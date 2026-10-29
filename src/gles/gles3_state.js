// GLES 3.0's state in the shadow state (docs/gles3-plan.md L2), written
// from the GLES 3.0 specification: what a context of api 3 (GLES 3.0 to
// 3.2, Context.version) has beyond GLES 2.0's, the commands GLES 3.0 adds,
// and its forms of GLES 2.0's commands whose rules it changed. GLES 2.0's
// handlers (gles_shadow.js) stay as they are for 2.0 and 1.1 contexts.
//
// Objects: vertex arrays, transform feedbacks, queries and framebuffers
// belong to the context; samplers and syncs to the share group (GLES 3.0,
// appendix D). Buffers keep a copy of their bytes on the CPU side
// (`bytes`, the shadow's keep_bytes) for glMapBufferRange's answers;
// `gpu_newer` says the page wrote it since (transform feedback, copies,
// pack buffers), which the CPU side then asks the page for (L3).

import { COMPRESSED_FORMATS, COMPRESSED_TEXTURE_FORMATS_3, COMPRESSED_TEXTURE_FORMATS_32, F, SIZED_FORMATS, compressed_bytes, component_type, format_info, image_bytes3,
    pixel_bytes, renderable, tex_image_format } from "./gles_formats3.js";

export const GL3 = {
    TEXTURE_3D: 0x806F, TEXTURE_2D_ARRAY: 0x8C1A, TEXTURE_2D: 0x0DE1, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_EXTERNAL_OES: 0x8D65,
    TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, COPY_READ_BUFFER: 0x8F36, COPY_WRITE_BUFFER: 0x8F37,
    PIXEL_PACK_BUFFER: 0x88EB, PIXEL_UNPACK_BUFFER: 0x88EC, TRANSFORM_FEEDBACK_BUFFER: 0x8C8E, UNIFORM_BUFFER: 0x8A11,
    FRAMEBUFFER: 0x8D40, DRAW_FRAMEBUFFER: 0x8CA9, READ_FRAMEBUFFER: 0x8CA8, RENDERBUFFER: 0x8D41,
    COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00, STENCIL_ATTACHMENT: 0x8D20, DEPTH_STENCIL_ATTACHMENT: 0x821A,
    BACK: 0x0405, NONE: 0, COLOR: 0x1800, DEPTH: 0x1801, STENCIL: 0x1802, DEPTH_STENCIL: 0x84F9,
    TEXTURE: 0x1702, FRAMEBUFFER_DEFAULT: 0x8218,
    FRAMEBUFFER_COMPLETE: 0x8CD5, INCOMPLETE_ATTACHMENT: 0x8CD6, INCOMPLETE_MISSING_ATTACHMENT: 0x8CD7,
    FRAMEBUFFER_UNSUPPORTED: 0x8CDD, INCOMPLETE_MULTISAMPLE: 0x8D56,
    TRANSFORM_FEEDBACK: 0x8E22, INTERLEAVED_ATTRIBS: 0x8C8C, SEPARATE_ATTRIBS: 0x8C8D,
    ANY_SAMPLES_PASSED: 0x8C2F, ANY_SAMPLES_PASSED_CONSERVATIVE: 0x8D6A, TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN: 0x8C88,
    POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
    NO_ERROR: 0, INVALID_ENUM: 0x0500, INVALID_VALUE: 0x0501, INVALID_OPERATION: 0x0502, INVALID_FRAMEBUFFER_OPERATION: 0x0506,
    NEAREST: 0x2600, LINEAR: 0x2601, NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701, NEAREST_MIPMAP_LINEAR: 0x2702,
    LINEAR_MIPMAP_LINEAR: 0x2703, REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370,
    RASTERIZER_DISCARD: 0x8C89, PRIMITIVE_RESTART_FIXED_INDEX: 0x8D69,
    MAP_READ_BIT: 1, MAP_WRITE_BIT: 2, MAP_INVALIDATE_RANGE_BIT: 4, MAP_INVALIDATE_BUFFER_BIT: 8, MAP_FLUSH_EXPLICIT_BIT: 0x10,
    MAP_UNSYNCHRONIZED_BIT: 0x20,
};

/** The limits GLES 3.x's contexts answer (WebGPU's defaults bound them; docs/gles3-plan.md "限制") */
export const LIMITS3 = {
    MAX_3D_TEXTURE_SIZE: 2048, MAX_ARRAY_TEXTURE_LAYERS: 256, MAX_COLOR_ATTACHMENTS: 4, MAX_DRAW_BUFFERS: 4, MAX_SAMPLES: 4,
    MAX_UNIFORM_BUFFER_BINDINGS: 36, MAX_UNIFORM_BLOCK_SIZE: 16384, MAX_VERTEX_UNIFORM_BLOCKS: 12, MAX_FRAGMENT_UNIFORM_BLOCKS: 12,
    MAX_COMBINED_UNIFORM_BLOCKS: 24, MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS: 4, MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS: 64,
    MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS: 4, MAX_VERTEX_OUTPUT_COMPONENTS: 64, MAX_FRAGMENT_INPUT_COMPONENTS: 60,
    MAX_VERTEX_UNIFORM_COMPONENTS: 1024, MAX_FRAGMENT_UNIFORM_COMPONENTS: 1024, MAX_VARYING_COMPONENTS: 60,
    UNIFORM_BUFFER_OFFSET_ALIGNMENT: 256, MAX_ELEMENT_INDEX: 0xFFFFFFFF, MAX_PROGRAM_TEXEL_OFFSET: 7, MIN_PROGRAM_TEXEL_OFFSET: -8,
    MAX_TEXTURE_LOD_BIAS: 2, MAX_TEXTURE_SIZE: 4096,
};

export const MAX_UNITS = 48;
/** The sampler states among the texture parameters: filters, wraps, LODs, comparison, the border color (GLES 3.2's) */
const SAMPLER_STATES = new Set([0x2801, 0x2800, 0x2802, 0x2803, 0x8072, 0x813A, 0x813B, 0x884C, 0x884D, 0x1004]);
const MAX_ATTRIBS = 16;
const MAX_LEVELS_2D = Math.log2(LIMITS3.MAX_TEXTURE_SIZE) + 1;
const MAX_LEVELS_3D = Math.log2(LIMITS3.MAX_3D_TEXTURE_SIZE) + 1;

/** Texture binding slots of a unit: GLES 2.0's three, then 3.0's (gles_shadow.js texture_slot) */
export const SLOT = { TEXTURE_2D: 0, TEXTURE_CUBE_MAP: 1, TEXTURE_EXTERNAL_OES: 2, TEXTURE_3D: 3, TEXTURE_2D_ARRAY: 4, TEXTURE_2D_MULTISAMPLE: 5,
    TEXTURE_CUBE_MAP_ARRAY: 6 };
/** GLES 3.2's cube map arrays */
const TEXTURE_CUBE_MAP_ARRAY = 0x9009;
/** @return {boolean} whether a target is of layers (2D arrays; GLES 3.2's cube map arrays, their layer-faces) */
const layered = (c, target) => target === GL3.TEXTURE_2D_ARRAY || target === TEXTURE_CUBE_MAP_ARRAY && c.version >= 32;

const BUFFER_TARGETS = new Map([[GL3.ARRAY_BUFFER, "array"], [GL3.ELEMENT_ARRAY_BUFFER, "element"], [GL3.COPY_READ_BUFFER, "copy_read"],
    [GL3.COPY_WRITE_BUFFER, "copy_write"], [GL3.PIXEL_PACK_BUFFER, "pixel_pack"], [GL3.PIXEL_UNPACK_BUFFER, "pixel_unpack"],
    [GL3.TRANSFORM_FEEDBACK_BUFFER, "transform_feedback"], [GL3.UNIFORM_BUFFER, "uniform"],
    // (GLES 3.1's: gles31_state.js)
    [0x90D2, "shader_storage"], [0x92C0, "atomic_counter"], [0x90EE, "dispatch_indirect"], [0x8F3F, "draw_indirect"]]);
/** The buffer targets only GLES 3.1 has */
const TARGETS31 = new Set([0x90D2, 0x92C0, 0x90EE, 0x8F3F]);
/** @return {boolean} whether a context of its version has the buffer target */
const target_ok = (c, target) => BUFFER_TARGETS.has(target) && (c.version >= 31 || !TARGETS31.has(target));
const USAGES3 = new Set([0x88E0, 0x88E1, 0x88E2, 0x88E4, 0x88E5, 0x88E6, 0x88E8, 0x88E9, 0x88EA]);
const COMPARE_FUNCS = new Set([0x0200, 0x0201, 0x0202, 0x0203, 0x0204, 0x0205, 0x0206, 0x0207]);
const WRAPS = new Set([GL3.REPEAT, GL3.CLAMP_TO_EDGE, GL3.MIRRORED_REPEAT]);
/** The bytes of a pixel transfer type's datum (a packed type's whole), for an unpack buffer's offset */
const DATUM_BYTES = { 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x1404: 4, 0x1405: 4, 0x1406: 4, 0x140B: 2, 0x8D61: 2, 0x8033: 2, 0x8034: 2,
    0x8363: 2, 0x8368: 4, 0x8C3B: 4, 0x8C3E: 4, 0x84FA: 4, 0x8DAD: 8 };
/** GLES 3.2's CLAMP_TO_BORDER and TEXTURE_BORDER_COLOR */
const CLAMP_TO_BORDER = 0x812D, TEXTURE_BORDER_COLOR = 0x1004;
/** GLES 3.1's DEPTH_STENCIL_TEXTURE_MODE (DEPTH_COMPONENT or STENCIL_INDEX) */
const DEPTH_STENCIL_TEXTURE_MODE = 0x90EA;
const wrap_ok = (c, wrap) => WRAPS.has(wrap) || c.version >= 32 && wrap === CLAMP_TO_BORDER;
/**
 * A border color as glTexParameteriv or glSamplerParameteriv gives it:
 * signed normalized (GLES 3.2 8.10's conversion), else as it is
 */
const border_color = (params, float) => [0, 1, 2, 3].map(k => k >= params.length ? 0 : float ? Math.fround(params[k]) : Math.fround((2 * params[k] + 1) / 4294967295));
/** A border color component as glGetTexParameteriv answers it */
const border_int = v => Math.max(-2147483648, Math.min(2147483647, Math.round((v * 4294967295 - 1) / 2)));
const MIN_FILTERS = new Set([GL3.NEAREST, GL3.LINEAR, GL3.NEAREST_MIPMAP_NEAREST, GL3.LINEAR_MIPMAP_NEAREST, GL3.NEAREST_MIPMAP_LINEAR,
    GL3.LINEAR_MIPMAP_LINEAR]);
const SWIZZLES = new Set([0x1903, 0x1904, 0x1905, 0x1906, 0, 1]);
const MODES = new Set([0, 1, 2, 3, 4, 5, 6]);
/** GLES 3.2's advanced blend equations (KHR_blend_equation_advanced's), in the order of BLEND_SUPPORT's names */
export const ADVANCED_EQUATIONS = [0x9294, 0x9295, 0x9296, 0x9297, 0x9298, 0x9299, 0x929A, 0x929B, 0x929C, 0x929E, 0x92A0, 0x92AD, 0x92AE,
    0x92AF, 0x92B0];
/** GLES 3.2's: lines and triangles with adjacency (a geometry shader's; without one the adjacent vertices are left out) */
const ADJACENCY_MODES = new Set([0xA, 0xB, 0xC, 0xD]);
/** whether a context of its version draws the mode */
const mode_ok = (c, mode) => MODES.has(mode) || c.version >= 32 && (ADJACENCY_MODES.has(mode) || mode === PATCHES);
/** GLES 3.2's PATCHES: tessellation's */
const PATCHES = 0xE;
/** the modes a geometry shader of each input type takes (GLES 3.2 11.3.4.1) */
const GEOMETRY_MODES = new Map([[0x0000, [0]], [0x0001, [1, 2, 3]], [0x0004, [4, 5, 6]], [0x000A, [0xA, 0xB]], [0x000C, [0xC, 0xD]]]);
const INDEX_TYPES = new Set([0x1401, 0x1403, 0x1405]);
const QUERY_TARGETS = new Set([GL3.ANY_SAMPLES_PASSED, GL3.ANY_SAMPLES_PASSED_CONSERVATIVE, GL3.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN]);

/** A vertex attribute's state, with GLES 3.0's integer and divisor */
export function new_attrib3()
{
    return { enabled: false, size: 4, type: 0x1406, normalized: false, stride: 0, buffer: 0, offset: 0, current: [0, 0, 0, 1],
        integer: false, divisor: 0, current_type: "f" };
}

/** A vertex array object */
function new_vao()
{
    return { attribs: Array.from({ length: MAX_ATTRIBS }, new_attrib3), element_array_buffer: 0, bound_once: false };
}

/** A transform feedback object */
function new_tf()
{
    return { active: false, paused: false, mode: 0, program: 0, bindings: Array.from({ length: 4 }, () => ({ buffer: 0, offset: 0, size: 0 })),
        vertices: [0, 0, 0, 0], bound_once: false };
}

/** A framebuffer object's GLES 3.0 state */
export function new_framebuffer3()
{
    return { attachments: new Map(), draw_buffers: [GL3.COLOR_ATTACHMENT0, GL3.NONE, GL3.NONE, GL3.NONE], read_buffer: GL3.COLOR_ATTACHMENT0 };
}

/** A sampler object's state (GLES 3.0 table 6.10) */
function new_sampler()
{
    return { min_filter: GL3.NEAREST_MIPMAP_LINEAR, mag_filter: GL3.LINEAR, wrap_s: GL3.REPEAT, wrap_t: GL3.REPEAT, wrap_r: GL3.REPEAT,
        min_lod: -1000, max_lod: 1000, compare_mode: 0, compare_func: 0x0203 };
}

/** A GLES 3.0 context's state beyond GLES 2.0's (tables 6.2 to 6.37) */
/**
 * A context a snapshot brought back from when the limits were lower: its
 * texture units and uniform buffer binding points as many as now
 */
export function pad_context3(c)
{
    while(c.textures.length < MAX_UNITS) c.textures.push([0, 0, 0, 0, 0, 0, 0]);
    while(c.samplers.length < MAX_UNITS) c.samplers.push(0);
    while(c.uniform_bindings.length < LIMITS3.MAX_UNIFORM_BUFFER_BINDINGS) c.uniform_bindings.push({ buffer: 0, offset: 0, size: 0 });
}

export function extend_context3(c)
{
    c.textures = Array.from({ length: MAX_UNITS }, () => [0, 0, 0, 0, 0, 0, 0]);
    c.samplers = new Array(MAX_UNITS).fill(0);
    c.buffers = { copy_read: 0, copy_write: 0, pixel_pack: 0, pixel_unpack: 0, transform_feedback: 0, uniform: 0,
        shader_storage: 0, atomic_counter: 0, dispatch_indirect: 0, draw_indirect: 0 };
    c.uniform_bindings = Array.from({ length: LIMITS3.MAX_UNIFORM_BUFFER_BINDINGS }, () => ({ buffer: 0, offset: 0, size: 0 }));
    c.default_vao = new_vao();
    c.attribs = c.default_vao.attribs;
    c.vaos = new Map();
    c.vao = 0;
    c.tfs = new Map([[0, new_tf()]]);
    c.tf = 0;
    c.queries = new Map();
    /** @type {!Map<number, number>} the active query of each target */
    c.active_queries = new Map();
    c.reserved3 = { vao: new Set(), tf: new Set(), query: new Set() };
    c.next3 = { vao: 1, tf: 1, query: 1 };
    c.read_framebuffer = 0;
    c.default_draw_buffer = GL3.BACK;
    c.default_read_buffer = GL3.BACK;
    c.unpack = { row_length: 0, image_height: 0, skip_pixels: 0, skip_rows: 0, skip_images: 0 };
    c.pack = { row_length: 0, skip_pixels: 0, skip_rows: 0 };
    c.hints.set(0x8B8B, 0x1100);
}

/** A share group's objects of GLES 3.0: samplers and syncs */
export function extend_group3(g)
{
    if(g.samplers) return;
    g.samplers = new Map();
    g.syncs = new Map();
    g.reserved.sampler = new Set();
    g.next.sampler = 1;
    g.next_sync = 1;
}

/** @param {!Object} c @param {string} kind @param {!Map} objects @return {number} a name the context's objects of the kind lack */
function fresh_context_name(c, kind, objects)
{
    let name = c.next3[kind];
    while(objects.has(name) || c.reserved3[kind].has(name)) name++;
    c.next3[kind] = name + 1;
    return name;
}

/**
 * The handlers of GLES 3.x's contexts: GLES 3.0's commands and its forms
 * of GLES 2.0's
 * @param {!Object} h gles_shadow.js's helpers
 * @return {!Object<string, function(!Object, !Object, !Array<*>)>}
 */
export function gles3_handlers(h)
{
    const { fail, query, put, put_text, i32s, f32s, text_of, REFUSED, base, framebuffer_status3 } = h;
    const GL = GL3;

    /** @return {number} a value as glGet's i form reads a float state, rounded */
    const round = v => Math.round(v);

    /** A glGen* of the context's objects (vertex arrays, transform feedbacks, queries) */
    const gen3 = (kind, map_of) => (shadow, c, [n, names]) =>
    {
        query(shadow);
        if(n < 0) return fail(c, GL.INVALID_VALUE);
        const objects = map_of(c);
        for(let i = 0; i < n && 4 * i + 4 <= names.size; i++)
        {
            const name = fresh_context_name(c, kind, objects);
            c.reserved3[kind].add(name);
            names.view.setUint32(4 * i, name, true);
        }
        return undefined;
    };

    // ---- buffers

    /** The name bound to a buffer target, or -1 for a target that is none */
    const buffer_binding = (c, target) =>
    {
        const which = BUFFER_TARGETS.get(target);
        if(!which) return -1;
        if(which === "array") return c.array_buffer;
        if(which === "element") return c.element_array_buffer;
        return c.buffers[which];
    };
    /** The buffer bound to a target, or null with the error set */
    const bound_buffer3 = (c, target) =>
    {
        const name = buffer_binding(c, target);
        if(name < 0) { fail(c, GL.INVALID_ENUM); return null; }
        const buffer = c.group.buffers.get(name);
        if(!buffer) { fail(c, GL.INVALID_OPERATION); return null; }
        return buffer;
    };
    const set_buffer_binding = (c, target, name) =>
    {
        const which = BUFFER_TARGETS.get(target);
        if(which === "array") c.array_buffer = name;
        else if(which === "element") c.element_array_buffer = name;
        else c.buffers[which] = name;
    };
    /**
     * Whether a name was made by glGen*: those calls are the CPU side's
     * alone (queries), so the page's shadow (`trusted`) takes the names the
     * CPU side accepted as made. GLES 3.x wants it of vertex arrays,
     * transform feedbacks, queries, samplers and program pipelines; a
     * buffer, texture, framebuffer or renderbuffer is still made by binding
     * an unused name (GLES 2.0's rule, which 3.x keeps)
     */
    const generated = (shadow, made, name) => shadow.trusted || made.has(name);
    const new_buffer = () => ({ size: 0, usage: 0x88E4, mapped: null, bytes: null, gpu_newer: false });
    /** whether the buffer is bound for transform feedback while one is active (writes to it are errors then) */
    const tf_bound_active = (c, name) =>
    {
        const tf = c.tfs.get(c.tf);
        return !!tf && tf.active && tf.bindings.some(b => b.buffer === name);
    };
    /** The buffer's bytes on the CPU side, as large as it is */
    const bytes_of = (shadow, buffer) =>
    {
        if(!shadow.keep_bytes) return null;
        if(!buffer.bytes || buffer.bytes.length !== buffer.size) buffer.bytes = new Uint8Array(buffer.size);
        return buffer.bytes;
    };

    // ---- textures

    const target_slot = (target, c) => target === GL.TEXTURE_2D ? SLOT.TEXTURE_2D : target === GL.TEXTURE_CUBE_MAP ? SLOT.TEXTURE_CUBE_MAP :
        target === GL.TEXTURE_EXTERNAL_OES ? SLOT.TEXTURE_EXTERNAL_OES : target === GL.TEXTURE_3D ? SLOT.TEXTURE_3D :
        target === GL.TEXTURE_2D_ARRAY ? SLOT.TEXTURE_2D_ARRAY : target === 0x9100 && c.version >= 31 ? SLOT.TEXTURE_2D_MULTISAMPLE :
        target === TEXTURE_CUBE_MAP_ARRAY && c.version >= 32 ? SLOT.TEXTURE_CUBE_MAP_ARRAY : -1;
    /** The texture bound to a target of the active unit (the default one for name 0), or null with the error set */
    const bound_texture3 = (c, target) =>
    {
        const slot = target_slot(target, c);
        if(slot < 0) { fail(c, GL.INVALID_ENUM); return null; }
        const name = c.textures[c.active_texture][slot];
        let texture = c.group.textures.get(name);
        if(!texture && !name)
        {
            c.defaults = c.defaults || new Map();
            texture = c.defaults.get(target);
            if(!texture) c.defaults.set(target, texture = h.new_texture(target));
        }
        return texture || null;
    };
    /** The face of a 2D image target: 0 for TEXTURE_2D, 0 to 5 for a cube face, -1 for none */
    const face_of = target =>
    {
        if(target === GL.TEXTURE_2D) return 0;
        const face = target - GL.TEXTURE_CUBE_MAP_POSITIVE_X;
        return face >= 0 && face < 6 ? face : -1;
    };
    const image_key = (face, level) => face * 32 + level;
    /** The unpack state as image_bytes3 takes it */
    const unpack_store = c => ({ alignment: c.unpack_alignment, row_length: c.unpack.row_length, image_height: c.unpack.image_height,
        skip_pixels: c.unpack.skip_pixels, skip_rows: c.unpack.skip_rows, skip_images: c.unpack.skip_images });
    /**
     * The data of a TexImage-like call: from the call's bytes, or (Offset
     * forms) from the pixel unpack buffer: @return {boolean} whether it is
     * there, else the error is set
     */
    const source_ok = (c, needed, bytes, offset, type) =>
    {
        if(offset === undefined)
        {
            if(c.buffers.pixel_unpack) return true; // (the encoder sends the Offset form with a buffer bound)
            if(bytes && bytes.length < needed) { fail(c, GL.INVALID_OPERATION); return false; }
            return true;
        }
        const buffer = c.group.buffers.get(c.buffers.pixel_unpack);
        if(!buffer) { fail(c, GL.INVALID_OPERATION); return false; }
        if(buffer.mapped || offset < 0 || offset + needed > buffer.size) { fail(c, GL.INVALID_OPERATION); return false; }
        // (the offset a whole number of the type's datums: GLES 3.0 3.7.1)
        if(type !== undefined && offset % (DATUM_BYTES[type] || 1)) { fail(c, GL.INVALID_OPERATION); return false; }
        return true;
    };
    const max_level_of = target => target === GL.TEXTURE_3D ? MAX_LEVELS_3D - 1 : MAX_LEVELS_2D - 1;
    /** A TexImage's size and level checks (GLES 3.0 3.8.3) @return {boolean} */
    const size_ok = (c, target, level, width, height, depth, border) =>
    {
        const max = target === GL.TEXTURE_3D ? LIMITS3.MAX_3D_TEXTURE_SIZE : LIMITS3.MAX_TEXTURE_SIZE;
        if(level < 0 || level > max_level_of(target) || width < 0 || height < 0 || depth < 0 || border !== 0 ||
            width > max >> level || height > max >> level ||
            (target === GL.TEXTURE_3D ? depth > max >> level : layered(c, target) ? depth > LIMITS3.MAX_ARRAY_TEXTURE_LAYERS : false) ||
            target !== GL.TEXTURE_2D && target !== GL.TEXTURE_3D && target !== GL.TEXTURE_2D_ARRAY && width !== height ||
            target === TEXTURE_CUBE_MAP_ARRAY && depth % 6)
        {
            fail(c, GL.INVALID_VALUE);
            return false;
        }
        return true;
    };
    /** glTexImage2D/3D, the Offset forms too */
    const tex_image = (shadow, c, three, args) =>
    {
        const [target, level, internalformat, width, height, depth, border, format, type, data] = three ? args :
            [args[0], args[1], args[2], args[3], args[4], 1, args[5], args[6], args[7], args[8]];
        const offset = typeof data === "number" ? data : undefined;
        let texture, face;
        if(three)
        {
            if(target !== GL.TEXTURE_3D && !layered(c, target)) return fail(c, GL.INVALID_ENUM);
            texture = bound_texture3(c, target);
            face = 0;
        }
        else
        {
            face = face_of(target);
            if(face < 0) return fail(c, GL.INVALID_ENUM);
            texture = bound_texture3(c, target === GL.TEXTURE_2D ? GL.TEXTURE_2D : GL.TEXTURE_CUBE_MAP);
        }
        if(!texture) return REFUSED;
        // (a 3D texture of depth: refused as INVALID_OPERATION before the format's checks, dEQP's negative_api.texture.teximage3d)
        if(three && target === GL.TEXTURE_3D && (format === 0x1902 || format === 0x84F9)) return fail(c, GL.INVALID_OPERATION);
        const f = tex_image_format(internalformat, format, type);
        if(f.error) return fail(c, f.error);
        const info = format_info(f.internal);
        if(three && target === GL.TEXTURE_3D && info && (info.kind === "depth" || info.kind === "depth_stencil")) return fail(c, GL.INVALID_OPERATION);
        if(!size_ok(c, target, level, width, height, depth, border)) return REFUSED;
        if(texture.immutable) return fail(c, GL.INVALID_OPERATION);
        const needed = image_bytes3(width, height, depth, format, type, unpack_store(c));
        if(!source_ok(c, needed, offset === undefined ? data : null, offset, type)) return REFUSED;
        texture.images.set(image_key(face, level), { width, height, depth, format, type, internal: f.internal, compressed: false });
        return undefined;
    };
    /** glTexSubImage2D/3D, the Offset forms too */
    const tex_sub_image = (shadow, c, three, args) =>
    {
        const [target, level, x, y, z, width, height, depth, format, type, data] = three ? args :
            [args[0], args[1], args[2], args[3], 0, args[4], args[5], 1, args[6], args[7], args[8]];
        const offset = typeof data === "number" ? data : undefined;
        let texture, face;
        if(three)
        {
            if(target !== GL.TEXTURE_3D && !layered(c, target)) return fail(c, GL.INVALID_ENUM);
            texture = bound_texture3(c, target);
            face = 0;
        }
        else
        {
            face = face_of(target);
            if(face < 0) return fail(c, GL.INVALID_ENUM);
            texture = bound_texture3(c, target === GL.TEXTURE_2D ? GL.TEXTURE_2D : GL.TEXTURE_CUBE_MAP);
        }
        if(!texture) return REFUSED;
        if(pixel_bytes(format, type) === 0) return fail(c, GL.INVALID_ENUM);
        if(level < 0 || level > max_level_of(target) || x < 0 || y < 0 || z < 0 || width < 0 || height < 0 || depth < 0) return fail(c, GL.INVALID_VALUE);
        const image = texture.images.get(image_key(face, level));
        if(!image || image.compressed) return fail(c, GL.INVALID_OPERATION);
        if(x + width > image.width || y + height > image.height || z + depth > (image.depth || 1)) return fail(c, GL.INVALID_VALUE);
        if(tex_image_format(image.internal || image.format, format, type).error) return fail(c, GL.INVALID_OPERATION);
        const needed = image_bytes3(width, height, depth, format, type, unpack_store(c));
        if(!source_ok(c, needed, offset === undefined ? data : null, offset, type)) return REFUSED;
        return undefined;
    };
    /** glTexStorage2D/3D */
    const tex_storage = (shadow, c, target, levels, internalformat, width, height, depth) =>
    {
        const two_d = target === GL.TEXTURE_2D || target === GL.TEXTURE_CUBE_MAP;
        if(!two_d && depth === undefined || two_d && depth !== undefined && depth !== 1) return fail(c, GL.INVALID_ENUM);
        const texture = bound_texture3(c, target);
        if(!texture) return REFUSED;
        const info = SIZED_FORMATS.get(internalformat);
        const compressed = COMPRESSED_FORMATS.get(internalformat);
        if(!info && !compressed) return fail(c, GL.INVALID_ENUM);
        if(depth === undefined) depth = 1;
        if(width < 1 || height < 1 || depth < 1 || levels < 1) return fail(c, GL.INVALID_VALUE);
        const max = target === GL.TEXTURE_3D ? LIMITS3.MAX_3D_TEXTURE_SIZE : LIMITS3.MAX_TEXTURE_SIZE;
        if(width > max || height > max || (target === GL.TEXTURE_3D && depth > max) ||
            (layered(c, target) && depth > LIMITS3.MAX_ARRAY_TEXTURE_LAYERS) || (target === GL.TEXTURE_CUBE_MAP || target === TEXTURE_CUBE_MAP_ARRAY) && width !== height ||
            target === TEXTURE_CUBE_MAP_ARRAY && depth % 6)
        {
            return fail(c, GL.INVALID_VALUE);
        }
        const largest = target === GL.TEXTURE_3D ? Math.max(width, height, depth) : Math.max(width, height);
        if(levels > Math.floor(Math.log2(largest)) + 1) return fail(c, GL.INVALID_OPERATION);
        if(texture.immutable) return fail(c, GL.INVALID_OPERATION);
        if(info && target === GL.TEXTURE_3D && (info.kind === "depth" || info.kind === "depth_stencil")) return fail(c, GL.INVALID_OPERATION);
        if(compressed && target === GL.TEXTURE_3D) return fail(c, GL.INVALID_OPERATION);
        texture.images.clear();
        const faces = target === GL.TEXTURE_CUBE_MAP ? 6 : 1;
        for(let level = 0; level < levels; level++)
        {
            const w = Math.max(1, width >> level), hh = Math.max(1, height >> level);
            const d = target === GL.TEXTURE_3D ? Math.max(1, depth >> level) : depth;
            for(let face = 0; face < faces; face++)
            {
                texture.images.set(image_key(face, level), { width: w, height: hh, depth: d, format: info ? info.format : internalformat,
                    type: info ? info.types[0] : 0x1401, internal: internalformat, compressed: !!compressed });
            }
        }
        texture.immutable = true;
        texture.immutable_levels = levels;
        return undefined;
    };
    /** glCompressedTexImage2D/3D, the Offset forms too */
    const compressed_image = (shadow, c, three, args) =>
    {
        const [target, level, internalformat, width, height, depth, border, size, data] = three ? args :
            [args[0], args[1], args[2], args[3], args[4], 1, args[5], args[6], args[7]];
        const offset = typeof data === "number" ? data : undefined;
        const face = three ? 0 : face_of(target);
        if(three ? !layered(c, target) && target !== GL.TEXTURE_3D : face < 0) return fail(c, GL.INVALID_ENUM);
        const texture = bound_texture3(c, three ? target : target === GL.TEXTURE_2D ? GL.TEXTURE_2D : GL.TEXTURE_CUBE_MAP);
        if(!texture) return REFUSED;
        if(!COMPRESSED_FORMATS.has(internalformat)) return fail(c, GL.INVALID_ENUM);
        if(target === GL.TEXTURE_3D) return fail(c, GL.INVALID_OPERATION);
        if(!size_ok(c, three ? target : target === GL.TEXTURE_2D ? GL.TEXTURE_2D : GL.TEXTURE_CUBE_MAP, level, width, height, depth, border)) return REFUSED;
        if(texture.immutable) return fail(c, GL.INVALID_OPERATION);
        if(size !== compressed_bytes(internalformat, width, height, depth)) return fail(c, GL.INVALID_VALUE);
        if(offset === undefined ? !c.buffers.pixel_unpack && data && data.length < size : !source_ok(c, size, null, offset)) return fail(c, GL.INVALID_VALUE);
        texture.images.set(image_key(face, level), { width, height, depth, format: internalformat, type: 0x1401, internal: internalformat,
            compressed: true });
        return undefined;
    };
    /** glCompressedTexSubImage2D/3D */
    const compressed_sub_image = (shadow, c, three, args) =>
    {
        const [target, level, x, y, z, width, height, depth, format, size] = three ? args :
            [args[0], args[1], args[2], args[3], 0, args[4], args[5], 1, args[6], args[7]];
        const face = three ? 0 : face_of(target);
        if(three ? !layered(c, target) && target !== GL.TEXTURE_3D : face < 0) return fail(c, GL.INVALID_ENUM);
        const texture = bound_texture3(c, three ? target : target === GL.TEXTURE_2D ? GL.TEXTURE_2D : GL.TEXTURE_CUBE_MAP);
        if(!texture) return REFUSED;
        if(!COMPRESSED_FORMATS.has(format)) return fail(c, GL.INVALID_ENUM);
        if(level < 0 || level > max_level_of(target) || x < 0 || y < 0 || z < 0 || width < 0 || height < 0 || depth < 0) return fail(c, GL.INVALID_VALUE);
        const image = texture.images.get(image_key(face, level));
        if(!image || !image.compressed || image.internal !== format || format === 0x8D64) return fail(c, GL.INVALID_OPERATION);
        const { block_width: bw, block_height: bh } = COMPRESSED_FORMATS.get(format);
        if(x % bw || y % bh || x + width > image.width || y + height > image.height || z + depth > image.depth ||
            width % bw && x + width !== image.width || height % bh && y + height !== image.height)
        {
            return fail(c, GL.INVALID_OPERATION);
        }
        if(size !== compressed_bytes(format, width, height, depth)) return fail(c, GL.INVALID_VALUE);
        return undefined;
    };

    // ---- framebuffers

    /** The framebuffer bound to a target's name, or -1 for a target that is none */
    const framebuffer_of = (c, target) => target === GL.FRAMEBUFFER || target === GL.DRAW_FRAMEBUFFER ? c.framebuffer :
        target === GL.READ_FRAMEBUFFER ? c.read_framebuffer : -1;
    const color_attachment = attachment => attachment >= GL.COLOR_ATTACHMENT0 && attachment < GL.COLOR_ATTACHMENT0 + LIMITS3.MAX_COLOR_ATTACHMENTS;
    const attachment_ok = attachment => color_attachment(attachment) || attachment === GL.DEPTH_ATTACHMENT ||
        attachment === GL.STENCIL_ATTACHMENT || attachment === GL.DEPTH_STENCIL_ATTACHMENT;
    /** Attach (or detach, a null record) at an attachment point: DEPTH_STENCIL is both */
    const attach = (fbo, attachment, record) =>
    {
        const points = attachment === GL.DEPTH_STENCIL_ATTACHMENT ? [GL.DEPTH_ATTACHMENT, GL.STENCIL_ATTACHMENT] : [attachment];
        for(const point of points)
        {
            if(record) fbo.attachments.set(point, Object.assign({}, record));
            else fbo.attachments.delete(point);
        }
    };
    /** The image of an attachment: size, samples, format info, or null */
    const attachment_image = (c, a) =>
    {
        if(a.type === GL.RENDERBUFFER)
        {
            const rb = c.group.renderbuffers.get(a.name);
            if(!rb || !rb.width || !rb.height) return null;
            return { width: rb.width, height: rb.height, samples: rb.samples || 0, info: format_info(rb.format) || h.renderbuffer_info(rb.format) };
        }
        const texture = c.group.textures.get(a.name);
        const image = texture && texture.images.get(image_key(a.face, a.level));
        if(!image || !image.width || !image.height) return null;
        if((texture.target === GL.TEXTURE_3D || layered(c, texture.target)) && a.layer >= (image.depth || 1)) return null;
        return { width: image.width, height: image.height, samples: image.samples || 0,
            info: image.compressed ? null : format_info(image.internal || image.format) || h.renderbuffer_info(image.format) };
    };
    /** A framebuffer's status by GLES 3.0's rules (4.4.4) */
    const status_of = (c, name) =>
    {
        if(!name) return GL.FRAMEBUFFER_COMPLETE;
        const fbo = c.framebuffers.get(name);
        let any = false, samples = -1;
        for(const [attachment, a] of fbo.attachments)
        {
            const image = attachment_image(c, a);
            if(!image || !image.info) return GL.INCOMPLETE_ATTACHMENT;
            const k = image.info.kind;
            if(color_attachment(attachment) ? !renderable(image.info, c.color_buffer_float) || k === "depth" || k === "depth_stencil" :
                attachment === GL.DEPTH_ATTACHMENT ? k !== "depth" && k !== "depth_stencil" :
                k !== "depth_stencil" && image.info.value !== 0x8D48)
            {
                return GL.INCOMPLETE_ATTACHMENT;
            }
            if(samples >= 0 && samples !== image.samples) return GL.INCOMPLETE_MULTISAMPLE;
            samples = image.samples;
            any = true;
        }
        // (GLES 3.1: none, with a default width and height: a framebuffer drawn to without attachments)
        if(!any) return c.version >= 31 && fbo.default_width > 0 && fbo.default_height > 0 ? GL.FRAMEBUFFER_COMPLETE : GL.INCOMPLETE_MISSING_ATTACHMENT;
        const depth = fbo.attachments.get(GL.DEPTH_ATTACHMENT), stencil = fbo.attachments.get(GL.STENCIL_ATTACHMENT);
        if(depth && stencil && (depth.type !== stencil.type || depth.name !== stencil.name || depth.level !== stencil.level ||
            depth.face !== stencil.face || depth.layer !== stencil.layer))
        {
            return GL.FRAMEBUFFER_UNSUPPORTED;
        }
        return GL.FRAMEBUFFER_COMPLETE;
    };
    framebuffer_status3.fn = status_of;
    /** INVALID_FRAMEBUFFER_OPERATION unless the draw (and for reads, the read) framebuffer is complete @return {boolean} */
    const complete = (c, read) =>
    {
        if(status_of(c, c.framebuffer) !== GL.FRAMEBUFFER_COMPLETE || read && status_of(c, c.read_framebuffer) !== GL.FRAMEBUFFER_COMPLETE)
        {
            fail(c, GL.INVALID_FRAMEBUFFER_OPERATION);
            return false;
        }
        return true;
    };
    /** The format of what a framebuffer reads from (its read buffer), or null */
    const read_image = (c) =>
    {
        if(!c.read_framebuffer)
        {
            if(c.default_read_buffer === GL.NONE) return null;
            const bits = h.framebuffer_bits(c);
            return { info: { kind: "unorm", bits, value: bits[3] ? 0x8058 : 0x8051, format: bits[3] ? 0x1908 : 0x1907 }, samples: 0 };
        }
        const fbo = c.framebuffers.get(c.read_framebuffer);
        if(fbo.read_buffer === GL.NONE) return null;
        const a = fbo.attachments.get(fbo.read_buffer);
        return a ? attachment_image(c, a) : null;
    };

    // ---- transform feedback

    const current_tf = c => c.tfs.get(c.tf);
    /** The primitives a draw of `count` vertices in `mode` makes */
    const primitives = (mode, count) => mode === GL.POINTS ? count : mode === GL.LINES ? count >> 1 :
        mode === GL.TRIANGLES ? Math.floor(count / 3) : 0;
    /**
     * A draw while transform feedback is active: GLES 3.0's errors (the
     * mode must be the feedback's, no room is an error), and the vertices
     * written (the CPU side's count of TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN)
     * @return {boolean}
     */
    const tf_draw = (shadow, c, mode, count, instances, elements) =>
    {
        const tf = current_tf(c);
        if(!tf.active || tf.paused) return true;
        if(elements || mode !== tf.mode) { fail(c, GL.INVALID_OPERATION); return false; }
        const program = c.group.objects.get(tf.program);
        const varyings = program && program.info && program.info.tf_varyings || [];
        const prims = primitives(mode, count) * instances;
        const vertices = prims * (mode === GL.POINTS ? 1 : mode === GL.LINES ? 2 : 3);
        const interleaved = program && program.info && program.info.tf_mode === GL.INTERLEAVED_ATTRIBS;
        const strides = interleaved ? [varyings.reduce((n, v) => n + v.bytes, 0)] : varyings.map(v => v.bytes);
        for(let i = 0; i < strides.length; i++)
        {
            const b = tf.bindings[i];
            const buffer = c.group.buffers.get(b.buffer);
            const room = buffer ? Math.floor(((b.size || buffer.size - b.offset) - tf.vertices[i] * strides[i]) / Math.max(1, strides[i])) : 0;
            if(vertices > room) { fail(c, GL.INVALID_OPERATION); return false; }
        }
        for(let i = 0; i < strides.length; i++) tf.vertices[i] += vertices;
        const q = c.active_queries.get(GL.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN);
        if(q) c.queries.get(q).result += prims;
        for(const b of tf.bindings)
        {
            const buffer = c.group.buffers.get(b.buffer);
            if(buffer) buffer.gpu_newer = true;
        }
        return true;
    };

    /** The draw's geometry shader's layout (link_glslang_program's `geometry`), or null */
    const geometry_of = c =>
    {
        const pipeline = !c.program && c.program_pipelines && c.program_pipelines.get(c.program_pipeline);
        const program = c.group.objects.get(c.program || pipeline && pipeline.stages[4]);
        return program && program.info && program.info.ok && program.info.geometry || null;
    };
    /** Whether the draw has a tessellation evaluation shader (link_glslang_program's `tessellation`) */
    const tessellates = c =>
    {
        const pipeline = !c.program && c.program_pipelines && c.program_pipelines.get(c.program_pipeline);
        const program = c.group.objects.get(c.program || pipeline && pipeline.stages[0x10]);
        return !!(program && program.info && program.info.ok && program.info.tessellation && program.info.tessellation.evaluation);
    };

    /** A draw's checks: mode, counts, the framebuffer, transform feedback */
    const draw_checks = (shadow, c, mode, count, instances, elements, type) =>
    {
        if(!mode_ok(c, mode) || elements && !INDEX_TYPES.has(type)) return fail(c, GL.INVALID_ENUM);
        if(count < 0 || instances < 0) return fail(c, GL.INVALID_VALUE);
        // (tessellation takes patches, and only it; a geometry shader the modes of its input type, after tessellation its output's)
        const tessellation = c.version >= 32 && tessellates(c);
        if(tessellation !== (mode === PATCHES)) return fail(c, GL.INVALID_OPERATION);
        const geometry = c.version >= 32 && !tessellation ? geometry_of(c) : null;
        if(geometry && !(GEOMETRY_MODES.get(geometry.input) || []).includes(mode)) return fail(c, GL.INVALID_OPERATION);
        // (an advanced blend equation: one draw buffer, a fragment shader that declares the equation's support)
        if(c.version >= 32 && c.enabled.has(0x0BE2) && ADVANCED_EQUATIONS.includes(c.blend_equation[0]))
        {
            const fbo = c.framebuffer && c.framebuffers.get(c.framebuffer);
            if(fbo && fbo.draw_buffers.slice(1).some(b => b !== GL.NONE)) return fail(c, GL.INVALID_OPERATION);
            const pipeline = !c.program && c.program_pipelines && c.program_pipelines.get(c.program_pipeline);
            const fragment = c.group.objects.get(c.program || pipeline && pipeline.stages[2]);
            const support = fragment && fragment.info && fragment.info.blend_support || [];
            if(!support.includes(c.blend_equation[0])) return fail(c, GL.INVALID_OPERATION);
        }
        if(!complete(c, false)) return REFUSED;
        if(!tf_draw(shadow, c, mode, count, instances, elements)) return REFUSED;
        const occlusion = [GL.ANY_SAMPLES_PASSED, GL.ANY_SAMPLES_PASSED_CONSERVATIVE].map(t => c.active_queries.get(t)).filter(Boolean);
        for(const q of occlusion) c.queries.get(q).drawn = true;
        return undefined;
    };

    // ---- uniforms

    /** The current program's uniform at a location (null for -1), REFUSED with the error set */
    const uniform_at3 = (c, location, count) =>
    {
        const program = c.group.objects.get(c.program);
        if(!program || !program.info || !program.info.ok) return fail(c, GL.INVALID_OPERATION);
        if(count < 0) return fail(c, GL.INVALID_VALUE);
        if(location === -1) return null;
        const at = program.info.by_location[location];
        if(!at) return fail(c, GL.INVALID_OPERATION);
        // (an array of one active element is still an array: its name ends in [0], the rest of the count is ignored)
        if(count > 1 && at.uniform.size === 1 && at.uniform.name === at.uniform.base) return fail(c, GL.INVALID_OPERATION);
        return { program, at };
    };
    /**
     * glUniform* of GLES 3.0 (2.12.6): the function's kind ("f", "i",
     * "ui", "m" for a matrix of columns x rows) against the uniform's type;
     * the values stored by location (program.values), as numbers
     */
    const uniform3 = (components, kind, vector, columns, rows) => (shadow, c, args) =>
    {
        const location = args[0];
        let count = 1, values;
        if(kind === "m")
        {
            count = args[1];
            values = f32s(args[3]);
        }
        else if(vector)
        {
            count = args[1];
            values = kind === "f" ? f32s(args[2]) : kind === "ui" ? i32s(args[2]).map(v => v >>> 0) : i32s(args[2]);
        }
        else values = args.slice(1).map(v => kind === "ui" ? v >>> 0 : v);
        const target = uniform_at3(c, location, count);
        if(target === REFUSED || target === null) return target === null ? undefined : target;
        const u = target.at.uniform;
        if(kind === "m" && args[2] && c.version < 30) return fail(c, GL.INVALID_VALUE);
        const ok = kind === "m" ? u.columns === columns && u.rows === rows :
            !u.columns && u.components === components && (u.bool ||
                (u.sampler || u.opaque ? kind === "i" && components === 1 :
                kind === "f" ? !u.int : kind === "i" ? u.int && !u.uint : u.uint));
        if(!ok) return fail(c, GL.INVALID_OPERATION);
        if(u.sampler && values.slice(0, count).some(v => v < 0 || v >= MAX_UNITS)) return fail(c, GL.INVALID_VALUE);
        const size = kind === "m" ? columns * rows : components;
        const first = target.at.element;
        const n = Math.min(count, u.size - first);
        for(let i = 0; i < n; i++)
        {
            let v = values.slice(i * size, (i + 1) * size);
            // (a transposed matrix's values in columns)
            if(kind === "m" && args[2])
            {
                const t = [];
                for(let col = 0; col < columns; col++) for(let row = 0; row < rows; row++) t.push(v[row * columns + col]);
                v = t;
            }
            if(u.bool) v = v.map(x => x ? 1 : 0);
            target.program.values.set(u.location + first + i, v);
        }
        return undefined;
    };
    /** glGetUniform{f,i,ui}v of GLES 3.0 */
    const get_uniform3 = as => (shadow, c, [p, location, params]) =>
    {
        query(shadow);
        const program = c.group.objects.get(p);
        if(!program) { fail(c, GL.INVALID_VALUE); return; }
        if(program.kind !== "program" || !program.info || !program.info.ok) { fail(c, GL.INVALID_OPERATION); return; }
        const at = program.info.by_location[location];
        if(!at) { fail(c, GL.INVALID_OPERATION); return; }
        const u = at.uniform;
        const values = program.values.get(location) || new Array(u.columns ? u.columns * u.rows : u.components).fill(0);
        if(as === "f") put(params, values, "f", "f");
        else if(as === "ui") put(params, values.map(v => u.int ? v >>> 0 : Math.round(v) >>> 0), "i", "i");
        else put(params, values.map(v => u.int ? v | 0 : Math.round(v)), "i", "i");
    };

    /** The program of a query with GLES 3.0's errors, linked or not */
    const program_of = (c, p) =>
    {
        const program = c.group.objects.get(p);
        if(!program) { fail(c, GL.INVALID_VALUE); return null; }
        if(program.kind !== "program") { fail(c, GL.INVALID_OPERATION); return null; }
        return program;
    };

    /** int64 values into an out buffer */
    const put64 = (out, values) =>
    {
        for(let i = 0; i < values.length && 8 * i + 8 <= out.size; i++) out.view.setBigInt64(8 * i, BigInt(Math.trunc(values[i])), true);
    };

    /**
     * A float form of glVertexAttrib: GLES 2.0's, and the value the
     * context's current one (attrib_current's), which a query answers
     * before the vertex array's: else a value an integer form set earlier
     */
    const float_attrib = name => (shadow, c, args) =>
    {
        const r = base[name](shadow, c, args);
        if(args[0] < MAX_ATTRIBS) attrib_current(c, args[0], c.attribs[args[0]].current, "f");
        return r;
    };

    // ---- the handlers
    const H = {
        // ---- state
        "glEnable": (shadow, c, [cap]) =>
        {
            if(cap === GL.RASTERIZER_DISCARD || cap === GL.PRIMITIVE_RESTART_FIXED_INDEX) { c.enabled.add(cap); return undefined; }
            return base["glEnable"](shadow, c, [cap]);
        },
        "glDisable": (shadow, c, [cap]) =>
        {
            if(cap === GL.RASTERIZER_DISCARD || cap === GL.PRIMITIVE_RESTART_FIXED_INDEX) { c.enabled.delete(cap); return undefined; }
            return base["glDisable"](shadow, c, [cap]);
        },
        "glIsEnabled": (shadow, c, [cap]) =>
        {
            if(cap === GL.RASTERIZER_DISCARD || cap === GL.PRIMITIVE_RESTART_FIXED_INDEX) { query(shadow); return c.enabled.has(cap) ? 1 : 0; }
            return base["glIsEnabled"](shadow, c, [cap]);
        },
        "glHint": (shadow, c, [target, mode]) =>
        {
            if(target !== 0x8192 && target !== 0x8B8B || ![0x1100, 0x1101, 0x1102].includes(mode)) return fail(c, GL.INVALID_ENUM);
            c.hints.set(target, mode);
            return undefined;
        },
        "glPixelStorei": (shadow, c, [pname, param]) =>
        {
            const fields = { 0x0CF2: ["unpack", "row_length"], 0x806E: ["unpack", "image_height"], 0x0CF4: ["unpack", "skip_pixels"],
                0x0CF3: ["unpack", "skip_rows"], 0x806D: ["unpack", "skip_images"], 0x0D02: ["pack", "row_length"],
                0x0D04: ["pack", "skip_pixels"], 0x0D03: ["pack", "skip_rows"] };
            if(fields[pname])
            {
                if(param < 0) return fail(c, GL.INVALID_VALUE);
                c[fields[pname][0]][fields[pname][1]] = param;
                return undefined;
            }
            return base["glPixelStorei"](shadow, c, [pname, param]);
        },
        "glGetInteger64v": (shadow, c, [pname, data]) =>
        {
            query(shadow);
            const v = shadow.state_value(c, pname);
            if(!v) { fail(c, GL.INVALID_ENUM); return; }
            put64(data, h.state_kind(pname) === "n" ? v.map(x => x * 0x7FFFFFFF) : v);
        },
        "glGetIntegeri_v": (shadow, c, [target, index, data]) => { query(shadow); indexed(c, target, index, data, false); },
        "glGetInteger64i_v": (shadow, c, [target, index, data]) => { query(shadow); indexed(c, target, index, data, true); },
        // (GLES 3.1's; its own targets are gles31_state.js's, GLES 3.0's these)
        "glGetBooleani_v": (shadow, c, [target, index, data]) => { query(shadow); indexed(c, target, index, data, "b"); },

        // ---- buffers
        "glBindBuffer": (shadow, c, [target, name]) =>
        {
            if(!target_ok(c, target)) return fail(c, GL.INVALID_ENUM);
            if(name && !c.group.buffers.has(name)) c.group.buffers.set(name, new_buffer());
            set_buffer_binding(c, target, name);
            return undefined;
        },
        "glDeleteBuffers": (shadow, c, [n, names]) =>
        {
            if(n < 0) return fail(c, GL.INVALID_VALUE);
            for(const name of i32s(names).slice(0, n))
            {
                if(!name) continue;
                c.group.reserved.buffer.delete(name);
                if(!c.group.buffers.delete(name)) continue;
                for(const target of BUFFER_TARGETS.keys()) if(buffer_binding(c, target) === name) set_buffer_binding(c, target, 0);
                // (the bound vertex array's bindings alone: another keeps the name, GLES 3.0 2.10)
                const vao = c.vao ? c.vaos.get(c.vao) : c.default_vao;
                if(vao)
                {
                    for(const a of vao.attribs) if(a.buffer === name) a.buffer = 0;
                    if(vao.element_array_buffer === name) vao.element_array_buffer = 0;
                    // (GLES 3.1's vertex buffer binding points)
                    for(const b of vao.bindings || []) if(b.buffer === name) b.buffer = 0;
                }
                // (the indexed binding points: uniform blocks', GLES 3.1's storage blocks' and atomic counters')
                for(const b of [...c.uniform_bindings, ...c.storage_bindings || [], ...c.atomic_bindings || []])
                {
                    if(b.buffer === name) Object.assign(b, { buffer: 0, offset: 0, size: 0 });
                }
                for(const b of current_tf(c).bindings) if(b.buffer === name) Object.assign(b, { buffer: 0, offset: 0, size: 0 });
            }
            return undefined;
        },
        "glBufferData": (shadow, c, [target, size, data, usage]) =>
        {
            if(!target_ok(c, target) || !USAGES3.has(usage)) return fail(c, GL.INVALID_ENUM);
            if(size < 0) return fail(c, GL.INVALID_VALUE);
            const buffer = bound_buffer3(c, target);
            if(!buffer) return REFUSED;
            if(tf_bound_active(c, buffer_binding(c, target)) && target === GL.TRANSFORM_FEEDBACK_BUFFER) return fail(c, GL.INVALID_OPERATION);
            buffer.size = size;
            buffer.usage = usage;
            buffer.mapped = null;
            buffer.gpu_newer = false;
            const bytes = bytes_of(shadow, buffer);
            if(bytes && data) bytes.set(data.subarray(0, size));
            return undefined;
        },
        "glBufferSubData": (shadow, c, [target, offset, size, data]) =>
        {
            if(!target_ok(c, target)) return fail(c, GL.INVALID_ENUM);
            const buffer = bound_buffer3(c, target);
            if(!buffer) return REFUSED;
            if(offset < 0 || size < 0 || offset + size > buffer.size) return fail(c, GL.INVALID_VALUE);
            if(buffer.mapped) return fail(c, GL.INVALID_OPERATION);
            const bytes = bytes_of(shadow, buffer);
            if(bytes && data && !buffer.gpu_newer) bytes.set(data.subarray(0, size), offset);
            return undefined;
        },
        "glGetBufferParameteriv": (shadow, c, [target, pname, params]) =>
        {
            query(shadow);
            if(!target_ok(c, target)) { fail(c, GL.INVALID_ENUM); return; }
            const buffer = bound_buffer3(c, target);
            if(!buffer) return;
            const m = buffer.mapped;
            const values = { 0x8764: buffer.size, 0x8765: buffer.usage, 0x911F: m ? m.access : 0, 0x88BC: m ? 1 : 0,
                0x9120: m ? m.length : 0, 0x9121: m ? m.offset : 0 };
            if(!(pname in values) || pname === 0x9120 || pname === 0x9121) { fail(c, GL.INVALID_ENUM); return; }
            put(params, [values[pname]], "i", "i");
        },
        "glMapBufferRangeAEMU": (shadow, c, [target, offset, length, access, mapped]) =>
        {
            query(shadow);
            if(!target_ok(c, target)) { fail(c, GL.INVALID_ENUM); return; }
            const buffer = bound_buffer3(c, target);
            if(!buffer) return;
            if(offset < 0 || length < 0 || offset + length > buffer.size || access & ~0x3F) { fail(c, GL.INVALID_VALUE); return; }
            if(buffer.mapped || !length || !(access & 3) ||
                access & GL.MAP_READ_BIT && access & (GL.MAP_INVALIDATE_RANGE_BIT | GL.MAP_INVALIDATE_BUFFER_BIT | GL.MAP_UNSYNCHRONIZED_BIT) ||
                access & GL.MAP_FLUSH_EXPLICIT_BIT && !(access & GL.MAP_WRITE_BIT))
            {
                fail(c, GL.INVALID_OPERATION);
                return;
            }
            buffer.mapped = { offset, length, access };
            // (the mapped bytes: the CPU side's copy; of a buffer the page wrote since, the page's: the host asks for them, stale_map)
            const bytes = bytes_of(shadow, buffer);
            if(bytes && mapped && mapped.size) mapped.data.set(bytes.subarray(offset, offset + Math.min(length, mapped.size)));
            if(buffer.gpu_newer && bytes && !(access & (GL.MAP_INVALIDATE_RANGE_BIT | GL.MAP_INVALIDATE_BUFFER_BIT)))
            {
                shadow.stale_map = { name: buffer_binding(c, target), offset, length, bytes };
            }
        },
        "glUnmapBufferAEMU": (shadow, c, [target, offset, length, access, guest_buffer, out_res]) =>
        {
            if(!target_ok(c, target)) return fail(c, GL.INVALID_ENUM);
            const buffer = bound_buffer3(c, target);
            if(!buffer) return REFUSED;
            // (the mapping and its bytes come with the command, as gfxstream's decoder takes them: the page's shadow,
            // which never sees glMapBufferRangeAEMU (a query), takes them so)
            if(!buffer.mapped && !shadow.trusted) return fail(c, GL.INVALID_OPERATION);
            buffer.mapped = null;
            const bytes = bytes_of(shadow, buffer);
            if(bytes && guest_buffer && access & GL.MAP_WRITE_BIT && !(access & GL.MAP_FLUSH_EXPLICIT_BIT) && offset >= 0 && offset + length <= buffer.size)
            {
                bytes.set(guest_buffer.subarray(0, length), offset);
            }
            if(out_res && out_res.size) out_res.data[0] = 1;
            return undefined;
        },
        "glFlushMappedBufferRangeAEMU": (shadow, c, [target, offset, length, access, guest_buffer]) =>
        {
            if(!target_ok(c, target)) return fail(c, GL.INVALID_ENUM);
            const buffer = bound_buffer3(c, target);
            if(!buffer) return REFUSED;
            // (`offset` is the buffer's, not the mapping's: the encoder adds the mapping's, gfxstream's decoder says)
            const m = buffer.mapped;
            if(!shadow.trusted)
            {
                if(!m || !(m.access & GL.MAP_FLUSH_EXPLICIT_BIT)) return fail(c, GL.INVALID_OPERATION);
                if(offset < m.offset || length < 0 || offset + length > m.offset + m.length) return fail(c, GL.INVALID_VALUE);
            }
            const bytes = bytes_of(shadow, buffer);
            if(bytes && guest_buffer && offset >= 0 && offset + length <= buffer.size) bytes.set(guest_buffer.subarray(0, length), offset);
            return undefined;
        },
        "glCopyBufferSubData": (shadow, c, [read_target, write_target, read_offset, write_offset, size]) =>
        {
            if(!target_ok(c, read_target) || !target_ok(c, write_target)) return fail(c, GL.INVALID_ENUM);
            const from = bound_buffer3(c, read_target), to = from && bound_buffer3(c, write_target);
            if(!to) return REFUSED;
            if(read_offset < 0 || write_offset < 0 || size < 0 || read_offset + size > from.size || write_offset + size > to.size) return fail(c, GL.INVALID_VALUE);
            if(from === to && Math.abs(read_offset - write_offset) < size) return fail(c, GL.INVALID_VALUE);
            if(from.mapped || to.mapped) return fail(c, GL.INVALID_OPERATION);
            const a = bytes_of(shadow, from), b = bytes_of(shadow, to);
            if(a && b && !from.gpu_newer) b.set(a.slice(read_offset, read_offset + size), write_offset);
            else to.gpu_newer = to.gpu_newer || from.gpu_newer;
            return undefined;
        },
        "glBindBufferRange": (shadow, c, [target, index, buffer, offset, size]) => bind_buffer_indexed(shadow, c, target, index, buffer, offset, size, true),
        "glBindBufferBase": (shadow, c, [target, index, buffer]) => bind_buffer_indexed(shadow, c, target, index, buffer, 0, 0, false),

        // ---- vertex arrays and attributes
        "glGenVertexArrays": gen3("vao", c => c.vaos),
        "glBindVertexArray": (shadow, c, [name]) =>
        {
            if(name && !c.vaos.has(name))
            {
                if(!generated(shadow, c.reserved3.vao, name)) return fail(c, GL.INVALID_OPERATION);
                c.vaos.set(name, new_vao());
            }
            const vao = name ? c.vaos.get(name) : c.default_vao;
            const old = c.vao ? c.vaos.get(c.vao) : c.default_vao;
            old.element_array_buffer = c.element_array_buffer;
            c.attribs = vao.attribs;
            c.element_array_buffer = vao.element_array_buffer;
            c.vao = name;
            return undefined;
        },
        "glDeleteVertexArrays": (shadow, c, [n, names]) =>
        {
            if(n < 0) return fail(c, GL.INVALID_VALUE);
            for(const name of i32s(names).slice(0, n))
            {
                if(!name) continue;
                c.reserved3.vao.delete(name);
                if(!c.vaos.has(name)) continue;
                if(c.vao === name) H["glBindVertexArray"](shadow, c, [0]);
                c.vaos.delete(name);
            }
            return undefined;
        },
        "glIsVertexArray": (shadow, c, [name]) => { query(shadow); return c.vaos.has(name) ? 1 : 0; },
        "glVertexAttribPointerData": (shadow, c, args) =>
        {
            // (a client array: none in a vertex array object of GLES 3.0's)
            if(c.vao) return fail(c, GL.INVALID_OPERATION);
            return attrib3(c, args[0], args[1], args[2], args[3], args[4], 0, 0, false);
        },
        "glVertexAttribPointerOffset": (shadow, c, [index, size, type, normalized, stride, offset]) =>
        {
            if(c.vao && !c.array_buffer && offset) return fail(c, GL.INVALID_OPERATION);
            return attrib3(c, index, size, type, normalized, stride, c.array_buffer, offset, false);
        },
        "glVertexAttribIPointerDataAEMU": (shadow, c, [index, size, type, stride]) =>
        {
            if(c.vao) return fail(c, GL.INVALID_OPERATION);
            return attrib3(c, index, size, type, false, stride, 0, 0, true);
        },
        "glVertexAttribIPointerOffsetAEMU": (shadow, c, [index, size, type, stride, offset]) =>
        {
            if(c.vao && !c.array_buffer && offset) return fail(c, GL.INVALID_OPERATION);
            return attrib3(c, index, size, type, false, stride, c.array_buffer, offset, true);
        },
        "glVertexAttribDivisor": (shadow, c, [index, divisor]) =>
        {
            if(index >= MAX_ATTRIBS) return fail(c, GL.INVALID_VALUE);
            c.attribs[index].divisor = divisor >>> 0;
            return undefined;
        },
        "glVertexAttrib1f": float_attrib("glVertexAttrib1f"),
        "glVertexAttrib2f": float_attrib("glVertexAttrib2f"),
        "glVertexAttrib3f": float_attrib("glVertexAttrib3f"),
        "glVertexAttrib4f": float_attrib("glVertexAttrib4f"),
        "glVertexAttrib1fv": float_attrib("glVertexAttrib1fv"),
        "glVertexAttrib2fv": float_attrib("glVertexAttrib2fv"),
        "glVertexAttrib3fv": float_attrib("glVertexAttrib3fv"),
        "glVertexAttrib4fv": float_attrib("glVertexAttrib4fv"),
        "glVertexAttribI4i": (shadow, c, [index, ...v]) => attrib_current(c, index, v, "i"),
        "glVertexAttribI4ui": (shadow, c, [index, ...v]) => attrib_current(c, index, v.map(x => x >>> 0), "ui"),
        "glVertexAttribI4iv": (shadow, c, [index, v]) => attrib_current(c, index, i32s(v).slice(0, 4), "i"),
        "glVertexAttribI4uiv": (shadow, c, [index, v]) => attrib_current(c, index, i32s(v).slice(0, 4).map(x => x >>> 0), "ui"),
        "glGetVertexAttribIiv": (shadow, c, [index, pname, params]) => get_attrib3(shadow, c, index, pname, params, "i"),
        "glGetVertexAttribIuiv": (shadow, c, [index, pname, params]) => get_attrib3(shadow, c, index, pname, params, "ui"),
        "glGetVertexAttribiv": (shadow, c, [index, pname, params]) => get_attrib3(shadow, c, index, pname, params, "iv"),
        "glGetVertexAttribfv": (shadow, c, [index, pname, params]) => get_attrib3(shadow, c, index, pname, params, "f"),

        // ---- drawing
        "glDrawArrays": (shadow, c, [mode, first, count]) =>
        {
            if(first < 0) return mode_ok(c, mode) ? fail(c, GL.INVALID_VALUE) : fail(c, GL.INVALID_ENUM);
            return draw_checks(shadow, c, mode, count, 1, false);
        },
        "glDrawArraysInstanced": (shadow, c, [mode, first, count, instances]) =>
        {
            if(first < 0) return mode_ok(c, mode) ? fail(c, GL.INVALID_VALUE) : fail(c, GL.INVALID_ENUM);
            return draw_checks(shadow, c, mode, count, instances, false);
        },
        "glDrawElementsOffset": (shadow, c, [mode, count, type]) => elements3(shadow, c, mode, count, type, 1, true),
        "glDrawElementsData": (shadow, c, [mode, count, type]) => elements3(shadow, c, mode, count, type, 1, false),
        "glDrawElementsInstancedOffsetAEMU": (shadow, c, [mode, count, type, offset, instances]) => elements3(shadow, c, mode, count, type, instances, true),
        "glDrawElementsInstancedDataAEMU": (shadow, c, [mode, count, type, data, instances]) => elements3(shadow, c, mode, count, type, instances, false),
        "glDrawRangeElementsOffsetAEMU": (shadow, c, [mode, start, end, count, type]) =>
        {
            if(end < start) return fail(c, GL.INVALID_VALUE);
            return elements3(shadow, c, mode, count, type, 1, true);
        },
        "glDrawRangeElementsDataAEMU": (shadow, c, [mode, start, end, count, type]) =>
        {
            if(end < start) return fail(c, GL.INVALID_VALUE);
            return elements3(shadow, c, mode, count, type, 1, false);
        },
        "glClear": (shadow, c, [mask]) =>
        {
            if(mask & ~(0x4000 | 0x0100 | 0x0400)) return fail(c, GL.INVALID_VALUE);
            if(!complete(c, false)) return REFUSED;
            return undefined;
        },
        "glClearBufferiv": (shadow, c, [buffer, drawbuffer]) => clear_buffer(c, buffer, drawbuffer, "i"),
        "glClearBufferuiv": (shadow, c, [buffer, drawbuffer]) => clear_buffer(c, buffer, drawbuffer, "ui"),
        "glClearBufferfv": (shadow, c, [buffer, drawbuffer]) => clear_buffer(c, buffer, drawbuffer, "f"),
        "glClearBufferfi": (shadow, c, [buffer, drawbuffer]) => clear_buffer(c, buffer, drawbuffer, "fi"),
        "glReadPixels": (shadow, c, [x, y, width, height, format, type]) => read_pixels3(shadow, c, width, height, format, type, false),
        "glReadPixelsOffsetAEMU": (shadow, c, [x, y, width, height, format, type, offset]) =>
        {
            const buffer = c.group.buffers.get(c.buffers.pixel_pack);
            if(!buffer || buffer.mapped) return fail(c, GL.INVALID_OPERATION);
            const r = read_pixels3(shadow, c, width, height, format, type, true);
            if(r === REFUSED) return r;
            const needed = image_bytes3(width, height, 1, format, type, { alignment: c.pack_alignment, row_length: c.pack.row_length,
                image_height: 0, skip_pixels: c.pack.skip_pixels, skip_rows: c.pack.skip_rows, skip_images: 0 });
            if(offset < 0 || offset + needed > buffer.size || offset % Math.max(1, pixel_bytes(format, type) >= 4 ? 4 : pixel_bytes(format, type))) {
                return fail(c, GL.INVALID_OPERATION);
            }
            buffer.gpu_newer = true;
            return undefined;
        },

        // ---- textures
        "glActiveTexture": (shadow, c, [unit]) =>
        {
            const index = unit - 0x84C0;
            if(index < 0 || index >= MAX_UNITS) return fail(c, GL.INVALID_ENUM);
            c.active_texture = index;
            return undefined;
        },
        "glBindTexture": (shadow, c, [target, name]) =>
        {
            const slot = target_slot(target, c);
            if(slot < 0) return fail(c, GL.INVALID_ENUM);
            if(name)
            {
                const texture = c.group.textures.get(name);
                if(texture && texture.target !== target) return fail(c, GL.INVALID_OPERATION);
                if(!texture) c.group.textures.set(name, h.new_texture(target));
            }
            c.textures[c.active_texture][slot] = name;
            return undefined;
        },
        "glDeleteTextures": (shadow, c, [n, names]) =>
        {
            if(n < 0) return fail(c, GL.INVALID_VALUE);
            for(const name of i32s(names).slice(0, n))
            {
                if(!name) continue;
                c.group.reserved.texture.delete(name);
                const texture = c.group.textures.get(name);
                if(!c.group.textures.delete(name)) continue;
                for(const unit of c.textures) for(let i = 0; i < unit.length; i++) if(unit[i] === name) unit[i] = 0;
                for(const fbo of c.framebuffers.values())
                {
                    if(fbo.name !== c.framebuffer && fbo.name !== c.read_framebuffer) continue;
                    for(const [attachment, a] of fbo.attachments) if(a.type === GL.TEXTURE && a.name === name) fbo.attachments.delete(attachment);
                }
                h.detach(c, GL.TEXTURE, name);
                h.keep_orphan(c, GL.TEXTURE, c.group.textures, name, texture);
            }
            return undefined;
        },
        "glTexImage2D": (shadow, c, args) => tex_image(shadow, c, false, args),
        "glTexImage2DOffsetAEMU": (shadow, c, args) => tex_image(shadow, c, false, args),
        "glTexImage3D": (shadow, c, args) => tex_image(shadow, c, true, args),
        "glTexImage3DOffsetAEMU": (shadow, c, args) => tex_image(shadow, c, true, args),
        "glTexSubImage2D": (shadow, c, args) => tex_sub_image(shadow, c, false, args),
        "glTexSubImage2DOffsetAEMU": (shadow, c, args) => tex_sub_image(shadow, c, false, args),
        "glTexSubImage3D": (shadow, c, args) => tex_sub_image(shadow, c, true, args),
        "glTexSubImage3DOffsetAEMU": (shadow, c, args) => tex_sub_image(shadow, c, true, args),
        "glTexStorage2D": (shadow, c, [target, levels, internalformat, width, height]) =>
        {
            if(target !== GL.TEXTURE_2D && target !== GL.TEXTURE_CUBE_MAP) return fail(c, GL.INVALID_ENUM);
            return tex_storage(shadow, c, target, levels, internalformat, width, height, undefined);
        },
        "glTexStorage3D": (shadow, c, [target, levels, internalformat, width, height, depth]) =>
        {
            if(target !== GL.TEXTURE_3D && !layered(c, target)) return fail(c, GL.INVALID_ENUM);
            return tex_storage(shadow, c, target, levels, internalformat, width, height, depth);
        },
        "glCompressedTexImage2D": (shadow, c, args) => compressed_image(shadow, c, false, args),
        "glCompressedTexImage2DOffsetAEMU": (shadow, c, args) => compressed_image(shadow, c, false, args),
        "glCompressedTexImage3D": (shadow, c, args) => compressed_image(shadow, c, true, args),
        "glCompressedTexImage3DOffsetAEMU": (shadow, c, args) => compressed_image(shadow, c, true, args),
        "glCompressedTexSubImage2D": (shadow, c, args) => compressed_sub_image(shadow, c, false, args),
        "glCompressedTexSubImage2DOffsetAEMU": (shadow, c, args) => compressed_sub_image(shadow, c, false, args),
        "glCompressedTexSubImage3D": (shadow, c, args) => compressed_sub_image(shadow, c, true, args),
        "glCompressedTexSubImage3DOffsetAEMU": (shadow, c, args) => compressed_sub_image(shadow, c, true, args),
        "glCopyTexImage2D": (shadow, c, [target, level, internalformat, x, y, width, height, border]) =>
        {
            const face = face_of(target);
            if(face < 0) return fail(c, GL.INVALID_ENUM);
            const texture = bound_texture3(c, target === GL.TEXTURE_2D ? GL.TEXTURE_2D : GL.TEXTURE_CUBE_MAP);
            if(!texture) return REFUSED;
            const info = format_info(internalformat) || ([0x1907, 0x1908].includes(internalformat) ? format_info(internalformat === 0x1907 ? 0x8051 : 0x8058) : null);
            if(!info) return fail(c, GL.INVALID_ENUM);
            if(!size_ok(c, target === GL.TEXTURE_2D ? GL.TEXTURE_2D : GL.TEXTURE_CUBE_MAP, level, width, height, 1, border)) return REFUSED;
            if(texture.immutable) return fail(c, GL.INVALID_OPERATION);
            if(!complete(c, true)) return REFUSED;
            const source = read_image(c);
            if(!source || !copy_compatible(source.info, info) || source.samples) return fail(c, GL.INVALID_OPERATION);
            texture.images.set(image_key(face, level), { width, height, depth: 1, format: info.format, type: info.types[0],
                internal: info.sized ? info.value : internalformat, compressed: false });
            return undefined;
        },
        "glCopyTexSubImage2D": (shadow, c, [target, level, xoffset, yoffset, x, y, width, height]) =>
            copy_sub(shadow, c, target, level, xoffset, yoffset, 0, width, height, false),
        "glCopyTexSubImage3D": (shadow, c, [target, level, xoffset, yoffset, zoffset, x, y, width, height]) =>
            copy_sub(shadow, c, target, level, xoffset, yoffset, zoffset, width, height, true),
        "glGenerateMipmap": (shadow, c, [target]) =>
        {
            if(![GL.TEXTURE_2D, GL.TEXTURE_CUBE_MAP, GL.TEXTURE_3D, GL.TEXTURE_2D_ARRAY].includes(target) && !layered(c, target)) return fail(c, GL.INVALID_ENUM);
            const texture = bound_texture3(c, target);
            if(!texture) return REFUSED;
            const base_level = Math.min(texture.base_level || 0, 31);
            const faces = target === GL.TEXTURE_CUBE_MAP ? 6 : 1;
            const first = texture.images.get(image_key(0, base_level));
            if(!first) return fail(c, GL.INVALID_OPERATION);
            const info = first.compressed ? null : format_info(first.internal || first.format);
            if(!info || !info.filterable || info.sized && !renderable(info, c.color_buffer_float) || info.kind === "depth" || info.kind === "depth_stencil") {
                return fail(c, GL.INVALID_OPERATION);
            }
            for(let face = 0; face < faces; face++)
            {
                const image = texture.images.get(image_key(face, base_level));
                if(!image || image.width !== first.width || image.height !== first.height || image.internal !== first.internal) return fail(c, GL.INVALID_OPERATION);
            }
            const last = texture.immutable ? texture.immutable_levels - 1 : 31;
            for(let face = 0; face < faces; face++)
            {
                let w = first.width, hh = first.height, d = first.depth || 1;
                for(let level = base_level + 1; level <= last && (w > 1 || hh > 1 || target === GL.TEXTURE_3D && d > 1); level++)
                {
                    w = Math.max(1, w >> 1);
                    hh = Math.max(1, hh >> 1);
                    if(target === GL.TEXTURE_3D) d = Math.max(1, d >> 1);
                    texture.images.set(image_key(face, level), Object.assign({}, first, { width: w, height: hh, depth: d }));
                }
            }
            return undefined;
        },
        "glTexParameterf": (shadow, c, [target, pname, param]) => tex_parameter3(shadow, c, target, pname, [param], true),
        "glTexParameteri": (shadow, c, [target, pname, param]) => tex_parameter3(shadow, c, target, pname, [param], false),
        "glTexParameterfv": (shadow, c, [target, pname, params]) => tex_parameter3(shadow, c, target, pname, f32s(params), true, true),
        "glTexParameteriv": (shadow, c, [target, pname, params]) => tex_parameter3(shadow, c, target, pname, i32s(params), false, true),
        "glGetTexParameteriv": (shadow, c, [target, pname, params]) => get_tex_parameter3(shadow, c, target, pname, params, "i"),
        "glGetTexParameterfv": (shadow, c, [target, pname, params]) => get_tex_parameter3(shadow, c, target, pname, params, "f"),

        // ---- samplers
        "glGenSamplers": (shadow, c, [n, names]) =>
        {
            query(shadow);
            if(n < 0) return fail(c, GL.INVALID_VALUE);
            for(let i = 0; i < n && 4 * i + 4 <= names.size; i++)
            {
                const name = c.group.fresh("sampler", c.group.samplers);
                c.group.samplers.set(name, new_sampler());
                names.view.setUint32(4 * i, name, true);
            }
            return undefined;
        },
        "glDeleteSamplers": (shadow, c, [n, names]) =>
        {
            if(n < 0) return fail(c, GL.INVALID_VALUE);
            for(const name of i32s(names).slice(0, n))
            {
                if(!c.group.samplers.delete(name)) continue;
                for(let i = 0; i < c.samplers.length; i++) if(c.samplers[i] === name) c.samplers[i] = 0;
            }
            return undefined;
        },
        "glIsSampler": (shadow, c, [name]) => { query(shadow); return c.group.samplers.has(name) ? 1 : 0; },
        "glBindSampler": (shadow, c, [unit, name]) =>
        {
            if(unit >= MAX_UNITS) return fail(c, GL.INVALID_VALUE);
            if(name && !c.group.samplers.has(name))
            {
                if(!shadow.trusted) return fail(c, GL.INVALID_OPERATION);
                c.group.samplers.set(name, new_sampler());
            }
            c.samplers[unit] = name;
            return undefined;
        },
        "glSamplerParameterf": (shadow, c, [s, pname, param]) => sampler_parameter(shadow, c, s, pname, [param], true),
        "glSamplerParameteri": (shadow, c, [s, pname, param]) => sampler_parameter(shadow, c, s, pname, [param], false),
        "glSamplerParameterfv": (shadow, c, [s, pname, params]) => sampler_parameter(shadow, c, s, pname, f32s(params), true, true),
        "glSamplerParameteriv": (shadow, c, [s, pname, params]) => sampler_parameter(shadow, c, s, pname, i32s(params), false, true),
        "glGetSamplerParameterfv": (shadow, c, [s, pname, params]) => get_sampler_parameter(shadow, c, s, pname, params, "f"),
        "glGetSamplerParameteriv": (shadow, c, [s, pname, params]) => get_sampler_parameter(shadow, c, s, pname, params, "i"),

        // ---- renderbuffers and framebuffers
        "glRenderbufferStorage": (shadow, c, [target, format, width, height]) => renderbuffer_storage(c, target, 0, format, width, height),
        "glRenderbufferStorageMultisample": (shadow, c, [target, samples, format, width, height]) =>
            renderbuffer_storage(c, target, samples, format, width, height),
        "glGetRenderbufferParameteriv": (shadow, c, [target, pname, params]) =>
        {
            if(pname === 0x8CAB)
            {
                query(shadow);
                if(target !== GL.RENDERBUFFER) { fail(c, GL.INVALID_ENUM); return undefined; }
                const rb = c.group.renderbuffers.get(c.renderbuffer);
                if(!rb) { fail(c, GL.INVALID_OPERATION); return undefined; }
                put(params, [rb.samples || 0], "i", "i");
                return undefined;
            }
            return base["glGetRenderbufferParameteriv"](shadow, c, [target, pname, params]);
        },
        "glGetInternalformativ": (shadow, c, [target, internalformat, pname, size, params]) =>
        {
            query(shadow);
            // (GLES 3.1's multisampled textures, 3.2's arrays: the renderbuffers' counts)
            const textures = c.version >= 31 && target === 0x9100 || c.version >= 32 && target === 0x9102;
            if(target !== GL.RENDERBUFFER && !textures || pname !== 0x80A9 && pname !== 0x9380) { fail(c, GL.INVALID_ENUM); return; }
            const info = format_info(internalformat) || (internalformat === 0x8D48 ? { kind: "stencil" } : null);
            if(!info || !(info.kind === "stencil" || renderable(info, c.color_buffer_float))) { fail(c, GL.INVALID_ENUM); return; }
            if(size < 0) { fail(c, GL.INVALID_VALUE); return; }
            const counts = info.kind === "int" || info.kind === "uint" ? [] : [4];
            if(pname === 0x9380) put(params, [counts.length], "i", "i");
            else put(params, counts.slice(0, Math.max(0, size)), "i", "i");
        },
        "glGenFramebuffers": (shadow, c, args) => base["glGenFramebuffers"](shadow, c, args),
        "glBindFramebuffer": (shadow, c, [target, name]) =>
        {
            if(framebuffer_of(c, target) < 0) return fail(c, GL.INVALID_ENUM);
            if(name && !c.framebuffers.has(name)) c.framebuffers.set(name, Object.assign(new_framebuffer3(), { name }));
            if(target !== GL.READ_FRAMEBUFFER) c.framebuffer = name;
            if(target !== GL.DRAW_FRAMEBUFFER) c.read_framebuffer = name;
            return undefined;
        },
        "glDeleteFramebuffers": (shadow, c, [n, names]) =>
        {
            if(n < 0) return fail(c, GL.INVALID_VALUE);
            for(const name of i32s(names).slice(0, n))
            {
                if(!name) continue;
                c.reserved_framebuffers.delete(name);
                if(!c.framebuffers.delete(name)) continue;
                if(c.framebuffer === name) c.framebuffer = 0;
                if(c.read_framebuffer === name) c.read_framebuffer = 0;
            }
            return undefined;
        },
        "glCheckFramebufferStatus": (shadow, c, [target]) =>
        {
            query(shadow);
            const name = framebuffer_of(c, target);
            if(name < 0) { fail(c, GL.INVALID_ENUM); return 0; }
            return status_of(c, name);
        },
        "glFramebufferRenderbuffer": (shadow, c, [target, attachment, rbtarget, name]) =>
        {
            const fb = framebuffer_of(c, target);
            if(fb < 0 || !attachment_ok(attachment) || rbtarget !== GL.RENDERBUFFER) return fail(c, GL.INVALID_ENUM);
            const fbo = c.framebuffers.get(fb);
            if(!fbo || name && !c.group.renderbuffers.has(name)) return fail(c, GL.INVALID_OPERATION);
            attach(fbo, attachment, name ? { type: GL.RENDERBUFFER, name, level: 0, face: 0, layer: 0 } : null);
            return undefined;
        },
        "glFramebufferTexture2D": (shadow, c, [target, attachment, textarget, name, level]) =>
        {
            const fb = framebuffer_of(c, target);
            if(fb < 0 || !attachment_ok(attachment)) return fail(c, GL.INVALID_ENUM);
            const fbo = c.framebuffers.get(fb);
            if(!fbo) return fail(c, GL.INVALID_OPERATION);
            if(!name) { attach(fbo, attachment, null); return undefined; }
            const face = face_of(textarget);
            if(face < 0) return fail(c, GL.INVALID_ENUM);
            const texture = c.group.textures.get(name);
            if(!texture || (texture.target === GL.TEXTURE_CUBE_MAP) !== (textarget !== GL.TEXTURE_2D) ||
                texture.target !== GL.TEXTURE_2D && texture.target !== GL.TEXTURE_CUBE_MAP)
            {
                return fail(c, GL.INVALID_OPERATION);
            }
            if(level < 0 || level >= MAX_LEVELS_2D) return fail(c, GL.INVALID_VALUE);
            attach(fbo, attachment, { type: GL.TEXTURE, name, level, face, layer: 0 });
            return undefined;
        },
        "glFramebufferTextureLayer": (shadow, c, [target, attachment, name, level, layer]) =>
        {
            const fb = framebuffer_of(c, target);
            if(fb < 0 || !attachment_ok(attachment)) return fail(c, GL.INVALID_ENUM);
            const fbo = c.framebuffers.get(fb);
            if(!fbo) return fail(c, GL.INVALID_OPERATION);
            if(!name) { attach(fbo, attachment, null); return undefined; }
            const texture = c.group.textures.get(name);
            if(!texture || texture.target !== GL.TEXTURE_3D && !layered(c, texture.target)) return fail(c, GL.INVALID_OPERATION);
            const max_layer = texture.target === GL.TEXTURE_3D ? LIMITS3.MAX_3D_TEXTURE_SIZE : LIMITS3.MAX_ARRAY_TEXTURE_LAYERS;
            if(layer < 0 || layer >= max_layer || level < 0 || level > max_level_of(texture.target)) return fail(c, GL.INVALID_VALUE);
            attach(fbo, attachment, { type: GL.TEXTURE, name, level, face: 0, layer });
            return undefined;
        },
        "glGetFramebufferAttachmentParameteriv": (shadow, c, [target, attachment, pname, params]) =>
        {
            query(shadow);
            const fb = framebuffer_of(c, target);
            if(fb < 0) { fail(c, GL.INVALID_ENUM); return; }
            const value = attachment_parameter(c, fb, attachment, pname);
            if(value !== null) put(params, [value], "i", "i");
        },
        "glDrawBuffers": (shadow, c, [n, bufs]) =>
        {
            const list = i32s(bufs).slice(0, Math.max(0, n));
            if(n < 0 || n > LIMITS3.MAX_DRAW_BUFFERS) return fail(c, GL.INVALID_VALUE);
            if(!c.framebuffer)
            {
                if(n !== 1 || list[0] !== GL.BACK && list[0] !== GL.NONE) return fail(c, GL.INVALID_OPERATION);
                c.default_draw_buffer = list[0];
                return undefined;
            }
            for(let i = 0; i < n; i++)
            {
                if(list[i] !== GL.NONE && list[i] !== GL.COLOR_ATTACHMENT0 + i)
                {
                    return color_attachment(list[i]) || list[i] === GL.BACK ? fail(c, GL.INVALID_OPERATION) : fail(c, GL.INVALID_ENUM);
                }
            }
            const fbo = c.framebuffers.get(c.framebuffer);
            fbo.draw_buffers = Array.from({ length: LIMITS3.MAX_DRAW_BUFFERS }, (_, i) => i < n ? list[i] : GL.NONE);
            return undefined;
        },
        "glReadBuffer": (shadow, c, [src]) =>
        {
            if(src !== GL.BACK && src !== GL.NONE && !(src >= GL.COLOR_ATTACHMENT0 && src < GL.COLOR_ATTACHMENT0 + 32)) return fail(c, GL.INVALID_ENUM);
            if(!c.read_framebuffer)
            {
                if(src !== GL.BACK && src !== GL.NONE) return fail(c, GL.INVALID_OPERATION);
                c.default_read_buffer = src;
                return undefined;
            }
            if(src === GL.BACK) return fail(c, GL.INVALID_OPERATION);
            if(src !== GL.NONE && !color_attachment(src)) return fail(c, GL.INVALID_OPERATION);
            c.framebuffers.get(c.read_framebuffer).read_buffer = src;
            return undefined;
        },
        "glBlitFramebuffer": (shadow, c, [sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter]) =>
        {
            if(mask & ~(0x4000 | 0x0100 | 0x0400)) return fail(c, GL.INVALID_VALUE);
            if(filter !== GL.NEAREST && filter !== GL.LINEAR) return fail(c, GL.INVALID_ENUM);
            if(filter === GL.LINEAR && mask & (0x0100 | 0x0400)) return fail(c, GL.INVALID_OPERATION);
            if(!complete(c, true)) return REFUSED;
            const source = read_image(c);
            if(mask & 0x4000 && source)
            {
                if(source.samples && (sx0 !== dx0 || sy0 !== dy0 || sx1 !== dx1 || sy1 !== dy1)) return fail(c, GL.INVALID_OPERATION);
                const kind = source.info.kind;
                if((kind === "int" || kind === "uint") && filter === GL.LINEAR) return fail(c, GL.INVALID_OPERATION);
                for(const image of draw_images(c))
                {
                    const dk = image.info.kind;
                    const integer = k => k === "int" || k === "uint";
                    if(integer(kind) !== integer(dk) || integer(kind) && kind !== dk) return fail(c, GL.INVALID_OPERATION);
                    if(source.samples && image.info.value !== source.info.value) return fail(c, GL.INVALID_OPERATION);
                }
                if(draw_images(c).some(i => i.samples)) return fail(c, GL.INVALID_OPERATION);
            }
            for(const [bit, point] of [[0x0100, GL.DEPTH_ATTACHMENT], [0x0400, GL.STENCIL_ATTACHMENT]])
            {
                if(!(mask & bit)) continue;
                const a = depth_stencil_image(c, c.read_framebuffer, point), b = depth_stencil_image(c, c.framebuffer, point);
                if(a && b && a.info.value !== b.info.value) return fail(c, GL.INVALID_OPERATION);
            }
            if(c.read_framebuffer && c.read_framebuffer === c.framebuffer) return fail(c, GL.INVALID_OPERATION);
            return undefined;
        },
        "glInvalidateFramebuffer": (shadow, c, [target, n, attachments]) => invalidate(c, target, n, attachments, 0, 0),
        "glInvalidateSubFramebuffer": (shadow, c, [target, n, attachments, x, y, width, height]) =>
            invalidate(c, target, n, attachments, width, height),

        // ---- programs: uniform blocks, transform feedback varyings, the rest of GLES 3.0's
        "glGetUniformBlockIndex": (shadow, c, [p, name]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return -1 >>> 0;
            if(!program.info || !program.info.ok) { fail(c, GL.INVALID_OPERATION); return -1 >>> 0; }
            const text = text_of(name);
            const index = (program.info.blocks || []).findIndex(b => b.name === text || b.name + "[0]" === text);
            return index < 0 ? 0xFFFFFFFF : index;
        },
        "glGetActiveUniformBlockiv": (shadow, c, [p, index, pname, params]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return;
            const blocks = program.info && program.info.ok ? program.info.blocks || [] : [];
            if(index >= blocks.length) { fail(c, GL.INVALID_VALUE); return; }
            const b = blocks[index];
            const binding = (program.block_bindings || [])[index] || 0;
            const values = { 0x8A3F: [binding], 0x8A40: [b.size], 0x8A41: [b.name.length + 1], 0x8A42: [b.members.length],
                0x8A43: b.members, 0x8A44: [b.stages & 1 ? 1 : 0], 0x8A46: [b.stages & 16 ? 1 : 0] };
            if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
            put(params, values[pname], "i", "i");
        },
        "glGetActiveUniformBlockName": (shadow, c, [p, index, size, length, name]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return;
            const blocks = program.info && program.info.ok ? program.info.blocks || [] : [];
            if(index >= blocks.length || size < 0) { fail(c, GL.INVALID_VALUE); return; }
            const written = put_text(name, blocks[index].name);
            if(length && length.size) put(length, [written], "i", "i");
        },
        "glUniformBlockBinding": (shadow, c, [p, index, binding]) =>
        {
            const program = program_of(c, p);
            if(!program) return REFUSED;
            const blocks = program.info && program.info.ok ? program.info.blocks || [] : [];
            if(index >= blocks.length || binding >= LIMITS3.MAX_UNIFORM_BUFFER_BINDINGS) return fail(c, GL.INVALID_VALUE);
            program.block_bindings = program.block_bindings || blocks.map(b => b.binding);
            program.block_bindings[index] = binding;
            return undefined;
        },
        "glGetUniformIndicesAEMU": (shadow, c, [p, count, packed, length, indices]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return;
            if(count < 0) { fail(c, GL.INVALID_VALUE); return; }
            const names = text_of(packed).split(";").slice(0, count);
            const uniforms = program.info && program.info.ok ? program.info.uniforms : [];
            put(indices, names.map(n =>
            {
                const i = uniforms.findIndex(u => u.name === n || u.base === n && u.name.endsWith("[0]"));
                return i < 0 ? -1 : i;
            }), "i", "i");
        },
        "glGetActiveUniformsiv": (shadow, c, [p, count, indices, pname, params]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return;
            if(count < 0) { fail(c, GL.INVALID_VALUE); return; }
            const uniforms = program.info && program.info.ok ? program.info.uniforms : [];
            const list = i32s(indices).slice(0, count);
            if(list.some(i => i < 0 || i >= uniforms.length)) { fail(c, GL.INVALID_VALUE); return; }
            // (the offsets and strides of uniforms in buffers: blocks' members, atomic counters)
            const in_buffer = u => u.block_index >= 0 || u.opaque === "atomic";
            const field = { 0x8A37: u => u.type, 0x8A38: u => u.size, 0x8A39: u => u.name.length + 1, 0x8A3A: u => u.block_index,
                0x8A3B: u => in_buffer(u) ? u.offset : -1, 0x8A3C: u => !in_buffer(u) ? -1 : u.size > 1 || u.name.endsWith("]") ? u.array_stride : 0,
                0x8A3D: u => !in_buffer(u) ? -1 : u.columns ? u.matrix_stride : 0, 0x8A3E: u => u.row_major ? 1 : 0 }[pname];
            if(!field) { fail(c, GL.INVALID_ENUM); return; }
            put(params, list.map(i => field(uniforms[i])), "i", "i");
        },
        "glUniform1ui": uniform3(1, "ui", false),
        "glUniform2ui": uniform3(2, "ui", false),
        "glUniform3ui": uniform3(3, "ui", false),
        "glUniform4ui": uniform3(4, "ui", false),
        "glUniform1uiv": uniform3(1, "ui", true),
        "glUniform2uiv": uniform3(2, "ui", true),
        "glUniform3uiv": uniform3(3, "ui", true),
        "glUniform4uiv": uniform3(4, "ui", true),
        "glUniform1f": uniform3(1, "f", false), "glUniform2f": uniform3(2, "f", false), "glUniform3f": uniform3(3, "f", false),
        "glUniform4f": uniform3(4, "f", false),
        "glUniform1fv": uniform3(1, "f", true), "glUniform2fv": uniform3(2, "f", true), "glUniform3fv": uniform3(3, "f", true),
        "glUniform4fv": uniform3(4, "f", true),
        "glUniform1i": uniform3(1, "i", false), "glUniform2i": uniform3(2, "i", false), "glUniform3i": uniform3(3, "i", false),
        "glUniform4i": uniform3(4, "i", false),
        "glUniform1iv": uniform3(1, "i", true), "glUniform2iv": uniform3(2, "i", true), "glUniform3iv": uniform3(3, "i", true),
        "glUniform4iv": uniform3(4, "i", true),
        "glUniformMatrix2fv": uniform3(0, "m", true, 2, 2), "glUniformMatrix3fv": uniform3(0, "m", true, 3, 3),
        "glUniformMatrix4fv": uniform3(0, "m", true, 4, 4),
        "glUniformMatrix2x3fv": uniform3(0, "m", true, 2, 3), "glUniformMatrix3x2fv": uniform3(0, "m", true, 3, 2),
        "glUniformMatrix2x4fv": uniform3(0, "m", true, 2, 4), "glUniformMatrix4x2fv": uniform3(0, "m", true, 4, 2),
        "glUniformMatrix3x4fv": uniform3(0, "m", true, 3, 4), "glUniformMatrix4x3fv": uniform3(0, "m", true, 4, 3),
        "glGetUniformfv": get_uniform3("f"),
        "glGetUniformiv": get_uniform3("i"),
        "glGetUniformuiv": get_uniform3("ui"),
        "glGetFragDataLocation": (shadow, c, [p, name]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return -1;
            if(!program.info || !program.info.ok) { fail(c, GL.INVALID_OPERATION); return -1; }
            const text = text_of(name);
            // (a fragment shader's outputs: a separable program of another stage reflects its own)
            if(program.info.spirv && !program.info.spirv.some(m => m.stage === "fragment")) return -1;
            const outputs = program.info.reflection && program.info.reflection.outputs || program.info.outputs || [];
            const o = outputs.find(x => x.name === text || x.name === text + "[0]" || x.name.replace(/\[0\]$/, "") === text.replace(/\[\d+\]$/, ""));
            if(!o) return -1;
            const element = /\[(\d+)\]$/.exec(text);
            return (o.location >= 0 ? o.location : 0) + (element ? +element[1] : 0);
        },
        "glGetProgramiv": (shadow, c, [p, pname, params]) =>
        {
            const own = [0x8C83, 0x8C7F, 0x8C76, 0x8A36, 0x8A35, 0x8257, 0x8741];
            if(!own.includes(pname)) return base["glGetProgramiv"](shadow, c, [p, pname, params]);
            query(shadow);
            const program = program_of(c, p);
            if(!program) return undefined;
            const info = program.info && program.info.ok ? program.info : null;
            const varyings = info ? info.tf_varyings || [] : [];
            const blocks = info ? info.blocks || [] : [];
            const longest = list => list.reduce((n, x) => Math.max(n, x.name.length + 1), 0);
            const value = { 0x8C83: varyings.length, 0x8C7F: info ? info.tf_mode || GL.INTERLEAVED_ATTRIBS : GL.INTERLEAVED_ATTRIBS,
                0x8C76: longest(varyings), 0x8A36: blocks.length, 0x8A35: longest(blocks), 0x8257: program.binary_hint || 0, 0x8741: 0 }[pname];
            put(params, [value], "i", "i");
            return undefined;
        },
        "glProgramParameteri": (shadow, c, [p, pname, value]) =>
        {
            const program = program_of(c, p);
            if(!program) return REFUSED;
            if(pname !== 0x8257) return fail(c, GL.INVALID_ENUM);
            if(value !== 0 && value !== 1) return fail(c, GL.INVALID_VALUE);
            program.binary_hint = value;
            return undefined;
        },
        "glGetProgramBinary": (shadow, c, [p, size, length]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return;
            // (no binary formats: GL_NUM_PROGRAM_BINARY_FORMATS 0)
            if(!program.info || !program.info.ok) { fail(c, GL.INVALID_OPERATION); return; }
            fail(c, GL.INVALID_OPERATION);
            if(length && length.size) put(length, [0], "i", "i");
        },
        "glProgramBinary": (shadow, c, [p]) =>
        {
            const program = program_of(c, p);
            if(!program) return REFUSED;
            return fail(c, GL.INVALID_ENUM);
        },
        "glTransformFeedbackVaryingsAEMU": (shadow, c, [p, count, packed, length, mode]) =>
        {
            const program = program_of(c, p);
            if(!program) return REFUSED;
            if(mode !== GL.INTERLEAVED_ATTRIBS && mode !== GL.SEPARATE_ATTRIBS) return fail(c, GL.INVALID_ENUM);
            if(count < 0 || mode === GL.SEPARATE_ATTRIBS && count > LIMITS3.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS) return fail(c, GL.INVALID_VALUE);
            program.tf_request = { names: text_of(packed).split(";").slice(0, count), mode };
            return undefined;
        },
        "glGetTransformFeedbackVarying": (shadow, c, [p, index, size, length, out_size, type, name]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return;
            const varyings = program.info && program.info.ok ? program.info.tf_varyings || [] : [];
            if(index >= varyings.length || size < 0) { fail(c, GL.INVALID_VALUE); return; }
            const v = varyings[index];
            const written = put_text(name, v.name);
            if(length && length.size) put(length, [written], "i", "i");
            if(out_size && out_size.size) put(out_size, [v.size], "i", "i");
            if(type && type.size) put(type, [v.type], "i", "i");
        },

        // ---- transform feedback objects
        "glGenTransformFeedbacks": gen3("tf", c => c.tfs),
        "glDeleteTransformFeedbacks": (shadow, c, [n, names]) =>
        {
            if(n < 0) return fail(c, GL.INVALID_VALUE);
            const list = i32s(names).slice(0, n);
            if(list.some(name => name && c.tfs.has(name) && c.tfs.get(name).active)) return fail(c, GL.INVALID_OPERATION);
            for(const name of list)
            {
                if(!name) continue;
                c.reserved3.tf.delete(name);
                if(!c.tfs.delete(name)) continue;
                if(c.tf === name) c.tf = 0;
            }
            return undefined;
        },
        "glIsTransformFeedback": (shadow, c, [name]) => { query(shadow); return name && c.tfs.has(name) && c.tfs.get(name).bound_once ? 1 : 0; },
        "glBindTransformFeedback": (shadow, c, [target, name]) =>
        {
            if(target !== GL.TRANSFORM_FEEDBACK) return fail(c, GL.INVALID_ENUM);
            const tf = current_tf(c);
            if(tf.active && !tf.paused) return fail(c, GL.INVALID_OPERATION);
            if(name && !c.tfs.has(name))
            {
                if(!generated(shadow, c.reserved3.tf, name)) return fail(c, GL.INVALID_OPERATION);
                c.tfs.set(name, new_tf());
            }
            c.tf = name;
            c.tfs.get(name).bound_once = true;
            return undefined;
        },
        "glBeginTransformFeedback": (shadow, c, [mode]) =>
        {
            if(mode !== GL.POINTS && mode !== GL.LINES && mode !== GL.TRIANGLES) return fail(c, GL.INVALID_ENUM);
            const tf = current_tf(c);
            if(tf.active) return fail(c, GL.INVALID_OPERATION);
            const program = c.group.objects.get(c.program);
            const varyings = program && program.info && program.info.ok ? program.info.tf_varyings || [] : [];
            if(!varyings.length) return fail(c, GL.INVALID_OPERATION);
            const buffers = program.info.tf_mode === GL.INTERLEAVED_ATTRIBS ? 1 : varyings.length;
            for(let i = 0; i < buffers; i++) if(!tf.bindings[i].buffer) return fail(c, GL.INVALID_OPERATION);
            Object.assign(tf, { active: true, paused: false, mode, program: c.program, vertices: [0, 0, 0, 0] });
            return undefined;
        },
        "glEndTransformFeedback": (shadow, c) =>
        {
            const tf = current_tf(c);
            if(!tf.active) return fail(c, GL.INVALID_OPERATION);
            tf.active = tf.paused = false;
            return undefined;
        },
        "glPauseTransformFeedback": (shadow, c) =>
        {
            const tf = current_tf(c);
            if(!tf.active || tf.paused) return fail(c, GL.INVALID_OPERATION);
            tf.paused = true;
            return undefined;
        },
        "glResumeTransformFeedback": (shadow, c) =>
        {
            const tf = current_tf(c);
            if(!tf.active || !tf.paused || tf.program !== c.program) return fail(c, GL.INVALID_OPERATION);
            tf.paused = false;
            return undefined;
        },
        "glUseProgram": (shadow, c, args) =>
        {
            const tf = current_tf(c);
            if(tf.active && !tf.paused) return fail(c, GL.INVALID_OPERATION);
            return base["glUseProgram"](shadow, c, args);
        },
        "glLinkProgram": (shadow, c, args) =>
        {
            const tf = current_tf(c);
            if(tf.active && tf.program === args[0]) return fail(c, GL.INVALID_OPERATION);
            return base["glLinkProgram"](shadow, c, args);
        },

        // ---- queries
        "glGenQueries": gen3("query", c => c.queries),
        "glDeleteQueries": (shadow, c, [n, names]) =>
        {
            if(n < 0) return fail(c, GL.INVALID_VALUE);
            for(const name of i32s(names).slice(0, n))
            {
                if(!name) continue;
                c.reserved3.query.delete(name);
                for(const [target, active] of c.active_queries) if(active === name) c.active_queries.delete(target);
                c.queries.delete(name);
            }
            return undefined;
        },
        "glIsQuery": (shadow, c, [name]) => { query(shadow); return c.queries.has(name) ? 1 : 0; },
        "glBeginQuery": (shadow, c, [target, name]) =>
        {
            if(!QUERY_TARGETS.has(target)) return fail(c, GL.INVALID_ENUM);
            const occlusion = target !== GL.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN;
            if(c.active_queries.has(target) || occlusion && c.active_queries.has(target === GL.ANY_SAMPLES_PASSED ?
                GL.ANY_SAMPLES_PASSED_CONSERVATIVE : GL.ANY_SAMPLES_PASSED))
            {
                return fail(c, GL.INVALID_OPERATION);
            }
            if(!name || !c.queries.has(name) && !generated(shadow, c.reserved3.query, name)) return fail(c, GL.INVALID_OPERATION);
            const q = c.queries.get(name);
            if(q && q.target !== target) return fail(c, GL.INVALID_OPERATION);
            if([...c.active_queries.values()].includes(name)) return fail(c, GL.INVALID_OPERATION);
            c.queries.set(name, { target, result: 0, drawn: false, available: false, ended: false });
            c.active_queries.set(target, name);
            return undefined;
        },
        "glEndQuery": (shadow, c, [target]) =>
        {
            if(!QUERY_TARGETS.has(target)) return fail(c, GL.INVALID_ENUM);
            const name = c.active_queries.get(target);
            if(!name) return fail(c, GL.INVALID_OPERATION);
            c.active_queries.delete(target);
            const q = c.queries.get(name);
            q.ended = true;
            // (occlusion: nothing drawn is 0, else the page answers, query_read; the CPU side counts feedback's primitives)
            if(target !== GL.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN) q.result = q.drawn ? 1 : 0;
            q.available = true;
            return undefined;
        },
        "glGetQueryiv": (shadow, c, [target, pname, params]) =>
        {
            query(shadow);
            if(!QUERY_TARGETS.has(target) || pname !== 0x8865) { fail(c, GL.INVALID_ENUM); return; }
            put(params, [c.active_queries.get(target) || 0], "i", "i");
        },
        "glGetQueryObjectuiv": (shadow, c, [name, pname, params]) =>
        {
            query(shadow);
            if(pname !== 0x8866 && pname !== 0x8867) { fail(c, GL.INVALID_ENUM); return; }
            const q = c.queries.get(name);
            if(!q || !q.ended || [...c.active_queries.values()].includes(name)) { fail(c, GL.INVALID_OPERATION); return; }
            put(params, [pname === 0x8867 ? (q.available ? 1 : 0) : q.result], "i", "i");
            if(pname === 0x8866 && q.target !== GL.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN && q.drawn && !q.answered) shadow.query_read = { name, query: q };
        },

        // ---- sync objects (GLES 3.0's own, not EGL's: done in order, as renderControl's)
        "glFenceSyncAEMU": (shadow, c, [condition, flags]) =>
        {
            query(shadow);
            if(condition !== 0x9117) { fail(c, GL.INVALID_ENUM); return 0; }
            if(flags) { fail(c, GL.INVALID_VALUE); return 0; }
            const handle = c.group.next_sync++;
            c.group.syncs.set(handle, { condition, flags });
            return handle;
        },
        "glClientWaitSyncAEMU": (shadow, c, [sync, flags]) =>
        {
            query(shadow);
            if(!c.group.syncs.has(sync)) { fail(c, GL.INVALID_VALUE); return 0x911D; }
            if(flags & ~1) { fail(c, GL.INVALID_VALUE); return 0x911D; }
            return 0x911A; // GL_ALREADY_SIGNALED
        },
        "glWaitSyncAEMU": (shadow, c, [sync, flags, timeout]) =>
        {
            if(!c.group.syncs.has(sync)) return fail(c, GL.INVALID_VALUE);
            // (GL_TIMEOUT_IGNORED, all ones: as u64 read into a number, 2 ** 64)
            if(flags || timeout < 2 ** 63) return fail(c, GL.INVALID_VALUE);
            return undefined;
        },
        "glDeleteSyncAEMU": (shadow, c, [sync]) =>
        {
            if(sync && !c.group.syncs.delete(sync)) return fail(c, GL.INVALID_VALUE);
            return undefined;
        },
        "glIsSyncAEMU": (shadow, c, [sync]) => { query(shadow); return c.group.syncs.has(sync) ? 1 : 0; },
        "glGetSyncivAEMU": (shadow, c, [sync, pname, size, length, values]) =>
        {
            query(shadow);
            const s = c.group.syncs.get(sync);
            if(!s) { fail(c, GL.INVALID_VALUE); return; }
            const value = { 0x9112: 0x9116, 0x9113: s.condition, 0x9114: 0x9119, 0x9115: s.flags }[pname];
            if(value === undefined) { fail(c, GL.INVALID_ENUM); return; }
            if(size < 0) { fail(c, GL.INVALID_VALUE); return; }
            if(size > 0) put(values, [value], "i", "i");
            if(length && length.size) put(length, [size > 0 ? 1 : 0], "i", "i");
        },
        "glGetStringi": (shadow, c, [name, index]) =>
        {
            query(shadow);
            if(name !== 0x1F03) { fail(c, GL.INVALID_ENUM); return 0; }
            if(index >= h.extensions(c).length) fail(c, GL.INVALID_VALUE);
            return 0;
        },
        "glGetCompressedTextureFormats": (shadow, c, [count, formats]) =>
        {
            query(shadow);
            put(formats, c.version >= 32 ? COMPRESSED_TEXTURE_FORMATS_32 : COMPRESSED_TEXTURE_FORMATS_3, "i", "i");
        },
    };

    // ---- the helpers above use

    function bind_buffer_indexed(shadow, c, target, index, name, offset, size, range)
    {
        if(target !== GL.UNIFORM_BUFFER && target !== GL.TRANSFORM_FEEDBACK_BUFFER) return fail(c, GL.INVALID_ENUM);
        const tf = current_tf(c);
        const max = target === GL.UNIFORM_BUFFER ? LIMITS3.MAX_UNIFORM_BUFFER_BINDINGS : LIMITS3.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS;
        if(index >= max) return fail(c, GL.INVALID_VALUE);
        if(range && name && (size <= 0 || offset < 0)) return fail(c, GL.INVALID_VALUE);
        if(target === GL.UNIFORM_BUFFER && range && name && offset % LIMITS3.UNIFORM_BUFFER_OFFSET_ALIGNMENT) return fail(c, GL.INVALID_VALUE);
        if(target === GL.TRANSFORM_FEEDBACK_BUFFER && range && name && (offset % 4 || size % 4)) return fail(c, GL.INVALID_VALUE);
        if(target === GL.TRANSFORM_FEEDBACK_BUFFER && tf.active) return fail(c, GL.INVALID_OPERATION);
        if(name && !c.group.buffers.has(name)) c.group.buffers.set(name, new_buffer());
        const list = target === GL.UNIFORM_BUFFER ? c.uniform_bindings : tf.bindings;
        list[index] = { buffer: name, offset: range ? offset : 0, size: range ? size : 0 };
        if(target === GL.UNIFORM_BUFFER) c.buffers.uniform = name;
        else c.buffers.transform_feedback = name;
        return undefined;
    }

    /** @param {boolean|string} wide 64-bit integers, or "b" booleans */
    function indexed(c, target, index, data, wide)
    {
        let list, field;
        switch(target)
        {
            case 0x8A28: list = c.uniform_bindings; field = "buffer"; break;
            case 0x8A29: list = c.uniform_bindings; field = "offset"; break;
            case 0x8A2A: list = c.uniform_bindings; field = "size"; break;
            case 0x8C8F: list = current_tf(c).bindings; field = "buffer"; break;
            case 0x8C84: list = current_tf(c).bindings; field = "offset"; break;
            case 0x8C85: list = current_tf(c).bindings; field = "size"; break;
            default: fail(c, GL.INVALID_ENUM); return;
        }
        if(index >= list.length) { fail(c, GL.INVALID_VALUE); return; }
        const value = list[index][field];
        if(wide === "b") put(data, [value], "b", "b");
        else if(wide) put64(data, [value]);
        else put(data, [value], "i", "i");
    }

    function attrib3(c, index, size, type, normalized, stride, buffer, offset, integer)
    {
        if(index >= MAX_ATTRIBS || size < 1 || size > 4 || stride < 0 || stride > 255) return fail(c, GL.INVALID_VALUE);
        const types = integer ? [0x1400, 0x1401, 0x1402, 0x1403, 0x1404, 0x1405] :
            [0x1400, 0x1401, 0x1402, 0x1403, 0x1404, 0x1405, 0x1406, 0x140B, 0x8D61, 0x140C, 0x8368, 0x8D9F];
        if(!types.includes(type)) return fail(c, GL.INVALID_ENUM);
        if((type === 0x8368 || type === 0x8D9F) && size !== 4) return fail(c, GL.INVALID_OPERATION);
        Object.assign(c.attribs[index], { size, type, normalized: !!normalized, stride, buffer, offset, integer });
        return undefined;
    }

    function attrib_current(c, index, values, kind)
    {
        if(index >= MAX_ATTRIBS) return fail(c, GL.INVALID_VALUE);
        c.attribs[index].current = values.slice(0, 4);
        c.attribs[index].current_type = kind;
        // (current values belong to the context, not to vertex arrays: GLES 3.0 table 6.6)
        c.current_values = c.current_values || [];
        c.current_values[index] = { values: values.slice(0, 4), kind };
        return undefined;
    }

    function get_attrib3(shadow, c, index, pname, params, as)
    {
        query(shadow);
        if(index >= MAX_ATTRIBS) { fail(c, GL.INVALID_VALUE); return; }
        const a = c.attribs[index];
        if(pname === 0x8626)
        {
            const current = c.current_values && c.current_values[index] || { values: a.current, kind: a.current_type || "f" };
            if(as === "f") put(params, current.values, "f", "f");
            else if(as === "ui") put(params, current.values.map(v => v >>> 0), "i", "i");
            else put(params, current.values.map(v => current.kind === "f" ? Math.round(v) : v | 0), "i", "i");
            return;
        }
        const values = { 0x8622: a.enabled ? 1 : 0, 0x8623: a.size, 0x8624: a.stride, 0x8625: a.type, 0x886A: a.normalized ? 1 : 0,
            0x889F: a.buffer, 0x88FD: a.integer ? 1 : 0, 0x88FE: a.divisor };
        if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
        put(params, [values[pname]], as === "f" ? "f" : "i", "i");
    }

    function elements3(shadow, c, mode, count, type, instances, from_buffer)
    {
        if(!mode_ok(c, mode) || !INDEX_TYPES.has(type)) return fail(c, GL.INVALID_ENUM);
        if(count < 0 || instances < 0) return fail(c, GL.INVALID_VALUE);
        if(from_buffer && !c.element_array_buffer) return fail(c, GL.INVALID_OPERATION);
        const buffer = c.group.buffers.get(c.element_array_buffer);
        if(buffer && buffer.mapped) return fail(c, GL.INVALID_OPERATION);
        return draw_checks(shadow, c, mode, count, instances, true, type);
    }

    function draw_images(c)
    {
        if(!c.framebuffer) return [{ info: { kind: "unorm", value: 0x8058 }, samples: 0 }];
        const fbo = c.framebuffers.get(c.framebuffer);
        return fbo.draw_buffers.filter(b => b !== GL.NONE).map(b => fbo.attachments.get(b)).filter(Boolean)
            .map(a => attachment_image(c, a)).filter(Boolean);
    }

    function depth_stencil_image(c, fb, point)
    {
        if(!fb) return null;
        const a = c.framebuffers.get(fb).attachments.get(point);
        return a ? attachment_image(c, a) : null;
    }

    function clear_buffer(c, buffer, drawbuffer, kind)
    {
        const ok = { i: [GL.COLOR, GL.STENCIL], ui: [GL.COLOR], f: [GL.COLOR, GL.DEPTH], fi: [GL.DEPTH_STENCIL] }[kind];
        if(!ok.includes(buffer)) return fail(c, GL.INVALID_ENUM);
        if(buffer === GL.COLOR ? drawbuffer < 0 || drawbuffer >= LIMITS3.MAX_DRAW_BUFFERS : drawbuffer !== 0) return fail(c, GL.INVALID_VALUE);
        if(!complete(c, false)) return REFUSED;
        return undefined;
    }

    function read_pixels3(shadow, c, width, height, format, type, pack)
    {
        if(width < 0 || height < 0) return fail(c, GL.INVALID_VALUE);
        if(pixel_bytes(format, type) === 0) return fail(c, GL.INVALID_ENUM);
        if(!pack && c.buffers.pixel_pack) return fail(c, GL.INVALID_OPERATION);
        if(!complete(c, true)) return REFUSED;
        const source = read_image(c);
        if(!source) return fail(c, GL.INVALID_OPERATION);
        if(source.samples) return fail(c, GL.INVALID_OPERATION);
        // (GLES 3.0 4.3.2: RGBA with UNSIGNED_BYTE, FLOAT or INT/UNSIGNED_INT by the buffer's kind; or the implementation's pair)
        const kind = source.info.kind;
        const [rf, rt] = implementation_read(source.info);
        const normal = kind === "int" ? format === 0x8D99 && type === 0x1404 : kind === "uint" ? format === 0x8D99 && type === 0x1405 :
            kind === "float" ? format === 0x1908 && type === 0x1406 :
            format === 0x1908 && (type === 0x1401 || source.info.value === 0x8059 && type === 0x8368);
        if(!normal && !(format === rf && type === rt)) return fail(c, GL.INVALID_OPERATION);
        return undefined;
    }

    /** GL_IMPLEMENTATION_COLOR_READ_FORMAT and _TYPE of a read buffer's format: its own format and first type */
    function implementation_read(info)
    {
        if(!info || !info.format || !info.types) return [0x1908, 0x1401];
        return [info.format, info.types[info.types.length > 1 && info.types[0] === 0x1401 ? 1 : 0]];
    }

    function copy_compatible(source, dest)
    {
        // (GLES 3.0 table 3.15: the destination's channels a subset of the source's, the same kind of component)
        if(!source || !dest) return false;
        const integer = k => k === "int" || k === "uint";
        if(integer(source.kind) !== integer(dest.kind) || integer(source.kind) && source.kind !== dest.kind) return false;
        if(source.kind === "float" !== (dest.kind === "float") && dest.sized) return false;
        const channels = info => info.bits.slice(0, 4).map(b => b > 0);
        const s = channels(source), d = channels(dest);
        if(dest.value === 0x1909 || dest.value === 0x190A) d[0] = true;
        return d.every((need, i) => !need || s[i]);
    }

    function copy_sub(shadow, c, target, level, x, y, z, width, height, three)
    {
        let texture, face;
        if(three)
        {
            if(target !== GL.TEXTURE_3D && !layered(c, target)) return fail(c, GL.INVALID_ENUM);
            texture = bound_texture3(c, target);
            face = 0;
        }
        else
        {
            face = face_of(target);
            if(face < 0) return fail(c, GL.INVALID_ENUM);
            texture = bound_texture3(c, target === GL.TEXTURE_2D ? GL.TEXTURE_2D : GL.TEXTURE_CUBE_MAP);
        }
        if(!texture) return REFUSED;
        if(level < 0 || level > max_level_of(target) || x < 0 || y < 0 || z < 0 || width < 0 || height < 0) return fail(c, GL.INVALID_VALUE);
        const image = texture.images.get(image_key(face, level));
        if(!image) return fail(c, GL.INVALID_OPERATION);
        if(x + width > image.width || y + height > image.height || z >= (image.depth || 1)) return fail(c, GL.INVALID_VALUE);
        if(!complete(c, true)) return REFUSED;
        const source = read_image(c);
        if(image.compressed || !source || source.samples || !copy_compatible(source.info, format_info(image.internal || image.format))) {
            return fail(c, GL.INVALID_OPERATION);
        }
        return undefined;
    }

    /** @param {boolean=} vector glTexParameter*v's (TEXTURE_BORDER_COLOR is theirs alone) */
    function tex_parameter3(shadow, c, target, pname, params, float, vector = false)
    {
        const texture = bound_texture3(c, target);
        if(!texture) return REFUSED;
        const value = params[0];
        const integer = float ? Math.round(value) : value;
        const external = target === GL.TEXTURE_EXTERNAL_OES;
        // (GLES 3.1's multisampled textures (3.2's arrays): no sampler state, the base level 0)
        if(target === 0x9100 || target === 0x9102)
        {
            if(SAMPLER_STATES.has(pname)) return fail(c, GL.INVALID_ENUM);
            if(pname === 0x813C && integer !== 0) return fail(c, GL.INVALID_OPERATION);
        }
        switch(pname)
        {
            case 0x2801: // GL_TEXTURE_MIN_FILTER
                if(!MIN_FILTERS.has(integer) || external && integer !== GL.NEAREST && integer !== GL.LINEAR) return fail(c, GL.INVALID_ENUM);
                texture.min_filter = integer;
                return undefined;
            case 0x2800: // GL_TEXTURE_MAG_FILTER
                if(integer !== GL.NEAREST && integer !== GL.LINEAR) return fail(c, GL.INVALID_ENUM);
                texture.mag_filter = integer;
                return undefined;
            case 0x2802: case 0x2803: case 0x8072: // wrap s, t, r
                if(!wrap_ok(c, integer) || external && integer !== GL.CLAMP_TO_EDGE) return fail(c, GL.INVALID_ENUM);
                texture[{ 0x2802: "wrap_s", 0x2803: "wrap_t", 0x8072: "wrap_r" }[pname]] = integer;
                return undefined;
            case 0x813A: texture.min_lod = Math.fround(value); return undefined;
            case 0x813B: texture.max_lod = Math.fround(value); return undefined;
            case 0x813C: // GL_TEXTURE_BASE_LEVEL
                if(integer < 0 || external && integer !== 0) return fail(c, external ? GL.INVALID_OPERATION : GL.INVALID_VALUE);
                texture.base_level = integer;
                return undefined;
            case 0x813D: // GL_TEXTURE_MAX_LEVEL
                if(integer < 0) return fail(c, GL.INVALID_VALUE);
                texture.max_level = integer;
                return undefined;
            case 0x884C: // GL_TEXTURE_COMPARE_MODE
                if(integer !== 0 && integer !== 0x884E) return fail(c, GL.INVALID_ENUM);
                texture.compare_mode = integer;
                return undefined;
            case 0x884D: // GL_TEXTURE_COMPARE_FUNC
                if(!COMPARE_FUNCS.has(integer)) return fail(c, GL.INVALID_ENUM);
                texture.compare_func = integer;
                return undefined;
            case 0x8E42: case 0x8E43: case 0x8E44: case 0x8E45: // swizzles
                if(!SWIZZLES.has(integer)) return fail(c, GL.INVALID_ENUM);
                texture.swizzle = texture.swizzle || [0x1903, 0x1904, 0x1905, 0x1906];
                texture.swizzle[pname - 0x8E42] = integer;
                return undefined;
            case TEXTURE_BORDER_COLOR:
                // (the scalar calls take none, an external texture none; the guest's encoder may send fewer than four: the rest 0)
                if(c.version < 32 || !vector || external) return fail(c, GL.INVALID_ENUM);
                texture.border_color = border_color(params, float);
                return undefined;
            case DEPTH_STENCIL_TEXTURE_MODE:
                // (GLES 3.1's: a depth and stencil texture sampled as its depth or its stencil; dEQP's state reset sets it)
                if(c.version < 31) return fail(c, GL.INVALID_ENUM);
                if(integer !== 0x1902 && integer !== 0x1901) return fail(c, GL.INVALID_ENUM);
                texture.depth_stencil_mode = integer;
                return undefined;
        }
        return fail(c, GL.INVALID_ENUM);
    }

    function get_tex_parameter3(shadow, c, target, pname, params, as)
    {
        query(shadow);
        const texture = bound_texture3(c, target);
        if(!texture) return;
        const swizzle = texture.swizzle || [0x1903, 0x1904, 0x1905, 0x1906];
        const values = { 0x2801: texture.min_filter, 0x2800: texture.mag_filter, 0x2802: texture.wrap_s, 0x2803: texture.wrap_t,
            0x8072: texture.wrap_r || GL.REPEAT, 0x813A: texture.min_lod === undefined ? -1000 : texture.min_lod,
            0x813B: texture.max_lod === undefined ? 1000 : texture.max_lod, 0x813C: texture.base_level || 0,
            0x813D: texture.max_level === undefined ? 1000 : texture.max_level, 0x884C: texture.compare_mode || 0,
            0x884D: texture.compare_func || 0x0203, 0x8E42: swizzle[0], 0x8E43: swizzle[1], 0x8E44: swizzle[2], 0x8E45: swizzle[3],
            0x912F: texture.immutable ? 1 : 0, 0x82DF: texture.immutable_levels || 0 };
        if(target === GL.TEXTURE_EXTERNAL_OES) values[0x8D68] = 1; // GL_REQUIRED_TEXTURE_IMAGE_UNITS_OES
        if(c.version >= 31) values[DEPTH_STENCIL_TEXTURE_MODE] = texture.depth_stencil_mode || 0x1902;
        if(pname === TEXTURE_BORDER_COLOR && c.version >= 32)
        {
            const color = texture.border_color || [0, 0, 0, 0];
            return void put(params, as === "f" ? color : color.map(border_int), as, as === "f" ? "f" : "i");
        }
        if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
        // (the levels of detail are floats: an integer query rounds them, as the sampler's do)
        put(params, [as === "i" && (pname === 0x813A || pname === 0x813B) ? round(values[pname]) : values[pname]], as, as === "f" ? "f" : "i");
    }

    function sampler_parameter(shadow, c, s, pname, params, float, vector = false)
    {
        if(s && shadow.trusted && !c.group.samplers.has(s)) c.group.samplers.set(s, new_sampler());
        const sampler = c.group.samplers.get(s);
        if(!sampler) return fail(c, GL.INVALID_OPERATION);
        const value = params[0];
        const integer = float ? Math.round(value) : value;
        switch(pname)
        {
            case 0x2801: if(!MIN_FILTERS.has(integer)) return fail(c, GL.INVALID_ENUM); sampler.min_filter = integer; return undefined;
            case 0x2800: if(integer !== GL.NEAREST && integer !== GL.LINEAR) return fail(c, GL.INVALID_ENUM); sampler.mag_filter = integer; return undefined;
            case 0x2802: case 0x2803: case 0x8072:
                if(!wrap_ok(c, integer)) return fail(c, GL.INVALID_ENUM);
                sampler[{ 0x2802: "wrap_s", 0x2803: "wrap_t", 0x8072: "wrap_r" }[pname]] = integer;
                return undefined;
            case TEXTURE_BORDER_COLOR:
                if(c.version < 32 || !vector) return fail(c, GL.INVALID_ENUM);
                sampler.border_color = border_color(params, float);
                return undefined;
            case 0x813A: sampler.min_lod = Math.fround(value); return undefined;
            case 0x813B: sampler.max_lod = Math.fround(value); return undefined;
            case 0x884C: if(integer !== 0 && integer !== 0x884E) return fail(c, GL.INVALID_ENUM); sampler.compare_mode = integer; return undefined;
            case 0x884D: if(!COMPARE_FUNCS.has(integer)) return fail(c, GL.INVALID_ENUM); sampler.compare_func = integer; return undefined;
        }
        return fail(c, GL.INVALID_ENUM);
    }

    function get_sampler_parameter(shadow, c, s, pname, params, as)
    {
        query(shadow);
        const sampler = c.group.samplers.get(s);
        if(!sampler) { fail(c, GL.INVALID_OPERATION); return; }
        const values = { 0x2801: sampler.min_filter, 0x2800: sampler.mag_filter, 0x2802: sampler.wrap_s, 0x2803: sampler.wrap_t,
            0x8072: sampler.wrap_r, 0x813A: sampler.min_lod, 0x813B: sampler.max_lod, 0x884C: sampler.compare_mode, 0x884D: sampler.compare_func };
        if(pname === TEXTURE_BORDER_COLOR && c.version >= 32)
        {
            const color = sampler.border_color || [0, 0, 0, 0];
            return void put(params, as === "f" ? color : color.map(border_int), as, as === "f" ? "f" : "i");
        }
        if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
        put(params, [as === "i" && (pname === 0x813A || pname === 0x813B) ? round(values[pname]) : values[pname]], as, as === "f" ? "f" : "i");
    }

    function renderbuffer_storage(c, target, samples, format, width, height)
    {
        if(target !== GL.RENDERBUFFER) return fail(c, GL.INVALID_ENUM);
        const info = format_info(format);
        const stencil = format === 0x8D48;
        const legacy = h.renderbuffer_info(format);
        if(!stencil && !(info && renderable(info, c.color_buffer_float)) && !legacy) return fail(c, GL.INVALID_ENUM);
        if(samples < 0 || width < 0 || height < 0 || width > LIMITS3.MAX_TEXTURE_SIZE || height > LIMITS3.MAX_TEXTURE_SIZE) return fail(c, GL.INVALID_VALUE);
        if(samples > LIMITS3.MAX_SAMPLES || samples > 0 && info && (info.kind === "int" || info.kind === "uint")) return fail(c, GL.INVALID_OPERATION);
        const rb = c.group.renderbuffers.get(c.renderbuffer);
        if(!rb) return fail(c, GL.INVALID_OPERATION);
        Object.assign(rb, { width, height, format, image: 0, samples: samples ? LIMITS3.MAX_SAMPLES : 0 });
        return undefined;
    }

    function attachment_parameter(c, fb, attachment, pname)
    {
        // (the default framebuffer: its BACK, DEPTH and STENCIL)
        if(!fb)
        {
            if(attachment !== GL.BACK && attachment !== 0x1801 && attachment !== 0x1802) { fail(c, GL.INVALID_ENUM); return null; }
            const bits = h.framebuffer_bits(c);
            const has = attachment === GL.BACK ? true : attachment === 0x1801 ? bits[4] > 0 : bits[5] > 0;
            if(pname === 0x8CD0) return has ? GL.FRAMEBUFFER_DEFAULT : GL.NONE;
            if(!has) { fail(c, GL.INVALID_ENUM); return null; }
            const sizes = { 0x8212: bits[0], 0x8213: bits[1], 0x8214: bits[2], 0x8215: bits[3], 0x8216: bits[4], 0x8217: bits[5] };
            if(pname in sizes) return attachment === GL.BACK ? (pname <= 0x8215 ? sizes[pname] : 0) :
                attachment === 0x1801 ? (pname === 0x8216 ? bits[4] : 0) : pname === 0x8217 ? bits[5] : 0;
            if(pname === 0x8211) return attachment === GL.BACK ? F.UNSIGNED_NORMALIZED : attachment === 0x1801 ? F.UNSIGNED_NORMALIZED : F.UNSIGNED_INT;
            if(pname === 0x8210) return F.LINEAR;
            fail(c, GL.INVALID_ENUM);
            return null;
        }
        if(!attachment_ok(attachment)) { fail(c, GL.INVALID_ENUM); return null; }
        const fbo = c.framebuffers.get(fb);
        const point = attachment === GL.DEPTH_STENCIL_ATTACHMENT ? GL.DEPTH_ATTACHMENT : attachment;
        const a = fbo.attachments.get(point);
        if(attachment === GL.DEPTH_STENCIL_ATTACHMENT)
        {
            const s = fbo.attachments.get(GL.STENCIL_ATTACHMENT);
            if(a && s && (a.type !== s.type || a.name !== s.name)) { fail(c, GL.INVALID_OPERATION); return null; }
        }
        if(pname === 0x8CD0) return a ? a.type : GL.NONE;
        if(!a)
        {
            if(pname === 0x8CD1) return 0;
            fail(c, GL.INVALID_OPERATION);
            return null;
        }
        if(pname === 0x8CD1) return a.name;
        if(a.type === GL.TEXTURE)
        {
            if(pname === 0x8CD2) return a.level;
            if(pname === 0x8CD3)
            {
                // (a cube map's face, POSITIVE_X's too; NONE for any other texture)
                const texture = c.group.textures.get(a.name);
                return texture && texture.target === GL.TEXTURE_CUBE_MAP ? GL.TEXTURE_CUBE_MAP_POSITIVE_X + a.face : 0;
            }
            if(pname === 0x8CD4) return a.layer || 0;
        }
        const image = attachment_image(c, a);
        const info = image && image.info;
        const bits = info ? info.bits : [0, 0, 0, 0, 0, 0];
        if(pname >= 0x8212 && pname <= 0x8217) return bits[pname - 0x8212];
        if(pname === 0x8211)
        {
            if(attachment === GL.DEPTH_STENCIL_ATTACHMENT) { fail(c, GL.INVALID_OPERATION); return null; }
            return info ? point === GL.STENCIL_ATTACHMENT ? F.UNSIGNED_INT : component_type(info) : GL.NONE;
        }
        if(pname === 0x8210) return info && info.srgb ? F.SRGB : F.LINEAR;
        fail(c, GL.INVALID_ENUM);
        return null;
    }

    function invalidate(c, target, n, attachments, width, height)
    {
        const fb = framebuffer_of(c, target);
        if(fb < 0) return fail(c, GL.INVALID_ENUM);
        if(n < 0 || width < 0 || height < 0) return fail(c, GL.INVALID_VALUE);
        for(const a of i32s(attachments).slice(0, n))
        {
            if(fb ? !attachment_ok(a) && !(a >= GL.COLOR_ATTACHMENT0 && a < GL.COLOR_ATTACHMENT0 + 32) : ![0x1800, 0x1801, 0x1802].includes(a))
            {
                return fail(c, GL.INVALID_ENUM);
            }
            if(fb && a >= GL.COLOR_ATTACHMENT0 + LIMITS3.MAX_COLOR_ATTACHMENTS && a < GL.COLOR_ATTACHMENT0 + 32) return fail(c, GL.INVALID_OPERATION);
        }
        return undefined;
    }

    // (what gles31_state.js's handlers build on: not a command's name)
    H.helpers = { target_ok, buffer_binding, set_buffer_binding, bound_buffer3, generated, new_buffer, current_tf, program_of, status_of, complete,
        uniform3, bound_texture3, attachment_image, draw_checks, tf_bound_active, put64, get_attrib3, attrib3, bytes_of };
    return H;
}

/**
 * A pname of GLES 3.0's glGet in a GLES 3.x context, or null for one
 * GLES 2.0's answers (gles_shadow.js's state_value)
 * @return {?Array<number>}
 */
export function state_value3(shadow, c, pname)
{
    const L = LIMITS3;
    const tf = c.tfs.get(c.tf);
    const fbo = c.framebuffer && c.framebuffers.get(c.framebuffer);
    switch(pname)
    {
        case 0x80A8: case 0x80A9: // GL_SAMPLE_BUFFERS, GL_SAMPLES: the bound framebuffer's (the default one's: GL_STATE's)
        {
            if(!fbo) return null;
            let samples = 0;
            for(const a of fbo.attachments.values())
            {
                const rb = a.type === 0x8D41 ? c.group.renderbuffers.get(a.name) : null; // (GL_RENDERBUFFER)
                const texture = a.type === 0x8D41 ? null : c.group.textures.get(a.name);
                const image = texture && texture.images.get(a.face * 32 + a.level);
                samples = Math.max(samples, rb ? rb.samples || 0 : image ? image.samples || 0 : 0);
            }
            return [pname === 0x80A9 ? samples : samples > 0 ? 1 : 0];
        }
        // (GLES 3.1's minimums, which GLES 3.0's contexts have too: GL_STATE's are GLES 2.0's)
        case 0x8B4D: return [MAX_UNITS]; // GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS
        case 0x8DFD: return [L.MAX_FRAGMENT_UNIFORM_COMPONENTS / 4]; // GL_MAX_FRAGMENT_UNIFORM_VECTORS
        case 0x821B: return [3]; // GL_MAJOR_VERSION
        case 0x821C: return [c.version % 10]; // GL_MINOR_VERSION
        case 0x821D: return [shadow.extensions3(c).length]; // GL_NUM_EXTENSIONS
        case 0x87FE: return [0]; // GL_NUM_PROGRAM_BINARY_FORMATS
        case 0x87FF: return []; // GL_PROGRAM_BINARY_FORMATS
        case 0x8073: return [L.MAX_3D_TEXTURE_SIZE];
        case 0x88FF: return [L.MAX_ARRAY_TEXTURE_LAYERS];
        case 0x8CDF: return [L.MAX_COLOR_ATTACHMENTS];
        case 0x8824: return [L.MAX_DRAW_BUFFERS];
        case 0x8D57: return [L.MAX_SAMPLES];
        case 0x8A2F: return [L.MAX_UNIFORM_BUFFER_BINDINGS];
        case 0x8A30: return [L.MAX_UNIFORM_BLOCK_SIZE];
        case 0x8A2B: return [L.MAX_VERTEX_UNIFORM_BLOCKS];
        case 0x8A2D: return [L.MAX_FRAGMENT_UNIFORM_BLOCKS];
        case 0x8A2E: return [L.MAX_COMBINED_UNIFORM_BLOCKS];
        case 0x8A31: return [L.MAX_VERTEX_UNIFORM_COMPONENTS + L.MAX_VERTEX_UNIFORM_BLOCKS * L.MAX_UNIFORM_BLOCK_SIZE / 4];
        case 0x8A33: return [L.MAX_FRAGMENT_UNIFORM_COMPONENTS + L.MAX_FRAGMENT_UNIFORM_BLOCKS * L.MAX_UNIFORM_BLOCK_SIZE / 4];
        case 0x8A34: return [L.UNIFORM_BUFFER_OFFSET_ALIGNMENT];
        case 0x8C8A: return [L.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS];
        case 0x8C8B: return [L.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS];
        case 0x8C80: return [L.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS];
        case 0x9122: return [L.MAX_VERTEX_OUTPUT_COMPONENTS];
        case 0x9125: return [L.MAX_FRAGMENT_INPUT_COMPONENTS];
        case 0x8B4A: return [L.MAX_VERTEX_UNIFORM_COMPONENTS];
        case 0x8B49: return [L.MAX_FRAGMENT_UNIFORM_COMPONENTS];
        case 0x8B4B: return [L.MAX_VARYING_COMPONENTS];
        case 0x8D6B: return [L.MAX_ELEMENT_INDEX];
        case 0x80E8: case 0x80E9: return [0x7FFFFFFF]; // GL_MAX_ELEMENTS_VERTICES, _INDICES
        case 0x8905: return [L.MAX_PROGRAM_TEXEL_OFFSET];
        case 0x8904: return [L.MIN_PROGRAM_TEXEL_OFFSET];
        case 0x84FD: return [L.MAX_TEXTURE_LOD_BIAS];
        case 0x9111: return [0]; // GL_MAX_SERVER_WAIT_TIMEOUT
        case 0x8F36: return [c.buffers.copy_read];
        case 0x8F37: return [c.buffers.copy_write];
        case 0x88ED: return [c.buffers.pixel_pack];
        case 0x88EF: return [c.buffers.pixel_unpack];
        case 0x8A28: return [c.buffers.uniform];
        case 0x8C8F: return [c.buffers.transform_feedback];
        case 0x8E25: return [c.tf];
        case 0x8E24: return [tf.active ? 1 : 0];
        case 0x8E23: return [tf.paused ? 1 : 0];
        case 0x85B5: return [c.vao];
        case 0x8919: return [c.samplers[c.active_texture]];
        case 0x806A: return [c.textures[c.active_texture][SLOT.TEXTURE_3D]];
        case 0x8C1D: return [c.textures[c.active_texture][SLOT.TEXTURE_2D_ARRAY]];
        case 0x8CAA: return [c.read_framebuffer];
        case 0x0C02: return [c.read_framebuffer ? c.framebuffers.get(c.read_framebuffer).read_buffer : c.default_read_buffer];
        case 0x0CF2: return [c.unpack.row_length];
        case 0x806E: return [c.unpack.image_height];
        case 0x0CF4: return [c.unpack.skip_pixels];
        case 0x0CF3: return [c.unpack.skip_rows];
        case 0x806D: return [c.unpack.skip_images];
        case 0x0D02: return [c.pack.row_length];
        case 0x0D04: return [c.pack.skip_pixels];
        case 0x0D03: return [c.pack.skip_rows];
        case 0x8C89: return [c.enabled.has(0x8C89) ? 1 : 0];
        case 0x8D69: return [c.enabled.has(0x8D69) ? 1 : 0];
        case 0x8B8B: return [c.hints.get(0x8B8B)];
        case 0x84E8: return [L.MAX_TEXTURE_SIZE]; // GL_MAX_RENDERBUFFER_SIZE
        // (GLES 3.2's: ASTC's too)
        case 0x86A2: return [(c.version >= 32 ? COMPRESSED_TEXTURE_FORMATS_32 : COMPRESSED_TEXTURE_FORMATS_3).length];
        case 0x86A3: return c.version >= 32 ? COMPRESSED_TEXTURE_FORMATS_32 : COMPRESSED_TEXTURE_FORMATS_3;
        case 0x8B9A: case 0x8B9B: // GL_IMPLEMENTATION_COLOR_READ_TYPE, _FORMAT
        {
            const info = shadow.read_info3(c);
            if(!info) { shadow.read_error3 = true; return null; }
            return [pname === 0x8B9B ? info[0] : info[1]];
        }
    }
    if(pname >= 0x8825 && pname < 0x8825 + L.MAX_DRAW_BUFFERS)
    {
        const i = pname - 0x8825;
        return [fbo ? fbo.draw_buffers[i] : i === 0 ? c.default_draw_buffer : 0];
    }
    return null;
}

/** GLES 3.0's int64 state (glGet's i form clamps these) */
export const INT64_STATE = new Set([0x8D6B, 0x9111, 0x8A30, 0x8A31, 0x8A33]);
