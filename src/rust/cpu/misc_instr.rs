use cpu::cpu::*;
use cpu::fpu::{fpu_load_m80, fpu_load_status_word, fpu_set_status_word, fpu_store_m80};
use cpu::global_pointers::*;
use paging::OrPageFault;

pub unsafe fn getcf() -> bool {
    if 0 != *flags_changed & 1 {
        let m = (2 << *last_op_size) - 1;
        dbg_assert!((*last_op1 as u32) <= m);
        dbg_assert!((*last_result as u32) <= m);

        let sub_mask = *flags_changed >> 31;

        // sub: last_op1 < last_result  (or last_op1 < last_op2) (or (result ^ ((result ^ b) & (b ^ a))))
        // add: last_result < last_op1  (or last_result < last_op2) (or a ^ ((a ^ b) & (b ^ result)))
        return ((*last_result as i32 ^ sub_mask) as u32) < (*last_op1 ^ sub_mask) as u32;
    }
    else {
        return 0 != *flags & 1;
    };
}
#[no_mangle]
pub unsafe fn getpf() -> bool {
    if 0 != *flags_changed & FLAG_PARITY {
        // inverted lookup table
        return 0 != 0x9669 << 2 >> ((*last_result ^ *last_result >> 4) & 15) & FLAG_PARITY;
    }
    else {
        return 0 != *flags & FLAG_PARITY;
    };
}
pub unsafe fn getaf() -> bool {
    if 0 != *flags_changed & FLAG_ADJUST {
        let is_sub = *flags_changed & FLAG_SUB != 0;
        let last_op2 = (*last_result - *last_op1) * if is_sub { -1 } else { 1 };
        return 0 != (*last_op1 ^ last_op2 ^ *last_result) & FLAG_ADJUST;
    }
    else {
        return 0 != *flags & FLAG_ADJUST;
    };
}
pub unsafe fn getzf() -> bool {
    if 0 != *flags_changed & FLAG_ZERO {
        return 0 != (!*last_result & *last_result - 1) >> *last_op_size & 1;
    }
    else {
        return 0 != *flags & FLAG_ZERO;
    };
}
pub unsafe fn getsf() -> bool {
    if 0 != *flags_changed & FLAG_SIGN {
        return 0 != *last_result >> *last_op_size & 1;
    }
    else {
        return 0 != *flags & FLAG_SIGN;
    };
}
pub unsafe fn getof() -> bool {
    if 0 != *flags_changed & FLAG_OVERFLOW {
        let is_sub = (*flags_changed as u32) >> 31;

        // add: (a ^ result) & (b ^ result)
        // sub: (a ^ result) & (b ^ result ^ 1) (or (a ^ b) & (result ^ a))
        let b_xor_1_if_sub = (*last_result - *last_op1) - is_sub as i32;
        return 0
            != ((*last_op1 ^ *last_result) & (b_xor_1_if_sub ^ *last_result)) >> *last_op_size & 1;
    }
    else {
        return 0 != *flags & FLAG_OVERFLOW;
    };
}

pub unsafe fn test_o() -> bool { return getof(); }
pub unsafe fn test_b() -> bool { return getcf(); }
pub unsafe fn test_z() -> bool { return getzf(); }
pub unsafe fn test_s() -> bool { return getsf(); }
#[no_mangle]
pub unsafe fn test_p() -> bool { return getpf(); }
pub unsafe fn test_be() -> bool { return getcf() || getzf(); }
pub unsafe fn test_l() -> bool { return getsf() != getof(); }
pub unsafe fn test_le() -> bool { return getzf() || getsf() != getof(); }
pub unsafe fn test_no() -> bool { return !test_o(); }
pub unsafe fn test_nb() -> bool { return !test_b(); }
pub unsafe fn test_nz() -> bool { return !test_z(); }
pub unsafe fn test_ns() -> bool { return !test_s(); }
#[no_mangle]
pub unsafe fn test_np() -> bool { return !test_p(); }
pub unsafe fn test_nbe() -> bool { return !test_be(); }
pub unsafe fn test_nl() -> bool { return !test_l(); }
pub unsafe fn test_nle() -> bool { return !test_le(); }

#[no_mangle]
pub unsafe fn jmp_rel16(rel16: i32) {
    let cs_offset = get_seg_cs();
    // limit ip to 16 bit
    *instruction_pointer = cs_offset + (*instruction_pointer - cs_offset + rel16 & 0xFFFF);
}
#[no_mangle]
pub unsafe fn jmpcc16(condition: bool, imm16: i32) {
    if condition {
        jmp_rel16(imm16);
    };
}
#[no_mangle]
pub unsafe fn jmpcc32(condition: bool, imm32: i32) {
    if condition {
        *instruction_pointer += imm32
    };
}
#[no_mangle]
pub unsafe fn loope16(imm8s: i32) { jmpcc16(0 != decr_ecx_asize(is_asize_32()) && getzf(), imm8s); }
#[no_mangle]
pub unsafe fn loopne16(imm8s: i32) {
    jmpcc16(0 != decr_ecx_asize(is_asize_32()) && !getzf(), imm8s);
}
#[no_mangle]
pub unsafe fn loop16(imm8s: i32) { jmpcc16(0 != decr_ecx_asize(is_asize_32()), imm8s); }
#[no_mangle]
pub unsafe fn jcxz16(imm8s: i32) { jmpcc16(get_reg_asize(ECX) == 0, imm8s); }
#[no_mangle]
pub unsafe fn loope32(imm8s: i32) { jmpcc32(0 != decr_ecx_asize(is_asize_32()) && getzf(), imm8s); }
#[no_mangle]
pub unsafe fn loopne32(imm8s: i32) {
    jmpcc32(0 != decr_ecx_asize(is_asize_32()) && !getzf(), imm8s);
}
#[no_mangle]
pub unsafe fn loop32(imm8s: i32) { jmpcc32(0 != decr_ecx_asize(is_asize_32()), imm8s); }
#[no_mangle]
pub unsafe fn jcxz32(imm8s: i32) { jmpcc32(get_reg_asize(ECX) == 0, imm8s); }

pub unsafe fn cmovcc16(condition: bool, value: i32, r: i32) {
    if condition {
        write_reg16(r, value);
    };
}
pub unsafe fn cmovcc32(condition: bool, value: i32, r: i32) {
    if condition {
        write_reg32(r, value);
    };
}

#[no_mangle]
pub unsafe fn get_stack_pointer(offset: i32) -> i32 {
    if *stack_size_32 {
        return get_seg_ss() + read_reg32(ESP) + offset;
    }
    else {
        return get_seg_ss() + (read_reg16(SP) + offset & 0xFFFF);
    };
}
#[no_mangle]
pub unsafe fn adjust_stack_reg(adjustment: i32) {
    if *stack_size_32 {
        write_reg32(ESP, read_reg32(ESP) + adjustment);
    }
    else {
        write_reg16(SP, read_reg16(SP) + adjustment);
    };
}

#[no_mangle]
pub unsafe fn push16_ss16(imm16: i32) -> OrPageFault<()> {
    let sp = get_seg_ss() + (read_reg16(SP) - 2 & 0xFFFF);
    safe_write16(sp, imm16)?;
    write_reg16(SP, read_reg16(SP) - 2);
    Ok(())
}
#[no_mangle]
pub unsafe fn push16_ss32(imm16: i32) -> OrPageFault<()> {
    let sp = get_seg_ss() + read_reg32(ESP) - 2;
    safe_write16(sp, imm16)?;
    write_reg32(ESP, read_reg32(ESP) - 2);
    Ok(())
}

#[no_mangle]
pub unsafe fn push16_ss16_mem(addr: i32) -> OrPageFault<()> { push16_ss16(safe_read16(addr)?) }
#[no_mangle]
pub unsafe fn push16_ss32_mem(addr: i32) -> OrPageFault<()> { push16_ss32(safe_read16(addr)?) }

#[no_mangle]
pub unsafe fn push16(imm16: i32) -> OrPageFault<()> {
    if *stack_size_32 { push16_ss32(imm16) } else { push16_ss16(imm16) }
}

#[no_mangle]
pub unsafe fn push32_ss16(imm32: i32) -> OrPageFault<()> {
    let new_sp = read_reg16(SP) - 4 & 0xFFFF;
    safe_write32(get_seg_ss() + new_sp, imm32)?;
    write_reg16(SP, new_sp);
    Ok(())
}
#[no_mangle]
pub unsafe fn push32_ss32(imm32: i32) -> OrPageFault<()> {
    let new_esp = read_reg32(ESP) - 4;
    safe_write32(get_seg_ss() + new_esp, imm32)?;
    write_reg32(ESP, new_esp);
    Ok(())
}

#[no_mangle]
pub unsafe fn push32_ss16_mem(addr: i32) -> OrPageFault<()> { push32_ss16(safe_read32s(addr)?) }
#[no_mangle]
pub unsafe fn push32_ss32_mem(addr: i32) -> OrPageFault<()> { push32_ss32(safe_read32s(addr)?) }

#[no_mangle]
pub unsafe fn push32(imm32: i32) -> OrPageFault<()> {
    if *stack_size_32 { push32_ss32(imm32) } else { push32_ss16(imm32) }
}
#[no_mangle]
pub unsafe fn pop16() -> OrPageFault<i32> {
    if *stack_size_32 { pop16_ss32() } else { pop16_ss16() }
}
#[no_mangle]
pub unsafe fn pop16_ss16() -> OrPageFault<i32> {
    let sp = get_seg_ss() + read_reg16(SP);
    let result = safe_read16(sp)?;
    write_reg16(SP, read_reg16(SP) + 2);
    Ok(result)
}
#[no_mangle]
pub unsafe fn pop16_ss32() -> OrPageFault<i32> {
    let esp = get_seg_ss() + read_reg32(ESP);
    let result = safe_read16(esp)?;
    write_reg32(ESP, read_reg32(ESP) + 2);
    Ok(result)
}
#[no_mangle]
pub unsafe fn pop32s() -> OrPageFault<i32> {
    if *stack_size_32 { pop32s_ss32() } else { pop32s_ss16() }
}
#[no_mangle]
pub unsafe fn pop32s_ss16() -> OrPageFault<i32> {
    let sp = read_reg16(SP);
    let result = safe_read32s(get_seg_ss() + sp)?;
    write_reg16(SP, sp + 4);
    Ok(result)
}
#[no_mangle]
pub unsafe fn pop32s_ss32() -> OrPageFault<i32> {
    let esp = read_reg32(ESP);
    let result = safe_read32s(get_seg_ss() + esp)?;
    write_reg32(ESP, read_reg32(ESP) + 4);
    Ok(result)
}
#[no_mangle]
pub unsafe fn pusha16() {
    let temp = read_reg16(SP);
    // make sure we don't get a pagefault after having
    // pushed several registers already
    return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-16), 16));
    push16(read_reg16(AX)).unwrap();
    push16(read_reg16(CX)).unwrap();
    push16(read_reg16(DX)).unwrap();
    push16(read_reg16(BX)).unwrap();
    push16(temp as i32).unwrap();
    push16(read_reg16(BP)).unwrap();
    push16(read_reg16(SI)).unwrap();
    push16(read_reg16(DI)).unwrap();
}
#[no_mangle]
pub unsafe fn pusha32() {
    let temp = read_reg32(ESP);
    return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-32), 32));
    push32(read_reg32(EAX)).unwrap();
    push32(read_reg32(ECX)).unwrap();
    push32(read_reg32(EDX)).unwrap();
    push32(read_reg32(EBX)).unwrap();
    push32(temp).unwrap();
    push32(read_reg32(EBP)).unwrap();
    push32(read_reg32(ESI)).unwrap();
    push32(read_reg32(EDI)).unwrap();
}

pub unsafe fn lss16(addr: i32, reg: i32, seg: i32) {
    let new_reg = return_on_pagefault!(safe_read16(addr));
    let new_seg = return_on_pagefault!(safe_read16(addr + 2));

    if !switch_seg(seg, new_seg) {
        return;
    }

    write_reg16(reg, new_reg);
}

pub unsafe fn lss32(addr: i32, reg: i32, seg: i32) {
    let new_reg = return_on_pagefault!(safe_read32s(addr));
    let new_seg = return_on_pagefault!(safe_read16(addr + 4));

    if !switch_seg(seg, new_seg) {
        return;
    }

    write_reg32(reg, new_reg);
}

pub unsafe fn enter16(size: i32, mut nesting_level: i32) {
    nesting_level &= 31;

    if nesting_level > 0 {
        dbg_log!(
            "enter16 stack={} size={} nest={}",
            (if *stack_size_32 { 16 } else { 32 }),
            size,
            nesting_level,
        );
    }

    let ss_mask = if *stack_size_32 { -1 } else { 0xFFFF };
    let ss = get_seg_ss();
    let frame_temp = read_reg32(ESP) - 2;

    if nesting_level > 0 {
        let mut tmp_ebp = read_reg32(EBP);
        for _ in 1..nesting_level {
            tmp_ebp -= 2;
            push16(safe_read16(ss + (tmp_ebp & ss_mask)).unwrap()).unwrap();
        }
        push16(frame_temp).unwrap();
    }

    return_on_pagefault!(safe_write16(ss + (frame_temp & ss_mask), read_reg16(BP)));
    write_reg16(BP, frame_temp);
    adjust_stack_reg(-size - 2);
}

pub unsafe fn enter32(size: i32, mut nesting_level: i32) {
    nesting_level &= 31;

    if nesting_level > 0 {
        dbg_log!(
            "enter32 stack={} size={} nest={}",
            (if *stack_size_32 { 16 } else { 32 }),
            size,
            nesting_level,
        );
    }

    let ss_mask = if *stack_size_32 { -1 } else { 0xFFFF };
    let ss = get_seg_ss();
    let frame_temp = read_reg32(ESP) - 4;

    if nesting_level > 0 {
        let mut tmp_ebp = read_reg32(EBP);
        for _ in 1..nesting_level {
            tmp_ebp -= 4;
            push32(safe_read32s(ss + (tmp_ebp & ss_mask)).unwrap()).unwrap();
        }
        push32(frame_temp).unwrap();
    }

    return_on_pagefault!(safe_write32(ss + (frame_temp & ss_mask), read_reg32(EBP)));
    write_reg32(EBP, frame_temp);
    adjust_stack_reg(-size - 4);
}

#[no_mangle]
pub unsafe fn setcc_reg(condition: bool, r: i32) { write_reg8(r, condition as i32); }
#[no_mangle]
pub unsafe fn setcc_mem(condition: bool, addr: i32) {
    return_on_pagefault!(safe_write8(addr, condition as i32));
}
#[no_mangle]
pub unsafe fn fxsave(addr: i32) {
    return_on_pagefault!(writable_or_pagefault(addr as i32, 512));
    safe_write16(addr.wrapping_add(0) as i32, *fpu_control_word).unwrap();
    safe_write16(addr.wrapping_add(2) as i32, fpu_load_status_word()).unwrap();
    safe_write8(addr.wrapping_add(4) as i32, !*fpu_stack_empty & 255).unwrap();
    safe_write16(addr.wrapping_add(6) as i32, *fpu_opcode).unwrap();
    safe_write32(addr.wrapping_add(8) as i32, *fpu_ip).unwrap();
    safe_write16(addr.wrapping_add(12) as i32, *fpu_ip_selector).unwrap();
    safe_write32(addr.wrapping_add(16) as i32, *fpu_dp).unwrap();
    safe_write16(addr.wrapping_add(20) as i32, *fpu_dp_selector).unwrap();
    safe_write32(addr.wrapping_add(24) as i32, *mxcsr).unwrap();
    safe_write32(addr.wrapping_add(28) as i32, MXCSR_MASK).unwrap();

    for i in 0..8 {
        let reg_index = i + *fpu_stack_ptr as i32 & 7;
        if *fxsave_store_fpu_mask & 1 << reg_index != 0 {
            fpu_store_m80(addr + 32 + (i << 4), *fpu_st.offset(reg_index as isize));
        }
        else {
            safe_write64(addr + 32 + (i << 4), *reg_mmx.offset(reg_index as isize)).unwrap();
            safe_write64(addr + 32 + (i << 4) | 8, 0).unwrap();
        }
    }

    // If the OSFXSR bit in control register CR4 is not set, the FXSAVE
    // instruction may not save these registers. This behavior is
    // implementation dependent.
    for i in 0..8 {
        safe_write128(
            addr.wrapping_add(160).wrapping_add(i << 4) as i32,
            *reg_xmm.offset(i as isize),
        )
        .unwrap();
    }
}
#[no_mangle]
pub unsafe fn fxrstor(addr: i32) {
    return_on_pagefault!(readable_or_pagefault(addr, 512));

    let new_mxcsr = safe_read32s(addr.wrapping_add(24) as i32).unwrap();
    if 0 != new_mxcsr & !MXCSR_MASK {
        dbg_log!("#gp Invalid mxcsr bits");
        trigger_gp(0);
        return;
    }
    else {
        *fpu_control_word = safe_read16(addr.wrapping_add(0) as i32).unwrap();
        fpu_set_status_word(safe_read16(addr.wrapping_add(2) as i32).unwrap());
        *fpu_stack_empty = !safe_read8(addr.wrapping_add(4) as i32).unwrap() & 255;
        *fpu_opcode = safe_read16(addr.wrapping_add(6) as i32).unwrap();
        *fpu_ip = safe_read32s(addr.wrapping_add(8) as i32).unwrap();
        *fpu_ip = safe_read16(addr.wrapping_add(12) as i32).unwrap();
        *fpu_dp = safe_read32s(addr.wrapping_add(16) as i32).unwrap();
        *fpu_dp_selector = safe_read16(addr.wrapping_add(20) as i32).unwrap();
        set_mxcsr(new_mxcsr);

        for i in 0..8 {
            let reg_index = *fpu_stack_ptr as i32 + i & 7;
            *fpu_st.offset(reg_index as isize) =
                fpu_load_m80(addr.wrapping_add(32).wrapping_add(i << 4)).unwrap();
            *reg_mmx.offset(reg_index as isize) =
                safe_read64s(addr.wrapping_add(32).wrapping_add(i << 4)).unwrap();
        }

        // Mark values as coming from the fpu: xmm registers fit into x87 registers, but not the
        // other way around
        *fxsave_store_fpu_mask = 0xff;

        for i in 0..8 {
            (*reg_xmm.offset(i as isize)).u32_0[0] =
                safe_read32s(addr.wrapping_add(160).wrapping_add(i << 4).wrapping_add(0)).unwrap()
                    as u32;
            (*reg_xmm.offset(i as isize)).u32_0[1] =
                safe_read32s(addr.wrapping_add(160).wrapping_add(i << 4).wrapping_add(4) as i32)
                    .unwrap() as u32;
            (*reg_xmm.offset(i as isize)).u32_0[2] =
                safe_read32s(addr.wrapping_add(160).wrapping_add(i << 4).wrapping_add(8) as i32)
                    .unwrap() as u32;
            (*reg_xmm.offset(i as isize)).u32_0[3] =
                safe_read32s(addr.wrapping_add(160).wrapping_add(i << 4).wrapping_add(12) as i32)
                    .unwrap() as u32;
        }
        return;
    };
}

#[no_mangle]
pub unsafe fn xchg8(data: i32, r8: i32) -> i32 {
    let tmp = read_reg8(r8);
    write_reg8(r8, data);
    return tmp;
}
#[no_mangle]
pub unsafe fn xchg16(data: i32, r16: i32) -> i32 {
    let tmp = read_reg16(r16);
    write_reg16(r16, data);
    return tmp;
}
#[no_mangle]
pub unsafe fn xchg16r(r16: i32) {
    let tmp = read_reg16(AX);
    write_reg16(AX, read_reg16(r16));
    write_reg16(r16, tmp);
}
#[no_mangle]
pub unsafe fn xchg32(data: i32, r32: i32) -> i32 {
    let tmp = read_reg32(r32);
    write_reg32(r32, data);
    return tmp;
}
#[no_mangle]
pub unsafe fn xchg32r(r32: i32) {
    let tmp = read_reg32(EAX);
    write_reg32(EAX, read_reg32(r32));
    write_reg32(r32, tmp);
}

#[no_mangle]
pub unsafe fn bswap(r: i32) { write_reg32(r, read_reg32(r).swap_bytes()) }
