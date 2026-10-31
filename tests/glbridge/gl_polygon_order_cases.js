"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream;
    function scene(s) {
        s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT)
            .call("ENABLE", GL.BLEND).call("BLEND_FUNC", GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA)
            .call("POLYGON_MODE", GL.FRONT, GL.FILL).call("POLYGON_MODE", GL.BACK, GL.LINE).call("BEGIN", GL.TRIANGLES);
        for (const [color, vertices] of [
            [[1, 0, 0, 0.5], [[-1, -1], [3, -1], [-1, 3]]],
            [[0, 1, 0, 0.5], [[-0.5, -0.5], [-0.5, 0.5], [0.5, -0.5]]],
            [[0, 0, 1, 0.5], [[-1, -1], [3, -1], [-1, 3]]],
        ]) {s.call("COLOR4F", ...color);for (const [x, y] of vertices) s.call("VERTEX3F", x, y, 0);}
        return s.call("END");
    }
    global.GLPolygonOrderCases = { scene };
    if (typeof module !== "undefined" && module.exports) module.exports = { scene };
})(typeof globalThis !== "undefined" ? globalThis : this);
