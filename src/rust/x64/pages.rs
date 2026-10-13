//! Runtime of the x64 page tier (x64::pagegen): which long-mode pages to
//! compile, publication into the shared Wasm table, entry, the helpers that
//! generated code calls, and invalidation.
//!
//! A function is keyed by the RAM backing page of its code alone, and is
//! position independent: every linear page that maps to that backing page
//! runs it. Entry translates RIP for execution first, so a function only runs
//! while its page maps to the bytes it was compiled from; writes to the
//! backing page (CPU, DMA, host) retire it through jit::jit_dirty_page.
//! Code in extended RAM has keys from extended::CODE_KEY_BASE on (the
//! extended page, whichever frame holds it); extended.rs watches its writes.
//! With x64_page_compat32 (docs/jit-unification-plan.md P7.2), 32-bit code
//! in compatibility mode runs here too: its functions have the key of their
//! page with COMPAT_KEY, so a page run in both modes has a function for each.
//! With x64_page_legacy32 (P7.3), so does 32-bit code in legacy protected
//! mode: compiled as compatibility mode's, translated through the 32-bit
//! paging and TLB (cpu::translate_address), with LEGACY_KEY besides.
use super::{extended, jac, memory, pagegen, paging, physical, state};
use crate::cpu::{apic, cpu, execution, global_pointers as gp};
use crate::page::Page;
use crate::step_profile::{self, event};
use std::collections::{HashMap, HashSet};

mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn x64_page_publish(id: u64, slot: u32, pointer: u32, length: u32);
    }
}
extern "C" {
    fn call_indirect1_ret(f: i32, x: u16) -> i32;
}

/// Interpreted instructions on a page before it is compiled.
const HOT: u32 = 2000;
/// Unserved entries reached through a published function before recompiling
/// (x64_page_set_recompile_misses).
static mut RECOMPILE_MISSES: u32 = 64;
#[no_mangle]
pub unsafe fn x64_page_set_recompile_misses(misses: u32) { RECOMPILE_MISSES = misses.max(1); }
/// HOT and RECOMPILE_MISSES of legacy-mode code (x64_legacy_heat and
/// x64_legacy_recompile_misses; P7.2b, P7.3). An XP boot runs one 32-bit
/// OS's code, much of it lukewarm and entered from ever new places, where a
/// compile (each starts V8's tier-up anew) costs more than interpreting:
/// Tier-0 compiles a page at 50000 instructions and never for new entries.
/// (XP to the desktop, i440FX, one core: at 2000 and 64, 1435 compiles of
/// 568 pages, 98 MB of Wasm, 18.2 s; at these, 365 of 247, 27 MB, 13.4 s.)
static mut LEGACY_HEAT: u32 = 50_000;
static mut LEGACY_MISSES: u32 = 4096;
pub unsafe fn set_legacy_heat(heat: u32) { LEGACY_HEAT = heat; }
pub unsafe fn set_legacy_recompile_misses(misses: u32) { LEGACY_MISSES = misses; }
/// Compiles of a page before each further one waits twice as long (heat
/// and unserved entries): a page recompiled for ever new entries, or
/// rewritten over and over, costs ever less; its code stays in use.
const FREE_RECOMPILES: u32 = 4;
fn backoff(compiles: u32) -> u32 { compiles.saturating_sub(FREE_RECOMPILES).min(16) }
/// (`page`: the function's key, which tells legacy-mode code)
fn recompile_due(page: u32, state: &PageState) -> bool {
    let misses = unsafe {
        if page & LEGACY_KEY != 0 {
            LEGACY_MISSES
        }
        else {
            RECOMPILE_MISSES
        }
    };
    state.misses >= misses << backoff(state.compiles)
}
pub const MAX_FUNCTIONS: usize = 9000;
/// The functions of one code mode (long, 32-bit compatibility) beyond which
/// a full table evicts that mode's (P7.2b)
const MODE_SHARE: usize = MAX_FUNCTIONS * 2 / 3;
const MAX_TRACKED_PAGES: usize = 65536;
const FAST_SLOTS: usize = 16384;

#[derive(PartialEq, Eq, Clone, Copy)]
enum Phase {
    Pending,
    Ready,
    Dead,
}
struct Function {
    /// backing page number (a function serves every mapping of the page),
    /// or an extended page's key (see code_key)
    page: u32,
    id: u64,
    slot: u32,
    phase: Phase,
    served: [u64; 64],
    last_used: u64,
    /// the source page's bytes (hash) when compiled: with cores in workers,
    /// checked again after the page is published (crate::parallel::code)
    source: u64,
    /// compiled with outlined access lookups and an execution counter, the
    /// HOT_COUNTS cell (a cold compile with x64_hot_inline, P4.14)
    counter: Option<u32>,
    /// The tier's native instructions when it was compiled (stats[RETIRED]):
    /// how long it ran when its page is written (dirty_page)
    native_at: u64,
}
fn bit(set: &[u64; 64], offset: u16) -> bool { set[offset as usize / 64] >> (offset % 64) & 1 != 0 }
/// The function a full table retires for a compile of (`compat`) code: the
/// least recently used ready one, of that code's mode when the mode holds
/// more than MODE_SHARE (P7.2b)
fn eviction_victim(functions: &[Function], compat: bool) -> Option<usize> {
    let mode = |f: &Function| f.page & COMPAT_KEY != 0;
    let held = functions
        .iter()
        .filter(|f| f.phase != Phase::Dead && mode(f) == compat)
        .count();
    let crowded = held > MODE_SHARE;
    functions
        .iter()
        .enumerate()
        .filter(|(_, f)| f.phase == Phase::Ready && (!crowded || mode(f) == compat))
        .min_by_key(|(_, f)| f.last_used)
        .map(|(i, _)| i)
}
struct PageState {
    heat: u32,
    entries: [u64; 64],
    /// unserved entries seen once (see note_unserved)
    seen: [u64; 64],
    entry_count: u32,
    misses: u32,
    compiles: u32,
    /// its code ran often: compiled with inline access lookups from then on
    /// (x64_hot_inline, P4.14; not a compile of its own, no backoff)
    hot: bool,
}
impl Default for PageState {
    fn default() -> Self {
        Self {
            heat: 0,
            entries: [0; 64],
            seen: [0; 64],
            entry_count: 0,
            misses: 0,
            compiles: 0,
            hot: false,
        }
    }
}
/// Multiplicative hashing for page numbers.
#[derive(Default)]
struct PageHasher(u64);
impl std::hash::Hasher for PageHasher {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(8) ^ b as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        }
    }
    fn write_u32(&mut self, value: u32) {
        self.0 = (value as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}
type PageMap<V> = HashMap<u32, V, std::hash::BuildHasherDefault<PageHasher>>;
struct Runtime {
    functions: Vec<Function>,
    by_page: PageMap<usize>,
    pages: PageMap<PageState>,
    /// slots of dead functions, released at the next cold point
    releases: Vec<(u32, u64)>,
    /// their HOT_COUNTS cells, free again at the same point
    released_counters: Vec<u32>,
    next_id: u64,
    clock: u64,
    last_rip: u64,
    enabled: bool,
    stats: [u64; 13],
    /// Changes whenever a function is registered or retired (HeatBatch)
    generation: u32,
}
static mut RUNTIME: Option<Runtime> = None;
/// Hot path lookup: backing page number and function index + 1, validated
/// against the function on every use.
static mut FAST: [(u32, u32); FAST_SLOTS] = [(0, 0); FAST_SLOTS];
// Statistics (x64_page_stat): compiled, native retired, retries, unknown
// exits, steps, invalidated, entries, compile failures, recompiles,
// instructions compiled, templated, evictions.
const COMPILED: usize = 0;
const RETIRED: usize = 1;
const RETRIES: usize = 2;
const UNKNOWN: usize = 3;
const INVALIDATED: usize = 5;
const ENTRIES: usize = 6;
const FAILED: usize = 7;
const RECOMPILED: usize = 8;
const INSTRUCTIONS: usize = 9;
const TEMPLATED: usize = 10;
const EVICTED: usize = 11;
/// recompiles of hot pages with inline lookups (x64_page_stat 33, P4.14)
const HOT_RECOMPILES: usize = 12;

/// Event counters for profiling (x64_page_stat 13..19, 25): activations of
/// page functions, INVLPG, control register writes, access cache misses
/// (x64_page_access calls), access cache fills of the VGA frame buffer, MOV
/// CR3 keeping global translations, INVLPG flushing a large-page region,
/// unaligned reads served from BOUNCE.
pub static mut COUNTERS: [u64; 19] = [0; 19];
pub const COUNT_ACTIVATIONS: usize = 0;
pub const COUNT_INVLPG: usize = 1;
pub const COUNT_CR_WRITES: usize = 2;
pub const COUNT_ACCESS_MISSES: usize = 3;
pub const COUNT_LFB_FILLS: usize = 4;
pub const COUNT_CR3_KEEP_GLOBAL: usize = 5;
pub const COUNT_JAC_LARGE_FLUSH: usize = 6;
/// (cores in workers) unaligned reads served from BOUNCE
pub const COUNT_UNALIGNED_READS: usize = 7;
/// control register writes by register (x64_page_stat 26..28), and those
/// that flushed every translation (29)
pub const COUNT_CR0_WRITES: usize = 8;
pub const COUNT_CR3_WRITES: usize = 9;
pub const COUNT_CR4_WRITES: usize = 10;
pub const COUNT_FULL_FLUSHES: usize = 11;
/// translations that walked the page tables (x64_page_stat 30); 32-bit TLB
/// entries filled from x64 translations in compatibility mode (31), of which
/// for pages it had already (32)
pub const COUNT_WALKS: usize = 12;
pub const COUNT_COMPAT_FILLS: usize = 13;
pub const COUNT_COMPAT_REFILLS: usize = 14;
/// Access cache fills, and those that replaced another page's live entry
/// (a conflict in the direct-mapped table; P4.15)
pub const COUNT_JAC_FILLS: usize = 15;
pub const COUNT_JAC_CONFLICTS: usize = 16;
/// compiles of compatibility-mode pages (x64_page_stat 36, P7.2)
pub const COUNT_COMPAT_COMPILES: usize = 17;
/// legacy-mode compiles (P7.3)
pub const COUNT_LEGACY_COMPILES: usize = 18;
/// (32 bytes: a VEX.256 load's)
#[repr(C, align(16))]
struct Bounce([u8; 32]);
static mut BOUNCE: Bounce = Bounce([0; 32]);
/// (generated code copies unaligned reads there itself: pagegen)
pub unsafe fn bounce_address() -> u32 { &raw mut BOUNCE as u32 }
/// x64_page_timing: milliseconds inside page function calls and in execute
/// as a whole (x64_page_stat 20 and 22; 23: first calls, 24: bytes compiled)
static mut TIMING: bool = false;
#[no_mangle]
pub unsafe fn x64_page_timing(enabled: bool) { TIMING = enabled; }
mod time {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn microtick() -> f64;
    }
}
static mut TIME_IN_CALLS: f64 = 0.0;
static mut TIME_IN_EXECUTE: f64 = 0.0;
/// first calls with budget 0 (the engine compiles the function lazily)
static mut TIME_FIRST_CALLS: f64 = 0.0;
static mut BYTES_COMPILED: u64 = 0;
/// A generated function is running.
static mut ACTIVE: bool = false;
/// It was compiled for segment bases (P7.2(3)), as all it chains to
static mut SEGMENTED_ACTIVE: bool = false;
/// Code-page invalidations; a step that changes it ends the activation.
static mut CODE_WRITES: u64 = 0;
static mut STEPS: u64 = 0;

/// The runtime state. Single-threaded, and no caller holds the reference
/// across a call that can re-enter this module (compilation, publication,
/// generated code, the interpreter or jit::).
fn rt() -> &'static mut Runtime {
    unsafe {
        (*(&raw mut RUNTIME)).get_or_insert_with(|| Runtime {
            functions: Vec::new(),
            by_page: PageMap::default(),
            pages: PageMap::default(),
            releases: Vec::new(),
            released_counters: Vec::new(),
            next_id: 1,
            clock: 0,
            last_rip: 0,
            enabled: true,
            stats: [0; 13],
            generation: 0,
        })
    }
}
fn fast_slot(page: u32) -> usize { (page as usize ^ (page as usize >> 12)) & (FAST_SLOTS - 1) }

pub struct Attempt {
    pub retired: u32,
    pub submitted: bool,
}
fn miss() -> Attempt {
    Attempt {
        retired: 0,
        submitted: false,
    }
}

/// Native execution is exact only without instruction-level observers.
/// Deliverable interrupts were taken by handle_irqs before this point; any
/// that become pending meanwhile wait at most one activation budget (steps
/// that make one deliverable end the activation).
pub unsafe fn allowed() -> bool {
    if *gp::in_hlt
        || *gp::interrupt_shadow != 0
        || *gp::flags as u64 & (0x100 | 0x10000) != 0
        || state::read_dr(7) & 255 != 0
        || execution::is_deterministic()
        || !(state::mode().is_long() || runnable32())
    {
        return false;
    }
    crate::ir::runtime::schedule::enabled()
        && !apic::has_core_events()
        && !apic::nmi_pending()
        && !crate::cpu::smm::smi_deliverable()
}

/// Why run() ran no function although there may be one (a MISS event of
/// the step profile): what allowed() refused, in its order
unsafe fn disallowed(budget: u32) -> u32 {
    if budget == 0 {
        event::MISS_DISABLED
    }
    else if *gp::in_hlt {
        event::MISS_HALT
    }
    else if *gp::interrupt_shadow != 0 {
        event::MISS_SHADOW
    }
    else if *gp::flags as u64 & (0x100 | 0x10000) != 0 {
        event::MISS_TRAP_FLAGS
    }
    else if state::read_dr(7) & 255 != 0 {
        event::MISS_BREAKPOINTS
    }
    else if apic::has_core_events() || apic::nmi_pending() || crate::cpu::smm::smi_deliverable() {
        event::MISS_EVENTS
    }
    else {
        event::MISS_DISABLED
    }
}

/// Per core: the last code page translation (access cache epoch | user |
/// code mode << 1, linear page, key). An x64 TLB invalidation changes the
/// epoch, as do legacy-mode flushes (P7.1; INVLPG forgets it).
static mut CODE_TLB: [(u64, u64, u32, bool); 8] = [(0, 0, 0, false); 8];

/// Chaining (pagegen::Emitter::chain): a page function leaving its page
/// looks the new linear page up here and tail-calls the function serving it,
/// without returning to the dispatch loop. Per core, code mode (P7.2, P7.3)
/// and CPL, direct mapped by linear page:
/// tag = page | access cache epoch (so every x64 TLB flush
/// retires the entries; INVLPG retires its page's), and the Wasm table index
/// of a published function whose backing page the linear page executed from
/// when the entry was filled. Retiring a function clears its entries.
pub const CHAIN_ENTRIES: usize = 1024;
#[derive(Clone, Copy)]
#[repr(C)]
struct ChainEntry {
    tag: u64,
    table_index: u32,
    /// the code page's translation is global (kept by MOV CR3)
    global: u32,
}
#[repr(C, align(16))]
struct ChainTables([[ChainEntry; CHAIN_ENTRIES]; 8]);
const NO_CHAIN: ChainEntry = ChainEntry {
    tag: 0,
    table_index: 0,
    global: 0,
};
static mut CHAIN: [ChainTables; 8] = [const { ChainTables([[NO_CHAIN; CHAIN_ENTRIES]; 8]) }; 8];
/// Whether generated code may tail-call through the host's function table
/// (x64_page_set_chaining: the engine supports Wasm tail calls).
static mut CHAINING: bool = false;
#[no_mangle]
pub unsafe fn x64_page_set_chaining(enabled: bool) {
    CHAINING = enabled;
    // functions compiled either way stay valid: a function without chaining
    // code only returns
    clear_chains();
}
/// Page functions compiled from now on chain (see CHAINING). With cores in
/// workers each instance chains through its own table and chaining table,
/// and leaves for crate::parallel::code::poll when other cores published or
/// invalidated code (pagegen::Emitter::chain).
pub unsafe fn chaining() -> bool { CHAINING }
unsafe fn chain_base(core: usize, user: bool, mode: usize) -> u32 {
    std::ptr::addr_of!(CHAIN[core].0[mode * 2 + user as usize]) as u32
}
unsafe fn chain_fill(core: usize, user: bool, mode: usize, rip: u64, slot: u32, global: bool) {
    let page = rip >> 12;
    let table = &mut CHAIN[core].0[mode * 2 + user as usize];
    table[page as usize & (CHAIN_ENTRIES - 1)] = ChainEntry {
        tag: page | jac::epoch_bits(core),
        table_index: slot + cpu::WASM_TABLE_OFFSET,
        global: global as u32,
    };
}
/// MOV CR3 (see memory::invalidate_core_nonglobal): code translations of
/// non-global pages go.
pub unsafe fn forget_nonglobal_code(core: usize) {
    CODE_TLB[core] = (0, 0, 0, false);
    for table in CHAIN[core].0.iter_mut() {
        for entry in table.iter_mut() {
            if entry.global == 0 {
                entry.tag = 0;
            }
        }
    }
}
fn clear_chains() {
    unsafe {
        for core in (*(&raw mut CHAIN)).iter_mut() {
            for table in core.0.iter_mut() {
                for entry in table.iter_mut() {
                    entry.tag = 0;
                }
            }
        }
    }
}
/// A function is retired: no chaining to its slot any more.
unsafe fn unchain_slot(slot: u32) {
    let index = slot + cpu::WASM_TABLE_OFFSET;
    for core in 0..apic::core_count().clamp(1, 8) {
        for table in CHAIN[core].0.iter_mut() {
            for entry in table.iter_mut() {
                if entry.table_index == index {
                    entry.tag = 0;
                }
            }
        }
    }
}
/// The key of the code page at `rip` for code of `mode` (see code_key and
/// MODE_KEYS), and whether its translation is global.
unsafe fn code_page(rip: u64, mode: usize) -> Option<(u32, bool)> {
    let core = apic::current_core();
    let tag = jac::epoch_bits(core) | (*gp::cpl == 3) as u64 | (mode as u64) << 1;
    let (cached_tag, linear, page, global) = CODE_TLB[core];
    if cached_tag == tag && linear == rip >> 12 {
        return Some((page, global));
    }
    let (physical, global) = if mode >= MODE_LEGACY {
        legacy_translate(rip as u32, false)?
    }
    else {
        let (physical, _, global) = memory::translate_page_execute(rip).ok()?;
        (physical, global)
    };
    let page = code_key(physical)? | MODE_KEYS[mode];
    CODE_TLB[core] = (tag, rip >> 12, page, global);
    Some((page, global))
}
/// The 32-bit translation of linear `address` for the current privilege in
/// legacy mode (P7.3): its physical address and whether it is global. It
/// fills the 32-bit TLB as the interpreter does (accessed and dirty bits)
/// only when it succeeds: a fault is the interpreter's to raise.
unsafe fn legacy_translate(address: u32, write: bool) -> Option<(u64, bool)> {
    let user = *gp::cpl == 3;
    cpu::translate_address(address as i32, write, user, false).ok()?;
    let physical = cpu::translate_address(address as i32, write, user, true).ok()?;
    let entry = cpu::tlb_data[(address >> 12) as usize];
    Some((physical as u64, entry & cpu::TLB_GLOBAL != 0))
}

/// INVLPG `address` on `core`: the cached code translation may be of that
/// page, and so may its chaining entries (a flush of the whole access cache
/// retired the others by epoch).
pub unsafe fn forget_code_page(core: usize, address: u64) {
    CODE_TLB[core] = (0, 0, 0, false);
    let page = address >> 12;
    // (the page the running function executes: a stepped INVLPG, in legacy
    // mode, leaves, as x64_page_invlpg does)
    if page == *gp::x64_page_linear >> 12 {
        CODE_WRITES += 1;
    }
    for table in CHAIN[core].0.iter_mut() {
        let entry = &mut table[page as usize & (CHAIN_ENTRIES - 1)];
        if entry.tag & !(!0 << jac::EPOCH_SHIFT) == page {
            entry.tag = 0;
        }
    }
}

/// The access cache epoch of `core` wrapped (jac::flush): its code
/// translations of earlier epochs go. (Legacy-mode TLB flushes start epochs
/// too, P7.1: thousands a minute while XP switches processes.)
pub unsafe fn forget_code(core: usize) {
    CODE_TLB[core] = (0, 0, 0, false);
    for table in CHAIN[core].0.iter_mut() {
        for entry in table.iter_mut() {
            entry.tag = 0;
        }
    }
}

/// The key of the code page at physical `address`: its RAM backing page
/// number, or (above every such number) its extended page's key.
unsafe fn code_key(address: u64) -> Option<u32> {
    if physical::plain_ram(address & !4095, 4096) {
        return Some((address >> 12) as u32);
    }
    match jac::ram_backing(address) {
        Some(backing) => Some(backing >> 12),
        None => extended::code_key(address),
    }
}
/// The key bit of a 32-bit function (P7.2; physical keys are below
/// extended::CODE_KEY_BASE plus the extended pages), the one of a
/// legacy-mode function besides (P7.3), and of one compiled for segment
/// bases (P7.2(3), segmented_runnable)
const COMPAT_KEY: u32 = 1 << 31;
const LEGACY_KEY: u32 = 1 << 30;
const SEGMENTED_KEY: u32 = 1 << 29;
/// The code key of a function's key: its page as compiled from
fn physical_key(key: u32) -> u32 { key & !(COMPAT_KEY | LEGACY_KEY | SEGMENTED_KEY) }
/// The code's mode, as function keys, code translations and chaining tables
/// tell it apart: 64-bit, compatibility mode (P7.2), 32-bit legacy protected
/// mode with flat segments (P7.3) and with segment bases (P7.2(3))
const MODE_LONG: usize = 0;
const MODE_COMPAT: usize = 1;
const MODE_LEGACY: usize = 2;
const MODE_SEGMENTED: usize = 3;
const MODE_KEYS: [u32; 4] = [
    0,
    COMPAT_KEY,
    COMPAT_KEY | LEGACY_KEY,
    COMPAT_KEY | LEGACY_KEY | SEGMENTED_KEY,
];
unsafe fn code_mode() -> usize {
    if state::mode().is_long() {
        MODE_LONG
    }
    else if state::efer() & state::EFER_LMA != 0 {
        MODE_COMPAT
    }
    else if legacy_runnable() {
        MODE_LEGACY
    }
    else {
        MODE_SEGMENTED
    }
}
fn is_extended(page: u32) -> bool { physical_key(page) >= extended::CODE_KEY_BASE }

/// Compatibility-mode code in the page tier (the JIT switch
/// x64_page_compat32, P7.2): 32-bit code under a 64-bit OS, while its data
/// and stack segments are flat (compat_runnable)
static mut COMPAT32: bool = false;
#[no_mangle]
pub unsafe fn x64_page_set_compat32(enabled: bool) { COMPAT32 = enabled; }
pub unsafe fn compat32() -> bool { COMPAT32 }
/// The current code runs in the page tier as 32-bit compatibility-mode
/// code: 32-bit CS, a 32-bit stack, and CS, DS, ES and SS with base 0 (as
/// WOW64's are; FS and GS bases are added at each access). Generated code
/// relies on it; a step that changes it leaves (context).
pub unsafe fn compat_runnable() -> bool {
    COMPAT32
        && state::mode() == state::ExecutionMode::Compatibility32
        && *gp::stack_size_32
        && cpu::has_flat_segmentation()
        && *gp::segment_offsets.add(cpu::ES as usize) == 0
        && !*gp::segment_is_null.add(cpu::ES as usize)
}
/// Legacy protected-mode code in the page tier (the JIT switch
/// x64_page_legacy32, P7.3), as 32-bit compatibility-mode code
static mut LEGACY32: bool = false;
#[no_mangle]
pub unsafe fn x64_page_set_legacy32(enabled: bool) { LEGACY32 = enabled; }
/// Whether a switch hands 32-bit code to the page tier (read once a slice)
pub unsafe fn page32() -> bool { COMPAT32 || LEGACY32 }
/// The current code runs in the page tier as 32-bit legacy protected-mode
/// code: as compat_runnable, and with FS not null (its base is added at each
/// access; GS's accesses step, see pagegen Decoder::legacy), paged or not
pub unsafe fn legacy_runnable() -> bool {
    LEGACY32
        && state::mode() == state::ExecutionMode::Protected32
        && *gp::stack_size_32
        && cpu::has_flat_segmentation()
        && *gp::segment_offsets.add(cpu::ES as usize) == 0
        && !*gp::segment_is_null.add(cpu::ES as usize)
        && !*gp::segment_is_null.add(cpu::FS as usize)
}
/// The current code runs in the page tier as legacy-mode code compiled for
/// segment bases (P7.2(3)): 32-bit protected mode with a flat 32-bit CS and
/// a 32-bit stack; each ES, SS, DS, FS or GS access adds its segment's base
/// and, but for SS, checks for a null selector (as Tier-0's functions for
/// other than flat segments do). Windows 98's VMM runs with a nonzero DS
/// base.
pub unsafe fn segmented_runnable() -> bool {
    LEGACY32
        && state::mode() == state::ExecutionMode::Protected32
        && *gp::stack_size_32
        && *gp::segment_offsets.add(cpu::CS as usize) == 0
}
/// compat_runnable, legacy_runnable or segmented_runnable
pub unsafe fn runnable32() -> bool { runnable_kind() != 0 }
/// 1 for compat_runnable or legacy_runnable (flat segments), 2 for
/// segmented_runnable only, else 0: a step that changes it leaves (context;
/// in a function compiled for segment bases, which runs flat segments too,
/// only a change to or from 0)
#[inline(always)]
unsafe fn runnable_kind() -> u8 {
    if compat_runnable() || legacy_runnable() {
        1
    }
    else if segmented_runnable() {
        2
    }
    else {
        0
    }
}
/// One interpreted instruction at RIP: the long-mode interpreter, or in
/// compatibility and legacy mode the 32-bit one (as Tier-0's steps)
unsafe fn interpret_one() {
    if state::mode().is_long() {
        cpu::run_long_instruction();
    }
    else {
        cpu::run_compat_instruction();
    }
}

unsafe fn release_dead(r: &mut Runtime) {
    if ACTIVE {
        return;
    }
    for (slot, id) in r.releases.drain(..) {
        crate::jit::ir_release_slot(slot, id);
    }
    (*(&raw mut HOT_FREE)).extend(r.released_counters.drain(..));
}

/// Run published code at RIP for up to `budget` instructions, or note the
/// interpreted instruction there. `retired` counts everything this call
/// retired (native instructions and interpreted steps).
pub unsafe fn run(budget: u32) -> Attempt {
    if budget == 0 || !allowed() {
        if step_profile::enabled() {
            step_profile::note_event(event::MISS, disallowed(budget));
        }
        return miss();
    }
    let rip = state::read_rip();
    let mode = code_mode();
    let compat = mode != MODE_LONG;
    let Some((page, global)) = code_page(rip, mode)
    else {
        step_profile::note_event(event::MISS, event::MISS_NO_CODE);
        return miss();
    };
    let offset = (rip & 4095) as u16;
    let r = rt();
    if !r.enabled {
        step_profile::note_event(event::MISS, event::MISS_DISABLED);
        return miss();
    }
    if !r.releases.is_empty() {
        release_dead(r);
    }
    let last = r.last_rip;
    r.last_rip = rip;
    // Far transfers (not the next few bytes) start blocks.
    let far = !(last < rip && rip - last <= 15);
    // a page without a function, as at the last miss: its heat goes to the
    // batch (P4.5b)
    if HEAT_BATCH.holds(page, r.generation) && HEAT_BATCH.count < HEAT_BATCH_LIMIT {
        if far {
            note_entry(r, page, offset);
        }
        HEAT_BATCH.count += 1;
        step_profile::note_event(event::MISS, event::MISS_COLD);
        return miss_run(r, page, budget, rip);
    }
    let (fast_page, fast_index) = FAST[fast_slot(page)];
    let index = if fast_page == page && fast_index != 0 {
        Some(fast_index as usize - 1)
    }
    else {
        let found = r.by_page.get(&page).copied();
        if let Some(i) = found {
            FAST[fast_slot(page)] = (page, i as u32 + 1);
        }
        found
    };
    match index {
        Some(i)
            if r.functions[i].page == page
                && r.functions[i].phase == Phase::Ready
                && bit(&r.functions[i].served, offset) =>
        {
            // (its code ran often: its recompile with inline lookups)
            if r.functions[i].counter.is_some_and(|c| {
                HOT_COUNTS[c as usize] >= if compat { COMPAT_HOT_COUNT } else { HOT_COUNT }
            }) {
                r.stats[HOT_RECOMPILES] += 1;
                return compile_mode(page, true);
            }
            r.clock += 1;
            r.functions[i].last_used = r.clock;
            let slot = r.functions[i].slot;
            if CHAINING {
                chain_fill(apic::current_core(), *gp::cpl == 3, mode, rip, slot, global);
            }
            execute(slot, budget, rip)
        },
        Some(i) if r.functions[i].page == page && r.functions[i].phase != Phase::Dead => {
            if r.functions[i].phase == Phase::Ready {
                // An entry the function does not serve: recompile once
                // enough repeated such entries accumulate (note_unserved)
                let state = r.pages.entry(page).or_default();
                if recompile_due(page, state) {
                    state.misses = 0;
                    step_profile::note_event(event::MISS, event::MISS_RECOMPILE);
                    return compile(page);
                }
                step_profile::note_event(event::MISS, event::MISS_UNSERVED);
                // Straight-line code is no entry, as in note_entry's `far`
                // (a block start there would split a loop body in the next,
                // hot, compile): after a retried instruction, or where the
                // interpreter ran up to while the function compiled, the
                // interpreter runs on to an offset the function serves
                if !far && MISS_RUN {
                    // (legacy mode, P7.3: one that recurs, as after an
                    // instruction retried on every iteration, counts towards
                    // a recompile that serves it; Tier-0 continues after
                    // such a step in place)
                    if mode >= MODE_LEGACY {
                        note_unserved(r, page, offset);
                    }
                    return unserved_run(r, i, budget, rip);
                }
                // Else the function steps from here to its next block start
                // (pagegen: unserved dispatch) and notes the entry
                if !far {
                    LAST_UNSERVED = last;
                }
                r.clock += 1;
                r.functions[i].last_used = r.clock;
                let slot = r.functions[i].slot;
                if CHAINING {
                    chain_fill(apic::current_core(), *gp::cpl == 3, mode, rip, slot, global);
                }
                return execute(slot, budget, rip);
            }
            step_profile::note_event(event::MISS, event::MISS_COMPILING);
            miss()
        },
        _ => {
            if far {
                note_entry(r, page, offset);
            }
            // (the batch: its count is this page's, or another page's to add first)
            let mut heat = 1;
            if HEAT_BATCH.holds(page, r.generation) {
                heat += HEAT_BATCH.count;
            }
            else {
                flush_heat(r);
            }
            HEAT_BATCH = HeatBatch::NONE;
            let state = r.pages.entry(page).or_default();
            state.heat += heat;
            // (legacy mode's first compile waits for LEGACY_HEAT; a page
            // compiled before is hot, its function retired by a write)
            let hot = if mode >= MODE_LEGACY && state.compiles == 0 { LEGACY_HEAT } else { HOT };
            if state.heat >= hot << backoff(state.compiles) {
                state.heat = 0;
                if state.entry_count == 0 {
                    state.entries[offset as usize / 64] |= 1 << (offset % 64);
                    state.entry_count = 1;
                }
                step_profile::note_event(event::MISS, event::MISS_COMPILE);
                return compile(page);
            }
            if BATCH_HEAT {
                HEAT_BATCH = HeatBatch {
                    page,
                    count: 0,
                    generation: r.generation,
                };
            }
            step_profile::note_event(event::MISS, event::MISS_COLD);
            miss_run(r, page, budget, rip)
        },
    }
}

/// Execution counters of cold (outlined) page functions (P4.14), a cell
/// each: the function increments its cell at each entry and dispatch
/// (pagegen Emitter::head), and run() recompiles its page with inline
/// lookups once the cell reaches HOT_COUNT. A cell is free again once its
/// function is released (release_dead): no code increments it then. Cells
/// for every live function and as many retired ones not yet released; a
/// compile that finds none free is not counted (it stays cold).
static mut HOT_COUNTS: [u32; HOT_CELLS] = [0; HOT_CELLS];
const HOT_CELLS: usize = MAX_FUNCTIONS + 1024;
static mut HOT_FREE: Vec<u32> = Vec::new();
/// cells never handed out: HOT_NEXT..HOT_CELLS
static mut HOT_NEXT: u32 = 0;
unsafe fn take_counter() -> Option<u32> {
    let cell = (*(&raw mut HOT_FREE)).pop().or_else(|| {
        (HOT_NEXT < HOT_CELLS as u32).then(|| {
            HOT_NEXT += 1;
            HOT_NEXT - 1
        })
    })?;
    HOT_COUNTS[cell as usize] = 0;
    Some(cell)
}
/// The JIT switches x64_hot_inline and x64_hot_count (P4.14)
static mut HOT_INLINE: bool = true;
static mut HOT_COUNT: u32 = 1 << 22;
#[no_mangle]
pub unsafe fn x64_page_set_hot_inline(enabled: bool) { HOT_INLINE = enabled; }
pub unsafe fn set_hot_count(count: u32) { HOT_COUNT = count; }
/// x64_compat_hot_count: HOT_COUNT of 32-bit compatibility-mode functions
/// (P7.2b): WOW64 code is a small share of what a Windows boot compiles, so
/// its hot pages are recompiled early, as Tier-0 compiles loops at once
static mut COMPAT_HOT_COUNT: u32 = 1 << 16;
pub unsafe fn set_compat_hot_count(count: u32) { COMPAT_HOT_COUNT = count; }

/// Interpreted execution's heat, batched (docs/jit-unification-plan.md
/// P4.5b; jitrt takes it over in P5): instructions run outside compiled
/// code on a code page without a function, not yet added to the page's
/// PageState. While the runtime's functions are unchanged (`generation`)
/// a miss on that page needs neither the function nor the page lookup; it
/// is added at the next miss of another page, and at HEAT_BATCH_LIMIT.
#[derive(Clone, Copy)]
pub struct HeatBatch {
    page: u32,
    count: u32,
    generation: u32,
}
impl HeatBatch {
    const NONE: HeatBatch = HeatBatch {
        page: u32::MAX,
        count: 0,
        generation: 0,
    };
    fn holds(self, page: u32, generation: u32) -> bool {
        self.page == page && self.generation == generation
    }
}
const HEAT_BATCH_LIMIT: u32 = 256;
static mut HEAT_BATCH: HeatBatch = HeatBatch::NONE;
/// The JIT switches x64_heat_batch (P4.5b) and x64_miss_run (P4.5c)
static mut BATCH_HEAT: bool = true;
static mut MISS_RUN: bool = true;
/// Instructions a miss run interprets at most
const MISS_RUN_LIMIT: u32 = 64;
#[no_mangle]
pub unsafe fn x64_page_set_heat_batch(enabled: bool) {
    flush_heat(rt());
    HEAT_BATCH = HeatBatch::NONE;
    BATCH_HEAT = enabled;
}
#[no_mangle]
pub unsafe fn x64_page_set_miss_run(enabled: bool) { MISS_RUN = enabled; }
/// The batch's heat to its page (whose compile waits for its next miss)
unsafe fn flush_heat(r: &mut Runtime) {
    let b = HEAT_BATCH;
    if b.count != 0 && b.generation == r.generation {
        r.pages.entry(b.page).or_default().heat += b.count;
    }
    HEAT_BATCH.count = 0;
}

/// A miss on code page `page` (at `rip`, which has no function): the
/// interpreter runs the instruction there, and with x64_miss_run (P4.5c)
/// the ones after it on the same linear page, without returning to run():
/// until another page, RIP unchanged (HLT, a REP instruction's batch, a
/// fault restarting it), a change of mode or CPL, a yield or core event,
/// `budget` or MISS_RUN_LIMIT; far transfers within the page are noted as
/// entries on the way, as run() notes them. Without the switch the caller
/// interprets the one instruction (retired 0). Each further instruction is
/// heat for the page, counted in the batch (or directly without
/// x64_heat_batch); its compile waits for the next miss.
unsafe fn miss_run(r: &mut Runtime, page: u32, budget: u32, rip: u64) -> Attempt {
    if !MISS_RUN {
        return miss();
    }
    let (linear, cpl, mode, kind) = (rip >> 12, *gp::cpl, state::mode(), runnable_kind());
    let limit = budget.min(MISS_RUN_LIMIT);
    let span = execution::ledger_begin();
    let (mut n, mut at) = (0, rip);
    loop {
        crate::x64::extended::safe_point();
        *gp::previous_ip = *gp::instruction_pointer;
        interpret_one();
        n += 1;
        let next = state::read_rip();
        if n >= limit
            || next >> 12 != linear
            || next == at
            || *gp::cpl != cpl
            || state::mode() != mode
            || !mode.is_long() && runnable_kind() != kind
            || *gp::in_hlt
            || cpu::core_yield
            || apic::has_core_events()
        {
            break;
        }
        // (far transfers start blocks, as in run())
        if !(at < next && next - at <= 15) {
            note_entry(r, page, (next & 4095) as u16);
        }
        at = next;
        if HEAT_BATCH.holds(page, r.generation) {
            HEAT_BATCH.count += 1;
        }
        else {
            r.pages.entry(page).or_default().heat += 1;
        }
    }
    // (the next miss compares its RIP with the last instruction run here)
    r.last_rip = at;
    execution::ledger_end(span, execution::Way::Interpreted);
    Attempt {
        retired: n,
        submitted: false,
    }
}

/// unserved_run: run() reached function `i` straight-line at an offset it
/// does not serve (after a retried instruction, as a page-crossing VMOVDQU
/// ymm in a loop's body): the interpreter runs to the next offset the
/// function serves, stopping as miss_run does, instead of entering the
/// function to step each instruction up to its next block start (an
/// activation, a dispatch and a step apiece)
unsafe fn unserved_run(r: &mut Runtime, i: usize, budget: u32, rip: u64) -> Attempt {
    let (linear, cpl, mode, kind) = (rip >> 12, *gp::cpl, state::mode(), runnable_kind());
    let limit = budget.min(MISS_RUN_LIMIT);
    let span = execution::ledger_begin();
    let (mut n, mut at) = (0, rip);
    loop {
        crate::x64::extended::safe_point();
        *gp::previous_ip = *gp::instruction_pointer;
        interpret_one();
        n += 1;
        let next = state::read_rip();
        if n >= limit
            || next >> 12 != linear
            || !(at < next && next - at <= 15)
            || bit(&r.functions[i].served, (next & 4095) as u16)
            || *gp::cpl != cpl
            || state::mode() != mode
            || !mode.is_long() && runnable_kind() != kind
            || *gp::in_hlt
            || cpu::core_yield
            || apic::has_core_events()
        {
            break;
        }
        at = next;
    }
    // (the next miss compares its RIP with the last instruction run here)
    r.last_rip = at;
    execution::ledger_end(span, execution::Way::Interpreted);
    Attempt {
        retired: n,
        submitted: false,
    }
}

/// A published function was entered at `offset`, which it does not serve.
/// Interrupted code resumes at arbitrary instructions, mostly once each; an
/// offset counts as an entry (and towards a recompile) from its second
/// sighting. True when the page is due for a recompile.
fn note_unserved(r: &mut Runtime, page: u32, offset: u16) -> bool {
    let state = r.pages.entry(page).or_default();
    let (word, mask) = (offset as usize / 64, 1u64 << (offset % 64));
    if state.entries[word] & mask != 0 {
        state.misses += 1;
    }
    else if state.seen[word] & mask != 0 {
        state.entries[word] |= mask;
        state.entry_count += 1;
        state.misses += 1;
        r.stats[ENTRIES] += 1;
        if step_profile::enabled() && !is_extended(page) {
            unsafe { ACCESS_REFUSED[6 + late_entry_kind(page, offset)] += 1 };
        }
    }
    else {
        state.seen[word] |= mask;
    }
    recompile_due(page, state)
}
/// (profile) 0: the instruction before looks like a call, 1: 16-byte
/// aligned, 2: other
fn late_entry_kind(page: u32, offset: u16) -> usize {
    let page = physical_key(page);
    let at = |o: u16| unsafe { *crate::cpu::memory::mem8.add(((page << 12) + o as u32) as usize) };
    let o = offset;
    let call = o >= 5 && at(o - 5) == 0xE8
        || o >= 6 && at(o - 6) == 0xFF && at(o - 5) == 0x15
        || o >= 2 && at(o - 2) == 0xFF && at(o - 1) & 0xF8 == 0xD0
        || o >= 3 && at(o - 3) == 0xFF && at(o - 2) & 0x38 == 0x10 && at(o - 2) >> 6 == 1;
    if call {
        0
    }
    else if o % 16 == 0 {
        1
    }
    else {
        2
    }
}
static mut LAST_UNSERVED: u64 = 0;
/// Generated code reached an offset its function does not serve (dispatch
/// after a transfer or a step): 1 to leave (EXIT_UNKNOWN: the page is due for
/// a recompile), 0 to step the instruction there in place. Only the first of
/// consecutive stepped instructions is noted.
#[no_mangle]
pub unsafe fn x64_page_unserved(rip: u64) -> i32 {
    let far = !(LAST_UNSERVED < rip && rip - LAST_UNSERVED <= 15);
    LAST_UNSERVED = rip;
    if !far {
        ACCESS_REFUSED[4] += 1;
        return 0;
    }
    let Some((page, _)) = code_page(rip, code_mode())
    else {
        return 1;
    };
    let leave = note_unserved(rt(), page, (rip & 4095) as u16) as i32;
    ACCESS_REFUSED[4] += (leave == 0) as u64;
    leave
}

fn note_entry(r: &mut Runtime, page: u32, offset: u16) {
    if r.pages.len() >= MAX_TRACKED_PAGES && !r.pages.contains_key(&page) {
        // Forget cold pages; published functions keep their own entries.
        r.pages.retain(|_, state| state.compiles != 0);
        if r.pages.len() >= MAX_TRACKED_PAGES / 2 {
            r.pages.clear();
        }
    }
    let state = r.pages.entry(page).or_default();
    let (word, mask) = (offset as usize / 64, 1u64 << (offset % 64));
    if state.entries[word] & mask == 0 {
        state.entries[word] |= mask;
        state.entry_count += 1;
        r.stats[ENTRIES] += 1;
    }
}

unsafe fn execute(slot: u32, budget: u32, rip: u64) -> Attempt {
    if TIMING {
        let t0 = time::microtick();
        let attempt = execute_inner(slot, budget, rip);
        TIME_IN_EXECUTE += time::microtick() - t0;
        return attempt;
    }
    execute_inner(slot, budget, rip)
}
unsafe fn execute_inner(slot: u32, budget: u32, rip: u64) -> Attempt {
    let before = *gp::instruction_counter;
    let span = execution::ledger_begin();
    let core = apic::current_core();
    *gp::x64_jac_base = jac::base(core, *gp::cpl == 3);
    *gp::x64_jac_epoch = jac::epoch_bits(core);
    *gp::x64_page_linear = rip & !4095;
    *gp::x64_page_exit = pagegen::EXIT_NORMAL;
    let mode = code_mode();
    *gp::x64_code_base = chain_base(core, *gp::cpl == 3, mode);
    SEGMENTED_ACTIVE = mode == MODE_SEGMENTED;
    *gp::x64_page_chain = 0;
    *gp::x64_page_lazy_kind = 0;
    // Generated code keeps EFLAGS materialized.
    if *gp::flags_changed != 0 {
        let flags = state::read_flags64();
        state::write_flags64(flags);
    }
    ACTIVE = true;
    COUNTERS[COUNT_ACTIVATIONS] += 1;
    STEP_EXITED = false;
    let t_call = if TIMING { time::microtick() } else { 0.0 };
    let native = call_indirect1_ret(
        (slot + cpu::WASM_TABLE_OFFSET) as i32,
        budget.min(u16::MAX as u32) as u16,
    ) as u32;
    if TIMING {
        TIME_IN_CALLS += time::microtick() - t_call;
    }
    ACTIVE = false;
    // (functions this activation tail-called from)
    let native = native.wrapping_add(*gp::x64_page_chain);
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(native);
    execution::note_native_retired(native, execution::jit_dispatches());
    execution::ledger_end_count(span, execution::Way::PageNative, native);
    let exit = *gp::x64_page_exit;
    if step_profile::enabled() {
        step_profile::note_event(
            event::EXIT,
            match exit {
                pagegen::EXIT_RETRY => event::EXIT_RETRY,
                pagegen::EXIT_UNKNOWN => event::EXIT_UNKNOWN,
                _ if STEP_EXITED => event::EXIT_STEP,
                _ if native >= budget.min(u16::MAX as u32) => event::EXIT_BUDGET,
                _ => event::EXIT_LEAVE,
            },
        );
    }
    let r = rt();
    r.stats[RETIRED] += native as u64;
    r.last_rip = state::read_rip();
    match exit {
        pagegen::EXIT_RETRY => {
            r.stats[RETRIES] += 1;
            if step_profile::enabled() && *gp::mxcsr & 0x20 == 0 {
                ACCESS_REFUSED[5] += 1;
            }
            profile_instruction(true);
            // (native code resumes after the interpreted instruction: an
            // unserved entry, noted when the function steps there)
            let span = execution::ledger_begin();
            interpret_one();
            execution::ledger_end(span, execution::Way::PageRetry);
        },
        pagegen::EXIT_UNKNOWN => r.stats[UNKNOWN] += 1,
        _ => {},
    }
    cpu::handle_irqs();
    Attempt {
        retired: (*gp::instruction_counter).wrapping_sub(before),
        submitted: false,
    }
}

unsafe fn compile(page: u32) -> Attempt { compile_mode(page, false) }
/// compile(page), or with `hot` its recompile with inline access lookups
/// (P4.14), which is no compile of its own: no backoff
unsafe fn compile_mode(page: u32, hot: bool) -> Attempt {
    let r = rt();
    let state = r.pages.entry(page).or_default();
    if hot {
        state.hot = true;
    }
    else {
        state.compiles += 1;
    }
    let recompile = state.compiles > 1 || hot;
    // (P7.2: a 32-bit function's key, of the same page; P7.3: legacy mode's)
    let (compat, physical) = (page & COMPAT_KEY != 0, physical_key(page));
    let legacy = page & LEGACY_KEY != 0;
    let segmented = page & SEGMENTED_KEY != 0;
    // (legacy mode's lookups are inline either way, in the 32-bit TLB: no
    // cold compile and hot recompile, which would start V8's tier-up anew;
    // loops from the first compile)
    let outline = pagegen::outline_access() && !state.hot && !legacy;
    let counter = if outline && HOT_INLINE { take_counter() } else { None };
    // (a recompile serves the unserved offsets seen once so far too: each
    // would otherwise count towards the next recompile)
    let mut entries: Vec<u16> = (0..4096u16)
        .filter(|&o| bit(&state.entries, o) || recompile && bit(&state.seen, o))
        .collect();
    let bytes = if is_extended(page) {
        extended::copy_page(physical - extended::CODE_KEY_BASE)
    }
    else {
        std::slice::from_raw_parts(
            crate::cpu::memory::mem8.add((physical << 12) as usize),
            4096,
        )
        .to_vec()
    };
    // Likely function starts: 16-byte aligned after INT3 padding (MSVC x64
    // code). Serving them from the first compile avoids most recompiles for
    // entries that other pages call later. (Guesses: an instruction's last
    // byte may be 0xCC, as MULSD XMM1, XMM4's ModRM; pagegen drops those
    // that code runs into, which would split its block)
    for o in (16..4096u16).step_by(16) {
        if bytes[o as usize - 1] == 0xCC && bytes[o as usize] != 0xCC && !bit(&state.entries, o) {
            entries.push(o | pagegen::GUESSED);
        }
    }
    // (named after the linear page it was compiled for: host profiles)
    let linear = state::read_rip() & !4095;
    let name = format!(
        "x64_page{}_{:x}",
        if segmented {
            "s32"
        }
        else if legacy {
            "l32"
        }
        else if compat {
            "32"
        }
        else {
            ""
        },
        linear
    );
    let next = next_page_bytes(linear);
    let Some(code) = pagegen::compile(
        &bytes,
        next.as_ref().map_or(&[][..], |b| &b[..]),
        &entries,
        chaining(),
        outline,
        counter.map(|c| &raw const HOT_COUNTS[c as usize] as u32),
        compat,
        legacy,
        segmented,
        name,
    )
    else {
        (*(&raw mut HOT_FREE)).extend(counter);
        rt().stats[FAILED] += 1;
        return miss();
    };
    let r = rt();
    if recompile {
        r.stats[RECOMPILED] += 1;
    }
    // Room in the table: retire the least recently used function; of this
    // code's mode when that holds more than its share (P7.2b: 32-bit
    // compatibility-mode code and long-mode code each keep a third at least)
    let live = r
        .functions
        .iter()
        .filter(|f| f.phase != Phase::Dead)
        .count();
    if live >= MAX_FUNCTIONS {
        if let Some(i) = eviction_victim(&r.functions, compat) {
            retire(r, i);
            r.stats[EVICTED] += 1;
        }
    }
    release_dead(r);
    let id = r.next_id;
    r.next_id += 1;
    // Watching the page retires cached write translations to it (jac). An
    // extended page is watched by extended.rs, once its old function is gone.
    let watched = if is_extended(page) {
        HashSet::new()
    }
    else {
        HashSet::from([Page::page_of(physical << 12)])
    };
    let Some(slot) = crate::jit::ir_reserve_slot(id, watched)
    else {
        (*(&raw mut HOT_FREE)).extend(counter);
        rt().stats[FAILED] += 1;
        return miss();
    };
    let r = rt();
    if let Some(&old) = r.by_page.get(&page) {
        retire(r, old);
    }
    if is_extended(page) {
        extended::watch_code(physical - extended::CODE_KEY_BASE);
    }
    let reusable = |f: &Function, releases: &Vec<(u32, u64)>| {
        f.phase == Phase::Dead && !releases.iter().any(|&(s, i)| s == f.slot && i == f.id)
    };
    let index = match r.functions.iter().position(|f| reusable(f, &r.releases)) {
        Some(i) => i,
        None => {
            r.functions.push(Function {
                page,
                id: 0,
                slot: 0,
                phase: Phase::Dead,
                served: [0; 64],
                last_used: 0,
                source: 0,
                counter: None,
                native_at: 0,
            });
            r.functions.len() - 1
        },
    };
    r.clock += 1;
    r.functions[index] = Function {
        page,
        id,
        slot,
        phase: Phase::Pending,
        served: code.served,
        last_used: r.clock,
        source: source_hash(&bytes),
        counter,
        native_at: r.stats[RETIRED],
    };
    r.by_page.insert(page, index);
    r.generation = r.generation.wrapping_add(1);
    FAST[fast_slot(page)] = (page, index as u32 + 1);
    r.stats[COMPILED] += 1;
    if legacy {
        COUNTERS[COUNT_LEGACY_COMPILES] += 1;
    }
    else if compat {
        COUNTERS[COUNT_COMPAT_COMPILES] += 1;
    }
    unsafe { BYTES_COMPILED += code.bytes.len() as u64 };
    r.stats[INSTRUCTIONS] += code.instructions as u64;
    r.stats[TEMPLATED] += code.templated as u64;
    // The host installs it synchronously when it can (x64_page_install).
    js::x64_page_publish(
        id,
        slot,
        code.bytes.as_ptr() as u32,
        code.bytes.len() as u32,
    );
    Attempt {
        retired: 0,
        submitted: false,
    }
}

/// The first bytes of the linear page after `linear_page` as instruction
/// fetch sees them now, when that page is plain RAM (instructions that
/// straddle into it, see pagegen).
unsafe fn next_page_bytes(linear_page: u64) -> Option<[u8; 16]> {
    let next = linear_page.wrapping_add(4096);
    let physical = if state::efer() & state::EFER_LMA == 0 {
        legacy_translate(next as u32, false)?.0
    }
    else {
        memory::translate(next, paging::Access::Execute, false, false).ok()?
    };
    let backing = jac::ram_backing(physical)?;
    let mut bytes = [0u8; 16];
    std::ptr::copy_nonoverlapping(
        crate::cpu::memory::mem8.add(backing as usize),
        bytes.as_mut_ptr(),
        16,
    );
    Some(bytes)
}
/// Generated code, before an instruction that continues into the next page:
/// whether that page (after gp::x64_page_linear) fetches as `word`, its
/// first `count` bytes when compiled. Else the instruction is stepped (the
/// interpreter fetches it, faults included).
#[no_mangle]
pub unsafe fn x64_page_straddle(word: u64, count: u32) -> i32 {
    let Some(bytes) = next_page_bytes(*gp::x64_page_linear)
    else {
        return 0;
    };
    let mask = if count >= 8 { !0 } else { (1u64 << (8 * count)) - 1 };
    (u64::from_le_bytes(bytes[..8].try_into().unwrap()) & mask == word) as i32
}

fn retire(r: &mut Runtime, index: usize) { retire_with(r, index, true) }
/// `unchain`: clear the chaining entries of the function (reset clears all).
fn retire_with(r: &mut Runtime, index: usize, unchain: bool) {
    let f = &mut r.functions[index];
    if f.phase == Phase::Dead {
        return;
    }
    f.phase = Phase::Dead;
    let (page, slot, id) = (f.page, f.slot, f.id);
    r.released_counters.extend(f.counter.take());
    r.generation = r.generation.wrapping_add(1);
    if unchain {
        unsafe { unchain_slot(slot) };
    }
    if r.by_page.get(&page) == Some(&index) {
        r.by_page.remove(&page);
        // (the page's function in another mode, P7.2, keeps it watched)
        if is_extended(page)
            && !MODE_KEYS
                .iter()
                .any(|&mode| r.by_page.contains_key(&(physical_key(page) | mode)))
        {
            unsafe { extended::unwatch_code(physical_key(page) - extended::CODE_KEY_BASE) };
        }
    }
    unsafe {
        if FAST[fast_slot(page)].0 == page {
            FAST[fast_slot(page)] = (0, 0);
        }
    }
    r.releases.push((slot, id));
}

/// Called by the host before table.set: false if the function was retired
/// meanwhile (its source changed, or reset).
#[no_mangle]
pub fn x64_page_install(id: u64, slot: u32) -> bool {
    let r = rt();
    let Some(f) = r
        .functions
        .iter()
        .find(|f| f.id == id && f.slot == slot && f.phase == Phase::Pending)
    else {
        return false;
    };
    if !crate::parallel::active() {
        return true;
    }
    // other cores mark the page first, then its bytes are checked once more
    let (page, source) = (f.page, f.source);
    let backing = match r.by_page.get(&page) {
        // (extended pages are not compiled then: retire_extended)
        Some(_) if !is_extended(page) => physical_key(page),
        _ => return false,
    };
    if !crate::jit::wait_pages_published(std::iter::once(Page::page_of(backing << 12)), 0.5) {
        return false;
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(crate::cpu::memory::mem8.add((backing << 12) as usize), 4096)
    };
    source_hash(bytes) == source
}

/// FNV-1a over a code page
fn source_hash(bytes: &[u8]) -> u64 {
    let mut hash = 0xCBF29CE484222325u64;
    for &byte in bytes {
        hash = (hash ^ byte as u64).wrapping_mul(0x100000001B3);
    }
    hash
}
#[no_mangle]
pub fn x64_page_ready(id: u64, slot: u32) -> bool {
    let r = rt();
    match r
        .functions
        .iter_mut()
        .find(|f| f.id == id && f.slot == slot && f.phase == Phase::Pending)
    {
        Some(f) => {
            f.phase = Phase::Ready;
            if unsafe { TIMING } {
                let slot = f.slot;
                unsafe { time_first_call(slot) };
            }
            true
        },
        None => false,
    }
}
/// (x64_page_timing) Call a new function once with budget 0: it returns at
/// its first budget check, having written back the unchanged state, and the
/// time is the engine's lazy compilation.
unsafe fn time_first_call(slot: u32) {
    if ACTIVE {
        return;
    }
    if *gp::flags_changed != 0 {
        let flags = state::read_flags64();
        state::write_flags64(flags);
    }
    *gp::x64_page_lazy_kind = 0;
    *gp::x64_page_linear = state::read_rip() & !4095;
    let core = apic::current_core();
    *gp::x64_jac_base = jac::base(core, *gp::cpl == 3);
    *gp::x64_jac_epoch = jac::epoch_bits(core);
    let t0 = time::microtick();
    ACTIVE = true;
    call_indirect1_ret((slot + cpu::WASM_TABLE_OFFSET) as i32, 0);
    ACTIVE = false;
    TIME_FIRST_CALLS += time::microtick() - t0;
    *gp::x64_page_exit = pagegen::EXIT_NORMAL;
}
#[no_mangle]
pub fn x64_page_cancel(id: u64, slot: u32) {
    let r = rt();
    if let Some(i) = r
        .functions
        .iter()
        .position(|f| f.id == id && f.slot == slot && f.phase != Phase::Dead)
    {
        retire(r, i);
        r.stats[FAILED] += 1;
    }
    unsafe { release_dead(r) };
}

/// A write to a watched backing page (see jit::jit_dirty_page), or to an
/// extended page with code (key from extended::CODE_KEY_BASE on).
pub fn dirty_page(page: u32) {
    let r = rt();
    // (the page's functions in every code mode, P7.2, P7.3)
    let dead: Vec<usize> = MODE_KEYS
        .iter()
        .filter_map(|&mode| r.by_page.get(&(page | mode)).copied())
        .collect();
    if dead.is_empty() {
        return;
    }
    unsafe {
        CODE_WRITES += 1;
    }
    for i in dead {
        // (legacy mode, P7.3: a function that ran long before its page was
        // written costs no backoff: the VMM's pages under Windows 98 hold
        // data written twice a second, and backed-off pages stay
        // interpreted; a page rewritten while its code runs, as 709.smc's,
        // still backs off)
        let f = &r.functions[i];
        if f.page & LEGACY_KEY != 0 && r.stats[RETIRED].wrapping_sub(f.native_at) >= LIVED {
            let key = f.page;
            if let Some(state) = r.pages.get_mut(&key) {
                state.compiles = state.compiles.min(1);
            }
        }
        retire(r, i);
        r.stats[INVALIDATED] += 1;
    }
    // Slots are released at the next entry, outside the JIT state lock.
}
/// Native instructions of the tier after which a legacy-mode function whose
/// page is written counts as having lived long (dirty_page)
const LIVED: u64 = 1 << 22;

/// Cores start to run in workers (crate::parallel): writes to extended RAM
/// are no longer tracked for code, so its page functions go.
pub fn retire_extended() {
    let r = rt();
    unsafe {
        CODE_TLB = [(0, 0, 0, false); 8];
    }
    for i in 0..r.functions.len() {
        if is_extended(r.functions[i].page) {
            retire(r, i);
        }
    }
}

/// Retire everything (jit_clear_cache: reset, restore, mapping changes).
pub fn reset() {
    let r = rt();
    clear_chains();
    for i in 0..r.functions.len() {
        retire_with(r, i, false);
    }
    r.pages.clear();
    r.last_rip = 0;
    r.generation = r.generation.wrapping_add(1);
    unsafe {
        CODE_WRITES += 1;
        HEAT_BATCH = HeatBatch::NONE;
    }
}

#[no_mangle]
pub fn x64_page_set_enabled(enabled: bool) {
    rt().enabled = enabled;
    if !enabled {
        reset();
    }
}

/// The values of x64_page_set_enabled, x64_page_set_chaining and
/// x64_page_set_recompile_misses (crate::jit_switches)
pub fn switch_value(name: &str) -> Option<u32> {
    unsafe {
        Some(match name {
            "x64_page" => rt().enabled as u32,
            "x64_chaining" => CHAINING as u32,
            "x64_recompile_misses" => RECOMPILE_MISSES,
            "x64_heat_batch" => BATCH_HEAT as u32,
            "x64_miss_run" => MISS_RUN as u32,
            "x64_hot_inline" => HOT_INLINE as u32,
            "x64_hot_count" => HOT_COUNT,
            "x64_compat_hot_count" => COMPAT_HOT_COUNT,
            "x64_page_compat32" => COMPAT32 as u32,
            "x64_page_legacy32" => LEGACY32 as u32,
            "x64_legacy_heat" => LEGACY_HEAT,
            "x64_legacy_recompile_misses" => LEGACY_MISSES,
            _ => return None,
        })
    }
}
#[no_mangle]
pub fn x64_page_stat(field: u32) -> f64 {
    let r = rt();
    match field as usize {
        4 => unsafe { STEPS as f64 },
        12 => r
            .functions
            .iter()
            .filter(|f| f.phase == Phase::Ready)
            .count() as f64,
        f if f < 12 => r.stats[f] as f64,
        f @ 13..=19 => unsafe { COUNTERS[f as usize - 13] as f64 },
        20 => unsafe { TIME_IN_CALLS },
        22 => unsafe { TIME_IN_EXECUTE },
        23 => unsafe { TIME_FIRST_CALLS },
        25 => unsafe { COUNTERS[COUNT_UNALIGNED_READS] as f64 },
        f @ 26..=32 => unsafe { COUNTERS[f as usize - 26 + COUNT_CR0_WRITES] as f64 },
        33 => r.stats[HOT_RECOMPILES] as f64,
        f @ 34..=35 => unsafe { COUNTERS[f as usize - 34 + COUNT_JAC_FILLS] as f64 },
        36 => unsafe { COUNTERS[COUNT_COMPAT_COMPILES] as f64 },
        37 => unsafe { COUNTERS[COUNT_LEGACY_COMPILES] as f64 },
        24 => unsafe { BYTES_COMPILED as f64 },
        // pages compiled at least once (while tracked)
        21 => r.pages.values().filter(|state| state.compiles != 0).count() as f64,
        _ => 0.0,
    }
}

// Helpers called by generated code -------------------------------------

/// Host address for a `kind & 255`-byte access (bit 8: write) at linear
/// `address` for the current privilege, filling the access cache; 0 when the
/// instruction must be interpreted instead (fault, device or VGA memory,
/// page with compiled code, page crossing). No guest-visible effects except
/// the A/D updates of a successful translation.
#[no_mangle]
pub unsafe fn x64_page_access(address: u64, kind: u32) -> u32 {
    COUNTERS[COUNT_ACCESS_MISSES] += 1;
    let size = (kind & 0xFF) as u64;
    let write = kind & 0x100 != 0;
    if (address & 4095) + size > 4096 {
        if let Some(host) = crossing_host(address, write) {
            return host;
        }
        ACCESS_REFUSED[0] += 1;
        return 0;
    }
    // generated accesses are atomic with cores in workers: aligned only. An
    // unaligned read of RAM is served from a copy (a racing write may or may
    // not be in it, as for a split access); an unaligned write is retried,
    // unless its code stores unaligned itself (kind bit 9, pagegen store).
    if crate::wasmgen::wasm_builder::WasmBuilder::ATOMIC_GUEST_MEMORY
        && address & (size.min(8) - 1) != 0
        && !(write && kind & 0x200 != 0)
    {
        if !write {
            if let Ok((physical, _, _)) = memory::translate_page(address, paging::Access::Read) {
                if let Some(backing) = jac::ram_backing(physical) {
                    let bounce = &raw mut BOUNCE as *mut u8;
                    let from =
                        crate::cpu::memory::mem8.add((backing + (address & 4095) as u32) as usize);
                    for i in 0..size as usize {
                        *bounce.add(i) = crate::parallel::load8(from.add(i));
                    }
                    COUNTERS[COUNT_UNALIGNED_READS] += 1;
                    return bounce as u32;
                }
            }
        }
        ACCESS_REFUSED[0] += 1;
        return 0;
    }
    let access = if write { paging::Access::Write } else { paging::Access::Read };
    let Ok((physical, large, global)) = memory::translate_page(address, access)
    else {
        ACCESS_REFUSED[1] += 1;
        return 0;
    };
    let Some(backing) = jac::ram_backing(physical)
    else {
        // extended RAM: its frame, while cores share this thread (never a
        // write entry for a page with a page function: extended::cache_frame)
        if let Some(host) = super::extended::cache_frame(physical, write) {
            let backing = host.wrapping_sub(crate::cpu::memory::mem8 as u32);
            jac::fill(
                apic::current_core(),
                *gp::cpl == 3,
                write,
                address,
                backing,
                large,
                global,
            );
            return host.wrapping_add((address & 4095) as u32);
        }
        // the VGA frame buffer: plain memory with dirty tracking
        if let Some(backing) = jac::frame_buffer_backing(physical, write) {
            COUNTERS[COUNT_LFB_FILLS] += 1;
            jac::fill(
                apic::current_core(),
                *gp::cpl == 3,
                write,
                address,
                backing,
                large,
                global,
            );
            return (crate::cpu::memory::mem8 as u32)
                .wrapping_add(backing)
                .wrapping_add((address & 4095) as u32);
        }
        ACCESS_REFUSED[2] += 1;
        return 0;
    };
    if write && crate::jit::page_needs_notification(Page::page_of(backing)) {
        ACCESS_REFUSED[3] += 1;
        return 0;
    }
    jac::fill(
        apic::current_core(),
        *gp::cpl == 3,
        write,
        address,
        backing,
        large,
        global,
    );
    (crate::cpu::memory::mem8 as u32)
        .wrapping_add(backing)
        .wrapping_add((address & 4095) as u32)
}

/// x64_page_access of an operand that crosses into the next page: served
/// when both pages are plain RAM whose backings are adjacent (guest RAM is
/// one array: so are most), for a write neither with compiled code; else
/// the instruction is retried, then the activation steps up to its next
/// block start (page-crossing VMOVDQU ymm loads and stores in a loop). With
/// cores in workers it is unaligned, which atomic accesses refuse.
unsafe fn crossing_host(address: u64, write: bool) -> Option<u32> {
    if crate::wasmgen::wasm_builder::WasmBuilder::ATOMIC_GUEST_MEMORY {
        return None;
    }
    let access = if write { paging::Access::Write } else { paging::Access::Read };
    let (first, _, _) = memory::translate_page(address, access).ok()?;
    let (second, _, _) =
        memory::translate_page((address & !4095).wrapping_add(4096), access).ok()?;
    let backing = jac::ram_backing(first)?;
    if jac::ram_backing(second)? != backing.wrapping_add(4096) {
        return None;
    }
    if write
        && (crate::jit::page_needs_notification(Page::page_of(backing))
            || crate::jit::page_needs_notification(Page::page_of(backing + 4096)))
    {
        return None;
    }
    Some(
        (crate::cpu::memory::mem8 as u32)
            .wrapping_add(backing)
            .wrapping_add((address & 4095) as u32),
    )
}

/// x64_page_access of legacy-mode code (P7.3; pagegen CompileEnv::legacy):
/// a miss in the 32-bit TLB, which this fills as Tier-0's slow paths do
/// (ir_t0_read_slow, ir_t0_write_slow); what it refuses (0) the
/// interpreter makes
#[no_mangle]
pub unsafe fn x64_page_access32(address: u64, kind: u32) -> u32 {
    COUNTERS[COUNT_ACCESS_MISSES] += 1;
    let address = address as u32;
    let size = kind & 0xFF;
    let write = kind & 0x100 != 0;
    let host = if (address & 4095) + size > 4096 {
        // (both pages served, their hosts adjacent: as crossing_host)
        if crate::wasmgen::wasm_builder::WasmBuilder::ATOMIC_GUEST_MEMORY {
            Err(0)
        }
        else {
            legacy_host(address, write).and_then(|first| {
                let second = legacy_host((address & !4095).wrapping_add(4096), write)?;
                if second == (first & !4095).wrapping_add(4096) {
                    Ok(first)
                }
                else {
                    Err(0)
                }
            })
        }
    }
    else if crate::wasmgen::wasm_builder::WasmBuilder::ATOMIC_GUEST_MEMORY
        && address & (size.min(8) - 1) != 0
        && !(write && kind & 0x200 != 0)
    {
        // (unaligned with cores in workers: as x64_page_access)
        if write {
            Err(0)
        }
        else {
            legacy_host(address, false).map(|host| {
                let bounce = &raw mut BOUNCE as *mut u8;
                for i in 0..size as usize {
                    *bounce.add(i) = crate::parallel::load8((host as *const u8).add(i));
                }
                COUNTERS[COUNT_UNALIGNED_READS] += 1;
                bounce as u32
            })
        }
    }
    else {
        legacy_host(address, write)
    };
    host.unwrap_or_else(|refused| {
        ACCESS_REFUSED[refused] += 1;
        0
    })
}
/// The host address of a legacy-mode access at linear `address` (not
/// crossing a page) for the current privilege, filling the 32-bit TLB, or
/// the ACCESS_REFUSED counter of why the interpreter must make it: it would
/// fault, it reaches device memory other than a frame buffer, or it writes
/// a page with compiled code
unsafe fn legacy_host(address: u32, write: bool) -> Result<u32, usize> {
    let (physical, _) = legacy_translate(address, write).ok_or(1usize)?;
    let entry = cpu::tlb_data[(address >> 12) as usize];
    if entry & cpu::TLB_IN_MAPPED_RANGE != 0 {
        // the VGA frame buffer: plain memory with dirty tracking (no TLB
        // entry hits it inline: each access comes here)
        let backing = jac::frame_buffer_backing(physical & !4095, write).ok_or(2usize)?;
        COUNTERS[COUNT_LFB_FILLS] += 1;
        return Ok((crate::cpu::memory::mem8 as u32)
            .wrapping_add(backing)
            .wrapping_add(address & 4095));
    }
    if write && entry & cpu::TLB_HAS_CODE != 0 {
        return Err(3);
    }
    Ok((entry & !0xFFF ^ address as i32) as u32)
}

#[derive(PartialEq)]
struct Context {
    cpl: u8,
    cs: u16,
    long: bool,
    cr0: u64,
    cr3: u64,
    cr4: u64,
    efer: u64,
    control: i32,
    dr7: u64,
    epoch: u64,
    /// in compatibility and legacy mode, runnable_kind (P7.2, P7.3)
    compat: u8,
}
// (inlined into x64_page_step, as before P7.2's field: every long-mode step
// takes it twice; runnable32 only in 32-bit modes)
#[inline(always)]
unsafe fn context() -> Context {
    let long = state::mode().is_long();
    Context {
        cpl: *gp::cpl,
        cs: *gp::sreg.add(1),
        long,
        compat: match (long, runnable_kind()) {
            (true, _) => 0,
            (_, 1) if SEGMENTED_ACTIVE => 2,
            (_, kind) => kind,
        },
        cr0: state::read_cr(0),
        cr3: state::read_cr(3),
        cr4: state::read_cr(4),
        efer: state::efer(),
        // IF, TF, AC, VM, RF and IOPL change what may run natively
        control: *gp::flags & (0x200 | 0x100 | 0x40000 | 0x20000 | 0x10000 | 0x3000),
        dr7: state::read_dr(7),
        epoch: jac::epoch_bits(apic::current_core()),
    }
}

/// Interpret the instruction at RIP (state was written back). Continue the
/// activation only if nothing it depends on changed.
/// Refused cache fills (then retried in the interpreter): page crossing,
/// translation fault, device or VGA memory, page with compiled code; then
/// instructions stepped because the function was entered at an offset it
/// does not serve (x64_page_unserved), and (with the step profile) retries
/// with MXCSR.PE clear; then late entries (unserved offsets seen twice) by
/// kind: after a call, 16-byte aligned, other.
static mut ACCESS_REFUSED: [u64; 9] = [0; 9];
/// The step profile (crate::step_profile, the JIT switch step_profile): on,
/// an empty one; off, dropped
#[no_mangle]
pub unsafe fn x64_page_profile(enabled: bool) {
    step_profile::set_enabled(false);
    step_profile::set_enabled(enabled);
}
/// Steps of this tier by its earlier key (bits 0-17 of StepKey: one-byte
/// opcodes 0..255, 0F xx as 0x100 | xx, 0F 38/3A xx as 0x200/0x300 | xx; VEX
/// forms as 0x4000 | L << 12 | pp << 10 | map << 8 | opcode; +0x10000 with a
/// REP prefix; retries at key + 0x20000), or with key >= 0x40000 the refused
/// access counter key - 0x40000.
#[no_mangle]
pub unsafe fn x64_page_profile_get(key: u32) -> f64 {
    if key >= 0x40000 {
        return (*(&raw const ACCESS_REFUSED))
            .get(key as usize - 0x40000)
            .copied()
            .unwrap_or(0) as f64;
    }
    step_profile::x64_legacy_count(key) as f64
}
/// With the step profile: stepped instructions by RIP (x64_page_step_rips)
static mut STEP_RIPS: Option<HashMap<u64, u32>> = None;
unsafe fn profile_step() {
    if !step_profile::enabled() {
        return;
    }
    let rips = (*(&raw mut STEP_RIPS)).get_or_insert_with(HashMap::new);
    if rips.len() < 1 << 16 {
        *rips.entry(state::read_rip()).or_default() += 1;
    }
    profile_instruction(false);
}
/// The `n`th most stepped RIP (sorted when n is 0) and its count; clears
/// the histogram when `n` is past its end
#[no_mangle]
pub unsafe fn x64_page_step_rip(n: u32, high: bool, count: bool) -> f64 {
    static mut SORTED: Vec<(u64, u32)> = Vec::new();
    let sorted = &mut *(&raw mut SORTED);
    if n == 0 && !high && !count {
        *sorted = (*(&raw mut STEP_RIPS))
            .take()
            .unwrap_or_default()
            .into_iter()
            .collect();
        sorted.sort_by(|a, b| b.1.cmp(&a.1));
    }
    let Some(&(rip, times)) = sorted.get(n as usize)
    else {
        return -1.0;
    };
    if count {
        times as f64
    }
    else if high {
        (rip >> 32) as f64
    }
    else {
        (rip & 0xFFFF_FFFF) as f64
    }
}
/// A step (or with `retry`, a retried instruction) at RIP into the step
/// profile: its bytes as far as they translate to RAM without side effects
unsafe fn profile_instruction(retry: bool) {
    if !step_profile::enabled() {
        return;
    }
    let rip = state::read_rip();
    let mut bytes = [0u8; 15];
    let mut n = 0;
    if state::efer() & state::EFER_LMA == 0 {
        // (legacy mode, P7.3: as Tier-0's step profile)
        if let Ok(physical) = cpu::translate_address_read_no_side_effects(rip as i32) {
            if !crate::cpu::memory::in_mapped_range(physical) {
                n = step_profile::read_legacy(rip as u32, physical, &mut bytes);
            }
        }
    }
    while n < 15 && state::efer() & state::EFER_LMA != 0 {
        let Some(t) =
            memory::snapshot_translation(rip.wrapping_add(n as u64), paging::Access::Execute)
        else {
            break;
        };
        let Ok(page) = physical::ram_page(t.physical.0 & !4095)
        else {
            break;
        };
        bytes[n] =
            *crate::cpu::memory::mem8.add((page.backing + (t.physical.0 & 4095) as u32) as usize);
        n += 1;
    }
    step_profile::note(step_profile::x86_key(
        &bytes[..n],
        state::mode(),
        step_profile::Stepper::X64Page,
        retry,
    ));
}

#[no_mangle]
pub unsafe fn x64_page_step() -> i32 {
    STEPS += 1;
    profile_step();
    let before = context();
    let writes = CODE_WRITES;
    ACTIVE = false;
    let span = execution::ledger_begin();
    interpret_one();
    execution::ledger_end(span, execution::Way::PageStep);
    ACTIVE = true;
    let flags = state::read_flags64();
    state::write_flags64(flags);
    let after = context();
    let exit = if *gp::in_hlt {
        event::STEP_EXIT_HALT
    }
    else if cpu::core_yield {
        event::STEP_EXIT_YIELD
    }
    else if *gp::interrupt_shadow != 0 {
        event::STEP_EXIT_SHADOW
    }
    else if apic::has_core_events() {
        event::STEP_EXIT_CORE_EVENT
    }
    else if CODE_WRITES != writes {
        event::STEP_EXIT_CODE_WRITE
    }
    else if after != before {
        if step_profile::enabled() {
            note_context_changes(&before, &after)
        }
        else {
            event::STEP_EXIT_BARRIER
        }
    }
    else if *gp::flags & 0x200 != 0
        && (apic::has_pending_irq() || apic::routed_pic_pending(apic::current_core() as u32))
    {
        event::STEP_EXIT_IRQ
    }
    else if apic::nmi_pending() {
        event::STEP_EXIT_NMI
    }
    else {
        return pagegen::STEP_CONTINUE;
    };
    STEP_EXITED = true;
    step_profile::note_event(event::STEP_EXIT, exit);
    pagegen::STEP_EXIT
}

/// Whether the last activation ended in a step that left (its exit's reason
/// for the step profile, P4.0)
static mut STEP_EXITED: bool = false;

/// The parts of a step's context that changed, each a STEP_CONTEXT event:
/// STEP_EXIT_CHAINABLE if only those P4.3's STEP_CHAIN may continue after
/// did (the CPL, CS, CR3, the epoch, IF, IOPL, AC), else STEP_EXIT_BARRIER
unsafe fn note_context_changes(before: &Context, after: &Context) -> u32 {
    let control = before.control ^ after.control;
    let changes = [
        (before.cpl != after.cpl, event::STEP_CONTEXT_CPL, true),
        (before.cs != after.cs, event::STEP_CONTEXT_CS, true),
        (before.long != after.long, event::STEP_CONTEXT_MODE, false),
        (before.cr0 != after.cr0, event::STEP_CONTEXT_CR0, false),
        (before.cr3 != after.cr3, event::STEP_CONTEXT_CR3, true),
        (before.cr4 != after.cr4, event::STEP_CONTEXT_CR4, false),
        (before.efer != after.efer, event::STEP_CONTEXT_EFER, false),
        (control & 0x200 != 0, event::STEP_CONTEXT_IF, true),
        (control & 0x100 != 0, event::STEP_CONTEXT_TF, false),
        (control & 0x40000 != 0, event::STEP_CONTEXT_AC, true),
        (control & 0x20000 != 0, event::STEP_CONTEXT_VM, false),
        (control & 0x10000 != 0, event::STEP_CONTEXT_RF, false),
        (control & 0x3000 != 0, event::STEP_CONTEXT_IOPL, true),
        (before.dr7 != after.dr7, event::STEP_CONTEXT_DR7, false),
        (before.epoch != after.epoch, event::STEP_CONTEXT_EPOCH, true),
    ];
    let mut chainable = true;
    for (changed, part, chain) in changes {
        if changed {
            step_profile::note_event(event::STEP_CONTEXT, part);
            chainable &= chain;
        }
    }
    if chainable {
        event::STEP_EXIT_CHAINABLE
    }
    else {
        event::STEP_EXIT_BARRIER
    }
}

/// EFLAGS with the pending bits of a lazy record (pagegen::Emitter::record)
/// computed: record = ALU code << 16 | log2(width / 8) << 20 | carry << 23 |
/// pending bits; `a`, `b` the operands.
#[no_mangle]
pub fn x64_page_flags(record: u32, a: u64, b: u64, flags: u32) -> u32 {
    let code = (record >> 16 & 7) as u8;
    let width = 8u8 << (record >> 20 & 3);
    let carry = (record >> 23 & 1) as u64;
    let pending = record & 0x8D5;
    let (_, computed) = super::execute::alu(code, a, b, width, carry);
    flags & !pending | computed as u32 & pending
}

/// INVLPG for generated code (CPL 0 is checked inline). True when the
/// function must leave after it: the access cache was flushed (its epoch
/// changed), or the invalidated page may be the running code page (or in its
/// 2 MiB region).
#[no_mangle]
pub unsafe fn x64_page_invlpg(address: u64) -> bool {
    // Intel defines a noncanonical INVLPG operand as a no-op.
    if !state::canonical(address, 48) {
        return false;
    }
    let core = apic::current_core();
    let before = jac::epoch_bits(core);
    memory::invlpg(address);
    cpu::invlpg(address as i32);
    jac::epoch_bits(core) != before || address >> 21 == *gp::x64_page_linear >> 21
}

/// The commit of a locked instruction (pagegen locked_store, cores in
/// workers): replace `expected` by `value` at the aligned host address, as
/// the interpreter's locked instructions do; 0 when another core changed it.
#[no_mangle]
pub unsafe fn x64_page_lock_commit(host: u32, expected: u64, value: u64, bytes: u32) -> i32 {
    crate::parallel::compare_exchange(host as *mut u8, bytes, expected, value) as i32
}

/// Shifts and rotates without a template (pagegen Op::ShiftCall): `kind` =
/// ALU group code | width << 8 (at most 32); the result in the low half,
/// EFLAGS in the high half.
#[no_mangle]
pub fn x64_page_shift(a: u64, count: u32, flags: u32, kind: u32) -> u64 {
    let (r, f) = super::execute::shift(
        (kind & 7) as u8,
        a,
        count as u8,
        (kind >> 8) as u8,
        flags as u64,
    );
    r & 0xFFFF_FFFF | f << 32
}

/// Compatibility mode (docs/jit-unification-plan.md P7.2): a shift or
/// rotate as the 32-bit interpreter computes it, EFLAGS included
/// (cpu::arith on its lazy EFLAGS, materialized before and after): `kind` =
/// ALU group code | width << 8 (8, 16 or 32), `count` as its instruction
/// handlers mask it, `last_op1` the page function's (pagegen
/// Emitter::last_op1: SHL, SHR and SAR leave AF to it). The result in the
/// low half, EFLAGS in the high half.
#[no_mangle]
pub unsafe fn x64_page_shift32(a: u64, count: u32, flags: u32, kind: u32, last_op1: i32) -> u64 {
    use crate::cpu::arith::*;
    *gp::flags = flags as i32;
    *gp::flags_changed = 0;
    *gp::last_op1 = last_op1;
    let (a, count) = (a as i32, (count & 31) as i32);
    let r = match (kind >> 8, kind & 7) {
        (8, 0) => rol8(a, count),
        (8, 1) => ror8(a, count),
        (8, 2) => rcl8(a, count),
        (8, 3) => rcr8(a, count),
        (8, 5) => shr8(a, count),
        (8, 7) => sar8(a, count),
        (8, _) => shl8(a, count),
        (16, 0) => rol16(a, count),
        (16, 1) => ror16(a, count),
        (16, 2) => rcl16(a, count),
        (16, 3) => rcr16(a, count),
        (16, 5) => shr16(a, count),
        (16, 7) => sar16(a, count),
        (16, _) => shl16(a, count),
        (_, 0) => rol32(a, count),
        (_, 1) => ror32(a, count),
        (_, 2) => rcl32(a, count),
        (_, 3) => rcr32(a, count),
        (_, 5) => shr32(a, count),
        (_, 7) => sar32(a, count),
        _ => shl32(a, count),
    };
    let f = cpu::get_eflags();
    *gp::flags = f;
    *gp::flags_changed = 0;
    r as u32 as u64 | (f as u32 as u64) << 32
}

/// PCMPESTRx/PCMPISTRx for generated code (ir::runtime::tier0::pcmpstr on
/// its operand block): the lengths RAX/RDX, or EAX/EDX sign-extended
#[no_mangle]
pub unsafe fn x64_page_pcmpstr(op: u32, imm8: u32, a: i64, b: i64) -> u32 {
    crate::ir::runtime::tier0::pcmpstr(op, imm8, a, b)
}

/// MOV and POP ES, DS, FS or GS in legacy-mode code (pagegen
/// Emitter::load_segment, P7.3), as Tier-0's ir_t0_load_seg: 1 when refused
/// (nothing changed: the instruction is retried); else the segment is
/// loaded: 2 when the code no longer runs as the function was compiled
/// (legacy_runnable: a null ES or FS, a nonzero ES base; with `segmented`,
/// segmented_runnable: a null ES, DS or FS; switch_seg_without_fault
/// refuses a DS that changes flat segmentation), so it leaves after it
#[no_mangle]
pub unsafe fn x64_page_load_seg(segment: u32, selector: u32, segmented: u32) -> u32 {
    if !cpu::switch_seg_without_fault(segment as i32, selector as i32 & 0xFFFF, segmented == 0) {
        return 1;
    }
    // (a function compiled for segment bases runs flat segments too)
    if legacy_runnable() || segmented != 0 && segmented_runnable() {
        0
    }
    else {
        2
    }
}

/// RDTSC for generated code (the privilege check is inline).
#[no_mangle]
pub unsafe fn x64_page_rdtsc() -> u64 { cpu::read_tsc() }

/// STI's interrupt shadow ended in compiled code (pagegen: End::Shadow,
/// x64_sti_shadow): 1 if an interrupt is deliverable under `flags` (the
/// function leaves for the dispatcher, which takes it)
#[no_mangle]
pub unsafe fn x64_page_irq_window(flags: i32) -> i32 {
    (flags & 0x200 != 0
        && (apic::has_pending_irq() || apic::routed_pic_pending(apic::current_core() as u32)))
        as i32
}
/// MOV r64, CR8 for generated code (CPL 0 is checked inline).
#[no_mangle]
pub unsafe fn x64_page_cr8() -> u64 { state::read_cr(8) }
/// MOV CR8, r64 for generated code: 0 continue, 1 retry (reserved bits are
/// #GP), 2 leave after the instruction (an interrupt the new task priority
/// admits is taken at the next boundary).
#[no_mangle]
pub unsafe fn x64_page_set_cr8(value: u64) -> i32 {
    if super::system::write_cr(8, value).is_err() {
        return 1;
    }
    if *gp::flags & cpu::FLAG_INTERRUPT != 0 && apic::has_pending_irq() {
        2
    }
    else {
        0
    }
}

/// Whether the signed 64x64 product of IMUL overflows 64 bits.
#[no_mangle]
pub fn x64_page_imul_overflow(a: u64, b: u64) -> bool { (a as i64).checked_mul(b as i64).is_none() }
/// High 64 bits of the 128-bit product of MUL (or IMUL when `signed`).
#[no_mangle]
pub fn x64_page_mul_high(a: u64, b: u64, signed: bool) -> u64 {
    if signed {
        ((a as i64 as i128 * b as i64 as i128) >> 64) as u64
    }
    else {
        ((a as u128 * b as u128) >> 64) as u64
    }
}

#[cfg(test)]
mod quota_tests {
    use super::*;
    fn function(page: u32, last_used: u64) -> Function {
        Function {
            page,
            id: 0,
            slot: 0,
            phase: Phase::Ready,
            served: [0; 64],
            last_used,
            source: 0,
            counter: None,
            native_at: 0,
        }
    }
    /// (P7.2b) A full table retires the least recently used function, but
    /// of the compiling code's mode once that mode holds more than its share
    #[test]
    fn each_mode_keeps_a_share() {
        // the oldest functions are the long mode's: 2000 of them
        let mut functions: Vec<Function> = (0..2000).map(|i| function(i, i as u64)).collect();
        functions.extend(
            (0..MAX_FUNCTIONS as u32 - 2000).map(|i| function(i | COMPAT_KEY, 10_000 + i as u64)),
        );
        // compatibility-mode code beyond its share retires its own
        let victim = eviction_victim(&functions, true).unwrap();
        assert!(functions[victim].page & COMPAT_KEY != 0);
        assert_eq!(functions[victim].last_used, 10_000);
        // long-mode code within its share: the least recently used of all
        let victim = eviction_victim(&functions, false).unwrap();
        assert_eq!(functions[victim].last_used, 0);
        // a mode within its share takes the oldest of all, the crowded one
        // its own
        let mut few: Vec<Function> = (0..10)
            .map(|i| function(i | COMPAT_KEY, 50 + i as u64))
            .collect();
        few.extend((0..MAX_FUNCTIONS as u32 - 10).map(|i| function(i, 100 + i as u64)));
        assert_eq!(few[eviction_victim(&few, true).unwrap()].last_used, 50);
        assert_eq!(few[eviction_victim(&few, false).unwrap()].last_used, 100);
    }
}
