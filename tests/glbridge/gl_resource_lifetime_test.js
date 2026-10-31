"use strict";
const assert = require("node:assert/strict");
const { GLFN } = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GPUResourceRegistry } = require("../../src/browser/glbridge/webgpu_host.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js"), { GLStream, GL } = require("./gl_stream_builder.js");
(async () => {
    // A delayed rejection must not evict a replacement or poison a new device.
    const registry = new GPUResourceRegistry(), cache = new Map();
    let finish;
    const log = { scoped: (kind, create) => ({ object: create(), checked: new Promise(resolve => { finish = resolve; }) }) };
    registry.checked(log, "test", cache, 7, () => ({}));
    const replacement = {};cache.set(7, replacement);finish("invalid");await Promise.resolve();assert.equal(cache.get(7), replacement);
    registry.checked(log, "test", cache, 8, () => ({}));registry.invalidate();finish("old device");await Promise.resolve();assert.equal(cache.get(8).glRejected, undefined);
    for (const copied of [false, true]) {
        const { host, log: calls, device } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true });await gpu.initialize();
        const send = s => {const bytes = s.bytes();gpu.submit(copied ? bytes.slice() : bytes, {});};
        const current = (hwnd, id, size = 16, samples = 0) => new GLStream().makeCurrent(hwnd, 0, 0, size, size, id, 1, samples << 8);
        send(current(1, 1));const first = gpu.ensurePass(), color = gpu.backBuffer, depth = gpu.depthTarget;
        assert.equal(gpu.ensurePass(), first, "unchanged attachments reuse the open pass");
        send(current(2, 2, 32));assert.ok(first.ended);gpu.ensurePass();assert.notEqual(gpu.backBuffer, color);
        send(current(1, 1));assert.equal(gpu.ensurePass().descriptor.colorAttachments[0].view.texture, color);assert.equal(gpu.depthTarget, depth);
        send(current(1, 3));gpu.ensurePass();assert.equal(gpu.backBuffer, color, "contexts on one drawable share default storage");
        send(current(2, 3, 32));gpu.ensurePass();assert.notEqual(gpu.backBuffer, color, "the same context can change drawables");
        send(current(1, 1, 16, 4));gpu.ensurePass();const msaa = gpu.multisampleTarget;
        // Attachment identity changes are detected even without a bind handler ending the pass.
        send(new GLStream().call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER, 5).call("BIND_RENDERBUFFER", GL.RENDERBUFFER, 5)
            .call("RENDERBUFFER_STORAGE", GL.RENDERBUFFER, GL.RGBA8, 16, 16)
            .call("FRAMEBUFFER_RENDERBUFFER", GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER, 5));
        const fboPass = gpu.ensurePass();assert.equal(gpu.ensurePass(), fboPass, "renderbuffer views have stable identities");
        const rb = gpu.current.shareGroup.renderbuffers.get(5), old = rb.gpuTexture;
        gpu.allocateRenderbuffer(rb);assert.notEqual(old, rb.gpuTexture);assert.notEqual(gpu.ensurePass(), fboPass);assert.ok(fboPass.ended);
        send(new GLStream().names(GLFN.DELETE_FRAMEBUFFERS, [5]));assert.equal(gpu.current.drawFramebuffer, 0);assert.equal(gpu.ensurePass().descriptor.colorAttachments[0].view.texture, msaa);
        // Allocate each previously omitted cache/singleton and every kind of upload state.
        gpu.depthColorPipeline("rgba8unorm", GL.LUMINANCE);gpu.colorCopyPipeline("rgba8unorm", "RGBA");gpu.mipmapPipeline("rgba8unorm");gpu.colorBlitPipeline("rgba8unorm");
        gpu.valuePipelineCache.set(1, {});gpu.depthReadPipeline = {};gpu.depthUploadPipeline = {};
        gpu.uploadPages.push(device.createBuffer({ size: 16 }));gpu.logicTargetViews.push({});gpu.logicTargetTextures.push({});
        gpu.uniformCursor = 256;gpu.vertexCursor = 256;
        let releaseRead;
        const read = gpu.awaitReadback(new Promise(resolve => {releaseRead = resolve;}), "test readback").then(() => "stale write", error => error.message);
        const next = createFakeHost();host.device = next.device;await gpu.onDeviceLost();
        const outcome = await Promise.race([read, new Promise(resolve => setTimeout(() => resolve("not cancelled"), 50))]);
        releaseRead();assert.equal(outcome, "test readback device lost");
        assert.equal(gpu.uploadPages.length, 0);assert.equal(gpu.logicTargetViews.length, 0);assert.equal(gpu.vertexCursor, 0);assert.equal(gpu.uniformCursor, 0);
        for (const name of ["depthReadPipeline", "depthUploadPipeline", "multisampleTarget", "multisampleView", "passTargets"]) assert.equal(gpu[name], null, name);
        assert.equal(gpu.valuePipelineCache.size, 0);assert.equal(gpu.depthColorPipelines.size, 0);
        for (const drawable of gpu.drawables.values()) assert.equal(drawable.backBuffer, null, "all drawable images invalidate together");
        gpu.ensurePass();assert.notEqual(gpu.multisampleTarget, msaa);assert.notEqual(gpu.backBuffer, color);assert.notEqual(rb.gpuTexture, old);
        // Real asynchronous error scopes: evict a failed auxiliary pipeline, retry successfully.
        const create = next.device.createRenderPipeline.bind(next.device);let reject = true;
        next.device.createRenderPipeline = descriptor => {const object = create(descriptor);if (reject) next.device.rejectWith("injected validation error");return object;};
        const rejected = gpu.colorBlitPipeline("rgba8unorm");await Promise.resolve();await Promise.resolve();
        assert.equal(gpu.colorBlitPipelines.size, 0);assert.ok(rejected.glRejected);reject = false;
        assert.notEqual(gpu.colorBlitPipeline("rgba8unorm"), rejected);assert.equal(gpu.colorBlitPipelines.size, 1);
        assert.equal(calls.draws.length, 0);gpu.resetForReplay();assert.equal(gpu.drawables.size, 0);
        assert.ok(next.log.textures.every(texture => texture.destroyed || texture === gpu.fallbackTexture), "replay releases all old tracked textures");
    }
    console.log("gl_resource_lifetime_test: drawable ownership, attachment pass keys, complete recovery, cancelled readbacks, rejected cache eviction and replay release in both modes passed");
})().catch(error => {console.error(error);process.exitCode = 1;});
