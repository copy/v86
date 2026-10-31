"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream,
        P = typeof require === "function" ? require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js") : global.GLProtocol;
    const names = ["color_stripes_attrib", "masked_depth_stencil", "query_clear_only", "query_hidden_clear_hidden", "query_visible_clear_visible"];
    function draw(s) { return s.call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, 0).call("VERTEX3F", 3, -1, 0).call("VERTEX3F", -1, 3, 0).call("END"); }
    function setup(s) { return s.call("VIEWPORT", 0, 0, 16, 16).call("CLEAR_COLOR", 0, 0, 1, 1).call("CLEAR_DEPTH", .75).call("CLEAR_STENCIL", 66).call("CLEAR", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT); }
    function scene(s, name) {
        const c = names.indexOf(name);setup(s);
        if (c === 0) {
            draw(s.call("COLOR4F", 0, 0, 1, 1)).call("VIEWPORT", 3, 3, 2, 2).call("ENABLE", GL.SCISSOR_TEST).call("SCISSOR", 0, 0, 16, 16);
            for (let i = 0; i < 16; ++i) s.call("PUSH_ATTRIB", GL.COLOR_BUFFER_BIT | 0x80000).call("SCISSOR", i, 0, 1, 16)
                .call("CLEAR_COLOR", i / 15, 1 - i / 15, .25, 1).call("CLEAR", GL.COLOR_BUFFER_BIT).call("POP_ATTRIB");
            draw(s.call("COLOR4F", 1, 1, 1, 1));
        } else if (c === 1) {
            draw(s.call("ENABLE", GL.DEPTH_TEST).call("DEPTH_FUNC", GL.NEVER).call("VIEWPORT", 1, 1, 2, 2).call("DEPTH_RANGE", .8, .9))
                .call("ENABLE", GL.SCISSOR_TEST).call("SCISSOR", 4, 4, 8, 8).call("COLOR_MASK", 1, 0, 1, 0).call("STENCIL_MASK", 15)
                .call("CLEAR_COLOR", 1, .5, 0, 0).call("CLEAR_DEPTH", .25).call("CLEAR_STENCIL", 173).call("CLEAR", GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT);
        } else {
            s.names(P.GLFN.GEN_QUERIES, [1]).call("ENABLE", GL.SCISSOR_TEST).call("SCISSOR", 0, 0, 16, 16);
            if (c === 3) s.call("ENABLE", GL.DEPTH_TEST).call("DEPTH_FUNC", GL.NEVER);
            s.call("BEGIN_QUERY", GL.SAMPLES_PASSED, 1).call("COLOR4F", 1, 0, 0, 1);if (c >= 3) draw(s);
            s.call("CLEAR_COLOR", 0, 1, 0, 1).call("CLEAR", GL.COLOR_BUFFER_BIT);if (c >= 3) draw(s);
            s.call("END_QUERY", GL.SAMPLES_PASSED);
        }
        return s;
    }
    function query(s) {
        const payload = new Uint8Array([...P.encodeRecord("QUERY_OBJECT_BATCH", { count: 1, object_kind: P.C.V86GL_OBJECT_KIND_QUERY }), ...P.encodeRecord("QUERY_OBJECT_BATCH_ENTRY", { name: 1 })]);
        s.record(P.GLFN.QUERY_OBJECT_BATCH, payload);return s.payloadView();
    }
    const api = { names, setup, draw, scene, query };global.GLClearPassCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
