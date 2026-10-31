"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const phases = ["before_manual", "cpu_manual", "gpu_manual", "gpu_auto_sub", "gpu_no_auto_render", "depth_manual", "depth_auto"];
    function pixels(size, color, depth) {
        if (depth) return new Uint8Array(new Float32Array(size * size).fill(color[0]).buffer);
        const bytes = new Uint8Array(size * size * 4);for (let i = 0; i < bytes.length; i += 4) bytes.set(color, i);return bytes;
    }
    function image(s, level, size, color, depth = false, sub = false) {
        const name = sub ? "TEX_SUB_IMAGE_2D" : "TEX_IMAGE_2D", bytes = pixels(size, color, depth);
        const header = P.encodeRecord(name, { target: GL.TEXTURE_2D, level, internalformat: depth ? GL.DEPTH_COMPONENT32 : GL.RGBA8,
            width: size, height: size, format: depth ? GL.DEPTH_COMPONENT : GL.RGBA, type: depth ? GL.FLOAT : GL.UNSIGNED_BYTE, data_size: bytes.length });
        const payload = new Uint8Array(header.length + bytes.length);payload.set(header);payload.set(bytes, header.length);return s.record(P.GLFN[name], payload);
    }
    function clearBase(s, level, depth, color) {
        s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, depth ? 2 : 1).call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT,
            depth ? GL.DEPTH_ATTACHMENT : GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, depth ? 2 : 1, level, 0)
            .call("DRAW_BUFFER", depth ? GL.NONE : GL.COLOR_ATTACHMENT0).call("READ_BUFFER", depth ? GL.NONE : GL.COLOR_ATTACHMENT0);
        if (depth) s.call("CLEAR_DEPTH", color[0]).call("CLEAR", GL.DEPTH_BUFFER_BIT);
        else s.call("CLEAR_COLOR", ...color).call("CLEAR", GL.COLOR_BUFFER_BIT);
        return s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 0);
    }
    function scene(s, phase) {
        if (phase === "before_manual") {
            s.call("BIND_TEXTURE", GL.TEXTURE_2D, 1);
            for (const [level, size, color] of [[0, 16, [255, 0, 0, 255]], [2, 4, [0, 255, 0, 255]], [3, 2, [0, 0, 255, 255]], [4, 1, [255, 255, 0, 255]]]) image(s, level, size, color);
            return s.call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 2).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 3);
        }
        if (phase === "cpu_manual") return s.call("GENERATE_MIPMAP", GL.TEXTURE_2D);
        if (phase === "gpu_manual") return clearBase(s, 2, false, [0, 1, 1, 1]).call("GENERATE_MIPMAP", GL.TEXTURE_2D);
        if (phase === "gpu_auto_sub") return image(s.call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.GENERATE_MIPMAP, 1), 2, 4, [255, 0, 255, 255], false, true);
        if (phase === "gpu_no_auto_render") return clearBase(s, 2, false, [1, 1, 1, 1]);
        if (phase === "depth_manual") {
            s.call("BIND_TEXTURE", GL.TEXTURE_2D, 2).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 1).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 2);
            image(s, 1, 4, [0.25], true);image(s, 3, 1, [0.875], true);
            return clearBase(s, 1, true, [0.5]).call("GENERATE_MIPMAP", GL.TEXTURE_2D);
        }
        return image(s.call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.GENERATE_MIPMAP, 1), 1, 4, [0.75], true, true);
    }
    // GL 2.1 3.8.8 / EXT_framebuffer_object issue 68: automatic
    // generation runs through p; manual generation stops at q. Mesa's
    // compatibility path stops both at MAX_LEVEL. Keep only these three
    // named consequences normative; retain both raw driver archives.
    function expected(entry) {
        if (entry.level === 4 && ["gpu_auto_sub", "gpu_no_auto_render"].includes(entry.phase)) return [255, 0, 255, 255];
        if (entry.phase === "depth_auto" && entry.level === 3) return [0.75];
        return entry.values;
    }
    global.GLMipmapRangesCases = { scene, phases, expected };
    if (typeof module !== "undefined" && module.exports) module.exports = { scene, phases, expected };
})(typeof globalThis !== "undefined" ? globalThis : this);
