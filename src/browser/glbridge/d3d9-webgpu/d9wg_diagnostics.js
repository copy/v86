// Optional D3D9 diagnostics. Loaded only after an explicit debug request.
// Snapshot and texture-preview capture starts at that request; rendering and
// cheap error/stat counters do not depend on this module.
(function(global) {
    "use strict";
    function createMethods(deps) {
        const { TEXTURE_FORMAT_NAMES, RESOURCE_VERTEX_SHADER, RESOURCE_PIXEL_SHADER,
            D3DRS_SCISSORTESTENABLE, intersectRects } = deps;
        return {
dumpSmallTextures(options) {
            const settings = options || {};
            const out = [];
            for (const [handle, resource] of this.resources) {
                if (!resource.preview) continue;
                if (settings.handle !== undefined && handle !== settings.handle)
                    continue;
                const { width, height, rgba } = resource.preview;
                let url = null;
                let error = null;
                try {
                    // A plain <canvas>, not OffscreenCanvas: only the former
                    // has toDataURL. OffscreenCanvas offers convertToBlob,
                    // which is async and cannot be returned from here -- that
                    // mismatch is why the first version of this helper
                    // reported url: null for every texture.
                    if (typeof document === "undefined")
                        throw new Error("no document to render into");
                    const canvas = document.createElement("canvas");
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext("2d");
                    const image = context.createImageData(width, height);
                    image.data.set(rgba.subarray(0, width * height * 4));
                    context.putImageData(image, 0, 0);
                    url = canvas.toDataURL();
                } catch (failure) {
                    error = failure && failure.message ? failure.message
                        : String(failure);
                }
                const entry = { handle, format: resource.format,
                    formatName: TEXTURE_FORMAT_NAMES[resource.format] ||
                        ("0x" + (resource.format >>> 0).toString(16)),
                    size: width + "x" + height,
                    declaredLevels: resource.levelCount,
                    uploadedLevels: resource.uploadedLevels
                        ? [...resource.uploadedLevels].sort((a, b) => a - b) : null,
                    url, error };
                out.push(entry);
                // Rendering them inline is the point of the helper: a data URL
                // in a console row is unreadable, an actual picture answers
                // "is the texture data wrong?" at a glance.
                if (settings.log !== false && url) {
                    const scale = Math.max(1, Math.round(64 / Math.max(width, height)));
                    console.log("%c ", "font-size:0;padding:" +
                        (height * scale / 2) + "px " + (width * scale / 2) +
                        "px;background:url(" + url +
                        ") no-repeat center/contain;image-rendering:pixelated",
                        handle, entry.formatName, entry.size);
                }
            }
            return out;
        },

dumpShaders(options) {
            options = options || {};
            const rows = [];
            for (const [handle, resource] of this.resources) {
                if (resource.kind !== RESOURCE_VERTEX_SHADER &&
                        resource.kind !== RESOURCE_PIXEL_SHADER) continue;
                const kind = resource.kind === RESOURCE_VERTEX_SHADER
                    ? "vertex" : "pixel";
                const translated = resource.translated;
                const reflection = translated && translated.reflection;
                rows.push({
                    handle, kind,
                    hash: [resource.hashHigh, resource.hashLow]
                        .map(value => (value >>> 0).toString(16)
                            .padStart(8, "0")).join(""),
                    ok: !!(translated && translated.ok),
                    error: translated && translated.error,
                    version: reflection ? reflection.version.major + "." +
                        reflection.version.minor : null,
                    // usage*16+usageIndex is how programFor matches a
                    // declaration element to a shader input, so print the
                    // semantics rather than the raw register numbers.
                    inputs: reflection ? reflection.inputs.map(input =>
                        "v" + input.register + "=usage" + input.usage +
                        "[" + input.usageIndex + "]") : null,
                    writtenVaryings: reflection ? reflection.writtenVaryings : null,
                    samplers: reflection
                        ? reflection.samplers.map(s => s.index) : null,
                    warnings: reflection ? reflection.warnings : null,
                });
            }
            if (options.log !== false) {
                for (const row of rows) console.log("[d3d9-shader]", row);
            }
            if (options.wgsl) {
                for (const [handle, resource] of this.resources) {
                    if (resource.kind !== RESOURCE_VERTEX_SHADER &&
                            resource.kind !== RESOURCE_PIXEL_SHADER) continue;
                    if (options.handle && handle !== options.handle) continue;
                    if (!resource.translated || !resource.translated.ok) continue;
                    console.log("[d3d9-shader] handle " + handle + " WGSL:\n" +
                        resource.translated.wgsl);
                }
            }
            return rows;
        },

dumpPipelineStates() {
            const out = [];
            for (const [key, pipeline] of this.pipelineCache) {
                const diagnostic = pipeline._d9wgDiagnostic;
                if (diagnostic) {
                    out.push({
                        ...diagnostic,
                        vertexBuffers: diagnostic.vertexBuffers.map(layout => ({
                            ...layout,
                            attributes: layout.attributes.map(attribute =>
                                ({ ...attribute })),
                        })),
                        samplers: diagnostic.samplers.slice(),
                        state: JSON.parse(JSON.stringify(diagnostic.state)),
                        draws: pipeline._d9wgDrawCount || 0,
                    });
                    continue;
                }
                // Compatibility for a pipeline created before structured
                // diagnostics existed. Do not try to split the key: a
                // fixed-function fragment signature legitimately contains
                // "|", so its fields cannot be recovered unambiguously.
                out.push({ key, state: null,
                    draws: pipeline._d9wgDrawCount || 0 });
            }
            return out;
        },

textureDiagnostic(handle) {
            const resource = handle ? this.resources.get(handle) : null;
            if (!resource) return { handle: handle || 0, live: false };
            return {
                handle, live: true, kind: resource.kind,
                type: resource.textureType || "2d",
                format: resource.format,
                formatName: TEXTURE_FORMAT_NAMES[resource.format] || null,
                gpuFormat: resource.gpuFormat || null,
                width: resource.width, height: resource.height,
                depth: resource.depth || 1,
                levels: resource.levelCount,
                uploadedLevels: resource.uploadedLevels
                    ? [...resource.uploadedLevels].sort((a, b) => a - b) : null,
                shadowLevels: [],
            };
        },

drawDiagnostic(reference, path) {
            if (!reference) return null;
            const { which, state, elements, geometry, program, pipelineState,
                targets, pipeline } = reference;
            const viewport = { ...state.viewport };
            const scissorEnabled =
                (state.renderStates.get(D3DRS_SCISSORTESTENABLE) || 0) !== 0 &&
                !!state.scissorRect;
            const scissor = scissorEnabled ? { ...state.scissorRect } : null;
            const clip = intersectRects(viewport, scissor,
                targets.width, targets.height);
            const streams = [];
            for (const [index, binding] of geometry.streams) {
                const resource = binding.resource || null;
                const shadow = resource && resource.shadow;
                const start = Math.max(0, binding.offset || 0);
                const preview = shadow
                    ? shadow.subarray(start,
                        Math.min(shadow.length, start + 64)) : null;
                streams.push({ index, stride: binding.stride || 0,
                    offset: binding.offset || 0,
                    frequency: binding.frequency === undefined
                        ? 1 : binding.frequency,
                    resourceBytes: resource ? resource.byteCount : null,
                    shadowBytes: shadow ? shadow.length : null,
                    availableVertices: shadow && binding.stride
                        ? Math.max(0, Math.floor((shadow.length - start) /
                            binding.stride)) : null,
                    firstBytes: preview ? [...preview].map(value =>
                        value.toString(16).padStart(2, "0")).join("") : null,
                });
            }
            let index = null;
            if (geometry.indexInfo) {
                const info = geometry.indexInfo;
                const resource = geometry.indexResource ||
                    this.resources.get(state.indexBufferHandle);
                const shadow = resource && resource.shadow;
                const bytesPerIndex = info.format === "uint32" ? 4 : 2;
                const scanCount = Math.min(info.count || 0, 4096);
                const samples = [];
                let minimum = Infinity, maximum = -Infinity, scanned = 0;
                if (shadow) {
                    const view = new DataView(shadow.buffer,
                        shadow.byteOffset, shadow.byteLength);
                    for (let item = 0; item < scanCount; ++item) {
                        const byteOffset = (info.offset || 0) +
                            ((info.firstIndex || 0) + item) * bytesPerIndex;
                        if (byteOffset + bytesPerIndex > shadow.length) break;
                        const value = bytesPerIndex === 4
                            ? view.getUint32(byteOffset, true)
                            : view.getUint16(byteOffset, true);
                        ++scanned;
                        if (samples.length < 24) samples.push(value);
                        minimum = Math.min(minimum, value);
                        maximum = Math.max(maximum, value);
                    }
                }
                index = { format: info.format, count: info.count,
                    firstIndex: info.firstIndex, baseVertex: info.baseVertex,
                    bufferOffset: info.offset || 0,
                    resourceBytes: resource ? resource.byteCount : null,
                    scanned,
                    minimum: Number.isFinite(minimum) ? minimum : null,
                    maximum: Number.isFinite(maximum) ? maximum : null,
                    samples };
            }
            const textureHandles = [...new Set(program.samplerIndices.map(
                sampler => state.textures.get(sampler) || 0))];
            return {
                path, which,
                shaders: { vertex: state.vertexShaderHandle || 0,
                    pixel: state.pixelShaderHandle || 0 },
                program: { vertex: program.vertexKey,
                    fragment: program.fragmentKey,
                    fixedPosition: program.fixedFunctionSignature
                        ? program.fixedFunctionSignature.positionType : null,
                    fixedTexCoordSets: program.fixedFunctionSignature
                        ? program.fixedFunctionSignature.texCoordSets.slice() : null,
                    samplers: program.samplerIndices.slice() },
                viewport, scissor, effectiveClip: clip,
                target: { width: targets.width, height: targets.height,
                    formats: targets.formats.slice(),
                    hasDepth: targets.hasDepth },
                pipelineState: JSON.parse(JSON.stringify(pipelineState)),
                pipelineDraws: pipeline._d9wgDrawCount || 0,
                elements: elements.map(element => ({ ...element })),
                streams, index,
                textures: textureHandles.map(handle =>
                    this.textureDiagnostic(handle)),
            };
        },

blackScreenReport() {
            const device = this.presentingDevice ||
                this.devices.values().next().value || null;
            const report = {
                stats: this.getStats(),
                debug: {
                    forceSolidAllDraws: !!this.debug.forceSolidAllDraws,
                    shaderMode: this.debug.shaderMode,
                    skipProgrammableDraws:
                        !!this.debug.skipProgrammableDraws,
                    disableCull: !!this.debug.disableCull,
                    disableDepthTest: !!this.debug.disableDepthTest,
                },
                device: device ? {
                    handle: device.handle,
                    viewport: { ...device.viewport },
                    scissorRect: device.scissorRect
                        ? { ...device.scissorRect } : null,
                    shaders: { vertex: device.vertexShaderHandle || 0,
                        pixel: device.pixelShaderHandle || 0 },
                    renderStates: Object.fromEntries(device.renderStates),
                    streams: Array.from(device.streams,
                        ([index, stream]) => ({ index, ...stream })),
                    indexBufferHandle: device.indexBufferHandle,
                } : null,
                pipelines: this.dumpPipelineStates(),
                draws: {
                    fixed: this.drawDiagnostic(this.lastDraws.fixed, "fixed"),
                    programmable: this.drawDiagnostic(
                        this.lastDraws.programmable, "programmable"),
                },
                shaders: this.dumpShaders({ log: false }),
                guestReports: (this.guestReports || []).slice(),
            };
            console.log("[d3d9-webgpu] black-screen report", report);
            return report;
        },
            captureTexturePreview(resource, payload, { compressed, width, height, depth, level, x, y, z }) {
                // Retain a CPU copy of small top-level images. This is the one
                // piece of evidence that separates "the texture data we uploaded
                // is wrong" from "the data is right but we sample it wrong", and
                // guessing between those two has already cost several rounds.
                // Bounded to sprite-sized textures so it cannot grow without
                // limit -- cursors and UI glyphs are exactly this size.
                // 64x64 was too small a net: a game's cursor and UI glyphs
                // usually live in a larger atlas, so the one texture worth looking
                // at was the one never captured. 256x256 covers those at a bounded
                // total cost (previewBudget below).
                if (!compressed && (resource.gpuFormat === "rgba8unorm" || resource.gpuFormat === "bgra8unorm") &&
                        resource.textureType !== "3d" && depth === 1 &&
                        level === 0 && z === 0 && width <= 256 &&
                        height <= 256 && x === 0 && y === 0) {
                    const previewBytes = width * height * 4;
                    if (!resource.preview) {
                        if (this.previewBudget === undefined)
                            this.previewBudget = 16 * 1024 * 1024;
                        if (this.previewBudget >= previewBytes) {
                            this.previewBudget -= previewBytes;
                            resource.preview = {
                                width, height, rgba: payload.slice()
                            };
                        } else {
                            // The preview is diagnostics only. Returning here used
                            // to drop the real queue.writeTexture below once War3
                            // had loaded 16 MiB of menu atlases. Textures first
                            // touched in battle (fog/minimap/command icons/software
                            // cursor) consequently stayed black or transparent.
                            ++this.stats.texturePreviewsSkipped;
                        }
                    } else {
                        resource.preview = { width, height, rgba: payload.slice() };
                    }
                    if (resource.preview && resource.gpuFormat === "bgra8unorm") {
                        const rgba = resource.preview.rgba;
                        for (let at = 0; at < rgba.length; at += 4) {
                            const b = rgba[at];rgba[at] = rgba[at + 2];rgba[at + 2] = b;
                        }
                    }
                }

            },
            capturePipelineDiagnostic(pipeline, program, topology, stripIndexFormat, pipelineState) {
                // Keep structured diagnostic data beside the cached object. The
                // old dumpPipelineStates() attempted to recover it by splitting
                // the cache key on "|", but fixed-function fragment keys use the
                // same character between texture stages, shifting every field and
                // producing a null/misattributed state exactly when multi-texture
                // debugging mattered most.
                pipeline._d9wgDiagnostic = {
                    vertex: program.vertexKey,
                    fragment: program.fragmentKey,
                    topology,
                    stripIndexFormat: stripIndexFormat || null,
                    vertexBuffers: program.vertexBuffers.map(layout => ({
                        stream: layout.stream,
                        arrayStride: layout.arrayStride,
                        stepMode: layout.stepMode || "vertex",
                        attributes: layout.attributes.map(attribute =>
                            ({ ...attribute })),
                    })),
                    samplers: program.samplerIndices.slice(),
                    state: JSON.parse(JSON.stringify(pipelineState)),
                };
                pipeline._d9wgDrawCount = 0;

            },
            captureDrawDiagnostic(reference) {
                const pipeline = reference.pipeline;
                pipeline._d9wgDrawCount = (pipeline._d9wgDrawCount || 0) + 1;
                const state = reference.state;
                this.lastDraws[(state.vertexShaderHandle || state.pixelShaderHandle)
                    ? "programmable" : "fixed"] = reference;
            },
        };
    }
    function install(executor, deps) {
        for (const [name, value] of Object.entries(createMethods(deps)))
            Object.defineProperty(executor, name, { value, writable: true, configurable: true });
        executor.lastDraws = { fixed: null, programmable: null };
        executor.diagnosticsEnabled = true;
    }
    const api = { install };
    global.D9WGDiagnostics = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
