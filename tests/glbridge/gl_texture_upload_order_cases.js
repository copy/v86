"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const names = ["rgba", "rendered", "volume", "cube", "bc1", "depth16", "depth32"];
    function image(s, name, fields, bytes) {
        const header = P.encodeRecord(name, { ...fields, data_size: bytes.length }), payload = new Uint8Array(header.length + bytes.length);
        payload.set(header);payload.set(bytes, header.length);return s.record(P.GLFN[name], payload);
    }
    function draw(s, x) {
        return s.call("VIEWPORT", x, 0, 8, 16).call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, 0)
            .call("VERTEX3F", 3, -1, 0).call("VERTEX3F", -1, 3, 0).call("END");
    }
    function scene(s, name) {
        const target = name === "volume" ? GL.TEXTURE_3D : name === "cube" ? GL.TEXTURE_CUBE_MAP : GL.TEXTURE_2D,
            face = name === "cube" ? GL.TEXTURE_CUBE_MAP_NEGATIVE_X : target, depth = name.startsWith("depth"),
            type = name === "depth16" ? GL.UNSIGNED_SHORT : depth ? GL.FLOAT : GL.UNSIGNED_BYTE,
            initial = depth ? new Uint8Array((name === "depth16" ? new Uint16Array([16384]) : new Float32Array([0.25])).buffer) : new Uint8Array([255, 0, 0, 255]),
            updated = depth ? new Uint8Array((name === "depth16" ? new Uint16Array([49151]) : new Float32Array([0.75])).buffer) : new Uint8Array([0, 0, 255, 255]);
        s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 0).call("DISABLE", GL.TEXTURE_2D).call("DISABLE", GL.TEXTURE_3D).call("DISABLE", GL.TEXTURE_CUBE_MAP)
            .call("BIND_TEXTURE", target, names.indexOf(name) + 1).call("ENABLE", target)
            .call("TEX_PARAMETERI", target, GL.TEXTURE_MIN_FILTER, GL.NEAREST).call("TEX_PARAMETERI", target, GL.TEXTURE_MAG_FILTER, GL.NEAREST)
            .call("COLOR4F", 1, 1, 1, 1).call("TEX_COORD4F", name === "cube" ? -1 : 0.5, name === "cube" ? 0 : 0.5, name === "volume" ? 0.75 : 0, 1);
        const fields = { target: face, level: 0, internalformat: depth ? name === "depth16" ? GL.DEPTH_COMPONENT16 : GL.DEPTH_COMPONENT32 : GL.RGBA8,
            width: name === "rendered" || name === "bc1" ? 4 : 1, height: name === "rendered" || name === "bc1" ? 4 : 1,
            depth: 1, format: depth ? GL.DEPTH_COMPONENT : GL.RGBA, type };
        if (depth) s.call("TEX_PARAMETERI", target, GL.DEPTH_TEXTURE_MODE, GL.LUMINANCE);
        if (name === "volume") image(s, "TEX_IMAGE_3D", { ...fields, depth: 2 }, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]));
        else if (name === "cube") for (let f = 0; f < 6; ++f) image(s, "TEX_IMAGE_2D", { ...fields, target: GL.TEXTURE_CUBE_MAP_POSITIVE_X + f }, initial);
        else if (name === "bc1") s.compressedTexImage2D(target, 0, GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, 4, 4, new Uint8Array([0, 248, 0, 0, 0, 0, 0, 0]));
        else image(s, "TEX_IMAGE_2D", fields, name === "rendered" ? new Uint8Array(0) : initial);
        if (name === "rendered") s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 1).call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT,
            GL.COLOR_ATTACHMENT0, target, names.indexOf(name) + 1, 0, 0).call("CLEAR_COLOR", 1, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 0);
        draw(s, 0);
        if (name === "volume") image(s, "TEX_SUB_IMAGE_3D", { ...fields, zoffset: 1 }, updated);
        else if (name === "bc1") s.compressedTexSubImage2D(target, 0, 0, 0, 4, 4, GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, new Uint8Array([31, 0, 0, 0, 0, 0, 0, 0]));
        else {
            const bytes = name === "rendered" ? new Uint8Array(64) : updated;
            if (name === "rendered") for (let at = 0; at < bytes.length; at += 4) bytes.set(updated, at);
            image(s, "TEX_SUB_IMAGE_2D", fields, bytes);
        }
        return draw(s, 8);
    }
    global.GLTextureUploadOrderCases = { scene, names };
    if (typeof module !== "undefined" && module.exports) module.exports = { scene, names };
})(typeof globalThis !== "undefined" ? globalThis : this);
