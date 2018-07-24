#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "const.h"
#include "cpu.h"
#include "fpu.h"
#include "global_pointers.h"
#include "js_imports.h"
#include "log.h"
#include "misc_instr.h"

bool getcf()
{
    if(*flags_changed & 1)
    {
        return (*last_op1 ^ (*last_op1 ^ *last_op2) & (*last_op2 ^ *last_add_result)) >> *last_op_size & 1;
    }
    else
    {
        return *flags & 1;
    }
}

bool getpf()
{
    if(*flags_changed & FLAG_PARITY)
    {
        // inverted lookup table
        return 0x9669 << 2 >> ((*last_result ^ *last_result >> 4) & 0xF) & FLAG_PARITY;
    }
    else
    {
        return *flags & FLAG_PARITY;
    }
}

bool getaf()
{
    if(*flags_changed & FLAG_ADJUST)
    {
        return (*last_op1 ^ *last_op2 ^ *last_add_result) & FLAG_ADJUST;
    }
    else
    {
        return *flags & FLAG_ADJUST;
    }
}

bool getzf()
{
    if(*flags_changed & FLAG_ZERO)
    {
        return (~*last_result & *last_result - 1) >> *last_op_size & 1;
    }
    else
    {
        return *flags & FLAG_ZERO;
    }
}

bool getsf()
{
    if(*flags_changed & FLAG_SIGN)
    {
        return *last_result >> *last_op_size & 1;
    }
    else
    {
        return *flags & FLAG_SIGN;
    }
}

bool getof()
{
    if(*flags_changed & FLAG_OVERFLOW)
    {
        return ((*last_op1 ^ *last_add_result) & (*last_op2 ^ *last_add_result)) >> *last_op_size & 1;
    }
    else
    {
        return *flags & FLAG_OVERFLOW;
    }
}

bool test_o() { return getof(); }
bool test_b() { return getcf(); }
bool test_z() { return getzf(); }
bool test_s() { return getsf(); }
bool test_p() { return getpf(); }
bool test_be() { return getcf() || getzf(); }
bool test_l() { return getsf() != getof(); }
bool test_le() { return getzf() || getsf() != getof(); }

bool test_no() { return !test_o(); }
bool test_nb() { return !test_b(); }
bool test_nz() { return !test_z(); }
bool test_ns() { return !test_s(); }
bool test_np() { return !test_p(); }
bool test_nbe() { return !test_be(); }
bool test_nl() { return !test_l(); }
bool test_nle() { return !test_le(); }

void jmp_rel16(int32_t rel16)
{
    int32_t cs_offset = get_seg_cs();

    // limit ip to 16 bit
    *instruction_pointer = cs_offset + ((*instruction_pointer - cs_offset + rel16) & 0xFFFF);
}

void jmpcc16(bool condition, int32_t imm16)
{
    if(condition)
    {
        jmp_rel16(imm16);
    }
}

void jmpcc32(bool condition, int32_t imm32)
{
    if(condition)
    {
        *instruction_pointer += imm32;
    }
}

void loopne16(int32_t imm8s) { jmpcc16(decr_ecx_asize() && !getzf(), imm8s); }
void loope16(int32_t imm8s) { jmpcc16(decr_ecx_asize() && getzf(), imm8s); }
void loop16(int32_t imm8s) { jmpcc16(decr_ecx_asize(), imm8s); }
void jcxz16(int32_t imm8s) { jmpcc16(get_reg_asize(ECX) == 0, imm8s); }

void loopne32(int32_t imm8s) { jmpcc32(decr_ecx_asize() && !getzf(), imm8s); }
void loope32(int32_t imm8s) { jmpcc32(decr_ecx_asize() && getzf(), imm8s); }
void loop32(int32_t imm8s) { jmpcc32(decr_ecx_asize(), imm8s); }
void jcxz32(int32_t imm8s) { jmpcc32(get_reg_asize(ECX) == 0, imm8s); }

void cmovcc16(bool condition, int32_t value, int32_t r)
{
    if(condition)
    {
        write_reg16(r, value);
    }
}

void cmovcc32(bool condition, int32_t value, int32_t r)
{
    if(condition)
    {
        write_reg32(r, value);
    }
}

int32_t get_stack_pointer(int32_t offset)
{
    if(*stack_size_32)
    {
        return get_seg_ss() + reg32s[ESP] + offset;
    }
    else
    {
        return get_seg_ss() + (reg16[SP] + offset & 0xFFFF);
    }
}

void adjust_stack_reg(int32_t adjustment)
{
    if(*stack_size_32)
    {
        reg32s[ESP] += adjustment;
    }
    else
    {
        reg16[SP] += adjustment;
    }
}

__attribute__((always_inline))
void push16_ss16(int32_t imm16)
{
    int32_t sp = get_seg_ss() + (reg16[SP] - 2 & 0xFFFF);
    safe_write16(sp, imm16);
    reg16[SP] += -2;
}

__attribute__((always_inline))
void push16_ss32(int32_t imm16)
{
    int32_t sp = get_seg_ss() + reg32s[ESP] - 2;
    safe_write16(sp, imm16);
    reg32s[ESP] += -2;
}

void push16_ss16_mem(int32_t addr) { push16_ss16(safe_read16(addr)); }
void push16_ss32_mem(int32_t addr) { push16_ss32(safe_read16(addr)); }

void push16(int32_t imm16)
{
    if(*stack_size_32)
    {
        push16_ss32(imm16);
    }
    else
    {
        push16_ss16(imm16);
    }
}

__attribute__((always_inline))
void push32_ss16(int32_t imm32)
{
    int32_t new_sp = reg16[SP] - 4 & 0xFFFF;
    safe_write32(get_seg_ss() + new_sp, imm32);
    reg16[SP] = new_sp;
}

__attribute__((always_inline))
void push32_ss32(int32_t imm32)
{
    int32_t new_esp = reg32s[ESP] - 4;
    safe_write32(get_seg_ss() + new_esp, imm32);
    reg32s[ESP] = new_esp;
}

void push32_ss16_mem(int32_t addr) { push32_ss16(safe_read32s(addr)); }
void push32_ss32_mem(int32_t addr) { push32_ss32(safe_read32s(addr)); }

__attribute__((always_inline))
void push32(int32_t imm32)
{
    if(*stack_size_32)
    {
        push32_ss32(imm32);
    }
    else
    {
        push32_ss16(imm32);
    }
}

__attribute__((always_inline))
int32_t pop16_ss16()
{
    int32_t sp = get_seg_ss() + reg16[SP];
    int32_t result = safe_read16(sp);

    reg16[SP] += 2;
    return result;
}

__attribute__((always_inline))
int32_t pop16_ss32()
{
    int32_t esp = get_seg_ss() + reg32s[ESP];
    int32_t result = safe_read16(esp);

    reg32s[ESP] += 2;
    return result;
}

__attribute__((always_inline))
int32_t pop16()
{
    if(*stack_size_32)
    {
        return pop16_ss32();
    }
    else
    {
        return pop16_ss16();
    }
}

__attribute__((always_inline))
int32_t pop32s_ss16()
{
    int32_t sp = reg16[SP];
    int32_t result = safe_read32s(get_seg_ss() + sp);
    reg16[SP] = sp + 4;
    return result;
}

__attribute__((always_inline))
int32_t pop32s_ss32()
{
    int32_t esp = reg32s[ESP];
    int32_t result = safe_read32s(get_seg_ss() + esp);
    reg32s[ESP] = esp + 4;
    return result;
}

__attribute__((always_inline))
int32_t pop32s()
{
    if(*stack_size_32)
    {
        return pop32s_ss32();
    }
    else
    {
        return pop32s_ss16();
    }
}

void pusha16()
{
    uint16_t temp = reg16[SP];

    // make sure we don't get a pagefault after having
    // pushed several registers already
    writable_or_pagefault(get_stack_pointer(-16), 16);

    push16(reg16[AX]);
    push16(reg16[CX]);
    push16(reg16[DX]);
    push16(reg16[BX]);
    push16(temp);
    push16(reg16[BP]);
    push16(reg16[SI]);
    push16(reg16[DI]);
}

void pusha32()
{
    int32_t temp = reg32s[ESP];

    writable_or_pagefault(get_stack_pointer(-32), 32);

    push32(reg32s[EAX]);
    push32(reg32s[ECX]);
    push32(reg32s[EDX]);
    push32(reg32s[EBX]);
    push32(temp);
    push32(reg32s[EBP]);
    push32(reg32s[ESI]);
    push32(reg32s[EDI]);
}

void setcc_reg(bool condition, int32_t r) {
    write_reg8(r, condition ? 1 : 0);
}

void setcc_mem(bool condition, int32_t addr) {
    safe_write8(addr, condition ? 1 : 0);
}

void fxsave(uint32_t addr)
{
    writable_or_pagefault(addr, 512);

    safe_write16(addr +  0, *fpu_control_word);
    safe_write16(addr +  2, fpu_load_status_word());
    safe_write8( addr +  4, ~*fpu_stack_empty & 0xFF);
    safe_write16(addr +  6, *fpu_opcode);
    safe_write32(addr +  8, *fpu_ip);
    safe_write16(addr + 12, *fpu_ip_selector);
    safe_write32(addr + 16, *fpu_dp);
    safe_write16(addr + 20, *fpu_dp_selector);

    safe_write32(addr + 24, *mxcsr);
    safe_write32(addr + 28, MXCSR_MASK);

    for(int32_t i = 0; i < 8; i++)
    {
        fpu_store_m80(addr + 32 + (i << 4), fpu_st[*fpu_stack_ptr + i & 7]);
    }

    // If the OSFXSR bit in control register CR4 is not set, the FXSAVE
    // instruction may not save these registers. This behavior is
    // implementation dependent.
    for(int32_t i = 0; i < 8; i++)
    {
        safe_write128(addr + 160 + (i << 4), reg_xmm[i]);
    }
}

void fxrstor(uint32_t addr)
{
    translate_address_read(addr);
    translate_address_read(addr + 511);

    int32_t new_mxcsr = safe_read32s(addr + 24);

    if(new_mxcsr & ~MXCSR_MASK)
    {
        dbg_log("#gp Invalid mxcsr bits");
        trigger_gp_non_raising(0);
        return;
    }

    *fpu_control_word = safe_read16(addr + 0);
    fpu_set_status_word(safe_read16(addr + 2));
    *fpu_stack_empty = ~safe_read8(addr + 4) & 0xFF;
    *fpu_opcode = safe_read16(addr + 6);
    *fpu_ip = safe_read32s(addr + 8);
    *fpu_ip = safe_read16(addr + 12);
    *fpu_dp = safe_read32s(addr + 16);
    *fpu_dp_selector = safe_read16(addr + 20);

    *mxcsr = new_mxcsr;

    for(int32_t i = 0; i < 8; i++)
    {
        fpu_st[*fpu_stack_ptr + i & 7] = fpu_load_m80(addr + 32 + (i << 4));
    }

    for(int32_t i = 0; i < 8; i++)
    {
        reg_xmm[i].u32[0] = safe_read32s(addr + 160 + (i << 4) +  0);
        reg_xmm[i].u32[1] = safe_read32s(addr + 160 + (i << 4) +  4);
        reg_xmm[i].u32[2] = safe_read32s(addr + 160 + (i << 4) +  8);
        reg_xmm[i].u32[3] = safe_read32s(addr + 160 + (i << 4) + 12);
    }
}

int32_t xchg8(int32_t data, int32_t r8)
{
    int32_t tmp = reg8[r8];
    reg8[r8] = data;
    return tmp;
}

int32_t xchg16(int32_t data, int32_t r16)
{
    int32_t tmp = reg16[r16];
    reg16[r16] = data;
    return tmp;
}

void xchg16r(int32_t r16)
{
    int32_t tmp = reg16[AX];
    reg16[AX] = reg16[r16];
    reg16[r16] = tmp;
}

int32_t xchg32(int32_t data, int32_t r32)
{
    int32_t tmp = reg32s[r32];
    reg32s[r32] = data;
    return tmp;
}

void xchg32r(int32_t r32)
{
    int32_t tmp = reg32s[EAX];
    reg32s[EAX] = reg32s[r32];
    reg32s[r32] = tmp;
}
