// GLES 1.1's draws on the page (docs/gles-proxy-plan.md E4): the shadow's
// fixed-function state (src/gles/gles1_state.js) turned into gl-webgpu's
// fixed-function signature and state block (gl_fixed_function.js,
// gl_state_layout.js: the XP path's generator, shared as it is), and the
// draw's vertices from the client arrays or the current values; the
// draw_texture extension's rectangles.

import { GL } from "../gles_formats.js";
import { UNITS, mat_inverse, mat_mul } from "../gles1_state.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const ENV_MODES = { 0x2100: "MODULATE", 0x2101: "DECAL", 0x0BE2: "BLEND", 0x0104: "ADD", 0x1E01: "REPLACE", 0x8570: "COMBINE" };
const COMBINE = { 0x1E01: "REPLACE", 0x2100: "MODULATE", 0x0104: "ADD", 0x8574: "ADD_SIGNED", 0x8575: "INTERPOLATE", 0x84E7: "SUBTRACT",
    0x86AE: "DOT3_RGB", 0x86AF: "DOT3_RGBA" };
const SOURCES = { 0x1702: "TEXTURE", 0x8576: "CONSTANT", 0x8577: "PRIMARY_COLOR", 0x8578: "PREVIOUS" };
const OPERANDS = { 0x0300: "SRC_COLOR", 0x0301: "ONE_MINUS_SRC_COLOR", 0x0302: "SRC_ALPHA", 0x0303: "ONE_MINUS_SRC_ALPHA" };
const ALPHA_FUNCS = { 0x0200: "never", 0x0201: "less", 0x0202: "equal", 0x0203: "lequal", 0x0204: "greater", 0x0205: "notequal",
    0x0206: "gequal", 0x0207: "always" };
const FORMATS = { [GL.RGBA]: "RGBA", [GL.BGRA_EXT]: "RGBA", [GL.RGB]: "RGB", [GL.ETC1_RGB8_OES]: "RGB", [GL.ALPHA]: "ALPHA",
    [GL.LUMINANCE]: "LUMINANCE", [GL.LUMINANCE_ALPHA]: "LUMINANCE_ALPHA" };

/** @param {!Array<number>} m @return {boolean} */
const is_identity = m => m.every((v, i) => v === IDENTITY[i]);

/** The bound texture a fixed-function unit samples, if the unit is enabled and has one */
export function unit_texture(c, unit)
{
    const enabled = c.ff.texture_enabled[unit];
    const target = enabled[GL.TEXTURE_EXTERNAL_OES] ? GL.TEXTURE_EXTERNAL_OES : enabled[GL.TEXTURE_2D] ? GL.TEXTURE_2D : 0;
    if(!target) return null;
    const name = c.textures[unit][target === GL.TEXTURE_2D ? 0 : 2];
    const texture = name ? c.group.textures.get(name) : c.defaults && c.defaults.get(target);
    return texture && texture.images.get(0) ? texture : null;
}

/**
 * The fixed-function signature of the context's state for a draw
 * @param {!Object} c
 * @param {boolean} points a draw of points (sprites)
 * @param {?Array<!Object>} textures by unit (unit_texture's)
 */
export function ff_signature(c, points, textures)
{
    const ff = c.ff;
    const on = cap => c.enabled.has(cap);
    const lighting = on(0x0B50);
    const signature = {
        attributes: {
            position: { components: ff.arrays.vertex.enabled ? ff.arrays.vertex.size : 4 },
            normal: lighting, color: true, secondaryColor: false, fogCoord: false,
            texCoord: textures.map(t => t ? { components: 4 } : null),
        },
        lighting: {
            enabled: lighting, twoSide: !!ff.light_model.two_side, localViewer: false, separateSpecular: false,
            normalMode: on(0x0BA1) ? "normalize" : on(0x803A) ? "rescale" : "none",
            colorMaterial: on(0x0B57) ? { enabled: true, face: "FRONT_AND_BACK", mode: "AMBIENT_AND_DIFFUSE" } : { enabled: false },
            lights: ff.lights.map((l, i) => ({ enabled: on(0x4000 + i), positional: l.position[3] !== 0, spot: l.spot_cutoff !== 180 })),
        },
        fog: on(0x0B60) ? { enabled: true, mode: { 0x2601: "linear", 0x0800: "exp", 0x0801: "exp2" }[ff.fog.mode], coordSource: "depth" } :
            { enabled: false },
        texture: textures.map((t, i) =>
        {
            if(!t) return { enabled: false };
            const e = ff.env[i];
            const env = { mode: ENV_MODES[e.mode], coordReplace: !!e.coord_replace };
            if(e.mode === 0x8570)
            {
                Object.assign(env, { combineRGB: COMBINE[e.combine_rgb], combineAlpha: COMBINE[e.combine_alpha],
                    srcRGB: e.src_rgb.map(s => SOURCES[s]), operandRGB: e.operand_rgb.map(o => OPERANDS[o]),
                    srcAlpha: e.src_alpha.map(s => SOURCES[s]), operandAlpha: e.operand_alpha.map(o => OPERANDS[o]),
                    rgbScale: e.rgb_scale, alphaScale: e.alpha_scale });
            }
            const base = t.images.get(0);
            return { enabled: true, target: "2D", shadow: false, format: FORMATS[base.format] || "RGBA",
                matrix: !is_identity(ff.stacks[0x1702][i].at(-1)), texGen: [null, null, null, null], env };
        }),
        alphaTest: on(0x0BC0) ? ALPHA_FUNCS[ff.alpha_func] : "always",
        clipPlaneCount: ff.clip_planes.reduce((n, p, i) => on(0x3000 + i) ? i + 1 : n, 0),
        pointSprite: points && on(0x8861),
        flatShading: ff.shade_model === 0x1D00,
        colorTargets: 1,
    };
    return signature;
}

/** The state block's snapshot (gl_state_layout.js's fields) of a GLES 1.1 context */
export function ff_snapshot(c, viewport)
{
    const ff = c.ff;
    const modelview = ff.stacks[0x1700].at(-1), projection = ff.stacks[0x1701].at(-1);
    const mv_inverse = mat_inverse(modelview);
    // the normal matrix: the inverse transpose of the modelview's upper 3 by 3
    const normal = [mv_inverse[0], mv_inverse[4], mv_inverse[8], mv_inverse[1], mv_inverse[5], mv_inverse[9], mv_inverse[2], mv_inverse[6], mv_inverse[10]];
    const textures = Array.from({ length: 8 }, (_, i) => i < UNITS ? ff.stacks[0x1702][i].at(-1) : IDENTITY);
    const material = { emission: ff.material.emission, ambient: ff.material.ambient, diffuse: ff.material.diffuse, specular: ff.material.specular,
        shininess: ff.material.shininess };
    const lights = ff.lights.map(l =>
    {
        const [px, py, pz] = l.position;
        const length = Math.hypot(px, py, pz) || 1;
        const h = [px / length, py / length, pz / length + 1];
        const hl = Math.hypot(...h) || 1;
        return { ambient: l.ambient, diffuse: l.diffuse, specular: l.specular, position: l.position, halfVector: [h[0] / hl, h[1] / hl, h[2] / hl, 0],
            spotDirection: l.spot_direction, spotExponent: l.spot_exponent, spotCutoff: l.spot_cutoff,
            spotCosCutoff: l.spot_cutoff === 180 ? -1 : Math.cos(l.spot_cutoff * Math.PI / 180),
            constantAttenuation: l.attenuation[0], linearAttenuation: l.attenuation[1], quadraticAttenuation: l.attenuation[2] };
    });
    const scene = [0, 1, 2].map(i => material.emission[i] + material.ambient[i] * ff.light_model.ambient[i]).concat([material.diffuse[3]]);
    const products = ff.lights.map(l => ({ ambient: material.ambient.map((v, i) => v * l.ambient[i]),
        diffuse: material.diffuse.map((v, i) => v * l.diffuse[i]), specular: material.specular.map((v, i) => v * l.specular[i]) }));
    const zero = () => [0, 0, 0, 0];
    return {
        matrices: { modelview, projection, mvp: mat_mul(projection, modelview), normal, modelviewInverse: mv_inverse,
            texture: textures, textureInverse: textures, textureTranspose: textures, textureInverseTranspose: textures,
            modelviewTranspose: IDENTITY, modelviewInverseTranspose: IDENTITY, projectionInverse: IDENTITY, projectionTranspose: IDENTITY,
            projectionInverseTranspose: IDENTITY, mvpInverse: IDENTITY, mvpTranspose: IDENTITY, mvpInverseTranspose: IDENTITY },
        lights, material: { front: material, back: material }, lightModel: { ambient: ff.light_model.ambient },
        derived: { frontSceneColor: scene, backSceneColor: scene, frontLightProduct: products, backLightProduct: products },
        fog: { color: ff.fog.color, density: ff.fog.density, start: ff.fog.start, end: ff.fog.end },
        texEnvColor: Array.from({ length: 8 }, (_, i) => i < UNITS ? ff.env[i].color : zero()),
        texGen: Array.from({ length: 8 }, () => Array.from({ length: 4 }, () => ({ objectPlane: zero(), eyePlane: zero() }))),
        clipPlanes: ff.clip_planes.map((p, i) => c.enabled.has(0x3000 + i) ? p : zero()),
        depthRange: { near: c.depth_range[0], far: c.depth_range[1] },
        point: { size: ff.point.size, sizeMin: ff.point.min, sizeMax: Math.max(ff.point.min, Math.min(ff.point.max, 256)),
            fadeThreshold: ff.point.fade, attenuation: ff.point.attenuation },
        alphaRef: ff.alpha_ref,
        viewport: { x: viewport[0], y: viewport[1], width: viewport[2], height: viewport[3] },
        lineWidth: c.line_width, lineStipple: { pattern: 0xFFFF, factor: 1 }, polygonStippleEnabled: false, polygonStipple: new Uint8Array(128),
    };
}

/**
 * The vertex inputs of a fixed-function draw: [location, the array or a
 * constant value, its normalization] by the generator's attributes
 * @param {!Object} c
 * @param {!Array<{name: string, location: number, components: number}>} attributes the generator's
 */
export function ff_inputs(c, attributes)
{
    const ff = c.ff;
    return attributes.map(a =>
    {
        if(a.name === "position") return { location: a.location, components: a.components, array: ff.arrays.vertex, normalized: false, current: [0, 0, 0, 1] };
        if(a.name === "normal") return { location: a.location, components: 3, array: ff.arrays.normal, normalized: true, current: ff.normal };
        if(a.name === "color") return { location: a.location, components: 4, array: ff.arrays.color, normalized: true, current: ff.color };
        const unit = +a.name.replace("texCoord", "");
        return { location: a.location, components: a.components, array: ff.arrays.texcoord[unit], normalized: false, current: ff.texcoord[unit] };
    });
}
