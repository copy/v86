// A shader's source as glslang's SPIR-V pass takes it (docs/gles3-plan.md,
// "着色器的数据流"): the check pass has already judged the source at its own
// version, so this only rewrites what Vulkan's relaxed rules read
// differently, token by token (comments and line breaks kept):
// - GLSL ES 1.00 becomes 3.00 es: attribute and varying, gl_FragColor and
//   gl_FragData as outputs, the 1.00 texture functions and their extensions'
//   (texture2D, texture2DLodEXT, shadow2DEXT, ...) as texture(),
//   textureLod(), ...; gl_FragDepthEXT as gl_FragDepth; samplerExternalOES
//   as sampler2D (the host's external images are 2D textures);
//   gl_MaxVaryingVectors, which 3.00 lacks, as its number; the #extension
//   lines go (what they enabled is 3.00's own);
// - at any version samplerExternalOES is sampler2D and its extensions'
//   #extension lines go;
// - user names that are keywords or built-in functions there (3.00's to a
//   1.00 shader; Vulkan GLSL's separate texture and sampler types to any)
//   get a suffix: `renames` maps the new names back to GL's;
// - a 1.00 shader's overloads of built-in functions (1.00 has them, 3.00
//   refuses them): the uses of the name with as many arguments as one of
//   the user's and none of the built-in's get a suffix (those of the same
//   count as a built-in's stay: 3.00 refuses the shader);
// - a fragment shader's gl_SamplePosition and interpolateAtCentroid,
//   interpolateAtSample and interpolateAtOffset (GLSL ES 3.20's, OES_sample_variables'
//   and OES_shader_multisample_interpolation's), which naga cannot read:
//   functions of gl_SampleID, the samples' standard positions (the sample
//   count specialization constant 71, the page's: 4, or 1 with a position of
//   0.5) and derivatives (an offset's value as the interpolant's plane at
//   the fragment's center gives it);
// - a fragment shader's gl_HelperInvocation (GLSL ES 3.20's), which naga
//   cannot read: false (a helper invocation writes nothing; what differs is
//   a derivative of a value that depends on it);
// - a fragment shader that declares advanced blend equations' support
//   (layout(blend_support_*) out;, GLES 3.2's KHR_blend_equation_advanced):
//   its color output a variable, blended in the shader with the draw's
//   destination (the sampler _v86_dst, a copy the page makes) by the
//   equation of specialization constant 72, the page's; the page's
//   pipeline does not blend.

/** 1.00's texture functions (and extensions') as 3.00's */
const TEXTURE_FUNCTIONS = new Map([
    ["texture2D", "texture"], ["texture2DProj", "textureProj"], ["texture2DLod", "textureLod"],
    ["texture2DProjLod", "textureProjLod"], ["textureCube", "texture"], ["textureCubeLod", "textureLod"],
    ["texture2DLodEXT", "textureLod"], ["texture2DProjLodEXT", "textureProjLod"], ["textureCubeLodEXT", "textureLod"],
    ["texture2DGradEXT", "textureGrad"], ["texture2DProjGradEXT", "textureProjGrad"], ["textureCubeGradEXT", "textureGrad"],
    ["shadow2DEXT", "texture"], ["shadow2DProjEXT", "textureProj"],
    ["texture3D", "texture"], ["texture3DProj", "textureProj"], ["texture3DLod", "textureLod"], ["texture3DProjLod", "textureProjLod"],
]);

/** Names 3.00 has and 1.00 does not: in a 1.00 shader they are the user's (1.00's in, out and inout qualify parameters) */
const ES300_NAMES = new Set((
    "flat smooth centroid layout uint uvec2 uvec3 uvec4 switch case default " +
    "mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 " +
    "sampler3D samplerCubeShadow sampler2DArray sampler2DArrayShadow isampler2D isampler3D isamplerCube " +
    "isampler2DArray usampler2D usampler3D usamplerCube usampler2DArray " +
    "sinh cosh tanh asinh acosh atanh trunc round roundEven isnan isinf floatBitsToInt floatBitsToUint " +
    "intBitsToFloat uintBitsToFloat packSnorm2x16 unpackSnorm2x16 packUnorm2x16 unpackUnorm2x16 " +
    "packHalf2x16 unpackHalf2x16 outerProduct transpose determinant inverse " +
    "texture textureProj textureLod textureOffset texelFetch texelFetchOffset textureProjOffset " +
    "textureLodOffset textureProjLod textureProjLodOffset textureGrad textureGradOffset textureProjGrad " +
    "textureProjGradOffset textureSize"
).split(" "));

/** Vulkan GLSL's keywords that OpenGL ES's GLSL leaves to the user */
const VULKAN_NAMES = new Set((
    "texture1D texture2D texture3D textureCube texture2DRect texture1DArray texture2DArray textureBuffer " +
    "texture2DMS texture2DMSArray textureCubeArray itexture1D itexture2D itexture3D itextureCube itexture2DRect " +
    "itexture1DArray itexture2DArray itextureBuffer itexture2DMS itexture2DMSArray itextureCubeArray " +
    "utexture1D utexture2D utexture3D utextureCube utexture2DRect utexture1DArray utexture2DArray utextureBuffer " +
    "utexture2DMS utexture2DMSArray utextureCubeArray sampler samplerShadow subpassInput subpassInputMS " +
    "isubpassInput isubpassInputMS usubpassInput usubpassInputMS attachmentEXT iattachmentEXT uattachmentEXT"
).split(" "));

const SUFFIX = "_v86";

/** The specialization constant of the draw's sample count (gles3_executor.js's pipeline3) */
export const SAMPLES_CONSTANT = 71;
/** The specialization constant of the draw's advanced blend equation (its index in ADVANCED_BLEND), and its destination's sampler */
export const BLEND_CONSTANT = 72;
export const BLEND_DESTINATION = "_v86_dst";
/** KHR_blend_equation_advanced's equations: the enums, the layout qualifiers' names */
export const ADVANCED_BLEND = [[0x9294, "multiply"], [0x9295, "screen"], [0x9296, "overlay"], [0x9297, "darken"], [0x9298, "lighten"],
    [0x9299, "colordodge"], [0x929A, "colorburn"], [0x929B, "hardlight"], [0x929C, "softlight"], [0x929E, "difference"], [0x92A0, "exclusion"],
    [0x92AD, "hsl_hue"], [0x92AE, "hsl_saturation"], [0x92AF, "hsl_color"], [0x92B0, "hsl_luminosity"]];

/** The equations a fragment shader's layout(blend_support_*) out; qualifiers declare (their enums) */
export function blend_support(source)
{
    const equations = new Set();
    for(const m of source.matchAll(/\blayout\s*\(([^)]*)\)\s*out\s*;/g))
    {
        for(const name of m[1].matchAll(/\bblend_support_(\w+)/g))
        {
            for(const [e, n] of ADVANCED_BLEND) if(name[1] === n || name[1] === "all_equations") equations.add(e);
        }
    }
    return [...equations];
}

/** KHR_blend_equation_advanced's equations (its section 3.8.x) in GLSL: f(), the HSL functions, the coverage terms */
const BLEND_FUNCTIONS = `
uniform highp sampler2D ${BLEND_DESTINATION};
layout(constant_id = ${BLEND_CONSTANT}) const int _v86_equation = 0;
highp float _v86_lum(highp vec3 c) { return dot(c, vec3(0.30, 0.59, 0.11)); }
highp vec3 _v86_clip(highp vec3 c) {
    highp float l = _v86_lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
    if (n < 0.0) c = l + ((c - l) * l) / (l - n);
    if (x > 1.0) c = l + ((c - l) * (1.0 - l)) / (x - l);
    return c;
}
highp vec3 _v86_setlum(highp vec3 base, highp vec3 lum) { return _v86_clip(base + (_v86_lum(lum) - _v86_lum(base))); }
highp float _v86_sat(highp vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
highp vec3 _v86_setsatlum(highp vec3 base, highp vec3 sat, highp vec3 lum) {
    highp float s = _v86_sat(base);
    highp vec3 c = s > 0.0 ? (base - min(min(base.r, base.g), base.b)) * _v86_sat(sat) / s : vec3(0.0);
    return _v86_setlum(c, lum);
}
highp float _v86_f(int e, highp float s, highp float d) {
    if (e == 0) return s * d;
    if (e == 1) return s + d - s * d;
    if (e == 2) return d <= 0.5 ? 2.0 * s * d : 1.0 - 2.0 * (1.0 - s) * (1.0 - d);
    if (e == 3) return min(s, d);
    if (e == 4) return max(s, d);
    if (e == 5) return d <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, d / (1.0 - s));
    if (e == 6) return d >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - d) / s);
    if (e == 7) return s <= 0.5 ? 2.0 * s * d : 1.0 - 2.0 * (1.0 - s) * (1.0 - d);
    if (e == 8) return s <= 0.5 ? d - (1.0 - 2.0 * s) * d * (1.0 - d) :
        d <= 0.25 ? d + (2.0 * s - 1.0) * d * ((16.0 * d - 12.0) * d + 3.0) : d + (2.0 * s - 1.0) * (sqrt(d) - d);
    if (e == 9) return abs(d - s);
    return s + d - 2.0 * s * d;
}
highp vec4 _v86_blend(highp vec4 src, highp vec4 dst) {
    int e = _v86_equation;
    src = clamp(src, 0.0, 1.0);
    highp vec3 cs = src.a == 0.0 ? vec3(0.0) : src.rgb / src.a, cd = dst.a == 0.0 ? vec3(0.0) : dst.rgb / dst.a;
    highp vec3 f;
    if (e <= 10) f = vec3(_v86_f(e, cs.r, cd.r), _v86_f(e, cs.g, cd.g), _v86_f(e, cs.b, cd.b));
    else if (e == 11) f = _v86_setsatlum(cs, cd, cd);
    else if (e == 12) f = _v86_setsatlum(cd, cs, cd);
    else if (e == 13) f = _v86_setlum(cs, cd);
    else f = _v86_setlum(cd, cs);
    highp float p0 = src.a * dst.a, p1 = src.a * (1.0 - dst.a), p2 = dst.a * (1.0 - src.a);
    return vec4(f * p0 + cs * p1 + cd * p2, p0 + p1 + p2);
}
`;

/**
 * A blend_support fragment shader's tokens rewritten (see above): the
 * qualifier statements gone, the first output declaration's layout and
 * `out` gone (a variable), main renamed; the text to append, or null when
 * it has no output to blend
 */
function rewrite_blend(tokens)
{
    const significant = tokens.map((t, i) => i).filter(i => !["space", "comment", "newline"].includes(tokens[i].kind));
    let brace = 0, paren = 0, start = 0, output = null;
    for(let k = 0; k < significant.length; k++)
    {
        const t = tokens[significant[k]];
        if(t.text === "{") brace++;
        else if(t.text === "}") { if(--brace === 0) start = k + 1; continue; }
        else if(t.text === "(") paren++;
        else if(t.text === ")") paren--;
        if(brace === 0 && paren === 0 && t.kind === "name" && t.text === "main" && tokens[significant[k + 1]] && tokens[significant[k + 1]].text === "(")
        {
            t.text = "_v86_main";
        }
        if(brace !== 0 || paren !== 0 || t.text !== ";") continue;
        const statement = significant.slice(start, k + 1).map(i => tokens[i]);
        start = k + 1;
        const words = statement.map(x => x.text);
        if(!words.includes("out")) continue;
        if(words.some(w => /^blend_support_/.test(w)))
        {
            for(const x of statement) x.text = "";
            continue;
        }
        if(output) continue;
        // (the output: its layout and out gone; its name the last before ; or [)
        const end = words.indexOf("[") >= 0 ? words.indexOf("[") : words.length - 1;
        output = words[end - 1];
        const layout = words.indexOf("layout");
        if(layout >= 0)
        {
            let depth = 0;
            for(let j = layout; j < statement.length; j++)
            {
                const x = statement[j].text;
                statement[j].text = "";
                if(x === "(") depth++;
                else if(x === ")" && --depth === 0) break;
            }
        }
        statement[words.indexOf("out")].text = "";
    }
    if(!output) return null;
    return BLEND_FUNCTIONS + "layout(location = 0) out highp vec4 _v86_color;\n" +
        `void main() { _v86_main(); _v86_color = _v86_blend(${output}, texelFetch(${BLEND_DESTINATION}, ivec2(gl_FragCoord.xy), 0)); }\n`;
}

const SAMPLE_FUNCTIONS = new Set(["gl_SamplePosition", "interpolateAtCentroid", "interpolateAtSample", "interpolateAtOffset"]);

/**
 * GLSL ES 3.10's extended integer functions, whose SPIR-V (OpIAddCarry,
 * OpISubBorrow, OpUMulExtended, OpSMulExtended) naga does not read: calls
 * to these instead, of plain integer arithmetic (the 32 by 32 bit products
 * from 16-bit halves), for each scalar and vector size
 */
const EXTENDED_FUNCTIONS = new Set(["uaddCarry", "usubBorrow", "umulExtended", "imulExtended"]);

function extended_helpers(uses)
{
    let text = "";
    for(const n of ["", "2", "3", "4"])
    {
        const u = n ? "uvec" + n : "uint", i = n ? "ivec" + n : "int";
        const below = (a, b) => n ? `${u}(lessThan(${a}, ${b}))` : `(${a} < ${b} ? 1u : 0u)`;
        if(uses.has("uaddCarry")) text += `highp ${u} _v86_uaddCarry(highp ${u} a, highp ${u} b, out highp ${u} carry) { highp ${u} s = a + b; carry = ${below("s", "a")}; return s; }\n`;
        if(uses.has("usubBorrow")) text += `highp ${u} _v86_usubBorrow(highp ${u} a, highp ${u} b, out highp ${u} borrow) { borrow = ${below("a", "b")}; return a - b; }\n`;
        if(uses.has("umulExtended") || uses.has("imulExtended"))
        {
            text += `void _v86_umulExtended(highp ${u} x, highp ${u} y, out highp ${u} msb, out highp ${u} lsb) { ` +
                `highp ${u} xl = x & 0xFFFFu, xh = x >> 16u, yl = y & 0xFFFFu, yh = y >> 16u; ` +
                `highp ${u} ll = xl * yl, lh = xl * yh, hl = xh * yl; ` +
                `highp ${u} mid = (ll >> 16u) + (lh & 0xFFFFu) + (hl & 0xFFFFu); ` +
                `msb = xh * yh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u); lsb = x * y; }\n`;
        }
        if(uses.has("imulExtended"))
        {
            // (the signed product's high word: the unsigned one's less each negative operand's other)
            const negative = (a, b) => n ? `${u}(lessThan(${a}, ${i}(0))) * ${u}(${b})` : `(${a} < 0 ? ${u}(${b}) : 0u)`;
            text += `void _v86_imulExtended(highp ${i} x, highp ${i} y, out highp ${i} msb, out highp ${i} lsb) { highp ${u} m, l; ` +
                `_v86_umulExtended(${u}(x), ${u}(y), m, l); m -= ${negative("x", "y")} + ${negative("y", "x")}; msb = ${i}(m); lsb = ${i}(l); }\n`;
        }
    }
    return text;
}

/** The functions that stand in for the sample functions `uses` names */
function sample_helpers(uses)
{
    let text = "";
    if(uses.has("gl_SamplePosition") || uses.has("interpolateAtSample"))
    {
        text += `layout(constant_id = ${SAMPLES_CONSTANT}) const int _v86_samples = 4;\n` +
            // (the constant through a variable: a comparison of it would be an OpSpecConstantOp, which naga cannot read)
            "highp vec2 _v86_sample_offset(int i) { int n = _v86_samples; return n == 1 ? vec2(0.0) : (i == 0 ? vec2(0.375, 0.125) : i == 1 ? vec2(0.875, 0.375) : " +
            "i == 2 ? vec2(0.125, 0.625) : vec2(0.625, 0.875)) - 0.5; }\n";
    }
    if(uses.has("gl_SamplePosition")) text += "highp vec2 _v86_SamplePosition() { return _v86_sample_offset(gl_SampleID) + 0.5; }\n";
    for(const type of ["float", "vec2", "vec3", "vec4"])
    {
        if(uses.has("interpolateAtCentroid")) text += `highp ${type} _v86_interpolateAtCentroid(highp ${type} x) { return x; }\n`;
        if(uses.has("interpolateAtOffset") || uses.has("interpolateAtSample"))
        {
            text += `highp ${type} _v86_interpolateAtOffset(highp ${type} x, highp vec2 o) { return x + dFdx(x) * o.x + dFdy(x) * o.y; }\n`;
        }
        if(uses.has("interpolateAtSample")) text += `highp ${type} _v86_interpolateAtSample(highp ${type} x, int i) { return _v86_interpolateAtOffset(x, _v86_sample_offset(i)); }\n`;
    }
    return text;
}

/** GLSL ES 1.00's built-in functions: their argument counts */
const BUILTINS_100 = new Map(Object.entries({
    radians: [1], degrees: [1], sin: [1], cos: [1], tan: [1], asin: [1], acos: [1], atan: [1, 2], pow: [2], exp: [1], log: [1], exp2: [1],
    log2: [1], sqrt: [1], inversesqrt: [1], abs: [1], sign: [1], floor: [1], ceil: [1], fract: [1], mod: [2], min: [2], max: [2], clamp: [3],
    mix: [3], step: [2], smoothstep: [3], length: [1], distance: [2], dot: [2], cross: [2], normalize: [1], faceforward: [3], reflect: [2],
    refract: [3], matrixCompMult: [2], lessThan: [2], lessThanEqual: [2], greaterThan: [2], greaterThanEqual: [2], equal: [2], notEqual: [2],
    any: [1], all: [1], not: [1], dFdx: [1], dFdy: [1], fwidth: [1],
}));

/**
 * The tokens that name a 1.00 shader's own overloads of built-in functions
 * (a function of a built-in's name declared outside any function), marked
 * `overload`: those followed by an argument list of a count the user's
 * declarations have and the built-in has not
 */
function mark_overloads(tokens)
{
    const significant = tokens.map((t, i) => i).filter(i => !["space", "comment", "newline"].includes(tokens[i].kind));
    // each name followed by "(": its argument count, and whether it is a declaration (at file scope, after its
    // return type: a call in a global's initializer is at file scope too, after an operator, "=", "(" or ",")
    const uses = [];
    let depth = 0;
    for(let k = 0; k < significant.length; k++)
    {
        const t = tokens[significant[k]];
        if(t.text === "{") depth++;
        else if(t.text === "}") depth--;
        if(t.kind !== "name" || !BUILTINS_100.has(t.text) || !tokens[significant[k + 1]] || tokens[significant[k + 1]].text !== "(") continue;
        let level = 0, count = 0, empty = true;
        for(let j = k + 1; j < significant.length; j++)
        {
            const x = tokens[significant[j]].text;
            // (anything inside the list but a lone `void` is an argument: `log2((x))` has one)
            if(level >= 1 && x !== ")" && !(level === 1 && x === "void")) empty = false;
            if(x === "(" || x === "[") level++;
            else if(x === ")" || x === "]") { if(--level === 0) break; }
            else if(level === 1 && x === ",") count++;
        }
        const before = k > 0 ? tokens[significant[k - 1]] : null;
        uses.push({ token: t, arity: empty ? 0 : count + 1, declaration: depth === 0 && !!before && before.kind === "name" });
    }
    const own = new Map();
    for(const u of uses) if(u.declaration) own.set(u.token.text, (own.get(u.token.text) || new Set()).add(u.arity));
    for(const u of uses)
    {
        const arities = own.get(u.token.text);
        if(arities && arities.has(u.arity) && !BUILTINS_100.get(u.token.text).includes(u.arity)) u.token.overload = true;
    }
}

/**
 * The source's tokens: identifiers, numbers and everything else, comments
 * and white space kept as they are
 * @param {string} source
 * @return {!Array<{kind: string, text: string, line: number}>}
 */
function tokenize(source)
{
    const tokens = [];
    let line = 1;
    const pattern = /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|([A-Za-z_][A-Za-z0-9_]*)|(\d+\.?\d*(?:[eE][+-]?\d+)?[uUfF]?|\.\d+(?:[eE][+-]?\d+)?[fF]?)|(\n)|([ \t\r\f\v]+)|([\s\S])/g;
    for(let m; (m = pattern.exec(source));)
    {
        const kind = m[1] || m[2] ? "comment" : m[3] ? "name" : m[4] ? "number" : m[5] ? "newline" : m[6] ? "space" : "punct";
        tokens.push({ kind, text: m[0], line });
        line += (m[0].match(/\n/g) || []).length;
    }
    return tokens;
}

/**
 * A GLSL ES 3.x source whose shared and packed interface blocks are std140
 * (uniform blocks) or std430 (buffer blocks), the default layouts too:
 * GLSL ES lets an implementation choose those layouts, glslang's reflection
 * packs them as std430 while the page reads uniform blocks as std140; the
 * offsets, strides and the code then agree. Each block's packing is written
 * on the block (glslang's reflection packs arrays in a block's structs as
 * std430 where a default statement gave the block std140); the defaults go
 * after the #version and #extension lines.
 * @param {string} source
 * @param {boolean=} buffers false: buffer blocks' packings as they are
 *     (glslang's reflection packs shared and packed ones as std430 and, as
 *     GL, keeps a shared one nothing uses)
 * @return {string}
 */
export function std_blocks(source, buffers = true)
{
    const version = glsl_version(source);
    if(version < 300) return source;
    const tokens = tokenize(source);
    const significant = tokens.map((t, i) => i).filter(i => !["space", "comment", "newline"].includes(tokens[i].kind));
    const at_k = k => tokens[significant[k]] || { text: "", kind: "" };
    const QUALIFIERS = new Set(["readonly", "writeonly", "coherent", "volatile", "restrict", "highp", "mediump", "lowp"]);
    const PACKINGS = new Set(["shared", "packed", "std140", "std430"]);
    const packing_of = (storage, packing) => storage === "uniform" ? (packing === "std430" ? packing : "std140") :
        buffers && (packing === "shared" || packing === "packed") ? "std430" : packing;
    const defaults = { uniform: "shared", buffer: "shared" };
    for(let k = 0; k < significant.length; k++)
    {
        // (a declaration of uniform or buffer storage: its layout, qualifiers, the storage, then ";" for a default, a block's name and "{")
        let open = -1, close = -1, storage_at = k;
        if(at_k(k).text === "layout" && at_k(k + 1).text === "(")
        {
            open = k + 1;
            close = open;
            while(close < significant.length && at_k(close).text !== ")") close++;
            storage_at = close + 1;
        }
        else if(at_k(k).text !== "uniform" && at_k(k).text !== "buffer") continue;
        while(storage_at < significant.length && QUALIFIERS.has(at_k(storage_at).text)) storage_at++;
        const storage = at_k(storage_at).text;
        if(storage !== "uniform" && storage !== "buffer") continue;
        let given = null;
        for(let j = open + 1; open >= 0 && j < close; j++) if(at_k(j).kind === "name" && PACKINGS.has(at_k(j).text)) given = at_k(j);
        const block = at_k(storage_at + 1).kind === "name" && at_k(storage_at + 2).text === "{";
        if(at_k(storage_at + 1).text === ";" && given) defaults[storage] = given.text;
        if(given) given.text = packing_of(storage, given.text);
        else if(block && open >= 0) at_k(open).text = "(" + packing_of(storage, defaults[storage]) + ", ";
        else if(block) at_k(storage_at).text = "layout(" + packing_of(storage, defaults[storage]) + ") " + storage;
        k = storage_at;
    }
    // (after the last #version or #extension line)
    let end = 0, at_line_start = true;
    for(let i = 0; i < tokens.length; i++)
    {
        const t = tokens[i];
        if(t.kind === "newline") { at_line_start = true; continue; }
        if(t.kind === "space" || t.kind === "comment") continue;
        if(at_line_start && t.text === "#")
        {
            const name = tokens.slice(i + 1).find(x => x.kind !== "space");
            let j = i;
            while(j < tokens.length && tokens[j].kind !== "newline") j++;
            if(name && (name.text === "version" || name.text === "extension")) end = j + 1;
            i = j - 1;
            continue;
        }
        at_line_start = false;
    }
    const before = tokens.slice(0, end).map(t => t.text).join(""), rest = tokens.slice(end).map(t => t.text).join("");
    const statements = "layout(std140) uniform;\n" + (version >= 310 && buffers ? "layout(std430) buffer;\n" : "");
    return before + (before && !before.endsWith("\n") ? "\n" : "") + statements + rest;
}

/**
 * Each interface block's packing as its source gives it (std_blocks makes
 * shared and packed std140, so a link compares them first): the layout's
 * shared, packed, std140 or std430, else the default a `layout(...)
 * uniform;` statement before it set, else shared
 * @param {string} source
 * @return {!Map<string, string>} by "uniform:Name" or "buffer:Name"
 */
export function block_packings(source)
{
    const packings = new Map();
    if(glsl_version(source) < 300) return packings;
    const tokens = tokenize(source).filter(t => !["space", "comment", "newline"].includes(t.kind));
    const PACKINGS = new Set(["shared", "packed", "std140", "std430"]);
    const QUALIFIERS = new Set(["readonly", "writeonly", "coherent", "volatile", "restrict", "highp", "mediump", "lowp"]);
    const defaults = { uniform: "shared", buffer: "shared" };
    for(let k = 0; k < tokens.length; k++)
    {
        let packing = null, at = k;
        if(tokens[k].text === "layout" && tokens[k + 1] && tokens[k + 1].text === "(")
        {
            at = k + 2;
            while(at < tokens.length && tokens[at].text !== ")") { if(PACKINGS.has(tokens[at].text)) packing = tokens[at].text; at++; }
            at++;
        }
        else if(tokens[k].text !== "uniform" && tokens[k].text !== "buffer") continue;
        while(at < tokens.length && QUALIFIERS.has(tokens[at].text)) at++;
        const storage = tokens[at] && tokens[at].text;
        if(storage !== "uniform" && storage !== "buffer") { k = at - 1; continue; }
        const next = tokens[at + 1];
        if(next && next.text === ";") { if(packing) defaults[storage] = packing; }
        else if(next && next.kind === "name" && tokens[at + 2] && tokens[at + 2].text === "{") packings.set(storage + ":" + next.text, packing || defaults[storage]);
        k = at;
    }
    return packings;
}

/** GLSL ES 3.x's reserved words glslang takes as names (3.00 3.7) */
const RESERVED_300 = new Set(["image1DShadow", "image2DShadow", "image1DArrayShadow", "image2DArrayShadow"]);

/** A reserved word of GLSL ES 3.x the source uses (one glslang takes), or null */
export function reserved_word(source)
{
    const t = tokenize(source).find(t => t.kind === "name" && RESERVED_300.has(t.text));
    return t ? t.text : null;
}

/**
 * Whether an #extension directive comes after a token that is not the
 * preprocessor's, which GLSL ES (3.00 3.4, 1.00 3.4) refuses and glslang
 * takes
 * @param {string} source
 */
export function extension_after_code(source)
{
    let code = false, line_start = true;
    const tokens = tokenize(source);
    for(let i = 0; i < tokens.length; i++)
    {
        const t = tokens[i];
        if(t.kind === "newline") { line_start = true; continue; }
        if(t.kind === "space" || t.kind === "comment") continue;
        if(line_start && t.text === "#")
        {
            let j = i + 1;
            while(j < tokens.length && tokens[j].kind === "space") j++;
            if(code && tokens[j] && tokens[j].text === "extension") return true;
            while(i < tokens.length && tokens[i].kind !== "newline") i++;
            i--;
            line_start = false;
            continue;
        }
        line_start = false;
        code = true;
    }
    return false;
}

/**
 * The rules of GLSL ES 3.x glslang's relaxed check lets through (an
 * #extension after the code, the reserved image shadow types): the error
 * a compile gives, or null
 * @param {string} source
 */
export function es3_rules(source)
{
    if(glsl_version(source) < 300) return null;
    if(extension_after_code(source)) return "ERROR: '#extension' : must occur before any non-preprocessor tokens\n";
    const reserved = reserved_word(source);
    return reserved ? "ERROR: '" + reserved + "' : Reserved word.\n" : null;
}

/** @return {number} the shader's #version (100 when it has none) */
export function glsl_version(source)
{
    const m = /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*#\s*version\s+(\d+)/.exec(source);
    return m ? +m[1] : 100;
}

/**
 * @param {string} source a shader the check pass compiled
 * @param {string} stage "vertex", "fragment", "compute", ...
 * @param {{maxVaryingVectors: number, maxDrawBuffers: number}} limits
 * @return {{source: string, renames: !Map<string, string>, version: number}}
 *     renames: the new names, by GL's
 */
export function rewrite_for_spirv(source, stage, limits)
{
    const version = glsl_version(source);
    const es100 = version === 100;
    const tokens = tokenize(source);
    const renames = new Map();
    const rename = name =>
    {
        const renamed = name + SUFFIX;
        renames.set(name, renamed);
        return renamed;
    };
    let frag_color = false, frag_data = false, at_line_start = true;
    let version_line_end = -1;
    // (where the sample functions' helpers go: after the #version and #extension lines)
    let directives_end = -1;
    const sample_uses = new Set();
    const extended_uses = new Set();
    if(es100) mark_overloads(tokens);
    for(let i = 0; i < tokens.length; i++)
    {
        const t = tokens[i];
        if(t.kind === "newline") { at_line_start = true; continue; }
        if(t.kind === "space" || t.kind === "comment") continue;
        if(at_line_start && t.text === "#")
        {
            // a directive: #version and #extension rewritten, the rest as they are
            let j = i + 1;
            while(j < tokens.length && tokens[j].kind === "space") j++;
            const directive = tokens[j] && tokens[j].text;
            let end = j;
            while(end < tokens.length && tokens[end].kind !== "newline") end++;
            if(directive === "version" || directive === "extension") directives_end = end;
            if(directive === "version")
            {
                if(es100) for(let k = i; k < end; k++) tokens[k].text = k === i ? "#version 300 es" : "";
                version_line_end = end;
            }
            else if(directive === "extension" && (es100 || tokens.slice(j, end).some(t => /^GL_OES_EGL_image_external/.test(t.text))))
            {
                for(let k = i; k < end; k++) tokens[k].text = "";
            }
            else
            {
                // (#define and #if lines name the user's identifiers too)
                for(let k = j + 1; k < end; k++) if(tokens[k].kind === "name") rename_token(tokens[k]);
            }
            i = end - 1;
            at_line_start = false;
            continue;
        }
        at_line_start = false;
        if(t.kind === "name" && t.text === "invariant" && es100 && stage === "fragment")
        {
            // invariance of a fragment shader's inputs: 1.00 has it, 3.00
            // refuses it, and it changes nothing; `invariant varying` loses
            // the qualifier, `invariant name;` the statement
            const next = tokens.slice(i + 1).find(n => n.kind !== "space" && n.kind !== "comment" && n.kind !== "newline");
            if(next && next.text === "varying") { t.text = ""; continue; }
            if(next && next.kind === "name" && !/^gl_Frag/.test(next.text))
            {
                let j = i;
                while(j < tokens.length && tokens[j].text !== ";") tokens[j++].text = "";
                if(j < tokens.length) tokens[j].text = "";
                i = j;
                continue;
            }
        }
        if(t.kind === "name") rename_token(t);
    }

    function rename_token(t)
    {
        const name = t.text;
        if(VULKAN_NAMES.has(name) && !(es100 && TEXTURE_FUNCTIONS.has(name)))
        {
            t.text = rename(name);
            return;
        }
        if(name === "samplerExternalOES") t.text = "sampler2D";
        if(!es100 && EXTENDED_FUNCTIONS.has(name))
        {
            extended_uses.add(name);
            t.text = "_v86_" + name;
            return;
        }
        if(stage === "fragment" && name === "gl_HelperInvocation")
        {
            t.text = "false";
            return;
        }
        if(stage === "fragment" && !es100 && SAMPLE_FUNCTIONS.has(name))
        {
            sample_uses.add(name);
            t.text = name === "gl_SamplePosition" ? "_v86_SamplePosition()" : "_v86_" + name;
            return;
        }
        if(!es100) return;
        if(t.overload) t.text = rename(name);
        else if(TEXTURE_FUNCTIONS.has(name)) t.text = TEXTURE_FUNCTIONS.get(name);
        else if(ES300_NAMES.has(name)) t.text = rename(name);
        else if(name === "attribute") t.text = "in";
        else if(name === "varying") t.text = stage === "vertex" ? "out" : "in";
        else if(name === "gl_FragColor") { t.text = "_v86_FragColor"; frag_color = true; }
        else if(name === "gl_FragData") { t.text = "_v86_FragData"; frag_data = true; }
        else if(name === "gl_FragDepthEXT") t.text = "gl_FragDepth";
        else if(name === "gl_MaxVaryingVectors") t.text = String(limits.maxVaryingVectors);
    }

    const blend = stage === "fragment" && !es100 && tokens.some(t => t.kind === "name" && /^blend_support_/.test(t.text)) ? rewrite_blend(tokens) : null;
    let text = tokens.map(t => t.text).join("");
    if(blend) text += "\n" + blend;
    // (glslang's relaxed rules write atomicCounterDecrement(c) as atomicAdd(c, -1) - 1, a uint minus an int: GLSL ES
    // refuses it without the implicit conversions, which change nothing the check pass accepted)
    const conversions = version >= 310 && tokens.some(t => t.kind === "name" && t.text === "atomicCounterDecrement") ?
        "#extension GL_EXT_shader_implicit_conversions : enable\n" : "";
    if((sample_uses.size || extended_uses.size || conversions) && directives_end >= 0)
    {
        const at = tokens.slice(0, directives_end).reduce((n, t) => n + t.text.length, 0);
        text = text.slice(0, at) + "\n" + conversions + sample_helpers(sample_uses) + extended_helpers(extended_uses) + text.slice(at);
    }
    if(es100)
    {
        const outputs = (frag_color ? "layout(location = 0) out mediump vec4 _v86_FragColor; " : "") +
            (frag_data ? "layout(location = 0) out mediump vec4 _v86_FragData[" + limits.maxDrawBuffers + "]; " : "");
        if(version_line_end < 0)
        {
            text = "#version 300 es\n" + (outputs ? outputs + "\n" : "") + text;
        }
        else if(outputs)
        {
            // after the #version line
            const end = tokens.slice(0, version_line_end).reduce((n, t) => n + t.text.length, 0);
            text = text.slice(0, end) + "\n" + outputs + text.slice(end);
        }
    }
    return { source: text, renames, version };
}
