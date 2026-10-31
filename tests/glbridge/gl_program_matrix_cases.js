"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const values = Array.from({ length: 16 }, (_, i) => i + 1), m7 = GL.MATRIX0_ARB + 7;
    function phase(s, name) {
        switch (name) {
            case "program_zero": return s.call("MATRIX_MODE", GL.MATRIX0_ARB);
            case "load": return s.record(P.GLFN.LOAD_MATRIXF, new Uint8Array(Float32Array.from(values).buffer));
            case "push_translate": return s.call("PUSH_MATRIX").call("TRANSLATEF", 1, 2, 3);
            case "pop": return s.call("POP_MATRIX");
            case "last_matrix": return s.call("MATRIX_MODE", m7).call("SCALEF", 2, 3, 4);
            case "independent": return s.call("MATRIX_MODE", GL.MATRIX0_ARB);
            case "projection": return s.call("MATRIX_MODE", GL.PROJECTION).call("TRANSLATEF", 4, 5, 6);
            case "texture_three": return s.call("MATRIX_MODE", GL.TEXTURE).call("ACTIVE_TEXTURE", GL.TEXTURE0 + 3).call("SCALEF", 5, 6, 7);
            case "texture_zero": return s.call("ACTIVE_TEXTURE", GL.TEXTURE0);
            case "transform_attrib": return s.call("MATRIX_MODE", m7).call("PUSH_ATTRIB", GL.TRANSFORM_BIT).call("MATRIX_MODE", GL.MODELVIEW).call("TRANSLATEF", 7, 8, 9).call("POP_ATTRIB");
            case "full_stack": case "overflow": return s.call("PUSH_MATRIX");
            case "empty_stack": case "underflow": return s.call("POP_MATRIX");
            case "invalid_mode": return s.call("MATRIX_MODE", GL.MATRIX0_ARB + 8);
            case "mode_inside_begin": return s.call("BEGIN", GL.POINTS).call("MATRIX_MODE", GL.MATRIX0_ARB).call("END");
            case "list_compile": return s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation: 1, name: 1, value: GL.COMPILE }))
                .call("MATRIX_MODE", GL.MATRIX0_ARB).call("LOAD_IDENTITY").call("TRANSLATEF", 10, 11, 12).record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation: 2 }));
            case "list_call": return s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation: 3, name: 1 }));
            default: return s;
        }
    }
    function query(s, pname, count, kind = P.C.V86GL_STATE_DOUBLE) {
        const bytes = new Uint8Array(24 + count * 8); bytes.set(P.encodeRecord("QUERY_STATE", { pname, value_kind: kind, data_size: count * 8 })); s.record(P.GLFN.QUERY_STATE, bytes);
        return s.payloadView();
    }
    const api = { phase, query, values }; global.GLProgramMatrixCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
