// The v86gl virtio device: the CPU side of the graphics proxy, a descriptor
// for v86's virtio_devices. It runs where the CPU runs (the page, or the CPU
// worker), knows nothing of WebGPU, and talks to the renderer
// (graphics_proxy.js) over a channel. See docs/graphics-proxy-plugin-plan.md.
//
// The PCI identity, slot, ports, configuration space and request layout are
// v86gl.sys's ABI. The VGL2/GLWG/D9WG rendering protocols ride in the batches
// unchanged. See docs/glbridge.md.
//
// Channel messages, device -> host:
//   batch      { id, generation, frameId, flags, commandCount, descAddr,
//                descLen, batchAddr, responseBase, submitCount, bytes }
//   released   {}                             the process that mapped the arena
//                                             let it go (it exited or was killed)
// host -> device:
//   write      { generation, offset, bytes, inlineId? }  readback into the arena
//              inlineId: GL command-memory response, expires on next submit;
//              absent: dedicated response slots / heartbeat, arena lifetime
//   done       { id }                         the batch no longer needs its capacity
//   available  { value }                      whether a renderer takes batches
//   capabilities { value }                    what the renderer's adapter backs
//                                             (gl_caps.js), for the GL shadow
//   machine_reset {}                          the guest was reset: no GL context
//                                             outlives it
//   initializing { value }                   hold descriptors until startup finishes
//   glslang    { module } or { error }        glslang's WebAssembly.Module, for
//                                             the GL shadow's GLSL answers
//
// The GL shadow (gl-webgpu/gl_shadow.js, when loaded) reads each GL batch in
// guest memory before it is posted and answers the guest's synchronous
// queries there.

(function(global) {
    "use strict";

    const MAGIC = 0x324C4756;
    // v86gl_pci.js's snapshots (state[92] before virtio_devices)
    const LEGACY_STATE_MAGIC = 0x56514731;
    const STATE_VERSION = 3;
    const ARENA_BYTES = 16 * 1024 * 1024;
    const RESPONSE_AREA_BYTES = 4 * 1024 * 1024;
    const HEADER_BYTES = 32;
    const REQUEST_BYTES = 24;
    const RESPONSE_BYTES = 16;
    const F_SHARED_ARENA = 0;
    const F_VERSION_1 = 32;
    const REGISTER_ARENA = 1;
    const SUBMIT = 2;
    const UNREGISTER_ARENA = 3;
    const OK = 0;
    const INVALID = 1;
    const NO_ARENA = 2;
    const NO_RENDERER = 3;

    // Flow control across threads only: on one thread the renderer takes each
    // batch as it comes, as it always has
    const MAX_INFLIGHT_BATCHES = 8;
    const MAX_INFLIGHT_BYTES = 32 * 1024 * 1024;

    /**
     * @param channel { remote, post(message, transfer), listen(handler) }
     * @return a virtio_devices descriptor
     */
    function createV86GLDevice(channel) {
        const remote = !!channel.remote;
        const shadow = global.V86GLShadow ? new global.V86GLShadow.GLShadow() : null;
        // Standalone shadow tests can check GLSL without a GPU. The guest's
        // device always waits for the real renderer before publishing a link.
        if (shadow) shadow.requireGPUProgramValidation = true;
        let dev = null;
        let arenaAddress = 0;
        let arenaBytes = 0;
        let arenaGeneration = 0;
        let lastFrameId = 0;
        let lastBytes = 0;
        let submitCount = 0;
        let hostAvailable = false;
        let initializing = false;
        let nextBatch = 0;
        const inflight = new Map();
        let inflightBytes = 0;
        let processing = false;
        let processAgain = false;
        let heldRequest = null;

        if (shadow) shadow.writeResponse = (target, bytes, statusOffset) => {
            if (target.generation !== arenaGeneration || target.batchId !== nextBatch || !arenaBytes) return;
            const offset = HEADER_BYTES + target.offset;
            if (offset < HEADER_BYTES || offset + bytes.length > arenaBytes) return;
            dev.write_memory(bytes.subarray(0, statusOffset), arenaAddress + offset);
            dev.write_memory(bytes.subarray(statusOffset + 4), arenaAddress + offset + statusOffset + 4);
            dev.write_memory(bytes.subarray(statusOffset, statusOffset + 4), arenaAddress + offset + statusOffset);
        };
        if (shadow) shadow.onCPUResume = (bytes, segments, metadata) => {
            if (metadata?.generation !== arenaGeneration || !arenaBytes) return;
            const offset = metadata.offset || 0;
            channel.post({ type: "batch", continuation: true, generated: !!metadata.generated, id: metadata.batchId, generation: arenaGeneration,
                frameId: metadata.frameId, flags: metadata.generated || shadow.cpuBarrier || !metadata.root ? 0 : metadata.flags,
                commandCount: metadata.commandCount, descAddr: arenaAddress, descLen: bytes.length + HEADER_BYTES,
                batchAddr: metadata.generated ? 0 : arenaAddress + HEADER_BYTES + offset,
                inlineOffset: metadata.generated ? 0 : offset,
                responseBase: arenaBytes - RESPONSE_AREA_BYTES - HEADER_BYTES - (metadata.generated ? 0 : offset),
                submitCount: metadata.submitCount, bytes, ...(segments ? { segments } : {}) }, remote && bytes.buffer.byteLength ? [bytes.buffer] : undefined);
        };
        if (shadow) shadow.onCPUComplete = metadata => {
            if (heldRequest?.id === metadata.batchId && heldRequest.generation === metadata.generation) completeHeld(OK);
        };

        function completeHeld(status) {
            if (!heldRequest) return;
            const held = heldRequest; heldRequest = null;
            const response = held.response.slice(); response[0] = status;
            held.request.write(new Uint8Array(response.buffer)); held.request.complete(); dev.flush(0);
            processQueue();
        }

        function releaseArena() {
            ++arenaGeneration;
            arenaAddress = 0;
            arenaBytes = 0;
        }

        function forgetInflight() {
            inflight.clear();
            inflightBytes = 0;
        }

        function canAccept() {
            return !heldRequest && !shadow?.cpuBarrier && (!remote || inflight.size < MAX_INFLIGHT_BATCHES &&
                inflightBytes <= MAX_INFLIGHT_BYTES - ARENA_BYTES);
        }

        channel.listen(message => {
            switch (message.type) {
                case "initializing":
                    initializing = !!message.value;
                    if (!initializing && dev) processQueue();
                    break;
                case "write": {
                    // A readback lands in the arena of the batch that asked for it
                    const offset = message.offset;
                    const bytes = message.bytes;
                    if (message.generation !== arenaGeneration || !arenaBytes) return;
                    // A timed-out GL inline response must not overwrite the
                    // next command stream, even when its page-side callback
                    // ran before that newer batch reached the page.
                    if (message.inlineId !== undefined && message.inlineId !== nextBatch) return;
                    if (!Number.isInteger(offset) || offset < 0 || offset + bytes.length > arenaBytes)
                        throw new RangeError("v86gl write outside registered arena");
                    dev.write_memory(bytes, arenaAddress + offset);
                    break;
                }
                case "done": {
                    const bytes = inflight.get(message.id);
                    if (bytes === undefined) return;
                    inflight.delete(message.id);
                    inflightBytes -= bytes;
                    // Descriptors left with the guest while the renderer was full
                    processQueue();
                    break;
                }
                case "gl_vertex_result":
                    if (message.generation === arenaGeneration && arenaBytes && shadow?.completeVertexCapture)
                        shadow.completeVertexCapture(message);
                    break;
                case "gl_program_link_result":
                    if (message.generation === arenaGeneration && arenaBytes && shadow?.completeProgramLink)
                        shadow.completeProgramLink(message);
                    break;
                case "capabilities":
                    // (a restored snapshot's stand: the guest was told those)
                    if (shadow && !shadow.capabilities) shadow.setCapabilities(message.value);
                    break;
                case "machine_reset":
                    if (shadow) shadow.reset();
                    completeHeld(INVALID);
                    break;
                case "glslang":
                    if (shadow && global.V86GLGlslang) {
                        try {
                            if (!message.module) throw new Error(message.error || "no compiler module was supplied");
                            shadow.setGlslang(new global.V86GLGlslang.Glslang(message.module));
                        } catch (error) {
                            shadow.setGlslangFailure(error.message);
                        }
                    } else if (shadow) shadow.setGlslangFailure("the compiler loader is missing");
                    break;
                case "available":
                    hostAvailable = !!message.value;
                    if (!hostAvailable) { if (shadow?.cpuBarrier) shadow.cancelCPU(); completeHeld(NO_RENDERER); }
                    // A renderer that is gone acknowledges nothing: answer the
                    // descriptors left with the guest (NO_RENDERER) rather than
                    // leave its driver waiting until it resets the queue
                    if (!hostAvailable && inflight.size) {
                        forgetInflight();
                        if (dev) processQueue();
                    }
                    break;
            }
        });

        // A local renderer answers inside post(): its "done" comes back while
        // the queue is being processed
        function processQueue() {
            if (processing) {
                processAgain = true;
                return;
            }
            processing = true;
            try {
                do {
                    processAgain = false;
                    processRequests();
                } while (processAgain);
            } finally {
                processing = false;
            }
        }

        function processRequests() {
            if (initializing) return;
            if (!dev.is_feature_negotiated(F_SHARED_ARENA) || !dev.is_feature_negotiated(F_VERSION_1)) return;
            // Leave descriptors with the guest until the renderer has room
            while (canAccept() && dev.has_request(0)) {
                const request = dev.pop_request(0);
                if (!request) break;
                if (request.readable !== REQUEST_BYTES || request.writable !== RESPONSE_BYTES) {
                    dev.needs_reset();
                    break;
                }
                let result = INVALID;
                try {
                    result = handleRequest(request.read());
                } catch (error) {
                    console.error("[virtio-v86gl] request failed", error);
                }
                const response = new Uint32Array([result, lastFrameId, lastBytes, submitCount]);
                if (result === OK && shadow?.cpuBarrier) {
                    heldRequest = { request, response, generation: arenaGeneration, id: nextBatch };
                    break;
                }
                request.write(new Uint8Array(response.buffer));
                request.complete();
            }
            dev.flush(0);
        }

        function handleRequest(request) {
            const view = new DataView(request.buffer, request.byteOffset, REQUEST_BYTES);
            const op = view.getUint32(0, true);
            const address = view.getUint32(4, true);
            const high = view.getUint32(8, true);
            const length = view.getUint32(12, true);
            const flags = view.getUint32(16, true);
            if (view.getUint32(20, true)) return INVALID;
            if (op === REGISTER_ARENA) {
                // A 64-bit guest-physical address: RAM anywhere on the 36-bit bus
                const arena = address + high * 0x100000000;
                if (arenaBytes || flags || length !== ARENA_BYTES || !arena || !dev.is_ram(arena, length))
                    return INVALID;
                ++arenaGeneration;
                arenaAddress = arena;
                arenaBytes = length;
                return OK;
            }
            if (address || high) return INVALID;
            if (op === UNREGISTER_ARENA) {
                if (length || flags) return INVALID;
                // v86gl.sys unmaps when its owner closes the device, which the
                // kernel does for a killed process too: every session it
                // submitted is over (review S1-10, GL S1-4)
                if (arenaBytes) channel.post({ type: "released" });
                releaseArena();
                if (shadow) shadow.reset();
                return OK;
            }
            if (op !== SUBMIT || (flags & ~1)) return INVALID;
            if (!arenaBytes) return NO_ARENA;
            if (length < HEADER_BYTES || length > arenaBytes) return INVALID;

            // A view of guest RAM while the batch has one contiguous backing
            // (checked per submission: the physical map may have changed)
            const raw = dev.read_memory(arenaAddress, length);
            const header = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
            const commandBytes = header.getUint32(20, true);
            // VGL2 reserved words belong to the graphics protocol, not to the
            // virtqueue request. Shipping D3D8/D3D9/DDraw DLLs put D9WG_MAGIC in
            // reserved0; the old PCI transport ignored both words. Preserve that ABI.
            if (header.getUint32(0, true) !== MAGIC || header.getUint32(4, true) !== 1 ||
                    commandBytes !== length - HEADER_BYTES || (header.getUint32(8, true) & ~1))
                return INVALID;
            if (!hostAvailable) return NO_RENDERER;
            const id = ++nextBatch;
            const frameId = header.getUint32(12, true);

            // A GL batch's answers, written into the guest's memory before
            // it is copied (a D3D batch is one envelope record, 0xFFE1)
            let segments;
            if (shadow && !(length >= HEADER_BYTES + 4 && (header.getUint16(HEADER_BYTES, true) & 0xFFF0) === 0xFFE0 &&
                    header.getUint16(HEADER_BYTES + 2, true) === 0xFFFF))
                segments = shadow.process(raw.subarray(HEADER_BYTES), { generation: arenaGeneration, batchId: id, root: true, offset: 0,
                    frameId, flags: header.getUint32(8, true) | flags, commandCount: header.getUint32(16, true), submitCount: submitCount + 1 });

            // Across threads a copy the renderer owns; never the guest's memory
            const bytes = remote ? raw.slice(HEADER_BYTES) : raw.subarray(HEADER_BYTES);
            inflight.set(id, bytes.byteLength);
            inflightBytes += bytes.byteLength;
            channel.post({
                type: "batch",
                id,
                generation: arenaGeneration,
                frameId,
                flags: shadow?.cpuBarrier ? 0 : header.getUint32(8, true) | flags,
                commandCount: header.getUint32(16, true),
                descAddr: arenaAddress,
                descLen: length,
                batchAddr: arenaAddress + HEADER_BYTES,
                responseBase: arenaBytes - RESPONSE_AREA_BYTES - HEADER_BYTES,
                submitCount: submitCount + 1,
                bytes,
                ...(segments ? { segments } : {}),
            }, remote ? [bytes.buffer] : undefined);
            lastFrameId = frameId;
            lastBytes = commandBytes;
            ++submitCount;
            return hostAvailable ? OK : NO_RENDERER;
        }

        return {
            name: "v86gl",
            // The slot keeps Windows' device instance, and so the installed driver
            pci_slot: 0x13,
            io_base: 0xF100,
            // Provisional, unallocated local ID. NOT the standard virtio-gpu ID.
            device_id: 0x107F,
            subsystem_device_id: 0x5686,
            features: [F_SHARED_ARENA],
            queues: [{ size: 8 }],
            config: [
                { bytes: 4, name: "magic", read: () => MAGIC },
                { bytes: 4, name: "version", read: () => 1 },
                { bytes: 4, name: "arena_bytes", read: () => ARENA_BYTES },
                { bytes: 4, name: "max_batch_bytes", read: () => ARENA_BYTES },
            ],
            init(handle) {
                dev = handle;
            },
            notify() {
                processQueue();
            },
            // Batches the renderer has not acknowledged yet
            busy() {
                // A renderer acknowledgement can precede the CPU's delivery
                // of a vertex result. The retained IOCTL is still live even
                // after its original rendering batch has been acknowledged.
                return inflight.size + +(!!heldRequest || !!shadow?.cpuBarrier);
            },
            // What the GL shadow did (tests)
            shadow_stats() {
                return shadow ? shadow.stats : null;
            },
            reset() {
                heldRequest = null;
                shadow?.cancelCPU();
                releaseArena();
                lastFrameId = lastBytes = submitCount = 0;
                forgetInflight();
                // (not the shadow's contexts: this is also the driver's queue
                // reset after a timeout, and the owner is still there; the
                // renderer says when the machine was reset)
            },
            get_state() {
                if (heldRequest || shadow?.cpuBarrier)
                    throw new Error("GL snapshot requires completed CPU state dependencies");
                return [STATE_VERSION, arenaAddress, arenaBytes, lastFrameId, lastBytes, submitCount,
                    shadow ? JSON.stringify(shadow.getState()) : ""];
            },
            set_state(state) {
                // version 2 has no shadow state: the renderer sends its capabilities again
                if (!Array.isArray(state) || state[0] !== STATE_VERSION && state[0] !== 2)
                    throw new Error("Unsupported virtio-v86gl state in snapshot");
                heldRequest = null;
                const [, address, bytes, frameId, last, count, shadowState] = state;
                if (shadow) shadow.setState(shadowState ? JSON.parse(shadowState) : null);
                if (bytes && (bytes !== ARENA_BYTES || !dev.is_ram(address, bytes)))
                    throw new Error("Invalid virtio-v86gl arena in snapshot");
                releaseArena();
                arenaAddress = address;
                arenaBytes = bytes;
                lastFrameId = frameId;
                lastBytes = last;
                submitCount = count;
                forgetInflight();
            },
            // [magic, transport, arena address, arena bytes, frame id, bytes,
            //  submit count, 0, graphics checkpoint]
            upgrade_state(slot) {
                if (!Array.isArray(slot) || slot[0] !== LEGACY_STATE_MAGIC) return null;
                return [slot[1], [2, slot[2], slot[3], slot[4], slot[5], slot[6]], slot[8]];
            },
        };
    }

    const factories = global.V86VirtioDeviceFactories || (global.V86VirtioDeviceFactories = {});
    factories.v86gl = createV86GLDevice;
    if (typeof module !== "undefined" && module.exports)
        module.exports = { createV86GLDevice };
})(typeof globalThis !== "undefined" ? globalThis : this);
