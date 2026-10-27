// OpenGL ES 2.0 and 1.1's enums and format rules that the shadow state
// (src/gles/gles_shadow.js) checks calls against and the executor (E3)
// stores images by: which format and type pairs TexImage2D takes, what a
// renderbuffer's internal format holds, which images a framebuffer can
// render to, the bytes of a row (pixel store alignment), the GL type of a
// GLSL type. With the extensions the host offers (gles_caps.js):
// OES_rgb8_rgba8, OES_depth24, OES_packed_depth_stencil,
// EXT_texture_format_BGRA8888, OES_compressed_ETC1_RGB8_texture,
// OES_element_index_uint, OES_texture_npot, OES_EGL_image(_external).

export const GL = {
    NO_ERROR: 0, INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501, INVALID_OPERATION: 0x0502, OUT_OF_MEMORY: 0x0505,
    INVALID_FRAMEBUFFER_OPERATION: 0x0506,
    FALSE: 0, TRUE: 1, NONE: 0,
    // primitives
    POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
    // types
    BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, INT: 0x1404, UNSIGNED_INT: 0x1405,
    FLOAT: 0x1406, FIXED: 0x140C, HALF_FLOAT_OES: 0x8D61,
    UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034, UNSIGNED_SHORT_5_6_5: 0x8363,
    // formats
    DEPTH_COMPONENT: 0x1902, ALPHA: 0x1906, RGB: 0x1907, RGBA: 0x1908, LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190A,
    BGRA_EXT: 0x80E1, ETC1_RGB8_OES: 0x8D64,
    RGBA4: 0x8056, RGB5_A1: 0x8057, RGB565: 0x8D62, RGB8_OES: 0x8051, RGBA8_OES: 0x8058, DEPTH_COMPONENT16: 0x81A5,
    DEPTH_COMPONENT24_OES: 0x81A6, STENCIL_INDEX8: 0x8D48, DEPTH24_STENCIL8_OES: 0x88F0,
    // objects and targets
    TEXTURE_2D: 0x0DE1, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515, TEXTURE_EXTERNAL_OES: 0x8D65,
    TEXTURE0: 0x84C0, ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41,
    TEXTURE: 0x1702, COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00, STENCIL_ATTACHMENT: 0x8D20,
    STREAM_DRAW: 0x88E0, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8,
    VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
    // framebuffer status
    FRAMEBUFFER_COMPLETE: 0x8CD5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8CD6, FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8CD7,
    FRAMEBUFFER_INCOMPLETE_DIMENSIONS: 0x8CD9, FRAMEBUFFER_UNSUPPORTED: 0x8CDD,
    // texture parameters
    TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    GENERATE_MIPMAP: 0x8191, TEXTURE_CROP_RECT_OES: 0x8B9D,
    NEAREST: 0x2600, LINEAR: 0x2601, NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701,
    NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
    REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370,
    // pixel store
    UNPACK_ALIGNMENT: 0x0CF5, PACK_ALIGNMENT: 0x0D05,
};

/** The capabilities glEnable takes: GLES 2.0's */
export const CAPS_2 = new Set([0x0B44, 0x0BE2, 0x0BD0, 0x0B90, 0x0B71, 0x0C11, 0x8037, 0x809E, 0x80A0]);
/** GLES 1.1's: 2.0's (but none of them the sample ones' alpha) and the fixed function's */
export const CAPS_1 = new Set([0x0B44, 0x0BE2, 0x0BD0, 0x0B90, 0x0B71, 0x0C11, 0x8037, 0x809E, 0x80A0,
    0x0BC0, 0x0B50, 0x0B57, 0x0BA1, 0x0B60, 0x0BF2, 0x0B20, 0x0B10, 0x809D, 0x803A, 0x809F, 0x8861, 0x8513,
    0x4000, 0x4001, 0x4002, 0x4003, 0x4004, 0x4005, 0x4006, 0x4007, 0x3000, 0x3001, 0x3002, 0x3003, 0x3004, 0x3005,
    0x8074, 0x8075, 0x8076, 0x8078, 0x8B9C, 0x8842, 0x86AD, 0x8D65]);

/** TexImage2D's format and type pairs (format is also the internal format) and each texel's bytes */
const TEXTURE_TYPES = new Map([
    [GL.RGBA, new Map([[GL.UNSIGNED_BYTE, 4], [GL.UNSIGNED_SHORT_4_4_4_4, 2], [GL.UNSIGNED_SHORT_5_5_5_1, 2]])],
    [GL.RGB, new Map([[GL.UNSIGNED_BYTE, 3], [GL.UNSIGNED_SHORT_5_6_5, 2]])],
    [GL.LUMINANCE_ALPHA, new Map([[GL.UNSIGNED_BYTE, 2]])],
    [GL.LUMINANCE, new Map([[GL.UNSIGNED_BYTE, 1]])],
    [GL.ALPHA, new Map([[GL.UNSIGNED_BYTE, 1]])],
    [GL.BGRA_EXT, new Map([[GL.UNSIGNED_BYTE, 4]])],
]);
/** Every enum TexImage2D might name as a type: the others are INVALID_ENUM */
const TYPE_ENUMS = new Set([GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.INT, GL.UNSIGNED_INT, GL.FLOAT,
    GL.HALF_FLOAT_OES, GL.UNSIGNED_SHORT_4_4_4_4, GL.UNSIGNED_SHORT_5_5_5_1, GL.UNSIGNED_SHORT_5_6_5]);
const FORMAT_ENUMS = new Set([GL.DEPTH_COMPONENT, GL.ALPHA, GL.RGB, GL.RGBA, GL.LUMINANCE, GL.LUMINANCE_ALPHA, GL.BGRA_EXT]);

/**
 * TexImage2D's (and TexSubImage2D's) check of a format and type
 * @param {number} format
 * @param {number} type
 * @return {number} GL.NO_ERROR, INVALID_ENUM (an enum that is no format or
 *     no type) or INVALID_OPERATION (a pair GLES does not have)
 */
export function texture_format_error(format, type)
{
    if(!FORMAT_ENUMS.has(format) || !TYPE_ENUMS.has(type)) return GL.INVALID_ENUM;
    const types = TEXTURE_TYPES.get(format);
    return types && types.has(type) ? GL.NO_ERROR : GL.INVALID_OPERATION;
}

/** @return {number} a texel's bytes in the format and type (0: none) */
export function texel_bytes(format, type)
{
    const types = TEXTURE_TYPES.get(format);
    return types && types.get(type) || 0;
}

/**
 * The bytes of an image the guest sends or receives: rows padded to the
 * pixel store's alignment, the last row not
 * @param {number} width
 * @param {number} height
 * @param {number} bytes_per_texel
 * @param {number} alignment 1, 2, 4 or 8
 * @return {number}
 */
export function image_bytes(width, height, bytes_per_texel, alignment)
{
    if(width <= 0 || height <= 0) return 0;
    const row = width * bytes_per_texel;
    const stride = Math.ceil(row / alignment) * alignment;
    return stride * (height - 1) + row;
}

/** ETC1's bytes: 8 per 4 by 4 block */
export function etc1_bytes(width, height)
{
    return Math.ceil(width / 4) * Math.ceil(height / 4) * 8;
}

/**
 * The sizes of the color, depth and stencil an image holds: red, green,
 * blue, alpha, depth, stencil, and whether a framebuffer renders color into it
 * @typedef {{bits: !Array<number>, color: boolean, depth: boolean, stencil: boolean}}
 */
export let ImageKind;

/** Renderbuffers' internal formats (RenderbufferStorage) */
export const RENDERBUFFER_FORMATS = new Map([
    [GL.RGBA4, { bits: [4, 4, 4, 4, 0, 0], color: true, depth: false, stencil: false }],
    [GL.RGB5_A1, { bits: [5, 5, 5, 1, 0, 0], color: true, depth: false, stencil: false }],
    [GL.RGB565, { bits: [5, 6, 5, 0, 0, 0], color: true, depth: false, stencil: false }],
    [GL.RGB8_OES, { bits: [8, 8, 8, 0, 0, 0], color: true, depth: false, stencil: false }],
    [GL.RGBA8_OES, { bits: [8, 8, 8, 8, 0, 0], color: true, depth: false, stencil: false }],
    [GL.DEPTH_COMPONENT16, { bits: [0, 0, 0, 0, 16, 0], color: false, depth: true, stencil: false }],
    [GL.DEPTH_COMPONENT24_OES, { bits: [0, 0, 0, 0, 24, 0], color: false, depth: true, stencil: false }],
    [GL.STENCIL_INDEX8, { bits: [0, 0, 0, 0, 0, 8], color: false, depth: false, stencil: true }],
    [GL.DEPTH24_STENCIL8_OES, { bits: [0, 0, 0, 0, 24, 8], color: false, depth: true, stencil: true }],
]);

/**
 * A texture image's kind by its format and type (an EGL image's or a
 * color buffer's by its internal format: GL_RGBA, GL_RGB, ...)
 * @param {number} format
 * @param {number} type
 * @return {!ImageKind}
 */
export function texture_kind(format, type)
{
    const color = !(format === GL.LUMINANCE || format === GL.LUMINANCE_ALPHA || format === GL.ALPHA || format === GL.ETC1_RGB8_OES);
    let bits;
    switch(format)
    {
        case GL.RGBA: case GL.BGRA_EXT:
            bits = type === GL.UNSIGNED_SHORT_4_4_4_4 ? [4, 4, 4, 4] : type === GL.UNSIGNED_SHORT_5_5_5_1 ? [5, 5, 5, 1] : [8, 8, 8, 8];
            break;
        case GL.RGB: case GL.ETC1_RGB8_OES:
            bits = type === GL.UNSIGNED_SHORT_5_6_5 ? [5, 6, 5, 0] : [8, 8, 8, 0];
            break;
        case GL.ALPHA: bits = [0, 0, 0, 8]; break;
        case GL.LUMINANCE: bits = [8, 8, 8, 0]; break;
        case GL.LUMINANCE_ALPHA: bits = [8, 8, 8, 8]; break;
        default: bits = [8, 8, 8, 8];
    }
    return { bits: [...bits, 0, 0], color, depth: false, stencil: false };
}

/** The GL types of GLSL ES's types (glGetActiveUniform, glGetActiveAttrib) */
export const GLSL_TYPES = {
    "float": 0x1406, "vec2": 0x8B50, "vec3": 0x8B51, "vec4": 0x8B52, "int": 0x1404, "ivec2": 0x8B53, "ivec3": 0x8B54,
    "ivec4": 0x8B55, "bool": 0x8B56, "bvec2": 0x8B57, "bvec3": 0x8B58, "bvec4": 0x8B59, "mat2": 0x8B5A, "mat3": 0x8B5B,
    "mat4": 0x8B5C, "sampler2D": 0x8B5E, "samplerCube": 0x8B60, "samplerExternalOES": 0x8D66,
};

/** @return {number} the GL type of a sampler by its reflection's dim (and whether it is external) */
export function sampler_type(dim, external)
{
    return external ? GLSL_TYPES["samplerExternalOES"] : dim === "Cube" ? GLSL_TYPES["samplerCube"] : GLSL_TYPES["sampler2D"];
}
