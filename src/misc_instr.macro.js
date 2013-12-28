/*
 * Some miscellaneous instructions:
 *
 * jmpcc16, jmpcc32, jmp16
 * loop, loope, loopne, jcxz
 * test_cc
 *
 * mov, push, pop
 * pusha, popa
 * xchg, lss
 * lea
 * enter
 * bswap
 *
 * Gets #included by cpu.macro.js
 */
"use strict";

function jmp_rel16(rel16)
{
    var current_cs = get_seg(reg_cs);

    // limit ip to 16 bit
    // ugly
    instruction_pointer -= current_cs;
    instruction_pointer = (instruction_pointer + rel16) & 0xFFFF;
    instruction_pointer = instruction_pointer + current_cs | 0;
}

function jmpcc16(condition)
{
    if(condition)
    {
        jmp_rel16(read_imm16());
    }
    else
    {
        instruction_pointer += 2;
    }
}


function jmpcc32(condition)
{
    if(condition)
    {
        // don't write `instruction_pointer += read_imm32s()`
        var imm32s = read_imm32s();
        instruction_pointer = instruction_pointer + imm32s | 0;
    }
    else
    {
        instruction_pointer = instruction_pointer + 4 | 0;
    }
}

function loopne()
{
    if(--regv[reg_vcx] && !getzf())
    {
        var imm8s = read_imm8s();
        instruction_pointer = instruction_pointer + imm8s | 0;
    }
    else
    {
        instruction_pointer++;
    }
}

function loope()
{
    if(--regv[reg_vcx] && getzf())
    {
        var imm8s = read_imm8s();
        instruction_pointer = instruction_pointer + imm8s | 0;
    }
    else
    {
        instruction_pointer++;
    }
}

function loop()
{
    if(--regv[reg_vcx])
    {
        var imm8s = read_imm8s();
        instruction_pointer = instruction_pointer + imm8s | 0;
    }
    else
    {
        instruction_pointer++;
    }
}

function jcxz()
{
    var imm8s = read_imm8s();

    if(regv[reg_vcx] === 0)
    {
        instruction_pointer = instruction_pointer + imm8s | 0;
    }
}

var test_o = getof,
    test_b = getcf,
    test_z = getzf,
    test_s = getsf,
    test_p = getpf;

function test_be()
{
    return getcf() || getzf();
}

function test_l()
{
    return !getsf() !== !getof();
}

function test_le()
{
    return getzf() || !getsf() !== !getof();
}

/** 
 * @return {number}
 * @const
 */
function getcf()
{
    if(flags_changed & 1)
    {
        if(last_op_size === OPSIZE_32)
        {
            // cannot bit test above 2^32-1
            return last_result > 0xffffffff | last_result < 0;
            //return ((last_op1 ^ last_result) & (last_op2 ^ last_result)) >>> 31;
        }
        else
        {
            return last_result >> last_op_size & 1;
        }

        //return last_result >= (1 << last_op_size) | last_result < 0;
    }
    else
    {
        return flags & 1;
    }
}

/** @return {number} */
function getpf()
{
    if(flags_changed & flag_parity)
    {
        // inverted lookup table
        return 0x9669 << 2 >> ((last_result ^ last_result >> 4) & 0xF) & flag_parity;
    }
    else
    {
        return flags & flag_parity;
    }
}

/** @return {number} */
function getaf()
{
    if(flags_changed & flag_adjust)
    {
        return (last_op1 ^ last_op2 ^ last_result ^ (last_op2 < 0) << 4) & flag_adjust;
    }
    else
    {
        return flags & flag_adjust;
    }
}

/** @return {number} */
function getzf()
{
    if(flags_changed & flag_zero)
    {
        return (~last_result & last_result - 1) >> last_op_size - 7 & flag_zero;
    }
    else
    {
        return flags & flag_zero;
    }
}

/** @return {number} */
function getsf()
{
    if(flags_changed & flag_sign)
    {
        return last_result >> last_op_size - 8 & flag_sign;
    }
    else
    {
        return flags & flag_sign;
    }
}

/** @return {number} */
function getof()
{
    if(flags_changed & flag_overflow)
    {
        return (((last_op1 ^ last_result) & (last_op2 ^ last_result)) >> last_op_size - 1) << 11 & flag_overflow;
    }
    else
    {
        return flags & flag_overflow;
    }
}


function push16(imm16)
{
    var sp = get_esp_write(-2);

    safe_write16(sp, imm16);
    stack_reg[reg_vsp] -= 2;
}

function push32(imm32)
{
    var sp = get_esp_write(-4);

    safe_write32(sp, imm32);
    stack_reg[reg_vsp] -= 4;
}

function pop16()
{
    var sp = get_esp_read(0),
        result = safe_read16(sp);

    stack_reg[reg_vsp] += 2;
    return result;
}

function pop32s()
{
    var sp = get_esp_read(0),
        result = safe_read32s(sp);

    stack_reg[reg_vsp] += 4;
    return result;
}

function pusha16()
{
    var temp = reg16[reg_sp];

    // make sure we don't get a pagefault after having 
    // pushed several registers already
    translate_address_write(temp - 15);

    push16(reg16[reg_ax]);
    push16(reg16[reg_cx]);
    push16(reg16[reg_dx]);
    push16(reg16[reg_bx]);
    push16(temp);
    push16(reg16[reg_bp]);
    push16(reg16[reg_si]);
    push16(reg16[reg_di]);
}

function pusha32()
{
    var temp = reg32s[reg_esp];

    translate_address_write(temp - 31);

    push32(reg32s[reg_eax]);
    push32(reg32s[reg_ecx]);
    push32(reg32s[reg_edx]);
    push32(reg32s[reg_ebx]);
    push32(temp);
    push32(reg32s[reg_ebp]);
    push32(reg32s[reg_esi]);
    push32(reg32s[reg_edi]);
}

function popa16()
{
    translate_address_read(stack_reg[reg_vsp] + 15);

    reg16[reg_di] = pop16();
    reg16[reg_si] = pop16();
    reg16[reg_bp] = pop16();
    stack_reg[reg_vsp] += 2;
    reg16[reg_bx] = pop16();
    reg16[reg_dx] = pop16();
    reg16[reg_cx] = pop16();
    reg16[reg_ax] = pop16();
}

function popa32()
{
    translate_address_read(stack_reg[reg_vsp] + 31);

    reg32[reg_edi] = pop32s();
    reg32[reg_esi] = pop32s();
    reg32[reg_ebp] = pop32s();
    stack_reg[reg_vsp] += 4;
    reg32[reg_ebx] = pop32s();
    reg32[reg_edx] = pop32s();
    reg32[reg_ecx] = pop32s();
    reg32[reg_eax] = pop32s();
}

function xchg8(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1,
        tmp = reg8[mod];

    reg8[mod] = memory_data;

    return tmp;
}

function xchg16(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 2 & 14,
        tmp = reg16[mod];

    reg16[mod] = memory_data;

    return tmp;
}

function xchg16r(operand)
{
    var temp = reg16[reg_ax];
    reg16[reg_ax] = reg16[operand];
    reg16[operand] = temp;
}

function xchg32(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 3 & 7,
        tmp = reg32s[mod];

    reg32[mod] = memory_data;

    return tmp;
}

function xchg32r(operand)
{
    var temp = reg32s[reg_eax];
    reg32[reg_eax] = reg32s[operand];
    reg32[operand] = temp;
}

function lss16(seg, addr, mod)
{
    var new_reg = safe_read16(addr),
        new_seg = safe_read16(addr + 2);

    switch_seg(seg, new_seg);

    reg16[mod] = new_reg;
}

function lss32(seg, addr, mod)
{
    var new_reg = safe_read32s(addr),
        new_seg = safe_read16(addr + 4);

    switch_seg(seg, new_seg);

    reg32[mod] = new_reg;
}

function lea16()
{
    var modrm_byte = read_imm8(),
        mod = modrm_byte >> 3 & 7;

    // override prefix, so modrm16 does not return the segment part
    segment_prefix = reg_noseg; 

    reg16[mod << 1] = modrm_resolve(modrm_byte);

    segment_prefix = -1;
}

function lea32()
{
    var modrm_byte = read_imm8(),
        mod = modrm_byte >> 3 & 7;

    segment_prefix = reg_noseg; 

    reg32[mod] = modrm_resolve(modrm_byte);

    segment_prefix = -1;
}

function enter16()
{
    var size = read_imm16(),
        nesting_level = read_imm8(),
        frame_temp;
    
    push16(reg16[reg_bp]);
    frame_temp = reg16[reg_sp];

    if(nesting_level > 0)
    {
        for(var i = 1; i < nesting_level; i++)
        {
            reg16[reg_bp] -= 2;
            push16(reg16[reg_bp]);
        }
        push16(frame_temp);
    }
    reg16[reg_bp] = frame_temp;
    reg16[reg_sp] = frame_temp - size;

    dbg_assert(!page_fault);
}

function enter32()
{
    var size = read_imm16(),
        nesting_level = read_imm8() & 31,
        frame_temp;

    push32(reg32s[reg_ebp]);
    frame_temp = reg32s[reg_esp];

    if(nesting_level > 0)
    {
        for(var i = 1; i < nesting_level; i++)
        {
            reg32[reg_ebp] -= 4;
            push32(reg32s[reg_ebp]);
        }
        push32(frame_temp);
    }
    reg32[reg_ebp] = frame_temp;
    reg32[reg_esp] -= size;

    dbg_assert(!page_fault);
}

function bswap(reg)
{
    var temp = reg32s[reg];

    reg32[reg] = temp >>> 24 | temp << 24 | (temp >> 8 & 0xFF00) | (temp << 8 & 0xFF0000);
}

