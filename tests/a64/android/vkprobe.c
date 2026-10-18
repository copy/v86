// The Vulkan devices the system loader finds (P11.4 V1): instance, physical
// devices and their properties, on stdout.
#include <stdio.h>
#include <vulkan/vulkan.h>

int main(void)
{
    VkApplicationInfo app = { VK_STRUCTURE_TYPE_APPLICATION_INFO, NULL, "vkprobe", 1, NULL, 0, VK_API_VERSION_1_1 };
    VkInstanceCreateInfo info = { VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, NULL, 0, &app, 0, NULL, 0, NULL };
    VkInstance instance;
    VkResult result = vkCreateInstance(&info, NULL, &instance);
    printf("vkCreateInstance: %d\n", result);
    if(result != VK_SUCCESS) return 1;
    uint32_t count = 0;
    result = vkEnumeratePhysicalDevices(instance, &count, NULL);
    printf("vkEnumeratePhysicalDevices: %d, %u devices\n", result, count);
    VkPhysicalDevice devices[8];
    if(count > 8) count = 8;
    vkEnumeratePhysicalDevices(instance, &count, devices);
    for(uint32_t i = 0; i < count; i++)
    {
        VkPhysicalDeviceProperties p;
        vkGetPhysicalDeviceProperties(devices[i], &p);
        printf("device %u: %s, Vulkan %u.%u.%u, driver 0x%x, vendor 0x%x, device 0x%x, type %d\n", i, p.deviceName,
            VK_VERSION_MAJOR(p.apiVersion), VK_VERSION_MINOR(p.apiVersion), VK_VERSION_PATCH(p.apiVersion),
            p.driverVersion, p.vendorID, p.deviceID, p.deviceType);
    }
    vkDestroyInstance(instance, NULL);
    return 0;
}
