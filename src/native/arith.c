#include <stdint.h>
#include <math.h>
#include <assert.h>
#include <stdbool.h>

#include <stdio.h>

#include "const.h"
#include "global_pointers.h"

int32_t add(int32_t dest_operand, int32_t source_operand, int32_t op_size)
{
    *last_op1 = dest_operand;
    *last_op2 = source_operand;
    int32_t res = dest_operand + source_operand;
    *last_add_result = *last_result = res;

    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;

    return res;
}

int32_t adc(int32_t dest_operand, int32_t source_operand, int32_t op_size)
{
    int32_t cf = getcf();
    *last_op1 = dest_operand;
    *last_op2 = source_operand;

    int32_t res = dest_operand + source_operand + cf;

    *last_add_result = *last_result = res;

    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;

    return res;
}

int32_t sub(int32_t dest_operand, int32_t source_operand, int32_t op_size)
{
    *last_add_result = dest_operand;
    *last_op2 = source_operand;

    int32_t res = dest_operand - source_operand;

    *last_op1 = *last_result = res;

    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;

    return res;
}

int32_t sbb(int32_t dest_operand, int32_t source_operand, int32_t op_size)
{
    int32_t cf = getcf();
    *last_add_result = dest_operand;
    *last_op2 = source_operand;

    int32_t res = dest_operand - source_operand - cf;

    *last_op1 = *last_result = res;

    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL;

    return res;
}

int32_t add8(int32_t x, int32_t y) { return add(x, y, OPSIZE_8); }
int32_t add16(int32_t x, int32_t y) { return add(x, y, OPSIZE_16); }
int32_t add32(int32_t x, int32_t y) { return add(x, y, OPSIZE_32); }

int32_t sub8(int32_t x, int32_t y) { return sub(x, y, OPSIZE_8); }
int32_t sub16(int32_t x, int32_t y) { return sub(x, y, OPSIZE_16); }
int32_t sub32(int32_t x, int32_t y) { return sub(x, y, OPSIZE_32); }

int32_t adc8(int32_t x, int32_t y) { return adc(x, y, OPSIZE_8); }
int32_t adc16(int32_t x, int32_t y) { return adc(x, y, OPSIZE_16); }
int32_t adc32(int32_t x, int32_t y) { return adc(x, y, OPSIZE_32); }

int32_t sbb8(int32_t x, int32_t y) { return sbb(x, y, OPSIZE_8); }
int32_t sbb16(int32_t x, int32_t y) { return sbb(x, y, OPSIZE_16); }
int32_t sbb32(int32_t x, int32_t y) { return sbb(x, y, OPSIZE_32); }

void cmp8(int32_t x, int32_t y) { sub(x, y, OPSIZE_8); }
void cmp16(int32_t x, int32_t y) { sub(x, y, OPSIZE_16); }
void cmp32(int32_t x, int32_t y) { sub(x, y, OPSIZE_32); }

int32_t inc(int32_t dest_operand, int32_t op_size)
{
    *flags = (*flags & ~1) | getcf();
    *last_op1 = dest_operand;
    *last_op2 = 1;

    int32_t res = dest_operand + 1;

    *last_add_result = *last_result = res;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL & ~1;

    return res;
}

int32_t dec(int32_t dest_operand, int32_t op_size)
{
    *flags = (*flags & ~1) | getcf();
    *last_add_result = dest_operand;
    *last_op2 = 1;

    int32_t res = dest_operand - 1;

    *last_op1 = *last_result = res;
    *last_op_size = op_size;
    *flags_changed = FLAGS_ALL & ~1;

    return res;
}

int32_t inc8(int32_t x) { return inc(x, OPSIZE_8); }
int32_t inc16(int32_t x) { return inc(x, OPSIZE_16); }
int32_t inc32(int32_t x) { return inc(x, OPSIZE_32); }

int32_t dec8(int32_t x) { return dec(x, OPSIZE_8); }
int32_t dec16(int32_t x) { return dec(x, OPSIZE_16); }
int32_t dec32(int32_t x) { return dec(x, OPSIZE_32); }

int32_t neg(int32_t dest_operand, int32_t op_size)
{
    int32_t res = -dest_operand;
    *last_op1 = *last_result = res;
    *flags_changed = FLAGS_ALL;
    *last_add_result = 0;
    *last_op2 = dest_operand;
    *last_op_size = op_size;

    return res;
}

int32_t neg8(int32_t x) { return neg(x, OPSIZE_8); }
int32_t neg16(int32_t x) { return neg(x, OPSIZE_16); }
int32_t neg32(int32_t x) { return neg(x, OPSIZE_32); }

void mul8(int32_t source_operand)
{
    int32_t result = source_operand * reg8[AL];

    reg16[AX] = result;
    *last_result = result & 0xFF;
    *last_op_size = OPSIZE_8;

    if(result < 0x100)
    {
        *flags = *flags & ~1 & ~FLAG_OVERFLOW;
    }
    else
    {
        *flags = *flags | 1 | FLAG_OVERFLOW;
    }

    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_OVERFLOW;
}

void imul8(int32_t source_operand)
{
    int32_t result = source_operand * reg8s[AL];

    reg16[AX] = result;
    *last_result = result & 0xFF;
    *last_op_size = OPSIZE_8;

    if(result > 0x7F || result < -0x80)
    {
        *flags = *flags | 1 | FLAG_OVERFLOW;
    }
    else
    {
        *flags = *flags & ~1 & ~FLAG_OVERFLOW;
    }

    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_OVERFLOW;
}

void mul16(uint32_t source_operand)
{
    uint32_t result = source_operand * reg16[AX];
    uint32_t high_result = result >> 16;


    reg16[AX] = result;
    reg16[DX] = high_result;

    *last_result = result & 0xFFFF;
    *last_op_size = OPSIZE_16;

    if(high_result == 0)
    {
        *flags &= ~1 & ~FLAG_OVERFLOW;
    }
    else
    {
        *flags |= *flags | 1 | FLAG_OVERFLOW;
    }
    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_OVERFLOW;
}

void imul16(int32_t source_operand)
{
    int32_t result = source_operand * reg16s[AX];

    reg16[AX] = result;
    reg16[DX] = result >> 16;

    *last_result = result & 0xFFFF;
    *last_op_size = OPSIZE_16;

    if(result > 0x7FFF || result < -0x8000)
    {
        *flags |= 1 | FLAG_OVERFLOW;
    }
    else
    {
        *flags &= ~1 & ~FLAG_OVERFLOW;
    }
    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_OVERFLOW;
}

int32_t imul_reg16(int32_t operand1, int32_t operand2)
{
    assert(operand1 < 0x8000 && operand1 >= -0x8000);
    assert(operand2 < 0x8000 && operand2 >= -0x8000);

    int32_t result = operand1 * operand2;

    *last_result = result & 0xFFFF;
    *last_op_size = OPSIZE_16;

    if(result > 0x7FFF || result < -0x8000)
    {
        *flags |= 1 | FLAG_OVERFLOW;
    }
    else
    {
        *flags &= ~1 & ~FLAG_OVERFLOW;
    }
    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_OVERFLOW;

    return result;
}

void do_mul32(uint32_t a, uint32_t b)
{
    uint32_t a00 = a & 0xFFFF;
    uint32_t a16 = a >> 16;
    uint32_t b00 = b & 0xFFFF;
    int32_t b16 = b >> 16;
    uint32_t low_result = a00 * b00;
    uint32_t mid = (low_result >> 16) + (a16 * b00);
    uint32_t high_result = mid >> 16;
    mid = (mid & 0xFFFF) + (a00 * b16);
    mul32_result[0] = (mid << 16) | low_result & 0xFFFF;
    mul32_result[1] = ((mid >> 16) + (a16 * b16)) + high_result;
}

void do_imul32(int32_t a, int32_t b)
{
    bool is_neg = false;
    if(a < 0) {
        is_neg = true;
        a = -a;
    }
    if(b < 0) {
        is_neg = !is_neg;
        b = -b;
    }
    do_mul32(a, b);
    if(is_neg) {
        mul32_result[0] = -mul32_result[0];
        mul32_result[1] = ~mul32_result[1] + !mul32_result[0];
    }
}

void mul32(int32_t source_operand)
{
    int32_t dest_operand = reg32s[EAX];

    do_mul32(dest_operand, source_operand);

    reg32s[EAX] = mul32_result[0];
    reg32s[EDX] = mul32_result[1];

    *last_result = mul32_result[0];
    *last_op_size = OPSIZE_32;

    if(mul32_result[1] == 0)
    {
        *flags &= ~1 & ~FLAG_OVERFLOW;
    }
    else
    {
        *flags |= 1 | FLAG_OVERFLOW;
    }
    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_OVERFLOW;
}

void imul32(int32_t source_operand)
{
    //XXX: this assert fails since the limits here are out of bounds for int32
    //but the assert is present in the original JS source :|
    //assert(source_operand < 0x80000000 && source_operand >= -0x80000000);

    int32_t dest_operand = reg32s[EAX];

    do_imul32(dest_operand, source_operand);

    reg32s[EAX] = mul32_result[0];
    reg32s[EDX] = mul32_result[1];

    *last_result = mul32_result[0];
    *last_op_size = OPSIZE_32;

    if(mul32_result[1] == (mul32_result[0] >> 31))
    {
        *flags &= ~1 & ~FLAG_OVERFLOW;
    }
    else
    {
        *flags |= 1 | FLAG_OVERFLOW;
    }
    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_OVERFLOW;
}

int32_t imul_reg32(int32_t operand1, int32_t operand2)
{
    //XXX: assert limits OOB for int32
    //dbg_assert(operand1 < 0x80000000 && operand1 >= -0x80000000);
    //dbg_assert(operand2 < 0x80000000 && operand2 >= -0x80000000);

    do_imul32(operand1, operand2);

    *last_result = mul32_result[0];
    *last_op_size = OPSIZE_32;

    if(mul32_result[1] == (mul32_result[0] >> 31))
    {
        *flags &= ~1 & ~FLAG_OVERFLOW;
    }
    else
    {
        *flags |= 1 | FLAG_OVERFLOW;
    }
    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_OVERFLOW;

    return mul32_result[0];
}

int32_t xadd8(int32_t source_operand, int32_t reg)
{
    int32_t tmp = reg8[reg];

    reg8[reg] = source_operand;

    return add(source_operand, tmp, OPSIZE_8);
}

int32_t xadd16(int32_t source_operand, int32_t reg)
{
    int32_t tmp = reg16[reg];

    reg16[reg] = source_operand;

    return add(source_operand, tmp, OPSIZE_16);
}

int32_t xadd32(int32_t source_operand, int32_t reg)
{
    int32_t tmp = reg32s[reg];

    reg32s[reg] = source_operand;

    return add(source_operand, tmp, OPSIZE_32);
}

void bcd_daa()
{
    int32_t old_al = reg8[AL];
    int32_t old_cf = getcf();
    int32_t old_af = getaf();

    *flags &= ~1 & ~FLAG_ADJUST;

    if((old_al & 0xF) > 9 || old_af)
    {
        reg8[AL] += 6;
        *flags |= FLAG_ADJUST;
    }
    if(old_al > 0x99 || old_cf)
    {
        reg8[AL] += 0x60;
        *flags |= 1;
    }

    *last_result = reg8[AL];
    *last_op_size = OPSIZE_8;
    *last_op1 = *last_op2 = 0;
    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_ADJUST & ~FLAG_OVERFLOW;
}

void bcd_das()
{
    int32_t old_al = reg8[AL];
    int32_t old_cf = getcf();

    *flags &= ~1;

    if((old_al & 0xF) > 9 || getaf())
    {
        reg8[AL] -= 6;
        *flags |= FLAG_ADJUST;
        *flags = *flags & ~1 | old_cf | (old_al < 6);
    }
    else
    {
        *flags &= ~FLAG_ADJUST;
    }

    if(old_al > 0x99 || old_cf)
    {
        reg8[AL] -= 0x60;
        *flags |= 1;
    }

    *last_result = reg8[AL];
    *last_op_size = OPSIZE_8;
    *last_op1 = *last_op2 = 0;
    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_ADJUST & ~FLAG_OVERFLOW;
}

void bcd_aad(int32_t imm8)
{
    int32_t result = reg8[AL] + reg8[AH] * imm8;
    *last_result = result & 0xFF;
    reg16[AX] = *last_result;
    *last_op_size = OPSIZE_8;

    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_ADJUST & ~FLAG_OVERFLOW;
    *flags &= ~1 & ~FLAG_ADJUST & ~FLAG_OVERFLOW;

    if(result > 0xFFFF)
    {
        *flags |= 1;
    }
}

void bcd_aaa()
{
    if((reg8[AL] & 0xF) > 9 || getaf())
    {
        reg16[AX] += 6;
        reg8[AH] += 1;
        *flags |= FLAG_ADJUST | 1;
    }
    else
    {
        *flags &= ~FLAG_ADJUST & ~1;
    }
    reg8[AL] &= 0xF;

    *flags_changed &= ~FLAG_ADJUST & ~1;
}

void bcd_aas()
{
    if((reg8[AL] & 0xF) > 9 || getaf())
    {
        reg16[AX] -= 6;
        reg8[AH] -= 1;
        *flags |= FLAG_ADJUST | 1;
    }
    else
    {
        *flags &= ~FLAG_ADJUST & ~1;
    }
    reg8[AL] &= 0xF;

    *flags_changed &= ~FLAG_ADJUST & ~1;
}

int32_t and(int32_t dest_operand, int32_t source_operand, int32_t op_size)
{
    *last_result = dest_operand & source_operand;

    *last_op_size = op_size;
    *flags &= ~1 & ~FLAG_OVERFLOW & ~FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_OVERFLOW & ~FLAG_ADJUST;

    return *last_result;
}

int32_t or(int32_t dest_operand, int32_t source_operand, int32_t op_size)
{
    *last_result = dest_operand | source_operand;

    *last_op_size = op_size;
    *flags &= ~1 & ~FLAG_OVERFLOW & ~FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_OVERFLOW & ~FLAG_ADJUST;

    return *last_result;
}

int32_t xor(int32_t dest_operand, int32_t source_operand, int32_t op_size)
{
    *last_result = dest_operand ^ source_operand;

    *last_op_size = op_size;
    *flags &= ~1 & ~FLAG_OVERFLOW & ~FLAG_ADJUST;
    *flags_changed = FLAGS_ALL & ~1 & ~FLAG_OVERFLOW & ~FLAG_ADJUST;

    return *last_result;
}

int32_t and8(int32_t x, int32_t y) { return and(x, y, OPSIZE_8); }
int32_t and16(int32_t x, int32_t y) { return and(x, y, OPSIZE_16); }
int32_t and32(int32_t x, int32_t y) { return and(x, y, OPSIZE_32); }

void test8(int32_t x, int32_t y) { and(x, y, OPSIZE_8); }
void test16(int32_t x, int32_t y) { and(x, y, OPSIZE_16); }
void test32(int32_t x, int32_t y) { and(x, y, OPSIZE_32); }

int32_t or8(int32_t x, int32_t y) { return or(x, y, OPSIZE_8); }
int32_t or16(int32_t x, int32_t y) { return or(x, y, OPSIZE_16); }
int32_t or32(int32_t x, int32_t y) { return or(x, y, OPSIZE_32); }

int32_t xor8(int32_t x, int32_t y) { return xor(x, y, OPSIZE_8); }
int32_t xor16(int32_t x, int32_t y) { return xor(x, y, OPSIZE_16); }
int32_t xor32(int32_t x, int32_t y) { return xor(x, y, OPSIZE_32); }

int32_t rol8(int32_t dest_operand, int32_t count)
{
    if(!count)
    {
        return dest_operand;
    }
    count &= 7;

    int32_t result = dest_operand << count | dest_operand >> (8 - count);

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW)
                | (result & 1)
                | (result << 11 ^ result << 4) & FLAG_OVERFLOW;

    return result;
}

int32_t rol16(int32_t dest_operand, int32_t count)
{
    if(!count)
    {
        return dest_operand;
    }
    count &= 15;

    int32_t result = dest_operand << count | dest_operand >> (16 - count);

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW)
                | (result & 1)
                | (result << 11 ^ result >> 4) & FLAG_OVERFLOW;

    return result;
}

int32_t rol32(int32_t dest_operand, int32_t count)
{
    if(!count)
    {
        return dest_operand;
    }

    int32_t result = dest_operand << count | ((uint32_t) dest_operand) >> (32 - count);

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW)
                | (result & 1)
                | (result << 11 ^ result >> 20) & FLAG_OVERFLOW;

    return result;
}

int32_t rcl8(int32_t dest_operand, int32_t count)
{
    count %= 9;
    if(!count)
    {
        return dest_operand;
    }

    int32_t result = dest_operand << count | getcf() << (count - 1) | dest_operand >> (9 - count);

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW)
                | (result >> 8 & 1)
                | (result << 3 ^ result << 4) & FLAG_OVERFLOW;

    return result;
}

int32_t rcl16(int32_t dest_operand, int32_t count)
{
    count %= 17;
    if(!count)
    {
        return dest_operand;
    }

    int32_t result = dest_operand << count | getcf() << (count - 1) | dest_operand >> (17 - count);

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW)
                | (result >> 16 & 1)
                | (result >> 5 ^ result >> 4) & FLAG_OVERFLOW;

    return result;
}

int32_t rcl32(int32_t dest_operand, int32_t count)
{
    if(!count)
    {
        return dest_operand;
    }

    int32_t result = dest_operand << count | getcf() << (count - 1);

    if(count > 1)
    {
        result |= ((uint32_t) dest_operand) >> (33 - count);
    }

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW) | (((uint32_t) dest_operand) >> (32 - count) & 1);
    *flags |= (*flags << 11 ^ result >> 20) & FLAG_OVERFLOW;

    return result;
}

int32_t ror8(int32_t dest_operand, int32_t count)
{
    if(!count)
    {
        return dest_operand;
    }

    count &= 7;
    int32_t result = dest_operand >> count | dest_operand << (8 - count);

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW)
                | (result >> 7 & 1)
                | (result << 4 ^ result << 5) & FLAG_OVERFLOW;

    return result;
}

int32_t ror16(int32_t dest_operand, int32_t count)
{
    if(!count)
    {
        return dest_operand;
    }

    count &= 15;
    int32_t result = dest_operand >> count | dest_operand << (16 - count);

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW)
                | (result >> 15 & 1)
                | (result >> 4 ^ result >> 3) & FLAG_OVERFLOW;

    return result;
}

int32_t ror32(int32_t dest_operand, int32_t count)
{
    if(!count)
    {
        return dest_operand;
    }

    int32_t result = ((uint32_t) dest_operand) >> count | dest_operand << (32 - count);

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW)
                | (result >> 31 & 1)
                | (result >> 20 ^ result >> 19) & FLAG_OVERFLOW;

    return result;
}

int32_t rcr8(int32_t dest_operand, int32_t count)
{
    count %= 9;
    if(!count)
    {
        return dest_operand;
    }

    int32_t result = dest_operand >> count | getcf() << (8 - count) | dest_operand << (9 - count);

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW)
                | (result >> 8 & 1)
                | (result << 4 ^ result << 5) & FLAG_OVERFLOW;

    return result;
}

int32_t rcr16(int32_t dest_operand, int32_t count)
{
    count %= 17;
    if(!count)
    {
        return dest_operand;
    }

    int32_t result = dest_operand >> count | getcf() << (16 - count) | dest_operand << (17 - count);

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW)
                | (result >> 16 & 1)
                | (result >> 4 ^ result >> 3) & FLAG_OVERFLOW;

    return result;
}

int32_t rcr32(int32_t dest_operand, int32_t count)
{
    if(!count)
    {
        return dest_operand;
    }

    int32_t result = ((uint32_t) dest_operand) >> count | getcf() << (32 - count);

    if(count > 1)
    {
        result |= dest_operand << (33 - count);
    }

    *flags_changed &= ~1 & ~FLAG_OVERFLOW;
    *flags = (*flags & ~1 & ~FLAG_OVERFLOW)
                | (dest_operand >> (count - 1) & 1)
                | (result >> 20 ^ result >> 19) & FLAG_OVERFLOW;

    return result;
}

void div8(uint32_t source_operand)
{
    if(source_operand == 0)
    {
        trigger_de();
        return;
    }

    uint16_t target_operand = reg16[AX];
    uint16_t result = target_operand / source_operand;

    if(result >= 0x100)
    {
        trigger_de();
    }
    else
    {
        reg8[AL] = result;
        reg8[AH] = target_operand % source_operand;
    }
}

void idiv8(int32_t source_operand)
{
    if(source_operand == 0)
    {
        trigger_de();
        return;
    }

    int32_t target_operand = reg16s[AX];
    int32_t result = target_operand / source_operand;

    if(result >= 0x80 || result <= -0x81)
    {
        trigger_de();
    }
    else
    {
        reg8[AL] = result;
        reg8[AH] = target_operand % source_operand;
    }
}

void div16(uint32_t source_operand)
{
    if(source_operand == 0)
    {
        trigger_de();
        return;
    }

    uint32_t target_operand = reg16[AX] | reg16[DX] << 16;
    uint32_t result = target_operand / source_operand;

    if(result >= 0x10000)
    {
        trigger_de();
    }
    else
    {
        reg16[AX] = result;
        reg16[DX] = target_operand % source_operand;
    }
}

