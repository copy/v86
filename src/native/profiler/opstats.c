#include <stdbool.h>
#include <stdint.h>

#include "../codegen/codegen.h"

#if ENABLE_PROFILER_OPSTATS

static struct {
    uint32_t opcode[0x100];
    uint32_t opcode_0f[0x100];
} opstats_buffer = {
    .opcode = { 0 },
    .opcode_0f = { 0 },
};

void gen_opstats(uint32_t instruction)
{
    bool is_0f = false;

    for(int32_t i = 0; i < 4; i++)
    {
        int32_t opcode = instruction & 0xFF;
        instruction >>= 8;

        // TODO:
        // - If instruction depends on middle bits of modrm_byte, split
        // - Split depending on memory or register variant
        // - If the instruction uses 4 or more prefixes, only the prefixes will be counted

        if(is_0f)
        {
            gen_increment_mem32((int32_t)&opstats_buffer.opcode_0f[opcode]);
            break;
        }
        else
        {
            gen_increment_mem32((int32_t)&opstats_buffer.opcode[opcode]);

            if(opcode == 0x0F)
            {
                is_0f = true;
            }
            else if(opcode == 0x26 || opcode == 0x2E || opcode == 0x36 || opcode == 0x3E ||
                    opcode == 0x64 || opcode == 0x65 || opcode == 0x66 || opcode == 0x67 ||
                    opcode == 0xF0 || opcode == 0xF2 || opcode == 0xF3)
            {
                // prefix
            }
            else
            {
                break;
            }
        }
    }
}

int32_t get_opstats_buffer(int32_t index)
{
    assert(index >= 0 && index < 0x200);

    if(index < 0x100)
    {
        return opstats_buffer.opcode[index];
    }
    else
    {
        return opstats_buffer.opcode_0f[index - 0x100];
    }
}

#else

void gen_opstats(uint32_t instruction)
{
}

int32_t get_opstats_buffer(int32_t index)
{
    assert(index >= 0 && index < 0x200);

    return 0;
}

#endif
