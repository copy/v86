// E0 gate: actual desktop parse -> SPIR-V -> vx_naga -> independent Naga.
// Usage: node tools/glslang/desktop_spirv_probe.mjs EXPERIMENT.wasm [OUTPUT]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire as create_require } from "node:module";
import { spawnSync } from "node:child_process";
const require = create_require(import.meta.url);
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
const naga_cli = require("../../tests/glbridge/naga.js").requireNaga("E0");
require("../../tests/glbridge/cube2_glsl_direct_corpus_r6889.js");
const cases = [...globalThis.CUBE2_DIRECT_GLSL_CORPUS_R6889.map(c => ({ ...c, name: "cube2_" + c.name })),
    ...require("../../tests/glbridge/gl_glsl120_codegen_cases.js").map(c => ({ ...c, name: "glsl120_" + c.name }))];
const output_dir = path.resolve(process.argv[3] || "build/gl-e0-results");
fs.mkdirSync(output_dir, { recursive: true });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const wasm = fs.readFileSync(process.argv[2]), module_wasm = new WebAssembly.Module(wasm);
const production = fs.readFileSync("bios/glslang.wasm"), authority = new Glslang(production);
const naga_bytes = fs.readFileSync("build/glbridge/vx_naga.wasm");
const naga = new WebAssembly.Instance(new WebAssembly.Module(naga_bytes), {}).exports;
function spirv(compiler, shaders, flags)
{
    const packed = Glslang.pack(shaders);
    compiler.withBytes(packed, ptr => compiler.exports.v86_glslang_spirv(ptr, packed.length, flags));
    const bytes = compiler.memory().slice(compiler.exports.v86_glslang_output(), compiler.exports.v86_glslang_output() + compiler.exports.v86_glslang_output_size());
    const view = new DataView(bytes.buffer), length = view.getUint32(0, true);
    const result = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
    result.modules = [];
    for(let at = 4 + length + 3 & ~3; at + 8 <= bytes.length;)
    {
        const stage = view.getUint32(at, true), count = view.getUint32(at + 4, true);
        result.modules.push({ stage, bytes: bytes.slice(at + 8, at + 8 + count * 4) });
        at += 8 + count * 4;
    }
    return result;
}
function translate(bytes)
{
    const ptr = naga.vx_alloc(bytes.length);
    new Uint8Array(naga.memory.buffer, ptr, bytes.length).set(bytes);
    const output = naga.vx_translate(ptr, bytes.length, 3, 0, 0, 0, 0, 0, 0);
    naga.vx_free(ptr, bytes.length);
    const length = new DataView(naga.memory.buffer).getUint32(output, true);
    const result = JSON.parse(new TextDecoder().decode(new Uint8Array(naga.memory.buffer, output + 4, length)));
    naga.vx_free(output, length + 4);
    return result;
}
const report = { experiment_sha256: hash(wasm), production_sha256: hash(production), vx_naga_sha256: hash(naga_bytes),
    routes: [], tint_modules: [], gles_reference_ms: [] };
for(const flags of [2, 6])
{
    const route = { flags, name: flags === 2 ? "relaxed-version-patch" : "typed-IR-lowering", cases: [] };
    for(const item of cases)
    {
        const shaders = [{ stage: 0, source: item.vertex }, { stage: 4, source: item.fragment }];
        const checked = authority.link(shaders);
        if(!checked.ok) throw new Error(item.name + ": invalid desktop corpus: " + checked.log);
        const compiler = new Glslang(module_wasm), entry = { name: item.name, source_sha256: hash(item.vertex + "\0" + item.fragment), ok: false, stages: [] };
        try
        {
            // Warm the same compiler, then time the complete pair three times.
            let result = spirv(compiler, shaders, flags);
            entry.ms = [];
            for(let i = 0; i < 3; i++)
            {
                const start = performance.now();result = spirv(compiler, shaders, flags);
                entry.ms.push(performance.now() - start);
            }
            entry.log = result.log;entry.ok = result.ok;
            if(result.ok) for(const module of result.modules)
            {
                const converted = translate(module.bytes), stage = { stage: module.stage, ok: !!converted.wgsl, error: converted.error };
                if(converted.wgsl)
                {
                    const filename = flags + "-" + item.name + "-" + module.stage + ".wgsl";
                    fs.writeFileSync(path.join(output_dir, filename), converted.wgsl);
                    const validated = spawnSync(naga_cli, [path.join(output_dir, filename)], { encoding: "utf8" });
                    stage.ok = validated.status === 0;stage.error = stage.ok ? undefined : validated.stderr;
                    report.tint_modules.push({ filename, route: flags, case: item.name, stage: module.stage, code: converted.wgsl });
                }
                entry.stages.push(stage);entry.ok &&= stage.ok;
            }
        }
        catch(error) {entry.log = String(error.stack);entry.ok = false;}
        route.cases.push(entry);
        console.log(flags, item.name, entry.ok ? "PASS" : "FAIL", (entry.stages.find(s => !s.ok)?.error || entry.log || "").slice(0, 160));
    }
    report.routes.push(route);
}
const es_shaders = [{ stage: 0, source: "attribute vec4 p;void main(){gl_Position=p;}" },
    { stage: 4, source: "precision mediump float;void main(){gl_FragColor=vec4(0.25,0.5,0.75,1.0);}" }];
spirv(authority, es_shaders, 0);
for(let i = 0; i < 30; i++)
{
    const start = performance.now();const result = spirv(authority, es_shaders, 0);
    if(!result.ok) throw new Error(result.log);
    for(const module of result.modules) if(!translate(module.bytes).wgsl) throw new Error("GLES reference failed");
    report.gles_reference_ms.push(performance.now() - start);
}
if(hash(fs.readFileSync("bios/glslang.wasm")) !== report.production_sha256) throw new Error("production compiler changed");
fs.writeFileSync(path.join(output_dir, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.routes.map(r => ({ route: r.name, passed: r.cases.filter(c => c.ok).length, total: r.cases.length }))));
