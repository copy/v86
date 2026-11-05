// Pure fixed-function WGSL generation. Installation dependencies contain only
// immutable enum values and the shared shader varying contract.
(function(global) {
    "use strict";
    function createGenerator(dependencies) {
        const { shaderPipeline, DECLUSAGE_POSITION, DECLUSAGE_POSITIONT, DECLUSAGE_COLOR, DECLUSAGE_NORMAL, DECLUSAGE_TEXCOORD, MAX_TEXCOORD_SETS, DECLUSAGE_PSIZE, DECLUSAGE_BLENDWEIGHT, DECLUSAGE_BLENDINDICES, D3DTOP_BUMPENVMAPLUMINANCE, D3DFOG_LINEAR, D3DFOG_EXP, D3DFOG_EXP2, D3DTOP_SELECTARG1, D3DTOP_SELECTARG2, D3DTOP_MODULATE, D3DTOP_MODULATE2X, D3DTOP_MODULATE4X, D3DTOP_ADD, D3DTOP_ADDSIGNED, D3DTOP_ADDSIGNED2X, D3DTOP_SUBTRACT, D3DTOP_ADDSMOOTH, D3DTOP_BLENDDIFFUSEALPHA, D3DTOP_BLENDTEXTUREALPHA, D3DTOP_BLENDFACTORALPHA, D3DTOP_BLENDCURRENTALPHA, D3DTOP_BLENDTEXTUREALPHAPM, D3DTOP_DOTPRODUCT3, D3DTOP_BUMPENVMAP, D3DTOP_MODULATEALPHA_ADDCOLOR, D3DTOP_MODULATECOLOR_ADDALPHA, D3DTOP_MODULATEINVALPHA_ADDCOLOR, D3DTOP_MODULATEINVCOLOR_ADDALPHA, D3DTOP_MULTIPLYADD, D3DTOP_LERP, D3DMCS_COLOR1, D3DMCS_COLOR2, D3DLIGHT_DIRECTIONAL, D3DLIGHT_PARALLELPOINT, D3DLIGHT_SPOT, D3DTSS_TCI_PASSTHRU, D3DTSS_TCI_CAMERASPACENORMAL, D3DTSS_TCI_CAMERASPACEPOSITION, D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR, D3DTSS_TCI_SPHEREMAP, D3DTA_SELECTMASK, D3DTA_DIFFUSE, D3DTA_CURRENT, D3DTA_TEXTURE, D3DTA_TFACTOR, D3DTA_SPECULAR, D3DTA_TEMP, D3DTA_CONSTANT, D3DTA_ALPHAREPLICATE, D3DTA_COMPLEMENT, D3DTOP_DISABLE } = dependencies;
        // The inter-stage contract shared with translated shaders. Both stages
        // always agree on it, whichever of the four VS/PS combinations a draw
        // uses (see the file header).
        const VARYING_COUNT = shaderPipeline.VARYING_COUNT;
        const VARYING_COLOR0 = shaderPipeline.VARYING_COLOR0;
        // D3DRS_SHADEMODE. D3DSHADE_FLAT takes the colour of the primitive's first
        // vertex instead of interpolating, which is exactly WGSL's
        // @interpolate(flat) -- whose default sampling is `first`, the same
        // provoking vertex D3D9 uses.
        //
        // It applies to the two colour varyings only. Texture coordinates and fog
        // keep interpolating under flat shading in D3D9, and a title that flat
        // shades a textured surface expects the texture to still follow the
        // surface. D3DSHADE_PHONG is in the enum but no D3D9 device ever
        // implemented it; D3D9 treats it as GOURAUD, and so does this.
        const D3DSHADE_FLAT = 1, D3DSHADE_GOURAUD = 2;
        function varyingDeclaration(slot, flatShading) {
            const flat = flatShading &&
                (slot === VARYING_COLOR0 || slot === shaderPipeline.VARYING_COLOR1);
            return "    @location(" + slot + ")" +
                (flat ? " @interpolate(flat)" : "") +
                " varying" + slot + ": vec4<f32>,";
        }
        const VARYING_TEXCOORD0 = shaderPipeline.VARYING_TEXCOORD0;

        // Vertex attribute locations the fixed-function vertex stage consumes.
        // These are assigned by *semantic*, not by the element's position in the
        // declaration array. M1 assigned them by iteration order and hardcoded
        // position/colour/texcoord as locations 0/1/2 in the WGSL, which agreed
        // only for declarations that happened to list the elements in that
        // order; a declaration with TEXCOORD before COLOR silently fed the
        // texcoord bytes into the colour attribute.
        // M3 widened this from three locations to twelve: fixed-function lighting
        // reads NORMAL, the specular material source can read COLOR1, and a
        // multi-stage cascade can reference all eight coordinate sets rather than
        // only TEXCOORD0.
        const FF_LOCATION_POSITION = 0;
        const FF_LOCATION_COLOR0 = 1;
        const FF_LOCATION_COLOR1 = 2;
        const FF_LOCATION_NORMAL = 3;
        const FF_LOCATION_TEXCOORD0 = 4; // .. 11 for TEXCOORD0..7
        const FF_LOCATION_PSIZE = 12;
        // M7 added two more: fixed-function vertex blending reads the skinning
        // usages the declaration validator has always accepted.
        const FF_LOCATION_BLENDWEIGHT = 13;
        const FF_LOCATION_BLENDINDICES = 14;

        // D3D9's alpha test has no fixed-function equivalent in WebGPU: it has to
        // become a `discard` in the fragment shader. The comparison function
        // is compiled while ALPHAREF is supplied through a uniform. Samples
        // are quantized to UNORM8 before comparison. Returns "" for ALWAYS.
        //
        // This matters far beyond a subtle shading difference. UI atlases and
        // billboarded foliage lean on alpha test to cut fully transparent texels;
        // without it those texels are drawn opaque, which reads as wrong or
        // missing texture on exactly the panels and edges that should be cut out.
        //
        // D3DCMPFUNC values are 1..8; the expression below is the *discard*
        // condition, i.e. the negation of "the fragment passes".
        function alphaTestDiscard(alphaTest, alphaExpression, referenceExpression) {
            if (!alphaTest || !alphaTest.enabled) return "";
            const reference = referenceExpression || (alphaTest.reference & 255) + "u";
            const alpha = "u32(clamp(" + alphaExpression + ", 0.0, 1.0) * 255.0 + 0.5)";
            const condition = {
                1: "true", // NEVER
                2: "!(" + alpha + " < " + reference + ")",
                3: "!(" + alpha + " == " + reference + ")",
                4: "!(" + alpha + " <= " + reference + ")",
                5: "!(" + alpha + " > " + reference + ")",
                6: "!(" + alpha + " != " + reference + ")",
                7: "!(" + alpha + " >= " + reference + ")",
            }[alphaTest.func];
            if (!condition) return ""; // ALWAYS (8) and anything unknown: no test
            return "    if (" + condition + ") { discard; }\n";
        }

        // `blend` is the signature's resolved vertexBlend (null when the draw is
        // not blended); it decides whether the skinning attributes are consumed.
        function fixedFunctionLocationFor(element, blend) {
            if (element.usage === DECLUSAGE_POSITION ||
                    element.usage === DECLUSAGE_POSITIONT)
                return element.usageIndex === 0 ? FF_LOCATION_POSITION
                    : (element.usage === DECLUSAGE_POSITION && element.usageIndex === 1 && blend && blend.tween && blend.hasPosition2 ? FF_LOCATION_BLENDWEIGHT : -1);
            if (element.usage === DECLUSAGE_COLOR)
                return element.usageIndex === 0 ? FF_LOCATION_COLOR0
                    : (element.usageIndex === 1 ? FF_LOCATION_COLOR1 : -1);
            if (element.usage === DECLUSAGE_NORMAL)
                return element.usageIndex === 0 ? FF_LOCATION_NORMAL
                    : (element.usageIndex === 1 && blend && blend.tween && blend.hasNormal2 ? FF_LOCATION_BLENDINDICES : -1);
            if (element.usage === DECLUSAGE_TEXCOORD &&
                    element.usageIndex < MAX_TEXCOORD_SETS)
                return FF_LOCATION_TEXCOORD0 + element.usageIndex;
            if (element.usage === DECLUSAGE_PSIZE)
                return element.usageIndex === 0 ? FF_LOCATION_PSIZE : -1;
            // The skinning usages are read only while vertex blending is actually
            // on. Reporting them unconditionally would put an attribute in the
            // vertex layout that the generated WGSL never declares, for every
            // declaration that carries blend data with D3DRS_VERTEXBLEND disabled
            // -- which is most of them, since engines share one declaration
            // between their skinned and unskinned passes.
            if (element.usage === DECLUSAGE_BLENDWEIGHT)
                return blend && blend.weightCount && element.usageIndex === 0
                    ? FF_LOCATION_BLENDWEIGHT : -1;
            if (element.usage === DECLUSAGE_BLENDINDICES)
                return blend && blend.indexed && element.usageIndex === 0
                    ? FF_LOCATION_BLENDINDICES : -1;
            return -1;
        }

        // The WGSL declaration for a vertex attribute is always vec4<f32>: WebGPU
        // fills the components a narrower vertex format does not supply with
        // (_, 0, 0, 1), which is exactly D3D9's rule for a FLOAT3 POSITION or a
        // FLOAT2 texcoord. One declared type per location also keeps a shader
        // module independent of which declaration is bound with it.
        // Raw palette indices retain their integer base type. Other integer
        // and packed inputs use the shared programmable-entry conversion below;
        // the fixed-function body then consumes canonical float4 values.
        function vertexInputDeclaration(location, scalar) {
            return "@location(" + location + ") in" + location +
                ": vec4<" + (scalar || "f32") + ">";
        }

        // D3DDECLTYPE -> the WGSL base type its WebGPU format must be read as.
        // Only the integer formats need an entry; everything else is f32. UDEC3
        // (13) and DEC3N (14) arrive as a single packed uint32 rather than a
        // four-component vector, so they have no vec4 reading at all and return
        // null -- callers fall back rather than emit WGSL that will not compile.
        function declTypeInputScalar(type) {
            if (type === 13 || type === 14) return null;
            if (type === 5) return "u32";           // UBYTE4  -> uint8x4
            if (type === 6 || type === 7) return "i32"; // SHORT2/4 -> sint16x2/x4
            return "f32";
        }

        // ---- fixed-function uniform blocks ----
        //
        // Both fixed-function stages get a uniform block whose *shape follows the
        // signature*: an unlit untextured draw uploads 80 bytes, one with eight
        // lights and three texture-coordinate transforms uploads over a kilobyte.
        // The shape has to vary because a uniform buffer is built and written per
        // draw (see constantBufferFor), so paying the worst case on every draw
        // would multiply a War3 session's ~100k draws by an order of magnitude of
        // upload traffic for state most of them do not use.
        //
        // One field table drives both the WGSL struct text and the JS writer, so
        // the two cannot drift. That matters more than the usual DRY argument: a
        // mismatched offset here produces a garbage matrix or a black light, not a
        // compile error, which is the class of bug that costs a day to locate.
        //
        // Every field is a vec4, a mat4x4 or an array of a 16-multiple struct, so
        // all of them align to 16 in WGSL's uniform address space and offsets
        // accumulate by plain size with no padding rules to apply. assertAligned
        // holds us to that.
        function uniformBlockLayout(fields) {
            let offset = 0;
            const entries = [];
            for (const field of fields) {
                if (!field) continue;
                if (field.bytes % 16 !== 0 || offset % 16 !== 0)
                    throw new Error("fixed-function uniform field " + field.name +
                        " is not 16-byte aligned; WGSL uniform layout would " +
                        "silently disagree with the writer");
                entries.push({ ...field, offset });
                offset += field.bytes;
            }
            return { entries, byteLength: Math.max(16, offset),
                byName: new Map(entries.map(entry => [entry.name, entry])) };
        }

        function uniformBlockStruct(structName, layout) {
            // A zero-field block still has to be a legal struct, and every
            // signature that produces one also produces a shader that reads
            // nothing from it, so a dummy vec4 costs one binding slot and no
            // correctness.
            const body = layout.entries.length
                ? layout.entries.map(entry =>
                    "    " + entry.name + ": " + entry.type + ",").join("\n")
                : "    _unused: vec4<f32>,";
            return "struct " + structName + " {\n" + body + "\n};";
        }

        // The vertex block. `source` names what fills the field; writeFixedVertex-
        // Uniforms below is the single place that knows how.
        // D3D9 rasterises with the sample point at a pixel's integer corner; WebGPU,
        // like D3D10 and everything after it, samples at the pixel centre -- half a
        // pixel further along both axes. A D3D9 title blitting UI 1:1 has already
        // subtracted that half pixel itself (the "Directly Mapping Texels to Pixels"
        // adjustment every 2000s-era engine carries), so replaying its geometry
        // unchanged puts every sample exactly on a texel boundary and bilinear
        // filtering returns the mean of two texels. 3D art does not care -- nothing
        // in it is pixel-aligned to begin with -- but 12px CJK glyphs turn to mush,
        // which is exactly the split Kart Rider showed: a clean track and an
        // unreadable shop.
        //
        // Adding the half pixel back in clip space, scaled by w so it stays half a
        // pixel at any depth, is what wined3d's posFixup and DXVK's half-pixel
        // offset both do. Screen y grows downward while NDC y grows upward, hence
        // the sign flip on the second component.
        const HALF_PIXEL_OFFSET_BODY =
            "    result.position = vec4<f32>(\n" +
            "        result.position.x + result.position.w / uniforms.viewport.x,\n" +
            "        result.position.y - result.position.w / uniforms.viewport.y,\n" +
            "        result.position.zw);";

        function fixedVertexUniformLayout(signature) {
            // A blended draw cannot pre-multiply the world matrix into anything,
            // because which world matrix applies is a per-vertex question. So the
            // chain splits: the shader poses the vertex into world space from the
            // matrix array, and these carry only what comes after that.
            const blend = signature.vertexBlend;
            const fields = [
                { name: blend ? "view_projection" : "world_view_projection",
                    type: "mat4x4<f32>", bytes: 64 },
                { name: "viewport", type: "vec4<f32>", bytes: 16 },
            ];
            if (blend)
                fields.push({ name: "blend_worlds",
                    type: "array<mat4x4<f32>, " + blend.matrixSlots + ">",
                    bytes: 64 * blend.matrixSlots });
            if (blend && (signature.hasNormal || (blend.tween && blend.hasNormal2)) && signature.needsViewSpace)
                fields.push({ name: "blend_normals",
                    type: "array<mat4x4<f32>, " + blend.matrixSlots + ">",
                    bytes: 64 * blend.matrixSlots });
            if (blend && blend.tween)
                fields.push({ name: "tween_params", type: "vec4<f32>", bytes: 16 });
            // D3D9 fixed-function clip-plane equations are in world space. The
            // ordinary position path only needs a pre-multiplied WVP matrix, so
            // retain the world matrix separately when clipping needs that space.
            if (signature.clipPlaneCount && !blend &&
                    signature.positionType !== "screen")
                fields.push({ name: "world_matrix",
                    type: "mat4x4<f32>", bytes: 64 });
            if (signature.needsViewSpace) {
                fields.push({ name: blend ? "view_matrix" : "world_view",
                    type: "mat4x4<f32>", bytes: 64 });
                // Inverse-transpose of the preceding matrix's upper 3x3, widened to
                // a mat4 so it obeys the same 16-byte rule as everything else here.
                fields.push({ name: "normal_matrix", type: "mat4x4<f32>", bytes: 64 });
            }
            if (signature.fogMode)
                fields.push({ name: "fog_params", type: "vec4<f32>", bytes: 16 });
            for (const stage of signature.coordStages) {
                if (stage.transformCount > 0 && signature.positionType !== "screen")
                    fields.push({ name: "texture_transform" + stage.index,
                        type: "mat4x4<f32>", bytes: 64, source: stage.index });
            }
            if (signature.lighting) {
                fields.push(
                    { name: "material_diffuse", type: "vec4<f32>", bytes: 16 },
                    { name: "material_ambient", type: "vec4<f32>", bytes: 16 },
                    { name: "material_specular", type: "vec4<f32>", bytes: 16 },
                    { name: "material_emissive", type: "vec4<f32>", bytes: 16 },
                    // xyz = D3DRS_AMBIENT, w = the material's specular power.
                    { name: "ambient_power", type: "vec4<f32>", bytes: 16 });
                if (signature.lighting.lights.length)
                    fields.push({ name: "lights",
                        type: "array<D9Light, " + signature.lighting.lights.length + ">",
                        bytes: 112 * signature.lighting.lights.length });
            }
            if (signature.clipPlaneCount)
                fields.push({ name: "clip_planes",
                    type: "array<vec4<f32>, " + signature.clipPlaneCount + ">",
                    bytes: 16 * signature.clipPlaneCount });
            if (signature.pointExpansion) {
                fields.push(
                    { name: "point_viewport", type: "vec4<f32>", bytes: 16 },
                    // x=size, y=min, z=max, w reserved.
                    { name: "point_params", type: "vec4<f32>", bytes: 16 });
                if (signature.pointScale)
                    fields.push({ name: "point_scale", type: "vec4<f32>", bytes: 16 });
            }
            return uniformBlockLayout(fields);
        }

        // The pixel block: only what the texture cascade and the fog blend read.
        function fixedPixelUniformLayout(signature) {
            const fields = [];
            if (signature.alphaTest && signature.alphaTest.enabled)
                fields.push({ name: "alpha_test", type: "vec4<u32>", bytes: 16 });
            if (signature.lodBiasUniforms) {
                const count = Math.max(...signature.stages.filter(stage => stage.samplesTexture).map(stage => stage.index)) + 1;
                const vectors = Math.ceil(count / 4);
                fields.push({ name: "sampler_lod_bias", type: "array<vec4<f32>, " + vectors + ">", bytes: vectors * 16, samplerBiasCount: vectors * 4 });
            }
            if (signature.fogMode)
                fields.push({ name: "fog_color", type: "vec4<f32>", bytes: 16 });
            if (signature.tableFog)
                fields.push({ name: "fog_params", type: "vec4<f32>", bytes: 16 });
            if (signature.usesTextureFactor)
                fields.push({ name: "texture_factor", type: "vec4<f32>", bytes: 16 });
            for (const stage of signature.stages) {
                if (stage.usesConstant)
                    fields.push({ name: "stage_constant" + stage.index,
                        type: "vec4<f32>", bytes: 16, source: stage.index });
                // The bump matrix and luminance terms belong to the stage that
                // declared BUMPENVMAP, not to the stage that samples with them.
                if (stage.isBumpSource) {
                    fields.push({ name: "stage_bump" + stage.index,
                        type: "vec4<f32>", bytes: 16, bumpSource: stage.index });
                    if (stage.colorOp === D3DTOP_BUMPENVMAPLUMINANCE)
                        fields.push({ name: "stage_bump_lum" + stage.index,
                            type: "vec4<f32>", bytes: 16,
                            bumpLuminanceSource: stage.index });
                }
            }
            return uniformBlockLayout(fields);
        }

        function fixedFogFactorExpression(mode, distance) {
            return {
                [D3DFOG_LINEAR]: "clamp((uniforms.fog_params.y - " + distance + ") / " +
                    "select(uniforms.fog_params.y - uniforms.fog_params.x, 1e-30, " +
                    "uniforms.fog_params.y == uniforms.fog_params.x), 0.0, 1.0)",
                [D3DFOG_EXP]: "clamp(exp(-(uniforms.fog_params.z * " + distance + ")), " +
                    "0.0, 1.0)",
                [D3DFOG_EXP2]: "clamp(exp(-((uniforms.fog_params.z * " + distance + ") * " +
                    "(uniforms.fog_params.z * " + distance + "))), 0.0, 1.0)",
            }[mode] || null;
        }

        // ---- D3DTEXTUREOP -> WGSL ----
        //
        // D3D9's texture cascade runs the colour and alpha channels through
        // *separate* operations with separate arguments, so each operation is
        // emitted twice: once over vec3 and once over f32. `blend` names the alpha
        // an op blends with (diffuse/texture/factor/current), which the caller
        // supplies as an already-built scalar expression.
        //
        // Only the operations fill_caps() lists in TextureOpCaps appear here.
        // Returning null makes the caller count the draw and fall back to
        // SELECTARG1 rather than inventing an approximation.
        // Shared post-shader fog for the FFP cascade and ps_1_x/ps_2_x.
        function fogBlendSource(signature, uniforms, target) {
            if (!signature.fogMode) return "";
            const tableFactor = fixedFogFactorExpression(signature.fogMode, "fog_distance");
            const factor = signature.tableFog && tableFactor
                ? tableFactor.replaceAll("uniforms.", uniforms + ".")
                : "clamp(stage_in.varying" + shaderPipeline.VARYING_FOG + ".x, 0.0, 1.0)";
            const distance = signature.tableFog && tableFactor
                ? "    let fog_distance = select(1.0 / max(abs(stage_in.position.w), 1e-6), " +
                    "stage_in.position.z, " + uniforms + ".fog_params.w != 0.0);\n" : "";
            return distance + "    " + target + " = vec4<f32>(mix(" + uniforms + ".fog_color.rgb, " + target + ".rgb,\n" +
                "        " + factor + "), " + target + ".a);\n";
        }

        function textureOpArguments(op) {
            if (op === D3DTOP_DISABLE) return [];
            if (op === D3DTOP_SELECTARG1) return [1];
            if (op === D3DTOP_SELECTARG2 || op === D3DTOP_BUMPENVMAP || op === D3DTOP_BUMPENVMAPLUMINANCE) return [2];
            return op === D3DTOP_MULTIPLYADD || op === D3DTOP_LERP ? [0, 1, 2] : [1, 2];
        }
        function textureOpReadsTexture(op, args) {
            return op === D3DTOP_BLENDTEXTUREALPHA || op === D3DTOP_BLENDTEXTUREALPHAPM ||
                op === D3DTOP_BUMPENVMAP || op === D3DTOP_BUMPENVMAPLUMINANCE ||
                textureOpArguments(op).some(index => (args[index] & D3DTA_SELECTMASK) === D3DTA_TEXTURE);
        }
        function normalizeTextureOperation(op, args, hasTexture) {
            if (!hasTexture && textureOpReadsTexture(op, args)) return { op: D3DTOP_SELECTARG1, args: [D3DTA_CURRENT, D3DTA_CURRENT, D3DTA_CURRENT] };
            const used = textureOpArguments(op);
            return { op, args: args.map((value, index) => used.includes(index) ? value : D3DTA_CURRENT) };
        }

        function textureOpExpression(op, type, args, blend) {
            const one = type === "vec3<f32>" ? "vec3<f32>(1.0)" : "1.0";
            const half = type === "vec3<f32>" ? "vec3<f32>(0.5)" : "0.5";
            const a0 = args[0], a1 = args[1], a2 = args[2];
            switch (op) {
            case D3DTOP_SELECTARG1: return a1;
            case D3DTOP_SELECTARG2: return a2;
            case D3DTOP_MODULATE: return "(" + a1 + " * " + a2 + ")";
            case D3DTOP_MODULATE2X: return "((" + a1 + " * " + a2 + ") * 2.0)";
            case D3DTOP_MODULATE4X: return "((" + a1 + " * " + a2 + ") * 4.0)";
            case D3DTOP_ADD: return "(" + a1 + " + " + a2 + ")";
            case D3DTOP_ADDSIGNED:
                return "(" + a1 + " + " + a2 + " - " + half + ")";
            case D3DTOP_ADDSIGNED2X:
                return "((" + a1 + " + " + a2 + " - " + half + ") * 2.0)";
            case D3DTOP_SUBTRACT: return "(" + a1 + " - " + a2 + ")";
            case D3DTOP_ADDSMOOTH:
                return "(" + a1 + " + " + a2 + " * (" + one + " - " + a1 + "))";
            case D3DTOP_BLENDDIFFUSEALPHA:
            case D3DTOP_BLENDTEXTUREALPHA:
            case D3DTOP_BLENDFACTORALPHA:
            case D3DTOP_BLENDCURRENTALPHA:
                return "mix(" + a2 + ", " + a1 + ", " + blend + ")";
            case D3DTOP_BLENDTEXTUREALPHAPM:
                // Pre-multiplied: arg1 already carries the alpha it was scaled by.
                return "(" + a1 + " + " + a2 + " * (1.0 - " + blend + "))";
            case D3DTOP_DOTPRODUCT3: {
                // Signed-scaled dot product replicated to every channel including
                // alpha, which is why the alpha form is the same expression.
                const dot = "(4.0 * dot(" + args.rgb1 + " - vec3<f32>(0.5), " +
                    args.rgb2 + " - vec3<f32>(0.5)))";
                return type === "vec3<f32>" ? "vec3<f32>(" + dot + ")" : dot;
            }
            case D3DTOP_BUMPENVMAP:
            case D3DTOP_BUMPENVMAPLUMINANCE:
                // A bump stage produces no colour of its own: its whole effect is
                // the coordinate perturbation the *next* stage samples with (see
                // the bump handling in buildFixedFunctionPixelShader). D3D leaves
                // the running result untouched, which is arg2 -- D3DTA_CURRENT by
                // default.
                return a2;
            // The four "modulate one channel set, add the other" forms. Each
            // reaches for arg1's alpha alongside arg1's colour, which is why the
            // caller supplies `args.alpha1` separately -- `a1` here is already
            // reduced to the channel being computed. D3D9 defines all four for
            // D3DTSS_COLOROP only, so the f32 form falls through to the null
            // default and is counted rather than invented.
            case D3DTOP_MODULATEALPHA_ADDCOLOR:
                if (type !== "vec3<f32>") return null;
                return "(" + args.rgb1 + " + " + args.alpha1 + " * " + args.rgb2 + ")";
            case D3DTOP_MODULATECOLOR_ADDALPHA:
                if (type !== "vec3<f32>") return null;
                return "(" + args.rgb1 + " * " + args.rgb2 + " + " +
                    "vec3<f32>(" + args.alpha1 + "))";
            case D3DTOP_MODULATEINVALPHA_ADDCOLOR:
                if (type !== "vec3<f32>") return null;
                return "((1.0 - " + args.alpha1 + ") * " + args.rgb2 + " + " +
                    args.rgb1 + ")";
            case D3DTOP_MODULATEINVCOLOR_ADDALPHA:
                if (type !== "vec3<f32>") return null;
                return "((vec3<f32>(1.0) - " + args.rgb1 + ") * " + args.rgb2 +
                    " + vec3<f32>(" + args.alpha1 + "))";
            case D3DTOP_MULTIPLYADD:
                return "(" + a0 + " + " + a1 + " * " + a2 + ")";
            case D3DTOP_LERP:
                return "mix(" + a2 + ", " + a1 + ", " + a0 + ")";
            default:
                return null;
            }
        }

        // Fixed-function vertex stage: position transform, optional lighting,
        // per-stage texture coordinate generation/transform and fog, all written
        // into the shared varying set. `signature` comes from
        // fixedFunctionVertexSignature() plus the state-derived fields
        // programFor() adds.
        function buildFixedFunctionVertexShader(signature) {
            const layout = fixedVertexUniformLayout(signature);
            const lighting = signature.lighting;
            const blend = signature.vertexBlend;
            const hasNormal = signature.hasNormal || !!(blend && blend.tween && blend.hasNormal2);
            const position = "in" + FF_LOCATION_POSITION;

            const conversions = signature.inputConversions || {}, inputLines = [];
            const parameter = location => {
                const conversion = conversions[location];
                if (!conversion) return vertexInputDeclaration(location);
                const name = "d9_raw_in" + location;
                inputLines.push("    let in" + location + " = " +
                    shaderPipeline.vertexInputValue(name, conversion) + ";");
                return "@location(" + location + ") " + name + ": " +
                    shaderPipeline.vertexInputType(conversion);
            };
            const inputHelpers = shaderPipeline.vertexInputHelpers(Object.values(conversions));
            const parameters = [parameter(FF_LOCATION_POSITION)];
            if (signature.hasColor)
                parameters.push(parameter(FF_LOCATION_COLOR0));
            if (signature.hasColor1)
                parameters.push(parameter(FF_LOCATION_COLOR1));
            if (signature.hasNormal)
                parameters.push(parameter(FF_LOCATION_NORMAL));
            if (signature.hasPointSize)
                parameters.push(parameter(FF_LOCATION_PSIZE));
            if (blend && blend.tween) {
                if (blend.hasPosition2) parameters.push(parameter(FF_LOCATION_BLENDWEIGHT));
                if (blend.hasNormal2) parameters.push(parameter(FF_LOCATION_BLENDINDICES));
            }
            if (blend && blend.weightCount)
                parameters.push(vertexInputDeclaration(FF_LOCATION_BLENDWEIGHT));
            if (blend && blend.indexed)
                parameters.push(vertexInputDeclaration(FF_LOCATION_BLENDINDICES,
                    blend.indexScalar));
            for (const set of signature.texCoordSets)
                parameters.push(parameter(FF_LOCATION_TEXCOORD0 + set));
            if (signature.pointExpansion)
                parameters.push("@builtin(vertex_index) d9_vertex_index: u32");

            const varyings = [];
            for (let slot = 0; slot < VARYING_COUNT; ++slot)
                varyings.push(varyingDeclaration(slot, signature.flatShading));
            const clipVaryings = [];
            let clipBody = "";
            if (signature.clipPlaneCount) {
                const clipPosition = blend ? "d9_blend_position"
                    : signature.positionType === "screen" ? position
                    : "uniforms.world_matrix * " + position;
                clipBody += "    let d9_clip_position = " + clipPosition + ";\n";
            }
            for (let group = 0; group < Math.ceil(
                    (signature.clipPlaneCount || 0) / 4); ++group) {
                clipVaryings.push("    @location(" + (VARYING_COUNT + group) +
                    ") clip" + group + ": vec4<f32>,");
                clipBody += "    result.clip" + group +
                    " = vec4<f32>(1.0);\n";
            }
            for (let plane = 0; plane < (signature.clipPlaneCount || 0); ++plane)
                clipBody += "    result.clip" + Math.floor(plane / 4) + "." +
                    "xyzw"[plane & 3] + " = dot(d9_clip_position, " +
                    "uniforms.clip_planes[" + plane + "]);\n";

            // ---- fixed-function vertex blending (D3DRS_VERTEXBLEND) ----
            //
            // D3D9 poses a vertex as sum(w_i * (v * WORLDMATRIX(i))) and applies
            // view and projection only to the result, so a blended draw cannot
            // fold the world matrix into world_view_projection the way every
            // other draw does -- which world matrix applies is a per-vertex
            // question. BLENDWEIGHT carries one fewer weight than there are
            // matrices because D3D9 defines the last as 1 - sum(the rest); that is
            // what keeps the weights a partition of unity even when the exported
            // ones do not quite sum to 1.
            //
            // Each normal uses its world's inverse transpose before the
            // weighted sum. View-space inverse transpose and optional
            // normalization are applied after blending.
            const blendedPosition = blend ? "d9_blend_position" : position;
            let blendBody = "";
            if (blend && blend.tween) {
                const factor = "uniforms.tween_params.x";
                const tweenPosition = blend.hasPosition2 ? "(" + position + " * (1.0 - " + factor + ") + in" + FF_LOCATION_BLENDWEIGHT + " * " + factor + ")" : position;
                blendBody = "    let d9_blend_position = uniforms.blend_worlds[0] * " + tweenPosition + ";\n";
                if (hasNormal && signature.needsViewSpace) {
                    const primary = signature.hasNormal ? "in" + FF_LOCATION_NORMAL + ".xyz" : "vec3<f32>(0.0)";
                    const tweenNormal = blend.hasNormal2 ? "(" + primary + " * (1.0 - " + factor + ") + in" + FF_LOCATION_BLENDINDICES + ".xyz * " + factor + ")" : primary;
                    blendBody += "    let d9_blend_normal = (uniforms.blend_normals[0] * vec4<f32>(" + tweenNormal + ", 0.0)).xyz;\n";
                }
            } else if (blend) {
                const slots = blend.matrixCount;
                const weights = [];
                for (let slot = 0; slot < slots - 1; ++slot)
                    weights.push("in" + FF_LOCATION_BLENDWEIGHT +
                        (signature.blendWeightType === 4 ? ".bgra" : "") + "." + "xyzw"[slot]);
                blendBody = "    var d9_blend_position = vec4<f32>(0.0);\n";
                if (signature.hasNormal && signature.needsViewSpace)
                    blendBody += "    var d9_blend_normal = vec3<f32>(0.0);\n";
                if (weights.length)
                    blendBody += "    let d9_blend_last = 1.0 - (" +
                        weights.join(" + ") + ");\n";
                if (blend.indexed) {
                    // A palette index out of range is the app's bug, but WGSL gives
                    // no defined value for an out-of-bounds uniform read, so clamp:
                    // one wrong bone beats an indeterminate matrix.
                    const raw = "in" + FF_LOCATION_BLENDINDICES +
                        (signature.blendIndicesType === 4 ? ".bgra" : "");
                    let unsigned;
                    if (blend.indexScalar === "u32")
                        unsigned = raw;
                    else if (blend.indexScalar === "i32")
                        unsigned = "vec4<u32>(max(" + raw + ", vec4<i32>(0)))";
                    else if (blend.indexNormalized)
                        // Rounded, not truncated: 2/255 * 255 does not land exactly
                        // on 2 in f32, and truncating it would select bone 1.
                        unsigned = "vec4<u32>(round(" + raw + " * 255.0))";
                    else
                        unsigned = "vec4<u32>(max(" + raw + ", vec4<f32>(0.0)))";
                    blendBody += "    let d9_blend_index = min(" + unsigned +
                        ",\n        vec4<u32>(" + (blend.matrixSlots - 1) + "u));\n";
                }
                for (let slot = 0; slot < slots; ++slot) {
                    const weight = slot < slots - 1 ? weights[slot]
                        : (weights.length ? "d9_blend_last" : "1.0");
                    const index = blend.indexed
                        ? "d9_blend_index." + "xyzw"[slot] : slot + "u";
                    blendBody += "    {\n" +
                        "        let d9_bone = uniforms.blend_worlds[" + index + "];\n" +
                        "        let d9_weight = " + weight + ";\n" +
                        "        d9_blend_position = d9_blend_position +\n" +
                        "            (d9_bone * " + position + ") * d9_weight;\n";
                    if (signature.hasNormal && signature.needsViewSpace)
                        blendBody +=
                        "        let d9_normal_bone = uniforms.blend_normals[" + index + "];\n" +
                        "        d9_blend_normal = d9_blend_normal +\n" +
                        "            (d9_normal_bone * vec4<f32>(in" + FF_LOCATION_NORMAL +
                            ".xyz, 0.0)).xyz * d9_weight;\n";
                    blendBody += "    }\n";
                }
            }

            // XYZRHW ("screen") vertices arrive already in viewport pixel space and
            // bypass the world/view/projection chain entirely. D3D9 also treats
            // them as already lit, which is why lighting is forced off for them.
            // XYZRHW ("screen") coordinates are absolute render-target pixels, not
            // pixels relative to the viewport -- so the viewport's origin has to
            // come off before normalising, because setViewport puts it back when it
            // maps NDC into the viewport rect. Omitting it made the two cancel only
            // for a viewport at 0,0, which is every full-screen UI pass and hid the
            // bug completely. Kart Rider draws its shop item previews through
            // 110x109 viewports at x=368..636, and pre-transformed geometry there
            // landed several viewport-widths outside the box and was clipped away:
            // the panels whose contents are entirely pre-transformed came out
            // empty, while the one item drawn from world-space geometry rendered
            // perfectly. Same fix as wined3d's transformed-position projection
            // matrix, which carries the -2x/w term for exactly this reason.
            const positionBody = blendBody + (signature.positionType === "screen"
                ? `    let viewport = uniforms.viewport;
    let ndc_x = ((${position}.x - viewport.z) / viewport.x) * 2.0 - 1.0;
    let ndc_y = 1.0 - ((${position}.y - viewport.w) / viewport.y) * 2.0;
    let clip_w = 1.0 / select(${position}.w, 1.0, ${position}.w == 0.0);
    result.position = vec4<f32>(ndc_x, ndc_y, ${position}.z, 1.0) * clip_w;`
                : "    result.position = uniforms." +
                    (blend ? "view_projection" : "world_view_projection") +
                    " * " + blendedPosition + ";")
                + "\n" + HALF_PIXEL_OFFSET_BODY;

            // View space is where D3D9 lights live and where the camera-space
            // coordinate generation modes are defined, so one block serves both.
            // The light positions/directions themselves arrive already multiplied by
            // the view matrix (see writeFixedVertexUniforms) rather than as a second
            // matrix in the shader.
            let viewSpaceBody = "";
            if (signature.needsViewSpace) {
                // With blending, world_view/normal_matrix hold the view half only
                // -- the world half already happened, per vertex, above.
                viewSpaceBody = "    let position_view = uniforms." +
                    (blend ? "view_matrix" : "world_view") + " * " +
                    blendedPosition + ";\n";
                if (hasNormal) {
                    const normalSource = blend ? "d9_blend_normal"
                        : "in" + FF_LOCATION_NORMAL + ".xyz";
                    viewSpaceBody += "    var normal_view = (uniforms.normal_matrix" +
                        " * vec4<f32>(" + normalSource + ", 0.0)).xyz;\n";
                    // D3DRS_NORMALIZENORMALS is honoured rather than always
                    // normalising: D3D9 genuinely does not renormalise unless asked,
                    // so a scaled world matrix produces over- or under-bright
                    // lighting, and silently fixing that would make this renderer
                    // disagree with the reference for content tuned against it.
                    if (signature.normalizeNormals)
                        viewSpaceBody += "    normal_view = normalize(normal_view);\n";
                } else {
                    // A declaration with no normal cannot receive directional
                    // diffuse/specular light; D3D9 uses (0,0,0), which zeroes every
                    // N.L term while leaving ambient + emissive.
                    viewSpaceBody += "    let normal_view = vec3<f32>(0.0);\n";
                }
            }

            // Vertex colours, before any material-source selection.
            const vertexDiffuse = signature.hasColor
                ? "in" + FF_LOCATION_COLOR0 + (signature.colorIsBGRA ? ".bgra" : "")
                : "vec4<f32>(1.0, 1.0, 1.0, 1.0)";
            const vertexSpecular = signature.hasColor1
                ? "in" + FF_LOCATION_COLOR1 + (signature.color1IsBGRA ? ".bgra" : "")
                : "vec4<f32>(0.0, 0.0, 0.0, 0.0)";

            let colorBody = "    let vertex_diffuse = " + vertexDiffuse + ";\n" +
                "    let vertex_specular = " + vertexSpecular + ";\n";
            if (lighting) {
                // D3DRS_COLORVERTEX off forces every channel to the material;
                // otherwise D3DRS_*MATERIALSOURCE picks between the material and
                // the two vertex colours. The D3D9 defaults are COLOR1 for diffuse
                // and COLOR2 for specular, which is why a lit mesh with per-vertex
                // colours is tinted by them rather than by the material alone.
                const sourceExpression = (source, materialField) => {
                    if (!lighting.colorVertex) return "uniforms." + materialField;
                    if (source === D3DMCS_COLOR1 && signature.hasColor) return "vertex_diffuse";
                    if (source === D3DMCS_COLOR2 && signature.hasColor1) return "vertex_specular";
                    return "uniforms." + materialField;
                };
                colorBody +=
                    "    let material_diffuse = " +
                        sourceExpression(lighting.diffuseSource, "material_diffuse") + ";\n" +
                    "    let material_ambient = " +
                        sourceExpression(lighting.ambientSource, "material_ambient") + ";\n" +
                    "    let material_specular = " +
                        sourceExpression(lighting.specularSource, "material_specular") + ";\n" +
                    "    let material_emissive = " +
                        sourceExpression(lighting.emissiveSource, "material_emissive") + ";\n" +
                    "    var total_diffuse = vec3<f32>(0.0);\n" +
                    "    var total_ambient = uniforms.ambient_power.xyz;\n" +
                    "    var total_specular = vec3<f32>(0.0);\n" +
                    // Without D3DRS_LOCALVIEWER the eye vector is the constant
                    // (0,0,-1) of D3D9's left-handed view space, which is the
                    // cheaper approximation engines of this era normally leave on.
                    "    let eye_direction = " + (lighting.localViewer
                        ? "normalize(-position_view.xyz)"
                        : "vec3<f32>(0.0, 0.0, -1.0)") + ";\n";
                lighting.lights.forEach((light, index) => {
                    colorBody += "    {\n" +
                        "        let light = uniforms.lights[" + index + "];\n";
                    if (light.type === D3DLIGHT_DIRECTIONAL || light.type === D3DLIGHT_PARALLELPOINT) {
                        colorBody +=
                            "        let light_direction = " + (light.type === D3DLIGHT_DIRECTIONAL ? "-light.direction.xyz" : "light.position.xyz") + ";\n" +
                            "        let attenuation = 1.0;\n";
                    } else {
                        colorBody +=
                            "        let to_light = light.position.xyz - position_view.xyz;\n" +
                            "        let light_distance = length(to_light);\n" +
                            "        let light_direction = select(vec3<f32>(0.0, 0.0, 1.0),\n" +
                            "            to_light / max(light_distance, 1e-6), light_distance > 0.0);\n" +
                            // D3D9 attenuates by 1/(a0 + a1*d + a2*d^2) and drops
                            // the light entirely past its range.
                            "        var range_attenuation = 1.0 / max(light.attenuation.x +\n" +
                            "            light.attenuation.y * light_distance +\n" +
                            "            light.attenuation.z * light_distance * light_distance, 1e-6);\n" +
                            "        if (light_distance > light.range_falloff.x) {\n" +
                            "            range_attenuation = 0.0;\n" +
                            "        }\n";
                        if (light.type === D3DLIGHT_SPOT) {
                            // range_falloff = (range, falloff, cos(theta/2), cos(phi/2)).
                            colorBody +=
                                "        let rho = dot(light.direction.xyz, -light_direction);\n" +
                                "        var spot = 0.0;\n" +
                                "        if (rho > light.range_falloff.z) {\n" +
                                "            spot = 1.0;\n" +
                                "        } else if (rho > light.range_falloff.w) {\n" +
                                "            spot = pow(max((rho - light.range_falloff.w) /\n" +
                                "                max(light.range_falloff.z - light.range_falloff.w, 1e-6),\n" +
                                "                0.0), max(light.range_falloff.y, 1e-4));\n" +
                                "        }\n" +
                                "        let attenuation = range_attenuation * spot;\n";
                        } else {
                            colorBody += "        let attenuation = range_attenuation;\n";
                        }
                    }
                    colorBody +=
                        "        let n_dot_l = max(dot(normal_view, light_direction), 0.0);\n" +
                        "        total_diffuse = total_diffuse + light.diffuse.xyz *\n" +
                        "            (n_dot_l * attenuation);\n" +
                        "        total_ambient = total_ambient + light.ambient.xyz * attenuation;\n";
                    if (lighting.specularEnable) {
                        colorBody +=
                            "        let half_vector = normalize(light_direction + eye_direction);\n" +
                            "        let n_dot_h = max(dot(normal_view, half_vector), 0.0);\n" +
                            // Back faces contribute no highlight, and pow(0, p) is
                            // only well-defined for p > 0, hence both guards.
                            "        let highlight = select(0.0,\n" +
                            "            pow(n_dot_h, max(uniforms.ambient_power.w, 1e-4)),\n" +
                            "            n_dot_l > 0.0);\n" +
                            "        total_specular = total_specular + light.specular.xyz *\n" +
                            "            (highlight * attenuation);\n";
                    }
                    colorBody += "    }\n";
                });
                colorBody +=
                    "    let lit_rgb = clamp(total_ambient * material_ambient.xyz +\n" +
                    "        total_diffuse * material_diffuse.xyz + material_emissive.xyz,\n" +
                    "        vec3<f32>(0.0), vec3<f32>(1.0));\n" +
                    // D3D9 takes the lit vertex's alpha from the diffuse material
                    // channel only -- lighting never affects alpha.
                    "    let out_diffuse = vec4<f32>(lit_rgb, clamp(material_diffuse.a, 0.0, 1.0));\n" +
                    (lighting.specularEnable
                        ? "    let out_specular = vec4<f32>(clamp(total_specular *\n" +
                          "        material_specular.xyz, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0);\n"
                        // Disabling generated highlights preserves the vertex
                        // specular input for a programmable pixel shader.
                        : "    let out_specular = vertex_specular;\n");
            } else {
                colorBody += "    let out_diffuse = vertex_diffuse;\n" +
                    "    let out_specular = vertex_specular;\n";
            }

            // Vertex fog's distance is the camera-space depth |z| (wined3d's
            // abs(ec_pos.z)); the clip-space w it used to be equals that only
            // under a standard projection. D3DRS_RANGEFOGENABLE asks for true
            // radial distance instead, which removes the "fog thins towards the
            // screen edges" artefact of depth-based fog. (Table fog, per pixel,
            // is the one that uses w: D3DPRASTERCAPS_WFOG.)
            const fogDistance = !signature.needsViewSpace ? "abs(result.position.w)"
                : signature.fogRange ? "length(position_view.xyz)" : "abs(position_view.z)";
            const fogFactor = fixedFogFactorExpression(signature.fogMode,
                "fog_distance");
            const fogBody = signature.fogMode && (signature.positionType === "screen" || signature.fogMode === "factor")
                ? "    result.varying" + shaderPipeline.VARYING_FOG + " = vec4<f32>(" +
                    (signature.hasColor1 ? "clamp(vertex_specular.a, 0.0, 1.0)" : "1.0") + ", 0.0, 0.0, 0.0);\n"
                : fogFactor
                ? "    let fog_distance = " + fogDistance + ";\n" +
                  "    result.varying" + shaderPipeline.VARYING_FOG +
                  " = vec4<f32>(" + fogFactor + ", 0.0, 0.0, 0.0);\n"
                : "";

            // One texture-coordinate varying per *stage*, not per declared
            // coordinate set: D3DTSS_TEXCOORDINDEX chooses which set (or which
            // generated vector) feeds a stage, and D3DTS_TEXTURE0+n transforms it,
            // so the varying a pixel stage reads for stage n is already the final
            // coordinate. That is also what D3D9 hands a real pixel shader, whose
            // texcoord input n corresponds to texture stage n.
            let coordBody = "";
            for (const stage of signature.coordStages) {
                let raw;
                // XYZRHW vertices have already passed the object/view transform
                // and carry neither an eye-space position nor a normal. A few
                // D3D8 applications leave camera-space TCI bits behind when they
                // switch to a pre-transformed overlay. Native D3D treats the
                // generated value there as undefined; referring to the absent
                // position_view/normal_view locals is worse because it makes the
                // whole WGSL module invalid and poisons the command buffer. Keep a
                // declared coordinate when one exists, otherwise use the same
                // benign (0,0,0,1) value as a missing passthrough coordinate.
                if (signature.positionType === "screen" &&
                        stage.tciMode !== D3DTSS_TCI_PASSTHRU) {
                    raw = signature.texCoordSets.includes(stage.texCoordIndex)
                        ? "in" + (FF_LOCATION_TEXCOORD0 + stage.texCoordIndex)
                        : "vec4<f32>(0.0, 0.0, 0.0, 1.0)";
                } else switch (stage.tciMode) {
                case D3DTSS_TCI_CAMERASPACENORMAL:
                    raw = "vec4<f32>(normal_view, 1.0)";
                    break;
                case D3DTSS_TCI_CAMERASPACEPOSITION:
                    raw = "vec4<f32>(position_view.xyz, 1.0)";
                    break;
                case D3DTSS_TCI_CAMERASPACEREFLECTIONVECTOR:
                    raw = "vec4<f32>(reflect(normalize(position_view.xyz), " +
                        "normalize(normal_view)), 1.0)";
                    break;
                case D3DTSS_TCI_SPHEREMAP:
                    // The classic sphere-map projection of the eye-space
                    // reflection vector: the same formula OpenGL's GL_SPHERE_MAP
                    // and wined3d use, which is what titles authored their
                    // sphere-map art against. m is twice the length of
                    // (R.x, R.y, R.z + 1), and the +0.5 recentres the result into
                    // the [0,1] texture domain.
                    raw = "(func_sphere_map(reflect(normalize(position_view.xyz), " +
                        "normalize(normal_view))))";
                    break;
                default:
                    raw = signature.texCoordSets.includes(stage.texCoordIndex)
                        ? "in" + (FF_LOCATION_TEXCOORD0 + stage.texCoordIndex)
                        : "vec4<f32>(0.0, 0.0, 0.0, 1.0)";
                    break;
                }
                let expression = raw;
                if (stage.transformCount > 0 && signature.positionType !== "screen") {
                    // Pad by input dimension: (u,1,0,0), (u,v,1,0),
                    // (u,v,w,1), or the original four components. COUNT only
                    // selects the output elements; generated coordinates keep Z.
                    // D3D's row-major upload is the column-vector transpose.
                    const padded = {
                        1: "vec4<f32>(" + raw + ".x, 1.0, 0.0, 0.0)",
                        2: "vec4<f32>(" + raw + ".xy, 1.0, 0.0)",
                        3: "vec4<f32>(" + raw + ".xyz, 1.0)",
                        4: raw,
                    }[stage.inputDimensions || 4] || raw;
                    expression = "(uniforms.texture_transform" + stage.index +
                        " * " + padded + ")";
                }
                coordBody += "    result.varying" +
                    (VARYING_TEXCOORD0 + stage.index) + " = " + expression + ";\n";
            }

            let pointBody = "";
            if (signature.pointExpansion) {
                const baseSize = signature.hasPointSize
                    ? "in" + FF_LOCATION_PSIZE + ".x" : "uniforms.point_params.x";
                pointBody +=
                    "    let d9_point_uvs = array<vec2<f32>, 6>(\n" +
                    "        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0),\n" +
                    "        vec2<f32>(0.0, 1.0), vec2<f32>(0.0, 1.0),\n" +
                    "        vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));\n" +
                    "    let d9_point_uv = d9_point_uvs[d9_vertex_index % 6u];\n" +
                    "    var d9_point_size = " + baseSize + ";\n";
                if (signature.pointScale) {
                    pointBody +=
                        "    let d9_point_distance = length(position_view.xyz);\n" +
                        "    let d9_point_denom = max(uniforms.point_scale.x +\n" +
                        "        uniforms.point_scale.y * d9_point_distance +\n" +
                        "        uniforms.point_scale.z * d9_point_distance * d9_point_distance, 1e-6);\n" +
                        "    d9_point_size = d9_point_size * uniforms.point_viewport.y *\n" +
                        "        inverseSqrt(d9_point_denom);\n";
                }
                pointBody +=
                    "    d9_point_size = clamp(d9_point_size, uniforms.point_params.y,\n" +
                    "        max(uniforms.point_params.y, uniforms.point_params.z));\n" +
                    "    let d9_point_ndc = vec2<f32>(\n" +
                    "        (d9_point_uv.x * 2.0 - 1.0) * d9_point_size / uniforms.point_viewport.x,\n" +
                    "        (1.0 - d9_point_uv.y * 2.0) * d9_point_size / uniforms.point_viewport.y);\n" +
                    "    result.position = vec4<f32>(result.position.xy +\n" +
                    "        d9_point_ndc * result.position.w, result.position.zw);\n";
                if (signature.pointSprite) {
                    for (let stage = 0; stage < MAX_TEXCOORD_SETS; ++stage) {
                        pointBody += "    result.varying" +
                            (VARYING_TEXCOORD0 + stage) +
                            " = vec4<f32>(d9_point_uv, 0.0, 1.0);\n";
                    }
                }
            }

            const lightStruct = lighting && lighting.lights.length ? `struct D9Light {
    diffuse: vec4<f32>,
    specular: vec4<f32>,
    ambient: vec4<f32>,
    position: vec4<f32>,
    direction: vec4<f32>,
    range_falloff: vec4<f32>,
    attenuation: vec4<f32>,
};
` : "";

            // Emitted only when a stage asks for it, so the ordinary vertex stage
            // is unchanged.
            const sphereMapHelper = signature.coordStages.some(stage =>
                stage.tciMode === D3DTSS_TCI_SPHEREMAP) ? `
fn func_sphere_map(r: vec3<f32>) -> vec4<f32> {
    // m = 2 * |(R.x, R.y, R.z + 1)|. The guard keeps the division finite for
    // the one reflection vector that degenerates it, R = (0, 0, -1), which is
    // the direction looking straight down the reflected axis.
    let m = 2.0 * sqrt(r.x * r.x + r.y * r.y + (r.z + 1.0) * (r.z + 1.0));
    return vec4<f32>(r.x / max(m, 1e-6) + 0.5, r.y / max(m, 1e-6) + 0.5,
        0.0, 1.0);
}
` : "";

            return `${lightStruct}${uniformBlockStruct("D9FixedUniforms", layout)}
@group(0) @binding(0) var<uniform> uniforms: D9FixedUniforms;
${sphereMapHelper}${inputHelpers ? "\n" + inputHelpers : ""}

struct D9VertexOutput {
    @builtin(position) position: vec4<f32>,
${varyings.join("\n")}
${clipVaryings.join("\n")}
};

@vertex
fn d9_vs_main(${parameters.join(", ")}) -> D9VertexOutput {
${inputLines.length ? inputLines.join("\n") + "\n" : ""}    var result: D9VertexOutput;
${positionBody}
${varyings.map((_, slot) =>
            "    result.varying" + slot + " = vec4<f32>(0.0);").join("\n")}
${viewSpaceBody}${colorBody}    result.varying${VARYING_COLOR0} = out_diffuse;
    result.varying${shaderPipeline.VARYING_COLOR1} = out_specular;
${coordBody}${fogBody}${clipBody}${pointBody}    return result;
}
`;
        }

        // Fixed-function pixel stage: D3D9's texture blending cascade.
        //
        // M1/M2 hardcoded one stage of MODULATE(texture, diffuse). This walks the
        // real cascade instead: stages 0..N-1 (N ends at the first D3DTOP_DISABLE),
        // each with its own colour and alpha operation over arguments drawn from
        // diffuse, the running result, the stage's texture, D3DRS_TEXTUREFACTOR,
        // the specular colour, a scratch register and the stage's own constant --
        // which is what terrain splatting, detail texturing and light mapping are
        // actually built from. Every stage saturates its result, as D3D9 does.
        //
        // debugMode (null in normal operation) replaces the output with something
        // unambiguous, so "the screen is black" can be attributed to a specific
        // input rather than guessed at:
        //   "solid"   flat green  -- proves geometry coverage and that fragments land
        //   "color"   vertex colour only, textures ignored
        //   "texture" stage 0's texture sample only, vertex colour ignored
        //   "uv"      stage 0's texcoords as red/green -- shows whether UVs are sane
        //   "missing" flat magenta -- set per draw by debug.highlightMissingTexture
        //             to mark the draws sampling a stage with no live texture
        function buildFixedFunctionPixelShader(signature, debugMode) {
            const layout = fixedPixelUniformLayout(signature);
            const diffuse = "stage_in.varying" + VARYING_COLOR0;
            const specular = "stage_in.varying" + shaderPipeline.VARYING_COLOR1;

            // Per-stage texture declarations. Cube and volume textures reach the
            // fixed-function cascade too (environment mapping, volume fog), so the
            // WGSL texture type and the coordinate arity both come from whatever is
            // actually bound.
            const declarations = [];
            const samples = [];
            for (const stage of signature.stages) {
                if (!stage.samplesTexture) continue;
                const wgslType = { cube: "texture_cube<f32>", "3d": "texture_3d<f32>" }[
                    stage.textureType] || "texture_2d<f32>";
                declarations.push("@group(0) @binding(" + (2 + stage.index * 2) +
                    ") var d9_tex" + stage.index + ": " + wgslType + ";");
                declarations.push("@group(0) @binding(" + (3 + stage.index * 2) +
                    ") var d9_smp" + stage.index + ": sampler;");
                const coord = "stage_in.varying" +
                    (VARYING_TEXCOORD0 + stage.coordVarying);
                const components = stage.textureType === "2d" ? 2 : 3;
                let coordExpression = coord +
                    (components === 2 ? ".xy" : ".xyz");
                if (stage.projected) {
                    // D3DTTFF_PROJECTED divides by the last component of the
                    // transformed coordinate, so the divisor follows the transform's
                    // component count, not the texture's dimensionality.
                    const divisor = coord + "." +
                        ["x", "x", "y", "z", "w"][stage.transformCount || 4];
                    // Preserve the sign of q. Clamping a negative divisor with
                    // max(q, epsilon) turns every behind-projector coordinate into
                    // an enormous positive UV; Warcraft III's projected tree
                    // shadows then sample the opaque edge texel over whole terrain
                    // triangles, producing the characteristic black wedges.
                    const safeDivisor = "select(-max(abs(" + divisor +
                        "), 1e-6), max(abs(" + divisor + "), 1e-6), " +
                        divisor + " >= 0.0)";
                    coordExpression = "(" + coordExpression + " / (" +
                        safeDivisor + "))";
                }
                // D3DTOP_BUMPENVMAP: the previous stage sampled a (du, dv) pair,
                // and this stage's coordinate is displaced by it through that
                // stage's 2x2 bump matrix. The bump formats decode signed (see
                // signedNormalized in the upload path), so du/dv are used as
                // sampled rather than being rescaled from unorm here.
                if (stage.bumpFrom !== undefined && stage.textureType === "2d") {
                    const bump = "uniforms.stage_bump" + stage.bumpFrom;
                    const source = "tex" + stage.bumpFrom;
                    coordExpression = "((" + coordExpression + ") + vec2<f32>(" +
                        bump + ".x * " + source + ".r + " + bump + ".z * " +
                        source + ".g, " + bump + ".y * " + source + ".r + " +
                        bump + ".w * " + source + ".g))";
                }
                // D3DTADDRESS_MIRRORONCE: mirror about zero, then clamp. The
                // sampler is already clamp-to-edge for such an axis (see
                // ADDRESS_MODES), so taking the absolute value of the coordinate
                // here completes the mode exactly rather than approximating it --
                // abs() folds the [-1,0] half onto [0,1] and the clamp handles
                // everything beyond. Cube addressing ignores address modes, so it
                // is excluded.
                const mirrorOnceAxes = stage.textureType === "cube" ? [] :
                    (stage.textureType === "3d"
                        ? [[stage.addressU, "x"], [stage.addressV, "y"],
                           [stage.addressW, "z"]]
                        : [[stage.addressU, "x"], [stage.addressV, "y"]])
                    .filter(axis => axis[0] === 5).map(axis => axis[1]);
                if (mirrorOnceAxes.length) {
                    const axes = stage.textureType === "3d"
                        ? ["x", "y", "z"] : ["x", "y"];
                    const vector = stage.textureType === "3d"
                        ? "vec3<f32>" : "vec2<f32>";
                    coordExpression = vector + "(" + axes.map(axis =>
                        (mirrorOnceAxes.includes(axis)
                            ? "abs((" + coordExpression + ")." + axis + ")"
                            : "(" + coordExpression + ")." + axis)).join(", ") + ")";
                }
                const rawSample = signature.lodBiasUniforms
                    ? "textureSampleBias(d9_tex" + stage.index + ", d9_smp" + stage.index + ", " + coordExpression +
                        ", uniforms.sampler_lod_bias[" + Math.floor(stage.index / 4) + "][" + (stage.index & 3) + "])"
                    : stage.lodBias
                    ? "textureSampleBias(d9_tex" + stage.index + ", d9_smp" + stage.index + ", " + coordExpression + ", " + stage.lodBias.toFixed(6) + ")"
                    : "textureSample(d9_tex" + stage.index + ", d9_smp" + stage.index + ", " + coordExpression + ")";
                const sampled = shaderPipeline.sampleSwizzleExpression(rawSample, stage.sampleSwizzle);
                const borderAxes = stage.textureType === "cube" ? [] :
                    (stage.textureType === "3d"
                        ? [[stage.addressU, "x"], [stage.addressV, "y"],
                           [stage.addressW, "z"]]
                        : [[stage.addressU, "x"], [stage.addressV, "y"]])
                    .filter(axis => axis[0] === 4).map(axis => axis[1]);
                let colorKeyInside = null;
                if (borderAxes.length) {
                    // WebGPU has no border-colour sampler.  Clamp for the physical
                    // sample, then replace every coordinate outside the D3D unit
                    // domain on an axis whose addressing mode is BORDER.  This is
                    // especially important after projected division: sampling an
                    // opaque edge texel outside a shadow/fog projector turns whole
                    // terrain triangles into black masks.
                    const inside = borderAxes.map(axis => "(" + coordExpression +
                        ")." + axis + " >= 0.0 && (" + coordExpression + ")." +
                        axis + " <= 1.0").join(" && ");
                    colorKeyInside = inside;
                    const color = stage.borderColor === undefined
                        ? 0 : stage.borderColor >>> 0;
                    const component = shift =>
                        (((color >>> shift) & 0xff) / 255).toFixed(8);
                    const border = "vec4<f32>(" + component(16) + ", " +
                        component(8) + ", " + component(0) + ", " +
                        component(24) + ")";
                    samples.push("    let tex" + stage.index + " = select(" +
                        border + ", " + sampled + ", " + inside + ");");
                } else {
                    samples.push("    let tex" + stage.index + " = " + sampled + ";");
                }
                if (stage.colorKey && !stage.colorKey.indexed) {
                    const low = stage.colorKey.low >>> 0;
                    const high = stage.colorKey.high >>> 0;
                    const rgb = value => "vec3<u32>(" +
                        ((value >>> 16) & 0xff) + "u, " +
                        ((value >>> 8) & 0xff) + "u, " +
                        (value & 0xff) + "u)";
                    const withinTexture = colorKeyInside
                        ? "(" + colorKeyInside + ") && " : "";
                    samples.push("    let d9_key_rgb" + stage.index +
                        " = vec3<u32>(round(clamp(tex" + stage.index +
                        ".rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * 255.0));\n" +
                        "    if (" + withinTexture + "all(d9_key_rgb" +
                        stage.index + " >= " + rgb(low) + ") && all(d9_key_rgb" +
                        stage.index + " <= " + rgb(high) + ")) { discard; }");
                } else if (stage.colorKey && stage.colorKey.indexed) {
                    // The indexed companion view was resolved from the original
                    // indices and writes alpha zero only for indices in the key
                    // range. Comparing palette RGB here would be wrong when two
                    // entries contain the same colour.
                    samples.push("    if (tex" + stage.index +
                        ".a <= 0.0) { discard; }");
                }
                // D3DTOP_BUMPENVMAPLUMINANCE additionally modulates this stage's
                // colour by the bump texture's luminance channel, scaled and
                // biased by BUMPENVLSCALE/BUMPENVLOFFSET and clamped to [0,1].
                if (stage.bumpLuminanceFrom !== undefined) {
                    const lum = "uniforms.stage_bump_lum" + stage.bumpLuminanceFrom;
                    const source = "tex" + stage.bumpLuminanceFrom;
                    samples.push("    let tex" + stage.index + "_lit = vec4<f32>(" +
                        "tex" + stage.index + ".rgb * clamp(" + lum + ".x * " +
                        source + ".b + " + lum + ".y, 0.0, 1.0), tex" +
                        stage.index + ".a);");
                }
            }

            const luminanceScaledStages = new Set(signature.stages
                .filter(stage => stage.bumpLuminanceFrom !== undefined)
                .map(stage => stage.index));

            // The argument pool. `current` and `temp` are the two mutable registers
            // the cascade threads through, so they are read from variables the
            // stage loop below reassigns.
            function argumentExpression(argument, stageIndex, channel) {
                const selector = argument & D3DTA_SELECTMASK;
                let value;
                switch (selector) {
                case D3DTA_DIFFUSE: value = diffuse; break;
                case D3DTA_CURRENT: value = "current"; break;
                case D3DTA_TEXTURE:
                    // A stage sampled under BUMPENVMAPLUMINANCE reads the
                    // luminance-modulated copy, which is what the luminance form
                    // exists to produce.
                    value = "tex" + stageIndex +
                        (luminanceScaledStages.has(stageIndex) ? "_lit" : "");
                    break;
                case D3DTA_TFACTOR: value = "uniforms.texture_factor"; break;
                case D3DTA_SPECULAR: value = specular; break;
                case D3DTA_TEMP: value = "temp"; break;
                case D3DTA_CONSTANT: value = "uniforms.stage_constant" + stageIndex; break;
                default: value = diffuse; break;
                }
                // D3DTA_ALPHAREPLICATE broadcasts the argument's alpha over the
                // colour channels; D3DTA_COMPLEMENT inverts whatever came out.
                let expression;
                if (channel === "rgb")
                    expression = (argument & D3DTA_ALPHAREPLICATE)
                        ? "vec3<f32>(" + value + ".a)" : value + ".rgb";
                else
                    expression = value + ".a";
                if (argument & D3DTA_COMPLEMENT) {
                    expression = channel === "rgb"
                        ? "(vec3<f32>(1.0) - " + expression + ")"
                        : "(1.0 - " + expression + ")";
                }
                return expression;
            }

            let cascadeBody = "    var current = " + diffuse + ";\n" +
                // D3D9 leaves the scratch register undefined until written; zero is
                // the one starting value that cannot make an unwritten read look
                // like meaningful data.
                "    var temp = vec4<f32>(0.0);\n";
            for (const stage of signature.stages) {
                const rgb = argument => argumentExpression(argument, stage.index, "rgb");
                const alpha = argument => argumentExpression(argument, stage.index, "a");
                const blendAlpha = {
                    [D3DTOP_BLENDDIFFUSEALPHA]: diffuse + ".a",
                    [D3DTOP_BLENDTEXTUREALPHA]: "tex" + stage.index + ".a",
                    [D3DTOP_BLENDTEXTUREALPHAPM]: "tex" + stage.index + ".a",
                    [D3DTOP_BLENDFACTORALPHA]: "uniforms.texture_factor.a",
                    [D3DTOP_BLENDCURRENTALPHA]: "current.a",
                };
                const colorArgs = [rgb(stage.colorArg0), rgb(stage.colorArg1),
                    rgb(stage.colorArg2)];
                colorArgs.rgb1 = rgb(stage.colorArg1);
                colorArgs.rgb2 = rgb(stage.colorArg2);
                // The MODULATE*_ADD* family reads arg1's alpha while computing the
                // colour channel, so it needs the alpha reduction of the *colour*
                // argument rather than of D3DTSS_ALPHAARG1.
                colorArgs.alpha1 = alpha(stage.colorArg1);
                const alphaArgs = [alpha(stage.alphaArg0), alpha(stage.alphaArg1),
                    alpha(stage.alphaArg2)];
                alphaArgs.rgb1 = rgb(stage.colorArg1);
                alphaArgs.rgb2 = rgb(stage.colorArg2);
                alphaArgs.alpha1 = alpha(stage.colorArg1);
                const colorExpression = textureOpExpression(stage.colorOp,
                    "vec3<f32>", colorArgs, blendAlpha[stage.colorOp] || "0.0");
                // Bump stages perturb the following sample; ALPHAOP does not
                // overwrite the running alpha (Wine test_texture_blending).
                const alphaExpression = stage.colorOp === D3DTOP_BUMPENVMAP ||
                        stage.colorOp === D3DTOP_BUMPENVMAPLUMINANCE ? null
                    : stage.colorOp === D3DTOP_DOTPRODUCT3 ? "stage_rgb.x"
                    : stage.alphaOp === D3DTOP_DISABLE ? null
                    : textureOpExpression(stage.alphaOp, "f32", alphaArgs,
                        blendAlpha[stage.alphaOp] || "0.0");
                const destination = stage.resultArg === D3DTA_TEMP ? "temp" : "current";
                cascadeBody += "    {\n" +
                    "        let stage_rgb = clamp(" +
                        (colorExpression || rgb(stage.colorArg1)) +
                        ", vec3<f32>(0.0), vec3<f32>(1.0));\n" +
                    "        let stage_a = clamp(" +
                        (alphaExpression || destination + ".a") + ", 0.0, 1.0);\n" +
                    "        " + destination + " = vec4<f32>(stage_rgb, stage_a);\n" +
                    "    }\n";
            }

            let value = "current";
            if (debugMode === "solid") value = "vec4<f32>(0.0, 1.0, 0.0, 1.0)";
            else if (debugMode === "missing") value = "vec4<f32>(1.0, 0.0, 1.0, 1.0)";
            else if (debugMode === "orphan") value = "vec4<f32>(0.0, 1.0, 1.0, 1.0)";
            else if (debugMode === "color")
                value = "vec4<f32>(" + diffuse + ".rgb, 1.0)";
            else if (debugMode === "uv")
                value = signature.stages.length
                    ? "vec4<f32>(stage_in.varying" +
                        (VARYING_TEXCOORD0 + signature.stages[0].coordVarying) +
                        ".xy, 0.0, 1.0)"
                    : "vec4<f32>(0.0, 0.0, 1.0, 1.0)";
            else if (debugMode === "texture")
                value = signature.stages.some(stage => stage.samplesTexture)
                    ? "vec4<f32>(tex" + signature.stages.find(
                        stage => stage.samplesTexture).index + ".rgb, 1.0)"
                    : "vec4<f32>(1.0, 0.0, 0.0, 1.0)";

            // D3D9 adds the specular colour after the texture cascade, before fog.
            const specularBody = signature.specularEnable && !debugMode
                ? "    result = vec4<f32>(clamp(result.rgb + " + specular +
                  ".rgb, vec3<f32>(0.0), vec3<f32>(1.0)), result.a);\n"
                : "";
            const fogBody = fogBlendSource(signature, "uniforms", "result");
            const varyings = [];
            for (let slot = 0; slot < VARYING_COUNT; ++slot)
                varyings.push(varyingDeclaration(slot, signature.flatShading));
            const clipVaryings = [];
            let clipDiscard = "";
            for (let group = 0; group < Math.ceil(
                    (signature.clipPlaneCount || 0) / 4); ++group)
                clipVaryings.push("    @location(" + (VARYING_COUNT + group) +
                    ") clip" + group + ": vec4<f32>,");
            for (let plane = 0; plane < (signature.clipPlaneCount || 0); ++plane)
                clipDiscard += "    if (stage_in.clip" +
                    Math.floor(plane / 4) + "." + "xyzw"[plane & 3] +
                    " < 0.0) { discard; }\n";

            return `${layout.entries.length
                ? uniformBlockStruct("D9FixedPixelUniforms", layout) +
                  "\n@group(0) @binding(1) var<uniform> uniforms: D9FixedPixelUniforms;"
                : ""}
${declarations.join("\n")}

struct D9PixelInput {
    @builtin(position) position: vec4<f32>,
${varyings.join("\n")}
${clipVaryings.join("\n")}
};

@fragment
fn d9_ps_main(stage_in: D9PixelInput) -> @location(0) vec4<f32> {
${clipDiscard}
${samples.join("\n")}
${cascadeBody}    var result = ${value};
${specularBody}${alphaTestDiscard(signature.alphaTest, "result.a", "uniforms.alpha_test.x")}${fogBody}    return result;
}
`;
        }

        function signatureKey(stage, signature, debugMode) {
            return "ff" + stage + ":" + JSON.stringify([signature, debugMode || ""]);
        }
        return { fogBlendSource, normalizeTextureOperation, textureOpArguments, textureOpReadsTexture, signatureKey, VARYING_COUNT, VARYING_COLOR0, D3DSHADE_FLAT, D3DSHADE_GOURAUD, varyingDeclaration, VARYING_TEXCOORD0, FF_LOCATION_POSITION, FF_LOCATION_COLOR0, FF_LOCATION_COLOR1, FF_LOCATION_NORMAL, FF_LOCATION_TEXCOORD0, FF_LOCATION_PSIZE, FF_LOCATION_BLENDWEIGHT, FF_LOCATION_BLENDINDICES, alphaTestDiscard, fixedFunctionLocationFor, vertexInputDeclaration, declTypeInputScalar, uniformBlockLayout, uniformBlockStruct, HALF_PIXEL_OFFSET_BODY, fixedVertexUniformLayout, fixedPixelUniformLayout, fixedFogFactorExpression, textureOpExpression, buildFixedFunctionVertexShader, buildFixedFunctionPixelShader };
    }
    const api = { createGenerator };
    global.D9WGFFP = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
