"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const cases = [
        { name: "fixed_even", size: 4 }, { name: "fixed_odd", size: 3.2 }, { name: "fixed_fractional", size: 3.6 },
        { name: "fixed_centre", size: 4, x: 0.11, y: -0.08 }, { name: "fixed_clipped", size: 8, x: 1.125 },
        { name: "fixed_depth_clipped", size: 8, z: 1.125 }, { name: "fixed_indexed", size: 4, indexed: true },
        { name: "glsl_all_attributes", size: 4, glsl: true, attributes: true },
        { name: "glsl_matrix", size: 4, glsl: true, matrix: true },
        { name: "glsl_size", size: 2, glsl: true, programSize: 6 },
        { name: "glsl_size_disabled", size: 4, glsl: true, programSize: 8, disabledSize: true },
        { name: "glsl_indexed", size: 4, glsl: true, indexed: true },
        { name: "glsl_polygon", size: 4, glsl: true, polygon: true },
        { name: "glsl_clipped", size: 8, glsl: true, x: 1.125 },
        { name: "fragment_only", size: 4, glsl: true, fragmentOnly: true },
        { name: "arb_size", size: 4, arb: true },
        { name: "arb_program_size", size: 2, arb: true, programSize: 6 },
        { name: "arb_size_disabled", size: 4, arb: true, programSize: 8, disabledSize: true },
        { name: "arb_indexed", size: 4, arb: true, indexed: true },
        { name: "arb_polygon", size: 4, arb: true, polygon: true },
        { name: "arb_clipped", size: 8, arb: true, x: 1.125 },
        { name: "fixed_sprite", size: 4.4, sprite: true, x: 0.08, y: -0.08 },
        { name: "glsl_sprite", size: 4.4, glsl: true, sprite: true, x: 0.08, y: -0.08 },
        { name: "arb_sprite", size: 4.4, arb: true, sprite: true, x: 0.08, y: -0.08 },
        { name: "fixed_minimum", size: 4, minimum: true },
        { name: "glsl_minimum", size: 4, minimum: true, glsl: true },
        { name: "glsl_program_minimum", size: 4, minimum: true, glsl: true, programSize: 6 },
        { name: "arb_program_minimum", size: 4, minimum: true, arb: true, programSize: 6 },
    ];
    function bindAttribute(s, location, text) {
        const name = new TextEncoder().encode(text + "\0"), header = P.encodeRecord("BIND_ATTRIB_LOCATION", { program: 1, location, name_length: name.length }), payload = new Uint8Array(header.length + name.length);
        payload.set(header);payload.set(name, header.length);s.record(P.GLFN.BIND_ATTRIB_LOCATION, payload);
    }
    function setup(s, entry) {
        if (entry.glsl) {
            const declarations = entry.attributes ? Array.from({ length: 15 }, (_, i) => "attribute vec4 a" + (i + 1) + ";").join("") : entry.matrix ? "attribute mat4 basis;" : "",
                color = entry.attributes ? "(" + Array.from({ length: 15 }, (_, i) => "a" + (i + 1)).join("+") + ")/15.0" : entry.matrix ? "basis[3]" : "gl_Color",
                vs = "#version 120\n" + declarations + "void main(){gl_Position=gl_Vertex;gl_FrontColor=" + color + ";" + (entry.programSize ? "gl_PointSize=" + entry.programSize.toFixed(1) + ";" : "") + "}",
                fs = "#version 120\nvoid main(){gl_FragColor=gl_Color;}";
            s.call("CREATE_PROGRAM", 1);
            for (const [id, type, source, skip] of [[2, GL.VERTEX_SHADER, vs, entry.fragmentOnly], [3, GL.FRAGMENT_SHADER, fs, false]]) if (!skip)
                s.call("CREATE_SHADER", id, type).shaderSource(id, source).call("COMPILE_SHADER", id).call("ATTACH_SHADER", 1, id);
            if (entry.attributes) for (let i = 1; i < 16; ++i) { bindAttribute(s, i, "a" + i);s.call("VERTEX_ATTRIB4F", i, 0, 1, 0, 1); }
            if (entry.matrix) { bindAttribute(s, 4, "basis");for (let i = 4; i < 8; ++i) s.call("VERTEX_ATTRIB4F", i, 0, 1, 0, 1); }
            s.call("LINK_PROGRAM", 1).call("USE_PROGRAM", 1);
        }
        if (entry.arb) s.call("BIND_PROGRAM_ARB", GL.VERTEX_PROGRAM_ARB, 1).programStringARB(GL.VERTEX_PROGRAM_ARB,
            "!!ARBvp1.0\nMOV result.position,vertex.position;MOV result.color,vertex.color;" + (entry.programSize ? "MOV result.pointsize,{" + entry.programSize + ",0,0,1};" : "") + "END").call("ENABLE", GL.VERTEX_PROGRAM_ARB);
        if (entry.programSize && !entry.disabledSize) s.call("ENABLE", GL.VERTEX_PROGRAM_POINT_SIZE);
        if (entry.sprite) s.call("ENABLE", GL.POINT_SPRITE);
        if (entry.minimum) s.call("POINT_PARAMETERF", GL.POINT_SIZE_MIN, 10);
        return s.call("POINT_SIZE", entry.size);
    }
    function vertices(entry) {
        return entry.polygon ? [[-0.5, -0.5, 0, 1], [0.5, -0.5, 0, 1], [0, 0.5, 0, 1]] :
            entry.indexed ? [[0, 0, 0, 1], [0.5, 0, 0, 1], [0, 0, 0, 1], [-0.5, 0, 0, 1]] : [[entry.x || 0, entry.y || 0, entry.z || 0, 1]];
    }
    function draw(s, entry) {
        s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("COLOR4F", 0, 1, 0, 1);
        if (entry.polygon) s.call("POLYGON_MODE", GL.FRONT_AND_BACK, GL.POINT);
        const values = vertices(entry);
        if (entry.indexed) return s.drawElements(GL.POINTS, new Uint16Array([3, 1]), GL.UNSIGNED_SHORT,
            { vertex: { size: 4, type: GL.FLOAT, stride: 16, data: new Float32Array(values.flat()) } });
        s.call("BEGIN", entry.polygon ? GL.TRIANGLES : GL.POINTS);for (const point of values) s.call("VERTEX4F", ...point);return s.call("END");
    }
    function expected(entry) {
        // GL 2.1 sections 2.12 and 3.3.1: Apple centres odd points one
        // pixel low at integer window coordinates. Both drivers expand
        // outside x/y; Apple supports a different sprite width granularity.
        // Retain raw native output; the named probes use the normative rule.
        if (["fixed_clipped", "glsl_clipped", "arb_clipped"].includes(entry.name)) return Array(16).fill(0);
        if (["fixed_sprite", "glsl_sprite", "arb_sprite"].includes(entry.name)) return Array.from({ length: 16 }, (_, y) => y >= 5 && y <= 9 ? 1984 : 0);
        if (entry.name === "fixed_odd") return Array.from({ length: 16 }, (_, y) => y >= 7 && y <= 9 ? 896 : 0);
        return entry.rows;
    }
    const api = { cases, setup, draw, expected };global.GLPointRasterCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
