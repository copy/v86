// VX: the renderer of virtio-gpu's Venus contexts (Vulkan; docs/gpu-devices.md,
// "Venus (Vulkan)"), on WebGPU. The device
// (src/graphics_adapters/virtio_gpu/venus_vk*.js) keeps the guest's Vulkan
// objects and sends VX batches: the GPU objects to make, the bytes the guest
// wrote into mapped memory, each submission's commands (BEGIN .. END: one
// command encoder), and readbacks of memory, answered through the response
// region as GX answers its own.
//
// - A VkDeviceMemory is a GPUBuffer; buffers are ranges of it, named in
//   each command by (memory, offset). A VkImage is a GPUTexture (cubes are
//   2D arrays), its views GPUTextureViews.
// - WebGPU copies between buffers and textures only with rows of a multiple
//   of 256 bytes: other pitches go through a staging buffer, row by row.
// - Clears, blits and resolves are render passes.
(function(global) {
    "use strict";

    const VX_MAGIC = 0x30315856;
    const VX = {
        MEMORY_CREATE: 1, DESTROY: 2, MEMORY_WRITE: 3, MEMORY_READ: 4, TEXTURE_CREATE: 5, VIEW_CREATE: 6, SAMPLER_CREATE: 7,
        BEGIN: 8, END: 9, COPY_BUFFER: 10, FILL_BUFFER: 11, UPDATE_BUFFER: 12, COPY_BUFFER_IMAGE: 13, COPY_IMAGE: 14,
        BLIT_IMAGE: 15, CLEAR_IMAGE: 16, RESOLVE_IMAGE: 17,
        SHADER_CREATE: 18, PIPELINE_CREATE: 19, BEGIN_PASS: 20, END_PASS: 21, BIND_PIPELINE: 22, SET_BIND_GROUP: 23,
        SET_VERTEX_BUFFER: 24, SET_INDEX_BUFFER: 25, SET_PUSH_CONSTANTS: 26, SET_VIEWPORT: 27, SET_SCISSOR: 28,
        SET_BLEND_CONSTANTS: 29, SET_STENCIL_REFERENCE: 30, DRAW: 31, DRAW_INDEXED: 32, DRAW_INDIRECT: 33,
        DISPATCH: 34, DISPATCH_INDIRECT: 35, CLEAR_ATTACHMENTS: 36,
        QUERY_POOL_CREATE: 37, BEGIN_QUERY: 38, END_QUERY: 39, COPY_QUERY_RESULTS: 40, TEXTURE_READ: 41, TEXTURE_WRITE: 42,
        TEXTURE_IMPORT: 43, XFB_BIND: 44, XFB_BEGIN: 45, XFB_END: 46, SET_STENCIL_COMPARE_MASK: 47, SET_STENCIL_WRITE_MASK: 48,
    };
    // VK_QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM_EXT; VkPrimitiveTopology's vertices a primitive (lists only)
    const QUERY_XFB = 1000028004;
    const LIST_VERTICES = { 0: 1, 1: 2, 3: 3 };
    // where the bundle is: naga's wasm is beside it
    const SCRIPT = typeof document !== "undefined" && document.currentScript ? document.currentScript.src : null;
    // Vulkan's enums, as WebGPU's
    const TOPOLOGY = ["point-list", "line-list", "line-strip", "triangle-list", "triangle-strip", null];
    const BLEND_FACTOR = ["zero", "one", "src", "one-minus-src", "dst", "one-minus-dst", "src-alpha", "one-minus-src-alpha",
        "dst-alpha", "one-minus-dst-alpha", "constant", "one-minus-constant", "constant", "one-minus-constant",
        "src-alpha-saturated", "src1", "one-minus-src1", "src1-alpha", "one-minus-src1-alpha"];
    const BLEND_OP = ["add", "subtract", "reverse-subtract", "min", "max"];
    const STENCIL_OP = ["keep", "zero", "replace", "increment-clamp", "decrement-clamp", "invert", "increment-wrap", "decrement-wrap"];
    // the group and binding of push constants (vx/naga): after the sets, or in the last group
    const PUSH_BINDING = 998;
    // (WebGPU's uniform buffers a stage, the default limit; the rest a stage
    // uses are read-only storage buffers: createPipeline)
    const MAX_UNIFORMS_PER_STAGE = 12;
    /** the attachment of passes and pipelines without any (WebGPU needs one) */
    const PLACEHOLDER_FORMAT = "r8unorm";
    const pushGroup = setCount => setCount < 4 ? setCount : 3;
    const QUERY_REGION_BYTES = 16 * 1024, RESPONSE_OK = 1, RESPONSE_FAILED = 2;
    const BUFFER = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
    const TEXTURE = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
    // VkImageUsageFlagBits
    const USAGE = { TRANSFER_DST: 0x2, SAMPLED: 0x4, STORAGE: 0x8, COLOR: 0x10, DEPTH: 0x20, INPUT: 0x80 };
    // VkImageAspectFlagBits
    const ASPECT = { COLOR: 1, DEPTH: 2, STENCIL: 4 };

    const align = (value, to) => Math.ceil(value / to) * to;
    const f32 = bits => new Float32Array(new Uint32Array([bits]).buffer)[0];
    const SRGB_TWIN = { "rgba8unorm": "rgba8unorm-srgb", "rgba8unorm-srgb": "rgba8unorm", "bgra8unorm": "bgra8unorm-srgb", "bgra8unorm-srgb": "bgra8unorm" };
    const VIEW_DIMENSION = ["2d", "2d", "3d", "cube", "2d-array", "2d-array", "cube-array"];
    const ADDRESS = ["repeat", "mirror-repeat", "clamp-to-edge", "clamp-to-edge", "mirror-repeat"];
    const COMPARE = ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];

    class VXExecutor {
        /**
         * @param options { device, formats: VkFormat -> [WebGPU format, capabilities, vertex format, bytes] }
         */
        constructor(options) {
            this.device = options.device;
            this.formats = options.formats || global.V86VenusFormats || {};
            // { surface(sid) }: GX's surfaces, for images Venus imports from virtio-gpu resources
            this.peer = options.peer || null;
            this.objects = new Map();
            this.encoderInstance = null;
            this.pending = [];
            this.transient = [];
            this.pipelines = new Map();
            this.warned = new Set();
            this.warnings = [];
            this.errors = 0;
            this.stats = { batches: 0, commands: 0, readbacks: 0, submits: 0, draws: 0, dispatches: 0, pipelines: 0 };
            this.write = null;
            this.nagaUrl = options.nagaUrl || global.V86VenusNagaUrl || (SCRIPT ? new URL("vx_naga.wasm", SCRIPT).href : "vx_naga.wasm");
            this.naga = null;
            this.pass = null;
            this.computePass = null;
            this.queryResolves = [];
            this.activeQuery = -1;
            this.ones = null;
            // transform feedback: each counter's bytes (memory:offset -> value), as End wrote it; the active query
            this.xfbCounters = new Map();
            this.xfbQuery = null;
            this.resetState();
        }

        resetState() {
            this.state = {
                graphics: null, compute: null, pipelineApplied: false,
                // group contents by bind point (0 graphics, 1 compute): group -> { version, descriptors }
                groups: [new Map(), new Map()], groupVersion: 0,
                vertex: [], vertexDirty: true, index: null, indexDirty: true,
                push: new Uint8Array(256), pushVersion: 0,
                viewport: null, scissor: null, blend: null, stencilReference: 0, stencilMasks: [0xFF, 0xFF], dynamicDirty: true,
                passWidth: 0, passHeight: 0,
                // transform feedback: the buffers ({ memory, offset, size } by binding), whether it is active, the bytes captured into each
                xfb: { buffers: [], active: false, written: [0, 0, 0, 0] },
            };
        }

        /** a JSON body: the bytes after `skip` dwords */
        json(b, skip) {
            const bytes = new Uint8Array(b.buffer, b.byteOffset + skip * 4, b.byteLength - skip * 4);
            let end = bytes.length;
            while (end && !bytes[end - 1]) end--;
            return JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
        }

        warn(key, text) {
            if (this.warned.has(key)) return;
            this.warned.add(key);
            if (this.warnings.length < 100) this.warnings.push(text);
            console.warn("[vx] " + text);
        }

        reset() {
            this.flushEncoder();
            for (const object of this.objects.values()) this.release(object);
            this.objects.clear();
        }

        release(object) {
            if (object.buffer) object.buffer.destroy();
            if (object.querySet) object.querySet.destroy();
            // (an imported image's texture is its GX surface's)
            if (object.texture && object.kind === "texture" && !object.borrowed) object.texture.destroy();
        }

        /**
         * Run a VX batch
         * @param bytes Uint8Array
         * @param options { writeResponse(offset, bytes) }
         */
        async submit(bytes, options) {
            this.write = options.writeResponse;
            if (bytes.byteOffset & 3) bytes = bytes.slice();
            const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
            if (words[0] !== VX_MAGIC) throw new Error("not a VX batch");
            const end = Math.min(words[2], words.length);
            this.stats.batches++;
            // (WebGPU's validation errors come later: what a batch did wrong is warned about)
            this.device.pushErrorScope("validation");
            for (let at = 4; at + 2 <= end;) {
                const op = words[at], n = words[at + 1];
                const body = words.subarray(at + 2, at + 2 + n);
                at += 2 + n;
                this.stats.commands++;
                try {
                    const r = this.command(op, body);
                    // (pipelines wait for their shaders' translation)
                    if (r && r.then) await r;
                } catch (error) {
                    this.errors++;
                    this.warn("exception:" + op + ":" + error.message, "VX op " + op + " failed: " + (error.stack || error));
                }
            }
            this.endPasses();
            this.flushEncoder();
            this.device.popErrorScope().then(error => {
                if (!error) return;
                this.errors++;
                this.warn("validation:" + error.message.slice(0, 80), "WebGPU: " + error.message);
            });
            const pending = this.pending.splice(0);
            if (pending.length) await Promise.all(pending);
        }

        command(op, b) {
            switch (op) {
                case VX.MEMORY_CREATE: return this.createMemory(b[0], b[1] + b[2] * 0x100000000);
                case VX.DESTROY: {
                    const object = this.objects.get(b[0]);
                    if (object) {
                        // (after the work that uses it)
                        this.flushEncoder();
                        this.release(object);
                    }
                    this.objects.delete(b[0]);
                    return;
                }
                case VX.MEMORY_WRITE: return this.writeMemory(b);
                case VX.MEMORY_READ: return this.readMemory(b);
                case VX.TEXTURE_CREATE: return this.createTexture(b);
                case VX.VIEW_CREATE: return this.createView(b);
                case VX.SAMPLER_CREATE: return this.createSampler(b);
                case VX.BEGIN: return;
                case VX.END: this.stats.submits++; return this.flushEncoder();
                case VX.COPY_BUFFER: return this.copyBuffer(b);
                case VX.FILL_BUFFER: return this.fillBuffer(b);
                case VX.UPDATE_BUFFER: return this.updateBuffer(b);
                case VX.COPY_BUFFER_IMAGE: return this.copyBufferImage(b);
                case VX.COPY_IMAGE: return this.copyImage(b);
                case VX.BLIT_IMAGE: return this.blitImage(b);
                case VX.CLEAR_IMAGE: return this.clearImage(b);
                case VX.RESOLVE_IMAGE: return this.resolveImage(b);
                case VX.SHADER_CREATE: {
                    this.objects.set(b[0], { kind: "shader", spirv: new Uint8Array(b.buffer, b.byteOffset + 8, b[1]).slice(), translations: new Map() });
                    return;
                }
                case VX.PIPELINE_CREATE: return this.createPipeline(b[0], this.json(b, 1));
                case VX.BEGIN_PASS: return this.beginPass(this.json(b, 0));
                case VX.END_PASS: return this.endPass();
                case VX.BIND_PIPELINE: {
                    const p = this.objects.get(b[0]);
                    if (p && p.kind === "pipeline") {
                        if (p.compute) this.state.compute = p;
                        else { this.state.graphics = p; this.state.pipelineApplied = false; }
                    }
                    return;
                }
                case VX.SET_BIND_GROUP: return this.setBindGroup(b);
                case VX.SET_VERTEX_BUFFER: {
                    this.state.vertex[b[0]] = { memory: b[1], offset: b[2] + b[3] * 0x100000000, size: b[4] + b[5] * 0x100000000 };
                    this.state.vertexDirty = true;
                    return;
                }
                case VX.SET_INDEX_BUFFER:
                    this.state.index = { memory: b[0], offset: b[1] + b[2] * 0x100000000, size: b[3] + b[4] * 0x100000000, type: b[5] };
                    this.state.indexDirty = true;
                    return;
                case VX.SET_PUSH_CONSTANTS: {
                    this.state.push.set(new Uint8Array(b.buffer, b.byteOffset + 8, Math.min(b[1], 256 - b[0])), b[0]);
                    this.state.pushVersion++;
                    return;
                }
                case VX.SET_VIEWPORT: this.state.viewport = Array.from(b.subarray(0, 6), f32); this.state.dynamicDirty = true; return;
                case VX.SET_SCISSOR: this.state.scissor = [b[0] | 0, b[1] | 0, b[2], b[3]]; this.state.dynamicDirty = true; return;
                case VX.SET_BLEND_CONSTANTS: this.state.blend = Array.from(b.subarray(0, 4), f32); this.state.dynamicDirty = true; return;
                case VX.SET_STENCIL_REFERENCE: this.state.stencilReference = b[1]; this.state.dynamicDirty = true; return;
                // (the front face's: WebGPU has one pair for both faces)
                case VX.SET_STENCIL_COMPARE_MASK: if (b[0] & 1) this.state.stencilMasks[0] = b[1] & 0xFF; return;
                case VX.SET_STENCIL_WRITE_MASK: if (b[0] & 1) this.state.stencilMasks[1] = b[1] & 0xFF; return;
                case VX.DRAW: return this.draw(b, 0);
                case VX.DRAW_INDEXED: return this.draw(b, 1);
                case VX.DRAW_INDIRECT: return this.draw(b, 2);
                case VX.DISPATCH: return this.dispatch(b, false);
                case VX.DISPATCH_INDIRECT: return this.dispatch(b, true);
                case VX.CLEAR_ATTACHMENTS: return this.clearAttachments(this.json(b, 0));
                case VX.QUERY_POOL_CREATE:
                    if (b[1] === 0) this.objects.set(b[0], { kind: "queries", querySet: this.device.createQuerySet({ type: "occlusion", count: Math.max(1, b[2]) }) });
                    // (transform feedback's: the captures count the primitives)
                    if (b[1] === QUERY_XFB) this.objects.set(b[0], { kind: "queries", xfb: true, count: b[2] });
                    return;
                case VX.BEGIN_QUERY:
                    if (this.objects.get(b[0]) && this.objects.get(b[0]).xfb) { this.xfbQuery = { pool: b[0], query: b[1], written: 0, needed: 0 }; return; }
                    if (this.pass && this.passInfo.occlusion === b[0]) { this.pass.beginOcclusionQuery(b[1]); this.activeQuery = b[1]; }
                    else this.warn("query-outside", "an occlusion query outside of a render pass, or of another pool than the pass's");
                    return;
                case VX.END_QUERY: {
                    if (this.xfbQuery && this.xfbQuery.pool === b[0] && this.xfbQuery.query === b[1]) {
                        // (two u64, primitives written and needed; the queue's write goes before this encoder)
                        const q = this.xfbQuery, memory = this.memory(b[2]);
                        this.xfbQuery = null;
                        if (memory && b[1] * 16 + 16 <= memory.buffer.size) this.device.queue.writeBuffer(memory.buffer, b[1] * 16,
                            new Uint32Array([q.written >>> 0, Math.floor(q.written / 0x100000000), q.needed >>> 0, Math.floor(q.needed / 0x100000000)]));
                        return;
                    }
                    if (!this.pass || this.activeQuery !== b[1]) return;
                    this.pass.endOcclusionQuery();
                    this.activeQuery = -1;
                    const pool = this.objects.get(b[0]), memory = this.memory(b[2]);
                    if (pool && memory) this.queryResolves.push([pool.querySet, b[1], memory]);
                    return;
                }
                case VX.COPY_QUERY_RESULTS: return this.copyQueryResults(b);
                case VX.TEXTURE_READ: return this.readTexture(b);
                case VX.TEXTURE_WRITE: return this.writeTexture(b);
                case VX.TEXTURE_IMPORT: return this.importTexture(b);
                case VX.XFB_BIND:
                    this.state.xfb.buffers[b[0] & 3] = { memory: b[1], offset: b[2] + b[3] * 0x100000000, size: b[4] + b[5] * 0x100000000 };
                    return;
                case VX.XFB_BEGIN: return this.xfbBegin(b, true);
                case VX.XFB_END: return this.xfbBegin(b, false);
            }
            this.warn("op" + op, "unknown VX op " + op);
        }

        // ------------------------------------------------------------------
        // The encoder

        encoder() {
            // (copies and render passes are outside of compute passes)
            if (this.computePass) { this.computePass.end(); this.computePass = null; }
            if (!this.encoderInstance) this.encoderInstance = this.device.createCommandEncoder();
            return this.encoderInstance;
        }

        endPasses() {
            if (this.pass) { this.pass.end(); this.pass = null; this.resolveQueries(); }
            if (this.computePass) { this.computePass.end(); this.computePass = null; }
        }

        /** the occlusion queries a pass ended: their results into their pools' memory (through 256-aligned places) */
        resolveQueries() {
            const list = this.queryResolves;
            if (!list.length) return;
            this.queryResolves = [];
            const scratch = this.scratch(list.length * 256, BUFFER.QUERY_RESOLVE | BUFFER.COPY_SRC);
            const encoder = this.encoder();
            list.forEach(([set, index, memory], i) => {
                encoder.resolveQuerySet(set, index, 1, scratch, i * 256);
                encoder.copyBufferToBuffer(scratch, i * 256, memory.buffer, index * 8, 8);
            });
        }

        /**
         * vkCmdCopyQueryPoolResults: the u64 results (`values` a query: two
         * for transform feedback's), or their low halves, and availability
         * (1: run in order, they are done)
         */
        copyQueryResults(b) {
            const [from, first, count, to, low, high, stride, flags] = b;
            const values = b[8] || 1;
            const src = this.memory(from), dst = this.memory(to);
            if (!src || !dst) return;
            const offset = low + high * 0x100000000, size = flags & 1 ? 8 : 4;
            if (!this.ones) {
                this.ones = this.device.createBuffer({ size: 8, usage: BUFFER.COPY_SRC, mappedAtCreation: true });
                new Uint32Array(this.ones.getMappedRange()).set([1, 0]);
                this.ones.unmap();
            }
            const encoder = this.encoder();
            for (let i = 0; i < count; i++) {
                const at = offset + i * stride;
                if (at + values * size > dst.buffer.size) break;
                for (let k = 0; k < values; k++) encoder.copyBufferToBuffer(src.buffer, ((first + i) * values + k) * 8, dst.buffer, at + k * size, size);
                if (flags & 4 && at + (values + 1) * size <= dst.buffer.size) encoder.copyBufferToBuffer(this.ones, 0, dst.buffer, at + values * size, size);
            }
        }

        flushEncoder() {
            this.endPasses();
            if (this.encoderInstance) {
                this.device.queue.submit([this.encoderInstance.finish()]);
                this.encoderInstance = null;
            }
            for (const buffer of this.transient.splice(0)) buffer.destroy();
        }

        /** A buffer with these bytes, to copy from in the encoder */
        staging(bytes) {
            const size = align(Math.max(4, bytes.length), 4);
            const buffer = this.device.createBuffer({ size, usage: BUFFER.COPY_SRC, mappedAtCreation: true });
            new Uint8Array(buffer.getMappedRange()).set(bytes);
            buffer.unmap();
            this.transient.push(buffer);
            return buffer;
        }

        scratch(size, usage) {
            const buffer = this.device.createBuffer({ size: align(Math.max(4, size), 4), usage });
            this.transient.push(buffer);
            return buffer;
        }

        // ------------------------------------------------------------------
        // Memory

        createMemory(id, size) {
            const limit = this.device.limits.maxBufferSize;
            if (size > limit) {
                this.warn("memory-size", "memory of " + size + " bytes is more than WebGPU's buffers have (" + limit + ")");
                return;
            }
            const usage = BUFFER.COPY_SRC | BUFFER.COPY_DST | BUFFER.INDEX | BUFFER.VERTEX | BUFFER.UNIFORM | BUFFER.STORAGE |
                BUFFER.INDIRECT | BUFFER.QUERY_RESOLVE;
            this.objects.set(id, { kind: "memory", buffer: this.device.createBuffer({ size: align(Math.max(4, size), 4), usage }), size });
        }

        memory(id) {
            const m = this.objects.get(id);
            return m && m.kind === "memory" ? m : null;
        }

        writeMemory(b) {
            const m = this.memory(b[0]);
            const offset = b[1] + b[2] * 0x100000000, length = b[3];
            if (!m) return;
            const bytes = new Uint8Array(b.buffer, b.byteOffset + 16, length);
            this.flushEncoder();
            // (whole dwords: the memory's size is rounded up to them)
            const padded = length & 3 || offset & 3 ? null : bytes;
            if (padded) this.device.queue.writeBuffer(m.buffer, offset, padded);
            else {
                const start = offset & ~3, stop = Math.min(m.buffer.size, align(offset + length, 4));
                if (start === offset && length % 4 === 0) this.device.queue.writeBuffer(m.buffer, offset, bytes);
                else {
                    // (an unaligned edge: the bytes around it come from a readback first)
                    this.warn("unaligned-write", "a memory write of " + length + " bytes at " + offset + " is not in whole dwords");
                    const whole = new Uint8Array(stop - start);
                    whole.set(bytes, offset - start);
                    this.device.queue.writeBuffer(m.buffer, start, whole);
                }
            }
        }

        readMemory(b) {
            const [id, low, high, length, request] = b;
            const m = this.memory(id);
            const offset = low + high * 0x100000000;
            if (!m || offset + length > m.buffer.size) return this.respond(request, null);
            this.stats.readbacks++;
            const start = offset & ~3, stop = Math.min(m.buffer.size, align(offset + length, 4));
            const target = this.device.createBuffer({ size: Math.max(4, stop - start), usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
            if (stop > start) this.encoder().copyBufferToBuffer(m.buffer, start, target, 0, stop - start);
            this.flushEncoder();
            this.pending.push(target.mapAsync(1).then(() => {
                const bytes = new Uint8Array(target.getMappedRange()).slice(offset - start, offset - start + length);
                target.destroy();
                this.respond(request, bytes);
            }, () => { target.destroy(); this.respond(request, null); }));
        }

        /** A readback's answer: id, length, 0, status, then the bytes */
        respond(id, bytes) {
            const out = new Uint8Array(16 + (bytes ? bytes.length : 0));
            const view = new DataView(out.buffer);
            view.setUint32(0, id, true);
            view.setUint32(4, bytes ? bytes.length : 0, true);
            view.setUint32(12, bytes ? RESPONSE_OK : RESPONSE_FAILED, true);
            if (bytes) out.set(bytes, 16);
            if (this.write) this.write(QUERY_REGION_BYTES, out);
        }

        copyBuffer(b) {
            const src = this.memory(b[0]), dst = this.memory(b[3]);
            const from = b[1] + b[2] * 0x100000000, to = b[4] + b[5] * 0x100000000, size = b[6] + b[7] * 0x100000000;
            if (!src || !dst) return;
            if ((from | to | size) & 3) {
                this.warn("copy-unaligned", "a buffer copy not in whole dwords (" + from + ", " + to + ", " + size + ")");
                return;
            }
            if (src === dst) {
                // (WebGPU copies between two buffers only: through another)
                const between = this.scratch(size, BUFFER.COPY_SRC | BUFFER.COPY_DST);
                this.encoder().copyBufferToBuffer(src.buffer, from, between, 0, size);
                this.encoder().copyBufferToBuffer(between, 0, dst.buffer, to, size);
                return;
            }
            this.encoder().copyBufferToBuffer(src.buffer, from, dst.buffer, to, size);
        }

        fillBuffer(b) {
            const dst = this.memory(b[0]);
            const offset = b[1] + b[2] * 0x100000000, size = b[3] + b[4] * 0x100000000, data = b[5];
            if (!dst || !size) return;
            if (data === 0) {
                this.encoder().clearBuffer(dst.buffer, offset, size);
                return;
            }
            const pattern = new Uint32Array(size / 4).fill(data);
            this.encoder().copyBufferToBuffer(this.staging(new Uint8Array(pattern.buffer)), 0, dst.buffer, offset, size);
        }

        updateBuffer(b) {
            const dst = this.memory(b[0]);
            const offset = b[1] + b[2] * 0x100000000, length = b[3];
            if (!dst || !length) return;
            const bytes = new Uint8Array(b.buffer, b.byteOffset + 16, length);
            this.encoder().copyBufferToBuffer(this.staging(bytes), 0, dst.buffer, offset, align(length, 4));
        }

        // ------------------------------------------------------------------
        // Textures

        format(vk) {
            const entry = this.formats[vk];
            if (!entry || !entry[0]) return null;
            const [gpu, caps, , bytes] = entry;
            return { gpu, bytes, caps, float: /[fx]/.test(caps), int: caps.includes("i"), depth: caps.includes("d"),
                renderable: caps.includes("r") || caps.includes("d"),
                uint: /uint$/.test(gpu), sint: /sint$/.test(gpu),
                hasDepth: /^depth/.test(gpu), hasStencil: /stencil/.test(gpu) };
        }

        createTexture(b) {
            const [id, vkformat, type, width, height, depth, mips, layers, samples, usage, flags] = b;
            const f = this.format(vkformat);
            if (!f) {
                this.warn("format" + vkformat, "images of VkFormat " + vkformat + " are not done");
                return;
            }
            let gpu_usage = TEXTURE.COPY_SRC | TEXTURE.COPY_DST | TEXTURE.TEXTURE_BINDING;
            // (render passes do clears, blits and resolves)
            if (f.renderable) gpu_usage |= TEXTURE.RENDER_ATTACHMENT;
            // (a format WebGPU cannot store to, sRGB: a mutable image's
            // storage views would be of its linear twin, which WebGPU's
            // textures cannot have; without storage, those views fail)
            if (usage & USAGE.STORAGE && f.caps.includes("s")) gpu_usage |= TEXTURE.STORAGE_BINDING;
            const volume = type === 2;
            const descriptor = {
                size: [width, volume ? height : Math.max(1, height), volume ? depth : layers],
                dimension: volume ? "3d" : "2d",
                format: f.gpu, mipLevelCount: mips, sampleCount: samples > 1 ? 4 : 1, usage: gpu_usage,
            };
            // VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT: its sRGB twin may view it
            if (flags & 0x8 && SRGB_TWIN[f.gpu]) descriptor.viewFormats = [SRGB_TWIN[f.gpu]];
            if (samples > 1) descriptor.usage &= ~TEXTURE.STORAGE_BINDING;
            const texture = this.device.createTexture(descriptor);
            this.objects.set(id, { kind: "texture", texture, vkformat, f, volume, width, height, depth, mips, layers, samples });
        }

        /**
         * An image bound to an imported virtio-gpu resource: it becomes the
         * texture of the resource's GX surface (same device), so Venus draws
         * into what virgl, the display and the guest's transfers see. The
         * image's own texture goes; GX keeps owning the surface's.
         */
        importTexture(b) {
            const [id, sid] = b;
            const image = this.objects.get(id);
            const surface = this.peer ? this.peer.surface(sid) : null;
            if (!image || image.kind !== "texture") return;
            if (!surface || !surface.texture) {
                this.warn("import" + sid, "resource " + sid + " has no GX texture to import");
                return;
            }
            const texture = surface.texture;
            if (texture.format !== image.f.gpu || texture.width !== image.width || texture.height !== Math.max(1, image.height) ||
                surface.ss[0] !== 1 || surface.ss[1] !== 1) {
                this.warn("import-mismatch" + sid, "resource " + sid + " (" + texture.format + " " + texture.width + "x" + texture.height +
                    ") does not match its image (" + image.f.gpu + " " + image.width + "x" + image.height + ")");
                return;
            }
            this.flushEncoder();
            const old = image.borrowed ? null : image.texture;
            // (in place: a restored state makes the image's views before
            // importing it again, and they are remade on the new texture)
            Object.assign(image, { texture, borrowed: true, mips: texture.mipLevelCount, layers: texture.depthOrArrayLayers });
            for (const v of this.objects.values()) {
                if (v.kind !== "view" || v.texture !== image) continue;
                v.view = this.view(texture, Object.assign({}, v.descriptor));
                v.attachment = v.storage = null;
            }
            if (old) old.destroy();
        }

        texture(id) {
            const t = this.objects.get(id);
            return t && t.kind === "texture" ? t : null;
        }

        /**
         * A texture view; an sRGB view of a texture that has storage usage
         * leaves it out (a view has its texture's usage unless it says
         * otherwise, and sRGB formats cannot be stored to)
         */
        view(texture, descriptor) {
            if (texture.usage & TEXTURE.STORAGE_BINDING && /-srgb$/.test(descriptor.format)) {
                descriptor.usage = texture.usage & ~TEXTURE.STORAGE_BINDING;
            }
            return texture.createView(descriptor);
        }

        createView(b) {
            const [id, tid, type, vkformat, aspect, baseMip, mips, baseLayer, layers] = b;
            const t = this.texture(tid);
            if (!t) return;
            const f = this.format(vkformat) || t.f;
            const dimension = t.volume ? "3d" : VIEW_DIMENSION[type] || "2d";
            const descriptor = {
                format: f.gpu, dimension,
                aspect: aspect === ASPECT.DEPTH && t.f.hasStencil ? "depth-only" : aspect === ASPECT.STENCIL && t.f.hasDepth ? "stencil-only" : "all",
                baseMipLevel: baseMip, mipLevelCount: mips,
                baseArrayLayer: t.volume ? 0 : baseLayer, arrayLayerCount: t.volume ? 1 : layers,
            };
            const view = this.view(t.texture, Object.assign({}, descriptor));
            this.objects.set(id, { kind: "view", view, descriptor, texture: t, f, aspect, baseMip, mips, baseLayer, layers, dimension });
        }

        createSampler(b) {
            const [id, mag, min, mipmap, u, v, w, bias, anisotropy, compare, compareOp, minLod, maxLod] = b;
            const linear = mag === 1 && min === 1 && mipmap === 1;
            const descriptor = {
                magFilter: mag === 1 ? "linear" : "nearest", minFilter: min === 1 ? "linear" : "nearest",
                mipmapFilter: mipmap === 1 ? "linear" : "nearest",
                addressModeU: ADDRESS[u] || "repeat", addressModeV: ADDRESS[v] || "repeat", addressModeW: ADDRESS[w] || "repeat",
                lodMinClamp: Math.max(0, f32(minLod)), lodMaxClamp: Math.max(Math.max(0, f32(minLod)), Math.min(32, f32(maxLod))),
                maxAnisotropy: linear ? Math.max(1, Math.min(16, Math.floor(f32(anisotropy)))) : 1,
            };
            if (compare) descriptor.compare = COMPARE[compareOp] || "always";
            if (f32(bias)) this.warn("lod-bias", "samplers' LOD bias is not done");
            if (u === 3 || v === 3 || w === 3) this.warn("border", "clamp to border is clamp to edge");
            this.objects.set(id, { kind: "sampler", sampler: this.device.createSampler(descriptor) });
        }

        /** The aspect a copy names, and the bytes of its texels */
        copyAspect(t, aspect) {
            if (aspect === ASPECT.STENCIL) return { aspect: "stencil-only", bytes: 1 };
            if (aspect === ASPECT.DEPTH) {
                if (t.f.gpu === "depth24plus" || t.f.gpu === "depth24plus-stencil8") return null;
                return { aspect: t.f.hasStencil ? "depth-only" : "all", bytes: t.f.gpu === "depth16unorm" ? 2 : 4 };
            }
            return { aspect: "all", bytes: t.f.bytes };
        }

        /** a texture's image (one mip, one layer or slice, one aspect), for a snapshot: null where WebGPU cannot copy it (multisampled, 24-bit depth) */
        readTexture(b) {
            const [id, aspectMask, mip, layer, request] = b;
            const t = this.texture(id);
            const a = t && t.samples <= 1 ? this.copyAspect(t, aspectMask) : null;
            if (!a) return this.respond(request, null);
            const w = Math.max(1, t.width >> mip), h = Math.max(1, t.height >> mip);
            const rowBytes = w * a.bytes, aligned = align(rowBytes, 256);
            const target = this.device.createBuffer({ size: aligned * h, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
            this.encoder().copyTextureToBuffer({ texture: t.texture, mipLevel: mip, origin: [0, 0, layer], aspect: a.aspect },
                { buffer: target, bytesPerRow: aligned, rowsPerImage: h }, [w, h, 1]);
            this.flushEncoder();
            this.pending.push(target.mapAsync(1).then(() => {
                const all = new Uint8Array(target.getMappedRange()), out = new Uint8Array(rowBytes * h);
                for (let r = 0; r < h; r++) out.set(all.subarray(r * aligned, r * aligned + rowBytes), r * rowBytes);
                target.destroy();
                this.respond(request, out);
            }, () => { target.destroy(); this.respond(request, null); }));
        }

        /** a snapshot's image back into its texture (WebGPU writes no depth32float: those come back cleared) */
        writeTexture(b) {
            const [id, aspectMask, mip, layer, length] = b;
            const t = this.texture(id);
            const a = t ? this.copyAspect(t, aspectMask) : null;
            if (!a || t.samples > 1) return;
            if (t.f.gpu === "depth32float" || t.f.gpu === "depth32float-stencil8" && a.aspect === "depth-only") {
                this.warn("restore-depth32", "32-bit depth comes back from a snapshot cleared");
                return;
            }
            const w = Math.max(1, t.width >> mip), h = Math.max(1, t.height >> mip);
            if (length < w * h * a.bytes) return;
            this.flushEncoder();
            this.device.queue.writeTexture({ texture: t.texture, mipLevel: mip, origin: [0, 0, layer], aspect: a.aspect },
                new Uint8Array(b.buffer, b.byteOffset + 20, length), { bytesPerRow: w * a.bytes, rowsPerImage: h }, [w, h, 1]);
        }

        copyBufferImage(b) {
            const [toImage, mid, low, high, rowLength, imageHeight, tid, aspectMask, mip, layer, layers, x, y, z, w, h, d] = b;
            const m = this.memory(mid), t = this.texture(tid);
            if (!m || !t || !w || !h || !d) return;
            const a = this.copyAspect(t, aspectMask);
            if (!a) {
                this.warn("copy-d24", "copies of 24-bit depth are not done");
                return;
            }
            const offset = low + high * 0x100000000;
            const pitch = (rowLength || w) * a.bytes, rows = imageHeight || h;
            const slices = t.volume ? d : layers;
            const rowBytes = w * a.bytes, aligned = align(rowBytes, 256);
            const place = { texture: t.texture, mipLevel: mip, origin: [x, y, t.volume ? z : layer], aspect: a.aspect };
            const size = [w, h, slices];
            const encoder = this.encoder();
            if (pitch % 256 === 0 && offset % 4 === 0) {
                const layout = { buffer: m.buffer, offset, bytesPerRow: pitch, rowsPerImage: rows };
                if (toImage) encoder.copyBufferToTexture(layout, place, size);
                else encoder.copyTextureToBuffer(place, layout, size);
                return;
            }
            if ((offset | pitch | rowBytes | pitch * rows) & 3) {
                this.warn("copy-pitch", "buffer-image copies of rows not in whole dwords are not done");
                return;
            }
            // row by row through a staging buffer of WebGPU's pitch
            const staging = this.scratch(aligned * h * slices, BUFFER.COPY_SRC | BUFFER.COPY_DST);
            const layout = { buffer: staging, offset: 0, bytesPerRow: aligned, rowsPerImage: h };
            if (!toImage) encoder.copyTextureToBuffer(place, layout, size);
            for (let s = 0; s < slices; s++) {
                for (let r = 0; r < h; r++) {
                    const there = offset + s * pitch * rows + r * pitch, here = (s * h + r) * aligned;
                    if (toImage) encoder.copyBufferToBuffer(m.buffer, there, staging, here, rowBytes);
                    else encoder.copyBufferToBuffer(staging, here, m.buffer, there, rowBytes);
                }
            }
            if (toImage) encoder.copyBufferToTexture(layout, place, size);
        }

        copyImage(b) {
            const [sid, sa, smip, slayer, sx, sy, sz, did, da, dmip, dlayer, dx, dy, dz, w, h, d, layers] = b;
            const s = this.texture(sid), t = this.texture(did);
            if (!s || !t) return;
            const as = this.copyAspect(s, sa), at = this.copyAspect(t, da);
            if (!as || !at) {
                this.warn("copy-d24", "copies of 24-bit depth are not done");
                return;
            }
            const size = [w, h, s.volume ? d : layers];
            const from = { texture: s.texture, mipLevel: smip, origin: [sx, sy, s.volume ? sz : slayer], aspect: as.aspect };
            const to = { texture: t.texture, mipLevel: dmip, origin: [dx, dy, t.volume ? dz : dlayer], aspect: at.aspect };
            const base = f => f.gpu.replace("-srgb", "");
            if (base(s.f) === base(t.f)) {
                this.encoder().copyTextureToTexture(from, to, size);
                return;
            }
            // formats of the same size: through a buffer
            const aligned = align(w * as.bytes, 256);
            const staging = this.scratch(aligned * h * size[2], BUFFER.COPY_SRC | BUFFER.COPY_DST);
            const layout = { buffer: staging, offset: 0, bytesPerRow: aligned, rowsPerImage: h };
            this.encoder().copyTextureToBuffer(from, layout, size);
            this.encoder().copyBufferToTexture(layout, to, size);
        }

        /** A view of one mip and layer (or depth slice's layer: 0) for a render pass */
        attachment(t, mip, layer, format) {
            return this.view(t.texture, { format: format || t.f.gpu, dimension: t.volume ? "3d" : "2d", baseMipLevel: mip, mipLevelCount: 1,
                baseArrayLayer: t.volume ? 0 : layer, arrayLayerCount: 1 });
        }

        clearImage(b) {
            const [tid, aspect, baseMip, mips, baseLayer, layers, v0, v1, v2, v3] = b;
            const t = this.texture(tid);
            if (!t) return;
            const encoder = this.encoder();
            for (let mip = baseMip; mip < baseMip + mips; mip++) {
                const slices = t.volume ? Math.max(1, t.depth >> mip) : layers;
                for (let i = 0; i < slices; i++) {
                    const layer = t.volume ? 0 : baseLayer + i;
                    const view = this.attachment(t, mip, layer);
                    if (t.f.depth) {
                        const ds = { view };
                        if (t.f.hasDepth) Object.assign(ds, aspect & ASPECT.DEPTH ?
                            { depthLoadOp: "clear", depthClearValue: f32(v0), depthStoreOp: "store" } : { depthLoadOp: "load", depthStoreOp: "store" });
                        if (t.f.hasStencil) Object.assign(ds, aspect & ASPECT.STENCIL ?
                            { stencilLoadOp: "clear", stencilClearValue: v1, stencilStoreOp: "store" } : { stencilLoadOp: "load", stencilStoreOp: "store" });
                        encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: ds }).end();
                        continue;
                    }
                    if (!t.f.renderable) {
                        this.warn("clear-format" + t.vkformat, "clearing VkFormat " + t.vkformat + " (not renderable) is not done");
                        return;
                    }
                    const values = [v0, v1, v2, v3];
                    const clearValue = t.f.uint ? values.map(v => v >>> 0) : t.f.sint ? values.map(v => v | 0) : values.map(f32);
                    const attachment = { view, loadOp: "clear", storeOp: "store", clearValue: { r: clearValue[0], g: clearValue[1], b: clearValue[2], a: clearValue[3] } };
                    if (t.volume) attachment.depthSlice = i;
                    encoder.beginRenderPass({ colorAttachments: [attachment] }).end();
                }
            }
        }

        resolveImage(b) {
            const [sid, smip, slayer, sx, sy, did, dmip, dlayer, dx, dy, w, h, layers] = b;
            const s = this.texture(sid), t = this.texture(did);
            if (!s || !t) return;
            const sw = Math.max(1, s.width >> smip), sh = Math.max(1, s.height >> smip);
            const tw = Math.max(1, t.width >> dmip), th = Math.max(1, t.height >> dmip);
            // (a render pass resolves all of an attachment into one of its
            // size: a region, or an image of another size, is resolved whole
            // into a single-sample copy, and the region copied from there)
            const whole = !sx && !sy && !dx && !dy && w === sw && h === sh && tw === sw && th === sh;
            let single = null;
            if (!whole) {
                single = this.device.createTexture({ size: [sw, sh, 1], format: s.f.gpu, usage: TEXTURE.RENDER_ATTACHMENT | TEXTURE.COPY_SRC });
                this.transient.push(single);
            }
            for (let i = 0; i < layers; i++) {
                const resolveTarget = whole ? this.attachment(t, dmip, dlayer + i) : this.view(single, { dimension: "2d" });
                this.encoder().beginRenderPass({ colorAttachments: [{
                    view: this.attachment(s, smip, slayer + i), resolveTarget, loadOp: "load", storeOp: "store",
                }] }).end();
                if (!whole) {
                    this.encoder().copyTextureToTexture({ texture: single, mipLevel: 0, origin: [sx, sy, 0] },
                        { texture: t.texture, mipLevel: dmip, origin: [dx, dy, dlayer + i] }, [w, h, 1]);
                }
            }
        }

        /** The blit pipeline into a format: a quad sampling the source */
        blitPipeline(format, kind) {
            const key = format + ":" + kind;
            let p = this.pipelines.get(key);
            if (p) return p;
            const type = kind === "u" ? "u32" : kind === "i" ? "i32" : "f32";
            const code = [
                "struct Rect { dst: vec4f, src: vec4f, level: f32 };",
                "@group(0) @binding(0) var<uniform> rect: Rect;",
                "@group(0) @binding(1) var source: texture_2d<" + type + ">;",
                kind === "f" ? "@group(0) @binding(2) var smp: sampler;" : "",
                "struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f };",
                "@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {",
                "    let corner = vec2f(f32(i & 1u), f32(i >> 1u));",
                "    var out: Out;",
                "    let xy = mix(rect.dst.xy, rect.dst.zw, corner);",
                "    out.position = vec4f(xy.x * 2.0 - 1.0, 1.0 - xy.y * 2.0, 0.0, 1.0);",
                "    out.uv = mix(rect.src.xy, rect.src.zw, corner);",
                "    return out;",
                "}",
                "@fragment fn fs(in: Out) -> @location(0) vec4<" + type + "> {",
                kind === "f" ? "    return textureSampleLevel(source, smp, in.uv, rect.level);" :
                    "    let size = vec2f(textureDimensions(source, u32(rect.level)));\n" +
                    "    return textureLoad(source, vec2i(floor(in.uv * size)), i32(rect.level));",
                "}",
            ].join("\n");
            const module = this.device.createShaderModule({ code });
            p = this.device.createRenderPipeline({
                layout: "auto",
                vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: [{ format }] },
                primitive: { topology: "triangle-strip" },
            });
            this.pipelines.set(key, p);
            return p;
        }

        blitImage(b) {
            const [sid, smip, slayer, sx0, sy0, sz0, sx1, sy1, sz1, did, dmip, dlayer, dx0, dy0, dz0, dx1, dy1, dz1, layers, linear] = b;
            const s = this.texture(sid), t = this.texture(did);
            if (!s || !t) return;
            if (t.f.depth || s.f.depth || !t.f.renderable || s.volume || t.volume) {
                this.warn("blit-kind", "blits of depth, of 3D images and into formats not renderable are not done");
                return;
            }
            const kind = s.f.uint ? "u" : s.f.sint ? "i" : "f";
            const pipeline = this.blitPipeline(t.f.gpu, kind);
            const sw = Math.max(1, s.width >> smip), sh = Math.max(1, s.height >> smip);
            const tw = Math.max(1, t.width >> dmip), th = Math.max(1, t.height >> dmip);
            // the destination's corners in order, the source's following them (flips)
            const flipX = dx0 > dx1, flipY = dy0 > dy1;
            const rect = new Float32Array(12);
            rect.set([Math.min(dx0, dx1) / tw, Math.min(dy0, dy1) / th, Math.max(dx0, dx1) / tw, Math.max(dy0, dy1) / th,
                (flipX ? sx1 : sx0) / sw, (flipY ? sy1 : sy0) / sh, (flipX ? sx0 : sx1) / sw, (flipY ? sy0 : sy1) / sh, 0]);
            const uniform = this.staging(new Uint8Array(rect.buffer));
            const ubo = this.scratch(48, BUFFER.UNIFORM | BUFFER.COPY_DST);
            const encoder = this.encoder();
            encoder.copyBufferToBuffer(uniform, 0, ubo, 0, 48);
            const sampler = kind === "f" ? this.device.createSampler({ magFilter: linear ? "linear" : "nearest", minFilter: linear ? "linear" : "nearest" }) : null;
            for (let i = 0; i < layers; i++) {
                const source = s.texture.createView({ dimension: "2d", baseMipLevel: smip, mipLevelCount: 1, baseArrayLayer: slayer + i, arrayLayerCount: 1 });
                const entries = [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: source }];
                if (sampler) entries.push({ binding: 2, resource: sampler });
                const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
                const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.attachment(t, dmip, dlayer + i), loadOp: "load", storeOp: "store" }] });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, group);
                pass.draw(4);
                pass.end();
            }
        }

        // ------------------------------------------------------------------
        // Shaders: SPIR-V to WGSL with naga (vx_naga.wasm)

        async loadNaga() {
            if (this.naga) return this.naga;
            const response = await fetch(this.nagaUrl);
            if (!response.ok) throw new Error("vx_naga.wasm: " + response.status);
            const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
            this.naga = instance.exports;
            return this.naga;
        }

        /** a shader module's translation for a pipeline layout's push constant group */
        async translate(shader, push, storage = []) {
            await this.loadNaga();
            return this.translateNow(shader, push, false, storage);
        }

        /**
         * The same, naga loaded; `keep`: Vulkan's clip space kept, for draws
         * with a viewport of a negative height (flippedPipeline); `storage`:
         * the uniform buffers (set << 16 | binding) that are read-only
         * storage buffers in it (spilledUniforms)
         */
        translateNow(shader, push, keep, storage = []) {
            const key = String(push) + (keep ? ":keep" : "") + (storage.length ? ":" + storage.join(",") : "");
            let t = shader.translations.get(key);
            if (t) return t;
            const naga = this.naga;
            const input = naga.vx_alloc(shader.spirv.length);
            new Uint8Array(naga.memory.buffer, input, shader.spirv.length).set(shader.spirv);
            const list = storage.length ? naga.vx_alloc(storage.length * 4) : 0;
            if (list) new Uint32Array(naga.memory.buffer, list, storage.length).set(storage);
            let out;
            try {
                out = naga.vx_translate(input, shader.spirv.length, push, PUSH_BINDING, keep ? 1 : 0, list, storage.length);
            } catch (error) {
                // (a panic: a fresh instance next time)
                this.naga = null;
                throw error;
            }
            naga.vx_free(input, shader.spirv.length);
            if (list) naga.vx_free(list, storage.length * 4);
            const length = new DataView(naga.memory.buffer).getUint32(out, true);
            const text = new TextDecoder().decode(new Uint8Array(naga.memory.buffer, out + 4, length));
            naga.vx_free(out, length + 4);
            t = JSON.parse(text);
            // (derivatives in non-uniform control flow: SPIR-V allows them, WGSL by default not)
            if (!t.error) t.wgsl = "diagnostic(off, derivative_uniformity);\n" + t.wgsl;
            if (!t.error) t.module = this.device.createShaderModule({ code: t.wgsl });
            shader.translations.set(key, t);
            return t;
        }

        // ------------------------------------------------------------------
        // Pipelines

        stageState(t, stage) {
            const entry = t.entries.find(e => e.name === stage.entry) || t.entries[0];
            const constants = {};
            for (const [id, type] of t.overrides) {
                if (!(id in stage.constants)) continue;
                const v = stage.constants[id];
                constants[id] = type === "bool" ? (v ? 1 : 0) : type === "i32" ? v | 0 : type === "u32" ? v >>> 0 : f32(v);
            }
            return { module: t.module, entryPoint: entry ? entry.name : stage.entry, constants, entry };
        }

        /**
         * The uniform buffers a pipeline's stages make read-only storage
         * buffers: WebGPU has 12 uniform buffers a stage, the device reports
         * more (venus_device_info.js); in each stage with more, those after
         * its first 12 (by set and binding), the same in every stage that
         * has them (an automatic layout merges the stages' bindings)
         * @return {!Array<number>} set << 16 | binding, sorted
         */
        spilledUniforms(translations) {
            const spilled = new Set();
            for (const [t, stage] of translations) {
                const entry = t.entries.find(e => e.name === stage.entry) || t.entries[0];
                const uniforms = (entry ? entry.bindings : []).filter(b => b[2] === "uniform").map(([group, binding]) => group << 16 | binding >> 1)
                    .sort((a, b) => a - b);
                for (const key of uniforms.slice(MAX_UNIFORMS_PER_STAGE)) spilled.add(key);
            }
            return [...spilled].sort((a, b) => a - b);
        }

        async createPipeline(id, d) {
            const push = pushGroup(d.set_count);
            const p = { kind: "pipeline", desc: d, compute: d.kind === "compute", gpu: null, groups: new Map(), push,
                bindGroups: new Map(), error: null, storage: [] };
            this.objects.set(id, p);
            this.stats.pipelines++;
            try {
                const shaders = d.stages.map(stage => {
                    const shader = this.objects.get(stage.shader);
                    if (!shader) throw new Error("no shader " + stage.shader);
                    return shader;
                });
                let translations = [];
                for (const [i, stage] of d.stages.entries()) translations.push([await this.translate(shaders[i], push), stage]);
                for (const [t] of translations) if (t.error) throw new Error("shader: " + t.error);
                // (more uniform buffers than a stage has: some are storage, every stage translated so)
                p.storage = this.spilledUniforms(translations);
                if (p.storage.length) {
                    this.stats.spilledUniforms = (this.stats.spilledUniforms || 0) + 1;
                    translations = [];
                    for (const [i, stage] of d.stages.entries()) translations.push([await this.translate(shaders[i], push, p.storage), stage]);
                    for (const [t] of translations) if (t.error) throw new Error("shader: " + t.error);
                }
                const stages = translations.map(([t, stage]) => [stage.stage, this.stageState(t, stage)]);
                // the bindings the stages use, by group
                for (const [, st] of stages) {
                    for (const [group, binding, kind] of st.entry ? st.entry.bindings : []) {
                        if (!p.groups.has(group)) p.groups.set(group, new Map());
                        p.groups.get(group).set(binding, kind);
                    }
                }
                const strip = s => ({ module: s.module, entryPoint: s.entryPoint, constants: s.constants });
                if (p.compute) {
                    p.gpu = await this.device.createComputePipelineAsync({ layout: "auto", compute: strip(stages[0][1]) });
                    p.workgroup = stages[0][1].entry ? stages[0][1].entry.workgroup : [1, 1, 1];
                    return;
                }
                const vertex = stages.find(([s]) => s === 1), fragment = stages.find(([s]) => s === 16);
                if (!vertex) throw new Error("no vertex stage");
                // (its shader again for the flipped variant)
                const vertex_stage = d.stages.find(stage => stage.stage === 1);
                p.vertexSource = { shader: this.objects.get(vertex_stage.shader), stage: vertex_stage };
                const buffers = [];
                for (const b of d.buffers) {
                    if (b.binding >= 8) { this.warn("vertex-binding", "vertex binding " + b.binding + ": WebGPU has 8"); continue; }
                    while (buffers.length <= b.binding) buffers.push({ arrayStride: 0, attributes: [] });
                    buffers[b.binding] = { arrayStride: b.stride, stepMode: b.rate ? "instance" : "vertex", attributes: [] };
                }
                for (const a of d.attributes) {
                    const f = this.formats[a.format];
                    if (!f || !f[2]) { this.warn("vertex-format" + a.format, "vertex format " + a.format + " is not done"); continue; }
                    if (buffers[a.binding]) buffers[a.binding].attributes.push({ format: f[2], offset: a.offset, shaderLocation: a.location });
                }
                // (triangle fans: lists, drawn through fanIndices)
                const topology = d.topology === 5 ? "triangle-list" : TOPOLOGY[d.topology];
                if (!topology) this.warn("topology" + d.topology, "topology " + d.topology + " is not done");
                const descriptor = {
                    layout: "auto",
                    vertex: Object.assign(strip(vertex[1]), { buffers }),
                    primitive: {
                        topology: topology || "triangle-list",
                        cullMode: d.cull === 1 ? "front" : d.cull === 2 ? "back" : "none",
                        frontFace: d.front ? "cw" : "ccw",
                    },
                    multisample: { count: d.samples > 1 ? 4 : 1, mask: d.sample_mask >>> 0, alphaToCoverageEnabled: d.alpha_to_coverage },
                };
                if (d.polygon) this.warn("polygon-mode", "polygon modes other than fill are fill");
                if (d.depth_format) {
                    const f = this.format(d.depth_format);
                    const z = d.depth || { test: false, write: false, compare: 7, stencil: false };
                    const face = s => s && z.stencil ? { compare: COMPARE[s.compare], failOp: STENCIL_OP[s.fail], depthFailOp: STENCIL_OP[s.depth_fail], passOp: STENCIL_OP[s.pass] } : {};
                    descriptor.depthStencil = {
                        format: f.gpu,
                        depthWriteEnabled: !!(z.test && z.write),
                        depthCompare: z.test ? COMPARE[z.compare] : "always",
                    };
                    if (f.hasStencil) Object.assign(descriptor.depthStencil, { stencilFront: face(z.front), stencilBack: face(z.back),
                        stencilReadMask: z.stencil && z.front ? z.front.read_mask : 0xFFFFFFFF, stencilWriteMask: z.stencil && z.front ? z.front.write_mask : 0 });
                    if (d.depth_bias) Object.assign(descriptor.depthStencil, { depthBias: Math.round(d.depth_bias.constant),
                        depthBiasSlopeScale: d.depth_bias.slope, depthBiasClamp: d.depth_bias.clamp });
                }
                const targets = d.targets.map(t => {
                    const f = this.format(t.format);
                    if (!f) return null;
                    const target = { format: f.gpu, writeMask: d.discard ? 0 : t.write_mask };
                    if (t.blend && !f.int && !d.discard) target.blend = {
                        color: { srcFactor: BLEND_FACTOR[t.src_color], dstFactor: BLEND_FACTOR[t.dst_color], operation: BLEND_OP[t.color_op] },
                        alpha: { srcFactor: BLEND_FACTOR[t.src_alpha], dstFactor: BLEND_FACTOR[t.dst_alpha], operation: BLEND_OP[t.alpha_op] },
                    };
                    return target;
                });
                if (fragment && !d.discard) descriptor.fragment = Object.assign(strip(fragment[1]), { targets });
                else if (d.discard) {
                    // rasterizer discard: a fragment stage that writes nothing,
                    // for the pass's attachments, and no depth or stencil writes
                    descriptor.fragment = { module: this.emptyFragment(), entryPoint: "fs", targets };
                    if (descriptor.depthStencil) Object.assign(descriptor.depthStencil, { depthWriteEnabled: false, stencilWriteMask: 0 });
                }
                if (!descriptor.depthStencil && !(descriptor.fragment && descriptor.fragment.targets.some(t => t))) {
                    // no attachments (WebGPU needs one): the placeholder the pass gets too, single-sampled
                    descriptor.fragment = descriptor.fragment || { module: this.emptyFragment(), entryPoint: "fs", targets: [] };
                    descriptor.fragment.targets = [{ format: PLACEHOLDER_FORMAT, writeMask: 0 }];
                    descriptor.multisample.count = 1;
                }
                p.descriptor = descriptor;
                p.gpu = await this.device.createRenderPipelineAsync(descriptor);
            } catch (error) {
                p.error = String(error && error.message || error);
                this.warn("pipeline:" + p.error, "a pipeline failed: " + p.error);
            }
        }

        /** a fragment stage that writes nothing */
        emptyFragment() {
            if (!this.emptyFragmentModule) this.emptyFragmentModule = this.device.createShaderModule({ code: "@fragment fn fs() {}" });
            return this.emptyFragmentModule;
        }

        /** the attachment of a pass without any, by its size */
        placeholder(width, height) {
            const key = Math.max(1, width) + "x" + Math.max(1, height);
            if (!this.placeholders) this.placeholders = new Map();
            let view = this.placeholders.get(key);
            if (!view) {
                view = this.device.createTexture({ size: [Math.max(1, width), Math.max(1, height)], format: PLACEHOLDER_FORMAT,
                    usage: TEXTURE.RENDER_ATTACHMENT }).createView();
                this.placeholders.set(key, view);
            }
            return view;
        }

        // ------------------------------------------------------------------
        // Passes

        /** a view of one mip and layer, for an attachment */
        attachmentOf(id) {
            const v = this.objects.get(id);
            if (!v || v.kind !== "view") return null;
            if (!v.attachment) v.attachment = this.view(v.texture.texture, { format: v.f.gpu, dimension: v.texture.volume ? "3d" : "2d",
                baseMipLevel: v.baseMip, mipLevelCount: 1, baseArrayLayer: v.texture.volume ? 0 : v.baseLayer, arrayLayerCount: 1 });
            return v;
        }

        beginPass(d) {
            this.endPasses();
            // (a capture's compute pass ends it, and it begins again: resumePass)
            this.passDesc = d;
            const colorAttachments = d.colors.map(c => {
                if (!c) return null;
                const v = this.attachmentOf(c.view);
                if (!v) return null;
                const f = v.f;
                const value = f.uint ? c.clear.map(x => x >>> 0) : f.sint ? c.clear.map(x => x | 0) : c.clear.map(f32);
                const a = { view: v.attachment, loadOp: c.load === 0 ? "load" : "clear", storeOp: c.store === 1 ? "discard" : "store",
                    clearValue: { r: value[0], g: value[1], b: value[2], a: value[3] } };
                const resolve = c.resolve ? this.attachmentOf(c.resolve) : null;
                if (resolve) a.resolveTarget = resolve.attachment;
                return a;
            });
            const descriptor = { colorAttachments };
            if (!colorAttachments.some(a => a) && !(d.depth && this.attachmentOf(d.depth.view))) {
                // no attachments: the pipelines' placeholder (see createPipeline)
                colorAttachments.splice(0, colorAttachments.length, { view: this.placeholder(d.width, d.height), loadOp: "clear", storeOp: "discard" });
            }
            if (d.depth) {
                const v = this.attachmentOf(d.depth.view);
                if (v) {
                    const ds = { view: v.attachment };
                    if (v.texture.f.hasDepth) Object.assign(ds, { depthLoadOp: d.depth.load === 0 ? "load" : "clear", depthClearValue: d.depth.clear_depth,
                        depthStoreOp: d.depth.store === 1 ? "discard" : "store" });
                    if (v.texture.f.hasStencil) Object.assign(ds, { stencilLoadOp: d.depth.stencil_load === 0 ? "load" : "clear",
                        stencilClearValue: d.depth.clear_stencil, stencilStoreOp: d.depth.stencil_store === 1 ? "discard" : "store" });
                    descriptor.depthStencilAttachment = ds;
                }
            }
            const queries = d.occlusion ? this.objects.get(d.occlusion) : null;
            if (queries && queries.querySet) descriptor.occlusionQuerySet = queries.querySet;
            this.pass = this.encoder().beginRenderPass(descriptor);
            this.activeQuery = -1;
            const first = d.colors.find(c => c) || d.depth;
            const firstView = first && this.objects.get(first.view);
            this.passInfo = { colors: d.colors, depth: d.depth, samples: firstView && firstView.texture ? firstView.texture.samples : 1,
                occlusion: queries && queries.querySet ? d.occlusion : 0 };
            this.state.passWidth = d.width;
            this.state.passHeight = d.height;
            this.state.pipelineApplied = false;
            this.state.vertexDirty = this.state.indexDirty = this.state.dynamicDirty = true;
            this.state.applied = new Map();
        }

        endPass() {
            if (this.pass) { this.pass.end(); this.pass = null; this.resolveQueries(); }
        }

        // ------------------------------------------------------------------
        // Descriptors

        setBindGroup(b) {
            const group = b[0] & 0xFFFF, point = b[0] >>> 16, count = b[1];
            const descriptors = new Map();
            for (let i = 0; i < count; i++) {
                const w = b.subarray(2 + i * 8, 10 + i * 8);
                descriptors.set(w[0] * 1024 + w[1], { type: w[2], rid: w[3], sampler: w[4], offset: w[5] + w[6] * 0x100000000, size: w[7] });
            }
            this.state.groups[point].set(group, { version: ++this.state.groupVersion, descriptors });
        }

        /** the bind group of a pipeline's group from what is bound there */
        bindGroup(p, point, group) {
            const used = p.groups.get(group);
            if (!used) return null;
            const isPush = group === p.push;
            const contents = this.state.groups[point].get(group);
            const key = (contents ? contents.version : 0) + (isPush ? ":" + this.state.pushOffset : "");
            let bg = p.bindGroups.get(group);
            if (bg && bg.key === key) return bg.group;
            const entries = [];
            for (const [binding, kind] of used) {
                if (isPush && binding === PUSH_BINDING) {
                    entries.push({ binding, resource: { buffer: this.pushBuffer, offset: this.state.pushOffset, size: 256 } });
                    continue;
                }
                const d = contents && contents.descriptors.get((binding >> 1) * 1024);
                if (!d) { this.warn("unbound" + group + ":" + binding, "group " + group + " binding " + binding + " has nothing bound"); return null; }
                if (binding & 1 || kind === "sampler" || kind === "sampler-comparison") {
                    const s = this.objects.get(binding & 1 ? d.sampler : d.sampler || d.rid);
                    if (!s || !s.sampler) return null;
                    entries.push({ binding, resource: s.sampler });
                    continue;
                }
                if (kind === "uniform" || kind === "storage" || kind === "storage-rw") {
                    const m = this.memory(d.rid);
                    if (!m) return null;
                    entries.push({ binding, resource: { buffer: m.buffer, offset: d.offset, size: Math.min(d.size, m.buffer.size - d.offset) } });
                    continue;
                }
                const v = this.objects.get(d.rid);
                if (!v || v.kind !== "view") return null;
                entries.push({ binding, resource: kind === "storage-texture" ? this.singleMip(v) : v.view });
            }
            const created = this.device.createBindGroup({ layout: p.gpu.getBindGroupLayout(group), entries });
            p.bindGroups.set(group, { key, group: created });
            return created;
        }

        singleMip(v) {
            if (v.mips === 1) return v.view;
            if (!v.storage) v.storage = v.texture.texture.createView({ format: v.f.gpu, dimension: v.dimension, baseMipLevel: v.baseMip, mipLevelCount: 1,
                baseArrayLayer: v.baseLayer, arrayLayerCount: v.layers });
            return v.storage;
        }

        /**
         * A render pipeline for draws with a viewport of a negative height:
         * Vulkan flips y with it (ANGLE draws GL's frames so), WebGPU's
         * viewports cannot, so the vertex stage keeps Vulkan's clip space
         * instead of flipping into WebGPU's. Made at the first such draw; its
         * own (automatic) layout, so its own bind groups: WebGPU does not let
         * another pipeline use an automatic layout's bind group layouts.
         */
        flippedPipeline(p) {
            if (p.flipped !== undefined) return p.flipped;
            p.flipped = null;
            try {
                const t = this.translateNow(p.vertexSource.shader, p.push, true, p.storage);
                if (t.error) throw new Error("shader: " + t.error);
                const st = this.stageState(t, p.vertexSource.stage);
                const gpu = this.device.createRenderPipeline(Object.assign({}, p.descriptor, {
                    vertex: Object.assign({}, p.descriptor.vertex, { module: st.module, entryPoint: st.entryPoint, constants: st.constants }),
                }));
                p.flipped = { kind: "pipeline", desc: p.desc, groups: p.groups, push: p.push, gpu, bindGroups: new Map(), error: null,
                    descriptor: Object.assign({}, p.descriptor, { vertex: Object.assign({}, p.descriptor.vertex, { module: st.module, entryPoint: st.entryPoint, constants: st.constants }) }) };
            } catch (error) {
                this.warn("flipped:" + error.message, "a pipeline's variant for flipped viewports failed: " + error.message);
            }
            return p.flipped;
        }

        /**
         * A render pipeline with other stencil masks: the dynamic ones
         * (VK_DYNAMIC_STATE_STENCIL_COMPARE_MASK, _WRITE_MASK) of a draw, as
         * WebGPU's are the pipeline's. Made at the first draw with them; its
         * own bind groups (an automatic layout, as flippedPipeline's)
         */
        maskedPipeline(q, read, write) {
            const ds = q.descriptor.depthStencil;
            if ((ds.stencilReadMask & 0xFF) === read && (ds.stencilWriteMask & 0xFF) === write) return q;
            return this.variant(q, "masks:" + read + ":" + write,
                d => Object.assign(d, { depthStencil: Object.assign({}, ds, { stencilReadMask: read, stencilWriteMask: write }) }));
        }

        /**
         * A render pipeline's variant by `key`, its descriptor as `change`
         * makes it of a copy of the pipeline's: made at the first draw that
         * needs it, with its own bind groups (an automatic layout)
         */
        variant(q, key, change) {
            q.variants = q.variants || new Map();
            if (q.variants.has(key)) return q.variants.get(key);
            let v = null;
            try {
                const descriptor = change(Object.assign({}, q.descriptor));
                v = { kind: "pipeline", desc: q.desc, groups: q.groups, push: q.push, descriptor, gpu: this.device.createRenderPipeline(descriptor),
                    bindGroups: new Map(), error: null };
            } catch (error) {
                this.warn("variant:" + error.message, "a pipeline's variant (" + key + ") failed: " + error.message);
            }
            q.variants.set(key, v);
            return v;
        }

        /** An index buffer of triangle fans as lists for fans of up to `n` vertices: Vulkan's (i + 1, i + 2, 0), its provoking vertex first */
        fanIndices(n) {
            if (this.fans && this.fans.vertices >= n) return this.fans.buffer;
            const vertices = Math.max(64, 1 << Math.ceil(Math.log2(n)));
            const indices = new Uint32Array(3 * (vertices - 2));
            for (let i = 0; i < vertices - 2; i++) indices.set([i + 1, i + 2, 0], 3 * i);
            if (this.fans) this.transient.push(this.fans.buffer);
            const buffer = this.device.createBuffer({ size: indices.byteLength, usage: BUFFER.INDEX | BUFFER.COPY_DST });
            this.device.queue.writeBuffer(buffer, 0, indices);
            this.fans = { vertices, buffer };
            return buffer;
        }

        // ------------------------------------------------------------------
        // Draws and dispatches

        draw(b, kind) {
            // (transform feedback: what the draw's vertices capture, before the draw: a pass of its own)
            if (this.state.xfb.active && this.state.graphics && this.state.graphics.gpu) {
                if (kind === 0) this.capture(this.state.graphics, b);
                else this.warn("xfb-indexed", "indexed and indirect draws capture nothing (GL ES 3.0 has none)");
            }
            const p = this.state.graphics, pass = this.pass;
            if (!pass || !p || !p.gpu) {
                if (p && p.error) this.warn("draw-pipeline", "draws with a failed pipeline are skipped");
                return;
            }
            this.stats.draws++;
            const s = this.state;
            // viewport and scissor: the dynamic ones, or the pipeline's; within the target (WebGPU's rule)
            const viewport = p.desc.dynamic.includes(0) && s.viewport ? s.viewport :
                p.desc.viewport ? [p.desc.viewport.x, p.desc.viewport.y, p.desc.viewport.width, p.desc.viewport.height, p.desc.viewport.minDepth, p.desc.viewport.maxDepth] : null;
            let q = viewport && viewport[3] < 0 ? this.flippedPipeline(p) : p;
            if (!q) return;
            // (the dynamic stencil masks, with the stencil test on)
            const dynamicMasks = p.desc.dynamic.includes(6) || p.desc.dynamic.includes(7);
            if (dynamicMasks && !p.desc.discard && q.descriptor && q.descriptor.depthStencil && q.descriptor.depthStencil.stencilFront &&
                q.descriptor.depthStencil.stencilFront.compare) {
                const ds = q.descriptor.depthStencil;
                q = this.maskedPipeline(q, p.desc.dynamic.includes(6) ? s.stencilMasks[0] : ds.stencilReadMask & 0xFF,
                    p.desc.dynamic.includes(7) ? s.stencilMasks[1] : ds.stencilWriteMask & 0xFF);
                if (!q) return;
            }
            // (indexed strips: WebGPU wants the index format in the pipeline)
            const indexed = kind === 1 || kind === 2 && b[5];
            if (indexed && (p.desc.topology === 2 || p.desc.topology === 4) && q.descriptor) {
                const format = s.index && s.index.type === 1 ? "uint32" : "uint16";
                q = this.variant(q, "strip:" + format, d => Object.assign(d, { primitive: Object.assign({}, d.primitive, { stripIndexFormat: format }) }));
                if (!q) return;
            }
            const fan = p.desc.topology === 5;
            if (fan && kind !== 0) {
                this.warn("fan-indexed", "indexed and indirect triangle fans are not done");
                return;
            }
            if (p.desc.push_size && p.groups.has(p.push)) this.pushWrite();
            pass.setPipeline(q.gpu);
            for (const group of p.groups.keys()) {
                const bg = this.bindGroup(q, 0, group);
                if (!bg) return;
                pass.setBindGroup(group, bg);
            }
            for (let slot = 0; slot < 8; slot++) {
                const v = s.vertex[slot], m = v && this.memory(v.memory);
                if (m) pass.setVertexBuffer(slot, m.buffer, v.offset, Math.min(v.size, m.buffer.size - v.offset));
            }
            if (viewport) {
                let [x, y, w, h, near, far] = viewport;
                // (flipped by the pipeline's variant: the rows it covers)
                if (h < 0) { y += h; h = -h; }
                const x0 = Math.max(0, x), y0 = Math.max(0, y);
                const x1 = Math.min(s.passWidth, x + w), y1 = Math.min(s.passHeight, y + h);
                if (x1 > x0 && y1 > y0) pass.setViewport(x0, y0, x1 - x0, y1 - y0, Math.max(0, Math.min(1, near)), Math.max(0, Math.min(1, far)));
            }
            const scissor = p.desc.dynamic.includes(1) && s.scissor ? s.scissor :
                p.desc.scissor ? [p.desc.scissor.offset.x, p.desc.scissor.offset.y, p.desc.scissor.extent.width, p.desc.scissor.extent.height] : null;
            if (scissor) {
                const x0 = Math.max(0, scissor[0]), y0 = Math.max(0, scissor[1]);
                const x1 = Math.min(s.passWidth, scissor[0] + scissor[2]), y1 = Math.min(s.passHeight, scissor[1] + scissor[3]);
                pass.setScissorRect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
            }
            const blend = p.desc.dynamic.includes(4) && s.blend ? s.blend : p.desc.blend_constants;
            pass.setBlendConstant({ r: blend[0], g: blend[1], b: blend[2], a: blend[3] });
            pass.setStencilReference(p.desc.dynamic.includes(8) ? s.stencilReference : p.desc.depth && p.desc.depth.front ? p.desc.depth.front.reference : 0);
            if (kind === 1 || kind === 2 && b[5]) {
                const ib = s.index, m = ib && this.memory(ib.memory);
                if (!m) return;
                pass.setIndexBuffer(m.buffer, ib.type === 1 ? "uint32" : "uint16", ib.offset, Math.min(ib.size, m.buffer.size - ib.offset));
            }
            if (kind === 0 && fan) {
                if (b[0] < 3) return;
                pass.setIndexBuffer(this.fanIndices(b[0]), "uint32");
                pass.drawIndexed(3 * (b[0] - 2), b[1], 0, b[2], b[3]);
            }
            else if (kind === 0) pass.draw(b[0], b[1], b[2], b[3]);
            else if (kind === 1) pass.drawIndexed(b[0], b[1], b[2], b[3] | 0, b[4]);
            else {
                const m = this.memory(b[0]);
                if (!m) return;
                const offset = b[1] + b[2] * 0x100000000;
                for (let i = 0; i < b[3]; i++) {
                    if (b[5]) pass.drawIndexedIndirect(m.buffer, offset + i * b[4]);
                    else pass.drawIndirect(m.buffer, offset + i * b[4]);
                }
            }
        }

        // ------------------------------------------------------------------
        // Transform feedback (VK_EXT_transform_feedback): WebGPU's vertex
        // stage cannot write storage buffers, so a draw that captures runs
        // its vertex shader as a compute shader first (vx/naga/src/xfb.rs),
        // in a compute pass between two halves of the render pass, into
        // scratch buffers copied where the transform feedback buffers are
        // (a vertex buffer and a capture buffer may be one memory, which a
        // dispatch cannot have as storage both read and written). The
        // primitives that fit are counted here (GL ES 3.0 captures draws of
        // lists, not indexed nor indirect): so are the counters and queries.

        /** XFB_BEGIN (`begin`) or XFB_END: the bytes captured from each counter (End: into it) */
        xfbBegin(b, begin) {
            const x = this.state.xfb, first = b[0], count = b[1];
            if (begin) { x.active = true; x.written = [0, 0, 0, 0]; }
            for (let i = 0; i < count; i++) {
                const rid = b[2 + 3 * i], offset = b[3 + 3 * i] + b[4 + 3 * i] * 0x100000000, slot = first + i;
                if (!rid || slot > 3) continue;
                const key = rid + ":" + offset;
                if (begin) { x.written[slot] = this.xfbCounters.get(key) || 0; continue; }
                this.xfbCounters.set(key, x.written[slot]);
                const m = this.memory(rid);
                if (m && offset + 4 <= m.buffer.size) this.device.queue.writeBuffer(m.buffer, offset, new Uint32Array([x.written[slot]]));
            }
            if (!begin) x.active = false;
        }

        /** a capturing draw's compute pipeline (made at its first draw), or null */
        xfbPipeline(p) {
            if (p.xfb !== undefined) return p.xfb;
            p.xfb = null;
            try {
                const vs = p.vertexSource, d = p.desc;
                // (its own resources in a group the vertex shader does not use)
                const group = [0, 1, 2, 3].find(g => !p.groups.has(g));
                if (group === undefined) throw new Error("the vertex shader uses every bind group");
                const words = [group, d.attributes.length];
                for (const a of d.attributes) words.push(a.location, a.binding, a.format, a.offset);
                words.push(d.buffers.length);
                for (const v of d.buffers) words.push(v.binding, v.stride, v.rate ? 1 : 0);
                const t = this.translateXfb(vs.shader, p.push, p.storage, words);
                if (t.error) throw new Error(t.error);
                const st = this.stageState(t, vs.stage);
                const module = this.device.createShaderModule({ code: "diagnostic(off, derivative_uniformity);\n" + t.wgsl });
                const gpu = this.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "vx_xfb", constants: st.constants } });
                const groups = new Map();
                for (const [g, binding, kind] of st.entry ? st.entry.bindings : []) {
                    if (!groups.has(g)) groups.set(g, new Map());
                    groups.get(g).set(binding, kind);
                }
                p.xfb = { kind: "pipeline", gpu, groups, push: p.push, bindGroups: new Map(), group, strides: t.xfb.strides, buffers: t.xfb.buffers,
                    slots: t.xfb.slots };
            } catch (error) {
                this.warn("xfb:" + error.message, "a capturing draw's compute shader failed: " + error.message);
            }
            return p.xfb;
        }

        /** The vertices of draw `b` (vertices, instances, first vertex, first instance) captured */
        capture(p, b) {
            const x = this.state.xfb;
            const vertices = LIST_VERTICES[p.desc.topology];
            if (!vertices) { this.warn("xfb-topology", "captures of strips and fans are not done (GL ES 3.0 captures lists)"); return; }
            const c = this.xfbPipeline(p);
            if (!c) return;
            const [count, instances, firstVertex, firstInstance] = b;
            const primitives = Math.floor(count / vertices), needed = primitives * instances;
            // the primitives that fit in every buffer the shader captures into
            let fit = needed;
            for (const buffer of c.buffers) {
                const bound = x.buffers[buffer], stride = c.strides[buffer];
                if (!bound || !stride) { fit = 0; break; }
                fit = Math.min(fit, Math.max(0, Math.floor((bound.size - x.written[buffer]) / (stride * vertices))));
            }
            if (this.xfbQuery) { this.xfbQuery.written += fit; this.xfbQuery.needed += needed; }
            const limit = fit * vertices;
            if (!limit) return;
            this.stats.captures = (this.stats.captures || 0) + 1;
            if (p.desc.push_size && p.groups.has(p.push)) this.pushWrite();
            const groups = [];
            for (const group of c.groups.keys()) {
                const bg = this.bindGroup(c, 0, group);
                if (!bg) return;
                groups.push([group, bg]);
            }
            // the parameters (VxXfbParams), the vertex buffers' memories, the scratch buffers
            const params = new Uint32Array(20);
            params.set([firstVertex, primitives * vertices, firstInstance, instances, 0, limit]);
            const entries = [];
            for (const slot of c.slots) {
                const v = this.state.vertex[slot], m = v && this.memory(v.memory);
                if (!m) { this.warn("xfb-vertex", "a capture without its vertex buffer"); return; }
                params[12 + slot] = v.offset;
                entries.push({ binding: 961 + slot, resource: { buffer: m.buffer } });
            }
            const uniform = this.device.createBuffer({ size: params.byteLength, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
            this.transient.push(uniform);
            this.device.queue.writeBuffer(uniform, 0, params);
            entries.push({ binding: 960, resource: { buffer: uniform } });
            const scratch = [];
            for (const buffer of c.buffers) {
                const bytes = limit * c.strides[buffer];
                const s = this.scratch(bytes, BUFFER.STORAGE | BUFFER.COPY_SRC);
                scratch.push([buffer, s, bytes]);
                entries.push({ binding: 970 + buffer, resource: { buffer: s } });
            }
            groups.push([c.group, this.device.createBindGroup({ layout: c.gpu.getBindGroupLayout(c.group), entries })]);
            // between the halves of the render pass
            const resume = !!this.pass;
            this.endPasses();
            const encoder = this.encoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(c.gpu);
            for (const [group, bg] of groups) pass.setBindGroup(group, bg);
            pass.dispatchWorkgroups(Math.ceil(limit / 64));
            pass.end();
            for (const [buffer, s, bytes] of scratch) {
                const bound = x.buffers[buffer], m = this.memory(bound.memory);
                if (m) encoder.copyBufferToBuffer(s, 0, m.buffer, bound.offset + x.written[buffer], Math.min(bytes, m.buffer.size - bound.offset - x.written[buffer]));
                x.written[buffer] += bytes;
            }
            if (resume) this.resumePass();
        }

        /** The render pass again after a capture's compute pass: as it was begun, its attachments loaded */
        resumePass() {
            const d = JSON.parse(JSON.stringify(this.passDesc));
            for (const c of d.colors) if (c) { if (c.store === 1) this.warn("xfb-discard", "a capture in a pass whose attachments it discards"); c.load = 0; }
            if (d.depth) { d.depth.load = 0; d.depth.stencil_load = 0; }
            // (its occlusion queries go on in no pass: an occlusion query across a capture counts its first half)
            d.occlusion = 0;
            const pipeline = this.state.graphics;
            this.beginPass(d);
            this.state.graphics = pipeline;
        }

        /** The compute shader of a capturing draw (vx_translate_xfb), naga loaded */
        translateXfb(shader, push, storage, words) {
            const naga = this.naga;
            const input = naga.vx_alloc(shader.spirv.length);
            new Uint8Array(naga.memory.buffer, input, shader.spirv.length).set(shader.spirv);
            const list = storage.length ? naga.vx_alloc(storage.length * 4) : 0;
            if (list) new Uint32Array(naga.memory.buffer, list, storage.length).set(storage);
            const desc = naga.vx_alloc(words.length * 4);
            new Uint32Array(naga.memory.buffer, desc, words.length).set(words);
            let out;
            try {
                out = naga.vx_translate_xfb(input, shader.spirv.length, push, PUSH_BINDING, list, storage.length, desc, words.length);
            } catch (error) {
                this.naga = null;
                throw error;
            }
            naga.vx_free(input, shader.spirv.length);
            if (list) naga.vx_free(list, storage.length * 4);
            naga.vx_free(desc, words.length * 4);
            const length = new DataView(naga.memory.buffer).getUint32(out, true);
            const text = new TextDecoder().decode(new Uint8Array(naga.memory.buffer, out + 4, length));
            naga.vx_free(out, length + 4);
            return JSON.parse(text);
        }

        /** push constants into the push buffer, before the pass they are for (a copy is not in a pass) */
        pushWrite() {
            const s = this.state;
            if (s.pushWritten === s.pushVersion && this.pushBuffer) return;
            if (!this.pushBuffer || this.pushUsed + 256 > this.pushBuffer.size) {
                this.pushBuffer = this.device.createBuffer({ size: 256 * 256, usage: BUFFER.STORAGE | BUFFER.COPY_DST });
                this.pushUsed = 0;
            }
            s.pushOffset = this.pushUsed;
            this.pushUsed += 256;
            // (queue writes go before the encoder's work: each place is written once, before the submit that reads it)
            this.device.queue.writeBuffer(this.pushBuffer, s.pushOffset, s.push);
            s.pushWritten = s.pushVersion;
        }

        dispatch(b, indirect) {
            const p = this.state.compute;
            if (!p || !p.gpu) return;
            this.stats.dispatches++;
            if (p.desc.push_size && p.groups.has(p.push)) this.pushWrite();
            this.endPass();
            if (!this.computePass) {
                const encoder = this.encoder();
                this.computePass = encoder.beginComputePass();
            }
            const pass = this.computePass;
            pass.setPipeline(p.gpu);
            for (const group of p.groups.keys()) {
                const bg = this.bindGroup(p, 1, group);
                if (!bg) return;
                pass.setBindGroup(group, bg);
            }
            if (indirect) {
                const m = this.memory(b[0]);
                if (m) pass.dispatchWorkgroupsIndirect(m.buffer, b[1] + b[2] * 0x100000000);
            } else pass.dispatchWorkgroups(b[0], b[1], b[2]);
        }

        /**
         * vkCmdClearAttachments: in the render pass, a draw over each rectangle
         * writing the value into the one attachment (the others masked)
         */
        clearAttachments(d) {
            const pass = this.pass, info = this.passInfo;
            if (!pass || !info) return;
            const colors = info.colors.map(c => c && this.format(c.format));
            const depthFormat = info.depth ? this.format(info.depth.format) : null;
            for (const a of d.attachments) {
                const color = a.aspect & ASPECT.COLOR;
                if (color && !colors[a.index]) continue;
                const key = "clear:" + colors.map(f => f ? f.gpu : "-").join(",") + ":" + (depthFormat ? depthFormat.gpu : "") + ":" +
                    info.samples + ":" + (color ? "c" + a.index : "d" + (a.aspect & (ASPECT.DEPTH | ASPECT.STENCIL)));
                let p = this.pipelines.get(key);
                if (!p) {
                    const type = f => f.uint ? "u32" : f.sint ? "i32" : "f32";
                    const outputs = colors.map((f, i) => f ? "@location(" + i + ") c" + i + ": vec4<" + type(f) + ">" : null).filter(x => x);
                    const values = colors.map((f, i) => !f ? null : "c" + i + " = " + (i === a.index ?
                        (f.uint ? "value.bits" : f.sint ? "bitcast<vec4<i32>>(value.bits)" : "bitcast<vec4<f32>>(value.bits)") : "vec4<" + type(f) + ">()") + ";").filter(x => x);
                    const code = [
                        "struct Value { bits: vec4<u32>, depth: f32 };",
                        "@group(0) @binding(0) var<uniform> value: Value;",
                        "struct Out { " + outputs.concat(color ? [] : ["@builtin(frag_depth) depth: f32"]).join(", ") + " };",
                        "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {",
                        "    let corner = vec2f(f32(i & 1u), f32(i >> 1u));",
                        "    return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);",
                        "}",
                        "@fragment fn fs() -> Out {",
                        "    var out: Out;",
                        ...values.map(v => "    out." + v),
                        color ? "" : "    out.depth = value.depth;",
                        "    return out;",
                        "}",
                    ].join("\n");
                    const module = this.device.createShaderModule({ code });
                    const descriptor = {
                        layout: "auto",
                        vertex: { module, entryPoint: "vs" },
                        fragment: { module, entryPoint: "fs", targets: colors.map((f, i) => f ? { format: f.gpu, writeMask: color && i === a.index ? 0xF : 0 } : null) },
                        primitive: { topology: "triangle-strip" },
                        multisample: { count: info.samples > 1 ? 4 : 1 },
                    };
                    if (depthFormat) {
                        const depthToo = !color && a.aspect & ASPECT.DEPTH, stencilToo = !color && a.aspect & ASPECT.STENCIL;
                        descriptor.depthStencil = { format: depthFormat.gpu, depthWriteEnabled: !!depthToo, depthCompare: "always" };
                        if (depthFormat.hasStencil) {
                            const face = { compare: "always", passOp: stencilToo ? "replace" : "keep", failOp: "keep", depthFailOp: "keep" };
                            Object.assign(descriptor.depthStencil, { stencilFront: face, stencilBack: face, stencilWriteMask: stencilToo ? 0xFF : 0 });
                        }
                    }
                    p = this.device.createRenderPipeline(descriptor);
                    this.pipelines.set(key, p);
                }
                const bytes = new Uint32Array(8);
                bytes.set(a.clear.slice(0, 4));
                if (!color) {
                    new Float32Array(bytes.buffer, 16, 1)[0] = f32(a.clear[0]);
                }
                const ubo = this.device.createBuffer({ size: 32, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
                this.device.queue.writeBuffer(ubo, 0, bytes);
                this.transient.push(ubo);
                const group = this.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }] });
                pass.setPipeline(p);
                pass.setBindGroup(0, group);
                if (!color && a.aspect & ASPECT.STENCIL) pass.setStencilReference(a.clear[1]);
                for (const r of d.rects) {
                    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
                    const x1 = Math.min(this.state.passWidth, r.x + r.width), y1 = Math.min(this.state.passHeight, r.y + r.height);
                    if (x1 <= x0 || y1 <= y0) continue;
                    pass.setViewport(x0, y0, x1 - x0, y1 - y0, 0, 1);
                    pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
                    pass.draw(4);
                }
            }
        }
    }

    const api = { VXExecutor, VX, VX_MAGIC };
    if (typeof module === "object" && module.exports) module.exports = api;
    else global.V86VXExecutor = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
