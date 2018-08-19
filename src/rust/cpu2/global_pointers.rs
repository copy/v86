#![allow(
    dead_code,
    mutable_transmutes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_mut
)]
#![feature(extern_types, libc)]

use cpu2::cpu::{reg128, reg64};

#[no_mangle]
pub static mut reg8: *mut u8 = unsafe { 4i32 as *mut u8 };
#[no_mangle]
pub static mut reg16: *mut u16 = unsafe { 4i32 as *mut u16 };
#[no_mangle]
pub static mut reg8s: *mut i8 = unsafe { 4i32 as *mut i8 };
#[no_mangle]
pub static mut reg16s: *mut i16 = unsafe { 4i32 as *mut i16 };
#[no_mangle]
pub static mut reg32s: *mut i32 = unsafe { 4i32 as *mut i32 };
#[no_mangle]
pub static mut last_op1: *mut i32 = unsafe { 512i32 as *mut i32 };
#[no_mangle]
pub static mut last_op2: *mut i32 = unsafe { 516i32 as *mut i32 };
#[no_mangle]
pub static mut last_op_size: *mut i32 = unsafe { 520i32 as *mut i32 };
#[no_mangle]
pub static mut last_add_result: *mut i32 = unsafe { 524i32 as *mut i32 };
#[no_mangle]
pub static mut last_result: *mut i32 = unsafe { 528i32 as *mut i32 };
#[no_mangle]
pub static mut flags_changed: *mut i32 = unsafe { 532i32 as *mut i32 };
#[no_mangle]
pub static mut flags: *mut i32 = unsafe { 536i32 as *mut i32 };
#[no_mangle]
pub static mut page_fault: *mut bool = unsafe { 540i32 as *mut bool };
#[no_mangle]
pub static mut a20_enabled: *mut bool = unsafe { 552i32 as *mut bool };
#[no_mangle]
pub static mut instruction_pointer: *mut i32 = unsafe { 556i32 as *mut i32 };
#[no_mangle]
pub static mut previous_ip: *mut i32 = unsafe { 560i32 as *mut i32 };
#[no_mangle]
pub static mut idtr_size: *mut i32 = unsafe { 564i32 as *mut i32 };
#[no_mangle]
pub static mut idtr_offset: *mut i32 = unsafe { 568i32 as *mut i32 };
#[no_mangle]
pub static mut gdtr_size: *mut i32 = unsafe { 572i32 as *mut i32 };
#[no_mangle]
pub static mut gdtr_offset: *mut i32 = unsafe { 576i32 as *mut i32 };
#[no_mangle]
pub static mut cr: *mut i32 = unsafe { 580i32 as *mut i32 };
#[no_mangle]
pub static mut cpl: *mut u8 = unsafe { 612i32 as *mut u8 };
#[no_mangle]
pub static mut in_hlt: *mut bool = unsafe { 616i32 as *mut bool };
#[no_mangle]
pub static mut last_virt_eip: *mut i32 = unsafe { 620i32 as *mut i32 };
#[no_mangle]
pub static mut eip_phys: *mut i32 = unsafe { 624i32 as *mut i32 };
#[no_mangle]
pub static mut last_virt_esp: *mut i32 = unsafe { 628i32 as *mut i32 };
#[no_mangle]
pub static mut esp_phys: *mut i32 = unsafe { 632i32 as *mut i32 };
#[no_mangle]
pub static mut sysenter_cs: *mut i32 = unsafe { 636i32 as *mut i32 };
#[no_mangle]
pub static mut sysenter_esp: *mut i32 = unsafe { 640i32 as *mut i32 };
#[no_mangle]
pub static mut sysenter_eip: *mut i32 = unsafe { 644i32 as *mut i32 };
#[no_mangle]
pub static mut prefixes: *mut u8 = unsafe { 648i32 as *mut u8 };
#[no_mangle]
pub static mut timestamp_counter: *mut u32 = unsafe { 664i32 as *mut u32 };
#[no_mangle]
pub static mut sreg: *mut u16 = unsafe { 668i32 as *mut u16 };
#[no_mangle]
pub static mut dreg: *mut i32 = unsafe { 684i32 as *mut i32 };
#[no_mangle]
pub static mut fw_value: *mut i32 = unsafe { 720i32 as *mut i32 };
#[no_mangle]
pub static mut segment_is_null: *mut bool = unsafe { 724i32 as *mut bool };
#[no_mangle]
pub static mut segment_offsets: *mut i32 = unsafe { 736i32 as *mut i32 };
#[no_mangle]
pub static mut segment_limits: *mut u32 = unsafe { 768i32 as *mut u32 };
#[no_mangle]
pub static mut protected_mode: *mut bool = unsafe { 800i32 as *mut bool };
#[no_mangle]
pub static mut is_32: *mut bool = unsafe { 804i32 as *mut bool };
#[no_mangle]
pub static mut stack_size_32: *mut bool = unsafe { 808i32 as *mut bool };
#[no_mangle]
pub static mut memory_size: *mut u32 = unsafe { 812i32 as *mut u32 };
#[no_mangle]
pub static mut fpu_stack_empty: *mut i32 = unsafe { 816i32 as *mut i32 };
#[no_mangle]
pub static mut mxcsr: *mut i32 = unsafe { 824i32 as *mut i32 };
#[no_mangle]
pub static mut reg_xmm: *mut reg128 = unsafe { 828i32 as *mut reg128 };
#[no_mangle]
pub static mut current_tsc: *mut u64 = unsafe { 956i32 as *mut u64 };
#[no_mangle]
pub static mut fpu_st: *mut f64 = unsafe { 968i32 as *mut f64 };
#[no_mangle]
pub static mut fpu_st8: *mut u8 = unsafe { 968i32 as *mut u8 };
#[no_mangle]
pub static mut fpu_st32: *mut i32 = unsafe { 968i32 as *mut i32 };
#[no_mangle]
pub static mut fpu_stack_ptr: *mut u32 = unsafe { 1032i32 as *mut u32 };
#[no_mangle]
pub static mut fpu_control_word: *mut i32 = unsafe { 1036i32 as *mut i32 };
#[no_mangle]
pub static mut fpu_status_word: *mut i32 = unsafe { 1040i32 as *mut i32 };
#[no_mangle]
pub static mut fpu_opcode: *mut i32 = unsafe { 1044i32 as *mut i32 };
#[no_mangle]
pub static mut fpu_ip: *mut i32 = unsafe { 1048i32 as *mut i32 };
#[no_mangle]
pub static mut fpu_ip_selector: *mut i32 = unsafe { 1052i32 as *mut i32 };
#[no_mangle]
pub static mut fpu_dp: *mut i32 = unsafe { 1056i32 as *mut i32 };
#[no_mangle]
pub static mut fpu_dp_selector: *mut i32 = unsafe { 1060i32 as *mut i32 };
#[no_mangle]
pub static mut reg_mmx: *mut reg64 = unsafe { 1064i32 as *mut reg64 };
#[no_mangle]
pub static mut opstats_buffer: *mut u32 = unsafe { 4096i32 as *mut u32 };
#[no_mangle]
pub static mut opstats_buffer_0f: *mut u32 = unsafe { 5120i32 as *mut u32 };
#[no_mangle]
pub static mut tlb_data: *mut i32 = unsafe { 4194304i32 as *mut i32 };
