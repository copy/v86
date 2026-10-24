// (tools/gfxstream_protocol_runtime.js, copied into gfxstream_protocol.js)
//
// gfxstream's Vulkan encoding (its cereal marshaling, "reserved" for
// requests): little endian, each value in its C size, no padding; 64-bit
// values (sizes, handles, VkDeviceSize, 64-bit flags) are numbers here, exact
// below 2**53; a pointer's presence and a size_t are 8 bytes big endian, a
// string's length and a string array's count 4 bytes big endian.

const MAX_COUNT = 1 << 24;

/**
 * Reads a command's parameters
 * @constructor
 * @param {!Uint8Array} bytes
 * @param {number=} start
 * @param {number=} end
 */
export function GfxReader(bytes, start, end)
{
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = start || 0;
    this.end = end === undefined ? bytes.length : end;
}

/** @param {number} n */
GfxReader.prototype.take = function(n)
{
    const at = this.p;
    if(at + n > this.end) throw new Error("gfxstream: read past the end of the command");
    this.p = at + n;
    return at;
};

GfxReader.prototype.u8 = function() { return this.view.getUint8(this.take(1)); };
GfxReader.prototype.i8 = function() { return this.view.getInt8(this.take(1)); };
GfxReader.prototype.u16 = function() { return this.view.getUint16(this.take(2), true); };
GfxReader.prototype.i16 = function() { return this.view.getInt16(this.take(2), true); };
GfxReader.prototype.u32 = function() { return this.view.getUint32(this.take(4), true); };
GfxReader.prototype.i32 = function() { return this.view.getInt32(this.take(4), true); };
GfxReader.prototype.f32 = function() { return this.view.getFloat32(this.take(4), true); };
GfxReader.prototype.f64 = function() { return this.view.getFloat64(this.take(8), true); };
GfxReader.prototype.u64 = function()
{
    const at = this.take(8);
    return this.view.getUint32(at, true) + this.view.getUint32(at + 4, true) * 0x100000000;
};
GfxReader.prototype.i64 = function()
{
    const at = this.take(8);
    return this.view.getUint32(at, true) + this.view.getInt32(at + 4, true) * 0x100000000;
};
/** a handle (the host's: the device allocates them) */
GfxReader.prototype.h = GfxReader.prototype.u64;
GfxReader.prototype.be32 = function() { return this.view.getUint32(this.take(4), false); };
GfxReader.prototype.be64 = function()
{
    const at = this.take(8);
    return this.view.getUint32(at, false) * 0x100000000 + this.view.getUint32(at + 4, false);
};
/** a pointer's presence (the guest's pointer, big endian): whether it is not null */
GfxReader.prototype.ptr = function()
{
    const at = this.take(8);
    // (tests: where the guest's pointers are)
    if(this.presences) this.presences.push(at);
    return (this.view.getUint32(at, false) | this.view.getUint32(at + 4, false)) !== 0;
};
/** a 32-bit value the guest wrote without moving on (what comes next overwrites it) */
GfxReader.prototype.peek_u32 = function()
{
    return this.p + 4 <= this.end ? this.view.getUint32(this.p, true) : 0;
};
/** @param {number} n */
GfxReader.prototype.count = function(n)
{
    if(!(n >= 0 && n <= MAX_COUNT)) throw new Error("gfxstream: a count of " + n);
    return n;
};
/** n bytes as a string (latin1), up to the first NUL */
GfxReader.prototype.str = function(n)
{
    const at = this.take(this.count(n));
    let s = "";
    for(let i = 0; i < n; i++)
    {
        const c = this.bytes[at + i];
        if(!c) break;
        s += String.fromCharCode(c);
    }
    return s;
};
/** a string: its length (big endian), then its bytes */
GfxReader.prototype.string = function() { return this.str(this.be32()); };
/** strings: their count (big endian), then each */
GfxReader.prototype.strings = function()
{
    const out = new Array(this.count(this.be32()));
    for(let i = 0; i < out.length; i++) out[i] = this.string();
    return out;
};
/**
 * @param {Function} type
 * @param {number} size
 * @param {number} n
 */
GfxReader.prototype.typed = function(type, size, n)
{
    const at = this.take(this.count(n) * size);
    const out = new type(n);
    for(let i = 0; i < n; i++)
    {
        const p = at + i * size;
        out[i] = size === 1 ? this.bytes[p] : size === 2 ? this.view.getUint16(p, true) :
            type === Float32Array ? this.view.getFloat32(p, true) : type === Int32Array ? this.view.getInt32(p, true) : this.view.getUint32(p, true);
    }
    return out;
};
GfxReader.prototype.u8s = function(n) { return this.typed(Uint8Array, 1, n); };
GfxReader.prototype.u16s = function(n) { return this.typed(Uint16Array, 2, n); };
GfxReader.prototype.u32s = function(n) { return this.typed(Uint32Array, 4, n); };
GfxReader.prototype.i32s = function(n) { return this.typed(Int32Array, 4, n); };
GfxReader.prototype.f32s = function(n) { return this.typed(Float32Array, 4, n); };
GfxReader.prototype.u64s = function(n)
{
    const out = new Array(this.count(n));
    for(let i = 0; i < n; i++) out[i] = this.u64();
    return out;
};
GfxReader.prototype.i64s = GfxReader.prototype.u64s;
/** n bytes (a copy) */
GfxReader.prototype.bytes_of = function(n)
{
    const at = this.take(this.count(n));
    return this.bytes.slice(at, at + n);
};

/**
 * Writes a reply
 * @constructor
 * @param {number=} size to start with
 */
export function GfxWriter(size)
{
    this.bytes = new Uint8Array(size || 256);
    this.view = new DataView(this.bytes.buffer);
    this.p = 0;
}

/** @param {number} n */
GfxWriter.prototype.room = function(n)
{
    const at = this.p;
    if(at + n > this.bytes.length)
    {
        const bigger = new Uint8Array(Math.max(this.bytes.length * 2, at + n));
        bigger.set(this.bytes);
        this.bytes = bigger;
        this.view = new DataView(bigger.buffer);
    }
    this.p = at + n;
    return at;
};

/** @return {!Uint8Array} what was written */
GfxWriter.prototype.result = function() { return this.bytes.subarray(0, this.p); };

GfxWriter.prototype.u8 = function(v) { const at = this.room(1); this.view.setUint8(at, v & 0xFF); };
GfxWriter.prototype.i8 = GfxWriter.prototype.u8;
GfxWriter.prototype.u16 = function(v) { const at = this.room(2); this.view.setUint16(at, v & 0xFFFF, true); };
GfxWriter.prototype.i16 = GfxWriter.prototype.u16;
GfxWriter.prototype.u32 = function(v) { const at = this.room(4); this.view.setUint32(at, v >>> 0, true); };
GfxWriter.prototype.i32 = function(v) { const at = this.room(4); this.view.setInt32(at, v | 0, true); };
GfxWriter.prototype.f32 = function(v) { const at = this.room(4); this.view.setFloat32(at, v || 0, true); };
GfxWriter.prototype.f64 = function(v) { const at = this.room(8); this.view.setFloat64(at, v || 0, true); };
GfxWriter.prototype.u64 = function(v)
{
    const at = this.room(8);
    v = v || 0;
    // (~0ULL, VK_WHOLE_SIZE: 2**64 as a number)
    if(v >= 2 ** 64)
    {
        this.view.setUint32(at, 0xFFFFFFFF, true);
        this.view.setUint32(at + 4, 0xFFFFFFFF, true);
        return;
    }
    const high = Math.floor(v / 0x100000000);
    this.view.setUint32(at, v - high * 0x100000000, true);
    this.view.setUint32(at + 4, high, true);
};
GfxWriter.prototype.i64 = function(v)
{
    v = v || 0;
    if(v >= 0) return this.u64(v);
    const at = this.room(8);
    const high = Math.floor(v / 0x100000000);
    this.view.setUint32(at, v - high * 0x100000000, true);
    this.view.setInt32(at + 4, high, true);
};
GfxWriter.prototype.h = GfxWriter.prototype.u64;
GfxWriter.prototype.be32 = function(v) { const at = this.room(4); this.view.setUint32(at, v >>> 0, false); };
GfxWriter.prototype.be64 = function(v)
{
    const at = this.room(8);
    v = v || 0;
    const high = Math.floor(v / 0x100000000);
    this.view.setUint32(at, high, false);
    this.view.setUint32(at + 4, v - high * 0x100000000, false);
};
/** a pointer's presence: what the guest compares with null */
GfxWriter.prototype.ptr = function(present) { this.be64(present ? 1 : 0); };
/** a string (latin1) in n bytes, NUL padded */
GfxWriter.prototype.str = function(s, n)
{
    const at = this.room(n);
    s = s || "";
    for(let i = 0; i < n; i++) this.bytes[at + i] = i < s.length && i < n - 1 ? s.charCodeAt(i) & 0xFF : 0;
};
/** a string's bytes, without its length */
GfxWriter.prototype.chars = function(s, n)
{
    s = s || "";
    const at = this.room(n);
    for(let i = 0; i < n; i++) this.bytes[at + i] = s.charCodeAt(i) & 0xFF;
};
/** a string: its length (big endian), then its bytes */
GfxWriter.prototype.string = function(s)
{
    s = s || "";
    this.be32(s.length);
    this.chars(s, s.length);
};
/** strings: their count (big endian), then each */
GfxWriter.prototype.strings = function(a)
{
    a = a || [];
    this.be32(a.length);
    for(const s of a) this.string(s);
};
GfxWriter.prototype.u8s = function(a, n) { for(let i = 0; i < n; i++) this.u8(a ? a[i] : 0); };
GfxWriter.prototype.u16s = function(a, n) { for(let i = 0; i < n; i++) this.u16(a ? a[i] : 0); };
GfxWriter.prototype.u32s = function(a, n) { for(let i = 0; i < n; i++) this.u32(a ? a[i] : 0); };
GfxWriter.prototype.i32s = function(a, n) { for(let i = 0; i < n; i++) this.i32(a ? a[i] : 0); };
GfxWriter.prototype.f32s = function(a, n) { for(let i = 0; i < n; i++) this.f32(a ? a[i] : 0); };
GfxWriter.prototype.u64s = function(a, n) { for(let i = 0; i < n; i++) this.u64(a ? a[i] : 0); };
GfxWriter.prototype.i64s = GfxWriter.prototype.u64s;
GfxWriter.prototype.bytes_of = function(a, n)
{
    const at = this.room(n);
    if(a) this.bytes.set(a.length > n ? a.subarray(0, n) : a, at);
};
