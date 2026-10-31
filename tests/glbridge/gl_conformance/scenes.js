// The GL 2.1 pixel conformance scenes, described once.
//
// Each scene is a list of ops ["GLName", ...args] in a tiny GL-call DSL.
// reference/gen_c.js turns the list into C for Apple's CGL (the reference,
// recorded in references.json.gz); to_stream.js interprets the same list into
// VGL2 records for the executor (gl_conformance_browser_test.html). Enum
// arguments are strings without the GL_ prefix; both sides resolve them
// independently (C via the SDK headers, JS via gl_constants.js).
//
// The framebuffer is 64x64 RGBA8 + depth24/stencil8. Most scenes draw into a
// 4x4 grid of 16x16 tiles; only each tile's 12x12 interior is drawn, so tile
// borders never depend on rasterization rules.
"use strict";

const SIZE = 64;
const EPS = 0.001;

class Scene {
    constructor(name, opts) {
        this.name = name;
        this.what = opts.what || "";
        this.spec = opts.spec || "";
        this.mode = opts.mode || "strict";   // "strict" | "loose" (lines/points)
        this.ops = [];
        this.tiles = [];
    }
    op(...args) { this.ops.push(args); return this; }
    ops_(list) { for (const o of list) this.ops.push(o); return this; }
    tileRect(i) {
        const x = (i % 4) * 16 + 2, y = Math.floor(i / 4) * 16 + 2;
        return [x, y, 12, 12];
    }
    label(i, text) {
        const [x, y, w, h] = this.tileRect(i);
        this.tiles.push({ label: text, x, y, w, h });
    }
    // The last tile's colour as the specification says it is (RGBA bytes),
    // where the reference renderers disagree with it; `why` cites the clause
    expect(rgba, why) {
        Object.assign(this.tiles[this.tiles.length - 1], { expect: rgba, why });
        return this;
    }
    ortho2d() {
        return this.op("MatrixMode", "PROJECTION").op("LoadIdentity")
            .op("Ortho", 0, SIZE, 0, SIZE, -1, 1)
            .op("MatrixMode", "MODELVIEW").op("LoadIdentity")
            .op("Viewport", 0, 0, SIZE, SIZE);
    }
    // A quad in window coordinates (after ortho2d); per(i) yields ops before
    // vertex i. Counter-clockwise (front-facing) unless cw.
    rect(x0, y0, x1, y1, per, cw, z) {
        z = z || 0;
        let v = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        if (cw) v = [v[0], v[3], v[2], v[1]];
        this.op("Begin", "QUADS");
        v.forEach((p, i) => {
            if (per) this.ops_(per(i));
            this.op("Vertex3f", p[0], p[1], z);
        });
        return this.op("End");
    }
    tileQuad(i, text, per, cw) {
        this.label(i, text);
        const [x, y, w, h] = this.tileRect(i);
        return this.rect(x, y, x + w, y + h, per, cw);
    }
    // "Spot" tile: a quad that is a point in eye space (all four vertices
    // within EPS of `eye`), magnified to the tile by the projection. Every
    // vertex sees the same lighting/fog/texgen inputs, so the tile is a flat
    // colour and per-vertex vs per-pixel evaluation cannot differ.
    // opts: eye [x,y,z] (eye space), obj (object-space centre, default eye;
    // set when the scene leaves a non-identity modelview), normal, per, cw,
    // scale (object-space EPS multiplier when modelview scales).
    spot(i, text, opts) {
        this.label(i, text);
        const [x, y, w, h] = this.tileRect(i);
        const eye = opts.eye, obj = opts.obj || eye;
        const oe = EPS * (opts.scale || 1);
        this.op("Viewport", x, y, w, h)
            .op("MatrixMode", "PROJECTION").op("LoadIdentity")
            .op("Ortho", eye[0] - EPS, eye[0] + EPS, eye[1] - EPS, eye[1] + EPS,
                -eye[2] - 1, -eye[2] + 1)
            .op("MatrixMode", "MODELVIEW");
        let v = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        if (opts.cw) v = [v[0], v[3], v[2], v[1]];
        this.op("Begin", "QUADS");
        for (const [sx, sy] of v) {
            if (opts.normal) this.op("Normal3f", ...opts.normal);
            if (opts.per) this.ops_(opts.per());
            this.op("Vertex3f", obj[0] + sx * oe, obj[1] + sy * oe, obj[2]);
        }
        this.op("End");
        return this.op("Viewport", 0, 0, SIZE, SIZE);
    }
}

const scenes = [];
function scene(name, opts, build) {
    const s = new Scene(name, opts);
    build(s);
    scenes.push(s);
}

const nearest = (target) => [
    ["TexParameteri", target || "TEXTURE_2D", "TEXTURE_MIN_FILTER", "NEAREST"],
    ["TexParameteri", target || "TEXTURE_2D", "TEXTURE_MAG_FILTER", "NEAREST"],
];
const tex1x1 = (name, ifmt, fmt, bytes) => [
    ["GenTextures", [name]], ["BindTexture", "TEXTURE_2D", name], ...nearest(),
    ["TexImage2D", "TEXTURE_2D", 0, ifmt, 1, 1, 0, fmt, "UNSIGNED_BYTE", { u8: bytes }],
];
const tc = (s, t) => () => [["TexCoord2f", s, t]];

/* ------------------------------------------------------------------ */
/* 1-5. Texture environment: mode x base internal format               */
/* ------------------------------------------------------------------ */

const TEX_FORMATS = [
    ["ALPHA", "ALPHA", [191]],
    ["LUMINANCE", "LUMINANCE", [64]],
    ["INTENSITY", "LUMINANCE", [64]],
    ["LUMINANCE_ALPHA", "LUMINANCE_ALPHA", [64, 191]],
    ["RGB", "RGB", [51, 153, 230]],
    ["RGBA", "RGBA", [51, 153, 230, 191]],
];
for (const mode of ["MODULATE", "REPLACE", "DECAL", "BLEND", "ADD"]) {
    scene("texenv_" + mode.toLowerCase(), {
        what: "glTexEnv " + mode + " with each base internal format (1x1 texel, colour (0.8,0.4,0.6,0.5), env colour (0.1,0.9,0.3,0.7))",
        spec: "GL 2.1 §3.8.13 Tables 3.22/3.23",
    }, s => {
        s.ortho2d().op("Enable", "TEXTURE_2D")
            .op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", mode)
            .op("TexEnvfv", "TEXTURE_ENV", "TEXTURE_ENV_COLOR", [0.1, 0.9, 0.3, 0.7]);
        TEX_FORMATS.forEach(([ifmt, fmt, bytes], i) => {
            if (mode === "DECAL" && !/^RGB/.test(ifmt)) return; // undefined in GL
            s.ops_(tex1x1(i + 1, ifmt, fmt, bytes));
            s.op("Color4f", 0.8, 0.4, 0.6, 0.5);
            s.tileQuad(i, mode + "/" + ifmt, tc(0.5, 0.5));
        });
    });
}

/* ------------------------------------------------------------------ */
/* 6. ARB_texture_env_combine / dot3 / crossbar                        */
/* ------------------------------------------------------------------ */

function combine(unit, o) {
    const out = [["ActiveTexture", unit], ["TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "COMBINE"],
        ["TexEnvi", "TEXTURE_ENV", "COMBINE_RGB", o.rgb], ["TexEnvi", "TEXTURE_ENV", "COMBINE_ALPHA", o.alpha || "REPLACE"]];
    const src = o.src || ["TEXTURE", "PREVIOUS", "CONSTANT"];
    const op = o.op || ["SRC_COLOR", "SRC_COLOR", "SRC_ALPHA"];
    const srcA = o.srcA || ["TEXTURE", "PREVIOUS", "CONSTANT"];
    const opA = o.opA || ["SRC_ALPHA", "SRC_ALPHA", "SRC_ALPHA"];
    for (let k = 0; k < 3; ++k) {
        out.push(["TexEnvi", "TEXTURE_ENV", "SOURCE" + k + "_RGB", src[k]]);
        out.push(["TexEnvi", "TEXTURE_ENV", "OPERAND" + k + "_RGB", op[k]]);
        out.push(["TexEnvi", "TEXTURE_ENV", "SOURCE" + k + "_ALPHA", srcA[k]]);
        out.push(["TexEnvi", "TEXTURE_ENV", "OPERAND" + k + "_ALPHA", opA[k]]);
    }
    out.push(["TexEnvf", "TEXTURE_ENV", "RGB_SCALE", o.rgbScale || 1]);
    out.push(["TexEnvf", "TEXTURE_ENV", "ALPHA_SCALE", o.alphaScale || 1]);
    out.push(["TexEnvfv", "TEXTURE_ENV", "TEXTURE_ENV_COLOR", o.constant || [0.25, 0.5, 1.0, 0.25]]);
    return out;
}
scene("texenv_combine", {
    what: "COMBINE: INTERPOLATE, DOT3_RGB/RGBA, ADD_SIGNED, SUBTRACT, scales, ONE_MINUS operands, two-unit chain, crossbar",
    spec: "GL 2.1 §3.8.13 Tables 3.24-3.26 (ARB_texture_env_combine/dot3/crossbar)",
}, s => {
    s.ortho2d();
    // unit 0 texture A (0.75,0.75,0.5,0.75), unit 1 texture B (0.2,0.4,0.6,0.5)
    s.op("ActiveTexture", "TEXTURE1").ops_(tex1x1(2, "RGBA", "RGBA", [51, 102, 153, 128]));
    s.op("ActiveTexture", "TEXTURE0").ops_(tex1x1(1, "RGBA", "RGBA", [191, 191, 128, 191]));
    s.op("Enable", "TEXTURE_2D");
    s.op("Color4f", 0.4, 0.2, 0.9, 0.6);
    const cases = [
        ["INTERPOLATE tex,prim by const.a", { rgb: "INTERPOLATE", src: ["TEXTURE", "PRIMARY_COLOR", "CONSTANT"], op: ["SRC_COLOR", "SRC_COLOR", "SRC_ALPHA"] }],
        ["DOT3_RGB tex.const", { rgb: "DOT3_RGB", src: ["TEXTURE", "CONSTANT", "CONSTANT"], constant: [1.0, 0.75, 0.5, 0.25], alpha: "REPLACE", srcA: ["PRIMARY_COLOR", "PREVIOUS", "CONSTANT"] }],
        ["DOT3_RGBA tex.const", { rgb: "DOT3_RGBA", src: ["TEXTURE", "CONSTANT", "CONSTANT"], constant: [1.0, 0.75, 0.5, 0.25], alpha: "REPLACE", srcA: ["PRIMARY_COLOR", "PREVIOUS", "CONSTANT"] }],
        ["ADD_SIGNED tex+prim", { rgb: "ADD_SIGNED", alpha: "ADD_SIGNED", src: ["TEXTURE", "PRIMARY_COLOR", "CONSTANT"], srcA: ["TEXTURE", "PRIMARY_COLOR", "CONSTANT"] }],
        ["SUBTRACT tex-prim", { rgb: "SUBTRACT", alpha: "SUBTRACT", src: ["TEXTURE", "PRIMARY_COLOR", "CONSTANT"], srcA: ["TEXTURE", "PRIMARY_COLOR", "CONSTANT"] }],
        ["MODULATE RGB_SCALE2 ALPHA_SCALE4", { rgb: "MODULATE", alpha: "MODULATE", src: ["TEXTURE", "PRIMARY_COLOR", "CONSTANT"], srcA: ["TEXTURE", "PRIMARY_COLOR", "CONSTANT"], rgbScale: 2, alphaScale: 4 }],
        ["REPLACE 1-tex.rgb, 1-tex.a", { rgb: "REPLACE", alpha: "REPLACE", op: ["ONE_MINUS_SRC_COLOR", "SRC_COLOR", "SRC_ALPHA"], opA: ["ONE_MINUS_SRC_ALPHA", "SRC_ALPHA", "SRC_ALPHA"] }],
        ["REPLACE rgb from tex.a", { rgb: "REPLACE", op: ["SRC_ALPHA", "SRC_COLOR", "SRC_ALPHA"] }],
    ];
    cases.forEach(([text, o], i) => {
        s.ops_(combine("TEXTURE0", o));
        s.tileQuad(i, text, tc(0.5, 0.5));
    });
    // two units: unit0 MODULATE tex*prim, unit1 ADD previous + texB
    s.op("ActiveTexture", "TEXTURE0").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "MODULATE");
    s.ops_(combine("TEXTURE1", { rgb: "ADD", alpha: "ADD", src: ["PREVIOUS", "TEXTURE", "CONSTANT"], srcA: ["PREVIOUS", "TEXTURE", "CONSTANT"] }));
    s.op("Enable", "TEXTURE_2D");
    s.tileQuad(9, "unit0 MODULATE, unit1 COMBINE ADD", () => [["MultiTexCoord2f", "TEXTURE0", 0.5, 0.5], ["MultiTexCoord2f", "TEXTURE1", 0.5, 0.5]]);
    // unit 0 disabled: unit 1 PREVIOUS must be the primary colour
    s.op("ActiveTexture", "TEXTURE0").op("Disable", "TEXTURE_2D");
    s.ops_(combine("TEXTURE1", { rgb: "MODULATE", alpha: "MODULATE", src: ["PREVIOUS", "TEXTURE", "CONSTANT"], srcA: ["PREVIOUS", "TEXTURE", "CONSTANT"] }));
    s.tileQuad(10, "unit0 disabled, unit1 PREVIOUS*tex", () => [["MultiTexCoord2f", "TEXTURE1", 0.5, 0.5]]);
    s.op("Disable", "TEXTURE_2D").op("ActiveTexture", "TEXTURE0");
});
for (const enabled of [true, false]) scene("texenv_crossbar_" + (enabled ? "unit1_on" : "unit1_off"), {
    what: "ARB_texture_env_crossbar: unit 0 COMBINE REPLACE with source TEXTURE1" + (enabled ? " (unit 1 enabled)" : " (unit 1 disabled: unit 0 blending is disabled, primary colour passes)"),
    spec: "ARB_texture_env_crossbar (reference to a disabled unit disables blending on the referencing unit)",
}, s => {
    s.ortho2d();
    s.op("ActiveTexture", "TEXTURE1").ops_(tex1x1(2, "RGBA", "RGBA", [51, 102, 153, 128]));
    if (enabled) s.op("Enable", "TEXTURE_2D").ops_(combine("TEXTURE1", { rgb: "REPLACE", alpha: "REPLACE", src: ["PREVIOUS", "TEXTURE", "CONSTANT"], srcA: ["PREVIOUS", "TEXTURE", "CONSTANT"] }));
    s.op("ActiveTexture", "TEXTURE0").ops_(tex1x1(1, "RGBA", "RGBA", [191, 191, 128, 191])).op("Enable", "TEXTURE_2D");
    s.op("Color4f", 0.4, 0.2, 0.9, 0.6);
    s.ops_(combine("TEXTURE0", { rgb: "REPLACE", alpha: "REPLACE", src: ["TEXTURE1", "PREVIOUS", "CONSTANT"], srcA: ["TEXTURE1", "PREVIOUS", "CONSTANT"] }));
    s.tileQuad(0, enabled ? "unit0 = TEXTURE1 colour" : "unit1 off: primary colour", () => [["MultiTexCoord2f", "TEXTURE0", 0.5, 0.5], ["MultiTexCoord2f", "TEXTURE1", 0.5, 0.5]]);
    // Apple's renderers give black here, the extension's older "undefined"
    if (!enabled) s.expect([102, 51, 229, 153], "GL 2.1 §3.8.13: a unit whose environment references a disabled " +
        "unit is as if its texture blending were disabled -- the primary colour passes");
});

/* ------------------------------------------------------------------ */
/* 7. Fog                                                              */
/* ------------------------------------------------------------------ */

scene("fog", {
    what: "fog LINEAR(1..9)/EXP/EXP2(0.15) at eye z -2,-4,-6,-8; FOG_COORD source; alpha untouched",
    spec: "GL 2.1 §3.10 (eq. 3.29-3.31), §2.12 fog coordinate",
}, s => {
    s.op("Enable", "FOG").op("Fogfv", "FOG_COLOR", [0.2, 0.4, 1.0, 1.0])
        .op("Fogf", "FOG_START", 1).op("Fogf", "FOG_END", 9).op("Fogf", "FOG_DENSITY", 0.15)
        .op("MatrixMode", "MODELVIEW").op("LoadIdentity");
    const zs = [-2, -4, -6, -8];
    ["LINEAR", "EXP", "EXP2"].forEach((m, row) => {
        s.op("Fogi", "FOG_MODE", m);
        zs.forEach((z, col) => s.spot(row * 4 + col, m + " z=" + z, { eye: [0, 0, z], per: () => [["Color4f", 1, 0.9, 0.1, 0.5]] }));
    });
    s.op("Fogi", "FOG_MODE", "LINEAR").op("Fogi", "FOG_COORDINATE_SOURCE", "FOG_COORDINATE");
    [2, 5, 8].forEach((f, k) => s.spot(12 + k, "FOG_COORD=" + f + " (z=-8)", { eye: [0, 0, -8], per: () => [["Color4f", 1, 0.9, 0.1, 0.5], ["FogCoordf", f]] }));
    s.op("Fogi", "FOG_COORDINATE_SOURCE", "FRAGMENT_DEPTH");
    // radial vs |z|: off-axis point. GL allows |z_e| as the distance, so this
    // tile is informational.
    s.spot(15, "LINEAR off-axis (3,0,-4)", { eye: [3, 0, -4], per: () => [["Color4f", 1, 0.9, 0.1, 0.5]] });
});

/* ------------------------------------------------------------------ */
/* 8-10. Lighting                                                      */
/* ------------------------------------------------------------------ */

const LIGHT_BASE = [
    ["Enable", "LIGHTING"], ["Enable", "LIGHT0"],
    ["Lightfv", "LIGHT0", "AMBIENT", [0.1, 0.1, 0.1, 1]],
    ["Lightfv", "LIGHT0", "DIFFUSE", [0.8, 0.6, 0.4, 1]],
    ["Lightfv", "LIGHT0", "SPECULAR", [0.5, 0.5, 0.5, 1]],
    ["Materialfv", "FRONT_AND_BACK", "AMBIENT", [0.2, 0.2, 0.2, 1]],
    ["Materialfv", "FRONT_AND_BACK", "DIFFUSE", [0.9, 0.7, 0.5, 0.6]],
    ["Materialfv", "FRONT_AND_BACK", "SPECULAR", [0.6, 0.6, 0.6, 1]],
    ["Materialf", "FRONT_AND_BACK", "SHININESS", 16],
    ["Materialfv", "FRONT_AND_BACK", "EMISSION", [0.05, 0, 0, 1]],
    ["MatrixMode", "MODELVIEW"], ["LoadIdentity"],
];
const dirLight = (x, y, z) => [["Lightfv", "LIGHT0", "POSITION", [x, y, z, 0]]];

scene("light_basic", {
    what: "directional diffuse+specular, infinite vs local viewer, normal scaling (NORMALIZE/RESCALE_NORMAL), material alpha",
    spec: "GL 2.1 §2.14.1 (eq. 2.4), §2.11.3 normal transformation",
}, s => {
    s.ops_(LIGHT_BASE).ops_(dirLight(0, 0, 1));
    s.spot(0, "N=(0,0,1) L=(0,0,1)", { eye: [0, 0, -3], normal: [0, 0, 1] });
    s.spot(1, "N=(0.6,0,0.8) infinite viewer", { eye: [0, 0, -3], normal: [0.6, 0, 0.8] });
    s.op("LightModeli", "LIGHT_MODEL_LOCAL_VIEWER", 1);
    s.spot(2, "N=(0.6,0,0.8) local viewer at (0.5,0.3,-3)", { eye: [0.5, 0.3, -3], normal: [0.6, 0, 0.8] });
    s.op("LightModeli", "LIGHT_MODEL_LOCAL_VIEWER", 0);
    s.ops_(dirLight(0.6, 0, 0.8));
    s.spot(3, "L=(0.6,0,0.8) unnormalised dir (3,0,4)", { eye: [0, 0, -3], normal: [0, 0, 1] });
    s.op("Lightfv", "LIGHT0", "POSITION", [3, 0, 4, 0]);
    s.spot(4, "L given as (3,0,4,0)", { eye: [0, 0, -3], normal: [0, 0, 1] });
    s.ops_(dirLight(0, 0, 1));
    // modelview scale 0.5 => normals transformed by inverse transpose grow 2x
    s.op("Scalef", 0.5, 0.5, 0.5);
    s.spot(5, "Scale 0.5, N=(0.6,0,0.8) no NORMALIZE", { eye: [0, 0, -3], obj: [0, 0, -6], normal: [0.6, 0, 0.8], scale: 2 });
    s.op("Enable", "NORMALIZE");
    s.spot(6, "Scale 0.5, NORMALIZE", { eye: [0, 0, -3], obj: [0, 0, -6], normal: [0.6, 0, 0.8], scale: 2 });
    s.op("Disable", "NORMALIZE").op("Enable", "RESCALE_NORMAL");
    s.spot(7, "Scale 0.5, RESCALE_NORMAL", { eye: [0, 0, -3], obj: [0, 0, -6], normal: [0.6, 0, 0.8], scale: 2 });
    s.op("Disable", "RESCALE_NORMAL").op("LoadIdentity");
    s.spot(8, "unnormalised normal (0,0,2) no NORMALIZE", { eye: [0, 0, -3], normal: [0, 0, 2] });
    s.spot(9, "N=(0,0,-1) facing away (ambient+emission)", { eye: [0, 0, -3], normal: [0, 0, -1] });
    s.op("LightModelfv", "LIGHT_MODEL_AMBIENT", [0.4, 0.1, 0.3, 1]);
    s.spot(10, "LIGHT_MODEL_AMBIENT (0.4,0.1,0.3)", { eye: [0, 0, -3], normal: [0, 0, -1] });
    s.op("LightModelfv", "LIGHT_MODEL_AMBIENT", [0.2, 0.2, 0.2, 1]);
    s.op("Enable", "LIGHT1").op("Lightfv", "LIGHT1", "POSITION", [-1, 0, 0, 0])
        .op("Lightfv", "LIGHT1", "DIFFUSE", [0, 0.5, 0.5, 1]);
    s.spot(11, "LIGHT0+LIGHT1, N=(-0.6,0,0.8)", { eye: [0, 0, -3], normal: [-0.6, 0, 0.8] });
    s.op("Disable", "LIGHT1");
});

scene("light_positional_spot", {
    what: "positional light with attenuation, spot cutoff/exponent (spot factor also scales the light's ambient term)",
    spec: "GL 2.1 §2.14.1 (att_i, spot_i), Table 2.10",
}, s => {
    s.ops_(LIGHT_BASE);
    s.op("Lightfv", "LIGHT0", "POSITION", [2, 1, 1, 1])
        .op("Lightf", "LIGHT0", "CONSTANT_ATTENUATION", 0.5)
        .op("Lightf", "LIGHT0", "LINEAR_ATTENUATION", 0.1)
        .op("Lightf", "LIGHT0", "QUADRATIC_ATTENUATION", 0.05);
    s.spot(0, "positional (2,1,1) atten, P=(0,0,-2) N=+z", { eye: [0, 0, -2], normal: [0, 0, 1] });
    s.spot(1, "positional atten, P=(1,1,-5)", { eye: [1, 1, -5], normal: [0, 0, 1] });
    s.spot(2, "positional atten, N=(0.6,0,0.8)", { eye: [0, 0, -2], normal: [0.6, 0, 0.8] });
    s.op("Lightf", "LIGHT0", "CONSTANT_ATTENUATION", 1)
        .op("Lightf", "LIGHT0", "LINEAR_ATTENUATION", 0)
        .op("Lightf", "LIGHT0", "QUADRATIC_ATTENUATION", 0);
    s.op("Lightfv", "LIGHT0", "POSITION", [0, 0, 0, 1])
        .op("Lightfv", "LIGHT0", "SPOT_DIRECTION", [0, 0, -1, 0])
        .op("Lightf", "LIGHT0", "SPOT_CUTOFF", 30)
        .op("Lightf", "LIGHT0", "SPOT_EXPONENT", 8);
    s.spot(4, "spot 30deg exp 8, P=(0.5,0,-2) inside", { eye: [0.5, 0, -2], normal: [0, 0, 1] });
    s.spot(5, "spot, P=(0,0,-2) on axis", { eye: [0, 0, -2], normal: [0, 0, 1] });
    s.spot(6, "spot, P=(2,0,-2) outside (45deg)", { eye: [2, 0, -2], normal: [0, 0, 1] });
    s.op("Lightf", "LIGHT0", "SPOT_EXPONENT", 0);
    s.spot(7, "spot exp 0, P=(1,0,-2) inside", { eye: [1, 0, -2], normal: [0, 0, 1] });
    // spot direction is transformed by the modelview at specification time
    s.op("Rotatef", 90, 0, 1, 0).op("Lightfv", "LIGHT0", "SPOT_DIRECTION", [0, 0, -1, 0]).op("LoadIdentity");
    s.spot(8, "spot dir set under Rotate(90,y): now -x; P=(-2,0,-0.2)", { eye: [-2, 0, -0.2], normal: [1, 0, 0] });
    s.spot(9, "same, P=(0,0,-2) now outside", { eye: [0, 0, -2], normal: [0, 0, 1] });
    s.op("Lightf", "LIGHT0", "SPOT_CUTOFF", 180);
    // light position transformed by modelview at specification time
    s.op("Translatef", 0, 0, -4).op("Lightfv", "LIGHT0", "POSITION", [0, 0, 2, 1]).op("LoadIdentity");
    s.spot(12, "light pos (0,0,2) set under Translate(0,0,-4): eye (0,0,-2); P=(0,0,-3)", { eye: [0, 0, -3], normal: [0, 0, 1] });
    s.spot(13, "same, P=(0,0,-1) behind the light", { eye: [0, 0, -1], normal: [0, 0, 1] });
});

scene("light_twoside_colormaterial", {
    what: "two-sided lighting, back material, COLOR_MATERIAL tracking and latching, separate specular with texturing",
    spec: "GL 2.1 §2.14.1 two-sided, §2.14.3 ColorMaterial, §3.9 colour sum",
}, s => {
    s.ops_(LIGHT_BASE).ops_(dirLight(0, 0, 1));
    s.op("Materialfv", "BACK", "DIFFUSE", [0.1, 0.9, 0.2, 1]).op("Materialfv", "BACK", "AMBIENT", [0, 0, 0.5, 1]);
    s.spot(0, "one-sided, back-facing, N=(0,0,1)", { eye: [0, 0, -3], normal: [0, 0, 1], cw: true });
    s.op("LightModeli", "LIGHT_MODEL_TWO_SIDE", 1);
    s.spot(1, "two-sided, back-facing, N=(0,0,-1)", { eye: [0, 0, -3], normal: [0, 0, -1], cw: true });
    s.spot(2, "two-sided, back-facing, N=(0,0,1)", { eye: [0, 0, -3], normal: [0, 0, 1], cw: true });
    s.spot(3, "two-sided, front-facing, N=(0,0,1)", { eye: [0, 0, -3], normal: [0, 0, 1] });
    s.op("LightModeli", "LIGHT_MODEL_TWO_SIDE", 0);
    s.op("ColorMaterial", "FRONT_AND_BACK", "AMBIENT_AND_DIFFUSE").op("Enable", "COLOR_MATERIAL");
    s.spot(4, "COLOR_MATERIAL AMBIENT_AND_DIFFUSE color (0.3,0.9,0.6,0.4)", { eye: [0, 0, -3], normal: [0.6, 0, 0.8], per: () => [["Color4f", 0.3, 0.9, 0.6, 0.4]] });
    s.op("ColorMaterial", "FRONT_AND_BACK", "DIFFUSE").op("Color4f", 0.9, 0.1, 0.1, 1).op("Disable", "COLOR_MATERIAL").op("Color4f", 0, 1, 0, 1);
    s.spot(5, "COLOR_MATERIAL latched diffuse (0.9,0.1,0.1) after disable", { eye: [0, 0, -3], normal: [0, 0, 1] });
    s.op("ColorMaterial", "FRONT_AND_BACK", "EMISSION").op("Enable", "COLOR_MATERIAL");
    s.spot(6, "COLOR_MATERIAL EMISSION color (0,0,0.5)", { eye: [0, 0, -3], normal: [0, 0, -1], per: () => [["Color4f", 0, 0, 0.5, 1]] });
    s.op("Disable", "COLOR_MATERIAL");
    s.op("Materialfv", "FRONT_AND_BACK", "DIFFUSE", [0.9, 0.7, 0.5, 0.6]).op("Materialfv", "FRONT_AND_BACK", "EMISSION", [0.05, 0, 0, 1])
        .op("Materialfv", "FRONT_AND_BACK", "AMBIENT", [0.2, 0.2, 0.2, 1]);
    // separate specular: texture is a 50% grey
    s.ops_(tex1x1(1, "RGB", "RGB", [128, 128, 128])).op("Enable", "TEXTURE_2D");
    s.spot(8, "SINGLE_COLOR, tex 0.5 MODULATE", { eye: [0, 0, -3], normal: [0, 0, 1], per: tc(0.5, 0.5) });
    s.op("LightModeli", "LIGHT_MODEL_COLOR_CONTROL", "SEPARATE_SPECULAR_COLOR");
    s.spot(9, "SEPARATE_SPECULAR_COLOR, tex 0.5 MODULATE", { eye: [0, 0, -3], normal: [0, 0, 1], per: tc(0.5, 0.5) });
    s.op("Disable", "TEXTURE_2D");
    s.spot(10, "SEPARATE_SPECULAR_COLOR, no texture (sum still applies)", { eye: [0, 0, -3], normal: [0, 0, 1] });
    s.op("LightModeli", "LIGHT_MODEL_COLOR_CONTROL", "SINGLE_COLOR");
    s.op("Materialf", "FRONT_AND_BACK", "SHININESS", 0);
    s.spot(11, "shininess 0, N.H<1", { eye: [0, 0, -3], normal: [0.6, 0, 0.8] });
});

/* ------------------------------------------------------------------ */
/* 11. Flat shading provoking vertex                                   */
/* ------------------------------------------------------------------ */

const PCOL = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]];
function prim(s, mode, verts, tile, text) {
    s.label(tile, text);
    s.op("Begin", mode);
    verts.forEach((v, i) => s.op("Color3f", ...PCOL[i]).op("Vertex2f", v[0], v[1]));
    s.op("End");
}
scene("flat_provoking", {
    what: "SHADE_MODEL FLAT: which vertex colours each primitive (vertex colours R,G,B,Y,M,C in order)",
    spec: "GL 2.1 §2.14.7 Table 2.12 (last vertex; POLYGON uses the first)",
}, s => {
    s.ortho2d().op("ShadeModel", "FLAT");
    // tile 0: one triangle
    prim(s, "TRIANGLES", [[2, 2], [14, 2], [2, 14]], 0, "TRIANGLES (expect v2 blue)");
    // tile 1: strip of 2 triangles: lower-right tri uses v2, upper-left v3
    prim(s, "TRIANGLE_STRIP", [[18, 2], [30, 2], [18, 14], [30, 14]], 1, "TRIANGLE_STRIP (v2 blue, v3 yellow)");
    prim(s, "TRIANGLE_FAN", [[34, 2], [46, 2], [46, 14], [34, 14]], 2, "TRIANGLE_FAN (v2 blue, v3 yellow)");
    prim(s, "QUADS", [[50, 2], [62, 2], [62, 14], [50, 14]], 3, "QUADS (v3 yellow)");
    prim(s, "QUAD_STRIP", [[2, 18], [2, 30], [8, 18], [8, 30], [14, 18], [14, 30]], 4, "QUAD_STRIP (v3 yellow, v5 cyan)");
    prim(s, "POLYGON", [[18, 18], [30, 18], [30, 30], [24, 31], [18, 30]], 5, "POLYGON (v0 red)");
    s.label(6, "TRIANGLES x2 (v2, v5)");
    s.op("Begin", "TRIANGLES");
    [[34, 18], [46, 18], [34, 30], [46, 18], [46, 30], [34, 30]].forEach((v, i) => s.op("Color3f", ...PCOL[i]).op("Vertex2f", ...v));
    s.op("End");
    // smooth baseline for comparison
    s.op("ShadeModel", "SMOOTH");
    prim(s, "QUADS", [[50, 18], [62, 18], [62, 30], [50, 30]], 7, "QUADS SMOOTH (gradient)");
    s.op("ShadeModel", "FLAT");
    // flat + lighting: the provoking vertex's lit colour
    s.op("Enable", "LIGHTING").op("Enable", "LIGHT0").op("Enable", "COLOR_MATERIAL");
    prim(s, "TRIANGLES", [[2, 34], [14, 34], [2, 46]], 8, "TRIANGLES lit+COLOR_MATERIAL (v2)");
    s.op("Disable", "LIGHTING");
});

scene("flat_lines", {
    what: "flat-shaded lines: LINES (2i), LINE_STRIP (i+1), LINE_LOOP closing segment (vertex 1)",
    spec: "GL 2.1 §2.14.7 Table 2.12", mode: "loose",
}, s => {
    s.ortho2d().op("ShadeModel", "FLAT");
    const lines = (mode, pts, y) => {
        s.op("Begin", mode);
        pts.forEach((p, i) => s.op("Color3f", ...PCOL[i]).op("Vertex2f", p[0] + 0.5, p[1] + 0.5));
        s.op("End");
    };
    lines("LINES", [[4, 8], [60, 8]], 0);
    lines("LINE_STRIP", [[4, 20], [30, 20], [60, 20]], 0);
    lines("LINE_LOOP", [[8, 34], [56, 34], [56, 58], [8, 58]], 0);
    s.tiles.push({ label: "LINES y=8 (green)", x: 10, y: 8, w: 40, h: 1 });
    s.tiles.push({ label: "LINE_STRIP 2nd seg (blue)", x: 34, y: 20, w: 20, h: 1 });
    s.tiles.push({ label: "LINE_LOOP closing edge x=8 (red)", x: 8, y: 38, w: 1, h: 16 });
    s.tiles.push({ label: "LINE_LOOP 3rd edge y=58 (yellow)", x: 12, y: 58, w: 40, h: 1 });
});

/* ------------------------------------------------------------------ */
/* 13. Clears                                                          */
/* ------------------------------------------------------------------ */

scene("clear_scissor_mask", {
    what: "glClear honours scissor, colour mask, depth/stencil masks",
    spec: "GL 2.1 §4.2.3 (Clear is affected by scissor, dither and masks)",
}, s => {
    s.ortho2d();
    s.op("ClearColor", 0.2, 0.2, 0.8, 1).op("Clear", ["COLOR_BUFFER_BIT"]);
    s.op("Enable", "SCISSOR_TEST").op("Scissor", 4, 4, 24, 24).op("ClearColor", 1, 0, 0, 1).op("Clear", ["COLOR_BUFFER_BIT"]);
    s.tiles.push({ label: "scissored clear red", x: 6, y: 6, w: 20, h: 20 });
    s.op("Scissor", 36, 4, 24, 24).op("ColorMask", 0, 1, 0, 1).op("ClearColor", 1, 1, 1, 0).op("Clear", ["COLOR_BUFFER_BIT"]).op("ColorMask", 1, 1, 1, 1);
    s.tiles.push({ label: "masked clear G,A only", x: 38, y: 6, w: 20, h: 20 });
    s.op("Scissor", 4, 36, 24, 24).op("ClearDepth", 0).op("Clear", ["DEPTH_BUFFER_BIT"]).op("ClearDepth", 1);
    s.op("Scissor", 36, 36, 24, 24).op("StencilMask", 0x0F).op("ClearStencil", 0xFF).op("Clear", ["STENCIL_BUFFER_BIT"]).op("StencilMask", 0xFF);
    s.op("Disable", "SCISSOR_TEST");
    s.op("Enable", "DEPTH_TEST").op("DepthFunc", "LESS").op("Color3f", 0, 1, 0);
    s.rect(0, 32, 64, 64, null, false, 0);
    s.tiles.push({ label: "depth cleared to 0 under scissor: quad rejected", x: 6, y: 38, w: 20, h: 20 });
    s.op("Disable", "DEPTH_TEST").op("Enable", "STENCIL_TEST").op("StencilFunc", "EQUAL", 0x0F, 0xFF).op("Color3f", 1, 1, 0);
    s.rect(32, 32, 64, 64);
    s.tiles.push({ label: "stencil cleared to 0x0F under mask: EQUAL 0x0F passes", x: 38, y: 38, w: 20, h: 20 });
    s.op("Disable", "STENCIL_TEST");
});

/* ------------------------------------------------------------------ */
/* 14. Polygon offset, depth range, depth func                         */
/* ------------------------------------------------------------------ */

scene("depth_offset_range", {
    what: "polygon offset fill/line enable, DepthRange incl. reversed (1,0), DepthFunc",
    spec: "GL 2.1 §3.5.5 polygon offset, §2.11.1 DepthRange (n>f allowed), §4.1.5",
}, s => {
    s.ortho2d().op("Enable", "DEPTH_TEST").op("DepthFunc", "LESS");
    s.op("Color3f", 1, 0, 0);
    s.rect(0, 0, 64, 32, null, false, 0);
    s.op("Color3f", 0, 1, 0);
    s.tileQuad(0, "coplanar, no offset (LESS fails: red)");
    s.op("Enable", "POLYGON_OFFSET_FILL").op("PolygonOffset", 0, -4);
    s.tileQuad(1, "offset units -4 (green)");
    s.op("PolygonOffset", 0, 4);
    s.tileQuad(2, "offset units +4 (red)");
    s.op("Disable", "POLYGON_OFFSET_FILL").op("Enable", "POLYGON_OFFSET_LINE").op("PolygonOffset", 0, -4);
    s.tileQuad(3, "only POLYGON_OFFSET_LINE enabled, fill drawn (red)");
    // GL 2.1 §3.5.5: line offset cannot affect filled polygons. Mesa 26.1's
    // quad path produces green here; keep the normative red expectation.
    s.tiles[s.tiles.length - 1].expect = [255, 0, 0, 255];
    s.op("Disable", "POLYGON_OFFSET_LINE");
    // DepthRange
    s.op("DepthFunc", "ALWAYS").op("DepthRange", 0.5, 1).op("Color3f", 0, 0, 1);
    s.tileQuad(4, "DepthRange(0.5,1) writes 0.75; then yellow at 0.7 LESS passes");
    s.op("DepthRange", 0, 1).op("DepthFunc", "LESS").op("Color3f", 1, 1, 0);
    s.rect(2, 18, 14, 30, null, false, -0.4);  // depth 0.7 < 0.75 passes
    // DepthMask false then EQUAL test
    s.op("DepthFunc", "ALWAYS").op("Color3f", 0.5, 0.5, 0.5).op("DepthMask", 0);
    s.tileQuad(6, "DepthMask(0) grey, then EQUAL at 0.5: white");
    s.op("DepthMask", 1).op("DepthFunc", "EQUAL").op("Color3f", 1, 1, 1);
    s.rect(34, 18, 46, 30, null, false, 0); // depth of row-0 red quad was 0.5 -> passes
    s.op("DepthFunc", "NEVER").op("Color3f", 0, 0, 0);
    s.tileQuad(7, "NEVER: stays red");
    s.op("DepthFunc", "LESS");
    // sloped quad with factor
    s.op("Color3f", 1, 0, 0);
    s.op("Begin", "QUADS").op("Vertex3f", 0, 32, -0.5).op("Vertex3f", 64, 32, 0.5).op("Vertex3f", 64, 48, 0.5).op("Vertex3f", 0, 48, -0.5).op("End");
    s.op("Enable", "POLYGON_OFFSET_FILL").op("PolygonOffset", -1, 0).op("Color3f", 0, 1, 0);
    s.op("Begin", "QUADS").op("Vertex3f", 0, 32, -0.5).op("Vertex3f", 64, 32, 0.5).op("Vertex3f", 64, 48, 0.5).op("Vertex3f", 0, 48, -0.5).op("End");
    s.op("Disable", "POLYGON_OFFSET_FILL");
    s.tiles.push({ label: "sloped quad, factor -1 (green)", x: 4, y: 34, w: 56, h: 12 });
});

scene("depth_range_reversed", {
    what: "glDepthRange(1,0) (n > f is legal) with GREATER",
    spec: "GL 2.1 §2.11.1 (no requirement that n <= f)",
}, s => {
    s.ortho2d().op("Enable", "DEPTH_TEST").op("Color3f", 1, 0, 0);
    s.rect(0, 0, 64, 64);
    s.op("DepthRange", 1, 0).op("DepthFunc", "ALWAYS").op("Color3f", 0, 1, 1);
    s.tileQuad(5, "DepthRange(1,0): cyan at depth 0.25, then GREATER magenta at 0.95 passes");
    s.rect(18, 18, 30, 30, null, false, -0.5); // ndc +0.5 -> reversed depth 0.25
    s.op("DepthFunc", "GREATER").op("Color3f", 1, 0, 1);
    s.rect(18, 18, 30, 30, null, false, 0.9); // reversed: ndc -0.9 -> depth 0.95 > 0.25 passes
    s.op("DepthRange", 0, 1).op("DepthFunc", "LESS");
    s.tiles.push({ label: "untouched red", x: 40, y: 40, w: 20, h: 20 });
});

/* ------------------------------------------------------------------ */
/* 15. User clip planes                                                */
/* ------------------------------------------------------------------ */

scene("clip_planes", {
    what: "glClipPlane is transformed by the inverse modelview current at specification time",
    spec: "GL 2.1 §2.12 (p_eye = p M^-1)",
}, s => {
    s.ortho2d();
    s.op("Translatef", 16, 0, 0).op("ClipPlane", "CLIP_PLANE0", [1, 0, 0, -32]).op("LoadIdentity");
    s.op("Scalef", 1, 0.5, 1).op("ClipPlane", "CLIP_PLANE1", [0, -1, 0, 20]).op("LoadIdentity");
    s.op("Enable", "CLIP_PLANE0").op("Color3f", 1, 0.5, 0);
    s.rect(0, 32, 64, 64);
    s.tiles.push({ label: "plane0 keeps x>=48", x: 40, y: 36, w: 20, h: 24 });
    s.op("Disable", "CLIP_PLANE0").op("Enable", "CLIP_PLANE1").op("Color3f", 0, 0.5, 1);
    s.rect(0, 0, 64, 32);
    s.tiles.push({ label: "plane1 keeps y<=10", x: 4, y: 2, w: 56, h: 28 });
    s.op("Disable", "CLIP_PLANE1");
});

/* ------------------------------------------------------------------ */
/* 16. Texgen                                                          */
/* ------------------------------------------------------------------ */

// 4x4 RGBA texture with 16 distinct texels; texel (i,j) colour encodes (i,j).
const GRID = [];
for (let j = 0; j < 4; ++j) for (let i = 0; i < 4; ++i) GRID.push(40 + i * 60, 40 + j * 60, 255 - (i + 4 * j) * 12, 255);
const gridTex = (name) => [["GenTextures", [name]], ["BindTexture", "TEXTURE_2D", name], ...nearest(),
    ["TexImage2D", "TEXTURE_2D", 0, "RGBA", 4, 4, 0, "RGBA", "UNSIGNED_BYTE", { u8: GRID }]];

scene("texgen", {
    what: "OBJECT_LINEAR, EYE_LINEAR (plane under non-identity modelview), SPHERE_MAP; 4x4 texel-index texture, REPLACE",
    spec: "GL 2.1 §2.11.4 (eq. 2.6-2.8)",
}, s => {
    s.ops_(gridTex(1)).op("Enable", "TEXTURE_2D").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "REPLACE");
    s.op("MatrixMode", "MODELVIEW").op("LoadIdentity");
    s.op("TexGeni", "S", "TEXTURE_GEN_MODE", "OBJECT_LINEAR").op("TexGeni", "T", "TEXTURE_GEN_MODE", "OBJECT_LINEAR")
        .op("TexGenfv", "S", "OBJECT_PLANE", [1, 0, 0, 0]).op("TexGenfv", "T", "OBJECT_PLANE", [0, 1, 0, 0])
        .op("Enable", "TEXTURE_GEN_S").op("Enable", "TEXTURE_GEN_T");
    s.spot(0, "OBJECT_LINEAR s=x=0.375 t=y=0.625 -> texel(1,2)", { eye: [0.375, 0.625, -1] });
    s.op("TexGenfv", "S", "OBJECT_PLANE", [0, 2, 0, 0]).op("TexGenfv", "T", "OBJECT_PLANE", [1, 0, 0, 0.5]);
    s.spot(1, "OBJECT_LINEAR swapped planes", { eye: [0.125, 0.3, -1] });
    s.op("TexGeni", "S", "TEXTURE_GEN_MODE", "EYE_LINEAR").op("TexGeni", "T", "TEXTURE_GEN_MODE", "EYE_LINEAR");
    s.op("Translatef", 0.25, 0, 0).op("TexGenfv", "S", "EYE_PLANE", [1, 0, 0, 0]).op("TexGenfv", "T", "EYE_PLANE", [0, 1, 0, 0]).op("LoadIdentity");
    s.spot(2, "EYE_LINEAR plane under Translate(0.25): s=x-0.25", { eye: [0.625, 0.625, -1] });
    s.op("Translatef", 0.5, 0, 0);
    s.spot(3, "EYE_LINEAR, draw-time modelview Translate(0.5)", { eye: [0.625, 0.625, -1], obj: [0.125, 0.625, -1] });
    s.op("LoadIdentity");
    s.op("TexGeni", "S", "TEXTURE_GEN_MODE", "SPHERE_MAP").op("TexGeni", "T", "TEXTURE_GEN_MODE", "SPHERE_MAP");
    s.spot(4, "SPHERE_MAP N=(0,0,1)", { eye: [0, 0, -1], normal: [0, 0, 1] });
    s.spot(5, "SPHERE_MAP N=(0.6,0,0.8) -> s=0.8", { eye: [0, 0, -1], normal: [0.6, 0, 0.8] });
    s.spot(6, "SPHERE_MAP N=(0,-0.6,0.8) -> t=0.2", { eye: [0, 0, -1], normal: [0, -0.6, 0.8] });
    s.spot(7, "SPHERE_MAP off-axis P=(0.5,0.5,-1)", { eye: [0.5, 0.5, -1], normal: [0, 0, 1] });
    s.op("Disable", "TEXTURE_GEN_S").op("Disable", "TEXTURE_GEN_T");
    // texture matrix
    s.op("MatrixMode", "TEXTURE").op("Translatef", 0.25, 0.5, 0).op("MatrixMode", "MODELVIEW");
    s.spot(8, "texture matrix Translate(0.25,0.5): (0.1,0.1)->(0.35,0.6)", { eye: [0, 0, -1], per: tc(0.1, 0.1) });
    s.op("MatrixMode", "TEXTURE").op("LoadIdentity").op("MatrixMode", "MODELVIEW");
    s.spot(9, "TexCoord4f q=2: (1.25,0.75,0,2)->(0.625,0.375)", { eye: [0, 0, -1], per: () => [["TexCoord4f", 1.25, 0.75, 0, 2]] });
});

/* ------------------------------------------------------------------ */
/* 17. Alpha test boundary                                             */
/* ------------------------------------------------------------------ */

scene("alpha_test", {
    what: "AlphaFunc ref 0.5 vs fragment alpha 127/255 and 128/255; ref 0 vs 0 and 1/255",
    spec: "GL 2.1 §4.1.4 (ref converted like an A component; precision implementation-dependent)",
}, s => {
    s.ortho2d().op("Enable", "ALPHA_TEST");
    const funcs = ["GREATER", "GEQUAL", "EQUAL", "LESS", "LEQUAL", "NOTEQUAL"];
    let t = 0;
    for (const a of [127, 128]) for (const f of funcs.slice(0, 6)) {
        if (t >= 12) break;
        s.op("AlphaFunc", f, 0.5).op("Color4ub", 255, 255, 255, a);
        s.tileQuad(t++, f + " 0.5, alpha " + a + "/255");
    }
    s.op("AlphaFunc", "GREATER", 0).op("Color4ub", 255, 255, 255, 0);
    s.tileQuad(12, "GREATER 0, alpha 0 (rejected)");
    s.op("Color4ub", 255, 255, 255, 1);
    s.tileQuad(13, "GREATER 0, alpha 1/255 (passes)");
    s.op("AlphaFunc", "GEQUAL", 0.502).op("Color4ub", 255, 255, 255, 128);
    s.tileQuad(14, "GEQUAL 0.502, alpha 128/255=0.50196");
    s.op("AlphaFunc", "LESS", 1.5).op("Color4ub", 255, 255, 255, 255);
    s.tileQuad(15, "LESS 1.5 (ref clamped to 1), alpha 1 (rejected)");
    s.op("Disable", "ALPHA_TEST");
});

/* ------------------------------------------------------------------ */
/* 18. Logic op                                                        */
/* ------------------------------------------------------------------ */

scene("logic_op", {
    what: "COLOR_LOGIC_OP: src (F0,0F,55,AA) over dst (33,66,99,CC)",
    spec: "GL 2.1 §4.1.10 Table 4.3",
}, s => {
    s.ortho2d().op("ClearColor", 0x33 / 255, 0x66 / 255, 0x99 / 255, 0xCC / 255).op("Clear", ["COLOR_BUFFER_BIT"]);
    s.op("Enable", "COLOR_LOGIC_OP").op("Color4ub", 0xF0, 0x0F, 0x55, 0xAA);
    ["CLEAR", "AND", "AND_REVERSE", "COPY", "AND_INVERTED", "NOOP", "XOR", "OR",
        "NOR", "EQUIV", "INVERT", "OR_REVERSE", "COPY_INVERTED", "OR_INVERTED", "NAND", "SET"].forEach((op, i) => {
        s.op("LogicOp", op);
        s.tileQuad(i, op);
    });
    s.op("Disable", "COLOR_LOGIC_OP");
});

/* ------------------------------------------------------------------ */
/* 19. Blending                                                        */
/* ------------------------------------------------------------------ */

scene("blend", {
    what: "blend factors/equations: separate, constant colour/alpha, dst alpha, MIN/MAX, reverse subtract, SRC_ALPHA_SATURATE",
    spec: "GL 2.1 §4.1.8 Tables 4.1/4.2",
}, s => {
    s.ortho2d().op("ClearColor", 0.2, 0.4, 0.6, 0.8).op("Clear", ["COLOR_BUFFER_BIT"]);
    s.op("Enable", "BLEND").op("Color4f", 0.9, 0.5, 0.1, 0.3).op("BlendColor", 0.25, 0.5, 0.75, 0.6);
    const cases = [
        [["BlendFunc", "SRC_ALPHA", "ONE_MINUS_SRC_ALPHA"], "SRC_ALPHA, 1-SRC_ALPHA"],
        [["BlendFuncSeparate", "SRC_ALPHA", "ONE_MINUS_SRC_ALPHA", "ONE", "ZERO"], "separate: alpha ONE,ZERO"],
        [["BlendFunc", "CONSTANT_ALPHA", "ONE_MINUS_CONSTANT_ALPHA"], "CONSTANT_ALPHA"],
        [["BlendFunc", "CONSTANT_COLOR", "ONE_MINUS_CONSTANT_COLOR"], "CONSTANT_COLOR"],
        [["BlendFunc", "DST_ALPHA", "ONE_MINUS_DST_ALPHA"], "DST_ALPHA"],
        [["BlendFunc", "SRC_ALPHA_SATURATE", "ONE"], "SRC_ALPHA_SATURATE, ONE"],
        [["BlendFunc", "DST_COLOR", "SRC_COLOR"], "DST_COLOR, SRC_COLOR"],
        [["BlendFunc", "ONE", "ONE"], "ONE, ONE (saturate)"],
    ];
    cases.forEach(([o, text], i) => { s.op(...o); s.tileQuad(i, text); });
    s.op("BlendFunc", "ONE", "ONE");
    [["MIN", 8], ["MAX", 9], ["FUNC_REVERSE_SUBTRACT", 10], ["FUNC_SUBTRACT", 11]].forEach(([eq, i]) => {
        s.op("BlendEquation", eq); s.tileQuad(i, "equation " + eq + " (ONE,ONE)");
    });
    s.op("BlendEquation", "FUNC_ADD").op("Disable", "BLEND");
});

/* ------------------------------------------------------------------ */
/* 20. Stencil                                                         */
/* ------------------------------------------------------------------ */

scene("stencil_ops", {
    what: "stencil INCR_WRAP/DECR_WRAP vs INCR/DECR saturation, INVERT, write mask; visualised with EQUAL tests",
    spec: "GL 2.1 §4.1.5 (EXT_stencil_wrap)",
}, s => {
    s.ortho2d().op("ClearStencil", 254).op("Clear", ["STENCIL_BUFFER_BIT"]).op("Enable", "STENCIL_TEST");
    s.op("StencilFunc", "ALWAYS", 0, 0xFF).op("ColorMask", 0, 0, 0, 0);
    const passes = (i, op, n) => {
        s.op("StencilOp", "KEEP", "KEEP", op);
        for (let k = 0; k < n; ++k) { const [x, y, w, h] = s.tileRect(i); s.rect(x, y, x + w, y + h); }
    };
    passes(0, "INCR_WRAP", 1);   // 255
    passes(1, "INCR_WRAP", 2);   // 0
    passes(2, "INCR_WRAP", 3);   // 1
    passes(3, "INCR", 3);        // 255
    passes(4, "DECR_WRAP", 255); // 255? 254-255 wraps -> 255
    passes(5, "INVERT", 1);      // 1
    s.op("StencilMask", 0x0F);
    passes(6, "INCR_WRAP", 3);   // 254 = 0xFE: low nibble 0xE+3 = 0x11 -> write mask 0x0F -> 0xF1
    s.op("StencilMask", 0xFF);
    passes(7, "ZERO", 1);        // 0
    s.op("StencilOp", "REPLACE", "KEEP", "KEEP").op("StencilFunc", "NEVER", 0x37, 0xFF);
    { const [x, y, w, h] = s.tileRect(8); s.rect(x, y, x + w, y + h); }   // 0x37 (sfail REPLACE)
    s.op("ColorMask", 1, 1, 1, 1).op("StencilOp", "KEEP", "KEEP", "KEEP");
    const show = [[255, [1, 0, 0]], [0, [0, 1, 0]], [1, [0, 0, 1]], [254, [1, 1, 0]], [0xF1, [1, 0, 1]], [0x37, [0, 1, 1]]];
    for (const [v, c] of show) {
        s.op("StencilFunc", "EQUAL", v, 0xFF).op("Color3f", ...c);
        s.rect(0, 0, 64, 64);
    }
    // masked compare: (ref & 0xF0) == (stencil & 0xF0)
    s.op("StencilFunc", "EQUAL", 0x3F, 0xF0).op("Color3f", 1, 1, 1);
    s.rect(0, 0, 64, 64);
    s.op("Disable", "STENCIL_TEST");
    ["INCR_WRAP x1 =255 red", "INCR_WRAP x2 =0 green", "INCR_WRAP x3 =1 blue", "INCR x3 saturates 255 red",
        "DECR_WRAP x255 from 254 = 255 red", "INVERT 254 = 1 blue", "StencilMask 0x0F INCR_WRAP x3 = 0xF1 magenta",
        "ZERO = 0 green", "sfail REPLACE 0x37 (white: mask 0xF0 match beats cyan)"].forEach((t, i) => s.label(i, t));
    s.label(9, "untouched 254 yellow");
});

/* ------------------------------------------------------------------ */
/* 21. Pixel rectangles                                                */
/* ------------------------------------------------------------------ */

const PIX16 = [];
for (let i = 0; i < 16; ++i) PIX16.push((i * 53) & 255, (i * 97 + 30) & 255, (255 - i * 15) & 255, 255);
scene("drawpixels_bitmap", {
    what: "DrawPixels with PixelZoom (incl. negative), LUMINANCE + RED_SCALE, raster colour latched at RasterPos, Bitmap advance, invalid raster pos, UNPACK_ALIGNMENT",
    spec: "GL 2.1 §3.6.4-3.6.5, §3.7 Bitmap, §2.13 current raster position",
}, s => {
    s.ortho2d();
    s.op("RasterPos2f", 2, 2).op("PixelZoom", 2, 3).op("DrawPixels", 4, 4, "RGBA", "UNSIGNED_BYTE", { u8: PIX16 });
    s.tiles.push({ label: "4x4 zoom (2,3) at (2,2)", x: 2, y: 2, w: 8, h: 12 });
    s.op("RasterPos2f", 20, 30).op("PixelZoom", 2, -2).op("DrawPixels", 4, 4, "RGBA", "UNSIGNED_BYTE", { u8: PIX16 });
    s.tiles.push({ label: "zoom (2,-2) at (20,30): rows go down", x: 20, y: 22, w: 8, h: 8 });
    s.op("PixelZoom", 1, 1);
    s.op("PixelTransferf", "RED_SCALE", 0.5).op("PixelTransferf", "GREEN_BIAS", 0.25);
    s.op("RasterPos2f", 34, 2).op("DrawPixels", 2, 2, "LUMINANCE", "UNSIGNED_BYTE", { u8: [200, 100, 0, 0, 50, 255] });
    s.tiles.push({ label: "LUMINANCE 2x2 (align 4) RED_SCALE .5 GREEN_BIAS .25", x: 34, y: 2, w: 2, h: 2 });
    s.op("PixelTransferf", "RED_SCALE", 1).op("PixelTransferf", "GREEN_BIAS", 0);
    s.op("PixelStorei", "UNPACK_ALIGNMENT", 4).op("RasterPos2f", 40, 2)
        .op("DrawPixels", 3, 2, "RGB", "UNSIGNED_BYTE", { u8: [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9, 255, 255, 0, 0, 255, 255, 255, 0, 255] });
    s.tiles.push({ label: "RGB 3x2 rows padded to 12 bytes", x: 40, y: 2, w: 3, h: 2 });
    // raster colour is latched at RasterPos; bitmap rows are 1 byte
    s.op("PixelStorei", "UNPACK_ALIGNMENT", 1).op("Color3f", 1, 0, 0).op("RasterPos2f", 2, 34).op("Color3f", 0, 1, 0)
        .op("Bitmap", 8, 8, 0, 0, 10, 0, { u8: [0xFF, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xF0] })
        .op("Bitmap", 8, 8, 0, 0, 10, 0, { u8: [0xFF, 0xFF, 0, 0, 0xFF, 0xFF, 0, 0xAA] });
    s.tiles.push({ label: "Bitmap red (latched), first", x: 2, y: 34, w: 8, h: 8 });
    s.tiles.push({ label: "Bitmap advanced by xmove 10", x: 12, y: 34, w: 8, h: 8 });
    // invalid raster position: nothing drawn
    s.op("RasterPos2f", -10, 50).op("DrawPixels", 4, 4, "RGBA", "UNSIGNED_BYTE", { u8: PIX16 });
    s.op("Bitmap", 0, 0, 0, 0, 20, 0, { u8: [] }).op("DrawPixels", 4, 4, "RGBA", "UNSIGNED_BYTE", { u8: PIX16 });
    s.tiles.push({ label: "invalid raster pos (x=-10, then moved): nothing", x: 0, y: 48, w: 16, h: 8 });
    // WindowPos is always valid; partly off-screen
    s.op("WindowPos2f", 62, 50).op("DrawPixels", 4, 4, "RGBA", "UNSIGNED_BYTE", { u8: PIX16 });
    s.tiles.push({ label: "WindowPos (62,50): 2 columns visible", x: 60, y: 48, w: 4, h: 8 });
    // raster pos with depth test: DrawPixels uses the raster z
    s.op("Enable", "DEPTH_TEST").op("DepthFunc", "LESS").op("Color3f", 0.5, 0.5, 0.5);
    s.rect(40, 30, 60, 44, null, false, 0);
    s.op("RasterPos3f", 42, 32, -0.5).op("DrawPixels", 4, 4, "RGBA", "UNSIGNED_BYTE", { u8: PIX16 });  // depth 0.75: hidden
    s.op("RasterPos3f", 50, 32, 0.5).op("DrawPixels", 4, 4, "RGBA", "UNSIGNED_BYTE", { u8: PIX16 });   // depth 0.25: drawn
    s.op("Disable", "DEPTH_TEST");
    s.tiles.push({ label: "DrawPixels behind grey (depth): hidden", x: 42, y: 32, w: 4, h: 4 });
    s.tiles.push({ label: "DrawPixels in front: drawn", x: 50, y: 32, w: 4, h: 4 });
});

scene("copy_pixels_teximage", {
    what: "CopyTexImage2D / CopyTexSubImage2D / CopyPixels orientation",
    spec: "GL 2.1 §3.8.2, §4.3.3",
}, s => {
    s.ortho2d().op("Color3f", 1, 0, 0);
    s.rect(0, 0, 16, 8).op("Color3f", 0, 1, 0).rect(0, 8, 16, 16).op("Color3f", 0, 0, 1).rect(0, 0, 4, 4);
    s.op("GenTextures", [1]).op("BindTexture", "TEXTURE_2D", 1).ops_(nearest())
        .op("CopyTexImage2D", "TEXTURE_2D", 0, "RGBA", 0, 0, 16, 16, 0);
    s.op("Enable", "TEXTURE_2D").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "REPLACE");
    s.rect(20, 0, 36, 16, i => [["TexCoord2f", [0, 1, 1, 0][i], [0, 0, 1, 1][i]]]);
    s.tiles.push({ label: "CopyTexImage2D drawn back (red bottom, blue corner)", x: 20, y: 0, w: 16, h: 16 });
    s.op("CopyTexSubImage2D", "TEXTURE_2D", 0, 0, 0, 0, 8, 16, 8);  // top green half -> bottom rows
    s.rect(40, 0, 56, 16, i => [["TexCoord2f", [0, 1, 1, 0][i], [0, 0, 1, 1][i]]]);
    s.tiles.push({ label: "CopyTexSubImage2D(yoff 0 <- y 8): all green", x: 40, y: 0, w: 16, h: 16 });
    s.op("Disable", "TEXTURE_2D");
    s.op("RasterPos2f", 4, 24).op("CopyPixels", 0, 0, 16, 16, "COLOR");
    s.tiles.push({ label: "CopyPixels to (4,24)", x: 4, y: 24, w: 16, h: 16 });
    s.op("RasterPos2f", 24, 40).op("PixelZoom", 1, -1).op("CopyPixels", 0, 0, 16, 16, "COLOR").op("PixelZoom", 1, 1);
    s.tiles.push({ label: "CopyPixels zoom (1,-1) at (24,40)", x: 24, y: 24, w: 16, h: 16 });
});

scene("fbo_render_to_texture", {
    what: "EXT_framebuffer_object: render into a texture, sample it; ReadPixels from the FBO",
    spec: "EXT_framebuffer_object; GL 2.1 §4.3.2",
}, s => {
    s.op("GenTextures", [3]).op("BindTexture", "TEXTURE_2D", 3).ops_(nearest())
        .op("TexImage2D", "TEXTURE_2D", 0, "RGBA8", 16, 16, 0, "RGBA", "UNSIGNED_BYTE", null);
    s.op("GenFramebuffers", [50]).op("BindFramebuffer", "FRAMEBUFFER_EXT", 50)
        .op("FramebufferTexture2D", "FRAMEBUFFER_EXT", "COLOR_ATTACHMENT0", "TEXTURE_2D", 3, 0);
    s.op("Viewport", 0, 0, 16, 16).op("MatrixMode", "PROJECTION").op("LoadIdentity").op("Ortho", 0, 16, 0, 16, -1, 1)
        .op("MatrixMode", "MODELVIEW").op("LoadIdentity");
    s.op("ClearColor", 0, 0, 1, 1).op("Clear", ["COLOR_BUFFER_BIT"]).op("Color3f", 1, 0, 0).rect(0, 0, 16, 4).op("Color3f", 0, 1, 0).rect(0, 0, 4, 16);
    s.op("ReadPixels", 0, 0, 2, 2, "RGBA", "UNSIGNED_BYTE");
    s.op("BindFramebuffer", "FRAMEBUFFER_EXT", 0).op("ClearColor", 0, 0, 0, 0);
    s.ortho2d().op("Enable", "TEXTURE_2D").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "REPLACE");
    s.rect(8, 8, 40, 40, i => [["TexCoord2f", [0, 1, 1, 0][i], [0, 0, 1, 1][i]]]);
    s.tiles.push({ label: "FBO texture drawn 2x (red bottom, green left)", x: 8, y: 8, w: 32, h: 32 });
});

/* ------------------------------------------------------------------ */
/* 22. Accumulation buffer                                             */
/* ------------------------------------------------------------------ */

scene("accum", {
    what: "ClearAccum, Accum LOAD/ACCUM/MULT/ADD/RETURN",
    spec: "GL 2.1 §4.2.4",
}, s => {
    s.ortho2d().op("ClearAccum", 0.1, 0.2, 0.3, 0.4).op("Clear", ["ACCUM_BUFFER_BIT"]);
    s.op("Accum", "RETURN", 1);
    s.tiles.push({ label: "RETURN of cleared accum (0.1,0.2,0.3,0.4)", x: 0, y: 48, w: 64, h: 16 });
    s.op("Color4f", 0.8, 0.4, 0.2, 1).rect(0, 0, 64, 48);
    s.op("Accum", "LOAD", 0.5);
    s.op("Color4f", 0.2, 0.6, 1.0, 0.5).rect(0, 0, 64, 48);
    s.op("Accum", "ACCUM", 0.25).op("Accum", "MULT", 0.8).op("Accum", "ADD", 0.1);
    s.op("Enable", "SCISSOR_TEST").op("Scissor", 0, 0, 64, 24).op("Accum", "RETURN", 1.5).op("Disable", "SCISSOR_TEST");
    s.tiles.push({ label: "LOAD .5, ACCUM .25, MULT .8, ADD .1, RETURN 1.5 (scissored)", x: 0, y: 0, w: 64, h: 24 });
    s.tiles.push({ label: "outside scissor: second quad", x: 0, y: 24, w: 64, h: 24 });
});

/* ------------------------------------------------------------------ */
/* 23. Primitive types + indexed draws                                 */
/* ------------------------------------------------------------------ */

scene("primitives", {
    what: "QUADS, QUAD_STRIP, POLYGON, TRIANGLE_FAN, TRIANGLE_STRIP (smooth colours)",
    spec: "GL 2.1 §2.6.1",
}, s => {
    s.ortho2d();
    const draw = (mode, verts, tile, text) => {
        s.label(tile, text);
        s.op("Begin", mode);
        verts.forEach((v, i) => s.op("Color3f", ...PCOL[i % 6]).op("Vertex2f", v[0], v[1]));
        s.op("End");
    };
    draw("QUADS", [[2, 2], [14, 2], [14, 14], [2, 14], [18, 2], [30, 2], [30, 14], [18, 14]], 0, "QUADS x2");
    s.label(1, "QUADS x2 (2nd)");
    draw("QUAD_STRIP", [[34, 2], [34, 14], [46, 2], [46, 14], [62, 2], [62, 14]], 2, "QUAD_STRIP 2 quads");
    s.label(3, "QUAD_STRIP (2nd)");
    draw("POLYGON", [[2, 18], [14, 18], [16, 24], [14, 30], [2, 30]], 4, "POLYGON pentagon");
    draw("TRIANGLE_FAN", [[24, 24], [18, 18], [30, 18], [30, 30], [18, 30], [18, 18]], 5, "TRIANGLE_FAN");
    draw("TRIANGLE_STRIP", [[34, 18], [46, 18], [34, 30], [46, 30], [34, 34], [46, 34]], 6, "TRIANGLE_STRIP");
    // non-convex POLYGON is undefined; concave QUAD also undefined. Skip.
    // GL_POLYGON with 3 vertices (degenerate case = triangle)
    draw("POLYGON", [[50, 18], [62, 18], [56, 30]], 7, "POLYGON triangle");
    // QUADS with an incomplete trailing quad (ignored)
    draw("QUADS", [[2, 34], [14, 34], [14, 46], [2, 46], [18, 34], [30, 34], [30, 46]], 8, "QUADS + 3 leftover vertices");
    s.label(9, "leftover vertices drawn nothing");
    // TRIANGLES with incomplete trailing triangle
    draw("TRIANGLES", [[34, 34], [46, 34], [34, 46], [50, 34], [62, 34]], 10, "TRIANGLES + 2 leftover");
    s.label(11, "leftover: nothing");
});

const f32 = (a) => ({ f32: a });
scene("draw_elements", {
    what: "glDrawElements with UNSIGNED_BYTE/SHORT/INT indices over client arrays; QUADS and TRIANGLE_FAN indexed; ubyte colour arrays",
    spec: "GL 2.1 §2.8",
}, s => {
    s.ortho2d();
    const verts = f32([2, 2, 14, 2, 14, 14, 2, 14,  18, 2, 30, 2, 30, 14, 18, 14,  34, 2, 46, 2, 46, 14, 34, 14]);
    const cols = { u8: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
        255, 0, 255, 255, 0, 255, 255, 255, 128, 128, 128, 255, 255, 255, 255, 255,
        10, 20, 30, 255, 200, 100, 50, 255, 50, 100, 200, 255, 90, 180, 40, 255] };
    const arrays = { vertex: { size: 2, type: "FLOAT", data: verts }, color: { size: 4, type: "UNSIGNED_BYTE", data: cols } };
    s.op("DrawElements", "TRIANGLES", "UNSIGNED_BYTE", [0, 1, 2, 0, 2, 3], arrays);
    s.label(0, "TRIANGLES ubyte");
    s.op("DrawElements", "QUADS", "UNSIGNED_SHORT", [4, 5, 6, 7], arrays);
    s.label(1, "QUADS ushort");
    s.op("DrawElements", "TRIANGLE_FAN", "UNSIGNED_INT", [8, 9, 10, 11], arrays);
    s.label(2, "TRIANGLE_FAN uint");
    s.op("ShadeModel", "FLAT");
    const v2 = f32([2, 18, 14, 18, 14, 30, 2, 30, 18, 18, 30, 18, 30, 30, 18, 30]);
    const c2 = { u8: [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 255, 0, 255, 0, 255, 255, 128, 128, 128, 255, 255, 255] };
    const arr2 = { vertex: { size: 2, type: "FLOAT", data: v2 }, color: { size: 3, type: "UNSIGNED_BYTE", data: c2 } };
    s.op("DrawElements", "TRIANGLES", "UNSIGNED_BYTE", [0, 1, 2, 2, 3, 0], arr2);
    s.label(4, "FLAT indexed TRIANGLES: last index of each tri (v2 blue, v0 red)");
    s.op("DrawElements", "QUADS", "UNSIGNED_BYTE", [5, 6, 7, 4], arr2);
    s.label(5, "FLAT indexed QUADS 5,6,7,4: provoking = 4th index (4, magenta)");
    s.op("ShadeModel", "SMOOTH");
    s.op("DrawArrays", "TRIANGLE_FAN", 4, { vertex: { size: 2, type: "FLOAT", data: f32([34, 18, 46, 18, 46, 30, 34, 30]) },
        color: { size: 4, type: "FLOAT", data: f32([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1]) } });
    s.label(6, "DrawArrays TRIANGLE_FAN float colours");
    s.op("DrawArrays", "QUADS", 4, { vertex: { size: 2, type: "SHORT", data: { i16: [50, 18, 62, 18, 62, 30, 50, 30] } },
        color: { size: 4, type: "UNSIGNED_BYTE", data: { u8: [255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255] } } });
    s.label(7, "DrawArrays QUADS short positions");
});

/* ------------------------------------------------------------------ */
/* 24. Texture wrap/filter                                             */
/* ------------------------------------------------------------------ */

scene("tex_wrap_border", {
    what: "2x2 texture, LINEAR, texcoords -0.5..1.5: CLAMP (blends border), CLAMP_TO_EDGE, CLAMP_TO_BORDER (magenta), REPEAT, MIRRORED_REPEAT",
    spec: "GL 2.1 §3.8.7-3.8.8 (CLAMP clamps to [0,1] then filters with border texels)",
}, s => {
    s.ortho2d().op("Enable", "TEXTURE_2D").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "REPLACE");
    s.op("GenTextures", [1]).op("BindTexture", "TEXTURE_2D", 1)
        .op("TexImage2D", "TEXTURE_2D", 0, "RGBA", 2, 2, 0, "RGBA", "UNSIGNED_BYTE", { u8: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255] })
        .op("TexParameteri", "TEXTURE_2D", "TEXTURE_MIN_FILTER", "LINEAR").op("TexParameteri", "TEXTURE_2D", "TEXTURE_MAG_FILTER", "LINEAR")
        .op("TexParameterfv", "TEXTURE_2D", "TEXTURE_BORDER_COLOR", [1, 0, 1, 1]);
    const wraps = ["CLAMP", "CLAMP_TO_EDGE", "CLAMP_TO_BORDER", "REPEAT", "MIRRORED_REPEAT"];
    wraps.forEach((w, k) => {
        s.op("TexParameteri", "TEXTURE_2D", "TEXTURE_WRAP_S", w).op("TexParameteri", "TEXTURE_2D", "TEXTURE_WRAP_T", w);
        const x = (k % 2) * 32, y = Math.floor(k / 2) * 21;
        s.rect(x, y, x + 32, y + 21, i => [["TexCoord2f", [-0.5, 1.5, 1.5, -0.5][i], [-0.5, -0.5, 1.5, 1.5][i]]]);
        s.tiles.push({ label: w, x: x + 1, y: y + 1, w: 30, h: 19 });
    });
    // NEAREST magnification of a 2x2 at exact texel boundary is ambiguous; skip
});

scene("tex_wrap_nearest", {
    what: "4x1 texture of four colours, NEAREST, s from -1 to 2 in quarter steps: REPEAT tiles, MIRRORED_REPEAT reflects, CLAMP_TO_EDGE holds the edges",
    spec: "GL 2.1 §3.8.7 (Table 3.19, REPEAT and MIRRORED_REPEAT)",
}, s => {
    s.ortho2d().op("Enable", "TEXTURE_2D").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "REPLACE");
    s.op("GenTextures", [1]).op("BindTexture", "TEXTURE_2D", 1)
        .op("TexImage2D", "TEXTURE_2D", 0, "RGBA", 4, 1, 0, "RGBA", "UNSIGNED_BYTE",
            { u8: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255] })
        .op("TexParameteri", "TEXTURE_2D", "TEXTURE_MIN_FILTER", "NEAREST")
        .op("TexParameteri", "TEXTURE_2D", "TEXTURE_MAG_FILTER", "NEAREST");
    // each tile is one texel of s: the quarter centred at s = (k + 0.5) / 4
    const wraps = ["REPEAT", "MIRRORED_REPEAT", "CLAMP_TO_EDGE"];
    wraps.forEach((w, row) => {
        s.op("TexParameteri", "TEXTURE_2D", "TEXTURE_WRAP_S", w);
        [-0.875, -0.375, 1.125, 1.625].forEach((st, k) => s.tileQuad(row * 4 + k, w + " s=" + st, tc(st, 0.5)));
    });
});

scene("mipmap", {
    what: "mip level selection NEAREST_MIPMAP_NEAREST at scale 1/2/4/8; BASE_LEVEL/MAX_LEVEL/LOD_BIAS/MIN_LOD; incomplete texture",
    spec: "GL 2.1 §3.8.8-3.8.10 (incomplete texture => unit disabled)",
}, s => {
    s.ortho2d().op("Enable", "TEXTURE_2D").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "REPLACE");
    const lvl = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255]];
    const mk = (name) => {
        s.op("GenTextures", [name]).op("BindTexture", "TEXTURE_2D", name);
        for (let l = 0; l < 5; ++l) {
            const n = 16 >> l, data = [];
            for (let i = 0; i < n * n; ++i) data.push(...lvl[l], 255);
            s.op("TexImage2D", "TEXTURE_2D", l, "RGBA", n, n, 0, "RGBA", "UNSIGNED_BYTE", { u8: data });
        }
        s.op("TexParameteri", "TEXTURE_2D", "TEXTURE_MIN_FILTER", "NEAREST_MIPMAP_NEAREST")
            .op("TexParameteri", "TEXTURE_2D", "TEXTURE_MAG_FILTER", "NEAREST");
    };
    mk(1);
    const quad = (x, y, size, text) => {
        s.rect(x, y, x + size, y + size, i => [["TexCoord2f", [0, 1, 1, 0][i], [0, 0, 1, 1][i]]]);
        s.tiles.push({ label: text, x, y, w: size, h: size });
    };
    quad(0, 0, 16, "16px: level 0 red"); quad(20, 0, 8, "8px: level 1 green"); quad(32, 0, 4, "4px: level 2 blue"); quad(40, 0, 2, "2px: level 3 yellow");
    s.op("TexParameteri", "TEXTURE_2D", "TEXTURE_BASE_LEVEL", 1);
    quad(0, 20, 16, "BASE_LEVEL 1 at 16px: green");
    s.op("TexParameteri", "TEXTURE_2D", "TEXTURE_BASE_LEVEL", 0).op("TexParameteri", "TEXTURE_2D", "TEXTURE_MAX_LEVEL", 1);
    quad(20, 20, 4, "MAX_LEVEL 1 at 4px: green");
    s.op("TexParameteri", "TEXTURE_2D", "TEXTURE_MAX_LEVEL", 1000).op("TexParameterf", "TEXTURE_2D", "TEXTURE_LOD_BIAS", 1);
    quad(28, 20, 16, "TEXTURE_LOD_BIAS 1 at 16px: green");
    s.op("TexParameterf", "TEXTURE_2D", "TEXTURE_LOD_BIAS", 0).op("TexEnvf", "TEXTURE_FILTER_CONTROL", "TEXTURE_LOD_BIAS", 2);
    quad(48, 20, 16, "TexEnv FILTER_CONTROL LOD_BIAS 2 at 16px: blue");
    s.op("TexEnvf", "TEXTURE_FILTER_CONTROL", "TEXTURE_LOD_BIAS", 0).op("TexParameterf", "TEXTURE_2D", "TEXTURE_MIN_LOD", 2);
    quad(0, 40, 16, "MIN_LOD 2 at 16px: blue");
    s.op("TexParameterf", "TEXTURE_2D", "TEXTURE_MIN_LOD", -1000);
    // incomplete: only level 0, default min filter NEAREST_MIPMAP_LINEAR
    s.op("GenTextures", [2]).op("BindTexture", "TEXTURE_2D", 2)
        .op("TexImage2D", "TEXTURE_2D", 0, "RGBA", 2, 2, 0, "RGBA", "UNSIGNED_BYTE", { u8: [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255] });
    s.op("Color3f", 0.2, 0.8, 0.4);
    s.rect(20, 40, 36, 56, i => [["TexCoord2f", [0, 1, 1, 0][i], [0, 0, 1, 1][i]]]);
    s.tiles.push({ label: "incomplete (mip filter, 1 level): untextured (0.2,0.8,0.4)", x: 20, y: 40, w: 16, h: 16 });
});

scene("tex_formats_unpack", {
    what: "packed pixel types and unpack state on TexImage2D (4 texels each, NEAREST, REPLACE)",
    spec: "GL 2.1 §3.6.4 Tables 3.5-3.11, §3.6.1 pixel store",
}, s => {
    s.ortho2d().op("Enable", "TEXTURE_2D").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "REPLACE");
    const u16 = (a) => ({ u16: a });
    const cases = [
        ["RGB", "RGB", "UNSIGNED_SHORT_5_6_5", u16([0xF800, 0x07E0, 0x001F, 0x8410]), "RGB 5_6_5"],
        ["RGBA", "RGBA", "UNSIGNED_SHORT_4_4_4_4", u16([0xF00F, 0x0F0F, 0x00FF, 0x8888]), "RGBA 4_4_4_4"],
        ["RGBA", "RGBA", "UNSIGNED_SHORT_5_5_5_1", u16([0xF801, 0x07C1, 0x003F, 0x8420]), "RGBA 5_5_5_1"],
        ["RGBA", "BGRA", "UNSIGNED_INT_8_8_8_8_REV", { u32: [0xFF0000FF >>> 0, 0x8000FF00, 0x40FF0000, 0xFF808080 >>> 0] }, "BGRA 8_8_8_8_REV"],
        ["RGBA", "BGRA", "UNSIGNED_BYTE", { u8: [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 10, 20, 30, 255] }, "BGRA ubyte"],
        // (rows padded to UNPACK_ALIGNMENT 4: unpadded, row 1 was read from past the data)
        ["RGB", "RGB", "UNSIGNED_BYTE_3_3_2", { u8: [0xE0, 0x1C, 0, 0, 0x03, 0x92] }, "RGB 3_3_2"],
        ["RGBA", "RGBA", "UNSIGNED_INT_8_8_8_8", { u32: [0xFF0000FF >>> 0, 0x00FF0080, 0x0000FF40, 0x808080FF >>> 0] }, "RGBA 8_8_8_8"],
        ["RGBA", "RGBA", "UNSIGNED_SHORT_4_4_4_4_REV", u16([0xF00F, 0x0F0F, 0x00FF, 0x8888]), "RGBA 4_4_4_4_REV"],
        ["LUMINANCE_ALPHA", "LUMINANCE_ALPHA", "FLOAT", { f32: [1, 0.5, 0.25, 1, 0.75, 0, 0, 1] }, "LA float"],
        ["RGB", "RGB", "UNSIGNED_BYTE", { u8: [255, 0, 0, 0, 255, 0, 7, 7, 0, 0, 255, 255, 255, 255] }, "RGB 2x2 align 4 (pad 2)"],
        ["RGB5_A1", "RGBA", "UNSIGNED_BYTE", { u8: [255, 0, 0, 255, 0, 255, 0, 100, 0, 0, 255, 200, 99, 99, 99, 255] }, "internal RGB5_A1"],
        ["RGBA", "RGBA", "BYTE", { i8: [127, 0, -1, 127, 0, 64, 0, 127, 0, 0, 127, 32, 100, 100, 100, 127] }, "RGBA signed BYTE (neg->0)"],
    ];
    cases.forEach(([ifmt, fmt, type, data, text], i) => {
        s.op("GenTextures", [i + 1]).op("BindTexture", "TEXTURE_2D", i + 1).ops_(nearest())
            .op("TexImage2D", "TEXTURE_2D", 0, ifmt, 2, 2, 0, fmt, type, data);
        s.tileQuad(i, text, i2 => [["TexCoord2f", [0, 1, 1, 0][i2], [0, 0, 1, 1][i2]]]);
    });
    // row length + skips: 4x3 source, take 2x2 at (1,1)
    const src = [];
    for (let y = 0; y < 3; ++y) for (let x = 0; x < 4; ++x) src.push(x * 80, y * 120, 50, 255);
    s.op("PixelStorei", "UNPACK_ROW_LENGTH", 4).op("PixelStorei", "UNPACK_SKIP_PIXELS", 1).op("PixelStorei", "UNPACK_SKIP_ROWS", 1);
    s.op("GenTextures", [20]).op("BindTexture", "TEXTURE_2D", 20).ops_(nearest())
        .op("TexImage2D", "TEXTURE_2D", 0, "RGBA", 2, 2, 0, "RGBA", "UNSIGNED_BYTE", { u8: src });
    s.op("PixelStorei", "UNPACK_ROW_LENGTH", 0).op("PixelStorei", "UNPACK_SKIP_PIXELS", 0).op("PixelStorei", "UNPACK_SKIP_ROWS", 0);
    s.tileQuad(12, "ROW_LENGTH 4 SKIP (1,1)", i2 => [["TexCoord2f", [0, 1, 1, 0][i2], [0, 0, 1, 1][i2]]]);
    // TexSubImage-free: LSB_FIRST is bitmap-only; SWAP_BYTES on 16-bit
    s.op("PixelStorei", "UNPACK_SWAP_BYTES", 1);
    s.op("GenTextures", [21]).op("BindTexture", "TEXTURE_2D", 21).ops_(nearest())
        .op("TexImage2D", "TEXTURE_2D", 0, "RGB", 2, 2, 0, "RGB", "UNSIGNED_SHORT_5_6_5", u16([0x00F8, 0xE007, 0x1F00, 0x1084]));
    s.op("PixelStorei", "UNPACK_SWAP_BYTES", 0);
    s.tileQuad(13, "UNPACK_SWAP_BYTES 5_6_5 (= tile 0)", i2 => [["TexCoord2f", [0, 1, 1, 0][i2], [0, 0, 1, 1][i2]]]);
});

/* ------------------------------------------------------------------ */
/* 25. Polygon mode, stipple, wide primitives                         */
/* ------------------------------------------------------------------ */

const loose = (name, what, spec, build) => scene(name, { what, spec, mode: "loose" }, s => { s.ortho2d(); build(s); });
loose("polymode_line", "PolygonMode(FRONT_AND_BACK, LINE) quad outline", "GL 2.1 §3.5.4", s => {
    s.op("Color3f", 1, 1, 1).op("PolygonMode", "FRONT_AND_BACK", "LINE");
    s.rect(4.5, 4.5, 27.5, 27.5);
    s.tiles.push({ label: "LINE mode outline", x: 2, y: 2, w: 28, h: 28 });
    s.op("PolygonMode", "FRONT_AND_BACK", "FILL");
});
loose("polymode_front_line_back_fill", "PolygonMode FRONT LINE, BACK FILL; a CW (back) quad is filled, a CCW one outlined", "GL 2.1 §3.5.4", s => {
    s.op("PolygonMode", "FRONT", "LINE").op("PolygonMode", "BACK", "FILL").op("Color3f", 0, 1, 0);
    s.rect(36.5, 4.5, 59.5, 27.5, null, true);
    s.tiles.push({ label: "BACK FILL (CW quad filled)", x: 38, y: 6, w: 20, h: 20 });
    s.rect(4.5, 4.5, 27.5, 27.5);
    s.tiles.push({ label: "FRONT LINE (CCW quad outlined)", x: 2, y: 2, w: 28, h: 28 });
    s.op("PolygonMode", "FRONT_AND_BACK", "FILL");
});
loose("polymode_point", "PolygonMode POINT with PointSize 3", "GL 2.1 §3.5.4, §3.3", s => {
    s.op("PolygonMode", "FRONT_AND_BACK", "POINT").op("PointSize", 3).op("Color3f", 1, 0, 0);
    s.rect(6.5, 36.5, 24.5, 54.5);
    s.tiles.push({ label: "POINT mode corners (3px)", x: 2, y: 32, w: 28, h: 28 });
    s.op("PolygonMode", "FRONT_AND_BACK", "FILL");
});
loose("points_size4", "GL_POINTS with PointSize 4", "GL 2.1 §3.3", s => {
    s.op("PointSize", 4).op("Color3f", 0, 0, 1);
    s.op("Begin", "POINTS").op("Vertex2f", 40, 40).op("Vertex2f", 52.5, 40.5).op("End");
    s.tiles.push({ label: "PointSize 4 points", x: 36, y: 36, w: 20, h: 8 });
});
loose("lines_width3", "GL_LINES with LineWidth 3", "GL 2.1 §3.4.2", s => {
    s.op("LineWidth", 3).op("Color3f", 1, 1, 0);
    s.op("Begin", "LINES").op("Vertex2f", 36, 54.5).op("Vertex2f", 62, 54.5).op("End");
    s.tiles.push({ label: "LineWidth 3 horizontal", x: 36, y: 50, w: 26, h: 10 });
});
scene("lines_wide_stipple", {
    what: "wide lines widen along the minor axis; LineStipple restarts per GL_LINES segment and runs on through a strip",
    spec: "GL 2.1 §3.4.2 (wide lines), §3.4.3 (stipple)",
}, s => {
    s.ortho2d().op("Color3f", 1, 1, 0).op("LineWidth", 3);
    s.op("Begin", "LINES").op("Vertex2f", 2, 6.5).op("Vertex2f", 62, 6.5).op("End");
    s.tiles.push({ label: "x-major width 3: rows 5-7", x: 8, y: 3, w: 48, h: 7 });
    s.op("LineWidth", 4).op("Color3f", 0, 1, 1);
    s.op("Begin", "LINES").op("Vertex2f", 8, 12).op("Vertex2f", 8, 62).op("End");
    s.tiles.push({ label: "y-major width 4: columns 6-9", x: 4, y: 16, w: 8, h: 42 });
    s.op("LineWidth", 1).op("Enable", "LINE_STIPPLE").op("LineStipple", 2, 0x0F0F).op("Color3f", 1, 0, 1);
    s.op("Begin", "LINE_STRIP").op("Vertex2f", 16, 20.5).op("Vertex2f", 37, 20.5).op("Vertex2f", 62, 20.5).op("End");
    s.tiles.push({ label: "stippled strip runs on", x: 18, y: 19, w: 42, h: 3 });
    s.op("Begin", "LINES").op("Vertex2f", 16, 30.5).op("Vertex2f", 37, 30.5).op("Vertex2f", 37, 30.5)
        .op("Vertex2f", 62, 30.5).op("End");
    s.tiles.push({ label: "stippled segments restart", x: 18, y: 29, w: 42, h: 3 });
    s.op("LineWidth", 3).op("LineStipple", 1, 0x00FF).op("Color3f", 0, 1, 0);
    s.op("Begin", "LINES").op("Vertex2f", 16, 44.5).op("Vertex2f", 62, 44.5).op("End");
    s.tiles.push({ label: "wide and stippled", x: 18, y: 41, w: 42, h: 7 });
    s.op("Disable", "LINE_STIPPLE").op("LineWidth", 1);
});
loose("lines_width1", "GL_LINES width 1 (baseline)", "GL 2.1 §3.4.1", s => {
    s.op("Color3f", 1, 1, 0);
    s.op("Begin", "LINES").op("Vertex2f", 4, 20.5).op("Vertex2f", 60, 20.5).op("Vertex2f", 10.5, 30).op("Vertex2f", 10.5, 60).op("End");
    s.tiles.push({ label: "horizontal + vertical 1px lines", x: 2, y: 18, w: 60, h: 44 });
});

scene("tex_depth_as_colour", {
    what: "a depth texture with TEXTURE_COMPARE_MODE NONE sampled as DEPTH_TEXTURE_MODE says: LUMINANCE, INTENSITY, ALPHA",
    spec: "GL 2.1 §3.8.14 (texture comparison), table 3.15",
}, s => {
    s.ortho2d().op("Enable", "TEXTURE_2D").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "REPLACE");
    s.op("GenTextures", [1]).op("BindTexture", "TEXTURE_2D", 1)
        .op("TexImage2D", "TEXTURE_2D", 0, "DEPTH_COMPONENT", 2, 2, 0, "DEPTH_COMPONENT", "FLOAT",
            { f32: [0.25, 0.5, 0.75, 1.0] })
        .op("TexParameteri", "TEXTURE_2D", "TEXTURE_MIN_FILTER", "NEAREST")
        .op("TexParameteri", "TEXTURE_2D", "TEXTURE_MAG_FILTER", "NEAREST");
    s.op("Color4f", 1, 0, 1, 0.5);
    ["LUMINANCE", "INTENSITY", "ALPHA"].forEach((mode, k) => {
        s.op("TexParameteri", "TEXTURE_2D", "DEPTH_TEXTURE_MODE", mode);
        const x = k * 21;
        s.rect(x + 1, 2, x + 20, 62, i => [["TexCoord2f", [0, 1, 1, 0][i], [0, 0, 1, 1][i]]]);
        s.tiles.push({ label: mode, x: x + 1, y: 2, w: 19, h: 60 });
    });
});

scene("drawpixels_depth_stencil", {
    what: "DrawPixels and CopyPixels of DEPTH_COMPONENT (the raster colour, depth tested) and of STENCIL_INDEX",
    spec: "GL 2.1 §4.3.1 (DrawPixels), §4.3.3 (CopyPixels)",
}, s => {
    s.ortho2d().op("Enable", "DEPTH_TEST").op("DepthFunc", "LESS");
    s.op("Color3f", 0, 0, 1).op("WindowPos2f", 4, 4)
        .op("DrawPixels", 16, 16, "DEPTH_COMPONENT", "FLOAT", { f32: new Array(256).fill(0.25) });
    s.op("Color3f", 1, 1, 0).op("WindowPos2f", 4, 40).op("CopyPixels", 4, 4, 16, 16, "DEPTH");
    s.op("Color3f", 1, 0, 0);
    s.rect(0, 0, 28, 28);   // depth 0.5: behind what the pixels wrote
    s.rect(0, 36, 28, 64);
    s.tiles.push({ label: "drawn depth 0.25 in the raster colour, in front", x: 0, y: 0, w: 28, h: 28 });
    s.tiles.push({ label: "copied depth, in front", x: 0, y: 36, w: 28, h: 28 });
    s.op("Disable", "DEPTH_TEST");
    s.op("WindowPos2f", 36, 4).op("DrawPixels", 16, 16, "STENCIL_INDEX", "UNSIGNED_BYTE", { u8: new Array(256).fill(5) });
    s.op("WindowPos2f", 40, 40).op("CopyPixels", 36, 4, 16, 16, "STENCIL");
    s.op("Enable", "STENCIL_TEST").op("StencilFunc", "EQUAL", 5, 0xFF).op("Color3f", 0, 1, 0);
    s.rect(32, 0, 64, 28);
    s.rect(32, 36, 64, 64);
    s.op("Disable", "STENCIL_TEST");
    s.tiles.push({ label: "drawn stencil 5", x: 32, y: 0, w: 32, h: 28 });
    s.tiles.push({ label: "copied stencil", x: 32, y: 36, w: 32, h: 28 });
});

scene("polygon_stipple", {
    what: "POLYGON_STIPPLE window-aligned pattern: first byte = bottom row, MSB = leftmost",
    spec: "GL 2.1 §3.5.6 (pattern origin at window (0,0))",
}, s => {
    const pat = [];
    for (let row = 0; row < 32; ++row) {
        if (row === 0) pat.push(0xF0, 0x00, 0x00, 0x01);
        else if (row < 8) pat.push(0x80, 0, 0, 0);
        else pat.push(row & 1 ? 0xAA : 0x55, 0xFF, 0x00, 0x0F);
    }
    s.ortho2d().op("PolygonStipple", { u8: pat }).op("Enable", "POLYGON_STIPPLE").op("Color3f", 1, 1, 1);
    s.rect(0, 0, 64, 64);
    s.tiles.push({ label: "stipple 64x64", x: 0, y: 0, w: 64, h: 64 });
    s.op("Disable", "POLYGON_STIPPLE");
});

/* ------------------------------------------------------------------ */
/* 26. Colour clamping / colour sum                                    */
/* ------------------------------------------------------------------ */

scene("color_clamp_sum", {
    what: "vertex colours outside [0,1] clamped before interpolation; COLOR_SUM with SecondaryColor; fog after colour sum",
    spec: "GL 2.1 §2.14.6 (colour clamping), §3.9 colour sum, §3.10",
}, s => {
    s.ortho2d();
    s.op("ShadeModel", "SMOOTH");
    s.rect(2, 2, 62, 14, i => [["Color4f", ...(i === 0 || i === 3 ? [2, -1, 0.5, 1] : [0, 1, 0.5, 1])]]);
    s.tiles.push({ label: "R: 2->0 clamped first => mid 0.5; G: -1->1 => mid 0.5", x: 2, y: 2, w: 60, h: 12 });
    s.op("Enable", "COLOR_SUM").op("Color3f", 0.25, 0.5, 0.125).op("SecondaryColor3f", 0.5, 0.25, 0.75);
    s.tileQuad(4, "COLOR_SUM primary+secondary");
    s.ops_(tex1x1(1, "RGB", "RGB", [128, 128, 128])).op("Enable", "TEXTURE_2D").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "MODULATE");
    s.tileQuad(5, "COLOR_SUM after texturing (prim*0.5+sec)", tc(0.5, 0.5));
    s.op("Disable", "COLOR_SUM");
    s.tileQuad(6, "COLOR_SUM off: secondary ignored", tc(0.5, 0.5));
    s.op("Disable", "TEXTURE_2D");
    s.op("Enable", "COLOR_SUM").op("SecondaryColor3f", 0.75, 0.75, 0.75).op("Color3f", 0.5, 0.5, 0.5);
    s.tileQuad(7, "COLOR_SUM saturates at 1");
    s.op("Disable", "COLOR_SUM");
    s.op("Color4f", 1.5, 0.5, -0.5, 2);
    s.tileQuad(8, "Color4f(1.5,.5,-.5,2) clamped");
});

/* ------------------------------------------------------------------ */
/* 27. GLSL semantics                                                  */
/* ------------------------------------------------------------------ */

const VS_PASS = "void main(){ gl_FrontColor = gl_Color; gl_BackColor = vec4(1.0,0.0,1.0,1.0); gl_TexCoord[0] = gl_MultiTexCoord0; gl_Position = ftransform(); }";
const FS_CASES = `#version 120
uniform float u_case;
uniform sampler2D u_tex;
void main() {
    vec4 c = vec4(0.0, 0.0, 0.0, 1.0);
    if (u_case < 0.5) c = vec4(mod(-1.5, 1.0), fract(-0.25), sign(-2.0) * -0.5, 1.0);
    else if (u_case < 1.5) c = vec4(gl_FragCoord.x / 64.0, gl_FragCoord.y / 64.0, gl_FragCoord.z, 1.0);
    else if (u_case < 2.5) c = gl_FrontFacing ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0);
    else if (u_case < 3.5) { mat2 m = mat2(0.1, 0.2, 0.3, 0.4); vec2 a = m * vec2(1.0, 0.0); vec2 b = vec2(1.0, 0.0) * m; c = vec4(a, b); }
    else if (u_case < 4.5) c = vec4(step(0.5, 0.5), smoothstep(0.0, 1.0, 0.25), pow(0.25, 0.5), clamp(1.7, 0.0, 0.5));
    else if (u_case < 5.5) c = gl_Color;
    else if (u_case < 6.5) c = texture2DProj(u_tex, vec3(0.625, 0.375, 1.0) * 2.0);
    else if (u_case < 7.5) { if (gl_FragCoord.x < 120.0) discard; }
    else if (u_case < 8.5) { mat3 m = mat3(mat4(0.1,0.2,0.3,0.4, 0.5,0.6,0.7,0.8, 0.9,0.15,0.25,0.35, 0.45,0.55,0.65,0.75)); c = vec4(m[1], m[2][0]); }
    else if (u_case < 9.5) c = vec4(atan(1.0, -1.0) / 4.0, atan(-1.0, 1.0) / -1.0, abs(-0.3), mix(0.2, 0.6, 0.25));
    else if (u_case < 10.5) { int i = 7; int j = i / 2; c = vec4(float(j) / 4.0, float(-i / 2) / -4.0, float(ivec2(5,3).y) / 4.0, 1.0); }
    gl_FragColor = c;
}`;
const FS_STATE = "void main(){ gl_FragColor = vec4(gl_FrontLightModelProduct.sceneColor.rgb, 1.0) * 0.5 + gl_LightSource[0].diffuse * 0.5 + vec4(gl_Fog.color.rgb, 0.0) * 0.25; }";
const VS_CLAMP = "varying vec4 v; void main(){ gl_FrontColor = vec4(gl_Vertex.x < 40.0 ? 2.0 : 0.0, 0.0, 0.0, 1.0); v = vec4(gl_Vertex.x < 40.0 ? 2.0 : 0.0); gl_Position = ftransform(); }";
const FS_CLAMP = "uniform float u_which; varying vec4 v; void main(){ gl_FragColor = u_which < 0.5 ? gl_Color : vec4(clamp(v.x, 0.0, 1.0), 0.0, 0.0, 1.0); }";

scene("glsl_texture2dproj_vec4", {
    what: "texture2DProj with a vec4 coordinate divides by w, not z; with a vec3 by z",
    spec: "GLSL 1.20 §8.7",
}, s => {
    s.ortho2d();
    s.ops_(gridTex(1));
    s.op("Program", 9, VS_PASS, "uniform sampler2D u_tex; uniform float u_case; void main(){ gl_FragColor = u_case < 0.5 ? " +
        "texture2DProj(u_tex, vec4(1.25, 0.75, 0.3, 2.0)) : texture2DProj(u_tex, vec3(0.375, 0.875, 0.5)); }")
        .op("UseProgram", 9).op("Uniform1i", "u_tex", 0);
    s.op("Uniform1f", "u_case", 0).tileQuad(0, "vec4 (1.25,.75,.3,2) / w -> texel(2,1)");
    s.op("Uniform1f", "u_case", 1).tileQuad(1, "vec3 (.375,.875,.5) / z -> texel(3,3)");
    s.op("UseProgram", 0);
});

// (after glsl_texture2dproj_vec4, in another context, with the same name)
scene("glsl_program_name_reuse", {
    what: "a program named like one of an earlier context's draws with its own shaders",
    spec: "GL 2.1 §2.15 (program objects belong to their share group)",
}, s => {
    s.ortho2d();
    s.op("Program", 9, VS_PASS, "void main(){ gl_FragColor = vec4(0.0, 0.5, 1.0, 1.0); }").op("UseProgram", 9);
    s.tileQuad(0, "program 9 of this context: (0, .5, 1)");
    s.op("UseProgram", 0);
});

scene("glsl_semantics", {
    what: "GLSL 1.10/1.20: mod/fract/sign of negatives, gl_FragCoord origin, gl_FrontFacing, matrix*vector order, builtins, texture2DProj, discard, mat3(mat4), atan(y,x), int division, built-in state uniforms",
    spec: "GLSL 1.20 §8, §7.2, §5.4.2; GL 2.1 §2.15.4",
}, s => {
    s.ortho2d().op("Lightfv", "LIGHT0", "DIFFUSE", [0.4, 0.2, 0.6, 1]).op("LightModelfv", "LIGHT_MODEL_AMBIENT", [0.2, 0.2, 0.2, 1])
        .op("Materialfv", "FRONT", "AMBIENT", [1, 0.5, 0.25, 1]).op("Materialfv", "FRONT", "EMISSION", [0.1, 0.1, 0.1, 0]);
    s.ops_(gridTex(1));
    s.op("Program", 1, VS_PASS, FS_CASES).op("UseProgram", 1).op("Uniform1i", "u_tex", 0);
    const labels = ["mod(-1.5,1)=.5 fract(-.25)=.75 sign", "gl_FragCoord/64 (origin bottom-left)", "gl_FrontFacing front=green",
        "mat2*vec2 (col0) and vec2*mat2 (row0)", "step/smoothstep/pow/clamp", "gl_Color interpolation", "texture2DProj -> texel(2,1)",
        "discard -> clear colour", "mat3(mat4) columns", "atan(y,x) / abs / mix", "int division 7/2, -7/2", "built-in state uniforms"];
    for (let i = 0; i < 11; ++i) {
        s.op("Uniform1f", "u_case", i);
        if (i === 5) s.tileQuad(i, labels[i], k => [["Color4f", ...PCOL[k], 1]]);
        else s.tileQuad(i, labels[i], i === 6 ? tc(0.5, 0.5) : null);
    }
    s.op("Uniform1f", "u_case", 2);
    s.tileQuad(12, "gl_FrontFacing back (CW)=red", null, true);
    s.op("Fogfv", "FOG_COLOR", [0.4, 0.8, 0.0, 1]).op("Program", 3, VS_PASS, FS_STATE).op("UseProgram", 3);
    s.tileQuad(11, labels[11]);
    s.op("Program", 2, VS_CLAMP, FS_CLAMP).op("UseProgram", 2).op("Uniform1f", "u_which", 0);
    s.rect(18, 50, 62, 54);
    s.tiles.push({ label: "VS writes gl_FrontColor 2.0/0.0: clamped before interpolation", x: 18, y: 50, w: 44, h: 4 });
    s.op("Uniform1f", "u_which", 1);
    s.rect(18, 56, 62, 62);
    s.tiles.push({ label: "user varying 2.0/0.0: not clamped", x: 18, y: 56, w: 44, h: 6 });
    s.op("UseProgram", 0);
});

/* ------------------------------------------------------------------ */
/* 28. ARB programs                                                    */
/* ------------------------------------------------------------------ */

const FP = (body) => "!!ARBfp1.0\n" + body + "\nEND\n";
scene("arb_fragment_program", {
    what: "ARB_fragment_program LIT, TXP, RSQ(abs), fragment.position, CMP/KIL, FLR/FRC negatives, POW/EX2/LG2, SCS, XPD, DPH, state bindings",
    spec: "ARB_fragment_program §3.11.5",
}, s => {
    s.ortho2d().ops_(gridTex(1));
    s.op("Fogfv", "FOG_COLOR", [0.3, 0.6, 0.9, 1]);
    const progs = [
        ["LIT x>0: (1,.5,.0625,1)*.5", "PARAM p = program.local[0];\nTEMP t;\nLIT t, p;\nMUL result.color, t, 0.5;", [0.5, 0.25, 0, 2]],
        ["LIT x<=0: z=0", "PARAM p = program.local[0];\nTEMP t;\nLIT t, p;\nMUL result.color, t, 0.5;", [-0.5, 0.25, 0, 2]],
        ["TXP (1.25,.75,0,2)->texel(2,1)", "TXP result.color, fragment.texcoord[0], texture[0], 2D;", null],
        ["RSQ(-4)=0.5 (abs)", "PARAM p = program.local[0];\nTEMP t;\nRSQ t.x, p.x;\nMOV result.color, {0,0,0,1};\nMOV result.color.x, t.x;", [-4, 0, 0, 0]],
        ["fragment.position/64", "MUL result.color, fragment.position, {0.015625, 0.015625, 1, 0};\nMOV result.color.w, 1.0;", null],
        ["CMP (-1?a:b) + KIL on other", "PARAM p = program.local[0];\nTEMP t;\nCMP t, p, {0.25,0.25,0.25,1}, {0.75,0.75,0.75,1};\nMOV result.color, t;", [-1, 1, -1, 1]],
        ["FLR(-1.25)=-2 FRC(-1.25)=.75", "PARAM p = program.local[0];\nTEMP t, u;\nFLR t, p;\nFRC u, p;\nMUL t, t, -0.25;\nMOV result.color, {0,0,0,1};\nMOV result.color.x, t.x;\nMOV result.color.y, u.x;", [-1.25, 0, 0, 0]],
        ["POW(.25,.5) EX2(-1) LG2(4)/4", "PARAM c = {0.25, 0.5, -1, 4};\nTEMP t;\nPOW t.x, c.x, c.y;\nEX2 t.y, c.z;\nLG2 t.z, c.w;\nMUL t.z, t.z, 0.25;\nMOV t.w, 1.0;\nMOV result.color, t;", null],
        ["SCS(pi/6): cos .866 sin .5", "PARAM c = {0.5235988, 0, 0, 0};\nTEMP t;\nSCS t.xy, c.x;\nMOV t.zw, {0,0,0,1};\nMOV result.color, t;", null],
        ["XPD x*y=z, DPH", "TEMP t;\nXPD t.xyz, {1,0,0,0}, {0,1,0,0};\nDPH t.w, {0.1,0.1,0.1,0}, {1,1,1,0.2};\nMOV result.color, t;", null],
        ["state.fog.color + state.light[0].diffuse*0", "PARAM f = state.fog.color;\nMOV result.color, f;", null],
        ["KIL negative -> clear colour", "KIL {-1,0,0,0};\nMOV result.color, {1,1,1,1};", null],
        ["LRP + MAD + SUB saturate", "TEMP t;\nLRP t, {0.25,0.5,0.75,1}, {1,1,1,1}, {0,0,0,0};\nMAD_SAT t, t, 4.0, -1.0;\nMOV result.color, t;", null],
        ["DST", "TEMP t;\nDST t, {0,4,16,0}, {0,0.25,0,0.125};\nMUL result.color, t, 0.5;", null],
    ];
    progs.forEach(([text, body, local], i) => {
        s.op("ProgramARB", "FRAGMENT_PROGRAM_ARB", 10 + i, FP(body)).op("Enable", "FRAGMENT_PROGRAM_ARB");
        if (local) s.op("ProgramLocalParameter4f", "FRAGMENT_PROGRAM_ARB", 0, ...local);
        s.tileQuad(i, text, i === 2 ? () => [["TexCoord4f", 1.25, 0.75, 0, 2]] : null);
    });
    s.op("Disable", "FRAGMENT_PROGRAM_ARB");
});

scene("arb_vertex_program", {
    what: "ARB_vertex_program: state.matrix.mvp, ARL relative addressing (negative offsets), EXP/LOG, LIT, result.color.secondary, program.env",
    spec: "ARB_vertex_program §2.14.5",
}, s => {
    s.ortho2d();
    const VP = (body) => "!!ARBvp1.0\nPARAM mvp[4] = { state.matrix.mvp };\nTEMP p;\nDP4 result.position.x, mvp[0], vertex.position;\nDP4 result.position.y, mvp[1], vertex.position;\nDP4 result.position.z, mvp[2], vertex.position;\nDP4 result.position.w, mvp[3], vertex.position;\n" + body + "\nEND\n";
    const progs = [
        ["ARL relative: local[a0.x+1] with a0=2.7 -> local[3]", "PARAM arr[5] = { program.local[0..4] };\nADDRESS a;\nARL a.x, program.env[0].x;\nMOV result.color, arr[a.x+1];"],
        ["ARL negative: arr[a0.x-1] a0=floor(-0.3)... use 2.7 -> arr[1]", "PARAM arr[5] = { program.local[0..4] };\nADDRESS a;\nARL a.x, program.env[0].x;\nMOV result.color, arr[a.x-1];"],
        ["EXP 1.5 -> (2, .5, 2.828, 1)/4", "PARAM c = {1.5, 0, 0, 0};\nTEMP t;\nEXP t, c.x;\nMUL result.color, t, 0.25;"],
        ["LOG 8 -> (3, 1, 3, 1)/4", "PARAM c = {8, 0, 0, 0};\nTEMP t;\nLOG t, c.x;\nMUL result.color, t, 0.25;"],
        ["LIT in VP", "TEMP t;\nLIT t, {0.5, 0.25, 0, 2};\nMUL result.color, t, 0.5;"],
        ["vertex.color passthrough", "MOV result.color, vertex.color;"],
    ];
    s.op("ProgramEnvParameter4f", "VERTEX_PROGRAM_ARB", 0, 2.7, 0, 0, 0);
    progs.forEach(([text, body], i) => {
        s.op("ProgramARB", "VERTEX_PROGRAM_ARB", 30 + i, VP(body)).op("Enable", "VERTEX_PROGRAM_ARB");
        for (let k = 0; k < 5; ++k) s.op("ProgramLocalParameter4f", "VERTEX_PROGRAM_ARB", k, 0.1 + 0.2 * k, 0.8 - 0.15 * k, 0.5, 1);
        s.tileQuad(i, text, i === 5 ? () => [["Color4f", 0.2, 0.7, 0.4, 1]] : null);
    });
    s.op("Disable", "VERTEX_PROGRAM_ARB");
});

/* ------------------------------------------------------------------ */
/* 29. glReadPixels formats                                            */
/* ------------------------------------------------------------------ */

scene("readpixels_formats", {
    what: "glReadPixels: RGB w=5 with PACK_ALIGNMENT 4, LUMINANCE (R+G+B), ALPHA, BGRA, DEPTH_COMPONENT/FLOAT, RGBA/FLOAT, 5_6_5, STENCIL_INDEX",
    spec: "GL 2.1 §4.3.2 (conversion to L = R+G+B; depth and stencil reads)",
}, s => {
    s.ortho2d().op("Enable", "DEPTH_TEST").op("Enable", "STENCIL_TEST").op("StencilFunc", "ALWAYS", 0x5A, 0xFF).op("StencilOp", "KEEP", "KEEP", "REPLACE");
    s.op("Color4f", 0.2, 0.4, 0.6, 0.8).rect(0, 0, 32, 32, null, false, 0.5);   // depth 0.25
    s.op("Color4f", 0.6, 0.3, 0.1, 0.5).rect(32, 0, 64, 32, null, false, 0);    // depth 0.5
    s.op("Disable", "DEPTH_TEST").op("Disable", "STENCIL_TEST");
    s.tiles.push({ label: "left quad", x: 2, y: 2, w: 28, h: 28 });
    s.op("ReadPixels", 28, 4, 5, 2, "RGB", "UNSIGNED_BYTE");
    s.op("ReadPixels", 30, 4, 4, 1, "LUMINANCE", "UNSIGNED_BYTE");
    s.op("ReadPixels", 30, 4, 4, 1, "ALPHA", "UNSIGNED_BYTE");
    s.op("ReadPixels", 30, 4, 2, 1, "BGRA", "UNSIGNED_BYTE");
    s.op("ReadPixels", 30, 4, 4, 1, "DEPTH_COMPONENT", "FLOAT");
    s.op("ReadPixels", 30, 4, 2, 1, "RGBA", "FLOAT");
    s.op("ReadPixels", 30, 4, 4, 1, "RGB", "UNSIGNED_SHORT_5_6_5");
    s.op("ReadPixels", 30, 4, 4, 1, "STENCIL_INDEX", "UNSIGNED_BYTE");
    s.op("PixelStorei", "PACK_ALIGNMENT", 1).op("ReadPixels", 28, 4, 5, 2, "RGB", "UNSIGNED_BYTE").op("PixelStorei", "PACK_ALIGNMENT", 4);
    s.op("ReadPixels", 30, 4, 4, 1, "DEPTH_COMPONENT", "UNSIGNED_SHORT");
});

/* ------------------------------------------------------------------ */
/* 30. Face culling / front face                                       */
/* ------------------------------------------------------------------ */

scene("cull_frontface", {
    what: "CULL_FACE with FrontFace CW/CCW, culling under a mirroring modelview, FRONT_AND_BACK",
    spec: "GL 2.1 §3.5.1 (facing from window-space signed area)",
}, s => {
    s.ortho2d().op("Enable", "CULL_FACE").op("Color3f", 1, 1, 1);
    s.tileQuad(0, "CCW, cull BACK: drawn");
    s.tileQuad(1, "CW, cull BACK: culled", null, true);
    s.op("FrontFace", "CW");
    s.tileQuad(2, "CCW, FrontFace CW: culled");
    s.tileQuad(3, "CW, FrontFace CW: drawn", null, true);
    s.op("FrontFace", "CCW").op("CullFace", "FRONT");
    s.tileQuad(4, "CCW, cull FRONT: culled");
    s.tileQuad(5, "CW, cull FRONT: drawn", null, true);
    s.op("CullFace", "BACK");
    // mirror: Scale(-1,1,1) about tile 6 centre turns CCW object into CW window
    s.op("Translatef", 64, 0, 0).op("Scalef", -1, 1, 1);
    s.rect(18, 18, 30, 30); // object CCW -> window x 34..46 (tile 6), now CW
    s.label(6, "mirrored CCW (window CW): culled");
    s.rect(2, 18, 14, 30, null, true); // object CW -> window x 50..62 (tile 7), now CCW
    s.label(7, "mirrored CW (window CCW): drawn");
    s.op("LoadIdentity").op("CullFace", "FRONT_AND_BACK");
    s.tileQuad(8, "FRONT_AND_BACK: nothing");
    s.op("Disable", "CULL_FACE");
});


/* ------------------------------------------------------------------ */
/* Reader-reported suspects                                            */
/* ------------------------------------------------------------------ */

scene("light_normal_matrix", {
    what: "normals transformed by the inverse-transpose of the modelview: rotated modelviews (inverse != inverse-transpose)",
    spec: "GL 2.1 §2.11.3 (n' = n M^-1, i.e. inverse transpose for column vectors)",
}, s => {
    s.ops_(LIGHT_BASE).op("Materialfv", "FRONT_AND_BACK", "SPECULAR", [0, 0, 0, 1]);
    s.op("Lightfv", "LIGHT0", "POSITION", [0, 1, 0, 0]);   // eye +y
    // Rotate 90 about z: object +x normal becomes eye +y (lit). The inverse
    // (a -90 rotation) would give eye -y (dark).
    s.op("Rotatef", 90, 0, 0, 1);
    s.spot(0, "Rotate(90,z), N=(1,0,0): eye N=(0,1,0) lit", { eye: [0, 0, -3], obj: [0, 0, -3], normal: [1, 0, 0] });
    s.spot(1, "Rotate(90,z), N=(-1,0,0): eye N=(0,-1,0) dark", { eye: [0, 0, -3], obj: [0, 0, -3], normal: [-1, 0, 0] });
    s.op("LoadIdentity").op("Rotatef", 30, 0, 0, 1);
    s.op("Lightfv", "LIGHT0", "POSITION", [0.8660254, 0.5, 0, 0]);
    s.spot(2, "Rotate(30,z), N=(1,0,0); L set under the rotation -> eye (0.5,0.866): N.L=.866 (inverse gives 0)", { eye: [0, 0, -3], obj: [0, 0, -3], normal: [1, 0, 0], scale: 1.5 });
    s.op("LoadIdentity").op("Rotatef", 30, 0, 0, 1).op("Scalef", 1, 0.25, 1);
    s.op("Enable", "NORMALIZE").op("Lightfv", "LIGHT0", "POSITION", [0, 0, 1, 0]);
    s.spot(3, "Rotate(30,z)*Scale(1,.25,1), N=(0.6,0.8,0.0)+z tilt, NORMALIZE", { eye: [0, 0, -3], obj: [0, 0, -3], normal: [0.3, 0.4, 0.866], scale: 6 });
    s.op("Disable", "NORMALIZE").op("LoadIdentity");
    // shear: x' = x + y
    s.op("MultMatrixf", [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).op("Enable", "NORMALIZE");
    s.op("Lightfv", "LIGHT0", "POSITION", [0.6, 0, 0.8, 0]);
    s.spot(4, "shear modelview, N=(0,0,1) unchanged; N=(1,0,0)->(1,-1,0)/sqrt2", { eye: [0, 0, -3], obj: [0, 0, -3], normal: [0.7071, 0, 0.7071], scale: 3 });
    s.op("Disable", "NORMALIZE").op("LoadIdentity");
    // sphere map under a rotation uses the eye normal too
    s.op("Disable", "LIGHTING").ops_(gridTex(1)).op("Enable", "TEXTURE_2D").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "REPLACE")
        .op("TexGeni", "S", "TEXTURE_GEN_MODE", "SPHERE_MAP").op("TexGeni", "T", "TEXTURE_GEN_MODE", "SPHERE_MAP")
        .op("Enable", "TEXTURE_GEN_S").op("Enable", "TEXTURE_GEN_T");
    s.op("Rotatef", 90, 0, 0, 1);
    s.spot(5, "SPHERE_MAP under Rotate(90,z), N=(0.6,0,0.8): eye N=(0,0.6,0.8) -> t=0.8", { eye: [0, 0, -1], obj: [0, 0, -1], normal: [0.6, 0, 0.8] });
    s.op("LoadIdentity").op("Disable", "TEXTURE_GEN_S").op("Disable", "TEXTURE_GEN_T").op("Disable", "TEXTURE_2D");
});

scene("light_integer_params", {
    what: "glLightiv: SPOT_CUTOFF/SPOT_EXPONENT/POSITION ints are converted directly; colour ints are normalized",
    spec: "GL 2.1 §2.14.2 (integer colour params map to [-1,1]; others convert directly)",
}, s => {
    s.ops_(LIGHT_BASE).op("Materialfv", "FRONT_AND_BACK", "SPECULAR", [0, 0, 0, 1]);
    s.op("Lightfv", "LIGHT0", "POSITION", [0, 0, 0, 1]).op("Lightfv", "LIGHT0", "SPOT_DIRECTION", [0, 0, -1, 0]);
    s.op("Lightiv", "LIGHT0", "SPOT_CUTOFF", [45]).op("Lightiv", "LIGHT0", "SPOT_EXPONENT", [2]);
    s.spot(0, "Lightiv SPOT_CUTOFF 45, exp 2: P at 26.6deg inside", { eye: [1, 0, -2], normal: [0, 0, 1] });
    s.spot(1, "Lightiv SPOT_CUTOFF 45: P at 56deg outside", { eye: [3, 0, -2], normal: [0, 0, 1] });
    s.op("Lightiv", "LIGHT0", "SPOT_CUTOFF", [180]).op("Lightiv", "LIGHT0", "POSITION", [0, 0, 1, 0]);
    s.spot(2, "Lightiv POSITION (0,0,1,0) directional", { eye: [0, 0, -2], normal: [0, 0, 1] });
    s.op("Lightiv", "LIGHT0", "DIFFUSE", [2147483647, 1073741823, 0, 2147483647]);
    s.spot(3, "Lightiv DIFFUSE (1, 0.5, 0) normalized", { eye: [0, 0, -2], normal: [0, 0, 1] });
    s.op("Lightiv", "LIGHT0", "CONSTANT_ATTENUATION", [2]).op("Lightiv", "LIGHT0", "POSITION", [0, 0, 0, 1]);
    s.spot(4, "Lightiv CONSTANT_ATTENUATION 2", { eye: [0, 0, -2], normal: [0, 0, 1] });
});

scene("projective_texcoord", {
    what: "glTexCoord4f with q varying across a quad: s/q interpolated projectively",
    spec: "GL 2.1 §3.8.8 (s/q, t/q per fragment), §3.5 attribute interpolation",
}, s => {
    s.ortho2d().ops_(gridTex(1)).op("Enable", "TEXTURE_2D").op("TexEnvi", "TEXTURE_ENV", "TEXTURE_ENV_MODE", "REPLACE");
    // left edge (s,q)=(0,1), right edge (s,q)=(4,4) -> s/q 0..1 but projective:
    // at the horizontal midpoint s/q = 2/2.5 = 0.8 (texel 3), linear s/q would be 0.5 (texel 2)
    s.rect(0, 0, 64, 16, i => [["TexCoord4f", [0, 4, 4, 0][i], [0.125, 0.5, 0.5, 0.125][i] * [1, 4, 4, 1][i], 0, [1, 4, 4, 1][i]]]);
    s.tiles.push({ label: "q 1->4 across x: projective s/q", x: 0, y: 0, w: 64, h: 16 });
    s.rect(0, 20, 64, 36, i => [["TexCoord4f", [0, 1, 1, 0][i], 0.625, 0, 1]]);
    s.tiles.push({ label: "q=1 baseline (linear)", x: 0, y: 20, w: 64, h: 16 });
    // uniform q=0.5 on all vertices: (0.25..0.5)/0.5
    s.rect(0, 40, 64, 56, i => [["TexCoord4f", [0, 0.5, 0.5, 0][i] * 0.5, 0.875 * 0.5, 0, 0.5]]);
    s.tiles.push({ label: "uniform q=0.5", x: 0, y: 40, w: 64, h: 16 });
});

scene("strip_winding_cull", {
    what: "CULL_FACE BACK with front-facing QUAD_STRIP / TRIANGLE_STRIP / TRIANGLE_FAN / POLYGON / QUADS: every face drawn",
    spec: "GL 2.1 §2.6.1, §3.5.1 (strip triangles alternate vertex order so all share the strip's facing)",
}, s => {
    s.ortho2d().op("Enable", "CULL_FACE").op("CullFace", "BACK").op("Color3f", 1, 1, 1);
    const draw = (mode, verts, tile, text) => {
        s.label(tile, text);
        s.op("Begin", mode); verts.forEach(v => s.op("Vertex2f", v[0], v[1])); s.op("End");
    };
    draw("QUAD_STRIP", [[2, 2], [2, 14], [8, 2], [8, 14], [14, 2], [14, 14]], 0, "QUAD_STRIP v0 bottom v1 top: CW = back, culled");
    draw("TRIANGLE_STRIP", [[18, 2], [30, 2], [18, 14], [30, 14]], 1, "TRIANGLE_STRIP (front) x2");
    draw("TRIANGLE_FAN", [[34, 2], [46, 2], [46, 14], [34, 14]], 2, "TRIANGLE_FAN (front) x2");
    draw("POLYGON", [[50, 2], [62, 2], [62, 14], [50, 14]], 3, "POLYGON (front)");
    draw("QUAD_STRIP", [[2, 18], [14, 18], [2, 24], [14, 24], [2, 30], [14, 30]], 4, "QUAD_STRIP v0 left v1 right: CCW = front, drawn");
    draw("TRIANGLE_STRIP", [[18, 18], [18, 30], [30, 18], [30, 30]], 5, "TRIANGLE_STRIP CW (back) culled");
    s.op("CullFace", "FRONT");
    draw("QUAD_STRIP", [[34, 18], [46, 18], [34, 24], [46, 24], [34, 30], [46, 30]], 6, "QUAD_STRIP CCW, cull FRONT: culled");
    draw("QUAD_STRIP", [[50, 18], [50, 30], [56, 18], [56, 30], [62, 18], [62, 30]], 7, "QUAD_STRIP CW, cull FRONT: drawn");
    s.op("Disable", "CULL_FACE");
    // two-sided lighting on a front-facing QUAD_STRIP: both quads front material
    s.op("Enable", "LIGHTING").op("Enable", "LIGHT0").op("LightModeli", "LIGHT_MODEL_TWO_SIDE", 1)
        .op("Materialfv", "FRONT", "DIFFUSE", [0, 1, 0, 1]).op("Materialfv", "BACK", "DIFFUSE", [1, 0, 0, 1]).op("Normal3f", 0, 0, 1);
    draw("QUAD_STRIP", [[2, 34], [2, 46], [8, 34], [8, 46], [14, 34], [14, 46]], 8, "two-sided CW QUAD_STRIP: back material both quads");
    draw("TRIANGLE_STRIP", [[18, 34], [30, 34], [18, 46], [30, 46]], 9, "two-sided TRIANGLE_STRIP: green both");
    s.op("Disable", "LIGHTING");
});


scene("glsl_normal_matrix", {
    what: "GLSL gl_NormalMatrix under rotated/sheared modelviews (shares the fixed-function normal matrix field)",
    spec: "GL 2.1 §2.15.3 / GLSL 1.20 §7.5 (gl_NormalMatrix = transpose(inverse(mat3(gl_ModelViewMatrix))))",
}, s => {
    s.op("Program", 1, "void main(){ vec3 n = gl_NormalMatrix * gl_Normal; gl_FrontColor = vec4(n * 0.5 + 0.5, 1.0); gl_Position = ftransform(); }",
        "void main(){ gl_FragColor = gl_Color; }").op("UseProgram", 1);
    s.op("MatrixMode", "MODELVIEW").op("LoadIdentity").op("Rotatef", 90, 0, 0, 1);
    s.spot(0, "Rotate(90,z): N(1,0,0) -> (0,1,0) => (128,255,128)", { eye: [0, 0, -3], obj: [0, 0, -3], normal: [1, 0, 0] });
    s.op("LoadIdentity").op("Rotatef", 30, 0, 0, 1);
    s.spot(1, "Rotate(30,z): N(1,0,0) -> (.866,.5,0)", { eye: [0, 0, -3], obj: [0, 0, -3], normal: [1, 0, 0], scale: 1.5 });
    s.op("LoadIdentity").op("MultMatrixf", [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    s.spot(2, "shear x+=y: N(1,0,0) -> (1,-1,0)", { eye: [0, 0, -3], obj: [0, 0, -3], normal: [1, 0, 0], scale: 3 });
    s.op("LoadIdentity").op("UseProgram", 0);
});

const VP_PASS = "!!ARBvp1.0\nPARAM mvp[4] = { state.matrix.mvp };\nDP4 result.position.x, mvp[0], vertex.position;\nDP4 result.position.y, mvp[1], vertex.position;\nDP4 result.position.z, mvp[2], vertex.position;\nDP4 result.position.w, mvp[3], vertex.position;\nMOV result.color, vertex.color;\nMOV result.texcoord[0], vertex.texcoord[0];\nEND\n";
scene("arb_fp_semantics", {
    what: "ARB_fragment_program instruction semantics, written to avoid the executor's parser gaps (constants as PARAMs) and paired with a pass-through ARB vertex program",
    spec: "ARB_fragment_program §3.11.5",
}, s => {
    s.ortho2d().ops_(gridTex(1)).op("Fogfv", "FOG_COLOR", [0.3, 0.6, 0.9, 1]);
    s.op("ProgramARB", "VERTEX_PROGRAM_ARB", 9, VP_PASS).op("Enable", "VERTEX_PROGRAM_ARB");
    const progs = [
        ["LIT x>0: (1,.5,.0625,1)*.5", "PARAM p = program.local[0];\nPARAM h = {0.5, 0.5, 0.5, 0.5};\nTEMP t;\nLIT t, p;\nMUL result.color, t, h;", [0.5, 0.25, 0, 2]],
        ["LIT x<=0: z=0", "PARAM p = program.local[0];\nPARAM h = {0.5, 0.5, 0.5, 0.5};\nTEMP t;\nLIT t, p;\nMUL result.color, t, h;", [-0.5, 0.25, 0, 2]],
        ["TXP (1.25,.75,0,2)->texel(2,1)", "TXP result.color, fragment.texcoord[0], texture[0], 2D;", null],
        ["RSQ(-4)=0.5 (abs)", "PARAM p = program.local[0];\nPARAM k = {0, 0, 0, 1};\nTEMP t;\nRSQ t.x, p.x;\nMOV result.color, k;\nMOV result.color.x, t.x;", [-4, 0, 0, 0]],
        ["fragment.position/64 (window coords, bottom-left)", "PARAM s = {0.015625, 0.015625, 1, 0};\nPARAM one = {0, 0, 0, 1};\nTEMP t;\nMUL t, fragment.position, s;\nADD result.color, t, one;", null],
        ["CMP p<0 ? a : b", "PARAM p = program.local[0];\nPARAM a = {0.25, 0.25, 0.25, 1};\nPARAM b = {0.75, 0.75, 0.75, 1};\nCMP result.color, p, a, b;", [-1, 1, -1, 1]],
        ["FLR(-1.25)*-.25=.5, FRC(-1.25)=.75", "PARAM p = program.local[0];\nPARAM q = {-0.25, -0.25, -0.25, -0.25};\nPARAM k = {0, 0, 0, 1};\nTEMP t, u;\nFLR t, p;\nFRC u, p;\nMUL t, t, q;\nMOV result.color, k;\nMOV result.color.x, t.x;\nMOV result.color.y, u.x;", [-1.25, 0, 0, 0]],
        ["POW(.25,.5) EX2(-1) LG2(4)/4", "PARAM c = {0.25, 0.5, -1, 4};\nPARAM d = {1, 1, 1, 1};\nTEMP t;\nPOW t.x, c.x, c.y;\nEX2 t.y, c.z;\nLG2 t.z, c.w;\nMUL t.z, t.z, c.x;\nMOV t.w, d.w;\nMOV result.color, t;", null],
        ["SCS(pi/6): cos .866 sin .5", "PARAM c = {0.5235988, 0, 0, 1};\nTEMP t;\nSCS t.xy, c.x;\nMOV t.zw, c.zzzw;\nMOV result.color, t;", null],
        ["XPD x*y=z, DPH", "PARAM x = {1, 0, 0, 0};\nPARAM y = {0, 1, 0, 0};\nPARAM a = {0.1, 0.1, 0.1, 0};\nPARAM b = {1, 1, 1, 0.2};\nTEMP t;\nXPD t.xyz, x, y;\nDPH t.w, a, b;\nMOV result.color, t;", null],
        ["state.fog.color", "PARAM f = state.fog.color;\nMOV result.color, f;", null],
        ["KIL negative -> clear colour", "PARAM k = {-1, 0, 0, 0};\nPARAM w = {1, 1, 1, 1};\nKIL k;\nMOV result.color, w;", null],
        ["LRP + MAD_SAT", "PARAM a = {0.25, 0.5, 0.75, 1};\nPARAM one = {1, 1, 1, 1};\nPARAM zero = {0, 0, 0, 0};\nPARAM four = {4, 4, 4, 4};\nPARAM m1 = {-1, -1, -1, -1};\nTEMP t;\nLRP t, a, one, zero;\nMAD_SAT t, t, four, m1;\nMOV result.color, t;", null],
        ["DST", "PARAM a = {0, 4, 16, 0};\nPARAM b = {0, 0.25, 0, 0.125};\nPARAM h = {0.5, 0.5, 0.5, 0.5};\nTEMP t;\nDST t, a, b;\nMUL result.color, t, h;", null],
        ["fragment.color passthrough", "MOV result.color, fragment.color;", null],
    ];
    progs.forEach(([text, body, local], i) => {
        s.op("ProgramARB", "FRAGMENT_PROGRAM_ARB", 10 + i, FP(body)).op("Enable", "FRAGMENT_PROGRAM_ARB");
        if (local) s.op("ProgramLocalParameter4f", "FRAGMENT_PROGRAM_ARB", 0, ...local);
        s.tileQuad(i, text, i === 2 ? () => [["TexCoord4f", 1.25, 0.75, 0, 2]] : i === 14 ? () => [["Color4f", 0.2, 0.7, 0.4, 0.9]] : null);
    });
    s.op("Disable", "FRAGMENT_PROGRAM_ARB").op("Disable", "VERTEX_PROGRAM_ARB");
});

scene("arb_vp_semantics", {
    what: "ARB_vertex_program: env params set before any program is bound, ARL relative addressing, EXP/LOG/LIT (no inline constants or [a..b] ranges)",
    spec: "ARB_vertex_program §2.14.1.2 (env parameters are per target, not per program), §2.14.5",
}, s => {
    s.ortho2d();
    const head = "!!ARBvp1.0\nPARAM mvp[4] = { state.matrix.mvp };\nPARAM arr[5] = { program.local[0], program.local[1], program.local[2], program.local[3], program.local[4] };\nDP4 result.position.x, mvp[0], vertex.position;\nDP4 result.position.y, mvp[1], vertex.position;\nDP4 result.position.z, mvp[2], vertex.position;\nDP4 result.position.w, mvp[3], vertex.position;\n";
    const progs = [
        ["env set before binding; ARL a0=floor(2.7)=2 -> arr[3]", "ADDRESS a;\nARL a.x, program.env[0].x;\nMOV result.color, arr[a.x+1];"],
        ["EXP 1.5 -> (2,.5,2.83,1)/4", "PARAM c = {1.5, 0, 0, 0};\nPARAM q = {0.25, 0.25, 0.25, 0.25};\nTEMP t;\nEXP t, c.x;\nMUL result.color, t, q;"],
        ["LOG 8 -> (3,1,3,1)/4", "PARAM c = {8, 0, 0, 0};\nPARAM q = {0.25, 0.25, 0.25, 0.25};\nTEMP t;\nLOG t, c.x;\nMUL result.color, t, q;"],
        ["LIT in VP", "PARAM c = {0.5, 0.25, 0, 2};\nPARAM h = {0.5, 0.5, 0.5, 0.5};\nTEMP t;\nLIT t, c;\nMUL result.color, t, h;"],
        ["ARL negative offset arr[a0.x-1] -> arr[1]", "ADDRESS a;\nARL a.x, program.env[0].x;\nMOV result.color, arr[a.x-1];"],
        ["state.light[0].diffuse binding", "PARAM d = state.light[0].diffuse;\nMOV result.color, d;"],
    ];
    s.op("ProgramEnvParameter4f", "VERTEX_PROGRAM_ARB", 0, 2.7, 0, 0, 0);   // no program bound yet: legal
    s.op("Lightfv", "LIGHT0", "DIFFUSE", [0.3, 0.6, 0.9, 1]);
    progs.forEach(([text, body], i) => {
        s.op("ProgramARB", "VERTEX_PROGRAM_ARB", 30 + i, head + body + "\nEND\n").op("Enable", "VERTEX_PROGRAM_ARB");
        for (let k = 0; k < 5; ++k) s.op("ProgramLocalParameter4f", "VERTEX_PROGRAM_ARB", k, 0.1 + 0.2 * k, 0.8 - 0.15 * k, 0.5, 1);
        s.tileQuad(i, text);
    });
    s.op("Disable", "VERTEX_PROGRAM_ARB");
});


scene("arb_diag", {
    what: "narrowing ARB failures: texture enable vs fragment programs, state.fog.color binding",
    spec: "ARB_fragment_program §3.11.2 (texture enables are ignored while a fragment program is enabled)",
}, s => {
    s.ortho2d().ops_(gridTex(1)).op("Fogfv", "FOG_COLOR", [0.3, 0.6, 0.9, 1]);
    s.op("ProgramARB", "VERTEX_PROGRAM_ARB", 9, VP_PASS).op("Enable", "VERTEX_PROGRAM_ARB");
    const fp = (i, text, body, pre, per) => {
        s.op("ProgramARB", "FRAGMENT_PROGRAM_ARB", 50 + i, FP(body)).op("Enable", "FRAGMENT_PROGRAM_ARB");
        if (pre) s.ops_(pre);
        s.tileQuad(i, text, per);
    };
    const TXP = "TXP result.color, fragment.texcoord[0], texture[0], 2D;";
    const TEX = "TEX result.color, fragment.texcoord[0], texture[0], 2D;";
    fp(0, "TEX, TEXTURE_2D disabled", TEX, null, () => [["TexCoord2f", 0.625, 0.375]]);
    fp(1, "TEX, TEXTURE_2D enabled", TEX, [["Enable", "TEXTURE_2D"]], () => [["TexCoord2f", 0.625, 0.375]]);
    fp(2, "TXP q=2, TEXTURE_2D enabled", TXP, null, () => [["TexCoord4f", 1.25, 0.75, 0, 2]]);
    s.op("Disable", "TEXTURE_2D");
    fp(3, "state.fog.color, FOG disabled", "PARAM f = state.fog.color;\nMOV result.color, f;");
    fp(4, "state.fog.color, FOG enabled", "PARAM f = state.fog.color;\nMOV result.color, f;", [["Enable", "FOG"]]);
    s.op("Disable", "FOG");
    fp(5, "state.light[0].diffuse in FP", "PARAM d = state.light[0].diffuse;\nMOV result.color, d;", [["Lightfv", "LIGHT0", "DIFFUSE", [0.3, 0.6, 0.9, 1]]]);
    fp(6, "program.env[3] in FP", "PARAM e = program.env[3];\nMOV result.color, e;", [["ProgramEnvParameter4f", "FRAGMENT_PROGRAM_ARB", 3, 0.7, 0.2, 0.5, 1]]);
    s.op("Disable", "FRAGMENT_PROGRAM_ARB").op("Disable", "VERTEX_PROGRAM_ARB");
});


scene("viewport_offscreen", {
    what: "viewport partly outside the window: Viewport(-32,0,128,64) and Viewport(0,32,128,128); NDC quads must land where GL maps them",
    spec: "GL 2.1 §2.11.1 (x_w = (x_d+1) p_x/2 + o_x; no clamping of o or p to the window)",
}, s => {
    s.op("MatrixMode", "PROJECTION").op("LoadIdentity").op("MatrixMode", "MODELVIEW").op("LoadIdentity");
    s.op("Viewport", -32, 0, 128, 32).op("Color3f", 1, 0, 0);
    s.op("Begin", "QUADS").op("Vertex2f", -0.25, -1).op("Vertex2f", 0.25, -1).op("Vertex2f", 0.25, 1).op("Vertex2f", -0.25, 1).op("End");
    s.tiles.push({ label: "Viewport(-32,0,128,32): NDC x in [-.25,.25] -> window x 16..48", x: 0, y: 0, w: 64, h: 32 });
    s.op("Viewport", 0, 32, 128, 128).op("Color3f", 0, 1, 0);
    s.op("Begin", "QUADS").op("Vertex2f", -1, -1).op("Vertex2f", -0.75, -1).op("Vertex2f", -0.75, -0.75).op("Vertex2f", -1, -0.75).op("End");
    s.tiles.push({ label: "Viewport(0,32,128,128): NDC [-1,-.75]^2 -> window 0..16 x 32..48", x: 0, y: 32, w: 64, h: 32 });
});

if (typeof module !== "undefined" && module.exports) module.exports = { scenes, SIZE };
else globalThis.GLConformanceScenes = { scenes, SIZE };
