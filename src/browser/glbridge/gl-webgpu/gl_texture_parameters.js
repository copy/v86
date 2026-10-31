// Desktop texture parameter defaults and typed setter conversion.
(function(global) {
    "use strict";
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const targets = [GL.TEXTURE_1D, GL.TEXTURE_2D, GL.TEXTURE_3D, GL.TEXTURE_CUBE_MAP, GL.TEXTURE_RECTANGLE];
    const definitions = new Map();
    const add = (p, value, kind, field, allowed) => definitions.set(p, { initial: Array.isArray(value) ? value : [value], kind, field, allowed });
    const wraps = [GL.CLAMP, GL.CLAMP_TO_EDGE, GL.CLAMP_TO_BORDER, GL.REPEAT, GL.MIRRORED_REPEAT];
    add(GL.TEXTURE_MIN_FILTER, GL.NEAREST_MIPMAP_LINEAR, "e", "minFilter", [GL.NEAREST, GL.LINEAR,
        GL.NEAREST_MIPMAP_NEAREST, GL.NEAREST_MIPMAP_LINEAR, GL.LINEAR_MIPMAP_NEAREST, GL.LINEAR_MIPMAP_LINEAR]);
    add(GL.TEXTURE_MAG_FILTER, GL.LINEAR, "e", "magFilter", [GL.NEAREST, GL.LINEAR]);
    for (const [p, field] of [[GL.TEXTURE_WRAP_S, "wrapS"], [GL.TEXTURE_WRAP_T, "wrapT"], [GL.TEXTURE_WRAP_R, "wrapR"]])
        add(p, GL.REPEAT, "e", field, wraps);
    add(GL.TEXTURE_BORDER_COLOR, [0, 0, 0, 0], "n", "borderColor");
    add(GL.TEXTURE_PRIORITY, 1, "f");
    add(GL.TEXTURE_RESIDENT, 1, "b");
    add(GL.TEXTURE_MIN_LOD, -1000, "f", "minLod"); add(GL.TEXTURE_MAX_LOD, 1000, "f", "maxLod");
    add(GL.TEXTURE_BASE_LEVEL, 0, "i", "baseLevel"); add(GL.TEXTURE_MAX_LEVEL, 1000, "i", "maxLevel");
    add(GL.TEXTURE_LOD_BIAS, 0, "f", "lodBias");
    add(GL.DEPTH_TEXTURE_MODE, GL.LUMINANCE, "e", "depthTextureMode", [GL.LUMINANCE, GL.INTENSITY, GL.ALPHA]);
    add(GL.TEXTURE_COMPARE_MODE, GL.NONE, "e", "compareMode", [GL.NONE, GL.COMPARE_R_TO_TEXTURE]);
    add(GL.TEXTURE_COMPARE_FUNC, GL.LEQUAL, "e", "compareFunc", Array.from({ length: 8 }, (_, i) => GL.NEVER + i));
    add(GL.GENERATE_MIPMAP, 0, "b");
    add(GL.TEXTURE_MAX_ANISOTROPY_EXT, 1, "f", "maxAnisotropy");
    const clamp = v => Math.max(0, Math.min(1, v));
    const initial = target => {
        const values = Object.fromEntries([...definitions].map(([p, d]) => [p, d.initial.slice()]));
        if (target === GL.TEXTURE_RECTANGLE) {
            values[GL.TEXTURE_MIN_FILTER] = [GL.LINEAR];
            for (const p of [GL.TEXTURE_WRAP_S, GL.TEXTURE_WRAP_T, GL.TEXTURE_WRAP_R]) values[p] = [GL.CLAMP_TO_EDGE];
        }
        return values;
    };
    function samplerDefaults(target) {
        const out = {};
        const values = initial(target);
        for (const [p, d] of definitions) if (d.field)
            out[d.field] = d.initial.length > 1 ? new Float32Array(values[p]) : values[p][0];
        return out;
    }
    function normalize(pname, values, integer, scalar, target) {
        const d = definitions.get(pname);
        if (!d || pname === GL.TEXTURE_RESIDENT || scalar && d.initial.length > 1) return { error: GL.INVALID_ENUM };
        if (values.length < d.initial.length) return { error: GL.INVALID_VALUE };
        let v = values[0];
        if (d.kind === "e") {
            v = Math.trunc(v); if (!d.allowed.includes(v)) return { error: GL.INVALID_ENUM };
        } else if (d.kind === "i") {
            v = Math.round(v); if (v < 0 || v > 0x7FFFFFFF) return { error: GL.INVALID_VALUE };
        } else if (d.kind === "b") v = +(!!Math.trunc(v));
        else if (pname === GL.TEXTURE_BORDER_COLOR)
            return { values: values.slice(0, 4).map(v => Math.fround(clamp(integer ? v / 0x7FFFFFFF : v))) };
        else if (pname === GL.TEXTURE_PRIORITY) v = Math.fround(clamp(integer ? v / 0x7FFFFFFF : v));
        else if (pname === GL.TEXTURE_MAX_ANISOTROPY_EXT) {
            if (v < 1) return { error: GL.INVALID_VALUE }; v = Math.fround(Math.min(16, v));
        } else v = Math.fround(v);
        if (target === GL.TEXTURE_RECTANGLE) {
            if ([GL.TEXTURE_WRAP_S, GL.TEXTURE_WRAP_T, GL.TEXTURE_WRAP_R].includes(pname) && ![GL.CLAMP, GL.CLAMP_TO_EDGE, GL.CLAMP_TO_BORDER].includes(v) ||
                    pname === GL.TEXTURE_MIN_FILTER && ![GL.NEAREST, GL.LINEAR].includes(v)) return { error: GL.INVALID_ENUM };
            if (pname === GL.TEXTURE_BASE_LEVEL && v !== 0) return { error: GL.INVALID_VALUE };
        }
        return { values: [v] };
    }
    const api = { targets, definitions, initial, samplerDefaults, normalize };
    global.GLTextureParameters = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
