"use strict";
const assert = require("node:assert/strict"), { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"), { GLStream, GL } = require("./gl_stream_builder.js"), cases = require("./gl_program_matrix_cases.js"),
    { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { createFakeHost } = require("./gl_fake_gpu.js"), reference = require("./gl_conformance/program_matrices_reference.json");
const read = q => { assert.equal(q.view.getUint32(P.F.QUERY_STATE.status, true), 1); return Array.from({ length: q.view.getUint32(P.F.QUERY_STATE.count, true) }, (_, i) => q.view.getFloat64(24 + i * 8, true)); };
(async () => {
    for (const copied of [false, true]) {
        const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize(); shadow.setCapabilities(gpu.capabilities());
        const submit = s => {
            const bytes = s.bytes(), segments = shadow.process(bytes);
            for (const segment of segments || [{ offset: 0, length: bytes.length }]) { const part = segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length); gpu.submit(copied ? part.slice() : part, {}); }
        };
        const initial = new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1), count = cases.query(initial, GL.MAX_PROGRAM_MATRICES_ARB, 1), limit = cases.query(initial, GL.MAX_PROGRAM_MATRIX_STACK_DEPTH_ARB, 1); submit(initial);
        assert.deepEqual(read(count), [reference.count]); assert.deepEqual(read(limit), [reference.limit]);
        for (const entry of reference.cases) {
            const stream = cases.phase(new GLStream(), entry.name), matrix = cases.query(stream, GL.CURRENT_MATRIX_ARB, 16), transpose = cases.query(stream, GL.TRANSPOSE_CURRENT_MATRIX_ARB, 16),
                depth = cases.query(stream, GL.CURRENT_MATRIX_STACK_DEPTH_ARB, 1), mode = cases.query(stream, GL.MATRIX_MODE, 1); submit(stream);
            assert.equal(shadow.current.error, entry.error, entry.name); shadow.current.error = 0;
            assert.deepEqual(read(matrix), entry.matrix, entry.name); assert.deepEqual(read(transpose), entry.transpose, entry.name + " transpose");
            assert.deepEqual(read(depth), [entry.depth], entry.name + " depth"); assert.deepEqual(read(mode), [entry.mode]);
            assert.deepEqual(Array.from(gpu.topMatrix()), entry.matrix, entry.name + " GPU"); assert.equal(gpu.stackFor(entry.mode).length, entry.depth);
        }
        const restored = new GLShadow(), saved = JSON.parse(JSON.stringify(shadow.getState())); restored.setState(saved);
        assert.deepEqual(restored.current.state.stacks, shadow.current.state.stacks);
        for (let i = 0; i < 8; ++i) delete saved.typed[0][1].stacks[GL.MATRIX0_ARB + i]; restored.setState(saved);
        assert.equal(restored.current.state.stacks[GL.MATRIX0_ARB + 7][0][0], 1);
        submit(new GLStream().makeCurrent(2, 0, 0, 16, 16, 2, 1).call("MATRIX_MODE", GL.MATRIX0_ARB)); assert.equal(shadow.stateValue(GL.CURRENT_MATRIX_ARB)[0][12], 0);
        submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1)); assert.equal(shadow.stateValue(GL.CURRENT_MATRIX_ARB)[0][12], 10);
        const snapshot = gpu.stateSnapshot({ stateFields: ["programMatrix", "programMatrixInverse", "programMatrixTranspose", "programMatrixInverseTranspose"] });
        assert.equal(snapshot.matrices.program[0][12], 10); assert.equal(snapshot.matrices.programTranspose[0][3], 10);
        assert.equal(snapshot.matrices.programInverse[0][12], -10); assert.equal(snapshot.matrices.programInverseTranspose[0][3], -10);
        assert.equal(snapshot.matrices.programInverse[7][0], 0.5);
        const layout = require("../../src/browser/glbridge/gl-webgpu/gl_state_layout.js"), block = layout.buildLayout(["programMatrixInverseTranspose"]), out = new Float32Array(block.floats);
        layout.writeLayout(block, snapshot, out, 0); assert.equal(out[3], -10); assert.equal(out[7 * 16], 0.5);
        assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0); await gpu.idle();
    }
    console.log("gl_program_matrix_test: 19 native matrix/transpose/stack queries, limits, lists, errors, context isolation and snapshots passed in both modes");
})().catch(error => { console.error(error); process.exitCode = 1; });
