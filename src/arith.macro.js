/*
 * Arithmatic functions
 * This file contains:
 *
 * add, adc, sub, sbc, cmp
 * inc, dec
 * neg, not
 * imul, mul, idiv, div
 * xadd
 *
 * das, daa, aad, aam
 *
 * and, or, xor, test
 * shl, shr, sar, ror, rol, rcr, rcl
 * shld, shrd
 *
 * bts, btr, btc, bt
 * bsf, bsr
 *
 * Gets #included by cpu.macro.js
 *
*/
"use strict";

#define add8(dest, src) add(dest, src, OPSIZE_8)
#define add16(dest, src) add(dest, src, OPSIZE_16)
#define add32(dest, src) add(dest, src, OPSIZE_32)

#define adc8(dest, src) adc(dest, src, OPSIZE_8)
#define adc16(dest, src) adc(dest, src, OPSIZE_16)
#define adc32(dest, src) adc(dest, src, OPSIZE_32)

#define sub8(dest, src) sub(dest, src, OPSIZE_8)
#define sub16(dest, src) sub(dest, src, OPSIZE_16)
#define sub32(dest, src) sub(dest, src, OPSIZE_32)

#define cmp8(dest, src) sub(dest, src, OPSIZE_8)
#define cmp16(dest, src) sub(dest, src, OPSIZE_16)
#define cmp32(dest, src) sub(dest, src, OPSIZE_32)

#define sbb8(dest, src) sbb(dest, src, OPSIZE_8)
#define sbb16(dest, src) sbb(dest, src, OPSIZE_16)
#define sbb32(dest, src) sbb(dest, src, OPSIZE_32)


function add(dest_operand, source_operand, op_size)
{
    // very likely to be a crash
    //if(DEBUG && memory.read32s(translate_address_read(instruction_pointer)) === 0)
    //{
    //    dump_regs();
    //    throw "detected jump to 00000000"; 
    //}

    last_op1 = dest_operand;
    last_op2 = source_operand;
    last_add_result = last_result = dest_operand + source_operand | 0;
    
    last_op_size = op_size;
    flags_changed = flags_all;

    return last_result;
}

function adc(dest_operand, source_operand, op_size)
{
    var cf = getcf();
    last_op1 = dest_operand;
    last_op2 = source_operand;
    last_add_result = last_result = dest_operand + source_operand + cf | 0;
    
    last_op_size = op_size;
    flags_changed = flags_all;

    return last_result;
}

function cmp(dest_operand, source_operand, op_size)
{
    last_add_result = dest_operand;
    last_op2 = source_operand;
    last_op1 = last_result = dest_operand - source_operand | 0;

    last_op_size = op_size;
    flags_changed = flags_all;
}

function sub(dest_operand, source_operand, op_size)
{
    last_add_result = dest_operand;
    last_op2 = source_operand;
    last_op1 = last_result = dest_operand - source_operand | 0;
    
    last_op_size = op_size;
    flags_changed = flags_all;

    return last_result;
}

function sbb(dest_operand, source_operand, op_size)
{
    var cf = getcf();
    last_add_result = dest_operand;
    last_op2 = source_operand;
    last_op1 = last_result = dest_operand - source_operand - cf | 0;
    last_op_size = op_size;
    
    flags_changed = flags_all;

    return last_result;
}

/*
 * inc and dec
 */

#define inc8(dest) inc(dest, OPSIZE_8)
#define inc16(dest) inc(dest, OPSIZE_16)
#define inc32(dest) inc(dest, OPSIZE_32)

#define dec8(dest) dec(dest, OPSIZE_8)
#define dec16(dest) dec(dest, OPSIZE_16)
#define dec32(dest) dec(dest, OPSIZE_32)

function inc(dest_operand, op_size)
{
    flags = (flags & ~1) | getcf();
    last_op1 = dest_operand;
    last_op2 = 1;
    last_add_result = last_result = dest_operand + 1 | 0;
    last_op_size = op_size;
    
    flags_changed = flags_all & ~1;

    return last_result;
}

function dec(dest_operand, op_size)
{
    flags = (flags & ~1) | getcf();
    last_add_result = dest_operand;
    last_op2 = 1;
    last_op1 = last_result = dest_operand - 1 | 0;
    last_op_size = op_size;
    
    flags_changed = flags_all & ~1;

    return last_result;
}


/*
 * neg
 */
#define neg8(dest) neg(dest, OPSIZE_8)
#define neg16(dest) neg(dest, OPSIZE_16)
#define neg32(dest) neg(dest, OPSIZE_32)

function neg(dest_operand, op_size)
{
    last_op1 = last_result = -dest_operand | 0;
    
    flags_changed = flags_all;
    last_add_result = 0;
    last_op2 = dest_operand;
    last_op_size = op_size;

    return last_result;
}


/*
 * mul, imul, div, idiv
 *
 * Note: imul has some extra opcodes
 *       while other functions only allow
 *       ax * modrm
 */

#define do_mul32(a, b)\
    var a00 = a & 0xFFFF, \
        a16 = a >>> 16, \
        b00 = b & 0xFFFF, \
        b16 = b >>> 16, \
        c00 = a00 * b00 | 0, \
        c16 = (c00 >>> 16) + a16 * b00 + a00 * b16 | 0, \
        low_result = (c16 << 16) | c00 & 0xFFFF, \
        high_result = (c16 >>> 16) + a16 * b16 | 0; 

#define do_imul32(a, b)\
    var is_neg = false; \
    if(a < 0) { \
        is_neg = true; \
        a = -a | 0; \
    } \
    if(b < 0) { \
        is_neg = !is_neg; \
        b = -b | 0; \
    } \
    do_mul32(a, b); \
    if(is_neg) { \
        low_result = -low_result | 0; \
        high_result = ~high_result + !low_result | 0; \
    }

function mul8(source_operand)
{
    var result = source_operand * reg8[reg_al];

    reg16[reg_ax] = result;

    if(result < 0x100)
    {
        flags = flags & ~1 & ~flag_overflow;
    }
    else
    {
        flags = flags | 1 | flag_overflow;
    }

    flags_changed = 0;
}

function imul8(source_operand)
{
    var result = source_operand * reg8s[reg_al];

    reg16[reg_ax] = result;

    if(result > 0x7F || result < -0x80)
    {
        flags = flags | 1 | flag_overflow;
    }
    else
    {
        flags = flags & ~1 & ~flag_overflow;
    }
    flags_changed = 0;
}

function mul16(source_operand)
{
    var result = source_operand * reg16[reg_ax],
        high_result = result >>> 16;
    //console.log(h(a) + " * " + h(reg16[reg_ax]) + " = " + h(result));

    reg16[reg_ax] = result;
    reg16[reg_dx] = high_result;

    if(high_result === 0)
    {
        flags &= ~1 & ~flag_overflow;
    }
    else
    {
        flags |= 1 | flag_overflow;
    }
    flags_changed = 0;
}

/*
 * imul with 1 argument
 * ax = ax * r/m
 */
function imul16(source_operand)
{
    var result = source_operand * reg16s[reg_ax];

    reg16[reg_ax] = result;
    reg16[reg_dx] = result >> 16;

    if(result > 0x7FFF || result < -0x8000)
    {
        flags |= 1 | flag_overflow;
    }
    else
    {
        flags &= ~1 & ~flag_overflow;
    }
    flags_changed = 0;
}

/*
 * imul with 2 or 3 arguments
 * reg = reg * r/m
 * reg = imm * r/m
 */
function imul_reg16(operand1, operand2)
{
    dbg_assert(operand1 < 0x8000 && operand1 >= -0x8000);
    dbg_assert(operand2 < 0x8000 && operand2 >= -0x8000);

    var result = operand1 * operand2;

    if(result > 0x7FFF || result < -0x8000)
    {
        flags |= 1 | flag_overflow;
    }
    else
    {
        flags &= ~1 & ~flag_overflow;
    }
    flags_changed = 0;

    return result;
}

function mul32(source_operand)
{
    var dest_operand = reg32s[reg_eax];

    do_mul32(dest_operand, source_operand);

    reg32[reg_eax] = low_result;
    reg32[reg_edx] = high_result;

    if(high_result === 0)
    {
        flags &= ~1 & ~flag_overflow;
    }
    else
    {
        flags |= 1 | flag_overflow;
    }
    flags_changed = 0;

    //console.log(memory.read32s(address) + " * " + old);
    //console.log("= " + reg32[reg_edx] + " " + reg32[reg_eax]);
}

function imul32(source_operand)
{
    dbg_assert(source_operand < 0x80000000 && source_operand >= -0x80000000);

    var dest_operand = reg32s[reg_eax];

    do_imul32(dest_operand, source_operand);
    
    reg32s[reg_eax] = low_result;
    reg32s[reg_edx] = high_result;

    if(high_result === (low_result >> 31))
    {
        flags &= ~1 & ~flag_overflow;
    }
    else
    {
        flags |= 1 | flag_overflow;
    }
    flags_changed = 0;

    //console.log(target_operand + " * " + source_operand);
    //console.log("= " + h(reg32[reg_edx]) + " " + h(reg32[reg_eax]));
}

/*
 * imul with 2 or 3 arguments
 * reg = reg * r/m
 * reg = imm * r/m
 */
function imul_reg32(operand1, operand2)
{
    dbg_assert(operand1 < 0x80000000 && operand1 >= -0x80000000);
    dbg_assert(operand2 < 0x80000000 && operand2 >= -0x80000000);

    do_imul32(operand1, operand2);

    if(high_result === (low_result >> 31))
    {
        flags &= ~1 & ~flag_overflow;
    }
    else
    {
        flags |= 1 | flag_overflow;
    }
    flags_changed = 0;

    return low_result;

    //console.log(operand + " * " + source_operand);
    //console.log("= " + reg32[reg]);
}

function div8(source_operand)
{
    dbg_assert(source_operand >= 0 && source_operand < 0x100);

    var target_operand = reg16[reg_ax],
        result = target_operand / source_operand | 0;

    if(result >= 0x100 || source_operand === 0)
    {
        trigger_de();
    }
    else
    {
        reg8[reg_al] = result;
        reg8[reg_ah] = target_operand % source_operand;
    }
}

function idiv8(source_operand)
{
    dbg_assert(source_operand >= -0x80 && source_operand < 0x80);

    var target_operand = reg16s[reg_ax],
        result = target_operand / source_operand | 0;

    if(result >= 0x80 || result <= -0x81 || source_operand === 0)
    {
        trigger_de();
    }
    else
    {
        reg8[reg_al] = result;
        reg8[reg_ah] = target_operand % source_operand;
    }
}

function div16(source_operand)
{
    dbg_assert(source_operand >= 0 && source_operand < 0x10000);

    var 
        target_operand = (reg16[reg_ax] | reg16[reg_dx] << 16) >>> 0,
        result = target_operand / source_operand | 0;

    if(result >= 0x10000 || result < 0 || source_operand === 0)
    {
        trigger_de();
    }
    else
    {
        reg16[reg_ax] = result;
        reg16[reg_dx] = target_operand % source_operand;
    }
}

function idiv16(source_operand)
{
    dbg_assert(source_operand >= -0x8000 && source_operand < 0x8000);

    var target_operand = reg16[reg_ax] | (reg16[reg_dx] << 16),
        result = target_operand / source_operand | 0;
    
    if(result >= 0x8000 || result <= -0x8001 || source_operand === 0)
    {
        trigger_de();
    }
    else
    {    
        reg16[reg_ax] = result;
        reg16[reg_dx] = target_operand % source_operand;
    }
}

function div32(source_operand)
{
    dbg_assert(source_operand >= 0 && source_operand <= 0xffffffff);

    var 
        dest_operand_low = reg32[reg_eax],
        dest_operand_high = reg32[reg_edx],

        // Wat? Not sure if seriös ...
        mod = (0x100000000 * dest_operand_high % source_operand + dest_operand_low % source_operand) % source_operand,
        result = dest_operand_low / source_operand + dest_operand_high * 0x100000000 / source_operand;

    if(result >= 0x100000000 || source_operand === 0)
    {
        dbg_log("div32 #DE: " + h(dest_operand_high, 8) + ":" + h(dest_operand_low, 8) + " div " + h(source_operand, 8));

        trigger_de();
    }
    else
    {    
        reg32[reg_eax] = result;
        reg32[reg_edx] = mod;
    }

    //console.log(h(dest_operand_high) + ":" + h(dest_operand_low) + " / " + h(source_operand));
    //console.log("= " + h(reg32[reg_eax]) + " rem " + h(reg32[reg_edx]));
}

function idiv32(source_operand)
{
    dbg_assert(source_operand < 0x80000000 && source_operand >= -0x80000000);

    var 
        dest_operand_low = reg32[reg_eax],
        dest_operand_high = reg32s[reg_edx],
        mod = (0x100000000 * dest_operand_high % source_operand + dest_operand_low % source_operand) % source_operand,
        result = dest_operand_low / source_operand + dest_operand_high * 0x100000000 / source_operand;

    if(result >= 0x80000000 || result <= -0x80000001 || source_operand === 0)
    {
        dbg_log("div32 #DE: " + h(dest_operand_high, 8) + ":" + h(dest_operand_low, 8) + " div " + h(source_operand, 8));
        trigger_de();
    }
    else
    {    
        reg32[reg_eax] = result;
        reg32[reg_edx] = mod;
    }

    //console.log(h(dest_operand_high) + ":" + h(dest_operand_low) + " / " + h(source_operand));
    //console.log("= " + h(reg32[reg_eax]) + " rem " + h(reg32[reg_edx]));
}


function xadd8(source_operand, reg)
{
    var tmp = reg8[reg];

    reg8[reg] = source_operand;

    return add8(source_operand, tmp);
}


function xadd16(source_operand, reg)
{
    var tmp = reg16[reg];

    reg16[reg] = source_operand;

    return add16(source_operand, tmp);
}


function xadd32(source_operand, reg)
{
    var tmp = reg32s[reg];

    reg32s[reg] = source_operand;

    return add32(source_operand, tmp);
}


function bcd_daa()
{
    //dbg_log("daa");
    // decimal adjust after addition
    var old_al = reg8[reg_al],
        old_cf = getcf(),
        old_af = getaf();

    flags &= ~1 & ~flag_adjust

    if((old_al & 0xF) > 9 || old_af)
    {
        reg8[reg_al] += 6;
        flags |= flag_adjust;
    }
    if(old_al > 0x99 || old_cf)
    {
        reg8[reg_al] += 0x60;
        flags |= 1;
    }

    last_result = reg8[reg_al];
    last_op_size = OPSIZE_8;
    last_op1 = last_op2 = 0;
    flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
}

function bcd_das()
{
    //dbg_log("das");
    // decimal adjust after subtraction
    var old_al = reg8[reg_al],
        old_cf = getcf();

    flags &= ~1;

    if((old_al & 0xF) > 9 || getaf())
    {
        reg8[reg_al] -= 6;
        flags |= flag_adjust;
        flags = flags & ~1 | old_cf | reg8[reg_al] >> 7;
    }
    else
    {
        flags &= ~flag_adjust;
    }

    if(old_al > 0x99 || old_cf)
    {
        reg8[reg_al] -= 0x60;
        flags |= 1;
    }

    last_result = reg8[reg_al];
    last_op_size = OPSIZE_8;
    last_op1 = last_op2 = 0;
    flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
}

function bcd_aam()
{
    // ascii adjust after multiplication
    var imm8 = read_imm8();

    if(imm8 === 0)
    {
        trigger_de();
    }
    else
    {
        var temp = reg8[reg_al];
        reg8[reg_ah] = temp / imm8;
        reg8[reg_al] = temp % imm8;

        last_result = reg8[reg_al];

        flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
        flags &= ~1 & ~flag_adjust & ~flag_overflow;
    }
}

function bcd_aad()
{
    // ascii adjust after division
    var imm8 = read_imm8();

    last_result = reg8[reg_al] + reg8[reg_ah] * imm8;
    reg16[reg_ax] = last_result & 0xFF;
    last_op_size = OPSIZE_8;

    flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
    flags &= ~1 & ~flag_adjust & ~flag_overflow;
}

function bcd_aaa()
{
    if((reg8[reg_al] & 0xF) > 9 || getaf())
    {
        reg16[reg_ax] += 6;
        reg8[reg_ah] += 1;
        flags |= flag_adjust | 1;
    }
    else
    {
        flags &= ~flag_adjust & ~1;
    }
    reg8[reg_al] &= 0xF;

    flags_changed &= ~flag_adjust & ~1;
}


function bcd_aas()
{
    if((reg8[reg_al] & 0xF) > 9 || getaf())
    {
        reg16[reg_ax] -= 6;
        reg8[reg_ah] -= 1;
        flags |= flag_adjust | 1;
    }
    else
    {
        flags &= ~flag_adjust & ~1;
    }
    reg8[reg_al] &= 0xF;

    flags_changed &= ~flag_adjust & ~1;
}


/*                     \O
 * bitwise functions    |\
 *                     / \
 *
 * and, or, xor, test
 * shl, shr, sar, rol, ror, rcl, ror
 * shrd, shld
 *
 * bt, bts, btr, btc
 * bsf, bsr
 */

#define and8(dest, src) and(dest, src, OPSIZE_8)
#define and16(dest, src) and(dest, src, OPSIZE_16)
#define and32(dest, src) and(dest, src, OPSIZE_32)

#define test8(dest, src) and(dest, src, OPSIZE_8)
#define test16(dest, src) and(dest, src, OPSIZE_16)
#define test32(dest, src) and(dest, src, OPSIZE_32)

#define or8(dest, src) or(dest, src, OPSIZE_8)
#define or16(dest, src) or(dest, src, OPSIZE_16)
#define or32(dest, src) or(dest, src, OPSIZE_32)

#define xor8(dest, src) xor(dest, src, OPSIZE_8)
#define xor16(dest, src) xor(dest, src, OPSIZE_16)
#define xor32(dest, src) xor(dest, src, OPSIZE_32)

function and(dest_operand, source_operand, op_size)
{
    last_result = dest_operand & source_operand;
    
    last_op_size = op_size;
    flags &= ~1 & ~flag_overflow & ~flag_adjust;
    flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;

    return last_result;
}

function test(dest_operand, source_operand, op_size)
{
    last_result = dest_operand & source_operand;

    last_op_size = op_size;
    flags &= ~1 & ~flag_overflow & ~flag_adjust;
    flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;
}

function or(dest_operand, source_operand, op_size)
{
    last_result = dest_operand | source_operand;
    
    last_op_size = op_size;
    flags &= ~1 & ~flag_overflow & ~flag_adjust;
    flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;

    return last_result;
}

function xor(dest_operand, source_operand, op_size)
{
    last_result = dest_operand ^ source_operand;
    
    last_op_size = op_size;
    flags &= ~1 & ~flag_overflow & ~flag_adjust;
    flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;

    return last_result;
}


/*
 * rotates and shifts
 */

function rol8(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }
    count &= 7;

    var result = dest_operand << count | dest_operand >> (8 - count);

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (result & 1)
                | (result << 11 ^ result << 4) & flag_overflow;

    return result;
}

function rol16(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }
    count &= 15;

    var result = dest_operand << count | dest_operand >> (16 - count);

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (result & 1)
                | (result << 11 ^ result >> 4) & flag_overflow;

    return result;
}

function rol32(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand << count | dest_operand >>> (32 - count);

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (result & 1)
                | (result << 11 ^ result >> 20) & flag_overflow;

    return result;
}

function rcl8(dest_operand, count)
{
    count %= 9;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand << count | getcf() << (count - 1) | dest_operand >> (9 - count);

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (result >> 8 & 1)
                | (result << 3 ^ result << 4) & flag_overflow;

    return result;
}

function rcl16(dest_operand, count)
{
    count %= 17;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand << count | getcf() << (count - 1) | dest_operand >> (17 - count);

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (result >> 16 & 1) 
                | (result >> 5 ^ result >> 4) & flag_overflow;

    return result;
}

function rcl32(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand << count | getcf() << (count - 1);

    if(count > 1)
    {
        result |= dest_operand >>> (33 - count);
    }

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) | (dest_operand >>> (32 - count) & 1);
    flags |= (flags << 11 ^ result >> 20) & flag_overflow;

    return result;
}

function ror8(dest_operand, count)
{
    count &= 7;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >> count | dest_operand << (8 - count);

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (result >> 7 & 1)
                | (result << 4 ^ result << 5) & flag_overflow;

    return result;
} 

function ror16(dest_operand, count)
{
    count &= 15;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >> count | dest_operand << (16 - count);

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (result >> 15 & 1) 
                | (result >> 4 ^ result >> 3) & flag_overflow;

    return result;
}    

function ror32(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >>> count | dest_operand << (32 - count);

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (result >> 31 & 1) 
                | (result >> 20 ^ result >> 19) & flag_overflow;

    return result;
}

function rcr8(dest_operand, count)
{
    count %= 9;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >> count | getcf() << (8 - count) | dest_operand << (9 - count);

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (result >> 8 & 1)
                | (result << 4 ^ result << 5) & flag_overflow;

    return result;
}    

function rcr16(dest_operand, count)
{
    count %= 17;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >> count | getcf() << (16 - count) | dest_operand << (17 - count);

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (result >> 16 & 1)
                | (result >> 4 ^ result >> 3) & flag_overflow;

    return result;
}

function rcr32(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >>> count | getcf() << (32 - count);

    if(count > 1)
    {
        result |= dest_operand << (33 - count);
    }

    flags_changed &= ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (dest_operand >> (count - 1) & 1)
                | (result >> 20 ^ result >> 19) & flag_overflow;

    return result;
}

function shl8(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    last_result = dest_operand << count;

    last_op_size = OPSIZE_8;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (last_result >> 8 & 1)
                | (last_result << 3 ^ last_result << 4) & flag_overflow;

    return last_result;
}

function shl16(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    last_result = dest_operand << count;

    last_op_size = OPSIZE_16;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (last_result >> 16 & 1)
                | (last_result >> 5 ^ last_result >> 4) & flag_overflow;

    return last_result;
}

function shl32(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    last_result = dest_operand << count;

    last_op_size = OPSIZE_32;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    // test this
    flags = (flags & ~1 & ~flag_overflow) | (dest_operand >>> (32 - count) & 1);
    flags |= ((flags & 1) ^ (last_result >> 31 & 1)) << 11 & flag_overflow;

    return last_result;
}
    
function shr8(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    last_result = dest_operand >> count;

    last_op_size = OPSIZE_8;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (dest_operand >> (count - 1) & 1)
                | (dest_operand >> 7 & 1) << 11 & flag_overflow;

    return last_result;
}    

function shr16(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    last_result = dest_operand >> count;

    last_op_size = OPSIZE_16;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (dest_operand >> (count - 1) & 1) 
                | (dest_operand >> 4)  & flag_overflow;

    return last_result;
}    

function shr32(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    last_result = dest_operand >>> count;

    last_op_size = OPSIZE_32;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) 
                | (dest_operand >>> (count - 1) & 1)
                | (dest_operand >> 20) & flag_overflow;

    return last_result;
}

function sar8(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    last_result = dest_operand >> count;

    last_op_size = OPSIZE_8;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) | (dest_operand >> (count - 1) & 1);
    // of is zero

    return last_result;
}    

function sar16(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    last_result = dest_operand >> count;

    last_op_size = OPSIZE_16;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) | (dest_operand >> (count - 1) & 1);

    return last_result;
}

function sar32(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    last_result = dest_operand >> count;

    last_op_size = OPSIZE_32;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    flags = (flags & ~1 & ~flag_overflow) | (dest_operand >>> (count - 1) & 1);

    return last_result;
}


function shrd16(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    if(count <= 16)
    {
        last_result = dest_operand >> count | source_operand << (16 - count);
        flags = (flags & ~1) | (dest_operand >> (count - 1) & 1);
    }
    else
    {
        last_result = dest_operand << (32 - count) | source_operand >> (count - 16);
        flags = (flags & ~1) | (source_operand >> (count - 17) & 1);
    }

    last_op_size = OPSIZE_16;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    flags = (flags & ~flag_overflow) | ((last_result ^ dest_operand) >> 4 & flag_overflow);

    return last_result;
}

function shrd32(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    last_result = dest_operand >>> count | source_operand << (32 - count);

    last_op_size = OPSIZE_32;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    flags = (flags & ~1) | (dest_operand >>> (count - 1) & 1);
    flags = (flags & ~flag_overflow) | ((last_result ^ dest_operand) >> 20 & flag_overflow);

    return last_result;
}

function shld16(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    if(count <= 16)
    {
        last_result = dest_operand << count | source_operand >>> (16 - count);
        flags = (flags & ~1) | (dest_operand >>> (16 - count) & 1);
    }
    else
    {
        last_result = dest_operand >> (32 - count) | source_operand << (count - 16);
        flags = (flags & ~1) | (source_operand >>> (32 - count) & 1);
    }

    last_op_size = OPSIZE_16;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    flags = (flags & ~flag_overflow) | ((flags & 1) ^ (last_result >> 15 & 1)) << 11;

    return last_result;
}

function shld32(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    last_result = dest_operand << count | source_operand >>> (32 - count);

    last_op_size = OPSIZE_32;
    flags_changed = flags_all & ~1 & ~flag_overflow;
    // test this
    flags = (flags & ~1) | (dest_operand >>> (32 - count) & 1);
    flags = (flags & ~flag_overflow) | ((flags & 1) ^ (last_result >> 31 & 1)) << 11;

    return last_result;
}


function bt_reg(bit_base, bit_offset)
{
    flags = (flags & ~1) | (bit_base >> bit_offset & 1);
    flags_changed &= ~1;
}

function btc_reg(bit_base, bit_offset)
{
    flags = (flags & ~1) | (bit_base >> bit_offset & 1);
    flags_changed &= ~1;

    return bit_base ^ 1 << bit_offset;
}

function bts_reg(bit_base, bit_offset)
{
    flags = (flags & ~1) | (bit_base >> bit_offset & 1);
    flags_changed &= ~1;

    return bit_base | 1 << bit_offset;
}

function btr_reg(bit_base, bit_offset)
{
    flags = (flags & ~1) | (bit_base >> bit_offset & 1);
    flags_changed &= ~1;

    return bit_base & ~(1 << bit_offset);
}

function bt_mem(virt_addr, bit_offset)
{
    var bit_base = safe_read8(virt_addr + (bit_offset >> 3));
    bit_offset &= 7;

    flags = (flags & ~1) | (bit_base >> bit_offset & 1);
    flags_changed &= ~1;
}

function btc_mem(virt_addr, bit_offset)
{
    var phys_addr = translate_address_write(virt_addr + (bit_offset >> 3));
    var bit_base = memory.read8(phys_addr);

    bit_offset &= 7;

    flags = (flags & ~1) | (bit_base >> bit_offset & 1);
    flags_changed &= ~1;

    memory.write8(phys_addr, bit_base ^ 1 << bit_offset);
}

function btr_mem(virt_addr, bit_offset)
{
    var phys_addr = translate_address_write(virt_addr + (bit_offset >> 3));
    var bit_base = memory.read8(phys_addr);

    bit_offset &= 7;

    flags = (flags & ~1) | (bit_base >> bit_offset & 1);
    flags_changed &= ~1;

    memory.write8(phys_addr, bit_base & ~(1 << bit_offset));
}

function bts_mem(virt_addr, bit_offset)
{
    var phys_addr = translate_address_write(virt_addr + (bit_offset >> 3));
    var bit_base = memory.read8(phys_addr);

    bit_offset &= 7;

    flags = (flags & ~1) | (bit_base >> bit_offset & 1);
    flags_changed &= ~1;

    memory.write8(phys_addr, bit_base | 1 << bit_offset);
}

function bsf16(old, bit_base)
{
    flags_changed = 0;

    if(bit_base === 0)
    {
        flags |= flag_zero;
        
        // not defined in the docs, but value doesn't change on my intel cpu
        return old;
    }
    else
    {
        flags &= ~flag_zero;

        // http://jsperf.com/lowest-bit-index
        return Math.int_log2(-bit_base & bit_base);
    }
}

function bsf32(old, bit_base)
{
    flags_changed = 0;

    if(bit_base === 0)
    {
        flags |= flag_zero;

        return old;
    }
    else
    {
        flags &= ~flag_zero;

        return Math.int_log2((-bit_base & bit_base) >>> 0);
    }
}

function bsr16(old, bit_base)
{
    flags_changed = 0;

    if(bit_base === 0)
    {
        flags |= flag_zero;
        return old;
    }
    else
    {
        flags &= ~flag_zero;

        return Math.int_log2(bit_base);
    }
}

function bsr32(old, bit_base)
{
    flags_changed = 0;

    if(bit_base === 0)
    {
        flags |= flag_zero;
        return old;
    }
    else
    {
        flags &= ~flag_zero;

        return Math.int_log2(bit_base >>> 0);
    }
}


#undef do_mul32
#undef do_imul32
