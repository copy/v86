// GLES 3.x's draws on the page (docs/gles3-plan.md L3): what a context of
// api 3 does on the GPU, as methods of the GLES executor (gles_executor.js
// installs them). Its programs are glslang's (the CPU side links them and
// sends the link, PROGRAM_LINK): each stage's SPIR-V becomes WGSL through
// vx_naga (vx/naga, the Venus executor's translator) with GL's clip space
// depth and the translator's Y flip, so the orientation is GLES 2.0's
// (framebuffer row 0 is GL's bottom row).
//
// - Buffers live on the GPU (a GPUBuffer each, made at first use) with
//   their bytes on the CPU side too (the shadow's `bytes`): the guest's
//   writes go to the bytes and reach the GPU buffer before a draw needs it
//   (`dirty`); a buffer the GPU wrote (`gpu_newer`, transform feedback,
//   copies) takes the guest's writes directly.
// - Vertex arrays in buffers are the draw's vertex buffers where WebGPU has
//   their format and alignment; the others (client arrays, packed and
//   three-component types, divisors past 1) are assembled on the CPU, the
//   indices then too (from the vertex range's first). Fans and loops become
//   lists; a fixed restart index ends a list's primitive or restarts a strip.
// - Textures have their sized format's WebGPU format (gles_formats3.js), all
//   levels of one GPU texture from the lowest level given; 3D and array
//   textures, sampler objects, base and max levels, depth comparison;
//   integer textures are fetched (vx_naga's intsample.rs, with the sampler's
//   wraps). An incomplete texture samples as (0, 0, 0, 1).
// - The draw framebuffer's draw buffers are the pass's color attachments (of
//   their own formats), multisampled renderbuffers 4 samples.

import { COMPRESSED_FORMATS, F, format_info, tex_image_format } from "../gles_formats3.js";
import { GL3 } from "../gles3_state.js";
import { ADVANCED_BLEND, BLEND_CONSTANT, SAMPLES_CONSTANT } from "../glsl_es_rewrite.js";
import { BINDING, gl_type } from "../glsl_program.js";
import { DRAWN_DEPTH, RENDERABLE, TEXEL_BYTES, decode_texels, depth_values, from_half, pack_pixels, to_texels, unpack_image } from "./gles3_pixels.js";
import { decode_etc1 } from "./gles_textures.js";
import { B, COLOR_FORMAT, COMPARE, STENCIL_OPS, U, WRAPS, align4, blend_component } from "./gles_gpu_tables.js";

const SCRIPT = typeof document !== "undefined" && document.currentScript ? document.currentScript.src : null;
/** vx_naga.wasm: next to the page's WebGPU bundle (tools/build_glbridge.mjs) */
const NAGA_URL = SCRIPT ? new URL("vx_naga.wasm", SCRIPT).href : "vx_naga.wasm";
/** vx_naga's translation flags (vx_executor.js's TRANSLATE): the fragment depth dropped, GL's clip space depth */
const NO_DEPTH = 2, GL_DEPTH = 8;
/** WGSL's bindings of SPIR-V's: 2b (2b + 1 a combined sampler's sampler), element e > 0 of an array ELEMENTS + 2 (16b + e) */
const ELEMENTS = 300, ELEMENTS_END = 960;

const NEAREST = 0x2600, LINEAR = 0x2601, NEAREST_MIPMAP_NEAREST = 0x2700;
const RESTART = 0x8D69, CULL_FACE = 0x0B44, BLEND = 0x0BE2, DEPTH_TEST = 0x0B71, STENCIL_TEST = 0x0B90, SCISSOR_TEST = 0x0C11;
const POLYGON_OFFSET_FILL = 0x8037;
const COMPARE_REF_TO_TEXTURE = 0x884E;
/**
 * The format a compressed texture of blocks WebGPU will not take (not whole
 * blocks) is decoded into: sRGB's, EAC's 11 signed or unsigned bits in
 * halves, the rest 8 bits a channel
 */
const decoded_format = compressed => compressed.webgpu.endsWith("-srgb") ? "rgba8unorm-srgb" : compressed.webgpu.startsWith("eac-") ? "rgba16float" : "rgba8unorm";
/**
 * Whether a color format GL reads with alpha 1 (RGB8, RGB565: none of its
 * own) is kept in a WebGPU format with an alpha (rgba8unorm): such a texture
 * starts with alpha 1 and draws, clears and blits leave its alpha alone
 */
const alpha_less = (internal, webgpu) =>
{
    const info = format_info(internal);
    return !!info && info.bits[3] === 0 && info.bits[0] > 0 && info.kind !== "depth" && info.kind !== "depth_stencil" && /^(rgba|bgra)/.test(webgpu);
};
/** GLES 3.1's DEPTH_STENCIL_TEXTURE_MODE: the stencil of a depth and stencil texture sampled */
const STENCIL_INDEX = 0x1901;
const TOPOLOGY = ["point-list", "line-list", "line-list", "line-strip", "triangle-list", "triangle-strip", "triangle-list"];
const INDEX_BYTES = { 0x1401: 1, 0x1403: 2, 0x1405: 4 };
const STRIP_END = 0xFFFFFFFF;

/** The texture slot (gles3_state.js's SLOT) of a sampler type, and each slot's target */
const SAMPLER_SLOT = new Map([[0x8B5E, 0], [0x8B62, 0], [0x8DCA, 0], [0x8DD2, 0], [0x8B60, 1], [0x8DC5, 1], [0x8DCC, 1], [0x8DD4, 1],
    [0x8D66, 2], [0x8B5F, 3], [0x8DCB, 3], [0x8DD3, 3], [0x8DC1, 4], [0x8DC4, 4], [0x8DCF, 4], [0x8DD7, 4], [0x9108, 5], [0x9109, 5], [0x910A, 5],
    [0x900C, 6], [0x900D, 6], [0x900E, 6], [0x900F, 6]]);
const SLOT_TARGET = [GL3.TEXTURE_2D, GL3.TEXTURE_CUBE_MAP, GL3.TEXTURE_EXTERNAL_OES, GL3.TEXTURE_3D, GL3.TEXTURE_2D_ARRAY, 0x9100, 0x9009];
/** What a texture unit samples with nothing bound */
const NO_SAMPLER = { min_filter: NEAREST, mag_filter: NEAREST, wrap_s: 0x812F, wrap_t: 0x812F, wrap_r: 0x812F, compare_func: 0x0203 };
/** Vulkan's address modes (vx_naga's int_wraps): repeat 0, mirrored repeat 1, clamp to edge 2 */
const VK_WRAP = { 0x2901: 0, 0x8370: 1, 0x812F: 2, 0x812D: 3 };
/** GLES 3.2's advanced blend equations: their index (glsl_es_rewrite.js's BLEND_CONSTANT) */
const ADVANCED_INDEX = new Map(ADVANCED_BLEND.map(([e], i) => [e, i]));
/** The advanced blend equation's index a draw blends by, or -1 */
const advanced_blend = c => c.version >= 32 && c.enabled.has(BLEND) && ADVANCED_INDEX.has(c.blend_equation[0]) ? ADVANCED_INDEX.get(c.blend_equation[0]) : -1;
/** vx_naga's border.rs: a border color component's entry in the wraps list */
const BORDER_COLOR = 0x80000000;

/** WebGPU's storage texture formats (GLES 3.1's image formats as WebGPU has them) */
const STORAGE_FORMATS = new Set(["rgba8unorm", "rgba8snorm", "rgba8uint", "rgba8sint", "rgba16uint", "rgba16sint", "rgba16float", "r32uint", "r32sint",
    "r32float", "rg32uint", "rg32sint", "rg32float", "rgba32uint", "rgba32sint", "rgba32float"]);

/** The renderbuffer formats that are no sized texture format */
const RENDERBUFFER_WEBGPU = { 0x8D48: "stencil8", 0x81A7: "depth32float" };

/** WebGPU's vertex formats as VkFormats (vx_naga's xfb.rs reads vertex buffers by them) */
const VK_FORMAT = {
    "float32": 100, "float32x2": 103, "float32x3": 106, "float32x4": 109, "sint32": 99, "sint32x2": 102, "sint32x3": 105, "sint32x4": 108,
    "uint32": 98, "uint32x2": 101, "uint32x3": 104, "uint32x4": 107, "unorm8x2": 16, "snorm8x2": 17, "uint8x2": 20, "sint8x2": 21,
    "unorm8x4": 37, "snorm8x4": 38, "uint8x4": 41, "sint8x4": 42, "unorm16x2": 77, "snorm16x2": 78, "uint16x2": 81, "sint16x2": 82,
    "float16x2": 83, "unorm16x4": 91, "snorm16x4": 92, "uint16x4": 95, "sint16x4": 96, "float16x4": 97,
};

/** Vertex attribute types: their bytes */
const TYPE_BYTES = { 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x1404: 4, 0x1405: 4, 0x1406: 4, 0x140C: 4, 0x140B: 2, 0x8D61: 2, 0x8D9F: 4,
    0x8368: 4 };
const INT_2_10_10_10_REV = 0x8D9F, UNSIGNED_INT_2_10_10_10_REV = 0x8368;
const packed_attribute = type => type === INT_2_10_10_10_REV || type === UNSIGNED_INT_2_10_10_10_REV;
/** The vertex formats of CPU-assembled attributes, by the shader's input kind */
const CPU_FORMAT = { f: "float32", i: "sint32", u: "uint32" };

/** GLES 2.0's unsized images of OES_texture_float, _half_float and OES_depth_texture as sized formats */
const UNSIZED_EXTENSIONS = { [F.RGBA]: { [F.FLOAT]: 0x8814, [F.HALF_FLOAT_OES]: 0x881A }, [F.RGB]: { [F.FLOAT]: 0x8815, [F.HALF_FLOAT_OES]: 0x881B },
    [F.DEPTH_COMPONENT]: { [F.UNSIGNED_SHORT]: 0x81A5, [F.UNSIGNED_INT]: 0x81A6 }, [F.DEPTH_STENCIL]: { [F.UNSIGNED_INT_24_8]: 0x88F0 } };

/**
 * An image's format as a sized one (or a legacy or compressed one): GLES
 * 3.0's images say it (`internal`), GLES 2.0's have their format and type
 */
function image_internal(image)
{
    if(image.internal) return image.internal;
    const own = UNSIZED_EXTENSIONS[image.format] && UNSIZED_EXTENSIONS[image.format][image.type];
    if(own) return own;
    const sized = tex_image_format(image.format, image.format, image.type);
    return sized.error ? image.format : sized.internal;
}

/** An unused vertex input's attribute (glsl_program.js's unused_inputs): its array disabled, its value (0, 0, 0, 1) */
const UNUSED_INPUT = { enabled: false, current: [0, 0, 0, 1] };

/** The pixel store's state a GLES 2.0 context lacks */
const NO_STORE = { row_length: 0, image_height: 0, skip_pixels: 0, skip_rows: 0, skip_images: 0 };

/** @return {?Uint8Array} a buffer's bytes on the page (GLES 3.0's `bytes`, GLES 2.0's `data`) */
const cpu_bytes = buffer => buffer.bytes || buffer.data || null;

/**
 * The WebGPU vertex format that reads an attribute's array as the shader's
 * input wants it, or null for one assembled on the CPU
 * @param {!Object} a the attribute's state
 * @param {string} kind the input's: "f", "i", "u"
 */
function direct_format(a, kind)
{
    const n = a.size, t = a.type;
    if(kind === "f")
    {
        if(a.integer) return null;
        if(t === 0x1406) return n === 1 ? "float32" : "float32x" + n;
        if(t === 0x140B || t === 0x8D61) return n === 2 || n === 4 ? "float16x" + n : null;
        if(!a.normalized) return null;
        const name = { 0x1401: "unorm8", 0x1400: "snorm8", 0x1403: "unorm16", 0x1402: "snorm16" }[t];
        return name && (n === 2 || n === 4) ? name + "x" + n : null;
    }
    if(!a.integer) return null;
    const signed = t === 0x1400 || t === 0x1402 || t === 0x1404;
    if(signed !== (kind === "i")) return null;
    const prefix = signed ? "sint" : "uint";
    if(t === 0x1404 || t === 0x1405) return n === 1 ? prefix + "32" : prefix + "32x" + n;
    return n === 2 || n === 4 ? prefix + (t === 0x1400 || t === 0x1401 ? "8x" : "16x") + n : null;
}

/** One component of a vertex array as GLES 3.0 reads it (2.9.1: normalized ones by equation 2.2) */
function read_component(view, p, type, normalized)
{
    switch(type)
    {
        case 0x1406: return view.getFloat32(p, true);
        case 0x140C: return view.getInt32(p, true) / 65536;
        case 0x140B: case 0x8D61: return from_half(view.getUint16(p, true));
        case 0x1401: return normalized ? view.getUint8(p) / 255 : view.getUint8(p);
        case 0x1400: return normalized ? Math.max(-1, view.getInt8(p) / 127) : view.getInt8(p);
        case 0x1403: return normalized ? view.getUint16(p, true) / 65535 : view.getUint16(p, true);
        case 0x1402: return normalized ? Math.max(-1, view.getInt16(p, true) / 32767) : view.getInt16(p, true);
        case 0x1405: return normalized ? view.getUint32(p, true) / 4294967295 : view.getUint32(p, true);
        case 0x1404: return normalized ? Math.max(-1, view.getInt32(p, true) / 2147483647) : view.getInt32(p, true);
    }
    return 0;
}

/** The four components of a packed 2_10_10_10 vertex */
function read_packed(view, p, type, normalized)
{
    const v = view.getUint32(p, true);
    const parts = [v & 1023, v >>> 10 & 1023, v >>> 20 & 1023, v >>> 30];
    if(type === UNSIGNED_INT_2_10_10_10_REV) return normalized ? parts.map((x, i) => x / (i === 3 ? 3 : 1023)) : parts;
    const signed = parts.map((x, i) => i === 3 ? (x >= 2 ? x - 4 : x) : x >= 512 ? x - 1024 : x);
    return normalized ? signed.map((x, i) => Math.max(-1, x / (i === 3 ? 1 : 511))) : signed;
}

/** A WGSL texture type's dimension and sample kind */
function texture_type(type)
{
    const m = /^texture_(depth_)?(multisampled_)?(1d|2d_array|2d|3d|cube_array|cube)(?:<(\w+)>)?/.exec(type || "");
    if(!m) return { dimension: "2d", sample: "float", multisampled: false };
    return { dimension: m[3].replace("_", "-"), multisampled: !!m[2], sample: m[1] ? "depth" : m[4] === "i32" ? "sint" : m[4] === "u32" ? "uint" : "float" };
}

/** The resource variables of naga's WGSL: binding to type */
function wgsl_declarations(wgsl)
{
    const declarations = new Map();
    for(const m of wgsl.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<[^>]*>)?\s+\w+\s*:\s*([^;]+);/g))
    {
        declarations.set(m[1] + ":" + m[2], m[3].trim());
    }
    return declarations;
}

/** A fragment entry point's color outputs: location to WGSL type */
function fragment_outputs(wgsl)
{
    const outputs = new Map();
    const at = wgsl.indexOf("@fragment");
    const signature = at < 0 ? null : /->\s*([^{]+)\{/.exec(wgsl.slice(at));
    if(!signature) return outputs;
    const result = signature[1].trim();
    const single = /^@location\((\d+)\)\s*(?:@\w+(?:\([^)]*\))?\s*)*([\w<>]+)/.exec(result);
    if(single)
    {
        outputs.set(+single[1], single[2]);
        return outputs;
    }
    const body = new RegExp("struct\\s+" + result + "\\s*\\{([^}]*)\\}").exec(wgsl);
    for(const m of body ? body[1].matchAll(/@location\((\d+)\)\s*(?:@\w+(?:\([^)]*\))?\s*)*\w+\s*:\s*([\w<>]+)/g) : [])
    {
        outputs.set(+m[1], m[2]);
    }
    return outputs;
}

/** SPIR-V's binding and element of a WGSL binding (vx/naga's wgsl_binding, backwards) */
function spirv_binding(binding)
{
    if(binding >= ELEMENTS && binding < ELEMENTS_END) return { b: binding - ELEMENTS >> 5, e: binding - ELEMENTS >> 1 & 15 };
    return { b: binding >> 1, e: 0 };
}

/**
 * Whether a dispatch's bind groups bind a buffer range or an image view to
 * write and also name it in another binding (GLSL's aliased buffers and
 * images, which WebGPU refuses in a dispatch)
 */
function writable_aliases(group)
{
    const ranges = [], views = [];
    for(const g of group.groups)
    {
        g.entries.forEach((entry, i) =>
        {
            const resource = g.resources[i].resource;
            if(entry.buffer && entry.buffer.type !== "uniform") ranges.push({ resource, writable: entry.buffer.type === "storage" });
            if(entry.storageTexture) views.push({ resource, writable: entry.storageTexture.access !== "read-only" });
        });
    }
    const overlap = (a, b) => a.resource.buffer === b.resource.buffer && a.resource.offset < b.resource.offset + b.resource.size &&
        b.resource.offset < a.resource.offset + a.resource.size;
    return ranges.some((a, i) => ranges.some((b, k) => k > i && (a.writable || b.writable) && overlap(a, b))) ||
        views.some((a, i) => views.some((b, k) => k > i && (a.writable || b.writable) && a.resource === b.resource));
}

/** The framebuffer a context reads (GLES 2.0's: the one it draws to) */
const read_framebuffer = c => c.read_framebuffer === undefined ? c.framebuffer : c.read_framebuffer;

/** A WebGPU format's kind for shader outputs and blending */
function format_kind(format)
{
    if(format.startsWith("depth") || format.startsWith("stencil")) return "depth";
    return format.includes("uint") ? "u" : format.includes("sint") ? "i" : "f";
}

/** @return {boolean} whether WebGPU blends into the format (no integer, no 32-bit float formats) */
const blendable = format => format_kind(format) === "f" && !format.includes("32float");

/**
 * What a copy into an image of the format keeps of the source's channels
 * (GLES 3.0 table 3.15), as a matrix (columns: each source channel's
 * weights) and an offset: luminance from red, a format without alpha's
 * alpha 1; null where the channels go as they are
 * @return {?{m: !Array<number>, b: !Array<number>}}
 */
function copy_map(info)
{
    const [r, , , a] = info.bits;
    if(info.value === F.LUMINANCE) return { m: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], b: [0, 0, 0, 1] };
    if(info.value === F.ALPHA) return { m: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], b: [0, 0, 0, 0] };
    if(info.value === F.LUMINANCE_ALPHA) return { m: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], b: [0, 0, 0, 0] };
    if(r && !a && info.kind !== "int" && info.kind !== "uint") return { m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], b: [0, 0, 0, 1] };
    return null;
}

/**
 * A draw's indices as WebGPU draws them: fans as triangle lists, loops as
 * line lists, each piece between restart indices on its own (a strip's
 * restarted, a list's last primitive ended), from the lowest vertex
 * @param {!ArrayLike<number>} indices
 * @param {number} restart the restart index, -1 for none
 * @return {?{list: !Uint32Array, low: number, high: number, topology: string, strip: boolean}}
 */
function index_list(indices, mode, restart)
{
    let low = Infinity, high = -1;
    for(const v of indices) if(v !== restart) { if(v < low) low = v; if(v > high) high = v; }
    if(high < 0) return null;
    const strip = mode === 3 || mode === 5;
    const out = [];
    const piece = (from, to) =>
    {
        const n = to - from;
        const at = i => indices[from + i] - low;
        switch(mode)
        {
            case 0: case 1: case 4:
            {
                const per = mode === 0 ? 1 : mode === 1 ? 2 : 3;
                for(let i = 0; i < n - n % per; i++) out.push(at(i));
                break;
            }
            case 3: case 5:
                if(n < (mode === 3 ? 2 : 3)) break;
                if(out.length) out.push(STRIP_END);
                for(let i = 0; i < n; i++) out.push(at(i));
                break;
            case 2:
                if(n < 2) break;
                for(let i = 0; i < n; i++) out.push(at(i), at((i + 1) % n));
                break;
            case 6:
                for(let i = 1; i + 1 < n; i++) out.push(at(0), at(i), at(i + 1));
                break;
        }
    };
    let start = 0;
    for(let i = 0; i <= indices.length; i++)
    {
        if(i === indices.length || indices[i] === restart)
        {
            piece(start, i);
            start = i + 1;
        }
    }
    return { list: new Uint32Array(out), low, high, topology: TOPOLOGY[mode], strip };
}

/** GLES 3.2's PATCHES, and the vertices a patch (GL's default PATCH_VERTICES: glPatchParameteri is not on the guest's wire) */
const PATCHES = 0xE, PATCH_VERTICES = 3;

/** Vertices an input primitive of each mode (GLES 3.2 11.3.4.1: a geometry shader's input) */
const PRIMITIVE_VERTICES = { 0: 1, 1: 2, 2: 2, 3: 2, 4: 3, 5: 3, 6: 3, 0xA: 4, 0xB: 4, 0xC: 6, 0xD: 6 };

/**
 * A draw's primitives as a geometry shader takes them (GLES 3.2 10.1 and
 * table 10.1 for strips with adjacency): `per` vertices each, the adjacent
 * ones in their places; a restart index ends a strip, loop or fan
 * @param {!ArrayLike<number>} indices the draw's vertices in order
 * @param {number} restart the restart index, -1 for none
 * @return {{vertices: !Uint32Array, per: number}}
 */
function primitives_of(indices, mode, restart)
{
    const per = PRIMITIVE_VERTICES[mode];
    const out = [];
    const piece = v =>
    {
        const n = v.length;
        switch(mode)
        {
            case 0: case 1: case 4: case 0xA: case 0xC:
                for(let i = 0; i + per <= n; i += per) for(let k = 0; k < per; k++) out.push(v[i + k]);
                break;
            case 3: for(let i = 0; i + 1 < n; i++) out.push(v[i], v[i + 1]); break;
            case 2: if(n >= 2) for(let i = 0; i < n; i++) out.push(v[i], v[(i + 1) % n]); break;
            case 5: for(let i = 0; i + 2 < n; i++) i % 2 ? out.push(v[i + 1], v[i], v[i + 2]) : out.push(v[i], v[i + 1], v[i + 2]); break;
            case 6: for(let i = 1; i + 1 < n; i++) out.push(v[0], v[i], v[i + 1]); break;
            case 0xB: for(let i = 1; i + 2 < n; i++) out.push(v[i - 1], v[i], v[i + 1], v[i + 2]); break;
            case 0xD:
            {
                // (1-based as the table: the triangle's vertices and each edge's adjacent one, in the shader's order)
                const m = n >= 6 ? n - 4 >> 1 : 0;
                const at = k => v[k - 1];
                for(let i = 0; i < m; i++)
                {
                    const last = i === m - 1, even = i % 2 === 0;
                    const [a, b, c] = even ? [2 * i + 1, 2 * i + 3, 2 * i + 5] : [2 * i + 3, 2 * i + 1, 2 * i + 5];
                    const ab = i === 0 ? 2 : 2 * i - 1;
                    const bc = even ? (last ? 2 * i + 6 : 2 * i + 7) : 2 * i + 4;
                    const ca = even ? 2 * i + 4 : (last ? 2 * i + 6 : 2 * i + 7);
                    out.push(at(a), at(ab), at(b), at(bc), at(c), at(ca));
                }
                break;
            }
        }
    };
    let start = 0;
    for(let i = 0; i <= indices.length; i++)
    {
        if(i === indices.length || indices[i] === restart)
        {
            piece(Array.prototype.slice.call(indices, start, i));
            start = i + 1;
        }
    }
    return { vertices: new Uint32Array(out), per };
}

/**
 * A vertex shader's WGSL with its outputs' interpolation the fragment
 * inputs' at their locations: WebGPU wants them the same, GLSL ES 3.10
 * lets centroid and sample differ between the stages
 */
function matched_interpolation(vertex_wgsl, inputs)
{
    // (the output struct's members: lines of their own; the entry point's inputs are on its line)
    return vertex_wgsl.replace(/^(\s+@location\((\d+)\)\s*)(?:@interpolate\([^)]*\)\s*)?/gm,
        (all, head, location) => inputs.has(+location) ? head + (inputs.get(+location) ? inputs.get(+location) + " " : "") : all);
}

/** A fragment entry point's inputs: location to their attributes (interpolation) */
function fragment_inputs(wgsl)
{
    const inputs = new Map();
    const at = wgsl.indexOf("@fragment");
    const signature = at < 0 ? null : /\(([^{]*)\)\s*(?:->[^{]*)?\{/.exec(wgsl.slice(at));
    for(const m of signature ? signature[1].matchAll(/@location\((\d+)\)\s*((?:@\w+(?:\([^)]*\))?\s*)*)\w+\s*:/g) : [])
    {
        inputs.set(+m[1], m[2].trim());
    }
    return inputs;
}

export const GLES3 = {
    // ---- vx_naga

    /** vx_naga.wasm, fetched once (a batch with a program link waits for it) */
    async load_naga()
    {
        if(this.naga) return this.naga;
        this.naga_loading = this.naga_loading || (async () =>
        {
            const response = await fetch(this.naga_url || globalThis["V86VenusNagaUrl"] || NAGA_URL);
            if(!response.ok) throw new Error("vx_naga.wasm: " + response.status);
            const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
            this.naga = instance.exports;
        })();
        await this.naga_loading;
        return this.naga;
    },

    /** SPIR-V words as vx_naga's answer: {wgsl, entries, intsamples} or {error} */
    translate_spirv(words, flags, wraps)
    {
        const naga = this.naga;
        const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
        const input = naga.vx_alloc(bytes.length);
        new Uint8Array(naga.memory.buffer, input, bytes.length).set(bytes);
        const list = wraps.length ? naga.vx_alloc(wraps.length * 8) : 0;
        if(list) new Uint32Array(naga.memory.buffer, list, wraps.length * 2).set(wraps.flat());
        let out;
        try
        {
            out = naga.vx_translate(input, bytes.length, 1, 0, flags, 0, 0, list, wraps.length);
        }
        finally
        {
            naga.vx_free(input, bytes.length);
            if(list) naga.vx_free(list, wraps.length * 8);
        }
        const length = new DataView(naga.memory.buffer).getUint32(out, true);
        const json = new TextDecoder().decode(new Uint8Array(naga.memory.buffer, out + 4, length));
        naga.vx_free(out, length + 4);
        return JSON.parse(json);
    },

    /** A note of what a draw could not do (the stats' `gles3`: each kind counted) */
    note3(what)
    {
        const notes = this.stats.gles3 = this.stats.gles3 || {};
        notes[what] = (notes[what] || 0) + 1;
        return null;
    },

    /** The program's GPU side (its `gpu`, which snapshots leave out): made again after each link */
    program_gpu(program)
    {
        if(!program.gpu || program.gpu.info !== program.info)
        {
            program.gpu = { info: program.info, translations: new Map(), shaders: new Map(), inputs: null, uniforms: null };
        }
        return program.gpu;
    },

    translation3(program, index, flags, wraps)
    {
        const gpu = this.program_gpu(program);
        const key = index + ":" + flags + ":" + wraps.flat().join(",");
        let t = gpu.translations.get(key);
        if(!t)
        {
            // (the stats' translations and their time: vx_naga's work, cached by the program, stage, flags and wraps)
            const start = performance.now();
            t = this.translate_spirv(program.info.spirv[index].words, flags, wraps);
            this.stats.translations = (this.stats.translations || 0) + 1;
            this.stats.translate_ms = (this.stats.translate_ms || 0) + performance.now() - start;
            gpu.translations.set(key, t);
        }
        return t;
    },

    /** A shader module of WGSL (cached by its code) */
    module3(code)
    {
        let m = this.shaders.get(code);
        if(!m) this.shaders.set(code, m = this.device.createShaderModule({ label: "GLES 3 program", code: "diagnostic(off, derivative_uniformity);\n" + code }));
        return m;
    },

    /**
     * The programs of a draw's stages: the current program for both, or the
     * bound pipeline's (GLES 3.1's separable programs), or null
     * @return {?{vertex: !Object, fragment: !Object}}
     */
    stages3(c)
    {
        const ok = p => p && p.kind === "program" && p.info && p.info.ok && p.info.spirv ? p : null;
        if(c.program) return ok(c.group.objects.get(c.program)) && { vertex: c.group.objects.get(c.program), fragment: c.group.objects.get(c.program) };
        const pipeline = c.program_pipelines && c.program_pipelines.get(c.program_pipeline);
        if(!pipeline) return null;
        const vertex = ok(c.group.objects.get(pipeline.stages[1])), fragment = ok(c.group.objects.get(pipeline.stages[2]));
        return vertex && fragment ? { vertex, fragment } : null;
    },

    /**
     * The bindings translations use: by group and binding, with their WGSL
     * types, the stages that see them (`visibility`) and the program whose
     * state they bind
     * @param {!Array<!Array<*>>} list [translation, visibility, program]
     */
    bindings3(list)
    {
        const bindings = new Map();
        for(const [t, visibility, program] of list)
        {
            const declarations = wgsl_declarations(t.wgsl);
            for(const [group, binding, kind, size] of t.entries[0].bindings)
            {
                const key = group + ":" + binding;
                const b = bindings.get(key) || { group, binding, kind, size: 0, visibility: 0, type: declarations.get(key), program };
                b.size = Math.max(b.size, size);
                b.visibility |= visibility;
                bindings.set(key, b);
            }
        }
        return [...bindings.values()].sort((a, b) => a.group - b.group || a.binding - b.binding);
    },

    /**
     * The shader modules of a draw's stages (one program's, or a pipeline's):
     * the fragment depth output kept only with a depth attachment, integer
     * textures fetched by their samplers' wraps
     * @param {{vertex: !Object, fragment: !Object}} stages stages3's
     * @return {?{vertex: !Object, fragment: !Object, bindings: !Array<!Object>, outputs: !Map<number, string>, id: string}}
     */
    program3(c, stages, target)
    {
        if(!this.naga) return this.note3("vx_naga not loaded");
        const v = stages.vertex.info.spirv.findIndex(m => m.stage === "vertex"), f = stages.fragment.info.spirv.findIndex(m => m.stage === "fragment");
        if(v < 0 || f < 0) return this.note3("a program without a vertex or fragment shader");
        const fragment_flags = target.depth ? 0 : NO_DEPTH;
        const translate = (vw, fw) => [this.translation3(stages.vertex, v, GL_DEPTH, vw), this.translation3(stages.fragment, f, fragment_flags, fw)];
        // (the samplers that clamp to the border: their axes and colors, the translations' constants)
        const borders = [this.border_wraps3(c, stages.vertex, 0), this.border_wraps3(c, stages.fragment, stages.fragment.separable ? 1 : 0)];
        let ts = translate(borders[0], borders[1]);
        const failed = ts.find(t => t.error);
        if(failed) return this.note3("vx_naga: " + failed.error.slice(0, 160));
        const wraps = ts.map((t, i) => t.intsamples && t.intsamples.length ? this.int_wraps3(c, i ? stages.fragment : stages.vertex, t.intsamples) : []);
        const gpu = this.program_gpu(stages.vertex);
        const key = this.id_of(stages.fragment) + ":" + fragment_flags + ":" + wraps.concat(borders).map(w => w.flat().join(",")).join("/");
        let shaders = gpu.shaders.get(key);
        if(shaders) return shaders;
        if(wraps.some(w => w.length)) ts = translate(wraps[0].concat(borders[0]), wraps[1].concat(borders[1]));
        if(ts.some(t => t.error)) return this.note3("vx_naga: " + ts.find(t => t.error).error.slice(0, 160));
        shaders = {
            vertex: { module: this.module3(matched_interpolation(ts[0].wgsl, fragment_inputs(ts[1].wgsl))), entry: ts[0].entries[0].name },
            // (flat inputs: draws reorder their primitives for GL's provoking vertex, draw3)
            flat: [...fragment_inputs(ts[1].wgsl).values()].some(i => /\bflat\b/.test(i)),
            fragment: { module: this.module3(ts[1].wgsl), entry: ts[1].entries[0].name, wgsl: ts[1].wgsl,
                // (the sample count, specialization constant 71: glsl_es_rewrite.js's sample functions)
                samples_constant: (ts[1].overrides || []).some(o => o[0] === SAMPLES_CONSTANT),
                blend_constant: (ts[1].overrides || []).some(o => o[0] === BLEND_CONSTANT) },
            bindings: this.bindings3([[ts[0], 1, stages.vertex], [ts[1], 2, stages.fragment]]),
            outputs: fragment_outputs(ts[1].wgsl),
        };
        shaders.id = this.id_of(shaders.vertex.module) + ":" + this.id_of(shaders.fragment.module);
        gpu.shaders.set(key, shaders);
        return shaders;
    },

    /** The vertex shader's inputs: location, kind ("f", "i", "u") and components, matrices by column */
    inputs3(program)
    {
        const gpu = this.program_gpu(program);
        if(gpu.inputs) return gpu.inputs;
        const inputs = [];
        for(const a of program.info.attributes)
        {
            if(a.location < 0) continue;
            const t = gl_type(a.type);
            const kind = t.base === "int" ? "i" : t.base === "uint" ? "u" : "f";
            const columns = t.columns || 1, components = t.columns ? t.rows : t.components;
            for(let e = 0; e < a.size; e++)
            {
                for(let k = 0; k < columns; k++) inputs.push({ location: a.location + e * columns + k, kind, components });
            }
        }
        // (the inputs GL does not list, unused: (0, 0, 0, 1) at the locations the link gave them)
        for(const u of program.info.unused_inputs || []) inputs.push(Object.assign({ unused: true }, u));
        return gpu.inputs = inputs;
    },

    // ---- buffers

    /**
     * A GL buffer's GPU buffer, the CPU side's changes copied in first
     * @param {number=} minimum the bytes it holds at least (a binding's
     *     least size past the GL buffer's end)
     */
    gpu_buffer(buffer, minimum = 0)
    {
        const size = Math.max(16, Math.ceil(Math.max(buffer.size, minimum) / 16) * 16);
        let gpu = buffer.gpu;
        if(!gpu || gpu.size < size)
        {
            const created = this.device.createBuffer({ label: "GL buffer", size,
                usage: B.VERTEX | B.INDEX | B.UNIFORM | B.STORAGE | B.COPY_SRC | B.COPY_DST | B.INDIRECT });
            if(gpu)
            {
                if(buffer.gpu_newer)
                {
                    this.end_pass();
                    this.encoder.copyBufferToBuffer(gpu.buffer, 0, created, 0, gpu.size);
                }
                this.staging.push(gpu.buffer);
            }
            // (a first GPU buffer starts as the CPU side's bytes: nothing on the GPU is newer yet)
            if(!gpu || !buffer.gpu_newer) buffer.dirty = [0, buffer.size];
            buffer.gpu = gpu = { buffer: created, size, destroy: () => created.destroy() };
        }
        if(buffer.dirty)
        {
            const [low, high] = buffer.dirty;
            buffer.dirty = null;
            const bytes = cpu_bytes(buffer);
            if(bytes && high > low) this.write_gpu_buffer(gpu.buffer, low, high - low, bytes, low, buffer.size);
        }
        return gpu;
    },

    /**
     * Bytes into a GPU buffer, in order with the draws (a staging buffer
     * copied in the encoder); the range widened to whole words from
     * `source`, and past the GL buffer's end (a size not a whole number of
     * words: a 6-byte index buffer) with zeros
     * @param {!Uint8Array} source holds the bytes, `at` the first's index
     * @param {number} end the GL buffer's size
     */
    write_gpu_buffer(target, offset, length, source, at, end)
    {
        const low = offset & ~3, high = align4(offset + length);
        const before = offset - low, after = offset + length >= end ? 0 : high - offset - length;
        if(at - before < 0 || at + length + after > source.length) return this.note3("an unaligned buffer write");
        this.end_pass();
        const staging = this.device.createBuffer({ label: "GLES buffer upload", size: Math.max(4, high - low), usage: B.COPY_SRC, mappedAtCreation: true });
        new Uint8Array(staging.getMappedRange()).set(source.subarray(at - before, at + length + after));
        staging.unmap();
        this.encoder.copyBufferToBuffer(staging, 0, target, low, high - low);
        this.staging.push(staging);
        return undefined;
    },

    /**
     * The guest wrote `length` bytes of a buffer at `offset` (`data`: them):
     * the CPU side's copy has them, the GPU buffer gets them before its next
     * use, or now if the GPU's copy is the newer one
     */
    buffer_written(buffer, offset, length, data)
    {
        if(!buffer || length <= 0) return;
        if(buffer.gpu_newer)
        {
            const gpu = this.gpu_buffer(buffer);
            if(data) this.write_gpu_buffer(gpu.buffer, offset, length, data, 0, buffer.size);
            return;
        }
        if(!buffer.gpu) return;
        buffer.dirty = buffer.dirty ? [Math.min(buffer.dirty[0], offset), Math.max(buffer.dirty[1], offset + length)] : [offset, offset + length];
    },

    /** The buffer bound to a target (GLES 3.0's targets and 3.1's) */
    buffer_of3(c, target)
    {
        const which = { 0x8892: "array", 0x8893: "element", 0x8F36: "copy_read", 0x8F37: "copy_write", 0x88EB: "pixel_pack", 0x88EC: "pixel_unpack",
            0x8C8E: "transform_feedback", 0x8A11: "uniform", 0x90D2: "shader_storage", 0x92C0: "atomic_counter", 0x90EE: "dispatch_indirect",
            0x8F3F: "draw_indirect" }[target];
        const name = which === "array" ? c.array_buffer : which === "element" ? c.element_array_buffer : which ? c.buffers[which] : 0;
        return name ? c.group.buffers.get(name) || null : null;
    },

    /** A zero buffer of at least `size` bytes (what an unbound uniform block reads) */
    zeros3(size)
    {
        size = Math.max(256, Math.ceil(size / 256) * 256);
        if(!this.zero_buffer || this.zero_buffer.size < size)
        {
            if(this.zero_buffer) this.staging.push(this.zero_buffer);
            this.zero_buffer = this.device.createBuffer({ label: "GLES zeros", size, usage: B.UNIFORM | B.STORAGE | B.VERTEX });
        }
        return this.zero_buffer;
    },

    /**
     * A buffer of at least `size` bytes that writes go to and nothing reads
     * (an unbound storage block's or atomic counters'), one of its own each:
     * WebGPU refuses two writable bindings of one buffer's range
     */
    discard3(size)
    {
        const buffer = this.device.createBuffer({ label: "GLES discarded writes", size: Math.max(16, align4(size)), usage: B.STORAGE });
        this.staging.push(buffer);
        return buffer;
    },

    // ---- textures

    /**
     * A texture's GPU texture: its format's, as large as the lowest level
     * given (GPU level 0 is that GL level, `first`) with a full chain (an
     * immutable texture's levels); made again when those change, the levels
     * that still fit copied over
     */
    gpu_texture3(texture)
    {
        const cube = texture.target === GL3.TEXTURE_CUBE_MAP, three = texture.target === GL3.TEXTURE_3D;
        // (GLES 3.2's cube map arrays: their layer-faces a 2D array's layers)
        const array = texture.target === GL3.TEXTURE_2D_ARRAY || texture.target === 0x9009;
        let first = -1, base = null;
        for(let level = 0; level < 32 && !base; level++)
        {
            for(let face = 0; face < (cube ? 6 : 1) && !base; face++)
            {
                const image = texture.images.get(face * 32 + level);
                if(image && image.width && image.height) { first = level; base = image; }
            }
        }
        if(!base) return null;
        const internal = image_internal(base);
        const compressed = COMPRESSED_FORMATS.get(internal);
        const info = format_info(internal);
        const width = base.width, height = base.height;
        const feature = compressed && this.device.features && this.device.features.has(compressed.astc ? "texture-compression-astc" : "texture-compression-etc2");
        // (WebGPU's compressed textures are whole blocks: one of another size is its blocks decoded by the GPU, decode_compressed3)
        const whole = compressed && width % compressed.block_width === 0 && height % compressed.block_height === 0;
        const native = feature && whole;
        const decoded = feature && !whole ? decoded_format(compressed) : null;
        const format = compressed ? (native ? compressed.webgpu : decoded || COLOR_FORMAT) : info ? info.webgpu : COLOR_FORMAT;
        const depth = three || array ? Math.max(1, base.depth || 1) : cube ? 6 : 1;
        const largest = Math.max(width, height, three ? depth : 1);
        const levels = texture.immutable ? Math.max(1, texture.immutable_levels - first) : Math.floor(Math.log2(largest)) + 1;
        // (GLES 3.1: a multisampled texture's 4 samples; an immutable texture of a storage format is an image's too)
        const samples = base.samples > 1 ? 4 : 1;
        const storage = samples === 1 && !!texture.immutable && STORAGE_FORMATS.has(format);
        const old = texture.gpu;
        if(old && old.es3 && old.format === format && old.width === width && old.height === height && old.depth === depth && old.first === first &&
            old.levels >= levels && old.samples === samples && old.storage === storage)
        {
            return old;
        }
        const usage = U.TEXTURE_BINDING | (samples > 1 ? 0 : U.COPY_DST | U.COPY_SRC) | (RENDERABLE.has(format) ? U.RENDER_ATTACHMENT : 0) |
            (storage ? U.STORAGE_BINDING : 0);
        const created = this.device.createTexture({ label: "GL texture", size: [width, height, depth], dimension: three ? "3d" : "2d", format,
            mipLevelCount: samples > 1 ? 1 : levels, sampleCount: samples, usage });
        if(RENDERABLE.has(format) && alpha_less(internal, format)) this.alpha_one3(created, samples > 1 ? 1 : levels, depth, three);
        const gpu = { es3: true, texture: created, format, width, height, depth, first, levels: samples > 1 ? 1 : levels, three, cube, array, samples,
            storage, views: new Map(), block: native ? compressed.block_width : 1, block_height: native ? compressed.block_height : 1,
            block_bytes: native ? compressed.block_bytes : 0, decode: decoded ? compressed : null, proxies: null,
            destroy: () => { created.destroy(); for(const proxy of gpu.proxies ? gpu.proxies.values() : []) proxy.texture.destroy(); } };
        if(old && old.texture)
        {
            // (the levels that keep their size: a level given below the others, a chain made longer)
            if(old.es3 && old.format === format && !DRAWN_DEPTH.has(format) && format !== "stencil8" && samples === 1 && old.samples === 1)
            {
                this.end_pass();
                for(let mip = 0; mip < old.levels; mip++)
                {
                    const to = mip + old.first - first;
                    const w = Math.max(1, old.width >> mip), h = Math.max(1, old.height >> mip);
                    if(to < 0 || to >= levels || Math.max(1, width >> to) !== w || Math.max(1, height >> to) !== h) continue;
                    const d = old.three ? Math.max(1, old.depth >> mip) : old.depth;
                    if(d !== (three ? Math.max(1, depth >> to) : depth)) continue;
                    if(gpu.block > 1 && (w % gpu.block || h % gpu.block_height)) continue;
                    this.encoder.copyTextureToTexture({ texture: old.texture, mipLevel: mip }, { texture: created, mipLevel: to }, [w, h, d]);
                }
            }
            this.staging.push(old.texture);
        }
        texture.gpu = gpu;
        return gpu;
    },

    /**
     * Texels into a level of a GPU texture, in order with the draws:
     * `origin` and `size` in texels (x, y, and the layer, face or slice)
     * @return {boolean} whether the level is there to write
     */
    upload3(gpu, level, origin, size, texels)
    {
        const mip = level - gpu.first;
        if(mip < 0 || mip >= gpu.levels) return false;
        const mip_width = Math.max(1, gpu.width >> mip), mip_height = Math.max(1, gpu.height >> mip);
        const mip_depth = gpu.three ? Math.max(1, gpu.depth >> mip) : gpu.depth;
        const [x, y, z] = origin, [w, h, d] = size;
        if(x + w > mip_width || y + h > mip_height || z + d > mip_depth || !w || !h || !d) return false;
        const block = gpu.block, block_height = gpu.block_height || 1;
        const texel = block > 1 ? gpu.block_bytes : TEXEL_BYTES[gpu.format];
        const columns = Math.ceil(w / block), rows = Math.ceil(h / block_height);
        const row = columns * texel, stride = Math.ceil(row / 256) * 256;
        this.end_pass();
        const staging = this.device.createBuffer({ label: "GLES upload", size: Math.max(4, stride * rows * d), usage: B.COPY_SRC, mappedAtCreation: true });
        const mapped = new Uint8Array(staging.getMappedRange());
        for(let k = 0; k < rows * d; k++)
        {
            const from = k * row;
            if(from >= texels.length) break;
            mapped.set(texels.subarray(from, Math.min(texels.length, from + row)), k * stride);
        }
        staging.unmap();
        this.encoder.copyBufferToTexture({ buffer: staging, bytesPerRow: stride, rowsPerImage: rows },
            { texture: gpu.texture, mipLevel: mip, origin: [x, y, z] }, [columns * block, rows * block_height, d]);
        this.staging.push(staging);
        this.stats.uploads++;
        return true;
    },

    /** The texture bound to a target of the active unit, the face of a cube face's target */
    bound3(c, target)
    {
        const face = target >= 0x8515 && target <= 0x851A ? target - 0x8515 : 0;
        const slot_target = face || target === 0x8515 ? GL3.TEXTURE_CUBE_MAP : target;
        const slot = SLOT_TARGET.indexOf(slot_target);
        if(slot < 0) return { texture: null, face };
        const name = c.textures[c.active_texture][slot];
        return { texture: name ? c.group.textures.get(name) : c.defaults && c.defaults.get(slot_target), face };
    },

    /** glTexImage2D/3D, glTexSubImage2D/3D and their Offset forms (the data from the pixel unpack buffer) */
    tex_image3(c, name, args)
    {
        const three = name.includes("3D"), sub = name.includes("Sub");
        let target, level, x = 0, y = 0, z = 0, width, height, depth = 1, format, type, data;
        if(sub && three) [target, level, x, y, z, width, height, depth, format, type, data] = args;
        else if(sub) [target, level, x, y, width, height, format, type, data] = args;
        else if(three) [target, level, , width, height, depth, , format, type, data] = args;
        else [target, level, , width, height, , format, type, data] = args;
        const { texture, face } = this.bound3(c, target);
        if(!texture || !width || !height || !depth) return;
        const image = texture.images.get((three ? 0 : face) * 32 + level);
        if(!image) return;
        const base = texture.images.get(0);
        if(!three && base && (base.image || base.color_buffer))
        {
            // (an EGL image's: the writes go to its color buffer, GLES 2.0's way)
            if(typeof data !== "number") this.tex_image(c, args, sub);
            return;
        }
        const gpu = this.gpu_texture3(texture);
        if(!gpu) return;
        if(typeof data === "number")
        {
            const pbo = c.group.buffers.get(c.buffers.pixel_unpack);
            if(!pbo || pbo.gpu_newer) return void this.note3("an unpack buffer the GPU wrote");
            data = cpu_bytes(pbo) && cpu_bytes(pbo).subarray(data);
        }
        if(!data) return;
        const info = format_info(image_internal(image));
        if(!info) return;
        const unpack = c.unpack || NO_STORE;
        const store = { alignment: c.unpack_alignment, row_length: unpack.row_length, image_height: unpack.image_height,
            skip_pixels: unpack.skip_pixels, skip_rows: unpack.skip_rows, skip_images: unpack.skip_images };
        const tight = unpack_image(data, width, height, depth, format, type, store, three);
        const texels = to_texels(tight, width * height * depth, format, type, info);
        if(!texels) return void this.depth_image3(gpu, level, [x, y, three ? z : face], [width, height, depth],
            depth_values(tight, width * height * depth, format, type));
        if(!this.upload3(gpu, level, [x, y, three ? z : face], [width, height, depth], texels)) this.note3("an image of a level the texture lacks");
    },

    /** glCompressedTexImage2D/3D, glCompressedTexSubImage2D/3D (and Offset forms) */
    compressed_image3(c, name, args)
    {
        const three = name.includes("3D"), sub = name.includes("Sub");
        let target, level, x = 0, y = 0, z = 0, width, height, depth = 1, data;
        if(sub && three) [target, level, x, y, z, width, height, depth, , , data] = args;
        else if(sub) [target, level, x, y, width, height, , , data] = args;
        else if(three) [target, level, , width, height, depth, , , data] = args;
        else [target, level, , width, height, , , data] = args;
        const { texture, face } = this.bound3(c, target);
        const gpu = texture && this.gpu_texture3(texture);
        if(!gpu) return;
        if(typeof data === "number")
        {
            const pbo = c.group.buffers.get(c.buffers.pixel_unpack);
            data = pbo && !pbo.gpu_newer && cpu_bytes(pbo) ? cpu_bytes(pbo).subarray(data) : null;
        }
        if(!data) return;
        const image = texture.images.get((three ? 0 : face) * 32 + level);
        const internal = image ? image_internal(image) : 0;
        const layer = three ? z : face;
        if(gpu.block > 1)
        {
            this.upload3(gpu, level, [x, y, layer], [width, height, depth], data);
            return;
        }
        if(gpu.decode)
        {
            const blocks = Math.ceil(width / gpu.decode.block_width) * Math.ceil(height / gpu.decode.block_height) * gpu.decode.block_bytes;
            for(let k = 0; k < depth; k++) this.decode_compressed3(gpu, level, [x, y, layer + k], [width, height], data.subarray(k * blocks, (k + 1) * blocks));
            return;
        }
        // (without WebGPU's ETC2: ETC1's blocks decoded; the others' not yet, nor ASTC without its feature)
        if(internal !== 0x8D64 && internal !== 0x9274) return void this.note3("ETC2/EAC or ASTC without WebGPU's compression feature");
        const blocks = Math.ceil(width / 4) * Math.ceil(height / 4) * 8;
        for(let k = 0; k < depth; k++)
        {
            this.upload3(gpu, level, [x, y, layer + k], [width, height, 1], decode_etc1(width, height, data.subarray(k * blocks, (k + 1) * blocks)));
        }
    },

    /** glCopyTexImage2D, glCopyTexSubImage2D/3D: from the read framebuffer's read buffer, of the same format */
    copy_tex_image3(c, name, args)
    {
        let target, level, xoffset = 0, yoffset = 0, zoffset = 0, x, y, width, height;
        if(name === "glCopyTexImage2D") [target, level, , x, y, width, height] = args;
        else if(name === "glCopyTexSubImage2D") [target, level, xoffset, yoffset, x, y, width, height] = args;
        else [target, level, xoffset, yoffset, zoffset, x, y, width, height] = args;
        const { texture, face } = this.bound3(c, target);
        const gpu = texture && this.gpu_texture3(texture);
        const source = this.read_target3(c);
        if(!gpu || !source || source.texture === gpu.texture) return;
        const mip = level - gpu.first;
        if(mip < 0 || mip >= gpu.levels || source.samples > 1) return;
        const sx = Math.max(0, x), sy = Math.max(0, y);
        const w = Math.min(width - (sx - x), source.width - sx), h = Math.min(height - (sy - y), source.height - sy);
        if(w <= 0 || h <= 0) return;
        const layer = gpu.three || gpu.array ? zoffset : face;
        const [dx, dy] = [xoffset + sx - x, yoffset + sy - y];
        // (the level's own format: what GLES 3.0 table 3.15 keeps of the source's channels)
        const image = texture.images.get((gpu.three || gpu.array ? 0 : face) * 32 + level);
        const info = image && format_info(image_internal(image));
        const map = info && copy_map(info);
        const no_alpha = !!image && alpha_less(image_internal(image), gpu.format);
        if(!map && source.format === gpu.format && (!no_alpha || source.no_alpha))
        {
            this.end_pass();
            this.encoder.copyTextureToTexture({ texture: source.texture, mipLevel: source.mip, origin: [sx, sy, source.layer] },
                { texture: gpu.texture, mipLevel: mip, origin: [dx, dy, layer] }, [w, h, 1]);
            return;
        }
        if(!RENDERABLE.has(gpu.format)) return void this.note3("a copy into a texture WebGPU draws no " + gpu.format + " to");
        const view = gpu.three ? gpu.texture.createView({ dimension: "3d", baseMipLevel: mip, mipLevelCount: 1 }) :
            gpu.texture.createView({ dimension: "2d", baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
        const dest = { texture: gpu.texture, view, format: gpu.format, mip, layer, depth_slice: gpu.three ? layer : undefined, no_alpha };
        this.blit3(source, dest, { src: [sx, sy, sx + w, sy + h], dst: [dx, dy, dx + w, dy + h], rect: [dx, dy, w, h], linear: false, map }, false);
    },

    /** glGenerateMipmap: each level drawn from the one before (2D, cube and array textures) */
    generate_mipmap3(c, target)
    {
        const { texture } = this.bound3(c, target);
        const gpu = texture && this.gpu_texture3(texture);
        if(!gpu) return;
        if(!RENDERABLE.has(gpu.format) || format_kind(gpu.format) !== "f" || gpu.format.includes("32float")) return void this.note3("glGenerateMipmap of that format");
        const base = Math.max(0, (texture.base_level || 0) - gpu.first);
        if(gpu.three)
        {
            for(let mip = base + 1; mip < gpu.levels; mip++) this.downsample3d(gpu, mip);
            return;
        }
        for(let layer = 0; layer < gpu.depth; layer++)
        {
            for(let mip = base + 1; mip < gpu.levels; mip++)
            {
                const view = m => gpu.texture.createView({ dimension: "2d", baseMipLevel: m, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
                this.downsample3(view(mip - 1), view(mip), gpu.format);
            }
        }
    },

    /** A full-size draw of one view into another of the format (filtered linearly) */
    downsample3(source, target, format)
    {
        this.blits3 = this.blits3 || new Map();
        let blit = this.blits3.get(format);
        if(!blit)
        {
            const module = this.device.createShaderModule({ code: `
                struct VOut { @builtin(position) p : vec4<f32>, @location(0) uv : vec2<f32> };
                @group(0) @binding(0) var t : texture_2d<f32>;
                @group(0) @binding(1) var s : sampler;
                @vertex fn vs(@builtin(vertex_index) i : u32) -> VOut {
                    let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
                    var o : VOut;
                    o.p = vec4<f32>(p[i], 0.0, 1.0);
                    o.uv = vec2<f32>(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
                    return o;
                }
                @fragment fn fs(i : VOut) -> @location(0) vec4<f32> { return textureSampleLevel(t, s, i.uv, 0.0); }` });
            blit = { pipeline: this.device.createRenderPipeline({ label: "GLES 3 blit", layout: "auto", vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } }),
            sampler: this.device.createSampler({ magFilter: "linear", minFilter: "linear" }) };
            this.blits3.set(format, blit);
        }
        this.end_pass();
        const pass = this.encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
        pass.setPipeline(blit.pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: blit.pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: source }, { binding: 1, resource: blit.sampler }] }));
        pass.draw(3);
        pass.end();
    },

    /** A 3D texture's level drawn from the one before, a slice at a time (linear filtering: each texel the mean of eight) */
    downsample3d(gpu, mip)
    {
        const key = "downsample3d:" + gpu.format;
        this.blits3 = this.blits3 || new Map();
        let blit = this.blits3.get(key);
        if(!blit)
        {
            const module = this.device.createShaderModule({ code: `
                @group(0) @binding(0) var t : texture_3d<f32>;
                @group(0) @binding(1) var s : sampler;
                @group(0) @binding(2) var<uniform> p : vec4<f32>;
                @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
                    let v = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
                    return vec4<f32>(v[i], 0.0, 1.0);
                }
                @fragment fn fs(@builtin(position) q : vec4<f32>) -> @location(0) vec4<f32> {
                    return textureSampleLevel(t, s, vec3<f32>(q.xy / p.xy, p.z), 0.0);
                }` });
            blit = { pipeline: this.device.createRenderPipeline({ label: "GLES 3 3D mipmap", layout: "auto", vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: [{ format: gpu.format }] }, primitive: { topology: "triangle-list" } }),
            sampler: this.device.createSampler({ magFilter: "linear", minFilter: "linear" }) };
            this.blits3.set(key, blit);
        }
        const w = Math.max(1, gpu.width >> mip), h = Math.max(1, gpu.height >> mip), d = Math.max(1, gpu.depth >> mip);
        const source = gpu.texture.createView({ dimension: "3d", baseMipLevel: mip - 1, mipLevelCount: 1 });
        const target = gpu.texture.createView({ dimension: "3d", baseMipLevel: mip, mipLevelCount: 1 });
        this.end_pass();
        for(let z = 0; z < d; z++)
        {
            const pass = this.encoder.beginRenderPass({ colorAttachments: [{ view: target, depthSlice: z, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 },
                storeOp: "store" }] });
            pass.setPipeline(blit.pipeline);
            pass.setBindGroup(0, this.device.createBindGroup({ layout: blit.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source },
                { binding: 1, resource: blit.sampler }, { binding: 2, resource: { buffer: this.uniform_buffer(new Float32Array([w, h, (z + 0.5) / d, 0]).buffer) } }] }));
            pass.draw(3);
            pass.end();
        }
    },

    /**
     * A depth image's values written by a draw (WebGPU copies no buffer into
     * depth24plus or depth32float): the depths as an r32float texture, each
     * layer drawn with frag_depth; the stencil values copied into the
     * stencil aspect (WebGPU copies into stencil8's)
     */
    depth_image3(gpu, level, origin, size, values)
    {
        const mip = level - gpu.first;
        if(mip < 0 || mip >= gpu.levels) return;
        const [x, y, z] = origin, [w, h, d] = size;
        const source = this.device.createTexture({ label: "GLES depth image", size: [w, h, d], format: "r32float", usage: U.TEXTURE_BINDING | U.COPY_DST });
        this.device.queue.writeTexture({ texture: source }, values.depth, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h, d]);
        this.staging.push(source);
        const key = "depth_image:" + gpu.format;
        this.blits3 = this.blits3 || new Map();
        let blit = this.blits3.get(key);
        if(!blit)
        {
            const module = this.device.createShaderModule({ code: `
                @group(0) @binding(0) var t : texture_2d_array<f32>;
                @group(0) @binding(1) var<uniform> p : vec4<i32>;
                @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
                    let v = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
                    return vec4<f32>(v[i], 0.0, 1.0);
                }
                @fragment fn fs(@builtin(position) q : vec4<f32>) -> @builtin(frag_depth) f32 {
                    return textureLoad(t, vec2<i32>(q.xy) - p.xy, p.z, 0).x;
                }` });
            const group = this.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 2, texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },
                { binding: 1, visibility: 2, buffer: { type: "uniform" } }] });
            blit = { group, pipeline: this.device.createRenderPipeline({ label: "GLES 3 depth image", layout: this.device.createPipelineLayout({ bindGroupLayouts: [group] }),
                vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [] }, primitive: { topology: "triangle-list" },
                depthStencil: { format: gpu.format, depthWriteEnabled: true, depthCompare: "always" } }) };
            this.blits3.set(key, blit);
        }
        const stencil = gpu.format.includes("stencil");
        this.end_pass();
        for(let k = 0; k < d; k++)
        {
            const view = gpu.texture.createView({ dimension: "2d", baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: z + k, arrayLayerCount: 1 });
            const pass = this.encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: Object.assign({ view, depthLoadOp: "load", depthStoreOp: "store" },
                stencil ? { stencilLoadOp: "load", stencilStoreOp: "store" } : {}) });
            pass.setPipeline(blit.pipeline);
            pass.setBindGroup(0, this.device.createBindGroup({ layout: blit.group, entries: [{ binding: 0, resource: source.createView({ dimension: "2d-array" }) },
                { binding: 1, resource: { buffer: this.uniform_buffer(new Int32Array([x, y, k, 0]).buffer) } }] }));
            pass.setScissorRect(x, y, w, h);
            pass.draw(3);
            pass.end();
        }
        if(stencil && values.stencil) this.stencil_image3(gpu, mip, origin, size, values.stencil);
    },

    /**
     * Stencil values into a rectangle of a depth stencil texture's level:
     * WebGPU copies the stencil aspect of whole levels (layers) only, so a
     * rectangle of less goes through a buffer of the levels' stencil, the
     * rectangle's bytes set in it by a compute pass, copied back whole
     */
    stencil_image3(gpu, mip, origin, size, stencil)
    {
        const [x, y, z] = origin, [w, h, d] = size;
        const width = Math.max(1, gpu.width >> mip), height = Math.max(1, gpu.height >> mip);
        const whole = x === 0 && y === 0 && w === width && h === height;
        const stride = Math.ceil((whole ? w : width) / 256) * 256;
        const rows = whole ? h : height;
        const level = { texture: gpu.texture, mipLevel: mip, origin: [0, 0, z], aspect: "stencil-only" };
        if(whole)
        {
            const staging = this.device.createBuffer({ label: "GLES stencil upload", size: stride * h * d, usage: B.COPY_SRC, mappedAtCreation: true });
            const mapped = new Uint8Array(staging.getMappedRange());
            for(let k = 0; k < h * d; k++) mapped.set(stencil.subarray(k * w, k * w + w), k * stride);
            staging.unmap();
            this.staging.push(staging);
            this.encoder.copyBufferToTexture({ buffer: staging, bytesPerRow: stride, rowsPerImage: h }, level, [w, h, d]);
            return;
        }
        const levels = this.device.createBuffer({ label: "GLES stencil levels", size: stride * rows * d, usage: B.STORAGE | B.COPY_SRC | B.COPY_DST });
        const values = this.device.createBuffer({ label: "GLES stencil values", size: Math.max(16, align4(w * h * d)), usage: B.STORAGE, mappedAtCreation: true });
        new Uint8Array(values.getMappedRange()).set(stencil.subarray(0, w * h * d));
        values.unmap();
        this.staging.push(levels, values);
        if(!this.stencil_patch3)
        {
            const module = this.device.createShaderModule({ code: `
                @group(0) @binding(0) var<storage, read_write> levels : array<u32>;
                @group(0) @binding(1) var<storage, read> values : array<u32>;
                @group(0) @binding(2) var<uniform> p : array<vec4<u32>, 2>;
                @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id : vec3<u32>) {
                    // p[0]: x, y, w, h; p[1]: stride, rows, the words
                    if(id.x >= p[1].z) { return; }
                    var word = levels[id.x];
                    for(var b = 0u; b < 4u; b++) {
                        let at = id.x * 4u + b;
                        let layer = at / (p[1].x * p[1].y);
                        let row = at % (p[1].x * p[1].y) / p[1].x;
                        let column = at % p[1].x;
                        if(column >= p[0].x && column < p[0].x + p[0].z && row >= p[0].y && row < p[0].y + p[0].w) {
                            let i = (layer * p[0].w + row - p[0].y) * p[0].z + column - p[0].x;
                            let value = (values[i / 4u] >> (i % 4u * 8u)) & 0xFFu;
                            word = (word & ~(0xFFu << (b * 8u))) | (value << (b * 8u));
                        }
                    }
                    levels[id.x] = word;
                }` });
            this.stencil_patch3 = this.device.createComputePipeline({ label: "GLES stencil patch", layout: "auto", compute: { module, entryPoint: "main" } });
        }
        const words = stride * rows * d / 4;
        const parameters = this.uniform_buffer(new Uint32Array([x, y, w, h, stride, rows, words, 0]).buffer);
        this.end_pass();
        this.encoder.copyTextureToBuffer(level, { buffer: levels, bytesPerRow: stride, rowsPerImage: rows }, [width, height, d]);
        const pass = this.encoder.beginComputePass({ label: "GLES stencil patch" });
        pass.setPipeline(this.stencil_patch3);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: this.stencil_patch3.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: levels } },
            { binding: 1, resource: { buffer: values } }, { binding: 2, resource: { buffer: parameters } }] }));
        pass.dispatchWorkgroups(Math.ceil(words / 64));
        pass.end();
        this.encoder.copyBufferToTexture({ buffer: levels, bytesPerRow: stride, rowsPerImage: rows }, level, [width, height, d]);
    },

    /**
     * A compressed image's blocks into a texture of their decoded format
     * (WebGPU makes compressed textures of whole blocks alone): the blocks
     * into a compressed texture of whole blocks, its texels drawn into the
     * level's rectangle by textureLoad
     * @param {!Array<number>} origin x, y and the layer, face or slice
     * @param {!Array<number>} size width and height
     */
    decode_compressed3(gpu, level, origin, size, data)
    {
        const mip = level - gpu.first;
        if(mip < 0 || mip >= gpu.levels) return;
        const c = gpu.decode, [x, y, layer] = origin, [w, h] = size;
        if(!w || !h) return;
        const columns = Math.ceil(w / c.block_width), rows = Math.ceil(h / c.block_height);
        const row = columns * c.block_bytes, stride = Math.ceil(row / 256) * 256;
        const blocks = this.device.createTexture({ label: "GLES compressed blocks", size: [columns * c.block_width, rows * c.block_height], format: c.webgpu,
            usage: U.TEXTURE_BINDING | U.COPY_DST });
        this.staging.push(blocks);
        this.end_pass();
        const staging = this.device.createBuffer({ label: "GLES compressed upload", size: Math.max(4, stride * rows), usage: B.COPY_SRC, mappedAtCreation: true });
        const mapped = new Uint8Array(staging.getMappedRange());
        for(let k = 0; k < rows && k * row < data.length; k++) mapped.set(data.subarray(k * row, Math.min(data.length, (k + 1) * row)), k * stride);
        staging.unmap();
        this.staging.push(staging);
        this.encoder.copyBufferToTexture({ buffer: staging, bytesPerRow: stride, rowsPerImage: rows }, { texture: blocks }, [columns * c.block_width, rows * c.block_height, 1]);
        this.blits3 = this.blits3 || new Map();
        const key = "decode:" + gpu.format;
        let decode = this.blits3.get(key);
        if(!decode)
        {
            const module = this.device.createShaderModule({ code: `
                @group(0) @binding(0) var t : texture_2d<f32>;
                @group(0) @binding(1) var<uniform> p : vec4<i32>;
                @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
                    let v = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
                    return vec4<f32>(v[i], 0.0, 1.0);
                }
                @fragment fn fs(@builtin(position) q : vec4<f32>) -> @location(0) vec4<f32> {
                    return textureLoad(t, vec2<i32>(q.xy) - p.xy, 0);
                }` });
            const group = this.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: 2, texture: { sampleType: "unfilterable-float" } },
                { binding: 1, visibility: 2, buffer: { type: "uniform" } }] });
            decode = { group, pipeline: this.device.createRenderPipeline({ label: "GLES 3 compressed decode", layout: this.device.createPipelineLayout({ bindGroupLayouts: [group] }),
                vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: gpu.format }] }, primitive: { topology: "triangle-list" } }) };
            this.blits3.set(key, decode);
        }
        const view = gpu.texture.createView({ dimension: "2d", baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
        const pass = this.encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] });
        pass.setPipeline(decode.pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: decode.group, entries: [{ binding: 0, resource: blocks.createView() },
            { binding: 1, resource: { buffer: this.uniform_buffer(new Int32Array([x, y, 0, 0]).buffer) } }] }));
        pass.setScissorRect(x, y, w, h);
        pass.draw(3);
        pass.end();
        this.stats.uploads++;
    },

    /** glRenderbufferStorage(Multisample): a texture of the format (4 samples for any multisampled one) */
    renderbuffer_storage3(c)
    {
        const rb = c.group.renderbuffers.get(c.renderbuffer);
        if(!rb) return;
        if(rb.gpu) this.staging.push(rb.gpu);
        rb.gpu = null;
        this.make_renderbuffer3(rb);
    },

    /** A renderbuffer's texture, of its format and samples */
    make_renderbuffer3(rb)
    {
        if(!rb.width || !rb.height || rb.image) return;
        const info = format_info(rb.format);
        const format = info ? info.webgpu : RENDERBUFFER_WEBGPU[rb.format] || COLOR_FORMAT;
        if(!RENDERABLE.has(format)) return void this.note3("a renderbuffer of a format WebGPU draws no " + format);
        const samples = rb.samples > 1 ? 4 : 1;
        const texture = this.device.createTexture({ label: "GL renderbuffer", size: [rb.width, rb.height], format, sampleCount: samples,
            usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | (samples === 1 ? U.COPY_SRC | U.COPY_DST : 0) });
        rb.gpu = { es3: true, texture, format, samples, view: texture.createView(), destroy: () => texture.destroy() };
        if(alpha_less(rb.format, format)) this.alpha_one3(texture, 1, 1, false);
    },

    /**
     * A new texture of a format GL reads with alpha 1 (alpha_less): every
     * level and layer cleared to (0, 0, 0, 1), draws leaving alpha alone after
     */
    alpha_one3(texture, levels, layers, three)
    {
        this.end_pass();
        for(let mip = 0; mip < levels; mip++)
        {
            const count = three ? Math.max(1, layers >> mip) : layers;
            for(let layer = 0; layer < count; layer++)
            {
                const view = three ? texture.createView({ dimension: "3d", baseMipLevel: mip, mipLevelCount: 1 }) :
                    texture.createView({ dimension: "2d", baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
                this.encoder.beginRenderPass({ colorAttachments: [Object.assign({ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" },
                    three ? { depthSlice: layer } : {})] }).end();
            }
        }
    },

    // ---- snapshots (L7's; the textures' and renderbuffers' contents)

    /**
     * A texture's levels and layers as save() reads them: rows of texels
     * (of blocks for a compressed format); the depth formats WebGPU copies
     * nothing out of, and multisampled textures (nothing copies them), are
     * left out (they read as undefined after a restore)
     */
    save_texture3(t, reads)
    {
        const gpu = t.gpu;
        if(gpu.samples > 1 || DRAWN_DEPTH.has(gpu.format) || gpu.format === "stencil8") return;
        t.saved = [];
        t.saved3 = true;
        const texel = gpu.block > 1 ? gpu.block_bytes : TEXEL_BYTES[gpu.format];
        for(let mip = 0; mip < gpu.levels; mip++)
        {
            const width = Math.max(1, gpu.width >> mip), height = Math.max(1, gpu.height >> mip);
            const layers = gpu.three ? Math.max(1, gpu.depth >> mip) : gpu.depth;
            const columns = Math.ceil(width / gpu.block), rows = Math.ceil(height / (gpu.block_height || 1));
            for(let layer = 0; layer < layers; layer++)
            {
                reads.push({ owner: t, texture: gpu.texture, level: mip, gl_level: mip + gpu.first, layer, width, height, row: columns * texel, rows,
                    extent: [columns * gpu.block, rows * (gpu.block_height || 1), 1] });
            }
        }
    },

    /** A texture's saved levels and layers put back (save_texture3's) */
    restore_texture3(t)
    {
        const gpu = this.gpu_texture3(t);
        for(const [level, layer, width, height, bytes] of gpu ? t.saved : []) this.upload3(gpu, level, [0, 0, layer], [width, height, 1], bytes);
    },

    /** A renderbuffer of one sample and a color or depth16 format: its texels */
    save_renderbuffer3(rb, reads)
    {
        rb.saved3 = true;
        const texel = TEXEL_BYTES[rb.gpu.format];
        if(rb.gpu.samples > 1 || !texel || DRAWN_DEPTH.has(rb.gpu.format) || rb.gpu.format === "stencil8") return;
        rb.saved = [];
        reads.push({ owner: rb, texture: rb.gpu.texture, level: 0, layer: 0, width: rb.width, height: rb.height, row: rb.width * texel, rows: rb.height });
    },

    restore_renderbuffer3(rb)
    {
        this.make_renderbuffer3(rb);
        for(const [, , width, height, bytes] of rb.gpu ? rb.saved || [] : [])
        {
            this.upload3({ texture: rb.gpu.texture, format: rb.gpu.format, first: 0, levels: 1, width, height, depth: 1, three: false, block: 1 }, 0,
                [0, 0, 0], [width, height, 1], bytes);
        }
        delete rb.saved;
        delete rb.saved3;
    },

    /**
     * The buffers the GPU wrote (`gpu_newer`: storage writes, transform
     * feedback, copies, pack buffers) copied out in save's encoder: their
     * bytes become the shadow's, which a restore's GPU buffer starts from
     * (gpu_buffer)
     * @return {!Array<!Object>} the reads, for saved_buffers3 once submitted
     */
    save_buffers3(encoder)
    {
        const reads = [];
        for(const group of this.shadow.groups.values())
        {
            for(const buffer of group.buffers.values())
            {
                if(!buffer.gpu || !buffer.gpu_newer || !buffer.size) continue;
                const size = Math.min(buffer.gpu.size, align4(buffer.size));
                const read = this.device.createBuffer({ label: "GLES buffer save", size, usage: B.COPY_DST | B.MAP_READ });
                encoder.copyBufferToBuffer(buffer.gpu.buffer, 0, read, 0, size);
                reads.push({ buffer, read, size });
            }
        }
        return reads;
    },

    /** save_buffers3's reads, once submitted: the buffers' bytes */
    async saved_buffers3(reads)
    {
        for(const { buffer, read, size } of reads)
        {
            await read.mapAsync(globalThis.GPUMapMode ? globalThis.GPUMapMode.READ : 1);
            const bytes = new Uint8Array(buffer.size);
            bytes.set(new Uint8Array(read.getMappedRange()).subarray(0, Math.min(size, buffer.size)));
            buffer.bytes = bytes;
            read.unmap();
            read.destroy();
        }
    },

    // ---- what is drawn to and read from

    /** An attachment as a pass's: texture, view, format, level and layer, size, samples */
    attachment3(c, a)
    {
        if(!a) return null;
        const color_buffer = t => t && { texture: t.texture, view: t.texture.createView(), format: COLOR_FORMAT, mip: 0, layer: 0, samples: 1,
            width: t.texture.width, height: t.texture.height };
        if(a.type === GL3.RENDERBUFFER)
        {
            const rb = c.group.renderbuffers.get(a.name);
            if(rb && rb.image) return color_buffer(this.image_texture(rb.image));
            if(!rb || !rb.gpu) return null;
            return { texture: rb.gpu.texture, view: rb.gpu.view, format: rb.gpu.format, mip: 0, layer: 0, samples: rb.gpu.samples, width: rb.width,
                height: rb.height, no_alpha: alpha_less(rb.format, rb.gpu.format) };
        }
        const texture = c.group.textures.get(a.name);
        const image = texture && texture.images.get(a.face * 32 + a.level);
        if(image && image.image) return color_buffer(this.image_texture(image.image));
        if(image && image.color_buffer) return color_buffer(this.color_buffer_texture(image.color_buffer));
        const gpu = texture && this.gpu_texture3(texture);
        if(!gpu || !RENDERABLE.has(gpu.format)) return null;
        const mip = a.level - gpu.first;
        if(mip < 0 || mip >= gpu.levels) return null;
        const layer = gpu.cube ? a.face : gpu.three || gpu.array ? a.layer || 0 : 0;
        const key = "attachment" + mip + ":" + (gpu.three ? 0 : layer);
        let view = gpu.views.get(key);
        if(!view)
        {
            view = gpu.three ? gpu.texture.createView({ dimension: "3d", baseMipLevel: mip, mipLevelCount: 1 }) :
                gpu.texture.createView({ dimension: "2d", baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
            gpu.views.set(key, view);
        }
        return { texture: gpu.texture, view, format: gpu.format, mip, layer, depth_slice: gpu.three ? layer : undefined, samples: gpu.samples || 1,
            width: Math.max(1, gpu.width >> mip), height: Math.max(1, gpu.height >> mip), no_alpha: !!image && alpha_less(image_internal(image), gpu.format) };
    },

    /**
     * The draw framebuffer as a pass's attachments: a color attachment each
     * draw buffer (null for none), the depth-stencil one; null when there is
     * nothing to draw to or WebGPU cannot (sizes or samples differ)
     */
    target3(c)
    {
        if(!c.framebuffer)
        {
            const t = this.surface_target(c);
            if(!t) return null;
            const color = c.default_draw_buffer === GL3.NONE ? null :
                { texture: t.color, view: t.color_view, format: COLOR_FORMAT, mip: 0, layer: 0, samples: 1, width: t.width, height: t.height };
            return { colors: color ? [color] : [], depth: t.depth ? { view: t.depth, format: t.depth_format, texture: t.depth_texture, mip: 0, layer: 0,
                samples: 1, width: t.width, height: t.height } : null, width: t.width,
                height: t.height, samples: 1, alpha: t.alpha, key: t.key + (color ? "" : "n"), textures: new Set([t.color]) };
        }
        const fbo = c.framebuffers.get(c.framebuffer);
        if(!fbo) return null;
        const colors = (fbo.draw_buffers || [GL3.COLOR_ATTACHMENT0]).map(b => b === GL3.NONE ? null : this.attachment3(c, fbo.attachments.get(b)));
        while(colors.length && !colors[colors.length - 1]) colors.pop();
        const depth = this.attachment3(c, fbo.attachments.get(GL3.DEPTH_ATTACHMENT)) || this.attachment3(c, fbo.attachments.get(GL3.STENCIL_ATTACHMENT));
        // (a depth and stencil image attached at one point alone: the framebuffer has no buffer of the other, whose test passes)
        if(depth) Object.assign(depth, { gl_depth: !!fbo.attachments.get(GL3.DEPTH_ATTACHMENT), gl_stencil: !!fbo.attachments.get(GL3.STENCIL_ATTACHMENT) });
        const all = [...colors.filter(Boolean), ...depth ? [depth] : []];
        if(!all.length)
        {
            // (GLES 3.1: no attachments, a default size; a pass has one: a color attachment nothing is written to)
            if(!(fbo.default_width > 0 && fbo.default_height > 0)) return null;
            const samples = fbo.default_samples > 0 ? 4 : 1;
            const size = fbo.default_width + "x" + fbo.default_height + "x" + samples;
            this.empty_targets3 = this.empty_targets3 || new Map();
            let empty = this.empty_targets3.get(size);
            if(!empty)
            {
                const texture = this.device.createTexture({ label: "GLES no attachments", size: [fbo.default_width, fbo.default_height], format: "r8unorm",
                    sampleCount: samples, usage: U.RENDER_ATTACHMENT });
                empty = { texture, view: texture.createView(), format: "r8unorm", mip: 0, layer: 0, samples, width: fbo.default_width,
                    height: fbo.default_height, unwritten: true };
                this.empty_targets3.set(size, empty);
            }
            return { colors: [empty], depth: null, width: empty.width, height: empty.height, samples, alpha: true, key: "3:empty:" + size, textures: new Set() };
        }
        const { width, height, samples } = all[0];
        if(all.some(a => a.width !== width || a.height !== height)) return this.note3("attachments of different sizes");
        if(all.some(a => a.samples !== samples)) return this.note3("attachments of different samples");
        const key = "3:" + colors.map(a => a ? this.id_of(a.texture) + "." + a.mip + "." + a.layer : "-").join(",") + "/" +
            (depth ? this.id_of(depth.texture) + "." + depth.mip + "." + depth.layer : "-");
        return { colors, depth, width, height, samples, alpha: true, key, textures: new Set(all.map(a => a.texture)) };
    },

    /** What glReadPixels and the copies read: the read framebuffer's read buffer, or null */
    read_target3(c)
    {
        if(!read_framebuffer(c))
        {
            if(c.default_read_buffer === GL3.NONE) return null;
            const t = this.surface_target(c);
            return t && t.color ? { texture: t.color, format: COLOR_FORMAT, mip: 0, layer: 0, samples: 1, width: t.width, height: t.height, no_alpha: t.alpha === false } : null;
        }
        const fbo = c.framebuffers.get(read_framebuffer(c));
        if(!fbo || fbo.read_buffer === GL3.NONE) return null;
        return this.attachment3(c, fbo.attachments.get(fbo.read_buffer === undefined ? GL3.COLOR_ATTACHMENT0 : fbo.read_buffer));
    },

    /** The read framebuffer's depth (or depth and stencil) attachment */
    read_depth3(c)
    {
        if(!read_framebuffer(c))
        {
            const t = this.surface_target(c);
            return t && t.depth ? { texture: t.depth_texture, view: t.depth, format: t.depth_format, mip: 0, layer: 0, samples: 1, width: t.width,
                height: t.height } : null;
        }
        const fbo = c.framebuffers.get(read_framebuffer(c));
        return fbo ? this.attachment3(c, fbo.attachments.get(GL3.DEPTH_ATTACHMENT)) || this.attachment3(c, fbo.attachments.get(GL3.STENCIL_ATTACHMENT)) : null;
    },

    /**
     * glBlitFramebuffer: the read buffer into each draw buffer, the depth
     * buffer into the depth buffer (frag_depth); a multisampled source
     * resolved first; what keeps size, format and place a copy. The stencil
     * buffer is not copied (WebGPU writes no stencil values, gpu-deviations.md).
     */
    blit_framebuffer3(c, [sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter])
    {
        const target = this.target3(c);
        if(!target) return;
        let [x0, y0, x1, y1] = [Math.min(dx0, dx1), Math.min(dy0, dy1), Math.max(dx0, dx1), Math.max(dy0, dy1)];
        if(c.enabled.has(SCISSOR_TEST))
        {
            const [x, y, w, h] = c.scissor;
            [x0, y0, x1, y1] = [Math.max(x0, x), Math.max(y0, y), Math.min(x1, x + w), Math.min(y1, y + h)];
        }
        [x0, y0, x1, y1] = [Math.max(0, x0), Math.max(0, y0), Math.min(target.width, x1), Math.min(target.height, y1)];
        if(x1 <= x0 || y1 <= y0 || sx0 === sx1 || sy0 === sy1 || dx0 === dx1 || dy0 === dy1) return;
        const blit = { src: [sx0, sy0, sx1, sy1], dst: [dx0, dy0, dx1, dy1], rect: [x0, y0, x1 - x0, y1 - y0], linear: filter === LINEAR };
        if(mask & 0x4000)
        {
            let source = this.read_target3(c);
            if(source && source.samples > 1) source = this.resolve3(source);
            for(const a of source ? target.colors : []) if(a) this.blit3(source, a, blit, false);
        }
        if(mask & 0x0100 && target.depth && target.depth.format !== "stencil8")
        {
            const source = this.read_depth3(c);
            if(source && source.format !== "stencil8") this.blit3(source, target.depth, Object.assign({}, blit, { linear: false }), true);
        }
        if(mask & 0x0400) this.note3("glBlitFramebuffer's stencil (not copied)");
    },

    /** A multisampled color attachment resolved into a texture of its own (gone after the batch) */
    resolve3(source)
    {
        if(format_kind(source.format) !== "f") return this.note3("a multisampled integer read buffer resolved");
        this.end_pass();
        const texture = this.device.createTexture({ label: "GLES resolve", size: [source.width, source.height], format: source.format,
            usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_SRC });
        const pass = this.encoder.beginRenderPass({ colorAttachments: [{ view: source.view, resolveTarget: texture.createView(), loadOp: "load", storeOp: "store" }] });
        pass.end();
        this.staging.push(texture);
        return { texture, view: texture.createView(), format: source.format, mip: 0, layer: 0, samples: 1, width: source.width, height: source.height };
    },

    /**
     * One blit of a source image into a destination attachment: a copy when
     * nothing scales, flips, clips or converts, else a draw sampling the
     * source (GL's mapping of destination pixel centers into the source)
     * @param {{src: !Array<number>, dst: !Array<number>, rect: !Array<number>, linear: boolean}} blit
     */
    blit3(source, dest, blit, depth)
    {
        const [sx0, sy0, sx1, sy1] = blit.src, [dx0, dy0, dx1, dy1] = blit.dst, [x, y, w, h] = blit.rect;
        const three = source.texture.dimension === "3d";
        // (a copy when nothing changes, but alpha into a target GL reads with alpha 1)
        if(!depth && !blit.map && source.format === dest.format && source.samples === 1 && (!dest.no_alpha || source.no_alpha) &&
            sx1 - sx0 === dx1 - dx0 && sy1 - sy0 === dy1 - dy0 && sx1 > sx0 && sy1 > sy0 &&
            x === dx0 && y === dy0 && w === dx1 - dx0 && h === dy1 - dy0 && sx0 >= 0 && sy0 >= 0 && sx1 <= source.width && sy1 <= source.height && dest.texture)
        {
            this.end_pass();
            this.encoder.copyTextureToTexture({ texture: source.texture, mipLevel: source.mip, origin: [sx0, sy0, source.layer] },
                { texture: dest.texture, mipLevel: dest.mip, origin: [dx0, dy0, dest.layer] }, [w, h, 1]);
            return;
        }
        const kind = format_kind(source.format);
        const out_kind = depth ? "depth" : format_kind(dest.format);
        if(!depth && kind === "depth") return;
        const scalar = { f: "f32", i: "i32", u: "u32" }[kind] || "f32";
        const ms = source.samples > 1;
        const linear = blit.linear && kind === "f" && !source.format.includes("32float") && !ms;
        const key = ["blit3", source.format, three ? 3 : 2, ms ? "m" : "", linear ? "l" : "n", depth ? dest.format : dest.format + ":" + out_kind,
            dest.no_alpha ? "~" : ""].join("|");
        this.blit_pipelines3 = this.blit_pipelines3 || new Map();
        let entry = this.blit_pipelines3.get(key);
        if(!entry)
        {
            const texture = kind === "depth" ? (ms ? "texture_depth_multisampled_2d" : "texture_depth_2d") : (three ? "texture_3d<" : "texture_2d<") + scalar + ">";
            const at = three ? "vec3<i32>(k, i32(p.layer))" : "k";
            const fetch = ms ? "textureLoad(t, k, 0)" : "textureLoad(t, " + at + ", 0)";
            const sample = three ? "textureSampleLevel(t, s, vec3<f32>(c / p.size, (p.layer + 0.5) / p.depth), 0.0)" : "textureSampleLevel(t, s, c / p.size, 0.0)";
            const out_type = { f: "vec4<f32>", i: "vec4<i32>", u: "vec4<u32>" }[out_kind];
            const value = kind === "depth" ? fetch : linear ? sample : fetch;
            const code = `
                struct P { src0 : vec2<f32>, scale : vec2<f32>, dst0 : vec2<f32>, size : vec2<f32>, layer : f32, depth : f32,
                    m : mat4x4<f32>, b : vec4<f32> };
                @group(0) @binding(0) var<uniform> p : P;
                @group(0) @binding(1) var t : ${texture};
                ${linear ? "@group(0) @binding(2) var s : sampler;" : ""}
                @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
                    let v = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
                    return vec4<f32>(v[i], 0.0, 1.0);
                }
                @fragment fn fs(@builtin(position) q : vec4<f32>) -> ${depth ? "@builtin(frag_depth) f32" : "@location(0) " + out_type} {
                    let c = p.src0 + (q.xy - p.dst0) * p.scale;
                    // (a destination pixel whose source is outside the source rectangle's image: left as it is)
                    if(any(c < vec2<f32>(0.0)) || any(c >= p.size)) { discard; }
                    let k = clamp(vec2<i32>(floor(c)), vec2<i32>(0), vec2<i32>(p.size) - vec2<i32>(1));
                    ${depth ? "return " + value + ";" : out_kind === "f" ? "return p.m * vec4<f32>(" + value + ") + p.b;" : "return " + out_type + "(" + value + ");"}
                }`;
            const module = this.device.createShaderModule({ label: "GLES 3 blit", code });
            const group = this.device.createBindGroupLayout({ entries: [
                { binding: 0, visibility: 2, buffer: { type: "uniform" } },
                { binding: 1, visibility: 2, texture: { sampleType: kind === "depth" ? "depth" : kind === "i" ? "sint" : kind === "u" ? "uint" :
                    linear ? "float" : "unfilterable-float", viewDimension: three ? "3d" : "2d", multisampled: ms } },
                ...linear ? [{ binding: 2, visibility: 2, sampler: { type: "filtering" } }] : []] });
            const descriptor = { label: "GLES 3 blit", layout: this.device.createPipelineLayout({ bindGroupLayouts: [group] }),
                vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: depth ? [] : [{ format: dest.format, writeMask: dest.no_alpha ? 7 : 15 }] },
                primitive: { topology: "triangle-list" } };
            if(depth) descriptor.depthStencil = { format: dest.format, depthWriteEnabled: true, depthCompare: "always" };
            entry = { pipeline: this.device.createRenderPipeline(descriptor), group,
                sampler: linear ? this.device.createSampler({ magFilter: "linear", minFilter: "linear" }) : null };
            this.blit_pipelines3.set(key, entry);
        }
        const uniforms = new Float32Array(36);
        uniforms.set([sx0, sy0, (sx1 - sx0) / (dx1 - dx0), (sy1 - sy0) / (dy1 - dy0), dx0, dy0, source.width, source.height,
            source.layer || 0, three ? Math.max(1, source.texture.depthOrArrayLayers >> source.mip) : 1]);
        uniforms.set(blit.map ? blit.map.m : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 12);
        uniforms.set(blit.map ? blit.map.b : [0, 0, 0, 0], 28);
        const view = three ? source.texture.createView({ dimension: "3d", baseMipLevel: source.mip, mipLevelCount: 1 }) :
            source.texture.createView({ dimension: "2d", baseMipLevel: source.mip, mipLevelCount: 1, baseArrayLayer: source.layer, arrayLayerCount: 1,
                aspect: kind === "depth" && source.format.includes("stencil") ? "depth-only" : "all" });
        this.end_pass();
        const pass = this.encoder.beginRenderPass(depth ? { colorAttachments: [], depthStencilAttachment: Object.assign({ view: dest.view,
            depthLoadOp: "load", depthStoreOp: "store" }, dest.format.includes("stencil") ? { stencilLoadOp: "load", stencilStoreOp: "store" } : {}) } :
            { colorAttachments: [Object.assign({ view: dest.view, loadOp: "load", storeOp: "store" }, dest.depth_slice !== undefined ? { depthSlice: dest.depth_slice } : {})] });
        pass.setPipeline(entry.pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: entry.group, entries: [
            { binding: 0, resource: { buffer: this.uniform_buffer(uniforms.buffer) } }, { binding: 1, resource: view },
            ...entry.sampler ? [{ binding: 2, resource: entry.sampler }] : []] }));
        pass.setScissorRect(x, y, w, h);
        pass.draw(3);
        pass.end();
    },

    /**
     * glReadPixels of a GLES 3.x context: the read buffer's texels, decoded
     * and packed by the call's format and type and the pack state (taken
     * now: later commands of the batch may change it)
     */
    read_pixels3(c, record)
    {
        if(!this.read_region3(c, record, (bytes, sink) => this.answer(sink, record.request, bytes))) this.answer_failed(record.request);
    },

    /**
     * glReadPixelsOffsetAEMU: the pixels into the pixel pack buffer, once the
     * batch's reads are back (the CPU side asks for them later, a map:
     * BUFFER_READ comes in a batch after this one)
     */
    read_pixels_pack3(c, [x, y, width, height, format, type, offset])
    {
        const buffer = c.group.buffers.get(c.buffers.pixel_pack);
        if(!buffer) return;
        const gpu = this.gpu_buffer(buffer);
        this.read_region3(c, { x, y, width, height, format, type }, bytes =>
        {
            const n = Math.min(bytes.length, buffer.size - offset);
            const copy = cpu_bytes(buffer);
            if(n <= 0 || !copy) return;
            copy.set(bytes.subarray(0, n), offset);
            // (a map in this batch read the GPU buffer before these bytes came: buffer_read3 lays them over it)
            (buffer.packed = buffer.packed || []).push([offset, n]);
            this.packed3 = this.packed3 || new Set();
            this.packed3.add(buffer);
            const low = offset & ~3, high = Math.min(gpu.size, align4(offset + n));
            this.device.queue.writeBuffer(gpu.buffer, low, copy.buffer, copy.byteOffset + low, high - low);
        });
    },

    /**
     * A rectangle of the read buffer, decoded and packed by a format and
     * type and the pack state (taken now: later commands of the batch may
     * change it), handed to `done` once read
     * @return {boolean} whether there is a read buffer to read
     */
    read_region3(c, record, done)
    {
        const source = this.read_target3(c);
        if(!source || source.samples > 1 || !TEXEL_BYTES[source.format] || format_kind(source.format) === "depth") return false;
        const pack = c.pack || NO_STORE;
        const store = { alignment: c.pack_alignment, row_length: pack.row_length, skip_pixels: pack.skip_pixels, skip_rows: pack.skip_rows };
        const x0 = Math.max(0, record.x), y0 = Math.max(0, record.y);
        const x1 = Math.min(source.width, record.x + record.width), y1 = Math.min(source.height, record.y + record.height);
        const packed = values => pack_pixels(values, record.width, record.height, record.format, record.type, store);
        if(x1 <= x0 || y1 <= y0)
        {
            this.reads.push({ buffer: null, done: (_, sink) => done(packed(new Float64Array(record.width * record.height * 4)), sink) });
            return true;
        }
        this.read_texture(source.texture, x0, y0, x1 - x0, y1 - y0, false, (raw, sink) =>
        {
            // (the part outside the read buffer: zeros)
            const w = x1 - x0;
            const decoded = decode_texels(raw, w * (y1 - y0), source.format);
            const values = new Float64Array(record.width * record.height * 4);
            for(let y = 0; y < y1 - y0; y++)
            {
                values.set(decoded.subarray(y * w * 4, (y + 1) * w * 4), ((y + y0 - record.y) * record.width + (x0 - record.x)) * 4);
            }
            done(packed(values), sink);
        }, source.mip, source.layer, TEXEL_BYTES[source.format]);
        return true;
    },

    /**
     * The render pass on a target (the open one if it is the same);
     * `clear`: {colors (values by draw buffer), depth, stencil};
     * `occlusion`: the pass counts samples (the batch's occlusion queries)
     */
    begin_pass3(target, clear, occlusion)
    {
        if(this.pass && this.pass_target === target.key && !clear && (!occlusion || this.pass_occlusion)) return this.pass;
        this.end_pass();
        const colors = target.colors.map((a, i) =>
        {
            if(!a) return null;
            const value = clear && clear.colors && clear.colors[i];
            return Object.assign({ view: a.view, storeOp: "store", loadOp: value ? "clear" : "load" },
                value ? { clearValue: { r: value[0], g: value[1], b: value[2], a: a.no_alpha ? 1 : value[3] } } : {},
                a.depth_slice !== undefined ? { depthSlice: a.depth_slice } : {});
        });
        const descriptor = { label: "GLES 3 pass", colorAttachments: colors };
        if(target.depth)
        {
            const format = target.depth.format;
            const has_depth = format !== "stencil8", has_stencil = format.includes("stencil");
            descriptor.depthStencilAttachment = Object.assign({ view: target.depth.view },
                has_depth ? { depthLoadOp: clear && clear.depth !== undefined ? "clear" : "load", depthStoreOp: "store",
                    depthClearValue: clear && clear.depth !== undefined ? clear.depth : 1 } : {},
                has_stencil ? { stencilLoadOp: clear && clear.stencil !== undefined ? "clear" : "load", stencilStoreOp: "store",
                    stencilClearValue: clear && clear.stencil !== undefined ? clear.stencil : 0 } : {});
        }
        if(occlusion) descriptor.occlusionQuerySet = this.occlusion3().set;
        this.pass = this.encoder.beginRenderPass(descriptor);
        this.pass_target = target.key;
        this.pass_occlusion = !!occlusion;
        return this.pass;
    },

    // ---- occlusion queries

    /**
     * The batch's occlusion queries: a WebGPU query a draw while a GL one is
     * active (`owners`: the GL query each, the shadow's object), summed at
     * the batch's end into the GL query's `passed` (whether any sample did;
     * a snapshot keeps it with the shadow)
     */
    occlusion3()
    {
        if(!this.occlusion) this.occlusion = { set: this.device.createQuerySet({ label: "GLES occlusion", type: "occlusion", count: 4096 }), owners: [],
            answers: [] };
        return this.occlusion;
    },

    /** The context's occlusion query in progress (the shadow's object; begun again, a new one), or null */
    occlusion_query3(c)
    {
        if(!c.active_queries) return null;
        const name = c.active_queries.get(GL3.ANY_SAMPLES_PASSED) || c.active_queries.get(GL3.ANY_SAMPLES_PASSED_CONSERVATIVE);
        return name && c.queries.get(name) || null;
    },

    /** The batch's end: the occlusion queries resolved and summed, then the results asked for answered */
    batch_end3()
    {
        // (the pack buffers' bytes that came after the last batch's maps are on the GPU now)
        for(const buffer of this.packed3 || []) buffer.packed = null;
        if(this.packed3) this.packed3.clear();
        const o = this.occlusion;
        if(!o || !o.owners.length && !o.answers.length) return;
        const owners = o.owners;
        o.owners = [];
        if(owners.length)
        {
            this.end_pass();
            const resolved = this.device.createBuffer({ label: "GLES occlusion", size: 8 * owners.length, usage: B.QUERY_RESOLVE | B.COPY_SRC });
            const read = this.device.createBuffer({ label: "GLES occlusion read", size: 8 * owners.length, usage: B.COPY_DST | B.MAP_READ });
            this.encoder.resolveQuerySet(o.set, 0, owners.length, resolved, 0);
            this.encoder.copyBufferToBuffer(resolved, 0, read, 0, 8 * owners.length);
            this.staging.push(resolved);
            this.reads.push({ buffer: read, bytes: 8 * owners.length, done: bytes =>
            {
                owners.forEach((query, i) => { if(bytes.subarray(8 * i, 8 * i + 8).some(Boolean)) query.passed = 1; });
            } });
        }
        for(const { request, query } of o.answers)
        {
            this.reads.push({ buffer: null, done: (_, sink) => this.answer(sink, request, new Uint8Array(new Uint32Array([query && query.passed || 0]).buffer)) });
        }
        o.answers = [];
    },

    /** QUERY_READ: an occlusion query's result, after the batch's own draws are counted */
    query_read3(record)
    {
        const conn = this.conns.get(record.conn);
        const c = conn && this.shadow.context(conn.context);
        if(!c) return this.answer_failed(record.request);
        this.occlusion3().answers.push({ request: record.request, query: c.queries ? c.queries.get(record.query) : null });
        return undefined;
    },

    // ---- clears

    /** glClear: every draw buffer, the depth and stencil buffers (none while RASTERIZER_DISCARD is on) */
    clear3(c, mask)
    {
        if(c.enabled.has(GL3.RASTERIZER_DISCARD)) return;
        const target = this.target3(c);
        if(!target) return;
        const color = c.clear_color.slice();
        this.clear_target3(c, target, { colors: mask & 0x4000 ? target.colors.map(a => a ? color : null) : [],
            depth: mask & 0x0100 ? c.clear_depth : undefined, stencil: mask & 0x0400 ? c.clear_stencil : undefined });
    },

    /** glClearBuffer{iv,uiv,fv,fi} (none while RASTERIZER_DISCARD is on) */
    clear_buffer3(c, name, args)
    {
        if(c.enabled.has(GL3.RASTERIZER_DISCARD)) return;
        const target = this.target3(c);
        if(!target) return;
        const [buffer, drawbuffer, value] = args;
        const bytes = value instanceof Uint8Array ? value.slice() : null;
        const words = bytes ? bytes.buffer : null;
        if(buffer === 0x1800)
        {
            if(!words || words.byteLength < 16 || !target.colors[drawbuffer]) return;
            const values = Array.from(name === "glClearBufferfv" ? new Float32Array(words, 0, 4) : name === "glClearBufferuiv" ? new Uint32Array(words, 0, 4) :
                new Int32Array(words, 0, 4));
            const colors = [];
            colors[drawbuffer] = values;
            this.clear_target3(c, target, { colors, typed: true });
        }
        else if(buffer === 0x1801 && words) this.clear_target3(c, target, { colors: [], depth: new Float32Array(words, 0, 1)[0] });
        else if(buffer === 0x1802 && words) this.clear_target3(c, target, { colors: [], stencil: new Int32Array(words, 0, 1)[0] });
        else if(buffer === 0x84F9) this.clear_target3(c, target, { colors: [], depth: args[2], stencil: args[3] });
    },

    /**
     * Clear what `want` says (colors by draw buffer, depth, stencil) by the
     * masks and the scissor: the pass's clears when nothing limits them,
     * else a quad
     */
    clear_target3(c, target, want)
    {
        const has = format => target.depth && (format === "depth" ? target.depth.format !== "stencil8" && target.depth.gl_depth !== false :
            target.depth.format.includes("stencil") && target.depth.gl_stencil !== false);
        const depth = want.depth !== undefined && c.depth_mask && has("depth") ? Math.min(1, Math.max(0, want.depth)) : undefined;
        const stencil = want.stencil !== undefined && has("stencil") ? want.stencil & 0xFF : undefined;
        const colors = want.colors.map((v, i) => v && target.colors[i] ? (target.alpha ? v : [v[0], v[1], v[2], 1]) : null);
        const any_color = colors.some(Boolean);
        if(!any_color && depth === undefined && stencil === undefined) return;
        const scissor = c.enabled.has(SCISSOR_TEST) && !(c.scissor[0] <= 0 && c.scissor[1] <= 0 && c.scissor[0] + c.scissor[2] >= target.width &&
            c.scissor[1] + c.scissor[3] >= target.height);
        const simple = !scissor && (!any_color || c.color_mask.every(Boolean)) && (stencil === undefined || (c.stencil_writemask[0] & 0xFF) === 0xFF);
        if(simple)
        {
            this.begin_pass3(target, { colors, depth, stencil });
            return;
        }
        this.clear_quad3(c, target, colors, depth, stencil);
    },

    clear_quad3(c, target, colors, depth, stencil)
    {
        const types = target.colors.map(a => a ? { f: "f32", i: "i32", u: "u32" }[format_kind(a.format)] : null);
        const mask = (c.color_mask[0] ? 1 : 0) | (c.color_mask[1] ? 2 : 0) | (c.color_mask[2] ? 4 : 0) | (c.color_mask[3] && target.alpha ? 8 : 0);
        const key = ["clear3", target.colors.map((a, i) => a ? a.format + (colors[i] ? mask : 0) : "-").join(","), target.depth ? target.depth.format : "",
            depth !== undefined ? 1 : 0, stencil !== undefined ? c.stencil_writemask[0] & 0xFF : 0, target.samples].join("|");
        let pipeline = this.pipelines.get(key);
        if(!pipeline)
        {
            const outputs = types.map((t, i) => t ? `@location(${i}) c${i} : vec4<${t}>,` : "").join("\n");
            const writes = types.map((t, i) => t ? `o.c${i} = bitcast<vec4<${t}>>(u[${i}]);` : "").join("\n");
            const code = `
                struct Out { ${outputs || "@location(0) unused : vec4<f32>,"} };
                @group(0) @binding(0) var<uniform> u : array<vec4<u32>, 5>;
                @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
                    let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
                    return vec4<f32>(p[i], bitcast<f32>(u[4].x), 1.0);
                }
                @fragment fn fs() -> Out { var o : Out; ${writes} return o; }`;
            const module = this.device.createShaderModule({ label: "GLES 3 clear", code });
            const descriptor = {
                label: "GLES 3 clear", layout: "auto", vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: target.colors.map((a, i) => a ? { format: a.format, writeMask: colors[i] ? mask & (a.no_alpha ? 7 : 15) : 0 } : null) },
                primitive: { topology: "triangle-list" }, multisample: { count: target.samples },
            };
            if(target.depth)
            {
                const format = target.depth.format;
                descriptor.depthStencil = Object.assign({ format },
                    format !== "stencil8" ? { depthWriteEnabled: depth !== undefined, depthCompare: "always" } : {},
                    format.includes("stencil") ? { stencilFront: { compare: "always", passOp: "replace" }, stencilBack: { compare: "always", passOp: "replace" },
                        stencilWriteMask: stencil !== undefined ? c.stencil_writemask[0] & 0xFF : 0 } : {});
            }
            pipeline = this.device.createRenderPipeline(descriptor);
            this.pipelines.set(key, pipeline);
        }
        const values = new ArrayBuffer(80);
        target.colors.forEach((a, i) =>
        {
            if(!a || !colors[i]) return;
            const kind = format_kind(a.format);
            (kind === "f" ? new Float32Array(values, i * 16, 4) : kind === "u" ? new Uint32Array(values, i * 16, 4) : new Int32Array(values, i * 16, 4)).set(colors[i]);
        });
        new Float32Array(values, 64, 1)[0] = depth === undefined ? 0 : depth;
        const pass = this.begin_pass3(target, null);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: this.uniform_buffer(values) } }] }));
        this.apply_scissor(pass, c, target);
        pass.setViewport(0, 0, target.width, target.height, 0, 1);
        if(stencil !== undefined) pass.setStencilReference(stencil);
        pass.draw(3);
    },

    // ---- draws

    /**
     * A draw of a GLES 3.x context
     * @param {?{type: number, bytes: (Uint8Array|undefined), offset: (number|undefined), provoking: (boolean|undefined)}} elements
     *     (provoking: a list already ordered for GL's provoking vertex)
     * @param {number=} base_vertex added to each index (GLES 3.1's indirect draws of elements)
     * @param {?{buffer: !Object, offset: number}=} indirect the draw's parameters in a buffer the GPU wrote (GLES 3.1):
     *     the GPU reads them, where the draw's arrays and indices can be bound as they are
     */
    draw3(c, mode, first, count, elements, instances, base_vertex = 0, indirect = null)
    {
        if(!indirect && (count <= 0 || instances <= 0)) return;
        const stages = this.stages3(c);
        if(!stages) return;
        if(c.enabled.has(CULL_FACE) && c.cull_face === 0x0408 && mode >= 4) return;
        const target = this.target3(c);
        if(!target) return;
        this.blend_destination3(c, target);
        const shaders = this.program3(c, stages, target);
        if(!shaders) return;
        // (GLES 3.2: a draw of patches, its tessellation shaders'; a geometry shader's; lines and triangles with adjacency drawn
        // without one, the adjacent vertices left out)
        if(mode === PATCHES)
        {
            if(indirect) return void this.note3("an indirect draw of patches");
            if(stages.vertex !== stages.fragment) return void this.note3("a pipeline's tessellation shaders");
            return void this.tessellation_draw3(c, stages.vertex, shaders, target, first, count, elements, instances, base_vertex);
        }
        if(stages.vertex.info.geometry && stages.vertex === stages.fragment)
        {
            if(indirect) return void this.note3("an indirect draw of a geometry shader");
            return void this.geometry_draw3(c, stages.vertex, shaders, target, mode, first, count, elements, instances, base_vertex);
        }
        if(mode >= 0xA)
        {
            const drawn = !indirect && this.draw_vertices3(c, first, count, elements, base_vertex);
            if(!drawn) return void (indirect && this.note3("an indirect draw with adjacency"));
            const { vertices, per } = primitives_of(drawn.indices, mode, drawn.restart);
            const keep = per === 4 ? [1, 2] : [0, 2, 4];
            const list = new Uint32Array(vertices.length / per * keep.length);
            for(let p = 0, k = 0; p < vertices.length; p += per) for(const i of keep) list[k++] = vertices[p + i];
            return void this.draw3(c, per === 4 ? 1 : 4, 0, list.length, { type: 0x1405, bytes: new Uint8Array(list.buffer) }, instances);
        }
        // (GL's provoking vertex is a primitive's last, WebGPU's its first: a draw with flat varyings as a list whose primitives
        // start with their last vertex, a rotation that keeps triangles' winding; G-17's. A draw transform feedback captures
        // captures first as it is, in GL's order, without drawing; not an indirect draw: G-77)
        const tf = c.tfs && c.tfs.get(c.tf);
        if(!indirect && !(elements && elements.provoking) && mode >= 1 && mode <= 6 && shaders.flat && !this.capture_only3)
        {
            if(tf && tf.active && !tf.paused && !elements)
            {
                this.capture_only3 = true;
                try
                {
                    this.draw3(c, mode, first, count, elements, instances, base_vertex, indirect);
                }
                finally
                {
                    this.capture_only3 = false;
                }
            }
            const drawn = this.draw_vertices3(c, first, count, elements, base_vertex);
            if(drawn)
            {
                const { vertices, per } = primitives_of(drawn.indices, mode, drawn.restart);
                if(!vertices.length) return;
                const list = new Uint32Array(vertices.length);
                for(let p = 0; p < vertices.length; p += per)
                {
                    list[p] = vertices[p + per - 1];
                    for(let k = 0; k + 1 < per; k++) list[p + 1 + k] = vertices[p + k];
                }
                return void this.draw3(c, per === 2 ? 1 : 4, 0, list.length, { type: 0x1405, bytes: new Uint8Array(list.buffer), provoking: true }, instances);
            }
        }
        const plan = this.vertex_plan3(c, this.inputs3(stages.vertex), indirect ? 1 : instances);
        if(!plan) return;
        if(indirect && (plan.cpu.length || mode === 2 || mode === 6 || elements && INDEX_BYTES[elements.type] < 2)) {
            return void this.note3("an indirect draw whose arrays or indices are converted");
        }
        // the indices: the element buffer's as they are where they can be, else a list from the vertex range's first
        let list = null, low = 0, high = -1, rebase = false, topology = TOPOLOGY[mode], strip = mode === 3 || mode === 5, direct = null;
        const fan_or_loop = mode === 2 || mode === 6;
        if(elements)
        {
            const size = INDEX_BYTES[elements.type];
            const buffer = elements.bytes ? null : c.group.buffers.get(c.element_array_buffer);
            if(!size || !elements.bytes && !buffer) return;
            if(buffer && !fan_or_loop && !plan.cpu_vertex && size > 1 && (indirect || elements.offset % size === 0))
            {
                direct = { buffer: this.gpu_buffer(buffer).buffer, format: size === 2 ? "uint16" : "uint32", offset: indirect ? 0 : elements.offset };
            }
            else
            {
                const source = elements.bytes || (buffer.gpu_newer ? null : cpu_bytes(buffer));
                if(!source) return void this.note3("indices the GPU wrote, converted");
                const offset = elements.bytes ? 0 : elements.offset;
                if(offset + count * size > source.length) return;
                const view = new DataView(source.buffer, source.byteOffset + offset, count * size);
                const indices = new Uint32Array(count);
                for(let i = 0; i < count; i++) indices[i] = size === 1 ? view.getUint8(i) : size === 2 ? view.getUint16(2 * i, true) : view.getUint32(4 * i, true);
                // (a base vertex: GLES 3.1's indirect draws; the restart index stays one)
                const restart_index = size === 1 ? 0xFF : size === 2 ? 0xFFFF : 0xFFFFFFFF;
                if(base_vertex) for(let i = 0; i < count; i++) if(!c.enabled.has(RESTART) || indices[i] !== restart_index) indices[i] += base_vertex;
                const r = index_list(indices, mode, c.enabled.has(RESTART) ? (size === 1 ? 0xFF : size === 2 ? 0xFFFF : 0xFFFFFFFF) : -1);
                this.stats.index_lists = (this.stats.index_lists || 0) + 1;
                if(!r || !r.list.length) return;
                ({ list, low, high, topology, strip } = r);
                rebase = true;
            }
        }
        else if(fan_or_loop)
        {
            const r = index_list(Uint32Array.from({ length: count }, (_, i) => first + i), mode, -1);
            this.stats.index_lists = (this.stats.index_lists || 0) + 1;
            if(!r || !r.list.length) return;
            ({ list, low, high, topology, strip } = r);
            rebase = true;
        }
        else if(plan.cpu_vertex)
        {
            low = first;
            high = first + count - 1;
            rebase = true;
        }
        if(rebase && high - low >= 1 << 24) return void this.note3("a vertex range past 2^24");
        const vertex = this.vertex_buffers3(c, plan, { low, high, rebase, instances: indirect ? 0 : instances, indexed: !!(list || direct || indirect), first,
            count });
        if(!vertex) return;
        const group = this.bind_groups3(c, shaders.bindings, target);
        if(!group) return;
        if(!elements && !indirect) this.capture3(c, stages.vertex, group, vertex, mode, first, count, instances, rebase);
        // (rasterizer discard: what transform feedback captured, nothing drawn; a capture before a reordered draw, the same)
        if(c.enabled.has(GL3.RASTERIZER_DISCARD) || this.capture_only3) return;
        if(c.viewport[2] <= 0 || c.viewport[3] <= 0) return;
        let index_buffer = null;
        if(list)
        {
            index_buffer = this.device.createBuffer({ label: "GLES indices", size: align4(Math.max(4, list.byteLength)), usage: B.INDEX, mappedAtCreation: true });
            new Uint32Array(index_buffer.getMappedRange()).set(list);
            index_buffer.unmap();
            this.staging.push(index_buffer);
        }
        const strip_format = strip && (list || direct) ? (direct ? direct.format : "uint32") : undefined;
        // (the parameters' GPU buffer before the pass: its bytes may go up first)
        const parameters = indirect && this.gpu_buffer(indirect.buffer).buffer;
        this.render3(c, target, shaders, vertex, group, topology, strip_format, mode, pass =>
        {
            if(indirect)
            {
                if(direct)
                {
                    pass.setIndexBuffer(direct.buffer, direct.format, 0);
                    pass.drawIndexedIndirect(parameters, indirect.offset);
                }
                else pass.drawIndirect(parameters, indirect.offset);
            }
            else if(index_buffer)
            {
                pass.setIndexBuffer(index_buffer, "uint32");
                pass.drawIndexed(list.length, instances);
            }
            else if(direct)
            {
                pass.setIndexBuffer(direct.buffer, direct.format, direct.offset);
                pass.drawIndexed(count, instances, 0, base_vertex);
            }
            else pass.draw(count, instances, rebase ? 0 : first, 0);
        });
    },

    /**
     * A draw's render passes (one a stencil face where they differ): the
     * pipeline, the resources, vertex buffers, viewport, scissor, the blend
     * and stencil references, the occlusion query; `draw` draws in the pass
     * @param {function(!GPURenderPassEncoder)} draw
     */
    render3(c, target, shaders, vertex, group, topology, strip_format, mode, draw)
    {
        const [vx, vy, vw, vh] = c.viewport;
        const occlusion = this.occlusion_query3(c);
        for(const face of this.stencil_faces3(c, target, mode))
        {
            const pipeline = this.pipeline3(c, shaders, vertex, group, topology, strip_format, target, face);
            if(!pipeline) return;
            const pass = this.begin_pass3(target, null, !!occlusion);

            pass.setPipeline(pipeline);
            for(const g of group.groups) pass.setBindGroup(g.index, this.device.createBindGroup({ layout: g.layout, entries: g.resources }));
            vertex.slots.forEach((s, i) => pass.setVertexBuffer(i, s.gpu, s.offset));
            pass.setViewport(vx, vy, vw, vh, Math.min(c.depth_range[0], c.depth_range[1]), Math.max(c.depth_range[0], c.depth_range[1]));
            if(!this.apply_scissor(pass, c, target)) return;
            // (CONSTANT_ALPHA's factors are WebGPU's constant ones of the alpha in every channel: G-70)
            pass.setBlendConstant(c.blend_func.some(f => f === 0x8003 || f === 0x8004) ?
                { r: c.blend_color[3], g: c.blend_color[3], b: c.blend_color[3], a: c.blend_color[3] } :
                { r: c.blend_color[0], g: c.blend_color[1], b: c.blend_color[2], a: c.blend_color[3] });
            if(c.enabled.has(STENCIL_TEST)) pass.setStencilReference(c.stencil_func[face === undefined ? 0 : face][1] & 0xFF);
            const o = occlusion && this.occlusion3();
            const query = o && o.owners.length < 4096 ? o.owners.push(occlusion) - 1 : -1;
            if(query >= 0) pass.beginOcclusionQuery(query);
            draw(pass);
            if(query >= 0) pass.endOcclusionQuery();
        }
        this.stats.draws++;
    },

    /**
     * An advanced blend's destination (GLES 3.2): the draw's color target
     * copied before it, which the fragment shader reads and blends with
     * (glsl_es_rewrite.js), in `blend_dst3`; null for a draw that does not
     * blend so
     */
    blend_destination3(c, target)
    {
        this.blend_dst3 = null;
        if(advanced_blend(c) < 0) return;
        const color = target.colors[0];
        if(!color || color.unwritten) return;
        if(color.samples > 1) return void this.note3("an advanced blend into a multisampled target");
        const copy = this.device.createTexture({ label: "GLES blend destination", size: [target.width, target.height], format: color.format,
            usage: U.TEXTURE_BINDING | U.COPY_DST });
        this.end_pass();
        this.encoder.copyTextureToTexture({ texture: color.texture, mipLevel: color.mip, origin: [0, 0, color.layer || 0] }, { texture: copy },
            [target.width, target.height, 1]);
        this.staging.push(copy);
        this.blend_dst3 = { view: copy.createView(), format: color.format };
    },

    /**
     * A draw's vertices in order (its indices, a base vertex added but not to
     * the restart index), from client memory or the element buffer's bytes
     * @return {?{indices: !Uint32Array, restart: number}} (restart: the restart index, -1 for none)
     */
    draw_vertices3(c, first, count, elements, base_vertex)
    {
        if(!elements) return { indices: Uint32Array.from({ length: count }, (_, i) => first + i), restart: -1 };
        const size = INDEX_BYTES[elements.type];
        const buffer = elements.bytes ? null : c.group.buffers.get(c.element_array_buffer);
        const source = elements.bytes || buffer && (buffer.gpu_newer ? null : cpu_bytes(buffer));
        if(!size || !source) return this.note3("indices the GPU wrote, converted");
        const offset = elements.bytes ? 0 : elements.offset;
        if(offset + count * size > source.length) return null;
        const view = new DataView(source.buffer, source.byteOffset + offset, count * size);
        const restart = c.enabled.has(RESTART) ? (size === 1 ? 0xFF : size === 2 ? 0xFFFF : 0xFFFFFFFF) : -1;
        const indices = new Uint32Array(count);
        for(let i = 0; i < count; i++)
        {
            const v = size === 1 ? view.getUint8(i) : size === 2 ? view.getUint16(2 * i, true) : view.getUint32(4 * i, true);
            indices[i] = v === restart ? v : v + base_vertex;
        }
        return { indices, restart };
    },

    // ---- geometry shaders (GLES 3.2; vx_naga's geometry.rs)

    /** vx_naga's JSON answer of `call` (input, its length) with the SPIR-V words in its memory */
    naga_json3(words, call)
    {
        const naga = this.naga;
        const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
        const input = naga.vx_alloc(bytes.length);
        new Uint8Array(naga.memory.buffer, input, bytes.length).set(bytes);
        let out;
        try
        {
            out = call(input, bytes.length);
        }
        finally
        {
            naga.vx_free(input, bytes.length);
        }
        const length = new DataView(naga.memory.buffer).getUint32(out, true);
        const t = JSON.parse(new TextDecoder().decode(new Uint8Array(naga.memory.buffer, out + 4, length)));
        naga.vx_free(out, length + 4);
        return t;
    },

    /** A program's geometry shader through vx_naga (cached with the program's GPU side), or null (noted) */
    geometry3(program)
    {
        const gpu = this.program_gpu(program);
        if(gpu.geometry !== undefined) return gpu.geometry;
        gpu.geometry = null;
        const m = program.info.spirv.find(x => x.stage === "geometry");
        if(!m || !this.naga.vx_translate_geometry) return this.note3("a geometry shader vx_naga cannot translate");
        const t = this.naga_json3(m.words, (input, length) => this.naga.vx_translate_geometry(input, length, 1, 0, 0));
        if(t.error) return this.note3("vx_naga's geometry shader: " + t.error.slice(0, 160));
        gpu.geometry = { translation: t, layout: t.geometry, passes: new Map(), pipelines: new Map(),
            module: this.device.createShaderModule({ label: "GLES 3 geometry", code: "diagnostic(off, derivative_uniformity);\n" + t.wgsl }) };
        return gpu.geometry;
    },

    /**
     * The vertex shader that passes a geometry shader's list on to the
     * fragment shader: the record's position in WebGPU's clip space (GL's
     * depth halved, Y flipped as vx_naga's), each output the fragment shader
     * reads at its location with the fragment input's interpolation; the
     * list's vertex attributes
     */
    pass_shader3(g, shaders)
    {
        const key = this.id_of(shaders.fragment.module);
        let pass = g.passes.get(key);
        if(pass) return pass;
        const inputs = fragment_inputs(shaders.fragment.wgsl);
        const scalar = { f: "f32", i: "i32", u: "u32" };
        const outputs = g.layout.outputs.filter(o => inputs.has(o[0]));
        const type = o => o[2] === 1 ? scalar[o[1]] : "vec" + o[2] + "<" + scalar[o[1]] + ">";
        const code = "struct VxPassOut {\n    @builtin(position) position: vec4<f32>,\n" +
            outputs.map((o, i) => `    @location(${o[0]}) ${inputs.get(o[0])} o${i}: ${type(o)},\n`).join("") + "}\n" +
            "@vertex fn vx_pass(@location(0) p: vec4<f32>" + outputs.map((o, i) => `, @location(${i + 1}) a${i}: ${type(o)}`).join("") + ") -> VxPassOut {\n" +
            "    var o: VxPassOut;\n    o.position = vec4<f32>(p.x, -p.y, (p.z + p.w) * 0.5, p.w);\n" +
            outputs.map((o, i) => `    o.o${i} = a${i};\n`).join("") + "    return o;\n}\n";
        const format = o => ({ f: "float32", i: "sint32", u: "uint32" })[o[1]] + (o[2] > 1 ? "x" + o[2] : "");
        pass = { module: this.device.createShaderModule({ label: "GLES 3 geometry pass", code }), attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" },
            ...outputs.map((o, i) => ({ shaderLocation: i + 1, offset: 4 * (8 + 4 * o[0]), format: format(o) }))] };
        g.passes.set(key, pass);
        return pass;
    },

    /** The largest buffer a compute pass binds */
    most3()
    {
        return this.device.limits ? Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize) : 1 << 27;
    },

    /**
     * The resources of a draw whose stages run as compute shaders too (a
     * geometry or tessellation shader's): the fragment shader's, the vertex
     * shader's seen by compute shaders as well, and the translations'
     */
    stages_group3(c, program, shaders, translations, target)
    {
        const merged = new Map(shaders.bindings.map(b => [b.group + ":" + b.binding, Object.assign({}, b, { visibility: b.visibility | (b.visibility & 1 ? 4 : 0) })]));
        for(const b of this.bindings3(translations.map(t => [t, 4, program])))
        {
            const key = b.group + ":" + b.binding;
            if(merged.has(key)) merged.get(key).visibility |= 4;
            else merged.set(key, b);
        }
        return this.bind_groups3(c, [...merged.values()].sort((a, b) => a.group - b.group || a.binding - b.binding), target);
    },

    /**
     * The vertex shader run as a compute shader over the vertices a draw's
     * primitives or patches use, every output captured (xfb3's `all`): the
     * records, a record's bytes, and each primitive's vertices' record
     * indices (each instance's after the last's), in a buffer
     * @param {!Uint32Array} vertices the primitives' vertices in order
     * @return {?{records: !GPUBuffer, record: number, ids_buffer: !GPUBuffer}}
     */
    vertex_records3(c, program, group, vertices, instances)
    {
        let low = Infinity, high = -1;
        for(const v of vertices) { if(v < low) low = v; if(v > high) high = v; }
        if(high - low >= 1 << 24) return this.note3("a vertex range past 2^24");
        const plan = this.vertex_plan3(c, this.inputs3(program), instances);
        if(!plan) return null;
        const vcount = high - low + 1, rebase = plan.cpu_vertex;
        const vertex = this.vertex_buffers3(c, plan, { low, high, rebase, instances, indexed: false, first: low, count: vcount });
        if(!vertex) return null;
        const capture = this.xfb3(program, vertex, true);
        if(!capture) return null;
        const record = capture.xfb.strides[0];
        if(vcount * instances * record > this.most3()) return this.note3("a draw's vertex records too large");
        const records = this.device.createBuffer({ label: "GLES vertex records", size: Math.max(16, align4(vcount * instances * record)), usage: B.STORAGE });
        this.staging.push(records);
        this.capture_pass3(capture, group, vertex, rebase ? 0 : low, vcount, instances, [records]);
        const ids = new Uint32Array(Math.max(4, vertices.length * instances));
        for(let i = 0; i < instances; i++) for(let k = 0; k < vertices.length; k++) ids[i * vertices.length + k] = i * vcount + vertices[k] - low;
        const ids_buffer = this.device.createBuffer({ label: "GLES primitives' vertices", size: ids.byteLength, usage: B.STORAGE, mappedAtCreation: true });
        new Uint32Array(ids_buffer.getMappedRange()).set(ids);
        ids_buffer.unmap();
        this.staging.push(ids_buffer);
        return { records, record, ids_buffer };
    },

    /** A program's tessellation shaders through vx_naga (cached with the program's GPU side), or null (noted) */
    tessellation3(program)
    {
        const gpu = this.program_gpu(program);
        if(gpu.tessellation !== undefined) return gpu.tessellation;
        gpu.tessellation = null;
        const stage = name => program.info.spirv.find(x => x.stage === name);
        const control = stage("tess_control"), evaluation = stage("tess_evaluation");
        if(!control || !evaluation) return this.note3("patches without tessellation shaders");
        if(!this.naga.vx_translate_tessellation) return this.note3("tessellation shaders vx_naga cannot translate");
        const [tc, te] = [[control, 1], [evaluation, 0]].map(([m, is_control]) =>
            this.naga_json3(m.words, (input, length) => this.naga.vx_translate_tessellation(input, length, is_control, 1)));
        const failed = [tc, te].find(t => t.error);
        if(failed) return this.note3("vx_naga's tessellation shader: " + failed.error.slice(0, 160));
        const module = t => this.device.createShaderModule({ label: "GLES 3 tessellation", code: "diagnostic(off, derivative_uniformity);\n" + t.wgsl });
        gpu.tessellation = { tc, te, control: module(tc), evaluation: module(te), pipelines: new Map(),
            // (pass_shader3's: the evaluation shader's outputs as a geometry shader's)
            pass: { layout: te.tessellation, passes: new Map() } };
        return gpu.tessellation;
    },

    /** GX's tessellator (tessellator_wgsl.js): its count, scan and generate pipelines, made once */
    tessellator3()
    {
        if(this.tessellator) return this.tessellator;
        // (a script of the page's WebGPU bundle before this one: tools/build_glbridge.mjs)
        const module = this.device.createShaderModule({ label: "GLES tessellator", code: globalThis["V86TessellatorWGSL"].TESSELLATOR_WGSL });
        const layout = this.device.createBindGroupLayout({ entries: [
            { binding: 0, visibility: 4, buffer: { type: "uniform" } },
            { binding: 1, visibility: 4, buffer: { type: "read-only-storage" } },
            ...[2, 3, 4, 5, 6].map(binding => ({ binding, visibility: 4, buffer: { type: "storage" } })),
        ] });
        const pipeline_layout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] });
        const make = entryPoint => this.device.createComputePipeline({ label: "GLES tessellator " + entryPoint, layout: pipeline_layout,
            compute: { module, entryPoint } });
        this.tessellator = { layout, count: make("count"), scan: make("scan"), generate: make("generate") };
        return this.tessellator;
    },

    /** A compute pipeline of a stage's module and entry point: the draw's resources in group 0, its own in group 1 (`own`'s entries) */
    stage_pipeline3(cache, group, module, entry, own)
    {
        const key = entry + ":" + group.key;
        let p = cache.get(key);
        if(!p)
        {
            const layouts = [group.groups[0].layout, this.device.createBindGroupLayout({ entries: own })];
            p = { layouts, pipeline: this.device.createComputePipeline({ label: "GLES 3 " + entry, layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }),
                compute: { module, entryPoint: entry } }) };
            cache.set(key, p);
        }
        return p;
    },

    /**
     * A draw of patches (GLES 3.2's tessellation; the guest's wire has no
     * glPatchParameteri: 3 vertices a patch): the vertex shader as a
     * compute shader over the patches' vertices; the control shader a
     * workgroup a patch (vx_naga's tessellation.rs); GX's tessellator (its
     * counts, their sums and the indirect arguments, the points and
     * indices); the evaluation shader an invocation a point (an indirect
     * dispatch); the points drawn by the indices (an indirect draw) through
     * the pass shader with the fragment shader
     */
    tessellation_draw3(c, program, shaders, target, first, count, elements, instances, base_vertex)
    {
        if(count <= 0 || instances <= 0) return;
        const t = this.tessellation3(program);
        if(!t) return;
        const tf = c.tfs && c.tfs.get(c.tf);
        if(tf && tf.active && !tf.paused) this.note3("transform feedback of tessellation's output");
        if(program.info.geometry) this.note3("a geometry shader after tessellation: left out");
        const drawn = this.draw_vertices3(c, first, count, elements, base_vertex);
        if(!drawn) return;
        const per = PATCH_VERTICES;
        const per_instance = Math.floor(drawn.indices.length / per);
        if(!per_instance) return;
        const vertices = drawn.indices.subarray(0, per_instance * per);
        const group = this.stages_group3(c, program, shaders, [t.tc, t.te], target);
        if(!group) return;
        const control = t.tc.tessellation, evaluation = t.te.tessellation;
        const total = per_instance * instances;
        // (room for what the tessellator makes, at the largest level: GX's bounds)
        const points_most = Math.min(total * 65 * 66, 1 << 18), indices_most = Math.min(total * (6 * 64 * 64 + 12 * 64), 3 << 19);
        const sizes = [total * control.vertices * control.cp_stride * 4, total * control.patch_stride * 4, points_most * evaluation.stride * 4,
            points_most * 16, indices_most * 4];
        if(sizes.some(n => n > this.most3()) || total > 65535 * 65535) return void this.note3("a draw of patches too large");
        const captured = this.vertex_records3(c, program, group, vertices, instances);
        if(!captured) return;
        const buffer = (size, usage) => { const b = this.device.createBuffer({ label: "GLES tessellation", size: Math.max(32, align4(size)), usage }); this.staging.push(b); return b; };
        const control_points = buffer(sizes[0], B.STORAGE), patches = buffer(sizes[1], B.STORAGE), vertices_out = buffer(sizes[2], B.STORAGE | B.VERTEX);
        const points = buffer(sizes[3], B.STORAGE), indices = buffer(sizes[4], B.STORAGE | B.INDEX);
        const counts = buffer(total * 8, B.STORAGE), offsets = buffer(total * 8, B.STORAGE);
        const args = buffer(32, B.STORAGE | B.INDIRECT | B.COPY_SRC), draw_args = buffer(32, B.INDIRECT | B.COPY_DST);
        const read = { buffer: { type: "read-only-storage" } }, write = { buffer: { type: "storage" } }, uniform = { buffer: { type: "uniform" } };
        const entries = list => list.map((resource, i) => ({ binding: 960 + i, resource: resource.buffer ? resource : { buffer: resource } }));
        const layout_of = list => list.map((type, i) => Object.assign({ binding: 960 + i, visibility: 4 }, type));
        const tc = this.stage_pipeline3(t.pipelines, group, t.control, "vx_tess_control", layout_of([uniform, read, read, write, write]));
        const te = this.stage_pipeline3(t.pipelines, group, t.evaluation, "vx_tess_eval", layout_of([uniform, read, read, read, read, write]));
        const tess = this.tessellator3();
        const group0 = layout => this.device.createBindGroup({ layout, entries: group.groups[0].resources });
        this.end_pass();
        const pass = this.encoder.beginComputePass({ label: "GLES 3 tessellation" });
        // the control shader: a workgroup a patch
        pass.setPipeline(tc.pipeline);
        pass.setBindGroup(0, group0(tc.layouts[0]));
        pass.setBindGroup(1, this.device.createBindGroup({ layout: tc.layouts[1], entries: entries([
            { buffer: this.uniform_buffer(new Uint32Array([total, captured.record / 4, per, per_instance, evaluation.domain, 0, 0, 0]).buffer) },
            captured.records, captured.ids_buffer, control_points, patches]) }));
        pass.dispatchWorkgroups(Math.min(total, 65535), Math.ceil(total / 65535));
        // the tessellator: counts, sums, points and indices
        const groups = Math.ceil(total / 64);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: tess.layout, entries: [
            { buffer: this.uniform_buffer(new Uint32Array([total, evaluation.domain, evaluation.spacing, evaluation.primitive, control.patch_stride / 4, 0,
                points_most, indices_most]).buffer) },
            { buffer: patches }, { buffer: counts }, { buffer: offsets }, { buffer: points }, { buffer: indices }, { buffer: args },
        ].map((resource, binding) => ({ binding, resource })) }));
        for(const [pipeline, n] of [[tess.count, groups], [tess.scan, 1], [tess.generate, groups]])
        {
            pass.setPipeline(pipeline);
            pass.dispatchWorkgroups(Math.min(n, 65535), Math.ceil(n / 65535));
        }
        pass.end();
        // the evaluation shader: an invocation a point (the dispatch the scan wrote: a pass of its own)
        const evaluate = this.encoder.beginComputePass({ label: "GLES 3 tessellation evaluation" });
        evaluate.setPipeline(te.pipeline);
        evaluate.setBindGroup(0, group0(te.layouts[0]));
        evaluate.setBindGroup(1, this.device.createBindGroup({ layout: te.layouts[1], entries: entries([
            { buffer: this.uniform_buffer(new Uint32Array([per_instance, control.cp_stride, control.patch_stride, control.vertices, evaluation.domain, 0, 0, 0]).buffer) },
            control_points, patches, points, args, vertices_out]) }));
        evaluate.dispatchWorkgroupsIndirect(args, 0);
        evaluate.end();
        // (the draw's arguments: the scan's index count, one instance, the first instance 0, which indirect-first-instance would want otherwise)
        this.encoder.copyBufferToBuffer(args, 12, draw_args, 0, 16);
        this.stats.tessellation = (this.stats.tessellation || 0) + 1;
        if(c.enabled.has(GL3.RASTERIZER_DISCARD) || c.viewport[2] <= 0 || c.viewport[3] <= 0) return;
        const through = this.pass_shader3(t.pass, shaders);
        const pass_shaders = { vertex: { module: through.module, entry: "vx_pass" }, fragment: shaders.fragment, outputs: shaders.outputs,
            id: this.id_of(through.module) + ":" + this.id_of(shaders.fragment.module) };
        const stride = 4 * evaluation.stride;
        const list_vertex = { slots: [{ gpu: vertices_out, offset: 0, stride, step: "vertex", attributes: through.attributes }],
            key: "t" + stride + ":" + JSON.stringify(through.attributes) };
        const topology = ["point-list", "point-list", "line-list", "triangle-list", "triangle-list"][evaluation.primitive];
        this.render3(c, target, pass_shaders, list_vertex, group, topology, undefined, [0, 0, 1, 4, 4][evaluation.primitive], render =>
        {
            render.setIndexBuffer(indices, "uint32");
            render.drawIndexedIndirect(draw_args, 0);
        });
    },

    /**
     * A draw of a program with a geometry shader: the draw's primitives
     * assembled on the CPU; the vertex shader run as a compute shader over
     * the vertices they use, every output captured (xfb3's `all`); the
     * geometry shader as one, an invocation an input primitive and
     * invocation, into a list of primitives; the list drawn through the pass
     * shader with the fragment shader
     */
    geometry_draw3(c, program, shaders, target, mode, first, count, elements, instances, base_vertex)
    {
        if(count <= 0 || instances <= 0) return;
        const g = this.geometry3(program);
        if(!g) return;
        const tf = c.tfs && c.tfs.get(c.tf);
        if(tf && tf.active && !tf.paused) this.note3("transform feedback of a geometry shader's output");
        const drawn = this.draw_vertices3(c, first, count, elements, base_vertex);
        if(!drawn) return;
        const { vertices, per } = primitives_of(drawn.indices, mode, drawn.restart);
        if(per !== g.layout.input || !vertices.length) return;
        const group = this.stages_group3(c, program, shaders, [g.translation], target);
        if(!group) return;
        const layout = g.layout;
        const prims = vertices.length / per, total = prims * instances, invocations = total * layout.invocations;
        const out_record = 4 * layout.stride;
        const sizes = [invocations * layout.max_vertices * out_record, invocations * layout.list * out_record];
        if(sizes.some(n => n > this.most3()) || Math.ceil(invocations / 64) > 65535) return void this.note3("a geometry shader's draw too large");
        const captured = this.vertex_records3(c, program, group, vertices, instances);
        if(!captured) return;
        const { records, record, ids_buffer } = captured;
        const [emitted, list] = sizes.map((n, i) => this.device.createBuffer({ label: "GLES geometry", size: Math.max(16, align4(n)),
            usage: B.STORAGE | (i === 1 ? B.VERTEX : 0) }));
        this.staging.push(emitted, list);
        const own = [{ binding: 960, visibility: 4, buffer: { type: "uniform" } }, { binding: 961, visibility: 4, buffer: { type: "read-only-storage" } },
            { binding: 962, visibility: 4, buffer: { type: "read-only-storage" } }, { binding: 963, visibility: 4, buffer: { type: "storage" } },
            { binding: 964, visibility: 4, buffer: { type: "storage" } }];
        const key = group.key;
        let p = g.pipelines.get(key);
        if(!p)
        {
            const layouts = [group.groups[0].layout, this.device.createBindGroupLayout({ entries: own })];
            p = { layouts, pipeline: this.device.createComputePipeline({ label: "GLES 3 geometry", layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }),
                compute: { module: g.module, entryPoint: "vx_geometry" } }) };
            g.pipelines.set(key, p);
        }
        const params = new Uint32Array([total, record / 4, prims, 0]);
        this.end_pass();
        const pass = this.encoder.beginComputePass({ label: "GLES 3 geometry" });
        pass.setPipeline(p.pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: p.layouts[0], entries: group.groups[0].resources }));
        pass.setBindGroup(1, this.device.createBindGroup({ layout: p.layouts[1], entries: [{ binding: 960, resource: { buffer: this.uniform_buffer(params.buffer) } },
            ...[records, ids_buffer, emitted, list].map((buffer, i) => ({ binding: 961 + i, resource: { buffer } }))] }));
        pass.dispatchWorkgroups(Math.ceil(invocations / 64));
        pass.end();
        this.stats.geometry = (this.stats.geometry || 0) + 1;
        // the list drawn
        if(c.enabled.has(GL3.RASTERIZER_DISCARD)) return;
        if(c.viewport[2] <= 0 || c.viewport[3] <= 0) return;
        const through = this.pass_shader3(g, shaders);
        const pass_shaders = { vertex: { module: through.module, entry: "vx_pass" }, fragment: shaders.fragment, outputs: shaders.outputs,
            id: this.id_of(through.module) + ":" + this.id_of(shaders.fragment.module) };
        const list_vertex = { slots: [{ gpu: list, offset: 0, stride: out_record, step: "vertex", attributes: through.attributes }],
            key: "g" + out_record + ":" + JSON.stringify(through.attributes) };
        const topology = ["point-list", "line-list", "triangle-list"][layout.output];
        this.render3(c, target, pass_shaders, list_vertex, group, topology, undefined, [0, 1, 4][layout.output], pass => pass.draw(invocations * layout.list));
    },

    /** The stencil faces a draw is made of (gles_executor.js's stencil_faces, with the target's depth format) */
    stencil_faces3(c, target, mode)
    {
        const format = target.depth ? target.depth.format : "";
        return this.stencil_faces(c, { depth: !!target.depth, depth_format: format }, mode);
    },

    /**
     * How each vertex input is read: from its buffer directly, assembled on
     * the CPU, or its current value
     * @return {?{direct: !Array<!Object>, cpu: !Array<!Object>, constants: !Array<!Object>, cpu_vertex: boolean}}
     */
    vertex_plan3(c, inputs, instances)
    {
        const direct = [], cpu = [], constants = [];
        for(const input of inputs)
        {
            const a = input.unused ? UNUSED_INPUT : c.attribs[input.location];
            if(!a) return this.note3("an input past the attributes");
            if(!a.enabled)
            {
                // (its current value: the context's, not the vertex array's, GLES 3.0 table 6.6)
                const current = !input.unused && c.current_values && c.current_values[input.location];
                constants.push({ input, a: current ? { current: current.values } : a });
                continue;
            }
            const step = a.divisor ? "instance" : "vertex";
            const buffer = !a.data && a.buffer ? c.group.buffers.get(a.buffer) : null;
            const format = buffer && buffer.size && !(a.divisor > 1 && instances > 1) ? direct_format(a, input.kind) : null;
            if(format)
            {
                const component = packed_attribute(a.type) ? 4 : TYPE_BYTES[a.type];
                const element = packed_attribute(a.type) ? 4 : a.size * component;
                const stride = a.stride || element;
                if(stride % 4 === 0 && stride <= 2048 && a.offset % Math.min(4, component) === 0 && (a.offset & 3) + element <= stride)
                {
                    direct.push({ input, a, buffer, format, stride, step, element });
                    continue;
                }
            }
            if(buffer && buffer.gpu_newer) return this.note3("a vertex array the GPU wrote, converted");
            cpu.push({ input, a, step });
        }
        return { direct, cpu, constants, cpu_vertex: cpu.some(x => x.step === "vertex") };
    },

    /**
     * The draw's vertex buffers by the plan: direct arrays sharing a slot
     * where their buffer, stride and step agree and their offsets fit in one
     * vertex; the CPU's in one buffer a step; the current values in one
     * @param {{low: number, high: number, rebase: boolean, instances: number, indexed: boolean, first: number, count: number}} range
     * @return {?{slots: !Array<!Object>, key: string}}
     */
    vertex_buffers3(c, plan, range)
    {
        const slots = [];
        const groups = new Map();
        for(const d of plan.direct)
        {
            const key = d.a.buffer + ":" + d.stride + ":" + d.step;
            if(!groups.has(key)) groups.set(key, []);
            groups.get(key).push(d);
        }
        for(const list of groups.values())
        {
            list.sort((x, y) => x.a.offset - y.a.offset);
            let slot = null;
            for(const d of list)
            {
                if(!slot || d.a.offset - slot.base + d.element > d.stride)
                {
                    slot = { buffer: d.buffer, base: d.a.offset & ~3, stride: d.stride, step: d.step, attributes: [], end: 0 };
                    slots.push(slot);
                }
                slot.attributes.push({ shaderLocation: d.input.location, offset: d.a.offset - slot.base, format: d.format });
                slot.end = Math.max(slot.end, d.a.offset - slot.base + d.element);
            }
        }
        for(const slot of slots)
        {
            const gpu = this.gpu_buffer(slot.buffer);
            slot.gpu = gpu.buffer;
            slot.offset = slot.base + (slot.step === "vertex" && range.rebase ? range.low * slot.stride : 0);
            // (what WebGPU checks of a draw's vertex and instance ranges: GL leaves reads past a buffer undefined)
            const last = slot.step === "instance" ? range.instances - 1 : range.indexed ? -1 : range.rebase ? range.count - 1 : range.first + range.count - 1;
            if(slot.offset > slot.buffer.size || last >= 0 && slot.offset + last * slot.stride + slot.end > slot.buffer.size)
            {
                return this.note3("a vertex array past its buffer");
            }
        }
        for(const step of ["vertex", "instance"])
        {
            const list = plan.cpu.filter(x => x.step === step);
            if(!list.length) continue;
            const n = step === "vertex" ? range.high - range.low + 1 : range.instances;
            if(n <= 0) return null;
            const stride = list.reduce((s, x) => s + x.input.components * 4, 0);
            const words = new Uint32Array(n * stride / 4);
            const attributes = [];
            let offset = 0;
            for(const x of list)
            {
                const components = x.input.components;
                const values = this.values3(c, x.a, step === "vertex" ? range.low : 0, n, components, x.input.kind,
                    step === "vertex" ? 0 : Math.max(1, x.a.divisor));
                if(!values) return this.note3("a vertex array with no data");
                const raw = new Uint32Array(values.buffer);
                for(let v = 0; v < n; v++) for(let k = 0; k < components; k++) words[(v * stride + offset) / 4 + k] = raw[v * components + k];
                attributes.push({ shaderLocation: x.input.location, offset, format: CPU_FORMAT[x.input.kind] + (components > 1 ? "x" + components : "") });
                offset += components * 4;
            }
            slots.push({ gpu: this.vertex_data3(words), offset: 0, stride, step, attributes });
            // (the stats' vertex arrays assembled on the CPU: client arrays, formats WebGPU lacks)
            this.stats.cpu_arrays = (this.stats.cpu_arrays || 0) + list.length;
        }
        if(plan.constants.length)
        {
            const values = new ArrayBuffer(plan.constants.length * 16);
            const attributes = plan.constants.map(({ input, a }, i) =>
            {
                const current = [0, 1, 2, 3].map(k => a.current[k] === undefined ? (k === 3 ? 1 : 0) : a.current[k]);
                (input.kind === "f" ? new Float32Array(values, 16 * i, 4) : input.kind === "u" ? new Uint32Array(values, 16 * i, 4) :
                    new Int32Array(values, 16 * i, 4)).set(current);
                return { shaderLocation: input.location, offset: 16 * i, format: CPU_FORMAT[input.kind] + (input.components > 1 ? "x" + input.components : "") };
            });
            slots.push({ gpu: this.vertex_data3(new Uint32Array(values)), offset: 0, stride: 0, step: "instance", attributes });
        }
        if(slots.length > (this.device.limits ? this.device.limits.maxVertexBuffers : 8)) return this.note3("more vertex buffers than WebGPU binds");
        const key = slots.map(s => s.stride + s.step[0] + s.attributes.map(x => x.shaderLocation + "@" + x.offset + x.format).join(".")).join("/");
        return { slots, key };
    },

    /** A vertex buffer holding the words */
    vertex_data3(words)
    {
        const buffer = this.device.createBuffer({ label: "GLES vertices", size: Math.max(16, words.byteLength), usage: B.VERTEX | B.STORAGE,
            mappedAtCreation: true });
        new Uint32Array(buffer.getMappedRange(), 0, words.length).set(words);
        buffer.unmap();
        this.staging.push(buffer);
        return buffer;
    },

    /**
     * An enabled array's values, `components` each (missing ones 0, w 1) as
     * the input's kind: vertices from `first` (absolute; a client array's
     * element 0 is vertex 0), or instances by the divisor
     * @return {?(Float32Array|Int32Array|Uint32Array)}
     */
    values3(c, a, first, n, components, kind, divisor)
    {
        const packed = packed_attribute(a.type);
        const type_bytes = TYPE_BYTES[a.type] || 4;
        const element = packed ? 4 : a.size * type_bytes;
        let source, base, stride;
        if(a.data)
        {
            source = a.data;
            stride = element;
            base = 0;
        }
        else
        {
            const buffer = c.group.buffers.get(a.buffer);
            source = buffer && cpu_bytes(buffer);
            if(!source) return null;
            stride = a.stride || element;
            base = a.offset;
        }
        const out = kind === "f" ? new Float32Array(n * components) : kind === "i" ? new Int32Array(n * components) : new Uint32Array(n * components);
        const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
        const convert = kind === "f" ? v => v : v => Math.trunc(v);
        for(let k = 0; k < n; k++)
        {
            const at = base + (divisor ? Math.floor(k / divisor) : first + k) * stride;
            const fits = at + element <= source.length;
            const parts = fits && packed ? read_packed(view, at, a.type, a.normalized) : null;
            for(let i = 0; i < components; i++)
            {
                let value = i === 3 ? 1 : 0;
                if(fits && i < (packed ? 4 : a.size)) value = packed ? parts[i] : read_component(view, at + i * type_bytes, a.type, a.normalized && !a.integer);
                out[k * components + i] = convert(value);
            }
        }
        return out;
    },

    // ---- compute (GLES 3.1)

    /**
     * glDispatchCompute(Indirect): the compute program's shader through
     * vx_naga, its resources, a compute pass (between render passes: what it
     * writes is there for the draws after it)
     * @param {?Array<number>} groups the work groups, or null for `indirect`'s
     * @param {?{buffer: !Object, offset: number}} indirect the dispatch indirect buffer's parameters
     */
    dispatch3(c, groups, indirect)
    {
        const pipeline_object = !c.program && c.program_pipelines && c.program_pipelines.get(c.program_pipeline);
        const program = c.group.objects.get(c.program || pipeline_object && pipeline_object.stages[0x20]);
        if(!program || !program.info || !program.info.ok || !program.info.spirv) return;
        if(!this.naga) return void this.note3("vx_naga not loaded");
        const index = program.info.spirv.findIndex(m => m.stage === "compute");
        if(index < 0) return;
        let t = this.translation3(program, index, 0, []);
        if(!t.error && t.intsamples && t.intsamples.length)
        {
            const wraps = this.int_wraps3(c, program, t.intsamples);
            if(wraps.length) t = this.translation3(program, index, 0, wraps);
        }
        if(t.error) return void this.note3("vx_naga: " + t.error.slice(0, 160));
        const module = this.module3(t.wgsl);
        // (the images' copies back to their textures, image_proxy3's: after the pass)
        const image_writes = this.image_writes3 = [];
        const group = this.bind_groups3(c, this.bindings3([[t, 4, program]]), { textures: new Set() });
        this.image_writes3 = null;
        if(!group) return;
        // (WebGPU refuses it, and with it the batch: gpu-deviations.md G-78)
        if(writable_aliases(group)) return void this.note3("a dispatch writing a buffer range or an image two bindings name");
        this.computes3 = this.computes3 || new Map();
        const key = this.id_of(module) + "|" + group.key;
        let pipeline = this.computes3.get(key);
        if(!pipeline)
        {
            try
            {
                pipeline = this.device.createComputePipeline({ label: "GLES 3 compute", layout: group.pipeline_layout,
                    compute: { module, entryPoint: t.entries[0].name } });
            }
            catch(error)
            {
                if(this.stats.errors.length < 20) this.stats.errors.push("compute pipeline: " + error.message);
                return;
            }
            this.computes3.set(key, pipeline);
        }
        // (the parameters' GPU buffer before the pass: its bytes may go up first)
        const parameters = indirect && this.gpu_buffer(indirect.buffer);
        this.end_pass();
        const pass = this.encoder.beginComputePass({ label: "GLES 3 dispatch" });
        pass.setPipeline(pipeline);
        for(const g of group.groups) pass.setBindGroup(g.index, this.device.createBindGroup({ layout: g.layout, entries: g.resources }));
        if(parameters) pass.dispatchWorkgroupsIndirect(parameters.buffer, indirect.offset);
        else pass.dispatchWorkgroups(groups[0], groups[1], groups[2]);
        pass.end();
        for(const write of image_writes) write();
        this.stats.dispatches = (this.stats.dispatches || 0) + 1;
    },

    /**
     * An indirect draw (GLES 3.1): its parameters with the command, or in the
     * draw indirect buffer: read there where the CPU side has them, else the
     * GPU's (a buffer a dispatch wrote)
     * @param {?Uint8Array} data the parameters, the Data forms'
     */
    draw_indirect3(c, mode, type, data, offset)
    {
        const elements = type !== 0;
        const words = 4 + (elements ? 1 : 0);
        let parameters = null;
        if(data && data.length >= 4 * words) parameters = new DataView(data.buffer, data.byteOffset, 4 * words);
        const buffer = !data ? c.group.buffers.get(c.buffers.draw_indirect) : null;
        if(buffer && !buffer.gpu_newer && cpu_bytes(buffer) && offset + 4 * words <= cpu_bytes(buffer).length)
        {
            const bytes = cpu_bytes(buffer);
            parameters = new DataView(bytes.buffer, bytes.byteOffset + offset, 4 * words);
        }
        if(!parameters)
        {
            if(!buffer) return;
            if(elements) this.draw3(c, mode, 0, 0, { type, offset: 0 }, 0, 0, { buffer, offset });
            else this.draw3(c, mode, 0, 0, null, 0, 0, { buffer, offset });
            return;
        }
        const count = parameters.getUint32(0, true), instances = parameters.getUint32(4, true);
        if(elements)
        {
            const first_index = parameters.getUint32(8, true), base_vertex = parameters.getInt32(12, true);
            this.draw3(c, mode, 0, count, { type, offset: first_index * INDEX_BYTES[type] }, instances, base_vertex);
        }
        else this.draw3(c, mode, parameters.getUint32(8, true), count, null, instances);
    },

    // ---- transform feedback

    /** vx_naga's capture translation of SPIR-V words (vx_translate_xfb) for a vertex layout's words */
    translate_xfb_spirv(words, desc)
    {
        const naga = this.naga;
        const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
        const input = naga.vx_alloc(bytes.length);
        new Uint8Array(naga.memory.buffer, input, bytes.length).set(bytes);
        const list = naga.vx_alloc(desc.length * 4);
        new Uint32Array(naga.memory.buffer, list, desc.length).set(desc);
        let out;
        try
        {
            out = naga.vx_translate_xfb(input, bytes.length, 1, 0, 0, 0, list, desc.length);
        }
        finally
        {
            naga.vx_free(input, bytes.length);
            naga.vx_free(list, desc.length * 4);
        }
        const length = new DataView(naga.memory.buffer).getUint32(out, true);
        const json = new TextDecoder().decode(new Uint8Array(naga.memory.buffer, out + 4, length));
        naga.vx_free(out, length + 4);
        return JSON.parse(json);
    },

    /**
     * The compute shader of a capturing draw (vx_naga's xfb.rs: the vertex
     * shader run a vertex an invocation, reading the vertex buffers as
     * storage) for the program and the draw's vertex buffers, or null
     */
    xfb3(program, vertex, all = false)
    {
        const gpu = this.program_gpu(program);
        gpu.xfb = gpu.xfb || new Map();
        const key = (all ? "all:" : "") + vertex.key;
        if(gpu.xfb.has(key)) return gpu.xfb.get(key);
        let entry = null;
        // (the group of its own resources, 1; bit 31: every output captured, a geometry shader's input)
        const desc = [all ? 0x80000001 : 1, 0];
        vertex.slots.forEach((s, slot) =>
        {
            for(const a of s.attributes)
            {
                desc.push(a.shaderLocation, slot, VK_FORMAT[a.format] || 0, a.offset);
                desc[1]++;
            }
        });
        desc.push(vertex.slots.length);
        vertex.slots.forEach((s, slot) => desc.push(slot, s.stride, s.step === "instance" ? 1 : 0));
        const v = program.info.spirv.find(m => m.stage === "vertex");
        if(vertex.slots.some(s => s.attributes.some(a => !VK_FORMAT[a.format]))) this.note3("a captured vertex array of a packed type");
        else
        {
            const t = this.translate_xfb_spirv(v.words, desc);
            if(t.error) this.note3("vx_naga's capture: " + t.error.slice(0, 160));
            else if(!t.xfb) this.note3("a capture of no varying");
            else
            {
                entry = { module: this.device.createShaderModule({ label: "GLES 3 capture", code: "diagnostic(off, derivative_uniformity);\n" + t.wgsl }),
                    bindings: new Set(t.entries[0].bindings.filter(b => b[0] === 0).map(b => b[1])), xfb: t.xfb, pipelines: new Map() };
            }
        }
        gpu.xfb.set(key, entry);
        return entry;
    },

    /**
     * A capture's compute pass (xfb3's entry): `vertex_count` vertices from
     * `first_vertex` of each of the instances into the scratch buffers
     * (one a transform feedback buffer the shader writes)
     */
    capture_pass3(entry, group, vertex, first_vertex, vertex_count, instances, scratch)
    {
        const { buffers, slots } = entry.xfb;
        const own = group.groups[0].entries.filter(e => entry.bindings.has(e.binding)).map(e => Object.assign({}, e, { visibility: 4 }));
        const capture = [{ binding: 960, visibility: 4, buffer: { type: "uniform" } },
            ...slots.map(s => ({ binding: 961 + s, visibility: 4, buffer: { type: "read-only-storage" } })),
            ...buffers.map(b => ({ binding: 970 + b, visibility: 4, buffer: { type: "storage" } }))];
        const key = JSON.stringify(own) + JSON.stringify(capture);
        let p = entry.pipelines.get(key);
        if(!p)
        {
            const layouts = [this.device.createBindGroupLayout({ entries: own }), this.device.createBindGroupLayout({ entries: capture })];
            p = { layouts, pipeline: this.device.createComputePipeline({ label: "GLES 3 capture",
                layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module: entry.module, entryPoint: "vx_xfb" } }) };
            entry.pipelines.set(key, p);
        }
        // (VxXfbParams: first vertex, vertices an instance, first instance, instances, first capture, the vertices captured,
        // pads, the buffers' offsets, each slot's offset)
        const total = vertex_count * instances;
        const params = new Uint32Array(20);
        params.set([first_vertex, vertex_count, 0, instances, 0, total]);
        vertex.slots.forEach((s, slot) => { params[12 + slot] = s.offset; });
        const resources = [{ binding: 960, resource: { buffer: this.uniform_buffer(params.buffer) } },
            ...slots.map(s => ({ binding: 961 + s, resource: { buffer: vertex.slots[s].gpu } })),
            ...buffers.map((b, i) => ({ binding: 970 + b, resource: { buffer: scratch[i] } }))];
        this.end_pass();
        const pass = this.encoder.beginComputePass({ label: "GLES 3 capture" });
        pass.setPipeline(p.pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: p.layouts[0], entries: group.groups[0].resources.filter(r => entry.bindings.has(r.binding)) }));
        pass.setBindGroup(1, this.device.createBindGroup({ layout: p.layouts[1], entries: resources }));
        pass.dispatchWorkgroups(Math.ceil(total / 64));
        pass.end();
    },

    /**
     * A draw's vertices captured while transform feedback is active (not
     * paused): the vertex shader run as a compute shader into scratch
     * buffers, copied after what the bound buffers hold already (the
     * shadow counted the draw's vertices into the feedback's)
     */
    capture3(c, program, group, vertex, mode, first, count, instances, rebase)
    {
        const tf = c.tfs && c.tfs.get(c.tf);
        if(!tf || !tf.active || tf.paused) return;
        const per = mode === 0 ? 1 : mode === 1 ? 2 : 3;
        const each = Math.floor(count / per) * per, total = each * instances;
        if(!total) return;
        const entry = this.xfb3(program, vertex);
        if(!entry) return;
        const { buffers, strides } = entry.xfb;
        const scratch = buffers.map(b => this.device.createBuffer({ label: "GLES capture", size: Math.max(16, align4(total * strides[b])),
            usage: B.STORAGE | B.COPY_SRC }));
        this.staging.push(...scratch);
        this.capture_pass3(entry, group, vertex, rebase ? 0 : first, each, instances, scratch);
        buffers.forEach((b, i) =>
        {
            const binding = tf.bindings[b];
            const buffer = binding && c.group.buffers.get(binding.buffer);
            if(!buffer) return;
            const gpu = this.gpu_buffer(buffer);
            const at = binding.offset + (tf.vertices[b] - total) * strides[b];
            const bytes = Math.min(total * strides[b], gpu.size - at);
            if(at >= 0 && bytes > 0) this.encoder.copyBufferToBuffer(scratch[i], 0, gpu.buffer, at, bytes);
        });
        this.stats.captures = (this.stats.captures || 0) + 1;
    },

    /** BUFFER_READ: a buffer's bytes (a map of one the GPU wrote) read back for the CPU side */
    buffer_read3(record)
    {
        const conn = this.conns.get(record.conn);
        const c = conn && this.shadow.context(conn.context);
        const buffer = c && c.group.buffers.get(record.buffer);
        if(!buffer || record.offset + record.length > buffer.size) return this.answer_failed(record.request);
        const gpu = this.gpu_buffer(buffer);
        const low = record.offset & ~3, high = align4(record.offset + record.length);
        this.end_pass();
        const read = this.device.createBuffer({ label: "GLES buffer read", size: Math.max(4, high - low), usage: B.COPY_DST | B.MAP_READ });
        if(high > low) this.encoder.copyBufferToBuffer(gpu.buffer, low, read, 0, high - low);
        this.reads.push({ buffer: read, bytes: record.length, skip: record.offset - low, done: (bytes, sink) =>
        {
            const copy = cpu_bytes(buffer);
            for(const [offset, n] of copy ? buffer.packed || [] : [])
            {
                const from = Math.max(offset, record.offset), to = Math.min(offset + n, record.offset + record.length);
                if(to > from) bytes.set(copy.subarray(from, to), from - record.offset);
            }
            this.answer(sink, record.request, bytes);
        } });
        return undefined;
    },

    // ---- bind groups

    /** The texture unit a sampler's element samples: the texture bound to its type's target, the sampler state */
    texture_unit3(c, program, b, e)
    {
        const binding = program.info.bindings.find(x => x.binding === b && x.kind === "sampler");
        const values = binding && binding.location >= 0 ? program.values.get(binding.location + e) : null;
        const unit = Math.max(0, Math.min(c.textures.length - 1, values ? values[0] : 0));
        const slot = binding && SAMPLER_SLOT.has(binding.type) ? SAMPLER_SLOT.get(binding.type) : 0;
        const name = c.textures[unit][slot];
        const texture = name ? c.group.textures.get(name) : c.defaults ? c.defaults.get(SLOT_TARGET[slot]) : null;
        const sampler = c.samplers && c.samplers[unit] ? c.group.samplers.get(c.samplers[unit]) : null;
        return { texture: texture || null, state: sampler || texture || NO_SAMPLER };
    },

    /**
     * The program's samplers that clamp to the border (GLES 3.2), as
     * vx_naga's border.rs takes them in the wraps list: [image key, address
     * modes], and each border color component [BORDER_COLOR | k << 24 | key, its bits]
     */
    border_wraps3(c, program, group)
    {
        const entries = [];
        if(c.version < 32) return entries;
        const mode = w => w in VK_WRAP ? VK_WRAP[w] : 0;
        for(const binding of program.info.bindings)
        {
            if(binding.kind !== "sampler") continue;
            for(let e = 0; e < Math.max(1, binding.size); e++)
            {
                const { state } = this.texture_unit3(c, program, binding.binding, e);
                if(state.wrap_s !== 0x812D && state.wrap_t !== 0x812D && state.wrap_r !== 0x812D) continue;
                const key = group << 16 | (e ? ELEMENTS + 2 * (16 * binding.binding + e) : 2 * binding.binding);
                entries.push([key, mode(state.wrap_s) | mode(state.wrap_t) << 4 | mode(state.wrap_r || 0x2901) << 8]);
                const bits = new Uint32Array(new Float32Array(state.border_color || [0, 0, 0, 0]).buffer);
                bits.forEach((b, k) => entries.push([(BORDER_COLOR | k << 24 | key) >>> 0, b]));
            }
        }
        return entries;
    },

    /** The wraps of the samplers of a program's integer textures (vx_naga's int_wraps: [group << 16 | binding, modes]) */
    int_wraps3(c, program, fetched)
    {
        const wraps = [];
        for(const key of fetched)
        {
            const { b, e } = spirv_binding(key & 0xFFFF);
            const { state } = this.texture_unit3(c, program, b, e);
            const mode = w => w in VK_WRAP ? VK_WRAP[w] : 0;
            const modes = mode(state.wrap_s) | mode(state.wrap_t) << 4 | mode(state.wrap_r || 0x2901) << 8;
            if(modes !== 0x222) wraps.push([key, modes]);
        }
        return wraps.sort((x, y) => x[0] - y[0]);
    },

    /**
     * A draw's or a dispatch's bind groups: each binding's resource by its
     * kind and its program's state (the default uniform block, samplers'
     * textures and samplers, uniform blocks, storage blocks, atomic counter
     * buffers, image units), the layouts by the resources' types
     * @param {!Array<!Object>} bindings bindings3's
     * @return {?{groups: !Array<{index: number, layout: !GPUBindGroupLayout, entries: !Array<!Object>, resources: !Array<!Object>}>,
     *     pipeline_layout: !GPUPipelineLayout, key: string}}
     */
    bind_groups3(c, bindings, target)
    {
        const by_group = new Map();
        const samplings = new Map();
        const declarations = new Map(bindings.map(b => [b.group + ":" + b.binding, b.type]));
        for(const b of bindings)
        {
            if(!by_group.has(b.group)) by_group.set(b.group, { entries: [], resources: [] });
            const got = this.binding3(c, b, target, samplings, declarations);
            if(!got) return null;
            by_group.get(b.group).entries.push(Object.assign({ binding: b.binding, visibility: b.visibility }, got.entry));
            by_group.get(b.group).resources.push({ binding: b.binding, resource: got.resource });
        }
        // (the groups up to the last one used; one used by no stage has no entries)
        const count = by_group.size ? Math.max(...by_group.keys()) + 1 : 1;
        this.layouts3 = this.layouts3 || new Map();
        const layout_of = entries =>
        {
            const key = JSON.stringify(entries);
            let layout = this.layouts3.get(key);
            if(!layout) this.layouts3.set(key, layout = { group: this.device.createBindGroupLayout({ label: "GLES 3 resources", entries }),
                id: this.layouts3.size + 1 });
            return layout;
        };
        const groups = [];
        for(let index = 0; index < count; index++)
        {
            const g = by_group.get(index) || { entries: [], resources: [] };
            const layout = layout_of(g.entries);
            groups.push({ index, layout: layout.group, entries: g.entries, resources: g.resources, id: layout.id });
        }
        const key = groups.map(g => g.id).join(".");
        this.pipeline_layouts3 = this.pipeline_layouts3 || new Map();
        let pipeline_layout = this.pipeline_layouts3.get(key);
        if(!pipeline_layout) this.pipeline_layouts3.set(key, pipeline_layout = this.device.createPipelineLayout({ bindGroupLayouts: groups.map(g => g.layout) }));
        return { groups, pipeline_layout, key };
    },

    /** One binding's layout entry (without its binding and visibility) and resource, or null (noted) */
    binding3(c, b, target, samplings, declarations)
    {
        const { binding, kind, program } = b;
        const buffer_type = kind === "uniform" ? "uniform" : kind === "storage" ? "read-only-storage" : "storage";
        if(binding === 0) return { entry: { buffer: { type: buffer_type } }, resource: { buffer: this.default_block3(program, b.size) } };
        const { b: spirv, e } = spirv_binding(binding);
        if(spirv >= BINDING.SAMPLERS && spirv < BINDING.UNIFORM_BLOCKS)
        {
            const key = this.id_of(program) + ":" + b.group + ":" + spirv + ":" + e;
            let sampling = samplings.get(key);
            const destination = !sampling && program.info.bindings.some(x => x.binding === spirv && x.kind === "sampler" && x.blend_destination);
            if(destination)
            {
                // (an advanced blend's destination, texelFetch's: the draw's copy, or a texel of zeros)
                const tex = texture_type(declarations.get(b.group + ":" + (binding & ~1)));
                const view = this.blend_dst3 ? this.blend_dst3.view : this.fallback3(tex).view;
                sampling = { view, sample_type: "float", filtering: false, state: NO_SAMPLER, tex };
                samplings.set(key, sampling);
            }
            if(!sampling)
            {
                const unit = this.texture_unit3(c, program, spirv, e);
                const tex = texture_type(declarations.get(b.group + ":" + (binding & ~1)));
                sampling = Object.assign(this.texture_view3(unit.texture, unit.state, tex, target), { state: unit.state, tex });
                samplings.set(key, sampling);
            }
            if(kind.startsWith("texture"))
            {
                return { entry: { texture: { sampleType: sampling.sample_type, viewDimension: sampling.tex.dimension, multisampled: sampling.tex.multisampled } },
                    resource: sampling.view };
            }
            const comparison = kind === "sampler-comparison";
            return { entry: { sampler: { type: comparison ? "comparison" : sampling.filtering ? "filtering" : "non-filtering" } },
                resource: this.sampler3(sampling.state, sampling.filtering, comparison) };
        }
        if(spirv >= BINDING.UNIFORM_BLOCKS && spirv < BINDING.STORAGE_BLOCKS && kind !== "storage-rw")
        {
            return { entry: { buffer: { type: buffer_type } }, resource: this.block3(c, program, spirv - BINDING.UNIFORM_BLOCKS + e, b.size) };
        }
        if(spirv >= BINDING.STORAGE_BLOCKS && spirv < BINDING.ATOMIC_COUNTERS)
        {
            const block = (program.info.storage_blocks || [])[spirv - BINDING.STORAGE_BLOCKS + e];
            return { entry: { buffer: { type: buffer_type } }, resource: this.storage3(c, c.storage_bindings, block ? block.binding : 0, b.size, buffer_type === "storage") };
        }
        if(spirv >= BINDING.ATOMIC_COUNTERS && spirv < BINDING.IMAGES)
        {
            return { entry: { buffer: { type: "storage" } }, resource: this.storage3(c, c.atomic_bindings, spirv - BINDING.ATOMIC_COUNTERS, b.size, true) };
        }
        if(spirv >= BINDING.IMAGES && kind === "storage-texture")
        {
            const image = program.info.bindings.find(x => x.binding === spirv && x.kind === "image");
            return this.image3(c, (image && image.unit || 0) + e, declarations.get(b.group + ":" + binding));
        }
        return this.note3("a binding of " + kind);
    },

    /**
     * A storage block's or an atomic counter buffer's range: what its binding
     * point holds (for nothing: zeros to read, or a buffer nothing reads to
     * write); a range shorter than the binding's least size (its WGSL
     * type's: an unsized array of no elements, the padding after the last)
     * is that size, of the buffer's memory after it (G-81)
     * @param {!Array<{buffer: number, offset: number, size: number}>} points the context's binding points of the kind
     */
    storage3(c, points, point, size, writable)
    {
        const zeros = () => ({ buffer: writable ? this.discard3(size) : this.zeros3(size), offset: 0, size: Math.max(16, align4(size)) });
        const b = points ? points[point] : null;
        const buffer = b && b.buffer ? c.group.buffers.get(b.buffer) : null;
        if(!buffer || !buffer.size || b.offset % 256 || b.offset >= buffer.size) return zeros();
        let length = b.size ? Math.min(b.size, buffer.size - b.offset) : buffer.size - b.offset;
        length = align4(Math.max(length, size));
        const gpu = this.gpu_buffer(buffer, b.offset + length);
        return { buffer: gpu.buffer, offset: b.offset, size: length };
    },

    /**
     * An image unit's texture as a storage texture of the WGSL type's
     * format, access and dimension: the unit's level, its layer unless it is
     * bound layered; a texture of another format binds a texture of nothing
     */
    image3(c, unit, type)
    {
        const m = /^texture_storage_(2d_array|2d|3d)<(\w+),\s*(\w+)>/.exec(type || "");
        if(!m) return this.note3("an image of a WGSL type " + type);
        const dimension = m[1].replace("_", "-"), format = m[2];
        const access = { read: "read-only", write: "write-only", read_write: "read-write" }[m[3]];
        const entry = { storageTexture: { access, format, viewDimension: dimension } };
        const u = c.image_units && c.image_units[unit];
        const texture = u && u.texture ? c.group.textures.get(u.texture) : null;
        const gpu = texture && this.gpu_texture3(texture);
        // (a texture of another format, or a 3D texture's layer as a 2D image: a copy, image_proxy3's)
        const proxy = gpu && (gpu.format !== format || !gpu.storage || gpu.three && dimension === "2d") ?
            this.image_proxy3(gpu, u, format, dimension, access) : null;
        if(proxy) return { entry, resource: proxy };
        if(!gpu || gpu.format !== format || !gpu.storage || gpu.three && dimension === "2d")
        {
            if(gpu) this.note3("an image unit's texture of a format or size the image cannot take");
            // (one to read for all, one of its own each to write: WebGPU refuses a texture bound to write with another binding)
            this.empty_images3 = this.empty_images3 || new Map();
            const key = format + ":" + dimension;
            let view = access === "read-only" ? this.empty_images3.get(key) : null;
            if(!view)
            {
                const empty = this.device.createTexture({ label: "GLES empty image", size: [1, 1, 1], dimension: dimension === "3d" ? "3d" : "2d", format,
                    usage: U.STORAGE_BINDING });
                view = empty.createView({ dimension });
                if(access === "read-only") this.empty_images3.set(key, view);
                else this.staging.push(empty);
            }
            return { entry, resource: view };
        }
        const mip = Math.max(0, u.level - gpu.first);
        const key = "image:" + dimension + ":" + mip + ":" + (u.layered ? "all" : u.layer);
        let view = gpu.views.get(key);
        if(!view)
        {
            view = gpu.texture.createView({ dimension, baseMipLevel: mip, mipLevelCount: 1,
                ...(dimension === "2d" ? { baseArrayLayer: gpu.three ? 0 : u.layer, arrayLayerCount: 1 } : {}) });
            gpu.views.set(key, view);
        }
        return { entry, resource: view };
    },

    /**
     * An image unit's level (its layer, or all of them for a layered unit)
     * where the texture cannot be the image itself: another format of the
     * same texel size (GL reinterprets the bits, WebGPU views no other
     * format), a 3D texture's layer as a 2D image (WebGPU views no 2D
     * slice), a format WebGPU stores no texels of. A texture of the image's
     * format and size gets the texels (through a buffer: the bits as they
     * are) before the pass, and gives them back after it unless the image
     * is read-only (image_writes3, dispatch3's)
     * @return {?GPUTextureView} null where the sizes differ
     */
    image_proxy3(gpu, u, format, dimension, access)
    {
        const texel = TEXEL_BYTES[format];
        const mip = u.level - gpu.first;
        if(!texel || TEXEL_BYTES[gpu.format] !== texel || gpu.samples > 1 || gpu.block > 1 || mip < 0 || mip >= gpu.levels) return null;
        const width = Math.max(1, gpu.width >> mip), height = Math.max(1, gpu.height >> mip);
        const layers = gpu.three ? Math.max(1, gpu.depth >> mip) : gpu.depth;
        const first = dimension === "2d" ? u.layer : 0, count = dimension === "2d" ? 1 : layers;
        if(first + count > layers) return null;
        gpu.proxies = gpu.proxies || new Map();
        const key = format + ":" + dimension + ":" + mip + ":" + first;
        let proxy = gpu.proxies.get(key);
        if(!proxy)
        {
            const created = this.device.createTexture({ label: "GLES image proxy", size: [width, height, count], dimension: dimension === "3d" ? "3d" : "2d",
                format, usage: U.STORAGE_BINDING | U.COPY_SRC | U.COPY_DST });
            proxy = { texture: created, view: created.createView({ dimension }) };
            gpu.proxies.set(key, proxy);
        }
        const bytes_per_row = Math.ceil(width * texel / 256) * 256;
        const buffer = this.device.createBuffer({ label: "GLES image proxy copy", size: bytes_per_row * height * count, usage: B.COPY_SRC | B.COPY_DST });
        this.staging.push(buffer);
        const layout = { buffer, bytesPerRow: bytes_per_row, rowsPerImage: height };
        const size = [width, height, count];
        const own = { texture: gpu.texture, mipLevel: mip, origin: [0, 0, first] };
        this.end_pass();
        this.encoder.copyTextureToBuffer(own, layout, size);
        this.encoder.copyBufferToTexture(layout, { texture: proxy.texture }, size);
        if(access !== "read-only" && this.image_writes3)
        {
            this.image_writes3.push(() =>
            {
                this.encoder.copyTextureToBuffer({ texture: proxy.texture }, layout, size);
                this.encoder.copyBufferToTexture(layout, own, size);
            });
        }
        return proxy.view;
    },

    /** The default uniform block's buffer: the program's values by their offsets (made again when they change) */
    default_block3(program, size)
    {
        const gpu = this.program_gpu(program);
        const version = program.values_version || 0;
        if(gpu.uniforms && gpu.uniforms.version === version && gpu.uniforms.size >= size) return gpu.uniforms.buffer;
        const info = program.info;
        const bytes = new ArrayBuffer(Math.ceil(Math.max(16, size, info.default_block_size || 0) / 16) * 16);
        const view = new DataView(bytes);
        for(const u of info.uniforms)
        {
            if(u.block_index >= 0 || u.opaque || u.location < 0 || u.offset < 0) continue;
            for(let e = 0; e < u.size; e++)
            {
                const values = program.values.get(u.location + e);
                if(!values) continue;
                const base = u.offset + e * (u.array_stride || 0);
                if(u.columns)
                {
                    for(let col = 0; col < u.columns; col++)
                    {
                        for(let row = 0; row < u.rows; row++)
                        {
                            const at = base + (u.row_major ? row * u.matrix_stride + col * 4 : col * u.matrix_stride + row * 4);
                            if(at + 4 <= bytes.byteLength) view.setFloat32(at, values[col * u.rows + row] || 0, true);
                        }
                    }
                    continue;
                }
                for(let i = 0; i < u.components && base + 4 * i + 4 <= bytes.byteLength; i++)
                {
                    const v = values[i] || 0;
                    if(!u.int) view.setFloat32(base + 4 * i, v, true);
                    else if(u.uint || u.bool) view.setUint32(base + 4 * i, v >>> 0, true);
                    else view.setInt32(base + 4 * i, v | 0, true);
                }
            }
        }
        const buffer = this.device.createBuffer({ label: "GLES default uniforms", size: bytes.byteLength, usage: B.UNIFORM | B.STORAGE, mappedAtCreation: true });
        new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(bytes));
        buffer.unmap();
        if(gpu.uniforms) this.staging.push(gpu.uniforms.buffer);
        gpu.uniforms = { version, size: bytes.byteLength, buffer };
        return buffer;
    },

    /** A uniform block's buffer range: what its binding point holds (zeros for nothing; at least the block's WGSL size) */
    block3(c, program, index, size)
    {
        const block = program.info.blocks[index];
        const point = program.block_bindings ? program.block_bindings[index] : block ? block.binding : 0;
        const b = c.uniform_bindings[point];
        const buffer = b && b.buffer ? c.group.buffers.get(b.buffer) : null;
        const zeros = () => ({ buffer: this.zeros3(size), offset: 0, size: Math.max(16, align4(size)) });
        const offset = b ? b.offset : 0;
        if(!buffer || !buffer.size || offset % 256 || offset >= buffer.size) return zeros();
        // (a range shorter than the block's WGSL size: that size, of the buffer's memory after it, as storage3's)
        let length = b.size ? Math.min(b.size, buffer.size - offset) : buffer.size - offset;
        length = align4(Math.max(length, size));
        const gpu = this.gpu_buffer(buffer, offset + length);
        return { buffer: gpu.buffer, offset, size: length };
    },

    /**
     * A texture's view as a sampler of the WGSL type samples it, by GLES
     * 3.0's completeness (3.8.13: levels base to max, cube faces, filters of
     * formats that filter no texels), or the fallback's
     * @return {{view: !GPUTextureView, sample_type: string, filtering: boolean}}
     */
    texture_view3(texture, state, tex, target)
    {
        const fallback = () => this.fallback3(tex);
        if(!texture) return fallback();
        const level0 = texture.images.get(0);
        if(level0 && (level0.image || level0.color_buffer))
        {
            const t = level0.image ? this.image_texture(level0.image) : this.color_buffer_texture(level0.color_buffer);
            if(!t || tex.sample !== "float" || tex.dimension !== "2d" || target.textures.has(t.texture)) return fallback();
            return { view: t.texture.createView(), sample_type: "float", filtering: true };
        }
        const gpu = this.gpu_texture3(texture);
        if(!gpu || target.textures.has(gpu.texture)) return fallback();
        if(tex.multisampled !== (gpu.samples > 1)) return fallback();
        if(tex.multisampled)
        {
            // (GLES 3.1's multisampled textures: texelFetch of a sample, no sampler state)
            const kind = format_kind(gpu.format);
            const sample_type = kind === "depth" ? (tex.sample === "depth" ? "depth" : "unfilterable-float") : kind === "i" ? "sint" : kind === "u" ? "uint" :
                "unfilterable-float";
            if((tex.sample === "sint") !== (kind === "i") || (tex.sample === "uint") !== (kind === "u")) return fallback();
            let view = gpu.views.get("ms");
            if(!view) gpu.views.set("ms", view = gpu.texture.createView({ dimension: "2d", aspect: gpu.format.includes("stencil") ? "depth-only" : "all" }));
            return { view, sample_type, filtering: false };
        }
        const three = gpu.three, cube = gpu.cube;
        let base = texture.base_level || 0;
        if(texture.immutable) base = Math.min(base, texture.immutable_levels - 1);
        const first = texture.images.get(base);
        if(!first || !first.width || !first.height) return fallback();
        const internal = image_internal(first);
        const info = format_info(internal);
        const kind = info ? info.kind : "unorm";
        // (GLES 3.1's DEPTH_STENCIL_TEXTURE_MODE STENCIL_INDEX: a depth and stencil texture's stencil, unsigned integers)
        const stencil = kind === "depth_stencil" && texture.depth_stencil_mode === STENCIL_INDEX;
        const depth = !stencil && (kind === "depth" || kind === "depth_stencil");
        const mipmapped = state.min_filter !== NEAREST && state.min_filter !== LINEAR;
        const max_level = texture.max_level === undefined ? 1000 : texture.max_level;
        const chain = base + Math.floor(Math.log2(Math.max(first.width, first.height, three ? first.depth || 1 : 1)));
        const top = !mipmapped ? base : Math.min(max_level, texture.immutable ? texture.immutable_levels - 1 : chain);
        if(top < base) return fallback();
        if(cube && first.width !== first.height) return fallback();
        for(let level = base; level <= top; level++)
        {
            const w = Math.max(1, first.width >> level - base), h = Math.max(1, first.height >> level - base);
            const d = three ? Math.max(1, (first.depth || 1) >> level - base) : first.depth || 1;
            for(let face = 0; face < (cube ? 6 : 1); face++)
            {
                const image = texture.images.get(face * 32 + level);
                if(!image || image.width !== w || image.height !== h || (image.depth || 1) !== d || image_internal(image) !== internal) return fallback();
            }
        }
        const compare = depth && state.compare_mode === COMPARE_REF_TO_TEXTURE;
        const filterable = !stencil && (!info || info.filterable || compare);
        const linear = state.mag_filter !== NEAREST || state.min_filter !== NEAREST && state.min_filter !== NEAREST_MIPMAP_NEAREST;
        if(!filterable && linear) return fallback();
        let sample_type;
        if(tex.sample === "depth") sample_type = depth ? "depth" : null;
        else if(tex.sample === "sint") sample_type = kind === "int" ? "sint" : null;
        else if(tex.sample === "uint") sample_type = kind === "uint" || stencil ? "uint" : null;
        else sample_type = kind === "int" || kind === "uint" ? null : depth || !filterable || info && !info.filterable ? "unfilterable-float" : "float";
        if(!sample_type) return fallback();
        const mip = base - gpu.first, count = top - base + 1;
        if(mip < 0 || mip + count > gpu.levels) return fallback();
        const aspect = stencil ? "stencil-only" : gpu.format.includes("stencil") && gpu.format !== "stencil8" ? "depth-only" : "all";
        const dimension = tex.dimension;
        if((dimension === "3d") !== three || dimension === "cube" && !cube || dimension === "cube-array" && !(gpu.array && gpu.depth % 6 === 0)) return fallback();
        // (TEXTURE_SWIZZLE_*: the view's, with WebGPU's texture-component-swizzle)
        let swizzle = (texture.swizzle || [0x1903, 0x1904, 0x1905, 0x1906]).map(v => ({ 0x1903: "r", 0x1904: "g", 0x1905: "b", 0x1906: "a", 0: "0", 1: "1" })[v]).join("");
        if(swizzle !== "rgba" && !this.device.features.has("texture-component-swizzle"))
        {
            this.note3("TEXTURE_SWIZZLE without WebGPU's texture-component-swizzle");
            swizzle = "rgba";
        }
        const key = dimension + ":" + mip + ":" + count + ":" + aspect + ":" + swizzle;
        let view = gpu.views.get(key);
        if(!view)
        {
            view = gpu.texture.createView({ dimension, baseMipLevel: mip, mipLevelCount: count, aspect,
                ...(dimension === "2d" ? { arrayLayerCount: 1 } : {}), ...(swizzle !== "rgba" ? { swizzle } : {}) });
            gpu.views.set(key, view);
        }
        return { view, sample_type, filtering: sample_type === "float" };
    },

    /** What an incomplete texture samples as, of the WGSL type's dimension and kind: (0, 0, 0, 1) */
    fallback3(tex)
    {
        const key = tex.dimension + ":" + tex.sample + (tex.multisampled ? ":ms" : "");
        this.fallbacks3 = this.fallbacks3 || new Map();
        let fallback = this.fallbacks3.get(key);
        if(fallback) return fallback;
        if(tex.multisampled)
        {
            // (4 samples, cleared by a pass of its own: no copy reaches a multisampled texture)
            const depth = tex.sample === "depth";
            const format = depth ? "depth16unorm" : tex.sample === "sint" ? "rgba8sint" : tex.sample === "uint" ? "rgba8uint" : COLOR_FORMAT;
            const texture = this.device.createTexture({ label: "GLES incomplete texture", size: [1, 1], format, sampleCount: 4,
                usage: U.TEXTURE_BINDING | U.RENDER_ATTACHMENT });
            const view = texture.createView();
            const encoder = this.device.createCommandEncoder();
            encoder.beginRenderPass(depth ? { colorAttachments: [], depthStencilAttachment: { view, depthLoadOp: "clear", depthClearValue: 0, depthStoreOp: "store" } } :
                { colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }] }).end();
            this.device.queue.submit([encoder.finish()]);
            fallback = { view, sample_type: tex.sample === "float" ? "unfilterable-float" : tex.sample, filtering: false };
            this.fallbacks3.set(key, fallback);
            return fallback;
        }
        const format = tex.sample === "depth" ? "depth16unorm" : tex.sample === "sint" ? "rgba8sint" : tex.sample === "uint" ? "rgba8uint" : COLOR_FORMAT;
        const layers = tex.dimension === "cube" ? 6 : 1;
        const texture = this.device.createTexture({ label: "GLES incomplete texture", size: [1, 1, layers], dimension: tex.dimension === "3d" ? "3d" : "2d",
            format, usage: U.TEXTURE_BINDING | U.COPY_DST });
        const texel = format === "depth16unorm" ? [0, 0] : format === COLOR_FORMAT ? [0, 0, 0, 255] : [0, 0, 0, 1];
        const data = new Uint8Array(texel.length * layers);
        for(let i = 0; i < layers; i++) data.set(texel, i * texel.length);
        this.device.queue.writeTexture({ texture }, data, { bytesPerRow: texel.length, rowsPerImage: 1 }, [1, 1, layers]);
        fallback = { view: texture.createView({ dimension: tex.dimension }), sample_type: tex.sample === "float" ? "float" : tex.sample,
            filtering: tex.sample === "float" };
        this.fallbacks3.set(key, fallback);
        return fallback;
    },

    /** A sampler of a sampler object's (or texture's) state; nearest only for a texture that filters no texels */
    sampler3(state, filtering, comparison)
    {
        const min = state.min_filter, mag = state.mag_filter;
        const lod_min = Math.min(32, Math.max(0, state.min_lod === undefined ? -1000 : state.min_lod));
        const lod_max = Math.min(32, Math.max(lod_min, state.max_lod === undefined ? 1000 : state.max_lod));
        const compare = comparison ? COMPARE[state.compare_func || 0x0203] : undefined;
        const key = [min, mag, state.wrap_s, state.wrap_t, state.wrap_r, lod_min, lod_max, filtering, compare].join("|");
        let sampler = this.samplers.get(key);
        if(!sampler)
        {
            const linear = f => filtering && (f === LINEAR || f === 0x2701 || f === 0x2703);
            sampler = this.device.createSampler(Object.assign({
                addressModeU: WRAPS[state.wrap_s] || "repeat", addressModeV: WRAPS[state.wrap_t] || "repeat", addressModeW: WRAPS[state.wrap_r] || "repeat",
                magFilter: filtering && mag === LINEAR ? "linear" : "nearest", minFilter: linear(min) ? "linear" : "nearest",
                mipmapFilter: filtering && (min === 0x2702 || min === 0x2703) ? "linear" : "nearest", lodMinClamp: lod_min, lodMaxClamp: lod_max,
            }, compare ? { compare } : {}));
            this.samplers.set(key, sampler);
        }
        return sampler;
    },

    /** The pipeline for the program, the vertex buffers, the resources, the state and the target */
    pipeline3(c, shaders, vertex, group, topology, strip_format, target, face)
    {
        // (an advanced equation: the fragment shader blends, glsl_es_rewrite.js's; its index the constant)
        const advanced = shaders.fragment.blend_constant ? advanced_blend(c) : -1;
        const blend = c.enabled.has(BLEND) && advanced < 0;
        const depth_test = c.enabled.has(DEPTH_TEST) && !(target.depth && target.depth.gl_depth === false);
        const stencil_test = c.enabled.has(STENCIL_TEST) && !(target.depth && target.depth.gl_stencil === false);
        const cull = face === 0 ? "back" : face === 1 ? "front" : c.enabled.has(CULL_FACE) ? (c.cull_face === 0x0404 ? "front" : "back") : "none";
        const masks = face === undefined ? 0 : face;
        const depth_format = target.depth ? target.depth.format : "";
        const key = ["3", shaders.id, vertex.key, group.key, topology, strip_format || "", c.front_face, cull, masks,
            target.colors.map(a => a ? a.format + (a.unwritten ? "!" : "") + (a.no_alpha ? "~" : "") : "-").join(","), target.alpha ? "a" : "x", depth_format, target.samples,
            c.enabled.has(0x8E51) ? c.sample_mask : "-", c.enabled.has(0x809E) ? "c" : "-",
            blend ? c.blend_func.join(",") + "/" + c.blend_equation.join(",") : advanced >= 0 ? "advanced" + advanced : "-", c.color_mask.join(""),
            depth_test ? c.depth_func + ":" + c.depth_mask : "-",
            stencil_test ? JSON.stringify([c.stencil_func, c.stencil_op, c.stencil_writemask]) : "-",
            c.enabled.has(POLYGON_OFFSET_FILL) ? c.polygon_offset.join(",") : "-"].join("|");
        let pipeline = this.pipelines.get(key);
        if(pipeline) return pipeline;
        const write_mask = (c.color_mask[0] ? 1 : 0) | (c.color_mask[1] ? 2 : 0) | (c.color_mask[2] ? 4 : 0) | (c.color_mask[3] && target.alpha ? 8 : 0);
        const targets = target.colors.map((a, i) =>
        {
            if(!a) return null;
            // (an output the shader lacks or of another kind: nothing written, GL leaves it undefined)
            const output = shaders.outputs.get(i);
            const kind = format_kind(a.format);
            const fits = !a.unwritten && output && (kind === "f" ? !/[iu]32/.test(output) : output.includes(kind === "i" ? "i32" : "u32"));
            return { format: a.format, writeMask: fits ? write_mask & (a.no_alpha ? 7 : 15) : 0, blend: blend && fits && blendable(a.format) ? {
                color: blend_component(c.blend_equation[0], c.blend_func[0], c.blend_func[1]),
                alpha: blend_component(c.blend_equation[1], c.blend_func[2], c.blend_func[3]),
            } : undefined };
        });
        const descriptor = {
            label: "GLES 3 pipeline", layout: group.pipeline_layout,
            vertex: { module: shaders.vertex.module, entryPoint: shaders.vertex.entry,
                buffers: vertex.slots.map(s => ({ arrayStride: s.stride, stepMode: s.step, attributes: s.attributes })) },
            fragment: { module: shaders.fragment.module, entryPoint: shaders.fragment.entry, targets,
                constants: Object.assign({}, shaders.fragment.samples_constant ? { [SAMPLES_CONSTANT]: target.samples } : {},
                    shaders.fragment.blend_constant ? { [BLEND_CONSTANT]: Math.max(0, advanced) } : {}) },
            // (the Y flip reverses the winding: GL's CCW is WebGPU's CW)
            primitive: { topology, frontFace: c.front_face === 0x0901 ? "cw" : "ccw", cullMode: cull, ...(strip_format ? { stripIndexFormat: strip_format } : {}) },
            // (the sample mask, GLES 3.1's; alpha to coverage, of multisampled targets)
            multisample: { count: target.samples, mask: c.enabled.has(0x8E51) ? c.sample_mask >>> 0 : 0xFFFFFFFF,
                alphaToCoverageEnabled: c.enabled.has(0x809E) && target.samples > 1 && shaders.outputs.has(0) },
        };
        if(target.depth)
        {
            const stencil = depth_format.includes("stencil");
            const face_state = i => ({ compare: COMPARE[c.stencil_func[i][0]], failOp: STENCIL_OPS[c.stencil_op[i][0]],
                depthFailOp: STENCIL_OPS[c.stencil_op[i][1]], passOp: STENCIL_OPS[c.stencil_op[i][2]] });
            descriptor.depthStencil = Object.assign({ format: depth_format },
                depth_format !== "stencil8" ? { depthWriteEnabled: depth_test && !!c.depth_mask, depthCompare: depth_test ? COMPARE[c.depth_func] : "always" } : {},
                stencil && stencil_test ? { stencilFront: face_state(0), stencilBack: face_state(1), stencilReadMask: c.stencil_func[masks][2] & 0xFF,
                    stencilWriteMask: c.stencil_writemask[masks] & 0xFF } : {},
                c.enabled.has(POLYGON_OFFSET_FILL) && depth_format !== "stencil8" ? { depthBias: Math.round(c.polygon_offset[1]),
                    depthBiasSlopeScale: c.polygon_offset[0] } : {});
        }
        try
        {
            pipeline = this.device.createRenderPipeline(descriptor);
        }
        catch(error)
        {
            if(this.stats.errors.length < 20) this.stats.errors.push("pipeline: " + error.message);
            return null;
        }
        this.stats.pipelines++;
        this.pipelines.set(key, pipeline);
        return pipeline;
    },

    // ---- commands

    /**
     * A command of a GLES 3.x context after the shadow took it: what the GPU
     * does of it
     * @return {boolean} whether it was this one's (else GLES 2.0's handles it)
     */
    command3(c, name, args)
    {
        switch(name)
        {
            case "glTexImage2D": case "glTexImage2DOffsetAEMU": case "glTexImage3D": case "glTexImage3DOffsetAEMU":
            case "glTexSubImage2D": case "glTexSubImage2DOffsetAEMU": case "glTexSubImage3D": case "glTexSubImage3DOffsetAEMU":
                this.tex_image3(c, name, args);
                return true;
            case "glTexStorage2D": case "glTexStorage3D":
            {
                const { texture } = this.bound3(c, args[0]);
                if(texture) this.gpu_texture3(texture);
                return true;
            }
            case "glCompressedTexImage2D": case "glCompressedTexImage2DOffsetAEMU": case "glCompressedTexImage3D": case "glCompressedTexImage3DOffsetAEMU":
            case "glCompressedTexSubImage2D": case "glCompressedTexSubImage2DOffsetAEMU": case "glCompressedTexSubImage3D":
            case "glCompressedTexSubImage3DOffsetAEMU":
                this.compressed_image3(c, name, args);
                return true;
            case "glCopyTexImage2D": case "glCopyTexSubImage2D": case "glCopyTexSubImage3D":
                this.copy_tex_image3(c, name, args);
                return true;
            case "glGenerateMipmap": this.generate_mipmap3(c, args[0]); return true;
            case "glBufferData":
            {
                // (GLES 2.0's shadow keeps no bytes: the executor's own, `data`)
                if(c.api === 2) this.buffer_data(c, args, false);
                const buffer = this.buffer_of3(c, args[0]);
                if(buffer) buffer.dirty = [0, buffer.size];
                return true;
            }
            case "glBufferSubData":
                if(c.api === 2) this.buffer_data(c, args, true);
                this.buffer_written(this.buffer_of3(c, args[0]), args[1], args[2], args[3]);
                return true;
            case "glUnmapBufferAEMU":
            {
                const [target, offset, length, access, data] = args;
                if(access & GL3.MAP_WRITE_BIT && !(access & GL3.MAP_FLUSH_EXPLICIT_BIT)) this.buffer_written(this.buffer_of3(c, target), offset, length, data);
                return true;
            }
            case "glFlushMappedBufferRangeAEMU":
                // (the buffer's offset: gfxstream's decoder's)
                this.buffer_written(this.buffer_of3(c, args[0]), args[1], args[2], args[4]);
                return true;
            case "glCopyBufferSubData":
            {
                const [read_target, write_target, read_offset, write_offset, size] = args;
                const from = this.buffer_of3(c, read_target), to = this.buffer_of3(c, write_target);
                if(!from || !to || size <= 0) return true;
                if(!from.gpu_newer)
                {
                    const bytes = cpu_bytes(to);
                    this.buffer_written(to, write_offset, size, bytes && bytes.subarray(write_offset, write_offset + size));
                    return true;
                }
                if(read_offset % 4 || write_offset % 4 || size % 4)
                {
                    this.note3("an unaligned copy of a buffer the GPU wrote");
                    return true;
                }
                const a = this.gpu_buffer(from), b = this.gpu_buffer(to);
                this.end_pass();
                this.encoder.copyBufferToBuffer(a.buffer, read_offset, b.buffer, write_offset, size);
                return true;
            }
            case "glRenderbufferStorage": case "glRenderbufferStorageMultisample": this.renderbuffer_storage3(c); return true;
            case "glEGLImageTargetRenderbufferStorage":
            {
                const rb = c.group.renderbuffers.get(c.renderbuffer);
                if(rb && rb.gpu) this.staging.push(rb.gpu);
                if(rb) rb.gpu = null;
                return true;
            }
            case "glVertexAttribPointerData": c.attribs[args[0]].data = args[5]; return true;
            case "glVertexAttribIPointerDataAEMU": c.attribs[args[0]].data = args[4]; return true;
            case "glVertexAttribPointerOffset": case "glVertexAttribIPointerOffsetAEMU": c.attribs[args[0]].data = null; return true;
            case "glClear": this.clear3(c, args[0]); return true;
            case "glBlitFramebuffer": this.blit_framebuffer3(c, args); return true;
            case "glReadPixelsOffsetAEMU": this.read_pixels_pack3(c, args); return true;
            case "glClearBufferiv": case "glClearBufferuiv": case "glClearBufferfv": case "glClearBufferfi": this.clear_buffer3(c, name, args); return true;
            case "glDrawArrays": this.draw3(c, args[0], args[1], args[2], null, 1); return true;
            case "glDrawArraysInstanced": this.draw3(c, args[0], args[1], args[2], null, args[3]); return true;
            case "glDrawElementsData": this.draw3(c, args[0], 0, args[1], { type: args[2], bytes: args[3] }, 1); return true;
            case "glDrawElementsOffset": this.draw3(c, args[0], 0, args[1], { type: args[2], offset: args[3] }, 1); return true;
            case "glDrawElementsInstancedDataAEMU": this.draw3(c, args[0], 0, args[1], { type: args[2], bytes: args[3] }, args[4]); return true;
            case "glDrawElementsInstancedOffsetAEMU": this.draw3(c, args[0], 0, args[1], { type: args[2], offset: args[3] }, args[4]); return true;
            case "glDrawRangeElementsDataAEMU": this.draw3(c, args[0], 0, args[3], { type: args[4], bytes: args[5] }, 1); return true;
            case "glDrawRangeElementsOffsetAEMU": this.draw3(c, args[0], 0, args[3], { type: args[4], offset: args[5] }, 1); return true;
            // (GLES 3.1)
            case "glDispatchCompute": this.dispatch3(c, args, null); return true;
            case "glDispatchComputeIndirect": this.dispatch3(c, null, { buffer: c.group.buffers.get(c.buffers.dispatch_indirect), offset: args[0] }); return true;
            case "glMemoryBarrier": case "glMemoryBarrierByRegion": this.end_pass(); return true;
            case "glDrawArraysIndirectDataAEMU": this.draw_indirect3(c, args[0], 0, args[1], 0); return true;
            case "glDrawArraysIndirectOffsetAEMU": this.draw_indirect3(c, args[0], 0, null, args[1]); return true;
            case "glDrawElementsIndirectDataAEMU": this.draw_indirect3(c, args[0], args[1], args[2], 0); return true;
            case "glDrawElementsIndirectOffsetAEMU": this.draw_indirect3(c, args[0], args[1], null, args[2]); return true;
        }
        if(/^gl(Program)?Uniform(?!BlockBinding)/.test(name))
        {
            // (glProgramUniform*'s program; glUniform*'s: the current one, else the bound pipeline's active one)
            const pipeline = !c.program && c.program_pipelines && c.program_pipelines.get(c.program_pipeline);
            const program = c.group.objects.get(name.startsWith("glProgram") ? args[0] : c.program || pipeline && pipeline.active);
            if(program) program.values_version = (program.values_version || 0) + 1;
            return true;
        }
        return false;
    },
};
