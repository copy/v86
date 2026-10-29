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

import { GL_STATE } from "./gles_caps.js";
import { STAGE } from "./glslang.js";
import { BLEND_DESTINATION, blend_support, block_packings, glsl_version, rewrite_for_spirv, std_blocks } from "./glsl_es_rewrite.js";
import { DECORATION, EXECUTION_MODEL, OP, STORAGE, add_xfb, array_length, block_layout, get_decoration, innermost, is_builtin, location_count, parse_spirv,
    set_decoration, variable_name } from "./spirv_patch.js";

/** GL_MAX_VERTEX_ATTRIBS */
const MAX_VERTEX_ATTRIBS = GL_STATE.get(0x8869)[0];

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

/** @param {string} name a block's ("B[1]", "B[0][2]") @return {string} its instance array's ("B") */
function instance_array_name(name)
{
    return name.replace(/(?:\[\d+\])+$/, "");
}

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
    // (a block of other packings in two stages: refused before std_blocks makes shared and packed one)
    const packings = new Map();
    for(const s of shaders)
    {
        for(const [block, packing] of block_packings(s.source))
        {
            if(packings.has(block) && packings.get(block) !== packing) return empty("ERROR: Linking: the layouts of block " + block.split(":")[1] + " differ");
            packings.set(block, packing);
        }
    }
    // (shared and packed blocks as std140 and std430: the reflection's offsets, the code's and the page's agree; the check
    // pass's buffer blocks as they are, so that a shared one nothing uses stays active)
    const check_sources = shaders.map(s => std_blocks(s.source, false));
    shaders = shaders.map(s => Object.assign({}, s, { source: std_blocks(s.source) }));
    let check;
    try
    {
        check = glslang.check_program(shaders.map((s, i) => ({ stage: STAGE[s.stage], source: check_sources[i] })), flags);
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
    // (GL_MAX_VERTEX_ATTRIBS, a link error past it)
    if([...used].some(location => location >= MAX_VERTEX_ATTRIBS)) return empty("ERROR: the vertex shader's inputs need more than " + MAX_VERTEX_ATTRIBS + " locations");

    // the uniforms GL lists: the default block's, the blocks' members, the opaque ones
    const blocks = check.uniformBlocks.map((b, index) => ({ name: b.name, index, size: b.size, binding: element_binding(check.uniformBlocks, b),
        stages: b.stages, members: [] }));
    const uniforms = [];
    for(const u of check.uniforms)
    {
        const t = gl_type(u.type);
        const size = Math.max(1, u.size);
        // (a matrix's alone: GL's UNIFORM_IS_ROW_MAJOR of any other uniform is false, in a row_major block too)
        const row_major = !!u.rowMajor && !!t.columns;
        const matrix_stride = !t.columns ? 0 : u.packing === "std430" ? ((row_major ? t.columns : t.rows) === 2 ? 8 : 16) : 16;
        uniforms.push({
            name: u.name, base: base_name(u.name), size, type: u.type, location: -1, explicit_location: u.location,
            components: t.components, columns: t.columns, rows: t.rows, sampler: t.opaque === "sampler", opaque: t.opaque || null,
            int: t.base !== "float", bool: t.base === "bool", uint: t.base === "uint", block_index: u.index, offset: u.offset,
            array_stride: u.arrayStride, matrix_stride, row_major, binding: u.binding, stages: u.stages,
        });
        if(u.index >= 0 && blocks[u.index]) blocks[u.index].members.push(uniforms.length - 1);
    }
    // (an instance array's elements each have the array's members, which glslang gives its first element)
    for(const b of blocks)
    {
        const first = blocks.find(x => instance_array_name(x.name) === instance_array_name(b.name));
        if(first !== b && !b.members.length) b.members = first.members.slice();
    }
    // layout(location) on uniforms: GL refuses two at one location even
    // when they are not active, which the reflection leaves out
    // (the declarations with a location: glslang reflects none for a
    // struct's members, nor for a uniform with one in one stage only, and
    // each inner array of an array of arrays at the array's)
    const declared = new Map(), located = new Map();
    const structs = struct_declarations(shaders);
    for(const s of shaders)
    {
        const pattern = /(?:layout\s*\(([^)]*)\)\s*uniform|uniform\s+layout\s*\(([^)]*)\))\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*((?:\[\s*\d+\s*\])*)/g;
        for(let m; (m = pattern.exec(s.source));)
        {
            const at = /\blocation\s*=\s*(\d+)/.exec(m[1] || m[2]);
            if(!at) continue;
            const dims = (m[5].match(/\d+/g) || []).map(Number);
            const location = +at[1], size = dims.reduce((n, d) => n * d, 1) * uniform_locations(m[3], structs);
            located.set(m[4], { location, type: m[3], dims });
            for(let i = 0; i < size; i++)
            {
                const owner = declared.get(location + i);
                if(owner !== undefined && owner !== m[4] + "[" + i + "]")
                {
                    return empty("ERROR: uniform location " + (location + i) + " is used by two uniforms");
                }
                declared.set(location + i, m[4] + "[" + i + "]");
            }
        }
    }
    // locations: the default block's and the opaque uniforms; layout(location) first
    const taken = new Set();
    const default_uniforms = uniforms.filter(u => u.block_index < 0 && u.opaque !== "atomic");
    for(const u of default_uniforms)
    {
        const declaration = located.get(u.name.replace(/[[.].*$/, ""));
        const offset = declaration ? location_offset(declaration, u.name, structs) : -1;
        if(offset >= 0) u.explicit_location = declaration.location + offset;
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
    // transform feedback of array elements and struct members ("v[1]",
    // "s.a"): the last stage before the fragment shader copies each into an
    // output of its own after its main (_v86_xfb<i>, captured whole)
    const parts = options.tf ? options.tf.names.filter(n => /[[.]/.test(n) && !n.startsWith("gl_")) : [];
    if(parts.length)
    {
        let index = shaders.length - 1;
        while(index >= 0 && (shaders[index].stage === "fragment" || shaders[index].stage === "compute")) index--;
        const module = index >= 0 && code.modules.find(x => x.stage === STAGE[shaders[index].stage]);
        const m = module && parse_spirv(new Uint32Array(module.words));
        const explicit = /\blayout\s*\([^)]*\blocation\b[^)]*\)\s*(?:(?:flat|smooth|centroid|highp|mediump|lowp|invariant)\s+)*out\b/.test(shaders[index].source);
        let source = rewritten[index].source.replace(/\bmain\b(?=\s*\()/g, "_v86_main");
        let copies = "";
        for(const [i, name] of parts.entries())
        {
            const type = m && element_type(m, renamed(name, renames));
            if(!type) return empty("ERROR: transform feedback varying " + name + " is not an output of the vertex shader");
            source += `\n${explicit ? `layout(location = ${15 - i}) ` : ""}${type.integer ? "flat " : ""}out highp ${type.glsl} _v86_xfb${i};`;
            copies += ` _v86_xfb${i} = ${renamed(name, renames)};`;
        }
        rewritten[index] = Object.assign({}, rewritten[index], { source: source + "\nvoid main() { _v86_main();" + copies + " }\n" });
        try
        {
            code = glslang.program_spirv(shaders.map((s, i) => ({ stage: STAGE[s.stage], source: rewritten[i].source })), flags);
        }
        catch(e)
        {
            return empty("ERROR: internal compiler error: " + (e && e.message || e));
        }
        if(!code.ok) return empty("ERROR: transform feedback varyings " + parts.join(", ") + ": " + code.log);
    }
    const refused = link_rules(code.modules, shaders, !!options.separable);
    if(refused) return empty(refused);

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
    // the atomic counters' offsets (their layout(offset)s, which the check
    // pass's reflection leaves out): their members' in the code pass's
    // gl_AtomicCounterBlock_<binding>, an array's element by its indices and
    // the arrays' strides; each binding's buffer size, the declared counters'
    const counters = new Map();
    const counter_buffers = new Map();
    for(const module of code.modules)
    {
        const words = new Uint32Array(module.words);
        const m = parse_spirv(words);
        for(const [id, name] of m.names)
        {
            const t = m.types.get(id);
            const binding = /^gl_AtomicCounterBlock_(\d+)$/.exec(name);
            if(!binding || !t || t.kind !== "struct") continue;
            const names = m.member_names.get(id) || [];
            t.members.forEach((member, i) =>
            {
                const d = m.member_decorations.get(id);
                const at = d && d.get(i) && d.get(i).get(DECORATION.Offset);
                const offset = at === undefined || at < 0 ? 0 : words[at];
                const strides = [];
                let count = 1;
                for(let e = member; m.types.get(e) && m.types.get(e).kind === "array"; e = m.types.get(e).element)
                {
                    strides.push(get_decoration(words, m, e, DECORATION.ArrayStride) || 4);
                    count *= array_length(m, m.types.get(e));
                }
                counters.set(binding[1] + ":" + names[i], { offset, strides });
                counter_buffers.set(+binding[1], Math.max(counter_buffers.get(+binding[1]) || 0, offset + 4 * count));
            });
        }
    }
    for(const u of uniforms)
    {
        if(u.opaque !== "atomic") continue;
        const parts = /^(\w+)((?:\[\d+\])*)$/.exec(u.name);
        const counter = parts && counters.get(u.binding + ":" + renamed(parts[1], renames));
        if(!counter) continue;
        const indices = (parts[2].match(/\d+/g) || []).map(Number);
        u.offset = indices.reduce((offset, index, k) => offset + index * (counter.strides[k] || 4), counter.offset);
        u.array_stride = counter.strides.length ? counter.strides[counter.strides.length - 1] : 0;
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
            type: at ? at.uniform.type : 0, unit: at && image ? at.uniform.binding : undefined,
            // (the draw's destination, an advanced blend's: glsl_es_rewrite.js's)
            ...(gl === BLEND_DESTINATION ? { blend_destination: true } : {}) });
        return binding;
    };
    blocks.forEach((b, i) => bindings.push({ binding: BINDING.UNIFORM_BLOCKS + i, kind: "uniform_block", block: i, size: b.size }));
    const storage_blocks = check.bufferBlocks.map((b, index) => ({ name: b.name, index, size: b.size, binding: element_binding(check.bufferBlocks, b) }));
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
                    // (a block's variable by its instance's name or its block's; an instance array's, its first element: GL lists
                    // "B[0]", "B[1]"..., the array's elements a binding each from the first's)
                    const type_name = m.names.get(innermost(m, m.types.get(v.type).pointee)) || "";
                    const of = b => [name, type_name].some(n => n && [b.name, renamed(b.name, renames)].some(x => x === n || x === n + "[0]"));
                    const block = blocks.findIndex(of);
                    const storage = storage_blocks.findIndex(of);
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
        naga_decorations(words, m);
        spirv.push({ stage: STAGE_NAME[stage], words: consecutive_elements(words), model: MODEL_OF_STAGE[stage] });
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
            // (an element or member: its copy's output)
            const variable = parts.includes(name) ? "_v86_xfb" + parts.indexOf(name) : renamed(name, renames);
            const v = m && varying_of(m, variable, name);
            if(v) v.variable = variable;
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
            const capture = { name: v.name.startsWith("gl_") ? v.name : v.variable, buffer: interleaved ? 0 : i,
                offset: interleaved ? offset : 0, stride: interleaved ? stride : v.bytes };
            offset += v.bytes;
            return capture;
        }));
    }

    const geometry_module = spirv.find(m => m.stage === "geometry");
    const tessellation_modules = spirv.filter(m => m.stage === "tess_control" || m.stage === "tess_evaluation");
    return { ok: true, log: check.log, attributes, uniforms, locations, by_location, reflection: check, blocks, storage_blocks,
        bindings, spirv, renames, local_size: check.localSize, default_block_size: bindings[0].size, tf_varyings,
        counter_buffers: Object.fromEntries(counter_buffers),
        tf_mode: options.tf ? options.tf.mode : 0x8C8C, outputs: check.outputs, geometry: geometry_module ? geometry_layout(geometry_module.words) : null,
        unused_inputs, blend_support: shaders.filter(s => s.stage === "fragment").flatMap(s => blend_support(s.source)),
        tessellation: tessellation_modules.length ? tessellation_layout(tessellation_modules) : null };
}

/**
 * The tessellation shaders' layout from their SPIR-V's execution modes, as
 * GL's program queries answer it: the control shader's output vertices
 * (0 without one), the evaluation shader's mode, spacing, vertex order and
 * point mode (0 without one)
 * @param {!Array<{stage: string, words: !Uint32Array}>} modules
 */
export function tessellation_layout(modules)
{
    const layout = { control: false, evaluation: false, vertices: 0, mode: 0, spacing: 0x0202, order: 0x0901, point_mode: 0 };
    const MODES = { 22: ["mode", 0x0004], 24: ["mode", 0x0007], 25: ["mode", 0x8E7A], 1: ["spacing", 0x0202], 2: ["spacing", 0x8E7C],
        3: ["spacing", 0x8E7B], 4: ["order", 0x0900], 5: ["order", 0x0901], 10: ["point_mode", 1] };
    for(const m of modules)
    {
        layout[m.stage === "tess_control" ? "control" : "evaluation"] = true;
        const words = m.words;
        for(let at = 5; at < words.length;)
        {
            const count = words[at] >>> 16;
            if(!count) break;
            if((words[at] & 0xFFFF) === 16 && count >= 3)
            {
                const mode = words[at + 2];
                if(mode === 26) layout.vertices = words[at + 3];
                else if(m.stage === "tess_evaluation" && mode in MODES) layout[MODES[mode][0]] = MODES[mode][1];
            }
            at += count;
        }
    }
    return layout;
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

/** The precisions GLSL ES gives a type when the shader declares none (4.5.4): float has none in a fragment shader */
const DEFAULT_PRECISIONS = { vertex: { float: "highp", int: "highp", sampler2D: "lowp", samplerCube: "lowp" },
    fragment: { int: "mediump", sampler2D: "lowp", samplerCube: "lowp" } };

/**
 * A shader's default block uniforms' precisions, a leaf's path to its
 * precision (GLSL ES: a qualifier of its own, else the default in effect
 * where it, or its struct's member, is declared); the SPIR-V does not keep
 * them. Blocks and the types without precision (bool) are left out.
 * @param {string} source
 * @param {string} stage
 * @return {!Map<string, string>}
 */
export function uniform_precisions(source, stage)
{
    const text = source.replace(/\/\*[^]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "").replace(/^\s*#[^\n]*/gm, "");
    const tokens = text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|[^\s\w]/g) || [];
    const defaults = Object.assign({}, DEFAULT_PRECISIONS[stage] || {});
    const QUALIFIERS = new Set(["lowp", "mediump", "highp"]);
    const category = type => /^(float|vec\d|mat\d(x\d)?)$/.test(type) ? "float" : /^(int|uint|[iu]vec\d)$/.test(type) ? "int" : type;
    const structs = new Map();
    const out = new Map();
    let i = 0;
    /** a struct's body from tokens[i] ("{"): its members [{name, type, precision}], i after "}" */
    const struct_body = () =>
    {
        const members = [];
        i++;
        while(i < tokens.length && tokens[i] !== "}")
        {
            let precision = null;
            if(QUALIFIERS.has(tokens[i])) precision = tokens[i++];
            let type = tokens[i++];
            if(type === "struct")
            {
                const name = tokens[i] !== "{" ? tokens[i++] : null;
                const nested = struct_body();
                if(name) structs.set(name, nested);
                type = { members: nested };
            }
            while(i < tokens.length && tokens[i] !== ";")
            {
                const name = tokens[i++];
                while(tokens[i] === "[") { while(tokens[i] !== "]") i++; i++; }
                members.push({ name, type, precision: precision || (typeof type === "string" ? defaults[category(type)] || null : null) });
                if(tokens[i] === ",") i++;
            }
            i++;
        }
        i++;
        return members;
    };
    const leaves = (path, type, precision) =>
    {
        const members = typeof type === "object" ? type.members : structs.get(type);
        if(members) for(const m of members) leaves(path + "." + m.name, m.type, m.precision);
        else if(type !== "bool" && !/^bvec/.test(type) && precision) out.set(path, precision);
    };
    let depth = 0;
    while(i < tokens.length)
    {
        const t = tokens[i];
        if(t === "{") { depth++; i++; continue; }
        if(t === "}") { depth--; i++; continue; }
        if(depth > 0) { i++; continue; }
        if(t === "precision" && QUALIFIERS.has(tokens[i + 1]))
        {
            defaults[category(tokens[i + 2])] = tokens[i + 1];
            i += 3;
            continue;
        }
        if(t === "struct" && tokens[i + 2] === "{")
        {
            const name = tokens[i + 1];
            i += 2;
            structs.set(name, struct_body());
            continue;
        }
        if(t !== "uniform") { i++; continue; }
        i++;
        // (a default layout's statement, `layout(std140) uniform;`: no uniform)
        if(tokens[i] === ";") { i++; continue; }
        if(tokens[i] === "layout") { while(tokens[i] !== ")") i++; i++; }
        let precision = null;
        if(QUALIFIERS.has(tokens[i])) precision = tokens[i++];
        let type = tokens[i++];
        if(type === "struct")
        {
            const name = tokens[i] !== "{" ? tokens[i++] : null;
            const members = struct_body();
            if(name) structs.set(name, members);
            type = { members };
        }
        else if(tokens[i] === "{") { depth++; i++; continue; }
        while(i < tokens.length && tokens[i] !== ";")
        {
            const name = tokens[i++];
            while(tokens[i] === "[") { while(tokens[i] !== "]") i++; i++; }
            leaves(name, type, precision || (typeof type === "string" ? defaults[category(type)] || null : null));
            if(tokens[i] === ",") i++;
            else if(tokens[i] !== ";") i++;
        }
        i++;
    }
    return out;
}

/**
 * The link errors of GLSL ES that glslang's relaxed link leaves out:
 * - a uniform of other precisions in two stages (uniform_precisions);
 * - an input the next stage uses that the stage before it does not write
 *   (not in a separable program: a pipeline's stages are checked apart);
 * - in GLSL ES 3.00, an input of other interpolation (flat, noperspective)
 *   than its output (3.10 lets them differ)
 * @param {!Array<{stage: number, words: !Array<number>}>} modules the code pass's
 * @param {!Array<{stage: string, source: string}>} shaders
 * @return {?string} the link's error
 */
function link_rules(modules, shaders, separable)
{
    const precisions = new Map();
    for(const shader of shaders)
    {
        for(const [path, precision] of uniform_precisions(shader.source, shader.stage))
        {
            if(precisions.has(path) && precisions.get(path) !== precision) return "ERROR: Linking: precision of uniform " + path + " differs between shaders";
            precisions.set(path, precision);
        }
    }
    if(separable) return null;
    const parsed = modules.map(module => { const words = new Uint32Array(module.words); return { stage: module.stage, words, m: parse_spirv(words) }; })
        .sort((a, b) => a.stage - b.stage);
    const FLAT = 14, NO_PERSPECTIVE = 13;
    // each stage's inputs against the outputs of the stage before it
    const decorated = (m, id, d) => !!(m.decorations.get(id) && m.decorations.get(id).has(d));
    // (an interface block matches by its block's name, not its instance's)
    const interface_name = (m, v) =>
    {
        let id = m.types.get(v.type).pointee;
        while(m.types.get(id) && m.types.get(id).kind === "array") id = m.types.get(id).element;
        return m.types.get(id) && m.types.get(id).kind === "struct" && decorated(m, id, DECORATION.Block) ? "block " + m.names.get(id) : variable_name(m, v);
    };
    for(let k = 1; k < parsed.length; k++)
    {
        const before = parsed[k - 1], after = parsed[k];
        if(after.stage === STAGE.compute) continue;
        const outputs = new Map(before.m.variables.filter(v => v.storage === STORAGE.Output && !is_builtin(before.m, v)).map(v => [interface_name(before.m, v), v]));
        // (what the stage's code reads: loads, access chains, the interpolation functions)
        const used = new Set();
        const words = after.words;
        let in_functions = false;
        for(let at = 5; at < words.length;)
        {
            const count = words[at] >>> 16, op = words[at] & 0xFFFF;
            if(!count) break;
            if(op === 54) in_functions = true;
            if(in_functions && (op === 61 || op === 65 || op === 66) && count >= 4) used.add(words[at + 3]);
            if(in_functions && op === 12 && count >= 6) used.add(words[at + 5]);
            at += count;
        }
        const es300 = [before, after].every(x => shaders.some(s => STAGE[s.stage] === x.stage && glsl_version(s.source) === 300));
        for(const v of after.m.variables)
        {
            if(v.storage !== STORAGE.Input || is_builtin(after.m, v)) continue;
            const name = interface_name(after.m, v);
            const output = outputs.get(name);
            if(!output)
            {
                if(used.has(v.id)) return "ERROR: Linking " + STAGE_NAME[after.stage] + " stage: input " + name + " is not written by the " + STAGE_NAME[before.stage] + " stage";
                continue;
            }
            if(es300 && (decorated(before.m, output.id, FLAT) !== decorated(after.m, v.id, FLAT) ||
                decorated(before.m, output.id, NO_PERSPECTIVE) !== decorated(after.m, v.id, NO_PERSPECTIVE)))
            {
                return "ERROR: Linking " + STAGE_NAME[after.stage] + " stage: interpolation of " + name + " differs from the " + STAGE_NAME[before.stage] + " stage's";
            }
        }
    }
    return null;
}

/** SPIR-V's numeric types as GL's: the base's enums of 1 to 4 components, matrices by [columns][rows] */
const GL_OF = { float: [0x1406, 0x8B50, 0x8B51, 0x8B52], int: [0x1404, 0x8B53, 0x8B54, 0x8B55], uint: [0x1405, 0x8DC6, 0x8DC7, 0x8DC8],
    bool: [0x8B56, 0x8B57, 0x8B58, 0x8B59] };
const GL_MATRICES = { 2: { 2: 0x8B5A, 3: 0x8B65, 4: 0x8B66 }, 3: { 2: 0x8B67, 3: 0x8B5B, 4: 0x8B68 }, 4: { 2: 0x8B69, 3: 0x8B6A, 4: 0x8B5C } };

/**
 * The GLSL type of an output's element or member ("v[1]", "s.a", "s[2].b"
 * by the code pass's names), and whether it is an integer's, or null
 * @return {?{glsl: string, integer: boolean}}
 */
function element_type(m, path)
{
    const steps = path.match(/^\w+|\[\d+\]|\.\w+/g);
    if(!steps || steps.join("") !== path) return null;
    const v = m.variables.find(x => x.storage === STORAGE.Output && variable_name(m, x) === steps[0] && !is_builtin(m, x));
    if(!v) return null;
    let id = m.types.get(v.type).pointee;
    for(const step of steps.slice(1))
    {
        const t = m.types.get(id);
        if(step[0] === "[")
        {
            if(!t || t.kind !== "array" || +step.slice(1, -1) >= array_length(m, t)) return null;
            id = t.element;
        }
        else
        {
            const member = t && t.kind === "struct" ? (m.member_names.get(id) || []).indexOf(step.slice(1)) : -1;
            if(member < 0) return null;
            id = t.members[member];
        }
    }
    const t = m.types.get(id);
    const scalar = s => s.kind === "float" ? "" : s.signed ? "i" : "u";
    if(t.kind === "matrix")
    {
        const column = m.types.get(t.column);
        return { glsl: t.columns === column.size ? `mat${t.columns}` : `mat${t.columns}x${column.size}`, integer: false };
    }
    if(t.kind === "vector")
    {
        const s = m.types.get(t.component);
        return s.kind === "bool" ? null : { glsl: `${scalar(s)}vec${t.size}`, integer: s.kind === "int" };
    }
    if(t.kind === "float") return { glsl: "float", integer: false };
    if(t.kind === "int") return { glsl: t.signed ? "int" : "uint", integer: true };
    return null;
}

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
    "tf_varyings", "tf_mode", "outputs", "geometry", "unused_inputs", "blend_support", "tessellation"];

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
 * The module marked for vx_naga's blockarrays.rs (its CONSECUTIVE): an
 * instance array's elements have SPIR-V bindings of their own here, the
 * array's plus the index (BINDING's ranges, a block each), which its
 * elements' variables take (any binding, any length)
 * @param {!Uint32Array} words
 * @return {!Uint32Array}
 */
function consecutive_elements(words)
{
    const text = new TextEncoder().encode("vx consecutive block elements");
    const marker = new Uint32Array(1 + (text.length >> 2) + 1);
    new Uint8Array(marker.buffer).set(text, 4);
    marker[0] = marker.length << 16 | 330; // OpModuleProcessed
    // (with the debug instructions: before the first annotation, type, constant or variable)
    let at = 5;
    while(at < words.length)
    {
        const op = words[at] & 0xFFFF;
        if(op >= 71 && op <= 75 || op === 332 || op >= 19 && op <= 59) break;
        at += words[at] >>> 16 || 1;
    }
    const out = new Uint32Array(words.length + marker.length);
    out.set(words.subarray(0, at));
    out.set(marker, at);
    out.set(words.subarray(at), at + marker.length);
    return out;
}

/**
 * The shaders' struct declarations: each one's members (type, name,
 * array dimensions) in order
 * @return {!Map<string, !Array<{type: string, name: string, dims: !Array<number>}>>}
 */
function struct_declarations(shaders)
{
    const structs = new Map();
    for(const s of shaders)
    {
        const source = s.source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
        for(const m of source.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g))
        {
            const members = [];
            for(const declaration of m[2].split(";"))
            {
                const words = declaration.replace(/\b(?:lowp|mediump|highp)\b/g, "").trim().match(/^(\w+)\s+([\s\S]+)$/);
                if(!words) continue;
                for(const d of words[2].split(","))
                {
                    const one = /^\s*(\w+)\s*((?:\[\s*\d+\s*\])*)\s*$/.exec(d);
                    if(one) members.push({ type: words[1], name: one[1], dims: (one[2].match(/\d+/g) || []).map(Number) });
                }
            }
            structs.set(m[1], members);
        }
    }
    return structs;
}

/** The uniform locations a value of a type takes: a basic type's one, a struct's its members' */
function uniform_locations(type, structs)
{
    const members = structs.get(type);
    if(!members) return 1;
    return members.reduce((n, m) => n + m.dims.reduce((k, d) => k * d, 1) * uniform_locations(m.type, structs), 0);
}

/**
 * A reflected uniform's location past its declaration's ("s.b[1]", "a[2][0]"):
 * the elements and members before it, in order; -1 where the declarations
 * do not say
 * @param {{type: string, dims: !Array<number>}} declaration
 * @return {number}
 */
function location_offset(declaration, name, structs)
{
    const steps = name.match(/^\w+|\[\d+\]|\.\w+/g);
    if(!steps || steps.join("") !== name) return -1;
    let type = declaration.type, dims = declaration.dims, offset = 0;
    for(const step of steps.slice(1))
    {
        if(step[0] === "[")
        {
            if(!dims.length) return -1;
            offset += +step.slice(1, -1) * dims.slice(1).reduce((n, d) => n * d, 1) * uniform_locations(type, structs);
            dims = dims.slice(1);
            continue;
        }
        const members = structs.get(type);
        const at = members ? members.findIndex(m => m.name === step.slice(1)) : -1;
        if(at < 0 || dims.length) return -1;
        for(const m of members.slice(0, at)) offset += m.dims.reduce((n, d) => n * d, 1) * uniform_locations(m.type, structs);
        type = members[at].type;
        dims = members[at].dims;
    }
    return offset;
}

/**
 * A block's binding point: its layout(binding)'s (or 0); an instance
 * array's element, the array's plus the element's index (glslang reflects
 * each element with the array's), its place among the elements for an
 * array of arrays
 * @param {!Array<{name: string, binding: number}>} list the reflection's blocks of its kind
 * @param {{name: string, binding: number}} b
 */
function element_binding(list, b)
{
    if(b.binding < 0) return 0;
    const parts = /^([^[]+)((?:\[\d+\])+)$/.exec(b.name);
    if(!parts) return b.binding;
    const indices = parts[2].match(/\d+/g);
    if(indices.length === 1) return b.binding + +indices[0];
    return b.binding + list.filter(x => x.name.startsWith(parts[1] + "[")).indexOf(b);
}

/**
 * Decorations naga refuses or writes as WGSL that is not, the decoration
 * RelaxedPrecision in their place (which it ignores):
 * - writeonly storage blocks (NonReadable on their members or variables),
 *   which naga refuses: readable (a shader GL took never reads them);
 * - coherent and volatile variables (buffers, images), which naga writes
 *   as @coherent and @volatile: WebGPU's storage is coherent within a
 *   dispatch, its barriers order it
 * @param {!Uint32Array} words
 * @param {!Object} m parse_spirv's
 */
function naga_decorations(words, m)
{
    const NON_READABLE = 25, COHERENT = 23, VOLATILE = 21, RELAXED_PRECISION = 0;
    const blocks = new Set(), buffers = new Set(), variables = new Set(m.variables.map(v => v.id));
    for(const v of m.variables)
    {
        if(v.storage !== STORAGE.StorageBuffer && v.storage !== STORAGE.Uniform) continue;
        buffers.add(v.id);
        blocks.add(innermost(m, m.types.get(v.type).pointee));
    }
    for(let at = 5; at < words.length;)
    {
        const count = words[at] >>> 16, op = words[at] & 0xFFFF;
        if(!count) break;
        if(op === OP.Decorate && count === 3 && (words[at + 2] === NON_READABLE && buffers.has(words[at + 1]) ||
            (words[at + 2] === COHERENT || words[at + 2] === VOLATILE) && variables.has(words[at + 1])))
        {
            words[at + 2] = RELAXED_PRECISION;
        }
        if(op === OP.MemberDecorate && count === 4 && words[at + 3] === NON_READABLE && blocks.has(words[at + 1])) words[at + 3] = RELAXED_PRECISION;
        at += count;
    }
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
