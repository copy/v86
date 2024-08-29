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

const TCP_STATE_CLOSED = "closed";
const TCP_STATE_LISTEN = "listen";
const TCP_STATE_ESTABLISHED = "established";
const TCP_STATE_FIN_WAIT_1 = "fin-wait-1";
const TCP_STATE_CLOSE_WAIT = "close-wait";
const TCP_STATE_FIN_WAIT_2 = "fin-wait-2";
const TCP_STATE_LAST_ACK = "last-ack";
const TCP_STATE_CLOSING = "closing";
const TCP_STATE_TIME_WAIT = "time-wait";
const TCP_STATE_SYN_RECEIVED = "syn-received";
const TCP_STATE_SYN_SENT = "syn-sent";

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

function handle_fake_tcp(packet, adapter)
{
    let reply = {};
    reply.eth = { ethertype: ETHERTYPE_IPV4, src: adapter.router_mac, dest: packet.eth.src };
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
        if(adapter.tcp_conn[tuple]) {
            dbg_log("SYN to already opened port", LOG_FETCH);
        }
        if(adapter.on_tcp_connection(adapter, packet, tuple)) return;
    }

    if(!adapter.tcp_conn[tuple]) {
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
        if(handle_fake_tcp(packet, adapter)) return true;
    }

    if(packet.arp && packet.arp.oper === 1 && packet.arp.ptype === ETHERTYPE_IPV4) {
        arp_whohas(packet, adapter);
    }

    if(packet.dns) {
        if(handle_fake_dns(packet, adapter)) return;
    }

    if(packet.ntp) {
        if(handle_fake_ntp(packet, adapter)) return;
    }

    // ICMP Ping
    if(packet.icmp && packet.icmp.type === 8) {
        handle_fake_ping(packet, adapter);
    }

    if(packet.dhcp) {
        if(handle_fake_dhcp(packet, adapter)) return;
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
    let payload = data.subarray(14, data.length);

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

function write_eth(spec, data) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setUint16(12, spec.eth.ethertype);
    for(let i = 0; i < 6; ++i ) view.setUint8(0 + i, spec.eth.dest[i]);
    for(let i = 0; i < 6; ++i ) view.setUint8(6 + i, spec.eth.src[i]);

    let len = 14;
    if(spec.arp) {
        len += write_arp(spec, data.subarray(14));
    }
    if(spec.ipv4) {
        len += write_ipv4(spec, data.subarray(14));
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

function write_arp(spec, data) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setUint16(0, spec.arp.htype);
    view.setUint16(2, spec.arp.ptype);
    view.setUint8(4, spec.arp.sha.length);
    view.setUint8(5, spec.arp.spa.length);
    view.setUint16(6, spec.arp.oper);

    for(let i = 0; i < 6; ++i) {
        view.setUint8(8 + i, spec.arp.sha[i]);
        view.setUint8(18 + i, spec.arp.tha[i]);
    }

    for(let i = 0; i < 4; ++i) {
        view.setUint8(14 + i, spec.arp.spa[i]);
        view.setUint8(24 + i, spec.arp.tpa[i]);
    }

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
    if(proto === IPV4_PROTO_TCP) {
        parse_tcp(ipdata, o);
    }
    if(proto === IPV4_PROTO_UDP) {
        parse_udp(ipdata, o);
    }


    return true;
}

function write_ipv4(spec, data) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    let ihl = 5; // 20 byte header length normally
    let version = 4;
    let len = 4 * ihl; // Total Length

    if(spec.icmp) {
        len += write_icmp(spec, data.subarray(ihl * 4));
    }
    if(spec.udp) {
        len += write_udp(spec, data.subarray(ihl * 4));
    }
    if(spec.tcp) {
        len += write_tcp(spec, data.subarray(ihl * 4));
    }
    if(spec.tcp_data) {
        // TODO(perf)
        for(let i = 0; i < spec.tcp_data.length; ++i) {
            view.setUint8(len + i, spec.tcp_data[i]);
        }
        len += spec.tcp_data.length;
    }

    view.setUint8(0, version << 4 | (ihl & 0x0F));
    view.setUint8(1, spec.ipv4.tos || 0);
    view.setUint16(2, len);
    view.setUint16(4, spec.ipv4.id || 0);
    view.setUint8(6, 2 << 5); // DF Flag
    view.setUint8(8, spec.ipv4.ttl || 32);
    view.setUint8(9, spec.ipv4.proto);
    view.setUint16(10, 0); // Checksum is zero during hashing

    for(let i = 0; i < 4; ++i) {
        view.setUint8(12 + i, spec.ipv4.src[i]);
        view.setUint8(16 + i, spec.ipv4.dest[i]);
    }

    let checksum = 0;
    for(let i = 0; i < ihl * 2; ++i) {
        // TODO(perf)
        checksum += view.getUint16(i << 1);
        if(checksum > 0xFFFF) {
            checksum = (checksum & 0xFFFF) + 1;
        }
    }

    view.setUint16(10, checksum ^ 0xFFFF);

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
    return true;
}

function write_icmp(spec, data) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setUint8(0, spec.icmp.type);
    view.setUint8(1, spec.icmp.code);
    view.setUint16(2, 0); // checksum 0 during calc

    for(let i = 0; i < spec.icmp.data.length; ++i) {
        view.setUint8(i + 4, spec.icmp.data[i]);
    }

    let checksum = 0;
    for(let i = 0; i < 4 + spec.icmp.data.length; i += 2) {
        // TODO(perf)
        checksum += view.getUint16(i);
        if(checksum > 0xFFFF) {
            checksum = (checksum & 0xFFFF) + 1;
        }
    }

    view.setUint16(2, checksum ^ 0xFFFF);

    return 4 + spec.icmp.data.length;
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
    if(udp.dport === 53 || udp.sport === 53) {
        parse_dns(data.subarray(8), o);
    }
    if(udp.dport === 123) {
        parse_ntp(data.subarray(8), o);
    }
    o.udp = udp;
    return true;
}

function write_udp(spec, data) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    let payload_length;

    if(spec.dhcp) {
        payload_length = write_dhcp(spec, data.subarray(8));
    } else if(spec.dns) {
        payload_length = write_dns(spec, data.subarray(8));
    } else if(spec.ntp) {
        payload_length = write_ntp(spec, data.subarray(8));
    } else {
        let raw_data = spec.udp.data;
        payload_length = raw_data.length;
        for(let i = 0; i < raw_data.length; ++i) {
            view.setUint8(8+i, raw_data[i]);
        }
    }

    view.setUint16(0, spec.udp.sport);
    view.setUint16(2, spec.udp.dport);
    view.setUint16(4, 8 + payload_length);
    view.setUint16(6, 0); // Checksum

    return 8 + payload_length;
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

function write_dns(spec, data) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    view.setUint16(0, spec.dns.id);
    view.setUint16(2, spec.dns.flags);
    view.setUint16(4, spec.dns.questions.length);
    view.setUint16(6, spec.dns.answers.length);

    let offset = 12;
    for(let i = 0; i < spec.dns.questions.length; ++i) {
        let q = spec.dns.questions[i];
        for(let s of q.name) {
            view.setUint8(offset, s.length);
            offset++;
            for( let ii = 0; ii < s.length; ++ii) {
                view.setUint8(offset, s.charCodeAt(ii));
                offset++;
            }
        }
        view.setUint16(offset, q.type);
        offset += 2;
        view.setUint16(offset, q.class);
        offset += 2;
    }

    function write_reply(a) {
        for(let s of a.name) {
            view.setUint8(offset, s.length);
            offset++;
            for( let ii = 0; ii < s.length; ++ii) {
                view.setUint8(offset, s.charCodeAt(ii));
                offset++;
            }
        }
        view.setUint16(offset, a.type);
        offset += 2;
        view.setUint16(offset, a.class);
        offset += 2;
        view.setUint32(offset, a.ttl);
        offset += 4;
        view.setUint16(offset, a.data.length);
        offset += 2;

        for(let ii = 0; ii < a.data.length; ++ii) {
            view.setUint8(offset + ii, a.data[ii]);
        }

        offset += a.data.length;
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
    return true;
}

function write_dhcp(spec, data) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);

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

    for(let i = 0; i < spec.dhcp.chaddr.length; ++i) {
        view.setUint8(28+i, spec.dhcp.chaddr[i]);
    }

    view.setUint32(236, DHCP_MAGIC_COOKIE);

    let offset = 240;
    for(let o of spec.dhcp.options) {
        for(let i = 0; i < o.length; ++i) {
            view.setUint8(offset, o[i]);
            ++offset;
        }
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
    return true;
}

function write_ntp(spec, data) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);

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
    return true;
}

function write_tcp(spec, data) {
    let view = new DataView(data.buffer, data.byteOffset, data.byteLength);

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

    let doff = 5;

    view.setUint16(0, tcp.sport);
    view.setUint16(2, tcp.dport);
    view.setUint32(4, tcp.seq);
    view.setUint32(8, tcp.ackn);
    view.setUint8(12, doff << 4);
    view.setUint8(13, flags);
    view.setUint16(14, tcp.winsize);
    view.setUint16(16, 0); // Checksum is 0 during calculation
    view.setUint16(18, tcp.urgent || 0);

    let total_len = (doff * 4) + (spec.tcp_data ? spec.tcp_data.length : 0);

    let checksum = 0;
    let psudo_header = new Uint8Array(12);
    let phview = new DataView(psudo_header.buffer, psudo_header.byteOffset, psudo_header.byteLength);
    for(let i = 0; i < 4; ++i) {
        phview.setUint8(i, spec.ipv4.src[i]);
        phview.setUint8(4 + i, spec.ipv4.dest[i]);
    }
    phview.setUint8(9, IPV4_PROTO_TCP);
    phview.setUint16(10, total_len);

    for(let i = 0; i < 6; ++i) {
        // TODO(perf)
        checksum += phview.getUint16(i << 1);
        if(checksum > 0xFFFF) {
            checksum = (checksum & 0xFFFF) + 1;
        }
    }
    for(let i = 0; i < doff * 2; ++i) {
        checksum += view.getUint16(i << 1);
        if(checksum > 0xFFFF) {
            checksum = (checksum & 0xFFFF) + 1;
        }
    }

    if(spec.tcp_data) {
        for(let i = 0; i < spec.tcp_data.length; i += 2) {
            checksum += spec.tcp_data[i] << 8 | spec.tcp_data[i+1];
            if(checksum > 0xFFFF) {
                checksum = (checksum & 0xFFFF) + 1;
            }
        }
    }
    view.setUint16(16, checksum ^ 0xFFFF);

    return doff * 4;
}

function make_packet(spec) {
    // TODO: Can we reuse this buffer?
    let bytes = new Uint8Array(1518); // Max ethernet packet size
    dbg_assert(spec.eth);

    let written = write_eth(spec, bytes);
    return bytes.subarray(0, written);
}

function fake_tcp_connect(dport, adapter)
{
    // TODO: check port collisions
    let sport = 49152 + Math.floor(Math.random() * 1000);
    let tuple = [
        adapter.vm_ip.join("."),
        dport,
        adapter.router_ip.join("."),
        sport
    ].join(":");

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
    this.send_buffer = new Uint8Array([]);
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
        this.send_buffer = this.send_buffer.subarray(nread);
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
    if(this.send_buffer.length > 0) {
        // TODO: Pretty inefficient
        let concat = new Uint8Array(this.send_buffer.byteLength + data.byteLength);
        concat.set(this.send_buffer, 0);
        concat.set(data, this.send_buffer.byteLength);
        this.send_buffer = concat;
    } else {
        this.send_buffer = data;
    }
    this.pump();
};

TCPConnection.prototype.close = function() {
    this.state = TCP_STATE_FIN_WAIT_1;
    let reply = this.ipv4_reply();
    reply.tcp.fin = true;
    this.net.receive(make_packet(reply));
    this.pump();
};

TCPConnection.prototype.pump = function() {

    if(this.send_buffer.length > 0 && !this.pending) {
        let data = this.send_buffer.subarray(0, 500);
        let reply = this.ipv4_reply();

        this.pending = true;
        if(this.send_buffer.length < 1) reply.tcp.fin = true;
        reply.tcp.psh = true;
        reply.tcp_data = data;
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
