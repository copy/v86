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
 * fxsave, fxrstor
 */
"use strict";

CPU.prototype.jmpcc8 = function(condition)
{
    var imm8 = this.read_op8s();
    if(condition)
    {
        this.instruction_pointer = this.instruction_pointer + imm8 | 0;
        this.branch_taken();
    }
    else
    {
        this.branch_not_taken();
    }
};

CPU.prototype.jmp_rel16 = function(rel16)
{
    var current_cs = this.get_seg(reg_cs);

    // limit ip to 16 bit
    // ugly
    this.instruction_pointer -= current_cs;
    this.instruction_pointer = (this.instruction_pointer + rel16) & 0xFFFF;
    this.instruction_pointer = this.instruction_pointer + current_cs | 0;
};

CPU.prototype.jmpcc16 = function(condition)
{
    var imm16 = this.read_op16();
    if(condition)
    {
        this.jmp_rel16(imm16);
        this.branch_taken();
    }
    else
    {
        this.branch_not_taken();
    }
}


CPU.prototype.jmpcc32 = function(condition)
{
    var imm32s = this.read_op32s();
    if(condition)
    {
        // don't change to `this.instruction_pointer += this.read_op32s()`,
        //   since read_op32s modifies instruction_pointer

        this.instruction_pointer = this.instruction_pointer + imm32s | 0;
        this.branch_taken();
    }
    else
    {
        this.branch_not_taken();
    }
};

CPU.prototype.cmovcc16 = function(condition)
{
    var data = this.read_e16();
    if(condition)
    {
        this.write_g16(data);
    }
};

CPU.prototype.cmovcc32 = function(condition)
{
    var data = this.read_e32s();
    if(condition)
    {
        this.write_g32(data);
    }
};

CPU.prototype.setcc = function(condition)
{
    this.set_e8(condition ? 1 : 0)
};

CPU.prototype.loopne = function(imm8s)
{
    if(this.decr_ecx_asize() && !this.getzf())
    {
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
        this.branch_taken();
    }
    else
    {
        this.branch_not_taken();
    }
}

CPU.prototype.loope = function(imm8s)
{
    if(this.decr_ecx_asize() && this.getzf())
    {
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
        this.branch_taken();
    }
    else
    {
        this.branch_not_taken();
    }
}

CPU.prototype.loop = function(imm8s)
{
    if(this.decr_ecx_asize())
    {
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
        this.branch_taken();
    }
    else
    {
        this.branch_not_taken();
    }
}

CPU.prototype.jcxz = function(imm8s)
{
    if(this.get_reg_asize(reg_ecx) === 0)
    {
        this.instruction_pointer = this.instruction_pointer + imm8s | 0;
        this.branch_taken();
    }
    else
    {
        this.branch_not_taken();
    }
};

/**
 * @return {number}
 * @const
 */
CPU.prototype.getcf = function()
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
CPU.prototype.getpf = function()
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
CPU.prototype.getaf = function()
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
CPU.prototype.getzf = function()
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
CPU.prototype.getsf = function()
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
CPU.prototype.getof = function()
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

CPU.prototype.test_o = CPU.prototype.getof;
CPU.prototype.test_b = CPU.prototype.getcf;
CPU.prototype.test_z = CPU.prototype.getzf;
CPU.prototype.test_s = CPU.prototype.getsf;
CPU.prototype.test_p = CPU.prototype.getpf;

CPU.prototype.test_be = function()
{
    // Idea:
    //    return this.last_op1 <= this.last_op2;
    return this.getcf() || this.getzf();
}

CPU.prototype.test_l = function()
{
    // Idea:
    //    return this.last_add_result < this.last_op2;
    return !this.getsf() !== !this.getof();
}

CPU.prototype.test_le = function()
{
    // Idea:
    //    return this.last_add_result <= this.last_op2;
    return this.getzf() || !this.getsf() !== !this.getof();
}



CPU.prototype.push16 = function(imm16)
{
    var sp = this.get_stack_pointer(-2);

    this.safe_write16(sp, imm16);
    this.adjust_stack_reg(-2);
}

CPU.prototype.push32 = function(imm32)
{
    var sp = this.get_stack_pointer(-4);

    this.safe_write32(sp, imm32);
    this.adjust_stack_reg(-4);
}

CPU.prototype.pop16 = function()
{
    var sp = this.get_seg(reg_ss) + this.get_stack_reg() | 0,
        result = this.safe_read16(sp);

    this.adjust_stack_reg(2);
    return result;
}

CPU.prototype.pop32s = function()
{
    var sp = this.get_seg(reg_ss) + this.get_stack_reg() | 0,
        result = this.safe_read32s(sp);

    this.adjust_stack_reg(4);
    return result;
}

CPU.prototype.pusha16 = function()
{
    var temp = this.reg16[reg_sp];

    // make sure we don't get a pagefault after having
    // pushed several registers already
    this.writable_or_pagefault(this.get_stack_pointer(-16), 16);

    this.push16(this.reg16[reg_ax]);
    this.push16(this.reg16[reg_cx]);
    this.push16(this.reg16[reg_dx]);
    this.push16(this.reg16[reg_bx]);
    this.push16(temp);
    this.push16(this.reg16[reg_bp]);
    this.push16(this.reg16[reg_si]);
    this.push16(this.reg16[reg_di]);
}

CPU.prototype.pusha32 = function()
{
    var temp = this.reg32s[reg_esp];

    this.writable_or_pagefault(this.get_stack_pointer(-32), 32);

    this.push32(this.reg32s[reg_eax]);
    this.push32(this.reg32s[reg_ecx]);
    this.push32(this.reg32s[reg_edx]);
    this.push32(this.reg32s[reg_ebx]);
    this.push32(temp);
    this.push32(this.reg32s[reg_ebp]);
    this.push32(this.reg32s[reg_esi]);
    this.push32(this.reg32s[reg_edi]);
}

CPU.prototype.popa16 = function()
{
    this.translate_address_read(this.get_stack_pointer(0));
    this.translate_address_read(this.get_stack_pointer(15));

    this.reg16[reg_di] = this.pop16();
    this.reg16[reg_si] = this.pop16();
    this.reg16[reg_bp] = this.pop16();
    this.adjust_stack_reg(2);
    this.reg16[reg_bx] = this.pop16();
    this.reg16[reg_dx] = this.pop16();
    this.reg16[reg_cx] = this.pop16();
    this.reg16[reg_ax] = this.pop16();
}

CPU.prototype.popa32 = function()
{
    this.translate_address_read(this.get_stack_pointer(0));
    this.translate_address_read(this.get_stack_pointer(31));

    this.reg32s[reg_edi] = this.pop32s();
    this.reg32s[reg_esi] = this.pop32s();
    this.reg32s[reg_ebp] = this.pop32s();
    this.adjust_stack_reg(4);
    this.reg32s[reg_ebx] = this.pop32s();
    this.reg32s[reg_edx] = this.pop32s();
    this.reg32s[reg_ecx] = this.pop32s();
    this.reg32s[reg_eax] = this.pop32s();
}

CPU.prototype.xchg8 = function(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1,
        tmp = this.reg8[mod];

    this.reg8[mod] = memory_data;

    return tmp;
}

CPU.prototype.xchg16 = function(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 2 & 14,
        tmp = this.reg16[mod];

    this.reg16[mod] = memory_data;

    return tmp;
}

CPU.prototype.xchg16r = function(operand)
{
    var temp = this.reg16[reg_ax];
    this.reg16[reg_ax] = this.reg16[operand];
    this.reg16[operand] = temp;
}

CPU.prototype.xchg32 = function(memory_data, modrm_byte)
{
    var mod = modrm_byte >> 3 & 7,
        tmp = this.reg32s[mod];

    this.reg32s[mod] = memory_data;

    return tmp;
}

CPU.prototype.xchg32r = function(operand)
{
    var temp = this.reg32s[reg_eax];
    this.reg32s[reg_eax] = this.reg32s[operand];
    this.reg32s[operand] = temp;
}

CPU.prototype.lss16 = function(seg)
{
    if(this.modrm_byte >= 0xC0)
    {
        // 0xc4c4 #ud (EMULATOR_BOP) is used by reactos and windows to exit vm86 mode
        this.trigger_ud();
    }

    var addr = this.modrm_resolve(this.modrm_byte);

    var new_reg = this.safe_read16(addr),
        new_seg = this.safe_read16(addr + 2 | 0);

    this.switch_seg(seg, new_seg);

    this.reg16[this.modrm_byte >> 2 & 14] = new_reg;
}

CPU.prototype.lss32 = function(seg)
{
    if(this.modrm_byte >= 0xC0)
    {
        this.trigger_ud();
    }

    var addr = this.modrm_resolve(this.modrm_byte);

    var new_reg = this.safe_read32s(addr),
        new_seg = this.safe_read16(addr + 4 | 0);

    this.switch_seg(seg, new_seg);

    this.reg32s[this.modrm_byte >> 3 & 7] = new_reg;
}

CPU.prototype.enter16 = function(size, nesting_level)
{
    nesting_level &= 31;

    if(nesting_level) dbg_log("enter16 stack=" + (this.stack_size_32 ? 32 : 16) + " size=" + size + " nest=" + nesting_level, LOG_CPU);
    this.push16(this.reg16[reg_bp]);
    var frame_temp = this.reg16[reg_sp];

    if(nesting_level > 0)
    {
        var tmp_ebp = this.reg16[reg_ebp];
        for(var i = 1; i < nesting_level; i++)
        {
            tmp_ebp -= 2;
            this.push16(this.safe_read16(this.get_seg(reg_ss) + tmp_ebp | 0));
        }
        this.push16(frame_temp);
    }
    this.reg16[reg_bp] = frame_temp;
    this.adjust_stack_reg(-size);
};

CPU.prototype.enter32 = function(size, nesting_level)
{
    nesting_level &= 31;

    if(nesting_level) dbg_log("enter32 stack=" + (this.stack_size_32 ? 32 : 16) + " size=" + size + " nest=" + nesting_level, LOG_CPU);
    this.push32(this.reg32s[reg_ebp]);
    var frame_temp = this.reg32s[reg_esp];

    if(nesting_level > 0)
    {
        var tmp_ebp = this.reg32s[reg_ebp];
        for(var i = 1; i < nesting_level; i++)
        {
            tmp_ebp -= 4;
            this.push32(this.safe_read32s(this.get_seg(reg_ss) + tmp_ebp | 0));
        }
        this.push32(frame_temp);
    }
    this.reg32s[reg_ebp] = frame_temp;
    this.adjust_stack_reg(-size);
};

CPU.prototype.bswap = function(reg)
{
    var temp = this.reg32s[reg];

    this.reg32s[reg] = temp >>> 24 | temp << 24 | (temp >> 8 & 0xFF00) | (temp << 8 & 0xFF0000);
}

CPU.prototype.fxsave = function(addr)
{
    this.writable_or_pagefault(addr, 512);

    this.safe_write16(addr + 0 | 0, this.fpu.control_word);
    this.safe_write16(addr + 2 | 0, this.fpu.load_status_word());
    this.safe_write8( addr + 4 | 0, ~this.fpu.stack_empty & 0xFF);
    this.safe_write16(addr + 6 | 0, this.fpu.fpu_opcode);
    this.safe_write32(addr + 8 | 0, this.fpu.fpu_ip);
    this.safe_write16(addr + 12 | 0, this.fpu.fpu_ip_selector);
    this.safe_write32(addr + 16 | 0, this.fpu.fpu_dp);
    this.safe_write16(addr + 20 | 0, this.fpu.fpu_dp_selector);

    this.safe_write32(addr + 24 | 0, this.mxcsr);
    this.safe_write32(addr + 28 | 0, MXCSR_MASK);

    for(let i = 0; i < 8; i++)
    {
        this.fpu.store_m80(addr + 32 + (i << 4) | 0, this.fpu.st[this.fpu.stack_ptr + i & 7]);
    }

    // If the OSFXSR bit in control register CR4 is not set, the FXSAVE
    // instruction may not save these registers. This behavior is
    // implementation dependent.
    for(let i = 0; i < 8; i++)
    {
        this.safe_write32(addr + 160 + (i << 4) +  0 | 0, this.reg_xmm32s[i << 2 | 0]);
        this.safe_write32(addr + 160 + (i << 4) +  4 | 0, this.reg_xmm32s[i << 2 | 1]);
        this.safe_write32(addr + 160 + (i << 4) +  8 | 0, this.reg_xmm32s[i << 2 | 2]);
        this.safe_write32(addr + 160 + (i << 4) + 12 | 0, this.reg_xmm32s[i << 2 | 3]);
    }
};

CPU.prototype.fxrstor = function(addr)
{
    this.translate_address_read(addr | 0);
    this.translate_address_read(addr + 511 | 0);

    var new_mxcsr = this.safe_read32s(addr + 24 | 0);

    if(new_mxcsr & ~MXCSR_MASK)
    {
        dbg_log("Invalid mxcsr bits: " + h((new_mxcsr & ~MXCSR_MASK) >>> 0, 8));
        this.trigger_gp(0);
    }

    this.fpu.control_word = this.safe_read16(addr + 0 | 0);
    this.fpu.set_status_word(this.safe_read16(addr + 2 | 0));
    this.fpu.stack_empty = ~this.safe_read8(addr + 4 | 0) & 0xFF;
    this.fpu.fpu_opcode = this.safe_read16(addr + 6 | 0);
    this.fpu.fpu_ip = this.safe_read32s(addr + 8 | 0);
    this.fpu.fpu_ip = this.safe_read16(addr + 12 | 0);
    this.fpu.fpu_dp = this.safe_read32s(addr + 16 | 0);
    this.fpu.fpu_dp_selector = this.safe_read16(addr + 20 | 0);

    this.mxcsr = new_mxcsr;

    for(let i = 0; i < 8; i++)
    {
        this.fpu.st[this.fpu.stack_ptr + i & 7] = this.fpu.load_m80(addr + 32 + (i << 4) | 0);
    }

    for(let i = 0; i < 8; i++)
    {
        this.reg_xmm32s[i << 2 | 0] = this.safe_read32s(addr + 160 + (i << 4) +  0 | 0);
        this.reg_xmm32s[i << 2 | 1] = this.safe_read32s(addr + 160 + (i << 4) +  4 | 0);
        this.reg_xmm32s[i << 2 | 2] = this.safe_read32s(addr + 160 + (i << 4) +  8 | 0);
        this.reg_xmm32s[i << 2 | 3] = this.safe_read32s(addr + 160 + (i << 4) + 12 | 0);
    }
};
