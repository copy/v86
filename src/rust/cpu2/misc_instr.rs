#![allow(
    dead_code,
    mutable_transmutes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_mut
)]

use cpu2::cpu::*;
use cpu2::fpu::{fpu_load_m80, fpu_load_status_word, fpu_set_status_word, fpu_store_m80};
use cpu2::global_pointers::*;

#[no_mangle]
pub unsafe fn getcf() -> bool {
    if 0 != *flags_changed & 1i32 {
        return 0
            != (*last_op1 ^ (*last_op1 ^ *last_op2) & (*last_op2 ^ *last_add_result))
                >> *last_op_size
                & 1i32;
    }
    else {
        return 0 != *flags & 1i32;
    };
}
#[no_mangle]
pub unsafe fn getpf() -> bool {
    if 0 != *flags_changed & FLAG_PARITY {
        c_comment!(("inverted lookup table"));
        return 0
            != 38505i32 << 2i32 >> ((*last_result ^ *last_result >> 4i32) & 15i32) & FLAG_PARITY;
    }
    else {
        return 0 != *flags & FLAG_PARITY;
    };
}
#[no_mangle]
pub unsafe fn getaf() -> bool {
    if 0 != *flags_changed & FLAG_ADJUST {
        return 0 != (*last_op1 ^ *last_op2 ^ *last_add_result) & FLAG_ADJUST;
    }
    else {
        return 0 != *flags & FLAG_ADJUST;
    };
}
#[no_mangle]
pub unsafe fn getzf() -> bool {
    if 0 != *flags_changed & FLAG_ZERO {
        return 0 != (!*last_result & *last_result - 1i32) >> *last_op_size & 1i32;
    }
    else {
        return 0 != *flags & FLAG_ZERO;
    };
}
#[no_mangle]
pub unsafe fn getsf() -> bool {
    if 0 != *flags_changed & FLAG_SIGN {
        return 0 != *last_result >> *last_op_size & 1i32;
    }
    else {
        return 0 != *flags & FLAG_SIGN;
    };
}
#[no_mangle]
pub unsafe fn getof() -> bool {
    if 0 != *flags_changed & FLAG_OVERFLOW {
        return 0
            != ((*last_op1 ^ *last_add_result) & (*last_op2 ^ *last_add_result)) >> *last_op_size
                & 1i32;
    }
    else {
        return 0 != *flags & FLAG_OVERFLOW;
    };
}
#[no_mangle]
pub unsafe fn test_o() -> bool { return getof(); }
#[no_mangle]
pub unsafe fn test_b() -> bool { return getcf(); }
#[no_mangle]
pub unsafe fn test_z() -> bool { return getzf(); }
#[no_mangle]
pub unsafe fn test_s() -> bool { return getsf(); }
#[no_mangle]
pub unsafe fn test_p() -> bool { return getpf(); }
#[no_mangle]
pub unsafe fn test_be() -> bool { return 0 != getcf() as i32 || 0 != getzf() as i32; }
#[no_mangle]
pub unsafe fn test_l() -> bool { return getsf() as i32 != getof() as i32; }
#[no_mangle]
pub unsafe fn test_le() -> bool { return 0 != getzf() as i32 || getsf() as i32 != getof() as i32; }
#[no_mangle]
pub unsafe fn test_no() -> bool { return !test_o(); }
#[no_mangle]
pub unsafe fn test_nb() -> bool { return !test_b(); }
#[no_mangle]
pub unsafe fn test_nz() -> bool { return !test_z(); }
#[no_mangle]
pub unsafe fn test_ns() -> bool { return !test_s(); }
#[no_mangle]
pub unsafe fn test_np() -> bool { return !test_p(); }
#[no_mangle]
pub unsafe fn test_nbe() -> bool { return !test_be(); }
#[no_mangle]
pub unsafe fn test_nl() -> bool { return !test_l(); }
#[no_mangle]
pub unsafe fn test_nle() -> bool { return !test_le(); }
#[no_mangle]
pub unsafe fn jmp_rel16(mut rel16: i32) -> () {
    let mut cs_offset: i32 = get_seg_cs();
    c_comment!(("limit ip to 16 bit"));
    *instruction_pointer = cs_offset + (*instruction_pointer - cs_offset + rel16 & 65535i32);
}
#[no_mangle]
pub unsafe fn jmpcc16(mut condition: bool, mut imm16: i32) -> () {
    if condition {
        jmp_rel16(imm16);
    };
}
#[no_mangle]
pub unsafe fn jmpcc32(mut condition: bool, mut imm32: i32) -> () {
    if condition {
        *instruction_pointer += imm32
    };
}
#[no_mangle]
pub unsafe fn loope16(mut imm8s: i32) -> () {
    jmpcc16(0 != decr_ecx_asize() && 0 != getzf() as i32, imm8s);
}
#[no_mangle]
pub unsafe fn loopne16(mut imm8s: i32) -> () { jmpcc16(0 != decr_ecx_asize() && !getzf(), imm8s); }
#[no_mangle]
pub unsafe fn loop16(mut imm8s: i32) -> () { jmpcc16(0 != decr_ecx_asize(), imm8s); }
#[no_mangle]
pub unsafe fn jcxz16(mut imm8s: i32) -> () { jmpcc16(get_reg_asize(ECX) == 0i32, imm8s); }
#[no_mangle]
pub unsafe fn loope32(mut imm8s: i32) -> () {
    jmpcc32(0 != decr_ecx_asize() && 0 != getzf() as i32, imm8s);
}
#[no_mangle]
pub unsafe fn loopne32(mut imm8s: i32) -> () { jmpcc32(0 != decr_ecx_asize() && !getzf(), imm8s); }
#[no_mangle]
pub unsafe fn loop32(mut imm8s: i32) -> () { jmpcc32(0 != decr_ecx_asize(), imm8s); }
#[no_mangle]
pub unsafe fn jcxz32(mut imm8s: i32) -> () { jmpcc32(get_reg_asize(ECX) == 0i32, imm8s); }
#[no_mangle]
pub unsafe fn cmovcc16(mut condition: bool, mut value: i32, mut r: i32) -> () {
    if condition {
        write_reg16(r, value);
    };
}
#[no_mangle]
pub unsafe fn cmovcc32(mut condition: bool, mut value: i32, mut r: i32) -> () {
    if condition {
        write_reg32(r, value);
    };
}
#[no_mangle]
pub unsafe fn get_stack_pointer(mut offset: i32) -> i32 {
    if *stack_size_32 {
        return get_seg_ss() + *reg32s.offset(ESP as isize) + offset;
    }
    else {
        return get_seg_ss() + (*reg16.offset(SP as isize) as i32 + offset & 65535i32);
    };
}
#[no_mangle]
pub unsafe fn adjust_stack_reg(mut adjustment: i32) -> () {
    if *stack_size_32 {
        let ref mut fresh0 = *reg32s.offset(ESP as isize);
        *fresh0 += adjustment
    }
    else {
        let ref mut fresh1 = *reg16.offset(SP as isize);
        *fresh1 = (*fresh1 as i32 + adjustment) as u16
    };
}

#[no_mangle]
pub unsafe fn push16_ss16(mut imm16: i32) -> Result<(), ()> {
    let mut sp: i32 = get_seg_ss() + (*reg16.offset(SP as isize) as i32 - 2i32 & 65535i32);
    safe_write16(sp, imm16)?;
    let ref mut fresh2 = *reg16.offset(SP as isize);
    *fresh2 = (*fresh2 as i32 + -2i32) as u16;
    Ok(())
}
#[no_mangle]
pub unsafe fn push16_ss32(mut imm16: i32) -> Result<(), ()> {
    let mut sp: i32 = get_seg_ss() + *reg32s.offset(ESP as isize) - 2i32;
    safe_write16(sp, imm16)?;
    let ref mut fresh3 = *reg32s.offset(ESP as isize);
    *fresh3 += -2i32;
    Ok(())
}

#[no_mangle]
pub unsafe fn push16_ss16_jit(mut imm16: i32) { return_on_pagefault!(push16_ss16(imm16)) }
#[no_mangle]
pub unsafe fn push16_ss32_jit(mut imm16: i32) { return_on_pagefault!(push16_ss32(imm16)) }

#[no_mangle]
pub unsafe fn push16_ss16_mem(mut addr: i32) -> Result<(), ()> { push16_ss16(safe_read16(addr)?) }
#[no_mangle]
pub unsafe fn push16_ss32_mem(mut addr: i32) -> Result<(), ()> { push16_ss32(safe_read16(addr)?) }

#[no_mangle]
pub unsafe fn push16_ss16_mem_jit(mut addr: i32) { return_on_pagefault!(push16_ss16_mem(addr)) }
#[no_mangle]
pub unsafe fn push16_ss32_mem_jit(mut addr: i32) { return_on_pagefault!(push16_ss32_mem(addr)) }

#[no_mangle]
pub unsafe fn push16(mut imm16: i32) -> Result<(), ()> {
    if *stack_size_32 {
        push16_ss32(imm16)
    }
    else {
        push16_ss16(imm16)
    }
}

#[no_mangle]
pub unsafe fn push32_ss16(mut imm32: i32) -> Result<(), ()> {
    let mut new_sp: i32 = *reg16.offset(SP as isize) as i32 - 4i32 & 65535i32;
    safe_write32(get_seg_ss() + new_sp, imm32)?;
    *reg16.offset(SP as isize) = new_sp as u16;
    Ok(())
}
#[no_mangle]
pub unsafe fn push32_ss32(mut imm32: i32) -> Result<(), ()> {
    let mut new_esp: i32 = *reg32s.offset(ESP as isize) - 4i32;
    safe_write32(get_seg_ss() + new_esp, imm32)?;
    *reg32s.offset(ESP as isize) = new_esp;
    Ok(())
}

#[no_mangle]
pub unsafe fn push32_ss16_jit(mut imm32: i32) { return_on_pagefault!(push32_ss16(imm32)) }
#[no_mangle]
pub unsafe fn push32_ss32_jit(mut imm32: i32) { return_on_pagefault!(push32_ss32(imm32)) }

#[no_mangle]
pub unsafe fn push32_ss16_mem(mut addr: i32) -> Result<(), ()> { push32_ss16(safe_read32s(addr)?) }
#[no_mangle]
pub unsafe fn push32_ss32_mem(mut addr: i32) -> Result<(), ()> { push32_ss32(safe_read32s(addr)?) }

#[no_mangle]
pub unsafe fn push32_ss16_mem_jit(mut addr: i32) { return_on_pagefault!(push32_ss16_mem(addr)) }
#[no_mangle]
pub unsafe fn push32_ss32_mem_jit(mut addr: i32) { return_on_pagefault!(push32_ss32_mem(addr)) }

#[no_mangle]
pub unsafe fn push32(mut imm32: i32) -> Result<(), ()> {
    if *stack_size_32 {
        push32_ss32(imm32)
    }
    else {
        push32_ss16(imm32)
    }
}
#[no_mangle]
pub unsafe fn pop16() -> Result<i32, ()> {
    if *stack_size_32 {
        pop16_ss32()
    }
    else {
        pop16_ss16()
    }
}
#[no_mangle]
pub unsafe fn pop16_ss16() -> Result<i32, ()> {
    let mut sp: i32 = get_seg_ss() + *reg16.offset(SP as isize) as i32;
    let mut result: i32 = safe_read16(sp)?;
    let ref mut fresh4 = *reg16.offset(SP as isize);
    *fresh4 = (*fresh4 as i32 + 2i32) as u16;
    Ok(result)
}
#[no_mangle]
pub unsafe fn pop16_ss32() -> Result<i32, ()> {
    let mut esp: i32 = get_seg_ss() + *reg32s.offset(ESP as isize);
    let mut result: i32 = safe_read16(esp)?;
    let ref mut fresh5 = *reg32s.offset(ESP as isize);
    *fresh5 += 2i32;
    Ok(result)
}
#[no_mangle]
pub unsafe fn pop32s() -> Result<i32, ()> {
    if *stack_size_32 {
        pop32s_ss32()
    }
    else {
        pop32s_ss16()
    }
}
#[no_mangle]
pub unsafe fn pop32s_ss16() -> Result<i32, ()> {
    let mut sp: i32 = *reg16.offset(SP as isize) as i32;
    let mut result: i32 = safe_read32s(get_seg_ss() + sp)?;
    *reg16.offset(SP as isize) = (sp + 4i32) as u16;
    Ok(result)
}
#[no_mangle]
pub unsafe fn pop32s_ss32() -> Result<i32, ()> {
    let mut esp: i32 = *reg32s.offset(ESP as isize);
    let mut result: i32 = safe_read32s(get_seg_ss() + esp)?;
    *reg32s.offset(ESP as isize) = esp + 4i32;
    Ok(result)
}
#[no_mangle]
pub unsafe fn pusha16() -> () {
    let mut temp: u16 = *reg16.offset(SP as isize);
    c_comment!(("make sure we don\'t get a pagefault after having"));
    c_comment!(("pushed several registers already"));
    return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-16i32), 16i32));
    push16(*reg16.offset(AX as isize) as i32).unwrap();
    push16(*reg16.offset(CX as isize) as i32).unwrap();
    push16(*reg16.offset(DX as isize) as i32).unwrap();
    push16(*reg16.offset(BX as isize) as i32).unwrap();
    push16(temp as i32).unwrap();
    push16(*reg16.offset(BP as isize) as i32).unwrap();
    push16(*reg16.offset(SI as isize) as i32).unwrap();
    push16(*reg16.offset(DI as isize) as i32).unwrap();
}
#[no_mangle]
pub unsafe fn pusha32() -> () {
    let mut temp: i32 = *reg32s.offset(ESP as isize);
    return_on_pagefault!(writable_or_pagefault(get_stack_pointer(-32i32), 32i32));
    push32(*reg32s.offset(EAX as isize)).unwrap();
    push32(*reg32s.offset(ECX as isize)).unwrap();
    push32(*reg32s.offset(EDX as isize)).unwrap();
    push32(*reg32s.offset(EBX as isize)).unwrap();
    push32(temp).unwrap();
    push32(*reg32s.offset(EBP as isize)).unwrap();
    push32(*reg32s.offset(ESI as isize)).unwrap();
    push32(*reg32s.offset(EDI as isize)).unwrap();
}
#[no_mangle]
pub unsafe fn setcc_reg(mut condition: bool, mut r: i32) -> () {
    write_reg8(r, if 0 != condition as i32 { 1i32 } else { 0i32 });
}
#[no_mangle]
pub unsafe fn setcc_mem(mut condition: bool, mut addr: i32) -> () {
    return_on_pagefault!(safe_write8(
        addr,
        if 0 != condition as i32 { 1i32 } else { 0i32 }
    ));
}
#[no_mangle]
pub unsafe fn fxsave(mut addr: u32) -> () {
    return_on_pagefault!(writable_or_pagefault(addr as i32, 512i32));
    safe_write16(addr.wrapping_add(0i32 as u32) as i32, *fpu_control_word).unwrap();
    safe_write16(
        addr.wrapping_add(2i32 as u32) as i32,
        fpu_load_status_word(),
    ).unwrap();
    safe_write8(
        addr.wrapping_add(4i32 as u32) as i32,
        !*fpu_stack_empty & 255i32,
    ).unwrap();
    safe_write16(addr.wrapping_add(6i32 as u32) as i32, *fpu_opcode).unwrap();
    safe_write32(addr.wrapping_add(8i32 as u32) as i32, *fpu_ip).unwrap();
    safe_write16(addr.wrapping_add(12i32 as u32) as i32, *fpu_ip_selector).unwrap();
    safe_write32(addr.wrapping_add(16i32 as u32) as i32, *fpu_dp).unwrap();
    safe_write16(addr.wrapping_add(20i32 as u32) as i32, *fpu_dp_selector).unwrap();
    safe_write32(addr.wrapping_add(24i32 as u32) as i32, *mxcsr).unwrap();
    safe_write32(addr.wrapping_add(28i32 as u32) as i32, MXCSR_MASK).unwrap();
    let mut i: i32 = 0i32;
    while i < 8i32 {
        fpu_store_m80(
            addr.wrapping_add(32i32 as u32)
                .wrapping_add((i << 4i32) as u32),
            *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(i as u32) & 7i32 as u32) as isize),
        );
        i += 1
    }
    c_comment!(("If the OSFXSR bit in control register CR4 is not set, the FXSAVE"));
    c_comment!(("instruction may not save these registers. This behavior is"));
    c_comment!(("implementation dependent."));
    let mut i_0: i32 = 0i32;
    while i_0 < 8i32 {
        safe_write128(
            addr.wrapping_add(160i32 as u32)
                .wrapping_add((i_0 << 4i32) as u32) as i32,
            *reg_xmm.offset(i_0 as isize),
        ).unwrap();
        i_0 += 1
    }
}
#[no_mangle]
pub unsafe fn fxrstor(mut addr: u32) -> () {
    // TODO: Add readable_or_pagefault
    return_on_pagefault!(translate_address_read(addr as i32));
    return_on_pagefault!(translate_address_read(
        addr.wrapping_add(511i32 as u32) as i32
    ));
    let mut new_mxcsr: i32 = safe_read32s(addr.wrapping_add(24i32 as u32) as i32).unwrap();
    if 0 != new_mxcsr & !MXCSR_MASK {
        dbg_log_c!("#gp Invalid mxcsr bits");
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        *fpu_control_word = safe_read16(addr.wrapping_add(0i32 as u32) as i32).unwrap();
        fpu_set_status_word(safe_read16(addr.wrapping_add(2i32 as u32) as i32).unwrap());
        *fpu_stack_empty = !safe_read8(addr.wrapping_add(4i32 as u32) as i32).unwrap() & 255i32;
        *fpu_opcode = safe_read16(addr.wrapping_add(6i32 as u32) as i32).unwrap();
        *fpu_ip = safe_read32s(addr.wrapping_add(8i32 as u32) as i32).unwrap();
        *fpu_ip = safe_read16(addr.wrapping_add(12i32 as u32) as i32).unwrap();
        *fpu_dp = safe_read32s(addr.wrapping_add(16i32 as u32) as i32).unwrap();
        *fpu_dp_selector = safe_read16(addr.wrapping_add(20i32 as u32) as i32).unwrap();
        set_mxcsr(new_mxcsr);
        let mut i: i32 = 0i32;
        while i < 8i32 {
            *fpu_st.offset(((*fpu_stack_ptr).wrapping_add(i as u32) & 7i32 as u32) as isize) =
                fpu_load_m80(
                    addr.wrapping_add(32i32 as u32)
                        .wrapping_add((i << 4i32) as u32),
                ).unwrap();
            i += 1
        }
        let mut i_0: i32 = 0i32;
        while i_0 < 8i32 {
            (*reg_xmm.offset(i_0 as isize)).u32_0[0usize] = safe_read32s(
                addr.wrapping_add(160i32 as u32)
                    .wrapping_add((i_0 << 4i32) as u32)
                    .wrapping_add(0i32 as u32) as i32,
            ).unwrap() as u32;
            (*reg_xmm.offset(i_0 as isize)).u32_0[1usize] = safe_read32s(
                addr.wrapping_add(160i32 as u32)
                    .wrapping_add((i_0 << 4i32) as u32)
                    .wrapping_add(4i32 as u32) as i32,
            ).unwrap() as u32;
            (*reg_xmm.offset(i_0 as isize)).u32_0[2usize] = safe_read32s(
                addr.wrapping_add(160i32 as u32)
                    .wrapping_add((i_0 << 4i32) as u32)
                    .wrapping_add(8i32 as u32) as i32,
            ).unwrap() as u32;
            (*reg_xmm.offset(i_0 as isize)).u32_0[3usize] = safe_read32s(
                addr.wrapping_add(160i32 as u32)
                    .wrapping_add((i_0 << 4i32) as u32)
                    .wrapping_add(12i32 as u32) as i32,
            ).unwrap() as u32;
            i_0 += 1
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn xchg8(mut data: i32, mut r8: i32) -> i32 {
    let mut tmp: i32 = *reg8.offset(r8 as isize) as i32;
    *reg8.offset(r8 as isize) = data as u8;
    return tmp;
}
#[no_mangle]
pub unsafe fn xchg16(mut data: i32, mut r16: i32) -> i32 {
    let mut tmp: i32 = *reg16.offset(r16 as isize) as i32;
    *reg16.offset(r16 as isize) = data as u16;
    return tmp;
}
#[no_mangle]
pub unsafe fn xchg16r(mut r16: i32) -> () {
    let mut tmp: i32 = *reg16.offset(AX as isize) as i32;
    *reg16.offset(AX as isize) = *reg16.offset(r16 as isize);
    *reg16.offset(r16 as isize) = tmp as u16;
}
#[no_mangle]
pub unsafe fn xchg32(mut data: i32, mut r32: i32) -> i32 {
    let mut tmp: i32 = *reg32s.offset(r32 as isize);
    *reg32s.offset(r32 as isize) = data;
    return tmp;
}
#[no_mangle]
pub unsafe fn xchg32r(mut r32: i32) -> () {
    let mut tmp: i32 = *reg32s.offset(EAX as isize);
    *reg32s.offset(EAX as isize) = *reg32s.offset(r32 as isize);
    *reg32s.offset(r32 as isize) = tmp;
}

#[no_mangle]
pub unsafe fn bswap(r: i32) { write_reg32(r, read_reg32(r).swap_bytes()) }
