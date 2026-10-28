// OpenGL ES 1.1's own state (docs/gles-proxy-plan.md E4), written from the
// GLES 1.1 specification: the matrix stacks and their operations, the
// current color, normal, texture coordinates and point size, the client
// arrays (the encoder's *PointerData/*PointerOffset), lights, the light
// model, the material, the shade model, each texture unit's environment and
// enable, fog, the alpha test, user clip planes (kept in eye coordinates,
// as the specification transforms them), point parameters and sprites, the
// logic op; the 16.16 fixed variants; the queries of all of it. The shadow
// state (src/gles/gles_shadow.js) runs these for GLES 1.1 contexts, beside
// the object state both versions share; the page's executor draws from the
// same state with gl-webgpu's fixed-function generator.

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const UNITS = 4;
const LIGHTS = 8;
const CLIP_PLANES = 6;
const STACK_DEPTH = { 0x1700: 16, 0x1701: 2, 0x1702: 2 };
const STACK_OVERFLOW = 0x0503, STACK_UNDERFLOW = 0x0504;
const INVALID_ENUM = 0x0500, INVALID_VALUE = 0x0501, INVALID_OPERATION = 0x0502;
const FIXED = 0x140C, FLOAT = 0x1406, BYTE = 0x1400, UNSIGNED_BYTE = 0x1401, SHORT = 0x1402;
/** the client arrays glEnableClientState takes */
export const CLIENT_ARRAYS = { 0x8074: "vertex", 0x8075: "normal", 0x8076: "color", 0x8078: "texcoord", 0x8B9C: "point_size" };

/** @param {!Array<number>} a @param {!Array<number>} b @return {!Array<number>} a * b, column-major */
export function mat_mul(a, b)
{
    const m = new Array(16);
    for(let c = 0; c < 4; c++)
    {
        for(let r = 0; r < 4; r++)
        {
            m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }
    return m;
}

/** @param {!Array<number>} m @return {!Array<number>} its inverse (the identity for a singular one) */
export function mat_inverse(m)
{
    const inv = new Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if(!det) return IDENTITY.slice();
    return inv.map(v => v / det);
}

/** @param {!Array<number>} m @param {!Array<number>} v @return {!Array<number>} m * v */
function transform(m, v)
{
    return [0, 1, 2, 3].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
}

/** A GLES 1.1 context's fixed-function state (GLES 1.1 tables 6.x), at its initial values */
export function new_ff_state()
{
    const pointer = () => ({ enabled: false, size: 4, type: FLOAT, stride: 0, buffer: 0, offset: 0, data: null });
    return {
        matrix_mode: 0x1700,
        stacks: { 0x1700: [IDENTITY.slice()], 0x1701: [IDENTITY.slice()], 0x1702: Array.from({ length: UNITS }, () => [IDENTITY.slice()]) },
        color: [1, 1, 1, 1], normal: [0, 0, 1], texcoord: Array.from({ length: UNITS }, () => [0, 0, 0, 1]),
        client_active_texture: 0,
        arrays: { vertex: pointer(), normal: Object.assign(pointer(), { size: 3 }), color: pointer(), point_size: Object.assign(pointer(), { size: 1 }),
            texcoord: Array.from({ length: UNITS }, pointer) },
        texture_enabled: Array.from({ length: UNITS }, () => ({ 0x0DE1: false, 0x8D65: false })),
        lights: Array.from({ length: LIGHTS }, (_, i) => ({
            ambient: [0, 0, 0, 1], diffuse: i ? [0, 0, 0, 1] : [1, 1, 1, 1], specular: i ? [0, 0, 0, 1] : [1, 1, 1, 1],
            position: [0, 0, 1, 0], spot_direction: [0, 0, -1], spot_exponent: 0, spot_cutoff: 180, attenuation: [1, 0, 0],
        })),
        light_model: { ambient: [0.2, 0.2, 0.2, 1], two_side: 0 },
        material: { ambient: [0.2, 0.2, 0.2, 1], diffuse: [0.8, 0.8, 0.8, 1], specular: [0, 0, 0, 1], emission: [0, 0, 0, 1], shininess: 0 },
        shade_model: 0x1D01,
        env: Array.from({ length: UNITS }, () => ({
            mode: 0x2100, color: [0, 0, 0, 0], combine_rgb: 0x2100, combine_alpha: 0x2100,
            src_rgb: [0x1702, 0x8578, 0x8576], src_alpha: [0x1702, 0x8578, 0x8576],
            operand_rgb: [0x0300, 0x0300, 0x0302], operand_alpha: [0x0302, 0x0302, 0x0302], rgb_scale: 1, alpha_scale: 1, coord_replace: 0,
        })),
        fog: { mode: 0x0800, density: 1, start: 0, end: 1, color: [0, 0, 0, 0] },
        alpha_func: 0x0207, alpha_ref: 0,
        clip_planes: Array.from({ length: CLIP_PLANES }, () => [0, 0, 0, 0]),
        point: { size: 1, min: 0, max: 1, fade: 1, attenuation: [1, 0, 0] },
        logic_op: 0x1503,
    };
}

/** @param {!Object} ff @return {!Array<!Array<number>>} the current matrix's stack */
function stack(ff, active_texture)
{
    const s = ff.stacks[ff.matrix_mode];
    return ff.matrix_mode === 0x1702 ? s[active_texture] : s;
}

/** @param {!Object} c the context @return {!Array<number>} the current modelview matrix */
export function modelview(c)
{
    return c.ff.stacks[0x1700].at(-1);
}

const x2f = v => v / 65536;
const xs = values => values.map(x2f);

/** @param {?Uint8Array} bytes @param {boolean} fixed @return {!Array<number>} f32s, or 16.16s as numbers */
function values_of(bytes, fixed)
{
    if(!bytes) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    for(let at = 0; at + 4 <= bytes.length; at += 4) out.push(fixed ? view.getInt32(at, true) / 65536 : view.getFloat32(at, true));
    return out;
}

/** The matrix operations: (context, fail, matrix) => the new top or a code */
function matrix_op(build)
{
    return (shadow, c, args, fail) =>
    {
        const m = build(args);
        if(typeof m === "number") return fail(c, m);
        const s = stack(c.ff, c.active_texture);
        s[s.length - 1] = mat_mul(s.at(-1), m);
        return undefined;
    };
}

const translate = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scale = ([x, y, z]) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
function rotate([angle, x, y, z])
{
    const length = Math.hypot(x, y, z);
    if(!length) return IDENTITY.slice();
    x /= length; y /= length; z /= length;
    const a = angle * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a), t = 1 - cs;
    return [x * x * t + cs, y * x * t + z * sn, x * z * t - y * sn, 0, x * y * t - z * sn, y * y * t + cs, y * z * t + x * sn, 0,
        x * z * t + y * sn, y * z * t - x * sn, z * z * t + cs, 0, 0, 0, 0, 1];
}
function frustum([l, r, b, t, n, f])
{
    if(n <= 0 || f <= 0 || l === r || b === t || n === f) return INVALID_VALUE;
    return [2 * n / (r - l), 0, 0, 0, 0, 2 * n / (t - b), 0, 0, (r + l) / (r - l), (t + b) / (t - b), -(f + n) / (f - n), -1,
        0, 0, -2 * f * n / (f - n), 0];
}
function ortho([l, r, b, t, n, f])
{
    if(l === r || b === t || n === f) return INVALID_VALUE;
    return [2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1];
}

/** glLight's: a light's parameter (`v` its values), GLES 1.1 2.12.1's checks */
function light(shadow, c, light_enum, pname, v, scalar, fail)
{
    const index = light_enum - 0x4000;
    if(index < 0 || index >= LIGHTS) return fail(c, INVALID_ENUM);
    const l = c.ff.lights[index];
    const vector = { 0x1200: "ambient", 0x1201: "diffuse", 0x1202: "specular", 0x1203: "position", 0x1204: "spot_direction" }[pname];
    if(vector)
    {
        if(scalar) return fail(c, INVALID_ENUM);
        if(pname === 0x1203) l.position = transform(modelview(c), v.slice(0, 4));
        else if(pname === 0x1204)
        {
            const m = modelview(c);
            l.spot_direction = [0, 1, 2].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2]);
        }
        else l[vector] = v.slice(0, 4);
        return undefined;
    }
    const value = v[0];
    switch(pname)
    {
        case 0x1205: if(value < 0 || value > 128) return fail(c, INVALID_VALUE); l.spot_exponent = value; break;
        case 0x1206: if((value < 0 || value > 90) && value !== 180) return fail(c, INVALID_VALUE); l.spot_cutoff = value; break;
        case 0x1207: case 0x1208: case 0x1209:
            if(value < 0) return fail(c, INVALID_VALUE);
            l.attenuation[pname - 0x1207] = value;
            break;
        default: return fail(c, INVALID_ENUM);
    }
    return undefined;
}

function light_model(shadow, c, pname, v, scalar, fail)
{
    if(pname === 0x0B53 && !scalar) c.ff.light_model.ambient = v.slice(0, 4);
    else if(pname === 0x0B52) c.ff.light_model.two_side = v[0] ? 1 : 0;
    else return fail(c, INVALID_ENUM);
    return undefined;
}

function material(shadow, c, face, pname, v, scalar, fail)
{
    if(face !== 0x0408) return fail(c, INVALID_ENUM);
    const m = c.ff.material;
    switch(pname)
    {
        case 0x1601:
            if(v[0] < 0 || v[0] > 128) return fail(c, INVALID_VALUE);
            m.shininess = v[0];
            return undefined;
        case 0x1200: case 0x1201: case 0x1202: case 0x1600: case 0x1602:
            if(scalar) return fail(c, INVALID_ENUM);
            if(pname === 0x1602) m.ambient = m.diffuse = v.slice(0, 4);
            else m[{ 0x1200: "ambient", 0x1201: "diffuse", 0x1202: "specular", 0x1600: "emission" }[pname]] = v.slice(0, 4);
            return undefined;
    }
    return fail(c, INVALID_ENUM);
}

/** glTexEnv's pnames: the field, and its values (null: any value) */
const ENV_PNAMES = {
    0x2200: ["mode", [0x2100, 0x2101, 0x0BE2, 0x0104, 0x1E01, 0x8570]],
    0x8571: ["combine_rgb", [0x1E01, 0x2100, 0x0104, 0x8574, 0x8575, 0x84E7, 0x86AE, 0x86AF]],
    0x8572: ["combine_alpha", [0x1E01, 0x2100, 0x0104, 0x8574, 0x8575, 0x84E7]],
    0x8573: ["rgb_scale", null], 0x0D1C: ["alpha_scale", null],
};
const SOURCES = [0x1702, 0x8576, 0x8577, 0x8578];

function tex_env(shadow, c, target, pname, v, scalar, fail)
{
    const env = c.ff.env[c.active_texture] || c.ff.env[0];
    if(target === 0x8861)
    {
        if(pname !== 0x8862) return fail(c, INVALID_ENUM);
        env.coord_replace = v[0] ? 1 : 0;
        return undefined;
    }
    if(target !== 0x2300) return fail(c, INVALID_ENUM);
    if(pname === 0x2201)
    {
        if(scalar) return fail(c, INVALID_ENUM);
        env.color = v.slice(0, 4).map(x => Math.min(1, Math.max(0, x)));
        return undefined;
    }
    const value = v[0];
    if(pname >= 0x8580 && pname <= 0x858A)
    {
        // SRC0..2_RGB, SRC0..2_ALPHA, OPERAND0..2_RGB (0x8590...), handled below
    }
    const src = { 0x8580: ["src_rgb", 0], 0x8581: ["src_rgb", 1], 0x8582: ["src_rgb", 2], 0x8588: ["src_alpha", 0], 0x8589: ["src_alpha", 1],
        0x858A: ["src_alpha", 2] }[pname];
    if(src)
    {
        if(!SOURCES.includes(value)) return fail(c, INVALID_ENUM);
        env[src[0]][src[1]] = value;
        return undefined;
    }
    const operand = { 0x8590: ["operand_rgb", 0], 0x8591: ["operand_rgb", 1], 0x8592: ["operand_rgb", 2], 0x8598: ["operand_alpha", 0],
        0x8599: ["operand_alpha", 1], 0x859A: ["operand_alpha", 2] }[pname];
    if(operand)
    {
        const allowed = operand[0] === "operand_rgb" ? [0x0300, 0x0301, 0x0302, 0x0303] : [0x0302, 0x0303];
        if(!allowed.includes(value)) return fail(c, INVALID_ENUM);
        env[operand[0]][operand[1]] = value;
        return undefined;
    }
    const entry = ENV_PNAMES[pname];
    if(!entry) return fail(c, INVALID_ENUM);
    if(entry[1] && !entry[1].includes(value)) return fail(c, INVALID_ENUM);
    if(!entry[1] && value !== 1 && value !== 2 && value !== 4) return fail(c, INVALID_VALUE);
    env[entry[0]] = value;
    return undefined;
}

function fog(shadow, c, pname, v, scalar, fail)
{
    const f = c.ff.fog;
    switch(pname)
    {
        case 0x0B65: if(![0x2601, 0x0800, 0x0801].includes(v[0])) return fail(c, INVALID_ENUM); f.mode = v[0]; break;
        case 0x0B62: if(v[0] < 0) return fail(c, INVALID_VALUE); f.density = v[0]; break;
        case 0x0B63: f.start = v[0]; break;
        case 0x0B64: f.end = v[0]; break;
        case 0x0B66: if(scalar) return fail(c, INVALID_ENUM); f.color = v.slice(0, 4).map(x => Math.min(1, Math.max(0, x))); break;
        default: return fail(c, INVALID_ENUM);
    }
    return undefined;
}

function point_parameter(shadow, c, pname, v, scalar, fail)
{
    const p = c.ff.point;
    switch(pname)
    {
        case 0x8126: if(v[0] < 0) return fail(c, INVALID_VALUE); p.min = v[0]; break;
        case 0x8127: if(v[0] < 0) return fail(c, INVALID_VALUE); p.max = v[0]; break;
        case 0x8128: if(v[0] < 0) return fail(c, INVALID_VALUE); p.fade = v[0]; break;
        case 0x8129: if(scalar) return fail(c, INVALID_ENUM); p.attenuation = v.slice(0, 3); break;
        default: return fail(c, INVALID_ENUM);
    }
    return undefined;
}

function clip_plane(shadow, c, plane, v, fail)
{
    const index = plane - 0x3000;
    if(index < 0 || index >= CLIP_PLANES) return fail(c, INVALID_ENUM);
    // (into eye coordinates: the plane times the inverse modelview)
    const inv = mat_inverse(modelview(c));
    c.ff.clip_planes[index] = [0, 1, 2, 3].map(col => v[0] * inv[col * 4] + v[1] * inv[col * 4 + 1] + v[2] * inv[col * 4 + 2] + v[3] * inv[col * 4 + 3]);
    return undefined;
}

/** A client array's pointer: GLES 1.1 2.8's sizes and types */
function pointer(array, sizes, types)
{
    return (shadow, c, args, fail, data_form) =>
    {
        let unit = null, size, type, stride, rest;
        if(array === "texcoord" && data_form) [unit, size, type, stride, ...rest] = args;
        else if(sizes) [size, type, stride, ...rest] = args;
        else { [type, stride, ...rest] = args; size = array === "normal" ? 3 : 1; }
        if(sizes && !sizes.includes(size) || stride < 0) return fail(c, INVALID_VALUE);
        if(!types.includes(type)) return fail(c, INVALID_ENUM);
        const ff = c.ff;
        const p = array === "texcoord" ? ff.arrays.texcoord[unit === null ? ff.client_active_texture : unit] : ff.arrays[array];
        if(!p) return fail(c, INVALID_VALUE);
        Object.assign(p, { size, type, stride, buffer: data_form ? 0 : c.array_buffer, offset: data_form ? 0 : rest[0], data: data_form ? rest[0] : null });
        return undefined;
    };
}

const POSITION_TYPES = [BYTE, SHORT, FIXED, FLOAT];
const ARRAY_HANDLERS = {
    "glVertexPointer": pointer("vertex", [2, 3, 4], POSITION_TYPES),
    "glColorPointer": pointer("color", [4], [UNSIGNED_BYTE, FIXED, FLOAT]),
    "glNormalPointer": pointer("normal", null, POSITION_TYPES),
    "glTexCoordPointer": pointer("texcoord", [2, 3, 4], POSITION_TYPES),
    "glPointSizePointer": pointer("point_size", null, [FIXED, FLOAT]),
};

/**
 * GLES 1.1's commands: (shadow, context, args, fail) to the answer (fail's
 * result when refused). `query(shadow)` marks a call that only asks.
 * @param {function(!Object, number): symbol} fail
 * @param {function(!Object)} query
 * @return {!Object<string, function>}
 */
export function gles1_handlers(fail, query)
{
    const H = {};
    // (the matrix operations, with this fail)
    const matrix = build => { const op = matrix_op(build); return (s, c, a) => op(s, c, a, fail); };
    const both = (name, f) => { H[name + "f"] = (s, c, a) => f(s, c, a, false); H[name + "x"] = (s, c, a) => f(s, c, a.map((v, i) => typeof v === "number" ? v : v), true); };
    H["glMatrixMode"] = (s, c, [mode]) =>
    {
        if(!STACK_DEPTH[mode]) return fail(c, INVALID_ENUM);
        c.ff.matrix_mode = mode;
        return undefined;
    };
    H["glLoadIdentity"] = (s, c) => { const st = stack(c.ff, c.active_texture); st[st.length - 1] = IDENTITY.slice(); return undefined; };
    H["glLoadMatrixf"] = (s, c, [m]) => { const st = stack(c.ff, c.active_texture); st[st.length - 1] = values_of(m, false).slice(0, 16); return undefined; };
    H["glLoadMatrixx"] = (s, c, [m]) => { const st = stack(c.ff, c.active_texture); st[st.length - 1] = values_of(m, true).slice(0, 16); return undefined; };
    H["glMultMatrixf"] = matrix(([m]) => values_of(m, false).slice(0, 16));
    H["glMultMatrixx"] = matrix(([m]) => values_of(m, true).slice(0, 16));
    H["glPushMatrix"] = (s, c) =>
    {
        const st = stack(c.ff, c.active_texture);
        if(st.length >= STACK_DEPTH[c.ff.matrix_mode]) return fail(c, STACK_OVERFLOW);
        st.push(st.at(-1).slice());
        return undefined;
    };
    H["glPopMatrix"] = (s, c) =>
    {
        const st = stack(c.ff, c.active_texture);
        if(st.length <= 1) return fail(c, STACK_UNDERFLOW);
        st.pop();
        return undefined;
    };
    H["glTranslatef"] = matrix(translate);
    H["glTranslatex"] = matrix(a => translate(xs(a)));
    H["glScalef"] = matrix(scale);
    H["glScalex"] = matrix(a => scale(xs(a)));
    H["glRotatef"] = matrix(rotate);
    H["glRotatex"] = matrix(a => rotate(xs(a)));
    H["glFrustumf"] = matrix(frustum);
    H["glFrustumx"] = matrix(a => frustum(xs(a)));
    H["glOrthof"] = matrix(ortho);
    H["glOrthox"] = matrix(a => ortho(xs(a)));
    // current values
    H["glColor4f"] = (s, c, rgba) => { c.ff.color = rgba.slice(); return undefined; };
    H["glColor4x"] = (s, c, rgba) => { c.ff.color = xs(rgba); return undefined; };
    H["glColor4ub"] = (s, c, rgba) => { c.ff.color = rgba.map(v => v / 255); return undefined; };
    H["glNormal3f"] = (s, c, n) => { c.ff.normal = n.slice(); return undefined; };
    H["glNormal3x"] = (s, c, n) => { c.ff.normal = xs(n); return undefined; };
    const texcoord = fixed => (s, c, [target, ...v]) =>
    {
        const unit = target - 0x84C0;
        if(unit < 0 || unit >= UNITS) return fail(c, INVALID_ENUM);
        c.ff.texcoord[unit] = fixed ? xs(v) : v.slice();
        return undefined;
    };
    H["glMultiTexCoord4f"] = texcoord(false);
    H["glMultiTexCoord4x"] = texcoord(true);
    H["glPointSize"] = (s, c, [size]) => { if(!(size > 0)) return fail(c, INVALID_VALUE); c.ff.point.size = size; return undefined; };
    H["glPointSizex"] = (s, c, [size]) => H["glPointSize"](s, c, [x2f(size)]);
    // client arrays
    H["glClientActiveTexture"] = (s, c, [texture]) =>
    {
        const unit = texture - 0x84C0;
        if(unit < 0 || unit >= UNITS) return fail(c, INVALID_ENUM);
        c.ff.client_active_texture = unit;
        return undefined;
    };
    const client_state = enable => (s, c, [array]) =>
    {
        const name = CLIENT_ARRAYS[array];
        if(!name) return fail(c, INVALID_ENUM);
        const p = name === "texcoord" ? c.ff.arrays.texcoord[c.ff.client_active_texture] : c.ff.arrays[name];
        p.enabled = enable;
        return undefined;
    };
    H["glEnableClientState"] = client_state(true);
    H["glDisableClientState"] = client_state(false);
    for(const [name, handler] of Object.entries(ARRAY_HANDLERS))
    {
        H[name + "Data"] = (s, c, a) => handler(s, c, a, fail, true);
        H[name + "Offset"] = (s, c, a) => handler(s, c, a, fail, false);
    }
    // (OES_matrix_palette is not offered: its calls change nothing)
    for(const name of ["glWeightPointerData", "glWeightPointerOffset", "glMatrixIndexPointerData", "glMatrixIndexPointerOffset",
        "glCurrentPaletteMatrixOES", "glLoadPaletteFromModelViewMatrixOES"]) H[name] = () => undefined;
    // lighting, material, environment, fog, points
    for(const [name, f] of [["glLight", light], ["glMaterial", material]])
    {
        H[name + "f"] = (s, c, [a, pname, v]) => f(s, c, a, pname, [v], true, fail);
        H[name + "x"] = (s, c, [a, pname, v]) => f(s, c, a, pname, [pname === 0x1206 || pname === 0x1205 || pname >= 0x1207 || pname === 0x1601 ? x2f(v) : x2f(v)], true, fail);
        H[name + "fv"] = (s, c, [a, pname, v]) => f(s, c, a, pname, values_of(v, false), false, fail);
        H[name + "xv"] = (s, c, [a, pname, v]) => f(s, c, a, pname, values_of(v, true), false, fail);
    }
    for(const [name, f] of [["glLightModel", light_model], ["glFog", fog], ["glPointParameter", point_parameter]])
    {
        // (enum values come as themselves in the x forms: GL_FOG_MODE's)
        const enum_valued = pname => name === "glFog" && pname === 0x0B65;
        H[name + "f"] = (s, c, [pname, v]) => f(s, c, pname, [v], true, fail);
        H[name + "x"] = (s, c, [pname, v]) => f(s, c, pname, [enum_valued(pname) ? v : x2f(v)], true, fail);
        H[name + "fv"] = (s, c, [pname, v]) => f(s, c, pname, values_of(v, false), false, fail);
        H[name + "xv"] = (s, c, [pname, v]) => f(s, c, pname, enum_valued(pname) ? [values_of(v, true)[0] * 65536] : values_of(v, true), false, fail);
    }
    const env_enum = pname => pname !== 0x2201 && pname !== 0x8573 && pname !== 0x0D1C;
    H["glTexEnvf"] = (s, c, [t, pname, v]) => tex_env(s, c, t, pname, [v], true, fail);
    H["glTexEnvi"] = (s, c, [t, pname, v]) => tex_env(s, c, t, pname, [v], true, fail);
    H["glTexEnvx"] = (s, c, [t, pname, v]) => tex_env(s, c, t, pname, [env_enum(pname) ? v : x2f(v)], true, fail);
    H["glTexEnvfv"] = (s, c, [t, pname, v]) => tex_env(s, c, t, pname, values_of(v, false), false, fail);
    H["glTexEnviv"] = (s, c, [t, pname, v]) => tex_env(s, c, t, pname, pname === 0x2201 ?
        values_of(v, true).map(x => x * 65536 / 0x7FFFFFFF) : values_of(v, true).map(x => x * 65536), false, fail);
    H["glTexEnvxv"] = (s, c, [t, pname, v]) => tex_env(s, c, t, pname, env_enum(pname) ? values_of(v, true).map(x => x * 65536) : values_of(v, true), false, fail);
    H["glShadeModel"] = (s, c, [mode]) => { if(mode !== 0x1D00 && mode !== 0x1D01) return fail(c, INVALID_ENUM); c.ff.shade_model = mode; return undefined; };
    H["glAlphaFunc"] = (s, c, [func, ref]) =>
    {
        if(func < 0x0200 || func > 0x0207) return fail(c, INVALID_ENUM);
        c.ff.alpha_func = func;
        c.ff.alpha_ref = Math.min(1, Math.max(0, ref));
        return undefined;
    };
    H["glAlphaFuncx"] = (s, c, [func, ref]) => H["glAlphaFunc"](s, c, [func, x2f(ref)]);
    H["glClipPlanef"] = (s, c, [plane, eq]) => clip_plane(s, c, plane, values_of(eq, false), fail);
    H["glClipPlanex"] = (s, c, [plane, eq]) => clip_plane(s, c, plane, values_of(eq, true), fail);
    H["glLogicOp"] = (s, c, [op]) => { if(op < 0x1500 || op > 0x150F) return fail(c, INVALID_ENUM); c.ff.logic_op = op; return undefined; };
    // the draw_texture extension: a screen-aligned rectangle (GLES 1.1 OES_draw_texture)
    const draw_tex = (s, c, [x, y, z, w, h]) => w <= 0 || h <= 0 ? fail(c, INVALID_VALUE) : undefined;
    H["glDrawTexsOES"] = draw_tex;
    H["glDrawTexiOES"] = draw_tex;
    H["glDrawTexfOES"] = draw_tex;
    H["glDrawTexxOES"] = (s, c, a) => draw_tex(s, c, xs(a));
    H["glDrawTexsvOES"] = (s, c, [v]) => draw_tex(s, c, Array.from(new Int16Array(v.slice().buffer)));
    H["glDrawTexivOES"] = (s, c, [v]) => draw_tex(s, c, Array.from(new Int32Array(v.slice().buffer)));
    H["glDrawTexfvOES"] = (s, c, [v]) => draw_tex(s, c, values_of(v, false));
    H["glDrawTexxvOES"] = (s, c, [v]) => draw_tex(s, c, values_of(v, true));
    // (the shared commands' fixed forms)
    for(const [x, f, convert] of [["glClearColorx", "glClearColor", xs], ["glClearDepthx", "glClearDepthf", xs], ["glDepthRangex", "glDepthRangef", xs],
        ["glLineWidthx", "glLineWidth", xs], ["glPolygonOffsetx", "glPolygonOffset", xs], ["glSampleCoveragex", "glSampleCoverage", a => [x2f(a[0]), a[1]]]])
    {
        H[x] = (s, c, a) => s.handlers[f](s, c, convert(a));
    }
    // queries
    H["glGetLightfv"] = (s, c, [l, pname, out]) => get_light(s, c, l, pname, out, "f", query, fail);
    H["glGetLightxv"] = (s, c, [l, pname, out]) => get_light(s, c, l, pname, out, "x", query, fail);
    H["glGetMaterialfv"] = (s, c, [face, pname, out]) => get_material(s, c, face, pname, out, "f", query, fail);
    H["glGetMaterialxv"] = (s, c, [face, pname, out]) => get_material(s, c, face, pname, out, "x", query, fail);
    H["glGetTexEnvfv"] = (s, c, [t, pname, out]) => get_tex_env(s, c, t, pname, out, "f", query, fail);
    H["glGetTexEnviv"] = (s, c, [t, pname, out]) => get_tex_env(s, c, t, pname, out, "i", query, fail);
    H["glGetTexEnvxv"] = (s, c, [t, pname, out]) => get_tex_env(s, c, t, pname, out, "x", query, fail);
    H["glGetClipPlanef"] = (s, c, [plane, out]) => get_clip_plane(s, c, plane, out, "f", query, fail);
    H["glGetClipPlanex"] = (s, c, [plane, out]) => get_clip_plane(s, c, plane, out, "x", query, fail);
    void both;
    return H;
}

/** Values into an out buffer: "f" floats, "x" 16.16, "i" integers (colors normalized) */
function put_values(out, values, as, normalized)
{
    for(let i = 0; i < values.length && 4 * i + 4 <= out.size; i++)
    {
        const v = values[i];
        if(as === "f") out.view.setFloat32(4 * i, v, true);
        else if(as === "x") out.view.setInt32(4 * i, Math.round(v * 65536), true);
        else out.view.setInt32(4 * i, normalized ? Math.round(Math.max(-1, Math.min(1, v)) * 0x7FFFFFFF) : Math.round(v), true);
    }
}

function get_light(s, c, light_enum, pname, out, as, query, fail)
{
    query(s);
    const l = c.ff.lights[light_enum - 0x4000];
    if(!l) return fail(c, INVALID_ENUM);
    const value = { 0x1200: l.ambient, 0x1201: l.diffuse, 0x1202: l.specular, 0x1203: l.position, 0x1204: l.spot_direction,
        0x1205: [l.spot_exponent], 0x1206: [l.spot_cutoff], 0x1207: [l.attenuation[0]], 0x1208: [l.attenuation[1]], 0x1209: [l.attenuation[2]] }[pname];
    if(!value) return fail(c, INVALID_ENUM);
    put_values(out, value, as, false);
    return undefined;
}

function get_material(s, c, face, pname, out, as, query, fail)
{
    query(s);
    if(face !== 0x0404 && face !== 0x0405) return fail(c, INVALID_ENUM);
    const m = c.ff.material;
    const value = { 0x1200: m.ambient, 0x1201: m.diffuse, 0x1202: m.specular, 0x1600: m.emission, 0x1601: [m.shininess] }[pname];
    if(!value) return fail(c, INVALID_ENUM);
    put_values(out, value, as, false);
    return undefined;
}

function get_tex_env(s, c, target, pname, out, as, query, fail)
{
    query(s);
    const env = c.ff.env[c.active_texture] || c.ff.env[0];
    if(target === 0x8861 && pname === 0x8862) { put_values(out, [env.coord_replace], as === "x" ? "i" : as, false); return undefined; }
    if(target !== 0x2300) return fail(c, INVALID_ENUM);
    if(pname === 0x2201) { put_values(out, env.color, as, as === "i"); return undefined; }
    const value = { 0x2200: env.mode, 0x8571: env.combine_rgb, 0x8572: env.combine_alpha, 0x8573: env.rgb_scale, 0x0D1C: env.alpha_scale,
        0x8580: env.src_rgb[0], 0x8581: env.src_rgb[1], 0x8582: env.src_rgb[2], 0x8588: env.src_alpha[0], 0x8589: env.src_alpha[1],
        0x858A: env.src_alpha[2], 0x8590: env.operand_rgb[0], 0x8591: env.operand_rgb[1], 0x8592: env.operand_rgb[2],
        0x8598: env.operand_alpha[0], 0x8599: env.operand_alpha[1], 0x859A: env.operand_alpha[2] }[pname];
    if(value === undefined) return fail(c, INVALID_ENUM);
    // (enum values as themselves, also in the fixed form; the scales as numbers)
    const scale = pname === 0x8573 || pname === 0x0D1C;
    put_values(out, [value], as === "x" && !scale ? "i" : as, false);
    return undefined;
}

function get_clip_plane(s, c, plane, out, as, query, fail)
{
    query(s);
    const p = c.ff.clip_planes[plane - 0x3000];
    if(!p) return fail(c, INVALID_ENUM);
    put_values(out, p, as, false);
    return undefined;
}

/**
 * GLES 1.1's glGet values, beyond the shared ones: [values, kind] ("f"
 * float, "n" a color or normal, "i" integer, "b" boolean), or null
 * @param {!Object} c
 * @param {number} pname
 * @return {?Array}
 */
export function gles1_state_value(c, pname)
{
    const ff = c.ff;
    const unit = c.active_texture;
    const tex = ff.arrays.texcoord[ff.client_active_texture];
    switch(pname)
    {
        case 0x0BA0: return [[ff.matrix_mode], "i"];
        case 0x0BA6: return [ff.stacks[0x1700].at(-1), "f"];
        case 0x0BA7: return [ff.stacks[0x1701].at(-1), "f"];
        case 0x0BA8: return [ff.stacks[0x1702][unit].at(-1), "f"];
        case 0x0BA3: return [[ff.stacks[0x1700].length], "i"];
        case 0x0BA4: return [[ff.stacks[0x1701].length], "i"];
        case 0x0BA5: return [[ff.stacks[0x1702][unit].length], "i"];
        case 0x0B00: return [ff.color, "n"];
        case 0x0B02: return [ff.normal, "n"];
        case 0x0B03: return [ff.texcoord[unit], "f"];
        case 0x0B11: return [[ff.point.size], "f"];
        case 0x8126: return [[ff.point.min], "f"];
        case 0x8127: return [[ff.point.max], "f"];
        case 0x8128: return [[ff.point.fade], "f"];
        case 0x8129: return [ff.point.attenuation, "f"];
        case 0x0B54: return [[ff.shade_model], "i"];
        case 0x0B53: return [ff.light_model.ambient, "n"];
        case 0x0B52: return [[ff.light_model.two_side], "b"];
        case 0x0B65: return [[ff.fog.mode], "i"];
        case 0x0B62: return [[ff.fog.density], "f"];
        case 0x0B63: return [[ff.fog.start], "f"];
        case 0x0B64: return [[ff.fog.end], "f"];
        case 0x0B66: return [ff.fog.color, "n"];
        case 0x0BC1: return [[ff.alpha_func], "i"];
        case 0x0BC2: return [[ff.alpha_ref], "n"];
        case 0x0BF0: return [[ff.logic_op], "i"];
        case 0x84E1: return [[0x84C0 + ff.client_active_texture], "i"];
        case 0x807A: return [[ff.arrays.vertex.size], "i"];
        case 0x807B: return [[ff.arrays.vertex.type], "i"];
        case 0x807C: return [[ff.arrays.vertex.stride], "i"];
        case 0x807E: return [[ff.arrays.normal.type], "i"];
        case 0x807F: return [[ff.arrays.normal.stride], "i"];
        case 0x8081: return [[ff.arrays.color.size], "i"];
        case 0x8082: return [[ff.arrays.color.type], "i"];
        case 0x8083: return [[ff.arrays.color.stride], "i"];
        case 0x8088: return [[tex.size], "i"];
        case 0x8089: return [[tex.type], "i"];
        case 0x808A: return [[tex.stride], "i"];
        case 0x898A: return [[ff.arrays.point_size.type], "i"];
        case 0x898B: return [[ff.arrays.point_size.stride], "i"];
        case 0x8896: return [[ff.arrays.vertex.buffer], "i"];
        case 0x8897: return [[ff.arrays.normal.buffer], "i"];
        case 0x8898: return [[ff.arrays.color.buffer], "i"];
        case 0x889A: return [[tex.buffer], "i"];
        case 0x8B9F: return [[ff.arrays.point_size.buffer], "i"];
        case 0x8074: return [[+ff.arrays.vertex.enabled], "b"];
        case 0x8075: return [[+ff.arrays.normal.enabled], "b"];
        case 0x8076: return [[+ff.arrays.color.enabled], "b"];
        case 0x8078: return [[+tex.enabled], "b"];
        case 0x8B9C: return [[+ff.arrays.point_size.enabled], "b"];
        case 0x0DE1: return [[+ff.texture_enabled[unit][0x0DE1]], "b"];
        case 0x8D65: return [[+ff.texture_enabled[unit][0x8D65]], "b"];
    }
    return null;
}
