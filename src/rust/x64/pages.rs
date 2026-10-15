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
use crate::jitrt::capacity;
use crate::jitrt::chain::{self, ChainTable};
use crate::jitrt::heat::{self, backoff, HeatBatch, HEAT_BATCH_LIMIT};
use crate::jitrt::page::{self, PageFrontend};
use crate::jitrt::publish::{self, Phase};
use crate::jitrt::step::{self, StepFrontend, StepOutcome};
use crate::jitrt::ClientId;
use crate::page::Page;
use crate::step_profile::{self, event};
use std::collections::{HashMap, HashSet};

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
/// IR Tier-0 (deleted in P7.5) compiled a page at 50000 instructions and
/// never for new entries.
/// (XP to the desktop, i440FX, one core: at 2000 and 64, 1435 compiles of
/// 568 pages, 98 MB of Wasm, 18.2 s; at these, 365 of 247, 27 MB, 13.4 s.)
static mut LEGACY_HEAT: u32 = 50_000;
static mut LEGACY_MISSES: u32 = 4096;
pub unsafe fn set_legacy_heat(heat: u32) { LEGACY_HEAT = heat; }
pub unsafe fn set_legacy_recompile_misses(misses: u32) { LEGACY_MISSES = misses; }
/// Compiles of a page before each further one waits twice as long (heat
/// and unserved entries): a page recompiled for ever new entries, or
/// rewritten over and over, costs ever less; its code stays in use.
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

/// The x64 page tier as a client of jitrt's page runtime (P5.7): its
/// functions' code facts, its code pages' own state and its own runtime
/// state
struct X86;
impl PageFrontend for X86 {
    type Code = X86Code;
    type Page = X86Page;
    type Extra = X86Extra;
}
type Function = page::Function<X86Code>;
type PageState = heat::PageState<X86Page>;
type Runtime = page::PageRuntime<X86>;

/// A function's own data. (Its key, the page number of its backing page
/// with the code mode's bits, or an extended page's key (see code_key);
/// `served`, its block starts as a bitmap of offsets, 64 words a page of
/// `members`, the keys of the consecutive linear pages it covers: a span of
/// legacy-mode code, P7.3b, else just its page: page::Function's.)
#[derive(Default)]
struct X86Code {
    /// The bytes its instructions were decoded from, as `served`
    /// (pagegen::Compiled::code): dirty_bytes
    code: Vec<u64>,
    /// The offsets its instructions start at, as `served`
    starts: Vec<u64>,
    /// The bytes of its volatile instructions (pagegen::Compiled::dynamic)
    dynamic: Vec<u64>,
    /// the source page's bytes (hash) when compiled: with cores in workers,
    /// checked again after the page is published (crate::parallel::code)
    source: u64,
    /// compiled with outlined access lookups and an execution counter, the
    /// HOT_COUNTS cell (a cold compile with x64_hot_inline, P4.14)
    counter: Option<u32>,
    /// The tier's native instructions when it was compiled (stats[RETIRED]):
    /// how long it ran when its page is written (dirty_page)
    native_at: u64,
    /// 16-bit protected-mode code (P7.7): the IP of its first page's first
    /// byte as compiled (its linear address less CS's base), which the
    /// function requires (pagegen::CompileEnv::ip_base)
    ip_base: i32,
}
fn bit(set: &[u64], offset: u16) -> bool { set[offset as usize / 64] >> (offset % 64) & 1 != 0 }
/// The function a full table retires for a compile of (`compat`) code: the
/// least recently used ready one, of that code's mode when the mode holds
/// more than MODE_SHARE (P7.2b)
fn eviction_victim(r: &Runtime, compat: bool) -> Option<usize> {
    r.victim(|f| (f.page & COMPAT_KEY != 0) == compat, MODE_SHARE)
}
/// A code page's own state (heat::PageState's `x`)
#[derive(Default)]
struct X86Page {
    /// its code ran often: compiled with inline access lookups from then on
    /// (x64_hot_inline, P4.14; not a compile of its own, no backoff)
    hot: bool,
    /// times run() found it entered from the linear page before it (0) or
    /// after it (1), with x64_page_clusters: span_members (P7.3b)
    from: [u16; 2],
    /// a write retired its function (dirty_page): no span takes it, P7.3b
    written: bool,
    /// Offsets of instructions a write changed while compiled
    /// (dirty_bytes), volatile in its compiles alone from then on
    /// (pagegen::CompileEnv::volatile); `volatile_new`: some since its last
    /// compile, which run() repeats at its next miss
    volatile: Vec<u16>,
    volatile_new: bool,
}
/// The runtime's own state
struct X86Extra {
    /// dead functions' HOT_COUNTS cells, free again when their slots are
    /// released
    released_counters: Vec<u32>,
    last_rip: u64,
    /// The linear page the last activation or miss run ended on (P7.3b)
    last_page: u64,
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
pub static mut COUNTERS: [u64; 23] = [0; 23];
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
/// compiles of spans (P7.3b), and their pages
pub const COUNT_SPANS: usize = 19;
pub const COUNT_SPAN_PAGES: usize = 20;
/// 16-bit protected-mode compiles (P7.7)
pub const COUNT_PROT16_COMPILES: usize = 21;
/// real-mode and virtual-8086 compiles (P7.8)
pub const COUNT_V86_COMPILES: usize = 22;
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
/// An activation is under way, steps and helpers in it too (physical::
/// set_window refuses to change the bus then; M11, as the IR cache's busy)
static mut IN_ACTIVATION: bool = false;
pub fn in_activation() -> bool { unsafe { IN_ACTIVATION } }
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
        (*(&raw mut RUNTIME)).get_or_insert_with(|| {
            Runtime::new(X86Extra {
                released_counters: Vec::new(),
                last_rip: 0,
                last_page: 0,
            })
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
    crate::jit::enabled()
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

/// Per core: code page translations (access cache epoch | user | code mode
/// << 1, linear page, key, global), direct mapped by linear page: code that
/// calls between pages (as 709.smc into the page it rewrites) translates
/// each once. An x64 TLB invalidation changes the epoch, as do legacy-mode
/// flushes (P7.1; INVLPG forgets the page's entry).
const CODE_TLB_SIZE: usize = 16;
type CodeTlb = [(u64, u64, u32, bool); CODE_TLB_SIZE];
static mut CODE_TLB: [CodeTlb; 8] = [[(0, 0, 0, false); CODE_TLB_SIZE]; 8];

/// Chaining (pagegen::Emitter::chain): a page function leaving its page
/// looks the new linear page up here and tail-calls the function serving it,
/// without returning to the dispatch loop: jitrt::chain's tables (P5.8), per
/// core, code mode (P7.2, P7.3) and CPL, tagged with the access cache epoch
/// (so every x64 TLB flush retires the entries; INVLPG retires its page's).
pub const CHAIN_ENTRIES: usize = chain::ENTRIES;
#[repr(C, align(16))]
struct ChainTables([ChainTable; 2 * MODE_KEYS.len()]);
static mut CHAIN: [ChainTables; 8] =
    [const { ChainTables([const { ChainTable::EMPTY }; 2 * MODE_KEYS.len()]) }; 8];
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
    CHAIN[core].0[mode * 2 + user as usize].base()
}
unsafe fn chain_fill(core: usize, user: bool, mode: usize, rip: u64, slot: u32, global: bool) {
    CHAIN[core].0[mode * 2 + user as usize].fill(
        rip >> 12,
        jac::epoch_bits(core),
        slot + cpu::WASM_TABLE_OFFSET,
        global,
    );
}
/// MOV CR3 (see memory::invalidate_core_nonglobal): code translations of
/// non-global pages go.
pub unsafe fn forget_nonglobal_code(core: usize) {
    for entry in CODE_TLB[core].iter_mut() {
        if !entry.3 {
            entry.0 = 0;
        }
    }
    for table in CHAIN[core].0.iter_mut() {
        table.forget_nonglobal();
    }
}
fn clear_chains() {
    unsafe {
        for core in (*(&raw mut CHAIN)).iter_mut() {
            for table in core.0.iter_mut() {
                table.clear();
            }
        }
    }
}
/// A function is retired: no chaining to its slot any more.
unsafe fn unchain_slot(slot: u32) {
    let index = slot + cpu::WASM_TABLE_OFFSET;
    for core in 0..apic::core_count().clamp(1, 8) {
        for table in CHAIN[core].0.iter_mut() {
            table.unchain(index);
        }
    }
}
/// The key of the code page at `rip` for code of `mode` (see code_key and
/// MODE_KEYS), and whether its translation is global.
unsafe fn code_page(rip: u64, mode: usize) -> Option<(u32, bool)> {
    let core = apic::current_core();
    let tag = jac::epoch_bits(core) | (*gp::cpl == 3) as u64 | (mode as u64) << 1;
    let index = (rip >> 12) as usize & (CODE_TLB_SIZE - 1);
    let (cached_tag, linear, page, global) = CODE_TLB[core][index];
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
    CODE_TLB[core][index] = (tag, rip >> 12, page, global);
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
    let page = address >> 12;
    CODE_TLB[core][page as usize & (CODE_TLB_SIZE - 1)].0 = 0;
    // (the page the running function executes: a stepped INVLPG leaves, as
    // x64_page_invlpg does; in legacy mode any, which may be another page of
    // a span, P7.3b)
    if page == *gp::x64_page_linear >> 12 || state::efer() & state::EFER_LMA == 0 {
        CODE_WRITES += 1;
    }
    for table in CHAIN[core].0.iter_mut() {
        table.forget_page(jac::LAYOUT, page);
    }
}

/// The access cache epoch of `core` wrapped (jac::flush): its code
/// translations of earlier epochs go. (Legacy-mode TLB flushes start epochs
/// too, P7.1: thousands a minute while XP switches processes.)
pub unsafe fn forget_code(core: usize) {
    CODE_TLB[core] = [(0, 0, 0, false); CODE_TLB_SIZE];
    for table in CHAIN[core].0.iter_mut() {
        table.clear();
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
/// legacy-mode function besides (P7.3), of one compiled for segment
/// bases (P7.2(3), segmented_runnable), of 16-bit protected-mode code
/// (P7.7, prot16_runnable) and with that of real-mode and virtual-8086 code
/// (P7.8, real_runnable, v86_runnable)
const COMPAT_KEY: u32 = 1 << 31;
const LEGACY_KEY: u32 = 1 << 30;
const SEGMENTED_KEY: u32 = 1 << 29;
const PROT16_KEY: u32 = 1 << 28;
const REAL_KEY: u32 = 1 << 27;
const V86_KEY: u32 = 1 << 26;
/// (M11) the stack's width is not the code's: 16-bit protected-mode code on
/// a 32-bit stack, 32-bit code compiled for segment bases on a 16-bit stack
/// (prot16_ss32_runnable, segmented_ss16_runnable)
const STACK_KEY: u32 = 1 << 25;
const MODE_BITS: u32 =
    COMPAT_KEY | LEGACY_KEY | SEGMENTED_KEY | PROT16_KEY | REAL_KEY | V86_KEY | STACK_KEY;
/// The code key of a function's key: its page as compiled from
fn physical_key(key: u32) -> u32 { key & !MODE_BITS }
/// The code's mode, as function keys, code translations and chaining tables
/// tell it apart: 64-bit, compatibility mode (P7.2), 32-bit legacy protected
/// mode with flat segments (P7.3) and with segment bases (P7.2(3)), 16-bit
/// protected mode (P7.7), real mode and virtual-8086 mode (P7.8)
const MODE_LONG: usize = 0;
const MODE_COMPAT: usize = 1;
const MODE_LEGACY: usize = 2;
const MODE_SEGMENTED: usize = 3;
const MODE_PROT16: usize = 4;
const MODE_REAL: usize = 5;
const MODE_V86: usize = 6;
const MODE_PROT16_SS32: usize = 7;
const MODE_SEGMENTED_SS16: usize = 8;
/// 16-bit code's modes (their functions require CS's base, ip_base)
fn code16(mode: usize) -> bool {
    matches!(mode, MODE_PROT16 | MODE_REAL | MODE_V86 | MODE_PROT16_SS32)
}
const MODE_KEYS: [u32; 9] = [
    0,
    COMPAT_KEY,
    COMPAT_KEY | LEGACY_KEY,
    COMPAT_KEY | LEGACY_KEY | SEGMENTED_KEY,
    COMPAT_KEY | LEGACY_KEY | SEGMENTED_KEY | PROT16_KEY,
    COMPAT_KEY | LEGACY_KEY | SEGMENTED_KEY | PROT16_KEY | REAL_KEY,
    COMPAT_KEY | LEGACY_KEY | SEGMENTED_KEY | PROT16_KEY | V86_KEY,
    COMPAT_KEY | LEGACY_KEY | SEGMENTED_KEY | PROT16_KEY | STACK_KEY,
    COMPAT_KEY | LEGACY_KEY | SEGMENTED_KEY | STACK_KEY,
];
unsafe fn code_mode() -> usize {
    let mode = state::mode();
    if mode.is_long() {
        MODE_LONG
    }
    else if state::efer() & state::EFER_LMA != 0 {
        MODE_COMPAT
    }
    else {
        // (legacy mode: runnable_kind's 1 is legacy_runnable)
        match kind_of(mode) {
            1 => MODE_LEGACY,
            3 => MODE_PROT16,
            4 => MODE_REAL,
            5 => MODE_V86,
            6 => MODE_PROT16_SS32,
            7 => MODE_SEGMENTED_SS16,
            _ => MODE_SEGMENTED,
        }
    }
}
fn is_extended(page: u32) -> bool { physical_key(page) >= extended::CODE_KEY_BASE }

/// Multi-page functions of legacy-mode code (the JIT switch
/// x64_page_clusters, docs/jit-unification-plan.md P7.3b, as Tier-0's
/// neighbour clusters): span_members
static mut CLUSTERS: bool = true;
#[no_mangle]
pub unsafe fn x64_page_set_clusters(enabled: bool) { CLUSTERS = enabled; }
/// Transfers between two pages that make them one span (the JIT switch
/// x64_span_crossings): an XP boot passes once between most neighbours, a
/// loop over pages (708.pages) on every iteration (at 256 an XP boot made
/// 87 spans and compiled 19% more bytes, at 4096 13 spans and 7%)
static mut SPAN_CROSSINGS: u32 = 4096;
pub unsafe fn set_span_crossings(crossings: u32) { SPAN_CROSSINGS = crossings; }
/// Entries (PageState::entry_count) a page of a span has at most: code
/// that runs on from page to page (708.pages: one each) rather than pages
/// of many small functions, one of which runs into the next (an XP boot's
/// spans joined pages of 8 to 117 entries, and made it 1% slower; the JIT
/// switch x64_span_entries)
static mut SPAN_ENTRIES: u32 = 8;
pub unsafe fn set_span_entries(entries: u32) { SPAN_ENTRIES = entries; }
/// The consecutive linear pages of a span of legacy-mode code (P7.3b)
/// around `linear`, whose key is `page`: (key, linear page, physical page),
/// in linear order. A page before (after) the span joins while run() found
/// control passing between it and the span's first (last) page, outside
/// compiled code, SPAN_CROSSINGS times (PageState::from), both have at most
/// SPAN_ENTRIES entries, it maps to plain RAM without a fault, no write
/// retired code of it (PageState::written) and it is no page of the span
/// already; at most pagegen::MAX_SPAN. Not with cores in workers.
unsafe fn span_members(r: &Runtime, page: u32, linear: u64) -> Vec<(u32, u64, u32)> {
    let user = *gp::cpl == 3;
    let mode_key = page & MODE_BITS;
    let at = |linear: u64| -> Option<(u32, u64, u32)> {
        if linear >= 1 << 32 {
            return None;
        }
        let physical = cpu::translate_address(linear as i32, false, user, false).ok()?;
        let key = code_key(physical as u64 & !4095)?;
        (key < extended::CODE_KEY_BASE).then_some((key | mode_key, linear, physical & !4095))
    };
    let Some(own) = at(linear).filter(|&(key, ..)| key == page)
    else {
        return vec![(page, linear, 0)];
    };
    if crate::parallel::active() || !physical::plain_ram((physical_key(page) as u64) << 12, 4096) {
        return vec![own];
    }
    let from = |key: u32, side: usize| r.pages.get(&key).map_or(0, |s| s.x.from[side] as u32);
    let few_entries = |key: u32| {
        r.pages
            .get(&key)
            .is_none_or(|s| s.entry_count <= SPAN_ENTRIES)
    };
    let written = |key: u32| r.pages.get(&key).is_some_and(|s| s.x.written);
    if written(page) {
        return vec![own];
    }
    let mut span = vec![own];
    while span.len() < pagegen::MAX_SPAN && span[0].1 != 0 {
        let Some(before) = at(span[0].1 - 4096)
        else {
            break;
        };
        if from(span[0].0, 0) + from(before.0, 1) < SPAN_CROSSINGS
            || !few_entries(span[0].0)
            || !few_entries(before.0)
            || written(before.0)
            || span.iter().any(|m| m.0 == before.0)
        {
            break;
        }
        span.insert(0, before);
    }
    while span.len() < pagegen::MAX_SPAN {
        let last = *span.last().unwrap();
        let Some(after) = at(last.1 + 4096)
        else {
            break;
        };
        if from(after.0, 0) + from(last.0, 1) < SPAN_CROSSINGS
            || !few_entries(last.0)
            || !few_entries(after.0)
            || written(after.0)
            || span.iter().any(|m| m.0 == after.0)
        {
            break;
        }
        span.push(after);
    }
    span
}
/// compile_mode is compiling its page alone after a span failed (P7.3b)
static mut SPAN_DECLINED: bool = false;
/// Undo compile_mode's count of a compile that it repeats (P7.3b)
fn r_page_uncount(page: u32, hot: bool) {
    if !hot {
        let state = rt().pages.entry(page).or_default();
        state.compiles = state.compiles.saturating_sub(1);
    }
}
/// Before a span's function runs (P7.3b): its prologue finds the page it
/// was entered at by that page's 32-bit TLB entry, which code_page does not
/// fill when its own cache hits
unsafe fn span_translation(rip: u64) {
    if cpu::tlb_data[(rip >> 12) as usize & 0xFFFFF] & cpu::TLB_VALID == 0 {
        legacy_translate(rip as u32, false);
    }
}

/// Compatibility-mode code in the page tier (the JIT switch
/// x64_page_compat32, P7.2; on since M9, which passed its D gate: P7.4):
/// 32-bit code under a 64-bit OS, while its data and stack segments are flat
/// (compat_runnable)
static mut COMPAT32: bool = true;
/// COMPAT32 && PAGE32_TIER0
static mut COMPAT_ACTIVE: bool = false;
#[no_mangle]
pub unsafe fn x64_page_set_compat32(enabled: bool) {
    COMPAT32 = enabled;
    COMPAT_ACTIVE = COMPAT32 && PAGE32_TIER0;
}
pub unsafe fn compat32() -> bool { COMPAT_ACTIVE }
/// The current code runs in the page tier as 32-bit compatibility-mode
/// code: 32-bit CS, a 32-bit stack, and CS, DS, ES and SS with base 0 (as
/// WOW64's are; FS and GS bases are added at each access). Generated code
/// relies on it; a step that changes it leaves (context).
pub unsafe fn compat_runnable() -> bool {
    COMPAT_ACTIVE
        && state::mode() == state::ExecutionMode::Compatibility32
        && *gp::stack_size_32
        && cpu::has_flat_segmentation()
        && *gp::segment_offsets.add(cpu::ES as usize) == 0
        && !*gp::segment_is_null.add(cpu::ES as usize)
}
/// Legacy protected-mode code in the page tier (the JIT switch
/// x64_page_legacy32, P7.3), as 32-bit compatibility-mode code
static mut LEGACY32: bool = true;
/// ir_tier0 (set_page32_tier0): the page tier replaced IR Tier-0, the IR's
/// page-granular compiler (deleted in P7.5); configurations without it
/// interpret 32-bit and 16-bit code (they left it to the region tiers until
/// M11 deleted them)
static mut PAGE32_TIER0: bool = false;
pub unsafe fn page32_tier0() -> bool { PAGE32_TIER0 }
/// LEGACY32 && PAGE32_TIER0
static mut LEGACY_ACTIVE: bool = false;
#[no_mangle]
pub unsafe fn x64_page_set_legacy32(enabled: bool) {
    LEGACY32 = enabled;
    LEGACY_ACTIVE = LEGACY32 && PAGE32_TIER0;
}
/// 16-bit protected-mode code in the page tier (the JIT switch
/// x64_page_prot16, P7.7): Windows 3.x and 9x's 16-bit code
static mut PROT16: bool = true;
/// PROT16 && PAGE32_TIER0
static mut PROT16_ACTIVE: bool = false;
#[no_mangle]
pub unsafe fn x64_page_set_prot16(enabled: bool) {
    PROT16 = enabled;
    PROT16_ACTIVE = PROT16 && PAGE32_TIER0;
}
/// Real-mode and virtual-8086 code in the page tier (the JIT switch
/// x64_page_v86, P7.8): BIOS, DOS and Windows 98's boot, DOS boxes
static mut V86: bool = true;
/// V86 && PAGE32_TIER0
static mut V86_ACTIVE: bool = false;
#[no_mangle]
pub unsafe fn x64_page_set_v86(enabled: bool) {
    V86 = enabled;
    V86_ACTIVE = V86 && PAGE32_TIER0;
}
/// (crate::jit::jit_set_page32, the JIT switch ir_tier0)
pub unsafe fn set_page32_tier0(enabled: bool) {
    PAGE32_TIER0 = enabled;
    LEGACY_ACTIVE = LEGACY32 && PAGE32_TIER0;
    COMPAT_ACTIVE = COMPAT32 && PAGE32_TIER0;
    PROT16_ACTIVE = PROT16 && PAGE32_TIER0;
    V86_ACTIVE = V86 && PAGE32_TIER0;
}
/// Whether a switch hands 32-bit (or 16-bit) code to the page tier (read
/// once a slice)
pub unsafe fn page32() -> bool { COMPAT_ACTIVE || LEGACY_ACTIVE || PROT16_ACTIVE || V86_ACTIVE }
/// The current instruction's linear address, on which the page tier works:
/// RIP in long mode, else CS's base plus EIP (the same with a flat CS, as
/// 32-bit code runs here; 16-bit code's CS has a base, P7.7)
#[inline(always)]
unsafe fn linear_rip() -> u64 {
    if state::mode().is_long() {
        state::read_rip()
    }
    else {
        *gp::instruction_pointer as u32 as u64
    }
}
/// Misses of a 16-bit function compiled under another CS base before its
/// page compiles for the current one (P7.7)
const PROT16_REBASE: u32 = 64;
/// The IP of the first byte of `rip`'s page under the current CS (P7.7)
unsafe fn ip_base_of(rip: u64) -> i32 {
    ((rip & !4095) as u32).wrapping_sub(*gp::segment_offsets.add(cpu::CS as usize) as u32) as i32
}
/// The current code runs in the page tier as 16-bit protected-mode code
/// (P7.7): a 16-bit CS and a 16-bit stack, compiled for segment bases as
/// segmented_runnable (CS's base too: near branches compute IPs in it,
/// pagegen::CompileEnv::ip_base). Data segment limits are not checked, as
/// the interpreter does not.
pub unsafe fn prot16_runnable() -> bool {
    PROT16_ACTIVE
        && state::mode() == state::ExecutionMode::Protected16
        && !*gp::stack_size_32
        && !crate::cpu::smm::smm_active()
}
/// The current code runs in the page tier as real-mode code (P7.8): as
/// prot16_runnable, segment bases the selectors shifted left by 4 (segment
/// loads cannot fault, cpu::switch_seg_without_fault). No A20 wrap: the
/// interpreter has none either. Not in SMM (16-bit code there runs at
/// SMBASE + 0x8000 in SMRAM, which the VGA window hides outside SMM; with
/// the page tier, tests/devices/smm.js failed 11 of 25: the core never left
/// SMM), as prot16_runnable
pub unsafe fn real_runnable() -> bool {
    V86_ACTIVE
        && state::mode() == state::ExecutionMode::Real
        && !*gp::stack_size_32
        && !crate::cpu::smm::smm_active()
}
/// The current code runs in the page tier as virtual-8086 code (P7.8): as
/// real_runnable at CPL 3; the instructions IOPL governs there (PUSHF,
/// POPF, INT n, IRET; CLI and STI check CPL <= IOPL as in protected mode)
/// step, as port I/O does everywhere
pub unsafe fn v86_runnable() -> bool {
    V86_ACTIVE && state::mode() == state::ExecutionMode::Vm86 && !*gp::stack_size_32
}
/// The current code runs in the page tier as 32-bit legacy protected-mode
/// code: as compat_runnable, and with FS not null (its base is added at each
/// access; GS's accesses step, see pagegen Decoder::legacy), paged or not
pub unsafe fn legacy_runnable() -> bool {
    LEGACY_ACTIVE
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
    LEGACY_ACTIVE
        && state::mode() == state::ExecutionMode::Protected32
        && *gp::stack_size_32
        && *gp::segment_offsets.add(cpu::CS as usize) == 0
}
/// The current code runs in the page tier as 32-bit code compiled for
/// segment bases on a 16-bit stack (M11): segmented_runnable but SS.B
/// clear. Windows 98's 16-to-32-bit thunks (2.8% of Diablo's time, 1.4% of
/// Red Alert 2's, left to the region tiers in M10)
pub unsafe fn segmented_ss16_runnable() -> bool {
    LEGACY_ACTIVE
        && state::mode() == state::ExecutionMode::Protected32
        && !*gp::stack_size_32
        && *gp::segment_offsets.add(cpu::CS as usize) == 0
}
/// The current code runs in the page tier as 16-bit protected-mode code on
/// a 32-bit stack (M11): prot16_runnable but SS.B set
pub unsafe fn prot16_ss32_runnable() -> bool {
    PROT16_ACTIVE
        && state::mode() == state::ExecutionMode::Protected16
        && *gp::stack_size_32
        && !crate::cpu::smm::smm_active()
}
/// compat_runnable, legacy_runnable, segmented_runnable, prot16_runnable,
/// real_runnable, v86_runnable, prot16_ss32_runnable or
/// segmented_ss16_runnable
pub unsafe fn runnable32() -> bool { runnable_kind() != 0 }
/// 1 for compat_runnable or legacy_runnable (flat segments), 2 for
/// segmented_runnable only, 3 for prot16_runnable, 4 for real_runnable, 5
/// for v86_runnable, 6 for prot16_ss32_runnable, 7 for
/// segmented_ss16_runnable, else 0: a step that changes it leaves (context;
/// in a function compiled for segment bases, which runs flat segments too,
/// only a change to or from 0)
#[inline(always)]
unsafe fn runnable_kind() -> u8 { kind_of(state::mode()) }
/// runnable_kind for the current state in `mode`: the predicates above with
/// the mode computed once (each computed it; with 7 kinds that cost Theme
/// Hospital 1.5%, M11)
#[inline(always)]
unsafe fn kind_of(mode: state::ExecutionMode) -> u8 {
    use state::ExecutionMode::*;
    let cs_flat = *gp::segment_offsets.add(cpu::CS as usize) == 0;
    let es_flat = || {
        cpu::has_flat_segmentation()
            && *gp::segment_offsets.add(cpu::ES as usize) == 0
            && !*gp::segment_is_null.add(cpu::ES as usize)
    };
    let stack32 = *gp::stack_size_32;
    match mode {
        Protected32 if LEGACY_ACTIVE => {
            if !stack32 {
                if cs_flat {
                    7
                }
                else {
                    0
                }
            }
            else if es_flat() && !*gp::segment_is_null.add(cpu::FS as usize) {
                1
            }
            else if cs_flat {
                2
            }
            else {
                0
            }
        },
        Compatibility32 if COMPAT_ACTIVE && stack32 && es_flat() => 1,
        Protected16 if PROT16_ACTIVE && !crate::cpu::smm::smm_active() => {
            if stack32 {
                6
            }
            else {
                3
            }
        },
        Real if V86_ACTIVE && !stack32 && !crate::cpu::smm::smm_active() => 4,
        Vm86 if V86_ACTIVE && !stack32 => 5,
        _ => 0,
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
    r.release_dead(|slot, id| {
        crate::jit::release_page_slot(slot, id);
    });
    (*(&raw mut HOT_FREE)).extend(r.x.released_counters.drain(..));
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
    let rip = linear_rip();
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
    let last = r.x.last_rip;
    // (P7.3b: entered from a neighbouring page, the evidence a span takes)
    let here = rip >> 12;
    if CLUSTERS && mode >= MODE_COMPAT && r.x.last_page != here {
        let side = if r.x.last_page.wrapping_add(1) == here {
            Some(0)
        }
        else if r.x.last_page == here.wrapping_add(1) {
            Some(1)
        }
        else {
            None
        };
        if let Some(side) = side {
            let count = &mut r.pages.entry(page).or_default().x.from[side];
            *count = count.saturating_add(1);
        }
    }
    r.x.last_page = here;
    r.x.last_rip = rip;
    // Far transfers (not the next few bytes) start blocks.
    // (and the first instruction a page is entered at from the page before:
    // straight-line code over pages would else step through each page after
    // the first, as no entry of its function, up to its next block start)
    let far = !(last < rip && rip - last <= 15) || last >> 12 != rip >> 12;
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
    let member = index.and_then(|i| r.functions[i].member(page));
    match index {
        Some(i)
            if member.is_some()
                && r.functions[i].phase == Phase::Ready
                && r.functions[i].serves(member.unwrap(), offset) =>
        {
            // (its code ran often: its recompile with inline lookups)
            if r.functions[i].x.counter.is_some_and(|c| {
                HOT_COUNTS[c as usize] >= if compat { COMPAT_HOT_COUNT } else { HOT_COUNT }
            }) {
                r.stats[HOT_RECOMPILES] += 1;
                return compile_mode(page, true);
            }
            // (P7.7: 16-bit code compiled under a CS of another base, whose
            // prologue would leave at once: the page compiles for this one
            // once that recurs)
            if code16(mode) && r.functions[i].x.ip_base != ip_base_of(rip) {
                step_profile::note_event(event::MISS, event::MISS_UNSERVED);
                let state = r.pages.entry(page).or_default();
                state.misses += 1;
                if state.misses >= PROT16_REBASE {
                    state.misses = 0;
                    return compile(page);
                }
                return miss();
            }
            r.clock += 1;
            r.functions[i].last_used = r.clock;
            let slot = r.functions[i].slot;
            if CHAINING {
                chain_fill(apic::current_core(), *gp::cpl == 3, mode, rip, slot, global);
            }
            if r.functions[i].members.len() > 1 {
                span_translation(rip);
            }
            execute(slot, budget, rip)
        },
        Some(i) if member.is_some() && r.functions[i].phase != Phase::Dead => {
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
                    return unserved_run(r, i, member.unwrap(), budget, rip);
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
                if r.functions[i].members.len() > 1 {
                    span_translation(rip);
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
            // (32-bit code's first compile waits for LEGACY_HEAT, which also
            // gathers the page crossings spans take (P7.3b; compatibility
            // mode since M9: compiled at HOT, its pages chained before any
            // crossing reached run); a page compiled before is hot, its
            // function retired by a write. 16-bit code, P7.7, P7.8: every
            // compile waits for LEGACY_HEAT, as DOS and the BIOS write their
            // code pages (a Windows 98 boot: 330 compiles after writes of
            // real-mode and virtual-8086 pages at HOT, 150 at LEGACY_HEAT)
            let hot = if code16(mode) || mode >= MODE_COMPAT && state.compiles == 0 {
                LEGACY_HEAT
            }
            else {
                HOT
            };
            // (instructions a write changed are volatile now: the page's
            // function would stay as they change again, no compile of its
            // own, dirty_bytes)
            if state.x.volatile_new {
                state.x.volatile_new = false;
                state.compiles = state.compiles.saturating_sub(1);
                state.heat = hot << backoff(state.compiles);
            }
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

/// Interpreted execution's heat, batched (jitrt::heat::HeatBatch, P4.5b)
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
    // (16-bit code, P7.8: a basic block at a time, as the interpreter runs
    // code without compiled code; one instruction at a time cost a Windows
    // 98 boot, whose real-mode and virtual-8086 code is mostly cold, 3%)
    let blocks = matches!(kind, 3..=6);
    loop {
        crate::x64::extended::safe_point();
        let ran = if blocks {
            cpu::run_interpreted_block(limit - n)
        }
        else {
            *gp::previous_ip = *gp::instruction_pointer;
            interpret_one();
            1
        };
        n += ran;
        // (where the last instruction started)
        let last = if blocks { *gp::previous_ip as u32 as u64 } else { at };
        let next = linear_rip();
        if blocks && (ran == 0 || last >> 12 != linear) {
            break;
        }
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
        if !(last < next && next - last <= 15) {
            note_entry(r, page, (next & 4095) as u16);
        }
        at = next;
        if HEAT_BATCH.holds(page, r.generation) {
            HEAT_BATCH.count += ran;
        }
        else {
            r.pages.entry(page).or_default().heat += ran;
        }
    }
    // (the next miss compares its RIP with the last instruction run here)
    r.x.last_rip = at;
    r.x.last_page = if *gp::in_hlt { u64::MAX } else { at >> 12 };
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
unsafe fn unserved_run(r: &mut Runtime, i: usize, m: usize, budget: u32, rip: u64) -> Attempt {
    let (linear, cpl, mode, kind) = (rip >> 12, *gp::cpl, state::mode(), runnable_kind());
    let limit = budget.min(MISS_RUN_LIMIT);
    let span = execution::ledger_begin();
    let (mut n, mut at) = (0, rip);
    loop {
        crate::x64::extended::safe_point();
        *gp::previous_ip = *gp::instruction_pointer;
        interpret_one();
        n += 1;
        let next = linear_rip();
        if n >= limit
            || next >> 12 != linear
            || !(at < next && next - at <= 15)
            || r.functions[i].serves(m, (next & 4095) as u16)
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
    r.x.last_rip = at;
    r.x.last_page = if *gp::in_hlt { u64::MAX } else { at >> 12 };
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
    let far =
        !(LAST_UNSERVED < rip && rip - LAST_UNSERVED <= 15) || LAST_UNSERVED >> 12 != rip >> 12;
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
    SEGMENTED_ACTIVE = mode >= MODE_SEGMENTED;
    *gp::x64_page_chain = 0;
    *gp::x64_page_lazy_kind = 0;
    // Generated code keeps EFLAGS materialized.
    if *gp::flags_changed != 0 {
        let flags = state::read_flags64();
        state::write_flags64(flags);
    }
    let interrupts_before = *gp::flags & cpu::FLAG_INTERRUPT;
    ACTIVE = true;
    IN_ACTIVATION = true;
    COUNTERS[COUNT_ACTIVATIONS] += 1;
    STEP_EXITED = false;
    let t_call = if TIMING { time::microtick() } else { 0.0 };
    // (the performance recorder's JIT chunks, as the IR cache's activations)
    let sample = crate::profiler::performance_recording_enabled().then(|| {
        crate::profiler::performance_chunk_start(true, rip as u32, *gp::cr.add(3) as u32, *gp::cpl)
    });
    let native = call_indirect1_ret(
        (slot + cpu::WASM_TABLE_OFFSET) as i32,
        budget.min(u16::MAX as u32) as u16,
    ) as u32;
    if TIMING {
        TIME_IN_CALLS += time::microtick() - t_call;
    }
    ACTIVE = false;
    IN_ACTIVATION = false;
    // (functions this activation tail-called from)
    let native = native.wrapping_add(*gp::x64_page_chain);
    // (REP elements legacy-mode functions ran, pagegen Emitter::note_rep:
    // the core's statistics count them as the interpreter's)
    if *gp::x64_page_rep_elements != 0 {
        execution::note_jit_rep(*gp::x64_page_rep_elements);
        *gp::x64_page_rep_elements = 0;
    }
    if let Some(sample) = sample {
        crate::profiler::performance_chunk_finish(sample, native);
        crate::profiler::performance_recording_add(1, native as u64);
    }
    *gp::instruction_counter = (*gp::instruction_counter).wrapping_add(native);
    execution::note_native_retired(native);
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
    r.x.last_rip = linear_rip();
    // (no evidence for span_members across a halt or an interrupt)
    r.x.last_page = if *gp::in_hlt { u64::MAX } else { *gp::x64_page_linear >> 12 };
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
    // (P7.3: legacy-mode code polls for interrupts only where one can have
    // become deliverable: an interpreted instruction, IF set by STI, a held
    // interrupt, events of other cores, NMI, SMI or HLT. Devices raise
    // theirs through handle_irqs, and native code does no device access: a
    // poll after each of XP's activations cost 2% of its boot)
    if mode < MODE_LEGACY
        || exit == pagegen::EXIT_RETRY
        || STEP_EXITED
        || *gp::flags & cpu::FLAG_INTERRUPT & !interrupts_before != 0
        || *gp::in_hlt
        || apic::has_core_events()
        || apic::nmi_pending()
        || crate::cpu::smm::smi_deliverable()
    {
        let rip = linear_rip();
        cpu::handle_irqs();
        if linear_rip() != rip {
            rt().x.last_page = u64::MAX;
        }
    }
    Attempt {
        retired: (*gp::instruction_counter).wrapping_sub(before),
        submitted: false,
    }
}

unsafe fn compile(page: u32) -> Attempt { compile_mode(page, false) }
/// compile(page), or with `hot` its recompile with inline access lookups
/// (P4.14), which is no compile of its own: no backoff
unsafe fn compile_mode(page: u32, hot: bool) -> Attempt {
    // (the performance recorder's synchronous code generation, up to the
    // publication of a function: src/browser/performance_recorder.js)
    let started = crate::profiler::performance_codegen_start();
    let r = rt();
    let state = r.pages.entry(page).or_default();
    if hot {
        state.x.hot = true;
    }
    else {
        state.compiles += 1;
    }
    let recompile = state.compiles > 1 || hot;
    // (P7.2: a 32-bit function's key, of the same page; P7.3: legacy mode's)
    let (compat, physical) = (page & COMPAT_KEY != 0, physical_key(page));
    let legacy = page & LEGACY_KEY != 0;
    let segmented = page & SEGMENTED_KEY != 0;
    let prot16 = page & PROT16_KEY != 0;
    // (M11: a stack of the other width than the code's)
    let stack16 = prot16 != (page & STACK_KEY != 0);
    // (P7.8: real-mode and virtual-8086 code, 16-bit code too)
    let mode16 = if page & REAL_KEY != 0 {
        pagegen::Mode16::Real
    }
    else if page & V86_KEY != 0 {
        pagegen::Mode16::V86
    }
    else {
        pagegen::Mode16::Protected
    };
    // (legacy mode's lookups are inline either way, in the 32-bit TLB: no
    // cold compile and hot recompile, which would start V8's tier-up anew;
    // loops from the first compile)
    let outline = pagegen::outline_access() && !state.x.hot && !legacy;
    let counter = if outline && HOT_INLINE { take_counter() } else { None };
    // (named after the linear page it was compiled for: host profiles)
    let linear = linear_rip() & !4095;
    // (P7.3b: with x64_page_clusters, the consecutive pages of a span of
    // 32-bit code, `page` among them, legacy mode and since M9 compatibility
    // mode; else just `page`)
    // (16-bit protected-mode code: pages alone, P7.7)
    let span: Vec<(u32, u64, u32)> = if compat && !prot16 && CLUSTERS && !hot && !SPAN_DECLINED {
        span_members(r, page, linear)
    }
    else {
        vec![(page, linear, 0)]
    };
    let (first, linear) = (span[0].0, span[0].1);
    // (a recompile serves the unserved offsets seen once so far too: each
    // would otherwise count towards the next recompile)
    let mut entries: Vec<u16> = Vec::new();
    for (m, &(key, ..)) in span.iter().enumerate() {
        let Some(state) = r.pages.get(&key)
        else {
            continue;
        };
        let recompile = key == page && recompile || state.compiles != 0;
        entries.extend(
            (0..4096u16)
                .filter(|&o| bit(&state.entries, o) || recompile && bit(&state.seen, o))
                .map(|o| (m * 4096) as u16 + o),
        );
    }
    let bytes = if is_extended(page) {
        extended::copy_page(physical - extended::CODE_KEY_BASE)
    }
    else {
        let mut bytes = Vec::with_capacity(4096 * span.len());
        for &(key, ..) in &span {
            bytes.extend_from_slice(std::slice::from_raw_parts(
                crate::cpu::memory::mem8.add((physical_key(key) << 12) as usize),
                4096,
            ));
        }
        bytes
    };
    // Likely function starts: 16-byte aligned after INT3 padding (MSVC x64
    // code). Serving them from the first compile avoids most recompiles for
    // entries that other pages call later. (Guesses: an instruction's last
    // byte may be 0xCC, as MULSD XMM1, XMM4's ModRM; pagegen drops those
    // that code runs into, which would split its block)
    for m in 0..span.len() {
        for o in (16..4096usize).step_by(16) {
            let at = m * 4096 + o;
            if bytes[at - 1] == 0xCC && bytes[at] != 0xCC && !entries.contains(&(at as u16)) {
                entries.push(at as u16 | pagegen::GUESSED);
            }
        }
    }
    // (P7.3: the instructions writes changed, of a 32-bit page compiled
    // alone: their immediates load from its host)
    let volatile: Vec<u16> = if compat && span.len() == 1 && !is_extended(page) {
        r.pages
            .get(&page)
            .map_or(Vec::new(), |s| s.x.volatile.clone())
    }
    else {
        Vec::new()
    };
    // (P7.3b: each page's host address as compiled, which the span's
    // prologue compares with the 32-bit TLB's)
    let hosts: Vec<u32> = if span.len() > 1 {
        span.iter()
            .map(|&(.., physical)| (crate::cpu::memory::mem8 as u32).wrapping_add(physical))
            .collect()
    }
    else if !volatile.is_empty() {
        vec![(crate::cpu::memory::mem8 as u32).wrapping_add(physical << 12)]
    }
    else {
        Vec::new()
    };
    // (P7.7: the IP of the page's first byte under the current CS, which
    // the function requires)
    let ip_base = if prot16 { ip_base_of(linear) } else { 0 };
    let name = format!(
        "x64_page{}_{:x}",
        if prot16 {
            match (mode16, stack16) {
                (pagegen::Mode16::Protected, false) => "16ss32",
                (pagegen::Mode16::Protected, true) => "16",
                (pagegen::Mode16::Real, _) => "r16",
                (pagegen::Mode16::V86, _) => "v16",
            }
        }
        else if segmented && stack16 {
            "s32ss16"
        }
        else if segmented {
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
    let next = next_page_bytes(span.last().unwrap().1);
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
        prot16.then_some((ip_base, mode16)),
        stack16,
        &hosts,
        &volatile,
        name,
    )
    else {
        (*(&raw mut HOT_FREE)).extend(counter);
        if span.len() > 1 {
            // (more code than a function takes: the page alone, P7.3b)
            r_page_uncount(page, hot);
            SPAN_DECLINED = true;
            let attempt = compile_mode(page, hot);
            SPAN_DECLINED = false;
            return attempt;
        }
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
    let live = r.live();
    // (the slot budget, jitrt::capacity: this client's quota is
    // MAX_FUNCTIONS; an eviction another client asked of it is done here,
    // at its cold point)
    let must_evict = {
        let rt = crate::jitrt::state();
        let free = rt.table.free_count();
        capacity::must_evict(ClientId::X86Page, live, free, |c| {
            rt.table.owned_by(c) as u32
        })
    };
    if capacity::take_request(ClientId::X86Page) || must_evict {
        if let Some(i) = eviction_victim(r, compat) {
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
        span.iter()
            .map(|&(key, ..)| Page::page_of(physical_key(key) << 12))
            .collect()
    };
    let Some(slot) = crate::jit::reserve_page_slot(id, watched)
    else {
        (*(&raw mut HOT_FREE)).extend(counter);
        rt().stats[FAILED] += 1;
        return miss();
    };
    let r = rt();
    for &(key, ..) in &span {
        if let Some(&old) = r.by_page.get(&key) {
            retire(r, old);
        }
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
                served: Vec::new(),
                members: Vec::new(),
                last_used: 0,
                x: X86Code::default(),
            });
            r.functions.len() - 1
        },
    };
    r.clock += 1;
    r.functions[index] = Function {
        page: first,
        id,
        slot,
        phase: Phase::Pending,
        served: code.served,
        members: span.iter().map(|&(key, ..)| key).collect(),
        last_used: r.clock,
        x: X86Code {
            code: code.code,
            starts: code.starts,
            dynamic: code.dynamic,
            source: source_hash(&bytes),
            counter,
            native_at: r.stats[RETIRED],
            ip_base,
        },
    };
    for &(key, ..) in &span {
        r.by_page.insert(key, index);
        FAST[fast_slot(key)] = (key, index as u32 + 1);
    }
    r.generation = r.generation.wrapping_add(1);
    r.stats[COMPILED] += 1;
    if legacy {
        COUNTERS[COUNT_LEGACY_COMPILES] += 1;
    }
    if prot16 && mode16 == pagegen::Mode16::Protected {
        COUNTERS[COUNT_PROT16_COMPILES] += 1;
    }
    else if prot16 {
        COUNTERS[COUNT_V86_COMPILES] += 1;
    }
    if span.len() > 1 {
        COUNTERS[COUNT_SPANS] += 1;
        COUNTERS[COUNT_SPAN_PAGES] += span.len() as u64;
    }
    else if compat {
        COUNTERS[COUNT_COMPAT_COMPILES] += 1;
    }
    unsafe { BYTES_COMPILED += code.bytes.len() as u64 };
    r.stats[INSTRUCTIONS] += code.instructions as u64;
    r.stats[TEMPLATED] += code.templated as u64;
    crate::profiler::performance_codegen_finish(started);
    // The host installs it synchronously when it can (x64_page_install).
    publish::publish(ClientId::X86Page, id, slot, &code.bytes);
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
    // (jitrt's: Dead, a new generation, the slot released at the next cold point)
    if !r.kill(index) {
        return;
    }
    let f = &mut r.functions[index];
    let (page, slot) = (f.page, f.slot);
    r.x.released_counters.extend(f.x.counter.take());
    if unchain {
        unsafe { unchain_slot(slot) };
    }
    // (a span's other pages, P7.3b)
    for m in 1..r.functions[index].members.len() {
        let key = r.functions[index].members[m];
        if r.by_page.get(&key) == Some(&index) {
            r.by_page.remove(&key);
        }
        unsafe {
            if FAST[fast_slot(key)].0 == key {
                FAST[fast_slot(key)] = (0, 0);
            }
        }
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
}

/// Called by the host before table.set: false if the function was retired
/// meanwhile (its source changed, or reset).
#[no_mangle]
pub fn x64_page_install(id: u64, slot: u32) -> bool {
    let r = rt();
    let Some(f) = r.pending(id, slot).map(|i| &r.functions[i])
    else {
        return false;
    };
    if !crate::parallel::active() {
        return true;
    }
    // other cores mark the page first, then its bytes are checked once more
    let (page, source) = (f.page, f.x.source);
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
/// (tests) A ready function serves code of the physical page of `address`,
/// in any code mode
#[no_mangle]
pub fn x64_page_published(address: u32) -> bool {
    let r = rt();
    MODE_KEYS.iter().any(|&mode| {
        r.by_page
            .get(&(address >> 12 | mode))
            .is_some_and(|&i| r.functions[i].phase == Phase::Ready)
    })
}
#[no_mangle]
pub fn x64_page_ready(id: u64, slot: u32) -> bool {
    if rt().ready(id, slot).is_none() {
        return false;
    }
    if unsafe { TIMING } {
        unsafe { time_first_call(slot) };
    }
    true
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
    *gp::x64_page_linear = linear_rip() & !4095;
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
    if let Some(i) = r.alive(id, slot) {
        retire(r, i);
        r.stats[FAILED] += 1;
    }
    unsafe { release_dead(r) };
}

/// A write to a watched backing page (see jit::jit_dirty_page), or to an
/// extended page with code (key from extended::CODE_KEY_BASE on).
pub fn dirty_page(page: u32) { retire_written(page, &[]); }
/// A write of bytes `lo..hi` of backing page `page` (jit::jit_dirty_bytes):
/// as dirty_page, but a legacy-mode function stays when the write changes
/// bytes of its volatile instructions, which it reads where it runs, and
/// none of its other instructions' (P7.3: 709.smc). Not for writes of data
/// next to code: the page stays watched while it has a function, and each
/// such write from compiled code would be retried in the interpreter
/// (Red Alert 2 under Windows 98: 2.6 million in 30 s, 0.8x Tier-0); after a
/// retire it is not watched until the page compiles again. The slots of
/// the functions that stay, which jit.rs keeps watching.
pub fn dirty_bytes(page: u32, lo: u32, hi: u32) -> Vec<u32> {
    let r = rt();
    let mut kept = Vec::new();
    if !crate::parallel::active() {
        for mode in MODE_KEYS {
            let key = page | mode;
            let Some(&i) = r.by_page.get(&key)
            else {
                continue;
            };
            let f = &r.functions[i];
            let Some(m) = f.member(key)
            else {
                continue;
            };
            let base = (m * 4096) as u16;
            let range = lo..hi.min(4096);
            if f.page & COMPAT_KEY != 0
                && f.phase != Phase::Dead
                && !range.clone().any(|o| bit(&f.x.code, base + o as u16))
                && range.clone().any(|o| bit(&f.x.dynamic, base + o as u16))
            {
                kept.push(i);
            }
        }
    }
    // (the instructions a write hits are volatile in their page's next
    // compiles, which it then keeps: 709.smc rewrites an immediate every
    // 64 calls, and its page would stay interpreted)
    for mode in MODE_KEYS {
        let key = page | mode;
        let Some(&i) = r.by_page.get(&key)
        else {
            continue;
        };
        let f = &r.functions[i];
        let Some(m) = f.member(key)
        else {
            continue;
        };
        if kept.contains(&i) || f.page & COMPAT_KEY == 0 || f.phase == Phase::Dead {
            continue;
        }
        let base = (m * 4096) as u16;
        let hit: Vec<u16> = (lo..hi.min(4096))
            .filter(|&o| bit(&f.x.code, base + o as u16))
            .filter_map(|o| {
                (0..=o)
                    .rev()
                    .take(15)
                    .find(|&s| bit(&f.x.starts, base + s as u16))
            })
            .map(|s| s as u16)
            .collect();
        let state = r.pages.entry(key).or_default();
        for s in hit {
            if !state.x.volatile.contains(&s) && state.x.volatile.len() < pagegen::MAX_VOLATILE {
                state.x.volatile.push(s);
                state.x.volatile_new = true;
            }
        }
    }
    retire_written(page, &kept);
    kept.iter().map(|&i| r.functions[i].slot).collect()
}
/// dirty_page, but for the functions `kept` (indices)
fn retire_written(page: u32, kept: &[usize]) {
    let r = rt();
    // (the page's functions in every code mode, P7.2, P7.3)
    let dead: Vec<usize> = MODE_KEYS
        .iter()
        .filter_map(|&mode| r.by_page.get(&(page | mode)).copied())
        .filter(|i| !kept.contains(i))
        .collect();
    if dead.is_empty() {
        return;
    }
    unsafe {
        CODE_WRITES += 1;
    }
    // (no span takes a page code writes retire, P7.3b: 709.smc's callee
    // would retire its caller's page with it)
    for key in MODE_KEYS {
        if let Some(state) = r.pages.get_mut(&(page | key)) {
            state.x.written = true;
        }
    }
    for i in dead {
        // (legacy mode, P7.3: a function that ran long before its page was
        // written costs no backoff: the VMM's pages under Windows 98 hold
        // data written twice a second, and backed-off pages stay
        // interpreted; a page rewritten while its code runs, as 709.smc's,
        // still backs off)
        let f = &r.functions[i];
        if f.page & COMPAT_KEY != 0 && r.stats[RETIRED].wrapping_sub(f.x.native_at) >= LIVED {
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
        CODE_TLB = [[(0, 0, 0, false); CODE_TLB_SIZE]; 8];
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
    r.x.last_rip = 0;
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
            "x64_page_prot16" => PROT16 as u32,
            "x64_page_v86" => V86 as u32,
            "x64_page_clusters" => CLUSTERS as u32,
            "x64_span_crossings" => SPAN_CROSSINGS,
            "x64_span_entries" => SPAN_ENTRIES,
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
        f @ 38..=39 => unsafe { COUNTERS[f as usize - 38 + COUNT_SPANS] as f64 },
        // (legacy-mode code runs here: x64_page_legacy32 and ir_tier0)
        40 => unsafe { LEGACY_ACTIVE as u32 as f64 },
        // (compatibility-mode code runs here: x64_page_compat32 and ir_tier0)
        41 => unsafe { COMPAT_ACTIVE as u32 as f64 },
        // (16-bit protected-mode code runs here: x64_page_prot16 and
        // ir_tier0; its compiles)
        42 => unsafe { PROT16_ACTIVE as u32 as f64 },
        43 => unsafe { COUNTERS[COUNT_PROT16_COMPILES] as f64 },
        // (real-mode and virtual-8086 code runs here: x64_page_v86 and
        // ir_tier0; its compiles)
        44 => unsafe { V86_ACTIVE as u32 as f64 },
        45 => unsafe { COUNTERS[COUNT_V86_COMPILES] as f64 },
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

#[derive(PartialEq, Clone, Copy)]
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
/// Steps and retries since x64_page_steps_reset by their first two bytes
/// (step_profile::pair_count); the reset turns the step profile on
#[no_mangle]
pub unsafe fn x64_page_steps(pair: u32) -> u32 { step_profile::pair_count(pair) }
#[no_mangle]
pub unsafe fn x64_page_steps_reset() { x64_page_profile(true) }
/// The counts of x64_page_steps stay as they are until the next reset (the
/// ISA tests: a hot run's, not the cold run's after it)
#[no_mangle]
pub unsafe fn x64_page_steps_freeze() { step_profile::freeze_pairs() }
/// With the step profile: stepped instructions by RIP (x64_page_step_rips)
static mut STEP_RIPS: Option<HashMap<u64, u32>> = None;
unsafe fn profile_step() {
    if !step_profile::enabled() {
        return;
    }
    let rips = (*(&raw mut STEP_RIPS)).get_or_insert_with(HashMap::new);
    if rips.len() < 1 << 16 {
        *rips.entry(linear_rip()).or_default() += 1;
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
    let rip = linear_rip();
    let mut bytes = [0u8; 15];
    let mut n = 0;
    if state::efer() & state::EFER_LMA == 0 {
        // (legacy mode, P7.3)
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
    let key = step_profile::x86_key(
        &bytes[..n],
        state::mode(),
        step_profile::Stepper::X64Page,
        retry,
    );
    step_profile::note_sampled(key, rip as u32, &bytes[..n]);
}

/// The x86 page tier's step frontend (jitrt::step, P5.6): the execution
/// context and CODE_WRITES before the step; the wide interpreter, with the
/// mode ledger's accounting; step_result's outcome
struct X86Step;
impl StepFrontend for X86Step {
    type Context = (Context, u64);
    #[inline(always)]
    fn context() -> (Context, u64) { unsafe { (context(), CODE_WRITES) } }
    #[inline(always)]
    fn interpret_one() {
        unsafe {
            ACTIVE = false;
            let span = execution::ledger_begin();
            interpret_one();
            execution::ledger_end(span, execution::Way::PageStep);
            ACTIVE = true;
            let flags = state::read_flags64();
            state::write_flags64(flags);
        }
    }
    #[inline(always)]
    fn outcome(before: &(Context, u64)) -> StepOutcome {
        unsafe { step_result(&before.0, before.1) }
    }
}

#[no_mangle]
pub unsafe fn x64_page_step() -> i32 {
    STEPS += 1;
    profile_step();
    step::step::<X86Step>() as i32
}

/// After an instruction the interpreter (x64_page_step) or a helper
/// (x64_page_far) ran for a page function, whose context was `before` and
/// CODE_WRITES `writes`
unsafe fn step_result(before: &Context, writes: u64) -> StepOutcome {
    let before = *before;
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
        // (code compiled for segment bases, 16-bit code among it, P7.7,
        // P7.8: a far call or return to code of the same privilege continues
        // through the chaining table; M11: also to code of another such
        // mode, as Windows 98's thunks between 16-bit code and 32-bit code
        // on a 16-bit stack, through that mode's table, unless the mode
        // ledger, which books an activation to the mode it started in, is on)
        if CHAINING
            && before.compat >= 2
            && after.compat >= 2
            && (after.compat == before.compat || !execution::ledger_on())
            && after
                == (Context {
                    cs: after.cs,
                    compat: after.compat,
                    ..before
                })
        {
            if after.compat != before.compat {
                let mode = code_mode();
                *gp::x64_code_base = chain_base(apic::current_core(), *gp::cpl == 3, mode);
                SEGMENTED_ACTIVE = mode >= MODE_SEGMENTED;
            }
            step_profile::note_event(event::STEP_EXIT, event::STEP_EXIT_CHAINABLE);
            return StepOutcome::Chain;
        }
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
        return StepOutcome::Continue;
    };
    STEP_EXITED = true;
    step_profile::note_event(event::STEP_EXIT, exit);
    StepOutcome::Exit
}

/// Whether the last activation ended in a step that left (its exit's reason
/// for the step profile, P4.0)
static mut STEP_EXITED: bool = false;

/// Far CALL ptr16:16 or ptr16:32 and RETF (imm16) for page functions of
/// code compiled for segment bases (M11; 16-bit code's far calls and
/// returns were a tenth of Diablo's instructions, each a step): `op` 0 a
/// call to `selector`:`offset`, 1 a return popping `offset` bytes more,
/// plus the operand size << 8. The state is in memory, EIP the next
/// instruction's, previous_ip this one's. 0: done, continue through the
/// chaining table (x64_page_step's STEP_CHAIN, or STEP_CONTINUE: the same
/// mode); 1: done, leave; 2: a fault was delivered (the instruction counts
/// as retired, as the interpreter counts it).
#[no_mangle]
pub unsafe fn x64_page_far(op: u32, offset: u32, selector: u32) -> i32 {
    let before = context();
    let writes = CODE_WRITES;
    let wide = op >> 8 == 32;
    ACTIVE = false;
    let done = if op & 255 == 0 {
        cpu::far_jump_checked(offset as i32, selector as i32 & 0xFFFF, true, wide)
    }
    else {
        let at = |bytes: i32| crate::cpu::misc_instr::get_stack_pointer(bytes);
        let ip = if wide { cpu::safe_read32s(at(0)) } else { cpu::safe_read16(at(0)) };
        // (RETF32 reads a dword for the selector)
        let cs = if wide { cpu::safe_read32s(at(4)) } else { cpu::safe_read16(at(2)) };
        match (ip, cs) {
            (Ok(ip), Ok(cs)) => cpu::far_return_checked(ip, cs & 0xFFFF, offset as i32, wide),
            _ => false,
        }
    };
    ACTIVE = true;
    if !done {
        return 2;
    }
    let flags = state::read_flags64();
    state::write_flags64(flags);
    match step_result(&before, writes) {
        StepOutcome::Exit => 1,
        _ => 0,
    }
}

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
/// With pagegen::RECORD_UNIT (an INC or DEC in legacy mode) `a` is the
/// result.
#[no_mangle]
pub fn x64_page_flags(record: u32, a: u64, b: u64, flags: u32) -> u32 {
    let code = (record >> 16 & 7) as u8;
    let width = 8u8 << (record >> 20 & 3);
    let carry = (record >> 23 & 1) as u64;
    let pending = record & 0x8D5;
    // (an INC or DEC whose `a` is the result: M8, pagegen::RECORD_UNIT)
    let (a, b) = if record & pagegen::RECORD_UNIT != 0 {
        let mask = if width == 64 { !0 } else { (1u64 << width) - 1 };
        (
            if code == 5 { a.wrapping_add(1) } else { a.wrapping_sub(1) } & mask,
            1,
        )
    }
    else {
        (a, b)
    };
    let (_, computed) = super::execute::alu(code, a, b, width, carry);
    flags & !pending | computed as u32 & pending
}

/// FLDCW for generated code in legacy mode, the word read (M8): as
/// fpu::fpu_fldcw, which leaves the x87 stack and its cache as they are
#[no_mangle]
pub unsafe fn x64_page_fldcw(word: i32) { crate::cpu::fpu::set_control_word(word as u16); }

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

/// PCMPESTRx/PCMPISTRx for generated code (x64::helpers::pcmpstr on
/// its operand block): the lengths RAX/RDX, or EAX/EDX sign-extended
#[no_mangle]
pub unsafe fn x64_page_pcmpstr(op: u32, imm8: u32, a: i64, b: i64) -> u32 {
    super::helpers::pcmpstr(op, imm8, a, b)
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
    // (a function compiled for segment bases runs flat segments too; 16-bit
    // code, P7.7, P7.8, any)
    if legacy_runnable() || segmented != 0 && runnable_kind() >= 2 {
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
            served: vec![0; 64],
            members: vec![page],
            last_used,
            x: X86Code::default(),
        }
    }
    fn runtime(functions: Vec<Function>) -> Runtime {
        let mut r = Runtime::new(X86Extra {
            released_counters: Vec::new(),
            last_rip: 0,
            last_page: 0,
        });
        r.functions = functions;
        r
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
        let r = runtime(functions);
        // compatibility-mode code beyond its share retires its own
        let victim = eviction_victim(&r, true).unwrap();
        assert!(r.functions[victim].page & COMPAT_KEY != 0);
        assert_eq!(r.functions[victim].last_used, 10_000);
        // long-mode code within its share: the least recently used of all
        let victim = eviction_victim(&r, false).unwrap();
        assert_eq!(r.functions[victim].last_used, 0);
        // a mode within its share takes the oldest of all, the crowded one
        // its own
        let mut few: Vec<Function> = (0..10)
            .map(|i| function(i | COMPAT_KEY, 50 + i as u64))
            .collect();
        few.extend((0..MAX_FUNCTIONS as u32 - 10).map(|i| function(i, 100 + i as u64)));
        let few = runtime(few);
        assert_eq!(
            few.functions[eviction_victim(&few, true).unwrap()].last_used,
            50
        );
        assert_eq!(
            few.functions[eviction_victim(&few, false).unwrap()].last_used,
            100
        );
    }
}
