// GLSL ES 1.00 on the CPU side (docs/gles-proxy-plan.md "影子状态"): the
// shadow state answers glGetShaderiv, glGetProgramiv, the info logs,
// glGetActiveUniform/Attrib and glGetUniform/AttribLocation itself, so it
// compiles and links with gl-webgpu's front end (gl_shader_translator.js,
// its ES mode) and turns the link's reflection into GL's view of the
// program: the active attributes and uniforms with their GL names, sizes and
// types, and every name glGetUniformLocation takes. The page's executor
// links the same sources with the same bindings, so the locations agree.

import "../browser/glbridge/gl-webgpu/gl_state_layout.js";
import "../browser/glbridge/gl-webgpu/gl_shader_translator.js";
import { GLSL_TYPES, sampler_type } from "./gles_formats.js";

/** @return {!Object} gl-webgpu's front end (set by the scripts above) */
function translator()
{
    return globalThis["GLShaderTranslator"];
}

/**
 * A shader compiled: whether it compiled, its log, and what linking needs
 * @param {string} source
 * @param {string} stage "vertex" or "fragment"
 * @return {{ok: boolean, log: string, result: !Object}}
 */
export function compile_shader(source, stage)
{
    // (a fault of the front end itself is the shader's error, never the machine's)
    let result;
    try
    {
        result = translator().compileShader(source, stage, { es: true });
    }
    catch(e)
    {
        return { ok: false, log: "ERROR: internal compiler error: " + (e && e.message || e), result: null };
    }
    return { ok: result.ok, log: result.log, result };
}

/**
 * An active uniform as GL lists it
 * @typedef {{name: string, size: number, type: number, location: number, components: number,
 *     base: string, sampler: boolean, int: boolean, bool: boolean, columns: number}}
 */
export let ActiveUniform;

/**
 * A program linked: GL's view of it
 * @typedef {{ok: boolean, log: string, attributes: !Array<{name: string, size: number, type: number, location: number}>,
 *     uniforms: !Array<!ActiveUniform>, locations: !Map<string, number>,
 *     by_location: !Array<{uniform: !ActiveUniform, element: number}>, reflection: ?Object,
 *     wgsl: ({vertex: string, fragment: string}|undefined)}}
 *     wgsl: the generated shaders, which the page's executor draws with
 */
export let ProgramInfo;

/**
 * Link two compiled shaders with the attribute bindings in force
 * @param {?Object} vs compile_shader's result
 * @param {?Object} fs
 * @param {!Map<string, number>} bindings glBindAttribLocation's
 * @return {!ProgramInfo}
 */
export function link_program(vs, fs, bindings)
{
    const empty = log => ({ ok: false, log, attributes: [], uniforms: [], locations: new Map(), by_location: [], reflection: null });
    if(!vs || !fs) return empty("ERROR: a program needs a vertex and a fragment shader");
    if(!vs.ok || !fs.ok) return empty("ERROR: " + (!vs.ok ? "the vertex" : "the fragment") + " shader is not compiled");
    let linked;
    try
    {
        linked = translator().linkProgram(vs.result, fs.result, { es: true, bindAttribLocations: bindings });
    }
    catch(e)
    {
        return empty("ERROR: internal linker error: " + (e && e.message || e));
    }
    if(!linked.ok) return empty(linked.log);
    const reflection = linked.reflection;
    const attributes = reflection.attributes.map(a => ({ name: a.name, size: 1, type: GLSL_TYPES[a.glslType], location: a.location }));
    /** @type {!Array<!ActiveUniform>} */
    const uniforms = [];
    for(const u of reflection.uniforms)
    {
        const size = Math.max(1, u.arraySize);
        uniforms.push({
            name: u.arraySize ? u.name + "[0]" : u.name, base: u.name, size, type: GLSL_TYPES[u.glslType], location: u.location,
            components: u.components, sampler: false, int: u.baseType === "int", bool: u.baseType === "bool", columns: u.columns,
        });
    }
    for(const s of reflection.samplers)
    {
        const size = Math.max(1, s.arraySize);
        uniforms.push({
            name: s.arraySize ? s.name + "[0]" : s.name, base: s.name, size, type: sampler_type(s.dim, s.external), location: s.location,
            components: 1, sampler: true, int: true, bool: false, columns: 0,
        });
    }
    // the names glGetUniformLocation takes: "a", "a[0]", ... "a[n-1]" for
    // an array, the name for anything else; and what each location is
    const locations = new Map();
    const by_location = [];
    for(const u of uniforms)
    {
        locations.set(u.base, u.location);
        for(let i = 0; i < u.size; i++)
        {
            if(u.size > 1 || u.name !== u.base) locations.set(u.base + "[" + i + "]", u.location + i);
            by_location[u.location + i] = { uniform: u, element: i };
        }
    }
    return { ok: true, log: linked.log, attributes, uniforms, locations, by_location, reflection,
        wgsl: { vertex: linked.wgslVertex, fragment: linked.wgslFragment } };
}
