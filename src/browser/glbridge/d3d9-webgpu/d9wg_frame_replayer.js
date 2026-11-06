// GPU command encoding, validation and submission. The component holds one
// executor reference; session/device data stay with the active owner.
(function(global) {
    "use strict";
    function createClass(dependencies) {
        const { D3DQUERYTYPE_OCCLUSION, MAX_QUERY_SET_COUNT, EMPTY_OFFSETS, intersectRects, alignUp, BUFFER_USAGE_QUERY_RESOLVE, BUFFER_USAGE_COPY_SRC, BUFFER_USAGE_COPY_DST, BUFFER_USAGE_MAP_READ, MAP_MODE_READ, D9WG_RESPONSE_FAILED, D9WG_RESPONSE_OK, D3DQUERYTYPE_EVENT, D3DQUERYTYPE_TIMESTAMP, D3DQUERYTYPE_TIMESTAMPFREQ, D3DQUERYTYPE_TIMESTAMPDISJOINT } = dependencies;
        return class FrameReplayer {
            constructor(executor) { this.executor = executor; }
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
                const occlusionBudget = hasOcclusion
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
                    if (op.kind === "query-begin") {
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
                            endOcclusionSegment();
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
                        pass.drawIndexed(op.indexInfo.count, op.instanceCount || 1,
                                op.indexInfo.firstIndex, op.indexInfo.baseVertex);
                    } else {
                        // StartVertex is already folded into each stream's
                        // setVertexBuffer offset (see boundStreams), so
                        // firstVertex stays 0 here.
                        if ((op.instanceCount || 1) === 1)
                            pass.draw(op.vertexCount || 0);
                        else
                            pass.draw(op.vertexCount || 0, op.instanceCount);
                    }
                }
                closePass();
                // D3D9 permits an occlusion query to cross Present. Resolve
                // this frame's segments now, retain the accumulator, and open
                // a fresh WebGPU segment when the next frame starts.
                if (activeOcclusion) {
                    if (activeOcclusionSlots.length)
                        occlusionCompletions.push({ record: activeOcclusion,
                            query: activeOcclusion.query,
                            requestId: activeOcclusion.requestId,
                            metadata: activeOcclusion.metadata,
                            slots: activeOcclusionSlots.slice(),
                            final: false });
                    executor.activeOcclusion = activeOcclusion;
                }
                const queryReadbacks = [];
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
                        pending.querySet.destroy();
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
    const api = { createClass };
    global.D9WGFrameReplayer = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
