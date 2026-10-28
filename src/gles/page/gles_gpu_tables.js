// GL's state as WebGPU's, for the GLES executor's draws (gles_executor.js,
// GLES 2.0's and 1.1's; gles3_executor.js, GLES 3.x's)

export const U = globalThis.GPUTextureUsage || { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
export const B = globalThis.GPUBufferUsage || { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64,
    STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
/** The format of color buffers, window surfaces and GLES 2.0's textures */
export const COLOR_FORMAT = "rgba8unorm";

export const BLEND_FACTORS = {
    0: "zero", 1: "one", 0x0300: "src", 0x0301: "one-minus-src", 0x0302: "src-alpha", 0x0303: "one-minus-src-alpha",
    0x0304: "dst-alpha", 0x0305: "one-minus-dst-alpha", 0x0306: "dst", 0x0307: "one-minus-dst", 0x0308: "src-alpha-saturated",
    0x8001: "constant", 0x8002: "one-minus-constant", 0x8003: "constant", 0x8004: "one-minus-constant",
};
/** (MIN and MAX: GLES 3.0's, EXT_blend_minmax's) */
export const BLEND_OPS = { 0x8006: "add", 0x800A: "subtract", 0x800B: "reverse-subtract", 0x8007: "min", 0x8008: "max" };
export const COMPARE = { 0x0200: "never", 0x0201: "less", 0x0202: "equal", 0x0203: "less-equal", 0x0204: "greater", 0x0205: "not-equal",
    0x0206: "greater-equal", 0x0207: "always" };
export const STENCIL_OPS = { 0: "zero", 0x1E00: "keep", 0x1E01: "replace", 0x1E02: "increment-clamp", 0x1E03: "decrement-clamp",
    0x150A: "invert", 0x8507: "increment-wrap", 0x8508: "decrement-wrap" };
/** (GLES 3.2's clamp to border: the edge's, the shader choosing the border color outside the image: vx_naga's border.rs) */
export const WRAPS = { 0x2901: "repeat", 0x812F: "clamp-to-edge", 0x8370: "mirror-repeat", 0x812D: "clamp-to-edge" };

/** @param {number} n @return {number} n rounded up to a multiple of 4 */
export const align4 = n => n + 3 & ~3;

/** A blend component's state (MIN and MAX take no factors: WebGPU's must be one) */
export function blend_component(equation, src, dst)
{
    const operation = BLEND_OPS[equation] || "add";
    if(operation === "min" || operation === "max") return { operation, srcFactor: "one", dstFactor: "one" };
    return { operation, srcFactor: BLEND_FACTORS[src], dstFactor: BLEND_FACTORS[dst] };
}
