"use strict";
(function(global) {
    const { GL } = typeof require === "function" ? require("./gl_stream_builder.js") : global.GLTestStream;
    function triangle(s, back) {
        for (const [x, y] of back ? [[-1, -1], [-1, 3], [3, -1]] : [[-1, -1], [3, -1], [-1, 3]]) s.call("VERTEX3F", x, y, 0);
    }
    function scene(s, name) {
        s.call("DISABLE", GL.CULL_FACE).call("STENCIL_MASK", 0xFFFFFFFF).call("CLEAR_STENCIL", 0).call("CLEAR", GL.STENCIL_BUFFER_BIT)
            .call("STENCIL_FUNC_SEPARATE", GL.FRONT, GL.ALWAYS, 3, 0xFFFFFFFF).call("STENCIL_FUNC_SEPARATE", GL.BACK, GL.ALWAYS, 9, 0xFFFFFFFF)
            .call("STENCIL_OP", GL.KEEP, GL.KEEP, GL.REPLACE);
        if (name === "write_masks") s.call("STENCIL_FUNC_SEPARATE", GL.FRONT, GL.ALWAYS, 0xAB, 255).call("STENCIL_FUNC_SEPARATE", GL.BACK, GL.ALWAYS, 0xCD, 255)
            .call("STENCIL_MASK_SEPARATE", GL.FRONT, 15).call("STENCIL_MASK_SEPARATE", GL.BACK, 240);
        if (name === "ordered_overlap") s.call("STENCIL_FUNC_SEPARATE", GL.FRONT, GL.ALWAYS, 1, 255).call("STENCIL_FUNC_SEPARATE", GL.BACK, GL.ALWAYS, 2, 255)
            .call("STENCIL_OP_SEPARATE", GL.BACK, GL.KEEP, GL.KEEP, GL.INCR);
        if (name === "back_read_mask") s.call("CLEAR_STENCIL", 0xA3).call("CLEAR", GL.STENCIL_BUFFER_BIT)
            .call("STENCIL_FUNC_SEPARATE", GL.FRONT, GL.EQUAL, 3, 15).call("STENCIL_FUNC_SEPARATE", GL.BACK, GL.EQUAL, 0xA0, 240).call("STENCIL_OP", GL.KEEP, GL.KEEP, GL.INVERT);
        if (name === "cull_back") s.call("ENABLE", GL.CULL_FACE).call("CULL_FACE", GL.BACK);
        if (name === "program_flips_face") s.call("CREATE_SHADER", 1, GL.VERTEX_SHADER).shaderSource(1, "#version 120\nvoid main(){gl_Position=vec4(-gl_Vertex.x,gl_Vertex.y,gl_Vertex.z,gl_Vertex.w);}")
            .call("COMPILE_SHADER", 1).call("CREATE_PROGRAM", 5).call("ATTACH_SHADER", 5, 1).call("LINK_PROGRAM", 5).call("USE_PROGRAM", 5);
        s.call("BEGIN", GL.TRIANGLES);
        for (const back of name === "ordered_overlap" ? [true, false, true] : name === "write_masks" ? [false, true] : name === "cull_back" ? [true, false] : [name === "back_ref" || name === "back_read_mask"]) triangle(s, back);
        return s.call("END");
    }
    const api = { scene };global.GLStencilFacesCases = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
