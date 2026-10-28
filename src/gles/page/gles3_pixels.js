// GLES 3.0's pixels on the page (docs/gles3-plan.md L3): an image of client
// memory unpacked by the pixel store's state (GLES 3.0, 3.7.1) and turned
// into the texels of its texture's WebGPU format (gles_formats3.js's
// `webgpu`): the same bytes where the layouts agree, a fourth channel where
// WebGPU has no three-channel format, floats as halves, the packed types
// expanded or packed, the legacy formats as RGBA8 (gles_textures.js).

import { F, pixel_bytes } from "../gles_formats3.js";
import { to_rgba8 } from "./gles_textures.js";

/** The bytes of a texel of the WebGPU formats textures have here */
export const TEXEL_BYTES = {
    "r8unorm": 1, "r8snorm": 1, "r8uint": 1, "r8sint": 1, "stencil8": 1,
    "r16uint": 2, "r16sint": 2, "r16float": 2, "rg8unorm": 2, "rg8snorm": 2, "rg8uint": 2, "rg8sint": 2, "depth16unorm": 2,
    "r32uint": 4, "r32sint": 4, "r32float": 4, "rg16uint": 4, "rg16sint": 4, "rg16float": 4, "rgba8unorm": 4, "rgba8unorm-srgb": 4,
    "rgba8snorm": 4, "rgba8uint": 4, "rgba8sint": 4, "rgb10a2unorm": 4, "rgb10a2uint": 4, "rg11b10ufloat": 4, "rgb9e5ufloat": 4,
    "depth24plus": 4, "depth32float": 4, "depth24plus-stencil8": 4,
    "rg32uint": 8, "rg32sint": 8, "rg32float": 8, "rgba16uint": 8, "rgba16sint": 8, "rgba16float": 8, "depth32float-stencil8": 8,
    "rgba32uint": 16, "rgba32sint": 16, "rgba32float": 16,
};

/** The formats a render pass can draw to (WebGPU's, without optional features) */
export const RENDERABLE = new Set(["r8unorm", "r8uint", "r8sint", "rg8unorm", "rg8uint", "rg8sint", "rgba8unorm", "rgba8unorm-srgb", "rgba8uint",
    "rgba8sint", "r16uint", "r16sint", "r16float", "rg16uint", "rg16sint", "rg16float", "rgba16uint", "rgba16sint", "rgba16float", "r32uint",
    "r32sint", "r32float", "rg32uint", "rg32sint", "rg32float", "rgba32uint", "rgba32sint", "rgba32float", "rgb10a2unorm", "rgb10a2uint",
    "depth16unorm", "depth24plus", "depth32float", "depth24plus-stencil8", "depth32float-stencil8", "stencil8"]);

/** The depth and stencil formats WebGPU copies no buffer into: their images are drawn (gles3_executor.js) */
export const DRAWN_DEPTH = new Set(["depth24plus", "depth32float", "depth24plus-stencil8", "depth32float-stencil8"]);

const PACKED = new Set([F.UNSIGNED_SHORT_4_4_4_4, F.UNSIGNED_SHORT_5_5_5_1, F.UNSIGNED_SHORT_5_6_5, F.UNSIGNED_INT_2_10_10_10_REV,
    F.UNSIGNED_INT_10F_11F_11F_REV, F.UNSIGNED_INT_5_9_9_9_REV, F.UNSIGNED_INT_24_8, F.FLOAT_32_UNSIGNED_INT_24_8_REV]);
/** The packed types whose words are the WebGPU format's texels as they are */
const SAME_PACKING = { [F.UNSIGNED_INT_2_10_10_10_REV]: ["rgb10a2unorm", "rgb10a2uint"], [F.UNSIGNED_INT_10F_11F_11F_REV]: ["rg11b10ufloat"],
    [F.UNSIGNED_INT_5_9_9_9_REV]: ["rgb9e5ufloat"] };

/**
 * An image of client memory as tight rows: rows of row_length (or width)
 * pixels aligned, image_height (or height) rows an image (3D images), after
 * the skips; what lies past the data reads as zeros
 * @param {!Uint8Array} data from the client's pointer
 * @param {{alignment: number, row_length: number, image_height: number, skip_pixels: number, skip_rows: number, skip_images: number}} store
 * @param {boolean} three a three-dimensional image's (IMAGE_HEIGHT and SKIP_IMAGES apply)
 * @return {!Uint8Array}
 */
export function unpack_image(data, width, height, depth, format, type, store, three)
{
    const pixel = pixel_bytes(format, type);
    const tight = width * pixel;
    const row = Math.ceil((store.row_length > 0 ? store.row_length : width) * pixel / store.alignment) * store.alignment;
    const image = row * (three && store.image_height > 0 ? store.image_height : height);
    const start = (three ? store.skip_images * image : 0) + store.skip_rows * row + store.skip_pixels * pixel;
    if(start === 0 && row === tight && image === tight * height && data.length >= tight * height * depth)
    {
        return data.subarray(0, tight * height * depth);
    }
    const out = new Uint8Array(tight * height * depth);
    for(let z = 0; z < depth; z++)
    {
        for(let y = 0; y < height; y++)
        {
            const from = start + z * image + y * row;
            if(from >= data.length) return out;
            out.set(data.subarray(from, Math.min(data.length, from + tight)), (z * height + y) * tight);
        }
    }
    return out;
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

/** @param {number} value @return {number} the IEEE half nearest it */
export function to_half(value)
{
    f32[0] = value;
    const x = u32[0];
    const sign = x >>> 16 & 0x8000;
    const exponent = x >>> 23 & 0xFF, mantissa = x & 0x7FFFFF;
    if(exponent === 0xFF) return sign | 0x7C00 | (mantissa ? 0x200 : 0);
    const e = exponent - 127 + 15;
    if(e >= 31) return sign | 0x7C00;
    if(e <= 0)
    {
        if(e < -10) return sign;
        const m = (mantissa | 0x800000) >> (1 - e);
        return sign | (m + 0x1000 >> 13);
    }
    const half = sign | e << 10 | mantissa >> 13;
    // (round to nearest: a carry into the exponent is right)
    return half + (mantissa >> 12 & 1);
}

/** @param {number} h @return {number} */
export function from_half(h)
{
    const s = h & 0x8000 ? -1 : 1, e = h >> 10 & 31, m = h & 1023;
    if(e === 0) return s * m * 2 ** -24;
    if(e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** An unsigned float of `bits` mantissa bits and 5 exponent bits (R11F_G11F_B10F's) */
function to_ufloat(value, mantissa_bits)
{
    if(!(value > 0)) return 0;
    const max_exponent = 30;
    if(value >= 2 ** 15 * (2 - 2 ** -mantissa_bits)) return max_exponent << mantissa_bits | (1 << mantissa_bits) - 1;
    let e = Math.floor(Math.log2(value));
    if(e < -14) return Math.round(value / 2 ** -14 * (1 << mantissa_bits)) & (1 << mantissa_bits) - 1;
    let m = Math.round((value / 2 ** e - 1) * (1 << mantissa_bits));
    if(m === 1 << mantissa_bits) { m = 0; e++; }
    return e + 15 << mantissa_bits | m;
}

/** RGB as RGB9_E5's shared exponent (GLES 3.0, 3.8.3.2) */
function to_rgb9e5(r, g, b)
{
    const max = 65408;
    const clamp = v => Math.min(max, Math.max(0, v || 0));
    r = clamp(r); g = clamp(g); b = clamp(b);
    const largest = Math.max(r, g, b);
    let e = Math.max(-16, Math.floor(Math.log2(largest || 2 ** -16))) + 1 + 15;
    let scale = 2 ** (e - 15 - 9);
    if(Math.round(largest / scale) === 512) { e++; scale *= 2; }
    return (Math.round(b / scale) << 18 | Math.round(g / scale) << 9 | Math.round(r / scale) | e << 27) >>> 0;
}

/**
 * Tight pixels of the format and type as the texels of the image's WebGPU
 * format
 * @param {!Uint8Array} tight unpack_image's
 * @param {number} count the pixels
 * @param {!Object} info the image's format (format_info's)
 * @return {?Uint8Array} null for a depth or stencil format drawn (DRAWN_DEPTH)
 */
export function to_texels(tight, count, format, type, info)
{
    const target = info.webgpu;
    if(!info.sized) return to_rgba8(format, type, count, 1, 1, tight);
    if(DRAWN_DEPTH.has(target)) return null;
    const texel = TEXEL_BYTES[target];
    const pixel = pixel_bytes(format, type);
    if(PACKED.has(type) ? (SAME_PACKING[type] || []).includes(target) : pixel === texel) return tight;
    const view = new DataView(tight.buffer, tight.byteOffset, tight.byteLength);
    const out = new Uint8Array(count * texel);
    const o = new DataView(out.buffer);
    const channels = { [F.RED]: 1, [F.RED_INTEGER]: 1, [F.RG]: 2, [F.RG_INTEGER]: 2, [F.RGB]: 3, [F.RGB_INTEGER]: 3, [F.RGBA]: 4,
        [F.RGBA_INTEGER]: 4, [F.DEPTH_COMPONENT]: 1 }[format] || 4;
    const out_channels = target.startsWith("rgba") ? 4 : target.startsWith("rg") && !target.startsWith("rgb") ? 2 : target.startsWith("r") ? 1 : 4;
    switch(type)
    {
        case F.UNSIGNED_SHORT_5_6_5: case F.UNSIGNED_SHORT_4_4_4_4: case F.UNSIGNED_SHORT_5_5_5_1: case F.UNSIGNED_INT_2_10_10_10_REV:
        {
            // (into RGBA8: RGB565, RGBA4, RGB5_A1)
            const rgba = type === F.UNSIGNED_INT_2_10_10_10_REV ? null : to_rgba8(F.RGBA, type, count, 1, 1, tight);
            if(rgba) return rgba;
            for(let i = 0; i < count; i++)
            {
                const v = view.getUint32(4 * i, true);
                out.set([Math.round((v & 1023) * 255 / 1023), Math.round((v >> 10 & 1023) * 255 / 1023), Math.round((v >> 20 & 1023) * 255 / 1023),
                    (v >>> 30) * 85], 4 * i);
            }
            return out;
        }
    }
    if(format === F.DEPTH_COMPONENT && target === "depth16unorm")
    {
        // (UNSIGNED_INT's high half)
        for(let i = 0; i < count; i++) o.setUint16(2 * i, view.getUint32(4 * i, true) >>> 16, true);
        return out;
    }
    if(target === "rg11b10ufloat" || target === "rgb9e5ufloat")
    {
        const read = type === F.FLOAT ? (i, k) => view.getFloat32(12 * i + 4 * k, true) : (i, k) => from_half(view.getUint16(6 * i + 2 * k, true));
        for(let i = 0; i < count; i++)
        {
            const [r, g, b] = [read(i, 0), read(i, 1), read(i, 2)];
            o.setUint32(4 * i, target === "rgb9e5ufloat" ? to_rgb9e5(r, g, b) : (to_ufloat(r, 6) | to_ufloat(g, 6) << 11 | to_ufloat(b, 5) << 22) >>> 0, true);
        }
        return out;
    }
    // floats as halves; a missing alpha one (by the component's kind)
    const half = target.includes("16float");
    const size = type === F.FLOAT ? 4 : type === F.HALF_FLOAT || type === F.HALF_FLOAT_OES || type === F.SHORT || type === F.UNSIGNED_SHORT ? 2 :
        type === F.INT || type === F.UNSIGNED_INT ? 4 : 1;
    const out_size = texel / out_channels;
    const one = info.kind === "float" ? (half ? [0x00, 0x3C] : [0, 0, 0x80, 0x3F]) : info.kind === "unorm" ? [255] : info.kind === "snorm" ? [127] :
        [1, 0, 0, 0].slice(0, out_size);
    for(let i = 0; i < count; i++)
    {
        for(let k = 0; k < out_channels; k++)
        {
            const at = (i * out_channels + k) * out_size;
            if(k >= channels)
            {
                if(k === 3) out.set(one, at);
                continue;
            }
            const from = (i * channels + k) * size;
            if(half && size === 4) o.setUint16(at, to_half(view.getFloat32(from, true)), true);
            else out.set(tight.subarray(from, from + out_size), at);
        }
    }
    return out;
}

/**
 * Depth (and stencil) values of a depth format's pixels, for an image that is
 * drawn: depths from 0 to 1, stencils as bytes
 * @return {{depth: !Float32Array, stencil: ?Uint8Array}}
 */
export function depth_values(tight, count, format, type)
{
    const view = new DataView(tight.buffer, tight.byteOffset, tight.byteLength);
    const depth = new Float32Array(count);
    const stencil = format === F.DEPTH_STENCIL ? new Uint8Array(count) : null;
    for(let i = 0; i < count; i++)
    {
        switch(type)
        {
            case F.UNSIGNED_SHORT: depth[i] = view.getUint16(2 * i, true) / 65535; break;
            case F.UNSIGNED_INT: depth[i] = view.getUint32(4 * i, true) / 4294967295; break;
            case F.FLOAT: depth[i] = Math.min(1, Math.max(0, view.getFloat32(4 * i, true))); break;
            case F.UNSIGNED_INT_24_8:
            {
                const v = view.getUint32(4 * i, true);
                depth[i] = (v >>> 8) / 0xFFFFFF;
                stencil[i] = v & 0xFF;
                break;
            }
            case F.FLOAT_32_UNSIGNED_INT_24_8_REV:
                depth[i] = Math.min(1, Math.max(0, view.getFloat32(8 * i, true)));
                stencil[i] = view.getUint32(8 * i + 4, true) & 0xFF;
                break;
        }
    }
    return { depth, stencil };
}
