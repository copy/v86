// GPU command encoding, validation and submission. The component holds one
// executor reference; session/device data stay with the active owner.
(function(global) {
    "use strict";
    // Direct3D queries require an exact number of passing samples. WebGPU may
    // return only a boolean from a native occlusion query (notably on Metal).
    // An additive attachment participates in the original draw's depth,
    // stencil, shader discard and sample coverage, so it counts those samples
    // without replaying or changing their effects on the application's targets.
    const COUNTER_FORMAT = "r16float", COUNTER_PRIMITIVE_BUDGET = 256;

    function counterFitsFormats(formats, limits) {
        let bytes = 0;
        for (const format of formats) {
            if (!format) continue;
            const components = /^(rgba|bgra)/.test(format) ? 4 : /^rg/.test(format) ? 2 : 1;
            const width = /32/.test(format) ? 4 : /16/.test(format) ? 2 : 1;
            // Normalized RGBA8/BGRA8 attachments have an eight-byte render
            // target cost in WebGPU, independent of their copy footprint.
            const cost = /^(rgba|bgra)8.*norm/.test(format) ? 8
                : /^(rgb10a2|rg11b10)/.test(format) ? 8 : components * width;
            bytes = Math.ceil(bytes / width) * width + cost;
        }
        return formats.length + 1 <= (limits.maxColorAttachments || 8)
            && Math.ceil(bytes / 2) * 2 + 2 <= (limits.maxColorAttachmentBytesPerSample || 32);
    }

    function countedDrawSegments(topology, count, instances = 1) {
        const step = topology === "triangle-list" ? 3 : topology === "line-list" ? 2 : 1;
        const overlap = topology === "triangle-strip" ? 2 : topology === "line-strip" ? 1 : 0;
        const primitives = Math.max(0, Math.floor((count - overlap) / step));
        if (!primitives || !instances) return [];
        const segments = [];
        // Preserve primitive and instance order. A draw larger than the budget
        // must finish all chunks of one instance before starting the next.
        if (primitives <= COUNTER_PRIMITIVE_BUDGET) {
            const batch = Math.max(1, Math.floor(COUNTER_PRIMITIVE_BUDGET / primitives));
            for (let instance = 0; instance < instances; instance += batch)
                segments.push({first: 0, count, firstInstance: instance,
                    instanceCount: Math.min(batch, instances - instance)});
        } else {
            for (let instance = 0; instance < instances; ++instance)
                for (let first = 0; first < primitives; first += COUNTER_PRIMITIVE_BUDGET) {
                    const length = Math.min(COUNTER_PRIMITIVE_BUDGET, primitives - first);
                    segments.push({first: first * step, count: length * step + overlap,
                        firstInstance: instance, instanceCount: 1});
                }
        }
        return segments;
    }

    // Wrap generated WGSL rather than changing the guest shader body. The
    // wrapper retains each bound colour output and frag_depth, and adds one
    // independent additive output. Discards inside the body still kill it.
    function countedFragmentSource(source, location) {
        const entry = /@fragment\s+fn\s+d9_ps_main\s*\(/.exec(source);
        if (!entry) throw new Error("Missing D3D9 fragment entry point");
        const paramsAt = entry.index + entry[0].length;
        let end = paramsAt, nesting = 1;
        for (; end < source.length && nesting; ++end) {
            if (source[end] === "(") ++nesting;
            else if (source[end] === ")") --nesting;
        }
        if (nesting) throw new Error("Unterminated D3D9 fragment parameters");
        const params = source.slice(paramsAt, end - 1);
        const bodyAt = source.indexOf("{", end);
        const returned = source.slice(end, bodyAt).replace(/^\s*->\s*/, "").trim();
        const returnType = returned.replace(/@\w+\([^)]*\)\s*/g, "");
        const simple = /^@location\(0\)\s+vec4<f32>$/.test(returned);
        let members;
        if (simple) members = [{attribute: "@location(0)", name: "color0", type: "vec4<f32>", simple: true}];
        else {
            const structure = new RegExp("struct\\s+" + returnType + "\\s*\\{([^}]+)\\}").exec(source);
            if (!structure) throw new Error("Unknown D3D9 fragment result " + returnType);
            members = [...structure[1].matchAll(/((?:@\w+\([^)]*\)\s*)+)(\w+)\s*:\s*([^,;]+)[,;]/g)]
                .map(([, attribute, name, type]) => ({attribute: attribute.trim(), name, type: type.trim()}))
                .filter(member => {
                    const output = /@location\((\d+)\)/.exec(member.attribute);
                    return !output || Number(output[1]) < location;
                });
        }
        const argumentsList = params.split(",").filter(p => p.trim()).map(p =>
            p.replace(/@\w+\([^)]*\)\s*/g, "").trim().split(":")[0].trim()).join(", ");
        const helper = "fn d9_query_body(" + params.replace(/@\w+\([^)]*\)\s*/g, "") + ") -> " + returnType + " ";
        const body = source.slice(0, entry.index) + helper + source.slice(bodyAt);
        return body + "\nstruct D9QueryOutput {\n" + members.map(member =>
            "    " + member.attribute + " " + member.name + ": " + member.type + ",").join("\n") +
            "\n    @location(" + location + ") samples: vec4<f32>,\n};\n" +
            "@fragment\nfn d9_ps_main(" + params + ") -> D9QueryOutput {\n" +
            "    let value = d9_query_body(" + argumentsList + ");\n    var result: D9QueryOutput;\n" +
            members.map(member => "    result." + member.name + " = value" + (member.simple ? "" : "." + member.name) + ";").join("\n") +
            "\n    result.samples = vec4<f32>(1.0);\n    return result;\n}\n";
    }

    function sampleReductionSource(sampleCount) {
        const multisampled = sampleCount > 1;
        return `
@group(0) @binding(0) var counts: ${multisampled ? "texture_multisampled_2d<f32>" : "texture_2d<f32>"};
struct Total { low: atomic<u32>, high: atomic<u32>, };
@group(0) @binding(1) var<storage, read_write> total: Total;
var<workgroup> sums: array<u32, 64>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) pos: vec3<u32>,
        @builtin(local_invocation_index) lane: u32) {
    let size = textureDimensions(counts);
    var value = 0u;
    if (pos.x < size.x && pos.y < size.y) {
        ${multisampled ? `for (var sample = 0; sample < ${sampleCount}; sample++) {
            value += u32(round(textureLoad(counts, vec2<i32>(pos.xy), sample).r));
        }` : "value = u32(round(textureLoad(counts, vec2<i32>(pos.xy), 0).r));"}
    }
    sums[lane] = value;
    workgroupBarrier();
    for (var stride = 32u; stride > 0u; stride >>= 1u) {
        if (lane < stride) { sums[lane] += sums[lane + stride]; }
        workgroupBarrier();
    }
    if (lane == 0u) {
        let addend = sums[0];
        let previous = atomicAdd(&total.low, addend);
        if (previous > 0xffffffffu - addend) { atomicAdd(&total.high, 1u); }
    }
}`;
    }

    class SampleCounter {
        constructor(executor, encoder, frame) {
            this.executor = executor;this.encoder = encoder;this.frame = frame;
            this.textures = new Map();this.totals = new Map();this.current = null;
        }
        attachment(targets, record) {
            const device = this.executor.device, samples = targets.sampleCount || 1;
            const key = [targets.width, targets.height, samples].join(":");
            let texture = this.textures.get(key);
            if (!texture) {
                texture = device.createTexture({label: "D3D9 passing sample counter",
                    size: [targets.width, targets.height], format: COUNTER_FORMAT,
                    sampleCount: samples, usage: 0x10 | 0x04});
                this.textures.set(key, texture);this.frame.transientBuffers.push(texture);
            }
            this.current = {texture, targets, record};
            return {view: texture.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0]};
        }
        finishPass() {
            if (!this.current) return false;
            const {texture, targets, record} = this.current;this.current = null;
            if (!record) return false;
            const executor = this.executor, device = executor.device;
            let total = this.totals.get(record);
            if (!total) {
                const buffer = device.createBuffer({label: "D3D9 64-bit passing sample total", size: 16, usage: 0x80 | 0x04});
                total = {buffer};this.totals.set(record, total);
            }
            const samples = targets.sampleCount || 1;
            const pipelines = executor.sampleReductionPipelines ||= new Map();
            let pipeline = pipelines.get(samples);
            if (!pipeline) {
                pipeline = device.createComputePipeline({label: "D3D9 passing sample reduction", layout: "auto",
                    compute: {module: executor.moduleFor(sampleReductionSource(samples), "D3D9 sample reduction"), entryPoint: "main"}});
                pipelines.set(samples, pipeline);
            }
            const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
                {binding: 0, resource: texture.createView()}, {binding: 1, resource: {buffer: total.buffer}},
            ]});
            const pass = this.encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0, group);
            pass.dispatchWorkgroups(Math.ceil(targets.width / 8), Math.ceil(targets.height / 8));pass.end();
            return true;
        }
        readbacks(completions) {
            const result = [];
            for (const [record, total] of this.totals) {
                const matching = completions.filter(completion => completion.record === record);
                if (!matching.length) {this.frame.transientBuffers.push(total.buffer);continue;}
                const read = this.executor.device.createBuffer({label: "D3D9 passing sample readback", size: 16, usage: 0x08 | 0x01});
                this.encoder.copyBufferToBuffer(total.buffer, 0, read, 0, 8);
                result.push({kind: "occlusion", count: 1, completions: matching,
                    querySet: null, resolve: total.buffer, read});
            }
            return result;
        }
    }

    function createClass(dependencies) {
        const { D3DQUERYTYPE_OCCLUSION, MAX_QUERY_SET_COUNT, EMPTY_OFFSETS, intersectRects, alignUp, BUFFER_USAGE_QUERY_RESOLVE, BUFFER_USAGE_COPY_SRC, BUFFER_USAGE_COPY_DST, BUFFER_USAGE_MAP_READ, MAP_MODE_READ, D9WG_RESPONSE_FAILED, D9WG_RESPONSE_OK, D3DQUERYTYPE_EVENT, D3DQUERYTYPE_TIMESTAMP, D3DQUERYTYPE_TIMESTAMPFREQ, D3DQUERYTYPE_TIMESTAMPDISJOINT } = dependencies;
        return class FrameReplayer {
            constructor(executor) { this.executor = executor; }
            counterProgram(program, location) {
                const variants = program.counterPrograms ||= new Map();
                let variant = variants.get(location);
                if (!variant) {
                    const fragmentKey = program.fragmentKey + ":sample-counter:" + location;
                    variant = {...program, fragmentKey, queryCounter: true,
                        fragmentModule: this.executor.moduleFor(countedFragmentSource(
                            program.fragmentModule._d9wgSource, location), fragmentKey),
                        pipelineVariants: undefined, pipelineLayoutKey: undefined};
                    variants.set(location, variant);
                }
                return variant;
            }
            counterFitsFormats(formats) {
                return counterFitsFormats(formats, this.executor.device.limits || {});
            }
            countedDrawSegments(topology, count, instances) {
                return countedDrawSegments(topology, count, instances);
            }
            finishFrame(present = true) {
                const executor = this.executor;
                /*
                 * A Present with no frame at all still has work to do. An earlier
                 * flush can consume every recorded op, and onPresent() records
                 * nothing itself, so `executor.frame` is legitimately null here -- but
                 * the canvas hands out a fresh, undefined texture each frame, so
                 * without the copy below everything already submitted would stay in
                 * the owned back buffer and the screen would hold whatever the
                 * uninitialised canvas texture contains.
                 */
                const frame = executor.frame || (present ? executor.ensureFrame() : null);
                if (!frame) return;
                executor.frame = null;
                // Counted only for a real Present: a partial flush is a fragment
                // of a frame, and "this frame never cleared" is a statement about
                // whole frames.
                if (present) {
                    if (!frame.ops.length) ++executor.stats.framesWithNoOps;
                    else if (!frame.hasColorClear)
                        ++executor.stats.framesWithoutColorClear;
                } else if (frame.ops.length) {
                    ++executor.stats.frameFlushes;
                }
                /*
                 * `|| present` matters once a frame can be flushed early: the last
                 * flush may consume every remaining op, leaving a Present with
                 * nothing to replay -- and the canvas texture is a *new*, undefined
                 * texture each frame, so skipping the work would leave everything
                 * already submitted stuck in the owned back buffer, never reaching
                 * the screen. A Present always copies, even with no ops of its own.
                 */
                if (frame.ops.length || present) {
                    // One validation scope from the encoder to the submit: a frame
                    // WebGPU refuses is reported, and its queries are answered as
                    // failed instead of reading the zeros an invalid command
                    // buffer leaves behind
                    let settle;
                    const frameValid = new Promise(resolve => { settle = resolve; });
                    executor.device.pushErrorScope("validation");
                    try {
                        executor.replayFrame(frame, present, frameValid);
                    } finally {
                        executor.device.popErrorScope().then(error => {
                            if (error) {
                                ++executor.stats.framesRejected;
                                executor.gpuErrors.report("frame", error,
                                    { ops: frame.ops.length, present });
                            }
                            settle(!error);
                        }, () => settle(false));
                    }
                }
                if (present) ++executor.stats.presents;
                const start = frame.statStart || {};
                executor.lastFrameStats = {
                    pipelineCreations: executor.stats.pipelineCreations -
                        (start.pipelineCreations || 0),
                    bindGroupCreations: executor.stats.bindGroupCreations -
                        (start.bindGroupCreations || 0),
                    queueSubmits: executor.stats.queueSubmits -
                        (start.queueSubmits || 0),
                    renderPasses: executor.stats.renderPasses -
                        (start.renderPasses || 0),
                };
                const transientBuffers = frame.transientBuffers;
                if (transientBuffers && transientBuffers.length) {
                    const destroy = () => { for (const b of transientBuffers) b.destroy(); };
                    if (executor.device.queue && typeof executor.device.queue.onSubmittedWorkDone === "function")
                        executor.device.queue.onSubmittedWorkDone().then(destroy, destroy);
                    else
                        destroy();
                }
                if (present && executor.presentingDevice &&
                        typeof executor.options.onPresent === "function")
                    executor.options.onPresent(executor.presentingDevice.surface, executor.getStats());
                if (present) executor.presentingDevice = null;
            }

            replayFrame(frame, present, frameValid) {
                const executor = this.executor;
                if (executor.uploads) executor.uploads.flush();
                const encoder = executor.device.createCommandEncoder();
                const carriedOcclusion = executor.activeOcclusion || null;
                executor.activeOcclusion = null;
                const hasOcclusion = !!carriedOcclusion || frame.hasOcclusion;
                /* Any op can force a render-pass boundary through a target
                 * switch. One slot per recorded op is therefore a safe upper
                 * bound on the number of query segments. */
                const exactOcclusion = executor.options.occlusionMode !== "native";
                const counter = hasOcclusion && exactOcclusion ? new SampleCounter(executor, encoder, frame) : null;
                const occlusionBudget = hasOcclusion && !exactOcclusion
                    ? Math.min(MAX_QUERY_SET_COUNT, Math.max(1, frame.ops.length)) : 0;
                const occlusionQuerySet = occlusionBudget
                    ? executor.device.createQuerySet({ type: "occlusion",
                        count: occlusionBudget }) : null;
                let occlusionSlot = 0;
                let activeOcclusion = carriedOcclusion;
                let activeOcclusionSlots = [];
                let activeOcclusionSlot = -1;
                const occlusionCompletions = [];
                const fenceCompletions = [];
                // Ops recorded against the implicit back buffer land in the
                // owned texture, so this whole replay is independent of the
                // swap chain; getCurrentTexture() is acquired further down and
                // only when this finish actually presents.
                const backState = executor.presentingDevice ||
                    executor.devices.values().next().value || null;
                const backWidth = backState
                    ? executor.backBufferWidthOf(backState)
                    : (executor.backBufferTextureWidth || executor.canvas.width || 1);
                const backHeight = backState
                    ? executor.backBufferHeightOf(backState)
                    : (executor.backBufferTextureHeight || executor.canvas.height || 1);
                const backTexture = backState ? executor.ensureBackBufferTexture(
                    backWidth, backHeight, backState) : null;
                const swapView = executor.backBufferView;
                const swapSrgbView = executor.backBufferSrgbView;
                // GetRenderTargetData on the implicit back buffer reads the
                // owned texture, which -- unlike a canvas texture -- is still
                // valid in whatever later task the request arrives in.
                executor.lastSwapTexture = backTexture;
                // No restore copy: a D3D9 back buffer is routinely reused by
                // applications that redraw only the changing rectangles between
                // Presents (3DMark06's loading renderer does exactly that on
                // 3342 of its first 3343 frames), and the owned texture simply
                // still holds last frame's pixels, so loadOp:"load" is honest.
                // Every op carries the target set it was recorded against (see
                // renderTargetsFor). A pass covers the longest run of ops that
                // share a target set; a Clear always starts a new one, because
                // WebGPU expresses a clear only as a pass's loadOp.
                let pass = null;
                let openKey = null;
                let openTargets = null;
                /*
                 * Everything below is *pass* state in WebGPU: a setX persists
                 * until it is changed or the pass ends, so re-issuing an
                 * identical value is a no-op that still costs a full JS->Dawn
                 * crossing. Nine of them were issued per draw regardless of
                 * whether anything moved, which is invisible at the few hundred
                 * draws a scene makes and dominant at the hundred thousand
                 * 3DMark06's batch-size test makes -- there, consecutive draws
                 * differ only in their index range, so eight of the nine calls
                 * are pure overhead.
                 *
                 * `bound` shadows what this pass has actually been told. It is
                 * reset in beginPass() and nowhere else, because beginning a
                 * pass is exactly when WebGPU forgets all of it.
                 */
                let bound = null;
                const resetBoundState = () => {
                    bound = {
                        pipeline: null, bindGroup: null, dynamicOffsets: null,
                        blendR: NaN, blendG: NaN, blendB: NaN, blendA: NaN,
                        stencilReference: -1,
                        vpX: NaN, vpY: NaN, vpW: NaN, vpH: NaN,
                        vpMinZ: NaN, vpMaxZ: NaN,
                        scX: NaN, scY: NaN, scW: NaN, scH: NaN,
                        clipScissor: undefined, clip: null,
                        vertexBuffers: [],
                        indexBuffer: null, indexFormat: null, indexOffset: -1,
                    };
                };
                const sameOffsets = (a, b) => {
                    if (a === b) return true;
                    if (!a || !b || a.length !== b.length) return false;
                    for (let i = 0; i < a.length; ++i)
                        if (a[i] !== b[i]) return false;
                    return true;
                };
                const endOcclusionSegment = () => {
                    if (!pass || activeOcclusionSlot < 0) return;
                    pass.endOcclusionQuery();
                    activeOcclusionSlots.push(activeOcclusionSlot);
                    activeOcclusionSlot = -1;
                };
                const closePass = () => {
                    if (!pass) return;
                    endOcclusionSegment();
                    pass.end();
                    if (counter && counter.finishPass() && !activeOcclusionSlots.length)
                        activeOcclusionSlots.push(0);
                    executor.restoreColorPromotions(encoder, openTargets);
                    openTargets = null;
                    pass = null;
                    openKey = null;
                };
                const beginPass = (targets, clearColor, clearDepthStencil) => {
                    if (!clearColor) executor.unresolveStale(encoder, targets, swapView);
                    executor.prepareColorPromotions(encoder, targets);
                    openTargets = targets;
                    const descriptor = {
                        colorAttachments: targets.colors.map(color => color && {
                            ...executor.colorAttachmentFor(color, swapView, swapSrgbView),
                            loadOp: clearColor ? "clear" : "load",
                            storeOp: "store",
                            ...(clearColor ? { clearValue: clearColor } : {}),
                        }),
                    };
                    if (targets.queryCounter && counter)
                        descriptor.colorAttachments.push(counter.attachment(targets, activeOcclusion));
                    if (occlusionQuerySet)
                        descriptor.occlusionQuerySet = occlusionQuerySet;
                    if (targets.depthView) {
                        const clearsDepth = clearDepthStencil &&
                            clearDepthStencil.depth !== undefined;
                        const clearsStencil = clearDepthStencil &&
                            clearDepthStencil.stencil !== undefined;
                        descriptor.depthStencilAttachment = {
                            view: targets.depthView,
                            depthLoadOp: clearsDepth ? "clear" : "load",
                            depthStoreOp: "store",
                            stencilLoadOp: clearsStencil ? "clear" : "load",
                            stencilStoreOp: "store",
                            ...(clearsDepth ? {
                                depthClearValue: clearDepthStencil.depth } : {}),
                            ...(clearsStencil ? {
                                stencilClearValue: clearDepthStencil.stencil } : {}),
                        };
                    }
                    ++executor.stats.renderPasses;
                    const created = encoder.beginRenderPass(descriptor);
                    resetBoundState();
                    if (activeOcclusion && occlusionQuerySet) {
                        if (occlusionSlot < occlusionBudget) {
                            activeOcclusionSlot = occlusionSlot++;
                            created.beginOcclusionQuery(activeOcclusionSlot);
                        } else {
                            // more passes than one query set holds: the count
                            // would miss this pass's samples
                            activeOcclusion.failed = true;
                        }
                    }
                    return created;
                };
                for (const op of frame.ops) {
                    if (op.kind === "buffer-upload" || op.kind === "texture-upload") {
                        closePass();
                        if (op.writes) op.writes.msaaStale = true;
                        executor.uploads.replay(encoder, op);continue;
                    }
                    if (op.writes) op.writes.msaaStale = true;
                    // Preserve the application's draw when the adapter has no
                    // spare attachment capacity. Report an unavailable query,
                    // rather than fabricate a count or submit an invalid pass.
                    if (op.queryCounterUnavailable && activeOcclusion)
                        activeOcclusion.failed = true;
                    if (op.kind === "query-begin") {
                        if (op.query.destroyed) continue;
                        if (op.query.type === D3DQUERYTYPE_OCCLUSION) {
                            closePass();
                            activeOcclusion = { query: op.query,
                                requestId: op.requestId,
                                metadata: op.metadata, value: 0n,
                                failed: false, pending: Promise.resolve() };
                            activeOcclusionSlots = [];
                        }
                        continue;
                    }
                    if (op.kind === "query-end") {
                        if (op.query.type === D3DQUERYTYPE_OCCLUSION) {
                            closePass();
                            const record = activeOcclusion || {
                                query: op.query, requestId: op.requestId,
                                metadata: op.metadata, value: 0n,
                                failed: false, pending: Promise.resolve() };
                            record.requestId = op.requestId;
                            record.metadata = op.metadata;
                            occlusionCompletions.push({ record,
                                query: record.query,
                                requestId: op.requestId,
                                metadata: op.metadata,
                                slots: activeOcclusionSlots.slice(),
                                final: true });
                            activeOcclusion = null;
                            activeOcclusionSlots = [];
                        } else {
                            fenceCompletions.push(op);
                        }
                        continue;
                    }
                    if (op.kind === "copy") {
                        closePass();
                        encoder.copyTextureToTexture(op.source, op.destination,
                            op.size);
                        continue;
                    }
                    if (op.kind === "blit") {
                        // A blit is its own pass against its own attachment.
                        closePass();
                        const transient = executor.replayBlit(encoder, op, swapView);
                        if (transient) frame.transientBuffers.push(transient);
                        continue;
                    }
                    if (op.kind === "ddblit") {
                        // The DirectDraw blit: the same shape, plus colour
                        // keying, mirroring and index/palette storage, so it is
                        // replayed by ddraw_ops.js.
                        closePass();
                        const transient = executor.replayDDBlit(encoder, op,
                            swapView, backTexture);
                        if (transient) frame.transientBuffers.push(transient);
                        continue;
                    }
                    if (op.kind === "present-swap-chain") {
                        closePass();
                        executor.encodeSwapChainPresent(encoder, op, frame);
                        continue;
                    }
                    if (op.kind === "generate-mips") {
                        closePass();
                        for (const transient of
                                executor.replayGenerateMips(encoder, op))
                            frame.transientBuffers.push(transient);
                        continue;
                    }
                    if (op.kind === "depth-upload") {
                        closePass();
                        frame.transientBuffers.push(executor.encodeDepthTransfer(encoder,op.source,op.destination,true,op.x,op.y,op.width,op.height));
                        continue;
                    }
                    if (op.kind === "rect-clear") {
                        closePass();
                        const transient = executor.replayRectClear(encoder, op,
                            swapView, swapSrgbView);
                        if (transient) frame.transientBuffers.push(transient);
                        continue;
                    }
                    if (op.kind === "color-fill") {
                        closePass();
                        const transient = executor.replayColorFill(encoder, op);
                        if (transient) frame.transientBuffers.push(transient);
                        continue;
                    }
                    if (op.kind === "clear") {
                        closePass();
                        // A Clear that only touches depth still has to keep the
                        // colour already drawn this frame, and vice versa --
                        // hence the two independent load ops.
                        pass = beginPass(op.targets,
                            op.clearsColor ? op.color : null,
                            (op.clearsDepth || op.clearsStencil) ? {
                                ...(op.clearsDepth ? { depth: op.depth } : {}),
                                ...(op.clearsStencil ? { stencil: op.stencil } : {}),
                            } : null);
                        openKey = op.targets.key;
                        continue;
                    }
                    if (!pass || openKey !== op.targets.key) {
                        closePass();
                        pass = beginPass(op.targets, null, null);
                        openKey = op.targets.key;
                    }
                    if (bound.pipeline !== op.pipeline) {
                        pass.setPipeline(op.pipeline);
                        bound.pipeline = op.pipeline;
                    } else ++executor.stats.redundantStateSkipped;
                    const offsets = op.dynamicOffsets || EMPTY_OFFSETS;
                    if (bound.bindGroup !== op.bindGroup ||
                            !sameOffsets(bound.dynamicOffsets, offsets)) {
                        pass.setBindGroup(0, op.bindGroup, offsets);
                        bound.bindGroup = op.bindGroup;
                        bound.dynamicOffsets = offsets;
                    } else ++executor.stats.redundantStateSkipped;
                    const blend = op.blendConstant;
                    if (bound.blendR !== blend.r || bound.blendG !== blend.g ||
                            bound.blendB !== blend.b || bound.blendA !== blend.a) {
                        pass.setBlendConstant(blend);
                        bound.blendR = blend.r; bound.blendG = blend.g;
                        bound.blendB = blend.b; bound.blendA = blend.a;
                    } else ++executor.stats.redundantStateSkipped;
                    if (bound.stencilReference !== op.stencilReference) {
                        pass.setStencilReference(op.stencilReference);
                        bound.stencilReference = op.stencilReference;
                    } else ++executor.stats.redundantStateSkipped;
                    const vp = op.viewport;
                    const viewportMoved = bound.vpX !== vp.x ||
                        bound.vpY !== vp.y || bound.vpW !== vp.width ||
                        bound.vpH !== vp.height || bound.vpMinZ !== vp.minZ ||
                        bound.vpMaxZ !== vp.maxZ;
                    if (viewportMoved) {
                        pass.setViewport(vp.x, vp.y, vp.width, vp.height,
                                vp.minZ, vp.maxZ);
                        bound.vpX = vp.x; bound.vpY = vp.y;
                        bound.vpW = vp.width; bound.vpH = vp.height;
                        bound.vpMinZ = vp.minZ; bound.vpMaxZ = vp.maxZ;
                    } else ++executor.stats.redundantStateSkipped;
                    // A D3D9 viewport clips; a WebGPU one only maps NDC to
                    // pixels. Without a matching scissor, geometry an app
                    // expected the viewport to cut off is drawn across the whole
                    // target instead -- which is why the clip rect is the
                    // viewport intersected with D3DRS_SCISSORTESTENABLE's rect
                    // (D3D9 applies both), not just the latter.
                    //
                    // The intersection is memoised as well as skipped, because
                    // recomputing it allocates a rect per draw. Keyed on the
                    // viewport having *moved* rather than on op.viewport's
                    // identity: every op carries its own copy of the viewport,
                    // so an identity check would miss on every single draw. The
                    // scissor is compared by identity because it is null --
                    // literally the same null -- whenever D3DRS_SCISSORTESTENABLE
                    // is off, which is the case this is here to make fast.
                    let clip = bound.clip;
                    if (!clip || viewportMoved || bound.clipScissor !== op.scissor) {
                        clip = intersectRects(vp, op.scissor,
                                op.targets.width, op.targets.height);
                        bound.clip = clip;
                        bound.clipScissor = op.scissor;
                    }
                    if (bound.scX !== clip.x || bound.scY !== clip.y ||
                            bound.scW !== clip.width || bound.scH !== clip.height) {
                        pass.setScissorRect(clip.x, clip.y, clip.width, clip.height);
                        bound.scX = clip.x; bound.scY = clip.y;
                        bound.scW = clip.width; bound.scH = clip.height;
                    } else ++executor.stats.redundantStateSkipped;
                    for (let slot = 0; slot < op.vertexBuffers.length; ++slot) {
                        const binding = op.vertexBuffers[slot];
                        const previous = bound.vertexBuffers[slot];
                        if (previous && previous.buffer === binding.buffer &&
                                previous.offset === binding.offset) {
                            ++executor.stats.redundantStateSkipped;
                            continue;
                        }
                        pass.setVertexBuffer(slot, binding.buffer, binding.offset);
                        bound.vertexBuffers[slot] = binding;
                    }
                    if (op.indexInfo) {
                        if (bound.indexBuffer !== op.indexInfo.buffer ||
                                bound.indexFormat !== op.indexInfo.format ||
                                bound.indexOffset !== op.indexInfo.offset) {
                            pass.setIndexBuffer(op.indexInfo.buffer,
                                    op.indexInfo.format, op.indexInfo.offset);
                            bound.indexBuffer = op.indexInfo.buffer;
                            bound.indexFormat = op.indexInfo.format;
                            bound.indexOffset = op.indexInfo.offset;
                        } else ++executor.stats.redundantStateSkipped;
                        if (op.firstInstance !== undefined)
                            pass.drawIndexed(op.indexInfo.count, op.instanceCount || 1,
                                op.indexInfo.firstIndex, op.indexInfo.baseVertex, op.firstInstance);
                        else
                            pass.drawIndexed(op.indexInfo.count, op.instanceCount || 1,
                                op.indexInfo.firstIndex, op.indexInfo.baseVertex);
                    } else {
                        // StartVertex is already folded into each stream's
                        // setVertexBuffer offset (see boundStreams), so
                        // firstVertex stays 0 here.
                        if (op.firstInstance !== undefined)
                            pass.draw(op.vertexCount || 0, op.instanceCount || 1, op.firstVertex || 0, op.firstInstance);
                        else if ((op.instanceCount || 1) === 1)
                            pass.draw(op.vertexCount || 0);
                        else
                            pass.draw(op.vertexCount || 0, op.instanceCount);
                    }
                    // Every instrumented op has at most 256 primitives, keeping
                    // each per-sample half-float sum exact even under overdraw.
                    if (op.targets.queryCounter) closePass();
                }
                closePass();
                // D3D9 permits an occlusion query to cross Present. Resolve
                // this frame's segments now, retain the accumulator, and open
                // a fresh WebGPU segment when the next frame starts.
                if (activeOcclusion && !activeOcclusion.query.destroyed) {
                    if (activeOcclusionSlots.length)
                        occlusionCompletions.push({ record: activeOcclusion,
                            query: activeOcclusion.query,
                            requestId: activeOcclusion.requestId,
                            metadata: activeOcclusion.metadata,
                            slots: activeOcclusionSlots.slice(),
                            final: false });
                    executor.activeOcclusion = activeOcclusion;
                }
                const queryReadbacks = counter ? counter.readbacks(occlusionCompletions) : [];
                const encodeQueryReadback = (querySet, count, completions,
                        kind) => {
                    if (!querySet || !count || !completions.length) return;
                    const byteCount = alignUp(count * 8, 256);
                    const resolve = executor.device.createBuffer({
                        label: "D3D9 " + kind + " query resolve",
                        size: byteCount,
                        usage: BUFFER_USAGE_QUERY_RESOLVE |
                            BUFFER_USAGE_COPY_SRC,
                    });
                    const read = executor.device.createBuffer({
                        label: "D3D9 " + kind + " query readback",
                        size: byteCount,
                        usage: BUFFER_USAGE_COPY_DST | BUFFER_USAGE_MAP_READ,
                    });
                    encoder.resolveQuerySet(querySet, 0, count, resolve, 0);
                    encoder.copyBufferToBuffer(resolve, 0, read, 0,
                        count * 8);
                    queryReadbacks.push({ kind, count, completions, querySet,
                        resolve, read });
                };
                encodeQueryReadback(occlusionQuerySet, occlusionSlot,
                    occlusionCompletions.filter(item => item.slots.length),
                    "occlusion");
                if (occlusionQuerySet && !occlusionSlot)
                    frame.transientBuffers.push(occlusionQuerySet);
                /* A query enclosing no draws still has a real answer: zero
                 * visible samples. It needs only the queue fence, not a query
                 * buffer mapping. */
                for (const completion of occlusionCompletions) {
                    if (!completion.slots.length && completion.final)
                        fenceCompletions.push({ ...completion,
                            query: completion.query, requestId: completion.requestId,
                            metadata: completion.metadata, zeroOcclusion: true });
                }
                // The one place the swap chain is touched, and it happens in
                // the same synchronous stretch as the submit that consumes it,
                // which is the whole rule getCurrentTexture() imposes.
                if (present) executor.encodePrimaryPresent(encoder, frame, backTexture);
                executor.uploadUniformStaging();
                executor.device.queue.submit([encoder.finish()]);
                ++executor.stats.queueSubmits;

                // Occlusion counts are read once the frame is known to be valid:
                // an invalid command buffer leaves the resolve buffer zeroed,
                // which would read as "fully occluded"
                for (const pending of queryReadbacks) {
                    const release = () => {
                        pending.read.destroy();
                        pending.resolve.destroy();
                        if (pending.querySet) pending.querySet.destroy();
                    };
                    const mapping = Promise.all([pending.read.mapAsync(MAP_MODE_READ), frameValid]).then(([, valid]) => {
                        const source = new DataView(pending.read.getMappedRange());
                        const values = new Map();
                        for (const completion of pending.completions) {
                            let value = 0n;
                            for (const slot of completion.slots)
                                value += source.getBigUint64(slot * 8, true);
                            values.set(completion, value);
                        }
                        pending.read.unmap();
                        release();
                        return valid ? { values } : { error: "WebGPU rejected the frame" };
                    }).catch(error => {
                        ++executor.stats.queryFailures;
                        release();
                        executor.warnOnce("query-map", "GPU query readback failed", { message: String(error) });
                        return { error };
                    });
                    for (const completion of pending.completions) {
                        const record = completion.record;
                        record.pending = executor.trackReadback(record.pending.then(() => mapping)
                            .then(result => {
                                if (result.error) record.failed = true;
                                else record.value += result.values.get(completion);
                                if (!completion.final) return;
                                ++executor.stats.occlusionQueriesResolved;
                                executor.writeQueryResponse(record.query,
                                    completion.requestId, record.value,
                                    record.failed ? D9WG_RESPONSE_FAILED
                                        : D9WG_RESPONSE_OK,
                                    completion.metadata);
                            }));
                    }
                }
                if (!fenceCompletions.length) return;
                const fenced = executor.device.queue.onSubmittedWorkDone().then(() => frameValid, () => false);
                executor.trackReadback(fenced.then(valid => {
                    for (const completion of fenceCompletions) {
                        if (completion.zeroOcclusion) {
                            const record = completion.record;
                            record.pending = executor.trackReadback(record.pending.then(() => {
                                if (!valid) record.failed = true;
                                ++executor.stats.occlusionQueriesResolved;
                                executor.writeQueryResponse(record.query,
                                    completion.requestId, record.value,
                                    record.failed ? D9WG_RESPONSE_FAILED
                                        : D9WG_RESPONSE_OK,
                                    completion.metadata);
                            }));
                            continue;
                        }
                        if (!valid) {
                            executor.writeQueryResponse(completion.query,
                                completion.requestId, 0,
                                D9WG_RESPONSE_FAILED, completion.metadata);
                            continue;
                        }
                        let value = 0n;
                        switch (completion.query.type) {
                        case D3DQUERYTYPE_EVENT:
                            value = 1n;
                            ++executor.stats.eventQueriesResolved;
                            break;
                        case D3DQUERYTYPE_TIMESTAMP:
                            value = BigInt(Math.floor(global.performance.now() * 1000000));
                            ++executor.stats.timestampQueriesResolved;
                            break;
                        case D3DQUERYTYPE_TIMESTAMPFREQ:
                            value = 1000000000n;
                            break;
                        case D3DQUERYTYPE_TIMESTAMPDISJOINT:
                        default:
                            value = 0n;
                            break;
                        }
                        executor.writeQueryResponse(completion.query,
                            completion.requestId, value, D9WG_RESPONSE_OK,
                            completion.metadata);
                    }
                }));
            }
        };
    }
    const api = { createClass, countedDrawSegments, countedFragmentSource, sampleReductionSource, counterFitsFormats };
    global.D9WGFrameReplayer = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
