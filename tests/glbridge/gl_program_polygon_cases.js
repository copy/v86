"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const cases = [
        { name: "glsl_back_fill", flip: true, front: GL.LINE, back: GL.FILL },
        { name: "glsl_front_line", flip: false, front: GL.LINE, back: GL.FILL },
        { name: "glsl_back_line", flip: true, front: GL.FILL, back: GL.LINE },
        { name: "glsl_cull_back", flip: true, front: GL.LINE, back: GL.LINE, cull: GL.BACK },
        { name: "glsl_cull_front", flip: true, front: GL.LINE, back: GL.LINE, cull: GL.FRONT },
        { name: "glsl_facing_line", flip: true, front: GL.LINE, back: GL.LINE, facing: true },
        { name: "glsl_facing_point", flip: true, front: GL.POINT, back: GL.POINT, facing: true },
        { name: "glsl_flat_global", flip: true, front: GL.LINE, back: GL.LINE, flat: true },
        { name: "glsl_front_cw", flip: true, cw: true, front: GL.LINE, back: GL.FILL },
        { name: "glsl_back_color", flip: true, twoSide: true, front: GL.LINE, back: GL.LINE },
        ...[2, 3, 4].map(matrix => ({ name: "glsl_matrix" + matrix, flip: true, matrix, front: GL.LINE, back: GL.FILL })),
        { name: "glsl_indexed", flip: true, indexed: true, front: GL.LINE, back: GL.FILL },
        { name: "glsl_vbo", flip: true, vbo: true, front: GL.LINE, back: GL.FILL },
        { name: "glsl_offset_positive", flip: true, offset: 16, front: GL.LINE, back: GL.LINE },
        { name: "glsl_offset_negative", flip: true, offset: -16, front: GL.LINE, back: GL.LINE },
        { name: "glsl_offset_slope", flip: true, factor: 1, slope: true, front: GL.LINE, back: GL.LINE },
        { name: "glsl_offset_reversed", flip: true, offset: 16, reverse: true, front: GL.LINE, back: GL.LINE },
        { name: "glsl_homogeneous_large", flip: true, scale: 1e20, front: GL.LINE, back: GL.FILL },
        { name: "glsl_homogeneous_small", flip: true, scale: 1e-20, front: GL.LINE, back: GL.FILL },
        { name: "glsl_clip_w", flip: true, clipW: true, front: GL.LINE, back: GL.FILL },
        { name: "glsl_quad", flip: true, quad: true, front: GL.LINE, back: GL.LINE },
        { name: "glsl_blend_order", normalFlip: true, blend: true, front: GL.FILL, back: GL.LINE },
        { name: "fragment_only", flip: true, fragmentOnly: true, facing: true, front: GL.LINE, back: GL.LINE },
        { name: "vertex_only", flip: true, vertexOnly: true, front: GL.LINE, back: GL.FILL },
        { name: "arb_back_fill", flip: true, arb: true, front: GL.LINE, back: GL.FILL },
        { name: "arb_back_line", flip: true, arb: true, front: GL.FILL, back: GL.LINE },
        { name: "arb_back_point", flip: true, arb: true, front: GL.POINT, back: GL.POINT },
        { name: "arb_cull_back", flip: true, arb: true, cull: GL.BACK, front: GL.LINE, back: GL.LINE },
        { name: "arb_flat", flip: true, arb: true, flat: true, front: GL.LINE, back: GL.LINE },
        { name: "arb_offset_negative", flip: true, arb: true, offset: -16, front: GL.LINE, back: GL.LINE },
    ];
    function setup(s, entry) {
        const position = entry.matrix ? entry.matrix === 4 ? "basis*gl_Vertex" : "vec4(basis*gl_Vertex." + (entry.matrix === 2 ? "xy,gl_Vertex.zw)" : "xyz,gl_Vertex.w)") : "gl_Vertex",
            vs = "#version 120\n" + (entry.matrix ? "attribute mat" + entry.matrix + " basis;" : "") + (entry.flat && !entry.arb ? "float info=.1;" : "") +
                "void main(){gl_Position=" + position + ";" + (entry.normalFlip ? "gl_Position.x*=gl_Normal.x;" : entry.flip && !entry.matrix ? "gl_Position.x=-gl_Position.x;" : "") +
                (entry.slope ? "gl_Position.z=gl_Vertex.x*.5;" : "") + (entry.scale ? "gl_Position*=" + entry.scale.toExponential() + ";" : "") +
                (entry.flat ? "info+=.2;gl_FrontColor=vec4(info,gl_Vertex.x*.25+.5,0.0,1.0);" : entry.twoSide ? "gl_FrontColor=vec4(1.0,0.0,0.0,1.0);gl_BackColor=vec4(0.0,1.0,0.0,1.0);" : "gl_FrontColor=gl_Color;") + "}",
            fs = "#version 120\nvoid main(){gl_FragColor=" + (entry.facing ? "gl_FrontFacing?vec4(1.0,0.0,0.0,1.0):vec4(0.0,1.0,0.0,1.0)" : "gl_Color") + ";}";
        if (entry.arb) {
            s.call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 1).programStringARB(GL.VERTEX_PROGRAM_ARB,
                "!!ARBvp1.0\nMUL result.position,vertex.position,{" + (entry.flip ? -1 : 1) + ",1,1,1};" +
                (entry.flat ? "MAD result.color,vertex.position,{0.0,.25,0.0,0.0},{.3,.5,0.0,1.0};" : "MOV result.color,vertex.color;") + "END")
                .call("ENABLE", GL.VERTEX_PROGRAM_ARB);
        } else {
            s.call("CREATE_PROGRAM", 1);
            for (const [id, type, source, skip] of [[2, GL.VERTEX_SHADER, vs, entry.fragmentOnly], [3, GL.FRAGMENT_SHADER, fs, entry.vertexOnly]]) if (!skip)
                s.call("CREATE_SHADER", id, type).shaderSource(id, source).call("COMPILE_SHADER", id).call("ATTACH_SHADER", 1, id);
            if (entry.matrix) {
                const name = new TextEncoder().encode("basis\0"), header = P.encodeRecord("BIND_ATTRIB_LOCATION", { program: 1, location: 8, name_length: name.length }), payload = new Uint8Array(header.length + name.length);
                payload.set(header);payload.set(name, header.length);s.record(P.GLFN.BIND_ATTRIB_LOCATION, payload);
                for (let column = 0; column < entry.matrix; ++column) s.call("VERTEX_ATTRIB4F", 8 + column, ...Array.from({ length: 4 }, (unused, row) => row === column ? column === 0 ? -1 : 1 : 0));
            }
            s.call("LINK_PROGRAM", 1).call("USE_PROGRAM", 1);
        }
        s.call("POLYGON_MODE", GL.FRONT, entry.front).call("POLYGON_MODE", GL.BACK, entry.back).call("SHADE_MODEL", entry.flat ? GL.FLAT : GL.SMOOTH);
        if (entry.fragmentOnly && entry.flip) s.call("SCALEF", -1, 1, 1);
        if (entry.cull) s.call("ENABLE", GL.CULL_FACE).call("CULL_FACE", entry.cull);
        if (entry.cw) s.call("FRONT_FACE", GL.CW);
        if (entry.twoSide) s.call("ENABLE", GL.VERTEX_PROGRAM_TWO_SIDE);
        if (entry.reverse) s.call("DEPTH_RANGE", 1, 0);
        return s;
    }
    function vertices(entry) {
        return (entry.quad ? [[-0.4375, -0.4375], [0.5625, -0.4375], [0.5625, 0.5625], [-0.4375, 0.5625]] :
            [[-0.4375, -0.4375], [0.5625, -0.4375], [0.0625, 0.5625]]).map(([x, y], i) => [x, y, 0, entry.clipW && i === 0 ? -1 : 1]);
    }
    function geometry(s, entry, color) {
        s.call("COLOR4F", ...color);
        if (entry.indexed) {
            const data = new Float32Array(24), values = vertices(entry);for (const [i, index] of [5, 1, 3].entries()) data.set(values[i], index * 4);
            return s.drawElements(GL.TRIANGLES, new Uint16Array([5, 1, 3]), GL.UNSIGNED_SHORT, { vertex: { size: 4, type: GL.FLOAT, stride: 16, data } });
        }
        if (entry.vbo) {
            const data = new Float32Array(vertices(entry).flat());
            return s.call("BIND_BUFFER", GL.ARRAY_BUFFER, 1).bufferData(GL.ARRAY_BUFFER, data.byteLength, GL.STATIC_DRAW, new Uint8Array(data.buffer))
                .pointerVBO("VERTEX_POINTER_VBO", 4, GL.FLOAT, 16, 0).call("ENABLE_CLIENT_STATE", GL.VERTEX_ARRAY).call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 0, 3);
        }
        s.call("BEGIN", entry.quad ? GL.QUADS : GL.TRIANGLES);
        const colors = entry.blend ? [[1, 0, 0, 0.5], [0, 1, 0, 0.5], [0, 0, 1, 0.5]] : [color];
        for (const [primitive, current] of colors.entries()) {
            if (entry.blend) s.call("NORMAL3F", primitive === 1 ? -1 : 1, 0, 1).call("COLOR4F", ...current);
            for (const vertex of vertices(entry)) s.call("VERTEX4F", ...vertex);
        }
        return s.call("END");
    }
    function draw(s, entry) {
        s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR_DEPTH", 1).call("CLEAR", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
        if (entry.offset !== undefined || entry.factor !== undefined) {
            s.call("ENABLE", GL.DEPTH_TEST).call("DEPTH_FUNC", GL.LEQUAL).call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.FILL);
            geometry(s, entry, [0, 0, 1, 1]);s.call("POLYGON_MODE", GL.FRONT, entry.front).call("POLYGON_MODE", GL.BACK, entry.back)
                .call("ENABLE", GL.POLYGON_OFFSET_LINE).call("ENABLE", GL.POLYGON_OFFSET_POINT).call("POLYGON_OFFSET", entry.factor || 0, entry.offset || 0);
        }
        if (entry.blend) s.call("ENABLE", GL.BLEND).call("BLEND_FUNC", GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA);
        return geometry(s, entry, [1, 0, 0, 1]);
    }
    const api = { cases, setup, draw };global.GLProgramPolygonCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
