"use strict";
let wispws;

let lastStream = 1;

const connections = {0: {congestion: 0}};

const congestedBuffer = [];
function sendPacket(data, type, streamID) {
    if(connections[streamID].congestion > 0) {
        if(type === "DATA")
            connections[streamID].congestion--;
        wispws.send(data);
    } else {
        connections[streamID].congested = true;
        congestedBuffer.push({data: data, type: type});
    }
}

function processIncomingWispFrame(frame) {
    // console.log(frame);
    const view = new DataView(frame.buffer);
    const streamID = view.getUint32(1, true);
    switch(frame[0]) {
        case 1: // CONNECT
            // The server should never send this actually
            throw new Error("Server sent client only frame: CONNECT 0x01");
            break;
        case 2: // DATA
            if(connections[streamID])
                connections[streamID].dataCallback(frame.slice(5));
            else
                throw new Error("Got a DATA packet but stream not registered. ID: " + streamID);


            break;
        case 3: // CONTINUE
            if(connections[streamID]) {
                connections[streamID].congestion = view.getUint32(5, true);
            }

            if(connections[streamID].congested) {
                for(const packet of congestedBuffer) {
                    sendPacket(packet.data, packet.type, streamID);
                }
                connections[streamID].congested = false;
            }

            break;
        case 4: // CLOSE
            if(connections[streamID])
                connections[streamID].closeCallback(view.getUint8(5));
            delete connections[streamID];
            break;
    }
}


// FrameObj will be the following
// FrameObj.streamID (number)
//
// FrameObj.type -- CONNECT
//      FrameObj.hostname (string)
//      FrameObj.port (number)
//      FrameObj.dataCallback (function (Uint8Array))
//      FrameObj.closeCallback (function (number)) OPTIONAL
//
//
// FrameObj.type -- DATA
//      FrameObj.data (Uint8Array)
//
// FrameObj.type -- CLOSE
//      FrameObj.reason (number)
//
// FrameObj.type -- RESIZE
//      FrameObj.cols (number)
//      FrameObj.rows (number)
//
//
//

function sendWispFrame(frameObj) {

    let fullPacket;
    let view;
    switch(frameObj.type) {
        case "CONNECT":
            const hostnameBuffer = new TextEncoder().encode(frameObj.hostname);
            fullPacket = new Uint8Array(5 + 1 + 2 + hostnameBuffer.length);
            view = new DataView(fullPacket.buffer);
            view.setUint8(0, 0x01);                     // TYPE
            view.setUint32(1, frameObj.streamID, true); // Stream ID
            view.setUint8(5, 0x01);                     // TCP
            view.setUint16(6, frameObj.port, true);     // PORT
            fullPacket.set(hostnameBuffer, 8);          // hostname

            // Setting callbacks
            connections[frameObj.streamID] = {
                dataCallback: frameObj.dataCallback,
                closeCallback: frameObj.closeCallback,
                congestion: connections[0].congestion
            };


            break;
        case "DATA":

            fullPacket = new Uint8Array(5 + frameObj.data.length);
            view = new DataView(fullPacket.buffer);
            view.setUint8(0, 0x02);                     // TYPE
            view.setUint32(1, frameObj.streamID, true); // Stream ID
            fullPacket.set(frameObj.data, 5);           // Actual data

            break;
        case "CLOSE":
            fullPacket = new Uint8Array(5 + 1);
            view = new DataView(fullPacket.buffer);
            view.setUint8(0, 0x04);                     // TYPE
            view.setUint32(1, frameObj.streamID, true); // Stream ID
            view.setUint8(5, frameObj.reason);          // Packet size

            break;

    }
    sendPacket(fullPacket, frameObj.type, frameObj.streamID);
}

/**
 * @constructor
 *
 * @param {BusConnector} bus
 * @param {*=} config
 */
function WispNetworkAdapter(wispURL, bus, config)
{
    const registerWS = function() {
        wispws = new WebSocket(wispURL.replace("wisp://", "ws://").replace("wisps://", "wss://"));
        wispws.binaryType = "arraybuffer";
        wispws.onmessage = (event) => {
            processIncomingWispFrame(new Uint8Array(event.data));
        };
        wispws.onerror = () => {
            registerWS();
        };
        wispws.onclose = () => {
            registerWS();
        };
    };
    registerWS();
    config = config || {};
    this.bus = bus;
    this.id = config.id || 0;
    this.router_mac = new Uint8Array((config.router_mac || "52:54:0:1:2:3").split(":").map(function(x) { return parseInt(x, 16); }));
    this.router_ip = new Uint8Array((config.router_ip || "192.168.86.1").split(".").map(function(x) { return parseInt(x, 10); }));
    this.vm_ip = new Uint8Array((config.vm_ip || "192.168.86.100").split(".").map(function(x) { return parseInt(x, 10); }));
    this.masquerade = config.masquerade === undefined || !!config.masquerade;
    this.vm_mac = new Uint8Array(6);

    this.tcp_conn = {};

    this.bus.register("net" + this.id + "-mac", function(mac) {
        this.vm_mac = new Uint8Array(mac.split(":").map(function(x) { return parseInt(x, 16); }));
    }, this);
    this.bus.register("net" + this.id + "-send", function(data)
    {
        this.send(data);
    }, this);
}

WispNetworkAdapter.prototype.destroy = function()
{
};

// https://stackoverflow.com/questions/4460586/javascript-regular-expression-to-check-for-ip-addresses
function validateIPaddress(ipaddress) {
    if(/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipaddress)) {
      return true;
    }
    return false;
}

// DNS over HTTPS fetch, recursively fetch the A record until the first result is an IPv4
async function dohdns(q) {
    const prefered_fetch = (window.anura?.net?.fetch) || fetch;
    const req = await prefered_fetch(`https://dns.google/resolve?name=${q.name.join(".")}&type=${q.type}`);
    if(req.status === 200) {
        const res = await req.json();
        if(res.Answer) {
            if(validateIPaddress(res.Answer[0].data)) {
                return res;
            } else {
                return await dohdns({name: res.Answer[0].data.split("."), type: q.type});
            }
        }
        return { // if theres an error, Naively return localhost
            "Status": 0,
            "TC": false,
            "RD": true,
            "RA": true,
            "AD": true,
            "CD": false,
            "Question": [
                {
                    "name": q.name.join("."),
                    "type": 1
                }
            ],
            "Answer": [
                {
                    "name": q.name.join("."),
                    "type": 1,
                    "TTL": 600,
                    "data": "127.0.0.1"
                }
            ]
        };
    } else {
        throw new Error("DNS Server returned error code");
    }


}

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

            this.tcp_conn[tuple] = new TCPConnection();
            this.tcp_conn[tuple].state = TCP_STATE_SYN_RECEIVED;
            this.tcp_conn[tuple].net = this;
            this.tcp_conn[tuple].on_data = TCPConnection.prototype.on_data_wisp;
            this.tcp_conn[tuple].tuple = tuple;
            this.tcp_conn[tuple].streamID = lastStream++;
            const deref = this.tcp_conn[tuple];
            sendWispFrame({
                type: "CONNECT",
                streamID: deref.streamID,
                hostname: packet.ipv4.dest.join("."),
                port: packet.tcp.dport,
                dataCallback: (data) => {
                    // console.log("Sending back data: ");
                    // console.log(data);
                    deref.write(data);
                },
                closeCallback: (data) => {
                    deref.close();
                }
            });
            deref.accept(packet);

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
        if(!this.masquerade) {
            let packet_subnet = iptolong(packet.arp.tpa) & 0xFFFFFF00;
            let router_subnet = iptolong(this.router_ip) & 0xFFFFFF00;

            if(packet_subnet !== router_subnet) {
                return;
            }
        }

        // Reply to ARP Whohas
        let reply = {};
        reply.eth = { ethertype: ETHERTYPE_ARP, src: this.router_mac, dest: packet.eth.src };
        reply.arp = {
            htype: 1,
            ptype: ETHERTYPE_IPV4,
            oper: 2,
            sha: this.router_mac,
            spa: packet.arp.tpa,
            tha: packet.eth.src,
            tpa: packet.arp.spa
        };
        this.receive(make_packet(reply));

    }

    if(packet.dns) {
        (async () => {
            let reply = {};
            reply.eth = { ethertype: ETHERTYPE_IPV4, src: this.router_mac, dest: packet.eth.src };
            reply.ipv4 = {
                proto: IPV4_PROTO_UDP,
                src: this.router_ip,
                dest: packet.ipv4.src,
            };
            reply.udp = { sport: 53, dport: packet.udp.sport };

            let answers = [];
            let flags = 0x8000; //Response,
            flags |= 0x0180; // Recursion
            // flags |= 0x0400; Authoritative
            for(let i = 0; i < packet.dns.questions.length; ++i) {
                let q = packet.dns.questions[i];
                // Sometimes this results in no answer at all, like if dohdns crashes, but UDP is unreliable in nature so this shouldn't be that big of an issue
                const res = await dohdns(q);
                switch(q.type){
                    case 1: // A recrod

                        // for (const ans in res.Answer) {    // v86 DNS server crashes and burns with multiple answers, not quite sure why
                        if(res?.Answer && res.Answer[0]) {
                            const ans = res.Answer[0];
                            answers.push({
                                name: ans.name.split("."),
                                type: ans.type,
                                class: q.class,
                                ttl: ans.TTL,
                                data: ans.data.split(".")
                            });
                        }

                        // }

                        break;
                    default:
                }
            }

            reply.dns = {
                id: packet.dns.id,
                flags: flags,
                questions: packet.dns.questions,
                answers: answers
            };
            this.receive(make_packet(reply));

        })();

    }

    if(packet.ntp) {

        let now = Date.now(); // - 1000 * 60 * 60 * 24 * 7;
        let now_n = now + NTP_EPOC_DIFF;
        let now_n_f = TWO_TO_32 * ((now_n % 1000) / 1000);

        let reply = {};
        reply.eth = { ethertype: ETHERTYPE_IPV4, src: this.router_mac, dest: packet.eth.src };
        reply.ipv4 = {
            proto: IPV4_PROTO_UDP,
            src: packet.ipv4.dest,
            dest: packet.ipv4.src,
        };
        reply.udp = { sport: 123, dport: packet.udp.sport };
        let flags = (0 << 6) | (4 << 3) | 4;
        reply.ntp = Object.assign({}, packet.ntp);
        reply.ntp.flags = flags;
        reply.ntp.poll = 10;
        reply.ntp.ori_ts_i = packet.ntp.trans_ts_i;
        reply.ntp.ori_ts_f = packet.ntp.trans_ts_f;

        reply.ntp.rec_ts_i = now_n / 1000;
        reply.ntp.rec_ts_f = now_n_f;

        reply.ntp.trans_ts_i = now_n / 1000;
        reply.ntp.trans_ts_f = now_n_f;

        reply.ntp.stratum = 2;
        this.receive(make_packet(reply));
        return;
    }

    // ICMP Ping
    if(packet.icmp && packet.icmp.type === 8) {
        let reply = {};
        reply.eth = { ethertype: ETHERTYPE_IPV4, src: this.router_mac, dest: packet.eth.src };
        reply.ipv4 = {
            proto: IPV4_PROTO_ICMP,
            src: this.router_ip,
            dest: packet.ipv4.src,
        };
        reply.icmp = {
            type: 0,
            code: packet.icmp.code,
            data: packet.icmp.data
        };
        this.receive(make_packet(reply));
        return;
    }

    if(packet.dhcp) {
        let reply = {};
        reply.eth = { ethertype: ETHERTYPE_IPV4, src: this.router_mac, dest: packet.eth.src };
        reply.ipv4 = {
            proto: IPV4_PROTO_UDP,
            src: this.router_ip,
            dest: this.vm_ip,
        };
        reply.udp = { sport: 67, dport: 68, };
        reply.dhcp = {
            htype: 1,
            hlen: 6,
            hops: 0,
            xid: packet.dhcp.xid,
            secs: 0,
            flags: 0,
            ciaddr: 0,
            yiaddr: iptolong(this.vm_ip),
            siaddr: iptolong(this.router_ip),
            giaddr: iptolong(this.router_ip),
            chaddr: packet.dhcp.chaddr,
        };

        let options = [];

        // idk, it seems like op should be 3, but udhcpc sends 1
        let fix = packet.dhcp.options.find(function(x) { return x[0] === 53; });
        if( fix && fix[2] === 3 ) packet.dhcp.op = 3;

        if(packet.dhcp.op === 1) {
            reply.dhcp.op = 2;
            options.push(new Uint8Array([53, 1, 2]));
        }

        if(packet.dhcp.op === 3) {
            reply.dhcp.op = 2;
            options.push(new Uint8Array([53, 1, 5]));
            options.push(new Uint8Array([51, 4, 8, 0, 0, 0]));  // Lease Time
        }

        let router_ip = [this.router_ip[0], this.router_ip[1], this.router_ip[2], this.router_ip[3]];
        options.push(new Uint8Array([1, 4, 255, 255, 255, 0])); // Netmask
        if(this.masquerade) {
            options.push(new Uint8Array([3, 4].concat(router_ip))); // Router
            options.push(new Uint8Array([6, 4].concat(router_ip))); // DNS
        }
        options.push(new Uint8Array([54, 4].concat(router_ip))); // DHCP Server
        options.push(new Uint8Array([60, 3].concat(V86_ASCII))); // Vendor
        options.push(new Uint8Array([255, 0]));

        reply.dhcp.options = options;
        this.receive(make_packet(reply));
        return;
    }

    if(packet.udp && packet.udp.dport === 8) {
        // UDP Echo Server
        let reply = {};
        reply.eth = { ethertype: ETHERTYPE_IPV4, src: this.router_mac, dest: packet.eth.src };
        reply.ipv4 = {
            proto: IPV4_PROTO_UDP,
            src: packet.ipv4.dest,
            dest: packet.ipv4.src,
        };
        reply.udp = {
            sport: packet.udp.dport,
            dport: packet.udp.sport,
            data: new TextEncoder().encode(packet.udp.data_s)
        };
        this.receive(make_packet(reply));
    }
};


WispNetworkAdapter.prototype.tcp_connect = function(dport)
{
    // TODO: check port collisions
    let sport = 49152 + Math.floor(Math.random() * 1000);
    let tuple = [
        this.vm_ip.join("."),
        dport,
        this.router_ip.join("."),
        sport
    ].join(":");


    let reader;
    let connector;

    let conn = new TCPConnection();
    conn.net = this;
    conn.on_data = function(data) { if(reader) reader.call(handle, data); };
    conn.on_connect = function() { if(connector) connector.call(handle); };
    conn.tuple = tuple;

    conn.hsrc = this.router_mac;
    conn.psrc = this.router_ip;
    conn.sport = sport;
    conn.hdest = this.vm_mac;
    conn.dport = dport;
    conn.pdest = this.vm_ip;

    this.tcp_conn[tuple] = conn;
    conn.connect();

    // TODO: Real event source
    let handle = {
        write: function(data) { conn.write(data); },
        on: function(event, cb) {
            if( event === "data" ) reader = cb;
            if( event === "connect" ) connector = cb;
        },
        close: function() { conn.close(); }
    };

    return handle;
};

/**
 * @param {Uint8Array} data
 */
WispNetworkAdapter.prototype.receive = function(data)
{
    this.bus.send("net" + this.id + "-receive", new Uint8Array(data));
};

/**
 *
 * @param {Uint8Array} data
 */
TCPConnection.prototype.on_data_wisp = async function(data) {
    if(data.length !== 0) {
        sendWispFrame({
            type: "DATA",
            streamID: this.streamID,
            data: data
        });
    }
};

if(typeof module !== "undefined" && typeof module.exports !== "undefined")
{
    module.exports["WispNetworkAdapter"] = WispNetworkAdapter;
}
