//! The ARM core's composition root (the x86 core's is crate::jit): the host
//! environment of the ISA-neutral runtime crate::jitrt. The ARM core has no
//! code client yet (the A64 page tier is P6, the JIT plan's J2).
use crate::jitrt::{self, host::Env};

mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn jit_clear_func(wasm_table_index: u16);
    }
}

/// The table's geometry: as the x86 core's (src/const.js)
pub const WASM_TABLE_SIZE: u32 = 12000;
pub const WASM_TABLE_OFFSET: u32 = 1024;

/// Guest memory's base in the Wasm memory (set when the memory is allocated, P1.5)
pub static mut MEM8: *mut u8 = std::ptr::null_mut();

#[no_mangle]
pub fn rust_init() {
    jitrt::init(Env {
        table_size: WASM_TABLE_SIZE,
        table_offset: WASM_TABLE_OFFSET,
        state_base: crate::state_block::state_base(),
        mem8: || unsafe { MEM8 },
        now: || unsafe { crate::isa::microtick() },
        core: crate::isa::current_core,
        clear_slot: |slot| unsafe { js::jit_clear_func(slot as u16) },
        page_has_code: |_, _| {},
        pages_gain_code: |_| {},
        claim: |page, on| unsafe {
            if on {
                crate::parallel::code::claim(page)
            }
            else {
                crate::parallel::code::release(page)
            }
        },
        release_all: || unsafe { crate::parallel::code::release_all() },
    });
    std::panic::set_hook(Box::new(|panic_info| {
        console_log!("{}", panic_info.to_string());
    }));
}
