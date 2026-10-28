#!/usr/bin/env node
// Validates that gl_shader_translator.js emits WGSL a real compiler accepts.
//
// gl_shader_translator_test.js asserts on translation structure and would
// happily pass on WGSL no driver can compile. This file closes that gap by
// running the generated source through `naga`, the WGSL front end wgpu and
// Firefox use, which performs the same shape of validation Tint does inside
// createShaderModule(). Running it here means a syntax or type error surfaces
// in Node in a second instead of as a black screen inside v86.
//
// The corpus is Cube 2's own shaders, because they are the acceptance target
// for M4 and because a generator-written shader exercises paths no hand-written
// fixture would think to.
//
// naga is optional: install it with
//     cargo install naga-cli
// and either put it on PATH or point GL_NAGA at the binary. Without it this
// test skips (exit 0) rather than blocking a machine that only wants the pure
// JavaScript suites.

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const t = require("../../src/browser/glbridge/gl-webgpu/gl_shader_translator.js");

function findNaga() {
    if (process.env.GL_NAGA) return process.env.GL_NAGA;
    if (spawnSync("naga", ["--version"], { encoding: "utf8" }).status === 0)
        return "naga";
    const cargo = path.join(os.homedir(), ".cargo", "bin", "naga");
    return fs.existsSync(cargo) ? cargo : null;
}

const naga = findNaga();
if (!naga) {
    console.log("SKIP: no `naga` binary (install with `cargo install naga-cli` " +
        "or set GL_NAGA) -- WGSL validation not run");
    process.exit(0);
}

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "glwg-wgsl-"));
let passed = 0;
const failures = [];

function validate(label, wgsl) {
    const file = path.join(outputDir, label.replace(/[^A-Za-z0-9_.-]/g, "_") + ".wgsl");
    fs.writeFileSync(file, wgsl);
    try {
        execFileSync(naga, [file], { stdio: "pipe" });
        return null;
    } catch (error) {
        return String(error.stderr || error.stdout || error);
    }
}

function checkProgram(label, vsSource, fsSource, options) {
    const vs = t.compileShader(vsSource, "vertex", {});
    const fs2 = t.compileShader(fsSource, "fragment", {});
    if (!vs.ok || !fs2.ok) {
        failures.push([label, (vs.ok ? "" : "vertex: " + vs.log) +
            (fs2.ok ? "" : " fragment: " + fs2.log)]);
        return;
    }
    const program = t.linkProgram(vs, fs2, options || {});
    if (!program.ok) { failures.push([label, "link: " + program.log]); return; }
    const vertexError = validate(label + ".vert", program.wgslVertex);
    const fragmentError = validate(label + ".frag", program.wgslFragment);
    if (vertexError || fragmentError)
        failures.push([label, (vertexError || "") + (fragmentError || "")]);
    else ++passed;
}

/* ---- Cube 2's own shaders ---- */

require("./cube2_glsl_direct_corpus_r6889.js");
const corpus = globalThis.CUBE2_DIRECT_GLSL_CORPUS_R6889;
assert.ok(corpus && corpus.length, "the Cube 2 corpus is present");
for (const entry of corpus)
    checkProgram("cube2_" + entry.name, entry.vertex, entry.fragment);

// Cube 2 rewrites skyfog's //:variantoverride directive after showing the
// "Shader: skyfog" loading message, then compiles the rewritten source as a
// second program.  Keep that runtime-only source in the real WGSL compiler
// corpus as well; the direct cfg extraction above contains only the base text.
const skyfog = corpus.find(entry => entry.name === "skyfog");
assert.ok(skyfog, "the Cube 2 corpus contains skyfog");
const skyfogVariantLines = skyfog.fragment.split("\n");
const skyfogVariantLine = skyfogVariantLines.findIndex(line =>
    line.indexOf("//:variantoverride") >= 0);
assert.ok(skyfogVariantLine >= 0 && skyfogVariantLine + 1 < skyfogVariantLines.length,
    "skyfog contains the generic variant directive and overridden line");
skyfogVariantLines[skyfogVariantLine] = skyfogVariantLines[skyfogVariantLine]
    .replace("//:variantoverride", " ".repeat("//:variantoverride".length));
skyfogVariantLines[skyfogVariantLine + 1] =
    " ".repeat(skyfogVariantLines[skyfogVariantLine + 1].length);
checkProgram("cube2_skyfog_generic_variant", skyfog.vertex,
    skyfogVariantLines.join("\n"));
const corpusFailures = failures.length;

/* ---- the compatibility surface, which the corpus barely touches ---- */

checkProgram("compat_fixed_state",
    "varying vec4 lit;\n" +
    "void main(void) {\n" +
    "  vec3 n = normalize(gl_NormalMatrix * gl_Normal);\n" +
    "  vec3 eye = (gl_ModelViewMatrix * gl_Vertex).xyz;\n" +
    "  vec4 c = gl_FrontLightModelProduct.sceneColor;\n" +
    "  for (int i = 0; i < 4; i++) {\n" +
    "    vec3 vp = normalize(gl_LightSource[i].position.xyz - eye);\n" +
    "    float att = 1.0 / (gl_LightSource[i].constantAttenuation +\n" +
    "                       gl_LightSource[i].linearAttenuation);\n" +
    "    c += att * max(dot(n, vp), 0.0) * gl_FrontLightProduct[i].diffuse;\n" +
    "    c += pow(max(dot(n, gl_LightSource[i].halfVector.xyz), 0.0),\n" +
    "             gl_FrontMaterial.shininess) * gl_FrontLightProduct[i].specular;\n" +
    "  }\n" +
    "  lit = c;\n" +
    "  gl_TexCoord[0] = gl_TextureMatrix[0] * gl_MultiTexCoord0;\n" +
    "  gl_FogFragCoord = abs(eye.z);\n" +
    "  gl_Position = ftransform();\n}",
    "varying vec4 lit;\n" +
    "void main(void) {\n" +
    "  float f = clamp((gl_Fog.end - gl_FogFragCoord) * gl_Fog.scale, 0.0, 1.0);\n" +
    "  gl_FragColor = mix(gl_Fog.color, lit * gl_TexCoord[0], f);\n}");

checkProgram("compat_shadow_and_cube",
    "varying vec4 shadowcoord;\nvarying vec3 dir;\n" +
    "void main(void) {\n" +
    "  shadowcoord = gl_TextureMatrix[1] * gl_Vertex;\n" +
    "  dir = gl_Normal;\n" +
    "  gl_Position = ftransform();\n}",
    "uniform sampler2DShadow shadowmap;\nuniform samplerCube env;\n" +
    "varying vec4 shadowcoord;\nvarying vec3 dir;\n" +
    "void main(void) {\n" +
    "  float lit = shadow2DProj(shadowmap, shadowcoord).r;\n" +
    "  gl_FragColor = textureCube(env, dir) * lit;\n}");

checkProgram("structs_and_out_params",
    "attribute vec4 pos;\nvoid main(void) { gl_Position = pos; }",
    "struct Light { vec3 color; float power; };\n" +
    "uniform Light lights[2];\n" +
    "uniform float gamma;\n" +
    "void apply(Light l, inout vec3 acc) { acc += l.color * l.power; }\n" +
    "void main(void) {\n" +
    "  vec3 acc = vec3(0.0);\n" +
    "  apply(lights[0], acc);\n" +
    "  apply(lights[1], acc);\n" +
    "  gl_FragColor = vec4(pow(acc, vec3(gamma)), 1.0);\n}");

checkProgram("control_flow_and_conversions",
    "attribute vec4 pos;\nvarying float k;\n" +
    "void main(void) {\n" +
    "  k = 0.0;\n" +
    "  for (int i = 0; i < 8; i++) { k += float(i) * 0.5; }\n" +
    "  int j = 0;\n" +
    "  while (j < 3) { k = k * 2.0; j++; }\n" +
    "  do { k -= 1.0; } while (k > 100.0);\n" +
    "  gl_Position = pos * (k > 0.0 ? 1.0 : -1.0);\n}",
    "varying float k;\nuniform bool invert;\nuniform int mode;\n" +
    "void main(void) {\n" +
    "  vec4 c = vec4(k);\n" +
    "  if (invert) { c = 1.0 - c; }\n" +
    "  if (mode == 2) { discard; }\n" +
    "  gl_FragColor = c;\n}");

checkProgram("non_uniform_sampling",
    "attribute vec4 pos;\nvarying vec2 tc;\n" +
    "void main(void) { tc = pos.xy; gl_Position = pos; }",
    "uniform sampler2D tex;\nvarying vec2 tc;\n" +
    "void main(void) {\n" +
    "  vec4 c = vec4(0.0);\n" +
    "  if (tc.x > 0.5) { c = texture2D(tex, tc); }\n" +
    "  for (int i = 0; i < 4; i++) { c += texture2D(tex, tc * float(i)); }\n" +
    "  gl_FragColor = c;\n}");

checkProgram("vertex_texture_fetch",
    "uniform sampler2D heightmap;\nattribute vec4 pos;\n" +
    "void main(void) {\n" +
    "  float h = texture2D(heightmap, pos.xy).r;\n" +
    "  gl_Position = gl_ModelViewProjectionMatrix * (pos + vec4(0.0, h, 0.0, 0.0));\n}",
    "void main(void) { gl_FragColor = vec4(1.0); }");

checkProgram("matrix_builtins",
    "attribute vec4 pos;\nuniform mat3 rot;\nvarying vec3 v;\n" +
    "void main(void) {\n" +
    "  mat3 t = transpose(rot);\n" +
    "  mat3 m = matrixCompMult(rot, t);\n" +
    "  v = m * pos.xyz;\n" +
    "  gl_Position = pos;\n}",
    "varying vec3 v;\nvoid main(void) { gl_FragColor = vec4(v, 1.0); }");

checkProgram("point_sprite_and_clip",
    "attribute vec4 pos;\n" +
    "void main(void) {\n" +
    "  gl_Position = gl_ModelViewProjectionMatrix * pos;\n" +
    "  gl_ClipVertex = gl_ModelViewMatrix * pos;\n" +
    "  gl_PointSize = 8.0;\n}",
    "uniform sampler2D sprite;\n" +
    "void main(void) { gl_FragColor = texture2D(sprite, gl_PointCoord); }",
    { variant: { pointSprite: true, clipPlaneCount: 3, alphaTest: "gequal" } });

checkProgram("two_sided_flat",
    "void main(void) {\n" +
    "  gl_Position = ftransform();\n" +
    "  gl_FrontColor = gl_Color;\n  gl_BackColor = gl_Color * 0.5;\n}",
    "void main(void) { gl_FragColor = gl_Color; }",
    { variant: { twoSided: true, flatShading: true } });

checkProgram("mrt",
    "attribute vec4 pos;\nvoid main(void) { gl_Position = pos; }",
    "void main(void) {\n" +
    "  gl_FragData[0] = vec4(1.0, 0.0, 0.0, 1.0);\n" +
    "  gl_FragData[1] = vec4(0.0, 1.0, 0.0, 1.0);\n" +
    "  gl_FragDepth = 0.5;\n}");

/* ---- operators WGSL takes differently (desktop: GLSL ES 1.00 reserves the
 * integer ones) ---- */

checkProgram("integer_operators",
    "attribute vec4 pos;\nvoid main(void) { gl_Position = pos; }",
    "uniform int k;\nuniform ivec2 v;\n" +
    "void main(void) {\n" +
    "  ivec2 a = v & k;\n" +
    "  ivec2 b = k | v;\n" +
    "  int s = k << k;\n" +
    "  ivec2 c = v >> k;\n" +
    "  ivec2 d = v << v;\n" +
    "  a ^= k;\n" +
    "  s >>= 2;\n" +
    "  gl_FragColor = vec4(vec2(a + b + c + d), float(s), float(~k));\n}");

/* ---- GLSL ES 1.00 (the GLES host's dialect) ---- */

function checkProgramES(label, vsSource, fsSource) {
    const vs = t.compileShader(vsSource, "vertex", { es: true });
    const fs2 = t.compileShader(fsSource, "fragment", { es: true });
    if (!vs.ok || !fs2.ok) {
        failures.push([label, (vs.ok ? "" : "vertex: " + vs.log) +
            (fs2.ok ? "" : " fragment: " + fs2.log)]);
        return;
    }
    const program = t.linkProgram(vs, fs2, { es: true });
    if (!program.ok) { failures.push([label, "link: " + program.log]); return; }
    const vertexError = validate(label + ".vert", program.wgslVertex);
    const fragmentError = validate(label + ".frag", program.wgslFragment);
    if (vertexError || fragmentError)
        failures.push([label, (vertexError || "") + (fragmentError || "")]);
    else ++passed;
}

checkProgramES("es_equality",
    "attribute vec4 pos;\nvarying vec2 tc;\n" +
    "void main(void) { tc = pos.xy; gl_Position = pos; }",
    "precision mediump float;\n" +
    "struct S { vec2 a; mat2 m; };\n" +
    "uniform S s0;\nuniform S s1;\nuniform mat3 m0;\nuniform mat3 m1;\n" +
    "uniform ivec3 i0;\nvarying vec2 tc;\n" +
    "void main(void) {\n" +
    "  bool e = tc == vec2(0.5) || m0 != m1 || s0 == s1 || i0 == ivec3(1, 2, 3);\n" +
    "  gl_FragColor = e ? vec4(1.0) : vec4(0.0);\n}");

checkProgramES("es_non_uniform_sampling_and_in_params",
    "attribute vec4 pos;\nvarying vec2 tc;\n" +
    "void main(void) { tc = pos.xy; gl_Position = pos; }",
    "precision mediump float;\n" +
    "uniform sampler2D tex;\nuniform samplerCube cube;\nvarying vec2 tc;\n" +
    "vec4 look(vec2 c) { c = c * 2.0; return texture2D(tex, c); }\n" +
    "void main(void) {\n" +
    "  vec4 c = vec4(0.0);\n" +
    "  if (tc.x > 0.5) { c = look(tc); }\n" +
    "  if (tc.y > 0.5) { gl_FragColor = c; return; }\n" +
    "  for (int i = 0; i < 4; i++) {\n" +
    "    if (tc.x > float(i) * 0.25) break;\n" +
    "    c += textureCube(cube, vec3(tc, 1.0));\n" +
    "  }\n" +
    "  gl_FragColor = c + texture2D(tex, tc);\n}");

checkProgramES("es_matrix_componentwise",
    "attribute vec4 pos;\nvoid main(void) { gl_Position = pos; }",
    "precision mediump float;\nuniform mat3 a;\nuniform mat3 b;\nuniform float s;\n" +
    "const mat2 c = mat2(1.0);\nconst mat2 d = mat2(1.0, 2.0, 3.0, 4.0);\n" +
    "void main(void) {\n" +
    "  mat3 r = a + s; r = s - r; r = r / b; r = -r; r = r / s; r = s / r;\n" +
    "  mat2 q = c + d; q = -c; q = c / d; q++; --q; q += 1.0; q /= d;\n" +
    "  gl_FragColor = vec4(r[0], 1.0) + vec4(q[0], q[1]);\n}");

checkProgramES("es_struct_with_struct_array",
    "attribute vec4 pos;\nvoid main(void) { gl_Position = pos; }",
    "precision mediump float;\nstruct L { vec3 c; float k; };\nstruct S { L l[2]; vec2 p; };\n" +
    "uniform S s;\nvoid main(void) { gl_FragColor = vec4(s.l[1].c * s.l[0].k, s.p.x); }");

// These shaders bypass the GLSL translator, so exercise them directly too.
// A syntax error here otherwise appears only when CopyTexImage, mipmap, or a
// scaling framebuffer blit first runs on a real adapter.
const executorSource = fs.readFileSync(path.join(__dirname, "../../src/browser/glbridge/gl-webgpu",
    "gl_executor.js"), "utf8");
for (const name of ["COLOR_COPY_WGSL", "MIPMAP_WGSL", "COLOR_BLIT_WGSL"]) {
    const match = new RegExp("const\\s+" + name + "\\s*=\\s*`([\\s\\S]*?)`;" )
        .exec(executorSource);
    if (!match) failures.push([name, "shader constant is missing"]);
    else {
        const error = validate(name, match[1]);
        if (error) failures.push([name, error]);
        else ++passed;
    }
}

for (const [name, log] of failures)
    console.error("FAIL: " + name + "\n" + String(log).slice(0, 900));
console.log(passed + " shader pairs validated (" + corpus.length +
    " from the Cube 2 corpus), " + failures.length + " failed");
void corpusFailures;
fs.rmSync(outputDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
