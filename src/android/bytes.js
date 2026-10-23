// The Android image library's byte helpers (docs/android-images-plan.md
// I1): fields, text, checksums and hashes over Uint8Array, so that the same
// code runs in node (tools/a64_android.mjs) and in browsers. Offsets and
// 64-bit fields are numbers (images stay far below 2^53 bytes).

import { SHA256 } from "../image/sha256.js";

/** @param {!Uint8Array} b @param {number} at @return {number} */
export function u16(b, at) { return b[at] | b[at + 1] << 8; }
/** @param {!Uint8Array} b @param {number} at @return {number} */
export function u32(b, at) { return (b[at] | b[at + 1] << 8 | b[at + 2] << 16 | b[at + 3] << 24) >>> 0; }
/** @param {!Uint8Array} b @param {number} at @return {number} */
export function u64(b, at) { return u32(b, at) + u32(b, at + 4) * 0x100000000; }
/** @param {!Uint8Array} b @param {number} at @return {number} */
export function u32be(b, at) { return (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]) >>> 0; }
/** @param {!Uint8Array} b @param {number} at @return {number} */
export function u64be(b, at) { return u32be(b, at) * 0x100000000 + u32be(b, at + 4); }

/** @param {!Uint8Array} b @param {number} at @param {number} v */
export function put16(b, at, v) { b[at] = v; b[at + 1] = v >>> 8; }
/** @param {!Uint8Array} b @param {number} at @param {number} v */
export function put32(b, at, v) { b[at] = v; b[at + 1] = v >>> 8; b[at + 2] = v >>> 16; b[at + 3] = v >>> 24; }
/** @param {!Uint8Array} b @param {number} at @param {number} v */
export function put64(b, at, v) { put32(b, at, v >>> 0); put32(b, at + 4, Math.floor(v / 0x100000000)); }
/** @param {!Uint8Array} b @param {number} at @param {number} v */
export function put32be(b, at, v) { b[at] = v >>> 24; b[at + 1] = v >>> 16; b[at + 2] = v >>> 8; b[at + 3] = v; }
/** @param {!Uint8Array} b @param {number} at @param {number} v */
export function put64be(b, at, v) { put32be(b, at, Math.floor(v / 0x100000000)); put32be(b, at + 4, v >>> 0); }

/**
 * Bytes as latin1 text (one character per byte)
 * @param {!Uint8Array} b
 * @param {number=} start
 * @param {number=} end
 * @return {string}
 */
export function latin1(b, start = 0, end = b.length)
{
    let text = "";
    for(let at = start; at < end; at += 0x8000)
    {
        text += String.fromCharCode.apply(null, Array.from(b.subarray(at, Math.min(end, at + 0x8000))));
    }
    return text;
}

/**
 * latin1 text as bytes (each character's low byte)
 * @param {string} text
 * @return {!Uint8Array}
 */
export function bytes_of(text)
{
    const out = new Uint8Array(text.length);
    for(let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
}

/**
 * UTF-8 text as bytes
 * @param {string} text
 * @return {!Uint8Array}
 */
export function utf8(text) { return new TextEncoder().encode(text); }

/**
 * UTF-16LE text as bytes (GPT's names)
 * @param {string} text
 * @return {!Uint8Array}
 */
export function utf16le(text)
{
    const out = new Uint8Array(text.length * 2);
    for(let i = 0; i < text.length; i++) put16(out, 2 * i, text.charCodeAt(i));
    return out;
}

/**
 * A NUL-terminated string of at most length bytes at offset
 * @param {!Uint8Array} b
 * @param {number} at
 * @param {number} length
 * @return {string}
 */
export function c_string(b, at, length)
{
    const field = b.subarray(at, at + length);
    const end = field.indexOf(0);
    return latin1(field, 0, end < 0 ? field.length : end);
}

/**
 * A copy of bytes of its own (b.slice() is a view when b is node's Buffer)
 * @param {!Uint8Array} b
 * @param {number=} start
 * @param {number=} end
 * @return {!Uint8Array}
 */
export function copy(b, start = 0, end = b.length)
{
    return new Uint8Array(b.subarray(start, end));
}

/**
 * @param {!Array<!Uint8Array>} parts
 * @return {!Uint8Array}
 */
export function concat(parts)
{
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for(const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

/** @param {!Uint8Array} a @param {!Uint8Array} b @return {boolean} */
export function equals(a, b)
{
    if(a.length !== b.length) return false;
    for(let i = 0; i < a.length; i++) if(a[i] !== b[i]) return false;
    return true;
}

/**
 * Byte order, as Buffer.compare
 * @param {!Uint8Array} a
 * @param {!Uint8Array} b
 * @return {number}
 */
export function compare(a, b)
{
    const n = Math.min(a.length, b.length);
    for(let i = 0; i < n; i++) if(a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Where needle starts in hay, or -1
 * @param {!Uint8Array} hay
 * @param {!Uint8Array} needle
 * @param {number=} from
 * @return {number}
 */
export function index_of(hay, needle, from = 0)
{
    if(!needle.length) return from;
    for(let i = hay.indexOf(needle[0], from); i >= 0 && i + needle.length <= hay.length; i = hay.indexOf(needle[0], i + 1))
    {
        let j = 1;
        while(j < needle.length && hay[i + j] === needle[j]) j++;
        if(j === needle.length) return i;
    }
    return -1;
}

/** @param {!Uint8Array} b @return {string} */
export function hex(b) { return Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); }

/**
 * @param {...!Uint8Array} parts
 * @return {!Uint8Array}
 */
export function sha256(...parts)
{
    const hash = new SHA256();
    for(const part of parts) hash.update(part);
    return hash.digest();
}

/**
 * @param {...!Uint8Array} parts
 * @return {string}
 */
export function sha256_hex(...parts)
{
    const hash = new SHA256();
    for(const part of parts) hash.update(part);
    return hash.hex();
}

const CRC32 = new Int32Array(256);
const CRC32C = new Int32Array(256);
for(let n = 0; n < 256; n++)
{
    let c = n, k = n;
    for(let i = 0; i < 8; i++)
    {
        c = c & 1 ? 0xEDB88320 ^ c >>> 1 : c >>> 1;
        k = k & 1 ? 0x82F63B78 ^ k >>> 1 : k >>> 1;
    }
    CRC32[n] = c;
    CRC32C[n] = k;
}

/**
 * CRC-32 (zlib's)
 * @param {!Uint8Array} bytes
 * @param {number=} crc a running value
 * @return {number}
 */
export function crc32(bytes, crc = 0)
{
    let c = ~crc;
    for(let i = 0; i < bytes.length; i++) c = CRC32[(c ^ bytes[i]) & 0xFF] ^ c >>> 8;
    return ~c >>> 0;
}

/**
 * CRC-32C over bytes from crc as is (erofs's: initial 0xFFFFFFFF, no final
 * inversion)
 * @param {number} crc
 * @param {!Uint8Array} bytes
 * @return {number}
 */
export function crc32c(crc, bytes)
{
    let c = crc;
    for(let i = 0; i < bytes.length; i++) c = CRC32C[(c ^ bytes[i]) & 0xFF] ^ c >>> 8;
    return c >>> 0;
}
