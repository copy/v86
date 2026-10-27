// The kernelcache's compression (docs/iphone4-plan.md S0): a 0x180-byte
// header ("comp", "lzss", Adler-32 and sizes of the plain data, big-endian)
// then LZSS as Okumura's lzss.c and XNU's decompress_lzss: a 4096-byte ring
// (filled with spaces), 18-byte matches at most, flag bytes read low bit
// first (1: a literal; 0: a 12-bit position and a 4-bit length less 3).

import { u32be, latin1 } from "../android/bytes.js";

const N = 4096, F = 18, THRESHOLD = 2;

/**
 * @param {!Uint8Array} src
 * @param {number} limit the output's size at most
 * @return {!Uint8Array}
 */
export function lzss_decompress(src, limit)
{
    const ring = new Uint8Array(N);
    ring.fill(0x20, 0, N - F);
    const out = new Uint8Array(limit);
    let r = N - F, flags = 0, i = 0, o = 0;
    while(o < limit)
    {
        flags >>>= 1;
        if(!(flags & 0x100))
        {
            if(i >= src.length) break;
            flags = src[i++] | 0xFF00;
        }
        if(flags & 1)
        {
            if(i >= src.length) break;
            const c = src[i++];
            out[o++] = c;
            ring[r] = c;
            r = r + 1 & N - 1;
        }
        else
        {
            if(i + 1 >= src.length) break;
            const position = src[i] | (src[i + 1] & 0xF0) << 4, length = (src[i + 1] & 0x0F) + THRESHOLD + 1;
            i += 2;
            for(let k = 0; k < length && o < limit; k++)
            {
                const c = ring[position + k & N - 1];
                out[o++] = c;
                ring[r] = c;
                r = r + 1 & N - 1;
            }
        }
    }
    return out.subarray(0, o);
}

/**
 * Adler-32 (RFC 1950)
 * @param {!Uint8Array} b
 * @return {number}
 */
export function adler32(b)
{
    let a = 1, s = 0;
    for(let at = 0; at < b.length;)
    {
        const end = Math.min(b.length, at + 5552);
        for(; at < end; at++) { a += b[at]; s += a; }
        a %= 65521; s %= 65521;
    }
    return (s << 16 | a) >>> 0;
}

/**
 * A compressed kernelcache's contents: the plain data, its size and
 * Adler-32 checked against the header's
 * @param {!Uint8Array} bytes
 * @return {!Uint8Array}
 */
export function complzss_decompress(bytes)
{
    if(bytes.length < 0x180 || latin1(bytes, 0, 8) !== "complzss") throw new Error("kernelcache: no complzss header");
    const checksum = u32be(bytes, 8), size = u32be(bytes, 12), packed = u32be(bytes, 16);
    if(0x180 + packed > bytes.length) throw new Error(`kernelcache: ${packed} compressed bytes, ${bytes.length - 0x180} there`);
    const out = lzss_decompress(bytes.subarray(0x180, 0x180 + packed), size);
    if(out.length !== size) throw new Error(`kernelcache: ${out.length} bytes decompressed, the header says ${size}`);
    if(adler32(out) !== checksum) throw new Error("kernelcache: the Adler-32 differs");
    return out;
}
