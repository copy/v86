// TODO: Make this an instance, so we can plug in a fake cpu

use state_flags::CachedStateFlags;

mod unsafe_cpu {
    extern "C" {
        pub fn codegen_finalize(
            wasm_table_index: u16,
            phys_addr: u32,
            end_addr: u32,
            first_opcode: u32,
            state_flags: u32,
        );
        pub fn jit_clear_func(wasm_table_index: u16);
        pub fn jit_clear_all_funcs();
    }
}

pub fn codegen_finalize(
    wasm_table_index: u16,
    phys_addr: u32,
    end_addr: u32,
    first_opcode: u32,
    state_flags: CachedStateFlags,
) {
    unsafe {
        unsafe_cpu::codegen_finalize(
            wasm_table_index,
            phys_addr,
            end_addr,
            first_opcode,
            state_flags.to_u32(),
        )
    }
}

pub fn jit_clear_func(wasm_table_index: u16) {
    unsafe { unsafe_cpu::jit_clear_func(wasm_table_index) }
}

pub fn jit_clear_all_funcs() { unsafe { unsafe_cpu::jit_clear_all_funcs() } }
