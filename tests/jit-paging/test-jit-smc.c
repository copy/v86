#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <sys/mman.h>
#include <sys/user.h>
#include <unistd.h>

static volatile uint32_t counter = 0;
static volatile uint32_t do_write = 0;

int main(void)
{
    uint8_t *const base = mmap(NULL, 2 * PAGE_SIZE,
            PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if(base == MAP_FAILED)
    {
        printf("*** FATAL ERROR: mmap\n");
        return 1;
    }

    memset(base, 0x90, 2 * PAGE_SIZE);

    const uint32_t entry_off = 0xFC0; // entry near (but not at) the end of page0
    const uint32_t target_off = 0x1010; // 0x10 bytes into page1
    uint8_t *const entry = base + entry_off;
    uint8_t *const target = base + target_off;
    uint8_t *const patch_imm = target + 1; // the imm8 of "mov al, imm8"

    // --- page0 ---
    uint8_t *p = entry;
    // cmp dword [do_write], 0
    *p++ = 0x83; *p++ = 0x3D; *(uint32_t *)p = (uint32_t)(uintptr_t)&do_write; p += 4; *p++ = 0x00;
    // je skip_store (over the three store instructions: 6 + 5 + 5 = 16 bytes)
    *p++ = 0x74; *p++ = 0x10;
    // inc dword [counter]
    *p++ = 0xFF; *p++ = 0x05; *(uint32_t *)p = (uint32_t)(uintptr_t)&counter; p += 4;
    // mov eax, [counter]
    *p++ = 0xA1; *(uint32_t *)p = (uint32_t)(uintptr_t)&counter; p += 4;
    // mov [patch_imm], al
    *p++ = 0xA2; *(uint32_t *)p = (uint32_t)(uintptr_t)patch_imm; p += 4;
    // skip_store: jmp target
    *p++ = 0xE9;
    int32_t rel = (int32_t)((intptr_t)target - (intptr_t)(p + 4));
    *(int32_t *)p = rel; p += 4;

    // --- page1 ---
    uint8_t *q = target;
    // mov al, imm8 (imm8 patched by page0)
    *q++ = 0xB0; *q++ = 0x00;
    // movzx eax, al
    *q++ = 0x0F; *q++ = 0xB6; *q++ = 0xC0;
    // ret
    *q++ = 0xC3;

    int (*f)(void) = (int (*)(void))entry;

    const int rounds = 40;
    const int warmup = 300000;
    int failures = 0;
    for(int round = 0; round < rounds; round++)
    {
        do_write = 0;
        *patch_imm = 0;
        for(int i = 0; i < warmup; i++)
        {
            int got = f();
            if(got != 0)
            {
                printf("*** FATAL ERROR: warmup got %d, expected 0\n", got);
                return 1;
            }
        }

        do_write = 1;
        uint32_t expected = (counter + 1) & 0xFF;
        int got = f();
        do_write = 0;
        if((uint32_t)got != expected)
        {
            failures++;
            if(failures <= 5)
            {
                printf("stale result in round %d: got=%d expected=%u\n", round, got, expected);
            }
        }
    }

    if(failures == 0)
    {
        printf("test_smc_multipage passed\n");
    }
    else
    {
        printf("test_smc_multipage FAILED: %d/%d stale results\n", failures, rounds);
    }

    return 0;
}
