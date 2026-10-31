// Client array formats/pointers are CPU state even when vertices themselves
// are copied into a later packed draw by the guest encoder (plan C3/C6).
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const state = global.V86GLShadowState || require("./gl_shadow_state.js");
    const caps = global.GLCaps || require("./gl_caps.js");
    if (typeof module !== "undefined") { require("./gl_shadow_raster.js"); require("./gl_shadow_buffers.js"); }
    const clone = GLShadow.clone;
    const FLOATS = [GL.FLOAT, GL.DOUBLE], VERTEX_TYPES = [GL.SHORT, GL.INT, ...FLOATS];
    const NORMAL_TYPES = [GL.BYTE, ...VERTEX_TYPES], COLOR_TYPES = [GL.UNSIGNED_BYTE, GL.UNSIGNED_SHORT, GL.UNSIGNED_INT, ...NORMAL_TYPES];
    // key, command, size, types, enable, size/type/stride/pointer/buffer pnames
    const definitions = [
        ["vertex", "VERTEX_POINTER_VBO", 4, VERTEX_TYPES, GL.VERTEX_ARRAY, [0x807A, 0x807B, 0x807C, 0x808E, 0x8896]],
        ["normal", "NORMAL_POINTER_VBO", 3, NORMAL_TYPES, GL.NORMAL_ARRAY, [0, 0x807E, 0x807F, 0x808F, 0x8897]],
        ["color", "COLOR_POINTER_VBO", 4, COLOR_TYPES, GL.COLOR_ARRAY, [0x8081, 0x8082, 0x8083, 0x8090, 0x8898]],
        ["index", "INDEX_POINTER_VBO", 1, [GL.UNSIGNED_BYTE, ...VERTEX_TYPES], GL.INDEX_ARRAY, [0, 0x8085, 0x8086, 0x8091, 0x8899]],
        ["texCoord", "TEX_COORD_POINTER_VBO", 4, VERTEX_TYPES, GL.TEXTURE_COORD_ARRAY, [0x8088, 0x8089, 0x808A, 0x8092, 0x889A]],
        ["edgeFlag", "EDGE_FLAG_POINTER_VBO", 1, [GL.UNSIGNED_BYTE], GL.EDGE_FLAG_ARRAY, [0, 0, 0x808C, 0x8093, 0x889B]],
        ["secondaryColor", "SECONDARY_COLOR_POINTER_VBO", 3, COLOR_TYPES, GL.SECONDARY_COLOR_ARRAY_EXT, [0x845A, 0x845B, 0x845C, 0x845D, 0x889C]],
        ["fogCoord", "FOG_COORD_POINTER_VBO", 1, FLOATS, GL.FOG_COORDINATE_ARRAY_EXT, [0, 0x8454, 0x8455, 0x8456, 0x889D]],
    ];
    const initial = (size, type = GL.FLOAT) => ({ size, type, stride: 0, pointer: 0, bufferId: 0, normalized: false });
    function arrays() {
        const result = Object.fromEntries(definitions.map(([key, , size]) => [key, key === "texCoord" ?
            Array.from({ length: caps.LIMITS.MAX_TEXTURE_COORDS }, () => initial(size)) : initial(size, key === "edgeFlag" ? GL.UNSIGNED_BYTE : GL.FLOAT)]));
        result.generic = Array.from({ length: caps.LIMITS.MAX_VERTEX_ATTRIBS }, () => ({ ...initial(4), enabled: false, current: [0, 0, 0, 1] }));
        return result;
    }
    const get = (c, key) => key === "texCoord" ? c.state.arrays.texCoord[c.state.clientTexture] : c.state.arrays[key];
    const nameOf = (c, array) => c.group.bufferObjects.get(array.bufferId)?.name || 0;
    const pointers = new Map(definitions.map(d => [P.GLFN[d[1]], d]));
    for (const [key, command, , types, , pnames] of definitions) {
        GLShadow.rules({ [P.GLFN[command]]: (s, b, v, o) => {
            if (s.current.state.begin) return GL.INVALID_OPERATION;
            const r = P.decodeRecord(command, v, o);
            const validSize = key === "vertex" ? r.size >= 2 && r.size <= 4 : key === "color" ? r.size === 3 || r.size === 4 :
                key === "texCoord" ? r.size >= 1 && r.size <= 4 : r.size === (key === "normal" || key === "secondaryColor" ? 3 : 1);
            if (!validSize || r.stride < 0) return GL.INVALID_VALUE;
            return types.includes(r.type) ? 0 : GL.INVALID_ENUM;
        } });
        for (const [i, field, kind] of [[0, "size", "i"], [1, "type", "e"], [2, "stride", "i"], [4, "bufferId", "u"]])
            if (pnames[i]) state.query([pnames[i]], s => { const array = get(s.current, key); return [[field === "bufferId" ? nameOf(s.current, array) : array[field]], kind]; });
    }
    GLShadow.rules({ [P.GLFN.VERTEX_ATTRIB_POINTER_VBO]: (s, b, v, o) => {
        if (s.current.state.begin) return GL.INVALID_OPERATION;
        const r = P.decodeRecord("VERTEX_ATTRIB_POINTER_VBO", v, o);
        if (r.index >= caps.LIMITS.MAX_VERTEX_ATTRIBS || r.size < 1 || r.size > 4 || r.stride < 0) return GL.INVALID_VALUE;
        return COLOR_TYPES.includes(r.type) ? 0 : GL.INVALID_ENUM;
    } });
    for (const [command, enabled] of [["ENABLE_VERTEX_ATTRIB_ARRAY", true], ["DISABLE_VERTEX_ATTRIB_ARRAY", false]]) {
        state.rule(command, (c, [index]) => index < caps.LIMITS.MAX_VERTEX_ATTRIBS ? 0 : GL.INVALID_VALUE);
        state.on(command, (c, [index]) => { c.state.arrays.generic[index].enabled = enabled; });
    }
    state.rule("VERTEX_ATTRIB4F", (c, [index]) => index < caps.LIMITS.MAX_VERTEX_ATTRIBS ? 0 : GL.INVALID_VALUE, true);
    state.on("VERTEX_ATTRIB4F", (c, [index, ...value]) => { c.state.arrays.generic[index].current = value.map(Math.fround); }, true);
    state.parameter(P.C.V86GL_PARAMETER_VERTEX_ATTRIB, (s, index, pname) => {
        if (index >= caps.LIMITS.MAX_VERTEX_ATTRIBS) return GL.INVALID_VALUE;
        const array = s.current.state.arrays.generic[index];
        if (pname === GL.CURRENT_VERTEX_ATTRIB) return index === 0 ? GL.INVALID_OPERATION : [array.current, "t"];
        if (pname === GL.VERTEX_ATTRIB_ARRAY_ENABLED) return [[+array.enabled], "b"];
        if (pname === GL.VERTEX_ATTRIB_ARRAY_SIZE) return [[array.size], "i"];
        if (pname === GL.VERTEX_ATTRIB_ARRAY_STRIDE) return [[array.stride], "i"];
        if (pname === GL.VERTEX_ATTRIB_ARRAY_TYPE) return [[array.type], "e"];
        if (pname === GL.VERTEX_ATTRIB_ARRAY_NORMALIZED) return [[+array.normalized], "b"];
        if (pname === GL.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) return [[nameOf(s.current, array)], "u"];
        return GL.INVALID_ENUM;
    });
    GLShadow.prototype.arrayPointerParameter = function(target, pname, index) {
        const s = this;
        if (target === GL.VERTEX_ATTRIB_ARRAY_POINTER) {
            if (index >= caps.LIMITS.MAX_VERTEX_ATTRIBS) return GL.INVALID_VALUE;
            return pname === GL.VERTEX_ATTRIB_ARRAY_POINTER ? [[s.current.state.arrays.generic[index].pointer], "u"] : GL.INVALID_ENUM;
        }
        const definition = definitions.find(d => d[5][3] === pname);
        if (definition) return [[get(s.current, definition[0]).pointer], "u"];
        if ([0x0DF0, 0x0DF3].includes(pname)) return null; // selection/feedback buffers migrate with those modes
        return GL.INVALID_ENUM;
    };
    state.parameter(P.C.V86GL_PARAMETER_ARRAY_POINTER, (s, ...args) => s.arrayPointerParameter(...args));
    state.attributes("arrays", {
        capture(c, mask, client) {
            if (client) return mask & 2 ? { formats: clone(c.state.arrays) } : null;
            return mask & 1 ? { current: c.state.arrays.generic.map(a => a.current.slice()) } : null;
        },
        restore(c, saved) {
            if (saved.formats) {
                const current = c.state.arrays.generic.map(a => a.current);
                c.state.arrays = saved.formats;
                c.state.arrays.generic.forEach((a, i) => { a.current = current[i]; });
            }
            if (saved.current) saved.current.forEach((value, i) => { c.state.arrays.generic[i].current = value; });
        },
    });
    const draws = new Set([P.GLFN.DRAW_ARRAYS, P.GLFN.DRAW_ELEMENTS,
        P.GLFN.DRAW_ARRAYS_GL2, P.GLFN.DRAW_ELEMENTS_GL2, P.GLFN.DRAW_ARRAYS_DIRECT, P.GLFN.DRAW_ELEMENTS_DIRECT,
        P.GLFN.DRAW_RANGE_ELEMENTS_DIRECT, P.GLFN.MULTI_DRAW_ARRAYS_DIRECT, P.GLFN.MULTI_DRAW_ELEMENTS_DIRECT]);
    function enabledArrays(c) {
        const a = c.state.arrays, result = a.generic.filter(array => array.enabled);
        for (const [key, , , , enable] of definitions) {
            if (key === "texCoord") a.texCoord.forEach((array, i) => { if (c.state.raster.texcoord[i]) result.push(array); });
            else if (c.state.raster.client[enable]) result.push(a[key]);
        }
        return result;
    }
    GLShadow.prototype.arrayInputError = function(fn) {
        const c = this.current, mapped = array => c.group.bufferObjects.get(array.bufferId)?.mapped;
        if (enabledArrays(c).some(mapped)) return GL.INVALID_OPERATION;
        if (P.NAME_BY_OPCODE[fn].includes("ELEMENTS") && this.boundBuffer(GL.ELEMENT_ARRAY_BUFFER)?.mapped) return GL.INVALID_OPERATION;
        return 0;
    };
    GLShadow.part({
        context(c) { c.state.arrays = arrays(); },
        setState(s) { for (const c of s.contexts.values()) if (!c.state.arrays) c.state.arrays = arrays(); },
        checkCommand(s, fn) {
            if (!draws.has(fn)) return 0;
            // List draws own captured client bytes. Unrelated VBO mapping at
            // call time does not participate in those frozen inputs.
            if (s.current.listExecution && [P.GLFN.DRAW_ARRAYS, P.GLFN.DRAW_ELEMENTS, P.GLFN.DRAW_ARRAYS_GL2, P.GLFN.DRAW_ELEMENTS_GL2].includes(fn)) return 0;
            return s.arrayInputError(fn);
        },
        command(s, fn, bytes, view, offset) {
            const c = s.current; if (!c) return;
            const definition = pointers.get(fn), generic = fn === P.GLFN.VERTEX_ATTRIB_POINTER_VBO;
            if (definition || generic) {
                const r = P.decodeRecord(P.NAME_BY_OPCODE[fn], view, offset), array = generic ? c.state.arrays.generic[r.index] : get(c, definition[0]);
                Object.assign(array, { size: r.size, type: r.type, stride: r.stride, pointer: r.offset,
                    bufferId: c.bufferBindings.get(GL.ARRAY_BUFFER) || 0, normalized: generic && !!r.normalized });
            } else if (fn === P.GLFN.DELETE_BUFFERS) {
                const ids = new Set(); for (let i = 0; i < view.getUint32(offset, true); ++i) {
                    const b = c.group.buffers.get(view.getUint32(offset + 4 + i * 4, true)); if (b) ids.add(b.id);
                }
                for (const value of Object.values(c.state.arrays)) for (const array of Array.isArray(value) ? value : [value])
                    if (ids.has(array.bufferId)) array.bufferId = 0;
            }
        },
    });
    const api = { enabledArrays };
    global.V86GLShadowArrays = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
