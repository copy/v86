"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_images.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_render.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js"), caps = require("../../src/browser/glbridge/gl-webgpu/gl_caps.js");
const { GLStream, GL } = require("./gl_stream_builder.js");
const reference = require("./gl_conformance/framebuffer_pixels_reference.json");
const fs = require("node:fs"), zlib = require("node:zlib");
const mesa = JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname + "/gl_conformance/mesa_reference.json.gz"))).fixtures.framebuffer_pixels;
function framebuffer(s, name, format, point) {
    s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, name).call("BIND_RENDERBUFFER", GL.RENDERBUFFER_EXT, name)
        .call("RENDERBUFFER_STORAGE", GL.RENDERBUFFER_EXT, format, 8, 8)
        .call("FRAMEBUFFER_RENDERBUFFER", GL.FRAMEBUFFER_EXT, point, GL.RENDERBUFFER_EXT, name)
        .call("DRAW_BUFFER", point === GL.COLOR_ATTACHMENT0 ? point : GL.NONE)
        .call("READ_BUFFER", point === GL.COLOR_ATTACHMENT0 ? point : GL.NONE);
    return s;
}
for (const copied of [false, true]) for (const oracle of [reference, mesa]) {
    const shadow = new GLShadow(); shadow.setCapabilities(caps.capabilities({}, {}));
    function send(s) { const bytes = s.bytes(); return shadow.process(copied ? bytes.slice() : bytes); }
    send(framebuffer(new GLStream().makeCurrent(1, 0, 0, 16, 16, 1, 1), 1, GL.RGBA8, GL.COLOR_ATTACHMENT0));
    for (const { name, error } of oracle.cases) {
        const s = new GLStream(); let read;
        if (name === "read_color_none") s.call("READ_BUFFER", GL.NONE);
        if (name === "read_depth_present") framebuffer(s, 2, GL.DEPTH_COMPONENT16, GL.DEPTH_ATTACHMENT);
        if (name === "blit_depth_mismatch") framebuffer(s, 3, GL.DEPTH_COMPONENT24, GL.DEPTH_ATTACHMENT).call("BIND_FRAMEBUFFER", GL.READ_FRAMEBUFFER, 2);
        if (name === "blit_depth_match") s.call("BIND_FRAMEBUFFER", GL.DRAW_FRAMEBUFFER, 2);
        if (name === "blit_depth_absent") s.call("BIND_FRAMEBUFFER", GL.DRAW_FRAMEBUFFER, 1);
        if (name === "blit_depth_packed_plain") framebuffer(s, 4, GL.DEPTH24_STENCIL8, GL.DEPTH_ATTACHMENT).call("BIND_FRAMEBUFFER", GL.READ_FRAMEBUFFER, 3);
        if (name.startsWith("read_")) {
            const format = name.includes("stencil") ? GL.STENCIL_INDEX : name.includes("depth") && !name.includes("color_depth") ? GL.DEPTH_COMPONENT : GL.RGBA;
            read = s.readPixels(0, 0, name.includes("zero") ? 0 : 1, 1, format, format === GL.DEPTH_COMPONENT ? GL.FLOAT : GL.UNSIGNED_BYTE, 4);
            read.bytes.fill(0xCD, P.RECORDS.READ_PIXELS.size);
        } else if (name.startsWith("draw_")) s.record(P.GLFN.DRAW_PIXELS, (() => {
            const header = P.encodeRecord("DRAW_PIXELS", { width: 1, height: 1, format: name.includes("depth") ? GL.DEPTH_COMPONENT : GL.STENCIL_INDEX, type: name.includes("depth") ? GL.FLOAT : GL.UNSIGNED_BYTE, data_size: 4 });
            const bytes = new Uint8Array(header.length + 4); bytes.set(header); return bytes;
        })());
        else if (name.startsWith("copy_")) s.call("COPY_PIXELS", 0, 0, 1, 1, name.includes("depth") ? GL.DEPTH : name.includes("stencil") ? GL.STENCIL : GL.COLOR);
        else s.call("BLIT_FRAMEBUFFER", 0, 0, 1, 1, 0, 0, 1, 1, GL.DEPTH_BUFFER_BIT, GL.NEAREST);
        // Keep the original packet for checking an inline CPU failure.
        const bytes = s.bytes(), packet = copied ? bytes.slice() : bytes, forwarded = shadow.process(packet);
        if (copied) bytes.set(packet);
        // GL 2.1 3.6.4 emits coloured fragments with supplied depth. With no
        // depth buffer the depth test passes (4.1.6); Mesa rejects this case.
        // DEPTH_COMPONENT24 may allocate a larger representation. Apple and
        // this virtual profile use 32 bits; Mesa uses 24, matching packed 24.
        if (name === "blit_depth_packed_plain") assert.equal(error, oracle.depthBits[1] === oracle.depthBits[2] ? 0 : GL.INVALID_OPERATION);
        const expected = name === "draw_depth_missing" ? 0 : name === "blit_depth_packed_plain" ? GL.INVALID_OPERATION : error;
        assert.equal(shadow.current.error, expected, name); shadow.current.error = 0;
        if (read && expected) {
            assert.equal(read.view.getUint32(P.F.READ_PIXELS.status, true), P.C.V86GL_SYNC_QUERY_STATUS_FAILED, name);
            assert.deepEqual(Array.from(read.bytes.subarray(P.RECORDS.READ_PIXELS.size)), [205, 205, 205, 205]);
            assert.ok(forwarded, "failed read must be filtered before the renderer");
        }
    }
    // The virtual device allocates a 32-bit depth texture for a 24-bit
    // request. It can blit to its 32-bit renderbuffer despite different
    // requested enums; packed depth24 remains a different actual format.
    const texture = new GLStream().call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 5).call("BIND_TEXTURE", GL.TEXTURE_2D, 1)
        .record(P.GLFN.TEX_IMAGE_2D, P.encodeRecord("TEX_IMAGE_2D", { target: GL.TEXTURE_2D, internalformat: GL.DEPTH_COMPONENT24, width: 8, height: 8, format: GL.DEPTH_COMPONENT, type: GL.FLOAT }))
        .call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT, GL.DEPTH_ATTACHMENT, GL.TEXTURE_2D, 1, 0, 0)
        .call("DRAW_BUFFER", GL.NONE).call("READ_BUFFER", GL.NONE).call("BIND_FRAMEBUFFER", GL.READ_FRAMEBUFFER, 3)
        .call("BLIT_FRAMEBUFFER", 0, 0, 1, 1, 0, 0, 1, 1, GL.DEPTH_BUFFER_BIT, GL.NEAREST);
    send(texture); assert.equal(shadow.current.error, 0);

}
console.log("gl_framebuffer_pixels_test: 17 Apple/Mesa attachment/read-none/blit cases, failed CPU reads preserve memory in both modes passed");
