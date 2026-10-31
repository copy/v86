#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const t = require("../../src/browser/glbridge/gl-webgpu/gl_shader_translator.js");
const { Glslang } = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const cases = require("./gl_shader_units_cases.js"), reference = require("./gl_conformance/shader_units_reference.json");
const naga = require("./naga.js").requireNaga("gl_shader_units_test");
if (!naga) process.exit(0);
const g = new Glslang(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm")));
const pack = entry => entry.vertex.map(source => ({ stage: 0, source })).concat(entry.fragment.map(source => ({ stage: 4, source })));
const unit = (sources, stage) => t.linkShaderUnits(sources.map(source => t.compileShader(source, stage, { library: true })), stage);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-shader-units-"));
try {
    for (const entry of cases) {
        assert.equal(g.link(pack(entry)).ok, reference[entry.name].link, entry.name);
        const result = t.linkProgram(unit(entry.vertex, "vertex"), unit(entry.fragment, "fragment"));
        assert.ok(result.ok, entry.name + ": " + result.log);
        for (const [stage, source] of [["vertex", result.wgslVertex], ["fragment", result.wgslFragment]]) {
            const file = path.join(dir, entry.name + "." + stage + ".wgsl");
            fs.writeFileSync(file, source); execFileSync(naga, [file], { stdio: "pipe" });
        }
        const shadow = new GLShadow(); shadow.setCapabilities(caps.capabilities({}, {})); shadow.setGlslang(g);
        const stream = new GLStream().makeCurrent(1, 0, 0, 4, 4, 1, 1);
        cases.appendProgram(stream, entry, 100);
        const link = stream.queryObjectiv(P.C.V86GL_OBJECT_KIND_PROGRAM, 100, GL.LINK_STATUS);
        const locations = (entry.updates || []).map(update => stream.queryLocation(P.C.V86GL_LOCATION_KIND_UNIFORM, 100, update.name, 64));
        shadow.process(stream.bytes());
        assert.equal(link.view.getInt32(P.F.QUERY_OBJECT_IV.value, true), 1, "compiled source snapshot: " + entry.name);
        assert.equal(shadow.stats.rejected, 0);
        const values = new GLStream(), reads = [];
        for (const [i, update] of (entry.updates || []).entries()) {
            const location = locations[i].view.getInt32(P.F.QUERY_LOCATION.result, true);
            assert.ok(location >= 0, update.name);
            if (update.matrix) values.uniformMatrixfv(location, update.matrix, update.count, false, update.value);
            else values[update.integer ? "uniformiv" : "uniformfv"](location, update.components, update.count, update.value);
            const components = update.matrix ? update.matrix ** 2 : update.components;
            for (let k = 0; k < update.count; ++k) reads.push({ record: values.queryUniform(100, location + k, 1, 64), expected: update.value.slice(k * components, (k + 1) * components) });
        }
        shadow.process(values.bytes());
        for (const { record, expected } of reads) {
            assert.equal(record.view.getUint32(P.F.QUERY_UNIFORM.status, true), P.C.V86GL_SYNC_QUERY_STATUS_OK);
            assert.equal(record.view.getInt32(P.F.QUERY_UNIFORM.value_count, true), expected.length);
            assert.deepEqual(expected.map((_, i) => record.view.getFloat32(32 + i * 4, true)), expected);
        }
    }
    const stages = (first, second) => pack({ vertex: [first + " float helper(); void main(){gl_Position=vec4(helper());}", second + " float helper(){return 0.0;}"], fragment: ["void main(){gl_FragColor=vec4(1.0);}"] });
    for (const [a, b] of [["float x=1.0;", "float x=2.0;"], ["vec4 x=vec4(1.0);", "vec4 x=vec4(1.0,2.0,1.0,1.0);"],
        ["const float x=1.0;", "const float x=2.0;"], ["float x;", "vec2 x;"], ["float x;", "uniform float x;"]])
        assert.equal(g.link(stages(a, b)).ok, false, "conflicting globals must fail: " + a + b);
    assert.equal(g.link(stages("vec4 x=vec4(0.5);", "vec4 x=vec4(1.0)/2.0;")).ok, true, "compare folded values");
    assert.equal(g.link(stages("float x;", "float x=0.5;")).ok, true, "a single initializer is allowed");
    const linked = t.linkProgram(unit(["float shared; float helper(); void main(){float x=helper();gl_Position=vec4(x+shared);}",
        "float shared=0.5;float helper(){shared+=0.25;return shared;}"], "vertex"), t.compileShader("void main(){gl_FragColor=vec4(1.0);}", "fragment"));
    assert.ok(linked.ok, linked.log);
    assert.equal(linked.wgslVertex.split("var<private> " + t.safeName("shared") + " ").length - 1, 1, "one storage cell for a shared global");
    assert.ok(linked.wgslVertex.includes(t.safeName("shared") + " = 0.5"));
    const library = t.compileShader("vec4 helper(){return vec4(1.0);}", "vertex", { library: true });
    assert.ok(library.ok, library.log);
    assert.equal(t.linkProgram(library, t.compileShader("void main(){gl_FragColor=vec4(1.0);}", "fragment")).ok, false);
    for (const [type, read] of [["float", "a[chosen].v[1]"], ["vec2", "a[chosen].v[1].x"], ["ivec3", "float(a[chosen].v[1].x)"], ["bvec2", "float(a[chosen].v[1].x)"]]) {
        const result = t.linkProgram(t.compileShader("void main(){gl_Position=gl_Vertex;}", "vertex"),
            t.compileShader("struct S{" + type + " v[2];};uniform S a[2];uniform int chosen;void main(){gl_FragColor=vec4(" + read + ");}", "fragment"));
        assert.ok(result.ok, result.log);
        const file = path.join(dir, "member-" + type + ".wgsl"); fs.writeFileSync(file, result.wgslFragment);
        execFileSync(naga, [file], { stdio: "pipe" });
    }
    console.log("PASS: shader compilation units, shared global initialization, compiled-source snapshots and WGSL validation");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
