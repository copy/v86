"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), zlib = require("node:zlib");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
for (const part of ["objects", "state", "raster", "rasterpos", "pixelmaps", "fixed", "misc", "stencil_ext", "render", "arrays", "images", "textures", "buffers", "queries", "glsl", "arb"])
    require("../../src/browser/glbridge/gl-webgpu/gl_shadow_" + part + ".js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"), { GLStream, GL } = require("./gl_stream_builder.js"),
    { createFakeHost } = require("./gl_fake_gpu.js"), cases = require("./gl_partial_update_cases.js");
(async () => {
    const apple = require("./gl_conformance/partial_updates_reference.json").cases,
        mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.partial_updates.cases;
    assert.deepEqual(apple.map(e => e.name), cases.names);assert.deepEqual(mesa.map(e => e.name), cases.names);
    for (let i = 0; i < cases.names.length; ++i) {
        assert.equal(apple[i].error, 0);assert.equal(mesa[i].error, 0);assert.ok(apple[i].pixels.every((v, c) => Math.abs(v - mesa[i].pixels[c]) <= 1), cases.names[i]);
        assert.deepEqual(apple[i].stencil, mesa[i].stencil);assert.ok(apple[i].depth.every((v, c) => Math.abs(v - mesa[i].depth[c]) < 1e-6));
    }
    for (const copied of [false, true]) {
        const { host, log } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const cpu = new GLShadow();cpu.setCapabilities(gpu.capabilities());
        const send = s => {
            const memory = s.bytes(), segments = cpu.process(memory);
            for (const segment of segments || [{ offset: 0, length: memory.length }]) {
                const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);gpu.submit(copied ? bytes.slice() : bytes, {});
            }
            assert.equal(cpu.current.error, 0);
        };
        for (const [i, name] of cases.names.entries()) {
            const buffers = log.buffers.length, encoders = log.encoders.length;send(cases.scene(new GLStream().makeCurrent(1, 0, 0, 16, 16, i + 1, i + 1), name));
            const copies = log.encoders.slice(encoders).flatMap(e => e.copies);
            if (i < 3) {
                assert.equal(log.buffers.slice(buffers).filter(b => b.descriptor.label?.startsWith("GL buffer ")).length, i === 1 ? 2 : 1, "subranges never rename whole storage");
                const updates = copies.filter(c => c[0] === "b2b" && c[1].descriptor.label === "GL ordered buffer update");
                assert.equal(updates.length, [6, 1, 3][i]);assert.equal(updates.reduce((n, c) => n + c[5], 0), [24, 8, 12][i]);
                assert.ok(updates.every(c => c[4] % 4 === 0 && c[5] % 4 === 0));
            } else {
                const copy = copies.find(c => c[0] === "t2t" && c[2].texture.descriptor.label.startsWith("GL logic-op destination copy")), rect = i === 3 ? { x: 4, y: 5, width: 5, height: 4 } : { x: 0, y: 0, width: 4, height: 4 };
                assert.deepEqual(copy[1].origin, { x: rect.x, y: rect.y, z: 0 });assert.deepEqual(copy[2].origin, copy[1].origin);
                assert.equal(copy[3].width, rect.width);assert.equal(copy[3].height, rect.height);
            }
            gpu.flushFrame();await gpu.idle();
        }
        send(new GLStream().makeCurrent(1, 0, 0, 16, 16, 19, 19).call("VIEWPORT", 2, 3, 10, 8));
        assert.deepEqual(gpu.logicCopyRect({ width: 16, height: 16 }, { mode: GL.TRIANGLES }), { x: 2, y: 3, width: 10, height: 8 });
        assert.deepEqual(gpu.logicCopyRect({ width: 16, height: 16 }, { mode: GL.POINTS }), { x: 0, y: 0, width: 16, height: 16 }, "expanded program points can cross the viewport");
        for (const i of [3, 4]) {
            const first = log.passes.length;
            send(cases.scene(new GLStream().makeCurrent(1, 0, 0, 16, 16, 20 + i, 20 + i, 4 << require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js").C.V86GL_FORMAT_SAMPLES_SHIFT).call("DISABLE", GL.MULTISAMPLE), cases.names[i]));
            const copies = log.passes.slice(first).filter(p => p.descriptor.label === "GL copy individual logic samples");assert.ok(copies.length);
            for (const pass of copies) {
                assert.deepEqual(pass.scissor, i === 3 ? [4, 5, 5, 4] : [0, 0, 4, 4]);
                assert.ok(pass.descriptor.colorAttachments.every(a => !a || a.loadOp === "load"), "copies do not clear untouched samples");
            }
            gpu.flushFrame();await gpu.idle();
        }
        // Large streaming updates use bounded staging and retain one VBO.
        send(new GLStream().makeCurrent(1, 0, 0, 16, 16, 30, 30).call("BIND_BUFFER", GL.ARRAY_BUFFER, 10));
        gpu.bufferData(GL.ARRAY_BUFFER, 8 * 1024 * 1024 + 3, 0x88E8, null);
        const buffer = gpu.bufferFor(GL.ARRAY_BUFFER), original = buffer.gpuBuffer, first = log.buffers.length;gpu.pendingVertexBuffers.add(original);
        gpu.bufferSubData(GL.ARRAY_BUFFER, 0, new Uint8Array(buffer.size).fill(99));assert.equal(buffer.gpuBuffer, original);
        const chunks = log.buffers.slice(first).filter(b => b.descriptor.label === "GL ordered buffer update");assert.deepEqual(chunks.map(b => b.descriptor.size), [4194304, 4194304, 4]);
        assert.deepEqual([...new Uint8Array(chunks[2].storage)], [99, 99, 99, 0]);gpu.flushFrame();assert.ok(chunks.every(b => b.destroyed));assert.equal(gpu.bufferUpdateBytes, 0);
        const count = log.buffers.length;gpu.pendingVertexBuffers.add(original);gpu.bufferSubData(GL.ARRAY_BUFFER, 1, new Uint8Array());assert.equal(log.buffers.length, count, "zero-length updates are no-ops");
        // Existing per-image dirty tracking must not reupload clean levels.
        const s = new GLStream().call("BIND_TEXTURE", GL.TEXTURE_2D, 20);
        for (let level = 0; level < 4; ++level) {const size = 8 >> level;s.texImage2D(GL.TEXTURE_2D, level, GL.RGBA8, size, size, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(size * size * 4).fill(255));}
        send(s);const texture = gpu.boundTexture(GL.TEXTURE_2D);gpu.ensureTextureUploaded(texture);gpu.flushFrame();let before = log.textureWrites.length;
        send(new GLStream().texSubImage2D(GL.TEXTURE_2D, 2, 1, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([0, 255, 0, 255])));gpu.ensureTextureUploaded(texture);
        let writes = log.textureWrites.slice(before);assert.equal(writes.length, 1);assert.equal(writes[0].destination.mipLevel, 2);assert.equal(writes[0].byteLength, 4);assert.equal(writes[0].destination.origin.x, 1);
        before = log.textureWrites.length;send(new GLStream().texImage2D(GL.TEXTURE_2D, 1, GL.RGBA8, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(64).fill(128)));gpu.ensureTextureUploaded(texture);
        writes = log.textureWrites.slice(before);assert.equal(writes.length, 1);assert.equal(writes[0].destination.mipLevel, 1);assert.equal(writes[0].byteLength, 64);
        gpu.flushFrame();await gpu.idle();assert.equal(gpu.stats.refusals, 0);assert.equal(gpu.hostErrors.length, 0);assert.equal(gpu.gpuErrors.errors.length, 0);
    }
    console.log("gl_partial_update_test: five dual-native scenes, stable VBO/EBO storage, ordered aligned subranges, bounded large updates, dirty-only mip uploads and logic regions passed in both modes");
})().catch(error => {console.error(String(error.stack || error));process.exitCode = 1;});
