/* gfxstream's guest marshaling (mesa src/gfxstream/guest/vulkan_enc, the
 * build pinned in docs/gfxstream-protocol.md) as an oracle for
 * gfxstream_protocol.js (tools/gfxstream_protocol_gen.mjs;
 * tests/devices/gfxstream_protocol.js keeps what it printed):
 *   oracle requests        -> one line per struct the guest's request writer
 *                             (reservedmarshal_*) wrote: name hex
 *   oracle replies < file  -> reads "name hex" lines with the guest's reply
 *                             readers (unmarshal_*), prints what it read
 *                             written again (marshal_*): name hex
 *
 * build: tools/gfxstream_oracle/build.sh <mesa checkout or the scratch copy>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>

#include "goldfish_vk_marshaling_guest.h"
#include "goldfish_vk_reserved_marshaling_guest.h"

using namespace gfxstream::vk;

#define GET_HOST_U64(type) \
    uint64_t get_host_u64_##type(type x) { return (uint64_t)(uintptr_t)x; }
GOLDFISH_VK_LIST_HANDLE_TYPES(GET_HOST_U64)

#define H(type, x) ((type)(uintptr_t)(x))
#define MAX VK_STRUCTURE_TYPE_MAX_ENUM

static uint8_t buf[1 << 16];

static void dump(const char* name, const uint8_t* p, size_t n)
{
    printf("%s ", name);
    for (size_t i = 0; i < n; i++) printf("%02x", p[i]);
    printf("\n");
}

#define REQUEST(Type, value)                                                    \
    {                                                                           \
        VulkanStreamGuest stream;                                               \
        uint8_t* ptr = buf;                                                     \
        reservedmarshal_##Type(&stream, MAX, &(value), &ptr);                   \
        dump(#Type, buf, ptr - buf);                                            \
    }

static void requests(void)
{
    {
        const char* exts[] = {"VK_KHR_surface", "VK_EXT_debug_utils"};
        VkApplicationInfo app = {VK_STRUCTURE_TYPE_APPLICATION_INFO, NULL, "vktest", 7, NULL, 0, VK_API_VERSION_1_3};
        VkInstanceCreateInfo info = {VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, NULL, 0, &app, 0, NULL, 2, exts};
        REQUEST(VkInstanceCreateInfo, info);
    }
    {
        VkPhysicalDeviceVulkan11Features v11 = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES};
        v11.shaderDrawParameters = VK_TRUE;
        VkPhysicalDeviceFeatures2 features = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, &v11};
        features.features.samplerAnisotropy = VK_TRUE;
        float priority = 1.0f;
        VkDeviceQueueCreateInfo queue = {VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, NULL, 0, 0, 1, &priority};
        const char* exts[] = {"VK_KHR_swapchain"};
        VkDeviceCreateInfo info = {VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, &features, 0, 1, &queue, 0, NULL, 1, exts, NULL};
        REQUEST(VkDeviceCreateInfo, info);
    }
    {
        uint32_t handle = 77;
        VkNativeBufferANDROID native = {VK_STRUCTURE_TYPE_NATIVE_BUFFER_ANDROID, NULL, &handle, 640, 1, 0x300, {5, 6}};
        uint32_t families[] = {0, 1};
        VkImageCreateInfo info = {VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, &native, 0, VK_IMAGE_TYPE_2D, VK_FORMAT_R8G8B8A8_UNORM,
                                  {640, 480, 1}, 1, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_TILING_OPTIMAL, 0x17,
                                  VK_SHARING_MODE_CONCURRENT, 2, families, VK_IMAGE_LAYOUT_UNDEFINED};
        REQUEST(VkImageCreateInfo, info);
    }
    {
        VkMemoryDedicatedAllocateInfo dedicated = {VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO, NULL, H(VkImage, 0x55), VK_NULL_HANDLE};
        VkImportColorBufferGOOGLE color = {VK_STRUCTURE_TYPE_IMPORT_COLOR_BUFFER_GOOGLE, &dedicated, 42};
        VkMemoryAllocateInfo info = {VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, &color, 1 << 20, 3};
        REQUEST(VkMemoryAllocateInfo, info);
    }
    {
        uint32_t spec_data = 0x01020304;
        VkSpecializationMapEntry entry = {3, 0, 4};
        VkSpecializationInfo spec = {1, &entry, 4, &spec_data};
        VkPipelineShaderStageCreateInfo stages[2] = {
            {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, NULL, 0, VK_SHADER_STAGE_VERTEX_BIT, H(VkShaderModule, 0x51), "main", NULL},
            {VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, NULL, 0, VK_SHADER_STAGE_FRAGMENT_BIT, H(VkShaderModule, 0x52), "main", &spec},
        };
        VkVertexInputBindingDescription binding = {0, 20, VK_VERTEX_INPUT_RATE_VERTEX};
        VkVertexInputAttributeDescription attributes[2] = {{0, 0, VK_FORMAT_R32G32_SFLOAT, 0}, {1, 0, VK_FORMAT_R32G32B32_SFLOAT, 8}};
        VkPipelineVertexInputStateCreateInfo vertex = {VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO, NULL, 0, 1, &binding, 2, attributes};
        VkPipelineInputAssemblyStateCreateInfo assembly = {VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO, NULL, 0, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP, VK_FALSE};
        VkViewport viewport = {0, 0, 640, 480, 0, 1};
        VkRect2D scissor = {{0, 0}, {640, 480}};
        VkPipelineViewportStateCreateInfo viewports = {VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, NULL, 0, 1, &viewport, 1, &scissor};
        VkPipelineRasterizationStateCreateInfo raster = {VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO, NULL, 0, VK_FALSE, VK_FALSE,
                                                         VK_POLYGON_MODE_FILL, VK_CULL_MODE_BACK_BIT, VK_FRONT_FACE_COUNTER_CLOCKWISE, VK_FALSE, 0, 0, 0, 1.0f};
        VkSampleMask mask = 0xFFFFFFFF;
        VkPipelineMultisampleStateCreateInfo multisample = {VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO, NULL, 0, VK_SAMPLE_COUNT_1_BIT, VK_FALSE, 0, &mask, VK_FALSE, VK_FALSE};
        VkPipelineDepthStencilStateCreateInfo depth = {VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO};
        depth.depthTestEnable = VK_TRUE;
        depth.depthCompareOp = VK_COMPARE_OP_LESS;
        depth.maxDepthBounds = 1.0f;
        VkPipelineColorBlendAttachmentState attachment = {VK_TRUE, VK_BLEND_FACTOR_SRC_ALPHA, VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA, VK_BLEND_OP_ADD,
                                                          VK_BLEND_FACTOR_ONE, VK_BLEND_FACTOR_ZERO, VK_BLEND_OP_ADD, 0xF};
        VkPipelineColorBlendStateCreateInfo blend = {VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO, NULL, 0, VK_FALSE, VK_LOGIC_OP_COPY, 1, &attachment, {0.25f, 0.5f, 0.75f, 1.0f}};
        VkDynamicState dynamics[2] = {VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR};
        VkPipelineDynamicStateCreateInfo dynamic = {VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO, NULL, 0, 2, dynamics};
        VkGraphicsPipelineCreateInfo info = {VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, NULL, 0, 2, stages, &vertex, &assembly, NULL,
                                             &viewports, &raster, &multisample, &depth, &blend, &dynamic, H(VkPipelineLayout, 0x60),
                                             H(VkRenderPass, 0x61), 0, VK_NULL_HANDLE, -1};
        REQUEST(VkGraphicsPipelineCreateInfo, info);
    }
    {
        VkDescriptorImageInfo image = {H(VkSampler, 0x71), H(VkImageView, 0x72), VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL};
        VkDescriptorBufferInfo buffers[2] = {{H(VkBuffer, 0x73), 0, 256}, {H(VkBuffer, 0x74), 256, VK_WHOLE_SIZE}};
        VkBufferView view = H(VkBufferView, 0x75);
        // (pointers of the other descriptor types are written as there, not what they point to)
        VkWriteDescriptorSet sampler = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, NULL, H(VkDescriptorSet, 0x76), 0, 0, 1, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, &image, buffers, NULL};
        REQUEST(VkWriteDescriptorSet, sampler);
        VkWriteDescriptorSet uniform = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, NULL, H(VkDescriptorSet, 0x76), 1, 0, 2, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, &image, buffers, NULL};
        REQUEST(VkWriteDescriptorSet, uniform);
        VkWriteDescriptorSet texel = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, NULL, H(VkDescriptorSet, 0x76), 2, 3, 1, VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, NULL, NULL, &view};
        REQUEST(VkWriteDescriptorSet, texel);
    }
    {
        VkSampler immutable = H(VkSampler, 0x70);
        VkDescriptorSetLayoutBinding bindings[2] = {{0, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, &immutable},
                                                    {1, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_VERTEX_BIT, NULL}};
        VkDescriptorSetLayoutCreateInfo info = {VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, NULL, 0, 2, bindings};
        REQUEST(VkDescriptorSetLayoutCreateInfo, info);
    }
    {
        uint32_t code[3] = {0x07230203, 0x00010000, 0x0008000a};
        VkShaderModuleCreateInfo info = {VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, NULL, 0, 12, code};
        REQUEST(VkShaderModuleCreateInfo, info);
    }
    {
        uint64_t wait_value = 5, signal_value = 6;
        VkTimelineSemaphoreSubmitInfo timeline = {VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO, NULL, 1, &wait_value, 1, &signal_value};
        VkSemaphore wait = H(VkSemaphore, 1), signal = H(VkSemaphore, 4);
        VkPipelineStageFlags stage = 0x400;
        VkCommandBuffer cbs[2] = {H(VkCommandBuffer, 2), H(VkCommandBuffer, 3)};
        VkSubmitInfo info = {VK_STRUCTURE_TYPE_SUBMIT_INFO, &timeline, 1, &wait, &stage, 2, cbs, 1, &signal};
        REQUEST(VkSubmitInfo, info);
    }
    {
        VkAttachmentDescription attachment = {0, VK_FORMAT_R8G8B8A8_UNORM, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR, VK_ATTACHMENT_STORE_OP_STORE,
                                              VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_PRESENT_SRC_KHR};
        VkAttachmentReference color = {0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
        VkSubpassDescription subpass = {0, VK_PIPELINE_BIND_POINT_GRAPHICS, 0, NULL, 1, &color, NULL, NULL, 0, NULL};
        VkRenderPassCreateInfo info = {VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, NULL, 0, 1, &attachment, 1, &subpass, 0, NULL};
        REQUEST(VkRenderPassCreateInfo, info);
    }
    {
        VkExternalMemoryBufferCreateInfo external = {VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_BUFFER_CREATE_INFO, NULL, VK_EXTERNAL_MEMORY_HANDLE_TYPE_ANDROID_HARDWARE_BUFFER_BIT_ANDROID};
        VkBufferCreateInfo info = {VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, &external, 0, 65536, 0x82, VK_SHARING_MODE_EXCLUSIVE, 0, NULL};
        REQUEST(VkBufferCreateInfo, info);
    }
    {
        VkClearValue clear;
        clear.color.float32[0] = 0.1f;
        clear.color.float32[1] = 0.2f;
        clear.color.float32[2] = 0.3f;
        clear.color.float32[3] = 1.0f;
        VkRenderPassBeginInfo info = {VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, NULL, H(VkRenderPass, 0x61), H(VkFramebuffer, 0x62), {{1, 2}, {300, 200}}, 1, &clear};
        REQUEST(VkRenderPassBeginInfo, info);
    }
    {
        VkPushConstantRange range = {VK_SHADER_STAGE_VERTEX_BIT, 0, 16};
        VkDescriptorSetLayout layout = H(VkDescriptorSetLayout, 0x90);
        VkPipelineLayoutCreateInfo info = {VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, NULL, 0, 1, &layout, 1, &range};
        REQUEST(VkPipelineLayoutCreateInfo, info);
    }
    {
        VkCommandBufferBeginInfo info = {VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, NULL, VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, NULL};
        REQUEST(VkCommandBufferBeginInfo, info);
    }
    {
        VkImageMemoryBarrier barrier = {VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, NULL, 0, 0x100, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
                                        VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED, H(VkImage, 0x55), {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
        REQUEST(VkImageMemoryBarrier, barrier);
    }
}

/* the replies: a struct of each name (its chain as the guest sets it up), read and written again */
#define REPLY(Type, value)                                                      \
    if (name == #Type) {                                                        \
        stream.in = bytes.data();                                               \
        stream.in_size = bytes.size();                                          \
        unmarshal_##Type(&stream, MAX, &(value));                               \
        if (stream.in_pos != bytes.size()) {                                    \
            fprintf(stderr, "oracle: %s read %zu of %zu bytes\n", #Type, stream.in_pos, bytes.size()); \
            exit(1);                                                            \
        }                                                                       \
        VulkanStreamGuest again;                                                \
        marshal_##Type(&again, MAX, &(value));                                  \
        dump(#Type, again.out.data(), again.out.size());                        \
        continue;                                                               \
    }

static void replies(void)
{
    static char line[1 << 17];
    while (fgets(line, sizeof(line), stdin)) {
        char* space = strchr(line, ' ');
        if (!space) continue;
        *space = 0;
        std::string name = line;
        std::vector<uint8_t> bytes;
        for (char* p = space + 1; p[0] && p[1] && p[0] != '\n'; p += 2) {
            unsigned v;
            sscanf(p, "%2x", &v);
            bytes.push_back(v);
        }
        VulkanStreamGuest stream;
        VkPhysicalDeviceVulkan11Properties v11 = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_PROPERTIES};
        VkPhysicalDeviceDriverProperties driver = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES, &v11};
        VkPhysicalDeviceProperties2 properties = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, &driver};
        REPLY(VkPhysicalDeviceProperties2, properties);
        VkPhysicalDeviceVulkan12Features v12 = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES};
        VkPhysicalDeviceFeatures2 features = {VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, &v12};
        REPLY(VkPhysicalDeviceFeatures2, features);
        VkPhysicalDeviceMemoryProperties memory = {};
        REPLY(VkPhysicalDeviceMemoryProperties, memory);
        VkMemoryDedicatedRequirements dedicated = {VK_STRUCTURE_TYPE_MEMORY_DEDICATED_REQUIREMENTS};
        VkMemoryRequirements2 requirements = {VK_STRUCTURE_TYPE_MEMORY_REQUIREMENTS_2, &dedicated};
        REPLY(VkMemoryRequirements2, requirements);
        VkQueueFamilyProperties family = {};
        REPLY(VkQueueFamilyProperties, family);
        VkExtensionProperties extension = {};
        REPLY(VkExtensionProperties, extension);
        VkFormatProperties format = {};
        REPLY(VkFormatProperties, format);
        VkSubresourceLayout layout = {};
        REPLY(VkSubresourceLayout, layout);
        VkExternalImageFormatProperties external = {VK_STRUCTURE_TYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES};
        VkImageFormatProperties2 image_format = {VK_STRUCTURE_TYPE_IMAGE_FORMAT_PROPERTIES_2, &external};
        REPLY(VkImageFormatProperties2, image_format);
        fprintf(stderr, "oracle: no reply %s\n", name.c_str());
        exit(1);
    }
}

int main(int argc, char** argv)
{
    if (argc > 1 && !strcmp(argv[1], "requests")) requests();
    else if (argc > 1 && !strcmp(argv[1], "replies")) replies();
    else {
        fprintf(stderr, "usage: oracle requests | oracle replies < file\n");
        return 1;
    }
    return 0;
}
