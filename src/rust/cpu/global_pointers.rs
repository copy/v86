#![allow(non_upper_case_globals)]

use cpu::cpu::reg128;
use softfloat::F80;

pub const reg8: *mut u8 = 64 as *mut u8;
pub const reg16: *mut u16 = 64 as *mut u16;
pub const reg32: *mut i32 = 64 as *mut i32;

pub const last_op1: *mut i32 = 96 as *mut i32;

pub const last_op_size: *mut i32 = 104 as *mut i32;

pub const last_result: *mut i32 = 112 as *mut i32;
pub const flags_changed: *mut i32 = 116 as *mut i32;
pub const flags: *mut i32 = 120 as *mut i32;

pub const page_fault: *mut bool = 540 as *mut bool;

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

pub const opstats_buffer: *mut u32 = 0x08000 as *mut u32;
pub const opstats_compiled_buffer: *mut u32 = 0x10000 as *mut u32;
pub const opstats_jit_exit_buffer: *mut u32 = 0x18000 as *mut u32;
pub const opstats_unguarded_register_buffer: *mut u32 = 0x20000 as *mut u32;
pub const opstats_wasm_size: *mut u32 = 0x28000 as *mut u32;

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
