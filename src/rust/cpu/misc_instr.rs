use cpu::cpu::*;
use cpu::fpu::{
    fpu_load_m80, fpu_load_status_word, fpu_set_status_word, fpu_store_m80, set_control_word,
};
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

pub unsafe fn jmp_rel16(rel16: i32) {
    let cs_offset = get_seg_cs();
    // limit ip to 16 bit
    *instruction_pointer = cs_offset + (*instruction_pointer - cs_offset + rel16 & 0xFFFF);
}
pub unsafe fn jmpcc16(condition: bool, imm16: i32) {
    if condition {
        jmp_rel16(imm16);
    };
}
pub unsafe fn jmpcc32(condition: bool, imm32: i32) {
    if condition {
        *instruction_pointer += imm32
    };
}
pub unsafe fn loope16(imm8s: i32) { jmpcc16(0 != decr_ecx_asize(is_asize_32()) && getzf(), imm8s); }
pub unsafe fn loopne16(imm8s: i32) {
    jmpcc16(0 != decr_ecx_asize(is_asize_32()) && !getzf(), imm8s);
}
pub unsafe fn loop16(imm8s: i32) { jmpcc16(0 != decr_ecx_asize(is_asize_32()), imm8s); }
pub unsafe fn jcxz16(imm8s: i32) { jmpcc16(get_reg_asize(ECX) == 0, imm8s); }
pub unsafe fn loope32(imm8s: i32) { jmpcc32(0 != decr_ecx_asize(is_asize_32()) && getzf(), imm8s); }
pub unsafe fn loopne32(imm8s: i32) {
    jmpcc32(0 != decr_ecx_asize(is_asize_32()) && !getzf(), imm8s);
}
pub unsafe fn loop32(imm8s: i32) { jmpcc32(0 != decr_ecx_asize(is_asize_32()), imm8s); }
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

pub unsafe fn get_stack_pointer(offset: i32) -> i32 {
    if *stack_size_32 {
        return get_seg_ss() + read_reg32(ESP) + offset;
    }
    else {
        return get_seg_ss() + (read_reg16(SP) + offset & 0xFFFF);
    };
}
pub unsafe fn adjust_stack_reg(adjustment: i32) {
    if *stack_size_32 {
        write_reg32(ESP, read_reg32(ESP) + adjustment);
    }
    else {
        write_reg16(SP, read_reg16(SP) + adjustment);
    };
}

pub unsafe fn push16_ss16(imm16: i32) -> OrPageFault<()> {
    let sp = get_seg_ss() + (read_reg16(SP) - 2 & 0xFFFF);
    safe_write16(sp, imm16)?;
    write_reg16(SP, read_reg16(SP) - 2);
    Ok(())
}
pub unsafe fn push16_ss32(imm16: i32) -> OrPageFault<()> {
    let sp = get_seg_ss() + read_reg32(ESP) - 2;
    safe_write16(sp, imm16)?;
    write_reg32(ESP, read_reg32(ESP) - 2);
    Ok(())
}

pub unsafe fn push16_ss16_mem(addr: i32) -> OrPageFault<()> { push16_ss16(safe_read16(addr)?) }
pub unsafe fn push16_ss32_mem(addr: i32) -> OrPageFault<()> { push16_ss32(safe_read16(addr)?) }

pub unsafe fn push16(imm16: i32) -> OrPageFault<()> {
    if *stack_size_32 {
        push16_ss32(imm16)
    }
    else {
        push16_ss16(imm16)
    }
}

pub unsafe fn push32_ss16(imm32: i32) -> OrPageFault<()> {
    let new_sp = read_reg16(SP) - 4 & 0xFFFF;
    safe_write32(get_seg_ss() + new_sp, imm32)?;
    write_reg16(SP, new_sp);
    Ok(())
}
pub unsafe fn push32_ss32(imm32: i32) -> OrPageFault<()> {
    let new_esp = read_reg32(ESP) - 4;
    safe_write32(get_seg_ss() + new_esp, imm32)?;
    write_reg32(ESP, new_esp);
    Ok(())
}

pub unsafe fn push32_ss16_mem(addr: i32) -> OrPageFault<()> { push32_ss16(safe_read32s(addr)?) }
pub unsafe fn push32_ss32_mem(addr: i32) -> OrPageFault<()> { push32_ss32(safe_read32s(addr)?) }

pub unsafe fn push32(imm32: i32) -> OrPageFault<()> {
    if *stack_size_32 {
        push32_ss32(imm32)
    }
    else {
        push32_ss16(imm32)
    }
}

pub unsafe fn push32_sreg(i: i32) -> OrPageFault<()> {
    // you can't make this up ...
    if *stack_size_32 {
        let new_esp = read_reg32(ESP) - 4;
        safe_write16(get_seg_ss() + new_esp, *sreg.offset(i as isize) as i32)?;
        write_reg32(ESP, new_esp);
    }
    else {
        let new_sp = read_reg16(SP) - 4 & 0xFFFF;
        safe_write16(get_seg_ss() + new_sp, *sreg.offset(i as isize) as i32)?;
        write_reg16(SP, new_sp);
    }
    Ok(())
}

pub unsafe fn pop16() -> OrPageFault<i32> {
    if *stack_size_32 {
        pop16_ss32()
    }
    else {
        pop16_ss16()
    }
}
pub unsafe fn pop16_ss16() -> OrPageFault<i32> {
    let sp = get_seg_ss() + read_reg16(SP);
    let result = safe_read16(sp)?;
    write_reg16(SP, read_reg16(SP) + 2);
    Ok(result)
}
pub unsafe fn pop16_ss32() -> OrPageFault<i32> {
    let esp = get_seg_ss() + read_reg32(ESP);
    let result = safe_read16(esp)?;
    write_reg32(ESP, read_reg32(ESP) + 2);
    Ok(result)
}
pub unsafe fn pop32s() -> OrPageFault<i32> {
    if *stack_size_32 {
        pop32s_ss32()
    }
    else {
        pop32s_ss16()
    }
}
pub unsafe fn pop32s_ss16() -> OrPageFault<i32> {
    let sp = read_reg16(SP);
    let result = safe_read32s(get_seg_ss() + sp)?;
    write_reg16(SP, sp + 4);
    Ok(result)
}
pub unsafe fn pop32s_ss32() -> OrPageFault<i32> {
    let esp = read_reg32(ESP);
    let result = safe_read32s(get_seg_ss() + esp)?;
    write_reg32(ESP, read_reg32(ESP) + 4);
    Ok(result)
}
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

pub unsafe fn setcc_reg(condition: bool, r: i32) { write_reg8(r, condition as i32); }
pub unsafe fn setcc_mem(condition: bool, addr: i32) {
    return_on_pagefault!(safe_write8(addr, condition as i32));
}

pub unsafe fn fxsave(addr: i32) {
    dbg_assert!(addr & 0xF == 0, "TODO: #gp");
    return_on_pagefault!(writable_or_pagefault(addr, 288));

    safe_write16(addr + 0, (*fpu_control_word).into()).unwrap();
    safe_write16(addr + 2, fpu_load_status_word().into()).unwrap();
    safe_write8(addr + 4, !*fpu_stack_empty as i32 & 0xFF).unwrap();
    safe_write16(addr + 6, *fpu_opcode).unwrap();
    safe_write32(addr + 8, *fpu_ip).unwrap();
    safe_write16(addr + 12, *fpu_ip_selector).unwrap();
    safe_write32(addr + 16, *fpu_dp).unwrap();
    safe_write16(addr + 20, *fpu_dp_selector).unwrap();

    safe_write32(addr + 24, *mxcsr).unwrap();
    safe_write32(addr + 28, MXCSR_MASK).unwrap();

    for i in 0..8 {
        let reg_index = i + *fpu_stack_ptr as i32 & 7;
        fpu_store_m80(addr + 32 + (i << 4), *fpu_st.offset(reg_index as isize));
    }

    // If the OSFXSR bit in control register CR4 is not set, the FXSAVE
    // instruction may not save these registers. This behavior is
    // implementation dependent.
    for i in 0..8 {
        safe_write128(addr + 160 + (i << 4), *reg_xmm.offset(i as isize)).unwrap();
    }
}
pub unsafe fn fxrstor(addr: i32) {
    dbg_assert!(addr & 0xF == 0, "TODO: #gp");
    return_on_pagefault!(readable_or_pagefault(addr, 288));

    let new_mxcsr = safe_read32s(addr + 24).unwrap();

    if 0 != new_mxcsr & !MXCSR_MASK {
        dbg_log!("#gp Invalid mxcsr bits");
        trigger_gp(0);
        return;
    }

    set_control_word(safe_read16(addr + 0).unwrap() as u16);
    fpu_set_status_word(safe_read16(addr + 2).unwrap() as u16);
    *fpu_stack_empty = !safe_read8(addr + 4).unwrap() as u8;
    *fpu_opcode = safe_read16(addr + 6).unwrap();
    *fpu_ip = safe_read32s(addr + 8).unwrap();
    *fpu_ip_selector = safe_read16(addr + 12).unwrap();
    *fpu_dp = safe_read32s(addr + 16).unwrap();
    *fpu_dp_selector = safe_read16(addr + 20).unwrap();

    set_mxcsr(new_mxcsr);

    for i in 0..8 {
        let reg_index = *fpu_stack_ptr as i32 + i & 7;
        *fpu_st.offset(reg_index as isize) = fpu_load_m80(addr + 32 + (i << 4)).unwrap();
    }

    for i in 0..8 {
        *reg_xmm.offset(i as isize) = safe_read128s(addr + 160 + (i << 4)).unwrap();
    }
}

pub unsafe fn xchg8(data: i32, r8: i32) -> i32 {
    let tmp = read_reg8(r8);
    write_reg8(r8, data);
    return tmp;
}
pub unsafe fn xchg16(data: i32, r16: i32) -> i32 {
    let tmp = read_reg16(r16);
    write_reg16(r16, data);
    return tmp;
}
pub unsafe fn xchg16r(r16: i32) {
    let tmp = read_reg16(AX);
    write_reg16(AX, read_reg16(r16));
    write_reg16(r16, tmp);
}
pub unsafe fn xchg32(data: i32, r32: i32) -> i32 {
    let tmp = read_reg32(r32);
    write_reg32(r32, data);
    return tmp;
}
pub unsafe fn xchg32r(r32: i32) {
    let tmp = read_reg32(EAX);
    write_reg32(EAX, read_reg32(r32));
    write_reg32(r32, tmp);
}

pub unsafe fn bswap(r: i32) { write_reg32(r, read_reg32(r).swap_bytes()) }

pub unsafe fn lar(selector: i32, original: i32) -> i32 {
    if false {
        dbg_log!("lar sel={:x}", selector);
    }

    const LAR_INVALID_TYPE: u32 =
        1 << 0 | 1 << 6 | 1 << 7 | 1 << 8 | 1 << 0xA | 1 << 0xD | 1 << 0xE | 1 << 0xF;

    let sel = SegmentSelector::of_u16(selector as u16);
    match lookup_segment_selector(sel) {
        Err(()) => {
            // pagefault
            return original;
        },
        Ok(Err(_)) => {
            *flags_changed &= !FLAG_ZERO;
            *flags &= !FLAG_ZERO;
            dbg_log!("lar: invalid selector={:x}: null or invalid", selector);
            return original;
        },
        Ok(Ok((desc, _))) => {
            *flags_changed &= !FLAG_ZERO;
            let dpl_bad = desc.dpl() < *cpl || desc.dpl() < sel.rpl();

            if if desc.is_system() {
                (LAR_INVALID_TYPE >> desc.system_type() & 1 == 1) || dpl_bad
            }
            else {
                !desc.is_conforming_executable() && dpl_bad
            } {
                dbg_log!(
                    "lar: invalid selector={:x} is_null={} is_system={}",
                    selector,
                    false,
                    desc.is_system()
                );
                *flags &= !FLAG_ZERO;
                return original;
            }
            else {
                *flags |= FLAG_ZERO;
                return (desc.raw >> 32) as i32 & 0x00FFFF00;
            }
        },
    }
}

pub unsafe fn lsl(selector: i32, original: i32) -> i32 {
    if false {
        dbg_log!("lsl sel={:x}", selector);
    }

    const LSL_INVALID_TYPE: i32 = 1 << 0
        | 1 << 4
        | 1 << 5
        | 1 << 6
        | 1 << 7
        | 1 << 8
        | 1 << 0xA
        | 1 << 0xC
        | 1 << 0xD
        | 1 << 0xE
        | 1 << 0xF;

    let sel = SegmentSelector::of_u16(selector as u16);
    match lookup_segment_selector(sel) {
        Err(()) => {
            // pagefault
            return original;
        },
        Ok(Err(_)) => {
            *flags_changed &= !FLAG_ZERO;
            *flags &= !FLAG_ZERO;
            dbg_log!("lsl: invalid selector={:x}: null or invalid", selector);
            return original;
        },
        Ok(Ok((desc, _))) => {
            *flags_changed &= !FLAG_ZERO;
            let dpl_bad = desc.dpl() < *cpl || desc.dpl() < sel.rpl();

            if if desc.is_system() {
                (LSL_INVALID_TYPE >> desc.system_type() & 1 == 1) || dpl_bad
            }
            else {
                !desc.is_conforming_executable() && dpl_bad
            } {
                dbg_log!(
                    "lsl: invalid  selector={:x} is_null={} is_system={}",
                    selector,
                    false,
                    desc.is_system(),
                );
                *flags &= !FLAG_ZERO;
                return original;
            }
            else {
                *flags |= FLAG_ZERO;
                return desc.effective_limit() as i32;
            }
        },
    }
}

pub unsafe fn verr(selector: i32) {
    *flags_changed &= !FLAG_ZERO;
    let sel = SegmentSelector::of_u16(selector as u16);
    match return_on_pagefault!(lookup_segment_selector(sel)) {
        Err(_) => {
            *flags &= !FLAG_ZERO;
            dbg_log!("verr -> invalid. selector={:x}", selector);
        },
        Ok((desc, _)) => {
            if desc.is_system()
                || !desc.is_readable()
                || (!desc.is_conforming_executable()
                    && (desc.dpl() < *cpl || desc.dpl() < sel.rpl()))
            {
                dbg_log!("verr -> invalid. selector={:x}", selector);
                *flags &= !FLAG_ZERO;
            }
            else {
                dbg_log!("verr -> valid. selector={:x}", selector);
                *flags |= FLAG_ZERO;
            }
        },
    }
}

pub unsafe fn verw(selector: i32) {
    *flags_changed &= !FLAG_ZERO;
    let sel = SegmentSelector::of_u16(selector as u16);
    match return_on_pagefault!(lookup_segment_selector(sel)) {
        Err(_) => {
            *flags &= !FLAG_ZERO;
            dbg_log!("verw -> invalid. selector={:x}", selector);
        },
        Ok((desc, _)) => {
            if desc.is_system()
                || !desc.is_writable()
                || desc.dpl() < *cpl
                || desc.dpl() < sel.rpl()
            {
                dbg_log!(
                    "verw invalid selector={:x} is_system={} is_writable={}",
                    selector,
                    desc.is_system(),
                    desc.is_writable(),
                );
                *flags &= !FLAG_ZERO;
            }
            else {
                *flags |= FLAG_ZERO;
            }
        },
    }
}
