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
// Channel messages, device -> renderer:
//   submit { seq, bytes, stream }   a D9WG batch, or with stream "gx" a GX
//                           batch, "vx" a VX one (virtio-gpu's Vulkan)
//   reset  {}               the machine was reset: forget every object
// renderer -> device:
//   write  { offset, bytes } into the response region: a query result or a
//                            readback, tagged with its request id
//   done   { seq }           the batch has run and its writes were sent
//   lost   { reason }        the renderer cannot go on
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
            };
            gx = new GX.GXExecutor({ device: executor.device, formats: global.V86SVGADXFormats,
                features: executor.deviceFeatures || {}, peer });
            return gx;
        };

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

        channel.listen(message => {
            switch (message.type) {
                case "submit": {
                    const seq = message.seq, bytes = message.bytes, forGeneration = generation;
                    const stream = message.stream || "d9wg";
                    queue = queue.then(async () => {
                        if (forGeneration !== generation) return;
                        if (!lost && stream === "vx") {
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
                case "reset":
                    ++generation;
                    queue = queue.then(() => {
                        if (gx) gx.reset();
                        if (vx) vx.reset();
                        return executor.resetForReplay();
                    }).catch(error => fail(error));
                    break;
            }
        });

        return {
            executor,
            get gx() { return gx; },
            get vx() { return vx; },
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
