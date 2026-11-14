// The WebGPU validation rules the executors have broken, for the fake devices
// of the Node tests: a fake device that accepts what Chrome rejects lets a
// test pass on a pipeline that blacks out every frame (the review's S1-4/S1-5
// and the GL review's S1-2; each rule below was confirmed in Chrome). A
// violation goes where a real device sends it -- the innermost validation
// error scope, or uncapturederror (fake_error_scopes.js's rejectWith) -- and
// the object is still returned, invalid, as WebGPU does.
"use strict";

// ---- a little WGSL reflection: what the stages of a pipeline declare ----

function structFields(code, name) {
    const match = new RegExp("struct\\s+" + name + "\\s*\\{([\\s\\S]*?)\\n?\\}").exec(code);
    return match ? match[1] : "";
}

// @location(n) -> "flat" | "perspective" ... of the text given (fields or parameters)
function locations(text) {
    const out = new Map();
    const re = /@location\((\d+)\)((?:\s*@[a-z_]+(?:\([^)]*\))?)*)\s*([a-zA-Z_][\w]*)?\s*:/g;
    let m;
    while ((m = re.exec(text))) {
        const interpolate = /@interpolate\(\s*([a-z]+)/.exec(m[2]);
        out.set(Number(m[1]), interpolate ? interpolate[1] : "perspective");
    }
    // a bare return type: -> @location(0) vec4<f32>
    const bare = /^\s*@location\((\d+)\)/.exec(text);
    if (bare && !out.has(Number(bare[1]))) out.set(Number(bare[1]), "perspective");
    return out;
}

// The entry point's inputs and outputs, with struct parameters expanded
function entryPoint(code, name) {
    const match = new RegExp("fn\\s+" + name + "\\s*\\(([\\s\\S]*?)\\)\\s*(?:->\\s*([^{]+))?\\{").exec(code);
    if (!match) return null;
    let inputs = match[1];
    for (const typeName of inputs.match(/:\s*([A-Z]\w*)/g) || [])
        inputs += "\n" + structFields(code, typeName.replace(/[:\s]/g, ""));
    let outputs = (match[2] || "").trim();
    if (/^[A-Za-z_]\w*$/.test(outputs)) outputs = structFields(code, outputs);
    return { inputs: locations(inputs), outputs: locations(outputs) };
}

const FLOAT32_FORMATS = new Set(["r32float", "rg32float", "rgba32float"]);
const LINE_OR_POINT = new Set(["point-list", "line-list", "line-strip"]);
const TRIANGLES = new Set(["triangle-list", "triangle-strip", undefined]);

function checkBlend(blend, index, features, format, problems) {
    if (!blend) return;
    if (FLOAT32_FORMATS.has(format) && !features.has("float32-blendable"))
        problems.push("targets[" + index + "]: blending " + format + " needs float32-blendable");
    for (const part of ["color", "alpha"]) {
        const c = blend[part] || {};
        if ((c.operation === "min" || c.operation === "max") &&
                ((c.srcFactor || "one") !== "one" || (c.dstFactor || "zero") !== "one"))
            problems.push("targets[" + index + "]." + part + ": " + c.operation +
                " needs srcFactor and dstFactor one");
    }
}

/* What createRenderPipeline would reject in `descriptor` */
function renderPipelineProblems(descriptor, features = new Set()) {
    const problems = [];
    const vertexCode = descriptor.vertex && descriptor.vertex.module && descriptor.vertex.module.code || "";
    const fragmentCode = descriptor.fragment && descriptor.fragment.module && descriptor.fragment.module.code || "";
    const vs = entryPoint(vertexCode, descriptor.vertex && descriptor.vertex.entryPoint || "\\w+");
    const fs = descriptor.fragment ? entryPoint(fragmentCode, descriptor.fragment.entryPoint || "\\w+") : null;
    const topology = descriptor.primitive && descriptor.primitive.topology;
    const ds = descriptor.depthStencil;
    if (ds && !TRIANGLES.has(topology) && LINE_OR_POINT.has(topology) &&
            (ds.depthBias || ds.depthBiasSlopeScale || ds.depthBiasClamp))
        problems.push("depthBias must be 0 when using " + topology);
    if (vs) {
        // every vertex input needs an attribute
        const provided = new Set();
        for (const buffer of (descriptor.vertex.buffers || []))
            for (const attribute of (buffer && buffer.attributes) || []) provided.add(attribute.shaderLocation);
        for (const location of vs.inputs.keys())
            if (!provided.has(location))
                problems.push("vertex attribute slot " + location + " is used in the shader but not present in the VertexState");
    }
    if (vs && fs) {
        for (const [location, interpolation] of fs.inputs) {
            if (!vs.outputs.has(location))
                problems.push("fragment input @location(" + location + ") is not an output of the vertex stage");
            else if ((vs.outputs.get(location) === "flat") !== (interpolation === "flat"))
                problems.push("@location(" + location + ") interpolation differs between the stages");
        }
    }
    if (descriptor.fragment) {
        (descriptor.fragment.targets || []).forEach((target, index) => {
            if (!target) return;
            const writeMask = target.writeMask === undefined ? 0xF : target.writeMask;
            if (fs && writeMask && !fs.outputs.has(index))
                problems.push("color target " + index + " has no corresponding fragment stage output but writeMask is not zero");
            checkBlend(target.blend, index, features, target.format, problems);
        });
    }
    const samples = descriptor.multisample && descriptor.multisample.count || 1;
    if (descriptor.multisample && descriptor.multisample.alphaToCoverageEnabled && samples === 1)
        problems.push("alphaToCoverage needs a multisampled target");
    return problems;
}

/* The pipeline's attachment state against the pass it is set in */
function attachmentProblems(pipelineDescriptor, passDescriptor) {
    const problems = [];
    const targets = pipelineDescriptor.fragment ? pipelineDescriptor.fragment.targets || [] : [];
    const attachments = passDescriptor.colorAttachments || [];
    const formatOf = attachment => attachment && attachment.view && attachment.view.format;
    const samplesOf = attachment => attachment && attachment.view && attachment.view.sampleCount;
    const count = Math.max(targets.length, attachments.length);
    for (let i = 0; i < count; ++i) {
        const target = targets[i] || null, attachment = attachments[i] || null;
        if (!target !== !attachment)
            problems.push("color attachment " + i + " does not match the pipeline's targets");
        else if (target && formatOf(attachment) && formatOf(attachment) !== target.format)
            problems.push("color attachment " + i + " is " + formatOf(attachment) + ", the pipeline's target " + target.format);
    }
    const samples = pipelineDescriptor.multisample && pipelineDescriptor.multisample.count || 1;
    for (const attachment of [...attachments, passDescriptor.depthStencilAttachment]) {
        const passSamples = samplesOf(attachment);
        if (passSamples && passSamples !== samples)
            problems.push("the pass's sample count (" + passSamples + ") is not the pipeline's (" + samples + ")");
    }
    if (!!pipelineDescriptor.depthStencil !== !!passDescriptor.depthStencilAttachment)
        problems.push("the pipeline's depthStencil state does not match the pass's depth attachment");
    return problems;
}

/* A render pass's own rules: sample counts and sizes agree, resolve targets single-sampled */
function passProblems(descriptor) {
    const problems = [];
    const attachments = [...(descriptor.colorAttachments || []), descriptor.depthStencilAttachment].filter(Boolean);
    const sampleCounts = new Set(attachments.map(a => a.view && a.view.sampleCount).filter(Boolean));
    if (sampleCounts.size > 1) problems.push("the attachments' sample counts differ: " + [...sampleCounts]);
    for (const attachment of descriptor.colorAttachments || []) {
        if (!attachment) continue;
        const texture = attachment.view && attachment.view.texture, d = texture && texture.descriptor;
        if (d && d.dimension === "3d") {
            const depth = Math.max(1, d.size.depthOrArrayLayers >> (attachment.view.options.baseMipLevel || 0));
            if (!Number.isInteger(attachment.depthSlice) || attachment.depthSlice < 0 || attachment.depthSlice >= depth)
                problems.push("a 3D color attachment requires an in-range depthSlice");
        }
        if (!attachment.resolveTarget) continue;
        if ((attachment.view.sampleCount || 1) === 1) problems.push("a resolve target on a single-sampled attachment");
        if ((attachment.resolveTarget.sampleCount || 1) !== 1) problems.push("a multisampled resolve target");
    }
    if (descriptor.depthStencilAttachment && descriptor.depthStencilAttachment.stencilClearValue < 0)
        problems.push("stencilClearValue is negative");
    return problems;
}

// setViewport: a viewport may lie partly outside the target, within twice
// the largest texture dimension (maxTextureDimension2D, 8192 by default)
function viewportProblems(x, y, width, height, minDepth, maxDepth, maxDimension = 8192) {
    if (!(minDepth >= 0 && minDepth <= 1 && maxDepth >= 0 && maxDepth <= 1 && minDepth <= maxDepth))
        return ["Viewport minDepth (" + minDepth + ") and maxDepth (" + maxDepth +
            ") are not in [0, 1] or minDepth was greater than maxDepth"];
    if (width < 0 || height < 0) return ["a negative viewport size"];
    const range = 2 * maxDimension;
    if (width > maxDimension || height > maxDimension || x < -range || y < -range ||
            x + width > range - 1 || y + height > range - 1)
        return ["the viewport (" + [x, y, width, height] + ") is outside the range WebGPU allows"];
    return [];
}

function querySetProblems(descriptor) {
    return descriptor.count > 4096 ? ["a query set holds at most 4096 queries, not " + descriptor.count] : [];
}

/*
 * A bind group's texture views against the WGSL types they are bound to:
 * the view's dimension and whether it is depth (the GL review's S1-2a: a 2D
 * colour fallback bound to a cube, 3D or depth binding lost the frame).
 * `types` maps each binding of the group to its declared type.
 */
function bindGroupProblems(types, entries) {
    const problems = [];
    for (const entry of entries) {
        const type = types.get(entry.binding), view = entry.resource;
        const declared = type && /^texture_(depth_)?(2d|3d|cube)\b/.exec(type);
        if (!declared || !view || !view.texture) continue;
        const dimension = view.options.dimension || (view.texture.descriptor.dimension === "3d" ? "3d" : "2d");
        if (dimension !== declared[2])
            problems.push("binding " + entry.binding + ": a " + dimension + " view for a " + type);
        if (/^depth/.test(view.format) !== !!declared[1])
            problems.push("binding " + entry.binding + ": a " + view.format + " view for a " + type);
    }
    return problems;
}

/* copyTextureToTexture: both rectangles inside their subresources */
function textureCopyProblems(source, destination, size) {
    const problems = [];
    const extent = [size.width, size.height || 1, size.depthOrArrayLayers || 1];
    for (const [name, copy] of [["source", source], ["destination", destination]]) {
        const d = copy.texture && copy.texture.descriptor;
        if (!d || !d.size) continue;
        const level = copy.mipLevel || 0, o = copy.origin || {};
        const three = d.dimension === "3d";
        const dims = [Math.max(1, d.size.width >> level), Math.max(1, (d.size.height || 1) >> level),
            three ? Math.max(1, (d.size.depthOrArrayLayers || 1) >> level) : d.size.depthOrArrayLayers || 1];
        if (/^bc/.test(d.format || "")) {
            dims[0] = Math.ceil(dims[0] / 4) * 4;dims[1] = Math.ceil(dims[1] / 4) * 4;
        }
        const origin = [o.x || 0, o.y || 0, o.z || 0];
        for (let i = 0; i < 3; ++i)
            if (origin[i] < 0 || origin[i] + extent[i] > dims[i])
                problems.push("the " + name + " of a texture copy is out of bounds: " + origin + " + " +
                    extent + " in " + dims);
    }
    return problems;
}

function validateSamplerDescriptor(descriptor) {
    if (descriptor.compare !== undefined && !["never", "less", "equal", "less-equal",
        "greater", "not-equal", "greater-equal", "always"].includes(descriptor.compare))
        throw new TypeError("Invalid GPUCompareFunction: " + descriptor.compare);
}

module.exports = { renderPipelineProblems, attachmentProblems, passProblems, viewportProblems,
    querySetProblems, bindGroupProblems, textureCopyProblems, entryPoint, validateSamplerDescriptor };
