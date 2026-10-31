// A minimal fake WebGPU device for the OpenGL executor's Node tests.
//
// It records what was asked of it rather than rendering: the point of the
// executor suite is to check that a GL command stream produces the right
// pipeline state, the right vertex layout and the right bind groups, none of
// which needs a GPU. The browser suites cover what pixels come out.

"use strict";

require("./gl_renderer_diagnostics.js");

const { errorScopes } = require("./fake_error_scopes.js");
const rules = require("./webgpu_rules.js");

class FakeBuffer {
    constructor(descriptor) {
        this.descriptor = descriptor;
        this.size = descriptor.size;
        this.destroyed = false;
        this.writes = [];
        // Persistent, so a test can seed what a readback will find -- a fresh
        // buffer per getMappedRange would make every mapped result zero and
        // hide the difference between "read a zero" and "read nothing".
        this.storage = new ArrayBuffer(descriptor.size);
    }
    destroy() { this.destroyed = true; }
    mapAsync() { return Promise.resolve(); }
    getMappedRange() { return this.storage; }
    unmap() {}
}

class FakeTexture {
    constructor(descriptor) {
        this.descriptor = descriptor;
        this.destroyed = false;
        this.views = [];
    }
    createView(options) {
        // (format and sample count: what a pass checks its attachments by)
        const view = { texture: this, options: options || {},
            format: options && options.format || this.descriptor.format,
            sampleCount: this.descriptor.sampleCount || 1 };
        this.views.push(view);
        return view;
    }
    destroy() { this.destroyed = true; }
}

class FakeRenderPass {
    constructor(descriptor, log, device) {
        this.descriptor = descriptor;
        this.device = device;
        this.log = log;
        this.ended = false;
        log.passes.push(this);
        this.calls = [];
    }
    checkOpen() {
        if (this.ended) throw new Error("render pass is already ended");
    }
    setPipeline(pipeline) {
        this.checkOpen();
        this.pipeline = pipeline;
        this.calls.push(["pipeline", pipeline]);
        if (pipeline.invalid) this.device.rejectWith("[Invalid RenderPipeline] is invalid due to a previous error");
        else if (pipeline.descriptor)
            for (const problem of rules.attachmentProblems(pipeline.descriptor, this.descriptor))
                this.device.rejectWith(problem);
    }
    setBindGroup(index, group) { this.calls.push(["bindGroup", index, group]); }
    setVertexBuffer(slot, buffer, offset) {
        this.calls.push(["vertexBuffer", slot, buffer, offset]);
        (this.vertexBuffers = this.vertexBuffers || [])[slot] = { buffer, offset };
    }
    setIndexBuffer(buffer, format, offset) {
        this.calls.push(["indexBuffer", buffer, format, offset]);
        this.indexBuffer = { buffer, format, offset };
    }
    setViewport(...args) {
        this.viewport = args;
        for (const problem of rules.viewportProblems(...args)) this.device.rejectWith(problem);
    }
    setScissorRect(...args) { this.scissor = args; }
    setStencilReference(value) { this.stencilReference = value; }
    setBlendConstant(value) { this.blendConstant = value; }
    beginOcclusionQuery(index) {
        this.checkOpen();
        if (!this.descriptor.occlusionQuerySet || this.activeQuery !== undefined)
            throw new Error("invalid occlusion query begin");
        this.usedQueries = this.usedQueries || new Set();
        if (this.usedQueries.has(index)) throw new Error("query slot reused in one pass");
        this.usedQueries.add(index);
        this.activeQuery = index;
        this.calls.push(["beginQuery", index]);
    }
    endOcclusionQuery() {
        this.checkOpen();
        if (this.activeQuery === undefined) throw new Error("no occlusion query is active");
        this.activeQuery = undefined;
        this.calls.push(["endQuery"]);
    }
    draw(count, instances, first) {
        this.checkOpen();
        this.log.draws.push({ pass: this, count, instances, first,
                              pipeline: this.pipeline,
                              vertexBuffers: (this.vertexBuffers || []).slice() });
        this.calls.push(["draw", count]);
    }
    drawIndexed(count, instances, firstIndex, baseVertex) {
        this.checkOpen();
        this.log.draws.push({ pass: this, count, instances, firstIndex,
                              baseVertex, indexed: true, pipeline: this.pipeline,
                              vertexBuffers: (this.vertexBuffers || []).slice(),
                              indexBuffer: this.indexBuffer });
        this.calls.push(["drawIndexed", count]);
    }
    end() {
        this.checkOpen();
        if (this.activeQuery !== undefined) throw new Error("incomplete occlusion query");
        this.ended = true;
    }
}

class FakeEncoder {
    constructor(log, device) { this.log = log; this.device = device; this.copies = []; }
    beginComputePass() { return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }; }
    beginRenderPass(descriptor) {
        for (const problem of rules.passProblems(descriptor)) this.device.rejectWith(problem);
        const attachment = descriptor.depthStencilAttachment;
        if (attachment) {
            const format = attachment.view && attachment.view.texture &&
                attachment.view.texture.descriptor.format;
            if (format && format.indexOf("stencil") < 0 &&
                    ("stencilLoadOp" in attachment ||
                     "stencilStoreOp" in attachment ||
                     "stencilClearValue" in attachment))
                throw new Error("stencil operations require a stencil aspect");
        }
        return new FakeRenderPass(descriptor, this.log, this.device);
    }
    copyTextureToTexture(...args) {
        for (const problem of rules.textureCopyProblems(...args)) this.device.rejectWith(problem);
        this.copies.push(["t2t", ...args]);
    }
    copyTextureToBuffer(...args) { this.copies.push(["t2b", ...args]); }
    copyBufferToTexture(source, destination, size) {
        for (const problem of rules.textureCopyProblems({}, destination, size)) this.device.rejectWith(problem);
        this.copies.push(["b2t", source, destination, size]);
    }
    copyBufferToBuffer(...args) { this.copies.push(["b2b", ...args]); }
    resolveQuerySet(querySet, first, count, destination, offset) {
        this.log.queryResolves.push({ querySet, first, count, destination, offset });
        this.copies.push(["resolve", querySet, first, count]);
    }
    finish() { return { encoder: this }; }
}

class FakeDevice {
    constructor(log) {
        this.log = log;
        Object.assign(this, errorScopes());
        this.features = new Set(["texture-compression-bc"]);
        this.limits = {
            maxTextureDimension2D: 8192, maxTextureDimension3D: 2048,
            maxColorAttachments: 8, maxVertexBuffers: 8,
            maxVertexAttributes: 16, maxBindGroups: 4,
        };
        this.lost = new Promise(() => {});
        this.queue = {
            writeBuffer: (buffer, offset, data, dataOffset, size) => {
                log.bufferWrites.push({ buffer, offset, size });
                const elementBytes = data.BYTES_PER_ELEMENT || 1;
                const start = (dataOffset || 0) * elementBytes;
                const length = size === undefined ? data.byteLength - start :
                    size * elementBytes;
                const bytes = new Uint8Array(data.buffer || data,
                    (data.byteOffset || 0) + start, length);
                new Uint8Array(buffer.storage).set(bytes, offset);
            },
            writeTexture: (destination, data, layout, size) => {
                const format = destination.texture &&
                    destination.texture.descriptor.format || "";
                // (Chrome: "Cannot copy into the depth aspect")
                if (/^depth(24plus|32float)/.test(format) && destination.aspect !== "stencil-only")
                    this.rejectWith("writeTexture into the depth aspect of " + format);
                if (/^bc\d-/.test(format)) {
                    if ((size.width & 3) || (size.height & 3))
                        throw new Error("compressed copies require whole 4x4 blocks");
                    const blockBytes = format.indexOf("bc1-") === 0 ? 8 : 16;
                    const required = (size.width >> 2) * (size.height >> 2) *
                        (size.depthOrArrayLayers || 1) * blockBytes;
                    if (data.byteLength < required)
                        throw new Error("compressed texture upload is truncated");
                }
                log.textureWrites.push({ destination, layout, size,
                                         byteLength: data.byteLength });
            },
            submit: buffers => { log.submits.push(buffers); },
            onSubmittedWorkDone: () => Promise.resolve(),
        };
    }
    createBuffer(descriptor) {
        const buffer = new FakeBuffer(descriptor);
        this.log.buffers.push(buffer);
        return buffer;
    }
    createTexture(descriptor) {
        if (/^bc\d-/.test(descriptor.format || "") &&
                (descriptor.usage & 0x10))
            throw new Error("compressed textures cannot be render attachments");
        const texture = new FakeTexture(descriptor);
        this.log.textures.push(texture);
        return texture;
    }
    createSampler(descriptor) {
        const sampler = { descriptor };
        this.log.samplers.push(sampler);
        return sampler;
    }
    createShaderModule(descriptor) {
        const module = { code: descriptor.code };
        this.log.modules.push(module);
        return module;
    }
    createComputePipeline(descriptor) {
        return { descriptor, getBindGroupLayout: index => ({ index }) };
    }
    createRenderPipeline(descriptor) {
        const pipeline = {
            descriptor,
            getBindGroupLayout: index => {
                const code = (descriptor.vertex && descriptor.vertex.module.code || "") +
                    "\n" + (descriptor.fragment &&
                        descriptor.fragment.module.code || "");
                const bindings = new Set(), types = new Map();
                const expression = /@group\((\d+)\)\s+@binding\((\d+)\)\s*var(?:<[^>]*>)?\s+\w+\s*:\s*([^;]+);/g;
                for (const match of code.matchAll(expression)) {
                    if (Number(match[1]) !== index) continue;
                    bindings.add(Number(match[2]));
                    types.set(Number(match[2]), match[3].trim());
                }
                if (!bindings.size)
                    throw new Error("no bind group layout at index " + index);
                return { index, bindings, types };
            },
        };
        const problems = rules.renderPipelineProblems(descriptor, this.features);
        if (problems.length) {
            pipeline.invalid = true;
            this.rejectWith(problems[0]);
        }
        this.log.pipelines.push(pipeline);
        return pipeline;
    }
    createBindGroup(descriptor) {
        if (descriptor.layout && descriptor.layout.bindings) {
            for (const entry of descriptor.entries)
                if (!descriptor.layout.bindings.has(entry.binding))
                    throw new Error("binding " + entry.binding +
                        " is not declared by group " + descriptor.layout.index);
        }
        if (descriptor.layout && descriptor.layout.types)
            for (const problem of rules.bindGroupProblems(descriptor.layout.types, descriptor.entries))
                this.rejectWith(problem);
        const group = { descriptor };
        this.log.bindGroups.push(group);
        return group;
    }
    createCommandEncoder() {
        const encoder = new FakeEncoder(this.log, this);
        this.log.encoders.push(encoder);
        return encoder;
    }
    createQuerySet(descriptor) {
        for (const problem of rules.querySetProblems(descriptor)) this.rejectWith(problem);
        const set = { descriptor };
        this.log.querySets.push(set);
        return set;
    }
}

function createFakeHost(canvas) {
    const log = {
        buffers: [], textures: [], samplers: [], modules: [], pipelines: [],
        bindGroups: [], encoders: [], passes: [], draws: [],
        bufferWrites: [], textureWrites: [], submits: [],
        querySets: [], queryResolves: [],
        presented: 0,
    };
    const device = new FakeDevice(log);
    const host = {
        canvas: canvas || null,
        device,
        format: "bgra8unorm",
        limits: device.limits,
        deviceFeatures: { bc: true, float32Filterable: true,
                          float32Blendable: false, timestampQuery: false,
                          depthClipControl: false, clipDistances: false },
        context: {
            configure() {},
            getCurrentTexture() {
                ++log.presented;
                return new FakeTexture({ label: "swapchain" });
            },
        },
        initialize() { return Promise.resolve(host); },
        onDeviceLost() { return () => {}; },
        claimPresenter() { return 1; },
        canPresent(token) { return token === 1; },
        releasePresenter() {},
        resizeCanvas() { return false; },
    };
    return { host, log, device };
}

module.exports = { createFakeHost, FakeDevice, FakeTexture, FakeBuffer };
