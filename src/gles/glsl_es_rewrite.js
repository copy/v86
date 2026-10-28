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
//   count as a built-in's stay: 3.00 refuses the shader).

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
    // each name followed by "(": its argument count, and whether it is at file scope
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
            if(x === "(" || x === "[") level++;
            else if(x === ")" || x === "]") { if(--level === 0) break; }
            else if(level === 1 && x === ",") count++;
            else if(level === 1 && x !== "void") empty = false;
        }
        uses.push({ token: t, arity: empty ? 0 : count + 1, file_scope: depth === 0 });
    }
    const own = new Map();
    for(const u of uses) if(u.file_scope) own.set(u.token.text, (own.get(u.token.text) || new Set()).add(u.arity));
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

    let text = tokens.map(t => t.text).join("");
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
