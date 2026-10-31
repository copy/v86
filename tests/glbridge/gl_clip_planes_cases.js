"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream;
    const cases = [
        ...["fixed", "glsl"].flatMap(stage => [
            { name: stage + "_plane4", stage, mask: 16 }, { name: stage + "_plane5", stage, mask: 32 },
            { name: stage + "_both", stage, mask: 48 }, { name: stage + "_hole", stage, mask: 32, hole: true },
            { name: stage + "_homogeneous", stage, mask: 32, homogeneous: true },
        ]),
        { name: "glsl_negative_clip_w", stage: "glsl", mask: 32, clipW: true, hole: true },
        { name: "glsl_inactive_builtin", stage: "glsl", mask: 32, builtin: true },
        { name: "fragment_only", stage: "fragment", mask: 32 }, { name: "vertex_only", stage: "vertex", mask: 32 },
        { name: "arb_invariant4", stage: "arb", mask: 16, invariant: true },
        { name: "arb_invariant5", stage: "arb", mask: 32, invariant: true },
        { name: "arb_invariant_hole", stage: "arb", mask: 32, invariant: true, hole: true },
        { name: "arb_invariant_homogeneous", stage: "arb", mask: 32, invariant: true, homogeneous: true },
        { name: "arb_noninvariant", stage: "arb", mask: 32, ignored: true },
        { name: "arb_pair_invariant", stage: "pair", mask: 32, invariant: true },
        { name: "arb_pair_noninvariant", stage: "pair", mask: 32, ignored: true },
        { name: "fixed_arb_fragment", stage: "arb_fragment", mask: 32 },
    ];
    function equations(entry) {
        return [[entry.builtin ? 0 : -1, entry.builtin ? 1 : 0, 0, entry.builtin ? 0 : -2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
            [1, 0, 0, -0.125], entry.homogeneous ? [1, 0, 0, 0.25] : entry.ignored ? [0, 0, 0, -1] : [0, 1, 0, entry.clipW ? 0.125 : -0.125]];
    }
    function setup(s, entry) {
        if (["glsl", "fragment", "vertex"].includes(entry.stage)) {
            const vs = "#version 120\nvoid main(){gl_Position=gl_Vertex;gl_ClipVertex=" + (entry.clipW ? "vec4(gl_Vertex.xyz,-1.0)" : "gl_ModelViewMatrix*gl_Vertex") +
                ";gl_FrontColor=" + (entry.builtin ? "vec4(0.0,gl_ClipPlane[0].y,0.0,1.0)" : "gl_Color") + ";}", fs = "#version 120\nvoid main(){gl_FragColor=gl_Color;}";
            s.call("CREATE_PROGRAM", 1);for (const [id, type, source, skip] of [[2, GL.VERTEX_SHADER, vs, entry.stage === "fragment"], [3, GL.FRAGMENT_SHADER, fs, entry.stage === "vertex"]]) if (!skip)
                s.call("CREATE_SHADER", id, type).shaderSource(id, source).call("COMPILE_SHADER", id).call("ATTACH_SHADER", 1, id);
            s.call("LINK_PROGRAM", 1).call("USE_PROGRAM", 1);
        }
        if (["arb", "pair"].includes(entry.stage)) s.call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 1).programStringARB(GL.VERTEX_PROGRAM_ARB,
            "!!ARBvp1.0\n" + (entry.invariant ? "OPTION ARB_position_invariant;" : "MOV result.position,vertex.position;") + "MOV result.color,vertex.color;END").call("ENABLE", GL.VERTEX_PROGRAM_ARB);
        if (["arb_fragment", "pair"].includes(entry.stage)) s.call("BIND_PROGRAM_ARB", GL.FRAGMENT_PROGRAM_ARB, 2).programStringARB(GL.FRAGMENT_PROGRAM_ARB,
            "!!ARBfp1.0\nMOV result.color,fragment.color;END").call("ENABLE", GL.FRAGMENT_PROGRAM_ARB);
        for (const [i, plane] of equations(entry).entries()) {
            s.call("CLIP_PLANE", GL.CLIP_PLANE0 + i, ...plane);
            if (entry.mask & 1 << i) s.call("ENABLE", GL.CLIP_PLANE0 + i);
        }
        return s;
    }
    function draw(s, entry) {
        const w = entry.homogeneous ? 2 : 1;
        s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("COLOR4F", 0, 1, 0, 1).call("BEGIN", GL.QUADS);
        for (const [x, y] of [[-0.75, -0.75], [0.75, -0.75], [0.75, 0.75], [-0.75, 0.75]]) s.call("VERTEX4F", x * w, y * w, 0, w);
        return s.call("END");
    }
    function stress(s) {
        setup(s, { stage: "arb", mask: 32, invariant: true });
        let source = "!!ARBvp1.0\nOPTION ARB_position_invariant;MOV result.color.front,{0,1,0,1};MOV result.color.back,{1,0,0,1};MOV result.pointsize,{6,0,0,1};";
        for (let i = 0; i < 8; ++i) source += "MOV result.texcoord[" + i + "],vertex.position;";
        source += "END";
        return s.programStringARB(GL.VERTEX_PROGRAM_ARB, source).call("ENABLE", GL.VERTEX_PROGRAM_TWO_SIDE).call("ENABLE", GL.VERTEX_PROGRAM_POINT_SIZE)
            .call("ENABLE", GL.COLOR_SUM).call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT)
            .call("BEGIN", GL.POINTS).call("VERTEX4F", 0, -0.5, 0, 1).call("VERTEX4F", 0, 0.5, 0, 1).call("END");
    }
    const api = { cases, setup, draw, equations, stress };global.GLClipPlanesCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
