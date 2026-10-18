// An AHardwareBuffer drawn by Vulkan and read by the CPU (P11.4 V2): what
// ANGLE, SurfaceFlinger and HWUI do with gralloc's buffers. The buffer is
// allocated by gralloc (minigbm), imported into Vulkan (venus turns it into
// VkImportMemoryResourceInfoMESA: the virtio-gpu resource), cleared to a
// known colour on the GPU, handed back (the foreign queue family) and read
// through AHardwareBuffer_lock. Prints each step and PASS or FAIL.
#include <android/hardware_buffer.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <vulkan/vulkan.h>
#include <vulkan/vulkan_android.h>

// (the VNDK's: libnativewindow exports it, the NDK neither declares nor links it)
typedef struct native_handle { int version, numFds, numInts, data[]; } native_handle_t;
typedef const native_handle_t *(*get_native_handle_t)(const AHardwareBuffer *buffer);

#define CHECK(call) do { VkResult r_ = (call); if(r_ != VK_SUCCESS) { printf("FAIL %s: %d\n", #call, r_); return 1; } } while(0)

static const uint32_t WIDTH = 64, HEIGHT = 64;

int main(void)
{
    AHardwareBuffer_Desc desc = {
        .width = WIDTH, .height = HEIGHT, .layers = 1, .format = AHARDWAREBUFFER_FORMAT_R8G8B8A8_UNORM,
        .usage = AHARDWAREBUFFER_USAGE_GPU_COLOR_OUTPUT | AHARDWAREBUFFER_USAGE_GPU_SAMPLED_IMAGE |
            AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN,
    };
    AHardwareBuffer *buffer = NULL;
    if(AHardwareBuffer_allocate(&desc, &buffer) != 0) { printf("FAIL AHardwareBuffer_allocate\n"); return 1; }
    AHardwareBuffer_describe(buffer, &desc);
    printf("ahb: %ux%u stride %u format %u\n", desc.width, desc.height, desc.stride, desc.format);
    // (gralloc's handle, word by word: the layout Mesa's gralloc helper reads)
    get_native_handle_t get_native_handle = (get_native_handle_t)dlsym(dlopen("libnativewindow.so", RTLD_NOW), "AHardwareBuffer_getNativeHandle");
    const native_handle_t *handle = get_native_handle ? get_native_handle(buffer) : NULL;
    if(handle)
    {
        printf("handle: version %d, %d fds, %d ints:", handle->version, handle->numFds, handle->numInts);
        for(int i = 0; i < handle->numFds + handle->numInts; i++) printf(" %08x", (unsigned)handle->data[i]);
        printf("\n");
    }

    VkApplicationInfo app = { VK_STRUCTURE_TYPE_APPLICATION_INFO, NULL, "vkahb", 1, NULL, 0, VK_API_VERSION_1_1 };
    VkInstanceCreateInfo instance_info = { VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, NULL, 0, &app, 0, NULL, 0, NULL };
    VkInstance instance;
    CHECK(vkCreateInstance(&instance_info, NULL, &instance));
    uint32_t count = 1;
    VkPhysicalDevice physical;
    CHECK(vkEnumeratePhysicalDevices(instance, &count, &physical));
    if(!count) { printf("FAIL no Vulkan device\n"); return 1; }
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(physical, &properties);
    printf("device: %s\n", properties.deviceName);

    // (the rest of what the AHardwareBuffer extension needs is Vulkan 1.1's)
    const char *extensions[] = {
        VK_ANDROID_EXTERNAL_MEMORY_ANDROID_HARDWARE_BUFFER_EXTENSION_NAME, VK_EXT_QUEUE_FAMILY_FOREIGN_EXTENSION_NAME,
    };
    // (the extensions the device lacks, if any)
    uint32_t available_count = 0;
    vkEnumerateDeviceExtensionProperties(physical, NULL, &available_count, NULL);
    VkExtensionProperties available[512];
    if(available_count > 512) available_count = 512;
    vkEnumerateDeviceExtensionProperties(physical, NULL, &available_count, available);
    for(size_t i = 0; i < sizeof(extensions) / sizeof(extensions[0]); i++)
    {
        int found = 0;
        for(uint32_t j = 0; j < available_count; j++) found |= !strcmp(available[j].extensionName, extensions[i]);
        if(!found) printf("missing: %s\n", extensions[i]);
    }
    float priority = 1;
    VkDeviceQueueCreateInfo queue_info = { VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, NULL, 0, 0, 1, &priority };
    VkDeviceCreateInfo device_info = { VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, NULL, 0, 1, &queue_info, 0, NULL,
        sizeof(extensions) / sizeof(extensions[0]), extensions, NULL };
    VkDevice device;
    CHECK(vkCreateDevice(physical, &device_info, NULL, &device));
    VkQueue queue;
    vkGetDeviceQueue(device, 0, 0, &queue);

    PFN_vkGetAndroidHardwareBufferPropertiesANDROID get_properties =
        (PFN_vkGetAndroidHardwareBufferPropertiesANDROID)vkGetDeviceProcAddr(device, "vkGetAndroidHardwareBufferPropertiesANDROID");
    VkAndroidHardwareBufferFormatPropertiesANDROID format = { VK_STRUCTURE_TYPE_ANDROID_HARDWARE_BUFFER_FORMAT_PROPERTIES_ANDROID };
    VkAndroidHardwareBufferPropertiesANDROID buffer_properties = { VK_STRUCTURE_TYPE_ANDROID_HARDWARE_BUFFER_PROPERTIES_ANDROID, &format };
    CHECK(get_properties(device, buffer, &buffer_properties));
    printf("ahb properties: size %llu, memory types 0x%x, format %d\n",
        (unsigned long long)buffer_properties.allocationSize, buffer_properties.memoryTypeBits, format.format);

    VkExternalMemoryImageCreateInfo external = { VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO, NULL,
        VK_EXTERNAL_MEMORY_HANDLE_TYPE_ANDROID_HARDWARE_BUFFER_BIT_ANDROID };
    VkImageCreateInfo image_info = { VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, &external, 0, VK_IMAGE_TYPE_2D,
        VK_FORMAT_R8G8B8A8_UNORM, { WIDTH, HEIGHT, 1 }, 1, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_TILING_OPTIMAL,
        VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT,
        VK_SHARING_MODE_EXCLUSIVE, 0, NULL, VK_IMAGE_LAYOUT_UNDEFINED };
    VkImage image;
    CHECK(vkCreateImage(device, &image_info, NULL, &image));

    VkMemoryDedicatedAllocateInfo dedicated = { VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO, NULL, image, VK_NULL_HANDLE };
    VkImportAndroidHardwareBufferInfoANDROID import = { VK_STRUCTURE_TYPE_IMPORT_ANDROID_HARDWARE_BUFFER_INFO_ANDROID, &dedicated, buffer };
    uint32_t type = 0;
    while(type < 32 && !(buffer_properties.memoryTypeBits & 1u << type)) type++;
    VkMemoryAllocateInfo allocate = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, &import, buffer_properties.allocationSize, type };
    VkDeviceMemory memory;
    CHECK(vkAllocateMemory(device, &allocate, NULL, &memory));
    CHECK(vkBindImageMemory(device, image, memory, 0));
    printf("imported: memory type %u\n", type);

    VkCommandPoolCreateInfo pool_info = { VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, NULL, 0, 0 };
    VkCommandPool pool;
    CHECK(vkCreateCommandPool(device, &pool_info, NULL, &pool));
    VkCommandBufferAllocateInfo command_info = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, NULL, pool, VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1 };
    VkCommandBuffer commands;
    CHECK(vkAllocateCommandBuffers(device, &command_info, &commands));
    VkCommandBufferBeginInfo begin = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, NULL, VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, NULL };
    CHECK(vkBeginCommandBuffer(commands, &begin));
    VkImageSubresourceRange range = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
    VkImageMemoryBarrier to_clear = { VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, NULL, 0, VK_ACCESS_TRANSFER_WRITE_BIT,
        VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED, image, range };
    vkCmdPipelineBarrier(commands, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1, &to_clear);
    VkClearColorValue colour = { .float32 = { 0.25f, 0.5f, 0.75f, 1.0f } };
    vkCmdClearColorImage(commands, image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, &colour, 1, &range);
    // (released to the foreign queue family: the CPU and other users of the buffer)
    VkImageMemoryBarrier release = { VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, NULL, VK_ACCESS_TRANSFER_WRITE_BIT, 0,
        VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_GENERAL, 0, VK_QUEUE_FAMILY_FOREIGN_EXT, image, range };
    vkCmdPipelineBarrier(commands, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, 0, 0, NULL, 0, NULL, 1, &release);
    CHECK(vkEndCommandBuffer(commands));
    VkFenceCreateInfo fence_info = { VK_STRUCTURE_TYPE_FENCE_CREATE_INFO, NULL, 0 };
    VkFence fence;
    CHECK(vkCreateFence(device, &fence_info, NULL, &fence));
    VkSubmitInfo submit = { VK_STRUCTURE_TYPE_SUBMIT_INFO, NULL, 0, NULL, NULL, 1, &commands, 0, NULL };
    CHECK(vkQueueSubmit(queue, 1, &submit, fence));
    CHECK(vkWaitForFences(device, 1, &fence, VK_TRUE, 60ull * 1000 * 1000 * 1000));
    printf("cleared\n");

    void *pixels = NULL;
    if(AHardwareBuffer_lock(buffer, AHARDWAREBUFFER_USAGE_CPU_READ_OFTEN, -1, NULL, &pixels) != 0 || !pixels)
    {
        printf("FAIL AHardwareBuffer_lock\n");
        return 1;
    }
    const uint8_t expected[4] = { 64, 128, 191, 255 };
    int bad = 0;
    for(uint32_t y = 0; y < HEIGHT; y++)
    {
        for(uint32_t x = 0; x < WIDTH; x++)
        {
            const uint8_t *p = (const uint8_t *)pixels + (y * desc.stride + x) * 4;
            for(int c = 0; c < 4; c++)
            {
                // (0.75 may round to 191 or 192)
                if(p[c] < expected[c] - 1 || p[c] > expected[c] + 1)
                {
                    if(bad++ < 4) printf("pixel %u,%u: %u %u %u %u\n", x, y, p[0], p[1], p[2], p[3]);
                    break;
                }
            }
        }
    }
    const uint8_t *first = (const uint8_t *)pixels;
    printf("pixel 0,0: %u %u %u %u\n", first[0], first[1], first[2], first[3]);
    AHardwareBuffer_unlock(buffer, NULL);
    printf(bad ? "FAIL %d pixels differ\n" : "PASS\n", bad);

    vkDestroyFence(device, fence, NULL);
    vkDestroyCommandPool(device, pool, NULL);
    vkDestroyImage(device, image, NULL);
    vkFreeMemory(device, memory, NULL);
    vkDestroyDevice(device, NULL);
    vkDestroyInstance(instance, NULL);
    AHardwareBuffer_release(buffer);
    return bad ? 1 : 0;
}
