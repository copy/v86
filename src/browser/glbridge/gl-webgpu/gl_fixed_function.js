// The OpenGL fixed-function pipeline, generated as WGSL.
//
// There is no interpreter here: a signature -- which lights are on, what each
// texture unit's environment does, whether fog is linear or exponential -- is
// turned into one vertex and one fragment shader, and the pair is cached. That
// is the same shape d3d9_executor.js uses for D3D9's fixed function, but none
// of its *content* transfers. GL's GL_COMBINE with its per-argument operands,
// independent RGB and alpha functions, RGB_SCALE and GL_TEXTURE<n> crossbar
// sources is a different machine from D3D9's texture stages, and GL's lighting
// differs from D3D9's in the attenuation and spotlight terms. Copying the D3D9
// tables would produce a picture that is close enough to look right and wrong
// everywhere it matters.
//
// The state uniforms come from gl_state_layout.js, shared with the GLSL
// compatibility built-ins, so ftransform() in a shader and the transform here
// are literally the same expression -- which is what GL requires for a depth
// pre-pass drawn one way and shaded the other not to z-fight.
//
// See docs/opengl-webgpu-implementation-plan.zh-CN.md sections 4.5 and 10.

(function(global) {
    "use strict";

    const stateLayout = (typeof require === "function" && typeof module !== "undefined") ?
        require("./gl_state_layout.js") : global.GLStateLayout;
    const translator = (typeof require === "function" && typeof module !== "undefined") ?
        require("./gl_shader_translator.js") : global.GLShaderTranslator;

    const { CacheKeys } = global.GLCacheKeys || require("./gl_cache_keys.js");
    const signatureKeys = new CacheKeys();
    const FIXED_FUNCTION_REVISION = 3;

    const MAX_TEXTURE_UNITS = stateLayout.MAX_TEXTURE_UNITS;
    const MAX_LIGHTS = stateLayout.MAX_LIGHTS;
    const ATTR = translator.COMPAT_ATTRIBUTE_LOCATIONS;
    const POINT_CORNER_LOCATION = translator.POINT_CORNER_LOCATION;
    // slots no conventional attribute aliases (ARB_vertex_program 2.14.3)
    const DEPTH_OFFSET_LOCATION = 6;
    const LINE_ATTRIBUTE_LOCATION = 1;

    /* ================================================================== */
    /* Signature                                                          */
    /* ================================================================== */

    /*
     * The signature is the cache key and the generator's only input. Anything
     * that changes the generated code must appear in it: a field that changes
     * the picture but not the signature shows up as "I changed the state and
     * nothing happened", which is the hardest class of bug in this file to
     * find. gl_state_signature_test.js walks every field to keep that honest.
     *
     * {
     *   attributes: { position:{components}, normal:bool, color:bool,
     *                 secondaryColor:bool, fogCoord:bool,
     *                 texCoord:[8 x {components}|null] },
     *   lighting: { enabled, twoSide, localViewer, separateSpecular,
     *               normalMode: "none"|"normalize"|"rescale",
     *               colorMaterial: {enabled, face, mode},
     *               lights: [8 x {enabled, positional, spot}] },
     *   fog: { enabled, mode: "linear"|"exp"|"exp2", coordSource: "depth"|"coord" },
     *   texture: [8 x { enabled, target:"1D"|"2D"|"3D"|"Cube", shadow,
     *                   format:"ALPHA"|"LUMINANCE"|"LUMINANCE_ALPHA"|
     *                          "INTENSITY"|"RGB"|"RGBA",
     *                   matrix: bool,
     *                   texGen: [4 x null|"OBJECT"|"EYE"|"SPHERE"|"REFLECTION"|"NORMAL"],
     *                   env: {...} } ],
     *   alphaTest: "always"|"never"|"less"|"lequal"|"equal"|"gequal"|"greater"|"notequal",
     *   clipPlaneCount: 0..6,
     *   pointSprite: bool,
     *   flatShading: bool,
     *   colorTargets: 1..8,
     *   backFacing: bool,     a back polygon's edges or vertices (glPolygonMode)
     *   depthOffset: bool,    a per-vertex depth offset (POLYGON_OFFSET_LINE/POINT)
     *   wideLine: bool,       a line's quad corner, offset in pixels (lineAttr.xy)
     *   lineStipple: bool,    the distance along the line for the pattern (lineAttr.z)
     * }
     */

    function normalizeSignature(sig) {
        const s = sig || {};
        const attributes = s.attributes || {};
        const texCoord = [];
        for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
            const entry = (attributes.texCoord || [])[i];
            texCoord.push(entry ? { components: entry.components || 4 } : null);
        }
        const lighting = s.lighting || {};
        const lights = [];
        for (let i = 0; i < MAX_LIGHTS; ++i) {
            const l = (lighting.lights || [])[i];
            lights.push(l && l.enabled ? {
                enabled: true,
                positional: !!l.positional,
                spot: !!l.spot,
            } : { enabled: false, positional: false, spot: false });
        }
        const texture = [];
        for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
            const t = (s.texture || [])[i];
            texture.push(t && t.enabled ? {
                enabled: true,
                target: t.target || "2D",
                shadow: !!t.shadow,
                format: t.format || "RGBA",
                matrix: !!t.matrix,
                // a LOD bias other than zero (the value is state, textureLodBias)
                lodBias: !!t.lodBias,
                border: normalizeBorder(t.border),
                texGen: (t.texGen || [null, null, null, null]).slice(0, 4),
                env: normalizeEnv(t.env),
            } : { enabled: false });
        }
        return {
            // ARB vertex programs expose the historical compatibility
            // varying ABI: primary/secondary/fog at locations 0/1/2 and
            // texture coordinates at 3+n. A fixed fragment stage paired with
            // one must consume that ABI instead of our compact internal one.
            varyingInterface: s.varyingInterface === "arb" ? "arb" : "packed",
            desktopSampling: !!s.desktopSampling,
            glslInterface: s.glslInterface || null,
            twoSidedColors: !!s.twoSidedColors,
            textureBindingBase: s.textureBindingBase || 0,
            // the vertex stage before an ARB fragment program, which reads
            // every interface slot (gl_arb_program.js FSIn)
            arbFragment: !!s.arbFragment,
            extraStateFields: Array.from(new Set(s.extraStateFields || [])).sort(),
            attributes: {
                position: { components: (attributes.position &&
                    attributes.position.components) || 4 },
                normal: !!attributes.normal,
                color: !!attributes.color,
                secondaryColor: !!attributes.secondaryColor,
                fogCoord: !!attributes.fogCoord,
                texCoord,
            },
            // GL_COLOR_SUM: the secondary colour added after texturing
            colorSum: !!s.colorSum,
            lighting: {
                enabled: !!lighting.enabled,
                twoSide: !!lighting.twoSide,
                localViewer: !!lighting.localViewer,
                separateSpecular: !!lighting.separateSpecular,
                normalMode: lighting.normalMode || "none",
                colorMaterial: lighting.colorMaterial && lighting.colorMaterial.enabled ?
                    { enabled: true,
                      face: lighting.colorMaterial.face || "FRONT_AND_BACK",
                      mode: lighting.colorMaterial.mode || "AMBIENT_AND_DIFFUSE" } :
                    { enabled: false },
                lights,
            },
            fog: s.fog && s.fog.enabled ? {
                enabled: true,
                mode: s.fog.mode || "linear",
                coordSource: s.fog.coordSource || "depth",
            } : { enabled: false },
            texture,
            alphaTest: s.alphaTest || "always",
            clipPlaneCount: Math.max(0, Math.min(6, s.clipPlaneCount || 0)),
            pointSprite: !!s.pointSprite,
            pointCoordLowerLeft: !!s.pointCoordLowerLeft,
            polygonStipple: !!s.polygonStipple,
            logicOp: s.logicOp ? (s.logicOp >>> 0) : 0,
            flatShading: !!s.flatShading,
            colorTargets: Math.max(1, Math.min(8, s.colorTargets || 1)),
            backFacing: !!s.backFacing,
            depthOffset: !!s.depthOffset,
            wideLine: !!s.wideLine,
            lineStipple: !!s.lineStipple,
        };
    }

    /*
     * The axes that read GL's border colour (the colour is state,
     * textureBorderColor): "border" for CLAMP_TO_BORDER, "clamp" for GL_CLAMP
     * filtered linearly (which blends the border in at the edge); `linear`
     * the filter, `compare` a shadow lookup's function. null for none.
     */
    function normalizeBorder(b) {
        if (!b || !(b.s || b.t || b.r)) return null;
        return { s: b.s || null, t: b.t || null, r: b.r || null, linear: !!b.linear,
                 compare: b.compare || null };
    }

    function normalizeEnv(env) {
        const e = env || {};
        const mode = e.mode || "MODULATE";
        if (mode !== "COMBINE") return {
            mode,
            coordReplace: !!e.coordReplace,
        };
        return {
            mode,
            coordReplace: !!e.coordReplace,
            combineRGB: e.combineRGB || "MODULATE",
            combineAlpha: e.combineAlpha || "MODULATE",
            srcRGB: (e.srcRGB || ["TEXTURE", "PREVIOUS", "CONSTANT"]).slice(0, 3),
            operandRGB: (e.operandRGB ||
                ["SRC_COLOR", "SRC_COLOR", "SRC_ALPHA"]).slice(0, 3),
            srcAlpha: (e.srcAlpha || ["TEXTURE", "PREVIOUS", "CONSTANT"]).slice(0, 3),
            operandAlpha: (e.operandAlpha ||
                ["SRC_ALPHA", "SRC_ALPHA", "SRC_ALPHA"]).slice(0, 3),
            rgbScale: e.rgbScale || 1,
            alphaScale: e.alphaScale || 1,
        };
    }

    function signatureKey(sig) {
        return signatureKeys.key([FIXED_FUNCTION_REVISION, normalizeSignature(sig)]);
    }

    /* ================================================================== */
    /* State field selection                                              */
    /* ================================================================== */

    /*
     * Only the state a given signature reads is uploaded. A 2D blit with one
     * modulate stage needs the modelview-projection matrix and nothing else --
     * 16 floats instead of the ~700 the full table would occupy, per draw.
     */
    function stateFieldsFor(sig) {
        const fields = new Set(["mvp"]);
        for (const field of sig.extraStateFields || []) fields.add(field);
        const lighting = sig.lighting;
        const needsEye = lighting.enabled ||
            sig.texture.some(t => t.enabled && t.texGen &&
                t.texGen.some(m => m === "EYE" || m === "SPHERE" ||
                    m === "REFLECTION" || m === "NORMAL")) ||
            (sig.fog.enabled && sig.fog.coordSource === "depth") ||
            sig.clipPlaneCount > 0 ||
            sig.pointSprite;
        if (needsEye) fields.add("modelview");
        if (lighting.enabled) {
            fields.add("lights");
            fields.add("frontMaterial");
            fields.add("lightModelAmbient");
            fields.add("frontSceneColor");
            if (lighting.twoSide) {
                fields.add("backMaterial");
                fields.add("backSceneColor");
            }
        }
        if (lighting.enabled || sig.attributes.normal) fields.add("normalMatrix");
        if (sig.fog.enabled) {
            fields.add("fogParams");
            fields.add("fogColor");
        }
        for (const t of sig.texture) {
            if (!t.enabled) continue;
            if (sig.desktopSampling) fields.add("samplerState");
            if (t.matrix) fields.add("textureMatrix");
            if (t.lodBias && !t.shadow) fields.add("textureLodBias");
            if (t.border) fields.add("textureBorderColor");
            if (t.texGen && t.texGen.some(m => m === "OBJECT" || m === "EYE"))
                fields.add("texGenPlanes");
            if (t.env.mode === "BLEND" ||
                    (t.env.mode === "COMBINE" &&
                     (t.env.srcRGB.includes("CONSTANT") ||
                      t.env.srcAlpha.includes("CONSTANT"))))
                fields.add("texEnvColor");
        }
        if (sig.clipPlaneCount) fields.add("clipPlanes");
        if (sig.alphaTest !== "always" && sig.alphaTest !== "never")
            fields.add("alphaRef");
        if (sig.pointSprite) {
            fields.add("pointParams");
            fields.add("pointAttenuation");
            fields.add("viewportParams");
        }
        if (sig.wideLine) fields.add("viewportParams");
        if (sig.lineStipple) fields.add("rasterParams");
        if (sig.polygonStipple) fields.add("polygonStipple");
        return fields;
    }

    /* ================================================================== */
    /* Varying allocation                                                 */
    /* ================================================================== */

    /*
     * Slots are assigned here rather than by the translator's packer because
     * the fixed pipeline's set is known exactly: colour, secondary colour,
     * fog, up to eight texture coordinates, and the two extras. Packing the
     * scalars (fog) alongside a colour keeps the common lit-and-fogged case
     * inside four slots.
     */
    function allocateVaryings(sig) {
        const entries = [];
        const slots = [];
        const place = (name, components, extra) => {
            let slot = -1, offset = 0;
            if (components === 4) {
                slots.push(4);
                slot = slots.length - 1;
            } else {
                for (let i = 0; i < slots.length; ++i) {
                    if (slots[i] + components <= 4) {
                        slot = i;
                        offset = slots[i];
                        slots[i] += components;
                        break;
                    }
                }
                if (slot < 0) { slots.push(components); slot = slots.length - 1; }
            }
            const entry = { name, components, slot, offset, ...(extra || {}) };
            entries.push(entry);
            return entry;
        };

        const layout = { entries, color: null, secondary: null, backColor: null,
                         backSecondary: null, fog: null, texCoord: [],
                         clip: -1, pointCoord: -1, lineDistance: -1 };

        if (sig.glslInterface) {
            const names = { gl_Color: "color", gl_Color__back: "backColor",
                gl_SecondaryColor: "secondary", gl_SecondaryColor__back: "backSecondary", gl_FogFragCoord: "fog" };
            for (const item of sig.glslInterface.entries) {
                const entry = { ...item };
                entries.push(entry);
                if (entry.name === "gl_TexCoord") layout.texCoord[entry.index] = entry;
                else if (names[entry.name]) layout[names[entry.name]] = entry;
            }
            layout.clip = sig.glslInterface.clip;
            layout.pointCoord = sig.glslInterface.pointCoord;
            layout.slotIndices = [...new Set(entries.map(e => e.slot))].sort((a, b) => a - b);
            layout.packedSlots = layout.slotIndices.length;
            layout.slotCount = Math.max(-1, ...layout.slotIndices, layout.clip, layout.pointCoord) + 1;
            return layout;
        }

        if (sig.varyingInterface === "arb") {
            const fixed = (name, components, slot, extra) => {
                const entry = { name, components, slot, offset: 0,
                                ...(extra || {}) };
                entries.push(entry);
                if (slots.indexOf(slot) < 0) slots.push(slot);
                return entry;
            };
            layout.color = fixed("color", 4, 0, { flat: sig.flatShading });
            if (sig.arbFragment || sig.colorSum || sig.lighting.enabled && sig.lighting.separateSpecular)
                layout.secondary = fixed("secondary", 3, 1,
                    { flat: sig.flatShading });
            for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
                if (!sig.texture[i].enabled) {
                    layout.texCoord.push(null);
                    continue;
                }
                layout.texCoord.push(fixed("texCoord" + i,
                    textureCoordComponents(sig.texture[i]), 3 + i));
            }
            if (sig.fog.enabled || sig.arbFragment) layout.fog = fixed("fog", 1, 2);
            slots.sort((a, b) => a - b);
            layout.slotIndices = slots;
            layout.packedSlots = slots.length;
            layout.slotCount = slots.length ? slots[slots.length - 1] + 1 : 0;
            if (layout.slotCount > translator.MAX_INTER_STAGE_SLOTS)
                throw new Error("fixed-function ARB interface needs location " +
                    (layout.slotCount - 1) + "; only " +
                    translator.MAX_INTER_STAGE_SLOTS + " slots are available");
            return layout;
        }

        layout.color = place("color", 4, { flat: sig.flatShading });
        // the secondary colour: lighting's separate specular, or with
        // COLOR_SUM unlit the vertex's own (GL 2.1 section 3.9; review S2-11)
        if (sig.colorSum || sig.lighting.enabled && sig.lighting.separateSpecular)
            layout.secondary = place("secondary", 3, { flat: sig.flatShading });
        if (sig.lighting.enabled && sig.lighting.twoSide) {
            layout.backColor = place("backColor", 4, { flat: sig.flatShading });
            if (sig.lighting.separateSpecular)
                layout.backSecondary = place("backSecondary", 3,
                    { flat: sig.flatShading });
        }
        for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
            if (!sig.texture[i].enabled) { layout.texCoord.push(null); continue; }
            layout.texCoord.push(place("texCoord" + i,
                textureCoordComponents(sig.texture[i])));
        }
        if (sig.fog.enabled) layout.fog = place("fog", 1);

        let next = slots.length;
        if (sig.clipPlaneCount) layout.clip = next++;
        if (sig.pointSprite) layout.pointCoord = next++;
        if (sig.lineStipple) layout.lineDistance = next++;
        layout.slotCount = next;
        layout.packedSlots = slots.length;
        layout.slotIndices = Array.from({ length: slots.length },
            (unused, i) => i);
        if (next > translator.MAX_INTER_STAGE_SLOTS)
            throw new Error("fixed-function signature needs " + next +
                " varying slots; only " + translator.MAX_INTER_STAGE_SLOTS +
                " are available");
        return layout;
    }

    /*
     * The coordinates a unit's varying carries: the ones its target reads
     * and q, which the fragment stage divides by after interpolation (GL's
     * projective lookup; review S2-12: q was dropped). A cube map ignores q.
     * (s, q) for 1D, (s, t, q) for 2D, (s, t, r, q) for 3D and shadows.
     */
    function textureCoordComponents(unit) {
        if (unit.shadow) return 4;
        switch (unit.target) {
        case "1D": return 2;
        case "3D": return 4;
        case "Cube": return 3;
        default: return 3;
        }
    }

    // The vertex stage's vec4 coordinates as the varying carries them
    function packedTexCoord(unit, tc) {
        if (unit.shadow) return tc;
        switch (unit.target) {
        case "1D": return "vec2<f32>(" + tc + ".x, " + tc + ".w)";
        case "3D": return tc;
        case "Cube": return tc + ".xyz";
        default: return "vec3<f32>(" + tc + ".xy, " + tc + ".w)";
        }
    }

    const SWIZZLE = "xyzw";
    function swz(offset, count) { return SWIZZLE.slice(offset, offset + count); }

    /* ================================================================== */
    /* Vertex shader                                                      */
    /* ================================================================== */

    function generateVertex(sig, layout, fields) {
        const L = [];
        const emit = line => L.push(line);
        const lighting = sig.lighting;

        emit("// generated by gl_fixed_function.js r" + FIXED_FUNCTION_REVISION +
            " (vertex)");
        emit("");
        emit(stateLayout.buildLayout([...fields]).structText);
        emit("@group(1) @binding(0) var<uniform> glState : GLState;");
        emit("");

        emit("struct VSIn {");
        emit("    @location(" + ATTR.gl_Vertex + ") position : vec4<f32>,");
        if (sig.attributes.normal)
            emit("    @location(" + ATTR.gl_Normal + ") normal : vec3<f32>,");
        if (sig.attributes.color)
            emit("    @location(" + ATTR.gl_Color + ") color : vec4<f32>,");
        if (sig.attributes.secondaryColor)
            emit("    @location(" + ATTR.gl_SecondaryColor + ") secondary : vec4<f32>,");
        if (sig.attributes.fogCoord)
            emit("    @location(" + ATTR.gl_FogCoord + ") fogCoord : f32,");
        for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
            const a = sig.attributes.texCoord[i];
            if (!a) continue;
            emit("    @location(" + (ATTR.gl_MultiTexCoord0 + i) + ") texCoord" + i +
                " : " + vecType(a.components) + ",");
        }
        if (sig.pointSprite)
            emit("    @location(" + POINT_CORNER_LOCATION + ") corner : vec2<f32>,");
        if (sig.depthOffset)
            emit("    @location(" + DEPTH_OFFSET_LOCATION + ") depthOffset : f32,");
        if (sig.wideLine || sig.lineStipple)
            emit("    @location(" + LINE_ATTRIBUTE_LOCATION + ") lineAttr : vec3<f32>,");
        emit("}");
        emit("");

        emit("struct VSOut {");
        emit("    @invariant @builtin(position) position : vec4<f32>,");
        for (const i of layout.slotIndices) {
            const flat = layout.entries.some(e => e.slot === i && e.flat);
            emit("    " + (flat ? "@interpolate(flat) " : "") +
                "@location(" + i + ") v" + i + " : vec4<f32>,");
        }
        if (layout.clip >= 0)
            emit("    @location(" + layout.clip + ") clipDist : vec4<f32>,");
        if (layout.pointCoord >= 0)
            emit("    @location(" + layout.pointCoord + ") pointCoord : vec2<f32>,");
        if (layout.lineDistance >= 0)
            emit("    @location(" + layout.lineDistance + ") @interpolate(linear) lineDistance : f32,");
        emit("}");
        emit("");

        emit("@vertex");
        emit("fn vs_main(vin : VSIn) -> VSOut {");
        emit("    var out : VSOut;");
        emit("    let objectPos = vin.position;");
        emit("    var clip = glState.mvp * objectPos;");

        const needsEye = fields.has("modelview");
        if (needsEye) emit("    let eyePos = (glState.modelview * objectPos).xyz;");

        if (sig.attributes.normal && fields.has("normalMatrix")) {
            emit("    var eyeNormal = glState.normalMatrix * vin.normal;");
            if (lighting.normalMode === "normalize")
                emit("    eyeNormal = normalize(eyeNormal);");
            else if (lighting.normalMode === "rescale")
                // GL 2.1 section 2.11.3: the factor is one over the length of
                // the inverse modelview's third row, which is the normal
                // matrix's third column (review S2-2: the modelview's was
                // used, off by the square of the scale). Exact for a uniform
                // scale, the condition the extension documents.
                emit("    eyeNormal = eyeNormal * inverseSqrt(max(dot(" +
                    "glState.normalMatrix[2], glState.normalMatrix[2]), 1e-8));");
        } else if (lighting.enabled) {
            emit("    var eyeNormal = vec3<f32>(0.0, 0.0, 1.0);");
        }

        emitVertexColor(emit, sig, layout);
        emitTexCoords(emit, sig, layout);

        if (sig.fog.enabled && layout.fog) {
            const coord = sig.fog.coordSource === "coord" ?
                (sig.attributes.fogCoord ? "vin.fogCoord" : "0.0") :
                (needsEye ? "abs(eyePos.z)" : "abs(clip.z)");
            emit("    let fogCoord = " + coord + ";");
            emit("    out.v" + layout.fog.slot + "." +
                SWIZZLE[layout.fog.offset] + " = fogCoord;");
        }

        if (sig.pointSprite) {
            emit("    let ptDist = " + (needsEye ? "length(eyePos)" : "1.0") + ";");
            emit("    let ptAtten = inverseSqrt(max(glState.pointAttenuation.x + " +
                "glState.pointAttenuation.y * ptDist + " +
                "glState.pointAttenuation.z * ptDist * ptDist, 1e-8));");
            emit("    let ptSize = clamp(glState.pointParams.x * ptAtten, " +
                "glState.pointParams.y, glState.pointParams.z);");
            emit("    clip.x = clip.x + vin.corner.x * ptSize * clip.w / " +
                "glState.viewportParams.z;");
            emit("    clip.y = clip.y + vin.corner.y * ptSize * clip.w / " +
                "glState.viewportParams.w;");
            emit("    out.pointCoord = vec2<f32>(vin.corner.x * 0.5 + 0.5, " +
                (sig.pointCoordLowerLeft ?
                    "vin.corner.y * 0.5 + 0.5);" :
                    "0.5 - vin.corner.y * 0.5);"));
        }

        if (sig.wideLine) {
            // a wide line's quad: the corner's offset from the line, in pixels
            emit("    clip.x = clip.x + vin.lineAttr.x * 2.0 * clip.w / glState.viewportParams.z;");
            emit("    clip.y = clip.y + vin.lineAttr.y * 2.0 * clip.w / glState.viewportParams.w;");
        }
        if (sig.lineStipple) emit("    out.lineDistance = vin.lineAttr.z;");

        if (sig.clipPlaneCount) {
            const parts = [];
            for (let i = 0; i < 4; ++i) {
                if (i < sig.clipPlaneCount && needsEye)
                    parts.push("dot(vec4<f32>(eyePos, 1.0), glState.clipPlanes[" +
                        i + "])");
                else parts.push("1.0");
            }
            emit("    out.clipDist = vec4<f32>(" + parts.join(", ") + ");");
        }

        // GL clip space is z in [-w, w] and its framebuffer origin is at the
        // bottom; WebGPU wants [0, w] and a top origin. Doing the flip here --
        // once, in clip space -- is what lets viewport, scissor, readback and
        // render-to-texture skip a conversion each (plan 4.3).
        emit("    clip.z = (clip.z + clip.w) * 0.5;");
        // glPolygonOffset for a polygon drawn as lines or points, in units of
        // the depth range (WebGPU's depth bias is for triangles only)
        if (sig.depthOffset) emit("    clip.z = clip.z + vin.depthOffset * clip.w;");
        emit("    clip.y = -clip.y;");
        emit("    out.position = clip;");
        emit("    return out;");
        emit("}");
        return L.join("\n") + "\n";
    }

    function vecType(components) {
        return components === 1 ? "f32" : "vec" + components + "<f32>";
    }

    function emitVertexColor(emit, sig, layout) {
        const lighting = sig.lighting;
        const primary = sig.attributes.color ? "vin.color" : "vec4<f32>(1.0)";

        // Vertex colours are clamped to [0, 1] before they are interpolated
        // (GL 2.1 section 2.14.6; review S2-17)
        if (!lighting.enabled) {
            writeVarying(emit, layout.color, "saturate(" + primary + ")", 4);
            writeVarying(emit, layout.backColor, "saturate(" + primary + ")", 4);
            if (layout.secondary) {
                const s = sig.attributes.secondaryColor ?
                    "saturate(vin.secondary.xyz)" : "vec3<f32>(0.0)";
                writeVarying(emit, layout.secondary, s, 3);
                writeVarying(emit, layout.backSecondary, s, 3);
            }
            return;
        }

        emit("    let vertexColor = " + primary + ";");
        emitLightingFace(emit, sig, layout, false);
        if (lighting.twoSide) emitLightingFace(emit, sig, layout, true);
        else {
            writeVarying(emit, layout.backColor, readVarying(layout.color, "out"), 4);
            if (layout.secondary) writeVarying(emit, layout.backSecondary, readVarying(layout.secondary, "out"), layout.secondary.components);
        }
    }

    /*
     * GL 1.5 section 2.14.1, verbatim:
     *
     *   c = e_cm + a_cm * a_cs
     *       + sum_i att_i * spot_i * ( a_cm*a_cli
     *                                + (n . VP_pli) * d_cm*d_cli
     *                                + f * (n . h_i)^srm * s_cm*s_cli )
     *
     * with f = 1 when n . VP_pli is positive and 0 otherwise. The scene colour
     * (e_cm + a_cm*a_cs) arrives precomputed in glState.frontSceneColor,
     * because it depends only on state the CPU already has.
     */
    function emitLightingFace(emit, sig, layout, back) {
        const lighting = sig.lighting;
        const prefix = back ? "back" : "front";
        const material = back ? "glState.backMaterial" : "glState.frontMaterial";
        const scene = back ? "glState.backSceneColor" : "glState.frontSceneColor";
        const normal = back ? "(-eyeNormal)" : "eyeNormal";

        const cm = lighting.colorMaterial;
        const applies = !cm.enabled ? false :
            (cm.face === "FRONT_AND_BACK" ||
             (back ? cm.face === "BACK" : cm.face === "FRONT"));
        const track = property => {
            if (!applies) return material + "." + property;
            switch (cm.mode) {
            case "EMISSION": return property === "emission" ?
                "vertexColor" : material + "." + property;
            case "AMBIENT": return property === "ambient" ?
                "vertexColor" : material + "." + property;
            case "DIFFUSE": return property === "diffuse" ?
                "vertexColor" : material + "." + property;
            case "SPECULAR": return property === "specular" ?
                "vertexColor" : material + "." + property;
            case "AMBIENT_AND_DIFFUSE":
                return (property === "ambient" || property === "diffuse") ?
                    "vertexColor" : material + "." + property;
            default: return material + "." + property;
            }
        };

        emit("    var " + prefix + "Color = vec3<f32>(0.0);");
        emit("    var " + prefix + "Spec = vec3<f32>(0.0);");
        if (applies && (cm.mode === "EMISSION" || cm.mode === "AMBIENT" ||
                cm.mode === "AMBIENT_AND_DIFFUSE")) {
            // The scene colour depends on the tracked property, so it has to
            // be recomputed here rather than taken from the uniform.
            emit("    " + prefix + "Color = " + track("emission") + ".rgb + " +
                track("ambient") + ".rgb * glState.lightModelAmbient.rgb;");
        } else {
            emit("    " + prefix + "Color = " + scene + ".rgb;");
        }

        for (let i = 0; i < MAX_LIGHTS; ++i) {
            const light = lighting.lights[i];
            if (!light.enabled) continue;
            const l = "glState.lights[" + i + "]";
            emit("    {");
            if (light.positional) {
                emit("        let toLight = " + l + ".position.xyz - eyePos;");
                emit("        let dist = length(toLight);");
                emit("        let VP = toLight / max(dist, 1e-8);");
                emit("        var atten = 1.0 / max(" + l +
                    ".constantAttenuation + " + l + ".linearAttenuation * dist + " +
                    l + ".quadraticAttenuation * dist * dist, 1e-8);");
            } else {
                emit("        let VP = normalize(" + l + ".position.xyz);");
                emit("        var atten = 1.0;");
            }
            if (light.spot) {
                emit("        let spotDot = dot(-VP, normalize(" + l +
                    ".spotDirection));");
                emit("        if (spotDot < " + l + ".spotCosCutoff) {");
                emit("            atten = 0.0;");
                emit("        } else {");
                emit("            atten = atten * pow(max(spotDot, 1e-8), " + l +
                    ".spotExponent);");
                emit("        }");
            }
            emit("        let nDotVP = dot(" + normal + ", VP);");
            emit("        " + prefix + "Color = " + prefix + "Color + atten * (" +
                track("ambient") + ".rgb * " + l + ".ambient.rgb");
            emit("            + max(nDotVP, 0.0) * " + track("diffuse") +
                ".rgb * " + l + ".diffuse.rgb);");
            emit("        if (nDotVP > 0.0) {");
            if (lighting.localViewer)
                emit("            let halfVec = normalize(VP + normalize(-eyePos));");
            else
                emit("            let halfVec = normalize(VP + vec3<f32>(0.0, 0.0, 1.0));");
            emit("            let nDotH = max(dot(" + normal + ", halfVec), 0.0);");
            emit("            let shine = pow(nDotH, max(" + material +
                ".shininess, 1e-4));");
            emit("            " + prefix + "Spec = " + prefix + "Spec + atten * " +
                "shine * " + track("specular") + ".rgb * " + l + ".specular.rgb;");
            emit("        }");
            emit("    }");
        }

        const alpha = "saturate(" + track("diffuse") + ".a)";
        const target = back ? layout.backColor : layout.color;
        const specTarget = back ? layout.backSecondary : layout.secondary;
        // (lit without a separate specular, the secondary colour is zero)
        if (specTarget && !lighting.separateSpecular) writeVarying(emit, specTarget, "vec3<f32>(0.0)", 3);
        if (lighting.separateSpecular && specTarget) {
            writeVarying(emit, target, "vec4<f32>(clamp(" + prefix +
                "Color, vec3<f32>(0.0), vec3<f32>(1.0)), " + alpha + ")", 4);
            writeVarying(emit, specTarget, "clamp(" + prefix +
                "Spec, vec3<f32>(0.0), vec3<f32>(1.0))", 3);
        } else {
            writeVarying(emit, target, "vec4<f32>(clamp(" + prefix + "Color + " +
                prefix + "Spec, vec3<f32>(0.0), vec3<f32>(1.0)), " + alpha + ")", 4);
        }
    }

    function writeVarying(emit, entry, expr, components) {
        if (!entry) return;
        if (entry.offset === 0 && entry.components === 4 && components === 4) {
            emit("    out.v" + entry.slot + " = " + expr + ";");
            return;
        }
        const tmp = "_v" + entry.slot + "_" + entry.offset;
        emit("    let " + tmp + " = " + expr + ";");
        for (let i = 0; i < entry.components; ++i) {
            const src = i >= components ? "1.0" : entry.components === 1 && components === 1 ?
                tmp : tmp + "." + SWIZZLE[i];
            emit("    out.v" + entry.slot + "." + SWIZZLE[entry.offset + i] +
                " = " + src + ";");
        }
    }

    /*
     * Texture coordinate generation. GL applies texgen per coordinate (S, T,
     * R, Q independently), then the texture matrix, then the projective divide
     * if the shader asked for one -- and a unit may mix generated and supplied
     * coordinates, which is why each of the four is built separately rather
     * than as one vector expression.
     */
    function emitTexCoords(emit, sig, layout) {
        for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
            const unit = sig.texture[i];
            const entry = layout.texCoord[i];
            if (!unit.enabled || !entry) continue;
            const supplied = sig.attributes.texCoord[i];
            const parts = [];
            const gen = unit.texGen || [];
            const anyGen = gen.some(m => !!m);

            if (!anyGen) {
                if (supplied) {
                    const c = supplied.components;
                    parts.push(c === 1 ? "vec4<f32>(vin.texCoord" + i + ", 0.0, 0.0, 1.0)" :
                        c === 2 ? "vec4<f32>(vin.texCoord" + i + ", 0.0, 1.0)" :
                        c === 3 ? "vec4<f32>(vin.texCoord" + i + ", 1.0)" :
                        "vin.texCoord" + i);
                } else {
                    parts.push("vec4<f32>(0.0, 0.0, 0.0, 1.0)");
                }
                emit("    var tc" + i + " = " + parts[0] + ";");
            } else {
                emit("    var tc" + i + " = vec4<f32>(0.0, 0.0, 0.0, 1.0);");
                const suppliedComponent = c => {
                    if (!supplied) return c === 3 ? "1.0" : "0.0";
                    if (supplied.components === 1)
                        return c === 0 ? "vin.texCoord" + i :
                            (c === 3 ? "1.0" : "0.0");
                    return c < supplied.components ?
                        "vin.texCoord" + i + "." + SWIZZLE[c] :
                        (c === 3 ? "1.0" : "0.0");
                };
                let sphereEmitted = false;
                let reflectEmitted = false;
                for (let c = 0; c < 4; ++c) {
                    const mode = gen[c];
                    if (!mode) {
                        emit("    tc" + i + "." + SWIZZLE[c] + " = " +
                            suppliedComponent(c) + ";");
                        continue;
                    }
                    switch (mode) {
                    case "OBJECT":
                        emit("    tc" + i + "." + SWIZZLE[c] +
                            " = dot(objectPos, glState.texGenPlanes[" +
                            (i * 8 + c) + "]);");
                        break;
                    case "EYE":
                        // The eye plane is stored already multiplied by the
                        // inverse modelview at glTexGen time, so the shader
                        // dots it with the eye position directly -- the same
                        // thing desktop GL does when the plane is specified.
                        emit("    tc" + i + "." + SWIZZLE[c] +
                            " = dot(vec4<f32>(eyePos, 1.0), glState.texGenPlanes[" +
                            (i * 8 + 4 + c) + "]);");
                        break;
                    case "SPHERE":
                        if (!sphereEmitted) {
                            sphereEmitted = true;
                            emit("    let sphereR" + i +
                                " = reflect(normalize(eyePos), eyeNormal);");
                            emit("    let sphereM" + i + " = 2.0 * sqrt(" +
                                "sphereR" + i + ".x * sphereR" + i + ".x + " +
                                "sphereR" + i + ".y * sphereR" + i + ".y + " +
                                "(sphereR" + i + ".z + 1.0) * (sphereR" + i +
                                ".z + 1.0));");
                        }
                        emit("    tc" + i + "." + SWIZZLE[c] + " = sphereR" + i +
                            "." + SWIZZLE[c] + " / max(sphereM" + i +
                            ", 1e-8) + 0.5;");
                        break;
                    case "REFLECTION":
                        if (!reflectEmitted) {
                            reflectEmitted = true;
                            emit("    let reflectV" + i +
                                " = reflect(normalize(eyePos), eyeNormal);");
                        }
                        emit("    tc" + i + "." + SWIZZLE[c] + " = reflectV" + i +
                            "." + SWIZZLE[c] + ";");
                        break;
                    case "NORMAL":
                        emit("    tc" + i + "." + SWIZZLE[c] + " = eyeNormal." +
                            SWIZZLE[c] + ";");
                        break;
                    default:
                        throw new Error("unknown texgen mode " + mode);
                    }
                }
            }

            if (unit.matrix)
                emit("    tc" + i + " = glState.textureMatrix[" + i + "] * tc" + i + ";");

            writeVarying(emit, entry, sig.glslInterface ? "tc" + i : packedTexCoord(unit, "tc" + i), entry.components);
        }
    }

    /* ================================================================== */
    /* Fragment shader                                                    */
    /* ================================================================== */

    function generateFragment(sig, layout, fields) {
        const L = [];
        const emit = line => L.push(line);

        emit("// generated by gl_fixed_function.js r" + FIXED_FUNCTION_REVISION +
            " (fragment)");
        emit("");
        emit(stateLayout.buildLayout([...fields]).structText);
        emit("@group(1) @binding(0) var<uniform> glState : GLState;");
        emit("");

        let binding = sig.textureBindingBase;
        const bindings = [];
        for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
            const unit = sig.texture[i];
            if (!unit.enabled) { bindings.push(null); continue; }
            bindings.push({ texture: binding, sampler: binding + 1 });
            emit("@group(2) @binding(" + binding + ") var t" + i + " : " +
                textureTypeFor(unit) + ";");
            emit("@group(2) @binding(" + (binding + 1) + ") var s" + i + " : " +
                (unit.shadow ? "sampler_comparison" : "sampler") + ";");
            binding += 2;
        }
        if (binding) emit("");

        if (sig.logicOp && sig.logicOp !== 0x1503)
            emitLogicOpDeclarations(emit, sig.logicOp, sig.colorTargets);

        emit("struct FSIn {");
        emit("    @builtin(position) position : vec4<f32>,");
        if ((sig.twoSidedColors || sig.lighting.enabled && sig.lighting.twoSide) && !sig.backFacing)
            emit("    @builtin(front_facing) frontFacing : bool,");
        for (const i of layout.slotIndices) {
            const flat = layout.entries.some(e => e.slot === i && e.flat);
            emit("    " + (flat ? "@interpolate(flat) " : "") +
                "@location(" + i + ") v" + i + " : vec4<f32>,");
        }
        if (layout.clip >= 0)
            emit("    @location(" + layout.clip + ") clipDist : vec4<f32>,");
        if (layout.pointCoord >= 0)
            emit("    @location(" + layout.pointCoord + ") pointCoord : vec2<f32>,");
        if (layout.lineDistance >= 0)
            emit("    @location(" + layout.lineDistance + ") @interpolate(linear) lineDistance : f32,");
        emit("}");
        emit("");

        emit("struct FSOut {");
        for (let i = 0; i < sig.colorTargets; ++i)
            emit("    @location(" + i + ") color" + i + " : vec4<f32>,");
        emit("}");
        emit("");

        if (sig.desktopSampling) {
            const types = new Map();
            for (const unit of sig.texture) if (unit.enabled) {
                const dim = unit.target === "Cube" ? "Cube" : unit.target === "3D" ? "3D" : "2D";
                types.set("gl_fixed_sample_" + dim + (unit.shadow ? "_shadow" : ""), { dim, shadow: unit.shadow });
            }
            for (const [name, type] of types) emit(stateLayout.textureSamplingWGSL(name, type.dim, type.shadow, "fragment"));
        }
        emit("@fragment");
        emit("fn fs_main(fin : FSIn) -> FSOut {");
        if (layout.clip >= 0)
            emit("    if (any(fin.clipDist < vec4<f32>(0.0))) { discard; }");
        if (sig.polygonStipple) emitPolygonStippleTest(emit, "fin.position");
        if (sig.lineStipple) {
            // GL 2.1 section 3.4.3: bit floor(s / factor) mod 16 of the pattern
            emit("    let stippleBit = u32(floor(fin.lineDistance / glState.rasterParams.z)) % 16u;");
            emit("    if (((u32(glState.rasterParams.y) >> stippleBit) & 1u) == 0u) { discard; }");
        }

        const colorRead = readVarying(layout.color);
        // a polygon's lines and points are not faces to WebGPU: the executor
        // says which side they came from
        const facing = sig.backFacing ? "false" : "fin.frontFacing";
        if ((sig.twoSidedColors || sig.lighting.enabled && sig.lighting.twoSide) && layout.backColor)
            emit("    let primary = select(" + readVarying(layout.backColor) +
                ", " + colorRead + ", " + facing + ");");
        else
            emit("    let primary = " + colorRead + ";");
        emit("    var frag = primary;");

        // Sample every enabled unit up front: GL_COMBINE's crossbar sources let
        // stage 3 read stage 0's texture, so the samples cannot be produced
        // lazily as the chain is walked.
        for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
            const unit = sig.texture[i];
            if (!unit.enabled) continue;
            const sample = sampleExpression(i, unit, layout.texCoord[i], sig);
            emit("    let tex" + i + " = " + (sig.desktopSampling ? sample : borderedSample(i, unit, sample,
                textureCoordinates(unit, layout.texCoord[i], sig))) + ";");
        }

        for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
            const unit = sig.texture[i];
            if (!unit.enabled || readsDisabledUnit(sig, unit)) continue;
            emitTextureEnv(emit, sig, i, unit);
        }

        if (layout.secondary) {
            const rgb = entry => readVarying({ ...entry, components: 3 });
            const secondary = ((sig.twoSidedColors || sig.lighting.twoSide) && layout.backSecondary) ?
                "select(" + rgb(layout.backSecondary) + ", " + rgb(layout.secondary) + ", " + facing + ")" : rgb(layout.secondary);
            emit("    frag = vec4<f32>(clamp(frag.rgb + " + secondary +
                ", vec3<f32>(0.0), vec3<f32>(1.0)), frag.a);");
        }

        if (sig.fog.enabled && layout.fog) {
            const c = readVarying(layout.fog);
            switch (sig.fog.mode) {
            case "exp":
                emit("    let fogFactor = clamp(exp(-glState.fogParams.x * " +
                    c + "), 0.0, 1.0);");
                break;
            case "exp2":
                emit("    let fogArg = glState.fogParams.x * " + c + ";");
                emit("    let fogFactor = clamp(exp(-(fogArg * fogArg)), 0.0, 1.0);");
                break;
            default:
                emit("    let fogFactor = clamp((glState.fogParams.z - " + c +
                    ") * glState.fogParams.w, 0.0, 1.0);");
                break;
            }
            emit("    frag = vec4<f32>(mix(glState.fogColor.rgb, frag.rgb, " +
                "fogFactor), frag.a);");
        }

        emitAlphaTest(emit, sig);

        emit("    var out : FSOut;");
        for (let i = 0; i < sig.colorTargets; ++i) {
            if (sig.logicOp && sig.logicOp !== 0x1503)
                emit("    out.color" + i + " = glApplyLogic(frag, " +
                    "textureLoad(glLogicTarget" + i +
                    ", vec2<i32>(floor(fin.position.xy)), 0));");
            else
                emit("    out.color" + i + " = frag;");
        }
        emit("    return out;");
        emit("}");
        return L.join("\n") + "\n";
    }

    function readVarying(entry, input = "fin") {
        if (!entry) return "vec4<f32>(1.0)";
        if (entry.offset === 0 && entry.components === 4)
            return input + ".v" + entry.slot;
        return input + ".v" + entry.slot + "." + swz(entry.offset, entry.components);
    }

    function emitPolygonStippleTest(emit, position) {
        emit("    let stippleX = u32(floor(" + position + ".x)) & 31u;");
        emit("    let stippleY = u32(floor(" + position + ".y)) & 31u;");
        emit("    let stippleByteIndex = stippleY * 4u + (stippleX >> 3u);");
        emit("    let stippleWord = glState.polygonStipple[stippleByteIndex >> 2u];");
        emit("    let stippleLane = stippleByteIndex & 3u;");
        emit("    var stippleByte = stippleWord.x;");
        emit("    if (stippleLane == 1u) { stippleByte = stippleWord.y; }");
        emit("    if (stippleLane == 2u) { stippleByte = stippleWord.z; }");
        emit("    if (stippleLane == 3u) { stippleByte = stippleWord.w; }");
        emit("    let stippleBit = 0x80u >> (stippleX & 7u);");
        emit("    if ((u32(stippleByte) & stippleBit) == 0u) { discard; }");
    }

    function logicOpExpression(op) {
        switch (op >>> 0) {
        case 0x1500: return "vec4<u32>(0u)";       // GL_CLEAR
        case 0x1501: return "s & d";
        case 0x1502: return "s & ~d";
        case 0x1503: return "s";
        case 0x1504: return "~s & d";
        case 0x1505: return "d";
        case 0x1506: return "s ^ d";
        case 0x1507: return "s | d";
        case 0x1508: return "~(s | d)";
        case 0x1509: return "~(s ^ d)";
        case 0x150A: return "~d";
        case 0x150B: return "s | ~d";
        case 0x150C: return "~s";
        case 0x150D: return "~s | d";
        case 0x150E: return "~(s & d)";
        case 0x150F: return "vec4<u32>(255u)";    // GL_SET
        default: return "s";
        }
    }

    function emitLogicOpDeclarations(emit, op, colorTargets) {
        for (let i = 0; i < colorTargets; ++i)
            emit("@group(3) @binding(" + i + ") var glLogicTarget" + i +
                " : texture_2d<f32>;");
        emit("fn glApplyLogic(src : vec4<f32>, dst : vec4<f32>) -> vec4<f32> {");
        emit("    let s = vec4<u32>(round(clamp(src, vec4<f32>(0.0), " +
            "vec4<f32>(1.0)) * 255.0));");
        emit("    let d = vec4<u32>(round(clamp(dst, vec4<f32>(0.0), " +
            "vec4<f32>(1.0)) * 255.0));");
        emit("    let r = (" + logicOpExpression(op) + ") & vec4<u32>(255u);");
        emit("    return vec4<f32>(r) / 255.0;");
        emit("}");
        emit("");
    }

    function textureTypeFor(unit) {
        if (unit.shadow) return "texture_depth_2d";
        switch (unit.target) {
        case "3D": return "texture_3d<f32>";
        case "Cube": return "texture_cube<f32>";
        default: return "texture_2d<f32>";   // 1D rides on a height-1 2D
        }
    }

    /*
     * GL's border colour (review D-03): WebGPU has no border addressing, so
     * the sampler clamps to the edge and the colour is blended in by the
     * fraction of the filter's footprint outside the texture, one factor an
     * axis. For a bilinear footprint with at most one texel outside per axis
     * that is exact: mix(border, edge sample, a_s * a_t). Measured on the
     * view's first level, so the band of a minified mipmap is approximate.
     */
    function borderedSample(i, unit, sample, coordinates) {
        const border = unit.border;
        if (!border || unit.target === "Cube") return sample;
        const size = unit.target === "1D" ? "vec3<f32>(f32(textureDimensions(t" + i + ")), 1.0, 1.0)" :
            unit.target === "3D" ? "vec3<f32>(textureDimensions(t" + i + "))" :
            "vec3<f32>(vec2<f32>(textureDimensions(t" + i + ")), 1.0)";
        const factors = [];
        ["s", "t", "r"].forEach((axis, k) => {
            const mode = border[axis];
            if (!mode) return;
            const c = "(" + coordinates + ")." + "xyz"[k], n = "(" + size + ")." + "xyz"[k];
            const u = mode === "clamp" ? "clamp(" + c + ", 0.0, 1.0) * " + n : c + " * " + n;
            factors.push(border.linear ?
                "clamp(min(" + u + " + 0.5, " + n + " - " + u + " + 0.5), 0.0, 1.0)" :
                "select(0.0, 1.0, " + u + " >= 0.0 && " + u + " < " + n + ")");
        });
        let color = "glState.textureBorderColor[" + i + "]";
        if (unit.shadow) {
            // the border's depth goes through the same comparison as a texel
            const ref = "(" + coordinates + ").z";
            color = "vec4<f32>(" + compareExpression(border.compare, ref, color + ".x") + ")";
        }
        return "mix(" + color + ", " + sample + ", " + factors.join(" * ") + ")";
    }

    // A depth comparison by name (the alpha test's names)
    function compareExpression(func, ref, depth) {
        const op = { less: "<", lequal: "<=", greater: ">", gequal: ">=", equal: "==", notequal: "!=" }[func];
        if (func === "always") return "1.0";
        if (!op) return "0.0";
        return "select(0.0, 1.0, " + ref + " " + op + " " + depth + ")";
    }

    // The coordinates a lookup samples at, after the projective divide
    function textureCoordinates(unit, entry, sig) {
        const coord = textureCoordinate(unit, entry, sig);
        return "(" + coord + ").xyz / max((" + coord + ").w, 1e-8)";
    }

    // (s, t, r, q) from what the varying carries (packedTexCoord)
    function textureCoordinate(unit, entry, sig) {
        const pointCoord = sig.pointSprite && unit.env.coordReplace;
        const v = pointCoord || !entry ? null : readVarying(entry);
        if (pointCoord) return "vec4<f32>(fin.pointCoord, 0.0, 1.0)";
        if (!entry) return "vec4<f32>(0.0, 0.0, 0.0, 1.0)";
        if (unit.shadow || unit.target === "3D" || sig.glslInterface) return v;
        if (unit.target === "1D") return "vec4<f32>((" + v + ").x, 0.0, 0.0, (" + v + ").y)";
        if (unit.target === "Cube") return "vec4<f32>(" + v + ", 1.0)";
        return "vec4<f32>((" + v + ").xy, 0.0, (" + v + ").z)";
    }

    function sampleExpression(i, unit, entry, sig) {
        const coord = textureCoordinate(unit, entry, sig);
        const q = "(" + coord + ").w";
        const xy = "(" + coord + ").xy";
        const xyz = "(" + coord + ").xyz";
        if (sig.desktopSampling) {
            const dim = unit.target === "Cube" ? "Cube" : unit.target === "3D" ? "3D" : "2D",
                name = "gl_fixed_sample_" + dim + (unit.shadow ? "_shadow" : ""),
                uv = dim === "Cube" ? xyz : dim === "3D" ? xyz + " / " + q : unit.target === "1D" ?
                    "vec2<f32>((" + coord + ").x / " + q + ", 0.5)" : xy + " / " + q,
                binding = sig.textureBindingBase / 2 + sig.texture.slice(0, i).filter(unit => unit.enabled).length,
                call = name + "(t" + i + ", s" + i + ", " + uv + ", " + binding + "u, 0.0, 0.0, false" +
                    (unit.shadow ? ", (" + coord + ").z / " + q : "") + ")";
            return unit.shadow ? "vec4<f32>(" + call + ")" : call;
        }
        if (unit.shadow) {
            // A shadow lookup's reference is the third coordinate after the
            // projective divide, which is what GL's GL_COMPARE_R_TO_TEXTURE
            // means; the result replicates into all four components.
            return "vec4<f32>(textureSampleCompare(t" + i + ", s" + i + ", " +
                xy + " / max(" + q + ", 1e-8), " + xyz +
                ".z / max(" + q + ", 1e-8)))";
        }
        // GL_TEXTURE_LOD_BIAS (the texture's and the unit's, as state)
        const sample = (coordinates) => unit.lodBias ?
            "textureSampleBias(t" + i + ", s" + i + ", " + coordinates + ", glState.textureLodBias[" + (i >> 2) + "]." +
                "xyzw"[i & 3] + ")" :
            "textureSample(t" + i + ", s" + i + ", " + coordinates + ")";
        switch (unit.target) {
        case "1D":
            return sample("vec2<f32>((" + coord + ").x / max(" + q + ", 1e-8), 0.5)");
        case "3D":
            return sample(xyz + " / max(" + q + ", 1e-8)");
        case "Cube":
            return sample(xyz);
        default:
            return sample(xy + " / max(" + q + ", 1e-8)");
        }
    }

    /*
     * GL 1.5 table 3.22 (the non-COMBINE functions) and section 3.8.13
     * (GL_COMBINE).
     *
     * The base internal format matters and cannot be folded away by the
     * upload-time channel expansion alone: an ALPHA texture leaves RGB
     * untouched, and REPLACE on an RGB or LUMINANCE texture leaves alpha
     * untouched. Uploads expand L to (l,l,l,1) and A to (0,0,0,a), which makes
     * MODULATE and ADD fall out correctly, but those two rows still need
     * saying explicitly.
     */
    function emitTextureEnv(emit, sig, i, unit) {
        const env = unit.env;
        const cs = "tex" + i;
        const format = unit.format;
        const cc = "glState.texEnvColor[" + i + "]";

        if (env.mode === "COMBINE") {
            emitCombine(emit, sig, i, unit);
            return;
        }

        const rgbOnlyFormats = format === "RGB" || format === "LUMINANCE";
        switch (env.mode) {
        case "REPLACE":
            if (format === "ALPHA")
                emit("    frag = vec4<f32>(frag.rgb, " + cs + ".a);");
            else if (rgbOnlyFormats)
                emit("    frag = vec4<f32>(" + cs + ".rgb, frag.a);");
            else
                emit("    frag = " + cs + ";");
            break;
        case "MODULATE":
            if (format === "ALPHA")
                emit("    frag = vec4<f32>(frag.rgb, frag.a * " + cs + ".a);");
            else
                emit("    frag = frag * " + cs + ";");
            break;
        case "DECAL":
            if (format === "RGB")
                emit("    frag = vec4<f32>(" + cs + ".rgb, frag.a);");
            else if (format === "RGBA")
                emit("    frag = vec4<f32>(mix(frag.rgb, " + cs + ".rgb, " +
                    cs + ".a), frag.a);");
            else
                // GL leaves DECAL undefined for the other base formats; the
                // least surprising reading is to pass the fragment through.
                emit("    // GL_DECAL is undefined for a " + format +
                    " texture; the fragment is unchanged");
            break;
        case "BLEND":
            if (format === "ALPHA")
                emit("    frag = vec4<f32>(frag.rgb, frag.a * " + cs + ".a);");
            else if (format === "INTENSITY")
                emit("    frag = vec4<f32>(mix(frag.rgb, " + cc + ".rgb, " +
                    cs + ".rgb), mix(frag.a, " + cc + ".a, " + cs + ".a));");
            else if (rgbOnlyFormats)
                emit("    frag = vec4<f32>(mix(frag.rgb, " + cc + ".rgb, " +
                    cs + ".rgb), frag.a);");
            else
                emit("    frag = vec4<f32>(mix(frag.rgb, " + cc + ".rgb, " +
                    cs + ".rgb), frag.a * " + cs + ".a);");
            break;
        case "ADD":
            if (format === "ALPHA")
                emit("    frag = vec4<f32>(frag.rgb, frag.a * " + cs + ".a);");
            else if (format === "INTENSITY")
                emit("    frag = clamp(frag + " + cs +
                    ", vec4<f32>(0.0), vec4<f32>(1.0));");
            else if (rgbOnlyFormats)
                emit("    frag = vec4<f32>(clamp(frag.rgb + " + cs +
                    ".rgb, vec3<f32>(0.0), vec3<f32>(1.0)), frag.a);");
            else
                emit("    frag = vec4<f32>(clamp(frag.rgb + " + cs +
                    ".rgb, vec3<f32>(0.0), vec3<f32>(1.0)), frag.a * " +
                    cs + ".a);");
            break;
        default:
            throw new Error("unknown texture environment mode " + env.mode);
        }
    }

    /*
     * ARB_texture_env_crossbar: a unit whose combiner reads the texture of a
     * unit that is disabled is as though its blending were disabled -- it
     * passes the previous colour on (review S1-2g: the WGSL named a texture
     * that was never declared). Only the sources its functions use count.
     */
    function readsDisabledUnit(sig, unit) {
        const env = unit.env;
        if (env.mode !== "COMBINE") return false;
        const used = fn => fn === "REPLACE" ? 1 : fn === "INTERPOLATE" ? 3 : 2;
        const sources = [...env.srcRGB.slice(0, used(env.combineRGB)), ...env.srcAlpha.slice(0, used(env.combineAlpha))];
        return sources.some(source => {
            const crossbar = /^TEXTURE(\d)$/.exec(source);
            return crossbar && !sig.texture[+crossbar[1]].enabled;
        });
    }

    function combineSource(source, unitIndex) {
        if (source === "TEXTURE") return "tex" + unitIndex;
        const crossbar = /^TEXTURE(\d)$/.exec(source);
        if (crossbar) return "tex" + crossbar[1];
        if (source === "CONSTANT") return "glState.texEnvColor[" + unitIndex + "]";
        if (source === "PRIMARY_COLOR") return "primary";
        if (source === "PREVIOUS") return "frag";
        throw new Error("unknown GL_COMBINE source " + source);
    }

    function combineArgRGB(source, operand, unitIndex) {
        const v = combineSource(source, unitIndex);
        switch (operand) {
        case "SRC_COLOR": return "(" + v + ").rgb";
        case "ONE_MINUS_SRC_COLOR": return "(vec3<f32>(1.0) - (" + v + ").rgb)";
        case "SRC_ALPHA": return "vec3<f32>((" + v + ").a)";
        case "ONE_MINUS_SRC_ALPHA": return "vec3<f32>(1.0 - (" + v + ").a)";
        default: throw new Error("unknown RGB operand " + operand);
        }
    }

    function combineArgAlpha(source, operand, unitIndex) {
        const v = combineSource(source, unitIndex);
        switch (operand) {
        case "SRC_ALPHA": return "(" + v + ").a";
        case "ONE_MINUS_SRC_ALPHA": return "(1.0 - (" + v + ").a)";
        default: throw new Error("unknown alpha operand " + operand);
        }
    }

    function emitCombine(emit, sig, i, unit) {
        const env = unit.env;
        void sig;
        const r = [0, 1, 2].map(n =>
            combineArgRGB(env.srcRGB[n], env.operandRGB[n], i));
        const a = [0, 1, 2].map(n =>
            combineArgAlpha(env.srcAlpha[n], env.operandAlpha[n], i));

        emit("    {");
        let rgbExpr;
        let dot3Alpha = null;
        switch (env.combineRGB) {
        case "REPLACE": rgbExpr = r[0]; break;
        case "MODULATE": rgbExpr = "(" + r[0] + " * " + r[1] + ")"; break;
        case "ADD": rgbExpr = "(" + r[0] + " + " + r[1] + ")"; break;
        case "ADD_SIGNED":
            rgbExpr = "(" + r[0] + " + " + r[1] + " - vec3<f32>(0.5))";
            break;
        case "INTERPOLATE":
            rgbExpr = "mix(" + r[1] + ", " + r[0] + ", " + r[2] + ")";
            break;
        case "SUBTRACT": rgbExpr = "(" + r[0] + " - " + r[1] + ")"; break;
        case "DOT3_RGB":
        case "DOT3_RGBA":
            // 4 * dot(A0 - 0.5, A1 - 0.5), replicated. DOT3_RGBA drives alpha
            // from the same dot product, which is what makes it different from
            // DOT3_RGB rather than a naming variant.
            emit("        let dot3 = clamp(4.0 * dot(" + r[0] +
                " - vec3<f32>(0.5), " + r[1] + " - vec3<f32>(0.5)), 0.0, 1.0);");
            rgbExpr = "vec3<f32>(dot3)";
            if (env.combineRGB === "DOT3_RGBA") dot3Alpha = "dot3";
            break;
        default:
            throw new Error("unknown GL_COMBINE_RGB " + env.combineRGB);
        }

        let alphaExpr;
        if (dot3Alpha) {
            alphaExpr = dot3Alpha;
        } else {
            switch (env.combineAlpha) {
            case "REPLACE": alphaExpr = a[0]; break;
            case "MODULATE": alphaExpr = "(" + a[0] + " * " + a[1] + ")"; break;
            case "ADD": alphaExpr = "(" + a[0] + " + " + a[1] + ")"; break;
            case "ADD_SIGNED":
                alphaExpr = "(" + a[0] + " + " + a[1] + " - 0.5)";
                break;
            case "INTERPOLATE":
                alphaExpr = "mix(" + a[1] + ", " + a[0] + ", " + a[2] + ")";
                break;
            case "SUBTRACT": alphaExpr = "(" + a[0] + " - " + a[1] + ")"; break;
            default:
                throw new Error("unknown GL_COMBINE_ALPHA " + env.combineAlpha);
            }
        }

        const rgbScale = env.rgbScale === 1 ? "" : " * " + env.rgbScale + ".0";
        const alphaScale = dot3Alpha || env.alphaScale === 1 ?
            "" : " * " + env.alphaScale + ".0";
        emit("        let combinedRGB = clamp((" + rgbExpr + ")" + rgbScale +
            ", vec3<f32>(0.0), vec3<f32>(1.0));");
        emit("        let combinedA = clamp((" + alphaExpr + ")" + alphaScale +
            ", 0.0, 1.0);");
        emit("        frag = vec4<f32>(combinedRGB, combinedA);");
        emit("    }");
    }

    const ALPHA_TEST_OPERATORS = {
        less: "<", equal: "==", lequal: "<=",
        greater: ">", notequal: "!=", gequal: ">=",
    };

    function emitAlphaTest(emit, sig) {
        if (sig.alphaTest === "always") return;
        if (sig.alphaTest === "never") { emit("    discard;"); return; }
        const op = ALPHA_TEST_OPERATORS[sig.alphaTest];
        if (!op) throw new Error("unknown alpha test " + sig.alphaTest);
        emit("    if (!(frag.a " + op + " glState.alphaRef.x)) { discard; }");
    }

    /* ================================================================== */
    /* Public API                                                         */
    /* ================================================================== */

    /*
     * Produces both stages plus everything the executor needs to build the
     * pipeline and the bind groups. The vertex layout is described here rather
     * than derived in the executor so that the shader and the buffer layout
     * cannot drift apart.
     */
    function generate(rawSignature) {
        const sig = normalizeSignature(rawSignature);
        const layout = allocateVaryings(sig);
        const fields = stateFieldsFor(sig);
        const stateInfo = stateLayout.buildLayout([...fields]);

        const attributes = [];
        attributes.push({ name: "position", location: ATTR.gl_Vertex,
                          components: sig.attributes.position.components });
        if (sig.attributes.normal)
            attributes.push({ name: "normal", location: ATTR.gl_Normal, components: 3 });
        if (sig.attributes.color)
            attributes.push({ name: "color", location: ATTR.gl_Color, components: 4 });
        if (sig.attributes.secondaryColor)
            attributes.push({ name: "secondaryColor",
                              location: ATTR.gl_SecondaryColor, components: 4 });
        if (sig.attributes.fogCoord)
            attributes.push({ name: "fogCoord", location: ATTR.gl_FogCoord,
                              components: 1 });
        for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
            const a = sig.attributes.texCoord[i];
            if (!a) continue;
            attributes.push({ name: "texCoord" + i,
                              location: ATTR.gl_MultiTexCoord0 + i,
                              components: a.components });
        }
        if (sig.pointSprite)
            attributes.push({ name: "corner", location: POINT_CORNER_LOCATION,
                              components: 2 });
        if (sig.depthOffset)
            attributes.push({ name: "depthOffset", location: DEPTH_OFFSET_LOCATION,
                              components: 1 });
        if (sig.wideLine || sig.lineStipple)
            attributes.push({ name: "lineAttr", location: LINE_ATTRIBUTE_LOCATION,
                              components: 3 });

        const textures = [];
        let binding = sig.textureBindingBase;
        for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) {
            if (!sig.texture[i].enabled) continue;
            textures.push({
                unit: i, textureBinding: binding, samplerBinding: binding + 1,
                target: sig.texture[i].target, shadow: sig.texture[i].shadow,
            });
            binding += 2;
        }

        return {
            signature: sig,
            key: signatureKeys.key([FIXED_FUNCTION_REVISION, sig]),
            wgslVertex: generateVertex(sig, layout, fields),
            wgslFragment: generateFragment(sig, layout, fields),
            stateFields: [...fields],
            stateFloats: stateInfo.floats,
            attributes, textures,
            varyingSlots: layout.slotCount,
            colorTargets: sig.colorTargets,
            usesDiscard: sig.alphaTest !== "always" || sig.clipPlaneCount > 0,
            pointSprite: sig.pointSprite,
        };
    }

    // Link the application's one programmable stage against a compatibility
    // interface, then generate the other stage with the same varying and GL
    // state layouts. The interface shaders never replace application source
    // or participate in CPU reflection.
    function linkGLSL(vertex, fragment, signature, options) {
        const programmable = vertex || fragment;
        const sig = { ...signature, extraStateFields: [...new Set([
            ...(signature.extraStateFields || []), ...programmable.usage.stateFields])],
        textureBindingBase: vertex ? programmable.usage.samplers.reduce((n, s) => n + 2 * Math.max(1, s.arraySize), 0) : 0 };
        let fixed = generate(sig);
        let source;
        if (vertex) {
            const inputs = ["gl_Color"];
            if (sig.colorSum || sig.lighting.enabled && sig.lighting.separateSpecular) inputs.push("gl_SecondaryColor");
            if (sig.fog.enabled) inputs.push("vec4(gl_FogFragCoord)");
            for (let i = 0; i < MAX_TEXTURE_UNITS; ++i) if (sig.texture[i].enabled) inputs.push("gl_TexCoord[" + i + "]");
            source = "void main(){gl_FragColor=" + inputs.join("+") + ";}";
        } else {
            const outputs = ["gl_Position=ftransform()", "gl_FrontColor=gl_Color", "gl_BackColor=gl_Color",
                "gl_FrontSecondaryColor=gl_SecondaryColor", "gl_BackSecondaryColor=gl_SecondaryColor", "gl_FogFragCoord=gl_FogCoord"];
            const count = fragment.usage.texCoordDynamic ? MAX_TEXTURE_UNITS : fragment.usage.texCoordMax + 1;
            for (let i = 0; i < count; ++i) outputs.push("gl_TexCoord[" + i + "]=gl_MultiTexCoord" + i);
            source = "void main(){" + outputs.join(";") + ";}";
        }
        const placeholder = translator.compileShader(source, vertex ? "fragment" : "vertex");
        const link = translator.linkProgram(vertex || placeholder, fragment || placeholder, {
            ...options, forceStateFields: fixed.stateFields, keepCompatInputs: true,
            variant: { ...options?.variant, twoSided: vertex ? !!sig.twoSidedColors : true },
        });
        if (!link.ok) return link;
        sig.glslInterface = link.varyingLayout;
        sig.extraStateFields = link.reflection.stateFields;
        fixed = generate(sig);
        if (vertex) link.wgslFragment = fixed.wgslFragment;
        else link.wgslVertex = fixed.wgslVertex;
        link.fixedTextures = vertex ? fixed.textures : [];
        link.fixedKey = fixed.key;
        return link;
    }

    const api = {
        FIXED_FUNCTION_REVISION,
        generate, linkGLSL, signatureKey, normalizeSignature, stateFieldsFor,
        allocateVaryings,
        MAX_TEXTURE_UNITS, MAX_LIGHTS, DEPTH_OFFSET_LOCATION, LINE_ATTRIBUTE_LOCATION,
    };
    global.GLFixedFunction = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
