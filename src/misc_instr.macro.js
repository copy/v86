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

v86.prototype.jmp_rel16 = function(rel16)
{
    var current_cs = this.get_seg(reg_cs);

    // limit ip to 16 bit
    // ugly
    this.instruction_pointer -= current_cs;
    this.instruction_pointer = (this.instruction_pointer + rel16) & 0xFFFF;
    this.instruction_pointer = this.instruction_pointer + current_cs | 0;

    this.last_instr_jump = true;
}

v86.prototype.jmpcc16 = function(condition)
{
    if(condition)
    {
        this.jmp_rel16(this.read_imm16());
    }
    else
    {
        this.instruction_pointer = this.instruction_pointer + 2 | 0;
    }

    this.last_instr_jump = true;
}


v86.prototype.jmpcc32 = function(condition)
{
    if(condition)
    {
        // don't change to `this.instruction_pointer += this.read_imm32s()`,
        //   since read_imm32s modifies instruction_pointer

        var imm32s = this.read_imm32s();
        this.instruction_pointer = this.instruction_pointer + imm32s | 0;
    }
    else
    {
        this.instruction_pointer = this.instruction_pointer + 4 | 0;
    }

    this.last_instr_jump = true;
}

v86.prototype.loopne = function()
{
    if(--this.regv[this.reg_vcx] && !this.getzf())
    {
        var imm8s = this.read_imm8s();
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
    }
    else
    {
        this.instruction_pointer++;
    }

    this.last_instr_jump = true;
}

v86.prototype.loope = function()
{
    if(--this.regv[this.reg_vcx] && this.getzf())
    {
        var imm8s = this.read_imm8s();
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
    }
    else
    {
        this.instruction_pointer++;
    }

    this.last_instr_jump = true;
}

v86.prototype.loop = function()
{
    if(--this.regv[this.reg_vcx])
    {
        var imm8s = this.read_imm8s();
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
    }
    else
    {
        this.instruction_pointer++;
    }

    this.last_instr_jump = true;
}

v86.prototype.jcxz = function()
{
    var imm8s = this.read_imm8s();

    if(this.regv[this.reg_vcx] === 0)
    {
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
    }

    this.last_instr_jump = true;
};

/** 
 * @return {number}
 * @const
 */
v86.prototype.getcf = function()
{
    if(this.flags_changed & 1)
    {
        return (this.last_op1 ^ (this.last_op1 ^ this.last_op2) & (this.last_op2 ^ this.last_add_result)) >>> this.last_op_size & 1;
    }
    else
    {
        return this.flags & 1;
    }
};

/** @return {number} */
v86.prototype.getpf = function()
{
    if(this.flags_changed & flag_parity)
    {
        // inverted lookup table
        return 0x9669 << 2 >> ((this.last_result ^ this.last_result >> 4) & 0xF) & flag_parity;
    }
    else
    {
        return this.flags & flag_parity;
    }
};

/** @return {number} */
v86.prototype.getaf = function()
{
    if(this.flags_changed & flag_adjust)
    {
        return (this.last_op1 ^ this.last_op2 ^ this.last_add_result) & flag_adjust;
    }
    else
    {
        return this.flags & flag_adjust;
    }
};

/** @return {number} */
v86.prototype.getzf = function()
{
    if(this.flags_changed & flag_zero)
    {
        return (~this.last_result & this.last_result - 1) >>> this.last_op_size & 1;
    }
    else
    {
        return this.flags & flag_zero;
    }
};

/** @return {number} */
v86.prototype.getsf = function()
{
    if(this.flags_changed & flag_sign)
    {
        return this.last_result >>> this.last_op_size & 1;
    }
    else
    {
        return this.flags & flag_sign;
    }
};

/** @return {number} */
v86.prototype.getof = function()
{
    if(this.flags_changed & flag_overflow)
    {
        return ((this.last_op1 ^ this.last_add_result) & (this.last_op2 ^ this.last_add_result)) >>> this.last_op_size & 1;
    }
    else
    {
        return this.flags & flag_overflow;
    }
};

v86.prototype.test_o = v86.prototype.getof;
v86.prototype.test_b = v86.prototype.getcf;
v86.prototype.test_z = v86.prototype.getzf;
v86.prototype.test_s = v86.prototype.getsf;
v86.prototype.test_p = v86.prototype.getpf;

v86.prototype.test_be = function()
{
    // Idea:
    //    return this.last_op1 <= this.last_op2;
    return this.getcf() || this.getzf();
}

v86.prototype.test_l = function()
{
    // Idea:
    //    return this.last_add_result < this.last_op2;
    return !this.getsf() !== !this.getof();
}

v86.prototype.test_le = function()
{
    // Idea:
    //    return this.last_add_result <= this.last_op2;
    return this.getzf() || !this.getsf() !== !this.getof();
}



v86.prototype.push16 = function(imm16)
{
    var sp = this.get_stack_pointer(-2);

    this.safe_write16(sp, imm16);
    this.stack_reg[this.reg_vsp] -= 2;
}

v86.prototype.push32 = function(imm32)
{
    var sp = this.get_stack_pointer(-4);

    this.safe_write32(sp, imm32);
    this.stack_reg[this.reg_vsp] -= 4;
}

v86.prototype.pop16 = function()
{
    var sp = this.get_stack_pointer(0),
        result = this.safe_read16(sp);

    this.stack_reg[this.reg_vsp] += 2;
    return result;
}

v86.prototype.pop32s = function()
{
    var sp = this.get_stack_pointer(0),
        result = this.safe_read32s(sp);

    this.stack_reg[this.reg_vsp] += 4;
    return result;
}

v86.prototype.pusha16 = function()
{
    var temp = this.reg16[reg_sp];

    // make sure we don't get a pagefault after having 
    // pushed several registers already
    this.translate_address_write(this.get_seg(reg_ss) + temp - 15);

    this.push16(this.reg16[reg_ax]);
    this.push16(this.reg16[reg_cx]);
    this.push16(this.reg16[reg_dx]);
    this.push16(this.reg16[reg_bx]);
    this.push16(temp);
    this.push16(this.reg16[reg_bp]);
    this.push16(this.reg16[reg_si]);
    this.push16(this.reg16[reg_di]);
}

v86.prototype.pusha32 = function()
{
    var temp = this.reg32s[reg_esp];

    this.translate_address_write(this.get_seg(reg_ss) + temp - 31);

    this.push32(this.reg32s[reg_eax]);
    this.push32(this.reg32s[reg_ecx]);
    this.push32(this.reg32s[reg_edx]);
    this.push32(this.reg32s[reg_ebx]);
    this.push32(temp);
    this.push32(this.reg32s[reg_ebp]);
    this.push32(this.reg32s[reg_esi]);
    this.push32(this.reg32s[reg_edi]);
}

v86.prototype.popa16 = function()
{
    this.translate_address_read(this.get_seg(reg_ss) + this.stack_reg[this.reg_vsp] + 15);

    this.reg16[reg_di] = this.pop16();
    this.reg16[reg_si] = this.pop16();
    this.reg16[reg_bp] = this.pop16();
    this.stack_reg[this.reg_vsp] += 2;
    this.reg16[reg_bx] = this.pop16();
    this.reg16[reg_dx] = this.pop16();
    this.reg16[reg_cx] = this.pop16();
    this.reg16[reg_ax] = this.pop16();
}

v86.prototype.popa32 = function()
{
    this.translate_address_read(this.get_seg(reg_ss) + this.stack_reg[this.reg_vsp] + 31);

    this.reg32s[reg_edi] = this.pop32s();
    this.reg32s[reg_esi] = this.pop32s();
    this.reg32s[reg_ebp] = this.pop32s();
    this.stack_reg[this.reg_vsp] += 4;
    this.reg32s[reg_ebx] = this.pop32s();
    this.reg32s[reg_edx] = this.pop32s();
    this.reg32s[reg_ecx] = this.pop32s();
    this.reg32s[reg_eax] = this.pop32s();
}

v86.prototype.xchg8 = function(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1,
        tmp = this.reg8[mod];

    this.reg8[mod] = memory_data;

    return tmp;
}

v86.prototype.xchg16 = function(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 2 & 14,
        tmp = this.reg16[mod];

    this.reg16[mod] = memory_data;

    return tmp;
}

v86.prototype.xchg16r = function(operand)
{
    var temp = this.reg16[reg_ax];
    this.reg16[reg_ax] = this.reg16[operand];
    this.reg16[operand] = temp;
}

v86.prototype.xchg32 = function(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 3 & 7,
        tmp = this.reg32s[mod];

    this.reg32s[mod] = memory_data;

    return tmp;
}

v86.prototype.xchg32r = function(operand)
{
    var temp = this.reg32s[reg_eax];
    this.reg32s[reg_eax] = this.reg32s[operand];
    this.reg32s[operand] = temp;
}

v86.prototype.lss16 = function(seg, addr, mod)
{
    var new_reg = this.safe_read16(addr),
        new_seg = this.safe_read16(addr + 2);

    this.switch_seg(seg, new_seg);

    this.reg16[mod] = new_reg;
}

v86.prototype.lss32 = function(seg, addr, mod)
{
    var new_reg = this.safe_read32s(addr),
        new_seg = this.safe_read16(addr + 4);

    this.switch_seg(seg, new_seg);

    this.reg32s[mod] = new_reg;
}

v86.prototype.enter16 = function()
{
    var size = this.read_imm16(),
        nesting_level = this.read_imm8() & 31,
        frame_temp,
        tmp_ebp;

    //dbg_log("enter16 size=" + size + " nest=" + nesting_level, LOG_CPU);
    this.push16(this.reg16[reg_bp]);
    frame_temp = this.reg16[reg_sp];

    if(nesting_level > 0)
    {
        tmp_ebp = this.reg16[reg_ebp];
        for(var i = 1; i < nesting_level; i++)
        {
            tmp_ebp -= 2;
            this.push16(this.safe_read16(this.get_seg(reg_ss) + tmp_ebp | 0));
        }
        this.push16(frame_temp);
    }
    this.reg16[reg_bp] = frame_temp;
    this.reg16[reg_sp] -= size;
};

v86.prototype.enter32 = function()
{
    var size = this.read_imm16(),
        nesting_level = this.read_imm8() & 31,
        frame_temp,
        tmp_ebp;

    //dbg_log("enter32 size=" + size + " nest=" + nesting_level, LOG_CPU);
    this.push32(this.reg32s[reg_ebp]);
    frame_temp = this.reg32s[reg_esp];

    if(nesting_level > 0)
    {
        tmp_ebp = this.reg32s[reg_ebp];
        for(var i = 1; i < nesting_level; i++)
        {
            tmp_ebp -= 4;
            this.push32(this.safe_read32s(this.get_seg(reg_ss) + tmp_ebp | 0));
        }
        this.push32(frame_temp);
    }
    this.reg32s[reg_ebp] = frame_temp;
    this.reg32s[reg_esp] -= size;
};

v86.prototype.bswap = function(reg)
{
    var temp = this.reg32s[reg];

    this.reg32s[reg] = temp >>> 24 | temp << 24 | (temp >> 8 & 0xFF00) | (temp << 8 & 0xFF0000);
}

