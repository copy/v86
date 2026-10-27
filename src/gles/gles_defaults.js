// E1's answers to GLESv1 and GLESv2 (docs/gles-proxy-plan.md, E1): the
// calls are decoded and counted, not drawn, and every call the guest waits
// on gets a legal default answer, or its thread would hang: names counted
// up per share group, compiles and links succeed, framebuffers are
// complete, glGetError is GL_NO_ERROR, queries give the implementation's
// limits and the state's initial values (gles_caps.js). What the queries
// see is followed only as far as that takes (enables, bindings, viewport,
// buffer and renderbuffer sizes, attachments, shader sources). E2's shadow
// state (src/gles/gles_shadow.js) replaces this.

import { COMPRESSED_TEXTURE_FORMATS, CONFIG_ATTRIBUTES, EGL, GL_ENABLED_INITIALLY, GL_STATE } from "./gles_caps.js";

const GL_FRAMEBUFFER_COMPLETE = 0x8CD5;
const GL_TEXTURE0 = 0x84C0;
const GL_TEXTURE_2D = 0x0DE1;
const GL_ARRAY_BUFFER = 0x8892;
const GL_TEXTURE = 0x1702;
const GL_RENDERBUFFER = 0x8D41;

/** The capabilities glEnable takes (GLES 2.0's and 1.1's), which glGet* also answers */
const CAPABILITIES = new Set([
    0x0B44, 0x0BE2, 0x0BD0, 0x8037, 0x809E, 0x80A0, 0x0C11, 0x0B90, 0x0B71, // GLES 2.0's
    0x0BC0, 0x0B50, 0x0B57, 0x0BA1, 0x0B60, 0x0BF2, 0x0B20, 0x0B10, 0x809D, 0x803A, 0x809F, 0x8861, 0x8513, // GLES 1.1's
    0x4000, 0x4001, 0x4002, 0x4003, 0x4004, 0x4005, 0x4006, 0x4007, 0x3000, 0x3001, 0x3002, 0x3003, 0x3004, 0x3005,
    0x8074, 0x8075, 0x8076, 0x8078, 0x8B9C, 0x8842, 0x86AD, 0x8D65,
]);

/** The bindings glGet* answers from what was bound: pname to the binding's key */
const BINDINGS = new Map([
    [0x8894, "array_buffer"], [0x8895, "element_array_buffer"], [0x8CA6, "framebuffer"], [0x8CA7, "renderbuffer"],
    [0x8B8D, "program"],
]);

/**
 * A share group's objects: names by kind (the live ones), shaders, programs, buffers, renderbuffers, framebuffers
 * @constructor
 */
function ShareGroup()
{
    /** @type {!Map<string, {next: number, live: !Set<number>}>} */
    this.names = new Map();
    /** @type {!Map<number, {type: number, source: string}>} */
    this.shaders = new Map();
    /** @type {!Map<number, {shaders: !Set<number>, uniforms: !Map<string, number>, attribs: !Map<string, number>}>} */
    this.programs = new Map();
    /** @type {!Map<number, {size: number, usage: number}>} */
    this.buffers = new Map();
    /** @type {!Map<number, {width: number, height: number, format: number}>} */
    this.renderbuffers = new Map();
    /** @type {!Map<number, !Map<number, {type: number, name: number, level: number}>>} each framebuffer's attachments */
    this.framebuffers = new Map();
}

/** @param {string} kind @return {{next: number, live: !Set<number>}} */
ShareGroup.prototype.kind = function(kind)
{
    let names = this.names.get(kind);
    if(!names) this.names.set(kind, names = { next: 1, live: new Set() });
    return names;
};

/** @param {string} kind @return {number} a new name */
ShareGroup.prototype.create = function(kind)
{
    const names = this.kind(kind);
    const name = names.next++;
    names.live.add(name);
    return name;
};

/**
 * A context's own state: enables, bindings, viewport and scissor box
 * @constructor
 */
function ContextState()
{
    this.enabled = new Set(GL_ENABLED_INITIALLY);
    this.active_texture = GL_TEXTURE0;
    /** @type {!Map<string, number>} */
    this.bound = new Map();
    /** @type {?Array<number>} until the first glViewport: the first draw surface's */
    this.viewport = null;
    /** @type {?Array<number>} */
    this.scissor = null;
}

/**
 * @constructor
 * @param {!Object} rc the RenderControl (src/gles/render_control.js): contexts, current surfaces
 */
export function GLESDefaults(rc)
{
    this.rc = rc;
    /** @type {!Map<number, !ShareGroup>} by the share group's first context */
    this.groups = new Map();
    /** @type {!WeakMap<!Object, !ContextState>} by renderControl's context */
    this.states = new WeakMap();
    /** a context-less call's state (a guest's bug; answered all the same) */
    this.none = { group: new ShareGroup(), state: new ContextState(), surface: null };
}

/**
 * The connection's current context: its share group, state and draw surface
 * @param {!Object} conn renderControl's connection
 * @return {{group: !ShareGroup, state: !ContextState, surface: ?{width: number, height: number, config: !Array<number>}}}
 */
GLESDefaults.prototype.current = function(conn)
{
    const context = this.rc.contexts.get(conn.context);
    if(!context) return this.none;
    const group_id = context.share || conn.context;
    let group = this.groups.get(group_id);
    if(!group) this.groups.set(group_id, group = new ShareGroup());
    let state = this.states.get(context);
    if(!state) this.states.set(context, state = new ContextState());
    return { group, state, surface: this.rc.draw_surface(conn) };
};

/** @param {?Uint8Array} bytes @return {!Array<number>} as u32s */
function u32s(bytes)
{
    if(!bytes) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = [];
    for(let at = 0; at + 4 <= bytes.length; at += 4) values.push(view.getUint32(at, true));
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
 * Values into an out buffer, as many as fit
 * @param {!Object} out an OutBuffer
 * @param {!Array<number>} values
 * @param {string} kind "i32", "u32", "f32", "fixed" or "u8" (booleans)
 */
function put(out, values, kind)
{
    const size = kind === "u8" ? 1 : 4;
    for(let i = 0; i < values.length && (i + 1) * size <= out.size; i++)
    {
        const v = values[i];
        if(kind === "u8") out.data[i] = v ? 1 : 0;
        else if(kind === "f32") out.view.setFloat32(4 * i, v, true);
        else if(kind === "fixed") out.view.setInt32(4 * i, Math.round(v * 65536), true);
        else out.view.setInt32(4 * i, Math.round(v), true);
    }
}

/** @param {!Object} out an OutBuffer @param {string} text written with its NUL as far as it fits @return {number} the length written */
function put_text(out, text)
{
    if(!out.size) return 0;
    const bytes = new TextEncoder().encode(text).subarray(0, out.size - 1);
    out.data.set(bytes);
    out.data[bytes.length] = 0;
    return bytes.length;
}

/**
 * glGet*'s value of a pname
 * @param {!Object} current
 * @param {number} pname
 * @return {!Array<number>}
 */
function state_value(current, pname)
{
    const { state, surface } = current;
    const config_value = attribute => surface ? surface.config[CONFIG_ATTRIBUTES.indexOf(attribute)] : 0;
    switch(pname)
    {
        case 0x0BA2: return state.viewport || (surface ? [0, 0, surface.width, surface.height] : [0, 0, 0, 0]); // GL_VIEWPORT
        case 0x0C10: return state.scissor || (surface ? [0, 0, surface.width, surface.height] : [0, 0, 0, 0]); // GL_SCISSOR_BOX
        case 0x0D52: return [config_value(EGL.RED_SIZE)];
        case 0x0D53: return [config_value(EGL.GREEN_SIZE)];
        case 0x0D54: return [config_value(EGL.BLUE_SIZE)];
        case 0x0D55: return [config_value(EGL.ALPHA_SIZE)];
        case 0x0D56: return [config_value(EGL.DEPTH_SIZE)];
        case 0x0D57: return [config_value(EGL.STENCIL_SIZE)];
        case 0x84E0: return [state.active_texture]; // GL_ACTIVE_TEXTURE
        case 0x8069: return [state.bound.get("texture:" + GL_TEXTURE_2D + ":" + state.active_texture) || 0]; // GL_TEXTURE_BINDING_2D
        case 0x8514: return [state.bound.get("texture:" + 0x8513 + ":" + state.active_texture) || 0]; // GL_TEXTURE_BINDING_CUBE_MAP
    }
    if(BINDINGS.has(pname)) return [state.bound.get(BINDINGS.get(pname)) || 0];
    if(GL_STATE.has(pname)) return GL_STATE.get(pname);
    if(CAPABILITIES.has(pname)) return [state.enabled.has(pname) ? 1 : 0];
    return [];
}

/** glGet*v by name: the value's kind */
const GETTERS = {
    "glGetBooleanv": "u8", "glGetIntegerv": "i32", "glGetFloatv": "f32", "glGetFixedv": "fixed", "glGetFixedvOES": "fixed",
};

/** The kinds of names by their commands' nouns */
const NAME_KINDS = {
    "Textures": "texture", "Buffers": "buffer", "Framebuffers": "framebuffer", "FramebuffersOES": "framebuffer",
    "Renderbuffers": "renderbuffer", "RenderbuffersOES": "renderbuffer", "VertexArraysOES": "vertex_array",
    "VertexArrays": "vertex_array", "Queries": "query", "Samplers": "sampler", "TransformFeedbacks": "transform_feedback",
    "ProgramPipelines": "program_pipeline", "FencesNV": "fence",
};

/**
 * The commands this answers or follows, by name: (current, args) to the
 * return value
 * @type {!Object<string, function(!Object, !Array<*>): *>}
 */
const HANDLERS = {
    "glGetError": () => 0,
    "glGetGraphicsResetStatusEXT": () => 0,
    "glFinishRoundTrip": () => 0,
    "glCheckFramebufferStatus": () => GL_FRAMEBUFFER_COMPLETE,
    "glCheckFramebufferStatusOES": () => GL_FRAMEBUFFER_COMPLETE,
    "glEnable": ({ state }, [cap]) => { state.enabled.add(cap); },
    "glDisable": ({ state }, [cap]) => { state.enabled.delete(cap); },
    "glIsEnabled": ({ state }, [cap]) => state.enabled.has(cap) ? 1 : 0,
    "glViewport": ({ state }, [x, y, width, height]) => { state.viewport = [x, y, width, height]; },
    "glScissor": ({ state }, [x, y, width, height]) => { state.scissor = [x, y, width, height]; },
    "glActiveTexture": ({ state }, [unit]) => { state.active_texture = unit; },
    "glBindTexture": ({ group, state }, [target, name]) =>
    {
        state.bound.set("texture:" + target + ":" + state.active_texture, name);
        if(name) group.kind("texture").live.add(name);
    },
    "glBindBuffer": ({ group, state }, [target, name]) =>
    {
        state.bound.set(target === GL_ARRAY_BUFFER ? "array_buffer" : "element_array_buffer", name);
        if(name) group.kind("buffer").live.add(name);
    },
    "glBufferData": ({ group, state }, [target, size, data, usage]) =>
    {
        const name = state.bound.get(target === GL_ARRAY_BUFFER ? "array_buffer" : "element_array_buffer");
        if(name) group.buffers.set(name, { size, usage });
    },
    "glBindFramebuffer": ({ group, state }, [target, name]) =>
    {
        state.bound.set("framebuffer", name);
        if(name) group.kind("framebuffer").live.add(name);
    },
    "glBindRenderbuffer": ({ group, state }, [target, name]) =>
    {
        state.bound.set("renderbuffer", name);
        if(name) group.kind("renderbuffer").live.add(name);
    },
    "glRenderbufferStorage": ({ group, state }, [target, format, width, height]) =>
    {
        const name = state.bound.get("renderbuffer");
        if(name) group.renderbuffers.set(name, { width, height, format });
    },
    "glFramebufferTexture2D": ({ group, state }, [target, attachment, textarget, texture, level]) =>
    {
        attach(group, state, attachment, texture ? { type: GL_TEXTURE, name: texture, level } : null);
    },
    "glFramebufferRenderbuffer": ({ group, state }, [target, attachment, rbtarget, renderbuffer]) =>
    {
        attach(group, state, attachment, renderbuffer ? { type: GL_RENDERBUFFER, name: renderbuffer, level: 0 } : null);
    },
    "glUseProgram": ({ state }, [program]) => { state.bound.set("program", program); },
    "glCreateShader": ({ group }, [type]) =>
    {
        const name = group.create("object");
        group.shaders.set(name, { type, source: "" });
        return name;
    },
    "glCreateProgram": ({ group }) =>
    {
        const name = group.create("object");
        group.programs.set(name, { shaders: new Set(), uniforms: new Map(), attribs: new Map() });
        return name;
    },
    "glDeleteShader": ({ group }, [name]) => { group.shaders.delete(name); group.kind("object").live.delete(name); },
    "glDeleteProgram": ({ group }, [name]) => { group.programs.delete(name); group.kind("object").live.delete(name); },
    "glIsShader": ({ group }, [name]) => group.shaders.has(name) ? 1 : 0,
    "glIsProgram": ({ group }, [name]) => group.programs.has(name) ? 1 : 0,
    "glShaderString": ({ group }, [name, string]) =>
    {
        const shader = group.shaders.get(name);
        if(shader) shader.source = text_of(string);
    },
    "glAttachShader": ({ group }, [program, shader]) => { group.programs.get(program)?.shaders.add(shader); },
    "glDetachShader": ({ group }, [program, shader]) => { group.programs.get(program)?.shaders.delete(shader); },
    "glBindAttribLocation": ({ group }, [program, index, name]) => { group.programs.get(program)?.attribs.set(text_of(name), index); },
    "glGetShaderiv": ({ group }, [name, pname, params]) =>
    {
        const shader = group.shaders.get(name);
        const value = {
            0x8B4F: shader ? shader.type : 0, // GL_SHADER_TYPE
            0x8B81: 1, // GL_COMPILE_STATUS
            0x8B88: shader && shader.source ? new TextEncoder().encode(shader.source).length + 1 : 0, // GL_SHADER_SOURCE_LENGTH
        }[pname] || 0;
        put(params, [value], "i32");
    },
    "glGetProgramiv": ({ group }, [name, pname, params]) =>
    {
        const program = group.programs.get(name);
        const value = {
            0x8B82: 1, 0x8B83: 1, // GL_LINK_STATUS, GL_VALIDATE_STATUS
            0x8B85: program ? program.shaders.size : 0, // GL_ATTACHED_SHADERS
        }[pname] || 0;
        put(params, [value], "i32");
    },
    "glGetShaderSource": ({ group }, [name, bufsize, length, source]) =>
    {
        const shader = group.shaders.get(name);
        put(length, [put_text(source, shader ? shader.source : "")], "i32");
    },
    "glGetShaderInfoLog": ({ group }, [name, bufsize, length, log]) => { put(length, [put_text(log, "")], "i32"); },
    "glGetProgramInfoLog": ({ group }, [name, bufsize, length, log]) => { put(length, [put_text(log, "")], "i32"); },
    "glGetAttachedShaders": ({ group }, [name, maxcount, count, shaders]) =>
    {
        const list = [...(group.programs.get(name)?.shaders || [])].slice(0, maxcount);
        put(count, [list.length], "i32");
        put(shaders, list, "u32");
    },
    // (a location per name, in the order asked for; attributes their bound ones first)
    "glGetUniformLocation": ({ group }, [name, text]) =>
    {
        const program = group.programs.get(name);
        if(!program) return -1;
        const key = text_of(text);
        if(!program.uniforms.has(key)) program.uniforms.set(key, program.uniforms.size);
        return program.uniforms.get(key);
    },
    "glGetAttribLocation": ({ group }, [name, text]) =>
    {
        const program = group.programs.get(name);
        if(!program) return -1;
        const key = text_of(text);
        if(!program.attribs.has(key))
        {
            const used = new Set(program.attribs.values());
            let index = 0;
            while(used.has(index)) index++;
            program.attribs.set(key, index);
        }
        return program.attribs.get(key);
    },
    "glGetShaderPrecisionFormat": (current, [shadertype, precisiontype, range, precision]) =>
    {
        // (floats: highp's IEEE single; ints: 32-bit)
        const float = precisiontype >= 0x8DF0 && precisiontype <= 0x8DF2;
        put(range, float ? [127, 127] : [31, 30], "i32");
        put(precision, [float ? 23 : 0], "i32");
    },
    "glGetCompressedTextureFormats": (current, [count, formats]) => { put(formats, COMPRESSED_TEXTURE_FORMATS, "i32"); },
    "glGetTexParameteriv": (current, [target, pname, params]) => { put(params, texture_parameter(pname), "i32"); },
    "glGetTexParameterfv": (current, [target, pname, params]) => { put(params, texture_parameter(pname), "f32"); },
    "glGetTexParameterxv": (current, [target, pname, params]) => { put(params, texture_parameter(pname), "i32"); },
    "glGetTexParameterxvOES": (current, [target, pname, params]) => { put(params, texture_parameter(pname), "i32"); },
    "glGetBufferParameteriv": ({ group, state }, [target, pname, params]) =>
    {
        const buffer = group.buffers.get(state.bound.get(target === GL_ARRAY_BUFFER ? "array_buffer" : "element_array_buffer"));
        put(params, [pname === 0x8764 ? buffer ? buffer.size : 0 : pname === 0x8765 ? buffer ? buffer.usage : 0x88E4 : 0], "i32");
    },
    "glGetRenderbufferParameteriv": ({ group, state }, [target, pname, params]) => { put(params, [renderbuffer_parameter(group, state, pname)], "i32"); },
    "glGetRenderbufferParameterivOES": ({ group, state }, [target, pname, params]) => { put(params, [renderbuffer_parameter(group, state, pname)], "i32"); },
    "glGetFramebufferAttachmentParameteriv": ({ group, state }, [target, attachment, pname, params]) =>
    {
        put(params, [attachment_parameter(group, state, attachment, pname)], "i32");
    },
    "glGetFramebufferAttachmentParameterivOES": ({ group, state }, [target, attachment, pname, params]) =>
    {
        put(params, [attachment_parameter(group, state, attachment, pname)], "i32");
    },
    "glGetVertexAttribfv": (current, [index, pname, params]) => { put(params, vertex_attrib(pname), "f32"); },
    "glGetVertexAttribiv": (current, [index, pname, params]) => { put(params, vertex_attrib(pname), "i32"); },
    "glUnmapBufferOES": () => 1,
    "glTestFenceNV": () => 1,
};

for(const [name, kind] of Object.entries(GETTERS))
{
    HANDLERS[name] = (current, [pname, params]) => { put(params, state_value(current, pname), kind); };
}

for(const [noun, kind] of Object.entries(NAME_KINDS))
{
    HANDLERS["glGen" + noun] = ({ group }, [n, names]) =>
    {
        const list = [];
        for(let i = 0; i < n && 4 * i + 4 <= names.size; i++) list.push(group.create(kind));
        put(names, list, "u32");
    };
    HANDLERS["glDelete" + noun] = ({ group }, [n, names]) =>
    {
        for(const name of u32s(names)) group.kind(kind).live.delete(name);
    };
    HANDLERS["glIs" + singular_of(noun)] = ({ group }, [name]) => group.kind(kind).live.has(name) ? 1 : 0;
}

/** "Textures" "Texture", "FramebuffersOES" "FramebufferOES", "Queries" "Query", "VertexArraysOES" "VertexArrayOES" */
function singular_of(noun)
{
    const m = /^(.*?)(ies|s)(OES|NV)?$/.exec(noun);
    return m ? m[1] + (m[2] === "ies" ? "y" : "") + (m[3] || "") : noun;
}

/** @param {number} pname @return {!Array<number>} a texture's initial parameter */
function texture_parameter(pname)
{
    switch(pname)
    {
        case 0x2801: return [0x2702]; // GL_TEXTURE_MIN_FILTER: GL_NEAREST_MIPMAP_LINEAR
        case 0x2800: return [0x2601]; // GL_TEXTURE_MAG_FILTER: GL_LINEAR
        case 0x2802: case 0x2803: return [0x2901]; // GL_TEXTURE_WRAP_S, _T: GL_REPEAT
    }
    return [0];
}

/** @return {number} the bound renderbuffer's parameter */
function renderbuffer_parameter(group, state, pname)
{
    const rb = group.renderbuffers.get(state.bound.get("renderbuffer"));
    switch(pname)
    {
        case 0x8D42: return rb ? rb.width : 0; // GL_RENDERBUFFER_WIDTH
        case 0x8D43: return rb ? rb.height : 0; // GL_RENDERBUFFER_HEIGHT
        case 0x8D44: return rb ? rb.format : 0x8056; // GL_RENDERBUFFER_INTERNAL_FORMAT: GL_RGBA4
    }
    return 0;
}

/** @param {!ShareGroup} group @param {!ContextState} state @param {number} attachment @param {?Object} what */
function attach(group, state, attachment, what)
{
    const fbo = state.bound.get("framebuffer");
    if(!fbo) return;
    let attachments = group.framebuffers.get(fbo);
    if(!attachments) group.framebuffers.set(fbo, attachments = new Map());
    if(what) attachments.set(attachment, what);
    else attachments.delete(attachment);
}

/** @return {number} the bound framebuffer's attachment's parameter */
function attachment_parameter(group, state, attachment, pname)
{
    const a = group.framebuffers.get(state.bound.get("framebuffer"))?.get(attachment);
    switch(pname)
    {
        case 0x8CD0: return a ? a.type : 0; // GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE
        case 0x8CD1: return a ? a.name : 0; // _OBJECT_NAME
        case 0x8CD2: return a ? a.level : 0; // _TEXTURE_LEVEL
    }
    return 0;
}

/** @param {number} pname @return {!Array<number>} an attribute's initial state */
function vertex_attrib(pname)
{
    switch(pname)
    {
        case 0x8626: return [0, 0, 0, 1]; // GL_CURRENT_VERTEX_ATTRIB
        case 0x8623: return [4]; // GL_VERTEX_ATTRIB_ARRAY_SIZE
        case 0x8625: return [0x1406]; // GL_VERTEX_ATTRIB_ARRAY_TYPE: GL_FLOAT
    }
    return [0];
}

/**
 * A GLESv1 or GLESv2 call
 * @param {!Object} conn renderControl's connection
 * @param {!Object} command (gles_wire.js)
 * @param {!Array<*>} args
 * @return {*} the return value (0 for what nothing here answers: out
 *     pointers stay zeros)
 */
GLESDefaults.prototype.call = function(conn, command, args)
{
    const handler = HANDLERS[command.name];
    return handler ? handler(this.current(conn), args) : 0;
};

/** @param {string} name @return {boolean} whether a handler answers or follows the call */
export function defaults_handle(name)
{
    return Object.prototype.hasOwnProperty.call(HANDLERS, name);
}
