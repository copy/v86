// Resource lifecycle, uploads, palettes and views. Dependencies are supplied
// once at module installation; all mutable state remains on the active owner.
(function(global) {
    "use strict";
    function createMethods(dependencies) {
        const {
            D9WG, RESOURCE_BUFFER_INDEX, BUFFER_USAGE_INDEX, BUFFER_USAGE_COPY_DST, BUFFER_USAGE_VERTEX,
            alignUp, D3DFMT_INDEX32, D3DUSAGE_DEPTHSTENCIL, isFourCCDepthFormat, D3DUSAGE_RENDERTARGET,
            D9WG_USAGE_DDRAW_INDEXED, isPalettizedFormat, sampleCountForD3D, D3DUSAGE_AUTOGENMIPMAP, fullMipLevelCount,
            DEPTH_FORMAT, formatToGPU, isRenderableGPUFormat, srgbSiblingOf, TEXTURE_USAGE_RENDER_ATTACHMENT,
            TEXTURE_USAGE_TEXTURE_BINDING, TEXTURE_USAGE_COPY_DST, TEXTURE_USAGE_COPY_SRC, isCompressedFormat, RESOURCE_TEXTURE_2D,
            gpuBytesPerTexel, expandRowToGPU, blockAlignedCopyExtent, RESOURCE_TEXTURE_CUBE, RESOURCE_TEXTURE_VOLUME,
            RESOURCE_VERTEX_DECLARATION, D9WGStreamError, shaderPipeline, RESOURCE_VERTEX_SHADER, RESOURCE_PIXEL_SHADER, BUFFER_USAGE_UNIFORM, PALETTE_ENTRIES, PALETTE_BYTES
        } = dependencies;
        return {
            // The GPU copy of the palette a surface samples through, or null when
            // the guest has not sent one yet.
            ddPaletteBufferFor(resource, encoder) {
                const index = resource.ddPaletteIndex;
                if (index === undefined) return null;
                const key = (resource.deviceHandle || 0) + ":" + index;
                const rgba = this.palettes && this.palettes.get(key);
                if (!rgba) return null;
                if (!this.ddPaletteBuffers) this.ddPaletteBuffers = new Map();
                let entry = this.ddPaletteBuffers.get(key);
                if (!entry) {
                    entry = {
                        buffer: this.device.createBuffer({
                            label: "DirectDraw palette " + key,
                            size: PALETTE_BYTES,
                            usage: BUFFER_USAGE_UNIFORM | BUFFER_USAGE_COPY_DST,
                        }),
                        serial: -1,
                    };
                    this.ddPaletteBuffers.set(key, entry);
                }
                const serial = (this.ddPaletteSerials &&
                    this.ddPaletteSerials.get(key)) || 0;
                if (entry.serial !== serial) {
                    const floats = new Float32Array(PALETTE_ENTRIES * 4);
                    for (let i = 0; i < PALETTE_ENTRIES; ++i) {
                        floats[i * 4] = rgba[i * 4] / 255;
                        floats[i * 4 + 1] = rgba[i * 4 + 1] / 255;
                        floats[i * 4 + 2] = rgba[i * 4 + 2] / 255;
                        floats[i * 4 + 3] = rgba[i * 4 + 3] / 255;
                    }
                    const bytes = new Uint8Array(floats.buffer);
                    if (encoder) this.encodeBufferUpload(encoder, entry.buffer, bytes);
                    else this.stageBufferUpload(entry.buffer, 0, bytes);
                    entry.serial = serial;
                    this.stats.ddPaletteUploads =
                        (this.stats.ddPaletteUploads || 0) + 1;
                }
                return entry.buffer;
            },

            // DirectDraw keeps P8 surfaces as r8uint so blits and readback preserve
            // the application's indices.  Fixed-function D3D sampling, however,
            // needs filterable colours. Build a companion RGBA texture from the
            // GPU index image and the palette attached to this *surface* (not the
            // device-global D3D9 palette). A keyed companion sets alpha to zero by
            // comparing the original index, so duplicate palette colours cannot
            // make an unrelated texel transparent.
            ddIndexedSampleViewFor(resource, colorKey) {
                if (!resource || !resource.ddIndexed) return null;
                const paletteIndex = resource.ddPaletteIndex;
                const paletteKey = paletteIndex === undefined ? null
                    : (resource.deviceHandle || 0) + ":" + paletteIndex;
                const paletteSerial = paletteKey && this.ddPaletteSerials
                    ? (this.ddPaletteSerials.get(paletteKey) || 0) : 0;
                const keyLow = colorKey ? colorKey.low & 0xff : -1;
                const keyHigh = colorKey ? colorKey.high & 0xff : -1;
                const variant = colorKey ? "keyed" : "plain";
                const serial = [resource.ddContentSerial || 0, paletteKey || "-",
                    paletteSerial, keyLow, keyHigh].join(":");
                if (!resource.ddSampleViews) resource.ddSampleViews = new Map();
                const old = resource.ddSampleViews.get(variant);
                if (old && old.serial === serial) return old.view;

                const layers = resource.layerCount || 1;
                const texture = old ? old.texture : this.device.createTexture({
                    label: "DirectDraw indexed D3D sample view",
                    size: { width: resource.width, height: resource.height, depthOrArrayLayers: layers },
                    format: "rgba8unorm", mipLevelCount: Math.max(1, resource.levelCount || 1),
                    usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_TEXTURE_BINDING,
                });
                const entry = old || { texture, view: texture.createView({
                    dimension: resource.textureType === "cube" ? "cube" : "2d",
                }) };
                entry.serial = serial;
                resource.ddSampleViews.set(variant, entry);
                const paletteBuffer = this.ddPaletteBufferFor(resource);
                const frame = this.ensureFrame();
                for (let level = 0; level < Math.max(1, resource.levelCount || 1); ++level) {
                    const width = Math.max(1, resource.width >> level), height = Math.max(1, resource.height >> level);
                    for (let layer = 0; layer < layers; ++layer) {
                        frame.ops.push({ kind: "ddblit", sourceKind: "index", destinationKind: "float",
                            sourceView: this.blitSourceView(resource, level, layer),
                            destinationView: texture.createView({ dimension: "2d", baseMipLevel: level, mipLevelCount: 1,
                                baseArrayLayer: layer, arrayLayerCount: 1 }),
                            destinationFormat: "rgba8unorm", sourceRect: [0, 0, 1, 1], sourceSize: [width, height],
                            viewport: [0, 0, width, height], paletteBuffer, filterPoint: true,
                            colorKey: colorKey || null, keyToAlpha: !!colorKey });
                    }
                }
                resource.frameReferenced = frame.serial;
                this.stats.ddIndexedSampleResolves =
                    (this.stats.ddIndexedSampleResolves || 0) + 1;
                return entry.view;
            },

            retireResourceState(resource) {
                if (!resource) return;
                this.retireGPUObject(resource.gpuBuffer);
                this.retireGPUObject(resource.gpuTexture);
                this.retireGPUObject(resource.msaaTexture);
                // Palettised sample resources have companion textures. A
                // SESSION_END bypasses per-resource opcodes, so its companion
                // textures have to participate in the process-wide teardown too.
                if (resource.ddSampleViews) {
                    for (const entry of resource.ddSampleViews.values())
                        this.retireGPUObject(entry && entry.texture);
                    resource.ddSampleViews.clear();
                }
                resource.destroyed = true;
            },

            retirePaletteCachesForDevice(handle) {
                const prefix = (handle >>> 0) + ":";
                for (const [key, entry] of this.ddPaletteBuffers) {
                    if (!key.startsWith(prefix)) continue;
                    this.retireGPUObject(entry && entry.buffer);
                    this.ddPaletteBuffers.delete(key);
                }
                for (const key of this.ddPaletteSerials.keys())
                    if (key.startsWith(prefix)) this.ddPaletteSerials.delete(key);
                for (const key of this.palettes.keys())
                    if (key.startsWith(prefix)) this.palettes.delete(key);
            },

            // ---- resources ----

            onCreateBuffer(bytes, view, offset) {
                const handle = view.getUint32(offset + D9WG.F.CreateBuffer.resource_handle, true);
                const kind = view.getUint32(offset + D9WG.F.CreateBuffer.resource_kind, true);
                const byteCount = view.getUint32(offset + D9WG.F.CreateBuffer.byte_count, true);
                const format = view.getUint32(offset + D9WG.F.CreateBuffer.fvf, true); // index format, for INDEX kind
                const usage = kind === RESOURCE_BUFFER_INDEX
                    ? BUFFER_USAGE_INDEX | BUFFER_USAGE_COPY_DST
                    : BUFFER_USAGE_VERTEX | BUFFER_USAGE_COPY_DST;
                const alignedSize = Math.max(4, alignUp(byteCount, 4));
                const gpuBuffer = this.device.createBuffer({
                    size: alignedSize,
                    usage,
                });
                this.resources.set(handle, {
                    kind, gpuBuffer, byteCount,
                    // CPU mirror of the buffer's full (aligned) content. D3D9's
                    // Lock/Unlock byte ranges can start and end anywhere, but
                    // WebGPU's writeBuffer requires both the destination offset
                    // and the size to be a multiple of 4 -- a 16-bit index
                    // buffer partially updated starting at an odd index is a
                    // routine, common example that is neither. Applying the
                    // update to this plain byte array first (no alignment
                    // concerns) and re-uploading only the small 4-byte-aligned
                    // super-range that covers it keeps every write legal without
                    // ever guessing at or corrupting the untouched bytes on
                    // either edge (see applyBufferUpdate()).
                    shadow: new Uint8Array(alignedSize),
                    indexFormat: format === D3DFMT_INDEX32 ? "uint32" : "uint16",
                });
            },

            onUpdateBuffer(bytes, view, offset, length) {
                const handle = view.getUint32(offset + D9WG.F.UpdateBuffer.resource_handle, true);
                const destinationOffset = view.getUint32(offset + D9WG.F.UpdateBuffer.destination_offset, true);
                const byteCount = view.getUint32(offset + D9WG.F.UpdateBuffer.byte_count, true);
                const dataOffset = view.getUint32(offset + D9WG.F.UpdateBuffer.data_offset, true);
                const lockFlags = view.getUint32(offset + D9WG.F.UpdateBuffer.lock_flags, true);
                const resource = this.resources.get(handle);
                if (!resource || !byteCount) return;
                this.applyBufferUpdate(resource, destinationOffset, bytes, dataOffset,
                    byteCount, lockFlags);
            },

            applyBufferUpdate(resource, destinationOffset, bytes, sourceOffset,
                    byteCount, lockFlags) {
                void lockFlags; // allocation hints do not change the order of destination copies
                const shadow = resource.shadow;
                if (destinationOffset >= shadow.length) return;
                if (destinationOffset + byteCount > shadow.length)
                    byteCount = shadow.length - destinationOffset;
                if (!byteCount) return;
                const source = new Uint8Array(bytes.buffer, bytes.byteOffset + sourceOffset, byteCount);
                shadow.set(source, destinationOffset);

                const alignedStart = destinationOffset & ~3;
                const alignedEnd = Math.min(shadow.length, alignUp(destinationOffset + byteCount, 4));
                if (alignedEnd > alignedStart)
                    this.stageBufferUpload(resource.gpuBuffer, alignedStart, shadow.subarray(alignedStart, alignedEnd));
            },

            // WebGPU requires writeBuffer's size (and destination offset) to be a
            // multiple of 4 bytes; D3D9's Lock/Unlock byte ranges carry no such
            // guarantee (a 16-bit index buffer update is a common example that
            // is not). D9WG command records are always padded to an 8-byte
            // boundary (D9WG_ALIGN8 in d3d9_proxy.c), so up to 3 extra
            // zero-padding bytes past `byteCount` are always safely readable
            // from the same batch -- this rounds the write size up into that
            // slack rather than crashing the whole batch on an unaligned
            // Direct3D-legal update.
            writeBufferAligned(gpuBuffer, dstOffset, bytes, sourceOffset, byteCount) {
                if (!byteCount) return;
                if (dstOffset % 4 !== 0) {
                    console.warn("[d3d9-webgpu] dropping a buffer update at a " +
                        "non-4-byte-aligned destination offset", { dstOffset, byteCount });
                    return;
                }
                let writeCount = alignUp(byteCount, 4);
                const available = gpuBuffer.size - dstOffset;
                if (writeCount > available) writeCount = available - (available % 4);
                if (writeCount <= 0) return;
                this.device.queue.writeBuffer(gpuBuffer, dstOffset,
                    new Uint8Array(bytes.buffer, bytes.byteOffset + sourceOffset, writeCount));
            },

            onDestroyResource(bytes, view, offset) {
                const handle = view.getUint32(offset + D9WG.F.DestroyResource.resource_handle, true);
                const kind = view.getUint32(offset + D9WG.F.DestroyResource.resource_kind, true);
                if (kind === 0) {
                    // Matches the D3D8 guest convention: DESTROY_RESOURCE with
                    // resource_kind 0 targets the device handle itself, emitted
                    // once from device_release() when the app's last reference
                    // drops (see d3d9_proxy.c).
                    const state = this.devices.get(handle);
                    if (state) {
                        const lastDevice = this.devices.size === 1;
                        if (lastDevice) this.discardFrame();
                        this.retireDeviceState(state, "device");
                        this.devices.delete(handle);
                        if (this.presentingDevice === state)
                            this.presentingDevice = null;
                        if (lastDevice) {
                            this.retireActiveSessionBackBuffer();
                            this.retireGPUObject(this.cursor && this.cursor.texture);
                            this.retireGPUObject(this.cursor && this.cursor.uniform);
                            this.cursor = { texture: null, view: null, width: 0,
                                height: 0, hotspotX: 0, hotspotY: 0, x: 0, y: 0,
                                visible: false, pipeline: null, sampler: null,
                                uniform: null };
                        }
                    }
                    return;
                }
                const resource = this.resources.get(handle);
                if (!resource) return;
                // Never destroy inline. A frame being recorded may already hold a
                // bind group referencing this texture's view or a pending draw
                // referencing this buffer, and none of it is submitted until
                // Present -- destroying now makes WebGPU reject the whole command
                // buffer ("Destroyed texture ... used in a submit"). Releasing a
                // texture in the same frame it was last drawn with is ordinary
                // application behaviour, not an edge case.
                this.retireResourceState(resource);
                this.resources.delete(handle);
            },

            onCreateTexture2D(bytes, view, offset, length) {
                const handle = view.getUint32(offset + D9WG.F.CreateTexture2D.resource_handle, true);
                const width = view.getUint32(offset + D9WG.F.CreateTexture2D.width, true);
                const height = view.getUint32(offset + D9WG.F.CreateTexture2D.height, true);
                let levelCount = view.getUint32(offset + D9WG.F.CreateTexture2D.level_count, true);
                const format = view.getUint32(offset + D9WG.F.CreateTexture2D.format, true);
                const usage = view.getUint32(offset + D9WG.F.CreateTexture2D.usage, true);
                const multisampleType = view.getUint32(offset + D9WG.F.CreateTexture2D.multisample_type, true);
                const multisampleQuality = view.getUint32(offset + D9WG.F.CreateTexture2D.multisample_quality, true);
                // A render target or depth surface arrives as a CREATE_TEXTURE_2D
                // carrying the usage (see d3d9_protocol.h): the host needs a GPU
                // texture either way, and D3D9 reaches a texture's render target
                // through GetSurfaceLevel as often as through CreateRenderTarget, so
                // one opcode covers both without two host paths for one object.
                // A FOURCC depth format is a depth resource whether or not the
                // app spelled out D3DUSAGE_DEPTHSTENCIL: INTZ in particular is
                // routinely created with usage 0 and then bound as the depth
                // surface, which is exactly the trick it exists for.
                const isDepth = (usage & D3DUSAGE_DEPTHSTENCIL) !== 0 ||
                    isFourCCDepthFormat(format);
                const isTarget = (usage & D3DUSAGE_RENDERTARGET) !== 0;
                const ddIndexed = (usage & D9WG_USAGE_DDRAW_INDEXED) !== 0 &&
                    isPalettizedFormat(format) && !isDepth;
                const sampleCount = sampleCountForD3D(multisampleType,
                    multisampleQuality);
                if (!sampleCount) {
                    ++this.stats.texturesRejected;
                    this.warnOnce("invalid-texture-msaa-" + multisampleType + "-" +
                            multisampleQuality,
                        "a texture requested an unsupported D3D9 multisample " +
                        "configuration and is rejected instead of silently " +
                        "creating a resource with different sampling semantics",
                        { multisampleType, multisampleQuality });
                    return;
                }
                if (sampleCount > 1 && (!isTarget && !isDepth)) {
                    ++this.stats.texturesRejected;
                    this.warnOnce("msaa-non-attachment-texture",
                        "a multisampled D3D9 texture must be a render target or " +
                        "depth-stencil attachment", { usage, sampleCount });
                    return;
                }
                if (sampleCount > 1 && levelCount > 1) {
                    ++this.stats.texturesRejected;
                    this.warnOnce("msaa-mip-chain",
                        "a multisampled D3D9 texture cannot have multiple mip " +
                        "levels; the resource is rejected", { levelCount,
                            sampleCount });
                    return;
                }
                // Every D3D9 depth format collapses onto one real depth target: the
                // guest cannot read any of them back, so only "a depth buffer
                // exists" is observable (same argument as ensureDepthTarget).
                // D3DUSAGE_AUTOGENMIPMAP means the app owns level 0 and the driver
                // owns everything under it. The guest therefore reports one level
                // -- which is what D3D9's GetLevelCount says for such a texture --
                // and the full chain is allocated here, where it is filled.
                const autoGenerateMips = (usage & D3DUSAGE_AUTOGENMIPMAP) !== 0 &&
                    !isDepth;
                if (autoGenerateMips)
                    levelCount = fullMipLevelCount(width, height);
                const gpuFormat = isDepth ? DEPTH_FORMAT
                    : (ddIndexed ? "r8uint" : formatToGPU(format));
                if (!gpuFormat) {
                    console.warn("[d3d9-webgpu] unsupported texture format", format);
                    return;
                }
                if (isTarget && !isDepth && !isRenderableGPUFormat(gpuFormat)) {
                    ++this.stats.texturesRejected;
                    this.warnOnce("non-renderable-d3d9-target-" + format,
                        "a texture was marked as a D3D9 render target but its " +
                        "WebGPU storage format cannot be a render attachment; " +
                        "the resource is rejected instead of creating an invalid " +
                        "GPU descriptor", { format, gpuFormat });
                    return;
                }
                const srgbFormat = isDepth ? null : srgbSiblingOf(gpuFormat);
                const textureDescriptor = {
                    label: isDepth ? "D3D9 depth surface"
                        : (isTarget ? "D3D9 render target" : undefined),
                    size: { width, height, depthOrArrayLayers: 1 },
                    format: gpuFormat,
                    ...(srgbFormat ? { viewFormats: [srgbFormat] } : {}),
                    mipLevelCount: Math.max(1, levelCount),
                    ...(isDepth && sampleCount > 1 ? { sampleCount } : {}),
                    usage: (isDepth
                            ? TEXTURE_USAGE_RENDER_ATTACHMENT |
                              // A D3D9 depth *texture* is the standard hardware
                              // shadow map: rendered into as a depth attachment,
                              // then bound to a sampler so the lighting pass can
                              // compare against it. Leaving the binding usage off
                              // made that second half impossible -- see the
                              // `view` field below.
                              (sampleCount > 1 ? 0 : TEXTURE_USAGE_TEXTURE_BINDING)
                            : TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_COPY_SRC |
                              TEXTURE_USAGE_TEXTURE_BINDING) |
                        // A blit writes through a render pass, so anything that can
                        // be a StretchRect destination needs the attachment usage.
                        // BCn cannot be an attachment at all, which is also why a
                        // StretchRect into a compressed texture stays unsupported.
                        ((!isDepth && isRenderableGPUFormat(gpuFormat) &&
                            (isTarget || autoGenerateMips ||
                                !isCompressedFormat(format)))
                            ? TEXTURE_USAGE_RENDER_ATTACHMENT : 0),
                };
                const gpuTexture = this.createTextureOrNull(textureDescriptor, format);
                if (!gpuTexture) return;
                // WebGPU multisampled colour textures cannot be sampled or copied.
                // Keep the ordinary texture as D3D9's resolved surface and render
                // through a transiently persistent multisampled attachment which
                // resolves into it at every pass boundary. Depth has no resolve in
                // either API, so its primary texture itself is multisampled.
                let msaaTexture = null;
                if (sampleCount > 1 && isTarget && !isDepth) {
                    const msaaDescriptor = {
                        label: "D3D9 multisampled render target",
                        size: { width, height, depthOrArrayLayers: 1 },
                        format: gpuFormat,
                        ...(srgbFormat ? { viewFormats: [srgbFormat] } : {}),
                        mipLevelCount: 1,
                        sampleCount,
                        usage: TEXTURE_USAGE_RENDER_ATTACHMENT,
                    };
                    msaaTexture = this.createTextureOrNull(msaaDescriptor, format);
                    if (!msaaTexture) {
                        if (typeof gpuTexture.destroy === "function")
                            gpuTexture.destroy();
                        return;
                    }
                }
                ++this.stats.texturesCreated;
                if (isTarget) ++this.stats.renderTargetsCreated;
                // No sampler is attached to the texture: since M2, sampling
                // parameters come from the device's per-stage sampler state
                // through samplerFor(), so the same texture bound to two stages
                // with different filtering behaves the way D3D9 says it should.
                this.resources.set(handle, {
                    kind: RESOURCE_TEXTURE_2D, textureType: "2d",
                    deviceHandle: view.getUint32(offset + D9WG.F.CreateTexture2D.device_handle, true),
                    gpuTexture, msaaTexture, gpuFormat, srgbFormat, format, usage,
                    width, height, sampleCount,
                    multisampleType, multisampleQuality,
                    gpuBytesPerTexel: ddIndexed ? 1 : gpuBytesPerTexel(format),
                    ddIndexed,
                    textureDescriptor,
                    levelCount: Math.max(1, levelCount),
                    // A subresource the guest never initializes has undefined
                    // contents.  Initialization can arrive either as a CPU upload
                    // or as a GPU write such as DirectDraw Blt/StretchRect.
                    // Sampling one is not "slightly blurry" -- it is whatever was
                    // in that memory, which reads as a completely wrong texture.
                    // M1 could not hit this the same way because it sampled with
                    // one hardcoded sampler; M2 honours D3DSAMP_MIPFILTER, so a
                    // game asking for mip filtering now reaches levels that were
                    // never written.
                    // A render target's or depth surface's levels are written by
                    // the GPU, never uploaded, so tracking them would make the
                    // incomplete-mip-chain warning fire on every draw that samples
                    // a perfectly valid target.
                    // A generated chain is written by the GPU, never uploaded, so
                    // tracking it would make the incomplete-mip warning fire on
                    // every draw that samples a perfectly valid texture.
                    uploadedLevels: (isTarget || isDepth || autoGenerateMips)
                        ? null : new Set(),
                    autoGenerateMips,
                    isDepth,
                    // D3D9 has two ways to read a depth texture and they are not
                    // interchangeable. A D16/D24X8/D32 texture bound to a sampler
                    // is a hardware shadow map: the driver compares and returns
                    // filtered visibility. A DF16/DF24/INTZ texture returns the
                    // stored depth itself, which is precisely why an app picks one.
                    // Sampling either as though it were the other produces an
                    // image that looks deliberate and is wrong.
                    depthReadsRaw: isDepth && isFourCCDepthFormat(format),
                    // A null view here used to be the modelling assumption that a
                    // depth surface is only ever an attachment -- nothing can read
                    // its pixels back, so "a depth buffer exists" looked like the
                    // whole of its observable behaviour. Shadow mapping is the
                    // counter-example, and the failure was not a wrong image: the
                    // null reached createBindGroup as a binding resource and threw
                    // a TypeError out of the batch, taking every command after it
                    // in that batch with it.
                    //
                    // depth24plus-stencil8 can only be sampled one aspect at a
                    // time, and the stencil aspect would need its own uint layout
                    // entry that no D3D9 shader can ask for.
                    view: !isDepth ? gpuTexture.createView()
                        : (sampleCount > 1 ? null
                            : gpuTexture.createView({ aspect: "depth-only" })),
                });
            },

            onUpdateTexture(bytes, view, offset) {
                const handle = view.getUint32(offset + D9WG.F.UpdateTexture.resource_handle, true);
                const level = view.getUint32(offset + D9WG.F.UpdateTexture.level, true);
                const x = view.getUint32(offset + D9WG.F.UpdateTexture.x, true);
                const y = view.getUint32(offset + D9WG.F.UpdateTexture.y, true);
                // D9WGUpdateTexture.z is the cube face for a cube texture and the
                // slice for a volume texture; both land on the same WebGPU array
                // layer, which is why one field and one opcode serve both.
                const z = view.getUint32(offset + D9WG.F.UpdateTexture.z, true);
                const width = view.getUint32(offset + D9WG.F.UpdateTexture.width, true);
                const height = view.getUint32(offset + D9WG.F.UpdateTexture.height, true);
                const depth = Math.max(1, view.getUint32(offset + D9WG.F.UpdateTexture.depth, true));
                const rowPitch = view.getUint32(offset + D9WG.F.UpdateTexture.row_pitch, true);
                const slicePitch = view.getUint32(offset + D9WG.F.UpdateTexture.slice_pitch, true) ||
                    rowPitch * height;
                const dataBytes = view.getUint32(offset + D9WG.F.UpdateTexture.data_bytes, true);
                const dataOffset = view.getUint32(offset + D9WG.F.UpdateTexture.data_offset, true);
                const resource = this.resources.get(handle);
                if (!resource || !resource.gpuTexture) return;
                const source = new Uint8Array(bytes.buffer, bytes.byteOffset + dataOffset, dataBytes);
                const compressed = isCompressedFormat(resource.format);
                let payload = source;
                let bytesPerRow = rowPitch;
                if (resource.ddIndexed) {
                    // An indexed DirectDraw surface stores what the app wrote: the
                    // bytes are the texels, and nothing about them changes when the
                    // palette does. Only the row padding comes off, because
                    // writeTexture wants the rows tightly packed.
                    const packed = new Uint8Array(width * height * depth);
                    for (let slice = 0; slice < depth; ++slice) {
                        for (let row = 0; row < height; ++row) {
                            const from = slice * slicePitch + row * rowPitch;
                            packed.set(source.subarray(from, from + width),
                                slice * width * height + row * width);
                        }
                    }
                    ++this.stats.textureUploads;
                    this.stats.textureBytesUploaded += packed.length;
                    this.markTextureSubresourceWritten(resource, level, z);
                    // Keep the primary r8uint texture current for indexed-to-
                    // indexed DirectDraw blits.  The RGBA sampling companion is
                    // resolved lazily from the GPU indices by ddIndexedSampleViewFor.
                    this.stageTextureUpload(
                        { texture: resource.gpuTexture, mipLevel: level,
                            origin: { x, y, z } }, packed,
                        { bytesPerRow: width, rowsPerImage: height },
                        { width, height, depthOrArrayLayers: depth });
                    return;
                }
                if (isPalettizedFormat(resource.format)) {
                    // The indices, not the colours, are what the app uploaded. A
                    // palette swap has to repaint this texture without any new
                    // traffic -- that is the whole point of a palettized format --
                    // so the source bytes are kept and re-expanded on demand.
                    this.rememberPalettizedUpload(resource, {
                        level, z, x, y, width, height, depth, rowPitch, slicePitch,
                        source: source.slice(),
                    });
                }
                if (!compressed) {
                    const gpuBpp = resource.gpuBytesPerTexel;
                    // Expand to the tightly packed WebGPU representation chosen
                    // by formatToGPU(): RGBA8 UNORM/SNORM or RGBA16F.
                    const expandedSlicePitch = width * height * gpuBpp;
                    const expanded = new Uint8Array(expandedSlicePitch * depth);
                    const palette = isPalettizedFormat(resource.format)
                        ? this.currentPaletteFor(handle) : null;
                    for (let slice = 0; slice < depth; ++slice) {
                        for (let row = 0; row < height; ++row) {
                            expandRowToGPU(resource.format, source,
                                slice * slicePitch + row * rowPitch, width,
                                expanded, slice * expandedSlicePitch +
                                    row * width * gpuBpp, palette);
                        }
                    }
                    payload = expanded;
                    bytesPerRow = width * gpuBpp;
                }
                ++this.stats.textureUploads;
                this.stats.textureBytesUploaded += payload.length;
                // Only level 0 is the app's on an autogen texture, so only level 0
                // can invalidate what the driver generated from it.
                this.markTextureSubresourceWritten(resource, level, z);
                // Retain a CPU copy of small top-level images. This is the one
                // piece of evidence that separates "the texture data we uploaded
                // is wrong" from "the data is right but we sample it wrong", and
                // guessing between those two has already cost several rounds.
                // Bounded to sprite-sized textures so it cannot grow without
                // limit -- cursors and UI glyphs are exactly this size.
                // 64x64 was too small a net: a game's cursor and UI glyphs
                // usually live in a larger atlas, so the one texture worth looking
                // at was the one never captured. 256x256 covers those at a bounded
                // total cost (previewBudget below).
                if (!compressed && (resource.gpuFormat === "rgba8unorm" || resource.gpuFormat === "bgra8unorm") &&
                        resource.textureType !== "3d" && depth === 1 &&
                        level === 0 && z === 0 && width <= 256 &&
                        height <= 256 && x === 0 && y === 0) {
                    const previewBytes = width * height * 4;
                    if (!resource.preview) {
                        if (this.previewBudget === undefined)
                            this.previewBudget = 16 * 1024 * 1024;
                        if (this.previewBudget >= previewBytes) {
                            this.previewBudget -= previewBytes;
                            resource.preview = {
                                width, height, rgba: payload.slice()
                            };
                        } else {
                            // The preview is diagnostics only. Returning here used
                            // to drop the real queue.writeTexture below once War3
                            // had loaded 16 MiB of menu atlases. Textures first
                            // touched in battle (fog/minimap/command icons/software
                            // cursor) consequently stayed black or transparent.
                            ++this.stats.texturePreviewsSkipped;
                        }
                    } else {
                        resource.preview = { width, height, rgba: payload.slice() };
                    }
                    if (resource.preview && resource.gpuFormat === "bgra8unorm") {
                        const rgba = resource.preview.rgba;
                        for (let at = 0; at < rgba.length; at += 4) {
                            const b = rgba[at];rgba[at] = rgba[at + 2];rgba[at + 2] = b;
                        }
                    }
                }
                // rowsPerImage counts *block* rows for a block-compressed format,
                // not pixel rows -- BCn blocks are 4x4, so a DXT upload that
                // passes the pixel height describes an image four times taller
                // than the data actually is.
                this.stageTextureUpload(
                    { texture: resource.gpuTexture, mipLevel: level, origin: { x, y, z } },
                    payload,
                    { bytesPerRow, rowsPerImage: compressed ? Math.ceil(height / 4) : height },
                    { width: blockAlignedCopyExtent(width, compressed),
                        height: blockAlignedCopyExtent(height, compressed),
                        depthOrArrayLayers: depth }, resource);
            },

            // ---- render targets, cube textures and blits (M3/M4) ----

            // A cube texture is a six-layer 2D WebGPU texture viewed as "cube".
            // Both views are kept: bind groups need the cube view, and a blit or an
            // upload addresses a single face, which only the layered 2D form can do.
            onCreateTextureCube(bytes, view, offset) {
                const handle = view.getUint32(offset + D9WG.F.CreateTextureCube.resource_handle, true);
                const edge = view.getUint32(offset + D9WG.F.CreateTextureCube.edge_length, true);
                const levelCount = Math.max(1, view.getUint32(offset + D9WG.F.CreateTextureCube.level_count, true));
                const format = view.getUint32(offset + D9WG.F.CreateTextureCube.format, true);
                const usage = view.getUint32(offset + D9WG.F.CreateTextureCube.usage, true);
                const ddIndexed = (usage & D9WG_USAGE_DDRAW_INDEXED) !== 0 &&
                    isPalettizedFormat(format);
                const gpuFormat = ddIndexed ? "r8uint" : formatToGPU(format);
                if (!gpuFormat) {
                    console.warn("[d3d9-webgpu] unsupported cube texture format", format);
                    return;
                }
                const autoGenerateMips = (usage & D3DUSAGE_AUTOGENMIPMAP) !== 0;
                const srgbFormat = srgbSiblingOf(gpuFormat);
                const textureDescriptor = {
                    label: "D3D9 cube " + edge,
                    size: { width: edge, height: edge, depthOrArrayLayers: 6 },
                    format: gpuFormat,
                    ...(srgbFormat ? { viewFormats: [srgbFormat] } : {}),
                    mipLevelCount: autoGenerateMips
                        ? fullMipLevelCount(edge, edge) : levelCount,
                    usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_COPY_SRC |
                        TEXTURE_USAGE_TEXTURE_BINDING |
                        // A dynamic environment map is a cube render target: the
                        // app renders the scene six times, once per face, through
                        // the surfaces GetCubeMapSurface hands out.
                        ((((usage & D3DUSAGE_RENDERTARGET) || autoGenerateMips) &&
                            isRenderableGPUFormat(gpuFormat))
                            ? TEXTURE_USAGE_RENDER_ATTACHMENT : 0),
                };
                const gpuTexture = this.createTextureOrNull(textureDescriptor, format);
                if (!gpuTexture) return;
                ++this.stats.texturesCreated;
                ++this.stats.cubeTexturesCreated;
                this.resources.set(handle, {
                    kind: RESOURCE_TEXTURE_CUBE, textureType: "cube",
                    deviceHandle: view.getUint32(offset + D9WG.F.CreateTextureCube.device_handle, true),
                    gpuTexture, gpuFormat, srgbFormat,
                    format, usage, width: edge, height: edge, layerCount: 6,
                    gpuBytesPerTexel: ddIndexed ? 1 : gpuBytesPerTexel(format),
                    ddIndexed,
                    textureDescriptor,
                    levelCount: textureDescriptor.mipLevelCount,
                    // Keyed by level*6+face, so the incomplete-mip warning counts a
                    // cube's faces independently -- a game that fills face 0's whole
                    // chain and leaves face 5 empty is a real bug this would hide if
                    // the levels were tracked per-level only.
                    uploadedLevels: autoGenerateMips ? null : new Set(),
                    autoGenerateMips,
                    view: gpuTexture.createView({ dimension: "cube" }),
                });
            },

            onCreateTextureVolume(bytes, view, offset, length) {
                const handle = view.getUint32(offset + D9WG.F.CreateTextureVolume.resource_handle, true);
                const width = view.getUint32(offset + D9WG.F.CreateTextureVolume.width, true);
                const height = view.getUint32(offset + D9WG.F.CreateTextureVolume.height, true);
                const depth = view.getUint32(offset + D9WG.F.CreateTextureVolume.depth, true);
                const levelCount = Math.max(1, view.getUint32(offset + D9WG.F.CreateTextureVolume.level_count, true));
                const format = view.getUint32(offset + D9WG.F.CreateTextureVolume.format, true);
                const usage = view.getUint32(offset + D9WG.F.CreateTextureVolume.usage, true);
                const gpuFormat = formatToGPU(format);
                if (!gpuFormat || isCompressedFormat(format) ||
                        (isRenderableGPUFormat(gpuFormat) &&
                            (usage & D3DUSAGE_RENDERTARGET))) {
                    ++this.stats.texturesRejected;
                    return;
                }
                const textureDescriptor = {
                    label: "D3D9 volume texture",
                    size: { width, height, depthOrArrayLayers: depth },
                    dimension: "3d",
                    format: gpuFormat,
                    mipLevelCount: levelCount,
                    usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_COPY_SRC |
                        TEXTURE_USAGE_TEXTURE_BINDING,
                };
                const gpuTexture = this.createTextureOrNull(textureDescriptor,
                    format);
                if (!gpuTexture) return;
                ++this.stats.texturesCreated;
                ++this.stats.volumeTexturesCreated;
                this.resources.set(handle, {
                    kind: RESOURCE_TEXTURE_VOLUME, textureType: "3d",
                    deviceHandle: view.getUint32(offset + D9WG.F.CreateTextureVolume.device_handle, true),
                    gpuTexture, gpuFormat, format, usage,
                    width, height, depth,
                    gpuBytesPerTexel: gpuBytesPerTexel(format),
                    textureDescriptor, levelCount,
                    uploadedLevels: new Set(),
                    view: gpuTexture.createView({ dimension: "3d" }),
                });
            },

            // createTexture throws for a format the device does not support, and an
            // exception here propagates out of the batch and discards the whole
            // frame -- one unsupported texture would blank the screen instead of
            // costing one texture. Contained, counted, and named once instead: the
            // draws that bind it fall back to the 1x1 white stand-in, which is
            // visibly wrong in a way that points at the right place.
            createTextureOrNull(descriptor, d3dFormat) {
                try {
                    return this.device.createTexture(descriptor);
                } catch (error) {
                    ++this.stats.texturesRejected;
                    this.warnOnce("createtexture-" + descriptor.format,
                        "the WebGPU device refused a texture format the D3D9 " +
                        "format table claims to support; every draw sampling it " +
                        "gets the 1x1 white fallback instead", {
                            d3dFormat, gpuFormat: descriptor.format,
                            size: descriptor.size,
                            bcSupported: this.deviceFeatures &&
                                this.deviceFeatures.bc,
                            message: error && error.message,
                        });
                    return null;
                }
            },

            // ---- texture palettes ----
            //
            // A D3D9 palette is device state consulted when a texel is sampled,
            // not a property baked into the texture: the same P8 surface takes on
            // different colours as the app switches palettes, with no upload in
            // between. WebGPU has no palettized format, so the expansion happens on
            // the CPU -- which means the indices have to be kept and replayed
            // whenever the table or the selection changes.

            paletteFor(deviceHandle, index) {
                if (!this.palettes) this.palettes = new Map();
                return this.palettes.get(deviceHandle + ":" + index) || null;
            },

            currentPaletteFor(resourceHandle) {
                const resource = this.resources.get(resourceHandle);
                const deviceHandle = resource ? resource.deviceHandle : 0;
                const state = this.devices.get(deviceHandle);
                if (!state || state.currentPalette === null ||
                        state.currentPalette === undefined)
                    return null;
                return this.paletteFor(deviceHandle, state.currentPalette);
            },

            rememberPalettizedUpload(resource, upload) {
                if (!resource.palettizedUploads) resource.palettizedUploads = [];
                // Keyed by subresource *and* sub-rectangle: a partial LockRect
                // update of one region must not discard the rest of the level.
                const key = upload.level + ":" + upload.z + ":" + upload.x + ":" +
                    upload.y + ":" + upload.width + ":" + upload.height;
                const existing = resource.palettizedUploads
                    .findIndex(item => item.key === key);
                upload.key = key;
                if (existing >= 0) resource.palettizedUploads[existing] = upload;
                else resource.palettizedUploads.push(upload);
            },

            // Re-expands every palettized texture on the device through the palette
            // now in force. Cheap in the way that matters: palettized content is
            // one byte per texel by definition, and a palette swap is rare.
            repaintPalettizedTextures(deviceHandle) {
                let repainted = 0;
                for (const [handle, resource] of this.resources) {
                    if (!resource || resource.deviceHandle !== deviceHandle) continue;
                    if (!isPalettizedFormat(resource.format)) continue;
                    if (!resource.palettizedUploads) continue;
                    const palette = this.currentPaletteFor(handle);
                    for (const upload of resource.palettizedUploads) {
                        this.uploadPalettizedRegion(resource, upload, palette);
                        ++repainted;
                    }
                }
                this.stats.palettizedRepaints += repainted;
            },

            uploadPalettizedRegion(resource, upload, palette) {
                const gpuBpp = resource.gpuBytesPerTexel;
                const { level, z, x, y, width, height, depth, rowPitch,
                    slicePitch, source } = upload;
                const expandedSlicePitch = width * height * gpuBpp;
                const expanded = new Uint8Array(expandedSlicePitch * depth);
                for (let slice = 0; slice < depth; ++slice) {
                    for (let row = 0; row < height; ++row) {
                        expandRowToGPU(resource.format, source,
                            slice * slicePitch + row * rowPitch, width,
                            expanded,
                            slice * expandedSlicePitch + row * width * gpuBpp,
                            palette);
                    }
                }
                const bytesPerRow = width * gpuBpp;
                this.stageTextureUpload(
                    { texture: resource.gpuTexture, mipLevel: level,
                        origin: { x, y, z } },
                    expanded, { bytesPerRow, rowsPerImage: height },
                    { width, height, depthOrArrayLayers: depth });
            },

            // ---- automatic mip generation ----
            //
            // D3DUSAGE_AUTOGENMIPMAP hands the driver everything below level 0 and
            // asks it to keep the chain current. D3D9 regenerates whenever the top
            // level changes; the host is the side that can see when that actually
            // happened -- an upload landed, or a render pass had level 0 as its
            // attachment -- so the trigger lives here rather than being guessed at
            // by the guest. GenerateMipSubLevels() arrives as its own opcode for
            // the case where the app asks explicitly.

            // Remember every subresource write, irrespective of whether its pixels
            // came over the wire or were produced on the GPU.  uploadedLevels keeps
            // its historical name because it is also exposed in diagnostic state,
            // but semantically it is the set of initialized levels/faces.
            markTextureSubresourceWritten(resource, level, layer = 0) {
                if (!resource) return;
                if (resource.ddIndexed) resource.ddContentSerial = (resource.ddContentSerial || 0) + 1;
                if (resource.uploadedLevels) {
                    if (resource.textureType === "3d") {
                        resource.uploadedLevels.add(level);
                    } else {
                        const layerCount = Math.max(1, resource.layerCount || 1);
                        const safeLayer = Math.max(0,
                            Math.min(layer >>> 0, layerCount - 1));
                        // Six slots per level preserve the existing cube-map key
                        // layout while a 2D texture naturally occupies slot zero.
                        resource.uploadedLevels.add(level * 6 + safeLayer);
                    }
                }
                if (level === 0) this.markMipsDirty(resource);
            },

            markMipsDirty(resource) {
                if (!resource || !resource.autoGenerateMips) return;
                resource.mipsDirty = true;
            },

            // Queued before whatever is about to read the texture, not executed
            // now: the chain is filled by render passes, and record time is inside
            // whatever pass is already open.
            flushGeneratedMips(resource) {
                if (!resource || !resource.autoGenerateMips || !resource.mipsDirty)
                    return;
                if (!resource.gpuTexture || resource.levelCount < 2) {
                    resource.mipsDirty = false;
                    return;
                }
                resource.mipsDirty = false;
                const frame = this.ensureFrame();
                frame.ops.push({ kind: "generate-mips", resource });
                resource.frameReferenced = frame.serial;
                ++this.stats.mipChainsGenerated;
            },

            onGenerateMips(bytes, view, offset) {
                const resource = this.resources.get(
                    view.getUint32(offset + D9WG.F.GenerateMips.resource_handle, true));
                if (!resource || !resource.autoGenerateMips) return;
                // An explicit call regenerates whether or not the host noticed a
                // write: the app may know something the write tracking cannot.
                resource.mipsDirty = true;
                this.flushGeneratedMips(resource);
                ++this.stats.explicitMipGenerations;
            },

            onSetTextureLOD(bytes, view, offset) {
                const resource = this.resources.get(
                    view.getUint32(offset + D9WG.F.SetTextureLOD.resource_handle, true));
                if (!resource) return;
                // Clamped against the chain that actually exists rather than
                // trusted: the guest clamps too, but a texture recreated at a
                // different level count between the two would otherwise leave a
                // lodMinClamp above lodMaxClamp, which WebGPU rejects outright.
                const levels = Math.max(1, resource.levelCount || 1);
                resource.lod = Math.min(view.getUint32(offset + D9WG.F.SetTextureLOD.lod, true) >>> 0,
                    levels - 1);
            },

            onSetPalette(bytes, view, offset) {
                const deviceHandle = view.getUint32(offset + D9WG.F.SetPalette.device_handle, true);
                const index = view.getUint32(offset + D9WG.F.SetPalette.palette_index, true);
                const entryCount = view.getUint32(offset + D9WG.F.SetPalette.entry_count, true);
                const dataOffset = view.getUint32(offset + D9WG.F.SetPalette.data_offset, true);
                if (entryCount !== 256) return;
                const source = new Uint8Array(bytes.buffer,
                    bytes.byteOffset + dataOffset, 256 * 4);
                // The wire carries D3DCOLOR (A8R8G8B8, little-endian BGRA bytes);
                // the expansion wants RGBA in memory order.
                const rgba = new Uint8Array(256 * 4);
                for (let entry = 0; entry < 256; ++entry) {
                    const at = entry * 4;
                    rgba[at] = source[at + 2];
                    rgba[at + 1] = source[at + 1];
                    rgba[at + 2] = source[at];
                    rgba[at + 3] = source[at + 3];
                }
                if (!this.palettes) this.palettes = new Map();
                this.palettes.set(deviceHandle + ":" + index, rgba);
                ++this.stats.palettesSet;
                const state = this.devices.get(deviceHandle);
                if (state && state.currentPalette === index)
                    this.repaintPalettizedTextures(deviceHandle);
            },

            onSetCurrentTexturePalette(bytes, view, offset) {
                const deviceHandle = view.getUint32(offset + D9WG.F.SetCurrentTexturePalette.device_handle, true);
                const index = view.getUint32(offset + D9WG.F.SetCurrentTexturePalette.palette_index, true);
                const state = this.deviceState(deviceHandle);
                if (state.currentPalette === index) return;
                state.currentPalette = index;
                ++this.stats.paletteSelections;
                this.repaintPalettizedTextures(deviceHandle);
            },

            // A sampled view of one mip level, cached on the resource.
            blitSourceView(resource, level, face) {
                if (!resource.blitViews) resource.blitViews = new Map();
                const baseArrayLayer = face || 0;
                const key = level + ":" + baseArrayLayer;
                let cached = resource.blitViews.get(key);
                if (!cached) {
                    cached = resource.gpuTexture.createView({
                        dimension: "2d", baseMipLevel: level, mipLevelCount: 1,
                        baseArrayLayer, arrayLayerCount: 1,
                    });
                    resource.blitViews.set(key, cached);
                }
                return cached;
            },

            // One attachment view per (level, face, srgb). A cube map is a
            // six-layer 2D texture here, so rendering into one face is exactly
            // selecting one array layer -- which is why the layer has to reach this
            // far rather than being resolved at bind time: an attachment view names
            // a single subresource, and "the cube" is not one.
            targetViewFor(resource, level, srgb, layer) {
                if (!resource.targetViews) resource.targetViews = new Map();
                const baseArrayLayer = layer || 0;
                const key = level + ":" + baseArrayLayer + (srgb ? "s" : "");
                let cached = resource.targetViews.get(key);
                if (!cached) {
                    cached = resource.gpuTexture.createView({
                        baseMipLevel: level, mipLevelCount: 1, dimension: "2d",
                        baseArrayLayer, arrayLayerCount: 1,
                        ...(srgb ? { format: resource.srgbFormat } : {}),
                    });
                    resource.targetViews.set(key, cached);
                }
                return cached;
            },

            msaaViewFor(resource, srgb) {
                const key = srgb ? "msaaSrgbView" : "msaaView";
                if (!resource[key])
                    resource[key] = resource.msaaTexture.createView(srgb ? { format: resource.srgbFormat } : {});
                return resource[key];
            },

            onCreateVertexDeclaration(bytes, view, offset, length) {
                const handle = view.getUint32(offset + D9WG.F.CreateVertexDeclaration.resource_handle, true);
                const count = view.getUint32(offset + D9WG.F.CreateVertexDeclaration.element_count, true);
                const elements = this.decodeVertexElements(bytes, view, offset + D9WG.STRUCTS.CreateVertexDeclaration.size, count);
                this.resources.set(handle,
                    { kind: RESOURCE_VERTEX_DECLARATION, elements });
            },

            // ---- programmable shaders (M2) ----

            // Translation happens here, at CREATE time, and never on a draw path
            // (plan 4.2): a shader first used mid-frame would otherwise produce an
            // unattributable latency spike. A shader this build cannot translate
            // is stored with its error rather than dropped -- recordDraw() then
            // skips draws that bind it and counts them, which is the difference
            // between "this shader is unsupported" and "the game stopped drawing".
            async onCreateShader(bytes, view, offset, kind) {
                const handle = view.getUint32(offset + 4, true);
                const tokenCount = view.getUint32(offset + 8, true);
                const codeOffset = view.getUint32(offset + 12, true);
                const suppliedHashLow = view.getUint32(offset + 16, true);
                const suppliedHashHigh = view.getUint32(offset + 20, true);
                if (codeOffset + tokenCount * 4 > bytes.byteLength) {
                    ++this.stats.malformedBatches;
                    throw new D9WGStreamError("D9WG shader bytecode overruns the batch");
                }
                // The DMA blob is not 4-byte aligned within `bytes` in general,
                // so copy rather than aliasing a Uint32Array onto it.
                const tokens = new Uint32Array(tokenCount);
                for (let i = 0; i < tokenCount; ++i)
                    tokens[i] = view.getUint32(codeOffset + i * 4, true);
                // Hashes are a cache hint carried by an untrusted guest. Verify
                // them from the bytecode so an old or buggy proxy cannot alias
                // every shader to the same cached translation (the original D3D8
                // proxy sent zero for both fields).
                const verifiedHash = shaderPipeline.hashTokens(tokens);
                const hashLow = verifiedHash.low;
                const hashHigh = verifiedHash.high;
                if (hashLow !== suppliedHashLow || hashHigh !== suppliedHashHigh) {
                    this.warnOnce("shader-hash-mismatch-" + kind,
                        "guest shader bytecode hash did not match its token " +
                        "stream; using the verified hash to prevent distinct " +
                        "shaders from aliasing in the translation cache", {
                            kind: kind === RESOURCE_VERTEX_SHADER
                                ? "vertex" : "pixel",
                            suppliedHashLow,
                            suppliedHashHigh,
                            verifiedHashLow: hashLow,
                            verifiedHashHigh: hashHigh,
                        });
                }
                const compilesBefore = this.shaderCache.stats.compiles;
                let translated = this.shaderCache.get(hashLow, hashHigh);
                if (!translated) {
                    const started = typeof performance !== "undefined" && performance.now
                        ? performance.now() : Date.now();
                    const workerCompile = this.compileShaderInWorker(tokens);
                    if (workerCompile) {
                        try {
                            translated = await workerCompile;
                            if (!translated || typeof translated.ok !== "boolean")
                                throw new Error("shader worker returned an invalid result");
                            ++this.stats.shaderWorkerCompiles;
                            const ended = typeof performance !== "undefined" && performance.now
                                ? performance.now() : Date.now();
                            translated = this.shaderCache.store(hashLow, hashHigh,
                                translated, ended - started);
                        } catch (error) {
                            ++this.stats.shaderWorkerFallbacks;
                            this.warnOnce("shader-worker-runtime",
                                "shader compile Worker failed; falling back to the " +
                                "executor thread", { message: String(error) });
                            translated = this.shaderCache.compile(tokens,
                                hashLow, hashHigh);
                        }
                    } else {
                        translated = this.shaderCache.compile(tokens,
                            hashLow, hashHigh);
                    }
                }
                if (this.shaderCache.stats.compiles !== compilesBefore)
                    this.shaderCacheDirty = true;
                if (translated.ok) ++this.stats.shadersTranslated;
                else {
                    ++this.stats.shaderTranslationFailures;
                    this.warnOnce("shader-translate-" + hashHigh + "-" + hashLow,
                        "cannot translate a " + (kind === RESOURCE_VERTEX_SHADER
                            ? "vertex" : "pixel") + " shader; draws that bind it " +
                        "will be skipped: " + translated.error);
                }
                this.resources.set(handle, {
                    kind, tokens, hashLow, hashHigh,
                    translated,
                    // Variant key -> {translated, module}. A vertex shader needs
                    // one variant per set of D3DCOLOR input locations; in practice
                    // that is a single entry, because a given shader is used with
                    // one vertex format.
                    variants: new Map(),
                });
            },

            onCreateVertexShader(bytes, view, offset) {
                return this.onCreateShader(bytes, view, offset, RESOURCE_VERTEX_SHADER);
            },

            onCreatePixelShader(bytes, view, offset) {
                return this.onCreateShader(bytes, view, offset, RESOURCE_PIXEL_SHADER);
            },

            sampledViewFor(texture, wantsSRGB) {
                if (!wantsSRGB) return texture.view;
                if (!texture.srgbFormat) {
                    ++this.stats.srgbTextureUnavailable;
                    this.warnOnce("srgb-no-sibling",
                        "a stage asks for sRGB decoding on a texture whose format " +
                        "has no -srgb equivalent in WebGPU, so it is sampled as " +
                        "linear and comes out too bright", { format: texture.format,
                            gpuFormat: texture.gpuFormat });
                    return texture.view;
                }
                if (!texture.srgbView) {
                    texture.srgbView = texture.gpuTexture.createView({
                        format: texture.srgbFormat,
                        dimension: texture.textureType === "cube" ? "cube" : "2d",
                    });
                    ++this.stats.srgbViewsCreated;
                }
                ++this.stats.srgbTextureSamples;
                return texture.srgbView;
            },

            // A 1x1 opaque white stand-in per view dimension, for a stage the
            // shader samples but the app left unbound. "depth" is not a view
            // dimension but is threaded through the same cache because it plays
            // the same role: the stand-in a depth slot reads when nothing usable
            // is bound.
            fallbackViewFor(dimension, unfilterable) {
                if (dimension === "depth") return this.fallbackDepthView();
                if ((dimension === "2d" || !dimension) && !unfilterable)
                    return this.fallbackView;
                if (!this.fallbackViews) this.fallbackViews = new Map();
                const key = (dimension || "2d") + (unfilterable ? "|f32" : "|u8");
                let view = this.fallbackViews.get(key);
                if (view) return view;
                const layers = dimension === "cube" ? 6 : 1;
                const texture = this.device.createTexture({
                    label: "D3D9 fallback white " + key,
                    size: { width: 1, height: 1, depthOrArrayLayers: layers },
                    format: unfilterable ? "rgba32float" : "rgba8unorm",
                    dimension: dimension === "3d" ? "3d" : "2d",
                    usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
                });
                for (let layer = 0; layer < layers; ++layer) {
                    this.device.queue.writeTexture(
                        { texture, origin: { x: 0, y: 0, z: layer } },
                        unfilterable
                            ? new Float32Array([1, 1, 1, 1])
                            : new Uint8Array([255, 255, 255, 255]),
                        { bytesPerRow: unfilterable ? 16 : 4, rowsPerImage: 1 },
                        { width: 1, height: 1, depthOrArrayLayers: 1 });
                }
                view = texture.createView({ dimension: dimension || "2d" });
                this.fallbackViews.set(key, view);
                return view;
            },

            // The depth counterpart of the 1x1 white texture. It has to read as
            // "nothing occludes this fragment", and for a less-equal comparison
            // that means the far plane. A fresh WebGPU texture zero-initialises,
            // which is the near plane and would come out fully shadowed, so it is
            // cleared through an empty render pass -- depth formats cannot be
            // written with writeTexture.
            fallbackDepthView() {
                if (this.fallbackDepth) return this.fallbackDepth;
                const texture = this.device.createTexture({
                    label: "D3D9 fallback depth (far plane)",
                    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
                    format: DEPTH_FORMAT,
                    usage: TEXTURE_USAGE_RENDER_ATTACHMENT |
                        TEXTURE_USAGE_TEXTURE_BINDING,
                });
                const encoder = this.device.createCommandEncoder(
                    { label: "D3D9 fallback depth clear" });
                encoder.beginRenderPass({
                    colorAttachments: [],
                    depthStencilAttachment: {
                        view: texture.createView(),
                        depthClearValue: 1.0,
                        depthLoadOp: "clear",
                        depthStoreOp: "store",
                        stencilClearValue: 0,
                        stencilLoadOp: "clear",
                        stencilStoreOp: "store",
                    },
                }).end();
                this.device.queue.submit([encoder.finish()]);
                this.fallbackDepth = texture.createView({ aspect: "depth-only" });
                return this.fallbackDepth;
            }
        };
    }
    const api = { createMethods };
    global.D9WGResources = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
