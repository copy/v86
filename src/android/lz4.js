// LZ4's legacy frame, Android's ramdisks (docs/android-images-plan.md I1)

import { u32, put32, concat } from "./bytes.js";

const LZ4_LEGACY_MAGIC = 0x184C2102;

/**
 * LZ4's legacy frame (Android's ramdisks): its blocks, one after another
 * @param {!Uint8Array} input
 * @return {!Uint8Array}
 */
export function lz4_legacy_decompress(input)
{
    if(u32(input, 0) !== LZ4_LEGACY_MAGIC) throw new Error("not an LZ4 legacy frame");
    const chunks = [];
    for(let at = 4; at + 4 <= input.length;)
    {
        const size = u32(input, at);
        // (another frame's magic: concatenated archives)
        if(size === LZ4_LEGACY_MAGIC) { at += 4; continue; }
        const src = input.subarray(at + 4, at + 4 + size);
        at += 4 + size;
        const out = new Uint8Array(8 << 20);
        let ip = 0, op = 0;
        while(ip < src.length)
        {
            const token = src[ip++];
            let literals = token >> 4;
            if(literals === 15) for(let b = 255; b === 255;) literals += b = src[ip++];
            out.set(src.subarray(ip, ip + literals), op);
            ip += literals; op += literals;
            if(ip >= src.length) break;
            const offset = src[ip] | src[ip + 1] << 8;
            ip += 2;
            let length = token & 15;
            if(length === 15) for(let b = 255; b === 255;) length += b = src[ip++];
            length += 4;
            for(let i = 0; i < length; i++, op++) out[op] = out[op - offset];
        }
        chunks.push(out.subarray(0, op));
    }
    return concat(chunks);
}

/**
 * LZ4's legacy frame with blocks of literals only (no compression), which
 * the kernel's unlz4 takes after another ramdisk's frame
 * @param {!Uint8Array} data
 * @return {!Uint8Array}
 */
export function lz4_legacy_store(data)
{
    const parts = [new Uint8Array([0x02, 0x21, 0x4C, 0x18])];
    for(let at = 0; at < data.length; at += 8 << 20)
    {
        const chunk = data.subarray(at, Math.min(data.length, at + (8 << 20)));
        const length = [];
        for(let rest = chunk.length - 15; rest >= 0; rest -= 255) length.push(Math.min(rest, 255));
        if(chunk.length >= 15 && length[length.length - 1] === 255) length.push(0);
        const block = concat([new Uint8Array([Math.min(chunk.length, 15) << 4, ...length]), chunk]);
        const size = new Uint8Array(4);
        put32(size, 0, block.length);
        parts.push(size, block);
    }
    return concat(parts);
}
