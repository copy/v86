// Shared WebGPU device/canvas ownership for every guest graphics frontend.
//
// Before this module each executor called requestAdapter()/requestDevice() and
// context.configure() for itself. That works only as long as exactly one of
// them ever runs: a GPUCanvasContext belongs to whichever device configured it
// last, so two executors sharing one canvas element silently drop one of the
// two frame streams (v86_network_bridge.js carries a long comment about
// exactly that hazard). Adding OpenGL as a third stream would have made it a
// three-way race.
//
// So the device, the canvas context and its configuration have one owner. The
// executors ask for it and get the same objects back. Sharing a device also
// means a texture created by one executor is usable by the other, which is
// what makes a future "GDI/DirectDraw surface composited under a GL overlay"
// possible at all -- separate devices could never do that.
//
// The three-way race was not hypothetical. This module shipped with only the
// OpenGL executor using it, while D3D8 and D3D9/DDraw kept acquiring their own
// devices -- and since DDraw drives the Windows desktop, the canvas was always
// already configured by the D3D9 device before any GL app started. Every
// OpenGL present pass then died with
//
//   [TextureView of Texture "...WebgpuSwapChainTexture..."] is associated with
//   [Device], and cannot be used with [Device]
//
// All three now acquire through here. tests/webgpu_shared_device_test.js
// builds all three on one canvas and asserts they land on one device, because
// each executor's own suite only ever constructs one and so cannot see this.
//
// See docs/opengl-webgpu-implementation-plan.zh-CN.md section 4.2.

(function(global) {
    "use strict";

    const TEXTURE_USAGE_COPY_SRC = 0x01;
    const TEXTURE_USAGE_COPY_DST = 0x02;
    const TEXTURE_USAGE_TEXTURE_BINDING = 0x04;
    const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

    // The union of what d3d9_executor.js and gl_executor.js each ask for. It is
    // one list rather than a per-caller negotiation because a GPUDevice's
    // feature set is fixed at creation: if the first caller asked for less, the
    // second would need a *different* device, which is the thing this module
    // exists to prevent. Every entry is optional -- an adapter that lacks one
    // simply does not get it, and the executors check deviceFeatures.
    const DEFAULT_FEATURES = [
        "texture-compression-bc",
        "float32-filterable",
        "float32-blendable",
        "timestamp-query",
        // GL_DEPTH_CLAMP / D3D9's clipping disable. Optional everywhere today.
        "depth-clip-control",
        // Real user clip planes instead of the fragment-discard emulation
        // (plan deviation D-05). Not yet shipping in any browser; asking for it
        // costs nothing when absent.
        "clip-distances",
        // VMware SVGA's DX contexts (gx_executor.js): D24/D32 with stencil
        // 8 of D3D10's formats, SRC1 blend factors, DrawInstancedIndirect's
        // first instance
        "depth32float-stencil8",
        "dual-source-blending",
        "rg11b10ufloat-renderable",
        "indirect-first-instance",
        "texture-compression-bc-sliced-3d",
        // D3D11's typed UAVs of B8G8R8A8
        "bgra8unorm-storage",
        // GLES 3.0's ETC2 and EAC, GLES 3.2's ASTC (the GLES executor, src/gles/page/gles3_executor.js)
        "texture-compression-etc2",
        "texture-compression-astc",
        // GLES 3.0's TEXTURE_SWIZZLE_*
        "texture-component-swizzle",
    ];

    // Limits raised to what the adapter allows: D3D10 has 8 render targets
    // of up to 16 bytes a pixel, 32 varyings, 128 textures and 16 samplers a
    // stage, 16 vertex buffers; D3D11 16384 texels a side, 8 (64) UAVs,
    // thread groups of 1024 with 32 KiB shared (gx_executor.js). Higher
    // limits cost nothing to the executors that need less.
    const RAISED_LIMITS = [
        "maxColorAttachmentBytesPerSample", "maxInterStageShaderVariables", "maxSampledTexturesPerShaderStage",
        "maxSamplersPerShaderStage", "maxStorageBuffersPerShaderStage", "maxUniformBuffersPerShaderStage",
        "maxVertexBuffers", "maxVertexAttributes", "maxBindingsPerBindGroup", "maxTextureArrayLayers",
        "maxStorageBufferBindingSize", "maxBufferSize",
        "maxTextureDimension1D", "maxTextureDimension2D", "maxTextureDimension3D", "maxStorageTexturesPerShaderStage",
        "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX",
        "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ", "maxComputeWorkgroupsPerDimension",
    ];

    function srgbSiblingOf(format) {
        if (format === "bgra8unorm") return "bgra8unorm-srgb";
        if (format === "rgba8unorm") return "rgba8unorm-srgb";
        return null;
    }

    class V86GPUHost {
        constructor(canvas, options) {
            this.canvas = canvas;
            this.options = options || {};
            this.gpu = this.options.gpu ||
                (global.navigator && global.navigator.gpu);
            this.adapter = this.options.adapter || null;
            this.device = this.options.device || null;
            this.context = this.options.context || null;
            this.format = this.options.format || null;
            this.swapchainSrgbFormat = null;
            this.deviceFeatures = null;
            this.readyPromise = null;
            this.failed = null;
            // name -> token. A presenter owns the swap chain; see claimPresenter.
            this.presenter = null;
            this.presenterToken = 0;
            this.nextPresenterToken = 1;
            this.deviceLostHandlers = new Set();
            this.generation = 0;
        }

        initialize() {
            if (this.readyPromise) return this.readyPromise;
            this.readyPromise = (async () => {
                if (!this.device) {
                    if (!this.gpu || typeof this.gpu.requestAdapter !== "function")
                        throw new Error("WebGPU is unavailable");
                    this.adapter = this.adapter || await this.gpu.requestAdapter({
                        powerPreference: "high-performance",
                    });
                    if (!this.adapter)
                        throw new Error("WebGPU adapter request failed");
                    const requested = [];
                    const available = this.adapter.features;
                    const supports = name => !!(available &&
                        typeof available.has === "function" && available.has(name));
                    const wanted = this.options.requiredFeatures || DEFAULT_FEATURES;
                    for (const name of wanted) {
                        if (supports(name)) requested.push(name);
                    }
                    const requiredLimits = {};
                    const limits = this.adapter.limits || {};
                    for (const name of RAISED_LIMITS) {
                        if (typeof limits[name] === "number") requiredLimits[name] = limits[name];
                    }
                    this.device = await this.adapter.requestDevice({
                        ...(requested.length ? { requiredFeatures: requested } : {}),
                        requiredLimits,
                    });
                }
                this.deviceFeatures = this.featureFlags();
                this.limits = this.device.limits || (this.adapter && this.adapter.limits) || {};
                this.configureCanvas();
                this.watchForDeviceLoss();
                return this;
            })().catch(error => {
                this.failed = error;
                console.error("[webgpu-host] initialization failed", error);
                throw error;
            });
            return this.readyPromise;
        }

        featureFlags() {
            const features = this.device && this.device.features;
            const has = name => !!(features &&
                typeof features.has === "function" && features.has(name));
            return {
                bc: has("texture-compression-bc"),
                float32Filterable: has("float32-filterable"),
                float32Blendable: has("float32-blendable"),
                timestampQuery: has("timestamp-query"),
                depthClipControl: has("depth-clip-control"),
                clipDistances: has("clip-distances"),
                depth32Stencil8: has("depth32float-stencil8"),
                dualSourceBlending: has("dual-source-blending"),
                bgra8unormStorage: has("bgra8unorm-storage"),
            };
        }

        configureCanvas() {
            if (!this.canvas) return;
            this.context = this.context ||
                (typeof this.canvas.getContext === "function" ?
                    this.canvas.getContext("webgpu") : null);
            if (!this.context)
                throw new Error("could not acquire a WebGPU canvas context");
            this.format = this.format || (this.gpu &&
                typeof this.gpu.getPreferredCanvasFormat === "function" ?
                this.gpu.getPreferredCanvasFormat() : "bgra8unorm");
            this.swapchainSrgbFormat = srgbSiblingOf(this.format);
            // Same usage set d3d9_executor.js has always configured: a canvas
            // context defaults to RENDER_ATTACHMENT alone, but both backends
            // copy into and sample from the swap-chain texture (GL's
            // glCopyTexImage2D from the back buffer, D3D9's StretchRect
            // post-processing), so the extra usages are not optional.
            this.context.configure({
                device: this.device,
                format: this.format,
                ...(this.swapchainSrgbFormat ?
                    { viewFormats: [this.swapchainSrgbFormat] } : {}),
                alphaMode: "opaque",
                usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC |
                    TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
            });
        }

        /*
         * A presenter owns the swap chain. Only one may at a time, because
         * getCurrentTexture() hands out the same texture to whoever asks and
         * the last render into it before the frame ends is what the user sees.
         *
         * A game process loads exactly one of opengl32.dll / d3d8.dll /
         * d3d9.dll / ddraw.dll, so in practice nobody ever contends. The point
         * of the token is that when the deployment rule *is* violated, the
         * second claimant learns about it in one console line instead of by
         * having its frames silently disappear. It keeps rendering into its own
         * back buffer either way, so getStats()/dumpSmallTextures() still work.
         */
        claimPresenter(name) {
            if (this.presenter && this.presenter !== name) {
                if (!this.presenterConflictReported) {
                    this.presenterConflictReported = true;
                    console.error("[webgpu-host] two graphics APIs are both " +
                        "presenting to the same canvas; only the first keeps " +
                        "the swap chain. A game directory must contain exactly " +
                        "one of opengl32.dll/d3d8.dll/d3d9.dll/ddraw.dll.", {
                            owner: this.presenter,
                            rejected: name,
                        });
                }
                return 0;
            }
            if (!this.presenter) {
                this.presenter = name;
                this.presenterToken = this.nextPresenterToken++;
            }
            return this.presenterToken;
        }

        releasePresenter(token) {
            if (token && token === this.presenterToken) {
                this.presenter = null;
                this.presenterToken = 0;
                this.presenterConflictReported = false;
            }
        }

        canPresent(token) {
            return !!token && token === this.presenterToken;
        }

        /* Executors register here instead of each attaching to device.lost, so
         * that recovery happens once and in a defined order: the host rebuilds
         * the device and reconfigures the canvas, then every executor rebuilds
         * its own resources against the new device. */
        onDeviceLost(handler) {
            this.deviceLostHandlers.add(handler);
            return () => this.deviceLostHandlers.delete(handler);
        }

        watchForDeviceLoss() {
            const device = this.device;
            if (!device || !device.lost || typeof device.lost.then !== "function")
                return;
            device.lost.then(info => {
                if (this.device !== device) return;   // already replaced
                if (info && info.reason === "destroyed") return;
                console.error("[webgpu-host] GPUDevice lost", info && info.message);
                this.recover();
            }).catch(() => { /* a destroyed device rejecting is not an error */ });
        }

        async recover() {
            if (this.destroyed) return;
            if (this.recovering) return this.recovering;
            this.recovering = (async () => {
                this.device = null;
                this.context = null;
                this.format = this.options.format || null;
                this.readyPromise = null;
                ++this.generation;
                await this.initialize();
                for (const handler of Array.from(this.deviceLostHandlers)) {
                    try {
                        await handler(this);
                    } catch (error) {
                        console.error("[webgpu-host] device-loss handler failed",
                            error);
                    }
                }
            })().finally(() => { this.recovering = null; });
            return this.recovering;
        }

        /* Canvas size is a shared resource too: whichever executor owns the
         * presenter decides it, and the other must not fight over it. */
        resizeCanvas(width, height) {
            const w = Math.max(1, width | 0);
            const h = Math.max(1, height | 0);
            if (!this.canvas) return false;
            if (this.canvas.width === w && this.canvas.height === h) return false;
            this.canvas.width = w;
            this.canvas.height = h;
            return true;
        }
    }

    // One host per canvas element. Keyed weakly so a page that swaps canvases
    // (the state-restore path replaces the overlay element) does not leak.
    const hosts = new WeakMap();
    // Tests inject a fake canvas object that is not a real Element; a WeakMap
    // handles those identically, but the fallback list keeps a host reachable
    // when the caller passes null (headless executor tests).
    let nullCanvasHost = null;

    function acquire(canvas, options) {
        if (!canvas) {
            if (!nullCanvasHost) nullCanvasHost = new V86GPUHost(null, options);
            return nullCanvasHost;
        }
        let host = hosts.get(canvas);
        if (!host) {
            host = new V86GPUHost(canvas, options);
            hosts.set(canvas, host);
        }
        return host;
    }

    function reset(canvas) {
        if (!canvas) { nullCanvasHost = null; return; }
        hosts.delete(canvas);
    }

    const api = { V86GPUHost, acquire, reset, DEFAULT_FEATURES, srgbSiblingOf };
    global.V86GPUHost = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
