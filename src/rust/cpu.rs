// TODO: Make this an instance, so we can plug in a fake cpu

use page::Page;
use state_flags::CachedStateFlags;

mod unsafe_cpu {
    extern "C" {
        pub fn tlb_set_has_code(physical_page: u32, has_code: bool);
        pub fn read8(addr: u32) -> u8;
        pub fn read16(addr: u32) -> u16;
        pub fn read32s(addr: u32) -> u32;
        pub fn check_tlb_invariants();

        pub fn codegen_finalize(
            wasm_table_index: u16,
            phys_addr: u32,
            end_addr: u32,
            first_opcode: u32,
            state_flags: u32,
        );
        pub fn jit_clear_func(wasm_table_index: u16);
    }
}

#[derive(Copy, Clone, Eq, PartialEq)]
pub enum BitSize {
    BYTE,
    WORD,
    DWORD,
}

pub fn read8(addr: u32) -> u8 { unsafe { unsafe_cpu::read8(addr) } }
pub fn read16(addr: u32) -> u16 { unsafe { unsafe_cpu::read16(addr) } }
pub fn read32(addr: u32) -> u32 { unsafe { unsafe_cpu::read32s(addr) } }

pub fn tlb_set_has_code(physical_page: Page, has_code: bool) {
    unsafe { unsafe_cpu::tlb_set_has_code(physical_page.to_u32(), has_code) }
}

pub fn check_tlb_invariants() { unsafe { unsafe_cpu::check_tlb_invariants() } }

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
