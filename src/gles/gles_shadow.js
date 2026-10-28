// The shadow state (docs/gles-proxy-plan.md "影子状态", E2): OpenGL ES 2.0's
// state machine, written from the GLES 2.0 specification, on the CPU side,
// so that the guest's queries are answered without waiting for the page:
// glGetError and the errors' rules, glGet* and glIsEnabled, the objects'
// names and parameters (textures, buffers, renderbuffers, framebuffers and
// their completeness, shaders and programs: compiled and linked by GLSL
// ES's front end, src/gles/glsl_es.js), uniforms' values and locations, the
// attributes' state.
//
// call() runs one command: its answer, and whether it goes to the page (a
// call the rules refuse sets the error and changes nothing; a query changes
// nothing either). The page's executor (E3) runs the same state machine on
// the commands it receives, so both sides agree on every name, location and
// binding.
//
// Objects: textures, buffers, renderbuffers, shaders and programs belong
// to the share group; framebuffers to the context (ES 3.0's rule, which no
// ES 2.0 guest relies against). GLES 1.1 contexts share the objects' part;
// their fixed-function state is answered from its initial values until E4.

import { GL, CAPS_1, CAPS_2, RENDERBUFFER_FORMATS, etc1_bytes, image_bytes, texel_bytes, texture_format_error, texture_kind } from "./gles_formats.js";
import { CONFIG_ATTRIBUTES, COMPRESSED_TEXTURE_FORMATS, EGL, GL_STATE, MAX_SIZE } from "./gles_caps.js";
import { compile_shader, link_program } from "./glsl_es.js";
import { STAGE_OF_GL_TYPE } from "./glslang.js";
import { es3_rules, glsl_version } from "./glsl_es_rewrite.js";
import { link_glslang_program } from "./glsl_program.js";
import { ADVANCED_EQUATIONS, INT64_STATE, extend_context3, extend_group3, gles3_handlers, new_framebuffer3, pad_context3, state_value3 } from "./gles3_state.js";
import { FLOAT_STATE32, extend_context31, gles31_handlers, glslang_limits, pad_context31, state_value31 } from "./gles31_state.js";
import { EXTENSIONS_3 } from "./gles_caps.js";
import { CLIENT_ARRAYS, gles1_handlers, gles1_state_value, new_ff_state } from "./gles1_state.js";
import { format_info as SIZED_INFO } from "./gles_formats3.js";
import { relink } from "./gles_snapshot.js";

const MAX_ATTRIBS = 16;
const MAX_UNITS = 32;
const MAX_VIEWPORT = MAX_SIZE;
/** log2 of MAX_SIZE: the levels a texture can have */
const MAX_LEVEL = Math.log2(MAX_SIZE);

const BLEND_EQUATIONS = new Set([0x8006, 0x800A, 0x800B]);
/** GLES 3.0's MIN and MAX; GLES 3.2's advanced equations (KHR_blend_equation_advanced: glBlendEquation's, not the separate one's) */
const BLEND_MINMAX = new Set([0x8007, 0x8008]);
const equation_ok = (c, mode, advanced) => BLEND_EQUATIONS.has(mode) || c.version >= 30 && BLEND_MINMAX.has(mode) ||
    advanced && c.version >= 32 && ADVANCED_EQUATIONS.includes(mode);
const BLEND_FACTORS = new Set([0, 1, 0x0300, 0x0301, 0x0302, 0x0303, 0x0304, 0x0305, 0x0306, 0x0307, 0x8001, 0x8002, 0x8003, 0x8004]);
const SRC_ALPHA_SATURATE = 0x0308;
/** @return {boolean} whether a blend factor is a source's (SRC_ALPHA_SATURATE too) */
const source_factor = f => BLEND_FACTORS.has(f) || f === SRC_ALPHA_SATURATE;
/** @return {boolean} whether a blend factor is a destination's: SRC_ALPHA_SATURATE too from GLES 3.0 on (GLES 2.0: sources' alone) */
const destination_factor = (c, f) => BLEND_FACTORS.has(f) || f === SRC_ALPHA_SATURATE && c.version >= 30;
const COMPARE_FUNCS = new Set([0x0200, 0x0201, 0x0202, 0x0203, 0x0204, 0x0205, 0x0206, 0x0207]);
const STENCIL_OPS = new Set([0, 0x1E00, 0x1E01, 0x1E02, 0x1E03, 0x150A, 0x8507, 0x8508]);
const FACES = new Set([0x0404, 0x0405, 0x0408]);
const FRONT = 0x0404, BACK = 0x0405;
const HINT_MODES = new Set([0x1100, 0x1101, 0x1102]);
const MODES = new Set([GL.POINTS, GL.LINES, GL.LINE_LOOP, GL.LINE_STRIP, GL.TRIANGLES, GL.TRIANGLE_STRIP, GL.TRIANGLE_FAN]);
const INDEX_TYPES = new Set([GL.UNSIGNED_BYTE, GL.UNSIGNED_SHORT, GL.UNSIGNED_INT]);
const ATTRIB_TYPES = new Set([GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.FLOAT, GL.FIXED, GL.HALF_FLOAT_OES]);
const CLEAR_BITS = 0x4000 | 0x0100 | 0x0400;
const USAGES = new Set([GL.STREAM_DRAW, GL.STATIC_DRAW, GL.DYNAMIC_DRAW]);
const MIN_FILTERS = new Set([GL.NEAREST, GL.LINEAR, GL.NEAREST_MIPMAP_NEAREST, GL.LINEAR_MIPMAP_NEAREST, GL.NEAREST_MIPMAP_LINEAR, GL.LINEAR_MIPMAP_LINEAR]);
const WRAPS = new Set([GL.REPEAT, GL.CLAMP_TO_EDGE, GL.MIRRORED_REPEAT]);
const ATTACHMENTS = [GL.COLOR_ATTACHMENT0, GL.DEPTH_ATTACHMENT, GL.STENCIL_ATTACHMENT];

/** A call's outcome when the rules refuse it */
const REFUSED = Symbol("refused");

/** The share group's objects and names */
function ShareGroup()
{
    /** @type {!Map<number, !Object>} */
    this.textures = new Map();
    /** @type {!Map<number, {size: number, usage: number}>} */
    this.buffers = new Map();
    /** @type {!Map<number, {width: number, height: number, format: number, image: number}>} */
    this.renderbuffers = new Map();
    /** @type {!Map<number, !Object>} shaders and programs: one name space */
    this.objects = new Map();
    /** names given out by glGen*, by kind (they are objects only once bound) */
    this.reserved = { texture: new Set(), buffer: new Set(), renderbuffer: new Set() };
    this.next = { texture: 1, buffer: 1, renderbuffer: 1, object: 1 };
    this.contexts = 0;
}

/** @param {string} kind @param {!Map} objects @return {number} a name nothing has */
ShareGroup.prototype.fresh = function(kind, objects)
{
    const reserved = this.reserved[kind];
    let name = this.next[kind];
    while(objects.has(name) || reserved && reserved.has(name)) name++;
    this.next[kind] = name + 1;
    return name;
};

/** A texture: its target, images (by face and level), parameters */
function new_texture(target)
{
    const external = target === GL.TEXTURE_EXTERNAL_OES;
    return {
        target, images: new Map(), min_filter: external ? GL.LINEAR : GL.NEAREST_MIPMAP_LINEAR, mag_filter: GL.LINEAR,
        wrap_s: external ? GL.CLAMP_TO_EDGE : GL.REPEAT, wrap_t: external ? GL.CLAMP_TO_EDGE : GL.REPEAT,
        generate_mipmap: 0, crop: [0, 0, 0, 0],
    };
}

/** A vertex attribute's state */
function new_attrib()
{
    return { enabled: false, size: 4, type: GL.FLOAT, normalized: false, stride: 0, buffer: 0, offset: 0, current: [0, 0, 0, 1] };
}

/**
 * One context's state (GLES 2.0 tables 6.2 to 6.17; GLES 3.x's in gles3_state.js)
 * @param {number} api renderControl's: 1 (GLES 1.1), 2 (2.0), 30 to 32 (3.0 to 3.2)
 */
function Context(api, group)
{
    /** 1, 2, or 3 for any GLES 3.x; `version` says which (11, 20, 30, 31, 32) */
    this.api = api >= 30 ? 3 : api === 20 ? 2 : api;
    this.version = api >= 30 ? api : api === 1 ? 11 : 20;
    /**
     * GLSL ES 1.00 through glslang, the program drawn on the page as GLES
     * 3.x's (api 20: a GLES 2.0 context of a host that has glslang;
     * docs/gles3-plan.md L3); a GLES 2.0 context of api 2 has gl-webgpu's
     * front end
     */
    this.glslang = api === 20 || api >= 30;
    this.group = group;
    this.error = GL.NO_ERROR;
    /** @type {?{width: number, height: number, config: !Array<number>}} */
    this.surface = null;
    this.made_current = false;
    /** @type {!Map<number, {attachments: !Map<number, {type: number, name: number, level: number, face: number}>}>} */
    this.framebuffers = new Map();
    this.reserved_framebuffers = new Set();
    this.next_framebuffer = 1;
    this.enabled = new Set([0x0BD0, ...(api === 1 ? [0x809D] : [])]);
    this.viewport = [0, 0, 0, 0];
    this.scissor = [0, 0, 0, 0];
    this.depth_range = [0, 1];
    this.line_width = 1;
    this.cull_face = BACK;
    this.front_face = 0x0901;
    this.polygon_offset = [0, 0];
    this.sample_coverage = [1, 0];
    this.clear_color = [0, 0, 0, 0];
    this.clear_depth = 1;
    this.clear_stencil = 0;
    this.color_mask = [1, 1, 1, 1];
    this.depth_mask = 1;
    this.stencil_writemask = [-1, -1];
    this.blend_func = [1, 0, 1, 0]; // src rgb, dst rgb, src alpha, dst alpha
    this.blend_equation = [0x8006, 0x8006];
    this.blend_color = [0, 0, 0, 0];
    this.depth_func = 0x0201;
    this.stencil_func = [[0x0207, 0, -1], [0x0207, 0, -1]]; // front, back: func, ref, mask
    this.stencil_op = [[0x1E00, 0x1E00, 0x1E00], [0x1E00, 0x1E00, 0x1E00]];
    this.unpack_alignment = 4;
    this.pack_alignment = 4;
    this.hints = new Map([[0x8192, 0x1100], [0x8B8B, 0x1100], [0x0C50, 0x1100], [0x0C51, 0x1100], [0x0C52, 0x1100], [0x0C54, 0x1100]]);
    this.active_texture = 0;
    /** texture bindings by unit: [2D, cube map, external] */
    this.textures = Array.from({ length: MAX_UNITS }, () => [0, 0, 0]);
    this.array_buffer = 0;
    this.element_array_buffer = 0;
    this.framebuffer = 0;
    this.renderbuffer = 0;
    this.program = 0;
    this.attribs = Array.from({ length: MAX_ATTRIBS }, new_attrib);
    /** GLES 1.1's fixed-function state (src/gles/gles1_state.js) */
    this.ff = api === 1 ? new_ff_state() : null;
    if(this.api === 3)
    {
        extend_group3(group);
        extend_context3(this);
        if(this.version >= 31) extend_context31(this);
    }
}

/**
 * A linked program's uniform values before any glUniform*: a sampler's or
 * image's layout(binding), its unit (an array's elements the units after
 * it); the others 0
 * @param {?Object} info the link's
 * @return {!Map<number, !Array<number>>}
 */
function initial_values(info)
{
    const values = new Map();
    if(!info || !info.ok) return values;
    for(const u of info.uniforms)
    {
        if(u.opaque !== "sampler" && u.opaque !== "image" || !(u.binding > 0) || u.location < 0) continue;
        for(let e = 0; e < u.size; e++) values.set(u.location + e, [u.binding + e]);
    }
    return values;
}

/** @param {number} target @return {number} the binding slot of a texture target, -1 for none */
function texture_slot(target)
{
    return target === GL.TEXTURE_2D ? 0 : target === GL.TEXTURE_CUBE_MAP ? 1 : target === GL.TEXTURE_EXTERNAL_OES ? 2 : -1;
}

/** @param {number} target TexImage2D's: 2D or a cube map face @return {number} the face (0 for 2D), -1 for none */
function face_of(target)
{
    if(target === GL.TEXTURE_2D) return 0;
    const face = target - GL.TEXTURE_CUBE_MAP_POSITIVE_X;
    return face >= 0 && face < 6 ? face : -1;
}

/** @param {?Uint8Array} bytes @return {!Array<number>} as i32 */
function i32s(bytes)
{
    if(!bytes) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = [];
    for(let at = 0; at + 4 <= bytes.length; at += 4) values.push(view.getInt32(at, true));
    return values;
}

/** @param {?Uint8Array} bytes @return {!Array<number>} as f32 */
function f32s(bytes)
{
    if(!bytes) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = [];
    for(let at = 0; at + 4 <= bytes.length; at += 4) values.push(view.getFloat32(at, true));
    return values;
}

/** @param {?Uint8Array} bytes @return {string} a C string's text */
function text_of(bytes)
{
    if(!bytes) return "";
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/**
 * Values into an out buffer, as many as fit, by glGet's conversions
 * (GLES 2.0, 6.1.2)
 * @param {!Object} out an OutBuffer
 * @param {!Array<number>} values
 * @param {string} as "b" boolean, "i" integer, "f" float, "x" 16.16 fixed
 * @param {string} kind the state's own: "b", "i", "f", or "n" (a color or depth, normalized)
 */
function put(out, values, as, kind)
{
    const size = as === "b" ? 1 : 4;
    for(let i = 0; i < values.length && (i + 1) * size <= out.size; i++)
    {
        const v = values[i];
        switch(as)
        {
            case "b": out.data[i] = v ? 1 : 0; break;
            case "f": out.view.setFloat32(4 * i, kind === "b" ? (v ? 1 : 0) : v, true); break;
            case "x": out.view.setInt32(4 * i, Math.round(v * 65536), true); break;
            default:
                if(kind === "n") out.view.setInt32(4 * i, Math.round(Math.max(-1, Math.min(1, v)) * 0x7FFFFFFF), true);
                else out.view.setInt32(4 * i, kind === "f" ? Math.round(v) : v | 0, true);
        }
    }
}

/** @param {!Object} out an OutBuffer @param {string} text written with its NUL, truncated to fit @return {number} the length written */
function put_text(out, text)
{
    if(!out.size) return 0;
    const bytes = new TextEncoder().encode(text).subarray(0, out.size - 1);
    out.data.set(bytes);
    out.data[bytes.length] = 0;
    return bytes.length;
}

/** The state glGet answers that is a float, a color or depth (normalized) or a boolean; the rest are integers */
const STATE_KIND = new Map([
    [0x0B70, "n"], [0x0B21, "f"], [0x8038, "f"], [0x2A00, "f"], [0x80AA, "f"], [0x0C22, "n"], [0x0B73, "n"], [0x8005, "n"],
    [0x846D, "f"], [0x846E, "f"], [0x0B12, "f"], [0x0B22, "f"],
    [0x0C23, "b"], [0x0B72, "b"], [0x80AB, "b"], [0x8DFA, "b"],
    // (GLES 3.2's: gles31_state.js's FLOAT_STATE32)
    ...[...FLOAT_STATE32].map(pname => [pname, "f"]),
]);

/**
 * @constructor
 * @param {?Object} rc the RenderControl (src/gles/render_control.js): EGL
 *     images and color buffers, which textures and renderbuffers take as images
 */
export function GLESShadow(rc)
{
    this.rc = rc;
    /** @type {!Map<number, !Context>} by renderControl's context handle */
    this.contexts = new Map();
    /** @type {!Map<number, !ShareGroup>} by the group's first context */
    this.groups = new Map();
    /** whether the call being run goes to the page */
    this.keep = true;
    /** the name glCreateShader or glCreateProgram gives (the page's: the CPU side's answer), 0: a fresh one */
    this.given_name = 0;
    /** the commands both versions share (GLES 1.1's fixed forms call them) */
    this.handlers = HANDLERS;
    /** shaders compiled and programs linked; the logs of the first failures */
    this.stats = { compiled: 0, compile_failed: 0, linked: 0, link_failed: 0, failures: [], compile_ms: 0 };
    /** @type {?Object} glslang (src/gles/glslang.js), on the CPU side: GLSL ES 3.x's shaders, and 1.00's in
     *  contexts of glslang's (Context's `glslang`); the page has none and takes links from the batch */
    this.glslang = null;
    /** the last glLinkProgram's result through glslang (gles_host.js sends it to the page) */
    this.last_link = null;
}

/** What glslang's code pass needs of the limits */
const GLSLANG_LIMITS = { maxVaryingVectors: 15, maxDrawBuffers: 4 };

/** @param {number} type a shader's GL type @return {string} its stage, glsl_program.js's name */
function stage_of(type)
{
    return ["vertex", "tess_control", "tess_evaluation", "geometry", "fragment", "compute"][STAGE_OF_GL_TYPE.get(type)];
}

/**
 * A shader compiled: GLSL ES 3.x (and 1.00 where `es100`: a context of
 * glslang's) by glslang's check pass, else gl-webgpu's front end; on the
 * page, such a shader is not compiled at all: its program's link comes with
 * the batch
 * @param {boolean=} es100 GLSL ES 1.00 through glslang too
 * @param {boolean=} es2 a GLES 2.0 context's (GLES 2.0's limits)
 * @return {!Object} {ok, log, ...}
 */
GLESShadow.prototype.compile = function(source, type, es100, es2)
{
    const version = glsl_version(source);
    const stage = stage_of(type);
    if(version >= 300 || es100)
    {
        if(!this.glslang) return { ok: true, log: "", glslang: true, stage };
        this.glslang.set_limits(glslang_limits(version, es2));
        const checked = this.glslang.check_shader(STAGE_OF_GL_TYPE.get(type), source);
        // (what GLSL ES refuses and glslang's relaxed check does not: an #extension after the code, reserved words)
        const refused = checked.ok ? es3_rules(source) : null;
        if(refused) return { ok: false, log: refused, glslang: true, stage };
        return { ok: checked.ok, log: checked.log, glslang: true, stage };
    }
    return compile_shader(source, stage);
};

/**
 * A program's shaders linked
 * @param {!Object} program
 * @param {!Array<!Object>} shaders the attached ones
 * @param {boolean=} es2 a GLES 2.0 context's (GLES 2.0's limits)
 * @return {!Object} ProgramInfo
 */
GLESShadow.prototype.link = function(program, shaders, es2)
{
    this.last_link = null;
    if(!shaders.some(s => s.compiled && s.compiled.glslang))
    {
        const shader = type => shaders.find(s => s.type === type);
        const vs = shader(GL.VERTEX_SHADER), fs = shader(GL.FRAGMENT_SHADER);
        return link_program(vs && vs.compiled, fs && fs.compiled, new Map(program.bindings));
    }
    const failed = log => ({ ok: false, log, attributes: [], uniforms: [], locations: new Map(), by_location: [], reflection: null });
    if(program.provided)
    {
        const info = program.provided;
        program.provided = null;
        return info;
    }
    if(!this.glslang) return failed("ERROR: no link of this program came with the batch");
    if(shaders.some(s => !s.compiled || !s.compiled.glslang)) return failed("ERROR: the shaders' versions differ");
    if(shaders.some(s => !s.compiled.ok)) return failed("ERROR: a shader is not compiled");
    this.glslang.set_limits(glslang_limits(glsl_version(shaders[0].compiled_source), es2));
    const info = link_glslang_program(this.glslang, shaders.map(s => ({ stage: s.compiled.stage, source: s.compiled_source })),
        { bindings: new Map(program.bindings), separable: !!program.separable, limits: GLSLANG_LIMITS, tf: program.tf_request || null });
    if(info.ok) this.last_link = info;
    return info;
};

/** The classes of the shadow's objects, for a snapshot's packing (gles_snapshot.js) */
export const SHADOW_CLASSES = { "ShareGroup": ShareGroup.prototype, "Context": Context.prototype };

/** What a snapshot keeps (packed with SHADOW_CLASSES and shadow_skip, gles_snapshot.js) */
GLESShadow.prototype.get_state = function()
{
    return { contexts: this.contexts, groups: this.groups, stats: this.stats };
};

/** @param {{contexts: !Map, groups: !Map, stats: !Object}} state get_state's, unpacked */
GLESShadow.prototype.set_state = function(state)
{
    this.contexts = state.contexts;
    this.groups = state.groups;
    this.stats = state.stats;
    for(const c of this.contexts.values())
    {
        if(c && c.version >= 30 && c.textures && c.uniform_bindings) pad_context3(c);
        if(c && c.version >= 31 && c.storage_bindings && c.atomic_bindings) pad_context31(c);
    }
    relink(this.groups, this);
};

/**
 * @param {number} handle
 * @param {number} api 1 (GLES 1.1), 2, or 30 to 32 (GLES 3.0 to 3.2)
 * @param {number} share the group's first context, or 0
 */
GLESShadow.prototype.create_context = function(handle, api, share)
{
    const group_id = share || handle;
    let group = this.groups.get(group_id);
    if(!group) this.groups.set(group_id, group = new ShareGroup());
    group.contexts++;
    const context = new Context(api, group);
    context.group_id = group_id;
    // (the group's shaders compile as its contexts' do: a snapshot's relink)
    if(context.glslang) group.glslang = true;
    if(context.glslang && context.api === 2) group.es2 = true;
    this.contexts.set(handle, context);
};

/** @param {number} handle */
GLESShadow.prototype.destroy_context = function(handle)
{
    const context = this.contexts.get(handle);
    if(!context) return;
    this.contexts.delete(handle);
    if(--context.group.contexts === 0) this.groups.delete(context.group_id);
};

/**
 * A context made current on a surface (EGL: the first time, its viewport
 * and scissor box become the surface's)
 * @param {number} handle
 * @param {?{width: number, height: number, config: !Array<number>}} surface
 */
GLESShadow.prototype.make_current = function(handle, surface)
{
    const context = this.contexts.get(handle);
    if(!context) return;
    context.surface = surface;
    if(!context.made_current && surface)
    {
        context.viewport = [0, 0, surface.width, surface.height];
        context.scissor = [0, 0, surface.width, surface.height];
    }
    context.made_current = context.made_current || !!surface;
};

/** @param {number} handle @return {?Context} */
GLESShadow.prototype.context = function(handle)
{
    return this.contexts.get(handle) || null;
};

/**
 * One GLES call in a context
 * @param {number} handle the connection's current context (0: none: the call does nothing)
 * @param {!Object} command (gles_wire.js)
 * @param {!Array<*>} args
 * @return {{ret: *, keep: boolean}} the answer, and whether the page needs the call
 */
GLESShadow.prototype.call = function(handle, command, args)
{
    const context = this.contexts.get(handle);
    if(!context) return { ret: 0, keep: false };
    const name = command.name, base = name.replace(/OES$/, "");
    const handler = context.api === 1 && (GLES1_HANDLERS[name] || GLES1_HANDLERS[base]) ||
        context.version >= 31 && (GLES31_HANDLERS[name] || GLES31_HANDLERS[base]) ||
        context.api === 3 && (GLES3_HANDLERS[name] || GLES3_HANDLERS[base]) || HANDLERS[name] || HANDLERS[base];
    this.keep = true;
    if(!handler)
    {
        // (a call nothing here follows: GLES 1.1's fixed function until E4)
        return { ret: 0, keep: true };
    }
    const ret = handler(this, context, args);
    if(ret === REFUSED) return { ret: 0, keep: false };
    return { ret, keep: this.keep };
};

/** Record an error (the first stays until glGetError) @return {symbol} REFUSED */
function fail(context, error)
{
    if(context.error === GL.NO_ERROR) context.error = error;
    return REFUSED;
}

/** @param {!GLESShadow} shadow the call is a query: nothing for the page */
function query(shadow)
{
    shadow.keep = false;
}

// ---- framebuffers

/**
 * An attachment's image: its size and kind, or null for none or one with no image
 * @return {?{width: number, height: number, kind: !Object}}
 */
GLESShadow.prototype.attachment_image = function(context, a)
{
    if(a.type === GL.RENDERBUFFER)
    {
        const rb = context.group.renderbuffers.get(a.name);
        if(!rb || !rb.width || !rb.height) return null;
        return { width: rb.width, height: rb.height, kind: RENDERBUFFER_FORMATS.get(rb.format) || texture_kind(GL.RGBA, GL.UNSIGNED_BYTE) };
    }
    const texture = context.group.textures.get(a.name);
    const image = texture && texture.images.get(a.face * 32 + a.level);
    if(!image || !image.width || !image.height) return null;
    return { width: image.width, height: image.height, kind: texture_kind(image.format, image.type) };
};

/**
 * The bound framebuffer's status (GLES 2.0, 4.4.5)
 * @param {!Context} context
 * @return {number}
 */
GLESShadow.prototype.framebuffer_status = function(context)
{
    if(context.api === 3) return FRAMEBUFFER_STATUS3.fn(context, context.framebuffer);
    if(!context.framebuffer) return GL.FRAMEBUFFER_COMPLETE;
    const fbo = context.framebuffers.get(context.framebuffer);
    let size = null, any = false;
    for(const [attachment, a] of fbo.attachments)
    {
        const image = this.attachment_image(context, a);
        if(!image) return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        const k = image.kind;
        if(attachment === GL.COLOR_ATTACHMENT0 ? !k.color : attachment === GL.DEPTH_ATTACHMENT ? !k.depth : !k.stencil)
        {
            return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        }
        if(size && (size[0] !== image.width || size[1] !== image.height)) return GL.FRAMEBUFFER_INCOMPLETE_DIMENSIONS;
        size = [image.width, image.height];
        any = true;
    }
    if(!any) return GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT;
    // (depth and stencil apart are WebGPU's one depth-stencil texture: only
    // as the same packed renderbuffer)
    const depth = fbo.attachments.get(GL.DEPTH_ATTACHMENT), stencil = fbo.attachments.get(GL.STENCIL_ATTACHMENT);
    if(depth && stencil && (depth.type !== stencil.type || depth.name !== stencil.name)) return GL.FRAMEBUFFER_UNSUPPORTED;
    return GL.FRAMEBUFFER_COMPLETE;
};

/** The red, green, blue, alpha, depth and stencil bits of what is drawn to */
GLESShadow.prototype.framebuffer_bits = function(context)
{
    if(!context.framebuffer)
    {
        const config = context.surface && context.surface.config;
        const value = attribute => config ? config[CONFIG_ATTRIBUTES.indexOf(attribute)] : 0;
        return [value(EGL.RED_SIZE), value(EGL.GREEN_SIZE), value(EGL.BLUE_SIZE), value(EGL.ALPHA_SIZE), value(EGL.DEPTH_SIZE), value(EGL.STENCIL_SIZE)];
    }
    const fbo = context.framebuffers.get(context.framebuffer);
    const bits = [0, 0, 0, 0, 0, 0];
    for(const [attachment, a] of fbo.attachments)
    {
        const image = this.attachment_image(context, a);
        if(!image) continue;
        const k = image.kind.bits;
        if(attachment === GL.COLOR_ATTACHMENT0) for(let i = 0; i < 4; i++) bits[i] = k[i];
        if(attachment === GL.DEPTH_ATTACHMENT) bits[4] = k[4];
        if(attachment === GL.STENCIL_ATTACHMENT) bits[5] = k[5];
    }
    return bits;
};

/** INVALID_FRAMEBUFFER_OPERATION when what is drawn to is not complete @return {boolean} whether it is */
function framebuffer_ok(shadow, context)
{
    if(shadow.framebuffer_status(context) === GL.FRAMEBUFFER_COMPLETE) return true;
    fail(context, GL.INVALID_FRAMEBUFFER_OPERATION);
    return false;
}

/** An object deleted: what the context had bound or attached of it goes */
function detach(context, type, name)
{
    const fbo = context.framebuffer && context.framebuffers.get(context.framebuffer);
    if(!fbo) return;
    for(const [attachment, a] of fbo.attachments) if(a.type === type && a.name === name) fbo.attachments.delete(attachment);
}

/**
 * A texture or renderbuffer deleted while framebuffers that are not bound
 * have it attached (GL keeps it for them; a new object of its name is
 * another): theirs, under a name of its own past those glGen gives
 * @param {!Map<number, !Object>} objects the group's of its kind
 */
function keep_orphan(context, type, objects, name, object)
{
    let orphan = 0;
    for(const fbo of context.framebuffers.values())
    {
        for(const a of fbo.attachments.values())
        {
            if(a.type !== type || a.name !== name) continue;
            if(!orphan) orphan = context.group.next_orphan = (context.group.next_orphan || 0x40000000) + 1;
            a.name = orphan;
        }
    }
    if(orphan) objects.set(orphan, object);
}

// ---- glGet

/**
 * A pname's value in the context, or null for a pname glGet does not know
 * @return {?Array<number>}
 */
GLESShadow.prototype.state_value = function(context, pname)
{
    const c = context;
    if(c.api === 3)
    {
        const value = c.version >= 31 && state_value31(this, c, pname) || state_value3(this, c, pname);
        if(value) return value;
        if(this.read_error3) { this.read_error3 = false; return null; }
    }
    switch(pname)
    {
        case 0x0BA2: return c.viewport;
        case 0x0C10: return c.scissor;
        case 0x0B70: return c.depth_range;
        case 0x0B21: return [c.line_width];
        case 0x0B45: return [c.cull_face];
        case 0x0B46: return [c.front_face];
        case 0x8038: return [c.polygon_offset[0]];
        case 0x2A00: return [c.polygon_offset[1]];
        case 0x80AA: return [c.sample_coverage[0]];
        case 0x80AB: return [c.sample_coverage[1]];
        case 0x0C22: return c.clear_color;
        case 0x0B73: return [c.clear_depth];
        case 0x0B91: return [c.clear_stencil];
        case 0x0C23: return c.color_mask;
        case 0x0B72: return [c.depth_mask];
        // (the masks are unsigned: a float or 64-bit query of all bits set is 4294967295)
        case 0x0B98: return [c.stencil_writemask[0] >>> 0];
        case 0x8CA5: return [c.stencil_writemask[1] >>> 0];
        case 0x80C9: return [c.blend_func[0]];
        case 0x80C8: return [c.blend_func[1]];
        case 0x80CB: return [c.blend_func[2]];
        case 0x80CA: return [c.blend_func[3]];
        case 0x0BE1: return [c.blend_func[0]]; // GLES 1.1's GL_BLEND_SRC
        case 0x0BE0: return [c.blend_func[1]];
        case 0x8009: return [c.blend_equation[0]];
        case 0x883D: return [c.blend_equation[1]];
        case 0x8005: return c.blend_color;
        case 0x0B74: return [c.depth_func];
        case 0x0B92: return [c.stencil_func[0][0]];
        case 0x0B97: return [c.stencil_func[0][1]];
        case 0x0B93: return [c.stencil_func[0][2] >>> 0];
        case 0x8800: return [c.stencil_func[1][0]];
        case 0x8CA3: return [c.stencil_func[1][1]];
        case 0x8CA4: return [c.stencil_func[1][2] >>> 0];
        case 0x0B94: return [c.stencil_op[0][0]];
        case 0x0B95: return [c.stencil_op[0][1]];
        case 0x0B96: return [c.stencil_op[0][2]];
        case 0x8801: return [c.stencil_op[1][0]];
        case 0x8802: return [c.stencil_op[1][1]];
        case 0x8803: return [c.stencil_op[1][2]];
        case GL.UNPACK_ALIGNMENT: return [c.unpack_alignment];
        case GL.PACK_ALIGNMENT: return [c.pack_alignment];
        case 0x84E0: return [GL.TEXTURE0 + c.active_texture];
        case 0x8069: return [c.textures[c.active_texture][0]];
        case 0x8514: return [c.textures[c.active_texture][1]];
        case 0x8D67: return [c.textures[c.active_texture][2]]; // GL_TEXTURE_BINDING_EXTERNAL_OES
        case 0x8894: return [c.array_buffer];
        case 0x8895: return [c.element_array_buffer];
        case 0x8CA6: return [c.framebuffer];
        case 0x8CA7: return [c.renderbuffer];
        case 0x8B8D: return [c.program];
        case 0x0D52: case 0x0D53: case 0x0D54: case 0x0D55: case 0x0D56: case 0x0D57:
            return [this.framebuffer_bits(c)[pname - 0x0D52]];
        case 0x86A3: return COMPRESSED_TEXTURE_FORMATS;
    }
    if(c.hints.has(pname) && (c.api === 1 || pname === 0x8192 || pname === 0x8B8B)) return [c.hints.get(pname)];
    if((c.api === 1 ? CAPS_1 : CAPS_2).has(pname)) return [c.enabled.has(pname) ? 1 : 0];
    if(GL_STATE.has(pname)) return GL_STATE.get(pname);
    return null;
};

/** glGet{Boolean,Integer,Float,Fixed}v: "b", "i", "f", "x" */
function get(as)
{
    return (shadow, c, [pname, params]) =>
    {
        query(shadow);
        const own = c.api === 1 ? gles1_state_value(c, pname) : null;
        if(own) return put(params, own[0], as, own[1]);
        let value = shadow.state_value(c, pname);
        if(!value) return fail(c, GL.INVALID_ENUM);
        // (GLES 3.0's 64-bit state through a 32-bit glGet: clamped)
        if(INT64_STATE.has(pname) && as !== "f") value = value.map(v => Math.min(v, 0x7FFFFFFF));
        put(params, value, as, STATE_KIND.get(pname) || "i");
        return undefined;
    };
}

// ---- the commands

/** @param {!Context} c @param {number} name @param {string} kind "shader" or "program" @return {?Object} the object, or null with the error set */
function object_of(c, name, kind)
{
    const object = c.group.objects.get(name);
    if(!object) { fail(c, GL.INVALID_VALUE); return null; }
    if(object.kind !== kind) { fail(c, GL.INVALID_OPERATION); return null; }
    return object;
}

/** The texture bound to a target of the active unit, or null with the error set */
function bound_texture(c, target)
{
    const slot = texture_slot(target);
    if(slot < 0) { fail(c, GL.INVALID_ENUM); return null; }
    const name = c.textures[c.active_texture][slot];
    let texture = c.group.textures.get(name);
    if(!texture && !name)
    {
        // (name 0: the context's default texture of the target)
        c.defaults = c.defaults || new Map();
        texture = c.defaults.get(target);
        if(!texture) c.defaults.set(target, texture = new_texture(target));
    }
    return texture || null;
}

/** @return {?Object} the texture a TexImage2D-like call names (2D or a cube face), with its face, or null with the error set */
function image_target(c, target)
{
    const face = face_of(target);
    if(face < 0) { fail(c, GL.INVALID_ENUM); return null; }
    const texture = bound_texture(c, target === GL.TEXTURE_2D ? GL.TEXTURE_2D : GL.TEXTURE_CUBE_MAP);
    return texture ? { texture, face } : null;
}

/** TexImage2D's checks of the level and size @return {boolean} */
function image_size_ok(c, target, level, width, height, border)
{
    if(level < 0 || level > MAX_LEVEL || width < 0 || height < 0 || border !== 0 ||
        (width << level) > MAX_SIZE || (height << level) > MAX_SIZE ||
        target !== GL.TEXTURE_2D && width !== height)
    {
        fail(c, GL.INVALID_VALUE);
        return false;
    }
    return true;
}

/** The buffer bound to a target, or null with the error set */
function bound_buffer(c, target)
{
    if(target !== GL.ARRAY_BUFFER && target !== GL.ELEMENT_ARRAY_BUFFER) { fail(c, GL.INVALID_ENUM); return null; }
    const name = target === GL.ARRAY_BUFFER ? c.array_buffer : c.element_array_buffer;
    const buffer = c.group.buffers.get(name);
    if(!buffer) { fail(c, GL.INVALID_OPERATION); return null; }
    return buffer;
}

/** The linked current program's uniform at a location: null for -1 (ignored), REFUSED with the error set */
function uniform_at(c, location, count)
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
}

/**
 * glUniform*: the values into the program's storage, after GLES 2.0's
 * checks (2.10.4): the size and kind of the function against the uniform's
 * @param {number} components 1 to 4, or 4, 9, 16 for the matrices
 * @param {string} kind "f", "i" or "m" (a matrix)
 */
function uniform(components, kind, vector)
{
    return (shadow, c, args) =>
    {
        const location = args[0];
        let count = 1, values;
        if(kind === "m")
        {
            count = args[1];
            if(args[2]) return fail(c, GL.INVALID_VALUE);
            values = f32s(args[3]);
        }
        else if(vector)
        {
            count = args[1];
            values = kind === "f" ? f32s(args[2]) : i32s(args[2]);
        }
        else values = args.slice(1);
        const target = uniform_at(c, location, count);
        if(target === REFUSED || target === null) return target === null ? undefined : target;
        const u = target.at.uniform;
        if(kind === "m" ? !u.columns || u.columns * u.columns !== components : u.columns || u.components !== components ||
            (kind === "f" ? u.int && !u.bool : !u.int && !u.bool) || u.sampler && (kind !== "i" || components !== 1))
        {
            return fail(c, GL.INVALID_OPERATION);
        }
        const store = target.program.values;
        const n = Math.min(count, u.size - target.at.element);
        for(let i = 0; i < n; i++)
        {
            const slice = values.slice(i * components, (i + 1) * components);
            store.set(location + i, u.bool ? slice.map(v => v ? 1 : 0) : kind === "f" || kind === "m" ? slice.map(Math.fround) : slice);
        }
    };
}

/** glVertexAttrib{1,2,3,4}f(v) */
function vertex_attrib(components, vector)
{
    return (shadow, c, args) =>
    {
        const index = args[0];
        if(index >= MAX_ATTRIBS) return fail(c, GL.INVALID_VALUE);
        const values = vector ? f32s(args[1]).slice(0, components) : args.slice(1, 1 + components);
        const current = [0, 0, 0, 1];
        values.forEach((v, i) => { current[i] = Math.fround(v); });
        c.attribs[index].current = current;
    };
}

/** A glGen*: names nothing has, reserved */
function gen(kind, map_of)
{
    return (shadow, c, [n, names]) =>
    {
        query(shadow);
        if(n < 0) return fail(c, GL.INVALID_VALUE);
        const objects = map_of(c);
        const reserved = kind === "framebuffer" ? c.reserved_framebuffers : c.group.reserved[kind];
        for(let i = 0; i < n && 4 * i + 4 <= names.size; i++)
        {
            let name;
            if(kind === "framebuffer")
            {
                name = c.next_framebuffer;
                while(objects.has(name) || reserved.has(name)) name++;
                c.next_framebuffer = name + 1;
            }
            else name = c.group.fresh(kind, objects);
            reserved.add(name);
            names.view.setUint32(4 * i, name, true);
        }
    };
}

/** @type {!Object<string, function(!GLESShadow, !Context, !Array<*>): *>} */
const HANDLERS = {
    "glGetError": (shadow, c) =>
    {
        query(shadow);
        const error = c.error;
        c.error = GL.NO_ERROR;
        return error;
    },
    "glGetGraphicsResetStatusEXT": shadow => { query(shadow); return 0; },
    "glFinishRoundTrip": shadow => { query(shadow); return 0; },
    "glFinish": () => {},
    "glFlush": () => {},
    "glGetBooleanv": get("b"),
    "glGetIntegerv": get("i"),
    "glGetFloatv": get("f"),
    "glGetFixedv": get("x"),
    "glGetCompressedTextureFormats": (shadow, c, [count, formats]) =>
    {
        query(shadow);
        put(formats, COMPRESSED_TEXTURE_FORMATS, "i", "i");
    },
    "glGetShaderPrecisionFormat": (shadow, c, [shadertype, precisiontype, range, precision]) =>
    {
        query(shadow);
        if(shadertype !== GL.VERTEX_SHADER && shadertype !== GL.FRAGMENT_SHADER || precisiontype < 0x8DF0 || precisiontype > 0x8DF5)
        {
            return fail(c, GL.INVALID_ENUM);
        }
        // (WebGPU's: f32 and i32 at every precision)
        const float = precisiontype <= 0x8DF2;
        put(range, float ? [127, 127] : [31, 30], "i", "i");
        put(precision, [float ? 23 : 0], "i", "i");
    },
    "glEnable": (shadow, c, [cap]) =>
    {
        if(!(c.api === 1 ? CAPS_1 : CAPS_2).has(cap)) return fail(c, GL.INVALID_ENUM);
        c.enabled.add(cap);
    },
    "glDisable": (shadow, c, [cap]) =>
    {
        if(!(c.api === 1 ? CAPS_1 : CAPS_2).has(cap)) return fail(c, GL.INVALID_ENUM);
        c.enabled.delete(cap);
    },
    "glIsEnabled": (shadow, c, [cap]) =>
    {
        query(shadow);
        if(!(c.api === 1 ? CAPS_1 : CAPS_2).has(cap)) { fail(c, GL.INVALID_ENUM); return 0; }
        return c.enabled.has(cap) ? 1 : 0;
    },
    "glViewport": (shadow, c, [x, y, width, height]) =>
    {
        if(width < 0 || height < 0) return fail(c, GL.INVALID_VALUE);
        c.viewport = [x, y, Math.min(width, MAX_VIEWPORT), Math.min(height, MAX_VIEWPORT)];
    },
    "glScissor": (shadow, c, [x, y, width, height]) =>
    {
        if(width < 0 || height < 0) return fail(c, GL.INVALID_VALUE);
        c.scissor = [x, y, width, height];
    },
    "glDepthRangef": (shadow, c, [near, far]) =>
    {
        c.depth_range = [Math.min(1, Math.max(0, near)), Math.min(1, Math.max(0, far))].map(Math.fround);
    },
    "glLineWidth": (shadow, c, [width]) =>
    {
        if(!(width > 0)) return fail(c, GL.INVALID_VALUE);
        c.line_width = Math.fround(width);
    },
    "glCullFace": (shadow, c, [mode]) =>
    {
        if(!FACES.has(mode)) return fail(c, GL.INVALID_ENUM);
        c.cull_face = mode;
    },
    "glFrontFace": (shadow, c, [mode]) =>
    {
        if(mode !== 0x0900 && mode !== 0x0901) return fail(c, GL.INVALID_ENUM);
        c.front_face = mode;
    },
    "glPolygonOffset": (shadow, c, [factor, units]) => { c.polygon_offset = [Math.fround(factor), Math.fround(units)]; },
    "glSampleCoverage": (shadow, c, [value, invert]) => { c.sample_coverage = [Math.fround(Math.min(1, Math.max(0, value))), invert ? 1 : 0]; },
    "glClearColor": (shadow, c, rgba) => { c.clear_color = rgba.map(v => Math.fround(Math.min(1, Math.max(0, v)))); },
    "glClearDepthf": (shadow, c, [depth]) => { c.clear_depth = Math.fround(Math.min(1, Math.max(0, depth))); },
    "glClearStencil": (shadow, c, [s]) => { c.clear_stencil = s; },
    "glColorMask": (shadow, c, rgba) => { c.color_mask = rgba.map(v => v ? 1 : 0); },
    "glDepthMask": (shadow, c, [flag]) => { c.depth_mask = flag ? 1 : 0; },
    "glStencilMask": (shadow, c, [mask]) => { c.stencil_writemask = [mask | 0, mask | 0]; },
    "glStencilMaskSeparate": (shadow, c, [face, mask]) =>
    {
        if(!FACES.has(face)) return fail(c, GL.INVALID_ENUM);
        if(face !== BACK) c.stencil_writemask[0] = mask | 0;
        if(face !== FRONT) c.stencil_writemask[1] = mask | 0;
    },
    "glBlendColor": (shadow, c, rgba) => { c.blend_color = rgba.map(v => Math.fround(Math.min(1, Math.max(0, v)))); },
    "glBlendEquation": (shadow, c, [mode]) =>
    {
        if(!equation_ok(c, mode, true)) return fail(c, GL.INVALID_ENUM);
        c.blend_equation = [mode, mode];
    },
    "glBlendEquationSeparate": (shadow, c, [rgb, alpha]) =>
    {
        if(!equation_ok(c, rgb, false) || !equation_ok(c, alpha, false)) return fail(c, GL.INVALID_ENUM);
        c.blend_equation = [rgb, alpha];
    },
    "glBlendFunc": (shadow, c, [src, dst]) =>
    {
        if(!source_factor(src) || !destination_factor(c, dst)) return fail(c, GL.INVALID_ENUM);
        c.blend_func = [src, dst, src, dst];
    },
    "glBlendFuncSeparate": (shadow, c, [src_rgb, dst_rgb, src_alpha, dst_alpha]) =>
    {
        if(!source_factor(src_rgb) || !source_factor(src_alpha) || !destination_factor(c, dst_rgb) || !destination_factor(c, dst_alpha)) {
            return fail(c, GL.INVALID_ENUM);
        }
        c.blend_func = [src_rgb, dst_rgb, src_alpha, dst_alpha];
    },
    "glDepthFunc": (shadow, c, [func]) =>
    {
        if(!COMPARE_FUNCS.has(func)) return fail(c, GL.INVALID_ENUM);
        c.depth_func = func;
    },
    "glStencilFunc": (shadow, c, [func, ref, mask]) =>
    {
        if(!COMPARE_FUNCS.has(func)) return fail(c, GL.INVALID_ENUM);
        c.stencil_func = [[func, ref, mask | 0], [func, ref, mask | 0]];
    },
    "glStencilFuncSeparate": (shadow, c, [face, func, ref, mask]) =>
    {
        if(!FACES.has(face) || !COMPARE_FUNCS.has(func)) return fail(c, GL.INVALID_ENUM);
        if(face !== BACK) c.stencil_func[0] = [func, ref, mask | 0];
        if(face !== FRONT) c.stencil_func[1] = [func, ref, mask | 0];
    },
    "glStencilOp": (shadow, c, ops) =>
    {
        if(!ops.every(op => STENCIL_OPS.has(op))) return fail(c, GL.INVALID_ENUM);
        c.stencil_op = [ops.slice(), ops.slice()];
    },
    "glStencilOpSeparate": (shadow, c, [face, ...ops]) =>
    {
        if(!FACES.has(face) || !ops.every(op => STENCIL_OPS.has(op))) return fail(c, GL.INVALID_ENUM);
        if(face !== BACK) c.stencil_op[0] = ops.slice();
        if(face !== FRONT) c.stencil_op[1] = ops.slice();
    },
    "glHint": (shadow, c, [target, mode]) =>
    {
        if(!(c.api === 1 ? c.hints.has(target) : target === 0x8192 || target === 0x8B8B) || !HINT_MODES.has(mode)) return fail(c, GL.INVALID_ENUM);
        c.hints.set(target, mode);
    },
    "glPixelStorei": (shadow, c, [pname, param]) =>
    {
        if(pname !== GL.UNPACK_ALIGNMENT && pname !== GL.PACK_ALIGNMENT) return fail(c, GL.INVALID_ENUM);
        if(![1, 2, 4, 8].includes(param)) return fail(c, GL.INVALID_VALUE);
        if(pname === GL.UNPACK_ALIGNMENT) c.unpack_alignment = param;
        else c.pack_alignment = param;
    },

    // ---- textures
    "glActiveTexture": (shadow, c, [unit]) =>
    {
        const index = unit - GL.TEXTURE0;
        if(index < 0 || index >= (c.api === 1 ? GL_STATE.get(0x84E2)[0] : MAX_UNITS)) return fail(c, GL.INVALID_ENUM);
        c.active_texture = index;
    },
    "glGenTextures": gen("texture", c => c.group.textures),
    "glBindTexture": (shadow, c, [target, name]) =>
    {
        const slot = texture_slot(target);
        if(slot < 0) return fail(c, GL.INVALID_ENUM);
        if(name)
        {
            const texture = c.group.textures.get(name);
            if(texture && texture.target !== target) return fail(c, GL.INVALID_OPERATION);
            if(!texture) c.group.textures.set(name, new_texture(target));
        }
        c.textures[c.active_texture][slot] = name;
    },
    "glDeleteTextures": (shadow, c, [n, names]) =>
    {
        if(n < 0) return fail(c, GL.INVALID_VALUE);
        for(const name of i32s(names).slice(0, n))
        {
            if(!name) continue;
            c.group.reserved.texture.delete(name);
            if(!c.group.textures.delete(name)) continue;
            for(const unit of c.textures) for(let i = 0; i < 3; i++) if(unit[i] === name) unit[i] = 0;
            detach(c, GL.TEXTURE, name);
        }
    },
    "glIsTexture": (shadow, c, [name]) => { query(shadow); return c.group.textures.has(name) ? 1 : 0; },
    "glTexImage2D": (shadow, c, [target, level, internalformat, width, height, border, format, type, pixels]) =>
    {
        const t = image_target(c, target);
        if(!t) return REFUSED;
        const error = texture_format_error(format, type);
        if(error) return fail(c, error);
        if(internalformat !== format) return fail(c, texture_format_error(internalformat, type) === GL.INVALID_ENUM ? GL.INVALID_VALUE : GL.INVALID_OPERATION);
        if(!image_size_ok(c, target, level, width, height, border)) return REFUSED;
        if(pixels && pixels.length < image_bytes(width, height, texel_bytes(format, type), c.unpack_alignment)) return fail(c, GL.INVALID_OPERATION);
        t.texture.images.set(t.face * 32 + level, { width, height, format, type, compressed: false });
    },
    "glTexSubImage2D": (shadow, c, [target, level, x, y, width, height, format, type, pixels]) =>
    {
        const t = image_target(c, target);
        if(!t) return REFUSED;
        const error = texture_format_error(format, type);
        if(error) return fail(c, error);
        if(level < 0 || level > MAX_LEVEL || x < 0 || y < 0 || width < 0 || height < 0) return fail(c, GL.INVALID_VALUE);
        const image = t.texture.images.get(t.face * 32 + level);
        if(!image || image.compressed) return fail(c, GL.INVALID_OPERATION);
        if(x + width > image.width || y + height > image.height) return fail(c, GL.INVALID_VALUE);
        if(image.format !== format || image.type !== type) return fail(c, GL.INVALID_OPERATION);
    },
    "glCompressedTexImage2D": (shadow, c, [target, level, internalformat, width, height, border, size, data]) =>
    {
        const t = image_target(c, target);
        if(!t) return REFUSED;
        if(internalformat !== GL.ETC1_RGB8_OES) return fail(c, GL.INVALID_ENUM);
        if(!image_size_ok(c, target, level, width, height, border)) return REFUSED;
        if(size !== etc1_bytes(width, height) || (data ? data.length : 0) < size) return fail(c, GL.INVALID_VALUE);
        t.texture.images.set(t.face * 32 + level, { width, height, format: internalformat, type: GL.UNSIGNED_BYTE, compressed: true });
    },
    // (ETC1 has no partial updates: OES_compressed_ETC1_RGB8_texture)
    "glCompressedTexSubImage2D": (shadow, c, [target]) =>
    {
        if(!image_target(c, target)) return REFUSED;
        return fail(c, GL.INVALID_OPERATION);
    },
    "glCopyTexImage2D": (shadow, c, [target, level, internalformat, x, y, width, height, border]) =>
    {
        const t = image_target(c, target);
        if(!t) return REFUSED;
        if(![GL.ALPHA, GL.LUMINANCE, GL.LUMINANCE_ALPHA, GL.RGB, GL.RGBA].includes(internalformat)) return fail(c, GL.INVALID_ENUM);
        if(!image_size_ok(c, target, level, width, height, border)) return REFUSED;
        if(!framebuffer_ok(shadow, c)) return REFUSED;
        // (the framebuffer's channels must cover the format's: GLES 2.0 table 3.9)
        const bits = shadow.framebuffer_bits(c);
        if((internalformat === GL.ALPHA || internalformat === GL.LUMINANCE_ALPHA || internalformat === GL.RGBA) && !bits[3]) return fail(c, GL.INVALID_OPERATION);
        t.texture.images.set(t.face * 32 + level, { width, height, format: internalformat, type: GL.UNSIGNED_BYTE, compressed: false });
    },
    "glCopyTexSubImage2D": (shadow, c, [target, level, xoffset, yoffset, x, y, width, height]) =>
    {
        const t = image_target(c, target);
        if(!t) return REFUSED;
        // (a level above log2 of the largest size: INVALID_VALUE, before whether it has an image)
        if(level < 0 || level > MAX_LEVEL || xoffset < 0 || yoffset < 0 || width < 0 || height < 0) return fail(c, GL.INVALID_VALUE);
        const image = t.texture.images.get(t.face * 32 + level);
        if(!image || image.compressed) return fail(c, GL.INVALID_OPERATION);
        if(xoffset + width > image.width || yoffset + height > image.height) return fail(c, GL.INVALID_VALUE);
        if(!framebuffer_ok(shadow, c)) return REFUSED;
    },
    "glGenerateMipmap": (shadow, c, [target]) =>
    {
        if(target !== GL.TEXTURE_2D && target !== GL.TEXTURE_CUBE_MAP) return fail(c, GL.INVALID_ENUM);
        const texture = bound_texture(c, target);
        const faces = target === GL.TEXTURE_2D ? 1 : 6;
        const base = texture.images.get(0);
        if(!base || base.compressed) return fail(c, GL.INVALID_OPERATION);
        for(let face = 0; face < faces; face++)
        {
            const image = texture.images.get(face * 32);
            if(!image || image.width !== base.width || image.height !== base.height || image.format !== base.format) return fail(c, GL.INVALID_OPERATION);
        }
        for(let face = 0; face < faces; face++)
        {
            let w = base.width, h = base.height;
            for(let level = 1; w > 1 || h > 1; level++)
            {
                w = Math.max(1, w >> 1);
                h = Math.max(1, h >> 1);
                texture.images.set(face * 32 + level, { width: w, height: h, format: base.format, type: base.type, compressed: false });
            }
        }
    },
    "glTexParameterf": (shadow, c, [target, pname, param]) => tex_parameter(c, target, pname, [param]),
    "glTexParameteri": (shadow, c, [target, pname, param]) => tex_parameter(c, target, pname, [param]),
    "glTexParameterx": (shadow, c, [target, pname, param]) => tex_parameter(c, target, pname, [param]),
    "glTexParameterfv": (shadow, c, [target, pname, params]) => tex_parameter(c, target, pname, f32s(params)),
    "glTexParameteriv": (shadow, c, [target, pname, params]) => tex_parameter(c, target, pname, i32s(params)),
    "glTexParameterxv": (shadow, c, [target, pname, params]) => tex_parameter(c, target, pname, i32s(params)),
    "glGetTexParameteriv": (shadow, c, [target, pname, params]) => get_tex_parameter(shadow, c, target, pname, params, "i"),
    "glGetTexParameterfv": (shadow, c, [target, pname, params]) => get_tex_parameter(shadow, c, target, pname, params, "f"),
    "glGetTexParameterxv": (shadow, c, [target, pname, params]) => get_tex_parameter(shadow, c, target, pname, params, "i"),
    // EGL images (OES_EGL_image): the image's color buffer is the texture's level 0
    "glEGLImageTargetTexture2DOES": (shadow, c, [target, image]) =>
    {
        if(target !== GL.TEXTURE_2D && target !== GL.TEXTURE_EXTERNAL_OES) return fail(c, GL.INVALID_ENUM);
        const size = shadow.image_size(image);
        if(!size) return fail(c, GL.INVALID_VALUE);
        const texture = bound_texture(c, target);
        if(!texture) return REFUSED;
        texture.images.clear();
        texture.images.set(0, { width: size.width, height: size.height, format: size.format, type: GL.UNSIGNED_BYTE, compressed: false, image });
    },
    "glEGLImageTargetRenderbufferStorageOES": (shadow, c, [target, image]) =>
    {
        if(target !== GL.RENDERBUFFER) return fail(c, GL.INVALID_ENUM);
        const size = shadow.image_size(image);
        if(!size) return fail(c, GL.INVALID_VALUE);
        const rb = c.group.renderbuffers.get(c.renderbuffer);
        if(!rb) return fail(c, GL.INVALID_OPERATION);
        Object.assign(rb, { width: size.width, height: size.height, format: size.format === GL.RGB ? GL.RGB8_OES : GL.RGBA8_OES, image });
    },

    // ---- buffers
    "glGenBuffers": gen("buffer", c => c.group.buffers),
    "glBindBuffer": (shadow, c, [target, name]) =>
    {
        if(target !== GL.ARRAY_BUFFER && target !== GL.ELEMENT_ARRAY_BUFFER) return fail(c, GL.INVALID_ENUM);
        if(name && !c.group.buffers.has(name)) c.group.buffers.set(name, { size: 0, usage: GL.STATIC_DRAW });
        if(target === GL.ARRAY_BUFFER) c.array_buffer = name;
        else c.element_array_buffer = name;
    },
    "glDeleteBuffers": (shadow, c, [n, names]) =>
    {
        if(n < 0) return fail(c, GL.INVALID_VALUE);
        for(const name of i32s(names).slice(0, n))
        {
            if(!name) continue;
            c.group.reserved.buffer.delete(name);
            if(!c.group.buffers.delete(name)) continue;
            if(c.array_buffer === name) c.array_buffer = 0;
            if(c.element_array_buffer === name) c.element_array_buffer = 0;
            for(const a of c.attribs) if(a.buffer === name) a.buffer = 0;
        }
    },
    "glIsBuffer": (shadow, c, [name]) => { query(shadow); return c.group.buffers.has(name) ? 1 : 0; },
    "glBufferData": (shadow, c, [target, size, data, usage]) =>
    {
        if(target !== GL.ARRAY_BUFFER && target !== GL.ELEMENT_ARRAY_BUFFER || !USAGES.has(usage)) return fail(c, GL.INVALID_ENUM);
        if(size < 0) return fail(c, GL.INVALID_VALUE);
        const buffer = bound_buffer(c, target);
        if(!buffer) return REFUSED;
        buffer.size = size;
        buffer.usage = usage;
    },
    "glBufferSubData": (shadow, c, [target, offset, size, data]) =>
    {
        const buffer = bound_buffer(c, target);
        if(!buffer) return REFUSED;
        if(offset < 0 || size < 0 || offset + size > buffer.size) return fail(c, GL.INVALID_VALUE);
    },
    "glGetBufferParameteriv": (shadow, c, [target, pname, params]) =>
    {
        query(shadow);
        if(pname !== 0x8764 && pname !== 0x8765) { fail(c, GL.INVALID_ENUM); return; }
        const buffer = bound_buffer(c, target);
        if(!buffer) return;
        put(params, [pname === 0x8764 ? buffer.size : buffer.usage], "i", "i");
    },

    // ---- renderbuffers and framebuffers
    "glGenRenderbuffers": gen("renderbuffer", c => c.group.renderbuffers),
    "glBindRenderbuffer": (shadow, c, [target, name]) =>
    {
        if(target !== GL.RENDERBUFFER) return fail(c, GL.INVALID_ENUM);
        if(name && !c.group.renderbuffers.has(name)) c.group.renderbuffers.set(name, { width: 0, height: 0, format: GL.RGBA4, image: 0 });
        c.renderbuffer = name;
    },
    "glDeleteRenderbuffers": (shadow, c, [n, names]) =>
    {
        if(n < 0) return fail(c, GL.INVALID_VALUE);
        for(const name of i32s(names).slice(0, n))
        {
            if(!name) continue;
            c.group.reserved.renderbuffer.delete(name);
            const renderbuffer = c.group.renderbuffers.get(name);
            if(!c.group.renderbuffers.delete(name)) continue;
            if(c.renderbuffer === name) c.renderbuffer = 0;
            detach(c, GL.RENDERBUFFER, name);
            keep_orphan(c, GL.RENDERBUFFER, c.group.renderbuffers, name, renderbuffer);
        }
    },
    "glIsRenderbuffer": (shadow, c, [name]) => { query(shadow); return c.group.renderbuffers.has(name) ? 1 : 0; },
    "glRenderbufferStorage": (shadow, c, [target, format, width, height]) =>
    {
        if(target !== GL.RENDERBUFFER || !RENDERBUFFER_FORMATS.has(format)) return fail(c, GL.INVALID_ENUM);
        if(width < 0 || height < 0 || width > MAX_SIZE || height > MAX_SIZE) return fail(c, GL.INVALID_VALUE);
        const rb = c.group.renderbuffers.get(c.renderbuffer);
        if(!rb) return fail(c, GL.INVALID_OPERATION);
        Object.assign(rb, { width, height, format, image: 0 });
    },
    "glGetRenderbufferParameteriv": (shadow, c, [target, pname, params]) =>
    {
        query(shadow);
        if(target !== GL.RENDERBUFFER) { fail(c, GL.INVALID_ENUM); return; }
        const rb = c.group.renderbuffers.get(c.renderbuffer);
        if(!rb) { fail(c, GL.INVALID_OPERATION); return; }
        // (GLES 2.0's formats, else GLES 3.0's sized ones)
        const bits = rb.width ? (RENDERBUFFER_FORMATS.get(rb.format) || SIZED_INFO(rb.format) || { bits: [0, 0, 0, 0, 0, 0] }).bits : [0, 0, 0, 0, 0, 0];
        const values = { 0x8D42: rb.width, 0x8D43: rb.height, 0x8D44: rb.format, 0x8D50: bits[0], 0x8D51: bits[1], 0x8D52: bits[2],
            0x8D53: bits[3], 0x8D54: bits[4], 0x8D55: bits[5] };
        if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
        put(params, [values[pname]], "i", "i");
    },
    "glGenFramebuffers": gen("framebuffer", c => c.framebuffers),
    "glBindFramebuffer": (shadow, c, [target, name]) =>
    {
        if(target !== GL.FRAMEBUFFER) return fail(c, GL.INVALID_ENUM);
        if(name && !c.framebuffers.has(name)) c.framebuffers.set(name, { attachments: new Map() });
        c.framebuffer = name;
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
        }
    },
    "glIsFramebuffer": (shadow, c, [name]) => { query(shadow); return c.framebuffers.has(name) ? 1 : 0; },
    "glCheckFramebufferStatus": (shadow, c, [target]) =>
    {
        query(shadow);
        if(target !== GL.FRAMEBUFFER) { fail(c, GL.INVALID_ENUM); return 0; }
        return shadow.framebuffer_status(c);
    },
    "glFramebufferRenderbuffer": (shadow, c, [target, attachment, rbtarget, name]) =>
    {
        if(target !== GL.FRAMEBUFFER || !ATTACHMENTS.includes(attachment) || rbtarget !== GL.RENDERBUFFER) return fail(c, GL.INVALID_ENUM);
        const fbo = c.framebuffers.get(c.framebuffer);
        if(!fbo || name && !c.group.renderbuffers.has(name)) return fail(c, GL.INVALID_OPERATION);
        if(name) fbo.attachments.set(attachment, { type: GL.RENDERBUFFER, name, level: 0, face: 0 });
        else fbo.attachments.delete(attachment);
    },
    "glFramebufferTexture2D": (shadow, c, [target, attachment, textarget, name, level]) =>
    {
        if(target !== GL.FRAMEBUFFER || !ATTACHMENTS.includes(attachment)) return fail(c, GL.INVALID_ENUM);
        const fbo = c.framebuffers.get(c.framebuffer);
        if(!fbo) return fail(c, GL.INVALID_OPERATION);
        if(!name)
        {
            fbo.attachments.delete(attachment);
            return;
        }
        const face = face_of(textarget);
        if(face < 0) return fail(c, GL.INVALID_ENUM);
        if(level !== 0) return fail(c, GL.INVALID_VALUE);
        const texture = c.group.textures.get(name);
        if(!texture || (texture.target === GL.TEXTURE_CUBE_MAP) !== (textarget !== GL.TEXTURE_2D)) return fail(c, GL.INVALID_OPERATION);
        fbo.attachments.set(attachment, { type: GL.TEXTURE, name, level, face });
    },
    "glGetFramebufferAttachmentParameteriv": (shadow, c, [target, attachment, pname, params]) =>
    {
        query(shadow);
        if(target !== GL.FRAMEBUFFER || !ATTACHMENTS.includes(attachment)) { fail(c, GL.INVALID_ENUM); return; }
        const fbo = c.framebuffers.get(c.framebuffer);
        if(!fbo) { fail(c, GL.INVALID_OPERATION); return; }
        const a = fbo.attachments.get(attachment);
        let value;
        if(pname === 0x8CD0) value = a ? a.type : GL.NONE;
        else if(!a || pname !== 0x8CD1 && (a.type !== GL.TEXTURE || pname !== 0x8CD2 && pname !== 0x8CD3)) { fail(c, GL.INVALID_ENUM); return; }
        else value = pname === 0x8CD1 ? a.name : pname === 0x8CD2 ? a.level : a.face ? GL.TEXTURE_CUBE_MAP_POSITIVE_X + a.face : 0;
        put(params, [value], "i", "i");
    },
    "glDiscardFramebufferEXT": () => {},

    // ---- drawing
    "glClear": (shadow, c, [mask]) =>
    {
        if(mask & ~CLEAR_BITS) return fail(c, GL.INVALID_VALUE);
        if(!framebuffer_ok(shadow, c)) return REFUSED;
    },
    "glDrawArrays": (shadow, c, [mode, first, count]) =>
    {
        if(!MODES.has(mode)) return fail(c, GL.INVALID_ENUM);
        if(first < 0 || count < 0) return fail(c, GL.INVALID_VALUE);
        if(!framebuffer_ok(shadow, c)) return REFUSED;
    },
    "glDrawElementsOffset": (shadow, c, [mode, count, type, offset]) => draw_elements(shadow, c, mode, count, type, !!c.element_array_buffer),
    "glDrawElementsData": (shadow, c, [mode, count, type, data]) => draw_elements(shadow, c, mode, count, type, true),
    "glReadPixels": (shadow, c, [x, y, width, height, format, type]) =>
    {
        if(width < 0 || height < 0) return fail(c, GL.INVALID_VALUE);
        if(texture_format_error(format, type) === GL.INVALID_ENUM) return fail(c, GL.INVALID_ENUM);
        if(format !== GL.RGBA || type !== GL.UNSIGNED_BYTE) return fail(c, GL.INVALID_OPERATION);
        if(!framebuffer_ok(shadow, c)) return REFUSED;
    },

    // ---- vertex attributes (the encoder's: client arrays' data with the pointer, or a buffer's offset)
    "glEnableVertexAttribArray": (shadow, c, [index]) =>
    {
        if(index >= MAX_ATTRIBS) return fail(c, GL.INVALID_VALUE);
        c.attribs[index].enabled = true;
    },
    "glDisableVertexAttribArray": (shadow, c, [index]) =>
    {
        if(index >= MAX_ATTRIBS) return fail(c, GL.INVALID_VALUE);
        c.attribs[index].enabled = false;
    },
    "glVertexAttribPointerData": (shadow, c, [index, size, type, normalized, stride]) => attrib_pointer(c, index, size, type, normalized, stride, 0, 0),
    "glVertexAttribPointerOffset": (shadow, c, [index, size, type, normalized, stride, offset]) =>
        attrib_pointer(c, index, size, type, normalized, stride, c.array_buffer, offset),
    "glVertexAttrib1f": vertex_attrib(1, false),
    "glVertexAttrib2f": vertex_attrib(2, false),
    "glVertexAttrib3f": vertex_attrib(3, false),
    "glVertexAttrib4f": vertex_attrib(4, false),
    "glVertexAttrib1fv": vertex_attrib(1, true),
    "glVertexAttrib2fv": vertex_attrib(2, true),
    "glVertexAttrib3fv": vertex_attrib(3, true),
    "glVertexAttrib4fv": vertex_attrib(4, true),
    "glGetVertexAttribfv": (shadow, c, [index, pname, params]) => get_vertex_attrib(shadow, c, index, pname, params, "f"),
    "glGetVertexAttribiv": (shadow, c, [index, pname, params]) => get_vertex_attrib(shadow, c, index, pname, params, "i"),

    // ---- shaders and programs
    "glCreateShader": (shadow, c, [type]) =>
    {
        if(type !== GL.VERTEX_SHADER && type !== GL.FRAGMENT_SHADER) { fail(c, GL.INVALID_ENUM); return 0; }
        const name = shadow.given_name || c.group.fresh("object", c.group.objects);
        c.group.objects.set(name, { kind: "shader", type, source: null, compiled: null, compiled_source: null, deleted: false, attached: 0 });
        return name;
    },
    "glCreateProgram": (shadow, c) =>
    {
        const name = shadow.given_name || c.group.fresh("object", c.group.objects);
        c.group.objects.set(name, { kind: "program", shaders: new Set(), bindings: new Map(), info: null, linked_once: false,
            validated: 0, deleted: false, values: new Map() });
        return name;
    },
    "glShaderString": (shadow, c, [name, string]) =>
    {
        const shader = object_of(c, name, "shader");
        if(!shader) return REFUSED;
        shader.source = text_of(string);
    },
    "glCompileShader": (shadow, c, [name]) =>
    {
        const shader = object_of(c, name, "shader");
        if(!shader) return REFUSED;
        // (the source compiled: a snapshot compiles it again, gles_snapshot.js)
        shader.compiled_source = shader.source || "";
        const start = performance.now();
        shader.compiled = shadow.compile(shader.compiled_source, shader.type, c.glslang, c.api === 2);
        shadow.stats.compile_ms += performance.now() - start;
        shadow.stats.compiled++;
        if(!shader.compiled.ok)
        {
            shadow.stats.compile_failed++;
            if(shadow.stats.failures.length < 8) shadow.stats.failures.push(shader.compiled.log + "\n" + shader.source);
        }
    },
    "glDeleteShader": (shadow, c, [name]) =>
    {
        if(!name) return undefined;
        const shader = object_of(c, name, "shader");
        if(!shader) return REFUSED;
        shader.deleted = true;
        if(!shader.attached) c.group.objects.delete(name);
    },
    "glDeleteProgram": (shadow, c, [name]) =>
    {
        if(!name) return undefined;
        const program = object_of(c, name, "program");
        if(!program) return REFUSED;
        program.deleted = true;
        if(!shadow.program_in_use(name)) shadow.free_program(c.group, name);
    },
    "glIsShader": (shadow, c, [name]) => { query(shadow); const o = c.group.objects.get(name); return o && o.kind === "shader" ? 1 : 0; },
    "glIsProgram": (shadow, c, [name]) => { query(shadow); const o = c.group.objects.get(name); return o && o.kind === "program" ? 1 : 0; },
    "glAttachShader": (shadow, c, [p, s]) =>
    {
        const program = object_of(c, p, "program");
        const shader = program && object_of(c, s, "shader");
        if(!shader) return REFUSED;
        if(program.shaders.has(s) || [...program.shaders].some(other => c.group.objects.get(other).type === shader.type)) return fail(c, GL.INVALID_OPERATION);
        program.shaders.add(s);
        shader.attached++;
    },
    "glDetachShader": (shadow, c, [p, s]) =>
    {
        const program = object_of(c, p, "program");
        const shader = program && object_of(c, s, "shader");
        if(!shader) return REFUSED;
        if(!program.shaders.has(s)) return fail(c, GL.INVALID_OPERATION);
        program.shaders.delete(s);
        if(--shader.attached === 0 && shader.deleted) c.group.objects.delete(s);
    },
    "glBindAttribLocation": (shadow, c, [p, index, name]) =>
    {
        const program = object_of(c, p, "program");
        if(!program) return REFUSED;
        if(index >= MAX_ATTRIBS) return fail(c, GL.INVALID_VALUE);
        const text = text_of(name);
        if(text.startsWith("gl_")) return fail(c, GL.INVALID_OPERATION);
        program.bindings.set(text, index);
    },
    "glLinkProgram": (shadow, c, [p]) =>
    {
        const program = object_of(c, p, "program");
        if(!program) return REFUSED;
        const shaders = [...program.shaders].map(s => c.group.objects.get(s));
        const shader = type => shaders.find(s => s.type === type);
        const vs = shader(GL.VERTEX_SHADER), fs = shader(GL.FRAGMENT_SHADER);
        const start = performance.now();
        program.info = shadow.link(program, shaders, c.api === 2);
        shadow.stats.compile_ms += performance.now() - start;
        // (what was linked: a snapshot links it again)
        program.link = { vs: vs && vs.compiled ? vs.compiled_source : null, fs: fs && fs.compiled ? fs.compiled_source : null,
            bindings: [...program.bindings] };
        if(shaders.some(s => s.compiled && s.compiled.glslang))
        {
            program.link.glslang = true;
            program.link.shaders = shaders.map(s => [s.type, s.compiled_source]);
            program.link.separable = !!program.separable;
            program.link.tf = program.tf_request || null;
            // (the page cannot link it again: its snapshot keeps the result)
            program.keep_info = !shadow.glslang;
        }
        program.linked_once = true;
        shadow.stats.linked++;
        if(!program.info.ok)
        {
            shadow.stats.link_failed++;
            if(shadow.stats.failures.length < 8) shadow.stats.failures.push(program.info.log);
        }
        program.values = initial_values(program.info);
    },
    "glValidateProgram": (shadow, c, [p]) =>
    {
        const program = object_of(c, p, "program");
        if(!program) return REFUSED;
        program.validated = program.info && program.info.ok ? 1 : 0;
    },
    "glUseProgram": (shadow, c, [p]) =>
    {
        if(p)
        {
            const program = object_of(c, p, "program");
            if(!program) return REFUSED;
            if(!program.info || !program.info.ok) return fail(c, GL.INVALID_OPERATION);
        }
        const old = c.program;
        c.program = p;
        const previous = old && c.group.objects.get(old);
        if(previous && previous.deleted && !shadow.program_in_use(old)) shadow.free_program(c.group, old);
    },
    "glReleaseShaderCompiler": () => {},
    "glGetShaderiv": (shadow, c, [name, pname, params]) =>
    {
        query(shadow);
        const shader = object_of(c, name, "shader");
        if(!shader) return;
        const log = shader.compiled ? shader.compiled.log : "";
        const values = {
            0x8B4F: shader.type, 0x8B80: shader.deleted ? 1 : 0, 0x8B81: shader.compiled && shader.compiled.ok ? 1 : 0,
            0x8B84: log ? new TextEncoder().encode(log).length + 1 : 0,
            0x8B88: shader.source ? new TextEncoder().encode(shader.source).length + 1 : 0,
        };
        if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
        put(params, [values[pname]], "i", "i");
    },
    "glGetShaderInfoLog": (shadow, c, [name, bufsize, length, log]) =>
    {
        query(shadow);
        if(bufsize < 0) { fail(c, GL.INVALID_VALUE); return; }
        const shader = object_of(c, name, "shader");
        if(!shader) return;
        put(length, [put_text(log, shader.compiled ? shader.compiled.log : "")], "i", "i");
    },
    "glGetShaderSource": (shadow, c, [name, bufsize, length, source]) =>
    {
        query(shadow);
        if(bufsize < 0) { fail(c, GL.INVALID_VALUE); return; }
        const shader = object_of(c, name, "shader");
        if(!shader) return;
        put(length, [put_text(source, shader.source || "")], "i", "i");
    },
    "glGetProgramiv": (shadow, c, [name, pname, params]) =>
    {
        query(shadow);
        const program = object_of(c, name, "program");
        if(!program) return;
        const info = program.info;
        const linked = info && info.ok;
        const longest = list => list.reduce((n, item) => Math.max(n, new TextEncoder().encode(item.name).length + 1), 0);
        const values = {
            0x8B80: program.deleted ? 1 : 0, 0x8B82: linked ? 1 : 0, 0x8B83: program.validated,
            0x8B84: info && info.log ? new TextEncoder().encode(info.log).length + 1 : 0, 0x8B85: program.shaders.size,
            0x8B86: linked ? info.uniforms.length : 0, 0x8B87: linked ? longest(info.uniforms) : 0,
            0x8B89: linked ? info.attributes.length : 0, 0x8B8A: linked ? longest(info.attributes) : 0,
        };
        if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
        put(params, [values[pname]], "i", "i");
    },
    "glGetProgramInfoLog": (shadow, c, [name, bufsize, length, log]) =>
    {
        query(shadow);
        if(bufsize < 0) { fail(c, GL.INVALID_VALUE); return; }
        const program = object_of(c, name, "program");
        if(!program) return;
        put(length, [put_text(log, program.info ? program.info.log : "")], "i", "i");
    },
    "glGetAttachedShaders": (shadow, c, [name, maxcount, count, shaders]) =>
    {
        query(shadow);
        if(maxcount < 0) { fail(c, GL.INVALID_VALUE); return; }
        const program = object_of(c, name, "program");
        if(!program) return;
        const list = [...program.shaders].slice(0, maxcount);
        put(count, [list.length], "i", "i");
        put(shaders, list, "i", "i");
    },
    "glGetActiveAttrib": (shadow, c, args) => get_active(shadow, c, args, "attributes"),
    "glGetActiveUniform": (shadow, c, args) => get_active(shadow, c, args, "uniforms"),
    "glGetAttribLocation": (shadow, c, [name, text]) =>
    {
        query(shadow);
        const program = object_of(c, name, "program");
        if(!program) return -1;
        if(!program.info || !program.info.ok) { fail(c, GL.INVALID_OPERATION); return -1; }
        const attribute = program.info.attributes.find(a => a.name === text_of(text));
        return attribute ? attribute.location : -1;
    },
    "glGetUniformLocation": (shadow, c, [name, text]) =>
    {
        query(shadow);
        const program = object_of(c, name, "program");
        if(!program) return -1;
        if(!program.info || !program.info.ok) { fail(c, GL.INVALID_OPERATION); return -1; }
        const location = program.info.locations.get(text_of(text));
        return location === undefined ? -1 : location;
    },
    "glGetUniformfv": (shadow, c, [name, location, params]) => get_uniform(shadow, c, name, location, params, "f"),
    "glGetUniformiv": (shadow, c, [name, location, params]) => get_uniform(shadow, c, name, location, params, "i"),
    "glUniform1f": uniform(1, "f", false), "glUniform2f": uniform(2, "f", false), "glUniform3f": uniform(3, "f", false),
    "glUniform4f": uniform(4, "f", false), "glUniform1i": uniform(1, "i", false), "glUniform2i": uniform(2, "i", false),
    "glUniform3i": uniform(3, "i", false), "glUniform4i": uniform(4, "i", false),
    "glUniform1fv": uniform(1, "f", true), "glUniform2fv": uniform(2, "f", true), "glUniform3fv": uniform(3, "f", true),
    "glUniform4fv": uniform(4, "f", true), "glUniform1iv": uniform(1, "i", true), "glUniform2iv": uniform(2, "i", true),
    "glUniform3iv": uniform(3, "i", true), "glUniform4iv": uniform(4, "i", true),
    "glUniformMatrix2fv": uniform(4, "m", true), "glUniformMatrix3fv": uniform(9, "m", true), "glUniformMatrix4fv": uniform(16, "m", true),
    // (no binary formats: GL_NUM_SHADER_BINARY_FORMATS is 0)
    "glShaderBinary": (shadow, c) => fail(c, GL.INVALID_ENUM),
    "glUnmapBufferOES": shadow => { query(shadow); return 1; },
};

/**
 * GLES 1.1's commands (src/gles/gles1_state.js), and the shared ones whose
 * rules differ: glEnable's texture targets are per unit, its client arrays
 * are glEnableClientState's (glIsEnabled answers both)
 */
const GLES1_HANDLERS = gles1_handlers(fail, query);

/** GLES 3.0's status of a framebuffer (gles3_state.js sets fn) */
const FRAMEBUFFER_STATUS3 = { fn: null };

/** GLES 3.x's handlers (gles3_state.js) over GLES 2.0's */
const GLES3_HANDLERS = gles3_handlers({
    fail, query, put, put_text, i32s, f32s, text_of, REFUSED, base: HANDLERS, framebuffer_status3: FRAMEBUFFER_STATUS3, new_texture,
    detach, keep_orphan, state_kind: pname => STATE_KIND.get(pname) || (INT64_STATE.has(pname) ? "i" : "i"),
    // (the default framebuffer's: the draw surface's configuration)
    framebuffer_bits: c => GLESShadow.prototype.framebuffer_bits.call(null, { framebuffer: 0, surface: c.surface }),
    extensions: () => EXTENSIONS_3,
    renderbuffer_info: format =>
    {
        const r = RENDERBUFFER_FORMATS.get(format);
        if(!r) return null;
        return { kind: r.depth && r.stencil ? "depth_stencil" : r.depth ? "depth" : r.stencil ? "stencil" : "unorm", bits: r.bits,
            value: format, format: r.color ? (r.bits[3] ? 0x1908 : 0x1907) : 0, types: [0x1401], renderable: true, sized: true };
    },
});

/** GLES 3.1's handlers (gles31_state.js) over GLES 3.0's */
const GLES31_HANDLERS = gles31_handlers({ fail, query, put, put_text, i32s, f32s, text_of, REFUSED, base: HANDLERS, initial_values }, GLES3_HANDLERS);

/** GL_EXTENSIONS of a GLES 3.x context, as glGetStringi counts them */
GLESShadow.prototype.extensions3 = function()
{
    return EXTENSIONS_3;
};

/** GL_IMPLEMENTATION_COLOR_READ_FORMAT and _TYPE of the read buffer, or null for none */
GLESShadow.prototype.read_info3 = function(c)
{
    if(!c.read_framebuffer) return [c.default_read_buffer === 0 ? 0x1908 : 0x1908, 0x1401];
    const fbo = c.framebuffers.get(c.read_framebuffer);
    const a = fbo.attachments.get(fbo.read_buffer);
    if(!a) return null;
    const rb = a.type === GL.RENDERBUFFER ? c.group.renderbuffers.get(a.name) : null;
    const texture = a.type === GL.RENDERBUFFER ? null : c.group.textures.get(a.name);
    const image = texture && texture.images.get(a.face * 32 + a.level);
    const format = rb ? rb.format : image ? image.internal || image.format : 0;
    const info = SIZED_INFO(format);
    if(!info || !info.types) return [0x1908, 0x1401];
    return [info.format, info.types[info.types.length > 1 && info.types[0] === 0x1401 ? 1 : 0]];
};
for(const [name, enable] of [["glEnable", true], ["glDisable", false]])
{
    GLES1_HANDLERS[name] = (shadow, c, [cap]) =>
    {
        if(cap === GL.TEXTURE_2D || cap === GL.TEXTURE_EXTERNAL_OES)
        {
            c.ff.texture_enabled[c.active_texture][cap] = enable;
            return undefined;
        }
        if(CLIENT_ARRAYS[cap]) return fail(c, GL.INVALID_ENUM);
        return HANDLERS[name](shadow, c, [cap]);
    };
}
GLES1_HANDLERS["glIsEnabled"] = (shadow, c, [cap]) =>
{
    const own = gles1_state_value(c, cap);
    if(own && own[1] === "b") { query(shadow); return own[0][0] ? 1 : 0; }
    return HANDLERS["glIsEnabled"](shadow, c, [cap]);
};

/** A draw of elements' checks; `indices` whether there are any (a buffer bound or the data sent) */
function draw_elements(shadow, c, mode, count, type, indices)
{
    if(!MODES.has(mode) || !INDEX_TYPES.has(type)) return fail(c, GL.INVALID_ENUM);
    if(count < 0) return fail(c, GL.INVALID_VALUE);
    if(!framebuffer_ok(shadow, c)) return REFUSED;
    return undefined;
}

function attrib_pointer(c, index, size, type, normalized, stride, buffer, offset)
{
    if(index >= MAX_ATTRIBS || size < 1 || size > 4 || stride < 0) return fail(c, GL.INVALID_VALUE);
    if(!ATTRIB_TYPES.has(type)) return fail(c, GL.INVALID_ENUM);
    Object.assign(c.attribs[index], { size, type, normalized: !!normalized, stride, buffer, offset });
    return undefined;
}

function tex_parameter(c, target, pname, params)
{
    const texture = bound_texture(c, target);
    if(!texture) return REFUSED;
    const value = params[0];
    const external = target === GL.TEXTURE_EXTERNAL_OES;
    switch(pname)
    {
        case GL.TEXTURE_MIN_FILTER:
            if(!MIN_FILTERS.has(value) || external && value !== GL.NEAREST && value !== GL.LINEAR) return fail(c, GL.INVALID_ENUM);
            texture.min_filter = value;
            return undefined;
        case GL.TEXTURE_MAG_FILTER:
            if(value !== GL.NEAREST && value !== GL.LINEAR) return fail(c, GL.INVALID_ENUM);
            texture.mag_filter = value;
            return undefined;
        case GL.TEXTURE_WRAP_S: case GL.TEXTURE_WRAP_T:
            if(!WRAPS.has(value) || external && value !== GL.CLAMP_TO_EDGE) return fail(c, GL.INVALID_ENUM);
            if(pname === GL.TEXTURE_WRAP_S) texture.wrap_s = value;
            else texture.wrap_t = value;
            return undefined;
        case GL.GENERATE_MIPMAP:
            if(c.api !== 1) return fail(c, GL.INVALID_ENUM);
            texture.generate_mipmap = value ? 1 : 0;
            return undefined;
        case GL.TEXTURE_CROP_RECT_OES:
            if(c.api !== 1) return fail(c, GL.INVALID_ENUM);
            texture.crop = params.slice(0, 4);
            return undefined;
    }
    return fail(c, GL.INVALID_ENUM);
}

function get_tex_parameter(shadow, c, target, pname, params, as)
{
    query(shadow);
    const texture = bound_texture(c, target);
    if(!texture) return;
    const values = {
        [GL.TEXTURE_MIN_FILTER]: [texture.min_filter], [GL.TEXTURE_MAG_FILTER]: [texture.mag_filter],
        [GL.TEXTURE_WRAP_S]: [texture.wrap_s], [GL.TEXTURE_WRAP_T]: [texture.wrap_t],
    };
    if(c.api === 1)
    {
        values[GL.GENERATE_MIPMAP] = [texture.generate_mipmap];
        values[GL.TEXTURE_CROP_RECT_OES] = texture.crop;
    }
    if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
    put(params, values[pname], as, "i");
}

function get_vertex_attrib(shadow, c, index, pname, params, as)
{
    query(shadow);
    if(index >= MAX_ATTRIBS) { fail(c, GL.INVALID_VALUE); return; }
    const a = c.attribs[index];
    const values = {
        0x8622: [a.enabled ? 1 : 0], 0x8623: [a.size], 0x8624: [a.stride], 0x8625: [a.type], 0x886A: [a.normalized ? 1 : 0],
        0x889F: [a.buffer], 0x8626: a.current,
    };
    if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
    put(params, values[pname], as, pname === 0x8626 ? "f" : "i");
}

function get_active(shadow, c, [name, index, bufsize, length, size, type, text], list)
{
    query(shadow);
    const program = object_of(c, name, "program");
    if(!program) return;
    const items = program.info && program.info.ok ? program.info[list] : [];
    if(index >= items.length || bufsize < 0) { fail(c, GL.INVALID_VALUE); return; }
    const item = items[index];
    put(length, [put_text(text, item.name)], "i", "i");
    put(size, [item.size], "i", "i");
    put(type, [item.type], "i", "i");
}

function get_uniform(shadow, c, name, location, params, as)
{
    query(shadow);
    const program = object_of(c, name, "program");
    if(!program) return;
    if(!program.info || !program.info.ok) { fail(c, GL.INVALID_OPERATION); return; }
    const at = program.info.by_location[location];
    if(!at) { fail(c, GL.INVALID_OPERATION); return; }
    const u = at.uniform;
    const count = u.columns ? u.columns * u.columns : u.components;
    const values = program.values.get(location) || new Array(count).fill(0);
    put(params, values, as, u.int || u.bool ? "i" : "f");
}

/**
 * rcBindTexture and rcBindRenderbuffer: a color buffer becomes the image
 * of the context's bound 2D texture (level 0) or renderbuffer
 * @param {number} handle the context
 * @param {number} color_buffer
 * @param {boolean} texture
 * @return {boolean} whether there was something to bind it to
 */
GLESShadow.prototype.bind_color_buffer = function(handle, color_buffer, texture)
{
    const c = this.contexts.get(handle);
    const cb = this.rc && this.rc.color_buffers.get(color_buffer);
    if(!c || !cb) return false;
    const format = cb.format === GL.RGB ? GL.RGB : GL.RGBA;
    if(texture)
    {
        const t = bound_texture(c, GL.TEXTURE_2D);
        t.images.clear();
        t.images.set(0, { width: cb.width, height: cb.height, format, type: GL.UNSIGNED_BYTE, compressed: false, color_buffer });
        return true;
    }
    const rb = c.group.renderbuffers.get(c.renderbuffer);
    if(!rb) return false;
    Object.assign(rb, { width: cb.width, height: cb.height, format: format === GL.RGB ? GL.RGB8_OES : GL.RGBA8_OES, image: 0 });
    return true;
};

/** Whether a program is current in any context of the shadow */
GLESShadow.prototype.program_in_use = function(name)
{
    for(const context of this.contexts.values()) if(context.program === name) return true;
    return false;
};

/** A program goes: its shaders lose an attachment */
GLESShadow.prototype.free_program = function(group, name)
{
    const program = group.objects.get(name);
    if(!program) return;
    for(const s of program.shaders)
    {
        const shader = group.objects.get(s);
        if(shader && --shader.attached === 0 && shader.deleted) group.objects.delete(s);
    }
    group.objects.delete(name);
};

/**
 * An EGL image's size and format: its color buffer's (renderControl's)
 * @param {number} image
 * @return {?{width: number, height: number, format: number}}
 */
GLESShadow.prototype.image_size = function(image)
{
    if(!this.rc) return null;
    const object = this.rc.images.get(image);
    if(!object) return null;
    const cb = this.rc.color_buffers.get(object.buffer);
    if(!cb) return null;
    return { width: cb.width, height: cb.height, format: cb.format === GL.RGB ? GL.RGB : GL.RGBA };
};

/** @param {string} name @return {boolean} whether the shadow state follows the call */
export function shadow_handles(name)
{
    return Object.prototype.hasOwnProperty.call(HANDLERS, name) || Object.prototype.hasOwnProperty.call(HANDLERS, name.replace(/OES$/, ""));
}
