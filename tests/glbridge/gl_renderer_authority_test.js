"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), { createRequire } = require("node:module");
const { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_render.js");
// A pristine product module, isolated from raw-renderer diagnostic helpers.
// The same source is bundled into the real guest acceptance page.
const filename = path.resolve(__dirname, "../../src/browser/glbridge/gl-webgpu/gl_executor.js"), product = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module: product, require: createRequire(filename), console, setTimeout, clearTimeout, performance }, { filename });
const bundle = { console, setTimeout, clearTimeout, performance, TextDecoder, TextEncoder, WebAssembly, URL };
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../../build/glbridge/libv86-webgpu.js"), "utf8"), bundle);
const sync = ["QUERY_ERROR", "QUERY_INTEGER", "QUERY_GL_STRING", "QUERY_LOCATION", "QUERY_UNIFORM", "QUERY_OBJECT_IV", "QUERY_OBJECT_LOG", "QUERY_ACTIVE",
    "CHECK_FRAMEBUFFER_STATUS", "QUERY_PROGRAM_IV_ARB", "QUERY_PROGRAM_PARAMETER_FV_ARB", "QUERY_PROGRAM_PARAMETER_DV_ARB", "QUERY_PROGRAM_STRING_ARB"];
(async () => {
    for (const Renderer of [product.exports.GLWebGPUExecutor, bundle.GLWebGPUExecutorModule.GLWebGPUExecutor, require("../../src/browser/glbridge/gl-webgpu/gl_executor.js").GLWebGPUExecutor]) for (const copied of [false, true]) {
        const { host } = createFakeHost(), gpu = new Renderer(null, { host, strict: true }); await gpu.initialize();
        gpu.submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).bytes(), {});
        for (const name of ["error", "errorQueue", "arbErrorString", "arbErrorPosition"]) assert.equal(Object.hasOwn(gpu.current, name), false, "renderer has no public GL error state");
        for (const method of ["setError", "queryInteger", "queryString", "queryObjectiv", "queryObjectLog", "queryLocation", "queryActive", "queryProgramivARB", "queryProgramParameterARB", "readUniform"])
            assert.equal(gpu[method], undefined, method + " must not exist in the product renderer");
        for (const name of sync) {
            const header = P.encodeRecord(name, { object_kind: P.C.V86GL_OBJECT_KIND_SHADER, data_size: 64, buf_size: 64 }), payload = new Uint8Array(header.length + 64); payload.fill(0xA5); payload.set(header);
            const source = new GLStream().record(P.GLFN[name], payload).bytes(), packet = copied ? source.slice() : source, before = packet.slice(), count = gpu.stats.refusals;
            gpu.submit(packet, {}); await gpu.idle();
            assert.deepEqual(packet, before, name + " cannot receive an answer from the page");
            assert.equal(gpu.stats.refusals, count + 1, name + " pending CPU query is a host invariant failure");
            assert.equal(Object.hasOwn(gpu.current, "error"), false);
        }
        const rejected = new GLStream().call("LINE_WIDTH", 7).record(P.rejectedOpcode(P.GLFN.LINE_WIDTH, GL.INVALID_OPERATION), new Uint8Array(new Float32Array([2]).buffer));
        gpu.submit(rejected.bytes(), {});assert.equal(gpu.current.lineWidth, 7, "old CPU rejection markers cannot apply arguments");
        gpu.submit(new GLStream().call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 7).programStringARB(GL.VERTEX_PROGRAM_ARB, "!!ARBvp1.0\nMOV result.position, vertex.position;\nEND").bytes(), {});
        for (const name of ["arbErrorString", "arbErrorPosition"]) { assert.equal(Object.hasOwn(gpu, name), false);assert.equal(Object.hasOwn(gpu.current, name), false); }
        gpu.submit(new GLStream().call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 0).bytes(), {});
        gpu.invalidState(GL.INVALID_OPERATION);
        assert.equal(Object.hasOwn(gpu.current, "error"), false);
        // Accepted CPU answers and failures are immutable at the page boundary.
        const shadow = new GLShadow(); shadow.setCapabilities(gpu.capabilities());
        const stream = new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("LINE_WIDTH", -1);
        stream.queryError();stream.queryInteger(GL.MAX_TEXTURE_SIZE);stream.queryString(GL.VENDOR, 64);
        const bytes = stream.bytes(), segments = shadow.process(bytes), answered = bytes.slice();
        for (const segment of segments) gpu.submit(copied ? bytes.slice(segment.offset, segment.offset + segment.length) : bytes.subarray(segment.offset, segment.offset + segment.length), {});
        await gpu.idle();assert.deepEqual(bytes, answered);assert.equal(shadow.current.error, GL.NO_ERROR);
        const draws = gpu.stats.draws;
        gpu.submit(new GLStream().call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, 0).call("VERTEX3F", 1, -1, 0).call("VERTEX3F", 0, 1, 0).call("END").bytes(), {});
        gpu.flushFrame();await gpu.idle();assert.equal(gpu.stats.draws, draws + 1, "an invariant report cannot poison later rendering");
        assert.equal(gpu.hostErrors.length, 0);assert.equal(Object.hasOwn(gpu.current, "error"), false);
    }
    console.log("gl_renderer_authority_test: pristine source and bundled renderers have no GL query helpers/error flag, never answers 13 CPU queries, preserves answers and keeps drawing in both modes passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
