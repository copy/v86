#!/usr/bin/env node
// Unit tests for glbridge/gl-webgpu/gl_arb_program.js -- GL_ARB_vertex_program
// and GL_ARB_fragment_program assembly translated to WGSL.
//
// The fixtures are written the way a real program is: a header, declarations,
// a flat instruction list, END. What is checked is that the register machine's
// semantics survive -- swizzles, write masks, saturation, the address register,
// the state bindings resolving into the *same* GLState block the fixed pipeline
// uses -- and that the output is WGSL naga accepts.

"use strict";

const { requireNaga } = require("./naga.js");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const arb = require("../../src/browser/glbridge/gl-webgpu/gl_arb_program.js");


const naga = requireNaga("gl_arb_program_test");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "glwg-arb-"));
let passed = 0;
const failures = [];

function test(name, fn) {
    try { fn(); ++passed; } catch (error) { failures.push([name, error]); }
}

function compile(source, label, options) {
    const result = arb.compileARBProgram(source, options || {});
    if (!result.ok) throw new Error(result.log);
    if (naga) {
        const file = path.join(outputDir,
            (label || "program").replace(/[^A-Za-z0-9_.-]/g, "_") + ".wgsl");
        fs.writeFileSync(file, result.wgsl);
        try {
            execFileSync(naga, [file], { stdio: "pipe" });
        } catch (error) {
            throw new Error("naga rejected the generated WGSL:\n" +
                String(error.stderr || error.stdout || error).slice(0, 800));
        }
    }
    return result;
}

/* ---- the canonical transform ---- */

const TRANSFORM = `!!ARBvp1.0
ATTRIB pos = vertex.position;
PARAM mvp[4] = { state.matrix.mvp };
OUTPUT oPos = result.position;
DP4 oPos.x, mvp[0], pos;
DP4 oPos.y, mvp[1], pos;
DP4 oPos.z, mvp[2], pos;
DP4 oPos.w, mvp[3], pos;
MOV result.color, vertex.color;
END`;

test("the canonical DP4 transform translates", () => {
    const result = compile(TRANSFORM, "transform");
    assert.strictEqual(result.target, "vertex");
    assert.ok(result.reflection.stateFields.indexOf("mvp") >= 0,
        "state.matrix.mvp resolves into the shared GL state block");
    assert.ok(result.wgsl.indexOf("clip.y = -clip.y;") >= 0,
        "the same clip-space flip every other path applies");
    assert.ok(result.wgsl.indexOf("clip.z = (clip.z + clip.w) * 0.5;") >= 0);
    const attributes = result.reflection.attributes.map(a => a.location);
    assert.ok(attributes.indexOf(0) >= 0, "vertex.position is attribute 0");
});

test("a fixed fragment stage can require ARB texture-coordinate outputs", () => {
    const result = compile(`!!ARBvp1.0
MOV result.position, vertex.position;
END`, "fixed_fragment_outputs", {
        forceVertexTexCoords: [0, 1],
        forceStateFields: ["mvp", "texEnvColor"],
        forceFlatVaryings: [0, 1],
    });
    assert.ok(result.wgsl.includes(
        "@location(3) texcoord0 : vec4<f32>"));
    assert.ok(result.wgsl.includes(
        "@location(4) texcoord1 : vec4<f32>"));
    assert.ok(result.wgsl.includes("out.texcoord0 = texcoord0;"));
    assert.ok(result.wgsl.includes(
        "@interpolate(flat) @location(0) frontColor"));
    assert.ok(result.wgsl.includes("texEnvColor"),
        "the mixed stages use a byte-identical GLState layout");
});

test("constants in instructions, ranges and relative addressing assemble (review S2-48)", () => {
    const fragment = compile("!!ARBfp1.0\nTEMP t;\nMUL t, fragment.color, 2.0;\n" +
        "MAD_SAT t, t, {0.5, 0.25}, -1.0;\nPOW t.x, 0.25, 0.5;\nMOV result.color, t;\nEND\n", "inline_constants");
    assert.match(fragment.wgsl, /vec4<f32>\(2(\.0)?, 2(\.0)?, 2(\.0)?, 2(\.0)?\)/, "a scalar is all four components");
    assert.match(fragment.wgsl, /vec4<f32>\(0\.5, 0\.25, 0(\.0)?, 1(\.0)?\)/, "a short vector is filled with 0 and 1");
    const vertex = compile(TRANSFORM.replace("MOV result.color, vertex.color;",
        "PARAM arr[5] = { program.local[0..4] };\nADDRESS a;\nARL a.x, program.env[0].x;\n" +
        "MOV result.color, arr[a.x-1];\nMOV result.color.secondary, program.env[a.x+2];"), "relative");
    assert.match(vertex.wgsl, /arbParams\.local\[4\]/, "the range is five registers");
    assert.match(vertex.wgsl, /\(arb_a\.x - 1\)/, "a negative offset");
    assert.match(vertex.wgsl, /clamp\(\(arb_a\.x \+ 2\), 0, /);
    assert.ok(vertex.reflection.stateFields.length >= 1);
    assert.deepStrictEqual(compile("!!ARBfp1.0\nMOV result.color, fragment.texcoord[3];\nEND\n", "texcoords")
        .reflection.fragmentTexCoords, [3]);
});

test("SWZ, result.depth, fog options, shadow targets and the remaining state bindings (S2-48..S2-50, S3)", () => {
    const swz = compile("!!ARBfp1.0\nTEMP t;\nSWZ t, fragment.color, x,-y,0,1;\nMOV result.color, t;\nEND\n", "swz");
    assert.match(swz.wgsl, /vec4<f32>\(\(fin\.frontColor\)\.x, -\(\(fin\.frontColor\)\.y\), 0\.0, 1\.0\)/);
    for (const [label, write] of [["depth_z", "MOV result.depth.z, fragment.color.x;"],
        ["depth_whole", "MOV result.depth, fragment.color;"]])
        assert.match(compile("!!ARBfp1.0\nMOV result.color, fragment.color;\n" + write + "\nEND\n", label).wgsl,
            /@builtin\(frag_depth\)/, "result.depth (S2-49)");
    const fog = compile("!!ARBfp1.0\nOPTION ARB_fog_exp2;\nMOV result.color, fragment.color;\nEND\n", "fog_exp2");
    assert.match(fog.wgsl, /mix\(glState\.fogColor\.rgb, color0\.rgb/);
    const shadow = compile("!!ARBfp1.0\nOPTION ARB_fragment_program_shadow;\n" +
        "TXP result.color, fragment.texcoord[0], texture[0], SHADOW2D;\nEND\n", "shadow");
    assert.match(shadow.wgsl, /texture_depth_2d/);
    assert.match(shadow.wgsl, /sampler_comparison/);
    assert.deepStrictEqual(shadow.reflection.textures, [{ unit: 0, target: "SHADOW2D" }]);
    const bindings = compile(TRANSFORM.replace("MOV result.color, vertex.color;",
        "PARAM t[4] = { state.matrix.texture[1] };\nPARAM m[4] = { state.matrix.modelview[0] };\n" +
        "PARAM r[2] = { state.matrix.mvp.row[1..2] };\nTEMP a;\nADD a, t[0], m[1];\nADD a, a, r[1];\n" +
        "ADD a, a, state.lightprod[0].back.diffuse;\nADD a, a, state.material.front.emission;\n" +
        "ADD result.color, a, state.texgen.eye.s;"), "state_bindings");
    assert.match(bindings.wgsl, /glState\.textureMatrix\[1\]/);
    assert.match(bindings.wgsl, /glState\.modelview\[0\]\[1\], glState\.modelview\[1\]\[1\]/,
        "modelview[0] is the matrix, m[1] its row 1 (it was read as row 0)");
    assert.match(bindings.wgsl, /glState\.backLightProduct\[0\]\.diffuse/);
    const lit = compile("!!ARBfp1.0\nTEMP t;\nLIT t, fragment.color;\nMOV result.color, t;\nEND\n", "lit");
    assert.match(lit.wgsl, /select\(pow\(max\(v\.y, 0\.0\), exponent\), 1\.0, exponent == 0\.0\)/, "0^0 is 1");
});

test("a write mask writes only the components it names", () => {
    const result = compile(`!!ARBvp1.0
TEMP r0;
MOV r0, vertex.position;
MOV result.color.xz, r0;
MOV result.position, r0;
END`, "writemask");
    assert.ok(result.wgsl.indexOf("frontColor.x = ") >= 0);
    assert.ok(result.wgsl.indexOf("frontColor.z = ") >= 0);
    assert.ok(result.wgsl.indexOf("frontColor.y = ") < 0,
        "an unnamed component keeps its previous value");
});

test("a one-component swizzle replicates", () => {
    assert.strictEqual(arb.applySwizzle("v", "x"), "vec4<f32>((v).x)");
    assert.strictEqual(arb.applySwizzle("v", "xyzw"), "(v).xyzw");
    assert.strictEqual(arb.applySwizzle("v", "wzyx"), "(v).wzyx");
    assert.ok(arb.applySwizzle("v", "x1").indexOf("1.0") >= 0,
        "the extended swizzle's literal components survive");
});

test("source modifiers negate and take the absolute value", () => {
    const result = compile(`!!ARBfp1.0
TEMP r0;
MOV r0, -fragment.color;
MOV result.color, |r0|;
END`, "modifiers");
    assert.ok(result.wgsl.indexOf("(-(") >= 0);
    assert.ok(result.wgsl.indexOf("abs(") >= 0);
});

test("_SAT clamps the result", () => {
    const result = compile(`!!ARBfp1.0
TEMP r0;
ADD_SAT r0, fragment.color, fragment.color;
MOV result.color, r0;
END`, "saturate");
    assert.ok(result.wgsl.indexOf("clamp(") >= 0);
});

/* ---- instruction semantics ---- */

test("LIT and LOG emit their helper rather than an approximation", () => {
    const result = compile(`!!ARBvp1.0
TEMP r0;
LIT r0, vertex.position;
LOG r0, vertex.position;
MOV result.position, r0;
END`, "lit_log");
    assert.ok(result.wgsl.indexOf("fn arbLit") >= 0);
    assert.ok(result.wgsl.indexOf("fn arbLog") >= 0);
});

test("scalar instructions read only the x component", () => {
    const result = compile(`!!ARBvp1.0
TEMP r0;
RCP r0, vertex.position;
RSQ r0, r0;
POW r0, r0, r0;
MOV result.position, r0;
END`, "scalar");
    assert.ok(result.wgsl.indexOf("1.0 / ") >= 0);
    assert.ok(result.wgsl.indexOf("inverseSqrt(max(abs(") >= 0,
        "RSQ guards against a zero operand the way hardware does");
});

test("DST assembles the distance vector from both operands", () => {
    const result = compile(`!!ARBvp1.0
TEMP r0, r1;
MOV r0, vertex.position;
MOV r1, vertex.normal;
DST r0, r0, r1;
MOV result.position, r0;
END`, "dst");
    assert.ok(result.wgsl.indexOf("vec4<f32>(1.0, ") >= 0);
});

test("KIL discards", () => {
    const result = compile(`!!ARBfp1.0
KIL fragment.color;
MOV result.color, fragment.color;
END`, "kil");
    assert.ok(result.wgsl.indexOf("discard;") >= 0);
    assert.strictEqual(result.reflection.usesKill, true);
});

test("CMP and LRP are fragment-only", () => {
    const ok = compile(`!!ARBfp1.0
TEMP r0;
CMP r0, fragment.color, fragment.color, fragment.color;
LRP r0, r0, r0, r0;
MOV result.color, r0;
END`, "cmp_lrp");
    assert.ok(ok.wgsl.indexOf("select(") >= 0);
    const rejected = arb.compileARBProgram(`!!ARBvp1.0
TEMP r0;
CMP r0, vertex.position, vertex.position, vertex.position;
MOV result.position, r0;
END`, {});
    assert.strictEqual(rejected.ok, false);
    assert.ok(rejected.log.indexOf("fragment-program only") >= 0, rejected.log);
});

/* ---- texture instructions ---- */

test("TEX, TXP and TXB reach the right unit and target", () => {
    const result = compile(`!!ARBfp1.0
TEMP r0, r1, r2;
TEX r0, fragment.texcoord[0], texture[0], 2D;
TXP r1, fragment.texcoord[1], texture[1], 2D;
TXB r2, fragment.texcoord[2], texture[2], CUBE;
ADD r0, r0, r1;
ADD result.color, r0, r2;
END`, "textures");
    assert.strictEqual(result.reflection.textures.length, 3);
    assert.strictEqual(result.reflection.textures[2].target, "CUBE");
    assert.ok(result.wgsl.indexOf("textureSample(t0") >= 0);
    assert.ok(result.wgsl.indexOf(".xy / ") >= 0, "TXP divides by w");
    assert.ok(result.wgsl.indexOf("textureSampleBias(t2") >= 0);
    assert.ok(result.wgsl.indexOf("texture_cube<f32>") >= 0);
});

/* ---- parameters and state ---- */

test("program.env and program.local share one binding", () => {
    const result = compile(`!!ARBvp1.0
TEMP r0;
MUL r0, vertex.position, program.env[7];
ADD r0, r0, program.local[3];
MOV result.position, r0;
END`, "params");
    assert.ok(result.wgsl.indexOf("arbParams.env[7]") >= 0);
    assert.ok(result.wgsl.indexOf("arbParams.local[3]") >= 0);
    assert.ok(result.wgsl.indexOf("@group(1) @binding(1)") >= 0,
        "a program which reads parameters declares their uniform binding");
    assert.strictEqual(result.reflection.usesEnv, true);
    assert.strictEqual(result.reflection.usesLocal, true);
    assert.strictEqual(result.reflection.maxParameters, 96,
        "ARB vertex programs provide the required 96 parameters");
});

test("an ARB program without parameters omits their unused binding", () => {
    const result = compile(`!!ARBvp1.0
MOV result.position, vertex.position;
MOV result.color, vertex.color;
END`, "no_params");
    assert.strictEqual(result.reflection.usesEnv, false);
    assert.strictEqual(result.reflection.usesLocal, false);
    assert.ok(result.wgsl.indexOf("@group(1) @binding(1)") < 0,
        "auto pipeline layout must not lose a declared-but-unused binding");
});

test("a parameter beyond the advertised count is refused", () => {
    const result = arb.compileARBProgram(`!!ARBvp1.0
MOV result.position, program.env[96];
END`, {});
    assert.strictEqual(result.ok, false);
    assert.ok(result.log.indexOf("96") >= 0, result.log);
});

test("relative addressing through ARL indexes the uniform array", () => {
    const result = compile(`!!ARBvp1.0
ADDRESS A0;
TEMP r0;
ARL A0.x, vertex.position;
MOV r0, program.env[A0.x + 2];
MOV result.position, r0;
END`, "relative");
    assert.ok(result.wgsl.indexOf("clamp(") >= 0,
        "the index is clamped, because WGSL does not define an out-of-range read");
    assert.strictEqual(result.reflection.usesAddress, true);
});

test("state bindings resolve into the shared GL state block", () => {
    const result = compile(`!!ARBvp1.0
TEMP r0;
MOV r0, state.light[2].position;
ADD r0, r0, state.lightprod[2].diffuse;
ADD r0, r0, state.material.specular;
ADD r0, r0, state.fog.params;
ADD r0, r0, state.clip[1].plane;
MOV result.position, r0;
END`, "state");
    const fields = result.reflection.stateFields;
    for (const field of ["lights", "frontLightProduct", "frontMaterial",
            "fogParams", "clipPlanes"])
        assert.ok(fields.indexOf(field) >= 0, field + " is requested");
    assert.ok(result.wgsl.indexOf("glState.lights[2].position") >= 0);
});

test("a matrix row binding gathers the row rather than a column", () => {
    const result = compile(`!!ARBvp1.0
PARAM m0 = state.matrix.mvp.row[1];
MOV result.position, m0;
END`, "matrix_row");
    // WGSL indexes a matrix by column, so an ARB row has to be assembled.
    assert.ok(result.wgsl.indexOf("glState.mvp[0][1]") >= 0, result.wgsl);
    assert.ok(result.wgsl.indexOf("glState.mvp[3][1]") >= 0);
});

test("all program and texture matrix modifiers compile, with bounded indices", () => {
    for (const type of ["program", "texture"]) for (const [modifier, suffix] of [["", ""], [".inverse", "Inverse"], [".transpose", "Transpose"], [".invtrans", "InverseTranspose"]]) {
        const result = compile("!!ARBvp1.0\nPARAM m[4] = { state.matrix." + type + "[7]" + modifier + " };\nMOV result.position, m[0];\nEND", type + suffix);
        assert.ok(result.reflection.stateFields.includes(type + "Matrix" + suffix));
        compile("!!ARBvp1.0\nMOV result.position, state.matrix." + type + "[7]" + modifier + ".row[2];\nEND", type + suffix + "_row");
        assert.equal(arb.compileARBProgram("!!ARBvp1.0\nMOV result.position, state.matrix." + type + "[8]" + modifier + ".row[0];\nEND", {}).ok, false);
    }
});

test("an unknown state binding is refused with its name", () => {
    const result = arb.compileARBProgram(`!!ARBvp1.0
MOV result.position, state.nonsense.thing;
END`, {});
    assert.strictEqual(result.ok, false);
    assert.ok(result.log.indexOf("state.nonsense.thing") >= 0, result.log);
});

test("a literal PARAM is inlined as a constant", () => {
    const result = compile(`!!ARBvp1.0
PARAM half = { 0.5, 0.5, 0.5, 1.0 };
TEMP r0;
MUL r0, vertex.position, half;
MOV result.position, r0;
END`, "literal");
    assert.ok(result.wgsl.indexOf("vec4<f32>(0.5, 0.5, 0.5, 1.0)") >= 0);
});

test("a scalar PARAM splats all four components like glview's half", () => {
    const result = compile(`!!ARBvp1.0
PARAM half = 0.5;
TEMP light_surf;
MAD result.color, light_surf, half, half;
MOV result.position, vertex.position;
END`, "glview_scalar_param");
    assert.ok(result.wgsl.indexOf(
        "vec4<f32>(0.5, 0.5, 0.5, 0.5)") >= 0, result.wgsl);
    assert.ok(result.wgsl.indexOf(
        "vec4<f32>(0.5, 0.0, 0.0, 1.0)") < 0,
        "a PARAM scalar is not expanded like a one-component vertex array");
});

test("ALIAS and ATTRIB declarations resolve", () => {
    const result = compile(`!!ARBvp1.0
ATTRIB iPos = vertex.position;
TEMP r0;
ALIAS scratch = r0;
MOV scratch, iPos;
MOV result.position, scratch;
END`, "alias");
    assert.ok(result.ok);
});

test("OPTION ARB_position_invariant supplies the transform", () => {
    const result = compile(`!!ARBvp1.0
OPTION ARB_position_invariant;
MOV result.color, vertex.color;
END`, "position_invariant");
    assert.strictEqual(result.reflection.positionInvariant, true);
    assert.ok(result.wgsl.indexOf("glState.mvp * vin.gl_Vertex") >= 0,
        "the same expression ftransform() uses, or a depth pre-pass z-fights");
});

/* ---- diagnostics ---- */

test("a missing header is refused", () => {
    const result = arb.compileARBProgram("MOV result.position, vertex.position;\nEND", {});
    assert.strictEqual(result.ok, false);
    assert.ok(result.log.indexOf("!!ARBvp1.0") >= 0, result.log);
});

test("an unknown instruction names itself", () => {
    const result = arb.compileARBProgram(`!!ARBvp1.0
FROB result.position, vertex.position;
END`, {});
    assert.strictEqual(result.ok, false);
    assert.ok(result.log.indexOf("FROB") >= 0, result.log);
});

test("a program with no END is refused", () => {
    const result = arb.compileARBProgram(`!!ARBvp1.0
MOV result.position, vertex.position;`, {});
    assert.strictEqual(result.ok, false);
    assert.ok(result.log.indexOf("END") >= 0, result.log);
});

test("comments and blank lines are ignored", () => {
    const result = compile(`!!ARBvp1.0
# the canonical transform
PARAM mvp[4] = { state.matrix.mvp };   # four rows

DP4 result.position.x, mvp[0], vertex.position;  # x
DP4 result.position.y, mvp[1], vertex.position;
DP4 result.position.z, mvp[2], vertex.position;
DP4 result.position.w, mvp[3], vertex.position;
END`, "comments");
    assert.ok(result.ok);
});

for (const [name, error] of failures)
    console.error("FAIL: " + name + "\n    " + (error && error.message));
console.log(passed + " passed, " + failures.length + " failed" +
    (naga ? " (WGSL validated with naga)" : " (naga absent)"));
fs.rmSync(outputDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
