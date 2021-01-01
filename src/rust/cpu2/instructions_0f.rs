#![allow(non_snake_case, non_upper_case_globals, unused_variables)]

extern "C" {
    #[no_mangle]
    fn unimplemented_sse();
    #[no_mangle]
    fn undefined_instruction();
    #[no_mangle]
    fn lss16(x: i32, y: i32, z: i32);
    #[no_mangle]
    fn lss32(x: i32, y: i32, z: i32);
    #[no_mangle]
    fn get_rand_int() -> i32;
    #[no_mangle]
    fn cpuid();
    #[no_mangle]
    fn lsl(r: i32, v: i32) -> i32;
    #[no_mangle]
    fn lar(r: i32, v: i32) -> i32;
    #[no_mangle]
    fn verw(r: i32);
    #[no_mangle]
    fn verr(r: i32);
    #[no_mangle]
    fn load_tr(v: i32);
    #[no_mangle]
    fn load_ldt(v: i32);
}

use cpu2::arith::{
    bsf16, bsf32, bsr16, bsr32, bt_mem, bt_reg, btc_mem, btc_reg, btr_mem, btr_reg, bts_mem,
    bts_reg, cmpxchg16, cmpxchg32, cmpxchg8, popcnt, shld16, shld32, shrd16, shrd32, xadd16,
    xadd32, xadd8,
};
use cpu2::arith::{
    imul_reg16, imul_reg32, saturate_sd_to_sb, saturate_sd_to_sw, saturate_sd_to_ub,
    saturate_sw_to_sb, saturate_sw_to_ub, saturate_ud_to_ub, saturate_uw,
};
use cpu2::cpu::*;
use cpu2::fpu::fpu_load_m32;
use cpu2::fpu::fpu_set_tag_word;
use cpu2::global_pointers::*;
use cpu2::misc_instr::{
    adjust_stack_reg, bswap, cmovcc16, cmovcc32, fxrstor, fxsave, get_stack_pointer, jmpcc16,
    jmpcc32, push16, push32, setcc_mem, setcc_reg, test_b, test_be, test_l, test_le, test_o,
    test_p, test_s, test_z,
};
use cpu2::sse_instr::*;

pub static mut apic_enabled: bool = false;
const ENABLE_ACPI: bool = false;

#[no_mangle]
pub unsafe fn instr_0F00_0_mem(addr: i32) {
    // sldt
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    else {
        return_on_pagefault!(safe_write16(addr, *sreg.offset(LDTR as isize) as i32));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_0_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    else {
        write_reg_osize(r, *sreg.offset(LDTR as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_1_mem(addr: i32) {
    // str
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    else {
        return_on_pagefault!(safe_write16(addr, *sreg.offset(TR as isize) as i32));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_1_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    else {
        write_reg_osize(r, *sreg.offset(TR as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_2_mem(addr: i32) {
    // lldt
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    else if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        load_ldt(return_on_pagefault!(safe_read16(addr)));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_2_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    else if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        load_ldt(read_reg16(r));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_3_mem(addr: i32) {
    // ltr
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    else if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        load_tr(return_on_pagefault!(safe_read16(addr)));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_3_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    else if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        load_tr(read_reg16(r));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_4_mem(addr: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("verr #ud");
        trigger_ud();
        return;
    }
    verr(return_on_pagefault!(safe_read16(addr)));
}
#[no_mangle]
pub unsafe fn instr_0F00_4_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("verr #ud");
        trigger_ud();
        return;
    }
    verr(read_reg16(r));
}
#[no_mangle]
pub unsafe fn instr_0F00_5_mem(addr: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("verw #ud");
        trigger_ud();
        return;
    }
    verw(return_on_pagefault!(safe_read16(addr)));
}
#[no_mangle]
pub unsafe fn instr_0F00_5_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("verw #ud");
        trigger_ud();
        return;
    }
    verw(read_reg16(r));
}
#[no_mangle]
pub unsafe fn instr_0F01_0_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F01_0_mem(addr: i32) {
    // sgdt
    return_on_pagefault!(writable_or_pagefault(addr, 6));
    let mask = if is_osize_32() { -1 } else { 0xFFFFFF };
    safe_write16(addr, *gdtr_size).unwrap();
    safe_write32(addr + 2, *gdtr_offset & mask).unwrap();
}
#[no_mangle]
pub unsafe fn instr_0F01_1_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F01_1_mem(addr: i32) {
    // sidt
    return_on_pagefault!(writable_or_pagefault(addr, 6));
    let mask = if is_osize_32() { -1 } else { 0xFFFFFF };
    safe_write16(addr, *idtr_size).unwrap();
    safe_write32(addr + 2, *idtr_offset & mask).unwrap();
}
#[no_mangle]
pub unsafe fn instr_0F01_2_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F01_2_mem(addr: i32) {
    // lgdt
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        let size = return_on_pagefault!(safe_read16(addr));
        let offset = return_on_pagefault!(safe_read32s(addr + 2));
        let mask = if is_osize_32() { -1 } else { 0xFFFFFF };
        *gdtr_size = size;
        *gdtr_offset = offset & mask;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F01_3_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F01_3_mem(addr: i32) {
    // lidt
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        let size = return_on_pagefault!(safe_read16(addr));
        let offset = return_on_pagefault!(safe_read32s(addr + 2));
        let mask = if is_osize_32() { -1 } else { 0xFFFFFF };
        *idtr_size = size;
        *idtr_offset = offset & mask;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F01_4_reg(r: i32) {
    // smsw
    write_reg_osize(r, *cr);
}
#[no_mangle]
pub unsafe fn instr_0F01_4_mem(addr: i32) {
    return_on_pagefault!(safe_write16(addr, *cr & 0xFFFF));
}
#[no_mangle]
pub unsafe fn lmsw(mut new_cr0: i32) {
    new_cr0 = *cr & !15 | new_cr0 & 15;
    if *protected_mode {
        // lmsw cannot be used to switch back
        new_cr0 |= CR0_PE
    }
    set_cr0(new_cr0);
}
#[no_mangle]
pub unsafe fn instr_0F01_6_reg(r: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        lmsw(read_reg16(r));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F01_6_mem(addr: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        lmsw(return_on_pagefault!(safe_read16(addr)));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F01_7_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F01_7_mem(addr: i32) {
    // invlpg
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        invlpg(addr);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_0F02_mem(addr: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lar #ud");
        trigger_ud();
        return;
    }
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, lar(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_0F02_reg(r1: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lar #ud");
        trigger_ud();
        return;
    }
    let ____0 = read_reg16(r1);
    write_reg16(r, lar(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_0F02_mem(addr: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lar #ud");
        trigger_ud();
        return;
    }
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg32(r, lar(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_0F02_reg(r1: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lar #ud");
        trigger_ud();
        return;
    }
    let ____0 = read_reg16(r1);
    write_reg32(r, lar(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr16_0F03_mem(addr: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lsl #ud");
        trigger_ud();
        return;
    }
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, lsl(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_0F03_reg(r1: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lsl #ud");
        trigger_ud();
        return;
    }
    let ____0 = read_reg16(r1);
    write_reg16(r, lsl(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_0F03_mem(addr: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lsl #ud");
        trigger_ud();
        return;
    }
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg32(r, lsl(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_0F03_reg(r1: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lsl #ud");
        trigger_ud();
        return;
    }
    let ____0 = read_reg16(r1);
    write_reg32(r, lsl(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_0F04() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F05() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F06() {
    // clts
    if 0 != *cpl {
        dbg_log!("clts #gp");
        trigger_gp(0);
    }
    else {
        if false {
            dbg_log!("clts");
        }
        *cr &= !CR0_TS;
    };
}
#[no_mangle]
pub unsafe fn instr_0F07() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F08() {
    // invd
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0F09() {
    if 0 != *cpl {
        dbg_log!("wbinvd #gp");
        trigger_gp(0);
    }
    else {
        // wbinvd
    };
}
#[no_mangle]
pub unsafe fn instr_0F0A() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F0B() {
    // UD2
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_0F0C() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F0D() {
    // nop
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0F0E() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F0F() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F10(source: reg128, r: i32) {
    // movups xmm, xmm/m128
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F10_reg(r1: i32, r2: i32) { instr_0F10(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F10_mem(addr: i32, r: i32) {
    instr_0F10(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F10_reg(r1: i32, r2: i32) {
    // movss xmm, xmm/m32
    let data = read_xmm128s(r1);
    let orig = read_xmm128s(r2);
    write_xmm128(
        r2,
        data.u32_0[0] as i32,
        orig.u32_0[1] as i32,
        orig.u32_0[2] as i32,
        orig.u32_0[3] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F30F10_mem(addr: i32, r: i32) {
    // movss xmm, xmm/m32
    let data = return_on_pagefault!(safe_read32s(addr));
    write_xmm128(r, data, 0, 0, 0);
}
#[no_mangle]
pub unsafe fn instr_660F10(source: reg128, r: i32) {
    // movupd xmm, xmm/m128
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F10_reg(r1: i32, r2: i32) { instr_660F10(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F10_mem(addr: i32, r: i32) {
    instr_660F10(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F10_reg(r1: i32, r2: i32) {
    // movsd xmm, xmm/m64
    let data = read_xmm128s(r1);
    let orig = read_xmm128s(r2);
    write_xmm128(
        r2,
        data.u32_0[0] as i32,
        data.u32_0[1] as i32,
        orig.u32_0[2] as i32,
        orig.u32_0[3] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F20F10_mem(addr: i32, r: i32) {
    // movsd xmm, xmm/m64
    let data = return_on_pagefault!(safe_read64s(addr));
    write_xmm128(r, data.u32_0[0] as i32, data.u32_0[1] as i32, 0, 0);
}
#[no_mangle]
pub unsafe fn instr_0F11_reg(r1: i32, r2: i32) {
    // movups xmm/m128, xmm
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr_0F11_mem(addr: i32, r: i32) {
    // movups xmm/m128, xmm
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_F30F11_reg(rm_dest: i32, reg_src: i32) {
    // movss xmm/m32, xmm
    let data = read_xmm128s(reg_src);
    let orig = read_xmm128s(rm_dest);
    write_xmm128(
        rm_dest,
        data.u32_0[0] as i32,
        orig.u32_0[1] as i32,
        orig.u32_0[2] as i32,
        orig.u32_0[3] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F30F11_mem(addr: i32, r: i32) {
    // movss xmm/m32, xmm
    let data = read_xmm128s(r);
    return_on_pagefault!(safe_write32(addr, data.u32_0[0] as i32));
}
#[no_mangle]
pub unsafe fn instr_660F11_reg(r1: i32, r2: i32) {
    // movupd xmm/m128, xmm
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr_660F11_mem(addr: i32, r: i32) {
    // movupd xmm/m128, xmm
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_F20F11_reg(r1: i32, r2: i32) {
    // movsd xmm/m64, xmm
    let data = read_xmm128s(r2);
    let orig = read_xmm128s(r1);
    write_xmm128(
        r1,
        data.u32_0[0] as i32,
        data.u32_0[1] as i32,
        orig.u32_0[2] as i32,
        orig.u32_0[3] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F20F11_mem(addr: i32, r: i32) {
    // movsd xmm/m64, xmm
    let data = read_xmm64s(r);
    return_on_pagefault!(safe_write64(addr, data.u64_0[0] as i64));
}
#[no_mangle]
pub unsafe fn instr_0F12_mem(addr: i32, r: i32) {
    // movlps xmm, m64
    let data = return_on_pagefault!(safe_read64s(addr));
    let orig = read_xmm128s(r);
    write_xmm128(
        r,
        data.u32_0[0] as i32,
        data.u32_0[1] as i32,
        orig.u32_0[2] as i32,
        orig.u32_0[3] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0F12_reg(r1: i32, r2: i32) {
    // movhlps xmm, xmm
    let data = read_xmm128s(r1);
    let orig = read_xmm128s(r2);
    write_xmm128(
        r2,
        data.u32_0[2] as i32,
        data.u32_0[3] as i32,
        orig.u32_0[2] as i32,
        orig.u32_0[3] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F12_reg(r1: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F12_mem(addr: i32, r: i32) {
    // movlpd xmm, m64
    let data = return_on_pagefault!(safe_read64s(addr));
    write_xmm64(r, data);
}
#[no_mangle]
pub unsafe fn instr_F20F12_mem(addr: i32, r: i32) { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F20F12_reg(r1: i32, r2: i32) { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F30F12_mem(addr: i32, r: i32) { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F30F12_reg(r1: i32, r2: i32) { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F13_mem(addr: i32, r: i32) {
    // movlps m64, xmm
    movl_r128_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F13_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F13_reg(r1: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F13_mem(addr: i32, r: i32) {
    // movlpd xmm/m64, xmm
    movl_r128_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F14(source: reg64, r: i32) {
    // unpcklps xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm64s(r);
    write_xmm128(
        r,
        destination.u32_0[0] as i32,
        source.u32_0[0] as i32,
        destination.u32_0[1] as i32,
        source.u32_0[1] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0F14_reg(r1: i32, r2: i32) { instr_0F14(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F14_mem(addr: i32, r: i32) {
    instr_0F14(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F14(source: reg64, r: i32) {
    // unpcklpd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm64s(r);
    write_xmm128(
        r,
        destination.u32_0[0] as i32,
        destination.u32_0[1] as i32,
        source.u32_0[0] as i32,
        source.u32_0[1] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F14_reg(r1: i32, r2: i32) { instr_660F14(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F14_mem(addr: i32, r: i32) {
    instr_660F14(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F15(source: reg128, r: i32) {
    // unpckhps xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[2] as i32,
        source.u32_0[2] as i32,
        destination.u32_0[3] as i32,
        source.u32_0[3] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0F15_reg(r1: i32, r2: i32) { instr_0F15(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F15_mem(addr: i32, r: i32) {
    instr_0F15(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F15(source: reg128, r: i32) {
    // unpckhpd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[2] as i32,
        destination.u32_0[3] as i32,
        source.u32_0[2] as i32,
        source.u32_0[3] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F15_reg(r1: i32, r2: i32) { instr_660F15(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F15_mem(addr: i32, r: i32) {
    instr_660F15(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F16_mem(addr: i32, r: i32) {
    // movhps xmm, m64
    movh_m64_r128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F16_reg(r1: i32, r2: i32) {
    // movlhps xmm, xmm
    let data = read_xmm128s(r1);
    let orig = read_xmm128s(r2);
    write_xmm128(
        r2,
        orig.u32_0[0] as i32,
        orig.u32_0[1] as i32,
        data.u32_0[0] as i32,
        data.u32_0[1] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F16_mem(addr: i32, r: i32) {
    // movhpd xmm, m64
    movh_m64_r128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_660F16_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F17_mem(addr: i32, r: i32) {
    // movhps m64, xmm
    movh_r128_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F17_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F17_mem(addr: i32, r: i32) {
    // movhpd m64, xmm
    movh_r128_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_660F17_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F18_reg(r1: i32, r2: i32) {
    // reserved nop
}
#[no_mangle]
pub unsafe fn instr_0F18_mem(addr: i32, r: i32) {
    // prefetch
    // nop for us
}
#[no_mangle]
pub unsafe fn instr_0F1A() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F1B() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F1F_reg(r1: i32, r2: i32) {}
#[no_mangle]
pub unsafe fn instr_0F1F_mem(addr: i32, r: i32) {}
#[no_mangle]
pub unsafe fn instr_0F20(r: i32, creg: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        match creg {
            0 => {
                write_reg32(r, *cr);
            },
            2 => {
                write_reg32(r, *cr.offset(2));
            },
            3 => {
                write_reg32(r, *cr.offset(3));
            },
            4 => {
                write_reg32(r, *cr.offset(4));
            },
            _ => {
                dbg_log!("{}", creg);
                undefined_instruction();
            },
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F21(r: i32, mut dreg_index: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        if dreg_index == 4 || dreg_index == 5 {
            if 0 != *cr.offset(4) & CR4_DE {
                dbg_log!("#ud mov dreg 4/5 with cr4.DE set");
                trigger_ud();
                return;
            }
            else {
                // DR4 and DR5 refer to DR6 and DR7 respectively
                dreg_index += 2
            }
        }
        write_reg32(r, *dreg.offset(dreg_index as isize));
        if false {
            dbg_log!(
                "read dr{}: {:x}",
                dreg_index,
                *dreg.offset(dreg_index as isize)
            );
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F22(r: i32, creg: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        let mut data: i32 = read_reg32(r);
        // mov cr, addr
        match creg {
            0 => {
                if false {
                    dbg_log!("cr0 <- {:x}", data);
                }
                set_cr0(data);
            },
            2 => {
                dbg_log!("cr2 <- {:x}", data);
                *cr.offset(2) = data
            },
            3 => {
                if false {
                    dbg_log!("cr3 <- {:x}", data);
                }
                data &= !0b111111100111;
                dbg_assert!(data & 0xFFF == 0, "TODO");
                *cr.offset(3) = data;
                clear_tlb();
            },
            4 => {
                dbg_log!("cr4 <- {:x}", *cr.offset(4));
                if 0 != data as u32
                    & ((1 << 11 | 1 << 12 | 1 << 15 | 1 << 16 | 1 << 19) as u32 | 0xFFC00000)
                {
                    dbg_log!("trigger_gp: Invalid cr4 bit");
                    trigger_gp(0);
                    return;
                }
                else {
                    if 0 != (*cr.offset(4) ^ data) & (CR4_PGE | CR4_PSE) {
                        full_clear_tlb();
                    }
                    *cr.offset(4) = data;
                    if 0 != *cr.offset(4) & CR4_PAE {
                        dbg_assert!(false);
                    }
                }
            },
            _ => {
                dbg_log!("{}", creg);
                undefined_instruction();
            },
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F23(r: i32, mut dreg_index: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        if dreg_index == 4 || dreg_index == 5 {
            if 0 != *cr.offset(4) & CR4_DE {
                dbg_log!("#ud mov dreg 4/5 with cr4.DE set");
                trigger_ud();
                return;
            }
            else {
                // DR4 and DR5 refer to DR6 and DR7 respectively
                dreg_index += 2
            }
        }
        *dreg.offset(dreg_index as isize) = read_reg32(r);
        if false {
            dbg_log!(
                "write dr{}: {:x}",
                dreg_index,
                *dreg.offset(dreg_index as isize)
            );
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F24() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F25() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F26() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F27() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F28(source: reg128, r: i32) {
    // movaps xmm, xmm/m128
    // XXX: Aligned read or #gp
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F28_reg(r1: i32, r2: i32) { instr_0F28(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F28_mem(addr: i32, r: i32) {
    instr_0F28(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F28(source: reg128, r: i32) {
    // movapd xmm, xmm/m128
    // XXX: Aligned read or #gp
    // Note: Same as movdqa (660F6F)
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F28_reg(r1: i32, r2: i32) { instr_660F28(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F28_mem(addr: i32, r: i32) {
    instr_660F28(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F29_mem(addr: i32, r: i32) {
    // movaps m128, xmm
    let data = read_xmm128s(r);
    // XXX: Aligned write or #gp
    return_on_pagefault!(safe_write128(addr, data));
}
#[no_mangle]
pub unsafe fn instr_0F29_reg(r1: i32, r2: i32) {
    // movaps xmm, xmm
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr_660F29_mem(addr: i32, r: i32) {
    // movapd m128, xmm
    let data = read_xmm128s(r);
    // XXX: Aligned write or #gp
    return_on_pagefault!(safe_write128(addr, data));
}
#[no_mangle]
pub unsafe fn instr_660F29_reg(r1: i32, r2: i32) {
    // movapd xmm, xmm
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr_0F2B_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F2B_mem(addr: i32, r: i32) {
    // movntps m128, xmm
    // XXX: Aligned write or #gp
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_660F2B_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F2B_mem(addr: i32, r: i32) {
    // movntpd m128, xmm
    // XXX: Aligned write or #gp
    mov_r_m128(addr, r);
}

#[no_mangle]
pub unsafe fn instr_0F2C(source: reg64, r: i32) {
    // cvttps2pi mm, xmm/m64
    let result = reg64 {
        i32_0: [
            sse_convert_f32_to_i32(source.f32_0[0].trunc()),
            sse_convert_f32_to_i32(source.f32_0[1].trunc()),
        ],
    };
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F2C_mem(addr: i32, r: i32) {
    instr_0F2C(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F2C_reg(r1: i32, r2: i32) { instr_0F2C(read_xmm64s(r1), r2); }

#[no_mangle]
pub unsafe fn instr_660F2C(source: reg128, r: i32) {
    // cvttpd2pi mm, xmm/m128
    let result = reg64 {
        // XXX: Check conversion
        i32_0: [
            sse_convert_f64_to_i32(source.f64_0[0]),
            sse_convert_f64_to_i32(source.f64_0[1]),
        ],
    };
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_660F2C_mem(addr: i32, r: i32) {
    instr_660F2C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F2C_reg(r1: i32, r2: i32) { instr_660F2C(read_xmm128s(r1), r2); }

#[no_mangle]
pub unsafe fn instr_F20F2C(source: reg64, r: i32) {
    // cvttsd2si r32, xmm/m64
    write_reg32(r, sse_convert_f64_to_i32(source.f64_0[0]));
}
#[no_mangle]
pub unsafe fn instr_F20F2C_reg(r1: i32, r2: i32) { instr_F20F2C(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F2C_mem(addr: i32, r: i32) {
    instr_F20F2C(return_on_pagefault!(safe_read64s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_F30F2C(source: f32, r: i32) {
    let result = source.trunc();
    write_reg32(r, sse_convert_f32_to_i32(source));
}
#[no_mangle]
pub unsafe fn instr_F30F2C_mem(addr: i32, r: i32) {
    instr_F30F2C(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_F30F2C_reg(r1: i32, r2: i32) { instr_F30F2C(read_xmm_f32(r1), r2); }

pub unsafe fn instr_0F2E(source: f32, r: i32) {
    // ucomiss xmm1, xmm2/m32
    let destination = read_xmm_f32(r);
    *flags_changed = 0;
    *flags &= !FLAGS_ALL;
    if destination == source {
        *flags |= FLAG_ZERO
    }
    else if destination < source {
        *flags |= FLAG_CARRY
    }
    else if destination > source {
        // all flags cleared
    }
    else {
        // TODO: Signal on SNaN
        *flags |= FLAG_ZERO | FLAG_PARITY | FLAG_CARRY
    }
}
#[no_mangle]
pub unsafe fn instr_0F2E_reg(r1: i32, r2: i32) { instr_0F2E(read_xmm_f32(r1), r2) }
#[no_mangle]
pub unsafe fn instr_0F2E_mem(addr: i32, r: i32) {
    instr_0F2E(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}

pub unsafe fn instr_660F2E(source: reg64, r: i32) {
    // ucomisd xmm1, xmm2/m64
    let destination = read_xmm64s(r).f64_0[0];
    let source = source.f64_0[0];
    *flags_changed = 0;
    *flags &= !FLAGS_ALL;
    if destination == source {
        *flags |= FLAG_ZERO
    }
    else if destination < source {
        *flags |= FLAG_CARRY
    }
    else if destination > source {
        // all flags cleared
    }
    else {
        // TODO: Signal on SNaN
        *flags |= FLAG_ZERO | FLAG_PARITY | FLAG_CARRY
    }
}
#[no_mangle]
pub unsafe fn instr_660F2E_reg(r1: i32, r: i32) { instr_660F2E(read_xmm64s(r1), r); }
#[no_mangle]
pub unsafe fn instr_660F2E_mem(addr: i32, r: i32) {
    instr_660F2E(return_on_pagefault!(safe_read64s(addr)), r)
}

pub unsafe fn instr_0F2F(source: f32, r: i32) {
    // comiss xmm1, xmm2/m32
    let destination = read_xmm_f32(r);
    *flags_changed = 0;
    *flags &= !FLAGS_ALL;
    if destination == source {
        *flags |= FLAG_ZERO
    }
    else if destination < source {
        *flags |= FLAG_CARRY
    }
    else if destination > source {
        // all flags cleared
    }
    else {
        // TODO: Signal on SNaN or QNaN
        *flags |= FLAG_ZERO | FLAG_PARITY | FLAG_CARRY
    }
}
#[no_mangle]
pub unsafe fn instr_0F2F_reg(r1: i32, r2: i32) { instr_0F2F(read_xmm_f32(r1), r2) }
#[no_mangle]
pub unsafe fn instr_0F2F_mem(addr: i32, r: i32) {
    instr_0F2F(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}

pub unsafe fn instr_660F2F(source: reg64, r: i32) {
    // comisd xmm1, xmm2/m64
    let destination = read_xmm64s(r).f64_0[0];
    let source = source.f64_0[0];
    *flags_changed = 0;
    *flags &= !FLAGS_ALL;
    if destination == source {
        *flags |= FLAG_ZERO
    }
    else if destination < source {
        *flags |= FLAG_CARRY
    }
    else if destination > source {
        // all flags cleared
    }
    else {
        // TODO: Signal on SNaN or QNaN
        *flags |= FLAG_ZERO | FLAG_PARITY | FLAG_CARRY
    }
}
#[no_mangle]
pub unsafe fn instr_660F2F_reg(r1: i32, r: i32) { instr_660F2F(read_xmm64s(r1), r); }
#[no_mangle]
pub unsafe fn instr_660F2F_mem(addr: i32, r: i32) {
    instr_660F2F(return_on_pagefault!(safe_read64s(addr)), r)
}

#[no_mangle]
pub unsafe fn instr_0F30() {
    // wrmsr - write maschine specific register
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        let index = *reg32.offset(ECX as isize);
        let low = *reg32.offset(EAX as isize);
        let high = *reg32.offset(EDX as isize);
        if index != IA32_SYSENTER_ESP {
            dbg_log!("wrmsr ecx={:x} data={:x}:{:x}", index, high, low);
        }
        if index == IA32_SYSENTER_CS {
            *sysenter_cs = low & 0xFFFF
        }
        else if index == IA32_SYSENTER_EIP {
            *sysenter_eip = low
        }
        else if index == IA32_SYSENTER_ESP {
            *sysenter_esp = low
        }
        else if index == IA32_APIC_BASE_MSR {
            dbg_assert!(
                high == 0,
                ("Changing APIC address (high 32 bits) not supported")
            );
            let address = low & !(IA32_APIC_BASE_BSP | IA32_APIC_BASE_EXTD | IA32_APIC_BASE_EN);
            dbg_assert!(
                address == APIC_ADDRESS,
                ("Changing APIC address not supported")
            );
            dbg_assert!(low & IA32_APIC_BASE_EXTD == 0, "x2apic not supported");
            apic_enabled = low & IA32_APIC_BASE_EN == IA32_APIC_BASE_EN
        }
        else if index == IA32_TIME_STAMP_COUNTER {
            set_tsc(low as u32, high as u32);
        }
        else if !(index == IA32_BIOS_SIGN_ID) {
            if index == MSR_MISC_FEATURE_ENABLES {
                // Linux 4, see: https://patchwork.kernel.org/patch/9528279/
            }
            else if index == IA32_MISC_ENABLE {
                // Enable Misc. Processor Features
            }
            else if index == IA32_MCG_CAP {
                // netbsd
            }
            else if index == IA32_KERNEL_GS_BASE {
                // Only used in 64 bit mode (by SWAPGS), but set by kvm-unit-test
                dbg_log!("GS Base written");
            }
            else {
                dbg_log!("Unknown msr: {:x}", index);
                dbg_assert!(false);
            }
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F31() {
    // rdtsc - read timestamp counter
    if 0 == *cpl || 0 == *cr.offset(4) & CR4_TSD {
        let tsc = read_tsc();
        *reg32.offset(EAX as isize) = tsc as i32;
        *reg32.offset(EDX as isize) = (tsc >> 32) as i32;
        if false {
            dbg_log!(
                "rdtsc  edx:eax={:x}:{:x}",
                *reg32.offset(EDX as isize),
                *reg32.offset(EAX as isize)
            );
        }
    }
    else {
        trigger_gp(0);
    };
}
#[no_mangle]
pub unsafe fn instr_0F32() {
    // rdmsr - read maschine specific register
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    else {
        let index = *reg32.offset(ECX as isize);
        dbg_log!("rdmsr ecx={:x}", index);
        let mut low: i32 = 0;
        let mut high: i32 = 0;
        if index == IA32_SYSENTER_CS {
            low = *sysenter_cs
        }
        else if index == IA32_SYSENTER_EIP {
            low = *sysenter_eip
        }
        else if index == IA32_SYSENTER_ESP {
            low = *sysenter_esp
        }
        else if index == IA32_TIME_STAMP_COUNTER {
            let tsc = read_tsc();
            low = tsc as i32;
            high = (tsc >> 32) as i32
        }
        else if !(index == IA32_PLATFORM_ID) {
            if index == IA32_APIC_BASE_MSR {
                if ENABLE_ACPI {
                    low = APIC_ADDRESS;
                    if apic_enabled {
                        low |= IA32_APIC_BASE_EN
                    }
                }
            }
            else if !(index == IA32_BIOS_SIGN_ID) {
                if index == MSR_PLATFORM_INFO {
                    low = 1 << 8
                }
                else if !(index == MSR_MISC_FEATURE_ENABLES) {
                    if index == IA32_MISC_ENABLE {
                        // Enable Misc. Processor Features
                        low = 1 << 0;
                    // fast string
                    }
                    else if index == IA32_RTIT_CTL {
                        // linux4
                    }
                    else if !(index == MSR_SMI_COUNT) {
                        if index == IA32_MCG_CAP {
                            // netbsd
                        }
                        else if !(index == MSR_PKG_C2_RESIDENCY) {
                            dbg_log!("Unknown msr: {:x}", index);
                            dbg_assert!(false);
                        }
                    }
                }
            }
        }
        *reg32.offset(EAX as isize) = low;
        *reg32.offset(EDX as isize) = high;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F33() {
    // rdpmc
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0F34() {
    // sysenter
    let seg = *sysenter_cs & 0xFFFC;
    if !*protected_mode || seg == 0 {
        trigger_gp(0);
        return;
    }
    else {
        *flags &= !FLAG_VM & !FLAG_INTERRUPT;
        *instruction_pointer = *sysenter_eip;
        *reg32.offset(ESP as isize) = *sysenter_esp;
        *sreg.offset(CS as isize) = seg as u16;
        *segment_is_null.offset(CS as isize) = false;
        *segment_limits.offset(CS as isize) = -1i32 as u32;
        *segment_offsets.offset(CS as isize) = 0;
        update_cs_size(true);
        *cpl = 0;
        cpl_changed();
        *sreg.offset(SS as isize) = (seg + 8) as u16;
        *segment_is_null.offset(SS as isize) = false;
        *segment_limits.offset(SS as isize) = -1i32 as u32;
        *segment_offsets.offset(SS as isize) = 0;
        *stack_size_32 = true;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F35() {
    // sysexit
    let seg = *sysenter_cs & 0xFFFC;
    if !*protected_mode || 0 != *cpl || seg == 0 {
        trigger_gp(0);
        return;
    }
    else {
        *instruction_pointer = *reg32.offset(EDX as isize);
        *reg32.offset(ESP as isize) = *reg32.offset(ECX as isize);
        *sreg.offset(CS as isize) = (seg + 16 | 3) as u16;
        *segment_is_null.offset(CS as isize) = false;
        *segment_limits.offset(CS as isize) = -1i32 as u32;
        *segment_offsets.offset(CS as isize) = 0;
        update_cs_size(true);
        *cpl = 3;
        cpl_changed();
        *sreg.offset(SS as isize) = (seg + 24 | 3) as u16;
        *segment_is_null.offset(SS as isize) = false;
        *segment_limits.offset(SS as isize) = -1i32 as u32;
        *segment_offsets.offset(SS as isize) = 0;
        *stack_size_32 = true;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F36() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F37() {
    // getsec
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0F38() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F39() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3A() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3B() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3C() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3D() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3E() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3F() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr16_0F40_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F40_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F40_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F40_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F41_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F41_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(!test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F41_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F41_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(!test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F42_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F42_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F42_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F42_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F43_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F43_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(!test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F43_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F43_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(!test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F44_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F44_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F44_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F44_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F45_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F45_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(!test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F45_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F45_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(!test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F46_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F46_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F46_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F46_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F47_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F47_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(!test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F47_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F47_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(!test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F48_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F48_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F48_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F48_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F49_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F49_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(!test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F49_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F49_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(!test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4A_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4A_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4A_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4A_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4B_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4B_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(!test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4B_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4B_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(!test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4C_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4C_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4C_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4C_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4D_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4D_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(!test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4D_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4D_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(!test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4E_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4E_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4E_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4E_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4F_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4F_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    cmovcc16(!test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4F_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4F_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    cmovcc32(!test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr_0F50_reg(r1: i32, r2: i32) {
    // movmskps r, xmm
    let source = read_xmm128s(r1);
    let data = (source.u32_0[0] >> 31
        | source.u32_0[1] >> 31 << 1
        | source.u32_0[2] >> 31 << 2
        | source.u32_0[3] >> 31 << 3) as i32;
    write_reg32(r2, data);
}
#[no_mangle]
pub unsafe fn instr_0F50_mem(addr: i32, r1: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F50_reg(r1: i32, r2: i32) {
    // movmskpd r, xmm
    let source = read_xmm128s(r1);
    let data = (source.u32_0[1] >> 31 | source.u32_0[3] >> 31 << 1) as i32;
    write_reg32(r2, data);
}
#[no_mangle]
pub unsafe fn instr_660F50_mem(addr: i32, r1: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F54(source: reg128, r: i32) {
    // andps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pand_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F54_reg(r1: i32, r2: i32) { instr_0F54(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F54_mem(addr: i32, r: i32) {
    instr_0F54(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F54(source: reg128, r: i32) {
    // andpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pand_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F54_reg(r1: i32, r2: i32) { instr_660F54(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F54_mem(addr: i32, r: i32) {
    instr_660F54(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F55(source: reg128, r: i32) {
    // andnps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pandn_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F55_reg(r1: i32, r2: i32) { instr_0F55(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F55_mem(addr: i32, r: i32) {
    instr_0F55(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F55(source: reg128, r: i32) {
    // andnpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pandn_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F55_reg(r1: i32, r2: i32) { instr_660F55(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F55_mem(addr: i32, r: i32) {
    instr_660F55(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F56(source: reg128, r: i32) {
    // orps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    por_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F56_reg(r1: i32, r2: i32) { instr_0F56(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F56_mem(addr: i32, r: i32) {
    instr_0F56(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F56(source: reg128, r: i32) {
    // orpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    por_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F56_reg(r1: i32, r2: i32) { instr_660F56(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F56_mem(addr: i32, r: i32) {
    instr_660F56(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F57(source: reg128, r: i32) {
    // xorps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pxor_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F57_reg(r1: i32, r2: i32) { instr_0F57(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F57_mem(addr: i32, r: i32) {
    instr_0F57(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F57(source: reg128, r: i32) {
    // xorpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pxor_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F57_reg(r1: i32, r2: i32) { instr_660F57(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F57_mem(addr: i32, r: i32) {
    instr_660F57(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F60(source: i32, r: i32) {
    // punpcklbw mm, mm/m32
    let destination = read_mmx64s(r);
    let byte0 = destination.u8_0[0] as i32;
    let byte1 = source & 255;
    let byte2 = destination.u8_0[1] as i32;
    let byte3 = source >> 8 & 255;
    let byte4 = destination.u8_0[2] as i32;
    let byte5 = source >> 16 & 255;
    let byte6 = destination.u8_0[3] as i32;
    let byte7 = source >> 24;
    let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
    let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F60_reg(r1: i32, r2: i32) { instr_0F60(read_mmx32s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F60_mem(addr: i32, r: i32) {
    instr_0F60(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F60(source: reg64, r: i32) {
    // punpcklbw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm64s(r);
    write_xmm128(
        r,
        destination.u8_0[0] as i32
            | (source.u8_0[0] as i32) << 8
            | (destination.u8_0[1] as i32) << 16
            | (source.u8_0[1] as i32) << 24,
        destination.u8_0[2] as i32
            | (source.u8_0[2] as i32) << 8
            | (destination.u8_0[3] as i32) << 16
            | (source.u8_0[3] as i32) << 24,
        destination.u8_0[4] as i32
            | (source.u8_0[4] as i32) << 8
            | (destination.u8_0[5] as i32) << 16
            | (source.u8_0[5] as i32) << 24,
        destination.u8_0[6] as i32
            | (source.u8_0[6] as i32) << 8
            | (destination.u8_0[7] as i32) << 16
            | (source.u8_0[7] as i32) << 24,
    );
}
#[no_mangle]
pub unsafe fn instr_660F60_reg(r1: i32, r2: i32) { instr_660F60(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F60_mem(addr: i32, r: i32) {
    instr_660F60(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F61(source: i32, r: i32) {
    // punpcklwd mm, mm/m32
    let destination = read_mmx64s(r);
    let word0 = destination.u16_0[0] as i32;
    let word1 = source & 0xFFFF;
    let word2 = destination.u16_0[1] as i32;
    let word3 = source >> 16;
    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F61_reg(r1: i32, r2: i32) { instr_0F61(read_mmx32s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F61_mem(addr: i32, r: i32) {
    instr_0F61(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F61(source: reg64, r: i32) {
    // punpcklwd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm64s(r);
    write_xmm128(
        r,
        destination.u16_0[0] as i32 | (source.u16_0[0] as i32) << 16,
        destination.u16_0[1] as i32 | (source.u16_0[1] as i32) << 16,
        destination.u16_0[2] as i32 | (source.u16_0[2] as i32) << 16,
        destination.u16_0[3] as i32 | (source.u16_0[3] as i32) << 16,
    );
}
#[no_mangle]
pub unsafe fn instr_660F61_reg(r1: i32, r2: i32) { instr_660F61(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F61_mem(addr: i32, r: i32) {
    instr_660F61(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F62(source: i32, r: i32) {
    // punpckldq mm, mm/m32
    let destination = read_mmx64s(r);
    write_mmx64(r, destination.u32_0[0] as i32, source);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F62_reg(r1: i32, r2: i32) { instr_0F62(read_mmx32s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F62_mem(addr: i32, r: i32) {
    instr_0F62(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F62(source: reg64, r: i32) {
    // punpckldq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[0] as i32,
        source.u32_0[0] as i32,
        destination.u32_0[1] as i32,
        source.u32_0[1] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F62_reg(r1: i32, r2: i32) { instr_660F62(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F62_mem(addr: i32, r: i32) {
    instr_660F62(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F63(source: reg64, r: i32) {
    // packsswb mm, mm/m64
    let destination = read_mmx64s(r);
    let low = saturate_sw_to_sb(destination.u16_0[0] as i32)
        | saturate_sw_to_sb(destination.u16_0[1] as i32) << 8
        | saturate_sw_to_sb(destination.u16_0[2] as i32) << 16
        | saturate_sw_to_sb(destination.u16_0[3] as i32) << 24;
    let high = saturate_sw_to_sb(source.u16_0[0] as i32)
        | saturate_sw_to_sb(source.u16_0[1] as i32) << 8
        | saturate_sw_to_sb(source.u16_0[2] as i32) << 16
        | saturate_sw_to_sb(source.u16_0[3] as i32) << 24;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F63_reg(r1: i32, r2: i32) { instr_0F63(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F63_mem(addr: i32, r: i32) {
    instr_0F63(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F63(source: reg128, r: i32) {
    // packsswb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let dword0 = saturate_sw_to_sb(destination.u16_0[0] as i32)
        | saturate_sw_to_sb(destination.u16_0[1] as i32) << 8
        | saturate_sw_to_sb(destination.u16_0[2] as i32) << 16
        | saturate_sw_to_sb(destination.u16_0[3] as i32) << 24;
    let dword1 = saturate_sw_to_sb(destination.u16_0[4] as i32)
        | saturate_sw_to_sb(destination.u16_0[5] as i32) << 8
        | saturate_sw_to_sb(destination.u16_0[6] as i32) << 16
        | saturate_sw_to_sb(destination.u16_0[7] as i32) << 24;
    let dword2 = saturate_sw_to_sb(source.u16_0[0] as i32)
        | saturate_sw_to_sb(source.u16_0[1] as i32) << 8
        | saturate_sw_to_sb(source.u16_0[2] as i32) << 16
        | saturate_sw_to_sb(source.u16_0[3] as i32) << 24;
    let dword3 = saturate_sw_to_sb(source.u16_0[4] as i32)
        | saturate_sw_to_sb(source.u16_0[5] as i32) << 8
        | saturate_sw_to_sb(source.u16_0[6] as i32) << 16
        | saturate_sw_to_sb(source.u16_0[7] as i32) << 24;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660F63_reg(r1: i32, r2: i32) { instr_660F63(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F63_mem(addr: i32, r: i32) {
    instr_660F63(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F64(source: reg64, r: i32) {
    // pcmpgtb mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.u8_0[i as usize] =
            (if destination.i8_0[i as usize] as i32 > source.i8_0[i as usize] as i32 {
                255
            }
            else {
                0
            }) as u8;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F64_reg(r1: i32, r2: i32) { instr_0F64(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F64_mem(addr: i32, r: i32) {
    instr_0F64(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F64(source: reg128, r: i32) {
    // pcmpgtb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..16 {
        result.i8_0[i as usize] =
            (if destination.i8_0[i as usize] as i32 > source.i8_0[i as usize] as i32 {
                255
            }
            else {
                0
            }) as i8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F64_reg(r1: i32, r2: i32) { instr_660F64(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F64_mem(addr: i32, r: i32) {
    instr_660F64(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F65(source: reg64, r: i32) {
    // pcmpgtw mm, mm/m64
    let destination = read_mmx64s(r);
    let word0 = if destination.i16_0[0] as i32 > source.i16_0[0] as i32 {
        0xFFFF
    }
    else {
        0
    };
    let word1 = if destination.i16_0[1] as i32 > source.i16_0[1] as i32 {
        0xFFFF
    }
    else {
        0
    };
    let word2 = if destination.i16_0[2] as i32 > source.i16_0[2] as i32 {
        0xFFFF
    }
    else {
        0
    };
    let word3 = if destination.i16_0[3] as i32 > source.i16_0[3] as i32 {
        0xFFFF
    }
    else {
        0
    };
    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F65_reg(r1: i32, r2: i32) { instr_0F65(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F65_mem(addr: i32, r: i32) {
    instr_0F65(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F65(source: reg128, r: i32) {
    // pcmpgtw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.u16_0[i as usize] =
            (if destination.i16_0[i as usize] as i32 > source.i16_0[i as usize] as i32 {
                0xFFFF
            }
            else {
                0
            }) as u16;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F65_reg(r1: i32, r2: i32) { instr_660F65(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F65_mem(addr: i32, r: i32) {
    instr_660F65(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F66(source: reg64, r: i32) {
    // pcmpgtd mm, mm/m64
    let destination = read_mmx64s(r);
    let low = if destination.i32_0[0] > source.i32_0[0] {
        -1
    }
    else {
        0
    };
    let high = if destination.i32_0[1] > source.i32_0[1] {
        -1
    }
    else {
        0
    };
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F66_reg(r1: i32, r2: i32) { instr_0F66(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F66_mem(addr: i32, r: i32) {
    instr_0F66(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F66(source: reg128, r: i32) {
    // pcmpgtd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        if destination.i32_0[0] > source.i32_0[0] {
            -1
        }
        else {
            0
        },
        if destination.i32_0[1] > source.i32_0[1] {
            -1
        }
        else {
            0
        },
        if destination.i32_0[2] > source.i32_0[2] {
            -1
        }
        else {
            0
        },
        if destination.i32_0[3] > source.i32_0[3] {
            -1
        }
        else {
            0
        },
    );
}
#[no_mangle]
pub unsafe fn instr_660F66_reg(r1: i32, r2: i32) { instr_660F66(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F66_mem(addr: i32, r: i32) {
    instr_660F66(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F67(source: reg64, r: i32) {
    // packuswb mm, mm/m64
    let destination = read_mmx64s(r);
    let low = saturate_sw_to_ub(destination.u16_0[0] as u32)
        | saturate_sw_to_ub(destination.u16_0[1] as u32) << 8
        | saturate_sw_to_ub(destination.u16_0[2] as u32) << 16
        | saturate_sw_to_ub(destination.u16_0[3] as u32) << 24;
    let high = saturate_sw_to_ub(source.u16_0[0] as u32)
        | saturate_sw_to_ub(source.u16_0[1] as u32) << 8
        | saturate_sw_to_ub(source.u16_0[2] as u32) << 16
        | saturate_sw_to_ub(source.u16_0[3] as u32) << 24;
    write_mmx64(r, low as i32, high as i32);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F67_reg(r1: i32, r2: i32) { instr_0F67(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F67_mem(addr: i32, r: i32) {
    instr_0F67(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F67(source: reg128, r: i32) {
    // packuswb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..8 {
        result.u8_0[i as usize] = saturate_sw_to_ub(destination.u16_0[i as usize] as u32) as u8;
        result.u8_0[(i | 8) as usize] = saturate_sw_to_ub(source.u16_0[i as usize] as u32) as u8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F67_reg(r1: i32, r2: i32) { instr_660F67(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F67_mem(addr: i32, r: i32) {
    instr_660F67(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F68(source: reg64, r: i32) {
    // punpckhbw mm, mm/m64
    let destination = read_mmx64s(r);
    let byte0 = destination.u8_0[4] as i32;
    let byte1 = source.u8_0[4] as i32;
    let byte2 = destination.u8_0[5] as i32;
    let byte3 = source.u8_0[5] as i32;
    let byte4 = destination.u8_0[6] as i32;
    let byte5 = source.u8_0[6] as i32;
    let byte6 = destination.u8_0[7] as i32;
    let byte7 = source.u8_0[7] as i32;
    let low = byte0 | byte1 << 8 | byte2 << 16 | byte3 << 24;
    let high = byte4 | byte5 << 8 | byte6 << 16 | byte7 << 24;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F68_reg(r1: i32, r2: i32) { instr_0F68(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F68_mem(addr: i32, r: i32) {
    instr_0F68(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F68(source: reg128, r: i32) {
    // punpckhbw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u8_0[8] as i32
            | (source.u8_0[8] as i32) << 8
            | (destination.u8_0[9] as i32) << 16
            | (source.u8_0[9] as i32) << 24,
        destination.u8_0[10] as i32
            | (source.u8_0[10] as i32) << 8
            | (destination.u8_0[11] as i32) << 16
            | (source.u8_0[11] as i32) << 24,
        destination.u8_0[12] as i32
            | (source.u8_0[12] as i32) << 8
            | (destination.u8_0[13] as i32) << 16
            | (source.u8_0[13] as i32) << 24,
        destination.u8_0[14] as i32
            | (source.u8_0[14] as i32) << 8
            | (destination.u8_0[15] as i32) << 16
            | (source.u8_0[15] as i32) << 24,
    );
}
#[no_mangle]
pub unsafe fn instr_660F68_reg(r1: i32, r2: i32) { instr_660F68(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F68_mem(addr: i32, r: i32) {
    instr_660F68(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F69(source: reg64, r: i32) {
    // punpckhwd mm, mm/m64
    let destination = read_mmx64s(r);
    let word0 = destination.u16_0[2] as i32;
    let word1 = source.u16_0[2] as i32;
    let word2 = destination.u16_0[3] as i32;
    let word3 = source.u16_0[3] as i32;
    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F69_reg(r1: i32, r2: i32) { instr_0F69(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F69_mem(addr: i32, r: i32) {
    instr_0F69(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F69(source: reg128, r: i32) {
    // punpckhwd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let dword0 = destination.u16_0[4] as i32 | (source.u16_0[4] as i32) << 16;
    let dword1 = destination.u16_0[5] as i32 | (source.u16_0[5] as i32) << 16;
    let dword2 = destination.u16_0[6] as i32 | (source.u16_0[6] as i32) << 16;
    let dword3 = destination.u16_0[7] as i32 | (source.u16_0[7] as i32) << 16;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660F69_reg(r1: i32, r2: i32) { instr_660F69(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F69_mem(addr: i32, r: i32) {
    instr_660F69(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6A(source: reg64, r: i32) {
    // punpckhdq mm, mm/m64
    let destination = read_mmx64s(r);
    write_mmx64(r, destination.u32_0[1] as i32, source.u32_0[1] as i32);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F6A_reg(r1: i32, r2: i32) { instr_0F6A(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F6A_mem(addr: i32, r: i32) {
    instr_0F6A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F6A(source: reg128, r: i32) {
    // punpckhdq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[2] as i32,
        source.u32_0[2] as i32,
        destination.u32_0[3] as i32,
        source.u32_0[3] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F6A_reg(r1: i32, r2: i32) { instr_660F6A(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F6A_mem(addr: i32, r: i32) {
    instr_660F6A(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6B(source: reg64, r: i32) {
    // packssdw mm, mm/m64
    let destination = read_mmx64s(r);
    let low = (saturate_sd_to_sw(destination.u32_0[0])
        | saturate_sd_to_sw(destination.u32_0[1]) << 16) as i32;
    let high =
        (saturate_sd_to_sw(source.u32_0[0]) | saturate_sd_to_sw(source.u32_0[1]) << 16) as i32;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F6B_reg(r1: i32, r2: i32) { instr_0F6B(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F6B_mem(addr: i32, r: i32) {
    instr_0F6B(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F6B(source: reg128, r: i32) {
    // packssdw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let dword0 = (saturate_sd_to_sw(destination.u32_0[0])
        | saturate_sd_to_sw(destination.u32_0[1]) << 16) as i32;
    let dword1 = (saturate_sd_to_sw(destination.u32_0[2])
        | saturate_sd_to_sw(destination.u32_0[3]) << 16) as i32;
    let dword2 =
        (saturate_sd_to_sw(source.u32_0[0]) | saturate_sd_to_sw(source.u32_0[1]) << 16) as i32;
    let dword3 =
        (saturate_sd_to_sw(source.u32_0[2]) | saturate_sd_to_sw(source.u32_0[3]) << 16) as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660F6B_reg(r1: i32, r2: i32) { instr_660F6B(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F6B_mem(addr: i32, r: i32) {
    instr_660F6B(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6C_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F6C_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F6C(source: reg128, r: i32) {
    // punpcklqdq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[0] as i32,
        destination.u32_0[1] as i32,
        source.u32_0[0] as i32,
        source.u32_0[1] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F6C_reg(r1: i32, r2: i32) { instr_660F6C(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F6C_mem(addr: i32, r: i32) {
    instr_660F6C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6D_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F6D_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F6D(source: reg128, r: i32) {
    // punpckhqdq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[2] as i32,
        destination.u32_0[3] as i32,
        source.u32_0[2] as i32,
        source.u32_0[3] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F6D_reg(r1: i32, r2: i32) { instr_660F6D(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F6D_mem(addr: i32, r: i32) {
    instr_660F6D(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6E(source: i32, r: i32) {
    // movd mm, r/m32
    write_mmx64(r, source, 0);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F6E_reg(r1: i32, r2: i32) { instr_0F6E(read_reg32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F6E_mem(addr: i32, r: i32) {
    instr_0F6E(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F6E(source: i32, r: i32) {
    // movd mm, r/m32
    write_xmm128(r, source, 0, 0, 0);
}
#[no_mangle]
pub unsafe fn instr_660F6E_reg(r1: i32, r2: i32) { instr_660F6E(read_reg32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F6E_mem(addr: i32, r: i32) {
    instr_660F6E(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6F(source: reg64, r: i32) {
    // movq mm, mm/m64
    write_mmx64(r, source.u32_0[0] as i32, source.u32_0[1] as i32);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F6F_reg(r1: i32, r2: i32) { instr_0F6F(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F6F_mem(addr: i32, r: i32) {
    instr_0F6F(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F6F(source: reg128, r: i32) {
    // movdqa xmm, xmm/mem128
    // XXX: Aligned access or #gp
    // XXX: Aligned read or #gp
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F6F_reg(r1: i32, r2: i32) { instr_660F6F(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F6F_mem(addr: i32, r: i32) {
    instr_660F6F(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F6F(source: reg128, r: i32) {
    // movdqu xmm, xmm/m128
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_F30F6F_reg(r1: i32, r2: i32) { instr_F30F6F(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F6F_mem(addr: i32, r: i32) {
    instr_F30F6F(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F70(source: reg64, r: i32, imm8: i32) {
    // pshufw mm1, mm2/m64, imm8
    let word0_shift = imm8 & 3;
    let word0 = source.u32_0[(word0_shift >> 1) as usize] >> ((word0_shift & 1) << 4) & 0xFFFF;
    let word1_shift = imm8 >> 2 & 3;
    let word1 = source.u32_0[(word1_shift >> 1) as usize] >> ((word1_shift & 1) << 4);
    let low = (word0 | word1 << 16) as i32;
    let word2_shift = imm8 >> 4 & 3;
    let word2 = source.u32_0[(word2_shift >> 1) as usize] >> ((word2_shift & 1) << 4) & 0xFFFF;
    let word3_shift = (imm8 >> 6) as u32;
    let word3 = source.u32_0[(word3_shift >> 1) as usize] >> ((word3_shift & 1) << 4);
    let high = (word2 | word3 << 16) as i32;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F70_reg(r1: i32, r2: i32, imm: i32) { instr_0F70(read_mmx64s(r1), r2, imm); }
#[no_mangle]
pub unsafe fn instr_0F70_mem(addr: i32, r: i32, imm: i32) {
    instr_0F70(return_on_pagefault!(safe_read64s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_660F70(source: reg128, r: i32, imm8: i32) {
    // pshufd xmm, xmm/mem128, imm8
    // XXX: Aligned access or #gp
    write_xmm128(
        r,
        source.u32_0[(imm8 & 3) as usize] as i32,
        source.u32_0[(imm8 >> 2 & 3) as usize] as i32,
        source.u32_0[(imm8 >> 4 & 3) as usize] as i32,
        source.u32_0[(imm8 >> 6 & 3) as usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F70_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F70(read_xmm128s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_660F70_mem(addr: i32, r: i32, imm: i32) {
    instr_660F70(return_on_pagefault!(safe_read128s(addr)), r, imm);
}

#[no_mangle]
pub unsafe fn instr_F20F70(source: reg128, r: i32, imm8: i32) {
    // pshuflw xmm, xmm/m128, imm8
    // XXX: Aligned access or #gp
    write_xmm128(
        r,
        source.u16_0[(imm8 & 3) as usize] as i32
            | (source.u16_0[(imm8 >> 2 & 3) as usize] as i32) << 16,
        source.u16_0[(imm8 >> 4 & 3) as usize] as i32
            | (source.u16_0[(imm8 >> 6 & 3) as usize] as i32) << 16,
        source.u32_0[2] as i32,
        source.u32_0[3] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F20F70_reg(r1: i32, r2: i32, imm: i32) {
    instr_F20F70(read_xmm128s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_F20F70_mem(addr: i32, r: i32, imm: i32) {
    instr_F20F70(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_F30F70(source: reg128, r: i32, imm8: i32) {
    // pshufhw xmm, xmm/m128, imm8
    // XXX: Aligned access or #gp
    write_xmm128(
        r,
        source.u32_0[0] as i32,
        source.u32_0[1] as i32,
        source.u16_0[(imm8 & 3 | 4) as usize] as i32
            | (source.u16_0[(imm8 >> 2 & 3 | 4) as usize] as i32) << 16,
        source.u16_0[(imm8 >> 4 & 3 | 4) as usize] as i32
            | (source.u16_0[(imm8 >> 6 & 3 | 4) as usize] as i32) << 16,
    );
}
#[no_mangle]
pub unsafe fn instr_F30F70_reg(r1: i32, r2: i32, imm: i32) {
    instr_F30F70(read_xmm128s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_F30F70_mem(addr: i32, r: i32, imm: i32) {
    instr_F30F70(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_0F71_2_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F71_4_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F71_6_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F71_2_reg(r: i32, imm8: i32) {
    // psrlw mm, imm8
    psrlw_r64(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_0F71_4_reg(r: i32, imm8: i32) {
    // psraw mm, imm8
    psraw_r64(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_0F71_6_reg(r: i32, imm8: i32) {
    // psllw mm, imm8
    psllw_r64(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_660F71_2_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F71_4_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F71_6_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F71_2_reg(r: i32, imm8: i32) {
    // psrlw xmm, imm8
    psrlw_r128(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_660F71_4_reg(r: i32, imm8: i32) {
    // psraw xmm, imm8
    psraw_r128(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_660F71_6_reg(r: i32, imm8: i32) {
    // psllw xmm, imm8
    psllw_r128(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_0F72_2_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F72_4_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F72_6_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F72_2_reg(r: i32, imm8: i32) {
    // psrld mm, imm8
    psrld_r64(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_0F72_4_reg(r: i32, imm8: i32) {
    // psrad mm, imm8
    psrad_r64(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_0F72_6_reg(r: i32, imm8: i32) {
    // pslld mm, imm8
    pslld_r64(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_660F72_2_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F72_4_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F72_6_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F72_2_reg(r: i32, imm8: i32) {
    // psrld xmm, imm8
    psrld_r128(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_660F72_4_reg(r: i32, imm8: i32) {
    // psrad xmm, imm8
    psrad_r128(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_660F72_6_reg(r: i32, imm8: i32) {
    // pslld xmm, imm8
    pslld_r128(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_0F73_2_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F73_6_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F73_2_reg(r: i32, imm8: i32) {
    // psrlq mm, imm8
    psrlq_r64(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_0F73_6_reg(r: i32, imm8: i32) {
    // psllq mm, imm8
    psllq_r64(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_660F73_2_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F73_3_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F73_6_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F73_7_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F73_2_reg(r: i32, imm8: i32) {
    // psrlq xmm, imm8
    psrlq_r128(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_660F73_3_reg(r: i32, imm8: i32) {
    // psrldq xmm, imm8
    let destination = read_xmm128s(r);
    if imm8 == 0 {
        return;
    }
    else {
        let mut result: reg128 = reg128 {
            i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        };
        let shift = (if imm8 > 15 { 128 } else { imm8 << 3 }) as u32;
        if shift <= 63 {
            result.u64_0[0] = destination.u64_0[0] >> shift | destination.u64_0[1] << (64 - shift);
            result.u64_0[1] = destination.u64_0[1] >> shift
        }
        else if shift <= 127 {
            result.u64_0[0] = destination.u64_0[1] >> shift.wrapping_sub(64);
            result.u64_0[1] = 0
        }
        write_xmm_reg128(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_660F73_6_reg(r: i32, imm8: i32) {
    // psllq xmm, imm8
    psllq_r128(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_660F73_7_reg(r: i32, imm8: i32) {
    // pslldq xmm, imm8
    let destination = read_xmm128s(r);
    if imm8 == 0 {
        return;
    }
    else {
        let mut result: reg128 = reg128 {
            i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        };
        let shift = (if imm8 > 15 { 128 } else { imm8 << 3 }) as u32;
        if shift <= 63 {
            result.u64_0[0] = destination.u64_0[0] << shift;
            result.u64_0[1] = destination.u64_0[1] << shift | destination.u64_0[0] >> (64 - shift)
        }
        else if shift <= 127 {
            result.u64_0[0] = 0;
            result.u64_0[1] = destination.u64_0[0] << shift.wrapping_sub(64)
        }
        write_xmm_reg128(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F74(source: reg64, r: i32) {
    // pcmpeqb mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.u8_0[i as usize] =
            (if destination.i8_0[i as usize] as i32 == source.i8_0[i as usize] as i32 {
                255
            }
            else {
                0
            }) as u8;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F74_reg(r1: i32, r2: i32) { instr_0F74(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F74_mem(addr: i32, r: i32) {
    instr_0F74(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F74(source: reg128, r: i32) {
    // pcmpeqb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..16 {
        result.u8_0[i as usize] =
            (if source.u8_0[i as usize] as i32 == destination.u8_0[i as usize] as i32 {
                255
            }
            else {
                0
            }) as u8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F74_reg(r1: i32, r2: i32) { instr_660F74(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F74_mem(addr: i32, r: i32) {
    instr_660F74(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F75(source: reg64, r: i32) {
    // pcmpeqw mm, mm/m64
    let destination = read_mmx64s(r);
    let word0 = if destination.u16_0[0] as i32 == source.u16_0[0] as i32 {
        0xFFFF
    }
    else {
        0
    };
    let word1 = if destination.u16_0[1] as i32 == source.u16_0[1] as i32 {
        0xFFFF
    }
    else {
        0
    };
    let word2 = if destination.u16_0[2] as i32 == source.u16_0[2] as i32 {
        0xFFFF
    }
    else {
        0
    };
    let word3 = if destination.u16_0[3] as i32 == source.u16_0[3] as i32 {
        0xFFFF
    }
    else {
        0
    };
    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F75_reg(r1: i32, r2: i32) { instr_0F75(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F75_mem(addr: i32, r: i32) {
    instr_0F75(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F75(source: reg128, r: i32) {
    // pcmpeqw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..8 {
        result.u16_0[i as usize] =
            (if source.u16_0[i as usize] as i32 == destination.u16_0[i as usize] as i32 {
                0xFFFF
            }
            else {
                0
            }) as u16;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F75_reg(r1: i32, r2: i32) { instr_660F75(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F75_mem(addr: i32, r: i32) {
    instr_660F75(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F76(source: reg64, r: i32) {
    // pcmpeqd mm, mm/m64
    let destination = read_mmx64s(r);
    let low = if destination.u32_0[0] == source.u32_0[0] {
        -1
    }
    else {
        0
    };
    let high = if destination.u32_0[1] == source.u32_0[1] {
        -1
    }
    else {
        0
    };
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F76_reg(r1: i32, r2: i32) { instr_0F76(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F76_mem(addr: i32, r: i32) {
    instr_0F76(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F76(source: reg128, r: i32) {
    // pcmpeqd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        if source.u32_0[0] == destination.u32_0[0] {
            -1
        }
        else {
            0
        },
        if source.u32_0[1] == destination.u32_0[1] {
            -1
        }
        else {
            0
        },
        if source.u32_0[2] == destination.u32_0[2] {
            -1
        }
        else {
            0
        },
        if source.u32_0[3] == destination.u32_0[3] {
            -1
        }
        else {
            0
        },
    );
}
#[no_mangle]
pub unsafe fn instr_660F76_reg(r1: i32, r2: i32) { instr_660F76(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F76_mem(addr: i32, r: i32) {
    instr_660F76(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F77() {
    // emms
    fpu_set_tag_word(0xFFFF);
}
#[no_mangle]
pub unsafe fn instr_0F78() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F79() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F7A() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F7B() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F7C() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F7D() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F7E(r: i32) -> i32 {
    // movd r/m32, mm
    let data = read_mmx64s(r);
    transition_fpu_to_mmx();
    return data.u32_0[0] as i32;
}
#[no_mangle]
pub unsafe fn instr_0F7E_reg(r1: i32, r2: i32) { write_reg32(r1, instr_0F7E(r2)); }
#[no_mangle]
pub unsafe fn instr_0F7E_mem(addr: i32, r: i32) {
    return_on_pagefault!(safe_write32(addr, instr_0F7E(r)));
}
#[no_mangle]
pub unsafe fn instr_660F7E(r: i32) -> i32 {
    // movd r/m32, xmm
    let data = read_xmm64s(r);
    return data.u32_0[0] as i32;
}
#[no_mangle]
pub unsafe fn instr_660F7E_reg(r1: i32, r2: i32) { write_reg32(r1, instr_660F7E(r2)); }
#[no_mangle]
pub unsafe fn instr_660F7E_mem(addr: i32, r: i32) {
    return_on_pagefault!(safe_write32(addr, instr_660F7E(r)));
}
#[no_mangle]
pub unsafe fn instr_F30F7E_mem(addr: i32, r: i32) {
    // movq xmm, xmm/mem64
    let data = return_on_pagefault!(safe_read64s(addr));
    write_xmm128(r, data.u32_0[0] as i32, data.u32_0[1] as i32, 0, 0);
}
#[no_mangle]
pub unsafe fn instr_F30F7E_reg(r1: i32, r2: i32) {
    // movq xmm, xmm/mem64
    let data = read_xmm64s(r1);
    write_xmm128(r2, data.u32_0[0] as i32, data.u32_0[1] as i32, 0, 0);
}
#[no_mangle]
pub unsafe fn instr_0F7F_mem(addr: i32, r: i32) {
    // movq mm/m64, mm
    mov_r_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F7F_reg(r1: i32, r2: i32) {
    // movq mm/m64, mm
    let data = read_mmx64s(r2);
    write_mmx64(r1, data.u32_0[0] as i32, data.u32_0[1] as i32);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_660F7F_mem(addr: i32, r: i32) {
    // movdqa xmm/m128, xmm
    // XXX: Aligned write or #gp
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_660F7F_reg(r1: i32, r2: i32) {
    // movdqa xmm/m128, xmm
    // XXX: Aligned access or #gp
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr_F30F7F_mem(addr: i32, r: i32) {
    // movdqu xmm/m128, xmm
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_F30F7F_reg(r1: i32, r2: i32) {
    // movdqu xmm/m128, xmm
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr16_0F80(imm: i32) { jmpcc16(test_o(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F80(imm: i32) { jmpcc32(test_o(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F81(imm: i32) { jmpcc16(!test_o(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F81(imm: i32) { jmpcc32(!test_o(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F82(imm: i32) { jmpcc16(test_b(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F82(imm: i32) { jmpcc32(test_b(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F83(imm: i32) { jmpcc16(!test_b(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F83(imm: i32) { jmpcc32(!test_b(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F84(imm: i32) { jmpcc16(test_z(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F84(imm: i32) { jmpcc32(test_z(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F85(imm: i32) { jmpcc16(!test_z(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F85(imm: i32) { jmpcc32(!test_z(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F86(imm: i32) { jmpcc16(test_be(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F86(imm: i32) { jmpcc32(test_be(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F87(imm: i32) { jmpcc16(!test_be(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F87(imm: i32) { jmpcc32(!test_be(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F88(imm: i32) { jmpcc16(test_s(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F88(imm: i32) { jmpcc32(test_s(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F89(imm: i32) { jmpcc16(!test_s(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F89(imm: i32) { jmpcc32(!test_s(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8A(imm: i32) { jmpcc16(test_p(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8A(imm: i32) { jmpcc32(test_p(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8B(imm: i32) { jmpcc16(!test_p(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8B(imm: i32) { jmpcc32(!test_p(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8C(imm: i32) { jmpcc16(test_l(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8C(imm: i32) { jmpcc32(test_l(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8D(imm: i32) { jmpcc16(!test_l(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8D(imm: i32) { jmpcc32(!test_l(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8E(imm: i32) { jmpcc16(test_le(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8E(imm: i32) { jmpcc32(test_le(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8F(imm: i32) { jmpcc16(!test_le(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8F(imm: i32) { jmpcc32(!test_le(), imm); }
#[no_mangle]
pub unsafe fn instr_0F90_reg(r: i32, unused: i32) { setcc_reg(test_o(), r); }
#[no_mangle]
pub unsafe fn instr_0F91_reg(r: i32, unused: i32) { setcc_reg(!test_o(), r); }
#[no_mangle]
pub unsafe fn instr_0F92_reg(r: i32, unused: i32) { setcc_reg(test_b(), r); }
#[no_mangle]
pub unsafe fn instr_0F93_reg(r: i32, unused: i32) { setcc_reg(!test_b(), r); }
#[no_mangle]
pub unsafe fn instr_0F94_reg(r: i32, unused: i32) { setcc_reg(test_z(), r); }
#[no_mangle]
pub unsafe fn instr_0F95_reg(r: i32, unused: i32) { setcc_reg(!test_z(), r); }
#[no_mangle]
pub unsafe fn instr_0F96_reg(r: i32, unused: i32) { setcc_reg(test_be(), r); }
#[no_mangle]
pub unsafe fn instr_0F97_reg(r: i32, unused: i32) { setcc_reg(!test_be(), r); }
#[no_mangle]
pub unsafe fn instr_0F98_reg(r: i32, unused: i32) { setcc_reg(test_s(), r); }
#[no_mangle]
pub unsafe fn instr_0F99_reg(r: i32, unused: i32) { setcc_reg(!test_s(), r); }
#[no_mangle]
pub unsafe fn instr_0F9A_reg(r: i32, unused: i32) { setcc_reg(test_p(), r); }
#[no_mangle]
pub unsafe fn instr_0F9B_reg(r: i32, unused: i32) { setcc_reg(!test_p(), r); }
#[no_mangle]
pub unsafe fn instr_0F9C_reg(r: i32, unused: i32) { setcc_reg(test_l(), r); }
#[no_mangle]
pub unsafe fn instr_0F9D_reg(r: i32, unused: i32) { setcc_reg(!test_l(), r); }
#[no_mangle]
pub unsafe fn instr_0F9E_reg(r: i32, unused: i32) { setcc_reg(test_le(), r); }
#[no_mangle]
pub unsafe fn instr_0F9F_reg(r: i32, unused: i32) { setcc_reg(!test_le(), r); }
#[no_mangle]
pub unsafe fn instr_0F90_mem(addr: i32, unused: i32) { setcc_mem(test_o(), addr); }
#[no_mangle]
pub unsafe fn instr_0F91_mem(addr: i32, unused: i32) { setcc_mem(!test_o(), addr); }
#[no_mangle]
pub unsafe fn instr_0F92_mem(addr: i32, unused: i32) { setcc_mem(test_b(), addr); }
#[no_mangle]
pub unsafe fn instr_0F93_mem(addr: i32, unused: i32) { setcc_mem(!test_b(), addr); }
#[no_mangle]
pub unsafe fn instr_0F94_mem(addr: i32, unused: i32) { setcc_mem(test_z(), addr); }
#[no_mangle]
pub unsafe fn instr_0F95_mem(addr: i32, unused: i32) { setcc_mem(!test_z(), addr); }
#[no_mangle]
pub unsafe fn instr_0F96_mem(addr: i32, unused: i32) { setcc_mem(test_be(), addr); }
#[no_mangle]
pub unsafe fn instr_0F97_mem(addr: i32, unused: i32) { setcc_mem(!test_be(), addr); }
#[no_mangle]
pub unsafe fn instr_0F98_mem(addr: i32, unused: i32) { setcc_mem(test_s(), addr); }
#[no_mangle]
pub unsafe fn instr_0F99_mem(addr: i32, unused: i32) { setcc_mem(!test_s(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9A_mem(addr: i32, unused: i32) { setcc_mem(test_p(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9B_mem(addr: i32, unused: i32) { setcc_mem(!test_p(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9C_mem(addr: i32, unused: i32) { setcc_mem(test_l(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9D_mem(addr: i32, unused: i32) { setcc_mem(!test_l(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9E_mem(addr: i32, unused: i32) { setcc_mem(test_le(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9F_mem(addr: i32, unused: i32) { setcc_mem(!test_le(), addr); }
#[no_mangle]
pub unsafe fn instr16_0FA0() {
    return_on_pagefault!(push16(*sreg.offset(FS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_0FA0() {
    return_on_pagefault!(push32(*sreg.offset(FS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_0FA1() {
    if !switch_seg(FS, return_on_pagefault!(safe_read16(get_stack_pointer(0)))) {
        return;
    }
    else {
        adjust_stack_reg(2);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_0FA1() {
    if !switch_seg(
        FS,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0))) & 0xFFFF,
    ) {
        return;
    }
    else {
        adjust_stack_reg(4);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0FA2() { cpuid(); }
#[no_mangle]
pub unsafe fn instr16_0FA3_reg(r1: i32, r2: i32) { bt_reg(read_reg16(r1), read_reg16(r2) & 15); }
#[no_mangle]
pub unsafe fn instr16_0FA3_mem(addr: i32, r: i32) { bt_mem(addr, read_reg16(r) << 16 >> 16); }
#[no_mangle]
pub unsafe fn instr32_0FA3_reg(r1: i32, r2: i32) { bt_reg(read_reg32(r1), read_reg32(r2) & 31); }
#[no_mangle]
pub unsafe fn instr32_0FA3_mem(addr: i32, r: i32) { bt_mem(addr, read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr16_0FA4_mem(addr: i32, r: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, shld16(___, read_reg16(r), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_0FA4_reg(r1: i32, r: i32, imm: i32) {
    let ____0 = read_reg16(r1);
    write_reg16(r1, shld16(____0, read_reg16(r), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_0FA4_mem(addr: i32, r: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, shld32(___, read_reg32(r), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_0FA4_reg(r1: i32, r: i32, imm: i32) {
    let ____0 = read_reg32(r1);
    write_reg32(r1, shld32(____0, read_reg32(r), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_0FA5_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        shld16(___, read_reg16(r), *reg8.offset(CL as isize) as i32 & 31)
    );
}
#[no_mangle]
pub unsafe fn instr16_0FA5_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    write_reg16(
        r1,
        shld16(____0, read_reg16(r), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr32_0FA5_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        shld32(___, read_reg32(r), *reg8.offset(CL as isize) as i32 & 31)
    );
}
#[no_mangle]
pub unsafe fn instr32_0FA5_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    write_reg32(
        r1,
        shld32(____0, read_reg32(r), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_0FA6() {
    // obsolete cmpxchg (os/2)
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_0FA7() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr16_0FA8() {
    return_on_pagefault!(push16(*sreg.offset(GS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_0FA8() {
    return_on_pagefault!(push32(*sreg.offset(GS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_0FA9() {
    if !switch_seg(GS, return_on_pagefault!(safe_read16(get_stack_pointer(0)))) {
        return;
    }
    else {
        adjust_stack_reg(2);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_0FA9() {
    if !switch_seg(
        GS,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0))) & 0xFFFF,
    ) {
        return;
    }
    else {
        adjust_stack_reg(4);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0FAA() {
    // rsm
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr16_0FAB_reg(r1: i32, r2: i32) {
    write_reg16(r1, bts_reg(read_reg16(r1), read_reg16(r2) & 15));
}
#[no_mangle]
pub unsafe fn instr16_0FAB_mem(addr: i32, r: i32) { bts_mem(addr, read_reg16(r) << 16 >> 16); }
#[no_mangle]
pub unsafe fn instr32_0FAB_reg(r1: i32, r2: i32) {
    write_reg32(r1, bts_reg(read_reg32(r1), read_reg32(r2) & 31));
}
#[no_mangle]
pub unsafe fn instr32_0FAB_mem(addr: i32, r: i32) { bts_mem(addr, read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr16_0FAC_mem(addr: i32, r: i32, imm: i32) {
    SAFE_READ_WRITE16!(___, addr, shrd16(___, read_reg16(r), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_0FAC_reg(r1: i32, r: i32, imm: i32) {
    let ____0 = read_reg16(r1);
    write_reg16(r1, shrd16(____0, read_reg16(r), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_0FAC_mem(addr: i32, r: i32, imm: i32) {
    SAFE_READ_WRITE32!(___, addr, shrd32(___, read_reg32(r), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_0FAC_reg(r1: i32, r: i32, imm: i32) {
    let ____0 = read_reg32(r1);
    write_reg32(r1, shrd32(____0, read_reg32(r), imm & 31));
}
#[no_mangle]
pub unsafe fn instr16_0FAD_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        shrd16(___, read_reg16(r), *reg8.offset(CL as isize) as i32 & 31)
    );
}
#[no_mangle]
pub unsafe fn instr16_0FAD_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    write_reg16(
        r1,
        shrd16(____0, read_reg16(r), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr32_0FAD_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        shrd32(___, read_reg32(r), *reg8.offset(CL as isize) as i32 & 31)
    );
}
#[no_mangle]
pub unsafe fn instr32_0FAD_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    write_reg32(
        r1,
        shrd32(____0, read_reg32(r), *reg8.offset(CL as isize) as i32 & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_0FAE_0_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_0_mem(addr: i32) { fxsave(addr); }
#[no_mangle]
pub unsafe fn instr_0FAE_1_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_1_mem(addr: i32) { fxrstor(addr); }
#[no_mangle]
pub unsafe fn instr_0FAE_2_reg(r: i32) { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0FAE_2_mem(addr: i32) {
    // ldmxcsr
    let new_mxcsr = return_on_pagefault!(safe_read32s(addr));
    if 0 != new_mxcsr & !MXCSR_MASK {
        dbg_log!("Invalid mxcsr bits: {:x}", new_mxcsr & !MXCSR_MASK);
        trigger_gp(0);
        return;
    }
    else {
        set_mxcsr(new_mxcsr);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0FAE_3_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_3_mem(addr: i32) {
    // stmxcsr
    return_on_pagefault!(safe_write32(addr, *mxcsr));
}
#[no_mangle]
pub unsafe fn instr_0FAE_4_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_4_mem(addr: i32) {
    // xsave
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0FAE_5_reg(_r: i32) {
    // lfence
}
#[no_mangle]
pub unsafe fn instr_0FAE_5_mem(addr: i32) {
    // xrstor
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0FAE_6_reg(_r: i32) {
    // mfence
}
#[no_mangle]
pub unsafe fn instr_0FAE_6_mem(addr: i32) {
    // xsaveopt
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0FAE_7_reg(_r: i32) {
    // sfence
}
#[no_mangle]
pub unsafe fn instr_0FAE_7_mem(addr: i32) {
    // clflush
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr16_0FAF_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, imul_reg16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0FAF_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    write_reg16(r, imul_reg16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FAF_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, imul_reg32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FAF_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    write_reg32(r, imul_reg32(read_reg32(r), ____0));
}

#[no_mangle]
pub unsafe fn instr_0FB0_reg(r1: i32, r2: i32) { write_reg8(r1, cmpxchg8(read_reg8(r1), r2)); }
#[no_mangle]
pub unsafe fn instr_0FB0_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE8!(___, addr, cmpxchg8(___, r));
}
#[no_mangle]
pub unsafe fn instr16_0FB1_reg(r1: i32, r2: i32) { write_reg16(r1, cmpxchg16(read_reg16(r1), r2)); }
#[no_mangle]
pub unsafe fn instr16_0FB1_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(___, addr, cmpxchg16(___, r));
}
#[no_mangle]
pub unsafe fn instr32_0FB1_reg(r1: i32, r2: i32) { write_reg32(r1, cmpxchg32(read_reg32(r1), r2)); }
#[no_mangle]
pub unsafe fn instr32_0FB1_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(___, addr, cmpxchg32(___, r));
}

#[no_mangle]
pub unsafe fn instr16_0FB2_reg(unused: i32, unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB2_mem(addr: i32, r: i32) { lss16(addr, get_reg16_index(r), SS); }
#[no_mangle]
pub unsafe fn instr32_0FB2_reg(unused: i32, unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FB2_mem(addr: i32, r: i32) { lss32(addr, r, SS); }
#[no_mangle]
pub unsafe fn instr16_0FB3_reg(r1: i32, r2: i32) {
    write_reg16(r1, btr_reg(read_reg16(r1), read_reg16(r2) & 15));
}
#[no_mangle]
pub unsafe fn instr16_0FB3_mem(addr: i32, r: i32) { btr_mem(addr, read_reg16(r) << 16 >> 16); }
#[no_mangle]
pub unsafe fn instr32_0FB3_reg(r1: i32, r2: i32) {
    write_reg32(r1, btr_reg(read_reg32(r1), read_reg32(r2) & 31));
}
#[no_mangle]
pub unsafe fn instr32_0FB3_mem(addr: i32, r: i32) { btr_mem(addr, read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr16_0FB4_reg(unused: i32, unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB4_mem(addr: i32, r: i32) { lss16(addr, get_reg16_index(r), FS); }
#[no_mangle]
pub unsafe fn instr32_0FB4_reg(unused: i32, unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FB4_mem(addr: i32, r: i32) { lss32(addr, r, FS); }
#[no_mangle]
pub unsafe fn instr16_0FB5_reg(unused: i32, unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB5_mem(addr: i32, r: i32) { lss16(addr, get_reg16_index(r), GS); }
#[no_mangle]
pub unsafe fn instr32_0FB5_reg(unused: i32, unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FB5_mem(addr: i32, r: i32) { lss32(addr, r, GS); }
#[no_mangle]
pub unsafe fn instr16_0FB6_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read8(addr));
    write_reg16(r, ____0);
}
#[no_mangle]
pub unsafe fn instr16_0FB6_reg(r1: i32, r: i32) {
    let ____0 = read_reg8(r1);
    write_reg16(r, ____0);
}
#[no_mangle]
pub unsafe fn instr32_0FB6_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read8(addr));
    write_reg32(r, ____0);
}
#[no_mangle]
pub unsafe fn instr32_0FB6_reg(r1: i32, r: i32) {
    let ____0 = read_reg8(r1);
    write_reg32(r, ____0);
}
#[no_mangle]
pub unsafe fn instr16_0FB7_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, ____0);
}
#[no_mangle]
pub unsafe fn instr16_0FB7_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    write_reg16(r, ____0);
}
#[no_mangle]
pub unsafe fn instr32_0FB7_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg32(r, ____0);
}
#[no_mangle]
pub unsafe fn instr32_0FB7_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    write_reg32(r, ____0);
}
#[no_mangle]
pub unsafe fn instr16_0FB8_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB8_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_F30FB8_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, popcnt(____0));
}
#[no_mangle]
pub unsafe fn instr16_F30FB8_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    write_reg16(r, popcnt(____0));
}
#[no_mangle]
pub unsafe fn instr32_0FB8_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FB8_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_F30FB8_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, popcnt(____0));
}
#[no_mangle]
pub unsafe fn instr32_F30FB8_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    write_reg32(r, popcnt(____0));
}
#[no_mangle]
pub unsafe fn instr_0FB9() {
    // UD2
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr16_0FBA_4_reg(r: i32, imm: i32) { bt_reg(read_reg16(r), imm & 15); }
#[no_mangle]
pub unsafe fn instr16_0FBA_4_mem(addr: i32, imm: i32) { bt_mem(addr, imm & 15); }
#[no_mangle]
pub unsafe fn instr16_0FBA_5_reg(r: i32, imm: i32) {
    write_reg16(r, bts_reg(read_reg16(r), imm & 15));
}
#[no_mangle]
pub unsafe fn instr16_0FBA_5_mem(addr: i32, imm: i32) { bts_mem(addr, imm & 15); }
#[no_mangle]
pub unsafe fn instr16_0FBA_6_reg(r: i32, imm: i32) {
    write_reg16(r, btr_reg(read_reg16(r), imm & 15));
}
#[no_mangle]
pub unsafe fn instr16_0FBA_6_mem(addr: i32, imm: i32) { btr_mem(addr, imm & 15); }
#[no_mangle]
pub unsafe fn instr16_0FBA_7_reg(r: i32, imm: i32) {
    write_reg16(r, btc_reg(read_reg16(r), imm & 15));
}
#[no_mangle]
pub unsafe fn instr16_0FBA_7_mem(addr: i32, imm: i32) { btc_mem(addr, imm & 15); }
#[no_mangle]
pub unsafe fn instr32_0FBA_4_reg(r: i32, imm: i32) { bt_reg(read_reg32(r), imm & 31); }
#[no_mangle]
pub unsafe fn instr32_0FBA_4_mem(addr: i32, imm: i32) { bt_mem(addr, imm & 31); }
#[no_mangle]
pub unsafe fn instr32_0FBA_5_reg(r: i32, imm: i32) {
    write_reg32(r, bts_reg(read_reg32(r), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_0FBA_5_mem(addr: i32, imm: i32) { bts_mem(addr, imm & 31); }
#[no_mangle]
pub unsafe fn instr32_0FBA_6_reg(r: i32, imm: i32) {
    write_reg32(r, btr_reg(read_reg32(r), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_0FBA_6_mem(addr: i32, imm: i32) { btr_mem(addr, imm & 31); }
#[no_mangle]
pub unsafe fn instr32_0FBA_7_reg(r: i32, imm: i32) {
    write_reg32(r, btc_reg(read_reg32(r), imm & 31));
}
#[no_mangle]
pub unsafe fn instr32_0FBA_7_mem(addr: i32, imm: i32) { btc_mem(addr, imm & 31); }
#[no_mangle]
pub unsafe fn instr16_0FBB_reg(r1: i32, r2: i32) {
    write_reg16(r1, btc_reg(read_reg16(r1), read_reg16(r2) & 15));
}
#[no_mangle]
pub unsafe fn instr16_0FBB_mem(addr: i32, r: i32) { btc_mem(addr, read_reg16(r) << 16 >> 16); }
#[no_mangle]
pub unsafe fn instr32_0FBB_reg(r1: i32, r2: i32) {
    write_reg32(r1, btc_reg(read_reg32(r1), read_reg32(r2) & 31));
}
#[no_mangle]
pub unsafe fn instr32_0FBB_mem(addr: i32, r: i32) { btc_mem(addr, read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr16_0FBC_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, bsf16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0FBC_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    write_reg16(r, bsf16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FBC_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, bsf32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FBC_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    write_reg32(r, bsf32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0FBD_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, bsr16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0FBD_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    write_reg16(r, bsr16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FBD_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, bsr32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FBD_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    write_reg32(r, bsr32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0FBE_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read8(addr));
    write_reg16(r, ____0 << 24 >> 24);
}
#[no_mangle]
pub unsafe fn instr16_0FBE_reg(r1: i32, r: i32) {
    let ____0 = read_reg8(r1);
    write_reg16(r, ____0 << 24 >> 24);
}
#[no_mangle]
pub unsafe fn instr32_0FBE_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read8(addr));
    write_reg32(r, ____0 << 24 >> 24);
}
#[no_mangle]
pub unsafe fn instr32_0FBE_reg(r1: i32, r: i32) {
    let ____0 = read_reg8(r1);
    write_reg32(r, ____0 << 24 >> 24);
}
#[no_mangle]
pub unsafe fn instr16_0FBF_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, ____0 << 16 >> 16);
}
#[no_mangle]
pub unsafe fn instr16_0FBF_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    write_reg16(r, ____0 << 16 >> 16);
}
#[no_mangle]
pub unsafe fn instr32_0FBF_mem(addr: i32, r: i32) {
    let ____0 = return_on_pagefault!(safe_read16(addr));
    write_reg32(r, ____0 << 16 >> 16);
}
#[no_mangle]
pub unsafe fn instr32_0FBF_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    write_reg32(r, ____0 << 16 >> 16);
}
#[no_mangle]
pub unsafe fn instr_0FC0_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE8!(___, addr, xadd8(___, get_reg8_index(r)));
}
#[no_mangle]
pub unsafe fn instr_0FC0_reg(r1: i32, r: i32) {
    let ____0 = read_reg8(r1);
    write_reg8(r1, xadd8(____0, get_reg8_index(r)));
}
#[no_mangle]
pub unsafe fn instr16_0FC1_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE16!(___, addr, xadd16(___, get_reg16_index(r)));
}
#[no_mangle]
pub unsafe fn instr16_0FC1_reg(r1: i32, r: i32) {
    let ____0 = read_reg16(r1);
    write_reg16(r1, xadd16(____0, get_reg16_index(r)));
}
#[no_mangle]
pub unsafe fn instr32_0FC1_mem(addr: i32, r: i32) {
    SAFE_READ_WRITE32!(___, addr, xadd32(___, r));
}
#[no_mangle]
pub unsafe fn instr32_0FC1_reg(r1: i32, r: i32) {
    let ____0 = read_reg32(r1);
    write_reg32(r1, xadd32(____0, r));
}
#[no_mangle]
pub unsafe fn instr_0FC3_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FC3_mem(addr: i32, r: i32) {
    // movnti
    return_on_pagefault!(safe_write32(addr, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_0FC4(source: i32, r: i32, imm8: i32) {
    // pinsrw mm, r32/m16, imm8
    let mut destination: reg64 = read_mmx64s(r);
    let index = (imm8 & 3) as u32;
    destination.u16_0[index as usize] = (source & 0xFFFF) as u16;
    write_mmx_reg64(r, destination);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FC4_reg(r1: i32, r2: i32, imm: i32) { instr_0FC4(read_reg32(r1), r2, imm); }
#[no_mangle]
pub unsafe fn instr_0FC4_mem(addr: i32, r: i32, imm: i32) {
    instr_0FC4(return_on_pagefault!(safe_read16(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_660FC4(source: i32, r: i32, imm8: i32) {
    // pinsrw xmm, r32/m16, imm8
    let mut destination: reg128 = read_xmm128s(r);
    let index = (imm8 & 7) as u32;
    destination.u16_0[index as usize] = (source & 0xFFFF) as u16;
    write_xmm_reg128(r, destination);
}
#[no_mangle]
pub unsafe fn instr_660FC4_reg(r1: i32, r2: i32, imm: i32) {
    instr_660FC4(read_reg32(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_660FC4_mem(addr: i32, r: i32, imm: i32) {
    instr_660FC4(return_on_pagefault!(safe_read16(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_0FC5_mem(addr: i32, r: i32, imm8: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FC5_reg(r1: i32, r2: i32, imm8: i32) {
    // pextrw r32, mm, imm8
    let data = read_mmx64s(r1);
    let index = (imm8 & 3) as u32;
    let result = data.u16_0[index as usize] as u32;
    write_reg32(r2, result as i32);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_660FC5_mem(addr: i32, r: i32, imm8: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FC5_reg(r1: i32, r2: i32, imm8: i32) {
    // pextrw r32, xmm, imm8
    let data = read_xmm128s(r1);
    let index = (imm8 & 7) as u32;
    let result = data.u16_0[index as usize] as u32;
    write_reg32(r2, result as i32);
}

#[no_mangle]
pub unsafe fn instr_0FC6(source: reg128, r: i32, imm8: i32) {
    // shufps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[(imm8 & 3) as usize] as i32,
        destination.u32_0[(imm8 >> 2 & 3) as usize] as i32,
        source.u32_0[(imm8 >> 4 & 3) as usize] as i32,
        source.u32_0[(imm8 >> 6 & 3) as usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0FC6_reg(r1: i32, r2: i32, imm: i32) { instr_0FC6(read_xmm128s(r1), r2, imm); }
#[no_mangle]
pub unsafe fn instr_0FC6_mem(addr: i32, r: i32, imm: i32) {
    instr_0FC6(return_on_pagefault!(safe_read128s(addr)), r, imm);
}

#[no_mangle]
pub unsafe fn instr_660FC6(source: reg128, r: i32, imm8: i32) {
    // shufpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        i64_0: [
            destination.i64_0[imm8 as usize & 1],
            source.i64_0[imm8 as usize >> 1 & 1],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FC6_reg(r1: i32, r2: i32, imm: i32) {
    instr_660FC6(read_xmm128s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_660FC6_mem(addr: i32, r: i32, imm: i32) {
    instr_660FC6(return_on_pagefault!(safe_read128s(addr)), r, imm);
}

#[no_mangle]
pub unsafe fn instr_0FC7_1_reg(r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FC7_1_mem(addr: i32) {
    // cmpxchg8b
    return_on_pagefault!(writable_or_pagefault(addr, 8));
    let m64_low = return_on_pagefault!(safe_read32s(addr));
    let m64_high = return_on_pagefault!(safe_read32s(addr + 4));
    if *reg32.offset(EAX as isize) == m64_low && *reg32.offset(EDX as isize) == m64_high {
        *flags |= FLAG_ZERO;
        safe_write32(addr, *reg32.offset(EBX as isize)).unwrap();
        safe_write32(addr + 4, *reg32.offset(ECX as isize)).unwrap();
    }
    else {
        *flags &= !FLAG_ZERO;
        *reg32.offset(EAX as isize) = m64_low;
        *reg32.offset(EDX as isize) = m64_high;
        safe_write32(addr, m64_low).unwrap();
        safe_write32(addr + 4, m64_high).unwrap();
    }
    *flags_changed &= !FLAG_ZERO;
}
#[no_mangle]
pub unsafe fn instr_0FC7_6_reg(r: i32) {
    // rdrand
    let rand = get_rand_int();
    write_reg_osize(r, rand);
    *flags &= !FLAGS_ALL;
    *flags |= 1;
    *flags_changed = 0;
}
#[no_mangle]
pub unsafe fn instr_0FC7_6_mem(addr: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FC8() { bswap(EAX); }
#[no_mangle]
pub unsafe fn instr_0FC9() { bswap(ECX); }
#[no_mangle]
pub unsafe fn instr_0FCA() { bswap(EDX); }
#[no_mangle]
pub unsafe fn instr_0FCB() { bswap(EBX); }
#[no_mangle]
pub unsafe fn instr_0FCC() { bswap(ESP); }
#[no_mangle]
pub unsafe fn instr_0FCD() { bswap(EBP); }
#[no_mangle]
pub unsafe fn instr_0FCE() { bswap(ESI); }
#[no_mangle]
pub unsafe fn instr_0FCF() { bswap(EDI); }
#[no_mangle]
pub unsafe fn instr_0FD0() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0FD1(source: reg64, r: i32) {
    // psrlw mm, mm/m64
    psrlw_r64(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_0FD1_reg(r1: i32, r2: i32) { instr_0FD1(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD1_mem(addr: i32, r: i32) {
    instr_0FD1(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD1(source: reg128, r: i32) {
    // psrlw xmm, xmm/m128
    // XXX: Aligned access or #gp
    psrlw_r128(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_660FD1_reg(r1: i32, r2: i32) { instr_660FD1(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FD1_mem(addr: i32, r: i32) {
    instr_660FD1(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD2(source: reg64, r: i32) {
    // psrld mm, mm/m64
    psrld_r64(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_0FD2_reg(r1: i32, r2: i32) { instr_0FD2(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD2_mem(addr: i32, r: i32) {
    instr_0FD2(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD2(source: reg128, r: i32) {
    // psrld xmm, xmm/m128
    // XXX: Aligned access or #gp
    psrld_r128(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_660FD2_reg(r1: i32, r2: i32) { instr_660FD2(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FD2_mem(addr: i32, r: i32) {
    instr_660FD2(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD3(source: reg64, r: i32) {
    // psrlq mm, mm/m64
    psrlq_r64(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_0FD3_reg(r1: i32, r2: i32) { instr_0FD3(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD3_mem(addr: i32, r: i32) {
    instr_0FD3(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD3(source: reg128, r: i32) {
    // psrlq xmm, mm/m64
    psrlq_r128(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_660FD3_reg(r1: i32, r2: i32) { instr_660FD3(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FD3_mem(addr: i32, r: i32) {
    instr_660FD3(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD4(source: reg64, r: i32) {
    // paddq mm, mm/m64
    let mut destination: reg64 = read_mmx64s(r);
    destination.u64_0[0] =
        (destination.u64_0[0] as u64).wrapping_add(source.u64_0[0]) as u64 as u64;
    write_mmx_reg64(r, destination);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FD4_reg(r1: i32, r2: i32) { instr_0FD4(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD4_mem(addr: i32, r: i32) {
    instr_0FD4(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD4(source: reg128, r: i32) {
    // paddq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let mut destination: reg128 = read_xmm128s(r);
    destination.u64_0[0] =
        (destination.u64_0[0] as u64).wrapping_add(source.u64_0[0]) as u64 as u64;
    destination.u64_0[1] =
        (destination.u64_0[1] as u64).wrapping_add(source.u64_0[1]) as u64 as u64;
    write_xmm_reg128(r, destination);
}
#[no_mangle]
pub unsafe fn instr_660FD4_reg(r1: i32, r2: i32) { instr_660FD4(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FD4_mem(addr: i32, r: i32) {
    instr_660FD4(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD5(source: reg64, r: i32) {
    // pmullw mm, mm/m64
    let destination = read_mmx64s(r);
    let word0 = destination.u16_0[0] as i32 * source.u16_0[0] as i32 & 0xFFFF;
    let word1 = destination.u16_0[1] as i32 * source.u16_0[1] as i32 & 0xFFFF;
    let word2 = destination.u16_0[2] as i32 * source.u16_0[2] as i32 & 0xFFFF;
    let word3 = destination.u16_0[3] as i32 * source.u16_0[3] as i32 & 0xFFFF;
    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FD5_reg(r1: i32, r2: i32) { instr_0FD5(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD5_mem(addr: i32, r: i32) {
    instr_0FD5(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD5(source: reg128, r: i32) {
    // pmullw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        source.u16_0[0] as i32 * destination.u16_0[0] as i32 & 0xFFFF
            | (source.u16_0[1] as i32 * destination.u16_0[1] as i32) << 16,
        source.u16_0[2] as i32 * destination.u16_0[2] as i32 & 0xFFFF
            | (source.u16_0[3] as i32 * destination.u16_0[3] as i32) << 16,
        source.u16_0[4] as i32 * destination.u16_0[4] as i32 & 0xFFFF
            | (source.u16_0[5] as i32 * destination.u16_0[5] as i32) << 16,
        source.u16_0[6] as i32 * destination.u16_0[6] as i32 & 0xFFFF
            | (source.u16_0[7] as i32 * destination.u16_0[7] as i32) << 16,
    );
}
#[no_mangle]
pub unsafe fn instr_660FD5_reg(r1: i32, r2: i32) { instr_660FD5(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FD5_mem(addr: i32, r: i32) {
    instr_660FD5(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD6_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FD6_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FD6_mem(addr: i32, r: i32) {
    // movq xmm/m64, xmm
    movl_r128_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_660FD6_reg(r1: i32, r2: i32) {
    // movq xmm/m64, xmm
    let data = read_xmm64s(r2);
    write_xmm128(r1, data.u32_0[0] as i32, data.u32_0[1] as i32, 0, 0);
}
#[no_mangle]
pub unsafe fn instr_F20FD6_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_F20FD6_reg(r1: i32, r2: i32) {
    // movdq2q mm, xmm
    let source = read_xmm128s(r1);
    write_mmx64(r2, source.u32_0[0] as i32, source.u32_0[1] as i32);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_F30FD6_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_F30FD6_reg(r1: i32, r2: i32) {
    // movq2dq xmm, mm
    let source = read_mmx64s(r1);
    write_xmm128(r2, source.u32_0[0] as i32, source.u32_0[1] as i32, 0, 0);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FD7_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FD7_reg(r1: i32, r2: i32) {
    // pmovmskb r, mm
    let x = read_mmx64s(r1);
    let result = (x.u8_0[0] as i32 >> 7 << 0
        | x.u8_0[1] as i32 >> 7 << 1
        | x.u8_0[2] as i32 >> 7 << 2
        | x.u8_0[3] as i32 >> 7 << 3
        | x.u8_0[4] as i32 >> 7 << 4
        | x.u8_0[5] as i32 >> 7 << 5
        | x.u8_0[6] as i32 >> 7 << 6
        | x.u8_0[7] as i32 >> 7 << 7) as u32;
    write_reg32(r2, result as i32);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_660FD7_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FD7_reg(r1: i32, r2: i32) {
    // pmovmskb reg, xmm
    let x = read_xmm128s(r1);
    let result = x.u8_0[0] as i32 >> 7 << 0
        | x.u8_0[1] as i32 >> 7 << 1
        | x.u8_0[2] as i32 >> 7 << 2
        | x.u8_0[3] as i32 >> 7 << 3
        | x.u8_0[4] as i32 >> 7 << 4
        | x.u8_0[5] as i32 >> 7 << 5
        | x.u8_0[6] as i32 >> 7 << 6
        | x.u8_0[7] as i32 >> 7 << 7
        | x.u8_0[8] as i32 >> 7 << 8
        | x.u8_0[9] as i32 >> 7 << 9
        | x.u8_0[10] as i32 >> 7 << 10
        | x.u8_0[11] as i32 >> 7 << 11
        | x.u8_0[12] as i32 >> 7 << 12
        | x.u8_0[13] as i32 >> 7 << 13
        | x.u8_0[14] as i32 >> 7 << 14
        | x.u8_0[15] as i32 >> 7 << 15;
    write_reg32(r2, result);
}
#[no_mangle]
pub unsafe fn instr_0FD8(source: reg64, r: i32) {
    // psubusb mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.u8_0[i as usize] =
            saturate_sd_to_ub(destination.u8_0[i as usize] as i32 - source.u8_0[i as usize] as i32)
                as u8;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FD8_reg(r1: i32, r2: i32) { instr_0FD8(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD8_mem(addr: i32, r: i32) {
    instr_0FD8(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD8(source: reg128, r: i32) {
    // psubusb xmm, xmm/m128
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..16 {
        result.u8_0[i as usize] =
            saturate_sd_to_ub(destination.u8_0[i as usize] as i32 - source.u8_0[i as usize] as i32)
                as u8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FD8_reg(r1: i32, r2: i32) { instr_660FD8(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FD8_mem(addr: i32, r: i32) {
    instr_660FD8(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD9(source: reg64, r: i32) {
    // psubusw mm, mm/m64
    let destination = read_mmx64s(r);
    let word0 = saturate_uw((destination.u16_0[0] as i32 - source.u16_0[0] as i32) as u32);
    let word1 = saturate_uw((destination.u16_0[1] as i32 - source.u16_0[1] as i32) as u32);
    let word2 = saturate_uw((destination.u16_0[2] as i32 - source.u16_0[2] as i32) as u32);
    let word3 = saturate_uw((destination.u16_0[3] as i32 - source.u16_0[3] as i32) as u32);
    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FD9_reg(r1: i32, r2: i32) { instr_0FD9(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD9_mem(addr: i32, r: i32) {
    instr_0FD9(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD9(source: reg128, r: i32) {
    // psubusw xmm, xmm/m128
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..8 {
        result.u16_0[i as usize] = saturate_uw(
            (destination.u16_0[i as usize] as i32 - source.u16_0[i as usize] as i32) as u32,
        ) as u16;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FD9_reg(r1: i32, r2: i32) { instr_660FD9(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FD9_mem(addr: i32, r: i32) {
    instr_660FD9(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDA(source: reg64, r: i32) {
    // pminub mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 { i8_0: [0; 8] };
    for i in 0..8 {
        result.u8_0[i as usize] =
            (if (source.u8_0[i as usize] as i32) < destination.u8_0[i as usize] as i32 {
                source.u8_0[i as usize] as i32
            }
            else {
                destination.u8_0[i as usize] as i32
            }) as u8;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FDA_reg(r1: i32, r2: i32) { instr_0FDA(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDA_mem(addr: i32, r: i32) {
    instr_0FDA(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDA(source: reg128, r: i32) {
    // pminub xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..16 {
        result.u8_0[i as usize] =
            (if (source.u8_0[i as usize] as i32) < destination.u8_0[i as usize] as i32 {
                source.u8_0[i as usize] as i32
            }
            else {
                destination.u8_0[i as usize] as i32
            }) as u8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FDA_reg(r1: i32, r2: i32) { instr_660FDA(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FDA_mem(addr: i32, r: i32) {
    instr_660FDA(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDB(source: reg64, r: i32) {
    // pand mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0] = source.u64_0[0] & destination.u64_0[0];
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FDB_reg(r1: i32, r2: i32) { instr_0FDB(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDB_mem(addr: i32, r: i32) {
    instr_0FDB(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDB(source: reg128, r: i32) {
    // pand xmm, xmm/m128
    // XXX: Aligned access or #gp
    pand_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660FDB_reg(r1: i32, r2: i32) { instr_660FDB(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FDB_mem(addr: i32, r: i32) {
    instr_660FDB(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDC(source: reg64, r: i32) {
    // paddusb mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.u8_0[i as usize] = saturate_ud_to_ub(
            (destination.u8_0[i as usize] as i32 + source.u8_0[i as usize] as i32) as u32,
        ) as u8;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FDC_reg(r1: i32, r2: i32) { instr_0FDC(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDC_mem(addr: i32, r: i32) {
    instr_0FDC(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDC(source: reg128, r: i32) {
    // paddusb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..16 {
        result.u8_0[i as usize] = saturate_ud_to_ub(
            (source.u8_0[i as usize] as i32 + destination.u8_0[i as usize] as i32) as u32,
        ) as u8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FDC_reg(r1: i32, r2: i32) { instr_660FDC(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FDC_mem(addr: i32, r: i32) {
    instr_660FDC(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDD(source: reg64, r: i32) {
    // paddusw mm, mm/m64
    let destination = read_mmx64s(r);
    let word0 = saturate_uw((destination.u16_0[0] as i32 + source.u16_0[0] as i32) as u32);
    let word1 = saturate_uw((destination.u16_0[1] as i32 + source.u16_0[1] as i32) as u32);
    let word2 = saturate_uw((destination.u16_0[2] as i32 + source.u16_0[2] as i32) as u32);
    let word3 = saturate_uw((destination.u16_0[3] as i32 + source.u16_0[3] as i32) as u32);
    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FDD_reg(r1: i32, r2: i32) { instr_0FDD(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDD_mem(addr: i32, r: i32) {
    instr_0FDD(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDD(source: reg128, r: i32) {
    // paddusw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        saturate_uw((source.u16_0[0] as i32 + destination.u16_0[0] as i32) as u32)
            | saturate_uw((source.u16_0[1] as i32 + destination.u16_0[1] as i32) as u32) << 16,
        saturate_uw((source.u16_0[2] as i32 + destination.u16_0[2] as i32) as u32)
            | saturate_uw((source.u16_0[3] as i32 + destination.u16_0[3] as i32) as u32) << 16,
        saturate_uw((source.u16_0[4] as i32 + destination.u16_0[4] as i32) as u32)
            | saturate_uw((source.u16_0[5] as i32 + destination.u16_0[5] as i32) as u32) << 16,
        saturate_uw((source.u16_0[6] as i32 + destination.u16_0[6] as i32) as u32)
            | saturate_uw((source.u16_0[7] as i32 + destination.u16_0[7] as i32) as u32) << 16,
    );
}
#[no_mangle]
pub unsafe fn instr_660FDD_reg(r1: i32, r2: i32) { instr_660FDD(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FDD_mem(addr: i32, r: i32) {
    instr_660FDD(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDE(source: reg64, r: i32) {
    // pmaxub mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 { i8_0: [0; 8] };
    for i in 0..8 {
        result.u8_0[i as usize] =
            (if source.u8_0[i as usize] as i32 > destination.u8_0[i as usize] as i32 {
                source.u8_0[i as usize] as i32
            }
            else {
                destination.u8_0[i as usize] as i32
            }) as u8;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FDE_reg(r1: i32, r2: i32) { instr_0FDE(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDE_mem(addr: i32, r: i32) {
    instr_0FDE(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDE(source: reg128, r: i32) {
    // pmaxub xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..16 {
        result.u8_0[i as usize] =
            (if source.u8_0[i as usize] as i32 > destination.u8_0[i as usize] as i32 {
                source.u8_0[i as usize] as i32
            }
            else {
                destination.u8_0[i as usize] as i32
            }) as u8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FDE_reg(r1: i32, r2: i32) { instr_660FDE(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FDE_mem(addr: i32, r: i32) {
    instr_660FDE(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDF(source: reg64, r: i32) {
    // pandn mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0] = source.u64_0[0] & !destination.u64_0[0];
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FDF_reg(r1: i32, r2: i32) { instr_0FDF(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDF_mem(addr: i32, r: i32) {
    instr_0FDF(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDF(source: reg128, r: i32) {
    // pandn xmm, xmm/m128
    // XXX: Aligned access or #gp
    pandn_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660FDF_reg(r1: i32, r2: i32) { instr_660FDF(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FDF_mem(addr: i32, r: i32) {
    instr_660FDF(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE0(source: reg64, r: i32) {
    // pavgb mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.u8_0[i as usize] =
            (destination.u8_0[i as usize] as i32 + source.u8_0[i as usize] as i32 + 1 >> 1) as u8;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FE0_reg(r1: i32, r2: i32) { instr_0FE0(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE0_mem(addr: i32, r: i32) {
    instr_0FE0(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE0(source: reg128, r: i32) {
    // pavgb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..16 {
        result.u8_0[i as usize] =
            (destination.u8_0[i as usize] as i32 + source.u8_0[i as usize] as i32 + 1 >> 1) as u8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FE0_reg(r1: i32, r2: i32) { instr_660FE0(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FE0_mem(addr: i32, r: i32) {
    instr_660FE0(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE1(source: reg64, r: i32) {
    // psraw mm, mm/m64
    psraw_r64(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_0FE1_reg(r1: i32, r2: i32) { instr_0FE1(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE1_mem(addr: i32, r: i32) {
    instr_0FE1(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE1(source: reg128, r: i32) {
    // psraw xmm, xmm/m128
    // XXX: Aligned access or #gp
    psraw_r128(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_660FE1_reg(r1: i32, r2: i32) { instr_660FE1(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FE1_mem(addr: i32, r: i32) {
    instr_660FE1(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE2(source: reg64, r: i32) {
    // psrad mm, mm/m64
    psrad_r64(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_0FE2_reg(r1: i32, r2: i32) { instr_0FE2(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE2_mem(addr: i32, r: i32) {
    instr_0FE2(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE2(source: reg128, r: i32) {
    // psrad xmm, xmm/m128
    // XXX: Aligned access or #gp
    psrad_r128(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_660FE2_reg(r1: i32, r2: i32) { instr_660FE2(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FE2_mem(addr: i32, r: i32) {
    instr_660FE2(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE3(source: reg64, r: i32) {
    // pavgw mm, mm/m64
    let mut destination: reg64 = read_mmx64s(r);
    destination.u16_0[0] = (destination.u16_0[0] as i32 + source.u16_0[0] as i32 + 1 >> 1) as u16;
    destination.u16_0[1] = (destination.u16_0[1] as i32 + source.u16_0[1] as i32 + 1 >> 1) as u16;
    destination.u16_0[2] = (destination.u16_0[2] as i32 + source.u16_0[2] as i32 + 1 >> 1) as u16;
    destination.u16_0[3] = (destination.u16_0[3] as i32 + source.u16_0[3] as i32 + 1 >> 1) as u16;
    write_mmx_reg64(r, destination);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FE3_reg(r1: i32, r2: i32) { instr_0FE3(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE3_mem(addr: i32, r: i32) {
    instr_0FE3(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE3(source: reg128, r: i32) {
    // pavgw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let mut destination: reg128 = read_xmm128s(r);
    destination.u16_0[0] = (destination.u16_0[0] as i32 + source.u16_0[0] as i32 + 1 >> 1) as u16;
    destination.u16_0[1] = (destination.u16_0[1] as i32 + source.u16_0[1] as i32 + 1 >> 1) as u16;
    destination.u16_0[2] = (destination.u16_0[2] as i32 + source.u16_0[2] as i32 + 1 >> 1) as u16;
    destination.u16_0[3] = (destination.u16_0[3] as i32 + source.u16_0[3] as i32 + 1 >> 1) as u16;
    destination.u16_0[4] = (destination.u16_0[4] as i32 + source.u16_0[4] as i32 + 1 >> 1) as u16;
    destination.u16_0[5] = (destination.u16_0[5] as i32 + source.u16_0[5] as i32 + 1 >> 1) as u16;
    destination.u16_0[6] = (destination.u16_0[6] as i32 + source.u16_0[6] as i32 + 1 >> 1) as u16;
    destination.u16_0[7] = (destination.u16_0[7] as i32 + source.u16_0[7] as i32 + 1 >> 1) as u16;
    write_xmm_reg128(r, destination);
}
#[no_mangle]
pub unsafe fn instr_660FE3_reg(r1: i32, r2: i32) { instr_660FE3(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FE3_mem(addr: i32, r: i32) {
    instr_660FE3(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE4(source: reg64, r: i32) {
    // pmulhuw mm, mm/m64
    let destination = read_mmx64s(r);
    write_mmx64(
        r,
        ((source.u16_0[0] as i32 * destination.u16_0[0] as i32 >> 16 & 0xFFFF) as u32
            | (source.u16_0[1] as i32 * destination.u16_0[1] as i32) as u32 & 0xFFFF0000)
            as i32,
        ((source.u16_0[2] as i32 * destination.u16_0[2] as i32 >> 16 & 0xFFFF) as u32
            | (source.u16_0[3] as i32 * destination.u16_0[3] as i32) as u32 & 0xFFFF0000)
            as i32,
    );
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FE4_reg(r1: i32, r2: i32) { instr_0FE4(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE4_mem(addr: i32, r: i32) {
    instr_0FE4(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE4(source: reg128, r: i32) {
    // pmulhuw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        ((source.u16_0[0] as i32 * destination.u16_0[0] as i32 >> 16 & 0xFFFF) as u32
            | (source.u16_0[1] as i32 * destination.u16_0[1] as i32) as u32 & 0xFFFF0000)
            as i32,
        ((source.u16_0[2] as i32 * destination.u16_0[2] as i32 >> 16 & 0xFFFF) as u32
            | (source.u16_0[3] as i32 * destination.u16_0[3] as i32) as u32 & 0xFFFF0000)
            as i32,
        ((source.u16_0[4] as i32 * destination.u16_0[4] as i32 >> 16 & 0xFFFF) as u32
            | (source.u16_0[5] as i32 * destination.u16_0[5] as i32) as u32 & 0xFFFF0000)
            as i32,
        ((source.u16_0[6] as i32 * destination.u16_0[6] as i32 >> 16 & 0xFFFF) as u32
            | (source.u16_0[7] as i32 * destination.u16_0[7] as i32) as u32 & 0xFFFF0000)
            as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660FE4_reg(r1: i32, r2: i32) { instr_660FE4(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FE4_mem(addr: i32, r: i32) {
    instr_660FE4(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE5(source: reg64, r: i32) {
    // pmulhw mm, mm/m64
    let destination = read_mmx64s(r);
    let word0 = (destination.i16_0[0] as i32 * source.i16_0[0] as i32 >> 16 & 0xFFFF) as u32;
    let word1 = (destination.i16_0[1] as i32 * source.i16_0[1] as i32 >> 16 & 0xFFFF) as u32;
    let word2 = (destination.i16_0[2] as i32 * source.i16_0[2] as i32 >> 16 & 0xFFFF) as u32;
    let word3 = (destination.i16_0[3] as i32 * source.i16_0[3] as i32 >> 16 & 0xFFFF) as u32;
    let low = (word0 | word1 << 16) as i32;
    let high = (word2 | word3 << 16) as i32;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FE5_reg(r1: i32, r2: i32) { instr_0FE5(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE5_mem(addr: i32, r: i32) {
    instr_0FE5(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE5(source: reg128, r: i32) {
    // pmulhw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let dword0 = ((destination.i16_0[0] as i32 * source.i16_0[0] as i32 >> 16 & 0xFFFF) as u32
        | (destination.i16_0[1] as i32 * source.i16_0[1] as i32) as u32 & 0xFFFF0000)
        as i32;
    let dword1 = ((destination.i16_0[2] as i32 * source.i16_0[2] as i32 >> 16 & 0xFFFF) as u32
        | (destination.i16_0[3] as i32 * source.i16_0[3] as i32) as u32 & 0xFFFF0000)
        as i32;
    let dword2 = ((destination.i16_0[4] as i32 * source.i16_0[4] as i32 >> 16 & 0xFFFF) as u32
        | (destination.i16_0[5] as i32 * source.i16_0[5] as i32) as u32 & 0xFFFF0000)
        as i32;
    let dword3 = ((destination.i16_0[6] as i32 * source.i16_0[6] as i32 >> 16 & 0xFFFF) as u32
        | (destination.i16_0[7] as i32 * source.i16_0[7] as i32) as u32 & 0xFFFF0000)
        as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660FE5_reg(r1: i32, r2: i32) { instr_660FE5(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FE5_mem(addr: i32, r: i32) {
    instr_660FE5(return_on_pagefault!(safe_read128s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0FE6_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FE6_reg(r1: i32, r2: i32) { trigger_ud(); }

#[no_mangle]
pub unsafe fn instr_660FE6(source: reg128, r: i32) {
    // cvttpd2dq xmm1, xmm2/m128
    let result = reg128 {
        i32_0: [
            sse_convert_f64_to_i32(source.f64_0[0].trunc()),
            sse_convert_f64_to_i32(source.f64_0[1].trunc()),
            0,
            0,
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FE6_mem(addr: i32, r: i32) {
    instr_660FE6(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE6_reg(r1: i32, r2: i32) { instr_660FE6(read_xmm128s(r1), r2); }

#[no_mangle]
pub unsafe fn instr_F20FE6(source: reg128, r: i32) {
    // cvtpd2dq xmm1, xmm2/m128
    let result = reg128 {
        i32_0: [
            // XXX: Precision exception
            sse_convert_f64_to_i32(source.f64_0[0].round()),
            sse_convert_f64_to_i32(source.f64_0[1].round()),
            0,
            0,
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20FE6_mem(addr: i32, r: i32) {
    instr_F20FE6(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20FE6_reg(r1: i32, r2: i32) { instr_F20FE6(read_xmm128s(r1), r2); }

#[no_mangle]
pub unsafe fn instr_F30FE6(source: reg64, r: i32) {
    // cvtdq2pd xmm1, xmm2/m64
    let result = reg128 {
        f64_0: [
            // Note: Conversion never fails (i32 fits into f64)
            source.i32_0[0] as f64,
            source.i32_0[1] as f64,
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30FE6_mem(addr: i32, r: i32) {
    instr_F30FE6(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30FE6_reg(r1: i32, r2: i32) { instr_F30FE6(read_xmm64s(r1), r2); }

#[no_mangle]
pub unsafe fn instr_0FE7_mem(addr: i32, r: i32) {
    // movntq m64, mm
    mov_r_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0FE7_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FE7_reg(r1: i32, r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FE7_mem(addr: i32, r: i32) {
    // movntdq m128, xmm
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0FE8(source: reg64, r: i32) {
    // psubsb mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.u8_0[i as usize] = saturate_sd_to_sb(
            (destination.i8_0[i as usize] as i32 - source.i8_0[i as usize] as i32) as u32,
        ) as u8;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FE8_reg(r1: i32, r2: i32) { instr_0FE8(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE8_mem(addr: i32, r: i32) {
    instr_0FE8(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE8(source: reg128, r: i32) {
    // psubsb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..16 {
        result.i8_0[i as usize] = saturate_sd_to_sb(
            (destination.i8_0[i as usize] as i32 - source.i8_0[i as usize] as i32) as u32,
        ) as i8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FE8_reg(r1: i32, r2: i32) { instr_660FE8(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FE8_mem(addr: i32, r: i32) {
    instr_660FE8(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE9(source: reg64, r: i32) {
    // psubsw mm, mm/m64
    let destination = read_mmx64s(r);
    let word0 =
        saturate_sd_to_sw((destination.i16_0[0] as i32 - source.i16_0[0] as i32) as u32) as i32;
    let word1 =
        saturate_sd_to_sw((destination.i16_0[1] as i32 - source.i16_0[1] as i32) as u32) as i32;
    let word2 =
        saturate_sd_to_sw((destination.i16_0[2] as i32 - source.i16_0[2] as i32) as u32) as i32;
    let word3 =
        saturate_sd_to_sw((destination.i16_0[3] as i32 - source.i16_0[3] as i32) as u32) as i32;
    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FE9_reg(r1: i32, r2: i32) { instr_0FE9(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE9_mem(addr: i32, r: i32) {
    instr_0FE9(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE9(source: reg128, r: i32) {
    // psubsw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let dword0 = (saturate_sd_to_sw((destination.i16_0[0] as i32 - source.i16_0[0] as i32) as u32)
        | saturate_sd_to_sw((destination.i16_0[1] as i32 - source.i16_0[1] as i32) as u32) << 16)
        as i32;
    let dword1 = (saturate_sd_to_sw((destination.i16_0[2] as i32 - source.i16_0[2] as i32) as u32)
        | saturate_sd_to_sw((destination.i16_0[3] as i32 - source.i16_0[3] as i32) as u32) << 16)
        as i32;
    let dword2 = (saturate_sd_to_sw((destination.i16_0[4] as i32 - source.i16_0[4] as i32) as u32)
        | saturate_sd_to_sw((destination.i16_0[5] as i32 - source.i16_0[5] as i32) as u32) << 16)
        as i32;
    let dword3 = (saturate_sd_to_sw((destination.i16_0[6] as i32 - source.i16_0[6] as i32) as u32)
        | saturate_sd_to_sw((destination.i16_0[7] as i32 - source.i16_0[7] as i32) as u32) << 16)
        as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660FE9_reg(r1: i32, r2: i32) { instr_660FE9(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FE9_mem(addr: i32, r: i32) {
    instr_660FE9(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEA(source: reg64, r: i32) {
    // pminsw mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 { i8_0: [0; 8] };
    for i in 0..4 {
        result.i16_0[i as usize] =
            (if (destination.i16_0[i as usize] as i32) < source.i16_0[i as usize] as i32 {
                destination.i16_0[i as usize] as i32
            }
            else {
                source.i16_0[i as usize] as i32
            }) as i16;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FEA_reg(r1: i32, r2: i32) { instr_0FEA(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FEA_mem(addr: i32, r: i32) {
    instr_0FEA(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEA(source: reg128, r: i32) {
    // pminsw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..8 {
        result.i16_0[i as usize] =
            (if (destination.i16_0[i as usize] as i32) < source.i16_0[i as usize] as i32 {
                destination.i16_0[i as usize] as i32
            }
            else {
                source.i16_0[i as usize] as i32
            }) as i16;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FEA_reg(r1: i32, r2: i32) { instr_660FEA(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FEA_mem(addr: i32, r: i32) {
    instr_660FEA(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEB(source: reg64, r: i32) {
    // por mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0] = source.u64_0[0] | destination.u64_0[0];
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FEB_reg(r1: i32, r2: i32) { instr_0FEB(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FEB_mem(addr: i32, r: i32) {
    instr_0FEB(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEB(source: reg128, r: i32) {
    // por xmm, xmm/m128
    // XXX: Aligned access or #gp
    por_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660FEB_reg(r1: i32, r2: i32) { instr_660FEB(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FEB_mem(addr: i32, r: i32) {
    instr_660FEB(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEC(source: reg64, r: i32) {
    // paddsb mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.u8_0[i as usize] = saturate_sd_to_sb(
            (destination.i8_0[i as usize] as i32 + source.i8_0[i as usize] as i32) as u32,
        ) as u8;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FEC_reg(r1: i32, r2: i32) { instr_0FEC(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FEC_mem(addr: i32, r: i32) {
    instr_0FEC(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEC(source: reg128, r: i32) {
    // paddsb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..16 {
        result.i8_0[i as usize] = saturate_sd_to_sb(
            (destination.i8_0[i as usize] as i32 + source.i8_0[i as usize] as i32) as u32,
        ) as i8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FEC_reg(r1: i32, r2: i32) { instr_660FEC(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FEC_mem(addr: i32, r: i32) {
    instr_660FEC(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FED(source: reg64, r: i32) {
    // paddsw mm, mm/m64
    let destination = read_mmx64s(r);
    let word0 =
        saturate_sd_to_sw((destination.i16_0[0] as i32 + source.i16_0[0] as i32) as u32) as i32;
    let word1 =
        saturate_sd_to_sw((destination.i16_0[1] as i32 + source.i16_0[1] as i32) as u32) as i32;
    let word2 =
        saturate_sd_to_sw((destination.i16_0[2] as i32 + source.i16_0[2] as i32) as u32) as i32;
    let word3 =
        saturate_sd_to_sw((destination.i16_0[3] as i32 + source.i16_0[3] as i32) as u32) as i32;
    let low = word0 | word1 << 16;
    let high = word2 | word3 << 16;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FED_reg(r1: i32, r2: i32) { instr_0FED(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FED_mem(addr: i32, r: i32) {
    instr_0FED(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FED(source: reg128, r: i32) {
    // paddsw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let dword0 = (saturate_sd_to_sw((destination.i16_0[0] as i32 + source.i16_0[0] as i32) as u32)
        | saturate_sd_to_sw((destination.i16_0[1] as i32 + source.i16_0[1] as i32) as u32) << 16)
        as i32;
    let dword1 = (saturate_sd_to_sw((destination.i16_0[2] as i32 + source.i16_0[2] as i32) as u32)
        | saturate_sd_to_sw((destination.i16_0[3] as i32 + source.i16_0[3] as i32) as u32) << 16)
        as i32;
    let dword2 = (saturate_sd_to_sw((destination.i16_0[4] as i32 + source.i16_0[4] as i32) as u32)
        | saturate_sd_to_sw((destination.i16_0[5] as i32 + source.i16_0[5] as i32) as u32) << 16)
        as i32;
    let dword3 = (saturate_sd_to_sw((destination.i16_0[6] as i32 + source.i16_0[6] as i32) as u32)
        | saturate_sd_to_sw((destination.i16_0[7] as i32 + source.i16_0[7] as i32) as u32) << 16)
        as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660FED_reg(r1: i32, r2: i32) { instr_660FED(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FED_mem(addr: i32, r: i32) {
    instr_660FED(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEE(source: reg64, r: i32) {
    // pmaxsw mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 { i8_0: [0; 8] };
    for i in 0..4 {
        result.i16_0[i as usize] =
            (if destination.i16_0[i as usize] as i32 >= source.i16_0[i as usize] as i32 {
                destination.i16_0[i as usize] as i32
            }
            else {
                source.i16_0[i as usize] as i32
            }) as i16;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FEE_reg(r1: i32, r2: i32) { instr_0FEE(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FEE_mem(addr: i32, r: i32) {
    instr_0FEE(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEE(source: reg128, r: i32) {
    // pmaxsw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    for i in 0..8 {
        result.i16_0[i as usize] =
            (if destination.i16_0[i as usize] as i32 >= source.i16_0[i as usize] as i32 {
                destination.i16_0[i as usize] as i32
            }
            else {
                source.i16_0[i as usize] as i32
            }) as i16;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FEE_reg(r1: i32, r2: i32) { instr_660FEE(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FEE_mem(addr: i32, r: i32) {
    instr_660FEE(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEF(source: reg64, r: i32) {
    // pxor mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0] = source.u64_0[0] ^ destination.u64_0[0];
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FEF_reg(r1: i32, r2: i32) { instr_0FEF(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FEF_mem(addr: i32, r: i32) {
    instr_0FEF(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEF(source: reg128, r: i32) {
    // pxor xmm, xmm/m128
    // XXX: Aligned access or #gp
    pxor_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660FEF_reg(r1: i32, r2: i32) { instr_660FEF(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FEF_mem(addr: i32, r: i32) {
    instr_660FEF(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF0() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0FF1(source: reg64, r: i32) {
    // psllw mm, mm/m64
    psllw_r64(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_0FF1_reg(r1: i32, r2: i32) { instr_0FF1(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF1_mem(addr: i32, r: i32) {
    instr_0FF1(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF1(source: reg128, r: i32) {
    // psllw xmm, xmm/m128
    // XXX: Aligned access or #gp
    psllw_r128(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_660FF1_reg(r1: i32, r2: i32) { instr_660FF1(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FF1_mem(addr: i32, r: i32) {
    instr_660FF1(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF2(source: reg64, r: i32) {
    // pslld mm, mm/m64
    pslld_r64(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_0FF2_reg(r1: i32, r2: i32) { instr_0FF2(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF2_mem(addr: i32, r: i32) {
    instr_0FF2(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF2(source: reg128, r: i32) {
    // pslld xmm, xmm/m128
    // XXX: Aligned access or #gp
    pslld_r128(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_660FF2_reg(r1: i32, r2: i32) { instr_660FF2(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FF2_mem(addr: i32, r: i32) {
    instr_660FF2(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF3(source: reg64, r: i32) {
    // psllq mm, mm/m64
    psllq_r64(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_0FF3_reg(r1: i32, r2: i32) { instr_0FF3(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF3_mem(addr: i32, r: i32) {
    instr_0FF3(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF3(source: reg128, r: i32) {
    // psllq xmm, xmm/m128
    // XXX: Aligned access or #gp
    psllq_r128(r, source.u64_0[0]);
}
#[no_mangle]
pub unsafe fn instr_660FF3_reg(r1: i32, r2: i32) { instr_660FF3(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FF3_mem(addr: i32, r: i32) {
    instr_660FF3(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF4(source: reg64, r: i32) {
    // pmuludq mm, mm/m64
    let mut destination: reg64 = read_mmx64s(r);
    destination.u64_0[0] = (source.u32_0[0] as u64).wrapping_mul(destination.u32_0[0] as u64);
    write_mmx_reg64(r, destination);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FF4_reg(r1: i32, r2: i32) { instr_0FF4(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF4_mem(addr: i32, r: i32) {
    instr_0FF4(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF4(source: reg128, r: i32) {
    // pmuludq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let mut destination: reg128 = read_xmm128s(r);
    destination.u64_0[0] = (source.u32_0[0] as u64).wrapping_mul(destination.u32_0[0] as u64);
    destination.u64_0[1] = (source.u32_0[2] as u64).wrapping_mul(destination.u32_0[2] as u64);
    write_xmm_reg128(r, destination);
}
#[no_mangle]
pub unsafe fn instr_660FF4_reg(r1: i32, r2: i32) { instr_660FF4(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FF4_mem(addr: i32, r: i32) {
    instr_660FF4(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF5(source: reg64, r: i32) {
    // pmaddwd mm, mm/m64
    let destination = read_mmx64s(r);
    let mul0 = destination.i16_0[0] as i32 * source.i16_0[0] as i32;
    let mul1 = destination.i16_0[1] as i32 * source.i16_0[1] as i32;
    let mul2 = destination.i16_0[2] as i32 * source.i16_0[2] as i32;
    let mul3 = destination.i16_0[3] as i32 * source.i16_0[3] as i32;
    let low = mul0 + mul1;
    let high = mul2 + mul3;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FF5_reg(r1: i32, r2: i32) { instr_0FF5(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF5_mem(addr: i32, r: i32) {
    instr_0FF5(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF5(source: reg128, r: i32) {
    // pmaddwd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let dword0 = destination.i16_0[0] as i32 * source.i16_0[0] as i32
        + destination.i16_0[1] as i32 * source.i16_0[1] as i32;
    let dword1 = destination.i16_0[2] as i32 * source.i16_0[2] as i32
        + destination.i16_0[3] as i32 * source.i16_0[3] as i32;
    let dword2 = destination.i16_0[4] as i32 * source.i16_0[4] as i32
        + destination.i16_0[5] as i32 * source.i16_0[5] as i32;
    let dword3 = destination.i16_0[6] as i32 * source.i16_0[6] as i32
        + destination.i16_0[7] as i32 * source.i16_0[7] as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660FF5_reg(r1: i32, r2: i32) { instr_660FF5(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FF5_mem(addr: i32, r: i32) {
    instr_660FF5(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF6(source: reg64, r: i32) {
    // psadbw mm, mm/m64
    let destination = read_mmx64s(r);
    let mut sum: u32 = 0;
    for i in 0..8 {
        sum = (sum as u32).wrapping_add(
            (destination.u8_0[i as usize] as i32 - source.u8_0[i as usize] as i32).abs() as u32,
        ) as u32 as u32;
    }
    write_mmx64(r, sum as i32, 0);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FF6_reg(r1: i32, r2: i32) { instr_0FF6(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF6_mem(addr: i32, r: i32) {
    instr_0FF6(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF6(source: reg128, r: i32) {
    // psadbw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut sum0: u32 = 0;
    let mut sum1: u32 = 0;
    for i in 0..8 {
        sum0 = (sum0 as u32).wrapping_add(
            (destination.u8_0[i as usize] as i32 - source.u8_0[i as usize] as i32).abs() as u32,
        ) as u32 as u32;
        sum1 = (sum1 as u32)
            .wrapping_add((destination.u8_0[i + 8] as i32 - source.u8_0[i + 8] as i32).abs() as u32)
            as u32 as u32;
    }
    write_xmm128(r, sum0 as i32, 0, sum1 as i32, 0);
}
#[no_mangle]
pub unsafe fn instr_660FF6_reg(r1: i32, r2: i32) { instr_660FF6(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FF6_mem(addr: i32, r: i32) {
    instr_660FF6(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF7_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FF7_reg(r1: i32, r2: i32) {
    // maskmovq mm, mm
    let source = read_mmx64s(r2);
    let mask = read_mmx64s(r1);
    let addr = get_seg_prefix(DS) + get_reg_asize(EDI);
    return_on_pagefault!(writable_or_pagefault(addr, 8));
    for i in 0..8 {
        if 0 != mask.u8_0[i as usize] as i32 & 128 {
            safe_write8(
                (addr as u32).wrapping_add(i) as i32,
                source.u8_0[i as usize] as i32,
            )
            .unwrap();
        }
    }
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_660FF7_mem(addr: i32, r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FF7_reg(r1: i32, r2: i32) {
    // maskmovdqu xmm, xmm
    let source = read_xmm128s(r2);
    let mask = read_xmm128s(r1);
    let addr = get_seg_prefix(DS) + get_reg_asize(EDI);
    return_on_pagefault!(writable_or_pagefault(addr, 16));
    for i in 0..16 {
        if 0 != mask.u8_0[i as usize] as i32 & 128 {
            safe_write8(
                (addr as u32).wrapping_add(i) as i32,
                source.u8_0[i as usize] as i32,
            )
            .unwrap();
        }
    }
}
#[no_mangle]
pub unsafe fn instr_0FF8(source: reg64, r: i32) {
    // psubb mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.u8_0[i as usize] =
            (destination.i8_0[i as usize] as i32 - source.i8_0[i as usize] as i32 & 255) as u8;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FF8_reg(r1: i32, r2: i32) { instr_0FF8(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF8_mem(addr: i32, r: i32) {
    instr_0FF8(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF8(source: reg128, r: i32) {
    // psubb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..16 {
        result.i8_0[i as usize] =
            (destination.i8_0[i as usize] as i32 - source.i8_0[i as usize] as i32 & 255) as i8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FF8_reg(r1: i32, r2: i32) { instr_660FF8(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FF8_mem(addr: i32, r: i32) {
    instr_660FF8(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF9(source: reg64, r: i32) {
    // psubw mm, mm/m64
    let destination = read_mmx64s(r);
    let word0 = (destination.u32_0[0].wrapping_sub(source.u32_0[0]) & 0xFFFF) as i32;
    let word1 =
        ((destination.u16_0[1] as u32).wrapping_sub(source.u16_0[1] as u32) & 0xFFFF) as i32;
    let low = word0 | word1 << 16;
    let word2 = (destination.u32_0[1].wrapping_sub(source.u32_0[1]) & 0xFFFF) as i32;
    let word3 =
        ((destination.u16_0[3] as u32).wrapping_sub(source.u16_0[3] as u32) & 0xFFFF) as i32;
    let high = word2 | word3 << 16;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FF9_reg(r1: i32, r2: i32) { instr_0FF9(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF9_mem(addr: i32, r: i32) {
    instr_0FF9(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF9(source: reg128, r: i32) {
    // psubw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.i16_0[i as usize] = (destination.i16_0[i as usize] as i32
            - source.i16_0[i as usize] as i32
            & 0xFFFF) as i16;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FF9_reg(r1: i32, r2: i32) { instr_660FF9(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FF9_mem(addr: i32, r: i32) {
    instr_660FF9(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFA(source: reg64, r: i32) {
    // psubd mm, mm/m64
    let destination = read_mmx64s(r);
    write_mmx64(
        r,
        destination.u32_0[0].wrapping_sub(source.u32_0[0]) as i32,
        destination.u32_0[1].wrapping_sub(source.u32_0[1]) as i32,
    );
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FFA_reg(r1: i32, r2: i32) { instr_0FFA(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FFA_mem(addr: i32, r: i32) {
    instr_0FFA(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFA(source: reg128, r: i32) {
    // psubd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[0].wrapping_sub(source.u32_0[0]) as i32,
        destination.u32_0[1].wrapping_sub(source.u32_0[1]) as i32,
        destination.u32_0[2].wrapping_sub(source.u32_0[2]) as i32,
        destination.u32_0[3].wrapping_sub(source.u32_0[3]) as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660FFA_reg(r1: i32, r2: i32) { instr_660FFA(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FFA_mem(addr: i32, r: i32) {
    instr_660FFA(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFB(source: reg64, r: i32) {
    // psubq mm, mm/m64
    let mut destination: reg64 = read_mmx64s(r);
    destination.u64_0[0] = destination.u64_0[0].wrapping_sub(source.u64_0[0]);
    write_mmx_reg64(r, destination);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FFB_reg(r1: i32, r2: i32) { instr_0FFB(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FFB_mem(addr: i32, r: i32) {
    instr_0FFB(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFB(source: reg128, r: i32) {
    // psubq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let mut destination: reg128 = read_xmm128s(r);
    destination.u64_0[0] = destination.u64_0[0].wrapping_sub(source.u64_0[0]);
    destination.u64_0[1] = destination.u64_0[1].wrapping_sub(source.u64_0[1]);
    write_xmm_reg128(r, destination);
}
#[no_mangle]
pub unsafe fn instr_660FFB_reg(r1: i32, r2: i32) { instr_660FFB(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FFB_mem(addr: i32, r: i32) {
    instr_660FFB(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFC(source: reg64, r: i32) {
    // paddb mm, mm/m64
    let destination = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.u8_0[i as usize] =
            (destination.u8_0[i as usize] as i32 + source.u8_0[i as usize] as i32 & 255) as u8;
    }
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FFC_reg(r1: i32, r2: i32) { instr_0FFC(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FFC_mem(addr: i32, r: i32) {
    instr_0FFC(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFC(source: reg128, r: i32) {
    // paddb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..16 {
        result.u8_0[i as usize] =
            (destination.u8_0[i as usize] as i32 + source.u8_0[i as usize] as i32 & 255) as u8;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FFC_reg(r1: i32, r2: i32) { instr_660FFC(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FFC_mem(addr: i32, r: i32) {
    instr_660FFC(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFD(source: reg64, r: i32) {
    // paddw mm, mm/m64
    let destination = read_mmx64s(r);
    let word0 = (destination.u32_0[0].wrapping_add(source.u32_0[0]) & 0xFFFF) as i32;
    let word1 = destination.u16_0[1] as i32 + source.u16_0[1] as i32 & 0xFFFF;
    let low = word0 | word1 << 16;
    let word2 = (destination.u32_0[1].wrapping_add(source.u32_0[1]) & 0xFFFF) as i32;
    let word3 = destination.u16_0[3] as i32 + source.u16_0[3] as i32 & 0xFFFF;
    let high = word2 | word3 << 16;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FFD_reg(r1: i32, r2: i32) { instr_0FFD(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FFD_mem(addr: i32, r: i32) {
    instr_0FFD(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFD(source: reg128, r: i32) {
    // paddw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    for i in 0..8 {
        result.u16_0[i as usize] = (destination.u16_0[i as usize] as i32
            + source.u16_0[i as usize] as i32
            & 0xFFFF) as u16;
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FFD_reg(r1: i32, r2: i32) { instr_660FFD(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FFD_mem(addr: i32, r: i32) {
    instr_660FFD(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFE(source: reg64, r: i32) {
    // paddd mm, mm/m64
    let destination = read_mmx64s(r);
    let low = destination.u32_0[0].wrapping_add(source.u32_0[0]) as i32;
    let high = destination.u32_0[1].wrapping_add(source.u32_0[1]) as i32;
    write_mmx64(r, low, high);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0FFE_reg(r1: i32, r2: i32) { instr_0FFE(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FFE_mem(addr: i32, r: i32) {
    instr_0FFE(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFE(source: reg128, r: i32) {
    // paddd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let dword0 = destination.u32_0[0].wrapping_add(source.u32_0[0]) as i32;
    let dword1 = destination.u32_0[1].wrapping_add(source.u32_0[1]) as i32;
    let dword2 = destination.u32_0[2].wrapping_add(source.u32_0[2]) as i32;
    let dword3 = destination.u32_0[3].wrapping_add(source.u32_0[3]) as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660FFE_reg(r1: i32, r2: i32) { instr_660FFE(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660FFE_mem(addr: i32, r: i32) {
    instr_660FFE(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFF() {
    // Windows 98
    dbg_log!("#ud: 0F FF");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_F30F16_reg(r1: i32, r2: i32) { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F30F16_mem(addr: i32, r: i32) { unimplemented_sse(); }

#[no_mangle]
pub unsafe fn instr_0F19_reg(r1: i32, r2: i32) {}
#[no_mangle]
pub unsafe fn instr_0F19_mem(addr: i32, r: i32) {}
#[no_mangle]
pub unsafe fn instr_0F1C_reg(r1: i32, r2: i32) {}
#[no_mangle]
pub unsafe fn instr_0F1C_mem(addr: i32, r: i32) {}
#[no_mangle]
pub unsafe fn instr_0F1D_reg(r1: i32, r2: i32) {}
#[no_mangle]
pub unsafe fn instr_0F1D_mem(addr: i32, r: i32) {}
#[no_mangle]
pub unsafe fn instr_0F1E_reg(r1: i32, r2: i32) {}
#[no_mangle]
pub unsafe fn instr_0F1E_mem(addr: i32, r: i32) {}
#[no_mangle]
pub unsafe fn instr_0F2A(source: reg64, r: i32) {
    // cvtpi2ps xmm, mm/m64
    // Note: Casts here can fail
    let result = reg64 {
        f32_0: [source.i32_0[0] as f32, source.i32_0[1] as f32],
    };
    write_xmm64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F2A_reg(r1: i32, r2: i32) { instr_0F2A(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F2A_mem(addr: i32, r: i32) {
    instr_0F2A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F2A(source: reg64, r: i32) {
    // cvtpi2pd xmm, xmm/m64
    // These casts can't fail
    let result = reg128 {
        f64_0: [source.i32_0[0] as f64, source.i32_0[1] as f64],
    };
    write_xmm_reg128(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_660F2A_reg(r1: i32, r2: i32) { instr_660F2A(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F2A_mem(addr: i32, r: i32) {
    instr_660F2A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F2A(source: i32, r: i32) {
    // cvtsi2sd xmm, r32/m32
    // This cast can't fail
    let result = reg64 {
        f64_0: [source as f64],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F2A_reg(r1: i32, r2: i32) { instr_F20F2A(read_reg32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F2A_mem(addr: i32, r: i32) {
    instr_F20F2A(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F2A(source: i32, r: i32) {
    // cvtsi2ss xmm, r/m32
    // Note: This cast can fail
    let result = source as f32;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F2A_reg(r1: i32, r2: i32) { instr_F30F2A(read_reg32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F2A_mem(addr: i32, r: i32) {
    instr_F30F2A(return_on_pagefault!(safe_read32s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F2D(source: reg64, r: i32) {
    // cvtps2pi mm, xmm/m64
    let result = reg64 {
        i32_0: [
            sse_convert_f32_to_i32(source.f32_0[0].round()),
            sse_convert_f32_to_i32(source.f32_0[1].round()),
        ],
    };
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F2D_reg(r1: i32, r2: i32) { instr_0F2D(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F2D_mem(addr: i32, r: i32) {
    instr_0F2D(return_on_pagefault!(safe_read64s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_660F2D(source: reg128, r: i32) {
    // cvtpd2pi mm, xmm/m128
    let result = reg64 {
        i32_0: [
            sse_convert_f64_to_i32(source.f64_0[0].round()),
            sse_convert_f64_to_i32(source.f64_0[1].round()),
        ],
    };
    write_mmx_reg64(r, result);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_660F2D_reg(r1: i32, r2: i32) { instr_660F2D(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F2D_mem(addr: i32, r: i32) {
    instr_660F2D(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F2D(source: reg64, r: i32) {
    // cvtsd2si r32, xmm/m64
    write_reg32(r, sse_convert_f64_to_i32(source.f64_0[0].round()));
}
#[no_mangle]
pub unsafe fn instr_F20F2D_reg(r1: i32, r2: i32) { instr_F20F2D(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F2D_mem(addr: i32, r: i32) {
    instr_F20F2D(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F2D(source: f32, r: i32) {
    // cvtss2si r32, xmm1/m32
    write_reg32(r, sse_convert_f32_to_i32(source.round()));
}
#[no_mangle]
pub unsafe fn instr_F30F2D_reg(r1: i32, r2: i32) { instr_F30F2D(read_xmm_f32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F2D_mem(addr: i32, r: i32) {
    instr_F30F2D(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}

#[no_mangle]
pub unsafe fn instr_0F51(source: reg128, r: i32) {
    // sqrtps xmm, xmm/mem128
    let result = reg128 {
        f32_0: [
            source.f32_0[0].sqrt(),
            source.f32_0[1].sqrt(),
            source.f32_0[2].sqrt(),
            source.f32_0[3].sqrt(),
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F51_reg(r1: i32, r2: i32) { instr_0F51(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F51_mem(addr: i32, r: i32) {
    instr_0F51(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F51(source: reg128, r: i32) {
    // sqrtpd xmm, xmm/mem128
    let result = reg128 {
        f64_0: [source.f64_0[0].sqrt(), source.f64_0[1].sqrt()],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F51_reg(r1: i32, r2: i32) { instr_660F51(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F51_mem(addr: i32, r: i32) {
    instr_660F51(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F51(source: reg64, r: i32) {
    // sqrtsd xmm, xmm/mem64
    let result = reg64 {
        f64_0: [source.f64_0[0].sqrt()],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F51_reg(r1: i32, r2: i32) { instr_F20F51(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F51_mem(addr: i32, r: i32) {
    instr_F20F51(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F51(source: f32, r: i32) {
    // sqrtss xmm, xmm/mem32
    write_xmm_f32(r, source.sqrt());
}
#[no_mangle]
pub unsafe fn instr_F30F51_reg(r1: i32, r2: i32) { instr_F30F51(read_xmm_f32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F51_mem(addr: i32, r: i32) {
    instr_F30F51(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}

#[no_mangle]
pub unsafe fn instr_0F52(source: reg128, r: i32) {
    // rcpps xmm1, xmm2/m128
    let result = reg128 {
        f32_0: [
            1.0 / source.f32_0[0].sqrt(),
            1.0 / source.f32_0[1].sqrt(),
            1.0 / source.f32_0[2].sqrt(),
            1.0 / source.f32_0[3].sqrt(),
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F52_reg(r1: i32, r2: i32) { instr_0F52(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F52_mem(addr: i32, r: i32) {
    instr_0F52(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F52(source: f32, r: i32) {
    // rsqrtss xmm1, xmm2/m32
    write_xmm_f32(r, 1.0 / source.sqrt());
}
#[no_mangle]
pub unsafe fn instr_F30F52_reg(r1: i32, r2: i32) { instr_F30F52(read_xmm_f32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F52_mem(addr: i32, r: i32) {
    instr_F30F52(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}

#[no_mangle]
pub unsafe fn instr_0F53(source: reg128, r: i32) {
    // rcpps xmm, xmm/m128
    let result = reg128 {
        f32_0: [
            1.0 / source.f32_0[0],
            1.0 / source.f32_0[1],
            1.0 / source.f32_0[2],
            1.0 / source.f32_0[3],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F53_reg(r1: i32, r2: i32) { instr_0F53(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F53_mem(addr: i32, r: i32) {
    instr_0F53(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F53(source: f32, r: i32) {
    // rcpss xmm, xmm/m32
    write_xmm_f32(r, 1.0 / source);
}
#[no_mangle]
pub unsafe fn instr_F30F53_reg(r1: i32, r2: i32) { instr_F30F53(read_xmm_f32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F53_mem(addr: i32, r: i32) {
    instr_F30F53(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}

#[no_mangle]
pub unsafe fn instr_0F58(source: reg128, r: i32) {
    // addps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32_0: [
            source.f32_0[0] + destination.f32_0[0],
            source.f32_0[1] + destination.f32_0[1],
            source.f32_0[2] + destination.f32_0[2],
            source.f32_0[3] + destination.f32_0[3],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F58_reg(r1: i32, r2: i32) { instr_0F58(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F58_mem(addr: i32, r: i32) {
    instr_0F58(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F58(source: reg128, r: i32) {
    // addpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64_0: [
            source.f64_0[0] + destination.f64_0[0],
            source.f64_0[1] + destination.f64_0[1],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F58_reg(r1: i32, r2: i32) { instr_660F58(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F58_mem(addr: i32, r: i32) {
    instr_660F58(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F58(source: reg64, r: i32) {
    // addsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    let result = reg64 {
        f64_0: [source.f64_0[0] + destination.f64_0[0]],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F58_reg(r1: i32, r2: i32) { instr_F20F58(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F58_mem(addr: i32, r: i32) {
    instr_F20F58(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F58(source: f32, r: i32) {
    // addss xmm, xmm/mem32
    let destination = read_xmm_f32(r);
    let result = source + destination;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F58_reg(r1: i32, r2: i32) { instr_F30F58(read_xmm_f32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F58_mem(addr: i32, r: i32) {
    instr_F30F58(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}

#[no_mangle]
pub unsafe fn instr_0F59(source: reg128, r: i32) {
    // mulps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32_0: [
            source.f32_0[0] * destination.f32_0[0],
            source.f32_0[1] * destination.f32_0[1],
            source.f32_0[2] * destination.f32_0[2],
            source.f32_0[3] * destination.f32_0[3],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F59_reg(r1: i32, r2: i32) { instr_0F59(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F59_mem(addr: i32, r: i32) {
    instr_0F59(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F59(source: reg128, r: i32) {
    // mulpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64_0: [
            source.f64_0[0] * destination.f64_0[0],
            source.f64_0[1] * destination.f64_0[1],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F59_reg(r1: i32, r2: i32) { instr_660F59(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F59_mem(addr: i32, r: i32) {
    instr_660F59(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F59(source: reg64, r: i32) {
    // mulsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    let result = reg64 {
        f64_0: [source.f64_0[0] * destination.f64_0[0]],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F59_reg(r1: i32, r2: i32) { instr_F20F59(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F59_mem(addr: i32, r: i32) {
    instr_F20F59(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F59(source: f32, r: i32) {
    // mulss xmm, xmm/mem32
    let destination = read_xmm_f32(r);
    let result = source * destination;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F59_reg(r1: i32, r2: i32) { instr_F30F59(read_xmm_f32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F59_mem(addr: i32, r: i32) {
    instr_F30F59(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}

#[no_mangle]
pub unsafe fn instr_0F5A(source: reg64, r: i32) {
    // cvtps2pd xmm1, xmm2/m64
    let result = reg128 {
        f64_0: [source.f32_0[0] as f64, source.f32_0[1] as f64],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F5A_reg(r1: i32, r2: i32) { instr_0F5A(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F5A_mem(addr: i32, r: i32) {
    instr_0F5A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5A(source: reg128, r: i32) {
    // cvtpd2ps xmm1, xmm2/m128
    let result = reg128 {
        // XXX: These conversions are lossy and should round according to the round control
        f32_0: [source.f64_0[0] as f32, source.f64_0[1] as f32, 0., 0.],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F5A_reg(r1: i32, r2: i32) { instr_660F5A(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F5A_mem(addr: i32, r: i32) {
    instr_660F5A(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5A(source: reg64, r: i32) {
    // cvtsd2ss xmm1, xmm2/m64
    // XXX: This conversions is lossy and should round according to the round control
    write_xmm_f32(r, source.f64_0[0] as f32);
}
#[no_mangle]
pub unsafe fn instr_F20F5A_reg(r1: i32, r2: i32) { instr_F20F5A(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F5A_mem(addr: i32, r: i32) {
    instr_F20F5A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5A(source: f32, r: i32) {
    // cvtss2sd xmm1, xmm2/m32
    let result = reg64 {
        f64_0: [source as f64],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F5A_reg(r1: i32, r2: i32) { instr_F30F5A(read_xmm_f32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F5A_mem(addr: i32, r: i32) {
    instr_F30F5A(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}

#[no_mangle]
pub unsafe fn instr_0F5B(source: reg128, r: i32) {
    // cvtdq2ps xmm1, xmm2/m128
    let result = reg128 {
        f32_0: [
            // XXX: Precision exception
            source.i32_0[0] as f32,
            source.i32_0[1] as f32,
            source.i32_0[2] as f32,
            source.i32_0[3] as f32,
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F5B_reg(r1: i32, r2: i32) { instr_0F5B(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F5B_mem(addr: i32, r: i32) {
    instr_0F5B(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5B(source: reg128, r: i32) {
    // cvtps2dq xmm1, xmm2/m128
    let result = reg128 {
        i32_0: [
            // XXX: Precision exception
            sse_convert_f32_to_i32(source.f32_0[0].round()),
            sse_convert_f32_to_i32(source.f32_0[1].round()),
            sse_convert_f32_to_i32(source.f32_0[2].round()),
            sse_convert_f32_to_i32(source.f32_0[3].round()),
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F5B_reg(r1: i32, r2: i32) { instr_660F5B(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F5B_mem(addr: i32, r: i32) {
    instr_660F5B(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5B(source: reg128, r: i32) {
    // cvttps2dq xmm1, xmm2/m128
    let result = reg128 {
        i32_0: [
            sse_convert_f32_to_i32(source.f32_0[0].trunc()),
            sse_convert_f32_to_i32(source.f32_0[1].trunc()),
            sse_convert_f32_to_i32(source.f32_0[2].trunc()),
            sse_convert_f32_to_i32(source.f32_0[3].trunc()),
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F5B_reg(r1: i32, r2: i32) { instr_F30F5B(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F5B_mem(addr: i32, r: i32) {
    instr_F30F5B(return_on_pagefault!(safe_read128s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F5C(source: reg128, r: i32) {
    // subps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32_0: [
            destination.f32_0[0] - source.f32_0[0],
            destination.f32_0[1] - source.f32_0[1],
            destination.f32_0[2] - source.f32_0[2],
            destination.f32_0[3] - source.f32_0[3],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F5C_reg(r1: i32, r2: i32) { instr_0F5C(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F5C_mem(addr: i32, r: i32) {
    instr_0F5C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5C(source: reg128, r: i32) {
    // subpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64_0: [
            destination.f64_0[0] - source.f64_0[0],
            destination.f64_0[1] - source.f64_0[1],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F5C_reg(r1: i32, r2: i32) { instr_660F5C(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F5C_mem(addr: i32, r: i32) {
    instr_660F5C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5C(source: reg64, r: i32) {
    // subsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    let result = reg64 {
        f64_0: [destination.f64_0[0] - source.f64_0[0]],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F5C_reg(r1: i32, r2: i32) { instr_F20F5C(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F5C_mem(addr: i32, r: i32) {
    instr_F20F5C(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5C(source: f32, r: i32) {
    // subss xmm, xmm/mem32
    let destination = read_xmm_f32(r);
    let result = destination - source;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F5C_reg(r1: i32, r2: i32) { instr_F30F5C(read_xmm_f32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F5C_mem(addr: i32, r: i32) {
    instr_F30F5C(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0F5D(source: reg128, r: i32) {
    // minps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32_0: [
            sse_min(destination.f32_0[0] as f64, source.f32_0[0] as f64) as f32,
            sse_min(destination.f32_0[1] as f64, source.f32_0[1] as f64) as f32,
            sse_min(destination.f32_0[2] as f64, source.f32_0[2] as f64) as f32,
            sse_min(destination.f32_0[3] as f64, source.f32_0[3] as f64) as f32,
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F5D_reg(r1: i32, r2: i32) { instr_0F5D(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F5D_mem(addr: i32, r: i32) {
    instr_0F5D(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5D(source: reg128, r: i32) {
    // minpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64_0: [
            sse_min(destination.f64_0[0], source.f64_0[0]),
            sse_min(destination.f64_0[1], source.f64_0[1]),
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F5D_reg(r1: i32, r2: i32) { instr_660F5D(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F5D_mem(addr: i32, r: i32) {
    instr_660F5D(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5D(source: reg64, r: i32) {
    // minsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    let result = reg64 {
        f64_0: [sse_min(destination.f64_0[0], source.f64_0[0])],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F5D_reg(r1: i32, r2: i32) { instr_F20F5D(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F5D_mem(addr: i32, r: i32) {
    instr_F20F5D(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5D(source: f32, r: i32) {
    // minss xmm, xmm/mem32
    let destination = read_xmm_f32(r);
    let result = sse_min(destination as f64, source as f64) as f32;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F5D_reg(r1: i32, r2: i32) { instr_F30F5D(read_xmm_f32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F5D_mem(addr: i32, r: i32) {
    instr_F30F5D(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0F5E(source: reg128, r: i32) {
    // divps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32_0: [
            destination.f32_0[0] / source.f32_0[0],
            destination.f32_0[1] / source.f32_0[1],
            destination.f32_0[2] / source.f32_0[2],
            destination.f32_0[3] / source.f32_0[3],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F5E_reg(r1: i32, r2: i32) { instr_0F5E(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F5E_mem(addr: i32, r: i32) {
    instr_0F5E(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5E(source: reg128, r: i32) {
    // divpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64_0: [
            destination.f64_0[0] / source.f64_0[0],
            destination.f64_0[1] / source.f64_0[1],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F5E_reg(r1: i32, r2: i32) { instr_660F5E(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F5E_mem(addr: i32, r: i32) {
    instr_660F5E(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5E(source: reg64, r: i32) {
    // divsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    let result = reg64 {
        f64_0: [destination.f64_0[0] / source.f64_0[0]],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F5E_reg(r1: i32, r2: i32) { instr_F20F5E(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F5E_mem(addr: i32, r: i32) {
    instr_F20F5E(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5E(source: f32, r: i32) {
    // divss xmm, xmm/mem32
    let destination = read_xmm_f32(r);
    let result = destination / source;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F5E_reg(r1: i32, r2: i32) { instr_F30F5E(read_xmm_f32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F5E_mem(addr: i32, r: i32) {
    instr_F30F5E(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0F5F(source: reg128, r: i32) {
    // maxps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32_0: [
            sse_max(destination.f32_0[0] as f64, source.f32_0[0] as f64) as f32,
            sse_max(destination.f32_0[1] as f64, source.f32_0[1] as f64) as f32,
            sse_max(destination.f32_0[2] as f64, source.f32_0[2] as f64) as f32,
            sse_max(destination.f32_0[3] as f64, source.f32_0[3] as f64) as f32,
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F5F_reg(r1: i32, r2: i32) { instr_0F5F(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F5F_mem(addr: i32, r: i32) {
    instr_0F5F(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5F(source: reg128, r: i32) {
    // maxpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64_0: [
            sse_max(destination.f64_0[0], source.f64_0[0]),
            sse_max(destination.f64_0[1], source.f64_0[1]),
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F5F_reg(r1: i32, r2: i32) { instr_660F5F(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F5F_mem(addr: i32, r: i32) {
    instr_660F5F(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5F(source: reg64, r: i32) {
    // maxsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    let result = reg64 {
        f64_0: [sse_max(destination.f64_0[0], source.f64_0[0])],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F5F_reg(r1: i32, r2: i32) { instr_F20F5F(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F5F_mem(addr: i32, r: i32) {
    instr_F20F5F(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5F(source: f32, r: i32) {
    // maxss xmm, xmm/mem32
    let destination = read_xmm_f32(r);
    let result = sse_max(destination as f64, source as f64) as f32;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F5F_reg(r1: i32, r2: i32) { instr_F30F5F(read_xmm_f32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F5F_mem(addr: i32, r: i32) {
    instr_F30F5F(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0FC2(source: reg128, r: i32, imm8: i32) {
    // cmpps xmm, xmm/m128
    let destination = read_xmm128s(r);
    let result = reg128 {
        i32_0: [
            if sse_comparison(imm8, destination.f32_0[0] as f64, source.f32_0[0] as f64) {
                -1
            }
            else {
                0
            },
            if sse_comparison(imm8, destination.f32_0[1] as f64, source.f32_0[1] as f64) {
                -1
            }
            else {
                0
            },
            if sse_comparison(imm8, destination.f32_0[2] as f64, source.f32_0[2] as f64) {
                -1
            }
            else {
                0
            },
            if sse_comparison(imm8, destination.f32_0[3] as f64, source.f32_0[3] as f64) {
                -1
            }
            else {
                0
            },
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FC2_reg(r1: i32, r2: i32, imm: i32) { instr_0FC2(read_xmm128s(r1), r2, imm); }
#[no_mangle]
pub unsafe fn instr_0FC2_mem(addr: i32, r: i32, imm: i32) {
    instr_0FC2(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_660FC2(source: reg128, r: i32, imm8: i32) {
    // cmppd xmm, xmm/m128
    let destination = read_xmm128s(r);
    let result = reg128 {
        i64_0: [
            (if sse_comparison(imm8, destination.f64_0[0], source.f64_0[0]) {
                -1
            }
            else {
                0
            }) as i64,
            (if sse_comparison(imm8, destination.f64_0[1], source.f64_0[1]) {
                -1
            }
            else {
                0
            }) as i64,
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FC2_reg(r1: i32, r2: i32, imm: i32) {
    instr_660FC2(read_xmm128s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_660FC2_mem(addr: i32, r: i32, imm: i32) {
    instr_660FC2(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_F20FC2(source: reg64, r: i32, imm8: i32) {
    // cmpsd xmm, xmm/m64
    let destination = read_xmm64s(r);
    let result = reg64 {
        i64_0: [
            (if sse_comparison(imm8, destination.f64_0[0], source.f64_0[0]) {
                -1
            }
            else {
                0
            }) as i64,
        ],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20FC2_reg(r1: i32, r2: i32, imm: i32) {
    instr_F20FC2(read_xmm64s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_F20FC2_mem(addr: i32, r: i32, imm: i32) {
    instr_F20FC2(return_on_pagefault!(safe_read64s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_F30FC2(source: f32, r: i32, imm8: i32) {
    // cmpss xmm, xmm/m32
    let destination = read_xmm_f32(r);
    let result = if sse_comparison(imm8, destination as f64, source as f64) {
        -1
    }
    else {
        0
    };
    write_xmm32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30FC2_reg(r1: i32, r2: i32, imm: i32) {
    instr_F30FC2(read_xmm_f32(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_F30FC2_mem(addr: i32, r: i32, imm: i32) {
    instr_F30FC2(return_on_pagefault!(fpu_load_m32(addr)) as f32, r, imm);
}
