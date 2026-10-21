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
        SET_DEPTH_BIAS: 49,
    };
    // VK_QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM_EXT; VkPrimitiveTopology's vertices a primitive (lists only)
    const QUERY_XFB = 1000028004;
    const LIST_VERTICES = { 0: 1, 1: 2, 3: 3 };
    // where the bundle is: naga's wasm is beside it
    const SCRIPT = typeof document !== "undefined" && document.currentScript ? document.currentScript.src : null;
    // Vulkan's enums, as WebGPU's
    const TOPOLOGY = ["point-list", "line-list", "line-strip", "triangle-list", "triangle-strip", null];
    // WGSL's bindings of a Vulkan binding b (vx/naga's rebind): 2b, 2b + 1 for
    // a combined image sampler's sampler; for element e > 0 of a descriptor
    // array (vx/naga/src/blockarrays.rs) ELEMENTS + 2 (16b + e), and one more
    // for its sampler (below 960: xfb.rs binds from there)
    const ELEMENTS = 300, ELEMENTS_END = 960;
    /** vx_naga's translation flags */
    const TRANSLATE = { KEEP: 1, NO_DEPTH: 2, REVERSE_DEPTH: 4 };
    /** The descriptor (binding * 1024 + element) a WGSL binding is of */
    const descriptorKey = binding => binding >= ELEMENTS && binding < ELEMENTS_END ?
        ((binding - ELEMENTS) >> 5) * 1024 + ((binding - ELEMENTS) >> 1 & 15) : (binding >> 1) * 1024;
    const samplerBinding = binding => (binding & 1) === 1;
    /** A render pass's or pipeline's attachments, as WebGPU compares them (trailing empty colors aside) */
    const attachmentState = (colors, depth, samples) => {
        const c = colors.map(f => f || "-");
        while (c.length && c[c.length - 1] === "-") c.pop();
        return c.join(",") + "|" + (depth || "") + "|" + samples;
    };
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
    /** The bytes of a WebGPU vertex format ("float32x3": 12, "unorm10-10-10-2": 4) */
    const vertexFormatBytes = format => {
        const m = /^[a-z]+(8|16|32)(?:x([234]))?$/.exec(format);
        return m ? +m[1] / 8 * (+m[2] || 1) : 4;
    };
    /**
     * How a view bound as `kind` is sampled through a copy (VX.swizzleCopies),
     * the view's field holding it: "depthRead" for a depth view bound as a float
     * texture, "swizzled" for a swizzled color view; null: the view itself
     */
    const copyMode = (v, kind) => {
        if (kind === "texture" && v.f.hasDepth && v.descriptor.aspect !== "stencil-only" && v.texture.samples <= 1) return "depthRead";
        if (v.swizzle && !v.f.depth && v.texture.samples <= 1 && kind !== "storage-texture") return "swizzled";
        return null;
    };
    /** VK_FORMAT_R5G6B5_UNORM_PACK16: an rgba8unorm texture whose alpha stays 1 (draws and clears leave it) */
    const R5G6B5 = 4;
    /** The color write mask a format's target takes: no alpha into R5G6B5 */
    const alphaMask = f => f && f.packed === R5G6B5 ? 0x7 : 0xF;
    /** The most vertices a draw's packed vertex input has (VX.packVertices) */
    const PACKED_ROWS = 1 << 20;
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
            /** a pipeline's buffers' least binding sizes (group << 16 | binding), by its groups (which its variants share) */
            this.bindingSizes = new WeakMap();
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
                viewport: null, scissor: null, blend: null, stencilReference: 0, stencilMasks: [0xFF, 0xFF], stencilBack: [0xFF, 0xFF, 0], dynamicDirty: true,
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
                case VX.END_PASS: {
                    this.endPass();
                    // (the depth and stencil resolved, VK_KHR_depth_stencil_resolve's sample zero)
                    const depth = this.passDesc && this.passDesc.depth;
                    if (depth && depth.resolve) this.resolveDepthStencil(depth);
                    return;
                }
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
                case VX.SET_STENCIL_REFERENCE:
                    if (b[0] & 1) this.state.stencilReference = b[1];
                    if (b[0] & 2) this.state.stencilBack[2] = b[1];
                    this.state.dynamicDirty = true;
                    return;
                // (the front face's: WebGPU has one pair for both faces)
                // (the back face's: stencilBack, compare and write masks and reference)
                case VX.SET_STENCIL_COMPARE_MASK:
                    if (b[0] & 1) this.state.stencilMasks[0] = b[1] & 0xFF;
                    if (b[0] & 2) this.state.stencilBack[0] = b[1] & 0xFF;
                    return;
                case VX.SET_STENCIL_WRITE_MASK:
                    if (b[0] & 1) this.state.stencilMasks[1] = b[1] & 0xFF;
                    if (b[0] & 2) this.state.stencilBack[1] = b[1] & 0xFF;
                    return;
                case VX.SET_DEPTH_BIAS: this.state.depthBias = Array.from(b.subarray(0, 3), f32); return;
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
            this.endPass();
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
                this.copyBytes(src.buffer, from, dst.buffer, to, size);
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

        /**
         * A copy of bytes not in whole dwords (Vulkan's copies have no
         * alignment, WebGPU's are of dwords): repack's, one row
         */
        copyBytes(src, from, dst, to, size) {
            if (size) this.repack(src, { offset: from, pitch: size, image: size }, dst, { offset: to, pitch: size, image: size }, size, 1, 1);
        }

        /**
         * Rows of bytes from one buffer layout to another, neither in whole
         * dwords: a compute shader writes each destination dword, the
         * source's bytes merged into it (the bytes between the rows kept).
         * Layouts: { offset, pitch (a row's), image (a slice's) }; a repack
         * within one buffer goes through a scratch buffer first
         */
        repack(src, from, dst, to, rowBytes, rows, slices) {
            const last = (l) => l.offset + (slices - 1) * l.image + (rows - 1) * l.pitch + rowBytes;
            if (src === dst) {
                const start = from.offset & ~3, length = align(last(from) - start, 4);
                const between = this.scratch(length, BUFFER.COPY_SRC | BUFFER.COPY_DST | BUFFER.STORAGE);
                this.encoder().copyBufferToBuffer(src, start, between, 0, length);
                src = between;
                from = Object.assign({}, from, { offset: from.offset - start });
            }
            if (!this.repacker) {
                const code = [
                    "struct P { src: u32, src_pitch: u32, src_image: u32, dst: u32, dst_pitch: u32, dst_image: u32, row: u32, rows: u32, slices: u32, end: u32 };",
                    "@group(0) @binding(0) var<uniform> p: P;",
                    "@group(0) @binding(1) var<storage, read> s: array<u32>;",
                    "@group(0) @binding(2) var<storage, read_write> d: array<u32>;",
                    "@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {",
                    "    let w = (p.dst >> 2u) + id.x;",
                    "    if (w * 4u >= p.end) { return; }",
                    "    var word = d[w];",
                    "    for (var k = 0u; k < 4u; k++) {",
                    "        let at = w * 4u + k;",
                    "        if (at < p.dst || at >= p.end) { continue; }",
                    "        let rel = at - p.dst;",
                    "        let slice = rel / p.dst_image;",
                    "        let row = (rel % p.dst_image) / p.dst_pitch;",
                    "        let column = (rel % p.dst_image) % p.dst_pitch;",
                    "        if (slice >= p.slices || row >= p.rows || column >= p.row) { continue; }",
                    "        let i = p.src + slice * p.src_image + row * p.src_pitch + column;",
                    "        let b = (s[i >> 2u] >> ((i & 3u) * 8u)) & 0xFFu;",
                    "        word = (word & ~(0xFFu << (k * 8u))) | (b << (k * 8u));",
                    "    }",
                    "    d[w] = word;",
                    "}",
                ].join("\n");
                this.repacker = this.device.createComputePipeline({ layout: "auto", compute: { module: this.device.createShaderModule({ code }), entryPoint: "main" } });
            }
            const end = last(to);
            const params = this.device.createBuffer({ size: 48, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
            this.device.queue.writeBuffer(params, 0, Uint32Array.from([from.offset, from.pitch, from.image, to.offset, to.pitch, to.image, rowBytes, rows, slices, end, 0, 0]));
            this.transient.push(params);
            const group = this.device.createBindGroup({ layout: this.repacker.getBindGroupLayout(0), entries: [
                { binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: src } }, { binding: 2, resource: { buffer: dst } }] });
            const pass = this.encoder().beginComputePass();
            pass.setPipeline(this.repacker);
            pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(Math.ceil((((end + 3) >> 2) - (to.offset >> 2)) / 64));
            pass.end();
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
            const [wanted, caps, , bytes] = entry;
            // (an optional format the device has not got: the nearest it has)
            const gpu = wanted === "depth32float-stencil8" && this.device && !this.device.features.has(wanted) ? "depth24plus-stencil8" : wanted;
            return { gpu, bytes, caps, float: /[fx]/.test(caps), int: caps.includes("i"), depth: caps.includes("d"), packed: caps.includes("p") ? vk : 0,
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
                v.attachment = v.storage = v.faces = v.swizzled = v.depthRead = null;
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
            const [id, tid, type, vkformat, aspect, baseMip, mips, baseLayer, layers, ...components] = b;
            const t = this.texture(tid);
            if (!t) return;
            const f = this.format(vkformat) || t.f;
            const dimension = t.volume ? "3d" : VIEW_DIMENSION[type] || "2d";
            const only = aspect === ASPECT.DEPTH && t.f.hasStencil ? "depth-only" : aspect === ASPECT.STENCIL && t.f.hasDepth ? "stencil-only" : "all";
            const descriptor = {
                // (a view of one aspect has that aspect's format: depth24plus of depth24plus-stencil8, stencil8)
                format: only === "depth-only" ? f.gpu.replace(/-stencil8$/, "") : only === "stencil-only" ? "stencil8" : f.gpu, dimension,
                aspect: only,
                baseMipLevel: baseMip, mipLevelCount: mips,
                baseArrayLayer: t.volume ? 0 : baseLayer, arrayLayerCount: t.volume ? 1 : layers,
            };
            const view = this.view(t.texture, Object.assign({}, descriptor));
            // the view's swizzle (VkComponentMapping: identity 0, zero 1, one 2, r..a 3..6) as
            // codes 0 zero, 1 one, 2..5 r..a; none when it is the identity
            const codes = [0, 1, 2, 3].map(i => components[i] === 0 || components[i] === undefined ? i + 2 : components[i] - 1);
            const swizzle = codes.join() === "2,3,4,5" ? null : codes;
            this.objects.set(id, { kind: "view", view, descriptor, texture: t, f, aspect, baseMip, mips, baseLayer, layers, dimension, swizzle });
        }

        /** A write into a texture (a copy, a clear, a pass's attachment, a storage binding): its swizzled copies are old */
        touch(texture) {
            if (texture) texture.vxGeneration = (texture.vxGeneration || 0) + 1;
        }

        /**
         * The views a pipeline samples that WebGPU cannot bind as they are,
         * through copies: a view with a swizzle (WebGPU's views have none;
         * ANGLE's GL_ALPHA, GL_LUMINANCE and GL ES 3.0's texture swizzles are
         * VkComponentMappings), and a depth view sampled as a float texture
         * (GL's sampler2D of a depth texture; WebGPU binds depth as depth or
         * unfilterable float only): each one's copy made again where its
         * texture was written since (a pass of its own per mip and layer),
         * outside of any pass; true when one was
         */
        swizzleCopies(p, point) {
            const stale = [];
            for (const [group, used] of p.groups) {
                const contents = this.state.groups[point].get(group);
                if (!contents) continue;
                for (const [binding, kind] of used) {
                    if (group === p.push && binding === PUSH_BINDING || samplerBinding(binding) || !/^texture/.test(kind) || kind === "storage-texture") continue;
                    const d = contents.descriptors.get(descriptorKey(binding));
                    const v = d && this.objects.get(d.rid);
                    if (!v || v.kind !== "view") continue;
                    const mode = copyMode(v, kind);
                    if (!mode) {
                        if (v.swizzle && (v.f.depth || v.texture.samples > 1)) this.warn("swizzle-kind", "swizzles of depth, stencil and multisampled views are not done");
                        continue;
                    }
                    const generation = v.texture.borrowed ? NaN : v.texture.texture.vxGeneration || 0;
                    if (!v[mode] || v[mode].generation !== generation) stale.push([v, generation, mode]);
                }
            }
            if (!stale.length) return false;
            const resume = !!this.pass;
            this.endPass();
            for (const [v, generation, mode] of stale) this.swizzleCopy(v, generation, mode);
            if (resume) this.resumePass();
            return true;
        }

        /** a view's copy (`mode`: copyMode's), drawn again: v[mode].view is the one bound */
        swizzleCopy(v, generation, mode) {
            const t = v.texture, f = v.f, depth = mode === "depthRead";
            const type = f.uint ? "u32" : f.sint ? "i32" : "f32";
            // (a copy of four components, of the view's kind and at least its precision; depth's in its
            // red, 32-bit where the device filters them)
            const view = v.descriptor.format, wide = this.device.features.has("float32-filterable");
            const format = depth ? (v.swizzle ? "rgba" : "r") + (wide ? "32float" : "16float") : f.uint ? "rgba32uint" : f.sint ? "rgba32sint" :
                /^(r|rg|rgba|bgra)8unorm-srgb$/.test(view) ? "rgba8unorm-srgb" : /^(r|rg|rgba|bgra)8unorm$/.test(view) ? "rgba8unorm" :
                /32float/.test(view) ? "rgba32float" : "rgba16float";
            if (depth && !wide) this.warn("depth-read16", "depth read as a float texture at 16 bits (the device filters no 32-bit floats)");
            const volume = t.volume, slices = m => volume ? Math.max(1, t.depth >> (v.baseMip + m)) : v.layers;
            if (!v[mode] || !v[mode].texture) {
                const texture = this.device.createTexture({ size: [Math.max(1, t.width >> v.baseMip), Math.max(1, Math.max(1, t.height) >> v.baseMip),
                    volume ? Math.max(1, t.depth >> v.baseMip) : v.layers], dimension: volume ? "3d" : "2d", format, mipLevelCount: v.mips,
                    usage: TEXTURE.TEXTURE_BINDING | TEXTURE.RENDER_ATTACHMENT });
                v[mode] = { texture, view: texture.createView({ dimension: v.dimension, format }) };
                // (bind groups made before bound the view itself)
                this.swizzleEpoch = (this.swizzleEpoch || 0) + 1;
            }
            const key = "swizzle:" + format + ":" + type + (volume ? ":3d" : "") + (depth ? ":depth" : "");
            let pipeline = this.pipelines.get(key);
            if (!pipeline) {
                const texel = depth ? "    let c = vec4f(textureLoad(source, vec2i(at.xy), i32(s.layer), i32(s.mip)), 0.0, 0.0, 1.0);" :
                    volume ? "    let c = textureLoad(source, vec3i(vec2i(at.xy), i32(s.layer)), i32(s.mip));" :
                        "    let c = textureLoad(source, vec2i(at.xy), i32(s.layer), i32(s.mip));";
                const code = [
                    "struct S { swizzle: vec4u, mip: u32, layer: u32 };",
                    "@group(0) @binding(0) var<uniform> s: S;",
                    "@group(0) @binding(1) var source: " + (depth ? "texture_depth_2d_array;" : (volume ? "texture_3d<" : "texture_2d_array<") + type + ">;"),
                    "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {",
                    "    return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);",
                    "}",
                    "fn pick(c: vec4<" + type + ">, k: u32) -> " + type + " {",
                    "    switch k { case 0u: { return " + type + "(0); } case 1u: { return " + type + "(1); } case 2u: { return c.x; }",
                    "        case 3u: { return c.y; } case 4u: { return c.z; } default: { return c.w; } }",
                    "}",
                    "@fragment fn fs(@builtin(position) at: vec4f) -> @location(0) vec4<" + type + "> {",
                    texel,
                    "    return vec4<" + type + ">(pick(c, s.swizzle.x), pick(c, s.swizzle.y), pick(c, s.swizzle.z), pick(c, s.swizzle.w));",
                    "}",
                ].join("\n");
                const module = this.device.createShaderModule({ code });
                pipeline = this.device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" },
                    fragment: { module, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } });
                this.pipelines.set(key, pipeline);
            }
            const source = depth ? t.texture.createView({ dimension: "2d-array", aspect: "depth-only", format: v.descriptor.format }) :
                t.texture.createView({ dimension: volume ? "3d" : "2d-array", format: v.descriptor.format });
            const encoder = this.encoder();
            for (let m = 0; m < v.mips; m++) {
                for (let l = 0; l < slices(m); l++) {
                    const ubo = this.device.createBuffer({ size: 32, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
                    this.device.queue.writeBuffer(ubo, 0, Uint32Array.from([...v.swizzle || [2, 3, 4, 5], v.baseMip + m, volume ? l : v.baseLayer + l, 0, 0]));
                    this.transient.push(ubo);
                    const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
                        { binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: source }] });
                    const target = { view: v[mode].texture.createView({ dimension: volume ? "3d" : "2d", baseMipLevel: m, mipLevelCount: 1,
                        baseArrayLayer: volume ? 0 : l, arrayLayerCount: 1 }), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] };
                    if (volume) target.depthSlice = l;
                    const pass = encoder.beginRenderPass({ colorAttachments: [target] });
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, group);
                    pass.draw(3);
                    pass.end();
                }
            }
            v[mode].generation = generation;
            this.stats.swizzleCopies = (this.stats.swizzleCopies || 0) + 1;
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
            // (its address modes, for integer images' samples: vx_naga's int_wraps)
            this.objects.set(id, { kind: "sampler", sampler: this.device.createSampler(descriptor), wrap: (u & 15) | (v & 15) << 4 | (w & 15) << 8 });
        }

        /** The aspect a copy names, and the bytes of its texels */
        copyAspect(t, aspect) {
            if (aspect === ASPECT.STENCIL) return { aspect: "stencil-only", bytes: 1, gpu: 1 };
            if (aspect === ASPECT.DEPTH) {
                if (t.f.gpu === "depth24plus" || t.f.gpu === "depth24plus-stencil8") return null;
                const bytes = t.f.gpu === "depth16unorm" ? 2 : 4;
                return { aspect: t.f.hasStencil ? "depth-only" : "all", bytes, gpu: bytes };
            }
            // (16-bit packed texels: the texture's are rgba8unorm, `gpu` bytes)
            return { aspect: "all", bytes: t.f.bytes, gpu: t.f.packed ? 4 : t.f.bytes };
        }

        /**
         * Depth from a memory (4 bytes a texel: a float, or 24-bit depth in
         * the low bits) into an image, which WebGPU copies only into
         * depth16unorm: a draw over the region writing frag_depth, a layer at
         * a time; and 24-bit depth out of an image, which WebGPU copies out of
         * no buffer: a dispatch reading it into the memory
         */
        depthByShader(toImage, m, guest, t, mip, layer, layers, x, y, w, h) {
            const d24 = /^depth24/.test(t.f.gpu) ? 1 : 0;
            const key = "depth-" + (toImage ? "up:" + t.f.gpu : "down");
            let pipeline = this.pipelines.get(key);
            if (!pipeline) {
                const common = [
                    "struct P { offset: u32, pitch: u32, x: u32, y: u32, w: u32, h: u32, d24: u32, layer: u32 };",
                    "@group(0) @binding(0) var<uniform> p: P;",
                ];
                const code = toImage ? [...common,
                    "@group(0) @binding(1) var<storage, read> src: array<u32>;",
                    "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {",
                    "    return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);",
                    "}",
                    "@fragment fn fs(@builtin(position) at: vec4f) -> @builtin(frag_depth) f32 {",
                    "    let word = src[(p.offset + (u32(at.y) - p.y) * p.pitch + (u32(at.x) - p.x) * 4u) >> 2u];",
                    "    return select(bitcast<f32>(word), f32(word & 0xFFFFFFu) / 16777215.0, p.d24 == 1u);",
                    "}",
                ] : [...common,
                    "@group(0) @binding(1) var source: texture_depth_2d_array;",
                    "@group(0) @binding(2) var<storage, read_write> dst: array<u32>;",
                    "@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3<u32>) {",
                    "    if (id.x >= p.w || id.y >= p.h) { return; }",
                    "    let depth = textureLoad(source, vec2u(p.x + id.x, p.y + id.y), p.layer, 0);",
                    "    dst[(p.offset + id.y * p.pitch + id.x * 4u) >> 2u] = u32(round(clamp(depth, 0.0, 1.0) * 16777215.0));",
                    "}",
                ];
                const module = this.device.createShaderModule({ code: code.join("\n") });
                pipeline = toImage ? this.device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" },
                    fragment: { module, entryPoint: "fs", targets: [] }, primitive: { topology: "triangle-list" },
                    depthStencil: { format: t.f.gpu, depthWriteEnabled: true, depthCompare: "always" } }) :
                    this.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
                this.pipelines.set(key, pipeline);
            }
            const encoder = this.encoder();
            for (let i = 0; i < layers; i++) {
                const ubo = this.device.createBuffer({ size: 32, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
                this.device.queue.writeBuffer(ubo, 0, Uint32Array.from([guest.offset + i * guest.image, guest.pitch, x, y, w, h, d24, layer + i]));
                this.transient.push(ubo);
                if (toImage) {
                    const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
                        { binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: { buffer: m.buffer } }] });
                    const ds = { view: this.attachment(t, mip, layer + i), depthLoadOp: "load", depthStoreOp: "store" };
                    if (t.f.hasStencil) Object.assign(ds, { stencilLoadOp: "load", stencilStoreOp: "store" });
                    const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: ds });
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, group);
                    pass.setViewport(x, y, w, h, 0, 1);
                    pass.setScissorRect(x, y, w, h);
                    pass.draw(3);
                    pass.end();
                }
                else {
                    const source = t.texture.createView({ dimension: "2d-array", aspect: "depth-only", baseMipLevel: mip, mipLevelCount: 1,
                        format: t.f.gpu.replace(/-stencil8$/, "") });
                    const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
                        { binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: source }, { binding: 2, resource: { buffer: m.buffer } }] });
                    const pass = encoder.beginComputePass();
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, group);
                    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
                    pass.end();
                }
            }
        }

        /**
         * A pass's depth and stencil resolved into its resolve view (sample
         * zero, the mode Venus offers; WebGPU resolves colors only): the depth
         * by a draw writing frag_depth from sample 0, the stencil cleared, then
         * written a bit at a time (a draw replacing through a write mask of the
         * bit, discarding where sample 0's bit is clear)
         */
        resolveDepthStencil(desc) {
            const v = this.attachmentOf(desc.view), r = this.attachmentOf(desc.resolve);
            if (!v || !r || v.texture.samples <= 1 || r.texture.samples > 1) return;
            const f = r.f, layer = { dimension: "2d", baseMipLevel: v.baseMip, mipLevelCount: 1, baseArrayLayer: v.texture.volume ? 0 : v.baseLayer, arrayLayerCount: 1 };
            const encoder = this.encoder();
            const vs = "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n" +
                "    return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);\n}\n";
            const ds = { view: r.attachment };
            if (f.hasDepth) Object.assign(ds, { depthLoadOp: "load", depthStoreOp: "store" });
            if (f.hasStencil) Object.assign(ds, { stencilLoadOp: "load", stencilStoreOp: "store" });
            if (desc.resolve_depth && f.hasDepth && v.f.hasDepth) {
                const key = "resolve-depth:" + f.gpu;
                let pipeline = this.pipelines.get(key);
                if (!pipeline) {
                    const module = this.device.createShaderModule({ code: vs + "@group(0) @binding(0) var source: texture_depth_multisampled_2d;\n" +
                        "@fragment fn fs(@builtin(position) at: vec4f) -> @builtin(frag_depth) f32 { return textureLoad(source, vec2i(at.xy), 0); }\n" });
                    pipeline = this.device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" },
                        fragment: { module, entryPoint: "fs", targets: [] }, primitive: { topology: "triangle-list" },
                        depthStencil: { format: f.gpu, depthWriteEnabled: true, depthCompare: "always" } });
                    this.pipelines.set(key, pipeline);
                }
                const source = v.texture.texture.createView(Object.assign({ aspect: "depth-only", format: v.f.gpu.replace(/-stencil8$/, "") }, layer));
                const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: ds });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source }] }));
                pass.draw(3);
                pass.end();
            }
            if (desc.resolve_stencil && f.hasStencil && v.f.hasStencil) {
                const source = v.texture.texture.createView(Object.assign({ aspect: "stencil-only", format: "stencil8" }, layer));
                const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: Object.assign({}, ds,
                    { stencilLoadOp: "clear", stencilClearValue: 0 }) });
                pass.setStencilReference(0xFF);
                for (let bit = 0; bit < 8; bit++) {
                    const key = "resolve-stencil:" + f.gpu + ":" + bit;
                    let pipeline = this.pipelines.get(key);
                    if (!pipeline) {
                        const module = this.device.createShaderModule({ code: vs + "@group(0) @binding(0) var source: texture_multisampled_2d<u32>;\n" +
                            "@fragment fn fs(@builtin(position) at: vec4f) {\n" +
                            "    if ((textureLoad(source, vec2i(at.xy), 0).x & " + (1 << bit) + "u) == 0u) { discard; }\n}\n" });
                        const face = { compare: "always", passOp: "replace", failOp: "keep", depthFailOp: "keep" };
                        pipeline = this.device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" },
                            fragment: { module, entryPoint: "fs", targets: [] }, primitive: { topology: "triangle-list" },
                            depthStencil: { format: f.gpu, depthWriteEnabled: false, depthCompare: "always", stencilFront: face, stencilBack: face,
                                stencilWriteMask: 1 << bit } });
                        this.pipelines.set(key, pipeline);
                    }
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source }] }));
                    pass.draw(3);
                }
                pass.end();
            }
            this.touch(r.texture.texture);
        }

        /**
         * A copy between a memory and part of a depth or stencil aspect
         * (`a`, copyAspect's), which WebGPU copies only whole: the whole
         * subresource through a buffer, the region repacked in it
         */
        copyPartialAspect(toImage, m, guest, t, a, mip, layer, layers, x, y, w, h) {
            const W = Math.max(1, t.width >> mip), H = Math.max(1, Math.max(1, t.height) >> mip), aligned = align(W * a.bytes, 256);
            const staging = this.scratch(aligned * H * layers, BUFFER.COPY_SRC | BUFFER.COPY_DST | BUFFER.STORAGE);
            const whole = { texture: t.texture, mipLevel: mip, origin: [0, 0, layer], aspect: a.aspect };
            const layout = { buffer: staging, offset: 0, bytesPerRow: aligned, rowsPerImage: H };
            const ours = { offset: y * aligned + x * a.bytes, pitch: aligned, image: aligned * H };
            this.encoder().copyTextureToBuffer(whole, layout, [W, H, layers]);
            if (toImage) {
                this.repack(m.buffer, guest, staging, ours, w * a.bytes, h, layers);
                this.encoder().copyBufferToTexture(layout, whole, [W, H, layers]);
            }
            else this.repack(staging, ours, m.buffer, guest, w * a.bytes, h, layers);
        }

        /**
         * A copy between images of depth or stencil that is not of whole
         * subresources: stencil (and 16-bit depth) through buffers, other
         * depth by a draw writing frag_depth from the source's texels
         */
        copyPartialDepthStencil(s, sa, smip, slayer, sx, sy, t, da, dmip, dlayer, dx, dy, w, h, layers) {
            const as = this.copyAspect(s, sa), at = this.copyAspect(t, da);
            if (as && at && (sa === ASPECT.STENCIL || s.f.gpu === "depth16unorm" && t.f.gpu === "depth16unorm")) {
                const SW = Math.max(1, s.width >> smip), SH = Math.max(1, Math.max(1, s.height) >> smip), sAligned = align(SW * as.bytes, 256);
                const staging = this.scratch(sAligned * SH * layers, BUFFER.COPY_SRC | BUFFER.COPY_DST | BUFFER.STORAGE);
                this.encoder().copyTextureToBuffer({ texture: s.texture, mipLevel: smip, origin: [0, 0, slayer], aspect: as.aspect },
                    { buffer: staging, offset: 0, bytesPerRow: sAligned, rowsPerImage: SH }, [SW, SH, layers]);
                const m = { buffer: staging };
                return this.copyPartialAspect(true, m, { offset: sy * sAligned + sx * as.bytes, pitch: sAligned, image: sAligned * SH }, t, at,
                    dmip, dlayer, layers, dx, dy, w, h);
            }
            if (sa !== ASPECT.DEPTH || da !== ASPECT.DEPTH) {
                this.warn("copy-depth-partial", "partial copies between these depth and stencil images are not done");
                return;
            }
            const key = "depth-copy:" + t.f.gpu;
            let pipeline = this.pipelines.get(key);
            if (!pipeline) {
                const code = [
                    "struct P { dx: i32, dy: i32, sx: i32, sy: i32, layer: u32, mip: u32 };",
                    "@group(0) @binding(0) var<uniform> p: P;",
                    "@group(0) @binding(1) var source: texture_depth_2d_array;",
                    "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {",
                    "    return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);",
                    "}",
                    "@fragment fn fs(@builtin(position) at: vec4f) -> @builtin(frag_depth) f32 {",
                    "    return textureLoad(source, vec2i(at.xy) - vec2i(p.dx, p.dy) + vec2i(p.sx, p.sy), p.layer, p.mip);",
                    "}",
                ].join("\n");
                const module = this.device.createShaderModule({ code });
                pipeline = this.device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" },
                    fragment: { module, entryPoint: "fs", targets: [] }, primitive: { topology: "triangle-list" },
                    depthStencil: { format: t.f.gpu, depthWriteEnabled: true, depthCompare: "always" } });
                this.pipelines.set(key, pipeline);
            }
            const source = s.texture.createView({ dimension: "2d-array", aspect: "depth-only", format: s.f.gpu.replace(/-stencil8$/, "") });
            const encoder = this.encoder();
            for (let i = 0; i < layers; i++) {
                const ubo = this.device.createBuffer({ size: 32, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
                this.device.queue.writeBuffer(ubo, 0, Int32Array.from([dx, dy, sx, sy, slayer + i, smip, 0, 0]));
                this.transient.push(ubo);
                const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
                    { binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: source }] });
                const ds = { view: this.attachment(t, dmip, dlayer + i), depthLoadOp: "load", depthStoreOp: "store" };
                if (t.f.hasStencil) Object.assign(ds, { stencilLoadOp: "load", stencilStoreOp: "store" });
                const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: ds });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, group);
                pass.setViewport(dx, dy, w, h, 0, 1);
                pass.setScissorRect(dx, dy, w, h);
                pass.draw(3);
                pass.end();
            }
        }

        /**
         * A copy between a memory and an image of 16-bit packed texels
         * (R5G6B5, R5G5B5A1, A1R5G5B5: textures of rgba8unorm here): through
         * a staging buffer of WebGPU's pitch that a compute shader unpacks
         * into or packs from
         */
        copyPacked(m, guest, place, size, toImage, format) {
            const [w, h, slices] = size, aligned = align(w * 4, 256);
            const staging = this.scratch(aligned * h * slices, BUFFER.COPY_SRC | BUFFER.COPY_DST | BUFFER.STORAGE);
            const layout = { buffer: staging, offset: 0, bytesPerRow: aligned, rowsPerImage: h };
            const ours = { offset: 0, pitch: aligned, image: aligned * h };
            if (!this.packer) {
                const code = [
                    "struct P { src: u32, src_pitch: u32, src_image: u32, dst: u32, dst_pitch: u32, dst_image: u32, w: u32, h: u32, slices: u32, end: u32, format: u32, pack: u32 };",
                    "@group(0) @binding(0) var<uniform> p: P;",
                    "@group(0) @binding(1) var<storage, read> s: array<u32>;",
                    "@group(0) @binding(2) var<storage, read_write> d: array<u32>;",
                    "fn to8(x: u32, top: u32) -> u32 { return (x * 255u + top / 2u) / top; }",
                    "fn from8(x: u32, top: u32) -> u32 { return (x * top + 127u) / 255u; }",
                    "fn bits(v: u32, at: u32, n: u32) -> u32 { return (v >> at) & ((1u << n) - 1u); }",
                    "// (VkFormat 4 R5G6B5, 6 R5G5B5A1, 8 A1R5G5B5; rgba8 with red in the low byte)",
                    "fn unpack(v: u32) -> u32 {",
                    "    var c = vec4u(to8(bits(v, 10u, 5u), 31u), to8(bits(v, 5u, 5u), 31u), to8(bits(v, 0u, 5u), 31u), bits(v, 15u, 1u) * 255u);",
                    "    if (p.format == 4u) { c = vec4u(to8(bits(v, 11u, 5u), 31u), to8(bits(v, 5u, 6u), 63u), to8(bits(v, 0u, 5u), 31u), 255u); }",
                    "    if (p.format == 6u) { c = vec4u(to8(bits(v, 11u, 5u), 31u), to8(bits(v, 6u, 5u), 31u), to8(bits(v, 1u, 5u), 31u), bits(v, 0u, 1u) * 255u); }",
                    "    return c.x | (c.y << 8u) | (c.z << 16u) | (c.w << 24u);",
                    "}",
                    "fn pack(t: u32) -> u32 {",
                    "    let c = vec4u(bits(t, 0u, 8u), bits(t, 8u, 8u), bits(t, 16u, 8u), bits(t, 24u, 8u));",
                    "    let a = select(0u, 1u, c.w >= 128u);",
                    "    if (p.format == 4u) { return (from8(c.x, 31u) << 11u) | (from8(c.y, 63u) << 5u) | from8(c.z, 31u); }",
                    "    if (p.format == 6u) { return (from8(c.x, 31u) << 11u) | (from8(c.y, 31u) << 6u) | (from8(c.z, 31u) << 1u) | a; }",
                    "    return (a << 15u) | (from8(c.x, 31u) << 10u) | (from8(c.y, 31u) << 5u) | from8(c.z, 31u);",
                    "}",
                    "@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>) {",
                    "    let i = id.x + id.y * n.x * 64u;",
                    "    if (p.pack == 0u) {",
                    "        // a texel of the image from the memory's 16 bits",
                    "        if (i >= p.w * p.h * p.slices) { return; }",
                    "        let slice = i / (p.w * p.h); let row = (i % (p.w * p.h)) / p.w; let column = i % p.w;",
                    "        let at = p.src + slice * p.src_image + row * p.src_pitch + column * 2u;",
                    "        let v = bits(s[at >> 2u], (at & 3u) * 8u, 16u);",
                    "        d[(p.dst + slice * p.dst_image + row * p.dst_pitch + column * 4u) >> 2u] = unpack(v);",
                    "        return;",
                    "    }",
                    "    // a dword of the memory: its texels in the region packed, the rest kept",
                    "    let w = (p.dst >> 2u) + i;",
                    "    if (w * 4u >= p.end) { return; }",
                    "    var word = d[w];",
                    "    for (var k = 0u; k < 4u; k += 2u) {",
                    "        let at = w * 4u + k;",
                    "        if (at < p.dst || at >= p.end) { continue; }",
                    "        let rel = at - p.dst;",
                    "        let slice = rel / p.dst_image; let row = (rel % p.dst_image) / p.dst_pitch; let byte = (rel % p.dst_image) % p.dst_pitch;",
                    "        if (slice >= p.slices || row >= p.h || byte >= p.w * 2u) { continue; }",
                    "        let texel = s[(p.src + slice * p.src_image + row * p.src_pitch + byte * 2u) >> 2u];",
                    "        word = (word & ~(0xFFFFu << (k * 8u))) | (pack(texel) << (k * 8u));",
                    "    }",
                    "    d[w] = word;",
                    "}",
                ].join("\n");
                this.packer = this.device.createComputePipeline({ layout: "auto", compute: { module: this.device.createShaderModule({ code }), entryPoint: "main" } });
            }
            const run = (src, from, dst, to, pack) => {
                const end = to.offset + (slices - 1) * to.image + (h - 1) * to.pitch + w * (pack ? 2 : 4);
                const params = this.device.createBuffer({ size: 48, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
                this.device.queue.writeBuffer(params, 0, Uint32Array.from([from.offset, from.pitch, from.image, to.offset, to.pitch, to.image, w, h, slices, end,
                    format, pack ? 1 : 0]));
                this.transient.push(params);
                const group = this.device.createBindGroup({ layout: this.packer.getBindGroupLayout(0), entries: [
                    { binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: src } }, { binding: 2, resource: { buffer: dst } }] });
                const invocations = pack ? ((end + 3) >> 2) - (to.offset >> 2) : w * h * slices;
                const groups = Math.ceil(invocations / 64);
                const pass = this.encoder().beginComputePass();
                pass.setPipeline(this.packer);
                pass.setBindGroup(0, group);
                pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
                pass.end();
            };
            if (toImage) {
                run(m.buffer, guest, staging, ours, false);
                this.encoder().copyBufferToTexture(layout, place, size);
            }
            else {
                this.encoder().copyTextureToBuffer(place, layout, size);
                run(staging, ours, m.buffer, guest, true);
            }
        }

        /** a texture's image (one mip, one layer or slice, one aspect), for a snapshot: null where WebGPU cannot copy it (multisampled, 24-bit depth) */
        readTexture(b) {
            const [id, aspectMask, mip, layer, request] = b;
            const t = this.texture(id);
            // (24-bit depth, which WebGPU copies out of no texture: read by a dispatch, 4 bytes a texel)
            if (t && t.samples <= 1 && aspectMask === ASPECT.DEPTH && /^depth24/.test(t.f.gpu)) {
                const w = Math.max(1, t.width >> mip), h = Math.max(1, t.height >> mip);
                const out = this.device.createBuffer({ size: w * h * 4, usage: BUFFER.STORAGE | BUFFER.COPY_SRC });
                const target = this.device.createBuffer({ size: w * h * 4, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
                this.transient.push(out);
                this.depthByShader(false, { buffer: out }, { offset: 0, pitch: w * 4, image: w * h * 4 }, t, mip, layer, 1, 0, 0, w, h);
                this.encoder().copyBufferToBuffer(out, 0, target, 0, w * h * 4);
                this.flushEncoder();
                this.pending.push(target.mapAsync(1).then(() => {
                    const bytes = new Uint8Array(target.getMappedRange()).slice();
                    target.destroy();
                    this.respond(request, bytes);
                }, () => { target.destroy(); this.respond(request, null); }));
                return;
            }
            const a = t && t.samples <= 1 ? this.copyAspect(t, aspectMask) : null;
            if (!a) return this.respond(request, null);
            const w = Math.max(1, t.width >> mip), h = Math.max(1, t.height >> mip);
            // (the texture's texels: rgba8unorm ones of 16-bit packed formats)
            const rowBytes = w * a.gpu, aligned = align(rowBytes, 256);
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

        /** a snapshot's image back into its texture (depth WebGPU writes no buffer into: by a draw, depthByShader) */
        writeTexture(b) {
            const [id, aspectMask, mip, layer, length] = b;
            const t = this.texture(id);
            if (!t || t.samples > 1) return;
            this.touch(t.texture);
            if (aspectMask === ASPECT.DEPTH && t.f.hasDepth && t.f.gpu !== "depth16unorm") {
                const w = Math.max(1, t.width >> mip), h = Math.max(1, t.height >> mip);
                if (length < w * h * 4) return;
                const staged = this.device.createBuffer({ size: w * h * 4, usage: BUFFER.STORAGE | BUFFER.COPY_DST });
                this.transient.push(staged);
                this.device.queue.writeBuffer(staged, 0, new Uint8Array(b.buffer, b.byteOffset + 20, w * h * 4));
                this.depthByShader(true, { buffer: staged }, { offset: 0, pitch: w * 4, image: w * h * 4 }, t, mip, layer, 1, 0, 0, w, h);
                return;
            }
            const a = this.copyAspect(t, aspectMask);
            if (!a) return;
            const w = Math.max(1, t.width >> mip), h = Math.max(1, t.height >> mip);
            if (length < w * h * a.gpu) return;
            this.flushEncoder();
            this.device.queue.writeTexture({ texture: t.texture, mipLevel: mip, origin: [0, 0, layer], aspect: a.aspect },
                new Uint8Array(b.buffer, b.byteOffset + 20, length), { bytesPerRow: w * a.gpu, rowsPerImage: h }, [w, h, 1]);
        }

        copyBufferImage(b) {
            const [toImage, mid, low, high, rowLength, imageHeight, tid, aspectMask, mip, layer, layers, x, y, z, w, h, d] = b;
            const m = this.memory(mid), t = this.texture(tid);
            if (!m || !t || !w || !h || !d) return;
            if (toImage) this.touch(t.texture);
            // (depth WebGPU copies no buffer into, or 24-bit depth out of: by a draw, a dispatch)
            if (aspectMask === ASPECT.DEPTH && t.f.hasDepth && t.f.gpu !== "depth16unorm" && t.samples <= 1 && (toImage || /^depth24/.test(t.f.gpu))) {
                const offset = low + high * 0x100000000, pitch = (rowLength || w) * 4, rows = imageHeight || h;
                return this.depthByShader(toImage, m, { offset, pitch, image: pitch * rows }, t, mip, layer, layers, x, y, w, h);
            }
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
            if (t.f.packed && a.aspect === "all") return this.copyPacked(m, { offset, pitch, image: pitch * rows }, place, size, toImage, t.f.packed);
            // (depth and stencil: WebGPU copies only whole subresources of them)
            if (t.f.depth && (x || y || w !== Math.max(1, t.width >> mip) || h !== Math.max(1, Math.max(1, t.height) >> mip))) {
                return this.copyPartialAspect(toImage, m, { offset, pitch, image: pitch * rows }, t, a, mip, layer, slices, x, y, w, h);
            }
            const encoder = this.encoder();
            if (pitch % 256 === 0 && offset % 4 === 0) {
                const layout = { buffer: m.buffer, offset, bytesPerRow: pitch, rowsPerImage: rows };
                if (toImage) encoder.copyBufferToTexture(layout, place, size);
                else encoder.copyTextureToBuffer(place, layout, size);
                return;
            }
            if ((offset | pitch | rowBytes | pitch * rows) & 3) {
                // (rows not in whole dwords: repacked by a compute shader to and from WebGPU's pitch)
                const staging = this.scratch(aligned * h * slices, BUFFER.COPY_SRC | BUFFER.COPY_DST | BUFFER.STORAGE);
                const layout = { buffer: staging, offset: 0, bytesPerRow: aligned, rowsPerImage: h };
                const guest = { offset, pitch, image: pitch * rows }, ours = { offset: 0, pitch: aligned, image: aligned * h };
                if (toImage) {
                    this.repack(m.buffer, guest, staging, ours, rowBytes, h, slices);
                    this.encoder().copyBufferToTexture(layout, place, size);
                }
                else {
                    this.encoder().copyTextureToBuffer(place, layout, size);
                    this.repack(staging, ours, m.buffer, guest, rowBytes, h, slices);
                }
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
            this.touch(t.texture);
            // (depth and stencil: WebGPU copies whole subresources of all their aspects only)
            if (s.f.depth || t.f.depth) {
                const all = f => (f.hasDepth ? ASPECT.DEPTH : 0) | (f.hasStencil ? ASPECT.STENCIL : 0);
                const full = (f, mip, x0, y0) => !x0 && !y0 && w === Math.max(1, f.width >> mip) && h === Math.max(1, Math.max(1, f.height) >> mip);
                if (s.f.gpu === t.f.gpu && sa === all(s.f) && da === sa && full(s, smip, sx, sy) && full(t, dmip, dx, dy) && s.samples === t.samples) {
                    this.encoder().copyTextureToTexture({ texture: s.texture, mipLevel: smip, origin: [0, 0, slayer] },
                        { texture: t.texture, mipLevel: dmip, origin: [0, 0, dlayer] }, [w, h, layers]);
                    return;
                }
                for (const aspect of [ASPECT.DEPTH, ASPECT.STENCIL]) {
                    if (sa & aspect) this.copyPartialDepthStencil(s, aspect, smip, slayer, sx, sy, t, aspect, dmip, dlayer, dx, dy, w, h, layers);
                }
                return;
            }
            const as = this.copyAspect(s, sa), at = this.copyAspect(t, da);
            if (!as || !at) {
                this.warn("copy-d24", "copies of 24-bit depth are not done");
                return;
            }
            const size = [w, h, s.volume ? d : layers];
            const from = { texture: s.texture, mipLevel: smip, origin: [sx, sy, s.volume ? sz : slayer], aspect: as.aspect };
            const to = { texture: t.texture, mipLevel: dmip, origin: [dx, dy, t.volume ? dz : dlayer], aspect: at.aspect };
            const base = f => f.gpu.replace("-srgb", "");
            if (!s.f.packed !== !t.f.packed) {
                this.warn("copy-packed", "copies between 16-bit packed images and others are not done");
                return;
            }
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
            this.touch(t.texture);
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
                    if (t.f.packed === R5G6B5) clearValue[3] = 1;
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
            this.touch(t.texture);
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
        /** a blit's pipeline into `format` from a texture of `kind` (f, u, i), a 3D one when `volume` (at the depth rect.w) */
        blitPipeline(format, kind, volume, mask = 0xF) {
            const key = format + ":" + kind + (volume ? ":3d" : "") + ":" + mask;
            let p = this.pipelines.get(key);
            if (p) return p;
            const type = kind === "u" ? "u32" : kind === "i" ? "i32" : "f32";
            const at = volume ? "vec3f(in.uv, rect.w)" : "in.uv";
            const code = [
                "struct Rect { dst: vec4f, src: vec4f, level: f32, w: f32 };",
                "@group(0) @binding(0) var<uniform> rect: Rect;",
                "@group(0) @binding(1) var source: texture_" + (volume ? "3d" : "2d") + "<" + type + ">;",
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
                kind === "f" ? "    return textureSampleLevel(source, smp, " + at + ", rect.level);" :
                    "    let size = " + (volume ? "vec3f" : "vec2f") + "(textureDimensions(source, u32(rect.level)));\n" +
                    "    return textureLoad(source, " + (volume ? "vec3i" : "vec2i") + "(floor(" + at + " * size)), i32(rect.level));",
                "}",
            ].join("\n");
            const module = this.device.createShaderModule({ code });
            p = this.device.createRenderPipeline({
                layout: "auto",
                vertex: { module, entryPoint: "vs" },
                fragment: { module, entryPoint: "fs", targets: [{ format, writeMask: mask }] },
                primitive: { topology: "triangle-strip" },
            });
            this.pipelines.set(key, p);
            return p;
        }

        blitImage(b) {
            const [sid, smip, slayer, sx0, sy0, sz0, sx1, sy1, sz1, did, dmip, dlayer, dx0, dy0, dz0, dx1, dy1, dz1, layers, linear] = b;
            const s = this.texture(sid), t = this.texture(did);
            if (!s || !t) return;
            this.touch(t.texture);
            // (Venus offers neither: VK_FORMAT_FEATURE_BLIT_DST_BIT is for the renderable color formats)
            if (t.f.depth || s.f.depth || !t.f.renderable) {
                this.warn("blit-kind", "blits of depth and into formats not renderable are not done");
                return;
            }
            const kind = s.f.uint ? "u" : s.f.sint ? "i" : "f";
            const pipeline = this.blitPipeline(t.f.gpu, kind, s.volume, alphaMask(t.f));
            const sw = Math.max(1, s.width >> smip), sh = Math.max(1, s.height >> smip);
            const tw = Math.max(1, t.width >> dmip), th = Math.max(1, t.height >> dmip);
            // the destination's corners in order, the source's following them (flips)
            const flipX = dx0 > dx1, flipY = dy0 > dy1;
            const rect = new Float32Array(12);
            rect.set([Math.min(dx0, dx1) / tw, Math.min(dy0, dy1) / th, Math.max(dx0, dx1) / tw, Math.max(dy0, dy1) / th,
                (flipX ? sx1 : sx0) / sw, (flipY ? sy1 : sy0) / sh, (flipX ? sx0 : sx1) / sw, (flipY ? sy0 : sy1) / sh, 0]);
            const uniform = this.staging(new Uint8Array(rect.buffer));
            const rects = this.scratch(48, BUFFER.UNIFORM | BUFFER.COPY_DST);
            const encoder = this.encoder();
            encoder.copyBufferToBuffer(uniform, 0, rects, 0, 48);
            const sampler = kind === "f" ? this.device.createSampler({ magFilter: linear ? "linear" : "nearest", minFilter: linear ? "linear" : "nearest" }) : null;
            // the slices: a 3D destination's of the blit's depths (each from the
            // source's depth its middle maps to, Vulkan's rule), else the layers
            const sd = Math.max(1, s.depth >> smip), td = Math.max(1, t.depth >> dmip);
            const slices = t.volume ? Math.abs(dz1 - dz0) : layers;
            const volumeSource = s.volume ? s.texture.createView({ dimension: "3d", baseMipLevel: smip, mipLevelCount: 1 }) : null;
            for (let i = 0; i < slices; i++) {
                const z = Math.min(dz0, dz1) + i;
                let ubo = rects;
                if (s.volume) {
                    const w = t.volume ? (sz0 + (z + 0.5 - dz0) * (sz1 - sz0) / (dz1 - dz0)) / sd : (sz0 + sz1) / 2 / sd;
                    rect[9] = w;
                    ubo = this.scratch(48, BUFFER.UNIFORM | BUFFER.COPY_DST);
                    encoder.copyBufferToBuffer(this.staging(new Uint8Array(rect.buffer)), 0, ubo, 0, 48);
                }
                const source = volumeSource || s.texture.createView({ dimension: "2d", baseMipLevel: smip, mipLevelCount: 1,
                    baseArrayLayer: slayer + (t.volume ? 0 : i), arrayLayerCount: 1 });
                const entries = [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: source }];
                if (sampler) entries.push({ binding: 2, resource: sampler });
                const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
                const target = { view: this.attachment(t, dmip, t.volume ? 0 : dlayer + i), loadOp: "load", storeOp: "store" };
                if (t.volume) {
                    if (z < 0 || z >= td) continue;
                    target.depthSlice = z;
                }
                const pass = encoder.beginRenderPass({ colorAttachments: [target] });
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
        async translate(shader, push, storage = [], flags = 0) {
            await this.loadNaga();
            return this.translateNow(shader, push, flags, storage);
        }

        /**
         * The same, naga loaded; `flags` (TRANSLATE): Vulkan's clip space
         * kept (draws with a viewport of a negative height), the fragment
         * depth output dropped (a pipeline with no depth attachment), depth
         * reversed (a viewport's depths reversed): vertexVariant; `storage`:
         * the uniform buffers (group << 16 | binding) that are read-only
         * storage buffers in it (spilledUniforms)
         */
        translateNow(shader, push, flags, storage = [], wraps = []) {
            const key = String(push) + (flags ? ":f" + flags : "") + (storage.length ? ":" + storage.join(",") : "") +
                (wraps.length ? ":w" + wraps.flat().join(",") : "");
            let t = shader.translations.get(key);
            if (t) return t;
            const naga = this.naga;
            const input = naga.vx_alloc(shader.spirv.length);
            new Uint8Array(naga.memory.buffer, input, shader.spirv.length).set(shader.spirv);
            const list = storage.length ? naga.vx_alloc(storage.length * 4) : 0;
            if (list) new Uint32Array(naga.memory.buffer, list, storage.length).set(storage);
            // (integer images' samplers' address modes: pairs of the image's group << 16 | binding, the modes)
            const wrapList = wraps.length ? naga.vx_alloc(wraps.length * 8) : 0;
            if (wrapList) new Uint32Array(naga.memory.buffer, wrapList, wraps.length * 2).set(wraps.flat());
            let out;
            try {
                out = naga.vx_translate(input, shader.spirv.length, push, PUSH_BINDING, flags, list, storage.length, wrapList, wraps.length);
            } catch (error) {
                // (a panic: a fresh instance next time)
                this.naga = null;
                throw error;
            }
            naga.vx_free(input, shader.spirv.length);
            if (list) naga.vx_free(list, storage.length * 4);
            if (wrapList) naga.vx_free(wrapList, wraps.length * 8);
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
                const uniforms = (entry ? entry.bindings : []).filter(b => b[2] === "uniform").map(([group, binding]) => group << 16 | binding)
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
                // (a fragment shader writing depth with no depth attachment: its depth output dropped)
                const flagsOf = stage => stage.stage === 16 && !d.depth_format ? TRANSLATE.NO_DEPTH : 0;
                let translations = [];
                for (const [i, stage] of d.stages.entries()) translations.push([await this.translate(shaders[i], push, [], flagsOf(stage)), stage]);
                for (const [t] of translations) if (t.error) throw new Error("shader: " + t.error);
                // (more uniform buffers than a stage has: some are storage, every stage translated so)
                p.storage = this.spilledUniforms(translations);
                if (p.storage.length) {
                    this.stats.spilledUniforms = (this.stats.spilledUniforms || 0) + 1;
                    translations = [];
                    for (const [i, stage] of d.stages.entries()) translations.push([await this.translate(shaders[i], push, p.storage, flagsOf(stage)), stage]);
                    for (const [t] of translations) if (t.error) throw new Error("shader: " + t.error);
                }
                const stages = translations.map(([t, stage]) => [stage.stage, this.stageState(t, stage)]);
                // (integer images sampled: the draws' samplers' address modes, wrapVariant)
                p.intsamples = [...new Set(translations.flatMap(([t]) => t.intsamples || []))];
                p.stageSources = d.stages.map((stage, i) => ({ shader: shaders[i], stage, flags: flagsOf(stage) }));
                // the bindings the stages use, by group (and the buffers' least sizes)
                const sizes = new Map();
                this.bindingSizes.set(p.groups, sizes);
                for (const [, st] of stages) {
                    for (const [group, binding, kind, size] of st.entry ? st.entry.bindings : []) {
                        if (!p.groups.has(group)) p.groups.set(group, new Map());
                        p.groups.get(group).set(binding, kind);
                        if (size) sizes.set(group << 16 | binding, Math.max(size, sizes.get(group << 16 | binding) || 0));
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
                p.vertexLayout = this.vertexLayout(d);
                // (VK_BLEND_FACTOR_CONSTANT_ALPHA: WebGPU's constant is the color's for color; such a
                // pipeline's draws get the constant's alpha in all four, warned when it uses both)
                const colorFactors = d.targets.filter(x => x.blend).flatMap(x => [x.src_color, x.dst_color]);
                p.constantAlpha = colorFactors.some(f => f === 12 || f === 13);
                if (p.constantAlpha && colorFactors.some(f => f === 10 || f === 11)) this.warn("constant-alpha", "a pipeline blends with the constant's color and its alpha (not done)");
                // (flat varyings of a pipeline of GL's provoking vertex: its draws reordered, provokingLast)
                p.flat = !!(vertex[1].entry && vertex[1].entry.flat);
                const buffers = p.vertexLayout.native ? p.vertexLayout.buffers : p.vertexLayout.packed;
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
                    // (WebGPU biases triangles only)
                    if (d.depth_bias && d.topology >= 3) Object.assign(descriptor.depthStencil, { depthBias: Math.round(d.depth_bias.constant),
                        depthBiasSlopeScale: d.depth_bias.slope, depthBiasClamp: d.depth_bias.clamp });
                }
                const targets = d.targets.map(t => {
                    const f = this.format(t.format);
                    if (!f) return null;
                    const target = { format: f.gpu, writeMask: d.discard ? 0 : t.write_mask & alphaMask(f) };
                    // (min and max take no factors in Vulkan; WebGPU wants them one)
                    const component = (src, dst, op) => op === 3 || op === 4 ? { srcFactor: "one", dstFactor: "one", operation: BLEND_OP[op] } :
                        { srcFactor: BLEND_FACTOR[src], dstFactor: BLEND_FACTOR[dst], operation: BLEND_OP[op] };
                    if (t.blend && !f.int && !d.discard) target.blend = {
                        color: component(t.src_color, t.dst_color, t.color_op),
                        alpha: component(t.src_alpha, t.dst_alpha, t.alpha_op),
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
                else {
                    // no fragment shader (a depth-only draw; Vulkan leaves the colors undefined): one that writes
                    // nothing, for the pass's attachments
                    descriptor.fragment = { module: this.emptyFragment(), entryPoint: "fs", targets: targets.map(t => t && { format: t.format, writeMask: 0 }) };
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
            const colorFormats = [];
            const colorAttachments = d.colors.map((c, i) => {
                if (!c) return null;
                const v = this.attachmentOf(c.view);
                if (!v) return null;
                const f = v.f;
                colorFormats[i] = f.gpu;
                const value = f.uint ? c.clear.map(x => x >>> 0) : f.sint ? c.clear.map(x => x | 0) : c.clear.map(f32);
                if (f.packed === R5G6B5) value[3] = 1;
                const a = { view: v.attachment, loadOp: c.load === 0 ? "load" : "clear", storeOp: c.store === 1 ? "discard" : "store",
                    clearValue: { r: value[0], g: value[1], b: value[2], a: value[3] } };
                const resolve = c.resolve ? this.attachmentOf(c.resolve) : null;
                if (resolve) a.resolveTarget = resolve.attachment;
                // (a slice of a 3D image: Vulkan's 2D view of it)
                if (v.texture.volume) a.depthSlice = v.baseLayer;
                return a;
            });
            const descriptor = { colorAttachments };
            if (!colorAttachments.some(a => a) && !(d.depth && this.attachmentOf(d.depth.view))) {
                // no attachments: the pipelines' placeholder (see createPipeline)
                colorAttachments.splice(0, colorAttachments.length, { view: this.placeholder(d.width, d.height), loadOp: "clear", storeOp: "discard" });
                colorFormats.splice(0, colorFormats.length, PLACEHOLDER_FORMAT);
            }
            let depthFormat = "";
            if (d.depth) {
                const v = this.attachmentOf(d.depth.view);
                if (v) {
                    depthFormat = v.texture.f.gpu;
                    const ds = { view: v.attachment };
                    if (v.texture.f.hasDepth) Object.assign(ds, { depthLoadOp: d.depth.load === 0 ? "load" : "clear", depthClearValue: d.depth.clear_depth,
                        depthStoreOp: d.depth.store === 1 && !d.depth.resolve ? "discard" : "store" });
                    if (v.texture.f.hasStencil) Object.assign(ds, { stencilLoadOp: d.depth.stencil_load === 0 ? "load" : "clear",
                        stencilClearValue: d.depth.clear_stencil, stencilStoreOp: d.depth.stencil_store === 1 && !d.depth.resolve ? "discard" : "store" });
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
            this.passAttachments = attachmentState(Array.from(colorFormats, f => f || null), depthFormat, this.passInfo.samples > 1 ? 4 : 1);
            // (the textures attached: a draw that samples one reads a copy, attachmentCopies)
            this.passTextures = new Set([...d.colors.flatMap(c => c ? [c.view, c.resolve] : []), d.depth && d.depth.view]
                .map(id => id && this.objects.get(id)).filter(v => v && v.kind === "view").map(v => v.texture.texture));
            this.state.passWidth = d.width;
            this.state.passHeight = d.height;
            this.state.pipelineApplied = false;
            this.state.vertexDirty = this.state.indexDirty = this.state.dynamicDirty = true;
            this.state.applied = new Map();
        }

        endPass() {
            if (this.pass) {
                this.pass.end();
                this.pass = null;
                this.resolveQueries();
                // (what it drew into: written)
                if (this.passTextures) for (const texture of this.passTextures) this.touch(texture);
            }
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

        /** The buffers a compute pipeline's bind groups bind as writable storage */
        writableBuffers(p) {
            const writable = new Set();
            for (const [group, used] of p.groups) {
                const contents = this.state.groups[1].get(group);
                for (const [binding, kind] of used) {
                    const d = kind === "storage-rw" && contents && contents.descriptors.get(descriptorKey(binding));
                    const m = d && this.memory(d.rid);
                    if (m) writable.add(m.buffer);
                }
            }
            return writable;
        }

        /**
         * the bind group of a pipeline's group from what is bound there;
         * `writable`: buffers a dispatch writes, whose other bindings in it
         * become copies (WebGPU allows no other use of a buffer a dispatch
         * writes; Vulkan's bindings of one memory's other ranges may)
         */
        bindGroup(p, point, group, writable) {
            const used = p.groups.get(group);
            if (!used) return null;
            const isPush = group === p.push;
            const contents = this.state.groups[point].get(group);
            const aliased = writable && [...used].some(([binding, kind]) => {
                const d = (kind === "uniform" || kind === "storage") && contents && contents.descriptors.get(descriptorKey(binding));
                const m = d && this.memory(d.rid);
                return m && writable.has(m.buffer);
            });
            const key = (contents ? contents.version : 0) + (isPush ? ":" + this.state.pushOffset : "") + ":" + (this.swizzleEpoch || 0);
            let bg = p.bindGroups.get(group);
            const substituted = !!this.substitutes;
            if (bg && bg.key === key && !aliased && !substituted) return bg.group;
            const entries = [];
            const sizes = this.bindingSizes.get(p.groups);
            for (const [binding, kind] of used) {
                if (isPush && binding === PUSH_BINDING) {
                    entries.push({ binding, resource: { buffer: this.pushBuffer, offset: this.state.pushOffset, size: 256 } });
                    continue;
                }
                const d = contents && contents.descriptors.get(descriptorKey(binding));
                if (!d) { this.warn("unbound" + group + ":" + binding, "group " + group + " binding " + binding + " has nothing bound"); return null; }
                if (samplerBinding(binding) || kind === "sampler" || kind === "sampler-comparison") {
                    const s = this.objects.get(samplerBinding(binding) ? d.sampler : d.sampler || d.rid);
                    if (!s || !s.sampler) return null;
                    entries.push({ binding, resource: s.sampler });
                    continue;
                }
                if (kind === "uniform" || kind === "storage" || kind === "storage-rw") {
                    const m = this.memory(d.rid);
                    if (!m) return null;
                    let size = Math.min(d.size, m.buffer.size - d.offset);
                    // (a range smaller than the shader's block, as std140's padding at its end may leave it:
                    // Vulkan reads what the shader reads, WebGPU wants the whole block; the memory after it)
                    const least = sizes && sizes.get(group << 16 | binding) || 0;
                    if (size < least) {
                        if (m.buffer.size - d.offset >= least) size = least;
                        else this.warn("binding-size", "a buffer bound smaller than the shader's block, at the end of its memory (not done)");
                    }
                    if (aliased && kind !== "storage-rw" && writable.has(m.buffer)) {
                        // (what it binds as it is before the dispatch)
                        const copy = this.scratch(size, BUFFER.COPY_DST | BUFFER.UNIFORM | BUFFER.STORAGE);
                        this.encoder().copyBufferToBuffer(m.buffer, d.offset, copy, 0, align(size, 4));
                        entries.push({ binding, resource: { buffer: copy, offset: 0, size } });
                        continue;
                    }
                    entries.push({ binding, resource: { buffer: m.buffer, offset: d.offset, size } });
                    continue;
                }
                const v = this.objects.get(d.rid);
                if (!v || v.kind !== "view") return null;
                const copy = this.substitutes && this.substitutes.get(v);
                if (kind === "storage-texture") this.touch(v.texture.texture);
                const mode = copyMode(v, kind), swizzled = mode && v[mode] ? v[mode].view : null;
                // (a texture of the render pass this binds into, not copied: WebGPU would drop the batch)
                if (point === 0 && this.pass && !copy && !swizzled && this.passTextures && this.passTextures.has(v.texture.texture)) {
                    this.warn("feedback:" + group + ":" + binding + ":" + kind, "a draw samples a texture of its own pass, not copied (group " + group +
                        " binding " + binding + " " + kind + ", " + v.f.gpu + " " + v.texture.width + "x" + v.texture.height + ")");
                }
                entries.push({ binding, resource: copy || (kind === "storage-texture" ? this.singleMip(v) : /-faces$/.test(kind) ? this.facesView(v) :
                    swizzled || v.view) });
            }
            const created = this.device.createBindGroup({ layout: p.gpu.getBindGroupLayout(group), entries });
            if (!aliased && !substituted) p.bindGroups.set(group, { key, group: created });
            return created;
        }

        /** A cube view's faces as a 2D array (integer cubes, which vx_naga's cubes.rs loads from) */
        facesView(v) {
            if (v.dimension !== "cube") return v.view;
            if (!v.faces) v.faces = v.texture.texture.createView({ format: v.descriptor.format, dimension: "2d-array", baseMipLevel: v.baseMip, mipLevelCount: v.mips,
                baseArrayLayer: v.baseLayer, arrayLayerCount: 6 });
            return v.faces;
        }

        singleMip(v) {
            if (v.mips === 1) return v.view;
            if (!v.storage) v.storage = v.texture.texture.createView({ format: v.f.gpu, dimension: v.dimension, baseMipLevel: v.baseMip, mipLevelCount: 1,
                baseArrayLayer: v.baseLayer, arrayLayerCount: v.layers });
            return v.storage;
        }

        /**
         * A render pipeline whose vertex shader is another translation
         * (`flags`, TRANSLATE): for draws with a viewport of a negative height
         * (Vulkan flips y with it, ANGLE draws GL's frames so; WebGPU's
         * viewports cannot, so the vertex stage keeps Vulkan's clip space
         * instead of flipping into WebGPU's), and for a viewport whose depths
         * are reversed (z made w - z, the viewport's depths swapped). Made at
         * the first such draw; its own (automatic) layout, so its own bind
         * groups: WebGPU does not let another pipeline use an automatic
         * layout's bind group layouts.
         */
        vertexVariant(p, flags) {
            p.vertexVariants = p.vertexVariants || new Map();
            if (p.vertexVariants.has(flags)) return p.vertexVariants.get(flags);
            let v = null;
            try {
                const t = this.translateNow(p.vertexSource.shader, p.push, flags, p.storage);
                if (t.error) throw new Error("shader: " + t.error);
                const st = this.stageState(t, p.vertexSource.stage);
                const descriptor = Object.assign({}, p.descriptor, {
                    vertex: Object.assign({}, p.descriptor.vertex, { module: st.module, entryPoint: st.entryPoint, constants: st.constants }),
                });
                v = { kind: "pipeline", desc: p.desc, groups: p.groups, push: p.push, gpu: this.device.createRenderPipeline(descriptor), bindGroups: new Map(),
                    error: null, descriptor };
            } catch (error) {
                this.warn("vertex-variant:" + flags + ":" + error.message, "a pipeline's variant for flipped or reversed viewports failed: " + error.message);
            }
            p.vertexVariants.set(flags, v);
            return v;
        }

        /**
         * The address modes of the samplers bound with a pipeline's integer
         * images (their samples are fetches, vx_naga's intsample.rs), where
         * one is not clamp to edge: [group << 16 | binding, modes] pairs
         */
        intWraps(p, point) {
            if (!p.intsamples || !p.intsamples.length) return [];
            const wraps = [];
            for (const key of p.intsamples) {
                const contents = this.state.groups[point].get(key >>> 16);
                const d = contents && contents.descriptors.get(descriptorKey(key & 0xFFFF));
                const s = d && this.objects.get(d.sampler);
                if (s && s.kind === "sampler" && [0, 4, 8].some(shift => (s.wrap >> shift & 15) < 2)) wraps.push([key, s.wrap]);
            }
            return wraps;
        }

        /**
         * A render pipeline whose stages are translated again with integer
         * images' address modes (`wraps`, intWraps) and the vertex shader's
         * `flags` (vertexVariant's): made at the first draw with them, its own
         * bind groups (an automatic layout)
         */
        wrapVariant(p, flags, wraps) {
            p.wrapVariants = p.wrapVariants || new Map();
            const key = flags + ":" + wraps.flat().join(",");
            if (p.wrapVariants.has(key)) return p.wrapVariants.get(key);
            let v = null;
            try {
                const descriptor = Object.assign({}, p.descriptor);
                for (const { shader, stage, flags: own } of p.stageSources) {
                    const t = this.translateNow(shader, p.push, own | (stage.stage === 1 ? flags : 0), p.storage, wraps);
                    if (t.error) throw new Error("shader: " + t.error);
                    const st = this.stageState(t, stage);
                    const replaced = { module: st.module, entryPoint: st.entryPoint, constants: st.constants };
                    if (stage.stage === 1) descriptor.vertex = Object.assign({}, p.descriptor.vertex, replaced);
                    else if (stage.stage === 16 && p.descriptor.fragment && !p.desc.discard) descriptor.fragment = Object.assign({}, p.descriptor.fragment, replaced);
                }
                v = { kind: "pipeline", desc: p.desc, groups: p.groups, push: p.push, gpu: this.device.createRenderPipeline(descriptor), bindGroups: new Map(),
                    error: null, descriptor };
            } catch (error) {
                this.warn("wrap-variant:" + error.message, "a pipeline's variant for its integer images' address modes failed: " + error.message);
            }
            p.wrapVariants.set(key, v);
            return v;
        }

        /** wrapVariant's for a compute pipeline */
        wrapComputeVariant(p, wraps) {
            p.wrapVariants = p.wrapVariants || new Map();
            const key = wraps.flat().join(",");
            if (p.wrapVariants.has(key)) return p.wrapVariants.get(key);
            let v = null;
            try {
                const { shader, stage } = p.stageSources[0];
                const t = this.translateNow(shader, p.push, 0, p.storage, wraps);
                if (t.error) throw new Error("shader: " + t.error);
                const st = this.stageState(t, stage);
                v = { kind: "pipeline", desc: p.desc, groups: p.groups, push: p.push, bindGroups: new Map(), error: null,
                    gpu: this.device.createComputePipeline({ layout: "auto", compute: { module: st.module, entryPoint: st.entryPoint, constants: st.constants } }) };
            } catch (error) {
                this.warn("wrap-variant:" + error.message, "a pipeline's variant for its integer images' address modes failed: " + error.message);
            }
            p.wrapVariants.set(key, v);
            return v;
        }

        /**
         * A render pipeline with other stencil masks: the dynamic ones
         * (VK_DYNAMIC_STATE_STENCIL_COMPARE_MASK, _WRITE_MASK) of a draw, as
         * WebGPU's are the pipeline's. Made at the first draw with them; its
         * own bind groups (an automatic layout, as vertexVariant's)
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

        /**
         * A pipeline's vertex input as WebGPU's buffers: Vulkan's bindings at
         * their slots (`buffers`, `native`), and packed (`packed`, `fields`,
         * `strides`: each attribute a field of slot 0 (bindings of stride 0),
         * 1 (per vertex) or 2 (per instance), which draws repack into, for
         * what WebGPU cannot take: more than 8 bindings (ANGLE gives each
         * attribute one), strides not in dwords or above 2048, attributes not
         * aligned to their size, buffers bound at offsets not in dwords)
         */
        vertexLayout(d) {
            const buffers = [], attributes = [];
            let native = true;
            for (const b of d.buffers) {
                if (b.binding >= 8 || b.stride % 4 || b.stride > 2048) { native = false; continue; }
                // (slots of no binding: none, which WebGPU wants no buffer for)
                while (buffers.length <= b.binding) buffers.push(null);
                buffers[b.binding] = { arrayStride: b.stride, stepMode: b.rate ? "instance" : "vertex", attributes: [] };
            }
            for (const a of d.attributes) {
                const f = this.formats[a.format], b = d.buffers.find(x => x.binding === a.binding);
                if (!f || !f[2]) { this.warn("vertex-format" + a.format, "vertex format " + a.format + " is not done"); continue; }
                if (!b) continue;
                const bytes = vertexFormatBytes(f[2]);
                if (a.offset % Math.min(4, bytes) || b.stride && a.offset + bytes > b.stride) native = false;
                attributes.push({ a, b, format: f[2], bytes });
                if (buffers[a.binding]) buffers[a.binding].attributes.push({ format: f[2], offset: a.offset, shaderLocation: a.location });
            }
            const slots = [[], [], []], strides = [0, 0, 0], fields = [];
            for (const { a, b, format, bytes } of attributes) {
                const slot = b.stride === 0 ? 0 : b.rate ? 2 : 1;
                slots[slot].push({ format, offset: strides[slot], shaderLocation: a.location });
                fields.push({ slot, offset: strides[slot], binding: a.binding, from: a.offset, stride: b.stride, bytes });
                strides[slot] += align(bytes, 4);
            }
            const packed = slots.map((list, slot) => list.length ? { arrayStride: slot ? strides[slot] : 0, stepMode: slot === 2 ? "instance" : "vertex",
                attributes: list } : null);
            if (!native) this.stats.packedPipelines = (this.stats.packedPipelines || 0) + 1;
            return { native, buffers, packed, fields, strides };
        }

        /**
         * A draw's vertex input repacked into scratch buffers (vertexLayout's
         * `packed`), between two halves of its pass: { buffers (by slot),
         * variant (a pipeline of native input bound at an offset WebGPU
         * refuses: its packed variant) }, or null when the draw needs none.
         * The rows are a draw's vertices and instances from 0 (the shader's
         * vertex and instance indices are kept); for indexed and indirect
         * draws, as many as the bound buffers have (up to PACKED_ROWS)
         */
        packVertices(p, kind, b) {
            const layout = p.vertexLayout, s = this.state;
            if (!layout || layout.native && !p.desc.buffers.some(x => s.vertex[x.binding] && s.vertex[x.binding].offset % 4)) return null;
            const bound = f => {
                const v = s.vertex[f.binding], m = v && this.memory(v.memory);
                return m ? { v, m, size: Math.min(v.size, m.buffer.size - v.offset) } : null;
            };
            const available = f => {
                const x = bound(f);
                if (!x || x.size < f.from + f.bytes) return 0;
                return f.stride ? Math.floor((x.size - f.from - f.bytes) / f.stride) + 1 : 1;
            };
            const rows = [1, kind === 0 ? b[2] + b[0] : 0, kind === 0 ? b[3] + b[1] : kind === 1 ? b[4] + b[1] : 0];
            for (const f of layout.fields) {
                if (f.slot === 1 && kind !== 0 || f.slot === 2 && kind === 2) rows[f.slot] = Math.max(rows[f.slot], available(f));
            }
            if (rows[1] > PACKED_ROWS) { this.warn("packed-rows", "a draw's vertices repacked: the first " + PACKED_ROWS + " only"); rows[1] = PACKED_ROWS; }
            // (a slot of the pipeline's always gets a buffer, of one row at least: WebGPU wants each set)
            const buffers = layout.packed.map((l, slot) => l ?
                this.scratch(Math.max(1, rows[slot]) * (layout.strides[slot] || 4), BUFFER.VERTEX | BUFFER.STORAGE | BUFFER.COPY_DST) : null);
            const resume = !!this.pass;
            this.endPass();
            for (const f of layout.fields) {
                const x = bound(f), dst = buffers[f.slot], n = Math.min(rows[f.slot], available(f));
                if (!x || !dst || !n) continue;
                const from = f.stride || f.bytes, to = layout.strides[f.slot] || 4;
                this.repack(x.m.buffer, { offset: x.v.offset + f.from, pitch: from, image: from * n }, dst, { offset: f.offset, pitch: to, image: to * n }, f.bytes, n, 1);
            }
            this.stats.packedDraws = (this.stats.packedDraws || 0) + 1;
            if (resume) this.resumePass();
            return { buffers, variant: layout.native };
        }

        /**
         * GL's provoking vertex (VK_EXT_provoking_vertex's last vertex,
         * which ANGLE asks of every pipeline) is the last of a primitive,
         * WebGPU's the first: a draw of such a pipeline whose vertex shader
         * has flat outputs is drawn as a list of its primitives with their
         * vertices rotated, the last first (so triangles keep their winding);
         * indexed triangle fans so too, either way. Without indices the order
         * is made here once per count; with indices a compute pass (between
         * two halves of the render pass) rewrites them, restarts included, and
         * the draw is indirect (the count is the pass's). Indirect draws are
         * drawn as they are (warned).
         * @return {?Object} { topology, buffer, count | args }, or null: drawn as it is
         */
        provokingLast(p, kind, b) {
            const s = this.state, d = p.desc, fan = d.topology === 5;
            const last = !!d.provoking_last && p.flat;
            // (and primitive restart in lists, GL ES 3.0's, which WebGPU does in strips only: the
            // restart index dropped, the primitive it cuts short too)
            const listRestart = kind === 1 && d.restart && (d.topology === 0 || d.topology === 1 || d.topology === 3);
            if (!last && !(fan && kind === 1) && !listRestart) return null;
            if (kind === 2) {
                if (last) this.warn("provoking-indirect", "indirect draws of flat varyings keep WebGPU's first vertex");
                return null;
            }
            // (VkPrimitiveTopology as GX's kinds: triangle list 1, strip 2, line list 3, strip 4, triangle fan 5; and point list 6)
            const order = { 0: 6, 1: 3, 2: 4, 3: 1, 4: 2, 5: 5 }[d.topology];
            if (!order || !b[0] || order === 6 && kind === 0) return null;
            const list = order <= 2 || order === 5 ? "triangle-list" : order === 6 ? "point-list" : "line-list";
            if (kind === 0) {
                const key = order + ":" + b[0] + ":" + last;
                this.provokingIndices = this.provokingIndices || new Map();
                let entry = this.provokingIndices.get(key);
                if (!entry) {
                    const n = b[0], out = [];
                    if (order === 1) for (let k = 0; k + 2 < n; k += 3) out.push(k + 2, k, k + 1);
                    else if (order === 2) for (let k = 0; k + 2 < n; k++) out.push(...(k & 1 ? [k + 2, k + 1, k] : [k + 2, k, k + 1]));
                    else if (order === 3) for (let k = 0; k + 1 < n; k += 2) out.push(k + 1, k);
                    else if (order === 4) for (let k = 0; k + 1 < n; k++) out.push(k + 1, k);
                    else for (let k = 1; k + 1 < n; k++) out.push(...(last ? [k + 1, 0, k] : [k, k + 1, 0]));
                    if (!out.length) return null;
                    const data = Uint32Array.from(out);
                    const buffer = this.device.createBuffer({ size: align(data.byteLength, 4), usage: BUFFER.INDEX | BUFFER.COPY_DST });
                    this.device.queue.writeBuffer(buffer, 0, data);
                    if (this.provokingIndices.size >= 64) {
                        for (const old of this.provokingIndices.values()) old.buffer.destroy();
                        this.provokingIndices.clear();
                    }
                    entry = { buffer, count: out.length };
                    this.provokingIndices.set(key, entry);
                }
                return { topology: list, buffer: entry.buffer, count: entry.count };
            }
            const ib = s.index, m = ib && this.memory(ib.memory);
            if (!m) return null;
            const wide = ib.type === 1;
            if (!this.provokingPipeline) {
                const code = [
                    "struct P { count: u32, offset: u32, wide: u32, kind: u32, base: u32, instances: u32, first_instance: u32, last: u32, restart: u32 }",
                    "@group(0) @binding(0) var<storage, read> src: array<u32>;",
                    "@group(0) @binding(1) var<uniform> p: P;",
                    "@group(0) @binding(2) var<storage, read_write> dst: array<u32>;",
                    "@group(0) @binding(3) var<storage, read_write> args: array<u32, 5>;",
                    "fn index(i: u32) -> u32 {",
                    "    let at = p.offset + i;",
                    "    if (p.wide == 1u) { return src[at]; }",
                    "    let w = src[at >> 1u];",
                    "    return select(w & 0xFFFFu, w >> 16u, (at & 1u) == 1u);",
                    "}",
                    "@compute @workgroup_size(1) fn main() {",
                    "    let cut = select(0xFFFFu, 0xFFFFFFFFu, p.wide == 1u);",
                    "    var n = 0u;",
                    "    var start = 0u;",
                    "    var i = 0u;",
                    "    // lists: a primitive's indices gathered (a restart drops the one it cuts short), then the last first or as they were",
                    "    if (p.kind == 1u || p.kind == 3u || p.kind == 6u) {",
                    "        let per = select(select(1u, 2u, p.kind == 3u), 3u, p.kind == 1u);",
                    "        var k = 0u; var a = 0u; var b = 0u; var c = 0u;",
                    "        for (var j = 0u; j < p.count; j++) {",
                    "            let v = index(j);",
                    "            if (p.restart == 1u && v == cut) { k = 0u; continue; }",
                    "            if (k == 0u) { a = v; } else if (k == 1u) { b = v; } else { c = v; }",
                    "            k++;",
                    "            if (k < per) { continue; }",
                    "            if (per == 1u) { dst[n] = a; }",
                    "            else if (per == 2u) { dst[n] = select(a, b, p.last == 1u); dst[n + 1u] = select(b, a, p.last == 1u); }",
                    "            else if (p.last == 1u) { dst[n] = c; dst[n + 1u] = a; dst[n + 2u] = b; }",
                    "            else { dst[n] = a; dst[n + 1u] = b; dst[n + 2u] = c; }",
                    "            n += per; k = 0u;",
                    "        }",
                    "        args[0] = n; args[1] = p.instances; args[2] = 0u; args[3] = p.base; args[4] = p.first_instance;",
                    "        return;",
                    "    }",
                    "    loop {",
                    "        if (i >= p.count) { break; }",
                    "        // strips and fans: a restart starts another",
                    "        if (index(i) == cut) { start = i + 1u; i++; continue; }",
                    "        let k = i - start;",
                    "        if (p.kind == 2u && k >= 2u) {",
                    "            if ((k & 1u) == 1u) { dst[n] = index(i); dst[n + 1u] = index(i - 1u); dst[n + 2u] = index(i - 2u); }",
                    "            else { dst[n] = index(i); dst[n + 1u] = index(i - 2u); dst[n + 2u] = index(i - 1u); }",
                    "            n += 3u;",
                    "        }",
                    "        if (p.kind == 4u && k >= 1u) { dst[n] = index(i); dst[n + 1u] = index(i - 1u); n += 2u; }",
                    "        if (p.kind == 5u && k >= 2u) {",
                    "            let first = index(start);",
                    "            if (p.last == 1u) { dst[n] = index(i); dst[n + 1u] = first; dst[n + 2u] = index(i - 1u); }",
                    "            else { dst[n] = index(i - 1u); dst[n + 1u] = index(i); dst[n + 2u] = first; }",
                    "            n += 3u;",
                    "        }",
                    "        i++;",
                    "    }",
                    "    args[0] = n; args[1] = p.instances; args[2] = 0u; args[3] = p.base; args[4] = p.first_instance;",
                    "}",
                ].join("\n");
                this.provokingPipeline = this.device.createComputePipeline({ layout: "auto", compute: { module: this.device.createShaderModule({ code }), entryPoint: "main" } });
            }
            // b: indexCount, instanceCount, firstIndex, vertexOffset, firstInstance
            const offset = Math.floor(ib.offset / (wide ? 4 : 2)) + b[2];
            const dst = this.scratch(Math.max(16, b[0] * 3 * 4), BUFFER.STORAGE | BUFFER.INDEX);
            const args = this.scratch(32, BUFFER.STORAGE | BUFFER.INDIRECT);
            const params = this.device.createBuffer({ size: 48, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
            this.device.queue.writeBuffer(params, 0, Uint32Array.from([b[0], offset, wide ? 1 : 0, order, b[3] >>> 0, b[1], b[4], last ? 1 : 0,
                d.restart ? 1 : 0, 0, 0, 0]));
            this.transient.push(params);
            const group = this.device.createBindGroup({ layout: this.provokingPipeline.getBindGroupLayout(0), entries: [
                { binding: 0, resource: { buffer: m.buffer } }, { binding: 1, resource: { buffer: params } },
                { binding: 2, resource: { buffer: dst } }, { binding: 3, resource: { buffer: args } }] });
            const resume = !!this.pass;
            this.endPass();
            const compute = this.encoder().beginComputePass();
            compute.setPipeline(this.provokingPipeline);
            compute.setBindGroup(0, group);
            compute.dispatchWorkgroups(1);
            compute.end();
            this.stats.provokingDraws = (this.stats.provokingDraws || 0) + 1;
            if (resume) this.resumePass();
            return { topology: list, buffer: dst, args };
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
            if (this.pass && this.state.graphics && this.state.graphics.gpu) {
                this.attachmentCopies(this.state.graphics);
                // (swizzled views: their copies, drawn again where their textures were written)
                this.swizzleCopies(this.state.graphics, 0);
            }
            // (vertex input WebGPU cannot take: repacked, between two halves of the pass)
            const packed = this.pass && this.state.graphics && this.state.graphics.gpu ? this.packVertices(this.state.graphics, kind, b) : null;
            // (GL's provoking vertex with flat varyings, and indexed fans: the vertices reordered)
            const reorder = this.pass && this.state.graphics && this.state.graphics.gpu ? this.provokingLast(this.state.graphics, kind, b) : null;
            const p = this.state.graphics, pass = this.pass;
            if (!pass || !p || !p.gpu) {
                if (p && p.error) this.warn("draw-pipeline", "draws with a failed pipeline are skipped");
                return;
            }
            this.stats.draws++;
            const s = this.state;
            // (both faces culled: no triangle drawn; WebGPU culls one face or none)
            if (p.desc.cull === 3 && p.desc.topology >= 3 && !p.desc.discard) return;
            // viewport and scissor: the dynamic ones, or the pipeline's; within the target (WebGPU's rule)
            const viewport = p.desc.dynamic.includes(0) && s.viewport ? s.viewport :
                p.desc.viewport ? [p.desc.viewport.x, p.desc.viewport.y, p.desc.viewport.width, p.desc.viewport.height, p.desc.viewport.minDepth, p.desc.viewport.maxDepth] : null;
            // (a viewport flipped, or with its depths reversed: a variant of the vertex shader)
            const reversed = viewport && viewport[4] > viewport[5];
            const variant = (viewport && viewport[3] < 0 ? TRANSLATE.KEEP : 0) | (reversed ? TRANSLATE.REVERSE_DEPTH : 0);
            // (integer images sampled with samplers that repeat: their address modes in the shaders)
            const wraps = this.intWraps(p, 0);
            let q = wraps.length ? this.wrapVariant(p, variant, wraps) : variant ? this.vertexVariant(p, variant) : p;
            if (!q) return;
            // the stencil masks and reference of each face (the dynamic ones, or
            // the pipeline's): WebGPU's are one for both faces, so a draw whose
            // faces differ is drawn twice, a face each, the other culled
            const z = p.desc.depth, dyn = state => p.desc.dynamic.includes(state);
            const stencil = !p.desc.discard && q.descriptor && q.descriptor.depthStencil && q.descriptor.depthStencil.stencilFront &&
                !!q.descriptor.depthStencil.stencilFront.compare && z;
            const faceOf = back => {
                const fixed = back ? z.back : z.front;
                return { read: (dyn(6) ? back ? s.stencilBack[0] : s.stencilMasks[0] : fixed.read_mask) & 0xFF,
                    write: (dyn(7) ? back ? s.stencilBack[1] : s.stencilMasks[1] : fixed.write_mask) & 0xFF,
                    reference: dyn(8) ? back ? s.stencilBack[2] : s.stencilReference : fixed.reference };
            };
            let faces = [{ face: null, cull: null }];
            if (stencil) {
                const front = faceOf(false), back = faceOf(true);
                const same = front.read === back.read && front.write === back.write && front.reference === back.reference;
                // (lines and points are front faces; a pipeline culling one face draws the other)
                if (p.desc.topology < 3 || p.desc.cull === 2 || same) faces = [{ face: front, cull: null }];
                else if (p.desc.cull === 1) faces = [{ face: back, cull: null }];
                else faces = [{ face: front, cull: "back" }, { face: back, cull: "front" }];
            }
            // (the dynamic depth bias, when the pipeline biases: a variant per bias)
            if (p.desc.dynamic.includes(3) && p.desc.depth_bias && p.desc.topology >= 3 && s.depthBias && q.descriptor && q.descriptor.depthStencil) {
                const [constant, clamp, slope] = s.depthBias, ds = q.descriptor.depthStencil;
                if (ds.depthBias !== Math.round(constant) || ds.depthBiasSlopeScale !== slope || ds.depthBiasClamp !== clamp) {
                    q = this.variant(q, "bias:" + constant + ":" + clamp + ":" + slope, d => Object.assign(d, { depthStencil: Object.assign({}, ds,
                        { depthBias: Math.round(constant), depthBiasSlopeScale: slope, depthBiasClamp: clamp }) }));
                    if (!q) return;
                }
            }
            // (indexed strips: WebGPU wants the index format in the pipeline)
            const indexed = kind === 1 || kind === 2 && b[5];
            if (reorder && q.descriptor) {
                q = this.variant(q, "list:" + reorder.topology, d => Object.assign(d, { primitive: Object.assign({}, d.primitive,
                    { topology: reorder.topology, stripIndexFormat: undefined }) }));
                if (!q) return;
            }
            else if (indexed && (p.desc.topology === 2 || p.desc.topology === 4) && q.descriptor) {
                const format = s.index && s.index.type === 1 ? "uint32" : "uint16";
                q = this.variant(q, "strip:" + format, d => Object.assign(d, { primitive: Object.assign({}, d.primitive, { stripIndexFormat: format }) }));
                if (!q) return;
            }
            if (packed && packed.variant && q.descriptor) {
                q = this.variant(q, "packed", d => Object.assign(d, { vertex: Object.assign({}, d.vertex, { buffers: p.vertexLayout.packed }) }));
                if (!q) return;
            }
            const fan = p.desc.topology === 5;
            if (fan && kind !== 0 && !reorder) {
                this.warn("fan-indexed", "indexed and indirect triangle fans are not done");
                return;
            }
            // (a pipeline for other attachments: WebGPU would drop the whole batch for it)
            const attachments = q.attachments || (q.attachments = attachmentState(q.descriptor && q.descriptor.fragment ?
                q.descriptor.fragment.targets.map(t => t ? t.format : null) : [], q.descriptor && q.descriptor.depthStencil ? q.descriptor.depthStencil.format : "",
                q.descriptor && q.descriptor.multisample ? q.descriptor.multisample.count || 1 : 1));
            if (attachments !== this.passAttachments) {
                this.warn("attachments:" + attachments + ":" + this.passAttachments, "a draw's pipeline is for other attachments: " + attachments +
                    ", the pass's " + this.passAttachments + " (skipped)");
                return;
            }
            if (p.desc.push_size && p.groups.has(p.push)) this.pushWrite();
            // each face's pipeline (its masks, and the other face culled) and bind groups
            const draws = [];
            for (const { face, cull } of faces) {
                let f = q;
                if (face) f = this.maskedPipeline(f, face.read, face.write);
                if (f && cull) f = this.variant(f, "cull:" + cull, d => Object.assign(d, { primitive: Object.assign({}, d.primitive, { cullMode: cull }) }));
                if (!f) return;
                const groups = [];
                for (const group of p.groups.keys()) {
                    const bg = this.bindGroup(f, 0, group);
                    if (!bg) return;
                    groups.push([group, bg]);
                }
                draws.push({ f, groups, reference: face ? face.reference : z && z.front ? z.front.reference : 0 });
            }
            if (packed) packed.buffers.forEach((buffer, slot) => { if (buffer) pass.setVertexBuffer(slot, buffer); });
            else {
                // (the pipeline's bindings only: others may be bound where WebGPU refuses; one with
                // nothing bound reads zeros, as WebGPU would drop the whole batch for it)
                for (const { binding: slot } of p.desc.buffers) {
                    const v = s.vertex[slot], m = v && this.memory(v.memory);
                    if (slot >= 8) continue;
                    if (m) pass.setVertexBuffer(slot, m.buffer, v.offset, Math.min(v.size, m.buffer.size - v.offset));
                    else {
                        this.warn("vertex-unbound" + slot, "vertex binding " + slot + " has nothing bound (zeros)");
                        if (!this.zeroVertices) this.zeroVertices = this.device.createBuffer({ size: 1 << 16, usage: BUFFER.VERTEX });
                        pass.setVertexBuffer(slot, this.zeroVertices);
                    }
                }
            }
            if (viewport) {
                let [x, y, w, h, near, far] = viewport;
                // (flipped by the pipeline's variant: the rows it covers)
                if (h < 0) { y += h; h = -h; }
                const x0 = Math.max(0, x), y0 = Math.max(0, y);
                const x1 = Math.min(s.passWidth, x + w), y1 = Math.min(s.passHeight, y + h);
                if (reversed) [near, far] = [far, near];
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
            if (p.constantAlpha) pass.setBlendConstant({ r: blend[3], g: blend[3], b: blend[3], a: blend[3] });
            else pass.setBlendConstant({ r: blend[0], g: blend[1], b: blend[2], a: blend[3] });
            if ((kind === 1 || kind === 2 && b[5]) && !reorder) {
                const ib = s.index, m = ib && this.memory(ib.memory);
                if (!m) return;
                pass.setIndexBuffer(m.buffer, ib.type === 1 ? "uint32" : "uint16", ib.offset, Math.min(ib.size, m.buffer.size - ib.offset));
            }
            this.substitutes = null;
            for (const { f, groups, reference } of draws) {
                pass.setPipeline(f.gpu);
                for (const [group, bg] of groups) pass.setBindGroup(group, bg);
                pass.setStencilReference(reference);
                if (!this.issueDraw(pass, b, kind, reorder, fan)) return;
            }
        }

        /** A draw's call, its pipeline and state set: false when it cannot be drawn */
        issueDraw(pass, b, kind, reorder, fan) {
            if (reorder) {
                pass.setIndexBuffer(reorder.buffer, "uint32");
                if (reorder.args) pass.drawIndexedIndirect(reorder.args, 0);
                // (the vertices from the draw's first: its vertex index kept)
                else pass.drawIndexed(reorder.count, b[1], 0, b[2], b[3]);
            }
            else if (kind === 0 && fan) {
                if (b[0] < 3) return false;
                pass.setIndexBuffer(this.fanIndices(b[0]), "uint32");
                pass.drawIndexed(3 * (b[0] - 2), b[1], 0, b[2], b[3]);
            }
            else if (kind === 0) pass.draw(b[0], b[1], b[2], b[3]);
            else if (kind === 1) pass.drawIndexed(b[0], b[1], b[2], b[3] | 0, b[4]);
            else {
                const m = this.memory(b[0]);
                if (!m) return false;
                const offset = b[1] + b[2] * 0x100000000;
                for (let i = 0; i < b[3]; i++) {
                    if (b[5]) pass.drawIndexedIndirect(m.buffer, offset + i * b[4]);
                    else pass.drawIndirect(m.buffer, offset + i * b[4]);
                }
            }
            return true;
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
            for (const c of d.colors) if (c) { if (c.store === 1) this.warn("resume-discard", "a pass ended in its middle (a capture, a copy of an attachment it samples) whose attachments it discards"); c.load = 0; }
            if (d.depth) { d.depth.load = 0; d.depth.stencil_load = 0; }
            // (its occlusion queries go on in no pass: an occlusion query across a capture counts its first half)
            d.occlusion = 0;
            const pipeline = this.state.graphics;
            this.beginPass(d);
            this.state.graphics = pipeline;
        }

        /**
         * A draw that samples a texture attached to its pass (an input
         * attachment of its own subpass: framebuffer fetch, ANGLE's advanced
         * blending): WebGPU samples no attachment of the pass it is in, so
         * the pass ends, each such texture is copied, the pass goes on and
         * the draw samples the copies (what the attachments held before it,
         * the non-coherent behaviour). Multisampled ones are not copied.
         */
        attachmentCopies(p) {
            this.substitutes = null;
            if (!this.passTextures || !this.passTextures.size) return;
            const views = new Set();
            for (const [group, used] of p.groups) {
                const contents = this.state.groups[0].get(group);
                if (!contents) continue;
                for (const [binding, kind] of used) {
                    // (push constants share a group with the last set when there are 4)
                    if (group === p.push && binding === PUSH_BINDING || samplerBinding(binding) || !/^texture/.test(kind)) continue;
                    const d = contents.descriptors.get(descriptorKey(binding));
                    const v = d && this.objects.get(d.rid);
                    if (v && v.kind === "view" && this.passTextures.has(v.texture.texture)) views.add(v);
                }
            }
            if (!views.size) return;
            this.endPass();
            const substitutes = new Map();
            for (const v of views) {
                const t = v.texture;
                if (t.samples > 1) {
                    this.warn("fetch-ms", "a draw reading its multisampled attachment reads it as it is (not done)");
                    continue;
                }
                const copy = this.device.createTexture({ size: [t.width, Math.max(1, t.height), t.volume ? t.depth : t.layers], dimension: t.volume ? "3d" : "2d",
                    format: t.texture.format, mipLevelCount: t.mips, usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST });
                this.transient.push(copy);
                for (let mip = v.baseMip; mip < v.baseMip + v.mips; mip++) {
                    const width = Math.max(1, t.width >> mip), height = Math.max(1, Math.max(1, t.height) >> mip);
                    this.encoder().copyTextureToTexture({ texture: t.texture, mipLevel: mip, origin: [0, 0, t.volume ? 0 : v.baseLayer] },
                        { texture: copy, mipLevel: mip, origin: [0, 0, t.volume ? 0 : v.baseLayer] },
                        [width, height, t.volume ? Math.max(1, t.depth >> mip) : v.layers]);
                }
                substitutes.set(v, copy.createView(Object.assign({}, v.descriptor)));
            }
            this.resumePass();
            this.substitutes = substitutes;
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
            this.swizzleCopies(p, 1);
            // (integer images sampled with samplers that repeat: a variant of the shader)
            const wraps = this.intWraps(p, 1);
            const q = wraps.length ? this.wrapComputeVariant(p, wraps) : p;
            if (!q) return;
            // (the bind groups first: their copies are outside the compute pass)
            const writable = this.writableBuffers(p);
            const groups = [];
            for (const group of p.groups.keys()) {
                const bg = this.bindGroup(q, 1, group, writable);
                if (!bg) return;
                groups.push([group, bg]);
            }
            if (!this.computePass) {
                const encoder = this.encoder();
                this.computePass = encoder.beginComputePass();
            }
            const pass = this.computePass;
            pass.setPipeline(q.gpu);
            for (const [group, bg] of groups) pass.setBindGroup(group, bg);
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
                    // (depth written only where there is depth: a stencil8 attachment has none; nothing to
                    // return when nothing is written, the value still used, for the bind group)
                    const writesDepth = !color && depthFormat && depthFormat.hasDepth;
                    if (writesDepth) outputs.push("@builtin(frag_depth) depth: f32");
                    const code = [
                        "struct Value { bits: vec4<u32>, depth: f32 };",
                        "@group(0) @binding(0) var<uniform> value: Value;",
                        outputs.length ? "struct Out { " + outputs.join(", ") + " };" : "",
                        "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {",
                        "    let corner = vec2f(f32(i & 1u), f32(i >> 1u));",
                        "    return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);",
                        "}",
                        outputs.length ? "@fragment fn fs() -> Out {" : "@fragment fn fs() {",
                        "    _ = value;",
                        outputs.length ? "    var out: Out;" : "",
                        ...values.map(v => "    out." + v),
                        writesDepth ? "    out.depth = value.depth;" : "",
                        outputs.length ? "    return out;" : "",
                        "}",
                    ].join("\n");
                    const module = this.device.createShaderModule({ code });
                    const descriptor = {
                        layout: "auto",
                        vertex: { module, entryPoint: "vs" },
                        fragment: { module, entryPoint: "fs", targets: colors.map((f, i) => f ? { format: f.gpu, writeMask: color && i === a.index ? alphaMask(f) : 0 } : null) },
                        primitive: { topology: "triangle-strip" },
                        multisample: { count: info.samples > 1 ? 4 : 1 },
                    };
                    if (depthFormat) {
                        const depthToo = !color && a.aspect & ASPECT.DEPTH, stencilToo = !color && a.aspect & ASPECT.STENCIL;
                        descriptor.depthStencil = { format: depthFormat.gpu, depthWriteEnabled: !!depthToo && depthFormat.hasDepth, depthCompare: "always" };
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
