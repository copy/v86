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
//   batch      { id, generation, ownerToken?, frameId, flags, commandCount, descAddr,
//                descLen, batchAddr, responseBase, submitCount, bytes }
//   released   { ownerToken }                 the process that mapped the arena
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
    const STATE_VERSION = 4;
    const ARENA_BYTES = 16 * 1024 * 1024;
    const RESPONSE_AREA_BYTES = 4 * 1024 * 1024;
    const HEADER_BYTES = 32;
    const REQUEST_BYTES = 24;
    const RESPONSE_BYTES = 16;
    const F_SHARED_ARENA = 0;
    const F_D3D_OWNER_ARENAS = 1;
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
        let nextGeneration = 0;
        const ownerArenas = new Map();
        const writeArenas = new Map();
        // A queue reset revokes physical mappings, but the process and its GPU
        // resources remain live until an explicit owner release.
        const logicalOwners = new Set();
        let lastFrameId = 0;
        let lastBytes = 0;
        let submitCount = 0;
        let hostAvailable = false;
        let initializing = false;
        let nextBatch = 0;
        let legacyBatch = 0;
        const inflight = new Map();
        let inflightBytes = 0;
        let processing = false;
        let processAgain = false;
        let heldRequest = null;

        if (shadow) shadow.writeResponse = (target, bytes, statusOffset) => {
            if (target.generation !== arenaGeneration || target.batchId !== legacyBatch || !arenaBytes) return;
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
            arenaGeneration = ++nextGeneration;
            arenaAddress = 0;
            arenaBytes = 0;
        }

        function releasePhysicalArenas() {
            releaseArena();
            ownerArenas.clear();
            writeArenas.clear();
        }

        function overlaps(address, bytes, exceptOwner) {
            if (exceptOwner !== 0 && arenaBytes && address < arenaAddress + arenaBytes && arenaAddress < address + bytes)
                return true;
            for (const [owner, arena] of ownerArenas)
                if (owner !== exceptOwner && address < arena.address + arena.bytes && arena.address < address + bytes) return true;
            return false;
        }

        function validArena(address, bytes) {
            return Number.isSafeInteger(address) && address > 0 && bytes === ARENA_BYTES && dev.is_ram(address, bytes);
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
                    const arena = writeArenas.get(message.generation) ||
                        (message.generation === arenaGeneration && arenaBytes ? { address: arenaAddress, bytes: arenaBytes } : null);
                    if (!arena) return;
                    // A timed-out GL inline response must not overwrite the
                    // next command stream, even when its page-side callback
                    // ran before that newer batch reached the page.
                    if (message.inlineId !== undefined && (message.generation !== arenaGeneration || message.inlineId !== legacyBatch)) return;
                    if (!Number.isInteger(offset) || offset < 0 || offset + bytes.length > arena.bytes)
                        throw new RangeError("v86gl write outside registered arena");
                    dev.write_memory(bytes, arena.address + offset);
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
                    releasePhysicalArenas();
                    logicalOwners.clear();
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
            const ownerToken = view.getUint32(20, true);
            if (ownerToken && !dev.is_feature_negotiated(F_D3D_OWNER_ARENAS)) return INVALID;
            if (op === REGISTER_ARENA) {
                // A 64-bit guest-physical address: RAM anywhere on the 36-bit bus.
                const address64 = address + high * 0x100000000;
                if (flags || !validArena(address64, length) || overlaps(address64, length, ownerToken)) return INVALID;
                if (ownerToken) {
                    const old = ownerArenas.get(ownerToken);
                    // The driver registers before each D3D submit, including
                    // after a queue reset. Repeating it must retain write leases.
                    if (old) return old.address === address64 && old.bytes === length ? OK : INVALID;
                    const arena = { address: address64, bytes: length, generation: ++nextGeneration };
                    ownerArenas.set(ownerToken, arena);
                    writeArenas.set(arena.generation, arena);
                } else {
                    if (arenaBytes) return INVALID;
                    arenaGeneration = ++nextGeneration;
                    arenaAddress = address64;
                    arenaBytes = length;
                }
                logicalOwners.add(ownerToken);
                return OK;
            }
            if (address || high) return INVALID;
            if (op === UNREGISTER_ARENA) {
                if (length || flags) return INVALID;
                if (logicalOwners.delete(ownerToken)) channel.post({ type: "released", ownerToken });
                if (ownerToken) {
                    const arena = ownerArenas.get(ownerToken);
                    if (arena) writeArenas.delete(arena.generation);
                    ownerArenas.delete(ownerToken);
                } else {
                    releaseArena();
                    if (shadow) shadow.reset();
                }
                return OK;
            }
            if (op !== SUBMIT || (flags & ~1)) return INVALID;
            const arena = ownerToken ? ownerArenas.get(ownerToken) :
                arenaBytes ? { address: arenaAddress, bytes: arenaBytes, generation: arenaGeneration } : null;
            if (!arena) return NO_ARENA;
            if (length < HEADER_BYTES || length > arena.bytes) return INVALID;

            // A view of guest RAM while the batch has one contiguous backing
            // (checked per submission: the physical map may have changed)
            const raw = dev.read_memory(arena.address, length);
            const header = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
            const commandBytes = header.getUint32(20, true);
            // VGL2 reserved words belong to the graphics protocol, not to the
            // virtqueue request. Shipping D3D8/D3D9/DDraw DLLs put D9WG_MAGIC in
            // reserved0; the old PCI transport ignored both words. Preserve that ABI.
            if (header.getUint32(0, true) !== MAGIC || header.getUint32(4, true) !== 1 ||
                    commandBytes !== length - HEADER_BYTES || (header.getUint32(8, true) & ~1))
                return INVALID;
            // Positive tokens are dedicated to the common DirectX runtime;
            // legacy OpenGL remains on owner zero with its synchronous shadow.
            if (ownerToken && (length < HEADER_BYTES + 8 || header.getUint32(16, true) !== 1 ||
                    header.getUint16(HEADER_BYTES, true) !== 0xffe1 || header.getUint16(HEADER_BYTES + 2, true) !== 0xffff ||
                    header.getUint32(HEADER_BYTES + 4, true) !== commandBytes - 8)) return INVALID;
            if (!hostAvailable) return NO_RENDERER;
            const id = ++nextBatch;
            if (!ownerToken) legacyBatch = id;
            const frameId = header.getUint32(12, true);

            // A GL batch's answers, written into the guest's memory before
            // it is copied (a D3D batch is one envelope record, 0xFFE1)
            let segments;
            if (!ownerToken && shadow && !(length >= HEADER_BYTES + 4 && (header.getUint16(HEADER_BYTES, true) & 0xFFF0) === 0xFFE0 &&
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
                generation: arena.generation,
                ...(ownerToken ? { ownerToken } : {}),
                frameId,
                flags: !ownerToken && shadow?.cpuBarrier ? 0 : header.getUint32(8, true) | flags,
                commandCount: header.getUint32(16, true),
                descAddr: arena.address,
                descLen: length,
                batchAddr: arena.address + HEADER_BYTES,
                responseBase: arena.bytes - RESPONSE_AREA_BYTES - HEADER_BYTES,
                submitCount: submitCount + 1,
                bytes,
                ...(segments ? { segments } : {}),
            }, remote ? [bytes.buffer] : undefined);
            lastFrameId = frameId;
            lastBytes = commandBytes;
            ++submitCount;
            // Availability may change reentrantly while a local host consumes
            // post(). This batch has already been accepted: reporting failure
            // now would invite the caller to execute it a second time.
            return OK;
        }

        return {
            name: "v86gl",
            // The slot keeps Windows' device instance, and so the installed driver
            pci_slot: 0x13,
            io_base: 0xF100,
            // Provisional, unallocated local ID. NOT the standard virtio-gpu ID.
            device_id: 0x107F,
            subsystem_device_id: 0x5686,
            features: [F_SHARED_ARENA, F_D3D_OWNER_ARENAS],
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
                releasePhysicalArenas();
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
                    shadow ? JSON.stringify(shadow.getState()) : "",
                    Array.from(ownerArenas, ([owner, arena]) => [owner, arena.address, arena.bytes]),
                    Array.from(logicalOwners)];
            },
            set_state(state) {
                // Versions 2/3 contain only the legacy arena.
                if (!Array.isArray(state) || ![2, 3, STATE_VERSION].includes(state[0]))
                    throw new Error("Unsupported virtio-v86gl state in snapshot");
                const [, address, bytes, frameId, last, count, shadowState] = state;
                const savedArenas = state[0] === STATE_VERSION ? state[7] : [];
                const savedOwners = state[0] === STATE_VERSION ? state[8] : bytes ? [0] : [];
                if (!Array.isArray(savedArenas) || !Array.isArray(savedOwners) ||
                        savedOwners.some(owner => !Number.isInteger(owner) || owner < 0 || owner > 0xffffffff) ||
                        new Set(savedOwners).size !== savedOwners.length)
                    throw new Error("Invalid virtio-v86gl owners in snapshot");
                const checked = new Map(), ranges = [];
                if (bytes) {
                    if (!validArena(address, bytes) || !savedOwners.includes(0))
                        throw new Error("Invalid virtio-v86gl arena in snapshot");
                    ranges.push([address, bytes]);
                }
                for (const entry of savedArenas) {
                    if (!Array.isArray(entry) || entry.length !== 3) throw new Error("Invalid virtio-v86gl owner arena");
                    const [owner, address, bytes] = entry;
                    if (!Number.isInteger(owner) || owner <= 0 || owner > 0xffffffff || checked.has(owner) ||
                            !savedOwners.includes(owner) || !validArena(address, bytes) ||
                            ranges.some(([start, size]) => address < start + size && start < address + bytes))
                        throw new Error("Invalid virtio-v86gl owner arena");
                    ranges.push([address, bytes]);checked.set(owner, { address, bytes });
                }
                if (shadow) shadow.setState(shadowState ? JSON.parse(shadowState) : null);
                heldRequest = null;
                releasePhysicalArenas();
                logicalOwners.clear();for (const owner of savedOwners) logicalOwners.add(owner);
                arenaAddress = bytes ? address : 0;
                arenaBytes = bytes;
                for (const [owner, arena] of checked) {
                    arena.generation = ++nextGeneration;
                    ownerArenas.set(owner, arena);writeArenas.set(arena.generation, arena);
                }
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
