"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const attach = (s, level, slice) => s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 1).call("FRAMEBUFFER_TEXTURE_3D", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_3D, 1, level, slice);
    function setup(s) {
        s.call("BIND_TEXTURE", GL.TEXTURE_3D, 1).record(P.GLFN.TEX_IMAGE_3D, P.encodeRecord("TEX_IMAGE_3D", {
            target: GL.TEXTURE_3D, internalformat: GL.RGBA8, width: 4, height: 4, depth: 4, format: GL.RGBA, type: GL.UNSIGNED_BYTE, data_size: 0 }));
        attach(s, 0, 0).call("VIEWPORT", 0, 0, 4, 4).call("CLEAR_COLOR", 1, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT);
        attach(s, 0, 1).call("COLOR4F", 0, 1, 0, 1).call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, 0).call("VERTEX3F", 3, -1, 0).call("VERTEX3F", -1, 3, 0).call("END");
        s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 2).call("BIND_RENDERBUFFER", GL.RENDERBUFFER_EXT, 2).call("RENDERBUFFER_STORAGE", GL.RENDERBUFFER_EXT, GL.RGBA8, 4, 4)
            .call("FRAMEBUFFER_RENDERBUFFER", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.RENDERBUFFER_EXT, 2).call("CLEAR_COLOR", 1, 1, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT)
            .call("COPY_TEX_SUB_IMAGE_3D", GL.TEXTURE_3D, 0, 0, 0, 2, 0, 0, 4, 4);
        return attach(s, 0, 3).call("CLEAR_COLOR", 0, 0, 1, 1).call("CLEAR", GL.COLOR_BUFFER_BIT)
            .call("COLOR_MASK", 1, 0, 0, 0).call("CLEAR_COLOR", 1, 0, 0, 0).call("CLEAR", GL.COLOR_BUFFER_BIT).call("COLOR_MASK", 1, 1, 1, 1);
    }
    function scene(s, name) {
        if (name.startsWith("slice")) return attach(s, 0, Number(name.slice(5)));
        if (name === "copy2d") return attach(s, 0, 3).call("BIND_TEXTURE", GL.TEXTURE_2D, 7).call("COPY_TEX_IMAGE_2D", GL.TEXTURE_2D, 0, GL.RGBA8, 0, 0, 4, 4, 0)
            .call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 3).call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, 7, 0, 0);
        if (name === "blit3d") return attach(s, 0, 1).call("BIND_FRAMEBUFFER", GL.DRAW_FRAMEBUFFER, 4)
            .call("FRAMEBUFFER_TEXTURE_3D", GL.DRAW_FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_3D, 1, 0, 3)
            .call("BLIT_FRAMEBUFFER", 0, 0, 4, 4, 4, 0, 0, 4, GL.COLOR_BUFFER_BIT, GL.NEAREST).call("BIND_FRAMEBUFFER", GL.READ_FRAMEBUFFER, 4);
        if (name === "mip1_0") s.call("BIND_TEXTURE", GL.TEXTURE_3D, 1).call("GENERATE_MIPMAP", GL.TEXTURE_3D);
        return attach(s, name === "mip2_0" ? 2 : 1, name === "mip1_1" ? 1 : 0);
    }
    const api = { setup, scene };global.GLVolumeCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
