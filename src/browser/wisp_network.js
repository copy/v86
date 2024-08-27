"use strict";

const DEFAULT_DOH_SERVER = "cloudflare-dns.com";

/**
 * @constructor
 *
 * @param {BusConnector} bus
 * @param {*=} config
 */
function WispNetworkAdapter(wisp_url, bus, config)
{

    this.register_ws(wisp_url);
    this.last_stream = 1;
    this.connections = {0: {congestion: 0}};
    this.congested_buffer = [];

    config = config || {};
    this.bus = bus;
    this.id = config.id || 0;
    this.router_mac = new Uint8Array((config.router_mac || "52:54:0:1:2:3").split(":").map(function(x) { return parseInt(x, 16); }));
    this.router_ip = new Uint8Array((config.router_ip || "192.168.86.1").split(".").map(function(x) { return parseInt(x, 10); }));
    this.vm_ip = new Uint8Array((config.vm_ip || "192.168.86.100").split(".").map(function(x) { return parseInt(x, 10); }));
    this.masquerade = config.masquerade === undefined || !!config.masquerade;
    this.vm_mac = new Uint8Array(6);
    this.doh_server =  config.doh_server || DEFAULT_DOH_SERVER;
    this.tcp_conn = {};

    this.bus.register("net" + this.id + "-mac", function(mac) {
        this.vm_mac = new Uint8Array(mac.split(":").map(function(x) { return parseInt(x, 16); }));
    }, this);
    this.bus.register("net" + this.id + "-send", function(data)
    {
        this.send(data);
    }, this);
}

WispNetworkAdapter.prototype.register_ws = function(wisp_url) {
    this.wispws = new WebSocket(wisp_url.replace("wisp://", "ws://").replace("wisps://", "wss://"));
    this.wispws.binaryType = "arraybuffer";
    this.wispws.onmessage = (event) => {
        this.process_incoming_wisp_frame(new Uint8Array(event.data));
    };
    this.wispws.onclose = () => {
        setTimeout(() => {
            this.register_ws(wisp_url);
        }, 10000); // wait 10s before reconnecting
    };
};

WispNetworkAdapter.prototype.send_packet = function(data, type, stream_id) {
    if(this.connections[stream_id].congestion > 0) {
        if(type === "DATA") {
            this.connections[stream_id].congestion--;
        }
        this.wispws.send(data);
    } else {
        this.connections[stream_id].congested = true;
        this.congested_buffer.push({data: data, type: type});
    }
};

WispNetworkAdapter.prototype.process_incoming_wisp_frame = function(frame) {
    const view = new DataView(frame.buffer);
    const stream_id = view.getUint32(1, true);
    switch(frame[0]) {
        case 1: // CONNECT
            // The server should never send this actually
            dbg_log("Server sent client-only packet CONNECT", LOG_NET);
            break;
        case 2: // DATA
            if(this.connections[stream_id])
                this.connections[stream_id].data_callback(frame.slice(5));
            else
                throw new Error("Got a DATA packet but stream not registered. ID: " + stream_id);
            break;
        case 3: // CONTINUE
            if(this.connections[stream_id]) {
                this.connections[stream_id].congestion = view.getUint32(5, true);
            }

            if(this.connections[stream_id].congested) {
                for(const packet of this.congested_buffer) {
                    this.send_packet(packet.data, packet.type, stream_id);
                }
                this.connections[stream_id].congested = false;
            }
            break;
        case 4: // CLOSE
            if(this.connections[stream_id])
                this.connections[stream_id].close_callback(view.getUint8(5));
            delete this.connections[stream_id];
            break;
        case 5: // PROTOEXT
            dbg_log("got a wisp V2 upgrade request, ignoring", LOG_NET);
            // Not responding, this is wisp v1 client not wisp v2;
            break;
        default:
            dbg_log("Wisp server returned unknown packet: " + frame[0], LOG_NET);
    }
};


// FrameObj will be the following
// FrameObj.stream_id (number)
//
// FrameObj.type -- CONNECT
//      FrameObj.hostname (string)
//      FrameObj.port (number)
//      FrameObj.data_callback (function (Uint8Array))
//      FrameObj.close_callback (function (number)) OPTIONAL
//
//
// FrameObj.type -- DATA
//      FrameObj.data (Uint8Array)
//
// FrameObj.type -- CLOSE
//      FrameObj.reason (number)
//
//

WispNetworkAdapter.prototype.send_wisp_frame = function(frame_obj) {
    let full_packet;
    let view;
    switch(frame_obj.type) {
        case "CONNECT":
            const hostname_buffer = new TextEncoder().encode(frame_obj.hostname);
            full_packet = new Uint8Array(5 + 1 + 2 + hostname_buffer.length);
            view = new DataView(full_packet.buffer);
            view.setUint8(0, 0x01);                     // TYPE
            view.setUint32(1, frame_obj.stream_id, true); // Stream ID
            view.setUint8(5, 0x01);                     // TCP
            view.setUint16(6, frame_obj.port, true);     // PORT
            full_packet.set(hostname_buffer, 8);          // hostname

            // Setting callbacks
            this.connections[frame_obj.stream_id] = {
                data_callback: frame_obj.data_callback,
                close_callback: frame_obj.close_callback,
                congestion: this.connections[0].congestion
            };
            break;
        case "DATA":
            full_packet = new Uint8Array(5 + frame_obj.data.length);
            view = new DataView(full_packet.buffer);
            view.setUint8(0, 0x02);                     // TYPE
            view.setUint32(1, frame_obj.stream_id, true); // Stream ID
            full_packet.set(frame_obj.data, 5);           // Actual data
            break;
        case "CLOSE":
            full_packet = new Uint8Array(5 + 1);
            view = new DataView(full_packet.buffer);
            view.setUint8(0, 0x04);                     // TYPE
            view.setUint32(1, frame_obj.stream_id, true); // Stream ID
            view.setUint8(5, frame_obj.reason);          // Packet size
            break;
        default:
            dbg_log("Client tried to send unknown packet: " + frame_obj.type, LOG_NET);

    }
    this.send_packet(full_packet, frame_obj.type, frame_obj.stream_id);
};

WispNetworkAdapter.prototype.destroy = function()
{
    if(this.wispws) {
        this.wispws.onmessage = null;
        this.wispws.onclose = null;
        this.wispws.close();
        this.wispws = null;
    }
};

/**
 * @param {Uint8Array} data
 */
WispNetworkAdapter.prototype.send = function(data)
{
    let packet = {};
    parse_eth(data, packet);

    if(packet.tcp) {
        let reply = {};
        reply.eth = { ethertype: ETHERTYPE_IPV4, src: this.router_mac, dest: packet.eth.src };
        reply.ipv4 = {
            proto: IPV4_PROTO_TCP,
            src: packet.ipv4.dest,
            dest: packet.ipv4.src
        };

        let tuple = [
            packet.ipv4.src.join("."),
            packet.tcp.sport,
            packet.ipv4.dest.join("."),
            packet.tcp.dport
        ].join(":");

        if(packet.tcp.syn) {
            if(this.tcp_conn[tuple]) {
                dbg_log("SYN to already opened port", LOG_FETCH);
            }
            const tcp_conn = new TCPConnection();

            tcp_conn.state = TCP_STATE_SYN_RECEIVED;
            tcp_conn.net = this;
            tcp_conn.tuple = tuple;
            tcp_conn.stream_id = this.last_stream++;
            this.tcp_conn[tuple] = tcp_conn;

            tcp_conn.on_data = (data) => {
                if(data.length !== 0) {
                    this.send_wisp_frame({
                        type: "DATA",
                        stream_id: tcp_conn.stream_id,
                        data: data
                    });
                }
            };

            this.send_wisp_frame({
                type: "CONNECT",
                stream_id: tcp_conn.stream_id,
                hostname: packet.ipv4.dest.join("."),
                port: packet.tcp.dport,
                data_callback: (data) => {
                    tcp_conn.write(data);
                },
                close_callback: (data) => {
                    tcp_conn.close();
                }
            });

            tcp_conn.accept(packet);
            return;
        }

        if(!this.tcp_conn[tuple]) {
            dbg_log(`I dont know about ${tuple}, so restting`, LOG_FETCH);
            let bop = packet.tcp.ackn;
            if(packet.tcp.fin || packet.tcp.syn) bop += 1;
            reply.tcp = {
                sport: packet.tcp.dport,
                dport: packet.tcp.sport,
                seq: bop,
                ackn: packet.tcp.seq + (packet.tcp.syn ? 1: 0),
                winsize: packet.tcp.winsize,
                rst: true,
                ack: packet.tcp.syn
            };
            this.receive(make_packet(reply));
            return;
        }

        this.tcp_conn[tuple].process(packet);
    }

    if(packet.arp && packet.arp.oper === 1 && packet.arp.ptype === ETHERTYPE_IPV4) {
        arp_whohas(packet, this);
    }

    if(packet.dns) {
        // TODO: remove when this wisp client supports udp
        (async () => {
            let reply = {};
            reply.eth = { ethertype: ETHERTYPE_IPV4, src: this.router_mac, dest: packet.eth.src };
            reply.ipv4 = {
                proto: IPV4_PROTO_UDP,
                src: this.router_ip,
                dest: packet.ipv4.src,
            };
            reply.udp = { sport: 53, dport: packet.udp.sport };
            const result = await ((await fetch(`https://${this.doh_server}/dns-query`, {method: "POST", headers: [["content-type", "application/dns-message"]], body: packet.udp.data})).arrayBuffer());
            reply.udp.data = new Uint8Array(result);
            this.receive(make_packet(reply));
        })();
    }

    if(packet.ntp) {
        // TODO: remove when this wisp client supports udp
        handle_fake_ntp(packet, this);
        return;
    }

    if(packet.dhcp) {
        handle_fake_dhcp(packet, this);
        return;
    }

    if(packet.udp && packet.udp.dport === 8) {
        // TODO: remove when this wisp client supports udp
        handle_udp_echo(packet, this);
    }
};

/**
 * @param {Uint8Array} data
 */
WispNetworkAdapter.prototype.receive = function(data)
{
    this.bus.send("net" + this.id + "-receive", new Uint8Array(data));
};
