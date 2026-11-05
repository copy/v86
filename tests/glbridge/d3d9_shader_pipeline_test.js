#!/usr/bin/env node
// Unit tests for glbridge/d3d9-webgpu/d3d9_shader_pipeline.js -- the D3D9
// shader-model 1.x/2.0/3.0 bytecode -> WGSL translator (plan section 9, M2).
//
// Every fixture here is real D3D9 bytecode, assembled token by token by the
// helpers at the top rather than captured from a game, so a failing test
// points at an exact instruction encoding instead of an opaque blob. The
// assembler encodes tokens the same way fxc does (register type split across
// bits 28-30 and 11-12, swizzle in 16-23, source modifier in 24-27), which is
// itself part of what these tests cover: a bug in either the assembler or the
// parser shows up as a decode mismatch.
//
// The WGSL these produce is additionally checked for real by
// d3d9_shader_wgsl_validation_test.js when a `naga` binary is available;
// this file asserts on translation *structure* (which registers, uniforms,
// varyings and reflection a shader yields) and runs everywhere.

"use strict";

const assert = require("assert");
const pipeline = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js");

// ---- bytecode assembler ----

const VS = (major, minor) => (0xfffe0000 | (major << 8) | minor) >>> 0;
const PS = (major, minor) => (0xffff0000 | (major << 8) | minor) >>> 0;
const END = 0x0000ffff;

const REG = pipeline.REGISTER;
const OP = pipeline.OP;

// D3DSP_REGTYPE is stored in two pieces: the low three bits at 28-30 and the
// high two at 11-12.
const regTypeBits = type => (((type & 0x7) << 28) | ((type & 0x18) << 8)) >>> 0;

const NOSWIZZLE = 0xe4; // .xyzw
const swizzle = text => {
    let bits = 0;
    for (let i = 0; i < 4; ++i) {
        const component = "xyzw".indexOf(text[Math.min(i, text.length - 1)]);
        bits |= component << (i * 2);
    }
    return bits;
};

const instruction = (opcode, options = {}) => {
    const length = options.length || 0;
    const control = options.control || 0;
    return ((opcode & 0xffff) | ((control & 0xff) << 16) |
        ((length & 0xf) << 24) | (options.predicated ? 0x10000000 : 0)) >>> 0;
};

const dst = (type, index, options = {}) => {
    const mask = options.mask === undefined ? 0xf : options.mask;
    return (0x80000000 | (index & 0x7ff) | regTypeBits(type) |
        ((mask & 0xf) << 16) | (((options.modifier || 0) & 0xf) << 20) |
        (((options.shift || 0) & 0xf) << 24)) >>> 0;
};

const src = (type, index, options = {}) => {
    const sw = options.swizzle === undefined ? NOSWIZZLE : options.swizzle;
    return (0x80000000 | (index & 0x7ff) | regTypeBits(type) |
        ((sw & 0xff) << 16) | (((options.modifier || 0) & 0xf) << 24) |
        (options.relative ? (1 << 13) : 0)) >>> 0;
};

const dclToken = (usage, usageIndex = 0, textureType = 0) =>
    (0x80000000 | (usage & 0xf) | ((usageIndex & 0xf) << 16) |
        ((textureType & 0xf) << 27)) >>> 0;

const floatBits = value => {
    const buffer = new ArrayBuffer(4);
    new Float32Array(buffer)[0] = value;
    return new Uint32Array(buffer)[0];
};

const tokens = list => new Uint32Array(list);

const USAGE = { POSITION: 0, BLENDWEIGHT: 1, BLENDINDICES: 2, NORMAL: 3,
    PSIZE: 4, TEXCOORD: 5, TANGENT: 6, BINORMAL: 7, TESSFACTOR: 8,
    POSITIONT: 9, COLOR: 10, FOG: 11, DEPTH: 12, SAMPLE: 13 };

// ---- test harness ----

const failures = [];
let passed = 0;

function test(name, body) {
    try {
        body();
        ++passed;
    } catch (error) {
        failures.push({ name, error });
    }
}

function compileOk(list, label) {
    const result = pipeline.compileShader(tokens(list));
    if (!result.ok)
        throw new Error((label || "shader") + " failed to translate: " + result.error);
    return result;
}

// ---- fixtures ----

// vs_1_1
//   dcl_position v0
//   dcl_texcoord0 v1
//   m4x4 oPos, v0, c0
//   mov oT0, v1
const VS_1_1_TRANSFORM = [
    VS(1, 1),
    instruction(OP.DCL), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
    instruction(OP.DCL), dclToken(USAGE.TEXCOORD, 0), dst(REG.INPUT, 1),
    instruction(OP.M4x4), dst(REG.RASTOUT, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
    instruction(OP.MOV), dst(REG.OUTPUT, 0), src(REG.INPUT, 1),
    END,
];

// ps_1_1
//   tex t0
//   mul r0, t0, v0
const PS_1_1_MODULATE = [
    PS(1, 1),
    instruction(OP.TEX), dst(REG.TEXTURE, 0),
    instruction(OP.MUL), dst(REG.TEMP, 0), src(REG.TEXTURE, 0), src(REG.INPUT, 0),
    END,
];

// ps_2_0
//   dcl_2d s0
//   dcl t0.xy
//   def c0, 0.5, 0.25, 0, 1
//   texld r0, t0, s0
//   mul r0, r0, c0
//   mov oC0, r0
const PS_2_0_TEXTURED = [
    PS(2, 0),
    instruction(OP.DCL, { length: 2 }), dclToken(0, 0, 2), dst(REG.SAMPLER, 0),
    instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0),
        dst(REG.TEXTURE, 0, { mask: 0x3 }),
    instruction(OP.DEF, { length: 5 }), dst(REG.CONST, 0),
        floatBits(0.5), floatBits(0.25), floatBits(0), floatBits(1),
    instruction(OP.TEX, { length: 3 }), dst(REG.TEMP, 0),
        src(REG.TEXTURE, 0), src(REG.SAMPLER, 0),
    instruction(OP.MUL, { length: 3 }), dst(REG.TEMP, 0),
        src(REG.TEMP, 0), src(REG.CONST, 0),
    instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
    END,
];

// vs_2_0 with the whole flow-control vocabulary plus relative addressing:
//   dcl_position v0
//   defi i0, 4, 0, 1, 0
//   defb b0, true
//   mov r0, c0
//   mova a0.x, v0.w
//   mov r1, c[a0.x + 2]
//   rep i0
//     add r0, r0, r1
//   endrep
//   if b0
//     mul r0, r0, r0
//   endif
//   m4x4 oPos, r0, c4
const VS_2_0_FLOW = [
    VS(2, 0),
    instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
    instruction(OP.DEFI, { length: 5 }), dst(REG.CONSTINT, 0), 4, 0, 1, 0,
    instruction(OP.DEFB, { length: 2 }), dst(REG.CONSTBOOL, 0), 1,
    instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 0), src(REG.CONST, 0),
    instruction(OP.MOVA, { length: 2 }), dst(REG.ADDR, 0, { mask: 0x1 }),
        src(REG.INPUT, 0, { swizzle: swizzle("wwww") }),
    instruction(OP.MOV, { length: 3 }), dst(REG.TEMP, 1),
        src(REG.CONST, 2, { relative: true }), src(REG.ADDR, 0, { swizzle: swizzle("xxxx") }),
    instruction(OP.REP, { length: 1 }), src(REG.CONSTINT, 0),
    instruction(OP.ADD, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.TEMP, 1),
    instruction(OP.ENDREP),
    instruction(OP.IF, { length: 1 }), src(REG.CONSTBOOL, 0),
    instruction(OP.MUL, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.TEMP, 0),
    instruction(OP.ENDIF),
    instruction(OP.M4x4, { length: 3 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0), src(REG.CONST, 4),
    END,
];

// vs_2_0 with a subroutine:
//   dcl_position v0
//   mov r0, v0
//   call l0
//   m4x4 oPos, r0, c0
//   ret
//   label l0
//     add r0, r0, r0
//   ret
const VS_2_0_SUBROUTINE = [
    VS(2, 0),
    instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
    instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 0), src(REG.INPUT, 0),
    instruction(OP.CALL, { length: 1 }), src(REG.LABEL, 0),
    instruction(OP.M4x4, { length: 3 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0), src(REG.CONST, 0),
    instruction(OP.RET),
    instruction(OP.LABEL, { length: 1 }), src(REG.LABEL, 0),
    instruction(OP.ADD, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.TEMP, 0),
    instruction(OP.RET),
    END,
];

// ---- tests ----

test("vs_1_1 transform: parses, emits a vertex entry point and a WVP uniform", () => {
    const { wgsl, reflection } = compileOk(VS_1_1_TRANSFORM, "vs_1_1");
    assert.strictEqual(reflection.kind, "vertex");
    assert.deepStrictEqual(reflection.version, { major: 1, minor: 1 });
    assert.strictEqual(reflection.entryPoint, "d9_vs_main");
    assert.ok(wgsl.includes("@vertex"), "no @vertex stage");
    assert.ok(wgsl.includes("fn d9_vs_main("), "missing entry point");
    // m4x4 reads c0..c3, so the float constant region must be four vec4s.
    assert.strictEqual(reflection.floatConstCount, 4);
    // Both declared inputs must surface with their semantics and a location
    // equal to their v# register number.
    assert.deepStrictEqual(reflection.inputs, [
        { register: 0, usage: USAGE.POSITION, usageIndex: 0, location: 0 },
        { register: 1, usage: USAGE.TEXCOORD, usageIndex: 0, location: 1 },
    ]);
    assert.ok(wgsl.includes("@location(0) in0: vec4<f32>"), "v0 not bound to location 0");
    assert.ok(wgsl.includes("@location(1) in1: vec4<f32>"), "v1 not bound to location 1");
    // oPos reaches @builtin(position) through the D3D9 half-pixel offset: D3D9
    // samples a pixel at its integer corner, WebGPU at its centre, and a title
    // that pixel-aligns its output has already subtracted that half pixel.
    assert.ok(wgsl.includes("o_position.x + o_position.w / d9c.viewport.x"),
        "oPos not routed to @builtin(position) with the half-pixel offset");
    assert.ok(wgsl.includes("o_position.y - o_position.w / d9c.viewport.y"),
        "the half-pixel offset must negate y: screen y grows downward");
    // oT0 is TEXCOORD0, which the fixed varying table puts at location 2.
    assert.ok(wgsl.includes("o_varying2 = "), "oT0 did not land in the TEXCOORD0 varying");
    assert.strictEqual(reflection.samplers.length, 0);
});

test("vs_1_1 m4x4 expands to four dot products against consecutive registers", () => {
    const { wgsl } = compileOk(VS_1_1_TRANSFORM, "vs_1_1");
    for (const register of [0, 1, 2, 3])
        assert.ok(wgsl.includes("d9c.f[" + register + "]"),
            "m4x4 did not read c" + register);
});

test("ps_1_1: t# is both coordinate and sample destination, r0 is the output", () => {
    const { wgsl, reflection } = compileOk(PS_1_1_MODULATE, "ps_1_1");
    assert.strictEqual(reflection.kind, "pixel");
    assert.ok(wgsl.includes("@fragment"), "no @fragment stage");
    // `tex t0` implies sampler 0 even without a dcl.
    assert.deepStrictEqual(reflection.samplers, [
        { index: 0, type: "2d", depth: false, textureBinding: 2, samplerBinding: 3 },
    ]);
    assert.ok(wgsl.includes("textureSample(d9_tex0, d9_smp0"), "no sample of texture 0");
    // ps_1_x has no oC0: the result is r0.
    assert.ok(wgsl.includes("result.color0 = r0;"),
        "ps_1_x output should come from r0, got:\n" + wgsl);
    // v0 is COLOR0 (varying 0), t0 is TEXCOORD0 (varying 2).
    assert.ok(wgsl.includes("v0 = stage_in.varying0;"), "v0 not wired to COLOR0");
    assert.ok(wgsl.includes("t0 = stage_in.varying2;"), "t0 not wired to TEXCOORD0");
});

test("ps_1_x tex/texld take sampler dimensions from the bound texture", () => {
    for (const minor of [1, 4]) {
        const code = minor === 1 ? [
            PS(1, 1), instruction(OP.TEX), dst(REG.TEXTURE, 0),
            instruction(OP.MOV), dst(REG.TEMP, 0), src(REG.TEXTURE, 0), END,
        ] : [
            PS(1, 4), instruction(OP.TEX), dst(REG.TEMP, 0), src(REG.TEXTURE, 0), END,
        ];
        for (const type of ["2d", "cube", "3d"]) {
            const result = pipeline.compileShader(tokens(code), {
                legacySamplerTypes: { 0: type, 7: "cube" },
            });
            assert.ok(result.ok, result.error);
            assert.equal(result.reflection.samplers.length, 1,
                "an unused bound texture must not add a sampler");
            assert.equal(result.reflection.samplers[0].type, type);
            assert.ok(result.wgsl.includes("var d9_tex0: texture_" + type + "<f32>"));
            if (type !== "2d") assert.match(result.wgsl, /textureSample\(d9_tex0, d9_smp0, [^\n]*\.xyz\)/);
        }
    }
    const sm2 = pipeline.compileShader(tokens(PS_2_0_TEXTURED), {
        legacySamplerTypes: { 0: "cube" },
    });
    assert.ok(sm2.ok, sm2.error);
    assert.equal(sm2.reflection.samplers[0].type, "2d",
        "SM2 explicit declarations must not be overridden by bindings");
});

test("a vs_1_1 with no dcl gets the API's fixed v# semantics", () => {
    // Real vs_1_x bytecode contains no dcl_ at all -- the instruction did not
    // exist before vs_2_0 -- so what v0/v5/v7 mean comes from D3D's fixed
    // register table, not from the shader. (The VS_1_1_* fixtures above spell
    // their inputs with dcl, which is convenient but not a shape any
    // assembler produces for this model.)
    //
    // Reflecting nothing here is not a cosmetic gap: the executor pairs a
    // vertex declaration element to a shader input by (usage, usageIndex), so
    // an input-less reflection means no attribute is bound, every v# reads
    // zero, and d3d9_executor drops the draw entirely -- which is what
    // happened to every vertex-shader draw 3DMark 2001 issued.
    const shader = [
        VS(1, 1),
        instruction(OP.M4x4), dst(REG.RASTOUT, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
        instruction(OP.MOV), dst(REG.ATTROUT, 0), src(REG.INPUT, 5),
        instruction(OP.MOV), dst(REG.TEXCRDOUT, 0), src(REG.INPUT, 7),
        END,
    ];
    const { wgsl, reflection } = compileOk(shader, "vs_1_1 without dcl");
    assert.deepStrictEqual(reflection.inputs, [
        { register: 0, usage: 0, usageIndex: 0, location: 0 },   // POSITION0
        { register: 5, usage: 10, usageIndex: 0, location: 5 },  // COLOR0
        { register: 7, usage: 5, usageIndex: 0, location: 7 },   // TEXCOORD0
    ], "v0/v5/v7 must reflect as position, diffuse and texcoord0");
    // And they have to reach the shader as real attributes: the register
    // variable is still private storage, but the entry point now takes an
    // attribute per input and copies it in, instead of leaving vin0 at the
    // zero it is initialised to.
    assert.match(wgsl, /fn d9_vs_main\(@location\(0\) \w+: vec4<f32>/);
    assert.match(wgsl, /\n\s+vin0 = \w+;/,
        "a used v# must be loaded from its vertex attribute");
});

test("vs_1_1 MOV a0.x selects a matrix-palette constant", () => {
    // SM1.1 has no MOVA instruction. Matrix-palette skinning loads each
    // vertex's packed bone index with MOV and then addresses c[a0.x + n]. If
    // the integer a0 mirror is not updated, every vertex reads the same root
    // matrix and an animated character remains in its bind/T pose.
    const shader = [
        VS(1, 1),
        instruction(OP.MOV), dst(REG.ADDR, 0, { mask: 0x1 }),
            src(REG.INPUT, 2, { swizzle: swizzle("xxxx") }),
        instruction(OP.M4x3), dst(REG.TEMP, 0, { mask: 0x7 }),
            src(REG.INPUT, 0), src(REG.CONST, 4, { relative: true }),
        instruction(OP.MOV), dst(REG.RASTOUT, 0), src(REG.TEMP, 0),
        END,
    ];
    const { wgsl, reflection } = compileOk(shader,
        "vs_1_1 matrix-palette address");
    assert.match(wgsl, /let _v\d+ = floor\(/,
        "MOV a0.x must floor as observed by Wine visual.c test_mova on Windows");
    assert.ok(wgsl.includes("a0 = vec4<i32>(a0f);"),
        "MOV a0.x did not update the integer address register:\n" + wgsl);
    assert.ok(wgsl.includes("clamp(a0.x + 4, 0, 255)"),
        "the bone matrix read did not use the updated address register:\n" + wgsl);
    assert.strictEqual(reflection.usesRelativeConstants, true);
    assert.strictEqual(reflection.floatConstCount, 256);
});

test("vs_1_0/ps_1_0 translate exactly like their 1.1 counterparts", () => {
    // The 1.0 models are strict subsets: vs_1_1 only adds the address
    // register, ps_1_1 only adds instructions a 1.0 shader cannot contain.
    // A device advertising vs_1_1/ps_1_4 therefore has to run them, and the
    // same bytecode with the minor version dropped must translate the same
    // way. 3DMark 2001 assembles most of its shaders as `vs.1.0`.
    const withVersion = (list, version) =>
        list.map((token, index) => (index === 0 ? version : token));
    // Everything but the header comment, which names the model it came from.
    const body = wgsl => wgsl.slice(wgsl.indexOf("\n") + 1);

    const vs10 = compileOk(withVersion(VS_1_1_TRANSFORM, VS(1, 0)), "vs_1_0");
    assert.deepStrictEqual(vs10.reflection.version, { major: 1, minor: 0 });
    assert.strictEqual(body(vs10.wgsl),
        body(compileOk(VS_1_1_TRANSFORM, "vs_1_1").wgsl));

    const ps10 = compileOk(withVersion(PS_1_1_MODULATE, PS(1, 0)), "ps_1_0");
    assert.deepStrictEqual(ps10.reflection.version, { major: 1, minor: 0 });
    assert.strictEqual(body(ps10.wgsl),
        body(compileOk(PS_1_1_MODULATE, "ps_1_1").wgsl));
});

test("ps_2_0: dcl_2d, def and texld produce a sampler pair and a constant default", () => {
    const { wgsl, reflection } = compileOk(PS_2_0_TEXTURED, "ps_2_0");
    assert.deepStrictEqual(reflection.samplers, [
        { index: 0, type: "2d", depth: false, textureBinding: 2, samplerBinding: 3 },
    ]);
    assert.ok(wgsl.includes("@group(0) @binding(2) var d9_tex0: texture_2d<f32>;"));
    assert.ok(wgsl.includes("@group(0) @binding(3) var d9_smp0: sampler;"));
    // The pixel-stage constant buffer is binding 1 (vertex takes binding 0).
    assert.ok(wgsl.includes("@group(0) @binding(1) var<uniform> d9c: D9Constants;"));
    assert.strictEqual(reflection.floatDefaults.length, 1);
    assert.strictEqual(reflection.floatDefaults[0].register, 0);
    assert.deepStrictEqual(reflection.floatDefaults[0].values.map(v => Math.round(v * 100) / 100),
        [0.5, 0.25, 0, 1]);
    assert.ok(wgsl.includes("result.color0 = oC0;"), "ps_2_0 output should come from oC0");
    // The coordinate is a 2D sampler's, so only .xy is taken.
    assert.ok(/textureSample\(d9_tex0, d9_smp0, _uv\d+\.xy\)/.test(wgsl),
        "2D sample did not use a two-component coordinate:\n" + wgsl);
});

test("ps_2_0 def registers count towards the float constant region", () => {
    const { reflection } = compileOk(PS_2_0_TEXTURED, "ps_2_0");
    assert.strictEqual(reflection.floatConstCount, 1);
    assert.strictEqual(reflection.floatRegionBytes, 16);
});

test("vs_2_0 flow control: rep/if/mova/relative addressing all translate", () => {
    const { wgsl, reflection } = compileOk(VS_2_0_FLOW, "vs_2_0 flow");
    assert.ok(/for \(var _rep\d+ = 0; _rep\d+ < d9c\.i\[0\]\.x;/.test(wgsl),
        "rep i0 did not become a bounded loop:\n" + wgsl);
    assert.ok(wgsl.includes("if ((d9c.b[0][0] != 0u))"), "if b0 did not read the bool register");
    assert.ok(wgsl.includes("a0 = vec4<i32>(a0f);"), "mova did not update a0");
    assert.ok(wgsl.includes("clamp(a0.x + 2, 0, 255)"),
        "relative addressing was not clamped into the constant file:\n" + wgsl);
    // Relative addressing forces the full 256-register file to be uploaded.
    assert.strictEqual(reflection.usesRelativeConstants, true);
    assert.strictEqual(reflection.floatConstCount, 256);
    assert.strictEqual(reflection.intConstCount, 1);
    assert.strictEqual(reflection.boolVectorCount, 1);
    assert.deepStrictEqual(reflection.intDefaults, [{ register: 0, values: [4, 0, 1, 0] }]);
    assert.deepStrictEqual(reflection.boolDefaults, [{ register: 0, value: true }]);
});

test("vs_2_0 subroutine: label bodies become functions defined before the caller", () => {
    const { wgsl } = compileOk(VS_2_0_SUBROUTINE, "vs_2_0 subroutine");
    const subroutineAt = wgsl.indexOf("fn d9_sub0()");
    const bodyAt = wgsl.indexOf("fn d9_body()");
    assert.ok(subroutineAt >= 0, "subroutine was not emitted");
    assert.ok(bodyAt > subroutineAt, "subroutine must precede its caller in WGSL");
    assert.ok(wgsl.includes("d9_sub0();"), "the call site was not emitted");
    // The trailing top-level `ret` ends main; it must not leave a stray
    // `return;` that would skip the output assembly.
    const body = wgsl.slice(bodyAt, wgsl.indexOf("}", bodyAt));
    assert.ok(!body.includes("return;"), "top-level ret leaked into the body:\n" + body);
});

test("write masks become per-component assignments (WGSL has no swizzle lvalue)", () => {
    const { wgsl } = compileOk([
        VS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 0, { mask: 0x5 }), src(REG.INPUT, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0),
        END,
    ], "write mask");
    assert.ok(/r0\.x = _v\d+\.x;/.test(wgsl), "missing .x component store:\n" + wgsl);
    assert.ok(/r0\.z = _v\d+\.z;/.test(wgsl), "missing .z component store:\n" + wgsl);
    assert.ok(!/r0\.y = /.test(wgsl), "masked-out .y was written anyway");
    assert.ok(!/\.xz = /.test(wgsl), "emitted an illegal multi-component swizzle assignment");
});

test("_sat destination modifier clamps, source modifiers apply after swizzle", () => {
    const { wgsl } = compileOk([
        VS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        // mov_sat r0, -v0.yxwz
        instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 0, { modifier: 1 }),
            src(REG.INPUT, 0, { swizzle: swizzle("yxwz"), modifier: 1 }),
        instruction(OP.MOV, { length: 2 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0),
        END,
    ], "modifiers");
    assert.ok(wgsl.includes("clamp("), "_sat did not clamp");
    assert.ok(wgsl.includes("-((vin0).yxwz)"),
        "negate should wrap the swizzled read, got:\n" + wgsl);
});

test("texkill emits a discard over the ps_1_x three-component rule", () => {
    const { wgsl } = compileOk([
        PS(1, 1),
        instruction(OP.TEXKILL), dst(REG.TEXTURE, 0),
        instruction(OP.MOV), dst(REG.TEMP, 0), src(REG.TEXTURE, 0),
        END,
    ], "texkill");
    assert.ok(wgsl.includes("discard;"), "texkill did not discard");
    assert.ok(wgsl.includes("(t0).xyz < vec3<f32>(0.0)"),
        "ps_1_x texkill must test three components:\n" + wgsl);
});

test("ps_2_0 texkill tests four components", () => {
    const { wgsl } = compileOk([
        PS(2, 0),
        instruction(OP.TEXKILL, { length: 1 }), dst(REG.TEMP, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ], "texkill 2.0");
    assert.ok(wgsl.includes("(r0).xyzw < vec4<f32>(0.0)"),
        "ps_2_0 texkill must test four components:\n" + wgsl);
});

test("ps_3_0 vPos/vFace map onto WGSL builtins", () => {
    const { wgsl, reflection } = compileOk([
        PS(3, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.COLOR, 0), dst(REG.INPUT, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 0), src(REG.MISCTYPE, 0),
        instruction(OP.MAD, { length: 4 }), dst(REG.TEMP, 0), src(REG.TEMP, 0),
            src(REG.MISCTYPE, 1), src(REG.INPUT, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ], "ps_3_0 misc");
    assert.strictEqual(reflection.readsFragmentPosition, true);
    assert.strictEqual(reflection.readsFrontFacing, true);
    assert.ok(wgsl.includes("@builtin(front_facing) d9_front: bool"));
    assert.ok(wgsl.includes("d9_frag_position = stage_in.position;"));
    assert.ok(wgsl.includes("floor(d9_frag_position.xy)"),
        "vPos should report integer pixel coordinates");
});

test("vs_3_0 output semantics come from dcl, not from the register number", () => {
    // dcl_position o3 / dcl_texcoord0 o0 -- deliberately swapped versus the
    // vs_1_1 fixed mapping, which is exactly what vs_3_0 allows.
    const { wgsl } = compileOk([
        VS(3, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.OUTPUT, 3),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.OUTPUT, 0),
        instruction(OP.M4x4, { length: 3 }), dst(REG.OUTPUT, 3), src(REG.INPUT, 0), src(REG.CONST, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.OUTPUT, 0), src(REG.INPUT, 0),
        END,
    ], "vs_3_0 outputs");
    assert.ok(wgsl.includes("o_position = "), "o3 (dcl_position) did not become the position");
    assert.ok(wgsl.includes("o_varying2 = "), "o0 (dcl_texcoord0) did not become TEXCOORD0");
});

test("every vertex shader emits the full varying set so VS/PS always link", () => {
    const { wgsl } = compileOk(VS_1_1_TRANSFORM, "vs_1_1");
    for (let slot = 0; slot < pipeline.VARYING_COUNT; ++slot)
        assert.ok(wgsl.includes("@location(" + slot + ") varying" + slot + ": vec4<f32>,"),
            "varying slot " + slot + " missing from the vertex output struct");
});

test("ps_1_x texbem displaces the coordinate by the stage's bump matrix", () => {
    const result = compileOk([
        PS(1, 1),
        instruction(OP.TEX), dst(REG.TEXTURE, 0),
        instruction(OP.TEXBEM), dst(REG.TEXTURE, 1), src(REG.TEXTURE, 0),
        END,
    ]);
    // The displacement must be the D3D formula -- u by (m00, m10) and v by
    // (m01, m11) -- against the bump register, not an axis-swapped variant.
    // Getting the transpose wrong still renders a plausible bumpy surface, so
    // the shape of the expression is the only thing that catches it.
    assert.match(result.wgsl, /bump\[1\]\.x \* \([^)]*\)\.x \+ d9c\.bump\[1\]\.z \* \([^)]*\)\.y/,
        "u displacement should be m00*du + m10*dv: " + result.wgsl);
    assert.match(result.wgsl, /bump\[1\]\.y \* \([^)]*\)\.x \+ d9c\.bump\[1\]\.w \* \([^)]*\)\.y/,
        "v displacement should be m01*du + m11*dv");
    assert.strictEqual(result.reflection.bumpStageCount, 2,
        "the bump matrix array must cover sampler 1");
    assert.ok(result.reflection.bumpOffset >= 0,
        "the reflection must tell the host where to write the bump matrices");
});

test("ps_1_x texbeml scales by luminance from the bump map's blue channel", () => {
    const result = compileOk([
        PS(1, 1),
        instruction(OP.TEX), dst(REG.TEXTURE, 0),
        instruction(OP.TEXBEML), dst(REG.TEXTURE, 1), src(REG.TEXTURE, 0),
        END,
    ]);
    assert.match(result.wgsl, /clamp\(d9c\.bump_lum\[1\]\.x \* \([^)]*\)\.z \+ d9c\.bump_lum\[1\]\.y, 0\.0, 1\.0\)/,
        "luminance should be scale*b + offset, clamped: " + result.wgsl);
});

test("ps_1_4 bem displaces a coordinate by the stage's bump matrix", () => {
    // The ps_1_4 spelling of the same transform, as an arithmetic instruction
    // with no sample: texcrd brings the coordinate into r1, texld the (du, dv)
    // pair into r0, and bem writes the displaced coordinate back for the
    // second phase to sample with.
    const result = compileOk([
        PS(1, 4),
        instruction(OP.TEXCOORD), dst(REG.TEMP, 1), src(REG.TEXTURE, 1),
        instruction(OP.TEX), dst(REG.TEMP, 0), src(REG.TEXTURE, 0),
        instruction(OP.BEM), dst(REG.TEMP, 1, { mask: 0x3 }),
            src(REG.TEMP, 1), src(REG.TEMP, 0),
        END,
    ]);
    // Same matrix convention as texbem, and the stage is the *destination*
    // register's index -- getting that from a source instead reads an
    // unwritten matrix and displaces by zero.
    assert.match(result.wgsl,
        /\w+\.x \+ d9c\.bump\[1\]\.x \* \w+\.x \+ d9c\.bump\[1\]\.z \* \w+\.y/,
        "r should be src0.r + m00*du + m10*dv: " + result.wgsl);
    assert.match(result.wgsl,
        /\w+\.y \+ d9c\.bump\[1\]\.y \* \w+\.x \+ d9c\.bump\[1\]\.w \* \w+\.y/,
        "g should be src0.g + m01*du + m11*dv");
    // bem writes .rg only. b and a of the destination must survive it.
    assert.match(result.wgsl, /r1\.x = /, "bem must write r");
    assert.match(result.wgsl, /r1\.y = /, "bem must write g");
    assert.ok(!/r1\.z = |r1\.w = /.test(result.wgsl),
        "bem must not touch b or a: " + result.wgsl);
    assert.strictEqual(result.reflection.bumpStageCount, 2,
        "the bump matrix array must cover stage 1");
});

test("ps_1_x texm3x3 forms build their coordinate from the preceding pads", () => {
    const result = compileOk([
        PS(1, 1),
        instruction(OP.TEX), dst(REG.TEXTURE, 0),
        instruction(OP.TEXM3x3PAD), dst(REG.TEXTURE, 1), src(REG.TEXTURE, 0),
        instruction(OP.TEXM3x3PAD), dst(REG.TEXTURE, 2), src(REG.TEXTURE, 0),
        instruction(OP.TEXM3x3TEX), dst(REG.TEXTURE, 3), src(REG.TEXTURE, 0),
        END,
    ]);
    // Three dot products, assembled into one vec3 that samples a cube map --
    // the shape tangent-space environment mapping needs.
    assert.strictEqual((result.wgsl.match(/let _m3row\d+ = dot\(/g) || []).length, 3,
        "each pad plus the tex should contribute one row: " + result.wgsl);
    assert.match(result.wgsl, /let _m3x3\d+ = vec3<f32>\(_m3row\d+, _m3row\d+, _m3row\d+\)/,
        "the three rows should assemble into a vec3 coordinate");
    assert.strictEqual(result.reflection.samplers.find(s => s.index === 3).type,
        "cube", "a texm3x3tex addresses a cube map");
});

test("ps_1_x instructions with no honest translation are still refused", () => {
    // TEXDEPTH replaces the fragment's depth from a texture-addressing result,
    // which this pipeline has no frag_depth path for. Refusing keeps it out of
    // the "renders something plausible but wrong" category.
    const result = pipeline.compileShader(tokens([
        PS(1, 4),
        instruction(OP.TEXDEPTH), dst(REG.TEMP, 0),
        END,
    ]));
    assert.strictEqual(result.ok, false);
    assert.ok(/texdepth/.test(result.error),
        "error should name the instruction: " + result.error);
});

test("vs_3_0 vertex texture fetch uses an explicit LOD and isolated bindings", () => {
    const result = compileOk([
        VS(3, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(0, 0, 2), dst(REG.SAMPLER, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION),
            dst(REG.INPUT, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION),
            dst(REG.OUTPUT, 0),
        instruction(OP.TEXLDL, { length: 3 }), dst(REG.TEMP, 0),
            src(REG.INPUT, 0), src(REG.SAMPLER, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.OUTPUT, 0),
            src(REG.TEMP, 0),
        END,
    ], "vs_3_0 vertex texture fetch");
    assert.match(result.wgsl, /textureSampleLevel\(d9_tex0, d9_smp0/);
    assert.match(result.wgsl, /@binding\(34\) var d9_tex0/);
    assert.deepStrictEqual(result.reflection.samplers, [{ index: 0, type: "2d",
        depth: false, textureBinding: 34, samplerBinding: 35 }]);
});

test("a truncated token stream is reported, never silently half-translated", () => {
    const result = pipeline.compileShader(tokens([
        VS(2, 0), instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 0),
    ]));
    assert.strictEqual(result.ok, false);
});

test("a non-shader blob is rejected by the version token", () => {
    const result = pipeline.compileShader(tokens([0x12345678, 0, END]));
    assert.strictEqual(result.ok, false);
    assert.ok(/not a D3D9 shader/.test(result.error), result.error);
});

test("comment tokens (the D3DX/fxc signature blocks) are skipped", () => {
    const withComment = [
        VS(1, 1),
        // D3DSIO_COMMENT with three payload DWORDs.
        (0xfffe | (3 << 16)) >>> 0, 0xdeadbeef, 0xcafebabe, 0x00c0ffee,
        instruction(OP.DCL), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.M4x4), dst(REG.RASTOUT, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
        END,
    ];
    const { reflection } = compileOk(withComment, "comment");
    assert.strictEqual(reflection.floatConstCount, 4);
    assert.strictEqual(reflection.inputs.length, 1);
});

test("setp writes the predicate that predication reads, per component", () => {
    const { wgsl, reflection } = compileOk([
        VS(2, 1),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.SETP, { length: 3, control: 1 /* gt */ }),
            dst(REG.PREDICATE, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
        // dst + predicate token + one source == three tokens after the
        // instruction token, which is what the SM2.0 length field must say.
        instruction(OP.MOV, { length: 3, predicated: true }), dst(REG.TEMP, 0),
            src(REG.PREDICATE, 0, { swizzle: swizzle("yxwz") }), src(REG.CONST, 1),
        instruction(OP.MOV, { length: 2 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0),
        END,
    ], "predicate");
    // (S2-9: setp used to write a p0f nothing read, so predication never ran)
    assert.ok(!/\bp0f\b/.test(wgsl), "setp writes p0 itself:\n" + wgsl);
    assert.match(wgsl, /\bp0(\.x)? = /, "setp assigns the predicate");
    // r0.x is gated by p0.y, r0.y by p0.x, ... -- the predicate's swizzle
    for (const [component, gate] of [["x", "y"], ["y", "x"], ["z", "w"], ["w", "z"]])
        assert.match(wgsl, new RegExp("r0\\." + component + " = select\\(r0\\." + component +
            ", [^,]+, p0\\." + gate + "\\);"), "r0." + component + " gated by p0." + gate + ":\n" + wgsl);
    assert.strictEqual(reflection.floatConstCount, 2);
});

test("hashTokens is stable and distinguishes single-bit differences", () => {
    const a = pipeline.hashTokens(tokens(VS_1_1_TRANSFORM));
    const b = pipeline.hashTokens(tokens(VS_1_1_TRANSFORM));
    const c = pipeline.hashTokens(tokens(PS_1_1_MODULATE));
    assert.deepStrictEqual(a, b);
    assert.notDeepStrictEqual(a, c);
    const mutated = VS_1_1_TRANSFORM.slice();
    mutated[mutated.length - 2] ^= 1;
    assert.notDeepStrictEqual(a, pipeline.hashTokens(tokens(mutated)));
});

test("the shader cache translates identical bytecode exactly once", () => {
    const cache = new pipeline.D3D9ShaderCache();
    const stream = tokens(VS_1_1_TRANSFORM);
    const hash = pipeline.hashTokens(stream);
    const first = cache.compile(stream, hash.low, hash.high);
    const second = cache.compile(stream, hash.low, hash.high);
    assert.strictEqual(first, second, "cache returned a different object");
    assert.strictEqual(cache.stats.compiles, 1);
    assert.strictEqual(cache.stats.hits, 1);
});

test("the shader cache remembers failures instead of retrying them every frame", () => {
    const cache = new pipeline.D3D9ShaderCache();
    const stream = tokens([PS(1, 4), instruction(OP.TEXDEPTH),
        dst(REG.TEMP, 0), END]);
    const hash = pipeline.hashTokens(stream);
    assert.strictEqual(cache.compile(stream, hash.low, hash.high).ok, false);
    assert.strictEqual(cache.compile(stream, hash.low, hash.high).ok, false);
    assert.strictEqual(cache.stats.compiles, 1);
    assert.strictEqual(cache.stats.failures, 1);
});

test("the shader cache evicts least-recently-used entries at its limit", () => {
    const cache = new pipeline.D3D9ShaderCache({ limit: 2 });
    const make = seed => {
        const list = VS_1_1_TRANSFORM.slice();
        list[list.length - 2] = src(REG.INPUT, seed);
        return tokens(list);
    };
    for (const seed of [1, 2, 3]) {
        const stream = make(seed);
        const hash = pipeline.hashTokens(stream);
        cache.compile(stream, hash.low, hash.high);
    }
    assert.strictEqual(cache.entries.size, 2);
    assert.strictEqual(cache.stats.evictions, 1);
});

test("shader cache reports compile latency/size and survives persistence", () => {
    const times = [10, 12.5];
    const cache = new pipeline.D3D9ShaderCache({ clock: () => times.shift() });
    const stream = tokens(VS_1_1_TRANSFORM);
    const hash = pipeline.hashTokens(stream);
    const translated = cache.compile(stream, hash.low, hash.high);
    const stats = cache.snapshot();
    assert.equal(stats.misses, 1);
    assert.equal(stats.compileLatencyMs.p50, 2.5);
    assert.equal(stats.compileLatencyMs.p95, 2.5);
    assert.equal(stats.cached, 1);
    assert.equal(stats.totalWGSLBytes, translated.wgsl.length * 2);

    const restored = new pipeline.D3D9ShaderCache();
    assert.equal(restored.importEntries(cache.exportEntries()), 1);
    const before = restored.stats.compiles;
    assert.equal(restored.compile(stream, hash.low, hash.high).ok, true);
    assert.equal(restored.stats.compiles, before,
        "a restored shader should be a cache hit, not a retranslation");
    assert.equal(restored.snapshot().restored, 1);

    // A payload carrying another build's translations must be refused rather
    // than restored. Accepting it means this session runs WGSL and reflection
    // this file no longer produces -- which is invisible, survives a reload,
    // and makes a translator fix appear to do nothing for exactly the shaders
    // that have been seen before. The storage `version` cannot catch it: that
    // describes the envelope, and the envelope did not change.
    const stale = cache.exportEntries();
    assert.equal(stale.revision, pipeline.TRANSLATOR_REVISION,
        "an exported payload has to record which translator wrote it");
    stale.revision = stale.revision + "-other-build";
    assert.equal(new pipeline.D3D9ShaderCache().importEntries(stale), 0,
        "entries from a different translator build must not be restored");
    const missing = cache.exportEntries();
    delete missing.revision;
    assert.equal(new pipeline.D3D9ShaderCache().importEntries(missing), 0,
        "a payload predating the revision field is from an older build too");
});

test("arithmetic opcodes translate to their WGSL equivalents", () => {
    const cases = [
        [OP.ADD, 2, "(vin0) + (vin0)"],
        [OP.MUL, 2, "(vin0) * (vin0)"],
        [OP.MIN, 2, "min(vin0, vin0)"],
        [OP.MAX, 2, "max(vin0, vin0)"],
        [OP.DP3, 2, "dot((vin0).xyz, (vin0).xyz)"],
        [OP.DP4, 2, "dot(vin0, vin0)"],
        [OP.MAD, 3, "(vin0) * (vin0) + (vin0)"],
        [OP.LRP, 3, "mix(vin0, vin0, vin0)"],
        [OP.FRC, 1, "fract(vin0)"],
        [OP.ABS, 1, "abs(vin0)"],
        [OP.RCP, 1, "d9_rcp((vin0).x)"],
        [OP.RSQ, 1, "d9_rsq((vin0).x)"],
        [OP.LIT, 1, "d9_lit(vin0)"],
        [OP.NRM, 1, "d9_normalize((vin0).xyz)"],
        [OP.CRS, 2, "cross((vin0).xyz, (vin0).xyz)"],
        [OP.POW, 2, "d9_pow((vin0).x, (vin0).x)"],
    ];
    for (const [opcode, sourceCount, expected] of cases) {
        const list = [
            VS(2, 0),
            instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
            instruction(opcode, { length: 1 + sourceCount }), dst(REG.TEMP, 0),
        ];
        for (let i = 0; i < sourceCount; ++i) list.push(src(REG.INPUT, 0));
        list.push(instruction(OP.MOV, { length: 2 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0));
        list.push(END);
        const { wgsl } = compileOk(list, "opcode " + opcode);
        assert.ok(wgsl.includes(expected),
            "opcode " + opcode + " did not emit `" + expected + "`");
    }
});

test("cmp/slt/sge use select() with the right operand order", () => {
    const build = opcode => {
        const list = [
            VS(2, 0),
            instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
            instruction(opcode, { length: 4 }), dst(REG.TEMP, 0),
            src(REG.INPUT, 0), src(REG.CONST, 0),
        ];
        if (opcode === OP.CMP) list.push(src(REG.CONST, 1));
        list.push(instruction(OP.MOV, { length: 2 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0));
        list.push(END);
        return compileOk(list, "opcode " + opcode).wgsl;
    };
    // cmp dst, a, b, c  ->  dst = a >= 0 ? b : c, i.e. select(c, b, a >= 0).
    assert.ok(build(OP.CMP).includes(
        "select(d9c.f[1], d9c.f[0], (vin0) >= vec4<f32>(0.0))"), "cmp operand order");
    assert.ok(build(OP.SLT).includes(
        "select(vec4<f32>(0.0), vec4<f32>(1.0), (vin0) < (d9c.f[0]))"), "slt");
    assert.ok(build(OP.SGE).includes(
        "select(vec4<f32>(0.0), vec4<f32>(1.0), (vin0) >= (d9c.f[0]))"), "sge");
});

test("loop/endloop drives aL from the integer register's y/z fields", () => {
    const { wgsl } = compileOk([
        VS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.DEFI, { length: 5 }), dst(REG.CONSTINT, 0), 4, 2, 1, 0,
        instruction(OP.LOOP, { length: 2 }), src(REG.LOOP, 0), src(REG.CONSTINT, 0),
        // The relative-addressing token counts towards the instruction
        // length: dst + r0 + c[..] + the aL index token == four.
        instruction(OP.ADD, { length: 4 }), dst(REG.TEMP, 0), src(REG.TEMP, 0),
            src(REG.CONST, 0, { relative: true }), src(REG.LOOP, 0),
        instruction(OP.ENDLOOP),
        instruction(OP.MOV, { length: 2 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0),
        END,
    ], "loop");
    assert.ok(wgsl.includes("aL = d9c.i[0].y;"), "aL was not initialised from i0.y");
    assert.ok(wgsl.includes("aL = aL + d9c.i[0].z;"), "aL was not stepped by i0.z");
    assert.ok(wgsl.includes("clamp(aL + 0, 0, 255)"),
        "c[aL] relative addressing did not use the loop counter:\n" + wgsl);
});

test("uniform sizing: the reflection describes the exact packed layout", () => {
    const { reflection } = compileOk(VS_2_0_FLOW, "vs_2_0 flow");
    assert.strictEqual(reflection.floatRegionBytes, 256 * 16);
    assert.strictEqual(reflection.intRegionBytes, 16);
    assert.strictEqual(reflection.boolRegionBytes, 16);
    const registerBytes = reflection.floatRegionBytes +
        reflection.intRegionBytes + reflection.boolRegionBytes;
    // A vertex shader carries one extra vec4 past the register file: the
    // viewport the half-pixel offset is measured against.
    assert.strictEqual(reflection.viewportOffset, registerBytes);
    assert.strictEqual(reflection.uniformBytes, registerBytes + 16);
});

test("a pixel shader carries no viewport uniform", () => {
    const { reflection } = compileOk(PS_2_0_TEXTURED, "ps_2_0 textured");
    assert.strictEqual(reflection.viewportOffset, -1,
        "the half-pixel offset is a vertex-stage concern only");
    assert.strictEqual(reflection.uniformBytes,
        reflection.floatRegionBytes + reflection.intRegionBytes +
        reflection.boolRegionBytes);
});

// Point-sprite expansion appends its own fields, which have to start after the
// viewport rather than on top of it.
test("point-sprite uniforms sit past the viewport, not on it", () => {
    const result = pipeline.compileShader(tokens(VS_1_1_TRANSFORM),
        { pointExpansion: true });
    assert.ok(result.ok, result.error);
    const reflection = result.reflection;
    const registerBytes = reflection.floatRegionBytes +
        reflection.intRegionBytes + reflection.boolRegionBytes;
    assert.strictEqual(reflection.viewportOffset, registerBytes);
    assert.strictEqual(reflection.pointViewportOffset, registerBytes + 16);
    assert.strictEqual(reflection.pointParamsOffset, registerBytes + 32);
    assert.strictEqual(reflection.uniformBytes, registerBytes + 48);
});

test("M5 compact skinning inputs are converted to D3D9 float4 registers", () => {
    const result = pipeline.compileShader(tokens(VS_1_1_TRANSFORM), {
        inputConversions: { 0: "dec3n", 1: "ubyte4" },
    });
    assert.ok(result.ok, result.error);
    assert.ok(result.wgsl.includes("@location(0) in0: u32"),
        "DEC3N must arrive as its packed uint32 storage");
    assert.ok(result.wgsl.includes("d9_unpack_dec3n(in0)"),
        "DEC3N was not sign-extended and normalised");
    assert.ok(result.wgsl.includes("@location(1) in1: vec4<u32>"),
        "UBYTE4 must use an integer vertex input");
    assert.ok(result.wgsl.includes("vin1 = vec4<f32>(in1)"),
        "UBYTE4 was not converted to the float4 D3D9 exposes");
});

test("projection source modifiers preserve a negative divisor", () => {
    const result = compileOk([
        VS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION),
            dst(REG.INPUT, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 0),
            src(REG.INPUT, 0, { modifier: 9 /* _dz */ }),
        instruction(OP.MOV, { length: 2 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0),
        END,
    ], "signed projective divide");
    assert.ok(result.wgsl.includes("select(-max(abs("),
        "negative q must not be clamped to a positive epsilon");
});

test("point-sprite vertex variants expand oPts into a six-vertex quad", () => {
    const bytecode = [
        VS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION),
            dst(REG.INPUT, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.RASTOUT, 0),
            src(REG.INPUT, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.RASTOUT, 2),
            src(REG.CONST, 0),
        END,
    ];
    const result = pipeline.compileShader(tokens(bytecode),
        { pointExpansion: true, pointSprite: true });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.reflection.writesPointSize, true);
    assert.equal(result.reflection.pointExpansion, true);
    assert.equal(result.reflection.pointParamsOffset + 16,
        result.reflection.uniformBytes);
    assert.ok(result.wgsl.includes("@builtin(vertex_index) d9_vertex_index"));
    assert.ok(result.wgsl.includes("var d9_point_size = o_pointsize.x"));
    assert.ok(result.wgsl.includes("result.varying2 = vec4<f32>(d9_point_uv"),
        "POINTSPRITEENABLE must synthesize TEXCOORD0");
});

test("generated WGSL is brace-balanced and declares every register it reads", () => {
    for (const [name, list] of [
        ["vs_1_1", VS_1_1_TRANSFORM], ["ps_1_1", PS_1_1_MODULATE],
        ["ps_2_0", PS_2_0_TEXTURED], ["vs_2_0 flow", VS_2_0_FLOW],
        ["vs_2_0 subroutine", VS_2_0_SUBROUTINE],
    ]) {
        const { wgsl } = compileOk(list, name);
        let depth = 0;
        for (const character of wgsl) {
            if (character === "{") ++depth;
            else if (character === "}") --depth;
            assert.ok(depth >= 0, name + ": unbalanced closing brace");
        }
        assert.strictEqual(depth, 0, name + ": unbalanced braces");
        // Every rN/tN/vinN referenced must have a var<private> declaration.
        const referenced = new Set(wgsl.match(/\b(?:r|t|vin)\d+\b/g) || []);
        for (const register of referenced) {
            if (/^t\d+$/.test(register) && !wgsl.includes("var<private> " + register))
                continue; // `t` also appears inside generated temp names
            assert.ok(wgsl.includes("var<private> " + register + ":"),
                name + ": " + register + " is used but never declared");
        }
    }
});

// Derivative/texture execution semantics are checked by actual pixel readback
// in d3d_shader_texture_browser_test.html, replacing the old assertions that
// required hoisting and its zero/LOD-zero fallbacks.

test("SM3 semantic linking preserves every declared packed component", () => {
    const vs = {version: {major: 3}, outputDeclarations: [
        {register: 2, usage: 3, usageIndex: 4, mask: 7},
        {register: 2, usage: 10, usageIndex: 0, mask: 8},
        {register: 9, usage: 5, usageIndex: 15, mask: 15}]};
    const ps = {version: {major: 3}, inputDeclarations: [
        {register: 0, usage: 5, usageIndex: 15, mask: 5},
        {register: 7, usage: 3, usageIndex: 4, mask: 7},
        {register: 7, usage: 10, usageIndex: 0, mask: 8}]};
    const pair = pipeline.linkShaderSemantics(vs, ps);
    assert.ok(pair.ok, pair.error);
    const outputs = {2: [.1, .2, .3, .4], 9: [.5, .6, .7, .8]}, stage = {}, inputs = {};
    for (const item of pair.link.vertex) stage[item.slot * 4 + item.channel] = outputs[item.register][item.component];
    for (const item of pair.link.pixel) (inputs[item.register] ||= [0, 0, 0, 0])[item.component] = stage[item.slot * 4 + item.channel];
    assert.deepStrictEqual(inputs, {0: [.5, 0, .7, 0], 7: [.1, .2, .3, .4]});
    assert.deepStrictEqual(pair.link.flatSlots, [2]);
    assert.strictEqual(pair.key, pipeline.linkShaderSemantics(vs, ps).key);
    assert.notStrictEqual(pair.key, pipeline.linkShaderSemantics(vs, {...ps, inputDeclarations: ps.inputDeclarations.slice(1)}).key);
});

test("SM3 semantic linking rejects incompatible declarations before GPU pipeline creation", () => {
    const item = {register: 0, usage: 3, usageIndex: 0, mask: 7};
    const vertex = outputDeclarations => ({version: {major: 3}, outputDeclarations});
    const pixel = inputDeclarations => ({version: {major: 3}, inputDeclarations});
    for (const [outputs, inputs] of [
        [[item], [{...item, usageIndex: 1}]], [[item], [{...item, mask: 15}]],
        [[item, {...item, register: 1}], [item]], [[item], [item, {...item, register: 1}]],
        [[item, {...item, usageIndex: 1}], [item]],
        [[item, {...item, usageIndex: 1, register: 1}], [item, {...item, usageIndex: 1}]],
        [[{...item, register: 12}], [item]], [[item], [{...item, register: 10}]],
    ]) assert.strictEqual(pipeline.linkShaderSemantics(vertex(outputs), pixel(inputs)).ok, false);
    assert.strictEqual(pipeline.linkShaderSemantics(null, pixel([item])).ok, false);
    const legacy = pipeline.linkShaderSemantics(null, pixel([{...item, usage: 10, mask: 15}]));
    assert.ok(legacy.ok);
    assert.strictEqual(legacy.link.vertex, null);
    assert.deepStrictEqual(legacy.link.flatSlots, [0, 1]);
    assert.deepStrictEqual(legacy.link.pixel.map(entry => entry.slot), [0, 0, 0, 0]);
});

test("SM3 reflection retains multiple declarations on one physical register", () => {
    const make = kind => pipeline.compileShader([
        kind === "vertex" ? VS(3, 0) : PS(3, 0),
        instruction(OP.DCL, {length: 2}), dclToken(USAGE.NORMAL), dst(kind === "vertex" ? REG.OUTPUT : REG.INPUT, 3, {mask: 7}),
        instruction(OP.DCL, {length: 2}), dclToken(USAGE.COLOR, 2), dst(kind === "vertex" ? REG.OUTPUT : REG.INPUT, 3, {mask: 8}),
        instruction(OP.MOV, {length: 2}), dst(kind === "vertex" ? REG.OUTPUT : REG.COLOROUT, kind === "vertex" ? 3 : 0),
        src(kind === "vertex" ? REG.CONST : REG.INPUT, kind === "vertex" ? 0 : 3), END]);
    const vs = make("vertex"), ps = make("pixel");
    assert.ok(vs.ok && ps.ok, vs.error || ps.error);
    assert.strictEqual(vs.reflection.outputDeclarations.length, 2);
    assert.strictEqual(ps.reflection.inputDeclarations.length, 2);
    const pair = pipeline.linkShaderSemantics(vs.reflection, ps.reflection);
    assert.ok(pair.ok, pair.error);
    assert.strictEqual(pair.link.vertex.length, 4);
    assert.strictEqual(pair.link.pixel.length, 4);
});

// ---- report ----

if (failures.length) {
    for (const failure of failures) {
        console.error("FAIL " + failure.name);
        console.error("  " + (failure.error && failure.error.message));
        if (process.env.D9_TEST_STACK) console.error(failure.error);
    }
    console.error("\n" + failures.length + " failed, " + passed + " passed");
    process.exit(1);
}
console.log(passed + " shader pipeline tests passed");
