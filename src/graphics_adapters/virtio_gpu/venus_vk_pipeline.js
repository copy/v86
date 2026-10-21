// The Venus device's shaders, pipelines, descriptor sets, render passes and
// framebuffers (venus_vk.js runs them). Shader modules go to the renderer
// as SPIR-V (it translates them with naga); pipelines as a description of
// their state, which the renderer turns into WebGPU pipelines; descriptor
// sets stay here and are sent, resolved, when a submission binds them.

import { VX } from "../renderer_protocol.js";
import { VK_SUCCESS, VK_ERROR_OUT_OF_HOST_MEMORY, REMAINING, out_array } from "./venus_device_info.js";

const STYPE_RENDER_PASS_MULTIVIEW = 1000053000;
const STYPE_PIPELINE_RENDERING_CREATE_INFO = 1000044002;
// VkPipelineRasterizationProvokingVertexStateCreateInfoEXT
const STYPE_PROVOKING_VERTEX_STATE = 1000254001;
// VkSubpassDescriptionDepthStencilResolve
const STYPE_DEPTH_STENCIL_RESOLVE = 1000199001;

/** UTF-8 of a JSON description, for the renderer */
function json_bytes(object)
{
    return new TextEncoder().encode(JSON.stringify(object));
}

/** VkSpecializationInfo: constant id -> its bytes as the shader reads them (u32 bits) */
function specialization(info)
{
    if(!info || !info.pMapEntries || !info.pData) return {};
    const out = {};
    const view = new DataView(info.pData.buffer, info.pData.byteOffset, info.pData.byteLength);
    for(const entry of info.pMapEntries)
    {
        if(entry.offset + 4 <= view.byteLength) out[entry.constantID] = view.getUint32(entry.offset, true);
        else if(entry.size === 1 && entry.offset < view.byteLength) out[entry.constantID] = view.getUint8(entry.offset);
    }
    return out;
}

/**
 * A render pass from VkRenderPassCreateInfo or ...2 (the fields both have)
 * @param {!Object} info
 * @param {boolean} two
 */
function render_pass(info, two)
{
    const ref = r => r ? { attachment: r.attachment, layout: r.layout, aspect: r.aspectMask || 0 } : null;
    return {
        type: "render_pass",
        attachments: (info.pAttachments || []).map(a => ({
            format: a.format, samples: a.samples, load: a.loadOp, store: a.storeOp,
            stencil_load: a.stencilLoadOp, stencil_store: a.stencilStoreOp,
        })),
        subpasses: (info.pSubpasses || []).map(s => ({
            colors: (s.pColorAttachments || []).map(ref),
            resolves: s.pResolveAttachments ? s.pResolveAttachments.map(ref) : null,
            inputs: (s.pInputAttachments || []).map(ref),
            depth: ref(s.pDepthStencilAttachment),
            // (VkSubpassDescriptionDepthStencilResolve: the depth and stencil resolved, sample zero)
            depth_resolve: (() => {
                for(let n = s.pNext; n; n = n.pNext)
                {
                    if(n.sType === STYPE_DEPTH_STENCIL_RESOLVE && n.pDepthStencilResolveAttachment)
                    {
                        return { attachment: n.pDepthStencilResolveAttachment.attachment, depth: n.depthResolveMode, stencil: n.stencilResolveMode };
                    }
                }
                return null;
            })(),
            view_mask: two ? s.viewMask : 0,
        })),
    };
}

/**
 * A graphics pipeline's state, as the renderer wants it
 * @param {!Object} ctx
 * @param {!Object} info VkGraphicsPipelineCreateInfo
 */
function graphics_pipeline(ctx, info)
{
    const pass = ctx.objects.get(info.renderPass);
    const subpass = pass && pass.subpasses[info.subpass] || { colors: [], depth: null };
    const layout = ctx.objects.get(info.layout) || { sets: [], push_size: 0 };
    const vi = info.pVertexInputState || {}, ia = info.pInputAssemblyState || {}, rs = info.pRasterizationState || {};
    const ms = info.pMultisampleState || {}, ds = info.pDepthStencilState, cb = info.pColorBlendState || {};
    let formats, depth, samples;
    if(pass)
    {
        formats = subpass.colors.map(r => r && r.attachment !== REMAINING && pass.attachments[r.attachment] ? pass.attachments[r.attachment].format : 0);
        depth = subpass.depth && subpass.depth.attachment !== REMAINING && pass.attachments[subpass.depth.attachment];
        samples = subpass.colors.concat([subpass.depth]).map(r => r && r.attachment !== REMAINING && pass.attachments[r.attachment])
            .filter(a => a).map(a => a.samples)[0] || 1;
    }
    else
    {
        // dynamic rendering: the formats are the pipeline's (VkPipelineRenderingCreateInfo)
        let rendering = null;
        for(let s = info.pNext; s; s = s.pNext) if(s.sType === STYPE_PIPELINE_RENDERING_CREATE_INFO) rendering = s;
        formats = rendering ? Array.from(rendering.pColorAttachmentFormats || []) : [];
        const depth_format = rendering ? rendering.depthAttachmentFormat || rendering.stencilAttachmentFormat : 0;
        depth = depth_format ? { format: depth_format } : null;
        samples = ms.rasterizationSamples || 1;
    }
    // VK_EXT_provoking_vertex: the last vertex of a primitive (GL's) for flat varyings
    let provoking_last = false;
    for(let s = rs.pNext; s; s = s.pNext) if(s.sType === STYPE_PROVOKING_VERTEX_STATE) provoking_last = s.provokingVertexMode === 1;
    const stencil = s => s && { fail: s.failOp, pass: s.passOp, depth_fail: s.depthFailOp, compare: s.compareOp,
        read_mask: s.compareMask, write_mask: s.writeMask, reference: s.reference };
    return {
        kind: "graphics",
        stages: (info.pStages || []).map(s => ({ shader: (ctx.objects.get(s.module) || {}).rid || 0, stage: s.stage, entry: s.pName,
            constants: specialization(s.pSpecializationInfo) })),
        buffers: (vi.pVertexBindingDescriptions || []).map(b => ({ binding: b.binding, stride: b.stride, rate: b.inputRate })),
        attributes: (vi.pVertexAttributeDescriptions || []).map(a => ({ location: a.location, binding: a.binding, format: a.format, offset: a.offset })),
        topology: ia.topology || 0, restart: !!ia.primitiveRestartEnable,
        cull: rs.cullMode || 0, front: rs.frontFace || 0, polygon: rs.polygonMode || 0, depth_clamp: !!rs.depthClampEnable, provoking_last,
        discard: !!rs.rasterizerDiscardEnable,
        depth_bias: rs.depthBiasEnable ? { constant: rs.depthBiasConstantFactor, clamp: rs.depthBiasClamp, slope: rs.depthBiasSlopeFactor } : null,
        samples, sample_mask: ms.pSampleMask ? ms.pSampleMask[0] : 0xFFFFFFFF, alpha_to_coverage: !!ms.alphaToCoverageEnable,
        depth: ds && depth ? { test: !!ds.depthTestEnable, write: !!ds.depthWriteEnable, compare: ds.depthCompareOp,
            stencil: !!ds.stencilTestEnable, front: stencil(ds.front), back: stencil(ds.back) } : null,
        depth_format: depth ? depth.format : 0,
        targets: formats.map((format, i) => {
            const a = (cb.pAttachments || [])[i] || {};
            return { format, blend: !!a.blendEnable, src_color: a.srcColorBlendFactor, dst_color: a.dstColorBlendFactor, color_op: a.colorBlendOp,
                src_alpha: a.srcAlphaBlendFactor, dst_alpha: a.dstAlphaBlendFactor, alpha_op: a.alphaBlendOp,
                write_mask: a.colorWriteMask === undefined ? 0xF : a.colorWriteMask };
        }),
        blend_constants: cb.blendConstants ? Array.from(cb.blendConstants) : [0, 0, 0, 0],
        dynamic: info.pDynamicState && info.pDynamicState.pDynamicStates ? Array.from(info.pDynamicState.pDynamicStates) : [],
        viewport: info.pViewportState && info.pViewportState.pViewports ? info.pViewportState.pViewports[0] : null,
        scissor: info.pViewportState && info.pViewportState.pScissors ? info.pViewportState.pScissors[0] : null,
        set_count: layout.sets.length, push_size: layout.push_size,
    };
}

/** @type {!Object<string, function(!Object, !Object, !Object): ?function(function())>} */
export const PIPELINE_HANDLERS = {
    // Shaders

    "vkCreateShaderModule": function(vk, ctx, a)
    {
        const info = a.pCreateInfo;
        const module = { type: "shader_module", rid: vk.new_rid() };
        const code = info.pCode;
        const bytes = new Uint8Array(code.buffer, code.byteOffset, Math.min(info.codeSize, code.byteLength));
        vk.vx.command(VX.SHADER_CREATE, [module.rid, bytes.length], bytes);
        ctx.objects.set(a.pShaderModule, module);
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyShaderModule": function(vk, ctx, a)
    {
        const module = ctx.objects.get(a.shaderModule);
        if(module) vk.vx.command(VX.DESTROY, [module.rid]);
        ctx.objects.delete(a.shaderModule);
        return null;
    },

    // Descriptor set layouts, pipeline layouts

    "vkCreateDescriptorSetLayout": function(vk, ctx, a)
    {
        const bindings = new Map();
        for(const b of a.pCreateInfo.pBindings || [])
        {
            bindings.set(b.binding, { type: b.descriptorType, count: b.descriptorCount, stages: b.stageFlags,
                immutable: b.pImmutableSamplers ? Array.from(b.pImmutableSamplers) : null });
        }
        ctx.objects.set(a.pSetLayout, { type: "set_layout", bindings });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyDescriptorSetLayout": function(vk, ctx, a) { ctx.objects.delete(a.descriptorSetLayout); return null; },
    "vkGetDescriptorSetLayoutSupport": function(vk, ctx, a)
    {
        const count = (a.pCreateInfo.pBindings || []).reduce((n, b) => n + b.descriptorCount, 0);
        a.pSupport.supported = count <= 1024 ? 1 : 0;
        return null;
    },
    "vkCreatePipelineLayout": function(vk, ctx, a)
    {
        const info = a.pCreateInfo;
        const push = (info.pPushConstantRanges || []).reduce((n, r) => Math.max(n, r.offset + r.size), 0);
        ctx.objects.set(a.pPipelineLayout, { type: "pipeline_layout", sets: Array.from(info.pSetLayouts || []), push_size: push });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyPipelineLayout": function(vk, ctx, a) { ctx.objects.delete(a.pipelineLayout); return null; },

    // Descriptor pools and sets

    "vkCreateDescriptorPool": function(vk, ctx, a)
    {
        ctx.objects.set(a.pDescriptorPool, { type: "descriptor_pool", sets: new Set() });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyDescriptorPool": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.descriptorPool);
        if(pool) for(const id of pool.sets) ctx.objects.delete(id);
        ctx.objects.delete(a.descriptorPool);
        return null;
    },
    "vkResetDescriptorPool": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.descriptorPool);
        if(pool) { for(const id of pool.sets) ctx.objects.delete(id); pool.sets.clear(); }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkAllocateDescriptorSets": function(vk, ctx, a)
    {
        const info = a.pAllocateInfo;
        const pool = ctx.objects.get(info.descriptorPool);
        (a.pDescriptorSets || []).forEach((id, i) => {
            const layout = ctx.objects.get(info.pSetLayouts[i]) || { bindings: new Map() };
            const set = { type: "descriptor_set", layout, descriptors: new Map(), version: 0 };
            // immutable samplers are there from the start
            for(const [binding, b] of layout.bindings)
            {
                if(b.immutable) b.immutable.forEach((sampler, e) => set.descriptors.set(binding * 1024 + e, { type: b.type, sampler }));
            }
            ctx.objects.set(id, set);
            if(pool) pool.sets.add(id);
        });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkFreeDescriptorSets": function(vk, ctx, a)
    {
        const pool = ctx.objects.get(a.descriptorPool);
        for(const id of a.pDescriptorSets || []) { ctx.objects.delete(id); if(pool) pool.sets.delete(id); }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkUpdateDescriptorSets": function(vk, ctx, a)
    {
        for(const w of a.pDescriptorWrites || [])
        {
            const set = ctx.objects.get(w.dstSet);
            if(!set) continue;
            set.version++;
            // (a write past a binding's count goes on into the next binding)
            let binding = w.dstBinding, element = w.dstArrayElement;
            for(let i = 0; i < w.descriptorCount; i++)
            {
                const b = set.layout.bindings.get(binding);
                if(b && element >= b.count) { binding++; element = 0; }
                const d = { type: w.descriptorType };
                if(w.pImageInfo && w.pImageInfo[i])
                {
                    d.view = w.pImageInfo[i].imageView;
                    d.sampler = w.pImageInfo[i].sampler;
                    const lb = set.layout.bindings.get(binding);
                    if(lb && lb.immutable) d.sampler = lb.immutable[element];
                }
                if(w.pBufferInfo && w.pBufferInfo[i]) { d.buffer = w.pBufferInfo[i].buffer; d.offset = w.pBufferInfo[i].offset; d.range = w.pBufferInfo[i].range; }
                if(w.pTexelBufferView && w.pTexelBufferView[i]) d.texel = w.pTexelBufferView[i];
                set.descriptors.set(binding * 1024 + element, d);
                element++;
            }
        }
        for(const c of a.pDescriptorCopies || [])
        {
            const src = ctx.objects.get(c.srcSet), dst = ctx.objects.get(c.dstSet);
            if(!src || !dst) continue;
            dst.version++;
            for(let i = 0; i < c.descriptorCount; i++)
            {
                const d = src.descriptors.get(c.srcBinding * 1024 + c.srcArrayElement + i);
                if(d) dst.descriptors.set(c.dstBinding * 1024 + c.dstArrayElement + i, Object.assign({}, d));
            }
        }
        return null;
    },

    // Render passes, framebuffers

    "vkCreateRenderPass": function(vk, ctx, a)
    {
        ctx.objects.set(a.pRenderPass, render_pass(a.pCreateInfo, false));
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkCreateRenderPass2": function(vk, ctx, a)
    {
        ctx.objects.set(a.pRenderPass, render_pass(a.pCreateInfo, true));
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyRenderPass": function(vk, ctx, a) { ctx.objects.delete(a.renderPass); return null; },
    "vkGetRenderAreaGranularity": function(vk, ctx, a)
    {
        a.pGranularity = { width: 1, height: 1 };
        return null;
    },
    "vkCreateFramebuffer": function(vk, ctx, a)
    {
        const info = a.pCreateInfo;
        ctx.objects.set(a.pFramebuffer, { type: "framebuffer", attachments: Array.from(info.pAttachments || []),
            width: info.width, height: info.height, layers: info.layers });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyFramebuffer": function(vk, ctx, a) { ctx.objects.delete(a.framebuffer); return null; },

    // Pipelines

    "vkCreateGraphicsPipelines": function(vk, ctx, a)
    {
        (a.pCreateInfos || []).forEach((info, i) => {
            const id = a.pPipelines[i];
            const pipeline = { type: "pipeline", rid: vk.new_rid(), bind_point: 0, layout: info.layout };
            vk.vx.command(VX.PIPELINE_CREATE, [pipeline.rid], json_bytes(graphics_pipeline(ctx, info)));
            ctx.objects.set(id, pipeline);
        });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkCreateComputePipelines": function(vk, ctx, a)
    {
        (a.pCreateInfos || []).forEach((info, i) => {
            const id = a.pPipelines[i];
            const layout = ctx.objects.get(info.layout) || { sets: [], push_size: 0 };
            const pipeline = { type: "pipeline", rid: vk.new_rid(), bind_point: 1, layout: info.layout };
            const s = info.stage;
            vk.vx.command(VX.PIPELINE_CREATE, [pipeline.rid], json_bytes({ kind: "compute",
                stages: [{ shader: (ctx.objects.get(s.module) || {}).rid || 0, stage: s.stage, entry: s.pName, constants: specialization(s.pSpecializationInfo) }],
                set_count: layout.sets.length, push_size: layout.push_size }));
            ctx.objects.set(id, pipeline);
        });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyPipeline": function(vk, ctx, a)
    {
        const pipeline = ctx.objects.get(a.pipeline);
        if(pipeline) vk.vx.command(VX.DESTROY, [pipeline.rid]);
        ctx.objects.delete(a.pipeline);
        return null;
    },
    "vkCreatePipelineCache": function(vk, ctx, a)
    {
        ctx.objects.set(a.pPipelineCache, { type: "pipeline_cache" });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyPipelineCache": function(vk, ctx, a) { ctx.objects.delete(a.pipelineCache); return null; },
    "vkGetPipelineCacheData": function(vk, ctx, a)
    {
        // (nothing kept: an empty cache's header is still the app's to read; none)
        a.pDataSize = 0;
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkMergePipelineCaches": function(vk, ctx, a) { a.ret = VK_SUCCESS; return null; },
};
