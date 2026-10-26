// A TCP endpoint for network card tests, at the fake network's router
// (192.168.86.1, 52:54:00:01:02:03): it takes the guest's connections to its
// ports from the frames the card sends and answers through the card's
// receive path. Unlike the fake network's own TCP (one segment in flight) it
// keeps a window of segments in flight, so that a transfer measures the card
// and the guest rather than the round trips. In-order delivery only:
// segments after a gap are dropped and acknowledged as duplicates, the
// sender goes back to the first unacknowledged byte on three duplicates or
// a timeout.

import crypto from "node:crypto";

const ROUTER_MAC = [0x52, 0x54, 0x00, 0x01, 0x02, 0x03];
const ROUTER_IP = [192, 168, 86, 1];
const MSS = 1460;
const WINDOW = 65535;
const IN_FLIGHT = 48 * 1024;

const FIN = 1, SYN = 2, RST = 4, PSH = 8, ACK = 16;

function sum16(bytes, start, end, sum = 0)
{
    for(let i = start; i < end; i += 2) sum += bytes[i] << 8 | (i + 1 < end ? bytes[i + 1] : 0);
    while(sum > 0xFFFF) sum = (sum & 0xFFFF) + Math.floor(sum / 0x10000);
    return sum;
}

/**
 * Call it when the emulator is ready ("emulator-ready"): the network
 * adapter (the fake network's frames) exists from then on
 * @param {Object} emulator a V86
 * @param {Object<number, {serve?: function(Uint8Array): Uint8Array, sink?: function(Buffer)}>} ports
 *     serve: the response to the first data (the endpoint sends it and closes);
 *     sink: all data until the guest's FIN
 * @return {{stop: function()}}
 */
export function tcp_endpoint(emulator, ports)
{
    const connections = new Map();
    const adapter = emulator.network_adapter;
    const fake_send = adapter && adapter.send.bind(adapter);

    function deliver(frame)
    {
        emulator.bus.send("net0-receive", frame);
    }

    function segment(c, flags, payload = new Uint8Array(0), seq = c.snd_nxt, options = [])
    {
        const tcp_length = 20 + options.length + payload.length;
        const f = new Uint8Array(14 + 20 + tcp_length);
        f.set(c.guest_mac, 0); f.set(ROUTER_MAC, 6); f[12] = 0x08;
        const ip = 14;
        f[ip] = 0x45; f[ip + 2] = 20 + tcp_length >> 8; f[ip + 3] = 20 + tcp_length; f[ip + 6] = 0x40;
        f[ip + 8] = 64; f[ip + 9] = 6; f.set(ROUTER_IP, ip + 12); f.set(c.guest_ip, ip + 16);
        const ip_sum = ~sum16(f, ip, ip + 20) & 0xFFFF;
        f[ip + 10] = ip_sum >> 8; f[ip + 11] = ip_sum;
        const t = ip + 20;
        f[t] = c.port >> 8; f[t + 1] = c.port; f[t + 2] = c.guest_port >> 8; f[t + 3] = c.guest_port;
        new DataView(f.buffer).setUint32(t + 4, seq >>> 0);
        new DataView(f.buffer).setUint32(t + 8, c.rcv_nxt >>> 0);
        f[t + 12] = (20 + options.length) / 4 << 4; f[t + 13] = flags;
        f[t + 14] = WINDOW >> 8; f[t + 15] = WINDOW & 0xFF;
        f.set(options, t + 20);
        f.set(payload, t + 20 + options.length);
        const pseudo = sum16(f, ip + 12, ip + 20) + 6 + tcp_length;
        const tcp_sum = ~sum16(f, t, t + tcp_length, pseudo) & 0xFFFF;
        f[t + 16] = tcp_sum >> 8; f[t + 17] = tcp_sum;
        deliver(f);
    }

    /** Send what the window allows */
    function pump(c)
    {
        if(!c.out) return;
        const window = Math.min(c.guest_window, IN_FLIGHT);
        while(c.snd_nxt - c.snd_una < window && c.snd_nxt - c.data_seq < c.out.length)
        {
            const offset = c.snd_nxt - c.data_seq;
            const length = Math.min(MSS, c.out.length - offset, window - (c.snd_nxt - c.snd_una));
            if(length <= 0) break;
            segment(c, ACK | (offset + length === c.out.length ? PSH : 0), c.out.subarray(offset, offset + length));
            c.snd_nxt += length;
        }
        if(c.snd_una - c.data_seq === c.out.length && !c.fin_sent)
        {
            c.fin_sent = true;
            segment(c, FIN | ACK);
            c.snd_nxt += 1;
        }
    }

    function on_frame(f)
    {
        if(f.length < 54 || f[12] !== 0x08 || f[13] !== 0 || f[23] !== 6) return false;
        if(f[30] !== ROUTER_IP[0] || f[31] !== ROUTER_IP[1] || f[32] !== ROUTER_IP[2] || f[33] !== ROUTER_IP[3]) return false;
        const ip = 14, t = ip + ((f[ip] & 0xF) << 2);
        const port = f[t + 2] << 8 | f[t + 3];
        if(!ports[port]) return false;
        const view = new DataView(f.buffer, f.byteOffset, f.byteLength);
        const guest_port = f[t] << 8 | f[t + 1];
        const seq = view.getUint32(t + 4), ack = view.getUint32(t + 8);
        const flags = f[t + 13];
        const total = f[ip + 2] << 8 | f[ip + 3];
        const payload = f.subarray(t + (f[t + 12] >> 4 << 2), ip + total);
        const key = port + ":" + guest_port;
        let c = connections.get(key);

        if(flags & SYN)
        {
            c = {
                port, guest_port, guest_mac: f.slice(6, 12), guest_ip: f.slice(26, 30),
                rcv_nxt: seq + 1 >>> 0, snd_una: 0, snd_nxt: 0, data_seq: 0, guest_window: 0,
                out: null, received: [], fin_sent: false, guest_fin: false, dup: 0, last_progress: Date.now(), handler: ports[port],
            };
            const isn = crypto.randomBytes(4).readUInt32BE(0) >>> 1;
            c.snd_una = c.snd_nxt = isn;
            c.data_seq = isn + 1;
            connections.set(key, c);
            // (no window scaling: the guest's window is what its segments say)
            segment(c, SYN | ACK, undefined, isn, [2, 4, MSS >> 8, MSS & 0xFF]);
            c.snd_nxt = isn + 1;
            c.snd_una = isn;
            return true;
        }
        if(!c) return true;
        if(flags & RST) { connections.delete(key); return true; }

        c.guest_window = view.getUint16(t + 14);
        if(flags & ACK)
        {
            // relative to our first sequence number: no wrap within a test
            const acked = ack - c.snd_una | 0;
            if(acked > 0 && (ack - c.snd_nxt | 0) <= 0)
            {
                c.snd_una = ack >>> 0;
                c.dup = 0;
                c.last_progress = Date.now();
            }
            else if(acked === 0 && c.snd_nxt !== c.snd_una && !payload.length && ++c.dup === 3)
            {
                // three duplicates: from the first unacknowledged byte again
                c.snd_nxt = c.snd_una;
                c.dup = 0;
            }
        }
        if(payload.length)
        {
            if(seq === c.rcv_nxt)
            {
                c.rcv_nxt = c.rcv_nxt + payload.length >>> 0;
                if(c.handler.sink) c.received.push(Buffer.from(payload));
                else if(c.handler.serve && !c.out)
                {
                    c.out = c.handler.serve(payload);
                }
            }
            segment(c, ACK);
        }
        if(flags & FIN && !c.guest_fin && seq + payload.length >>> 0 === c.rcv_nxt)
        {
            c.guest_fin = true;
            c.rcv_nxt = c.rcv_nxt + 1 >>> 0;
            if(c.handler.sink)
            {
                c.out = new Uint8Array(0);
                c.handler.sink(Buffer.concat(c.received));
            }
            segment(c, ACK);
        }
        pump(c);
        if(c.fin_sent && c.snd_una === c.snd_nxt && c.guest_fin) connections.delete(key);
        return true;
    }

    // the card's frames: ours, or the fake network's
    if(adapter) adapter.send = frame => { if(!on_frame(frame)) fake_send(frame); };
    else emulator.add_listener("net0-send", on_frame);

    // a lost segment without three duplicates (the end of a transfer)
    const timer = setInterval(() => {
        for(const c of connections.values())
        {
            if(c.out && c.snd_nxt !== c.snd_una && Date.now() - c.last_progress > 300)
            {
                c.snd_nxt = c.snd_una;
                if(c.fin_sent && c.snd_una - c.data_seq === c.out.length) c.fin_sent = false;
                c.last_progress = Date.now();
                pump(c);
            }
        }
    }, 100);
    // (it does not keep the process alive)
    timer.unref();

    return {
        stop()
        {
            clearInterval(timer);
            if(adapter) adapter.send = fake_send;
        },
    };
}
