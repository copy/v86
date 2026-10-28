// A GLSL ES program linked with glslang (docs/gles3-plan.md, "着色器的数据流"):
// GL's view of it from the check pass (the active attributes, uniforms and
// blocks with GL's names, types and sizes; the locations, by GL's rules),
// and each stage's SPIR-V from the code pass with the interface and the
// bindings the host decides:
// - vertex inputs at their attribute locations (layout(location), else
//   glBindAttribLocation, else the lowest free);
// - each stage's outputs and the next stage's inputs at the same
//   locations, by name, unless the shaders place them;
// - resources in group 0: the default uniform block at 0, samplers from 1,
//   uniform blocks from 17, shader storage blocks from 42, atomic counter
//   blocks from 60 (by binding point), images from 70. vx_naga makes
//   binding b WGSL's 2b (2b + 1 for a combined sampler's sampler).
// The result has the shape glsl_es.js's link_program gives the shadow
// (ProgramInfo), with `spirv`, `blocks` and `bindings` added.

import { STAGE } from "./glslang.js";
import { rewrite_for_spirv } from "./glsl_es_rewrite.js";
import { DECORATION, EXECUTION_MODEL, STORAGE, add_xfb, block_layout, get_decoration, is_builtin, location_count, parse_spirv,
    set_decoration, variable_name } from "./spirv_patch.js";

export const BINDING = { DEFAULT_BLOCK: 0, SAMPLERS: 1, UNIFORM_BLOCKS: 17, STORAGE_BLOCKS: 42, ATOMIC_COUNTERS: 60, IMAGES: 70 };

/** GL's uniform types: components, matrix columns and rows, base, and the opaque kinds */
const TYPES = new Map();
for(const [base, enums] of [["float", [0x1406, 0x8B50, 0x8B51, 0x8B52]], ["int", [0x1404, 0x8B53, 0x8B54, 0x8B55]],
    ["uint", [0x1405, 0x8DC6, 0x8DC7, 0x8DC8]], ["bool", [0x8B56, 0x8B57, 0x8B58, 0x8B59]]])
{
    enums.forEach((e, i) => TYPES.set(e, { base, components: i + 1, columns: 0, rows: i + 1 }));
}
for(const [e, columns, rows] of [[0x8B5A, 2, 2], [0x8B5B, 3, 3], [0x8B5C, 4, 4], [0x8B65, 2, 3], [0x8B66, 2, 4], [0x8B67, 3, 2],
    [0x8B68, 3, 4], [0x8B69, 4, 2], [0x8B6A, 4, 3]])
{
    TYPES.set(e, { base: "float", components: columns * rows, columns, rows });
}
const SAMPLERS = [0x8B5E, 0x8B5F, 0x8B60, 0x8B62, 0x8DC1, 0x8DC4, 0x8DC5, 0x8DCA, 0x8DCB, 0x8DCC, 0x8DCF, 0x8DD2, 0x8DD3, 0x8DD4,
    0x8DD7, 0x8D66, 0x9108, 0x9109, 0x910A, 0x900C, 0x900D, 0x900E, 0x900F, 0x8DC2, 0x8DD0, 0x8DD8, 0x910B, 0x910C, 0x910D];
const IMAGES = [0x904D, 0x904E, 0x9050, 0x9053, 0x9058, 0x9059, 0x905B, 0x905E, 0x9063, 0x9064, 0x9066, 0x9069, 0x9051, 0x905C,
    0x9067, 0x9054, 0x905F, 0x906A];
for(const e of SAMPLERS) TYPES.set(e, { base: "int", components: 1, columns: 0, rows: 1, opaque: "sampler" });
for(const e of IMAGES) TYPES.set(e, { base: "int", components: 1, columns: 0, rows: 1, opaque: "image" });
TYPES.set(0x92DB, { base: "uint", components: 1, columns: 0, rows: 1, opaque: "atomic" });

/** @param {number} type GL's @return {!Object} its TYPES entry */
export function gl_type(type)
{
    return TYPES.get(type) || { base: "float", components: 1, columns: 0, rows: 1 };
}

const STAGE_NAME = ["vertex", "tess_control", "tess_evaluation", "geometry", "fragment", "compute"];
const MODEL_OF_STAGE = [EXECUTION_MODEL.Vertex, EXECUTION_MODEL.TessellationControl, EXECUTION_MODEL.TessellationEvaluation,
    EXECUTION_MODEL.Geometry, EXECUTION_MODEL.Fragment, EXECUTION_MODEL.GLCompute];

/** @param {string} name GL's ("a[0].b") @param {!Map<string, string>} renames @return {string} the code pass's */
function renamed(name, renames)
{
    return name.replace(/[A-Za-z_][A-Za-z0-9_]*/g, id => renames.get(id) || id);
}

/** @param {string} name @return {string} without its last "[0]" */
function base_name(name)
{
    return name.endsWith("[0]") ? name.slice(0, -3) : name;
}

/**
 * Link a program's shaders
 * @param {!Object} glslang src/gles/glslang.js's Glslang
 * @param {!Array<{stage: string, source: string}>} shaders stage: STAGE_NAME's
 * @param {{bindings: (!Map<string, number>|undefined), separable: (boolean|undefined),
 *     limits: {maxVaryingVectors: number, maxDrawBuffers: number}}} options bindings: glBindAttribLocation's
 * @return {!Object} ProgramInfo and spirv, blocks, bindings
 */
export function link_glslang_program(glslang, shaders, options)
{
    const empty = log => ({ ok: false, log, attributes: [], uniforms: [], locations: new Map(), by_location: [], reflection: null,
        blocks: [], bindings: [], spirv: [] });
    const flags = options.separable ? 1 : 0;
    let check;
    try
    {
        check = glslang.check_program(shaders.map(s => ({ stage: STAGE[s.stage], source: s.source })), flags);
    }
    catch(e)
    {
        return empty("ERROR: internal linker error: " + (e && e.message || e));
    }
    if(!check.ok) return empty(check.log || "ERROR: link failed");

    // the attributes: layout(location), else glBindAttribLocation's, else the lowest free
    const attributes = [];
    const used = new Set();
    const vertex_inputs = check.inputs.filter(i => !i.builtIn && (i.stages & 1 << STAGE.vertex));
    const span = i => Math.max(1, gl_type(i.type).columns) * Math.max(1, i.size);
    const take = (location, n) => { for(let k = 0; k < n; k++) used.add(location + k); };
    for(const i of vertex_inputs)
    {
        const bound = options.bindings && options.bindings.get(i.name);
        const location = i.location >= 0 ? i.location : bound !== undefined ? bound : -1;
        attributes.push({ name: i.name, size: Math.max(1, i.size), type: i.type, location });
        if(location >= 0) take(location, span(i));
    }
    for(const a of attributes)
    {
        if(a.location >= 0) continue;
        const n = span(vertex_inputs.find(i => i.name === a.name));
        let location = 0;
        while([...Array(n).keys()].some(k => used.has(location + k))) location++;
        a.location = location;
        take(location, n);
    }

    // the uniforms GL lists: the default block's, the blocks' members, the opaque ones
    const blocks = check.uniformBlocks.map((b, index) => ({ name: b.name, index, size: b.size, binding: b.binding >= 0 ? b.binding : 0,
        stages: b.stages, members: [] }));
    const uniforms = [];
    for(const u of check.uniforms)
    {
        const t = gl_type(u.type);
        const size = Math.max(1, u.size);
        const row_major = !!u.rowMajor;
        const matrix_stride = !t.columns ? 0 : u.packing === "std430" ? ((row_major ? t.columns : t.rows) === 2 ? 8 : 16) : 16;
        uniforms.push({
            name: u.name, base: base_name(u.name), size, type: u.type, location: -1, explicit_location: u.location,
            components: t.components, columns: t.columns, rows: t.rows, sampler: t.opaque === "sampler", opaque: t.opaque || null,
            int: t.base !== "float", bool: t.base === "bool", uint: t.base === "uint", block_index: u.index, offset: u.offset,
            array_stride: u.arrayStride, matrix_stride, row_major, binding: u.binding, stages: u.stages,
        });
        if(u.index >= 0 && blocks[u.index]) blocks[u.index].members.push(uniforms.length - 1);
    }
    // layout(location) on uniforms: GL refuses two at one location even
    // when they are not active, which the reflection leaves out
    const declared = new Map();
    for(const s of shaders)
    {
        const pattern = /layout\s*\(([^)]*)\)\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?/g;
        for(let m; (m = pattern.exec(s.source));)
        {
            const at = /\blocation\s*=\s*(\d+)/.exec(m[1]);
            if(!at) continue;
            const location = +at[1], size = m[3] ? +m[3] : 1;
            for(let i = 0; i < size; i++)
            {
                const owner = declared.get(location + i);
                if(owner !== undefined && owner !== m[2] + "[" + i + "]")
                {
                    return empty("ERROR: uniform location " + (location + i) + " is used by two uniforms");
                }
                declared.set(location + i, m[2] + "[" + i + "]");
            }
        }
    }
    // locations: the default block's and the opaque uniforms; layout(location) first
    const taken = new Set();
    const default_uniforms = uniforms.filter(u => u.block_index < 0 && u.opaque !== "atomic");
    for(const u of default_uniforms)
    {
        if(u.explicit_location < 0) continue;
        u.location = u.explicit_location;
        for(let i = 0; i < u.size; i++)
        {
            // (two uniforms at one location: a link error, which glslang leaves to GL)
            if(taken.has(u.location + i)) return empty("ERROR: uniform location " + (u.location + i) + " is used by two uniforms");
            taken.add(u.location + i);
        }
    }
    let next = 0;
    for(const u of default_uniforms)
    {
        if(u.location >= 0) continue;
        while([...Array(u.size).keys()].some(k => taken.has(next + k))) next++;
        u.location = next;
        for(let i = 0; i < u.size; i++) taken.add(next + i);
        next += u.size;
    }
    const locations = new Map();
    const by_location = [];
    for(const u of default_uniforms)
    {
        locations.set(u.base, u.location);
        for(let i = 0; i < u.size; i++)
        {
            if(u.size > 1 || u.name !== u.base) locations.set(u.base + "[" + i + "]", u.location + i);
            by_location[u.location + i] = { uniform: u, element: i };
        }
    }

    // the code pass
    const rewritten = shaders.map(s => rewrite_for_spirv(s.source, s.stage, options.limits));
    const renames = new Map();
    for(const r of rewritten) for(const [from, to] of r.renames) renames.set(from, to);
    let code;
    try
    {
        code = glslang.program_spirv(shaders.map((s, i) => ({ stage: STAGE[s.stage], source: rewritten[i].source })), flags);
    }
    catch(e)
    {
        return empty("ERROR: internal compiler error: " + (e && e.message || e));
    }
    if(!code.ok) return empty("ERROR: internal compiler error (SPIR-V): " + code.log);

    // the default block's layout: each uniform's offset and strides in it,
    // from the SPIR-V (the code pass's reflection differs from it); the
    // block is the same in every stage (glslang merges it when linking)
    const default_block = code.uniformBlocks.findIndex(b => b.name === "gl_DefaultUniformBlock");
    const layout = new Map();
    for(const module of code.modules)
    {
        const words = new Uint32Array(module.words);
        for(const [name, leaf] of block_layout(words, parse_spirv(words), "gl_DefaultUniformBlock")) layout.set(name, leaf);
    }
    for(const u of default_uniforms)
    {
        if(u.opaque) continue;
        const leaf = layout.get(renamed(u.name, renames));
        if(!leaf) continue;
        u.offset = leaf.offset;
        u.array_stride = leaf.array_stride;
        u.matrix_stride = leaf.matrix_stride;
    }

    // the resources' bindings
    const bindings = [{ binding: BINDING.DEFAULT_BLOCK, kind: "default", size: default_block >= 0 ? code.uniformBlocks[default_block].size : 0 }];
    // samplers and images: one binding a SPIR-V variable, the same in every
    // stage (an array in a struct is a variable an element there)
    const gl_names = new Map([...renames].map(([from, to]) => [to, from]));
    const gl_name = name => name.replace(/[A-Za-z_][A-Za-z0-9_]*/g, id => gl_names.get(id) || id);
    const opaque = new Map();
    let next_sampler = BINDING.SAMPLERS, next_image = BINDING.IMAGES;
    const opaque_binding = (name, image) =>
    {
        if(opaque.has(name)) return opaque.get(name);
        const gl = gl_name(name);
        const location = locations.has(gl) ? locations.get(gl) : -1;
        const at = by_location[location];
        const binding = image ? next_image++ : next_sampler++;
        opaque.set(name, binding);
        bindings.push({ binding, kind: image ? "image" : "sampler", location, size: at && gl === at.uniform.base ? at.uniform.size : 1,
            type: at ? at.uniform.type : 0, unit: at && image ? at.uniform.binding : undefined });
        return binding;
    };
    blocks.forEach((b, i) => bindings.push({ binding: BINDING.UNIFORM_BLOCKS + i, kind: "uniform_block", block: i, size: b.size }));
    const storage_blocks = check.bufferBlocks.map((b, index) => ({ name: b.name, index, size: b.size, binding: b.binding >= 0 ? b.binding : 0 }));
    storage_blocks.forEach((b, i) => bindings.push({ binding: BINDING.STORAGE_BLOCKS + i, kind: "storage_block", block: i, size: b.size }));

    // each stage's SPIR-V with them; the vertex inputs GL does not list
    // (unused: the draw gives them (0, 0, 0, 1)) at locations of their own
    const spirv = [];
    const unused_inputs = [];
    const stages = code.modules.map(m => m.stage).sort((a, b) => a - b);
    /** @type {!Map<string, number>} the previous stage's outputs' locations, by name */
    let previous = null;
    const explicit_io = shaders.some(s => /\blayout\s*\([^)]*\blocation\b[^)]*\)\s*(?:(?:flat|smooth|centroid|highp|mediump|lowp|invariant|patch)\s+)*(?:in|out)\b/.test(s.source));
    for(const stage of stages)
    {
        const module = code.modules.find(m => m.stage === stage);
        const words = new Uint32Array(module.words);
        const m = parse_spirv(words);
        const arrayed_inputs = stage === STAGE.tess_control || stage === STAGE.tess_evaluation || stage === STAGE.geometry;
        const arrayed_outputs = stage === STAGE.tess_control;
        const count = (v, arrayed) =>
        {
            let t = m.types.get(m.types.get(v.type).pointee);
            const id = arrayed && t.kind === "array" ? t.element : m.types.get(v.type).pointee;
            return location_count(m, id);
        };
        const outputs = new Map();
        let next_output = 0;
        for(const v of m.variables)
        {
            const name = variable_name(m, v);
            if(v.storage === STORAGE.Input && !is_builtin(m, v))
            {
                if(stage === STAGE.vertex)
                {
                    const gl = [...renames].find(([, to]) => to === name);
                    const a = attributes.find(x => x.name === (gl ? gl[0] : name));
                    if(a) set_decoration(words, m, v.id, DECORATION.Location, a.location);
                    else
                    {
                        const pointee = m.types.get(v.type).pointee;
                        const n = location_count(m, pointee);
                        let location = 0;
                        while([...Array(n).keys()].some(k => used.has(location + k))) location++;
                        take(location, n);
                        set_decoration(words, m, v.id, DECORATION.Location, location);
                        // (each location's: a matrix's columns, an array's elements)
                        let t = m.types.get(pointee);
                        while(t && t.kind === "array") t = m.types.get(t.element);
                        if(t && t.kind === "matrix") t = m.types.get(t.column);
                        const scalar = t && t.kind === "vector" ? m.types.get(t.component) : t;
                        const kind = scalar && scalar.kind === "int" ? (scalar.signed ? "i" : "u") : "f";
                        for(let k = 0; k < n; k++) unused_inputs.push({ location: location + k, kind, components: t && t.kind === "vector" ? t.size : 1 });
                    }
                }
                else if(!explicit_io && previous && previous.has(name))
                {
                    set_decoration(words, m, v.id, DECORATION.Location, previous.get(name));
                }
            }
            else if(v.storage === STORAGE.Output && !is_builtin(m, v) && stage !== STAGE.fragment)
            {
                if(!explicit_io)
                {
                    set_decoration(words, m, v.id, DECORATION.Location, next_output);
                    outputs.set(name, next_output);
                    next_output += count(v, arrayed_outputs);
                }
                else outputs.set(name, get_decoration(words, m, v.id, DECORATION.Location));
            }
            else if(v.storage === STORAGE.Uniform || v.storage === STORAGE.UniformConstant || v.storage === STORAGE.StorageBuffer)
            {
                let binding;
                let inner = m.types.get(m.types.get(v.type).pointee);
                while(inner && (inner.kind === "array" || inner.kind === "runtime_array")) inner = m.types.get(inner.element);
                if(name === "gl_DefaultUniformBlock") binding = BINDING.DEFAULT_BLOCK;
                else if(inner && (inner.kind === "sampled_image" || inner.kind === "sampler")) binding = opaque_binding(name, false);
                else if(inner && inner.kind === "image") binding = opaque_binding(name, inner.sampled === 2);
                else if(/^gl_AtomicCounterBlock/.test(name))
                {
                    binding = BINDING.ATOMIC_COUNTERS + (+(/_(\d+)$/.exec(name) || [0, 0])[1]);
                    if(!bindings.some(b => b.binding === binding)) bindings.push({ binding, kind: "atomic_counters", unit: binding - BINDING.ATOMIC_COUNTERS });
                }
                else
                {
                    const block = blocks.findIndex(b => renamed(b.name, renames) === name || b.name === name);
                    const storage = storage_blocks.findIndex(b => renamed(b.name, renames) === name || b.name === name);
                    if(block >= 0) binding = BINDING.UNIFORM_BLOCKS + block;
                    else if(storage >= 0) binding = BINDING.STORAGE_BLOCKS + storage;
                }
                if(binding !== undefined)
                {
                    // (a separable program's fragment stage in set 1: a pipeline's vertex and fragment programs each have a set,
                    // their default blocks the same binding)
                    set_decoration(words, m, v.id, DECORATION.DescriptorSet, options.separable && stage === STAGE.fragment ? 1 : 0);
                    set_decoration(words, m, v.id, DECORATION.Binding, binding);
                }
            }
        }
        void arrayed_inputs;
        previous = outputs;
        spirv.push({ stage: STAGE_NAME[stage], words, model: MODEL_OF_STAGE[stage] });
    }

    // transform feedback's varyings: outputs of the last stage before the
    // fragment shader, whole (or gl_Position, gl_PointSize)
    let tf_varyings = [];
    if(options.tf && options.tf.names.length)
    {
        const last = spirv.filter(m => m.stage !== "fragment" && m.stage !== "compute").pop();
        const m = last && parse_spirv(last.words);
        let components = 0;
        for(const name of options.tf.names)
        {
            const v = m && varying_of(m, renamed(name, renames), name);
            if(!v) return empty("ERROR: transform feedback varying " + name + " is not an output of the vertex shader");
            if(tf_varyings.some(x => x.name === name)) return empty("ERROR: transform feedback varying " + name + " is named twice");
            components += v.components * v.size;
            if(options.tf.mode === 0x8C8D && v.components * v.size > 4) return empty("ERROR: " + name + " has too many components to capture alone");
            tf_varyings.push(v);
        }
        if(options.tf.mode === 0x8C8C && components > 64) return empty("ERROR: too many components to capture interleaved");
        // (the decorations the page's capture reads: interleaved into buffer 0, else each into its own)
        const interleaved = options.tf.mode === 0x8C8C;
        const stride = tf_varyings.reduce((n, v) => n + v.bytes, 0);
        let offset = 0;
        last.words = add_xfb(last.words, tf_varyings.map((v, i) =>
        {
            const capture = { name: v.name.startsWith("gl_") ? v.name : renamed(v.name, renames), buffer: interleaved ? 0 : i,
                offset: interleaved ? offset : 0, stride: interleaved ? stride : v.bytes };
            offset += v.bytes;
            return capture;
        }));
    }

    const geometry_module = spirv.find(m => m.stage === "geometry");
    return { ok: true, log: check.log, attributes, uniforms, locations, by_location, reflection: check, blocks, storage_blocks,
        bindings, spirv, renames, local_size: check.localSize, default_block_size: bindings[0].size, tf_varyings,
        tf_mode: options.tf ? options.tf.mode : 0x8C8C, outputs: check.outputs, geometry: geometry_module ? geometry_layout(geometry_module.words) : null,
        unused_inputs };
}

/**
 * A geometry shader's layout from its SPIR-V's execution modes, as GL's
 * program queries answer it: the input and output primitive types (GL's
 * enums), max_vertices and invocations
 * @param {!Uint32Array} words
 * @return {{input: number, output: number, vertices: number, invocations: number}}
 */
export function geometry_layout(words)
{
    const layout = { input: 0x0004, output: 0x0005, vertices: 0, invocations: 1 };
    const INPUT = { 19: 0x0000, 20: 0x0001, 21: 0x000A, 22: 0x0004, 23: 0x000C };
    const OUTPUT = { 27: 0x0000, 28: 0x0003, 29: 0x0005 };
    for(let at = 5; at < words.length;)
    {
        const count = words[at] >>> 16;
        if(!count) break;
        // (OpExecutionMode: the entry point, the mode, its operand)
        if((words[at] & 0xFFFF) === 16 && count >= 3)
        {
            const mode = words[at + 2];
            if(mode in INPUT) layout.input = INPUT[mode];
            else if(mode in OUTPUT) layout.output = OUTPUT[mode];
            else if(mode === 26) layout.vertices = words[at + 3];
            else if(mode === 0) layout.invocations = words[at + 3];
        }
        at += count;
    }
    return layout;
}

/** SPIR-V's numeric types as GL's: the base's enums of 1 to 4 components, matrices by [columns][rows] */
const GL_OF = { float: [0x1406, 0x8B50, 0x8B51, 0x8B52], int: [0x1404, 0x8B53, 0x8B54, 0x8B55], uint: [0x1405, 0x8DC6, 0x8DC7, 0x8DC8],
    bool: [0x8B56, 0x8B57, 0x8B58, 0x8B59] };
const GL_MATRICES = { 2: { 2: 0x8B5A, 3: 0x8B65, 4: 0x8B66 }, 3: { 2: 0x8B67, 3: 0x8B5B, 4: 0x8B68 }, 4: { 2: 0x8B69, 3: 0x8B6A, 4: 0x8B5C } };

/** An output of a module as a transform feedback varying (type, size, components, bytes), or null */
function varying_of(m, name, gl_name)
{
    const builtin = { gl_Position: [0x8B52, 4], gl_PointSize: [0x1406, 1] }[gl_name];
    if(builtin) return { name: gl_name, type: builtin[0], size: 1, components: builtin[1], bytes: 4 * builtin[1] };
    const v = m.variables.find(x => x.storage === STORAGE.Output && variable_name(m, x) === name && !is_builtin(m, x));
    if(!v) return null;
    let t = m.types.get(m.types.get(v.type).pointee), size = 1;
    if(t.kind === "array") { size = m.constants.get(t.length_id) || 1; t = m.types.get(t.element); }
    const scalar = id => { const s = m.types.get(id); return s.kind === "float" ? "float" : s.kind === "bool" ? "bool" : s.signed ? "int" : "uint"; };
    let type, components;
    if(t.kind === "matrix")
    {
        const column = m.types.get(t.column);
        type = GL_MATRICES[t.columns][column.size];
        components = t.columns * column.size;
    }
    else if(t.kind === "vector") { type = GL_OF[scalar(t.component)][t.size - 1]; components = t.size; }
    else if(t.kind === "struct") return null;
    else { type = GL_OF[t.kind === "float" ? "float" : t.kind === "bool" ? "bool" : t.signed ? "int" : "uint"][0]; components = 1; }
    return { name: gl_name, type, size, components, bytes: 4 * components * size };
}

/** What of a link's result the page needs (it has no glslang): the GL view, the bindings, the SPIR-V */
const PACKED_FIELDS = ["ok", "log", "attributes", "uniforms", "blocks", "storage_blocks", "bindings", "local_size", "default_block_size",
    "tf_varyings", "tf_mode", "outputs", "geometry", "unused_inputs"];

/**
 * A link's result as bytes (GLES.PROGRAM_LINK's): a u32 JSON length, the
 * JSON, padding to 4, then each stage's u32 word count and words
 * @param {!Object} info link_glslang_program's
 * @return {!Uint8Array}
 */
export function pack_program(info)
{
    const json = new TextEncoder().encode(JSON.stringify(Object.assign(Object.fromEntries(PACKED_FIELDS.map(f => [f, info[f]])),
        { stages: info.spirv.map(m => [m.stage, m.model]) })));
    const head = 4 + (json.length + 3 & ~3);
    const bytes = new Uint8Array(head + info.spirv.reduce((n, m) => n + 4 + 4 * m.words.length, 0));
    const view = new DataView(bytes.buffer);
    view.setUint32(0, json.length, true);
    bytes.set(json, 4);
    let at = head;
    for(const m of info.spirv)
    {
        view.setUint32(at, m.words.length, true);
        bytes.set(new Uint8Array(m.words.buffer, m.words.byteOffset, m.words.byteLength), at + 4);
        at += 4 + 4 * m.words.length;
    }
    return bytes;
}

/**
 * pack_program's bytes as the result again (the locations' maps made anew)
 * @param {!Uint8Array} bytes
 * @return {!Object}
 */
export function unpack_program(bytes)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(0, true);
    const info = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
    let at = 4 + (length + 3 & ~3);
    info.spirv = info.stages.map(([stage, model]) =>
    {
        const count = view.getUint32(at, true);
        const words = new Uint32Array(bytes.slice(at + 4, at + 4 + 4 * count).buffer);
        at += 4 + 4 * count;
        return { stage, model, words };
    });
    delete info.stages;
    info.locations = new Map();
    info.by_location = [];
    for(const u of info.uniforms)
    {
        if(u.location < 0) continue;
        info.locations.set(u.base, u.location);
        for(let i = 0; i < u.size; i++)
        {
            if(u.size > 1 || u.name !== u.base) info.locations.set(u.base + "[" + i + "]", u.location + i);
            info.by_location[u.location + i] = { uniform: u, element: i };
        }
    }
    return info;
}
