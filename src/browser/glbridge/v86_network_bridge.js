// v86 PCI DMA graphics router.
//
// OpenGL records are executed directly by gl-webgpu/gl_executor.js. D3D9
// (which d3d8.dll and ddraw.dll also speak) keeps its tagged envelope on the
// same v86gl.sys transport, but there is deliberately no GL4ES/WebGL decoder
// or fallback in this file.

(function(global) {
    "use strict";

    const GraphicsJournal = global.V86GraphicsJournal ||
        (typeof require === "function" ? require("./graphics_journal.js").GraphicsJournal : null);
    const snapshotCodec = global.GLSnapshotCodec ||
        (typeof require === "function" ? require("./gl-webgpu/gl_snapshot_codec.js") : null);
    const rendererSnapshot = global.GLRendererSnapshot ||
        (typeof require === "function" ? require("./gl-webgpu/gl_renderer_snapshot.js") : null);
    const V86GL_BRIDGE_VERSION = "gl-webgpu-only-v1-20260824";
    // The retired D8WG renderer's envelope: a d3d8.dll from before D3D8 was
    // translated onto D9WG. Refused, with a message.
    const CTRL_D3D8_BATCH = 0xFFE0;
    const CTRL_D3D9_BATCH = 0xFFE1;
    // Not from the guest: v86gl_device.js saw the arena's owner release it,
    // so every session submitted since the previous release is over. A
    // record like a batch's so the journal replays it in order.
    const CTRL_OWNER_RELEASED = 0xFFE2;
    const EXTENDED_RECORD_SIZE = 0xFFFF;
    const CHECKPOINT_MAGIC = 0x32534756; // "VGS2"
    const CHECKPOINT_VERSION = 2;
    const JOURNAL_ENTRY_BYTES = 32;
    const CHECKPOINT_HEADER_BYTES = 32;
    const DEFAULT_JOURNAL_MEMORY_BYTES = 64 * 1024 * 1024;

    // Version 3 compresses/spools every accepted batch, including queries and Presents.
    // Readback writers are disabled during replay; object creation and query
    // begin/end still run, so guest handles and unfinished frames survive.

    function u16(bytes, offset) {
        return bytes[offset] | bytes[offset + 1] << 8;
    }

    function u32(bytes, offset) {
        return (bytes[offset] | bytes[offset + 1] << 8 |
            bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
    }

    function asBytes(value) {
        if (value instanceof Uint8Array) return value;
        if (ArrayBuffer.isView(value))
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        return new Uint8Array(value || []);
    }

    function ownedBytes(value) {
        return asBytes(value).slice();
    }

    function ownerReleasedRecord() {
        const bytes = new Uint8Array(8);
        bytes[0] = CTRL_OWNER_RELEASED & 0xff;
        bytes[1] = CTRL_OWNER_RELEASED >> 8;
        bytes[2] = bytes[3] = 0xff;
        return bytes;
    }

    class V86GLNetworkBridge {
        constructor(emulator, canvas, options) {
            this.emulator = emulator;
            this.options = options || {};
            // Each API draws into a window layer of the one screen canvas,
            // which the compositor (webgpu_compositor.js) shows over the guest
            // desktop where the guest has its window
            this.compositor = this.options.compositor;
            if (!this.compositor)
                throw new Error("the graphics bridge needs a compositor (webgpu_compositor.js)");
            const layer = name => this.compositor.createLayer(name).canvas;
            this.glCanvas = this.options.glCanvas || layer("gl");
            this.d3d9Canvas = this.options.d3d9Canvas || layer("d3d9");
            this.screenCanvas = this.options.screenCanvas || this.compositor.canvas || null;
            this.destroyed = false;
            this.memoryGeneration = 0;

            this.glExecutor = null;
            this.d3d9Executor = null;
            this.glSurface = this.emptySurface();
            this.d3d9Surface = this.emptySurface();
            this.activeOwner = null;
            this.d3d9OwnerSessionKey = null;
            this.d3d9SwapChainCanvases = new Map();
            this.d3d9SwapChainSurfaces = new Map();

            this.journalBudget = this.options.graphicsJournalMemoryBytes ??
                this.options.maxGraphicsJournalBytes ?? this.options.maxGLJournalBytes ?? DEFAULT_JOURNAL_MEMORY_BYTES;
            this.graphicsJournal = new GraphicsJournal({ budget: this.journalBudget });
            this.preparedCheckpoint = null;
            this.graphicsJournalBytes = 0;
            this.legacyCheckpoint = new Uint8Array(0);
            this.glJournal = [];
            this.glJournalBytes = 0;
            this.glJournalOverflow = false;
            this.replayingState = false;
            this.restoringState = false;
            this.restorePrepared = false;
            this.restoreSeen = false;
            this.restoreHadCheckpoint = false;
            this.pendingRestore = Promise.resolve();
            this.pendingBatches = [];

            // Batches arrive through graphics_proxy.js
            this.installGLExecutor();
            this.installD3D9Executor();
        }

        /* The host an executor draws through when its canvas is a compositor layer */
        layerHost(canvas) {
            return canvas && canvas.layer ? canvas.layer.host : null;
        }

        emptySurface() {
            return { hwnd: 0, x: 0, y: 0, width: 0, height: 0,
                     displayWidth: 0, displayHeight: 0, visible: false };
        }

        installGLExecutor() {
            if (this.options.glExecutor) {
                // (one made elsewhere still answers into guest memory through this bridge)
                this.glExecutor = this.options.glExecutor;
                if (this.glExecutor.options && !this.glExecutor.options.writeGuestMemory)
                    this.glExecutor.options.writeGuestMemory = (offset, data, metadata, inline) =>
                        this.writeGLGuestMemory(offset, data, metadata, inline);
                return;
            }
            const install = this.options.installGLWebGPUExecutor ||
                global.installGLWebGPUExecutor;
            if (!this.glCanvas || typeof install !== "function") {
                console.error("[gl-webgpu] executor unavailable; load " +
                    "gl_executor.js and provide the shared graphics canvas");
                return;
            }
            const executorOptions = { ...(this.options.gl || {}) };
            if (!executorOptions.host && this.layerHost(this.glCanvas))
                executorOptions.host = this.layerHost(this.glCanvas);
            const userSurface = executorOptions.onSurface;
            executorOptions.onSurface = (surface, reason) => {
                this.glSurface = { ...this.glSurface, ...surface };
                if (reason === "hide" || surface.visible === false) {
                    if (this.activeOwner === "gl") this.hideLayers();
                } else if (reason === "window-state") {
                    // Where the window is and what of it shows: it does not
                    // make OpenGL the one on screen, SwapBuffers does
                    if (this.activeOwner === "gl") this.placeOwner("gl", true);
                } else {
                    this.showOwner("gl");
                }
                if (typeof userSurface === "function") userSurface(surface, reason);
            };
            executorOptions.writeGuestMemory = (offsetInBatch, data, metadata, inline) =>
                this.writeGLGuestMemory(offsetInBatch, data, metadata, inline);
            this.glExecutor = install(this.glCanvas, executorOptions);
        }

        // An answer the GL executor writes into the batch's record in guest memory
        writeGLGuestMemory(offsetInBatch, data, metadata, inline = true) {
            if (this.destroyed || this.suspended || this.restoringState || this.replayingState) return;
            if (metadata && metadata.graphicsGeneration !== undefined &&
                metadata.graphicsGeneration !== this.memoryGeneration) return;
            if (!metadata || metadata.batchAddress === undefined) return;
            if (typeof metadata.writeGuestMemory === "function")
                return metadata.writeGuestMemory(32 + offsetInBatch, asBytes(data), inline);
            if (!this.emulator ||
                    typeof this.emulator.write_memory !== "function") return;
            this.emulator.write_memory(asBytes(data),
                (metadata.batchAddress + offsetInBatch) >>> 0);
        }

        installD3D9Executor() {
            if (this.options.d3d9Executor) {
                this.d3d9Executor = this.options.d3d9Executor;
                return;
            }
            const install = this.options.installD3D9WebGPUExecutor ||
                global.installD3D9WebGPUExecutor;
            if (!this.d3d9Canvas || typeof install !== "function") return;
            const opts = { ...(this.options.d3d9 || {}) };
            if (!opts.host && this.layerHost(this.d3d9Canvas))
                opts.host = this.layerHost(this.d3d9Canvas);
            const userSurface = opts.onSurface;
            const userPresent = opts.onPresent;
            const userDestroy = opts.onDestroy;
            opts.onSurface = (surface, reason) => {
                const session = surface.sessionKey || null;
                if (reason === "hide" || surface.visible === false) {
                    if (!session || session === this.d3d9OwnerSessionKey) {
                        this.d3d9Surface = { ...this.d3d9Surface, ...surface };
                        if (this.activeOwner === "d3d9")
                            this.hideLayers();
                        else
                            this.placeLayer(this.d3d9Canvas,
                                0, 0, 0, 0, false);
                    }
                } else {
                    /* A CREATE/RESET only declares where a process would
                     * present; it does not make that process the visible
                     * owner. Capability helpers interleave their batches with
                     * games and dxdiag, so stealing ownership here made the
                     * live canvas disappear until the helper's (often absent)
                     * Present. Ownership changes only after a successful
                     * onPresent below. */
                    const hasOwner = this.d3d9OwnerSessionKey !== null;
                    const belongsToOwner = hasOwner &&
                        session === this.d3d9OwnerSessionKey;
                    const legacyOwner = !hasOwner && !session &&
                        this.activeOwner === "d3d9";
                    if (!hasOwner || belongsToOwner) {
                        this.d3d9Surface = { ...this.d3d9Surface, ...surface };
                        // Only a successful Present may put the shared canvas
                        // on screen.  In particular, DirectDraw sends a
                        // display-mode report while tearing down 3DMark 2000;
                        // treating that geometry report as visibility showed
                        // the retained (black) canvas after the primary had
                        // already told us to hide it.
                        this.placeOwner("d3d9",
                            this.activeOwner === "d3d9" &&
                            (belongsToOwner || legacyOwner));
                    }
                }
                if (typeof userSurface === "function") userSurface(surface, reason);
            };
            opts.onPresent = (surface, stats) => {
                this.d3d9OwnerSessionKey = surface.sessionKey || null;
                this.d3d9Surface = { ...this.d3d9Surface, ...surface };
                if (surface.visible === false) this.hideLayers();
                else this.showOwner("d3d9");
                if (typeof userPresent === "function") userPresent(surface, stats);
            };
            opts.onDestroy = (surface, reason) => {
                const session = surface.sessionKey || null;
                // The session check stops a helper process -- dxdiag, a
                // capability probe -- from tearing down a running game's
                // canvas, and that has to keep working.
                //
                // What it cannot answer is the orphaned case: the canvas is
                // still showing frames while no session claims it any more,
                // which is where an earlier destroy in the same session has
                // already cleared the owner. Nothing can take it down after
                // that, so an exiting process leaves a picture of itself over
                // the guest's desktop with nothing left running to remove it.
                // A session ending is a safe moment to reclaim that: there is
                // no owner left to protect.
                const orphaned = this.d3d9OwnerSessionKey === null &&
                    this.activeOwner === "d3d9";
                if (!session || session === this.d3d9OwnerSessionKey ||
                        (reason === "session-end" && orphaned)) {
                    this.d3d9OwnerSessionKey = null;
                    this.d3d9Surface = { ...this.d3d9Surface, ...surface,
                        visible: false };
                    if (this.activeOwner === "d3d9")
                        this.hideLayers();
                    else
                        this.placeLayer(this.d3d9Canvas,
                            0, 0, 0, 0, false);
                }
                if (typeof userDestroy === "function") userDestroy(surface, reason);
            };
            const userCreateSwapChainCanvas = opts.createSwapChainCanvas;
            opts.createSwapChainCanvas = surface => {
                if (this.destroyed || this.suspended) return null;
                if (typeof userCreateSwapChainCanvas === "function")
                    return userCreateSwapChainCanvas(surface);
                const layer = this.compositor.createLayer("d3d9 swap chain " + surface.swapChain);
                layer.canvas.width = Math.max(1, surface.width || 1);
                layer.canvas.height = Math.max(1, surface.height || 1);
                this.d3d9SwapChainCanvases.set(surface.swapChain, layer.canvas);
                return layer.canvas;
            };
            const userSwapChainSurface = opts.onSwapChainSurface;
            opts.onSwapChainSurface = (surface, reason) => {
                if (reason === "destroy") this.removeD3D9SwapChain(surface.swapChain);
                else this.placeD3D9SwapChain(surface);
                if (typeof userSwapChainSurface === "function")
                    userSwapChainSurface(surface, reason);
            };
            this.d3d9Executor = install(this.d3d9Canvas, opts);
        }

        pushPCIBatch(event) {
            if (this.destroyed || this.failed) return;
            event.handled = true;
            const bytes = asBytes(event && event.bytes);
            if (this.isEnvelope(bytes, CTRL_D3D8_BATCH)) {
                if (!this.d8wgReported) console.error("[v86gl] a D8WG batch from a d3d8.dll that predates the " +
                    "D3D9 translation layer; this host no longer renders D8WG, replace the guest's d3d8.dll");
                this.d8wgReported = true;
                return;
            }
            if (this.restoringState) {
                this.pendingBatches.push({ ...event, bytes: bytes.slice() });
                return;
            }
            if (!this.replayingState) this.recordGraphicsBatch(event, bytes);
            return this.executePCIBatch(event, bytes);
        }

        executePCIBatch(event, bytes) {
            if (this.isEnvelope(bytes, CTRL_OWNER_RELEASED)) {
                for (const executor of [this.glExecutor, this.d3d9Executor])
                    if (executor) executor.endOwnerSessions();
                return;
            }
            if (this.isEnvelope(bytes, CTRL_D3D9_BATCH))
                return this.pushD3D9PCIBatch(event, bytes);
            this.pushGLPCIBatch(event, bytes);
        }

        isEnvelope(bytes, opcode) {
            return bytes.byteLength >= 8 && u16(bytes, 0) === opcode &&
                u16(bytes, 2) === EXTENDED_RECORD_SIZE;
        }

        pushGLPCIBatch(event, bytes) {
            if (!this.glExecutor || typeof this.glExecutor.submit !== "function") {
                console.error("[gl-webgpu] executor unavailable");
                return;
            }
            this.glExecutor.submit(bytes, {
                ...(event.replay ? { replay: true } : {}),
                pciFrameId: event.frameId >>> 0,
                submitCount: event.submitCount >>> 0,
                descriptorCommandCount: event.commandCount >>> 0,
                batchAddress: event.batchAddr === undefined ? undefined :
                    event.batchAddr >>> 0,
                responseBase: event.responseBase,
                writeGuestMemory: event.writeGuestMemory,
                onVertexCapture: event.onVertexCapture,
                onProgramLink: event.onProgramLink,
                isMemoryValid: event.isMemoryValid,
                isInlineMemoryValid: event.isInlineMemoryValid,
                graphicsGeneration: this.memoryGeneration,
            });
            if (event.flags & 1) {
                this.glExecutor.onSwapBuffers();
                this.showOwner("gl");
            }
        }

        pushD3D9PCIBatch(event, bytes) {
            if (!this.d3d9Executor ||
                    typeof this.d3d9Executor.submit !== "function") {
                console.error("[d3d9-webgpu] executor unavailable");
                return;
            }
            const payloadBytes = u32(bytes, 4);
            if (payloadBytes !== bytes.byteLength - 8) {
                console.error("[d3d9-webgpu] malformed D9WG envelope");
                return;
            }
            const descriptorBase = event.descAddr >>> 0;
            const generation = this.memoryGeneration;
            const writeGuestMemory = (dmaOffset, data) => {
                if (this.destroyed || this.suspended || this.restoringState ||
                    generation !== this.memoryGeneration) return;
                const source = asBytes(data);
                if (typeof event.writeGuestMemory === "function")
                    return event.writeGuestMemory(dmaOffset, source);
                const offset = dmaOffset >>> 0;
                const end = offset + source.byteLength;
                if (end < offset || end > 16 * 1024 * 1024)
                    throw new RangeError("D9WG response write is outside DMA memory");
                if (!this.emulator ||
                        typeof this.emulator.write_memory !== "function")
                    throw new Error("v86 physical-memory writer is unavailable");
                this.emulator.write_memory(source,
                    (descriptorBase + offset) >>> 0);
            };
            return this.d3d9Executor.submit(bytes.subarray(8), {
                ...(event.replay ? { replay: true } : {}),
                pciFrameId: event.frameId >>> 0,
                submitCount: event.submitCount >>> 0,
                descriptorCommandCount: event.commandCount >>> 0,
                descriptorBase,
                writeGuestMemory,
            });
        }

        recordGraphicsBatch(event, bytes) {
            this.preparedCheckpoint = null;
            if (this.glExecutor?.saveSnapshot && !event.barrier && !this.isEnvelope(bytes, CTRL_D3D9_BATCH) &&
                !this.isEnvelope(bytes, CTRL_OWNER_RELEASED)) return;
            this.graphicsJournal.append(event, bytes);
            this.graphicsJournalBytes += JOURNAL_ENTRY_BYTES + bytes.byteLength;
            if (!event.barrier && !this.isEnvelope(bytes, CTRL_D3D9_BATCH))
                this.glJournalBytes += bytes.byteLength;
        }

        async resetJournal() {
            await this.graphicsJournal.destroy();
            this.graphicsJournal = new GraphicsJournal({ budget: this.journalBudget });
            this.graphicsJournalBytes = 0;
            this.preparedCheckpoint = null;
        }

        serializeCheckpoint() {
            if (this.restoringState || this.replayingState)
                throw new Error("graphics state is being restored");
            if (!this.preparedCheckpoint)
                throw new Error("Graphics checkpoint is not prepared; await emulator.save_state()");
            return this.preparedCheckpoint;
        }

        releaseCheckpoint() { this.preparedCheckpoint = null; }

        parseCheckpoint(checkpoint) {
            const bytes = asBytes(checkpoint);
            if (bytes.length >= 4 && u32(bytes, 0) === 0x31534C47) {
                try {
                    const resources = snapshotCodec.decode(bytes);
                    if (resources.version !== 4 || !(resources.history instanceof Uint8Array) || !(resources.renderer instanceof Uint8Array))
                        throw new Error("invalid resource checkpoint");
                    rendererSnapshot.inspect(resources.renderer);
                    return { ...this.parseCheckpoint(resources.history), resourceState: resources };
                } catch (error) { throw new Error("invalid graphics resource checkpoint: " + error.message); }
            }
            if (bytes.byteLength < CHECKPOINT_HEADER_BYTES)
                throw new Error("graphics checkpoint is truncated");
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const version = view.getUint16(4, true);
            if (version === 3) {
                const parsed = GraphicsJournal.parse(bytes);
                if (parsed.legacy.length && (parsed.legacy.length < CHECKPOINT_HEADER_BYTES ||
                        new DataView(parsed.legacy.buffer).getUint16(4, true) !== 1))
                    throw new Error("graphics checkpoint legacy data must be version 1");
                if (parsed.legacy.length) this.parseCheckpoint(parsed.legacy);
                return parsed;
            }
            if (view.getUint32(0, true) !== CHECKPOINT_MAGIC ||
                    (version !== 1 && version !== CHECKPOINT_VERSION))
                throw new Error("graphics checkpoint version is unsupported");
            const header = view.getUint16(6, true);
            const total = view.getUint32(8, true);
            if (header !== CHECKPOINT_HEADER_BYTES || total !== bytes.byteLength)
                throw new Error("graphics checkpoint lengths are invalid");
            if (version === 1) {
                const glBytes = view.getUint32(12, true);
                const d3d8Bytes = view.getUint32(16, true);
                if (header + glBytes + d3d8Bytes !== total)
                    throw new Error("graphics checkpoint lengths are invalid");
                if (d3d8Bytes)
                    throw new Error("graphics checkpoint holds state of the retired D8WG (D3D8) renderer");
                return { version, gl: bytes.slice(header, header + glBytes), records: [] };
            }
            const legacyBytes = view.getUint32(12, true);
            if (legacyBytes > total - header)
                throw new Error("graphics checkpoint legacy data is truncated");
            const legacy = bytes.slice(header, header + legacyBytes);
            if (legacyBytes && (legacyBytes < CHECKPOINT_HEADER_BYTES ||
                    new DataView(legacy.buffer).getUint16(4, true) !== 1))
                throw new Error("graphics checkpoint legacy data must be version 1");
            if (legacyBytes) this.parseCheckpoint(legacy);
            const count = view.getUint32(16, true);
            const records = [];
            let offset = header + legacyBytes;
            for (let i = 0; i < count; ++i) {
                if (offset + JOURNAL_ENTRY_BYTES > total)
                    throw new Error("graphics checkpoint batch header is truncated");
                const size = view.getUint32(offset, true);
                const kind = view.getUint32(offset + 24, true);
                if (size > total - offset - JOURNAL_ENTRY_BYTES || kind > 1 ||
                        (kind === 1 && size) || view.getUint32(offset + 28, true))
                    throw new Error("graphics checkpoint batch is invalid");
                records.push({ flags: view.getUint32(offset + 4, true),
                    frameId: view.getUint32(offset + 8, true),
                    submitCount: view.getUint32(offset + 12, true),
                    commandCount: view.getUint32(offset + 16, true),
                    responseBase: view.getUint32(offset + 20, true), barrier: kind === 1,
                    bytes: bytes.slice(offset + JOURNAL_ENTRY_BYTES,
                        offset + JOURNAL_ENTRY_BYTES + size) });
                offset += JOURNAL_ENTRY_BYTES + size;
            }
            if (offset !== total) throw new Error("graphics checkpoint has trailing data");
            return { version, legacy, records };
        }

        async waitForIdle(flush, allowFailure = false) {
            const executors = [this.glExecutor, this.d3d9Executor].filter(Boolean);
            for (const executor of executors) {
                try {
                    if (executor.readyPromise) await executor.readyPromise;
                    if (executor.idle) await executor.idle();
                    else if (executor.work) await executor.work;
                } catch (error) {
                    if (!allowFailure) throw error;
                }
            }
            if (flush) {
                if (this.glExecutor && this.glExecutor.flushFrame) this.glExecutor.flushFrame();
                if (this.d3d9Executor && this.d3d9Executor.flushForCheckpoint)
                    this.d3d9Executor.flushForCheckpoint();
            }
            for (const executor of executors) {
                try {
                    if (executor.checkpointIdle) await executor.checkpointIdle();
                    else if (executor.idle) await executor.idle();
                    const queue = executor.device && executor.device.queue;
                    if (queue && queue.onSubmittedWorkDone) await queue.onSubmittedWorkDone();
                } catch (error) {
                    if (!allowFailure) throw error;
                }
            }
        }

        async waitForSubmittedBatches() {
            // Drain JS continuations/readbacks without inserting a GPU fence for
            // every transport batch. Checkpoint barriers still fence the GPU.
            for (const executor of [this.glExecutor, this.d3d9Executor]) {
                if (!executor) continue;
                if (executor.checkpointIdle) await executor.checkpointIdle();
                else if (executor.idle) await executor.idle();
                else if (executor.work) await executor.work;
            }
        }

        // The checkpoint travels in the snapshot as the device's host state
        // (graphics_proxy.js prepare_save/after_restore)
        async prepareSaveState() {
            await this.waitForIdle(true);
            // Flushes can split an unfinished frame/query. Replay that boundary
            // too, including when this checkpoint later becomes a parent save.
            this.recordGraphicsBatch({ barrier: true }, new Uint8Array(0));
            if (this.glExecutor?.saveSnapshot) {
                const renderer = await this.glExecutor.saveSnapshot();
                // Version-one legacy checkpoints contain only GL history.
                // Live resources now replace that ancestry as well.
                this.legacyCheckpoint = new Uint8Array(0);
                const history = await this.graphicsJournal.snapshot(this.legacyCheckpoint);
                this.preparedCheckpoint = snapshotCodec.encode({ version: 4, renderer, history,
                    activeOwner: this.activeOwner, glSurface: this.glSurface, d3d9Surface: this.d3d9Surface,
                    d3d9OwnerSessionKey: this.d3d9OwnerSessionKey });
            } else this.preparedCheckpoint = await this.graphicsJournal.snapshot(this.legacyCheckpoint);
            return { entries: this.graphicsJournal.count, bytes: this.preparedCheckpoint.byteLength };
        }

        beginStateRestore() {
            this.restorePrepared = true;
            this.restoreSeen = false;
            this.restoreHadCheckpoint = false;
            this.restoringState = true;
            this.pendingRestore = Promise.resolve();
            this.placeLayers();
        }

        onPCIStateRestored(checkpoint) {
            ++this.memoryGeneration;
            this.restoreSeen = true;
            this.restoreHadCheckpoint = !!(checkpoint && checkpoint.byteLength);
            this.restoringState = true;
            this.pendingRestore = Promise.resolve().then(() =>
                this.restoreCheckpoint(checkpoint));
            this.pendingRestore.catch(error =>
                console.error("[v86gl] graphics state restore failed", error));
        }

        async restoreCheckpoint(checkpoint) {
            // Validate before discarding live resources. Version 1 can restore
            // only the GL data that old writers saved; their D3D8 data belonged
            // to the retired D8WG renderer and is refused.
            const parsed = checkpoint && checkpoint.byteLength ? this.parseCheckpoint(checkpoint) :
                { version: 2, legacy: new Uint8Array(0), records: [] };
            await this.waitForIdle(false, true);
            this.replayingState = true;
            this.placeLayers();
            let complete = false;
            try {
                if (this.resetForStateRestore) await this.resetForStateRestore();
                else {
                    if (this.glExecutor) this.glExecutor.resetForReplay();
                    if (this.d3d9Executor && this.d3d9Executor.resetForReplay)
                        await this.d3d9Executor.resetForReplay();
                }
                await this.resetJournal();
                this.glJournal = [];
                this.glJournalBytes = 0;
                this.glJournalOverflow = false;
                this.legacyCheckpoint = parsed.version === 1 ? ownedBytes(checkpoint) : parsed.legacy;
                const legacy = parsed.version === 1 ? parsed :
                    (parsed.legacy.byteLength ? this.parseCheckpoint(parsed.legacy) : null);
                if (legacy) {
                    if (legacy.gl.byteLength) {
                        this.glExecutor.submit(legacy.gl.slice(), { replay: true });
                        this.glExecutor.onSwapBuffers();
                        this.glJournalBytes = legacy.gl.byteLength;
                    }
                }
                const records = parsed.version === 3 ? GraphicsJournal.records(parsed) : parsed.records;
                for await (const record of records) {
                    if (record.barrier) await this.waitForIdle(true);
                    else {
                        // Each replay owns its response buffer. Never let query
                        // responses mutate the journal or restored guest RAM.
                        const event = { ...record, replay: true, batchAddr: 0, descAddr: 0,
                            writeGuestMemory() {}, isMemoryValid: () => true };
                        await this.executePCIBatch(event, record.bytes.slice());
                    }
                    this.recordGraphicsBatch(record, record.bytes);
                    // Do not accumulate an entire decompressed history during
                    // restore. Compression and disk writes keep pace with replay.
                    await this.graphicsJournal.work;
                }
                if (parsed.resourceState) {
                    const saved = parsed.resourceState;
                    await this.glExecutor.restoreSnapshot(saved.renderer);
                    this.glExecutor.presentToCanvas(); this.glExecutor.flushFrame();
                    this.activeOwner = saved.activeOwner;
                    this.glSurface = saved.glSurface; this.d3d9Surface = saved.d3d9Surface;
                    this.d3d9OwnerSessionKey = saved.d3d9OwnerSessionKey;
                }
                await this.waitForIdle(false);
                complete = true;
            } finally {
                this.replayingState = false;
                this.restoringState = false;
                if (complete) {
                    this.placeLayers();
                    this.drainPendingBatches();
                } else {
                    this.hideLayers(true);
                    this.pendingBatches = [];
                }
            }
        }

        async finishStateRestore() {
            if (!this.restoreSeen) this.onPCIStateRestored(null);
            await this.pendingRestore;
            this.restorePrepared = false;
            return { hasGLState: this.restoreHadCheckpoint };
        }

        cancelStateRestore() {
            this.restorePrepared = false;
            this.restoreSeen = false;
            this.restoreHadCheckpoint = false;
            this.replayingState = false;
            this.restoringState = false;
            this.pendingRestore = Promise.resolve();
            this.drainPendingBatches();
        }

        drainPendingBatches() {
            const pending = this.pendingBatches.splice(0);
            for (const event of pending) this.pushPCIBatch(event);
        }

        ownerCanvas(owner) {
            if (owner === "d3d9") return this.d3d9Canvas;
            return this.glCanvas;
        }

        ownerSurface(owner) {
            if (owner === "d3d9") return this.d3d9Surface;
            return this.glSurface;
        }

        /* Put a window layer where the guest has its window, in guest desktop
         * pixels, which are the screen canvas's pixels. Nothing shows while
         * state is being restored or the guest shows text. */
        placeLayer(canvas, left, top, width, height, visible) {
            if (!canvas || !canvas.layer) return;
            if (this.destroyed || this.suspended || this.restoringState || this.replayingState ||
                    this.options.isGraphical && !this.options.isGraphical())
                visible = false;
            canvas.layer.place(left, top, width, height, visible);
            canvas.layer.setClip(null);
            canvas.layer.setVisibleRegion(null);
        }

        ownerRect(owner) {
            const canvas = this.ownerCanvas(owner);
            const surface = this.ownerSurface(owner);
            // DDSCL_NORMAL exposes the desktop primary. Its Present HWND is
            // merely the application asking for scanout; using that HWND's
            // client rectangle to place the layer shrinks the entire desktop
            // texture into a splash window and makes its logo fill the window.
            // Keep the layer coincident with the v86 desktop and let clipRect
            // reveal only the primary pixels this application actually wrote.
            const desktopPrimary = !!surface.ddDesktopPrimary;
            return {
                left: desktopPrimary ? 0 : (surface.x || 0),
                top: desktopPrimary ? 0 : (surface.y || 0),
                width: surface.displayWidth || surface.width || canvas.width || 1,
                height: surface.displayHeight || surface.height || canvas.height || 1,
            };
        }

        /* The parts of the layer other guest windows leave showing
         * (surface.visibleRegion, from the guest's window-state reports), as
         * fractions of the layer placed at `rect`; null for all of it */
        layerRegion(surface, rect) {
            const region = surface && surface.visibleRegion;
            if (!region || !region.baseWidth || !region.baseHeight || !rect.width || !rect.height)
                return null;
            // The layer is the window's client area, perhaps scaled -- or, for
            // a DirectDraw desktop primary, the whole desktop
            const x = surface.ddDesktopPrimary ?
                v => (region.originX + v - rect.left) / rect.width : v => v / region.baseWidth;
            const y = surface.ddDesktopPrimary ?
                v => (region.originY + v - rect.top) / rect.height : v => v / region.baseHeight;
            return region.rects.map(r => ({ left: x(r.left), top: y(r.top), right: x(r.right), bottom: y(r.bottom) }));
        }

        placeOwner(owner, visible, targetCanvas) {
            const canvas = targetCanvas || this.ownerCanvas(owner);
            if (!canvas) return;
            const surface = this.ownerSurface(owner);
            const rect = this.ownerRect(owner);
            // Covered by other guest windows: shown again when the guest says
            // it is uncovered, whatever is presented meanwhile
            this.placeLayer(canvas, rect.left, rect.top, rect.width, rect.height,
                (visible === undefined ? this.activeOwner === owner : visible) &&
                !(surface && surface.occluded));
            let clip = surface && surface.clipRect;
            // Clip windowed rendering to the guest desktop, preserving any
            // DirectDraw primary clip region as well.
            if (this.screenCanvas && this.screenCanvas.width && this.screenCanvas.height) {
                const w = rect.width, h = rect.height, x = rect.left, y = rect.top;
                const source = clip && clip.baseWidth > 0 && clip.baseHeight > 0 ? clip :
                    { left: 0, top: 0, right: w, bottom: h, baseWidth: w, baseHeight: h };
                clip = {
                    baseWidth: w, baseHeight: h,
                    left: Math.min(w, Math.max(0, -x, source.left / source.baseWidth * w)),
                    top: Math.min(h, Math.max(0, -y, source.top / source.baseHeight * h)),
                    right: Math.max(0, Math.min(w, this.screenCanvas.width - x, source.right / source.baseWidth * w)),
                    bottom: Math.max(0, Math.min(h, this.screenCanvas.height - y, source.bottom / source.baseHeight * h)),
                };
            }
            if (clip && clip.baseWidth > 0 && clip.baseHeight > 0) {
                canvas.layer.setClip({
                    left: Math.max(0, clip.left) / clip.baseWidth,
                    top: Math.max(0, clip.top) / clip.baseHeight,
                    right: Math.min(clip.baseWidth, clip.right) / clip.baseWidth,
                    bottom: Math.min(clip.baseHeight, clip.bottom) / clip.baseHeight,
                });
            }
            canvas.layer.setVisibleRegion(this.layerRegion(surface, rect));
        }

        showOwner(owner) {
            if (this.destroyed || this.suspended) return;
            this.activeOwner = owner;
            const active = this.ownerCanvas(owner);
            for (const canvas of [this.glCanvas, this.d3d9Canvas]) {
                if (canvas && canvas !== active)
                    this.placeLayer(canvas, 0, 0, 0, 0, false);
            }
            this.placeOwner(owner, true);
        }

        placeLayers() {
            if (this.activeOwner) this.placeOwner(this.activeOwner, true);
            for (const surface of this.d3d9SwapChainSurfaces.values())
                this.placeD3D9SwapChain(surface);
        }

        hideLayers(includeSwapChains) {
            for (const canvas of [this.glCanvas, this.d3d9Canvas])
                if (canvas) this.placeLayer(canvas, 0, 0, 0, 0, false);
            this.activeOwner = null;
            if (includeSwapChains) {
                for (const canvas of this.d3d9SwapChainCanvases.values())
                    this.placeLayer(canvas, 0, 0, 0, 0, false);
            }
        }

        placeD3D9SwapChain(surface) {
            this.d3d9SwapChainSurfaces.set(surface.swapChain, surface);
            const canvas = this.d3d9SwapChainCanvases.get(surface.swapChain);
            if (!canvas) return;
            // Placed by its own surface alone: the primary window's size,
            // clip and desktop-primary flag are not this window's
            const saved = this.d3d9Surface;
            this.d3d9Surface = { ...this.emptySurface(), ...surface };
            this.placeOwner("d3d9", surface.visible !== false, canvas);
            this.d3d9Surface = saved;
        }

        removeD3D9SwapChain(handle) {
            const canvas = this.d3d9SwapChainCanvases.get(handle);
            if (!canvas) return;
            this.d3d9SwapChainCanvases.delete(handle);
            this.d3d9SwapChainSurfaces.delete(handle);
            canvas.layer.destroy();
        }
    }
    global.V86GL_BRIDGE_VERSION = V86GL_BRIDGE_VERSION;
    global.V86GLNetworkBridge = { ownerReleasedRecord };
    global.installV86GLNetworkBridge = function(emulator, canvas, options) {
        return new V86GLNetworkBridge(emulator, canvas, options);
    };
})(typeof window !== "undefined" ? window : globalThis);
