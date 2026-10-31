"use strict";
const assert = require("node:assert/strict"), { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"),
    codec = require("../../src/browser/glbridge/gl-webgpu/gl_snapshot_codec.js"), snapshot = require("../../src/browser/glbridge/gl-webgpu/gl_renderer_snapshot.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js"), cases = require("./gl_selection_program_cases.js");
(async () => {
    const { host: pureHost } = createFakeHost(), pure = new GLWebGPUExecutor(null, { host: pureHost, strict: true, rendererTestDiagnostics: false });await pure.initialize();
    pure.submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).bytes(), {});
    pure.current.error = GL.INVALID_OPERATION;pure.current.errorQueue = [GL.INVALID_ENUM];pure.current.arbErrorString = "legacy";pure.current.arbErrorPosition = 7;
    const clean = await pure.saveSnapshot(), cleanArchive = snapshot.inspect(clean), cleanState = codec.decode(cleanArchive.state);
    for (const name of ["error", "errorQueue", "arbErrorString", "arbErrorPosition"]) assert.equal(Object.hasOwn(cleanState.current, name), false, "retired error state omitted from new snapshots");
    cleanState.current.error = GL.INVALID_OPERATION;cleanState.current.errorQueue = [GL.INVALID_ENUM];cleanState.current.arbErrorString = "legacy";cleanState.current.arbErrorPosition = 7;
    cleanArchive.state = codec.encode(cleanState);await pure.restoreSnapshot(codec.encode(cleanArchive));
    for (const name of ["error", "errorQueue", "arbErrorString", "arbErrorPosition"]) assert.equal(Object.hasOwn(pure.current, name), false, "old renderer errors retired during restore");
    const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true, rendererTestDiagnostics: true }); await gpu.initialize();
    gpu.submit(cases.setup().stream.bytes(), {}); await gpu.idle();
    gpu.submit(new GLStream().call("CREATE_SHADER", 102, GL.VERTEX_SHADER).shaderSource(102, "float helper(float x){return x+0.25;}")
        .call("COMPILE_SHADER", 102).call("ATTACH_SHADER", 100, 102).shaderSource(101, "float helper(float x);void main(){gl_Position=vec4(helper(gl_Vertex.x),gl_Vertex.yzw);}")
        .call("COMPILE_SHADER", 101).call("CREATE_SHADER", 103, GL.FRAGMENT_SHADER).shaderSource(103, "uniform sampler2D image;void main(){gl_FragColor=texture2D(image,vec2(0.5));}")
        .call("COMPILE_SHADER", 103).call("ATTACH_SHADER", 100, 103).call("LINK_PROGRAM", 100).call("USE_PROGRAM", 100).bytes(), {});
    gpu.submit(new GLStream().call("MATRIX_MODE", GL.MODELVIEW).call("TRANSLATEF", 1, 2, 3).call("PUSH_MATRIX").call("BEGIN_QUERY", GL.SAMPLES_PASSED, 9).bytes(), {});
    const current = gpu.current, program = current.currentProgram, saved = await gpu.saveSnapshot(), archive = snapshot.inspect(saved);
    assert.equal(archive.version, 1); assert.equal(archive.resources.length, 0, "no GL images have been allocated");
    gpu.submit(new GLStream().call("END_QUERY", GL.SAMPLES_PASSED).call("USE_PROGRAM", 0).call("POP_MATRIX").bytes(), {});
    await gpu.restoreSnapshot(saved);
    assert.notEqual(gpu.current, current); assert.equal(gpu.current.currentProgram, program);
    assert.equal(gpu.current, [...gpu.contexts.values()][0]); assert.equal(gpu.current.shareGroup, [...gpu.shareGroups.values()][0]);
    assert.equal(gpu.current.activeQuery, gpu.activeQuery); assert.equal(gpu.queries.get(9), gpu.activeQuery); assert.equal(gpu.activeQuery.active, true);
    assert.equal(gpu.current.stacks[GL.MODELVIEW].length, 2); assert.equal(gpu.current.stacks[GL.MODELVIEW][1][12], 1);
    assert.ok(gpu.current.shareGroup.programs.get(gpu.current.currentProgram).linked);
    const compiled = gpu.current.shareGroup.programs.get(program).compiled;
    assert.equal(compiled.vertex.unitSources.length, 2); assert.ok(compiled.vertex.functions.has("helper"));
    assert.equal(typeof compiled.fragment.ast.decls[1].body.stmts[0].expr.value.resolved.emit, "function", "shader builtins are reconstructed from sources");
    gpu.submit(new GLStream().call("END_QUERY", GL.SAMPLES_PASSED).bytes(), {}); assert.equal(gpu.activeQuery, null);
    const restored = gpu.current, bad = codec.decode(saved); bad.resources = null;
    await assert.rejects(gpu.restoreSnapshot(codec.encode(bad)), /Invalid GL renderer checkpoint/); assert.equal(gpu.current, restored, "invalid archive leaves live state installed");
    const again = await gpu.saveSnapshot(), other = new GLWebGPUExecutor(null, { host, strict: true, rendererTestDiagnostics: true }); await other.initialize(); await other.restoreSnapshot(again);
    assert.equal(other.current.shareGroup.programs.get(other.current.currentProgram).linked, true); assert.equal(other.current.activeQuery, null);
    const converted = new GLWebGPUExecutor(null, { host, strict: true, rendererTestDiagnostics: false });await converted.initialize();
    converted.submit(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1).call("BIND_BUFFER", GL.ARRAY_BUFFER, 1).bytes(), {});
    converted.bufferData(GL.ARRAY_BUFFER, 9, GL.STATIC_DRAW, new Uint8Array([127, 0, 129, 0, 127, 0, 0, 0, 127]));
    const buffer = converted.bufferFor(GL.ARRAY_BUFFER), layout = { type: GL.BYTE, size: 3, stride: 3, offset: 0 }, old = converted.convertVertexAttribute(buffer, layout, 3, true),
        checkpoint = await converted.saveSnapshot(), images = snapshot.inspect(checkpoint).resources;
    assert.equal(images.length, 1);assert.ok(images.every(r => !r.descriptor.label.startsWith("GL converted attribute")), "only original VBO storage is persistent");
    await converted.restoreSnapshot(checkpoint);const restoredBuffer = converted.bufferFor(GL.ARRAY_BUFFER);
    assert.equal(restoredBuffer.convertedAttributes.size, 0);assert.equal(converted.convertedVertexCache.size, 0);assert.equal(converted.convertedVertexBytes, 0);
    const rebuilt = converted.convertVertexAttribute(restoredBuffer, layout, 3, true);assert.notEqual(rebuilt, old);
    assert.deepEqual([...new Float32Array(rebuilt.storage)], [1, 0, -1, 0, 1, 0, 0, 0, 1]);assert.equal(converted.convertedVertexBytes, 36);
    assert.equal(gpu.hostErrors.length, 0); assert.equal(other.hostErrors.length, 0);
    console.log("gl_renderer_snapshot_test: linked renderer graphs, shared identities, matrix stacks, active query continuation, cold restore and invalid archive ownership passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
