// The Venus device's memory and the objects in it (venus_vk.js runs them):
// a VkDeviceMemory is a GPU buffer of the renderer's (VX), and while the
// guest maps it, also pages of the host visible memory (BAR4) -- the pages
// the guest writes go to the GPU buffer before each submission, what the GPU
// writes comes back before the submission completes. A VkBuffer is a range
// of its memory; a VkImage is a texture of its own (its memory only counts).

import { VX } from "../renderer_protocol.js";
import * as INFO from "./venus_device_info.js";
import { VK_SUCCESS, VK_ERROR_OUT_OF_DEVICE_MEMORY, VK_ERROR_FORMAT_NOT_SUPPORTED, VK_ERROR_INVALID_EXTERNAL_HANDLE,
    WHOLE, REMAINING, out_array } from "./venus_device_info.js";

const STYPE_MEMORY_DEDICATED_REQUIREMENTS = 1000127000;
const STYPE_IMPORT_MEMORY_RESOURCE_INFO_MESA = 1000384002;
const STYPE_MEMORY_RESOURCE_ALLOCATION_SIZE_PROPERTIES_MESA = 1000384003;

/** what memory of buffers and images is aligned to (WebGPU's binding offsets) */
const ALIGNMENT = 256;

const align = (value, to) => Math.ceil(value / to) * to;
const lo = value => value % 0x100000000 >>> 0;
const hi = value => Math.floor(value / 0x100000000) >>> 0;

/**
 * A VkDeviceMemory
 * @constructor
 */
export function Memory(rid, size, type_index)
{
    this.type = "memory";
    this.rid = rid;
    this.size = size;
    this.type_index = type_index;
    this.host_visible = type_index !== INFO.MEMORY_DEVICE_LOCAL;
    /** @type {Object} the blob exporting it (mapped by the guest at its map_offset) */
    this.blob = null;
    /** the GPU wrote it since the guest last saw it */
    this.gpu_written = false;
}

/**
 * The bytes an image's memory says it has: every mip of every layer
 * @param {!Object} image
 */
export function image_size(image)
{
    const texel = INFO.FORMATS[image.format] ? INFO.FORMATS[image.format][3] : 4;
    let size = 0;
    for(let mip = 0; mip < image.mips; mip++)
    {
        const w = Math.max(1, image.width >> mip), h = Math.max(1, image.height >> mip), d = Math.max(1, image.depth >> mip);
        size += w * h * d * texel;
    }
    return align(size * image.layers * image.samples, ALIGNMENT);
}

/** @return {Object} VkMemoryRequirements of a buffer */
function buffer_requirements(size)
{
    return { size: align(size, 4), alignment: ALIGNMENT, memoryTypeBits: 7 };
}

/**
 * An image bound to its memory; memory imported from a virtio-gpu resource
 * makes the image that resource's GX surface (VX.TEXTURE_IMPORT)
 */
function bind_image(vk, image, memory, offset)
{
    image.memory = memory;
    image.offset = offset;
    if(memory && memory.resource_id && !image.resource_id)
    {
        image.resource_id = memory.resource_id;
        vk.vx.command(VX.TEXTURE_IMPORT, [image.rid, memory.resource_id]);
    }
}

/** VkMemoryRequirements of an image: device local memory (images are textures) */
function image_requirements(image)
{
    return { size: image_size(image), alignment: ALIGNMENT, memoryTypeBits: 1 << INFO.MEMORY_DEVICE_LOCAL };
}

/** fill VkMemoryRequirements2's chain */
function requirements2(out, requirements)
{
    out.memoryRequirements = requirements;
    for(let s = out.pNext; s; s = s.pNext)
    {
        if(s.sType === STYPE_MEMORY_DEDICATED_REQUIREMENTS)
        {
            s.prefersDedicatedAllocation = 0;
            s.requiresDedicatedAllocation = 0;
        }
    }
}

/**
 * The bytes a virtio-gpu resource Venus imports holds: its blob's size, or
 * its texels (the bits in its virgl format's name), aligned as images' memory
 * @param {!Object} resource a virgl Resource3D
 */
function resource_size(resource)
{
    if(resource.blob_size > 0) return resource.blob_size;
    // (the name is the SVGA3D format's: SVGA3D_R8G8B8A8_UNORM)
    const bits = resource.info ? (resource.info.name.replace(/^SVGA3D_/, "").match(/\d+/g) || []).reduce((sum, n) => sum + +n, 0) : 32;
    const texel = Math.max(1, Math.ceil((bits || 32) / 8));
    return align(Math.max(1, resource.width) * Math.max(1, resource.height) * Math.max(1, resource.depth) *
        Math.max(1, resource.array_size) * texel, ALIGNMENT);
}

/** the virtio-gpu resource an import names, when Venus can import it: a virgl resource with a GX surface */
function importable_resource(vk, id)
{
    const resource = vk.gpu && vk.gpu.resources ? vk.gpu.resources.get(id) : null;
    return resource && resource.three_d && resource.info ? resource : null;
}

/** an image from its create info */
function image_of(rid, info)
{
    return {
        type: "image", rid,
        format: info.format, image_type: info.imageType,
        width: info.extent.width, height: info.extent.height, depth: info.extent.depth,
        mips: info.mipLevels, layers: info.arrayLayers, samples: info.samples,
        texel_bytes: INFO.FORMATS[info.format] ? INFO.FORMATS[info.format][3] : 4,
        tiling: info.tiling, usage: info.usage, flags: info.flags,
        memory: null, offset: 0,
    };
}

/** @type {!Object<string, function(!Object, !Object, !Object): ?function(function())>} */
export const RESOURCE_HANDLERS = {
    // Memory

    "vkAllocateMemory": function(vk, ctx, a)
    {
        const info = a.pAllocateInfo;
        const type = info.memoryTypeIndex, size = info.allocationSize;
        for(let s = info.pNext; s; s = s.pNext)
        {
            // (a dma-buf: its virtio-gpu resource, whose GX surface the image
            // bound to it becomes; no GPU buffer of its own)
            if(s.sType !== STYPE_IMPORT_MEMORY_RESOURCE_INFO_MESA) continue;
            if(type !== INFO.MEMORY_DEVICE_LOCAL || !importable_resource(vk, s.resourceId)) { a.ret = VK_ERROR_INVALID_EXTERNAL_HANDLE; return null; }
            const memory = new Memory(vk.new_rid(), size, type);
            memory.resource_id = s.resourceId;
            ctx.objects.set(a.pMemory, memory);
            a.ret = VK_SUCCESS;
            return null;
        }
        if(type > INFO.MEMORY_HOST_CACHED || !size || size > 1 << 30) { a.ret = VK_ERROR_OUT_OF_DEVICE_MEMORY; return null; }
        const host = type !== INFO.MEMORY_DEVICE_LOCAL;
        const heap = host ? vk.host_visible_size : 1 << 30;
        if((host ? vk.host_allocated : vk.device_allocated) + size > heap) { a.ret = VK_ERROR_OUT_OF_DEVICE_MEMORY; return null; }
        if(host) vk.host_allocated += size; else vk.device_allocated += size;
        const memory = new Memory(vk.new_rid(), size, type);
        vk.vx.command(VX.MEMORY_CREATE, [memory.rid, lo(align(size, 4)), hi(align(size, 4))]);
        ctx.objects.set(a.pMemory, memory);
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkFreeMemory": function(vk, ctx, a)
    {
        const memory = ctx.objects.get(a.memory);
        if(!memory) return null;
        if(memory.resource_id)
        {
            ctx.objects.delete(a.memory);
            return null;
        }
        if(memory.host_visible) vk.host_allocated -= memory.size; else vk.device_allocated -= memory.size;
        vk.vx.command(VX.DESTROY, [memory.rid]);
        if(memory.blob) memory.blob.memory = null;
        ctx.objects.delete(a.memory);
        return null;
    },
    "vkGetDeviceMemoryCommitment": function(vk, ctx, a)
    {
        const memory = ctx.objects.get(a.memory);
        a.pCommittedMemoryInBytes = memory ? memory.size : 0;
        return null;
    },
    "vkGetMemoryResourcePropertiesMESA": function(vk, ctx, a)
    {
        const resource = importable_resource(vk, a.resourceId);
        if(!resource)
        {
            a.ret = VK_ERROR_INVALID_EXTERNAL_HANDLE;
            return null;
        }
        const props = a.pMemoryResourceProperties;
        props.memoryTypeBits = 1 << INFO.MEMORY_DEVICE_LOCAL;
        for(let s = props.pNext; s; s = s.pNext)
        {
            if(s.sType === STYPE_MEMORY_RESOURCE_ALLOCATION_SIZE_PROPERTIES_MESA) s.allocationSize = resource_size(resource);
        }
        a.ret = VK_SUCCESS;
        return null;
    },
    // (coherent memory: nothing to do)
    "vkFlushMappedMemoryRanges": function(vk, ctx, a) { a.ret = VK_SUCCESS; return null; },
    "vkInvalidateMappedMemoryRanges": function(vk, ctx, a) { a.ret = VK_SUCCESS; return null; },

    // Buffers

    "vkCreateBuffer": function(vk, ctx, a)
    {
        const info = a.pCreateInfo;
        ctx.objects.set(a.pBuffer, { type: "buffer", size: info.size, usage: info.usage, flags: info.flags, memory: null, offset: 0 });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyBuffer": function(vk, ctx, a)
    {
        ctx.objects.delete(a.buffer);
        return null;
    },
    "vkGetBufferMemoryRequirements": function(vk, ctx, a)
    {
        const buffer = ctx.objects.get(a.buffer);
        a.pMemoryRequirements = buffer_requirements(buffer ? buffer.size : 0);
        return null;
    },
    "vkGetBufferMemoryRequirements2": function(vk, ctx, a)
    {
        const buffer = ctx.objects.get(a.pInfo.buffer);
        requirements2(a.pMemoryRequirements, buffer_requirements(buffer ? buffer.size : 0));
        return null;
    },
    "vkGetDeviceBufferMemoryRequirements": function(vk, ctx, a)
    {
        requirements2(a.pMemoryRequirements, buffer_requirements(a.pInfo.pCreateInfo.size));
        return null;
    },
    "vkBindBufferMemory": function(vk, ctx, a)
    {
        const buffer = ctx.objects.get(a.buffer);
        if(buffer)
        {
            buffer.memory = ctx.objects.get(a.memory) || null;
            buffer.offset = a.memoryOffset;
        }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkBindBufferMemory2": function(vk, ctx, a)
    {
        for(const bind of a.pBindInfos || [])
        {
            const buffer = ctx.objects.get(bind.buffer);
            if(!buffer) continue;
            buffer.memory = ctx.objects.get(bind.memory) || null;
            buffer.offset = bind.memoryOffset;
        }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkCreateBufferView": function(vk, ctx, a)
    {
        const info = a.pCreateInfo;
        ctx.objects.set(a.pView, { type: "buffer_view", buffer: info.buffer, format: info.format, offset: info.offset, range: info.range });
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyBufferView": function(vk, ctx, a)
    {
        ctx.objects.delete(a.bufferView);
        return null;
    },

    // Images

    "vkCreateImage": function(vk, ctx, a)
    {
        const info = a.pCreateInfo;
        if(!INFO.image_format_properties(info.format, info.imageType, info.tiling, info.usage, info.flags))
        {
            a.ret = VK_ERROR_FORMAT_NOT_SUPPORTED;
            return null;
        }
        const image = image_of(vk.new_rid(), info);
        for(let s = info.pNext; s; s = s.pNext)
        {
            // (the layout the guest's buffer has, for vkGetImageSubresourceLayout)
            if(s.sType === INFO.STYPE.IMAGE_DRM_FORMAT_MODIFIER_EXPLICIT_CREATE_INFO && s.pPlaneLayouts) image.layout = s.pPlaneLayouts[0];
        }
        vk.vx.command(VX.TEXTURE_CREATE, [image.rid, image.format, image.image_type, image.width, image.height, image.depth,
            image.mips, image.layers, image.samples, image.usage, image.flags]);
        ctx.objects.set(a.pImage, image);
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyImage": function(vk, ctx, a)
    {
        const image = ctx.objects.get(a.image);
        if(image) vk.vx.command(VX.DESTROY, [image.rid]);
        ctx.objects.delete(a.image);
        return null;
    },
    "vkGetImageMemoryRequirements": function(vk, ctx, a)
    {
        const image = ctx.objects.get(a.image);
        a.pMemoryRequirements = image ? image_requirements(image) : {};
        return null;
    },
    "vkGetImageMemoryRequirements2": function(vk, ctx, a)
    {
        const image = ctx.objects.get(a.pInfo.image);
        requirements2(a.pMemoryRequirements, image ? image_requirements(image) : {});
        return null;
    },
    "vkGetDeviceImageMemoryRequirements": function(vk, ctx, a)
    {
        requirements2(a.pMemoryRequirements, image_requirements(image_of(0, a.pInfo.pCreateInfo)));
        return null;
    },
    "vkGetImageSparseMemoryRequirements": function(vk, ctx, a)
    {
        out_array(a, "pSparseMemoryRequirementCount", "pSparseMemoryRequirements", []);
        return null;
    },
    "vkGetImageSparseMemoryRequirements2": function(vk, ctx, a)
    {
        out_array(a, "pSparseMemoryRequirementCount", "pSparseMemoryRequirements", []);
        return null;
    },
    "vkGetDeviceImageSparseMemoryRequirements": function(vk, ctx, a)
    {
        out_array(a, "pSparseMemoryRequirementCount", "pSparseMemoryRequirements", []);
        return null;
    },
    "vkBindImageMemory": function(vk, ctx, a)
    {
        const image = ctx.objects.get(a.image);
        if(image) bind_image(vk, image, ctx.objects.get(a.memory) || null, a.memoryOffset);
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkBindImageMemory2": function(vk, ctx, a)
    {
        for(const bind of a.pBindInfos || [])
        {
            const image = ctx.objects.get(bind.image);
            if(image) bind_image(vk, image, ctx.objects.get(bind.memory) || null, bind.memoryOffset);
        }
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkGetImageSubresourceLayout": function(vk, ctx, a)
    {
        // (optimal tiling: no layout to speak of; an imported buffer's is the guest's)
        const image = ctx.objects.get(a.image);
        a.pLayout = image && image.layout ? image.layout : { offset: 0, size: 0, rowPitch: 0, arrayPitch: 0, depthPitch: 0 };
        return null;
    },
    "vkGetImageDrmFormatModifierPropertiesEXT": function(vk, ctx, a)
    {
        a.pProperties.drmFormatModifier = INFO.DRM_FORMAT_MOD_LINEAR;
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkCreateImageView": function(vk, ctx, a)
    {
        const info = a.pCreateInfo;
        const image = ctx.objects.get(info.image);
        if(!image) { a.ret = VK_ERROR_OUT_OF_DEVICE_MEMORY; return null; }
        const range = info.subresourceRange;
        const mips = range.levelCount === REMAINING ? image.mips - range.baseMipLevel : range.levelCount;
        const layers = range.layerCount === REMAINING ? image.layers - range.baseArrayLayer : range.layerCount;
        const view = { type: "image_view", rid: vk.new_rid(), image: info.image, image_rid: image.rid, view_type: info.viewType,
            format: info.format, aspect: range.aspectMask, base_mip: range.baseMipLevel, mips, base_layer: range.baseArrayLayer, layers,
            width: Math.max(1, image.width >> range.baseMipLevel), height: Math.max(1, image.height >> range.baseMipLevel),
            samples: image.samples };
        const c = info.components;
        vk.vx.command(VX.VIEW_CREATE, [view.rid, image.rid, info.viewType, info.format, range.aspectMask, range.baseMipLevel, mips,
            range.baseArrayLayer, layers, c.r, c.g, c.b, c.a]);
        ctx.objects.set(a.pView, view);
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroyImageView": function(vk, ctx, a)
    {
        const view = ctx.objects.get(a.imageView);
        if(view) vk.vx.command(VX.DESTROY, [view.rid]);
        ctx.objects.delete(a.imageView);
        return null;
    },
    "vkCreateSampler": function(vk, ctx, a)
    {
        const info = a.pCreateInfo;
        const sampler = { type: "sampler", rid: vk.new_rid() };
        const f32 = new Float32Array(4);
        f32[0] = info.mipLodBias;
        f32[1] = info.anisotropyEnable ? info.maxAnisotropy : 1;
        f32[2] = info.minLod;
        f32[3] = info.maxLod;
        const bits = new Uint32Array(f32.buffer);
        vk.vx.command(VX.SAMPLER_CREATE, [sampler.rid, info.magFilter, info.minFilter, info.mipmapMode, info.addressModeU,
            info.addressModeV, info.addressModeW, bits[0], bits[1], info.compareEnable, info.compareOp, bits[2], bits[3]]);
        ctx.objects.set(a.pSampler, sampler);
        a.ret = VK_SUCCESS;
        return null;
    },
    "vkDestroySampler": function(vk, ctx, a)
    {
        const sampler = ctx.objects.get(a.sampler);
        if(sampler) vk.vx.command(VX.DESTROY, [sampler.rid]);
        ctx.objects.delete(a.sampler);
        return null;
    },
};

/** The size of a buffer range (VK_WHOLE_SIZE: to its end) */
export function range_size(buffer, offset, size)
{
    return size >= WHOLE ? buffer.size - offset : size;
}

export { lo, hi, align };
