// The oracle's Resources.h: a handle's host value is the handle
#pragma once

#include <vulkan/vulkan.h>

#include "VulkanHandles.h"

#define GOLDFISH_VK_GET_HOST_U64_DECL(type) uint64_t get_host_u64_##type(type);
GOLDFISH_VK_LIST_HANDLE_TYPES(GOLDFISH_VK_GET_HOST_U64_DECL)
