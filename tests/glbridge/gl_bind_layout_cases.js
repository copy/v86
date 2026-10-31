"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream;
    function setup(s, wide = false) {
        s.call("CREATE_PROGRAM", 1);for (const [id, type, source] of [[2, GL.VERTEX_SHADER, "#version 120\nvoid main(){gl_Position=gl_Vertex;}"],
            [3, GL.FRAGMENT_SHADER, wide ? "#version 120\nuniform vec4 palette[128];void main(){gl_FragColor=palette[int(gl_FragCoord.x)*8];}" : "#version 120\nuniform vec4 tint;void main(){gl_FragColor=tint;}"]])
            s.call("CREATE_SHADER", id, type).shaderSource(id, source).call("COMPILE_SHADER", id).call("ATTACH_SHADER", 1, id);
        return s.call("LINK_PROGRAM", 1).call("USE_PROGRAM", 1).call("VIEWPORT", 0, 0, 16, 16).call("ENABLE", GL.SCISSOR_TEST);
    }
    function draw(s) { return s.call("BEGIN", GL.TRIANGLES).call("VERTEX3F", -1, -1, 0).call("VERTEX3F", 3, -1, 0).call("VERTEX3F", -1, 3, 0).call("END"); }
    function stripes(s, location, repeats = 0) {
        for (let i = 0; i < 16; ++i) draw(s.call("SCISSOR", i, 0, 1, 16).uniformfv(location, 4, 1, [i / 15, 1 - i / 15, .25, 1]));
        for (let i = 0; i < repeats; ++i) draw(s);
        return s;
    }
    const api = { setup, draw, stripes };global.GLBindLayoutCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
