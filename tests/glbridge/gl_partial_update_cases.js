"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const names = ["vertex_subranges", "index_subrange", "ragged_colors", "logic_viewport_scissor", "logic_negative_scissor"];
    function bytes(data) {return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);}
    function sub(s, target, offset, data) {
        const payload = new Uint8Array(16 + data.byteLength);payload.set(P.encodeRecord("BUFFER_SUB_DATA", { target, offset, size: data.byteLength, data_size: data.byteLength }));payload.set(data, 16);
        return s.record(P.GLFN.BUFFER_SUB_DATA, payload);
    }
    function vbo(s, data, stride = 0) {
        return s.names(P.GLFN.GEN_BUFFERS, [1]).call("BIND_BUFFER", GL.ARRAY_BUFFER, 1).bufferData(GL.ARRAY_BUFFER, data.byteLength, 0x88E8, data)
            .call("ENABLE_CLIENT_STATE", GL.VERTEX_ARRAY).pointerVBO("VERTEX_POINTER_VBO", 2, GL.FLOAT, stride, 0);
    }
    function draw(s, count = 3) {return s.call("DRAW_ARRAYS_DIRECT", GL.TRIANGLES, 0, count);}
    function scene(s, name) {
        const c = names.indexOf(name);s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 1, 1).call("CLEAR_DEPTH", .75).call("CLEAR_STENCIL", 66)
            .call("CLEAR", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT);
        if (c === 0) {
            const p = new Float32Array([-1, -1, 0, -1, -1, 1, -1, 1, 0, -1, 0, 1]);draw(vbo(s, bytes(p)).call("COLOR4F", 1, 0, 0, 1), 6);
            for (let i = 0; i < 6; ++i) sub(s, GL.ARRAY_BUFFER, i * 8, bytes(new Float32Array([p[i * 2] + 1])));
            draw(s.call("COLOR4F", 0, 1, 0, 1), 6);
        }
        if (c === 1) {
            vbo(s, bytes(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]))).names(P.GLFN.GEN_BUFFERS, [2]).call("BIND_BUFFER", GL.ELEMENT_ARRAY_BUFFER, 2)
                .bufferData(GL.ELEMENT_ARRAY_BUFFER, 6, 0x88E8, bytes(new Uint16Array([0, 1, 2]))).call("COLOR4F", 1, 0, 0, 1).drawElementsDirect(GL.TRIANGLES, 3, GL.UNSIGNED_SHORT, 0);
            sub(s, GL.ELEMENT_ARRAY_BUFFER, 0, bytes(new Uint16Array([1, 3, 2]))).call("COLOR4F", 0, 1, 0, 1).drawElementsDirect(GL.TRIANGLES, 3, GL.UNSIGNED_SHORT, 0);
        }
        if (c === 2) {
            const data = new Uint8Array(36), v = new DataView(data.buffer), xy = [-1, -1, 3, -1, -1, 3];
            for (let i = 0; i < 3; ++i) {v.setFloat32(i * 12, xy[i * 2], true);v.setFloat32(i * 12 + 4, xy[i * 2 + 1], true);data.set([255, 0, 0, 255], i * 12 + 8);}
            draw(vbo(s, data, 12).call("ENABLE_CLIENT_STATE", GL.COLOR_ARRAY).pointerVBO("COLOR_POINTER_VBO", 4, GL.UNSIGNED_BYTE, 12, 8).call("VIEWPORT", 0, 0, 8, 16));
            for (let i = 0; i < 3; ++i) sub(s, GL.ARRAY_BUFFER, i * 12 + 9, new Uint8Array([255]));
            draw(s.call("VIEWPORT", 8, 0, 8, 16));
        }
        if (c === 3 || c === 4) {
            s.call("ENABLE", GL.COLOR_LOGIC_OP).call("LOGIC_OP", GL.XOR).call("ENABLE", GL.SCISSOR_TEST);
            if (c === 3) s.call("VIEWPORT", 2, 3, 10, 8).call("SCISSOR", 4, 5, 5, 4);else s.call("SCISSOR", -2, -3, 6, 7);
            s.call("COLOR4F", 1, 0, 0, 1).call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, 0).call("VERTEX3F", 3, -1, 0).call("VERTEX3F", -1, 3, 0).call("END");
        }
        return s;
    }
    const api = { names, bytes, sub, vbo, draw, scene };global.GLPartialUpdateCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
