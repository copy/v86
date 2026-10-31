#!/usr/bin/env node
// The GL shadow's textures, renderbuffers and framebuffer objects
// (gl_shadow_objects.js): glCheckFramebufferStatus answered on the CPU side,
// by EXT_framebuffer_object's rules, and the state kept across snapshots.
"use strict";

const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_textures.js");
const glCaps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const { GLStream, GL } = require("./gl_stream_builder.js");

const OK = P.C.V86GL_SYNC_QUERY_STATUS_OK;
const FRAMEBUFFER = 0x8D40, RENDERBUFFER = 0x8D41;
const COLOR0 = GL.COLOR_ATTACHMENT0, DEPTH = GL.DEPTH_ATTACHMENT, STENCIL = GL.STENCIL_ATTACHMENT;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function shadow() {
    const s = new GLShadow();
    s.setCapabilities(glCaps.capabilities({}, {}));
    return s;
}

// A stream with a context, and a way to ask the status at that point
function scene() {
    const stream = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1);
    const asks = [];
    stream.status = (target = FRAMEBUFFER) => {
        stream.record(P.GLFN.CHECK_FRAMEBUFFER_STATUS, P.encodeRecord("CHECK_FRAMEBUFFER_STATUS", { target }));
        asks.push(stream.payloadView());
        return stream;
    };
    stream.answers = () => asks.map(r => {
        assert.equal(r.view.getUint32(P.F.CHECK_FRAMEBUFFER_STATUS.status, true), OK);
        return r.view.getUint32(P.F.CHECK_FRAMEBUFFER_STATUS.result, true);
    });
    return stream;
}

const texture = (stream, name, width, height, internalFormat = GL.RGBA, target = GL.TEXTURE_2D) =>
    stream.call("BIND_TEXTURE", target === GL.TEXTURE_2D ? target : GL.TEXTURE_CUBE_MAP, name)
        .texImage2D(target, 0, internalFormat, width, height, GL.RGBA, GL.UNSIGNED_BYTE, null);
const renderbuffer = (stream, name, internalFormat, width, height) =>
    stream.call("BIND_RENDERBUFFER", RENDERBUFFER, name).call("RENDERBUFFER_STORAGE", RENDERBUFFER, internalFormat,
        width, height);
const attachTexture = (stream, attachment, name, level = 0, target = GL.TEXTURE_2D) =>
    stream.call("FRAMEBUFFER_TEXTURE", FRAMEBUFFER, attachment, target, name, level, 0);
const attachRenderbuffer = (stream, attachment, name) =>
    stream.call("FRAMEBUFFER_RENDERBUFFER", FRAMEBUFFER, attachment, RENDERBUFFER, name);

test("EXT-created FBOs share by identity, core-created FBOs stay private and deleted bindings survive snapshots", async () => {
    const native = require("./gl_conformance/framebuffer_sharing_reference.json");
    assert.equal(native.foreignEXT, 1); assert.equal(native.crossBindError, 0); assert.equal(native.crossAttachment, 1);
    const one = shadow(), stream = scene().call("BIND_TEXTURE", GL.TEXTURE_2D, 1)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(64))
        .call("BIND_FRAMEBUFFER_EXT", FRAMEBUFFER, 7).call("FRAMEBUFFER_TEXTURE_2D", FRAMEBUFFER, COLOR0, GL.TEXTURE_2D, 1, 0, 0)
        .makeCurrent(2, 0, 0, 64, 64, 2, 1).call("BIND_FRAMEBUFFER", FRAMEBUFFER, 7)
        .makeCurrent(1, 0, 0, 64, 64, 1, 1).call("BIND_FRAMEBUFFER", FRAMEBUFFER, 9)
        .makeCurrent(2, 0, 0, 64, 64, 2, 1).call("BIND_FRAMEBUFFER_EXT", FRAMEBUFFER, 9)
        .call("BIND_FRAMEBUFFER", FRAMEBUFFER, 7).call("DRAW_BUFFER", GL.NONE);
    one.process(stream.bytes()); assert.equal(one.stats.rejected, 0);
    const group = one.current.group, contexts = [...one.contexts.values()], first = contexts.find(c => c.id === 1), second = contexts.find(c => c.id === 2);
    assert.notEqual(first.privateFramebuffers.get(9), second.privateFramebuffers.get(9));
    assert.equal(first.privateFramebuffers.get(9).shared, false);
    // Context 2 first bound 9 through EXT, so it owns a different shared
    // object; context 1's core-created 9 remains private in that context.
    assert.equal(group.sharedFramebuffers.get(9), second.framebuffers.get(9));
    assert.equal(second.drawFramebufferObject, group.sharedFramebuffers.get(7));
    const old = second.drawFramebufferObject, imageId = old.color[0].id;
    const changes = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1).call("BIND_FRAMEBUFFER", FRAMEBUFFER, 7);
    one.process(changes.bytes()); assert.deepEqual(one.current.drawBuffers, [GL.NONE]);
    const replace = new GLStream().call("DRAW_BUFFER", COLOR0).names(P.GLFN.DELETE_FRAMEBUFFERS, [7])
        .call("BIND_FRAMEBUFFER_EXT", FRAMEBUFFER, 7).call("BIND_TEXTURE", GL.TEXTURE_2D, 2)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(64))
        .call("FRAMEBUFFER_TEXTURE_2D", FRAMEBUFFER, COLOR0, GL.TEXTURE_2D, 2, 0, 0).names(P.GLFN.DELETE_TEXTURES, [1])
        .makeCurrent(2, 0, 0, 64, 64, 2, 1).names(P.GLFN.DELETE_FRAMEBUFFERS, [7]);
    one.process(replace.bytes()); assert.equal(one.stats.rejected, 0); assert.equal(one.boundFramebuffer(FRAMEBUFFER), old);
    assert.equal(one.framebufferStatus(FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE); assert.equal(group.sharedFramebuffers.has(7), false);
    assert.equal(group.textureImages.has(imageId), true, "deleted bound FBO retains its deleted attachment image");
    const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(one.getState())));
    assert.equal(copy.boundFramebuffer(FRAMEBUFFER).id, old.id); assert.equal(copy.framebufferStatus(FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
    assert.equal(copy.boundFramebuffer(FRAMEBUFFER).color[0].name, 1);
    copy.process(scene().call("BIND_FRAMEBUFFER_EXT", FRAMEBUFFER, 9).bytes());
    assert.equal(copy.boundFramebuffer(FRAMEBUFFER), copy.current.privateFramebuffers.get(9), "EXT alias preserves an existing core object's private origin");
    const { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host }); await gpu.initialize();
    for (const batch of [stream, changes, replace]) gpu.submit(batch.bytes(), {});
    assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.boundFramebufferObject(FRAMEBUFFER).color[0].name, 1);
    assert.equal(gpu.current.shareGroup.sharedFramebuffers.has(7), false);
    const gpuFirst = [...gpu.contexts.values()].find(c => c.protocolId === 1);
    assert.notEqual(gpuFirst.privateFramebuffers.get(9), gpu.current.shareGroup.sharedFramebuffers.get(9));
    const end = new GLStream().record(P.CTRL.DESTROY_CONTEXT, P.encodeRecord("DESTROY_CONTEXT", { context_id: 2 }));
    one.process(end.bytes()); assert.equal(group.textureImages.has(imageId), false, "last FBO binding releases its old image");
});

test("version 2 object snapshots restore their legacy private FBOs", () => {
    const one = shadow(), stream = scene().call("BIND_TEXTURE", GL.TEXTURE_2D, 1)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(64))
        .call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3).call("FRAMEBUFFER_TEXTURE", FRAMEBUFFER, COLOR0, GL.TEXTURE_2D, 1, 0, 0);
    one.process(stream.bytes()); const saved = JSON.parse(JSON.stringify(one.getState())); saved.objects.version = 2;
    const pool = new Map(saved.objects.groups[0].framebuffers.map(f => [f.id, f]));
    for (const c of saved.objects.contexts) c.framebuffers = c.framebuffers.map(([, id]) => pool.get(id));
    for (const g of saved.objects.groups) { delete g.framebuffers; delete g.sharedFramebuffers; delete g.framebufferReservations; delete g.nextFramebufferId; }
    const copy = shadow(); copy.setState(saved);
    assert.equal(copy.framebufferStatus(FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
    assert.equal(copy.current.privateFramebuffers.get(3).color[0].name, 1);
});

test("the default framebuffer is complete; an empty object is missing an attachment", () => {
    const s = scene().status().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3).status();
    shadow().process(s.bytes());
    assert.deepEqual(s.answers(), [GL.FRAMEBUFFER_COMPLETE, GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]);
});

test("colour texture plus depth renderbuffer is complete, and the executor agrees", async () => {
    const s = scene();
    texture(s, 7, 32, 16);
    renderbuffer(s, 9, GL.DEPTH_COMPONENT24, 32, 16);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    attachTexture(s, COLOR0, 7);
    attachRenderbuffer(s, DEPTH, 9);
    s.status();
    // Only the CPU answers completeness; the renderer preserves that answer.
    shadow().process(s.bytes());
    const copy = s.bytes().slice();
    assert.deepEqual(s.answers(), [GL.FRAMEBUFFER_COMPLETE]);
    const { host } = createFakeHost();
    const executor = new GLWebGPUExecutor(null, { host });
    await executor.initialize();
    executor.submit(copy, {});
    const at = copy.length - P.RECORDS.CHECK_FRAMEBUFFER_STATUS.size;
    assert.equal(new DataView(copy.buffer).getUint32(at + P.F.CHECK_FRAMEBUFFER_STATUS.result, true),
        GL.FRAMEBUFFER_COMPLETE);
});

test("what makes an attachment incomplete", () => {
    const s = scene();
    texture(s, 7, 32, 16);
    s.call("BIND_TEXTURE", GL.TEXTURE_2D, 8);
    renderbuffer(s, 9, GL.DEPTH_COMPONENT24, 32, 16);
    renderbuffer(s, 10, GL.RGBA8, 32, 16);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    // a texture with no image at the level
    attachTexture(s, COLOR0, 8);
    s.status();
    // a level the texture does not have
    attachTexture(s, COLOR0, 7, 2);
    s.status();
    // a depth format as colour
    attachTexture(s, COLOR0, 7);
    attachRenderbuffer(s, GL.COLOR_ATTACHMENT0 + 1, 9);
    s.status();
    // a colour format as depth
    attachRenderbuffer(s, GL.COLOR_ATTACHMENT0 + 1, 0);
    attachRenderbuffer(s, DEPTH, 10);
    s.status();
    // a depth-only format as stencil
    attachRenderbuffer(s, DEPTH, 0);
    attachRenderbuffer(s, STENCIL, 9);
    s.status();
    shadow().process(s.bytes());
    assert.deepEqual(s.answers(), new Array(5).fill(GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT));
});

test("sizes, draw and read buffers, and separate depth and stencil images", () => {
    const s = scene();
    texture(s, 7, 32, 16);
    texture(s, 8, 16, 16);
    renderbuffer(s, 9, GL.DEPTH_COMPONENT24, 32, 16);
    renderbuffer(s, 11, GL.STENCIL_INDEX8_EXT, 32, 16);
    renderbuffer(s, 12, GL.DEPTH24_STENCIL8, 32, 16);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    attachTexture(s, COLOR0, 7);
    attachTexture(s, COLOR0 + 1, 8);
    s.status();
    attachTexture(s, COLOR0 + 1, 0);
    // the draw buffer names an attachment that is not there
    s.call("DRAW_BUFFER", COLOR0 + 2).status();
    s.call("DRAW_BUFFER", COLOR0).call("READ_BUFFER", COLOR0 + 3).status().status(GL.DRAW_FRAMEBUFFER);
    s.call("READ_BUFFER", COLOR0);
    // depth and stencil from two images: WebGPU cannot
    attachRenderbuffer(s, DEPTH, 9);
    attachRenderbuffer(s, STENCIL, 11);
    s.status();
    // one depth-stencil image at both is fine
    attachRenderbuffer(s, GL.DEPTH_STENCIL_ATTACHMENT, 12);
    s.status();
    shadow().process(s.bytes());
    assert.deepEqual(s.answers(), [GL.FRAMEBUFFER_INCOMPLETE_DIMENSIONS_EXT, GL.FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER_EXT,
        GL.FRAMEBUFFER_INCOMPLETE_READ_BUFFER_EXT, GL.FRAMEBUFFER_COMPLETE, GL.FRAMEBUFFER_UNSUPPORTED_EXT,
        GL.FRAMEBUFFER_COMPLETE]);
});

test("cube faces, mipmaps and deletion", () => {
    const s = scene();
    texture(s, 7, 32, 32, GL.RGBA, GL.TEXTURE_CUBE_MAP_POSITIVE_X + 2);
    texture(s, 8, 64, 32);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    // the face that has an image, then one that has not
    attachTexture(s, COLOR0, 7, 0, GL.TEXTURE_CUBE_MAP_POSITIVE_X + 2);
    s.status();
    attachTexture(s, COLOR0, 7, 0, GL.TEXTURE_CUBE_MAP_POSITIVE_X + 3);
    s.status();
    // level 2 exists once the mipmaps are generated: 16x8
    attachTexture(s, COLOR0, 8, 2);
    s.status();
    s.call("BIND_TEXTURE", GL.TEXTURE_2D, 8).call("GENERATE_MIPMAP", GL.TEXTURE_2D).status();
    // deleting the texture detaches it from the bound framebuffer
    s.names(P.GLFN.DELETE_TEXTURES, [8]);
    s.status();
    shadow().process(s.bytes());
    assert.deepEqual(s.answers(), [GL.FRAMEBUFFER_COMPLETE, GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT,
        GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT, GL.FRAMEBUFFER_COMPLETE, GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]);
});

test("framebuffer objects are the context's; textures the share group's; a snapshot keeps both", () => {
    const one = shadow();
    const s = scene();
    texture(s, 7, 32, 16);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    attachTexture(s, COLOR0, 7);
    one.process(s.bytes());
    // another context of the share group: texture 7 is there, framebuffer 3 is not (yet)
    const other = new GLStream().makeCurrent(1, 0, 0, 64, 64, 2, 1).call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    other.record(P.GLFN.CHECK_FRAMEBUFFER_STATUS, P.encodeRecord("CHECK_FRAMEBUFFER_STATUS", { target: FRAMEBUFFER }));
    const fresh = other.payloadView();
    one.process(other.bytes());
    assert.equal(fresh.view.getUint32(P.F.CHECK_FRAMEBUFFER_STATUS.result, true),
        GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT);
    // back on the first context, after a snapshot
    const copy = shadow();
    copy.setState(JSON.parse(JSON.stringify(one.getState())));
    const again = scene().status();
    copy.process(again.bytes());
    assert.deepEqual(again.answers(), [GL.FRAMEBUFFER_COMPLETE]);
});

test("deleted names cannot redirect shared bindings or unbound framebuffer attachments", async () => {
    const one = shadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host }); await gpu.initialize();
    const send = s => { const b = s.bytes(); one.process(b); gpu.submit(b, {}); };
    const s = scene(); texture(s, 7, 32, 16); renderbuffer(s, 9, GL.DEPTH_COMPONENT24, 32, 16);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3); attachTexture(s, COLOR0, 7); attachRenderbuffer(s, DEPTH, 9);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 0).makeCurrent(2, 0, 0, 64, 64, 2, 1)
        .call("BIND_TEXTURE", GL.TEXTURE_2D, 7).call("BIND_RENDERBUFFER", RENDERBUFFER, 9);
    send(s);
    const group = one.current.group, gpuGroup = gpu.current.shareGroup;
    const oldTexture = group.textures.get(7), oldRb = group.renderbuffers.get(9);
    const gpuTexture = gpu.boundTexture(GL.TEXTURE_2D), gpuRb = gpuGroup.renderbuffers.get(9);
    const gpuStorage = gpu.ensureTextureUploaded(gpuTexture), rbStorage = gpuRb.gpuTexture;
    const reuse = scene().names(P.GLFN.DELETE_TEXTURES, [7]).names(P.GLFN.DELETE_RENDERBUFFERS, [9]);
    texture(reuse, 7, 8, 8); renderbuffer(reuse, 9, GL.DEPTH_COMPONENT24, 8, 8);
    reuse.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3).status(); send(reuse);
    assert.ok(!(gpu.retired || []).includes(gpuStorage) && !(gpu.retired || []).includes(rbStorage), "referenced images must not be retired");
    assert.deepEqual(reuse.answers(), [GL.FRAMEBUFFER_COMPLETE]);
    assert.notEqual(group.textures.get(7), oldTexture); assert.notEqual(group.renderbuffers.get(9), oldRb);
    assert.equal(one.attachedImage(one.current.framebuffers.get(3).color[0]).width, 32);
    assert.equal(gpu.attachmentSize(gpu.framebuffers.get(gpu.current.id).get(3).color[0]).width, 32);
    const other = new GLStream().makeCurrent(2, 0, 0, 64, 64, 2, 1); send(other);
    assert.equal(one.boundImage(GL.TEXTURE_2D).texture, oldTexture); assert.equal(gpu.boundTexture(GL.TEXTURE_2D), gpuTexture);
    assert.equal(group.renderbufferImages.get(one.current.renderbufferImage), oldRb);
    assert.equal(gpuGroup.renderbufferImages.get(gpu.current.renderbufferImage), gpuRb);
    // Deleting the reused names while the old FBO is bound must not detach its old images.
    const again = scene().names(P.GLFN.DELETE_TEXTURES, [7]).names(P.GLFN.DELETE_RENDERBUFFERS, [9]).status(); send(again);
    assert.deepEqual(again.answers(), [GL.FRAMEBUFFER_COMPLETE]);
    const release = scene().names(P.GLFN.DELETE_FRAMEBUFFERS, [3])
        .record(P.CTRL.DESTROY_CONTEXT, P.encodeRecord("DESTROY_CONTEXT", { context_id: 2 })); send(release);
    assert.equal(group.textureImages.has(oldTexture.id), false); assert.equal(group.renderbufferImages.has(oldRb.id), false);
    assert.equal(gpuGroup.textureImages.has(gpuTexture.imageId), false); assert.equal(gpuGroup.renderbufferImages.has(gpuRb.imageId), false);
    gpu.releaseRetired(); assert.ok(gpuStorage.destroyed && rbStorage.destroyed, "last-reference removal must release GPU storage");
});
test("reserved names become objects only on bind and CPU queries distinguish deletion and name reuse", () => {
    const one = shadow(), s = scene(), asks = [];
    const ask = (kind, name) => {
        const at = s.length + 4, r = P.encodeRecord("QUERY_PARAMETER", {
            query_kind: P.C.V86GL_PARAMETER_IS_OBJECT, target: kind, pname: name, value_kind: P.C.V86GL_STATE_BOOLEAN, data_size: 8,
        });
        const data = new Uint8Array(r.length + 8); data.set(r); s.record(P.GLFN.QUERY_PARAMETER, data); asks.push(at);
    };
    const kinds = [P.C.V86GL_OBJECT_KIND_TEXTURE, P.C.V86GL_OBJECT_KIND_RENDERBUFFER, P.C.V86GL_OBJECT_KIND_FRAMEBUFFER];
    s.names(P.GLFN.GEN_TEXTURES, [7]).names(P.GLFN.GEN_RENDERBUFFERS, [7]).names(P.GLFN.GEN_FRAMEBUFFERS, [7]);
    for (const k of kinds) ask(k, 7);
    s.call("BIND_TEXTURE", GL.TEXTURE_2D, 7).call("BIND_RENDERBUFFER", RENDERBUFFER, 7).call("BIND_FRAMEBUFFER", FRAMEBUFFER, 7);
    for (const k of kinds) ask(k, 7);
    s.names(P.GLFN.DELETE_TEXTURES, [7]).names(P.GLFN.DELETE_RENDERBUFFERS, [7]).names(P.GLFN.DELETE_FRAMEBUFFERS, [7]);
    for (const k of kinds) ask(k, 7);
    one.process(s.bytes()); const v = new DataView(s.bytes().buffer);
    assert.deepEqual(asks.map(at => { assert.equal(v.getUint32(at + P.F.QUERY_PARAMETER.status, true), OK); return v.getFloat64(at + P.RECORDS.QUERY_PARAMETER.size, true); }),
        [0, 0, 0, 1, 1, 1, 0, 0, 0]);
    const invalid = new GLStream().call("BIND_TEXTURE", GL.TEXTURE_2D, 7).call("BIND_TEXTURE", GL.TEXTURE_3D, 7);
    one.process(invalid.bytes()); assert.equal(one.current.error, GL.INVALID_OPERATION);
    assert.equal(one.current.units[0].has(GL.TEXTURE_3D), false);
});
test("default textures are per-context objects and snapshots preserve retained identities", () => {
    const one = shadow(), s = scene();
    s.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 2, GL.RGBA, GL.UNSIGNED_BYTE, null)
        .call("PUSH_ATTRIB", 0x40000);
    texture(s, 7, 32, 16); s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3); attachTexture(s, COLOR0, 7);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 0).names(P.GLFN.DELETE_TEXTURES, [7]);
    texture(s, 7, 8, 8); s.makeCurrent(2, 0, 0, 64, 64, 2, 1)
        .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 9, 7, GL.RGBA, GL.UNSIGNED_BYTE, null);
    one.process(s.bytes());
    const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(one.getState())));
    assert.equal(copy.boundImage(GL.TEXTURE_2D).texture.levels.get(0).get(0).width, 9);
    const back = scene().call("POP_ATTRIB").call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3).status(); copy.process(back.bytes());
    assert.equal(copy.boundImage(GL.TEXTURE_2D).texture.name, 0);
    assert.equal(copy.boundImage(GL.TEXTURE_2D).texture.levels.get(0).get(0).width, 4);
    assert.equal(copy.attachedImage(copy.current.framebuffers.get(3).color[0]).width, 32);
    assert.deepEqual(back.answers(), [GL.FRAMEBUFFER_COMPLETE]);
});
test("FBO draw/read selections match desktop GL and attribute restoration follows EXT issue 81", async () => {
    const one = shadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host }); await gpu.initialize();
    const reference = require("./gl_conformance/fbo_buffers_reference.json").cases;
    const expected = { ...reference, pop_on_b: [COLOR0 + 2, 0, COLOR0 + 1, 0], return_to_b: [COLOR0 + 2, 0, COLOR0 + 1, 0] };
    // Apple does not restore FBO selections at PopAttrib. EXT_framebuffer_object
    // issue 81 and the state tables specify restoration to the currently bound FBO.
    const step = (name, stream) => {
        const asks = [];
        for (const pname of [GL.DRAW_BUFFER0, GL.DRAW_BUFFER0 + 1, GL.DRAW_BUFFER0 + 2, 0x0C02]) {
            const at = stream.length + 4, h = P.encodeRecord("QUERY_STATE", { pname, value_kind: P.C.V86GL_STATE_INTEGER, data_size: 8 });
            const payload = new Uint8Array(h.length + 8); payload.set(h); stream.record(P.GLFN.QUERY_STATE, payload); asks.push(at);
        }
        const bytes = stream.bytes(); one.process(bytes); gpu.submit(bytes, {});
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        assert.deepEqual(asks.map(at => { assert.equal(v.getUint32(at + P.F.QUERY_STATE.status, true), OK); return v.getFloat64(at + P.RECORDS.QUERY_STATE.size, true); }), expected[name], name);
        const c = gpu.current;
        assert.deepEqual([c.drawBuffers[0] || 0, c.drawBuffers[1] || 0, c.drawBuffers[2] || 0, c.readBuffer], expected[name], "renderer " + name);
    };
    step("initial_a", scene().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3));
    step("configured_a", new GLStream().names(P.GLFN.DRAW_BUFFERS, [COLOR0 + 2, 0, COLOR0 + 1]).call("READ_BUFFER", COLOR0 + 2));
    step("initial_b", new GLStream().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 4));
    step("configured_b", new GLStream().call("DRAW_BUFFER", GL.NONE).call("READ_BUFFER", GL.NONE));
    step("draw_a_read_b", new GLStream().call("BIND_FRAMEBUFFER", GL.DRAW_FRAMEBUFFER, 3));
    step("pop_on_b", new GLStream().call("PUSH_ATTRIB", 0x4020).call("BIND_FRAMEBUFFER", FRAMEBUFFER, 4)
        .call("DRAW_BUFFER", COLOR0 + 3).call("READ_BUFFER", COLOR0 + 3).call("POP_ATTRIB"));
    step("return_to_a", new GLStream().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3));
    step("return_to_b", new GLStream().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 4));
    const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(one.getState())));
    copy.process(scene().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3).bytes());
    assert.deepEqual(copy.current.drawBuffers, [COLOR0 + 2, 0, COLOR0 + 1]); assert.equal(copy.current.readBuffer, COLOR0 + 2);
    const remove = scene().names(P.GLFN.DELETE_FRAMEBUFFERS, [4]); one.process(remove.bytes()); gpu.submit(remove.bytes(), {});
    assert.deepEqual(one.current.drawBuffers, [GL.BACK]); assert.equal(one.current.readBuffer, GL.BACK);
    assert.deepEqual(gpu.current.drawBuffers, [GL.BACK]); assert.equal(gpu.current.readBuffer, GL.BACK);
});
test("draw/read selection rejects invalid enums, unavailable buffers and duplicates atomically", () => {
    for (const [stream, error] of [
        [new GLStream().call("DRAW_BUFFER", GL.BACK), GL.INVALID_OPERATION],
        [new GLStream().call("READ_BUFFER", 0xFFFFFFFF), GL.INVALID_ENUM],
        [new GLStream().names(P.GLFN.DRAW_BUFFERS, [COLOR0, COLOR0]), GL.INVALID_OPERATION],
        [new GLStream().names(P.GLFN.DRAW_BUFFERS, [COLOR0 + 2, 0xFFFFFFFF]), GL.INVALID_ENUM],
        [new GLStream().names(P.GLFN.DRAW_BUFFERS, new Array(9).fill(GL.NONE)), GL.INVALID_VALUE],
        [new GLStream().call("BEGIN", GL.POINTS).call("DRAW_BUFFER", GL.NONE), GL.INVALID_OPERATION],
    ]) {
        const one = shadow(); one.process(scene().call("BIND_TEXTURE", GL.TEXTURE_2D, 1)
            .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(64))
            .call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3).call("FRAMEBUFFER_TEXTURE", FRAMEBUFFER, COLOR0, GL.TEXTURE_2D, 1, 0, 0).bytes());
        one.process(stream.bytes()); assert.equal(one.current.error, error); assert.deepEqual(one.current.drawBuffers, [COLOR0]);
        assert.equal(one.current.readBuffer, COLOR0);
    }
    const single = shadow(), s = new GLStream().makeCurrent(1, 0, 0, 64, 64, 1, 1, P.C.V86GL_FORMAT_SINGLE_BUFFER);
    single.process(s.bytes()); assert.deepEqual(single.current.drawBuffers, [GL.FRONT]); assert.equal(single.current.readBuffer, GL.FRONT);
    single.process(new GLStream().call("DRAW_BUFFER", GL.BACK).bytes()); assert.equal(single.current.error, GL.INVALID_OPERATION);
});
test("framebuffer attachment queries match desktop GL for images, faces, slices and failures", () => {
    const one = shadow(), s = scene().call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3), cases = [];
    const ask = (name, attachment, pname) => {
        const at = s.length + 4, h = P.encodeRecord("QUERY_PARAMETER", { query_kind: P.C.V86GL_PARAMETER_FRAMEBUFFER_ATTACHMENT,
            target: FRAMEBUFFER, pname, index: attachment, value_kind: P.C.V86GL_STATE_INTEGER, data_size: 8 });
        const payload = new Uint8Array(h.length + 8); payload.set(h); new DataView(payload.buffer).setFloat64(h.length, 1234567, true);
        s.record(P.GLFN.QUERY_PARAMETER, payload); cases.push([name, at]);
    };
    const T = GL.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE_EXT, N = GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME_EXT;
    const L = GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL_EXT, F = GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE_EXT;
    const Z = GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_3D_ZOFFSET_EXT;
    ask("empty_type", COLOR0, T); ask("empty_name", COLOR0, N); ask("empty_level", COLOR0, L);
    s.call("BIND_TEXTURE", GL.TEXTURE_2D, 11); attachTexture(s, COLOR0, 11, 2);
    for (const [name, p] of [["texture_type", T], ["texture_name", N], ["texture_level", L], ["texture_face", F], ["texture_z", Z]]) ask(name, COLOR0, p);
    s.call("BIND_TEXTURE", GL.TEXTURE_CUBE_MAP, 12); attachTexture(s, COLOR0 + 1, 12, 0, GL.TEXTURE_CUBE_MAP_NEGATIVE_Z);
    ask("cube_face", COLOR0 + 1, F);
    s.call("BIND_TEXTURE", GL.TEXTURE_3D, 13).call("FRAMEBUFFER_TEXTURE", FRAMEBUFFER, COLOR0 + 2, GL.TEXTURE_3D, 13, 0, 1);
    ask("volume_z", COLOR0 + 2, Z);
    s.call("BIND_RENDERBUFFER", RENDERBUFFER, 15); attachRenderbuffer(s, DEPTH, 15);
    ask("renderbuffer_type", DEPTH, T); ask("renderbuffer_name", DEPTH, N); ask("renderbuffer_level", DEPTH, L);
    ask("bad_attachment", 0, T); ask("bad_pname", COLOR0, 0);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 0).names(P.GLFN.DELETE_TEXTURES, [12])
        .call("BIND_TEXTURE", GL.TEXTURE_2D, 12).call("BIND_FRAMEBUFFER", FRAMEBUFFER, 3);
    ask("retained_cube_face", COLOR0 + 1, F);
    s.call("BIND_FRAMEBUFFER", FRAMEBUFFER, 0); ask("default", COLOR0, T);
    one.process(s.bytes()); const view = new DataView(s.bytes().buffer);
    const reference = require("./gl_conformance/fbo_parameters_reference.json").cases;
    // Core FBO queries allow default framebuffer attachments, whereas this
    // extension's query on framebuffer zero is INVALID_OPERATION.
    const expected = { ...reference, default: [1234567, GL.INVALID_OPERATION], retained_cube_face: reference.cube_face };
    for (const [name, at] of cases) {
        assert.deepEqual([view.getFloat64(at + P.RECORDS.QUERY_PARAMETER.size, true), view.getUint32(at + P.F.QUERY_PARAMETER.error, true)], expected[name], name);
        assert.equal(view.getUint32(at + P.F.QUERY_PARAMETER.status, true), expected[name][1] ? P.C.V86GL_SYNC_QUERY_STATUS_FAILED : OK);
    }
});
test("renderbuffer queries describe the shared storage formats and zero storage", async () => {
    const one = shadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host }); await gpu.initialize();
    const reference = require("./gl_conformance/renderbuffer_parameters_reference.json").cases;
    const pnames = [GL.RENDERBUFFER_WIDTH_EXT, GL.RENDERBUFFER_HEIGHT_EXT, GL.RENDERBUFFER_INTERNAL_FORMAT_EXT,
        GL.RENDERBUFFER_RED_SIZE_EXT, GL.RENDERBUFFER_GREEN_SIZE_EXT, GL.RENDERBUFFER_BLUE_SIZE_EXT,
        GL.RENDERBUFFER_ALPHA_SIZE_EXT, GL.RENDERBUFFER_DEPTH_SIZE_EXT, GL.RENDERBUFFER_STENCIL_SIZE_EXT];
    for (const [name, format] of [["initial", null], ["rgba8", GL.RGBA8], ["rgb8", GL.RGB8], ["rgba4", GL.RGBA4],
            ["depth16", GL.DEPTH_COMPONENT16], ["depth24", GL.DEPTH_COMPONENT24], ["stencil1", GL.STENCIL_INDEX1_EXT],
            ["stencil4", GL.STENCIL_INDEX4_EXT], ["stencil8", GL.STENCIL_INDEX8_EXT], ["stencil16", GL.STENCIL_INDEX16_EXT],
            ["rgba16f", GL.RGBA16F_ARB], ["zero_width", GL.RGBA8]]) {
        const s = scene().call("BIND_RENDERBUFFER", RENDERBUFFER, 9), asks = [];
        if (format) s.call("RENDERBUFFER_STORAGE", RENDERBUFFER, format, name === "zero_width" ? 0 : 7, 5);
        for (const pname of pnames) {
            const at = s.length + 4, h = P.encodeRecord("QUERY_PARAMETER", { query_kind: P.C.V86GL_PARAMETER_RENDERBUFFER,
                target: RENDERBUFFER, pname, value_kind: P.C.V86GL_STATE_INTEGER, data_size: 8 });
            const payload = new Uint8Array(h.length + 8); payload.set(h); s.record(P.GLFN.QUERY_PARAMETER, payload); asks.push(at);
        }
        one.process(s.bytes()); gpu.submit(s.bytes(), {}); const v = new DataView(s.bytes().buffer);
        const values = asks.map(at => { assert.equal(v.getUint32(at + P.F.QUERY_PARAMETER.status, true), OK); return v.getFloat64(at + P.RECORDS.QUERY_PARAMETER.size, true); });
        // WebGPU stores renderbuffer RGBA4 in rgba8unorm. Report that chosen
        // precision, rather than Apple's four-bit choice or the requested size.
        const expected = name === "rgba4" ? [7, 5, GL.RGBA4, 8, 8, 8, 8, 0, 0] : reference[name].values;
        assert.deepEqual(values, expected, name);
        const rb = gpu.current.shareGroup.renderbufferImages.get(gpu.current.renderbufferImage);
        assert.deepEqual([rb.width, rb.height, rb.internalFormat, ...rb.componentBits], values, "renderer " + name);
        if (name === "zero_width") assert.equal(rb.gpuTexture, null, "zero storage must not allocate a 1x5 image");
        if (name.startsWith("stencil")) assert.equal(rb.gpuTexture.descriptor.format, "depth24plus-stencil8");
    }
    const copy = shadow(); copy.setState(JSON.parse(JSON.stringify(one.getState())));
    assert.deepEqual(copy.current.group.renderbufferImages.get(copy.current.renderbufferImage).componentBits, [0, 0, 0, 0, 0, 0]);
});
test("invalid renderbuffer storage leaves the previous image intact", () => {
    for (const [target, format, width, height, expected] of [[0, GL.RGBA8, 4, 4, GL.INVALID_ENUM],
            [RENDERBUFFER, GL.ALPHA8, 4, 4, GL.INVALID_ENUM], [RENDERBUFFER, GL.RGBA8, -1, 4, GL.INVALID_VALUE],
            [RENDERBUFFER, GL.RGBA8, 4, 20000, GL.INVALID_VALUE]]) {
        const one = shadow(), s = scene(); renderbuffer(s, 9, GL.RGBA8, 7, 5); one.process(s.bytes());
        one.process(new GLStream().call("RENDERBUFFER_STORAGE", target, format, width, height).bytes());
        const rb = one.current.group.renderbuffers.get(9);
        assert.equal(one.current.error, expected); assert.deepEqual([rb.width, rb.height, rb.internalFormat], [7, 5, GL.RGBA8]);
    }
    const one = shadow(); one.process(scene().call("RENDERBUFFER_STORAGE", RENDERBUFFER, GL.RGBA8, 1, 1).bytes());
    assert.equal(one.current.error, GL.INVALID_OPERATION);
});
test("texture attribute bindings keep a deleted image alive until the saved binding is released", async () => {
    const one = shadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host }); await gpu.initialize();
    const send = s => { one.process(s.bytes()); gpu.submit(s.bytes(), {}); };
    const s = scene(); texture(s, 7, 4, 4); s.call("PUSH_ATTRIB", 0x40000).names(P.GLFN.DELETE_TEXTURES, [7]); send(s);
    const group = one.current.group, gpuGroup = gpu.current.shareGroup;
    const old = [...group.textureImages.values()].find(t => t.name === 7);
    const gpuOld = [...gpuGroup.textureImages.values()].find(t => t.name === 7);
    assert.ok(old && gpuOld);
    send(new GLStream().call("POP_ATTRIB"));
    assert.equal(one.boundImage(GL.TEXTURE_2D).texture, old); assert.equal(gpu.boundTexture(GL.TEXTURE_2D), gpuOld);
    send(new GLStream().call("BIND_TEXTURE", GL.TEXTURE_2D, 0));
    assert.equal(group.textureImages.has(old.id), false); assert.equal(gpuGroup.textureImages.has(gpuOld.imageId), false);
});

(async () => {
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log("ok   " + name);
        } catch (error) {
            console.error("FAIL " + name + "\n" + (error && error.stack || error));
            process.exitCode = 1;
            return;
        }
    }
    console.log(tests.length + " GL shadow object tests passed");
})();
