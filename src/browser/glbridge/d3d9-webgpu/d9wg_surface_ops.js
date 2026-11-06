// Shared GPU utility passes for surfaces and presentation. Guest opcode
// interpretation stays in the executor/DirectDraw semantic layer.
(function(global) {
    "use strict";
    const UNIFORM_BYTES = 128;
    const PALETTE_ENTRIES = 256, PALETTE_BYTES = PALETTE_ENTRIES * 16;
    // eight vec4s, see WGSL below

    // The blit uniform block, built once per op.
    //   0  source_rect  u, v, du, dv  (du/dv negative when mirrored)
    //  16  source_size   level width, level height
    //  32  key_low       r, g, b (or the palette index in .x)
    //  48  key_high
    //  64  fill          float fill colour
    //  80  fill_index    index fill
    //  96  destination key low
    // 112  destination key high
    function packUniforms(op) {
        const buffer = new ArrayBuffer(UNIFORM_BYTES);
        const floats = new Float32Array(buffer);
        const uints = new Uint32Array(buffer);
        floats[0] = op.sourceRect[0];
        floats[1] = op.sourceRect[1];
        floats[2] = op.sourceRect[2];
        floats[3] = op.sourceRect[3];
        floats[4] = op.sourceSize ? op.sourceSize[0] : 1;
        floats[5] = op.sourceSize ? op.sourceSize[1] : 1;
        const key = op.colorKey;
        uints[8] = key ? (key.low >>> 16) & 0xff : 0;
        uints[9] = key ? (key.low >>> 8) & 0xff : 0;
        uints[10] = key ? key.low & 0xff : 0;
        uints[11] = key ? key.low & 0xff : 0;
        uints[12] = key ? (key.high >>> 16) & 0xff : 0;
        uints[13] = key ? (key.high >>> 8) & 0xff : 0;
        uints[14] = key ? key.high & 0xff : 0;
        uints[15] = key ? key.high & 0xff : 0;
        // An indexed source compares the index itself, which the guest put in
        // the low byte of both ends.
        if (op.sourceKind === "index" && key) {
            uints[8] = key.low & 0xff;
            uints[12] = key.high & 0xff;
        }
        const fill = op.fill || [0, 0, 0, 0];
        floats[16] = fill[0];
        floats[17] = fill[1];
        floats[18] = fill[2];
        floats[19] = fill[3];
        uints[20] = op.fillIndex >>> 0;
        const destinationKey = op.destinationColorKey;
        uints[24] = destinationKey
            ? (destinationKey.low >>> 16) & 0xff : 0;
        uints[25] = destinationKey
            ? (destinationKey.low >>> 8) & 0xff : 0;
        uints[26] = destinationKey ? destinationKey.low & 0xff : 0;
        uints[27] = destinationKey ? destinationKey.low & 0xff : 0;
        uints[28] = destinationKey
            ? (destinationKey.high >>> 16) & 0xff : 0;
        uints[29] = destinationKey
            ? (destinationKey.high >>> 8) & 0xff : 0;
        uints[30] = destinationKey ? destinationKey.high & 0xff : 0;
        uints[31] = destinationKey ? destinationKey.high & 0xff : 0;
        if (op.destinationKind === "index" && destinationKey) {
            uints[24] = destinationKey.low & 0xff;
            uints[28] = destinationKey.high & 0xff;
        }
        return new Uint8Array(buffer);
    }

    function ddBlitShaderSource(variant) {
        const indexedSource = variant.sourceKind === "index";
        const noSource = variant.sourceKind === "none";
        const indexedDestination = variant.destinationKind === "index";
        const outputType = indexedDestination ? "vec4<u32>" : "vec4<f32>";
        const lines = [];
        lines.push(`struct D9DDBlitUniforms {
    source_rect: vec4<f32>,
    source_size: vec4<f32>,
    key_low: vec4<u32>,
    key_high: vec4<u32>,
    fill: vec4<f32>,
    fill_index: vec4<u32>,
    destination_key_low: vec4<u32>,
    destination_key_high: vec4<u32>,
};
@group(0) @binding(0) var<uniform> blit: D9DDBlitUniforms;`);
        if (!noSource) {
            lines.push(indexedSource
                ? "@group(0) @binding(1) var d9dd_source: texture_2d<u32>;"
                : "@group(0) @binding(1) var d9dd_source: texture_2d<f32>;");
            if (!indexedSource)
                lines.push("@group(0) @binding(2) var d9dd_sampler: sampler;");
        }
        if (variant.paletteResolve) {
            lines.push(`struct D9DDPalette {
    entries: array<vec4<f32>, ${PALETTE_ENTRIES}>,
};
@group(0) @binding(3) var<uniform> d9dd_palette: D9DDPalette;`);
        }
        if (variant.destinationKey) {
            lines.push(variant.destinationKind === "index"
                ? "@group(0) @binding(4) var d9dd_destination_key: texture_2d<u32>;"
                : "@group(0) @binding(4) var d9dd_destination_key: texture_2d<f32>;");
        }
        lines.push(`
struct D9DDBlitOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn d9dd_vs_main(@builtin(vertex_index) index: u32) -> D9DDBlitOutput {
    // Two triangles over the whole viewport; setViewport restricts the output
    // to the destination rectangle, so no destination maths belongs here.
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
    let corner = corners[index];
    var result: D9DDBlitOutput;
    result.position = vec4<f32>(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0,
        0.0, 1.0);
    // Mirroring is a negative extent in source_rect rather than a shader
    // variant of its own: DDBLTFX_MIRRORLEFTRIGHT/UPDOWN are exactly a
    // reversed traversal of the source rectangle.
    result.uv = blit.source_rect.xy + corner * blit.source_rect.zw;
    return result;
}`);
        const body = [];
        if (variant.destinationKey) {
            body.push("    let destination_texel = vec2<i32>(stage_in.position.xy);");
            if (indexedDestination) {
                body.push(`    let destination_index = textureLoad(
        d9dd_destination_key, destination_texel, 0).r;
    if (destination_index < blit.destination_key_low.x ||
            destination_index > blit.destination_key_high.x) {
        discard;
    }`);
            } else {
                body.push(`    let destination_color = textureLoad(
        d9dd_destination_key, destination_texel, 0);
    let destination_quantised = vec3<u32>(round(destination_color.rgb * 255.0));
    if (any(destination_quantised < blit.destination_key_low.rgb) ||
            any(destination_quantised > blit.destination_key_high.rgb)) {
        discard;
    }`);
            }
        }
        if (noSource) {
            body.push(indexedDestination
                ? "    return vec4<u32>(blit.fill_index.x, 0u, 0u, 0u);"
                : "    return blit.fill;");
        } else if (indexedSource) {
            body.push(`    let texel = vec2<i32>(clamp(
        floor(stage_in.uv * blit.source_size.xy), vec2<f32>(0.0, 0.0),
        max(blit.source_size.xy - vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0))));
    let index = textureLoad(d9dd_source, texel, 0).r;`);
            if (variant.colorKey && !variant.keyToAlpha)
                body.push(`    if (index >= blit.key_low.x && index <= blit.key_high.x) {
        discard;
    }`);
            if (variant.keyToAlpha) {
                body.push(variant.paletteResolve ? "    let color = d9dd_palette.entries[index];"
                    : "    let color = vec4<f32>(vec3<f32>(f32(index) / 255.0), 1.0);");
                body.push("    let keyed = index <= blit.key_high.x && blit.key_low.x <= index;\n" +
                    "    return vec4<f32>(color.rgb, select(color.a, 0.0, keyed));");
            } else if (indexedDestination)
                body.push("    return vec4<u32>(index, 0u, 0u, 0u);");
            else if (variant.paletteResolve)
                body.push("    return d9dd_palette.entries[index];");
            else
                // No palette bound: the indices are all the host has, and
                // inventing colours for them would be a picture the app never
                // asked for. Grey ramp, and the guest is told through the
                // ddPaletteMissing counter.
                body.push("    let level = f32(index) / 255.0;\n" +
                    "    return vec4<f32>(level, level, level, 1.0);");
        } else {
            body.push("    let color = textureSample(d9dd_source, " +
                "d9dd_sampler, stage_in.uv);");
            if (variant.colorKey)
                // Quantised back to the 8-bit-per-channel domain the key lives
                // in. Both ends of the key were widened from the surface
                // format by the same bit replication in the guest
                // (ddraw_expand_channel), and the upload widened the texels the
                // same way, so this comparison is exact rather than nearly so.
                body.push(`    let quantised = vec3<u32>(round(color.rgb * 255.0));
    if (all(quantised >= blit.key_low.rgb) &&
            all(quantised <= blit.key_high.rgb)) {
        discard;
    }`);
            body.push(indexedDestination
                ? "    return vec4<u32>(u32(round(color.r * 255.0)), 0u, 0u, 0u);"
                : "    return color;");
        }
        lines.push(`
@fragment
fn d9dd_ps_main(stage_in: D9DDBlitOutput) -> @location(0) ${outputType} {
${body.join("\n")}
}
`);
        return lines.join("\n");
    }
    function clipRects(source, destination, width, height) {
        const destinationWidth = destination.right - destination.left;
        const destinationHeight = destination.bottom - destination.top;
        const sourceWidth = source.right - source.left;
        const sourceHeight = source.bottom - source.top;
        if (destinationWidth <= 0 || destinationHeight <= 0 ||
                sourceWidth <= 0 || sourceHeight <= 0)
            return null;
        const scaleX = sourceWidth / destinationWidth;
        const scaleY = sourceHeight / destinationHeight;
        const left = Math.max(0, destination.left);
        const top = Math.max(0, destination.top);
        const right = Math.min(width, destination.right);
        const bottom = Math.min(height, destination.bottom);
        if (right <= left || bottom <= top) return null;
        return {
            viewport: [left, top, right - left, bottom - top],
            source: {
                left: source.left + Math.round((left - destination.left) * scaleX),
                top: source.top + Math.round((top - destination.top) * scaleY),
                right: source.right -
                    Math.round((destination.right - right) * scaleX),
                bottom: source.bottom -
                    Math.round((destination.bottom - bottom) * scaleY),
            },
        };
    }

    function clipDestination(destination, width, height) {
        const left = Math.max(0, destination.left);
        const top = Math.max(0, destination.top);
        const right = Math.min(width, destination.right);
        const bottom = Math.min(height, destination.bottom);
        if (right <= left || bottom <= top) return null;
        return { viewport: [left, top, right - left, bottom - top],
            source: { left: 0, top: 0, right: 0, bottom: 0 } };
    }
    function createMethods(dependencies) {
        const {
            formatToGPU, SHADER_STAGE_FRAGMENT, isFloat32GPUFormat, SHADER_STAGE_VERTEX,
              DEPTH_FORMAT, TEXTURE_USAGE_COPY_SRC, TEXTURE_USAGE_COPY_DST,
            TEXTURE_USAGE_TEXTURE_BINDING, TEXTURE_USAGE_RENDER_ATTACHMENT, DDOVER_KEY_SOURCE, DDOVER_KEY_DESTINATION,
            DDOVER_MIRROR_X, DDOVER_MIRROR_Y
        } = dependencies;
        return {
            // depth24plus has no portable byte layout. Read its actual values
            // through a depth view and write them through frag_depth; stencil
            // and every pixel outside an uploaded rectangle remain untouched.
            depthTransferPipelineFor(write) {
                if (!this.depthTransferPipelines) this.depthTransferPipelines = new Map();
                let entry = this.depthTransferPipelines.get(write);
                if (entry) return entry;
                const module = this.moduleFor(`
@group(0) @binding(0) var source: ${write ? "texture_2d<f32>" : "texture_depth_2d"};
@group(0) @binding(1) var<uniform> offset: vec4<i32>;
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
    return vec4<f32>(positions[index],0.0,1.0);
}
@fragment fn fs(@builtin(position) position: vec4<f32>) -> ${write ? "@builtin(frag_depth)" : "@location(0)"} f32 {
    return textureLoad(source, vec2<i32>(position.xy) + offset.xy, 0)${write ? ".r" : ""};
}`, "D3D9 depth transfer " + write);
                const layout = this.device.createBindGroupLayout({ entries: [
                    { binding: 0, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: write ? "unfilterable-float" : "depth" } },
                    { binding: 1, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
                ] });
                const pipeline = this.device.createRenderPipeline({
                    label: "D3D9 depth transfer " + write,
                    layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
                    vertex: { module, entryPoint: "vs" },
                    fragment: { module, entryPoint: "fs", targets: write ? [] : [{format:"r32float"}] },
                    primitive: { topology: "triangle-list" },
                    ...(write ? { depthStencil: {format:DEPTH_FORMAT,depthWriteEnabled:true,depthCompare:"always",stencilWriteMask:0} } : {}),
                });
                entry = {layout,pipeline}; this.depthTransferPipelines.set(write,entry); return entry;
            },

            encodeDepthTransfer(encoder, source, destination, write, x, y, width, height, firstRow = 0) {
                const entry = this.depthTransferPipelineFor(write);
                const uniform = this.device.createBuffer({label:"D3D9 depth transfer offset",size:16,usage:0x40|0x08});
                this.device.queue.writeBuffer(uniform,0,new Int32Array(write ? [-x,-y,0,0] : [0,firstRow,0,0]));
                const group = this.device.createBindGroup({layout:entry.layout,entries:[
                    {binding:0,resource:source},{binding:1,resource:{buffer:uniform}},
                ]});
                const pass = encoder.beginRenderPass(write ? {colorAttachments:[],depthStencilAttachment:{
                    view:destination,depthLoadOp:"load",depthStoreOp:"store",stencilLoadOp:"load",stencilStoreOp:"store",
                }} : {colorAttachments:[{view:destination,loadOp:"clear",storeOp:"store",clearValue:{r:0,g:0,b:0,a:0}}]});
                ++this.stats.renderPasses;
                pass.setPipeline(entry.pipeline);pass.setBindGroup(0,group);
                pass.setViewport(x,y,width,height,0,1);pass.setScissorRect(x,y,width,height);pass.draw(3);pass.end();
                return uniform;
            },

            stageDepthUpload(resource, level, x, y, width, height, rowPitch, source) {
                if (resource.format !== 70 || (resource.sampleCount || 1) !== 1 || level >= resource.levelCount ||
                        !width || !height || x + width > Math.max(1,resource.width >> level) ||
                        y + height > Math.max(1,resource.height >> level) || rowPitch < width*2 ||
                        source.byteLength < (height-1)*rowPitch + width*2)
                    throw new Error("invalid lockable depth upload");
                const values = new Float32Array(width*height), view = new DataView(source.buffer,source.byteOffset,source.byteLength);
                for(let row=0;row<height;++row)for(let col=0;col<width;++col)
                    values[row*width+col] = view.getUint16(row*rowPitch+col*2,true)/65535;
                const texture = this.device.createTexture({label:"D3D9 depth upload values",size:{width,height},format:"r32float",
                    usage:TEXTURE_USAGE_COPY_DST|TEXTURE_USAGE_TEXTURE_BINDING});
                this.stageTextureUpload({texture},new Uint8Array(values.buffer),{bytesPerRow:width*4,rowsPerImage:height},{width,height,depthOrArrayLayers:1});
                this.ensureFrame().record({kind:"depth-upload",source:texture.createView(),destination:this.targetViewFor(resource,level,false),x,y,width,height});
                this.retireGPUObject(texture);
                ++this.stats.textureUploads;this.stats.textureBytesUploaded += width*height*2;
            },

            utilityUniform(data) {
                const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
                const slot = this.allocateUniformSlot(bytes.byteLength, false);
                if (slot.transient) this.device.queue.writeBuffer(slot.buffer, 0, bytes);
                else this.uniformStaging[slot.chunkIndex].set(bytes, slot.offset);
                return { binding: { buffer: slot.buffer, offset: slot.offset, size: bytes.byteLength },
                    transient: slot.transient ? slot.buffer : null };
            },
            replayGenerateMips(encoder, op) {
                const resource = op.resource;
                const layers = resource.layerCount || 1;
                const format = resource.gpuFormat || formatToGPU(resource.format);
                const buffers = [];
                for (let layer = 0; layer < layers; ++layer) {
                    for (let level = 1; level < resource.levelCount; ++level) {
                        const width = Math.max(1, resource.width >> level);
                        const height = Math.max(1, resource.height >> level);
                        const blit = {
                            kind: "blit",
                            sourceView: this.blitSourceView(resource, level - 1,
                                layer),
                            destinationView: this.targetViewFor(resource, level,
                                false, layer),
                            destinationFormat: format,
                            sourceFormat: format,
                            // The whole of the parent level, into the whole of this
                            // one.
                            sourceRect: [0, 0, 1, 1],
                            viewport: [0, 0, width, height],
                            filterPoint: op.filterType === 1,
                            maxAnisotropy: op.filterType === 3 ? 16 : 1,
                        };
                        const transient = this.replayBlit(encoder, blit, null);
                        if (transient) buffers.push(transient);
                        ++this.stats.mipLevelsGenerated;
                    }
                }
                return buffers;
            },

            gammaBlitPipelineFor(format) {
                if (!this.gammaBlitPipelines) this.gammaBlitPipelines = new Map();
                let entry = this.gammaBlitPipelines.get(format);
                if (entry) return entry;
                const module = this.moduleFor(`@group(0) @binding(0) var d9_gamma_source: texture_2d<f32>;
    @group(0) @binding(1) var d9_gamma_sampler: sampler;
    @group(0) @binding(2) var d9_gamma_ramp: texture_2d<f32>;
    
    struct D9GammaOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
    };
    
    @vertex
    fn d9_vs_main(@builtin(vertex_index) index: u32) -> D9GammaOutput {
        var corners = array<vec2<f32>, 6>(
            vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
            vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
        let corner = corners[index];
        var result: D9GammaOutput;
        result.position = vec4<f32>(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0,
            0.0, 1.0);
        result.uv = corner;
        return result;
    }
    
    @fragment
    fn d9_ps_main(stage_in: D9GammaOutput) -> @location(0) vec4<f32> {
        let source = textureSample(d9_gamma_source, d9_gamma_sampler, stage_in.uv);
        // Each channel indexes the table independently -- D3D9's ramp is three
        // separate curves, and titles do set them apart (a red damage flash is
        // exactly that).
        let index = vec3<i32>(clamp(source.rgb, vec3<f32>(0.0), vec3<f32>(1.0))
            * 255.0 + vec3<f32>(0.5));
        return vec4<f32>(
            textureLoad(d9_gamma_ramp, vec2<i32>(index.r, 0), 0).r,
            textureLoad(d9_gamma_ramp, vec2<i32>(index.g, 0), 0).g,
            textureLoad(d9_gamma_ramp, vec2<i32>(index.b, 0), 0).b,
            source.a);
    }
    `, "d3d9 gamma blit " + format);
                const bindGroupLayout = this.device.createBindGroupLayout({
                    entries: [
                        { binding: 0, visibility: SHADER_STAGE_FRAGMENT,
                          texture: { sampleType: "float" } },
                        { binding: 1, visibility: SHADER_STAGE_FRAGMENT,
                          sampler: { type: "filtering" } },
                        // The ramp is read with textureLoad, which is defined for
                        // an unfilterable-float binding and needs no sampler.
                        { binding: 2, visibility: SHADER_STAGE_FRAGMENT,
                          texture: { sampleType: "unfilterable-float" } },
                    ],
                });
                entry = {
                    pipeline: this.device.createRenderPipeline({
                        label: "D3D9 gamma blit " + format,
                        layout: this.device.createPipelineLayout(
                            { bindGroupLayouts: [bindGroupLayout] }),
                        vertex: { module, entryPoint: "d9_vs_main" },
                        fragment: { module, entryPoint: "d9_ps_main",
                            targets: [{ format }] },
                        primitive: { topology: "triangle-list" },
                    }),
                    bindGroupLayout,
                    sampler: this.device.createSampler({
                        magFilter: "nearest", minFilter: "nearest",
                        addressModeU: "clamp-to-edge",
                        addressModeV: "clamp-to-edge",
                    }),
                };
                this.gammaBlitPipelines.set(format, entry);
                return entry;
            },

            blitPipelineFor(format, filterPoint, sourceFormat, maxAnisotropy = 1) {
                // WebGPU exposes filtering and blending for 32-bit float formats
                // as independent optional features.  A D3D point blit remains
                // legal without float32-filterable, but its binding layout and
                // sampler must explicitly be non-filtering.
                const unfilterable = isFloat32GPUFormat(sourceFormat) &&
                    !this.deviceFeatures.float32Filterable;
                const point = filterPoint || unfilterable;
                const anisotropy = !point && maxAnisotropy > 1 ? 16 : 1;
                const key = format + "|" + (point ? "point" : "linear") + "|" +
                    (unfilterable ? "unfilterable" : "filterable") + (anisotropy > 1 ? "|aniso16" : "");
                if (!this.blitPipelines) this.blitPipelines = new Map();
                let entry = this.blitPipelines.get(key);
                if (entry) return entry;
                const module = this.moduleFor(`struct D9BlitUniforms {
        source_rect: vec4<f32>,
    };
    @group(0) @binding(0) var<uniform> blit: D9BlitUniforms;
    @group(0) @binding(1) var d9_blit_source: texture_2d<f32>;
    @group(0) @binding(2) var d9_blit_sampler: sampler;
    
    struct D9BlitOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
    };
    
    @vertex
    fn d9_vs_main(@builtin(vertex_index) index: u32) -> D9BlitOutput {
        // Two triangles covering the whole viewport; setViewport restricts the
        // output to the destination rect, so no destination maths is needed here.
        var corners = array<vec2<f32>, 6>(
            vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
            vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
        let corner = corners[index];
        var result: D9BlitOutput;
        result.position = vec4<f32>(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0,
            0.0, 1.0);
        result.uv = blit.source_rect.xy + corner * blit.source_rect.zw;
        return result;
    }
    
    @fragment
    fn d9_ps_main(stage_in: D9BlitOutput) -> @location(0) vec4<f32> {
        return textureSample(d9_blit_source, d9_blit_sampler, stage_in.uv);
    }
    `, "d3d9 blit " + key);
                const bindGroupLayout = this.device.createBindGroupLayout({
                    entries: [
                        { binding: 0, visibility: SHADER_STAGE_VERTEX,
                          buffer: { type: "uniform" } },
                        { binding: 1, visibility: SHADER_STAGE_FRAGMENT,
                          texture: { sampleType: unfilterable
                              ? "unfilterable-float" : "float" } },
                        { binding: 2, visibility: SHADER_STAGE_FRAGMENT,
                          sampler: { type: unfilterable
                              ? "non-filtering" : "filtering" } },
                    ],
                });
                const pipeline = this.device.createRenderPipeline({
                    label: "D3D9 blit " + key,
                    layout: this.device.createPipelineLayout(
                        { bindGroupLayouts: [bindGroupLayout] }),
                    vertex: { module, entryPoint: "d9_vs_main" },
                    fragment: { module, entryPoint: "d9_ps_main",
                        targets: [{ format }] },
                    primitive: { topology: "triangle-list" },
                });
                const sampler = this.device.createSampler({
                    magFilter: point ? "nearest" : "linear",
                    minFilter: point ? "nearest" : "linear",
                    ...(anisotropy > 1 ? {mipmapFilter: "linear", maxAnisotropy: anisotropy} : {}),
                    addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
                });
                entry = { pipeline, bindGroupLayout, sampler };
                this.blitPipelines.set(key, entry);
                return entry;
            },

            replayBlit(encoder, op, swapView) {
                const sourceView = op.sourceView || swapView;
                const destinationView = op.destinationView || swapView;
                if (!sourceView || !destinationView) return null;
                const entry = this.blitPipelineFor(op.destinationFormat,
                    op.filterPoint, op.sourceFormat, op.maxAnisotropy);
                const uniform = this.utilityUniform(new Float32Array(op.sourceRect));
                const bindGroup = this.device.createBindGroup({
                    layout: entry.bindGroupLayout,
                    entries: [
                        { binding: 0, resource: uniform.binding },
                        { binding: 1, resource: sourceView },
                        { binding: 2, resource: entry.sampler },
                    ],
                });
                const pass = encoder.beginRenderPass({
                    colorAttachments: [{ view: destinationView,
                        loadOp: "load", storeOp: "store" }],
                });
                ++this.stats.renderPasses;
                pass.setPipeline(entry.pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.setViewport(op.viewport[0], op.viewport[1], op.viewport[2],
                    op.viewport[3], 0, 1);
                pass.draw(6);
                pass.end();
                return uniform.transient;
            },

            // WebGPU needs equal attachment extents. Keep the real depth /
            // stencil attachment and temporarily resize color storage, so
            // depth survives switching between large and small color targets.
            promoteColorTarget(color, width, height) {
                const owner = color.owner;
                if (!owner.colorPromotions) owner.colorPromotions = new Map();
                const sampleCount = color.sampleCount || 1;
                const key = width + "x" + height + "x" + sampleCount + ":" + color.format;
                let entry = owner.colorPromotions.get(key);
                if (!entry) {
                    const texture = this.device.createTexture({
                        label: "D3D9 color extent adapter " + key,
                        size: { width, height, depthOrArrayLayers: 1 },
                        format: color.format, sampleCount,
                        usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_TEXTURE_BINDING |
                            (sampleCount === 1 ? TEXTURE_USAGE_COPY_SRC | TEXTURE_USAGE_COPY_DST : 0),
                    });
                    entry = { texture, view: texture.createView() };
                    owner.colorPromotions.set(key, entry);
                }
                ++this.stats.colorTargetPromotions;
                return { ...color, view: entry.view, msaaView: null,
                    promotion: { ...entry, original: color,
                        width: Math.min(color.width, width), height: Math.min(color.height, height) } };
            },

            retireColorPromotions(owner) {
                if (!owner || !owner.colorPromotions) return;
                for (const entry of owner.colorPromotions.values()) this.retireGPUObject(entry.texture);
                owner.colorPromotions.clear();
            },

            multisampleCopyPipelineFor(format, sampleCount) {
                if (!this.multisampleCopyPipelines) this.multisampleCopyPipelines = new Map();
                const key = format + ":" + sampleCount;
                let entry = this.multisampleCopyPipelines.get(key);
                if (entry) return entry;
                const module = this.moduleFor(`@group(0) @binding(0) var source: texture_multisampled_2d<f32>;
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    return vec4<f32>(positions[index], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) position: vec4<f32>, @builtin(sample_index) sample: u32) -> @location(0) vec4<f32> {
    return textureLoad(source, vec2<i32>(position.xy), i32(sample));
}`, "D3D9 exact multisample copy " + key);
                const layout = this.device.createBindGroupLayout({ entries: [{ binding: 0,
                    visibility: SHADER_STAGE_FRAGMENT,
                    texture: { sampleType: "unfilterable-float", multisampled: true } }] });
                const pipeline = this.device.createRenderPipeline({
                    label: "D3D9 exact multisample copy " + key,
                    layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
                    vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format }] },
                    primitive: { topology: "triangle-list" }, multisample: { count: sampleCount },
                });
                entry = { layout, pipeline }; this.multisampleCopyPipelines.set(key, entry);
                return entry;
            },

            copyColorPromotion(encoder, color, restore) {
                const p = color.promotion, original = p.original;
                if ((color.sampleCount || 1) === 1) {
                    const actual = { texture: original.texture, mipLevel: original.level || 0,
                        origin: { x: 0, y: 0, z: original.face || 0 } };
                    const temporary = { texture: p.texture };
                    encoder.copyTextureToTexture(restore ? temporary : actual, restore ? actual : temporary,
                        { width: p.width, height: p.height, depthOrArrayLayers: 1 });
                } else {
                    // Resolve-and-unresolve would merge distinct coverage
                    // samples. Copy sample i to sample i instead, and only
                    // resolve once the original multisampled target is updated.
                    const entry = this.multisampleCopyPipelineFor(color.format, color.sampleCount);
                    const pass = encoder.beginRenderPass({ colorAttachments: [{
                        view: restore ? original.msaaView : p.view,
                        ...(restore ? { resolveTarget: original.view } : {}),
                        loadOp: "load", storeOp: "store",
                    }] });
                    pass.setPipeline(entry.pipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({ layout: entry.layout, entries: [
                        { binding: 0, resource: restore ? p.view : original.msaaView } ] }));
                    pass.setViewport(0, 0, p.width, p.height, 0, 1);
                    pass.draw(3); pass.end(); ++this.stats.renderPasses;
                }
                ++this.stats.colorExtentCopies;
            },

            prepareColorPromotions(encoder, targets) {
                if (!targets.promotedColors) return;
                for (const color of targets.colors) if (color && color.promotion)
                    this.copyColorPromotion(encoder, color, false);
            },

            restoreColorPromotions(encoder, targets) {
                if (!targets || !targets.promotedColors) return;
                for (const color of targets.colors) if (color && color.promotion)
                    this.copyColorPromotion(encoder, color, true);
            },

            colorAttachmentFor(color, swapView, swapSrgbView) {
                const resolved = color.view || (color.format === this.swapchainSrgbFormat ? swapSrgbView : swapView);
                return color.msaaView ? { view: color.msaaView, resolveTarget: resolved } : { view: resolved };
            },

            unresolveStale(encoder, targets, swapView) {
                for (const color of targets.colors) {
                    if (!color || !color.msaaOwner || !color.msaaOwner.msaaStale) continue;
                    color.msaaOwner.msaaStale = false;
                    const swapchain = color.swapchain;
                    const format = swapchain ? this.format : color.resource.gpuFormat;
                    const entry = this.unresolvePipelineFor(format, color.sampleCount);
                    const pass = encoder.beginRenderPass({ colorAttachments: [{
                        view: swapchain ? color.msaaOwner.backBufferMsaaView : this.msaaViewFor(color.resource, false),
                        loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
                    ++this.stats.renderPasses;
                    ++this.stats.msaaUnresolves;
                    pass.setPipeline(entry.pipeline);
                    pass.setBindGroup(0, this.device.createBindGroup({ layout: entry.layout, entries: [
                        { binding: 0, resource: swapchain ? (color.linearView || swapView) : this.targetViewFor(color.resource, 0, false, 0) }] }));
                    pass.draw(3);
                    pass.end();
                }
            },

            unresolvePipelineFor(format, sampleCount) {
                const key = format + "x" + sampleCount;
                this.unresolvePipelines = this.unresolvePipelines || new Map();
                let entry = this.unresolvePipelines.get(key);
                if (entry) return entry;
                const module = this.moduleFor(`@group(0) @binding(0) var resolved: texture_2d<f32>;
    @vertex
    fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
        var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
        return vec4<f32>(positions[index], 0.0, 1.0);
    }
    @fragment
    fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
        return textureLoad(resolved, vec2<i32>(position.xy), 0);
    }
    `, "d3d9 msaa unresolve");
                const layout = this.device.createBindGroupLayout({ entries: [{ binding: 0,
                    visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "unfilterable-float" } }] });
                entry = { layout, pipeline: this.gpuErrors.scoped("msaa unresolve pipeline", () =>
                    this.device.createRenderPipeline({
                        label: "D3D9 MSAA unresolve " + key,
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
                        vertex: { module, entryPoint: "vs" },
                        fragment: { module, entryPoint: "fs", targets: [{ format }] },
                        primitive: { topology: "triangle-list" },
                        multisample: { count: sampleCount },
                    })).object };
                this.unresolvePipelines.set(key, entry);
                return entry;
            },

            rectClearPipelineFor(targets, clearsColor, clearsDepth, clearsStencil) {
                // The key has to describe the *pass* this pipeline will be used
                // in, not just what the clear writes. WebGPU requires a pipeline's
                // attachment state -- colour formats, whether there is a
                // depth-stencil attachment, and the sample count -- to match the
                // pass exactly. Keying on the clear flags alone let a pipeline
                // built for a depth-less pass be reused in a pass that has depth,
                // which fails validation at setPipeline and invalidates the whole
                // command buffer, so the frame draws nothing. 3DMark 2001 hits
                // this the moment one pass drops depth (an undersized depth
                // surface does that) and the next one has it.
                const key = [targets.formats.join(","), clearsColor ? "c" : "-",
                    clearsDepth ? "d" : "-", clearsStencil ? "s" : "-",
                    targets.hasDepth ? "z" : "-",
                    targets.sampleCount || 1].join("|");
                if (!this.rectClearPipelines) this.rectClearPipelines = new Map();
                let entry = this.rectClearPipelines.get(key);
                if (entry) return entry;
                const slots = targets.formats.map((format, index) => format ? index : -1)
                    .filter(index => index >= 0);
                const colorFields = slots.map(index =>
                    "    @location(" + index + ") color" + index + ": vec4<f32>,");
                const colorWrites = slots.map(index =>
                    "    result.color" + index + " = clear.color;");
                const depthField = clearsDepth
                    ? "    @builtin(frag_depth) depth: f32," : "";
                const depthWrite = clearsDepth
                    ? "    result.depth = clear.depth.x;" : "";
                const hasOutput = colorFields.length > 0 || clearsDepth;
                const module = this.moduleFor(`struct D9RectClearUniforms {
        color: vec4<f32>,
        depth: vec4<f32>,
    };
    @group(0) @binding(0) var<uniform> clear: D9RectClearUniforms;
    
    ${hasOutput ? `struct D9RectClearOutput {
    ${colorFields.join("\n")}
    ${depthField}
    };` : ""}
    
    @vertex
    fn d9_vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
        var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0),
            vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
        return vec4<f32>(positions[index], 0.0, 1.0);
    }
    
    @fragment
    fn d9_ps_main()${hasOutput ? " -> D9RectClearOutput" : ""} {
        ${hasOutput ? "var result: D9RectClearOutput;" : ""}
    ${colorWrites.join("\n")}
    ${depthWrite}
        ${hasOutput ? "return result;" : ""}
    }
    `, "d3d9 rectangle clear " + key);
                const bindGroupLayout = this.device.createBindGroupLayout({
                    entries: [{ binding: 0, visibility: SHADER_STAGE_FRAGMENT,
                        buffer: { type: "uniform" } }],
                });
                const descriptor = {
                    label: "D3D9 rectangle clear " + key,
                    layout: this.device.createPipelineLayout(
                        { bindGroupLayouts: [bindGroupLayout] }),
                    vertex: { module, entryPoint: "d9_vs_main" },
                    fragment: { module, entryPoint: "d9_ps_main",
                        targets: targets.formats.map(format => format && ({ format,
                            writeMask: clearsColor ? 0xF : 0 })) },
                    primitive: { topology: "triangle-list" },
                };
                if (targets.hasDepth) {
                    const stencil = clearsStencil ? { compare: "always",
                        failOp: "keep", depthFailOp: "keep", passOp: "replace" } : {};
                    descriptor.depthStencil = { format: DEPTH_FORMAT,
                        depthWriteEnabled: clearsDepth, depthCompare: "always",
                        stencilFront: stencil, stencilBack: stencil,
                        stencilReadMask: clearsStencil ? 0xff : 0,
                        stencilWriteMask: clearsStencil ? 0xff : 0 };
                }
                if ((targets.sampleCount || 1) > 1)
                    descriptor.multisample = { count: targets.sampleCount };
                entry = { pipeline: this.device.createRenderPipeline(descriptor),
                    bindGroupLayout };
                this.rectClearPipelines.set(key, entry);
                return entry;
            },

            replayRectClear(encoder, op, swapView, swapSrgbView) {
                this.unresolveStale(encoder, op.targets, swapView);
                this.prepareColorPromotions(encoder, op.targets);
                const entry = this.rectClearPipelineFor(op.targets, op.clearsColor,
                    op.clearsDepth, op.clearsStencil);
                const uniform = this.utilityUniform(new Float32Array([
                    op.color.r, op.color.g, op.color.b, op.color.a,
                    op.depth, 0, 0, 0,
                ]));
                const bindGroup = this.device.createBindGroup({
                    layout: entry.bindGroupLayout,
                    entries: [{ binding: 0, resource: uniform.binding }],
                });
                const descriptor = {
                    colorAttachments: op.targets.colors.map(color => color && {
                        ...this.colorAttachmentFor(color, swapView, swapSrgbView),
                        loadOp: "load", storeOp: "store",
                    }),
                };
                if (op.targets.depthView) descriptor.depthStencilAttachment = {
                    view: op.targets.depthView,
                    depthLoadOp: "load", depthStoreOp: "store",
                    stencilLoadOp: "load", stencilStoreOp: "store",
                };
                const pass = encoder.beginRenderPass(descriptor);
                ++this.stats.renderPasses;
                pass.setPipeline(entry.pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.setStencilReference(op.stencil & 0xff);
                for (const rect of op.rects) {
                    pass.setViewport(rect.left, rect.top, rect.right - rect.left,
                        rect.bottom - rect.top, 0, 1);
                    pass.draw(3);
                }
                pass.end();
                this.restoreColorPromotions(encoder, op.targets);
                return uniform.transient;
            },

            colorFillPipelineFor(format) {
                if (!this.colorFillPipelines) this.colorFillPipelines = new Map();
                let entry = this.colorFillPipelines.get(format);
                if (entry) return entry;
                const module = this.moduleFor(`struct D9ColorFillUniforms {
        color: vec4<f32>,
    };
    @group(0) @binding(0) var<uniform> fill: D9ColorFillUniforms;
    
    @vertex
    fn d9_vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
        var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0),
            vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
        return vec4<f32>(positions[index], 0.0, 1.0);
    }
    
    @fragment
    fn d9_ps_main() -> @location(0) vec4<f32> {
        return fill.color;
    }
    `, "d3d9 ColorFill " + format);
                const bindGroupLayout = this.device.createBindGroupLayout({
                    entries: [{ binding: 0, visibility: SHADER_STAGE_FRAGMENT,
                        buffer: { type: "uniform" } }],
                });
                const pipeline = this.device.createRenderPipeline({
                    label: "D3D9 ColorFill " + format,
                    layout: this.device.createPipelineLayout(
                        { bindGroupLayouts: [bindGroupLayout] }),
                    vertex: { module, entryPoint: "d9_vs_main" },
                    fragment: { module, entryPoint: "d9_ps_main",
                        targets: [{ format }] },
                    primitive: { topology: "triangle-list" },
                });
                entry = { pipeline, bindGroupLayout };
                this.colorFillPipelines.set(format, entry);
                return entry;
            },

            replayColorFill(encoder, op) {
                const pass = encoder.beginRenderPass({ colorAttachments: [{
                    view: op.targetView, loadOp: op.isFull ? "clear" : "load",
                    storeOp: "store", ...(op.isFull ? { clearValue: {
                        r: op.rgba[0], g: op.rgba[1], b: op.rgba[2], a: op.rgba[3],
                    } } : {}),
                }] });
                ++this.stats.renderPasses;
                let transient = null;
                if (!op.isFull) {
                    const entry = this.colorFillPipelineFor(op.format);
                    const uniform = this.utilityUniform(new Float32Array(op.rgba));
                    transient = uniform.transient;
                    const bindGroup = this.device.createBindGroup({
                        layout: entry.bindGroupLayout,
                        entries: [{ binding: 0, resource: uniform.binding }],
                    });
                    pass.setPipeline(entry.pipeline);
                    pass.setBindGroup(0, bindGroup);
                    pass.setViewport(op.left, op.top, op.right - op.left,
                        op.bottom - op.top, 0, 1);
                    pass.draw(3);
                }
                pass.end();
                return transient;
            },

            ensureCursorPipeline() {
                if (this.cursor.pipeline) return this.cursor.pipeline;
                const module = this.device.createShaderModule({
                    label: "D3D9 cursor",
                    code: `
    struct CursorRect { origin: vec2<f32>, size: vec2<f32> };
    @group(0) @binding(0) var<uniform> rect: CursorRect;
    @group(0) @binding(1) var cursor_texture: texture_2d<f32>;
    @group(0) @binding(2) var cursor_sampler: sampler;
    
    struct VSOut {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
    };
    
    @vertex
    fn vs_main(@builtin(vertex_index) index: u32) -> VSOut {
        // Two triangles covering the cursor's rectangle, in normalised
        // back-buffer space supplied by the uniform.
        var corners = array<vec2<f32>, 6>(
            vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
            vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
        let corner = corners[index];
        let position = rect.origin + corner * rect.size;
        var out: VSOut;
        out.position = vec4<f32>(position.x * 2.0 - 1.0,
            1.0 - position.y * 2.0, 0.0, 1.0);
        out.uv = corner;
        return out;
    }
    
    @fragment
    fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
        return textureSample(cursor_texture, cursor_sampler, in.uv);
    }
    `,
                });
                const bindGroupLayout = this.device.createBindGroupLayout({
                    entries: [
                        { binding: 0, visibility: SHADER_STAGE_VERTEX, buffer: { type: "uniform" } },
                        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, texture: {} },
                        { binding: 2, visibility: SHADER_STAGE_FRAGMENT, sampler: {} },
                    ],
                });
                this.cursor.bindGroupLayout = bindGroupLayout;
                this.cursor.sampler = this.device.createSampler({
                    magFilter: "nearest", minFilter: "nearest",
                    addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
                });

                this.cursor.pipeline = this.device.createRenderPipeline({
                    layout: this.device.createPipelineLayout(
                        { bindGroupLayouts: [bindGroupLayout] }),
                    vertex: { module, entryPoint: "vs_main" },
                    fragment: { module, entryPoint: "fs_main", targets: [{
                        format: this.format,
                        // Straight alpha: a cursor bitmap's transparent texels
                        // must not paint over the frame.
                        blend: {
                            color: { srcFactor: "src-alpha",
                                     dstFactor: "one-minus-src-alpha", operation: "add" },
                            alpha: { srcFactor: "one",
                                     dstFactor: "one-minus-src-alpha", operation: "add" },
                        },
                    }] },
                    primitive: { topology: "triangle-list" },
                });
                return this.cursor.pipeline;
            },

            drawCursor(encoder, targetView, width, height) {
                const cursor = this.cursor;
                if (!cursor.visible || !cursor.view || !width || !height) return;
                const pipeline = this.ensureCursorPipeline();
                const originX = (cursor.x - cursor.hotspotX) / width;
                const originY = (cursor.y - cursor.hotspotY) / height;
                const uniform = this.utilityUniform(new Float32Array([
                    originX, originY, cursor.width / width, cursor.height / height,
                ]));
                const bindGroup = this.device.createBindGroup({
                    layout: cursor.bindGroupLayout,
                    entries: [
                        { binding: 0, resource: uniform.binding },
                        { binding: 1, resource: cursor.view },
                        { binding: 2, resource: cursor.sampler },
                    ],
                });
                const pass = encoder.beginRenderPass({
                    colorAttachments: [{ view: targetView, loadOp: "load", storeOp: "store" }],
                });
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.draw(6);
                pass.end();
                ++this.stats.cursorDraws;
                return uniform.transient;
            },

            replayDDOverlays(encoder, state, sourceTexture, width, height, frame) {
                if (!state || !state.ddOverlays) return null;
                const overlays = [...state.ddOverlays.values()]
                    .filter(entry => entry.visible)
                    .sort((a, b) => a.zOrder - b.zOrder);
                if (!overlays.length) return null;
                const composite = this.device.createTexture({
                    label: "DirectDraw overlay composite",
                    size: { width, height, depthOrArrayLayers: 1 },
                    format: this.format,
                    mipLevelCount: 1,
                    usage: TEXTURE_USAGE_COPY_SRC | TEXTURE_USAGE_COPY_DST |
                        TEXTURE_USAGE_TEXTURE_BINDING |
                        TEXTURE_USAGE_RENDER_ATTACHMENT,
                });
                encoder.copyTextureToTexture({ texture: sourceTexture },
                    { texture: composite },
                    { width, height, depthOrArrayLayers: 1 });
                const compositeView = composite.createView();

                for (const overlay of overlays) {
                    const source = this.resources.get(overlay.surfaceHandle);
                    if (!source || !source.gpuTexture) continue;
                    const sourceWidth = source.width;
                    const sourceHeight = source.height;
                    const sourceRect = {
                        left: overlay.sourceRect[0], top: overlay.sourceRect[1],
                        right: overlay.sourceRect[2], bottom: overlay.sourceRect[3],
                    };
                    const destinationRect = {
                        left: overlay.destinationRect[0],
                        top: overlay.destinationRect[1],
                        right: overlay.destinationRect[2],
                        bottom: overlay.destinationRect[3],
                    };
                    const clipped = clipRects(sourceRect, destinationRect,
                        width, height);
                    if (!clipped) continue;
                    const sourceIndexed = !!source.ddIndexed;
                    const sourceColorKey = (overlay.flags & DDOVER_KEY_SOURCE)
                        ? overlay.sourceColorKey : null;
                    const destinationColorKey =
                        (overlay.flags & DDOVER_KEY_DESTINATION)
                            ? overlay.destinationColorKey : null;
                    if ((overlay.flags & DDOVER_KEY_SOURCE) && !sourceColorKey)
                        continue;
                    if ((overlay.flags & DDOVER_KEY_DESTINATION) &&
                            !destinationColorKey)
                        continue;
                    let paletteBuffer = null;
                    if (sourceIndexed) paletteBuffer = this.ddPaletteBufferFor(source, encoder);
                    const src = clipped.source;
                    const sourceU = src.left / sourceWidth;
                    const sourceV = src.top / sourceHeight;
                    const sourceDU = (src.right - src.left) / sourceWidth;
                    const sourceDV = (src.bottom - src.top) / sourceHeight;
                    const transient = this.replayDDBlit(encoder, {
                        sourceKind: sourceIndexed ? "index" : "float",
                        destinationKind: "float",
                        sourceView: this.blitSourceView(source, 0, 0),
                        destinationView: compositeView,
                        destinationFormat: this.format,
                        sourceFormat: source.gpuFormat || "rgba8unorm",
                        sourceRect: [
                            (overlay.flags & DDOVER_MIRROR_X)
                                ? sourceU + sourceDU : sourceU,
                            (overlay.flags & DDOVER_MIRROR_Y)
                                ? sourceV + sourceDV : sourceV,
                            (overlay.flags & DDOVER_MIRROR_X)
                                ? -sourceDU : sourceDU,
                            (overlay.flags & DDOVER_MIRROR_Y)
                                ? -sourceDV : sourceDV,
                        ],
                        sourceSize: [sourceWidth, sourceHeight],
                        viewport: clipped.viewport,
                        colorKey: sourceColorKey,
                        destinationColorKey,
                        destinationTexture: sourceTexture,
                        destinationLevel: 0,
                        destinationFace: 0,
                        destinationSize: [width, height],
                        paletteBuffer,
                        paletteResolve: !!paletteBuffer,
                        filterPoint: sourceIndexed,
                    }, compositeView, composite);
                    if (transient) frame.transientBuffers.push(transient);
                    this.stats.ddOverlayComposites =
                        (this.stats.ddOverlayComposites || 0) + 1;
                }
                return composite;
            },

            ddBlitPipelineFor(variant) {
                const key = [variant.destinationFormat, variant.sourceKind,
                    variant.destinationKind, variant.colorKey ? "key" : "-", variant.keyToAlpha ? "alpha" : "-",
                    variant.destinationKey ? "dest-key" : "-",
                    variant.paletteResolve ? "pal" : "-",
                    variant.filterPoint ? "point" : "linear"].join("|");
                if (!this.ddBlitPipelines) this.ddBlitPipelines = new Map();
                let entry = this.ddBlitPipelines.get(key);
                if (entry) return entry;
                const module = this.moduleFor(ddBlitShaderSource(variant),
                    "ddraw blit " + key);
                const entries = [
                    { binding: 0, visibility: SHADER_STAGE_VERTEX |
                        SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
                ];
                if (variant.sourceKind === "index")
                    entries.push({ binding: 1, visibility: SHADER_STAGE_FRAGMENT,
                        texture: { sampleType: "uint" } });
                else if (variant.sourceKind === "float") {
                    entries.push({ binding: 1, visibility: SHADER_STAGE_FRAGMENT,
                        texture: { sampleType: "float" } });
                    entries.push({ binding: 2, visibility: SHADER_STAGE_FRAGMENT,
                        sampler: { type: "filtering" } });
                }
                if (variant.paletteResolve)
                    entries.push({ binding: 3, visibility: SHADER_STAGE_FRAGMENT,
                        buffer: { type: "uniform" } });
                if (variant.destinationKey)
                    entries.push({ binding: 4, visibility: SHADER_STAGE_FRAGMENT,
                        texture: { sampleType: variant.destinationKind === "index"
                            ? "uint" : "float" } });
                const bindGroupLayout =
                    this.device.createBindGroupLayout({ entries });
                const pipeline = this.device.createRenderPipeline({
                    label: "DirectDraw blit " + key,
                    layout: this.device.createPipelineLayout(
                        { bindGroupLayouts: [bindGroupLayout] }),
                    vertex: { module, entryPoint: "d9dd_vs_main" },
                    fragment: { module, entryPoint: "d9dd_ps_main",
                        targets: [{ format: variant.destinationFormat }] },
                    primitive: { topology: "triangle-list" },
                });
                const sampler = variant.sourceKind === "float"
                    ? this.device.createSampler({
                        magFilter: variant.filterPoint ? "nearest" : "linear",
                        minFilter: variant.filterPoint ? "nearest" : "linear",
                        addressModeU: "clamp-to-edge",
                        addressModeV: "clamp-to-edge",
                    })
                    : null;
                entry = { pipeline, bindGroupLayout, sampler };
                this.ddBlitPipelines.set(key, entry);
                return entry;
            },

            replayDDBlit(encoder, op, swapView, swapTexture) {
                const destinationView = op.destinationView || swapView;
                if (!destinationView) return null;
                // A swap-chain source is whatever the canvas format is, never an
                // index texture, and the variant has to say so or the pipeline
                // declares a texture_2d<u32> for a float view.
                const swapchainSource = op.sourceKind !== "none" && !op.sourceView;
                const variant = {
                    // The swap-chain image is whatever the canvas format is and is
                    // never an index texture, so a blit that reads it is a float
                    // blit no matter what the recorded kind said.
                    sourceKind: swapchainSource ? "float" : op.sourceKind,
                    destinationKind: op.destinationView
                        ? op.destinationKind : "float",
                    destinationFormat: op.destinationView
                        ? op.destinationFormat : this.format,
                    colorKey: !!op.colorKey, keyToAlpha: !!op.keyToAlpha,
                    destinationKey: !!op.destinationColorKey,
                    paletteResolve: !!op.paletteBuffer,
                    filterPoint: !!op.filterPoint,
                };
                let snapshotTexture = null;
                let snapshotView = null;
                let destinationKeyView = null;
                if (variant.destinationKey || op.sourceSnapshot) {
                    const snapshotSource = variant.destinationKey
                        ? (op.destinationTexture || swapTexture)
                        : op.sourceTexture;
                    const size = variant.destinationKey
                        ? (op.destinationSize || [1, 1])
                        : (op.sourceSize || [1, 1]);
                    if (!snapshotSource || !size[0] || !size[1]) return null;
                    snapshotTexture = this.device.createTexture({
                        label: variant.destinationKey
                            ? "DirectDraw destination colour-key snapshot"
                            : "DirectDraw self-blit snapshot",
                        size: { width: size[0], height: size[1],
                            depthOrArrayLayers: 1 },
                        format: variant.destinationKey
                            ? variant.destinationFormat : op.sourceFormat,
                        mipLevelCount: 1,
                        usage: TEXTURE_USAGE_COPY_DST |
                            TEXTURE_USAGE_TEXTURE_BINDING,
                    });
                    encoder.copyTextureToTexture({ texture: snapshotSource,
                        mipLevel: variant.destinationKey
                            ? (op.destinationLevel || 0) : (op.sourceLevel || 0),
                        origin: { x: 0, y: 0,
                            z: variant.destinationKey
                                ? (op.destinationFace || 0) : (op.sourceFace || 0) } },
                        { texture: snapshotTexture },
                        { width: size[0], height: size[1],
                            depthOrArrayLayers: 1 });
                    snapshotView = snapshotTexture.createView();
                    if (variant.destinationKey) destinationKeyView = snapshotView;
                }
                const sourceView = op.sourceKind === "none" ? null
                    : (op.sourceSnapshot ? snapshotView : (op.sourceView || swapView));
                if (op.sourceKind !== "none" && !sourceView) return null;
                const entry = this.ddBlitPipelineFor(variant);
                const uniform = this.utilityUniform(packUniforms(op));
                const entries = [{ binding: 0, resource: uniform.binding }];
                if (variant.sourceKind !== "none") {
                    entries.push({ binding: 1, resource: sourceView });
                    if (variant.sourceKind === "float")
                        entries.push({ binding: 2, resource: entry.sampler });
                }
                if (variant.paletteResolve)
                    entries.push({ binding: 3,
                        resource: { buffer: op.paletteBuffer } });
                if (variant.destinationKey)
                    entries.push({ binding: 4, resource: destinationKeyView });
                const bindGroup = this.device.createBindGroup({
                    layout: entry.bindGroupLayout, entries });
                const pass = encoder.beginRenderPass({
                    colorAttachments: [{ view: destinationView,
                        loadOp: "load", storeOp: "store" }],
                });
                ++this.stats.renderPasses;
                pass.setPipeline(entry.pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.setViewport(op.viewport[0], op.viewport[1], op.viewport[2],
                    op.viewport[3], 0, 1);
                pass.draw(6);
                pass.end();
                if (!snapshotTexture) return uniform.transient;
                return { destroy() {
                    if (uniform.transient) uniform.transient.destroy();
                    snapshotTexture.destroy();
                } };
            }
        };
    }
    const api = { createMethods, packUniforms, ddBlitShaderSource, clipRects, clipDestination, PALETTE_ENTRIES, PALETTE_BYTES };
    global.D9WGSurfaceOps = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
