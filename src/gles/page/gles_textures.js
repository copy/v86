// The GLES executor's texels (docs/gles-proxy-plan.md "执行器", E3): every
// color image is held as RGBA8 (WebGPU has no packed or luminance formats),
// so what the guest sends is expanded here: RGBA, RGB, LUMINANCE_ALPHA,
// LUMINANCE, ALPHA and BGRA_EXT bytes, the 4444, 5551 and 565 packings, and
// ETC1 blocks (OES_compressed_ETC1_RGB8_texture), decoded. Rows come padded
// to the unpack alignment; they leave tightly packed.

import { GL } from "../gles_formats.js";

/** @return {number} the bytes of one texel the guest sends */
function source_bytes(format, type)
{
    if(type !== GL.UNSIGNED_BYTE) return 2;
    switch(format)
    {
        case GL.RGBA: case GL.BGRA_EXT: return 4;
        case GL.RGB: return 3;
        case GL.LUMINANCE_ALPHA: return 2;
    }
    return 1;
}

/**
 * The guest's texels as RGBA8, rows tight
 * @param {number} format
 * @param {number} type
 * @param {number} width
 * @param {number} height
 * @param {number} alignment the unpack alignment
 * @param {?Uint8Array} bytes null: a defined image with no data (zeros)
 * @return {!Uint8Array}
 */
export function to_rgba8(format, type, width, height, alignment, bytes)
{
    const out = new Uint8Array(width * height * 4);
    if(!bytes) return out;
    const texel = source_bytes(format, type);
    const stride = Math.ceil(width * texel / alignment) * alignment;
    if(format === GL.RGBA && type === GL.UNSIGNED_BYTE && stride === width * 4)
    {
        out.set(bytes.subarray(0, Math.min(bytes.length, out.length)));
        return out;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for(let y = 0; y < height; y++)
    {
        let src = y * stride, dst = y * width * 4;
        if(src + width * texel > bytes.length) break;
        for(let x = 0; x < width; x++, src += texel, dst += 4)
        {
            let r, g, b, a;
            if(type === GL.UNSIGNED_SHORT_4_4_4_4)
            {
                const p = view.getUint16(src, true);
                r = (p >> 12) * 17; g = (p >> 8 & 15) * 17; b = (p >> 4 & 15) * 17; a = (p & 15) * 17;
            }
            else if(type === GL.UNSIGNED_SHORT_5_5_5_1)
            {
                const p = view.getUint16(src, true);
                r = (p >> 11) * 255 / 31 + 0.5 | 0; g = (p >> 6 & 31) * 255 / 31 + 0.5 | 0; b = (p >> 1 & 31) * 255 / 31 + 0.5 | 0;
                a = p & 1 ? 255 : 0;
            }
            else if(type === GL.UNSIGNED_SHORT_5_6_5)
            {
                const p = view.getUint16(src, true);
                r = (p >> 11) * 255 / 31 + 0.5 | 0; g = (p >> 5 & 63) * 255 / 63 + 0.5 | 0; b = (p & 31) * 255 / 31 + 0.5 | 0; a = 255;
            }
            else switch(format)
            {
                case GL.RGBA: r = bytes[src]; g = bytes[src + 1]; b = bytes[src + 2]; a = bytes[src + 3]; break;
                case GL.BGRA_EXT: b = bytes[src]; g = bytes[src + 1]; r = bytes[src + 2]; a = bytes[src + 3]; break;
                case GL.RGB: r = bytes[src]; g = bytes[src + 1]; b = bytes[src + 2]; a = 255; break;
                case GL.LUMINANCE_ALPHA: r = g = b = bytes[src]; a = bytes[src + 1]; break;
                case GL.LUMINANCE: r = g = b = bytes[src]; a = 255; break;
                case GL.ALPHA: r = g = b = 0; a = bytes[src]; break;
                default: r = g = b = 0; a = 255;
            }
            out[dst] = r; out[dst + 1] = g; out[dst + 2] = b; out[dst + 3] = a;
        }
    }
    return out;
}

/** ETC1's modifier tables (the "intensity modifier" sets, OES_compressed_ETC1_RGB8_texture) */
const ETC1_MODIFIERS = [[2, 8], [5, 17], [9, 29], [13, 42], [18, 60], [24, 80], [33, 106], [47, 183]];

/**
 * ETC1 blocks as RGBA8 (alpha 255), rows tight
 * @param {number} width
 * @param {number} height
 * @param {!Uint8Array} bytes 8 per 4 by 4 block, row by row of blocks
 * @return {!Uint8Array}
 */
export function decode_etc1(width, height, bytes)
{
    const out = new Uint8Array(width * height * 4);
    const blocks_x = Math.ceil(width / 4), blocks_y = Math.ceil(height / 4);
    const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
    for(let by = 0; by < blocks_y; by++)
    {
        for(let bx = 0; bx < blocks_x; bx++)
        {
            const at = (by * blocks_x + bx) * 8;
            if(at + 8 > bytes.length) return out;
            const hi = (bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0;
            const lo = (bytes[at + 4] << 24 | bytes[at + 5] << 16 | bytes[at + 6] << 8 | bytes[at + 7]) >>> 0;
            const diff = hi >>> 1 & 1, flip = hi & 1;
            const table = [hi >>> 5 & 7, hi >>> 2 & 7];
            let base;
            if(diff)
            {
                // (5-bit colors, the second a 3-bit signed difference from the first)
                const five = shift => hi >>> shift & 31;
                const delta = shift => { const d = hi >>> shift & 7; return d >= 4 ? d - 8 : d; };
                const expand5 = v => v << 3 | v >> 2;
                const c1 = [five(27), five(19), five(11)];
                const c2 = [c1[0] + delta(24), c1[1] + delta(16), c1[2] + delta(8)];
                base = [c1.map(expand5), c2.map(v => expand5(v & 31))];
            }
            else
            {
                const four = shift => (hi >>> shift & 15) * 17;
                base = [[four(28), four(20), four(12)], [four(24), four(16), four(8)]];
            }
            for(let i = 0; i < 16; i++)
            {
                // (pixel indices run down the columns)
                const x = i >> 2, y = i & 3;
                const sub = flip ? (y >= 2 ? 1 : 0) : (x >= 2 ? 1 : 0);
                const msb = lo >>> (i + 16) & 1, lsb = lo >>> i & 1;
                const modifier = ETC1_MODIFIERS[table[sub]][lsb];
                const delta = msb ? -modifier : modifier;
                const px = bx * 4 + x, py = by * 4 + y;
                if(px >= width || py >= height) continue;
                const o = (py * width + px) * 4;
                out[o] = clamp(base[sub][0] + delta);
                out[o + 1] = clamp(base[sub][1] + delta);
                out[o + 2] = clamp(base[sub][2] + delta);
                out[o + 3] = 255;
            }
        }
    }
    return out;
}

/**
 * RGBA8 pixels as the guest reads them in a format and type: GLES 2.0 reads
 * RGBA and UNSIGNED_BYTE only (the implementation's format is the same),
 * rows padded to the pack alignment
 * @param {!Uint8Array} rgba tight rows
 * @param {number} width
 * @param {number} height
 * @param {number} alignment
 * @return {!Uint8Array}
 */
export function pack_rgba8(rgba, width, height, alignment)
{
    const row = width * 4, stride = Math.ceil(row / alignment) * alignment;
    if(stride === row) return rgba;
    const out = new Uint8Array(stride * (height - 1) + row);
    for(let y = 0; y < height; y++) out.set(rgba.subarray(y * row, y * row + row), y * stride);
    return out;
}
