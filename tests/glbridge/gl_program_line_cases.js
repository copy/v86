"use strict";
(function(global) {
    const P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream;
    const cases = [
        { name: "glsl_horizontal", width: 4 }, { name: "glsl_vertical", width: 4, vertical: true },
        { name: "glsl_diagonal", width: 3, diagonal: true }, { name: "glsl_reverse", width: 4, reverse: true },
        { name: "glsl_stipple", width: 1, stipple: true }, { name: "glsl_wide_stipple", width: 4, stipple: true },
        { name: "glsl_strip", width: 3, stipple: true, strip: true }, { name: "glsl_loop", width: 2, stipple: true, loop: true },
        { name: "glsl_indexed", width: 4, indexed: true }, { name: "glsl_vbo", width: 4, vbo: true },
        { name: "glsl_flat", width: 4, flat: true }, { name: "glsl_cross_w", width: 4, crossW: true },
        { name: "arb_horizontal", width: 4, arb: true }, { name: "arb_stipple", width: 4, arb: true, stipple: true },
        { name: "arb_strip", width: 3, arb: true, stipple: true, strip: true }, { name: "arb_flat", width: 4, arb: true, flat: true },
        { name: "glsl_matrix", width: 4, matrix: true }, { name: "glsl_attributes", width: 4, attributes: true },
        { name: "glsl_polygon", width: 3, polygon: true }, { name: "glsl_polygon_stipple", width: 3, polygon: true, stipple: true },
        { name: "glsl_polygon_flat", width: 3, polygon: true, flat: true }, { name: "arb_polygon_stipple", width: 3, polygon: true, stipple: true, arb: true },
    ];
    function bindAttribute(s, location, text) {
        const name = new TextEncoder().encode(text + "\0"), header = P.encodeRecord("BIND_ATTRIB_LOCATION", { program: 1, location, name_length: name.length }), payload = new Uint8Array(header.length + name.length);
        payload.set(header);payload.set(name, header.length);s.record(P.GLFN.BIND_ATTRIB_LOCATION, payload);
    }
    function setup(s, entry) {
        if (entry.arb) s.call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 1).programStringARB(GL.VERTEX_PROGRAM_ARB,
            "!!ARBvp1.0\nMUL result.position,vertex.position,{-1,1,1,1};" + (entry.flat ? "MAD result.color,vertex.position,{.25,.25,0,0},{.5,.5,0,1};" : "MOV result.color,vertex.color;") + "END").call("ENABLE", GL.VERTEX_PROGRAM_ARB);
        else {
            const vs = "#version 120\n" + (entry.matrix ? "attribute mat2 basis;" : entry.attributes ? Array.from({ length: 15 }, (_, i) => "attribute vec4 a" + (i + 1) + ";").join("") : "") +
                "void main(){gl_Position=" + (entry.matrix ? "vec4(basis*gl_Vertex.xy,gl_Vertex.zw)" : "gl_Vertex;gl_Position.x=-gl_Position.x") + ";gl_FrontColor=" +
                (entry.flat ? "vec4(gl_Vertex.xy*.25+.5,0.0,1.0)" : entry.attributes ? "(" + Array.from({ length: 15 }, (_, i) => "a" + (i + 1)).join("+") + ")/15.0" : "gl_Color") + ";}", fs = "#version 120\nvoid main(){gl_FragColor=gl_Color;}";
            s.call("CREATE_PROGRAM", 1);for (const [id, type, source] of [[2, GL.VERTEX_SHADER, vs], [3, GL.FRAGMENT_SHADER, fs]])
                s.call("CREATE_SHADER", id, type).shaderSource(id, source).call("COMPILE_SHADER", id).call("ATTACH_SHADER", 1, id);
            if (entry.matrix) { bindAttribute(s, 8, "basis");s.call("VERTEX_ATTRIB4F", 8, -1, 0, 0, 1).call("VERTEX_ATTRIB4F", 9, 0, 1, 0, 1); }
            if (entry.attributes) for (let i = 1; i < 16; ++i) { bindAttribute(s, i, "a" + i);s.call("VERTEX_ATTRIB4F", i, 0, 1, 0, 1); }
            s.call("LINK_PROGRAM", 1).call("USE_PROGRAM", 1);
        }
        s.call("LINE_WIDTH", entry.width).call("SHADE_MODEL", entry.flat ? GL.FLAT : GL.SMOOTH);
        if (entry.stipple) s.call("ENABLE", GL.LINE_STIPPLE).call("LINE_STIPPLE", 1, 0x0F0F);
        if (entry.polygon) s.call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.LINE);
        return s;
    }
    function vertices(entry) {
        let points = entry.strip || entry.loop || entry.polygon ? [[-0.4375, -0.4375, 0, 1], [0.3125, -0.4375, 0, 1], [0.3125, 0.3125, 0, 1]] :
            entry.vertical ? [[0.0625, -0.4375, 0, 1], [0.0625, 0.5625, 0, 1]] : entry.diagonal ? [[-0.4375, -0.4375, 0, 1], [0.5625, 0.0625, 0, 1]] :
                [[-0.4375, -0.1875, 0, entry.crossW ? -1 : 1], [0.5625, -0.1875, 0, 1]];
        if (entry.reverse) points = points.reverse();return points;
    }
    function draw(s, entry) {
        s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("COLOR4F", 0, 1, 0, 1);
        const mode = entry.polygon ? GL.TRIANGLES : entry.strip ? GL.LINE_STRIP : entry.loop ? GL.LINE_LOOP : GL.LINES, points = vertices(entry);
        if (entry.indexed) {
            const data = new Float32Array(24);data.set(points[0], 20);data.set(points[1], 4);
            return s.drawElements(mode, new Uint16Array([5, 1]), GL.UNSIGNED_SHORT, { vertex: { size: 4, type: GL.FLOAT, stride: 16, data } });
        }
        if (entry.vbo) {
            const data = new Float32Array(points.flat());return s.call("BIND_BUFFER", GL.ARRAY_BUFFER, 1).bufferData(GL.ARRAY_BUFFER, data.byteLength, GL.STATIC_DRAW, new Uint8Array(data.buffer))
                .pointerVBO("VERTEX_POINTER_VBO", 4, GL.FLOAT, 16, 0).call("ENABLE_CLIENT_STATE", GL.VERTEX_ARRAY).call("DRAW_ARRAYS_DIRECT", mode, 0, points.length);
        }
        s.call("BEGIN", mode);for (const point of points) s.call("VERTEX4F", ...point);return s.call("END");
    }
    const api = { cases, setup, draw };global.GLProgramLineCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
