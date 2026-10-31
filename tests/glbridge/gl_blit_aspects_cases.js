"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream;
    function framebuffer(s, name, color, depth, stencil) {
        s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, name);
        for (const [id, format, points] of [[name * 2, GL.RGBA8, [GL.COLOR_ATTACHMENT0]], [name * 2 + 1, GL.DEPTH24_STENCIL8, [GL.DEPTH_ATTACHMENT, GL.STENCIL_ATTACHMENT]]]) {
            s.call("BIND_RENDERBUFFER", GL.RENDERBUFFER_EXT, id).call("RENDERBUFFER_STORAGE", GL.RENDERBUFFER_EXT, format, 16, 16);
            for (const point of points) s.call("FRAMEBUFFER_RENDERBUFFER", GL.FRAMEBUFFER_EXT, point, GL.RENDERBUFFER_EXT, id);
        }
        return s.call("DISABLE", GL.SCISSOR_TEST).call("CLEAR_COLOR", ...color, 1).call("CLEAR_DEPTH", depth).call("CLEAR_STENCIL", stencil)
            .call("CLEAR", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT);
    }
    function scene(s, name) {
        framebuffer(s, 1, [1, 0, 0], 0.25, 173);
        s.call("ENABLE", GL.SCISSOR_TEST).call("SCISSOR", 0, 0, 8, 16).call("CLEAR_COLOR", 0, 1, 0, 1).call("CLEAR_DEPTH", 0.125).call("CLEAR_STENCIL", 17)
            .call("CLEAR", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT);
        if (name === "missing") for (const point of [GL.DEPTH_ATTACHMENT, GL.STENCIL_ATTACHMENT]) s.call("FRAMEBUFFER_RENDERBUFFER", GL.FRAMEBUFFER_EXT, point, GL.RENDERBUFFER_EXT, 0);
        framebuffer(s, 2, [0, 0, 1], 0.75, 42);
        s.call("BIND_FRAMEBUFFER", GL.READ_FRAMEBUFFER, 1).call("BIND_FRAMEBUFFER", GL.DRAW_FRAMEBUFFER, 2);
        const mask = name === "depth" ? GL.DEPTH_BUFFER_BIT : name === "stencil" ? GL.STENCIL_BUFFER_BIT : GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT;
        if (name === "scissor") s.call("ENABLE", GL.SCISSOR_TEST).call("SCISSOR", 4, 4, 8, 8);
        if (["straight", "missing"].includes(name)) s.call("BLIT_FRAMEBUFFER", 0, 0, 16, 16, 0, 0, 16, 16, mask, GL.NEAREST);
        else if (name === "scaled") s.call("BLIT_FRAMEBUFFER", 0, 0, 16, 16, 0, 0, 8, 8, mask, GL.NEAREST);
        else if (name === "clipped") s.call("BLIT_FRAMEBUFFER", -8, 0, 8, 16, 0, 0, 16, 16, mask, GL.NEAREST);
        else s.call("BLIT_FRAMEBUFFER", 0, 0, 16, 16, 16, 0, 0, 16, mask, GL.NEAREST);
        return s.call("BIND_FRAMEBUFFER", GL.READ_FRAMEBUFFER, 2);
    }
    const api = { scene, framebuffer };global.GLBlitAspectsCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
