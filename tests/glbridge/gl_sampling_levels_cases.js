"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream;
    function image(s, level, size, rgba) {
        const bytes = new Uint8Array(size * size * 4);for (let i = 0; i < bytes.length; i += 4) bytes.set(rgba, i);
        return s.texImage2D(GL.TEXTURE_2D, level, GL.RGBA8, size, size, GL.RGBA, GL.UNSIGNED_BYTE, bytes);
    }
    const names = ["partial_max", "base_without_zero", "zero_inactive", "incomplete", "zero_base", "base_above_max", "fbo_nonmipmap", "npot_base"];
    function scene(s, name) {
        s.call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 0).call("BIND_TEXTURE", GL.TEXTURE_2D, names.indexOf(name) + 1).call("ENABLE", GL.TEXTURE_2D)
            .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST_MIPMAP_NEAREST).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
        if (name === "base_without_zero") image(s, 2, 2, [0, 0, 255, 255]).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 2).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 2);
        else {
            image(s, 0, name === "zero_inactive" || name === "zero_base" ? 0 : name === "npot_base" ? 9 : 4, [255, 0, 0, 255]);
            if (name !== "zero_base") image(s, 1, name === "npot_base" ? 4 : 2, [0, 255, 0, 255]);
            if (name === "partial_max") s.call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 1);
            if (name === "zero_inactive" || name === "npot_base") s.call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 1).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 1);
            if (name === "base_above_max") s.call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 1).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 0).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
        }
        if (name === "fbo_nonmipmap") return s.call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 1).call("BIND_FRAMEBUFFER", GL.FRAMEBUFFER_EXT, 1)
            .call("FRAMEBUFFER_TEXTURE_2D", GL.FRAMEBUFFER_EXT, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, names.indexOf(name) + 1, 1, 0);
        return s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("COLOR4F", 1, 1, 1, 1).call("TEX_COORD2F", 0.5, 0.5)
            .call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, 0).call("VERTEX3F", 3, -1, 0).call("VERTEX3F", -1, 3, 0).call("END");
    }
    global.GLSamplingLevelsCases = { scene, names };
    if (typeof module !== "undefined" && module.exports) module.exports = { scene, names };
})(typeof globalThis !== "undefined" ? globalThis : this);
