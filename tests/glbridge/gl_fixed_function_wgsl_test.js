#!/usr/bin/env node
// Unit tests for glbridge/gl-webgpu/gl_fixed_function.js -- the OpenGL fixed
// pipeline generated as WGSL.
//
// Two things are checked. First, that a signature produces the code the GL
// spec calls for: the texture environment table, the lighting equation's
// terms, fog, texgen. Second, that the result is WGSL a compiler accepts --
// through `naga` when it is available, because a generator that emits
// plausible-looking invalid code fails in the browser and nowhere else.

"use strict";

const { requireNaga } = require("./naga.js");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const ff = require("../../src/browser/glbridge/gl-webgpu/gl_fixed_function.js");


const naga = requireNaga("gl_fixed_function_wgsl_test");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "glwg-ff-"));
let passed = 0;
const failures = [];

function test(name, fn) {
    try { fn(); ++passed; } catch (error) { failures.push([name, error]); }
}

function generate(signature) {
    const result = ff.generate(signature);
    if (naga) {
        for (const [suffix, wgsl] of [["vert", result.wgslVertex],
                ["frag", result.wgslFragment]]) {
            const file = path.join(outputDir,
                (signature._name || "case") + "." + suffix + ".wgsl");
            fs.writeFileSync(file, wgsl);
            try {
                execFileSync(naga, [file], { stdio: "pipe" });
            } catch (error) {
                throw new Error("naga rejected the " + suffix + " shader:\n" +
                    String(error.stderr || error.stdout || error).slice(0, 700));
            }
        }
    }
    return result;
}

const POSITION_ONLY = { attributes: { position: { components: 3 } } };

function textured(env, format, extra) {
    return Object.assign({
        attributes: { position: { components: 3 }, color: true,
                      texCoord: [{ components: 2 }] },
        texture: [{ enabled: true, target: "2D", format: format || "RGBA", env }],
    }, extra || {});
}

/* ---- the shape of the generated code ---- */

test("a bare signature transforms and nothing else", () => {
    const result = generate(Object.assign({ _name: "minimal" }, POSITION_ONLY));
    assert.deepStrictEqual(result.stateFields, ["mvp"],
        "a untextured, unlit draw needs one matrix and no more");
    assert.strictEqual(result.attributes.length, 1);
    assert.strictEqual(result.textures.length, 0);
    assert.ok(result.wgslVertex.indexOf("clip.y = -clip.y;") >= 0);
    assert.ok(result.wgslVertex.indexOf("clip.z = (clip.z + clip.w) * 0.5;") >= 0);
});

test("attributes sit at their historical locations", () => {
    const result = generate({
        _name: "attributes",
        attributes: { position: { components: 4 }, normal: true, color: true,
                      secondaryColor: true, fogCoord: true,
                      texCoord: [{ components: 2 }, null, { components: 3 }] },
        texture: [{ enabled: true, target: "2D", env: { mode: "MODULATE" } },
                  { enabled: false },
                  { enabled: true, target: "3D", env: { mode: "MODULATE" } }],
        fog: { enabled: true, mode: "linear", coordSource: "coord" },
    });
    const byName = new Map(result.attributes.map(a => [a.name, a.location]));
    assert.strictEqual(byName.get("position"), 0);
    assert.strictEqual(byName.get("normal"), 2);
    assert.strictEqual(byName.get("color"), 3);
    assert.strictEqual(byName.get("secondaryColor"), 4);
    assert.strictEqual(byName.get("fogCoord"), 5);
    assert.strictEqual(byName.get("texCoord0"), 8);
    assert.strictEqual(byName.get("texCoord2"), 10);
});

test("an ARB vertex program can feed the fixed multitexture fragment stage", () => {
    const result = generate({
        _name: "arb_vertex_fixed_fragment",
        varyingInterface: "arb",
        attributes: { position: { components: 4 }, color: true,
                      texCoord: [{ components: 4 }, { components: 4 }] },
        texture: [
            { enabled: true, target: "2D", env: { mode: "MODULATE" } },
            { enabled: true, target: "2D", env: { mode: "ADD" } },
        ],
    });
    const fragment = result.wgslFragment;
    assert.ok(fragment.includes("@location(0) v0 : vec4<f32>"),
        "ARB result.color is the primary fixed-function colour");
    assert.ok(fragment.includes("@location(3) v3 : vec4<f32>"),
        "ARB result.texcoord[0] keeps its compatibility location");
    assert.ok(fragment.includes("@location(4) v4 : vec4<f32>"),
        "ARB result.texcoord[1] keeps its compatibility location");
    assert.ok(!fragment.includes("@location(1) v1 : vec4<f32>"),
        "unused compatibility outputs are not required from the vertex stage");
});

/* ---- texture environment, GL 1.5 table 3.22 ---- */

test("GL_REPLACE on an RGB texture leaves alpha alone", () => {
    const result = generate(textured({ mode: "REPLACE" }, "RGB"));
    result.signature._name = "replace_rgb";
    assert.ok(result.wgslFragment.indexOf(
        "frag = vec4<f32>(tex0.rgb, frag.a);") >= 0, result.wgslFragment);
});

test("GL_REPLACE on an RGBA texture replaces both", () => {
    const result = generate(textured({ mode: "REPLACE" }, "RGBA"));
    assert.ok(result.wgslFragment.indexOf("frag = tex0;") >= 0);
});

test("GL_MODULATE on an ALPHA texture leaves RGB alone", () => {
    const result = generate(textured({ mode: "MODULATE" }, "ALPHA"));
    assert.ok(result.wgslFragment.indexOf(
        "frag = vec4<f32>(frag.rgb, frag.a * tex0.a);") >= 0,
        result.wgslFragment);
});

test("GL_DECAL on RGBA interpolates by the texture's alpha", () => {
    const result = generate(textured({ mode: "DECAL" }, "RGBA"));
    assert.ok(result.wgslFragment.indexOf("mix(frag.rgb, tex0.rgb, tex0.a)") >= 0);
});

test("GL_DECAL on a LUMINANCE texture is documented as undefined", () => {
    const result = generate(textured({ mode: "DECAL" }, "LUMINANCE"));
    assert.ok(result.wgslFragment.indexOf("GL_DECAL is undefined") >= 0);
});

test("GL_BLEND on INTENSITY blends alpha as well as colour", () => {
    const result = generate(textured({ mode: "BLEND" }, "INTENSITY"));
    assert.ok(result.wgslFragment.indexOf("mix(frag.a,") >= 0,
        "intensity is the one base format whose alpha is blended too");
});

test("GL_COMBINE DOT3_RGBA drives alpha from the dot product", () => {
    const result = generate(textured({
        mode: "COMBINE", combineRGB: "DOT3_RGBA", combineAlpha: "REPLACE",
        srcRGB: ["TEXTURE", "PRIMARY_COLOR", "CONSTANT"],
        operandRGB: ["SRC_COLOR", "SRC_COLOR", "SRC_ALPHA"],
        srcAlpha: ["TEXTURE", "PREVIOUS", "CONSTANT"],
        operandAlpha: ["SRC_ALPHA", "SRC_ALPHA", "SRC_ALPHA"],
        rgbScale: 1, alphaScale: 1,
    }));
    assert.ok(result.wgslFragment.indexOf("4.0 * dot(") >= 0);
    assert.ok(result.wgslFragment.indexOf("let combinedA = clamp((dot3)") >= 0,
        result.wgslFragment);
});

test("GL_COMBINE crossbar reads another unit's sample", () => {
    const result = generate({
        _name: "crossbar",
        attributes: { position: { components: 3 }, color: true,
                      texCoord: [{ components: 2 }, { components: 2 }] },
        texture: [
            { enabled: true, target: "2D", env: { mode: "MODULATE" } },
            { enabled: true, target: "2D", env: {
                mode: "COMBINE", combineRGB: "INTERPOLATE",
                combineAlpha: "MODULATE",
                srcRGB: ["TEXTURE0", "PREVIOUS", "CONSTANT"],
                operandRGB: ["SRC_COLOR", "SRC_COLOR", "SRC_ALPHA"],
                srcAlpha: ["TEXTURE", "PREVIOUS", "CONSTANT"],
                operandAlpha: ["SRC_ALPHA", "SRC_ALPHA", "SRC_ALPHA"],
                rgbScale: 4, alphaScale: 2 } },
        ],
    });
    assert.ok(result.wgslFragment.indexOf("(tex0).rgb") >= 0,
        "stage 1 reads stage 0's sample, so both are taken before the chain runs");
    assert.ok(result.wgslFragment.indexOf("* 4.0") >= 0, "RGB_SCALE is applied");
});

/* ---- lighting ---- */

test("the lighting equation carries every term the spec lists", () => {
    const result = generate({
        _name: "lighting",
        attributes: { position: { components: 3 }, normal: true, color: true },
        lighting: {
            enabled: true, twoSide: true, localViewer: true,
            separateSpecular: true, normalMode: "normalize",
            colorMaterial: { enabled: true, face: "FRONT_AND_BACK",
                             mode: "AMBIENT_AND_DIFFUSE" },
            lights: [{ enabled: true, positional: true, spot: true },
                     { enabled: true, positional: false }],
        },
    });
    const vertex = result.wgslVertex;
    assert.ok(vertex.indexOf("constantAttenuation") >= 0, "attenuation");
    assert.ok(vertex.indexOf("spotCosCutoff") >= 0, "the spotlight cutoff");
    assert.ok(vertex.indexOf("spotExponent") >= 0, "the spotlight exponent");
    assert.ok(vertex.indexOf("normalize(-eyePos)") >= 0, "the local viewer");
    assert.ok(vertex.indexOf("backColor") >= 0, "the back face");
    assert.ok(vertex.indexOf("vertexColor.rgb * glState.lights[0].ambient.rgb") >= 0,
        "colour material replaces the tracked property");
    assert.ok(result.stateFields.indexOf("backMaterial") >= 0);
});

test("a directional light has no attenuation term", () => {
    const result = generate({
        _name: "directional",
        attributes: { position: { components: 3 }, normal: true },
        lighting: { enabled: true,
            lights: [{ enabled: true, positional: false }] },
    });
    assert.ok(result.wgslVertex.indexOf("var atten = 1.0;") >= 0);
    // The GLLight struct always declares the attenuation members; what matters
    // is that the generated body never reads them for a directional light.
    const body = result.wgslVertex.slice(result.wgslVertex.indexOf("@vertex"));
    assert.ok(body.indexOf("constantAttenuation") < 0, body);
});

test("an unlit signature asks for no lighting state", () => {
    const result = generate(Object.assign({ _name: "unlit" }, POSITION_ONLY));
    assert.ok(result.stateFields.indexOf("lights") < 0);
    assert.ok(result.stateFields.indexOf("frontMaterial") < 0);
});

/* ---- fog, texgen, alpha test, clipping, points ---- */

test("each fog mode emits its own factor", () => {
    for (const [mode, needle] of [["linear", "glState.fogParams.w"],
            ["exp", "exp(-glState.fogParams.x"], ["exp2", "fogArg * fogArg"]]) {
        const result = generate({
            _name: "fog_" + mode,
            attributes: { position: { components: 3 } },
            fog: { enabled: true, mode, coordSource: "depth" },
        });
        assert.ok(result.wgslFragment.indexOf(needle) >= 0,
            mode + ": " + result.wgslFragment);
    }
});

test("texgen builds each coordinate separately", () => {
    const result = generate({
        _name: "texgen",
        attributes: { position: { components: 4 }, normal: true },
        texture: [{ enabled: true, target: "2D", matrix: true,
            texGen: ["OBJECT", "EYE", "SPHERE", null],
            env: { mode: "MODULATE" } }],
    });
    const vertex = result.wgslVertex;
    assert.ok(vertex.indexOf("dot(objectPos, glState.texGenPlanes[0])") >= 0,
        "the object plane for S is slot 0 of the unit");
    assert.ok(vertex.indexOf("glState.texGenPlanes[5]") >= 0,
        "the eye plane for T is slot 4 + 1");
    assert.ok(vertex.indexOf("sphereM0") >= 0);
    assert.ok(vertex.indexOf("glState.textureMatrix[0] * tc0") >= 0);
});

test("alpha test and clip planes both discard", () => {
    const result = generate({
        _name: "discard",
        attributes: { position: { components: 3 } },
        alphaTest: "gequal", clipPlaneCount: 2,
    });
    assert.ok(result.wgslFragment.indexOf(
        "if (!(frag.a >= glState.alphaRef.x)) { discard; }") >= 0);
    assert.ok(result.wgslFragment.indexOf(
        "if (any(fin.clipDist < vec4<f32>(0.0))) { discard; }") >= 0);
    assert.ok(result.usesDiscard);
});

test("a point-sprite signature expands the point in clip space", () => {
    const result = generate({
        _name: "pointsprite",
        attributes: { position: { components: 3 }, color: true },
        pointSprite: true,
    });
    assert.ok(result.wgslVertex.includes("gl_point_position(clip,ptSize,corner,glState.viewportParams)"));
    assert.ok(result.wgslVertex.indexOf("0.5 - corner.y * 0.5") >= 0,
        "GL_POINT_SPRITE_COORD_ORIGIN defaults to GL_UPPER_LEFT");
    assert.ok(result.wgslVertex.includes("@builtin(vertex_index) cornerIndex"));
    assert.ok(!result.attributes.some(a => a.name === "corner"));
});

test("point sprites honour a lower-left coordinate origin", () => {
    const result = generate({
        _name: "pointsprite_lower_left",
        attributes: { position: { components: 3 }, color: true },
        pointSprite: true,
        pointCoordLowerLeft: true,
    });
    assert.ok(result.wgslVertex.indexOf(
        "corner.y * 0.5 + 0.5") >= 0);
});

test("polygon stipple tests the 32 by 32 pattern in fragment coordinates", () => {
    const result = generate({
        _name: "polygon_stipple",
        attributes: { position: { components: 3 }, color: true },
        polygonStipple: true,
    });
    assert.ok(result.stateFields.includes("polygonStipple"));
    assert.ok(result.wgslFragment.indexOf("stippleByteIndex") >= 0);
    assert.ok(result.wgslFragment.indexOf("stippleBit") >= 0);
});

test("colour logic XOR is emitted as an attachment-sampling bit operation", () => {
    const result = generate({
        _name: "logic_xor",
        attributes: { position: { components: 3 }, color: true },
        logicOp: 0x1506,
    });
    assert.ok(result.wgslFragment.includes(
        "@group(3) @binding(0) var glLogicTarget0"));
    assert.ok(result.wgslFragment.includes("let r = (s ^ d)"));
    assert.ok(result.wgslFragment.includes("glApplyLogic(frag"));
});

test("point-sprite coordinate replacement samples gl_PointCoord", () => {
    const result = generate({
        _name: "point_coord_replace",
        attributes: { position: { components: 3 },
            texCoord: [{ components: 4 }] },
        pointSprite: true,
        texture: [{ enabled: true, target: "2D", format: "RGBA",
            texGen: [null, null, null, null],
            env: { mode: "REPLACE", coordReplace: true } }],
    });
    assert.ok(result.wgslFragment.indexOf(
        "vec4<f32>(fin.pointCoord, 0.0, 1.0)") >= 0,
    "GL_COORD_REPLACE uses the generated point coordinate");
});

test("a border axis blends GL's border colour by the footprint outside the texture", () => {
    const linear = generate(Object.assign(textured({ mode: "REPLACE" }), { _name: "border_linear" }, {
        texture: [{ enabled: true, target: "2D", format: "RGBA", env: { mode: "REPLACE" },
            border: { s: "border", t: "clamp", linear: true } }] }));
    assert.ok(linear.stateFields.includes("textureBorderColor"));
    assert.match(linear.wgslFragment, /mix\(glState\.textureBorderColor\[0\], textureSample\(t0, s0/);
    // CLAMP clamps the coordinate first; CLAMP_TO_BORDER does not
    assert.match(linear.wgslFragment, /clamp\(\(.*\)\.y, 0\.0, 1\.0\) \* /);
    assert.match(linear.wgslFragment, /clamp\(min\(\(.*\)\.x \* /);
    const nearest = generate(Object.assign(textured({ mode: "REPLACE" }), { _name: "border_nearest" }, {
        texture: [{ enabled: true, target: "2D", format: "RGBA", env: { mode: "REPLACE" },
            border: { s: "border", linear: false } }] }));
    assert.match(nearest.wgslFragment, /select\(0\.0, 1\.0, .* >= 0\.0 && .* < /);
    const shadow = generate(Object.assign(textured({ mode: "REPLACE" }, "DEPTH"), { _name: "border_shadow" }, {
        attributes: { position: { components: 3 }, color: true, texCoord: [{ components: 4 }] },
        texture: [{ enabled: true, target: "2D", shadow: true, format: "DEPTH", env: { mode: "REPLACE" },
            border: { s: "border", t: "border", linear: true, compare: "lequal" } }] }));
    assert.match(shadow.wgslFragment, /select\(0\.0, 1\.0, .*\.z <= glState\.textureBorderColor\[0\]\.x\)/,
        "a shadow lookup compares the border's depth");
    const none = generate(textured({ mode: "REPLACE" }));
    assert.ok(!none.stateFields.includes("textureBorderColor"));
});

test("a polygon's back-face lines and offset points are variants of their own", () => {
    const lit = { attributes: { position: { components: 3 }, normal: true, color: true },
        lighting: { enabled: true, twoSide: true, lights: [{ enabled: true }] } };
    const back = generate(Object.assign({ _name: "back_facing", backFacing: true }, lit));
    assert.ok(!/front_facing/.test(back.wgslFragment), "no builtin to ask");
    assert.match(back.wgslFragment, /select\(.*, false\)/);
    const offset = generate(Object.assign({ _name: "depth_offset", depthOffset: true }, POSITION_ONLY));
    assert.match(offset.wgslVertex, /@location\(6\) depthOffset : f32/);
    assert.match(offset.wgslVertex, /clip\.z = \(clip\.z \+ clip\.w\) \* 0\.5;\n {4}clip\.z = clip\.z \+ vin\.depthOffset \* clip\.w;/);
    assert.ok(offset.attributes.some(a => a.location === ff.DEPTH_OFFSET_LOCATION));
    const line = generate(Object.assign({ _name: "wide_stippled_line", wideLine: true, lineStipple: true },
        POSITION_ONLY));
    assert.match(line.wgslVertex, /@location\(1\) lineAttr : vec3<f32>/);
    assert.match(line.wgslFragment, /@interpolate\(linear\) lineDistance : f32/);
    assert.ok(line.stateFields.includes("rasterParams") && line.stateFields.includes("viewportParams"));
});

test("eight textured units still fit the varying budget", () => {
    const result = generate({
        _name: "eight_units",
        attributes: { position: { components: 3 }, color: true,
            texCoord: Array.from({ length: 8 }, () => ({ components: 2 })) },
        texture: Array.from({ length: 8 }, () => ({ enabled: true,
            target: "2D", env: { mode: "MODULATE" } })),
    });
    assert.ok(result.varyingSlots <= 16, result.varyingSlots);
    assert.strictEqual(result.textures.length, 8);
});

/* ---- the signature is the cache key ---- */

test("every field that changes the code changes the key", () => {
    const base = { attributes: { position: { components: 3 }, color: true } };
    const key = ff.signatureKey(base);
    const variations = [
        { attributes: { position: { components: 3 }, color: true, normal: true } },
        { attributes: base.attributes, fog: { enabled: true, mode: "exp" } },
        { attributes: base.attributes, alphaTest: "less" },
        { attributes: base.attributes, clipPlaneCount: 1 },
        { attributes: base.attributes, pointSprite: true },
        { attributes: base.attributes, polygonStipple: true },
        { attributes: base.attributes, flatShading: true },
        { attributes: base.attributes, colorTargets: 2 },
        { attributes: base.attributes, backFacing: true },
        { attributes: base.attributes, depthOffset: true },
        { attributes: base.attributes, wideLine: true },
        { attributes: base.attributes, lineStipple: true },

        { attributes: base.attributes, lighting: { enabled: true,
            lights: [{ enabled: true }] } },
        { attributes: base.attributes, texture: [{ enabled: true, target: "2D",
            env: { mode: "MODULATE" } }] },
    ];
    for (const variation of variations)
        assert.notStrictEqual(ff.signatureKey(variation), key,
            "a state that changes the shader must change the signature");
    const unit = { enabled: true, target: "2D", env: { mode: "MODULATE" } };
    assert.notStrictEqual(ff.signatureKey({ attributes: base.attributes, texture: [unit] }),
        ff.signatureKey({ attributes: base.attributes, texture: [{ ...unit, border: { s: "border" } }] }),
        "the border axes are part of the signature");
});

test("the same signature produces the same key regardless of field order", () => {
    const a = { attributes: { color: true, position: { components: 3 } },
                alphaTest: "less" };
    const b = { alphaTest: "less",
                attributes: { position: { components: 3 }, color: true } };
    assert.strictEqual(ff.signatureKey(a), ff.signatureKey(b));
});

for (const [name, error] of failures)
    console.error("FAIL: " + name + "\n    " + (error && error.message));
console.log(passed + " passed, " + failures.length + " failed" +
    (naga ? " (WGSL validated with naga)" : " (naga absent; WGSL not validated)"));
fs.rmSync(outputDir, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
