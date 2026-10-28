// GLES 3.1's state in the shadow state (docs/gles3-plan.md L5), written
// from the GLES 3.1 specification: what a context of version 31 or 32 has
// beyond GLES 3.0's (gles3_state.js), the commands GLES 3.1 adds, and its
// forms of 3.0's whose rules it changed. Its handlers come before 3.0's for
// those contexts (gles_shadow.js).
//
// - Compute: glDispatchCompute(Indirect) of the current program (or the
//   bound pipeline's compute program); the buffers bound for storage and
//   atomic counters are the GPU's then ("gpu_newer": the CPU side asks the
//   page for their bytes when mapped, as transform feedback's).
// - Shader storage and atomic counter buffers (indexed bindings), image
//   units, memory barriers.
// - Vertex attribute bindings (glBindVertexBuffer and the formats): each
//   vertex array has binding points; an attribute's buffer, offset, stride
//   and divisor (what GLES 3.0's handlers and the executor read) follow its
//   binding point's.
// - Separable programs and program pipelines, glProgramUniform*, the
//   program interface queries.
// - Multisampled 2D textures, the sample mask, framebuffers without
//   attachments (their default size), glGetTexLevelParameter*.
// - Indirect draws (the AEMU forms: the parameters with the command, or
//   in the draw indirect buffer), robustness's reset status and sized reads.

import { GL3, LIMITS3, SLOT } from "./gles3_state.js";
import { format_info } from "./gles_formats3.js";

export const GL31 = {
    SHADER_STORAGE_BUFFER: 0x90D2, ATOMIC_COUNTER_BUFFER: 0x92C0, DISPATCH_INDIRECT_BUFFER: 0x90EE, DRAW_INDIRECT_BUFFER: 0x8F3F,
    TEXTURE_2D_MULTISAMPLE: 0x9100, COMPUTE_SHADER: 0x91B9, PROGRAM_SEPARABLE: 0x8258, READ_ONLY: 0x88B8, WRITE_ONLY: 0x88B9,
    READ_WRITE: 0x88BA, ALL_BARRIER_BITS: 0xFFFFFFFF, VERTEX_SHADER_BIT: 1, FRAGMENT_SHADER_BIT: 2, COMPUTE_SHADER_BIT: 0x20,
};

/** The limits GLES 3.1's contexts answer: the specification's minimums, within WebGPU's defaults (docs/gles3-plan.md "限制") */
export const LIMITS31 = {
    MAX_COMPUTE_WORK_GROUP_COUNT: [65535, 65535, 65535], MAX_COMPUTE_WORK_GROUP_SIZE: [128, 128, 64], MAX_COMPUTE_WORK_GROUP_INVOCATIONS: 128,
    MAX_COMPUTE_SHARED_MEMORY_SIZE: 16384, MAX_COMPUTE_UNIFORM_BLOCKS: 12, MAX_COMPUTE_TEXTURE_IMAGE_UNITS: 16, MAX_COMPUTE_UNIFORM_COMPONENTS: 1024,
    MAX_COMPUTE_ATOMIC_COUNTER_BUFFERS: 1, MAX_COMPUTE_ATOMIC_COUNTERS: 8, MAX_COMPUTE_IMAGE_UNIFORMS: 4, MAX_COMPUTE_SHADER_STORAGE_BLOCKS: 4,
    MAX_UNIFORM_LOCATIONS: 1024, MAX_FRAMEBUFFER_WIDTH: 4096, MAX_FRAMEBUFFER_HEIGHT: 4096, MAX_FRAMEBUFFER_SAMPLES: 4,
    MAX_VERTEX_ATOMIC_COUNTER_BUFFERS: 0, MAX_FRAGMENT_ATOMIC_COUNTER_BUFFERS: 0, MAX_COMBINED_ATOMIC_COUNTER_BUFFERS: 1,
    MAX_VERTEX_ATOMIC_COUNTERS: 0, MAX_FRAGMENT_ATOMIC_COUNTERS: 0, MAX_COMBINED_ATOMIC_COUNTERS: 8, MAX_ATOMIC_COUNTER_BUFFER_SIZE: 32,
    MAX_ATOMIC_COUNTER_BUFFER_BINDINGS: 1, MAX_VERTEX_IMAGE_UNIFORMS: 0, MAX_FRAGMENT_IMAGE_UNIFORMS: 0, MAX_COMBINED_IMAGE_UNIFORMS: 4,
    MAX_IMAGE_UNITS: 4, MAX_VERTEX_SHADER_STORAGE_BLOCKS: 0, MAX_FRAGMENT_SHADER_STORAGE_BLOCKS: 0, MAX_COMBINED_SHADER_STORAGE_BLOCKS: 4,
    MAX_SHADER_STORAGE_BUFFER_BINDINGS: 4, MAX_SHADER_STORAGE_BLOCK_SIZE: 1 << 27, SHADER_STORAGE_BUFFER_OFFSET_ALIGNMENT: 256,
    MAX_COMBINED_SHADER_OUTPUT_RESOURCES: 4, MAX_VERTEX_ATTRIB_RELATIVE_OFFSET: 2047, MAX_VERTEX_ATTRIB_BINDINGS: 16,
    MAX_VERTEX_ATTRIB_STRIDE: 2048, MAX_SAMPLE_MASK_WORDS: 1, MAX_COLOR_TEXTURE_SAMPLES: 4, MAX_DEPTH_TEXTURE_SAMPLES: 4,
    MAX_INTEGER_SAMPLES: 4, MIN_PROGRAM_TEXTURE_GATHER_OFFSET: -8, MAX_PROGRAM_TEXTURE_GATHER_OFFSET: 7,
};

/** The image formats an image unit takes (GLES 3.1 table 8.27) */
const IMAGE_FORMATS = new Set([0x8814, 0x881A, 0x822E, 0x8D70, 0x8D76, 0x8D7C, 0x8236, 0x8D82, 0x8D88, 0x8D8E, 0x8235, 0x8058, 0x8F97]);
/** The standard sample positions of 4 samples (glGetMultisamplefv; WebGPU's, Direct3D's) */
const SAMPLE_POSITIONS_4 = [[0.375, 0.125], [0.875, 0.375], [0.125, 0.625], [0.625, 0.875]];
const MAX_ATTRIBS = 16;

/** A GLES 3.1 context's state beyond GLES 3.0's (tables 20.2 to 20.53's additions) */
export function extend_context31(c)
{
    const bindings = n => Array.from({ length: n }, () => ({ buffer: 0, offset: 0, size: 0 }));
    c.storage_bindings = bindings(LIMITS31.MAX_SHADER_STORAGE_BUFFER_BINDINGS);
    c.atomic_bindings = bindings(LIMITS31.MAX_ATOMIC_COUNTER_BUFFER_BINDINGS);
    c.image_units = Array.from({ length: LIMITS31.MAX_IMAGE_UNITS }, () => ({ texture: 0, level: 0, layered: false, layer: 0, access: GL31.READ_ONLY,
        format: 0x8236 }));
    c.program_pipelines = new Map();
    c.program_pipeline = 0;
    c.reserved3.pipeline = new Set();
    c.next3.pipeline = 1;
    c.sample_mask = 0xFFFFFFFF;
}

/** A vertex array's binding points (GLES 3.1's model of 3.0's arrays), made at first use */
function vertex_bindings(c)
{
    const vao = c.vao ? c.vaos.get(c.vao) : c.default_vao;
    if(!vao.bindings)
    {
        // (each attribute's own binding point, as GLES 3.0's calls leave them)
        vao.bindings = vao.attribs.map(a => ({ buffer: a.buffer, offset: a.offset, stride: a.stride, divisor: a.divisor }));
        vao.attribs.forEach((a, i) => { a.binding = i; a.relative_offset = 0; });
    }
    return vao.bindings;
}

/** The attributes of a binding point: their buffer, offset, stride and divisor as GLES 3.0's handlers and the executor read them */
function follow_binding(c, index)
{
    const bindings = vertex_bindings(c);
    const b = bindings[index];
    c.attribs.forEach(a =>
    {
        if(a.binding !== index) return;
        a.buffer = b.buffer;
        a.offset = b.offset + (a.relative_offset || 0);
        // (an explicit stride of 0: every vertex the same; the executor reads 0 as tight, gpu-deviations.md)
        a.stride = b.stride;
        a.divisor = b.divisor;
    });
}

/** GLES 3.1's names of the program interfaces (glGetProgramInterfaceiv) */
const INTERFACES = { UNIFORM: 0x92E1, UNIFORM_BLOCK: 0x92E2, PROGRAM_INPUT: 0x92E3, PROGRAM_OUTPUT: 0x92E4, BUFFER_VARIABLE: 0x92E5,
    SHADER_STORAGE_BLOCK: 0x92E6, ATOMIC_COUNTER_BUFFER: 0x92C0, TRANSFORM_FEEDBACK_VARYING: 0x92F4 };
/** glslang's stage bits (STAGE: vertex 0, fragment 4, compute 5) of REFERENCED_BY_*_SHADER */
const REFERENCED = { 0x9306: 1 << 0, 0x930A: 1 << 4, 0x930B: 1 << 5 };

/**
 * A program's resources of an interface, as the program interface queries
 * list them: name, and each property's value (by its enum), from the
 * link's GL view and glslang's reflection
 * @return {?Array<{name: string, props: !Object<number, (number|!Array<number>)>}>} null for no such interface
 */
function resources(program, iface)
{
    const info = program.info;
    if(!info || !info.ok) return [];
    const reflection = info.reflection || {};
    const stages = s => Object.fromEntries(Object.entries(REFERENCED).map(([p, bit]) => [p, s & bit ? 1 : 0]));
    const array_name = (name, size) => size > 1 && !name.endsWith("]") ? name + "[0]" : name;
    switch(iface)
    {
        case INTERFACES.UNIFORM:
            return info.uniforms.map(u => ({ name: array_name(u.name, u.size), props: Object.assign({
                0x92FA: u.type, 0x92FB: u.size, 0x92FC: u.block_index >= 0 ? u.offset : -1, 0x92FD: u.block_index,
                0x92FE: u.block_index >= 0 ? u.array_stride || 0 : -1, 0x92FF: u.block_index >= 0 ? u.matrix_stride || 0 : -1,
                0x9300: u.row_major ? 1 : 0, 0x9301: u.opaque === "atomic" ? 0 : -1, 0x930E: u.block_index >= 0 || u.opaque === "atomic" ? -1 : u.location,
            }, stages(u.stages)) }));
        case INTERFACES.UNIFORM_BLOCK:
            return (info.blocks || []).map((b, i) => ({ name: b.name, props: Object.assign({
                0x9302: program.block_bindings ? program.block_bindings[i] : b.binding, 0x9303: b.size, 0x9304: b.members.length, 0x9305: b.members,
            }, stages(b.stages)) }));
        case INTERFACES.SHADER_STORAGE_BLOCK:
            return (info.storage_blocks || []).map((b, i) =>
            {
                const members = (reflection.bufferVariables || []).map((v, k) => [v, k]).filter(([v]) => v.index === i).map(([, k]) => k);
                const block = (reflection.bufferBlocks || [])[i] || {};
                return { name: b.name, props: Object.assign({ 0x9302: program.storage_bindings ? program.storage_bindings[i] : b.binding, 0x9303: b.size,
                    0x9304: members.length, 0x9305: members }, stages(block.stages || 0)) };
            });
        case INTERFACES.BUFFER_VARIABLE:
            return (reflection.bufferVariables || []).map(v => ({ name: array_name(v.name, v.size), props: Object.assign({
                0x92FA: v.type, 0x92FB: Math.max(0, v.size), 0x92FC: v.offset, 0x92FD: v.index, 0x92FE: v.arrayStride || 0,
                0x92FF: v.matrixStride || 0, 0x9300: v.rowMajor ? 1 : 0, 0x930C: v.topLevelArraySize === undefined ? 1 : v.topLevelArraySize,
                0x930D: v.topLevelArrayStride || 0,
            }, stages(v.stages || 0)) }));
        case INTERFACES.PROGRAM_INPUT:
            return (reflection.inputs || []).filter(i => i.stages & (info.spirv && info.spirv.some(m => m.stage === "vertex") ? 1 : 1 << 4))
                .map(i => ({ name: array_name(i.name, i.size), props: Object.assign({ 0x92FA: i.type, 0x92FB: Math.max(1, i.size),
                    0x930E: i.builtIn ? -1 : (info.attributes.find(a => a.name === i.name) || { location: i.location }).location }, stages(i.stages || 0)) }));
        case INTERFACES.PROGRAM_OUTPUT:
            return (reflection.outputs || []).map(o => ({ name: array_name(o.name, o.size), props: Object.assign({ 0x92FA: o.type,
                0x92FB: Math.max(1, o.size), 0x930E: o.builtIn ? -1 : Math.max(0, o.location) }, stages(o.stages || 0)) }));
        case INTERFACES.TRANSFORM_FEEDBACK_VARYING:
            return (info.tf_varyings || []).map(v => ({ name: v.name, props: { 0x92FA: v.type, 0x92FB: v.size } }));
        case INTERFACES.ATOMIC_COUNTER_BUFFER:
        {
            const buffers = new Map();
            info.uniforms.forEach((u, k) =>
            {
                if(u.opaque !== "atomic") return;
                if(!buffers.has(u.binding)) buffers.set(u.binding, { members: [], size: 0, stages: 0 });
                const b = buffers.get(u.binding);
                b.members.push(k);
                b.size = Math.max(b.size, (u.offset || 0) + 4 * u.size);
                b.stages |= u.stages;
            });
            return [...buffers].map(([binding, b]) => ({ name: "", props: Object.assign({ 0x9302: binding, 0x9303: b.size, 0x9304: b.members.length,
                0x9305: b.members }, stages(b.stages)) }));
        }
    }
    return null;
}

/**
 * The handlers of GLES 3.1's contexts: GLES 3.1's commands and its forms of
 * GLES 3.0's (those not here are 3.0's)
 * @param {!Object} h gles_shadow.js's helpers
 * @param {!Object} H3 gles3_state.js's handlers (their `helpers` too)
 * @return {!Object<string, function(!Object, !Object, !Array<*>)>}
 */
export function gles31_handlers(h, H3)
{
    const { fail, query, put, put_text, i32s, f32s, text_of, REFUSED, base } = h;
    const { bound_buffer3, generated, new_buffer, current_tf, program_of, put64, get_attrib3, status_of } = H3.helpers;
    const GL = GL3;

    /** The program whose stage runs: the current program's, else the bound pipeline's for the stage */
    const stage_program = (c, stage_bit) =>
    {
        if(c.program) return c.group.objects.get(c.program) || null;
        const pipeline = c.program_pipelines.get(c.program_pipeline);
        const name = pipeline && pipeline.stages[stage_bit];
        return name ? c.group.objects.get(name) || null : null;
    };
    /** The buffers a program's run writes (storage, atomic counters): the GPU's newer copies */
    const written = (c, programs) =>
    {
        const info = programs.map(p => p && p.info).filter(Boolean);
        if(info.some(i => (i.storage_blocks || []).length)) for(const b of c.storage_bindings) mark(c, b.buffer);
        if(info.some(i => i.uniforms.some(u => u.opaque === "atomic"))) for(const b of c.atomic_bindings) mark(c, b.buffer);
    };
    const mark = (c, name) =>
    {
        const buffer = name && c.group.buffers.get(name);
        if(buffer) buffer.gpu_newer = true;
    };
    /** glUniform*'s handler run on another program (glProgramUniform*, a pipeline's active program) */
    const on_program = (c, name, run) =>
    {
        const saved = c.program;
        c.program = name;
        try
        {
            return run();
        }
        finally
        {
            c.program = saved;
        }
    };
    /** A draw of GLES 3.1: 3.0's checks, then what it writes */
    const draw31 = handler => (shadow, c, args) =>
    {
        const r = handler(shadow, c, args);
        if(r !== REFUSED) written(c, [stage_program(c, GL31.VERTEX_SHADER_BIT), stage_program(c, GL31.FRAGMENT_SHADER_BIT)]);
        return r;
    };
    /** An indirect draw's checks (GLES 3.1 10.5): a vertex array object, its parameters from the command or the bound buffer */
    const indirect = (shadow, c, mode, type, data, offset, elements) =>
    {
        if(![0, 1, 2, 3, 4, 5, 6].includes(mode) || elements && ![0x1401, 0x1403, 0x1405].includes(type)) return fail(c, GL.INVALID_ENUM);
        if(!c.vao) return fail(c, GL.INVALID_OPERATION);
        if(elements && !c.element_array_buffer) return fail(c, GL.INVALID_OPERATION);
        if(current_tf(c).active && !current_tf(c).paused) return fail(c, GL.INVALID_OPERATION);
        if(offset !== undefined)
        {
            const buffer = c.group.buffers.get(c.buffers.draw_indirect);
            if(!buffer) return fail(c, GL.INVALID_OPERATION);
            if(offset % 4) return fail(c, GL.INVALID_VALUE);
            if(offset + (elements ? 20 : 16) > buffer.size || buffer.mapped) return fail(c, GL.INVALID_OPERATION);
        }
        if(!H3.helpers.complete(c, false)) return REFUSED;
        written(c, [stage_program(c, GL31.VERTEX_SHADER_BIT), stage_program(c, GL31.FRAGMENT_SHADER_BIT)]);
        void data;
        return undefined;
    };
    /** glGetIntegeri_v / glGetInteger64i_v / glGetBooleani_v of GLES 3.1's indexed state, else 3.0's */
    const indexed31 = (shadow, c, [target, index, data], as) =>
    {
        query(shadow);
        const list = (bindings, field) =>
        {
            if(index >= bindings.length) { fail(c, GL.INVALID_VALUE); return null; }
            return [bindings[index][field]];
        };
        let value;
        switch(target)
        {
            case 0x90D3: value = list(c.storage_bindings, "buffer"); break;
            case 0x90D4: value = list(c.storage_bindings, "offset"); break;
            case 0x90D5: value = list(c.storage_bindings, "size"); break;
            case 0x92C1: value = list(c.atomic_bindings, "buffer"); break;
            case 0x92C2: value = list(c.atomic_bindings, "offset"); break;
            case 0x92C3: value = list(c.atomic_bindings, "size"); break;
            case 0x8F3A: value = list(c.image_units, "texture"); break;
            case 0x8F3B: value = list(c.image_units, "level"); break;
            case 0x8F3C: value = list(c.image_units, "layered"); if(value) value = [value[0] ? 1 : 0]; break;
            case 0x8F3D: value = list(c.image_units, "layer"); break;
            case 0x8F3E: value = list(c.image_units, "access"); break;
            case 0x906E: value = list(c.image_units, "format"); break;
            case 0x8F4F: value = list(vertex_bindings(c), "buffer"); break;
            case 0x82D7: value = list(vertex_bindings(c), "offset"); break;
            case 0x82D8: value = list(vertex_bindings(c), "stride"); break;
            case 0x82D6: value = list(vertex_bindings(c), "divisor"); break;
            case 0x91BE: value = index < 3 ? [LIMITS31.MAX_COMPUTE_WORK_GROUP_COUNT[index]] : (fail(c, GL.INVALID_VALUE), null); break;
            case 0x91BF: value = index < 3 ? [LIMITS31.MAX_COMPUTE_WORK_GROUP_SIZE[index]] : (fail(c, GL.INVALID_VALUE), null); break;
            case 0x8E52: value = index < 1 ? [c.sample_mask | 0] : (fail(c, GL.INVALID_VALUE), null); break;
            default:
                if(as === "b") { fail(c, GL.INVALID_ENUM); return; }
                H3[as === "64" ? "glGetInteger64i_v" : "glGetIntegeri_v"](shadow, c, [target, index, data]);
                return;
        }
        if(!value) return;
        if(as === "64") put64(data, value);
        else if(as === "b") put(data, value.map(v => v ? 1 : 0), "b", "b");
        else put(data, value, "i", "i");
    };
    /** What a 3.1 helper answers for what is 3.0's */
    const NOT_HERE = Symbol("GLES 3.0's");
    /** glBindBufferRange/Base of GLES 3.1's indexed targets (storage, atomic counters), else NOT_HERE */
    const bind_indexed31 = (shadow, c, target, index, name, offset, size, range) =>
    {
        const storage = target === GL31.SHADER_STORAGE_BUFFER;
        if(!storage && target !== GL31.ATOMIC_COUNTER_BUFFER) return NOT_HERE;
        const list = storage ? c.storage_bindings : c.atomic_bindings;
        if(index >= list.length) return fail(c, GL.INVALID_VALUE);
        if(range && name && (size <= 0 || offset < 0)) return fail(c, GL.INVALID_VALUE);
        if(range && name && (storage ? offset % LIMITS31.SHADER_STORAGE_BUFFER_OFFSET_ALIGNMENT : offset % 4)) return fail(c, GL.INVALID_VALUE);
        if(name && !c.group.buffers.has(name))
        {
            if(!generated(shadow, c.group.reserved.buffer, name)) return fail(c, GL.INVALID_OPERATION);
            c.group.buffers.set(name, new_buffer());
        }
        list[index] = { buffer: name, offset: range ? offset : 0, size: range ? size : 0 };
        c.buffers[storage ? "shader_storage" : "atomic_counter"] = name;
        return undefined;
    };
    /** glProgramUniform*: glUniform*'s handler on that program */
    const program_uniform = uniform => (shadow, c, [p, ...args]) =>
    {
        const program = program_of(c, p);
        if(!program) return REFUSED;
        return on_program(c, p, () => H3[uniform](shadow, c, args));
    };
    /** glUniform*: with no current program, the bound pipeline's active program's */
    const uniform31 = uniform => (shadow, c, args) =>
    {
        if(c.program || !c.program_pipeline) return H3[uniform](shadow, c, args);
        const pipeline = c.program_pipelines.get(c.program_pipeline);
        return on_program(c, pipeline ? pipeline.active : 0, () => H3[uniform](shadow, c, args));
    };
    /** A program pipeline, made when first bound (glGenProgramPipelines' names) */
    const pipeline_of = (shadow, c, name, make) =>
    {
        let pipeline = c.program_pipelines.get(name);
        if(!pipeline && make && name && generated(shadow, c.reserved3.pipeline, name))
        {
            c.program_pipelines.set(name, pipeline = { stages: {}, active: 0, log: "", valid: false });
        }
        return pipeline || null;
    };
    /** glValidateProgramPipeline's rules (GLES 3.1 7.4.1): stages of separable, linked programs, vertex with fragment */
    const validate = (c, pipeline) =>
    {
        const programs = Object.entries(pipeline.stages).filter(([, p]) => p).map(([bit, p]) => [+bit, c.group.objects.get(p)]);
        const problem = !programs.length ? "no program" :
            programs.some(([, p]) => !p || !p.info || !p.info.ok) ? "a program is not linked" :
            programs.some(([, p]) => !p.separable) ? "a program is not separable" :
            !!pipeline.stages[GL31.VERTEX_SHADER_BIT] !== !!pipeline.stages[GL31.FRAGMENT_SHADER_BIT] && !pipeline.stages[GL31.COMPUTE_SHADER_BIT] ?
                "a vertex shader without a fragment shader, or the other way" : "";
        pipeline.valid = !problem;
        pipeline.log = problem;
        return !problem;
    };

    const H = {
        // (GLES 3.1's capability: the sample mask)
        "glEnable": (shadow, c, [cap]) => cap === 0x8E51 ? void c.enabled.add(cap) : H3["glEnable"](shadow, c, [cap]),
        "glDisable": (shadow, c, [cap]) => cap === 0x8E51 ? void c.enabled.delete(cap) : H3["glDisable"](shadow, c, [cap]),
        "glIsEnabled": (shadow, c, [cap]) => { if(cap !== 0x8E51) return H3["glIsEnabled"](shadow, c, [cap]); query(shadow); return c.enabled.has(cap) ? 1 : 0; },
        "glCreateShader": (shadow, c, [type]) =>
        {
            if(type !== GL31.COMPUTE_SHADER) return base["glCreateShader"](shadow, c, [type]);
            const name = shadow.given_name || c.group.fresh("object", c.group.objects);
            c.group.objects.set(name, { kind: "shader", type, source: null, compiled: null, compiled_source: null, deleted: false, attached: 0 });
            return name;
        },
        "glProgramParameteri": (shadow, c, [p, pname, value]) =>
        {
            if(pname !== GL31.PROGRAM_SEPARABLE) return H3["glProgramParameteri"](shadow, c, [p, pname, value]);
            const program = program_of(c, p);
            if(!program) return REFUSED;
            if(value !== 0 && value !== 1) return fail(c, GL.INVALID_VALUE);
            program.separable = !!value;
            return undefined;
        },
        "glCreateShaderProgramvAEMU": (shadow, c, [type, count, packed]) =>
        {
            // (glCreateShaderProgramv, GLES 3.1 7.3: the strings compiled, a separable program linked of the shader, which
            // goes; the program's name the answer, the page's (given_name) the same; the page links with the batch's PROGRAM_LINK)
            if(type !== 0x8B31 && type !== 0x8B30 && type !== GL31.COMPUTE_SHADER) { fail(c, GL.INVALID_ENUM); return 0; }
            if(count < 0) { fail(c, GL.INVALID_VALUE); return 0; }
            const name = shadow.given_name || c.group.fresh("object", c.group.objects);
            const source = text_of(packed);
            const program = { kind: "program", shaders: new Set(), bindings: new Map(), info: null, linked_once: true, validated: 0, deleted: false,
                values: new Map(), separable: true };
            c.group.objects.set(name, program);
            const compiled = shadow.compile(source, type, c.glslang);
            if(shadow.pending_links && shadow.pending_links.has(name))
            {
                program.provided = shadow.pending_links.get(name);
                shadow.pending_links.delete(name);
            }
            program.info = compiled.ok ? shadow.link(program, [{ type, compiled, compiled_source: source }]) :
                { ok: false, log: compiled.log, attributes: [], uniforms: [], locations: new Map(), by_location: [], reflection: null };
            program.link = { vs: null, fs: null, bindings: [], glslang: true, shaders: [[type, source]] };
            program.keep_info = !shadow.glslang;
            return name;
        },

        // ---- buffers
        "glBindBufferRange": (shadow, c, args) =>
        {
            const r = bind_indexed31(shadow, c, args[0], args[1], args[2], args[3], args[4], true);
            return r === NOT_HERE ? H3["glBindBufferRange"](shadow, c, args) : r;
        },
        "glBindBufferBase": (shadow, c, args) =>
        {
            const r = bind_indexed31(shadow, c, args[0], args[1], args[2], 0, 0, false);
            return r === NOT_HERE ? H3["glBindBufferBase"](shadow, c, args) : r;
        },
        "glGetIntegeri_v": (shadow, c, args) => indexed31(shadow, c, args, "i"),
        "glGetInteger64i_v": (shadow, c, args) => indexed31(shadow, c, args, "64"),
        "glGetBooleani_v": (shadow, c, args) => indexed31(shadow, c, args, "b"),
        "glMemoryBarrier": (shadow, c, [barriers]) =>
        {
            if(barriers !== GL31.ALL_BARRIER_BITS && barriers & ~0x3FFF) return fail(c, GL.INVALID_VALUE);
            return undefined;
        },
        "glMemoryBarrierByRegion": (shadow, c, [barriers]) =>
        {
            // (the barriers a fragment shader's region may have: GLES 3.1 7.11.2)
            if(barriers !== GL31.ALL_BARRIER_BITS && barriers & ~(0x4 | 0x8 | 0x20 | 0x400 | 0x1000 | 0x2000)) return fail(c, GL.INVALID_VALUE);
            return undefined;
        },

        // ---- compute
        "glDispatchCompute": (shadow, c, [x, y, z]) =>
        {
            const program = stage_program(c, GL31.COMPUTE_SHADER_BIT);
            if(!program || !program.info || !program.info.ok || !(program.info.spirv || []).some(m => m.stage === "compute") &&
                !(program.info.local_size && program.info.local_size.some(Boolean)))
            {
                return fail(c, GL.INVALID_OPERATION);
            }
            const max = LIMITS31.MAX_COMPUTE_WORK_GROUP_COUNT;
            if(x > max[0] || y > max[1] || z > max[2]) return fail(c, GL.INVALID_VALUE);
            written(c, [program]);
            return undefined;
        },
        "glDispatchComputeIndirect": (shadow, c, [offset]) =>
        {
            const program = stage_program(c, GL31.COMPUTE_SHADER_BIT);
            if(!program || !program.info || !program.info.ok) return fail(c, GL.INVALID_OPERATION);
            if(offset < 0 || offset % 4) return fail(c, GL.INVALID_VALUE);
            const buffer = c.group.buffers.get(c.buffers.dispatch_indirect);
            if(!buffer || offset + 12 > buffer.size || buffer.mapped) return fail(c, GL.INVALID_OPERATION);
            written(c, [program]);
            return undefined;
        },

        // ---- draws (what they write), indirect draws
        "glDrawArrays": draw31(H3["glDrawArrays"]),
        "glDrawArraysInstanced": draw31(H3["glDrawArraysInstanced"]),
        "glDrawElementsOffset": draw31(H3["glDrawElementsOffset"]),
        "glDrawElementsData": draw31(H3["glDrawElementsData"]),
        "glDrawElementsInstancedOffsetAEMU": draw31(H3["glDrawElementsInstancedOffsetAEMU"]),
        "glDrawElementsInstancedDataAEMU": draw31(H3["glDrawElementsInstancedDataAEMU"]),
        "glDrawRangeElementsOffsetAEMU": draw31(H3["glDrawRangeElementsOffsetAEMU"]),
        "glDrawRangeElementsDataAEMU": draw31(H3["glDrawRangeElementsDataAEMU"]),
        "glDrawArraysIndirectDataAEMU": (shadow, c, [mode, data]) => indirect(shadow, c, mode, 0, data, undefined, false),
        "glDrawArraysIndirectOffsetAEMU": (shadow, c, [mode, offset]) => indirect(shadow, c, mode, 0, null, offset, false),
        "glDrawElementsIndirectDataAEMU": (shadow, c, [mode, type, data]) => indirect(shadow, c, mode, type, data, undefined, true),
        "glDrawElementsIndirectOffsetAEMU": (shadow, c, [mode, type, offset]) => indirect(shadow, c, mode, type, null, offset, true),

        // ---- vertex attribute bindings
        "glBindVertexBuffer": (shadow, c, [index, buffer, offset, stride]) =>
        {
            if(index >= LIMITS31.MAX_VERTEX_ATTRIB_BINDINGS || offset < 0 || stride < 0 || stride > LIMITS31.MAX_VERTEX_ATTRIB_STRIDE) {
                return fail(c, GL.INVALID_VALUE);
            }
            if(!c.vao) return fail(c, GL.INVALID_OPERATION);
            if(buffer && !c.group.buffers.has(buffer))
            {
                if(!generated(shadow, c.group.reserved.buffer, buffer)) return fail(c, GL.INVALID_OPERATION);
                c.group.buffers.set(buffer, new_buffer());
            }
            Object.assign(vertex_bindings(c)[index], { buffer, offset, stride });
            follow_binding(c, index);
            return undefined;
        },
        "glVertexAttribBinding": (shadow, c, [attrib, binding]) =>
        {
            if(attrib >= MAX_ATTRIBS || binding >= LIMITS31.MAX_VERTEX_ATTRIB_BINDINGS) return fail(c, GL.INVALID_VALUE);
            if(!c.vao) return fail(c, GL.INVALID_OPERATION);
            vertex_bindings(c);
            c.attribs[attrib].binding = binding;
            follow_binding(c, binding);
            return undefined;
        },
        "glVertexAttribFormat": (shadow, c, [attrib, size, type, normalized, relative]) =>
            attrib_format(shadow, c, attrib, size, type, normalized, relative, false),
        "glVertexAttribIFormat": (shadow, c, [attrib, size, type, relative]) => attrib_format(shadow, c, attrib, size, type, false, relative, true),
        "glVertexBindingDivisor": (shadow, c, [binding, divisor]) =>
        {
            if(binding >= LIMITS31.MAX_VERTEX_ATTRIB_BINDINGS) return fail(c, GL.INVALID_VALUE);
            if(!c.vao) return fail(c, GL.INVALID_OPERATION);
            vertex_bindings(c)[binding].divisor = divisor >>> 0;
            follow_binding(c, binding);
            return undefined;
        },
        // (GLES 3.0's calls in 3.1's model: the attribute's own binding point)
        "glVertexAttribPointerOffset": (shadow, c, args) => pointer31(shadow, c, args, "glVertexAttribPointerOffset"),
        "glVertexAttribPointerData": (shadow, c, args) => pointer31(shadow, c, args, "glVertexAttribPointerData"),
        "glVertexAttribIPointerOffsetAEMU": (shadow, c, args) => pointer31(shadow, c, args, "glVertexAttribIPointerOffsetAEMU"),
        "glVertexAttribIPointerDataAEMU": (shadow, c, args) => pointer31(shadow, c, args, "glVertexAttribIPointerDataAEMU"),
        "glVertexAttribDivisor": (shadow, c, [index, divisor]) =>
        {
            if(index >= MAX_ATTRIBS) return fail(c, GL.INVALID_VALUE);
            vertex_bindings(c);
            c.attribs[index].binding = index;
            vertex_bindings(c)[index].divisor = divisor >>> 0;
            follow_binding(c, index);
            return undefined;
        },
        "glGetVertexAttribiv": (shadow, c, args) => attrib_query31(shadow, c, args, "iv"),
        "glGetVertexAttribfv": (shadow, c, args) => attrib_query31(shadow, c, args, "f"),
        "glGetVertexAttribIiv": (shadow, c, args) => attrib_query31(shadow, c, args, "i"),
        "glGetVertexAttribIuiv": (shadow, c, args) => attrib_query31(shadow, c, args, "ui"),

        // ---- images
        "glBindImageTexture": (shadow, c, [unit, texture, level, layered, layer, access, format]) =>
        {
            if(unit >= LIMITS31.MAX_IMAGE_UNITS || level < 0 || layer < 0) return fail(c, GL.INVALID_VALUE);
            if(![GL31.READ_ONLY, GL31.WRITE_ONLY, GL31.READ_WRITE].includes(access) || !IMAGE_FORMATS.has(format)) return fail(c, GL.INVALID_VALUE);
            if(texture)
            {
                const t = c.group.textures.get(texture);
                if(!t) return fail(c, GL.INVALID_VALUE);
                if(!t.immutable) return fail(c, GL.INVALID_OPERATION);
            }
            c.image_units[unit] = { texture, level, layered: !!layered, layer, access, format };
            return undefined;
        },

        // ---- multisampled textures, the sample mask
        "glTexStorage2DMultisample": (shadow, c, [target, samples, internalformat, width, height, fixed]) =>
        {
            if(target !== GL31.TEXTURE_2D_MULTISAMPLE) return fail(c, GL.INVALID_ENUM);
            const name = c.textures[c.active_texture][SLOT.TEXTURE_2D_MULTISAMPLE];
            const texture = name ? c.group.textures.get(name) : null;
            if(!texture || texture.immutable) return fail(c, GL.INVALID_OPERATION);
            const info = format_info(internalformat);
            if(!info || !info.sized || !(info.renderable || info.kind === "depth" || info.kind === "depth_stencil")) return fail(c, GL.INVALID_ENUM);
            if(width < 1 || height < 1 || samples < 1) return fail(c, GL.INVALID_VALUE);
            if(width > LIMITS3.MAX_TEXTURE_SIZE || height > LIMITS3.MAX_TEXTURE_SIZE) return fail(c, GL.INVALID_VALUE);
            if(samples > LIMITS31.MAX_COLOR_TEXTURE_SAMPLES) return fail(c, GL.INVALID_OPERATION);
            texture.images.clear();
            texture.images.set(0, { width, height, depth: 1, format: info.format, type: info.types[0], internal: internalformat, compressed: false,
                samples: 4, fixed_locations: !!fixed });
            texture.immutable = true;
            texture.immutable_levels = 1;
            return undefined;
        },
        "glSampleMaski": (shadow, c, [index, mask]) =>
        {
            if(index >= LIMITS31.MAX_SAMPLE_MASK_WORDS) return fail(c, GL.INVALID_VALUE);
            c.sample_mask = mask >>> 0;
            return undefined;
        },
        "glGetMultisamplefv": (shadow, c, [pname, index, val]) =>
        {
            query(shadow);
            if(pname !== 0x8E50) { fail(c, GL.INVALID_ENUM); return; }
            if(index >= 4) { fail(c, GL.INVALID_VALUE); return; }
            put(val, SAMPLE_POSITIONS_4[index], "f", "f");
        },
        "glGetTexLevelParameteriv": (shadow, c, args) => tex_level_parameter(shadow, c, args, "i"),
        "glGetTexLevelParameterfv": (shadow, c, args) => tex_level_parameter(shadow, c, args, "f"),

        "glFramebufferTexture2D": (shadow, c, [target, attachment, textarget, name, level]) =>
        {
            // (GLES 3.1: a multisampled texture's level 0 too)
            if(textarget !== GL31.TEXTURE_2D_MULTISAMPLE) return H3["glFramebufferTexture2D"](shadow, c, [target, attachment, textarget, name, level]);
            const fb = target === GL.READ_FRAMEBUFFER ? c.read_framebuffer : target === GL.FRAMEBUFFER || target === GL.DRAW_FRAMEBUFFER ? c.framebuffer : -1;
            if(fb < 0) return fail(c, GL.INVALID_ENUM);
            const fbo = c.framebuffers.get(fb);
            if(!fbo) return fail(c, GL.INVALID_OPERATION);
            const texture = name ? c.group.textures.get(name) : null;
            if(name && (!texture || texture.target !== GL31.TEXTURE_2D_MULTISAMPLE)) return fail(c, GL.INVALID_OPERATION);
            if(name && level !== 0) return fail(c, GL.INVALID_VALUE);
            const points = attachment === 0x821A ? [GL.DEPTH_ATTACHMENT, GL.STENCIL_ATTACHMENT] : [attachment];
            for(const point of points)
            {
                if(name) fbo.attachments.set(point, { type: GL.TEXTURE, name, level: 0, face: 0, layer: 0 });
                else fbo.attachments.delete(point);
            }
            return undefined;
        },

        // ---- framebuffers without attachments
        "glFramebufferParameteri": (shadow, c, [target, pname, param]) =>
        {
            const name = target === GL.READ_FRAMEBUFFER ? c.read_framebuffer : target === GL.FRAMEBUFFER || target === GL.DRAW_FRAMEBUFFER ? c.framebuffer : -1;
            if(name < 0) return fail(c, GL.INVALID_ENUM);
            if(!name) return fail(c, GL.INVALID_OPERATION);
            const fbo = c.framebuffers.get(name);
            switch(pname)
            {
                case 0x9310: if(param < 0 || param > LIMITS31.MAX_FRAMEBUFFER_WIDTH) return fail(c, GL.INVALID_VALUE); fbo.default_width = param; break;
                case 0x9311: if(param < 0 || param > LIMITS31.MAX_FRAMEBUFFER_HEIGHT) return fail(c, GL.INVALID_VALUE); fbo.default_height = param; break;
                case 0x9313: if(param < 0 || param > LIMITS31.MAX_FRAMEBUFFER_SAMPLES) return fail(c, GL.INVALID_VALUE); fbo.default_samples = param; break;
                case 0x9314: fbo.default_fixed = !!param; break;
                default: return fail(c, GL.INVALID_ENUM);
            }
            return undefined;
        },
        "glGetFramebufferParameteriv": (shadow, c, [target, pname, params]) =>
        {
            query(shadow);
            const name = target === GL.READ_FRAMEBUFFER ? c.read_framebuffer : target === GL.FRAMEBUFFER || target === GL.DRAW_FRAMEBUFFER ? c.framebuffer : -1;
            if(name < 0) { fail(c, GL.INVALID_ENUM); return; }
            if(!name) { fail(c, GL.INVALID_OPERATION); return; }
            const fbo = c.framebuffers.get(name);
            const values = { 0x9310: fbo.default_width || 0, 0x9311: fbo.default_height || 0, 0x9313: fbo.default_samples || 0,
                0x9314: fbo.default_fixed ? 1 : 0 };
            if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
            put(params, [values[pname]], "i", "i");
        },

        // ---- program pipelines
        "glGenProgramPipelines": (shadow, c, [n, names]) =>
        {
            query(shadow);
            if(n < 0) { fail(c, GL.INVALID_VALUE); return; }
            for(let i = 0; i < n && 4 * i + 4 <= names.size; i++)
            {
                let name = c.next3.pipeline;
                while(c.program_pipelines.has(name) || c.reserved3.pipeline.has(name)) name++;
                c.next3.pipeline = name + 1;
                c.reserved3.pipeline.add(name);
                names.view.setUint32(4 * i, name, true);
            }
        },
        "glDeleteProgramPipelines": (shadow, c, [n, names]) =>
        {
            if(n < 0) return fail(c, GL.INVALID_VALUE);
            for(const name of i32s(names).slice(0, n))
            {
                c.reserved3.pipeline.delete(name);
                c.program_pipelines.delete(name);
                if(c.program_pipeline === name) c.program_pipeline = 0;
            }
            return undefined;
        },
        "glIsProgramPipeline": (shadow, c, [name]) => { query(shadow); return c.program_pipelines.has(name) ? 1 : 0; },
        "glBindProgramPipeline": (shadow, c, [name]) =>
        {
            if(name && !pipeline_of(shadow, c, name, true)) return fail(c, GL.INVALID_OPERATION);
            if(current_tf(c).active && !current_tf(c).paused) return fail(c, GL.INVALID_OPERATION);
            c.program_pipeline = name;
            return undefined;
        },
        "glUseProgramStages": (shadow, c, [name, stages, p]) =>
        {
            if(stages !== GL31.ALL_BARRIER_BITS && stages & ~(GL31.VERTEX_SHADER_BIT | GL31.FRAGMENT_SHADER_BIT | GL31.COMPUTE_SHADER_BIT)) {
                return fail(c, GL.INVALID_VALUE);
            }
            const pipeline = pipeline_of(shadow, c, name, true);
            if(!pipeline) return fail(c, GL.INVALID_OPERATION);
            if(p)
            {
                const program = program_of(c, p);
                if(!program) return REFUSED;
                if(!program.separable || !program.info || !program.info.ok) return fail(c, GL.INVALID_OPERATION);
            }
            for(const bit of [GL31.VERTEX_SHADER_BIT, GL31.FRAGMENT_SHADER_BIT, GL31.COMPUTE_SHADER_BIT]) if(stages & bit) pipeline.stages[bit] = p;
            return undefined;
        },
        "glActiveShaderProgram": (shadow, c, [name, p]) =>
        {
            const pipeline = pipeline_of(shadow, c, name, true);
            if(!pipeline) return fail(c, GL.INVALID_OPERATION);
            if(p && !program_of(c, p)) return REFUSED;
            if(p && !c.group.objects.get(p).info?.ok) return fail(c, GL.INVALID_OPERATION);
            pipeline.active = p;
            return undefined;
        },
        "glValidateProgramPipeline": (shadow, c, [name]) =>
        {
            const pipeline = pipeline_of(shadow, c, name, true);
            if(!pipeline) return fail(c, GL.INVALID_OPERATION);
            validate(c, pipeline);
            return undefined;
        },
        "glGetProgramPipelineiv": (shadow, c, [name, pname, params]) =>
        {
            query(shadow);
            const pipeline = pipeline_of(shadow, c, name, true);
            if(!pipeline) { fail(c, GL.INVALID_OPERATION); return; }
            const values = { 0x8259: pipeline.active, 0x8B31: pipeline.stages[GL31.VERTEX_SHADER_BIT] || 0, 0x8B30: pipeline.stages[GL31.FRAGMENT_SHADER_BIT] || 0,
                0x91B9: pipeline.stages[GL31.COMPUTE_SHADER_BIT] || 0, 0x8B84: pipeline.log ? pipeline.log.length + 1 : 0, 0x8B83: pipeline.valid ? 1 : 0 };
            if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
            put(params, [values[pname]], "i", "i");
        },
        "glGetProgramPipelineInfoLog": (shadow, c, [name, size, length, log]) =>
        {
            query(shadow);
            const pipeline = pipeline_of(shadow, c, name, true);
            if(!pipeline) { fail(c, GL.INVALID_OPERATION); return; }
            const n = put_text(log, pipeline.log);
            if(length && length.size) length.view.setInt32(0, n, true);
            void size;
        },

        // ---- program interface queries
        "glGetProgramInterfaceiv": (shadow, c, [p, iface, pname, params]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return;
            const list = resources(program, iface);
            if(!list || ![0x92F5, 0x92F6, 0x92F7].includes(pname)) { fail(c, GL.INVALID_ENUM); return; }
            if(pname === 0x92F6 && iface === INTERFACES.ATOMIC_COUNTER_BUFFER) { fail(c, GL.INVALID_OPERATION); return; }
            if(pname === 0x92F7 && ![INTERFACES.UNIFORM_BLOCK, INTERFACES.SHADER_STORAGE_BLOCK, INTERFACES.ATOMIC_COUNTER_BUFFER].includes(iface)) {
                fail(c, GL.INVALID_OPERATION);
                return;
            }
            const value = pname === 0x92F5 ? list.length : pname === 0x92F6 ? list.reduce((n, r) => Math.max(n, r.name.length + 1), 0) :
                list.reduce((n, r) => Math.max(n, r.props[0x9304] || 0), 0);
            put(params, [value], "i", "i");
        },
        "glGetProgramResourceIndex": (shadow, c, [p, iface, name]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return 0xFFFFFFFF;
            const list = resources(program, iface);
            if(!list || iface === INTERFACES.ATOMIC_COUNTER_BUFFER) { fail(c, GL.INVALID_ENUM); return 0xFFFFFFFF; }
            const wanted = text_of(name);
            const index = list.findIndex(r => r.name === wanted || r.name === wanted + "[0]");
            return index < 0 ? 0xFFFFFFFF : index;
        },
        "glGetProgramResourceName": (shadow, c, [p, iface, index, size, length, name]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return;
            const list = resources(program, iface);
            if(!list || iface === INTERFACES.ATOMIC_COUNTER_BUFFER) { fail(c, GL.INVALID_ENUM); return; }
            if(index >= list.length) { fail(c, GL.INVALID_VALUE); return; }
            const n = put_text(name, list[index].name);
            if(length && length.size) length.view.setInt32(0, n, true);
            void size;
        },
        "glGetProgramResourceiv": (shadow, c, [p, iface, index, count, props, size, length, params]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return;
            const list = resources(program, iface);
            if(!list) { fail(c, GL.INVALID_ENUM); return; }
            if(index >= list.length || count <= 0 || size < 0) { fail(c, GL.INVALID_VALUE); return; }
            const r = list[index];
            const values = [];
            for(const prop of i32s(props).slice(0, count))
            {
                const v = prop === 0x92F9 ? (iface === INTERFACES.ATOMIC_COUNTER_BUFFER ? undefined : r.name.length + 1) : r.props[prop];
                if(v === undefined) { fail(c, GL.INVALID_OPERATION); return; }
                values.push(...Array.isArray(v) ? v : [v]);
            }
            put(params, values.slice(0, Math.max(0, size)), "i", "i");
            if(length && length.size) length.view.setInt32(0, Math.min(values.length, size), true);
        },
        "glGetProgramResourceLocation": (shadow, c, [p, iface, name]) =>
        {
            query(shadow);
            const program = program_of(c, p);
            if(!program) return -1;
            if(![INTERFACES.UNIFORM, INTERFACES.PROGRAM_INPUT, INTERFACES.PROGRAM_OUTPUT].includes(iface)) { fail(c, GL.INVALID_ENUM); return -1; }
            if(!program.info || !program.info.ok) { fail(c, GL.INVALID_OPERATION); return -1; }
            const wanted = text_of(name);
            if(iface === INTERFACES.UNIFORM)
            {
                const at = program.info.locations.get(wanted);
                return at === undefined ? -1 : at;
            }
            const r = resources(program, iface).find(x => x.name === wanted || x.name === wanted + "[0]");
            return r ? r.props[0x930E] : -1;
        },

        // ---- robustness (EXT_robustness): no context is ever lost
        "glGetGraphicsResetStatusEXT": shadow => { query(shadow); return 0; },
        "glGetnUniformfvEXT": (shadow, c, [p, location, size, params]) => H3["glGetUniformfv"](shadow, c, [p, location, params]),
        "glGetnUniformivEXT": (shadow, c, [p, location, size, params]) => H3["glGetUniformiv"](shadow, c, [p, location, params]),
    };

    /** glVertexAttribFormat / IFormat: an attribute's format, its offset in its binding point's vertex */
    function attrib_format(shadow, c, attrib, size, type, normalized, relative, integer)
    {
        if(attrib >= MAX_ATTRIBS || size < 1 || size > 4 || relative < 0 || relative > LIMITS31.MAX_VERTEX_ATTRIB_RELATIVE_OFFSET) {
            return fail(c, GL.INVALID_VALUE);
        }
        if(!c.vao) return fail(c, GL.INVALID_OPERATION);
        const types = integer ? [0x1400, 0x1401, 0x1402, 0x1403, 0x1404, 0x1405] :
            [0x1400, 0x1401, 0x1402, 0x1403, 0x1404, 0x1405, 0x1406, 0x140B, 0x140C, 0x8368, 0x8D9F];
        if(!types.includes(type)) return fail(c, GL.INVALID_ENUM);
        if((type === 0x8368 || type === 0x8D9F) && size !== 4) return fail(c, GL.INVALID_OPERATION);
        vertex_bindings(c);
        Object.assign(c.attribs[attrib], { size, type, normalized: !!normalized, integer, relative_offset: relative });
        follow_binding(c, c.attribs[attrib].binding);
        return undefined;
    }

    /** GLES 3.0's glVertexAttrib*Pointer in 3.1's model: binding point `index` holds the buffer, offset and stride */
    function pointer31(shadow, c, args, name)
    {
        const r = H3[name](shadow, c, args);
        if(r === REFUSED) return r;
        const index = args[0];
        const a = c.attribs[index];
        const bindings = vertex_bindings(c);
        const element = a.type === 0x8368 || a.type === 0x8D9F ? 4 : a.size * ({ 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x140B: 2, 0x8D61: 2 }[a.type] || 4);
        Object.assign(bindings[index], { buffer: a.buffer, offset: a.offset, stride: a.stride || element });
        a.binding = index;
        a.relative_offset = 0;
        // (the attribute reads its stride as GLES 3.0 gave it: 0 is tight)
        follow_binding(c, index);
        a.stride = a.stride === element && !args[name.includes("IPointer") ? 3 : 4] ? 0 : a.stride;
        return r;
    }

    /** glGetVertexAttrib* with GLES 3.1's VERTEX_ATTRIB_BINDING and _RELATIVE_OFFSET */
    function attrib_query31(shadow, c, [index, pname, params], as)
    {
        if(pname !== 0x82D4 && pname !== 0x82D5) return get_attrib3(shadow, c, index, pname, params, as);
        query(shadow);
        if(index >= MAX_ATTRIBS) { fail(c, GL.INVALID_VALUE); return undefined; }
        vertex_bindings(c);
        const a = c.attribs[index];
        put(params, [pname === 0x82D4 ? a.binding : a.relative_offset || 0], as === "f" ? "f" : "i", "i");
        return undefined;
    }

    /** glGetTexLevelParameter{i,f}v (GLES 3.1 8.10.3): a level's size, format and component sizes */
    function tex_level_parameter(shadow, c, [target, level, pname, params], as)
    {
        query(shadow);
        const face = target >= 0x8515 && target <= 0x851A ? target - 0x8515 : 0;
        const slot = target === GL.TEXTURE_2D ? SLOT.TEXTURE_2D : face || target === 0x8515 ? SLOT.TEXTURE_CUBE_MAP : target === GL.TEXTURE_3D ?
            SLOT.TEXTURE_3D : target === GL.TEXTURE_2D_ARRAY ? SLOT.TEXTURE_2D_ARRAY : target === GL31.TEXTURE_2D_MULTISAMPLE ? SLOT.TEXTURE_2D_MULTISAMPLE : -1;
        if(slot < 0) { fail(c, GL.INVALID_ENUM); return; }
        if(level < 0 || level > 31) { fail(c, GL.INVALID_VALUE); return; }
        const name = c.textures[c.active_texture][slot];
        const texture = name ? c.group.textures.get(name) : c.defaults && c.defaults.get(target);
        const image = texture && texture.images.get(face * 32 + level);
        const info = image && !image.compressed ? format_info(image.internal || image.format) : null;
        const bits = info ? info.bits : [0, 0, 0, 0, 0, 0];
        const kind = info ? info.kind : "";
        const type = k => !image ? 0 : bits[k] ? { unorm: 0x8C17, snorm: 0x8F9C, float: 0x1406, int: 0x1404, uint: 0x1405, depth: 0x8C17,
            depth_stencil: k === 5 ? 0x8C17 : 0x8C17 }[kind] || 0x8C17 : 0;
        const values = {
            0x1000: image ? image.width : 0, 0x1001: image ? image.height : 0, 0x8071: image ? image.depth || 1 : 0,
            0x1003: image ? image.internal || image.format : 0x1908, 0x805C: bits[0], 0x805D: bits[1], 0x805E: bits[2], 0x805F: bits[3],
            0x884A: bits[4], 0x88F1: bits[5], 0x8C3F: info && info.value === 0x8C3D ? 5 : 0, 0x8C10: type(0), 0x8C11: type(1), 0x8C12: type(2),
            0x8C13: type(3), 0x8C16: type(4), 0x9106: image && image.samples ? image.samples : 0, 0x9107: image ? (image.fixed_locations !== false ? 1 : 0) : 1,
            0x86A1: image && image.compressed ? 1 : 0, 0x86A0: image && image.compressed ? image.size || 0 : 0,
        };
        if(!(pname in values)) { fail(c, GL.INVALID_ENUM); return; }
        put(params, [values[pname]], as === "f" ? "f" : "i", "i");
    }

    // glUniform* and glProgramUniform*
    const uniforms = ["1f", "2f", "3f", "4f", "1i", "2i", "3i", "4i", "1ui", "2ui", "3ui", "4ui", "1fv", "2fv", "3fv", "4fv", "1iv", "2iv", "3iv", "4iv",
        "1uiv", "2uiv", "3uiv", "4uiv", "Matrix2fv", "Matrix3fv", "Matrix4fv", "Matrix2x3fv", "Matrix3x2fv", "Matrix2x4fv", "Matrix4x2fv",
        "Matrix3x4fv", "Matrix4x3fv"];
    for(const u of uniforms)
    {
        H["glProgramUniform" + u] = program_uniform("glUniform" + u);
        H["glUniform" + u] = uniform31("glUniform" + u);
    }
    void f32s;
    void status_of;
    void bound_buffer3;
    return H;
}

/** GLES 3.1's state values (glGet*), null for one not GLES 3.1's (then GLES 3.0's) */
export function state_value31(shadow, c, pname)
{
    const L = LIMITS31;
    switch(pname)
    {
        case 0x90DB: return [L.MAX_COMPUTE_SHADER_STORAGE_BLOCKS];
        case 0x91BB: return [L.MAX_COMPUTE_UNIFORM_BLOCKS];
        case 0x91BC: return [L.MAX_COMPUTE_TEXTURE_IMAGE_UNITS];
        case 0x91BD: return [L.MAX_COMPUTE_IMAGE_UNIFORMS];
        case 0x8262: return [L.MAX_COMPUTE_SHARED_MEMORY_SIZE];
        case 0x8263: return [L.MAX_COMPUTE_UNIFORM_COMPONENTS];
        case 0x8264: return [L.MAX_COMPUTE_ATOMIC_COUNTER_BUFFERS];
        case 0x8265: return [L.MAX_COMPUTE_ATOMIC_COUNTERS];
        case 0x8266: return [L.MAX_COMPUTE_UNIFORM_COMPONENTS + L.MAX_COMPUTE_UNIFORM_BLOCKS * LIMITS3.MAX_UNIFORM_BLOCK_SIZE / 4];
        case 0x90EB: return [L.MAX_COMPUTE_WORK_GROUP_INVOCATIONS];
        case 0x826E: return [L.MAX_UNIFORM_LOCATIONS];
        case 0x9315: return [L.MAX_FRAMEBUFFER_WIDTH];
        case 0x9316: return [L.MAX_FRAMEBUFFER_HEIGHT];
        case 0x9318: return [L.MAX_FRAMEBUFFER_SAMPLES];
        case 0x92CC: return [L.MAX_VERTEX_ATOMIC_COUNTER_BUFFERS];
        case 0x92D0: return [L.MAX_FRAGMENT_ATOMIC_COUNTER_BUFFERS];
        case 0x92D1: return [L.MAX_COMBINED_ATOMIC_COUNTER_BUFFERS];
        case 0x92D2: return [L.MAX_VERTEX_ATOMIC_COUNTERS];
        case 0x92D6: return [L.MAX_FRAGMENT_ATOMIC_COUNTERS];
        case 0x92D7: return [L.MAX_COMBINED_ATOMIC_COUNTERS];
        case 0x92D8: return [L.MAX_ATOMIC_COUNTER_BUFFER_SIZE];
        case 0x92DC: return [L.MAX_ATOMIC_COUNTER_BUFFER_BINDINGS];
        case 0x90CA: return [L.MAX_VERTEX_IMAGE_UNIFORMS];
        case 0x90CE: return [L.MAX_FRAGMENT_IMAGE_UNIFORMS];
        case 0x90CF: return [L.MAX_COMBINED_IMAGE_UNIFORMS];
        case 0x8F38: return [L.MAX_IMAGE_UNITS];
        case 0x90D6: return [L.MAX_VERTEX_SHADER_STORAGE_BLOCKS];
        case 0x90DA: return [L.MAX_FRAGMENT_SHADER_STORAGE_BLOCKS];
        case 0x90DC: return [L.MAX_COMBINED_SHADER_STORAGE_BLOCKS];
        case 0x90DD: return [L.MAX_SHADER_STORAGE_BUFFER_BINDINGS];
        case 0x90DE: return [L.MAX_SHADER_STORAGE_BLOCK_SIZE];
        case 0x90DF: return [L.SHADER_STORAGE_BUFFER_OFFSET_ALIGNMENT];
        case 0x8F39: return [L.MAX_COMBINED_SHADER_OUTPUT_RESOURCES];
        case 0x82D9: return [L.MAX_VERTEX_ATTRIB_RELATIVE_OFFSET];
        case 0x82DA: return [L.MAX_VERTEX_ATTRIB_BINDINGS];
        case 0x82E5: return [L.MAX_VERTEX_ATTRIB_STRIDE];
        case 0x8E59: return [L.MAX_SAMPLE_MASK_WORDS];
        case 0x910E: return [L.MAX_COLOR_TEXTURE_SAMPLES];
        case 0x910F: return [L.MAX_DEPTH_TEXTURE_SAMPLES];
        case 0x9110: return [L.MAX_INTEGER_SAMPLES];
        case 0x8E5E: return [L.MIN_PROGRAM_TEXTURE_GATHER_OFFSET];
        case 0x8E5F: return [L.MAX_PROGRAM_TEXTURE_GATHER_OFFSET];
        case 0x90EF: return [c.buffers.dispatch_indirect];
        case 0x8F43: return [c.buffers.draw_indirect];
        case 0x90D3: return [c.buffers.shader_storage];
        case 0x92C1: return [c.buffers.atomic_counter];
        case 0x825A: return [c.program_pipeline];
        case 0x9104: return [c.textures[c.active_texture][SLOT.TEXTURE_2D_MULTISAMPLE]];
        case 0x8E51: return [c.enabled.has(0x8E51) ? 1 : 0];
    }
    return null;
}
