"use strict";
const assert = require("node:assert/strict"), { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_stencil_ext.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"), { GLStream, GL } = require("./gl_stream_builder.js"), cases = require("./gl_stencil_ext_cases.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { createFakeHost } = require("./gl_fake_gpu.js"), reference = require("./gl_conformance/stencil_ext_reference.json").cases;
(async () => {
    for (const copied of [false, true]) {
        const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize(); shadow.setCapabilities(gpu.capabilities());
        const submit = s => {
            const bytes = s.bytes(), segments = shadow.process(bytes);
            for (const segment of segments || [{ offset: 0, length: bytes.length }]) {
                const part = segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length); gpu.submit(copied ? part.slice() : part, {});
            }
        };
        submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1));
        for (const entry of reference) {
            const stream = cases.phase(new GLStream(), entry.name), queries = entry.values && cases.queries(stream); submit(stream);
            assert.equal(shadow.current.error, entry.error, entry.name); shadow.current.error = 0;
            if (queries) assert.deepEqual(queries.map(q => { assert.equal(q.view.getUint32(P.F.QUERY_STATE.status, true), 1); return q.view.getFloat64(24, true); }), entry.values, entry.name);
            const values = shadow.current.state.values, ext = shadow.current.state.stencilExtBack, enabled = shadow.current.state.raster.enabled[GL.STENCIL_TEST_TWO_SIDE_EXT];
            for (const [key, front, back] of [["func", GL.STENCIL_FUNC, GL.STENCIL_BACK_FUNC], ["ref", GL.STENCIL_REF, GL.STENCIL_BACK_REF],
                ["valueMask", GL.STENCIL_VALUE_MASK, GL.STENCIL_BACK_VALUE_MASK], ["writeMask", GL.STENCIL_WRITEMASK, GL.STENCIL_BACK_WRITEMASK],
                ["fail", GL.STENCIL_FAIL, GL.STENCIL_BACK_FAIL], ["zfail", GL.STENCIL_PASS_DEPTH_FAIL, GL.STENCIL_BACK_PASS_DEPTH_FAIL], ["zpass", GL.STENCIL_PASS_DEPTH_PASS, GL.STENCIL_BACK_PASS_DEPTH_PASS]]) {
                assert.equal(gpu.current.stencil.front[key], values[front][0], entry.name + " front " + key);
                assert.equal(gpu.current.stencil.back[key], enabled ? ext[front] : values[back][0], entry.name + " effective back " + key);
            }
        }
        submit(new GLStream().call("DISABLE", GL.STENCIL_TEST_TWO_SIDE_EXT)); assert.equal(gpu.current.stencil.back.ref, 1234567);
        submit(new GLStream().call("ENABLE", GL.STENCIL_TEST_TWO_SIDE_EXT)); assert.equal(gpu.current.stencil.back.ref, 17);
        const saved = JSON.parse(JSON.stringify(shadow.getState())), restored = new GLShadow(); restored.setState(saved);
        for (const pname of cases.pnames) assert.deepEqual(restored.stateValue(pname), shadow.stateValue(pname));
        assert.deepEqual(restored.current.state.stencilExtBack, shadow.current.state.stencilExtBack);
        // Old snapshots contained one back bank. Keep their effective EXT
        // rendering until an updated guest issues independent setters.
        delete saved.typed[0][1].stencilExtBack; delete saved.typed[0][1].values[GL.ACTIVE_STENCIL_FACE_EXT]; restored.setState(saved);
        assert.equal(restored.stateValue(GL.ACTIVE_STENCIL_FACE_EXT)[0][0], GL.FRONT);
        assert.equal(restored.current.state.stencilExtBack[GL.STENCIL_REF], 1234567);
        assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0); await gpu.idle();
    }
    console.log("gl_stencil_ext_test: 18 native three-bank queries, effective GPU state, lists, attributes, invalid calls and snapshots passed in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
