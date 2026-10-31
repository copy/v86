"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream;
    const names = ["shared_colors", "zero_alpha_depth", "ignores_zoom_transfer", "unpack_skips_lsb", "origin_scissor", "latched_color_moves", "ordered_new_masks", "blend_alpha_stencil"],
        bits = new Uint8Array([0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81]);
    function glyph(s, x, y, r, g, b, a) {return s.call("COLOR4F", r, g, b, a).call("WINDOW_POS3F", x, y, .25).bitmap(8, 8, 0, 0, 0, 0, bits);}
    function scene(s, name) {
        const c = names.indexOf(name);s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 1, 1).call("CLEAR_DEPTH", .75).call("CLEAR_STENCIL", 66)
            .call("CLEAR", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT).call("PIXEL_STOREI", 0x0CF5, 1);
        if (c === 0) {glyph(s, 0, 0, 1, 0, 0, 1);glyph(s, 8, 0, 0, 1, 0, 1);glyph(s, 0, 8, 1, 1, 0, .5);glyph(s, 8, 8, 1, 0, 1, 1);}
        if (c === 1) glyph(s.call("ENABLE", GL.DEPTH_TEST), 4, 4, 1, 0, 0, 0);
        if (c === 2) glyph(s.call("PIXEL_ZOOM", 2, -3).call("PIXEL_TRANSFERF", 0x0D14, 0).call("PIXEL_TRANSFERF", 0x0D19, 1), 4, 4, 1, 0, 0, 1);
        if (c === 3) s.call("PIXEL_STOREI", 0x0CF2, 16).call("PIXEL_STOREI", 0x0CF3, 1).call("PIXEL_STOREI", 0x0CF4, 3).call("PIXEL_STOREI", 0x0CF1, 1)
            .call("COLOR4F", 1, 1, 0, 1).call("WINDOW_POS3F", 2, 3, .25).bitmap(8, 4, 0, 0, 0, 0, new Uint8Array([0, 0, 0x90, 1, 0x48, 2, 0x24, 4, 0x12, 8]));
        if (c === 4) s.call("ENABLE", GL.SCISSOR_TEST).call("SCISSOR", 3, 4, 7, 6).call("VIEWPORT", 1, 1, 2, 2).call("COLOR4F", 0, 1, 0, 1)
            .call("WINDOW_POS3F", 6, 7, .25).bitmap(8, 8, 2, 3, 0, 0, bits);
        if (c === 5) s.call("COLOR4F", 1, 0, 0, 1).call("WINDOW_POS3F", 1, 2, .25).call("COLOR4F", 0, 1, 0, 1).bitmap(8, 8, 0, 0, 7, 3, bits)
            .bitmap(0, 0, 0, 0, 0, -2, new Uint8Array()).bitmap(8, 8, 0, 0, 0, 0, bits).call("RASTER_POS4F", 2, 2, 0, 1).bitmap(8, 8, 0, 0, -1, -1, bits);
        if (c === 6) {glyph(s, 1, 1, 1, 0, 0, 1);s.call("COLOR4F", 0, 1, 0, 1).call("WINDOW_POS3F", 7, 7, .25)
            .bitmap(8, 8, 0, 0, 0, 0, new Uint8Array([255, 129, 189, 165, 165, 189, 129, 255]));glyph(s, 4, 4, 1, 1, 0, 1);}
        if (c === 7) {s.call("ENABLE", GL.BLEND).call("BLEND_FUNC", GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA).call("ENABLE", GL.ALPHA_TEST).call("ALPHA_FUNC", GL.GREATER, .25)
            .call("ENABLE", GL.STENCIL_TEST).call("STENCIL_FUNC", GL.ALWAYS, 77, 255).call("STENCIL_OP", GL.KEEP, GL.KEEP, GL.REPLACE);glyph(s, 1, 1, 1, 0, 0, .5);glyph(s, 7, 7, 0, 1, 0, .2);}
        return s.call("PIXEL_TRANSFERF", 0x0D14, 1).call("PIXEL_TRANSFERF", 0x0D19, 0);
    }
    const api = { names, bits, glyph, scene };global.GLBitmapAtlasCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
