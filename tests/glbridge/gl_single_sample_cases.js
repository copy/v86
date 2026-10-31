"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream;
    const cases = ["triangle", "blend", "depth_stencil", "logic", "points", "lines", "glsl_discard", "scissor", "back_stencil", "clipped_points"];
    function scene(s, name) {
        s.call("VIEWPORT", 0, 0, 16, 16).call("DISABLE", GL.MULTISAMPLE).call("ENABLE", GL.SAMPLE_ALPHA_TO_COVERAGE).call("ENABLE", GL.SAMPLE_COVERAGE).call("SAMPLE_COVERAGE", 0, 0)
            .call("CLEAR_COLOR", 0, 0, 1, 1).call("CLEAR_DEPTH", 1).call("CLEAR_STENCIL", 3).call("CLEAR", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT);
        if (name === "glsl_discard") {
            s.call("CREATE_PROGRAM", 1);for (const [id, type, source] of [[2, GL.VERTEX_SHADER, "#version 120\nvoid main(){gl_Position=gl_Vertex;gl_FrontColor=gl_Color;}"],
                [3, GL.FRAGMENT_SHADER, "#version 120\nvoid main(){if(gl_FragCoord.x<6.0)discard;gl_FragColor=gl_Color;gl_FragDepth=.25;}"]])
                s.call("CREATE_SHADER", id, type).shaderSource(id, source).call("COMPILE_SHADER", id).call("ATTACH_SHADER", 1, id);
            s.call("LINK_PROGRAM", 1).call("USE_PROGRAM", 1).call("ENABLE", GL.DEPTH_TEST);
        }
        if (["blend", "points", "lines", "clipped_points"].includes(name)) s.call("ENABLE", GL.BLEND).call("BLEND_FUNC", GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA);
        if (name === "logic") s.call("ENABLE", GL.COLOR_LOGIC_OP).call("LOGIC_OP", GL.XOR);
        if (name === "depth_stencil") s.call("ENABLE", GL.DEPTH_TEST).call("ENABLE", GL.STENCIL_TEST).call("STENCIL_FUNC", GL.ALWAYS, 7, 255).call("STENCIL_OP", GL.KEEP, GL.KEEP, GL.INCR);
        if (name === "back_stencil") s.call("ENABLE", GL.STENCIL_TEST).call("STENCIL_FUNC_SEPARATE", GL.FRONT, GL.ALWAYS, 17, 255).call("STENCIL_FUNC_SEPARATE", GL.BACK, GL.ALWAYS, 165, 255)
            .call("STENCIL_MASK_SEPARATE", GL.FRONT, 15).call("STENCIL_MASK_SEPARATE", GL.BACK, 240).call("STENCIL_OP", GL.KEEP, GL.KEEP, GL.REPLACE);
        if (name === "scissor") s.call("ENABLE", GL.SCISSOR_TEST).call("SCISSOR", 5, 3, 7, 8);
        if (name === "points" || name === "clipped_points") s.call("POINT_SIZE", 5);
        if (name === "lines") s.call("LINE_WIDTH", 3);
        if (name === "clipped_points") s.call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.POINT);
        s.call("BEGIN", name === "points" ? GL.POINTS : name === "lines" ? GL.LINE_STRIP : GL.TRIANGLES);
        for (let i = 0; i < (name === "points" ? 8 : name === "clipped_points" ? 1 : 3); ++i) {
            s.call("COLOR4F", +(i % 3 === 0), +(i % 3 === 1), 0, .5);
            const positions = name === "points" ? [[.0625, .0625]] : name === "lines" ? [[i % 2 ? .5625 : -.4375, (i - 1) * .4375]] :
                name === "clipped_points" ? [[-.75, -.1], [3, 0], [-.75, .1]] : [[-.731, -.647], [.693, -.539], [-.107, .843]];
            for (const p of positions) s.call("VERTEX4F", name === "back_stencil" && i === 1 ? -p[0] : p[0], p[1], i * .1, 1);
        }
        return s.call("END");
    }
    const api = { cases, scene };global.GLSingleSampleCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
