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
 * popcnt
 *
 * Gets #included by cpu.macro.js
 *
*/
"use strict";

#define add8(dest, src)  cpu.add(dest, src, OPSIZE_8)
#define add16(dest, src) cpu.add(dest, src, OPSIZE_16)
#define add32(dest, src) cpu.add(dest, src, OPSIZE_32)

#define adc8(dest, src)  cpu.adc(dest, src, OPSIZE_8)
#define adc16(dest, src) cpu.adc(dest, src, OPSIZE_16)
#define adc32(dest, src) cpu.adc(dest, src, OPSIZE_32)

#define sub8(dest, src)  cpu.sub(dest, src, OPSIZE_8)
#define sub16(dest, src) cpu.sub(dest, src, OPSIZE_16)
#define sub32(dest, src) cpu.sub(dest, src, OPSIZE_32)

#define cmp8(dest, src)  cpu.sub(dest, src, OPSIZE_8)
#define cmp16(dest, src) cpu.sub(dest, src, OPSIZE_16)
#define cmp32(dest, src) cpu.sub(dest, src, OPSIZE_32)

#define sbb8(dest, src)  cpu.sbb(dest, src, OPSIZE_8)
#define sbb16(dest, src) cpu.sbb(dest, src, OPSIZE_16)
#define sbb32(dest, src) cpu.sbb(dest, src, OPSIZE_32)

CPU.prototype.add = function(dest_operand, source_operand, op_size)
{
    this.last_op1 = dest_operand;
    this.last_op2 = source_operand;
    this.last_add_result = this.last_result = dest_operand + source_operand | 0;
    
    this.last_op_size = op_size;
    this.flags_changed = flags_all;

    return this.last_result;
}

CPU.prototype.adc = function(dest_operand, source_operand, op_size)
{
    var cf = this.getcf();
    this.last_op1 = dest_operand;
    this.last_op2 = source_operand;
    this.last_add_result = this.last_result = (dest_operand + source_operand | 0) + cf | 0;
    
    this.last_op_size = op_size;
    this.flags_changed = flags_all;

    return this.last_result;
}

CPU.prototype.cmp = function(dest_operand, source_operand, op_size)
{
    this.last_add_result = dest_operand;
    this.last_op2 = source_operand;
    this.last_op1 = this.last_result = dest_operand - source_operand | 0;

    this.last_op_size = op_size;
    this.flags_changed = flags_all;
}

CPU.prototype.sub = function(dest_operand, source_operand, op_size)
{
    this.last_add_result = dest_operand;
    this.last_op2 = source_operand;
    this.last_op1 = this.last_result = dest_operand - source_operand | 0;
    
    this.last_op_size = op_size;
    this.flags_changed = flags_all;

    return this.last_result;
}

CPU.prototype.sbb = function(dest_operand, source_operand, op_size)
{
    var cf = this.getcf();
    this.last_add_result = dest_operand;
    this.last_op2 = source_operand;
    this.last_op1 = this.last_result = dest_operand - source_operand - cf | 0;
    this.last_op_size = op_size;
    
    this.flags_changed = flags_all;

    return this.last_result;
}

/*
 * inc and dec
 */

#define inc8(dest) cpu.inc(dest, OPSIZE_8)
#define inc16(dest) cpu.inc(dest, OPSIZE_16)
#define inc32(dest) cpu.inc(dest, OPSIZE_32)

#define dec8(dest) cpu.dec(dest, OPSIZE_8)
#define dec16(dest) cpu.dec(dest, OPSIZE_16)
#define dec32(dest) cpu.dec(dest, OPSIZE_32)

CPU.prototype.inc = function(dest_operand, op_size)
{
    this.flags = (this.flags & ~1) | this.getcf();
    this.last_op1 = dest_operand;
    this.last_op2 = 1;
    this.last_add_result = this.last_result = dest_operand + 1 | 0;
    this.last_op_size = op_size;
    
    this.flags_changed = flags_all & ~1;

    return this.last_result;
}

CPU.prototype.dec = function(dest_operand, op_size)
{
    this.flags = (this.flags & ~1) | this.getcf();
    this.last_add_result = dest_operand;
    this.last_op2 = 1;
    this.last_op1 = this.last_result = dest_operand - 1 | 0;
    this.last_op_size = op_size;
    
    this.flags_changed = flags_all & ~1;

    return this.last_result;
}


/*
 * neg
 */
#define neg8(dest) neg(dest, OPSIZE_8)
#define neg16(dest) neg(dest, OPSIZE_16)
#define neg32(dest) neg(dest, OPSIZE_32)

CPU.prototype.neg = function(dest_operand, op_size)
{
    this.last_op1 = this.last_result = -dest_operand | 0;
    
    this.flags_changed = flags_all;
    this.last_add_result = 0;
    this.last_op2 = dest_operand;
    this.last_op_size = op_size;

    return this.last_result;
}


/*
 * mul, imul, div, idiv
 *
 * Note: imul has some extra opcodes
 *       while other functions only allow
 *       ax * modrm
 */

CPU.prototype.mul8 = function(source_operand)
{
    var result = source_operand * this.reg8[reg_al];

    this.reg16[reg_ax] = result;

    if(result < 0x100)
    {
        this.flags = this.flags & ~1 & ~flag_overflow;
    }
    else
    {
        this.flags = this.flags | 1 | flag_overflow;
    }

    this.flags_changed = 0;
}

CPU.prototype.imul8 = function(source_operand)
{
    var result = source_operand * this.reg8s[reg_al];

    this.reg16[reg_ax] = result;

    if(result > 0x7F || result < -0x80)
    {
        this.flags = this.flags | 1 | flag_overflow;
    }
    else
    {
        this.flags = this.flags & ~1 & ~flag_overflow;
    }
    this.flags_changed = 0;
}

CPU.prototype.mul16 = function(source_operand)
{
    var result = source_operand * this.reg16[reg_ax],
        high_result = result >>> 16;
    //console.log(h(a) + " * " + h(this.reg16[reg_ax]) + " = " + h(result));

    this.reg16[reg_ax] = result;
    this.reg16[reg_dx] = high_result;

    if(high_result === 0)
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    else
    {
        this.flags |= 1 | flag_overflow;
    }
    this.flags_changed = 0;
}

/*
 * imul with 1 argument
 * ax = ax * r/m
 */
CPU.prototype.imul16 = function(source_operand)
{
    var result = source_operand * this.reg16s[reg_ax];

    this.reg16[reg_ax] = result;
    this.reg16[reg_dx] = result >> 16;

    if(result > 0x7FFF || result < -0x8000)
    {
        this.flags |= 1 | flag_overflow;
    }
    else
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    this.flags_changed = 0;
}

/*
 * imul with 2 or 3 arguments
 * reg = reg * r/m
 * reg = imm * r/m
 */
CPU.prototype.imul_reg16 = function(operand1, operand2)
{
    dbg_assert(operand1 < 0x8000 && operand1 >= -0x8000);
    dbg_assert(operand2 < 0x8000 && operand2 >= -0x8000);

    var result = operand1 * operand2;

    if(result > 0x7FFF || result < -0x8000)
    {
        this.flags |= 1 | flag_overflow;
    }
    else
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    this.flags_changed = 0;

    return result;
}


#define do_mul32(a, b)\
    var a00 = a & 0xFFFF;\
    var a16 = a >>> 16;\
    var b00 = b & 0xFFFF;\
    var b16 = b >>> 16;\
    var low_result = a00 * b00;\
    var mid = (low_result >>> 16) + (a16 * b00 | 0) | 0;\
    var high_result = mid >>> 16;\
    mid = (mid & 0xFFFF) + (a00 * b16 | 0) | 0;\
    low_result = (mid << 16) | low_result & 0xFFFF;\
    high_result = ((mid >>> 16) + (a16 * b16 | 0) | 0) + high_result | 0;\


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

CPU.prototype.mul32 = function(source_operand)
{
    var dest_operand = this.reg32s[reg_eax];

    do_mul32(dest_operand, source_operand);

    this.reg32s[reg_eax] = low_result;
    this.reg32s[reg_edx] = high_result;

    if(high_result === 0)
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    else
    {
        this.flags |= 1 | flag_overflow;
    }
    this.flags_changed = 0;

    //console.log(h(source_operand >>> 0, 8) + " * " + h(dest_operand >>> 0, 8));
    //console.log("= " + h(this.reg32[reg_edx], 8) + ":" + h(this.reg32[reg_eax], 8));
}

CPU.prototype.imul32 = function(source_operand)
{
    dbg_assert(source_operand < 0x80000000 && source_operand >= -0x80000000);

    var dest_operand = this.reg32s[reg_eax];

    do_imul32(dest_operand, source_operand);
    
    this.reg32s[reg_eax] = low_result;
    this.reg32s[reg_edx] = high_result;

    if(high_result === (low_result >> 31))
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    else
    {
        this.flags |= 1 | flag_overflow;
    }
    this.flags_changed = 0;

    //console.log(target_operand + " * " + source_operand);
    //console.log("= " + h(this.reg32[reg_edx]) + " " + h(this.reg32[reg_eax]));
}

/*
 * imul with 2 or 3 arguments
 * reg = reg * r/m
 * reg = imm * r/m
 */
CPU.prototype.imul_reg32 = function(operand1, operand2)
{
    dbg_assert(operand1 < 0x80000000 && operand1 >= -0x80000000);
    dbg_assert(operand2 < 0x80000000 && operand2 >= -0x80000000);

    do_imul32(operand1, operand2);

    if(high_result === (low_result >> 31))
    {
        this.flags &= ~1 & ~flag_overflow;
    }
    else
    {
        this.flags |= 1 | flag_overflow;
    }
    this.flags_changed = 0;

    return low_result;

    //console.log(operand + " * " + source_operand);
    //console.log("= " + this.reg32[reg]);
}
#undef do_mul32
#undef do_imul32

CPU.prototype.div8 = function(source_operand)
{
    dbg_assert(source_operand >= 0 && source_operand < 0x100);

    var target_operand = this.reg16[reg_ax],
        result = target_operand / source_operand | 0;

    if(result >= 0x100 || source_operand === 0)
    {
        this.trigger_de();
    }
    else
    {
        this.reg8[reg_al] = result;
        this.reg8[reg_ah] = target_operand % source_operand;
    }
}

CPU.prototype.idiv8 = function(source_operand)
{
    dbg_assert(source_operand >= -0x80 && source_operand < 0x80);

    var target_operand = this.reg16s[reg_ax],
        result = target_operand / source_operand | 0;

    if(result >= 0x80 || result <= -0x81 || source_operand === 0)
    {
        this.trigger_de();
    }
    else
    {
        this.reg8[reg_al] = result;
        this.reg8[reg_ah] = target_operand % source_operand;
    }
}

CPU.prototype.div16 = function(source_operand)
{
    dbg_assert(source_operand >= 0 && source_operand < 0x10000);

    var 
        target_operand = (this.reg16[reg_ax] | this.reg16[reg_dx] << 16) >>> 0,
        result = target_operand / source_operand | 0;

    if(result >= 0x10000 || result < 0 || source_operand === 0)
    {
        this.trigger_de();
    }
    else
    {
        this.reg16[reg_ax] = result;
        this.reg16[reg_dx] = target_operand % source_operand;
    }
}

CPU.prototype.idiv16 = function(source_operand)
{
    dbg_assert(source_operand >= -0x8000 && source_operand < 0x8000);

    var target_operand = this.reg16[reg_ax] | (this.reg16[reg_dx] << 16),
        result = target_operand / source_operand | 0;
    
    if(result >= 0x8000 || result <= -0x8001 || source_operand === 0)
    {
        this.trigger_de();
    }
    else
    {    
        this.reg16[reg_ax] = result;
        this.reg16[reg_dx] = target_operand % source_operand;
    }
}

// If the dividend is too large, the division cannot be done precisely using
// JavaScript's double floating point numbers. Run simple long divsion until
// the dividend is small enough
#define do_div32(div_low, div_high, quot)\
    if(div_high >= quot || !quot) this.trigger_de();\
    var result = 0;\
    if(div_high > 0x100000) {\
        var m = 0;\
        var i = 32;\
        var q = quot;\
        while(q > div_high) {\
            q >>>= 1;\
            i--;\
        }\
        while(div_high > 0x100000) {\
            if(div_high >= q) {\
                div_high -= q;\
                var sub = quot << i >>> 0;\
                if(sub > div_low) {\
                    div_high--;\
                }\
                div_low = div_low - sub >>> 0;\
                result |= 1 << i\
            }\
            i--;\
            q >>= 1;\
        }\
        result >>>= 0;\
    }\
    var div = div_low + div_high * 0x100000000;\
    var mod = div % quot;\
    result += div / quot | 0;\


CPU.prototype.div32 = function(source_operand)
{
    dbg_assert(source_operand >= 0 && source_operand <= 0xffffffff);

    var dest_operand_low = this.reg32[reg_eax],
        dest_operand_high = this.reg32[reg_edx];

    do_div32(dest_operand_low, dest_operand_high, source_operand);

    if(result >= 0x100000000 || source_operand === 0)
    {
        dbg_log("div32 #DE: " + h(dest_operand_high, 8) + ":" + h(dest_operand_low, 8) + " div " + h(source_operand, 8));

        this.trigger_de();
    }
    else
    {    
        this.reg32s[reg_eax] = result;
        this.reg32s[reg_edx] = mod;
    }

    //console.log(h(dest_operand_high) + ":" + h(dest_operand_low) + " / " + h(source_operand));
    //console.log("= " + h(this.reg32[reg_eax]) + " rem " + h(this.reg32[reg_edx]));
}

CPU.prototype.idiv32 = function(source_operand)
{
    dbg_assert(source_operand < 0x80000000 && source_operand >= -0x80000000);

    var dest_operand_low = this.reg32[reg_eax],
        dest_operand_high = this.reg32s[reg_edx],
        div_is_neg = false,
        is_neg = false;

    if(source_operand < 0)
    {
        is_neg = true;
        source_operand = -source_operand;
    }

    if(dest_operand_high < 0)
    {
        div_is_neg = true;
        is_neg = !is_neg;
        dest_operand_low = -dest_operand_low | 0;
        dest_operand_high = ~dest_operand_high + !dest_operand_low;
    }

    do_div32(dest_operand_low, dest_operand_high, source_operand);

    if(is_neg)
    {
        result = -result | 0;
    }

    if(div_is_neg)
    {
        mod = -mod | 0;
    }

    if(result >= 0x80000000 || result <= -0x80000001 || source_operand === 0)
    {
        dbg_log("div32 #DE: " + h(dest_operand_high, 8) + ":" + h(dest_operand_low, 8) + " div " + h(source_operand, 8));
        this.trigger_de();
    }
    else
    {    
        this.reg32s[reg_eax] = result;
        this.reg32s[reg_edx] = mod;
    }

    //console.log(h(dest_operand_high) + ":" + h(dest_operand_low) + " / " + h(source_operand));
    //console.log("= " + h(this.reg32[reg_eax]) + " rem " + h(this.reg32[reg_edx]));
}


CPU.prototype.xadd8 = function(source_operand, reg)
{
    var tmp = this.reg8[reg];

    this.reg8[reg] = source_operand;

    return this.add(source_operand, tmp, OPSIZE_8);
}


CPU.prototype.xadd16 = function(source_operand, reg)
{
    var tmp = this.reg16[reg];

    this.reg16[reg] = source_operand;

    return this.add(source_operand, tmp, OPSIZE_16);
}


CPU.prototype.xadd32 = function(source_operand, reg)
{
    var tmp = this.reg32s[reg];

    this.reg32s[reg] = source_operand;

    return this.add(source_operand, tmp, OPSIZE_32);
}


CPU.prototype.bcd_daa = function()
{
    //dbg_log("daa");
    // decimal adjust after addition
    var old_al = this.reg8[reg_al],
        old_cf = this.getcf(),
        old_af = this.getaf();

    this.flags &= ~1 & ~flag_adjust

    if((old_al & 0xF) > 9 || old_af)
    {
        this.reg8[reg_al] += 6;
        this.flags |= flag_adjust;
    }
    if(old_al > 0x99 || old_cf)
    {
        this.reg8[reg_al] += 0x60;
        this.flags |= 1;
    }

    this.last_result = this.reg8[reg_al];
    this.last_op_size = OPSIZE_8;
    this.last_op1 = this.last_op2 = 0;
    this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
}

CPU.prototype.bcd_das = function()
{
    //dbg_log("das");
    // decimal adjust after subtraction
    var old_al = this.reg8[reg_al],
        old_cf = this.getcf();

    this.flags &= ~1;

    if((old_al & 0xF) > 9 || this.getaf())
    {
        this.reg8[reg_al] -= 6;
        this.flags |= flag_adjust;
        this.flags = this.flags & ~1 | old_cf | this.reg8[reg_al] >> 7;
    }
    else
    {
        this.flags &= ~flag_adjust;
    }

    if(old_al > 0x99 || old_cf)
    {
        this.reg8[reg_al] -= 0x60;
        this.flags |= 1;
    }

    this.last_result = this.reg8[reg_al];
    this.last_op_size = OPSIZE_8;
    this.last_op1 = this.last_op2 = 0;
    this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
}

CPU.prototype.bcd_aam = function()
{
    //dbg_log("aam");
    // ascii adjust after multiplication
    var imm8 = this.read_imm8();

    if(imm8 === 0)
    {
        this.trigger_de();
    }
    else
    {
        var temp = this.reg8[reg_al];
        this.reg8[reg_ah] = temp / imm8;
        this.reg8[reg_al] = temp % imm8;

        this.last_result = this.reg8[reg_al];

        this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
        this.flags &= ~1 & ~flag_adjust & ~flag_overflow;
    }
}

CPU.prototype.bcd_aad = function()
{
    //dbg_log("aad");
    // ascii adjust before division
    var imm8 = this.read_imm8();

    this.last_result = this.reg8[reg_al] + this.reg8[reg_ah] * imm8 & 0xFF;
    this.reg16[reg_ax] = this.last_result;
    this.last_op_size = OPSIZE_8;

    this.flags_changed = flags_all & ~1 & ~flag_adjust & ~flag_overflow;
    this.flags &= ~1 & ~flag_adjust & ~flag_overflow;
}

CPU.prototype.bcd_aaa = function()
{
    //dbg_log("aaa");
    if((this.reg8[reg_al] & 0xF) > 9 || this.getaf())
    {
        this.reg16[reg_ax] += 6;
        this.reg8[reg_ah] += 1;
        this.flags |= flag_adjust | 1;
    }
    else
    {
        this.flags &= ~flag_adjust & ~1;
    }
    this.reg8[reg_al] &= 0xF;

    this.flags_changed &= ~flag_adjust & ~1;
};


CPU.prototype.bcd_aas = function()
{
    //dbg_log("aas");
    if((this.reg8[reg_al] & 0xF) > 9 || this.getaf())
    {
        this.reg16[reg_ax] -= 6;
        this.reg8[reg_ah] -= 1;
        this.flags |= flag_adjust | 1;
    }
    else
    {
        this.flags &= ~flag_adjust & ~1;
    }
    this.reg8[reg_al] &= 0xF;

    this.flags_changed &= ~flag_adjust & ~1;
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

#define and8(dest, src)  cpu.and(dest, src, OPSIZE_8)
#define and16(dest, src) cpu.and(dest, src, OPSIZE_16)
#define and32(dest, src) cpu.and(dest, src, OPSIZE_32)

#define test8(dest, src)  cpu.and(dest, src, OPSIZE_8)
#define test16(dest, src) cpu.and(dest, src, OPSIZE_16)
#define test32(dest, src) cpu.and(dest, src, OPSIZE_32)

#define or8(dest, src)  cpu.or(dest, src, OPSIZE_8)
#define or16(dest, src) cpu.or(dest, src, OPSIZE_16)
#define or32(dest, src) cpu.or(dest, src, OPSIZE_32)

#define xor8(dest, src)  cpu.xor(dest, src, OPSIZE_8)
#define xor16(dest, src) cpu.xor(dest, src, OPSIZE_16)
#define xor32(dest, src) cpu.xor(dest, src, OPSIZE_32)

CPU.prototype.and = function(dest_operand, source_operand, op_size)
{
    this.last_result = dest_operand & source_operand;
    
    this.last_op_size = op_size;
    this.flags &= ~1 & ~flag_overflow & ~flag_adjust;
    this.flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;

    return this.last_result;
}

CPU.prototype.or = function(dest_operand, source_operand, op_size)
{
    this.last_result = dest_operand | source_operand;
    
    this.last_op_size = op_size;
    this.flags &= ~1 & ~flag_overflow & ~flag_adjust;
    this.flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;

    return this.last_result;
}

CPU.prototype.xor = function(dest_operand, source_operand, op_size)
{
    this.last_result = dest_operand ^ source_operand;
    
    this.last_op_size = op_size;
    this.flags &= ~1 & ~flag_overflow & ~flag_adjust;
    this.flags_changed = flags_all & ~1 & ~flag_overflow & ~flag_adjust;

    return this.last_result;
}


/*
 * rotates and shifts
 */

CPU.prototype.rol8 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }
    count &= 7;

    var result = dest_operand << count | dest_operand >> (8 - count);

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (result & 1)
                | (result << 11 ^ result << 4) & flag_overflow;

    return result;
}

CPU.prototype.rol16 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }
    count &= 15;

    var result = dest_operand << count | dest_operand >> (16 - count);

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (result & 1)
                | (result << 11 ^ result >> 4) & flag_overflow;

    return result;
}

CPU.prototype.rol32 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand << count | dest_operand >>> (32 - count);

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (result & 1)
                | (result << 11 ^ result >> 20) & flag_overflow;

    return result;
}

CPU.prototype.rcl8 = function(dest_operand, count)
{
    count %= 9;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand << count | this.getcf() << (count - 1) | dest_operand >> (9 - count);

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (result >> 8 & 1)
                | (result << 3 ^ result << 4) & flag_overflow;

    return result;
}

CPU.prototype.rcl16 = function(dest_operand, count)
{
    count %= 17;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand << count | this.getcf() << (count - 1) | dest_operand >> (17 - count);

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (result >> 16 & 1) 
                | (result >> 5 ^ result >> 4) & flag_overflow;

    return result;
}

CPU.prototype.rcl32 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand << count | this.getcf() << (count - 1);

    if(count > 1)
    {
        result |= dest_operand >>> (33 - count);
    }

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >>> (32 - count) & 1);
    this.flags |= (this.flags << 11 ^ result >> 20) & flag_overflow;

    return result;
}

CPU.prototype.ror8 = function(dest_operand, count)
{
    count &= 7;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >> count | dest_operand << (8 - count);

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (result >> 7 & 1)
                | (result << 4 ^ result << 5) & flag_overflow;

    return result;
} 

CPU.prototype.ror16 = function(dest_operand, count)
{
    count &= 15;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >> count | dest_operand << (16 - count);

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (result >> 15 & 1) 
                | (result >> 4 ^ result >> 3) & flag_overflow;

    return result;
}    

CPU.prototype.ror32 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >>> count | dest_operand << (32 - count);

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (result >> 31 & 1) 
                | (result >> 20 ^ result >> 19) & flag_overflow;

    return result;
}

CPU.prototype.rcr8 = function(dest_operand, count)
{
    count %= 9;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >> count | this.getcf() << (8 - count) | dest_operand << (9 - count);

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (result >> 8 & 1)
                | (result << 4 ^ result << 5) & flag_overflow;

    return result;
}    

CPU.prototype.rcr16 = function(dest_operand, count)
{
    count %= 17;
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >> count | this.getcf() << (16 - count) | dest_operand << (17 - count);

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (result >> 16 & 1)
                | (result >> 4 ^ result >> 3) & flag_overflow;

    return result;
}

CPU.prototype.rcr32 = function(dest_operand, count)
{
    if(!count)
    {
        return dest_operand;
    }

    var result = dest_operand >>> count | this.getcf() << (32 - count);

    if(count > 1)
    {
        result |= dest_operand << (33 - count);
    }

    this.flags_changed &= ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (dest_operand >> (count - 1) & 1)
                | (result >> 20 ^ result >> 19) & flag_overflow;

    return result;
}

CPU.prototype.shl8 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    this.last_result = dest_operand << count;

    this.last_op_size = OPSIZE_8;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (this.last_result >> 8 & 1)
                | (this.last_result << 3 ^ this.last_result << 4) & flag_overflow;

    return this.last_result;
}

CPU.prototype.shl16 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    this.last_result = dest_operand << count;

    this.last_op_size = OPSIZE_16;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (this.last_result >> 16 & 1)
                | (this.last_result >> 5 ^ this.last_result >> 4) & flag_overflow;

    return this.last_result;
}

CPU.prototype.shl32 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    this.last_result = dest_operand << count;

    this.last_op_size = OPSIZE_32;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    // test this
    this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >>> (32 - count) & 1);
    this.flags |= ((this.flags & 1) ^ (this.last_result >> 31 & 1)) << 11 & flag_overflow;

    return this.last_result;
}
    
CPU.prototype.shr8 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    this.last_result = dest_operand >> count;

    this.last_op_size = OPSIZE_8;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (dest_operand >> (count - 1) & 1)
                | (dest_operand >> 7 & 1) << 11 & flag_overflow;

    return this.last_result;
}    

CPU.prototype.shr16 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    this.last_result = dest_operand >> count;

    this.last_op_size = OPSIZE_16;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (dest_operand >> (count - 1) & 1) 
                | (dest_operand >> 4)  & flag_overflow;

    return this.last_result;
}    

CPU.prototype.shr32 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    this.last_result = dest_operand >>> count;

    this.last_op_size = OPSIZE_32;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) 
                | (dest_operand >>> (count - 1) & 1)
                | (dest_operand >> 20) & flag_overflow;

    return this.last_result;
}

CPU.prototype.sar8 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    this.last_result = dest_operand >> count;

    this.last_op_size = OPSIZE_8;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >> (count - 1) & 1);
    // of is zero

    return this.last_result;
}    

CPU.prototype.sar16 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    this.last_result = dest_operand >> count;

    this.last_op_size = OPSIZE_16;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >> (count - 1) & 1);

    return this.last_result;
}

CPU.prototype.sar32 = function(dest_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    this.last_result = dest_operand >> count;

    this.last_op_size = OPSIZE_32;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1 & ~flag_overflow) | (dest_operand >>> (count - 1) & 1);

    return this.last_result;
}


CPU.prototype.shrd16 = function(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    if(count <= 16)
    {
        this.last_result = dest_operand >> count | source_operand << (16 - count);
        this.flags = (this.flags & ~1) | (dest_operand >> (count - 1) & 1);
    }
    else
    {
        this.last_result = dest_operand << (32 - count) | source_operand >> (count - 16);
        this.flags = (this.flags & ~1) | (source_operand >> (count - 17) & 1);
    }

    this.last_op_size = OPSIZE_16;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~flag_overflow) | ((this.last_result ^ dest_operand) >> 4 & flag_overflow);

    return this.last_result;
}

CPU.prototype.shrd32 = function(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    this.last_result = dest_operand >>> count | source_operand << (32 - count);

    this.last_op_size = OPSIZE_32;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1) | (dest_operand >>> (count - 1) & 1);
    this.flags = (this.flags & ~flag_overflow) | ((this.last_result ^ dest_operand) >> 20 & flag_overflow);

    return this.last_result;
}

CPU.prototype.shld16 = function(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    if(count <= 16)
    {
        this.last_result = dest_operand << count | source_operand >>> (16 - count);
        this.flags = (this.flags & ~1) | (dest_operand >>> (16 - count) & 1);
    }
    else
    {
        this.last_result = dest_operand >> (32 - count) | source_operand << (count - 16);
        this.flags = (this.flags & ~1) | (source_operand >>> (32 - count) & 1);
    }

    this.last_op_size = OPSIZE_16;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~flag_overflow) | ((this.flags & 1) ^ (this.last_result >> 15 & 1)) << 11;

    return this.last_result;
}

CPU.prototype.shld32 = function(dest_operand, source_operand, count)
{
    if(count === 0)
    {
        return dest_operand;
    }

    this.last_result = dest_operand << count | source_operand >>> (32 - count);

    this.last_op_size = OPSIZE_32;
    this.flags_changed = flags_all & ~1 & ~flag_overflow;
    this.flags = (this.flags & ~1) | (dest_operand >>> (32 - count) & 1);
    this.flags = (this.flags & ~flag_overflow) | ((this.flags & 1) ^ (this.last_result >> 31 & 1)) << 11;

    return this.last_result;
}


CPU.prototype.bt_reg = function(bit_base, bit_offset)
{
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;
}

CPU.prototype.btc_reg = function(bit_base, bit_offset)
{
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;

    return bit_base ^ 1 << bit_offset;
}

CPU.prototype.bts_reg = function(bit_base, bit_offset)
{
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;

    return bit_base | 1 << bit_offset;
}

CPU.prototype.btr_reg = function(bit_base, bit_offset)
{
    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;

    return bit_base & ~(1 << bit_offset);
}

CPU.prototype.bt_mem = function(virt_addr, bit_offset)
{
    var bit_base = this.safe_read8(virt_addr + (bit_offset >> 3));
    bit_offset &= 7;

    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;
}

CPU.prototype.btc_mem = function(virt_addr, bit_offset)
{
    var phys_addr = this.translate_address_write(virt_addr + (bit_offset >> 3));
    var bit_base = this.memory.read8(phys_addr);

    bit_offset &= 7;

    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;

    this.memory.write8(phys_addr, bit_base ^ 1 << bit_offset);
}

CPU.prototype.btr_mem = function(virt_addr, bit_offset)
{
    var phys_addr = this.translate_address_write(virt_addr + (bit_offset >> 3));
    var bit_base = this.memory.read8(phys_addr);

    bit_offset &= 7;

    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;

    this.memory.write8(phys_addr, bit_base & ~(1 << bit_offset));
}

CPU.prototype.bts_mem = function(virt_addr, bit_offset)
{
    var phys_addr = this.translate_address_write(virt_addr + (bit_offset >> 3));
    var bit_base = this.memory.read8(phys_addr);

    bit_offset &= 7;

    this.flags = (this.flags & ~1) | (bit_base >> bit_offset & 1);
    this.flags_changed &= ~1;

    this.memory.write8(phys_addr, bit_base | 1 << bit_offset);
}

CPU.prototype.bsf16 = function(old, bit_base)
{
    this.flags_changed = 0;

    if(bit_base === 0)
    {
        this.flags |= flag_zero;
        
        // not defined in the docs, but value doesn't change on my intel this
        return old;
    }
    else
    {
        this.flags &= ~flag_zero;

        // http://jsperf.com/lowest-bit-index
        return v86util.int_log2(-bit_base & bit_base);
    }
}

CPU.prototype.bsf32 = function(old, bit_base)
{
    this.flags_changed = 0;

    if(bit_base === 0)
    {
        this.flags |= flag_zero;

        return old;
    }
    else
    {
        this.flags &= ~flag_zero;

        return v86util.int_log2((-bit_base & bit_base) >>> 0);
    }
}

CPU.prototype.bsr16 = function(old, bit_base)
{
    this.flags_changed = 0;

    if(bit_base === 0)
    {
        this.flags |= flag_zero;
        return old;
    }
    else
    {
        this.flags &= ~flag_zero;

        return v86util.int_log2(bit_base);
    }
}

CPU.prototype.bsr32 = function(old, bit_base)
{
    this.flags_changed = 0;

    if(bit_base === 0)
    {
        this.flags |= flag_zero;
        return old;
    }
    else
    {
        this.flags &= ~flag_zero;
        return v86util.int_log2(bit_base >>> 0);
    }
}

CPU.prototype.popcnt = function(v)
{
    this.flags_changed = 0;
    this.flags &= ~flag_overflow & ~flag_sign & ~flag_zero 
                & ~flag_adjust & ~flag_parity & ~1;

    if(v)
    {
        // http://graphics.stanford.edu/~seander/bithacks.html#CountBitsSetParallel
        v = v - ((v >> 1) & 0x55555555);
        v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
        return ((v + (v >> 4) & 0xF0F0F0F) * 0x1010101) >> 24;
    }
    else
    {
        this.flags |= flag_zero;
        return 0;
    }
};
