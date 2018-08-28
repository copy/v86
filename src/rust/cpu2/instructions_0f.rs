#![allow(
    dead_code,
    mutable_transmutes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_mut
)]

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
    fn switch_seg(seg: i32, value: i32) -> bool;
    #[no_mangle]
    fn get_rand_int() -> i32;
    #[no_mangle]
    fn has_rand_int() -> bool;
    #[no_mangle]
    fn cpuid();
    #[no_mangle]
    fn cpl_changed();
    #[no_mangle]
    fn update_cs_size(cs_size: bool);
    #[no_mangle]
    fn set_cr0(cr0: i32);
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
    bts_reg, popcnt, shld16, shld32, shrd16, shrd32, xadd16, xadd32, xadd8,
};
use cpu2::arith::{
    cmp16, cmp32, cmp8, imul_reg16, imul_reg32, saturate_sd_to_sb, saturate_sd_to_sw,
    saturate_sd_to_ub, saturate_sw_to_sb, saturate_sw_to_ub, saturate_ud_to_ub, saturate_uw,
};
use cpu2::cpu::*;
use cpu2::fpu::fpu_load_m32;
use cpu2::fpu::fpu_set_tag_word;
use cpu2::global_pointers::*;
use cpu2::misc_instr::{
    adjust_stack_reg, bswap, cmovcc16, cmovcc32, fxrstor, fxsave, get_stack_pointer, getzf,
    jmpcc16, jmpcc32, push16, push32, setcc_mem, setcc_reg, test_b, test_be, test_l, test_le,
    test_o, test_p, test_s, test_z,
};
use cpu2::sse_instr::*;

pub static mut apic_enabled: bool = false;
const ENABLE_ACPI: bool = false;

pub fn convert_f64_to_i32(x: f64) -> i32 { x as i32 }

#[no_mangle]
pub unsafe fn instr_0F00_0_mem(mut addr: i32) -> () {
    c_comment!(("sldt"));
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else {
        return_on_pagefault!(safe_write16(addr, *sreg.offset(LDTR as isize) as i32));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_0_reg(mut r: i32) -> () {
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else {
        write_reg_osize(r, *sreg.offset(LDTR as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_1_mem(mut addr: i32) -> () {
    c_comment!(("str"));
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else {
        return_on_pagefault!(safe_write16(addr, *sreg.offset(TR as isize) as i32));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_1_reg(mut r: i32) -> () {
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else {
        write_reg_osize(r, *sreg.offset(TR as isize) as i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_2_mem(mut addr: i32) -> () {
    c_comment!(("lldt"));
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        load_ldt(return_on_pagefault!(safe_read16(addr)));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_2_reg(mut r: i32) -> () {
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        load_ldt(read_reg16(r));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_3_mem(mut addr: i32) -> () {
    c_comment!(("ltr"));
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        load_tr(return_on_pagefault!(safe_read16(addr)));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_3_reg(mut r: i32) -> () {
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        load_tr(read_reg16(r));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_4_mem(mut addr: i32) -> () {
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else {
        verr(return_on_pagefault!(safe_read16(addr)));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_4_reg(mut r: i32) -> () {
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else {
        verr(read_reg16(r));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_5_mem(mut addr: i32) -> () {
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else {
        verw(return_on_pagefault!(safe_read16(addr)));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F00_5_reg(mut r: i32) -> () {
    if !*protected_mode.offset(0isize) || 0 != vm86_mode() as i32 {
        trigger_ud();
        return;
    }
    else {
        verw(read_reg16(r));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F01_0_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F01_0_mem(mut addr: i32) -> () {
    c_comment!(("sgdt"));
    return_on_pagefault!(writable_or_pagefault(addr, 6i32));
    let mut mask: i32 = if 0 != is_osize_32() as i32 {
        -1i32
    }
    else {
        16777215i32
    };
    safe_write16(addr, *gdtr_size.offset(0isize)).unwrap();
    safe_write32(addr + 2i32, *gdtr_offset.offset(0isize) & mask).unwrap();
}
#[no_mangle]
pub unsafe fn instr_0F01_1_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F01_1_mem(mut addr: i32) -> () {
    c_comment!(("sidt"));
    return_on_pagefault!(writable_or_pagefault(addr, 6i32));
    let mut mask: i32 = if 0 != is_osize_32() as i32 {
        -1i32
    }
    else {
        16777215i32
    };
    safe_write16(addr, *idtr_size.offset(0isize)).unwrap();
    safe_write32(addr + 2i32, *idtr_offset.offset(0isize) & mask).unwrap();
}
#[no_mangle]
pub unsafe fn instr_0F01_2_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F01_2_mem(mut addr: i32) -> () {
    c_comment!(("lgdt"));
    if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        let mut size: i32 = return_on_pagefault!(safe_read16(addr));
        let mut offset: i32 = return_on_pagefault!(safe_read32s(addr + 2i32));
        let mut mask: i32 = if 0 != is_osize_32() as i32 {
            -1i32
        }
        else {
            16777215i32
        };
        *gdtr_size.offset(0isize) = size;
        *gdtr_offset.offset(0isize) = offset & mask;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F01_3_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F01_3_mem(mut addr: i32) -> () {
    c_comment!(("lidt"));
    if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        let mut size: i32 = return_on_pagefault!(safe_read16(addr));
        let mut offset: i32 = return_on_pagefault!(safe_read32s(addr + 2i32));
        let mut mask: i32 = if 0 != is_osize_32() as i32 {
            -1i32
        }
        else {
            16777215i32
        };
        *idtr_size.offset(0isize) = size;
        *idtr_offset.offset(0isize) = offset & mask;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F01_4_reg(mut r: i32) -> () {
    c_comment!(("smsw"));
    write_reg_osize(r, *cr.offset(0isize));
}
#[no_mangle]
pub unsafe fn instr_0F01_4_mem(mut addr: i32) -> () {
    return_on_pagefault!(safe_write16(addr, *cr.offset(0isize) & 65535i32));
}
#[no_mangle]
pub unsafe fn lmsw(mut new_cr0: i32) -> () {
    new_cr0 = *cr.offset(0isize) & !15i32 | new_cr0 & 15i32;
    if *protected_mode.offset(0isize) {
        c_comment!(("lmsw cannot be used to switch back"));
        new_cr0 |= CR0_PE
    }
    set_cr0(new_cr0);
}
#[no_mangle]
pub unsafe fn instr_0F01_6_reg(mut r: i32) -> () {
    if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        lmsw(read_reg16(r));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F01_6_mem(mut addr: i32) -> () {
    if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        lmsw(return_on_pagefault!(safe_read16(addr)));
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F01_7_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F01_7_mem(mut addr: i32) -> () {
    c_comment!(("invlpg"));
    if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        invlpg(addr);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr16_0F02_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, lar(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_0F02_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, lar(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_0F02_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg32(r, lar(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_0F02_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg32(r, lar(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr16_0F03_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, lsl(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr16_0F03_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, lsl(____0, read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_0F03_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg32(r, lsl(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr32_0F03_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg32(r, lsl(____0, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_0F04() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F05() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F06() -> () {
    c_comment!(("clts"));
    if 0 != *cpl.offset(0isize) {
        dbg_log_c!("clts #gp");
        trigger_gp_non_raising(0i32);
    }
    else {
        if 0 != 0i32 * 0i32 {
            dbg_log_c!("clts");
        }
        let ref mut fresh0 = *cr.offset(0isize);
        *fresh0 &= !CR0_TS
    };
}
#[no_mangle]
pub unsafe fn instr_0F07() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F08() -> () {
    c_comment!(("invd"));
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0F09() -> () {
    if 0 != *cpl.offset(0isize) {
        dbg_log_c!("wbinvd #gp");
        trigger_gp_non_raising(0i32);
    }
    else {
        c_comment!(("wbinvd"));
    };
}
#[no_mangle]
pub unsafe fn instr_0F0A() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F0B() -> () {
    c_comment!(("UD2"));
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_0F0C() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F0D() -> () {
    c_comment!(("nop"));
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0F0E() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F0F() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F10(mut source: reg128, mut r: i32) -> () {
    c_comment!(("movups xmm, xmm/m128"));
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F10_reg(mut r1: i32, mut r2: i32) -> () { instr_0F10(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F10_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F10(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F10_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movss xmm, xmm/m32"));
    let mut data: reg128 = read_xmm128s(r1);
    let mut orig: reg128 = read_xmm128s(r2);
    write_xmm128(
        r2,
        data.u32_0[0usize] as i32,
        orig.u32_0[1usize] as i32,
        orig.u32_0[2usize] as i32,
        orig.u32_0[3usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F30F10_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movss xmm, xmm/m32"));
    let mut data: i32 = return_on_pagefault!(safe_read32s(addr));
    write_xmm128(r, data, 0i32, 0i32, 0i32);
}
#[no_mangle]
pub unsafe fn instr_660F10(mut source: reg128, mut r: i32) -> () {
    c_comment!(("movupd xmm, xmm/m128"));
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F10_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F10(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F10_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F10(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F10_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movsd xmm, xmm/m64"));
    let mut data: reg128 = read_xmm128s(r1);
    let mut orig: reg128 = read_xmm128s(r2);
    write_xmm128(
        r2,
        data.u32_0[0usize] as i32,
        data.u32_0[1usize] as i32,
        orig.u32_0[2usize] as i32,
        orig.u32_0[3usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F20F10_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movsd xmm, xmm/m64"));
    let mut data: reg64 = return_on_pagefault!(safe_read64s(addr));
    write_xmm128(
        r,
        data.u32_0[0usize] as i32,
        data.u32_0[1usize] as i32,
        0i32,
        0i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0F11_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movups xmm/m128, xmm"));
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr_0F11_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movups xmm/m128, xmm"));
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_F30F11_reg(mut rm_dest: i32, mut reg_src: i32) -> () {
    c_comment!(("movss xmm/m32, xmm"));
    let mut data: reg128 = read_xmm128s(reg_src);
    let mut orig: reg128 = read_xmm128s(rm_dest);
    write_xmm128(
        rm_dest,
        data.u32_0[0usize] as i32,
        orig.u32_0[1usize] as i32,
        orig.u32_0[2usize] as i32,
        orig.u32_0[3usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F30F11_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movss xmm/m32, xmm"));
    let mut data: reg128 = read_xmm128s(r);
    return_on_pagefault!(safe_write32(addr, data.u32_0[0usize] as i32));
}
#[no_mangle]
pub unsafe fn instr_660F11_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movupd xmm/m128, xmm"));
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr_660F11_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movupd xmm/m128, xmm"));
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_F20F11_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movsd xmm/m64, xmm"));
    let mut data: reg128 = read_xmm128s(r2);
    let mut orig: reg128 = read_xmm128s(r1);
    write_xmm128(
        r1,
        data.u32_0[0usize] as i32,
        data.u32_0[1usize] as i32,
        orig.u32_0[2usize] as i32,
        orig.u32_0[3usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F20F11_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movsd xmm/m64, xmm"));
    let mut data: reg64 = read_xmm64s(r);
    return_on_pagefault!(safe_write64(addr, data.u64_0[0usize] as i64));
}
#[no_mangle]
pub unsafe fn instr_0F12_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movlps xmm, m64"));
    let mut data: reg64 = return_on_pagefault!(safe_read64s(addr));
    let mut orig: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        data.u32_0[0usize] as i32,
        data.u32_0[1usize] as i32,
        orig.u32_0[2usize] as i32,
        orig.u32_0[3usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0F12_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movhlps xmm, xmm"));
    let mut data: reg128 = read_xmm128s(r1);
    let mut orig: reg128 = read_xmm128s(r2);
    write_xmm128(
        r2,
        data.u32_0[2usize] as i32,
        data.u32_0[3usize] as i32,
        orig.u32_0[2usize] as i32,
        orig.u32_0[3usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F12_reg(mut r1: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F12_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movlpd xmm, m64"));
    let mut data: reg64 = return_on_pagefault!(safe_read64s(addr));
    write_xmm64(r, data);
}
#[no_mangle]
pub unsafe fn instr_F20F12_mem(mut addr: i32, mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F20F12_reg(mut r1: i32, mut r2: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F30F12_mem(mut addr: i32, mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F30F12_reg(mut r1: i32, mut r2: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F13_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movlps m64, xmm"));
    movl_r128_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F13_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F13_reg(mut r1: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F13_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movlpd xmm/m64, xmm"));
    movl_r128_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F14(mut source: reg64, mut r: i32) -> () {
    c_comment!(("unpcklps xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg64 = read_xmm64s(r);
    write_xmm128(
        r,
        destination.u32_0[0usize] as i32,
        source.u32_0[0usize] as i32,
        destination.u32_0[1usize] as i32,
        source.u32_0[1usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0F14_reg(mut r1: i32, mut r2: i32) -> () { instr_0F14(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F14_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F14(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F14(mut source: reg64, mut r: i32) -> () {
    c_comment!(("unpcklpd xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg64 = read_xmm64s(r);
    write_xmm128(
        r,
        destination.u32_0[0usize] as i32,
        destination.u32_0[1usize] as i32,
        source.u32_0[0usize] as i32,
        source.u32_0[1usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F14_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F14(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F14_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F14(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F15(mut source: reg128, mut r: i32) -> () {
    c_comment!(("unpckhps xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[2usize] as i32,
        source.u32_0[2usize] as i32,
        destination.u32_0[3usize] as i32,
        source.u32_0[3usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0F15_reg(mut r1: i32, mut r2: i32) -> () { instr_0F15(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F15_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F15(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F15(mut source: reg128, mut r: i32) -> () {
    c_comment!(("unpckhpd xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[2usize] as i32,
        destination.u32_0[3usize] as i32,
        source.u32_0[2usize] as i32,
        source.u32_0[3usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F15_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F15(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F15_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F15(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F16_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movhps xmm, m64"));
    movh_m64_r128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F16_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movlhps xmm, xmm"));
    let mut data: reg128 = read_xmm128s(r1);
    let mut orig: reg128 = read_xmm128s(r2);
    write_xmm128(
        r2,
        orig.u32_0[0usize] as i32,
        orig.u32_0[1usize] as i32,
        data.u32_0[0usize] as i32,
        data.u32_0[1usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F16_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movhpd xmm, m64"));
    movh_m64_r128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_660F16_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F17_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movhps m64, xmm"));
    movh_r128_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F17_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F17_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movhpd m64, xmm"));
    movh_r128_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_660F17_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F18_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("reserved nop"));
}
#[no_mangle]
pub unsafe fn instr_0F18_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("prefetch"));
    c_comment!(("nop for us"));
}
#[no_mangle]
pub unsafe fn instr_0F1A() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F1B() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F1F_reg(mut r1: i32, mut r2: i32) -> () {}
#[no_mangle]
pub unsafe fn instr_0F1F_mem(mut addr: i32, mut r: i32) -> () {}
#[no_mangle]
pub unsafe fn instr_0F20(mut r: i32, mut creg: i32) -> () {
    if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        match creg {
            0 => {
                write_reg32(r, *cr.offset(0isize));
            },
            2 => {
                write_reg32(r, *cr.offset(2isize));
            },
            3 => {
                write_reg32(r, *cr.offset(3isize));
            },
            4 => {
                write_reg32(r, *cr.offset(4isize));
            },
            _ => {
                dbg_log_c!("%d", creg);
                undefined_instruction();
            },
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F21(mut r: i32, mut dreg_index: i32) -> () {
    if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        if dreg_index == 4i32 || dreg_index == 5i32 {
            if 0 != *cr.offset(4isize) & CR4_DE {
                dbg_log_c!("#ud mov dreg 4/5 with cr4.DE set");
                trigger_ud();
                return;
            }
            else {
                c_comment!(("DR4 and DR5 refer to DR6 and DR7 respectively"));
                dreg_index += 2i32
            }
        }
        write_reg32(r, *dreg.offset(dreg_index as isize));
        if 0 != 0i32 * 0i32 {
            dbg_log_c!(
                "read dr%d: %x",
                dreg_index,
                *dreg.offset(dreg_index as isize)
            );
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F22(mut r: i32, mut creg: i32) -> () {
    if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        let mut data: i32 = read_reg32(r);
        c_comment!(("mov cr, addr"));
        match creg {
            0 => {
                if 0 != 0i32 * 0i32 {
                    dbg_log_c!("cr0 <- %x", data);
                }
                set_cr0(data);
            },
            2 => {
                dbg_log_c!("cr2 <- %x", data);
                *cr.offset(2isize) = data
            },
            3 => {
                if 0 != 0i32 * 0i32 {
                    dbg_log_c!("cr3 <- %x", data);
                }
                data &= !4071i32;
                dbg_assert!(data & 4095i32 == 0i32, ("TODO"));
                *cr.offset(3isize) = data;
                clear_tlb();
            },
            4 => {
                dbg_log_c!("cr4 <- %d", *cr.offset(4isize));
                if 0 != data as u32
                    & ((1i32 << 11i32
                        | 1i32 << 12i32
                        | 1i32 << 15i32
                        | 1i32 << 16i32
                        | 1i32 << 19i32) as u32
                        | 4290772992u32)
                {
                    dbg_log_c!("trigger_gp: Invalid cr4 bit");
                    trigger_gp_non_raising(0i32);
                    return;
                }
                else {
                    if 0 != (*cr.offset(4isize) ^ data) & (CR4_PGE | CR4_PSE) {
                        full_clear_tlb();
                    }
                    *cr.offset(4isize) = data;
                    if 0 != *cr.offset(4isize) & CR4_PAE {
                        dbg_assert!(0 != 0i32);
                    }
                }
            },
            _ => {
                dbg_log_c!("%d", creg);
                undefined_instruction();
            },
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F23(mut r: i32, mut dreg_index: i32) -> () {
    if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        if dreg_index == 4i32 || dreg_index == 5i32 {
            if 0 != *cr.offset(4isize) & CR4_DE {
                dbg_log_c!("#ud mov dreg 4/5 with cr4.DE set");
                trigger_ud();
                return;
            }
            else {
                c_comment!(("DR4 and DR5 refer to DR6 and DR7 respectively"));
                dreg_index += 2i32
            }
        }
        *dreg.offset(dreg_index as isize) = read_reg32(r);
        if 0 != 0i32 * 0i32 {
            dbg_log_c!(
                "write dr%d: %x",
                dreg_index,
                *dreg.offset(dreg_index as isize)
            );
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F24() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F25() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F26() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F27() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F28(mut source: reg128, mut r: i32) -> () {
    c_comment!(("movaps xmm, xmm/m128"));
    c_comment!(("XXX: Aligned read or #gp"));
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F28_reg(mut r1: i32, mut r2: i32) -> () { instr_0F28(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F28_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F28(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F28(mut source: reg128, mut r: i32) -> () {
    c_comment!(("movapd xmm, xmm/m128"));
    c_comment!(("XXX: Aligned read or #gp"));
    c_comment!(("Note: Same as movdqa (660F6F)"));
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F28_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F28(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F28_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F28(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F29_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movaps m128, xmm"));
    let mut data: reg128 = read_xmm128s(r);
    c_comment!(("XXX: Aligned write or #gp"));
    return_on_pagefault!(safe_write128(addr, data));
}
#[no_mangle]
pub unsafe fn instr_0F29_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movaps xmm, xmm"));
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr_660F29_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movapd m128, xmm"));
    let mut data: reg128 = read_xmm128s(r);
    c_comment!(("XXX: Aligned write or #gp"));
    return_on_pagefault!(safe_write128(addr, data));
}
#[no_mangle]
pub unsafe fn instr_660F29_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movapd xmm, xmm"));
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr_0F2B_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F2B_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movntps m128, xmm"));
    c_comment!(("XXX: Aligned write or #gp"));
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_660F2B_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F2B_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movntpd m128, xmm"));
    c_comment!(("XXX: Aligned write or #gp"));
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F2C_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F2C(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F2C(mut source: reg64, mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F2C_reg(mut r1: i32, mut r2: i32) -> () { instr_0F2C(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F2C_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F2C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F2C(mut source: reg128, mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_660F2C_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F2C(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F20F2C(mut source: reg64, mut r: i32) -> () {
    let mut si: i32 = 0;
    c_comment!(("cvttsd2si r32, xmm/m64"));
    c_comment!(
        ("emscripten bug causes this ported instruction to throw \'integer result unpresentable\'")
    );
    c_comment!(("https://github.com/kripken/emscripten/issues/5433"));
    if 0 != 0i32 * 0i32 {
        let mut f: f64 = source.f64_0[0usize];
        if f <= 2147483647i32 as f64 && f >= 2147483648u32.wrapping_neg() as f64 {
            si = f as i32;
            write_reg32(r, si);
        }
        else {
            write_reg32(r, 2147483648u32 as i32);
        }
    }
    else {
        write_reg32(r, convert_f64_to_i32(source.f64_0[0usize]));
    };
}
#[no_mangle]
pub unsafe fn instr_F20F2C_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F20F2C(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F20F2C_mem(mut addr: i32, mut r: i32) -> () {
    instr_F20F2C(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F2C_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F2C(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_F30F2C(mut source: f32, mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F30F2C_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F2C(read_xmm_f32(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_0F2E() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F2F() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F30() -> () {
    c_comment!(("wrmsr - write maschine specific register"));
    if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        let mut index: i32 = *reg32s.offset(ECX as isize);
        let mut low: i32 = *reg32s.offset(EAX as isize);
        let mut high: i32 = *reg32s.offset(EDX as isize);
        if index != IA32_SYSENTER_ESP {
            dbg_log_c!("wrmsr ecx=%x data=%x:%x", index, high, low);
        }
        if index == IA32_SYSENTER_CS {
            *sysenter_cs.offset(0isize) = low & 65535i32
        }
        else if index == IA32_SYSENTER_EIP {
            *sysenter_eip.offset(0isize) = low
        }
        else if index == IA32_SYSENTER_ESP {
            *sysenter_esp.offset(0isize) = low
        }
        else if index == IA32_APIC_BASE_MSR {
            dbg_assert!(
                high == 0i32,
                ("Changing APIC address (high 32 bits) not supported")
            );
            let mut address: i32 =
                low & !(IA32_APIC_BASE_BSP | IA32_APIC_BASE_EXTD | IA32_APIC_BASE_EN);
            dbg_assert!(
                address == APIC_ADDRESS,
                ("Changing APIC address not supported")
            );
            dbg_assert!(low & IA32_APIC_BASE_EXTD == 0i32, ("x2apic not supported"));
            apic_enabled = low & IA32_APIC_BASE_EN == IA32_APIC_BASE_EN
        }
        else if index == IA32_TIME_STAMP_COUNTER {
            set_tsc(low as u32, high as u32);
        }
        else if !(index == IA32_BIOS_SIGN_ID) {
            if index == MSR_MISC_FEATURE_ENABLES {
                c_comment!(("Linux 4, see: https://patchwork.kernel.org/patch/9528279/"));
            }
            else if index == IA32_MISC_ENABLE {
                c_comment!(("Enable Misc. Processor Features"));
            }
            else if index == IA32_MCG_CAP {
                c_comment!(("netbsd"));
            }
            else if index == IA32_KERNEL_GS_BASE {
                c_comment!(("Only used in 64 bit mode (by SWAPGS), but set by kvm-unit-test"));
                dbg_log_c!("GS Base written");
            }
            else {
                dbg_log_c!("Unknown msr: %x", index);
                dbg_assert!(0 != 0i32);
            }
        }
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F31() -> () {
    c_comment!(("rdtsc - read timestamp counter"));
    if 0 == *cpl.offset(0isize) || 0 == *cr.offset(4isize) & CR4_TSD {
        let mut tsc: u64 = read_tsc();
        *reg32s.offset(EAX as isize) = tsc as i32;
        *reg32s.offset(EDX as isize) = (tsc >> 32i32) as i32;
        if 0 != 0i32 * 0i32 {
            dbg_log_c!(
                "rdtsc  edx:eax=%x:%x",
                *reg32s.offset(EDX as isize),
                *reg32s.offset(EAX as isize)
            );
        }
    }
    else {
        trigger_gp_non_raising(0i32);
    };
}
#[no_mangle]
pub unsafe fn instr_0F32() -> () {
    c_comment!(("rdmsr - read maschine specific register"));
    if 0 != *cpl.offset(0isize) {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        let mut index: i32 = *reg32s.offset(ECX as isize);
        dbg_log_c!("rdmsr ecx=%x", index);
        let mut low: i32 = 0i32;
        let mut high: i32 = 0i32;
        if index == IA32_SYSENTER_CS {
            low = *sysenter_cs.offset(0isize)
        }
        else if index == IA32_SYSENTER_EIP {
            low = *sysenter_eip.offset(0isize)
        }
        else if index == IA32_SYSENTER_ESP {
            low = *sysenter_esp.offset(0isize)
        }
        else if index == IA32_TIME_STAMP_COUNTER {
            let mut tsc: u64 = read_tsc();
            low = tsc as i32;
            high = (tsc >> 32i32) as i32
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
                    low = 1i32 << 8i32
                }
                else if !(index == MSR_MISC_FEATURE_ENABLES) {
                    if index == IA32_MISC_ENABLE {
                        c_comment!(("Enable Misc. Processor Features"));
                        low = 1i32 << 0i32;
                        c_comment!(("fast string"));
                    }
                    else if index == IA32_RTIT_CTL {
                        c_comment!(("linux4"));
                    }
                    else if !(index == MSR_SMI_COUNT) {
                        if index == IA32_MCG_CAP {
                            c_comment!(("netbsd"));
                        }
                        else if !(index == MSR_PKG_C2_RESIDENCY) {
                            dbg_log_c!("Unknown msr: %x", index);
                            dbg_assert!(0 != 0i32);
                        }
                    }
                }
            }
        }
        *reg32s.offset(EAX as isize) = low;
        *reg32s.offset(EDX as isize) = high;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F33() -> () {
    c_comment!(("rdpmc"));
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0F34() -> () {
    c_comment!(("sysenter"));
    let mut seg: i32 = *sysenter_cs.offset(0isize) & 65532i32;
    if !*protected_mode.offset(0isize) || seg == 0i32 {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        let ref mut fresh1 = *flags.offset(0isize);
        *fresh1 &= !FLAG_VM & !FLAG_INTERRUPT;
        *instruction_pointer.offset(0isize) = *sysenter_eip.offset(0isize);
        *reg32s.offset(ESP as isize) = *sysenter_esp.offset(0isize);
        *sreg.offset(CS as isize) = seg as u16;
        *segment_is_null.offset(CS as isize) = 0 != 0i32;
        *segment_limits.offset(CS as isize) = -1i32 as u32;
        *segment_offsets.offset(CS as isize) = 0i32;
        update_cs_size(true);
        *cpl.offset(0isize) = 0i32 as u8;
        cpl_changed();
        *sreg.offset(SS as isize) = (seg + 8i32) as u16;
        *segment_is_null.offset(SS as isize) = 0 != 0i32;
        *segment_limits.offset(SS as isize) = -1i32 as u32;
        *segment_offsets.offset(SS as isize) = 0i32;
        *stack_size_32.offset(0isize) = 0 != 1i32;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F35() -> () {
    c_comment!(("sysexit"));
    let mut seg: i32 = *sysenter_cs.offset(0isize) & 65532i32;
    if !*protected_mode.offset(0isize) || 0 != *cpl.offset(0isize) as i32 || seg == 0i32 {
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        *instruction_pointer.offset(0isize) = *reg32s.offset(EDX as isize);
        *reg32s.offset(ESP as isize) = *reg32s.offset(ECX as isize);
        *sreg.offset(CS as isize) = (seg + 16i32 | 3i32) as u16;
        *segment_is_null.offset(CS as isize) = 0 != 0i32;
        *segment_limits.offset(CS as isize) = -1i32 as u32;
        *segment_offsets.offset(CS as isize) = 0i32;
        update_cs_size(true);
        *cpl.offset(0isize) = 3i32 as u8;
        cpl_changed();
        *sreg.offset(SS as isize) = (seg + 24i32 | 3i32) as u16;
        *segment_is_null.offset(SS as isize) = 0 != 0i32;
        *segment_limits.offset(SS as isize) = -1i32 as u32;
        *segment_offsets.offset(SS as isize) = 0i32;
        *stack_size_32.offset(0isize) = 0 != 1i32;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F36() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F37() -> () {
    c_comment!(("getsec"));
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0F38() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F39() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3A() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3B() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3C() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3D() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3E() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F3F() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr16_0F40_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F40_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F40_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F40_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F41_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F41_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(!test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F41_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F41_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(!test_o(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F42_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F42_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F42_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F42_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F43_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F43_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(!test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F43_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F43_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(!test_b(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F44_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F44_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F44_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F44_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F45_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F45_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(!test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F45_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F45_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(!test_z(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F46_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F46_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F46_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F46_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F47_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F47_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(!test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F47_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F47_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(!test_be(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F48_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F48_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F48_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F48_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F49_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F49_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(!test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F49_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F49_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(!test_s(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4A_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4A_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4A_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4A_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(!test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4B_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4B_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(!test_p(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4C_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4C_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4C_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4C_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4D_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4D_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(!test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4D_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4D_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(!test_l(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4E_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4E_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4E_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4E_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4F_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    cmovcc16(!test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr16_0F4F_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    cmovcc16(!test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4F_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    cmovcc32(!test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr32_0F4F_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    cmovcc32(!test_le(), ____0, r);
}
#[no_mangle]
pub unsafe fn instr_0F50_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movmskps r, xmm"));
    let mut source: reg128 = read_xmm128s(r1);
    let mut data: i32 = (source.u32_0[0usize] >> 31i32
        | source.u32_0[1usize] >> 31i32 << 1i32
        | source.u32_0[2usize] >> 31i32 << 2i32
        | source.u32_0[3usize] >> 31i32 << 3i32) as i32;
    write_reg32(r2, data);
}
#[no_mangle]
pub unsafe fn instr_0F50_mem(mut addr: i32, mut r1: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F50_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movmskpd r, xmm"));
    let mut source: reg128 = read_xmm128s(r1);
    let mut data: i32 =
        (source.u32_0[1usize] >> 31i32 | source.u32_0[3usize] >> 31i32 << 1i32) as i32;
    write_reg32(r2, data);
}
#[no_mangle]
pub unsafe fn instr_660F50_mem(mut addr: i32, mut r1: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F54(mut source: reg128, mut r: i32) -> () {
    c_comment!(("andps xmm, xmm/mem128"));
    c_comment!(("XXX: Aligned access or #gp"));
    pand_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F54_reg(mut r1: i32, mut r2: i32) -> () { instr_0F54(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F54_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F54(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F54(mut source: reg128, mut r: i32) -> () {
    c_comment!(("andpd xmm, xmm/mem128"));
    c_comment!(("XXX: Aligned access or #gp"));
    pand_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F54_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F54(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F54_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F54(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F55(mut source: reg128, mut r: i32) -> () {
    c_comment!(("andnps xmm, xmm/mem128"));
    c_comment!(("XXX: Aligned access or #gp"));
    pandn_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F55_reg(mut r1: i32, mut r2: i32) -> () { instr_0F55(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F55_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F55(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F55(mut source: reg128, mut r: i32) -> () {
    c_comment!(("andnpd xmm, xmm/mem128"));
    c_comment!(("XXX: Aligned access or #gp"));
    pandn_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F55_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F55(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F55_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F55(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F56(mut source: reg128, mut r: i32) -> () {
    c_comment!(("orps xmm, xmm/mem128"));
    c_comment!(("XXX: Aligned access or #gp"));
    por_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F56_reg(mut r1: i32, mut r2: i32) -> () { instr_0F56(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F56_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F56(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F56(mut source: reg128, mut r: i32) -> () {
    c_comment!(("orpd xmm, xmm/mem128"));
    c_comment!(("XXX: Aligned access or #gp"));
    por_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F56_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F56(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F56_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F56(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F57(mut source: reg128, mut r: i32) -> () {
    c_comment!(("xorps xmm, xmm/mem128"));
    c_comment!(("XXX: Aligned access or #gp"));
    pxor_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_0F57_reg(mut r1: i32, mut r2: i32) -> () { instr_0F57(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F57_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F57(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F57(mut source: reg128, mut r: i32) -> () {
    c_comment!(("xorpd xmm, xmm/mem128"));
    c_comment!(("XXX: Aligned access or #gp"));
    pxor_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F57_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F57(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F57_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F57(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F60(mut source: i32, mut r: i32) -> () {
    c_comment!(("punpcklbw mm, mm/m32"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut byte0: i32 = destination.u8_0[0usize] as i32;
    let mut byte1: i32 = source & 255i32;
    let mut byte2: i32 = destination.u8_0[1usize] as i32;
    let mut byte3: i32 = source >> 8i32 & 255i32;
    let mut byte4: i32 = destination.u8_0[2usize] as i32;
    let mut byte5: i32 = source >> 16i32 & 255i32;
    let mut byte6: i32 = destination.u8_0[3usize] as i32;
    let mut byte7: i32 = source >> 24i32;
    let mut low: i32 = byte0 | byte1 << 8i32 | byte2 << 16i32 | byte3 << 24i32;
    let mut high: i32 = byte4 | byte5 << 8i32 | byte6 << 16i32 | byte7 << 24i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0F60_reg(mut r1: i32, mut r2: i32) -> () { instr_0F60(read_mmx32s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F60_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F60(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F60(mut source: reg64, mut r: i32) -> () {
    c_comment!(("punpcklbw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg64 = read_xmm64s(r);
    write_xmm128(
        r,
        destination.u8_0[0usize] as i32
            | (source.u8_0[0usize] as i32) << 8i32
            | (destination.u8_0[1usize] as i32) << 16i32
            | (source.u8_0[1usize] as i32) << 24i32,
        destination.u8_0[2usize] as i32
            | (source.u8_0[2usize] as i32) << 8i32
            | (destination.u8_0[3usize] as i32) << 16i32
            | (source.u8_0[3usize] as i32) << 24i32,
        destination.u8_0[4usize] as i32
            | (source.u8_0[4usize] as i32) << 8i32
            | (destination.u8_0[5usize] as i32) << 16i32
            | (source.u8_0[5usize] as i32) << 24i32,
        destination.u8_0[6usize] as i32
            | (source.u8_0[6usize] as i32) << 8i32
            | (destination.u8_0[7usize] as i32) << 16i32
            | (source.u8_0[7usize] as i32) << 24i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F60_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F60(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F60_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F60(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F61(mut source: i32, mut r: i32) -> () {
    c_comment!(("punpcklwd mm, mm/m32"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: i32 = destination.u16_0[0usize] as i32;
    let mut word1: i32 = source & 65535i32;
    let mut word2: i32 = destination.u16_0[1usize] as i32;
    let mut word3: i32 = source >> 16i32;
    let mut low: i32 = word0 | word1 << 16i32;
    let mut high: i32 = word2 | word3 << 16i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0F61_reg(mut r1: i32, mut r2: i32) -> () { instr_0F61(read_mmx32s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F61_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F61(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F61(mut source: reg64, mut r: i32) -> () {
    c_comment!(("punpcklwd xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg64 = read_xmm64s(r);
    write_xmm128(
        r,
        destination.u16_0[0usize] as i32 | (source.u16_0[0usize] as i32) << 16i32,
        destination.u16_0[1usize] as i32 | (source.u16_0[1usize] as i32) << 16i32,
        destination.u16_0[2usize] as i32 | (source.u16_0[2usize] as i32) << 16i32,
        destination.u16_0[3usize] as i32 | (source.u16_0[3usize] as i32) << 16i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F61_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F61(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F61_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F61(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F62(mut source: i32, mut r: i32) -> () {
    c_comment!(("punpckldq mm, mm/m32"));
    let mut destination: reg64 = read_mmx64s(r);
    write_mmx64(r, destination.u32_0[0usize] as i32, source);
}
#[no_mangle]
pub unsafe fn instr_0F62_reg(mut r1: i32, mut r2: i32) -> () { instr_0F62(read_mmx32s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F62_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F62(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F62(mut source: reg128, mut r: i32) -> () {
    c_comment!(("punpckldq xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[0usize] as i32,
        source.u32_0[0usize] as i32,
        destination.u32_0[1usize] as i32,
        source.u32_0[1usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F62_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F62(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F62_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F62(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F63(mut source: reg64, mut r: i32) -> () {
    c_comment!(("packsswb mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut low: i32 = saturate_sw_to_sb(destination.u16_0[0usize] as i32)
        | saturate_sw_to_sb(destination.u16_0[1usize] as i32) << 8i32
        | saturate_sw_to_sb(destination.u16_0[2usize] as i32) << 16i32
        | saturate_sw_to_sb(destination.u16_0[3usize] as i32) << 24i32;
    let mut high: i32 = saturate_sw_to_sb(source.u16_0[0usize] as i32)
        | saturate_sw_to_sb(source.u16_0[1usize] as i32) << 8i32
        | saturate_sw_to_sb(source.u16_0[2usize] as i32) << 16i32
        | saturate_sw_to_sb(source.u16_0[3usize] as i32) << 24i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0F63_reg(mut r1: i32, mut r2: i32) -> () { instr_0F63(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F63_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F63(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F63(mut source: reg128, mut r: i32) -> () {
    c_comment!(("packsswb xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = saturate_sw_to_sb(destination.u16_0[0usize] as i32)
        | saturate_sw_to_sb(destination.u16_0[1usize] as i32) << 8i32
        | saturate_sw_to_sb(destination.u16_0[2usize] as i32) << 16i32
        | saturate_sw_to_sb(destination.u16_0[3usize] as i32) << 24i32;
    let mut dword1: i32 = saturate_sw_to_sb(destination.u16_0[4usize] as i32)
        | saturate_sw_to_sb(destination.u16_0[5usize] as i32) << 8i32
        | saturate_sw_to_sb(destination.u16_0[6usize] as i32) << 16i32
        | saturate_sw_to_sb(destination.u16_0[7usize] as i32) << 24i32;
    let mut dword2: i32 = saturate_sw_to_sb(source.u16_0[0usize] as i32)
        | saturate_sw_to_sb(source.u16_0[1usize] as i32) << 8i32
        | saturate_sw_to_sb(source.u16_0[2usize] as i32) << 16i32
        | saturate_sw_to_sb(source.u16_0[3usize] as i32) << 24i32;
    let mut dword3: i32 = saturate_sw_to_sb(source.u16_0[4usize] as i32)
        | saturate_sw_to_sb(source.u16_0[5usize] as i32) << 8i32
        | saturate_sw_to_sb(source.u16_0[6usize] as i32) << 16i32
        | saturate_sw_to_sb(source.u16_0[7usize] as i32) << 24i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660F63_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F63(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F63_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F63(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F64(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pcmpgtb mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u8_0[i as usize] =
            (if destination.i8_0[i as usize] as i32 > source.i8_0[i as usize] as i32 {
                255i32
            }
            else {
                0i32
            }) as u8;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F64_reg(mut r1: i32, mut r2: i32) -> () { instr_0F64(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F64_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F64(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F64(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pcmpgtb xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: i32 = 0i32;
    while i < 16i32 {
        result.i8_0[i as usize] =
            (if destination.i8_0[i as usize] as i32 > source.i8_0[i as usize] as i32 {
                255i32
            }
            else {
                0i32
            }) as i8;
        i += 1
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F64_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F64(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F64_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F64(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F65(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pcmpgtw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: i32 = if destination.i16_0[0usize] as i32 > source.i16_0[0usize] as i32 {
        65535i32
    }
    else {
        0i32
    };
    let mut word1: i32 = if destination.i16_0[1usize] as i32 > source.i16_0[1usize] as i32 {
        65535i32
    }
    else {
        0i32
    };
    let mut word2: i32 = if destination.i16_0[2usize] as i32 > source.i16_0[2usize] as i32 {
        65535i32
    }
    else {
        0i32
    };
    let mut word3: i32 = if destination.i16_0[3usize] as i32 > source.i16_0[3usize] as i32 {
        65535i32
    }
    else {
        0i32
    };
    let mut low: i32 = word0 | word1 << 16i32;
    let mut high: i32 = word2 | word3 << 16i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0F65_reg(mut r1: i32, mut r2: i32) -> () { instr_0F65(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F65_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F65(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F65(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pcmpgtw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: i32 = 0i32;
    while i < 8i32 {
        result.u16_0[i as usize] =
            (if destination.i16_0[i as usize] as i32 > source.i16_0[i as usize] as i32 {
                65535i32
            }
            else {
                0i32
            }) as u16;
        i += 1
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F65_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F65(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F65_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F65(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F66(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pcmpgtd mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut low: i32 = if destination.i32_0[0usize] > source.i32_0[0usize] {
        -1i32
    }
    else {
        0i32
    };
    let mut high: i32 = if destination.i32_0[1usize] > source.i32_0[1usize] {
        -1i32
    }
    else {
        0i32
    };
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0F66_reg(mut r1: i32, mut r2: i32) -> () { instr_0F66(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F66_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F66(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F66(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pcmpgtd xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        if destination.i32_0[0usize] > source.i32_0[0usize] {
            -1i32
        }
        else {
            0i32
        },
        if destination.i32_0[1usize] > source.i32_0[1usize] {
            -1i32
        }
        else {
            0i32
        },
        if destination.i32_0[2usize] > source.i32_0[2usize] {
            -1i32
        }
        else {
            0i32
        },
        if destination.i32_0[3usize] > source.i32_0[3usize] {
            -1i32
        }
        else {
            0i32
        },
    );
}
#[no_mangle]
pub unsafe fn instr_660F66_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F66(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F66_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F66(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F67(mut source: reg64, mut r: i32) -> () {
    c_comment!(("packuswb mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut low: u32 = saturate_sw_to_ub(destination.u16_0[0usize] as u32)
        | saturate_sw_to_ub(destination.u16_0[1usize] as u32) << 8i32
        | saturate_sw_to_ub(destination.u16_0[2usize] as u32) << 16i32
        | saturate_sw_to_ub(destination.u16_0[3usize] as u32) << 24i32;
    let mut high: u32 = saturate_sw_to_ub(source.u16_0[0usize] as u32)
        | saturate_sw_to_ub(source.u16_0[1usize] as u32) << 8i32
        | saturate_sw_to_ub(source.u16_0[2usize] as u32) << 16i32
        | saturate_sw_to_ub(source.u16_0[3usize] as u32) << 24i32;
    write_mmx64(r, low as i32, high as i32);
}
#[no_mangle]
pub unsafe fn instr_0F67_reg(mut r1: i32, mut r2: i32) -> () { instr_0F67(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F67_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F67(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F67(mut source: reg128, mut r: i32) -> () {
    c_comment!(("packuswb xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: i32 = 0i32;
    while i < 8i32 {
        result.u8_0[i as usize] = saturate_sw_to_ub(destination.u16_0[i as usize] as u32) as u8;
        result.u8_0[(i | 8i32) as usize] = saturate_sw_to_ub(source.u16_0[i as usize] as u32) as u8;
        i += 1
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F67_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F67(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F67_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F67(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F68(mut source: reg64, mut r: i32) -> () {
    c_comment!(("punpckhbw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut byte0: i32 = destination.u8_0[4usize] as i32;
    let mut byte1: i32 = source.u8_0[4usize] as i32;
    let mut byte2: i32 = destination.u8_0[5usize] as i32;
    let mut byte3: i32 = source.u8_0[5usize] as i32;
    let mut byte4: i32 = destination.u8_0[6usize] as i32;
    let mut byte5: i32 = source.u8_0[6usize] as i32;
    let mut byte6: i32 = destination.u8_0[7usize] as i32;
    let mut byte7: i32 = source.u8_0[7usize] as i32;
    let mut low: i32 = byte0 | byte1 << 8i32 | byte2 << 16i32 | byte3 << 24i32;
    let mut high: i32 = byte4 | byte5 << 8i32 | byte6 << 16i32 | byte7 << 24i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0F68_reg(mut r1: i32, mut r2: i32) -> () { instr_0F68(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F68_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F68(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F68(mut source: reg128, mut r: i32) -> () {
    c_comment!(("punpckhbw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u8_0[8usize] as i32
            | (source.u8_0[8usize] as i32) << 8i32
            | (destination.u8_0[9usize] as i32) << 16i32
            | (source.u8_0[9usize] as i32) << 24i32,
        destination.u8_0[10usize] as i32
            | (source.u8_0[10usize] as i32) << 8i32
            | (destination.u8_0[11usize] as i32) << 16i32
            | (source.u8_0[11usize] as i32) << 24i32,
        destination.u8_0[12usize] as i32
            | (source.u8_0[12usize] as i32) << 8i32
            | (destination.u8_0[13usize] as i32) << 16i32
            | (source.u8_0[13usize] as i32) << 24i32,
        destination.u8_0[14usize] as i32
            | (source.u8_0[14usize] as i32) << 8i32
            | (destination.u8_0[15usize] as i32) << 16i32
            | (source.u8_0[15usize] as i32) << 24i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F68_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F68(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F68_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F68(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F69(mut source: reg64, mut r: i32) -> () {
    c_comment!(("punpckhwd mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: i32 = destination.u16_0[2usize] as i32;
    let mut word1: i32 = source.u16_0[2usize] as i32;
    let mut word2: i32 = destination.u16_0[3usize] as i32;
    let mut word3: i32 = source.u16_0[3usize] as i32;
    let mut low: i32 = word0 | word1 << 16i32;
    let mut high: i32 = word2 | word3 << 16i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0F69_reg(mut r1: i32, mut r2: i32) -> () { instr_0F69(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F69_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F69(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F69(mut source: reg128, mut r: i32) -> () {
    c_comment!(("punpckhwd xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = destination.u16_0[4usize] as i32 | (source.u16_0[4usize] as i32) << 16i32;
    let mut dword1: i32 = destination.u16_0[5usize] as i32 | (source.u16_0[5usize] as i32) << 16i32;
    let mut dword2: i32 = destination.u16_0[6usize] as i32 | (source.u16_0[6usize] as i32) << 16i32;
    let mut dword3: i32 = destination.u16_0[7usize] as i32 | (source.u16_0[7usize] as i32) << 16i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660F69_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F69(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F69_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F69(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6A(mut source: reg64, mut r: i32) -> () {
    c_comment!(("punpckhdq mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    write_mmx64(
        r,
        destination.u32_0[1usize] as i32,
        source.u32_0[1usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0F6A_reg(mut r1: i32, mut r2: i32) -> () { instr_0F6A(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F6A_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F6A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F6A(mut source: reg128, mut r: i32) -> () {
    c_comment!(("punpckhdq xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[2usize] as i32,
        source.u32_0[2usize] as i32,
        destination.u32_0[3usize] as i32,
        source.u32_0[3usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F6A_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F6A(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F6A_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F6A(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6B(mut source: reg64, mut r: i32) -> () {
    c_comment!(("packssdw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut low: i32 = (saturate_sd_to_sw(destination.u32_0[0usize])
        | saturate_sd_to_sw(destination.u32_0[1usize]) << 16i32) as i32;
    let mut high: i32 = (saturate_sd_to_sw(source.u32_0[0usize])
        | saturate_sd_to_sw(source.u32_0[1usize]) << 16i32) as i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0F6B_reg(mut r1: i32, mut r2: i32) -> () { instr_0F6B(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F6B_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F6B(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F6B(mut source: reg128, mut r: i32) -> () {
    c_comment!(("packssdw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = (saturate_sd_to_sw(destination.u32_0[0usize])
        | saturate_sd_to_sw(destination.u32_0[1usize]) << 16i32) as i32;
    let mut dword1: i32 = (saturate_sd_to_sw(destination.u32_0[2usize])
        | saturate_sd_to_sw(destination.u32_0[3usize]) << 16i32) as i32;
    let mut dword2: i32 = (saturate_sd_to_sw(source.u32_0[0usize])
        | saturate_sd_to_sw(source.u32_0[1usize]) << 16i32) as i32;
    let mut dword3: i32 = (saturate_sd_to_sw(source.u32_0[2usize])
        | saturate_sd_to_sw(source.u32_0[3usize]) << 16i32) as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660F6B_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F6B(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F6B_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F6B(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6C_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F6C_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F6C(mut source: reg128, mut r: i32) -> () {
    c_comment!(("punpcklqdq xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[0usize] as i32,
        destination.u32_0[1usize] as i32,
        source.u32_0[0usize] as i32,
        source.u32_0[1usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F6C_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F6C(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F6C_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F6C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6D_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F6D_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F6D(mut source: reg128, mut r: i32) -> () {
    c_comment!(("punpckhqdq xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[2usize] as i32,
        destination.u32_0[3usize] as i32,
        source.u32_0[2usize] as i32,
        source.u32_0[3usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F6D_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F6D(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F6D_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F6D(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6E(mut source: i32, mut r: i32) -> () {
    c_comment!(("movd mm, r/m32"));
    write_mmx64(r, source, 0i32);
}
#[no_mangle]
pub unsafe fn instr_0F6E_reg(mut r1: i32, mut r2: i32) -> () { instr_0F6E(read_reg32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F6E_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F6E(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F6E(mut source: i32, mut r: i32) -> () {
    c_comment!(("movd mm, r/m32"));
    write_xmm128(r, source, 0i32, 0i32, 0i32);
}
#[no_mangle]
pub unsafe fn instr_660F6E_reg(mut r1: i32, mut r2: i32) -> () { instr_660F6E(read_reg32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F6E_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F6E(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6F(mut source: reg64, mut r: i32) -> () {
    c_comment!(("movq mm, mm/m64"));
    write_mmx64(r, source.u32_0[0usize] as i32, source.u32_0[1usize] as i32);
}
#[no_mangle]
pub unsafe fn instr_0F6F_reg(mut r1: i32, mut r2: i32) -> () { instr_0F6F(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F6F_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F6F(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F6F(mut source: reg128, mut r: i32) -> () {
    c_comment!(("movdqa xmm, xmm/mem128"));
    c_comment!(("XXX: Aligned access or #gp"));
    c_comment!(("XXX: Aligned read or #gp"));
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660F6F_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F6F(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F6F_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F6F(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F6F(mut source: reg128, mut r: i32) -> () {
    c_comment!(("movdqu xmm, xmm/m128"));
    mov_rm_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_F30F6F_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F6F(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F30F6F_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F6F(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F70(mut source: reg64, mut r: i32, mut imm8: i32) -> () {
    c_comment!(("pshufw mm1, mm2/m64, imm8"));
    let mut word0_shift: i32 = imm8 & 3i32;
    let mut word0: u32 = source.u32_0[(word0_shift >> 1i32) as usize]
        >> ((word0_shift & 1i32) << 4i32)
        & 65535i32 as u32;
    let mut word1_shift: i32 = imm8 >> 2i32 & 3i32;
    let mut word1: u32 =
        source.u32_0[(word1_shift >> 1i32) as usize] >> ((word1_shift & 1i32) << 4i32);
    let mut low: i32 = (word0 | word1 << 16i32) as i32;
    let mut word2_shift: i32 = imm8 >> 4i32 & 3i32;
    let mut word2: u32 = source.u32_0[(word2_shift >> 1i32) as usize]
        >> ((word2_shift & 1i32) << 4i32)
        & 65535i32 as u32;
    let mut word3_shift: u32 = (imm8 >> 6i32) as u32;
    let mut word3: u32 =
        source.u32_0[(word3_shift >> 1i32) as usize] >> ((word3_shift & 1i32 as u32) << 4i32);
    let mut high: i32 = (word2 | word3 << 16i32) as i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0F70_reg(mut r1: i32, mut r2: i32, mut imm: i32) -> () {
    instr_0F70(read_mmx64s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_0F70_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    instr_0F70(return_on_pagefault!(safe_read64s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_660F70(mut source: reg128, mut r: i32, mut imm8: i32) -> () {
    c_comment!(("pshufd xmm, xmm/mem128"));
    c_comment!(("XXX: Aligned access or #gp"));
    write_xmm128(
        r,
        source.u32_0[(imm8 & 3i32) as usize] as i32,
        source.u32_0[(imm8 >> 2i32 & 3i32) as usize] as i32,
        source.u32_0[(imm8 >> 4i32 & 3i32) as usize] as i32,
        source.u32_0[(imm8 >> 6i32 & 3i32) as usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660F70_reg(mut r1: i32, mut r2: i32, mut imm: i32) -> () {
    instr_660F70(read_xmm128s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_660F70_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    instr_660F70(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_F20F70(mut source: reg128, mut r: i32, mut imm8: i32) -> () {
    c_comment!(("pshuflw xmm, xmm/m128, imm8"));
    c_comment!(("XXX: Aligned access or #gp"));
    write_xmm128(
        r,
        source.u16_0[(imm8 & 3i32) as usize] as i32
            | (source.u16_0[(imm8 >> 2i32 & 3i32) as usize] as i32) << 16i32,
        source.u16_0[(imm8 >> 4i32 & 3i32) as usize] as i32
            | (source.u16_0[(imm8 >> 6i32 & 3i32) as usize] as i32) << 16i32,
        source.u32_0[2usize] as i32,
        source.u32_0[3usize] as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F20F70_reg(mut r1: i32, mut r2: i32, mut imm: i32) -> () {
    instr_F20F70(read_xmm128s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_F20F70_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    instr_F20F70(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_F30F70(mut source: reg128, mut r: i32, mut imm8: i32) -> () {
    c_comment!(("pshufhw xmm, xmm/m128, imm8"));
    c_comment!(("XXX: Aligned access or #gp"));
    write_xmm128(
        r,
        source.u32_0[0usize] as i32,
        source.u32_0[1usize] as i32,
        source.u16_0[(imm8 & 3i32 | 4i32) as usize] as i32
            | (source.u16_0[(imm8 >> 2i32 & 3i32 | 4i32) as usize] as i32) << 16i32,
        source.u16_0[(imm8 >> 4i32 & 3i32 | 4i32) as usize] as i32
            | (source.u16_0[(imm8 >> 6i32 & 3i32 | 4i32) as usize] as i32) << 16i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F30F70_reg(mut r1: i32, mut r2: i32, mut imm: i32) -> () {
    instr_F30F70(read_xmm128s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_F30F70_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    instr_F30F70(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_0F71_2_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F71_4_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F71_6_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F71_2_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psrlw mm, imm8"));
    psrlw_r64(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_0F71_4_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psraw mm, imm8"));
    psraw_r64(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_0F71_6_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psllw mm, imm8"));
    psllw_r64(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_660F71_2_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F71_4_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F71_6_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F71_2_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psrlw xmm, imm8"));
    psrlw_r128(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_660F71_4_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psraw xmm, imm8"));
    psraw_r128(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_660F71_6_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psllw xmm, imm8"));
    psllw_r128(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_0F72_2_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F72_4_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F72_6_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F72_2_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psrld mm, imm8"));
    psrld_r64(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_0F72_4_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psrad mm, imm8"));
    psrad_r64(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_0F72_6_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("pslld mm, imm8"));
    pslld_r64(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_660F72_2_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F72_4_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F72_6_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F72_2_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psrld xmm, imm8"));
    psrld_r128(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_660F72_4_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psrad xmm, imm8"));
    psrad_r128(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_660F72_6_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("pslld xmm, imm8"));
    pslld_r128(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_0F73_2_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F73_6_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F73_2_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psrlq mm, imm8"));
    psrlq_r64(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_0F73_6_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psllq mm, imm8"));
    psllq_r64(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_660F73_2_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F73_3_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F73_6_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F73_7_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F73_2_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psrlq xmm, imm8"));
    psrlq_r128(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_660F73_3_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psrldq xmm, imm8"));
    let mut destination: reg128 = read_xmm128s(r);
    if imm8 == 0i32 {
        return;
    }
    else {
        let mut result: reg128 = reg128 {
            i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        };
        let mut shift: u32 = (if imm8 > 15i32 { 128i32 } else { imm8 << 3i32 }) as u32;
        if shift <= 63i32 as u32 {
            result.u64_0[0usize] = destination.u64_0[0usize] >> shift
                | destination.u64_0[1usize] << (64i32 as u32).wrapping_sub(shift);
            result.u64_0[1usize] = destination.u64_0[1usize] >> shift
        }
        else if shift <= 127i32 as u32 {
            result.u64_0[0usize] = destination.u64_0[1usize] >> shift.wrapping_sub(64i32 as u32);
            result.u64_0[1usize] = 0i32 as u64
        }
        write_xmm_reg128(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_660F73_6_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("psllq xmm, imm8"));
    psllq_r128(r, imm8 as u32);
}
#[no_mangle]
pub unsafe fn instr_660F73_7_reg(mut r: i32, mut imm8: i32) -> () {
    c_comment!(("pslldq xmm, imm8"));
    let mut destination: reg128 = read_xmm128s(r);
    if imm8 == 0i32 {
        return;
    }
    else {
        let mut result: reg128 = reg128 {
            i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        };
        let mut shift: u32 = (if imm8 > 15i32 { 128i32 } else { imm8 << 3i32 }) as u32;
        if shift <= 63i32 as u32 {
            result.u64_0[0usize] = destination.u64_0[0usize] << shift;
            result.u64_0[1usize] = destination.u64_0[1usize] << shift
                | destination.u64_0[0usize] >> (64i32 as u32).wrapping_sub(shift)
        }
        else if shift <= 127i32 as u32 {
            result.u64_0[0usize] = 0i32 as u64;
            result.u64_0[1usize] = destination.u64_0[0usize] << shift.wrapping_sub(64i32 as u32)
        }
        write_xmm_reg128(r, result);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0F74(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pcmpeqb mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u8_0[i as usize] =
            (if destination.i8_0[i as usize] as i32 == source.i8_0[i as usize] as i32 {
                255i32
            }
            else {
                0i32
            }) as u8;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F74_reg(mut r1: i32, mut r2: i32) -> () { instr_0F74(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F74_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F74(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F74(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pcmpeqb xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: i32 = 0i32;
    while i < 16i32 {
        result.u8_0[i as usize] =
            (if source.u8_0[i as usize] as i32 == destination.u8_0[i as usize] as i32 {
                255i32
            }
            else {
                0i32
            }) as u8;
        i += 1
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F74_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F74(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F74_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F74(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F75(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pcmpeqw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: i32 = if destination.u16_0[0usize] as i32 == source.u16_0[0usize] as i32 {
        65535i32
    }
    else {
        0i32
    };
    let mut word1: i32 = if destination.u16_0[1usize] as i32 == source.u16_0[1usize] as i32 {
        65535i32
    }
    else {
        0i32
    };
    let mut word2: i32 = if destination.u16_0[2usize] as i32 == source.u16_0[2usize] as i32 {
        65535i32
    }
    else {
        0i32
    };
    let mut word3: i32 = if destination.u16_0[3usize] as i32 == source.u16_0[3usize] as i32 {
        65535i32
    }
    else {
        0i32
    };
    let mut low: i32 = word0 | word1 << 16i32;
    let mut high: i32 = word2 | word3 << 16i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0F75_reg(mut r1: i32, mut r2: i32) -> () { instr_0F75(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F75_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F75(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F75(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pcmpeqw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: i32 = 0i32;
    while i < 8i32 {
        result.u16_0[i as usize] =
            (if source.u16_0[i as usize] as i32 == destination.u16_0[i as usize] as i32 {
                65535i32
            }
            else {
                0i32
            }) as u16;
        i += 1
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F75_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F75(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F75_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F75(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F76(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pcmpeqd mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut low: i32 = if destination.u32_0[0usize] == source.u32_0[0usize] {
        -1i32
    }
    else {
        0i32
    };
    let mut high: i32 = if destination.u32_0[1usize] == source.u32_0[1usize] {
        -1i32
    }
    else {
        0i32
    };
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0F76_reg(mut r1: i32, mut r2: i32) -> () { instr_0F76(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F76_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F76(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F76(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pcmpeqd xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        if source.u32_0[0usize] == destination.u32_0[0usize] {
            -1i32
        }
        else {
            0i32
        },
        if source.u32_0[1usize] == destination.u32_0[1usize] {
            -1i32
        }
        else {
            0i32
        },
        if source.u32_0[2usize] == destination.u32_0[2usize] {
            -1i32
        }
        else {
            0i32
        },
        if source.u32_0[3usize] == destination.u32_0[3usize] {
            -1i32
        }
        else {
            0i32
        },
    );
}
#[no_mangle]
pub unsafe fn instr_660F76_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F76(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F76_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F76(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F77() -> () {
    c_comment!(("emms"));
    fpu_set_tag_word(65535i32);
}
#[no_mangle]
pub unsafe fn instr_0F78() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F79() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F7A() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F7B() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F7C() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F7D() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F7E(mut r: i32) -> i32 {
    c_comment!(("movd r/m32, mm"));
    let mut data: reg64 = read_mmx64s(r);
    return data.u32_0[0usize] as i32;
}
#[no_mangle]
pub unsafe fn instr_0F7E_reg(mut r1: i32, mut r2: i32) -> () { write_reg32(r1, instr_0F7E(r2)); }
#[no_mangle]
pub unsafe fn instr_0F7E_mem(mut addr: i32, mut r: i32) -> () {
    return_on_pagefault!(safe_write32(addr, instr_0F7E(r)));
}
#[no_mangle]
pub unsafe fn instr_660F7E(mut r: i32) -> i32 {
    c_comment!(("movd r/m32, xmm"));
    let mut data: reg64 = read_xmm64s(r);
    return data.u32_0[0usize] as i32;
}
#[no_mangle]
pub unsafe fn instr_660F7E_reg(mut r1: i32, mut r2: i32) -> () {
    write_reg32(r1, instr_660F7E(r2));
}
#[no_mangle]
pub unsafe fn instr_660F7E_mem(mut addr: i32, mut r: i32) -> () {
    return_on_pagefault!(safe_write32(addr, instr_660F7E(r)));
}
#[no_mangle]
pub unsafe fn instr_F30F7E_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movq xmm, xmm/mem64"));
    let mut data: reg64 = return_on_pagefault!(safe_read64s(addr));
    write_xmm128(
        r,
        data.u32_0[0usize] as i32,
        data.u32_0[1usize] as i32,
        0i32,
        0i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F30F7E_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movq xmm, xmm/mem64"));
    let mut data: reg64 = read_xmm64s(r1);
    write_xmm128(
        r2,
        data.u32_0[0usize] as i32,
        data.u32_0[1usize] as i32,
        0i32,
        0i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0F7F_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movq mm/m64, mm"));
    mov_r_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F7F_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movq mm/m64, mm"));
    let mut data: reg64 = read_mmx64s(r2);
    write_mmx64(r1, data.u32_0[0usize] as i32, data.u32_0[1usize] as i32);
}
#[no_mangle]
pub unsafe fn instr_660F7F_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movdqa xmm/m128, xmm"));
    c_comment!(("XXX: Aligned write or #gp"));
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_660F7F_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movdqa xmm/m128, xmm"));
    c_comment!(("XXX: Aligned access or #gp"));
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr_F30F7F_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movdqu xmm/m128, xmm"));
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_F30F7F_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movdqu xmm/m128, xmm"));
    mov_r_r128(r1, r2);
}
#[no_mangle]
pub unsafe fn instr16_0F80(mut imm: i32) -> () { jmpcc16(test_o(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F80(mut imm: i32) -> () { jmpcc32(test_o(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F81(mut imm: i32) -> () { jmpcc16(!test_o(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F81(mut imm: i32) -> () { jmpcc32(!test_o(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F82(mut imm: i32) -> () { jmpcc16(test_b(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F82(mut imm: i32) -> () { jmpcc32(test_b(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F83(mut imm: i32) -> () { jmpcc16(!test_b(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F83(mut imm: i32) -> () { jmpcc32(!test_b(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F84(mut imm: i32) -> () { jmpcc16(test_z(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F84(mut imm: i32) -> () { jmpcc32(test_z(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F85(mut imm: i32) -> () { jmpcc16(!test_z(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F85(mut imm: i32) -> () { jmpcc32(!test_z(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F86(mut imm: i32) -> () { jmpcc16(test_be(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F86(mut imm: i32) -> () { jmpcc32(test_be(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F87(mut imm: i32) -> () { jmpcc16(!test_be(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F87(mut imm: i32) -> () { jmpcc32(!test_be(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F88(mut imm: i32) -> () { jmpcc16(test_s(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F88(mut imm: i32) -> () { jmpcc32(test_s(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F89(mut imm: i32) -> () { jmpcc16(!test_s(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F89(mut imm: i32) -> () { jmpcc32(!test_s(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8A(mut imm: i32) -> () { jmpcc16(test_p(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8A(mut imm: i32) -> () { jmpcc32(test_p(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8B(mut imm: i32) -> () { jmpcc16(!test_p(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8B(mut imm: i32) -> () { jmpcc32(!test_p(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8C(mut imm: i32) -> () { jmpcc16(test_l(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8C(mut imm: i32) -> () { jmpcc32(test_l(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8D(mut imm: i32) -> () { jmpcc16(!test_l(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8D(mut imm: i32) -> () { jmpcc32(!test_l(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8E(mut imm: i32) -> () { jmpcc16(test_le(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8E(mut imm: i32) -> () { jmpcc32(test_le(), imm); }
#[no_mangle]
pub unsafe fn instr16_0F8F(mut imm: i32) -> () { jmpcc16(!test_le(), imm); }
#[no_mangle]
pub unsafe fn instr32_0F8F(mut imm: i32) -> () { jmpcc32(!test_le(), imm); }
#[no_mangle]
pub unsafe fn instr_0F90_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(test_o(), r); }
#[no_mangle]
pub unsafe fn instr_0F91_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(!test_o(), r); }
#[no_mangle]
pub unsafe fn instr_0F92_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(test_b(), r); }
#[no_mangle]
pub unsafe fn instr_0F93_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(!test_b(), r); }
#[no_mangle]
pub unsafe fn instr_0F94_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(test_z(), r); }
#[no_mangle]
pub unsafe fn instr_0F95_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(!test_z(), r); }
#[no_mangle]
pub unsafe fn instr_0F96_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(test_be(), r); }
#[no_mangle]
pub unsafe fn instr_0F97_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(!test_be(), r); }
#[no_mangle]
pub unsafe fn instr_0F98_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(test_s(), r); }
#[no_mangle]
pub unsafe fn instr_0F99_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(!test_s(), r); }
#[no_mangle]
pub unsafe fn instr_0F9A_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(test_p(), r); }
#[no_mangle]
pub unsafe fn instr_0F9B_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(!test_p(), r); }
#[no_mangle]
pub unsafe fn instr_0F9C_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(test_l(), r); }
#[no_mangle]
pub unsafe fn instr_0F9D_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(!test_l(), r); }
#[no_mangle]
pub unsafe fn instr_0F9E_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(test_le(), r); }
#[no_mangle]
pub unsafe fn instr_0F9F_reg(mut r: i32, mut unused: i32) -> () { setcc_reg(!test_le(), r); }
#[no_mangle]
pub unsafe fn instr_0F90_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(test_o(), addr); }
#[no_mangle]
pub unsafe fn instr_0F91_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(!test_o(), addr); }
#[no_mangle]
pub unsafe fn instr_0F92_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(test_b(), addr); }
#[no_mangle]
pub unsafe fn instr_0F93_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(!test_b(), addr); }
#[no_mangle]
pub unsafe fn instr_0F94_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(test_z(), addr); }
#[no_mangle]
pub unsafe fn instr_0F95_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(!test_z(), addr); }
#[no_mangle]
pub unsafe fn instr_0F96_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(test_be(), addr); }
#[no_mangle]
pub unsafe fn instr_0F97_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(!test_be(), addr); }
#[no_mangle]
pub unsafe fn instr_0F98_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(test_s(), addr); }
#[no_mangle]
pub unsafe fn instr_0F99_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(!test_s(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9A_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(test_p(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9B_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(!test_p(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9C_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(test_l(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9D_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(!test_l(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9E_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(test_le(), addr); }
#[no_mangle]
pub unsafe fn instr_0F9F_mem(mut addr: i32, mut unused: i32) -> () { setcc_mem(!test_le(), addr); }
#[no_mangle]
pub unsafe fn instr16_0FA0() -> () {
    return_on_pagefault!(push16(*sreg.offset(FS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_0FA0() -> () {
    return_on_pagefault!(push32(*sreg.offset(FS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_0FA1() -> () {
    if !switch_seg(
        FS,
        return_on_pagefault!(safe_read16(get_stack_pointer(0i32))),
    ) {
        return;
    }
    else {
        adjust_stack_reg(2i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_0FA1() -> () {
    if !switch_seg(
        FS,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0i32))) & 65535i32,
    ) {
        return;
    }
    else {
        adjust_stack_reg(4i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0FA2() -> () { cpuid(); }
#[no_mangle]
pub unsafe fn instr16_0FA3_reg(mut r1: i32, mut r2: i32) -> () {
    bt_reg(read_reg16(r1), read_reg16(r2) & 15i32);
}
#[no_mangle]
pub unsafe fn instr16_0FA3_mem(mut addr: i32, mut r: i32) -> () {
    bt_mem(addr, read_reg16(r) << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr32_0FA3_reg(mut r1: i32, mut r2: i32) -> () {
    bt_reg(read_reg32(r1), read_reg32(r2) & 31i32);
}
#[no_mangle]
pub unsafe fn instr32_0FA3_mem(mut addr: i32, mut r: i32) -> () { bt_mem(addr, read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr16_0FA4_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, shld16(___, read_reg16(r), imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_0FA4_reg(mut r1: i32, mut r: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, shld16(____0, read_reg16(r), imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_0FA4_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, shld32(___, read_reg32(r), imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_0FA4_reg(mut r1: i32, mut r: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, shld32(____0, read_reg32(r), imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_0FA5_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        shld16(___, read_reg16(r), *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr16_0FA5_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(
        r1,
        shld16(
            ____0,
            read_reg16(r),
            *reg8.offset(CL as isize) as i32 & 31i32,
        ),
    );
}
#[no_mangle]
pub unsafe fn instr32_0FA5_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        shld32(___, read_reg32(r), *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr32_0FA5_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(
        r1,
        shld32(
            ____0,
            read_reg32(r),
            *reg8.offset(CL as isize) as i32 & 31i32,
        ),
    );
}
#[no_mangle]
pub unsafe fn instr_0FA6() -> () {
    c_comment!(("obsolete cmpxchg (os/2)"));
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_0FA7() -> () { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr16_0FA8() -> () {
    return_on_pagefault!(push16(*sreg.offset(GS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_0FA8() -> () {
    return_on_pagefault!(push32(*sreg.offset(GS as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr16_0FA9() -> () {
    if !switch_seg(
        GS,
        return_on_pagefault!(safe_read16(get_stack_pointer(0i32))),
    ) {
        return;
    }
    else {
        adjust_stack_reg(2i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr32_0FA9() -> () {
    if !switch_seg(
        GS,
        return_on_pagefault!(safe_read32s(get_stack_pointer(0i32))) & 65535i32,
    ) {
        return;
    }
    else {
        adjust_stack_reg(4i32);
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0FAA() -> () {
    c_comment!(("rsm"));
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr16_0FAB_reg(mut r1: i32, mut r2: i32) -> () {
    write_reg16(r1, bts_reg(read_reg16(r1), read_reg16(r2) & 15i32));
}
#[no_mangle]
pub unsafe fn instr16_0FAB_mem(mut addr: i32, mut r: i32) -> () {
    bts_mem(addr, read_reg16(r) << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr32_0FAB_reg(mut r1: i32, mut r2: i32) -> () {
    write_reg32(r1, bts_reg(read_reg32(r1), read_reg32(r2) & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_0FAB_mem(mut addr: i32, mut r: i32) -> () { bts_mem(addr, read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr16_0FAC_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, shrd16(___, read_reg16(r), imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_0FAC_reg(mut r1: i32, mut r: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, shrd16(____0, read_reg16(r), imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_0FAC_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, shrd32(___, read_reg32(r), imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_0FAC_reg(mut r1: i32, mut r: i32, mut imm: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, shrd32(____0, read_reg32(r), imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr16_0FAD_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(
        ___,
        addr,
        shrd16(___, read_reg16(r), *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr16_0FAD_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(
        r1,
        shrd16(
            ____0,
            read_reg16(r),
            *reg8.offset(CL as isize) as i32 & 31i32,
        ),
    );
}
#[no_mangle]
pub unsafe fn instr32_0FAD_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE32!(
        ___,
        addr,
        shrd32(___, read_reg32(r), *reg8.offset(CL as isize) as i32 & 31i32)
    );
}
#[no_mangle]
pub unsafe fn instr32_0FAD_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(
        r1,
        shrd32(
            ____0,
            read_reg32(r),
            *reg8.offset(CL as isize) as i32 & 31i32,
        ),
    );
}
#[no_mangle]
pub unsafe fn instr_0FAE_0_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_0_mem(mut addr: i32) -> () { fxsave(addr as u32); }
#[no_mangle]
pub unsafe fn instr_0FAE_1_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_1_mem(mut addr: i32) -> () { fxrstor(addr as u32); }
#[no_mangle]
pub unsafe fn instr_0FAE_2_reg(mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0FAE_2_mem(mut addr: i32) -> () {
    c_comment!(("ldmxcsr"));
    let mut new_mxcsr: i32 = return_on_pagefault!(safe_read32s(addr));
    if new_mxcsr & 1 << 6 != 0 {
        dbg_log!("Warning: Unimplemented MXCSR bit: {:x}", new_mxcsr)
    }
    if 0 != new_mxcsr & !MXCSR_MASK {
        dbg_log!("Invalid mxcsr bits: {:x}", new_mxcsr & !MXCSR_MASK);
        trigger_gp_non_raising(0i32);
        return;
    }
    else {
        *mxcsr = new_mxcsr;
        return;
    };
}
#[no_mangle]
pub unsafe fn instr_0FAE_3_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_3_mem(mut addr: i32) -> () {
    c_comment!(("stmxcsr"));
    return_on_pagefault!(safe_write32(addr, *mxcsr));
}
#[no_mangle]
pub unsafe fn instr_0FAE_4_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_4_mem(mut addr: i32) -> () {
    c_comment!(("xsave"));
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0FAE_5_reg(mut r: i32) -> () {
    c_comment!(("lfence"));
    dbg_assert!(r == 0i32, ("Unexpected lfence encoding"));
}
#[no_mangle]
pub unsafe fn instr_0FAE_5_mem(mut addr: i32) -> () {
    c_comment!(("xrstor"));
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0FAE_6_reg(mut r: i32) -> () {
    c_comment!(("mfence"));
    dbg_assert!(r == 0i32, ("Unexpected mfence encoding"));
}
#[no_mangle]
pub unsafe fn instr_0FAE_6_mem(mut addr: i32) -> () {
    c_comment!(("xsaveopt"));
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0FAE_7_reg(mut r: i32) -> () {
    c_comment!(("sfence"));
    dbg_assert!(r == 0i32, ("Unexpected sfence encoding"));
}
#[no_mangle]
pub unsafe fn instr_0FAE_7_mem(mut addr: i32) -> () {
    c_comment!(("clflush"));
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr16_0FAF_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, imul_reg16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0FAF_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, imul_reg16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FAF_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, imul_reg32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FAF_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, imul_reg32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr_0FB0_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("cmpxchg8"));
    let mut data: i32 = read_reg8(r1);
    cmp8(*reg8.offset(AL as isize) as i32, data);
    if getzf() {
        write_reg8(r1, read_reg8(r2));
    }
    else {
        *reg8.offset(AL as isize) = data as u8
    };
}
#[no_mangle]
pub unsafe fn instr_0FB0_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("cmpxchg8"));
    return_on_pagefault!(writable_or_pagefault(addr, 1i32));
    let mut data: i32 = return_on_pagefault!(safe_read8(addr));
    cmp8(*reg8.offset(AL as isize) as i32, data);
    if getzf() {
        safe_write8(addr, read_reg8(r)).unwrap();
    }
    else {
        safe_write8(addr, data).unwrap();
        *reg8.offset(AL as isize) = data as u8
    };
}
#[no_mangle]
pub unsafe fn instr16_0FB1_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("cmpxchg16"));
    let mut data: i32 = read_reg16(r1);
    cmp16(*reg16.offset(AX as isize) as i32, data);
    if getzf() {
        write_reg16(r1, read_reg16(r2));
    }
    else {
        *reg16.offset(AX as isize) = data as u16
    };
}
#[no_mangle]
pub unsafe fn instr16_0FB1_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("cmpxchg16"));
    return_on_pagefault!(writable_or_pagefault(addr, 2i32));
    let mut data: i32 = return_on_pagefault!(safe_read16(addr));
    cmp16(*reg16.offset(AX as isize) as i32, data);
    if getzf() {
        safe_write16(addr, read_reg16(r)).unwrap();
    }
    else {
        safe_write16(addr, data).unwrap();
        *reg16.offset(AX as isize) = data as u16
    };
}
#[no_mangle]
pub unsafe fn instr32_0FB1_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("cmpxchg32"));
    let mut data: i32 = read_reg32(r1);
    cmp32(*reg32s.offset(EAX as isize), data);
    if getzf() {
        write_reg32(r1, read_reg32(r2));
    }
    else {
        *reg32s.offset(EAX as isize) = data
    };
}
#[no_mangle]
pub unsafe fn instr32_0FB1_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("cmpxchg32"));
    return_on_pagefault!(writable_or_pagefault(addr, 4i32));
    let mut data: i32 = return_on_pagefault!(safe_read32s(addr));
    cmp32(*reg32s.offset(EAX as isize), data);
    if getzf() {
        safe_write32(addr, read_reg32(r)).unwrap();
    }
    else {
        safe_write32(addr, data).unwrap();
        *reg32s.offset(EAX as isize) = data
    };
}
#[no_mangle]
pub unsafe fn instr16_0FB2_reg(mut unused: i32, mut unused2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB2_mem(mut addr: i32, mut r: i32) -> () {
    lss16(addr, get_reg16_index(r), SS);
}
#[no_mangle]
pub unsafe fn instr32_0FB2_reg(mut unused: i32, mut unused2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FB2_mem(mut addr: i32, mut r: i32) -> () { lss32(addr, r, SS); }
#[no_mangle]
pub unsafe fn instr16_0FB3_reg(mut r1: i32, mut r2: i32) -> () {
    write_reg16(r1, btr_reg(read_reg16(r1), read_reg16(r2) & 15i32));
}
#[no_mangle]
pub unsafe fn instr16_0FB3_mem(mut addr: i32, mut r: i32) -> () {
    btr_mem(addr, read_reg16(r) << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr32_0FB3_reg(mut r1: i32, mut r2: i32) -> () {
    write_reg32(r1, btr_reg(read_reg32(r1), read_reg32(r2) & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_0FB3_mem(mut addr: i32, mut r: i32) -> () { btr_mem(addr, read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr16_0FB4_reg(mut unused: i32, mut unused2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB4_mem(mut addr: i32, mut r: i32) -> () {
    lss16(addr, get_reg16_index(r), FS);
}
#[no_mangle]
pub unsafe fn instr32_0FB4_reg(mut unused: i32, mut unused2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FB4_mem(mut addr: i32, mut r: i32) -> () { lss32(addr, r, FS); }
#[no_mangle]
pub unsafe fn instr16_0FB5_reg(mut unused: i32, mut unused2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB5_mem(mut addr: i32, mut r: i32) -> () {
    lss16(addr, get_reg16_index(r), GS);
}
#[no_mangle]
pub unsafe fn instr32_0FB5_reg(mut unused: i32, mut unused2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FB5_mem(mut addr: i32, mut r: i32) -> () { lss32(addr, r, GS); }
#[no_mangle]
pub unsafe fn instr16_0FB6_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg16(r, ____0);
}
#[no_mangle]
pub unsafe fn instr16_0FB6_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg16(r, ____0);
}
#[no_mangle]
pub unsafe fn instr32_0FB6_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg32(r, ____0);
}
#[no_mangle]
pub unsafe fn instr32_0FB6_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg32(r, ____0);
}
#[no_mangle]
pub unsafe fn instr16_0FB7_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, ____0);
}
#[no_mangle]
pub unsafe fn instr16_0FB7_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, ____0);
}
#[no_mangle]
pub unsafe fn instr32_0FB7_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg32(r, ____0);
}
#[no_mangle]
pub unsafe fn instr32_0FB7_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg32(r, ____0);
}
#[no_mangle]
pub unsafe fn instr16_0FB8_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB8_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_F30FB8_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, popcnt(____0));
}
#[no_mangle]
pub unsafe fn instr16_F30FB8_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, popcnt(____0));
}
#[no_mangle]
pub unsafe fn instr32_0FB8_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FB8_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_F30FB8_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, popcnt(____0));
}
#[no_mangle]
pub unsafe fn instr32_F30FB8_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, popcnt(____0));
}
#[no_mangle]
pub unsafe fn instr_0FB9() -> () {
    c_comment!(("UD2"));
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr16_0FBA_4_reg(mut r: i32, mut imm: i32) -> () {
    bt_reg(read_reg16(r), imm & 15i32);
}
#[no_mangle]
pub unsafe fn instr16_0FBA_4_mem(mut addr: i32, mut imm: i32) -> () { bt_mem(addr, imm & 15i32); }
#[no_mangle]
pub unsafe fn instr16_0FBA_5_reg(mut r: i32, mut imm: i32) -> () {
    write_reg16(r, bts_reg(read_reg16(r), imm & 15i32));
}
#[no_mangle]
pub unsafe fn instr16_0FBA_5_mem(mut addr: i32, mut imm: i32) -> () { bts_mem(addr, imm & 15i32); }
#[no_mangle]
pub unsafe fn instr16_0FBA_6_reg(mut r: i32, mut imm: i32) -> () {
    write_reg16(r, btr_reg(read_reg16(r), imm & 15i32));
}
#[no_mangle]
pub unsafe fn instr16_0FBA_6_mem(mut addr: i32, mut imm: i32) -> () { btr_mem(addr, imm & 15i32); }
#[no_mangle]
pub unsafe fn instr16_0FBA_7_reg(mut r: i32, mut imm: i32) -> () {
    write_reg16(r, btc_reg(read_reg16(r), imm & 15i32));
}
#[no_mangle]
pub unsafe fn instr16_0FBA_7_mem(mut addr: i32, mut imm: i32) -> () { btc_mem(addr, imm & 15i32); }
#[no_mangle]
pub unsafe fn instr32_0FBA_4_reg(mut r: i32, mut imm: i32) -> () {
    bt_reg(read_reg32(r), imm & 31i32);
}
#[no_mangle]
pub unsafe fn instr32_0FBA_4_mem(mut addr: i32, mut imm: i32) -> () { bt_mem(addr, imm & 31i32); }
#[no_mangle]
pub unsafe fn instr32_0FBA_5_reg(mut r: i32, mut imm: i32) -> () {
    write_reg32(r, bts_reg(read_reg32(r), imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_0FBA_5_mem(mut addr: i32, mut imm: i32) -> () { bts_mem(addr, imm & 31i32); }
#[no_mangle]
pub unsafe fn instr32_0FBA_6_reg(mut r: i32, mut imm: i32) -> () {
    write_reg32(r, btr_reg(read_reg32(r), imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_0FBA_6_mem(mut addr: i32, mut imm: i32) -> () { btr_mem(addr, imm & 31i32); }
#[no_mangle]
pub unsafe fn instr32_0FBA_7_reg(mut r: i32, mut imm: i32) -> () {
    write_reg32(r, btc_reg(read_reg32(r), imm & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_0FBA_7_mem(mut addr: i32, mut imm: i32) -> () { btc_mem(addr, imm & 31i32); }
#[no_mangle]
pub unsafe fn instr16_0FBB_reg(mut r1: i32, mut r2: i32) -> () {
    write_reg16(r1, btc_reg(read_reg16(r1), read_reg16(r2) & 15i32));
}
#[no_mangle]
pub unsafe fn instr16_0FBB_mem(mut addr: i32, mut r: i32) -> () {
    btc_mem(addr, read_reg16(r) << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr32_0FBB_reg(mut r1: i32, mut r2: i32) -> () {
    write_reg32(r1, btc_reg(read_reg32(r1), read_reg32(r2) & 31i32));
}
#[no_mangle]
pub unsafe fn instr32_0FBB_mem(mut addr: i32, mut r: i32) -> () { btc_mem(addr, read_reg32(r)); }
#[no_mangle]
pub unsafe fn instr16_0FBC_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, bsf16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0FBC_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, bsf16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FBC_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, bsf32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FBC_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, bsf32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0FBD_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, bsr16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0FBD_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, bsr16(read_reg16(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FBD_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read32s(addr));
    write_reg32(r, bsr32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr32_0FBD_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r, bsr32(read_reg32(r), ____0));
}
#[no_mangle]
pub unsafe fn instr16_0FBE_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg16(r, ____0 << 24i32 >> 24i32);
}
#[no_mangle]
pub unsafe fn instr16_0FBE_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg16(r, ____0 << 24i32 >> 24i32);
}
#[no_mangle]
pub unsafe fn instr32_0FBE_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read8(addr));
    write_reg32(r, ____0 << 24i32 >> 24i32);
}
#[no_mangle]
pub unsafe fn instr32_0FBE_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg32(r, ____0 << 24i32 >> 24i32);
}
#[no_mangle]
pub unsafe fn instr16_0FBF_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg16(r, ____0 << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr16_0FBF_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r, ____0 << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr32_0FBF_mem(mut addr: i32, mut r: i32) -> () {
    let mut ____0: i32 = return_on_pagefault!(safe_read16(addr));
    write_reg32(r, ____0 << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr32_0FBF_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg32(r, ____0 << 16i32 >> 16i32);
}
#[no_mangle]
pub unsafe fn instr_0FC0_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE8!(___, addr, xadd8(___, get_reg8_index(r)));
}
#[no_mangle]
pub unsafe fn instr_0FC0_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg8(r1);
    write_reg8(r1, xadd8(____0, get_reg8_index(r)));
}
#[no_mangle]
pub unsafe fn instr16_0FC1_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE16!(___, addr, xadd16(___, get_reg16_index(r)));
}
#[no_mangle]
pub unsafe fn instr16_0FC1_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg16(r1);
    write_reg16(r1, xadd16(____0, get_reg16_index(r)));
}
#[no_mangle]
pub unsafe fn instr32_0FC1_mem(mut addr: i32, mut r: i32) -> () {
    SAFE_READ_WRITE32!(___, addr, xadd32(___, r));
}
#[no_mangle]
pub unsafe fn instr32_0FC1_reg(mut r1: i32, mut r: i32) -> () {
    let mut ____0: i32 = read_reg32(r1);
    write_reg32(r1, xadd32(____0, r));
}
#[no_mangle]
pub unsafe fn instr_0FC3_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FC3_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movnti"));
    return_on_pagefault!(safe_write32(addr, read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr_0FC4(mut source: i32, mut r: i32, mut imm8: i32) -> () {
    c_comment!(("pinsrw mm, r32/m16, imm8"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut index: u32 = (imm8 & 3i32) as u32;
    destination.u16_0[index as usize] = (source & 65535i32) as u16;
    write_mmx_reg64(r, destination);
}
#[no_mangle]
pub unsafe fn instr_0FC4_reg(mut r1: i32, mut r2: i32, mut imm: i32) -> () {
    instr_0FC4(read_reg32(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_0FC4_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    instr_0FC4(return_on_pagefault!(safe_read16(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_660FC4(mut source: i32, mut r: i32, mut imm8: i32) -> () {
    c_comment!(("pinsrw xmm, r32/m16, imm8"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut index: u32 = (imm8 & 7i32) as u32;
    destination.u16_0[index as usize] = (source & 65535i32) as u16;
    write_xmm_reg128(r, destination);
}
#[no_mangle]
pub unsafe fn instr_660FC4_reg(mut r1: i32, mut r2: i32, mut imm: i32) -> () {
    instr_660FC4(read_reg32(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_660FC4_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    instr_660FC4(return_on_pagefault!(safe_read16(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_0FC5_mem(mut addr: i32, mut r: i32, mut imm8: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FC5_reg(mut r1: i32, mut r2: i32, mut imm8: i32) -> () {
    c_comment!(("pextrw r32, mm, imm8"));
    let mut data: reg64 = read_mmx64s(r1);
    let mut index: u32 = (imm8 & 3i32) as u32;
    let mut result: u32 = data.u16_0[index as usize] as u32;
    write_reg32(r2, result as i32);
}
#[no_mangle]
pub unsafe fn instr_660FC5_mem(mut addr: i32, mut r: i32, mut imm8: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FC5_reg(mut r1: i32, mut r2: i32, mut imm8: i32) -> () {
    c_comment!(("pextrw r32, xmm, imm8"));
    let mut data: reg128 = read_xmm128s(r1);
    let mut index: u32 = (imm8 & 7i32) as u32;
    let mut result: u32 = data.u16_0[index as usize] as u32;
    write_reg32(r2, result as i32);
}
#[no_mangle]
pub unsafe fn instr_0FC6() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0FC7_1_reg(mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FC7_1_mem(mut addr: i32) -> () {
    c_comment!(("cmpxchg8b"));
    return_on_pagefault!(writable_or_pagefault(addr, 8i32));
    let mut m64_low: i32 = return_on_pagefault!(safe_read32s(addr));
    let mut m64_high: i32 = return_on_pagefault!(safe_read32s(addr + 4i32));
    if *reg32s.offset(EAX as isize) == m64_low && *reg32s.offset(EDX as isize) == m64_high {
        let ref mut fresh2 = *flags.offset(0isize);
        *fresh2 |= FLAG_ZERO;
        safe_write32(addr, *reg32s.offset(EBX as isize)).unwrap();
        safe_write32(addr + 4i32, *reg32s.offset(ECX as isize)).unwrap();
    }
    else {
        let ref mut fresh3 = *flags.offset(0isize);
        *fresh3 &= !FLAG_ZERO;
        *reg32s.offset(EAX as isize) = m64_low;
        *reg32s.offset(EDX as isize) = m64_high;
        safe_write32(addr, m64_low).unwrap();
        safe_write32(addr + 4i32, m64_high).unwrap();
    }
    let ref mut fresh4 = *flags_changed.offset(0isize);
    *fresh4 &= !FLAG_ZERO;
}
#[no_mangle]
pub unsafe fn instr_0FC7_6_reg(mut r: i32) -> () {
    c_comment!(("rdrand"));
    let mut has_rand: i32 = has_rand_int() as i32;
    let mut rand: i32 = 0i32;
    if 0 != has_rand {
        rand = get_rand_int()
    }
    write_reg_osize(r, rand);
    let ref mut fresh5 = *flags.offset(0isize);
    *fresh5 &= !FLAGS_ALL;
    let ref mut fresh6 = *flags.offset(0isize);
    *fresh6 |= has_rand;
    *flags_changed.offset(0isize) = 0i32;
}
#[no_mangle]
pub unsafe fn instr_0FC7_6_mem(mut addr: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FC8() -> () { bswap(EAX); }
#[no_mangle]
pub unsafe fn instr_0FC9() -> () { bswap(ECX); }
#[no_mangle]
pub unsafe fn instr_0FCA() -> () { bswap(EDX); }
#[no_mangle]
pub unsafe fn instr_0FCB() -> () { bswap(EBX); }
#[no_mangle]
pub unsafe fn instr_0FCC() -> () { bswap(ESP); }
#[no_mangle]
pub unsafe fn instr_0FCD() -> () { bswap(EBP); }
#[no_mangle]
pub unsafe fn instr_0FCE() -> () { bswap(ESI); }
#[no_mangle]
pub unsafe fn instr_0FCF() -> () { bswap(EDI); }
#[no_mangle]
pub unsafe fn instr_0FD0() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0FD1(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psrlw mm, mm/m64"));
    psrlw_r64(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_0FD1_reg(mut r1: i32, mut r2: i32) -> () { instr_0FD1(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD1_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FD1(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD1(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psrlw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    psrlw_r128(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_660FD1_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FD1(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FD1_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FD1(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD2(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psrld mm, mm/m64"));
    psrld_r64(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_0FD2_reg(mut r1: i32, mut r2: i32) -> () { instr_0FD2(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD2_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FD2(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD2(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psrld xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    psrld_r128(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_660FD2_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FD2(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FD2_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FD2(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD3(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psrlq mm, mm/m64"));
    psrlq_r64(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_0FD3_reg(mut r1: i32, mut r2: i32) -> () { instr_0FD3(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD3_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FD3(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD3(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psrlq xmm, mm/m64"));
    psrlq_r128(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_660FD3_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FD3(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FD3_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FD3(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD4(mut source: reg64, mut r: i32) -> () {
    c_comment!(("paddq mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    destination.u64_0[0usize] =
        (destination.u64_0[0usize] as u64).wrapping_add(source.u64_0[0usize]) as u64 as u64;
    write_mmx_reg64(r, destination);
}
#[no_mangle]
pub unsafe fn instr_0FD4_reg(mut r1: i32, mut r2: i32) -> () { instr_0FD4(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD4_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FD4(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD4(mut source: reg128, mut r: i32) -> () {
    c_comment!(("paddq xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    destination.u64_0[0usize] =
        (destination.u64_0[0usize] as u64).wrapping_add(source.u64_0[0usize]) as u64 as u64;
    destination.u64_0[1usize] =
        (destination.u64_0[1usize] as u64).wrapping_add(source.u64_0[1usize]) as u64 as u64;
    write_xmm_reg128(r, destination);
}
#[no_mangle]
pub unsafe fn instr_660FD4_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FD4(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FD4_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FD4(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD5(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pmullw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: i32 = destination.u16_0[0usize] as i32 * source.u16_0[0usize] as i32 & 65535i32;
    let mut word1: i32 = destination.u16_0[1usize] as i32 * source.u16_0[1usize] as i32 & 65535i32;
    let mut word2: i32 = destination.u16_0[2usize] as i32 * source.u16_0[2usize] as i32 & 65535i32;
    let mut word3: i32 = destination.u16_0[3usize] as i32 * source.u16_0[3usize] as i32 & 65535i32;
    let mut low: i32 = word0 | word1 << 16i32;
    let mut high: i32 = word2 | word3 << 16i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0FD5_reg(mut r1: i32, mut r2: i32) -> () { instr_0FD5(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD5_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FD5(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD5(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pmullw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        source.u16_0[0usize] as i32 * destination.u16_0[0usize] as i32 & 65535i32
            | (source.u16_0[1usize] as i32 * destination.u16_0[1usize] as i32) << 16i32,
        source.u16_0[2usize] as i32 * destination.u16_0[2usize] as i32 & 65535i32
            | (source.u16_0[3usize] as i32 * destination.u16_0[3usize] as i32) << 16i32,
        source.u16_0[4usize] as i32 * destination.u16_0[4usize] as i32 & 65535i32
            | (source.u16_0[5usize] as i32 * destination.u16_0[5usize] as i32) << 16i32,
        source.u16_0[6usize] as i32 * destination.u16_0[6usize] as i32 & 65535i32
            | (source.u16_0[7usize] as i32 * destination.u16_0[7usize] as i32) << 16i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660FD5_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FD5(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FD5_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FD5(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD6_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FD6_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FD6_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movq xmm/m64, xmm"));
    movl_r128_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_660FD6_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movq xmm/m64, xmm"));
    let mut data: reg64 = read_xmm64s(r2);
    write_xmm128(
        r1,
        data.u32_0[0usize] as i32,
        data.u32_0[1usize] as i32,
        0i32,
        0i32,
    );
}
#[no_mangle]
pub unsafe fn instr_F20FD6_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_F20FD6_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movdq2q mm, xmm"));
    let mut source: reg128 = read_xmm128s(r1);
    write_mmx64(r2, source.u32_0[0usize] as i32, source.u32_0[1usize] as i32);
}
#[no_mangle]
pub unsafe fn instr_F30FD6_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_F30FD6_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("movq2dq xmm, mm"));
    let mut source: reg64 = read_mmx64s(r1);
    write_xmm128(
        r2,
        source.u32_0[0usize] as i32,
        source.u32_0[1usize] as i32,
        0i32,
        0i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0FD7_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FD7_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("pmovmskb r, mm"));
    let mut x: reg64 = read_mmx64s(r1);
    let mut result: u32 = (x.u8_0[0usize] as i32 >> 7i32 << 0i32
        | x.u8_0[1usize] as i32 >> 7i32 << 1i32
        | x.u8_0[2usize] as i32 >> 7i32 << 2i32
        | x.u8_0[3usize] as i32 >> 7i32 << 3i32
        | x.u8_0[4usize] as i32 >> 7i32 << 4i32
        | x.u8_0[5usize] as i32 >> 7i32 << 5i32
        | x.u8_0[6usize] as i32 >> 7i32 << 6i32
        | x.u8_0[7usize] as i32 >> 7i32 << 7i32) as u32;
    write_reg32(r2, result as i32);
}
#[no_mangle]
pub unsafe fn instr_660FD7_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FD7_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("pmovmskb reg, xmm"));
    let mut x: reg128 = read_xmm128s(r1);
    let mut result: i32 = x.u8_0[0usize] as i32 >> 7i32 << 0i32
        | x.u8_0[1usize] as i32 >> 7i32 << 1i32
        | x.u8_0[2usize] as i32 >> 7i32 << 2i32
        | x.u8_0[3usize] as i32 >> 7i32 << 3i32
        | x.u8_0[4usize] as i32 >> 7i32 << 4i32
        | x.u8_0[5usize] as i32 >> 7i32 << 5i32
        | x.u8_0[6usize] as i32 >> 7i32 << 6i32
        | x.u8_0[7usize] as i32 >> 7i32 << 7i32
        | x.u8_0[8usize] as i32 >> 7i32 << 8i32
        | x.u8_0[9usize] as i32 >> 7i32 << 9i32
        | x.u8_0[10usize] as i32 >> 7i32 << 10i32
        | x.u8_0[11usize] as i32 >> 7i32 << 11i32
        | x.u8_0[12usize] as i32 >> 7i32 << 12i32
        | x.u8_0[13usize] as i32 >> 7i32 << 13i32
        | x.u8_0[14usize] as i32 >> 7i32 << 14i32
        | x.u8_0[15usize] as i32 >> 7i32 << 15i32;
    write_reg32(r2, result);
}
#[no_mangle]
pub unsafe fn instr_0FD8(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psubusb mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u8_0[i as usize] =
            saturate_sd_to_ub(destination.u8_0[i as usize] as i32 - source.u8_0[i as usize] as i32)
                as u8;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FD8_reg(mut r1: i32, mut r2: i32) -> () { instr_0FD8(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD8_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FD8(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD8(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psubusb xmm, xmm/m128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: u32 = 0i32 as u32;
    while i < 16i32 as u32 {
        result.u8_0[i as usize] =
            saturate_sd_to_ub(destination.u8_0[i as usize] as i32 - source.u8_0[i as usize] as i32)
                as u8;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FD8_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FD8(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FD8_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FD8(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD9(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psubusw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: i32 =
        saturate_uw((destination.u16_0[0usize] as i32 - source.u16_0[0usize] as i32) as u32);
    let mut word1: i32 =
        saturate_uw((destination.u16_0[1usize] as i32 - source.u16_0[1usize] as i32) as u32);
    let mut word2: i32 =
        saturate_uw((destination.u16_0[2usize] as i32 - source.u16_0[2usize] as i32) as u32);
    let mut word3: i32 =
        saturate_uw((destination.u16_0[3usize] as i32 - source.u16_0[3usize] as i32) as u32);
    let mut low: i32 = word0 | word1 << 16i32;
    let mut high: i32 = word2 | word3 << 16i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0FD9_reg(mut r1: i32, mut r2: i32) -> () { instr_0FD9(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FD9_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FD9(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD9(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psubusw xmm, xmm/m128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u16_0[i as usize] = saturate_uw(
            (destination.u16_0[i as usize] as i32 - source.u16_0[i as usize] as i32) as u32,
        ) as u16;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FD9_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FD9(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FD9_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FD9(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDA(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pminub mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 { i8_0: [0; 8] };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u8_0[i as usize] =
            (if (source.u8_0[i as usize] as i32) < destination.u8_0[i as usize] as i32 {
                source.u8_0[i as usize] as i32
            }
            else {
                destination.u8_0[i as usize] as i32
            }) as u8;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FDA_reg(mut r1: i32, mut r2: i32) -> () { instr_0FDA(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDA_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FDA(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDA(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pminub xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: u32 = 0i32 as u32;
    while i < 16i32 as u32 {
        result.u8_0[i as usize] =
            (if (source.u8_0[i as usize] as i32) < destination.u8_0[i as usize] as i32 {
                source.u8_0[i as usize] as i32
            }
            else {
                destination.u8_0[i as usize] as i32
            }) as u8;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FDA_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FDA(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FDA_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FDA(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDB(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pand mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] & destination.u64_0[0usize];
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FDB_reg(mut r1: i32, mut r2: i32) -> () { instr_0FDB(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDB_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FDB(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDB(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pand xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    pand_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660FDB_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FDB(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FDB_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FDB(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDC(mut source: reg64, mut r: i32) -> () {
    c_comment!(("paddusb mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u8_0[i as usize] = saturate_ud_to_ub(
            (destination.u8_0[i as usize] as i32 + source.u8_0[i as usize] as i32) as u32,
        ) as u8;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FDC_reg(mut r1: i32, mut r2: i32) -> () { instr_0FDC(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDC_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FDC(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDC(mut source: reg128, mut r: i32) -> () {
    c_comment!(("paddusb xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: u32 = 0i32 as u32;
    while i < 16i32 as u32 {
        result.u8_0[i as usize] = saturate_ud_to_ub(
            (source.u8_0[i as usize] as i32 + destination.u8_0[i as usize] as i32) as u32,
        ) as u8;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FDC_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FDC(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FDC_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FDC(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDD(mut source: reg64, mut r: i32) -> () {
    c_comment!(("paddusw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: i32 =
        saturate_uw((destination.u16_0[0usize] as i32 + source.u16_0[0usize] as i32) as u32);
    let mut word1: i32 =
        saturate_uw((destination.u16_0[1usize] as i32 + source.u16_0[1usize] as i32) as u32);
    let mut word2: i32 =
        saturate_uw((destination.u16_0[2usize] as i32 + source.u16_0[2usize] as i32) as u32);
    let mut word3: i32 =
        saturate_uw((destination.u16_0[3usize] as i32 + source.u16_0[3usize] as i32) as u32);
    let mut low: i32 = word0 | word1 << 16i32;
    let mut high: i32 = word2 | word3 << 16i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0FDD_reg(mut r1: i32, mut r2: i32) -> () { instr_0FDD(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDD_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FDD(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDD(mut source: reg128, mut r: i32) -> () {
    c_comment!(("paddusw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        saturate_uw((source.u16_0[0usize] as i32 + destination.u16_0[0usize] as i32) as u32)
            | saturate_uw((source.u16_0[1usize] as i32 + destination.u16_0[1usize] as i32) as u32)
                << 16i32,
        saturate_uw((source.u16_0[2usize] as i32 + destination.u16_0[2usize] as i32) as u32)
            | saturate_uw((source.u16_0[3usize] as i32 + destination.u16_0[3usize] as i32) as u32)
                << 16i32,
        saturate_uw((source.u16_0[4usize] as i32 + destination.u16_0[4usize] as i32) as u32)
            | saturate_uw((source.u16_0[5usize] as i32 + destination.u16_0[5usize] as i32) as u32)
                << 16i32,
        saturate_uw((source.u16_0[6usize] as i32 + destination.u16_0[6usize] as i32) as u32)
            | saturate_uw((source.u16_0[7usize] as i32 + destination.u16_0[7usize] as i32) as u32)
                << 16i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660FDD_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FDD(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FDD_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FDD(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDE(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pmaxub mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 { i8_0: [0; 8] };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u8_0[i as usize] =
            (if source.u8_0[i as usize] as i32 > destination.u8_0[i as usize] as i32 {
                source.u8_0[i as usize] as i32
            }
            else {
                destination.u8_0[i as usize] as i32
            }) as u8;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FDE_reg(mut r1: i32, mut r2: i32) -> () { instr_0FDE(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDE_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FDE(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDE(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pmaxub xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: u32 = 0i32 as u32;
    while i < 16i32 as u32 {
        result.u8_0[i as usize] =
            (if source.u8_0[i as usize] as i32 > destination.u8_0[i as usize] as i32 {
                source.u8_0[i as usize] as i32
            }
            else {
                destination.u8_0[i as usize] as i32
            }) as u8;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FDE_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FDE(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FDE_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FDE(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDF(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pandn mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] & !destination.u64_0[0usize];
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FDF_reg(mut r1: i32, mut r2: i32) -> () { instr_0FDF(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FDF_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FDF(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDF(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pandn xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    pandn_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660FDF_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FDF(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FDF_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FDF(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE0(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pavgb mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u8_0[i as usize] =
            (destination.u8_0[i as usize] as i32 + source.u8_0[i as usize] as i32 + 1i32 >> 1i32)
                as u8;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FE0_reg(mut r1: i32, mut r2: i32) -> () { instr_0FE0(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE0_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FE0(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE0(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pavgb xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: u32 = 0i32 as u32;
    while i < 16i32 as u32 {
        result.u8_0[i as usize] =
            (destination.u8_0[i as usize] as i32 + source.u8_0[i as usize] as i32 + 1i32 >> 1i32)
                as u8;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FE0_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FE0(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FE0_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FE0(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE1(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psraw mm, mm/m64"));
    psraw_r64(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_0FE1_reg(mut r1: i32, mut r2: i32) -> () { instr_0FE1(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE1_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FE1(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE1(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psraw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    psraw_r128(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_660FE1_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FE1(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FE1_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FE1(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE2(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psrad mm, mm/m64"));
    psrad_r64(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_0FE2_reg(mut r1: i32, mut r2: i32) -> () { instr_0FE2(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE2_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FE2(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE2(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psrad xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    psrad_r128(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_660FE2_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FE2(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FE2_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FE2(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE3(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pavgw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    destination.u16_0[0usize] =
        (destination.u16_0[0usize] as i32 + source.u16_0[0usize] as i32 + 1i32 >> 1i32) as u16;
    destination.u16_0[1usize] =
        (destination.u16_0[1usize] as i32 + source.u16_0[1usize] as i32 + 1i32 >> 1i32) as u16;
    destination.u16_0[2usize] =
        (destination.u16_0[2usize] as i32 + source.u16_0[2usize] as i32 + 1i32 >> 1i32) as u16;
    destination.u16_0[3usize] =
        (destination.u16_0[3usize] as i32 + source.u16_0[3usize] as i32 + 1i32 >> 1i32) as u16;
    write_mmx_reg64(r, destination);
}
#[no_mangle]
pub unsafe fn instr_0FE3_reg(mut r1: i32, mut r2: i32) -> () { instr_0FE3(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE3_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FE3(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE3(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pavgw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    destination.u16_0[0usize] =
        (destination.u16_0[0usize] as i32 + source.u16_0[0usize] as i32 + 1i32 >> 1i32) as u16;
    destination.u16_0[1usize] =
        (destination.u16_0[1usize] as i32 + source.u16_0[1usize] as i32 + 1i32 >> 1i32) as u16;
    destination.u16_0[2usize] =
        (destination.u16_0[2usize] as i32 + source.u16_0[2usize] as i32 + 1i32 >> 1i32) as u16;
    destination.u16_0[3usize] =
        (destination.u16_0[3usize] as i32 + source.u16_0[3usize] as i32 + 1i32 >> 1i32) as u16;
    destination.u16_0[4usize] =
        (destination.u16_0[4usize] as i32 + source.u16_0[4usize] as i32 + 1i32 >> 1i32) as u16;
    destination.u16_0[5usize] =
        (destination.u16_0[5usize] as i32 + source.u16_0[5usize] as i32 + 1i32 >> 1i32) as u16;
    destination.u16_0[6usize] =
        (destination.u16_0[6usize] as i32 + source.u16_0[6usize] as i32 + 1i32 >> 1i32) as u16;
    destination.u16_0[7usize] =
        (destination.u16_0[7usize] as i32 + source.u16_0[7usize] as i32 + 1i32 >> 1i32) as u16;
    write_xmm_reg128(r, destination);
}
#[no_mangle]
pub unsafe fn instr_660FE3_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FE3(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FE3_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FE3(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE4(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pmulhuw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    write_mmx64(
        r,
        ((source.u16_0[0usize] as i32 * destination.u16_0[0usize] as i32 >> 16i32 & 65535i32)
            as u32
            | (source.u16_0[1usize] as i32 * destination.u16_0[1usize] as i32) as u32
                & 4294901760u32) as i32,
        ((source.u16_0[2usize] as i32 * destination.u16_0[2usize] as i32 >> 16i32 & 65535i32)
            as u32
            | (source.u16_0[3usize] as i32 * destination.u16_0[3usize] as i32) as u32
                & 4294901760u32) as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0FE4_reg(mut r1: i32, mut r2: i32) -> () { instr_0FE4(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE4_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FE4(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE4(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pmulhuw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        ((source.u16_0[0usize] as i32 * destination.u16_0[0usize] as i32 >> 16i32 & 65535i32)
            as u32
            | (source.u16_0[1usize] as i32 * destination.u16_0[1usize] as i32) as u32
                & 4294901760u32) as i32,
        ((source.u16_0[2usize] as i32 * destination.u16_0[2usize] as i32 >> 16i32 & 65535i32)
            as u32
            | (source.u16_0[3usize] as i32 * destination.u16_0[3usize] as i32) as u32
                & 4294901760u32) as i32,
        ((source.u16_0[4usize] as i32 * destination.u16_0[4usize] as i32 >> 16i32 & 65535i32)
            as u32
            | (source.u16_0[5usize] as i32 * destination.u16_0[5usize] as i32) as u32
                & 4294901760u32) as i32,
        ((source.u16_0[6usize] as i32 * destination.u16_0[6usize] as i32 >> 16i32 & 65535i32)
            as u32
            | (source.u16_0[7usize] as i32 * destination.u16_0[7usize] as i32) as u32
                & 4294901760u32) as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660FE4_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FE4(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FE4_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FE4(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE5(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pmulhw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: u32 =
        (destination.i16_0[0usize] as i32 * source.i16_0[0usize] as i32 >> 16i32 & 65535i32) as u32;
    let mut word1: u32 =
        (destination.i16_0[1usize] as i32 * source.i16_0[1usize] as i32 >> 16i32 & 65535i32) as u32;
    let mut word2: u32 =
        (destination.i16_0[2usize] as i32 * source.i16_0[2usize] as i32 >> 16i32 & 65535i32) as u32;
    let mut word3: u32 =
        (destination.i16_0[3usize] as i32 * source.i16_0[3usize] as i32 >> 16i32 & 65535i32) as u32;
    let mut low: i32 = (word0 | word1 << 16i32) as i32;
    let mut high: i32 = (word2 | word3 << 16i32) as i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0FE5_reg(mut r1: i32, mut r2: i32) -> () { instr_0FE5(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE5_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FE5(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE5(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pmulhw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = ((destination.i16_0[0usize] as i32 * source.i16_0[0usize] as i32 >> 16i32
        & 65535i32) as u32
        | (destination.i16_0[1usize] as i32 * source.i16_0[1usize] as i32) as u32 & 4294901760u32)
        as i32;
    let mut dword1: i32 = ((destination.i16_0[2usize] as i32 * source.i16_0[2usize] as i32 >> 16i32
        & 65535i32) as u32
        | (destination.i16_0[3usize] as i32 * source.i16_0[3usize] as i32) as u32 & 4294901760u32)
        as i32;
    let mut dword2: i32 = ((destination.i16_0[4usize] as i32 * source.i16_0[4usize] as i32 >> 16i32
        & 65535i32) as u32
        | (destination.i16_0[5usize] as i32 * source.i16_0[5usize] as i32) as u32 & 4294901760u32)
        as i32;
    let mut dword3: i32 = ((destination.i16_0[6usize] as i32 * source.i16_0[6usize] as i32 >> 16i32
        & 65535i32) as u32
        | (destination.i16_0[7usize] as i32 * source.i16_0[7usize] as i32) as u32 & 4294901760u32)
        as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660FE5_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FE5(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FE5_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FE5(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE6_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FE6_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FE6_mem(mut addr: i32, mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_660FE6_reg(mut r1: i32, mut r2: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F20FE6_mem(mut addr: i32, mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F20FE6_reg(mut r1: i32, mut r2: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F30FE6_mem(mut addr: i32, mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F30FE6_reg(mut r1: i32, mut r2: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0FE7_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movntq m64, mm"));
    mov_r_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0FE7_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FE7_reg(mut r1: i32, mut r2: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FE7_mem(mut addr: i32, mut r: i32) -> () {
    c_comment!(("movntdq m128, xmm"));
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0FE8(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psubsb mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u8_0[i as usize] = saturate_sd_to_sb(
            (destination.i8_0[i as usize] as i32 - source.i8_0[i as usize] as i32) as u32,
        ) as u8;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FE8_reg(mut r1: i32, mut r2: i32) -> () { instr_0FE8(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE8_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FE8(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE8(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psubsb xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: u32 = 0i32 as u32;
    while i < 16i32 as u32 {
        result.i8_0[i as usize] = saturate_sd_to_sb(
            (destination.i8_0[i as usize] as i32 - source.i8_0[i as usize] as i32) as u32,
        ) as i8;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FE8_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FE8(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FE8_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FE8(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE9(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psubsw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: i32 =
        saturate_sd_to_sw((destination.i16_0[0usize] as i32 - source.i16_0[0usize] as i32) as u32)
            as i32;
    let mut word1: i32 =
        saturate_sd_to_sw((destination.i16_0[1usize] as i32 - source.i16_0[1usize] as i32) as u32)
            as i32;
    let mut word2: i32 =
        saturate_sd_to_sw((destination.i16_0[2usize] as i32 - source.i16_0[2usize] as i32) as u32)
            as i32;
    let mut word3: i32 =
        saturate_sd_to_sw((destination.i16_0[3usize] as i32 - source.i16_0[3usize] as i32) as u32)
            as i32;
    let mut low: i32 = word0 | word1 << 16i32;
    let mut high: i32 = word2 | word3 << 16i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0FE9_reg(mut r1: i32, mut r2: i32) -> () { instr_0FE9(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FE9_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FE9(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE9(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psubsw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 =
        (saturate_sd_to_sw((destination.i16_0[0usize] as i32 - source.i16_0[0usize] as i32) as u32)
            | saturate_sd_to_sw(
                (destination.i16_0[1usize] as i32 - source.i16_0[1usize] as i32) as u32,
            ) << 16i32) as i32;
    let mut dword1: i32 =
        (saturate_sd_to_sw((destination.i16_0[2usize] as i32 - source.i16_0[2usize] as i32) as u32)
            | saturate_sd_to_sw(
                (destination.i16_0[3usize] as i32 - source.i16_0[3usize] as i32) as u32,
            ) << 16i32) as i32;
    let mut dword2: i32 =
        (saturate_sd_to_sw((destination.i16_0[4usize] as i32 - source.i16_0[4usize] as i32) as u32)
            | saturate_sd_to_sw(
                (destination.i16_0[5usize] as i32 - source.i16_0[5usize] as i32) as u32,
            ) << 16i32) as i32;
    let mut dword3: i32 =
        (saturate_sd_to_sw((destination.i16_0[6usize] as i32 - source.i16_0[6usize] as i32) as u32)
            | saturate_sd_to_sw(
                (destination.i16_0[7usize] as i32 - source.i16_0[7usize] as i32) as u32,
            ) << 16i32) as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660FE9_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FE9(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FE9_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FE9(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEA(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pminsw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 { i8_0: [0; 8] };
    let mut i: u32 = 0i32 as u32;
    while i < 4i32 as u32 {
        result.i16_0[i as usize] =
            (if (destination.i16_0[i as usize] as i32) < source.i16_0[i as usize] as i32 {
                destination.i16_0[i as usize] as i32
            }
            else {
                source.i16_0[i as usize] as i32
            }) as i16;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FEA_reg(mut r1: i32, mut r2: i32) -> () { instr_0FEA(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FEA_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FEA(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEA(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pminsw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.i16_0[i as usize] =
            (if (destination.i16_0[i as usize] as i32) < source.i16_0[i as usize] as i32 {
                destination.i16_0[i as usize] as i32
            }
            else {
                source.i16_0[i as usize] as i32
            }) as i16;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FEA_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FEA(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FEA_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FEA(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEB(mut source: reg64, mut r: i32) -> () {
    c_comment!(("por mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] | destination.u64_0[0usize];
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FEB_reg(mut r1: i32, mut r2: i32) -> () { instr_0FEB(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FEB_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FEB(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEB(mut source: reg128, mut r: i32) -> () {
    c_comment!(("por xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    por_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660FEB_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FEB(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FEB_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FEB(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEC(mut source: reg64, mut r: i32) -> () {
    c_comment!(("paddsb mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u8_0[i as usize] = saturate_sd_to_sb(
            (destination.i8_0[i as usize] as i32 + source.i8_0[i as usize] as i32) as u32,
        ) as u8;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FEC_reg(mut r1: i32, mut r2: i32) -> () { instr_0FEC(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FEC_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FEC(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEC(mut source: reg128, mut r: i32) -> () {
    c_comment!(("paddsb xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: u32 = 0i32 as u32;
    while i < 16i32 as u32 {
        result.i8_0[i as usize] = saturate_sd_to_sb(
            (destination.i8_0[i as usize] as i32 + source.i8_0[i as usize] as i32) as u32,
        ) as i8;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FEC_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FEC(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FEC_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FEC(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FED(mut source: reg64, mut r: i32) -> () {
    c_comment!(("paddsw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: i32 =
        saturate_sd_to_sw((destination.i16_0[0usize] as i32 + source.i16_0[0usize] as i32) as u32)
            as i32;
    let mut word1: i32 =
        saturate_sd_to_sw((destination.i16_0[1usize] as i32 + source.i16_0[1usize] as i32) as u32)
            as i32;
    let mut word2: i32 =
        saturate_sd_to_sw((destination.i16_0[2usize] as i32 + source.i16_0[2usize] as i32) as u32)
            as i32;
    let mut word3: i32 =
        saturate_sd_to_sw((destination.i16_0[3usize] as i32 + source.i16_0[3usize] as i32) as u32)
            as i32;
    let mut low: i32 = word0 | word1 << 16i32;
    let mut high: i32 = word2 | word3 << 16i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0FED_reg(mut r1: i32, mut r2: i32) -> () { instr_0FED(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FED_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FED(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FED(mut source: reg128, mut r: i32) -> () {
    c_comment!(("paddsw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 =
        (saturate_sd_to_sw((destination.i16_0[0usize] as i32 + source.i16_0[0usize] as i32) as u32)
            | saturate_sd_to_sw(
                (destination.i16_0[1usize] as i32 + source.i16_0[1usize] as i32) as u32,
            ) << 16i32) as i32;
    let mut dword1: i32 =
        (saturate_sd_to_sw((destination.i16_0[2usize] as i32 + source.i16_0[2usize] as i32) as u32)
            | saturate_sd_to_sw(
                (destination.i16_0[3usize] as i32 + source.i16_0[3usize] as i32) as u32,
            ) << 16i32) as i32;
    let mut dword2: i32 =
        (saturate_sd_to_sw((destination.i16_0[4usize] as i32 + source.i16_0[4usize] as i32) as u32)
            | saturate_sd_to_sw(
                (destination.i16_0[5usize] as i32 + source.i16_0[5usize] as i32) as u32,
            ) << 16i32) as i32;
    let mut dword3: i32 =
        (saturate_sd_to_sw((destination.i16_0[6usize] as i32 + source.i16_0[6usize] as i32) as u32)
            | saturate_sd_to_sw(
                (destination.i16_0[7usize] as i32 + source.i16_0[7usize] as i32) as u32,
            ) << 16i32) as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660FED_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FED(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FED_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FED(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEE(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pmaxsw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 { i8_0: [0; 8] };
    let mut i: u32 = 0i32 as u32;
    while i < 4i32 as u32 {
        result.i16_0[i as usize] =
            (if destination.i16_0[i as usize] as i32 >= source.i16_0[i as usize] as i32 {
                destination.i16_0[i as usize] as i32
            }
            else {
                source.i16_0[i as usize] as i32
            }) as i16;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FEE_reg(mut r1: i32, mut r2: i32) -> () { instr_0FEE(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FEE_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FEE(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEE(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pmaxsw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 { i8_0: [0; 16] };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.i16_0[i as usize] =
            (if destination.i16_0[i as usize] as i32 >= source.i16_0[i as usize] as i32 {
                destination.i16_0[i as usize] as i32
            }
            else {
                source.i16_0[i as usize] as i32
            }) as i16;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FEE_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FEE(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FEE_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FEE(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEF(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pxor mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    result.u64_0[0usize] = source.u64_0[0usize] ^ destination.u64_0[0usize];
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FEF_reg(mut r1: i32, mut r2: i32) -> () { instr_0FEF(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FEF_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FEF(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEF(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pxor xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    pxor_r128(source, r);
}
#[no_mangle]
pub unsafe fn instr_660FEF_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FEF(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FEF_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FEF(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF0() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0FF1(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psllw mm, mm/m64"));
    psllw_r64(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_0FF1_reg(mut r1: i32, mut r2: i32) -> () { instr_0FF1(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF1_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FF1(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF1(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psllw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    psllw_r128(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_660FF1_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FF1(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FF1_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FF1(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF2(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pslld mm, mm/m64"));
    pslld_r64(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_0FF2_reg(mut r1: i32, mut r2: i32) -> () { instr_0FF2(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF2_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FF2(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF2(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pslld xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    pslld_r128(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_660FF2_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FF2(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FF2_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FF2(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF3(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psllq mm, mm/m64"));
    psllq_r64(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_0FF3_reg(mut r1: i32, mut r2: i32) -> () { instr_0FF3(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF3_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FF3(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF3(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psllq xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    psllq_r128(r, source.u32_0[0usize]);
}
#[no_mangle]
pub unsafe fn instr_660FF3_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FF3(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FF3_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FF3(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF4(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pmuludq mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    destination.u64_0[0usize] =
        (source.u32_0[0usize] as u64).wrapping_mul(destination.u32_0[0usize] as u64);
    write_mmx_reg64(r, destination);
}
#[no_mangle]
pub unsafe fn instr_0FF4_reg(mut r1: i32, mut r2: i32) -> () { instr_0FF4(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF4_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FF4(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF4(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pmuludq xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    destination.u64_0[0usize] =
        (source.u32_0[0usize] as u64).wrapping_mul(destination.u32_0[0usize] as u64);
    destination.u64_0[1usize] =
        (source.u32_0[2usize] as u64).wrapping_mul(destination.u32_0[2usize] as u64);
    write_xmm_reg128(r, destination);
}
#[no_mangle]
pub unsafe fn instr_660FF4_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FF4(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FF4_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FF4(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF5(mut source: reg64, mut r: i32) -> () {
    c_comment!(("pmaddwd mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut mul0: i32 = destination.i16_0[0usize] as i32 * source.i16_0[0usize] as i32;
    let mut mul1: i32 = destination.i16_0[1usize] as i32 * source.i16_0[1usize] as i32;
    let mut mul2: i32 = destination.i16_0[2usize] as i32 * source.i16_0[2usize] as i32;
    let mut mul3: i32 = destination.i16_0[3usize] as i32 * source.i16_0[3usize] as i32;
    let mut low: i32 = mul0 + mul1;
    let mut high: i32 = mul2 + mul3;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0FF5_reg(mut r1: i32, mut r2: i32) -> () { instr_0FF5(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF5_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FF5(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF5(mut source: reg128, mut r: i32) -> () {
    c_comment!(("pmaddwd xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = destination.i16_0[0usize] as i32 * source.i16_0[0usize] as i32
        + destination.i16_0[1usize] as i32 * source.i16_0[1usize] as i32;
    let mut dword1: i32 = destination.i16_0[2usize] as i32 * source.i16_0[2usize] as i32
        + destination.i16_0[3usize] as i32 * source.i16_0[3usize] as i32;
    let mut dword2: i32 = destination.i16_0[4usize] as i32 * source.i16_0[4usize] as i32
        + destination.i16_0[5usize] as i32 * source.i16_0[5usize] as i32;
    let mut dword3: i32 = destination.i16_0[6usize] as i32 * source.i16_0[6usize] as i32
        + destination.i16_0[7usize] as i32 * source.i16_0[7usize] as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660FF5_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FF5(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FF5_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FF5(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF6(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psadbw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut sum: u32 = 0i32 as u32;
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        sum = (sum as u32).wrapping_add(
            (destination.u8_0[i as usize] as i32 - source.u8_0[i as usize] as i32).abs() as u32,
        ) as u32 as u32;
        i = i.wrapping_add(1)
    }
    write_mmx64(r, sum as i32, 0i32);
}
#[no_mangle]
pub unsafe fn instr_0FF6_reg(mut r1: i32, mut r2: i32) -> () { instr_0FF6(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF6_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FF6(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF6(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psadbw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut sum0: u32 = 0i32 as u32;
    let mut sum1: u32 = 0i32 as u32;
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        sum0 = (sum0 as u32).wrapping_add(
            (destination.u8_0[i as usize] as i32 - source.u8_0[i as usize] as i32).abs() as u32,
        ) as u32 as u32;
        sum1 = (sum1 as u32).wrapping_add(
            (destination.u8_0[i.wrapping_add(8i32 as u32) as usize] as i32
                - source.u8_0[i.wrapping_add(8i32 as u32) as usize] as i32)
                .abs() as u32,
        ) as u32 as u32;
        i = i.wrapping_add(1)
    }
    write_xmm128(r, sum0 as i32, 0i32, sum1 as i32, 0i32);
}
#[no_mangle]
pub unsafe fn instr_660FF6_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FF6(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FF6_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FF6(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF7_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FF7_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("maskmovq mm, mm"));
    let mut source: reg64 = read_mmx64s(r2);
    let mut mask: reg64 = read_mmx64s(r1);
    let mut addr: i32 = get_seg_prefix(DS) + get_reg_asize(EDI);
    return_on_pagefault!(writable_or_pagefault(addr, 8i32));
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        if 0 != mask.u8_0[i as usize] as i32 & 128i32 {
            safe_write8(
                (addr as u32).wrapping_add(i) as i32,
                source.u8_0[i as usize] as i32,
            ).unwrap();
        }
        i = i.wrapping_add(1)
    }
}
#[no_mangle]
pub unsafe fn instr_660FF7_mem(mut addr: i32, mut r: i32) -> () { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FF7_reg(mut r1: i32, mut r2: i32) -> () {
    c_comment!(("maskmovdqu xmm, xmm"));
    let mut source: reg128 = read_xmm128s(r2);
    let mut mask: reg128 = read_xmm128s(r1);
    let mut addr: i32 = get_seg_prefix(DS) + get_reg_asize(EDI);
    return_on_pagefault!(writable_or_pagefault(addr, 16i32));
    let mut i: u32 = 0i32 as u32;
    while i < 16i32 as u32 {
        if 0 != mask.u8_0[i as usize] as i32 & 128i32 {
            safe_write8(
                (addr as u32).wrapping_add(i) as i32,
                source.u8_0[i as usize] as i32,
            ).unwrap();
        }
        i = i.wrapping_add(1)
    }
}
#[no_mangle]
pub unsafe fn instr_0FF8(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psubb mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u8_0[i as usize] =
            (destination.i8_0[i as usize] as i32 - source.i8_0[i as usize] as i32 & 255i32) as u8;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FF8_reg(mut r1: i32, mut r2: i32) -> () { instr_0FF8(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF8_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FF8(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF8(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psubb xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 16i32 as u32 {
        result.i8_0[i as usize] =
            (destination.i8_0[i as usize] as i32 - source.i8_0[i as usize] as i32 & 255i32) as i8;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FF8_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FF8(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FF8_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FF8(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF9(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psubw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: i32 =
        (destination.u32_0[0usize].wrapping_sub(source.u32_0[0usize]) & 65535i32 as u32) as i32;
    let mut word1: i32 = ((destination.u16_0[1usize] as u32)
        .wrapping_sub(source.u16_0[1usize] as u32)
        & 65535i32 as u32) as i32;
    let mut low: i32 = word0 | word1 << 16i32;
    let mut word2: i32 =
        (destination.u32_0[1usize].wrapping_sub(source.u32_0[1usize]) & 65535i32 as u32) as i32;
    let mut word3: i32 = ((destination.u16_0[3usize] as u32)
        .wrapping_sub(source.u16_0[3usize] as u32)
        & 65535i32 as u32) as i32;
    let mut high: i32 = word2 | word3 << 16i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0FF9_reg(mut r1: i32, mut r2: i32) -> () { instr_0FF9(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FF9_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FF9(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF9(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psubw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.i16_0[i as usize] = (destination.i16_0[i as usize] as i32
            - source.i16_0[i as usize] as i32
            & 65535i32) as i16;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FF9_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FF9(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FF9_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FF9(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFA(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psubd mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    write_mmx64(
        r,
        destination.u32_0[0usize].wrapping_sub(source.u32_0[0usize]) as i32,
        destination.u32_0[1usize].wrapping_sub(source.u32_0[1usize]) as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_0FFA_reg(mut r1: i32, mut r2: i32) -> () { instr_0FFA(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FFA_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FFA(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFA(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psubd xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32_0[0usize].wrapping_sub(source.u32_0[0usize]) as i32,
        destination.u32_0[1usize].wrapping_sub(source.u32_0[1usize]) as i32,
        destination.u32_0[2usize].wrapping_sub(source.u32_0[2usize]) as i32,
        destination.u32_0[3usize].wrapping_sub(source.u32_0[3usize]) as i32,
    );
}
#[no_mangle]
pub unsafe fn instr_660FFA_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FFA(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FFA_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FFA(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFB(mut source: reg64, mut r: i32) -> () {
    c_comment!(("psubq mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    destination.u64_0[0usize] = destination.u64_0[0usize].wrapping_sub(source.u64_0[0usize]);
    write_mmx_reg64(r, destination);
}
#[no_mangle]
pub unsafe fn instr_0FFB_reg(mut r1: i32, mut r2: i32) -> () { instr_0FFB(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FFB_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FFB(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFB(mut source: reg128, mut r: i32) -> () {
    c_comment!(("psubq xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    destination.u64_0[0usize] = destination.u64_0[0usize].wrapping_sub(source.u64_0[0usize]);
    destination.u64_0[1usize] = destination.u64_0[1usize].wrapping_sub(source.u64_0[1usize]);
    write_xmm_reg128(r, destination);
}
#[no_mangle]
pub unsafe fn instr_660FFB_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FFB(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FFB_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FFB(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFC(mut source: reg64, mut r: i32) -> () {
    c_comment!(("paddb mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut result: reg64 = reg64 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u8_0[i as usize] =
            (destination.u8_0[i as usize] as i32 + source.u8_0[i as usize] as i32 & 255i32) as u8;
        i = i.wrapping_add(1)
    }
    write_mmx_reg64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FFC_reg(mut r1: i32, mut r2: i32) -> () { instr_0FFC(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FFC_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FFC(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFC(mut source: reg128, mut r: i32) -> () {
    c_comment!(("paddb xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 16i32 as u32 {
        result.u8_0[i as usize] =
            (destination.u8_0[i as usize] as i32 + source.u8_0[i as usize] as i32 & 255i32) as u8;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FFC_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FFC(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FFC_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FFC(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFD(mut source: reg64, mut r: i32) -> () {
    c_comment!(("paddw mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut word0: i32 =
        (destination.u32_0[0usize].wrapping_add(source.u32_0[0usize]) & 65535i32 as u32) as i32;
    let mut word1: i32 = destination.u16_0[1usize] as i32 + source.u16_0[1usize] as i32 & 65535i32;
    let mut low: i32 = word0 | word1 << 16i32;
    let mut word2: i32 =
        (destination.u32_0[1usize].wrapping_add(source.u32_0[1usize]) & 65535i32 as u32) as i32;
    let mut word3: i32 = destination.u16_0[3usize] as i32 + source.u16_0[3usize] as i32 & 65535i32;
    let mut high: i32 = word2 | word3 << 16i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0FFD_reg(mut r1: i32, mut r2: i32) -> () { instr_0FFD(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FFD_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FFD(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFD(mut source: reg128, mut r: i32) -> () {
    c_comment!(("paddw xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i8_0: [0i32 as i8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    let mut i: u32 = 0i32 as u32;
    while i < 8i32 as u32 {
        result.u16_0[i as usize] = (destination.u16_0[i as usize] as i32
            + source.u16_0[i as usize] as i32
            & 65535i32) as u16;
        i = i.wrapping_add(1)
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FFD_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FFD(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FFD_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FFD(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFE(mut source: reg64, mut r: i32) -> () {
    c_comment!(("paddd mm, mm/m64"));
    let mut destination: reg64 = read_mmx64s(r);
    let mut low: i32 = destination.u32_0[0usize].wrapping_add(source.u32_0[0usize]) as i32;
    let mut high: i32 = destination.u32_0[1usize].wrapping_add(source.u32_0[1usize]) as i32;
    write_mmx64(r, low, high);
}
#[no_mangle]
pub unsafe fn instr_0FFE_reg(mut r1: i32, mut r2: i32) -> () { instr_0FFE(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0FFE_mem(mut addr: i32, mut r: i32) -> () {
    instr_0FFE(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFE(mut source: reg128, mut r: i32) -> () {
    c_comment!(("paddd xmm, xmm/m128"));
    c_comment!(("XXX: Aligned access or #gp"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut dword0: i32 = destination.u32_0[0usize].wrapping_add(source.u32_0[0usize]) as i32;
    let mut dword1: i32 = destination.u32_0[1usize].wrapping_add(source.u32_0[1usize]) as i32;
    let mut dword2: i32 = destination.u32_0[2usize].wrapping_add(source.u32_0[2usize]) as i32;
    let mut dword3: i32 = destination.u32_0[3usize].wrapping_add(source.u32_0[3usize]) as i32;
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
#[no_mangle]
pub unsafe fn instr_660FFE_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660FFE(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660FFE_mem(mut addr: i32, mut r: i32) -> () {
    instr_660FFE(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFF() -> () {
    c_comment!(("Windows 98"));
    dbg_log_c!("#ud: 0F FF");
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_F30F16() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F19_reg(mut r1: i32, mut r2: i32) -> () {}
#[no_mangle]
pub unsafe fn instr_0F19_mem(mut addr: i32, mut r: i32) -> () {}
#[no_mangle]
pub unsafe fn instr_0F1C_reg(mut r1: i32, mut r2: i32) -> () {}
#[no_mangle]
pub unsafe fn instr_0F1C_mem(mut addr: i32, mut r: i32) -> () {}
#[no_mangle]
pub unsafe fn instr_0F1D_reg(mut r1: i32, mut r2: i32) -> () {}
#[no_mangle]
pub unsafe fn instr_0F1D_mem(mut addr: i32, mut r: i32) -> () {}
#[no_mangle]
pub unsafe fn instr_0F1E_reg(mut r1: i32, mut r2: i32) -> () {}
#[no_mangle]
pub unsafe fn instr_0F1E_mem(mut addr: i32, mut r: i32) -> () {}
#[no_mangle]
pub unsafe fn instr_0F2A(mut source: reg64, mut r: i32) -> () {
    c_comment!(("cvtpi2ps xmm, mm/m64"));
    c_comment!((("XXX: The non-memory variant causes a transition from x87 FPU to MMX technology operation")));
    c_comment!(("Note: Casts here can fail"));
    let mut result: reg64 = reg64 {
        f32_0: [source.i32_0[0usize] as f32, source.i32_0[1usize] as f32],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F2A_reg(mut r1: i32, mut r2: i32) -> () { instr_0F2A(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F2A_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F2A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F2A(mut source: reg64, mut r: i32) -> () {
    c_comment!(("cvtpi2pd xmm, xmm/m64"));
    c_comment!((("XXX: The non-memory variant causes a transition from x87 FPU to MMX technology operation")));
    c_comment!(("These casts can\'t fail"));
    let mut result: reg128 = reg128 {
        f64_0: [source.i32_0[0usize] as f64, source.i32_0[1usize] as f64],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F2A_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F2A(read_mmx64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F2A_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F2A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F2A(mut source: i32, mut r: i32) -> () {
    c_comment!(("cvtsi2sd xmm, r32/m32"));
    c_comment!(("This cast can\'t fail"));
    let mut result: reg64 = reg64 {
        f64_0: [source as f64],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F2A_reg(mut r1: i32, mut r2: i32) -> () { instr_F20F2A(read_reg32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F2A_mem(mut addr: i32, mut r: i32) -> () {
    instr_F20F2A(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F2A(mut source: i32, mut r: i32) -> () {
    c_comment!(("cvtsi2ss xmm, r/m32"));
    c_comment!(("Note: This cast can fail"));
    let mut result: f32 = source as f32;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F2A_reg(mut r1: i32, mut r2: i32) -> () { instr_F30F2A(read_reg32(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F30F2A_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F2A(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F2D(mut source: reg64, mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F2D_reg(mut r1: i32, mut r2: i32) -> () { instr_0F2D(read_mmx64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F2D_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F2D(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F2D(mut source: reg128, mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_660F2D_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F2D(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F2D_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F2D(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F2D(mut source: reg64, mut r: i32) -> () {
    c_comment!(("cvtsd2si r32, xmm/m64"));
    write_reg32(r, sse_convert_f64_to_i32(source.f64_0[0usize]));
}
#[no_mangle]
pub unsafe fn instr_F20F2D_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F20F2D(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F20F2D_mem(mut addr: i32, mut r: i32) -> () {
    instr_F20F2D(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F2D(mut source: f32, mut r: i32) -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_F30F2D_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F2D(read_xmm_f32(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F30F2D_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F2D(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0F51(mut source: reg128, mut r: i32) -> () {
    c_comment!(("sqrtps xmm, xmm/mem128"));
    let mut result: reg128 = reg128 {
        f32_0: [
            source.f32_0[0usize].sqrt(),
            source.f32_0[1usize].sqrt(),
            source.f32_0[2usize].sqrt(),
            source.f32_0[3usize].sqrt(),
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F51_reg(mut r1: i32, mut r2: i32) -> () { instr_0F51(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F51_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F51(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F51(mut source: reg128, mut r: i32) -> () {
    c_comment!(("sqrtpd xmm, xmm/mem128"));
    let mut result: reg128 = reg128 {
        f64_0: [source.f64_0[0usize].sqrt(), source.f64_0[1usize].sqrt()],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F51_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F51(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F51_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F51(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F51(mut source: reg64, mut r: i32) -> () {
    c_comment!(("sqrtsd xmm, xmm/mem64"));
    let mut result: reg64 = reg64 {
        f64_0: [source.f64_0[0usize].sqrt()],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F51_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F20F51(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F20F51_mem(mut addr: i32, mut r: i32) -> () {
    instr_F20F51(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F51(mut source: f32, mut r: i32) -> () {
    c_comment!(("sqrtss xmm, xmm/mem32"));
    write_xmm_f32(r, source.sqrt());
}
#[no_mangle]
pub unsafe fn instr_F30F51_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F51(read_xmm_f32(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F30F51_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F51(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}

#[no_mangle]
pub unsafe fn instr_0F52(mut source: reg128, mut r: i32) -> () {
    c_comment!(("rcpps xmm1, xmm2/m128"));
    let mut result: reg128 = reg128 {
        f32_0: [
            1i32 as f32 / source.f32_0[0usize].sqrt(),
            1i32 as f32 / source.f32_0[1usize].sqrt(),
            1i32 as f32 / source.f32_0[2usize].sqrt(),
            1i32 as f32 / source.f32_0[3usize].sqrt(),
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F52_reg(mut r1: i32, mut r2: i32) -> () { instr_0F52(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F52_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F52(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F52(mut source: f32, mut r: i32) -> () {
    c_comment!(("rsqrtss xmm1, xmm2/m32"));
    write_xmm_f32(r, 1i32 as f32 / source.sqrt());
}
#[no_mangle]
pub unsafe fn instr_F30F52_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F52(read_xmm_f32(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F30F52_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F52(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}

#[no_mangle]
pub unsafe fn instr_0F53(mut source: reg128, mut r: i32) -> () {
    c_comment!(("rcpps xmm, xmm/m128"));
    let mut result: reg128 = reg128 {
        f32_0: [
            1i32 as f32 / source.f32_0[0usize],
            1i32 as f32 / source.f32_0[1usize],
            1i32 as f32 / source.f32_0[2usize],
            1i32 as f32 / source.f32_0[3usize],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F53_reg(mut r1: i32, mut r2: i32) -> () { instr_0F53(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F53_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F53(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F53(mut source: f32, mut r: i32) -> () {
    c_comment!(("rcpss xmm, xmm/m32"));
    write_xmm_f32(r, 1i32 as f32 / source);
}
#[no_mangle]
pub unsafe fn instr_F30F53_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F53(read_xmm_f32(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F30F53_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F53(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0F58(mut source: reg128, mut r: i32) -> () {
    c_comment!(("addps xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f32_0: [
            source.f32_0[0usize] + destination.f32_0[0usize],
            source.f32_0[1usize] + destination.f32_0[1usize],
            source.f32_0[2usize] + destination.f32_0[2usize],
            source.f32_0[3usize] + destination.f32_0[3usize],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F58_reg(mut r1: i32, mut r2: i32) -> () { instr_0F58(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F58_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F58(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F58(mut source: reg128, mut r: i32) -> () {
    c_comment!(("addpd xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f64_0: [
            source.f64_0[0usize] + destination.f64_0[0usize],
            source.f64_0[1usize] + destination.f64_0[1usize],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F58_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F58(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F58_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F58(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F58(mut source: reg64, mut r: i32) -> () {
    c_comment!(("addsd xmm, xmm/mem64"));
    let mut destination: reg64 = read_xmm64s(r);
    let mut result: reg64 = reg64 {
        f64_0: [source.f64_0[0usize] + destination.f64_0[0usize]],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F58_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F20F58(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F20F58_mem(mut addr: i32, mut r: i32) -> () {
    instr_F20F58(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F58(mut source: f32, mut r: i32) -> () {
    c_comment!(("addss xmm, xmm/mem32"));
    let mut destination: f32 = read_xmm_f32(r);
    let mut result: f32 = source + destination;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F58_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F58(read_xmm_f32(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F30F58_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F58(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0F59(mut source: reg128, mut r: i32) -> () {
    c_comment!(("mulps xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f32_0: [
            source.f32_0[0usize] * destination.f32_0[0usize],
            source.f32_0[1usize] * destination.f32_0[1usize],
            source.f32_0[2usize] * destination.f32_0[2usize],
            source.f32_0[3usize] * destination.f32_0[3usize],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F59_reg(mut r1: i32, mut r2: i32) -> () { instr_0F59(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F59_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F59(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F59(mut source: reg128, mut r: i32) -> () {
    c_comment!(("mulpd xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f64_0: [
            source.f64_0[0usize] * destination.f64_0[0usize],
            source.f64_0[1usize] * destination.f64_0[1usize],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F59_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F59(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F59_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F59(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F59(mut source: reg64, mut r: i32) -> () {
    c_comment!(("mulsd xmm, xmm/mem64"));
    let mut destination: reg64 = read_xmm64s(r);
    let mut result: reg64 = reg64 {
        f64_0: [source.f64_0[0usize] * destination.f64_0[0usize]],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F59_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F20F59(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F20F59_mem(mut addr: i32, mut r: i32) -> () {
    instr_F20F59(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F59(mut source: f32, mut r: i32) -> () {
    c_comment!(("mulss xmm, xmm/mem32"));
    let mut destination: f32 = read_xmm_f32(r);
    let mut result: f32 = source * destination;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F59_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F59(read_xmm_f32(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F30F59_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F59(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0F5A() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F5B() -> () { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0F5C(mut source: reg128, mut r: i32) -> () {
    c_comment!(("subps xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f32_0: [
            destination.f32_0[0usize] - source.f32_0[0usize],
            destination.f32_0[1usize] - source.f32_0[1usize],
            destination.f32_0[2usize] - source.f32_0[2usize],
            destination.f32_0[3usize] - source.f32_0[3usize],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F5C_reg(mut r1: i32, mut r2: i32) -> () { instr_0F5C(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F5C_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F5C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5C(mut source: reg128, mut r: i32) -> () {
    c_comment!(("subpd xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f64_0: [
            destination.f64_0[0usize] - source.f64_0[0usize],
            destination.f64_0[1usize] - source.f64_0[1usize],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F5C_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F5C(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F5C_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F5C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5C(mut source: reg64, mut r: i32) -> () {
    c_comment!(("subsd xmm, xmm/mem64"));
    let mut destination: reg64 = read_xmm64s(r);
    let mut result: reg64 = reg64 {
        f64_0: [destination.f64_0[0usize] - source.f64_0[0usize]],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F5C_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F20F5C(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F20F5C_mem(mut addr: i32, mut r: i32) -> () {
    instr_F20F5C(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5C(mut source: f32, mut r: i32) -> () {
    c_comment!(("subss xmm, xmm/mem32"));
    let mut destination: f32 = read_xmm_f32(r);
    let mut result: f32 = destination - source;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F5C_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F5C(read_xmm_f32(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F30F5C_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F5C(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0F5D(mut source: reg128, mut r: i32) -> () {
    c_comment!(("minps xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f32_0: [
            sse_min(
                destination.f32_0[0usize] as f64,
                source.f32_0[0usize] as f64,
            ) as f32,
            sse_min(
                destination.f32_0[1usize] as f64,
                source.f32_0[1usize] as f64,
            ) as f32,
            sse_min(
                destination.f32_0[2usize] as f64,
                source.f32_0[2usize] as f64,
            ) as f32,
            sse_min(
                destination.f32_0[3usize] as f64,
                source.f32_0[3usize] as f64,
            ) as f32,
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F5D_reg(mut r1: i32, mut r2: i32) -> () { instr_0F5D(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F5D_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F5D(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5D(mut source: reg128, mut r: i32) -> () {
    c_comment!(("minpd xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f64_0: [
            sse_min(destination.f64_0[0usize], source.f64_0[0usize]),
            sse_min(destination.f64_0[1usize], source.f64_0[1usize]),
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F5D_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F5D(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F5D_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F5D(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5D(mut source: reg64, mut r: i32) -> () {
    c_comment!(("minsd xmm, xmm/mem64"));
    let mut destination: reg64 = read_xmm64s(r);
    let mut result: reg64 = reg64 {
        f64_0: [sse_min(destination.f64_0[0usize], source.f64_0[0usize])],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F5D_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F20F5D(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F20F5D_mem(mut addr: i32, mut r: i32) -> () {
    instr_F20F5D(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5D(mut source: f32, mut r: i32) -> () {
    c_comment!(("minss xmm, xmm/mem32"));
    let mut destination: f32 = read_xmm_f32(r);
    let mut result: f32 = sse_min(destination as f64, source as f64) as f32;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F5D_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F5D(read_xmm_f32(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F30F5D_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F5D(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0F5E(mut source: reg128, mut r: i32) -> () {
    c_comment!(("divps xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f32_0: [
            destination.f32_0[0usize] / source.f32_0[0usize],
            destination.f32_0[1usize] / source.f32_0[1usize],
            destination.f32_0[2usize] / source.f32_0[2usize],
            destination.f32_0[3usize] / source.f32_0[3usize],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F5E_reg(mut r1: i32, mut r2: i32) -> () { instr_0F5E(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F5E_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F5E(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5E(mut source: reg128, mut r: i32) -> () {
    c_comment!(("divpd xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f64_0: [
            destination.f64_0[0usize] / source.f64_0[0usize],
            destination.f64_0[1usize] / source.f64_0[1usize],
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F5E_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F5E(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F5E_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F5E(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5E(mut source: reg64, mut r: i32) -> () {
    c_comment!(("divsd xmm, xmm/mem64"));
    let mut destination: reg64 = read_xmm64s(r);
    let mut result: reg64 = reg64 {
        f64_0: [destination.f64_0[0usize] / source.f64_0[0usize]],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F5E_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F20F5E(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F20F5E_mem(mut addr: i32, mut r: i32) -> () {
    instr_F20F5E(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5E(mut source: f32, mut r: i32) -> () {
    c_comment!(("divss xmm, xmm/mem32"));
    let mut destination: f32 = read_xmm_f32(r);
    let mut result: f32 = destination / source;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F5E_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F5E(read_xmm_f32(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F30F5E_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F5E(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0F5F(mut source: reg128, mut r: i32) -> () {
    c_comment!(("maxps xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f32_0: [
            sse_max(
                destination.f32_0[0usize] as f64,
                source.f32_0[0usize] as f64,
            ) as f32,
            sse_max(
                destination.f32_0[1usize] as f64,
                source.f32_0[1usize] as f64,
            ) as f32,
            sse_max(
                destination.f32_0[2usize] as f64,
                source.f32_0[2usize] as f64,
            ) as f32,
            sse_max(
                destination.f32_0[3usize] as f64,
                source.f32_0[3usize] as f64,
            ) as f32,
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0F5F_reg(mut r1: i32, mut r2: i32) -> () { instr_0F5F(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F5F_mem(mut addr: i32, mut r: i32) -> () {
    instr_0F5F(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5F(mut source: reg128, mut r: i32) -> () {
    c_comment!(("maxpd xmm, xmm/mem128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        f64_0: [
            sse_max(destination.f64_0[0usize], source.f64_0[0usize]),
            sse_max(destination.f64_0[1usize], source.f64_0[1usize]),
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F5F_reg(mut r1: i32, mut r2: i32) -> () {
    instr_660F5F(read_xmm128s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_660F5F_mem(mut addr: i32, mut r: i32) -> () {
    instr_660F5F(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5F(mut source: reg64, mut r: i32) -> () {
    c_comment!(("maxsd xmm, xmm/mem64"));
    let mut destination: reg64 = read_xmm64s(r);
    let mut result: reg64 = reg64 {
        f64_0: [sse_max(destination.f64_0[0usize], source.f64_0[0usize])],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20F5F_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F20F5F(read_xmm64s(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F20F5F_mem(mut addr: i32, mut r: i32) -> () {
    instr_F20F5F(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5F(mut source: f32, mut r: i32) -> () {
    c_comment!(("maxss xmm, xmm/mem32"));
    let mut destination: f32 = read_xmm_f32(r);
    let mut result: f32 = sse_max(destination as f64, source as f64) as f32;
    write_xmm_f32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30F5F_reg(mut r1: i32, mut r2: i32) -> () {
    instr_F30F5F(read_xmm_f32(r1), r2);
}
#[no_mangle]
pub unsafe fn instr_F30F5F_mem(mut addr: i32, mut r: i32) -> () {
    instr_F30F5F(return_on_pagefault!(fpu_load_m32(addr)) as f32, r);
}
#[no_mangle]
pub unsafe fn instr_0FC2(mut source: reg128, mut r: i32, mut imm8: i32) -> () {
    c_comment!(("cmpps xmm, xmm/m128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i32_0: [
            if 0 != sse_comparison(
                imm8,
                destination.f32_0[0usize] as f64,
                source.f32_0[0usize] as f64,
            ) as i32
            {
                -1i32
            }
            else {
                0i32
            },
            if 0 != sse_comparison(
                imm8,
                destination.f32_0[1usize] as f64,
                source.f32_0[1usize] as f64,
            ) as i32
            {
                -1i32
            }
            else {
                0i32
            },
            if 0 != sse_comparison(
                imm8,
                destination.f32_0[2usize] as f64,
                source.f32_0[2usize] as f64,
            ) as i32
            {
                -1i32
            }
            else {
                0i32
            },
            if 0 != sse_comparison(
                imm8,
                destination.f32_0[3usize] as f64,
                source.f32_0[3usize] as f64,
            ) as i32
            {
                -1i32
            }
            else {
                0i32
            },
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_0FC2_reg(mut r1: i32, mut r2: i32, mut imm: i32) -> () {
    instr_0FC2(read_xmm128s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_0FC2_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    instr_0FC2(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_660FC2(mut source: reg128, mut r: i32, mut imm8: i32) -> () {
    c_comment!(("cmppd xmm, xmm/m128"));
    let mut destination: reg128 = read_xmm128s(r);
    let mut result: reg128 = reg128 {
        i64_0: [
            (if 0 != sse_comparison(imm8, destination.f64_0[0usize], source.f64_0[0usize]) as i32 {
                -1i32
            }
            else {
                0i32
            }) as i64,
            (if 0 != sse_comparison(imm8, destination.f64_0[1usize], source.f64_0[1usize]) as i32 {
                -1i32
            }
            else {
                0i32
            }) as i64,
        ],
    };
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660FC2_reg(mut r1: i32, mut r2: i32, mut imm: i32) -> () {
    instr_660FC2(read_xmm128s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_660FC2_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    instr_660FC2(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_F20FC2(mut source: reg64, mut r: i32, mut imm8: i32) -> () {
    c_comment!(("cmpsd xmm, xmm/m64"));
    let mut destination: reg64 = read_xmm64s(r);
    let mut result: reg64 = reg64 {
        i64_0: [(if 0
            != sse_comparison(imm8, destination.f64_0[0usize], source.f64_0[0usize]) as i32
        {
            -1i32
        }
        else {
            0i32
        }) as i64],
    };
    write_xmm64(r, result);
}
#[no_mangle]
pub unsafe fn instr_F20FC2_reg(mut r1: i32, mut r2: i32, mut imm: i32) -> () {
    instr_F20FC2(read_xmm64s(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_F20FC2_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    instr_F20FC2(return_on_pagefault!(safe_read64s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_F30FC2(mut source: f32, mut r: i32, mut imm8: i32) -> () {
    c_comment!(("cmpss xmm, xmm/m32"));
    let mut destination: f32 = read_xmm_f32(r);
    let mut result: i32 = if 0 != sse_comparison(imm8, destination as f64, source as f64) as i32 {
        -1i32
    }
    else {
        0i32
    };
    write_xmm32(r, result);
}
#[no_mangle]
pub unsafe fn instr_F30FC2_reg(mut r1: i32, mut r2: i32, mut imm: i32) -> () {
    instr_F30FC2(read_xmm_f32(r1), r2, imm);
}
#[no_mangle]
pub unsafe fn instr_F30FC2_mem(mut addr: i32, mut r: i32, mut imm: i32) -> () {
    instr_F30FC2(return_on_pagefault!(fpu_load_m32(addr)) as f32, r, imm);
}
