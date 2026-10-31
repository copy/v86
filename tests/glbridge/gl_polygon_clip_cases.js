"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream;
    const cases = [
        { name: "fixed_view_line" }, { name: "fixed_view_point", point: true }, { name: "fixed_top_line", top: true },
        { name: "fixed_corner_point", point: true, corner: true }, { name: "fixed_near_line", near: true }, { name: "fixed_far_point", point: true, far: true },
        { name: "fixed_user_line", user: true }, { name: "fixed_user_point", user: true, point: true },
        { name: "fixed_two_planes_point", user: true, two: true, point: true }, { name: "fixed_homogeneous", user: true, homogeneous: true },
        { name: "fixed_edges_line", edges: true }, { name: "fixed_edges_point", edges: true, point: true },
        { name: "fixed_flat_light_line", light: true }, { name: "fixed_flat_light_point", light: true, point: true },
        { name: "fixed_flat_inside", light: true, inside: true },
        { name: "glsl_view_line", glsl: true }, { name: "glsl_view_point", glsl: true, point: true },
        { name: "glsl_user_line", glsl: true, user: true }, { name: "glsl_negative_clip_w", glsl: true, user: true, clipW: true, point: true },
        { name: "glsl_nonlinear_point", glsl: true, point: true, nonlinear: true },
        { name: "glsl_program_point", glsl: true, point: true, programSize: true },
        { name: "glsl_mixed_back", glsl: true, flip: true, mixed: true }, { name: "glsl_cull_back", glsl: true, flip: true, cull: true },
        { name: "arb_invariant_user", arb: true, user: true }, { name: "arb_noninvariant_user", arb: true, user: true, noninvariant: true },
        { name: "arb_pair_user_point", arb: true, pair: true, user: true, point: true },
        { name: "arb_all_outputs", arb: true, user: true, point: true, all: true },
        { name: "glsl_indexed_user", glsl: true, user: true, indexed: true }, { name: "glsl_vbo_point", glsl: true, point: true, vbo: true },
        { name: "glsl_cross_w", glsl: true, crossW: true },
        { name: "glsl_offset_positive", glsl: true, offset: 16 }, { name: "glsl_offset_negative", glsl: true, offset: -16 },
        { name: "fixed_offset_slope", factor: 1 },
        { name: "fixed_clipped_provoking", light: true, provokingOutside: true },
    ];
    function setup(s, entry) {
        if (entry.glsl) {
            const vs = "#version 120\n" + (entry.nonlinear ? "varying vec4 custom;" : "") + "void main(){gl_Position=gl_ModelViewProjectionMatrix*gl_Vertex;gl_ClipVertex=" +
                (entry.clipW ? "vec4(gl_Vertex.xyz,-1.0)" : "gl_ModelViewMatrix*gl_Vertex") + ";" + (entry.nonlinear ? "custom=vec4(0.0,.1+.05*gl_Vertex.x*gl_Vertex.x,0.0,1.0);gl_PointSize=6.0+4.0*gl_Vertex.x*gl_Vertex.x;" : "gl_FrontColor=gl_Color;" + (entry.programSize ? "gl_PointSize=6.0;" : "")) + "}",
                fs = "#version 120\n" + (entry.nonlinear ? "varying vec4 custom;" : "") + "void main(){gl_FragColor=" + (entry.nonlinear ? "custom" : "gl_Color") + ";}";
            s.call("CREATE_PROGRAM", 1);for (const [id, type, source] of [[2, GL.VERTEX_SHADER, vs], [3, GL.FRAGMENT_SHADER, fs]])
                s.call("CREATE_SHADER", id, type).shaderSource(id, source).call("COMPILE_SHADER", id).call("ATTACH_SHADER", 1, id);
            s.call("LINK_PROGRAM", 1).call("USE_PROGRAM", 1);
        }
        if (entry.arb) {
            let source = "!!ARBvp1.0\n" + (entry.noninvariant ? "MOV result.position,vertex.position;" : "OPTION ARB_position_invariant;") + "MOV result.color,vertex.color;";
            if (entry.all) { source += "MOV result.color.back,{1,0,0,1};MOV result.color.secondary,{0,0,0,0};MOV result.color.back.secondary,{0,0,0,0};MOV result.pointsize,{4,0,0,1};";for (let i = 0; i < 8; ++i) source += "MOV result.texcoord[" + i + "],vertex.position;"; }
            s.call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 1).programStringARB(GL.VERTEX_PROGRAM_ARB, source + "END").call("ENABLE", GL.VERTEX_PROGRAM_ARB);
            if (entry.pair) s.call("BIND_PROGRAM_ARB", GL.FRAGMENT_PROGRAM_ARB, 2).programStringARB(GL.FRAGMENT_PROGRAM_ARB, "!!ARBfp1.0\nMOV result.color,fragment.color;END").call("ENABLE", GL.FRAGMENT_PROGRAM_ARB);
        }
        if (entry.user) s.call("CLIP_PLANE", GL.CLIP_PLANE0, 0, 0, 0, -1).call("CLIP_PLANE", GL.CLIP_PLANE0 + 5, -1, 0, 0, 0.125).call("ENABLE", GL.CLIP_PLANE0 + 5);
        if (entry.two) s.call("CLIP_PLANE", GL.CLIP_PLANE0 + 4, 0, 1, 0, 0).call("ENABLE", GL.CLIP_PLANE0 + 4);
        if (entry.flip) s.call("SCALEF", -1, 1, 1);
        if (entry.cull) s.call("ENABLE", GL.CULL_FACE).call("CULL_FACE", GL.BACK);
        if (entry.nonlinear || entry.programSize || entry.all) s.call("ENABLE", GL.VERTEX_PROGRAM_POINT_SIZE);
        if (entry.all) s.call("ENABLE", GL.VERTEX_PROGRAM_TWO_SIDE).call("ENABLE", GL.COLOR_SUM);
        if (entry.light) {
            s.call("ENABLE", GL.LIGHTING).call("ENABLE", GL.LIGHT0).call("SHADE_MODEL", GL.FLAT).call("NORMAL3F", 0, 0, 1)
                .call("LIGHT_MODELFV", GL.LIGHT_MODEL_AMBIENT, 4, 0, 0, 0, 1).call("LIGHTFV", GL.LIGHT0, GL.POSITION, 4, 3, 0, 2, 1)
                .call("LIGHTFV", GL.LIGHT0, GL.AMBIENT, 4, 0, 0, 0, 1).call("LIGHTFV", GL.LIGHT0, GL.DIFFUSE, 4, 0, 1, 0, 1)
                .call("LIGHTF", GL.LIGHT0, GL.LINEAR_ATTENUATION, 0.2).call("MATERIALFV", GL.FRONT_AND_BACK, GL.DIFFUSE, 4, 1, 1, 1, 1);
        }
        return s.call("POINT_SIZE", 4).call("LINE_WIDTH", 3);
    }
    function vertices(entry) {
        const points = entry.corner ? [[-0.75, -0.75, 0, 1], [3, -0.75, 0, 1], [-0.75, 3, 0, 1]] :
            entry.near || entry.far ? [[-0.75, -0.75, entry.near ? -0.5 : 0.5, 1], [0.75, 0, entry.near ? -3 : 3, 1], [-0.75, 0.75, entry.near ? -0.5 : 0.5, 1]] :
                [[-0.75, -0.75, 0, entry.crossW ? -1 : 1], [entry.inside ? 0.75 : 3, 0, 0, 1], [-0.75, 0.75, 0, 1]];
        for (const point of points) { if (entry.top) [point[0], point[1]] = [point[1], point[0]];if (entry.factor) point[2] = point[0] * 0.2;if (entry.homogeneous) for (let i = 0; i < 4; ++i) point[i] *= 2; }
        if (entry.provokingOutside) points.unshift(points.pop());
        return points;
    }
    function geometry(s, entry, color) {
        s.call("COLOR4F", ...color);const points = vertices(entry);
        if (entry.indexed) {
            const data = new Float32Array(24);for (const [i, at] of [5, 1, 3].entries()) data.set(points[i], at * 4);
            return s.drawElements(GL.TRIANGLES, new Uint16Array([5, 1, 3]), GL.UNSIGNED_SHORT, { vertex: { size: 4, type: GL.FLOAT, stride: 16, data } });
        }
        if (entry.vbo) {
            const data = new Float32Array(points.flat());return s.call("BIND_BUFFER", GL.ARRAY_BUFFER, 1).bufferData(GL.ARRAY_BUFFER, data.byteLength, GL.STATIC_DRAW, new Uint8Array(data.buffer))
                .pointerVBO("VERTEX_POINTER_VBO", 4, GL.FLOAT, 16, 0).call("ENABLE_CLIENT_STATE", GL.VERTEX_ARRAY).call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 0, 3);
        }
        s.call("BEGIN", GL.TRIANGLES);for (const [i, point] of points.entries()) { if (entry.edges) s.call("EDGE_FLAG", +(i !== 1));s.call("VERTEX4F", ...point); } return s.call("END");
    }
    function draw(s, entry) {
        s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR_DEPTH", 1).call("CLEAR", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
        if (entry.offset !== undefined || entry.factor) {
            s.call("ENABLE", GL.DEPTH_TEST).call("DEPTH_FUNC", GL.LEQUAL).call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.FILL);geometry(s, entry, [0, 0, 1, 1]);
            s.call("ENABLE", GL.POLYGON_OFFSET_LINE).call("POLYGON_OFFSET", entry.factor || 0, entry.offset || 0);
        }
        s.call("POLYGON_MODE", GL.FRONT_AND_BACK, entry.point ? GL.POINT : GL.LINE);if (entry.mixed) s.call("POLYGON_MODE", GL.FRONT, GL.FILL);
        return geometry(s, entry, [0, 1, 0, 1]);
    }
    const api = { cases, setup, draw, vertices };global.GLPolygonClipCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
