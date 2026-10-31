// Desktop GL's typed state queries (plan C3). Unlike QUERY_INTEGER, which
// predates the CPU shadow and has only one int, QUERY_STATE carries vectors
// and doubles. Migrate a whole state family here before the guest stops
// answering it locally. Other families explicitly return UNSUPPORTED.
(function(global) {
    "use strict";
    const P = global.GLProtocol || require("./gl_protocol.js");
    const { GL } = global.GLWGConstants || require("./gl_constants.js");
    const caps = global.GLCaps || require("./gl_caps.js");
    const { GLShadow } = global.V86GLShadow || require("./gl_shadow.js");
    const { GLFN, F, RECORDS, C } = P;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const clone = GLShadow.clone;
    const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    function multiply(a, b) {
        return Array.from({ length: 16 }, (_, i) => {
            const row = i % 4, col = i - row;
            return a[row] * b[col] + a[row + 4] * b[col + 1] +
                a[row + 8] * b[col + 2] + a[row + 12] * b[col + 3];
        });
    }

    // pname -> [initial values, GL state type, glPushAttrib group]. Colors
    // and depth's normalized conversion are distinct from ordinary floats.
    const DEFAULTS = new Map();
    const QUERIES = new Map(), PARAMETERS = new Map(), ATTRIB_PARTS = new Map();
    const define = (names, values, kind, group) => {
        for (const name of names.split(" ")) {
            if (GL[name] === undefined) throw new Error("unknown GL state " + name);
            DEFAULTS.set(GL[name], [values, kind || "i", group || 0]);
        }
    };
    define("VIEWPORT", [0, 0, 0, 0], "i", 0x800);
    define("SCISSOR_BOX", [0, 0, 0, 0], "i", 0x80000);
    define("DEPTH_RANGE", [0, 1], "n", 0x800);
    define("COLOR_CLEAR_VALUE ACCUM_CLEAR_VALUE", [0, 0, 0, 0], "n", 0x4000);
    define("CURRENT_INDEX", [1], "f", 1);
    define("INDEX_CLEAR_VALUE", [0], "f", 0x4000);
    define("INDEX_WRITEMASK", [0xFFFFFFFF], "u", 0x4000);
    DEFAULTS.get(GL.ACCUM_CLEAR_VALUE)[2] = 0x200;
    define("DEPTH_CLEAR_VALUE", [1], "n", 0x100);
    define("STENCIL_CLEAR_VALUE", [0], "i", 0x400);
    define("DEPTH_FUNC", [GL.LESS], "i", 0x100);
    define("DEPTH_WRITEMASK", [1], "b", 0x100);
    define("COLOR_WRITEMASK", [1, 1, 1, 1], "b", 0x4000);
    define("CULL_FACE_MODE", [GL.BACK], "i", 0x8);
    define("FRONT_FACE", [GL.CCW], "i", 0x8);
    define("SHADE_MODEL", [GL.SMOOTH], "i", 0x40);
    define("LINE_WIDTH POINT_SIZE", [1], "f", 0x4);
    DEFAULTS.get(GL.POINT_SIZE)[2] = 0x2;
    define("POLYGON_MODE", [GL.FILL, GL.FILL], "i", 0x8);
    define("POLYGON_OFFSET_FACTOR POLYGON_OFFSET_UNITS", [0], "f", 0x8);
    define("LINE_STIPPLE_REPEAT", [1], "i", 0x4);
    define("LINE_STIPPLE_PATTERN", [65535], "i", 0x4);
    define("BLEND_SRC_RGB BLEND_SRC_ALPHA", [GL.ONE], "i", 0x4000);
    define("BLEND_DST_RGB BLEND_DST_ALPHA", [GL.ZERO], "i", 0x4000);
    define("BLEND_EQUATION_RGB BLEND_EQUATION_ALPHA", [GL.FUNC_ADD], "i", 0x4000);
    // GL_BLEND_COLOR (not present in older generated constant tables).
    DEFAULTS.set(0x8005, [[0, 0, 0, 0], "n", 0x4000]);
    define("ALPHA_TEST_FUNC", [GL.ALWAYS], "i", 0x4000);
    define("ALPHA_TEST_REF", [0], "n", 0x4000);
    define("SAMPLE_COVERAGE_VALUE", [1], "f", 0x20000000);
    define("SAMPLE_COVERAGE_INVERT", [0], "b", 0x20000000);
    define("PACK_ALIGNMENT UNPACK_ALIGNMENT", [4]);
    const STORE_BOOLEAN = new Set([GL.PACK_SWAP_BYTES, GL.PACK_LSB_FIRST, GL.UNPACK_SWAP_BYTES, GL.UNPACK_LSB_FIRST]);
    const STORE = new Set([GL.PACK_ALIGNMENT, GL.UNPACK_ALIGNMENT, ...STORE_BOOLEAN,
        GL.PACK_ROW_LENGTH, GL.PACK_SKIP_ROWS, GL.PACK_SKIP_PIXELS, GL.PACK_SKIP_IMAGES, GL.PACK_IMAGE_HEIGHT,
        GL.UNPACK_ROW_LENGTH, GL.UNPACK_SKIP_ROWS, GL.UNPACK_SKIP_PIXELS, GL.UNPACK_SKIP_IMAGES, GL.UNPACK_IMAGE_HEIGHT]);
    for (const pname of STORE) if (!DEFAULTS.has(pname)) DEFAULTS.set(pname, [[0], STORE_BOOLEAN.has(pname) ? "b" : "i", 0]);
    const COMPARE = value => value >= GL.NEVER && value <= GL.ALWAYS;
    const FACTORS = new Set([0, 1, GL.SRC_COLOR, GL.ONE_MINUS_SRC_COLOR, GL.DST_COLOR, GL.ONE_MINUS_DST_COLOR,
        GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA, GL.DST_ALPHA, GL.ONE_MINUS_DST_ALPHA,
        GL.CONSTANT_COLOR, GL.ONE_MINUS_CONSTANT_COLOR, GL.CONSTANT_ALPHA, GL.ONE_MINUS_CONSTANT_ALPHA]);
    const EQUATIONS = new Set([GL.FUNC_ADD, GL.FUNC_SUBTRACT, GL.FUNC_REVERSE_SUBTRACT, GL.MIN, GL.MAX]);
    const SETTERS = new Map();
    const WITHIN_BEGIN = new Set();
    const on = (name, fn, withinBegin) => { SETTERS.set(GLFN[name], fn); if (withinBegin) WITHIN_BEGIN.add(GLFN[name]); };
    const set = (c, pname, values) => { c.state.values[pname] = values; };
    function rule(name, check, withinBegin) {
        GLShadow.rules({ [GLFN[name]]: (shadow, bytes, view, offset, size) => {
            const c = shadow.current;
            if (c.state.begin && !withinBegin) return GL.INVALID_OPERATION;
            const a = P.SIGNATURES[name] ? shadow.args(name, view, offset, size) : [];
            return check ? check(c, a, shadow) : 0;
        } });
    }
    const scalar = (name, pname, valid, convert, error = GL.INVALID_ENUM) => {
        rule(name, (c, a) => valid && !valid(a[0]) ? error : 0);
        on(name, (c, a) => set(c, pname, [convert ? convert(a[0]) : a[0]]));
    };
    on("VIEWPORT", (c, a, shadow, view, offset) => {
        const limit = shadow.capabilities && caps.integer(shadow.capabilities, GL.MAX_VIEWPORT_DIMS);
        if (limit) {
            a[2] = Math.min(a[2], limit); a[3] = Math.min(a[3], limit);
            // The page receives the same accepted, clamped rectangle.
            view.setInt32(offset + 8, a[2], true); view.setInt32(offset + 12, a[3], true);
        }
        set(c, GL.VIEWPORT, a);
    });
    on("SCISSOR", (c, a) => { if (a[2] >= 0 && a[3] >= 0) set(c, GL.SCISSOR_BOX, a); });
    on("DEPTH_RANGE", (c, a) => set(c, GL.DEPTH_RANGE, a.map(v => clamp(v, 0, 1))));
    on("CLEAR_COLOR", (c, a) => set(c, GL.COLOR_CLEAR_VALUE, a.map(v => clamp(v, 0, 1))));
    on("CLEAR_ACCUM", (c, a) => set(c, GL.ACCUM_CLEAR_VALUE, a.map(v => clamp(v, -1, 1))));
    scalar("CLEAR_DEPTH", GL.DEPTH_CLEAR_VALUE, null, v => clamp(v, 0, 1));
    scalar("CLEAR_STENCIL", GL.STENCIL_CLEAR_VALUE);
    scalar("DEPTH_FUNC", GL.DEPTH_FUNC, COMPARE);
    scalar("DEPTH_MASK", GL.DEPTH_WRITEMASK, null, v => +!!v);
    on("COLOR_MASK", (c, a) => set(c, GL.COLOR_WRITEMASK, a.map(v => +!!v)));
    scalar("CULL_FACE", GL.CULL_FACE_MODE, v => [GL.FRONT, GL.BACK, GL.FRONT_AND_BACK].includes(v));
    scalar("FRONT_FACE", GL.FRONT_FACE, v => v === GL.CW || v === GL.CCW);
    scalar("SHADE_MODEL", GL.SHADE_MODEL, v => v === GL.FLAT || v === GL.SMOOTH);
    scalar("LINE_WIDTH", GL.LINE_WIDTH, v => v > 0, null, GL.INVALID_VALUE);
    scalar("POINT_SIZE", GL.POINT_SIZE, v => v > 0, null, GL.INVALID_VALUE);
    on("POLYGON_MODE", (c, a) => {
        if (![GL.FRONT, GL.BACK, GL.FRONT_AND_BACK].includes(a[0]) || ![GL.POINT, GL.LINE, GL.FILL].includes(a[1])) return;
        const modes = c.state.values[GL.POLYGON_MODE].slice();
        if (a[0] !== GL.BACK) modes[0] = a[1];
        if (a[0] !== GL.FRONT) modes[1] = a[1];
        set(c, GL.POLYGON_MODE, modes);
    });
    on("POLYGON_OFFSET", (c, a) => { set(c, GL.POLYGON_OFFSET_FACTOR, [a[0]]); set(c, GL.POLYGON_OFFSET_UNITS, [a[1]]); });
    on("LINE_STIPPLE", (c, a) => { set(c, GL.LINE_STIPPLE_REPEAT, [clamp(a[0], 1, 256)]); set(c, GL.LINE_STIPPLE_PATTERN, [a[1] & 65535]); });
    function blend(c, a) {
        if (!a.every((v, i) => FACTORS.has(v) || i % 2 === 0 && v === GL.SRC_ALPHA_SATURATE)) return;
        [GL.BLEND_SRC_RGB, GL.BLEND_DST_RGB, GL.BLEND_SRC_ALPHA, GL.BLEND_DST_ALPHA].forEach((p, i) => set(c, p, [a[i]]));
    }
    on("BLEND_FUNC", (c, a) => {
        if ((!FACTORS.has(a[0]) && a[0] !== GL.SRC_ALPHA_SATURATE) || !FACTORS.has(a[1])) return;
        [GL.BLEND_SRC_RGB, GL.BLEND_DST_RGB, GL.BLEND_SRC_ALPHA, GL.BLEND_DST_ALPHA].forEach((p, i) => set(c, p, [a[i % 2]]));
    });
    on("BLEND_FUNC_SEPARATE", blend);
    on("BLEND_EQUATION", (c, a) => { if (EQUATIONS.has(a[0])) for (const p of [GL.BLEND_EQUATION_RGB, GL.BLEND_EQUATION_ALPHA]) set(c, p, a); });
    on("BLEND_EQUATION_SEPARATE", (c, a) => {
        if (a.every(v => EQUATIONS.has(v))) { set(c, GL.BLEND_EQUATION_RGB, [a[0]]); set(c, GL.BLEND_EQUATION_ALPHA, [a[1]]); }
    });
    on("BLEND_COLOR", (c, a) => set(c, 0x8005, a.map(v => clamp(v, 0, 1))));
    on("ALPHA_FUNC", (c, a) => { if (COMPARE(a[0])) { set(c, GL.ALPHA_TEST_FUNC, [a[0]]); set(c, GL.ALPHA_TEST_REF, [clamp(a[1], 0, 1)]); } });
    on("SAMPLE_COVERAGE", (c, a) => { set(c, GL.SAMPLE_COVERAGE_VALUE, [clamp(a[0], 0, 1)]); set(c, GL.SAMPLE_COVERAGE_INVERT, [+!!a[1]]); });
    on("PIXEL_STOREI", (c, [p, value]) => {
        if (!STORE.has(p)) return;
        if (p === GL.PACK_ALIGNMENT || p === GL.UNPACK_ALIGNMENT) { if (![1, 2, 4, 8].includes(value)) return; }
        else if (STORE_BOOLEAN.has(p)) value = +!!value;
        else if (value < 0) return;
        set(c, p, [value]);
    });
    function stack(c) { return c.state.mode === GL.TEXTURE ? c.state.texture[c.activeTexture || 0] : c.state.stacks[c.state.mode]; }
    const programMatrix = mode => mode >= GL.MATRIX0_ARB && mode < GL.MATRIX0_ARB + caps.LIMITS.MAX_PROGRAM_MATRICES;
    const matrixLimit = (c, shadow) => c.state.mode === GL.MODELVIEW ? caps.LIMITS.MODELVIEW_STACK_DEPTH :
        programMatrix(c.state.mode) ? (shadow.capabilities && caps.integer(shadow.capabilities, GL.MAX_PROGRAM_MATRIX_STACK_DEPTH_ARB)) ?? caps.LIMITS.PROGRAM_MATRIX_STACK_DEPTH :
        c.state.mode === GL.COLOR && shadow.capabilities ? caps.integer(shadow.capabilities, GL.MAX_COLOR_MATRIX_STACK_DEPTH_SGI) ?? caps.LIMITS.OTHER_STACK_DEPTH : caps.LIMITS.OTHER_STACK_DEPTH;
    on("MATRIX_MODE", (c, [mode]) => { c.state.mode = mode; });
    on("LOAD_IDENTITY", c => { const s = stack(c); s[s.length - 1] = identity(); });
    on("PUSH_MATRIX", (c, a, shadow) => { const s = stack(c); if (s.length < matrixLimit(c, shadow)) s.push(s[s.length - 1].slice()); });
    on("POP_MATRIX", c => { const s = stack(c); if (s.length > 1) s.pop(); });
    const mult = (c, m) => { const s = stack(c); s[s.length - 1] = multiply(s[s.length - 1], m).map(Math.fround); };
    on("TRANSLATEF", (c, [x, y, z]) => { const m = identity(); m[12] = x; m[13] = y; m[14] = z; mult(c, m); });
    on("SCALEF", (c, [x, y, z]) => { const m = identity(); m[0] = x; m[5] = y; m[10] = z; mult(c, m); });
    on("ROTATEF", (c, [angle, x, y, z]) => {
        const len = Math.hypot(x, y, z); if (!len) return;
        x /= len; y /= len; z /= len;
        const cs = Math.cos(angle * Math.PI / 180), sn = Math.sin(angle * Math.PI / 180), t = 1 - cs;
        mult(c, [t*x*x+cs, t*x*y+sn*z, t*x*z-sn*y, 0, t*x*y-sn*z, t*y*y+cs, t*y*z+sn*x, 0,
            t*x*z+sn*y, t*y*z-sn*x, t*z*z+cs, 0, 0, 0, 0, 1]);
    });
    on("ORTHO", (c, [l, r, b, t, n, f]) => {
        if (l === r || b === t || n === f) return;
        mult(c, [2/(r-l), 0, 0, 0, 0, 2/(t-b), 0, 0, 0, 0, -2/(f-n), 0, -(r+l)/(r-l), -(t+b)/(t-b), -(f+n)/(f-n), 1]);
    });
    on("FRUSTUM", (c, [l, r, b, t, n, f]) => {
        if (l === r || b === t || n <= 0 || f <= 0 || n === f) return;
        mult(c, [2*n/(r-l), 0, 0, 0, 0, 2*n/(t-b), 0, 0, (r+l)/(r-l), (t+b)/(t-b), -(f+n)/(f-n), -1, 0, 0, -2*f*n/(f-n), 0]);
    });

    // State families share the same validation path before forwarding.
    for (const name of ["VIEWPORT", "SCISSOR"])
        rule(name, (c, a) => a[2] < 0 || a[3] < 0 ? GL.INVALID_VALUE : 0);
    for (const name of ["DEPTH_RANGE", "CLEAR_COLOR", "CLEAR_ACCUM", "COLOR_MASK", "POLYGON_OFFSET", "LINE_STIPPLE",
            "BLEND_COLOR", "SAMPLE_COVERAGE", "LOAD_IDENTITY", "LOAD_MATRIXF", "MULT_MATRIXF", "TRANSLATEF", "SCALEF", "ROTATEF", "FLUSH", "FINISH"])
        rule(name);
    rule("POLYGON_MODE", (c, a) => [GL.FRONT, GL.BACK, GL.FRONT_AND_BACK].includes(a[0]) &&
        [GL.POINT, GL.LINE, GL.FILL].includes(a[1]) ? 0 : GL.INVALID_ENUM);
    rule("BLEND_FUNC", (c, a) => (FACTORS.has(a[0]) || a[0] === GL.SRC_ALPHA_SATURATE) && FACTORS.has(a[1]) ? 0 : GL.INVALID_ENUM);
    rule("BLEND_FUNC_SEPARATE", (c, a) => a.every((v, i) => FACTORS.has(v) || i % 2 === 0 && v === GL.SRC_ALPHA_SATURATE) ? 0 : GL.INVALID_ENUM);
    for (const name of ["BLEND_EQUATION", "BLEND_EQUATION_SEPARATE"])
        rule(name, (c, a) => a.every(v => EQUATIONS.has(v)) ? 0 : GL.INVALID_ENUM);
    rule("ALPHA_FUNC", (c, a) => COMPARE(a[0]) ? 0 : GL.INVALID_ENUM);
    rule("PIXEL_STOREI", (c, [p, v]) => {
        if (!STORE.has(p)) return GL.INVALID_ENUM;
        if (p === GL.PACK_ALIGNMENT || p === GL.UNPACK_ALIGNMENT) return [1, 2, 4, 8].includes(v) ? 0 : GL.INVALID_VALUE;
        return !STORE_BOOLEAN.has(p) && v < 0 ? GL.INVALID_VALUE : 0;
    });
    rule("MATRIX_MODE", (c, [mode]) => [GL.MODELVIEW, GL.PROJECTION, GL.TEXTURE, GL.COLOR].includes(mode) || programMatrix(mode) ? 0 : GL.INVALID_ENUM);
    rule("PUSH_MATRIX", (c, a, shadow) => stack(c).length >= matrixLimit(c, shadow) ? GL.STACK_OVERFLOW : 0);
    rule("POP_MATRIX", c => stack(c).length <= 1 ? GL.STACK_UNDERFLOW : 0);
    rule("ORTHO", (c, [l, r, b, t, n, f]) => l === r || b === t || n === f ? GL.INVALID_VALUE : 0);
    rule("FRUSTUM", (c, [l, r, b, t, n, f]) => l === r || b === t || n === f || n <= 0 || f <= 0 ? GL.INVALID_VALUE : 0);
    for (const [push, pop, property] of [["PUSH_ATTRIB", "POP_ATTRIB", "attrib"], ["PUSH_CLIENT_ATTRIB", "POP_CLIENT_ATTRIB", "clientAttrib"]]) {
        rule(push, c => c.state[property].length >= (property === "attrib" ? caps.LIMITS.MAX_ATTRIB_STACK_DEPTH : caps.LIMITS.MAX_CLIENT_ATTRIB_STACK_DEPTH) ? GL.STACK_OVERFLOW : 0);
        rule(pop, c => c.state[property].length === 0 ? GL.STACK_UNDERFLOW : 0);
    }
    for (const name of ["ACTIVE_TEXTURE", "CLIENT_ACTIVE_TEXTURE"])
        rule(name, (c, [unit]) => unit >= GL.TEXTURE0 && unit < GL.TEXTURE0 + caps.LIMITS.MAX_TEXTURE_UNITS ? 0 : GL.INVALID_ENUM);
    rule("BEGIN", (c, [mode]) => c.state.begin ? GL.INVALID_OPERATION : mode <= GL.POLYGON ? 0 : GL.INVALID_ENUM, true);
    rule("END", c => c.state.begin ? 0 : GL.INVALID_OPERATION, true);
    for (const name of ["VERTEX3F", "VERTEX4F"]) rule(name, c => c.state.begin ? 0 : GL.INVALID_OPERATION, true);

    const proto = GLShadow.prototype;
    GLShadow.rules({ [GLFN.INDEX_STATE]: (shadow, bytes, view, offset) => {
        const r = P.decodeRecord("INDEX_STATE", view, offset);
        return r.operation > 2 ? GL.INVALID_ENUM : r.operation && shadow.current.state.begin ? GL.INVALID_OPERATION : 0;
    } });
    proto.indexState = function(bytes, view, offset) {
        const r = P.decodeRecord("INDEX_STATE", view, offset);
        set(this.current, [GL.CURRENT_INDEX, GL.INDEX_CLEAR_VALUE, GL.INDEX_WRITEMASK][r.operation], [r.operation === 2 ? r.mask : Math.fround(r.value)]);
    };
    GLShadow.install({ [GLFN.INDEX_STATE]: "indexState" });
    proto.stateValue = function(pname) {
        const c = this.current;
        if (!c) return null;
        const state = c.state;
        const query = QUERIES.get(pname);
        if (query) return query(this);
        if (DEFAULTS.has(pname)) return [state.values[pname], DEFAULTS.get(pname)[1]];
        if (pname === GL.BLEND_SRC) return [state.values[GL.BLEND_SRC_RGB], "i"];
        if (pname === GL.BLEND_DST) return [state.values[GL.BLEND_DST_RGB], "i"];
        const matrix = { [GL.MODELVIEW_MATRIX]: GL.MODELVIEW, [GL.PROJECTION_MATRIX]: GL.PROJECTION,
            [GL.TEXTURE_MATRIX]: GL.TEXTURE, [GL.COLOR_MATRIX_SGI]: GL.COLOR }[pname];
        if (matrix) { const s = matrix === GL.TEXTURE ? state.texture[c.activeTexture || 0] : state.stacks[matrix]; return [s[s.length - 1], "f"]; }
        const transposed = { [GL.TRANSPOSE_MODELVIEW_MATRIX]: GL.MODELVIEW, [GL.TRANSPOSE_PROJECTION_MATRIX]: GL.PROJECTION,
            [GL.TRANSPOSE_TEXTURE_MATRIX]: GL.TEXTURE, [GL.TRANSPOSE_COLOR_MATRIX]: GL.COLOR }[pname];
        if (transposed) {
            const s = transposed === GL.TEXTURE ? state.texture[c.activeTexture || 0] : state.stacks[transposed], m = s[s.length - 1];
            return [Array.from({ length: 16 }, (_, i) => m[(i % 4) * 4 + (i >> 2)]), "f"];
        }
        const depth = { [GL.MODELVIEW_STACK_DEPTH]: GL.MODELVIEW, [GL.PROJECTION_STACK_DEPTH]: GL.PROJECTION,
            [GL.TEXTURE_STACK_DEPTH]: GL.TEXTURE, [GL.COLOR_MATRIX_STACK_DEPTH_SGI]: GL.COLOR }[pname];
        if (depth) return [[(depth === GL.TEXTURE ? state.texture[c.activeTexture || 0] : state.stacks[depth]).length], "i"];
        if (pname === GL.CURRENT_MATRIX_ARB || pname === GL.TRANSPOSE_CURRENT_MATRIX_ARB) {
            const s = stack(c), m = s[s.length - 1];
            return [pname === GL.CURRENT_MATRIX_ARB ? m : Array.from({ length: 16 }, (_, i) => m[(i % 4) * 4 + (i >> 2)]), "f"];
        }
        if (pname === GL.CURRENT_MATRIX_STACK_DEPTH_ARB) return [[stack(c).length], "i"];
        if (pname === GL.MATRIX_MODE) return [[state.mode], "i"];
        if (pname === GL.CURRENT_PROGRAM) return [[c.program], "i"];
        if (pname === GL.ATTRIB_STACK_DEPTH || pname === GL.CLIENT_ATTRIB_STACK_DEPTH) return [[(pname === GL.ATTRIB_STACK_DEPTH ? state.attrib : state.clientAttrib).length], "i"];
        if (pname === GL.PROGRAM_ERROR_POSITION_ARB) return [[this.programErrorPosition?.() ?? -1], "i"];
        const vector = this.capabilities && caps.vector(this.capabilities, pname);
        if (vector) return [vector, pname === GL.COMPRESSED_TEXTURE_FORMATS ? "i" : "f"];
        if (pname === GL.ACTIVE_TEXTURE) return [[GL.TEXTURE0 + (c.activeTexture || 0)], "i"];
        if (pname === GL.CLIENT_ACTIVE_TEXTURE) return [[GL.TEXTURE0 + state.clientTexture], "i"];
        // Format queries belong to the selected drawable, not the adapter.
        if (pname === GL.DOUBLEBUFFER) return [[+(!c.drawFramebuffer && !(state.format & C.V86GL_FORMAT_SINGLE_BUFFER))], "b"];
        if (pname === GL.SAMPLES || pname === GL.SAMPLE_BUFFERS) {
            if (c.drawFramebuffer) return this.framebufferStateValue?.(pname) || null;
            const samples = (state.format & C.V86GL_FORMAT_SAMPLES_MASK) >>> C.V86GL_FORMAT_SAMPLES_SHIFT;
            return [[pname === GL.SAMPLES ? (samples > 1 ? samples : 0) : +(samples > 1)], "i"];
        }
        if (pname === GL.MAX_VIEWPORT_DIMS && this.capabilities) {
            const max = caps.integer(this.capabilities, pname); return [[max, max], "i"];
        }
        // Do not use the adapter's unconditional bit-depth answers for FBOs.
        if (c.drawFramebuffer && pname >= GL.RED_BITS && pname <= GL.STENCIL_BITS) return this.framebufferStateValue?.(pname) || null;
        const value = this.capabilities && caps.integer(this.capabilities, pname);
        return value !== undefined && value !== null ? [[value], "i"] : null;
    };

    proto.queryState = function(bytes, view, offset, size) {
        return this.queryTyped("QUERY_STATE", view, offset, size);
    };
    proto.queryParameter = function(bytes, view, offset, size) {
        return this.queryTyped("QUERY_PARAMETER", view, offset, size);
    };
    proto.queryTyped = function(name, view, offset, size) {
        if (!this.pending(name, view, offset, size)) return;
        const r = P.decodeRecord(name, view, offset);
        const header = RECORDS[name].size;
        const fail = error => {
            if (this.current && !this.current.error) this.current.error = error;
            view.setUint32(offset + F[name].error, error, true);
            this.answered(name, view, offset, C.V86GL_SYNC_QUERY_STATUS_FAILED);
        };
        const parameter = name === "QUERY_PARAMETER";
        if (header + r.data_size > size || r.value_kind < C.V86GL_STATE_INTEGER ||
                r.value_kind > (parameter ? C.V86GL_STATE_UNSIGNED_INT : C.V86GL_STATE_IS_ENABLED) ||
                parameter && r.value_kind === C.V86GL_STATE_IS_ENABLED) return fail(GL.INVALID_VALUE);
        if (!this.current || this.current.state.begin) return fail(GL.INVALID_OPERATION);
        const isEnabled = r.value_kind === C.V86GL_STATE_IS_ENABLED;
        const resolver = parameter && PARAMETERS.get(r.query_kind);
        const result = parameter ? resolver && resolver(this, r.target, r.pname, r.index) :
            isEnabled ? this.enableStateValue && this.enableStateValue(r.pname) : this.stateValue(r.pname);
        if (typeof result === "number") return fail(result);
        if (isEnabled && !result) return fail(GL.INVALID_ENUM);
        if (!result) return fail(GL.INVALID_ENUM);
        const [values, kind] = result;
        if (values.length * 8 > r.data_size) return fail(GL.INVALID_VALUE);
        for (let i = 0; i < values.length; ++i) {
            let v = values[i];
            if (r.value_kind === C.V86GL_STATE_BOOLEAN || isEnabled) v = +!!v;
            else if (r.value_kind === C.V86GL_STATE_UNSIGNED_SHORT || r.value_kind === C.V86GL_STATE_UNSIGNED_INT) {
                const max = r.value_kind === C.V86GL_STATE_UNSIGNED_SHORT ? 65535 : 0xFFFFFFFF;
                v = kind === "n" ? (max === 65535 ? Math.round(clamp(v, 0, 1) * max) : Math.trunc(clamp(v, 0, 1) * max)) : Math.trunc(v) >>> 0;
                if (max === 65535) v &= max;
            }
            else if (r.value_kind === C.V86GL_STATE_INTEGER) {
                // Color/depth conversion scales then truncates (the Apple
                // GL 2.1 oracle), unlike an ordinary float's nearest integer.
                // Preserve the specified negative endpoint even though the
                // Apple driver returns -INT_MAX there (glGet's refpage).
                v = kind === "u" ? v | 0 : kind === "n" ? (v <= -1 ? -0x80000000 : Math.trunc(clamp(v, -1, 1) * 0x7FFFFFFF)) :
                    kind === "t" ? Math.trunc(v) : v < 0 ? -Math.round(-v) : Math.round(v);
                v = clamp(v, -0x80000000, 0x7FFFFFFF);
            } else if (r.value_kind === C.V86GL_STATE_FLOAT) v = Math.fround(v);
            view.setFloat64(offset + header + i * 8, v, true);
        }
        view.setUint32(offset + F[name].count, values.length, true);
        this.answered(name, view, offset, C.V86GL_SYNC_QUERY_STATUS_OK);
    };
    GLShadow.install({ [GLFN.QUERY_STATE]: "queryState", [GLFN.QUERY_PARAMETER]: "queryParameter" });
    GLShadow.part({
        context(c) {
            c.state = { values: Object.fromEntries([...DEFAULTS].map(([p, [v]]) => [p, v.slice()])),
                mode: GL.MODELVIEW, stacks: { [GL.MODELVIEW]: [identity()], [GL.PROJECTION]: [identity()], [GL.COLOR]: [identity()] },
                texture: Array.from({ length: caps.LIMITS.MAX_TEXTURE_UNITS }, () => [identity()]),
                attrib: [], clientAttrib: [], clientTexture: 0, format: 0, initialized: false, begin: false };
            for (let i = 0; i < caps.LIMITS.MAX_PROGRAM_MATRICES; ++i) c.state.stacks[GL.MATRIX0_ARB + i] = [identity()];
        },
        current(shadow, c, view, offset, size) {
            if (!c.state.initialized) {
                const width = shadow.field("MAKE_CURRENT", "width", view, offset, size), height = shadow.field("MAKE_CURRENT", "height", view, offset, size);
                set(c, GL.VIEWPORT, [0, 0, width, height]); set(c, GL.SCISSOR_BOX, [0, 0, width, height]);
                c.state.format = shadow.field("MAKE_CURRENT", "format", view, offset, size);
                c.state.initialized = true;
            }
        },
        command(shadow, fn, bytes, view, offset, size) {
            const c = shadow.current; if (!c) return;
            const state = c.state;
            if (fn === GLFN.BEGIN) { if (size >= 4 && view.getUint32(offset, true) <= GL.POLYGON) state.begin = true; return; }
            if (fn === GLFN.END) { state.begin = false; return; }
            if (state.begin && !WITHIN_BEGIN.has(fn)) return;
            if (fn === GLFN.LOAD_MATRIXF || fn === GLFN.MULT_MATRIXF) {
                if (size < 64) return;
                const m = Array.from({ length: 16 }, (_, i) => view.getFloat32(offset + i * 4, true)), s = stack(c);
                s[s.length - 1] = fn === GLFN.LOAD_MATRIXF ? m : multiply(s[s.length - 1], m).map(Math.fround);
                return;
            }
            if (fn === GLFN.PUSH_ATTRIB || fn === GLFN.PUSH_CLIENT_ATTRIB) {
                if (size < 4) return;
                const mask = view.getUint32(offset, true), client = fn === GLFN.PUSH_CLIENT_ATTRIB;
                const list = client ? state.clientAttrib : state.attrib;
                if (list.length >= 16) return;
                const values = {};
                for (const [p, [, , group]] of DEFAULTS)
                    if (client ? STORE.has(p) && (mask & 1) : group && (mask & group)) values[p] = state.values[p].slice();
                list.push({ values, mode: !client && (mask & 0x1000) ? state.mode : null,
                    clientTexture: client && (mask & 2) ? state.clientTexture : null,
                    activeTexture: !client && (mask & 0x40000) ? c.activeTexture : null,
                    parts: Object.fromEntries([...ATTRIB_PARTS].map(([name, part]) => [name, part.capture(c, mask, client)])) });
                return;
            }
            if (fn === GLFN.POP_ATTRIB || fn === GLFN.POP_CLIENT_ATTRIB) {
                const saved = (fn === GLFN.POP_ATTRIB ? state.attrib : state.clientAttrib).pop();
                if (!saved) return;
                Object.assign(state.values, saved.values);
                if (saved.mode !== null) state.mode = saved.mode;
                if (saved.clientTexture !== null) state.clientTexture = saved.clientTexture;
                if (saved.activeTexture !== null && saved.activeTexture !== undefined) c.activeTexture = saved.activeTexture;
                for (const [name, part] of ATTRIB_PARTS) if (saved.parts && saved.parts[name]) part.restore(c, saved.parts[name]);
                return;
            }
            if (fn === GLFN.CLIENT_ACTIVE_TEXTURE) {
                if (size >= 4) { const unit = view.getUint32(offset, true) - GL.TEXTURE0; if (unit >= 0 && unit < caps.LIMITS.MAX_TEXTURE_COORDS) state.clientTexture = unit; }
                return;
            }
            const setter = SETTERS.get(fn);
            if (setter) { const a = shadow.args(P.NAME_BY_OPCODE[fn], view, offset, size); if (a) setter(c, a, shadow, view, offset); }
        },
        getState(shadow, state) { state.typed = [...shadow.contexts.values()].map(c => [c.key, clone(c.state)]); },
        setState(shadow, state) {
            for (const [key, saved] of state.typed || []) {
                const c = shadow.contexts.get(key); if (!c) continue;
                c.state = clone(saved);
                // Early snapshots stored EdgeFlag under MAX_LIST_NESTING's
                // enum. Migrate the current value and saved attribute values
                // before filling defaults for the corrected pname.
                for (const values of [c.state.values, ...(c.state.attrib || []).map(a => a.values)]) if (values && values[0x0B31] && !values[GL.CURRENT_EDGE_FLAG]) {
                    values[GL.CURRENT_EDGE_FLAG] = values[0x0B31]; delete values[0x0B31];
                }
                for (const [p, [values]] of DEFAULTS) if (!c.state.values[p]) c.state.values[p] = values.slice();
                // The first typed-state snapshot used the query pname as a
                // color stack key. Normalize that internal snapshot spelling.
                if (!c.state.stacks[GL.COLOR]) c.state.stacks[GL.COLOR] = c.state.stacks[GL.COLOR_MATRIX_SGI] || [identity()];
                delete c.state.stacks[GL.COLOR_MATRIX_SGI];
                for (let i = 0; i < caps.LIMITS.MAX_PROGRAM_MATRICES; ++i) if (!c.state.stacks[GL.MATRIX0_ARB + i]) c.state.stacks[GL.MATRIX0_ARB + i] = [identity()];
                if (c.state.mode === GL.COLOR_MATRIX_SGI) c.state.mode = GL.COLOR;
            }
        },
    });
    // State-family modules extend this registry, rather than adding another
    // copy of typed conversion, command walking or snapshot serialization.
    const api = { define, on, set, rule,
        query(pnames, fn) { for (const pname of pnames) QUERIES.set(pname, fn); },
        parameter(kind, fn) { PARAMETERS.set(kind, fn); },
        attributes(name, part) { ATTRIB_PARTS.set(name, part); } };
    global.V86GLShadowState = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
