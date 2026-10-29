#!/usr/bin/env node
// The GLES host's shader path on a corpus (docs/gles3-plan.md L1): glslang's
// check pass against what dEQP expects of each shader case, then for the
// programs that link the whole way to WGSL: the code pass (SPIR-V),
// glsl_program.js's interface and bindings, vx_naga, and naga's validation
// of the WGSL (when `naga` is installed; Tint's is
// tests/glbridge/gles_shader_browser_test.html, over the WGSL this writes).
//
// The corpus is dEQP's shader library (the .test files of CTS 7.1's
// com.drawelements.deqp.apk: gles2, gles3 and gles31 shaders), filled in
// as dEQP's ShaderLibrary does (simplified: inputs are uniforms, outputs
// globals), and this file's own GLSL ES 3.10/3.20 cases. Without the APK
// (build/a32-android/cts, tools/a32_cts.mjs) only the own cases run.
//
//   node tests/gles/shader_corpus.mjs [--naga] [--filter regexp] [--wgsl file] [--verbose]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compile_glslang, create_glslang, STAGE } from "../../src/gles/glslang.js";
import { link_glslang_program } from "../../src/gles/glsl_program.js";
import { es3_rules, glsl_version } from "../../src/gles/glsl_es_rewrite.js";
import { glslang_limits } from "../../src/gles/gles31_state.js";
import { zip_entries, zip_read } from "../../src/android/zip.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
const argv = process.argv.slice(2);
const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const verbose = argv.includes("--verbose");
const filter = option("--filter") ? new RegExp(option("--filter")) : null;
const LIMITS = { maxVaryingVectors: 15, maxDrawBuffers: 4 };

const glslang = await create_glslang(await compile_glslang(fs.readFileSync(root + "bios/glslang.wasm")));
glslang.set_limits({ MaxDrawBuffers: 4, MaxVaryingVectors: 15 });

// ---- vx_naga (no imports)
const naga_wasm = root + "build/glbridge/vx_naga.wasm";
const naga = fs.existsSync(naga_wasm) ? (await WebAssembly.instantiate(fs.readFileSync(naga_wasm), {})).instance.exports : null;
function translate(words)
{
    const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
    const input = naga.vx_alloc(bytes.length);
    new Uint8Array(naga.memory.buffer, input, bytes.length).set(bytes);
    const out = naga.vx_translate(input, bytes.length, 3, 0, 0, 0, 0, 0, 0);
    naga.vx_free(input, bytes.length);
    const length = new DataView(naga.memory.buffer).getUint32(out, true);
    const text = new TextDecoder().decode(new Uint8Array(naga.memory.buffer, out + 4, length));
    naga.vx_free(out, length + 4);
    return JSON.parse(text);
}

// ---- naga's CLI, for the WGSL
function find_naga()
{
    if(process.env.GL_NAGA) return process.env.GL_NAGA;
    const cargo = path.join(os.homedir(), ".cargo", "bin", "naga");
    return fs.existsSync(cargo) ? cargo : null;
}
const naga_cli = argv.includes("--naga") ? find_naga() : null;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gles-corpus-"));
function validate_wgsl(label, wgsl)
{
    const file = path.join(scratch, label.replace(/[^A-Za-z0-9_.-]/g, "_").slice(-120) + ".wgsl");
    fs.writeFileSync(file, wgsl);
    const r = spawnSync(naga_cli, [file], { encoding: "utf8" });
    return r.status === 0 ? null : (r.stderr || r.stdout).split("\n").slice(0, 8).join("\n");
}

// ---- dEQP's .test files
/**
 * @param {string} text
 * @return {!Array<!Object>} the cases: {name, version, expect, requires, values, sources: {both|vertex|...}}
 */
function parse_tests(text, prefix)
{
    const lines = text.split("\n");
    const cases = [];
    const groups = [];
    let current = null;
    for(let i = 0; i < lines.length; i++)
    {
        const line = lines[i].trim();
        if(!line || line.startsWith("#")) continue;
        let m;
        if((m = /^group\s+(\S+)/.exec(line))) { groups.push(m[1]); continue; }
        if((m = /^case\s+(\S+)/.exec(line)))
        {
            current = { name: prefix + [...groups, m[1]].join("."), version: "100", expect: "pass", requires: [], values: [], sources: {}, skip: null };
            continue;
        }
        if(line === "end")
        {
            if(current) { cases.push(current); current = null; }
            else groups.pop();
            continue;
        }
        if(!current) continue;
        if((m = /^version\s+(.+)$/.exec(line))) current.version = m[1].trim();
        else if((m = /^expect\s+(\S+)/.exec(line))) current.expect = m[1];
        else if(line.startsWith("require")) current.requires.push(line);
        else if(line.startsWith("pipeline_program") || line.startsWith("active_stages")) current.skip = "separable pipeline";
        else if(line.startsWith("values"))
        {
            let body = line;
            while(!body.includes("}")) body += " " + lines[++i];
            for(const v of body.slice(body.indexOf("{") + 1, body.lastIndexOf("}")).split(";"))
            {
                const d = /^\s*(input|output|uniform)\s+(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\[[^\]]*\])?\s*=/.exec(v);
                if(d) current.values.push({ kind: d[1], type: d[2], name: d[3] });
            }
        }
        else if((m = /^(both|vertex|fragment|geometry|tessellation_control|tessellation_evaluation)\s+""\s*$/.exec(line)))
        {
            const body = [];
            while(++i < lines.length && lines[i].trim() !== "\"\"") body.push(lines[i]);
            current.sources[m[1]] = body.join("\n");
        }
    }
    return cases;
}

const EXTENSIONS_WE_HAVE = /GL_EXT_geometry_shader|GL_EXT_tessellation_shader|GL_EXT_shader_io_blocks|GL_OES_geometry_shader|GL_OES_tessellation_shader|GL_OES_shader_io_blocks/;

/** The programs a case runs: dEQP's specialization, simplified */
function specialize(c)
{
    const es = !/^100\b/.test(c.version);
    const version_line = es ? "#version " + c.version + "\n" : "";
    const frag_color = es ? "dEQP_FragColor" : "gl_FragColor";
    const precision = t => /^(lowp|mediump|highp)\b/.test(t) || /^(bool|bvec)/.test(t) ? "" : (/^(u?int|[iu]vec)/.test(t) ? "highp " : "mediump ");
    const inputs = c.values.filter(v => v.kind === "input"), outputs = c.values.filter(v => v.kind === "output");
    const uniforms = c.values.filter(v => v.kind === "uniform");
    // (inputs: uniforms, copied into locals by ${SETUP} where there is one)
    const has_setup = Object.values(c.sources).some(s => /\$\{(VERTEX_)?SETUP\}/.test(s));
    const prefix = has_setup ? "u_" : "";
    const uniform_decls = [...inputs.map(v => "uniform " + precision(v.type) + v.type + " " + prefix + v.name + ";"),
        ...uniforms.map(v => "uniform " + precision(v.type) + v.type + " " + v.name + ";")].join("\n");
    const setup = inputs.map(v => v.type + " " + v.name + " = u_" + v.name + ";").join("\n");
    const output_decls = outputs.map(v => precision(v.type) + v.type + " " + v.name + ";").join("\n");
    const position = (es ? "in" : "attribute") + " highp vec4 dEQP_Position;";
    const frag_out = es ? "layout(location = 0) out mediump vec4 dEQP_FragColor;" : "";
    const extension_lines = {};
    for(const r of c.requires)
    {
        const m = /extension\s*\{([^}]*)\}(?:\s*in\s*\{([^}]*)\})?/.exec(r);
        if(!m) { if(/limit "GL_MAX_VERTEX_(SHADER_STORAGE_BLOCKS|IMAGE_UNIFORMS|ATOMIC_COUNTERS)"/.test(r)) return { skip: "a vertex-stage limit of 0" }; continue; }
        const names = m[1].split("|").map(s => s.trim().replace(/"/g, ""));
        const name = names.find(n => EXTENSIONS_WE_HAVE.test(n));
        if(!name) return { skip: "extension " + names.join("|") };
        const stages = m[2] ? m[2].split(",").map(s => s.trim()) : ["vertex", "fragment", "geometry", "tessellation_control", "tessellation_evaluation"];
        for(const s of stages) extension_lines[s] = (extension_lines[s] || "") + "#extension " + name + " : require\n";
    }
    const fill = (source, stage, variant) =>
    {
        const decls = stage === "vertex" ? [position, uniform_decls, variant === "vertex" ? output_decls : ""].join("\n") :
            stage === "fragment" ? [frag_out, uniform_decls, variant !== "vertex" ? output_decls : ""].join("\n") : "";
        let s = source;
        if(!/^\s*#version/.test(s)) s = version_line + s;
        if(extension_lines[stage]) s = s.replace(/^(\s*#version[^\n]*\n)/, "$1" + extension_lines[stage]);
        return s.replace(/\$\{DECLARATIONS\}/g, decls)
            .replace(/\$\{VERTEX_DECLARATIONS\}/g, [position, uniform_decls].join("\n"))
            .replace(/\$\{FRAGMENT_DECLARATIONS\}/g, [frag_out, uniform_decls, output_decls].join("\n"))
            .replace(/\$\{GEOMETRY_DECLARATIONS\}/g, "layout (triangles) in;\nlayout (triangle_strip, max_vertices=3) out;")
            .replace(/\$\{TESSELLATION_CONTROL_DECLARATIONS\}/g, "layout (vertices=3) out;")
            .replace(/\$\{TESSELLATION_EVALUATION_DECLARATIONS\}/g, "layout (triangles) in;")
            .replace(/\$\{TESSELLATION_CONTROL_OUTPUT\}/g, "gl_out[gl_InvocationID].gl_Position = gl_in[gl_InvocationID].gl_Position;")
            .replace(/\$\{TESSELLATION_EVALUATION_OUTPUT\}/g, "gl_Position = gl_in[0].gl_Position;")
            .replace(/\$\{GL_MAX_PATCH_VERTICES\}/g, "32")
            .replace(/\$\{SETUP\}|\$\{VERTEX_SETUP\}/g, setup)
            .replace(/\$\{POSITION_FRAG_COLOR\}/g, stage === "vertex" ? "gl_Position" : frag_color)
            .replace(/\$\{FRAG_COLOR\}/g, frag_color)
            .replace(/\$\{VERTEX_OUTPUT\}/g, "gl_Position = dEQP_Position;")
            .replace(/\$\{FRAGMENT_OUTPUT\}/g, frag_color + " = vec4(1.0);")
            .replace(/\$\{OUTPUT\}/g, stage === "vertex" ? "gl_Position = dEQP_Position;" : frag_color + " = vec4(1.0);");
    };
    const plain_vs = version_line + position + "\nvoid main() { gl_Position = dEQP_Position; }\n";
    const plain_fs = version_line + "precision mediump float;\n" + frag_out + "\nvoid main() { " + frag_color + " = vec4(1.0); }\n";
    const programs = [];
    if(c.sources.both !== undefined)
    {
        programs.push({ variant: "vertex", shaders: [{ stage: "vertex", source: fill(c.sources.both, "vertex", "vertex") },
            { stage: "fragment", source: fill(plain_fs, "fragment", "vertex") }] });
        programs.push({ variant: "fragment", shaders: [{ stage: "vertex", source: fill(plain_vs, "vertex", "fragment") },
            { stage: "fragment", source: fill(c.sources.both, "fragment", "fragment") }] });
    }
    else
    {
        const shaders = [];
        for(const stage of ["vertex", "tessellation_control", "tessellation_evaluation", "geometry", "fragment"])
        {
            if(c.sources[stage] === undefined) continue;
            const name = { tessellation_control: "tess_control", tessellation_evaluation: "tess_evaluation" }[stage] || stage;
            shaders.push({ stage: name, source: fill(c.sources[stage], stage, "separate") });
        }
        programs.push({ variant: "program", shaders });
    }
    return { programs };
}

// ---- this file's own cases: GLSL ES 3.10 and 3.20 that dEQP's library does not cover
const OWN = [
    { name: "own.compute_ssbo_atomics_images", expect: "pass", shaders: [{ stage: "compute", source: `#version 310 es
layout(local_size_x = 8, local_size_y = 4) in;
layout(std430, binding = 1) buffer B { uint n; int m; float v[]; } b;
layout(binding = 0) uniform atomic_uint counter;
layout(rgba8, binding = 2) writeonly uniform highp image2D img;
layout(r32ui, binding = 3) uniform highp uimage2D counts;
shared float s[32];
void main() {
    uint i = gl_LocalInvocationIndex;
    s[i] = b.v[i];
    barrier();
    b.v[i] = s[31u - i];
    atomicCounterIncrement(counter);
    imageStore(img, ivec2(gl_GlobalInvocationID.xy), vec4(1.0));
    imageStore(counts, ivec2(gl_GlobalInvocationID.xy), imageLoad(counts, ivec2(0)) + uvec4(1u));
    atomicAdd(b.n, 1u);
    atomicMin(b.m, -int(i));
}` }] },
    { name: "own.es300_ubo_mrt_integer", expect: "pass", shaders: [{ stage: "vertex", source: `#version 300 es
layout(location = 1) in vec4 pos;
in ivec2 id;
uniform Block { mat4 mvp; vec2 off[3]; } blk;
flat out ivec2 vid;
out vec2 tc;
void main() { vid = id; tc = blk.off[gl_VertexID % 3]; gl_Position = blk.mvp * pos; }` }, { stage: "fragment", source: `#version 300 es
precision highp float;
precision highp usampler2D;
precision mediump sampler2DArray;
uniform usampler2D utex;
uniform sampler2DArray arr;
flat in ivec2 vid;
in vec2 tc;
layout(location = 0) out vec4 c0;
layout(location = 1) out uvec4 c1;
void main() { c0 = texture(arr, vec3(tc, 1.0)); c1 = texelFetch(utex, vid, 0) + uvec4(textureSize(utex, 0), 0, 0); }` }] },
    // (instance arrays of storage blocks whose last member is an unsized array of structs, arrays or matrices: element 1's block
    // alone, the split array's types gone although a member's offset is the pointer type's id, dEQP-GLES31
    // ssbo.layout.unsized_struct_array and 2_level_unsized_struct_array's *_instance_array)
    ...["S s[];", "S s[][2];", "mat2x4 s[][2];"].map((member, i) => ({ name: "own.ssbo_instance_array_unsized_" + i, expect: "pass", shaders: [
        { stage: "compute", source: `#version 310 es
layout(local_size_x = 1) in;
struct S { highp ivec3 a; highp vec4 c; };
layout(std430, binding = 0) buffer Block { lowp uint u; mediump vec4 v; ${member} } b[3];
void main() { b[1].u = uint(b[1].s.length()); }` }] })),
    // (an unused storage block of an unsized array of row major matrices, which layout.rs lays out again: the old pointer type gone
    // although the int type's width is its id, dEQP-GLES31 ssbo.layout.random.nested_structs.3)
    { name: "own.ssbo_unused_row_major_unsized", expect: "pass", shaders: [{ stage: "compute", source: `#version 310 es
layout(local_size_x = 1) in;
layout(row_major, binding = 0) buffer BlockB { highp mat3x2 a[]; };
layout(binding = 0) uniform atomic_uint ac_numPassed;
void main() { bool allOk = true; if(allOk) atomicCounterIncrement(ac_numPassed); }` }] },
    { name: "own.es320_geometry", expect: "pass", shaders: [
        { stage: "vertex", source: "#version 320 es\nin vec4 pos;\nout vec2 tc;\nvoid main(){ tc = pos.xy; gl_Position = pos; }" },
        { stage: "geometry", source: "#version 320 es\nlayout(triangles) in;\nlayout(triangle_strip, max_vertices=3) out;\nin vec2 tc[];\nout vec2 gtc;\nvoid main(){ for(int i=0;i<3;i++){ gtc = tc[i]; gl_Position = gl_in[i].gl_Position; EmitVertex(); } EndPrimitive(); }" },
        { stage: "fragment", source: "#version 320 es\nprecision mediump float;\nin vec2 gtc;\nout vec4 c;\nvoid main(){ c = vec4(gtc, 0.0, 1.0); }" }] },
];

// ---- the run
const stats = { cases: 0, skipped: 0, programs: 0, agree: 0, disagree: 0, linked: 0, link_errors: 0, spirv: 0,
    naga_ok: 0, naga_errors: 0, wgsl_ok: 0, wgsl_errors: 0, stage_unsupported: 0, check_ms: 0, code_ms: 0 };
const disagreements = [], failures = [];
let own_failures = 0;
const wgsl_out = [];
/** @param {!Object} program @param {string} expect @param {string} label @param {string=} known an expected failure's reason */
function run_program(label, shaders, expect, known)
{
    stats.programs++;
    // the check pass, shader by shader then linked: what dEQP expects
    const t0 = performance.now();
    // (with the GLSL ES rules the shadow adds to glslang's check and its limits, gles_shadow.js's compile)
    glslang.set_limits(glslang_limits(glsl_version(shaders[0].source)));
    const compiled = shaders.map(s =>
    {
        const checked = glslang.check_shader(STAGE[s.stage], s.source);
        const refused = checked.ok ? es3_rules(s.source) : null;
        return refused ? { ok: false, log: refused } : checked;
    });
    const compiles = compiled.every(c => c.ok);
    const t1 = performance.now();
    const linked = compiles ? link_glslang_program(glslang, shaders, { limits: LIMITS }) : null;
    const t2 = performance.now();
    stats.check_ms += t1 - t0;
    stats.code_ms += t2 - t1;
    const links = !!(linked && linked.ok);
    const ok = expect === "compile_fail" ? !compiles : expect === "link_fail" ? compiles && !links :
        expect === "compile_or_link_fail" ? !links : links;
    if(ok) stats.agree++;
    else
    {
        stats.disagree++;
        if(label.startsWith("own.")) own_failures++;
        disagreements.push(label + ": expected " + expect + ", " + (!compiles ? "did not compile: " + compiled.map(c => c.log).join(" ").slice(0, 300) :
            !links ? "did not link: " + (linked && linked.log || "").slice(0, 300) : "built"));
    }
    if(!links) return;
    stats.linked++;
    for(const module of linked.spirv)
    {
        stats.spirv++;
        if(!naga) continue;
        if(module.stage !== "vertex" && module.stage !== "fragment" && module.stage !== "compute") { stats.stage_unsupported++; continue; }
        let t;
        try { t = translate(module.words); }
        catch(e) { t = { error: "vx_naga panicked: " + e.message }; }
        if(t.error)
        {
            stats.naga_errors++;
            failures.push(label + " " + module.stage + ": " + t.error.slice(0, 400));
            if(label.startsWith("own.") && !known) own_failures++;
            continue;
        }
        stats.naga_ok++;
        const wgsl = "diagnostic(off, derivative_uniformity);\n" + t.wgsl;
        wgsl_out.push({ label: label + "." + module.stage, wgsl });
        if(naga_cli)
        {
            const error = validate_wgsl(label + "." + module.stage, wgsl);
            if(error) { stats.wgsl_errors++; failures.push(label + " " + module.stage + " WGSL: " + error); }
            else stats.wgsl_ok++;
        }
    }
}

const apk = root + "build/a32-android/cts/com.drawelements.deqp.apk";
if(fs.existsSync(apk))
{
    const fd = fs.openSync(apk, "r");
    const size = fs.fstatSync(fd).size;
    const read = async(offset, length) => { const b = Buffer.alloc(length); fs.readSync(fd, b, 0, length, offset); return new Uint8Array(b); };
    const entries = await zip_entries(read, size);
    for(const e of entries.filter(e => /^assets\/gles(2|3|31)\/shaders\/.*\.test$/.test(e.name)))
    {
        const api = /assets\/(gles\d+)\//.exec(e.name)[1];
        const prefix = "dEQP-" + api.toUpperCase() + ".functional.shaders." + path.basename(e.name, ".test") + ".";
        const text = new TextDecoder().decode(await zip_read(read, e));
        for(const c of parse_tests(text, prefix))
        {
            if(filter && !filter.test(c.name)) continue;
            stats.cases++;
            if(c.skip) { stats.skipped++; continue; }
            const s = specialize(c);
            if(s.skip) { stats.skipped++; continue; }
            for(const p of s.programs) run_program(c.name + (s.programs.length > 1 ? "." + p.variant : ""), p.shaders, c.expect === "build_successful" ? "pass" : c.expect);
        }
    }
    fs.closeSync(fd);
}
else console.log("(no " + apk + ": dEQP's shader library not run; tools/a32_cts.mjs --download)");
for(const c of OWN)
{
    if(filter && !filter.test(c.name)) continue;
    stats.cases++;
    run_program(c.name, c.shaders, c.expect, c.known);
}

if(verbose) for(const d of disagreements) console.log("DISAGREE " + d);
for(const f of failures.slice(0, verbose ? failures.length : 15)) console.log("FAIL " + f);
if(!verbose && disagreements.length) console.log(disagreements.slice(0, 10).map(d => "DISAGREE " + d).join("\n"));
console.log(JSON.stringify(stats));
if(option("--wgsl")) fs.writeFileSync(option("--wgsl"), JSON.stringify(wgsl_out));
fs.rmSync(scratch, { recursive: true, force: true });
// (what L1 reached, docs/gles3-plan.md: a fall below it is a regression)
const deqp_programs = stats.programs - OWN.length;
const regressed = own_failures || stats.wgsl_errors || deqp_programs > 0 && (stats.agree < 0.98 * stats.programs || stats.naga_errors > 2);
if(regressed) console.log("FAIL: below L5's results (own cases, 98% agreement with dEQP, 2 vx_naga errors, no WGSL errors)");
process.exit(regressed ? 1 : 0);
