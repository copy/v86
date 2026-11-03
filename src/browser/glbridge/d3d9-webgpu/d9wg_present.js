// Device-owned retained images, swap-chain surfaces, window placement and
// final scanout. Surface GPU utility pipelines stay in d9wg_surface_ops.js.
(function(global) {
    "use strict";
    function createMethods(dependencies) {
        const { TEXTURE_USAGE_RENDER_ATTACHMENT, TEXTURE_USAGE_COPY_SRC, TEXTURE_USAGE_COPY_DST, TEXTURE_USAGE_TEXTURE_BINDING, sampleCountForD3D, D3DMULTISAMPLE_NONE, D9WG, formatToGPU, D9WGStreamError, expandRowToGPU, D3DFMT_A8R8G8B8, sameVisibleRegion, D9WG_WINDOW_IS_WINDOW, D9WG_WINDOW_VISIBLE, D9WG_WINDOW_ICONIC, D9WG_WINDOW_FOREGROUND, D9WG_WINDOW_FULLSCREEN, D9WG_WINDOW_NO_SURFACE, D9WG_WINDOW_OCCLUDED, D9WG_WINDOW_REGION, readVisibleRegion, D9WG_WINDOW_STATE_BYTES } = dependencies;
        return {


            retireDeviceBackBuffer(state) {
                if (this.backBufferTexture === state.backBufferTexture) this.retireActiveSessionBackBuffer();
                this.retireGPUObject(state.backBufferTexture);
                state.backBufferTexture = state.backBufferView = state.backBufferSrgbView = null;
                state.backBufferTextureWidth = state.backBufferTextureHeight = 0;
            },


            // Compatibility/diagnostic aliases of the most recently selected
            // device. The device itself owns the texture and retires it.
            retireActiveSessionBackBuffer() {
                this.backBufferTexture = null;
                this.backBufferView = null;
                this.backBufferSrgbView = null;
                this.backBufferTextureWidth = 0;
                this.backBufferTextureHeight = 0;
                this.lastSwapTexture = null;
            },


            resizeCanvasIfNeeded(width, height) {
                if (this.canvas.width !== width) this.canvas.width = width;
                if (this.canvas.height !== height) this.canvas.height = height;
            },


            // The swap-chain colour attachment is context.getCurrentTexture(). The
            // shared canvas is resized only at Present, after that process has won
            // ownership; CREATE/RESET from a helper session must not clear the
            // currently visible owner's canvas.
            // Reading state.surface here instead was a real defect: Present rewrites
            // state.surface with the window's client rect every frame, so a windowed
            // game reported a back buffer 13 rows shorter than the auto depth target
            // created with it (Kart Rider: 800x587 against 800x600). The pass then
            // looked mismatched and dropped depth, which turns off depth testing for
            // the entire game rather than for anything the app actually did.
            /*
             * D3D9 draws into a back buffer that survives Present; WebGPU hands out
             * a different canvas texture every frame, valid only for the task that
             * acquired it. Owning the back buffer resolves both at once.
             *
             * The lifetime is what matters most. A D3D9 frame does not arrive in
             * one task -- d3d9_proxy.c flushes a partial batch whenever the DMA
             * arena fills, and each PCI record is a separate macrotask -- so
             * acquiring the swap-chain texture early and holding it across the
             * frame is the pattern that goes stale ("Destroyed texture ... used in
             * a submit"). Recording into an owned texture instead means nothing
             * before Present touches the swap chain at all, which is what lets
             * finishFrame(false) submit a partial frame (see flushThreshold).
             *
             * It is also less work than the copy pair it replaces: the previous
             * shape copied the retained image *into* the canvas texture at the
             * start of every frame (so loadOp:"load" saw last frame's pixels) and
             * copied it back *out* before Present (so GetRenderTargetData had
             * something to read). Owning it makes the retained image and the render
             * target the same object, leaving one copy at Present.
             */
            ensureBackBufferTexture(width, height, state) {
                width = Math.max(1, width >>> 0);
                height = Math.max(1, height >>> 0);
                if (state.backBufferTexture &&
                        state.backBufferTextureWidth === width &&
                        state.backBufferTextureHeight === height)
                    return this.selectDeviceBackBuffer(state);
                // A resize discards the contents, which is what D3D9 does too: the
                // back buffer is undefined across a Reset that changes its size.
                this.retireGPUObject(state.backBufferTexture);
                state.backBufferTexture = this.device.createTexture({
                    label: "D3D9 back buffer",
                    size: { width, height, depthOrArrayLayers: 1 },
                    format: this.format,
                    ...(this.swapchainSrgbFormat
                        ? { viewFormats: [this.swapchainSrgbFormat] } : {}),
                    mipLevelCount: 1,
                    // RENDER_ATTACHMENT to draw into, COPY_SRC to reach the swap
                    // chain and GetRenderTargetData, COPY_DST + TEXTURE_BINDING
                    // because StretchRect uses the back buffer as both ends of a
                    // full-screen post-processing round trip.
                    usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC |
                        TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
                });
                state.backBufferView = state.backBufferTexture.createView();
                state.backBufferSrgbView = this.swapchainSrgbFormat
                    ? state.backBufferTexture.createView(
                        { format: this.swapchainSrgbFormat })
                    : state.backBufferView;
                state.backBufferTextureWidth = width;
                state.backBufferTextureHeight = height;
                ++this.stats.backBufferAllocations;
                return this.selectDeviceBackBuffer(state);
            },


            selectDeviceBackBuffer(state) {
                this.backBufferTexture = state.backBufferTexture;
                this.backBufferView = state.backBufferView;
                this.backBufferSrgbView = state.backBufferSrgbView;
                this.backBufferTextureWidth = state.backBufferTextureWidth;
                this.backBufferTextureHeight = state.backBufferTextureHeight;
                return state.backBufferTexture;
            },


            deviceBackBuffer(state) {
                return this.ensureBackBufferTexture(this.backBufferWidthOf(state), this.backBufferHeightOf(state), state);
            },


            backBufferWidthOf(state) {
                return state.backBufferWidth || this.canvas.width ||
                    state.surface.width || 1;
            },


            backBufferHeightOf(state) {
                return state.backBufferHeight || this.canvas.height ||
                    state.surface.height || 1;
            },


            configureBackBufferMSAA(state, width, height, type, quality) {
                this.retireGPUObject(state.backBufferMsaaTexture);
                state.backBufferMsaaTexture = null;
                state.backBufferMsaaView = null;
                state.backBufferMsaaSrgbView = null;
                const sampleCount = sampleCountForD3D(type, quality);
                if (!sampleCount) {
                    this.warnOnce("invalid-backbuffer-msaa-" + type + "-" + quality,
                        "the guest requested an unsupported D3D9 multisample " +
                        "configuration; the host falls back to a single-sampled " +
                        "back buffer instead of creating an invalid WebGPU texture",
                        { type, quality });
                }
                state.multisampleType = sampleCount ? (type >>> 0)
                    : D3DMULTISAMPLE_NONE;
                state.multisampleQuality = sampleCount ? (quality >>> 0) : 0;
                state.sampleCount = sampleCount || 1;
                if (state.sampleCount === 1 || !width || !height) return;
                const descriptor = {
                    label: "D3D9 multisampled back buffer",
                    size: { width, height, depthOrArrayLayers: 1 },
                    format: this.format,
                    ...(this.swapchainSrgbFormat
                        ? { viewFormats: [this.swapchainSrgbFormat] } : {}),
                    mipLevelCount: 1,
                    sampleCount: state.sampleCount,
                    usage: TEXTURE_USAGE_RENDER_ATTACHMENT,
                };
                state.backBufferMsaaTexture = this.device.createTexture(descriptor);
                state.backBufferMsaaView = state.backBufferMsaaTexture.createView();
                state.backBufferMsaaSrgbView = this.swapchainSrgbFormat
                    ? state.backBufferMsaaTexture.createView(
                        { format: this.swapchainSrgbFormat })
                    : state.backBufferMsaaView;
            },


            notifySurface(state, reason) {
                if (typeof this.options.onSurface === "function")
                    this.options.onSurface(state.surface, reason);
            },


            onPresent(bytes, view, offset) {
                // The actual GPU submit happens in finishFrame(), called once
                // per executeBatch() when the outer D9WGBatchHeader carries
                // D9WG_BATCH_FLAG_PRESENT -- see the end of executeBatch(). The
                // guest recomputes the window's current screen position on
                // every Present (d3d9_proxy.c has no window-move subclassing in
                // M1), so this is the live source of truth for canvas placement
                // rather than a separate UPDATE_SURFACE event.
                const handle = view.getUint32(offset + D9WG.F.Present.device_handle, true);
                const state = this.deviceState(handle);
                const hwnd = view.getUint32(offset + D9WG.F.Present.hwnd, true);
                const x = view.getInt32(offset + D9WG.F.Present.x, true);
                const y = view.getInt32(offset + D9WG.F.Present.y, true);
                let width = view.getUint32(offset + D9WG.F.Present.width, true);
                let height = view.getUint32(offset + D9WG.F.Present.height, true);
                // The guest recomputes the client rect on every Present, and
                // GetClientRect is known to return an empty rect in fullscreen
                // (recorded as an open issue at M1). Letting a 0x0 report through
                // makes the host repeatedly resize/reposition the overlay canvas
                // between the real size and nothing, which reads on screen as
                // flicker. The last non-empty size is the better answer: a window
                // that genuinely has no client area has nothing to show anyway.
                if (!width || !height) {
                    ++this.stats.emptySurfaceReports;
                    width = state.surface.width || width;
                    height = state.surface.height || height;
                }
                const changed = state.surface.hwnd !== hwnd || state.surface.x !== x ||
                    state.surface.y !== y || state.surface.width !== width ||
                    state.surface.height !== height;
                state.surface = { ...state.surface, hwnd, x, y, width, height,
                    visible: true, noSurface: false };
                if (changed) {
                    ++this.stats.surfaceChanges;
                    this.notifySurface(state, "present");
                }
                this.presentingDevice = state;
            },


            // IDirect3DDevice9::SetGammaRamp. D3D9 applies this at scanout, after
            // everything the renderer did, so it is applied here in the step that
            // moves the finished back buffer onto the canvas -- see the present
            // path in finishFrame(), which swaps its plain copy for a lookup pass
            // whenever a non-identity ramp is set.
            //
            // Held as a 256x1 rgba32float lookup rather than as a curve fit: a
            // D3D9 ramp is an arbitrary table, and titles do use it for effects
            // (fades, damage flashes) that no gamma exponent can express.
            // ---- additional swap chains ----
            //
            // An additional chain targets a *different* HWND, so it needs its own
            // drawing surface: the implicit chain's canvas is the one the page
            // composites over the device window and nothing else.
            //
            // The chain's back buffer arrives as an ordinary render-target texture
            // handle, which is what keeps every other path unchanged -- draws,
            // StretchRect and readback all treat it as a texture. It becomes
            // special only here, in the step that moves the finished image onto
            // its canvas.
            //
            // The canvas itself has to come from the embedder, because only the
            // page knows where a second overlay may live in the document. Without
            // that hook the chain is refused and named rather than quietly
            // rendering nowhere.
            onCreateSwapChain(bytes, view, offset) {
                const state = this.deviceState(view.getUint32(offset + D9WG.F.CreateSwapChain.device_handle, true));
                if (!state) return;
                const handle = view.getUint32(offset + D9WG.F.CreateSwapChain.swap_chain_handle, true);
                const previous = state.swapChains.get(handle);
                if (previous) {
                    state.swapChains.delete(handle);
                    this.retireSwapChain(previous, true);
                }
                const backBufferHandle = view.getUint32(offset + D9WG.F.CreateSwapChain.back_buffer_handle, true);
                const surface = {
                    hwnd: view.getUint32(offset + D9WG.F.CreateSwapChain.hwnd, true),
                    x: view.getInt32(offset + D9WG.F.CreateSwapChain.x, true),
                    y: view.getInt32(offset + D9WG.F.CreateSwapChain.y, true),
                    width: view.getUint32(offset + D9WG.F.CreateSwapChain.width, true),
                    height: view.getUint32(offset + D9WG.F.CreateSwapChain.height, true),
                    swapChain: handle,
                    deviceHandle: state.handle,
                    sessionKey: state.surface ? state.surface.sessionKey : null,
                    visible: true,
                };
                const create = this.options.createSwapChainCanvas;
                if (typeof create !== "function") {
                    ++this.stats.swapChainsRefused;
                    this.warnOnce("additional-swap-chain",
                        "the guest created an additional swap chain, but this " +
                        "embedder supplies no createSwapChainCanvas hook, so " +
                        "there is no second surface to present it on; its frames " +
                        "are counted and dropped");
                    state.swapChains.set(handle, { handle, backBufferHandle,
                        surface, canvas: null, context: null });
                    return;
                }
                let canvas = null;
                try {
                    canvas = create(surface);
                } catch (error) {
                    this.warnOnce("additional-swap-chain-canvas",
                        "createSwapChainCanvas threw; the chain has no surface to " +
                        "present on", { message: String(error) });
                }
                let context = null;
                if (canvas) {
                    canvas.width = Math.max(1, surface.width);
                    canvas.height = Math.max(1, surface.height);
                    context = canvas.getContext("webgpu");
                    if (context) {
                        context.configure({
                            device: this.device, format: this.format,
                            alphaMode: "opaque",
                            usage: TEXTURE_USAGE_RENDER_ATTACHMENT |
                                TEXTURE_USAGE_COPY_DST,
                        });
                    }
                }
                state.swapChains.set(handle,
                    { handle, backBufferHandle, surface, canvas, context });
                ++this.stats.swapChainsCreated;
                this.notifySwapChainSurface(surface, "create");
            },


            onDestroySwapChain(bytes, view, offset) {
                const state = this.deviceState(view.getUint32(offset + D9WG.F.DestroySwapChain.device_handle, true));
                if (!state) return;
                const handle = view.getUint32(offset + D9WG.F.DestroySwapChain.swap_chain_handle, true);
                const chain = state.swapChains.get(handle);
                if (!chain) return;
                state.swapChains.delete(handle);
                this.retireSwapChain(chain, true);
                ++this.stats.swapChainsDestroyed;
            },


            onPresentSwapChain(bytes, view, offset) {
                const state = this.deviceState(view.getUint32(offset + D9WG.F.PresentSwapChain.device_handle, true));
                if (!state) return;
                const handle = view.getUint32(offset + D9WG.F.PresentSwapChain.swap_chain_handle, true);
                const chain = state.swapChains.get(handle);
                if (!chain) {
                    ++this.stats.swapChainPresentsDropped;
                    return;
                }
                // D9WGPresentSwapChain: device, chain, hwnd, x, y, width, height
                const width = view.getUint32(offset + D9WG.F.PresentSwapChain.width, true);
                const height = view.getUint32(offset + D9WG.F.PresentSwapChain.height, true);
                chain.surface = {
                    ...chain.surface,
                    hwnd: view.getUint32(offset + D9WG.F.PresentSwapChain.hwnd, true),
                    x: view.getInt32(offset + D9WG.F.PresentSwapChain.x, true),
                    y: view.getInt32(offset + D9WG.F.PresentSwapChain.y, true),
                    // An empty client rect means the guest could not find the
                    // window; the last non-empty size is the better answer, for
                    // the same reason the implicit chain keeps its own.
                    width: width || chain.surface.width,
                    height: height || chain.surface.height,
                    visible: true,
                };
                this.notifySwapChainSurface(chain.surface, "present");
                if (!chain.context) {
                    ++this.stats.swapChainPresentsDropped;
                    return;
                }
                const texture = this.resources.get(chain.backBufferHandle);
                if (!texture || !texture.gpuTexture) {
                    ++this.stats.swapChainPresentsDropped;
                    return;
                }
                if (chain.canvas) {
                    if (chain.canvas.width !== texture.width)
                        chain.canvas.width = texture.width;
                    if (chain.canvas.height !== texture.height)
                        chain.canvas.height = texture.height;
                }
                // Queued into the frame op list rather than run here, for the same
                // reason draws are: the chain's current texture is only valid
                // inside the task that acquires it, and a guest frame arrives
                // across several PCI submits.
                const frame = this.ensureFrame();
                frame.record({
                    kind: "present-swap-chain",
                    chain,
                    sourceView: this.blitSourceView(texture, 0, 0),
                    sourceFormat: texture.gpuFormat ||
                        formatToGPU(texture.format),
                    width: texture.width,
                    height: texture.height,
                });
                chain.frameReferenced = frame.serial;
                texture.frameReferenced = frame.serial;
                ++this.stats.swapChainPresents;
            },


            retireSwapChain(chain, drainQueued = false) {
                if (drainQueued && this.frame && chain.frameReferenced === this.frame.serial)
                    this.finishFrame(false);
                if (chain.context && typeof chain.context.unconfigure === "function") chain.context.unconfigure();
                this.notifySwapChainSurface({ ...chain.surface, visible: false }, "destroy");
            },
            retireSwapChains(state) {
                if (!state.swapChains) return;
                for (const chain of state.swapChains.values()) this.retireSwapChain(chain);
                state.swapChains.clear();
            },

            notifySwapChainSurface(surface, reason) {
                if (typeof this.options.onSwapChainSurface === "function")
                    this.options.onSwapChainSurface(surface, reason);
            },


            onSetGammaRamp(bytes, view, offset, length) {
                const state = this.deviceState(view.getUint32(offset + D9WG.F.SetGammaRamp.device_handle, true));
                if (!state) return;
                const values = new Float32Array(256 * 4);
                let identity = true;
                for (let index = 0; index < 256; ++index) {
                    for (let channel = 0; channel < 3; ++channel) {
                        const raw = view.getUint16(
                            offset + D9WG.F.SetGammaRamp.ramp + (channel * 256 + index) * 2, true);
                        values[index * 4 + channel] = raw / 65535;
                        // The identity ramp is entry = index * 257 (0x0000, 0x0101,
                        // ... 0xffff). Recognising it matters: a title that sets the
                        // identity ramp on startup would otherwise pay for a lookup
                        // pass on every frame for no visible difference.
                        if (raw !== index * 257) identity = false;
                    }
                    values[index * 4 + 3] = 1;
                }
                state.gammaRampIdentity = identity;
                // Counted for every accepted ramp, identity included: "the title
                // never called SetGammaRamp" and "the title set the identity ramp"
                // are different facts, and a counter that only moved for the second
                // kind could not tell them apart.
                ++this.stats.gammaRampUpdates;
                if (identity) {
                    this.retireGPUObject(state.gammaRampTexture);
                    state.gammaRampTexture = null;
                    state.gammaRampView = null;
                    return;
                }
                if (!state.gammaRampTexture) {
                    state.gammaRampTexture = this.device.createTexture({
                        label: "D3D9 gamma ramp",
                        size: { width: 256, height: 1, depthOrArrayLayers: 1 },
                        format: "rgba32float",
                        usage: TEXTURE_USAGE_TEXTURE_BINDING |
                            TEXTURE_USAGE_COPY_DST,
                    });
                    state.gammaRampView = state.gammaRampTexture.createView();
                }
                this.device.queue.writeTexture({ texture: state.gammaRampTexture },
                    values, { bytesPerRow: 256 * 16 },
                    { width: 256, height: 1, depthOrArrayLayers: 1 });
            },


            // Which device's ramp the canvas should show. A page runs one D3D9
            // device at a time in practice, but the state table is keyed by handle
            // and nothing guarantees a single entry, so this picks the first device
            // that actually has a non-identity ramp rather than assuming there is
            // exactly one.
            presentGammaView() {
                for (const state of this.devices.values()) {
                    if (state && state.gammaRampView) return state.gammaRampView;
                }
                return null;
            },


            // ---- D3D9 hardware cursor ----
            //
            // A fullscreen D3D9 game draws its pointer through SetCursorProperties
            // rather than GDI, so it never reaches the VGA framebuffer the page
            // composites under this canvas -- and the page hides the browser
            // cursor. Without this the pointer is invisible even though input
            // still works, which makes the game effectively unplayable.
            onSetCursorProperties(bytes, view, offset) {
                const width = view.getUint32(offset + D9WG.F.SetCursorProperties.width, true);
                const height = view.getUint32(offset + D9WG.F.SetCursorProperties.height, true);
                const dataBytes = view.getUint32(offset + D9WG.F.SetCursorProperties.data_bytes, true);
                const dataOffset = view.getUint32(offset + D9WG.F.SetCursorProperties.data_offset, true);
                if (!width || !height) return;
                if (dataOffset + dataBytes > bytes.byteLength) {
                    ++this.stats.malformedBatches;
                    throw new D9WGStreamError("D9WG cursor bitmap overruns the batch");
                }
                this.cursor.hotspotX = view.getUint32(offset + D9WG.F.SetCursorProperties.hotspot_x, true);
                this.cursor.hotspotY = view.getUint32(offset + D9WG.F.SetCursorProperties.hotspot_y, true);
                if (this.cursor.width !== width || this.cursor.height !== height ||
                        !this.cursor.texture) {
                    this.retireGPUObject(this.cursor.texture);
                    this.cursor.texture = this.device.createTexture({
                        label: "D3D9 hardware cursor",
                        size: { width, height, depthOrArrayLayers: 1 },
                        format: "bgra8unorm",
                        usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
                    });
                    this.cursor.view = this.cursor.texture.createView();
                    this.cursor.width = width;
                    this.cursor.height = height;
                }
                // The guest sends A8R8G8B8 at a tight width*4 stride; the same
                // BGRA storage used by every A8R8G8B8 texture. The expander
                // preserves that byte order, so the cursor texture must match.
                const source = new Uint8Array(bytes.buffer,
                    bytes.byteOffset + dataOffset, dataBytes);
                const bgra = new Uint8Array(width * height * 4);
                for (let row = 0; row < height; ++row)
                    expandRowToGPU(D3DFMT_A8R8G8B8, source, row * width * 4,
                        width, bgra, row * width * 4);
                this.device.queue.writeTexture({ texture: this.cursor.texture },
                    bgra, { bytesPerRow: width * 4, rowsPerImage: height },
                    { width, height, depthOrArrayLayers: 1 });
                ++this.stats.cursorUploads;
            },


            onSetCursorPosition(bytes, view, offset) {
                this.cursor.x = view.getInt32(offset + D9WG.F.SetCursorPosition.x, true);
                this.cursor.y = view.getInt32(offset + D9WG.F.SetCursorPosition.y, true);
            },


            onShowCursor(bytes, view, offset) {
                this.cursor.visible = view.getUint32(offset + D9WG.F.ShowCursor.show, true) !== 0;
            },


            // Moves the overlay to match a WINDOW_STATE report.
            //
            // Deliberately conservative about what counts as a real move. The
            // report also arrives for foreground changes and other events that say
            // nothing about geometry, and a 0x0 client area is the same
            // fullscreen GetClientRect artefact onPresent() already guards
            // against -- letting either through makes the canvas flicker between
            // the real size and nothing.
            //
            // Covered windows are not hidden ones. Other windows lying over all
            // or part of the device window (occluded, visibleRegion) is state the
            // surface keeps until the next report changes it -- a Present in
            // between does not uncover anything -- and the embedder shows the
            // picture only where the guest's screen shows the window.
            applyWindowStateGeometry(deviceHandle, report) {
                if (!deviceHandle) return;
                const state = this.devices.get(deviceHandle);
                if (!state) return;
                const hidden = !report.isWindow || report.iconic || !report.visible;
                if (hidden) {
                    // Visibility is tracked per device; the canvas is one shared
                    // thing. Those disagree the moment anything else puts the
                    // canvas back on screen -- a CreateDevice for the same
                    // session does exactly that -- and this device's own flag
                    // still reads false from an earlier report. Skipping the
                    // notification as redundant then drops the one message that
                    // would have taken the canvas down.
                    //
                    // A no-surface report is a teardown signal rather than a
                    // geometry update, so it is never redundant: it is the last
                    // thing an exiting process says, and if it is dropped its
                    // final frame stays composited over the guest's desktop with
                    // nothing left running to remove it.
                    if (state.surface.visible === false && !report.noSurface)
                        return;
                    if (report.noSurface) {
                        state.ddScreenWriteRect = null;
                        state.surface = { ...state.surface, clipRect: null };
                    }
                    state.surface = { ...state.surface, visible: false,
                        noSurface: !!report.noSurface };
                    ++this.stats.surfaceChanges;
                    this.notifySurface(state, "window-state");
                    return;
                }
                const width = report.clientWidth || state.surface.width;
                const height = report.clientHeight || state.surface.height;
                if (!width || !height) {
                    ++this.stats.emptySurfaceReports;
                    return;
                }
                const occluded = !!report.occluded;
                const visibleRegion = report.visibleRegion || null;
                const changed = state.surface.hwnd !== report.hwnd ||
                    state.surface.x !== report.windowX ||
                    state.surface.y !== report.windowY ||
                    state.surface.width !== width ||
                    state.surface.height !== height ||
                    state.surface.visible === false ||
                    !!state.surface.occluded !== occluded ||
                    !sameVisibleRegion(state.surface.visibleRegion || null, visibleRegion);
                if (!changed) return;
                state.surface = { ...state.surface, hwnd: report.hwnd,
                    x: report.windowX, y: report.windowY, width, height,
                    visible: true, noSurface: false, occluded, visibleRegion };
                ++this.stats.surfaceChanges;
                this.notifySurface(state, "window-state");
            },


            // Two jobs. The diagnostic one is why the opcode exists: see
            // D9WG_OP_WINDOW_STATE in d3d9_protocol.h for why the guest's
            // window-manager view has to be reported rather than inferred.
            //
            // The second is placement, and it exists for the D3D8 frontend. A
            // D3D9 title presents continuously, so onPresent() is a fine source of
            // truth for where the overlay goes. A D3D8 title need not: one that
            // draws a single frame and then only pumps messages still has to have
            // the overlay follow its window, and there is no further Present to
            // carry the geometry. d3d8_proxy.c sends this record on move/size/show
            // for exactly that reason.
            onWindowState(bytes, view, offset, length) {
                const flags = view.getUint32(offset + D9WG.F.WindowState.flags, true);
                const deviceHandle = view.getUint32(offset + D9WG.F.WindowState.device_handle, true);
                const state = {
                    hwnd: view.getUint32(offset + D9WG.F.WindowState.hwnd, true),
                    foregroundHwnd: view.getUint32(offset + D9WG.F.WindowState.foreground_hwnd, true),
                    isWindow: (flags & D9WG_WINDOW_IS_WINDOW) !== 0,
                    visible: (flags & D9WG_WINDOW_VISIBLE) !== 0,
                    iconic: (flags & D9WG_WINDOW_ICONIC) !== 0,
                    foreground: (flags & D9WG_WINDOW_FOREGROUND) !== 0,
                    fullscreen: (flags & D9WG_WINDOW_FULLSCREEN) !== 0,
                    windowX: view.getInt32(offset + D9WG.F.WindowState.window_x, true),
                    windowY: view.getInt32(offset + D9WG.F.WindowState.window_y, true),
                    windowWidth: view.getUint32(offset + D9WG.F.WindowState.window_width, true),
                    windowHeight: view.getUint32(offset + D9WG.F.WindowState.window_height, true),
                    clientWidth: view.getUint32(offset + D9WG.F.WindowState.client_width, true),
                    clientHeight: view.getUint32(offset + D9WG.F.WindowState.client_height, true),
                    // "I have nothing to show", which is not the same claim as
                    // "my window is gone": the window may be up and taking input.
                    noSurface: (flags & D9WG_WINDOW_NO_SURFACE) !== 0,
                    occluded: (flags & D9WG_WINDOW_OCCLUDED) !== 0,
                    visibleRegion: null,
                };
                if (flags & D9WG_WINDOW_REGION) {
                    state.visibleRegion = readVisibleRegion(view, offset + D9WG_WINDOW_STATE_BYTES,
                        (length === undefined ? D9WG_WINDOW_STATE_BYTES : length) - D9WG_WINDOW_STATE_BYTES,
                        state.clientWidth, state.clientHeight, state.windowX, state.windowY);
                    if (state.visibleRegion) ++this.stats.windowRegionReports;
                }
                this.windowState = state;
                ++this.stats.windowStateChanges;
                this.applyWindowStateGeometry(deviceHandle, state);
                // A device that says it has nothing to present is not describing a
                // window problem, and the two diagnostics below are about window
                // problems: they would report broken input for a title that is
                // simply done drawing.
                if (state.noSurface) return;
                // Covered by another of the guest's windows, which then rightly
                // has the foreground and the input: not a window problem either
                if (state.occluded) {
                    ++this.stats.windowOccludedReports;
                    return;
                }
                if (!state.foreground) {
                    ++this.stats.windowNotForegroundReports;
                    // The guest re-takes the foreground for a fullscreen device
                    // (maintain_fullscreen_foreground in d3d9_proxy.c), so a single
                    // report of this at startup is normal and self-healing. Repeated
                    // reports mean the claim is being refused, which is worth saying
                    // out loud: the picture looks perfect either way and every click
                    // goes somewhere else, so there is nothing on screen to notice.
                    if (this.stats.windowNotForegroundReports > 1)
                        this.warnOnce("window-not-foreground",
                            "the game's window keeps losing the guest's foreground " +
                            "even though the guest re-claims it, so clicks go to " +
                            "whatever is on top -- the overlay still shows this " +
                            "game's frames either way. Check getStats().window",
                            state);
                }
                if (state.iconic || !state.visible)
                    this.warnOnce("window-not-visible",
                        "the game's window is minimised or hidden in the guest; " +
                        "input will not reach it", state);
            },
            encodePrimaryPresent(encoder, frame, backTexture) {
                if (!backTexture) return;
                // Canvas width/height are global even though the retained
                // image is per session. Defer this destructive resize until
                // the session actually presents, so a capability helper's
                // CREATE_DEVICE cannot blank the visible process.
                this.resizeCanvasIfNeeded(this.backBufferTextureWidth,
                    this.backBufferTextureHeight);
                const swapTexture = this.context.getCurrentTexture();
                // A canvas resize between recording and here would leave
                // the two sizes disagreeing; copying the overlap keeps the
                // submit valid instead of failing the whole command buffer.
                const copyWidth = Math.min(swapTexture.width,
                    this.backBufferTextureWidth);
                const copyHeight = Math.min(swapTexture.height,
                    this.backBufferTextureHeight);
                if (copyWidth && copyHeight) {
                    let presentSource = backTexture;
                    if (typeof this.replayDDOverlays === "function") {
                        const composite = this.replayDDOverlays(encoder,
                            this.presentingDevice, backTexture,
                            copyWidth, copyHeight, frame);
                        if (composite) {
                            presentSource = composite;
                            frame.transientBuffers.push(composite);
                        }
                    }
                    // A gamma ramp is applied here, at the one point every
                    // finished pixel passes through on its way to the
                    // canvas -- which is where the hardware applies it too.
                    // The plain copy stays the path for the overwhelmingly
                    // common identity case, because a lookup pass costs a
                    // full-screen draw the copy does not.
                    const gammaView = this.presentGammaView();
                    if (gammaView) {
                        // The configured canvas format, not
                        // swapTexture.format: the context was configured
                        // with the former and a pipeline target has to
                        // match what the pass writes.
                        const entry = this.gammaBlitPipelineFor(this.format);
                        const pass = encoder.beginRenderPass({
                            colorAttachments: [{
                                view: swapTexture.createView(),
                                loadOp: "clear",
                                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                                storeOp: "store" }],
                        });
                        ++this.stats.renderPasses;
                        pass.setPipeline(entry.pipeline);
                        pass.setBindGroup(0, this.device.createBindGroup({
                                layout: entry.bindGroupLayout,
                                entries: [
                                { binding: 0,
                                  resource: presentSource.createView() },
                                { binding: 1, resource: entry.sampler },
                                { binding: 2, resource: gammaView },
                            ],
                        }));
                        pass.setViewport(0, 0, copyWidth, copyHeight, 0, 1);
                        pass.draw(6);
                        pass.end();
                        ++this.stats.gammaPresents;
                    } else {
                        encoder.copyTextureToTexture(
                            { texture: presentSource },
                            { texture: swapTexture },
                            { width: copyWidth, height: copyHeight,
                                depthOrArrayLayers: 1 });
                    }
                    ++this.stats.backBufferPresents;
                }
                // Drawn onto the canvas copy rather than the back buffer,
                // so the cursor never accumulates into the image the next
                // frame loads or GetRenderTargetData reads.
                const cursorTransient = this.drawCursor(encoder, swapTexture.createView(),
                    swapTexture.width, swapTexture.height);
                if (cursorTransient) frame.transientBuffers.push(cursorTransient);

            },
            encodeSwapChainPresent(encoder, op, frame) {
                let target = null;
                try {
                    target = op.chain.context.getCurrentTexture();
                } catch (error) {
                    ++this.stats.swapChainPresentsDropped;
                    this.warnOnce("swap-chain-acquire",
                        "an additional swap chain's canvas could not " +
                        "be acquired; its frame is dropped",
                        { message: String(error) });
                }
                if (target) {
                    const width = Math.min(target.width, op.width);
                    const height = Math.min(target.height, op.height);
                    // A blit rather than copyTextureToTexture: the
                    // chain's back buffer is an ordinary D3D texture,
                    // so its format is whatever the guest asked for,
                    // while the canvas is the preferred canvas format.
                    // A copy requires those to be identical and they
                    // routinely are not.
                    if (width && height) {
                        const transient = this.replayBlit(encoder, {
                            sourceView: op.sourceView,
                            destinationView: null,
                            destinationFormat: this.format,
                            sourceFormat: op.sourceFormat,
                            sourceRect: [0, 0, 1, 1],
                            viewport: [0, 0, width, height],
                            filterPoint: false,
                        }, target.createView());
                        if (transient)
                            frame.transientBuffers.push(transient);
                    }
                }


            },

        };
    }
    const api = { createMethods };
    global.D9WGPresent = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
