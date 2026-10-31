"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream;
    const cases = [["rgba4_rgba8", GL.RGBA4, GL.RGBA8], ["rgb5_rgb8", GL.RGB5, GL.RGB8], ["rgba_rgba8", GL.RGBA, GL.RGBA8], ["numeric_rgba8", 4, GL.RGBA8],
        ["alpha4_alpha8", GL.ALPHA4, GL.ALPHA8], ["luminance4_luminance8", GL.LUMINANCE4, GL.LUMINANCE8], ["rgba8_rgba4", GL.RGBA8, GL.RGBA4],
        ["same_rgba4", GL.RGBA4, GL.RGBA4], ["rgba2_rgba4", GL.RGBA2, GL.RGBA4], ["srgb_srgb8", GL.SRGB, GL.SRGB8],
        ["depth24_depth32", GL.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT32], ["copy_rgba4_rgba8", GL.RGBA4, GL.RGBA8], ["numeric_rgba", 4, GL.RGBA]];
    function scene(s, entry) {
        s.call("VIEWPORT", 0, 0, 16, 16).call("BIND_TEXTURE", GL.TEXTURE_2D, 1).call("ENABLE", GL.TEXTURE_2D)
            .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST_MIPMAP_NEAREST).call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST)
            .call("TEX_PARAMETERI", GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 1);
        for (let level = 0; level < 2; ++level) {
            const size = level ? 1 : 2, data = new Uint8Array(size * size * 4);for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
            if (entry[0] === "copy_rgba4_rgba8" && level === 0) s.call("CLEAR_COLOR", 1, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("COPY_TEX_IMAGE_2D", GL.TEXTURE_2D, 0, entry[1], 0, 0, 2, 2, 0);
            else s.texImage2D(GL.TEXTURE_2D, level, entry[level + 1], size, size, entry[0] === "depth24_depth32" ? GL.DEPTH_COMPONENT : GL.RGBA,
                entry[0] === "depth24_depth32" ? GL.FLOAT : GL.UNSIGNED_BYTE, entry[0] === "depth24_depth32" ? new Uint8Array(new Float32Array(size * size).fill(.25).buffer) : data);
        }
        return s.call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("COLOR4F", 1, 1, 1, 1).call("TEX_COORD2F", .5, .5)
            .call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, 0).call("VERTEX3F", 3, -1, 0).call("VERTEX3F", -1, 3, 0).call("END");
    }
    const api = { cases, scene };global.GLFormatCompleteCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
