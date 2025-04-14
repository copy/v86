import { LOG_FETCH } from "../const.js";
import { h } from "../lib.js";
import { dbg_assert, dbg_log } from "../log.js";

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

/* For the complete TCP state diagram see:
 *
 *   https://en.wikipedia.org/wiki/File:Tcp_state_diagram_fixed_new.svg
 *
 * State TIME_WAIT is not needed, we can skip it and transition directly to CLOSED instead.
 */
export const TCP_STATE_CLOSED = "closed";
export const TCP_STATE_SYN_RECEIVED = "syn-received";
export const TCP_STATE_SYN_SENT = "syn-sent";
export const TCP_STATE_SYN_PROBE = "syn-probe";
//const TCP_STATE_LISTEN = "listen";
export const TCP_STATE_ESTABLISHED = "established";
export const TCP_STATE_FIN_WAIT_1 = "fin-wait-1";
export const TCP_STATE_CLOSE_WAIT = "close-wait";
export const TCP_STATE_FIN_WAIT_2 = "fin-wait-2";
export const TCP_STATE_LAST_ACK = "last-ack";
export const TCP_STATE_CLOSING = "closing";
//const TCP_STATE_TIME_WAIT = "time-wait";

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

const DEFAULT_DOH_SERVER = "cloudflare-dns.com";

function a2ethaddr(bytes) {
    return [0,1,2,3,4,5].map((i) => bytes[i].toString(16)).map(x => x.length === 1 ? "0" + x : x).join(":");
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
            dbg_assert(capacity > 0);
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

export function create_eth_encoder_buf()
{
    const eth_frame = new Uint8Array(ETH_FRAME_SIZE);
    const buffer = eth_frame.buffer;
    const offset = eth_frame.byteOffset;
    return {
        eth_frame: eth_frame,
        eth_frame_view: new DataView(buffer),
        eth_payload_view: new DataView(buffer, offset + ETH_PAYLOAD_OFFSET, ETH_PAYLOAD_SIZE),
        ipv4_payload_view: new DataView(buffer, offset + IPV4_PAYLOAD_OFFSET, IPV4_PAYLOAD_SIZE),
        udp_payload_view: new DataView(buffer, offset + UDP_PAYLOAD_OFFSET, UDP_PAYLOAD_SIZE),
        text_encoder: new TextEncoder()
    };
}

/**
 * Copy given data array into view starting at offset, return number of bytes written.
 *
 * @param {number} offset
 * @param {ArrayBuffer|ArrayBufferView} data
 * @param {DataView} view
 * @param {Object} out
 */
function view_set_array(offset, data, view, out)
{
    out.eth_frame.set(data, view.byteOffset + offset);
    return data.length;
}

/**
 * UTF8-encode given string into view starting at offset, return number of bytes written.
 *
 * @param {number} offset
 * @param {string} str
 * @param {DataView} view
 * @param {Object} out
 */
function view_set_string(offset, str, view, out)
{
    return out.text_encoder.encodeInto(str, out.eth_frame.subarray(view.byteOffset + offset)).written;
}

/**
 * Calculate internet checksum for view[0 : length] and return the 16-bit result.
 * Source: RFC768 and RFC1071 (chapter 4.1).
 *
 * @param {number} length
 * @param {number} checksum
 * @param {DataView} view
 * @param {Object} out
 */
function calc_inet_checksum(length, checksum, view, out)
{
    const uint16_end = view.byteOffset + (length & ~1);
    const eth_frame = out.eth_frame;
    for(let i = view.byteOffset; i < uint16_end; i += 2) {
        checksum += eth_frame[i] << 8 | eth_frame[i+1];
    }
    if(length & 1) {
        checksum += eth_frame[uint16_end] << 8;
    }
    while(checksum >>> 16) {
        checksum = (checksum & 0xffff) + (checksum >>> 16);
    }
    return ~checksum & 0xffff;
}

/**
 * @param {Object} out
 * @param {Object} spec
 */
function make_packet(out, spec)
{
    dbg_assert(spec.eth);
    out.eth_frame.fill(0);
    return out.eth_frame.subarray(0, write_eth(spec, out));
}

function handle_fake_tcp(packet, adapter)
{
    const tuple = `${packet.ipv4.src.join(".")}:${packet.tcp.sport}:${packet.ipv4.dest.join(".")}:${packet.tcp.dport}`;

    if(packet.tcp.syn) {
        if(adapter.tcp_conn[tuple]) {
            dbg_log("SYN to already opened port", LOG_FETCH);
        }
        if(adapter.on_tcp_connection(packet, tuple)) {
            return;
        }
    }

    if(!adapter.tcp_conn[tuple]) {
        dbg_log(`I dont know about ${tuple}, so resetting`, LOG_FETCH);
        let bop = packet.tcp.ackn;
        if(packet.tcp.fin || packet.tcp.syn) bop += 1;
        let reply = {};
        reply.eth = { ethertype: ETHERTYPE_IPV4, src: adapter.router_mac, dest: packet.eth.src };
        reply.ipv4 = {
            proto: IPV4_PROTO_TCP,
            src: packet.ipv4.dest,
            dest: packet.ipv4.src
        };
        reply.tcp = {
            sport: packet.tcp.dport,
            dport: packet.tcp.sport,
            seq: bop,
            ackn: packet.tcp.seq + (packet.tcp.syn ? 1: 0),
            winsize: packet.tcp.winsize,
            rst: true,
            ack: packet.tcp.syn
        };
        adapter.receive(make_packet(adapter.eth_encoder_buf, reply));
        return true;
    }

    adapter.tcp_conn[tuple].process(packet);
}

function handle_fake_dns_static(packet, adapter)
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
            case 1: // A record
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
    adapter.receive(make_packet(adapter.eth_encoder_buf, reply));
    return true;
}

function handle_fake_dns_doh(packet, adapter)
{
    const fetch_url = `https://${adapter.doh_server || DEFAULT_DOH_SERVER}/dns-query`;
    const fetch_opts = {
        method: "POST",
        headers: [["content-type", "application/dns-message"]],
        body: packet.udp.data
    };
    fetch(fetch_url, fetch_opts).then(async (resp) => {
        const reply = {
            eth: {
                ethertype: ETHERTYPE_IPV4,
                src: adapter.router_mac,
                dest: packet.eth.src
            },
            ipv4: {
                proto: IPV4_PROTO_UDP,
                src: adapter.router_ip,
                dest: packet.ipv4.src
            },
            udp: {
                sport: 53,
                dport: packet.udp.sport,
                data: new Uint8Array(await resp.arrayBuffer())
            }
        };
        adapter.receive(make_packet(adapter.eth_encoder_buf, reply));
    });
    return true;
}

function handle_fake_dns(packet, adapter)
{
    if(adapter.dns_method === "static") {
        return handle_fake_dns_static(packet, adapter);
    }
    else {
        return handle_fake_dns_doh(packet, adapter);
    }
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
    adapter.receive(make_packet(adapter.eth_encoder_buf, reply));
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
    adapter.receive(make_packet(adapter.eth_encoder_buf, reply));
}

export function handle_fake_networking(data, adapter) {
    let packet = {};
    parse_eth(data, packet);

    if(packet.ipv4) {
        if(packet.tcp) {
            handle_fake_tcp(packet, adapter);
        }
        else if(packet.udp) {
            if(packet.dns) {
                handle_fake_dns(packet, adapter);
            }
            else if(packet.dhcp) {
                handle_fake_dhcp(packet, adapter);
            }
            else if(packet.ntp) {
                handle_fake_ntp(packet, adapter);
            }
            else if(packet.udp.dport === 8) {
                handle_udp_echo(packet, adapter);
            }
        }
        else if(packet.icmp && packet.icmp.type === 8) {
            handle_fake_ping(packet, adapter);
        }
    }
    else if(packet.arp && packet.arp.oper === 1 && packet.arp.ptype === ETHERTYPE_IPV4) {
        arp_whohas(packet, adapter);
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

    // TODO: Remove CRC from the end of the packet maybe?
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

function write_eth(spec, out) {
    const view = out.eth_frame_view;
    view_set_array(0, spec.eth.dest, view, out);
    view_set_array(6, spec.eth.src, view, out);
    view.setUint16(12, spec.eth.ethertype);
    let len = ETH_HEADER_SIZE;
    if(spec.arp) {
        len += write_arp(spec, out);
    }
    else if(spec.ipv4) {
        len += write_ipv4(spec, out);
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

function write_arp(spec, out) {
    const view = out.eth_payload_view;
    view.setUint16(0, spec.arp.htype);
    view.setUint16(2, spec.arp.ptype);
    view.setUint8(4, spec.arp.sha.length);
    view.setUint8(5, spec.arp.spa.length);
    view.setUint16(6, spec.arp.oper);
    view_set_array(8, spec.arp.sha, view, out);
    view_set_array(14, spec.arp.spa, view, out);
    view_set_array(18, spec.arp.tha, view, out);
    view_set_array(24, spec.arp.tpa, view, out);
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
    if(Math.max(len, 46) !== data.length) {
        dbg_log(`ipv4 Length mismatch: ${len} != ${data.length}`, LOG_FETCH);
    }

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

function write_ipv4(spec, out) {
    const view = out.eth_payload_view;
    const ihl = IPV4_HEADER_SIZE >> 2; // header length in 32-bit words
    const version = 4;

    let len = IPV4_HEADER_SIZE;
    if(spec.icmp) {
        len += write_icmp(spec, out);
    }
    else if(spec.udp) {
        len += write_udp(spec, out);
    }
    else if(spec.tcp) {
        len += write_tcp(spec, out);
    }

    view.setUint8(0, version << 4 | (ihl & 0x0F));
    view.setUint8(1, spec.ipv4.tos || 0);
    view.setUint16(2, len);
    view.setUint16(4, spec.ipv4.id || 0);
    view.setUint8(6, 2 << 5); // DF Flag
    view.setUint8(8, spec.ipv4.ttl || 32);
    view.setUint8(9, spec.ipv4.proto);
    view.setUint16(10, 0); // checksum initially zero before calculation
    view_set_array(12, spec.ipv4.src, view, out);
    view_set_array(16, spec.ipv4.dest, view, out);
    view.setUint16(10, calc_inet_checksum(IPV4_HEADER_SIZE, 0, view, out));
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

function write_icmp(spec, out) {
    const view = out.ipv4_payload_view;
    view.setUint8(0, spec.icmp.type);
    view.setUint8(1, spec.icmp.code);
    view.setUint16(2, 0); // checksum initially zero before calculation
    const data_length = view_set_array(ICMP_HEADER_SIZE, spec.icmp.data, view, out);
    const total_length = ICMP_HEADER_SIZE + data_length;
    view.setUint16(2, calc_inet_checksum(total_length, 0, view, out));
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

function write_udp(spec, out) {
    const view = out.ipv4_payload_view;
    let total_length = UDP_HEADER_SIZE;
    if(spec.dhcp) {
        total_length += write_dhcp(spec, out);
    }
    else if(spec.dns) {
        total_length += write_dns(spec, out);
    }
    else if(spec.ntp) {
        total_length += write_ntp(spec, out);
    }
    else {
        total_length += view_set_array(0, spec.udp.data, out.udp_payload_view, out);
    }

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
    view.setUint16(6, calc_inet_checksum(total_length, pseudo_header, view, out));
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

function write_dns(spec, out) {
    const view = out.udp_payload_view;
    view.setUint16(0, spec.dns.id);
    view.setUint16(2, spec.dns.flags);
    view.setUint16(4, spec.dns.questions.length);
    view.setUint16(6, spec.dns.answers.length);

    let offset = 12;
    for(let i = 0; i < spec.dns.questions.length; ++i) {
        let q = spec.dns.questions[i];
        for(let s of q.name) {
            const n_written = view_set_string(offset + 1, s, view, out);
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
            const n_written = view_set_string(offset + 1, s, view, out);
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
        offset += view_set_array(offset, a.data, view, out);
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

function write_dhcp(spec, out) {
    const view = out.udp_payload_view;
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
    view_set_array(28, spec.dhcp.chaddr, view, out);

    view.setUint32(236, DHCP_MAGIC_COOKIE);

    let offset = 240;
    for(let o of spec.dhcp.options) {
        offset += view_set_array(offset, o, view, out);
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

function write_ntp(spec, out) {
    const view = out.udp_payload_view;
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

function write_tcp(spec, out) {
    const view = out.ipv4_payload_view;
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

    let total_length = TCP_HEADER_SIZE;
    if(spec.tcp_data) {
        total_length += view_set_array(TCP_HEADER_SIZE, spec.tcp_data, view, out);
    }

    const pseudo_header =
        (spec.ipv4.src[0] << 8 | spec.ipv4.src[1]) +
        (spec.ipv4.src[2] << 8 | spec.ipv4.src[3]) +
        (spec.ipv4.dest[0] << 8 | spec.ipv4.dest[1]) +
        (spec.ipv4.dest[2] << 8 | spec.ipv4.dest[3]) +
        IPV4_PROTO_TCP +
        total_length;
    view.setUint16(16, calc_inet_checksum(total_length, pseudo_header, view, out));
    return total_length;
}

export function fake_tcp_connect(dport, adapter)
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

    let conn = new TCPConnection();

    conn.tuple = tuple;
    conn.hsrc = adapter.router_mac;
    conn.psrc = adapter.router_ip;
    conn.sport = sport;
    conn.hdest = adapter.vm_mac;
    conn.dport = dport;
    conn.pdest = adapter.vm_ip;
    conn.net = adapter;
    adapter.tcp_conn[tuple] = conn;
    conn.connect();
    return conn;
}

export function fake_tcp_probe(dport, adapter) {
    return new Promise((res, rej) => {
        let handle = fake_tcp_connect(dport, adapter);
        handle.state = TCP_STATE_SYN_PROBE;
        handle.on("probe", res);
    });
}

/**
 * @constructor
 */
export function TCPConnection()
{
    this.state = TCP_STATE_CLOSED;
    this.net = null; // The adapter is stored here
    this.send_buffer = new GrowableRingbuffer(2048, 0);
    this.send_chunk_buf = new Uint8Array(TCP_PAYLOAD_SIZE);
    this.in_active_close = false;
    this.delayed_send_fin = false;
    this.delayed_state = undefined;
    this.events_handlers = {};
}

TCPConnection.prototype.on = function(event, handler) {
    this.events_handlers[event] = handler;
};

TCPConnection.prototype.emit = function(event, ...args) {
    if(!this.events_handlers[event]) return;
    this.events_handlers[event].apply(this, args);
};


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

TCPConnection.prototype.packet_reply = function(packet, tcp_options) {
    const reply_tcp = {
        sport: packet.tcp.dport,
        dport: packet.tcp.sport,
        winsize: packet.tcp.winsize,
        ackn: this.ack,
        seq: this.seq
    };
    if(tcp_options) {
        for(const opt in tcp_options) {
            reply_tcp[opt] = tcp_options[opt];
        }
    }
    const reply = this.ipv4_reply();
    reply.tcp = reply_tcp;
    return reply;
};


TCPConnection.prototype.connect = function() {
    // dbg_log(`TCP[${this.tuple}]: connect(): sending SYN+ACK in state "${this.state}", next "${TCP_STATE_SYN_SENT}"`, LOG_FETCH);
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
    this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
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
    // dbg_log(`TCP[${this.tuple}]: accept(): sending SYN+ACK in state "${this.state}", next "${TCP_STATE_ESTABLISHED}"`, LOG_FETCH);
    this.state = TCP_STATE_ESTABLISHED;
    this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
};

TCPConnection.prototype.process = function(packet) {
    if(this.state === TCP_STATE_CLOSED) {
        // dbg_log(`TCP[${this.tuple}]: WARNING: connection already closed, packet dropped`, LOG_FETCH);
        const reply = this.packet_reply(packet, {rst: true});
        this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
        return;
    }
    else if(packet.tcp.rst) {
        if(this.state === TCP_STATE_SYN_PROBE) {
            this.emit("probe", false);
            this.release();
            return;
        }
        // dbg_log(`TCP[${this.tuple}]: received RST in state "${this.state}"`, LOG_FETCH);
        this.on_close();
        this.release();
        return;
    }
    else if(packet.tcp.syn) {
        if(this.state === TCP_STATE_SYN_SENT && packet.tcp.ack) {
            this.ack = packet.tcp.seq + 1;
            this.start_seq = packet.tcp.seq;
            this.last_received_ackn = packet.tcp.ackn;

            const reply = this.ipv4_reply();
            this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
            // dbg_log(`TCP[${this.tuple}]: received SYN+ACK in state "${this.state}", next "${TCP_STATE_ESTABLISHED}"`, LOG_FETCH);
            this.state = TCP_STATE_ESTABLISHED;
            this.emit("connect");
        }
        else if(this.state === TCP_STATE_SYN_PROBE && packet.tcp.ack) {
            this.emit("probe", true);
            const reply = this.packet_reply(packet, {rst: true});
            this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
            this.release();
        }
        else {
            dbg_log(`TCP[${this.tuple}]: WARNING: unexpected SYN packet dropped`, LOG_FETCH);
        }
        if(packet.tcp_data.length) {
            dbg_log(`TCP[${this.tuple}]: WARNING: ${packet.tcp_data.length} bytes of unexpected SYN packet payload dropped`, LOG_FETCH);
        }
        return;
    }

    if(packet.tcp.ack) {
        if(this.state === TCP_STATE_SYN_RECEIVED) {
            // dbg_log(`TCP[${this.tuple}]: received ACK in state "${this.state}", next "${TCP_STATE_ESTABLISHED}"`, LOG_FETCH);
            this.state = TCP_STATE_ESTABLISHED;
        }
        else if(this.state === TCP_STATE_FIN_WAIT_1) {
            if(!packet.tcp.fin) {   // handle FIN+ACK in FIN_WAIT_1 separately further down below
                // dbg_log(`TCP[${this.tuple}]: received ACK in state "${this.state}", next "${TCP_STATE_FIN_WAIT_2}"`, LOG_FETCH);
                this.state = TCP_STATE_FIN_WAIT_2;
            }
        }
        else if(this.state === TCP_STATE_CLOSING || this.state === TCP_STATE_LAST_ACK) {
            // dbg_log(`TCP[${this.tuple}]: received ACK in state "${this.state}"`, LOG_FETCH);
            this.release();
            return;
        }
    }

    if(this.last_received_ackn === undefined) {
        this.last_received_ackn = packet.tcp.ackn;
    }
    else {
        const n_ack = packet.tcp.ackn - this.last_received_ackn;
        //console.log("Read ", n_ack, "(", this.last_received_ackn, ") ", packet.tcp.ackn, packet.tcp.winsize)
        if(n_ack > 0) {
            this.last_received_ackn = packet.tcp.ackn;
            this.send_buffer.remove(n_ack);
            this.seq += n_ack;
            this.pending = false;

            if(this.delayed_send_fin && !this.send_buffer.length) {
                // dbg_log(`TCP[${this.tuple}]: sending delayed FIN from active close in state "${this.state}", next "${this.delayed_state}"`, LOG_FETCH);
                this.delayed_send_fin = false;
                this.state = this.delayed_state;
                const reply = this.ipv4_reply();
                reply.tcp.fin = true;
                this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
                return;
            }
        }
        else if(n_ack < 0) {    // TODO: could this just be a 32-bit sequence number overflow?
            dbg_log(`TCP[${this.tuple}]: ERROR: ack underflow (pkt=${packet.tcp.ackn} last=${this.last_received_ackn}), resetting`, LOG_FETCH);
            const reply = this.packet_reply(packet, {rst: true});
            this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
            this.on_close();
            this.release();
            return;
        }
    }

    if(packet.tcp.fin) {
        if(this.ack !== packet.tcp.seq) {
            dbg_log(`TCP[${this.tuple}]: WARNING: closing connection in state "${this.state}" with invalid seq (${this.ack} != ${packet.tcp.seq})`, LOG_FETCH);
        }
        ++this.ack; // FIN increases seqnr
        const reply = this.packet_reply(packet, {});
        if(this.state === TCP_STATE_ESTABLISHED) {
            // dbg_log(`TCP[${this.tuple}]: received FIN in state "${this.state}, next "${TCP_STATE_CLOSE_WAIT}""`, LOG_FETCH);
            reply.tcp.ack = true;
            this.state = TCP_STATE_CLOSE_WAIT;
            this.on_shutdown();
        }
        else if(this.state === TCP_STATE_FIN_WAIT_1) {
            if(packet.tcp.ack) {
                // dbg_log(`TCP[${this.tuple}]: received ACK+FIN in state "${this.state}"`, LOG_FETCH);
                this.release();
            }
            else {
                // dbg_log(`TCP[${this.tuple}]: received ACK in state "${this.state}", next "${TCP_STATE_CLOSING}"`, LOG_FETCH);
                this.state = TCP_STATE_CLOSING;
            }
            reply.tcp.ack = true;
        }
        else if(this.state === TCP_STATE_FIN_WAIT_2) {
            // dbg_log(`TCP[${this.tuple}]: received FIN in state "${this.state}"`, LOG_FETCH);
            this.release();
            reply.tcp.ack = true;
        }
        else {
            // dbg_log(`TCP[${this.tuple}]: ERROR: received FIN in unexpected TCP state "${this.state}", resetting`, LOG_FETCH);
            this.release();
            this.on_close();
            reply.tcp.rst = true;
        }
        this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
    }
    else if(this.ack !== packet.tcp.seq) {
        // Handle TCP Keep-Alives silently.
        // Excerpt from RFC 9293, 3.8.4. TCP Keep-Alives:
        //   To confirm that an idle connection is still active, these
        //   implementations send a probe segment designed to elicit a response
        //   from the TCP peer.  Such a segment generally contains SEG.SEQ =
        //   SND.NXT-1 and may or may not contain one garbage octet of data.
        if(this.ack !== packet.tcp.seq + 1) {
            dbg_log(`Packet seq was wrong ex: ${this.ack} ~${this.ack - this.start_seq} ` +
                `pk: ${packet.tcp.seq} ~${this.start_seq - packet.tcp.seq} ` +
                `(${this.ack - packet.tcp.seq}) = ${this.name}`, LOG_FETCH);
        }
        const reply = this.packet_reply(packet, {ack: true});
        this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
    }
    else if(packet.tcp.ack && packet.tcp_data.length > 0) {
        this.ack += packet.tcp_data.length;
        const reply = this.ipv4_reply();
        this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
        this.emit("data", packet.tcp_data);
    }

    this.pump();
};

/**
 * @param {Uint8Array} data
 */
TCPConnection.prototype.write = function(data) {
    if(!this.in_active_close) {
        this.send_buffer.write(data);
    }
    this.pump();
};

/**
 * @param {!Array<Uint8Array>} data_array
 */
TCPConnection.prototype.writev = function(data_array) {
    if(!this.in_active_close) {
        for(const data of data_array) {
            this.send_buffer.write(data);
        }
    }
    this.pump();
};

TCPConnection.prototype.close = function() {
    if(!this.in_active_close) {
        this.in_active_close = true;
        let next_state;
        if(this.state === TCP_STATE_ESTABLISHED || this.state === TCP_STATE_SYN_RECEIVED) {
            next_state = TCP_STATE_FIN_WAIT_1;
        }
        else if(this.state === TCP_STATE_CLOSE_WAIT) {
            next_state = TCP_STATE_LAST_ACK;
        }
        else {
            if(this.state !== TCP_STATE_SYN_SENT) {
                dbg_log(`TCP[${this.tuple}]: active close in unexpected state "${this.state}"`, LOG_FETCH);
            }
            this.release();
            return;
        }

        if(this.send_buffer.length || this.pending) {
            // dbg_log(`TCP[${this.tuple}]: active close, delaying FIN in state "${this.state}", delayed next "${next_state}"`, LOG_FETCH);
            this.delayed_send_fin = true;
            this.delayed_state = next_state;
        }
        else {
            // dbg_log(`TCP[${this.tuple}]: active close, sending FIN in state "${this.state}", next "${next_state}"`, LOG_FETCH);
            this.state = next_state;
            const reply = this.ipv4_reply();
            reply.tcp.fin = true;
            this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
        }
    }
    this.pump();
};

TCPConnection.prototype.on_shutdown = function() {
    this.emit("shutdown");
    // forward FIN event from guest device to network adapter
};

TCPConnection.prototype.on_close = function() {
    this.emit("close");
    // forward RST event from guest device to network adapter
};

TCPConnection.prototype.release = function() {
    if(this.net.tcp_conn[this.tuple]) {
        // dbg_log(`TCP[${this.tuple}]: connection closed in state "${this.state}"`, LOG_FETCH);
        this.state = TCP_STATE_CLOSED;
        delete this.net.tcp_conn[this.tuple];
    }
};

TCPConnection.prototype.pump = function() {
    if(this.send_buffer.length && !this.pending) {
        const data = this.send_chunk_buf;
        const n_ready = this.send_buffer.peek(data);
        const reply = this.ipv4_reply();
        reply.tcp.psh = true;
        reply.tcp_data = data.subarray(0, n_ready);
        this.net.receive(make_packet(this.net.eth_encoder_buf, reply));
        this.pending = true;
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
    adapter.receive(make_packet(adapter.eth_encoder_buf, reply));
}

function handle_fake_ping(packet, adapter) {
    let reply = {};
    reply.eth = { ethertype: ETHERTYPE_IPV4, src: adapter.router_mac, dest: packet.eth.src };
    reply.ipv4 = {
        proto: IPV4_PROTO_ICMP,
        src: packet.ipv4.dest,
        dest: packet.ipv4.src,
    };
    reply.icmp = {
        type: 0,
        code: packet.icmp.code,
        data: packet.icmp.data
    };
    adapter.receive(make_packet(adapter.eth_encoder_buf, reply));
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
    adapter.receive(make_packet(adapter.eth_encoder_buf, reply));
}
