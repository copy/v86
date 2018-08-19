#![allow(
    dead_code,
    mutable_transmutes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_mut
)]

use cpu2::cpu::{reg128, reg64};

pub const reg8: *mut u8 = 4i32 as *mut u8;
pub const reg16: *mut u16 = 4i32 as *mut u16;
pub const reg8s: *mut i8 = 4i32 as *mut i8;
pub const reg16s: *mut i16 = 4i32 as *mut i16;
pub const reg32s: *mut i32 = 4i32 as *mut i32;
pub const last_op1: *mut i32 = 512i32 as *mut i32;
pub const last_op2: *mut i32 = 516i32 as *mut i32;
pub const last_op_size: *mut i32 = 520i32 as *mut i32;
pub const last_add_result: *mut i32 = 524i32 as *mut i32;
pub const last_result: *mut i32 = 528i32 as *mut i32;
pub const flags_changed: *mut i32 = 532i32 as *mut i32;
pub const flags: *mut i32 = 536i32 as *mut i32;
pub const page_fault: *mut bool = 540i32 as *mut bool;
pub const a20_enabled: *mut bool = 552i32 as *mut bool;
pub const instruction_pointer: *mut i32 = 556i32 as *mut i32;
pub const previous_ip: *mut i32 = 560i32 as *mut i32;
pub const idtr_size: *mut i32 = 564i32 as *mut i32;
pub const idtr_offset: *mut i32 = 568i32 as *mut i32;
pub const gdtr_size: *mut i32 = 572i32 as *mut i32;
pub const gdtr_offset: *mut i32 = 576i32 as *mut i32;
pub const cr: *mut i32 = 580i32 as *mut i32;
pub const cpl: *mut u8 = 612i32 as *mut u8;
pub const in_hlt: *mut bool = 616i32 as *mut bool;
pub const last_virt_eip: *mut i32 = 620i32 as *mut i32;
pub const eip_phys: *mut i32 = 624i32 as *mut i32;
pub const last_virt_esp: *mut i32 = 628i32 as *mut i32;
pub const esp_phys: *mut i32 = 632i32 as *mut i32;
pub const sysenter_cs: *mut i32 = 636i32 as *mut i32;
pub const sysenter_esp: *mut i32 = 640i32 as *mut i32;
pub const sysenter_eip: *mut i32 = 644i32 as *mut i32;
pub const prefixes: *mut u8 = 648i32 as *mut u8;
pub const timestamp_counter: *mut u32 = 664i32 as *mut u32;
pub const sreg: *mut u16 = 668i32 as *mut u16;
pub const dreg: *mut i32 = 684i32 as *mut i32;
pub const fw_value: *mut i32 = 720i32 as *mut i32;
pub const segment_is_null: *mut bool = 724i32 as *mut bool;
pub const segment_offsets: *mut i32 = 736i32 as *mut i32;
pub const segment_limits: *mut u32 = 768i32 as *mut u32;
pub const protected_mode: *mut bool = 800i32 as *mut bool;
pub const is_32: *mut bool = 804i32 as *mut bool;
pub const stack_size_32: *mut bool = 808i32 as *mut bool;
pub const memory_size: *mut u32 = 812i32 as *mut u32;
pub const fpu_stack_empty: *mut i32 = 816i32 as *mut i32;
pub const mxcsr: *mut i32 = 824i32 as *mut i32;
pub const reg_xmm: *mut reg128 = 828i32 as *mut reg128;
pub const current_tsc: *mut u64 = 956i32 as *mut u64;
pub const fpu_st: *mut f64 = 968i32 as *mut f64;
pub const fpu_st8: *mut u8 = 968i32 as *mut u8;
pub const fpu_st32: *mut i32 = 968i32 as *mut i32;
pub const fpu_stack_ptr: *mut u32 = 1032i32 as *mut u32;
pub const fpu_control_word: *mut i32 = 1036i32 as *mut i32;
pub const fpu_status_word: *mut i32 = 1040i32 as *mut i32;
pub const fpu_opcode: *mut i32 = 1044i32 as *mut i32;
pub const fpu_ip: *mut i32 = 1048i32 as *mut i32;
pub const fpu_ip_selector: *mut i32 = 1052i32 as *mut i32;
pub const fpu_dp: *mut i32 = 1056i32 as *mut i32;
pub const fpu_dp_selector: *mut i32 = 1060i32 as *mut i32;
pub const reg_mmx: *mut reg64 = 1064i32 as *mut reg64;
pub const opstats_buffer: *mut u32 = 4096i32 as *mut u32;
pub const opstats_buffer_0f: *mut u32 = 5120i32 as *mut u32;
pub const tlb_data: *mut i32 = 4194304i32 as *mut i32;
