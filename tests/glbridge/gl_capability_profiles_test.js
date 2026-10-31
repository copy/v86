"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_render.js");
const caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
function query(shadow, name, copied) {
    const stream = new GLStream(); stream.queryString(name, 4096);
    let bytes = stream.bytes(); if (copied) bytes = bytes.slice();
    shadow.process(bytes);
    const view = new DataView(bytes.buffer), F = P.F.QUERY_GL_STRING;
    return { status: view.getUint32(4 + F.status, true), text: new TextDecoder().decode(bytes.subarray(4 + P.RECORDS.QUERY_GL_STRING.size)).split("\0")[0] };
}
for (const copied of [false, true]) for (const bc of [false, true]) {
    const shadow = new GLShadow(); shadow.setCapabilities(caps.capabilities({}, { bc }));
    for (let profile = 1; profile <= 5; profile++) {
        shadow.process(new GLStream().makeCurrent(1, 0, 0, 64, 64, profile, 1, 0, profile).bytes());
        const ext = query(shadow, GL.EXTENSIONS, copied).text.split(" ");
        assert.equal(query(shadow, GL.VENDOR, copied).text, "VMware, Inc.");
        assert.equal(query(shadow, GL.RENDERER, copied).text, "SVGA3D; v86 WebGPU bridge");
        assert.equal(query(shadow, GL.VERSION, copied).text.startsWith(profile <= 2 ? "1.5 " : "2.1 "), true);
        assert.equal(query(shadow, GL.SHADING_LANGUAGE_VERSION, copied).status, profile <= 2 ? P.C.V86GL_SYNC_QUERY_STATUS_FAILED : P.C.V86GL_SYNC_QUERY_STATUS_OK);
        assert.equal(shadow.current.error, profile <= 2 ? GL.INVALID_ENUM : GL.NO_ERROR); shadow.current.error = 0;
        assert.equal(ext.includes("GL_EXT_framebuffer_object"), profile >= 4);
        assert.equal(ext.includes("GL_EXT_framebuffer_blit"), profile >= 4);
        assert.equal(ext.includes("GL_ARB_shader_objects"), profile >= 3);
        assert.equal(ext.includes("GL_EXT_texture_compression_s3tc"), bc);
        assert.equal(ext.includes("GL_ARB_texture_float"), false);
        assert.equal(ext.includes("GL_ARB_half_float_pixel"), false);
        assert.equal(ext.includes("GL_ARB_imaging"), false);
        // The same context cannot change its public contract on a switch.
        shadow.process(new GLStream().makeCurrent(1, 0, 0, 64, 64, profile, 1, 0, 6 - profile).bytes());
        assert.deepEqual(query(shadow, GL.EXTENSIONS, copied).text.split(" "), ext);
        shadow.process(new GLStream().call("BEGIN", GL.POINTS).bytes());
        assert.equal(query(shadow, GL.VENDOR, copied).status, P.C.V86GL_SYNC_QUERY_STATUS_FAILED);
        shadow.process(new GLStream().call("END").bytes()); assert.equal(shadow.current.error, GL.INVALID_OPERATION); shadow.current.error = 0;
    }
    const saved = JSON.parse(JSON.stringify(shadow.getState())), restored = new GLShadow();
    // A future implementation must preserve the exact context string table.
    saved.contexts[4].capsStrings[GL.RENDERER] = "saved virtual renderer";
    restored.setState(saved);
    assert.equal(query(restored, GL.RENDERER, copied).text, "saved virtual renderer");
    assert.equal(restored.current.capsProfile, 5);
    assert.equal(query(restored, 0xDEADBEEF, copied).status, P.C.V86GL_SYNC_QUERY_STATUS_FAILED);
    assert.equal(restored.current.error, GL.INVALID_ENUM);
    const legacy = JSON.parse(JSON.stringify(saved));
    legacy.contexts = legacy.contexts.map(({ capsProfile, capsStrings, ...context }) => context);
    legacy.capabilities.profile.strings[GL.RENDERER] = "old saved renderer";
    restored.setState(legacy);
    restored.process(new GLStream().makeCurrent(1, 0, 0, 64, 64, 5, 1, 0).bytes());
    assert.equal(query(restored, GL.RENDERER, copied).text, "old saved renderer");
}
console.log("gl_capability_profiles_test: CPU strings, five WineD3D profiles, optional features, old records, context isolation and frozen snapshots in both memory modes passed");
