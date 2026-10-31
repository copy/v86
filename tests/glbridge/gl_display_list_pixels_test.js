"use strict";
const assert = require("node:assert/strict");
const { GLShadow } = require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_objects.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_arrays.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_textures.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_rasterpos.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_stipple.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_lists.js");
const P = require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
const { GLWebGPUExecutor } = require("../../src/browser/glbridge/gl-webgpu/gl_executor.js");
const { createFakeHost } = require("./gl_fake_gpu.js");
const cases = require("./gl_display_list_pixel_cases.js"), reference = require("./gl_conformance/display_list_pixels_reference.json").cases;
(async () => {
    for (const copied of [false, true]) {
        const shadow = new GLShadow(), { host } = createFakeHost(), gpu = new GLWebGPUExecutor(null, { host, strict: true }); await gpu.initialize();
        const drawn = []; gpu.drawPixelRGBA = (rgba, width, height, x, y, bitmap) => {
            const pixels = Array.from(rgba); if (bitmap) for (let at = 0; at < pixels.length; at += 4) if (!pixels[at + 3]) pixels[at + 3] = 255;
            drawn.push({ pixels, width, height });
        };
        const pages = new Map(), upload = gpu.uploadTexture;
        gpu.uploadTexture = function(destination, data, layout, size) {
            if (destination.texture.descriptor.format === "r8unorm") {
                const width = destination.texture.descriptor.size.width, page = pages.get(destination.texture) || new Uint8Array(width * destination.texture.descriptor.size.height), origin = destination.origin || { x: 0, y: 0 };
                for (let y = 0; y < size.height; ++y) page.set(data.subarray(y * layout.bytesPerRow, y * layout.bytesPerRow + size.width), (origin.y + y) * width + origin.x);
                pages.set(destination.texture, page);
            }
            return upload.call(this, destination, data, layout, size);
        };
        gpu.drawPixelTexture = (texture, view, width, height, x, y, discard, glyph) => {
            assert.ok(glyph, "bitmap uses the mask atlas");
            const page = pages.get(texture), left = Math.round(glyph.uv[0] * texture.descriptor.size.width), bottom = Math.round(glyph.uv[1] * texture.descriptor.size.height), pixels = [];
            for (let row = 0; row < height; ++row) for (let col = 0; col < width; ++col) {
                const on = page[(bottom + row) * texture.descriptor.size.width + left + col];
                pixels.push(...gpu.current.current.rasterColor.map((v, c) => c === 3 ? 255 : on ? Math.round(v * 255) : 0));
            }
            drawn.push({ pixels, width, height });
        };
        const { stream, queries, states } = cases.build(reference), memory = stream.bytes(), segments = shadow.process(memory);
        gpu.options.writeGuestMemory = (at, bytes, metadata) => memory.set(bytes, at + (metadata.originalOffset || 0));
        for (const segment of segments) {
            const bytes = segment.bytes || memory.subarray(segment.offset, segment.offset + segment.length);
            gpu.submit(copied ? bytes.slice() : bytes, { originalOffset: segment.bytes ? 0 : segment.offset });
            const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let at = 0; at < bytes.length;) {
                const fn = v.getUint16(at, true); let size = v.getUint16(at + 2, true); at += 4;
                if (size === 0xFFFF) { size = v.getUint32(at, true); at += 4; }
                if (fn === P.GLFN.QUERY_POLYGON_STIPPLE && v.getUint32(at, true) === 2 && v.getUint32(at + P.F.QUERY_POLYGON_STIPPLE.pbo, true) === 1)
                    assert.deepEqual(Array.from(gpu.current.polygonStipple), reference.find(c => c.name === "pbo_compiling").bytes, "capture-only PBO query does not execute the setter on the renderer");
                at += size;
            }
        }
        await gpu.idle();
        for (const [i, name] of ["bitmap", "draw_pixels"].entries()) assert.deepEqual(drawn[i].pixels, reference.find(c => c.name === name).bytes, name);
        for (const { name, read, expected, error, expectedError } of queries) {
            assert.equal(read.view.getUint32(P.F.QUERY_POLYGON_STIPPLE.status, true), 1, name);
            assert.deepEqual(Array.from(read.bytes.subarray(48, 176)), expected, name);
            assert.equal(error.view.getUint32(P.F.QUERY_ERROR.status, true), 1, name);
            assert.equal(error.view.getUint32(P.F.QUERY_ERROR.value, true), expectedError, name);
        }
        for (const { name, checks, expected } of states) assert.deepEqual(checks.map(q => {
            assert.equal(q.view.getUint32(P.F.QUERY_STATE.status, true), 1, name); return q.view.getFloat64(24, true);
        }), expected, name);
        const texture = gpu.current.shareGroup.textures.get(2), slot = texture.levels[0][0];
        assert.deepEqual(Array.from(slot.pixels), reference.find(c => c.name === "sub_texture").bytes);
        assert.deepEqual(Array.from(gpu.current.shareGroup.textures.get(4).levels[0][0].pixels), reference.find(c => c.name === "swap_texture").bytes);
        assert.deepEqual(Array.from(gpu.current.shareGroup.textures.get(3).levels[0][0].pixels), reference.find(c => c.name === "texture_3d").bytes);
        assert.equal(gpu.current.pixelStore.unpackAlignment, 1); assert.equal(gpu.current.pixelStore.unpackRowLength, 0);
        assert.equal(gpu.readAttachmentView().view, undefined, "a 3D slice read does not create an invalid 2D view");
        assert.equal(shadow.current.error, 0); assert.equal(gpu.stats.refusals, 0); assert.equal(gpu.hostErrors.length, 0);
        const saved = JSON.parse(JSON.stringify(shadow.getState())), restored = new GLShadow(); restored.setState(saved);
        assert.deepEqual(restored.getState(), saved, "snapshot preserves each pixel command's captured client state");
    }
    console.log("13 native display-list pixel cases preserve captured layouts, 3D reads, subimages, PBOs, deferred errors and client state in both modes (passed)");
})().catch(error => { console.error(error); process.exitCode = 1; });
