// GLES 3.0's texture and renderbuffer formats (docs/gles3-plan.md,
// "纹理、采样器与格式"): the sized internal formats of the GLES 3.0
// specification's tables 3.2, 3.13 and 3.14 with the format and types each
// takes, whether a framebuffer can render to it and a sampler filter it,
// its channels' bits, its components' type and its WebGPU format (the
// page's: L3). The shadow state (gles3_state.js) checks the guest's calls
// with it, the page's executor stores textures by it.

export const F = {
    // formats
    RED: 0x1903, RG: 0x8227, RGB: 0x1907, RGBA: 0x1908, RED_INTEGER: 0x8D94, RG_INTEGER: 0x8228, RGB_INTEGER: 0x8D98,
    RGBA_INTEGER: 0x8D99, DEPTH_COMPONENT: 0x1902, DEPTH_STENCIL: 0x84F9, LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190A, ALPHA: 0x1906,
    BGRA_EXT: 0x80E1, STENCIL_INDEX: 0x1901,
    // types
    BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406,
    HALF_FLOAT: 0x140B, HALF_FLOAT_OES: 0x8D61, UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034,
    UNSIGNED_SHORT_5_6_5: 0x8363, UNSIGNED_INT_2_10_10_10_REV: 0x8368, UNSIGNED_INT_10F_11F_11F_REV: 0x8C3B,
    UNSIGNED_INT_5_9_9_9_REV: 0x8C3E, UNSIGNED_INT_24_8: 0x84FA, FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8DAD,
    // component types (GL_FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE)
    UNSIGNED_NORMALIZED: 0x8C17, SIGNED_NORMALIZED: 0x8F9C,
    LINEAR: 0x2601, SRGB: 0x8C40,
};

/**
 * The sized internal formats: [name, value, format, types, color-renderable,
 * texture-filterable, bits (r, g, b, a, depth, stencil), component kind,
 * WebGPU format (the page's; "rgba" variants where WebGPU has no 3- or
 * 1-channel one of the kind it needs)]
 */
const SIZED = [
    ["R8", 0x8229, F.RED, [F.UNSIGNED_BYTE], true, true, [8, 0, 0, 0, 0, 0], "unorm", "r8unorm"],
    ["R8_SNORM", 0x8F94, F.RED, [F.BYTE], false, true, [8, 0, 0, 0, 0, 0], "snorm", "r8snorm"],
    ["R16F", 0x822D, F.RED, [F.HALF_FLOAT, F.FLOAT], false, true, [16, 0, 0, 0, 0, 0], "float", "r16float"],
    ["R32F", 0x822E, F.RED, [F.FLOAT], false, false, [32, 0, 0, 0, 0, 0], "float", "r32float"],
    ["R8UI", 0x8232, F.RED_INTEGER, [F.UNSIGNED_BYTE], true, false, [8, 0, 0, 0, 0, 0], "uint", "r8uint"],
    ["R8I", 0x8231, F.RED_INTEGER, [F.BYTE], true, false, [8, 0, 0, 0, 0, 0], "int", "r8sint"],
    ["R16UI", 0x8234, F.RED_INTEGER, [F.UNSIGNED_SHORT], true, false, [16, 0, 0, 0, 0, 0], "uint", "r16uint"],
    ["R16I", 0x8233, F.RED_INTEGER, [F.SHORT], true, false, [16, 0, 0, 0, 0, 0], "int", "r16sint"],
    ["R32UI", 0x8236, F.RED_INTEGER, [F.UNSIGNED_INT], true, false, [32, 0, 0, 0, 0, 0], "uint", "r32uint"],
    ["R32I", 0x8235, F.RED_INTEGER, [F.INT], true, false, [32, 0, 0, 0, 0, 0], "int", "r32sint"],
    ["RG8", 0x822B, F.RG, [F.UNSIGNED_BYTE], true, true, [8, 8, 0, 0, 0, 0], "unorm", "rg8unorm"],
    ["RG8_SNORM", 0x8F95, F.RG, [F.BYTE], false, true, [8, 8, 0, 0, 0, 0], "snorm", "rg8snorm"],
    ["RG16F", 0x822F, F.RG, [F.HALF_FLOAT, F.FLOAT], false, true, [16, 16, 0, 0, 0, 0], "float", "rg16float"],
    ["RG32F", 0x8230, F.RG, [F.FLOAT], false, false, [32, 32, 0, 0, 0, 0], "float", "rg32float"],
    ["RG8UI", 0x8238, F.RG_INTEGER, [F.UNSIGNED_BYTE], true, false, [8, 8, 0, 0, 0, 0], "uint", "rg8uint"],
    ["RG8I", 0x8237, F.RG_INTEGER, [F.BYTE], true, false, [8, 8, 0, 0, 0, 0], "int", "rg8sint"],
    ["RG16UI", 0x823A, F.RG_INTEGER, [F.UNSIGNED_SHORT], true, false, [16, 16, 0, 0, 0, 0], "uint", "rg16uint"],
    ["RG16I", 0x8239, F.RG_INTEGER, [F.SHORT], true, false, [16, 16, 0, 0, 0, 0], "int", "rg16sint"],
    ["RG32UI", 0x823C, F.RG_INTEGER, [F.UNSIGNED_INT], true, false, [32, 32, 0, 0, 0, 0], "uint", "rg32uint"],
    ["RG32I", 0x823B, F.RG_INTEGER, [F.INT], true, false, [32, 32, 0, 0, 0, 0], "int", "rg32sint"],
    ["RGB8", 0x8051, F.RGB, [F.UNSIGNED_BYTE], true, true, [8, 8, 8, 0, 0, 0], "unorm", "rgba8unorm"],
    ["SRGB8", 0x8C41, F.RGB, [F.UNSIGNED_BYTE], false, true, [8, 8, 8, 0, 0, 0], "unorm", "rgba8unorm-srgb"],
    ["RGB565", 0x8D62, F.RGB, [F.UNSIGNED_BYTE, F.UNSIGNED_SHORT_5_6_5], true, true, [5, 6, 5, 0, 0, 0], "unorm", "rgba8unorm"],
    ["RGB8_SNORM", 0x8F96, F.RGB, [F.BYTE], false, true, [8, 8, 8, 0, 0, 0], "snorm", "rgba8snorm"],
    ["R11F_G11F_B10F", 0x8C3A, F.RGB, [F.UNSIGNED_INT_10F_11F_11F_REV, F.HALF_FLOAT, F.FLOAT], false, true, [11, 11, 10, 0, 0, 0], "float",
        "rg11b10ufloat"],
    ["RGB9_E5", 0x8C3D, F.RGB, [F.UNSIGNED_INT_5_9_9_9_REV, F.HALF_FLOAT, F.FLOAT], false, true, [9, 9, 9, 0, 0, 0], "float", "rgb9e5ufloat"],
    ["RGB16F", 0x881B, F.RGB, [F.HALF_FLOAT, F.FLOAT], false, true, [16, 16, 16, 0, 0, 0], "float", "rgba16float"],
    ["RGB32F", 0x8815, F.RGB, [F.FLOAT], false, false, [32, 32, 32, 0, 0, 0], "float", "rgba32float"],
    ["RGB8UI", 0x8D7D, F.RGB_INTEGER, [F.UNSIGNED_BYTE], false, false, [8, 8, 8, 0, 0, 0], "uint", "rgba8uint"],
    ["RGB8I", 0x8D8F, F.RGB_INTEGER, [F.BYTE], false, false, [8, 8, 8, 0, 0, 0], "int", "rgba8sint"],
    ["RGB16UI", 0x8D77, F.RGB_INTEGER, [F.UNSIGNED_SHORT], false, false, [16, 16, 16, 0, 0, 0], "uint", "rgba16uint"],
    ["RGB16I", 0x8D89, F.RGB_INTEGER, [F.SHORT], false, false, [16, 16, 16, 0, 0, 0], "int", "rgba16sint"],
    ["RGB32UI", 0x8D71, F.RGB_INTEGER, [F.UNSIGNED_INT], false, false, [32, 32, 32, 0, 0, 0], "uint", "rgba32uint"],
    ["RGB32I", 0x8D83, F.RGB_INTEGER, [F.INT], false, false, [32, 32, 32, 0, 0, 0], "int", "rgba32sint"],
    ["RGBA8", 0x8058, F.RGBA, [F.UNSIGNED_BYTE], true, true, [8, 8, 8, 8, 0, 0], "unorm", "rgba8unorm"],
    ["SRGB8_ALPHA8", 0x8C43, F.RGBA, [F.UNSIGNED_BYTE], true, true, [8, 8, 8, 8, 0, 0], "unorm", "rgba8unorm-srgb"],
    ["RGBA8_SNORM", 0x8F97, F.RGBA, [F.BYTE], false, true, [8, 8, 8, 8, 0, 0], "snorm", "rgba8snorm"],
    ["RGB5_A1", 0x8057, F.RGBA, [F.UNSIGNED_BYTE, F.UNSIGNED_SHORT_5_5_5_1, F.UNSIGNED_INT_2_10_10_10_REV], true, true, [5, 5, 5, 1, 0, 0],
        "unorm", "rgba8unorm"],
    ["RGBA4", 0x8056, F.RGBA, [F.UNSIGNED_BYTE, F.UNSIGNED_SHORT_4_4_4_4], true, true, [4, 4, 4, 4, 0, 0], "unorm", "rgba8unorm"],
    ["RGB10_A2", 0x8059, F.RGBA, [F.UNSIGNED_INT_2_10_10_10_REV], true, true, [10, 10, 10, 2, 0, 0], "unorm", "rgb10a2unorm"],
    ["RGBA16F", 0x881A, F.RGBA, [F.HALF_FLOAT, F.FLOAT], false, true, [16, 16, 16, 16, 0, 0], "float", "rgba16float"],
    ["RGBA32F", 0x8814, F.RGBA, [F.FLOAT], false, false, [32, 32, 32, 32, 0, 0], "float", "rgba32float"],
    ["RGBA8UI", 0x8D7C, F.RGBA_INTEGER, [F.UNSIGNED_BYTE], true, false, [8, 8, 8, 8, 0, 0], "uint", "rgba8uint"],
    ["RGBA8I", 0x8D8E, F.RGBA_INTEGER, [F.BYTE], true, false, [8, 8, 8, 8, 0, 0], "int", "rgba8sint"],
    ["RGB10_A2UI", 0x906F, F.RGBA_INTEGER, [F.UNSIGNED_INT_2_10_10_10_REV], true, false, [10, 10, 10, 2, 0, 0], "uint", "rgb10a2uint"],
    ["RGBA16UI", 0x8D76, F.RGBA_INTEGER, [F.UNSIGNED_SHORT], true, false, [16, 16, 16, 16, 0, 0], "uint", "rgba16uint"],
    ["RGBA16I", 0x8D88, F.RGBA_INTEGER, [F.SHORT], true, false, [16, 16, 16, 16, 0, 0], "int", "rgba16sint"],
    ["RGBA32I", 0x8D82, F.RGBA_INTEGER, [F.INT], true, false, [32, 32, 32, 32, 0, 0], "int", "rgba32sint"],
    ["RGBA32UI", 0x8D70, F.RGBA_INTEGER, [F.UNSIGNED_INT], true, false, [32, 32, 32, 32, 0, 0], "uint", "rgba32uint"],
    ["DEPTH_COMPONENT16", 0x81A5, F.DEPTH_COMPONENT, [F.UNSIGNED_SHORT, F.UNSIGNED_INT], false, false, [0, 0, 0, 0, 16, 0], "depth",
        "depth16unorm"],
    ["DEPTH_COMPONENT24", 0x81A6, F.DEPTH_COMPONENT, [F.UNSIGNED_INT], false, false, [0, 0, 0, 0, 24, 0], "depth", "depth24plus"],
    ["DEPTH_COMPONENT32F", 0x8CAC, F.DEPTH_COMPONENT, [F.FLOAT], false, false, [0, 0, 0, 0, 32, 0], "depth", "depth32float"],
    ["DEPTH24_STENCIL8", 0x88F0, F.DEPTH_STENCIL, [F.UNSIGNED_INT_24_8], false, false, [0, 0, 0, 0, 24, 8], "depth_stencil",
        "depth24plus-stencil8"],
    ["DEPTH32F_STENCIL8", 0x8CAD, F.DEPTH_STENCIL, [F.FLOAT_32_UNSIGNED_INT_24_8_REV], false, false, [0, 0, 0, 0, 32, 8], "depth_stencil",
        "depth32float-stencil8"],
];

/** @typedef {{name: string, value: number, format: number, types: !Array<number>, renderable: boolean, filterable: boolean,
 *     bits: !Array<number>, kind: string, webgpu: string, sized: boolean, compressed: boolean, srgb: boolean}} */
export let FormatInfo;

/** @type {!Map<number, !FormatInfo>} the sized internal formats */
export const SIZED_FORMATS = new Map(SIZED.map(([name, value, format, types, renderable, filterable, bits, kind, webgpu]) =>
    [value, { name, value, format, types, renderable, filterable, bits, kind, webgpu, sized: true, compressed: false,
        srgb: name.startsWith("SRGB") }]));

/** The unsized ones (table 3.3): format, the types each takes, the sized format each pair amounts to */
const UNSIZED = new Map([
    [F.RGBA, new Map([[F.UNSIGNED_BYTE, 0x8058], [F.UNSIGNED_SHORT_4_4_4_4, 0x8056], [F.UNSIGNED_SHORT_5_5_5_1, 0x8057]])],
    [F.RGB, new Map([[F.UNSIGNED_BYTE, 0x8051], [F.UNSIGNED_SHORT_5_6_5, 0x8D62]])],
    [F.LUMINANCE_ALPHA, new Map([[F.UNSIGNED_BYTE, F.LUMINANCE_ALPHA]])],
    [F.LUMINANCE, new Map([[F.UNSIGNED_BYTE, F.LUMINANCE]])],
    [F.ALPHA, new Map([[F.UNSIGNED_BYTE, F.ALPHA]])],
    [F.BGRA_EXT, new Map([[F.UNSIGNED_BYTE, F.BGRA_EXT]])],
]);

/** The legacy formats as FormatInfo (LUMINANCE, ALPHA, LUMINANCE_ALPHA, BGRA: rgba8 on the page, swizzled) */
const LEGACY = new Map([
    [F.LUMINANCE, { name: "LUMINANCE", value: F.LUMINANCE, format: F.LUMINANCE, types: [F.UNSIGNED_BYTE], renderable: false, filterable: true,
        bits: [8, 0, 0, 0, 0, 0], kind: "unorm", webgpu: "rgba8unorm", sized: false, compressed: false, srgb: false }],
    [F.ALPHA, { name: "ALPHA", value: F.ALPHA, format: F.ALPHA, types: [F.UNSIGNED_BYTE], renderable: false, filterable: true,
        bits: [0, 0, 0, 8, 0, 0], kind: "unorm", webgpu: "rgba8unorm", sized: false, compressed: false, srgb: false }],
    [F.LUMINANCE_ALPHA, { name: "LUMINANCE_ALPHA", value: F.LUMINANCE_ALPHA, format: F.LUMINANCE_ALPHA, types: [F.UNSIGNED_BYTE],
        renderable: false, filterable: true, bits: [8, 0, 0, 8, 0, 0], kind: "unorm", webgpu: "rgba8unorm", sized: false, compressed: false,
        srgb: false }],
    [F.BGRA_EXT, { name: "BGRA8_EXT", value: F.BGRA_EXT, format: F.BGRA_EXT, types: [F.UNSIGNED_BYTE], renderable: true, filterable: true,
        bits: [8, 8, 8, 8, 0, 0], kind: "unorm", webgpu: "rgba8unorm", sized: false, compressed: false, srgb: false }],
]);

/** The compressed formats of GLES 3.0 (ETC2 and EAC), and ETC1: [value, name, block bytes, channels, WebGPU's format] */
const COMPRESSED = [
    [0x9270, "COMPRESSED_R11_EAC", 8, 1, "eac-r11unorm"], [0x9271, "COMPRESSED_SIGNED_R11_EAC", 8, 1, "eac-r11snorm"],
    [0x9272, "COMPRESSED_RG11_EAC", 16, 2, "eac-rg11unorm"], [0x9273, "COMPRESSED_SIGNED_RG11_EAC", 16, 2, "eac-rg11snorm"],
    [0x9274, "COMPRESSED_RGB8_ETC2", 8, 3, "etc2-rgb8unorm"], [0x9275, "COMPRESSED_SRGB8_ETC2", 8, 3, "etc2-rgb8unorm-srgb"],
    [0x9276, "COMPRESSED_RGB8_PUNCHTHROUGH_ALPHA1_ETC2", 8, 4, "etc2-rgb8a1unorm"],
    [0x9277, "COMPRESSED_SRGB8_PUNCHTHROUGH_ALPHA1_ETC2", 8, 4, "etc2-rgb8a1unorm-srgb"],
    [0x9278, "COMPRESSED_RGBA8_ETC2_EAC", 16, 4, "etc2-rgba8unorm"], [0x9279, "COMPRESSED_SRGB8_ALPHA8_ETC2_EAC", 16, 4, "etc2-rgba8unorm-srgb"],
    [0x8D64, "ETC1_RGB8_OES", 8, 3, "etc2-rgb8unorm"],
];
/** GLES 3.2's ASTC (LDR): [value, block width, block height], the sRGB ones 0x20 after; 16 bytes a block */
const ASTC = [[0x93B0, 4, 4], [0x93B1, 5, 4], [0x93B2, 5, 5], [0x93B3, 6, 5], [0x93B4, 6, 6], [0x93B5, 8, 5], [0x93B6, 8, 6], [0x93B7, 8, 8],
    [0x93B8, 10, 5], [0x93B9, 10, 6], [0x93BA, 10, 8], [0x93BB, 10, 10], [0x93BC, 12, 10], [0x93BD, 12, 12]];
/** @type {!Map<number, {name: string, block_bytes: number, channels: number, webgpu: string, block_width: number, block_height: number}>} */
export const COMPRESSED_FORMATS = new Map([
    ...COMPRESSED.map(([value, name, block_bytes, channels, webgpu]) => [value, { name, block_bytes, channels, webgpu, block_width: 4, block_height: 4 }]),
    ...ASTC.flatMap(([value, w, h]) => [false, true].map(srgb => [value + (srgb ? 0x20 : 0), {
        name: (srgb ? "COMPRESSED_SRGB8_ALPHA8_ASTC_" : "COMPRESSED_RGBA_ASTC_") + w + "x" + h, block_bytes: 16, channels: 4,
        webgpu: "astc-" + w + "x" + h + "-unorm" + (srgb ? "-srgb" : ""), block_width: w, block_height: h, astc: true }])),
]);

/** GLES 3.0's GL_COMPRESSED_TEXTURE_FORMATS: ETC2 and EAC, and ETC1 */
export const COMPRESSED_TEXTURE_FORMATS_3 = COMPRESSED.map(c => c[0]);
/** GLES 3.2's: ASTC's too */
export const COMPRESSED_TEXTURE_FORMATS_32 = [...COMPRESSED_FORMATS.keys()];

/** @param {number} internalformat @return {?FormatInfo} a sized format's, or a legacy one's */
export function format_info(internalformat)
{
    return SIZED_FORMATS.get(internalformat) || LEGACY.get(internalformat) || null;
}

const FORMATS = new Set([F.RED, F.RG, F.RGB, F.RGBA, F.RED_INTEGER, F.RG_INTEGER, F.RGB_INTEGER, F.RGBA_INTEGER, F.DEPTH_COMPONENT,
    F.DEPTH_STENCIL, F.LUMINANCE, F.LUMINANCE_ALPHA, F.ALPHA, F.BGRA_EXT]);
const TYPES = new Set([F.BYTE, F.UNSIGNED_BYTE, F.SHORT, F.UNSIGNED_SHORT, F.INT, F.UNSIGNED_INT, F.FLOAT, F.HALF_FLOAT, F.HALF_FLOAT_OES,
    F.UNSIGNED_SHORT_4_4_4_4, F.UNSIGNED_SHORT_5_5_5_1, F.UNSIGNED_SHORT_5_6_5, F.UNSIGNED_INT_2_10_10_10_REV, F.UNSIGNED_INT_10F_11F_11F_REV,
    F.UNSIGNED_INT_5_9_9_9_REV, F.UNSIGNED_INT_24_8, F.FLOAT_32_UNSIGNED_INT_24_8_REV]);

/**
 * glTexImage*'s internal format, format and type, by GLES 3.0's rules
 * (3.8.3): the sized format they make, or the error
 * @return {{error: number, internal: number}} internal: the sized (or
 *     legacy) format the image has; error: 0, or INVALID_ENUM,
 *     INVALID_VALUE, INVALID_OPERATION
 */
export function tex_image_format(internalformat, format, type)
{
    if(!FORMATS.has(format) || !TYPES.has(type)) return { error: 0x0500, internal: 0 };
    const unsized = UNSIZED.get(internalformat);
    if(unsized)
    {
        if(format !== internalformat) return { error: 0x0502, internal: 0 };
        // (GLES 2.0's OES_texture_half_float: an unsized format of half floats; GLES 3.0 also takes FLOAT with OES_texture_float)
        if(!unsized.has(type)) return { error: 0x0502, internal: 0 };
        return { error: 0, internal: unsized.get(type) };
    }
    const sized = SIZED_FORMATS.get(internalformat);
    if(!sized) return { error: 0x0501, internal: 0 };
    if(sized.format !== format || !sized.types.includes(type)) return { error: 0x0502, internal: 0 };
    return { error: 0, internal: internalformat };
}

/** @return {number} the bytes of one pixel of the format and type (as client memory holds it); 0 for a pair that is none */
export function pixel_bytes(format, type)
{
    switch(type)
    {
        case F.UNSIGNED_SHORT_4_4_4_4: case F.UNSIGNED_SHORT_5_5_5_1: case F.UNSIGNED_SHORT_5_6_5: return 2;
        case F.UNSIGNED_INT_2_10_10_10_REV: case F.UNSIGNED_INT_10F_11F_11F_REV: case F.UNSIGNED_INT_5_9_9_9_REV: case F.UNSIGNED_INT_24_8: return 4;
        case F.FLOAT_32_UNSIGNED_INT_24_8_REV: return 8;
    }
    const channels = { [F.RED]: 1, [F.RED_INTEGER]: 1, [F.DEPTH_COMPONENT]: 1, [F.LUMINANCE]: 1, [F.ALPHA]: 1, [F.STENCIL_INDEX]: 1,
        [F.RG]: 2, [F.RG_INTEGER]: 2, [F.LUMINANCE_ALPHA]: 2, [F.RGB]: 3, [F.RGB_INTEGER]: 3, [F.RGBA]: 4, [F.RGBA_INTEGER]: 4,
        [F.BGRA_EXT]: 4 }[format] || 0;
    const size = { [F.BYTE]: 1, [F.UNSIGNED_BYTE]: 1, [F.SHORT]: 2, [F.UNSIGNED_SHORT]: 2, [F.HALF_FLOAT]: 2, [F.HALF_FLOAT_OES]: 2,
        [F.INT]: 4, [F.UNSIGNED_INT]: 4, [F.FLOAT]: 4 }[type] || 0;
    return channels * size;
}

/**
 * The bytes an image of client memory takes by the pixel store's state
 * (GLES 3.0, 3.7.1): rows of row_length (or width) pixels aligned,
 * image_height (or height) rows an image, after the skips
 * @param {{alignment: number, row_length: number, image_height: number, skip_pixels: number, skip_rows: number, skip_images: number}} store
 * @return {number} 0 for an empty image
 */
export function image_bytes3(width, height, depth, format, type, store)
{
    if(!width || !height || !depth) return 0;
    const pixel = pixel_bytes(format, type);
    const row_pixels = store.row_length > 0 ? store.row_length : width;
    const row = Math.ceil(row_pixels * pixel / store.alignment) * store.alignment;
    const image_rows = store.image_height > 0 ? store.image_height : height;
    const skip = store.skip_images * image_rows * row + store.skip_rows * row + store.skip_pixels * pixel;
    return skip + (depth - 1) * image_rows * row + (height - 1) * row + width * pixel;
}

/** @return {number} the bytes of a compressed image of the format, or -1 for no such format */
export function compressed_bytes(internalformat, width, height, depth)
{
    const c = COMPRESSED_FORMATS.get(internalformat);
    if(!c) return -1;
    return Math.ceil(width / c.block_width) * Math.ceil(height / c.block_height) * c.block_bytes * depth;
}

/**
 * What GL_FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE answers for the format
 * @return {number}
 */
export function component_type(info)
{
    switch(info.kind)
    {
        case "snorm": return F.SIGNED_NORMALIZED;
        case "float": return F.FLOAT;
        case "int": return F.INT;
        case "uint": return F.UNSIGNED_INT;
        case "depth": case "depth_stencil": return info.value === 0x8CAC || info.value === 0x8CAD ? F.FLOAT : F.UNSIGNED_NORMALIZED;
        default: return F.UNSIGNED_NORMALIZED;
    }
}

/**
 * Whether a framebuffer can render to the format: GLES 3.0's
 * color-renderable ones, the depth and stencil formats; with
 * EXT_color_buffer_float the float formats too
 */
export function renderable(info, color_buffer_float)
{
    if(!info) return false;
    if(info.kind === "depth" || info.kind === "depth_stencil" || info.value === 0x8D48) return true;
    if(info.renderable) return true;
    return !!color_buffer_float && info.kind === "float" && info.value !== 0x8C3D && info.format !== F.RGB || !!color_buffer_float && info.value === 0x8C3A;
}
