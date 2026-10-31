// GL 2.1 enable bits, stencil state and hints on the CPU (plan C3/C6).
// Includes per-unit texture/texgen enables and per-client-unit array enables.
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const caps = global.GLCaps || require("./gl_caps.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const { GLFN } = P;
    const clone = GLShadow.clone;
    // cap -> [default, server attribute group]; ENABLE_BIT saves all caps.
    const ENABLES = new Map();
    function enables(names, group, initial = 0) {
        for (const name of names.split(" ")) {
            if (GL[name] === undefined) throw new Error("unknown GL enable " + name);
            ENABLES.set(GL[name], [initial, group]);
        }
    }
    enables("ALPHA_TEST BLEND COLOR_LOGIC_OP INDEX_LOGIC_OP", 0x4000);
    enables("DITHER", 0x4000, 1);
    enables("DEPTH_TEST", 0x100); enables("STENCIL_TEST STENCIL_TEST_TWO_SIDE_EXT", 0x400);
    enables("CULL_FACE POLYGON_SMOOTH POLYGON_OFFSET_FILL POLYGON_OFFSET_LINE POLYGON_OFFSET_POINT", 0x8);
    enables("POLYGON_STIPPLE", 0x10); enables("SCISSOR_TEST", 0x80000);
    enables("LINE_SMOOTH LINE_STIPPLE", 0x4); enables("POINT_SMOOTH POINT_SPRITE", 0x2);
    enables("FOG", 0x80); enables("LIGHTING COLOR_MATERIAL COLOR_SUM", 0x40);
    enables("NORMALIZE RESCALE_NORMAL", 0x1000);
    enables("MULTISAMPLE", 0x20000000, 1);
    enables("SAMPLE_ALPHA_TO_COVERAGE SAMPLE_ALPHA_TO_ONE SAMPLE_COVERAGE", 0x20000000);
    enables("VERTEX_PROGRAM_ARB FRAGMENT_PROGRAM_ARB VERTEX_PROGRAM_POINT_SIZE VERTEX_PROGRAM_TWO_SIDE", 0);
    enables("AUTO_NORMAL", 0x10000); enables("DEPTH_CLAMP", 0x1000);
    for (let i = 0; i < caps.LIMITS.MAX_LIGHTS; ++i) ENABLES.set(GL.LIGHT0 + i, [0, 0x40]);
    for (let i = 0; i < caps.LIMITS.MAX_CLIP_PLANES; ++i) ENABLES.set(GL.CLIP_PLANE0 + i, [0, 0x1000]);
    for (let i = 0; i < 9; ++i) { ENABLES.set(GL.MAP1_COLOR_4 + i, [0, 0x10000]); ENABLES.set(GL.MAP2_COLOR_4 + i, [0, 0x10000]); }
    const UNIT_ENABLES = [GL.TEXTURE_1D, GL.TEXTURE_2D, GL.TEXTURE_3D, GL.TEXTURE_CUBE_MAP,
        GL.TEXTURE_GEN_S, GL.TEXTURE_GEN_T, GL.TEXTURE_GEN_R, GL.TEXTURE_GEN_Q];
    const CLIENT_ENABLES = [GL.VERTEX_ARRAY, GL.NORMAL_ARRAY, GL.COLOR_ARRAY, GL.INDEX_ARRAY,
        GL.EDGE_FLAG_ARRAY, GL.SECONDARY_COLOR_ARRAY_EXT, GL.FOG_COORDINATE_ARRAY_EXT];
    const unitCap = cap => UNIT_ENABLES.includes(cap);
    const serverCap = (shadow, cap) => (ENABLES.has(cap) || unitCap(cap)) &&
        (cap !== GL.DEPTH_CLAMP || !!(shadow.capabilities && shadow.capabilities.features.depthClipControl));
    const clientCap = cap => CLIENT_ENABLES.includes(cap) || cap === GL.TEXTURE_COORD_ARRAY;
    const defaults = list => Object.fromEntries(list.map(cap => [cap, 0]));
    const newRaster = () => ({ enabled: Object.fromEntries([...ENABLES].map(([cap, [value]]) => [cap, value])),
        units: Array.from({ length: caps.LIMITS.MAX_TEXTURE_UNITS }, () => defaults(UNIT_ENABLES)),
        client: defaults(CLIENT_ENABLES), texcoord: Array(caps.LIMITS.MAX_TEXTURE_UNITS).fill(0) });
    GLShadow.prototype.enableStateValue = function(cap) {
        const c = this.current, r = c.state.raster;
        if (serverCap(this, cap)) return [[unitCap(cap) ? r.units[c.activeTexture || 0][cap] : r.enabled[cap]], "b"];
        if (clientCap(cap)) return [[cap === GL.TEXTURE_COORD_ARRAY ? r.texcoord[c.state.clientTexture] : r.client[cap]], "b"];
        return null;
    };
    for (const cap of [...ENABLES.keys(), ...UNIT_ENABLES, ...CLIENT_ENABLES, GL.TEXTURE_COORD_ARRAY])
        state.query([cap], shadow => shadow.enableStateValue(cap));
    for (const [name, value] of [["ENABLE", 1], ["DISABLE", 0]]) {
        state.rule(name, (c, [cap], shadow) => serverCap(shadow, cap) ? 0 : GL.INVALID_ENUM);
        state.on(name, (c, [cap]) => { const r = c.state.raster; if (unitCap(cap)) r.units[c.activeTexture || 0][cap] = value; else r.enabled[cap] = value; });
    }
    for (const [name, value] of [["ENABLE_CLIENT_STATE", 1], ["DISABLE_CLIENT_STATE", 0]]) {
        state.rule(name, (c, [cap]) => clientCap(cap) ? 0 : GL.INVALID_ENUM);
        state.on(name, (c, [cap]) => { const r = c.state.raster; if (cap === GL.TEXTURE_COORD_ARRAY) r.texcoord[c.state.clientTexture] = value; else r.client[cap] = value; });
    }
    state.attributes("raster", {
        capture(c, mask, client) {
            const r = c.state.raster;
            if (client) return mask & 2 ? { client: clone(r.client), texcoord: r.texcoord.slice() } : {};
            const enabled = {};
            for (const [cap, [, group]] of ENABLES) if (mask & (0x2000 | group)) enabled[cap] = r.enabled[cap];
            return { enabled, ...(mask & (0x2000 | 0x40000) ? { units: clone(r.units) } : {}) };
        },
        restore(c, saved) {
            const r = c.state.raster;
            if (saved.enabled) Object.assign(r.enabled, saved.enabled);
            if (saved.units) r.units = saved.units;
            if (saved.client) r.client = saved.client;
            if (saved.texcoord) r.texcoord = saved.texcoord;
        },
    });
    const STENCIL_FIELDS = [
        ["STENCIL_FUNC STENCIL_BACK_FUNC", GL.ALWAYS, "i"], ["STENCIL_REF STENCIL_BACK_REF", 0, "i"],
        ["STENCIL_VALUE_MASK STENCIL_BACK_VALUE_MASK STENCIL_WRITEMASK STENCIL_BACK_WRITEMASK", 0xFFFFFFFF, "u"],
        ["STENCIL_FAIL STENCIL_BACK_FAIL STENCIL_PASS_DEPTH_FAIL STENCIL_BACK_PASS_DEPTH_FAIL STENCIL_PASS_DEPTH_PASS STENCIL_BACK_PASS_DEPTH_PASS", GL.KEEP, "i"],
    ];
    for (const [names, value, kind] of STENCIL_FIELDS) state.define(names, [value], kind, 0x400);
    const FACES = [GL.FRONT, GL.BACK, GL.FRONT_AND_BACK];
    const COMPARE = func => func >= GL.NEVER && func <= GL.ALWAYS;
    const OPS = new Set([GL.KEEP, GL.ZERO, GL.REPLACE, GL.INCR, GL.DECR, GL.INVERT, GL.INCR_WRAP, GL.DECR_WRAP]);
    const faceState = (c, face, front, back, value) => {
        if (face !== GL.BACK) state.set(c, front, [value]);
        if (face !== GL.FRONT) state.set(c, back, [value]);
    };
    function stencilFunc(c, [face, func, ref, mask]) {
        faceState(c, face, GL.STENCIL_FUNC, GL.STENCIL_BACK_FUNC, func);
        faceState(c, face, GL.STENCIL_REF, GL.STENCIL_BACK_REF, ref);
        faceState(c, face, GL.STENCIL_VALUE_MASK, GL.STENCIL_BACK_VALUE_MASK, mask);
    }
    state.rule("STENCIL_FUNC", (c, [func]) => COMPARE(func) ? 0 : GL.INVALID_ENUM);
    state.on("STENCIL_FUNC", (c, a) => stencilFunc(c, [GL.FRONT_AND_BACK, ...a]));
    state.rule("STENCIL_FUNC_SEPARATE", (c, [face, func]) => FACES.includes(face) && COMPARE(func) ? 0 : GL.INVALID_ENUM);
    state.on("STENCIL_FUNC_SEPARATE", stencilFunc);
    for (const [name, separate] of [["STENCIL_MASK", false], ["STENCIL_MASK_SEPARATE", true]]) {
        state.rule(name, (c, a) => !separate || FACES.includes(a[0]) ? 0 : GL.INVALID_ENUM);
        state.on(name, (c, a) => faceState(c, separate ? a[0] : GL.FRONT_AND_BACK, GL.STENCIL_WRITEMASK, GL.STENCIL_BACK_WRITEMASK, a[separate ? 1 : 0]));
    }
    for (const [name, separate] of [["STENCIL_OP", false], ["STENCIL_OP_SEPARATE", true]]) {
        state.rule(name, (c, a) => (!separate || FACES.includes(a[0])) && a.slice(separate ? 1 : 0).every(op => OPS.has(op)) ? 0 : GL.INVALID_ENUM);
        state.on(name, (c, a) => {
            const face = separate ? a[0] : GL.FRONT_AND_BACK, values = a.slice(separate ? 1 : 0);
            for (const [i, front, back] of [[0, GL.STENCIL_FAIL, GL.STENCIL_BACK_FAIL], [1, GL.STENCIL_PASS_DEPTH_FAIL, GL.STENCIL_BACK_PASS_DEPTH_FAIL], [2, GL.STENCIL_PASS_DEPTH_PASS, GL.STENCIL_BACK_PASS_DEPTH_PASS]])
                faceState(c, face, front, back, values[i]);
        });
    }
    // Keep the unclamped ref: switching between a framebuffer with/without
    // stencil changes the queried clamped value, not the specified state.
    const STENCIL_BITS = new Map([[GL.STENCIL_INDEX1_EXT, 1], [GL.STENCIL_INDEX4_EXT, 4], [GL.STENCIL_INDEX16_EXT, 16],
        [GL.STENCIL_INDEX8_EXT, 8], [GL.STENCIL_INDEX, 8], [GL.DEPTH_STENCIL, 8], [GL.DEPTH24_STENCIL8, 8], [0x8CAD, 8]]);
    function stencilBits(shadow) {
        const c = shadow.current;
        if (!c.drawFramebuffer) return 8;
        const fbo = c.framebuffers.get(c.drawFramebuffer), image = fbo && fbo.stencil && shadow.attachedImage(fbo.stencil);
        if (!image) return 0;
        if (image.componentBits) return image.componentBits[5];
        return STENCIL_BITS.get(image.internalFormat) || 0;
    }
    for (const pname of [GL.STENCIL_REF, GL.STENCIL_BACK_REF]) state.query([pname], shadow =>
        [[Math.max(0, Math.min(2 ** stencilBits(shadow) - 1, shadow.current.state.values[pname][0]))], "i"]);
    const HINTS = [GL.PERSPECTIVE_CORRECTION_HINT, GL.POINT_SMOOTH_HINT, GL.LINE_SMOOTH_HINT, GL.POLYGON_SMOOTH_HINT,
        GL.FOG_HINT, GL.GENERATE_MIPMAP_HINT, GL.TEXTURE_COMPRESSION_HINT, GL.FRAGMENT_SHADER_DERIVATIVE_HINT];
    state.define("PERSPECTIVE_CORRECTION_HINT POINT_SMOOTH_HINT LINE_SMOOTH_HINT POLYGON_SMOOTH_HINT FOG_HINT GENERATE_MIPMAP_HINT TEXTURE_COMPRESSION_HINT FRAGMENT_SHADER_DERIVATIVE_HINT", [GL.DONT_CARE], "i", 0x8000);
    state.rule("HINT", (c, [target, mode]) => HINTS.includes(target) && [GL.DONT_CARE, GL.FASTEST, GL.NICEST].includes(mode) ? 0 : GL.INVALID_ENUM);
    state.on("HINT", (c, [target, mode]) => state.set(c, target, [mode]));
    GLShadow.part({
        context(c) { c.state.raster = newRaster(); },
        setState(shadow) { for (const c of shadow.contexts.values()) if (!c.state.raster) c.state.raster = newRaster(); },
    });
    const api = { stencilBits };
    global.V86GLShadowRaster = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
