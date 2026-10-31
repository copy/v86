"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const names = ["format", "size", "inactive_update", "redefine", "null_image", "copy_image", "copy_sub", "cube_face", "volume_image"];
    function range(s, level) {
        return s.call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, level).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, level);
    }
    function clear(s, texture, level, color) {
        range(s, level).call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 1).call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT,
            GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, level, 0).call("CLEAR_COLOR", ...color).call("CLEAR", GL.COLOR_BUFFER_BIT);
        return s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 0);
    }
    function draw(s, x) {
        return s.call("VIEWPORT", x, 0, 8, 16).call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, 0)
            .call("VERTEX3F", 3, -1, 0).call("VERTEX3F", -1, 3, 0).call("END");
    }
    function setup(s, name) {
        const texture = names.indexOf(name) + 20;
        s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 0).call("BIND_TEXTURE", GL.TEXTURE_2D, texture).call("ENABLE", GL.TEXTURE_2D)
            .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST)
            .call("COLOR4F", 1, 1, 1, 1).call("TEX_COORD2F", 0.125, 0.125)
            .texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(0));
        clear(s, texture, 0, [1, 0, 0, 1]);
        s.texImage2D(GL.TEXTURE_2D, 1, name === "size" || name === "null_image" ? GL.RGBA8 : GL.RGBA16F_ARB,
            name === "size" ? 3 : name === "format" ? 2 : 4, name === "size" ? 5 : name === "format" ? 2 : 4, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(0));
        clear(s, texture, 1, [0, 1, 0, 1]);
        if (name === "cube_face") s.call("BIND_TEXTURE", GL.TEXTURE_CUBE_MAP, 77)
            .call("TEX_PARAMETERI", GL.TEXTURE_CUBE_MAP, GL.TEXTURE_MIN_FILTER, GL.NEAREST).call("TEX_PARAMETERI", GL.TEXTURE_CUBE_MAP, GL.TEXTURE_MAX_LEVEL, 0)
            .texImage2D(GL.TEXTURE_CUBE_MAP_NEGATIVE_X, 0, GL.RGBA16F_ARB, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array(0))
            .call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 2).call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_CUBE_MAP_NEGATIVE_X, 77, 0, 0)
            .call("CLEAR_COLOR", 0, 1, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT);
        if (name === "volume_image") {
            s.call("BIND_TEXTURE", GL.TEXTURE_3D, 78).call("TEX_PARAMETERI", GL.TEXTURE_3D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
            for (const level of [0, 1]) s.record(P.GLFN.TEX_IMAGE_3D, P.encodeRecord("TEX_IMAGE_3D", { target: GL.TEXTURE_3D, level,
                internalformat: GL.RGBA8, width: level ? 3 : 4, height: level ? 5 : 4, depth: level ? 3 : 2, format: GL.RGBA, type: GL.UNSIGNED_BYTE, data_size: 0 }))
                .call("TEX_PARAMETERI", GL.TEXTURE_3D, GL.TEXTURE_BASE_LEVEL, level).call("TEX_PARAMETERI", GL.TEXTURE_3D, GL.TEXTURE_MAX_LEVEL, level)
                .call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 2).call("FRAMEBUFFER_TEXTURE_3D", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_3D, 78, level, level ? 2 : 1)
                .call("CLEAR_COLOR", level ? 0 : 1, level ? 1 : 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT);
        }
        return s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 0).call("BIND_TEXTURE", GL.TEXTURE_2D, texture);
    }
    function scene(s, name) {
        range(s, 0);
        if (name === "cube_face" || name === "volume_image") s.call("BIND_FRAMEBUFFER", GL.READ_FRAMEBUFFER, 2)
            .call("COPY_TEX_IMAGE_2D", GL.TEXTURE_2D, 1, GL.RGBA8, 0, 0, name === "cube_face" ? 2 : 3, name === "cube_face" ? 2 : 5, 0)
            .call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 0);
        if (name === "copy_image" || name === "copy_sub") {
            s.call("CLEAR_COLOR", 0, 0, 1, 1).call("CLEAR", GL.COLOR_BUFFER_BIT);
            if (name === "copy_image") s.call("COPY_TEX_IMAGE_2D", GL.TEXTURE_2D, 1, GL.RGBA8, 0, 0, 3, 3, 0);
            else s.call("COPY_TEX_SUB_IMAGE_2D", GL.TEXTURE_2D, 1, 0, 0, 0, 0, 1, 1);
        }
        if (name === "inactive_update") {
            s.texSubImage2D(GL.TEXTURE_2D, 1, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, new Uint8Array([0, 0, 255, 255]));draw(s, 8);
        }
        if (name === "null_image") { range(s, 1);draw(s, 0); }
        if (name === "redefine" || name === "null_image") s.texImage2D(GL.TEXTURE_2D, 1, GL.RGBA8, name === "null_image" ? 4 : 1, name === "null_image" ? 4 : 1,
            GL.RGBA, GL.UNSIGNED_BYTE, name === "redefine" ? new Uint8Array([0, 0, 255, 255]) : new Uint8Array(0));
        range(s, 1);draw(s, 0);range(s, 0);return draw(s, 8);
    }
    const api = { setup, scene, names, range };global.GLTextureImagesCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
