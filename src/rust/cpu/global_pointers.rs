#![allow(non_upper_case_globals)]

use crate::cpu::cpu::reg128;
use crate::softfloat::F80;
use crate::state_flags::CachedStateFlags;

pub const reg8: *mut u8 = 64 as *mut u8;
pub const reg16: *mut u16 = 64 as *mut u16;
pub const reg32: *mut i32 = 64 as *mut i32;

pub const last_op_size: *mut i32 = 96 as *mut i32;
pub const flags_changed: *mut i32 = 100 as *mut i32;
pub const last_op1: *mut i32 = 104 as *mut i32;
pub const state_flags: *mut CachedStateFlags = 108 as *mut CachedStateFlags;
pub const last_result: *mut i32 = 112 as *mut i32;
pub const flags: *mut i32 = 120 as *mut i32;

pub const segment_access_bytes: *mut u8 = 512 as *mut u8; // TODO: reorder below segment_limits

pub const apic_enabled: *mut bool = 548 as *mut bool;
pub const acpi_enabled: *mut bool = 552 as *mut bool;

pub const instruction_pointer: *mut i32 = 556 as *mut i32;
pub const previous_ip: *mut i32 = 560 as *mut i32;
pub const idtr_size: *mut i32 = 564 as *mut i32;
pub const idtr_offset: *mut i32 = 568 as *mut i32;
pub const gdtr_size: *mut i32 = 572 as *mut i32;
pub const gdtr_offset: *mut i32 = 576 as *mut i32;
pub const cr: *mut i32 = 580 as *mut i32;
pub const cpl: *mut u8 = 612 as *mut u8;
pub const in_hlt: *mut bool = 616 as *mut bool;
pub const last_virt_eip: *mut i32 = 620 as *mut i32;
pub const eip_phys: *mut i32 = 624 as *mut i32;

pub const sysenter_cs: *mut i32 = 636 as *mut i32;
pub const sysenter_esp: *mut i32 = 640 as *mut i32;
pub const sysenter_eip: *mut i32 = 644 as *mut i32;
pub const prefixes: *mut u8 = 648 as *mut u8;
pub const instruction_counter: *mut u32 = 664 as *mut u32;
pub const sreg: *mut u16 = 668 as *mut u16;
pub const dreg: *mut i32 = 684 as *mut i32;

// filled in by svga_fill_pixel_buffer, read by javacsript for optimised putImageData calls
pub const svga_dirty_bitmap_min_offset: *mut u32 = 716 as *mut u32;
pub const svga_dirty_bitmap_max_offset: *mut u32 = 720 as *mut u32;

pub const segment_is_null: *mut bool = 724 as *mut bool;
pub const segment_offsets: *mut i32 = 736 as *mut i32;
pub const segment_limits: *mut u32 = 768 as *mut u32;

pub const protected_mode: *mut bool = 800 as *mut bool;
pub const is_32: *mut bool = 804 as *mut bool;
pub const stack_size_32: *mut bool = 808 as *mut bool;
pub const memory_size: *mut u32 = 812 as *mut u32;
pub const fpu_stack_empty: *mut u8 = 816 as *mut u8;
pub const mxcsr: *mut i32 = 824 as *mut i32;

pub const reg_xmm: *mut reg128 = 832 as *mut reg128;
pub const current_tsc: *mut u64 = 960 as *mut u64;

pub const reg_pdpte: *mut u64 = 968 as *mut u64; // 4 64-bit entries

pub const fpu_stack_ptr: *mut u8 = 1032 as *mut u8;
pub const fpu_control_word: *mut u16 = 1036 as *mut u16;
pub const fpu_status_word: *mut u16 = 1040 as *mut u16;
pub const fpu_opcode: *mut i32 = 1044 as *mut i32;
pub const fpu_ip: *mut i32 = 1048 as *mut i32;
pub const fpu_ip_selector: *mut i32 = 1052 as *mut i32;
pub const fpu_dp: *mut i32 = 1056 as *mut i32;
pub const fpu_dp_selector: *mut i32 = 1060 as *mut i32;
pub const tss_size_32: *mut bool = 1128 as *mut bool;

pub const sse_scratch_register: *mut reg128 = 1136 as *mut reg128;

pub const fpu_st: *mut F80 = 1152 as *mut F80;

// ── x86-64 / long mode state ─────────────────────────────────────────────────
// EFER MSR value (u32 is sufficient; bits above 11 are reserved)
pub const efer: *mut u32 = 1288 as *mut u32;

// When EFER.LME=1 and CR0.PG=1 the CPU activates long mode (EFER.LMA).
// This flag mirrors EFER.LMA and is checked by the interpreter dispatch.
pub const is_long_mode: *mut bool = 1292 as *mut bool;

// High 32 bits of the 64-bit GPRs (RAX–RDI = indices 0–7).
// The low 32 bits live in the existing reg32 array at offset 64.
// Layout: reg64h[0]=rax_hi .. reg64h[7]=rdi_hi
pub const reg64h: *mut u32 = 1296 as *mut u32; // 8 × 4 = 32 bytes → ends at 1328

// R8–R15: full 64-bit values stored as two u32 halves (lo at even, hi at odd)
// reg_r8_15[0]=r8_lo, reg_r8_15[1]=r8_hi, ..., reg_r8_15[14]=r15_lo, reg_r8_15[15]=r15_hi
pub const reg_r8_15: *mut u32 = 1328 as *mut u32; // 16 × 4 = 64 bytes → ends at 1392

// 64-bit instruction pointer (high 32 bits; low 32 bits = instruction_pointer)
pub const rip_high: *mut u32 = 1392 as *mut u32;

// SYSCALL/SYSRET MSRs
pub const msr_star: *mut u64 = 1400 as *mut u64;
pub const msr_lstar: *mut u64 = 1408 as *mut u64;
pub const msr_cstar: *mut u64 = 1416 as *mut u64;
pub const msr_fmask: *mut u32 = 1424 as *mut u32;
pub const msr_kernel_gs_base: *mut u64 = 1432 as *mut u64;
pub const pat: *mut u64 = 1288 as *mut u64;

pub fn get_reg32_offset(r: u32) -> u32 {
    dbg_assert!(r < 8);
    (unsafe { reg32.offset(r as isize) }) as u32
}

pub fn get_reg_mmx_offset(r: u32) -> u32 {
    dbg_assert!(r < 8);
    (unsafe { fpu_st.offset(r as isize) }) as u32
}

pub fn get_reg_xmm_offset(r: u32) -> u32 {
    dbg_assert!(r < 8);
    (unsafe { reg_xmm.offset(r as isize) }) as u32
}

pub fn get_sreg_offset(s: u32) -> u32 {
    dbg_assert!(s < 6);
    (unsafe { sreg.offset(s as isize) }) as u32
}

pub fn get_seg_offset(s: u32) -> u32 {
    dbg_assert!(s < 8);
    (unsafe { segment_offsets.offset(s as isize) }) as u32
}

pub fn get_segment_is_null_offset(s: u32) -> u32 {
    dbg_assert!(s < 8);
    (unsafe { segment_is_null.offset(s as isize) }) as u32
}

pub fn get_creg_offset(i: u32) -> u32 {
    dbg_assert!(i < 8);
    (unsafe { cr.offset(i as isize) }) as u32
}
