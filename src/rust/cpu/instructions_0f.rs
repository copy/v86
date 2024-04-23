#![allow(non_snake_case)]

extern "C" {
    fn get_rand_int() -> i32;
}

unsafe fn undefined_instruction() {
    dbg_assert!(false, "Undefined instructions");
    trigger_ud()
}
unsafe fn unimplemented_sse() {
    dbg_assert!(false, "Unimplemented SSE instruction");
    trigger_ud()
}

use cpu::arith::{
    bsf16, bsf32, bsr16, bsr32, bt_mem, bt_reg, btc_mem, btc_reg, btr_mem, btr_reg, bts_mem,
    bts_reg, cmpxchg16, cmpxchg32, cmpxchg8, popcnt, shld16, shld32, shrd16, shrd32, xadd16,
    xadd32, xadd8,
};
use cpu::arith::{
    imul_reg16, imul_reg32, saturate_sd_to_sb, saturate_sd_to_sw, saturate_sd_to_ub,
    saturate_sw_to_sb, saturate_sw_to_ub, saturate_ud_to_ub, saturate_uw,
};
use cpu::cpu::*;
use cpu::fpu::fpu_set_tag_word;
use cpu::global_pointers::*;
use cpu::misc_instr::{
    adjust_stack_reg, bswap, cmovcc16, cmovcc32, fxrstor, fxsave, get_stack_pointer, jmpcc16,
    jmpcc32, push16, push32_sreg, setcc_mem, setcc_reg, test_b, test_be, test_l, test_le, test_o,
    test_p, test_s, test_z,
};
use cpu::misc_instr::{lar, lsl, verr, verw};
use cpu::misc_instr::{lss16, lss32};
use cpu::sse_instr::*;

#[no_mangle]
pub unsafe fn instr16_0F00_0_mem(addr: i32) {
    // sldt
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    return_on_pagefault!(safe_write16(addr, *sreg.offset(LDTR as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_0F00_0_mem(addr: i32) { instr16_0F00_0_mem(addr) }
#[no_mangle]
pub unsafe fn instr16_0F00_0_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    write_reg16(r, *sreg.offset(LDTR as isize) as i32);
}
#[no_mangle]
pub unsafe fn instr32_0F00_0_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    write_reg32(r, *sreg.offset(LDTR as isize) as i32);
}

#[no_mangle]
pub unsafe fn instr16_0F00_1_mem(addr: i32) {
    // str
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    return_on_pagefault!(safe_write16(addr, *sreg.offset(TR as isize) as i32));
}
#[no_mangle]
pub unsafe fn instr32_0F00_1_mem(addr: i32) { instr16_0F00_1_mem(addr) }
#[no_mangle]
pub unsafe fn instr16_0F00_1_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    write_reg16(r, *sreg.offset(TR as isize) as i32);
}
#[no_mangle]
pub unsafe fn instr32_0F00_1_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        trigger_ud();
        return;
    }
    write_reg32(r, *sreg.offset(TR as isize) as i32);
}

#[no_mangle]
pub unsafe fn instr16_0F00_2_mem(addr: i32) {
    // lldt
    if !*protected_mode || vm86_mode() {
        trigger_ud();
    }
    else if 0 != *cpl {
        trigger_gp(0);
    }
    else {
        return_on_pagefault!(load_ldt(return_on_pagefault!(safe_read16(addr))));
    };
}
#[no_mangle]
pub unsafe fn instr32_0F00_2_mem(addr: i32) { instr16_0F00_2_mem(addr) }
#[no_mangle]
pub unsafe fn instr16_0F00_2_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        trigger_ud();
    }
    else if 0 != *cpl {
        trigger_gp(0);
    }
    else {
        return_on_pagefault!(load_ldt(read_reg16(r)));
    };
}
#[no_mangle]
pub unsafe fn instr32_0F00_2_reg(r: i32) { instr16_0F00_2_reg(r) }

#[no_mangle]
pub unsafe fn instr16_0F00_3_mem(addr: i32) {
    // ltr
    if !*protected_mode || vm86_mode() {
        trigger_ud();
    }
    else if 0 != *cpl {
        trigger_gp(0);
    }
    else {
        load_tr(return_on_pagefault!(safe_read16(addr)));
    };
}
#[no_mangle]
pub unsafe fn instr32_0F00_3_mem(addr: i32) { instr16_0F00_3_mem(addr); }
#[no_mangle]
pub unsafe fn instr16_0F00_3_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        trigger_ud();
    }
    else if 0 != *cpl {
        trigger_gp(0);
    }
    else {
        load_tr(read_reg16(r));
    };
}
#[no_mangle]
pub unsafe fn instr32_0F00_3_reg(r: i32) { instr16_0F00_3_reg(r) }

#[no_mangle]
pub unsafe fn instr16_0F00_4_mem(addr: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("verr #ud");
        trigger_ud();
        return;
    }
    verr(return_on_pagefault!(safe_read16(addr)));
}
#[no_mangle]
pub unsafe fn instr32_0F00_4_mem(addr: i32) { instr16_0F00_4_mem(addr) }
#[no_mangle]
pub unsafe fn instr16_0F00_4_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("verr #ud");
        trigger_ud();
        return;
    }
    verr(read_reg16(r));
}
#[no_mangle]
pub unsafe fn instr32_0F00_4_reg(r: i32) { instr16_0F00_4_reg(r) }
#[no_mangle]
pub unsafe fn instr16_0F00_5_mem(addr: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("verw #ud");
        trigger_ud();
        return;
    }
    verw(return_on_pagefault!(safe_read16(addr)));
}
#[no_mangle]
pub unsafe fn instr32_0F00_5_mem(addr: i32) { instr16_0F00_5_mem(addr) }
#[no_mangle]
pub unsafe fn instr16_0F00_5_reg(r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("verw #ud");
        trigger_ud();
        return;
    }
    verw(read_reg16(r));
}
#[no_mangle]
pub unsafe fn instr32_0F00_5_reg(r: i32) { instr16_0F00_5_reg(r) }

#[no_mangle]
pub unsafe fn instr16_0F01_0_reg(_r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0F01_0_reg(_r: i32) { trigger_ud(); }

unsafe fn sgdt(addr: i32, mask: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 6));
    safe_write16(addr, *gdtr_size).unwrap();
    safe_write32(addr + 2, *gdtr_offset & mask).unwrap();
}
#[no_mangle]
pub unsafe fn instr16_0F01_0_mem(addr: i32) { sgdt(addr, 0xFFFFFF) }
#[no_mangle]
pub unsafe fn instr32_0F01_0_mem(addr: i32) { sgdt(addr, -1) }

#[no_mangle]
pub unsafe fn instr16_0F01_1_reg(_r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0F01_1_reg(_r: i32) { trigger_ud(); }

unsafe fn sidt(addr: i32, mask: i32) {
    return_on_pagefault!(writable_or_pagefault(addr, 6));
    safe_write16(addr, *idtr_size).unwrap();
    safe_write32(addr + 2, *idtr_offset & mask).unwrap();
}
#[no_mangle]
pub unsafe fn instr16_0F01_1_mem(addr: i32) { sidt(addr, 0xFFFFFF) }
#[no_mangle]
pub unsafe fn instr32_0F01_1_mem(addr: i32) { sidt(addr, -1) }

#[no_mangle]
pub unsafe fn instr16_0F01_2_reg(_r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0F01_2_reg(_r: i32) { trigger_ud(); }

unsafe fn lgdt(addr: i32, mask: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    let size = return_on_pagefault!(safe_read16(addr));
    let offset = return_on_pagefault!(safe_read32s(addr + 2));
    *gdtr_size = size;
    *gdtr_offset = offset & mask;
}
#[no_mangle]
pub unsafe fn instr16_0F01_2_mem(addr: i32) { lgdt(addr, 0xFFFFFF); }
#[no_mangle]
pub unsafe fn instr32_0F01_2_mem(addr: i32) { lgdt(addr, -1); }

#[no_mangle]
pub unsafe fn instr16_0F01_3_reg(_r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0F01_3_reg(_r: i32) { trigger_ud(); }

unsafe fn lidt(addr: i32, mask: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    let size = return_on_pagefault!(safe_read16(addr));
    let offset = return_on_pagefault!(safe_read32s(addr + 2));
    *idtr_size = size;
    *idtr_offset = offset & mask;
}
#[no_mangle]
pub unsafe fn instr16_0F01_3_mem(addr: i32) { lidt(addr, 0xFFFFFF); }
#[no_mangle]
pub unsafe fn instr32_0F01_3_mem(addr: i32) { lidt(addr, -1); }

#[no_mangle]
pub unsafe fn instr16_0F01_4_reg(r: i32) {
    // smsw
    write_reg16(r, *cr);
}
#[no_mangle]
pub unsafe fn instr32_0F01_4_reg(r: i32) { write_reg32(r, *cr); }
#[no_mangle]
pub unsafe fn instr16_0F01_4_mem(addr: i32) {
    return_on_pagefault!(safe_write16(addr, *cr));
}
#[no_mangle]
pub unsafe fn instr32_0F01_4_mem(addr: i32) {
    return_on_pagefault!(safe_write16(addr, *cr));
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
pub unsafe fn instr16_0F01_6_reg(r: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    lmsw(read_reg16(r));
}
#[no_mangle]
pub unsafe fn instr32_0F01_6_reg(r: i32) { instr16_0F01_6_reg(r); }
#[no_mangle]
pub unsafe fn instr16_0F01_6_mem(addr: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    lmsw(return_on_pagefault!(safe_read16(addr)));
}
#[no_mangle]
pub unsafe fn instr32_0F01_6_mem(addr: i32) { instr16_0F01_6_mem(addr) }

#[no_mangle]
pub unsafe fn instr16_0F01_7_reg(_r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0F01_7_reg(_r: i32) { trigger_ud(); }

#[no_mangle]
pub unsafe fn instr16_0F01_7_mem(addr: i32) {
    // invlpg
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }
    invlpg(addr);
}
#[no_mangle]
pub unsafe fn instr32_0F01_7_mem(addr: i32) { instr16_0F01_7_mem(addr) }

#[no_mangle]
pub unsafe fn instr16_0F02_mem(addr: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lar #ud");
        trigger_ud();
        return;
    }
    write_reg16(
        r,
        lar(return_on_pagefault!(safe_read16(addr)), read_reg16(r)),
    );
}
#[no_mangle]
pub unsafe fn instr16_0F02_reg(r1: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lar #ud");
        trigger_ud();
        return;
    }
    write_reg16(r, lar(read_reg16(r1), read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_0F02_mem(addr: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lar #ud");
        trigger_ud();
        return;
    }
    write_reg32(
        r,
        lar(return_on_pagefault!(safe_read16(addr)), read_reg32(r)),
    );
}
#[no_mangle]
pub unsafe fn instr32_0F02_reg(r1: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lar #ud");
        trigger_ud();
        return;
    }
    write_reg32(r, lar(read_reg16(r1), read_reg32(r)));
}
#[no_mangle]
pub unsafe fn instr16_0F03_mem(addr: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lsl #ud");
        trigger_ud();
        return;
    }
    write_reg16(
        r,
        lsl(return_on_pagefault!(safe_read16(addr)), read_reg16(r)),
    );
}
#[no_mangle]
pub unsafe fn instr16_0F03_reg(r1: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lsl #ud");
        trigger_ud();
        return;
    }
    write_reg16(r, lsl(read_reg16(r1), read_reg16(r)));
}
#[no_mangle]
pub unsafe fn instr32_0F03_mem(addr: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lsl #ud");
        trigger_ud();
        return;
    }
    write_reg32(
        r,
        lsl(return_on_pagefault!(safe_read16(addr)), read_reg32(r)),
    );
}
#[no_mangle]
pub unsafe fn instr32_0F03_reg(r1: i32, r: i32) {
    if !*protected_mode || vm86_mode() {
        dbg_log!("lsl #ud");
        trigger_ud();
        return;
    }
    write_reg32(r, lsl(read_reg16(r1), read_reg32(r)));
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

pub unsafe fn instr_0F10(source: reg128, r: i32) {
    // movups xmm, xmm/m128
    mov_rm_r128(source, r);
}
pub unsafe fn instr_0F10_reg(r1: i32, r2: i32) { instr_0F10(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F10_mem(addr: i32, r: i32) {
    instr_0F10(return_on_pagefault!(safe_read128s(addr)), r);
}
pub unsafe fn instr_F30F10_reg(r1: i32, r2: i32) {
    // movss xmm, xmm/m32
    let data = read_xmm128s(r1);
    write_xmm32(r2, data.u32[0] as i32);
}
pub unsafe fn instr_F30F10_mem(addr: i32, r: i32) {
    // movss xmm, xmm/m32
    let data = return_on_pagefault!(safe_read32s(addr));
    write_xmm128(r, data, 0, 0, 0);
}
pub unsafe fn instr_660F10(source: reg128, r: i32) {
    // movupd xmm, xmm/m128
    mov_rm_r128(source, r);
}
pub unsafe fn instr_660F10_reg(r1: i32, r2: i32) { instr_660F10(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F10_mem(addr: i32, r: i32) {
    instr_660F10(return_on_pagefault!(safe_read128s(addr)), r);
}
pub unsafe fn instr_F20F10_reg(r1: i32, r2: i32) {
    // movsd xmm, xmm/m64
    let data = read_xmm128s(r1);
    write_xmm64(r2, data.u64[0]);
}
pub unsafe fn instr_F20F10_mem(addr: i32, r: i32) {
    // movsd xmm, xmm/m64
    let data = return_on_pagefault!(safe_read64s(addr));
    write_xmm128_2(r, data, 0);
}
pub unsafe fn instr_0F11_reg(r1: i32, r2: i32) {
    // movups xmm/m128, xmm
    mov_r_r128(r1, r2);
}
pub unsafe fn instr_0F11_mem(addr: i32, r: i32) {
    // movups xmm/m128, xmm
    mov_r_m128(addr, r);
}
pub unsafe fn instr_F30F11_reg(rm_dest: i32, reg_src: i32) {
    // movss xmm/m32, xmm
    let data = read_xmm128s(reg_src);
    write_xmm32(rm_dest, data.u32[0] as i32);
}
pub unsafe fn instr_F30F11_mem(addr: i32, r: i32) {
    // movss xmm/m32, xmm
    let data = read_xmm128s(r);
    return_on_pagefault!(safe_write32(addr, data.u32[0] as i32));
}
pub unsafe fn instr_660F11_reg(r1: i32, r2: i32) {
    // movupd xmm/m128, xmm
    mov_r_r128(r1, r2);
}
pub unsafe fn instr_660F11_mem(addr: i32, r: i32) {
    // movupd xmm/m128, xmm
    mov_r_m128(addr, r);
}
pub unsafe fn instr_F20F11_reg(r1: i32, r2: i32) {
    // movsd xmm/m64, xmm
    let data = read_xmm128s(r2);
    write_xmm64(r1, data.u64[0]);
}
pub unsafe fn instr_F20F11_mem(addr: i32, r: i32) {
    // movsd xmm/m64, xmm
    let data = read_xmm64s(r);
    return_on_pagefault!(safe_write64(addr, data));
}
pub unsafe fn instr_0F12_mem(addr: i32, r: i32) {
    // movlps xmm, m64
    let data = return_on_pagefault!(safe_read64s(addr));
    write_xmm64(r, data);
}
pub unsafe fn instr_0F12_reg(r1: i32, r2: i32) {
    // movhlps xmm, xmm
    let data = read_xmm128s(r1);
    write_xmm64(r2, data.u64[1]);
}
pub unsafe fn instr_660F12_reg(_r1: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_660F12_mem(addr: i32, r: i32) {
    // movlpd xmm, m64
    let data = return_on_pagefault!(safe_read64s(addr));
    write_xmm64(r, data);
}
#[no_mangle]
pub unsafe fn instr_F20F12(source: u64, r: i32) {
    // movddup xmm1, xmm2/m64
    write_xmm_reg128(
        r,
        reg128 {
            u64: [source, source],
        },
    );
}
pub unsafe fn instr_F20F12_reg(r1: i32, r2: i32) { instr_F20F12(read_xmm64s(r1), r2); }
pub unsafe fn instr_F20F12_mem(addr: i32, r: i32) {
    instr_F20F12(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F12(source: reg128, r: i32) {
    // movsldup xmm1, xmm2/m128
    write_xmm_reg128(
        r,
        reg128 {
            u32: [source.u32[0], source.u32[0], source.u32[2], source.u32[2]],
        },
    );
}
pub unsafe fn instr_F30F12_reg(r1: i32, r2: i32) { instr_F30F12(read_xmm128s(r1), r2); }
pub unsafe fn instr_F30F12_mem(addr: i32, r: i32) {
    instr_F30F12(return_on_pagefault!(safe_read128s(addr)), r);
}
pub unsafe fn instr_0F13_mem(addr: i32, r: i32) {
    // movlps m64, xmm
    movl_r128_m64(addr, r);
}
pub unsafe fn instr_0F13_reg(_r1: i32, _r2: i32) { trigger_ud(); }
pub unsafe fn instr_660F13_reg(_r1: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_660F13_mem(addr: i32, r: i32) {
    // movlpd xmm/m64, xmm
    movl_r128_m64(addr, r);
}

#[no_mangle]
pub unsafe fn instr_0F14(source: u64, r: i32) {
    // unpcklps xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm64s(r);
    write_xmm128(
        r,
        destination as i32,
        source as i32,
        (destination >> 32) as i32,
        (source >> 32) as i32,
    );
}
pub unsafe fn instr_0F14_reg(r1: i32, r2: i32) { instr_0F14(read_xmm64s(r1), r2); }
pub unsafe fn instr_0F14_mem(addr: i32, r: i32) {
    instr_0F14(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F14(source: u64, r: i32) {
    // unpcklpd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm64s(r);
    write_xmm128(
        r,
        destination as i32,
        (destination >> 32) as i32,
        source as i32,
        (source >> 32) as i32,
    );
}
pub unsafe fn instr_660F14_reg(r1: i32, r2: i32) { instr_660F14(read_xmm64s(r1), r2); }
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
        destination.u32[2] as i32,
        source.u32[2] as i32,
        destination.u32[3] as i32,
        source.u32[3] as i32,
    );
}
pub unsafe fn instr_0F15_reg(r1: i32, r2: i32) { instr_0F15(read_xmm128s(r1), r2); }
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
        destination.u32[2] as i32,
        destination.u32[3] as i32,
        source.u32[2] as i32,
        source.u32[3] as i32,
    );
}
pub unsafe fn instr_660F15_reg(r1: i32, r2: i32) { instr_660F15(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F15_mem(addr: i32, r: i32) {
    instr_660F15(return_on_pagefault!(safe_read128s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F16(source: u64, r: i32) { (*reg_xmm.offset(r as isize)).u64[1] = source; }
pub unsafe fn instr_0F16_mem(addr: i32, r: i32) {
    // movhps xmm, m64
    instr_0F16(return_on_pagefault!(safe_read64s(addr)), r);
}
pub unsafe fn instr_0F16_reg(r1: i32, r2: i32) {
    // movlhps xmm, xmm
    instr_0F16(read_xmm64s(r1), r2);
}
pub unsafe fn instr_660F16_mem(addr: i32, r: i32) {
    // movhpd xmm, m64
    instr_0F16(return_on_pagefault!(safe_read64s(addr)), r);
}
pub unsafe fn instr_660F16_reg(_r1: i32, _r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_F30F16(source: reg128, r: i32) {
    // movshdup xmm1, xmm2/m128
    write_xmm_reg128(
        r,
        reg128 {
            u32: [source.u32[1], source.u32[1], source.u32[3], source.u32[3]],
        },
    );
}
pub unsafe fn instr_F30F16_reg(r1: i32, r2: i32) { instr_F30F16(read_xmm128s(r1), r2); }
pub unsafe fn instr_F30F16_mem(addr: i32, r: i32) {
    instr_F30F16(return_on_pagefault!(safe_read128s(addr)), r);
}
pub unsafe fn instr_0F17_mem(addr: i32, r: i32) {
    // movhps m64, xmm
    movh_r128_m64(addr, r);
}
pub unsafe fn instr_0F17_reg(_r1: i32, _r2: i32) { trigger_ud(); }
pub unsafe fn instr_660F17_mem(addr: i32, r: i32) {
    // movhpd m64, xmm
    movh_r128_m64(addr, r);
}
pub unsafe fn instr_660F17_reg(_r1: i32, _r2: i32) { trigger_ud(); }

pub unsafe fn instr_0F18_reg(_r1: i32, _r2: i32) {
    // reserved nop
}
pub unsafe fn instr_0F18_mem(_addr: i32, _r: i32) {
    // prefetch
    // nop for us
}

pub unsafe fn instr_0F19_reg(_r1: i32, _r2: i32) {}
pub unsafe fn instr_0F19_mem(_addr: i32, _r: i32) {}

#[no_mangle]
pub unsafe fn instr_0F1A() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F1B() { undefined_instruction(); }

pub unsafe fn instr_0F1C_reg(_r1: i32, _r2: i32) {}
pub unsafe fn instr_0F1C_mem(_addr: i32, _r: i32) {}
pub unsafe fn instr_0F1D_reg(_r1: i32, _r2: i32) {}
pub unsafe fn instr_0F1D_mem(_addr: i32, _r: i32) {}
pub unsafe fn instr_0F1E_reg(_r1: i32, _r2: i32) {}
pub unsafe fn instr_0F1E_mem(_addr: i32, _r: i32) {}
pub unsafe fn instr_0F1F_reg(_r1: i32, _r2: i32) {}
pub unsafe fn instr_0F1F_mem(_addr: i32, _r: i32) {}

#[no_mangle]
pub unsafe fn instr_0F20(r: i32, creg: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }

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
}
#[no_mangle]
pub unsafe fn instr_0F21(r: i32, mut dreg_index: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }

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
}
#[no_mangle]
pub unsafe fn instr_0F22(r: i32, creg: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }

    let data = read_reg32(r);
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
        3 => set_cr3(data),
        4 => {
            dbg_log!("cr4 <- {:x}", data);
            if 0 != data as u32
                & ((1 << 11 | 1 << 12 | 1 << 15 | 1 << 16 | 1 << 19) as u32 | 0xFFC00000)
            {
                dbg_log!("trigger_gp: Invalid cr4 bit");
                trigger_gp(0);
                return;
            }
            else {
                if 0 != (*cr.offset(4) ^ data) & (CR4_PGE | CR4_PSE | CR4_PAE) {
                    full_clear_tlb();
                }
                if data & CR4_PAE != 0
                    && 0 != (*cr.offset(4) ^ data) & (CR4_PGE | CR4_PSE | CR4_SMEP)
                {
                    load_pdpte(*cr.offset(3));
                }
                *cr.offset(4) = data;
            }
        },
        _ => {
            dbg_log!("{}", creg);
            undefined_instruction();
        },
    }
}
#[no_mangle]
pub unsafe fn instr_0F23(r: i32, mut dreg_index: i32) {
    if 0 != *cpl {
        trigger_gp(0);
        return;
    }

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
}
#[no_mangle]
pub unsafe fn instr_0F24() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F25() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F26() { undefined_instruction(); }
#[no_mangle]
pub unsafe fn instr_0F27() { undefined_instruction(); }

pub unsafe fn instr_0F28(source: reg128, r: i32) {
    // movaps xmm, xmm/m128
    // XXX: Aligned read or #gp
    mov_rm_r128(source, r);
}
pub unsafe fn instr_0F28_reg(r1: i32, r2: i32) { instr_0F28(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F28_mem(addr: i32, r: i32) {
    instr_0F28(return_on_pagefault!(safe_read128s(addr)), r);
}
pub unsafe fn instr_660F28(source: reg128, r: i32) {
    // movapd xmm, xmm/m128
    // XXX: Aligned read or #gp
    // Note: Same as movdqa (660F6F)
    mov_rm_r128(source, r);
}
pub unsafe fn instr_660F28_reg(r1: i32, r2: i32) { instr_660F28(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F28_mem(addr: i32, r: i32) {
    instr_660F28(return_on_pagefault!(safe_read128s(addr)), r);
}
pub unsafe fn instr_0F29_mem(addr: i32, r: i32) {
    // movaps m128, xmm
    let data = read_xmm128s(r);
    // XXX: Aligned write or #gp
    return_on_pagefault!(safe_write128(addr, data));
}
pub unsafe fn instr_0F29_reg(r1: i32, r2: i32) {
    // movaps xmm, xmm
    mov_r_r128(r1, r2);
}
pub unsafe fn instr_660F29_mem(addr: i32, r: i32) {
    // movapd m128, xmm
    let data = read_xmm128s(r);
    // XXX: Aligned write or #gp
    return_on_pagefault!(safe_write128(addr, data));
}
pub unsafe fn instr_660F29_reg(r1: i32, r2: i32) {
    // movapd xmm, xmm
    mov_r_r128(r1, r2);
}

#[no_mangle]
pub unsafe fn instr_0F2A(source: u64, r: i32) {
    // cvtpi2ps xmm, mm/m64
    // Note: Casts here can fail
    // XXX: Should round according to round control
    let source: [i32; 2] = std::mem::transmute(source);
    let result = [source[0] as f32, source[1] as f32];
    write_xmm64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F2A_reg(r1: i32, r2: i32) { instr_0F2A(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F2A_mem(addr: i32, r: i32) {
    instr_0F2A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F2A(source: u64, r: i32) {
    // cvtpi2pd xmm, xmm/m64
    // These casts can't fail
    let source: [i32; 2] = std::mem::transmute(source);
    let result = reg128 {
        f64: [source[0] as f64, source[1] as f64],
    };
    write_xmm_reg128(r, result);
    transition_fpu_to_mmx();
}
pub unsafe fn instr_660F2A_reg(r1: i32, r2: i32) { instr_660F2A(read_mmx64s(r1), r2); }
pub unsafe fn instr_660F2A_mem(addr: i32, r: i32) {
    instr_660F2A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F2A(source: i32, r: i32) {
    // cvtsi2sd xmm, r32/m32
    // This cast can't fail
    write_xmm_f64(r, source as f64);
}
pub unsafe fn instr_F20F2A_reg(r1: i32, r2: i32) { instr_F20F2A(read_reg32(r1), r2); }
pub unsafe fn instr_F20F2A_mem(addr: i32, r: i32) {
    instr_F20F2A(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F2A(source: i32, r: i32) {
    // cvtsi2ss xmm, r/m32
    // Note: This cast can fail
    // XXX: Should round according to round control
    let result = source as f32;
    write_xmm_f32(r, result);
}
pub unsafe fn instr_F30F2A_reg(r1: i32, r2: i32) { instr_F30F2A(read_reg32(r1), r2); }
pub unsafe fn instr_F30F2A_mem(addr: i32, r: i32) {
    instr_F30F2A(return_on_pagefault!(safe_read32s(addr)), r);
}

pub unsafe fn instr_0F2B_reg(_r1: i32, _r2: i32) { trigger_ud(); }
pub unsafe fn instr_0F2B_mem(addr: i32, r: i32) {
    // movntps m128, xmm
    // XXX: Aligned write or #gp
    mov_r_m128(addr, r);
}
pub unsafe fn instr_660F2B_reg(_r1: i32, _r2: i32) { trigger_ud(); }
pub unsafe fn instr_660F2B_mem(addr: i32, r: i32) {
    // movntpd m128, xmm
    // XXX: Aligned write or #gp
    mov_r_m128(addr, r);
}

pub unsafe fn instr_0F2C(source: u64, r: i32) {
    // cvttps2pi mm, xmm/m64
    let low = f32::from_bits(source as u32);
    let high = f32::from_bits((source >> 32) as u32);
    write_mmx_reg64(
        r,
        sse_convert_with_truncation_f32_to_i32(low) as u32 as u64
            | (sse_convert_with_truncation_f32_to_i32(high) as u32 as u64) << 32,
    );
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F2C_mem(addr: i32, r: i32) {
    instr_0F2C(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F2C_reg(r1: i32, r2: i32) { instr_0F2C(read_xmm64s(r1), r2); }

pub unsafe fn instr_660F2C(source: reg128, r: i32) {
    // cvttpd2pi mm, xmm/m128
    write_mmx_reg64(
        r,
        sse_convert_with_truncation_f64_to_i32(source.f64[0]) as u32 as u64
            | (sse_convert_with_truncation_f64_to_i32(source.f64[1]) as u32 as u64) << 32,
    );
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_660F2C_mem(addr: i32, r: i32) {
    instr_660F2C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F2C_reg(r1: i32, r2: i32) { instr_660F2C(read_xmm128s(r1), r2); }

pub unsafe fn instr_F20F2C(source: u64, r: i32) {
    // cvttsd2si r32, xmm/m64
    let source = f64::from_bits(source);
    write_reg32(r, sse_convert_with_truncation_f64_to_i32(source));
}
#[no_mangle]
pub unsafe fn instr_F20F2C_reg(r1: i32, r2: i32) { instr_F20F2C(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_F20F2C_mem(addr: i32, r: i32) {
    instr_F20F2C(return_on_pagefault!(safe_read64s(addr)), r);
}

pub unsafe fn instr_F30F2C(source: f32, r: i32) {
    // cvttss2si
    write_reg32(r, sse_convert_with_truncation_f32_to_i32(source));
}
#[no_mangle]
pub unsafe fn instr_F30F2C_mem(addr: i32, r: i32) {
    instr_F30F2C(return_on_pagefault!(safe_read_f32(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F2C_reg(r1: i32, r2: i32) { instr_F30F2C(read_xmm_f32(r1), r2); }

pub unsafe fn instr_0F2D(source: u64, r: i32) {
    // cvtps2pi mm, xmm/m64
    let source: [f32; 2] = std::mem::transmute(source);
    let result = [
        sse_convert_f32_to_i32(source[0]),
        sse_convert_f32_to_i32(source[1]),
    ];
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F2D_reg(r1: i32, r2: i32) { instr_0F2D(read_xmm64s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_0F2D_mem(addr: i32, r: i32) {
    instr_0F2D(return_on_pagefault!(safe_read64s(addr)), r);
}

pub unsafe fn instr_660F2D(source: reg128, r: i32) {
    // cvtpd2pi mm, xmm/m128
    let result = [
        sse_convert_f64_to_i32(source.f64[0]),
        sse_convert_f64_to_i32(source.f64[1]),
    ];
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_660F2D_reg(r1: i32, r2: i32) { instr_660F2D(read_xmm128s(r1), r2); }
#[no_mangle]
pub unsafe fn instr_660F2D_mem(addr: i32, r: i32) {
    instr_660F2D(return_on_pagefault!(safe_read128s(addr)), r);
}
pub unsafe fn instr_F20F2D(source: u64, r: i32) {
    // cvtsd2si r32, xmm/m64
    write_reg32(r, sse_convert_f64_to_i32(f64::from_bits(source)));
}
pub unsafe fn instr_F20F2D_reg(r1: i32, r2: i32) { instr_F20F2D(read_xmm64s(r1), r2); }
pub unsafe fn instr_F20F2D_mem(addr: i32, r: i32) {
    instr_F20F2D(return_on_pagefault!(safe_read64s(addr)), r);
}
pub unsafe fn instr_F30F2D(source: f32, r: i32) {
    // cvtss2si r32, xmm1/m32
    write_reg32(r, sse_convert_f32_to_i32(source));
}
pub unsafe fn instr_F30F2D_reg(r1: i32, r2: i32) { instr_F30F2D(read_xmm_f32(r1), r2); }
pub unsafe fn instr_F30F2D_mem(addr: i32, r: i32) {
    instr_F30F2D(return_on_pagefault!(safe_read_f32(addr)), r);
}

#[no_mangle]
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
pub unsafe fn instr_0F2E_reg(r1: i32, r2: i32) { instr_0F2E(read_xmm_f32(r1), r2) }
pub unsafe fn instr_0F2E_mem(addr: i32, r: i32) {
    instr_0F2E(return_on_pagefault!(safe_read_f32(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_660F2E(source: u64, r: i32) {
    // ucomisd xmm1, xmm2/m64
    let destination = f64::from_bits(read_xmm64s(r));
    let source = f64::from_bits(source);
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
pub unsafe fn instr_660F2E_reg(r1: i32, r: i32) { instr_660F2E(read_xmm64s(r1), r); }
pub unsafe fn instr_660F2E_mem(addr: i32, r: i32) {
    instr_660F2E(return_on_pagefault!(safe_read64s(addr)), r)
}

#[no_mangle]
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
pub unsafe fn instr_0F2F_reg(r1: i32, r2: i32) { instr_0F2F(read_xmm_f32(r1), r2) }
pub unsafe fn instr_0F2F_mem(addr: i32, r: i32) {
    instr_0F2F(return_on_pagefault!(safe_read_f32(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_660F2F(source: u64, r: i32) {
    // comisd xmm1, xmm2/m64
    let destination = f64::from_bits(read_xmm64s(r));
    let source = f64::from_bits(source);
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
pub unsafe fn instr_660F2F_reg(r1: i32, r: i32) { instr_660F2F(read_xmm64s(r1), r); }
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

    let index = read_reg32(ECX);
    let low = read_reg32(EAX);
    let high = read_reg32(EDX);

    if index != IA32_SYSENTER_ESP {
        dbg_log!("wrmsr ecx={:x} data={:x}:{:x}", index, high, low);
    }

    match index {
        IA32_SYSENTER_CS => *sysenter_cs = low & 0xFFFF,
        IA32_SYSENTER_EIP => *sysenter_eip = low,
        IA32_SYSENTER_ESP => *sysenter_esp = low,
        IA32_FEAT_CTL => {}, // linux 5.x
        MSR_TEST_CTRL => {}, // linux 5.x
        IA32_APIC_BASE => {
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
            *apic_enabled = low & IA32_APIC_BASE_EN == IA32_APIC_BASE_EN
        },
        IA32_TIME_STAMP_COUNTER => set_tsc(low as u32, high as u32),
        IA32_BIOS_SIGN_ID => {},
        MISC_FEATURE_ENABLES => {
            // Linux 4, see: https://patchwork.kernel.org/patch/9528279/
        },
        IA32_MISC_ENABLE => {
            // Enable Misc. Processor Features
        },
        IA32_MCG_CAP => {}, // netbsd
        IA32_KERNEL_GS_BASE => {
            // Only used in 64 bit mode (by SWAPGS), but set by kvm-unit-test
            dbg_log!("GS Base written");
        },
        IA32_PAT => {},
        IA32_SPEC_CTRL => {},      // linux 5.19
        IA32_TSX_CTRL => {},       // linux 5.19
        MSR_TSX_FORCE_ABORT => {}, // linux 5.19
        IA32_MCU_OPT_CTRL => {},   // linux 5.19
        MSR_AMD64_LS_CFG => {},    // linux 5.19
        MSR_AMD64_DE_CFG => {},    // linux 6.1
        _ => {
            dbg_log!("Unknown msr: {:x}", index);
            dbg_assert!(false);
        },
    }
}

pub unsafe fn instr_0F31() {
    // rdtsc - read timestamp counter
    if 0 == *cpl || 0 == *cr.offset(4) & CR4_TSD {
        let tsc = read_tsc();
        write_reg32(EAX, tsc as i32);
        write_reg32(EDX, (tsc >> 32) as i32);
        if false {
            dbg_log!("rdtsc  edx:eax={:x}:{:x}", read_reg32(EDX), read_reg32(EAX));
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

    let index = read_reg32(ECX);
    dbg_log!("rdmsr ecx={:x}", index);

    let mut low = 0;
    let mut high = 0;

    match index {
        IA32_SYSENTER_CS => low = *sysenter_cs,
        IA32_SYSENTER_EIP => low = *sysenter_eip,
        IA32_SYSENTER_ESP => low = *sysenter_esp,
        IA32_TIME_STAMP_COUNTER => {
            let tsc = read_tsc();
            low = tsc as i32;
            high = (tsc >> 32) as i32
        },
        IA32_FEAT_CTL => {}, // linux 5.x
        MSR_TEST_CTRL => {}, // linux 5.x
        IA32_PLATFORM_ID => {},
        IA32_APIC_BASE => {
            if *acpi_enabled {
                low = APIC_ADDRESS;
                if *apic_enabled {
                    low |= IA32_APIC_BASE_EN
                }
            }
        },
        IA32_BIOS_SIGN_ID => {},
        MSR_PLATFORM_INFO => low = 1 << 8,
        MISC_FEATURE_ENABLES => {},
        IA32_MISC_ENABLE => {
            // Enable Misc. Processor Features
            low = 1 << 0; // fast string
        },
        IA32_RTIT_CTL => {
            // linux4
        },
        MSR_SMI_COUNT => {},
        IA32_MCG_CAP => {
            // netbsd
        },
        IA32_PAT => {},
        MSR_PKG_C2_RESIDENCY => {},
        IA32_SPEC_CTRL => {},      // linux 5.19
        IA32_TSX_CTRL => {},       // linux 5.19
        MSR_TSX_FORCE_ABORT => {}, // linux 5.19
        IA32_MCU_OPT_CTRL => {},   // linux 5.19
        MSR_AMD64_LS_CFG => {},    // linux 5.19
        MSR_AMD64_DE_CFG => {},    // linux 6.1
        _ => {
            dbg_log!("Unknown msr: {:x}", index);
            dbg_assert!(false);
        },
    }

    write_reg32(EAX, low);
    write_reg32(EDX, high);
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
        write_reg32(ESP, *sysenter_esp);
        *sreg.offset(CS as isize) = seg as u16;
        *segment_is_null.offset(CS as isize) = false;
        *segment_limits.offset(CS as isize) = -1i32 as u32;
        *segment_offsets.offset(CS as isize) = 0;
        *segment_access_bytes.offset(CS as isize) = 0x80 | (0 << 5) | 0x10 | 0x08 | 0x02; // P dpl0 S E RW
        update_cs_size(true);
        *cpl = 0;
        cpl_changed();
        *sreg.offset(SS as isize) = (seg + 8) as u16;
        *segment_is_null.offset(SS as isize) = false;
        *segment_limits.offset(SS as isize) = -1i32 as u32;
        *segment_offsets.offset(SS as isize) = 0;
        *segment_access_bytes.offset(SS as isize) = 0x80 | (0 << 5) | 0x10 | 0x02; // P dpl0 S RW
        *stack_size_32 = true;
        update_state_flags();
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
        *instruction_pointer = read_reg32(EDX);
        write_reg32(ESP, read_reg32(ECX));
        *sreg.offset(CS as isize) = (seg + 16 | 3) as u16;
        *segment_is_null.offset(CS as isize) = false;
        *segment_limits.offset(CS as isize) = -1i32 as u32;
        *segment_offsets.offset(CS as isize) = 0;
        *segment_access_bytes.offset(CS as isize) = 0x80 | (3 << 5) | 0x10 | 0x08 | 0x02; // P dpl3 S E RW
        update_cs_size(true);
        *cpl = 3;
        cpl_changed();
        *sreg.offset(SS as isize) = (seg + 24 | 3) as u16;
        *segment_is_null.offset(SS as isize) = false;
        *segment_limits.offset(SS as isize) = -1i32 as u32;
        *segment_offsets.offset(SS as isize) = 0;
        *segment_access_bytes.offset(SS as isize) = 0x80 | (3 << 5) | 0x10 | 0x02; // P dpl3 S RW
        *stack_size_32 = true;
        update_state_flags();
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

pub unsafe fn instr16_0F40_mem(addr: i32, r: i32) {
    cmovcc16(test_o(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F40_reg(r1: i32, r: i32) { cmovcc16(test_o(), read_reg16(r1), r); }
pub unsafe fn instr32_0F40_mem(addr: i32, r: i32) {
    cmovcc32(test_o(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F40_reg(r1: i32, r: i32) { cmovcc32(test_o(), read_reg32(r1), r); }
pub unsafe fn instr16_0F41_mem(addr: i32, r: i32) {
    cmovcc16(!test_o(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F41_reg(r1: i32, r: i32) { cmovcc16(!test_o(), read_reg16(r1), r); }
pub unsafe fn instr32_0F41_mem(addr: i32, r: i32) {
    cmovcc32(!test_o(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F41_reg(r1: i32, r: i32) { cmovcc32(!test_o(), read_reg32(r1), r); }
pub unsafe fn instr16_0F42_mem(addr: i32, r: i32) {
    cmovcc16(test_b(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F42_reg(r1: i32, r: i32) { cmovcc16(test_b(), read_reg16(r1), r); }
pub unsafe fn instr32_0F42_mem(addr: i32, r: i32) {
    cmovcc32(test_b(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F42_reg(r1: i32, r: i32) { cmovcc32(test_b(), read_reg32(r1), r); }
pub unsafe fn instr16_0F43_mem(addr: i32, r: i32) {
    cmovcc16(!test_b(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F43_reg(r1: i32, r: i32) { cmovcc16(!test_b(), read_reg16(r1), r); }
pub unsafe fn instr32_0F43_mem(addr: i32, r: i32) {
    cmovcc32(!test_b(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F43_reg(r1: i32, r: i32) { cmovcc32(!test_b(), read_reg32(r1), r); }
pub unsafe fn instr16_0F44_mem(addr: i32, r: i32) {
    cmovcc16(test_z(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F44_reg(r1: i32, r: i32) { cmovcc16(test_z(), read_reg16(r1), r); }
pub unsafe fn instr32_0F44_mem(addr: i32, r: i32) {
    cmovcc32(test_z(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F44_reg(r1: i32, r: i32) { cmovcc32(test_z(), read_reg32(r1), r); }
pub unsafe fn instr16_0F45_mem(addr: i32, r: i32) {
    cmovcc16(!test_z(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F45_reg(r1: i32, r: i32) { cmovcc16(!test_z(), read_reg16(r1), r); }
pub unsafe fn instr32_0F45_mem(addr: i32, r: i32) {
    cmovcc32(!test_z(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F45_reg(r1: i32, r: i32) { cmovcc32(!test_z(), read_reg32(r1), r); }
pub unsafe fn instr16_0F46_mem(addr: i32, r: i32) {
    cmovcc16(test_be(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F46_reg(r1: i32, r: i32) { cmovcc16(test_be(), read_reg16(r1), r); }
pub unsafe fn instr32_0F46_mem(addr: i32, r: i32) {
    cmovcc32(test_be(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F46_reg(r1: i32, r: i32) { cmovcc32(test_be(), read_reg32(r1), r); }
pub unsafe fn instr16_0F47_mem(addr: i32, r: i32) {
    cmovcc16(!test_be(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F47_reg(r1: i32, r: i32) { cmovcc16(!test_be(), read_reg16(r1), r); }
pub unsafe fn instr32_0F47_mem(addr: i32, r: i32) {
    cmovcc32(!test_be(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F47_reg(r1: i32, r: i32) { cmovcc32(!test_be(), read_reg32(r1), r); }
pub unsafe fn instr16_0F48_mem(addr: i32, r: i32) {
    cmovcc16(test_s(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F48_reg(r1: i32, r: i32) { cmovcc16(test_s(), read_reg16(r1), r); }
pub unsafe fn instr32_0F48_mem(addr: i32, r: i32) {
    cmovcc32(test_s(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F48_reg(r1: i32, r: i32) { cmovcc32(test_s(), read_reg32(r1), r); }
pub unsafe fn instr16_0F49_mem(addr: i32, r: i32) {
    cmovcc16(!test_s(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F49_reg(r1: i32, r: i32) { cmovcc16(!test_s(), read_reg16(r1), r); }
pub unsafe fn instr32_0F49_mem(addr: i32, r: i32) {
    cmovcc32(!test_s(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F49_reg(r1: i32, r: i32) { cmovcc32(!test_s(), read_reg32(r1), r); }
pub unsafe fn instr16_0F4A_mem(addr: i32, r: i32) {
    cmovcc16(test_p(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F4A_reg(r1: i32, r: i32) { cmovcc16(test_p(), read_reg16(r1), r); }
pub unsafe fn instr32_0F4A_mem(addr: i32, r: i32) {
    cmovcc32(test_p(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F4A_reg(r1: i32, r: i32) { cmovcc32(test_p(), read_reg32(r1), r); }
pub unsafe fn instr16_0F4B_mem(addr: i32, r: i32) {
    cmovcc16(!test_p(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F4B_reg(r1: i32, r: i32) { cmovcc16(!test_p(), read_reg16(r1), r); }
pub unsafe fn instr32_0F4B_mem(addr: i32, r: i32) {
    cmovcc32(!test_p(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F4B_reg(r1: i32, r: i32) { cmovcc32(!test_p(), read_reg32(r1), r); }
pub unsafe fn instr16_0F4C_mem(addr: i32, r: i32) {
    cmovcc16(test_l(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F4C_reg(r1: i32, r: i32) { cmovcc16(test_l(), read_reg16(r1), r); }
pub unsafe fn instr32_0F4C_mem(addr: i32, r: i32) {
    cmovcc32(test_l(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F4C_reg(r1: i32, r: i32) { cmovcc32(test_l(), read_reg32(r1), r); }
pub unsafe fn instr16_0F4D_mem(addr: i32, r: i32) {
    cmovcc16(!test_l(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F4D_reg(r1: i32, r: i32) { cmovcc16(!test_l(), read_reg16(r1), r); }
pub unsafe fn instr32_0F4D_mem(addr: i32, r: i32) {
    cmovcc32(!test_l(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F4D_reg(r1: i32, r: i32) { cmovcc32(!test_l(), read_reg32(r1), r); }
pub unsafe fn instr16_0F4E_mem(addr: i32, r: i32) {
    cmovcc16(test_le(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F4E_reg(r1: i32, r: i32) { cmovcc16(test_le(), read_reg16(r1), r); }
pub unsafe fn instr32_0F4E_mem(addr: i32, r: i32) {
    cmovcc32(test_le(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F4E_reg(r1: i32, r: i32) { cmovcc32(test_le(), read_reg32(r1), r); }
pub unsafe fn instr16_0F4F_mem(addr: i32, r: i32) {
    cmovcc16(!test_le(), return_on_pagefault!(safe_read16(addr)), r);
}
pub unsafe fn instr16_0F4F_reg(r1: i32, r: i32) { cmovcc16(!test_le(), read_reg16(r1), r); }
pub unsafe fn instr32_0F4F_mem(addr: i32, r: i32) {
    cmovcc32(!test_le(), return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr32_0F4F_reg(r1: i32, r: i32) { cmovcc32(!test_le(), read_reg32(r1), r); }

#[no_mangle]
pub unsafe fn instr_0F50_reg(r1: i32, r2: i32) {
    // movmskps r, xmm
    let source = read_xmm128s(r1);
    let data = (source.u32[0] >> 31
        | source.u32[1] >> 31 << 1
        | source.u32[2] >> 31 << 2
        | source.u32[3] >> 31 << 3) as i32;
    write_reg32(r2, data);
}
#[no_mangle]
pub unsafe fn instr_0F50_mem(_addr: i32, _r1: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F50_reg(r1: i32, r2: i32) {
    // movmskpd r, xmm
    let source = read_xmm128s(r1);
    let data = (source.u32[1] >> 31 | source.u32[3] >> 31 << 1) as i32;
    write_reg32(r2, data);
}
#[no_mangle]
pub unsafe fn instr_660F50_mem(_addr: i32, _r1: i32) { trigger_ud(); }

#[no_mangle]
pub unsafe fn instr_0F51(source: reg128, r: i32) {
    // sqrtps xmm, xmm/mem128
    // XXX: Should round according to round control
    let result = reg128 {
        f32: [
            source.f32[0].sqrt(),
            source.f32[1].sqrt(),
            source.f32[2].sqrt(),
            source.f32[3].sqrt(),
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0F51_reg(r1: i32, r2: i32) { instr_0F51(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F51_mem(addr: i32, r: i32) {
    instr_0F51(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F51(source: reg128, r: i32) {
    // sqrtpd xmm, xmm/mem128
    // XXX: Should round according to round control
    let result = reg128 {
        f64: [source.f64[0].sqrt(), source.f64[1].sqrt()],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F51_reg(r1: i32, r2: i32) { instr_660F51(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F51_mem(addr: i32, r: i32) {
    instr_660F51(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F51(source: u64, r: i32) {
    // sqrtsd xmm, xmm/mem64
    // XXX: Should round according to round control
    write_xmm_f64(r, f64::from_bits(source).sqrt());
}
pub unsafe fn instr_F20F51_reg(r1: i32, r2: i32) { instr_F20F51(read_xmm64s(r1), r2); }
pub unsafe fn instr_F20F51_mem(addr: i32, r: i32) {
    instr_F20F51(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F51(source: f32, r: i32) {
    // sqrtss xmm, xmm/mem32
    // XXX: Should round according to round control
    write_xmm_f32(r, source.sqrt());
}
pub unsafe fn instr_F30F51_reg(r1: i32, r2: i32) { instr_F30F51(read_xmm_f32(r1), r2); }
pub unsafe fn instr_F30F51_mem(addr: i32, r: i32) {
    instr_F30F51(return_on_pagefault!(safe_read_f32(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F52(source: reg128, r: i32) {
    // rcpps xmm1, xmm2/m128
    let result = reg128 {
        f32: [
            1.0 / source.f32[0].sqrt(),
            1.0 / source.f32[1].sqrt(),
            1.0 / source.f32[2].sqrt(),
            1.0 / source.f32[3].sqrt(),
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0F52_reg(r1: i32, r2: i32) { instr_0F52(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F52_mem(addr: i32, r: i32) {
    instr_0F52(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F52(source: f32, r: i32) {
    // rsqrtss xmm1, xmm2/m32
    write_xmm_f32(r, 1.0 / source.sqrt());
}
pub unsafe fn instr_F30F52_reg(r1: i32, r2: i32) { instr_F30F52(read_xmm_f32(r1), r2); }
pub unsafe fn instr_F30F52_mem(addr: i32, r: i32) {
    instr_F30F52(return_on_pagefault!(safe_read_f32(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F53(source: reg128, r: i32) {
    // rcpps xmm, xmm/m128
    let result = reg128 {
        f32: [
            1.0 / source.f32[0],
            1.0 / source.f32[1],
            1.0 / source.f32[2],
            1.0 / source.f32[3],
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0F53_reg(r1: i32, r2: i32) { instr_0F53(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F53_mem(addr: i32, r: i32) {
    instr_0F53(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F53(source: f32, r: i32) {
    // rcpss xmm, xmm/m32
    write_xmm_f32(r, 1.0 / source);
}
pub unsafe fn instr_F30F53_reg(r1: i32, r2: i32) { instr_F30F53(read_xmm_f32(r1), r2); }
pub unsafe fn instr_F30F53_mem(addr: i32, r: i32) {
    instr_F30F53(return_on_pagefault!(safe_read_f32(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F54(source: reg128, r: i32) {
    // andps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pand_r128(source, r);
}
pub unsafe fn instr_0F54_reg(r1: i32, r2: i32) { instr_0F54(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F54_mem(addr: i32, r: i32) {
    instr_0F54(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F54(source: reg128, r: i32) {
    // andpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pand_r128(source, r);
}
pub unsafe fn instr_660F54_reg(r1: i32, r2: i32) { instr_660F54(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F54_mem(addr: i32, r: i32) {
    instr_660F54(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F55(source: reg128, r: i32) {
    // andnps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pandn_r128(source, r);
}
pub unsafe fn instr_0F55_reg(r1: i32, r2: i32) { instr_0F55(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F55_mem(addr: i32, r: i32) {
    instr_0F55(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F55(source: reg128, r: i32) {
    // andnpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pandn_r128(source, r);
}
pub unsafe fn instr_660F55_reg(r1: i32, r2: i32) { instr_660F55(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F55_mem(addr: i32, r: i32) {
    instr_660F55(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F56(source: reg128, r: i32) {
    // orps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    por_r128(source, r);
}
pub unsafe fn instr_0F56_reg(r1: i32, r2: i32) { instr_0F56(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F56_mem(addr: i32, r: i32) {
    instr_0F56(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F56(source: reg128, r: i32) {
    // orpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    por_r128(source, r);
}
pub unsafe fn instr_660F56_reg(r1: i32, r2: i32) { instr_660F56(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F56_mem(addr: i32, r: i32) {
    instr_660F56(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F57(source: reg128, r: i32) {
    // xorps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pxor_r128(source, r);
}
pub unsafe fn instr_0F57_reg(r1: i32, r2: i32) { instr_0F57(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F57_mem(addr: i32, r: i32) {
    instr_0F57(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F57(source: reg128, r: i32) {
    // xorpd xmm, xmm/mem128
    // XXX: Aligned access or #gp
    pxor_r128(source, r);
}
pub unsafe fn instr_660F57_reg(r1: i32, r2: i32) { instr_660F57(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F57_mem(addr: i32, r: i32) {
    instr_660F57(return_on_pagefault!(safe_read128s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F58(source: reg128, r: i32) {
    // addps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32: [
            source.f32[0] + destination.f32[0],
            source.f32[1] + destination.f32[1],
            source.f32[2] + destination.f32[2],
            source.f32[3] + destination.f32[3],
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0F58_reg(r1: i32, r2: i32) { instr_0F58(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F58_mem(addr: i32, r: i32) {
    instr_0F58(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F58(source: reg128, r: i32) {
    // addpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64: [
            source.f64[0] + destination.f64[0],
            source.f64[1] + destination.f64[1],
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F58_reg(r1: i32, r2: i32) { instr_660F58(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F58_mem(addr: i32, r: i32) {
    instr_660F58(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F58(source: u64, r: i32) {
    // addsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    write_xmm_f64(r, f64::from_bits(source) + f64::from_bits(destination));
}
pub unsafe fn instr_F20F58_reg(r1: i32, r2: i32) { instr_F20F58(read_xmm64s(r1), r2); }
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
pub unsafe fn instr_F30F58_reg(r1: i32, r2: i32) { instr_F30F58(read_xmm_f32(r1), r2); }
pub unsafe fn instr_F30F58_mem(addr: i32, r: i32) {
    instr_F30F58(return_on_pagefault!(safe_read_f32(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F59(source: reg128, r: i32) {
    // mulps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32: [
            source.f32[0] * destination.f32[0],
            source.f32[1] * destination.f32[1],
            source.f32[2] * destination.f32[2],
            source.f32[3] * destination.f32[3],
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0F59_reg(r1: i32, r2: i32) { instr_0F59(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F59_mem(addr: i32, r: i32) {
    instr_0F59(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F59(source: reg128, r: i32) {
    // mulpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64: [
            source.f64[0] * destination.f64[0],
            source.f64[1] * destination.f64[1],
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F59_reg(r1: i32, r2: i32) { instr_660F59(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F59_mem(addr: i32, r: i32) {
    instr_660F59(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F59(source: u64, r: i32) {
    // mulsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    write_xmm_f64(r, f64::from_bits(source) * f64::from_bits(destination));
}
pub unsafe fn instr_F20F59_reg(r1: i32, r2: i32) { instr_F20F59(read_xmm64s(r1), r2); }
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
pub unsafe fn instr_F30F59_reg(r1: i32, r2: i32) { instr_F30F59(read_xmm_f32(r1), r2); }
pub unsafe fn instr_F30F59_mem(addr: i32, r: i32) {
    instr_F30F59(return_on_pagefault!(safe_read_f32(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F5A(source: u64, r: i32) {
    // cvtps2pd xmm1, xmm2/m64
    let source: [f32; 2] = std::mem::transmute(source);
    let result = reg128 {
        f64: [source[0] as f64, source[1] as f64],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0F5A_reg(r1: i32, r2: i32) { instr_0F5A(read_xmm64s(r1), r2); }
pub unsafe fn instr_0F5A_mem(addr: i32, r: i32) {
    instr_0F5A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5A(source: reg128, r: i32) {
    // cvtpd2ps xmm1, xmm2/m128
    let result = reg128 {
        // XXX: These conversions are lossy and should round according to the round control
        f32: [source.f64[0] as f32, source.f64[1] as f32, 0., 0.],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F5A_reg(r1: i32, r2: i32) { instr_660F5A(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F5A_mem(addr: i32, r: i32) {
    instr_660F5A(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5A(source: u64, r: i32) {
    // cvtsd2ss xmm1, xmm2/m64
    // XXX: This conversions is lossy and should round according to the round control
    write_xmm_f32(r, f64::from_bits(source) as f32);
}
pub unsafe fn instr_F20F5A_reg(r1: i32, r2: i32) { instr_F20F5A(read_xmm64s(r1), r2); }
pub unsafe fn instr_F20F5A_mem(addr: i32, r: i32) {
    instr_F20F5A(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5A(source: f32, r: i32) {
    // cvtss2sd xmm1, xmm2/m32
    write_xmm_f64(r, source as f64);
}
pub unsafe fn instr_F30F5A_reg(r1: i32, r2: i32) { instr_F30F5A(read_xmm_f32(r1), r2); }
pub unsafe fn instr_F30F5A_mem(addr: i32, r: i32) {
    instr_F30F5A(return_on_pagefault!(safe_read_f32(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F5B(source: reg128, r: i32) {
    // cvtdq2ps xmm1, xmm2/m128
    // XXX: Should round according to round control
    let result = reg128 {
        f32: [
            // XXX: Precision exception
            source.i32[0] as f32,
            source.i32[1] as f32,
            source.i32[2] as f32,
            source.i32[3] as f32,
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0F5B_reg(r1: i32, r2: i32) { instr_0F5B(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F5B_mem(addr: i32, r: i32) {
    instr_0F5B(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5B(source: reg128, r: i32) {
    // cvtps2dq xmm1, xmm2/m128
    let result = reg128 {
        i32: [
            // XXX: Precision exception
            sse_convert_f32_to_i32(source.f32[0]),
            sse_convert_f32_to_i32(source.f32[1]),
            sse_convert_f32_to_i32(source.f32[2]),
            sse_convert_f32_to_i32(source.f32[3]),
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F5B_reg(r1: i32, r2: i32) { instr_660F5B(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F5B_mem(addr: i32, r: i32) {
    instr_660F5B(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F30F5B(source: reg128, r: i32) {
    // cvttps2dq xmm1, xmm2/m128
    let result = reg128 {
        i32: [
            sse_convert_with_truncation_f32_to_i32(source.f32[0]),
            sse_convert_with_truncation_f32_to_i32(source.f32[1]),
            sse_convert_with_truncation_f32_to_i32(source.f32[2]),
            sse_convert_with_truncation_f32_to_i32(source.f32[3]),
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_F30F5B_reg(r1: i32, r2: i32) { instr_F30F5B(read_xmm128s(r1), r2); }
pub unsafe fn instr_F30F5B_mem(addr: i32, r: i32) {
    instr_F30F5B(return_on_pagefault!(safe_read128s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F5C(source: reg128, r: i32) {
    // subps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32: [
            destination.f32[0] - source.f32[0],
            destination.f32[1] - source.f32[1],
            destination.f32[2] - source.f32[2],
            destination.f32[3] - source.f32[3],
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0F5C_reg(r1: i32, r2: i32) { instr_0F5C(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F5C_mem(addr: i32, r: i32) {
    instr_0F5C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5C(source: reg128, r: i32) {
    // subpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64: [
            destination.f64[0] - source.f64[0],
            destination.f64[1] - source.f64[1],
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F5C_reg(r1: i32, r2: i32) { instr_660F5C(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F5C_mem(addr: i32, r: i32) {
    instr_660F5C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5C(source: u64, r: i32) {
    // subsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    write_xmm_f64(r, f64::from_bits(destination) - f64::from_bits(source));
}
pub unsafe fn instr_F20F5C_reg(r1: i32, r2: i32) { instr_F20F5C(read_xmm64s(r1), r2); }
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
pub unsafe fn instr_F30F5C_reg(r1: i32, r2: i32) { instr_F30F5C(read_xmm_f32(r1), r2); }
pub unsafe fn instr_F30F5C_mem(addr: i32, r: i32) {
    instr_F30F5C(return_on_pagefault!(safe_read_f32(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F5D(source: reg128, r: i32) {
    // minps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32: [
            sse_min(destination.f32[0] as f64, source.f32[0] as f64) as f32,
            sse_min(destination.f32[1] as f64, source.f32[1] as f64) as f32,
            sse_min(destination.f32[2] as f64, source.f32[2] as f64) as f32,
            sse_min(destination.f32[3] as f64, source.f32[3] as f64) as f32,
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0F5D_reg(r1: i32, r2: i32) { instr_0F5D(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F5D_mem(addr: i32, r: i32) {
    instr_0F5D(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5D(source: reg128, r: i32) {
    // minpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64: [
            sse_min(destination.f64[0], source.f64[0]),
            sse_min(destination.f64[1], source.f64[1]),
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F5D_reg(r1: i32, r2: i32) { instr_660F5D(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F5D_mem(addr: i32, r: i32) {
    instr_660F5D(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5D(source: u64, r: i32) {
    // minsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    write_xmm_f64(
        r,
        sse_min(f64::from_bits(destination), f64::from_bits(source)),
    );
}
pub unsafe fn instr_F20F5D_reg(r1: i32, r2: i32) { instr_F20F5D(read_xmm64s(r1), r2); }
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
pub unsafe fn instr_F30F5D_reg(r1: i32, r2: i32) { instr_F30F5D(read_xmm_f32(r1), r2); }
pub unsafe fn instr_F30F5D_mem(addr: i32, r: i32) {
    instr_F30F5D(return_on_pagefault!(safe_read_f32(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F5E(source: reg128, r: i32) {
    // divps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32: [
            destination.f32[0] / source.f32[0],
            destination.f32[1] / source.f32[1],
            destination.f32[2] / source.f32[2],
            destination.f32[3] / source.f32[3],
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0F5E_reg(r1: i32, r2: i32) { instr_0F5E(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F5E_mem(addr: i32, r: i32) {
    instr_0F5E(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5E(source: reg128, r: i32) {
    // divpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64: [
            destination.f64[0] / source.f64[0],
            destination.f64[1] / source.f64[1],
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F5E_reg(r1: i32, r2: i32) { instr_660F5E(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F5E_mem(addr: i32, r: i32) {
    instr_660F5E(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5E(source: u64, r: i32) {
    // divsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    write_xmm_f64(r, f64::from_bits(destination) / f64::from_bits(source));
}
pub unsafe fn instr_F20F5E_reg(r1: i32, r2: i32) { instr_F20F5E(read_xmm64s(r1), r2); }
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
pub unsafe fn instr_F30F5E_reg(r1: i32, r2: i32) { instr_F30F5E(read_xmm_f32(r1), r2); }
pub unsafe fn instr_F30F5E_mem(addr: i32, r: i32) {
    instr_F30F5E(return_on_pagefault!(safe_read_f32(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F5F(source: reg128, r: i32) {
    // maxps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f32: [
            sse_max(destination.f32[0] as f64, source.f32[0] as f64) as f32,
            sse_max(destination.f32[1] as f64, source.f32[1] as f64) as f32,
            sse_max(destination.f32[2] as f64, source.f32[2] as f64) as f32,
            sse_max(destination.f32[3] as f64, source.f32[3] as f64) as f32,
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0F5F_reg(r1: i32, r2: i32) { instr_0F5F(read_xmm128s(r1), r2); }
pub unsafe fn instr_0F5F_mem(addr: i32, r: i32) {
    instr_0F5F(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F5F(source: reg128, r: i32) {
    // maxpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        f64: [
            sse_max(destination.f64[0], source.f64[0]),
            sse_max(destination.f64[1], source.f64[1]),
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F5F_reg(r1: i32, r2: i32) { instr_660F5F(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F5F_mem(addr: i32, r: i32) {
    instr_660F5F(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F5F(source: u64, r: i32) {
    // maxsd xmm, xmm/mem64
    let destination = read_xmm64s(r);
    write_xmm_f64(
        r,
        sse_max(f64::from_bits(destination), f64::from_bits(source)),
    );
}
pub unsafe fn instr_F20F5F_reg(r1: i32, r2: i32) { instr_F20F5F(read_xmm64s(r1), r2); }
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
pub unsafe fn instr_F30F5F_reg(r1: i32, r2: i32) { instr_F30F5F(read_xmm_f32(r1), r2); }
pub unsafe fn instr_F30F5F_mem(addr: i32, r: i32) {
    instr_F30F5F(return_on_pagefault!(safe_read_f32(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F60(source: i32, r: i32) {
    // punpcklbw mm, mm/m32
    let destination: [u8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [u8; 4] = std::mem::transmute(source);
    let mut result = [0; 8];
    for i in 0..4 {
        result[2 * i + 0] = destination[i];
        result[2 * i + 1] = source[i];
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F60_reg(r1: i32, r2: i32) { instr_0F60(read_mmx32s(r1), r2); }
pub unsafe fn instr_0F60_mem(addr: i32, r: i32) {
    instr_0F60(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F60(source: reg128, r: i32) {
    // punpcklbw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination: [u8; 8] = std::mem::transmute(read_xmm64s(r));
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u8[2 * i + 0] = destination[i];
        result.u8[2 * i + 1] = source.u8[i];
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F60_reg(r1: i32, r2: i32) { instr_660F60(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F60_mem(addr: i32, r: i32) {
    instr_660F60(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F61(source: i32, r: i32) {
    // punpcklwd mm, mm/m32
    let destination: [u16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [u16; 2] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..2 {
        result[2 * i + 0] = destination[i];
        result[2 * i + 1] = source[i];
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F61_reg(r1: i32, r2: i32) { instr_0F61(read_mmx32s(r1), r2); }
pub unsafe fn instr_0F61_mem(addr: i32, r: i32) {
    instr_0F61(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F61(source: reg128, r: i32) {
    // punpcklwd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination: [u16; 4] = std::mem::transmute(read_xmm64s(r));
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..4 {
        result.u16[2 * i + 0] = destination[i];
        result.u16[2 * i + 1] = source.u16[i];
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F61_reg(r1: i32, r2: i32) { instr_660F61(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F61_mem(addr: i32, r: i32) {
    instr_660F61(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F62(source: i32, r: i32) {
    // punpckldq mm, mm/m32
    let destination = read_mmx64s(r);
    write_mmx_reg64(
        r,
        (destination & 0xFFFF_FFFF) | (source as u32 as u64) << 32,
    );
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F62_reg(r1: i32, r2: i32) { instr_0F62(read_mmx32s(r1), r2); }
pub unsafe fn instr_0F62_mem(addr: i32, r: i32) {
    instr_0F62(return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr_660F62(source: reg128, r: i32) {
    // punpckldq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32[0] as i32,
        source.u32[0] as i32,
        destination.u32[1] as i32,
        source.u32[1] as i32,
    );
}
pub unsafe fn instr_660F62_reg(r1: i32, r2: i32) { instr_660F62(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F62_mem(addr: i32, r: i32) {
    instr_660F62(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F63(source: u64, r: i32) {
    // packsswb mm, mm/m64
    let destination: [u16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [u16; 4] = std::mem::transmute(source);
    let mut result: [u8; 8] = [0; 8];
    for i in 0..4 {
        result[i + 0] = saturate_sw_to_sb(destination[i] as i32);
        result[i + 4] = saturate_sw_to_sb(source[i] as i32);
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F63_reg(r1: i32, r2: i32) { instr_0F63(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F63_mem(addr: i32, r: i32) {
    instr_0F63(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F63(source: reg128, r: i32) {
    // packsswb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u8[i + 0] = saturate_sw_to_sb(destination.u16[i] as i32);
        result.u8[i + 8] = saturate_sw_to_sb(source.u16[i] as i32);
    }
    write_xmm_reg128(r, result)
}
pub unsafe fn instr_660F63_reg(r1: i32, r2: i32) { instr_660F63(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F63_mem(addr: i32, r: i32) {
    instr_660F63(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F64(source: u64, r: i32) {
    // pcmpgtb mm, mm/m64
    let destination: [i8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [i8; 8] = std::mem::transmute(source);
    let mut result: [u8; 8] = [0; 8];
    for i in 0..8 {
        result[i] = if destination[i] > source[i] { 255 } else { 0 };
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F64_reg(r1: i32, r2: i32) { instr_0F64(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F64_mem(addr: i32, r: i32) {
    instr_0F64(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F64(source: reg128, r: i32) {
    // pcmpgtb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..16 {
        result.u8[i] = if destination.i8[i] as i32 > source.i8[i] as i32 { 255 } else { 0 };
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F64_reg(r1: i32, r2: i32) { instr_660F64(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F64_mem(addr: i32, r: i32) {
    instr_660F64(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F65(source: u64, r: i32) {
    // pcmpgtw mm, mm/m64
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [i16; 4] = std::mem::transmute(source);
    let mut result: [u16; 4] = [0; 4];
    for i in 0..4 {
        result[i] = if destination[i] > source[i] { 0xFFFF } else { 0 }
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F65_reg(r1: i32, r2: i32) { instr_0F65(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F65_mem(addr: i32, r: i32) {
    instr_0F65(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F65(source: reg128, r: i32) {
    // pcmpgtw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u16[i] = if destination.i16[i] > source.i16[i] { 0xFFFF } else { 0 };
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F65_reg(r1: i32, r2: i32) { instr_660F65(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F65_mem(addr: i32, r: i32) {
    instr_660F65(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F66(source: u64, r: i32) {
    // pcmpgtd mm, mm/m64
    let destination: [i32; 2] = std::mem::transmute(read_mmx64s(r));
    let source: [i32; 2] = std::mem::transmute(source);
    let mut result = [0; 2];
    for i in 0..2 {
        result[i] = if destination[i] > source[i] { -1 } else { 0 }
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F66_reg(r1: i32, r2: i32) { instr_0F66(read_mmx64s(r1), r2); }
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
        if destination.i32[0] > source.i32[0] { -1 } else { 0 },
        if destination.i32[1] > source.i32[1] { -1 } else { 0 },
        if destination.i32[2] > source.i32[2] { -1 } else { 0 },
        if destination.i32[3] > source.i32[3] { -1 } else { 0 },
    );
}
pub unsafe fn instr_660F66_reg(r1: i32, r2: i32) { instr_660F66(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F66_mem(addr: i32, r: i32) {
    instr_660F66(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F67(source: u64, r: i32) {
    // packuswb mm, mm/m64
    let destination: [u16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [u16; 4] = std::mem::transmute(source);
    let mut result = [0; 8];
    for i in 0..4 {
        result[i + 0] = saturate_sw_to_ub(destination[i]);
        result[i + 4] = saturate_sw_to_ub(source[i]);
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F67_reg(r1: i32, r2: i32) { instr_0F67(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F67_mem(addr: i32, r: i32) {
    instr_0F67(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F67(source: reg128, r: i32) {
    // packuswb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u8[i + 0] = saturate_sw_to_ub(destination.u16[i]);
        result.u8[i + 8] = saturate_sw_to_ub(source.u16[i]);
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F67_reg(r1: i32, r2: i32) { instr_660F67(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F67_mem(addr: i32, r: i32) {
    instr_660F67(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F68(source: u64, r: i32) {
    // punpckhbw mm, mm/m64
    let destination: [u8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [u8; 8] = std::mem::transmute(source);
    let mut result: [u8; 8] = [0; 8];
    for i in 0..4 {
        result[2 * i + 0] = destination[i + 4];
        result[2 * i + 1] = source[i + 4];
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F68_reg(r1: i32, r2: i32) { instr_0F68(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F68_mem(addr: i32, r: i32) {
    instr_0F68(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F68(source: reg128, r: i32) {
    // punpckhbw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u8[2 * i + 0] = destination.u8[i + 8];
        result.u8[2 * i + 1] = source.u8[i + 8];
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F68_reg(r1: i32, r2: i32) { instr_660F68(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F68_mem(addr: i32, r: i32) {
    instr_660F68(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F69(source: u64, r: i32) {
    // punpckhwd mm, mm/m64
    let destination: [u16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [u16; 4] = std::mem::transmute(source);
    let result = [destination[2], source[2], destination[3], source[3]];
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F69_reg(r1: i32, r2: i32) { instr_0F69(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F69_mem(addr: i32, r: i32) {
    instr_0F69(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F69(source: reg128, r: i32) {
    // punpckhwd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..4 {
        result.u16[2 * i + 0] = destination.u16[i + 4];
        result.u16[2 * i + 1] = source.u16[i + 4];
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F69_reg(r1: i32, r2: i32) { instr_660F69(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F69_mem(addr: i32, r: i32) {
    instr_660F69(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6A(source: u64, r: i32) {
    // punpckhdq mm, mm/m64
    let destination = read_mmx64s(r);
    write_mmx_reg64(r, (destination >> 32) | (source >> 32 << 32));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F6A_reg(r1: i32, r2: i32) { instr_0F6A(read_mmx64s(r1), r2); }
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
        destination.u32[2] as i32,
        source.u32[2] as i32,
        destination.u32[3] as i32,
        source.u32[3] as i32,
    );
}
pub unsafe fn instr_660F6A_reg(r1: i32, r2: i32) { instr_660F6A(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F6A_mem(addr: i32, r: i32) {
    instr_660F6A(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6B(source: u64, r: i32) {
    // packssdw mm, mm/m64
    let destination: [u32; 2] = std::mem::transmute(read_mmx64s(r));
    let source: [u32; 2] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..2 {
        result[i + 0] = saturate_sd_to_sw(destination[i]);
        result[i + 2] = saturate_sd_to_sw(source[i]);
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F6B_reg(r1: i32, r2: i32) { instr_0F6B(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F6B_mem(addr: i32, r: i32) {
    instr_0F6B(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F6B(source: reg128, r: i32) {
    // packssdw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..4 {
        result.u16[i + 0] = saturate_sd_to_sw(destination.u32[i]);
        result.u16[i + 4] = saturate_sd_to_sw(source.u32[i]);
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F6B_reg(r1: i32, r2: i32) { instr_660F6B(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F6B_mem(addr: i32, r: i32) {
    instr_660F6B(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6C_mem(_addr: i32, _r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F6C_reg(_r1: i32, _r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F6C(source: reg128, r: i32) {
    // punpcklqdq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32[0] as i32,
        destination.u32[1] as i32,
        source.u32[0] as i32,
        source.u32[1] as i32,
    );
}
pub unsafe fn instr_660F6C_reg(r1: i32, r2: i32) { instr_660F6C(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F6C_mem(addr: i32, r: i32) {
    instr_660F6C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6D_mem(_addr: i32, _r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0F6D_reg(_r1: i32, _r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F6D(source: reg128, r: i32) {
    // punpckhqdq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32[2] as i32,
        destination.u32[3] as i32,
        source.u32[2] as i32,
        source.u32[3] as i32,
    );
}
pub unsafe fn instr_660F6D_reg(r1: i32, r2: i32) { instr_660F6D(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F6D_mem(addr: i32, r: i32) {
    instr_660F6D(return_on_pagefault!(safe_read128s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F6E(source: i32, r: i32) {
    // movd mm, r/m32
    write_mmx_reg64(r, source as u32 as u64);
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F6E_reg(r1: i32, r2: i32) { instr_0F6E(read_reg32(r1), r2); }
pub unsafe fn instr_0F6E_mem(addr: i32, r: i32) {
    instr_0F6E(return_on_pagefault!(safe_read32s(addr)), r);
}
pub unsafe fn instr_660F6E(source: i32, r: i32) {
    // movd mm, r/m32
    write_xmm128(r, source, 0, 0, 0);
}
pub unsafe fn instr_660F6E_reg(r1: i32, r2: i32) { instr_660F6E(read_reg32(r1), r2); }
pub unsafe fn instr_660F6E_mem(addr: i32, r: i32) {
    instr_660F6E(return_on_pagefault!(safe_read32s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F6F(source: u64, r: i32) {
    // movq mm, mm/m64
    write_mmx_reg64(r, source);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_0F6F_reg(r1: i32, r2: i32) { instr_0F6F(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F6F_mem(addr: i32, r: i32) {
    instr_0F6F(return_on_pagefault!(safe_read64s(addr)), r);
}
pub unsafe fn instr_660F6F(source: reg128, r: i32) {
    // movdqa xmm, xmm/mem128
    // XXX: Aligned access or #gp
    mov_rm_r128(source, r);
}
pub unsafe fn instr_660F6F_reg(r1: i32, r2: i32) { instr_660F6F(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F6F_mem(addr: i32, r: i32) {
    instr_660F6F(return_on_pagefault!(safe_read128s(addr)), r);
}
pub unsafe fn instr_F30F6F(source: reg128, r: i32) {
    // movdqu xmm, xmm/m128
    mov_rm_r128(source, r);
}
pub unsafe fn instr_F30F6F_reg(r1: i32, r2: i32) { instr_F30F6F(read_xmm128s(r1), r2); }
pub unsafe fn instr_F30F6F_mem(addr: i32, r: i32) {
    instr_F30F6F(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F70(source: u64, r: i32, imm8: i32) {
    // pshufw mm1, mm2/m64, imm8
    let source: [u16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = source[(imm8 >> (2 * i) & 3) as usize]
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F70_reg(r1: i32, r2: i32, imm: i32) { instr_0F70(read_mmx64s(r1), r2, imm); }
pub unsafe fn instr_0F70_mem(addr: i32, r: i32, imm: i32) {
    instr_0F70(return_on_pagefault!(safe_read64s(addr)), r, imm);
}
pub unsafe fn instr_660F70(source: reg128, r: i32, imm8: i32) {
    // pshufd xmm, xmm/mem128, imm8
    // XXX: Aligned access or #gp
    write_xmm128(
        r,
        source.u32[(imm8 & 3) as usize] as i32,
        source.u32[(imm8 >> 2 & 3) as usize] as i32,
        source.u32[(imm8 >> 4 & 3) as usize] as i32,
        source.u32[(imm8 >> 6 & 3) as usize] as i32,
    );
}
pub unsafe fn instr_660F70_reg(r1: i32, r2: i32, imm: i32) {
    instr_660F70(read_xmm128s(r1), r2, imm);
}
pub unsafe fn instr_660F70_mem(addr: i32, r: i32, imm: i32) {
    instr_660F70(return_on_pagefault!(safe_read128s(addr)), r, imm);
}

#[no_mangle]
pub unsafe fn instr_F20F70(source: reg128, r: i32, imm8: i32) {
    // pshuflw xmm, xmm/m128, imm8
    // XXX: Aligned access or #gp
    write_xmm128(
        r,
        source.u16[(imm8 & 3) as usize] as i32
            | (source.u16[(imm8 >> 2 & 3) as usize] as i32) << 16,
        source.u16[(imm8 >> 4 & 3) as usize] as i32
            | (source.u16[(imm8 >> 6 & 3) as usize] as i32) << 16,
        source.u32[2] as i32,
        source.u32[3] as i32,
    );
}
pub unsafe fn instr_F20F70_reg(r1: i32, r2: i32, imm: i32) {
    instr_F20F70(read_xmm128s(r1), r2, imm);
}
pub unsafe fn instr_F20F70_mem(addr: i32, r: i32, imm: i32) {
    instr_F20F70(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_F30F70(source: reg128, r: i32, imm8: i32) {
    // pshufhw xmm, xmm/m128, imm8
    // XXX: Aligned access or #gp
    write_xmm128(
        r,
        source.u32[0] as i32,
        source.u32[1] as i32,
        source.u16[(imm8 & 3 | 4) as usize] as i32
            | (source.u16[(imm8 >> 2 & 3 | 4) as usize] as i32) << 16,
        source.u16[(imm8 >> 4 & 3 | 4) as usize] as i32
            | (source.u16[(imm8 >> 6 & 3 | 4) as usize] as i32) << 16,
    );
}
pub unsafe fn instr_F30F70_reg(r1: i32, r2: i32, imm: i32) {
    instr_F30F70(read_xmm128s(r1), r2, imm);
}
pub unsafe fn instr_F30F70_mem(addr: i32, r: i32, imm: i32) {
    instr_F30F70(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
pub unsafe fn instr_0F71_2_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_0F71_4_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_0F71_6_mem(_addr: i32, _r: i32) { trigger_ud(); }
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
pub unsafe fn instr_660F71_2_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_660F71_4_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_660F71_6_mem(_addr: i32, _r: i32) { trigger_ud(); }
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
pub unsafe fn instr_0F72_2_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_0F72_4_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_0F72_6_mem(_addr: i32, _r: i32) { trigger_ud(); }
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
pub unsafe fn instr_660F72_2_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_660F72_4_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_660F72_6_mem(_addr: i32, _r: i32) { trigger_ud(); }
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
pub unsafe fn instr_0F73_2_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_0F73_6_mem(_addr: i32, _r: i32) { trigger_ud(); }
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
pub unsafe fn instr_660F73_2_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_660F73_3_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_660F73_6_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr_660F73_7_mem(_addr: i32, _r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660F73_2_reg(r: i32, imm8: i32) {
    // psrlq xmm, imm8
    psrlq_r128(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_660F73_3_reg(r: i32, imm8: i32) {
    // psrldq xmm, imm8
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    if imm8 == 0 {
        return;
    }
    let shift = (if imm8 > 15 { 128 } else { imm8 << 3 }) as u32;
    if shift <= 63 {
        result.u64[0] = destination.u64[0] >> shift | destination.u64[1] << (64 - shift);
        result.u64[1] = destination.u64[1] >> shift
    }
    else if shift <= 127 {
        result.u64[0] = destination.u64[1] >> (shift - 64);
        result.u64[1] = 0
    }
    write_xmm_reg128(r, result);
}
#[no_mangle]
pub unsafe fn instr_660F73_6_reg(r: i32, imm8: i32) {
    // psllq xmm, imm8
    psllq_r128(r, imm8 as u64);
}
#[no_mangle]
pub unsafe fn instr_660F73_7_reg(r: i32, imm8: i32) {
    // pslldq xmm, imm8
    if imm8 == 0 {
        return;
    }
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    let shift = (if imm8 > 15 { 128 } else { imm8 << 3 }) as u32;
    if shift <= 63 {
        result.u64[0] = destination.u64[0] << shift;
        result.u64[1] = destination.u64[1] << shift | destination.u64[0] >> (64 - shift)
    }
    else if shift <= 127 {
        result.u64[0] = 0;
        result.u64[1] = destination.u64[0] << (shift - 64)
    }
    write_xmm_reg128(r, result);
}

#[no_mangle]
pub unsafe fn instr_0F74(source: u64, r: i32) {
    // pcmpeqb mm, mm/m64
    let destination: [u8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [u8; 8] = std::mem::transmute(source);
    let mut result: [u8; 8] = [0; 8];
    for i in 0..8 {
        result[i] = if destination[i] == source[i] { 255 } else { 0 };
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F74_reg(r1: i32, r2: i32) { instr_0F74(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F74_mem(addr: i32, r: i32) {
    instr_0F74(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F74(source: reg128, r: i32) {
    // pcmpeqb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..16 {
        result.u8[i] = if source.u8[i] == destination.u8[i] { 255 } else { 0 }
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F74_reg(r1: i32, r2: i32) { instr_660F74(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F74_mem(addr: i32, r: i32) {
    instr_660F74(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F75(source: u64, r: i32) {
    // pcmpeqw mm, mm/m64
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [i16; 4] = std::mem::transmute(source);
    let mut result: [u16; 4] = [0; 4];
    for i in 0..4 {
        result[i] = if destination[i] == source[i] { 0xFFFF } else { 0 };
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F75_reg(r1: i32, r2: i32) { instr_0F75(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F75_mem(addr: i32, r: i32) {
    instr_0F75(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F75(source: reg128, r: i32) {
    // pcmpeqw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u16[i] =
            (if source.u16[i] as i32 == destination.u16[i] as i32 { 0xFFFF } else { 0 }) as u16;
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F75_reg(r1: i32, r2: i32) { instr_660F75(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F75_mem(addr: i32, r: i32) {
    instr_660F75(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0F76(source: u64, r: i32) {
    // pcmpeqd mm, mm/m64
    let destination: [i32; 2] = std::mem::transmute(read_mmx64s(r));
    let source: [i32; 2] = std::mem::transmute(source);
    let mut result = [0; 2];
    for i in 0..2 {
        result[i] = if destination[i] == source[i] { -1 } else { 0 }
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0F76_reg(r1: i32, r2: i32) { instr_0F76(read_mmx64s(r1), r2); }
pub unsafe fn instr_0F76_mem(addr: i32, r: i32) {
    instr_0F76(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660F76(source: reg128, r: i32) {
    // pcmpeqd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..4 {
        result.i32[i] = if source.u32[i] == destination.u32[i] { -1 } else { 0 }
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660F76_reg(r1: i32, r2: i32) { instr_660F76(read_xmm128s(r1), r2); }
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
pub unsafe fn instr_660F7C(source: reg128, r: i32) {
    // haddpd xmm1, xmm2/m128
    let destination = read_xmm128s(r);
    write_xmm_reg128(
        r,
        reg128 {
            f64: [
                destination.f64[0] + destination.f64[1],
                source.f64[0] + source.f64[1],
            ],
        },
    );
}
pub unsafe fn instr_660F7C_reg(r1: i32, r2: i32) { instr_660F7C(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F7C_mem(addr: i32, r: i32) {
    instr_660F7C(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_F20F7C(source: reg128, r: i32) {
    // haddps xmm, xmm/mem128
    let destination = read_xmm128s(r);
    write_xmm_reg128(
        r,
        reg128 {
            f32: [
                destination.f32[0] + destination.f32[1],
                destination.f32[2] + destination.f32[3],
                source.f32[0] + source.f32[1],
                source.f32[2] + source.f32[3],
            ],
        },
    );
}
pub unsafe fn instr_F20F7C_reg(r1: i32, r2: i32) { instr_F20F7C(read_xmm128s(r1), r2); }
pub unsafe fn instr_F20F7C_mem(addr: i32, r: i32) {
    instr_F20F7C(return_on_pagefault!(safe_read128s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_660F7D(source: reg128, r: i32) {
    // hsubpd xmm1, xmm2/m128
    let destination = read_xmm128s(r);
    write_xmm_reg128(
        r,
        reg128 {
            f64: [
                destination.f64[0] - destination.f64[1],
                source.f64[0] - source.f64[1],
            ],
        },
    );
}
pub unsafe fn instr_660F7D_reg(r1: i32, r2: i32) { instr_660F7D(read_xmm128s(r1), r2); }
pub unsafe fn instr_660F7D_mem(addr: i32, r: i32) {
    instr_660F7D(return_on_pagefault!(safe_read128s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_F20F7D(source: reg128, r: i32) {
    // hsubps xmm1, xmm2/m128
    let destination = read_xmm128s(r);
    write_xmm_reg128(
        r,
        reg128 {
            f32: [
                destination.f32[0] - destination.f32[1],
                destination.f32[2] - destination.f32[3],
                source.f32[0] - source.f32[1],
                source.f32[2] - source.f32[3],
            ],
        },
    );
}
pub unsafe fn instr_F20F7D_reg(r1: i32, r2: i32) { instr_F20F7D(read_xmm128s(r1), r2); }
pub unsafe fn instr_F20F7D_mem(addr: i32, r: i32) {
    instr_F20F7D(return_on_pagefault!(safe_read128s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0F7E(r: i32) -> i32 {
    // movd r/m32, mm
    let data = read_mmx64s(r);
    transition_fpu_to_mmx();
    return data as i32;
}
pub unsafe fn instr_0F7E_reg(r1: i32, r2: i32) { write_reg32(r1, instr_0F7E(r2)); }
pub unsafe fn instr_0F7E_mem(addr: i32, r: i32) {
    return_on_pagefault!(safe_write32(addr, instr_0F7E(r)));
}
pub unsafe fn instr_660F7E(r: i32) -> i32 {
    // movd r/m32, xmm
    let data = read_xmm64s(r);
    return data as i32;
}
pub unsafe fn instr_660F7E_reg(r1: i32, r2: i32) { write_reg32(r1, instr_660F7E(r2)); }
pub unsafe fn instr_660F7E_mem(addr: i32, r: i32) {
    return_on_pagefault!(safe_write32(addr, instr_660F7E(r)));
}
pub unsafe fn instr_F30F7E_mem(addr: i32, r: i32) {
    // movq xmm, xmm/mem64
    let data = return_on_pagefault!(safe_read64s(addr));
    write_xmm128_2(r, data, 0);
}
pub unsafe fn instr_F30F7E_reg(r1: i32, r2: i32) {
    // movq xmm, xmm/mem64
    write_xmm128_2(r2, read_xmm64s(r1), 0);
}

#[no_mangle]
pub unsafe fn instr_0F7F(r: i32) -> u64 {
    // movq mm/m64, mm
    transition_fpu_to_mmx();
    read_mmx64s(r)
}
pub unsafe fn instr_0F7F_mem(addr: i32, r: i32) {
    // movq mm/m64, mm
    mov_r_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0F7F_reg(r1: i32, r2: i32) {
    // movq mm/m64, mm
    write_mmx_reg64(r1, read_mmx64s(r2));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_660F7F_mem(addr: i32, r: i32) {
    // movdqa xmm/m128, xmm
    // XXX: Aligned write or #gp
    mov_r_m128(addr, r);
}
pub unsafe fn instr_660F7F_reg(r1: i32, r2: i32) {
    // movdqa xmm/m128, xmm
    // XXX: Aligned access or #gp
    mov_r_r128(r1, r2);
}
pub unsafe fn instr_F30F7F_mem(addr: i32, r: i32) {
    // movdqu xmm/m128, xmm
    mov_r_m128(addr, r);
}
pub unsafe fn instr_F30F7F_reg(r1: i32, r2: i32) {
    // movdqu xmm/m128, xmm
    mov_r_r128(r1, r2);
}

pub unsafe fn instr16_0F80(imm: i32) { jmpcc16(test_o(), imm); }
pub unsafe fn instr32_0F80(imm: i32) { jmpcc32(test_o(), imm); }
pub unsafe fn instr16_0F81(imm: i32) { jmpcc16(!test_o(), imm); }
pub unsafe fn instr32_0F81(imm: i32) { jmpcc32(!test_o(), imm); }
pub unsafe fn instr16_0F82(imm: i32) { jmpcc16(test_b(), imm); }
pub unsafe fn instr32_0F82(imm: i32) { jmpcc32(test_b(), imm); }
pub unsafe fn instr16_0F83(imm: i32) { jmpcc16(!test_b(), imm); }
pub unsafe fn instr32_0F83(imm: i32) { jmpcc32(!test_b(), imm); }
pub unsafe fn instr16_0F84(imm: i32) { jmpcc16(test_z(), imm); }
pub unsafe fn instr32_0F84(imm: i32) { jmpcc32(test_z(), imm); }
pub unsafe fn instr16_0F85(imm: i32) { jmpcc16(!test_z(), imm); }
pub unsafe fn instr32_0F85(imm: i32) { jmpcc32(!test_z(), imm); }
pub unsafe fn instr16_0F86(imm: i32) { jmpcc16(test_be(), imm); }
pub unsafe fn instr32_0F86(imm: i32) { jmpcc32(test_be(), imm); }
pub unsafe fn instr16_0F87(imm: i32) { jmpcc16(!test_be(), imm); }
pub unsafe fn instr32_0F87(imm: i32) { jmpcc32(!test_be(), imm); }
pub unsafe fn instr16_0F88(imm: i32) { jmpcc16(test_s(), imm); }
pub unsafe fn instr32_0F88(imm: i32) { jmpcc32(test_s(), imm); }
pub unsafe fn instr16_0F89(imm: i32) { jmpcc16(!test_s(), imm); }
pub unsafe fn instr32_0F89(imm: i32) { jmpcc32(!test_s(), imm); }
pub unsafe fn instr16_0F8A(imm: i32) { jmpcc16(test_p(), imm); }
pub unsafe fn instr32_0F8A(imm: i32) { jmpcc32(test_p(), imm); }
pub unsafe fn instr16_0F8B(imm: i32) { jmpcc16(!test_p(), imm); }
pub unsafe fn instr32_0F8B(imm: i32) { jmpcc32(!test_p(), imm); }
pub unsafe fn instr16_0F8C(imm: i32) { jmpcc16(test_l(), imm); }
pub unsafe fn instr32_0F8C(imm: i32) { jmpcc32(test_l(), imm); }
pub unsafe fn instr16_0F8D(imm: i32) { jmpcc16(!test_l(), imm); }
pub unsafe fn instr32_0F8D(imm: i32) { jmpcc32(!test_l(), imm); }
pub unsafe fn instr16_0F8E(imm: i32) { jmpcc16(test_le(), imm); }
pub unsafe fn instr32_0F8E(imm: i32) { jmpcc32(test_le(), imm); }
pub unsafe fn instr16_0F8F(imm: i32) { jmpcc16(!test_le(), imm); }
pub unsafe fn instr32_0F8F(imm: i32) { jmpcc32(!test_le(), imm); }

pub unsafe fn instr_0F90_reg(r: i32, _: i32) { setcc_reg(test_o(), r); }
pub unsafe fn instr_0F91_reg(r: i32, _: i32) { setcc_reg(!test_o(), r); }
pub unsafe fn instr_0F92_reg(r: i32, _: i32) { setcc_reg(test_b(), r); }
pub unsafe fn instr_0F93_reg(r: i32, _: i32) { setcc_reg(!test_b(), r); }
pub unsafe fn instr_0F94_reg(r: i32, _: i32) { setcc_reg(test_z(), r); }
pub unsafe fn instr_0F95_reg(r: i32, _: i32) { setcc_reg(!test_z(), r); }
pub unsafe fn instr_0F96_reg(r: i32, _: i32) { setcc_reg(test_be(), r); }
pub unsafe fn instr_0F97_reg(r: i32, _: i32) { setcc_reg(!test_be(), r); }
pub unsafe fn instr_0F98_reg(r: i32, _: i32) { setcc_reg(test_s(), r); }
pub unsafe fn instr_0F99_reg(r: i32, _: i32) { setcc_reg(!test_s(), r); }
pub unsafe fn instr_0F9A_reg(r: i32, _: i32) { setcc_reg(test_p(), r); }
pub unsafe fn instr_0F9B_reg(r: i32, _: i32) { setcc_reg(!test_p(), r); }
pub unsafe fn instr_0F9C_reg(r: i32, _: i32) { setcc_reg(test_l(), r); }
pub unsafe fn instr_0F9D_reg(r: i32, _: i32) { setcc_reg(!test_l(), r); }
pub unsafe fn instr_0F9E_reg(r: i32, _: i32) { setcc_reg(test_le(), r); }
pub unsafe fn instr_0F9F_reg(r: i32, _: i32) { setcc_reg(!test_le(), r); }
pub unsafe fn instr_0F90_mem(addr: i32, _: i32) { setcc_mem(test_o(), addr); }
pub unsafe fn instr_0F91_mem(addr: i32, _: i32) { setcc_mem(!test_o(), addr); }
pub unsafe fn instr_0F92_mem(addr: i32, _: i32) { setcc_mem(test_b(), addr); }
pub unsafe fn instr_0F93_mem(addr: i32, _: i32) { setcc_mem(!test_b(), addr); }
pub unsafe fn instr_0F94_mem(addr: i32, _: i32) { setcc_mem(test_z(), addr); }
pub unsafe fn instr_0F95_mem(addr: i32, _: i32) { setcc_mem(!test_z(), addr); }
pub unsafe fn instr_0F96_mem(addr: i32, _: i32) { setcc_mem(test_be(), addr); }
pub unsafe fn instr_0F97_mem(addr: i32, _: i32) { setcc_mem(!test_be(), addr); }
pub unsafe fn instr_0F98_mem(addr: i32, _: i32) { setcc_mem(test_s(), addr); }
pub unsafe fn instr_0F99_mem(addr: i32, _: i32) { setcc_mem(!test_s(), addr); }
pub unsafe fn instr_0F9A_mem(addr: i32, _: i32) { setcc_mem(test_p(), addr); }
pub unsafe fn instr_0F9B_mem(addr: i32, _: i32) { setcc_mem(!test_p(), addr); }
pub unsafe fn instr_0F9C_mem(addr: i32, _: i32) { setcc_mem(test_l(), addr); }
pub unsafe fn instr_0F9D_mem(addr: i32, _: i32) { setcc_mem(!test_l(), addr); }
pub unsafe fn instr_0F9E_mem(addr: i32, _: i32) { setcc_mem(test_le(), addr); }
pub unsafe fn instr_0F9F_mem(addr: i32, _: i32) { setcc_mem(!test_le(), addr); }

pub unsafe fn instr16_0FA0() {
    return_on_pagefault!(push16(*sreg.offset(FS as isize) as i32));
}
pub unsafe fn instr32_0FA0() { return_on_pagefault!(push32_sreg(FS)) }
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
pub unsafe fn instr_0FA2() {
    // cpuid
    // TODO: Fill in with less bogus values

    // http://lxr.linux.no/linux+%2a/arch/x86/include/asm/cpufeature.h
    // http://www.sandpile.org/x86/cpuid.htm
    let mut eax = 0;
    let mut ecx = 0;
    let mut edx = 0;
    let mut ebx = 0;

    let level = read_reg32(EAX) as u32;

    match level {
        0 => {
            // maximum supported level (default 0x16, overwritten to 2 as a workaround for Windows NT)
            eax = cpuid_level as i32;

            ebx = 0x756E6547 | 0; // Genu
            edx = 0x49656E69 | 0; // ineI
            ecx = 0x6C65746E | 0; // ntel
        },

        1 => {
            // pentium
            eax = 3 | 6 << 4 | 15 << 8;
            ebx = 1 << 16 | 8 << 8; // cpu count, clflush size
            ecx = 1 << 0 | 1 << 23 | 1 << 30; // sse3, popcnt, rdrand
            let vme = 0 << 1;
            if ::config::VMWARE_HYPERVISOR_PORT {
                ecx |= 1 << 31
            }; // hypervisor
            edx = (if true /* have fpu */ { 1 } else {  0 }) |      // fpu
                    vme | 1 << 3 | 1 << 4 | 1 << 5 | 1 << 6 |  // vme, pse, tsc, msr, pae
                    1 << 8 | 1 << 11 | 1 << 13 | 1 << 15 | // cx8, sep, pge, cmov
                    1 << 23 | 1 << 24 | 1 << 25 | 1 << 26; // mmx, fxsr, sse1, sse2

            if *acpi_enabled
            //&& this.apic_enabled[0])
            {
                edx |= 1 << 9; // apic
            }
        },

        2 => {
            // Taken from http://siyobik.info.gf/main/reference/instruction/CPUID
            eax = 0x665B5001;
            ebx = 0;
            ecx = 0;
            edx = 0x007A7000;
        },

        4 => {
            // from my local machine
            match read_reg32(ECX) {
                0 => {
                    eax = 0x00000121;
                    ebx = 0x01c0003f;
                    ecx = 0x0000003f;
                    edx = 0x00000001;
                },
                1 => {
                    eax = 0x00000122;
                    ebx = 0x01c0003f;
                    ecx = 0x0000003f;
                    edx = 0x00000001;
                },
                2 => {
                    eax = 0x00000143;
                    ebx = 0x05c0003f;
                    ecx = 0x00000fff;
                    edx = 0x00000001;
                },
                _ => {},
            }
        },

        5 => {
            // from my local machine
            eax = 0x40;
            ebx = 0x40;
            ecx = 3;
            edx = 0x00142120;
        },

        7 => {
            if read_reg32(ECX) == 0 {
                eax = 0; // maximum supported sub-level
                ebx = 1 << 9; // enhanced REP MOVSB/STOSB
                ecx = 0;
                edx = 0;
            }
        },

        0x80000000 => {
            // maximum supported extended level
            eax = 5;
            // other registers are reserved
        },

        0x40000000 => {
            // hypervisor
            if ::config::VMWARE_HYPERVISOR_PORT {
                // h("Ware".split("").reduce((a, c, i) => a | c.charCodeAt(0) << i * 8, 0))
                ebx = 0x61774D56 | 0; // VMwa
                ecx = 0x4D566572 | 0; // reVM
                edx = 0x65726177 | 0; // ware
            }
        },

        0x15 => {
            eax = 1; // denominator
            ebx = 1; // numerator
            ecx = (TSC_RATE * 1000.0) as u32 as i32; // core crystal clock frequency in Hz
            dbg_assert!(ecx > 0);
            //  (TSC frequency = core crystal clock frequency * EBX/EAX)
        },

        0x16 => {
            eax = (TSC_RATE / 1000.0).floor() as u32 as i32; // core base frequency in MHz
            ebx = (TSC_RATE / 1000.0).floor() as u32 as i32; // core maximum frequency in MHz
            ecx = 10; // bus (reference) frequency in MHz

            // 16-bit values
            dbg_assert!(eax < 0x10000);
            dbg_assert!(ebx < 0x10000);
            dbg_assert!(ecx < 0x10000);
        },

        x => {
            dbg_log!("cpuid: unimplemented eax: {:x}", x);
        },
    }

    if level == 4 || level == 7 {
        dbg_log!(
            "cpuid: eax={:08x} ecx={:02x}",
            read_reg32(EAX),
            read_reg32(ECX),
        );
    }
    else if level != 0 && level != 2 && level != 0x80000000 {
        dbg_log!("cpuid: eax={:08x}", read_reg32(EAX));
    }

    write_reg32(EAX, eax);
    write_reg32(ECX, ecx);
    write_reg32(EDX, edx);
    write_reg32(EBX, ebx);
}
pub unsafe fn instr16_0FA3_reg(r1: i32, r2: i32) { bt_reg(read_reg16(r1), read_reg16(r2) & 15); }
pub unsafe fn instr16_0FA3_mem(addr: i32, r: i32) { bt_mem(addr, read_reg16(r) << 16 >> 16); }
pub unsafe fn instr32_0FA3_reg(r1: i32, r2: i32) { bt_reg(read_reg32(r1), read_reg32(r2) & 31); }
pub unsafe fn instr32_0FA3_mem(addr: i32, r: i32) { bt_mem(addr, read_reg32(r)); }
pub unsafe fn instr16_0FA4_mem(addr: i32, r: i32, imm: i32) {
    safe_read_write16(addr, &|x| shld16(x, read_reg16(r), imm & 31))
}
pub unsafe fn instr16_0FA4_reg(r1: i32, r: i32, imm: i32) {
    write_reg16(r1, shld16(read_reg16(r1), read_reg16(r), imm & 31));
}
pub unsafe fn instr32_0FA4_mem(addr: i32, r: i32, imm: i32) {
    safe_read_write32(addr, &|x| shld32(x, read_reg32(r), imm & 31))
}
pub unsafe fn instr32_0FA4_reg(r1: i32, r: i32, imm: i32) {
    write_reg32(r1, shld32(read_reg32(r1), read_reg32(r), imm & 31));
}
pub unsafe fn instr16_0FA5_mem(addr: i32, r: i32) {
    safe_read_write16(addr, &|x| shld16(x, read_reg16(r), read_reg8(CL) & 31))
}
pub unsafe fn instr16_0FA5_reg(r1: i32, r: i32) {
    write_reg16(
        r1,
        shld16(read_reg16(r1), read_reg16(r), read_reg8(CL) & 31),
    );
}
pub unsafe fn instr32_0FA5_mem(addr: i32, r: i32) {
    safe_read_write32(addr, &|x| shld32(x, read_reg32(r), read_reg8(CL) & 31))
}
pub unsafe fn instr32_0FA5_reg(r1: i32, r: i32) {
    write_reg32(
        r1,
        shld32(read_reg32(r1), read_reg32(r), read_reg8(CL) & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_0FA6() {
    // obsolete cmpxchg (os/2)
    trigger_ud();
}
#[no_mangle]
pub unsafe fn instr_0FA7() { undefined_instruction(); }
pub unsafe fn instr16_0FA8() {
    return_on_pagefault!(push16(*sreg.offset(GS as isize) as i32));
}
pub unsafe fn instr32_0FA8() { return_on_pagefault!(push32_sreg(GS)) }
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
pub unsafe fn instr16_0FAC_mem(addr: i32, r: i32, imm: i32) {
    safe_read_write16(addr, &|x| shrd16(x, read_reg16(r), imm & 31))
}
pub unsafe fn instr16_0FAC_reg(r1: i32, r: i32, imm: i32) {
    write_reg16(r1, shrd16(read_reg16(r1), read_reg16(r), imm & 31));
}
pub unsafe fn instr32_0FAC_mem(addr: i32, r: i32, imm: i32) {
    safe_read_write32(addr, &|x| shrd32(x, read_reg32(r), imm & 31))
}
pub unsafe fn instr32_0FAC_reg(r1: i32, r: i32, imm: i32) {
    write_reg32(r1, shrd32(read_reg32(r1), read_reg32(r), imm & 31));
}
pub unsafe fn instr16_0FAD_mem(addr: i32, r: i32) {
    safe_read_write16(addr, &|x| shrd16(x, read_reg16(r), read_reg8(CL) & 31))
}
pub unsafe fn instr16_0FAD_reg(r1: i32, r: i32) {
    write_reg16(
        r1,
        shrd16(read_reg16(r1), read_reg16(r), read_reg8(CL) & 31),
    );
}
pub unsafe fn instr32_0FAD_mem(addr: i32, r: i32) {
    safe_read_write32(addr, &|x| shrd32(x, read_reg32(r), read_reg8(CL) & 31))
}
pub unsafe fn instr32_0FAD_reg(r1: i32, r: i32) {
    write_reg32(
        r1,
        shrd32(read_reg32(r1), read_reg32(r), read_reg8(CL) & 31),
    );
}
#[no_mangle]
pub unsafe fn instr_0FAE_0_reg(_r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_0_mem(addr: i32) { fxsave(addr); }
#[no_mangle]
pub unsafe fn instr_0FAE_1_reg(_r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_1_mem(addr: i32) { fxrstor(addr); }
#[no_mangle]
pub unsafe fn instr_0FAE_2_reg(_r: i32) { unimplemented_sse(); }
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
pub unsafe fn instr_0FAE_3_reg(_r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_3_mem(addr: i32) {
    // stmxcsr
    return_on_pagefault!(safe_write32(addr, *mxcsr));
}
#[no_mangle]
pub unsafe fn instr_0FAE_4_reg(_r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FAE_4_mem(_addr: i32) {
    // xsave
    undefined_instruction();
}
pub unsafe fn instr_0FAE_5_reg(_r: i32) {
    // lfence
}
pub unsafe fn instr_0FAE_5_mem(_addr: i32) {
    // xrstor
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0FAE_6_reg(_r: i32) {
    // mfence
}
#[no_mangle]
pub unsafe fn instr_0FAE_6_mem(_addr: i32) {
    // xsaveopt
    undefined_instruction();
}
#[no_mangle]
pub unsafe fn instr_0FAE_7_reg(_r: i32) {
    // sfence
}
#[no_mangle]
pub unsafe fn instr_0FAE_7_mem(_addr: i32) {
    // clflush
    undefined_instruction();
}
pub unsafe fn instr16_0FAF_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        imul_reg16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
pub unsafe fn instr16_0FAF_reg(r1: i32, r: i32) {
    write_reg16(r, imul_reg16(read_reg16(r), read_reg16(r1)));
}
pub unsafe fn instr32_0FAF_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        imul_reg32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
pub unsafe fn instr32_0FAF_reg(r1: i32, r: i32) {
    write_reg32(r, imul_reg32(read_reg32(r), read_reg32(r1)));
}

#[no_mangle]
pub unsafe fn instr_0FB0_reg(r1: i32, r2: i32) { write_reg8(r1, cmpxchg8(read_reg8(r1), r2)); }
#[no_mangle]
pub unsafe fn instr_0FB0_mem(addr: i32, r: i32) { safe_read_write8(addr, &|x| cmpxchg8(x, r)) }
pub unsafe fn instr16_0FB1_reg(r1: i32, r2: i32) { write_reg16(r1, cmpxchg16(read_reg16(r1), r2)); }
pub unsafe fn instr16_0FB1_mem(addr: i32, r: i32) { safe_read_write16(addr, &|x| cmpxchg16(x, r)) }
pub unsafe fn instr32_0FB1_reg(r1: i32, r2: i32) { write_reg32(r1, cmpxchg32(read_reg32(r1), r2)); }
pub unsafe fn instr32_0FB1_mem(addr: i32, r: i32) { safe_read_write32(addr, &|x| cmpxchg32(x, r)) }

#[no_mangle]
pub unsafe fn instr16_0FB2_reg(_unused: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB2_mem(addr: i32, r: i32) { lss16(addr, r, SS); }
#[no_mangle]
pub unsafe fn instr32_0FB2_reg(_unused: i32, _unused2: i32) { trigger_ud(); }
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
pub unsafe fn instr16_0FB4_reg(_unused: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB4_mem(addr: i32, r: i32) { lss16(addr, r, FS); }
#[no_mangle]
pub unsafe fn instr32_0FB4_reg(_unused: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FB4_mem(addr: i32, r: i32) { lss32(addr, r, FS); }
#[no_mangle]
pub unsafe fn instr16_0FB5_reg(_unused: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB5_mem(addr: i32, r: i32) { lss16(addr, r, GS); }
#[no_mangle]
pub unsafe fn instr32_0FB5_reg(_unused: i32, _unused2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FB5_mem(addr: i32, r: i32) { lss32(addr, r, GS); }
pub unsafe fn instr16_0FB6_mem(addr: i32, r: i32) {
    write_reg16(r, return_on_pagefault!(safe_read8(addr)));
}
pub unsafe fn instr16_0FB6_reg(r1: i32, r: i32) { write_reg16(r, read_reg8(r1)); }
pub unsafe fn instr32_0FB6_mem(addr: i32, r: i32) {
    write_reg32(r, return_on_pagefault!(safe_read8(addr)));
}
pub unsafe fn instr32_0FB6_reg(r1: i32, r: i32) { write_reg32(r, read_reg8(r1)); }
pub unsafe fn instr16_0FB7_mem(addr: i32, r: i32) {
    write_reg16(r, return_on_pagefault!(safe_read16(addr)));
}
pub unsafe fn instr16_0FB7_reg(r1: i32, r: i32) { write_reg16(r, read_reg16(r1)); }
pub unsafe fn instr32_0FB7_mem(addr: i32, r: i32) {
    write_reg32(r, return_on_pagefault!(safe_read16(addr)));
}
pub unsafe fn instr32_0FB7_reg(r1: i32, r: i32) { write_reg32(r, read_reg16(r1)); }
#[no_mangle]
pub unsafe fn instr16_0FB8_reg(_r1: i32, _r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr16_0FB8_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr16_F30FB8_mem(addr: i32, r: i32) {
    write_reg16(r, popcnt(return_on_pagefault!(safe_read16(addr))));
}
pub unsafe fn instr16_F30FB8_reg(r1: i32, r: i32) { write_reg16(r, popcnt(read_reg16(r1))); }
#[no_mangle]
pub unsafe fn instr32_0FB8_reg(_r1: i32, _r2: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FB8_mem(_addr: i32, _r: i32) { trigger_ud(); }
pub unsafe fn instr32_F30FB8_mem(addr: i32, r: i32) {
    write_reg32(r, popcnt(return_on_pagefault!(safe_read32s(addr))));
}
pub unsafe fn instr32_F30FB8_reg(r1: i32, r: i32) { write_reg32(r, popcnt(read_reg32(r1))); }
#[no_mangle]
pub unsafe fn instr_0FB9() {
    // UD2
    trigger_ud();
}
pub unsafe fn instr16_0FBA_4_reg(r: i32, imm: i32) { bt_reg(read_reg16(r), imm & 15); }
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
pub unsafe fn instr32_0FBA_4_reg(r: i32, imm: i32) { bt_reg(read_reg32(r), imm & 31); }
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
pub unsafe fn instr16_0FBC_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        bsf16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
pub unsafe fn instr16_0FBC_reg(r1: i32, r: i32) {
    write_reg16(r, bsf16(read_reg16(r), read_reg16(r1)));
}
pub unsafe fn instr32_0FBC_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        bsf32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
pub unsafe fn instr32_0FBC_reg(r1: i32, r: i32) {
    write_reg32(r, bsf32(read_reg32(r), read_reg32(r1)));
}
pub unsafe fn instr16_0FBD_mem(addr: i32, r: i32) {
    write_reg16(
        r,
        bsr16(read_reg16(r), return_on_pagefault!(safe_read16(addr))),
    );
}
pub unsafe fn instr16_0FBD_reg(r1: i32, r: i32) {
    write_reg16(r, bsr16(read_reg16(r), read_reg16(r1)));
}
pub unsafe fn instr32_0FBD_mem(addr: i32, r: i32) {
    write_reg32(
        r,
        bsr32(read_reg32(r), return_on_pagefault!(safe_read32s(addr))),
    );
}
pub unsafe fn instr32_0FBD_reg(r1: i32, r: i32) {
    write_reg32(r, bsr32(read_reg32(r), read_reg32(r1)));
}
pub unsafe fn instr16_0FBE_mem(addr: i32, r: i32) {
    write_reg16(r, return_on_pagefault!(safe_read8(addr)) << 24 >> 24);
}
pub unsafe fn instr16_0FBE_reg(r1: i32, r: i32) { write_reg16(r, read_reg8(r1) << 24 >> 24); }
pub unsafe fn instr32_0FBE_mem(addr: i32, r: i32) {
    write_reg32(r, return_on_pagefault!(safe_read8(addr)) << 24 >> 24);
}
pub unsafe fn instr32_0FBE_reg(r1: i32, r: i32) { write_reg32(r, read_reg8(r1) << 24 >> 24); }
pub unsafe fn instr16_0FBF_mem(addr: i32, r: i32) {
    write_reg16(r, return_on_pagefault!(safe_read16(addr)) << 16 >> 16);
}
pub unsafe fn instr16_0FBF_reg(r1: i32, r: i32) { write_reg16(r, read_reg16(r1) << 16 >> 16); }
pub unsafe fn instr32_0FBF_mem(addr: i32, r: i32) {
    write_reg32(r, return_on_pagefault!(safe_read16(addr)) << 16 >> 16);
}
pub unsafe fn instr32_0FBF_reg(r1: i32, r: i32) { write_reg32(r, read_reg16(r1) << 16 >> 16); }
#[no_mangle]
pub unsafe fn instr_0FC0_mem(addr: i32, r: i32) { safe_read_write8(addr, &|x| xadd8(x, r)) }
#[no_mangle]
pub unsafe fn instr_0FC0_reg(r1: i32, r: i32) { write_reg8(r1, xadd8(read_reg8(r1), r)); }
pub unsafe fn instr16_0FC1_mem(addr: i32, r: i32) { safe_read_write16(addr, &|x| xadd16(x, r)) }
pub unsafe fn instr16_0FC1_reg(r1: i32, r: i32) { write_reg16(r1, xadd16(read_reg16(r1), r)); }
pub unsafe fn instr32_0FC1_mem(addr: i32, r: i32) { safe_read_write32(addr, &|x| xadd32(x, r)) }
pub unsafe fn instr32_0FC1_reg(r1: i32, r: i32) { write_reg32(r1, xadd32(read_reg32(r1), r)); }

#[no_mangle]
pub unsafe fn instr_0FC2(source: reg128, r: i32, imm8: i32) {
    // cmpps xmm, xmm/m128
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..4 {
        result.i32[i] = if sse_comparison(imm8, destination.f32[i] as f64, source.f32[i] as f64) {
            -1
        }
        else {
            0
        };
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_0FC2_reg(r1: i32, r2: i32, imm: i32) { instr_0FC2(read_xmm128s(r1), r2, imm); }
pub unsafe fn instr_0FC2_mem(addr: i32, r: i32, imm: i32) {
    instr_0FC2(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_660FC2(source: reg128, r: i32, imm8: i32) {
    // cmppd xmm, xmm/m128
    let destination = read_xmm128s(r);
    let result = reg128 {
        i64: [
            (if sse_comparison(imm8, destination.f64[0], source.f64[0]) { -1 } else { 0 }) as i64,
            (if sse_comparison(imm8, destination.f64[1], source.f64[1]) { -1 } else { 0 }) as i64,
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FC2_reg(r1: i32, r2: i32, imm: i32) {
    instr_660FC2(read_xmm128s(r1), r2, imm);
}
pub unsafe fn instr_660FC2_mem(addr: i32, r: i32, imm: i32) {
    instr_660FC2(return_on_pagefault!(safe_read128s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_F20FC2(source: u64, r: i32, imm8: i32) {
    // cmpsd xmm, xmm/m64
    let destination = read_xmm64s(r);
    write_xmm64(
        r,
        if sse_comparison(imm8, f64::from_bits(destination), f64::from_bits(source)) {
            (-1i32) as u64
        }
        else {
            0
        },
    );
}
pub unsafe fn instr_F20FC2_reg(r1: i32, r2: i32, imm: i32) {
    instr_F20FC2(read_xmm64s(r1), r2, imm);
}
pub unsafe fn instr_F20FC2_mem(addr: i32, r: i32, imm: i32) {
    instr_F20FC2(return_on_pagefault!(safe_read64s(addr)), r, imm);
}
#[no_mangle]
pub unsafe fn instr_F30FC2(source: i32, r: i32, imm8: i32) {
    // cmpss xmm, xmm/m32
    let destination = read_xmm_f32(r);
    let source: f32 = std::mem::transmute(source);
    let result = if sse_comparison(imm8, destination as f64, source as f64) { -1 } else { 0 };
    write_xmm32(r, result);
}
pub unsafe fn instr_F30FC2_reg(r1: i32, r2: i32, imm: i32) {
    instr_F30FC2(read_xmm64s(r1) as i32, r2, imm);
}
pub unsafe fn instr_F30FC2_mem(addr: i32, r: i32, imm: i32) {
    instr_F30FC2(return_on_pagefault!(safe_read32s(addr)), r, imm);
}

pub unsafe fn instr_0FC3_reg(_r1: i32, _r2: i32) { trigger_ud(); }
pub unsafe fn instr_0FC3_mem(addr: i32, r: i32) {
    // movnti
    return_on_pagefault!(safe_write32(addr, read_reg32(r)));
}

#[no_mangle]
pub unsafe fn instr_0FC4(source: i32, r: i32, imm8: i32) {
    // pinsrw mm, r32/m16, imm8
    let mut destination: [u16; 4] = std::mem::transmute(read_mmx64s(r));
    destination[(imm8 & 3) as usize] = source as u16;
    write_mmx_reg64(r, std::mem::transmute(destination));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FC4_reg(r1: i32, r2: i32, imm: i32) { instr_0FC4(read_reg32(r1), r2, imm); }
pub unsafe fn instr_0FC4_mem(addr: i32, r: i32, imm: i32) {
    instr_0FC4(return_on_pagefault!(safe_read16(addr)), r, imm);
}
pub unsafe fn instr_660FC4(source: i32, r: i32, imm8: i32) {
    // pinsrw xmm, r32/m16, imm8
    let mut destination = read_xmm128s(r);
    let index = (imm8 & 7) as u32;
    destination.u16[index as usize] = (source & 0xFFFF) as u16;
    write_xmm_reg128(r, destination);
}
pub unsafe fn instr_660FC4_reg(r1: i32, r2: i32, imm: i32) {
    instr_660FC4(read_reg32(r1), r2, imm);
}
pub unsafe fn instr_660FC4_mem(addr: i32, r: i32, imm: i32) {
    instr_660FC4(return_on_pagefault!(safe_read16(addr)), r, imm);
}
pub unsafe fn instr_0FC5_mem(_addr: i32, _r: i32, _imm8: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FC5_reg(r1: i32, r2: i32, imm8: i32) {
    // pextrw r32, mm, imm8
    let data: [u16; 4] = std::mem::transmute(read_mmx64s(r1));
    write_reg32(r2, data[(imm8 & 3) as usize] as i32);
    transition_fpu_to_mmx();
}
pub unsafe fn instr_660FC5_mem(_addr: i32, _r: i32, _imm8: i32) { trigger_ud(); }
pub unsafe fn instr_660FC5_reg(r1: i32, r2: i32, imm8: i32) {
    // pextrw r32, xmm, imm8
    let data = read_xmm128s(r1);
    let index = (imm8 & 7) as u32;
    let result = data.u16[index as usize] as u32;
    write_reg32(r2, result as i32);
}

#[no_mangle]
pub unsafe fn instr_0FC6(source: reg128, r: i32, imm8: i32) {
    // shufps xmm, xmm/mem128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    write_xmm128(
        r,
        destination.u32[(imm8 & 3) as usize] as i32,
        destination.u32[(imm8 >> 2 & 3) as usize] as i32,
        source.u32[(imm8 >> 4 & 3) as usize] as i32,
        source.u32[(imm8 >> 6 & 3) as usize] as i32,
    );
}
pub unsafe fn instr_0FC6_reg(r1: i32, r2: i32, imm: i32) { instr_0FC6(read_xmm128s(r1), r2, imm); }
pub unsafe fn instr_0FC6_mem(addr: i32, r: i32, imm: i32) {
    instr_0FC6(return_on_pagefault!(safe_read128s(addr)), r, imm);
}

#[no_mangle]
pub unsafe fn instr_660FC6(source: reg128, r: i32, imm8: i32) {
    // shufpd xmm, xmm/mem128
    let destination = read_xmm128s(r);
    let result = reg128 {
        i64: [
            destination.i64[imm8 as usize & 1],
            source.i64[imm8 as usize >> 1 & 1],
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FC6_reg(r1: i32, r2: i32, imm: i32) {
    instr_660FC6(read_xmm128s(r1), r2, imm);
}
pub unsafe fn instr_660FC6_mem(addr: i32, r: i32, imm: i32) {
    instr_660FC6(return_on_pagefault!(safe_read128s(addr)), r, imm);
}

pub unsafe fn instr16_0FC7_1_reg(_r: i32) { trigger_ud(); }
pub unsafe fn instr32_0FC7_1_reg(_r: i32) { trigger_ud(); }
pub unsafe fn instr16_0FC7_1_mem(addr: i32) {
    // cmpxchg8b
    return_on_pagefault!(writable_or_pagefault(addr, 8));
    let m64 = safe_read64s(addr).unwrap();
    let m64_low = m64 as i32;
    let m64_high = (m64 >> 32) as i32;
    if read_reg32(EAX) == m64_low && read_reg32(EDX) == m64_high {
        *flags |= FLAG_ZERO;
        safe_write64(
            addr,
            read_reg32(EBX) as u32 as u64 | (read_reg32(ECX) as u32 as u64) << 32,
        )
        .unwrap();
    }
    else {
        *flags &= !FLAG_ZERO;
        write_reg32(EAX, m64_low);
        write_reg32(EDX, m64_high);
    }
    *flags_changed &= !FLAG_ZERO;
}
pub unsafe fn instr32_0FC7_1_mem(addr: i32) { instr16_0FC7_1_mem(addr) }

#[no_mangle]
pub unsafe fn instr16_0FC7_6_reg(r: i32) {
    // rdrand
    let rand = get_rand_int();
    write_reg16(r, rand);
    *flags &= !FLAGS_ALL;
    *flags |= 1;
    *flags_changed = 0;
}
#[no_mangle]
pub unsafe fn instr32_0FC7_6_reg(r: i32) {
    // rdrand
    let rand = get_rand_int();
    write_reg32(r, rand);
    *flags &= !FLAGS_ALL;
    *flags |= 1;
    *flags_changed = 0;
}

#[no_mangle]
pub unsafe fn instr16_0FC7_6_mem(_addr: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr32_0FC7_6_mem(_addr: i32) { trigger_ud(); }

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
pub unsafe fn instr_0FD1(source: u64, r: i32) {
    // psrlw mm, mm/m64
    psrlw_r64(r, source);
}
pub unsafe fn instr_0FD1_reg(r1: i32, r2: i32) { instr_0FD1(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FD1_mem(addr: i32, r: i32) {
    instr_0FD1(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD1(source: reg128, r: i32) {
    // psrlw xmm, xmm/m128
    // XXX: Aligned access or #gp
    psrlw_r128(r, source.u64[0]);
}
pub unsafe fn instr_660FD1_reg(r1: i32, r2: i32) { instr_660FD1(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FD1_mem(addr: i32, r: i32) {
    instr_660FD1(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD2(source: u64, r: i32) {
    // psrld mm, mm/m64
    psrld_r64(r, source);
}
pub unsafe fn instr_0FD2_reg(r1: i32, r2: i32) { instr_0FD2(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FD2_mem(addr: i32, r: i32) {
    instr_0FD2(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD2(source: reg128, r: i32) {
    // psrld xmm, xmm/m128
    // XXX: Aligned access or #gp
    psrld_r128(r, source.u64[0]);
}
pub unsafe fn instr_660FD2_reg(r1: i32, r2: i32) { instr_660FD2(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FD2_mem(addr: i32, r: i32) {
    instr_660FD2(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD3(source: u64, r: i32) {
    // psrlq mm, mm/m64
    psrlq_r64(r, source);
}
pub unsafe fn instr_0FD3_reg(r1: i32, r2: i32) { instr_0FD3(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FD3_mem(addr: i32, r: i32) {
    instr_0FD3(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD3(source: reg128, r: i32) {
    // psrlq xmm, mm/m64
    psrlq_r128(r, source.u64[0]);
}
pub unsafe fn instr_660FD3_reg(r1: i32, r2: i32) { instr_660FD3(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FD3_mem(addr: i32, r: i32) {
    instr_660FD3(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD4(source: u64, r: i32) {
    // paddq mm, mm/m64
    let destination = read_mmx64s(r);
    write_mmx_reg64(r, source + destination);
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FD4_reg(r1: i32, r2: i32) { instr_0FD4(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FD4_mem(addr: i32, r: i32) {
    instr_0FD4(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD4(source: reg128, r: i32) {
    // paddq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    result.u64[0] = destination.u64[0] + source.u64[0];
    result.u64[1] = destination.u64[1] + source.u64[1];
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FD4_reg(r1: i32, r2: i32) { instr_660FD4(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FD4_mem(addr: i32, r: i32) {
    instr_660FD4(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD5(source: u64, r: i32) {
    // pmullw mm, mm/m64
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [i16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = destination[i] * source[i];
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FD5_reg(r1: i32, r2: i32) { instr_0FD5(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FD5_mem(addr: i32, r: i32) {
    instr_0FD5(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD5(source: reg128, r: i32) {
    // pmullw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u16[i] = destination.u16[i] * source.u16[i]
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FD5_reg(r1: i32, r2: i32) { instr_660FD5(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FD5_mem(addr: i32, r: i32) {
    instr_660FD5(return_on_pagefault!(safe_read128s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0FD6_mem(_addr: i32, _r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FD6_reg(_r1: i32, _r2: i32) { trigger_ud(); }
pub unsafe fn instr_660FD6_mem(addr: i32, r: i32) {
    // movq xmm/m64, xmm
    movl_r128_m64(addr, r);
}
pub unsafe fn instr_660FD6_reg(r1: i32, r2: i32) {
    // movq xmm/m64, xmm
    write_xmm128_2(r1, read_xmm64s(r2), 0);
}

#[no_mangle]
pub unsafe fn instr_F20FD6_mem(_addr: i32, _r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_F20FD6_reg(r1: i32, r2: i32) {
    // movdq2q mm, xmm
    write_mmx_reg64(r2, read_xmm128s(r1).u64[0]);
    transition_fpu_to_mmx();
}
#[no_mangle]
pub unsafe fn instr_F30FD6_mem(_addr: i32, _r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_F30FD6_reg(r1: i32, r2: i32) {
    // movq2dq xmm, mm
    let source = read_mmx64s(r1);
    write_xmm_reg128(r2, reg128 { u64: [source, 0] });
    transition_fpu_to_mmx();
}

pub unsafe fn instr_0FD7_mem(_addr: i32, _r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FD7(r1: i32) -> i32 {
    // pmovmskb r, mm
    let x: [u8; 8] = std::mem::transmute(read_mmx64s(r1));
    let mut result = 0;
    for i in 0..8 {
        result |= x[i] as i32 >> 7 << i
    }
    transition_fpu_to_mmx();
    result
}
pub unsafe fn instr_0FD7_reg(r1: i32, r2: i32) { write_reg32(r2, instr_0FD7(r1)); }
pub unsafe fn instr_660FD7_mem(_addr: i32, _r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_660FD7(r1: i32) -> i32 {
    // pmovmskb reg, xmm
    let x = read_xmm128s(r1);
    let mut result = 0;
    for i in 0..16 {
        result |= x.u8[i] as i32 >> 7 << i
    }
    result
}
pub unsafe fn instr_660FD7_reg(r1: i32, r2: i32) { write_reg32(r2, instr_660FD7(r1)) }
#[no_mangle]
pub unsafe fn instr_0FD8(source: u64, r: i32) {
    // psubusb mm, mm/m64
    let destination: [u8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [u8; 8] = std::mem::transmute(source);
    let mut result = [0; 8];
    for i in 0..8 {
        result[i] = saturate_sd_to_ub(destination[i] as i32 - source[i] as i32) as u8;
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FD8_reg(r1: i32, r2: i32) { instr_0FD8(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FD8_mem(addr: i32, r: i32) {
    instr_0FD8(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD8(source: reg128, r: i32) {
    // psubusb xmm, xmm/m128
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..16 {
        result.u8[i] = saturate_sd_to_ub(destination.u8[i] as i32 - source.u8[i] as i32) as u8;
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FD8_reg(r1: i32, r2: i32) { instr_660FD8(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FD8_mem(addr: i32, r: i32) {
    instr_660FD8(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FD9(source: u64, r: i32) {
    // psubusw mm, mm/m64
    let destination: [u16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [u16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = saturate_uw(destination[i] as u32 - source[i] as u32)
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FD9_reg(r1: i32, r2: i32) { instr_0FD9(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FD9_mem(addr: i32, r: i32) {
    instr_0FD9(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FD9(source: reg128, r: i32) {
    // psubusw xmm, xmm/m128
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u16[i] = saturate_uw(destination.u16[i] as u32 - source.u16[i] as u32)
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FD9_reg(r1: i32, r2: i32) { instr_660FD9(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FD9_mem(addr: i32, r: i32) {
    instr_660FD9(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDA(source: u64, r: i32) {
    // pminub mm, mm/m64
    let destination: [u8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [u8; 8] = std::mem::transmute(source);
    let mut result = [0; 8];
    for i in 0..8 {
        result[i] = u8::min(source[i], destination[i])
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FDA_reg(r1: i32, r2: i32) { instr_0FDA(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FDA_mem(addr: i32, r: i32) {
    instr_0FDA(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDA(source: reg128, r: i32) {
    // pminub xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { u8: [0; 16] };
    for i in 0..16 {
        result.u8[i] = u8::min(source.u8[i], destination.u8[i]);
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FDA_reg(r1: i32, r2: i32) { instr_660FDA(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FDA_mem(addr: i32, r: i32) {
    instr_660FDA(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDB(source: u64, r: i32) {
    // pand mm, mm/m64
    let destination = read_mmx64s(r);
    write_mmx_reg64(r, source & destination);
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FDB_reg(r1: i32, r2: i32) { instr_0FDB(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FDB_mem(addr: i32, r: i32) {
    instr_0FDB(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDB(source: reg128, r: i32) {
    // pand xmm, xmm/m128
    // XXX: Aligned access or #gp
    pand_r128(source, r);
}
pub unsafe fn instr_660FDB_reg(r1: i32, r2: i32) { instr_660FDB(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FDB_mem(addr: i32, r: i32) {
    instr_660FDB(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDC(source: u64, r: i32) {
    // paddusb mm, mm/m64
    let destination: [u8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [u8; 8] = std::mem::transmute(source);
    let mut result = [0; 8];
    for i in 0..8 {
        result[i] = saturate_ud_to_ub(destination[i] as u32 + source[i] as u32);
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FDC_reg(r1: i32, r2: i32) { instr_0FDC(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FDC_mem(addr: i32, r: i32) {
    instr_0FDC(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDC(source: reg128, r: i32) {
    // paddusb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..16 {
        result.u8[i] = saturate_ud_to_ub(source.u8[i] as u32 + destination.u8[i] as u32);
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FDC_reg(r1: i32, r2: i32) { instr_660FDC(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FDC_mem(addr: i32, r: i32) {
    instr_660FDC(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDD(source: u64, r: i32) {
    // paddusw mm, mm/m64
    let destination: [u16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [u16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = saturate_uw(destination[i] as u32 + source[i] as u32)
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FDD_reg(r1: i32, r2: i32) { instr_0FDD(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FDD_mem(addr: i32, r: i32) {
    instr_0FDD(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDD(source: reg128, r: i32) {
    // paddusw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u16[i] = saturate_uw(source.u16[i] as u32 + destination.u16[i] as u32)
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FDD_reg(r1: i32, r2: i32) { instr_660FDD(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FDD_mem(addr: i32, r: i32) {
    instr_660FDD(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDE(source: u64, r: i32) {
    // pmaxub mm, mm/m64
    let destination: [u8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [u8; 8] = std::mem::transmute(source);
    let mut result = [0; 8];
    for i in 0..8 {
        result[i] = u8::max(source[i], destination[i])
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FDE_reg(r1: i32, r2: i32) { instr_0FDE(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FDE_mem(addr: i32, r: i32) {
    instr_0FDE(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDE(source: reg128, r: i32) {
    // pmaxub xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..16 {
        result.u8[i] = u8::max(source.u8[i], destination.u8[i]);
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FDE_reg(r1: i32, r2: i32) { instr_660FDE(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FDE_mem(addr: i32, r: i32) {
    instr_660FDE(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FDF(source: u64, r: i32) {
    // pandn mm, mm/m64
    let destination = read_mmx64s(r);
    write_mmx_reg64(r, source & !destination);
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FDF_reg(r1: i32, r2: i32) { instr_0FDF(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FDF_mem(addr: i32, r: i32) {
    instr_0FDF(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FDF(source: reg128, r: i32) {
    // pandn xmm, xmm/m128
    // XXX: Aligned access or #gp
    pandn_r128(source, r);
}
pub unsafe fn instr_660FDF_reg(r1: i32, r2: i32) { instr_660FDF(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FDF_mem(addr: i32, r: i32) {
    instr_660FDF(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE0(source: u64, r: i32) {
    // pavgb mm, mm/m64
    let destination: [u8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [u8; 8] = std::mem::transmute(source);
    let mut result = [0; 8];
    for i in 0..8 {
        result[i] = (destination[i] as i32 + source[i] as i32 + 1 >> 1) as u8;
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FE0_reg(r1: i32, r2: i32) { instr_0FE0(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FE0_mem(addr: i32, r: i32) {
    instr_0FE0(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE0(source: reg128, r: i32) {
    // pavgb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..16 {
        result.u8[i] = (destination.u8[i] as i32 + source.u8[i] as i32 + 1 >> 1) as u8;
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FE0_reg(r1: i32, r2: i32) { instr_660FE0(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FE0_mem(addr: i32, r: i32) {
    instr_660FE0(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE1(source: u64, r: i32) {
    // psraw mm, mm/m64
    psraw_r64(r, source);
}
pub unsafe fn instr_0FE1_reg(r1: i32, r2: i32) { instr_0FE1(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FE1_mem(addr: i32, r: i32) {
    instr_0FE1(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE1(source: reg128, r: i32) {
    // psraw xmm, xmm/m128
    // XXX: Aligned access or #gp
    psraw_r128(r, source.u64[0]);
}
pub unsafe fn instr_660FE1_reg(r1: i32, r2: i32) { instr_660FE1(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FE1_mem(addr: i32, r: i32) {
    instr_660FE1(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE2(source: u64, r: i32) {
    // psrad mm, mm/m64
    psrad_r64(r, source);
}
pub unsafe fn instr_0FE2_reg(r1: i32, r2: i32) { instr_0FE2(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FE2_mem(addr: i32, r: i32) {
    instr_0FE2(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE2(source: reg128, r: i32) {
    // psrad xmm, xmm/m128
    // XXX: Aligned access or #gp
    psrad_r128(r, source.u64[0]);
}
pub unsafe fn instr_660FE2_reg(r1: i32, r2: i32) { instr_660FE2(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FE2_mem(addr: i32, r: i32) {
    instr_660FE2(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE3(source: u64, r: i32) {
    // pavgw mm, mm/m64
    let destination: [u16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [u16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = (destination[i] as i32 + source[i] as i32 + 1 >> 1) as u16
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FE3_reg(r1: i32, r2: i32) { instr_0FE3(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FE3_mem(addr: i32, r: i32) {
    instr_0FE3(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE3(source: reg128, r: i32) {
    // pavgw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let mut destination = read_xmm128s(r);
    for i in 0..8 {
        destination.u16[i] = (destination.u16[i] as i32 + source.u16[i] as i32 + 1 >> 1) as u16;
    }
    write_xmm_reg128(r, destination);
}
pub unsafe fn instr_660FE3_reg(r1: i32, r2: i32) { instr_660FE3(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FE3_mem(addr: i32, r: i32) {
    instr_660FE3(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE4(source: u64, r: i32) {
    // pmulhuw mm, mm/m64
    let destination: [u16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [u16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = ((destination[i] as i32 * source[i] as i32) >> 16) as u16
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FE4_reg(r1: i32, r2: i32) { instr_0FE4(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FE4_mem(addr: i32, r: i32) {
    instr_0FE4(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE4(source: reg128, r: i32) {
    // pmulhuw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u16[i] = (source.u16[i] as i32 * destination.u16[i] as i32 >> 16) as u16;
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FE4_reg(r1: i32, r2: i32) { instr_660FE4(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FE4_mem(addr: i32, r: i32) {
    instr_660FE4(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE5(source: u64, r: i32) {
    // pmulhw mm, mm/m64
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [i16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = ((destination[i] as i32 * source[i] as i32) >> 16) as i16
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FE5_reg(r1: i32, r2: i32) { instr_0FE5(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FE5_mem(addr: i32, r: i32) {
    instr_0FE5(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE5(source: reg128, r: i32) {
    // pmulhw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u16[i] = (destination.i16[i] as i32 * source.i16[i] as i32 >> 16) as u16
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FE5_reg(r1: i32, r2: i32) { instr_660FE5(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FE5_mem(addr: i32, r: i32) {
    instr_660FE5(return_on_pagefault!(safe_read128s(addr)), r);
}

#[no_mangle]
pub unsafe fn instr_0FE6_mem(_addr: i32, _r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn instr_0FE6_reg(_r1: i32, _r2: i32) { trigger_ud(); }

#[no_mangle]
pub unsafe fn instr_660FE6(source: reg128, r: i32) {
    // cvttpd2dq xmm1, xmm2/m128
    let result = reg128 {
        i32: [
            sse_convert_with_truncation_f64_to_i32(source.f64[0]),
            sse_convert_with_truncation_f64_to_i32(source.f64[1]),
            0,
            0,
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FE6_mem(addr: i32, r: i32) {
    instr_660FE6(return_on_pagefault!(safe_read128s(addr)), r);
}
pub unsafe fn instr_660FE6_reg(r1: i32, r2: i32) { instr_660FE6(read_xmm128s(r1), r2); }

#[no_mangle]
pub unsafe fn instr_F20FE6(source: reg128, r: i32) {
    // cvtpd2dq xmm1, xmm2/m128
    let result = reg128 {
        i32: [
            // XXX: Precision exception
            sse_convert_f64_to_i32(source.f64[0]),
            sse_convert_f64_to_i32(source.f64[1]),
            0,
            0,
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_F20FE6_mem(addr: i32, r: i32) {
    instr_F20FE6(return_on_pagefault!(safe_read128s(addr)), r);
}
pub unsafe fn instr_F20FE6_reg(r1: i32, r2: i32) { instr_F20FE6(read_xmm128s(r1), r2); }

#[no_mangle]
pub unsafe fn instr_F30FE6(source: u64, r: i32) {
    // cvtdq2pd xmm1, xmm2/m64
    let result = reg128 {
        f64: [
            // Note: Conversion never fails (i32 fits into f64)
            source as i32 as f64,
            (source >> 32) as i32 as f64,
        ],
    };
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_F30FE6_mem(addr: i32, r: i32) {
    instr_F30FE6(return_on_pagefault!(safe_read64s(addr)), r);
}
pub unsafe fn instr_F30FE6_reg(r1: i32, r2: i32) { instr_F30FE6(read_xmm64s(r1), r2); }

#[no_mangle]
pub unsafe fn instr_0FE7_mem(addr: i32, r: i32) {
    // movntq m64, mm
    mov_r_m64(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0FE7_reg(_r1: i32, _r2: i32) { trigger_ud(); }
pub unsafe fn instr_660FE7_reg(_r1: i32, _r2: i32) { trigger_ud(); }
pub unsafe fn instr_660FE7_mem(addr: i32, r: i32) {
    // movntdq m128, xmm
    mov_r_m128(addr, r);
}
#[no_mangle]
pub unsafe fn instr_0FE8(source: u64, r: i32) {
    // psubsb mm, mm/m64
    let destination: [i8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [i8; 8] = std::mem::transmute(source);
    let mut result = [0; 8];
    for i in 0..8 {
        result[i] = saturate_sd_to_sb(destination[i] as u32 - source[i] as u32);
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FE8_reg(r1: i32, r2: i32) { instr_0FE8(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FE8_mem(addr: i32, r: i32) {
    instr_0FE8(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE8(source: reg128, r: i32) {
    // psubsb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..16 {
        result.i8[i] = saturate_sd_to_sb(destination.i8[i] as u32 - source.i8[i] as u32);
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FE8_reg(r1: i32, r2: i32) { instr_660FE8(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FE8_mem(addr: i32, r: i32) {
    instr_660FE8(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FE9(source: u64, r: i32) {
    // psubsw mm, mm/m64
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [i16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = saturate_sd_to_sw(destination[i] as u32 - source[i] as u32)
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FE9_reg(r1: i32, r2: i32) { instr_0FE9(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FE9_mem(addr: i32, r: i32) {
    instr_0FE9(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FE9(source: reg128, r: i32) {
    // psubsw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u16[i] = saturate_sd_to_sw(destination.i16[i] as u32 - source.i16[i] as u32)
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FE9_reg(r1: i32, r2: i32) { instr_660FE9(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FE9_mem(addr: i32, r: i32) {
    instr_660FE9(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEA(source: u64, r: i32) {
    // pminsw mm, mm/m64
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [i16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = i16::min(destination[i], source[i])
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FEA_reg(r1: i32, r2: i32) { instr_0FEA(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FEA_mem(addr: i32, r: i32) {
    instr_0FEA(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEA(source: reg128, r: i32) {
    // pminsw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.i16[i] = i16::min(destination.i16[i], source.i16[i])
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FEA_reg(r1: i32, r2: i32) { instr_660FEA(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FEA_mem(addr: i32, r: i32) {
    instr_660FEA(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEB(source: u64, r: i32) {
    // por mm, mm/m64
    let destination = read_mmx64s(r);
    write_mmx_reg64(r, source | destination);
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FEB_reg(r1: i32, r2: i32) { instr_0FEB(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FEB_mem(addr: i32, r: i32) {
    instr_0FEB(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEB(source: reg128, r: i32) {
    // por xmm, xmm/m128
    // XXX: Aligned access or #gp
    por_r128(source, r);
}
pub unsafe fn instr_660FEB_reg(r1: i32, r2: i32) { instr_660FEB(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FEB_mem(addr: i32, r: i32) {
    instr_660FEB(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEC(source: u64, r: i32) {
    // paddsb mm, mm/m64
    let destination: [i8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [i8; 8] = std::mem::transmute(source);
    let mut result = [0; 8];
    for i in 0..8 {
        result[i] = saturate_sd_to_sb(destination[i] as u32 + source[i] as u32);
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FEC_reg(r1: i32, r2: i32) { instr_0FEC(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FEC_mem(addr: i32, r: i32) {
    instr_0FEC(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEC(source: reg128, r: i32) {
    // paddsb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..16 {
        result.i8[i] = saturate_sd_to_sb(destination.i8[i] as u32 + source.i8[i] as u32);
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FEC_reg(r1: i32, r2: i32) { instr_660FEC(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FEC_mem(addr: i32, r: i32) {
    instr_660FEC(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FED(source: u64, r: i32) {
    // paddsw mm, mm/m64
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [i16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = saturate_sd_to_sw(destination[i] as u32 + source[i] as u32)
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FED_reg(r1: i32, r2: i32) { instr_0FED(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FED_mem(addr: i32, r: i32) {
    instr_0FED(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FED(source: reg128, r: i32) {
    // paddsw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u16[i] = saturate_sd_to_sw(destination.i16[i] as u32 + source.i16[i] as u32)
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FED_reg(r1: i32, r2: i32) { instr_660FED(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FED_mem(addr: i32, r: i32) {
    instr_660FED(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEE(source: u64, r: i32) {
    // pmaxsw mm, mm/m64
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [i16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = i16::max(destination[i], source[i])
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FEE_reg(r1: i32, r2: i32) { instr_0FEE(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FEE_mem(addr: i32, r: i32) {
    instr_0FEE(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEE(source: reg128, r: i32) {
    // pmaxsw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.i16[i] = i16::max(destination.i16[i], source.i16[i])
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FEE_reg(r1: i32, r2: i32) { instr_660FEE(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FEE_mem(addr: i32, r: i32) {
    instr_660FEE(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FEF(source: u64, r: i32) {
    // pxor mm, mm/m64
    let destination = read_mmx64s(r);
    write_mmx_reg64(r, source ^ destination);
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FEF_reg(r1: i32, r2: i32) { instr_0FEF(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FEF_mem(addr: i32, r: i32) {
    instr_0FEF(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FEF(source: reg128, r: i32) {
    // pxor xmm, xmm/m128
    // XXX: Aligned access or #gp
    pxor_r128(source, r);
}
pub unsafe fn instr_660FEF_reg(r1: i32, r2: i32) { instr_660FEF(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FEF_mem(addr: i32, r: i32) {
    instr_660FEF(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF0() { unimplemented_sse(); }
#[no_mangle]
pub unsafe fn instr_0FF1(source: u64, r: i32) {
    // psllw mm, mm/m64
    psllw_r64(r, source);
}
pub unsafe fn instr_0FF1_reg(r1: i32, r2: i32) { instr_0FF1(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FF1_mem(addr: i32, r: i32) {
    instr_0FF1(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF1(source: reg128, r: i32) {
    // psllw xmm, xmm/m128
    // XXX: Aligned access or #gp
    psllw_r128(r, source.u64[0]);
}
pub unsafe fn instr_660FF1_reg(r1: i32, r2: i32) { instr_660FF1(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FF1_mem(addr: i32, r: i32) {
    instr_660FF1(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF2(source: u64, r: i32) {
    // pslld mm, mm/m64
    pslld_r64(r, source);
}
pub unsafe fn instr_0FF2_reg(r1: i32, r2: i32) { instr_0FF2(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FF2_mem(addr: i32, r: i32) {
    instr_0FF2(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF2(source: reg128, r: i32) {
    // pslld xmm, xmm/m128
    // XXX: Aligned access or #gp
    pslld_r128(r, source.u64[0]);
}
pub unsafe fn instr_660FF2_reg(r1: i32, r2: i32) { instr_660FF2(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FF2_mem(addr: i32, r: i32) {
    instr_660FF2(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF3(source: u64, r: i32) {
    // psllq mm, mm/m64
    psllq_r64(r, source);
}
pub unsafe fn instr_0FF3_reg(r1: i32, r2: i32) { instr_0FF3(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FF3_mem(addr: i32, r: i32) {
    instr_0FF3(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF3(source: reg128, r: i32) {
    // psllq xmm, xmm/m128
    // XXX: Aligned access or #gp
    psllq_r128(r, source.u64[0]);
}
pub unsafe fn instr_660FF3_reg(r1: i32, r2: i32) { instr_660FF3(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FF3_mem(addr: i32, r: i32) {
    instr_660FF3(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF4(source: u64, r: i32) {
    // pmuludq mm, mm/m64
    let destination = read_mmx64s(r);
    write_mmx_reg64(r, (source as u32 as u64) * (destination as u32 as u64));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FF4_reg(r1: i32, r2: i32) { instr_0FF4(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FF4_mem(addr: i32, r: i32) {
    instr_0FF4(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF4(source: reg128, r: i32) {
    // pmuludq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    result.u64[0] = source.u32[0] as u64 * destination.u32[0] as u64;
    result.u64[1] = source.u32[2] as u64 * destination.u32[2] as u64;
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FF4_reg(r1: i32, r2: i32) { instr_660FF4(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FF4_mem(addr: i32, r: i32) {
    instr_660FF4(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF5(source: u64, r: i32) {
    // pmaddwd mm, mm/m64
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [i16; 4] = std::mem::transmute(source);
    let mul0 = destination[0] as i32 * source[0] as i32;
    let mul1 = destination[1] as i32 * source[1] as i32;
    let mul2 = destination[2] as i32 * source[2] as i32;
    let mul3 = destination[3] as i32 * source[3] as i32;
    let low = mul0 + mul1;
    let high = mul2 + mul3;
    write_mmx_reg64(r, low as u32 as u64 | (high as u64) << 32);
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FF5_reg(r1: i32, r2: i32) { instr_0FF5(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FF5_mem(addr: i32, r: i32) {
    instr_0FF5(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF5(source: reg128, r: i32) {
    // pmaddwd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..4 {
        result.i32[i] = destination.i16[2 * i] as i32 * source.i16[2 * i] as i32
            + destination.i16[2 * i + 1] as i32 * source.i16[2 * i + 1] as i32
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FF5_reg(r1: i32, r2: i32) { instr_660FF5(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FF5_mem(addr: i32, r: i32) {
    instr_660FF5(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF6(source: u64, r: i32) {
    // psadbw mm, mm/m64
    let destination: [u8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [u8; 8] = std::mem::transmute(source);
    let mut sum = 0;
    for i in 0..8 {
        sum += (destination[i] as i32 - source[i] as i32).abs() as u64;
    }
    write_mmx_reg64(r, sum);
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FF6_reg(r1: i32, r2: i32) { instr_0FF6(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FF6_mem(addr: i32, r: i32) {
    instr_0FF6(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF6(source: reg128, r: i32) {
    // psadbw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut sum0 = 0;
    let mut sum1 = 0;
    for i in 0..8 {
        sum0 += (destination.u8[i + 0] as i32 - source.u8[i + 0] as i32).abs() as u32;
        sum1 += (destination.u8[i + 8] as i32 - source.u8[i + 8] as i32).abs() as u32;
    }
    write_xmm128(r, sum0 as i32, 0, sum1 as i32, 0);
}
pub unsafe fn instr_660FF6_reg(r1: i32, r2: i32) { instr_660FF6(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FF6_mem(addr: i32, r: i32) {
    instr_660FF6(return_on_pagefault!(safe_read128s(addr)), r);
}

pub unsafe fn instr_0FF7_mem(_addr: i32, _r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn maskmovq(r1: i32, r2: i32, addr: i32) {
    // maskmovq mm, mm
    let source: [u8; 8] = std::mem::transmute(read_mmx64s(r2));
    let mask: [u8; 8] = std::mem::transmute(read_mmx64s(r1));
    match writable_or_pagefault(addr, 8) {
        Ok(()) => *page_fault = false,
        Err(()) => {
            *page_fault = true;
            return;
        },
    }
    for i in 0..8 {
        if 0 != mask[i] & 0x80 {
            safe_write8(addr + i as i32, source[i] as i32).unwrap();
        }
    }
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FF7_reg(r1: i32, r2: i32) {
    maskmovq(
        r1,
        r2,
        return_on_pagefault!(get_seg_prefix_ds(get_reg_asize(EDI))),
    )
}

pub unsafe fn instr_660FF7_mem(_addr: i32, _r: i32) { trigger_ud(); }
#[no_mangle]
pub unsafe fn maskmovdqu(r1: i32, r2: i32, addr: i32) {
    // maskmovdqu xmm, xmm
    let source = read_xmm128s(r2);
    let mask = read_xmm128s(r1);
    match writable_or_pagefault(addr, 16) {
        Ok(()) => *page_fault = false,
        Err(()) => {
            *page_fault = true;
            return;
        },
    }
    for i in 0..16 {
        if 0 != mask.u8[i] & 0x80 {
            safe_write8(addr + i as i32, source.u8[i] as i32).unwrap();
        }
    }
}
pub unsafe fn instr_660FF7_reg(r1: i32, r2: i32) {
    maskmovdqu(
        r1,
        r2,
        return_on_pagefault!(get_seg_prefix_ds(get_reg_asize(EDI))),
    )
}
#[no_mangle]
pub unsafe fn instr_0FF8(source: u64, r: i32) {
    // psubb mm, mm/m64
    let destination: [u8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [u8; 8] = std::mem::transmute(source);
    let mut result = [0; 8];
    for i in 0..8 {
        result[i] = destination[i] - source[i];
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FF8_reg(r1: i32, r2: i32) { instr_0FF8(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FF8_mem(addr: i32, r: i32) {
    instr_0FF8(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF8(source: reg128, r: i32) {
    // psubb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..16 {
        result.u8[i] = destination.u8[i] - source.u8[i];
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FF8_reg(r1: i32, r2: i32) { instr_660FF8(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FF8_mem(addr: i32, r: i32) {
    instr_660FF8(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FF9(source: u64, r: i32) {
    // psubw mm, mm/m64
    let destination: [i16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [i16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = destination[i] - source[i]
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FF9_reg(r1: i32, r2: i32) { instr_0FF9(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FF9_mem(addr: i32, r: i32) {
    instr_0FF9(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FF9(source: reg128, r: i32) {
    // psubw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.i16[i] = destination.i16[i] - source.i16[i]
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FF9_reg(r1: i32, r2: i32) { instr_660FF9(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FF9_mem(addr: i32, r: i32) {
    instr_660FF9(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFA(source: u64, r: i32) {
    // psubd mm, mm/m64
    let destination: [i32; 2] = std::mem::transmute(read_mmx64s(r));
    let source: [i32; 2] = std::mem::transmute(source);
    let mut result = [0; 2];
    for i in 0..2 {
        result[i] = destination[i] - source[i]
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FFA_reg(r1: i32, r2: i32) { instr_0FFA(read_mmx64s(r1), r2); }
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
        destination.i32[0] - source.i32[0],
        destination.i32[1] - source.i32[1],
        destination.i32[2] - source.i32[2],
        destination.i32[3] - source.i32[3],
    );
}
pub unsafe fn instr_660FFA_reg(r1: i32, r2: i32) { instr_660FFA(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FFA_mem(addr: i32, r: i32) {
    instr_660FFA(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFB(source: u64, r: i32) {
    // psubq mm, mm/m64
    write_mmx_reg64(r, read_mmx64s(r) - source);
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FFB_reg(r1: i32, r2: i32) { instr_0FFB(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FFB_mem(addr: i32, r: i32) {
    instr_0FFB(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFB(source: reg128, r: i32) {
    // psubq xmm, xmm/m128
    // XXX: Aligned access or #gp
    let mut destination = read_xmm128s(r);
    destination.u64[0] = destination.u64[0] - source.u64[0];
    destination.u64[1] = destination.u64[1] - source.u64[1];
    write_xmm_reg128(r, destination);
}
pub unsafe fn instr_660FFB_reg(r1: i32, r2: i32) { instr_660FFB(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FFB_mem(addr: i32, r: i32) {
    instr_660FFB(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFC(source: u64, r: i32) {
    // paddb mm, mm/m64
    let destination: [u8; 8] = std::mem::transmute(read_mmx64s(r));
    let source: [u8; 8] = std::mem::transmute(source);
    let mut result = [0; 8];
    for i in 0..8 {
        result[i] = destination[i] + source[i];
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FFC_reg(r1: i32, r2: i32) { instr_0FFC(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FFC_mem(addr: i32, r: i32) {
    instr_0FFC(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFC(source: reg128, r: i32) {
    // paddb xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..16 {
        result.u8[i] = destination.u8[i] + source.u8[i];
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FFC_reg(r1: i32, r2: i32) { instr_660FFC(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FFC_mem(addr: i32, r: i32) {
    instr_660FFC(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFD(source: u64, r: i32) {
    // paddw mm, mm/m64
    let destination: [u16; 4] = std::mem::transmute(read_mmx64s(r));
    let source: [u16; 4] = std::mem::transmute(source);
    let mut result = [0; 4];
    for i in 0..4 {
        result[i] = destination[i] + source[i]
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FFD_reg(r1: i32, r2: i32) { instr_0FFD(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FFD_mem(addr: i32, r: i32) {
    instr_0FFD(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFD(source: reg128, r: i32) {
    // paddw xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let mut result = reg128 { i8: [0; 16] };
    for i in 0..8 {
        result.u16[i] = (destination.u16[i] as i32 + source.u16[i] as i32 & 0xFFFF) as u16;
    }
    write_xmm_reg128(r, result);
}
pub unsafe fn instr_660FFD_reg(r1: i32, r2: i32) { instr_660FFD(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FFD_mem(addr: i32, r: i32) {
    instr_660FFD(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFE(source: u64, r: i32) {
    // paddd mm, mm/m64
    let destination: [i32; 2] = std::mem::transmute(read_mmx64s(r));
    let source: [i32; 2] = std::mem::transmute(source);
    let mut result = [0; 2];
    for i in 0..2 {
        result[i] = destination[i] + source[i]
    }
    write_mmx_reg64(r, std::mem::transmute(result));
    transition_fpu_to_mmx();
}
pub unsafe fn instr_0FFE_reg(r1: i32, r2: i32) { instr_0FFE(read_mmx64s(r1), r2); }
pub unsafe fn instr_0FFE_mem(addr: i32, r: i32) {
    instr_0FFE(return_on_pagefault!(safe_read64s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_660FFE(source: reg128, r: i32) {
    // paddd xmm, xmm/m128
    // XXX: Aligned access or #gp
    let destination = read_xmm128s(r);
    let dword0 = destination.i32[0] + source.i32[0];
    let dword1 = destination.i32[1] + source.i32[1];
    let dword2 = destination.i32[2] + source.i32[2];
    let dword3 = destination.i32[3] + source.i32[3];
    write_xmm128(r, dword0, dword1, dword2, dword3);
}
pub unsafe fn instr_660FFE_reg(r1: i32, r2: i32) { instr_660FFE(read_xmm128s(r1), r2); }
pub unsafe fn instr_660FFE_mem(addr: i32, r: i32) {
    instr_660FFE(return_on_pagefault!(safe_read128s(addr)), r);
}
#[no_mangle]
pub unsafe fn instr_0FFF() {
    // Windows 98
    dbg_log!("#ud: 0F FF");
    trigger_ud();
}
