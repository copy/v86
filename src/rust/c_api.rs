use std::mem;
use std::ptr::NonNull;

use jit::{cached_code, JitState};
use page::Page;
use state_flags::CachedStateFlags;

static mut MODULE_PTR: NonNull<JitState> =
    unsafe { NonNull::new_unchecked(mem::align_of::<JitState>() as *mut _) };

pub fn get_module<'a>() -> &'a mut JitState { unsafe { MODULE_PTR.as_mut() } }

#[no_mangle]
/// Called from JS, not C
pub fn rust_setup() {
    let x = Box::new(JitState::create_and_initialise());
    unsafe {
        MODULE_PTR = NonNull::new(Box::into_raw(x)).expect("assigning module ptr");
    }

    use std::panic;

    panic::set_hook(Box::new(|panic_info| {
        console_log!("{}", panic_info.to_string());
    }));
}

pub fn jit_find_cache_entry(phys_address: u32, state_flags: CachedStateFlags) -> u32 {
    let cached_code {
        wasm_table_index,
        initial_state,
    } = ::jit::jit_find_cache_entry(phys_address, state_flags);
    wasm_table_index as u32 | (initial_state as u32) << 16
}

#[no_mangle]
/// Called from JS, not C
pub fn codegen_finalize_finished(
    wasm_table_index: u16,
    phys_addr: u32,
    end_addr: u32,
    first_opcode: u32,
    state_flags: u32,
) {
    ::jit::codegen_finalize_finished(
        get_module(),
        wasm_table_index,
        phys_addr,
        end_addr,
        first_opcode,
        CachedStateFlags::of_u32(state_flags),
    )
}

pub fn jit_increase_hotness_and_maybe_compile(
    phys_address: u32,
    cs_offset: u32,
    state_flags: CachedStateFlags,
    hotness: u32,
) {
    ::jit::jit_increase_hotness_and_maybe_compile(
        get_module(),
        phys_address,
        cs_offset,
        state_flags,
        hotness,
    )
}

#[no_mangle]
#[cfg(debug_assertions)]
/// Called from JS
pub fn jit_force_generate_unsafe(phys_addr: u32, cs_offset: u32, state_flags: u32) {
    ::jit::jit_force_generate_unsafe(
        get_module(),
        phys_addr,
        cs_offset,
        CachedStateFlags::of_u32(state_flags),
    )
}

#[no_mangle]
/// Called from JS
pub fn jit_dirty_cache(start_addr: u32, end_addr: u32) {
    ::jit::jit_dirty_cache(get_module(), start_addr, end_addr);
}

pub fn jit_dirty_cache_small(start_addr: u32, end_addr: u32) {
    ::jit::jit_dirty_cache_small(get_module(), start_addr, end_addr);
}

pub fn jit_dirty_page(page: Page) { ::jit::jit_dirty_page(get_module(), page); }

pub fn jit_page_has_code(page: u32) -> bool {
    ::jit::jit_page_has_code(get_module(), Page::page_of(page << 12))
}

#[no_mangle]
/// Called from JS, not C
pub fn jit_empty_cache() { ::jit::jit_empty_cache(get_module()) }

#[no_mangle]
/// Called from JS, not C
pub fn jit_get_op_ptr() -> *const u8 { ::jit::jit_get_op_ptr(get_module()) }

#[no_mangle]
/// Called from JS, not C
pub fn jit_get_op_len() -> u32 { ::jit::jit_get_op_len(get_module()) }

#[no_mangle]
#[cfg(debug_assertions)]
pub fn jit_unused_cache_stat() -> u32 { ::jit::jit_unused_cache_stat() }
#[no_mangle]
#[cfg(debug_assertions)]
pub fn jit_get_entry_length(i: u32) -> u32 { ::jit::jit_get_entry_length(i) }
#[no_mangle]
#[cfg(debug_assertions)]
pub fn jit_get_entry_address(i: u32) -> u32 { ::jit::jit_get_entry_address(i) }
#[no_mangle]
#[cfg(debug_assertions)]
pub fn jit_get_entry_pending(i: u32) -> bool { ::jit::jit_get_entry_pending(i) }
#[no_mangle]
#[cfg(debug_assertions)]
pub fn jit_get_wasm_table_index_free_list_count() -> u32 {
    ::jit::jit_get_wasm_table_index_free_list_count(get_module())
}

#[no_mangle]
#[cfg(not(debug_assertions))]
pub fn jit_unused_cache_stat() -> u32 { 0 }
#[no_mangle]
#[cfg(not(debug_assertions))]
pub fn jit_get_entry_length(_: u32) -> u32 { 0 }
#[no_mangle]
#[cfg(not(debug_assertions))]
pub fn jit_get_entry_address(_: u32) -> u32 { 0 }
#[no_mangle]
#[cfg(not(debug_assertions))]
pub fn jit_get_entry_pending(_: u32) -> bool { false }
#[no_mangle]
#[cfg(not(debug_assertions))]
pub fn jit_get_wasm_table_index_free_list_count() -> u32 { 0 }
