"use strict";

// https://www.iana.org/assignments/ieee-802-numbers/ieee-802-numbers.xhtml
const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_ARP = 0x0806;
const ETHERTYPE_IPV6 = 0x86DD;

const IPV4_PROTO_ICMP = 1;
const IPV4_PROTO_TCP = 6;
const IPV4_PROTO_UDP = 17;

const UNIX_EPOCH = new Date("1970-01-01T00:00:00Z").getTime();
const NTP_EPOCH = new Date("1900-01-01T00:00:00Z").getTime();
const NTP_EPOC_DIFF = UNIX_EPOCH - NTP_EPOCH;
const TWO_TO_32 = Math.pow(2, 32);

const DHCP_MAGIC_COOKIE = 0x63825363;
const V86_ASCII = [118, 56, 54];

//const TCP_STATE_CLOSED = "closed";            // unused (terminal state)
//const TCP_STATE_LISTEN = "listen";            // unused
const TCP_STATE_ESTABLISHED = "established";    // TCPConnection.process()
const TCP_STATE_FIN_WAIT_1 = "fin-wait-1";      // close() (graceful-shutdown initiator state)
//const TCP_STATE_CLOSE_WAIT = "close-wait";    // unused (graceful-shutdown receiver state)
//const TCP_STATE_FIN_WAIT_2 = "fin-wait-2";    // unused (graceful-shutdown initiator state)
//const TCP_STATE_LAST_ACK = "last-ack";        // unused (graceful-shutdown receiver state)
//const TCP_STATE_CLOSING = "closing";          // unused
//const TCP_STATE_TIME_WAIT = "time-wait";      // unused (graceful-shutdown initiator state)
const TCP_STATE_SYN_RECEIVED = "syn-received";  // WispNetworkAdapter.send() (wisp_network.js)
const TCP_STATE_SYN_SENT = "syn-sent";          // connect() + process()

// source: RFC6335, 6. Port Number Ranges
const TCP_DYNAMIC_PORT_START = 49152;
const TCP_DYNAMIC_PORT_END   = 65535;
const TCP_DYNAMIC_PORT_RANGE = TCP_DYNAMIC_PORT_END - TCP_DYNAMIC_PORT_START;

const ETH_HEADER_SIZE     = 14;
const ETH_PAYLOAD_OFFSET  = ETH_HEADER_SIZE;
const ETH_PAYLOAD_SIZE    = 1500;
const ETH_TRAILER_SIZE    = 4;
const ETH_FRAME_SIZE      = ETH_HEADER_SIZE + ETH_PAYLOAD_SIZE + ETH_TRAILER_SIZE;
const IPV4_HEADER_SIZE    = 20;
const IPV4_PAYLOAD_OFFSET = ETH_PAYLOAD_OFFSET + IPV4_HEADER_SIZE;
const IPV4_PAYLOAD_SIZE   = ETH_PAYLOAD_SIZE - IPV4_HEADER_SIZE;
const UDP_HEADER_SIZE     = 8;
const UDP_PAYLOAD_OFFSET  = IPV4_PAYLOAD_OFFSET + UDP_HEADER_SIZE;
const UDP_PAYLOAD_SIZE    = IPV4_PAYLOAD_SIZE - UDP_HEADER_SIZE;
const TCP_HEADER_SIZE     = 20;
const TCP_PAYLOAD_OFFSET  = IPV4_PAYLOAD_OFFSET + TCP_HEADER_SIZE;
const TCP_PAYLOAD_SIZE    = IPV4_PAYLOAD_SIZE - TCP_HEADER_SIZE;
const ICMP_HEADER_SIZE    = 4;

function a2ethaddr(bytes) {
    return [0,1,2,3,4,5].map((i) => bytes[i].toString(16)).map(x => x.length === 1 ? "0" + x : x).join(":");
}

function siptolong(s) {
    let parts = s.split(".").map(function(x) { return parseInt(x, 10); });
    return parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3];
}

function iptolong(parts) {
    return parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3];
}

class GrowableRingbuffer
{
    /**
     * @param {number} initial_capacity
     * @param {number} maximum_capacity
     */
    constructor(initial_capacity, maximum_capacity)
    {
        initial_capacity = Math.min(initial_capacity, 16);
        this.maximum_capacity = maximum_capacity ? Math.max(maximum_capacity, initial_capacity) : 0;
        this.tail = 0;
        this.head = 0;
        this.length = 0;
        this.buffer = new Uint8Array(initial_capacity);
    }

    /**
     * @param {Uint8Array} src_array
     */
    write(src_array)
    {
        const src_length = src_array.length;
        const total_length = this.length + src_length;
        let capacity = this.buffer.length;
        if(capacity < total_length) {
            while(capacity < total_length) {
                capacity *= 2;
            }
            if(this.maximum_capacity && capacity > this.maximum_capacity) {
                throw new Error("stream capacity overflow in GrowableRingbuffer.write(), package dropped");
            }
            const new_buffer = new Uint8Array(capacity);
            this.peek(new_buffer);
            this.tail = 0;
            this.head = this.length;
            this.buffer = new_buffer;
        }
        const buffer = this.buffer;

        const new_head = this.head + src_length;
        if(new_head > capacity) {
            const i_split = capacity - this.head;
            buffer.set(src_array.subarray(0, i_split), this.head);
            buffer.set(src_array.subarray(i_split));
        }
        else {
            buffer.set(src_array, this.head);
        }
        this.head = new_head % capacity;
        this.length += src_length;
    }

    /**
     * @param {Uint8Array} dst_array
     */
    peek(dst_array)
    {
        const length = Math.min(this.length, dst_array.length);
        if(length) {
            const buffer = this.buffer;
            const capacity = buffer.length;
            const new_tail = this.tail + length;
            if(new_tail > capacity) {
                const buf_len_left = new_tail % capacity;
                const buf_len_right = capacity - this.tail;
                dst_array.set(buffer.subarray(this.tail));
                dst_array.set(buffer.subarray(0, buf_len_left), buf_len_right);
            }
            else {
                dst_array.set(buffer.subarray(this.tail, new_tail));
            }
        }
        return length;
    }

    /**
     * @param {number} length
     */
    remove(length)
    {
        if(length > this.length) {
            length = this.length;
        }
        if(length) {
            this.tail = (this.tail + length) % this.buffer.length;
            this.length -= length;
        }
        return length;
    }
}

class EthernetPacketEncoder
{
    constructor()
    {
        const eth_frame = new Uint8Array(ETH_FRAME_SIZE);
        const offset = eth_frame.byteOffset;

        this.eth_frame = eth_frame;
        this.eth_frame_view = new DataView(eth_frame.buffer);
        this.eth_payload_view = new DataView(eth_frame.buffer, offset + ETH_PAYLOAD_OFFSET, ETH_PAYLOAD_SIZE);
        this.ipv4_payload_view = new DataView(eth_frame.buffer, offset + IPV4_PAYLOAD_OFFSET, IPV4_PAYLOAD_SIZE);
        this.udp_payload_view = new DataView(eth_frame.buffer, offset + UDP_PAYLOAD_OFFSET, UDP_PAYLOAD_SIZE);

        for(const view of [this.eth_frame_view, this.eth_payload_view, this.ipv4_payload_view, this.udp_payload_view]) {
            view.setArray = this.view_setArray.bind(this, view);
            view.setString = this.view_setString.bind(this, view);
            view.setInetChecksum = this.view_setInetChecksum.bind(this, view);
        }

        this.text_encoder = new TextEncoder();
    }

    /**
     * Copy given data array into dst_view[dst_offset], return number of bytes written.
     *
     * @param {DataView} dst_view
     * @param {number} dst_offset
     * @param data
     */
    view_setArray(dst_view, dst_offset, data)
    {
        this.eth_frame.set(data, dst_view.byteOffset + dst_offset);
        return data.length;
    }

    /**
     * UTF8-encode given string into dst_view[dst_offset], return number of bytes written.
     *
     * @param {DataView} dst_view
     * @param {number} dst_offset
     * @param {string} str
     */
    view_setString(dst_view, dst_offset, str)
    {
        const ofs = dst_view.byteOffset + dst_offset;
        const result = this.text_encoder.encodeInto(str, ofs ? this.eth_frame.subarray(ofs) : this.eth_frame);
        return result.written;
    }

    /**
     * Calculate 16-bit internet checksum for dst_view[0 : length], store result in dst_view[dst_offset].
     * Source: RFC768 and RFC1071 (chapter 4.1).
     *
     * @param {DataView} dst_view
     * @param {number} dst_offset
     * @param {number} length
     * @param {number} checksum
     */
    view_setInetChecksum(dst_view, dst_offset, length, checksum)
    {
        const data = this.eth_frame;
        const offset = dst_view.byteOffset;
        const uint16_end = offset + (length & ~1);
        for(let i = offset; i < uint16_end; i += 2) {
            checksum += data[i] << 8 | data[i+1];
        }
        if(length & 1) {
            checksum += data[uint16_end] << 8;
        }
        while(checksum >> 16) {
            checksum = (checksum & 0xffff) + (checksum >> 16);
        }
        dst_view.setUint16(dst_offset, ~checksum);
    }

    /**
     * Encode and return ethernet packet for given spec.
     * TODO: what about the trailing 32-bit ethernet checksum?
     *
     * @param {Object} spec
     */
    encode_packet(spec)
    {
        dbg_assert(spec.eth);
        this.eth_frame.fill(0);
        const length = write_eth(spec, this.eth_frame_view, this);
        return this.eth_frame.subarray(0, length);
    }
}

const ethernet_encoder = new EthernetPacketEncoder();

function make_packet(spec)
{
    return ethernet_encoder.encode_packet(spec);
}

function handle_fake_tcp(packet, adapter)
{
    let reply = {};
    reply.eth = { ethertype: ETHERTYPE_IPV4, src: adapter.router_mac, dest: packet.eth.src };
    reply.ipv4 = {
        proto: IPV4_PROTO_TCP,
        src: packet.ipv4.dest,
        dest: packet.ipv4.src
    };
    const tuple = `${packet.ipv4.src.join(".")}:${packet.tcp.sport}:${packet.ipv4.dest.join(".")}:${packet.tcp.dport}`;

    if(packet.tcp.syn) {
        if(adapter.tcp_conn[tuple]) {
            dbg_log("SYN to already opened port", LOG_FETCH);
        }
        if(adapter.on_tcp_connection(adapter, packet, tuple)) {
            return;
        }
    }

    if(!adapter.tcp_conn[tuple]) {
        dbg_log(`I dont know about ${tuple}, so resetting`, LOG_FETCH);
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
        adapter.receive(make_packet(reply));
        return true;
    }

    adapter.tcp_conn[tuple].process(packet);
}

function handle_fake_dns(packet, adapter)
{
    let reply = {};
    reply.eth = { ethertype: ETHERTYPE_IPV4, src: adapter.router_mac, dest: packet.eth.src };
    reply.ipv4 = {
        proto: IPV4_PROTO_UDP,
        src: adapter.router_ip,
        dest: packet.ipv4.src,
    };
    reply.udp = { sport: 53, dport: packet.udp.sport };

    let answers = [];
    let flags = 0x8000; //Response,
    flags |= 0x0180; // Recursion
    // flags |= 0x0400; Authoritative

    for(let i = 0; i < packet.dns.questions.length; ++i) {
        let q = packet.dns.questions[i];

        switch(q.type){
            case 1: // A recrod
                answers.push({
                    name: q.name,
                    type: q.type,
                    class: q.class,
                    ttl: 600,
                    data: [192, 168, 87, 1]
                });
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
    adapter.receive(make_packet(reply));
    return true;
}

function handle_fake_ntp(packet, adapter) {
    let now = Date.now(); // - 1000 * 60 * 60 * 24 * 7;
    let now_n = now + NTP_EPOC_DIFF;
    let now_n_f = TWO_TO_32 * ((now_n % 1000) / 1000);

    let reply = {};
    reply.eth = { ethertype: ETHERTYPE_IPV4, src: adapter.router_mac, dest: packet.eth.src };
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
    adapter.receive(make_packet(reply));
    return true;
}

function handle_fake_dhcp(packet, adapter) {
    let reply = {};
    reply.eth = { ethertype: ETHERTYPE_IPV4, src: adapter.router_mac, dest: packet.eth.src };
    reply.ipv4 = {
        proto: IPV4_PROTO_UDP,
        src: adapter.router_ip,
        dest: adapter.vm_ip,
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
        yiaddr: iptolong(adapter.vm_ip),
        siaddr: iptolong(adapter.router_ip),
        giaddr: iptolong(adapter.router_ip),
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

    let router_ip = [adapter.router_ip[0], adapter.router_ip[1], adapter.router_ip[2], adapter.router_ip[3]];
    options.push(new Uint8Array([1, 4, 255, 255, 255, 0])); // Netmask
    if(adapter.masquerade) {
        options.push(new Uint8Array([3, 4].concat(router_ip))); // Router
        options.push(new Uint8Array([6, 4].concat(router_ip))); // DNS
    }
    options.push(new Uint8Array([54, 4].concat(router_ip))); // DHCP Server
    options.push(new Uint8Array([60, 3].concat(V86_ASCII))); // Vendor
    options.push(new Uint8Array([255, 0]));

    reply.dhcp.options = options;
    adapter.receive(make_packet(reply));
}

function handle_fake_networking(data, adapter) {
    let packet = {};
    parse_eth(data, packet);
    if(packet.tcp) {
        if(handle_fake_tcp(packet, adapter)) {
            return true;
        }
    }

    if(packet.arp && packet.arp.oper === 1 && packet.arp.ptype === ETHERTYPE_IPV4) {
        arp_whohas(packet, adapter);
    }

    if(packet.dns) {
        if(handle_fake_dns(packet, adapter)) {
            return;
        }
    }

    if(packet.ntp) {
        if(handle_fake_ntp(packet, adapter)) {
            return;
        }
    }

    // ICMP Ping
    if(packet.icmp && packet.icmp.type === 8) {
        handle_fake_ping(packet, adapter);
    }

    if(packet.dhcp) {
        if(handle_fake_dhcp(packet, adapter)) {
            return;
        }
    }

    if(packet.udp && packet.udp.dport === 8) {
        handle_udp_echo(packet, adapter);
    }
}

function parse_eth(data, o) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    let ethertype = view.getUint16(12);
    let eth = {
        ethertype: ethertype,
        dest: data.subarray(0, 6),
        dest_s: a2ethaddr(data.subarray(0, 6)),
        src: data.subarray(6, 12),
        src_s: a2ethaddr(data.subarray(6, 12)),
    };

    o.eth = eth;

    // Remove CRC from the end of the packet maybe?
    let payload = data.subarray(ETH_HEADER_SIZE, data.length);

    if(ethertype === ETHERTYPE_IPV4) {
        parse_ipv4(payload, o);
    }
    else if(ethertype === ETHERTYPE_ARP) {
        parse_arp(payload, o);
    }
    else if(ethertype === ETHERTYPE_IPV6) {
        dbg_log("Unimplemented: ipv6");
    }
    else {
        dbg_log("Unknown ethertype: " + h(ethertype), LOG_FETCH);
    }
}

function write_eth(spec, view, eth_encoder) {
    view.setArray(0, spec.eth.dest);
    view.setArray(6, spec.eth.src);
    view.setUint16(12, spec.eth.ethertype);
    let len = ETH_HEADER_SIZE;
    if(spec.arp) {
        len += write_arp(spec, eth_encoder.eth_payload_view);
    }
    else if(spec.ipv4) {
        len += write_ipv4(spec, eth_encoder.eth_payload_view, eth_encoder);
    }
    return len;
}

function parse_arp(data, o) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let hlen = data[4];
    let plen = data[5];

    let arp = {
        htype: view.getUint16(0),
        ptype: view.getUint16(2),
        oper: view.getUint16(6),
        sha: data.subarray(8, 14),
        spa: data.subarray(14, 18),
        tha: data.subarray(18, 24),
        tpa: data.subarray(24, 28),
    };
    o.arp = arp;
}

function write_arp(spec, view) {
    view.setUint16(0, spec.arp.htype);
    view.setUint16(2, spec.arp.ptype);
    view.setUint8(4, spec.arp.sha.length);
    view.setUint8(5, spec.arp.spa.length);
    view.setUint16(6, spec.arp.oper);
    view.setArray(8, spec.arp.sha);
    view.setArray(14, spec.arp.spa);
    view.setArray(18, spec.arp.tha);
    view.setArray(24, spec.arp.tpa);
    return 28;
}

function parse_ipv4(data, o) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    let version = (data[0] >> 4) & 0x0F;
    let ihl = data[0] & 0x0F;

    let tos = view.getUint8(1);
    let len = view.getUint16(2);

    let ttl = view.getUint8(8);
    let proto = view.getUint8(9);
    let ip_checksum = view.getUint16(10);

    let ipv4 = {
        version,
        ihl,
        tos,
        len,
        ttl,
        proto,
        ip_checksum,
        src: data.subarray(12, 12+4),
        dest: data.subarray(16, 16+4),
    };

    // Ethernet minmum packet size.
    if(Math.max(len, 46) !== data.length) dbg_log(`ipv4 Length mismatch: ${len} != ${data.length}`, LOG_FETCH);

    o.ipv4 = ipv4;
    let ipdata = data.subarray(ihl * 4, len);
    if(proto === IPV4_PROTO_ICMP) {
        parse_icmp(ipdata, o);
    }
    else if(proto === IPV4_PROTO_TCP) {
        parse_tcp(ipdata, o);
    }
    else if(proto === IPV4_PROTO_UDP) {
        parse_udp(ipdata, o);
    }
}

function write_ipv4(spec, view, eth_encoder) {
    const ihl = IPV4_HEADER_SIZE >> 2; // header length in 32-bit words
    const version = 4;

    let len = IPV4_HEADER_SIZE;
    if(spec.icmp) {
        len += write_icmp(spec, eth_encoder.ipv4_payload_view);
    }
    else if(spec.udp) {
        len += write_udp(spec, eth_encoder.ipv4_payload_view, eth_encoder);
    }
    else if(spec.tcp) {
        len += write_tcp(spec, eth_encoder.ipv4_payload_view);
    }

    view.setUint8(0, version << 4 | (ihl & 0x0F));
    view.setUint8(1, spec.ipv4.tos || 0);
    view.setUint16(2, len);
    view.setUint16(4, spec.ipv4.id || 0);
    view.setUint8(6, 2 << 5); // DF Flag
    view.setUint8(8, spec.ipv4.ttl || 32);
    view.setUint8(9, spec.ipv4.proto);
    view.setUint16(10, 0); // checksum initially zero before calculation
    view.setArray(12, spec.ipv4.src);
    view.setArray(16, spec.ipv4.dest);
    view.setInetChecksum(10, IPV4_HEADER_SIZE, 0);
    return len;
}

function parse_icmp(data, o) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let icmp = {
        type: view.getUint8(0),
        code: view.getUint8(1),
        checksum: view.getUint16(2),
        data: data.subarray(4)
    };
    o.icmp = icmp;
}

function write_icmp(spec, view) {
    view.setUint8(0, spec.icmp.type);
    view.setUint8(1, spec.icmp.code);
    view.setUint16(2, 0); // checksum initially zero before calculation
    const data_length = view.setArray(ICMP_HEADER_SIZE, spec.icmp.data);
    const total_length = ICMP_HEADER_SIZE + data_length;
    view.setInetChecksum(2, total_length, 0);
    return total_length;
}

function parse_udp(data, o) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let udp = {
        sport: view.getUint16(0),
        dport: view.getUint16(2),
        len: view.getUint16(4),
        checksum: view.getUint16(6),
        data: data.subarray(8),
        data_s: new TextDecoder().decode(data.subarray(8))
    };

    //dbg_assert(udp.data.length + 8 == udp.len);
    if(udp.dport === 67 || udp.sport === 67) { //DHCP
        parse_dhcp(data.subarray(8), o);
    }
    else if(udp.dport === 53 || udp.sport === 53) {
        parse_dns(data.subarray(8), o);
    }
    else if(udp.dport === 123) {
        parse_ntp(data.subarray(8), o);
    }
    o.udp = udp;
}

function write_udp(spec, view, eth_encoder) {
    let payload_length;
    if(spec.dhcp) {
        payload_length = write_dhcp(spec, eth_encoder.udp_payload_view);
    }
    else if(spec.dns) {
        payload_length = write_dns(spec, eth_encoder.udp_payload_view);
    }
    else if(spec.ntp) {
        payload_length = write_ntp(spec, eth_encoder.udp_payload_view);
    }
    else {
        payload_length = eth_encoder.udp_payload_view.setArray(0, spec.udp.data);
    }

    const total_length = UDP_HEADER_SIZE + payload_length;
    view.setUint16(0, spec.udp.sport);
    view.setUint16(2, spec.udp.dport);
    view.setUint16(4, total_length);
    view.setUint16(6, 0); // checksum initially zero before calculation

    const pseudo_header =
        (spec.ipv4.src[0] << 8 | spec.ipv4.src[1]) +
        (spec.ipv4.src[2] << 8 | spec.ipv4.src[3]) +
        (spec.ipv4.dest[0] << 8 | spec.ipv4.dest[1]) +
        (spec.ipv4.dest[2] << 8 | spec.ipv4.dest[3]) +
        IPV4_PROTO_UDP +
        total_length;
    view.setInetChecksum(6, total_length, pseudo_header);
    return total_length;
}

function parse_dns(data, o) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let dns = {
        id: view.getUint16(0),
        flags: view.getUint16(2),
        questions: [],
        answers: []
    };

    let qdcount = view.getUint16(4);
    let ancount = view.getUint16(6);
    let nscount = view.getUint16(8);
    let arcount = view.getUint16(10);

    let offset = 12;
    function read_dstr() {
        let o = [];
        let len;
        do {
            len = view.getUint8(offset);
            o.push(new TextDecoder().decode(data.subarray(offset+1, offset+1+len)));
            offset += len + 1;
        } while(len > 0);
        return o;
    }

    for(let i = 0; i < qdcount; i++) {
        dns.questions.push({
            name: read_dstr(),
            type: view.getInt16(offset),
            class: view.getInt16(offset + 2)
        });
        offset += 4;
    }
    for(let i = 0; i < ancount; i++) {
        let ans = {
            name: read_dstr(),
            type: view.getInt16(offset),
            class: view.getUint16(offset + 2),
            ttl: view.getUint32(offset + 4)
        };
        offset += 8;
        let rdlen = view.getUint16(offset);
        offset += 2;
        ans.data = data.subarray(offset, offset+rdlen);
        offset += rdlen;
        dns.answers.push(ans);
    }
    o.dns = dns;
}

function write_dns(spec, view) {
    view.setUint16(0, spec.dns.id);
    view.setUint16(2, spec.dns.flags);
    view.setUint16(4, spec.dns.questions.length);
    view.setUint16(6, spec.dns.answers.length);

    let offset = 12;
    for(let i = 0; i < spec.dns.questions.length; ++i) {
        let q = spec.dns.questions[i];
        for(let s of q.name) {
            const n_written = view.setString(offset + 1, s);
            view.setUint8(offset, n_written);
            offset += 1 + n_written;
        }
        view.setUint16(offset, q.type);
        offset += 2;
        view.setUint16(offset, q.class);
        offset += 2;
    }

    function write_reply(a) {
        for(let s of a.name) {
            const n_written = view.setString(offset + 1, s);
            view.setUint8(offset, n_written);
            offset += 1 + n_written;
        }
        view.setUint16(offset, a.type);
        offset += 2;
        view.setUint16(offset, a.class);
        offset += 2;
        view.setUint32(offset, a.ttl);
        offset += 4;
        view.setUint16(offset, a.data.length);
        offset += 2;
        offset += view.setArray(offset, a.data);
    }

    for(let i = 0; i < spec.dns.answers.length; ++i) {
        let a = spec.dns.answers[i];
        write_reply(a);
    }

    return offset;
}

function parse_dhcp(data, o) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let bootpo  = data.subarray(44,44+192);
    let dhcp = {
        op:  view.getUint8(0),
        htype: view.getUint8(1),
        hlen: view.getUint8(2),
        hops: view.getUint8(3),
        xid: view.getUint32(4),
        secs: view.getUint16(8),
        flags: view.getUint16(10),
        ciaddr: view.getUint32(12),
        yiaddr: view.getUint32(16),
        siaddr: view.getUint32(20),
        giaddr: view.getUint32(24),
        chaddr: data.subarray(28,28+16),
        magic: view.getUint32(236),
        options: [],
    };

    let options = data.subarray(240);
    for(let i = 0; i < options.length; ++i) {
        let start = i;
        let op = options[i];
        if(op === 0) continue;
        ++i;
        let len = options[i];
        i += len;
        dhcp.options.push(options.subarray(start, start + len + 2));
    }

    o.dhcp = dhcp;
    o.dhcp_options = dhcp.options;
}

function write_dhcp(spec, view) {
    view.setUint8(0, spec.dhcp.op);
    view.setUint8(1, spec.dhcp.htype);
    view.setUint8(2, spec.dhcp.hlen);
    view.setUint8(3, spec.dhcp.hops);
    view.setUint32(4, spec.dhcp.xid);
    view.setUint16(8, spec.dhcp.secs);
    view.setUint16(10, spec.dhcp.flags);
    view.setUint32(12, spec.dhcp.ciaddr);
    view.setUint32(16, spec.dhcp.yiaddr);
    view.setUint32(20, spec.dhcp.siaddr);
    view.setUint32(24, spec.dhcp.giaddr);
    view.setArray(28, spec.dhcp.chaddr);

    view.setUint32(236, DHCP_MAGIC_COOKIE);

    let offset = 240;
    for(let o of spec.dhcp.options) {
        offset += view.setArray(offset, o);
    }
    return offset;
}

function parse_ntp(data, o) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    o.ntp = {
        flags: view.getUint8(0),
        stratum: view.getUint8(1),
        poll: view.getUint8(2),
        precision: view.getUint8(3),
        root_delay: view.getUint32(4),
        root_disp: view.getUint32(8),
        ref_id: view.getUint32(12),
        ref_ts_i: view.getUint32(16),
        ref_ts_f: view.getUint32(20),
        ori_ts_i: view.getUint32(24),
        ori_ts_f: view.getUint32(28),
        rec_ts_i: view.getUint32(32),
        rec_ts_f: view.getUint32(36),
        trans_ts_i: view.getUint32(40),
        trans_ts_f: view.getUint32(44),
    };
}

function write_ntp(spec, view) {
    view.setUint8(0, spec.ntp.flags);
    view.setUint8(1, spec.ntp.stratum);
    view.setUint8(2, spec.ntp.poll);
    view.setUint8(3, spec.ntp.precision);
    view.setUint32(4, spec.ntp.root_delay);
    view.setUint32(8, spec.ntp.root_disp);
    view.setUint32(12, spec.ntp.ref_id);
    view.setUint32(16, spec.ntp.ref_ts_i);
    view.setUint32(20, spec.ntp.ref_ts_f);
    view.setUint32(24, spec.ntp.ori_ts_i);
    view.setUint32(28, spec.ntp.ori_ts_f);
    view.setUint32(32, spec.ntp.rec_ts_i);
    view.setUint32(36, spec.ntp.rec_ts_f);
    view.setUint32(40, spec.ntp.trans_ts_i);
    view.setUint32(44, spec.ntp.trans_ts_f);
    return 48;
}

function parse_tcp(data, o) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    let tcp = {
        sport: view.getUint16(0),
        dport: view.getUint16(2),
        seq: view.getUint32(4),
        ackn: view.getUint32(8),
        doff: view.getUint8(12) >> 4,
        winsize: view.getUint16(14),
        checksum: view.getUint16(16),
        urgent: view.getUint16(18),
    };

    let flags = view.getUint8(13);

    tcp.fin = !!(flags & 0x01);
    tcp.syn = !!(flags & 0x02);
    tcp.rst = !!(flags & 0x04);
    tcp.psh = !!(flags & 0x08);
    tcp.ack = !!(flags & 0x10);
    tcp.urg = !!(flags & 0x20);
    tcp.ece = !!(flags & 0x40);
    tcp.cwr = !!(flags & 0x80);

    o.tcp = tcp;

    let offset = tcp.doff * 4;
    o.tcp_data = data.subarray(offset);
}

function write_tcp(spec, view) {
    let flags = 0;
    let tcp = spec.tcp;

    if(tcp.fin) flags |= 0x01;
    if(tcp.syn) flags |= 0x02;
    if(tcp.rst) flags |= 0x04;
    if(tcp.psh) flags |= 0x08;
    if(tcp.ack) flags |= 0x10;
    if(tcp.urg) flags |= 0x20;
    if(tcp.ece) flags |= 0x40;
    if(tcp.cwr) flags |= 0x80;

    const doff = TCP_HEADER_SIZE >> 2;  // header length in 32-bit words

    view.setUint16(0, tcp.sport);
    view.setUint16(2, tcp.dport);
    view.setUint32(4, tcp.seq);
    view.setUint32(8, tcp.ackn);
    view.setUint8(12, doff << 4);
    view.setUint8(13, flags);
    view.setUint16(14, tcp.winsize);
    view.setUint16(16, 0); // checksum initially zero before calculation
    view.setUint16(18, tcp.urgent || 0);

    const total_length = TCP_HEADER_SIZE + (spec.tcp_data ? spec.tcp_data.length : 0);

    if(spec.tcp_data) {
        view.setArray(TCP_HEADER_SIZE, spec.tcp_data);
    }

    const pseudo_header =
        (spec.ipv4.src[0] << 8 | spec.ipv4.src[1]) +
        (spec.ipv4.src[2] << 8 | spec.ipv4.src[3]) +
        (spec.ipv4.dest[0] << 8 | spec.ipv4.dest[1]) +
        (spec.ipv4.dest[2] << 8 | spec.ipv4.dest[3]) +
        IPV4_PROTO_TCP +
        total_length;
    view.setInetChecksum(16, total_length, pseudo_header);
    return total_length;
}

function fake_tcp_connect(dport, adapter)
{
    const vm_ip_str = adapter.vm_ip.join(".");
    const router_ip_str = adapter.router_ip.join(".");
    const sport_0 = (Math.random() * TCP_DYNAMIC_PORT_RANGE) | 0;
    let sport, tuple, sport_i = 0;
    do {
        sport = TCP_DYNAMIC_PORT_START + ((sport_0 + sport_i) % TCP_DYNAMIC_PORT_RANGE);
        tuple = `${vm_ip_str}:${dport}:${router_ip_str}:${sport}`;
    } while(++sport_i < TCP_DYNAMIC_PORT_RANGE && adapter.tcp_conn[tuple]);
    if(adapter.tcp_conn[tuple]) {
        throw new Error("pool of dynamic TCP port numbers exhausted, connection aborted");
    }

    let reader;
    let connector;

    let conn = new TCPConnection();
    conn.net = adapter;
    conn.on_data = function(data) { if(reader) reader.call(handle, data); };
    conn.on_connect = function() { if(connector) connector.call(handle); };
    conn.tuple = tuple;

    conn.hsrc = adapter.router_mac;
    conn.psrc = adapter.router_ip;
    conn.sport = sport;
    conn.hdest = adapter.vm_mac;
    conn.dport = dport;
    conn.pdest = adapter.vm_ip;

    adapter.tcp_conn[tuple] = conn;
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
}

/**
 * @constructor
 */
function TCPConnection()
{
    this.send_stream = new GrowableRingbuffer(2048, 0);
    this.send_chunk_buf = new Uint8Array(TCP_PAYLOAD_SIZE);
    this.seq_history = [];
}

TCPConnection.prototype.ipv4_reply = function() {
    let reply = {};
    reply.eth = { ethertype: ETHERTYPE_IPV4, src: this.hsrc, dest: this.hdest };
    reply.ipv4 = {
        proto: IPV4_PROTO_TCP,
        src: this.psrc,
        dest: this.pdest
    };
    reply.tcp = {
        sport: this.sport,
        dport: this.dport,
        winsize: this.winsize,
        ackn: this.ack,
        seq: this.seq,
        ack: true
    };
    return reply;
};

TCPConnection.prototype.connect = function() {
    this.seq = 1338;
    this.ack = 1;
    this.start_seq = 0;
    this.winsize = 64240;
    this.state = TCP_STATE_SYN_SENT;

    let reply = this.ipv4_reply();
    reply.ipv4.id = 2345;
    reply.tcp = {
        sport: this.sport,
        dport: this.dport,
        seq: 1337,
        ackn: 0,
        winsize: 0,
        syn: true,
    };
    this.net.receive(make_packet(reply));
};

TCPConnection.prototype.accept = function(packet) {
    this.seq = 1338;
    this.ack = packet.tcp.seq + 1;
    this.start_seq = packet.tcp.seq;
    this.hsrc = this.net.router_mac;
    this.psrc = packet.ipv4.dest;
    this.sport = packet.tcp.dport;
    this.hdest = packet.eth.src;
    this.dport = packet.tcp.sport;
    this.pdest = packet.ipv4.src;
    this.winsize = packet.tcp.winsize;

    let reply = this.ipv4_reply();

    reply.tcp = {
        sport: this.sport,
        dport: this.dport,
        seq: 1337,
        ackn: this.ack,
        winsize: packet.tcp.winsize,
        syn: true,
        ack: true
    };
    this.net.receive(make_packet(reply));
};

TCPConnection.prototype.process = function(packet) {
    // Receive Handshake Part 2, Send Part 3
    if(packet.tcp.syn) {
        dbg_assert(packet.tcp.ack);
        dbg_assert(this.state === TCP_STATE_SYN_SENT);

        this.ack = packet.tcp.seq + 1;
        this.start_seq = packet.tcp.seq;
        this.last_received_ackn = packet.tcp.ackn;

        let reply = this.ipv4_reply();
        this.net.receive(make_packet(reply));

        this.state = TCP_STATE_ESTABLISHED;
        if(this.on_connect) this.on_connect.call(this);
        return;
    }

    if(packet.tcp.fin) {
        dbg_log(`All done with ${this.tuple} resetting`, LOG_FETCH);
        if(this.ack !== packet.tcp.seq) {
            dbg_log("Closing the connecton, but seq was wrong", LOG_FETCH);
            ++this.ack; // FIN increases seq#
        }
        let reply = this.ipv4_reply();
        reply.tcp = {
            sport: packet.tcp.dport,
            dport: packet.tcp.sport,
            seq: this.seq,
            ackn: this.ack,
            winsize: packet.tcp.winsize,
            rst: true,
        };
        delete this.net.tcp_conn[this.tuple];
        this.net.receive(make_packet(reply));
        return;
    }

    if(this.ack !== packet.tcp.seq) {
        dbg_log(`Packet seq was wrong ex: ${this.ack} ~${this.ack - this.start_seq} pk: ${packet.tcp.seq} ~${this.start_seq - packet.tcp.seq} (${this.ack - packet.tcp.seq}) = ${this.name}`, LOG_FETCH);

        let reply = this.ipv4_reply();
        reply.tcp = {
            sport: packet.tcp.dport,
            dport: packet.tcp.sport,
            seq: this.seq,
            ackn: this.ack,
            winsize: packet.tcp.winsize,
            ack: true
        };
        this.net.receive(make_packet(reply));

        return;
    }

    this.seq_history.push(`${packet.tcp.seq - this.start_seq}:${packet.tcp.seq + packet.tcp_data.length- this.start_seq}`);

    this.ack += packet.tcp_data.length;

    if(packet.tcp_data.length > 0) {
        let reply = this.ipv4_reply();
        this.net.receive(make_packet(reply));
    }

    if(this.last_received_ackn === undefined) this.last_received_ackn = packet.tcp.ackn;
    let nread = packet.tcp.ackn - this.last_received_ackn;
    //console.log("Read ", nread, "(", this.last_received_ackn, ") ", packet.tcp.ackn, packet.tcp.winsize)
    if(nread > 0) {
        this.last_received_ackn = packet.tcp.ackn;
        this.send_stream.remove(nread);
        this.seq += nread;
        this.pending = false;
    }

    if(nread < 0) return;

    this.on_data(packet.tcp_data);
    this.pump();
};

/**
 * @param {Uint8Array} data
 */
TCPConnection.prototype.write = function(data) {
    this.send_stream.write(data);
    this.pump();
};

TCPConnection.prototype.close = function() {
    this.state = TCP_STATE_FIN_WAIT_1;
    if(!this.send_stream.length) {
        let reply = this.ipv4_reply();
        reply.tcp.fin = true;
        this.net.receive(make_packet(reply));
    }
    this.pump();
};

TCPConnection.prototype.pump = function() {
    if(this.send_stream.length > 0 && !this.pending) {
        const data = this.send_chunk_buf;
        const n_ready = this.send_stream.peek(data);
        const reply = this.ipv4_reply();
        this.pending = true;
        if(this.state === TCP_STATE_FIN_WAIT_1 && this.send_stream.length === n_ready) {
            reply.tcp.fin = true;
        }
        reply.tcp.psh = true;
        reply.tcp_data = data.subarray(0, n_ready);
        this.net.receive(make_packet(reply));
    }
};


function arp_whohas(packet, adapter) {
    let packet_subnet = iptolong(packet.arp.tpa) & 0xFFFFFF00;
    let router_subnet = iptolong(adapter.router_ip) & 0xFFFFFF00;

    if(!adapter.masquerade) {
        if(packet_subnet !== router_subnet) {
            return;
        }
    }

    if(packet_subnet === router_subnet) {
        // Ignore the DHCP client area
        if(packet.arp.tpa[3] > 99) return;
    }

    // Reply to ARP Whohas
    let reply = {};
    reply.eth = { ethertype: ETHERTYPE_ARP, src: adapter.router_mac, dest: packet.eth.src };
    reply.arp = {
        htype: 1,
        ptype: ETHERTYPE_IPV4,
        oper: 2,
        sha: adapter.router_mac,
        spa: packet.arp.tpa,
        tha: packet.eth.src,
        tpa: packet.arp.spa
    };
    adapter.receive(make_packet(reply));
}

function handle_fake_ping(packet, adapter) {
    let reply = {};
    reply.eth = { ethertype: ETHERTYPE_IPV4, src: adapter.router_mac, dest: packet.eth.src };
    reply.ipv4 = {
        proto: IPV4_PROTO_ICMP,
        src: adapter.router_ip,
        dest: packet.ipv4.src,
    };
    reply.icmp = {
        type: 0,
        code: packet.icmp.code,
        data: packet.icmp.data
    };
    adapter.receive(make_packet(reply));
}

function handle_udp_echo(packet, adapter) {
    // UDP Echo Server
    let reply = {};
    reply.eth = { ethertype: ETHERTYPE_IPV4, src: adapter.router_mac, dest: packet.eth.src };
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
    adapter.receive(make_packet(reply));
}
