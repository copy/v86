// The GLES backdoor device of arm32 user code (docs/gles-proxy-plan.md
// "iOS 传输", E6; the core's side: src/rust/aarch64/backdoor.rs): a process
// without a driver reaches the GLES host's services ("opengles",
// "GLProcessPipe", as Android's goldfish pipe does) with UDF #0x8664.
//
// A call: r0 = 0x8664 << 16 | command, r1 a user address, r2 a length,
// r3 a connection; the answer in r0:
//   PROBE    the backdoor's version (1)
//   OPEN     r1, r2 the service's name: a connection (1 up)
//   WRITE    r3's service gets r2 bytes at r1: r2
//   READ     at most r2 of r3's bytes for the guest into r1: how many;
//            AGAIN when it has none yet (the guest library polls, yielding)
//   POLL     whether r3 has bytes for the guest: 1 or 0
//   CLOSE    r3 closed: 0
// Errors: FAULT (a page of the buffer is not mapped for the access: the
// library touches its pages and calls again; nothing happened), AGAIN,
// INVALID (a command, connection or service this does not know), CLOSED.
//
// Buffers are translated page by page through the calling core's tables
// (env.a32_backdoor_translate) and read or written in guest memory; a call
// checks every page before it does anything. The guest's library writes a
// connection's commands as the pipe's clients do (a u32 of flags, then the
// commands) and reads the replies it waits for: the services cannot tell the
// two transports apart.
//
// A snapshot keeps each connection with its service's state, as the pipe's
// channels (src/virt/goldfish.js).

/** r0's top half for a call */
export const BACKDOOR_CALL = 0x8664;
export const BACKDOOR_VERSION = 1;
export const BACKDOOR = { PROBE: 0, OPEN: 1, WRITE: 2, READ: 3, POLL: 4, CLOSE: 5 };
export const BACKDOOR_ERROR = { FAULT: -1, AGAIN: -2, INVALID: -3, CLOSED: -4 };
/** The core's "not a call": the UDF is the undefined instruction it was (src/rust/aarch64/backdoor.rs) */
export const BACKDOOR_NOT_HANDLED = -0x80000000;

/** A service name or a single call's buffer at most this long (a 4096 by 4096 RGBA texture, with room) */
const MAX_BUFFER = 80 << 20;

/**
 * @constructor
 * @param {?} cpu the ARM CPU: read_blob_physical, write_blob_physical, and
 *     its core's translate(va, write) (a physical address, or -1)
 * @param {function(string, function(), *=): ?Object} services a name (and
 *     at a restore the service's state) to its service, or null
 */
export function BackdoorA32(cpu, services)
{
    this.cpu = cpu;
    this.services = services;
    /** @type {!Map<number, {name: string, service: !Object}>} */
    this.connections = new Map();
    this.next = 1;
    this.calls = 0;
}

BackdoorA32.prototype.reset = function()
{
    for(const conn of this.connections.values()) conn.service.close();
    this.connections.clear();
    this.next = 1;
};

/**
 * The physical ranges of a user buffer, page by page, or null at a fault
 * @param {number} address
 * @param {number} length
 * @param {boolean} write
 * @return {?Array<!Array<number>>} [physical address, bytes]
 */
BackdoorA32.prototype.ranges = function(address, length, write)
{
    const ranges = [];
    for(let at = address >>> 0, end = (address >>> 0) + length; at < end;)
    {
        const n = Math.min(end - at, 0x1000 - (at & 0xFFF));
        const physical = this.cpu.translate_user(at, write);
        if(physical < 0) return null;
        const last = ranges[ranges.length - 1];
        if(last && last[0] + last[1] === physical) last[1] += n;
        else ranges.push([physical, n]);
        at += n;
    }
    return ranges;
};

/** @return {?Uint8Array} the user buffer's bytes, or null at a fault */
BackdoorA32.prototype.read_user = function(address, length)
{
    const ranges = this.ranges(address, length, false);
    if(!ranges) return null;
    if(ranges.length === 1) return this.cpu.read_blob_physical(ranges[0][0], ranges[0][1]).slice();
    const bytes = new Uint8Array(length);
    let at = 0;
    for(const [physical, n] of ranges)
    {
        bytes.set(this.cpu.read_blob_physical(physical, n), at);
        at += n;
    }
    return bytes;
};

/**
 * r0 to r3 of a call: the answer for r0
 * @return {number}
 */
BackdoorA32.prototype.call = function(r0, r1, r2, r3)
{
    this.calls++;
    const command = r0 & 0xFFFF, address = r1 >>> 0, length = r2 >>> 0;
    if(length > MAX_BUFFER) return BACKDOOR_ERROR.INVALID;
    if(command === BACKDOOR.PROBE) return BACKDOOR_VERSION;
    if(command === BACKDOOR.OPEN)
    {
        if(length === 0 || length > 256) return BACKDOOR_ERROR.INVALID;
        const bytes = this.read_user(address, length);
        if(!bytes) return BACKDOOR_ERROR.FAULT;
        const end = bytes.indexOf(0);
        const name = new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
        const id = this.next;
        const service = this.services(name, () => {});
        if(!service) return BACKDOOR_ERROR.INVALID;
        this.next = this.next % 0x7FFFFFFF + 1;
        this.connections.set(id, { name, service });
        return id;
    }
    const conn = this.connections.get(r3 >>> 0);
    if(!conn) return BACKDOOR_ERROR.INVALID;
    switch(command)
    {
        case BACKDOOR.WRITE:
        {
            const bytes = this.read_user(address, length);
            if(!bytes) return BACKDOOR_ERROR.FAULT;
            conn.service.write(bytes);
            return length;
        }
        case BACKDOOR.READ:
        {
            if(!conn.service.available()) return BACKDOOR_ERROR.AGAIN;
            // (every page writable first: a fault takes nothing from the service)
            const ranges = this.ranges(address, length, true);
            if(!ranges) return BACKDOOR_ERROR.FAULT;
            const bytes = conn.service.read(length);
            if(!bytes || !bytes.length) return BACKDOOR_ERROR.AGAIN;
            let at = 0;
            for(const [physical, n] of ranges)
            {
                if(at >= bytes.length) break;
                const part = bytes.subarray(at, at + n);
                this.cpu.write_blob_physical(part, physical);
                at += part.length;
            }
            return bytes.length;
        }
        case BACKDOOR.POLL: return conn.service.available() ? 1 : 0;
        case BACKDOOR.CLOSE:
            conn.service.close();
            this.connections.delete(r3 >>> 0);
            return 0;
    }
    return BACKDOOR_ERROR.INVALID;
};

/** A snapshot's: the next connection, each connection with its service's state */
BackdoorA32.prototype.get_state = function()
{
    return [this.next, [...this.connections].map(([id, conn]) => [id, conn.name, conn.service.get_state ? conn.service.get_state() : null])];
};

BackdoorA32.prototype.set_state = function(state)
{
    this.reset();
    this.next = state[0];
    for(const [id, name, saved] of state[1])
    {
        // (a service that keeps no state: its connection is gone, the guest's calls get INVALID)
        const service = saved === null ? null : this.services(name, () => {}, saved);
        if(service) this.connections.set(id, { name, service });
    }
};
