"use strict";

var t = [];
var t16 = [];
var t32 = [];

t[0x00] = cpu => { cpu.read_modrm_byte(); cpu.write_e8(cpu.add8(cpu.read_write_e8(), cpu.read_g8())); };
t16[0x01] = cpu => { cpu.read_modrm_byte(); cpu.write_e16(cpu.add16(cpu.read_write_e16(), cpu.read_g16())); };
t32[0x01] = cpu => { cpu.read_modrm_byte(); cpu.write_e32(cpu.add32(cpu.read_write_e32(), cpu.read_g32s())); };
t[0x02] = cpu => { cpu.read_modrm_byte(); cpu.write_g8(cpu.add8(cpu.read_g8(), cpu.read_e8())); };
t16[0x03] = cpu => { cpu.read_modrm_byte(); cpu.write_g16(cpu.add16(cpu.read_g16(), cpu.read_e16())); };
t32[0x03] = cpu => { cpu.read_modrm_byte(); cpu.write_g32(cpu.add32(cpu.read_g32s(), cpu.read_e32s())); };
t[0x04] = cpu => { cpu.reg8[reg_al] = cpu.add8(cpu.reg8[reg_al], cpu.read_op8()); };
t16[0x05] = cpu => { cpu.reg16[reg_ax] = cpu.add16(cpu.reg16[reg_ax], cpu.read_op16()); };
t32[0x05] = cpu => { cpu.reg32s[reg_eax] = cpu.add32(cpu.reg32s[reg_eax], cpu.read_op32s()); };

t16[0x06] = cpu => { cpu.push16(cpu.sreg[reg_es]); };
t32[0x06] = cpu => { cpu.push32(cpu.sreg[reg_es]); };
t16[0x07] = cpu => {
    cpu.switch_seg(reg_es, cpu.safe_read16(cpu.get_stack_pointer(0)));
    cpu.adjust_stack_reg(2);
};
t32[0x07] = cpu => {
    cpu.switch_seg(reg_es, cpu.safe_read32s(cpu.get_stack_pointer(0)) & 0xFFFF);
    cpu.adjust_stack_reg(4);
};

t[0x08] = cpu => { cpu.read_modrm_byte(); cpu.write_e8(cpu.or8(cpu.read_write_e8(), cpu.read_g8())); };
t16[0x09] = cpu => { cpu.read_modrm_byte(); cpu.write_e16(cpu.or16(cpu.read_write_e16(), cpu.read_g16())); };
t32[0x09] = cpu => { cpu.read_modrm_byte(); cpu.write_e32(cpu.or32(cpu.read_write_e32(), cpu.read_g32s())); };
t[0x0a] = cpu => { cpu.read_modrm_byte(); cpu.write_g8(cpu.or8(cpu.read_g8(), cpu.read_e8())); };
t16[0x0b] = cpu => { cpu.read_modrm_byte(); cpu.write_g16(cpu.or16(cpu.read_g16(), cpu.read_e16())); };
t32[0x0b] = cpu => { cpu.read_modrm_byte(); cpu.write_g32(cpu.or32(cpu.read_g32s(), cpu.read_e32s())); }
t[0x0c] = cpu => { cpu.reg8[reg_al] = cpu.or8(cpu.reg8[reg_al], cpu.read_op8()); };
t16[0x0d] = cpu => { cpu.reg16[reg_ax] = cpu.or16(cpu.reg16[reg_ax], cpu.read_op16()); };
t32[0x0d] = cpu => { cpu.reg32s[reg_eax] = cpu.or32(cpu.reg32s[reg_eax], cpu.read_op32s()); }


t16[0x0E] = cpu => { cpu.push16(cpu.sreg[reg_cs]); };
t32[0x0E] = cpu => { cpu.push32(cpu.sreg[reg_cs]); };
t16[0x0F] = cpu => {
    cpu.table0F_16[cpu.read_op0F()](cpu);
};
t32[0x0F] = cpu => {
    cpu.table0F_32[cpu.read_op0F()](cpu);
};

t[0x10] = cpu => { cpu.read_modrm_byte(); cpu.write_e8(cpu.adc8(cpu.read_write_e8(), cpu.read_g8())); };
t16[0x11] = cpu => { cpu.read_modrm_byte(); cpu.write_e16(cpu.adc16(cpu.read_write_e16(), cpu.read_g16())); };
t32[0x11] = cpu => { cpu.read_modrm_byte(); cpu.write_e32(cpu.adc32(cpu.read_write_e32(), cpu.read_g32s())); }
t[0x12] = cpu => { cpu.read_modrm_byte(); cpu.write_g8(cpu.adc8(cpu.read_g8(), cpu.read_e8())); };
t16[0x13] = cpu => { cpu.read_modrm_byte(); cpu.write_g16(cpu.adc16(cpu.read_g16(), cpu.read_e16())); };
t32[0x13] = cpu => { cpu.read_modrm_byte(); cpu.write_g32(cpu.adc32(cpu.read_g32s(), cpu.read_e32s())); }
t[0x14] = cpu => { cpu.reg8[reg_al] = cpu.adc8(cpu.reg8[reg_al], cpu.read_op8()); };
t16[0x15] = cpu => { cpu.reg16[reg_ax] = cpu.adc16(cpu.reg16[reg_ax], cpu.read_op16()); };
t32[0x15] = cpu => { cpu.reg32s[reg_eax] = cpu.adc32(cpu.reg32s[reg_eax], cpu.read_op32s()); }

t16[0x16] = cpu => { cpu.push16(cpu.sreg[reg_ss]); };
t32[0x16] = cpu => { cpu.push32(cpu.sreg[reg_ss]); };
t16[0x17] = cpu => {
    cpu.switch_seg(reg_ss, cpu.safe_read16(cpu.get_stack_pointer(0)));
    cpu.adjust_stack_reg(2);
    cpu.clear_prefixes();
    cpu.cycle_internal();
};
t32[0x17] = cpu => {
    cpu.switch_seg(reg_ss, cpu.safe_read32s(cpu.get_stack_pointer(0)) & 0xFFFF);
    cpu.adjust_stack_reg(4);
    cpu.clear_prefixes();
    cpu.cycle_internal();
};

t[0x18] = cpu => { cpu.read_modrm_byte(); cpu.write_e8(cpu.sbb8(cpu.read_write_e8(), cpu.read_g8())); };
t16[0x19] = cpu => { cpu.read_modrm_byte(); cpu.write_e16(cpu.sbb16(cpu.read_write_e16(), cpu.read_g16())); };
t32[0x19] = cpu => { cpu.read_modrm_byte(); cpu.write_e32(cpu.sbb32(cpu.read_write_e32(), cpu.read_g32s())); }
t[0x1a] = cpu => { cpu.read_modrm_byte(); cpu.write_g8(cpu.sbb8(cpu.read_g8(), cpu.read_e8())); };
t16[0x1b] = cpu => { cpu.read_modrm_byte(); cpu.write_g16(cpu.sbb16(cpu.read_g16(), cpu.read_e16())); };
t32[0x1b] = cpu => { cpu.read_modrm_byte(); cpu.write_g32(cpu.sbb32(cpu.read_g32s(), cpu.read_e32s())); }
t[0x1c] = cpu => { cpu.reg8[reg_al] = cpu.sbb8(cpu.reg8[reg_al], cpu.read_op8()); };
t16[0x1d] = cpu => { cpu.reg16[reg_ax] = cpu.sbb16(cpu.reg16[reg_ax], cpu.read_op16()); };
t32[0x1d] = cpu => { cpu.reg32s[reg_eax] = cpu.sbb32(cpu.reg32s[reg_eax], cpu.read_op32s()); }


t16[0x1E] = cpu => { cpu.push16(cpu.sreg[reg_ds]); };
t32[0x1E] = cpu => { cpu.push32(cpu.sreg[reg_ds]); };
t16[0x1F] = cpu => {
    cpu.switch_seg(reg_ds, cpu.safe_read16(cpu.get_stack_pointer(0)));
    cpu.adjust_stack_reg(2);
};
t32[0x1F] = cpu => {
    cpu.switch_seg(reg_ds, cpu.safe_read32s(cpu.get_stack_pointer(0)) & 0xFFFF);
    cpu.adjust_stack_reg(4);
};

t[0x20] = cpu => { cpu.read_modrm_byte(); cpu.write_e8(cpu.and8(cpu.read_write_e8(), cpu.read_g8())); };
t16[0x21] = cpu => { cpu.read_modrm_byte(); cpu.write_e16(cpu.and16(cpu.read_write_e16(), cpu.read_g16())); };
t32[0x21] = cpu => { cpu.read_modrm_byte(); cpu.write_e32(cpu.and32(cpu.read_write_e32(), cpu.read_g32s())); }
t[0x22] = cpu => { cpu.read_modrm_byte(); cpu.write_g8(cpu.and8(cpu.read_g8(), cpu.read_e8())); };
t16[0x23] = cpu => { cpu.read_modrm_byte(); cpu.write_g16(cpu.and16(cpu.read_g16(), cpu.read_e16())); };
t32[0x23] = cpu => { cpu.read_modrm_byte(); cpu.write_g32(cpu.and32(cpu.read_g32s(), cpu.read_e32s())); }
t[0x24] = cpu => { cpu.reg8[reg_al] = cpu.and8(cpu.reg8[reg_al], cpu.read_op8()); };
t16[0x25] = cpu => { cpu.reg16[reg_ax] = cpu.and16(cpu.reg16[reg_ax], cpu.read_op16()); };
t32[0x25] = cpu => { cpu.reg32s[reg_eax] = cpu.and32(cpu.reg32s[reg_eax], cpu.read_op32s()); }


t[0x26] = cpu => { cpu.segment_prefix_op(reg_es); };
t[0x27] = cpu => { cpu.bcd_daa(); };

t[0x28] = cpu => { cpu.read_modrm_byte(); cpu.write_e8(cpu.sub8(cpu.read_write_e8(), cpu.read_g8())); };
t16[0x29] = cpu => { cpu.read_modrm_byte(); cpu.write_e16(cpu.sub16(cpu.read_write_e16(), cpu.read_g16())); };
t32[0x29] = cpu => { cpu.read_modrm_byte(); cpu.write_e32(cpu.sub32(cpu.read_write_e32(), cpu.read_g32s())); }
t[0x2a] = cpu => { cpu.read_modrm_byte(); cpu.write_g8(cpu.sub8(cpu.read_g8(), cpu.read_e8())); };
t16[0x2b] = cpu => { cpu.read_modrm_byte(); cpu.write_g16(cpu.sub16(cpu.read_g16(), cpu.read_e16())); };
t32[0x2b] = cpu => { cpu.read_modrm_byte(); cpu.write_g32(cpu.sub32(cpu.read_g32s(), cpu.read_e32s())); }
t[0x2c] = cpu => { cpu.reg8[reg_al] = cpu.sub8(cpu.reg8[reg_al], cpu.read_op8()); };
t16[0x2d] = cpu => { cpu.reg16[reg_ax] = cpu.sub16(cpu.reg16[reg_ax], cpu.read_op16()); };
t32[0x2d] = cpu => { cpu.reg32s[reg_eax] = cpu.sub32(cpu.reg32s[reg_eax], cpu.read_op32s()); }

t[0x2E] = cpu => { cpu.segment_prefix_op(reg_cs); };
t[0x2F] = cpu => { cpu.bcd_das(); };

t[0x30] = cpu => { cpu.read_modrm_byte(); cpu.write_e8(cpu.xor8(cpu.read_write_e8(), cpu.read_g8())); };
t16[0x31] = cpu => { cpu.read_modrm_byte(); cpu.write_e16(cpu.xor16(cpu.read_write_e16(), cpu.read_g16())); };
t32[0x31] = cpu => { cpu.read_modrm_byte(); cpu.write_e32(cpu.xor32(cpu.read_write_e32(), cpu.read_g32s())); }
t[0x32] = cpu => { cpu.read_modrm_byte(); cpu.write_g8(cpu.xor8(cpu.read_g8(), cpu.read_e8())); };
t16[0x33] = cpu => { cpu.read_modrm_byte(); cpu.write_g16(cpu.xor16(cpu.read_g16(), cpu.read_e16())); };
t32[0x33] = cpu => { cpu.read_modrm_byte(); cpu.write_g32(cpu.xor32(cpu.read_g32s(), cpu.read_e32s())); }
t[0x34] = cpu => { cpu.reg8[reg_al] = cpu.xor8(cpu.reg8[reg_al], cpu.read_op8()); };
t16[0x35] = cpu => { cpu.reg16[reg_ax] = cpu.xor16(cpu.reg16[reg_ax], cpu.read_op16()); };
t32[0x35] = cpu => { cpu.reg32s[reg_eax] = cpu.xor32(cpu.reg32s[reg_eax], cpu.read_op32s()); }

t[0x36] = cpu => { cpu.segment_prefix_op(reg_ss); };
t[0x37] = cpu => { cpu.bcd_aaa(); };

t[0x38] = cpu => { cpu.read_modrm_byte(); cpu.cmp8(cpu.read_e8(), cpu.read_g8()); };
t16[0x39] = cpu => { cpu.read_modrm_byte(); cpu.cmp16(cpu.read_e16(), cpu.read_g16()); };
t32[0x39] = cpu => { cpu.read_modrm_byte(); cpu.cmp32(cpu.read_e32s(), cpu.read_g32s()); }
t[0x3A] = cpu => { cpu.read_modrm_byte(); cpu.cmp8(cpu.read_g8(), cpu.read_e8()); };
t16[0x3B] = cpu => { cpu.read_modrm_byte(); cpu.cmp16(cpu.read_g16(), cpu.read_e16()); };
t32[0x3B] = cpu => { cpu.read_modrm_byte(); cpu.cmp32(cpu.read_g32s(), cpu.read_e32s()); }
t[0x3C] = cpu => { cpu.cmp8(cpu.reg8[reg_al], cpu.read_op8()); };
t16[0x3D] = cpu => { cpu.cmp16(cpu.reg16[reg_ax], cpu.read_op16()); };
t32[0x3D] = cpu => { cpu.cmp32(cpu.reg32s[reg_eax], cpu.read_op32s()); }

t[0x3E] = cpu => { cpu.segment_prefix_op(reg_ds); };
t[0x3F] = cpu => { cpu.bcd_aas(); };


t16[0x40] = cpu => { cpu.reg16[reg_ax] = cpu.inc16(cpu.reg16[reg_ax]); };
t32[0x40] = cpu => { cpu.reg32s[reg_eax] = cpu.inc32(cpu.reg32s[reg_eax]); };
t16[0x41] = cpu => { cpu.reg16[reg_cx] = cpu.inc16(cpu.reg16[reg_cx]); };
t32[0x41] = cpu => { cpu.reg32s[reg_ecx] = cpu.inc32(cpu.reg32s[reg_ecx]); };
t16[0x42] = cpu => { cpu.reg16[reg_dx] = cpu.inc16(cpu.reg16[reg_dx]); };
t32[0x42] = cpu => { cpu.reg32s[reg_edx] = cpu.inc32(cpu.reg32s[reg_edx]); };
t16[0x43] = cpu => { cpu.reg16[reg_bx] = cpu.inc16(cpu.reg16[reg_bx]); };
t32[0x43] = cpu => { cpu.reg32s[reg_ebx] = cpu.inc32(cpu.reg32s[reg_ebx]); };
t16[0x44] = cpu => { cpu.reg16[reg_sp] = cpu.inc16(cpu.reg16[reg_sp]); };
t32[0x44] = cpu => { cpu.reg32s[reg_esp] = cpu.inc32(cpu.reg32s[reg_esp]); };
t16[0x45] = cpu => { cpu.reg16[reg_bp] = cpu.inc16(cpu.reg16[reg_bp]); };
t32[0x45] = cpu => { cpu.reg32s[reg_ebp] = cpu.inc32(cpu.reg32s[reg_ebp]); };
t16[0x46] = cpu => { cpu.reg16[reg_si] = cpu.inc16(cpu.reg16[reg_si]); };
t32[0x46] = cpu => { cpu.reg32s[reg_esi] = cpu.inc32(cpu.reg32s[reg_esi]); };
t16[0x47] = cpu => { cpu.reg16[reg_di] = cpu.inc16(cpu.reg16[reg_di]); };
t32[0x47] = cpu => { cpu.reg32s[reg_edi] = cpu.inc32(cpu.reg32s[reg_edi]); };


t16[0x48] = cpu => { cpu.reg16[reg_ax] = cpu.dec16(cpu.reg16[reg_ax]); };
t32[0x48] = cpu => { cpu.reg32s[reg_eax] = cpu.dec32(cpu.reg32s[reg_eax]); };
t16[0x49] = cpu => { cpu.reg16[reg_cx] = cpu.dec16(cpu.reg16[reg_cx]); };
t32[0x49] = cpu => { cpu.reg32s[reg_ecx] = cpu.dec32(cpu.reg32s[reg_ecx]); };
t16[0x4A] = cpu => { cpu.reg16[reg_dx] = cpu.dec16(cpu.reg16[reg_dx]); };
t32[0x4A] = cpu => { cpu.reg32s[reg_edx] = cpu.dec32(cpu.reg32s[reg_edx]); };
t16[0x4B] = cpu => { cpu.reg16[reg_bx] = cpu.dec16(cpu.reg16[reg_bx]); };
t32[0x4B] = cpu => { cpu.reg32s[reg_ebx] = cpu.dec32(cpu.reg32s[reg_ebx]); };
t16[0x4C] = cpu => { cpu.reg16[reg_sp] = cpu.dec16(cpu.reg16[reg_sp]); };
t32[0x4C] = cpu => { cpu.reg32s[reg_esp] = cpu.dec32(cpu.reg32s[reg_esp]); };
t16[0x4D] = cpu => { cpu.reg16[reg_bp] = cpu.dec16(cpu.reg16[reg_bp]); };
t32[0x4D] = cpu => { cpu.reg32s[reg_ebp] = cpu.dec32(cpu.reg32s[reg_ebp]); };
t16[0x4E] = cpu => { cpu.reg16[reg_si] = cpu.dec16(cpu.reg16[reg_si]); };
t32[0x4E] = cpu => { cpu.reg32s[reg_esi] = cpu.dec32(cpu.reg32s[reg_esi]); };
t16[0x4F] = cpu => { cpu.reg16[reg_di] = cpu.dec16(cpu.reg16[reg_di]); };
t32[0x4F] = cpu => { cpu.reg32s[reg_edi] = cpu.dec32(cpu.reg32s[reg_edi]); };


t16[0x50] = cpu => { cpu.push16(cpu.reg16[reg_ax]); };
t32[0x50] = cpu => { cpu.push32(cpu.reg32s[reg_eax]); }
t16[0x51] = cpu => { cpu.push16(cpu.reg16[reg_cx]); };
t32[0x51] = cpu => { cpu.push32(cpu.reg32s[reg_ecx]); }
t16[0x52] = cpu => { cpu.push16(cpu.reg16[reg_dx]); };
t32[0x52] = cpu => { cpu.push32(cpu.reg32s[reg_edx]); }
t16[0x53] = cpu => { cpu.push16(cpu.reg16[reg_bx]); };
t32[0x53] = cpu => { cpu.push32(cpu.reg32s[reg_ebx]); }
t16[0x54] = cpu => { cpu.push16(cpu.reg16[reg_sp]); };
t32[0x54] = cpu => { cpu.push32(cpu.reg32s[reg_esp]); }
t16[0x55] = cpu => { cpu.push16(cpu.reg16[reg_bp]); };
t32[0x55] = cpu => { cpu.push32(cpu.reg32s[reg_ebp]); }
t16[0x56] = cpu => { cpu.push16(cpu.reg16[reg_si]); };
t32[0x56] = cpu => { cpu.push32(cpu.reg32s[reg_esi]); }
t16[0x57] = cpu => { cpu.push16(cpu.reg16[reg_di]); };
t32[0x57] = cpu => { cpu.push32(cpu.reg32s[reg_edi]); }

t16[0x58] = cpu => { cpu.reg16[reg_ax] = cpu.pop16(); };
t32[0x58] = cpu => { cpu.reg32s[reg_eax] = cpu.pop32s(); }
t16[0x59] = cpu => { cpu.reg16[reg_cx] = cpu.pop16(); };
t32[0x59] = cpu => { cpu.reg32s[reg_ecx] = cpu.pop32s(); }
t16[0x5A] = cpu => { cpu.reg16[reg_dx] = cpu.pop16(); };
t32[0x5A] = cpu => { cpu.reg32s[reg_edx] = cpu.pop32s(); }
t16[0x5B] = cpu => { cpu.reg16[reg_bx] = cpu.pop16(); };
t32[0x5B] = cpu => { cpu.reg32s[reg_ebx] = cpu.pop32s(); }
t16[0x5C] = cpu => { cpu.reg16[reg_sp] = cpu.pop16(); };
t32[0x5C] = cpu => { cpu.reg32s[reg_esp] = cpu.pop32s(); }
t16[0x5D] = cpu => { cpu.reg16[reg_bp] = cpu.pop16(); };
t32[0x5D] = cpu => { cpu.reg32s[reg_ebp] = cpu.pop32s(); }
t16[0x5E] = cpu => { cpu.reg16[reg_si] = cpu.pop16(); };
t32[0x5E] = cpu => { cpu.reg32s[reg_esi] = cpu.pop32s(); }
t16[0x5F] = cpu => { cpu.reg16[reg_di] = cpu.pop16(); };
t32[0x5F] = cpu => { cpu.reg32s[reg_edi] = cpu.pop32s(); }


t16[0x60] = cpu => { cpu.pusha16(); };
t32[0x60] = cpu => { cpu.pusha32(); };
t16[0x61] = cpu => { cpu.popa16(); };
t32[0x61] = cpu => { cpu.popa32(); };

t[0x62] = cpu => {
    // bound
    dbg_log("Unimplemented BOUND instruction", LOG_CPU);
    dbg_assert(false);
};
t[0x63] = cpu => { cpu.read_modrm_byte();
    // arpl
    //dbg_log("arpl", LOG_CPU);
    if(cpu.protected_mode && !cpu.vm86_mode())
    {
        cpu.write_e16(cpu.arpl(cpu.read_write_e16(), cpu.modrm_byte >> 2 & 14));
    }
    else
    {
        dbg_log("arpl #ud", LOG_CPU);
        cpu.trigger_ud();
    }
};

t[0x64] = cpu => { cpu.segment_prefix_op(reg_fs); };
t[0x65] = cpu => { cpu.segment_prefix_op(reg_gs); };

t[0x66] = cpu => {
    // Operand-size override prefix
    cpu.prefixes |= PREFIX_MASK_OPSIZE;
    cpu.run_prefix_instruction();
    cpu.prefixes = 0;
};

t[0x67] = cpu => {
    // Address-size override prefix
    dbg_assert(cpu.is_asize_32() === cpu.is_32);

    cpu.prefixes |= PREFIX_MASK_ADDRSIZE;
    cpu.run_prefix_instruction();
    cpu.prefixes = 0;
};

t16[0x68] = cpu => { cpu.push16(cpu.read_op16()); };
t32[0x68] = cpu => { cpu.push32(cpu.read_op32s()); };

t16[0x69] = cpu => { cpu.read_modrm_byte();
    cpu.write_g16(cpu.imul_reg16(cpu.read_e16s(), cpu.read_op16() << 16 >> 16));
};
t32[0x69] = cpu => { cpu.read_modrm_byte();
    cpu.write_g32(cpu.imul_reg32(cpu.read_e32s(), cpu.read_op32s()));
};

t16[0x6A] = cpu => { cpu.push16(cpu.read_op8s()); };
t32[0x6A] = cpu => { cpu.push32(cpu.read_op8s()); };

t16[0x6B] = cpu => { cpu.read_modrm_byte();
    cpu.write_g16(cpu.imul_reg16(cpu.read_e16s(), cpu.read_op8s()));
};
t32[0x6B] = cpu => { cpu.read_modrm_byte();
    cpu.write_g32(cpu.imul_reg32(cpu.read_e32s(), cpu.read_op8s()));
};

t[0x6C] = cpu => { insb(cpu); };
t16[0x6D] = cpu => { insw(cpu); };
t32[0x6D] = cpu => { insd(cpu); };
t[0x6E] = cpu => { outsb(cpu); };
t16[0x6F] = cpu => { outsw(cpu); };
t32[0x6F] = cpu => { outsd(cpu); };

t[0x70] = cpu => { cpu.jmpcc8( cpu.test_o()); };
t[0x71] = cpu => { cpu.jmpcc8(!cpu.test_o()); };
t[0x72] = cpu => { cpu.jmpcc8( cpu.test_b()); };
t[0x73] = cpu => { cpu.jmpcc8(!cpu.test_b()); };
t[0x74] = cpu => { cpu.jmpcc8( cpu.test_z()); };
t[0x75] = cpu => { cpu.jmpcc8(!cpu.test_z()); };
t[0x76] = cpu => { cpu.jmpcc8( cpu.test_be()); };
t[0x77] = cpu => { cpu.jmpcc8(!cpu.test_be()); };
t[0x78] = cpu => { cpu.jmpcc8( cpu.test_s()); };
t[0x79] = cpu => { cpu.jmpcc8(!cpu.test_s()); };
t[0x7A] = cpu => { cpu.jmpcc8( cpu.test_p()); };
t[0x7B] = cpu => { cpu.jmpcc8(!cpu.test_p()); };
t[0x7C] = cpu => { cpu.jmpcc8( cpu.test_l()); };
t[0x7D] = cpu => { cpu.jmpcc8(!cpu.test_l()); };
t[0x7E] = cpu => { cpu.jmpcc8( cpu.test_le()); };
t[0x7F] = cpu => { cpu.jmpcc8(!cpu.test_le()); };

t[0x80] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: cpu.write_e8(cpu.add8(cpu.read_write_e8(), cpu.read_op8())); break;
        case 1: cpu.write_e8(cpu. or8(cpu.read_write_e8(), cpu.read_op8())); break;
        case 2: cpu.write_e8(cpu.adc8(cpu.read_write_e8(), cpu.read_op8())); break;
        case 3: cpu.write_e8(cpu.sbb8(cpu.read_write_e8(), cpu.read_op8())); break;
        case 4: cpu.write_e8(cpu.and8(cpu.read_write_e8(), cpu.read_op8())); break;
        case 5: cpu.write_e8(cpu.sub8(cpu.read_write_e8(), cpu.read_op8())); break;
        case 6: cpu.write_e8(cpu.xor8(cpu.read_write_e8(), cpu.read_op8())); break;
        case 7: cpu.cmp8(cpu.read_e8(), cpu.read_op8()); break;
    }
};
t16[0x81] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: cpu.write_e16(cpu.add16(cpu.read_write_e16(), cpu.read_op16())); break;
        case 1: cpu.write_e16(cpu. or16(cpu.read_write_e16(), cpu.read_op16())); break;
        case 2: cpu.write_e16(cpu.adc16(cpu.read_write_e16(), cpu.read_op16())); break;
        case 3: cpu.write_e16(cpu.sbb16(cpu.read_write_e16(), cpu.read_op16())); break;
        case 4: cpu.write_e16(cpu.and16(cpu.read_write_e16(), cpu.read_op16())); break;
        case 5: cpu.write_e16(cpu.sub16(cpu.read_write_e16(), cpu.read_op16())); break;
        case 6: cpu.write_e16(cpu.xor16(cpu.read_write_e16(), cpu.read_op16())); break;
        case 7: cpu.cmp16(cpu.read_e16(), cpu.read_op16()); break;
    }
};
t32[0x81] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: cpu.write_e32(cpu.add32(cpu.read_write_e32(), cpu.read_op32s())); break;
        case 1: cpu.write_e32(cpu. or32(cpu.read_write_e32(), cpu.read_op32s())); break;
        case 2: cpu.write_e32(cpu.adc32(cpu.read_write_e32(), cpu.read_op32s())); break;
        case 3: cpu.write_e32(cpu.sbb32(cpu.read_write_e32(), cpu.read_op32s())); break;
        case 4: cpu.write_e32(cpu.and32(cpu.read_write_e32(), cpu.read_op32s())); break;
        case 5: cpu.write_e32(cpu.sub32(cpu.read_write_e32(), cpu.read_op32s())); break;
        case 6: cpu.write_e32(cpu.xor32(cpu.read_write_e32(), cpu.read_op32s())); break;
        case 7: cpu.cmp32(cpu.read_e32s(), cpu.read_op32s()); break;
    }
};
t[0x82] = t[0x80]; // alias
t16[0x83] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: cpu.write_e16(cpu.add16(cpu.read_write_e16(), cpu.read_op8s())); break;
        case 1: cpu.write_e16(cpu. or16(cpu.read_write_e16(), cpu.read_op8s())); break;
        case 2: cpu.write_e16(cpu.adc16(cpu.read_write_e16(), cpu.read_op8s())); break;
        case 3: cpu.write_e16(cpu.sbb16(cpu.read_write_e16(), cpu.read_op8s())); break;
        case 4: cpu.write_e16(cpu.and16(cpu.read_write_e16(), cpu.read_op8s())); break;
        case 5: cpu.write_e16(cpu.sub16(cpu.read_write_e16(), cpu.read_op8s())); break;
        case 6: cpu.write_e16(cpu.xor16(cpu.read_write_e16(), cpu.read_op8s())); break;
        case 7: cpu.cmp16(cpu.read_e16(), cpu.read_op8s()); break;
    }
};
t32[0x83] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: cpu.write_e32(cpu.add32(cpu.read_write_e32(), cpu.read_op8s())); break;
        case 1: cpu.write_e32(cpu. or32(cpu.read_write_e32(), cpu.read_op8s())); break;
        case 2: cpu.write_e32(cpu.adc32(cpu.read_write_e32(), cpu.read_op8s())); break;
        case 3: cpu.write_e32(cpu.sbb32(cpu.read_write_e32(), cpu.read_op8s())); break;
        case 4: cpu.write_e32(cpu.and32(cpu.read_write_e32(), cpu.read_op8s())); break;
        case 5: cpu.write_e32(cpu.sub32(cpu.read_write_e32(), cpu.read_op8s())); break;
        case 6: cpu.write_e32(cpu.xor32(cpu.read_write_e32(), cpu.read_op8s())); break;
        case 7: cpu.cmp32(cpu.read_e32s(), cpu.read_op8s()); break;
    }
};

t[0x84] = cpu => { cpu.read_modrm_byte(); var data = cpu.read_e8(); cpu.test8(data, cpu.read_g8()); };
t16[0x85] = cpu => { cpu.read_modrm_byte(); var data = cpu.read_e16(); cpu.test16(data, cpu.read_g16()); };
t32[0x85] = cpu => { cpu.read_modrm_byte(); var data = cpu.read_e32s(); cpu.test32(data, cpu.read_g32s()); }


t[0x86] = cpu => { cpu.read_modrm_byte(); var data = cpu.read_write_e8(); cpu.write_e8(cpu.xchg8(data, cpu.modrm_byte)); };
t16[0x87] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e16(); cpu.write_e16(cpu.xchg16(data, cpu.modrm_byte));
};
t32[0x87] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e32(); cpu.write_e32(cpu.xchg32(data, cpu.modrm_byte));
};

t[0x88] = cpu => { cpu.read_modrm_byte(); cpu.set_e8(cpu.read_g8()); };
t16[0x89] = cpu => { cpu.read_modrm_byte(); cpu.set_e16(cpu.read_g16()); };
t32[0x89] = cpu => { cpu.read_modrm_byte(); cpu.set_e32(cpu.read_g32s()); }

t[0x8A] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e8();
    cpu.write_g8(data);
};
t16[0x8B] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e16();
    cpu.write_g16(data);
};
t32[0x8B] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e32s();
    cpu.write_g32(data);
};

t16[0x8C] = cpu => { cpu.read_modrm_byte();
    cpu.set_e16(cpu.sreg[cpu.modrm_byte >> 3 & 7]);
};
t32[0x8C] = cpu => { cpu.read_modrm_byte();
    cpu.set_e32(cpu.sreg[cpu.modrm_byte >> 3 & 7]);
};

t16[0x8D] = cpu => { cpu.read_modrm_byte();
    // lea
    if(cpu.modrm_byte >= 0xC0)
    {
        dbg_log("lea #ud", LOG_CPU);
        cpu.trigger_ud();
    }
    var mod = cpu.modrm_byte >> 3 & 7;

    // override prefix, so modrm_resolve does not return the segment part
    cpu.prefixes |= SEG_PREFIX_ZERO;
    cpu.reg16[mod << 1] = cpu.modrm_resolve(cpu.modrm_byte);
    cpu.prefixes = 0;
};
t32[0x8D] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte >= 0xC0)
    {
        dbg_log("lea #ud", LOG_CPU);
        cpu.trigger_ud();
    }
    var mod = cpu.modrm_byte >> 3 & 7;

    cpu.prefixes |= SEG_PREFIX_ZERO;
    cpu.reg32s[mod] = cpu.modrm_resolve(cpu.modrm_byte);
    cpu.prefixes = 0;
};

t[0x8E] = cpu => { cpu.read_modrm_byte();
    var mod = cpu.modrm_byte >> 3 & 7;
    var data = cpu.read_e16();
    cpu.switch_seg(mod, data);

    if(mod === reg_ss)
    {
        // run next instruction, so no interrupts are handled
        cpu.clear_prefixes();
        cpu.cycle_internal();
    }
};

t16[0x8F] = cpu => { cpu.read_modrm_byte();
    // pop
    var sp = cpu.safe_read16(cpu.get_stack_pointer(0));

    cpu.adjust_stack_reg(2);

    if(cpu.modrm_byte < 0xC0) {
        var addr = cpu.modrm_resolve(cpu.modrm_byte);
        cpu.adjust_stack_reg(-2);
        cpu.safe_write16(addr, sp);
        cpu.adjust_stack_reg(2);
    } else {
        cpu.write_reg_e16(sp);
    }
};
t32[0x8F] = cpu => { cpu.read_modrm_byte();
    var sp = cpu.safe_read32s(cpu.get_stack_pointer(0));

    // change esp first, then resolve modrm address
    cpu.adjust_stack_reg(4);

    if(cpu.modrm_byte < 0xC0) {
        var addr = cpu.modrm_resolve(cpu.modrm_byte);

        // Before attempting a write that might cause a page fault,
        // we must set esp to the old value. Fuck Intel.
        cpu.adjust_stack_reg(-4);
        cpu.safe_write32(addr, sp);
        cpu.adjust_stack_reg(4);
    } else {
        cpu.write_reg_e32(sp);
    }
};

t[0x90] = cpu => { };
t16[0x91] = cpu => { cpu.xchg16r(reg_cx) };
t32[0x91] = cpu => { cpu.xchg32r(reg_ecx) };
t16[0x92] = cpu => { cpu.xchg16r(reg_dx) };
t32[0x92] = cpu => { cpu.xchg32r(reg_edx) };
t16[0x93] = cpu => { cpu.xchg16r(reg_bx) };
t32[0x93] = cpu => { cpu.xchg32r(reg_ebx) };
t16[0x94] = cpu => { cpu.xchg16r(reg_sp) };
t32[0x94] = cpu => { cpu.xchg32r(reg_esp) };
t16[0x95] = cpu => { cpu.xchg16r(reg_bp) };
t32[0x95] = cpu => { cpu.xchg32r(reg_ebp) };
t16[0x96] = cpu => { cpu.xchg16r(reg_si) };
t32[0x96] = cpu => { cpu.xchg32r(reg_esi) };
t16[0x97] = cpu => { cpu.xchg16r(reg_di) };
t32[0x97] = cpu => { cpu.xchg32r(reg_edi) };

t16[0x98] = cpu => { /* cbw */ cpu.reg16[reg_ax] = cpu.reg8s[reg_al]; };
t32[0x98] = cpu => { /* cwde */ cpu.reg32s[reg_eax] = cpu.reg16s[reg_ax]; };
t16[0x99] = cpu => { /* cwd */ cpu.reg16[reg_dx] = cpu.reg16s[reg_ax] >> 15; };
t32[0x99] = cpu => { /* cdq */ cpu.reg32s[reg_edx] = cpu.reg32s[reg_eax] >> 31; };

t16[0x9A] = cpu => {
    // callf
    var new_ip = cpu.read_op16();
    var new_cs = cpu.read_disp16();

    cpu.far_jump(new_ip, new_cs, true);
    dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
    cpu.diverged();
};
t32[0x9A] = cpu => {
    var new_ip = cpu.read_op32s();
    var new_cs = cpu.read_disp16();

    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        if(new_ip & 0xFFFF0000)
        {
            throw cpu.debug.unimpl("#GP handler");
        }
    }

    cpu.far_jump(new_ip, new_cs, true);
    dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
    cpu.diverged();
};

t[0x9B] = cpu => {
    // fwait: check for pending fpu exceptions
    if((cpu.cr[0] & (CR0_MP | CR0_TS)) === (CR0_MP | CR0_TS))
    {
        // task switched and MP bit is set
        cpu.trigger_nm();
    }
    else
    {
        if(cpu.fpu)
        {
            cpu.fpu.fwait();
        }
        else
        {
            // EM bit isn't checked
            // If there's no FPU, do nothing
        }
    }
};
t16[0x9C] = cpu => {
    // pushf
    if((cpu.flags & flag_vm) && cpu.getiopl() < 3)
    {
        dbg_assert(cpu.protected_mode);
        dbg_log("pushf #gp", LOG_CPU);
        cpu.trigger_gp(0);
    }
    else
    {
        cpu.push16(cpu.get_eflags());
    }
};
t32[0x9C] = cpu => {
    // pushf
    if((cpu.flags & flag_vm) && cpu.getiopl() < 3)
    {
        // trap to virtual 8086 monitor
        dbg_assert(cpu.protected_mode);
        dbg_log("pushf #gp", LOG_CPU);
        cpu.trigger_gp(0);
    }
    else
    {
        // vm and rf flag are cleared in image stored on the stack
        cpu.push32(cpu.get_eflags() & 0x00FCFFFF);
    }
};
t16[0x9D] = cpu => {
    // popf
    if((cpu.flags & flag_vm) && cpu.getiopl() < 3)
    {
        dbg_log("popf #gp", LOG_CPU);
        cpu.trigger_gp(0);
    }

    cpu.update_eflags((cpu.flags & ~0xFFFF) | cpu.pop16());

    if(cpu.flags & flag_trap)
    {
        // XXX: Problems with fdgame
        //cpu.clear_prefixes();
        //cpu.cycle_internal();
        cpu.flags &= ~flag_trap;
        //cpu.instruction_pointer = cpu.previous_ip;
        //cpu.raise_exception(1);
    }
    else
    {
        cpu.handle_irqs();
    }
};
t32[0x9D] = cpu => {
    // popf
    if((cpu.flags & flag_vm) && cpu.getiopl() < 3)
    {
        dbg_log("popf #gp", LOG_CPU);
        cpu.trigger_gp(0);
    }

    cpu.update_eflags(cpu.pop32s());
    cpu.handle_irqs();
};
t[0x9E] = cpu => {
    // sahf
    cpu.flags = (cpu.flags & ~0xFF) | cpu.reg8[reg_ah];
    cpu.flags = (cpu.flags & flags_mask) | flags_default;
    cpu.flags_changed = 0;
};
t[0x9F] = cpu => {
    // lahf
    cpu.reg8[reg_ah] = cpu.get_eflags();
};

t[0xA0] = cpu => {
    // mov
    var data = cpu.safe_read8(cpu.read_moffs());
    cpu.reg8[reg_al] = data;
};
t16[0xA1] = cpu => {
    // mov
    var data = cpu.safe_read16(cpu.read_moffs());
    cpu.reg16[reg_ax] = data;
};
t32[0xA1] = cpu => {
    var data = cpu.safe_read32s(cpu.read_moffs());
    cpu.reg32s[reg_eax] = data;
};
t[0xA2] = cpu => {
    // mov
    cpu.safe_write8(cpu.read_moffs(), cpu.reg8[reg_al]);
};
t16[0xA3] = cpu => {
    // mov
    cpu.safe_write16(cpu.read_moffs(), cpu.reg16[reg_ax]);
};
t32[0xA3] = cpu => {
    cpu.safe_write32(cpu.read_moffs(), cpu.reg32s[reg_eax]);
};

t[0xA4] = cpu => { cpu.movsb(); };
t16[0xA5] = cpu => { cpu.movsw(); };
t32[0xA5] = cpu => { cpu.movsd(); };
t[0xA6] = cpu => { cmpsb(cpu); };
t16[0xA7] = cpu => { cmpsw(cpu); };
t32[0xA7] = cpu => { cmpsd(cpu); };

t[0xA8] = cpu => {
    cpu.test8(cpu.reg8[reg_al], cpu.read_op8());
};
t16[0xA9] = cpu => {
    cpu.test16(cpu.reg16[reg_ax], cpu.read_op16());
};
t32[0xA9] = cpu => {
    cpu.test32(cpu.reg32s[reg_eax], cpu.read_op32s());
};

t[0xAA] = cpu => { stosb(cpu); };
t16[0xAB] = cpu => { stosw(cpu); };
t32[0xAB] = cpu => { stosd(cpu); };
t[0xAC] = cpu => { lodsb(cpu); };
t16[0xAD] = cpu => { lodsw(cpu); };
t32[0xAD] = cpu => { lodsd(cpu); };
t[0xAE] = cpu => { scasb(cpu); };
t16[0xAF] = cpu => { scasw(cpu); };
t32[0xAF] = cpu => { scasd(cpu); };


t[0xB0] = cpu => { cpu.reg8[reg_al] = cpu.read_op8(); };
t[0xB1] = cpu => { cpu.reg8[reg_cl] = cpu.read_op8(); };
t[0xB2] = cpu => { cpu.reg8[reg_dl] = cpu.read_op8(); };
t[0xB3] = cpu => { cpu.reg8[reg_bl] = cpu.read_op8(); };
t[0xB4] = cpu => { cpu.reg8[reg_ah] = cpu.read_op8(); };
t[0xB5] = cpu => { cpu.reg8[reg_ch] = cpu.read_op8(); };
t[0xB6] = cpu => { cpu.reg8[reg_dh] = cpu.read_op8(); };
t[0xB7] = cpu => { cpu.reg8[reg_bh] = cpu.read_op8(); };

t16[0xB8] = cpu => { cpu.reg16[reg_ax] = cpu.read_op16(); };
t32[0xB8] = cpu => { cpu.reg32s[reg_eax] = cpu.read_op32s(); };
t16[0xB9] = cpu => { cpu.reg16[reg_cx] = cpu.read_op16(); };
t32[0xB9] = cpu => { cpu.reg32s[reg_ecx] = cpu.read_op32s(); };
t16[0xBA] = cpu => { cpu.reg16[reg_dx] = cpu.read_op16(); };
t32[0xBA] = cpu => { cpu.reg32s[reg_edx] = cpu.read_op32s(); };
t16[0xBB] = cpu => { cpu.reg16[reg_bx] = cpu.read_op16(); };
t32[0xBB] = cpu => { cpu.reg32s[reg_ebx] = cpu.read_op32s(); };
t16[0xBC] = cpu => { cpu.reg16[reg_sp] = cpu.read_op16(); };
t32[0xBC] = cpu => { cpu.reg32s[reg_esp] = cpu.read_op32s(); };
t16[0xBD] = cpu => { cpu.reg16[reg_bp] = cpu.read_op16(); };
t32[0xBD] = cpu => { cpu.reg32s[reg_ebp] = cpu.read_op32s(); };
t16[0xBE] = cpu => { cpu.reg16[reg_si] = cpu.read_op16(); };
t32[0xBE] = cpu => { cpu.reg32s[reg_esi] = cpu.read_op32s(); };
t16[0xBF] = cpu => { cpu.reg16[reg_di] = cpu.read_op16(); };
t32[0xBF] = cpu => { cpu.reg32s[reg_edi] = cpu.read_op32s(); };


t[0xC0] = cpu => { cpu.read_modrm_byte();
    var op1 = cpu.read_write_e8();
    var op2 = cpu.read_op8() & 31;
    var result = 0;
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: result = cpu.rol8(op1, op2); break;
        case 1: result = cpu.ror8(op1, op2); break;
        case 2: result = cpu.rcl8(op1, op2); break;
        case 3: result = cpu.rcr8(op1, op2); break;
        case 4: result = cpu.shl8(op1, op2); break;
        case 5: result = cpu.shr8(op1, op2); break;
        case 6: result = cpu.shl8(op1, op2); break;
        case 7: result = cpu.sar8(op1, op2); break;
    }
    cpu.write_e8(result);
};
t16[0xC1] = cpu => { cpu.read_modrm_byte();
    var op1 = cpu.read_write_e16();
    var op2 = cpu.read_op8() & 31;
    var result = 0;
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: result = cpu.rol16(op1, op2); break;
        case 1: result = cpu.ror16(op1, op2); break;
        case 2: result = cpu.rcl16(op1, op2); break;
        case 3: result = cpu.rcr16(op1, op2); break;
        case 4: result = cpu.shl16(op1, op2); break;
        case 5: result = cpu.shr16(op1, op2); break;
        case 6: result = cpu.shl16(op1, op2); break;
        case 7: result = cpu.sar16(op1, op2); break;
    }
    cpu.write_e16(result);
};
t32[0xC1] = cpu => { cpu.read_modrm_byte();
    var op1 = cpu.read_write_e32();
    var op2 = cpu.read_op8() & 31;
    var result = 0;
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: result = cpu.rol32(op1, op2); break;
        case 1: result = cpu.ror32(op1, op2); break;
        case 2: result = cpu.rcl32(op1, op2); break;
        case 3: result = cpu.rcr32(op1, op2); break;
        case 4: result = cpu.shl32(op1, op2); break;
        case 5: result = cpu.shr32(op1, op2); break;
        case 6: result = cpu.shl32(op1, op2); break;
        case 7: result = cpu.sar32(op1, op2); break;
    }
    cpu.write_e32(result);
};

t16[0xC2] = cpu => {
    // retn
    var imm16 = cpu.read_op16();

    cpu.instruction_pointer = cpu.get_seg(reg_cs) + cpu.pop16() | 0;
    dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
    cpu.adjust_stack_reg(imm16);
    cpu.diverged();
};
t32[0xC2] = cpu => {
    // retn
    var imm16 = cpu.read_op16();
    var ip = cpu.pop32s();

    dbg_assert(cpu.is_asize_32() || ip < 0x10000);
    cpu.instruction_pointer = cpu.get_seg(reg_cs) + ip | 0;
    cpu.adjust_stack_reg(imm16);
    cpu.diverged();
};
t16[0xC3] = cpu => {
    // retn
    cpu.instruction_pointer = cpu.get_seg(reg_cs) + cpu.pop16() | 0;
    cpu.diverged();
};
t32[0xC3] = cpu => {
    // retn
    var ip = cpu.pop32s();
    dbg_assert(cpu.is_asize_32() || ip < 0x10000);
    cpu.instruction_pointer = cpu.get_seg(reg_cs) + ip | 0;
    cpu.diverged();
};

t16[0xC4] = cpu => { cpu.read_modrm_byte();
    cpu.lss16(reg_es);
};
t32[0xC4] = cpu => { cpu.read_modrm_byte();
    cpu.lss32(reg_es);
};
t16[0xC5] = cpu => { cpu.read_modrm_byte();
    cpu.lss16(reg_ds);
};
t32[0xC5] = cpu => { cpu.read_modrm_byte();
    cpu.lss32(reg_ds);
};

t[0xC6] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0) {
        cpu.safe_write8(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_op8());
    } else {
        cpu.reg8[cpu.modrm_byte << 2 & 0xC | cpu.modrm_byte >> 2 & 1] = cpu.read_op8();
    }
}
t16[0xC7] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0) {
        cpu.safe_write16(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_op16());
    } else {
        cpu.reg16[cpu.modrm_byte << 1 & 14] = cpu.read_op16();
    }
};
t32[0xC7] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0) {
        cpu.safe_write32(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_op32s());
    } else {
        cpu.reg32s[cpu.modrm_byte & 7] = cpu.read_op32s();
    }
}

t16[0xC8] = cpu => { cpu.enter16(cpu.read_op16(), cpu.read_disp8()); };
t32[0xC8] = cpu => { cpu.enter32(cpu.read_op16(), cpu.read_disp8()); };
t16[0xC9] = cpu => {
    // leave
    var old_vbp = cpu.stack_size_32 ? cpu.reg32s[reg_ebp] : cpu.reg16[reg_bp];
    var new_bp = cpu.safe_read16(cpu.get_seg(reg_ss) + old_vbp | 0);
    cpu.set_stack_reg(old_vbp + 2 | 0);
    cpu.reg16[reg_bp] = new_bp;
};
t32[0xC9] = cpu => {
    var old_vbp = cpu.stack_size_32 ? cpu.reg32s[reg_ebp] : cpu.reg16[reg_bp];
    var new_ebp = cpu.safe_read32s(cpu.get_seg(reg_ss) + old_vbp | 0);
    cpu.set_stack_reg(old_vbp + 4 | 0);
    cpu.reg32s[reg_ebp] = new_ebp;
};
t16[0xCA] = cpu => {
    // retf
    var imm16 = cpu.read_op16();
    var ip = cpu.safe_read16(cpu.get_stack_pointer(0));
    var cs = cpu.safe_read16(cpu.get_stack_pointer(2));

    cpu.far_return(ip, cs, imm16);
    cpu.diverged();
};
t32[0xCA] = cpu => {
    // retf
    var imm16 = cpu.read_op16();
    var ip = cpu.safe_read32s(cpu.get_stack_pointer(0));
    var cs = cpu.safe_read32s(cpu.get_stack_pointer(4)) & 0xFFFF;

    cpu.far_return(ip, cs, imm16);
    dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
    cpu.diverged();
};
t16[0xCB] = cpu => {
    // retf
    var ip = cpu.safe_read16(cpu.get_stack_pointer(0));
    var cs = cpu.safe_read16(cpu.get_stack_pointer(2));

    cpu.far_return(ip, cs, 0);
    dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
    cpu.diverged();
};
t32[0xCB] = cpu => {
    // retf
    var ip = cpu.safe_read32s(cpu.get_stack_pointer(0));
    var cs = cpu.safe_read32s(cpu.get_stack_pointer(4)) & 0xFFFF;

    cpu.far_return(ip, cs, 0);
    dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
    cpu.diverged();
};

t[0xCC] = cpu => {
    // INT3
    // TODO: inhibit iopl checks
    dbg_log("INT3", LOG_CPU);
    cpu.call_interrupt_vector(3, true, false);
    cpu.diverged();
};
t[0xCD] = cpu => {
    // INT
    var imm8 = cpu.read_op8();
    cpu.call_interrupt_vector(imm8, true, false);
    cpu.diverged();
};
t[0xCE] = cpu => {
    // INTO
    dbg_log("INTO", LOG_CPU);
    if(cpu.getof())
    {
        // TODO: inhibit iopl checks
        cpu.call_interrupt_vector(4, true, false);
    }
    cpu.diverged();
};

t16[0xCF] = cpu => {
    // iret
    cpu.iret16();
    cpu.diverged();
};
t32[0xCF] = cpu => {
    cpu.iret32();
    cpu.diverged();
};

t[0xD0] = cpu => { cpu.read_modrm_byte();
    var op1 = cpu.read_write_e8();
    var result = 0;
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: result = cpu.rol8(op1, 1); break;
        case 1: result = cpu.ror8(op1, 1); break;
        case 2: result = cpu.rcl8(op1, 1); break;
        case 3: result = cpu.rcr8(op1, 1); break;
        case 4: result = cpu.shl8(op1, 1); break;
        case 5: result = cpu.shr8(op1, 1); break;
        case 6: result = cpu.shl8(op1, 1); break;
        case 7: result = cpu.sar8(op1, 1); break;
    }
    cpu.write_e8(result);
};
t16[0xD1] = cpu => { cpu.read_modrm_byte();
    var op1 = cpu.read_write_e16();
    var result = 0;
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: result = cpu.rol16(op1, 1); break;
        case 1: result = cpu.ror16(op1, 1); break;
        case 2: result = cpu.rcl16(op1, 1); break;
        case 3: result = cpu.rcr16(op1, 1); break;
        case 4: result = cpu.shl16(op1, 1); break;
        case 5: result = cpu.shr16(op1, 1); break;
        case 6: result = cpu.shl16(op1, 1); break;
        case 7: result = cpu.sar16(op1, 1); break;
    }
    cpu.write_e16(result);
};
t32[0xD1] = cpu => { cpu.read_modrm_byte();
    var op1 = cpu.read_write_e32();
    var result = 0;
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: result = cpu.rol32(op1, 1); break;
        case 1: result = cpu.ror32(op1, 1); break;
        case 2: result = cpu.rcl32(op1, 1); break;
        case 3: result = cpu.rcr32(op1, 1); break;
        case 4: result = cpu.shl32(op1, 1); break;
        case 5: result = cpu.shr32(op1, 1); break;
        case 6: result = cpu.shl32(op1, 1); break;
        case 7: result = cpu.sar32(op1, 1); break;
    }
    cpu.write_e32(result);
};

t[0xD2] = cpu => { cpu.read_modrm_byte();
    var op1 = cpu.read_write_e8();
    var op2 = cpu.reg8[reg_cl] & 31;
    var result = 0;
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: result = cpu.rol8(op1, op2); break;
        case 1: result = cpu.ror8(op1, op2); break;
        case 2: result = cpu.rcl8(op1, op2); break;
        case 3: result = cpu.rcr8(op1, op2); break;
        case 4: result = cpu.shl8(op1, op2); break;
        case 5: result = cpu.shr8(op1, op2); break;
        case 6: result = cpu.shl8(op1, op2); break;
        case 7: result = cpu.sar8(op1, op2); break;
    }
    cpu.write_e8(result);
};
t16[0xD3] = cpu => { cpu.read_modrm_byte();
    var op1 = cpu.read_write_e16();
    var op2 = cpu.reg8[reg_cl] & 31;
    var result = 0;
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: result = cpu.rol16(op1, op2); break;
        case 1: result = cpu.ror16(op1, op2); break;
        case 2: result = cpu.rcl16(op1, op2); break;
        case 3: result = cpu.rcr16(op1, op2); break;
        case 4: result = cpu.shl16(op1, op2); break;
        case 5: result = cpu.shr16(op1, op2); break;
        case 6: result = cpu.shl16(op1, op2); break;
        case 7: result = cpu.sar16(op1, op2); break;
    }
    cpu.write_e16(result);
};
t32[0xD3] = cpu => { cpu.read_modrm_byte();
    var op1 = cpu.read_write_e32();
    var op2 = cpu.reg8[reg_cl] & 31;
    var result = 0;
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: result = cpu.rol32(op1, op2); break;
        case 1: result = cpu.ror32(op1, op2); break;
        case 2: result = cpu.rcl32(op1, op2); break;
        case 3: result = cpu.rcr32(op1, op2); break;
        case 4: result = cpu.shl32(op1, op2); break;
        case 5: result = cpu.shr32(op1, op2); break;
        case 6: result = cpu.shl32(op1, op2); break;
        case 7: result = cpu.sar32(op1, op2); break;
    }
    cpu.write_e32(result);
};

t[0xD4] = cpu => {
    cpu.bcd_aam(cpu.read_op8());
};
t[0xD5] = cpu => {
    cpu.bcd_aad(cpu.read_op8());
};

t[0xD6] = cpu => {
    // salc
    cpu.reg8[reg_al] = -cpu.getcf();
};
t[0xD7] = cpu => {
    // xlat
    if(cpu.is_asize_32())
    {
        cpu.reg8[reg_al] = cpu.safe_read8(cpu.get_seg_prefix(reg_ds) + cpu.reg32s[reg_ebx] + cpu.reg8[reg_al] | 0);
    }
    else
    {
        cpu.reg8[reg_al] = cpu.safe_read8(cpu.get_seg_prefix(reg_ds) + (cpu.reg16[reg_bx] + cpu.reg8[reg_al] & 0xFFFF) | 0);
    }
};

t[0xD8] = cpu => { cpu.read_modrm_byte();
    cpu.task_switch_test();
    if(cpu.modrm_byte < 0xC0)
        cpu.fpu.op_D8_mem(cpu.modrm_byte, cpu.modrm_resolve(cpu.modrm_byte));
    else
        cpu.fpu.op_D8_reg(cpu.modrm_byte);
};
t[0xD9] = cpu => { cpu.read_modrm_byte();
    cpu.task_switch_test();
    if(cpu.modrm_byte < 0xC0)
        cpu.fpu.op_D9_mem(cpu.modrm_byte, cpu.modrm_resolve(cpu.modrm_byte));
    else
        cpu.fpu.op_D9_reg(cpu.modrm_byte);
};
t[0xDA] = cpu => { cpu.read_modrm_byte();
    cpu.task_switch_test();
    if(cpu.modrm_byte < 0xC0)
        cpu.fpu.op_DA_mem(cpu.modrm_byte, cpu.modrm_resolve(cpu.modrm_byte));
    else
        cpu.fpu.op_DA_reg(cpu.modrm_byte);
};
t[0xDB] = cpu => { cpu.read_modrm_byte();
    cpu.task_switch_test();
    if(cpu.modrm_byte < 0xC0)
        cpu.fpu.op_DB_mem(cpu.modrm_byte, cpu.modrm_resolve(cpu.modrm_byte));
    else
        cpu.fpu.op_DB_reg(cpu.modrm_byte);
};
t[0xDC] = cpu => { cpu.read_modrm_byte();
    cpu.task_switch_test();
    if(cpu.modrm_byte < 0xC0)
        cpu.fpu.op_DC_mem(cpu.modrm_byte, cpu.modrm_resolve(cpu.modrm_byte));
    else
        cpu.fpu.op_DC_reg(cpu.modrm_byte);
};
t[0xDD] = cpu => { cpu.read_modrm_byte();
    cpu.task_switch_test();
    if(cpu.modrm_byte < 0xC0)
        cpu.fpu.op_DD_mem(cpu.modrm_byte, cpu.modrm_resolve(cpu.modrm_byte));
    else
        cpu.fpu.op_DD_reg(cpu.modrm_byte);
};
t[0xDE] = cpu => { cpu.read_modrm_byte();
    cpu.task_switch_test();
    if(cpu.modrm_byte < 0xC0)
        cpu.fpu.op_DE_mem(cpu.modrm_byte, cpu.modrm_resolve(cpu.modrm_byte));
    else
        cpu.fpu.op_DE_reg(cpu.modrm_byte);
};
t[0xDF] = cpu => { cpu.read_modrm_byte();
    cpu.task_switch_test();
    if(cpu.modrm_byte < 0xC0)
        cpu.fpu.op_DF_mem(cpu.modrm_byte, cpu.modrm_resolve(cpu.modrm_byte));
    else
        cpu.fpu.op_DF_reg(cpu.modrm_byte);
};

t[0xE0] = cpu => { cpu.loopne(cpu.read_op8s()); };
t[0xE1] = cpu => { cpu.loope(cpu.read_op8s()); };
t[0xE2] = cpu => { cpu.loop(cpu.read_op8s()); };
t[0xE3] = cpu => { cpu.jcxz(cpu.read_op8s()); };

t[0xE4] = cpu => {
    var port = cpu.read_op8();
    cpu.test_privileges_for_io(port, 1);
    cpu.reg8[reg_al] = cpu.io.port_read8(port);
    cpu.diverged();
};
t16[0xE5] = cpu => {
    var port = cpu.read_op8();
    cpu.test_privileges_for_io(port, 2);
    cpu.reg16[reg_ax] = cpu.io.port_read16(port);
    cpu.diverged();
};
t32[0xE5] = cpu => {
    var port = cpu.read_op8();
    cpu.test_privileges_for_io(port, 4);
    cpu.reg32s[reg_eax] = cpu.io.port_read32(port);
    cpu.diverged();
};
t[0xE6] = cpu => {
    var port = cpu.read_op8();
    cpu.test_privileges_for_io(port, 1);
    cpu.io.port_write8(port, cpu.reg8[reg_al]);
    cpu.diverged();
};
t16[0xE7] = cpu => {
    var port = cpu.read_op8();
    cpu.test_privileges_for_io(port, 2);
    cpu.io.port_write16(port, cpu.reg16[reg_ax]);
    cpu.diverged();
};
t32[0xE7] = cpu => {
    var port = cpu.read_op8();
    cpu.test_privileges_for_io(port, 4);
    cpu.io.port_write32(port, cpu.reg32s[reg_eax]);
    cpu.diverged();
};

t16[0xE8] = cpu => {
    // call
    var imm16 = cpu.read_op16();
    cpu.push16(cpu.get_real_eip());

    cpu.jmp_rel16(imm16);
    cpu.diverged();
};
t32[0xE8] = cpu => {
    // call
    var imm32s = cpu.read_op32s();
    cpu.push32(cpu.get_real_eip());

    cpu.instruction_pointer = cpu.instruction_pointer + imm32s | 0;
    dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
    cpu.diverged();
};
t16[0xE9] = cpu => {
    // jmp
    var imm16 = cpu.read_op16();
    cpu.jmp_rel16(imm16);
    cpu.diverged();
};
t32[0xE9] = cpu => {
    // jmp
    var imm32s = cpu.read_op32s();
    cpu.instruction_pointer = cpu.instruction_pointer + imm32s | 0;
    dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
    cpu.diverged();
};
t16[0xEA] = cpu => {
    // jmpf
    var ip = cpu.read_op16();
    var cs = cpu.read_disp16();
    cpu.far_jump(ip, cs, false);
    dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
    cpu.diverged();
};
t32[0xEA] = cpu => {
    // jmpf
    var new_ip = cpu.read_op32s();
    var cs = cpu.read_disp16();
    cpu.far_jump(new_ip, cs, false);
    dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
    cpu.diverged();
};
t[0xEB] = cpu => {
    // jmp near
    var imm8 = cpu.read_op8s();
    cpu.instruction_pointer = cpu.instruction_pointer + imm8 | 0;
    dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
    cpu.diverged();
};

t[0xEC] = cpu => {
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);
    cpu.reg8[reg_al] = cpu.io.port_read8(port);
    cpu.diverged();
};
t16[0xED] = cpu => {
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);
    cpu.reg16[reg_ax] = cpu.io.port_read16(port);
    cpu.diverged();
};
t32[0xED] = cpu => {
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);
    cpu.reg32s[reg_eax] = cpu.io.port_read32(port);
    cpu.diverged();
};
t[0xEE] = cpu => {
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);
    cpu.io.port_write8(port, cpu.reg8[reg_al]);
    cpu.diverged();
};
t16[0xEF] = cpu => {
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);
    cpu.io.port_write16(port, cpu.reg16[reg_ax]);
    cpu.diverged();
};
t32[0xEF] = cpu => {
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);
    cpu.io.port_write32(port, cpu.reg32s[reg_eax]);
    cpu.diverged();
};

t[0xF0] = cpu => {
    // lock
    //dbg_log("lock", LOG_CPU);

    // TODO
    // This triggers UD when used with
    // some instructions that don't write to memory
    cpu.run_prefix_instruction();
};
t[0xF1] = cpu => {
    // INT1
    // https://code.google.com/p/corkami/wiki/x86oddities#IceBP
    throw cpu.debug.unimpl("int1 instruction");
};

t[0xF2] = cpu => {
    // repnz
    dbg_assert((cpu.prefixes & PREFIX_MASK_REP) === 0);
    cpu.prefixes |= PREFIX_REPNZ;
    cpu.run_prefix_instruction();
    cpu.prefixes = 0;
};
t[0xF3] = cpu => {
    // repz
    dbg_assert((cpu.prefixes & PREFIX_MASK_REP) === 0);
    cpu.prefixes |= PREFIX_REPZ;
    cpu.run_prefix_instruction();
    cpu.prefixes = 0;
};

t[0xF4] = cpu => {
    cpu.hlt_op();
};

t[0xF5] = cpu => {
    // cmc
    cpu.flags = (cpu.flags | 1) ^ cpu.getcf();
    cpu.flags_changed &= ~1;
};

t[0xF6] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0:
            var data = cpu.read_e8(); cpu.test8(data, cpu.read_op8());
            break;
        case 1:
            var data = cpu.read_e8(); cpu.test8(data, cpu.read_op8());
            break;
        case 2:
            var data = cpu.read_write_e8(); cpu.write_e8(~(data));
            break;
        case 3:
            var data = cpu.read_write_e8(); cpu.write_e8(cpu.neg8(data));
            break;
        case 4:
            var data = cpu.read_e8(); cpu.mul8(data);
            break;
        case 5:
            var data = cpu.read_e8s(); cpu.imul8(data);
            break;
        case 6:
            var data = cpu.read_e8(); cpu.div8(data);
            break;
        case 7:
            var data = cpu.read_e8s(); cpu.idiv8(data);
            break;
    }
};

t16[0xF7] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0:
            var data = cpu.read_e16(); cpu.test16(data, cpu.read_op16());
            break;
        case 1:
            var data = cpu.read_e16(); cpu.test16(data, cpu.read_op16());
            break;
        case 2:
            var data = cpu.read_write_e16(); cpu.write_e16(~(data));
            break;
        case 3:
            var data = cpu.read_write_e16(); cpu.write_e16(cpu.neg16(data));
            break;
        case 4:
            var data = cpu.read_e16(); cpu.mul16(data);
            break;
        case 5:
            var data = cpu.read_e16s(); cpu.imul16(data);
            break;
        case 6:
            var data = cpu.read_e16(); cpu.div16(data);
            break;
        case 7:
            var data = cpu.read_e16s(); cpu.idiv16(data);
            break;
    }
};
t32[0xF7] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0:
            var data = cpu.read_e32s(); cpu.test32(data, cpu.read_op32s());
            break;
        case 1:
            var data = cpu.read_e32s(); cpu.test32(data, cpu.read_op32s());
            break;
        case 2:
            var data = cpu.read_write_e32(); cpu.write_e32(~(data));
            break;
        case 3:
            var data = cpu.read_write_e32(); cpu.write_e32(cpu.neg32(data));
            break;
        case 4:
            var data = cpu.read_e32(); cpu.mul32(data);
            break;
        case 5:
            var data = cpu.read_e32s(); cpu.imul32(data);
            break;
        case 6:
            var data = cpu.read_e32(); cpu.div32(data);
            break;
        case 7:
            var data = cpu.read_e32s(); cpu.idiv32(data);
            break;
    }
};

t[0xF8] = cpu => {
    // clc
    cpu.flags &= ~flag_carry;
    cpu.flags_changed &= ~1;
};
t[0xF9] = cpu => {
    // stc
    cpu.flags |= flag_carry;
    cpu.flags_changed &= ~1;
};

t[0xFA] = cpu => {
    // cli
    //dbg_log("interrupts off");

    if(!cpu.protected_mode || ((cpu.flags & flag_vm) ?
            cpu.getiopl() === 3 : cpu.getiopl() >= cpu.cpl))
    {
        cpu.flags &= ~flag_interrupt;
    }
    else
    {
        //if(cpu.getiopl() < 3 && ((cpu.flags & flag_vm) ?
        //    (cpu.cr[4] & CR4_VME) :
        //    (cpu.cpl === 3 && (cpu.cr[4] & CR4_PVI))))
        //{
        //    cpu.flags &= ~flag_vif;
        //}
        //else
        {
            dbg_log("cli #gp", LOG_CPU);
            cpu.trigger_gp(0);
        }
    }
};
t[0xFB] = cpu => {
    // sti
    //dbg_log("interrupts on");

    if(!cpu.protected_mode || ((cpu.flags & flag_vm) ?
            cpu.getiopl() === 3 : cpu.getiopl() >= cpu.cpl))
    {
        cpu.flags |= flag_interrupt;

        cpu.clear_prefixes();
        cpu.cycle_internal();

        cpu.handle_irqs();
    }
    else
    {
        //if(cpu.getiopl() < 3 && (cpu.flags & flag_vip) === 0 && ((cpu.flags & flag_vm) ?
        //    (cpu.cr[4] & CR4_VME) :
        //    (cpu.cpl === 3 && (cpu.cr[4] & CR4_PVI))))
        //{
        //    cpu.flags |= flag_vif;
        //}
        //else
        {
            dbg_log("sti #gp", LOG_CPU);
            cpu.trigger_gp(0);
        }
    }

};

t[0xFC] = cpu => {
    // cld
    cpu.flags &= ~flag_direction;
};
t[0xFD] = cpu => {
    // std
    cpu.flags |= flag_direction;
};

t[0xFE] = cpu => { cpu.read_modrm_byte();
    var mod = cpu.modrm_byte & 56;

    if(mod === 0)
    {
        var data = cpu.read_write_e8(); cpu.write_e8(cpu.inc8(data));
    }
    else if(mod === 8)
    {
        var data = cpu.read_write_e8(); cpu.write_e8(cpu.dec8(data));
    }
    else
    {
        cpu.todo();
    }
};
t16[0xFF] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0:
            var data = cpu.read_write_e16(); cpu.write_e16(cpu.inc16(data));
            break;
        case 1:
            var data = cpu.read_write_e16(); cpu.write_e16(cpu.dec16(data));
            break;
        case 2:
            // 2, call near
            var data = cpu.read_e16();
            cpu.push16(cpu.get_real_eip());
            cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0;
            dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
            cpu.diverged();
            break;
        case 3:
            // 3, callf
            if(cpu.modrm_byte >= 0xC0)
            {
                dbg_log("callf #ud", LOG_CPU);
                cpu.trigger_ud();
                dbg_assert(false, "unreachable");
            }

            var virt_addr = cpu.modrm_resolve(cpu.modrm_byte);
            var new_ip = cpu.safe_read16(virt_addr);
            var new_cs = cpu.safe_read16(virt_addr + 2 | 0);

            cpu.far_jump(new_ip, new_cs, true);
            dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
            cpu.diverged();
            break;
        case 4:
            // 4, jmp near
            var data = cpu.read_e16();
            cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0;
            dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
            cpu.diverged();
            break;
        case 5:
            // 5, jmpf
            if(cpu.modrm_byte >= 0xC0)
            {
                dbg_log("jmpf #ud", LOG_CPU);
                cpu.trigger_ud();
                dbg_assert(false, "unreachable");
            }

            var virt_addr = cpu.modrm_resolve(cpu.modrm_byte);
            var new_ip = cpu.safe_read16(virt_addr);
            var new_cs = cpu.safe_read16(virt_addr + 2 | 0);

            cpu.far_jump(new_ip, new_cs, false);
            dbg_assert(cpu.is_asize_32() || cpu.get_real_eip() < 0x10000);
            cpu.diverged();
            break;
        case 6:
            // 6, push
            var data = cpu.read_e16();
            cpu.push16(data);
            break;
        case 7:
            cpu.todo();
    }
};
t32[0xFF] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0:
            var data = cpu.read_write_e32(); cpu.write_e32(cpu.inc32(data));
            break;
        case 1:
            var data = cpu.read_write_e32(); cpu.write_e32(cpu.dec32(data));
            break;
        case 2:
            // 2, call near
            var data = cpu.read_e32s();
            cpu.push32(cpu.get_real_eip());

            dbg_assert(cpu.is_asize_32() || data < 0x10000);
            cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0;
            cpu.diverged();
            break;
        case 3:
            // 3, callf
            if(cpu.modrm_byte >= 0xC0)
            {
                dbg_log("callf #ud", LOG_CPU);
                cpu.trigger_ud();
                dbg_assert(false, "unreachable");
            }

            var virt_addr = cpu.modrm_resolve(cpu.modrm_byte);
            var new_ip = cpu.safe_read32s(virt_addr);
            var new_cs = cpu.safe_read16(virt_addr + 4 | 0);

            if(!cpu.protected_mode || cpu.vm86_mode())
            {
                if(new_ip & 0xFFFF0000)
                {
                    throw cpu.debug.unimpl("#GP handler");
                }
            }

            cpu.far_jump(new_ip, new_cs, true);
            dbg_assert(cpu.is_asize_32() || new_ip < 0x10000);
            cpu.diverged();
            break;
        case 4:
            // 4, jmp near
            var data = cpu.read_e32s();
            dbg_assert(cpu.is_asize_32() || data < 0x10000);
            cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0;
            cpu.diverged();
            break;
        case 5:
            // 5, jmpf
            if(cpu.modrm_byte >= 0xC0)
            {
                dbg_log("jmpf #ud", LOG_CPU);
                cpu.trigger_ud();
                dbg_assert(false, "unreachable");
            }

            var virt_addr = cpu.modrm_resolve(cpu.modrm_byte);
            var new_ip = cpu.safe_read32s(virt_addr);
            var new_cs = cpu.safe_read16(virt_addr + 4 | 0);

            if(!cpu.protected_mode || cpu.vm86_mode())
            {
                if(new_ip & 0xFFFF0000)
                {
                    throw cpu.debug.unimpl("#GP handler");
                }
            }

            cpu.far_jump(new_ip, new_cs, false);
            dbg_assert(cpu.is_asize_32() || new_ip < 0x10000);
            cpu.diverged();
            break;
        case 6:
            // push
            var data = cpu.read_e32s();
            cpu.push32(data);
            break;
        case 7:
            cpu.todo();
    }
};

var table16 = [];
var table32 = [];
CPU.prototype.table16 = table16;
CPU.prototype.table32 = table32;

for(var i = 0; i < 256; i++)
{
    if(t[i])
    {
        //dbg_assert(!t16[i]);
        //dbg_assert(!t32[i]);
        table16[i] = table32[i] = t[i];
    }
    else if(t16[i])
    {
        //dbg_assert(!t[i]);
        //dbg_assert(t32[i]);
        table16[i] = t16[i];
        table32[i] = t32[i];
    }
}

t = [];
t16 = [];
t32 = [];

// 0F ops start here

t[0x00] = cpu => { cpu.read_modrm_byte();
    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        // No GP, UD is correct here
        dbg_log("0f 00 #ud", LOG_CPU);
        cpu.trigger_ud();
    }

    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0:
            // sldt
            cpu.set_e16(cpu.sreg[reg_ldtr]);
            if(cpu.is_osize_32() && cpu.modrm_byte >= 0xC0)
            {
                cpu.reg32s[cpu.modrm_byte & 7] &= 0xFFFF;
            }
            break;
        case 1:
            // str
            cpu.set_e16(cpu.sreg[reg_tr]);
            if(cpu.is_osize_32() && cpu.modrm_byte >= 0xC0)
            {
                cpu.reg32s[cpu.modrm_byte & 7] &= 0xFFFF;
            }
            break;
        case 2:
            // lldt
            if(cpu.cpl)
            {
                cpu.trigger_gp(0);
            }

            var data = cpu.read_e16();
            cpu.load_ldt(data);
            break;
        case 3:
            // ltr
            if(cpu.cpl)
            {
                cpu.trigger_gp(0);
            }

            var data = cpu.read_e16();
            cpu.load_tr(data);
            break;
        case 4:
            cpu.verr(cpu.read_e16());
            break;
        case 5:
            cpu.verw(cpu.read_e16());
            break;

        default:
            dbg_log(cpu.modrm_byte >> 3 & 7, LOG_CPU);
            cpu.todo();
    }
};

t[0x01] = cpu => { cpu.read_modrm_byte();
    var mod = cpu.modrm_byte >> 3 & 7;

    if(mod === 4)
    {
        // smsw
        if(cpu.modrm_byte >= 0xC0 && cpu.is_osize_32())
        {
            cpu.set_e32(cpu.cr[0]);
        }
        else
        {
            cpu.set_e16(cpu.cr[0]);
        }
        return;
    }
    else if(mod === 6)
    {
        // lmsw
        if(cpu.cpl)
        {
            cpu.trigger_gp(0);
        }

        var cr0 = cpu.read_e16();

        cr0 = (cpu.cr[0] & ~0xF) | (cr0 & 0xF);

        if(cpu.protected_mode)
        {
            // lmsw cannot be used to switch back
            cr0 |= CR0_PE;
        }

        cpu.set_cr0(cr0);
        return;
    }

    if(cpu.modrm_byte >= 0xC0)
    {
        // only memory
        dbg_log("0f 01 #ud", LOG_CPU);
        cpu.trigger_ud();
    }

    var addr = cpu.modrm_resolve(cpu.modrm_byte);

    switch(mod)
    {
        case 0:
            // sgdt
            cpu.writable_or_pagefault(addr, 6);
            cpu.safe_write16(addr, cpu.gdtr_size);
            var mask = cpu.is_osize_32() ? -1 : 0x00FFFFFF;
            cpu.safe_write32(addr + 2, cpu.gdtr_offset & mask);
            break;
        case 1:
            // sidt
            cpu.writable_or_pagefault(addr, 6);
            cpu.safe_write16(addr, cpu.idtr_size);
            var mask = cpu.is_osize_32() ? -1 : 0x00FFFFFF;
            cpu.safe_write32(addr + 2, cpu.idtr_offset & mask);
            break;
        case 2:
            // lgdt
            if(cpu.cpl)
            {
                cpu.trigger_gp(0);
            }

            var size = cpu.safe_read16(addr);
            var offset = cpu.safe_read32s(addr + 2);

            cpu.gdtr_size = size;
            cpu.gdtr_offset = offset;

            if(!cpu.is_osize_32())
            {
                cpu.gdtr_offset &= 0xFFFFFF;
            }

            //dbg_log("gdt at " + h(cpu.gdtr_offset) + ", " + cpu.gdtr_size + " bytes", LOG_CPU);
            //cpu.debug.dump_state();
            //cpu.debug.dump_regs_short();
            //cpu.debug.dump_gdt_ldt();
            break;
        case 3:
            // lidt
            if(cpu.cpl)
            {
                cpu.trigger_gp(0);
            }

            var size = cpu.safe_read16(addr);
            var offset = cpu.safe_read32s(addr + 2);

            cpu.idtr_size = size;
            cpu.idtr_offset = offset;

            if(!cpu.is_osize_32())
            {
                cpu.idtr_offset &= 0xFFFFFF;
            }

            //dbg_log("[" + h(cpu.instruction_pointer) + "] idt at " +
            //        h(idtr_offset) + ", " + cpu.idtr_size + " bytes " + h(addr), LOG_CPU);
            break;
        case 7:
            // flush translation lookaside buffer
            if(cpu.cpl)
            {
                cpu.trigger_gp(0);
            }

            cpu.invlpg(addr);
            break;
        default:
            dbg_log(mod);
            cpu.todo();
    }
};

t16[0x02] = cpu => { cpu.read_modrm_byte();
    // lar
    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        dbg_log("lar #ud", LOG_CPU);
        cpu.trigger_ud();
    }
    var data = cpu.read_e16();
    cpu.write_g16(cpu.lar(data, cpu.read_g16()));
};
t32[0x02] = cpu => { cpu.read_modrm_byte();
    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        dbg_log("lar #ud", LOG_CPU);
        cpu.trigger_ud();
    }
    var data = cpu.read_e16();
    cpu.write_g32(cpu.lar(data, cpu.read_g32s()));
};

t16[0x03] = cpu => { cpu.read_modrm_byte();
    // lsl
    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        dbg_log("lsl #ud", LOG_CPU);
        cpu.trigger_ud();
    }
    var data = cpu.read_e16();
    cpu.write_g16(cpu.lsl(data, cpu.read_g16()));
};
t32[0x03] = cpu => { cpu.read_modrm_byte();
    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        dbg_log("lsl #ud", LOG_CPU);
        cpu.trigger_ud();
    }
    var data = cpu.read_e16();
    cpu.write_g32(cpu.lsl(data, cpu.read_g32s()));
};

t[0x04] = cpu => { cpu.undefined_instruction(); };
t[0x05] = cpu => { cpu.undefined_instruction(); };

t[0x06] = cpu => {
    // clts
    if(cpu.cpl)
    {
        dbg_log("clts #gp", LOG_CPU);
        cpu.trigger_gp(0);
    }
    else
    {
        //dbg_log("clts", LOG_CPU);
        cpu.cr[0] &= ~CR0_TS;
    }
};

t[0x07] = cpu => { cpu.undefined_instruction(); };
t[0x08] = cpu => {
    // invd
    cpu.todo();
};

t[0x09] = cpu => {
    if(cpu.cpl)
    {
        dbg_log("wbinvd #gp", LOG_CPU);
        cpu.trigger_gp(0);
    }
    // wbinvd
};


t[0x0A] = cpu => { cpu.undefined_instruction(); };
t[0x0B] = cpu => {
    // UD2
    cpu.trigger_ud();
};
t[0x0C] = cpu => { cpu.undefined_instruction(); };

t[0x0D] = cpu => {
    // nop
    cpu.todo();
};

t[0x0E] = cpu => { cpu.undefined_instruction(); };
t[0x0F] = cpu => { cpu.undefined_instruction(); };

t[0x10] = cpu => { cpu.unimplemented_sse(); };
t[0x11] = cpu => { cpu.unimplemented_sse(); };
t[0x12] = cpu => {
    // movlpd xmm, xmm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_66);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();
    let data = cpu.read_xmm_mem64s();
    cpu.write_xmm64(data[0], data[1]);
};
t[0x13] = cpu => {
    // movlpd xmm/m64, xmm
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_66);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();
    let data = cpu.read_xmm64s();
    dbg_assert(cpu.modrm_byte < 0xC0);
    var addr = cpu.modrm_resolve(cpu.modrm_byte);
    cpu.safe_write64(addr, data[0], data[1]);
};
t[0x14] = cpu => { cpu.unimplemented_sse(); };
t[0x15] = cpu => { cpu.unimplemented_sse(); };
t[0x16] = cpu => { cpu.unimplemented_sse(); };
t[0x17] = cpu => { cpu.unimplemented_sse(); };

t[0x18] = cpu => { cpu.read_modrm_byte();
    // prefetch
    // nop for us
    if(cpu.modrm_byte < 0xC0)
        cpu.modrm_resolve(cpu.modrm_byte);
};

t[0x19] = cpu => { cpu.unimplemented_sse(); };
t[0x1A] = cpu => { cpu.unimplemented_sse(); };
t[0x1B] = cpu => { cpu.unimplemented_sse(); };
t[0x1C] = cpu => { cpu.unimplemented_sse(); };
t[0x1D] = cpu => { cpu.unimplemented_sse(); };
t[0x1E] = cpu => { cpu.unimplemented_sse(); };
t[0x1F] = cpu => { cpu.read_modrm_byte()
    // multi-byte nop
    if(cpu.modrm_byte < 0xC0)
        cpu.modrm_resolve(cpu.modrm_byte);
};


t[0x20] = cpu => { cpu.read_modrm_byte();

    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }
    //dbg_log("cr" + (cpu.modrm_byte >> 3 & 7) + " read", LOG_CPU);

    // mov addr, cr
    // mod = which control register
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0:
            cpu.write_reg_e32(cpu.cr[0]);
            break;
        case 2:
            //dbg_log("read cr2 at " + h(cpu.instruction_pointer >>> 0, 8));
            cpu.write_reg_e32(cpu.cr[2]);
            break;
        case 3:
            //dbg_log("read cr3 (" + h(cpu.cr[3], 8) + ")", LOG_CPU);
            cpu.write_reg_e32(cpu.cr[3]);
            break;
        case 4:
            cpu.write_reg_e32(cpu.cr[4]);
            break;
        default:
            dbg_log(cpu.modrm_byte >> 3 & 7);
            dbg_assert(false);
            cpu.trigger_ud();
    }
};

t[0x21] = cpu => { cpu.read_modrm_byte();
    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }

    var dreg = cpu.modrm_byte >> 3 & 7;
    if((cpu.cr[4] & CR4_DE) && (dreg === 4 || dreg === 5))
    {
        dbg_log("#ud mov dreg 4/5 with cr4.DE set", LOG_CPU);
        cpu.trigger_ud();
    }

    // high two bits of modrm are ignored
    cpu.reg32s[cpu.modrm_byte & 7] = cpu.dreg[dreg];

    //dbg_log("read dr" + dreg + ": " + h(cpu.dreg[dreg] >>> 0), LOG_CPU);
};

t[0x22] = cpu => { cpu.read_modrm_byte();

    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }

    var data = cpu.read_reg_e32s();
    //dbg_log("cr" + (cpu.modrm_byte >> 3 & 7) + " written: " + h(data >>> 0, 8), LOG_CPU);

    // mov cr, addr
    // mod = which control register
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0:
            cpu.set_cr0(data);
            //dbg_log("cr0=" + h(data >>> 0), LOG_CPU);
            break;

        case 2:
            cpu.cr[2] = data;
            //dbg_log("cr2=" + h(data >>> 0), LOG_CPU);
            break;

        case 3:
            //dbg_log("cr3=" + h(data >>> 0), LOG_CPU);
            data &= ~0b111111100111;
            dbg_assert((data & 0xFFF) === 0, "TODO");
            cpu.cr[3] = data;
            cpu.clear_tlb();

            //dump_page_directory();
            //dbg_log("page directory loaded at " + h(cpu.cr[3] >>> 0, 8), LOG_CPU);
            break;

        case 4:
            cpu.set_cr4(data);
            break;

        default:
            dbg_log(cpu.modrm_byte >> 3 & 7);
            dbg_assert(false);
            cpu.trigger_ud();
    }
};
t[0x23] = cpu => { cpu.read_modrm_byte();
    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }

    var dreg = cpu.modrm_byte >> 3 & 7;
    if((cpu.cr[4] & CR4_DE) && (dreg === 4 || dreg === 5))
    {
        dbg_log("#ud mov dreg 4/5 with cr4.DE set", LOG_CPU);
        cpu.trigger_ud();
    }

    // high two bits of modrm are ignored
    cpu.dreg[dreg] = cpu.read_reg_e32s();

    //dbg_log("write dr" + dreg + ": " + h(cpu.dreg[dreg] >>> 0), LOG_CPU);
};

t[0x24] = cpu => { cpu.undefined_instruction(); };
t[0x25] = cpu => { cpu.undefined_instruction(); };
t[0x26] = cpu => { cpu.undefined_instruction(); };
t[0x27] = cpu => { cpu.undefined_instruction(); };

t[0x28] = cpu => {
    // movaps xmm, xmm/m128
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();
    let data = cpu.read_xmm_mem128s();
    cpu.write_xmm128s(data[0], data[1], data[2], data[3]);
};
t[0x29] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();
    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_66)
    {
        // movapd xmm/m128, xmm
        // (note: same as below, see google.com/?q=MOVAPD+vs+MOVAPS)
        let data = cpu.read_xmm128s();
        dbg_assert(cpu.modrm_byte < 0xC0);
        let addr = cpu.modrm_resolve(cpu.modrm_byte);
        cpu.safe_write128(addr, data[0], data[1], data[2], data[3]);
    }
    else
    {
        // movaps xmm/m128, xmm
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === 0);
        let data = cpu.read_xmm128s();
        dbg_assert(cpu.modrm_byte < 0xC0);
        let addr = cpu.modrm_resolve(cpu.modrm_byte);
        cpu.safe_write128(addr, data[0], data[1], data[2], data[3]);
    }
};
t[0x2A] = cpu => {
    // cvtpi2ps xmm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();
    let data = cpu.read_mmx_mem64s();
    let float32 = new Float32Array(2);
    let res32 = new Uint32Array(float32.buffer);
    float32[0] = data[0];
    float32[1] = data[1];
    cpu.write_xmm64(res32[0], res32[1]);
 };
t[0x2B] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();
    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_66)
    {
        // movntpd m128, xmm
        let data = cpu.read_xmm128s();
        dbg_assert(cpu.modrm_byte < 0xC0);
        let addr = cpu.modrm_resolve(cpu.modrm_byte);
        cpu.safe_write128(addr, data[0], data[1], data[2], data[3]);
    }
    else
    {
        // movntps m128, xmm
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === 0);
        let data = cpu.read_xmm128s();
        dbg_assert(cpu.modrm_byte < 0xC0);
        let addr = cpu.modrm_resolve(cpu.modrm_byte);
        cpu.safe_write128(addr, data[0], data[1], data[2], data[3]);
    }
 };
t[0x2C] = cpu => {
    // cvttps2pi mm, xmm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let data = cpu.read_xmm_mem64s();
    let float32 = new Float32Array(data.buffer);
    let low = 0;
    let high = 0;

    var res0 = Math.trunc(float32[0]);
    if(res0 <= 0x7FFFFFFF && res0 >= -0x80000000)
    {
        low = res0;
    }
    else
    {
        low = 0x80000000|0;
    }

    var res1 = Math.trunc(float32[1]);
    if(res1 <= 0x7FFFFFFF && res1 >= -0x80000000)
    {
        high = res1;
    }
    else
    {
        high = 0x80000000|0;
    }

    cpu.write_mmx64s(low, high);
};

t[0x2D] = cpu => {
    // cvtps2pi mm, xmm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let data = cpu.read_xmm_mem64s();
    let float32 = new Float32Array(data.buffer);
    let low = 0;
    let high = 0;
    var rc = cpu.mxcsr >> 13 & 3;

    var res0 = cpu.integer_round(float32[0], rc);
    if(res0 <= 0x7FFFFFFF && res0 >= -0x80000000)
    {
        low = res0;
    }
    else
    {
        low = 0x80000000|0;
    }

    var res1 = cpu.integer_round(float32[1], rc);
    if(res1 <= 0x7FFFFFFF && res1 >= -0x80000000)
    {
        high = res1;
    }
    else
    {
        high = 0x80000000|0;
    }

    cpu.write_mmx64s(low, high);
};

t[0x2E] = cpu => {
    // ucomiss xmm1, xmm2/m32
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source1 = cpu.read_xmm128s();
    let source2 = cpu.read_xmm_mem128s();

    let x = (new Float32Array(source1.buffer))[0];
    let y = (new Float32Array(source2.buffer))[0];

    cpu.flags_changed &= ~(1 | flag_parity | flag_zero);
    cpu.flags &= ~(1 | flag_parity | flag_zero);

    if(x > y)
    {
    }
    else if(y > x)
    {
        cpu.flags |= 1;
    }
    else if(x === y)
    {
        cpu.flags |= flag_zero;
    }
    else
    {
        cpu.flags |= 1 | flag_parity | flag_zero;

        if (cpu.is_SNaN32(source1[0]) || cpu.is_SNaN32(source2[0])) {
            cpu.invalid_arithmatic();
        }
    }
};

t[0x2F] = cpu => {
    // comiss xmm1, xmm2/m32
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source1 = cpu.read_xmm128s();
    let source2 = cpu.read_xmm_mem128s();

    let x = (new Float32Array(source1.buffer))[0];
    let y = (new Float32Array(source2.buffer))[0];

    cpu.flags_changed &= ~(1 | flag_parity | flag_zero);
    cpu.flags &= ~(1 | flag_parity | flag_zero);

    if(x > y)
    {
    }
    else if(y > x)
    {
        cpu.flags |= 1;
    }
    else if(x === y)
    {
        cpu.flags |= flag_zero;
    }
    else
    {
        cpu.flags |= 1 | flag_parity | flag_zero;
        cpu.invalid_arithmatic();
    }
};

// wrmsr
t[0x30] = cpu => {
    // wrmsr - write maschine specific register

    if(cpu.cpl)
    {
        // cpl > 0 or vm86 mode (vm86 mode is always runs with cpl=3)
        cpu.trigger_gp(0);
    }

    var index = cpu.reg32s[reg_ecx];
    var low = cpu.reg32s[reg_eax];
    var high = cpu.reg32s[reg_edx];

    if(index !== IA32_SYSENTER_ESP)
    {
        dbg_log("wrmsr ecx=" + h(index >>> 0, 8) +
                    " data=" + h(high >>> 0, 8) + ":" + h(low >>> 0, 8), LOG_CPU);
    }

    switch(index)
    {
        case IA32_SYSENTER_CS:
            cpu.sysenter_cs = low & 0xFFFF;
            break;

        case IA32_SYSENTER_EIP:
            cpu.sysenter_eip = low;
            break;

        case IA32_SYSENTER_ESP:
            cpu.sysenter_esp = low;
            break;

        case IA32_APIC_BASE_MSR:
            dbg_assert(high === 0, "Changing APIC address (high 32 bits) not supported");
            let address = low & ~(IA32_APIC_BASE_BSP | IA32_APIC_BASE_EXTD | IA32_APIC_BASE_EN);
            dbg_assert((address >>> 0) === APIC_ADDRESS, "Changing APIC address not supported");
            dbg_assert((low & IA32_APIC_BASE_EXTD) === 0, "x2apic not supported");
            cpu.apic_enabled = (low & IA32_APIC_BASE_EN) === IA32_APIC_BASE_EN;
            break;

        case IA32_TIME_STAMP_COUNTER:
            var new_tick = (low >>> 0) + 0x100000000 * (high >>> 0);
            cpu.tsc_offset = v86.microtick() - new_tick / TSC_RATE;
            break;

        case IA32_BIOS_SIGN_ID:
            break;

        case IA32_MISC_ENABLE: // Enable Misc. Processor Features
            dbg_log("IA32_MISC_ENABLE=" + h(low >>> 0, 8), LOG_CPU);
            break;

        case IA32_MCG_CAP:
            // netbsd
            break;

        case IA32_KERNEL_GS_BASE:
            // Only used in 64 bit mode (by SWAPGS), but set by kvm-unit-test
            dbg_log("GS Base written", LOG_CPU);
            break;

        default:
            dbg_assert(false, "Unknown msr: " + h(index >>> 0, 8));
    }
};

t[0x31] = cpu => {
    // rdtsc - read timestamp counter

    if(!cpu.cpl || !(cpu.cr[4] & CR4_TSD))
    {
        var n = v86.microtick() - cpu.tsc_offset;
        dbg_assert(isFinite(n), "non-finite tsc: " + n);

        cpu.reg32s[reg_eax] = n * TSC_RATE;
        cpu.reg32s[reg_edx] = n * (TSC_RATE / 0x100000000);

        //dbg_log("rdtsc  edx:eax=" + h(cpu.reg32[reg_edx], 8) + ":" + h(cpu.reg32[reg_eax], 8), LOG_CPU);
    }
    else
    {
        cpu.trigger_gp(0);
    }
};

t[0x32] = cpu => {
    // rdmsr - read maschine specific register
    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }

    var index = cpu.reg32s[reg_ecx];

    dbg_log("rdmsr ecx=" + h(index >>> 0, 8), LOG_CPU);

    var low = 0;
    var high = 0;

    switch(index)
    {
        case IA32_SYSENTER_CS:
            low = cpu.sysenter_cs;
            break;

        case IA32_SYSENTER_EIP:
            low = cpu.sysenter_eip;
            break;

        case IA32_SYSENTER_ESP:
            low = cpu.sysenter_esp;
            break;

        case IA32_TIME_STAMP_COUNTER:
            var n = v86.microtick() - cpu.tsc_offset;
            low = n * TSC_RATE;
            high = n * (TSC_RATE / 0x100000000);
            break;

        case IA32_PLATFORM_ID:
            break;

        case IA32_APIC_BASE_MSR:
            if(ENABLE_ACPI)
            {
                low = APIC_ADDRESS;

                if(cpu.apic_enabled)
                {
                    low |= IA32_APIC_BASE_EN;
                }
            }
            break;

        case IA32_BIOS_SIGN_ID:
            break;

        case IA32_MISC_ENABLE: // Enable Misc. Processor Features
            break;

        case IA32_RTIT_CTL:
            // linux4
            break;

        case MSR_SMI_COUNT:
            break;

        case IA32_MCG_CAP:
            // netbsd
            break;

        case MSR_PKG_C2_RESIDENCY:
            break;

        case MSR_EBC_FREQUENCY_ID:
            low = 1 << 24;
            break;

        default:
            dbg_assert(false, "Unknown msr: " + h(index >>> 0, 8));
    }

    cpu.reg32s[reg_eax] = low;
    cpu.reg32s[reg_edx] = high;
};

t[0x33] = cpu => {
    // rdpmc
    cpu.todo();
};

t[0x34] = cpu => {
    // sysenter
    var seg = cpu.sysenter_cs & 0xFFFC;

    if(!cpu.protected_mode || seg === 0)
    {
        cpu.trigger_gp(0);
    }

    //dbg_log("sysenter  cs:eip=" + h(seg    , 4) + ":" + h(cpu.sysenter_eip >>> 0, 8) +
    //                 " ss:esp=" + h(seg + 8, 4) + ":" + h(cpu.sysenter_esp >>> 0, 8), LOG_CPU);

    cpu.flags &= ~flag_vm & ~flag_interrupt;

    cpu.instruction_pointer = cpu.sysenter_eip;
    cpu.reg32s[reg_esp] = cpu.sysenter_esp;

    cpu.sreg[reg_cs] = seg;
    cpu.segment_is_null[reg_cs] = 0;
    cpu.segment_limits[reg_cs] = -1;
    cpu.segment_offsets[reg_cs] = 0;

    cpu.update_cs_size(true);

    cpu.cpl = 0;
    cpu.cpl_changed();

    cpu.sreg[reg_ss] = seg + 8;
    cpu.segment_is_null[reg_ss] = 0;
    cpu.segment_limits[reg_ss] = -1;
    cpu.segment_offsets[reg_ss] = 0;

    cpu.stack_size_32 = true;
    cpu.diverged();
};

t[0x35] = cpu => {
    // sysexit
    var seg = cpu.sysenter_cs & 0xFFFC;

    if(!cpu.protected_mode || cpu.cpl || seg === 0)
    {
        cpu.trigger_gp(0);
    }

    //dbg_log("sysexit  cs:eip=" + h(seg + 16, 4) + ":" + h(cpu.reg32s[reg_edx] >>> 0, 8) +
    //                 " ss:esp=" + h(seg + 24, 4) + ":" + h(cpu.reg32s[reg_ecx] >>> 0, 8), LOG_CPU);

    cpu.instruction_pointer = cpu.reg32s[reg_edx];
    cpu.reg32s[reg_esp] = cpu.reg32s[reg_ecx];

    cpu.sreg[reg_cs] = seg + 16 | 3;

    cpu.segment_is_null[reg_cs] = 0;
    cpu.segment_limits[reg_cs] = -1;
    cpu.segment_offsets[reg_cs] = 0;

    cpu.update_cs_size(true);

    cpu.cpl = 3;
    cpu.cpl_changed();

    cpu.sreg[reg_ss] = seg + 24 | 3;
    cpu.segment_is_null[reg_ss] = 0;
    cpu.segment_limits[reg_ss] = -1;
    cpu.segment_offsets[reg_ss] = 0;

    cpu.stack_size_32 = true;
    cpu.diverged();
};

t[0x36] = cpu => { cpu.undefined_instruction(); };

t[0x37] = cpu => {
    // getsec
    cpu.todo();
};

// sse3+
t[0x38] = cpu => { cpu.unimplemented_sse(); };
t[0x39] = cpu => { cpu.unimplemented_sse(); };
t[0x3A] = cpu => { cpu.unimplemented_sse(); };
t[0x3B] = cpu => { cpu.unimplemented_sse(); };
t[0x3C] = cpu => { cpu.unimplemented_sse(); };
t[0x3D] = cpu => { cpu.unimplemented_sse(); };
t[0x3E] = cpu => { cpu.unimplemented_sse(); };
t[0x3F] = cpu => { cpu.unimplemented_sse(); };

// cmov
t16[0x40] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16( cpu.test_o()); };
t32[0x40] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32( cpu.test_o()); };
t16[0x41] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16(!cpu.test_o()); };
t32[0x41] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32(!cpu.test_o()); };
t16[0x42] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16( cpu.test_b()); };
t32[0x42] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32( cpu.test_b()); };
t16[0x43] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16(!cpu.test_b()); };
t32[0x43] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32(!cpu.test_b()); };
t16[0x44] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16( cpu.test_z()); };
t32[0x44] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32( cpu.test_z()); };
t16[0x45] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16(!cpu.test_z()); };
t32[0x45] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32(!cpu.test_z()); };
t16[0x46] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16( cpu.test_be()); };
t32[0x46] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32( cpu.test_be()); };
t16[0x47] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16(!cpu.test_be()); };
t32[0x47] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32(!cpu.test_be()); };
t16[0x48] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16( cpu.test_s()); };
t32[0x48] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32( cpu.test_s()); };
t16[0x49] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16(!cpu.test_s()); };
t32[0x49] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32(!cpu.test_s()); };
t16[0x4A] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16( cpu.test_p()); };
t32[0x4A] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32( cpu.test_p()); };
t16[0x4B] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16(!cpu.test_p()); };
t32[0x4B] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32(!cpu.test_p()); };
t16[0x4C] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16( cpu.test_l()); };
t32[0x4C] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32( cpu.test_l()); };
t16[0x4D] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16(!cpu.test_l()); };
t32[0x4D] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32(!cpu.test_l()); };
t16[0x4E] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16( cpu.test_le()); };
t32[0x4E] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32( cpu.test_le()); };
t16[0x4F] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc16(!cpu.test_le()); };
t32[0x4F] = cpu => { cpu.read_modrm_byte(); cpu.cmovcc32(!cpu.test_le()); };


t[0x50] = cpu => { cpu.unimplemented_sse(); };
t[0x51] = cpu => { cpu.unimplemented_sse(); };
t[0x52] = cpu => { cpu.unimplemented_sse(); };
t[0x53] = cpu => { cpu.unimplemented_sse(); };
t[0x54] = cpu => { cpu.unimplemented_sse(); };
t[0x55] = cpu => { cpu.unimplemented_sse(); };
t[0x56] = cpu => { cpu.unimplemented_sse(); };
t[0x57] = cpu => {
    // xorps xmm, xmm/mem128
    // xorpd xmm, xmm/mem128
    // Note: Same code as pxor
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_xmm_mem128s();
    let destination = cpu.read_xmm128s();

    cpu.write_xmm128s(
        source[0] ^ destination[0],
        source[1] ^ destination[1],
        source[2] ^ destination[2],
        source[3] ^ destination[3]
    );
};

t[0x58] = cpu => { cpu.unimplemented_sse(); };
t[0x59] = cpu => { cpu.unimplemented_sse(); };
t[0x5A] = cpu => { cpu.unimplemented_sse(); };
t[0x5B] = cpu => { cpu.unimplemented_sse(); };
t[0x5C] = cpu => { cpu.unimplemented_sse(); };
t[0x5D] = cpu => { cpu.unimplemented_sse(); };
t[0x5E] = cpu => { cpu.unimplemented_sse(); };
t[0x5F] = cpu => { cpu.unimplemented_sse(); };

t[0x60] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // punpcklbw xmm, xmm/m128
        let source = cpu.read_xmm_mem64s();
        let source8 = new Uint8Array(source.buffer);

        let destination = cpu.read_xmm64s();
        let destination8 = new Uint8Array(destination.buffer);

        cpu.write_xmm128s(
            destination8[0] | source8[0] << 8 | destination8[1] << 16 | source8[1] << 24,
            destination8[2] | source8[2] << 8 | destination8[3] << 16 | source8[3] << 24,
            destination8[4] | source8[4] << 8 | destination8[5] << 16 | source8[5] << 24,
            destination8[6] | source8[6] << 8 | destination8[7] << 16 | source8[7] << 24
        );
    }
    else
    {
        // punpcklbw mm, mm/m32
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);

        let source = cpu.read_mmx_mem32s();
        let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];

        let byte0 = destination_low & 0xFF;
        let byte1 = source & 0xFF;
        let byte2 = (destination_low >> 8) & 0xFF;
        let byte3 = (source >> 8) & 0xFF;
        let byte4 = (destination_low >> 16) & 0xFF;
        let byte5 = (source >> 16) & 0xFF;
        let byte6 = destination_low >>> 24;
        let byte7 = source >>> 24;

        let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
        let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

        cpu.write_mmx64s(low, high);
    }
};

t[0x61] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // punpcklwd xmm, xmm/m128
        let source = cpu.read_xmm_mem64s();
        let source16 = new Uint16Array(source.buffer);

        let destination = cpu.read_xmm64s();
        let destination16 = new Uint16Array(destination.buffer);

        cpu.write_xmm128s(
            destination16[0] | source16[0] << 16,
            destination16[1] | source16[1] << 16,
            destination16[2] | source16[2] << 16,
            destination16[3] | source16[3] << 16
        );
    }
    else
    {
        // punpcklwd mm, mm/m32
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
        let source = cpu.read_mmx_mem32s();
        let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];

        let word0 = destination_low & 0xFFFF;
        let word1 = source & 0xFFFF;
        let word2 = destination_low >>> 16;
        let word3 = source >>> 16;

        let low = word0 | word1 << 16;
        let high = word2 | word3 << 16;

        cpu.write_mmx64s(low, high);
    }
};

t[0x62] = cpu => {
    // punpckldq mm, mm/m32
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem32s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];

    let low = destination_low;
    let high = source;

    cpu.write_mmx64s(low, high);
};

t[0x63] = cpu => {
    // packsswb mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let low = 0;
    low |= (cpu.saturate_sw_to_sb((destination_low) & 0xFFFF));
    low |= (cpu.saturate_sw_to_sb(destination_low >>> 16)) << 8;
    low |= (cpu.saturate_sw_to_sb((destination_high) & 0xFFFF)) << 16;
    low |= (cpu.saturate_sw_to_sb(destination_high >>> 16)) << 24;

    let high = 0;
    high |= (cpu.saturate_sw_to_sb((source[0]) & 0xFFFF));
    high |= (cpu.saturate_sw_to_sb(source[0] >>> 16)) << 8;
    high |= (cpu.saturate_sw_to_sb((source[1]) & 0xFFFF)) << 16;
    high |= (cpu.saturate_sw_to_sb(source[1] >>> 16)) << 24;

    cpu.write_mmx64s(low, high);
};

t[0x64] = cpu => {
    // pcmpgtb mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source64s = cpu.read_mmx_mem64s();
    let source8s = new Int8Array(source64s.buffer);

    let reg_offset = 8 * (cpu.modrm_byte >> 3 & 7);
    let destination8s = cpu.reg_mmx8s;

    let byte0 = destination8s[reg_offset] > source8s[0] ? 0xFF : 0;
    let byte1 = destination8s[reg_offset + 1] > source8s[1] ? 0xFF : 0;
    let byte2 = destination8s[reg_offset + 2] > source8s[2] ? 0xFF : 0;
    let byte3 = destination8s[reg_offset + 3] > source8s[3] ? 0xFF : 0;
    let byte4 = destination8s[reg_offset + 4] > source8s[4] ? 0xFF : 0;
    let byte5 = destination8s[reg_offset + 5] > source8s[5] ? 0xFF : 0;
    let byte6 = destination8s[reg_offset + 6] > source8s[6] ? 0xFF : 0;
    let byte7 = destination8s[reg_offset + 7] > source8s[7] ? 0xFF : 0;

    let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
    let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

    cpu.write_mmx64s(low, high);
};

t[0x65] = cpu => {
    // pcmpgtw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let word0 = (destination_low << 16 >> 16) > (source[0] << 16 >> 16) ? 0xFFFF : 0;
    let word1 = (destination_low >> 16) > (source[0] >> 16) ? 0xFFFF : 0;
    let word2 = (destination_high << 16 >> 16) > (source[1] << 16 >> 16) ? 0xFFFF : 0;
    let word3 = (destination_high >> 16) > (source[1] >> 16) ? 0xFFFF : 0;

    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;

    cpu.write_mmx64s(low, high);
};

t[0x66] = cpu => {
    // pcmpgtd mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let low = destination_low > source[0] ? -1 : 0;
    let high = destination_high > source[1] ? -1 : 0;

    cpu.write_mmx64s(low, high);
};

t[0x67] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        let source = cpu.read_xmm_mem128s();
        let source16s = new Int16Array(source.buffer);

        let destination = cpu.read_xmm128s();
        let destination16s = new Int16Array(destination.buffer);

        let result = cpu.create_atom128s(0, 0, 0, 0);
        let result8 = new Uint8Array(result.buffer);

        for(let i = 0; i < 8; i++)
        {
            result8[i] = cpu.saturate_sw_to_ub(destination16s[i]);
            result8[i | 8] = cpu.saturate_sw_to_ub(source16s[i]);
        }

        cpu.write_xmm128s(result[0], result[1], result[2], result[3]);
    }
    else
    {
        // packuswb mm, mm/m64
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);

        let source = cpu.read_mmx_mem64s();
        let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
        let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

        let low = 0;
        low |= (cpu.saturate_sw_to_ub((destination_low) & 0xFFFF));
        low |= (cpu.saturate_sw_to_ub(destination_low >>> 16)) << 8;
        low |= (cpu.saturate_sw_to_ub((destination_high) & 0xFFFF)) << 16;
        low |= (cpu.saturate_sw_to_ub(destination_high >>> 16)) << 24;

        let high = 0;
        high |= (cpu.saturate_sw_to_ub((source[0]) & 0xFFFF));
        high |= (cpu.saturate_sw_to_ub(source[0] >>> 16)) << 8;
        high |= (cpu.saturate_sw_to_ub((source[1]) & 0xFFFF)) << 16;
        high |= (cpu.saturate_sw_to_ub(source[1] >>> 16)) << 24;

        cpu.write_mmx64s(low, high);
    }
};

t[0x68] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // punpckhbw xmm, xmm/m128
        let source = cpu.read_xmm_mem128s();
        let source8 = new Uint8Array(source.buffer);

        let destination = cpu.read_xmm128s();
        let destination8 = new Uint8Array(destination.buffer);

        cpu.write_xmm128s(
            destination8[ 8] | source8[ 8] << 8 | destination8[ 9] << 16 | source8[ 9] << 24,
            destination8[10] | source8[10] << 8 | destination8[11] << 16 | source8[11] << 24,
            destination8[12] | source8[12] << 8 | destination8[13] << 16 | source8[13] << 24,
            destination8[14] | source8[14] << 8 | destination8[15] << 16 | source8[15] << 24
        );
    }
    else
    {
        // punpckhbw mm, mm/m64
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);

        let source = cpu.read_mmx_mem64s();
        let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

        let byte0 = destination_high & 0xFF;
        let byte1 = source[1] & 0xFF;
        let byte2 = (destination_high >> 8) & 0xFF;
        let byte3 = (source[1] >> 8) & 0xFF;
        let byte4 = (destination_high >> 16) & 0xFF;
        let byte5 = (source[1] >> 16) & 0xFF;
        let byte6 = destination_high >>> 24;
        let byte7 = source[1] >>> 24;

        let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
        let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

        cpu.write_mmx64s(low, high);
    }
};

t[0x69] = cpu => {
    // punpckhwd mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let word0 = destination_high & 0xFFFF;
    let word1 = source[1] & 0xFFFF;
    let word2 = destination_high >>> 16;
    let word3 = source[1] >>> 16;

    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;

    cpu.write_mmx64s(low, high);
};

t[0x6A] = cpu => {
    // punpckhdq mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let low = destination_high;
    let high = source[1];

    cpu.write_mmx64s(low, high);
};

t[0x6B] = cpu => {
    // packssdw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let low = 0;
    low |= cpu.saturate_sd_to_sw(destination_low);
    low |= cpu.saturate_sd_to_sw(destination_high) << 16;

    let high = 0;
    high |= cpu.saturate_sd_to_sw(source[0]);
    high |= cpu.saturate_sd_to_sw(source[1]) << 16;

    cpu.write_mmx64s(low, high);
};

t[0x6C] = cpu => { cpu.unimplemented_sse(); };
t[0x6D] = cpu => { cpu.unimplemented_sse(); };
t[0x6E] = cpu => {
    // movd mm, r/m32
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_66)
    {
        let data = cpu.read_e32s();
        cpu.write_xmm128s(data, 0, 0, 0);
    }
    else
    {
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
        let data = cpu.read_e32s();
        cpu.write_mmx64s(data, 0);
    }
};
t[0x6F] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // movdqa xmm, xmm/mem128
        let data = cpu.read_xmm_mem128s();
        cpu.write_xmm128s(data[0], data[1], data[2], data[3]);
    }
    else if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_F3)
    {
        // movdqu xmm, xmm/m128
        let data = cpu.read_xmm_mem128s_unaligned();
        cpu.write_xmm128s(data[0], data[1], data[2], data[3]);
    }
    else
    {
        // movq mm, mm/m64
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
        let data = cpu.read_mmx_mem64s();
        cpu.write_mmx64s(data[0], data[1]);
    }
};

t[0x70] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_66)
    {
        // pshufd xmm, xmm/mem128
        let source = cpu.read_xmm_mem128s();
        let order = cpu.read_op8();

        cpu.write_xmm128s(
            source[order & 3],
            source[order >> 2 & 3],
            source[order >> 4 & 3],
            source[order >> 6 & 3]
        );
    }
    else if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_F2)
    {
        // pshuflw xmm, xmm/m128, imm8
        let source = cpu.read_xmm_mem128s();
        let source16 = new Uint16Array(source.buffer);
        let order = cpu.read_op8();

        cpu.write_xmm128s(
            source16[order & 3] | source16[order >> 2 & 3] << 16,
            source16[order >> 4 & 3] | source16[order >> 6 & 3] << 16,
            source[2],
            source[3]
        );
    }
    else if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_F3)
    {
        // pshufhw xmm, xmm/m128, imm8
        let source = cpu.read_xmm_mem128s();
        let source16 = new Uint16Array(source.buffer);
        let order = cpu.read_op8();

        cpu.write_xmm128s(
            source[0],
            source[1],
            source16[order & 3 | 4] | source16[order >> 2 & 3 | 4] << 16,
            source16[order >> 4 & 3 | 4] | source16[order >> 6 & 3 | 4] << 16
        );
    }
    else
    {
        // pshufw mm1, mm2/m64, imm8
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
        let source = cpu.read_mmx_mem64s();
        let order = cpu.read_op8();

        let word0_shift = order & 0b11;
        let word0 = source[word0_shift >> 1] >>> ((word0_shift & 1) * 16) & 0xFFFF;
        let word1_shift = (order >> 2) & 0b11;
        let word1 = source[word1_shift >> 1] >>> ((word1_shift & 1) * 16);
        let low = word0 | word1 << 16;

        let word2_shift = (order >> 4) & 0b11;
        let word2 = source[word2_shift >> 1] >>> ((word2_shift & 1) * 16) & 0xFFFF;
        let word3_shift = (order >>> 6);
        let word3 = source[word3_shift >> 1] >>> ((word3_shift & 1) * 16);
        let high = word2 | word3 << 16;

        cpu.write_mmx64s(low, high);
    }
};
t[0x71] = cpu => {
    cpu.read_modrm_byte();
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();

    if(cpu.modrm_byte < 0xC0)
    {
        cpu.trigger_ud();
    }

    // psrlw, psraw, psllw
    //     2,     4,     6
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 2:
            // psrlw mm, imm8
            var source = cpu.read_op8();
            var destination = cpu.modrm_byte & 7;

            var destination_low = cpu.reg_mmxs[2 * destination];
            var destination_high = cpu.reg_mmxs[2 * destination + 1];

            var shift = source;
            var low = 0;
            var high = 0;

            if (shift <= 15) {
                var word0 = (destination_low & 0xFFFF) >>> shift;
                var word1 = (destination_low >>> 16) >>> shift;
                low = word0 | word1 << 16;

                var word2 = (destination_high & 0xFFFF) >>> shift;
                var word3 = (destination_high >>> 16) >>> shift;
                high = word2 | word3 << 16;
            }

            cpu.reg_mmxs[2 * destination] = low;
            cpu.reg_mmxs[2 * destination + 1] = high;

            break;
        case 4:
            // psraw mm, imm8
            var source = cpu.read_op8();
            var destination = cpu.modrm_byte & 7;

            var destination_low = cpu.reg_mmxs[2 * destination];
            var destination_high = cpu.reg_mmxs[2 * destination + 1];

            var shift = source;
            if (shift > 15) {
                shift = 16;
            }

            var word0 = ((destination_low << 16 >> 16) >> shift) & 0xFFFF;
            var word1 = ((destination_low >> 16) >> shift) & 0xFFFF;
            var low = word0 | word1 << 16;

            var word2 = ((destination_high << 16 >> 16) >> shift) & 0xFFFF;
            var word3 = ((destination_high >> 16) >> shift) & 0xFFFF;
            var high = word2 | word3 << 16;

            cpu.reg_mmxs[2 * destination] = low;
            cpu.reg_mmxs[2 * destination + 1] = high;

            break;
        case 6:
            // psllw mm, imm8
            var source = cpu.read_op8();
            var destination = cpu.modrm_byte & 7;

            var destination_low = cpu.reg_mmxs[2 * destination];
            var destination_high = cpu.reg_mmxs[2 * destination + 1];

            var shift = source;
            var low = 0;
            var high = 0;

            if (shift <= 15) {
                var word0 = ((destination_low & 0xFFFF) << shift) & 0xFFFF;
                var word1 = (destination_low >>> 16) << shift;
                low = word0 | word1 << 16;

                var word2 = ((destination_high & 0xFFFF) << shift) & 0xFFFF;
                var word3 = (destination_high >>> 16) << shift;
                high = word2 | word3 << 16;
            }

            cpu.reg_mmxs[2 * destination] = low;
            cpu.reg_mmxs[2 * destination + 1] = high;

            break;
        default:
            cpu.unimplemented_sse();
            break;
    }
};

t[0x72] = cpu => {
    cpu.read_modrm_byte();
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();

    if(cpu.modrm_byte < 0xC0)
    {
        cpu.trigger_ud();
    }

    // psrld, psrad, pslld
    //     2,     4,     6
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 2:
            // psrld mm, imm8
            var source = cpu.read_op8();
            var destination = cpu.modrm_byte & 7;

            var destination_low = cpu.reg_mmxs[2 * destination];
            var destination_high = cpu.reg_mmxs[2 * destination + 1];

            var shift = source;
            var low = 0;
            var high = 0;

            if (shift <= 31) {
                low = destination_low >>> shift;
                high = destination_high >>> shift;
            }

            cpu.reg_mmxs[2 * destination] = low;
            cpu.reg_mmxs[2 * destination + 1] = high;

            break;
        case 4:
            // psrad mm, imm8
            var source = cpu.read_op8();
            var destination = cpu.modrm_byte & 7;

            var destination_low = cpu.reg_mmxs[2 * destination];
            var destination_high = cpu.reg_mmxs[2 * destination + 1];

            var shift = source;
            if (shift > 31) {
                shift = 31;
            }

            var low = destination_low >> shift;
            var high = destination_high >> shift;

            cpu.reg_mmxs[2 * destination] = low;
            cpu.reg_mmxs[2 * destination + 1] = high;

            break;
        case 6:
            // pslld mm, imm8
            var source = cpu.read_op8();
            var destination = cpu.modrm_byte & 7;

            var destination_low = cpu.reg_mmxs[2 * destination];
            var destination_high = cpu.reg_mmxs[2 * destination + 1];

            var shift = source;
            var low = 0;
            var high = 0;

            if (shift <= 31) {
                low = destination_low << shift;
                high = destination_high << shift;
            }

            cpu.reg_mmxs[2 * destination] = low;
            cpu.reg_mmxs[2 * destination + 1] = high;

            break;
        default:
            cpu.unimplemented_sse();
            break;
    }
};

t[0x73] = cpu => {
    cpu.read_modrm_byte();
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();

    if(cpu.modrm_byte < 0xC0)
    {
        cpu.trigger_ud();
    }

    // psrlq, psllq
    //     2,     6
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 2:
            // psrlq mm, imm8
            var source = cpu.read_op8();
            var destination = cpu.modrm_byte & 7;

            var destination_low = cpu.reg_mmxs[2 * destination];
            var destination_high = cpu.reg_mmxs[2 * destination + 1];

            var shift = source;
            var low = 0;
            var high = 0;

            if (shift <= 31) {
                low = destination_low >>> shift | (destination_high << (32 - shift));
                high = destination_high >>> shift;
            }
            else if (shift <= 63) {
                low = destination_high >>> (shift & 0x1F);
                high = 0;
            }

            cpu.reg_mmxs[2 * destination] = low;
            cpu.reg_mmxs[2 * destination + 1] = high;

            break;
        case 6:
            // psllq mm, imm8
            var source = cpu.read_op8();
            var destination = cpu.modrm_byte & 7;

            var destination_low = cpu.reg_mmxs[2 * destination];
            var destination_high = cpu.reg_mmxs[2 * destination + 1];

            var shift = source;
            var low = 0;
            var high = 0;

            if (shift <= 31) {
                low = destination_low << shift;
                high = destination_high << shift | (destination_low >>> (32 - shift));
            }
            else if (shift <= 63) {
                high = destination_low << (shift & 0x1F);
                low = 0;
            }

            cpu.reg_mmxs[2 * destination] = low;
            cpu.reg_mmxs[2 * destination + 1] = high;

            break;
        default:
            cpu.unimplemented_sse();
            break;
    }
};

t[0x74] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // pcmpeqb xmm, xmm/m128
        let source64s = cpu.read_xmm_mem128s();
        let source8 = new Uint8Array(source64s.buffer);

        let destination128 = cpu.read_xmm128s();
        let destination8 = new Uint8Array(destination128.buffer);

        let result = cpu.create_atom128s(0, 0, 0, 0);
        let result8 = new Uint8Array(result.buffer);

        for(let i = 0; i < 16; i++)
        {
            result8[i] = source8[i] === destination8[i] ? 0xFF : 0;
        }

        cpu.write_xmm128s(result[0], result[1], result[2], result[3])
    }
    else
    {
        // pcmpeqb mm, mm/m64
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
        let source64s = cpu.read_mmx_mem64s();
        let source8s = new Int8Array(source64s.buffer);

        let reg_offset = 8 * (cpu.modrm_byte >> 3 & 7);
        let destination8s = cpu.reg_mmx8s;

        let byte0 = destination8s[reg_offset] === source8s[0] ? 0xFF : 0;
        let byte1 = destination8s[reg_offset + 1] === source8s[1] ? 0xFF : 0;
        let byte2 = destination8s[reg_offset + 2] === source8s[2] ? 0xFF : 0;
        let byte3 = destination8s[reg_offset + 3] === source8s[3] ? 0xFF : 0;
        let byte4 = destination8s[reg_offset + 4] === source8s[4] ? 0xFF : 0;
        let byte5 = destination8s[reg_offset + 5] === source8s[5] ? 0xFF : 0;
        let byte6 = destination8s[reg_offset + 6] === source8s[6] ? 0xFF : 0;
        let byte7 = destination8s[reg_offset + 7] === source8s[7] ? 0xFF : 0;

        let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
        let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

        cpu.write_mmx64s(low, high);
    }
};

t[0x75] = cpu => {
    // pcmpeqw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let word0 = (destination_low & 0xFFFF) === (source[0] & 0xFFFF) ? 0xFFFF : 0;
    let word1 = (destination_low & 0xFFFF0000) === (source[0] & 0xFFFF0000) ? 0xFFFF : 0;
    let word2 = (destination_high & 0xFFFF) === (source[1] & 0xFFFF) ? 0xFFFF : 0;
    let word3 = (destination_high & 0xFFFF0000) === (source[1] & 0xFFFF0000) ? 0xFFFF : 0;

    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;

    cpu.write_mmx64s(low, high);
};

t[0x76] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // pcmpeqd xmm, xmm/m128
        let source = cpu.read_xmm_mem128s();
        let destination = cpu.read_xmm128s();

        cpu.write_xmm128s(
            source[0] === destination[0] ? -1 : 0,
            source[1] === destination[1] ? -1 : 0,
            source[2] === destination[2] ? -1 : 0,
            source[3] === destination[3] ? -1 : 0
        );
    }
    else
    {
        // pcmpeqd mm, mm/m64
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);

        let source = cpu.read_mmx_mem64s();
        let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
        let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

        let low = destination_low === source[0] ? -1 : 0;
        let high = destination_high === source[1] ? -1 : 0;

        cpu.write_mmx64s(low, high);
    }
};

t[0x77] = cpu => {
    // emms
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.fpu.stack_empty = 0xFF;
};

t[0x78] = cpu => { cpu.unimplemented_sse(); };
t[0x79] = cpu => { cpu.unimplemented_sse(); };
t[0x7A] = cpu => { cpu.unimplemented_sse(); };
t[0x7B] = cpu => { cpu.unimplemented_sse(); };
t[0x7C] = cpu => { cpu.unimplemented_sse(); };
t[0x7D] = cpu => { cpu.unimplemented_sse(); };
t[0x7E] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_F3)
    {
        // movq xmm, xmm/mem64
        let data = cpu.read_xmm_mem64s();
        cpu.write_xmm128s(data[0], data[1], 0, 0);
    }
    else if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // movd r/m32, xmm
        let data = cpu.read_xmm64s();
        cpu.set_e32(data[0]);
    }
    else
    {
        // movd r/m32, mm
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
        let data = cpu.read_mmx64s();
        cpu.set_e32(data[0]);
    }
};
t[0x7F] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_F3)
    {
        // movdqu xmm/m128, xmm
        let data = cpu.read_xmm128s();
        dbg_assert(cpu.modrm_byte < 0xC0);
        let addr = cpu.modrm_resolve(cpu.modrm_byte);
        cpu.safe_write128(addr, data[0], data[1], data[2], data[3]);
    }
    else if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // movdqa xmm/m128, xmm
        let data = cpu.read_xmm128s();
        dbg_assert(cpu.modrm_byte < 0xC0);
        let addr = cpu.modrm_resolve(cpu.modrm_byte);
        cpu.safe_write128(addr, data[0], data[1], data[2], data[3]);
    }
    else
    {
        // movq mm/m64, mm
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);

        let data = cpu.read_mmx64s();
        cpu.set_mmx_mem64s(data[0], data[1]);
    }
};

// jmpcc
t16[0x80] = cpu => { cpu.jmpcc16( cpu.test_o()); };
t32[0x80] = cpu => { cpu.jmpcc32( cpu.test_o()); };
t16[0x81] = cpu => { cpu.jmpcc16(!cpu.test_o()); };
t32[0x81] = cpu => { cpu.jmpcc32(!cpu.test_o()); };
t16[0x82] = cpu => { cpu.jmpcc16( cpu.test_b()); };
t32[0x82] = cpu => { cpu.jmpcc32( cpu.test_b()); };
t16[0x83] = cpu => { cpu.jmpcc16(!cpu.test_b()); };
t32[0x83] = cpu => { cpu.jmpcc32(!cpu.test_b()); };
t16[0x84] = cpu => { cpu.jmpcc16( cpu.test_z()); };
t32[0x84] = cpu => { cpu.jmpcc32( cpu.test_z()); };
t16[0x85] = cpu => { cpu.jmpcc16(!cpu.test_z()); };
t32[0x85] = cpu => { cpu.jmpcc32(!cpu.test_z()); };
t16[0x86] = cpu => { cpu.jmpcc16( cpu.test_be()); };
t32[0x86] = cpu => { cpu.jmpcc32( cpu.test_be()); };
t16[0x87] = cpu => { cpu.jmpcc16(!cpu.test_be()); };
t32[0x87] = cpu => { cpu.jmpcc32(!cpu.test_be()); };
t16[0x88] = cpu => { cpu.jmpcc16( cpu.test_s()); };
t32[0x88] = cpu => { cpu.jmpcc32( cpu.test_s()); };
t16[0x89] = cpu => { cpu.jmpcc16(!cpu.test_s()); };
t32[0x89] = cpu => { cpu.jmpcc32(!cpu.test_s()); };
t16[0x8A] = cpu => { cpu.jmpcc16( cpu.test_p()); };
t32[0x8A] = cpu => { cpu.jmpcc32( cpu.test_p()); };
t16[0x8B] = cpu => { cpu.jmpcc16(!cpu.test_p()); };
t32[0x8B] = cpu => { cpu.jmpcc32(!cpu.test_p()); };
t16[0x8C] = cpu => { cpu.jmpcc16( cpu.test_l()); };
t32[0x8C] = cpu => { cpu.jmpcc32( cpu.test_l()); };
t16[0x8D] = cpu => { cpu.jmpcc16(!cpu.test_l()); };
t32[0x8D] = cpu => { cpu.jmpcc32(!cpu.test_l()); };
t16[0x8E] = cpu => { cpu.jmpcc16( cpu.test_le()); };
t32[0x8E] = cpu => { cpu.jmpcc32( cpu.test_le()); };
t16[0x8F] = cpu => { cpu.jmpcc16(!cpu.test_le()); };
t32[0x8F] = cpu => { cpu.jmpcc32(!cpu.test_le()); };

// setcc
t[0x90] = cpu => { cpu.read_modrm_byte(); cpu.setcc( cpu.test_o()); };
t[0x91] = cpu => { cpu.read_modrm_byte(); cpu.setcc(!cpu.test_o()); };
t[0x92] = cpu => { cpu.read_modrm_byte(); cpu.setcc( cpu.test_b()); };
t[0x93] = cpu => { cpu.read_modrm_byte(); cpu.setcc(!cpu.test_b()); };
t[0x94] = cpu => { cpu.read_modrm_byte(); cpu.setcc( cpu.test_z()); };
t[0x95] = cpu => { cpu.read_modrm_byte(); cpu.setcc(!cpu.test_z()); };
t[0x96] = cpu => { cpu.read_modrm_byte(); cpu.setcc( cpu.test_be()); };
t[0x97] = cpu => { cpu.read_modrm_byte(); cpu.setcc(!cpu.test_be()); };
t[0x98] = cpu => { cpu.read_modrm_byte(); cpu.setcc( cpu.test_s()); };
t[0x99] = cpu => { cpu.read_modrm_byte(); cpu.setcc(!cpu.test_s()); };
t[0x9A] = cpu => { cpu.read_modrm_byte(); cpu.setcc( cpu.test_p()); };
t[0x9B] = cpu => { cpu.read_modrm_byte(); cpu.setcc(!cpu.test_p()); };
t[0x9C] = cpu => { cpu.read_modrm_byte(); cpu.setcc( cpu.test_l()); };
t[0x9D] = cpu => { cpu.read_modrm_byte(); cpu.setcc(!cpu.test_l()); };
t[0x9E] = cpu => { cpu.read_modrm_byte(); cpu.setcc( cpu.test_le()); };
t[0x9F] = cpu => { cpu.read_modrm_byte(); cpu.setcc(!cpu.test_le()); };

t16[0xA0] = cpu => { cpu.push16(cpu.sreg[reg_fs]); };
t32[0xA0] = cpu => { cpu.push32(cpu.sreg[reg_fs]); };
t16[0xA1] = cpu => {
    cpu.switch_seg(reg_fs, cpu.safe_read16(cpu.get_stack_pointer(0)));
    cpu.adjust_stack_reg(2);
};
t32[0xA1] = cpu => {
    cpu.switch_seg(reg_fs, cpu.safe_read32s(cpu.get_stack_pointer(0)) & 0xFFFF);
    cpu.adjust_stack_reg(4);
};

t[0xA2] = cpu => { cpu.cpuid(); };

t16[0xA3] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0)
    {
        cpu.bt_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_g16s());
    }
    else
    {
        cpu.bt_reg(cpu.read_reg_e16(), cpu.read_g16() & 15);
    }
};
t32[0xA3] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0)
    {
        cpu.bt_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_g32s());
    }
    else
    {
        cpu.bt_reg(cpu.read_reg_e32s(), cpu.read_g32s() & 31);
    }
};

t16[0xA4] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e16(); cpu.write_e16(cpu.shld16(data, cpu.read_g16(), cpu.read_op8() & 31));
};
t32[0xA4] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e32(); cpu.write_e32(cpu.shld32(data, cpu.read_g32s(), cpu.read_op8() & 31));
};
t16[0xA5] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e16(); cpu.write_e16(cpu.shld16(data, cpu.read_g16(), cpu.reg8[reg_cl] & 31));
};
t32[0xA5] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e32(); cpu.write_e32(cpu.shld32(data, cpu.read_g32s(), cpu.reg8[reg_cl] & 31));
};

t[0xA6] = cpu => {
    // obsolete cmpxchg (os/2)
    cpu.trigger_ud();
};
t[0xA7] = cpu => { cpu.undefined_instruction(); };

t16[0xA8] = cpu => { cpu.push16(cpu.sreg[reg_gs]); };
t32[0xA8] = cpu => { cpu.push32(cpu.sreg[reg_gs]); };
t16[0xA9] = cpu => {
    cpu.switch_seg(reg_gs, cpu.safe_read16(cpu.get_stack_pointer(0)));
    cpu.adjust_stack_reg(2);
};
t32[0xA9] = cpu => {
    cpu.switch_seg(reg_gs, cpu.safe_read32s(cpu.get_stack_pointer(0)) & 0xFFFF);
    cpu.adjust_stack_reg(4);
};


t[0xAA] = cpu => {
    // rsm
    cpu.todo();
};

t16[0xAB] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0) {
        cpu.bts_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_g16s());
    } else {
        cpu.write_reg_e16(cpu.bts_reg(cpu.read_reg_e16(), cpu.read_g16s() & 15));
    }
};
t32[0xAB] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0) {
        cpu.bts_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_g32s());
    } else {
        cpu.write_reg_e32(cpu.bts_reg(cpu.read_reg_e32s(), cpu.read_g32s() & 31));
    }
};


t16[0xAC] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e16(); cpu.write_e16(cpu.shrd16(data, cpu.read_g16(), cpu.read_op8() & 31));
};
t32[0xAC] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e32(); cpu.write_e32(cpu.shrd32(data, cpu.read_g32s(), cpu.read_op8() & 31));
};
t16[0xAD] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e16(); cpu.write_e16(cpu.shrd16(data, cpu.read_g16(), cpu.reg8[reg_cl] & 31));
};
t32[0xAD] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e32(); cpu.write_e32(cpu.shrd32(data, cpu.read_g32s(), cpu.reg8[reg_cl] & 31));
};

t[0xAE] = cpu => { cpu.read_modrm_byte();
    // xsave, xrstor, ...
    if(cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) cpu.todo();

    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 0: // fxsave
            if(cpu.modrm_byte >= 0xC0) cpu.trigger_ud();
            var addr = cpu.modrm_resolve(cpu.modrm_byte);
            cpu.fxsave(addr);
            break;

        case 1: // fxrstor
            if(cpu.modrm_byte >= 0xC0) cpu.trigger_ud();
            var addr = cpu.modrm_resolve(cpu.modrm_byte);
            cpu.fxrstor(addr);
            break;

        case 2: // ldmxcsr
            if(cpu.modrm_byte >= 0xC0) cpu.trigger_ud();
            var addr = cpu.modrm_resolve(cpu.modrm_byte);
            let new_mxcsr = cpu.safe_read32s(addr);
            if(new_mxcsr & ~MXCSR_MASK)
            {
                dbg_log("Invalid mxcsr bits: " + h((new_mxcsr & ~MXCSR_MASK) >>> 0, 8));
                cpu.trigger_gp(0);
            }
            cpu.mxcsr = new_mxcsr;
            break;

        case 3: // stmxcsr
            if(cpu.modrm_byte >= 0xC0) cpu.trigger_ud();
            var addr = cpu.modrm_resolve(cpu.modrm_byte);
            cpu.safe_write32(addr, cpu.mxcsr);
            break;

        case 5:
            // lfence
            dbg_assert(cpu.modrm_byte >= 0xC0, "Unexpected lfence encoding");
            if(cpu.modrm_byte < 0xC0) cpu.trigger_ud();
            break;
        case 6:
            // mfence
            dbg_assert(cpu.modrm_byte >= 0xC0, "Unexpected mfence encoding");
            if(cpu.modrm_byte < 0xC0) cpu.trigger_ud();
            break;
        case 7:
            // sfence or clflush
            dbg_assert(cpu.modrm_byte >= 0xC0, "Unexpected sfence encoding");
            if(cpu.modrm_byte < 0xC0) cpu.trigger_ud();
            break;
        default:
            dbg_log("missing " + (cpu.modrm_byte >> 3 & 7), LOG_CPU);
            cpu.todo();
    }
};

t16[0xAF] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e16s();
    cpu.write_g16(cpu.imul_reg16(cpu.read_g16s(), data));
};
t32[0xAF] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e32s();
    cpu.write_g32(cpu.imul_reg32(cpu.read_g32s(), data));
};

t[0xB0] = cpu => { cpu.read_modrm_byte();
    // cmpxchg8
    if(cpu.modrm_byte < 0xC0)
    {
        var virt_addr = cpu.modrm_resolve(cpu.modrm_byte);
        cpu.writable_or_pagefault(virt_addr, 1);

        var data = cpu.safe_read8(virt_addr);
    }
    else
        data = cpu.reg8[cpu.modrm_byte << 2 & 0xC | cpu.modrm_byte >> 2 & 1];


    cpu.cmp8(cpu.reg8[reg_al], data);

    if(cpu.getzf())
    {
        if(cpu.modrm_byte < 0xC0)
            cpu.safe_write8(virt_addr, cpu.read_g8());
        else
            cpu.reg8[cpu.modrm_byte << 2 & 0xC | cpu.modrm_byte >> 2 & 1] = cpu.read_g8();
    }
    else
    {
        if(cpu.modrm_byte < 0xC0)
            cpu.safe_write8(virt_addr, data);

        cpu.reg8[reg_al] = data;
    }
};
t16[0xB1] = cpu => { cpu.read_modrm_byte();
    // cmpxchg16/32
    if(cpu.modrm_byte < 0xC0)
    {
        var virt_addr = cpu.modrm_resolve(cpu.modrm_byte);
        cpu.writable_or_pagefault(virt_addr, 2);

        var data = cpu.safe_read16(virt_addr);
    }
    else
        data = cpu.read_reg_e16();

    cpu.cmp16(cpu.reg16[reg_ax], data);

    if(cpu.getzf())
    {
        if(cpu.modrm_byte < 0xC0)
            cpu.safe_write16(virt_addr, cpu.read_g16());
        else
            cpu.write_reg_e16(cpu.read_g16());
    }
    else
    {
        if(cpu.modrm_byte < 0xC0)
            cpu.safe_write16(virt_addr, data);

        cpu.reg16[reg_ax] = data;
    }
};
t32[0xB1] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0)
    {
        var virt_addr = cpu.modrm_resolve(cpu.modrm_byte);
        cpu.writable_or_pagefault(virt_addr, 4);

        var data = cpu.safe_read32s(virt_addr);
    }
    else
    {
        data = cpu.read_reg_e32s();
    }

    cpu.cmp32(cpu.reg32s[reg_eax], data);

    if(cpu.getzf())
    {
        if(cpu.modrm_byte < 0xC0)
            cpu.safe_write32(virt_addr, cpu.read_g32s());
        else
            cpu.write_reg_e32(cpu.read_g32s());
    }
    else
    {
        if(cpu.modrm_byte < 0xC0)
            cpu.safe_write32(virt_addr, data);

        cpu.reg32s[reg_eax] = data;
    }
};

// lss
t16[0xB2] = cpu => { cpu.read_modrm_byte();
    cpu.lss16(reg_ss);
};
t32[0xB2] = cpu => { cpu.read_modrm_byte();
    cpu.lss32(reg_ss);
};

t16[0xB3] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0) {
        cpu.btr_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_g16s());
    } else {
        cpu.write_reg_e16(cpu.btr_reg(cpu.read_reg_e16(), cpu.read_g16s() & 15));
    }
};
t32[0xB3] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0) {
        cpu.btr_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_g32s());
    } else {
        cpu.write_reg_e32(cpu.btr_reg(cpu.read_reg_e32s(), cpu.read_g32s() & 31));
    }
};

// lfs, lgs
t16[0xB4] = cpu => { cpu.read_modrm_byte();
    cpu.lss16(reg_fs);
};
t32[0xB4] = cpu => { cpu.read_modrm_byte();
    cpu.lss32(reg_fs);
};
t16[0xB5] = cpu => { cpu.read_modrm_byte();
    cpu.lss16(reg_gs);
};
t32[0xB5] = cpu => { cpu.read_modrm_byte();
    cpu.lss32(reg_gs);
};

t16[0xB6] = cpu => { cpu.read_modrm_byte();
    // movzx
    var data = cpu.read_e8();
    cpu.write_g16(data);
};
t32[0xB6] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e8();
    cpu.write_g32(data);
};

t16[0xB7] = cpu => { cpu.read_modrm_byte();
    // movzx
    dbg_assert(false, "Possibly invalid encoding");
    var data = cpu.read_e16();
    cpu.write_g16(data);
};
t32[0xB7] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e16();
    cpu.write_g32(data);
};

t16[0xB8] = cpu => { cpu.read_modrm_byte();
    // popcnt
    if((cpu.prefixes & PREFIX_F3) === 0)
    {
        cpu.trigger_ud();
    }
    var data = cpu.read_e16();
    cpu.write_g16(cpu.popcnt(data));
};
t32[0xB8] = cpu => { cpu.read_modrm_byte();
    if((cpu.prefixes & PREFIX_F3) === 0)
    {
        cpu.trigger_ud();
    }
    var data = cpu.read_e32s();
    cpu.write_g32(cpu.popcnt(data));
};

t[0xB9] = cpu => {
    // UD
    cpu.todo();
};

t16[0xBA] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 4:
            if(cpu.modrm_byte < 0xC0)
            {
                cpu.bt_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_op8() & 15);
            }
            else
            {
                cpu.bt_reg(cpu.read_reg_e16(), cpu.read_op8() & 15);
            }
            break;
        case 5:
            if(cpu.modrm_byte < 0xC0) {
                cpu.bts_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_op8() & 15);
            } else {
                cpu.write_reg_e16(cpu.bts_reg(cpu.read_reg_e16(), cpu.read_op8() & 15));
            }
            break;
        case 6:
            if(cpu.modrm_byte < 0xC0) {
                cpu.btr_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_op8() & 15);
            } else {
                cpu.write_reg_e16(cpu.btr_reg(cpu.read_reg_e16(), cpu.read_op8() & 15));
            }
            break;
        case 7:
            if(cpu.modrm_byte < 0xC0) {
                cpu.btc_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_op8() & 15);
            } else {
                cpu.write_reg_e16(cpu.btc_reg(cpu.read_reg_e16(), cpu.read_op8() & 15));
            }
            break;
        default:
            dbg_log(cpu.modrm_byte >> 3 & 7);
            cpu.todo();
    }
};
t32[0xBA] = cpu => { cpu.read_modrm_byte();
    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 4:
            if(cpu.modrm_byte < 0xC0)
            {
                cpu.bt_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_op8() & 31);
            }
            else
            {
                cpu.bt_reg(cpu.read_reg_e32s(), cpu.read_op8() & 31);
            }
            break;
        case 5:
            if(cpu.modrm_byte < 0xC0) {
                cpu.bts_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_op8() & 31);
            } else {
                cpu.write_reg_e32(cpu.bts_reg(cpu.read_reg_e32s(), cpu.read_op8() & 31));
            }
            break;
        case 6:
            if(cpu.modrm_byte < 0xC0) {
                cpu.btr_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_op8() & 31);
            } else {
                cpu.write_reg_e32(cpu.btr_reg(cpu.read_reg_e32s(), cpu.read_op8() & 31));
            }
            break;
        case 7:
            if(cpu.modrm_byte < 0xC0) {
                cpu.btc_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_op8() & 31);
            } else {
                cpu.write_reg_e32(cpu.btc_reg(cpu.read_reg_e32s(), cpu.read_op8() & 31));
            }
            break;
        default:
            dbg_log(cpu.modrm_byte >> 3 & 7);
            cpu.todo();
    }
};

t16[0xBB] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0) {
        cpu.btc_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_g16s());
    } else {
        cpu.write_reg_e16(cpu.btc_reg(cpu.read_reg_e16(), cpu.read_g16s() & 15));
    }
};
t32[0xBB] = cpu => { cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0) {
        cpu.btc_mem(cpu.modrm_resolve(cpu.modrm_byte), cpu.read_g32s());
    } else {
        cpu.write_reg_e32(cpu.btc_reg(cpu.read_reg_e32s(), cpu.read_g32s() & 31));
    }
};

t16[0xBC] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e16();
    cpu.write_g16(cpu.bsf16(cpu.read_g16(), data));
};
t32[0xBC] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e32s();
    cpu.write_g32(cpu.bsf32(cpu.read_g32s(), data));
};

t16[0xBD] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e16();
    cpu.write_g16(cpu.bsr16(cpu.read_g16(), data));
};
t32[0xBD] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e32s();
    cpu.write_g32(cpu.bsr32(cpu.read_g32s(), data));
};

t16[0xBE] = cpu => { cpu.read_modrm_byte();
    // movsx
    var data = cpu.read_e8s();
    cpu.write_g16(data);
};
t32[0xBE] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e8s();
    cpu.write_g32(data);
};

t16[0xBF] = cpu => { cpu.read_modrm_byte();
    // movsx
    dbg_assert(false, "Possibly invalid encoding");
    var data = cpu.read_e16();
    cpu.write_g16(data);
};

t32[0xBF] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_e16s();
    cpu.write_g32(data);
};

t[0xC0] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e8(); cpu.write_e8(cpu.xadd8(data, cpu.modrm_byte >> 1 & 0xC | cpu.modrm_byte >> 5 & 1));
};

t16[0xC1] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e16();
    cpu.write_e16(cpu.xadd16(data, cpu.modrm_byte >> 2 & 14));
};
t32[0xC1] = cpu => { cpu.read_modrm_byte();
    var data = cpu.read_write_e32();
    cpu.write_e32(cpu.xadd32(data, cpu.modrm_byte >> 3 & 7));
};


t[0xC2] = cpu => { cpu.unimplemented_sse(); };
t[0xC3] = cpu => {
    // movnti
    cpu.read_modrm_byte();
    if(cpu.modrm_byte >= 0xC0) cpu.trigger_ud();
    cpu.set_e32(cpu.read_g32s());
};
t[0xC4] = cpu => { cpu.unimplemented_sse(); };
t[0xC5] = cpu => { cpu.unimplemented_sse(); };
t[0xC6] = cpu => { cpu.unimplemented_sse(); };

t[0xC7] = cpu => {
    cpu.read_modrm_byte();

    switch(cpu.modrm_byte >> 3 & 7)
    {
        case 1:
            // cmpxchg8b
            if(cpu.modrm_byte >= 0xC0)
            {
                cpu.trigger_ud();
            }

            var addr = cpu.modrm_resolve(cpu.modrm_byte);
            cpu.writable_or_pagefault(addr, 8);

            var m64_low = cpu.safe_read32s(addr);
            var m64_high = cpu.safe_read32s(addr + 4 | 0);

            if(cpu.reg32s[reg_eax] === m64_low &&
               cpu.reg32s[reg_edx] === m64_high)
            {
                cpu.flags |= flag_zero;

                cpu.safe_write32(addr, cpu.reg32s[reg_ebx]);
                cpu.safe_write32(addr + 4 | 0, cpu.reg32s[reg_ecx]);
            }
            else
            {
                cpu.flags &= ~flag_zero;

                cpu.reg32s[reg_eax] = m64_low;
                cpu.reg32s[reg_edx] = m64_high;

                cpu.safe_write32(addr, m64_low);
                cpu.safe_write32(addr + 4 | 0, m64_high);
            }

            cpu.flags_changed &= ~flag_zero;
            break;

        case 6:
            var has_rand = v86util.has_rand_int();

            if(has_rand)
            {
                var rand = v86util.get_rand_int();
            }
            else
            {
                var rand = 0;
            }
            //dbg_log("rdrand -> " + h(rand >>> 0, 8), LOG_CPU);

            if(cpu.is_osize_32())
            {
                cpu.set_e32(rand);
            }
            else
            {
                cpu.set_e16(rand);
            }

            cpu.flags &= ~flags_all;
            cpu.flags |= has_rand;
            cpu.flags_changed = 0;
            break;

        default:
            dbg_log(cpu.modrm_byte >> 3 & 7, LOG_CPU);
            cpu.todo();
    }
};

t[0xC8] = cpu => { cpu.bswap(reg_eax); };
t[0xC9] = cpu => { cpu.bswap(reg_ecx); };
t[0xCA] = cpu => { cpu.bswap(reg_edx); };
t[0xCB] = cpu => { cpu.bswap(reg_ebx); };
t[0xCC] = cpu => { cpu.bswap(reg_esp); };
t[0xCD] = cpu => { cpu.bswap(reg_ebp); };
t[0xCE] = cpu => { cpu.bswap(reg_esi); };
t[0xCF] = cpu => { cpu.bswap(reg_edi); };

t[0xD0] = cpu => { cpu.unimplemented_sse(); };

t[0xD1] = cpu => {
    // psrlw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let shift = source[0] >>> 0;
    let low = 0;
    let high = 0;

    if (shift <= 15) {
        let word0 = (destination_low & 0xFFFF) >>> shift;
        let word1 = (destination_low >>> 16) >>> shift;
        low = word0 | word1 << 16;

        let word2 = (destination_high & 0xFFFF) >>> shift;
        let word3 = (destination_high >>> 16) >>> shift;
        high = word2 | word3 << 16;
    }

    cpu.write_mmx64s(low, high);
};

t[0xD2] = cpu => {
    // psrld mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let shift = source[0] >>> 0;
    let low = 0;
    let high = 0;

    if (shift <= 31) {
        low = destination_low >>> shift;
        high = destination_high >>> shift;
    }

    cpu.write_mmx64s(low, high);
};

t[0xD3] = cpu => {
    // psrlq mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let shift = source[0] >>> 0;

    if(shift === 0)
    {
        return;
    }

    let low = 0;
    let high = 0;

    if (shift <= 31) {
        low = destination_low >>> shift | (destination_high << (32 - shift));
        high = destination_high >>> shift;
    }
    else if (shift <= 63) {
        low = destination_high >>> (shift & 0x1F);
        high = 0;
    }

    cpu.write_mmx64s(low, high);
};

t[0xD4] = cpu => { cpu.unimplemented_sse(); };
t[0xD5] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // pmullw xmm, xmm/m128
        let source = cpu.read_xmm_mem128s();
        let source16s = new Int16Array(source.buffer);

        let destination = cpu.read_xmm128s();
        let destination16s = new Int16Array(destination.buffer);

        cpu.write_xmm128s(
            source16s[0] * destination16s[0] & 0xFFFF | source16s[1] * destination16s[1] << 16,
            source16s[2] * destination16s[2] & 0xFFFF | source16s[3] * destination16s[3] << 16,
            source16s[4] * destination16s[4] & 0xFFFF | source16s[5] * destination16s[5] << 16,
            source16s[6] * destination16s[6] & 0xFFFF | source16s[7] * destination16s[7] << 16
        );
    }
    else
    {
        // pmullw mm, mm/m64
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);

        let source = cpu.read_mmx_mem64s();
        let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
        let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

        let word0 = ((destination_low & 0xFFFF) * (source[0] & 0xFFFF)) & 0xFFFF;
        let word1 = ((destination_low >>> 16) * (source[0] >>> 16)) & 0xFFFF;
        let low = word0 | word1 << 16;

        let word2 = ((destination_high & 0xFFFF) * (source[1] & 0xFFFF)) & 0xFFFF;
        let word3 = ((destination_high >>> 16) * (source[1] >>> 16)) & 0xFFFF;
        let high = word2 | word3 << 16;

        cpu.write_mmx64s(low, high);
    }
};
t[0xD6] = cpu => {
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_66);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    // movq xmm/m64, xmm
    var data = cpu.read_xmm64s();
    dbg_assert(cpu.modrm_byte < 0xC0);
    var addr = cpu.modrm_resolve(cpu.modrm_byte);
    cpu.safe_write64(addr, data[0], data[1]);
};
t[0xD7] = cpu => {
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_66);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();
    if(cpu.modrm_byte < 0xC0) cpu.trigger_ud();

    // pmovmskb reg, xmm
    let data = cpu.read_xmm_mem128s();
    let data8 = new Uint8Array(data.buffer);
    let result =
        data8[0] >> 7 << 0 | data8[1] >> 7 << 1 | data8[2] >> 7 << 2 | data8[3] >> 7 << 3 |
        data8[4] >> 7 << 4 | data8[5] >> 7 << 5 | data8[6] >> 7 << 6 | data8[7] >> 7 << 7 |
        data8[8] >> 7 << 8 | data8[9] >> 7 << 9 | data8[10] >> 7 << 10 | data8[11] >> 7 << 11 |
        data8[12] >> 7 << 12 | data8[13] >> 7 << 13 | data8[14] >> 7 << 14 | data8[15] >> 7 << 15;
    cpu.write_g32(result);
};

t[0xD8] = cpu => {
    // psubusb mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source64s = cpu.read_mmx_mem64s();
    let source8 = new Uint8Array(source64s.buffer);

    let reg_offset = 8 * (cpu.modrm_byte >> 3 & 7);
    let destination8 = cpu.reg_mmx8;

    let byte0 = cpu.saturate_sd_to_ub(destination8[reg_offset] - source8[0]);
    let byte1 = cpu.saturate_sd_to_ub(destination8[reg_offset + 1] - source8[1]);
    let byte2 = cpu.saturate_sd_to_ub(destination8[reg_offset + 2] - source8[2]);
    let byte3 = cpu.saturate_sd_to_ub(destination8[reg_offset + 3] - source8[3]);
    let byte4 = cpu.saturate_sd_to_ub(destination8[reg_offset + 4] - source8[4]);
    let byte5 = cpu.saturate_sd_to_ub(destination8[reg_offset + 5] - source8[5]);
    let byte6 = cpu.saturate_sd_to_ub(destination8[reg_offset + 6] - source8[6]);
    let byte7 = cpu.saturate_sd_to_ub(destination8[reg_offset + 7] - source8[7]);

    let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
    let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

    cpu.write_mmx64s(low, high);
};

t[0xD9] = cpu => {
    // psubusw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let word0 = (destination_low & 0xFFFF) - (source[0] & 0xFFFF);
    let word1 = (destination_low >>> 16) - (source[0] >>> 16);
    if (word0 < 0) {
        word0 = 0;
    }
    if (word1 < 0) {
        word1 = 0;
    }

    let word2 = (destination_high & 0xFFFF) - (source[1] & 0xFFFF);
    let word3 = (destination_high >>> 16) - (source[1] >>> 16);
    if (word2 < 0) {
        word2 = 0;
    }
    if (word3 < 0) {
        word3 = 0;
    }

    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;

    cpu.write_mmx64s(low, high);
};

t[0xDA] = cpu => {
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_66);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    // pminub xmm, xmm/m128
    let source = cpu.read_xmm_mem128s();
    let source8 = new Uint8Array(source.buffer);

    let destination = cpu.read_xmm128s();
    let destination8 = new Uint8Array(destination.buffer);

    let result = cpu.create_atom128s(0, 0, 0, 0);
    let result8 = new Uint8Array(result.buffer);

    for(let i = 0; i < 16; i++)
    {
        result8[i] = source8[i] < destination8[i] ? source8[i] : destination8[i];
    }

    cpu.write_xmm128s(result[0], result[1], result[2], result[3])
};
t[0xDB] = cpu => {
    // pand mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let low = source[0] & destination_low;
    let high = source[1] & destination_high;

    cpu.write_mmx64s(low, high);
};

t[0xDC] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // paddusb xmm, xmm/m128
        let source = cpu.read_xmm_mem128s();
        let source8 = new Uint8Array(source.buffer);

        let destination = cpu.read_xmm128s();
        let destination8 = new Uint8Array(destination.buffer);

        let result = cpu.create_atom128s(0, 0, 0, 0);
        let result8 = new Uint8Array(result.buffer);

        for(let i = 0; i < 16; i++)
        {
            result8[i] = cpu.saturate_ud_to_ub(source8[i] + destination8[i]);
        }

        cpu.write_xmm128s(result[0], result[1], result[2], result[3])
    }
    else
    {
        // paddusb mm, mm/m64
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);

        let source64s = cpu.read_mmx_mem64s();
        let source8 = new Uint8Array(source64s.buffer);

        let reg_offset = 8 * (cpu.modrm_byte >> 3 & 7);
        let destination8 = cpu.reg_mmx8;

        let byte0 = cpu.saturate_ud_to_ub(destination8[reg_offset] + source8[0]);
        let byte1 = cpu.saturate_ud_to_ub(destination8[reg_offset + 1] + source8[1]);
        let byte2 = cpu.saturate_ud_to_ub(destination8[reg_offset + 2] + source8[2]);
        let byte3 = cpu.saturate_ud_to_ub(destination8[reg_offset + 3] + source8[3]);
        let byte4 = cpu.saturate_ud_to_ub(destination8[reg_offset + 4] + source8[4]);
        let byte5 = cpu.saturate_ud_to_ub(destination8[reg_offset + 5] + source8[5]);
        let byte6 = cpu.saturate_ud_to_ub(destination8[reg_offset + 6] + source8[6]);
        let byte7 = cpu.saturate_ud_to_ub(destination8[reg_offset + 7] + source8[7]);

        let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
        let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

        cpu.write_mmx64s(low, high);
    }
};

t[0xDD] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // paddusw mm, mm/m64
        let source = cpu.read_xmm_mem128s();
        let source16 = new Uint16Array(source.buffer);

        let destination = cpu.read_xmm128s();
        let destination16 = new Uint16Array(destination.buffer);

        cpu.write_xmm128s(
            cpu.saturate_uw(source16[0] + destination16[0]) | cpu.saturate_uw(source16[1] + destination16[1]) << 16,
            cpu.saturate_uw(source16[2] + destination16[2]) | cpu.saturate_uw(source16[3] + destination16[3]) << 16,
            cpu.saturate_uw(source16[4] + destination16[4]) | cpu.saturate_uw(source16[5] + destination16[5]) << 16,
            cpu.saturate_uw(source16[6] + destination16[6]) | cpu.saturate_uw(source16[7] + destination16[7]) << 16
        );
    }
    else
    {
        // paddusw mm, mm/m64
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);

        let source = cpu.read_mmx_mem64s();
        let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
        let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

        let word0 = cpu.saturate_uw((destination_low & 0xFFFF) + (source[0] & 0xFFFF));
        let word1 = cpu.saturate_uw((destination_low >>> 16) + (source[0] >>> 16));
        let word2 = cpu.saturate_uw((destination_high & 0xFFFF) + (source[1] & 0xFFFF));
        let word3 = cpu.saturate_uw((destination_high >>> 16) + (source[1] >>> 16));

        let low = word0 | word1 << 16;
        let high = word2 | word3 << 16;

        cpu.write_mmx64s(low, high);
    }
};

t[0xDE] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // pmaxub xmm, xmm/m128
        let source = cpu.read_xmm_mem128s();
        let source8 = new Uint8Array(source.buffer);

        let destination = cpu.read_xmm128s();
        let destination8 = new Uint8Array(destination.buffer);

        let result = cpu.create_atom128s(0, 0, 0, 0);
        let result8 = new Uint8Array(result.buffer);

        for(let i = 0; i < 16; i++)
        {
            result8[i] = source8[i] > destination8[i] ? source8[i] : destination8[i];
        }

        cpu.write_xmm128s(result[0], result[1], result[2], result[3])
    }
    else
    {
        dbg_assert(false);
    }
};
t[0xDF] = cpu => {
    // pandn mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let low = source[0] & ~destination_low;
    let high = source[1] & ~destination_high;

    cpu.write_mmx64s(low, high);
};

t[0xE0] = cpu => { cpu.unimplemented_sse(); };

t[0xE1] = cpu => {
    // psraw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let shift = source[0] >>> 0;
    if (shift > 15) {
        shift = 16;
    }

    let word0 = ((destination_low << 16 >> 16) >> shift) & 0xFFFF;
    let word1 = ((destination_low >> 16) >> shift) & 0xFFFF;
    let low = word0 | word1 << 16;

    let word2 = ((destination_high << 16 >> 16) >> shift) & 0xFFFF;
    let word3 = ((destination_high >> 16) >> shift) & 0xFFFF;
    let high = word2 | word3 << 16;

    cpu.write_mmx64s(low, high);
};

t[0xE2] = cpu => {
    // psrad mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let shift = source[0] >>> 0;
    if (shift > 31) {
        shift = 31;
    }

    let low = destination_low >> shift;
    let high = destination_high >> shift;

    cpu.write_mmx64s(low, high);
};

t[0xE3] = cpu => { cpu.unimplemented_sse(); };
t[0xE4] = cpu => {
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    // pmulhuw xmm, xmm/m128
    let source = cpu.read_xmm_mem128s();
    let source16 = new Uint16Array(source.buffer);

    let destination = cpu.read_xmm128s();
    let destination16 = new Uint16Array(destination.buffer);

    cpu.write_xmm128s(
        source16[0] * destination16[0] >>> 16 | source16[1] * destination16[1] & 0xFFFF0000,
        source16[2] * destination16[2] >>> 16 | source16[3] * destination16[3] & 0xFFFF0000,
        source16[4] * destination16[4] >>> 16 | source16[5] * destination16[5] & 0xFFFF0000,
        source16[6] * destination16[6] >>> 16 | source16[7] * destination16[7] & 0xFFFF0000
    );
};

t[0xE5] = cpu => {
    // pmulhw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let word0 = ((destination_low << 16 >> 16) * (source[0] << 16 >> 16)) >>> 16;
    let word1 = ((destination_low >> 16) * (source[0] >> 16)) >>> 16;
    let word2 = ((destination_high << 16 >> 16) * (source[1] << 16 >> 16)) >>> 16;
    let word3 = ((destination_high >> 16) * (source[1] >> 16)) >>> 16;

    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;

    cpu.write_mmx64s(low, high);
};

t[0xE6] = cpu => { cpu.unimplemented_sse(); };
t[0xE7] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if(cpu.modrm_byte >= 0xC0)
    {
        cpu.trigger_ud();
    }

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        let data = cpu.read_xmm128s();
        let addr = cpu.modrm_resolve(cpu.modrm_byte);
        cpu.safe_write128(addr, data[0], data[1], data[2], data[3]);
    }
    else
    {
        dbg_assert(false);
    }
};

t[0xE8] = cpu => {
    // psubsb mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source64s = cpu.read_mmx_mem64s();
    let source8s = new Int8Array(source64s.buffer);

    let reg_offset = 8 * (cpu.modrm_byte >> 3 & 7);
    let destination8s = cpu.reg_mmx8s;

    let byte0 = cpu.saturate_sd_to_sb(destination8s[reg_offset] - source8s[0]);
    let byte1 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 1] - source8s[1]);
    let byte2 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 2] - source8s[2]);
    let byte3 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 3] - source8s[3]);
    let byte4 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 4] - source8s[4]);
    let byte5 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 5] - source8s[5]);
    let byte6 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 6] - source8s[6]);
    let byte7 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 7] - source8s[7]);

    let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
    let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

    cpu.write_mmx64s(low, high);
};

t[0xE9] = cpu => {
    // psubsw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let word0 = cpu.saturate_sd_to_sw((destination_low << 16 >> 16) - (source[0] << 16 >> 16));
    let word1 = cpu.saturate_sd_to_sw((destination_low >> 16) - (source[0] >> 16));
    let word2 = cpu.saturate_sd_to_sw((destination_high << 16 >> 16) - (source[1] << 16 >> 16));
    let word3 = cpu.saturate_sd_to_sw((destination_high >> 16) - (source[1] >> 16));

    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;

    cpu.write_mmx64s(low, high);
};

t[0xEA] = cpu => { cpu.unimplemented_sse(); };

t[0xEB] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) === PREFIX_66)
    {
        // por xmm, xmm/m128
        let source = cpu.read_xmm_mem128s();
        let destination = cpu.read_xmm128s();

        cpu.write_xmm128s(
            source[0] | destination[0],
            source[1] | destination[1],
            source[2] | destination[2],
            source[3] | destination[3]
        );
    }
    else
    {
        // por mm, mm/m64
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);

        let source = cpu.read_mmx_mem64s();
        let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
        let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

        let low = source[0] | destination_low;
        let high = source[1] | destination_high;

        cpu.write_mmx64s(low, high);
    }
};

t[0xEC] = cpu => {
    // paddsb mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source64s = cpu.read_mmx_mem64s();
    let source8s = new Int8Array(source64s.buffer);

    let reg_offset = 8 * (cpu.modrm_byte >> 3 & 7);
    let destination8s = cpu.reg_mmx8s;

    let byte0 = cpu.saturate_sd_to_sb(destination8s[reg_offset] + source8s[0]);
    let byte1 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 1] + source8s[1]);
    let byte2 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 2] + source8s[2]);
    let byte3 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 3] + source8s[3]);
    let byte4 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 4] + source8s[4]);
    let byte5 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 5] + source8s[5]);
    let byte6 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 6] + source8s[6]);
    let byte7 = cpu.saturate_sd_to_sb(destination8s[reg_offset + 7] + source8s[7]);

    let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
    let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

    cpu.write_mmx64s(low, high);
};

t[0xED] = cpu => {
    // paddsw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let word0 = cpu.saturate_sd_to_sw((destination_low << 16 >> 16) + (source[0] << 16 >> 16));
    let word1 = cpu.saturate_sd_to_sw((destination_low >> 16) + (source[0] >> 16));
    let word2 = cpu.saturate_sd_to_sw((destination_high << 16 >> 16) + (source[1] << 16 >> 16));
    let word3 = cpu.saturate_sd_to_sw((destination_high >> 16) + (source[1] >> 16));

    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;

    cpu.write_mmx64s(low, high);
};

t[0xEE] = cpu => { cpu.unimplemented_sse(); };
t[0xEF] = cpu => {
    // pxor mm, mm/m64
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        let source = cpu.read_xmm_mem128s();
        let destination = cpu.read_xmm128s();

        cpu.write_xmm128s(
            source[0] ^ destination[0],
            source[1] ^ destination[1],
            source[2] ^ destination[2],
            source[3] ^ destination[3]
        );
    }
    else
    {
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
        let source = cpu.read_mmx_mem64s();
        let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
        let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

        let low = source[0] ^ destination_low;
        let high = source[1] ^ destination_high;

        cpu.write_mmx64s(low, high);
    }
};

t[0xF0] = cpu => { cpu.unimplemented_sse(); };

t[0xF1] = cpu => {
    // psllw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let shift = source[0] >>> 0;
    let low = 0;
    let high = 0;

    if (shift <= 15) {
        let word0 = ((destination_low & 0xFFFF) << shift) & 0xFFFF;
        let word1 = (destination_low >>> 16) << shift;
        low = word0 | word1 << 16;

        let word2 = ((destination_high & 0xFFFF) << shift) & 0xFFFF;
        let word3 = (destination_high >>> 16) << shift;
        high = word2 | word3 << 16;
    }

    cpu.write_mmx64s(low, high);
};

t[0xF2] = cpu => {
    // pslld mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let shift = source[0] >>> 0;
    let low = 0;
    let high = 0;

    if (shift <= 31) {
        low = destination_low << shift;
        high = destination_high << shift;
    }

    cpu.write_mmx64s(low, high);
};

t[0xF3] = cpu => {
    // psllq mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let shift = source[0] >>> 0;

    if(shift === 0)
    {
        return;
    }

    let low = 0;
    let high = 0;

    if (shift <= 31) {
        low = destination_low << shift;
        high = destination_high << shift | (destination_low >>> (32 - shift));
    }
    else if (shift <= 63) {
        high = destination_low << (shift & 0x1F);
        low = 0;
    }

    cpu.write_mmx64s(low, high);
};

t[0xF4] = cpu => {
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    if((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == PREFIX_66)
    {
        // pmuludq xmm1, xmm2/m128
        let source = cpu.read_xmm_mem128s();
        let destination = cpu.read_xmm128s();

        let i = (cpu.modrm_byte >> 3 & 7) << 2;

        let result = cpu.do_mul32(destination[0] , source[0]);
        cpu.reg_xmm32s[i] = result[0];
        cpu.reg_xmm32s[i + 1] = result[1];

        result = cpu.do_mul32(destination[2] , source[2]);
        cpu.reg_xmm32s[i + 2] = result[0];
        cpu.reg_xmm32s[i + 3] = result[1];
    }
    else
    {
        // pmuludq mm1, mm2/m64
        dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
        let source64s = cpu.read_mmx_mem64s();
        let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];

        let result = cpu.do_mul32(destination_low,source64s[0])

        cpu.write_mmx64s(result[0], result[1]);
    }
};

t[0xF5] = cpu => {
    // pmaddwd mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let mul0 = ((destination_low << 16 >> 16) * (source[0] << 16 >> 16));
    let mul1 = ((destination_low >> 16) * (source[0] >> 16));
    let mul2 = ((destination_high << 16 >> 16) * (source[1] << 16 >> 16));
    let mul3 = ((destination_high >> 16) * (source[1] >> 16));

    let low = mul0 + mul1 | 0;
    let high = mul2 + mul3 | 0;

    cpu.write_mmx64s(low, high);
};

t[0xF6] = cpu => { cpu.unimplemented_sse(); };
t[0xF7] = cpu => { cpu.unimplemented_sse(); };

t[0xF8] = cpu => {
    // psubb mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source64s = cpu.read_mmx_mem64s();
    let source8s = new Int8Array(source64s.buffer);

    let reg_offset = 8 * (cpu.modrm_byte >> 3 & 7);
    let destination8s = cpu.reg_mmx8s;

    let byte0 = (destination8s[reg_offset] - source8s[0]) & 0xFF;
    let byte1 = (destination8s[reg_offset + 1] - source8s[1]) & 0xFF;
    let byte2 = (destination8s[reg_offset + 2] - source8s[2]) & 0xFF;
    let byte3 = (destination8s[reg_offset + 3] - source8s[3]) & 0xFF;
    let byte4 = (destination8s[reg_offset + 4] - source8s[4]) & 0xFF;
    let byte5 = (destination8s[reg_offset + 5] - source8s[5]) & 0xFF;
    let byte6 = (destination8s[reg_offset + 6] - source8s[6]) & 0xFF;
    let byte7 = (destination8s[reg_offset + 7] - source8s[7]) & 0xFF;

    let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
    let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

    cpu.write_mmx64s(low, high);
};

t[0xF9] = cpu => {
    // psubw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let word0 = (destination_low - source[0]) & 0xFFFF;
    let word1 = ((destination_low >>> 16) - (source[0] >>> 16)) & 0xFFFF;
    let low = word0 | word1 << 16;

    let word2 = (destination_high - source[1]) & 0xFFFF;
    let word3 = ((destination_high >>> 16) - (source[1] >>> 16)) & 0xFFFF;
    let high = word2 | word3 << 16;

    cpu.write_mmx64s(low, high);
};

t[0xFA] = cpu => {
    // psubd mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let low = destination_low - source[0];
    let high = destination_high - source[1];

    cpu.write_mmx64s(low, high);
};

t[0xFB] = cpu => { cpu.unimplemented_sse(); };

t[0xFC] = cpu => {
    // paddb mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source64s = cpu.read_mmx_mem64s();
    let source8s = new Int8Array(source64s.buffer);

    let reg_offset = 8 * (cpu.modrm_byte >> 3 & 7);
    let destination8s = cpu.reg_mmx8s;

    let byte0 = (destination8s[reg_offset] + source8s[0]) & 0xFF;
    let byte1 = (destination8s[reg_offset + 1] + source8s[1]) & 0xFF;
    let byte2 = (destination8s[reg_offset + 2] + source8s[2]) & 0xFF;
    let byte3 = (destination8s[reg_offset + 3] + source8s[3]) & 0xFF;
    let byte4 = (destination8s[reg_offset + 4] + source8s[4]) & 0xFF;
    let byte5 = (destination8s[reg_offset + 5] + source8s[5]) & 0xFF;
    let byte6 = (destination8s[reg_offset + 6] + source8s[6]) & 0xFF;
    let byte7 = (destination8s[reg_offset + 7] + source8s[7]) & 0xFF;

    let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
    let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;

    cpu.write_mmx64s(low, high);
};

t[0xFD] = cpu => {
    // paddw mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let word0 = (destination_low + source[0]) & 0xFFFF;
    let word1 = ((destination_low >>> 16) + (source[0] >>> 16)) & 0xFFFF;
    let low = word0 | word1 << 16;

    let word2 = (destination_high + source[1]) & 0xFFFF;
    let word3 = ((destination_high >>> 16) + (source[1] >>> 16)) & 0xFFFF;
    let high = word2 | word3 << 16;

    cpu.write_mmx64s(low, high);
};

t[0xFE] = cpu => {
    // paddd mm, mm/m64
    dbg_assert((cpu.prefixes & (PREFIX_MASK_REP | PREFIX_MASK_OPSIZE)) == 0);
    cpu.task_switch_test_mmx();
    cpu.read_modrm_byte();

    let source = cpu.read_mmx_mem64s();
    let destination_low = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7)];
    let destination_high = cpu.reg_mmxs[2 * (cpu.modrm_byte >> 3 & 7) + 1];

    let low = destination_low + source[0] | 0;
    let high = destination_high + source[1] | 0;

    cpu.write_mmx64s(low, high);
};

t[0xFF] = cpu => {
    // Windows 98
    dbg_log("#ud: 0F FF");
    cpu.trigger_ud();
};


var table0F_16 = [];
var table0F_32 = [];
CPU.prototype.table0F_16 = table0F_16;
CPU.prototype.table0F_32 = table0F_32;

for(i = 0; i < 256; i++)
{
    if(t[i])
    {
        //dbg_assert(!t16[i]);
        //dbg_assert(!t32[i]);
        table0F_16[i] = table0F_32[i] = t[i];
    }
    else if(t16[i])
    {
        //dbg_assert(!t[i]);
        //dbg_assert(t32[i]);
        table0F_16[i] = t16[i];
        table0F_32[i] = t32[i];
    }
}
