// (tools/venus_protocol_runtime.js, copied into venus_protocol.js)
//
// Venus's encoding: little endian, everything a multiple of 4 bytes; 64-bit
// values (sizes, handles, VkDeviceSize, 64-bit flags) are numbers here, exact
// below 2**53, except a ring's id (ring_id); arrays, strings and pointers
// start with a 64-bit count (1 or 0 for a pointer to one value).

const MAX_COUNT = 1 << 24;

/**
 * Reads a command stream
 * @constructor
 * @param {!Uint8Array} bytes
 * @param {number=} start
 * @param {number=} end
 */
export function VenusReader(bytes, start, end)
{
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = start || 0;
    this.end = end === undefined ? bytes.length : end;
}

/** @param {number} n */
VenusReader.prototype.take = function(n)
{
    const at = this.p;
    if(at + n > this.end) throw new Error("venus: read past the end of the stream");
    this.p = at + n;
    return at;
};

VenusReader.prototype.u32 = function() { return this.view.getUint32(this.take(4), true); };
VenusReader.prototype.i32 = function() { return this.view.getInt32(this.take(4), true); };
VenusReader.prototype.u8 = function() { return this.view.getUint8(this.take(4)); };
VenusReader.prototype.u16 = function() { return this.view.getUint16(this.take(4), true); };
VenusReader.prototype.i16 = function() { return this.view.getInt16(this.take(4), true); };
VenusReader.prototype.f32 = function() { return this.view.getFloat32(this.take(4), true); };
VenusReader.prototype.f64 = function() { return this.view.getFloat64(this.take(8), true); };
VenusReader.prototype.u64 = function()
{
    const at = this.take(8);
    return this.view.getUint32(at, true) + this.view.getUint32(at + 4, true) * 0x100000000;
};
VenusReader.prototype.i64 = function()
{
    const at = this.take(8);
    return this.view.getUint32(at, true) + this.view.getInt32(at + 4, true) * 0x100000000;
};
/** a handle: the object id the driver gave it */
VenusReader.prototype.h = VenusReader.prototype.u64;
/**
 * A ring's id (the `ring` of the transport commands): the driver's pointer
 * to its ring, which a number would round to a multiple of 2048 (Android's
 * heap pointers have a tag in their top byte), so that the rings of two
 * threads could have the same id: 16 hex digits
 * @return {string}
 */
VenusReader.prototype.ring_id = function()
{
    const at = this.take(8);
    return this.view.getUint32(at + 4, true).toString(16).padStart(8, "0") + this.view.getUint32(at, true).toString(16).padStart(8, "0");
};

/** an array's size */
VenusReader.prototype.size = function()
{
    const n = this.u64();
    if(n > MAX_COUNT) throw new Error("venus: array of " + n);
    return n;
};

/** @param {number} n bytes */
VenusReader.prototype.blob = function(n)
{
    const at = this.take(n + 3 & ~3);
    return this.bytes.slice(at, at + n);
};

/** @param {number} n bytes, with the terminating NUL */
VenusReader.prototype.str = function(n)
{
    const at = this.take(n + 3 & ~3);
    let s = "";
    for(let i = at; i < at + n && this.bytes[i]; i++) s += String.fromCharCode(this.bytes[i]);
    return s;
};

/**
 * @param {Function} type
 * @param {number} size of an element
 * @param {number} n
 */
VenusReader.prototype.typed = function(type, size, n)
{
    const at = this.take(n * size + 3 & ~3);
    const out = new type(n);
    new Uint8Array(out.buffer).set(this.bytes.subarray(at, at + n * size));
    return out;
};
VenusReader.prototype.u32s = function(n) { return this.typed(Uint32Array, 4, n); };
VenusReader.prototype.i32s = function(n) { return this.typed(Int32Array, 4, n); };
VenusReader.prototype.f32s = function(n) { return this.typed(Float32Array, 4, n); };
VenusReader.prototype.u8s = function(n) { return this.typed(Uint8Array, 1, n); };
VenusReader.prototype.u64s = function(n)
{
    const out = new Array(n);
    for(let i = 0; i < n; i++) out[i] = this.u64();
    return out;
};

/**
 * A pNext chain, as objects linked by pNext
 * @param {!Object<number, function(!VenusReader, !Object)>} table
 * @return {Object}
 */
VenusReader.prototype.pnext = function(table)
{
    if(!this.u64()) return null;
    const stype = this.u32();
    const next = this.pnext(table);
    const self = table[stype];
    if(!self) throw new Error("venus: struct " + stype + " in a chain");
    const o = { sType: stype, pNext: next };
    self(this, o);
    return o;
};

/**
 * Writes a reply
 * @constructor
 * @param {number=} size to start with
 */
export function VenusWriter(size)
{
    this.bytes = new Uint8Array(size || 256);
    this.view = new DataView(this.bytes.buffer);
    this.p = 0;
}

/** @param {number} n */
VenusWriter.prototype.room = function(n)
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
VenusWriter.prototype.result = function() { return this.bytes.subarray(0, this.p); };

VenusWriter.prototype.u32 = function(v) { const at = this.room(4); this.view.setUint32(at, v >>> 0, true); };
VenusWriter.prototype.i32 = function(v) { const at = this.room(4); this.view.setInt32(at, v | 0, true); };
VenusWriter.prototype.u8 = function(v) { const at = this.room(4); this.view.setUint32(at, v & 0xFF, true); };
VenusWriter.prototype.u16 = function(v) { const at = this.room(4); this.view.setUint32(at, v & 0xFFFF, true); };
VenusWriter.prototype.i16 = function(v) { const at = this.room(4); this.view.setInt32(at, v << 16 >> 16, true); };
VenusWriter.prototype.f32 = function(v) { const at = this.room(4); this.view.setFloat32(at, v || 0, true); };
VenusWriter.prototype.f64 = function(v) { const at = this.room(8); this.view.setFloat64(at, v || 0, true); };
VenusWriter.prototype.u64 = function(v)
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
VenusWriter.prototype.i64 = function(v)
{
    v = v || 0;
    if(v >= 0) return this.u64(v);
    const at = this.room(8);
    const high = Math.floor(v / 0x100000000);
    this.view.setUint32(at, v - high * 0x100000000, true);
    this.view.setInt32(at + 4, high, true);
};
VenusWriter.prototype.h = VenusWriter.prototype.u64;
VenusWriter.prototype.size = VenusWriter.prototype.u64;
/** @param {(string|number)} v a ring's id: VenusReader.ring_id's 16 hex digits, or a number below 2**53 */
VenusWriter.prototype.ring_id = function(v)
{
    if(typeof v !== "string") return this.u64(v);
    const at = this.room(8);
    this.view.setUint32(at, parseInt(v.slice(-8), 16) >>> 0, true);
    this.view.setUint32(at + 4, parseInt(v.slice(0, -8) || "0", 16) >>> 0, true);
};

/**
 * @param {Uint8Array|undefined} data
 * @param {number} n bytes
 */
VenusWriter.prototype.blob = function(data, n)
{
    const at = this.room(n + 3 & ~3);
    this.bytes.fill(0, at, at + (n + 3 & ~3));
    if(data) this.bytes.set(data.length > n ? data.subarray(0, n) : data, at);
};

/**
 * A string in n bytes (a fixed array: the rest zeros)
 * @param {string|undefined} s
 * @param {number} n
 */
VenusWriter.prototype.str = function(s, n)
{
    const at = this.room(n + 3 & ~3);
    this.bytes.fill(0, at, at + (n + 3 & ~3));
    s = s || "";
    for(let i = 0; i < s.length && i < n - 1; i++) this.bytes[at + i] = s.charCodeAt(i);
};

VenusWriter.prototype.u32s = function(a, n) { for(let i = 0; i < n; i++) this.u32(a ? a[i] : 0); };
VenusWriter.prototype.i32s = function(a, n) { for(let i = 0; i < n; i++) this.i32(a ? a[i] : 0); };
VenusWriter.prototype.f32s = function(a, n) { for(let i = 0; i < n; i++) this.f32(a ? a[i] : 0); };
VenusWriter.prototype.u64s = function(a, n) { for(let i = 0; i < n; i++) this.u64(a ? a[i] : 0); };
VenusWriter.prototype.u8s = function(a, n) { this.blob(a, n); };

/**
 * A pNext chain: the structs the request's chain had, in its order (the
 * driver looks for each further along its own chain); those this cannot
 * write are left out
 * @param {Object} o
 * @param {!Object<number, function(!VenusWriter, !Object)>} table
 */
VenusWriter.prototype.pnext = function(o, table)
{
    while(o && !table[o.sType]) o = o.pNext;
    if(!o) return this.u64(0);
    this.u64(1);
    this.u32(o.sType);
    this.pnext(o.pNext, table);
    table[o.sType](this, o);
};

/** the next array size, not taken */
VenusReader.prototype.peek_size = function()
{
    const p = this.p;
    const n = this.u64();
    this.p = p;
    return n;
};
