"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const pnames = [GL.ACTIVE_STENCIL_FACE_EXT, GL.STENCIL_TEST_TWO_SIDE_EXT, GL.STENCIL_FUNC, GL.STENCIL_REF, GL.STENCIL_VALUE_MASK, GL.STENCIL_WRITEMASK,
        GL.STENCIL_FAIL, GL.STENCIL_PASS_DEPTH_FAIL, GL.STENCIL_PASS_DEPTH_PASS, GL.STENCIL_BACK_FUNC, GL.STENCIL_BACK_REF,
        GL.STENCIL_BACK_VALUE_MASK, GL.STENCIL_BACK_WRITEMASK, GL.STENCIL_BACK_FAIL, GL.STENCIL_BACK_PASS_DEPTH_FAIL, GL.STENCIL_BACK_PASS_DEPTH_PASS];
    const list = (s, operation, name = 0, value = 0) => s.record(P.GLFN.LIST_COMMAND, P.encodeRecord("LIST_COMMAND", { operation, name, value }));
    function phase(s, name) {
        switch (name) {
            case "core_back": return s.call("STENCIL_FUNC_SEPARATE", GL.BACK, GL.LESS, 5, 15);
            case "ext_back": return s.call("ACTIVE_STENCIL_FACE", GL.BACK).call("STENCIL_FUNC", GL.GREATER, 7, 240);
            case "front_separate": return s.call("STENCIL_FUNC_SEPARATE", GL.FRONT, GL.NOTEQUAL, 3, 170);
            case "front_nonseparate": return s.call("ACTIVE_STENCIL_FACE", GL.FRONT).call("STENCIL_FUNC", GL.EQUAL, 11, 176);
            case "ext_back_kept": case "ext_mask_kept": return s.call("ACTIVE_STENCIL_FACE", GL.BACK);
            case "ext_enabled": return s.call("ENABLE", GL.STENCIL_TEST_TWO_SIDE_EXT);
            case "attrib_restored": return s.call("PUSH_ATTRIB", GL.STENCIL_BUFFER_BIT).call("ACTIVE_STENCIL_FACE", GL.FRONT).call("STENCIL_FUNC", GL.ALWAYS, 13, 192)
                .call("ACTIVE_STENCIL_FACE", GL.BACK).call("STENCIL_FUNC", GL.NEVER, 19, 208).call("STENCIL_MASK", 7).call("POP_ATTRIB");
            case "separate_masks": return s.call("STENCIL_MASK_SEPARATE", GL.BACK, 51).call("STENCIL_MASK", 119);
            case "front_mask": return s.call("ACTIVE_STENCIL_FACE", GL.FRONT).call("STENCIL_MASK", 85);
            case "separate_ops": return s.call("STENCIL_OP_SEPARATE", GL.BACK, GL.REPLACE, GL.INCR, GL.DECR).call("STENCIL_OP", GL.KEEP, GL.DECR_WRAP, GL.INCR_WRAP);
            case "negative_ref": return s.call("ACTIVE_STENCIL_FACE", GL.FRONT).call("STENCIL_FUNC", GL.ALWAYS, -7, 0xFFFFFFFF);
            case "large_ref": return s.call("STENCIL_FUNC_SEPARATE", GL.BACK, GL.ALWAYS, 1234567, 0xFFFFFFFF);
            case "invalid_face": return s.call("ACTIVE_STENCIL_FACE", GL.FRONT_AND_BACK);
            case "face_inside_begin": return s.call("BEGIN", GL.POINTS).call("ACTIVE_STENCIL_FACE", GL.BACK).call("END");
            case "list_compile": list(s, 1, 1, GL.COMPILE); s.call("ACTIVE_STENCIL_FACE", GL.BACK).call("STENCIL_FUNC", GL.NEVER, 17, 170); return list(s, 2);
            case "list_call": return list(s, 3, 1);
            default: return s;
        }
    }
    function queries(s, kind = P.C.V86GL_STATE_INTEGER) {
        s.reserve(pnames.length * 36);
        return pnames.map(pname => {
            const bytes = new Uint8Array(32); bytes.set(P.encodeRecord("QUERY_STATE", { pname, value_kind: kind, data_size: 8 }));
            s.record(P.GLFN.QUERY_STATE, bytes); return s.payloadView();
        });
    }
    const api = { pnames, phase, queries }; global.GLStencilExtCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
