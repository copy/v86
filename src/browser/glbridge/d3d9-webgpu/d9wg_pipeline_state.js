// Render pipeline and sampler state. Dynamic blend/stencil/alpha values are
// carried by recorded draws and shader constants, outside immutable cache keys.
(function(global) {
    "use strict";
    function createMethods(dependencies) {
        const {
            D3DRS_ZENABLE, D3DZB_FALSE, D3DRS_ZWRITEENABLE, COMPARE_FUNCS,
            D3DRS_ZFUNC, D3DRS_ALPHABLENDENABLE, BLEND_FACTORS, D3DRS_SRCBLEND,
            D3DRS_DESTBLEND, D3DRS_BLENDOP, D3DRS_SEPARATEALPHABLENDENABLE, D3DRS_SRCBLENDALPHA,
            D3DRS_DESTBLENDALPHA, D3DRS_BLENDOPALPHA, BLEND_OPS, D3DRS_BLENDFACTOR,
            floatFromDWORD, D3DRS_DEPTHBIAS, D3DRS_SLOPESCALEDEPTHBIAS, D3DRS_STENCILENABLE,
            STENCIL_OPS, D3DRS_STENCILFAIL, D3DRS_STENCILZFAIL, D3DRS_STENCILPASS,
            D3DRS_STENCILFUNC, D3DRS_TWOSIDEDSTENCILMODE, D3DRS_CCW_STENCILFAIL, D3DRS_CCW_STENCILZFAIL,
            D3DRS_CCW_STENCILPASS, D3DRS_CCW_STENCILFUNC, D3DRS_CULLMODE, D3DCULL_CCW,
            D3DCULL_CW, D3DRS_COLORWRITEENABLE, D3DRS_COLORWRITEENABLE1, D3DRS_COLORWRITEENABLE2,
            D3DRS_COLORWRITEENABLE3, D3DRS_ALPHATESTENABLE, D3DRS_ALPHAFUNC, D3DRS_ALPHAREF,
            D3DRS_STENCILMASK, D3DRS_STENCILWRITEMASK, D3DRS_STENCILREF, D3DRS_MULTISAMPLEANTIALIAS,
            D3DRS_MULTISAMPLEMASK, D3DRS_ADAPTIVETESS_Y, D3DFOURCC_ATOC, D3DSAMP_ADDRESSU,
            D3DSAMP_ADDRESSV, D3DSAMP_ADDRESSW, D3DSAMP_MIPFILTER, D3DSAMP_MAGFILTER,
            D3DSAMP_MINFILTER, D3DSAMP_MAXANISOTROPY, D3DSAMP_MAXMIPLEVEL, ADDRESS_MODES,
            FILTER_MODES, SHADER_STAGE_VERTEX, SHADER_STAGE_FRAGMENT, isBlendableGPUFormat,
            DEPTH_FORMAT
        } = dependencies;
        // All entries are normalized enums, booleans, finite numbers or GPU
        // format names. Explicit slots avoid cloning/stringifying the full
        // state object on every draw; dynamic values have no slot here.
        function staticStateKey(state) {
            const front = state.stencilFront, back = state.stencilBack;
            return [state.depthEnabled, state.depthWrite, state.depthCompare,
                state.depthBias, state.depthBiasSlopeScale, state.blendEnabled,
                state.srcFactor, state.dstFactor, state.blendOp, state.alphaSrcFactor,
                state.alphaDstFactor, state.alphaBlendOp, state.cullMode, state.writeMask,
                state.hasDepth, state.stencilEnabled,
                front.compare, front.failOp, front.depthFailOp, front.passOp,
                back.compare, back.failOp, back.depthFailOp, back.passOp,
                state.stencilReadMask, state.stencilWriteMask,
                state.extraWriteMasks.join("."), state.colorFormats.join("."),
                state.opaqueTargetMask || 0,
                state.sampleCount, state.sampleMask, state.alphaToCoverage].join("|");
        }
        return {
            // ---- draw pipeline ----

            // Distils the render states a WebGPU render pipeline is allowed to
            // depend on into a small plain object. WebGPU bakes depth/blend/cull
            // into the immutable pipeline (unlike D3D9, where they are free-
            // floating device state), so this is also exactly the set that has
            // to participate in the pipeline cache key.
            pipelineStateFor(state, targets) {
                const rs = state.renderStates;
                const hasDepth = targets ? targets.hasDepth : !!state.hasDepth;
                const forceSolid = !!this.debug.forceSolidAllDraws;
                const get = (id, fallback) => {
                    const value = rs.get(id);
                    return value === undefined ? fallback : value;
                };

                // D3DRS_ZENABLE defaults to on whenever a depth buffer exists;
                // with no depth attachment there is nothing to test against.
                const depthEnabled = !forceSolid && hasDepth
                    && get(D3DRS_ZENABLE, 1) !== D3DZB_FALSE;
                const depthWrite = !forceSolid &&
                    get(D3DRS_ZWRITEENABLE, 1) !== 0;
                const depthCompare = (forceSolid || this.debug.disableDepthTest)
                    ? "always"
                    : (COMPARE_FUNCS[get(D3DRS_ZFUNC, 4)] || "less-equal");

                const blendEnabled = !forceSolid &&
                    get(D3DRS_ALPHABLENDENABLE, 0) !== 0;
                const resolveBlend = (rawSrc, rawDst) => {
                    // The legacy BOTH* source values override both halves of the
                    // pair. D3D9 exposes them as one enum; WebGPU exposes the two
                    // factors separately, so the mapping is exact once resolved.
                    if (rawSrc === 12)
                        return { src: "src-alpha", dst: "one-minus-src-alpha",
                            valid: true };
                    if (rawSrc === 13)
                        return { src: "one-minus-src-alpha", dst: "src-alpha",
                            valid: true };
                    return { src: BLEND_FACTORS[rawSrc], dst: BLEND_FACTORS[rawDst],
                        valid: !!BLEND_FACTORS[rawSrc] && !!BLEND_FACTORS[rawDst] };
                };
                // D3D9 starts at ONE/ZERO.  Using SRCALPHA/INVSRCALPHA here was
                // mostly hidden while blending stayed disabled, but it changes an
                // app that enables blending before choosing new factors from an
                // overwrite into a translucent UI/overlay pass.
                const rawColorSrc = get(D3DRS_SRCBLEND, 2);
                const rawColorDst = get(D3DRS_DESTBLEND, 1);
                const rawColorOp = get(D3DRS_BLENDOP, 1);
                const colorBlend = resolveBlend(rawColorSrc, rawColorDst);
                const separateAlpha =
                    get(D3DRS_SEPARATEALPHABLENDENABLE, 0) !== 0;
                const rawAlphaSrc = separateAlpha
                    ? get(D3DRS_SRCBLENDALPHA, 2) : rawColorSrc;
                const rawAlphaDst = separateAlpha
                    ? get(D3DRS_DESTBLENDALPHA, 1) : rawColorDst;
                const rawAlphaOp = separateAlpha
                    ? get(D3DRS_BLENDOPALPHA, 1) : rawColorOp;
                const alphaBlend = separateAlpha
                    ? resolveBlend(rawAlphaSrc, rawAlphaDst) : colorBlend;
                const blendOp = BLEND_OPS[rawColorOp] || "add";
                const alphaBlendOp = BLEND_OPS[rawAlphaOp] || "add";
                // D3DBLENDOP_MIN/MAX ignore the factors; WebGPU requires them
                // to be ONE (D3D9's default DESTBLEND is ZERO)
                const factorless = op => op === "min" || op === "max";
                const srcFactor = factorless(blendOp) ? "one" : colorBlend.src || "src-alpha";
                const dstFactor = factorless(blendOp) ? "one" : colorBlend.dst || "one-minus-src-alpha";
                const alphaSrcFactor = factorless(alphaBlendOp) ? "one" : alphaBlend.src || "one";
                const alphaDstFactor = factorless(alphaBlendOp) ? "one" : alphaBlend.dst || "zero";
                if (blendEnabled && (!colorBlend.valid || !alphaBlend.valid ||
                        !BLEND_OPS[rawColorOp] || !BLEND_OPS[rawAlphaOp])) {
                    ++this.stats.drawsWithUnmappedBlend;
                    this.warnOnce("unmapped-blend-" + [rawColorSrc, rawColorDst,
                        rawColorOp, rawAlphaSrc, rawAlphaDst, rawAlphaOp].join("-"),
                        "a draw asks for a blend mode with no WebGPU equivalent; " +
                        "it silently falls back to src-alpha/inv-src-alpha, which " +
                        "renders as plausible-but-wrong compositing", {
                            D3DRS_SRCBLEND: rawColorSrc, mappedSrc: colorBlend.src,
                            D3DRS_DESTBLEND: rawColorDst, mappedDst: colorBlend.dst,
                            D3DRS_BLENDOP: rawColorOp, mappedOp: BLEND_OPS[rawColorOp],
                        });
                }
                const blendColor = get(D3DRS_BLENDFACTOR, 0xffffffff) >>> 0;
                const blendConstant = {
                    r: ((blendColor >>> 16) & 0xff) / 255,
                    g: ((blendColor >>> 8) & 0xff) / 255,
                    b: (blendColor & 0xff) / 255,
                    a: ((blendColor >>> 24) & 0xff) / 255,
                };

                // D3D9 stores both bias states as float bit patterns in DWORDs.
                // Its constant bias is in normalised depth units; depth24 WebGPU
                // expresses the same offset in one-ULP integer steps.
                const rawDepthBias = floatFromDWORD(get(D3DRS_DEPTHBIAS, 0));
                const scaledDepthBias = Number.isFinite(rawDepthBias)
                    ? Math.round(rawDepthBias * 0x1000000) : 0;
                const depthBias = Math.max(-0x80000000,
                    Math.min(0x7fffffff, scaledDepthBias));
                const rawSlopeBias = floatFromDWORD(
                    get(D3DRS_SLOPESCALEDEPTHBIAS, 0));
                const depthBiasSlopeScale = Number.isFinite(rawSlopeBias)
                    ? rawSlopeBias : 0;

                const stencilEnabled = !forceSolid && hasDepth &&
                    get(D3DRS_STENCILENABLE, 0) !== 0;
                const stencilFace = (failId, depthFailId, passId, funcId) => ({
                    compare: COMPARE_FUNCS[get(funcId, 8)] || "always",
                    failOp: STENCIL_OPS[get(failId, 1)] || "keep",
                    depthFailOp: STENCIL_OPS[get(depthFailId, 1)] || "keep",
                    passOp: STENCIL_OPS[get(passId, 1)] || "keep",
                });
                const stencilFront = stencilFace(D3DRS_STENCILFAIL,
                    D3DRS_STENCILZFAIL, D3DRS_STENCILPASS, D3DRS_STENCILFUNC);
                const stencilBack = get(D3DRS_TWOSIDEDSTENCILMODE, 0) !== 0
                    ? stencilFace(D3DRS_CCW_STENCILFAIL, D3DRS_CCW_STENCILZFAIL,
                        D3DRS_CCW_STENCILPASS, D3DRS_CCW_STENCILFUNC)
                    : stencilFront;

                // D3D9's front face is clockwise, so D3DCULL_CW means "cull the
                // front" and D3DCULL_CCW (its default) means "cull the back".
                const cullValue = get(D3DRS_CULLMODE, D3DCULL_CCW);
                let cullMode = "none";
                if (!forceSolid && !this.debug.disableCull) {
                    if (cullValue === D3DCULL_CW) cullMode = "front";
                    else if (cullValue === D3DCULL_CCW) cullMode = "back";
                }

                // D3DCOLORWRITEENABLE's RED/GREEN/BLUE/ALPHA bits happen to be
                // 1/2/4/8, matching GPUColorWrite exactly.
                const writeMask = forceSolid ? 0xF
                    : get(D3DRS_COLORWRITEENABLE, 0xF) & 0xF;
                const extraWriteMasks = forceSolid ? [0xF, 0xF, 0xF] : [
                        get(D3DRS_COLORWRITEENABLE1, 0xF) & 0xF,
                        get(D3DRS_COLORWRITEENABLE2, 0xF) & 0xF,
                        get(D3DRS_COLORWRITEENABLE3, 0xF) & 0xF,
                    ];

                // Alpha test is a shader construct here, not pipeline state, so
                // it travels with the rest of the immutable state and lands in
                // the fragment key rather than in the GPURenderPipeline itself.
                const alphaTest = {
                    enabled: !forceSolid &&
                        get(D3DRS_ALPHATESTENABLE, 0) !== 0,
                    func: get(D3DRS_ALPHAFUNC, 8) & 0xF,
                    reference: get(D3DRS_ALPHAREF, 0) & 0xFF,
                };

                const sampleCount = (targets && targets.sampleCount) || 1;
                return { depthEnabled, depthWrite, depthCompare, depthBias,
                    depthBiasValue: Number.isFinite(rawDepthBias) ? rawDepthBias : 0,
                    depthBiasSlopeScale, blendEnabled, srcFactor, dstFactor,
                    blendOp, alphaSrcFactor, alphaDstFactor, alphaBlendOp,
                    blendConstant, cullMode, writeMask, alphaTest, hasDepth,
                    stencilEnabled, stencilFront, stencilBack,
                    stencilReadMask: get(D3DRS_STENCILMASK, 0xffffffff) >>> 0,
                    stencilWriteMask: get(D3DRS_STENCILWRITEMASK, 0xffffffff) >>> 0,
                    stencilReference: get(D3DRS_STENCILREF, 0) >>> 0,
                    extraWriteMasks,
                    // Every colour attachment of the pass this pipeline runs in has
                    // to appear in its fragment targets, in order -- WebGPU matches
                    // them positionally, so an MRT pass needs the whole list baked
                    // into the pipeline and therefore into its cache key.
                    colorFormats: targets ? targets.formats : [this.format],
                    opaqueTargetMask: targets ? targets.opaqueTargetMask : 0,
                    // WebGPU takes the sample count on the pipeline as well as on
                    // the attachments, and the two must agree; without this the
                    // pipeline defaulted to 1 and every draw into a multisampled
                    // target failed validation.
                    sampleCount,
                    // D3DRS_MULTISAMPLEMASK maps straight onto WebGPU's
                    // multisample mask. D3DRS_MULTISAMPLEANTIALIAS = FALSE makes
                    // D3D write every sample with the pixel's value; WebGPU's
                    // coverage is fixed for the pass, so every covered sample is
                    // written (deviation: the draw's edges stay antialiased).
                    // Writing sample 0 only would resolve to a quarter of it.
                    sampleMask: sampleCount > 1 && get(D3DRS_MULTISAMPLEANTIALIAS, 1) !== 0
                        ? (get(D3DRS_MULTISAMPLEMASK, 0xffffffff) >>> 0)
                        : 0xffffffff,
                    // Only meaningful on a multisampled target -- with one sample
                    // there is no coverage to spread an alpha value over, and
                    // WebGPU rejects the combination outright.
                    alphaToCoverage: sampleCount > 1 &&
                        (get(D3DRS_ADAPTIVETESS_Y, 0) >>> 0) === D3DFOURCC_ATOC };
            },


            // ---- independent sampler state (plan 4.4/12) ----
            //
            // D3D9 splits sampling parameters out of texture-stage state into
            // SetSamplerState, which maps almost one-to-one onto an immutable
            // GPUSampler. M1 recorded these values but sampled every texture with
            // one hardcoded linear/repeat sampler created alongside the texture;
            // they now drive a cache keyed by the parameter tuple, so a stage's
            // sampler follows the app's state rather than the texture it happens
            // to be bound to.
            samplerFor(state, stage, unfilterable, texture) {
                const get = (id, fallback) => {
                    const value = state.samplerStates.get(stage * 64 + id);
                    return value === undefined ? fallback : value;
                };
                // D3D9 defaults: WRAP addressing, POINT min/mag, no mip filtering.
                const addressU = get(D3DSAMP_ADDRESSU, 1);
                const addressV = get(D3DSAMP_ADDRESSV, 1);
                const addressW = get(D3DSAMP_ADDRESSW, 1);
                const requestedMipFilter = get(D3DSAMP_MIPFILTER, 0);
                const magFilter = unfilterable ? 1 : get(D3DSAMP_MAGFILTER, 1);
                const minFilter = unfilterable ? 1 : get(D3DSAMP_MINFILTER, 1);
                const mipFilter = unfilterable && requestedMipFilter !== 0
                    ? 1 : requestedMipFilter;
                let maxAnisotropy = get(D3DSAMP_MAXANISOTROPY, 1) | 0;
                if (unfilterable) maxAnisotropy = 1;
                // Resource LOD always limits the most detailed available mip.
                // MAXMIPLEVEL applies only when mip filtering is enabled (Wine
                // visual.c, test_mipmap). With NONE, only resource LOD selects
                // the single sampled level. Clamp to the actual chain.
                const levels = Math.max(1, (texture && texture.levelCount) || 1);
                const lodFloor = Math.min(levels - 1,
                    Math.max(mipFilter === 0 ? 0 : get(D3DSAMP_MAXMIPLEVEL, 0) >>> 0,
                        (texture && texture.lod) || 0));
                // NV40 has independent fractional LOD clamps. Its frontend
                // uses private sampler slots 62/63 (f32 bits); D3D callers
                // leave them absent and retain their MAXMIPLEVEL/SetLOD rules.
                const nativeClamp = state.samplerStates.has(stage * 64 + 62) || state.samplerStates.has(stage * 64 + 63);
                const finiteLod = (raw, fallback) => { const value=floatFromDWORD(raw);return Number.isFinite(value)?value:fallback; };
                const minimum = Math.min(levels-1,Math.max(lodFloor,finiteLod(get(62,0),0)));
                const maximum = Math.max(minimum,Math.min(levels-1,finiteLod(get(63,0x42000000),levels-1)));
                const key = [addressU, addressV, addressW, magFilter, minFilter,
                    mipFilter, maxAnisotropy, lodFloor,
                    nativeClamp ? minimum : "",nativeClamp ? maximum : "",
                    this.debug.forceMipLevel0 ? "top" : "",
                    unfilterable ? "non-filtering" : "filtering"].join(",");
                const cached = this.samplerCache.get(key);
                if (cached) { ++this.stats.samplerHits; return cached; }

                const descriptor = {
                    addressModeU: ADDRESS_MODES[addressU] || "repeat",
                    addressModeV: ADDRESS_MODES[addressV] || "repeat",
                    addressModeW: ADDRESS_MODES[addressW] || "repeat",
                    magFilter: FILTER_MODES[magFilter] || "nearest",
                    minFilter: FILTER_MODES[minFilter] || "nearest",
                    // D3DTEXF_NONE means "use only the top mip level", which is
                    // what clamping the LOD range to 0 expresses in WebGPU.
                    mipmapFilter: mipFilter === 2 ? "linear" : "nearest",
                };
                if (this.debug.forceMipLevel0) {
                    descriptor.lodMinClamp = 0;
                    descriptor.lodMaxClamp = 0;
                } else if (mipFilter === 0) {
                    // D3DTEXF_NONE means "sample one level and do not blend
                    // between levels". That level is the most detailed one still
                    // allowed, which is the floor -- not level 0, once
                    // SetLOD has raised it; MAXMIPLEVEL is ignored with NONE.
                    descriptor.lodMinClamp = lodFloor;
                    descriptor.lodMaxClamp = lodFloor;
                } else if (nativeClamp) {
                    descriptor.lodMinClamp = minimum;
                    descriptor.lodMaxClamp = maximum;
                } else if (lodFloor > 0) {
                    descriptor.lodMinClamp = lodFloor;
                }
                // WebGPU only accepts maxAnisotropy > 1 when all three filters are
                // linear, so anisotropy is dropped rather than forcing filters the
                // app did not ask for.
                if (!unfilterable && maxAnisotropy > 1 &&
                        descriptor.magFilter === "linear" &&
                        descriptor.minFilter === "linear" &&
                        descriptor.mipmapFilter === "linear" && mipFilter !== 0)
                    descriptor.maxAnisotropy = Math.min(16, maxAnisotropy);
                if (addressU === 4 || addressV === 4 || addressW === 4)
                    this.warnOnce("address-border", "D3DTADDRESS_BORDER has no " +
                        "native WebGPU sampler mode; the physical sample clamps " +
                        "to edge and the fixed-function fragment shader replaces " +
                        "out-of-domain coordinates with D3DSAMP_BORDERCOLOR");
                const sampler = this.device.createSampler(descriptor);
                ++this.stats.samplersCreated;
                this.samplerCache.set(key, sampler);
                return sampler;
            },


            pipelineFor(program, pipelineState, topology, stripIndexFormat) {
                // A resolved program is immutable. Serialize its large module
                // and binding-layout signatures once, then use a short state
                // tuple per draw. The authoritative global cache is checked on
                // hits so deletion/clearing never resurrects a retired pipeline.
                if (!program.pipelineVariants) {
                    program.pipelineVariants = new Map();
                    program.pipelineLayoutKey = JSON.stringify([
                        program.vertexKey, program.fragmentKey, program.vertexBuffers,
                        program.samplerIndices.map(index => [index,
                            (program.samplerDimensions && program.samplerDimensions[index]) || "2d",
                            (program.samplerBindingTypes && program.samplerBindingTypes[index]) || "filterable"]),
                        (program.vertexSamplers || []).map(sampler => [sampler.index, sampler.type, sampler.bindingType]),
                    ]);
                }
                const variantKey = topology + "|" + (stripIndexFormat || "") + "|" + staticStateKey(pipelineState);
                const cached = program.pipelineVariants.get(variantKey);
                const key = cached ? cached.key : program.pipelineLayoutKey + "|" + variantKey;
                let pipeline = this.pipelineCache.get(key);
                if (pipeline && (!cached || cached.pipeline !== pipeline))
                    program.pipelineVariants.set(variantKey, { key, pipeline });
                if (pipeline) {
                    if (this.diagnosticsEnabled && !pipeline._d9wgDiagnostic)
                        this.capturePipelineDiagnostic(pipeline, program, topology, stripIndexFormat, pipelineState);
                    ++this.stats.pipelineHits;return pipeline;
                }

                // Binding 0 is the vertex stage's constant buffer (or the
                // fixed-function transform block, which occupies the same slot),
                // binding 1 the pixel stage's; samplers take 2+2n / 3+2n, the
                // numbering d3d9_shader_pipeline.js emits.
                const bindGroupEntries = [
                    { binding: 0, visibility: SHADER_STAGE_VERTEX,
                      buffer: { type: program.vertexReflection && program.vertexReflection.constantBufferType || "uniform",
                          hasDynamicOffset: true } },
                ];
                if (program.pixelUniformBytes)
                    bindGroupEntries.push({ binding: 1, visibility: SHADER_STAGE_FRAGMENT,
                        buffer: { type: "uniform", hasDynamicOffset: true } });
                for (const index of program.samplerIndices) {
                    // The view dimension has to be declared here, not left to
                    // default to "2d": WebGPU checks the layout against what the
                    // shader declares, so a texture_cube<f32> binding paired with a
                    // default 2D layout entry fails pipeline creation outright. naga
                    // cannot catch that -- it validates one module, not the pairing.
                    const dimension = (program.samplerDimensions &&
                        program.samplerDimensions[index]) || "2d";
                    const bindingType = program.samplerBindingTypes &&
                        program.samplerBindingTypes[index];
                    const unfilterable = bindingType === "unfilterable";
                    const compare = bindingType === "depth-compare";
                    const fetch = bindingType === "depth-fetch";
                    const depth = compare || fetch;
                    // Both depth modes are sampleType "depth"; only the comparison
                    // one takes a comparison sampler. A raw fetch reads the stored
                    // value through an ordinary non-filtering sampler, because
                    // WebGPU will not filter a depth texture without comparing.
                    bindGroupEntries.push(
                        { binding: 2 + index * 2, visibility: SHADER_STAGE_FRAGMENT,
                          texture: { viewDimension: depth ? "2d" : dimension,
                              sampleType: depth ? "depth"
                                  : (unfilterable ? "unfilterable-float" : "float") } },
                        { binding: 3 + index * 2, visibility: SHADER_STAGE_FRAGMENT,
                          sampler: { type: compare ? "comparison"
                              : ((fetch || unfilterable) ? "non-filtering"
                                  : "filtering") } });
                }
                for (const sampler of program.vertexSamplers || []) {
                    const unfilterable = sampler.bindingType === "unfilterable";
                    bindGroupEntries.push(
                        { binding: sampler.textureBinding,
                          visibility: SHADER_STAGE_VERTEX,
                          texture: { viewDimension: sampler.type,
                              sampleType: unfilterable
                                  ? "unfilterable-float" : "float" } },
                        { binding: sampler.samplerBinding,
                          visibility: SHADER_STAGE_VERTEX,
                          sampler: { type: unfilterable
                              ? "non-filtering" : "filtering" } });
                }
                const bindGroupLayout = this.device.createBindGroupLayout(
                    { entries: bindGroupEntries });

                // D3DRS_COLORWRITEENABLE1/2/3 mask the extra MRT attachments; slot
                // 0 uses D3DRS_COLORWRITEENABLE. An attachment the fragment shader
                // does not write still needs an entry, or WebGPU rejects the
                // pipeline against the pass -- with a zero write mask, which is
                // also what D3D leaves in it. The fixed-function stage writes
                // location 0 only; a translated one 0 up to its highest oC#.
                const outputs = program.pixelReflection && program.pixelReflection.colorOutputs.length
                    ? Math.max(...program.pixelReflection.colorOutputs) + 1 : 1;
                const colorTargets = (pipelineState.colorFormats || [this.format])
                    .map((format, index) => {
                        if (!format) return null;
                        const target = { format, writeMask: index >= outputs ? 0
                            : index === 0 ? pipelineState.writeMask
                                : pipelineState.extraWriteMasks[index - 1] };
                        if (pipelineState.blendEnabled &&
                                isBlendableGPUFormat(format, this.deviceFeatures)) {
                            // A8 and X8 can share a physical RGBA texture format.
                            // Read destination-alpha factors from the logical D3D
                            // target, independently for every MRT attachment.
                            const opaque = (pipelineState.opaqueTargetMask & (1 << index)) !== 0;
                            const factor = (value, alpha = false) => !opaque ? value
                                : value === "dst-alpha" ? "one"
                                : value === "one-minus-dst-alpha" ? "zero"
                                : value === "src-alpha-saturated" ? (alpha ? "one" : "zero")
                                : value;
                            target.blend = {
                                color: { srcFactor: factor(pipelineState.srcFactor),
                                         dstFactor: factor(pipelineState.dstFactor),
                                         operation: pipelineState.blendOp },
                                alpha: { srcFactor: factor(pipelineState.alphaSrcFactor, true),
                                         dstFactor: factor(pipelineState.alphaDstFactor, true),
                                         operation: pipelineState.alphaBlendOp },
                            };
                        } else if (pipelineState.blendEnabled &&
                                !isBlendableGPUFormat(format, this.deviceFeatures)) {
                            this.warnOnce("float32-blend-disabled-" + format,
                                "D3D blending was requested for a 32-bit float " +
                                "render target, but this WebGPU device does not " +
                                "expose float32-blendable; the draw is emitted " +
                                "without blending instead of creating an invalid " +
                                "render pipeline", { format });
                        }
                        return target;
                    });
                if (program.queryCounter)
                    colorTargets.push({format: "r16float", writeMask: 1, blend: {
                        color: {srcFactor: "one", dstFactor: "one", operation: "add"},
                        alpha: {srcFactor: "one", dstFactor: "one", operation: "add"},
                    }});
                const primitive = { topology,
                    cullMode: program.pointExpansion ? "none" : pipelineState.cullMode,
                    frontFace: "cw" };
                const triangles = topology === "triangle-list" || topology === "triangle-strip";
                // WebGPU needs to know the restart-index width up front for an
                // indexed strip draw; it must be absent for every other topology.
                if (stripIndexFormat) primitive.stripIndexFormat = stripIndexFormat;
                const descriptor = {
                    layout: this.device.createPipelineLayout(
                        { bindGroupLayouts: [bindGroupLayout] }),
                    vertex: {
                        module: program.vertexModule, entryPoint: "d9_vs_main",
                        buffers: program.vertexBuffers.map(layout =>
                            ({ arrayStride: layout.arrayStride,
                               stepMode: layout.stepMode || "vertex",
                               attributes: layout.attributes })),
                    },
                    fragment: { module: program.fragmentModule, entryPoint: "d9_ps_main",
                        targets: colorTargets },
                    primitive,
                };
                if (pipelineState.sampleCount > 1) {
                    descriptor.multisample = {
                        count: pipelineState.sampleCount,
                        mask: pipelineState.sampleMask,
                        alphaToCoverageEnabled: pipelineState.alphaToCoverage,
                    };
                }
                // The pipeline must declare a depthStencil state whenever the
                // pass it runs in has a depth attachment, even for a draw that
                // does no depth testing -- hence depthCompare "always" plus
                // depthWriteEnabled false rather than omitting the block.
                if (pipelineState.hasDepth) {
                    descriptor.depthStencil = {
                        format: DEPTH_FORMAT,
                        depthWriteEnabled: pipelineState.depthEnabled
                            ? pipelineState.depthWrite : false,
                        depthCompare: pipelineState.depthEnabled
                            ? pipelineState.depthCompare : "always",
                        // The constant bias is added to depth in the pixel shader
                        // (every topology; hardware bias scales with the primitive's
                        // depth exponent on some GPUs). Only the slope term stays here.
                        depthBias: 0,
                        depthBiasSlopeScale: triangles ? pipelineState.depthBiasSlopeScale : 0,
                        stencilFront: pipelineState.stencilEnabled
                            ? pipelineState.stencilFront : {},
                        stencilBack: pipelineState.stencilEnabled
                            ? pipelineState.stencilBack : {},
                        stencilReadMask: pipelineState.stencilEnabled
                            ? pipelineState.stencilReadMask : 0,
                        stencilWriteMask: pipelineState.stencilEnabled
                            ? pipelineState.stencilWriteMask : 0,
                    };
                }
                // A rejected pipeline stays in the cache, marked, so that later
                // draws skip it instead of creating it again every frame
                const created = this.gpuErrors.scoped("render pipeline",
                    () => this.device.createRenderPipeline(descriptor),
                    { vertex: program.vertexKey, fragment: program.fragmentKey, topology });
                pipeline = created.object;
                created.checked.then(error => {
                    if (!error) return;
                    pipeline._d9wgRejected = error;
                    ++this.stats.pipelinesRejected;
                });
                pipeline._bindGroupLayout = bindGroupLayout;
                pipeline._d9wgId = this.objectId(pipeline);
                if (this.diagnosticsEnabled)
                    this.capturePipelineDiagnostic(pipeline, program, topology, stripIndexFormat, pipelineState);
                ++this.stats.pipelineCreations;
                this.pipelineCache.set(key, pipeline);
                program.pipelineVariants.set(variantKey, { key, pipeline });
                return pipeline;
            },
        };
    }
    const api = { createMethods };
    global.D9WGPipelineState = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
