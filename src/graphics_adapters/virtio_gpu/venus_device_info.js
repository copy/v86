// What the Venus device says it is (venus_vk.js): Vulkan 1.1 on WebGPU's
// guaranteed limits and formats. Each capability is one the WebGPU
// executor backs; docs/gpu-deviations.md lists where Vulkan asks for more.

// VkResult
export const VK_SUCCESS = 0;
export const VK_NOT_READY = 1;
export const VK_TIMEOUT = 2;
export const VK_EVENT_SET = 3;
export const VK_EVENT_RESET = 4;
export const VK_INCOMPLETE = 5;
export const VK_ERROR_OUT_OF_HOST_MEMORY = -1;
export const VK_ERROR_OUT_OF_DEVICE_MEMORY = -2;
export const VK_ERROR_INITIALIZATION_FAILED = -3;
export const VK_ERROR_DEVICE_LOST = -4;
export const VK_ERROR_MEMORY_MAP_FAILED = -5;
export const VK_ERROR_LAYER_NOT_PRESENT = -6;
export const VK_ERROR_EXTENSION_NOT_PRESENT = -7;
export const VK_ERROR_FEATURE_NOT_PRESENT = -8;
export const VK_ERROR_FORMAT_NOT_SUPPORTED = -11;
export const VK_ERROR_INVALID_EXTERNAL_HANDLE = -1000072003;

/** VK_WHOLE_SIZE, VK_REMAINING_*: all ones (2**64 as a number) */
export const WHOLE = 2 ** 64;
export const REMAINING = 0xFFFFFFFF;

/**
 * Fill an output array the way Vulkan's two-call idiom wants: the count
 * when there is no array, else as many as fit, VK_INCOMPLETE when not all
 * @param {!Object} a the command's parameters
 * @param {string} count_name
 * @param {string} array_name
 * @param {!Array} items
 * @param {function(!Object, *)=} fill an output struct from an item
 */
export function out_array(a, count_name, array_name, items, fill)
{
    if(!a[array_name])
    {
        a[count_name] = items.length;
        a.ret = VK_SUCCESS;
        return;
    }
    const n = Math.min(a[count_name] || 0, items.length);
    const out = a[array_name];
    for(let i = 0; i < n; i++)
    {
        if(fill) fill(out[i] || (out[i] = {}), items[i]);
        else out[i] = items[i];
    }
    out.length = n;
    a[count_name] = n;
    a.ret = n < items.length ? VK_INCOMPLETE : VK_SUCCESS;
}

export const VK_API_VERSION = (1 << 22 | 1 << 12 | 0) >>> 0;
export const VK_DRIVER_VERSION = 1;
export const VENDOR_ID = 0x10005;        // VK_VENDOR_ID_MESA
export const DEVICE_ID = 0x5686;
export const DEVICE_NAME = "v86 WebGPU";
const PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU = 3;

// sTypes of the chain structs filled here
export const STYPE = {
    PHYSICAL_DEVICE_FEATURES_2: 1000059000,
    PHYSICAL_DEVICE_PROPERTIES_2: 1000059001,
    VULKAN_1_1_FEATURES: 49,
    VULKAN_1_1_PROPERTIES: 50,
    VULKAN_1_2_FEATURES: 51,
    VULKAN_1_2_PROPERTIES: 52,
    ID_PROPERTIES: 1000071004,
    SUBGROUP_PROPERTIES: 1000094000,
    POINT_CLIPPING_PROPERTIES: 1000117000,
    MULTIVIEW_PROPERTIES: 1000053002,
    PROTECTED_MEMORY_PROPERTIES: 1000145002,
    MAINTENANCE_3_PROPERTIES: 1000168000,
    DRIVER_PROPERTIES: 1000196000,
    TIMELINE_SEMAPHORE_FEATURES: 1000207000,
    TIMELINE_SEMAPHORE_PROPERTIES: 1000207001,
    QUEUE_FAMILY_PROPERTIES_2: 1000059005,
    MEMORY_PROPERTIES_2: 1000059006,
    FORMAT_PROPERTIES_2: 1000059002,
    IMAGE_FORMAT_PROPERTIES_2: 1000059003,
    EXTERNAL_IMAGE_FORMAT_PROPERTIES: 1000071001,
    PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO: 1000071000,
    DRM_FORMAT_MODIFIER_PROPERTIES_LIST: 1000158000,
    DRM_FORMAT_MODIFIER_PROPERTIES_LIST_2: 1000158006,
    PHYSICAL_DEVICE_IMAGE_DRM_FORMAT_MODIFIER_INFO: 1000158002,
    IMAGE_DRM_FORMAT_MODIFIER_EXPLICIT_CREATE_INFO: 1000158004,
    SAMPLER_YCBCR_CONVERSION_IMAGE_FORMAT_PROPERTIES: 1000156005,
    SEMAPHORE_TYPE_CREATE_INFO: 1000207002,
    DYNAMIC_RENDERING_FEATURES: 1000044003,
    DEPTH_STENCIL_RESOLVE_PROPERTIES: 1000199000,
    TRANSFORM_FEEDBACK_FEATURES: 1000028000,
    TRANSFORM_FEEDBACK_PROPERTIES: 1000028001,
    PROVOKING_VERTEX_FEATURES: 1000254000,
    PIPELINE_RASTERIZATION_PROVOKING_VERTEX_STATE_CREATE_INFO: 1000254001,
    PROVOKING_VERTEX_PROPERTIES: 1000254002,
};
/** VK_QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM_EXT: two values a query, primitives written and needed */
export const QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM = 1000028004;

const KB = 1024, MB = 1024 * 1024;

/** VkPhysicalDeviceLimits: WebGPU's default limits, Vulkan's minimums where it asks for more */
const LIMITS = {
    maxImageDimension1D: 8192,
    maxImageDimension2D: 8192,
    maxImageDimension3D: 2048,
    maxImageDimensionCube: 8192,
    maxImageArrayLayers: 256,
    maxTexelBufferElements: 65536,
    maxUniformBufferRange: 65536,
    maxStorageBufferRange: 128 * MB,
    maxPushConstantsSize: 128,
    maxMemoryAllocationCount: 4096,
    maxSamplerAllocationCount: 4000,
    bufferImageGranularity: 1,
    sparseAddressSpaceSize: 0,
    maxBoundDescriptorSets: 4,
    maxPerStageDescriptorSamplers: 16,
    // (WebGPU has 12 a stage; VX makes the rest read-only storage buffers,
    // which leaves 8 + 2 of WebGPU's 10: GL ES 3.0 needs 12 besides ANGLE's own)
    maxPerStageDescriptorUniformBuffers: 14,
    maxPerStageDescriptorStorageBuffers: 8,
    maxPerStageDescriptorSampledImages: 16,
    maxPerStageDescriptorStorageImages: 4,
    maxPerStageDescriptorInputAttachments: 4,
    maxPerStageResources: 128,
    maxDescriptorSetSamplers: 96,
    maxDescriptorSetUniformBuffers: 72,
    maxDescriptorSetUniformBuffersDynamic: 8,
    maxDescriptorSetStorageBuffers: 24,
    maxDescriptorSetStorageBuffersDynamic: 4,
    maxDescriptorSetSampledImages: 96,
    maxDescriptorSetStorageImages: 24,
    maxDescriptorSetInputAttachments: 4,
    maxVertexInputAttributes: 16,
    maxVertexInputBindings: 16,
    maxVertexInputAttributeOffset: 2047,
    maxVertexInputBindingStride: 2048,
    // (17 of WebGPU's inter-stage variables, one past its default: ANGLE keeps
    // 4 components for capturing gl_Position, GL ES 3.0 needs 64 besides)
    maxVertexOutputComponents: 68,
    maxTessellationGenerationLevel: 0,
    maxTessellationPatchSize: 0,
    maxTessellationControlPerVertexInputComponents: 0,
    maxTessellationControlPerVertexOutputComponents: 0,
    maxTessellationControlPerPatchOutputComponents: 0,
    maxTessellationControlTotalOutputComponents: 0,
    maxTessellationEvaluationInputComponents: 0,
    maxTessellationEvaluationOutputComponents: 0,
    maxGeometryShaderInvocations: 0,
    maxGeometryInputComponents: 0,
    maxGeometryOutputComponents: 0,
    maxGeometryOutputVertices: 0,
    maxGeometryTotalOutputComponents: 0,
    maxFragmentInputComponents: 68,
    maxFragmentOutputAttachments: 8,
    maxFragmentDualSrcAttachments: 0,
    maxFragmentCombinedOutputResources: 16,
    maxComputeSharedMemorySize: 16 * KB,
    maxComputeWorkGroupCount: [65535, 65535, 65535],
    maxComputeWorkGroupInvocations: 256,
    maxComputeWorkGroupSize: [256, 256, 64],
    subPixelPrecisionBits: 8,
    subTexelPrecisionBits: 8,
    mipmapPrecisionBits: 8,
    maxDrawIndexedIndexValue: 0xFFFFFFFF,
    maxDrawIndirectCount: 1 << 30,
    maxSamplerLodBias: 2,
    maxSamplerAnisotropy: 16,
    maxViewports: 1,
    maxViewportDimensions: [8192, 8192],
    viewportBoundsRange: [-16384, 16383],
    viewportSubPixelBits: 0,
    minMemoryMapAlignment: 64,
    minTexelBufferOffsetAlignment: 256,
    minUniformBufferOffsetAlignment: 256,
    minStorageBufferOffsetAlignment: 256,
    minTexelOffset: -8,
    maxTexelOffset: 7,
    minTexelGatherOffset: -8,
    maxTexelGatherOffset: 7,
    minInterpolationOffset: -0.5,
    maxInterpolationOffset: 0.4375,
    subPixelInterpolationOffsetBits: 4,
    maxFramebufferWidth: 8192,
    maxFramebufferHeight: 8192,
    maxFramebufferLayers: 256,
    // (1 and 4 samples: WebGPU's)
    framebufferColorSampleCounts: 5,
    framebufferDepthSampleCounts: 5,
    framebufferStencilSampleCounts: 5,
    framebufferNoAttachmentsSampleCounts: 5,
    maxColorAttachments: 8,
    sampledImageColorSampleCounts: 5,
    sampledImageIntegerSampleCounts: 1,
    sampledImageDepthSampleCounts: 5,
    sampledImageStencilSampleCounts: 5,
    storageImageSampleCounts: 1,
    maxSampleMaskWords: 1,
    timestampComputeAndGraphics: 0,
    timestampPeriod: 1,
    maxClipDistances: 0,
    maxCullDistances: 0,
    maxCombinedClipAndCullDistances: 0,
    discreteQueuePriorities: 2,
    pointSizeRange: [1, 1],
    lineWidthRange: [1, 1],
    pointSizeGranularity: 0,
    lineWidthGranularity: 0,
    strictLines: 0,
    // (1 and 4 samples: WebGPU's four are Vulkan's standard positions)
    standardSampleLocations: 1,
    optimalBufferCopyOffsetAlignment: 4,
    optimalBufferCopyRowPitchAlignment: 256,
    nonCoherentAtomSize: 64,
};

/** @return {!Object} VkPhysicalDeviceProperties */
export function properties()
{
    return {
        apiVersion: VK_API_VERSION,
        driverVersion: VK_DRIVER_VERSION,
        vendorID: VENDOR_ID,
        deviceID: DEVICE_ID,
        deviceType: PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU,
        deviceName: DEVICE_NAME,
        pipelineCacheUUID: PIPELINE_CACHE_UUID,
        limits: LIMITS,
        sparseProperties: {},
    };
}

const PIPELINE_CACHE_UUID = [0x76, 0x38, 0x36, 0x2d, 0x76, 0x65, 0x6e, 0x75, 0x73, 0x2d, 0x77, 0x67, 0x70, 0x75, 0x00, 0x01];
const DEVICE_UUID = [0x76, 0x38, 0x36, 0x2d, 0x77, 0x65, 0x62, 0x67, 0x70, 0x75, 0x2d, 0x64, 0x65, 0x76, 0x00, 0x01];
const DRIVER_UUID = [0x76, 0x38, 0x36, 0x2d, 0x77, 0x65, 0x62, 0x67, 0x70, 0x75, 0x2d, 0x64, 0x72, 0x76, 0x00, 0x01];

/** VkPhysicalDeviceFeatures: what the executor does */
const FEATURES = {
    robustBufferAccess: 1,
    fullDrawIndexUint32: 1,
    imageCubeArray: 1,
    independentBlend: 1,
    multiDrawIndirect: 1,
    depthBiasClamp: 1,
    samplerAnisotropy: 1,
    fragmentStoresAndAtomics: 1,
    // (not occlusionQueryPrecise: WebGPU promises only zero or not, and
    // Chrome's Metal backend answers 1)
};

// VK_SUBGROUP_FEATURE_BASIC_BIT, VK_SHADER_STAGE_COMPUTE_BIT
const SUBGROUP = { subgroupSize: 1, subgroupSupportedStages: 0x20, subgroupSupportedOperations: 1, subgroupQuadOperationsInAllStages: 0 };

const VULKAN_1_1_PROPERTIES = {
    deviceUUID: DEVICE_UUID, driverUUID: DRIVER_UUID, deviceLUID: [0, 0, 0, 0, 0, 0, 0, 0], deviceNodeMask: 0, deviceLUIDValid: 0,
    ...SUBGROUP,
    pointClippingBehavior: 0,
    maxMultiviewViewCount: 6, maxMultiviewInstanceIndex: (1 << 27) - 1,
    protectedNoFault: 0,
    maxPerSetDescriptors: 1024, maxMemoryAllocationSize: 1024 * MB,
};

/** Properties of chain structs, by sType */
const CHAIN_PROPERTIES = {
    // (VK_RESOLVE_MODE_SAMPLE_ZERO_BIT, as required: WebGPU resolves no depth, see the deviations)
    [STYPE.DEPTH_STENCIL_RESOLVE_PROPERTIES]: { supportedDepthResolveModes: 1, supportedStencilResolveModes: 1, independentResolveNone: 0, independentResolve: 0 },
    [STYPE.VULKAN_1_1_PROPERTIES]: VULKAN_1_1_PROPERTIES,
    [STYPE.ID_PROPERTIES]: { deviceUUID: DEVICE_UUID, driverUUID: DRIVER_UUID, deviceLUID: [0, 0, 0, 0, 0, 0, 0, 0], deviceNodeMask: 0, deviceLUIDValid: 0 },
    [STYPE.SUBGROUP_PROPERTIES]: { subgroupSize: SUBGROUP.subgroupSize, supportedStages: SUBGROUP.subgroupSupportedStages,
        supportedOperations: SUBGROUP.subgroupSupportedOperations, quadOperationsInAllStages: 0 },
    [STYPE.POINT_CLIPPING_PROPERTIES]: { pointClippingBehavior: 0 },
    [STYPE.MULTIVIEW_PROPERTIES]: { maxMultiviewViewCount: 6, maxMultiviewInstanceIndex: (1 << 27) - 1 },
    [STYPE.PROTECTED_MEMORY_PROPERTIES]: { protectedNoFault: 0 },
    [STYPE.MAINTENANCE_3_PROPERTIES]: { maxPerSetDescriptors: 1024, maxMemoryAllocationSize: 1024 * MB },
    // VK_DRIVER_ID_MESA_VENUS is the guest's; this is the renderer's
    [STYPE.TIMELINE_SEMAPHORE_PROPERTIES]: { maxTimelineSemaphoreValueDifference: 0xFFFFFFFF },
    [STYPE.DRIVER_PROPERTIES]: { driverID: 0, driverName: "v86 WebGPU", driverInfo: "WebGPU through the v86 renderer",
        conformanceVersion: { major: 0, minor: 0, subminor: 0, patch: 0 } },
    // (VX captures in a compute pass: one stream, 4 buffers, GL ES's interleaved 64 components and more)
    [STYPE.TRANSFORM_FEEDBACK_PROPERTIES]: { maxTransformFeedbackStreams: 1, maxTransformFeedbackBuffers: 4,
        maxTransformFeedbackBufferSize: 1024 * MB, maxTransformFeedbackStreamDataSize: 512, maxTransformFeedbackBufferDataSize: 512,
        maxTransformFeedbackBufferDataStride: 512, transformFeedbackQueries: 1, transformFeedbackStreamsLinesTriangles: 0,
        transformFeedbackRasterizationStreamSelect: 0, transformFeedbackDraw: 0 },
    // (VX draws a pipeline of the last vertex with flat varyings reordered, the last first)
    [STYPE.PROVOKING_VERTEX_PROPERTIES]: { provokingVertexModePerPipeline: 1, transformFeedbackPreservesTriangleFanProvokingVertex: 0 },
};

/** Features of chain structs, by sType (absent: all false) */
const CHAIN_FEATURES = {
    [STYPE.TIMELINE_SEMAPHORE_FEATURES]: { timelineSemaphore: 1 },
    [STYPE.DYNAMIC_RENDERING_FEATURES]: { dynamicRendering: 1 },
    [STYPE.TRANSFORM_FEEDBACK_FEATURES]: { transformFeedback: 1, geometryStreams: 0 },
    [STYPE.PROVOKING_VERTEX_FEATURES]: { provokingVertexLast: 1, transformFeedbackPreservesProvokingVertex: 0 },
};

/**
 * Fill what a request's chain asks for
 * @param {Object} chain
 * @param {!Object} table by sType
 */
function fill_chain(chain, table)
{
    for(let s = chain; s; s = s.pNext)
    {
        const values = table[s.sType];
        if(values) Object.assign(s, values);
    }
}

/** @param {!Object} out VkPhysicalDeviceFeatures2 (its chain) */
export function features2(out)
{
    out.features = FEATURES;
    fill_chain(out.pNext, CHAIN_FEATURES);
}

/** @param {!Object} out VkPhysicalDeviceProperties2 (its chain) */
export function properties2(out)
{
    out.properties = properties();
    fill_chain(out.pNext, CHAIN_PROPERTIES);
}

export function features()
{
    return FEATURES;
}

// ---------------------------------------------------------------------------
// Queues and memory

// VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT | VK_QUEUE_TRANSFER_BIT
export const QUEUE_FAMILIES = [
    // (timestamps: the time the device makes the batch, in ns)
    { queueFlags: 7, queueCount: 1, timestampValidBits: 64, minImageTransferGranularity: { width: 1, height: 1, depth: 1 } },
];

const DEVICE_LOCAL = 1, HOST_VISIBLE = 2, HOST_COHERENT = 4, HOST_CACHED = 8;
export const MEMORY_DEVICE_LOCAL = 0, MEMORY_HOST = 1, MEMORY_HOST_CACHED = 2;

/**
 * Device memory is GPU buffers; host visible memory is also mapped into
 * the guest from the host visible memory region (BAR4) while it is mapped
 * @param {number} host_visible_size bytes of the host visible region for memory
 */
export function memory_properties(host_visible_size)
{
    return {
        memoryTypeCount: 3,
        memoryTypes: [
            { propertyFlags: DEVICE_LOCAL, heapIndex: 0 },
            { propertyFlags: HOST_VISIBLE | HOST_COHERENT, heapIndex: 1 },
            { propertyFlags: HOST_VISIBLE | HOST_COHERENT | HOST_CACHED, heapIndex: 1 },
        ],
        memoryHeapCount: 2,
        memoryHeaps: [
            // VK_MEMORY_HEAP_DEVICE_LOCAL_BIT
            { size: 1024 * MB, flags: 1 },
            { size: host_visible_size, flags: 0 },
        ],
    };
}

// ---------------------------------------------------------------------------
// Formats

// VkFormatFeatureFlagBits
const F = {
    SAMPLED: 0x1, STORAGE: 0x2, UNIFORM_TEXEL: 0x8, STORAGE_TEXEL: 0x10, VERTEX: 0x40, COLOR: 0x80, BLEND: 0x100,
    DEPTH: 0x200, BLIT_SRC: 0x400, BLIT_DST: 0x800, LINEAR: 0x1000, TRANSFER_SRC: 0x4000, TRANSFER_DST: 0x8000,
};

/**
 * VkFormat: [WebGPU texture format or null, capabilities, WebGPU vertex
 * format or null, texel block bytes]. Capabilities: f filterable float,
 * x unfilterable float, i integer, r renderable, b blendable, m 4x
 * multisampled, s storage, d depth/stencil, c copies through buffers, p
 * 16-bit packed texels stored as the texture format's (VX converts them in
 * copies through buffers)
 */
export const FORMATS = {
    // (Vulkan's required color attachment formats, and GL ES 3.0's RGB565
    // and RGB5_A1, which ANGLE gives no other format)
    4: ["rgba8unorm", "frbmcp", null, 2],              // R5G6B5_UNORM_PACK16
    6: ["rgba8unorm", "frbmcp", null, 2],              // R5G5B5A1_UNORM_PACK16
    8: ["rgba8unorm", "frbmcp", null, 2],              // A1R5G5B5_UNORM_PACK16
    9: ["r8unorm", "frbmc", "unorm8", 1],              // R8_UNORM
    10: ["r8snorm", "fc", "snorm8", 1],                // R8_SNORM
    13: ["r8uint", "irmc", "uint8", 1],                // R8_UINT
    14: ["r8sint", "irmc", "sint8", 1],                // R8_SINT
    16: ["rg8unorm", "frbmc", "unorm8x2", 2],          // R8G8_UNORM
    17: ["rg8snorm", "fc", "snorm8x2", 2],             // R8G8_SNORM
    20: ["rg8uint", "irmc", "uint8x2", 2],             // R8G8_UINT
    21: ["rg8sint", "irmc", "sint8x2", 2],             // R8G8_SINT
    37: ["rgba8unorm", "frbmsc", "unorm8x4", 4],       // R8G8B8A8_UNORM
    38: ["rgba8snorm", "fsc", "snorm8x4", 4],          // R8G8B8A8_SNORM
    41: ["rgba8uint", "irmsc", "uint8x4", 4],          // R8G8B8A8_UINT
    42: ["rgba8sint", "irmsc", "sint8x4", 4],          // R8G8B8A8_SINT
    43: ["rgba8unorm-srgb", "frbmc", null, 4],         // R8G8B8A8_SRGB
    44: ["bgra8unorm", "frbmc", "unorm8x4-bgra", 4],   // B8G8R8A8_UNORM
    50: ["bgra8unorm-srgb", "frbmc", null, 4],         // B8G8R8A8_SRGB
    51: ["rgba8unorm", "frbmsc", "unorm8x4", 4],       // A8B8G8R8_UNORM_PACK32
    52: ["rgba8snorm", "fsc", "snorm8x4", 4],          // A8B8G8R8_SNORM_PACK32
    55: ["rgba8uint", "irmsc", "uint8x4", 4],          // A8B8G8R8_UINT_PACK32
    56: ["rgba8sint", "irmsc", "sint8x4", 4],          // A8B8G8R8_SINT_PACK32
    57: ["rgba8unorm-srgb", "frbmc", null, 4],         // A8B8G8R8_SRGB_PACK32
    64: ["rgb10a2unorm", "frbmc", "unorm10-10-10-2", 4], // A2B10G10R10_UNORM_PACK32
    68: ["rgb10a2uint", "irmc", null, 4],              // A2B10G10R10_UINT_PACK32
    70: [null, "", "unorm16", 2],                      // R16_UNORM
    71: [null, "", "snorm16", 2],                      // R16_SNORM
    74: ["r16uint", "irmc", "uint16", 2],              // R16_UINT
    75: ["r16sint", "irmc", "sint16", 2],              // R16_SINT
    76: ["r16float", "frbmc", "float16", 2],           // R16_SFLOAT
    77: [null, "", "unorm16x2", 4],                    // R16G16_UNORM
    78: [null, "", "snorm16x2", 4],                    // R16G16_SNORM
    81: ["rg16uint", "irmc", "uint16x2", 4],           // R16G16_UINT
    82: ["rg16sint", "irmc", "sint16x2", 4],           // R16G16_SINT
    83: ["rg16float", "frbmc", "float16x2", 4],        // R16G16_SFLOAT
    91: [null, "", "unorm16x4", 8],                    // R16G16B16A16_UNORM
    92: [null, "", "snorm16x4", 8],                    // R16G16B16A16_SNORM
    95: ["rgba16uint", "irmsc", "uint16x4", 8],        // R16G16B16A16_UINT
    96: ["rgba16sint", "irmsc", "sint16x4", 8],        // R16G16B16A16_SINT
    97: ["rgba16float", "frbmsc", "float16x4", 8],     // R16G16B16A16_SFLOAT
    98: ["r32uint", "irmsc", "uint32", 4],             // R32_UINT
    99: ["r32sint", "irmsc", "sint32", 4],             // R32_SINT
    100: ["r32float", "xrmsc", "float32", 4],          // R32_SFLOAT
    101: ["rg32uint", "irsc", "uint32x2", 8],          // R32G32_UINT
    102: ["rg32sint", "irsc", "sint32x2", 8],          // R32G32_SINT
    103: ["rg32float", "xrsc", "float32x2", 8],        // R32G32_SFLOAT
    104: [null, "", "uint32x3", 12],                   // R32G32B32_UINT
    105: [null, "", "sint32x3", 12],                   // R32G32B32_SINT
    106: [null, "", "float32x3", 12],                  // R32G32B32_SFLOAT
    107: ["rgba32uint", "irsc", "uint32x4", 16],       // R32G32B32A32_UINT
    108: ["rgba32sint", "irsc", "sint32x4", 16],       // R32G32B32A32_SINT
    109: ["rgba32float", "xrsc", "float32x4", 16],     // R32G32B32A32_SFLOAT
    122: ["rg11b10ufloat", "fc", null, 4],             // B10G11R11_UFLOAT_PACK32
    123: ["rgb9e5ufloat", "fc", null, 4],              // E5B9G9R9_UFLOAT_PACK32
    124: ["depth16unorm", "dmc", null, 2],             // D16_UNORM
    // (24-bit depth: WebGPU copies none to or from a buffer; VX does it by a
    // draw and a dispatch, as depth into depth32float)
    125: ["depth24plus", "dmc", null, 4],              // X8_D24_UNORM_PACK32
    126: ["depth32float", "dmc", null, 4],             // D32_SFLOAT
    127: ["stencil8", "dmc", null, 1],                 // S8_UINT
    129: ["depth24plus-stencil8", "dmc", null, 4],     // D24_UNORM_S8_UINT
    // (GL ES 3.0's DEPTH32F_STENCIL8: WebGPU's optional depth32float-stencil8,
    // which VX makes depth24plus-stencil8 on a device without it)
    130: ["depth32float-stencil8", "dmc", null, 8],    // D32_SFLOAT_S8_UINT
};

/**
 * VkFormatProperties of a format
 * @param {number} format
 * @return {{linearTilingFeatures: number, optimalTilingFeatures: number, bufferFeatures: number}}
 */
export function format_properties(format)
{
    const entry = FORMATS[format];
    if(!entry) return { linearTilingFeatures: 0, optimalTilingFeatures: 0, bufferFeatures: 0 };
    const [texture, caps, vertex] = entry;
    let optimal = 0;
    if(texture)
    {
        optimal |= F.SAMPLED | F.BLIT_SRC;
        if(caps.includes("f")) optimal |= F.LINEAR;
        if(caps.includes("r")) optimal |= F.COLOR | F.BLIT_DST;
        if(caps.includes("b")) optimal |= F.BLEND;
        if(caps.includes("s")) optimal |= F.STORAGE;
        if(caps.includes("d")) optimal = F.SAMPLED | F.DEPTH | F.BLIT_SRC;
        if(caps.includes("c")) optimal |= F.TRANSFER_SRC | F.TRANSFER_DST;
    }
    return { linearTilingFeatures: 0, optimalTilingFeatures: optimal, bufferFeatures: vertex ? F.VERTEX : 0 };
}

// VkImageUsageFlagBits -> the format features they need
const USAGE_FEATURES = [
    [0x1, F.TRANSFER_SRC],      // TRANSFER_SRC
    [0x2, F.TRANSFER_DST],      // TRANSFER_DST
    [0x4, F.SAMPLED],           // SAMPLED
    [0x8, F.STORAGE],           // STORAGE
    [0x10, F.COLOR],            // COLOR_ATTACHMENT
    [0x20, F.DEPTH],            // DEPTH_STENCIL_ATTACHMENT
    [0x80, F.COLOR | F.DEPTH],  // INPUT_ATTACHMENT: one of them
];

/**
 * VkImageFormatProperties, or null when the combination is not supported
 * @param {number} format
 * @param {number} type VkImageType
 * @param {number} tiling VkImageTiling
 * @param {number} usage
 * @param {number} flags VkImageCreateFlags
 */
export function image_format_properties(format, type, tiling, usage, flags)
{
    const entry = FORMATS[format];
    // (optimal tiling, and the linear modifier's: an image is a texture either way)
    if(!entry || !entry[0] || tiling !== 0 && tiling !== TILING_DRM_FORMAT_MODIFIER) return null;
    const features = format_properties(format).optimalTilingFeatures;
    for(const [bit, need] of USAGE_FEATURES)
    {
        if(usage & bit && !(features & need)) return null;
    }
    // VK_IMAGE_USAGE_TRANSIENT_ATTACHMENT_BIT and the others need nothing more
    const depth = entry[1].includes("d");
    if(type === 2 && depth) return null;
    // mutable format, cube and 2D array compatible, block texel view
    // compatible, extended usage, alias (swapchain images have it: their
    // memory is theirs alone here); sparse, protected and the like are not
    // offered
    if(flags & ~(0x8 | 0x10 | 0x20 | 0x80 | 0x100 | 0x400)) return null;
    const max = type === 0 ? [8192, 1, 1] : type === 1 ? [8192, 8192, 1] : [2048, 2048, 2048];
    const levels = Math.floor(Math.log2(Math.max(...max))) + 1;
    const multisample = type === 1 && entry[1].includes("m") && !(flags & 0x10) && !(usage & 0x8);
    return {
        maxExtent: { width: max[0], height: max[1], depth: max[2] },
        maxMipLevels: levels,
        maxArrayLayers: type === 2 ? 1 : 256,
        sampleCounts: multisample ? 5 : 1,
        maxResourceSize: 2 * 1024 * MB,
    };
}

/** Device extensions, name: spec version (each one the executor backs) */
export const DEVICE_EXTENSIONS = {
    "VK_KHR_driver_properties": 1,
    // (the device keeps the values; one queue runs in order)
    "VK_KHR_timeline_semaphore": 2,
    // sync files: the driver makes them itself (a SUBMIT_3D on the queue's
    // timeline) and tells the device what they mean for the semaphore or
    // fence (vkImportSemaphoreResourceMESA and friends); Venus offers
    // VK_KHR_swapchain only when semaphores import them
    "VK_KHR_external_semaphore_fd": 1,
    "VK_KHR_external_fence_fd": 1,
    // render passes without render pass objects (and what it needs)
    "VK_KHR_create_renderpass2": 1,
    "VK_KHR_depth_stencil_resolve": 1,
    "VK_KHR_dynamic_rendering": 1,
    // gralloc's buffers on Android (P11.4 of docs/arm64-virt-android16-plan.md):
    // the driver imports a dma-buf as its virtio-gpu resource
    // (VkImportMemoryResourceInfoMESA), whose GX surface the image then is;
    // one modifier, linear (images are textures here, with no layout of
    // their own); the foreign queue family is the CPU and the display.
    // Not VK_EXT_external_memory_dma_buf (nor VK_KHR_external_memory_fd):
    // nothing here becomes a dma-buf, and Mesa's venus on Linux takes it for
    // dma-buf swapchain images (its software WSI only without it); the
    // Android driver (tools/a64_venus/venus-android.patch) imports without it
    "VK_KHR_image_format_list": 1,
    "VK_EXT_image_drm_format_modifier": 2,
    "VK_EXT_queue_family_foreign": 1,
    // (captured in a compute pass, VX: what GL ES 3.0 needs, so that ANGLE gives it)
    "VK_EXT_transform_feedback": 1,
    // (GL's last vertex for flat shading, which ANGLE takes from it: VX reorders
    // the vertices of draws with flat varyings, G-51 of docs/gpu-deviations.md)
    "VK_EXT_provoking_vertex": 1,
};

// VkExternalMemoryHandleTypeFlagBits, VkExternalMemoryFeatureFlagBits
export const MEMORY_HANDLE_DMA_BUF = 0x200;
export const MEMORY_DEDICATED_ONLY = 1, MEMORY_IMPORTABLE = 4;
/** VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT, and the one modifier offered */
export const TILING_DRM_FORMAT_MODIFIER = 1000158000;
export const DRM_FORMAT_MOD_LINEAR = 0;

// VkExternalSemaphoreHandleTypeFlagBits, VkExternalFenceHandleTypeFlagBits
export const SEMAPHORE_SYNC_FD = 0x10;
export const FENCE_SYNC_FD = 0x8;
