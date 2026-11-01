// Frame and draw recording on the active owner. Methods install directly on
// the executor prototype, adding no per-draw forwarding layer.
(function(global) {
    "use strict";
    function createMethods(dependencies) {
        const { D3DRS_ZENABLE, D3DSTREAMSOURCE_INSTANCEDATA, D3DRS_POINTSPRITEENABLE, DEFAULT_ATTRIBUTE_STREAM, D3DRS_SCISSORTESTENABLE, D3DQUERYTYPE_OCCLUSION } = dependencies;
        class RecordedFrame {
            constructor(serial, statStart) {
                this.ops = [];
                this.transientBuffers = [];
                this.serial = serial;
                this.statStart = statStart;
                this.hasColorClear = false;
                this.hasOcclusion = false;
            }
            record(op) {
                this.ops.push(op);
                this.hasColorClear ||= op.kind === "clear" && op.clearsColor;
                this.hasOcclusion ||= op.kind === "query-begin" && op.query.type === D3DQUERYTYPE_OCCLUSION;
            }
        }
        return {
            // A "frame" here is pure JS bookkeeping -- a list of pending clear/
            // draw operations -- with no WebGPU objects created yet. This is
            // deliberate: a canvas's context.getCurrentTexture() is only valid
            // for the task that acquired it; once control returns to the
            // browser's event loop, that texture is liable to be presented and
            // invalidated out from under you ("Destroyed texture ... used in a
            // submit"). A single D3D9 frame's Clear/Draw/Present calls do not
            // reliably arrive in one task: d3d9_proxy.c flushes a partial batch
            // over PCI whenever the DMA ring fills up (reserve_command_locked's
            // intermediate submit_batch_locked(FALSE)), and each such PCI record
            // is delivered to this executor as a separate worker postMessage --
            // a separate macrotask. Acquiring the swapchain texture eagerly on
            // the first Clear of a frame and holding it until a much-later
            // Present-carrying submit is exactly the pattern that goes stale.
            // Recording lightweight ops now and only turning them into real
            // WebGPU calls inside finishFrame() -- acquired, recorded, and
            // submitted in one synchronous stretch -- avoids that regardless of
            // how many separate PCI submits contributed to the frame.
            ensureFrame() {
                if (this.frame) return this.frame;
                if (this.uploads) this.uploads.reset();
                // `serial` identifies this frame for the write-after-record check in
                // applyBufferUpdate(); it must be unique per frame, never reused.
                // Chunks are retained, only the write position rewinds: WebGPU
                // orders queue.writeBuffer against already-submitted work, so
                // rewinding after the previous frame's Present cannot overwrite
                // bytes a queued draw still has to read.
                this.uniformRingIndex = 0;
                this.uniformRingCursor = 0;
                this.frame = new RecordedFrame(++this.frameSerial, {
                    pipelineCreations: this.stats.pipelineCreations,
                    bindGroupCreations: this.stats.bindGroupCreations,
                    queueSubmits: this.stats.queueSubmits,
                    renderPasses: this.stats.renderPasses,
                });
                return this.frame;
            },
            // If a command throws partway through a batch (see submit()'s catch
            // handler), this.frame may be left holding recorded-but-unreplayed
            // ops. Since no WebGPU render pass/encoder exists yet at this point
            // (those are only created in finishFrame(), at Present time), there
            // is nothing to end -- just drop the ops and free any transient
            // buffers already created for them so the next frame starts clean.
            discardFrame() {
                const frame = this.frame;
                // An occlusion query open across the dropped work has lost samples
                if (this.activeOcclusion) this.activeOcclusion.failed = true;
                if (!frame) return;
                this.frame = null;
                this.failDroppedQueries(frame.ops);
                for (const buffer of frame.transientBuffers) buffer.destroy();
            },
            // Builds the pipeline/uniform buffer/bind group eagerly (none of
            // those are tied to the swapchain's current texture, so there is no
            // staleness concern in creating them now) but only *records* the
            // draw as a pending op -- see the comment on ensureFrame() for why
            // the actual pass.draw()/drawIndexed() call must wait until
            // finishFrame() replays it against a freshly-acquired texture.
            //
            // The stride each stream contributes is the one the application bound
            // via SetStreamSource (or that a Draw*UP command carried). It must
            // never be inferred from the vertex declaration: a declaration's
            // consumed elements are only part of the vertex, so a computed stride
            // is too small whenever the format carries anything the shader skips
            // (NORMAL, extra texcoords, padding) and every vertex after the first
            // would then be fetched from the wrong offset.
            recordDraw(state, elements, which, geometry) {
                const targets = this.renderTargetsFor(state);
                if (!targets) {
                    this.noteDroppedDraw(which, state,
                        ["no usable colour render target is bound"]);
                    return;
                }
                // D3DRS_FILLMODE. WebGPU has no polygon mode, so wireframe is
                // reached by rewriting the topology and the indices instead: every
                // triangle becomes its three edges as a line list. Done here, at
                // the single funnel every draw path reaches, rather than at the
                // four Draw* entry points -- and after the fan conversion above it,
                // so a fan is already an ordinary triangle list by the time it
                // arrives.
                geometry = this.applyFillMode(state, geometry) || geometry;
                // A draw against a stand-in depth attachment that nothing cleared
                // is the one case where standing in changed the image; anything
                // else has no earlier contents to have lost.
                if (targets.substituteDepth &&
                        (state.renderStates.get(D3DRS_ZENABLE) || 0) !== 0)
                    this.noteSubstituteDepthUse(targets, false);
                const pipelineState = this.pipelineStateFor(state, targets);
                // A point-list that came from D3DFILL_POINT is not a point
                // sprite: sprite expansion is what D3DRS_POINTSPRITEENABLE asks
                // for, and a wireframe-mode triangle mesh asked for neither.
                const pointExpansion = geometry.topology === "point-list" &&
                    !geometry.indexInfo && !geometry.fromFillMode;
                const instanceCount = this.drawInstanceCount(state);
                const hasInstanceStream = Array.from(state.streams.values()).some(stream =>
                    (((stream.frequency ?? 1) >>> 0) &
                        D3DSTREAMSOURCE_INSTANCEDATA) !== 0);
                if (instanceCount > 1 && !geometry.indexInfo && !pointExpansion) {
                    this.noteDroppedDraw(which, state,
                        ["D3D9 indexed instancing requires an indexed draw"]);
                    return;
                }
                if (pointExpansion && (instanceCount !== 1 || hasInstanceStream)) {
                    this.noteDroppedDraw(which, state,
                        ["point expansion cannot share WebGPU instance slots with D3D9 instancing"]);
                    return;
                }
                const pointSprite = pointExpansion &&
                    (state.renderStates.get(D3DRS_POINTSPRITEENABLE) || 0) !== 0;
                const program = this.programFor(state, elements, pipelineState,
                    { pointExpansion, pointSprite });
                if (program.error) {
                    if (program.shaderError) ++this.stats.drawsSkippedForBadShader;
                    this.noteDroppedDraw(which, state, [program.error]);
                    return;
                }
                const pipeline = this.pipelineFor(program, pipelineState,
                    pointExpansion ? "triangle-list" : geometry.topology,
                    pointExpansion ? undefined : geometry.stripIndexFormat);
                if (pipeline._d9wgRejected) {
                    this.noteDroppedDraw(which, state,
                        ["WebGPU rejected the pipeline: " + pipeline._d9wgRejected]);
                    return;
                }
                // The bind group captures concrete GPUTextureView objects. Create
                // the frame first so bindGroupFor can mark those textures as read;
                // a later UPDATE_TEXTURE can then rename instead of retroactively
                // changing this already-recorded draw. A draw without a preceding
                // Clear is legal and used by War3's UI passes, so relying on Clear
                // to create the frame misses exactly those textures.
                const frame = this.ensureFrame();
                const constants = this.constantBufferFor(state, program);
                let binding;
                this.recordingBindings = true;
                try { binding = this.bindGroupFor(state, pipeline, program, constants); }
                finally { this.recordingBindings = false; }
                if (binding.group._d9wgRejected) {
                    this.noteDroppedDraw(which, state,
                        ["WebGPU rejected the bind group: " + binding.group._d9wgRejected]);
                    return;
                }
                const prepared = this.prepareInstanceStreams(
                    geometry.streams, instanceCount);
                if (prepared.error) {
                    this.noteDroppedDraw(which, state, [prepared.error]);
                    return;
                }
                geometry = { ...geometry, streams: prepared.streams };
                // Bind each stream the pipeline declared a layout for, in the same
                // order, so slot N in the pipeline is slot N here.
                const vertexBuffers = [];
                for (const layout of program.vertexBuffers) {
                    if (layout.stream === DEFAULT_ATTRIBUTE_STREAM) {
                        vertexBuffers.push({ buffer: this.defaultAttributeBuffer(), offset: 0 });
                        continue;
                    }
                    const binding = geometry.streams.get(layout.stream);
                    if (!binding) {
                        this.noteDroppedDraw(which, state,
                            ["stream " + layout.stream + " is referenced by the " +
                             "declaration but not bound"]);
                        return;
                    }
                    vertexBuffers.push({ buffer: binding.buffer, offset: binding.offset });
                }
                // Mark every buffer this draw reads as "observed at this frame's
                // contents". applyBufferUpdate() uses that to notice a write that
                // would retroactively change what an already-recorded draw sees.
                for (const layout of program.vertexBuffers) {
                    const binding = geometry.streams.get(layout.stream);
                    if (binding && binding.resource)
                        binding.resource.frameReferenced = frame.serial;
                }
                if (geometry.indexResource)
                    geometry.indexResource.frameReferenced = frame.serial;
                // D3DRS_SCISSORTESTENABLE gates the rect; without it D3D9 ignores
                // whatever SetScissorRect last set.
                const scissorEnabled =
                    (state.renderStates.get(D3DRS_SCISSORTESTENABLE) || 0) !== 0 &&
                    !!state.scissorRect;
                if (scissorEnabled) ++this.stats.drawsWithScissor;
                const attachmentCount = Math.max(1, Math.min(4,
                    (targets.colors && targets.colors.length) || 1));
                ++this.mrtAttachmentDraws[attachmentCount];
                pipeline._d9wgDrawCount = (pipeline._d9wgDrawCount || 0) + 1;
                const drawPath = (state.vertexShaderHandle ||
                    state.pixelShaderHandle) ? "programmable" : "fixed";
                // References are retained, not expanded, on the hot draw path.
                // blackScreenReport() serialises the two most recent paths only
                // when explicitly requested, avoiding per-draw diagnostic copies
                // during a real benchmark run.
                this.lastDraws[drawPath] = {
                    which, state, elements, geometry, program, pipelineState,
                    targets, pipeline,
                };
                frame.record({
                    kind: "draw", pipeline, bindGroup: binding.group,
                    dynamicOffsets: binding.dynamicOffsets, targets,
                    viewport: { ...state.viewport },
                    scissor: scissorEnabled ? { ...state.scissorRect } : null,
                    blendConstant: pipelineState.blendConstant,
                    stencilReference: pipelineState.stencilReference,
                    vertexBuffers, indexInfo: geometry.indexInfo,
                    vertexCount: pointExpansion ? 6 : geometry.vertexCount,
                    instanceCount: pointExpansion ? geometry.vertexCount : instanceCount,
                });
                if (pointExpansion) {
                    ++this.stats.pointSpriteDraws;
                    this.stats.pointSpriteInstances += geometry.vertexCount || 0;
                }
                if (!pointExpansion && instanceCount > 1) {
                    ++this.stats.instancedDraws;
                    this.stats.instancesDrawn += instanceCount;
                }
                // The pointer is almost always the final thing a frame draws, so
                // the texture bound by the last draw is the quickest way to name
                // the cursor's texture without hunting through the whole atlas set.
                if (program.samplerIndices.length)
                    this.stats.lastDrawTexture =
                        state.textures.get(program.samplerIndices[0]) || 0;
                if (state.vertexShaderHandle || state.pixelShaderHandle)
                    ++this.stats.programmableDraws;
                if (geometry.indexInfo) ++this.stats.indexedDrawCalls;
                else ++this.stats.drawCalls;
            },
            // Draw*UP carries its own stride rather than having one bound through
            // SetStreamSource, so vertexBufferLayoutsFor() -- which reads
            // state.streams -- needs stream 0 temporarily standing in for it.
            recordDrawWithStride(state, elements, which, geometry, stride) {
                const saved = state.streams.get(0);
                state.streams.set(0, { bufferHandle: 0, stride, offsetInBytes: 0,
                    frequency: 1 });
                try {
                    this.recordDraw(state, elements, which, geometry);
                } finally {
                    if (saved) state.streams.set(0, saved);
                    else state.streams.delete(0);
                }
            },
        };
    }
    const api = { createMethods };
    global.D9WGDrawRecorder = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
