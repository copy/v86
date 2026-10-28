// The host half of the display adapters' 3D (graphics_adapter "vmware_svga"
// and "virtio_gpu"; docs/gpu-devices.md, "Architecture"). At levels vgpu9 and
// gb9 the SVGA device (src/graphics_adapters/vmware_svga/svga3d.js) turns the
// guest's SVGA3D commands into D9WG batches; this runs them through a D3D9
// executor of its own. GX batches (SVGA's DX levels, virgl) go to GX
// (gx/gx_executor.js) and VX batches (Venus) to VX (vx/vx_executor.js), both
// on the D3D9 executor's WebGPU device. It answers with what the batches
// wrote back and when each has run. It draws nothing on the page: pictures go
// back to the device as readbacks, and the device shows them on its screens
// like 2D ones.
//
// With options.scanoutLayer (a layer of the page's compositor, whose device
// it then shares, webgpu_compositor.js) GX's SURFACE_PRESENT copies a
// scanout's picture into that layer on the GPU: no readback
// (docs/gfxstream-plan.md G4).
//
// The ranchu machine's GLES host (docs/gles-proxy-plan.md) sends stream
// "gles": GLES batches for the GLES executor (V86GLESExecutor, E3), on the
// same device.
//
// Channel messages, device -> renderer:
//   submit { seq, bytes, stream }   a D9WG batch, or with stream "gx" a GX
//                           batch, "vx" a VX one (virtio-gpu's Vulkan),
//                           "gles" a GLES one
//   reset  {}               the machine was reset: forget every object
//   hello  {}               the device asks what the renderer can do
//   gles_save { id }        (the GLES host, before a snapshot) the GLES
//                           executor's state, with the GPU's contents
//   gles_restore { state }  (after a reset) a snapshot's GLES state back
// renderer -> device:
//   write  { offset, bytes } into the response region: a query result or a
//                            readback, tagged with its request id
//   done   { seq }           the batch has run and its writes were sent
//   lost   { reason }        the renderer cannot go on
//   caps   { present }       (to hello and reset) whether SURFACE_PRESENT shows pictures
//   frame  { width, height, bytes }  (stream "gles", without a layer) a posted
//                            color buffer, RGBA rows from the top
//   gles_saved { id, state } gles_save's answer (null: no GLES executor yet)
(function(global) {
    "use strict";

    // d3d9_protocol.h: the response region is the last 4 MiB of a 16 MiB arena
    const RESPONSE_REGION_OFFSET = 12 * 1024 * 1024;
    const HEARTBEAT_OFFSET = 4 * 1024 * 1024 - 16;

    /**
     * @param channel { post(message, transfer), listen(handler) }
     * @param options { canvas, executorOptions }
     */
    function createSVGARenderer(channel, options) {
        options = options || {};
        const Executor = global.D3D9WebGPUExecutor;
        if (typeof Executor !== "function")
            throw new Error("the SVGA renderer needs d3d9_executor.js (libv86-webgpu.js)");
        // The executor wants a canvas for its device; nothing is shown on it
        const canvas = options.canvas || new global.OffscreenCanvas(1, 1);
        const executor = new Executor(canvas, { ...(options.executorOptions || {}) });
        let generation = 0;
        let lost = false;
        // submits and resets in the order they came
        let queue = Promise.resolve();

        const writer = forGeneration => (offset, data) => {
            // (the heartbeat at the end of the region is for proxies spinning
            // on a readback; the device waits for done instead)
            if (forGeneration !== generation || offset >= RESPONSE_REGION_OFFSET + HEARTBEAT_OFFSET) return;
            const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
            channel.post({ type: "write", offset: offset - RESPONSE_REGION_OFFSET, bytes }, [bytes.buffer]);
        };

        const fail = reason => {
            if (lost) return;
            lost = true;
            console.error("[svga-renderer] " + reason);
            channel.post({ type: "lost", reason: String(reason) });
        };

        // GX (DX contexts, level dx10 and up), made on the D3D9 executor's device the first time
        let gx = null;
        const gxExecutor = async () => {
            if (gx) return gx;
            if (!executor.device) await executor.initialize();
            const GX = global.V86GXExecutor;
            if (!GX || !global.V86SVGADXFormats) throw new Error("the SVGA renderer needs gx_executor.js (libv86-webgpu.js)");
            // surfaces legacy 3D and DX share are copied between the two on the GPU
            const peer = {
                resource: handle => executor.resources ? executor.resources.get(handle) || null : null,
                flush: () => { if (executor.frame) executor.finishFrame(false); },
                // (a surface goes: VX's commands recorded with it, as images Venus imported, are submitted first)
                releasing: () => { if (vx) vx.flushEncoder(); },
            };
            if (layer) peer.present = present;
            gx = new GX.GXExecutor({ device: executor.device, formats: global.V86SVGADXFormats,
                features: executor.deviceFeatures || {}, peer });
            return gx;
        };

        // The page's screen: a layer of its compositor, the GX surface's
        // rectangle copied into it (the same format) and shown over the screen
        const layer = options.scanoutLayer || null;
        const present = p => {
            if (!p) {
                layer.place(0, 0, 0, 0, false);
                return;
            }
            const configuration = layer.context.getConfiguration();
            if (!configuration || configuration.format !== p.format) {
                layer.context.configure({ format: p.format });
                layer.texture = null;
            }
            layer.canvas.width = p.width;
            layer.canvas.height = p.height;
            p.encoder.copyTextureToTexture({ texture: p.texture, origin: [p.x, p.y, 0] },
                { texture: layer.context.getCurrentTexture(), origin: [p.dx, p.dy, 0] }, [p.w, p.h, 1]);
            layer.place(0, 0, p.width, p.height, true);
        };
        const caps = () => channel.post({ type: "caps", present: !!layer });

        // VX (virtio-gpu's Venus contexts), on the same device
        let vx = null;
        const vxExecutor = async () => {
            if (vx) return vx;
            if (!executor.device) await executor.initialize();
            const VX = global.V86VXExecutor;
            if (!VX) throw new Error("the renderer needs vx_executor.js (libv86-webgpu.js)");
            // (GX's surfaces: the images Venus imports from virtio-gpu resources)
            const peer = { surface: sid => gx && gx.surfaces ? gx.surfaces.get(sid) || null : null };
            vx = new VX.VXExecutor({ device: executor.device, formats: global.V86VenusFormats, peer });
            return vx;
        };

        // GLES (the ranchu machine's GLES host), on the same device; until
        // the page has its executor, a batch's reads fail (the guest reads
        // zeros) and nothing is drawn
        let gles = null;
        const glesExecutor = async () => {
            if (gles) return gles;
            const GLES = global.V86GLESExecutor;
            if (!GLES) return null;
            if (!executor.device) await executor.initialize();
            gles = new GLES.GLESExecutor({ device: executor.device, layer, features: executor.deviceFeatures || {} });
            return gles;
        };
        const glesUnanswered = bytes => {
            // (the records' READ_PIXELS and COLOR_BUFFER_READ: request ids at
            // dword 3 and dword 9 of their bodies; renderer_protocol.js GLES)
            const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
            for (let at = 4, i = 0; i < words[3] && at + 1 < words.length; i++) {
                const op = words[at], request = op === 17 ? words[at + 3] : op === 11 ? words[at + 9] : 0;
                if (request) {
                    const answer = new Uint8Array(16);
                    new DataView(answer.buffer).setUint32(0, request, true);
                    new DataView(answer.buffer).setUint32(12, 2, true); // RESPONSE_FAILED
                    channel.post({ type: "write", offset: 0, bytes: answer }, [answer.buffer]);
                }
                at += 2 + words[at + 1];
            }
        };

        channel.listen(message => {
            switch (message.type) {
                case "submit": {
                    const seq = message.seq, bytes = message.bytes, forGeneration = generation;
                    const stream = message.stream || "d9wg";
                    queue = queue.then(async () => {
                        if (forGeneration !== generation) return;
                        if (stream === "gles") {
                            try {
                                const target = lost ? null : await glesExecutor();
                                if (target) {
                                    await target.submit(bytes, { writeResponse: (offset, data) => {
                                        if (forGeneration !== generation) return;
                                        const copy = data.slice();
                                        channel.post({ type: "write", offset, bytes: copy }, [copy.buffer]);
                                    }, frame: (rgba, width, height) => {
                                        if (forGeneration !== generation) return;
                                        channel.post({ type: "frame", width, height, bytes: rgba }, [rgba.buffer]);
                                    } });
                                } else {
                                    glesUnanswered(bytes);
                                }
                            } catch (error) {
                                fail(error && error.stack || error);
                            }
                        } else if (!lost && stream === "vx") {
                            try {
                                const target = await vxExecutor();
                                await target.submit(bytes, { writeResponse: (offset, data) => {
                                    if (forGeneration !== generation) return;
                                    const copy = data.slice();
                                    channel.post({ type: "write", offset, bytes: copy }, [copy.buffer]);
                                } });
                            } catch (error) {
                                fail(error && error.stack || error);
                            }
                        } else if (!lost && stream === "gx") {
                            try {
                                const target = await gxExecutor();
                                await target.submit(bytes, { writeResponse: (offset, data) => {
                                    if (forGeneration !== generation) return;
                                    const copy = data.slice();
                                    channel.post({ type: "write", offset, bytes: copy }, [copy.buffer]);
                                } });
                            } catch (error) {
                                fail(error && error.stack || error);
                            }
                        } else if (!lost) {
                            await executor.submit(bytes, { writeGuestMemory: writer(forGeneration),
                                submitCount: seq });
                            if (executor.failed && !executor.device) fail(executor.failed);
                        }
                        if (forGeneration === generation) channel.post({ type: "done", seq });
                    });
                    break;
                }
                case "hello":
                    caps();
                    break;
                case "gles_save": {
                    // (after the batches sent before it)
                    const id = message.id;
                    queue = queue.then(async () => {
                        let state = null;
                        try {
                            if (gles && !lost) state = await gles.save();
                        } catch (error) {
                            console.warn("GLES: the page's state could not be saved: " + (error && error.message || error));
                        }
                        channel.post({ type: "gles_saved", id, state }, state ? state[1].map(b => b.buffer) : []);
                    });
                    break;
                }
                case "gles_restore": {
                    const state = message.state, forGeneration = generation;
                    queue = queue.then(async () => {
                        if (forGeneration !== generation || lost) return;
                        try {
                            const target = await glesExecutor();
                            if (target) target.restore(state);
                        } catch (error) {
                            fail(error && error.stack || error);
                        }
                    });
                    break;
                }
                case "reset":
                    ++generation;
                    if (layer) layer.place(0, 0, 0, 0, false);
                    caps();
                    queue = queue.then(() => {
                        // (VX first: its images may be GX's surfaces)
                        if (gles) gles.reset();
                        if (vx) vx.reset();
                        if (gx) gx.reset();
                        return executor.resetForReplay();
                    }).catch(error => fail(error));
                    break;
            }
        });

        return {
            executor,
            get gx() { return gx; },
            get vx() { return vx; },
            get gles() { return gles; },
            // the batches sent so far have run
            idle: () => queue.then(() => executor.checkpointIdle()),
            destroy() {
                ++generation;
                executor.destroyed = true;
                if (executor.shaderWorker) executor.shaderWorker.terminate();
            },
        };
    }

    global.V86SVGARenderer = createSVGARenderer;
    if (typeof module !== "undefined" && module.exports)
        module.exports = { createSVGARenderer };
})(typeof globalThis !== "undefined" ? globalThis : this);
