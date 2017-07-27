#include <stdint.h>
#include <math.h>
#include <assert.h>
#include <stdbool.h>

#include <stdio.h>

#include "const.h"
#include "global_pointers.h"

static int32_t get_stack_pointer(int32_t);
static void adjust_stack_reg(int32_t);
void branch_taken();
void branch_not_taken();
void writable_or_pagefault(int32_t, int32_t);


int32_t getcf()
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

int32_t getpf()
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

int32_t getaf()
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

int32_t getzf()
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

int32_t getsf()
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

int32_t getof()
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

int32_t test_o() { return getof(); }
int32_t test_b() { return getcf(); }
int32_t test_z() { return getzf(); }
int32_t test_s() { return getsf(); }
int32_t test_p() { return getpf(); }
int32_t test_be() { return getcf() || getzf(); }
int32_t test_l() { return !getsf() != !getof(); }
int32_t test_le() { return getzf() || !getsf() != !getof(); }

void jmp_rel16(int32_t rel16)
{
    int32_t cs_offset = get_seg(CS);

    // limit ip to 16 bit
    *instruction_pointer = cs_offset + ((*instruction_pointer - cs_offset + rel16) & 0xFFFF);
    branch_taken();
}

void jmpcc8(bool condition)
{
    int32_t imm8 = read_imm8s();
    if(condition)
    {
        *instruction_pointer += imm8;
        branch_taken();
    }
    else
    {
        branch_not_taken();
    }
}

void jmpcc16(bool condition)
{
    int32_t imm16 = read_imm16();

    if(condition)
    {
        jmp_rel16(imm16);
        branch_taken();
    }
    else
    {
        branch_not_taken();
    }
}

void jmpcc32(bool condition)
{
    int32_t op = read_imm32s();

    if(condition)
    {
        *instruction_pointer += op;
        branch_taken();
    }
    else
    {
        branch_not_taken();
    }
}

static void cmovcc16(bool condition)
{
    int32_t data = read_e16();
    if(condition)
    {
        write_g16(data);
    }
}

static void cmovcc32(bool condition)
{
    int32_t data = read_e32s();
    if(condition)
    {
        write_g32(data);
    }
}

static int32_t get_stack_pointer(int32_t offset)
{
    if(*stack_size_32)
    {
        return get_seg(SS) + reg32s[ESP] + offset;
    }
    else
    {
        return get_seg(SS) + (reg16[SP] + offset & 0xFFFF);
    }
}

static void adjust_stack_reg(int32_t adjustment)
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

void push16(int32_t imm16)
{
    if(*stack_size_32)
    {
        int32_t sp = get_seg(SS) + reg32s[ESP] - 2;
        safe_write16(sp, imm16);
        reg32s[ESP] += -2;
    }
    else
    {
        int32_t sp = get_seg(SS) + (reg16[SP] - 2 & 0xFFFF);
        safe_write16(sp, imm16);
        reg16[SP] += -2;
    }
}

void push32(int32_t imm32)
{
    if(*stack_size_32)
    {
        int32_t sp = get_seg(SS) + reg32s[ESP] - 4;
        safe_write32(sp, imm32);
        reg32s[ESP] += -4;
    }
    else
    {
        int32_t sp = get_seg(SS) + (reg16[SP] - 4 & 0xFFFF);
        safe_write32(sp, imm32);
        reg16[SP] += -4;
    }
}

int32_t pop16()
{
    int32_t sp = get_seg(SS) + get_stack_reg();
    int32_t result = safe_read16(sp);

    adjust_stack_reg(2);
    return result;
}

int32_t pop32s()
{
    if(*stack_size_32)
    {
        int32_t sp = get_seg(SS) + reg32s[ESP];
        int32_t result = safe_read32s(sp);
        reg32s[ESP] += 4;
        return result;
    }
    else
    {
        int32_t sp = get_seg(SS) + reg16[SP];
        int32_t result = safe_read32s(sp);
        reg16[SP] += 4;
        return result;
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

void setcc(bool condition) {
	set_e8(condition);
}
