// EXT_stencil_two_side with GL 2.0 has three state sets: shared front,
// core back and EXT back. EXT's active face selects ordinary setters and
// queries even while the extension is disabled (EXT spec issues 16/17).
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js"), { GL } = global.GLWGConstants || require("./gl_constants.js"),
        { GLShadow } = global.V86GLShadow || require("./gl_shadow.js"), state = global.V86GLShadowState || require("./gl_shadow_state.js"),
        { stencilBits } = global.V86GLShadowRaster || require("./gl_shadow_raster.js"), arrays = global.GLListArrays || require("./gl_list_arrays.js");
    // This part must follow the display-list router: compile-only commands
    // must be stored before they can change any of the three state sets.
    if (typeof require === "function") require("./gl_shadow_lists.js");
    const fields = [GL.STENCIL_FUNC, GL.STENCIL_REF, GL.STENCIL_VALUE_MASK, GL.STENCIL_WRITEMASK,
        GL.STENCIL_FAIL, GL.STENCIL_PASS_DEPTH_FAIL, GL.STENCIL_PASS_DEPTH_PASS];
    const backs = [GL.STENCIL_BACK_FUNC, GL.STENCIL_BACK_REF, GL.STENCIL_BACK_VALUE_MASK, GL.STENCIL_BACK_WRITEMASK,
        GL.STENCIL_BACK_FAIL, GL.STENCIL_BACK_PASS_DEPTH_FAIL, GL.STENCIL_BACK_PASS_DEPTH_PASS];
    const initial = () => Object.fromEntries(fields.map((p, i) => [p, [GL.ALWAYS, 0, 0xFFFFFFFF, 0xFFFFFFFF, GL.KEEP, GL.KEEP, GL.KEEP][i]]));
    const activeBack = c => c.state.values[GL.ACTIVE_STENCIL_FACE_EXT][0] === GL.BACK;
    const enabled = c => !!c.state.raster.enabled[GL.STENCIL_TEST_TWO_SIDE_EXT];
    state.define("ACTIVE_STENCIL_FACE_EXT", [GL.FRONT], "i", 0x400);
    state.rule("ACTIVE_STENCIL_FACE", (c, [face]) => [GL.FRONT, GL.BACK].includes(face) ? 0 : GL.INVALID_ENUM);
    state.on("ACTIVE_STENCIL_FACE", (c, [face]) => state.set(c, GL.ACTIVE_STENCIL_FACE_EXT, [face]));
    function ordinary(c, indices, values) {
        for (let j = 0; j < indices.length; ++j) {
            const i = indices[j], value = values[j];
            if (activeBack(c)) c.state.stencilExtBack[fields[i]] = value;
            else { state.set(c, fields[i], [value]); state.set(c, backs[i], [value]); }
        }
    }
    state.on("STENCIL_FUNC", (c, a) => ordinary(c, [0, 1, 2], a));
    state.on("STENCIL_MASK", (c, a) => ordinary(c, [3], a));
    state.on("STENCIL_OP", (c, a) => ordinary(c, [4, 5, 6], a));
    for (const [i, pname] of fields.entries()) state.query([pname], shadow => {
        const c = shadow.current;
        let value = activeBack(c) ? c.state.stencilExtBack[pname] : c.state.values[pname][0];
        if (pname === GL.STENCIL_REF) value = Math.max(0, Math.min(2 ** stencilBits(shadow) - 1, value));
        return [[value], i === 2 || i === 3 ? "u" : "i"];
    });
    state.attributes("stencilExtBack", {
        capture(c, mask, client) { return !client && mask & 0x400 ? { values: { ...c.state.stencilExtBack } } : {}; },
        restore(c, saved) { if (saved.values) c.state.stencilExtBack = saved.values; },
    });
    const families = new Map([
        [P.GLFN.STENCIL_FUNC, [0, 1, 2]], [P.GLFN.STENCIL_FUNC_SEPARATE, [0, 1, 2]],
        [P.GLFN.STENCIL_MASK, [3]], [P.GLFN.STENCIL_MASK_SEPARATE, [3]],
        [P.GLFN.STENCIL_OP, [4, 5, 6]], [P.GLFN.STENCIL_OP_SEPARATE, [4, 5, 6]],
    ]);
    function resolved(c, indices) {
        const commands = [], ext = enabled(c);
        for (const face of [GL.FRONT, GL.BACK]) {
            const values = fields.map((p, i) => face === GL.BACK && ext ? c.state.stencilExtBack[p] : c.state.values[face === GL.BACK ? backs[i] : p][0]);
            const name = indices[0] === 0 ? "STENCIL_FUNC_SEPARATE" : indices[0] === 3 ? "STENCIL_MASK_SEPARATE" : "STENCIL_OP_SEPARATE";
            commands.push(arrays.record(P.GLFN[name], [P.encodeArgs(name, [face, ...indices.map(i => values[i])])]));
        }
        return commands;
    }
    GLShadow.part({
        context(c) { c.state.stencilExtBack = initial(); },
        setState(s) {
            for (const c of s.contexts.values()) if (!c.state.stencilExtBack) {
                c.state.stencilExtBack = enabled(c) ? Object.fromEntries(fields.map((p, i) => [p, c.state.values[backs[i]][0]])) : initial();
            }
        },
        routeRecord(s, fn, bytes, view, offset, size) {
            const c = s.current; if (!c) return;
            const indices = families.get(fn), face = fn === P.GLFN.ACTIVE_STENCIL_FACE,
                toggle = (fn === P.GLFN.ENABLE || fn === P.GLFN.DISABLE) && view.getUint32(offset, true) === GL.STENCIL_TEST_TWO_SIDE_EXT,
                pop = fn === P.GLFN.POP_ATTRIB;
            if (!indices && !face && !toggle && !pop) return;
            const failure = s.dispatch(fn, bytes, view, offset, size); if (failure) return { error: failure };
            if (face) return { commands: [] };
            if (indices) return { commands: resolved(c, indices) };
            return { commands: [arrays.record(fn, [bytes.subarray(offset, offset + size)]),
                ...[[0, 1, 2], [3], [4, 5, 6]].flatMap(group => resolved(c, group))] };
        },
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
