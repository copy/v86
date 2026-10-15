//! Shared state for compiled code: whether it runs (jit_set_enabled), the
//! bounded Wasm table that the x64 page tier's functions are installed into,
//! and the physical code pages they were compiled from. Writes to such a page
//! (self-modifying code, DMA, host writes) retire the functions that depend
//! on it. (The IR region tiers shared it until docs/jit-unification-plan.md
//! M11 deleted them.)
use std::collections::{HashMap, HashSet};
use std::iter::FromIterator;
use std::mem::MaybeUninit;
use std::ops::{Deref, DerefMut};
use std::sync::{Mutex, MutexGuard};

use crate::cpu::cpu;
use crate::page::Page;
use crate::profiler;
use crate::profiler::stat;

#[derive(Copy, Clone, Eq, Hash, PartialEq)]
#[repr(transparent)]
pub struct WasmTableIndex(u16);
impl WasmTableIndex {
    pub fn to_u16(self) -> u16 { self.0 }
}

mod unsafe_jit {
    use super::WasmTableIndex;

    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn jit_clear_func(wasm_table_index: WasmTableIndex);
    }
}

pub fn jit_clear_func(wasm_table_index: WasmTableIndex) {
    unsafe { unsafe_jit::jit_clear_func(wasm_table_index) }
}

// needs to be synced to const.js
pub const WASM_TABLE_SIZE: u32 = 12000;

/// Whether compiled code runs (CPU.configure_jit_backend: not disable_jit;
/// the region tiers' scheduler held it until M11)
static mut ENABLED: bool = false;
#[no_mangle]
pub unsafe fn jit_set_enabled(enabled: u32) -> bool {
    if enabled > 1 {
        return false;
    }
    ENABLED = enabled == 1;
    true
}
#[inline(always)]
pub fn enabled() -> bool { unsafe { ENABLED } }
/// Whether the JIT compiles (get_jit_info's ir.enabled)
#[no_mangle]
pub fn jit_is_enabled() -> bool { enabled() }
/// 32-bit and 16-bit code in the x64 page tier (the JIT switch ir_tier0,
/// set by CPU.configure_jit_backend unless its setting ir_tier0 is false;
/// the region tiers' scheduler set it until M11)
#[no_mangle]
pub unsafe fn jit_set_page32(enabled: u32) -> bool {
    if enabled > 1 {
        return false;
    }
    crate::x64::pages::set_page32_tier0(enabled == 1);
    if enabled == 1 {
        reserve_compiler_heap();
    }
    true
}
/// Grow the Wasm heap once for the compiler's working set: every later
/// memory.grow of the (multi-GiB) guest memory makes the host re-account it as
/// external memory and collect, so many small grows cost far more than one.
/// (The region tiers' scheduler did this for the page tier's 32-bit code
/// until M11; CPU.configure_jit_backend sets ir_tier0 before the guest's RAM
/// is allocated, which takes the freed chunks' place: cpu::memory.)
fn reserve_compiler_heap() {
    static mut RESERVED: bool = false;
    unsafe {
        if RESERVED {
            return;
        }
        RESERVED = true;
    }
    // Freed chunks stay in the allocator's free lists.
    let chunks: Vec<Vec<u8>> = (0..16).map(|_| Vec::with_capacity(2 << 20)).collect();
    drop(chunks);
}

/// Whether this build has Wasm SIMD: the portable one (build/v86-fallback.wasm)
/// has none, and the page tier declines the forms whose templates need it
/// (ir_wasm_simd_supported until M11 of docs/jit-unification-plan.md).
#[no_mangle]
pub extern "C" fn jit_wasm_simd_supported() -> u32 { u32::from(cfg!(target_feature = "simd128")) }

static JIT_STATE: Mutex<MaybeUninit<JitState>> = Mutex::new(MaybeUninit::uninit());
fn get_jit_state() -> JitStateRef { JitStateRef(JIT_STATE.try_lock().unwrap()) }

struct JitStateRef(MutexGuard<'static, MaybeUninit<JitState>>);

impl Deref for JitStateRef {
    type Target = JitState;
    fn deref(&self) -> &Self::Target { unsafe { self.0.assume_init_ref() } }
}
impl DerefMut for JitStateRef {
    fn deref_mut(&mut self) -> &mut Self::Target { unsafe { self.0.assume_init_mut() } }
}

#[no_mangle]
pub fn rust_init() {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        *crate::cpu::global_pointers::ir_tlb_base = std::ptr::addr_of!(cpu::tlb_data) as u32;
    }
    let _ = JIT_STATE
        .try_lock()
        .unwrap()
        .write(JitState::create_and_initialise());

    use std::panic;

    panic::set_hook(Box::new(|panic_info| {
        console_log!("{}", panic_info.to_string());
    }));
}

struct JitState {
    wasm_table_index_free_list: Vec<WasmTableIndex>,
    /// Reserved table slots: owner id and the physical pages the module was
    /// compiled from.
    ir_slots: HashMap<WasmTableIndex, (u64, HashSet<Page>)>,
    /// Number of slots watching each physical page (TLB fills query this on
    /// every page walk; iterating all slots' sets was measurable).
    ir_page_counts: Vec<u16>,
}

impl JitState {
    pub fn create_and_initialise() -> JitState {
        // don't assign 0 (XXX: Check)
        let wasm_table_indices = (1..=(WASM_TABLE_SIZE - 1) as u16).map(|x| WasmTableIndex(x));

        JitState {
            wasm_table_index_free_list: Vec::from_iter(wasm_table_indices),
            ir_slots: HashMap::new(),
            ir_page_counts: Vec::new(),
        }
    }
}

fn check_jit_state_invariants(ctx: &JitState) {
    if !cfg!(debug_assertions) {
        return;
    }
    let free: HashSet<WasmTableIndex> =
        HashSet::from_iter(ctx.wasm_table_index_free_list.iter().copied());
    dbg_assert!(ctx.ir_slots.keys().all(|index| !free.contains(index)));
    dbg_assert!(free.len() + ctx.ir_slots.len() == (WASM_TABLE_SIZE - 1) as usize);
}

/// Register a write in this page: retire all IR code compiled from it, here
/// and (crate::parallel::code) in other cores' workers.
fn jit_dirty_page_ctx(ctx: &mut JitState, page: Page) {
    unsafe { crate::parallel::code::written(page.to_u32()) };
    retire_page_ctx(ctx, page);
}

/// Another core wrote the page (crate::parallel::code::poll): retire this
/// instance's code from it
pub fn jit_retire_page(page: Page) { retire_page_ctx(&mut get_jit_state(), page) }

fn retire_page_ctx(ctx: &mut JitState, page: Page) { retire_bytes_ctx(ctx, page, None) }

/// retire_page_ctx for a write of `bytes` (offsets lo..hi) of the page: the
/// x64 page tier keeps code the write misses (x64::pages::dirty_bytes)
fn retire_bytes_ctx(ctx: &mut JitState, page: Page, bytes: Option<(u32, u32)>) {
    if !ir_page_watched(ctx, page) {
        profiler::stat_increment(stat::DIRTY_PAGE_DID_NOT_HAVE_CODE);
        return;
    }
    let kept = match bytes {
        Some((lo, hi)) => crate::x64::pages::dirty_bytes(page.to_u32(), lo, hi),
        None => {
            crate::x64::pages::dirty_page(page.to_u32());
            Vec::new()
        },
    };
    let mut unwatched = HashSet::new();
    let JitState {
        ir_slots,
        ir_page_counts,
        ..
    } = ctx;
    for (index, (_, pages)) in ir_slots.iter_mut() {
        if pages.contains(&page) && !kept.contains(&(index.to_u16() as u32)) {
            for p in pages.drain() {
                ir_page_count(ir_page_counts, p, -1);
                unwatched.insert(p);
            }
        }
    }
    for page in unwatched {
        cpu::tlb_set_has_code(page, ir_page_watched(ctx, page));
    }
}

#[no_mangle]
pub fn jit_dirty_cache(start_addr: u32, end_addr: u32) {
    dbg_assert!(start_addr < end_addr);

    let start_page = Page::page_of(start_addr);
    let end_page = Page::page_of(end_addr - 1);

    for page in start_page.to_u32()..end_page.to_u32() + 1 {
        jit_dirty_page_ctx(&mut get_jit_state(), Page::page_of(page << 12));
    }
}

#[no_mangle]
pub fn jit_dirty_page(page: Page) { jit_dirty_page_ctx(&mut get_jit_state(), page) }

/// A write of `len` bytes at physical `addr`, within one page: as
/// jit_dirty_page, where code the write misses may stay (retire_bytes_ctx)
pub fn jit_dirty_bytes(addr: u32, len: u32) {
    let page = Page::page_of(addr);
    dbg_assert!(Page::page_of(addr + len - 1) == page);
    unsafe { crate::parallel::code::written(page.to_u32()) };
    let lo = addr & 0xFFF;
    retire_bytes_ctx(&mut get_jit_state(), page, Some((lo, lo + len)));
}

/// jit_dirty_bytes for the bytes start..end, which span at most two pages
/// (the RAM writers of crate::cpu::memory, through which compatibility-mode
/// code's writes go: M9)
pub fn jit_dirty_bytes_small(start: u32, end: u32) {
    dbg_assert!(start < end);
    let split = (start & !0xFFF).wrapping_add(0x1000);
    if end <= split || split == 0 {
        jit_dirty_bytes(start, end - start);
    }
    else {
        jit_dirty_bytes(start, split - start);
        jit_dirty_bytes(split, end - split);
    }
}

/// dirty pages in the range of start_addr and end_addr, which must span at most two pages
pub fn jit_dirty_cache_small(start_addr: u32, end_addr: u32) {
    dbg_assert!(start_addr < end_addr);

    let start_page = Page::page_of(start_addr);
    let end_page = Page::page_of(end_addr - 1);

    let mut ctx = get_jit_state();
    jit_dirty_page_ctx(&mut ctx, start_page);

    // Note: This can't happen when paging is enabled, as writes across
    //       boundaries are split up on two pages
    if start_page != end_page {
        dbg_assert!(start_page.to_u32() + 1 == end_page.to_u32());
        jit_dirty_page_ctx(&mut ctx, end_page);
    }
}

#[no_mangle]
pub fn jit_clear_cache_js() { jit_clear_cache(&mut get_jit_state()) }

fn jit_clear_cache(ctx: &mut JitState) {
    crate::x64::pages::reset();
    let mut pages_with_code = HashSet::new();
    for (_, pages) in ctx.ir_slots.values_mut() {
        pages_with_code.extend(pages.drain());
    }
    ctx.ir_page_counts.clear();
    unsafe { (*(&raw mut WATCHED)).clear() };
    unsafe { crate::parallel::code::release_all() };
    for page in pages_with_code {
        cpu::tlb_set_has_code(page, false);
    }
}

/// Whether IR code (a published artifact's source) lies on the page.
pub fn jit_page_has_code(page: Page) -> bool { ir_page_watched(&get_jit_state(), page) }

/// Whether stores to the page must take the slow path: this instance or,
/// with cores in workers, another core compiled code from it. Used for new
/// translations (TLB fills, write translation caches).
pub fn page_needs_notification(page: Page) -> bool {
    jit_page_has_code(page) || unsafe { crate::parallel::code::others_own(page.to_u32()) }
}

fn ir_page_watched(ctx: &JitState, page: Page) -> bool {
    ctx.ir_page_counts
        .get(page.to_u32() as usize)
        .is_some_and(|count| *count != 0)
}
fn ir_page_count(counts: &mut Vec<u16>, page: Page, delta: i32) {
    let index = page.to_u32() as usize;
    if counts.len() <= index {
        counts.resize(index + 1, 0);
    }
    let before = counts[index] != 0;
    counts[index] = (counts[index] as i32 + delta).max(0) as u16;
    let after = counts[index] != 0;
    set_watched(index, after);
    if before != after {
        unsafe {
            if after {
                crate::parallel::code::claim(index as u32)
            }
            else {
                crate::parallel::code::release(index as u32)
            }
        }
    }
}

/// Lock-free mirror of `ir_page_counts != 0`, one bit per page, for writers
/// that must only notify pages holding compiled code (x64::physical).
static mut WATCHED: Vec<u64> = Vec::new();
fn set_watched(page: usize, watched: bool) {
    unsafe {
        let bits = &mut *(&raw mut WATCHED);
        if bits.len() <= page / 64 {
            if !watched {
                return;
            }
            bits.resize(page / 64 + 1, 0);
        }
        if watched {
            bits[page / 64] |= 1 << (page % 64)
        }
        else {
            bits[page / 64] &= !(1 << (page % 64))
        }
    }
}
/// Whether IR or x64 page-tier code was compiled from this backing page, by
/// this instance or (with cores in workers) another: writes must notify.
#[inline(always)]
pub fn page_watched(page: u32) -> bool {
    unsafe {
        (&*(&raw const WATCHED))
            .get(page as usize / 64)
            .is_some_and(|w| w >> (page % 64) & 1 != 0)
            || crate::parallel::code::others_own(page)
    }
}

/// Whether every page this code depends on is published to the other cores
/// (crate::parallel::code), so that it may be installed, waiting up to `ms`
/// for their acknowledgements
pub fn wait_pages_published(pages: impl Iterator<Item = Page> + Clone, ms: f64) -> bool {
    unsafe { crate::parallel::code::wait_published(pages.map(|page| page.to_u32()), ms) }
}

/// The fewest free table slots since the last jit_wasm_table_free_low_reset
/// (docs/jit-unification-plan.md P0.10): IR and the x64 page tier both take
/// theirs from this table
static mut TABLE_FREE_LOW: u32 = WASM_TABLE_SIZE - 1;
#[no_mangle]
pub fn jit_wasm_table_free_low() -> u32 { unsafe { TABLE_FREE_LOW } }
#[no_mangle]
pub fn jit_wasm_table_free_low_reset() {
    unsafe { TABLE_FREE_LOW = get_jit_state().wasm_table_index_free_list.len() as u32 }
}

pub fn ir_reserve_slot(id: u64, pages: HashSet<Page>) -> Option<u32> {
    let mut ctx = get_jit_state();
    let index = ctx.wasm_table_index_free_list.pop()?;
    unsafe {
        TABLE_FREE_LOW = TABLE_FREE_LOW.min(ctx.wasm_table_index_free_list.len() as u32);
    }
    for &page in &pages {
        ir_page_count(&mut ctx.ir_page_counts, page, 1);
    }
    ctx.ir_slots.insert(index, (id, pages.clone()));
    cpu::tlb_set_has_code_multiple(&pages, true);
    // x64 page functions store through cached write translations of pages
    // without code; these pages may be among them.
    for page in &pages {
        unsafe { crate::x64::jac::retire_writes_to(page.to_address()) };
    }
    check_jit_state_invariants(&ctx);
    Some(index.to_u16() as u32)
}

/// Called only at a cold/quiescent point. The owner protects a reused slot from old callbacks.
pub fn ir_release_slot(index: u32, id: u64) -> bool {
    if index == 0 || index >= WASM_TABLE_SIZE {
        return false;
    }
    let mut ctx = get_jit_state();
    let index = WasmTableIndex(index as u16);
    if !ctx
        .ir_slots
        .get(&index)
        .is_some_and(|(owner, _)| *owner == id)
    {
        return false;
    }
    let (_, pages) = ctx.ir_slots.remove(&index).unwrap();
    for &page in &pages {
        ir_page_count(&mut ctx.ir_page_counts, page, -1);
    }
    for page in pages {
        cpu::tlb_set_has_code(page, ir_page_watched(&ctx, page));
    }
    ctx.wasm_table_index_free_list.push(index);
    // It is not strictly necessary to clear the function, but it will fail more predictably if we
    // accidentally use the function and may garbage collect unused modules earlier
    jit_clear_func(index);
    check_jit_state_invariants(&ctx);
    true
}

#[no_mangle]
pub fn jit_get_wasm_table_index_free_list_count() -> u32 {
    get_jit_state().wasm_table_index_free_list.len() as u32
}
