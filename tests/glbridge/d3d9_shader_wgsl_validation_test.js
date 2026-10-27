#!/usr/bin/env node
// Validates that d3d9_shader_pipeline.js emits WGSL a real compiler accepts.
//
// d3d9_shader_pipeline_test.js asserts on translation structure -- which
// registers, varyings and reflection a shader yields -- and would happily pass
// on WGSL that no driver can compile. This file closes that gap by running the
// generated source through `naga`, the WGSL front end wgpu/Firefox use, which
// performs the same shape of validation Chrome's Tint does when
// d3d9_executor.js calls createShaderModule()/getCompilationInfo() (plan 9.6).
// Running it here means a syntax or type error surfaces in Node in one second
// instead of as a black screen inside v86.
//
// naga is optional: install it with
//     cargo install naga-cli
// and either put it on PATH or point D9_NAGA at the binary. Without it this
// test skips (exit 0) rather than failing, so it never blocks a machine that
// only wants the pure-JS suite.

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const pipeline = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js");

function findNaga() {
    if (process.env.D9_NAGA) return process.env.D9_NAGA;
    const probe = spawnSync("naga", ["--version"], { encoding: "utf8" });
    return probe.status === 0 ? "naga" : null;
}

const naga = findNaga();
if (!naga) {
    console.log("SKIP: no `naga` binary (install with `cargo install naga-cli` " +
        "or set D9_NAGA) -- WGSL validation not run");
    process.exit(0);
}

// ---- the same little assembler the structural test uses ----

const VS = (major, minor) => (0xfffe0000 | (major << 8) | minor) >>> 0;
const PS = (major, minor) => (0xffff0000 | (major << 8) | minor) >>> 0;
const END = 0x0000ffff;
const REG = pipeline.REGISTER;
const OP = pipeline.OP;
const NOSWIZZLE = 0xe4;

const regTypeBits = type => (((type & 0x7) << 28) | ((type & 0x18) << 8)) >>> 0;
const swizzle = text => {
    let bits = 0;
    for (let i = 0; i < 4; ++i)
        bits |= "xyzw".indexOf(text[Math.min(i, text.length - 1)]) << (i * 2);
    return bits;
};
const instruction = (opcode, options = {}) =>
    ((opcode & 0xffff) | (((options.control || 0) & 0xff) << 16) |
        (((options.length || 0) & 0xf) << 24) |
        (options.predicated ? 0x10000000 : 0)) >>> 0;
const dst = (type, index, options = {}) =>
    (0x80000000 | (index & 0x7ff) | regTypeBits(type) |
        ((options.mask === undefined ? 0xf : options.mask) << 16) |
        (((options.modifier || 0) & 0xf) << 20) |
        (((options.shift || 0) & 0xf) << 24)) >>> 0;
const src = (type, index, options = {}) =>
    (0x80000000 | (index & 0x7ff) | regTypeBits(type) |
        ((options.swizzle === undefined ? NOSWIZZLE : options.swizzle) << 16) |
        (((options.modifier || 0) & 0xf) << 24) |
        (options.relative ? (1 << 13) : 0)) >>> 0;
const dclToken = (usage, usageIndex = 0, textureType = 0) =>
    (0x80000000 | (usage & 0xf) | ((usageIndex & 0xf) << 16) |
        ((textureType & 0xf) << 27)) >>> 0;
const floatBits = value => {
    const buffer = new ArrayBuffer(4);
    new Float32Array(buffer)[0] = value;
    return new Uint32Array(buffer)[0];
};
const USAGE = { POSITION: 0, NORMAL: 3, PSIZE: 4, TEXCOORD: 5, POSITIONT: 9,
    COLOR: 10, FOG: 11 };

// ---- corpus ----
//
// Each entry is a shader shaped like something a real D3D9 game emits, chosen
// to cover a distinct WGSL construct the translator has to get right.

const CORPUS = [
    // What an assembler actually produces for this model: no dcl_ anywhere,
    // because the instruction post-dates it. v0/v5/v7 mean position, diffuse
    // and texcoord0 by API rule, and the entry point has to declare them as
    // real attributes on their register's location.
    ["vs_1_1 as assembled, with no dcl_ to declare its inputs", [
        VS(1, 1),
        instruction(OP.M4x4), dst(REG.RASTOUT, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
        instruction(OP.MOV), dst(REG.ATTROUT, 0), src(REG.INPUT, 5),
        instruction(OP.MOV), dst(REG.OUTPUT, 0), src(REG.INPUT, 7),
        END,
    ]],
    // The DirectX 8 matrix-palette skinning path. SM1.1 writes its scalar
    // integer address register with MOV (MOVA starts at SM2), then indexes the
    // bone-matrix constants relative to it.
    ["vs_1_1 MOV a0.x matrix-palette skinning", [
        VS(1, 1),
        instruction(OP.MOV), dst(REG.ADDR, 0, { mask: 0x1 }),
            src(REG.INPUT, 2, { swizzle: swizzle("xxxx") }),
        instruction(OP.M4x3), dst(REG.TEMP, 0, { mask: 0x7 }),
            src(REG.INPUT, 0), src(REG.CONST, 4, { relative: true }),
        instruction(OP.MOV), dst(REG.RASTOUT, 0), src(REG.TEMP, 0),
        END,
    ]],
    ["vs_1_1 world transform + texcoord passthrough", [
        VS(1, 1),
        instruction(OP.DCL), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.DCL), dclToken(USAGE.COLOR, 0), dst(REG.INPUT, 1),
        instruction(OP.DCL), dclToken(USAGE.TEXCOORD, 0), dst(REG.INPUT, 2),
        instruction(OP.M4x4), dst(REG.RASTOUT, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
        instruction(OP.MOV), dst(REG.ATTROUT, 0), src(REG.INPUT, 1),
        instruction(OP.MOV), dst(REG.OUTPUT, 0), src(REG.INPUT, 2),
        END,
    ]],
    ["vs_1_1 diffuse lighting with dp3/max/mul", [
        VS(1, 1),
        instruction(OP.DCL), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.DCL), dclToken(USAGE.NORMAL), dst(REG.INPUT, 1),
        instruction(OP.M4x4), dst(REG.RASTOUT, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
        instruction(OP.DP3), dst(REG.TEMP, 0), src(REG.INPUT, 1), src(REG.CONST, 4),
        instruction(OP.MAX), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.CONST, 5),
        instruction(OP.MUL), dst(REG.ATTROUT, 0), src(REG.TEMP, 0), src(REG.CONST, 6),
        END,
    ]],
    ["vs_1_1 point size and fog rasterizer outputs", [
        VS(1, 1),
        instruction(OP.DCL), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.M4x4), dst(REG.RASTOUT, 0), src(REG.INPUT, 0), src(REG.CONST, 0),
        instruction(OP.MOV), dst(REG.RASTOUT, 1, { mask: 0x1 }),
            src(REG.CONST, 4, { swizzle: swizzle("xxxx") }),
        instruction(OP.MOV), dst(REG.RASTOUT, 2, { mask: 0x1 }),
            src(REG.CONST, 4, { swizzle: swizzle("yyyy") }),
        END,
    ]],
    ["vs_2_0 rep/if/mova/relative addressing", [
        VS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.DEFI, { length: 5 }), dst(REG.CONSTINT, 0), 4, 0, 1, 0,
        instruction(OP.DEFB, { length: 2 }), dst(REG.CONSTBOOL, 0), 1,
        instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 0), src(REG.CONST, 0),
        instruction(OP.MOVA, { length: 2 }), dst(REG.ADDR, 0, { mask: 0x1 }),
            src(REG.INPUT, 0, { swizzle: swizzle("wwww") }),
        instruction(OP.MOV, { length: 3 }), dst(REG.TEMP, 1),
            src(REG.CONST, 2, { relative: true }),
            src(REG.ADDR, 0, { swizzle: swizzle("xxxx") }),
        instruction(OP.REP, { length: 1 }), src(REG.CONSTINT, 0),
        instruction(OP.ADD, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.TEMP, 1),
        instruction(OP.ENDREP),
        instruction(OP.IF, { length: 1 }), src(REG.CONSTBOOL, 0),
        instruction(OP.MUL, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.TEMP, 0),
        instruction(OP.ELSE),
        instruction(OP.ADD, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.CONST, 1),
        instruction(OP.ENDIF),
        instruction(OP.M4x4, { length: 3 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0), src(REG.CONST, 4),
        END,
    ]],
    ["vs_2_0 loop/endloop with c[aL] matrix palette", [
        VS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.DEFI, { length: 5 }), dst(REG.CONSTINT, 0), 4, 8, 1, 0,
        instruction(OP.LOOP, { length: 2 }), src(REG.LOOP, 0), src(REG.CONSTINT, 0),
        instruction(OP.ADD, { length: 4 }), dst(REG.TEMP, 0), src(REG.TEMP, 0),
            src(REG.CONST, 0, { relative: true }), src(REG.LOOP, 0),
        instruction(OP.BREAKC, { length: 2, control: 1 }),
            src(REG.TEMP, 0), src(REG.CONST, 1),
        instruction(OP.ENDLOOP),
        instruction(OP.M4x4, { length: 3 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0), src(REG.CONST, 4),
        END,
    ]],
    ["vs_2_0 subroutine call graph", [
        VS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 0), src(REG.INPUT, 0),
        instruction(OP.CALL, { length: 1 }), src(REG.LABEL, 1),
        instruction(OP.M4x4, { length: 3 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 0), src(REG.CONST, 0),
        instruction(OP.RET),
        // l1 calls l0, and is declared first -- the emitter has to reorder.
        instruction(OP.LABEL, { length: 1 }), src(REG.LABEL, 1),
        instruction(OP.CALL, { length: 1 }), src(REG.LABEL, 0),
        instruction(OP.MUL, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.CONST, 5),
        instruction(OP.RET),
        instruction(OP.LABEL, { length: 1 }), src(REG.LABEL, 0),
        instruction(OP.ADD, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.TEMP, 0),
        instruction(OP.RET),
        END,
    ]],
    ["vs_2_0 lit/dst/sincos/nrm/pow transcendentals", [
        VS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.NRM, { length: 2 }), dst(REG.TEMP, 0), src(REG.INPUT, 0),
        instruction(OP.LIT, { length: 2 }), dst(REG.TEMP, 1), src(REG.TEMP, 0),
        instruction(OP.DST, { length: 3 }), dst(REG.TEMP, 2), src(REG.TEMP, 0), src(REG.TEMP, 1),
        instruction(OP.SINCOS, { length: 4 }), dst(REG.TEMP, 3, { mask: 0x3 }),
            src(REG.TEMP, 2, { swizzle: swizzle("xxxx") }), src(REG.CONST, 1), src(REG.CONST, 2),
        instruction(OP.POW, { length: 3 }), dst(REG.TEMP, 3), src(REG.TEMP, 3), src(REG.CONST, 3),
        instruction(OP.M4x4, { length: 3 }), dst(REG.RASTOUT, 0), src(REG.TEMP, 3), src(REG.CONST, 4),
        END,
    ]],
    ["vs_3_0 dcl-declared outputs in non-default order", [
        VS(3, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.INPUT, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 3), dst(REG.INPUT, 1),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION), dst(REG.OUTPUT, 4),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.COLOR, 1), dst(REG.OUTPUT, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 7), dst(REG.OUTPUT, 2),
        instruction(OP.M4x4, { length: 3 }), dst(REG.OUTPUT, 4), src(REG.INPUT, 0), src(REG.CONST, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.OUTPUT, 0), src(REG.INPUT, 1),
        instruction(OP.MOV, { length: 2 }), dst(REG.OUTPUT, 2), src(REG.INPUT, 1),
        END,
    ]],
    ["vs_3_0 vertex texture fetch", [
        VS(3, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(0, 0, 2),
            dst(REG.SAMPLER, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION),
            dst(REG.INPUT, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.POSITION),
            dst(REG.OUTPUT, 0),
        instruction(OP.TEXLDL, { length: 3 }), dst(REG.TEMP, 0),
            src(REG.INPUT, 0), src(REG.SAMPLER, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.OUTPUT, 0),
            src(REG.TEMP, 0),
        END,
    ]],
    ["ps_1_1 modulate diffuse by texture", [
        PS(1, 1),
        instruction(OP.TEX), dst(REG.TEXTURE, 0),
        instruction(OP.MUL), dst(REG.TEMP, 0), src(REG.TEXTURE, 0), src(REG.INPUT, 0),
        END,
    ]],
    ["ps_1_1 texcoord + texkill + result shift", [
        PS(1, 1),
        instruction(OP.TEXCOORD), dst(REG.TEXTURE, 0),
        instruction(OP.TEXKILL), dst(REG.TEXTURE, 1),
        instruction(OP.MUL), dst(REG.TEMP, 0, { shift: 1 }),
            src(REG.TEXTURE, 0), src(REG.INPUT, 0),
        END,
    ]],
    // The ps_1_x texture-addressing family. These build their sample
    // coordinate out of a bump matrix or a chain of dot products rather than
    // reading a texcoord directly, so they are the entries most likely to
    // produce WGSL that parses but does not type-check.
    ["ps_1_1 texbem environment bump mapping", [
        PS(1, 1),
        instruction(OP.TEX), dst(REG.TEXTURE, 0),
        instruction(OP.TEXBEM), dst(REG.TEXTURE, 1), src(REG.TEXTURE, 0),
        instruction(OP.MOV), dst(REG.TEMP, 0), src(REG.TEXTURE, 1),
        END,
    ]],
    ["ps_1_1 texbeml bump mapping with luminance", [
        PS(1, 1),
        instruction(OP.TEX), dst(REG.TEXTURE, 0),
        instruction(OP.TEXBEML), dst(REG.TEXTURE, 1), src(REG.TEXTURE, 0),
        instruction(OP.MOV), dst(REG.TEMP, 0), src(REG.TEXTURE, 1),
        END,
    ]],
    ["ps_1_4 bem arithmetic bump displacement", [
        PS(1, 4),
        instruction(OP.TEXCOORD), dst(REG.TEMP, 1), src(REG.TEXTURE, 1),
        instruction(OP.TEX), dst(REG.TEMP, 0), src(REG.TEXTURE, 0),
        instruction(OP.BEM), dst(REG.TEMP, 1, { mask: 0x3 }),
            src(REG.TEMP, 1), src(REG.TEMP, 0),
        instruction(OP.PHASE),
        instruction(OP.TEX), dst(REG.TEMP, 1), src(REG.TEMP, 1),
        instruction(OP.MOV), dst(REG.TEMP, 0), src(REG.TEMP, 1),
        END,
    ]],
    ["ps_1_1 texm3x3tex tangent-space environment map", [
        PS(1, 1),
        instruction(OP.TEX), dst(REG.TEXTURE, 0),
        instruction(OP.TEXM3x3PAD), dst(REG.TEXTURE, 1), src(REG.TEXTURE, 0),
        instruction(OP.TEXM3x3PAD), dst(REG.TEXTURE, 2), src(REG.TEXTURE, 0),
        instruction(OP.TEXM3x3TEX), dst(REG.TEXTURE, 3), src(REG.TEXTURE, 0),
        instruction(OP.MOV), dst(REG.TEMP, 0), src(REG.TEXTURE, 3),
        END,
    ]],
    ["ps_1_1 texm3x3vspec reflective environment map", [
        PS(1, 1),
        instruction(OP.TEX), dst(REG.TEXTURE, 0),
        instruction(OP.TEXM3x3PAD), dst(REG.TEXTURE, 1), src(REG.TEXTURE, 0),
        instruction(OP.TEXM3x3PAD), dst(REG.TEXTURE, 2), src(REG.TEXTURE, 0),
        instruction(OP.TEXM3x3VSPEC), dst(REG.TEXTURE, 3), src(REG.TEXTURE, 0),
        instruction(OP.MOV), dst(REG.TEMP, 0), src(REG.TEXTURE, 3),
        END,
    ]],
    ["ps_1_1 texm3x2tex two-row matrix lookup", [
        PS(1, 1),
        instruction(OP.TEX), dst(REG.TEXTURE, 0),
        instruction(OP.TEXM3x2PAD), dst(REG.TEXTURE, 1), src(REG.TEXTURE, 0),
        instruction(OP.TEXM3x2TEX), dst(REG.TEXTURE, 2), src(REG.TEXTURE, 0),
        instruction(OP.MOV), dst(REG.TEMP, 0), src(REG.TEXTURE, 2),
        END,
    ]],
    ["ps_1_1 texdp3tex dot-product lookup", [
        PS(1, 1),
        instruction(OP.TEX), dst(REG.TEXTURE, 0),
        instruction(OP.TEXDP3TEX), dst(REG.TEXTURE, 1), src(REG.TEXTURE, 0),
        instruction(OP.MOV), dst(REG.TEMP, 0), src(REG.TEXTURE, 1),
        END,
    ]],
    ["ps_1_4 texld with an explicit coordinate register", [
        PS(1, 4),
        instruction(OP.TEXCOORD), dst(REG.TEMP, 0), src(REG.TEXTURE, 0),
        instruction(OP.TEX), dst(REG.TEMP, 1), src(REG.TEMP, 0),
        instruction(OP.PHASE),
        instruction(OP.MUL), dst(REG.TEMP, 0), src(REG.TEMP, 1), src(REG.INPUT, 0),
        END,
    ]],
    ["ps_2_0 two-sampler blend with def constants", [
        PS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(0, 0, 2), dst(REG.SAMPLER, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(0, 0, 2), dst(REG.SAMPLER, 1),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0),
            dst(REG.TEXTURE, 0, { mask: 0x3 }),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 1),
            dst(REG.TEXTURE, 1, { mask: 0x3 }),
        instruction(OP.DEF, { length: 5 }), dst(REG.CONST, 0),
            floatBits(0.5), floatBits(0.5), floatBits(0.5), floatBits(1),
        instruction(OP.TEX, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEXTURE, 0), src(REG.SAMPLER, 0),
        instruction(OP.TEX, { length: 3 }), dst(REG.TEMP, 1), src(REG.TEXTURE, 1), src(REG.SAMPLER, 1),
        instruction(OP.LRP, { length: 4 }), dst(REG.TEMP, 0),
            src(REG.CONST, 0), src(REG.TEMP, 0), src(REG.TEMP, 1),
        instruction(OP.MUL, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.INPUT, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ]],
    ["ps_2_0 cube sampler with a projected coordinate", [
        PS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(0, 0, 3), dst(REG.SAMPLER, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.TEXTURE, 0),
        instruction(OP.TEX, { length: 3, control: 1 }), dst(REG.TEMP, 0),
            src(REG.TEXTURE, 0), src(REG.SAMPLER, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ]],
    ["ps_2_0 volume sampler and dp2add", [
        PS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(0, 0, 4), dst(REG.SAMPLER, 2),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.TEXTURE, 0),
        instruction(OP.TEX, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEXTURE, 0), src(REG.SAMPLER, 2),
        instruction(OP.DP2ADD, { length: 4 }), dst(REG.TEMP, 1),
            src(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.TEMP, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 1),
        END,
    ]],
    ["ps_2_0 cmp/slt/sge/frc/abs saturating chain", [
        PS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.TEXTURE, 0),
        instruction(OP.DEF, { length: 5 }), dst(REG.CONST, 0),
            floatBits(0.25), floatBits(0.5), floatBits(0.75), floatBits(1),
        instruction(OP.FRC, { length: 2 }), dst(REG.TEMP, 0), src(REG.TEXTURE, 0),
        instruction(OP.ABS, { length: 2 }), dst(REG.TEMP, 1), src(REG.TEMP, 0),
        instruction(OP.SLT, { length: 3 }), dst(REG.TEMP, 2), src(REG.TEMP, 1), src(REG.CONST, 0),
        instruction(OP.SGE, { length: 3 }), dst(REG.TEMP, 3), src(REG.TEMP, 1), src(REG.CONST, 0),
        instruction(OP.CMP, { length: 4 }), dst(REG.TEMP, 0, { modifier: 1 }),
            src(REG.TEMP, 2), src(REG.TEMP, 3), src(REG.CONST, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ]],
    ["ps_2_0 source modifiers (bias/sign/complement/x2/abs)", [
        PS(2, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.TEXTURE, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 0), src(REG.TEXTURE, 0, { modifier: 2 }),
        instruction(OP.ADD, { length: 3 }), dst(REG.TEMP, 0),
            src(REG.TEMP, 0, { modifier: 4 }), src(REG.TEXTURE, 0, { modifier: 6 }),
        instruction(OP.MAD, { length: 4 }), dst(REG.TEMP, 0),
            src(REG.TEMP, 0, { modifier: 7 }), src(REG.TEMP, 0, { modifier: 11 }),
            src(REG.TEMP, 0, { modifier: 1 }),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ]],
    ["ps_3_0 flow control with vFace/vPos and oDepth", [
        PS(3, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(0, 0, 2), dst(REG.SAMPLER, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.INPUT, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.COLOR, 0), dst(REG.INPUT, 1),
        instruction(OP.DEFB, { length: 2 }), dst(REG.CONSTBOOL, 0), 1,
        instruction(OP.TEX, { length: 3 }), dst(REG.TEMP, 0), src(REG.INPUT, 0), src(REG.SAMPLER, 0),
        // A uniform (bool-register) branch keeps textureSample legal inside.
        instruction(OP.IF, { length: 1 }), src(REG.CONSTBOOL, 0),
        instruction(OP.TEX, { length: 3 }), dst(REG.TEMP, 1), src(REG.INPUT, 0), src(REG.SAMPLER, 0),
        instruction(OP.ADD, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.TEMP, 1),
        instruction(OP.ENDIF),
        instruction(OP.MUL, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.MISCTYPE, 1),
        instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 2), src(REG.MISCTYPE, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.DEPTHOUT, 0, { mask: 0x1 }),
            src(REG.TEMP, 2, { swizzle: swizzle("zzzz") }),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ]],
    ["ps_3_0 data-dependent branch degrades to level-0 sampling", [
        PS(3, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(0, 0, 2), dst(REG.SAMPLER, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.INPUT, 0),
        instruction(OP.DEF, { length: 5 }), dst(REG.CONST, 0),
            floatBits(0), floatBits(0), floatBits(0), floatBits(0),
        // `ifc` on an interpolated value is genuinely non-uniform control flow.
        instruction(OP.IFC, { length: 2, control: 1 }), src(REG.INPUT, 0), src(REG.CONST, 0),
        instruction(OP.TEX, { length: 3 }), dst(REG.TEMP, 0), src(REG.INPUT, 0), src(REG.SAMPLER, 0),
        instruction(OP.ENDIF),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ]],
    ["ps_2_0 texldl/texldd explicit LOD and gradients", [
        PS(3, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(0, 0, 2), dst(REG.SAMPLER, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.INPUT, 0),
        instruction(OP.TEXLDL, { length: 3 }), dst(REG.TEMP, 0), src(REG.INPUT, 0), src(REG.SAMPLER, 0),
        instruction(OP.TEXLDD, { length: 5 }), dst(REG.TEMP, 1), src(REG.INPUT, 0),
            src(REG.SAMPLER, 0), src(REG.INPUT, 0), src(REG.INPUT, 0),
        instruction(OP.ADD, { length: 3 }), dst(REG.TEMP, 0), src(REG.TEMP, 0), src(REG.TEMP, 1),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ]],
    // Sampling inside a data-dependent branch, with the coordinate available
    // above it. This must come out as textureSampleGrad with hoisted
    // derivatives -- naga proves the explicit-gradient form really is legal
    // under non-uniform control flow, which is the whole basis for preferring
    // it over dropping to mip level 0.
    ["ps_3_0 in-branch sample keeps its mip level via hoisted gradients", [
        PS(3, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(0, 0, 2), dst(REG.SAMPLER, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.INPUT, 0),
        instruction(OP.DEF, { length: 5 }), dst(REG.CONST, 0),
            floatBits(0.5), floatBits(0), floatBits(0), floatBits(0),
        instruction(OP.IFC, { length: 2, control: 5 /* ne */ }),
            src(REG.INPUT, 0), src(REG.CONST, 0),
        instruction(OP.TEX, { length: 3 }), dst(REG.TEMP, 0),
            src(REG.INPUT, 0), src(REG.SAMPLER, 0),
        instruction(OP.ENDIF),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ]],
    // The exact shape that made 3DMark06's airship a black silhouette: a
    // derivative inside a data-dependent `if`. Legal in D3D9, which runs both
    // sides of the branch; a compile error in WGSL, which is why naga has to
    // see this one.
    ["ps_3_0 dsx/dsy inside a data-dependent branch", [
        PS(3, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.INPUT, 0),
        instruction(OP.DEF, { length: 5 }), dst(REG.CONST, 0),
            floatBits(0.5), floatBits(0), floatBits(0), floatBits(0),
        // r1 is computed before the branch, so its derivative can be hoisted.
        instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 1), src(REG.INPUT, 0),
        instruction(OP.IFC, { length: 2, control: 5 /* ne */ }),
            src(REG.TEMP, 1), src(REG.CONST, 0),
        instruction(OP.DSX, { length: 2 }), dst(REG.TEMP, 2), src(REG.TEMP, 1),
        instruction(OP.DSY, { length: 2 }), dst(REG.TEMP, 3), src(REG.TEMP, 1),
        instruction(OP.ADD, { length: 3 }), dst(REG.TEMP, 0),
            src(REG.TEMP, 2), src(REG.TEMP, 3),
        instruction(OP.ENDIF),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ]],
    // The case that cannot be hoisted: the branch overwrites the operand, so
    // there is no value above it to differentiate.
    ["ps_3_0 dsx of a register the branch itself rewrites", [
        PS(3, 0),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.INPUT, 0),
        instruction(OP.DEF, { length: 5 }), dst(REG.CONST, 0),
            floatBits(0.5), floatBits(0), floatBits(0), floatBits(0),
        instruction(OP.IFC, { length: 2, control: 5 /* ne */ }),
            src(REG.INPUT, 0), src(REG.CONST, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.TEMP, 1), src(REG.CONST, 0),
        instruction(OP.DSX, { length: 2 }), dst(REG.TEMP, 0), src(REG.TEMP, 1),
        instruction(OP.ENDIF),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ]],
    ["ps_2_x predicated instruction with setp", [
        PS(2, 1),
        instruction(OP.DCL, { length: 2 }), dclToken(USAGE.TEXCOORD, 0), dst(REG.TEXTURE, 0),
        instruction(OP.DEF, { length: 5 }), dst(REG.CONST, 0),
            floatBits(0.5), floatBits(0), floatBits(0), floatBits(0),
        instruction(OP.SETP, { length: 3, control: 4 /* lt */ }), dst(REG.PREDICATE, 0),
            src(REG.TEXTURE, 0), src(REG.CONST, 0),
        instruction(OP.MOV, { length: 3, predicated: true }), dst(REG.TEMP, 0),
            src(REG.PREDICATE, 0, { swizzle: swizzle("xxxx") }), src(REG.CONST, 0),
        instruction(OP.MOV, { length: 2 }), dst(REG.COLOROUT, 0), src(REG.TEMP, 0),
        END,
    ]],
];

// ---- run ----

// SM1 has no dcl_2d/dcl_cube: specialize ordinary tex/texld from SetTexture.
for (const minor of [1, 4]) {
    const code = minor === 1 ? [
        PS(1, 1), instruction(OP.TEX), dst(REG.TEXTURE, 0),
        instruction(OP.MOV), dst(REG.TEMP, 0), src(REG.TEXTURE, 0), END,
    ] : [
        PS(1, 4), instruction(OP.TEX), dst(REG.TEMP, 0), src(REG.TEXTURE, 0), END,
    ];
    for (const type of ["cube", "3d"]) {
        CORPUS.push(["ps_1_" + minor + " bound " + type, code, {
            legacySamplerTypes: { 0: type },
        }]);
    }
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wgsl-"));
const failures = [];
let validated = 0;

for (const [name, list, options] of CORPUS) {
    const stream = new Uint32Array(list);
    const result = pipeline.compileShader(stream, options);
    if (!result.ok) {
        failures.push({ name, message: "translation failed: " + result.error });
        continue;
    }
    const file = path.join(directory,
        name.replace(/[^a-z0-9]+/gi, "_").toLowerCase() + ".wgsl");
    fs.writeFileSync(file, result.wgsl);
    const run = spawnSync(naga, [file], { encoding: "utf8" });
    if (run.status !== 0) {
        failures.push({ name, message: (run.stderr || run.stdout || "").trim(),
            source: result.wgsl });
        continue;
    }
    ++validated;
}

// M5's declaration-specific vertex variants change the WGSL input scalar
// types and inject unpack helpers, so validate each conversion with naga too.
for (const [name, kind] of [["ubyte4", "ubyte4"], ["short2", "short2"],
        ["short4", "short4"], ["udec3", "udec3"], ["dec3n", "dec3n"]]) {
    const result = pipeline.compileShader(new Uint32Array(CORPUS[0][1]), {
        inputConversions: { 0: kind },
    });
    if (!result.ok) {
        failures.push({ name: "M5 " + name,
            message: "translation failed: " + result.error });
        continue;
    }
    const file = path.join(directory, "m5_" + name + ".wgsl");
    fs.writeFileSync(file, result.wgsl);
    const run = spawnSync(naga, [file], { encoding: "utf8" });
    if (run.status !== 0)
        failures.push({ name: "M5 " + name,
            message: (run.stderr || run.stdout || "").trim(), source: result.wgsl });
    else ++validated;
}

// M6 point primitives use a translated vertex-shader variant with instance
// attributes and @builtin(vertex_index) quad expansion.
{
    const result = pipeline.compileShader(new Uint32Array(CORPUS[0][1]), {
        pointExpansion: true, pointSprite: true,
    });
    const file = path.join(directory, "m6_programmable_point_sprite.wgsl");
    if (!result.ok) {
        failures.push({ name: "M6 programmable point sprite",
            message: "translation failed: " + result.error });
    } else {
        fs.writeFileSync(file, result.wgsl);
        const run = spawnSync(naga, [file], { encoding: "utf8" });
        if (run.status !== 0)
            failures.push({ name: "M6 programmable point sprite",
                message: (run.stderr || run.stdout || "").trim(),
                source: result.wgsl });
        else ++validated;
    }
}

// Programmable clip-plane variants add two inter-stage vec4s and extend the
// vertex constant block. Validate both modules, not just their fixed-function
// counterparts below.
for (const [name, source] of [
        ["programmable clip-plane vertex", CORPUS.find(entry =>
            entry[0].startsWith("vs_3_0 dcl"))[1]],
        ["programmable clip-plane pixel", CORPUS.find(entry =>
            entry[0].startsWith("ps_2_0 two-sampler"))[1]],
    ]) {
    const result = pipeline.compileShader(new Uint32Array(source), {
        clipPlaneCount: 6,
    });
    const file = path.join(directory,
        name.replace(/[^a-z0-9]+/gi, "_") + ".wgsl");
    if (!result.ok) {
        failures.push({ name, message: "translation failed: " + result.error });
    } else {
        fs.writeFileSync(file, result.wgsl);
        const run = spawnSync(naga, [file], { encoding: "utf8" });
        if (run.status !== 0)
            failures.push({ name,
                message: (run.stderr || run.stdout || "").trim(),
                source: result.wgsl });
        else ++validated;
    }
}

// Hardware shadow maps: a stage bound to a depth texture is declared
// texture_depth_2d and sampled through a sampler_comparison, which is a
// different WGSL type system from every other case above -- textureSample does
// not accept a comparison sampler and textureSampleCompare does not accept an
// ordinary one, so a mistake here is a compile error rather than a wrong
// image. The projected form is included because that is what a shadow lookup
// actually uses: tex2Dproj supplies the comparison reference as z/w.
for (const [name, entry] of [
        ["depth compare", "ps_2_0 two-sampler blend with def constants"],
        ["depth compare projected", "ps_2_0 cube sampler with a projected " +
            "coordinate"],
        ["depth compare non-uniform", "ps_3_0 data-dependent branch degrades " +
            "to level-0 sampling"],
        ["depth compare explicit lod", "ps_2_0 texldl/texldd explicit LOD and " +
            "gradients"],
    ]) {
    const source = CORPUS.find(item => item[0] === entry);
    assert.ok(source, "validation corpus is missing " + entry);
    const result = pipeline.compileShader(new Uint32Array(source[1]), {
        depthSamplers: [0],
    });
    if (!result.ok) {
        failures.push({ name, message: "translation failed: " + result.error });
        continue;
    }
    // The cube case must *not* become a depth sampler: a cube depth texture
    // cannot be created at all, and silently emitting texture_depth_2d for one
    // would pair a cube view with a 2D layout entry.
    const sampler0 = result.reflection.samplers.find(item => item.index === 0);
    if (sampler0.type === "2d") {
        assert.equal(sampler0.depth, "compare",
            name + ": a 2D sampler asked to be depth must report it");
        assert.ok(result.wgsl.includes("texture_depth_2d"),
            name + ": expected a texture_depth_2d declaration");
        assert.ok(result.wgsl.includes("sampler_comparison"),
            name + ": expected a sampler_comparison declaration");
        assert.ok(/textureSampleCompare(Level)?\(/.test(result.wgsl),
            name + ": expected a comparison sample");
        // Only stage 0 is the shadow map; the two-sampler case keeps an
        // ordinary textureSample on stage 1, which is the point -- one module
        // has to carry both kinds at once.
        assert.ok(!/textureSample(Bias|Grad|Level)?\(d9_tex0\b/.test(result.wgsl),
            name + ": a comparison sampler cannot be used with textureSample");
    } else {
        assert.equal(sampler0.depth, false,
            name + ": only 2D samplers can be depth");
    }
    const file = path.join(directory,
        name.replace(/[^a-z0-9]+/gi, "_") + ".wgsl");
    fs.writeFileSync(file, result.wgsl);
    const run = spawnSync(naga, [file], { encoding: "utf8" });
    if (run.status !== 0)
        failures.push({ name, message: (run.stderr || run.stdout || "").trim(),
            source: result.wgsl });
    else ++validated;
}

// The other half of the depth story: the ATI FOURCC formats read the stored
// depth back instead of comparing against it. Same texture_depth_2d, an
// ordinary sampler, textureSampleLevel rather than textureSampleCompare -- and
// naga is the thing that proves those three agree, because pairing a
// sampler_comparison with textureSampleLevel is a type error, not a bad image.
for (const [name, entry] of [
        ["depth fetch", "ps_2_0 two-sampler blend with def constants"],
        ["depth fetch explicit lod", "ps_2_0 texldl/texldd explicit LOD and " +
            "gradients"],
    ]) {
    const source = CORPUS.find(item => item[0] === entry);
    assert.ok(source, "validation corpus is missing " + entry);
    const result = pipeline.compileShader(new Uint32Array(source[1]), {
        depthSamplers: [0], depthFetchSamplers: [0],
    });
    if (!result.ok) {
        failures.push({ name, message: "translation failed: " + result.error });
        continue;
    }
    const sampler0 = result.reflection.samplers.find(item => item.index === 0);
    assert.equal(sampler0.depth, "fetch",
        name + ": a raw-depth sampler must report the fetch mode");
    assert.ok(result.wgsl.includes("texture_depth_2d"),
        name + ": a depth fetch is still a depth texture");
    assert.ok(!result.wgsl.includes("sampler_comparison"),
        name + ": a fetch reads through an ordinary sampler");
    assert.ok(!/textureSampleCompare/.test(result.wgsl),
        name + ": a fetch does not compare");
    assert.ok(/textureSampleLevel\(d9_tex0\b/.test(result.wgsl),
        name + ": expected a level-explicit depth fetch");
    const file = path.join(directory,
        name.replace(/[^a-z0-9]+/gi, "_") + ".wgsl");
    fs.writeFileSync(file, result.wgsl);
    const run = spawnSync(naga, [file], { encoding: "utf8" });
    if (run.status !== 0)
        failures.push({ name, message: (run.stderr || run.stdout || "").trim(),
            source: result.wgsl });
    else ++validated;
}

// The synthesised fixed-function stages are part of the same contract and
// pair with translated shaders inside a pipeline, so they get validated here
// too rather than only being exercised through the fake-device executor test.
{
    const executor = require("../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js");
    const fixedFunction = [];
    // A vertex signature with every optional field defaulted off. The builder
    // reads these unconditionally, so a partial object would fail for reasons
    // that have nothing to do with what a case is testing.
    const vsBase = overrides => Object.assign({
        positionType: "world", hasColor: false, colorIsBGRA: false,
        hasColor1: false, color1IsBGRA: false, hasNormal: false,
        hasPointSize: false,
        texCoordSets: [], hasTexCoord: false, coordStages: [],
        fogMode: 0, fogRange: false, normalizeNormals: false,
        needsViewSpace: false, lighting: null, clipPlaneCount: 0,
        pointExpansion: false, pointSprite: false, pointScale: false,
        blendWeightType: -1, blendIndicesType: -1, vertexBlend: null,
    }, overrides);
    for (const positionType of ["world", "screen"]) {
        for (const hasColor of [false, true]) {
            for (const hasTexCoord of [false, true]) {
                fixedFunction.push(["ff vs " + positionType +
                    (hasColor ? " colour" : "") + (hasTexCoord ? " texcoord" : ""),
                    executor.buildFixedFunctionVertexShader(vsBase({
                        positionType, hasColor, hasTexCoord,
                        texCoordSets: hasTexCoord ? [0] : [],
                        coordStages: hasTexCoord
                            ? [{ index: 0, texCoordIndex: 0, tciMode: 0,
                                transformCount: 0, projected: false }] : [],
                    }))]);
            }
        }
    }
    // M3's fixed-function lighting: every light type, every material source,
    // and the two branches (local viewer, specular) that change the maths.
    for (const type of [1, 2, 3]) { // D3DLIGHT_POINT / SPOT / DIRECTIONAL
        for (const specularEnable of [false, true]) {
            for (const localViewer of [false, true]) {
                fixedFunction.push(["ff vs light type" + type +
                    (specularEnable ? " specular" : "") +
                    (localViewer ? " localviewer" : ""),
                    executor.buildFixedFunctionVertexShader(vsBase({
                        hasColor: true, hasColor1: true, hasNormal: true,
                        needsViewSpace: true, normalizeNormals: true,
                        lighting: { lights: [{ index: 0, type }, { index: 3, type }],
                            colorVertex: true, specularEnable, localViewer,
                            diffuseSource: 1, ambientSource: 0,
                            specularSource: 2, emissiveSource: 0 },
                    }))]);
            }
        }
    }
    for (const source of [0, 1, 2]) { // D3DMCS_MATERIAL / COLOR1 / COLOR2
        fixedFunction.push(["ff vs material source " + source,
            executor.buildFixedFunctionVertexShader(vsBase({
                hasColor: true, hasColor1: true, hasNormal: true,
                needsViewSpace: true,
                lighting: { lights: [{ index: 0, type: 3 }], colorVertex: true,
                    specularEnable: true, localViewer: false,
                    diffuseSource: source, ambientSource: source,
                    specularSource: source, emissiveSource: source },
            }))]);
    }
    // Coordinate generation and the transform component counts, including the
    // camera-space modes that make the shader read view-space position/normal.
    for (const tciMode of [0, 0x10000, 0x20000, 0x30000]) {
        for (const transformCount of [0, 1, 2, 3, 4]) {
            fixedFunction.push(["ff vs tci " + tciMode.toString(16) +
                " count" + transformCount,
                executor.buildFixedFunctionVertexShader(vsBase({
                    hasNormal: true, texCoordSets: [0, 1], hasTexCoord: true,
                    needsViewSpace: tciMode !== 0,
                    coordStages: [
                        { index: 0, texCoordIndex: 1, tciMode, transformCount,
                          projected: false },
                        { index: 1, texCoordIndex: 0, tciMode: 0,
                          transformCount: 0, projected: false },
                    ],
                }))]);
        }
    }
    // 3DMark 2001 leaves camera-space reflection TCI selected while drawing
    // one XYZRHW pass with no normal or texture-coordinate declaration. The
    // value is undefined in D3D, but the generated WGSL must remain valid: a
    // reference to position_view/normal_view here invalidates the module and
    // every pipeline/command buffer that follows it.
    fixedFunction.push(["ff vs screen stale camera reflection tci",
        executor.buildFixedFunctionVertexShader(vsBase({
            positionType: "screen", hasColor: true,
            coordStages: [{ index: 0, texCoordIndex: 0, tciMode: 0x30000,
                transformCount: 3, projected: false }],
        }))]);
    for (const fogMode of [1, 2, 3]) {
        for (const fogRange of [false, true]) {
            fixedFunction.push(["ff vs fog " + fogMode + (fogRange ? " range" : ""),
                executor.buildFixedFunctionVertexShader(vsBase({
                    fogMode, fogRange, needsViewSpace: fogRange,
                }))]);
        }
    }
    // Fixed-function vertex blending: every matrix count, both the ordered and
    // the indexed matrix source, and both integer index formats -- BLENDINDICES
    // is the one fixed-function attribute whose WGSL type is not f32, so a
    // wrong base type here is a compile error the compiler has to be the one to
    // catch. Paired with lighting because the blended normal takes a different
    // path from the plain one.
    for (let matrixCount = 1; matrixCount <= 4; ++matrixCount) {
        for (const indexScalar of [null, "u32", "i32", "f32", "f32-plain"]) {
            for (const hasNormal of [false, true]) {
                const indexed = indexScalar !== null;
                const scalar = indexed
                    ? indexScalar.replace("-plain", "") : "u32";
                fixedFunction.push(["ff vs blend " + matrixCount +
                    (indexed ? " indexed " + indexScalar : " ordered") +
                    (hasNormal ? " normal" : ""),
                    executor.buildFixedFunctionVertexShader(vsBase({
                        hasNormal, needsViewSpace: hasNormal,
                        normalizeNormals: hasNormal,
                        lighting: hasNormal
                            ? { lights: [{ index: 0, type: 3 }],
                                colorVertex: false, specularEnable: false,
                                localViewer: false, diffuseSource: 0,
                                ambientSource: 0, specularSource: 0,
                                emissiveSource: 0 }
                            : null,
                        blendWeightType: matrixCount > 1 ? 2 : -1,
                        blendIndicesType: indexed ? 5 : -1,
                        vertexBlend: {
                            matrixCount, weightCount: matrixCount - 1, indexed,
                            indexScalar: scalar,
                            // The unorm8x4 spelling (D3DCOLOR/UBYTE4N) reaches
                            // the shader as bytes over 255 and needs its own
                            // conversion, so it is its own case here.
                            indexNormalized: indexScalar === "f32",
                            matrixSlots: indexed ? 16 : matrixCount,
                        },
                    }))]);
            }
        }
    }
    fixedFunction.push(["ff vs point sprite scaled",
        executor.buildFixedFunctionVertexShader(vsBase({
            hasColor: true, hasPointSize: true, needsViewSpace: true,
            pointExpansion: true, pointSprite: true, pointScale: true,
            texCoordSets: [0], hasTexCoord: true,
            coordStages: [{ index: 0, texCoordIndex: 0, tciMode: 0,
                transformCount: 0, projected: false }],
        }))]);
    fixedFunction.push(["ff vs six user clip planes",
        executor.buildFixedFunctionVertexShader(vsBase({
            hasColor: true, clipPlaneCount: 6,
        }))]);

    // A pixel signature with a single default stage.
    const stage = overrides => Object.assign({
        index: 0, colorOp: 4, colorArg0: 1, colorArg1: 2, colorArg2: 1,
        alphaOp: 2, alphaArg0: 1, alphaArg1: 2, alphaArg2: 1, resultArg: 1,
        usesConstant: false, samplesTexture: true, textureType: "2d",
        transformCount: 0, projected: false, coordVarying: 0,
    }, overrides);
    const psBase = overrides => Object.assign({
        stages: [stage()], usesTextureFactor: false, fogMode: 0,
        tableFog: false,
        alphaTest: { enabled: false, func: 8, reference: 0 },
        specularEnable: false, clipPlaneCount: 0,
    }, overrides);
    for (const hasTexture of [false, true]) {
        for (const debugMode of [null, "solid", "color", "uv", "texture"]) {
            fixedFunction.push(["ff ps" + (hasTexture ? " textured" : "") +
                (debugMode ? " " + debugMode : ""),
                executor.buildFixedFunctionPixelShader(psBase({
                    stages: hasTexture ? [stage()] : [],
                }), debugMode)]);
        }
    }
    // Every D3DTEXTUREOP fill_caps() advertises, on both channels, since the
    // colour and alpha forms are emitted from separate code paths.
    for (const op of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 24, 25, 26]) {
        fixedFunction.push(["ff ps op " + op,
            executor.buildFixedFunctionPixelShader(psBase({
                usesTextureFactor: true,
                stages: [stage({ colorOp: op, alphaOp: op, colorArg0: 3,
                    alphaArg0: 3 })],
            }), null)]);
    }
    // The argument pool, its two modifier bits, the scratch register and a
    // multi-stage cascade that threads a result through it.
    fixedFunction.push(["ff ps argument pool",
        executor.buildFixedFunctionPixelShader(psBase({
            usesTextureFactor: true, specularEnable: true,
            stages: [
                stage({ index: 0, colorOp: 26, colorArg0: 0x10 | 0,
                    colorArg1: 0x20 | 2, colorArg2: 3, alphaOp: 4,
                    alphaArg1: 4, alphaArg2: 6, usesConstant: true,
                    resultArg: 5 }),
                stage({ index: 1, colorOp: 25, colorArg0: 5, colorArg1: 1,
                    colorArg2: 2, alphaOp: 1, coordVarying: 1 }),
            ],
        }), null)]);
    // Cube and volume textures reach the cascade too, and PROJECTED changes the
    // coordinate expression rather than the sample.
    for (const textureType of ["2d", "cube", "3d"]) {
        for (const projected of [false, true]) {
            fixedFunction.push(["ff ps " + textureType +
                (projected ? " projected" : ""),
                executor.buildFixedFunctionPixelShader(psBase({
                    stages: [stage({ textureType, projected,
                        transformCount: projected ? 3 : 0 })],
                }), null)]);
        }
    }
    fixedFunction.push(["ff ps projected border colour",
        executor.buildFixedFunctionPixelShader(psBase({
            stages: [stage({ projected: true, transformCount: 3,
                addressU: 4, addressV: 4, addressW: 1,
                borderColor: 0x80402010 })],
        }), null)]);
    fixedFunction.push(["ff ps d3d7 texture colour key",
        executor.buildFixedFunctionPixelShader(psBase({
            stages: [stage({ colorKey: {
                low: 0x00102030, high: 0x00112233, indexed: false,
            } })],
        }), null)]);
    fixedFunction.push(["ff ps d3d7 indexed texture colour key",
        executor.buildFixedFunctionPixelShader(psBase({
            stages: [stage({ colorKey: {
                low: 9, high: 12, indexed: true,
            } })],
        }), null)]);
    for (const fogMode of [1, 2, 3]) {
        fixedFunction.push(["ff ps vertex fog " + fogMode,
            executor.buildFixedFunctionPixelShader(psBase({
                fogMode, specularEnable: true,
                alphaTest: { enabled: true, func: 5, reference: 128 },
            }), null)]);
        fixedFunction.push(["ff ps table fog " + fogMode,
            executor.buildFixedFunctionPixelShader(psBase({
                fogMode, tableFog: true, specularEnable: true,
                alphaTest: { enabled: true, func: 5, reference: 128 },
            }), null)]);
    }
    fixedFunction.push(["ff ps six user clip planes",
        executor.buildFixedFunctionPixelShader(psBase({
            clipPlaneCount: 6,
        }), null)]);
    for (const [name, wgsl] of fixedFunction) {
        const file = path.join(directory,
            name.replace(/[^a-z0-9]+/gi, "_").toLowerCase() + ".wgsl");
        fs.writeFileSync(file, wgsl);
        const run = spawnSync(naga, [file], { encoding: "utf8" });
        if (run.status !== 0)
            failures.push({ name, message: (run.stderr || run.stdout || "").trim(),
                source: wgsl });
        else ++validated;
    }
}

// A vertex and a fragment module have to agree on their inter-stage interface
// or the pipeline will not link. naga validates modules one at a time, so
// check the contract this translator relies on -- every vertex shader emits
// the complete varying set -- across a VS/PS pair that share no semantics.
{
    const vs = pipeline.compileShader(new Uint32Array(CORPUS[0][1]));
    const ps = pipeline.compileShader(new Uint32Array(CORPUS[11][1]));
    assert.ok(vs.ok && ps.ok, "corpus pair failed to translate");
    for (let slot = 0; slot < pipeline.VARYING_COUNT; ++slot) {
        const declaration = "@location(" + slot + ") varying" + slot + ": vec4<f32>,";
        if (!vs.wgsl.includes(declaration))
            failures.push({ name: "VS/PS interface",
                message: "vertex output is missing varying slot " + slot });
        if (!ps.wgsl.includes(declaration))
            failures.push({ name: "VS/PS interface",
                message: "pixel input is missing varying slot " + slot });
    }
}

// D3DSHADE_FLAT: the same pair compiled flat-shaded. Valid on its own, and
// the colour slots (only those) flat in both stages, so the pair still links.
{
    const pair = [["vertex", CORPUS[0][1]], ["pixel", CORPUS[11][1]]]
        .map(([kind, tokens]) => [kind, pipeline.compileShader(new Uint32Array(tokens),
            { flatShading: true })]);
    for (const [kind, result] of pair) {
        const name = "flat-shaded " + kind + " shader";
        if (!result.ok) {
            failures.push({ name, message: "translation failed: " + result.error });
            continue;
        }
        const file = path.join(directory, "flat_" + kind + ".wgsl");
        fs.writeFileSync(file, result.wgsl);
        const run = spawnSync(naga, [file], { encoding: "utf8" });
        if (run.status !== 0)
            failures.push({ name, message: (run.stderr || run.stdout || "").trim(),
                source: result.wgsl });
        else ++validated;
        for (let slot = 0; slot < pipeline.VARYING_COUNT; ++slot) {
            const flat = slot === pipeline.VARYING_COLOR0 || slot === pipeline.VARYING_COLOR1;
            const declaration = "@location(" + slot + ")" + (flat ? " @interpolate(flat)" : "") +
                " varying" + slot + ": vec4<f32>,";
            if (!result.wgsl.includes(declaration))
                failures.push({ name, message: "expected `" + declaration + "`",
                    source: result.wgsl });
        }
    }
}

if (failures.length) {
    for (const failure of failures) {
        console.error("FAIL " + failure.name);
        console.error(failure.message.split("\n").map(l => "  " + l).join("\n"));
        if (process.env.D9_TEST_WGSL && failure.source)
            console.error(failure.source);
    }
    console.error("\n" + failures.length + " failed, " + validated +
        " validated (naga: " + naga + ")");
    console.error("generated sources kept in " + directory);
    process.exit(1);
}
fs.rmSync(directory, { recursive: true, force: true });
console.log(validated + " translated shaders validated by naga");
