"use strict";

var 
    table16 = [], 
    table32 = [], 
    table0F_16 = [],
    table0F_32 = [];

CPU.prototype.table16 = table16;
CPU.prototype.table32 = table32;

CPU.prototype.table0F_16 = table0F_16;
CPU.prototype.table0F_32 = table0F_32;


#define op(n, code) table16[n] = table32[n] = function(cpu) { code };

// opcode with modm byte
#define opm(n, code)\
    table16[n] = table32[n] = function(cpu) { var modrm_byte = cpu.read_imm8(); code };

// opcode that has a 16 and a 32 bit version
#define op2(n, code16, code32)\
    table16[n] = function(cpu) { code16 };\
    table32[n] = function(cpu) { code32 };

#define opm2(n, code16, code32)\
    table16[n] = function(cpu) { var modrm_byte = cpu.read_imm8(); code16 };\
    table32[n] = function(cpu) { var modrm_byte = cpu.read_imm8(); code32 };


#define unimplemented_sse(num) op(num, {\
    dbg_log("No SSE", LOG_CPU);\
    cpu.trigger_ud();\
})

#define undefined_instruction(num) op(num, {\
    if(DEBUG) throw "Possible fault: undefined instruction"; \
    cpu.trigger_ud();\
})

#define todo()\
    if(DEBUG) { dbg_trace(); throw "TODO"; }\
    cpu.trigger_ud();


#define each_jcc(macro)\
    macro(0x0, ( cpu.test_o()));\
    macro(0x1, (!cpu.test_o()));\
    macro(0x2, ( cpu.test_b()));\
    macro(0x3, (!cpu.test_b()));\
    macro(0x4, ( cpu.test_z()));\
    macro(0x5, (!cpu.test_z()));\
    macro(0x6, ( cpu.test_be()));\
    macro(0x7, (!cpu.test_be()));\
    macro(0x8, ( cpu.test_s()));\
    macro(0x9, (!cpu.test_s()));\
    macro(0xA, ( cpu.test_p()));\
    macro(0xB, (!cpu.test_p()));\
    macro(0xC, ( cpu.test_l()));\
    macro(0xD, (!cpu.test_l()));\
    macro(0xE, ( cpu.test_le()));\
    macro(0xF, (!cpu.test_le()));


// very special, should be somewhere else?
#define lss_op16(sreg)\
    if(modrm_byte >= 0xC0) { cpu.trigger_ud(); }\
    cpu.lss16(sreg, cpu.modrm_resolve(modrm_byte), modrm_byte >> 2 & 14);


#define lss_op32(sreg)\
    if(modrm_byte >= 0xC0) { cpu.trigger_ud(); }\
    cpu.lss32(sreg, cpu.modrm_resolve(modrm_byte), modrm_byte >> 3 & 7);


#define bt_op16(op, arg16)\
    if(modrm_byte < 0xC0) {\
        cpu.op ## _mem(cpu.modrm_resolve(modrm_byte), arg16);\
    } else {\
        reg_e16 = cpu.op ## _reg(reg_e16, arg16 & 15);\
    }

#define bt_op32(op, arg32)\
    if(modrm_byte < 0xC0) {\
        cpu.op ## _mem(cpu.modrm_resolve(modrm_byte), arg32);\
    } else {\
        reg_e32s = cpu.op ## _reg(reg_e32s, arg32 & 31);\
    }


// equivalent to switch(modrm_byte >> 3 & 7)
//#define sub_op(i0, i1, i2, i3, i4, i5, i6, i7) \
//    if(modrm_byte & 0x20) { sub_op1(i4, i5, i6, i7) }\
//    else { sub_op1(i0, i1, i2, i3) }
//
//#define sub_op1(i0, i1, i2, i3)\
//    if(modrm_byte & 0x10) { sub_op2(i2, i3) }\
//    else { sub_op2(i0, i1) }
//
//#define sub_op2(i0, i1)\
//    if(modrm_byte & 0x08) { i1 }\
//    else { i0 }


// Evaluate the modrm byte of the instruction and run one
//   of the 8 instructions depending on the middle 3 bits.
// Used by 0x80-0x83, 0xd0-0xd3, 0xc0-0xc1, 0xf6-0xf7 and 0xff
#define sub_op(i0, i1, i2, i3, i4, i5, i6, i7) \
    switch(modrm_byte >> 3 & 7) {\
        case 0: i0; break;\
        case 1: i1; break;\
        case 2: i2; break;\
        case 3: i3; break;\
        case 4: i4; break;\
        case 5: i5; break;\
        case 6: i6; break;\
        case 7: i7; break;\
    }

#define sub_op_instr(i)\
    result = i(data, data2)

#define sub_op_write(size, second_operand, i0, i1, i2, i3, i4, i5, i6, i7)\
    var data2;\
    write_e ## size(0; data2 = second_operand;\
            sub_op(sub_op_instr(i0), sub_op_instr(i1), sub_op_instr(i2), sub_op_instr(i3),\
                   sub_op_instr(i4), sub_op_instr(i5), sub_op_instr(i6), sub_op_instr(i7))\
    )


// equivalent to switch(modrm_byte >> 3 & 7)
#define sub_op_expr(i0, i1, i2, i3, i4, i5, i6, i7) \
    ((modrm_byte & 0x20) ? sub_op_expr1(i4, i5, i6, i7) :\
    sub_op_expr1(i0, i1, i2, i3))

#define sub_op_expr1(i0, i1, i2, i3)\
    ((modrm_byte & 0x10) ? sub_op_expr2(i2, i3) :\
    sub_op_expr2(i0, i1))

#define sub_op_expr2(i0, i1)\
    ((modrm_byte & 0x08) ? (i1) :\
    (i0))


#define pop_sreg_op(n, reg)\
    op2(n, \
        { cpu.switch_seg(reg, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 2; }, \
        { cpu.switch_seg(reg, cpu.safe_read16(cpu.get_stack_pointer(0))); cpu.stack_reg[cpu.reg_vsp] += 4; });


#define reg_e8  cpu.reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]
#define reg_e8s cpu.reg8s[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]
#define reg_g8  cpu.reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1]

#define reg_e16  cpu.reg16[modrm_byte << 1 & 14]
#define reg_e16s cpu.reg16s[modrm_byte << 1 & 14]
#define reg_g16  cpu.reg16[modrm_byte >> 2 & 14] 
#define reg_g16s cpu.reg16s[modrm_byte >> 2 & 14] 

#define reg_e32 cpu.reg32[modrm_byte & 7]
#define reg_e32s cpu.reg32s[modrm_byte & 7]
//#define reg_g32 cpu.reg32[modrm_byte >> 3 & 7] 
#define reg_g32s cpu.reg32s[modrm_byte >> 3 & 7] 


#define cpu_safe_read8(addr) cpu.safe_read8(addr)
#define cpu_safe_read8s(addr) (cpu.safe_read8(addr) << 24 >> 24)
#define cpu_safe_read16(addr) cpu.safe_read16(addr)
#define cpu_safe_read16s(addr) (cpu.safe_read16(addr) << 16 >> 16)
#define cpu_safe_read32(addr) (cpu.safe_read32s(addr) >>> 0)
#define cpu_safe_read32s(addr) cpu.safe_read32s(addr)

#define modrm_read(size)\
    if(modrm_byte < 0xC0) {\
        var data = cpu_safe_read ## size(cpu.modrm_resolve(modrm_byte)); \
    } else {\
        data = reg_e ## size;\
    }


#define read_e8   modrm_read(8)
#define read_e8s  modrm_read(8s)
#define read_e16  modrm_read(16)
#define read_e16s modrm_read(16s)
#define read_e32  modrm_read(32)
#define read_e32s modrm_read(32s)


// use modrm_byte to write a value to cpu.memory or register 
// (without reading it beforehand)
#define modrm_set(arg, size) \
    if(modrm_byte < 0xC0) var addr = cpu.modrm_resolve(modrm_byte);\
    var data = arg;\
    if(modrm_byte < 0xC0) {\
        cpu.safe_write ## size(addr, data);\
    } else {\
        reg_e ## size = data;\
    }

#define set_eb(arg)   modrm_set(arg, 8)
#define set_ev16(arg) modrm_set(arg, 16)
#define set_ev32(arg) modrm_set(arg, 32)


// use modrm_byte to write a value to cpu.memory or register,
// using the previous data from cpu.memory or register.
// op is a function call that needs to return the result
#define write_e8(op)\
    var data;\
    var addr;\
    var result;\
    if(modrm_byte < 0xC0) {\
        addr = cpu.translate_address_write(cpu.modrm_resolve(modrm_byte));\
        data = cpu.memory.read8(addr);\
    } else {\
        data = reg_e8;\
    }\
    result = op;\
    if(modrm_byte < 0xC0) {\
        cpu.memory.write8(addr, result);\
    } else {\
        reg_e8 = result;\
    }


#define write_ev16(op)\
    var data;\
    var virt_addr;\
    var phys_addr;\
    var phys_addr_high = 0;\
    var result;\
    if(modrm_byte < 0xC0) {\
        virt_addr = cpu.modrm_resolve(modrm_byte);\
        phys_addr = cpu.translate_address_write(virt_addr);\
        if(cpu.paging && (virt_addr & 0xFFF) === 0xFFF) {\
            phys_addr_high = cpu.translate_address_write(virt_addr + 1);\
            data = cpu.virt_boundary_read16(phys_addr, phys_addr_high);\
        } else {\
            data = cpu.memory.read16(phys_addr);\
        }\
    } else {\
        data = reg_e16;\
    }\
    result = op;\
    if(modrm_byte < 0xC0) {\
        if(phys_addr_high) {\
            cpu.virt_boundary_write16(phys_addr, phys_addr_high, result);\
        } else {\
            cpu.memory.write16(phys_addr, result);\
        }\
    } else {\
        reg_e16 = result;\
    }


#define write_ev32s(op)\
    var data;\
    var virt_addr;\
    var phys_addr;\
    var phys_addr_high = 0;\
    var result;\
    if(modrm_byte < 0xC0) {\
        virt_addr = cpu.modrm_resolve(modrm_byte);\
        phys_addr = cpu.translate_address_write(virt_addr);\
        if(cpu.paging && (virt_addr & 0xFFF) >= 0xFFD) {\
            phys_addr_high = cpu.translate_address_write(virt_addr + 3);\
            data = cpu.virt_boundary_read32s(phys_addr, phys_addr_high);\
        } else {\
            data = cpu.memory.read32s(phys_addr);\
        }\
    } else {\
        data = reg_e32s;\
    }\
    result = op;\
    if(modrm_byte < 0xC0) {\
        if(phys_addr_high) {\
            cpu.virt_boundary_write32(phys_addr, phys_addr_high, result);\
        } else {\
            cpu.memory.write32(phys_addr, result);\
        }\
    } else {\
        reg_e32s = result;\
    }\



#define arith_group(n, instr)\
    opm(n, { write_e8(instr ## 8(data, reg_g8)) })\
    opm2(n | 1, { write_ev16(instr ## 16(data, reg_g16)) }, { write_ev32s(instr ## 32(data, reg_g32s)) })\
    opm(n | 2, { read_e8; reg_g8 = instr ## 8(reg_g8, data); })\
    opm2(n | 3, { read_e16; reg_g16 = instr ## 16(reg_g16, data); }, { read_e32s; reg_g32s = instr ## 32(reg_g32s, data); })\
    op(n | 4, { cpu.reg8[reg_al] = instr ## 8(cpu.reg8[reg_al], cpu.read_imm8()); })\
    op2(n | 5, { cpu.reg16[reg_ax] = instr ## 16(cpu.reg16[reg_ax], cpu.read_imm16()); }, { cpu.reg32s[reg_eax] = instr ## 32(cpu.reg32s[reg_eax], cpu.read_imm32s()); })\
    


// instructions start here

arith_group(0x00, add);

op2(0x06, { cpu.push16(cpu.sreg[reg_es]); }, { cpu.push32(cpu.sreg[reg_es]); });
pop_sreg_op(0x07, reg_es);

arith_group(0x08, or);

op2(0x0E, { cpu.push16(cpu.sreg[reg_cs]); }, { cpu.push32(cpu.sreg[reg_cs]); });
op2(0x0F, { 
    cpu.table0F_16[cpu.read_imm8()](cpu); 
}, {
    cpu.table0F_32[cpu.read_imm8()](cpu); 
});

arith_group(0x10, adc);

op2(0x16, { cpu.push16(cpu.sreg[reg_ss]); }, { cpu.push32(cpu.sreg[reg_ss]); });
pop_sreg_op(0x17, reg_ss);

arith_group(0x18, sbb);

op2(0x1E, { cpu.push16(cpu.sreg[reg_ds]); }, { cpu.push32(cpu.sreg[reg_ds]); });
pop_sreg_op(0x1F, reg_ds);

arith_group(0x20, and);

op(0x26, { cpu.seg_prefix(reg_es); });
op(0x27, { cpu.bcd_daa(); });

arith_group(0x28, sub);

op(0x2E, { cpu.seg_prefix(reg_cs); });
op(0x2F, { cpu.bcd_das(); });

arith_group(0x30, xor);

op(0x36, { cpu.seg_prefix(reg_ss); });
op(0x37, { cpu.bcd_aaa(); });

opm(0x38, { read_e8; cmp8(data, reg_g8); })
opm2(0x39, { read_e16; cmp16(data, reg_g16); }, { read_e32s; cmp32(data, reg_g32s); })
opm(0x3A, { read_e8; cmp8(reg_g8, data); })
opm2(0x3B, { read_e16; cmp16(reg_g16, data); }, { read_e32s; cmp32(reg_g32s, data); })
op(0x3C, { cmp8(cpu.reg8[reg_al], cpu.read_imm8()); })
op2(0x3D, { cmp16(cpu.reg16[reg_ax], cpu.read_imm16()); }, { cmp32(cpu.reg32s[reg_eax], cpu.read_imm32s()); })

op(0x3E, { cpu.seg_prefix(reg_ds); });
op(0x3F, { cpu.bcd_aas(); });


op2(0x40, { cpu.reg16[reg_ax] = inc16(cpu.reg16[reg_ax]); }, { cpu.reg32s[reg_eax] = inc32(cpu.reg32s[reg_eax]); });
op2(0x41, { cpu.reg16[reg_cx] = inc16(cpu.reg16[reg_cx]); }, { cpu.reg32s[reg_ecx] = inc32(cpu.reg32s[reg_ecx]); });
op2(0x42, { cpu.reg16[reg_dx] = inc16(cpu.reg16[reg_dx]); }, { cpu.reg32s[reg_edx] = inc32(cpu.reg32s[reg_edx]); });
op2(0x43, { cpu.reg16[reg_bx] = inc16(cpu.reg16[reg_bx]); }, { cpu.reg32s[reg_ebx] = inc32(cpu.reg32s[reg_ebx]); });
op2(0x44, { cpu.reg16[reg_sp] = inc16(cpu.reg16[reg_sp]); }, { cpu.reg32s[reg_esp] = inc32(cpu.reg32s[reg_esp]); });
op2(0x45, { cpu.reg16[reg_bp] = inc16(cpu.reg16[reg_bp]); }, { cpu.reg32s[reg_ebp] = inc32(cpu.reg32s[reg_ebp]); });
op2(0x46, { cpu.reg16[reg_si] = inc16(cpu.reg16[reg_si]); }, { cpu.reg32s[reg_esi] = inc32(cpu.reg32s[reg_esi]); });
op2(0x47, { cpu.reg16[reg_di] = inc16(cpu.reg16[reg_di]); }, { cpu.reg32s[reg_edi] = inc32(cpu.reg32s[reg_edi]); });


op2(0x48, { cpu.reg16[reg_ax] = dec16(cpu.reg16[reg_ax]); }, { cpu.reg32s[reg_eax] = dec32(cpu.reg32s[reg_eax]); });
op2(0x49, { cpu.reg16[reg_cx] = dec16(cpu.reg16[reg_cx]); }, { cpu.reg32s[reg_ecx] = dec32(cpu.reg32s[reg_ecx]); });
op2(0x4A, { cpu.reg16[reg_dx] = dec16(cpu.reg16[reg_dx]); }, { cpu.reg32s[reg_edx] = dec32(cpu.reg32s[reg_edx]); });
op2(0x4B, { cpu.reg16[reg_bx] = dec16(cpu.reg16[reg_bx]); }, { cpu.reg32s[reg_ebx] = dec32(cpu.reg32s[reg_ebx]); });
op2(0x4C, { cpu.reg16[reg_sp] = dec16(cpu.reg16[reg_sp]); }, { cpu.reg32s[reg_esp] = dec32(cpu.reg32s[reg_esp]); });
op2(0x4D, { cpu.reg16[reg_bp] = dec16(cpu.reg16[reg_bp]); }, { cpu.reg32s[reg_ebp] = dec32(cpu.reg32s[reg_ebp]); });
op2(0x4E, { cpu.reg16[reg_si] = dec16(cpu.reg16[reg_si]); }, { cpu.reg32s[reg_esi] = dec32(cpu.reg32s[reg_esi]); });
op2(0x4F, { cpu.reg16[reg_di] = dec16(cpu.reg16[reg_di]); }, { cpu.reg32s[reg_edi] = dec32(cpu.reg32s[reg_edi]); });


op2(0x50, { cpu.push16(cpu.reg16[reg_ax]); }, { cpu.push32(cpu.reg32s[reg_eax]); })
op2(0x51, { cpu.push16(cpu.reg16[reg_cx]); }, { cpu.push32(cpu.reg32s[reg_ecx]); })
op2(0x52, { cpu.push16(cpu.reg16[reg_dx]); }, { cpu.push32(cpu.reg32s[reg_edx]); })
op2(0x53, { cpu.push16(cpu.reg16[reg_bx]); }, { cpu.push32(cpu.reg32s[reg_ebx]); })
op2(0x54, { cpu.push16(cpu.reg16[reg_sp]); }, { cpu.push32(cpu.reg32s[reg_esp]); })
op2(0x55, { cpu.push16(cpu.reg16[reg_bp]); }, { cpu.push32(cpu.reg32s[reg_ebp]); })
op2(0x56, { cpu.push16(cpu.reg16[reg_si]); }, { cpu.push32(cpu.reg32s[reg_esi]); })
op2(0x57, { cpu.push16(cpu.reg16[reg_di]); }, { cpu.push32(cpu.reg32s[reg_edi]); })

op2(0x58, { cpu.reg16[reg_ax] = cpu.pop16(); }, { cpu.reg32s[reg_eax] = cpu.pop32s(); })
op2(0x59, { cpu.reg16[reg_cx] = cpu.pop16(); }, { cpu.reg32s[reg_ecx] = cpu.pop32s(); })
op2(0x5A, { cpu.reg16[reg_dx] = cpu.pop16(); }, { cpu.reg32s[reg_edx] = cpu.pop32s(); })
op2(0x5B, { cpu.reg16[reg_bx] = cpu.pop16(); }, { cpu.reg32s[reg_ebx] = cpu.pop32s(); })
op2(0x5C, { cpu.reg16[reg_sp] = cpu.pop16(); }, { cpu.reg32s[reg_esp] = cpu.pop32s(); })
op2(0x5D, { cpu.reg16[reg_bp] = cpu.pop16(); }, { cpu.reg32s[reg_ebp] = cpu.pop32s(); })
op2(0x5E, { cpu.reg16[reg_si] = cpu.pop16(); }, { cpu.reg32s[reg_esi] = cpu.pop32s(); })
op2(0x5F, { cpu.reg16[reg_di] = cpu.pop16(); }, { cpu.reg32s[reg_edi] = cpu.pop32s(); })


op2(0x60, { cpu.pusha16(); }, { cpu.pusha32(); });
op2(0x61, { cpu.popa16(); }, { cpu.popa32(); });

op(0x62, { 
    // bound
    dbg_log("Unimplemented BOUND instruction", LOG_CPU);
});
opm(0x63, { 
    // arpl
    dbg_log("arpl", LOG_CPU);
    if(cpu.protected_mode && !cpu.vm86_mode())
    {
        write_ev16(cpu.arpl(data, modrm_byte >> 2 & 14));
    }
    else
    {
        cpu.trigger_ud();
    }
});

op(0x64, { cpu.seg_prefix(reg_fs); });
op(0x65, { cpu.seg_prefix(reg_gs); });

op2(0x66, {
    // Operand-size override prefix
    dbg_assert(cpu.operand_size_32 === cpu.is_32);

    cpu.operand_size_32 = true;

    cpu.table = cpu.table32;
    cpu.do_op();

    cpu.operand_size_32 = cpu.is_32;
    cpu.update_operand_size();
}, {
    dbg_assert(cpu.operand_size_32 === cpu.is_32);
    cpu.operand_size_32 = false;

    cpu.table = cpu.table16;
    cpu.do_op();

    cpu.operand_size_32 = cpu.is_32;
    cpu.update_operand_size();
});

op(0x67, {
    // Address-size override prefix
    dbg_assert(cpu.address_size_32 === cpu.is_32);

    cpu.address_size_32 = !cpu.is_32;
    cpu.update_address_size();

    cpu.do_op();

    cpu.address_size_32 = cpu.is_32;
    cpu.update_address_size();
});

op2(0x68, { cpu.push16(cpu.read_imm16()); }, { cpu.push32(cpu.read_imm32s()); });

opm2(0x69, {
    read_e16s;
    reg_g16 = cpu.imul_reg16(cpu.read_imm16s(), data);
}, {
    read_e32s;
    reg_g32s = cpu.imul_reg32(cpu.read_imm32s(), data);
});

op2(0x6A, { cpu.push16(cpu.read_imm8s()); }, { cpu.push32(cpu.read_imm8s()); });

opm2(0x6B, {
    read_e16s;
    reg_g16 = cpu.imul_reg16(cpu.read_imm8s(), data);
}, {
    read_e32s;
    reg_g32s = cpu.imul_reg32(cpu.read_imm8s(), data);
});

op(0x6C, { insb(cpu); });
op2(0x6D, { insw(cpu); }, { insd(cpu); });
op(0x6E, { outsb(cpu); });
op2(0x6F, { outsw(cpu); }, { outsd(cpu); });


#define group70(n, test) \
    op(0x70 | n, { \
        if(test) { \
            cpu.instruction_pointer = cpu.instruction_pointer + cpu.read_imm8s() | 0;\
        }\
        cpu.instruction_pointer++;\
        cpu.last_instr_jump = true;\
    });

each_jcc(group70);
#undef group70


opm(0x80, { 
    if((modrm_byte & 56) === 56) 
    {
        // CMP
        read_e8; 
        cmp8(data, cpu.read_imm8());
    }
    else
    {
        sub_op_write(
            8, cpu.read_imm8(),
            add8,
            or8,
            adc8,
            sbb8,
            and8,
            sub8,
            xor8,
            dbg_assert.bind(this, 0)
        )
    }
});
opm2(0x81, {
    if((modrm_byte & 56) === 56) 
    {
        // CMP
        read_e16; 
        cmp16(data, cpu.read_imm16());
    }
    else
    {
        sub_op_write(
            v16, cpu.read_imm16(),
            add16,
            or16,
            adc16,
            sbb16,
            and16,
            sub16,
            xor16,
            dbg_assert.bind(this, 0)
        )
    }
}, {
    if((modrm_byte & 56) === 56) 
    {
        // CMP
        read_e32s; 
        cmp32(data, cpu.read_imm32s());
    }
    else
    {
        sub_op_write(
            v32s, cpu.read_imm32s(),
            add32,
            or32,
            adc32,
            sbb32,
            and32,
            sub32,
            xor32,
            dbg_assert.bind(this, 0)
        )
    }
});
op(0x82, { 
    cpu.table[0x80](cpu); // alias
});
opm2(0x83, {
    if((modrm_byte & 56) === 56) 
    {
        // CMP
        read_e16; 
        cmp16(data, cpu.read_imm8s());
    }
    else
    {
        sub_op_write(
            v16, cpu.read_imm8s(),
            add16,
            or16,
            adc16,
            sbb16,
            and16,
            sub16,
            xor16,
            dbg_assert.bind(this, 0)
        )
    }
}, {
    if((modrm_byte & 56) === 56) 
    {
        // CMP
        read_e32s; 
        cmp32(data, cpu.read_imm8s());
    }
    else
    {
        sub_op_write(
            v32s, cpu.read_imm8s(),
            add32,
            or32,
            adc32,
            sbb32,
            and32,
            sub32,
            xor32,
            dbg_assert.bind(this, 0)
        )
    }
});

opm(0x84, { read_e8; test8(data, reg_g8); })
opm2(0x85, { read_e16; test16(data, reg_g16); }, { read_e32s; test32(data, reg_g32s); })


opm(0x86, { write_e8(cpu.xchg8(data, modrm_byte)); });
opm2(0x87, { 
    write_ev16(cpu.xchg16(data, modrm_byte)); 
}, {
    write_ev32s(cpu.xchg32(data, modrm_byte)); 
});

opm(0x88, { set_eb(reg_g8); })
opm2(0x89, { set_ev16(reg_g16); }, { set_ev32(reg_g32s); })

opm(0x8A, {
    read_e8;
    reg_g8 = data;
});
opm2(0x8B, {
    read_e16;
    reg_g16 = data;
}, {
    read_e32s;
    reg_g32s = data;
});

opm2(0x8C, { 
    set_ev16(cpu.sreg[modrm_byte >> 3 & 7]); 
}, { 
    set_ev32(cpu.sreg[modrm_byte >> 3 & 7]); 
});

opm2(0x8D, { 
    // lea
    if(modrm_byte >= 0xC0)
    {
        cpu.trigger_ud();
    }
    var mod = modrm_byte >> 3 & 7;

    // override prefix, so modrm_resolve does not return the segment part
    cpu.segment_prefix = SEG_PREFIX_ZERO;
    cpu.reg16[mod << 1] = cpu.modrm_resolve(modrm_byte);
    cpu.segment_prefix = SEG_PREFIX_NONE;
}, { 
    if(modrm_byte >= 0xC0)
    {
        cpu.trigger_ud();
    }
    var mod = modrm_byte >> 3 & 7;

    cpu.segment_prefix = SEG_PREFIX_ZERO;
    cpu.reg32s[mod] = cpu.modrm_resolve(modrm_byte);
    cpu.segment_prefix = SEG_PREFIX_NONE;
});

opm(0x8E, {
    var mod = modrm_byte >> 3 & 7;

    read_e16;

    cpu.switch_seg(mod, data);

    if(mod === reg_ss)
    {
        // TODO
        // run next instruction, so no irqs are handled
        // Can't use cpu.cycle, because prefixes are still active
    }
});

opm2(0x8F, {
    // pop
    var sp = cpu.safe_read16(cpu.get_stack_pointer(0));

    cpu.stack_reg[cpu.reg_vsp] += 2;

    if(modrm_byte < 0xC0) {
        var addr = cpu.modrm_resolve(modrm_byte);
        cpu.stack_reg[cpu.reg_vsp] -= 2;
        cpu.safe_write16(addr, sp);
        cpu.stack_reg[cpu.reg_vsp] += 2;
    } else {
        reg_e16 = sp;
    }
}, {
    var sp = cpu.safe_read32s(cpu.get_stack_pointer(0));

    // change esp first, then resolve modrm address
    cpu.stack_reg[cpu.reg_vsp] += 4;

    if(modrm_byte < 0xC0) {
        var addr = cpu.modrm_resolve(modrm_byte);

        // Before attempting a write that might cause a page fault,
        // we must set esp to the old value. Fuck Intel.
        cpu.stack_reg[cpu.reg_vsp] -= 4;
        cpu.safe_write32(addr, sp);
        cpu.stack_reg[cpu.reg_vsp] += 4;
    } else {
        reg_e32s = sp;
    }
});

op(0x90,  /* nop */ );
op2(0x91, { cpu.xchg16r(reg_cx) }, { cpu.xchg32r(reg_ecx) });
op2(0x92, { cpu.xchg16r(reg_dx) }, { cpu.xchg32r(reg_edx) });
op2(0x93, { cpu.xchg16r(reg_bx) }, { cpu.xchg32r(reg_ebx) });
op2(0x94, { cpu.xchg16r(reg_sp) }, { cpu.xchg32r(reg_esp) });
op2(0x95, { cpu.xchg16r(reg_bp) }, { cpu.xchg32r(reg_ebp) });
op2(0x96, { cpu.xchg16r(reg_si) }, { cpu.xchg32r(reg_esi) });
op2(0x97, { cpu.xchg16r(reg_di) }, { cpu.xchg32r(reg_edi) });

op2(0x98, 
    { /* cbw */ cpu.reg16[reg_ax] = cpu.reg8s[reg_al]; },
    { /* cwde */ cpu.reg32s[reg_eax] = cpu.reg16s[reg_ax]; });

op2(0x99, 
    { /* cwd */ cpu.reg16[reg_dx] = cpu.reg16s[reg_ax] >> 15; },
    { /* cdq */ cpu.reg32s[reg_edx] = cpu.reg32s[reg_eax] >> 31; });
    
op2(0x9A, {
    // callf

    var new_ip = cpu.read_imm16();
    var new_cs = cpu.read_imm16();

    cpu.writable_or_pagefault(cpu.get_stack_pointer(-4), 4);
    cpu.push16(cpu.sreg[reg_cs]);
    cpu.push16(cpu.get_real_eip());

    cpu.switch_seg(reg_cs, new_cs);
    cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0;
    cpu.last_instr_jump = true;
}, {
    var new_ip = cpu.read_imm32s();
    var new_cs = cpu.read_imm16();

    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        if(new_ip & 0xFFFF0000)
        {
            throw cpu.debug.unimpl("#GP handler");
        }
    }

    cpu.writable_or_pagefault(cpu.get_stack_pointer(-8), 8);
    cpu.push32(cpu.sreg[reg_cs]);
    cpu.push32(cpu.get_real_eip());

    cpu.switch_seg(reg_cs, new_cs);
    cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0;
    cpu.last_instr_jump = true;
});

op(0x9B, {
    // fwait: check for pending fpu exceptions
    if((cpu.cr0 & (CR0_MP | CR0_TS)) === (CR0_MP | CR0_TS))
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
});
op2(0x9C, {
    // pushf
    if((cpu.flags & flag_vm) && cpu.getiopl() < 3)
    {
        cpu.trigger_gp(0);
    }
    else
    {
        cpu.load_eflags();
        cpu.push16(cpu.flags);
    }
}, {
    // pushf
    if((cpu.flags & flag_vm) && cpu.getiopl() < 3)
    {
        // trap to virtual 8086 monitor
        cpu.trigger_gp(0);
    }
    else
    {
        cpu.load_eflags();
        // vm and rf flag are cleared in image stored on the stack
        cpu.push32(cpu.flags & 0x00FCFFFF);
    }
});
op2(0x9D, {
    // popf
    if((cpu.flags & flag_vm) && cpu.getiopl() < 3)
    {
        cpu.trigger_gp(0);
    }

    cpu.update_eflags((cpu.flags & ~0xFFFF) | cpu.pop16());
    cpu.handle_irqs();
}, {
    // popf
    if((cpu.flags & flag_vm) && cpu.getiopl() < 3)
    {
        cpu.trigger_gp(0);
    }

    cpu.update_eflags(cpu.pop32s());
    cpu.handle_irqs();
});
op(0x9E, {
    // sahf
    cpu.flags = (cpu.flags & ~0xFF) | cpu.reg8[reg_ah];
    cpu.flags = (cpu.flags & flags_mask) | flags_default;
    cpu.flags_changed = 0;
});
op(0x9F, {
    // lahf
    cpu.load_eflags();
    cpu.reg8[reg_ah] = cpu.flags;
});

op(0xA0, {
    // mov
    var data = cpu.safe_read8(cpu.read_moffs());
    cpu.reg8[reg_al] = data;
});
op2(0xA1, {
    // mov
    var data = cpu.safe_read16(cpu.read_moffs());
    cpu.reg16[reg_ax] = data;
}, {
    var data = cpu.safe_read32s(cpu.read_moffs());
    cpu.reg32s[reg_eax] = data;
});
op(0xA2, {
    // mov
    cpu.safe_write8(cpu.read_moffs(), cpu.reg8[reg_al]);
});
op2(0xA3, {
    // mov
    cpu.safe_write16(cpu.read_moffs(), cpu.reg16[reg_ax]);
}, {
    cpu.safe_write32(cpu.read_moffs(), cpu.reg32s[reg_eax]);
});

op(0xA4, { movsb(cpu); });
op2(0xA5, { movsw(cpu); }, { movsd(cpu); });
op(0xA6, { cmpsb(cpu); });
op2(0xA7, { cmpsw(cpu); }, { cmpsd(cpu); });

op(0xA8, {
    test8(cpu.reg8[reg_al], cpu.read_imm8());
});
op2(0xA9, {
    test16(cpu.reg16[reg_ax], cpu.read_imm16());
}, {
    test32(cpu.reg32s[reg_eax], cpu.read_imm32s());
});

op(0xAA, { stosb(cpu); });
op2(0xAB, { stosw(cpu); }, { stosd(cpu); });
op(0xAC, { lodsb(cpu); });
op2(0xAD, { lodsw(cpu); }, { lodsd(cpu); });
op(0xAE, { scasb(cpu); });
op2(0xAF, { scasw(cpu); }, { scasd(cpu); });


op(0xB0, { cpu.reg8[reg_al] = cpu.read_imm8(); })
op(0xB1, { cpu.reg8[reg_cl] = cpu.read_imm8(); })
op(0xB2, { cpu.reg8[reg_dl] = cpu.read_imm8(); })
op(0xB3, { cpu.reg8[reg_bl] = cpu.read_imm8(); })
op(0xB4, { cpu.reg8[reg_ah] = cpu.read_imm8(); })
op(0xB5, { cpu.reg8[reg_ch] = cpu.read_imm8(); })
op(0xB6, { cpu.reg8[reg_dh] = cpu.read_imm8(); })
op(0xB7, { cpu.reg8[reg_bh] = cpu.read_imm8(); })

op2(0xB8, { cpu.reg16[reg_ax] = cpu.read_imm16(); }, { cpu.reg32s[reg_eax] = cpu.read_imm32s(); });
op2(0xB9, { cpu.reg16[reg_cx] = cpu.read_imm16(); }, { cpu.reg32s[reg_ecx] = cpu.read_imm32s(); });
op2(0xBA, { cpu.reg16[reg_dx] = cpu.read_imm16(); }, { cpu.reg32s[reg_edx] = cpu.read_imm32s(); });
op2(0xBB, { cpu.reg16[reg_bx] = cpu.read_imm16(); }, { cpu.reg32s[reg_ebx] = cpu.read_imm32s(); });
op2(0xBC, { cpu.reg16[reg_sp] = cpu.read_imm16(); }, { cpu.reg32s[reg_esp] = cpu.read_imm32s(); });
op2(0xBD, { cpu.reg16[reg_bp] = cpu.read_imm16(); }, { cpu.reg32s[reg_ebp] = cpu.read_imm32s(); });
op2(0xBE, { cpu.reg16[reg_si] = cpu.read_imm16(); }, { cpu.reg32s[reg_esi] = cpu.read_imm32s(); });
op2(0xBF, { cpu.reg16[reg_di] = cpu.read_imm16(); }, { cpu.reg32s[reg_edi] = cpu.read_imm32s(); });


opm(0xC0, { 
    sub_op_write(
        8, cpu.read_imm8() & 31, 
        cpu.rol8,
        cpu.ror8,
        cpu.rcl8,
        cpu.rcr8,
        cpu.shl8,
        cpu.shr8,
        cpu.shl8,
        cpu.sar8
    )
});
opm2(0xC1, { 
    sub_op_write(
        v16, cpu.read_imm8() & 31, 
        cpu.rol16,
        cpu.ror16,
        cpu.rcl16,
        cpu.rcr16,
        cpu.shl16,
        cpu.shr16,
        cpu.shl16,
        cpu.sar16
    )
}, {
    sub_op_write(
        v32s, cpu.read_imm8() & 31, 
        cpu.rol32,
        cpu.ror32,
        cpu.rcl32,
        cpu.rcr32,
        cpu.shl32,
        cpu.shr32,
        cpu.shl32,
        cpu.sar32
    )
});

op2(0xC2, {
    // retn
    var imm16 = cpu.read_imm16();

    cpu.instruction_pointer = cpu.get_seg(reg_cs) + cpu.pop16() | 0;
    cpu.stack_reg[cpu.reg_vsp] += imm16;
    cpu.last_instr_jump = true;
}, {
    // retn
    var imm16 = cpu.read_imm16();

    cpu.instruction_pointer = cpu.get_seg(reg_cs) + cpu.pop32s() | 0;
    cpu.stack_reg[cpu.reg_vsp] += imm16;
    cpu.last_instr_jump = true;
});
op2(0xC3, {
    // retn
    cpu.instruction_pointer = cpu.get_seg(reg_cs) + cpu.pop16() | 0;
    cpu.last_instr_jump = true;
}, {
    // retn
    cpu.instruction_pointer = cpu.get_seg(reg_cs) + cpu.pop32s() | 0;
    cpu.last_instr_jump = true;
});

opm2(0xC4, {
    lss_op16(reg_es);
}, {
    lss_op32(reg_es);
});
opm2(0xC5, {
    lss_op16(reg_ds);
}, {
    lss_op32(reg_ds);
});

opm(0xC6, { set_eb(cpu.read_imm8()); })
opm2(0xC7, { set_ev16(cpu.read_imm16()); }, { set_ev32(cpu.read_imm32s()); })

op2(0xC8, { cpu.enter16(); }, { cpu.enter32(); });
op2(0xC9, {
    // leave
    cpu.stack_reg[cpu.reg_vsp] = cpu.stack_reg[cpu.reg_vbp];
    cpu.reg16[reg_bp] = cpu.pop16();
}, {
    cpu.stack_reg[cpu.reg_vsp] = cpu.stack_reg[cpu.reg_vbp];
    cpu.reg32s[reg_ebp] = cpu.pop32s();
});
op2(0xCA, {
    // retf
    cpu.translate_address_read(cpu.get_seg(reg_ss) + cpu.stack_reg[cpu.reg_vsp] + 4);

    var imm16 = cpu.read_imm16();
    var ip = cpu.pop16();

    cpu.switch_seg(reg_cs, cpu.pop16());
    cpu.instruction_pointer = cpu.get_seg(reg_cs) + ip | 0;

    cpu.stack_reg[cpu.reg_vsp] += imm16;
    cpu.last_instr_jump = true;
}, {
    // retf 
    cpu.translate_address_read(cpu.get_seg(reg_ss) + cpu.stack_reg[cpu.reg_vsp] + 8);

    var imm16 = cpu.read_imm16();
    var ip = cpu.pop32s();

    cpu.switch_seg(reg_cs, cpu.pop32s() & 0xFFFF);
    cpu.instruction_pointer = cpu.get_seg(reg_cs) + ip | 0;

    cpu.stack_reg[cpu.reg_vsp] += imm16;
    cpu.last_instr_jump = true;
});
op2(0xCB, {
    // retf
    cpu.translate_address_read(cpu.get_seg(reg_ss) + cpu.stack_reg[cpu.reg_vsp] + 4);
    var ip = cpu.pop16();

    cpu.switch_seg(reg_cs, cpu.pop16());
    cpu.instruction_pointer = cpu.get_seg(reg_cs) + ip | 0;
    cpu.last_instr_jump = true;
}, {
    // retf 
    cpu.translate_address_read(cpu.get_seg(reg_ss) + cpu.stack_reg[cpu.reg_vsp] + 8);
    var ip = cpu.pop32s();

    cpu.switch_seg(reg_cs, cpu.pop32s() & 0xFFFF);
    cpu.instruction_pointer = cpu.get_seg(reg_cs) + ip | 0;
    cpu.last_instr_jump = true;
});

op(0xCC, {
    // INT3
    cpu.call_interrupt_vector(3, true, false);
});
op(0xCD, {
    // INT 
    var imm8 = cpu.read_imm8();

    cpu.call_interrupt_vector(imm8, true, false);
});
op(0xCE, {
    // INTO
    if(cpu.getof())
    {
        cpu.call_interrupt_vector(4, true, false);
    }
});

op2(0xCF, {
    // iret
    cpu.iret16();
}, {
    cpu.iret32();
});

opm(0xD0, { 
    sub_op_write(
        8, 1,
        cpu.rol8,
        cpu.ror8,
        cpu.rcl8,
        cpu.rcr8,
        cpu.shl8,
        cpu.shr8,
        cpu.shl8,
        cpu.sar8
    )
});
opm2(0xD1, { 
    sub_op_write(
        v16, 1,
        cpu.rol16,
        cpu.ror16,
        cpu.rcl16,
        cpu.rcr16,
        cpu.shl16,
        cpu.shr16,
        cpu.shl16,
        cpu.sar16
    )
}, {
    sub_op_write(
        v32s, 1,
        cpu.rol32,
        cpu.ror32,
        cpu.rcl32,
        cpu.rcr32,
        cpu.shl32,
        cpu.shr32,
        cpu.shl32,
        cpu.sar32
    )
});

opm(0xD2, { 
    sub_op_write(
        8, cpu.reg8[reg_cl] & 31,
        cpu.rol8,
        cpu.ror8,
        cpu.rcl8,
        cpu.rcr8,
        cpu.shl8,
        cpu.shr8,
        cpu.shl8,
        cpu.sar8
    )
});
opm2(0xD3, { 
    sub_op_write(
        v16, cpu.reg8[reg_cl] & 31,
        cpu.rol16,
        cpu.ror16,
        cpu.rcl16,
        cpu.rcr16,
        cpu.shl16,
        cpu.shr16,
        cpu.shl16,
        cpu.sar16
    )
}, {
    sub_op_write(
        v32s, cpu.reg8[reg_cl] & 31,
        cpu.rol32,
        cpu.ror32,
        cpu.rcl32,
        cpu.rcr32,
        cpu.shl32,
        cpu.shr32,
        cpu.shl32,
        cpu.sar32
    )
});

op(0xD4, {
    cpu.bcd_aam();
});
op(0xD5, {
    cpu.bcd_aad();
});

op(0xD6, {
    // salc
    cpu.reg8[reg_al] = -cpu.getcf();
});
op(0xD7, {
    // xlat
    if(cpu.address_size_32)
    {
        cpu.reg8[reg_al] = cpu.safe_read8(cpu.get_seg_prefix(reg_ds) + cpu.reg32s[reg_ebx] + cpu.reg8[reg_al]);
    }
    else
    {
        cpu.reg8[reg_al] = cpu.safe_read8(cpu.get_seg_prefix(reg_ds) + cpu.reg16[reg_bx] + cpu.reg8[reg_al]);
    }
});


// fpu instructions
#define fpu_op(n, op)\
    opm(n, { \
        if(cpu.cr0 & (CR0_EM | CR0_TS))\
            cpu.trigger_nm();\
        if(modrm_byte < 0xC0)\
            cpu.fpu.op_ ## op ## _mem(modrm_byte, cpu.modrm_resolve(modrm_byte));\
        else\
            cpu.fpu.op_ ## op ## _reg(modrm_byte);\
    })

fpu_op(0xD8, D8);
fpu_op(0xD9, D9);
fpu_op(0xDA, DA);
fpu_op(0xDB, DB);
fpu_op(0xDC, DC);
fpu_op(0xDD, DD);
fpu_op(0xDE, DE);
fpu_op(0xDF, DF);

#undef fpu_op


op(0xE0, { cpu.loopne(); });
op(0xE1, { cpu.loope(); });
op(0xE2, { cpu.loop(); });
op(0xE3, { cpu.jcxz(); });

op(0xE4, { 
    var port = cpu.read_imm8();
    cpu.test_privileges_for_io(port, 1);
    cpu.reg8[reg_al] = cpu.io.port_read8(port); 
});
op2(0xE5, { 
    var port = cpu.read_imm8();
    cpu.test_privileges_for_io(port, 2);
    cpu.reg16[reg_ax] = cpu.io.port_read16(port); 
}, { 
    var port = cpu.read_imm8();
    cpu.test_privileges_for_io(port, 4);
    cpu.reg32s[reg_eax] = cpu.io.port_read32(port); 
});
op(0xE6, { 
    var port = cpu.read_imm8();
    cpu.test_privileges_for_io(port, 1);
    cpu.io.port_write8(port, cpu.reg8[reg_al]); 
});
op2(0xE7, { 
    var port = cpu.read_imm8();
    cpu.test_privileges_for_io(port, 2);
    cpu.io.port_write16(port, cpu.reg16[reg_ax]); 
}, { 
    var port = cpu.read_imm8();
    cpu.test_privileges_for_io(port, 4);
    cpu.io.port_write32(port, cpu.reg32s[reg_eax]); 
});

op2(0xE8, {
    // call
    var imm16s = cpu.read_imm16s();
    cpu.push16(cpu.get_real_eip());

    cpu.jmp_rel16(imm16s);
    cpu.last_instr_jump = true;
}, {
    // call
    var imm32s = cpu.read_imm32s();
    cpu.push32(cpu.get_real_eip());

    cpu.instruction_pointer = cpu.instruction_pointer + imm32s | 0;
    cpu.last_instr_jump = true;
});
op2(0xE9, {
    // jmp
    var imm16s = cpu.read_imm16s();
    cpu.jmp_rel16(imm16s);
    cpu.last_instr_jump = true;
}, {
    // jmp
    var imm32s = cpu.read_imm32s();
    cpu.instruction_pointer = cpu.instruction_pointer + imm32s | 0;
    cpu.last_instr_jump = true;
});
op2(0xEA, {
    // jmpf
    var ip = cpu.read_imm16();
    cpu.switch_seg(reg_cs, cpu.read_imm16());

    cpu.instruction_pointer = ip + cpu.get_seg(reg_cs) | 0;
    cpu.last_instr_jump = true;
}, {
    // jmpf
    var ip = cpu.read_imm32s();
    cpu.switch_seg(reg_cs, cpu.read_imm16());

    cpu.instruction_pointer = ip + cpu.get_seg(reg_cs) | 0;
    cpu.last_instr_jump = true;
});
op(0xEB, {
    // jmp near
    var imm8 = cpu.read_imm8s();
    cpu.instruction_pointer = cpu.instruction_pointer + imm8 | 0;

    cpu.last_instr_jump = true;
});

op(0xEC, { 
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);
    cpu.reg8[reg_al] = cpu.io.port_read8(port); 
});
op2(0xED, { 
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);
    cpu.reg16[reg_ax] = cpu.io.port_read16(port); 
}, { 
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);
    cpu.reg32s[reg_eax] = cpu.io.port_read32(port); 
});
op(0xEE, { 
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 1);
    cpu.io.port_write8(port, cpu.reg8[reg_al]); 
});
op2(0xEF, { 
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 2);
    cpu.io.port_write16(port, cpu.reg16[reg_ax]); 
}, { 
    var port = cpu.reg16[reg_dx];
    cpu.test_privileges_for_io(port, 4);
    cpu.io.port_write32(port, cpu.reg32s[reg_eax]); 
});

op(0xF0, {
    // lock

    // TODO
    // This triggers UD when used with
    // some instructions that don't write to memory
    cpu.do_op();
});
op(0xF1, {
    // INT1
    // https://code.google.com/p/corkami/wiki/x86oddities#IceBP
    throw cpu.debug.unimpl("int1 instruction");
});

op(0xF2, {
    // repnz
    dbg_assert(cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_NONE);
    cpu.repeat_string_prefix = REPEAT_STRING_PREFIX_NZ;
    cpu.do_op();
    cpu.repeat_string_prefix = REPEAT_STRING_PREFIX_NONE;
});
op(0xF3, {
    // repz
    dbg_assert(cpu.repeat_string_prefix === REPEAT_STRING_PREFIX_NONE);
    cpu.repeat_string_prefix = REPEAT_STRING_PREFIX_Z;
    cpu.do_op();
    cpu.repeat_string_prefix = REPEAT_STRING_PREFIX_NONE;
});

op(0xF4, {
    cpu.hlt_op();
});

op(0xF5, {
    // cmc
    cpu.flags = (cpu.flags | 1) ^ cpu.getcf();
    cpu.flags_changed &= ~1;
});

opm(0xF6, {
    sub_op(
        { read_e8; test8(data, cpu.read_imm8()); },
        { read_e8; test8(data, cpu.read_imm8()); },
        { write_e8(~(data)); },
        { write_e8(cpu.neg8(data)); },
        { read_e8; cpu.mul8(data); },
        { read_e8s; cpu.imul8(data); },
        { read_e8; cpu.div8(data); },
        { read_e8s; cpu.idiv8(data); }
    )
});

opm2(0xF7, {
    sub_op (
        { read_e16; test16(data, cpu.read_imm16()); },
        { read_e16; test16(data, cpu.read_imm16()); },
        { write_ev16(~(data)); },
        { write_ev16(cpu.neg16(data)); },
        { read_e16; cpu.mul16(data); },
        { read_e16s; cpu.imul16(data); },
        { read_e16; cpu.div16(data); },
        { read_e16s; cpu.idiv16(data); }
    )
}, {
    sub_op (
        { read_e32s; test32(data, cpu.read_imm32s()); },
        { read_e32s; test32(data, cpu.read_imm32s()); },
        { write_ev32s(~(data)); },
        { write_ev32s(cpu.neg32(data)); },
        { read_e32; cpu.mul32(data); },
        { read_e32s; cpu.imul32(data); },
        { read_e32; cpu.div32(data); },
        { read_e32s; cpu.idiv32(data); }
    )
});

op(0xF8, {
    // clc
    cpu.flags &= ~flag_carry;
    cpu.flags_changed &= ~1;
});
op(0xF9, {
    // stc
    cpu.flags |= flag_carry;
    cpu.flags_changed &= ~1;
});

op(0xFA, {
    // cli
    //dbg_log("interrupts off");

    if(!cpu.protected_mode || ((cpu.flags & flag_vm) ? 
            cpu.getiopl() === 3 : cpu.getiopl() >= cpu.cpl))
    {
        cpu.flags &= ~flag_interrupt;
    }
    else
    {
        if(cpu.getiopl() < 3 && ((cpu.flags & flag_vm) ? 
            (cpu.cr4 & CR4_VME) :
            (cpu.cpl === 3 && (cpu.cr4 & CR4_PVI))))
        {
            cpu.flags &= ~flag_vif;
        }
        else
        {
            cpu.trigger_gp(0);
        }
    }
});
op(0xFB, {
    // sti
    //dbg_log("interrupts on");

    if(!cpu.protected_mode || ((cpu.flags & flag_vm) ? 
            cpu.getiopl() === 3 : cpu.getiopl() >= cpu.cpl))
    {
        cpu.flags |= flag_interrupt;

        //cpu.table[cpu.read_imm8()](cpu);
        cpu.cycle();

        cpu.handle_irqs();
    }
    else
    {
        if(cpu.getiopl() < 3 && (cpu.flags & flag_vip) === 0 && ((cpu.flags & flag_vm) ? 
            (cpu.cr4 & CR4_VME) :
            (cpu.cpl === 3 && (cpu.cr4 & CR4_PVI))))
        {
            cpu.flags |= flag_vif;
        }
        else
        {
            cpu.trigger_gp(0);
        }
    }

});

op(0xFC, {
    // cld
    cpu.flags &= ~flag_direction;
});
op(0xFD, {
    // std
    cpu.flags |= flag_direction;
});

opm(0xFE, {
    var mod = modrm_byte & 56;

    if(mod === 0)
    {
        write_e8(inc8(data)); 
    }
    else if(mod === 8)
    {
        write_e8(dec8(data)); 
    }
    else
    {
        todo();
    }
});
opm2(0xFF, {
    sub_op(
        { write_ev16(inc16(data)); },
        { write_ev16(dec16(data)); },
        { 
            // 2, call near
            read_e16;
            cpu.push16(cpu.get_real_eip());
            
            cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0;
            cpu.last_instr_jump = true;
        },
        {
            // 3, callf
            if(modrm_byte >= 0xC0)
            {
                cpu.trigger_ud();
                dbg_assert(false, "unreachable");
            }

            var virt_addr = cpu.modrm_resolve(modrm_byte);
            var new_cs = cpu.safe_read16(virt_addr + 2);
            var new_ip = cpu.safe_read16(virt_addr);

            cpu.writable_or_pagefault(cpu.get_stack_pointer(-4), 4);
            cpu.push16(cpu.sreg[reg_cs]);
            cpu.push16(cpu.get_real_eip());

            cpu.switch_seg(reg_cs, new_cs);
            cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0;
            cpu.last_instr_jump = true;
        },
        {
            // 4, jmp near
            read_e16;
            cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0;
            cpu.last_instr_jump = true;
        },
        {
            // 5, jmpf
            if(modrm_byte >= 0xC0)
            {
                cpu.trigger_ud();
                dbg_assert(false, "unreachable");
            }

            var virt_addr = cpu.modrm_resolve(modrm_byte);
            var new_cs = cpu.safe_read16(virt_addr + 2);
            var new_ip = cpu.safe_read16(virt_addr);

            cpu.switch_seg(reg_cs, new_cs);
            cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0;
            cpu.last_instr_jump = true;
        },
        {
            // 6, push
            read_e16;
            cpu.push16(data);
        },
        {
            todo();
        }
    )
}, {
    sub_op(
        { write_ev32s(inc32(data)); },
        { write_ev32s(dec32(data)); },
        { 
            // 2, call near
            read_e32s;
            cpu.push32(cpu.get_real_eip());

            cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0;
            cpu.last_instr_jump = true;
        },
        {
            // 3, callf
            if(modrm_byte >= 0xC0)
            {
                cpu.trigger_ud();
                dbg_assert(false, "unreachable");
            }

            var virt_addr = cpu.modrm_resolve(modrm_byte);
            var new_cs = cpu.safe_read16(virt_addr + 4);
            var new_ip = cpu.safe_read32s(virt_addr);

            cpu.writable_or_pagefault(cpu.get_stack_pointer(-8), 8);
            cpu.push32(cpu.sreg[reg_cs]);
            cpu.push32(cpu.get_real_eip());

            cpu.switch_seg(reg_cs, new_cs);
            cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0;
            cpu.last_instr_jump = true;
        },
        {
            // 4, jmp near
            read_e32s;
            cpu.instruction_pointer = cpu.get_seg(reg_cs) + data | 0;
            cpu.last_instr_jump = true;
        },
        {
            // 5, jmpf
            if(modrm_byte >= 0xC0)
            {
                cpu.trigger_ud();
                dbg_assert(false, "unreachable");
            }

            var virt_addr = cpu.modrm_resolve(modrm_byte);
            var new_cs = cpu.safe_read16(virt_addr + 4);
            var new_ip = cpu.safe_read32s(virt_addr);

            cpu.switch_seg(reg_cs, new_cs);
            cpu.instruction_pointer = cpu.get_seg(reg_cs) + new_ip | 0;
            cpu.last_instr_jump = true;
        },
        {
            // push
            read_e32s;
            cpu.push32(data);
        },
        {
            todo();
        }
    )
});


// 0F ops start here
#define table16 table0F_16
#define table32 table0F_32

opm(0x00, {
    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        // No GP, UD is correct here
        cpu.trigger_ud();
    }

    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }


    switch(modrm_byte >> 3 & 7)
    {
        case 0:
            // sldt
            set_ev16(cpu.sreg[reg_ldtr]);
            break;
        case 1:
            // str
            set_ev16(cpu.sreg[reg_tr]);
            break;
        case 2:
            // lldt
            read_e16;
            cpu.load_ldt(data);
            break;
        case 3:
            // ltr
            read_e16;
            cpu.load_tr(data);
            break;
        default:
            dbg_log(modrm_byte >> 3 & 7, LOG_CPU);
            todo();
    }
});

opm(0x01, {
    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }

    var mod = modrm_byte >> 3 & 7;

    if(mod === 4)
    {
        // smsw
        set_ev16(cpu.cr0);
        return;
    }
    else if(mod === 6)
    {
        // lmsw
        read_e16;

        var old_cr0 = cpu.cr0;
        cpu.cr0 = (cpu.cr0 & ~0xF) | (data & 0xF);

        if(cpu.protected_mode)
        {
            // lmsw cannot be used to switch back
            cpu.cr0 |= CR0_PE;
        }

        //dbg_log("cr0=" + h(data >>> 0), LOG_CPU);
        cpu.cr0_changed(old_cr0);
        return;
    }

    if(modrm_byte >= 0xC0)
    {
        // only memory
        cpu.trigger_ud();
    }

    if((mod === 2 || mod === 3) && cpu.protected_mode)
    {
        // override prefix, so cpu.modrm_resolve does not return the segment part
        // only lgdt and lidt and only in protected mode
        cpu.segment_prefix = SEG_PREFIX_ZERO;
    }

    var addr = cpu.modrm_resolve(modrm_byte);
    cpu.segment_prefix = SEG_PREFIX_NONE;

    switch(mod)
    {
        case 0:
            // sgdt
            cpu.writable_or_pagefault(addr, 6);
            cpu.safe_write16(addr, cpu.gdtr_size);
            cpu.safe_write32(addr + 2, cpu.gdtr_offset);
            break;
        case 1:
            // sidt
            cpu.writable_or_pagefault(addr, 6);
            cpu.safe_write16(addr, cpu.idtr_size);
            cpu.safe_write32(addr + 2, cpu.idtr_offset);
            break;
        case 2:
            // lgdt
            var size = cpu.safe_read16(addr);
            var offset = cpu.safe_read32s(addr + 2);

            cpu.gdtr_size = size;
            cpu.gdtr_offset = offset;

            if(!cpu.operand_size_32)
            {
                cpu.gdtr_offset &= 0xFFFFFF;
            }

            //dbg_log("gdt at " + h(cpu.gdtr_offset) + ", " + cpu.gdtr_size + " bytes", LOG_CPU);
            //dump_gdt_ldt();
            break;
        case 3:
            // lidt
            var size = cpu.safe_read16(addr);
            var offset = cpu.safe_read32s(addr + 2);

            cpu.idtr_size = size;
            cpu.idtr_offset = offset;

            if(!cpu.operand_size_32)
            {
                cpu.idtr_offset &= 0xFFFFFF;
            }

            //dbg_log("[" + h(cpu.instruction_pointer) + "] idt at " + 
            //        h(idtr_offset) + ", " + cpu.idtr_size + " bytes " + h(addr), LOG_CPU);
            break;
        case 7:
            // flush translation lookaside buffer
            cpu.invlpg(addr);
            break;
        default:
            dbg_log(mod);
            todo();
    }
});

opm2(0x02, {
    // lar
    dbg_log("lar", LOG_CPU);
    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        cpu.trigger_ud();
    }
    read_e16; 
    reg_g16 = cpu.lar(data, reg_g16);
}, {
    dbg_log("lar", LOG_CPU);
    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        cpu.trigger_ud();
    }
    read_e16; 
    reg_g32s = cpu.lar(data, reg_g32s);
});

opm2(0x03, {
    // lsl
    dbg_log("lsl", LOG_CPU);
    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        cpu.trigger_ud();
    }
    read_e16; 
    reg_g16 = cpu.lsl(data, reg_g16);
}, {
    dbg_log("lsl", LOG_CPU);
    if(!cpu.protected_mode || cpu.vm86_mode())
    {
        cpu.trigger_ud();
    }
    read_e16; 
    reg_g32s = cpu.lsl(data, reg_g32s);
});

undefined_instruction(0x04);
undefined_instruction(0x05);

op(0x06, {
    // clts
    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }
    else
    {
        //dbg_log("clts", LOG_CPU);
        cpu.cr0 &= ~CR0_TS;
        // do something here ?
    }
});

undefined_instruction(0x07);
op(0x08, {
    // invd
    todo();
})

op(0x09, {
    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }
    // wbinvd
});


undefined_instruction(0x0A);
op(0x0B, {
    // UD2
    cpu.trigger_ud();
});
undefined_instruction(0x0C);

op(0x0D, {
    // nop
    todo();
})

undefined_instruction(0x0E);
undefined_instruction(0x0F);


unimplemented_sse(0x10);
unimplemented_sse(0x11);
unimplemented_sse(0x12);
unimplemented_sse(0x13);
unimplemented_sse(0x14);
unimplemented_sse(0x15);
unimplemented_sse(0x16);
unimplemented_sse(0x17);

opm(0x18, {
    // prefetch
    // nop for us 
    if(modrm_byte < 0xC0)
        cpu.modrm_resolve(modrm_byte);
});

unimplemented_sse(0x19);
unimplemented_sse(0x1A);
unimplemented_sse(0x1B);
unimplemented_sse(0x1C);
unimplemented_sse(0x1D);
unimplemented_sse(0x1E);
unimplemented_sse(0x1F);


opm(0x20, {

    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }
    //dbg_log("cr" + mod + " read", LOG_CPU);

    // mov addr, cr
    // mod = which control register
    switch(modrm_byte >> 3 & 7)
    {
        case 0:
            reg_e32s = cpu.cr0;
            break;
        case 2:
            reg_e32s = cpu.cr2;
            break;
        case 3:
            //dbg_log("read cr3 (" + h(cpu.cr3, 8) + ")", LOG_CPU);
            reg_e32s = cpu.cr3;
            break;
        case 4:
            reg_e32s = cpu.cr4;
            break;
        default:
            dbg_log(modrm_byte >> 3 & 7);
            todo();
    }
});

opm(0x21, {
    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }

    // TODO: mov from debug register
    dbg_assert(modrm_byte >= 0xC0);

    cpu.reg32s[modrm_byte & 7] = cpu.dreg[modrm_byte >> 3 & 7];

    //dbg_log("read dr" + (modrm_byte >> 3 & 7) + ": " + h(cpu.reg32[modrm_byte & 7]), LOG_CPU);
});

opm(0x22, {

    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }

    var data = reg_e32s;
    //dbg_log("cr" + mod + " written: " + h(cpu.reg32[reg]), LOG_CPU);

    // mov cr, addr
    // mod = which control register
    switch(modrm_byte >> 3 & 7)
    {
        case 0:
            var old_cr0 = cpu.cr0;
            cpu.cr0 = data;

            if((cpu.cr0 & (CR0_PE | CR0_PG)) === CR0_PG)
            {
                // cannot load PG without PE
                throw cpu.debug.unimpl("#GP handler");
            }

            cpu.cr0_changed(old_cr0);
            //dbg_log("cr0=" + h(data >>> 0), LOG_CPU);
            break;

        case 2:
            cpu.cr2 = data;
            //dbg_log("cr2=" + h(data >>> 0), LOG_CPU);
            break;

        case 3: 
            //dbg_log("cr3=" + h(data >>> 0), LOG_CPU);
            cpu.cr3 = data;
            dbg_assert((cpu.cr3 & 0xFFF) === 0);
            cpu.clear_tlb();

            //dump_page_directory();
            //dbg_log("page directory loaded at " + h(cpu.cr3 >>> 0, 8), LOG_CPU);
            break;

        case 4:
            if(data & (1 << 11 | 1 << 12 | 1 << 15 | 1 << 16 | 1 << 19 | 0xFFC00000))
            {
                cpu.trigger_gp(0);
            }

            if((cpu.cr4 ^ data) & CR4_PGE)
            {
                if(data & CR4_PGE)
                {
                    // The PGE bit has been enabled. The global TLB is
                    // still empty, so we only have to copy it over
                    cpu.clear_tlb();
                }
                else
                {
                    // Clear the global TLB
                    cpu.full_clear_tlb();
                }
            }

            cpu.cr4 = data;
            cpu.page_size_extensions = (cpu.cr4 & CR4_PSE) ? PSE_ENABLED : 0;

            if(cpu.cr4 & CR4_PAE)
            {
                throw cpu.debug.unimpl("PAE");
            }

            dbg_log("cr4=" + h(cpu.cr4 >>> 0), LOG_CPU);
            break;

        default:
            dbg_log(modrm_byte >> 3 & 7);
            todo();
    }
});
opm(0x23, {
    if(cpu.cpl)
    {
        cpu.trigger_gp(0);
    }

    // TODO: mov to debug register
    dbg_assert(modrm_byte >= 0xC0);
    //dbg_log("write dr" + (modrm_byte >> 3 & 7) + ": " + h(cpu.reg32[modrm_byte & 7]), LOG_CPU);

    cpu.dreg[modrm_byte >> 3 & 7] = reg_e32s;
});

undefined_instruction(0x24);
undefined_instruction(0x25);
undefined_instruction(0x26);
undefined_instruction(0x27);

unimplemented_sse(0x28);
unimplemented_sse(0x29);
unimplemented_sse(0x2A);
unimplemented_sse(0x2B);
unimplemented_sse(0x2C);
unimplemented_sse(0x2D);
unimplemented_sse(0x2E);
unimplemented_sse(0x2F);

// wrmsr
op(0x30, {
    // wrmsr - write maschine specific register
    
    if(cpu.cpl)
    {
        // cpl > 0 or vm86 mode (vm86 mode is always runs with cpl=3)
        cpu.trigger_gp(0);
    }

    var index = cpu.reg32s[reg_ecx];
    var low = cpu.reg32s[reg_eax];
    var high = cpu.reg32s[reg_edx];

    dbg_log("wrmsr ecx=" + h(index >>> 0, 8) + 
                " data=" + h(high >>> 0, 8) + ":" + h(low >>> 0, 8), LOG_CPU);

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
    }
});

op(0x31, {
    // rdtsc - read timestamp counter

    if(!cpu.cpl || !(cpu.cr4 & CR4_TSD))
    {
        var n = v86.microtick() - cpu.tsc_offset;
        dbg_assert(isFinite(n), "non-finite tsc: " + n);

        cpu.reg32s[reg_eax] = n * TSC_RATE;
        cpu.reg32s[reg_edx] = n * (TSC_RATE / 0x100000000);

        //dbg_log("rtdsc  edx:eax=" + h(cpu.reg32[reg_edx], 8) + ":" + h(cpu.reg32[reg_eax], 8), LOG_CPU);
    }
    else
    {
        cpu.trigger_gp(0);
    }
});

op(0x32, {
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
    }

    cpu.reg32s[reg_eax] = low;
    cpu.reg32s[reg_edx] = high;
});

op(0x33, {
    // rdpmc
    todo();
})

op(0x34, {
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

    if(!cpu.is_32)
        cpu.update_cs_size(true);

    cpu.cpl = 0;
    cpu.cpl_changed();

    cpu.sreg[reg_ss] = seg + 8;
    cpu.segment_is_null[reg_ss] = 0;
    cpu.segment_limits[reg_ss] = -1;
    cpu.segment_offsets[reg_ss] = 0;

    cpu.stack_size_32 = true;
    cpu.stack_reg = cpu.reg32s;
    cpu.reg_vsp = reg_esp;
    cpu.reg_vbp = reg_ebp;
});

op(0x35, {
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

    if(!cpu.is_32)
        cpu.update_cs_size(true);

    cpu.cpl = 3;
    cpu.cpl_changed();

    cpu.sreg[reg_ss] = seg + 24 | 3;
    cpu.segment_is_null[reg_ss] = 0;
    cpu.segment_limits[reg_ss] = -1;
    cpu.segment_offsets[reg_ss] = 0;

    cpu.stack_size_32 = true;
    cpu.stack_reg = cpu.reg32s;
    cpu.reg_vsp = reg_esp;
    cpu.reg_vbp = reg_ebp;
});

undefined_instruction(0x36);

op(0x37, {
    // getsec
    todo();
})

unimplemented_sse(0x38);
unimplemented_sse(0x39);
unimplemented_sse(0x3A);
unimplemented_sse(0x3B);
unimplemented_sse(0x3C);
unimplemented_sse(0x3D);
unimplemented_sse(0x3E);
unimplemented_sse(0x3F);


// cmov
#define group0F40(n, test)\
    opm2(0x40 | n, {\
        read_e16;\
        if(test) {\
            reg_g16 = data;\
        }\
    }, {\
        read_e32s;\
        if(test) {\
            reg_g32s = data;\
        }\
    });

each_jcc(group0F40);
#undef group0F40


unimplemented_sse(0x50);
unimplemented_sse(0x51);
unimplemented_sse(0x52);
unimplemented_sse(0x53);
unimplemented_sse(0x54);
unimplemented_sse(0x55);
unimplemented_sse(0x56);
unimplemented_sse(0x57);

unimplemented_sse(0x58);
unimplemented_sse(0x59);
unimplemented_sse(0x5A);
unimplemented_sse(0x5B);
unimplemented_sse(0x5C);
unimplemented_sse(0x5D);
unimplemented_sse(0x5E);
unimplemented_sse(0x5F);

unimplemented_sse(0x60);
unimplemented_sse(0x61);
unimplemented_sse(0x62);
unimplemented_sse(0x63);
unimplemented_sse(0x64);
unimplemented_sse(0x65);
unimplemented_sse(0x66);
unimplemented_sse(0x67);

unimplemented_sse(0x68);
unimplemented_sse(0x69);
unimplemented_sse(0x6A);
unimplemented_sse(0x6B);
unimplemented_sse(0x6C);
unimplemented_sse(0x6D);
unimplemented_sse(0x6E);
unimplemented_sse(0x6F);

unimplemented_sse(0x70);
unimplemented_sse(0x71);
unimplemented_sse(0x72);
unimplemented_sse(0x73);
unimplemented_sse(0x74);
unimplemented_sse(0x75);
unimplemented_sse(0x76);
unimplemented_sse(0x77);

unimplemented_sse(0x78);
unimplemented_sse(0x79);
unimplemented_sse(0x7A);
unimplemented_sse(0x7B);
unimplemented_sse(0x7C);
unimplemented_sse(0x7D);
unimplemented_sse(0x7E);
unimplemented_sse(0x7F);


#define group0F80(n, test) op2(0x80 | n, { cpu.jmpcc16(test); }, { cpu.jmpcc32(test); })
each_jcc(group0F80)
#undef group0F80


#define group0F90(n, test) opm(0x90 | n, { set_eb(!test ^ 1); });
each_jcc(group0F90);
#undef group0F90


op2(0xA0, { cpu.push16(cpu.sreg[reg_fs]); }, { cpu.push32(cpu.sreg[reg_fs]); });
pop_sreg_op(0xA1, reg_fs);

op(0xA2, { cpu.cpuid(); });

opm2(0xA3, {
    if(modrm_byte < 0xC0)
    {
        cpu.bt_mem(cpu.modrm_resolve(modrm_byte), reg_g16s);
    }
    else
    {
        cpu.bt_reg(reg_e16, reg_g16 & 15);
    }
}, {
    if(modrm_byte < 0xC0)
    {
        cpu.bt_mem(cpu.modrm_resolve(modrm_byte), reg_g32s);
    }
    else
    {
        cpu.bt_reg(reg_e32s, reg_g32s & 31);
    }
});

opm2(0xA4, {
    write_ev16(cpu.shld16(data, reg_g16, cpu.read_imm8() & 31));
}, {
    write_ev32s(cpu.shld32(data, reg_g32s, cpu.read_imm8() & 31));
});
opm2(0xA5, {
    write_ev16(cpu.shld16(data, reg_g16, cpu.reg8[reg_cl] & 31));
}, {
    write_ev32s(cpu.shld32(data, reg_g32s, cpu.reg8[reg_cl] & 31));
});

undefined_instruction(0xA6);
undefined_instruction(0xA7);

op2(0xA8, { cpu.push16(cpu.sreg[reg_gs]); }, { cpu.push32(cpu.sreg[reg_gs]); });
pop_sreg_op(0xA9, reg_gs);

op(0xAA, {
    // rsm
    todo();
})

opm2(0xAB, {
    bt_op16(bts, reg_g16s);
}, {
    bt_op32(bts, reg_g32s);
});


opm2(0xAC, {
    write_ev16(cpu.shrd16(data, reg_g16, cpu.read_imm8() & 31));
}, {
    write_ev32s(cpu.shrd32(data, reg_g32s, cpu.read_imm8() & 31));
});
opm2(0xAD, {
    write_ev16(cpu.shrd16(data, reg_g16, cpu.reg8[reg_cl] & 31));
}, {
    write_ev32s(cpu.shrd32(data, reg_g32s, cpu.reg8[reg_cl] & 31));
});

opm(0xAE, {
    // fxsave, fxrstor, ldmxcsr ...

    switch(modrm_byte >> 3 & 7)
    {
        case 6:
            // mfence
            break;
        default:
            dbg_log("missing " + (modrm_byte >> 3 & 7), LOG_CPU);
            todo();
    }
})

opm2(0xAF, {
    read_e16s;
    reg_g16 = cpu.imul_reg16(reg_g16s, data);
}, {
    read_e32s;
    reg_g32s = cpu.imul_reg32(reg_g32s, data);
});


opm(0xB0, {
    // cmpxchg8
    if(modrm_byte < 0xC0)
    {
        var virt_addr = cpu.modrm_resolve(modrm_byte);
        cpu.writable_or_pagefault(virt_addr, 1);

        var data = cpu.safe_read8(virt_addr);
    }
    else
        data = reg_e8;


    cmp8(data, cpu.reg8[reg_al]);

    if(cpu.getzf())
    {
        if(modrm_byte < 0xC0)
            cpu.safe_write8(virt_addr, reg_g8);
        else
            reg_e8 = reg_g8;
    }
    else
    {
        cpu.reg8[reg_al] = data;
    }
});
opm2(0xB1, {
    // cmpxchg16/32
    if(modrm_byte < 0xC0)
    {
        var virt_addr = cpu.modrm_resolve(modrm_byte);
        cpu.writable_or_pagefault(virt_addr, 2);

        var data = cpu.safe_read16(virt_addr);
    }
    else
        data = reg_e16;
    
    cmp16(data, cpu.reg16[reg_ax]);

    if(cpu.getzf())
    {
        if(modrm_byte < 0xC0)
            cpu.safe_write16(virt_addr, reg_g16);
        else
            reg_e16 = reg_g16;
    }
    else
    {
        cpu.reg16[reg_ax] = data;
    }
}, {
    if(modrm_byte < 0xC0)
    {
        var virt_addr = cpu.modrm_resolve(modrm_byte);
        cpu.writable_or_pagefault(virt_addr, 4);

        var data = cpu.safe_read32s(virt_addr);
    }
    else
    {
        data = reg_e32s;
    }

    cmp32(data, cpu.reg32s[reg_eax]);

    if(cpu.getzf())
    {
        if(modrm_byte < 0xC0)
            cpu.safe_write32(virt_addr, reg_g32s);
        else
            reg_e32s = reg_g32s;
    }
    else
    {
        cpu.reg32s[reg_eax] = data;
    }
});

// lss
opm2(0xB2, {
    lss_op16(reg_ss);
}, {
    lss_op32(reg_ss);
});

opm2(0xB3, {
    bt_op16(btr, reg_g16s);
}, {
    bt_op32(btr, reg_g32s);
});

// lfs, lgs
opm2(0xB4, {
    lss_op16(reg_fs);
}, {
    lss_op32(reg_fs);
});
opm2(0xB5, {
    lss_op16(reg_gs);
}, {
    lss_op32(reg_gs);
});

opm2(0xB6, {
    // movzx
    read_e8;
    reg_g16 = data;
}, {
    read_e8;
    reg_g32s = data;
});

opm(0xB7, {
    // movzx
    read_e16;
    reg_g32s = data;
});

opm2(0xB8, {
    // popcnt
    read_e16; 
    reg_g16 = cpu.popcnt(data);
}, {
    read_e32s; 
    reg_g32s = cpu.popcnt(data);
});

op(0xB9, {
    // UD
    todo();
})

opm2(0xBA, {
    //dbg_log("BA " + mod + " " + imm8);

    switch(modrm_byte >> 3 & 7)
    {
        case 4:
            if(modrm_byte < 0xC0)
            {
                cpu.bt_mem(cpu.modrm_resolve(modrm_byte), cpu.read_imm8() & 15);
            }
            else
            {
                cpu.bt_reg(reg_e16, cpu.read_imm8() & 15);
            }
            break;
        case 5:
            bt_op16(bts, cpu.read_imm8());
            break;
        case 6:
            bt_op16(btr, cpu.read_imm8());
            break;
        case 7:
            bt_op16(btc, cpu.read_imm8());
            break;
        default:
            dbg_log(modrm_byte >> 3 & 7);
            todo();
    }
}, {
    //dbg_log("BA " + mod + " " + imm8);

    switch(modrm_byte >> 3 & 7)
    {
        case 4:
            if(modrm_byte < 0xC0)
            {
                cpu.bt_mem(cpu.modrm_resolve(modrm_byte), cpu.read_imm8() & 31);
            }
            else
            {
                cpu.bt_reg(reg_e32s, cpu.read_imm8() & 31);
            }
            break;
        case 5:
            bt_op32(bts, cpu.read_imm8());
            break;
        case 6:
            bt_op32(btr, cpu.read_imm8());
            break;
        case 7:
            bt_op32(btc, cpu.read_imm8());
            break;
        default:
            dbg_log(modrm_byte >> 3 & 7);
            todo();
    }
});

opm2(0xBB, {
    bt_op16(btc, reg_g16s);
}, {
    bt_op32(btc, reg_g32s);
});

opm2(0xBC, {
    read_e16;
    reg_g16 = cpu.bsf16(reg_g16, data);
}, {
    read_e32s;
    reg_g32s = cpu.bsf32(reg_g32s, data);
});

opm2(0xBD, {
    read_e16;
    reg_g16 = cpu.bsr16(reg_g16, data);
}, {
    read_e32s;
    reg_g32s = cpu.bsr32(reg_g32s, data);
});

opm2(0xBE, {
    // movsx
    read_e8s;
    reg_g16 = data;
}, {
    read_e8s;
    reg_g32s = data;
});

opm(0xBF, {
    // movsx
    read_e16s;
    reg_g32s = data;
});

opm(0xC0, {
    write_e8(cpu.xadd8(data, modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1));
});

opm2(0xC1, {
    write_ev16(cpu.xadd16(data, modrm_byte >> 2 & 14));
}, {
    write_ev32s(cpu.xadd32(data, modrm_byte >> 3 & 7));
});


unimplemented_sse(0xC2);
unimplemented_sse(0xC3);
unimplemented_sse(0xC4);
unimplemented_sse(0xC5);
unimplemented_sse(0xC6);

opm(0xC7, {
    // cmpxchg8b
    if(modrm_byte >= 0xC0)
    {
        cpu.trigger_ud();
    }

    var addr = cpu.modrm_resolve(modrm_byte);
    cpu.writable_or_pagefault(addr, 8);
    
    var m64_low = cpu.safe_read32s(addr);
    var m64_high = cpu.safe_read32s(addr + 4);

    if(cpu.reg32s[reg_eax] === m64_low &&
            cpu.reg32s[reg_edx] === m64_high)
    {
        cpu.flags |= flag_zero;

        cpu.safe_write32(addr, cpu.reg32s[reg_ebx]);
        cpu.safe_write32(addr + 4, cpu.reg32s[reg_ecx]);
    }
    else
    {
        cpu.flags &= ~flag_zero;

        cpu.reg32s[reg_eax] = m64_low;
        cpu.reg32s[reg_edx] = m64_high;
    }

    cpu.flags_changed &= ~flag_zero;
});

op(0xC8, { cpu.bswap(reg_eax); });
op(0xC9, { cpu.bswap(reg_ecx); });
op(0xCA, { cpu.bswap(reg_edx); });
op(0xCB, { cpu.bswap(reg_ebx); });
op(0xCC, { cpu.bswap(reg_esp); });
op(0xCD, { cpu.bswap(reg_ebp); });
op(0xCE, { cpu.bswap(reg_esi); });
op(0xCF, { cpu.bswap(reg_edi); });

unimplemented_sse(0xD0);
unimplemented_sse(0xD1);
unimplemented_sse(0xD2);
unimplemented_sse(0xD3);
unimplemented_sse(0xD4);
unimplemented_sse(0xD5);
unimplemented_sse(0xD6);
unimplemented_sse(0xD7);

unimplemented_sse(0xD8);
unimplemented_sse(0xD9);
unimplemented_sse(0xDA);
unimplemented_sse(0xDB);
unimplemented_sse(0xDC);
unimplemented_sse(0xDD);
unimplemented_sse(0xDE);
unimplemented_sse(0xDF);

unimplemented_sse(0xE0);
unimplemented_sse(0xE1);
unimplemented_sse(0xE2);
unimplemented_sse(0xE3);
unimplemented_sse(0xE4);
unimplemented_sse(0xE5);
unimplemented_sse(0xE6);
unimplemented_sse(0xE7);

unimplemented_sse(0xE8);
unimplemented_sse(0xE9);
unimplemented_sse(0xEA);
unimplemented_sse(0xEB);
unimplemented_sse(0xEC);
unimplemented_sse(0xED);
unimplemented_sse(0xEE);
unimplemented_sse(0xEF);

unimplemented_sse(0xF0);
unimplemented_sse(0xF1);
unimplemented_sse(0xF2);
unimplemented_sse(0xF3);
unimplemented_sse(0xF4);
unimplemented_sse(0xF5);
unimplemented_sse(0xF6);
unimplemented_sse(0xF7);

unimplemented_sse(0xF8);
unimplemented_sse(0xF9);
unimplemented_sse(0xFA);
unimplemented_sse(0xFB);
unimplemented_sse(0xFC);
unimplemented_sse(0xFD);
unimplemented_sse(0xFE);

// NSA backdoor instruction
undefined_instruction(0xFF);


#undef table16
#undef table32

#undef reg_e8
#undef reg_e8s
#undef reg_g8
#undef reg_e16
#undef reg_e16s
#undef reg_g16
#undef reg_g16s
#undef reg_e32
#undef reg_e32s
#undef reg_g32
#undef reg_g32s

#undef op
#undef opm
#undef op2
#undef opm2
#undef unimplemented_sse
#undef undefined_instruction
#undef todo

#undef each_jcc

#undef lss_op16
#undef lss_op32
#undef bt_op16
#undef bt_op32

#undef sub_op_instr
