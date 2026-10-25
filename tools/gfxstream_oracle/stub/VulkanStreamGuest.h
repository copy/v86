// The oracle's VulkanStreamGuest (tools/gfxstream_oracle): the guest's stream
// over a byte buffer, with the features of a virtio-gpu guest (all four)
#pragma once

#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

#include <vector>

#include "Stream.h"
#include "VulkanHandleMapping.h"
#include "goldfish_vk_private_defs.h"

namespace gfxstream {
namespace vk {

class VulkanStreamGuest : public gfxstream::aemu::Stream {
   public:
    std::vector<uint8_t> out;
    const uint8_t* in = nullptr;
    size_t in_size = 0, in_pos = 0;

    void alloc(void** ptrAddr, size_t bytes) { *ptrAddr = calloc(1, bytes ? bytes : 1); }
    void loadStringInPlace(char** forOutput)
    {
        uint32_t len = getBe32();
        alloc((void**)forOutput, len + 1);
        if (len) read(*forOutput, len);
    }
    void loadStringArrayInPlace(char*** forOutput)
    {
        uint32_t count = getBe32();
        alloc((void**)forOutput, count * sizeof(char*));
        for (uint32_t i = 0; i < count; i++) loadStringInPlace(&(*forOutput)[i]);
    }
    ssize_t read(void* buffer, size_t size) override
    {
        if (in_pos + size > in_size) {
            fprintf(stderr, "oracle: read past the end (%zu + %zu > %zu)\n", in_pos, size, in_size);
            exit(1);
        }
        memcpy(buffer, in + in_pos, size);
        in_pos += size;
        return size;
    }
    ssize_t write(const void* buffer, size_t size) override
    {
        out.insert(out.end(), (const uint8_t*)buffer, (const uint8_t*)buffer + size);
        return size;
    }
    VulkanHandleMapping* handleMapping() { return &mMapping; }
    uint32_t getFeatureBits() const { return 15; }

   private:
    DefaultHandleMapping mMapping;
};

}  // namespace vk
}  // namespace gfxstream
