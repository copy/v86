// Vulkan tests for the x86_64 Linux guest's Vulkan drivers (tests/x64/
// linux_gpu.mjs, scenario venus): virtio-gpu's Venus and, as the reference,
// lavapipe. Each test checks its results against what they must be:
//
//     VK_ICD_FILENAMES=<icd> vktest [test...]
//
// prints "VKTEST <name> ok" or "VKTEST <name> FAIL <what>", then
// "VKTEST done <n> failures".
//
// Built without the C library's headers (the host has none for musl; the
// two the Vulkan headers include are in tests/x64/include), with
// third_party/vulkan's; it links against musl's libc and the Vulkan loader
// from the guest's Alpine packages.

#include "vulkan_core.h"
// the shaders: tests/x64/vktest_shaders/ compiled by naga, and vkcube's
// (glslang's SPIR-V, from the guest's vulkan-tools), by tests/x64/linux_gpu.mjs
#include "vktest_shaders.h"

int printf(const char *, ...);
void *malloc(size_t);
void *calloc(size_t, size_t);
void free(void *);
void *memset(void *, int, size_t);
void *memcpy(void *, const void *, size_t);
int memcmp(const void *, const void *, size_t);
int strcmp(const char *, const char *);
int fflush(void *);

// the start: what musl's crt1 does
int __libc_start_main(int (*)(int, char **, char **), int, char **, void (*)(void), void (*)(void), void (*)(void));
int main(int, char **, char **);
#if defined(__aarch64__)
// (the arm64 guest's, tests/a64/linux_gpu.mjs: the stack is 16-byte aligned at entry)
__asm__(".text\n.global _start\n_start:\n mov x29, #0\n mov x30, #0\n mov x0, sp\n bl start_c\n brk #0\n");
#else
__asm__(".text\n.global _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n andq $-16, %rsp\n call start_c\n hlt\n");
#endif
__attribute__((used)) void start_c(long *p)
{
    __libc_start_main(main, (int)p[0], (char **)(p + 1), 0, 0, 0);
}

// ---------------------------------------------------------------------------
// The device

static VkInstance instance;
static VkPhysicalDevice physical;
static VkDevice device;
static VkQueue queue;
static VkCommandPool pool;
static int dynamic_rendering;
/** flat_pipeline's for dynamic rendering: VkPipelineRenderingCreateInfo, no render pass */
static const void *flat_next;
static VkPhysicalDeviceMemoryProperties memory_properties;
static int failures;
static int timeline_semaphores;
static char failure[256];

#define CHECK(x) do { VkResult r_ = (x); if(r_ != VK_SUCCESS) { printf("VKTEST error %s: %d\n", #x, r_); return 1; } } while(0)
#define EXPECT(cond, ...) do { if(!(cond)) { if(!failure[0]) { char *f_ = failure; (void)f_; sprintf_like(failure, __VA_ARGS__); } } } while(0)

static void sprintf_like(char *out, const char *text, ...)
{
    // (a fixed message: enough to say which check)
    int i = 0;
    for(; text[i] && i < 255; i++) out[i] = text[i];
    out[i] = 0;
}

static int setup(void)
{
    VkApplicationInfo app = { .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .pApplicationName = "vktest", .apiVersion = VK_API_VERSION_1_1 };
    VkInstanceCreateInfo info = { .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app };
    CHECK(vkCreateInstance(&info, 0, &instance));
    uint32_t count = 1;
    VkResult r = vkEnumeratePhysicalDevices(instance, &count, &physical);
    if((r != VK_SUCCESS && r != VK_INCOMPLETE) || !count) { printf("VKTEST error: no physical device\n"); return 1; }
    VkPhysicalDeviceProperties props;
    vkGetPhysicalDeviceProperties(physical, &props);
    printf("VKTEST device %s, Vulkan %u.%u.%u\n", props.deviceName, props.apiVersion >> 22, props.apiVersion >> 12 & 1023, props.apiVersion & 4095);
    vkGetPhysicalDeviceMemoryProperties(physical, &memory_properties);
    float priority = 1;
    VkDeviceQueueCreateInfo queue_info = { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueFamilyIndex = 0,
        .queueCount = 1, .pQueuePriorities = &priority };
    // VK_KHR_timeline_semaphore, when there is
    uint32_t extension_count = 0;
    vkEnumerateDeviceExtensionProperties(physical, 0, &extension_count, 0);
    VkExtensionProperties *extensions = calloc(extension_count + 1, sizeof *extensions);
    vkEnumerateDeviceExtensionProperties(physical, 0, &extension_count, extensions);
    for(uint32_t i = 0; i < extension_count; i++)
    {
        if(!strcmp(extensions[i].extensionName, "VK_KHR_timeline_semaphore")) timeline_semaphores = 1;
        if(!strcmp(extensions[i].extensionName, "VK_KHR_dynamic_rendering")) dynamic_rendering = 1;
    }
    free(extensions);
    // and VK_KHR_dynamic_rendering (with what it needs)
    const char *enabled[4];
    uint32_t enabled_count = 0;
    void *chain = 0;
    VkPhysicalDeviceDynamicRenderingFeatures dynamic_features = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DYNAMIC_RENDERING_FEATURES,
        .dynamicRendering = VK_TRUE };
    VkPhysicalDeviceTimelineSemaphoreFeatures timeline_features = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TIMELINE_SEMAPHORE_FEATURES,
        .timelineSemaphore = VK_TRUE };
    if(dynamic_rendering)
    {
        enabled[enabled_count++] = "VK_KHR_dynamic_rendering";
        enabled[enabled_count++] = "VK_KHR_depth_stencil_resolve";
        enabled[enabled_count++] = "VK_KHR_create_renderpass2";
        dynamic_features.pNext = chain;
        chain = &dynamic_features;
    }
    if(timeline_semaphores)
    {
        enabled[enabled_count++] = "VK_KHR_timeline_semaphore";
        timeline_features.pNext = chain;
        chain = &timeline_features;
    }
    VkDeviceCreateInfo device_info = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .queueCreateInfoCount = 1, .pQueueCreateInfos = &queue_info,
        .pNext = chain, .enabledExtensionCount = enabled_count, .ppEnabledExtensionNames = enabled };
    CHECK(vkCreateDevice(physical, &device_info, 0, &device));
    vkGetDeviceQueue(device, 0, 0, &queue);
    VkCommandPoolCreateInfo pool_info = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
        .flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT };
    CHECK(vkCreateCommandPool(device, &pool_info, 0, &pool));
    return 0;
}

static uint32_t memory_type(uint32_t bits, VkMemoryPropertyFlags want)
{
    for(uint32_t i = 0; i < memory_properties.memoryTypeCount; i++)
    {
        if(bits & 1u << i && (memory_properties.memoryTypes[i].propertyFlags & want) == want) return i;
    }
    return ~0u;
}

typedef struct { VkBuffer buffer; VkDeviceMemory memory; uint8_t *map; VkDeviceSize size; } Buffer;

static Buffer buffer(VkDeviceSize size, int host)
{
    Buffer b = { .size = size };
    VkBufferCreateInfo info = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = size,
        .usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT | VK_BUFFER_USAGE_STORAGE_BUFFER_BIT |
            VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT | VK_BUFFER_USAGE_VERTEX_BUFFER_BIT | VK_BUFFER_USAGE_INDEX_BUFFER_BIT };
    vkCreateBuffer(device, &info, 0, &b.buffer);
    VkMemoryRequirements req;
    vkGetBufferMemoryRequirements(device, b.buffer, &req);
    VkMemoryAllocateInfo alloc = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size,
        .memoryTypeIndex = memory_type(req.memoryTypeBits, host ? VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT :
            VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT) };
    vkAllocateMemory(device, &alloc, 0, &b.memory);
    vkBindBufferMemory(device, b.buffer, b.memory, 0);
    if(host) vkMapMemory(device, b.memory, 0, VK_WHOLE_SIZE, 0, (void **)&b.map);
    return b;
}

static void buffer_free(Buffer *b)
{
    if(b->map) vkUnmapMemory(device, b->memory);
    vkDestroyBuffer(device, b->buffer, 0);
    vkFreeMemory(device, b->memory, 0);
}

typedef struct { VkImage image; VkDeviceMemory memory; VkFormat format; uint32_t width, height; } Image;

static Image image(VkFormat format, uint32_t width, uint32_t height, uint32_t mips, VkSampleCountFlagBits samples, VkImageUsageFlags usage)
{
    Image i = { .format = format, .width = width, .height = height };
    VkImageCreateInfo info = { .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = format,
        .extent = { width, height, 1 }, .mipLevels = mips, .arrayLayers = 1, .samples = samples, .tiling = VK_IMAGE_TILING_OPTIMAL,
        .usage = usage, .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED };
    vkCreateImage(device, &info, 0, &i.image);
    VkMemoryRequirements req;
    vkGetImageMemoryRequirements(device, i.image, &req);
    VkMemoryAllocateInfo alloc = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size,
        .memoryTypeIndex = memory_type(req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT) };
    vkAllocateMemory(device, &alloc, 0, &i.memory);
    vkBindImageMemory(device, i.image, i.memory, 0);
    return i;
}

static void image_free(Image *i)
{
    vkDestroyImage(device, i->image, 0);
    vkFreeMemory(device, i->memory, 0);
}

static VkCommandBuffer begin(void)
{
    VkCommandBuffer cb;
    VkCommandBufferAllocateInfo info = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = pool,
        .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1 };
    vkAllocateCommandBuffers(device, &info, &cb);
    VkCommandBufferBeginInfo begin_info = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
        .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT };
    vkBeginCommandBuffer(cb, &begin_info);
    return cb;
}

/** end, submit, wait for the fence */
static VkResult run(VkCommandBuffer cb)
{
    vkEndCommandBuffer(cb);
    VkFence fence;
    VkFenceCreateInfo fence_info = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
    vkCreateFence(device, &fence_info, 0, &fence);
    VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cb };
    VkResult r = vkQueueSubmit(queue, 1, &submit, fence);
    if(r == VK_SUCCESS) r = vkWaitForFences(device, 1, &fence, VK_TRUE, 30ull * 1000 * 1000 * 1000);
    vkDestroyFence(device, fence, 0);
    vkFreeCommandBuffers(device, pool, 1, &cb);
    return r;
}

static void barrier(VkCommandBuffer cb)
{
    VkMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_MEMORY_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT };
    vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 1, &b, 0, 0, 0, 0);
}

static void layout(VkCommandBuffer cb, VkImage image, VkImageAspectFlags aspect, VkImageLayout from, VkImageLayout to)
{
    VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_MEMORY_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT, .oldLayout = from, .newLayout = to,
        .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED, .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED, .image = image,
        .subresourceRange = { aspect, 0, VK_REMAINING_MIP_LEVELS, 0, VK_REMAINING_ARRAY_LAYERS } };
    vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 0, 0, 0, 0, 1, &b);
}

static int near(int a, int b, int tolerance)
{
    return a - b <= tolerance && b - a <= tolerance;
}

// ---------------------------------------------------------------------------
// The tests: each returns nonzero on an error of the API, and puts what it
// found wrong into `failure`

/** copies host -> device local -> host; the guest's writes reach the GPU, the GPU's come back */
static int test_buffer_copy(void)
{
    Buffer src = buffer(4096, 1), mid = buffer(4096, 0), dst = buffer(4096, 1);
    for(int i = 0; i < 4096; i++) src.map[i] = (uint8_t)(i * 7 + 3);
    memset(dst.map, 0x5A, 4096);
    VkCommandBuffer cb = begin();
    VkBufferCopy whole = { 0, 0, 4096 }, part = { 1024, 8, 512 };
    vkCmdCopyBuffer(cb, src.buffer, mid.buffer, 1, &whole);
    barrier(cb);
    vkCmdCopyBuffer(cb, mid.buffer, dst.buffer, 1, &part);
    CHECK(run(cb));
    int bad = 0;
    for(int i = 0; i < 4096; i++)
    {
        uint8_t want = i >= 8 && i < 520 ? (uint8_t)((i - 8 + 1024) * 7 + 3) : 0x5A;
        if(dst.map[i] != want) bad++;
    }
    EXPECT(!bad, "bytes differ after the copies");
    buffer_free(&src); buffer_free(&mid); buffer_free(&dst);
    return 0;
}

static int test_fill_update(void)
{
    Buffer b = buffer(2048, 1);
    memset(b.map, 0x5A, 2048);
    uint32_t words[16];
    for(int i = 0; i < 16; i++) words[i] = 0x01020304u * (i + 1);
    VkCommandBuffer cb = begin();
    vkCmdFillBuffer(cb, b.buffer, 256, 256, 0x11223344);
    vkCmdUpdateBuffer(cb, b.buffer, 1024, sizeof words, words);
    vkCmdFillBuffer(cb, b.buffer, 1536, VK_WHOLE_SIZE, 0);
    CHECK(run(cb));
    uint32_t *w = (uint32_t *)b.map;
    int bad = 0;
    for(int i = 64; i < 128; i++) bad += w[i] != 0x11223344;
    EXPECT(!bad, "vkCmdFillBuffer");
    EXPECT(!memcmp(b.map + 1024, words, sizeof words), "vkCmdUpdateBuffer");
    EXPECT(b.map[255] == 0x5A && b.map[512] == 0x5A && b.map[1023] == 0x5A, "bytes around them changed");
    bad = 0;
    for(int i = 1536; i < 2048; i++) bad += b.map[i] != 0;
    EXPECT(!bad, "vkCmdFillBuffer to VK_WHOLE_SIZE");
    buffer_free(&b);
    return 0;
}

/** buffer -> image -> buffer, the second with a row length and offset of its own */
static int test_image_roundtrip(void)
{
    const uint32_t W = 64, H = 48;
    Buffer src = buffer(W * H * 4, 1), dst = buffer(256 + 70 * H * 4, 1);
    for(uint32_t i = 0; i < W * H * 4; i++) src.map[i] = (uint8_t)(i * 13 + i / 256);
    memset(dst.map, 0, dst.size);
    Image img = image(VK_FORMAT_R8G8B8A8_UNORM, W, H, 1, VK_SAMPLE_COUNT_1_BIT,
        VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT);
    VkCommandBuffer cb = begin();
    layout(cb, img.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
    VkBufferImageCopy in = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { W, H, 1 } };
    vkCmdCopyBufferToImage(cb, src.buffer, img.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &in);
    layout(cb, img.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
    VkBufferImageCopy out = { .bufferOffset = 256, .bufferRowLength = 70, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
        .imageExtent = { W, H, 1 } };
    vkCmdCopyImageToBuffer(cb, img.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, dst.buffer, 1, &out);
    CHECK(run(cb));
    int bad = 0;
    for(uint32_t y = 0; y < H; y++) bad += memcmp(dst.map + 256 + y * 70 * 4, src.map + y * W * 4, W * 4) != 0;
    EXPECT(!bad, "rows differ");
    image_free(&img); buffer_free(&src); buffer_free(&dst);
    return 0;
}

/** a region of mip 1 */
static int test_image_mip_region(void)
{
    Buffer src = buffer(16 * 16 * 4, 1), dst = buffer(16 * 16 * 4, 1);
    for(int i = 0; i < 16 * 16 * 4; i++) src.map[i] = (uint8_t)(255 - i);
    memset(dst.map, 0, dst.size);
    Image img = image(VK_FORMAT_R8G8B8A8_UINT, 32, 32, 3, VK_SAMPLE_COUNT_1_BIT,
        VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    VkCommandBuffer cb = begin();
    layout(cb, img.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    VkBufferImageCopy in = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 1, 0, 1 }, .imageOffset = { 4, 2, 0 }, .imageExtent = { 8, 6, 1 } };
    vkCmdCopyBufferToImage(cb, src.buffer, img.image, VK_IMAGE_LAYOUT_GENERAL, 1, &in);
    barrier(cb);
    VkBufferImageCopy out = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 1, 0, 1 }, .imageOffset = { 4, 2, 0 }, .imageExtent = { 8, 6, 1 } };
    vkCmdCopyImageToBuffer(cb, img.image, VK_IMAGE_LAYOUT_GENERAL, dst.buffer, 1, &out);
    CHECK(run(cb));
    EXPECT(!memcmp(dst.map, src.map, 8 * 6 * 4), "the region of mip 1 differs");
    image_free(&img); buffer_free(&src); buffer_free(&dst);
    return 0;
}

static int read_color(Image *img, uint32_t mip, Buffer *out)
{
    VkCommandBuffer cb = begin();
    layout(cb, img->image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_GENERAL);
    VkBufferImageCopy copy = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, mip, 0, 1 },
        .imageExtent = { img->width >> mip, img->height >> mip, 1 } };
    vkCmdCopyImageToBuffer(cb, img->image, VK_IMAGE_LAYOUT_GENERAL, out->buffer, 1, &copy);
    return run(cb);
}

static int test_clear_color(void)
{
    Buffer out = buffer(16 * 16 * 16, 1);
    VkImageSubresourceRange all = { VK_IMAGE_ASPECT_COLOR_BIT, 0, VK_REMAINING_MIP_LEVELS, 0, 1 };
    // UNORM: (0.25, 0.5, 0.75, 1)
    Image unorm = image(VK_FORMAT_R8G8B8A8_UNORM, 16, 16, 2, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    VkCommandBuffer cb = begin();
    layout(cb, unorm.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    VkClearColorValue c1 = { .float32 = { 0.25f, 0.5f, 0.75f, 1.0f } };
    vkCmdClearColorImage(cb, unorm.image, VK_IMAGE_LAYOUT_GENERAL, &c1, 1, &all);
    CHECK(run(cb));
    CHECK(read_color(&unorm, 1, &out));
    EXPECT(near(out.map[0], 64, 1) && near(out.map[1], 128, 1) && near(out.map[2], 191, 1) && out.map[3] == 255 &&
        !memcmp(out.map, out.map + 4 * 63, 4), "R8G8B8A8_UNORM's mip 1");
    // UINT, exact
    Image uint = image(VK_FORMAT_R32G32B32A32_UINT, 8, 8, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    cb = begin();
    layout(cb, uint.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    VkClearColorValue c2 = { .uint32 = { 1, 2, 0x80000000u, 0xFFFFFFFFu } };
    vkCmdClearColorImage(cb, uint.image, VK_IMAGE_LAYOUT_GENERAL, &c2, 1, &all);
    CHECK(run(cb));
    CHECK(read_color(&uint, 0, &out));
    uint32_t *u = (uint32_t *)out.map;
    EXPECT(u[0] == 1 && u[1] == 2 && u[2] == 0x80000000u && u[3] == 0xFFFFFFFFu && u[255] == 0xFFFFFFFFu, "R32G32B32A32_UINT");
    // half floats
    Image half = image(VK_FORMAT_R16G16B16A16_SFLOAT, 8, 8, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    cb = begin();
    layout(cb, half.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    VkClearColorValue c3 = { .float32 = { 0.5f, -2.0f, 0.0f, 1.0f } };
    vkCmdClearColorImage(cb, half.image, VK_IMAGE_LAYOUT_GENERAL, &c3, 1, &all);
    CHECK(run(cb));
    CHECK(read_color(&half, 0, &out));
    uint16_t *h = (uint16_t *)out.map;
    EXPECT(h[0] == 0x3800 && h[1] == 0xC000 && h[2] == 0 && h[3] == 0x3C00, "R16G16B16A16_SFLOAT");
    image_free(&unorm); image_free(&uint); image_free(&half); buffer_free(&out);
    return 0;
}

static int test_clear_depth(void)
{
    Buffer out = buffer(16 * 16 * 4, 1);
    Image d32 = image(VK_FORMAT_D32_SFLOAT, 16, 16, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    Image d16 = image(VK_FORMAT_D16_UNORM, 16, 16, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    VkImageSubresourceRange depth = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 1, 0, 1 };
    VkClearDepthStencilValue v = { 0.375f, 0 };
    VkCommandBuffer cb = begin();
    layout(cb, d32.image, VK_IMAGE_ASPECT_DEPTH_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    layout(cb, d16.image, VK_IMAGE_ASPECT_DEPTH_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    vkCmdClearDepthStencilImage(cb, d32.image, VK_IMAGE_LAYOUT_GENERAL, &v, 1, &depth);
    v.depth = 0.5f;
    vkCmdClearDepthStencilImage(cb, d16.image, VK_IMAGE_LAYOUT_GENERAL, &v, 1, &depth);
    barrier(cb);
    VkBufferImageCopy copy = { .imageSubresource = { VK_IMAGE_ASPECT_DEPTH_BIT, 0, 0, 1 }, .imageExtent = { 16, 16, 1 } };
    vkCmdCopyImageToBuffer(cb, d32.image, VK_IMAGE_LAYOUT_GENERAL, out.buffer, 1, &copy);
    CHECK(run(cb));
    float *f = (float *)out.map;
    EXPECT(f[0] == 0.375f && f[255] == 0.375f, "D32_SFLOAT");
    cb = begin();
    vkCmdCopyImageToBuffer(cb, d16.image, VK_IMAGE_LAYOUT_GENERAL, out.buffer, 1, &copy);
    CHECK(run(cb));
    uint16_t *s = (uint16_t *)out.map;
    EXPECT(near(s[0], 32768, 1), "D16_UNORM");
    image_free(&d32); image_free(&d16); buffer_free(&out);
    return 0;
}

static int test_copy_image(void)
{
    Buffer src = buffer(32 * 32 * 4, 1), out = buffer(32 * 32 * 4, 1);
    for(int i = 0; i < 32 * 32 * 4; i++) src.map[i] = (uint8_t)(i ^ i >> 8);
    Image a = image(VK_FORMAT_R8G8B8A8_UNORM, 32, 32, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    Image b = image(VK_FORMAT_R8G8B8A8_UNORM, 32, 32, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    VkCommandBuffer cb = begin();
    layout(cb, a.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    layout(cb, b.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    VkBufferImageCopy in = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { 32, 32, 1 } };
    vkCmdCopyBufferToImage(cb, src.buffer, a.image, VK_IMAGE_LAYOUT_GENERAL, 1, &in);
    VkClearColorValue zero = { 0 };
    VkImageSubresourceRange range = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
    vkCmdClearColorImage(cb, b.image, VK_IMAGE_LAYOUT_GENERAL, &zero, 1, &range);
    barrier(cb);
    VkImageCopy region = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .srcOffset = { 8, 4, 0 },
        .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .dstOffset = { 1, 2, 0 }, .extent = { 16, 8, 1 } };
    vkCmdCopyImage(cb, a.image, VK_IMAGE_LAYOUT_GENERAL, b.image, VK_IMAGE_LAYOUT_GENERAL, 1, &region);
    CHECK(run(cb));
    CHECK(read_color(&b, 0, &out));
    int bad = 0;
    for(int y = 0; y < 32; y++) for(int x = 0; x < 32; x++)
    {
        const uint8_t *got = out.map + (y * 32 + x) * 4;
        int inside = x >= 1 && x < 17 && y >= 2 && y < 10;
        const uint8_t *want = src.map + ((y - 2 + 4) * 32 + x - 1 + 8) * 4;
        bad += inside ? memcmp(got, want, 4) != 0 : got[0] | got[1] | got[2] | got[3];
    }
    EXPECT(!bad, "the copied region (or what is around it) differs");
    image_free(&a); image_free(&b); buffer_free(&src); buffer_free(&out);
    return 0;
}

/** 4x4 -> 2x2, linear: each texel the average of 4 */
static int test_blit(void)
{
    Buffer src = buffer(4 * 4 * 4, 1), out = buffer(2 * 2 * 4, 1);
    for(int i = 0; i < 16; i++) { src.map[i * 4] = (uint8_t)(i * 16); src.map[i * 4 + 1] = 100; src.map[i * 4 + 2] = (uint8_t)(i & 1 ? 200 : 0); src.map[i * 4 + 3] = 255; }
    Image a = image(VK_FORMAT_R8G8B8A8_UNORM, 4, 4, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    Image b = image(VK_FORMAT_R8G8B8A8_UNORM, 2, 2, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    VkCommandBuffer cb = begin();
    layout(cb, a.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    layout(cb, b.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    VkBufferImageCopy in = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { 4, 4, 1 } };
    vkCmdCopyBufferToImage(cb, src.buffer, a.image, VK_IMAGE_LAYOUT_GENERAL, 1, &in);
    barrier(cb);
    VkImageBlit blit = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .srcOffsets = { { 0, 0, 0 }, { 4, 4, 1 } },
        .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .dstOffsets = { { 0, 0, 0 }, { 2, 2, 1 } } };
    vkCmdBlitImage(cb, a.image, VK_IMAGE_LAYOUT_GENERAL, b.image, VK_IMAGE_LAYOUT_GENERAL, 1, &blit, VK_FILTER_LINEAR);
    CHECK(run(cb));
    CHECK(read_color(&b, 0, &out));
    // texel (0, 0) averages source texels 0, 1, 4, 5: red (0 + 16 + 64 + 80) / 4 = 40, blue (0 + 200 + 0 + 200) / 4 = 100
    EXPECT(near(out.map[0], 40, 2) && out.map[1] == 100 && near(out.map[2], 100, 2) && out.map[3] == 255, "the linear blit's average");
    image_free(&a); image_free(&b); buffer_free(&src); buffer_free(&out);
    return 0;
}

static int test_resolve(void)
{
    Buffer out = buffer(8 * 8 * 4, 1);
    Image ms = image(VK_FORMAT_R8G8B8A8_UNORM, 8, 8, 1, VK_SAMPLE_COUNT_4_BIT, VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT);
    Image one = image(VK_FORMAT_R8G8B8A8_UNORM, 8, 8, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    VkCommandBuffer cb = begin();
    layout(cb, ms.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    layout(cb, one.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    VkClearColorValue c = { .float32 = { 0, 1, 0.5f, 1 } };
    VkImageSubresourceRange range = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
    vkCmdClearColorImage(cb, ms.image, VK_IMAGE_LAYOUT_GENERAL, &c, 1, &range);
    barrier(cb);
    VkImageResolve resolve = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
        .extent = { 8, 8, 1 } };
    vkCmdResolveImage(cb, ms.image, VK_IMAGE_LAYOUT_GENERAL, one.image, VK_IMAGE_LAYOUT_GENERAL, 1, &resolve);
    CHECK(run(cb));
    CHECK(read_color(&one, 0, &out));
    EXPECT(out.map[0] == 0 && out.map[1] == 255 && near(out.map[2], 128, 1) && out.map[3] == 255, "the resolved color");
    image_free(&ms); image_free(&one); buffer_free(&out);
    return 0;
}

static int test_fence(void)
{
    VkFence fence;
    VkFenceCreateInfo info = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO, .flags = VK_FENCE_CREATE_SIGNALED_BIT };
    CHECK(vkCreateFence(device, &info, 0, &fence));
    EXPECT(vkGetFenceStatus(device, fence) == VK_SUCCESS, "created signaled");
    vkResetFences(device, 1, &fence);
    EXPECT(vkGetFenceStatus(device, fence) == VK_NOT_READY, "reset: not ready");
    EXPECT(vkWaitForFences(device, 1, &fence, VK_TRUE, 0) == VK_TIMEOUT, "a wait of 0 on an unsignaled fence times out");
    EXPECT(vkWaitForFences(device, 1, &fence, VK_TRUE, 1000 * 1000) == VK_TIMEOUT, "a wait of 1 ms times out");
    Buffer b = buffer(256, 1);
    VkCommandBuffer cb = begin();
    vkCmdFillBuffer(cb, b.buffer, 0, 256, 0xCAFEF00D);
    vkEndCommandBuffer(cb);
    VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cb };
    CHECK(vkQueueSubmit(queue, 1, &submit, fence));
    CHECK(vkWaitForFences(device, 1, &fence, VK_TRUE, 30ull * 1000 * 1000 * 1000));
    EXPECT(vkGetFenceStatus(device, fence) == VK_SUCCESS, "signaled by the submission");
    EXPECT(((uint32_t *)b.map)[63] == 0xCAFEF00D, "the submission's work is done when its fence is");
    vkFreeCommandBuffers(device, pool, 1, &cb);
    vkDestroyFence(device, fence, 0);
    buffer_free(&b);
    return 0;
}

/** a submission waits for a timeline value the host signals, and signals the next */
static int test_timeline(void)
{
    if(!timeline_semaphores) { EXPECT(0, "VK_KHR_timeline_semaphore is not there"); return 0; }
    VkSemaphoreTypeCreateInfo type = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO, .semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE,
        .initialValue = 0 };
    VkSemaphoreCreateInfo info = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO, .pNext = &type };
    VkSemaphore timeline;
    CHECK(vkCreateSemaphore(device, &info, 0, &timeline));
    Buffer b = buffer(256, 1);
    memset(b.map, 0, 256);
    VkCommandBuffer cb = begin();
    vkCmdFillBuffer(cb, b.buffer, 0, 256, 0x12345678);
    vkEndCommandBuffer(cb);
    uint64_t wait = 1, signal = 2;
    VkTimelineSemaphoreSubmitInfo values = { .sType = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO,
        .waitSemaphoreValueCount = 1, .pWaitSemaphoreValues = &wait, .signalSemaphoreValueCount = 1, .pSignalSemaphoreValues = &signal };
    VkPipelineStageFlags stage = VK_PIPELINE_STAGE_TRANSFER_BIT;
    VkSubmitInfo submit = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .pNext = &values, .waitSemaphoreCount = 1, .pWaitSemaphores = &timeline,
        .pWaitDstStageMask = &stage, .commandBufferCount = 1, .pCommandBuffers = &cb, .signalSemaphoreCount = 1, .pSignalSemaphores = &timeline };
    PFN_vkGetSemaphoreCounterValue get = (PFN_vkGetSemaphoreCounterValue)vkGetDeviceProcAddr(device, "vkGetSemaphoreCounterValueKHR");
    PFN_vkSignalSemaphore host_signal = (PFN_vkSignalSemaphore)vkGetDeviceProcAddr(device, "vkSignalSemaphoreKHR");
    PFN_vkWaitSemaphores host_wait = (PFN_vkWaitSemaphores)vkGetDeviceProcAddr(device, "vkWaitSemaphoresKHR");
    if(!get || !host_signal || !host_wait) { EXPECT(0, "no timeline semaphore functions"); return 0; }
    CHECK(vkQueueSubmit(queue, 1, &submit, VK_NULL_HANDLE));
    uint64_t value = 99;
    get(device, timeline, &value);
    EXPECT(value == 0, "nothing signaled yet");
    VkSemaphoreWaitInfo wait_info = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO, .semaphoreCount = 1, .pSemaphores = &timeline, .pValues = &signal };
    EXPECT(host_wait(device, &wait_info, 1000 * 1000) == VK_TIMEOUT, "the submission waits for the host");
    EXPECT(((uint32_t *)b.map)[0] == 0, "and its work is not done");
    VkSemaphoreSignalInfo signal_info = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO, .semaphore = timeline, .value = 1 };
    CHECK(host_signal(device, &signal_info));
    CHECK(host_wait(device, &wait_info, 30ull * 1000 * 1000 * 1000));
    get(device, timeline, &value);
    EXPECT(value == 2, "the submission signaled 2");
    EXPECT(((uint32_t *)b.map)[63] == 0x12345678, "after the host's signal, the work is done");
    vkFreeCommandBuffers(device, pool, 1, &cb);
    vkDestroySemaphore(device, timeline, 0);
    buffer_free(&b);
    return 0;
}

/** two submissions in order through a binary semaphore; vkQueueWaitIdle */
static int test_semaphores(void)
{
    VkSemaphoreCreateInfo info = { .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO };
    VkSemaphore semaphore;
    CHECK(vkCreateSemaphore(device, &info, 0, &semaphore));
    Buffer a = buffer(256, 1), b = buffer(256, 1);
    memset(b.map, 0, 256);
    VkCommandBuffer first = begin();
    vkCmdFillBuffer(first, a.buffer, 0, 256, 0x0BADBEEF);
    vkEndCommandBuffer(first);
    VkCommandBuffer second = begin();
    VkBufferCopy copy = { 0, 0, 256 };
    vkCmdCopyBuffer(second, a.buffer, b.buffer, 1, &copy);
    vkEndCommandBuffer(second);
    VkPipelineStageFlags stage = VK_PIPELINE_STAGE_TRANSFER_BIT;
    VkSubmitInfo submits[2] = {
        { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &first, .signalSemaphoreCount = 1, .pSignalSemaphores = &semaphore },
        { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .waitSemaphoreCount = 1, .pWaitSemaphores = &semaphore, .pWaitDstStageMask = &stage,
          .commandBufferCount = 1, .pCommandBuffers = &second },
    };
    CHECK(vkQueueSubmit(queue, 1, &submits[0], VK_NULL_HANDLE));
    CHECK(vkQueueSubmit(queue, 1, &submits[1], VK_NULL_HANDLE));
    CHECK(vkQueueWaitIdle(queue));
    EXPECT(((uint32_t *)b.map)[0] == 0x0BADBEEF && ((uint32_t *)b.map)[63] == 0x0BADBEEF, "the second saw the first's work");
    VkCommandBuffer cbs[2] = { first, second };
    vkFreeCommandBuffers(device, pool, 2, cbs);
    vkDestroySemaphore(device, semaphore, 0);
    buffer_free(&a); buffer_free(&b);
    return 0;
}

static int test_events(void)
{
    VkEventCreateInfo info = { .sType = VK_STRUCTURE_TYPE_EVENT_CREATE_INFO };
    VkEvent event;
    CHECK(vkCreateEvent(device, &info, 0, &event));
    EXPECT(vkGetEventStatus(device, event) == VK_EVENT_RESET, "created reset");
    vkSetEvent(device, event);
    EXPECT(vkGetEventStatus(device, event) == VK_EVENT_SET, "set by the host");
    vkResetEvent(device, event);
    VkCommandBuffer cb = begin();
    vkCmdSetEvent(cb, event, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT);
    CHECK(run(cb));
    EXPECT(vkGetEventStatus(device, event) == VK_EVENT_SET, "set by a command buffer");
    vkDestroyEvent(device, event, 0);
    return 0;
}

/** memory the GPU writes, mapped again later: the GPU's bytes */
static int test_remap(void)
{
    Buffer b = buffer(8192, 1);
    vkUnmapMemory(device, b.memory);
    b.map = 0;
    VkCommandBuffer cb = begin();
    vkCmdFillBuffer(cb, b.buffer, 4096, 4096, 0x55AA55AA);
    CHECK(run(cb));
    uint32_t *w;
    CHECK(vkMapMemory(device, b.memory, 0, VK_WHOLE_SIZE, 0, (void **)&w));
    EXPECT(w[1024] == 0x55AA55AA && w[2047] == 0x55AA55AA, "the GPU's writes, in a later mapping");
    w[0] = 0x600DF00D;
    vkUnmapMemory(device, b.memory);
    Buffer out = buffer(256, 1);
    cb = begin();
    VkBufferCopy copy = { 0, 0, 4 };
    vkCmdCopyBuffer(cb, b.buffer, out.buffer, 1, &copy);
    CHECK(run(cb));
    EXPECT(((uint32_t *)out.map)[0] == 0x600DF00D, "the guest's write before an unmap reaches the GPU");
    vkDestroyBuffer(device, b.buffer, 0);
    vkFreeMemory(device, b.memory, 0);
    buffer_free(&out);
    return 0;
}


// ---------------------------------------------------------------------------
// Drawing: 64x64 targets, read back as RGBA8

#define SIZE 64

static VkShaderModule shader(const uint32_t *code, size_t size)
{
    VkShaderModuleCreateInfo info = { .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, .codeSize = size, .pCode = code };
    VkShaderModule module = VK_NULL_HANDLE;
    vkCreateShaderModule(device, &info, 0, &module);
    return module;
}

typedef struct {
    VkRenderPass pass;
    VkFramebuffer framebuffer;
    Image color, resolve, depth;
    VkImageView views[3];
    int has_depth, samples;
} Target;

static VkImageView view_of(Image *img, VkImageAspectFlags aspect)
{
    VkImageViewCreateInfo info = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = img->image, .viewType = VK_IMAGE_VIEW_TYPE_2D,
        .format = img->format, .subresourceRange = { aspect, 0, 1, 0, 1 } };
    VkImageView view = VK_NULL_HANDLE;
    vkCreateImageView(device, &info, 0, &view);
    return view;
}

/** a render pass of a color attachment (cleared), maybe a depth one (cleared to 1), maybe 4x with a resolve */
static Target target(int depth, int samples, VkClearColorValue unused)
{
    Target t = { .has_depth = depth, .samples = samples };
    VkSampleCountFlagBits count = samples > 1 ? VK_SAMPLE_COUNT_4_BIT : VK_SAMPLE_COUNT_1_BIT;
    t.color = image(VK_FORMAT_R8G8B8A8_UNORM, SIZE, SIZE, 1, count, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT);
    VkAttachmentDescription attachments[3] = {
        { .format = VK_FORMAT_R8G8B8A8_UNORM, .samples = count, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR, .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
          .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE, .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE,
          .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED, .finalLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL },
    };
    uint32_t n = 1;
    VkAttachmentReference color_ref = { 0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL }, resolve_ref = { 0, 0 }, depth_ref = { 0, 0 };
    t.views[0] = view_of(&t.color, VK_IMAGE_ASPECT_COLOR_BIT);
    if(samples > 1)
    {
        t.resolve = image(VK_FORMAT_R8G8B8A8_UNORM, SIZE, SIZE, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT);
        attachments[n] = attachments[0];
        attachments[n].samples = VK_SAMPLE_COUNT_1_BIT;
        attachments[n].loadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE;
        resolve_ref = (VkAttachmentReference){ n, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL };
        t.views[n++] = view_of(&t.resolve, VK_IMAGE_ASPECT_COLOR_BIT);
    }
    if(depth)
    {
        t.depth = image(VK_FORMAT_D32_SFLOAT, SIZE, SIZE, 1, count, VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT);
        attachments[n] = (VkAttachmentDescription){ .format = VK_FORMAT_D32_SFLOAT, .samples = count, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
            .storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
            .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
            .finalLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL };
        depth_ref = (VkAttachmentReference){ n, VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL };
        t.views[n++] = view_of(&t.depth, VK_IMAGE_ASPECT_DEPTH_BIT);
    }
    VkSubpassDescription subpass = { .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .colorAttachmentCount = 1,
        .pColorAttachments = &color_ref, .pResolveAttachments = samples > 1 ? &resolve_ref : 0, .pDepthStencilAttachment = depth ? &depth_ref : 0 };
    VkRenderPassCreateInfo info = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = n, .pAttachments = attachments,
        .subpassCount = 1, .pSubpasses = &subpass };
    vkCreateRenderPass(device, &info, 0, &t.pass);
    VkFramebufferCreateInfo fb = { .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = t.pass, .attachmentCount = n,
        .pAttachments = t.views, .width = SIZE, .height = SIZE, .layers = 1 };
    vkCreateFramebuffer(device, &fb, 0, &t.framebuffer);
    return t;
}

static void target_free(Target *t)
{
    vkDestroyFramebuffer(device, t->framebuffer, 0);
    vkDestroyRenderPass(device, t->pass, 0);
    int n = 1 + (t->samples > 1) + t->has_depth;
    for(int i = 0; i < n; i++) vkDestroyImageView(device, t->views[i], 0);
    image_free(&t->color);
    if(t->samples > 1) image_free(&t->resolve);
    if(t->has_depth) image_free(&t->depth);
}

static void begin_pass(VkCommandBuffer cb, Target *t, float r, float g, float b)
{
    VkClearValue clears[3] = { { .color = { .float32 = { r, g, b, 1 } } } };
    int n = 1;
    if(t->samples > 1) clears[n++].color = clears[0].color;
    if(t->has_depth) clears[n++].depthStencil = (VkClearDepthStencilValue){ 1, 0 };
    VkRenderPassBeginInfo info = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = t->pass, .framebuffer = t->framebuffer,
        .renderArea = { { 0, 0 }, { SIZE, SIZE } }, .clearValueCount = n, .pClearValues = clears };
    vkCmdBeginRenderPass(cb, &info, VK_SUBPASS_CONTENTS_INLINE);
    VkViewport viewport = { 0, 0, SIZE, SIZE, 0, 1 };
    VkRect2D scissor = { { 0, 0 }, { SIZE, SIZE } };
    vkCmdSetViewport(cb, 0, 1, &viewport);
    vkCmdSetScissor(cb, 0, 1, &scissor);
}

/** the target's picture (the resolved one when there is one) into `out` */
static int read_target(Target *t, Buffer *out)
{
    VkCommandBuffer cb = begin();
    VkBufferImageCopy copy = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { SIZE, SIZE, 1 } };
    vkCmdCopyImageToBuffer(cb, t->samples > 1 ? t->resolve.image : t->color.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out->buffer, 1, &copy);
    return run(cb);
}

static const uint8_t *pixel(Buffer *b, int x, int y)
{
    return b->map + (y * SIZE + x) * 4;
}

static int pixel_is(Buffer *b, int x, int y, int r, int g, int bl, int tolerance)
{
    const uint8_t *p = pixel(b, x, y);
    return near(p[0], r, tolerance) && near(p[1], g, tolerance) && near(p[2], bl, tolerance);
}

typedef struct {
    VkPipeline pipeline;
    VkPipelineLayout layout;
    VkDescriptorSetLayout set_layout;
} Pipeline;

/**
 * flat.vert/flat.frag: vertex buffer 0 (position vec3, color vec4: 28
 * bytes), push constants, the uniform buffer at set 0 binding 0
 */
static Pipeline flat_pipeline(Target *t, VkPrimitiveTopology topology, int depth_test, int blend)
{
    Pipeline p = { 0 };
    VkDescriptorSetLayoutBinding binding = { 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_VERTEX_BIT, 0 };
    VkDescriptorSetLayoutCreateInfo set_info = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 1, .pBindings = &binding };
    vkCreateDescriptorSetLayout(device, &set_info, 0, &p.set_layout);
    VkPushConstantRange push = { VK_SHADER_STAGE_VERTEX_BIT, 0, 16 };
    VkPipelineLayoutCreateInfo layout_info = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &p.set_layout,
        .pushConstantRangeCount = 1, .pPushConstantRanges = &push };
    vkCreatePipelineLayout(device, &layout_info, 0, &p.layout);
    VkShaderModule vs = shader(SPV_flat_vert, sizeof SPV_flat_vert), fs = shader(SPV_flat_frag, sizeof SPV_flat_frag);
    VkPipelineShaderStageCreateInfo stages[2] = {
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vs, .pName = "main" },
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fs, .pName = "main" },
    };
    VkVertexInputBindingDescription vb = { 0, 28, VK_VERTEX_INPUT_RATE_VERTEX };
    VkVertexInputAttributeDescription attributes[2] = { { 0, 0, VK_FORMAT_R32G32B32_SFLOAT, 0 }, { 1, 0, VK_FORMAT_R32G32B32A32_SFLOAT, 12 } };
    VkPipelineVertexInputStateCreateInfo vertex = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
        .vertexBindingDescriptionCount = 1, .pVertexBindingDescriptions = &vb, .vertexAttributeDescriptionCount = 2, .pVertexAttributeDescriptions = attributes };
    VkPipelineInputAssemblyStateCreateInfo assembly = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO, .topology = topology };
    VkPipelineViewportStateCreateInfo viewport = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1, .scissorCount = 1 };
    VkPipelineRasterizationStateCreateInfo raster = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
        .polygonMode = VK_POLYGON_MODE_FILL, .cullMode = VK_CULL_MODE_NONE, .frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE, .lineWidth = 1 };
    VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
        .rasterizationSamples = t->samples > 1 ? VK_SAMPLE_COUNT_4_BIT : VK_SAMPLE_COUNT_1_BIT };
    VkPipelineDepthStencilStateCreateInfo ds = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO,
        .depthTestEnable = depth_test, .depthWriteEnable = depth_test, .depthCompareOp = VK_COMPARE_OP_LESS, .maxDepthBounds = 1 };
    VkPipelineColorBlendAttachmentState attachment = { .blendEnable = blend, .srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA,
        .dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA, .colorBlendOp = VK_BLEND_OP_ADD, .srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE,
        .dstAlphaBlendFactor = VK_BLEND_FACTOR_ZERO, .alphaBlendOp = VK_BLEND_OP_ADD, .colorWriteMask = 0xF };
    VkPipelineColorBlendStateCreateInfo blend_state = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
        .attachmentCount = 1, .pAttachments = &attachment };
    VkDynamicState dynamic_states[2] = { VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR };
    VkPipelineDynamicStateCreateInfo dynamic = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO, .dynamicStateCount = 2,
        .pDynamicStates = dynamic_states };
    VkGraphicsPipelineCreateInfo info = { .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages,
        .pVertexInputState = &vertex, .pInputAssemblyState = &assembly, .pViewportState = &viewport, .pRasterizationState = &raster,
        .pMultisampleState = &ms, .pDepthStencilState = t->has_depth ? &ds : 0, .pColorBlendState = &blend_state, .pDynamicState = &dynamic,
        .layout = p.layout, .renderPass = flat_next ? VK_NULL_HANDLE : t->pass, .pNext = flat_next };
    vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &info, 0, &p.pipeline);
    vkDestroyShaderModule(device, vs, 0);
    vkDestroyShaderModule(device, fs, 0);
    return p;
}

static void pipeline_free(Pipeline *p)
{
    vkDestroyPipeline(device, p->pipeline, 0);
    vkDestroyPipelineLayout(device, p->layout, 0);
    vkDestroyDescriptorSetLayout(device, p->set_layout, 0);
}

/** a descriptor set of one uniform buffer for flat.vert */
static VkDescriptorSet uniform_set(Pipeline *p, VkDescriptorPool *pool_out, Buffer *ubo)
{
    VkDescriptorPoolSize size = { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1 };
    VkDescriptorPoolCreateInfo pool_info = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1, .poolSizeCount = 1, .pPoolSizes = &size };
    vkCreateDescriptorPool(device, &pool_info, 0, pool_out);
    VkDescriptorSetAllocateInfo alloc = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = *pool_out,
        .descriptorSetCount = 1, .pSetLayouts = &p->set_layout };
    VkDescriptorSet set;
    vkAllocateDescriptorSets(device, &alloc, &set);
    VkDescriptorBufferInfo info = { ubo->buffer, 0, 16 };
    VkWriteDescriptorSet write = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &info };
    vkUpdateDescriptorSets(device, 1, &write, 0, 0);
    return set;
}

/** a rectangle of two triangles, at a depth, of a color: 6 vertices of flat.vert's */
static void rectangle(float *v, float x0, float y0, float x1, float y1, float z, float r, float g, float b, float a)
{
    const float corners[6][2] = { { x0, y0 }, { x1, y0 }, { x0, y1 }, { x1, y0 }, { x1, y1 }, { x0, y1 } };
    for(int i = 0; i < 6; i++)
    {
        float *o = v + i * 7;
        o[0] = corners[i][0]; o[1] = corners[i][1]; o[2] = z;
        o[3] = r; o[4] = g; o[5] = b; o[6] = a;
    }
}

/** a rectangle, moved by push constants, tinted by a uniform buffer; Y down as Vulkan's */
static int test_draw(void)
{
    Target t = target(0, 1, (VkClearColorValue){ 0 });
    Pipeline p = flat_pipeline(&t, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST, 0, 0);
    Buffer vb = buffer(6 * 28, 1), ubo = buffer(256, 1), out = buffer(SIZE * SIZE * 4, 1);
    rectangle((float *)vb.map, -0.5f, -0.75f, 0.5f, 0.25f, 0.5f, 1, 0.5f, 0.25f, 1);
    float tint[4] = { 1, 1, 1, 1 };
    memcpy(ubo.map, tint, sizeof tint);
    VkDescriptorPool dpool;
    VkDescriptorSet set = uniform_set(&p, &dpool, &ubo);
    VkCommandBuffer cb = begin();
    begin_pass(cb, &t, 0, 0, 0);
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, p.pipeline);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, p.layout, 0, 1, &set, 0, 0);
    VkDeviceSize offset = 0;
    vkCmdBindVertexBuffers(cb, 0, 1, &vb.buffer, &offset);
    float push[4] = { 0.25f, 0, 1, 0 };
    vkCmdPushConstants(cb, p.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, push);
    vkCmdDraw(cb, 6, 1, 0, 0);
    vkCmdEndRenderPass(cb);
    CHECK(run(cb));
    CHECK(read_target(&t, &out));
    // x: -0.25 .. 0.75 -> pixels 24 .. 56; y: -0.75 .. 0.25 -> rows 8 .. 40 (Vulkan: -1 is the top)
    EXPECT(pixel_is(&out, 40, 12, 255, 128, 64, 2), "inside the rectangle (moved by the push constants)");
    EXPECT(pixel_is(&out, 40, 44, 0, 0, 0, 0), "below it: Y down");
    EXPECT(pixel_is(&out, 10, 20, 0, 0, 0, 0), "left of it");
    EXPECT(pixel_is(&out, 60, 20, 0, 0, 0, 0), "right of it");
    vkDestroyDescriptorPool(device, dpool, 0);
    pipeline_free(&p);
    target_free(&t);
    buffer_free(&vb); buffer_free(&ubo); buffer_free(&out);
    return 0;
}

/** indexed draws with a depth test: the nearer rectangle wins whatever the order */
static int test_depth(void)
{
    Target t = target(1, 1, (VkClearColorValue){ 0 });
    Pipeline p = flat_pipeline(&t, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST, 1, 0);
    Buffer vb = buffer(3 * 6 * 28, 1), ib = buffer(64, 1), ubo = buffer(256, 1), out = buffer(SIZE * SIZE * 4, 1);
    float *v = (float *)vb.map;
    rectangle(v, -1, -1, 1, 1, 0.5f, 1, 0, 0, 1);              // red, everywhere, at 0.5
    rectangle(v + 42, -0.5f, -0.5f, 0.5f, 0.5f, 0.25f, 0, 1, 0, 1); // green, the middle, nearer
    rectangle(v + 84, -1, -1, 1, 1, 0.75f, 0, 0, 1, 1);      // blue, everywhere, behind
    uint16_t *indices = (uint16_t *)ib.map;
    for(int i = 0; i < 18; i++) indices[i] = (uint16_t)i;
    float tint[4] = { 1, 1, 1, 1 };
    memcpy(ubo.map, tint, sizeof tint);
    VkDescriptorPool dpool;
    VkDescriptorSet set = uniform_set(&p, &dpool, &ubo);
    VkCommandBuffer cb = begin();
    begin_pass(cb, &t, 0, 0, 0);
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, p.pipeline);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, p.layout, 0, 1, &set, 0, 0);
    VkDeviceSize offset = 0;
    vkCmdBindVertexBuffers(cb, 0, 1, &vb.buffer, &offset);
    vkCmdBindIndexBuffer(cb, ib.buffer, 0, VK_INDEX_TYPE_UINT16);
    float push[4] = { 0, 0, 1, 0 };
    vkCmdPushConstants(cb, p.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, push);
    vkCmdDrawIndexed(cb, 6, 1, 0, 0, 0);
    vkCmdDrawIndexed(cb, 6, 1, 6, 0, 0);
    vkCmdDrawIndexed(cb, 6, 1, 0, 12, 0);
    vkCmdEndRenderPass(cb);
    CHECK(run(cb));
    CHECK(read_target(&t, &out));
    EXPECT(pixel_is(&out, 32, 32, 0, 255, 0, 0), "the middle: the nearest (green)");
    EXPECT(pixel_is(&out, 4, 4, 255, 0, 0, 0), "a corner: red, in front of blue");
    vkDestroyDescriptorPool(device, dpool, 0);
    pipeline_free(&p);
    target_free(&t);
    buffer_free(&vb); buffer_free(&ib); buffer_free(&ubo); buffer_free(&out);
    return 0;
}

/** blending: half transparent red over blue; and 4x MSAA, resolved */
static int test_blend_msaa(void)
{
    for(int msaa = 0; msaa < 2; msaa++)
    {
        Target t = target(0, msaa ? 4 : 1, (VkClearColorValue){ 0 });
        Pipeline p = flat_pipeline(&t, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST, 0, 1);
        Buffer vb = buffer(6 * 28, 1), ubo = buffer(256, 1), out = buffer(SIZE * SIZE * 4, 1);
        rectangle((float *)vb.map, -1, -1, 1, 1, 0, 1, 0, 0, 0.5f);
        float tint[4] = { 1, 1, 1, 1 };
        memcpy(ubo.map, tint, sizeof tint);
        VkDescriptorPool dpool;
        VkDescriptorSet set = uniform_set(&p, &dpool, &ubo);
        VkCommandBuffer cb = begin();
        begin_pass(cb, &t, 0, 0, 1);
        vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, p.pipeline);
        vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, p.layout, 0, 1, &set, 0, 0);
        VkDeviceSize offset = 0;
        vkCmdBindVertexBuffers(cb, 0, 1, &vb.buffer, &offset);
        float push[4] = { 0, 0, 1, 0 };
        vkCmdPushConstants(cb, p.layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, push);
        vkCmdDraw(cb, 6, 1, 0, 0);
        vkCmdEndRenderPass(cb);
        CHECK(run(cb));
        CHECK(read_target(&t, &out));
        EXPECT(pixel_is(&out, 32, 32, 128, 0, 128, 2), msaa ? "4x MSAA, resolved: half red over blue" : "half red over blue");
        vkDestroyDescriptorPool(device, dpool, 0);
        pipeline_free(&p);
        target_free(&t);
        buffer_free(&vb); buffer_free(&ubo); buffer_free(&out);
    }
    return 0;
}

/** a 2x2 texture, nearest, through a separate sampler: its texels in the quadrants */
static int test_texture(void)
{
    Target t = target(0, 1, (VkClearColorValue){ 0 });
    Buffer texels = buffer(16, 1), out = buffer(SIZE * SIZE * 4, 1);
    const uint8_t rgba[16] = { 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255 };
    memcpy(texels.map, rgba, 16);
    Image tex = image(VK_FORMAT_R8G8B8A8_UNORM, 2, 2, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    VkImageView view = view_of(&tex, VK_IMAGE_ASPECT_COLOR_BIT);
    VkSamplerCreateInfo sampler_info = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO, .magFilter = VK_FILTER_NEAREST, .minFilter = VK_FILTER_NEAREST,
        .addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE, .addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
        .addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE, .maxLod = 1 };
    VkSampler sampler;
    vkCreateSampler(device, &sampler_info, 0, &sampler);
    VkDescriptorSetLayoutBinding bindings[2] = {
        { 0, VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 1, VK_SHADER_STAGE_FRAGMENT_BIT, 0 },
        { 1, VK_DESCRIPTOR_TYPE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, 0 },
    };
    VkDescriptorSetLayoutCreateInfo set_info = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 2, .pBindings = bindings };
    VkDescriptorSetLayout set_layout;
    vkCreateDescriptorSetLayout(device, &set_info, 0, &set_layout);
    VkPipelineLayoutCreateInfo layout_info = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &set_layout };
    VkPipelineLayout pipeline_layout;
    vkCreatePipelineLayout(device, &layout_info, 0, &pipeline_layout);
    VkShaderModule vs = shader(SPV_textured_vert, sizeof SPV_textured_vert), fs = shader(SPV_textured_frag, sizeof SPV_textured_frag);
    VkPipelineShaderStageCreateInfo stages[2] = {
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vs, .pName = "main" },
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fs, .pName = "main" },
    };
    VkPipelineVertexInputStateCreateInfo vertex = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
    VkPipelineInputAssemblyStateCreateInfo assembly = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
        .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP };
    VkViewport vp = { 0, 0, SIZE, SIZE, 0, 1 };
    VkRect2D sc = { { 0, 0 }, { SIZE, SIZE } };
    VkPipelineViewportStateCreateInfo viewport = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1, .pViewports = &vp,
        .scissorCount = 1, .pScissors = &sc };
    VkPipelineRasterizationStateCreateInfo raster = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO, .lineWidth = 1 };
    VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO, .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
    VkPipelineColorBlendAttachmentState attachment = { .colorWriteMask = 0xF };
    VkPipelineColorBlendStateCreateInfo blend = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO, .attachmentCount = 1, .pAttachments = &attachment };
    VkGraphicsPipelineCreateInfo info = { .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages,
        .pVertexInputState = &vertex, .pInputAssemblyState = &assembly, .pViewportState = &viewport, .pRasterizationState = &raster,
        .pMultisampleState = &ms, .pColorBlendState = &blend, .layout = pipeline_layout, .renderPass = t.pass };
    VkPipeline pipeline;
    vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &info, 0, &pipeline);
    VkDescriptorPoolSize sizes[2] = { { VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, 1 }, { VK_DESCRIPTOR_TYPE_SAMPLER, 1 } };
    VkDescriptorPoolCreateInfo pool_info = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1, .poolSizeCount = 2, .pPoolSizes = sizes };
    VkDescriptorPool dpool;
    vkCreateDescriptorPool(device, &pool_info, 0, &dpool);
    VkDescriptorSetAllocateInfo alloc = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dpool, .descriptorSetCount = 1, .pSetLayouts = &set_layout };
    VkDescriptorSet set;
    vkAllocateDescriptorSets(device, &alloc, &set);
    VkDescriptorImageInfo image_info = { .imageView = view, .imageLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL };
    VkDescriptorImageInfo sampler_desc = { .sampler = sampler };
    VkWriteDescriptorSet writes[2] = {
        { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE, .pImageInfo = &image_info },
        { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_SAMPLER, .pImageInfo = &sampler_desc },
    };
    vkUpdateDescriptorSets(device, 2, writes, 0, 0);
    VkCommandBuffer cb = begin();
    layout(cb, tex.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
    VkBufferImageCopy copy = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { 2, 2, 1 } };
    vkCmdCopyBufferToImage(cb, texels.buffer, tex.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &copy);
    layout(cb, tex.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL);
    begin_pass(cb, &t, 0, 0, 0);
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline_layout, 0, 1, &set, 0, 0);
    vkCmdDraw(cb, 4, 1, 0, 0);
    vkCmdEndRenderPass(cb);
    CHECK(run(cb));
    CHECK(read_target(&t, &out));
    EXPECT(pixel_is(&out, 16, 16, 255, 0, 0, 0), "top left: texel (0, 0)");
    EXPECT(pixel_is(&out, 48, 16, 0, 255, 0, 0), "top right: texel (1, 0)");
    EXPECT(pixel_is(&out, 16, 48, 0, 0, 255, 0), "bottom left: texel (0, 1)");
    EXPECT(pixel_is(&out, 48, 48, 255, 255, 255, 0), "bottom right: texel (1, 1)");
    vkDestroyPipeline(device, pipeline, 0);
    vkDestroyDescriptorPool(device, dpool, 0);
    vkDestroyPipelineLayout(device, pipeline_layout, 0);
    vkDestroyDescriptorSetLayout(device, set_layout, 0);
    vkDestroyShaderModule(device, vs, 0);
    vkDestroyShaderModule(device, fs, 0);
    vkDestroySampler(device, sampler, 0);
    vkDestroyImageView(device, view, 0);
    image_free(&tex);
    target_free(&t);
    buffer_free(&texels); buffer_free(&out);
    return 0;
}

/** a compute shader into a storage buffer the guest maps */
static int test_compute(void)
{
    Buffer b = buffer(256 * 4, 1);
    memset(b.map, 0, 256 * 4);
    VkDescriptorSetLayoutBinding binding = { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, 0 };
    VkDescriptorSetLayoutCreateInfo set_info = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 1, .pBindings = &binding };
    VkDescriptorSetLayout set_layout;
    vkCreateDescriptorSetLayout(device, &set_info, 0, &set_layout);
    VkPushConstantRange push = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 4 };
    VkPipelineLayoutCreateInfo layout_info = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &set_layout,
        .pushConstantRangeCount = 1, .pPushConstantRanges = &push };
    VkPipelineLayout pipeline_layout;
    vkCreatePipelineLayout(device, &layout_info, 0, &pipeline_layout);
    VkShaderModule cs = shader(SPV_fill_comp, sizeof SPV_fill_comp);
    VkComputePipelineCreateInfo info = { .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT, .module = cs, .pName = "main" },
        .layout = pipeline_layout };
    VkPipeline pipeline;
    vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &info, 0, &pipeline);
    VkDescriptorPoolSize size = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 };
    VkDescriptorPoolCreateInfo pool_info = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1, .poolSizeCount = 1, .pPoolSizes = &size };
    VkDescriptorPool dpool;
    vkCreateDescriptorPool(device, &pool_info, 0, &dpool);
    VkDescriptorSetAllocateInfo alloc = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dpool, .descriptorSetCount = 1, .pSetLayouts = &set_layout };
    VkDescriptorSet set;
    vkAllocateDescriptorSets(device, &alloc, &set);
    VkDescriptorBufferInfo buffer_info = { b.buffer, 0, VK_WHOLE_SIZE };
    VkWriteDescriptorSet write = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &buffer_info };
    vkUpdateDescriptorSets(device, 1, &write, 0, 0);
    VkCommandBuffer cb = begin();
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline_layout, 0, 1, &set, 0, 0);
    uint32_t base = 7;
    vkCmdPushConstants(cb, pipeline_layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &base);
    vkCmdDispatch(cb, 4, 1, 1);
    CHECK(run(cb));
    const uint32_t *values = (const uint32_t *)b.map;
    int bad = 0;
    for(uint32_t i = 0; i < 256; i++) bad += values[i] != i * 2 + 7;
    EXPECT(!bad, "the storage buffer's values");
    vkDestroyPipeline(device, pipeline, 0);
    vkDestroyDescriptorPool(device, dpool, 0);
    vkDestroyPipelineLayout(device, pipeline_layout, 0);
    vkDestroyDescriptorSetLayout(device, set_layout, 0);
    vkDestroyShaderModule(device, cs, 0);
    buffer_free(&b);
    return 0;
}


/** vkCmdClearAttachments: a rectangle of the color, in the render pass */
static int test_clear_attachments(void)
{
    Target t = target(0, 1, (VkClearColorValue){ 0 });
    Buffer out = buffer(SIZE * SIZE * 4, 1);
    VkCommandBuffer cb = begin();
    begin_pass(cb, &t, 1, 0, 0);
    VkClearAttachment clear = { .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT, .colorAttachment = 0,
        .clearValue = { .color = { .float32 = { 0, 1, 0, 1 } } } };
    VkClearRect rect = { { { 16, 8 }, { 32, 16 } }, 0, 1 };
    vkCmdClearAttachments(cb, 1, &clear, 1, &rect);
    vkCmdEndRenderPass(cb);
    CHECK(run(cb));
    CHECK(read_target(&t, &out));
    EXPECT(pixel_is(&out, 32, 16, 0, 255, 0, 0), "inside the rectangle: its color");
    EXPECT(pixel_is(&out, 32, 30, 255, 0, 0, 0), "below it: the pass's clear");
    EXPECT(pixel_is(&out, 8, 16, 255, 0, 0, 0), "left of it");
    target_free(&t);
    buffer_free(&out);
    return 0;
}

/**
 * vkcube's shaders (glslang's SPIR-V: a combined image sampler, arrays in a
 * uniform buffer, derivatives): a triangle over the target, white texture;
 * the light is dot(lightDir, normal) = 0.707 for a flat triangle facing
 * the viewer: 180 in alpha, and vkcube's gamma makes the color 219 (as
 * lavapipe draws it)
 */
static int test_vkcube_shaders(void)
{
    if(sizeof SPV_cube_vert < 20 || sizeof SPV_cube_frag < 20) { EXPECT(0, "no vkcube shaders in the build"); return 0; }
    Target t = target(0, 1, (VkClearColorValue){ 0 });
    Buffer ubo = buffer(64 + 36 * 16 * 2, 1), texel = buffer(4, 1), out = buffer(SIZE * SIZE * 4, 1);
    float *u = (float *)ubo.map;
    memset(u, 0, ubo.size);
    for(int i = 0; i < 4; i++) u[i * 5] = 1;
    const float corners[3][4] = { { -1, -1, 0.5f, 1 }, { 3, -1, 0.5f, 1 }, { -1, 3, 0.5f, 1 } };
    memcpy(u + 16, corners, sizeof corners);
    memset(texel.map, 255, 4);
    Image tex = image(VK_FORMAT_R8G8B8A8_UNORM, 1, 1, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    VkImageView view = view_of(&tex, VK_IMAGE_ASPECT_COLOR_BIT);
    VkSamplerCreateInfo sampler_info = { .sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO, .magFilter = VK_FILTER_LINEAR, .minFilter = VK_FILTER_LINEAR,
        .addressModeU = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE, .addressModeV = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE,
        .addressModeW = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE, .maxLod = 1 };
    VkSampler sampler;
    vkCreateSampler(device, &sampler_info, 0, &sampler);
    VkDescriptorSetLayoutBinding bindings[2] = {
        { 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_VERTEX_BIT, 0 },
        { 1, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1, VK_SHADER_STAGE_FRAGMENT_BIT, 0 },
    };
    VkDescriptorSetLayoutCreateInfo set_info = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 2, .pBindings = bindings };
    VkDescriptorSetLayout set_layout;
    vkCreateDescriptorSetLayout(device, &set_info, 0, &set_layout);
    VkPipelineLayoutCreateInfo layout_info = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &set_layout };
    VkPipelineLayout pipeline_layout;
    vkCreatePipelineLayout(device, &layout_info, 0, &pipeline_layout);
    VkShaderModule vs = shader(SPV_cube_vert, sizeof SPV_cube_vert), fs = shader(SPV_cube_frag, sizeof SPV_cube_frag);
    VkPipelineShaderStageCreateInfo stages[2] = {
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vs, .pName = "main" },
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fs, .pName = "main" },
    };
    VkPipelineVertexInputStateCreateInfo vertex = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO };
    VkPipelineInputAssemblyStateCreateInfo assembly = { .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
        .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST };
    VkPipelineViewportStateCreateInfo viewport = { .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1, .scissorCount = 1 };
    VkPipelineRasterizationStateCreateInfo raster = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO, .lineWidth = 1 };
    VkPipelineMultisampleStateCreateInfo ms = { .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO, .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT };
    VkPipelineColorBlendAttachmentState attachment = { .colorWriteMask = 0xF };
    VkPipelineColorBlendStateCreateInfo blend = { .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO, .attachmentCount = 1, .pAttachments = &attachment };
    VkDynamicState dynamic_states[2] = { VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR };
    VkPipelineDynamicStateCreateInfo dynamic = { .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO, .dynamicStateCount = 2, .pDynamicStates = dynamic_states };
    VkGraphicsPipelineCreateInfo info = { .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages,
        .pVertexInputState = &vertex, .pInputAssemblyState = &assembly, .pViewportState = &viewport, .pRasterizationState = &raster,
        .pMultisampleState = &ms, .pColorBlendState = &blend, .pDynamicState = &dynamic, .layout = pipeline_layout, .renderPass = t.pass };
    VkPipeline pipeline;
    vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &info, 0, &pipeline);
    VkDescriptorPoolSize sizes[2] = { { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1 }, { VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1 } };
    VkDescriptorPoolCreateInfo pool_info = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1, .poolSizeCount = 2, .pPoolSizes = sizes };
    VkDescriptorPool dpool;
    vkCreateDescriptorPool(device, &pool_info, 0, &dpool);
    VkDescriptorSetAllocateInfo alloc = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dpool, .descriptorSetCount = 1, .pSetLayouts = &set_layout };
    VkDescriptorSet set;
    vkAllocateDescriptorSets(device, &alloc, &set);
    VkDescriptorBufferInfo buffer_info = { ubo.buffer, 0, VK_WHOLE_SIZE };
    VkDescriptorImageInfo image_info = { .sampler = sampler, .imageView = view, .imageLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL };
    VkWriteDescriptorSet writes[2] = {
        { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 0, .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, .pBufferInfo = &buffer_info },
        { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = 1, .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, .pImageInfo = &image_info },
    };
    vkUpdateDescriptorSets(device, 2, writes, 0, 0);
    VkCommandBuffer cb = begin();
    layout(cb, tex.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
    VkBufferImageCopy copy = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { 1, 1, 1 } };
    vkCmdCopyBufferToImage(cb, texel.buffer, tex.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &copy);
    layout(cb, tex.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL);
    begin_pass(cb, &t, 0, 0, 0);
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline_layout, 0, 1, &set, 0, 0);
    vkCmdDraw(cb, 3, 1, 0, 0);
    vkCmdEndRenderPass(cb);
    CHECK(run(cb));
    CHECK(read_target(&t, &out));
    const uint8_t *c = pixel(&out, 32, 32);
    printf("VKTEST vkcube-shaders: center %d,%d,%d,%d\n", c[0], c[1], c[2], c[3]);
    EXPECT(pixel_is(&out, 32, 32, 219, 219, 219, 3) && near(c[3], 180, 3), "lit white: dot(lightDir, normal)");
    vkDestroyPipeline(device, pipeline, 0);
    vkDestroyDescriptorPool(device, dpool, 0);
    vkDestroyPipelineLayout(device, pipeline_layout, 0);
    vkDestroyDescriptorSetLayout(device, set_layout, 0);
    vkDestroyShaderModule(device, vs, 0);
    vkDestroyShaderModule(device, fs, 0);
    vkDestroySampler(device, sampler, 0);
    vkDestroyImageView(device, view, 0);
    image_free(&tex);
    target_free(&t);
    buffer_free(&ubo); buffer_free(&texel); buffer_free(&out);
    return 0;
}


/** draws flat.vert's rectangles with `p` into `t`, the pass begun with these contents */
static void begin_flat(VkCommandBuffer cb, Target *t, Pipeline *p, VkDescriptorSet set, Buffer *vb)
{
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, p->pipeline);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, p->layout, 0, 1, &set, 0, 0);
    VkDeviceSize offset = 0;
    vkCmdBindVertexBuffers(cb, 0, 1, &vb->buffer, &offset);
    float push[4] = { 0, 0, 1, 0 };
    vkCmdPushConstants(cb, p->layout, VK_SHADER_STAGE_VERTEX_BIT, 0, 16, push);
    VkViewport viewport = { 0, 0, SIZE, SIZE, 0, 1 };
    VkRect2D scissor = { { 0, 0 }, { SIZE, SIZE } };
    vkCmdSetViewport(cb, 0, 1, &viewport);
    vkCmdSetScissor(cb, 0, 1, &scissor);
}

/**
 * Occlusion queries (the samples a draw covers: precise), timestamps, and
 * vkCmdCopyQueryPoolResults with availability
 */
static int test_queries(void)
{
    Target t = target(0, 1, (VkClearColorValue){ 0 });
    Pipeline p = flat_pipeline(&t, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST, 0, 0);
    Buffer vb = buffer(12 * 28, 1), ubo = buffer(256, 1), copied = buffer(64, 1);
    // 32 x 32 pixels; then one off the target
    rectangle((float *)vb.map, -0.5f, -0.5f, 0.5f, 0.5f, 0.5f, 1, 1, 1, 1);
    rectangle((float *)vb.map + 42, 2, 2, 3, 3, 0.5f, 1, 1, 1, 1);
    float tint[4] = { 1, 1, 1, 1 };
    memcpy(ubo.map, tint, sizeof tint);
    memset(copied.map, 0xEE, 64);
    VkDescriptorPool dpool;
    VkDescriptorSet set = uniform_set(&p, &dpool, &ubo);
    VkQueryPoolCreateInfo occlusion_info = { .sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, .queryType = VK_QUERY_TYPE_OCCLUSION, .queryCount = 2 };
    VkQueryPoolCreateInfo time_info = { .sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, .queryType = VK_QUERY_TYPE_TIMESTAMP, .queryCount = 2 };
    VkQueryPool occlusion, times;
    CHECK(vkCreateQueryPool(device, &occlusion_info, 0, &occlusion));
    CHECK(vkCreateQueryPool(device, &time_info, 0, &times));
    VkCommandBuffer cb = begin();
    vkCmdResetQueryPool(cb, occlusion, 0, 2);
    vkCmdResetQueryPool(cb, times, 0, 2);
    vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, times, 0);
    begin_pass(cb, &t, 0, 0, 0);
    begin_flat(cb, &t, &p, set, &vb);
    vkCmdBeginQuery(cb, occlusion, 0, VK_QUERY_CONTROL_PRECISE_BIT);
    vkCmdDraw(cb, 6, 1, 0, 0);
    vkCmdEndQuery(cb, occlusion, 0);
    vkCmdBeginQuery(cb, occlusion, 1, VK_QUERY_CONTROL_PRECISE_BIT);
    vkCmdDraw(cb, 6, 1, 6, 0);
    vkCmdEndQuery(cb, occlusion, 1);
    vkCmdEndRenderPass(cb);
    vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, times, 1);
    vkCmdCopyQueryPoolResults(cb, occlusion, 0, 2, copied.buffer, 0, 16, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
    vkCmdCopyQueryPoolResults(cb, occlusion, 0, 1, copied.buffer, 32, 8, VK_QUERY_RESULT_WAIT_BIT);
    CHECK(run(cb));
    uint64_t samples[2] = { 0 }, stamps[2] = { 0 };
    CHECK(vkGetQueryPoolResults(device, occlusion, 0, 2, sizeof samples, samples, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
    CHECK(vkGetQueryPoolResults(device, times, 0, 2, sizeof stamps, stamps, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
    printf("VKTEST queries: samples %llu %llu, timestamps %llu %llu\n", (unsigned long long)samples[0], (unsigned long long)samples[1],
        (unsigned long long)stamps[0], (unsigned long long)stamps[1]);
    // (without occlusionQueryPrecise, any number but 0 says samples passed)
    VkPhysicalDeviceFeatures features;
    vkGetPhysicalDeviceFeatures(physical, &features);
    EXPECT(features.occlusionQueryPrecise ? samples[0] == 32 * 32 : samples[0] > 0, "the rectangle's samples");
    EXPECT(samples[1] == 0, "none off the target");
    EXPECT(stamps[1] >= stamps[0] && stamps[0], "timestamps in order");
    const uint64_t *c = (const uint64_t *)copied.map;
    const uint32_t *c32 = (const uint32_t *)copied.map;
    EXPECT(c[0] == samples[0] && c[1] == 1 && c[2] == 0 && c[3] == 1, "copied: results and availability");
    EXPECT(c32[8] == samples[0] && c32[9] == 0xEEEEEEEE, "copied: 32 bits, nothing after");
    vkDestroyQueryPool(device, occlusion, 0);
    vkDestroyQueryPool(device, times, 0);
    vkDestroyDescriptorPool(device, dpool, 0);
    pipeline_free(&p);
    target_free(&t);
    buffer_free(&vb); buffer_free(&ubo); buffer_free(&copied);
    return 0;
}

/** a render pass whose draw is in a secondary command buffer */
static int test_secondary(void)
{
    Target t = target(0, 1, (VkClearColorValue){ 0 });
    Pipeline p = flat_pipeline(&t, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST, 0, 0);
    Buffer vb = buffer(6 * 28, 1), ubo = buffer(256, 1), out = buffer(SIZE * SIZE * 4, 1);
    rectangle((float *)vb.map, 0, 0, 1, 1, 0.5f, 0, 1, 1, 1);
    float tint[4] = { 1, 1, 1, 1 };
    memcpy(ubo.map, tint, sizeof tint);
    VkDescriptorPool dpool;
    VkDescriptorSet set = uniform_set(&p, &dpool, &ubo);
    VkCommandBuffer secondary;
    VkCommandBufferAllocateInfo alloc = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = pool,
        .level = VK_COMMAND_BUFFER_LEVEL_SECONDARY, .commandBufferCount = 1 };
    CHECK(vkAllocateCommandBuffers(device, &alloc, &secondary));
    VkCommandBufferInheritanceInfo inheritance = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_INFO, .renderPass = t.pass,
        .subpass = 0, .framebuffer = t.framebuffer };
    VkCommandBufferBeginInfo begin_info = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
        .flags = VK_COMMAND_BUFFER_USAGE_RENDER_PASS_CONTINUE_BIT, .pInheritanceInfo = &inheritance };
    CHECK(vkBeginCommandBuffer(secondary, &begin_info));
    begin_flat(secondary, &t, &p, set, &vb);
    vkCmdDraw(secondary, 6, 1, 0, 0);
    CHECK(vkEndCommandBuffer(secondary));
    VkCommandBuffer cb = begin();
    VkClearValue clear = { .color = { .float32 = { 1, 0, 0, 1 } } };
    VkRenderPassBeginInfo info = { .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = t.pass, .framebuffer = t.framebuffer,
        .renderArea = { { 0, 0 }, { SIZE, SIZE } }, .clearValueCount = 1, .pClearValues = &clear };
    vkCmdBeginRenderPass(cb, &info, VK_SUBPASS_CONTENTS_SECONDARY_COMMAND_BUFFERS);
    vkCmdExecuteCommands(cb, 1, &secondary);
    vkCmdEndRenderPass(cb);
    CHECK(run(cb));
    CHECK(read_target(&t, &out));
    EXPECT(pixel_is(&out, 48, 48, 0, 255, 255, 0), "the secondary's rectangle");
    EXPECT(pixel_is(&out, 16, 16, 255, 0, 0, 0), "the pass's clear around it");
    vkFreeCommandBuffers(device, pool, 1, &secondary);
    vkDestroyDescriptorPool(device, dpool, 0);
    pipeline_free(&p);
    target_free(&t);
    buffer_free(&vb); buffer_free(&ubo); buffer_free(&out);
    return 0;
}

/** vkCmdDrawIndirect (two draws from one buffer) and vkCmdDrawIndexedIndirect */
static int test_indirect(void)
{
    Target t = target(0, 1, (VkClearColorValue){ 0 });
    Pipeline p = flat_pipeline(&t, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST, 0, 0);
    Buffer vb = buffer(18 * 28, 1), ubo = buffer(256, 1), ib = buffer(6 * 2, 1), args = buffer(64, 1), out = buffer(SIZE * SIZE * 4, 1);
    rectangle((float *)vb.map, -1, -1, 0, 0, 0.5f, 1, 0, 0, 1);
    rectangle((float *)vb.map + 42, 0, -1, 1, 0, 0.5f, 0, 1, 0, 1);
    rectangle((float *)vb.map + 84, -1, 0, 0, 1, 0.5f, 0, 0, 1, 1);
    const uint16_t indices[6] = { 0, 1, 2, 3, 4, 5 };
    memcpy(ib.map, indices, sizeof indices);
    float tint[4] = { 1, 1, 1, 1 };
    memcpy(ubo.map, tint, sizeof tint);
    // two VkDrawIndirectCommand (stride 16), then a VkDrawIndexedIndirectCommand at 32 (vertex offset 12)
    uint32_t *a = (uint32_t *)args.map;
    const uint32_t draws[8] = { 6, 1, 0, 0, 6, 1, 6, 0 };
    memcpy(a, draws, sizeof draws);
    a[8] = 6; a[9] = 1; a[10] = 0; a[11] = 12; a[12] = 0;
    VkDescriptorPool dpool;
    VkDescriptorSet set = uniform_set(&p, &dpool, &ubo);
    VkCommandBuffer cb = begin();
    begin_pass(cb, &t, 0, 0, 0);
    begin_flat(cb, &t, &p, set, &vb);
    vkCmdDrawIndirect(cb, args.buffer, 0, 2, 16);
    vkCmdBindIndexBuffer(cb, ib.buffer, 0, VK_INDEX_TYPE_UINT16);
    vkCmdDrawIndexedIndirect(cb, args.buffer, 32, 1, 20);
    vkCmdEndRenderPass(cb);
    CHECK(run(cb));
    CHECK(read_target(&t, &out));
    EXPECT(pixel_is(&out, 16, 16, 255, 0, 0, 0), "the first indirect draw");
    EXPECT(pixel_is(&out, 48, 16, 0, 255, 0, 0), "the second one");
    EXPECT(pixel_is(&out, 16, 48, 0, 0, 255, 0), "the indexed one");
    EXPECT(pixel_is(&out, 48, 48, 0, 0, 0, 0), "nothing else");
    vkDestroyDescriptorPool(device, dpool, 0);
    pipeline_free(&p);
    target_free(&t);
    buffer_free(&vb); buffer_free(&ubo); buffer_free(&ib); buffer_free(&args); buffer_free(&out);
    return 0;
}

static void mip_layout(VkCommandBuffer cb, VkImage image, uint32_t mip, VkImageLayout from, VkImageLayout to)
{
    VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER, .srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT, .oldLayout = from, .newLayout = to,
        .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED, .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED, .image = image,
        .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, mip, 1, 0, 1 } };
    vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, 0, 0, 0, 1, &b);
}

/** a mip chain made by linear blits, mip by mip (as vkcube and most engines make theirs) */
static int test_mipmaps(void)
{
    Image img = image(VK_FORMAT_R8G8B8A8_UNORM, 8, 8, 4, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT);
    Buffer texels = buffer(8 * 8 * 4, 1), out = buffer(4 * 4 * 4, 1);
    // left half red, right half blue
    for(int y = 0; y < 8; y++)
        for(int x = 0; x < 8; x++)
        {
            uint8_t *t = texels.map + (y * 8 + x) * 4;
            t[0] = x < 4 ? 255 : 0; t[1] = 0; t[2] = x < 4 ? 0 : 255; t[3] = 255;
        }
    VkCommandBuffer cb = begin();
    layout(cb, img.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL);
    VkBufferImageCopy copy = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { 8, 8, 1 } };
    vkCmdCopyBufferToImage(cb, texels.buffer, img.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &copy);
    for(uint32_t mip = 1; mip < 4; mip++)
    {
        mip_layout(cb, img.image, mip - 1, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
        int32_t from = 8 >> (mip - 1), to = 8 >> mip;
        VkImageBlit blit = { .srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, mip - 1, 0, 1 }, .srcOffsets = { { 0, 0, 0 }, { from, from, 1 } },
            .dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, mip, 0, 1 }, .dstOffsets = { { 0, 0, 0 }, { to, to, 1 } } };
        vkCmdBlitImage(cb, img.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, img.image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &blit, VK_FILTER_LINEAR);
    }
    mip_layout(cb, img.image, 3, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
    VkBufferImageCopy back[2] = {
        { .bufferOffset = 0, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 1, 0, 1 }, .imageExtent = { 4, 4, 1 } },
        { .bufferOffset = 0, .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 3, 0, 1 }, .imageExtent = { 1, 1, 1 } },
    };
    vkCmdCopyImageToBuffer(cb, img.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out.buffer, 1, &back[0]);
    CHECK(run(cb));
    const uint8_t *m1 = out.map;
    EXPECT(near(m1[0], 255, 1) && near(m1[2], 0, 1) && near(m1[12 + 2], 255, 1), "mip 1: still red and blue halves");
    cb = begin();
    vkCmdCopyImageToBuffer(cb, img.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out.buffer, 1, &back[1]);
    CHECK(run(cb));
    printf("VKTEST mipmaps: mip 3 %d,%d,%d,%d\n", out.map[0], out.map[1], out.map[2], out.map[3]);
    EXPECT(near(out.map[0], 128, 2) && near(out.map[2], 128, 2) && out.map[3] == 255, "mip 3 (1x1): the average, purple");
    image_free(&img);
    buffer_free(&texels); buffer_free(&out);
    return 0;
}

/** a compute shader's imageStore into a storage image */
static int test_storage_image(void)
{
    Image img = image(VK_FORMAT_R8G8B8A8_UNORM, 16, 16, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_STORAGE_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT);
    VkImageView view = view_of(&img, VK_IMAGE_ASPECT_COLOR_BIT);
    Buffer out = buffer(16 * 16 * 4, 1);
    VkDescriptorSetLayoutBinding binding = { 0, VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1, VK_SHADER_STAGE_COMPUTE_BIT, 0 };
    VkDescriptorSetLayoutCreateInfo set_info = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 1, .pBindings = &binding };
    VkDescriptorSetLayout set_layout;
    vkCreateDescriptorSetLayout(device, &set_info, 0, &set_layout);
    VkPipelineLayoutCreateInfo layout_info = { .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &set_layout };
    VkPipelineLayout pipeline_layout;
    vkCreatePipelineLayout(device, &layout_info, 0, &pipeline_layout);
    VkShaderModule cs = shader(SPV_store_comp, sizeof SPV_store_comp);
    VkComputePipelineCreateInfo info = { .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT, .module = cs, .pName = "main" },
        .layout = pipeline_layout };
    VkPipeline pipeline;
    CHECK(vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &info, 0, &pipeline));
    VkDescriptorPoolSize size = { VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, 1 };
    VkDescriptorPoolCreateInfo pool_info = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1, .poolSizeCount = 1, .pPoolSizes = &size };
    VkDescriptorPool dpool;
    vkCreateDescriptorPool(device, &pool_info, 0, &dpool);
    VkDescriptorSetAllocateInfo alloc = { .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dpool, .descriptorSetCount = 1, .pSetLayouts = &set_layout };
    VkDescriptorSet set;
    vkAllocateDescriptorSets(device, &alloc, &set);
    VkDescriptorImageInfo image_info = { .imageView = view, .imageLayout = VK_IMAGE_LAYOUT_GENERAL };
    VkWriteDescriptorSet write = { .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE, .pImageInfo = &image_info };
    vkUpdateDescriptorSets(device, 1, &write, 0, 0);
    VkCommandBuffer cb = begin();
    layout(cb, img.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL);
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline_layout, 0, 1, &set, 0, 0);
    vkCmdDispatch(cb, 2, 2, 1);
    barrier(cb);
    VkBufferImageCopy copy = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { 16, 16, 1 } };
    vkCmdCopyImageToBuffer(cb, img.image, VK_IMAGE_LAYOUT_GENERAL, out.buffer, 1, &copy);
    CHECK(run(cb));
    const uint8_t *px = out.map + (5 * 16 + 10) * 4;
    printf("VKTEST storage-image: (10, 5) %d,%d,%d,%d\n", px[0], px[1], px[2], px[3]);
    EXPECT(near(px[0], 170, 1) && near(px[1], 85, 1) && near(px[2], 128, 1) && px[3] == 255, "the stored color of (10, 5)");
    vkDestroyPipeline(device, pipeline, 0);
    vkDestroyDescriptorPool(device, dpool, 0);
    vkDestroyPipelineLayout(device, pipeline_layout, 0);
    vkDestroyDescriptorSetLayout(device, set_layout, 0);
    vkDestroyShaderModule(device, cs, 0);
    vkDestroyImageView(device, view, 0);
    image_free(&img);
    buffer_free(&out);
    return 0;
}


/** VK_KHR_dynamic_rendering: a clear and a draw into an image view, no render pass object */
static int test_dynamic_rendering(void)
{
    if(!dynamic_rendering) { EXPECT(0, "VK_KHR_dynamic_rendering is not offered"); return 0; }
    PFN_vkCmdBeginRenderingKHR begin_rendering = (PFN_vkCmdBeginRenderingKHR)vkGetDeviceProcAddr(device, "vkCmdBeginRenderingKHR");
    PFN_vkCmdEndRenderingKHR end_rendering = (PFN_vkCmdEndRenderingKHR)vkGetDeviceProcAddr(device, "vkCmdEndRenderingKHR");
    if(!begin_rendering || !end_rendering) { EXPECT(0, "no vkCmdBeginRenderingKHR"); return 0; }
    Image color = image(VK_FORMAT_R8G8B8A8_UNORM, SIZE, SIZE, 1, VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT);
    VkImageView view = view_of(&color, VK_IMAGE_ASPECT_COLOR_BIT);
    Target t = { .samples = 1 };
    VkFormat format = VK_FORMAT_R8G8B8A8_UNORM;
    VkPipelineRenderingCreateInfo rendering = { .sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO, .colorAttachmentCount = 1,
        .pColorAttachmentFormats = &format };
    flat_next = &rendering;
    Pipeline p = flat_pipeline(&t, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST, 0, 0);
    flat_next = 0;
    Buffer vb = buffer(6 * 28, 1), ubo = buffer(256, 1), out = buffer(SIZE * SIZE * 4, 1);
    rectangle((float *)vb.map, -1, -1, 0, 0, 0.5f, 1, 1, 0, 1);
    float tint[4] = { 1, 1, 1, 1 };
    memcpy(ubo.map, tint, sizeof tint);
    VkDescriptorPool dpool;
    VkDescriptorSet set = uniform_set(&p, &dpool, &ubo);
    VkCommandBuffer cb = begin();
    layout(cb, color.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL);
    VkRenderingAttachmentInfo attachment = { .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO, .imageView = view,
        .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR, .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
        .clearValue = { .color = { .float32 = { 0, 0, 1, 1 } } } };
    VkRenderingInfo info = { .sType = VK_STRUCTURE_TYPE_RENDERING_INFO, .renderArea = { { 0, 0 }, { SIZE, SIZE } }, .layerCount = 1,
        .colorAttachmentCount = 1, .pColorAttachments = &attachment };
    begin_rendering(cb, &info);
    begin_flat(cb, &t, &p, set, &vb);
    vkCmdDraw(cb, 6, 1, 0, 0);
    end_rendering(cb);
    layout(cb, color.image, VK_IMAGE_ASPECT_COLOR_BIT, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);
    VkBufferImageCopy copy = { .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, .imageExtent = { SIZE, SIZE, 1 } };
    vkCmdCopyImageToBuffer(cb, color.image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, out.buffer, 1, &copy);
    CHECK(run(cb));
    EXPECT(pixel_is(&out, 16, 16, 255, 255, 0, 0), "the rectangle");
    EXPECT(pixel_is(&out, 48, 48, 0, 0, 255, 0), "the clear");
    vkDestroyDescriptorPool(device, dpool, 0);
    pipeline_free(&p);
    vkDestroyImageView(device, view, 0);
    image_free(&color);
    buffer_free(&vb); buffer_free(&ubo); buffer_free(&out);
    return 0;
}

static const struct { const char *name; int (*run)(void); } TESTS[] = {
    { "buffer-copy", test_buffer_copy },
    { "fill-update", test_fill_update },
    { "image-roundtrip", test_image_roundtrip },
    { "image-mip-region", test_image_mip_region },
    { "clear-color", test_clear_color },
    { "clear-depth", test_clear_depth },
    { "copy-image", test_copy_image },
    { "blit", test_blit },
    { "resolve", test_resolve },
    { "fence", test_fence },
    { "timeline", test_timeline },
    { "semaphores", test_semaphores },
    { "events", test_events },
    { "remap", test_remap },
    { "draw", test_draw },
    { "depth", test_depth },
    { "blend-msaa", test_blend_msaa },
    { "texture", test_texture },
    { "compute", test_compute },
    { "clear-attachments", test_clear_attachments },
    { "vkcube-shaders", test_vkcube_shaders },
    { "queries", test_queries },
    { "secondary", test_secondary },
    { "indirect", test_indirect },
    { "mipmaps", test_mipmaps },
    { "storage-image", test_storage_image },
    { "dynamic-rendering", test_dynamic_rendering },
};

int main(int argc, char **argv, char **envp)
{
    // ("list": the tests' names, one a line, without a device)
    if(argc == 2 && !strcmp(argv[1], "list"))
    {
        for(unsigned i = 0; i < sizeof TESTS / sizeof TESTS[0]; i++) printf("%s\n", TESTS[i].name);
        return 0;
    }
    if(setup()) return 1;
    for(unsigned i = 0; i < sizeof TESTS / sizeof TESTS[0]; i++)
    {
        int wanted = argc < 2;
        for(int j = 1; j < argc; j++) wanted |= !strcmp(argv[j], TESTS[i].name);
        if(!wanted) continue;
        failure[0] = 0;
        printf("VKTEST start %s\n", TESTS[i].name);
        fflush(0);
        int error = TESTS[i].run();
        if(error || failure[0])
        {
            failures++;
            printf("VKTEST %s FAIL %s\n", TESTS[i].name, error ? "(an API call failed)" : failure);
        }
        else printf("VKTEST %s ok\n", TESTS[i].name);
        fflush(0);
    }
    printf("VKTEST done %d failures\n", failures);
    vkDestroyCommandPool(device, pool, 0);
    vkDestroyDevice(device, 0);
    vkDestroyInstance(instance, 0);
    return failures != 0;
}
