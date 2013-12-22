"use strict";



var table16 = [], 
    table32 = [], 
    table0F_16 = [],
    table0F_32 = [];



#define do_op() table[read_imm8()]()

#define unimplemented_sse(num) op(num, {\
    dbg_log("No SSE", LOG_CPU);\
    trigger_ud();\
})

#define undefined_instruction(num) op(num, {\
    if(DEBUG) throw "Possible fault: undefined instruction"; \
    trigger_ud();\
})

#define todo_op(num) op(num, {\
    todo();\
})

#define todo()\
    if(DEBUG) { dbg_trace(); throw "TODO"; }\
    trigger_ud();


#define each_jcc(macro)\
    macro(0x0, (test_o()));\
    macro(0x1, (!test_o()));\
    macro(0x2, (test_b()));\
    macro(0x3, (!test_b()));\
    macro(0x4, (test_z()));\
    macro(0x5, (!test_z()));\
    macro(0x6, (test_be()));\
    macro(0x7, (!test_be()));\
    macro(0x8, (test_s()));\
    macro(0x9, (!test_s()));\
    macro(0xA, (test_p()));\
    macro(0xB, (!test_p()));\
    macro(0xC, (test_l()));\
    macro(0xD, (!test_l()));\
    macro(0xE, (test_le()));\
    macro(0xF, (!test_le()));

#define each_reg(macro)\
    macro(0, reg_ax, reg_eax)\
    macro(1, reg_cx, reg_ecx)\
    macro(2, reg_dx, reg_edx)\
    macro(3, reg_bx, reg_ebx)\
    macro(4, reg_sp, reg_esp)\
    macro(5, reg_bp, reg_ebp)\
    macro(6, reg_si, reg_esi)\
    macro(7, reg_di, reg_edi)

#define each_reg8(macro)\
    macro(0, reg_al)\
    macro(1, reg_cl)\
    macro(2, reg_dl)\
    macro(3, reg_bl)\
    macro(4, reg_ah)\
    macro(5, reg_ch)\
    macro(6, reg_dh)\
    macro(7, reg_bh)

// no cmp, because it uses different arguments
#define each_arith(macro)\
    macro(0, add)\
    macro(1,  or)\
    macro(2, adc)\
    macro(3, sbb)\
    macro(4, and)\
    macro(5, sub)\
    macro(6, xor)



#define safe_pop32s(dest) dest = pop32s();
#define safe_pop16(dest) dest = pop16();


// very special, should be somewhere else?
#define lss_op(sreg)\
    if(modrm_byte >= 0xC0) { raise_exception(6); return; }\
    if(operand_size_32) { lss32(sreg, modrm_resolve(modrm_byte), modrm_byte >> 3 & 7); }\
    else { lss16(sreg, modrm_resolve(modrm_byte), modrm_byte >> 2 & 14); }


#define bt_op(op, arg16, arg32)\
    if(operand_size_32) {\
        if(modrm_byte < 0xC0) {\
            op ## _mem(modrm_resolve(modrm_byte), arg32);\
        } else {\
            reg_e32 = op ## _reg(reg_e32s, arg32 & 31);\
        }\
    } else {\
        if(modrm_byte < 0xC0) {\
            op ## _mem(modrm_resolve(modrm_byte), arg16);\
        } else {\
            reg_e16 = op ## _reg(reg_e16, arg16 & 15);\
        }\
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

#define pop_sreg_op(n, reg)\
    op2(n, \
        { switch_seg(reg, memory.read16(get_esp_read(0))); stack_reg[reg_vsp] += 2; }, \
        { switch_seg(reg, memory.read16(get_esp_read(0))); stack_reg[reg_vsp] += 4; });


#define reg_e8 reg8[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]
#define reg_e8s reg8s[modrm_byte << 2 & 0xC | modrm_byte >> 2 & 1]
#define reg_g8 reg8[modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1]

#define reg_e16 reg16[modrm_byte << 1 & 14]
#define reg_e16s reg16s[modrm_byte << 1 & 14]
#define reg_g16 reg16[modrm_byte >> 2 & 14] 
#define reg_g16s reg16s[modrm_byte >> 2 & 14] 

#define reg_e32 reg32[modrm_byte & 7]
#define reg_e32s reg32s[modrm_byte & 7]
#define reg_g32 reg32[modrm_byte >> 3 & 7] 
#define reg_g32s reg32s[modrm_byte >> 3 & 7] 


#define modrm_read(size)\
    if(modrm_byte < 0xC0) {\
        var data = safe_read ## size(modrm_resolve(modrm_byte)); \
    } else {\
        data = reg_e ## size;\
    }


#define read_e8 modrm_read(8)
#define read_e8s modrm_read(8s)
#define read_e16 modrm_read(16)
#define read_e16s modrm_read(16s)
#define read_e32 modrm_read(32)
#define read_e32s modrm_read(32s)



// use modrm_byte to write a value to memory or register 
// (without reading it beforehand)
#define modrm_set(arg, size) \
    if(modrm_byte < 0xC0) {\
        safe_write ## size(modrm_resolve(modrm_byte), arg);\
    } else {\
        reg_e ## size = arg;\
    }

#define set_eb(arg) modrm_set(arg, 8)
#define set_ev16(arg) modrm_set(arg, 16)
#define set_ev32(arg) modrm_set(arg, 32)


// use modrm_byte to write a value to memory or register,
// using the previous data from memory or register.
// op is a function call that needs to return the result
#define write_e8(op)\
    var data;\
    var addr;\
    if(modrm_byte < 0xC0) {\
        addr = translate_address_write(modrm_resolve(modrm_byte));\
        data = memory.read8(addr);\
        memory.write8(addr, op);\
    } else {\
        data = reg_e8;\
        reg_e8 = op;\
    }


#define write_ev16(op)\
    var data;\
    var virt_addr;\
    var phys_addr;\
    var phys_addr_high;\
    if(modrm_byte < 0xC0) {\
        virt_addr = modrm_resolve(modrm_byte);\
        phys_addr = translate_address_write(virt_addr);\
        if(paging && (virt_addr & 0xFFF) === 0xFFF) {\
            phys_addr_high = translate_address_write(virt_addr + 1);\
            data = virt_boundary_read16(phys_addr, phys_addr_high);\
            virt_boundary_write16(phys_addr, phys_addr_high, op);\
        } else {\
            data = memory.read16(phys_addr);\
            memory.write16(phys_addr, op);\
        }\
    } else {\
        data = reg_e16;\
        reg_e16 = op;\
    }


#define write_ev32(op)\
    var data;\
    var virt_addr;\
    var phys_addr;\
    var phys_addr_high;\
    if(modrm_byte < 0xC0) {\
        virt_addr = modrm_resolve(modrm_byte);\
        phys_addr = translate_address_write(virt_addr);\
        if(paging && (virt_addr & 0xFFF) >= 0xFFD) {\
            phys_addr_high = translate_address_write(virt_addr + 3);\
            data = virt_boundary_read32s(phys_addr, phys_addr_high) >>> 0;\
            virt_boundary_write32(phys_addr, phys_addr_high, op);\
        } else {\
            data = memory.read32s(phys_addr) >>> 0;\
            memory.write32(phys_addr, op);\
        }\
    } else {\
        data = reg_e32;\
        reg_e32s = op;\
    }



#define write_ev32s(op)\
    var data;\
    var virt_addr;\
    var phys_addr;\
    var phys_addr_high;\
    if(modrm_byte < 0xC0) {\
        virt_addr = modrm_resolve(modrm_byte);\
        phys_addr = translate_address_write(virt_addr);\
        if(paging && (virt_addr & 0xFFF) >= 0xFFD) {\
            phys_addr_high = translate_address_write(virt_addr + 3);\
            data = virt_boundary_read32s(phys_addr, phys_addr_high);\
            virt_boundary_write32(phys_addr, phys_addr_high, op);\
        } else {\
            data = memory.read32s(phys_addr);\
            memory.write32(phys_addr, op);\
        }\
    } else {\
        data = reg_e32s;\
        reg_e32s = op;\
    }


#define op(n, code) table16[n] = table32[n] = function() { code };

// opcode with modrm byte
#define opm(n, code)\
    table16[n] = table32[n] = function() { var modrm_byte = read_imm8(); code };

// opcode that has a 16 and a 32 bit version
#define op2(n, code16, code32)\
    table16[n] = function() { code16 };\
    table32[n] = function() { code32 };\

#define opm2(n, code16, code32)\
    table16[n] = function() { var modrm_byte = read_imm8(); code16 };\
    table32[n] = function() { var modrm_byte = read_imm8(); code32 };\


#define arith_group(n, instr, sign)\
    opm(n, { write_e8(instr ## 8(data, reg_g8)) })\
    opm2(n | 1, { write_ev16(instr ## 16(data, reg_g16)) }, { write_ev32 ## sign(instr ## 32(data, reg_g32 ## sign)) })\
    opm(n | 2, { read_e8; reg_g8 = instr ## 8(reg_g8, data); })\
    opm2(n | 3, { read_e16; reg_g16 = instr ## 16(reg_g16, data); }, { read_e32 ## sign; reg_g32s = instr ## 32(reg_g32 ## sign, data); })\
    op(n | 4, { reg8[reg_al] = instr ## 8(reg8[reg_al], read_imm8()); })\
    op2(n | 5, { reg16[reg_ax] = instr ## 16(reg16[reg_ax], read_imm16()); }, { reg32[reg_eax] = instr ## 32(reg32 ## sign[reg_eax], read_imm32 ## sign()); })\
    


// instructions start here

arith_group(0x00, add, );

op2(0x06, { push16(sreg[reg_es]); }, { push32(sreg[reg_es]); });
pop_sreg_op(0x07, reg_es);
//op2(0x07, 
//    { safe_pop16(sreg[reg_es]); switch_seg(reg_es, memory.read16(get_esp_read(0))); }, 
//    { safe_pop32s(sreg[reg_es]); switch_seg(reg_es); });

arith_group(0x08, or, s);

op2(0x0E, { push16(sreg[reg_cs]); }, { push32(sreg[reg_cs]); });
op(0x0F, { table0F[read_imm8()](); });

arith_group(0x10, adc, );

op2(0x16, { push16(sreg[reg_ss]); }, { push32(sreg[reg_ss]); });
pop_sreg_op(0x17, reg_ss);
//op2(0x17, 
//    { safe_pop16(sreg[reg_ss]); switch_seg(reg_ss); }, 
//    { safe_pop32s(sreg[reg_ss]); switch_seg(reg_ss); });

arith_group(0x18, sbb, );

op2(0x1E, { push16(sreg[reg_ds]); }, { push32(sreg[reg_ds]); });
pop_sreg_op(0x1F, reg_ds);
//op2(0x1F, 
//    { safe_pop16(sreg[reg_ds]); switch_seg(reg_ds); }, 
//    { safe_pop32s(sreg[reg_ds]); switch_seg(reg_ds); });

arith_group(0x20, and, s);

op(0x26, { seg_prefix(reg_es); });
op(0x27, { bcd_daa(); });

arith_group(0x28, sub, );

op(0x2E, { seg_prefix(reg_cs); });
op(0x2F, { bcd_das(); });

arith_group(0x30, xor, s);

op(0x36, { seg_prefix(reg_ss); });
op(0x37, { bcd_aaa(); });

opm(0x38, { read_e8; cmp8(data, reg_g8); })
opm2(0x39, { read_e16; cmp16(data, reg_g16); }, { read_e32; cmp32(data, reg_g32); })
opm(0x3A, { read_e8; cmp8(reg_g8, data); })
opm2(0x3B, { read_e16; cmp16(reg_g16, data); }, { read_e32; cmp32(reg_g32, data); })
op(0x3C, { cmp8(reg8[reg_al], read_imm8()); })
op2(0x3D, { cmp16(reg16[reg_ax], read_imm16()); }, { cmp32(reg32[reg_eax], read_imm32()); })

op(0x3E, { seg_prefix(reg_ds); });
op(0x3F, { bcd_aas(); });


#define group40(n, r16, r32)\
    op2(0x40 | n, { reg16[r16] = inc16(reg16[r16]); }, { reg32[r32] = inc32(reg32[r32]); });
each_reg(group40);


#define group48(n, r16, r32)\
    op2(0x48 | n, { reg16[r16] = dec16(reg16[r16]); }, { reg32[r32] = dec32(reg32[r32]); });
each_reg(group48);


#define group50(n, r16, r32)\
    op2(0x50 | n, { push16(reg16[r16]); }, { push32(reg32s[r32]); })
each_reg(group50);

#define group58(n, r16, r32)\
    op2(0x58 | n, { safe_pop16(reg16[r16]); }, { safe_pop32s(reg32[r32]); })
each_reg(group58);


op2(0x60, { pusha16(); }, { pusha32(); });
op2(0x61, { popa16(); }, { popa32(); });

op(0x62, { throw unimpl("bound instruction"); });
opm(0x63, { 
    // arpl
    write_ev16(arpl(data, modrm_byte >> 2 & 14));
});

op(0x64, { seg_prefix(reg_fs); });
op(0x65, { seg_prefix(reg_gs); });

op(0x66, {
    // Operand-size override prefix
    dbg_assert(operand_size_32 === is_32);

    operand_size_32 = !is_32;
    update_operand_size();

    do_op();

    operand_size_32 = is_32;
    update_operand_size();
});

op(0x67, {
    // Address-size override prefix
    dbg_assert(address_size_32 === is_32);

    address_size_32 = !is_32;
    update_address_size();

    do_op();

    address_size_32 = is_32;
    update_address_size();
});

op2(0x68, { push16(read_imm16()); }, { push32(read_imm32s()); });

opm2(0x69, {
    read_e16s;
    reg_g16 = imul_reg16(read_imm16s(), data);
}, {
    read_e32s;
    reg_g32 = imul_reg32(read_imm32s(), data);
});

op2(0x6A, { push16(read_imm8s()); }, { push32(read_imm8s()); });

opm2(0x6B, {
    read_e16s;
    reg_g16 = imul_reg16(read_imm8s(), data);
}, {
    read_e32s;
    reg_g32 = imul_reg32(read_imm8s(), data);
});

op(0x6C, { insb(); });
op2(0x6D, { insw(); }, { insd(); });
op(0x6E, { outsb(); });
op2(0x6F, { outsw(); }, { outsd(); });


#define group70(n, test) \
    op(0x70 | n, { \
        if(test) { \
            instruction_pointer = instruction_pointer + read_imm8s() | 0;\
        }\
        instruction_pointer++;\
    });

each_jcc(group70);


opm(0x80, { 
    sub_op(
        { write_e8(add8(data, read_imm8())); },
        { write_e8( or8(data, read_imm8())); },
        { write_e8(adc8(data, read_imm8())); },
        { write_e8(sbb8(data, read_imm8())); },
        { write_e8(and8(data, read_imm8())); },
        { write_e8(sub8(data, read_imm8())); },
        { write_e8(xor8(data, read_imm8())); },
        { read_e8; cmp8(data, read_imm8()); }
    )
});
opm2(0x81, {
    sub_op(
        { write_ev16(add16(data, read_imm16())); },
        { write_ev16( or16(data, read_imm16())); },
        { write_ev16(adc16(data, read_imm16())); },
        { write_ev16(sbb16(data, read_imm16())); },
        { write_ev16(and16(data, read_imm16())); },
        { write_ev16(sub16(data, read_imm16())); },
        { write_ev16(xor16(data, read_imm16())); },
        { read_e16;  cmp16(data, read_imm16()); }
    )
}, {
    sub_op(
        { write_ev32(add32(data, read_imm32())); },
        { write_ev32s( or32(data, read_imm32s())); },
        { write_ev32(adc32(data, read_imm32())); },
        { write_ev32(sbb32(data, read_imm32())); },
        { write_ev32s(and32(data, read_imm32s())); },
        { write_ev32(sub32(data, read_imm32())); },
        { write_ev32s(xor32(data, read_imm32s())); },
        { read_e32;  cmp32(data, read_imm32()); }
    )
});
op(0x82, { 
    table[0x80](); // alias
});
opm2(0x83, {
    sub_op(
        { write_ev16(add16(data, read_imm8s() & 0xFFFF)); },
        { write_ev16( or16(data, read_imm8s())); },
        { write_ev16(adc16(data, read_imm8s() & 0xFFFF)); },
        { write_ev16(sbb16(data, read_imm8s() & 0xFFFF)); },
        { write_ev16(and16(data, read_imm8s())); },
        { write_ev16(sub16(data, read_imm8s() & 0xFFFF)); },
        { write_ev16(xor16(data, read_imm8s())); },
        { read_e16;  cmp16(data, read_imm8s() & 0xFFFF); }
    )
}, {
    sub_op(
        { write_ev32(add32(data, read_imm8s() >>> 0)); },
        { write_ev32s( or32(data, read_imm8s())); },
        { write_ev32(adc32(data, read_imm8s() >>> 0)); },
        { write_ev32(sbb32(data, read_imm8s() >>> 0)); },
        { write_ev32s(and32(data, read_imm8s())); },
        { write_ev32(sub32(data, read_imm8s() >>> 0)); },
        { write_ev32s(xor32(data, read_imm8s())); },
        { read_e32;  cmp32(data, read_imm8s() >>> 0); }
    )
});

opm(0x84, { read_e8; test8(data, reg_g8); })
opm2(0x85, { read_e16; test16(data, reg_g16); }, { read_e32s; test32(data, reg_g32s); })


opm(0x86, { write_e8(xchg8(data, modrm_byte)); });
opm2(0x87, { 
    write_ev16(xchg16(data, modrm_byte)); 
}, {
    write_ev32(xchg32(data, modrm_byte)); 
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

opm2(0x8C, { set_ev16(sreg[modrm_byte >> 3 & 7]); }, { set_ev32(sreg[modrm_byte >> 3 & 7]); })

op2(0x8D, { lea16(); }, { lea32(); });

opm(0x8E, {
    var mod = modrm_byte >> 3 & 7;

    read_e16;

    switch_seg(mod, data);

    if(mod === reg_ss)
    {
        // TODO
        // run next instruction, so no irqs are handled
    }
});

opm(0x8F, {
    // pop
    if(operand_size_32)
    {
        // change esp first, then resolve modrm address
        var sp = get_esp_read(0);
        // TODO unsafe

        stack_reg[reg_vsp] += 4;
        set_ev32(memory.read32s(sp));
    }
    else
    {
        var sp = get_esp_read(0);

        stack_reg[reg_vsp] += 2;
        set_ev16(memory.read16(sp));
    }
});

#define group90(n, r16, r32) op2(0x90 | n, { xchg16r(r16) }, { xchg32r(r32) })
each_reg(group90)

op(0x90,  /* nop */ );


op2(0x98, 
    { /* cbw */ reg16[reg_ax] = reg8s[reg_al]; },
    { /* cwde */ reg32[reg_eax] = reg16s[reg_ax]; });

op2(0x99, 
    { /* cwd */ reg16[reg_dx] = reg16s[reg_ax] >> 15; },
    { /* cdq */ reg32[reg_edx] = reg32s[reg_eax] >> 31; });
    
op2(0x9A, {
    // callf

    var new_ip = read_imm16();
    var new_cs = read_imm16();

    push16(sreg[reg_cs]);
    push16(get_real_ip());

    switch_seg(reg_cs, new_cs);
    instruction_pointer = get_seg(reg_cs) + new_ip | 0;
}, {
    var new_ip = read_imm32s();
    var new_cs = read_imm16();

    push32(sreg[reg_cs]);
    push32(get_real_ip());

    switch_seg(reg_cs, new_cs);
    instruction_pointer = get_seg(reg_cs) + new_ip | 0;
});

op(0x9B, {
    // fwait: check for pending fpu exceptions
    fpu.fwait();
});
op2(0x9C, {
    // pushf
    if((flags & flag_vm) && getiopl() < 3)
    {
        trigger_gp(0);
    }
    else
    {
        load_flags();
        push16(flags);
    }
}, {
    // pushf
    if((flags & flag_vm) && getiopl() < 3)
    {
        // trap to virtual 8086 monitor
        trigger_gp(0);
    }
    else
    {
        load_flags();
        // vm and rf flag are cleared in image stored on the stack
        push32(flags & ~flag_vm & ~flag_rf);
    }
});
op2(0x9D, {
    // popf
    var tmp;
    safe_pop16(tmp);
    update_flags((flags & 0xFFFF0000) | tmp);

    handle_irqs();
}, {
    // popf
    update_flags(pop32s());

    handle_irqs();
});
op(0x9E, {
    // sahf
    flags = (flags & ~0xFF) | reg8[reg_ah];
    flags = (flags & flags_mask) | flags_default;
    flags_changed = 0;
});
op(0x9F, {
    // lahf
    load_flags();
    reg8[reg_ah] = flags;
});

op(0xA0, {
    // mov
    var data = safe_read8(read_moffs());
    reg8[reg_al] = data;
});
op2(0xA1, {
    // mov
    var data = safe_read16(read_moffs());
    reg16[reg_ax] = data;
}, {
    var data = safe_read32s(read_moffs());
    reg32[reg_eax] = data;
});
op(0xA2, {
    // mov
    safe_write8(read_moffs(), reg8[reg_al]);
});
op2(0xA3, {
    // mov
    safe_write16(read_moffs(), reg16[reg_ax]);
}, {
    safe_write32(read_moffs(), reg32s[reg_eax]);
});

op(0xA4, { movsb(); });
op2(0xA5, { movsw(); }, { movsd(); });
op(0xA6, { cmpsb(); });
op2(0xA7, { cmpsw(); }, { cmpsd(); });

op(0xA8, {
    test8(reg8[reg_al], read_imm8());
});
op2(0xA9, {
    test16(reg16[reg_ax], read_imm16());
}, {
    test32(reg32s[reg_eax], read_imm32s());
});

op(0xAA, { stosb(); });
op2(0xAB, { stosw(); }, { stosd(); });
op(0xAC, { lodsb(); });
op2(0xAD, { lodsw(); }, { lodsd(); });
op(0xAE, { scasb(); });
op2(0xAF, { scasw(); }, { scasd(); });


#define groupB0(n, r8) op(0xB0 | n, { reg8[r8] = read_imm8(); });
each_reg8(groupB0);


#define groupB8(n, r16, r32)\
    op2(0xB8 | n, { reg16[r16] = read_imm16(); }, { reg32s[r32] = read_imm32s(); });
each_reg(groupB8);


opm(0xC0, { 
    sub_op(
        { write_e8(rol8(data, read_imm8() & 31)); },
        { write_e8(ror8(data, read_imm8() & 31)); },
        { write_e8(rcl8(data, read_imm8() & 31)); },
        { write_e8(rcr8(data, read_imm8() & 31)); },
        { write_e8(shl8(data, read_imm8() & 31)); },
        { write_e8(shr8(data, read_imm8() & 31)); },
        { write_e8(shl8(data, read_imm8() & 31)); },
        { write_e8(sar8(data, read_imm8() & 31)); }
    )
});
opm2(0xC1, { 
    sub_op(
        { write_ev16(rol16(data, read_imm8() & 31)); },
        { write_ev16(ror16(data, read_imm8() & 31)); },
        { write_ev16(rcl16(data, read_imm8() & 31)); },
        { write_ev16(rcr16(data, read_imm8() & 31)); },
        { write_ev16(shl16(data, read_imm8() & 31)); },
        { write_ev16(shr16(data, read_imm8() & 31)); },
        { write_ev16(shl16(data, read_imm8() & 31)); },
        { write_ev16(sar16(data, read_imm8() & 31)); }
    )
}, {
    sub_op(
        { write_ev32(rol32(data, read_imm8() & 31)); },
        { write_ev32(ror32(data, read_imm8() & 31)); },
        { write_ev32(rcl32(data, read_imm8() & 31)); },
        { write_ev32(rcr32(data, read_imm8() & 31)); },
        { write_ev32(shl32(data, read_imm8() & 31)); },
        { write_ev32(shr32(data, read_imm8() & 31)); },
        { write_ev32(shl32(data, read_imm8() & 31)); },
        { write_ev32(sar32(data, read_imm8() & 31)); }
    )
});

op2(0xC2, {
    // retn
    var imm16 = read_imm16();

    instruction_pointer = get_seg(reg_cs) + pop16() | 0;
    // TODO regv
    reg32[reg_esp] += imm16;
}, {
    // retn
    var imm16 = read_imm16();

    instruction_pointer = get_seg(reg_cs) + pop32s() | 0;
    reg32[reg_esp] += imm16;
});
op2(0xC3, {
    // retn
    instruction_pointer = get_seg(reg_cs) + pop16() | 0;;
}, {
    // retn
    instruction_pointer = get_seg(reg_cs) + pop32s() | 0;;
});

opm(0xC4, {
    lss_op(reg_es);
});
opm(0xC5, {
    lss_op(reg_ds);
});

opm(0xC6, { set_eb(read_imm8()); })
opm2(0xC7, { set_ev16(read_imm16()); }, { set_ev32(read_imm32s()); })

op2(0xC8, { enter16(); }, { enter32(); });
op2(0xC9, {
    // leave
    stack_reg[reg_vsp] = stack_reg[reg_vbp];
    reg16[reg_bp] = pop16();
}, {
    stack_reg[reg_vsp] = stack_reg[reg_vbp];
    reg32[reg_ebp] = pop32s();
});
op2(0xCA, {
    // retf
    var imm16 = read_imm16();
    var ip = pop16();

    switch_seg(reg_cs, pop16());
    instruction_pointer = get_seg(reg_cs) + ip | 0;
    reg16[reg_sp] += imm16;
}, {
    // retf 
    var imm16 = read_imm16();
    var ip = pop32s();

    switch_seg(reg_cs, pop32s() & 0xFFFF);
    instruction_pointer = get_seg(reg_cs) + ip | 0;

    stack_reg[reg_vsp] += imm16;
});
op2(0xCB, {
    // retf
    var ip = pop16();
    switch_seg(reg_cs, pop16());
    instruction_pointer = get_seg(reg_cs) + ip | 0;
}, {
    // retf 

    var ip = pop32s();

    switch_seg(reg_cs, pop32s() & 0xFFFF);
    instruction_pointer = get_seg(reg_cs) + ip | 0;
});

op(0xCC, {
    // INT3
    call_interrupt_vector(3, true, false);
});
op(0xCD, {
    // INT 
    var imm8 = read_imm8();

    call_interrupt_vector(imm8, true, false);
});
op(0xCE, {
    // INTO
    if(getof())
    {
        call_interrupt_vector(4, true, false);
    }
});

op2(0xCF, {
    // iret
    if(!protected_mode || (vm86_mode && getiopl() === 3))
    {
        var ip = pop16();

        switch_seg(reg_cs, pop16());
        var new_flags = pop16();

        instruction_pointer = ip + get_seg(reg_cs) | 0;
        update_flags(new_flags);

        handle_irqs();
    } 
    else
    {
        if(vm86_mode) 
        {
            // vm86 mode, iopl != 3
            trigger_gp(0);
        }

        throw unimpl("16 bit iret in protected mode");
    }
}, {
    // iret
    if(!protected_mode || (vm86_mode && getiopl() === 3))
    {
        if(vm86_mode) dbg_log("iret in vm86 mode  iopl=3", LOG_CPU);

        var ip = pop32s();

        switch_seg(reg_cs, pop32s() & 0xFFFF);
        var new_flags = pop32s();

        instruction_pointer = ip + get_seg(reg_cs) | 0;
        update_flags(new_flags);

        handle_irqs();
        return;
    }

    if(vm86_mode) 
    {
        // vm86 mode, iopl != 3
        trigger_gp(0);
    }

    if(flags & flag_nt)
    {
        if(DEBUG) throw "unimplemented nt";
    }

    //dbg_log("pop eip from " + h(reg32[reg_esp], 8));
    instruction_pointer = pop32s();
    //dbg_log("IRET | from " + h(previous_ip) + " to " + h(instruction_pointer));

    sreg[reg_cs] = pop32s();

    //instruction_pointer += get_seg(reg_cs);

    var new_flags = pop32s();

    if(new_flags & flag_vm)
    {
        if(cpl === 0)
        {
            // return to virtual 8086 mode

            update_flags(new_flags);
            flags |= flag_vm;

            dbg_log("in vm86 mode now " + 
                    " cs:eip=" + h(sreg[reg_cs]) + ":" + h(instruction_pointer >>> 0) +
                    " iopl=" + getiopl(), LOG_CPU);

            switch_seg(reg_cs, sreg[reg_cs]);
            instruction_pointer = instruction_pointer + get_seg(reg_cs) | 0;

            var temp_esp = pop32s();
            var temp_ss = pop32s();

            switch_seg(reg_es, pop32s() & 0xFFFF);
            switch_seg(reg_ds, pop32s() & 0xFFFF);
            switch_seg(reg_fs, pop32s() & 0xFFFF);
            switch_seg(reg_gs, pop32s() & 0xFFFF);

            reg32[reg_esp] = temp_esp;
            switch_seg(reg_ss, temp_ss & 0xFFFF);

            cpl = 3;

            is_32 = operand_size_32 = address_size_32 = false;
            update_operand_size();
            update_address_size();

            return;
        }
        else
        {
            // ignored if not cpl=0
            new_flags &= ~flag_vm;
        }
    }

    // protected mode return

    var info = lookup_segment_selector(sreg[reg_cs]);

    if(info.is_null)
    {
        throw unimpl("is null");
    }
    if(!info.is_present)
    {
        throw unimpl("not present");
    }
    if(!info.is_executable)
    {
        throw unimpl("not exec");
    }
    if(info.rpl < cpl)
    {
        throw unimpl("rpl < cpl");
    }
    if(info.dc_bit && info.dpl > info.rpl)
    {
        throw unimpl("conforming and dpl > rpl");
    }

    if(info.rpl > cpl)
    {
        // outer privilege return
        var temp_esp = pop32s();
        var temp_ss = pop32s();


        reg32[reg_esp] = temp_esp;

        update_flags(new_flags);

        cpl = info.rpl;
        switch_seg(reg_ss, temp_ss & 0xFFFF);

        //dbg_log("iret cpl=" + cpl + " to " + h(instruction_pointer) + 
        //        " cs:eip=" + h(sreg[reg_cs],4) + ":" + h(get_real_ip(), 8) +
        //        " ss:esp=" + h(temp_ss & 0xFFFF, 2) + ":" + h(temp_esp, 8), LOG_CPU);

        cpl_changed();
    }
    else
    {
        update_flags(new_flags);
        // same privilege return

        //dbg_log(h(new_flags) + " " + h(flags));
        //dbg_log("iret to " + h(instruction_pointer));
    }

    //dbg_log("iret if=" + (flags & flag_interrupt) + " cpl=" + cpl);
    dbg_assert(!page_fault);

    handle_irqs();

});

opm(0xD0, { 
    sub_op(
        { write_e8(rol8(data, 1)); },
        { write_e8(ror8(data, 1)); },
        { write_e8(rcl8(data, 1)); },
        { write_e8(rcr8(data, 1)); },
        { write_e8(shl8(data, 1)); },
        { write_e8(shr8(data, 1)); },
        { write_e8(shl8(data, 1)); },
        { write_e8(sar8(data, 1)); }
    )
});
opm2(0xD1, { 
    sub_op(
        { write_ev16(rol16(data, 1)); },
        { write_ev16(ror16(data, 1)); },
        { write_ev16(rcl16(data, 1)); },
        { write_ev16(rcr16(data, 1)); },
        { write_ev16(shl16(data, 1)); },
        { write_ev16(shr16(data, 1)); },
        { write_ev16(shl16(data, 1)); },
        { write_ev16(sar16(data, 1)); }
    )
}, {
    sub_op(
        { write_ev32(rol32(data, 1)); },
        { write_ev32(ror32(data, 1)); },
        { write_ev32(rcl32(data, 1)); },
        { write_ev32(rcr32(data, 1)); },
        { write_ev32(shl32(data, 1)); },
        { write_ev32(shr32(data, 1)); },
        { write_ev32(shl32(data, 1)); },
        { write_ev32(sar32(data, 1)); }
    )
});

opm(0xD2, { 
    var shift = reg8[reg_cl] & 31;
    sub_op(
        { write_e8(rol8(data, shift)); },
        { write_e8(ror8(data, shift)); },
        { write_e8(rcl8(data, shift)); },
        { write_e8(rcr8(data, shift)); },
        { write_e8(shl8(data, shift)); },
        { write_e8(shr8(data, shift)); },
        { write_e8(shl8(data, shift)); },
        { write_e8(sar8(data, shift)); }
    )
});
opm2(0xD3, { 
    var shift = reg8[reg_cl] & 31;
    sub_op(
        { write_ev16(rol16(data, shift)); },
        { write_ev16(ror16(data, shift)); },
        { write_ev16(rcl16(data, shift)); },
        { write_ev16(rcr16(data, shift)); },
        { write_ev16(shl16(data, shift)); },
        { write_ev16(shr16(data, shift)); },
        { write_ev16(shl16(data, shift)); },
        { write_ev16(sar16(data, shift)); }
    )
}, {
    var shift = reg8[reg_cl] & 31;
    sub_op(
        { write_ev32(rol32(data, shift)); },
        { write_ev32(ror32(data, shift)); },
        { write_ev32(rcl32(data, shift)); },
        { write_ev32(rcr32(data, shift)); },
        { write_ev32(shl32(data, shift)); },
        { write_ev32(shr32(data, shift)); },
        { write_ev32(shl32(data, shift)); },
        { write_ev32(sar32(data, shift)); }
    )
});

op(0xD4, {
    bcd_aam();
});
op(0xD5, {
    bcd_aad();
});

op(0xD6, {
    // salc
    throw unimpl("salc instruction");
});
op(0xD7, {
    // xlat
    if(address_size_32)
    {
        reg8[reg_al] = safe_read8(get_seg_prefix(reg_ds) + reg32s[reg_ebx] + reg8[reg_al]);
    }
    else
    {
        reg8[reg_al] = safe_read8(get_seg_prefix(reg_ds) + reg16[reg_bx] + reg8[reg_al]);
    }
});


// fpu instructions
#define fpu_op(n, op)\
    opm(n, { \
        if(modrm_byte < 0xC0)\
            fpu.op_ ## op ## _mem(modrm_byte, modrm_resolve(modrm_byte));\
        else\
            fpu.op_ ## op ## _reg(modrm_byte);\
    })

fpu_op(0xD8, D8);
fpu_op(0xD9, D9);
fpu_op(0xDA, DA);
fpu_op(0xDB, DB);
fpu_op(0xDC, DC);
fpu_op(0xDD, DD);
fpu_op(0xDE, DE);
fpu_op(0xDF, DF);


op(0xE0, { loopne(); });
op(0xE1, { loope(); });
op(0xE2, { loop(); });
op(0xE3, { jcxz(); });

op(0xE4, { 
    var port = read_imm8();
    test_privileges_for_io(port, 1);
    reg8[reg_al] = io.port_read8(port); 
});
op2(0xE5, { 
    var port = read_imm8();
    test_privileges_for_io(port, 2);
    reg16[reg_ax] = io.port_read16(port); 
}, { 
    var port = read_imm8();
    test_privileges_for_io(port, 4);
    reg32[reg_eax] = io.port_read32(port); 
});
op(0xE6, { 
    var port = read_imm8();
    test_privileges_for_io(port, 1);
    io.port_write8(port, reg8[reg_al]); 
});
op2(0xE7, { 
    var port = read_imm8();
    test_privileges_for_io(port, 2);
    io.port_write16(port, reg16[reg_ax]); 
}, { 
    var port = read_imm8();
    test_privileges_for_io(port, 4);
    io.port_write32(port, reg32s[reg_eax]); 
});

op2(0xE8, {
    // call
    var imm16s = read_imm16s();
    push16(get_real_ip());

    jmp_rel16(imm16s);
}, {
    // call
    var imm32s = read_imm32s();
    push32(get_real_ip());

    instruction_pointer = instruction_pointer + imm32s | 0;
});
op2(0xE9, {
    // jmp
    var imm16s = read_imm16s();
    jmp_rel16(imm16s);
}, {
    // jmp
    var imm32s = read_imm32s();
    instruction_pointer = instruction_pointer + imm32s | 0;
});
op2(0xEA, {
    // jmpf
    var ip = read_imm16();
    switch_seg(reg_cs, read_imm16());

    instruction_pointer = ip + get_seg(reg_cs) | 0;
}, {
    // jmpf
    var ip = read_imm32s();
    switch_seg(reg_cs, read_imm16());

    instruction_pointer = ip + get_seg(reg_cs) | 0;
});
op(0xEB, {
    // jmp near
    var imm8 = read_imm8s();
    instruction_pointer = instruction_pointer + imm8 | 0;
});

op(0xEC, { 
    var port = reg16[reg_dx];
    test_privileges_for_io(port, 1);
    reg8[reg_al] = io.port_read8(port); 
});
op2(0xED, { 
    var port = reg16[reg_dx];
    test_privileges_for_io(port, 2);
    reg16[reg_ax] = io.port_read16(port); 
}, { 
    var port = reg16[reg_dx];
    test_privileges_for_io(port, 4);
    reg32[reg_eax] = io.port_read32(port); 
});
op(0xEE, { 
    var port = reg16[reg_dx];
    test_privileges_for_io(port, 1);
    io.port_write8(port, reg8[reg_al]); 
});
op2(0xEF, { 
    var port = reg16[reg_dx];
    test_privileges_for_io(port, 2);
    io.port_write16(port, reg16[reg_ax]); 
}, { 
    var port = reg16[reg_dx];
    test_privileges_for_io(port, 4);
    io.port_write32(port, reg32s[reg_eax]); 
});

op(0xF0, {
    // lock

    // TODO
    // This triggers UD when used with
    // some instructions that don't write to memory
});
op(0xF1, {
    // INT1
    // https://code.google.com/p/corkami/wiki/x86oddities#IceBP
    throw unimpl("int1 instruction");
});

op(0xF2, {
    // repnz
    dbg_assert(!repeat_string_prefix);
    repeat_string_prefix = true;
    repeat_string_type = false;
    do_op();
    repeat_string_prefix = false;
});
op(0xF3, {
    // repz
    dbg_assert(!repeat_string_prefix);
    repeat_string_prefix = true;
    repeat_string_type = true;
    do_op();
    repeat_string_prefix = false;
});

op(0xF4, {
    if(cpl)
    {
        trigger_gp(0);
    }

    // hlt
    if((flags & flag_interrupt) === 0)
    {
        log("cpu halted");
        stopped = true;
        if(DEBUG) dump_regs();
        throw "HALT";
    }
    else
    {
        // infinite loop until an irq happens
        // this is handled in call_interrupt_vector
        instruction_pointer--;
        in_hlt = true;
    }
});

op(0xF5, {
    // cmc
    flags = (flags | 1) ^ getcf();
    flags_changed &= ~1;
});

opm(0xF6, {
    sub_op(
        { read_e8; test8(data, read_imm8()); },
        { read_e8; test8(data, read_imm8()); },
        { write_e8(not8(data)); },
        { write_e8(neg8(data)); },
        { read_e8; mul8(data); },
        { read_e8s; imul8(data); },
        { read_e8; div8(data); },
        { read_e8s; idiv8(data); }
    )
});

opm2(0xF7, {
    sub_op (
        { read_e16; test16(data, read_imm16()); },
        { read_e16; test16(data, read_imm16()); },
        { write_ev16(not16(data)); },
        { write_ev16(neg16(data)); },
        { read_e16; mul16(data); },
        { read_e16s; imul16(data); },
        { read_e16; div16(data); },
        { read_e16s; idiv16(data); }
    )
}, {
    sub_op (
        { read_e32s; test32(data, read_imm32s()); },
        { read_e32s; test32(data, read_imm32s()); },
        { write_ev32(not32(data)); },
        { write_ev32(neg32(data)); },
        { read_e32; mul32(data); },
        { read_e32s; imul32(data); },
        { read_e32; div32(data); },
        { read_e32s; idiv32(data); }
    )
});

op(0xF8, {
    // clc
    flags &= ~flag_carry;
    flags_changed &= ~1;
});
op(0xF9, {
    // stc
    flags |= flag_carry;
    flags_changed &= ~1;
});

op(0xFA, {
    // cli
    //dbg_log("interrupts off");

    if(!protected_mode || (vm86_mode ? 
            getiopl() === 3 : getiopl() >= cpl))
    {
        flags &= ~flag_interrupt;
    }
    else
    {
        trigger_gp(0);
    }
});
op(0xFB, {
    // sti
    //dbg_log("interrupts on");

    if(!protected_mode || (vm86_mode ? 
            getiopl() === 3 : getiopl() >= cpl))
    {
        flags |= flag_interrupt;
        handle_irqs();
    }
    else
    {
        trigger_gp(0);
    }

});

op(0xFC, {
    // cld
    flags &= ~flag_direction;
});
op(0xFD, {
    // std
    flags |= flag_direction;
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
            push16(get_real_ip());
            
            instruction_pointer = get_seg(reg_cs) + data | 0;
        },
        {
            // 3, callf
            if(modrm_byte >= 0xC0)
            {
                raise_exception(6);
                dbg_assert(false);
            }

            var virt_addr = modrm_resolve(modrm_byte);

            push16(sreg[reg_cs]);
            push16(get_real_ip());

            switch_seg(reg_cs, safe_read16(virt_addr + 2));
            instruction_pointer = get_seg(reg_cs) + safe_read16(virt_addr) | 0;
            dbg_assert(!page_fault);
        },
        {
            // 4, jmp near
            read_e16;
            instruction_pointer = get_seg(reg_cs) + data | 0;
        },
        {
            // 5, jmpf
            if(modrm_byte >= 0xC0)
            {
                raise_exception(6);
                dbg_assert(false);
            }

            var virt_addr = modrm_resolve(modrm_byte);

            switch_seg(reg_cs, safe_read16(virt_addr + 2));
            instruction_pointer = get_seg(reg_cs) + safe_read16(virt_addr) | 0;

            // TODO safe read
        },
        {
            // 6, push
            read_e16;
            push16(data);
        },
        {
            todo();
        }
    )
}, {
    sub_op(

        { write_ev32(inc32(data)); },
        { write_ev32(dec32(data)); },
        { 
            // 2, call near
            read_e32s;
            push32(get_real_ip());

            instruction_pointer = get_seg(reg_cs) + data | 0;
        },
        {
            // 3, callf
            if(modrm_byte >= 0xC0)
            {
                raise_exception(6);
                dbg_assert(false);
            }

            var virt_addr = modrm_resolve(modrm_byte);
            var new_cs = safe_read16(virt_addr + 4);
            var new_ip = safe_read32s(virt_addr);


            push32(sreg[reg_cs]);
            push32(get_real_ip());

            switch_seg(reg_cs, new_cs);
            instruction_pointer = get_seg(reg_cs) + new_ip | 0;
        },
        {
            // 4, jmp near
            read_e32s;
            instruction_pointer = get_seg(reg_cs) + data | 0;
        },
        {
            // 5, jmpf
            if(modrm_byte >= 0xC0)
            {
                raise_exception(6);
                dbg_assert(false);
            }

            var virt_addr = modrm_resolve(modrm_byte);
            var new_cs = safe_read16(virt_addr + 4);
            var new_ip = safe_read32s(virt_addr);

            switch_seg(reg_cs, new_cs);
            instruction_pointer = get_seg(reg_cs) + new_ip | 0;
        },
        {
            // push
            read_e32s;
            push32(data);
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
    read_e16;

    if(!protected_mode)
    {
        // No GP, UD is correct here
        trigger_ud();
    }

    if(cpl)
    {
        trigger_gp(0);
    }

    switch(modrm_byte >> 3 & 7)
    {
        case 2:
            load_ldt(data);
            break;
        case 3:
            load_tr(data);
            break;
        default:
            dbg_log(modrm_byte >> 3 & 7, LOG_CPU);
            todo();
    }
});

opm(0x01, {
    if(cpl)
    {
        trigger_gp(0);
    }

    var mod = modrm_byte >> 3 & 7;

    if(mod === 4)
    {
        // smsw
        set_ev16(cr0);
        return;
    }
    else if(mod === 6)
    {
        // lmsw
        read_e16;

        cr0 = (cr0 & ~0xF) | (data & 0xF);
        cr0_changed();
        return;
    }

    if(modrm_byte >= 0xC0)
    {
        // only memory
        raise_exception(6);
        dbg_assert(false);
    }

    if((mod === 2 || mod === 3) && protected_mode)
    {
        // override prefix, so modrm_resolve does not return the segment part
        // only lgdt and lidt and only in protected mode
        segment_prefix = reg_noseg; 
    }

    var addr = modrm_resolve(modrm_byte);
    segment_prefix = -1;

    switch(mod)
    {
        case 0:
            // sgdt
            safe_write16(addr, gdtr_size);
            safe_write32(addr + 2, gdtr_offset);
            break;
        case 1:
            // sidt
            safe_write16(addr, idtr_size);
            safe_write32(addr + 2, idtr_offset);
            break;
        case 2:
            // lgdt
            var size = safe_read16(addr);
            var offset = safe_read32s(addr + 2);

            gdtr_size = size;
            gdtr_offset = offset;

            if(!operand_size_32)
            {
                gdtr_offset &= 0xFFFFFF;
            }

            //dbg_log("gdt at " + h(gdtr_offset) + ", " + gdtr_size + " bytes", LOG_CPU);
            //dump_gdt_ldt();
            break;
        case 3:
            // lidt
            var size = safe_read16(addr);
            var offset = safe_read32s(addr + 2);

            idtr_size = size;
            idtr_offset = offset;

            if(!operand_size_32)
            {
                idtr_offset &= 0xFFFFFF;
            }

            //dbg_log("[" + h(instruction_pointer) + "] idt at " + 
            //        h(idtr_offset) + ", " + idtr_size + " bytes " + h(addr), LOG_CPU);
            break;
        case 7:
            // flush translation lookaside buffer
            invlpg(addr);
            break;
        default:
            dbg_log(mod);
            todo();
    }
});

opm(0x02, {
    todo();
    // lar
});

opm(0x03, {
    todo();
    // lsl
});

undefined_instruction(0x04);
undefined_instruction(0x05);

op(0x06, {
    // clts
    if(cpl)
    {
        trigger_gp(0);
    }
    else
    {
        //dbg_log("clts", LOG_CPU);
        cr0 &= ~8;
        // do something here ?
    }
});

undefined_instruction(0x07);
// invd
todo_op(0x08);

op(0x09, {
    if(cpl)
    {
        trigger_gp(0);
    }
    // wbinvd
});


undefined_instruction(0x0A);
op(0x0B, {
    // UD2
    trigger_ud();
});
undefined_instruction(0x0C);
todo_op(0x0D);
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
    if(operand_size_32) {
        read_e32s;
    }
    else {
        read_e16;
    }
});

unimplemented_sse(0x19);
unimplemented_sse(0x1A);
unimplemented_sse(0x1B);
unimplemented_sse(0x1C);
unimplemented_sse(0x1D);
unimplemented_sse(0x1E);
unimplemented_sse(0x1F);


opm(0x20, {

    if(cpl)
    {
        trigger_gp(0);
    }
    //dbg_log("cr" + mod + " read", LOG_CPU);

    // mov addr, cr
    // mod = which control register
    switch(modrm_byte >> 3 & 7)
    {
        case 0:
            reg_e32 = cr0;
            break;
        case 2:
            reg_e32 = cr2;
            break;
        case 3:
            //dbg_log("read cr3 (" + h(cr3, 8) + ")", LOG_CPU);
            reg_e32 = cr3;
            break;
        case 4:
            reg_e32 = cr4;
            break;
        default:
            dbg_log(modrm_byte >> 3 & 7);
            todo();
    }
});

opm(0x21, {
    if(cpl)
    {
        trigger_gp(0);
    }

    // TODO: mov from debug register
    dbg_assert(modrm_byte >= 0xC0);

    reg32s[modrm_byte & 7] = dreg[modrm_byte >> 3 & 7];

    //dbg_log("read dr" + (modrm_byte >> 3 & 7) + ": " + h(reg32[modrm_byte & 7]), LOG_CPU);
});

opm(0x22, {

    if(cpl)
    {
        trigger_gp(0);
    }

    var data = reg_e32s;
    //dbg_log("cr" + mod + " written: " + h(reg32[reg]), LOG_CPU);

    // mov cr, addr
    // mod = which control register
    switch(modrm_byte >> 3 & 7)
    {
        case 0:
            if((data & (0x80000001|0)) === (0x80000000 | 0))
            {
                // cannot load PG without PE
                throw unimpl("#GP handler");
            }

            if((cr0 & 1<<31) && !(data & 1<<31))
            {
                full_clear_tlb();
            }

            cr0 = data;
            cr0_changed();
            //dbg_log("cr1 = " + bits(memory.read32s(addr)), LOG_CPU);
            break;
        case 2:
            cr2 = data;
            dbg_log("cr2 <- " + h(data >>> 0), LOG_CPU);
            break;
        case 3: 
            cr3 = data;
            dbg_assert((cr3 & 0xFFF) === 0);
            clear_tlb();

            //dump_page_directory();
            //dbg_log("page directory loaded at " + h(cr3 >>> 0, 8), LOG_CPU);
            break;
        case 4:
            if((cr4 ^ data) & 0x80)
            {
                full_clear_tlb();
            }

            cr4 = data;
            page_size_extensions = (cr4 & 16) ? PSE_ENABLED : 0;
            //dbg_log("cr4 set to " + h(cr4 >>> 0), LOG_CPU);
                
            break;
        default:
            dbg_log(modrm_byte >> 3 & 7);
            todo();
    }
});
opm(0x23, {
    if(cpl)
    {
        trigger_gp(0);
    }

    // TODO: mov to debug register
    dbg_assert(modrm_byte >= 0xC0);
    //dbg_log("write dr" + (modrm_byte >> 3 & 7) + ": " + h(reg32[modrm_byte & 7]), LOG_CPU);

    dreg[modrm_byte >> 3 & 7] = reg32s[modrm_byte & 7];
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
todo_op(0x30);

op(0x31, {
    // rdtsc - read timestamp counter
    
    //var cycles = (Date.now() - emulation_start) / 1000 * 3000000;
    //reg32[reg_eax] = cycles;
    //reg32[reg_edx] = cycles / 0x100000000;

    if(!protected_mode || !cpl || !(cr4 & 4))
    {
        reg32[reg_eax] = cpu_timestamp_counter;
        reg32[reg_edx] = cpu_timestamp_counter / 0x100000000;
    }
    else
    {
        trigger_gp(0);
    }
});

// rdmsr
todo_op(0x32);
// rdpmc
todo_op(0x33);
// sysenter
todo_op(0x34);
// sysexit
todo_op(0x35);

undefined_instruction(0x36);

// getsec
todo_op(0x37);

unimplemented_sse(0x38);
unimplemented_sse(0x39);
unimplemented_sse(0x3A);
unimplemented_sse(0x3B);
unimplemented_sse(0x3C);
unimplemented_sse(0x3D);
unimplemented_sse(0x3E);
unimplemented_sse(0x3F);


#define group0F40(n, test)\
    opm2(0x40 | n, {\
        if(test) {\
            read_e16;\
            reg_g16 = data;\
        } else if(modrm_byte < 0xC0)\
            modrm_resolve(modrm_byte)\
    }, {\
        if(test) {\
            read_e32s;\
            reg_g32s = data;\
        } else if(modrm_byte < 0xC0)\
            modrm_resolve(modrm_byte)\
    });

each_jcc(group0F40);


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


#define group0F80(n, test) op2(0x80 | n, { jmpcc16(test); }, { jmpcc32(test); })
each_jcc(group0F80)


#define group0F90(n, test) opm(0x90 | n, { set_eb(!test ^ 1); });
each_jcc(group0F90);


op2(0xA0, { push16(sreg[reg_fs]); }, { push32(sreg[reg_fs]); });
pop_sreg_op(0xA1, reg_fs);
//op2(0xA1, 
//    { safe_pop16(sreg[reg_fs]); switch_seg(reg_fs); }, 
//    { safe_pop32s(sreg[reg_fs]); switch_seg(reg_fs); });

op(0xA2, { cpuid(); });

opm(0xA3, {
    if(operand_size_32)
    {
        if(modrm_byte < 0xC0)
        {
            bt_mem(modrm_resolve(modrm_byte), reg_g32s);
        }
        else
        {
            bt_reg(reg_e32s, reg_g32 & 31);
        }
    }
    else
    {
        if(modrm_byte < 0xC0)
        {
            bt_mem(modrm_resolve(modrm_byte), reg_g16s);
        }
        else
        {
            bt_reg(reg_e16, reg_g16 & 15);
        }
    }
});

opm2(0xA4, {
    write_ev16(shld16(data, reg_g16, read_imm8() & 31));
}, {
    write_ev32(shld32(data, reg_g32, read_imm8() & 31));
});
opm2(0xA5, {
    write_ev16(shld16(data, reg_g16, reg8[reg_cl] & 31));
}, {
    write_ev32(shld32(data, reg_g32, reg8[reg_cl] & 31));
});

undefined_instruction(0xA6);
undefined_instruction(0xA7);

op2(0xA8, { push16(sreg[reg_gs]); }, { push32(sreg[reg_gs]); });
pop_sreg_op(0xA9, reg_gs);
//op2(0xA9, 
//    { safe_pop16(sreg[reg_gs]); switch_seg(reg_gs); }, 
//    { safe_pop32s(sreg[reg_gs]); switch_seg(reg_gs); });

// rsm
todo_op(0xAA);

opm(0xAB, {
    bt_op(bts, reg_g16s, reg_g32s);
});


opm2(0xAC, {
    write_ev16(shrd16(data, reg_g16, read_imm8() & 31));
}, {
    write_ev32(shrd32(data, reg_g32, read_imm8() & 31));
});
opm2(0xAD, {
    write_ev16(shrd16(data, reg_g16, reg8[reg_cl] & 31));
}, {
    write_ev32(shrd32(data, reg_g32, reg8[reg_cl] & 31));
});

todo_op(0xAE);

opm2(0xAF, {
    read_e16s;
    reg_g16 = imul_reg16(reg_g16s, data);
}, {
    read_e32s;
    reg_g32 = imul_reg32(reg_g32s, data);
});


opm(0xB0, {
    // cmpxchg8
    if(modrm_byte < 0xC0)
    {
        var virt_addr = modrm_resolve(modrm_byte);
        translate_address_write(virt_addr);
        var data = safe_read8(virt_addr);
    }
    else
        data = reg_e8;


    cmp8(data, reg8[reg_al]);

    if(getzf())
    {
        if(modrm_byte < 0xC0)
            safe_write8(virt_addr, reg_g8);
        else
            reg_e8 = reg_g8;
    }
    else
    {
        reg8[reg_al] = data;
    }
});
opm(0xB1, {
    // cmpxchg16/32
    if(operand_size_32)
    {
        if(modrm_byte < 0xC0)
        {
            var virt_addr = modrm_resolve(modrm_byte);
            translate_address_write(virt_addr);
            var data = safe_read32(virt_addr);
        }
        else
            data = reg_e32;

        cmp32(data, reg32[reg_eax]);

        if(getzf())
        {
            if(modrm_byte < 0xC0)
                safe_write32(virt_addr, reg_g32);
            else
                reg_e32 = reg_g32;
        }
        else
        {
            reg32[reg_eax] = data;
        }
    }
    else
    {
        if(modrm_byte < 0xC0)
        {
            var virt_addr = modrm_resolve(modrm_byte);
            translate_address_write(virt_addr);
            var data = safe_read16(virt_addr);
        }
        else
            data = reg_e16;
        
        cmp16(data, reg16[reg_ax]);

        if(getzf())
        {
            if(modrm_byte < 0xC0)
                safe_write16(virt_addr, reg_g16);
            else
                reg_e16 = reg_g16;
        }
        else
        {
            reg16[reg_ax] = data;
        }
    }
});

// lss
opm(0xB2, { 
    lss_op(reg_ss);
});

opm(0xB3, {
    bt_op(btr, reg_g16s, reg_g32s);
});

// lfs, lgs
opm(0xB4, { 
    lss_op(reg_fs);
});
opm(0xB5, {
    lss_op(reg_gs);
});

opm2(0xB6, {
    // movzx
    read_e8;
    reg_g16 = data;
}, {
    read_e8;
    reg_g32 = data;
});

opm(0xB7, {
    // movzx
    read_e16;
    reg_g32 = data;
});

// popcnt
todo_op(0xB8);

// UD
todo_op(0xB9);

opm(0xBA, {
    //dbg_log("BA " + mod + " " + imm8);

    switch(modrm_byte >> 3 & 7)
    {
        case 4:
            if(operand_size_32)
            {
                if(modrm_byte < 0xC0)
                {
                    bt_mem(modrm_resolve(modrm_byte), read_imm8() & 31);
                }
                else
                {
                    bt_reg(reg_e32s, read_imm8() & 31);
                }
            }
            else
            {
                if(modrm_byte < 0xC0)
                {
                    bt_mem(modrm_resolve(modrm_byte), read_imm8() & 31);
                }
                else
                {
                    bt_reg(reg_e16, read_imm8() & 15);
                }
            }
            break;
        case 5:
            bt_op(bts, read_imm8() & 31, read_imm8() & 31);
            break;
        case 6:
            bt_op(btr, read_imm8() & 31, read_imm8() & 31);
            break;
        case 7:
            bt_op(btc, read_imm8() & 31, read_imm8() & 31);
            break;
        default:
            dbg_log(modrm_byte >> 3 & 7);
            todo();
    }
});
opm(0xBB, {
    bt_op(btc, reg_g16s, reg_g32s);
});

opm2(0xBC, {
    read_e16;
    reg_g16 = bsf16(reg_g16, data);
}, {
    read_e32s;
    reg_g32 = bsf32(reg_g32, data);
});

opm2(0xBD, {
    read_e16;
    reg_g16 = bsr16(reg_g16, data);
}, {
    read_e32s;
    reg_g32 = bsr32(reg_g32, data);
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
    write_e8(xadd8(data, modrm_byte >> 1 & 0xC | modrm_byte >> 5 & 1));
});

opm2(0xC1, {
    write_ev16(xadd16(data, modrm_byte >> 2 & 14));
}, {
    write_ev32(xadd32(data, modrm_byte >> 3 & 7));
});


unimplemented_sse(0xC2);
unimplemented_sse(0xC3);
unimplemented_sse(0xC4);
unimplemented_sse(0xC5);
unimplemented_sse(0xC6);

opm(0xC7, {
    // cmpxchg8b
    var addr = modrm_resolve(modrm_byte);
    translate_address_write(addr);
    
    var m64_low = safe_read32(addr);
    var m64_high = safe_read32(addr + 4);

    if(reg32[reg_eax] === m64_low &&
            reg32[reg_edx] === m64_high)
    {
        flags |= flag_zero;

        safe_write32(addr, reg32[reg_ebx]);
        safe_write32(addr + 4, reg32[reg_ecx]);
    }
    else
    {
        flags &= ~flag_zero;

        reg32[reg_eax] = m64_low;
        reg32[reg_edx] = m64_high;
    }

    flags_changed &= ~flag_zero;
});

#define group0FC8(n, r16, r32) op(0xC8 | n, { bswap(r32); });
each_reg(group0FC8)

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
