//! The A64 page tier's runtime (docs/jit-unification-plan.md P6, J2;
//! docs/arm64-virt-android16-plan.md P6): jitrt's client A64Page in the ARM
//! core. One Wasm function per 4 KiB code page (crate::aarch64::jit::pagegen),
//! keyed by the page's code key (its RAM backing page from the AddressSpace,
//! P6.1: the code is position independent) with the mode it was compiled for
//! (the EL and whether SP alignment is checked); compiled once the
//! interpreter ran HOT instructions on the page, published through
//! jitrt::publish, retired when the page is written (jitrt::watch: the
//! interpreter's and compiled code's stores, DC ZVA, store-exclusives, DMA,
//! the loader and restores all reach bus::written or a64_bus_written). The
//! run loop (crate::aarch64::smp) offers each block boundary to `run`.
//!
//! What a page function reads and writes of the core: the registers, SP,
//! NZCV and the PC from the state block (loaded in its prologue, written
//! back at every way out and around single steps), guest memory through the
//! access cache (jitrt::access: per core and EL, filled by a64_page_access
//! from translations the TLB holds, so every TLB flush of the core retires
//! them, P6.4) and the chaining tables (jitrt::chain, per core and mode).
//! Steps go to the interpreter (A64Step, jitrt::step; P6.2).
//!
//! Not run (the interpreter goes on): with the MMU off (data accesses are
//! Device memory) or SCTLR_EL1.A set, with a breakpoint or watchpoint
//! enabled, while software step is active, with PSTATE.IL set.

use crate::aarch64::bus::{self, Lookup};
use crate::aarch64::cpu::{self, PSTATE_IL};
use crate::aarch64::execute::{self, Flow};
use crate::aarch64::jit::pagegen;
use crate::aarch64::state::{
    a64_code_base, a64_jac_base, a64_jac_epoch, a64_page_chain, a64_page_exit, a64_page_linear,
    mdscr_el1, sctlr_el1, tcr_el1, ttbr0_el1, ttbr1_el1,
};
use crate::isa::{current_core, MAX_CORES};
use crate::jitrt::access::{AccessCache, TagLayout};
use crate::jitrt::chain::ChainTable;
use crate::jitrt::page::{Function, PageFrontend, PageRuntime};
use crate::jitrt::publish::{self, Phase};
use crate::jitrt::step::{self, StepFrontend, StepOutcome, EXIT_RETRY, EXIT_UNKNOWN};
use crate::jitrt::table::{Owner, Signature};
use crate::jitrt::{self, ClientId};
use crate::page::Page;
use crate::wasmgen::wasm_builder::WasmBuilder;
use std::collections::HashSet;

extern "C" {
    fn call_indirect1_ret(f: i32, x: u16) -> i32;
}

// ---- switches (crate::aarch64::jit's registry)

/// The page tier runs (a64_page; default off until its F gate)
pub static mut ENABLED: bool = false;
/// AArch32's code is compiled too (a64_page_aarch32, docs/aarch32-plan.md Q6)
pub static mut AARCH32: bool = true;
/// (bisecting) the switch's value: 2 helper calls only, 3 native forms only, 16 + a mask
pub static mut AARCH32_DEBUG: u32 = 1;
/// (bisecting, a64_page_aarch32_filter) n << 16 | pattern
pub static mut AARCH32_FILTER: u32 = 0;
/// (debugging, a64_page_aarch32_trace) the last events of AArch32's EL0
/// code, its exceptions and returns, printed when an IT instruction is
/// UNDEFINED inside an IT block (a32_trace_dump)
pub static mut A32_TRACE: bool = false;
const TRACE_LENGTH: usize = 384;
/// (kind, core, ITSTATE, PC, extra): kinds 1 interpreted (the word), 2 a
/// helper (the word), 3 a function entered (its slot), 4 left (the exit
/// code | retired << 8), 5 a step (before), 8 its end (the step's result),
/// 6 an exception taken (the CPSR it saved), 7 an exception return (the CPSR)
static mut TRACE: [(u8, u8, u8, u32, u32); TRACE_LENGTH] = [(0, 0, 0, 0, 0); TRACE_LENGTH];
static mut TRACE_AT: usize = 0;
#[inline(always)]
pub fn a32_trace(kind: u8, pc: u32, extra: u32) {
    unsafe {
        if !A32_TRACE {
            return;
        }
        TRACE[TRACE_AT % TRACE_LENGTH] = (
            kind,
            current_core() as u8,
            crate::aarch64::t32::itstate() as u8,
            pc,
            extra,
        );
        TRACE_AT += 1;
    }
}
/// (a64_page_aarch32_trace) the trace, oldest first, and the page function's
/// view of the PC's page (pagegen::describe_a32)
pub fn a32_trace_dump(why: &str) {
    if !unsafe { A32_TRACE } {
        return;
    }
    let pc = cpu::get_pc();
    console_log!("a32 trace: {} at {:x} core {}", why, pc, current_core());
    let at = unsafe { TRACE_AT };
    for i in at.saturating_sub(TRACE_LENGTH)..at {
        let (kind, core, it, pc, extra) = unsafe { TRACE[i % TRACE_LENGTH] };
        let name = [
            "?", "interp", "helper", "enter", "leave", "step", "exc", "eret", "stepped",
        ][kind as usize % 9];
        console_log!(
            "  {} c{} it={:02x} {:08x} {:08x}",
            name,
            core,
            it,
            pc,
            extra
        );
    }
    let mode = mode();
    if let Some(key) = code_page(pc, mode) {
        let code_key = key & ((1 << MODE_SHIFT) - 1);
        let r = rt();
        let entries: Vec<u16> = r.pages.get(&key).map_or(Vec::new(), |state| {
            (0..4096u16)
                .filter(|&o| state.entries[o as usize / 64] >> (o % 64) & 1 != 0)
                .collect()
        });
        let compiled = r.by_page.get(&key).is_some();
        if code_key < bus::EXTENDED_CODE_KEY {
            let bytes = unsafe {
                std::slice::from_raw_parts(bus::MEM8.add((code_key << 12) as usize), 4096)
            };
            let offset = (pc & 0xFFF) as u16;
            console_log!(
                "a32 trace: page key {:x} compiled {} entries {:?}",
                key,
                compiled,
                entries
            );
            console_log!(
                "{}",
                pagegen::describe_a32(
                    bytes,
                    &entries,
                    pagegen::CompileEnv {
                        el1: false,
                        sp_checked: false,
                        chaining: true,
                        neon: unsafe { super::NEON },
                        helpers: unsafe { super::HELPERS },
                        system: unsafe { super::SYSTEM },
                        relaxed_fma: unsafe { super::RELAXED_FMA },
                        isa: if mode & !1 == MODE_T32 {
                            pagegen::Isa::T32
                        }
                        else {
                            pagegen::Isa::A32
                        },
                    },
                    offset.saturating_sub(32),
                    offset + 16,
                )
            );
        }
    }
    unsafe { TRACE_AT = 0 };
}
/// Interpreted instructions on a page before it is compiled
pub static mut HOT: u32 = 2000;
/// Unserved entries of a published function before its page is recompiled
const RECOMPILE_MISSES: u32 = 64;
/// The most functions (this client's quota of the core's table)
pub const MAX_FUNCTIONS: u32 = 9000;
/// The most Wasm bytes of live functions, MiB (a64_page_code_mb): the host
/// commits about 1.3 times as much machine code for them, and every core
/// of a process (cores in workers) draws on one limit, V8's 4 GiB of
/// committed Wasm code; Android's boot on four cores exceeded it with the
/// table full of functions. Past it the least recently used ones go
pub static mut CODE_BUDGET_MB: u32 = 160;
/// The Wasm bytes of the live (and pending) functions
static mut LIVE_BYTES: u64 = 0;
/// Instructions an activation may retire: the run loop ticks the timers
/// and takes interrupts between activations (a step ticks them too)
const MAX_BUDGET: u32 = 1 << 14;

// ---- keys and modes

/// A function's key: the code key (below 2^28) with its mode's bits
const MODE_SHIFT: u32 = 28;
/// Modes: bit 0 EL1, bit 1 SP alignment checked; AArch32, A32 and T32 at
/// EL0 (Q6), or PL1 with bit 0 (cpu_type arm32, R5.3)
pub const MODES: usize = 8;
pub const MODE_A32: u32 = 4;
pub const MODE_T32: u32 = 6;

/// Whether a mode is AArch32's (A32 or T32, either privilege)
#[inline(always)]
fn aarch32_mode(mode: u32) -> bool { mode & !1 == MODE_A32 || mode & !1 == MODE_T32 }

/// The mode the running core's code would be compiled for
#[inline(always)]
fn mode() -> u32 {
    if cpu::aarch32() {
        let isa = if cpu::get_pstate() & cpu::PSTATE_T != 0 { MODE_T32 } else { MODE_A32 };
        return isa | (cpu::el() != 0) as u32;
    }
    let el1 = cpu::el() != 0;
    let sctlr = cpu::sctlr();
    let sp_checked = sctlr & if el1 { cpu::SCTLR_SA } else { cpu::SCTLR_SA0 } != 0;
    el1 as u32 | (sp_checked as u32) << 1
}

// ---- the access cache (jitrt::access) and the chaining tables (jitrt::chain)

/// A64's tags: the virtual page below bit 52, the epoch above (with
/// a64_asid_tag, the ASID's: bind_asid); a tagged pointer (TBI: Android's
/// heap pointers) gets an entry of its own in the untagged page's slot,
/// which a TLBI by VA (naming the page untagged) clears with it
/// (tlb_flushed_page); regions: no block marks them (the TLB decides when a
/// page's invalidation flushes, tlb::flush_page)
pub const LAYOUT: TagLayout = TagLayout {
    epoch_shift: 52,
    region_shift: 21,
};
pub const ENTRIES: usize = 2048;
static mut ACCESS: [AccessCache; MAX_CORES] = [const { AccessCache::NEW }; MAX_CORES];
#[inline(always)]
fn access(core: usize) -> &'static mut AccessCache { unsafe { &mut (*(&raw mut ACCESS))[core] } }

#[repr(C, align(16))]
struct ChainTables([ChainTable; MODES]);
static mut CHAIN: [ChainTables; MAX_CORES] =
    [const { ChainTables([const { ChainTable::EMPTY }; MODES]) }; MAX_CORES];
#[inline(always)]
fn chain(core: usize) -> &'static mut ChainTables { unsafe { &mut (*(&raw mut CHAIN))[core] } }
/// Whether generated code tail-calls between pages (the host supports Wasm
/// tail calls: jit_set_tail_calls)
static mut CHAINING: bool = false;
#[no_mangle]
pub fn a64_page_set_chaining(enabled: bool) {
    unsafe { CHAINING = enabled };
    clear_chains();
}
fn clear_chains() {
    for core in 0..MAX_CORES {
        for table in chain(core).0.iter_mut() {
            table.clear();
        }
    }
}

/// Per core: the code pages' translations (tag: epoch | mode, the virtual
/// page, the function key), direct mapped by virtual page
const CODE_TLB_SIZE: usize = 16;
static mut CODE_TLB: [[(u64, u64, u32); CODE_TLB_SIZE]; MAX_CORES] =
    [[(0, 0, 0); CODE_TLB_SIZE]; MAX_CORES];

/// The TLB of `core` was flushed: its access cache entries and code
/// translations retire (an epoch), its chaining entries go
pub fn tlb_flushed(core: usize) {
    if unsafe { super::ASID_TAG } {
        // (every ASID's epoch goes; the chaining tables' and the code TLB's
        // entries of old epochs never match again)
        asids(core).slots = [NO_SLOT; ASID_SLOTS];
        fresh_epoch(core);
        return;
    }
    if access(core).flush(LAYOUT) {
        // (the epochs wrapped: the tables were emptied, and tags of old epochs would match again)
        unsafe { CODE_TLB[core] = [(0, 0, 0); CODE_TLB_SIZE] };
    }
    for table in chain(core).0.iter_mut() {
        table.clear();
    }
}
/// The TLB of `core` dropped its non-global entries (an ASID's)
pub fn tlb_flushed_nonglobal(core: usize) {
    access(core).flush_nonglobal(ENTRIES);
    unsafe { CODE_TLB[core] = [(0, 0, 0); CODE_TLB_SIZE] };
    for table in chain(core).0.iter_mut() {
        table.forget_nonglobal();
    }
}
/// The TLB of `core` dropped the non-global entries of `asid` (TLBI ASIDE1)
pub fn tlb_flushed_asid(core: usize, asid: u16) {
    if !unsafe { super::ASID_TAG } {
        return tlb_flushed_nonglobal(core);
    }
    let a = asids(core);
    match a.slots.iter().position(|s| s.epoch != 0 && s.asid == asid) {
        Some(i) if a.current == Some(i) => drop_current_epoch(core),
        Some(i) => a.slots[i] = NO_SLOT,
        None => {},
    }
}
/// The TLB of `core` dropped the entries of virtual page `page` (VA >> 12,
/// TBI applied) for `asid` (and the global ones), or for every ASID (None)
pub fn tlb_flushed_page(core: usize, page: u64, asid: Option<u16>) {
    let flushed = access(core).invalidate_page(LAYOUT, ENTRIES, page << 12);
    if flushed.is_none() {
        forget_tagged(core, page);
    }
    unsafe { CODE_TLB[core][page as usize & (CODE_TLB_SIZE - 1)].0 = 0 };
    for table in chain(core).0.iter_mut() {
        table.forget_page(LAYOUT, page);
    }
    if unsafe { super::ASID_TAG } {
        if flushed.is_some() {
            // (jitrt's flush numbered the new epoch itself: start over)
            asids(core).slots = [NO_SLOT; ASID_SLOTS];
            fresh_epoch(core);
            return;
        }
        // the other epochs that may hold the page: the ASID's, those with a
        // global translation in the lower half, all of them for the upper
        // half (the kernel's global pages are in every epoch)
        let upper = page >> 43 & 1 != 0;
        let a = asids(core);
        for i in 0..ASID_SLOTS {
            let slot = a.slots[i];
            if a.current != Some(i)
                && slot.epoch != 0
                && (upper || slot.low_global || asid.map_or(true, |x| x == slot.asid))
            {
                a.slots[i] = NO_SLOT;
            }
        }
    }
    else if flushed == Some(true) {
        // (the epochs wrapped: tags of old epochs would match again)
        unsafe { CODE_TLB[core] = [(0, 0, 0); CODE_TLB_SIZE] };
        for table in chain(core).0.iter_mut() {
            table.clear();
        }
    }
}

/// The current epoch's entries of virtual page `page` under any pointer tag
/// (TBI: VA bits 63:56, the page number's 51:44) go: they share the
/// untagged page's slot
fn forget_tagged(core: usize, page: u64) {
    const TAG_BITS: u64 = 0xFF << 44;
    let cache = access(core);
    let epoch = cache.epoch();
    for kind in 0..crate::jitrt::access::TABLES {
        let entry = &mut cache.tables[AccessCache::slot(ENTRIES, kind, page)];
        if entry.tag != 0
            && entry.tag >> LAYOUT.epoch_shift == epoch
            && LAYOUT.page(entry.tag) & !TAG_BITS == page & !TAG_BITS
        {
            entry.tag = 0;
        }
    }
}

// ---- a64_asid_tag (P6.4): an epoch per ASID

/// With a64_asid_tag, each recently used ASID of a core has an epoch of its
/// own: an ASID switch makes the running ASID's epoch the access cache's
/// current one (its entries, and the code TLB's and chaining tables', are
/// live again) instead of dropping every non-global entry. Epoch numbers are
/// never reused before the epochs wrap (everything is emptied then), and
/// binding happens at an activation (bind_asid), which a TTBR write by a
/// single step ends. A TLBI drops the epochs its entries may be in: TLBI
/// ASIDE1 the ASID's; a TLBI by VA the current epoch's entries of the page,
/// and the other epochs that may hold it; anything else, every epoch.
const ASID_SLOTS: usize = 16;
#[derive(Clone, Copy)]
struct AsidSlot {
    asid: u16,
    /// 0: an empty slot
    epoch: u64,
    used: u64,
    /// an entry of a global translation in the lower half (TTBR0) was filled
    low_global: bool,
}
const NO_SLOT: AsidSlot = AsidSlot {
    asid: 0,
    epoch: 0,
    used: 0,
    low_global: false,
};
struct Asids {
    slots: [AsidSlot; ASID_SLOTS],
    /// the slot of the current epoch (None: a fresh epoch, no entries yet)
    current: Option<usize>,
    /// the last epoch number given out
    latest: u64,
    clock: u64,
}
static mut ASIDS: [Asids; MAX_CORES] = [const {
    Asids {
        slots: [NO_SLOT; ASID_SLOTS],
        current: None,
        latest: 0,
        clock: 0,
    }
}; MAX_CORES];
fn asids(core: usize) -> &'static mut Asids { unsafe { &mut (*(&raw mut ASIDS))[core] } }

/// A new epoch number, made the current epoch of `core`'s access cache
/// (bound to no ASID yet); when the numbers run out, everything tagged
/// with one is emptied
fn fresh_epoch(core: usize) -> u64 {
    let a = asids(core);
    a.latest = a.latest.max(access(core).epoch()) + 1;
    if a.latest >= LAYOUT.epoch_limit() {
        access(core).clear();
        unsafe { CODE_TLB[core] = [(0, 0, 0); CODE_TLB_SIZE] };
        for table in chain(core).0.iter_mut() {
            table.clear();
        }
        a.slots = [NO_SLOT; ASID_SLOTS];
        a.latest = 1;
    }
    access(core).set_epoch(a.latest);
    a.current = None;
    a.latest
}
/// The current epoch's entries are no longer valid: its slot goes, a fresh epoch comes
fn drop_current_epoch(core: usize) {
    let a = asids(core);
    if let Some(i) = a.current {
        a.slots[i] = NO_SLOT;
    }
    fresh_epoch(core);
}
/// Before compiled code runs or the code TLB is used: the access cache's
/// current epoch is the running ASID's
#[inline]
fn bind_asid(core: usize) {
    if !unsafe { super::ASID_TAG } {
        return;
    }
    let asid = crate::aarch64::mmu::current_asid();
    let a = asids(core);
    if let Some(i) = a.current {
        if a.slots[i].asid == asid {
            return;
        }
    }
    a.clock += 1;
    if let Some(i) = a.slots.iter().position(|s| s.epoch != 0 && s.asid == asid) {
        a.slots[i].used = a.clock;
        access(core).set_epoch(a.slots[i].epoch);
        a.current = Some(i);
        return;
    }
    // (an unbound epoch has no entries: the ASID takes it; else a fresh one)
    let epoch = if a.current.is_none() { access(core).epoch() } else { fresh_epoch(core) };
    let a = asids(core);
    let i = a
        .slots
        .iter()
        .position(|s| s.epoch == 0)
        .unwrap_or_else(|| (0..ASID_SLOTS).min_by_key(|&i| a.slots[i].used).unwrap());
    a.slots[i] = AsidSlot {
        asid,
        epoch,
        used: a.clock,
        low_global: false,
    };
    a.current = Some(i);
}
/// a64_asid_tag 2 (auto): every AUTO_WINDOW ticks of the run loop (about 4
/// million instructions) the tags go on when the ASIDs changed AUTO_ON times
/// or more in the window, off when fewer than AUTO_OFF (P9.3: about 1300 per
/// window while the androidish kernel, with SW_TTBR0_PAN, boots Alpine to a
/// login; about 7 for the stock kernel)
const AUTO_WINDOW: u32 = 4096;
const AUTO_ON: u64 = 256;
const AUTO_OFF: u64 = 16;
static mut AUTO_TICKS: u32 = 0;
static mut AUTO_LAST: u64 = 0;
/// the tags turned on or off by auto
static mut AUTO_SWITCHES: u64 = 0;
/// (crate::aarch64::smp::run_core, about every 1024 instructions: no compiled code is active)
pub fn asid_tag_tick() {
    unsafe {
        if super::ASID_TAG_MODE != 2 {
            return;
        }
        AUTO_TICKS += 1;
        if AUTO_TICKS < AUTO_WINDOW {
            return;
        }
        AUTO_TICKS = 0;
        let changes = crate::aarch64::mmu::asid_changes();
        let window = changes.wrapping_sub(AUTO_LAST);
        AUTO_LAST = changes;
        if !super::ASID_TAG && window >= AUTO_ON || super::ASID_TAG && window < AUTO_OFF {
            set_asid_tag(!super::ASID_TAG);
            AUTO_SWITCHES += 1;
        }
    }
}

/// a64_asid_tag changed: every core's cache starts over, empty (an epoch
/// number either way may have been given out by the other)
pub fn set_asid_tag(on: bool) {
    unsafe { super::ASID_TAG = on };
    for core in 0..MAX_CORES {
        access(core).clear();
        unsafe { CODE_TLB[core] = [(0, 0, 0); CODE_TLB_SIZE] };
        for table in chain(core).0.iter_mut() {
            table.clear();
        }
        let a = asids(core);
        a.slots = [NO_SLOT; ASID_SLOTS];
        a.current = None;
    }
}

// ---- the runtime

pub struct A64;
/// A function's own data: its source page's hash when it was compiled
/// (with cores in workers, checked again when it is installed, P8.2)
#[derive(Default)]
pub struct A64Code {
    source: u64,
    /// its module's Wasm bytes, against CODE_BUDGET_MB
    bytes: u32,
}
#[derive(Default)]
pub struct A64Page;
pub struct A64Extra {
    /// the page of the last activation's or boundary's PC, for heat
    last_key: u32,
    /// instructions interpreted since the last boundary
    interpreted: u32,
}
impl PageFrontend for A64 {
    type Code = A64Code;
    type Page = A64Page;
    type Extra = A64Extra;
}
type Runtime = PageRuntime<A64>;
static mut RUNTIME: Option<Runtime> = None;
fn rt() -> &'static mut Runtime {
    unsafe {
        (*(&raw mut RUNTIME)).get_or_insert_with(|| {
            Runtime::new(A64Extra {
                last_key: u32::MAX,
                interpreted: 0,
            })
        })
    }
}

// statistics (jit_stat(1, n), a64_page_stat)
const COMPILED: usize = 0;
const ACTIVATIONS: usize = 1;
const RETIRED: usize = 2;
const STEPS: usize = 3;
const RETRIES: usize = 4;
const UNKNOWN: usize = 5;
const RETIRED_FUNCTIONS: usize = 6;
const ACCESS_FILLS: usize = 7;
const ACCESS_REFUSED: usize = 8;
const FAILED: usize = 9;
const CHAINED: usize = 10;
const INSTRUCTIONS: usize = 11;
const TEMPLATED: usize = 12;
/// (the client's own counters, past PageRuntime::stats)
static mut WRITES: u64 = 0;
static mut RESETS: u64 = 0;
static mut HELPERS: u64 = 0;
/// functions retired to make room (P6.6b), and the time spent compiling (ms)
static mut EVICTIONS: u64 = 0;
static mut COMPILE_MS: f64 = 0.0;

/// Code retired (a write to code, a reset): a step that sees it changed ends the activation
static mut CODE_WRITES: u64 = 0;

/// (diagnostics) why the access cache refused a fill (a64_page_stat 120 +
/// reason): a page crossing (or SCTLR_EL1.A), no translation (a fault, or
/// none the cache may hold), a write to memory that is not writable RAM, a
/// write to a page with code, a write to a page a core holds a reservation
/// in, extended RAM without a frame, not RAM; and an unaligned access the
/// caller cannot take (filled, refused this once)
const REFUSED_CROSSING: usize = 0;
const REFUSED_TRANSLATION: usize = 1;
const REFUSED_NOT_WRITABLE: usize = 2;
const REFUSED_WATCHED: usize = 3;
const REFUSED_RESERVED: usize = 4;
const REFUSED_EXTENDED: usize = 5;
const REFUSED_NOT_RAM: usize = 6;
const REFUSED_UNALIGNED: usize = 7;
static mut REFUSED: [u64; 8] = [0; 8];

/// (a64_reserved_fill) whether a write entry to a page some core holds a
/// reservation in is refused also with the cores in workers, where a
/// store-exclusive compares the value instead (docs/aarch64.md) and the
/// write entries already filled stay; with four cores the refusals (every
/// store to an ART lock word's page through the interpreter) cost more
/// than the reservation they protect
pub static mut RESERVED_FILL_REFUSED: bool = false;
/// (a64_step_stats) whether steps and helper calls are counted (a64_step_stat)
pub static mut STEP_STATS: bool = true;
/// Steps and helper calls are counted one in STEP_SAMPLE (the counts in
/// machine memory, which every core writes, scaled up): a count per call
/// made the cores share the counters' cache lines
const STEP_SAMPLE: u32 = 64;
static mut STEP_SAMPLED: u32 = 0;
#[inline(always)]
fn refused(reason: usize) { unsafe { REFUSED[reason] += 1 } }

/// A function is retired: its chaining entries and fast entries go
fn retire(r: &mut Runtime, index: usize) {
    if !r.kill(index) {
        return;
    }
    let f = &r.functions[index];
    unsafe { LIVE_BYTES = LIVE_BYTES.saturating_sub(f.x.bytes as u64) };
    for &key in &f.members {
        if r.by_page.get(&key) == Some(&index) {
            r.by_page.remove(&key);
        }
    }
    let table_index = f.slot + crate::aarch64::root::WASM_TABLE_OFFSET;
    for core in 0..MAX_CORES {
        for table in chain(core).0.iter_mut() {
            table.unchain(table_index);
        }
    }
    r.stats[RETIRED_FUNCTIONS] += 1;
    unsafe { CODE_WRITES += 1 };
}
/// At a cold point: dead functions' slots back to the table
fn release_dead(r: &mut Runtime) {
    r.release_dead(|slot, id| {
        let mut rt = jitrt::state();
        if rt.table.release(slot, ClientId::A64Page, id) {
            rt.watch.detach(slot);
            (jitrt::host::env().clear_slot)(slot);
        }
    });
}

/// The watch's listener (crate::aarch64::root): the code page `page` (a
/// code key) was written; the functions of each mode compiled from it retire
pub fn page_written(page: u32) {
    unsafe { WRITES += 1 };
    let r = rt();
    for mode in 0..MODES as u32 {
        if let Some(&index) = r.by_page.get(&(page | mode << MODE_SHIFT)) {
            retire(r, index);
        }
    }
}
/// Every function retires (a reset of the watch: a new map, a restore)
pub fn retire_all() {
    unsafe { RESETS += 1 };
    let r = rt();
    for index in 0..r.functions.len() {
        retire(r, index);
    }
    for core in 0..MAX_CORES {
        tlb_flushed(core);
    }
}

/// Before `core` runs (crate::aarch64::smp::switch_to): its write entries to
/// the RAM pages the cores in `monitors` hold reservations in retire, so
/// that its compiled stores there reach the global monitor (P3.7). (A scan
/// at every reservation instead cost 2-core Alpine half its speed, also
/// interpreted: every atomic is a load-exclusive.)
pub fn retire_reserved_writes(core: usize, monitors: u32) {
    if !unsafe { ENABLED } {
        return;
    }
    let mem8 = unsafe { bus::MEM8 } as u32;
    let mut hosts = [u32::MAX; MAX_CORES];
    let mut count = 0;
    let mut extended = false;
    for c in 0..MAX_CORES {
        if monitors & 1 << c != 0 {
            let backing = crate::aarch64::smp::reserved_backing(c);
            extended |= backing >= crate::aarch64::extended::KEY_BASE;
            hosts[count] = mem8.wrapping_add(backing & !0xFFF);
            count += 1;
        }
    }
    // (a reservation in extended RAM: its key names no frame, so the write
    // entries to every frame retire)
    let (start, end) =
        if extended { unsafe { crate::aarch64::extended::frame_range() } } else { (0, 0) };
    access(core).retire_writes(ENTRIES, |entry| {
        hosts[..count].contains(&entry.host) || entry.host >= start && entry.host < end
    });
}

/// The frame of extended RAM at `host` gained code: write entries to it retire
pub fn retire_writes_to(host: u32) {
    for core in 0..MAX_CORES {
        access(core).retire_writes(ENTRIES, |entry| entry.host == host);
    }
}

/// Pages that gained code: write entries to them retire (stores must notify)
pub fn pages_gain_code(pages: &HashSet<Page>) {
    let mem8 = unsafe { bus::MEM8 } as u32;
    for page in pages {
        let host = mem8.wrapping_add(page.to_u32() << 12);
        for core in 0..MAX_CORES {
            access(core).retire_writes(ENTRIES, |entry| entry.host == host);
        }
    }
}

// ---- running

/// What `run` did: nothing (the interpreter goes on), or an activation
pub enum Ran {
    None,
    /// `retired` instructions; `flow`: what a single step that ended it
    /// asks of the run loop (a wait, a stop, a yield), else Flow::Next
    Native {
        retired: u32,
        flow: Flow,
    },
}

#[inline(always)]
fn allowed() -> bool {
    let sctlr = cpu::sctlr();
    unsafe {
        ENABLED
            && sctlr & cpu::SCTLR_M != 0
            && sctlr & cpu::SCTLR_A == 0
            && !crate::aarch64::debug::ANY_BREAKPOINT
            && !crate::aarch64::debug::ANY_WATCHPOINT
            && !crate::aarch64::debug::stepping()
            && cpu::get_pstate() & PSTATE_IL == 0
    }
}

/// The function key of the code page at `pc` for the current mode, if it is RAM
fn code_page(pc: u64, mode: u32) -> Option<u32> {
    let core = current_core();
    let tag = access(core).epoch_bits(LAYOUT) | mode as u64;
    let index = (pc >> 12) as usize & (CODE_TLB_SIZE - 1);
    let (cached_tag, page, key) = unsafe { CODE_TLB[core][index] };
    if cached_tag == tag && page == pc >> 12 {
        return Some(key);
    }
    let pa = crate::aarch64::mmu::translate(
        pc,
        crate::aarch64::memory::Access::Fetch,
        cpu::el() == 0,
        4,
    )
    .ok()?
    .pa;
    let code_key = bus::bus().code_key(pa)?;
    // (code in extended RAM: compiled with the cores in one instance; in
    // workers it is interpreted, P8.5)
    if code_key >= 1 << MODE_SHIFT
        || code_key >= bus::EXTENDED_CODE_KEY && crate::parallel::active()
    {
        return None;
    }
    let key = code_key | mode << MODE_SHIFT;
    unsafe { CODE_TLB[core][index] = (tag, pc >> 12, key) };
    Some(key)
}

/// At a block boundary (a branch, an exception, a slice's start): run the
/// function of the PC's page if there is one ready and it serves the PC,
/// for at most `budget` instructions; else note the page's heat and entry,
/// and compile it when hot
pub fn run(budget: u32) -> Ran {
    // (AArch32's code with a64_page_aarch32, docs/aarch32-plan.md Q6, R5.3; not
    // from inside an IT block: compiled code enters at ITSTATE 0, little-endian)
    if !allowed()
        || budget == 0
        || cpu::aarch32()
            && !(unsafe { AARCH32 }
                && crate::aarch64::t32::itstate() == 0
                && cpu::get_pstate() & cpu::PSTATE_E == 0)
    {
        return Ran::None;
    }
    let pc = cpu::get_pc();
    let mode = mode();
    bind_asid(current_core());
    let Some(key) = code_page(pc, mode)
    else {
        return Ran::None;
    };
    let offset = (pc & 0xFFF) as u16;
    let r = rt();
    // (heat: the instructions interpreted since the last boundary went to its page)
    let interpreted = std::mem::replace(&mut r.x.interpreted, 0);
    if r.x.last_key != u32::MAX && interpreted != 0 {
        let last = r.x.last_key;
        if !r.by_page.contains_key(&last) {
            let state = r.pages.entry(last).or_default();
            state.heat = state.heat.saturating_add(interpreted);
        }
    }
    r.x.last_key = key;
    if let Some(&index) = r.by_page.get(&key) {
        let f = &r.functions[index];
        if f.phase == Phase::Ready {
            if f.serves(0, offset) {
                let slot = f.slot;
                r.clock += 1;
                r.functions[index].last_used = r.clock;
                let ran = execute(slot, budget, pc);
                if key & ((1 << MODE_SHIFT) - 1) >= bus::EXTENDED_CODE_KEY {
                    if let Ran::Native { retired, .. } = ran {
                        unsafe { crate::aarch64::extended::RETIRED[1] += retired as u64 };
                    }
                }
                return ran;
            }
            // (an entry it does not serve: noted, recompiled after enough of them)
            let state = r.pages.entry(key).or_default();
            note_entry_bits(&mut state.entries, offset);
            state.misses += 1;
            if state.misses >= RECOMPILE_MISSES {
                state.misses = 0;
                compile(key, pc);
            }
        }
        return Ran::None;
    }
    let state = r.pages.entry(key).or_default();
    note_entry_bits(&mut state.entries, offset);
    let threshold = unsafe { HOT } << crate::jitrt::heat::backoff(state.compiles);
    if state.heat >= threshold {
        state.heat = 0;
        compile(key, pc);
    }
    Ran::None
}

/// The run loop interpreted an instruction (heat for the page of the last boundary)
#[inline(always)]
pub fn interpreted() { unsafe { (*(&raw mut RUNTIME)).as_mut().map(|r| r.x.interpreted += 1) }; }

fn note_entry_bits(entries: &mut [u64; 64], offset: u16) {
    entries[offset as usize / 64] |= 1 << (offset % 64);
}

/// (the parallel build) where page functions copy unaligned reads to,
/// pagegen::frame: two slots of 32 bytes (a pair's elements)
#[repr(C, align(16))]
struct Bounce([u8; 64]);
static mut BOUNCE: Bounce = Bounce([0; 64]);
pub fn bounce_address() -> u32 { &raw mut BOUNCE as u32 }

/// The flow a step asked for (a wait, a stop, a yield) while compiled code ran
static mut STEP_FLOW: Option<Flow> = None;
/// A helper's instruction that completed but asked the run loop for
/// something (a load-exclusive's spin yield): its next PC and that flow;
/// the function left as for a retry, which this finishes instead of
/// executing the instruction again
static mut HELPER_DONE: Option<(u64, Flow)> = None;

fn execute(slot: u32, budget: u32, pc: u64) -> Ran {
    let core = current_core();
    let mode = mode();
    // (functions leaving for this page chain to this one: jitrt::chain)
    let epoch_bits = access(core).epoch_bits(LAYOUT);
    chain(core).0[mode as usize].fill(
        pc >> 12,
        epoch_bits,
        slot + crate::aarch64::root::WASM_TABLE_OFFSET,
        false,
    );
    unsafe {
        *a64_page_exit = 0;
        *a64_page_chain = 0;
        *a64_page_linear = pc & !0xFFF;
        *a64_jac_epoch = access(core).epoch_bits(LAYOUT);
        *a64_jac_base = access(core).base(ENTRIES, (mode & 1 == 0) as usize);
        *a64_code_base = chain(core).0[mode as usize].base();
        STEP_FLOW = None;
        HELPER_DONE = None;
    }
    let r = rt();
    r.stats[ACTIVATIONS] += 1;
    a32_trace(3, pc as u32, slot);
    let native = unsafe {
        call_indirect1_ret(
            (slot + crate::aarch64::root::WASM_TABLE_OFFSET) as i32,
            budget.min(MAX_BUDGET) as u16,
        )
    } as u32;
    let chained = unsafe { *a64_page_chain };
    let retired = native.wrapping_add(chained);
    let r = rt();
    r.stats[RETIRED] += retired as u64;
    if chained != 0 {
        r.stats[CHAINED] += 1;
    }
    crate::core_stats::add_pending(retired, 0);
    r.x.last_key = u32::MAX;
    let mut retired = retired;
    let mut flow = unsafe { (*(&raw mut STEP_FLOW)).take() }.unwrap_or(Flow::Next);
    match unsafe { *a64_page_exit } {
        EXIT_RETRY if unsafe { (*(&raw const HELPER_DONE)).is_some() } => {
            let (next, f) = unsafe { (*(&raw mut HELPER_DONE)).take() }.unwrap();
            cpu::set_pc(next);
            retired += 1;
            flow = f;
        },
        EXIT_RETRY => {
            // (the instruction at the PC: a template refused it before any of its effects)
            r.stats[RETRIES] += 1;
            let f = execute::interpret_one();
            if !matches!(f, Flow::Set | Flow::Retry) {
                retired += 1;
            }
            if matches!(f, Flow::Wait(_) | Flow::Off | Flow::Yield | Flow::Retry) {
                flow = f;
            }
        },
        EXIT_UNKNOWN => r.stats[UNKNOWN] += 1,
        _ => {},
    }
    release_dead(rt());
    a32_trace(
        4,
        cpu::get_pc() as u32,
        unsafe { *a64_page_exit } | retired << 8,
    );
    Ran::Native { retired, flow }
}

// ---- compiling

fn compile(key: u32, pc: u64) {
    let r = rt();
    let state = r.pages.entry(key).or_default();
    state.compiles += 1;
    let entries: Vec<u16> = (0..4096u16)
        .filter(|&o| state.entries[o as usize / 64] >> (o % 64) & 1 != 0)
        .collect();
    let code_key = key & ((1 << MODE_SHIFT) - 1);
    let mode = key >> MODE_SHIFT;
    let filter = unsafe { AARCH32_FILTER };
    if filter != 0 && aarch32_mode(mode) {
        let mask = (1u32 << (filter >> 16)) - 1;
        if code_key & mask != filter & 0xFFFF & mask {
            return;
        }
        console_log!(
            "a32 page {:x} key {:x} {}",
            pc & !0xFFF,
            code_key,
            if mode & !1 == MODE_T32 { "T32" } else { "A32" }
        );
    }
    let bytes = if code_key >= bus::EXTENDED_CODE_KEY {
        unsafe { crate::extended::copy_page(code_key - bus::EXTENDED_CODE_KEY) }
    }
    else {
        unsafe { std::slice::from_raw_parts(bus::MEM8.add((code_key << 12) as usize), 4096) }
            .to_vec()
    };
    let name = format!(
        "a64_page{}_{:x}",
        match mode {
            MODE_A32 => "_a32",
            MODE_T32 => "_t32",
            5 => "_a32_pl1",
            7 => "_t32_pl1",
            _ if mode & 1 != 0 => "_el1",
            _ => "_el0",
        },
        pc & !0xFFF
    );
    let started = unsafe { crate::isa::microtick() };
    let compiled = pagegen::compile(
        &bytes,
        &entries,
        pagegen::CompileEnv {
            el1: mode & 1 != 0,
            sp_checked: mode & 2 != 0,
            // (a64_page_aarch32_filter's bit 15: AArch32's functions do not chain)
            chaining: unsafe { CHAINING } && !(aarch32_mode(mode) && filter & 0x8000 != 0),
            neon: unsafe { super::NEON },
            helpers: unsafe { super::HELPERS },
            system: unsafe { super::SYSTEM },
            relaxed_fma: unsafe { super::RELAXED_FMA },
            isa: match mode & !1 {
                MODE_A32 => pagegen::Isa::A32,
                MODE_T32 => pagegen::Isa::T32,
                _ => pagegen::Isa::A64,
            },
        },
        name,
    );
    unsafe { COMPILE_MS += crate::isa::microtick() - started };
    let Some(code) = compiled
    else {
        rt().stats[FAILED] += 1;
        return;
    };
    let r = rt();
    // room in the table: the least recently used function goes
    let live = r.live();
    let must_evict = {
        let rt = jitrt::state();
        let free = rt.table.free_count();
        crate::jitrt::capacity::must_evict(ClientId::A64Page, live, free, |c| {
            rt.table.owned_by(c) as u32
        })
    };
    if crate::jitrt::capacity::take_request(ClientId::A64Page) || must_evict {
        if let Some(i) = r.victim(|_| true, usize::MAX) {
            retire(r, i);
            unsafe { EVICTIONS += 1 };
        }
    }
    // room in the code budget: the least recently used go until it fits
    let budget = unsafe { CODE_BUDGET_MB } as u64 * 1048576;
    while unsafe { LIVE_BYTES } + code.bytes.len() as u64 > budget {
        let Some(i) = r.victim(|_| true, usize::MAX)
        else {
            break;
        };
        retire(r, i);
        unsafe { EVICTIONS += 1 };
    }
    release_dead(r);
    let id = r.next_id;
    r.next_id += 1;
    let slot = {
        let mut rt = jitrt::state();
        let Some(slot) = rt.table.reserve(Owner {
            client: ClientId::A64Page,
            signature: Signature::Fn1Ret,
            id,
        })
        else {
            drop(rt);
            self::rt().stats[FAILED] += 1;
            return;
        };
        rt.watch
            .attach(slot, HashSet::from([Page::of_u32(code_key)]));
        slot
    };
    // (its next write retires it: crate::aarch64::isa_hooks::extended_code_written)
    if code_key >= bus::EXTENDED_CODE_KEY {
        unsafe { crate::extended::watch_code(code_key - bus::EXTENDED_CODE_KEY) };
    }
    let r = rt();
    if let Some(&old) = r.by_page.get(&key) {
        retire(r, old);
    }
    let index = match r.functions.iter().position(|f| {
        f.phase == Phase::Dead && !r.releases.iter().any(|&(s, i)| s == f.slot && i == f.id)
    }) {
        Some(i) => i,
        None => {
            r.functions.push(Function {
                page: key,
                id: 0,
                slot: 0,
                phase: Phase::Dead,
                served: Vec::new(),
                members: Vec::new(),
                last_used: 0,
                x: A64Code::default(),
            });
            r.functions.len() - 1
        },
    };
    r.clock += 1;
    r.functions[index] = Function {
        page: key,
        id,
        slot,
        phase: Phase::Pending,
        served: code.served,
        members: vec![key],
        last_used: r.clock,
        x: A64Code {
            source: source_hash(&bytes),
            bytes: code.bytes.len() as u32,
        },
    };
    unsafe { LIVE_BYTES += code.bytes.len() as u64 };
    r.by_page.insert(key, index);
    r.generation = r.generation.wrapping_add(1);
    r.stats[COMPILED] += 1;
    r.stats[INSTRUCTIONS] += code.instructions as u64;
    r.stats[TEMPLATED] += code.templated as u64;
    publish::publish(ClientId::A64Page, id, slot, &code.bytes);
}

/// FNV-1a over a code page
fn source_hash(bytes: &[u8]) -> u64 {
    let mut hash = 0xCBF29CE484222325u64;
    for &byte in bytes {
        hash = (hash ^ byte as u64).wrapping_mul(0x100000001B3);
    }
    hash
}

// publication's answers (jitrt::publish)
fn install(id: u64, slot: u32) -> bool {
    let r = rt();
    let Some(f) = r.pending(id, slot).map(|i| &r.functions[i])
    else {
        return false;
    };
    if !crate::parallel::active() {
        return true;
    }
    // (cores in workers, P8.2: the other cores mark the page first, so that
    // their stores to it retire this code; then its bytes are checked once
    // more, which sees any store before the marks)
    let (key, source) = (f.page & ((1 << MODE_SHIFT) - 1), f.x.source);
    if key >= bus::EXTENDED_CODE_KEY
        || !unsafe { crate::parallel::code::wait_published(std::iter::once(key), 0.5) }
    {
        return false;
    }
    let bytes = unsafe { std::slice::from_raw_parts(bus::MEM8.add((key << 12) as usize), 4096) };
    source_hash(bytes) == source
}
fn ready(id: u64, slot: u32) -> bool { rt().ready(id, slot).is_some() }
fn cancel(id: u64, slot: u32) {
    let r = rt();
    if let Some(index) = r.pending(id, slot) {
        retire(r, index);
    }
}
pub fn register() {
    publish::register(
        ClientId::A64Page,
        publish::Client {
            install,
            ready,
            cancel,
        },
    );
}

// ---- what generated code calls

/// The access cache's miss (pagegen::frame::AccessAbi::slow): the host
/// address of a `kind & 255`-byte access (bit 8: write) at virtual address
/// `address` by the running core at its EL, filling the cache; 0 when
/// refused (a fault, a device, a page with code for a write, a page
/// crossing): the function leaves for the interpreter to do it
#[no_mangle]
pub fn a64_page_access(address: u64, kind: u32) -> u32 {
    let size = kind & 255;
    let write = kind & 0x100 != 0;
    let r = rt();
    // (an access across pages, and with SCTLR_EL1.A every access: the
    // interpreter, which splits it or raises the alignment fault)
    if (address & 0xFFF) + size as u64 > 0x1000 || cpu::sctlr() & cpu::SCTLR_A != 0 {
        r.stats[ACCESS_REFUSED] += 1;
        refused(REFUSED_CROSSING);
        return 0;
    }
    // (the parallel build's atomics need natural alignment: an unaligned
    // access whose code cannot take an unaligned host (kind bit 9: a plain
    // store's; reads copy through the bounce slot on a hit) retries in the
    // interpreter, but the entry is filled, so the next access hits:
    // pagegen::frame)
    let unaligned = WasmBuilder::ATOMIC_GUEST_MEMORY
        && size > 1
        && address & (size.min(8) as u64 - 1) != 0
        && kind & 0x200 == 0;
    // (kind bit 11: an unprivileged access at EL1, LDTR/STTR: EL0's permissions and table)
    let el0 = cpu::el() == 0 || kind & 0x800 != 0;
    let Some((pa, _large, global)) = crate::aarch64::mmu::translate_for_cache(address, write, el0)
    else {
        r.stats[ACCESS_REFUSED] += 1;
        refused(REFUSED_TRANSLATION);
        return 0;
    };
    let host = match bus::bus().lookup(pa) {
        Lookup::Ram {
            backing, writable, ..
        } => {
            let page = backing & !0xFFF;
            // (device memory: its writes go the interpreter's way, which marks them)
            if write
                && (!writable
                    || page >= unsafe { bus::DEVICE_START }
                    || crate::aarch64::root::page_watched(page >> 12)
                    || (unsafe { RESERVED_FILL_REFUSED } || !crate::parallel::active())
                        && crate::aarch64::smp::reserved_page(page))
            {
                r.stats[ACCESS_REFUSED] += 1;
                refused(if !writable || page >= unsafe { bus::DEVICE_START } {
                    REFUSED_NOT_WRITABLE
                }
                else if crate::aarch64::root::page_watched(page >> 12) {
                    REFUSED_WATCHED
                }
                else {
                    REFUSED_RESERVED
                });
                return 0;
            }
            (unsafe { bus::MEM8 } as u32).wrapping_add(page)
        },
        // (extended RAM: its frame, held until the run loop's next safe
        // point; no write entry while a core holds a reservation in the page)
        Lookup::Extended { .. } => {
            let frame = if write
                && crate::aarch64::smp::reserved_page(crate::aarch64::extended::monitor_key(
                    pa & !0xFFF,
                )) {
                None
            }
            else {
                unsafe { crate::aarch64::extended::cache_frame(pa & !0xFFF, write) }
            };
            match frame {
                Some(frame) => frame,
                None => {
                    r.stats[ACCESS_REFUSED] += 1;
                    refused(REFUSED_EXTENDED);
                    return 0;
                },
            }
        },
        _ => {
            r.stats[ACCESS_REFUSED] += 1;
            refused(REFUSED_NOT_RAM);
            return 0;
        },
    };
    // (a tagged pointer, TBI, gets an entry too: forget_tagged)
    let core = current_core();
    access(core).fill(LAYOUT, ENTRIES, el0, write, address, host, false, global);
    if global && address >> 55 == 0 && unsafe { super::ASID_TAG } {
        let a = asids(core);
        if let Some(i) = a.current {
            a.slots[i].low_global = true;
        }
    }
    r.stats[ACCESS_FILLS] += 1;
    if unaligned {
        r.stats[ACCESS_REFUSED] += 1;
        refused(REFUSED_UNALIGNED);
        return 0;
    }
    host + (address & 0xFFF) as u32
}

/// The PC (an offset in the page) is no block start of the function: note
/// it; whether the page is due for a recompile (the function then leaves)
#[no_mangle]
pub fn a64_page_unserved(pc: u64) -> u32 {
    // (inside an IT block, a step's PC: no entry, compiled code never starts there)
    if cpu::aarch32() && crate::aarch64::t32::itstate() != 0 {
        return 0;
    }
    let mode = mode();
    let Some(key) = code_page(pc, mode)
    else {
        return 1;
    };
    let state = rt().pages.entry(key).or_default();
    let offset = (pc & 0xFFF) as u16;
    note_entry_bits(&mut state.entries, offset);
    state.misses += 1;
    (state.misses >= RECOMPILE_MISSES) as u32
}

/// What a step may change that compiled code depends on
#[derive(Clone, Copy, PartialEq, Eq)]
struct Context {
    el: u32,
    /// DAIF, SS, IL, SPSel, PAN; AArch32's state and instruction set
    /// (a step's BX or BLX: a function is one set's, Q6)
    pstate: u32,
    sctlr: u64,
    tcr: u64,
    ttbr0: u64,
    ttbr1: u64,
    mdscr: u64,
    debug: (bool, bool),
    code_writes: u64,
    epoch: u64,
}
fn context() -> Context {
    unsafe {
        Context {
            el: cpu::el(),
            pstate: cpu::get_pstate()
                & (cpu::PSTATE_DAIF
                    | cpu::PSTATE_SS
                    | PSTATE_IL
                    | cpu::PSTATE_SP
                    | cpu::PSTATE_PAN
                    | cpu::PSTATE_NRW
                    | cpu::PSTATE_T
                    | cpu::PSTATE_E),
            sctlr: *sctlr_el1,
            tcr: *tcr_el1,
            ttbr0: *ttbr0_el1,
            ttbr1: *ttbr1_el1,
            mdscr: *mdscr_el1,
            debug: (
                crate::aarch64::debug::ANY_BREAKPOINT,
                crate::aarch64::debug::ANY_WATCHPOINT,
            ),
            code_writes: CODE_WRITES,
            epoch: access(current_core()).epoch(),
        }
    }
}

/// The A64 page tier's step frontend (jitrt::step, P6.2): the interpreter's
/// `interpret_one` (P2.9); the activation ends when the step changed the
/// context, asked the run loop for something (a wait, a stop, a yield), or
/// left an interrupt the core takes pending
struct A64Step;
impl StepFrontend for A64Step {
    type Context = Context;
    fn context() -> Context { context() }
    fn interpret_one() {
        let flow = execute::interpret_one();
        let (key, word) = unsafe { execute::LAST_STEPPED };
        note_step(STEPPED, key, word);
        if matches!(flow, Flow::Wait(_) | Flow::Off | Flow::Yield | Flow::Retry) {
            unsafe { STEP_FLOW = Some(flow) };
        }
    }
    fn outcome(before: &Context) -> StepOutcome {
        // (a busy loop around a stepped counter read sees its timer's
        // interrupt: after the system register accesses and the hints, WFE
        // and WFI among them; not after SYS, TLBI and its kind, nor other
        // steps: the run loop ticks every 1024 instructions)
        let (key, word) = unsafe { execute::LAST_STEPPED };
        if word & 0xFFC0_0000 == 0xD500_0000 && word >> 19 & 3 != 1 {
            crate::aarch64::timer::tick();
        }
        let changed = context() != *before;
        if changed {
            note_step(CHANGED_CONTEXT, key, word);
        }
        // (T32: inside an IT block, which the interpreter finishes: the
        // function's next instruction may be a native IT block's, compiled
        // for ITSTATE 0)
        let it = cpu::aarch32() && crate::aarch64::t32::itstate() != 0;
        if unsafe { (*(&raw const STEP_FLOW)).is_some() } || changed || it || interrupt_pending() {
            return StepOutcome::Exit;
        }
        StepOutcome::Continue
    }
}

// Diagnostics (a64_step_stat): how often each instruction class
// (execute::step_key) was stepped, ended an activation by changing the
// context, or ran as a helper; machine-wide (every core adds), approximate
const STEPPED: usize = 0;
const CHANGED_CONTEXT: usize = 1;
const HELPED: usize = 2;
const STEP_KEYS: usize = 1024;
static mut STEP_COUNTS: [[u32; STEP_KEYS]; 3] = [[0; STEP_KEYS]; 3];
/// the last word of each class
static mut STEP_WORDS: [u32; STEP_KEYS] = [0; STEP_KEYS];
/// MRS and MSR (register) by their register (the word's bits 19:5, op0's low bit and op1:CRn:CRm:op2), MSR from 1 << 15
static mut SYSREG_COUNTS: [[u32; 1 << 16]; 3] = [[0; 1 << 16]; 3];
/// SYS (TLBI, DC, IC, AT) by op1:CRn:CRm:op2
static mut SYS_COUNTS: [[u32; 1 << 14]; 3] = [[0; 1 << 14]; 3];
#[inline(always)]
fn note_step(kind: usize, key: u32, word: u32) {
    unsafe {
        if !STEP_STATS {
            return;
        }
        STEP_SAMPLED = STEP_SAMPLED.wrapping_add(1);
        if STEP_SAMPLED % STEP_SAMPLE != 0 {
            return;
        }
    }
    let index = key as usize & (STEP_KEYS - 1);
    unsafe {
        let counts = &mut *crate::parallel::machine(&raw mut STEP_COUNTS);
        counts[kind][index] = counts[kind][index].wrapping_add(STEP_SAMPLE);
        (*crate::parallel::machine(&raw mut STEP_WORDS))[index] = word;
        // (MRS and MSR (register): which register)
        if word & 0xFFD0_0000 == 0xD510_0000 {
            let reg = (word >> 5 & 0x7FFF | (!word >> 21 & 1) << 15) as usize;
            let counts = &mut *crate::parallel::machine(&raw mut SYSREG_COUNTS);
            counts[kind][reg] = counts[kind][reg].wrapping_add(STEP_SAMPLE);
        }
        // (SYS: which operation)
        else if word & 0xFFF8_0000 == 0xD508_0000 {
            let op = (word >> 5 & 0x3FFF) as usize;
            let counts = &mut *crate::parallel::machine(&raw mut SYS_COUNTS);
            counts[kind][op] = counts[kind][op].wrapping_add(STEP_SAMPLE);
        }
    }
}
/// (diagnostics) The count of MRS (`reg` < 1 << 15) or MSR (register) of
/// the register `reg` & 0x7FFF (the word's bits 19:5), by kind as a64_step_stat
#[no_mangle]
pub fn a64_sysreg_stat(kind: u32, reg: u32) -> f64 {
    // (kinds 4-6: SYS by op1:CRn:CRm:op2, as kinds 0-2)
    if (4..=6).contains(&kind) {
        return unsafe {
            (*crate::parallel::machine(&raw mut SYS_COUNTS))[kind as usize - 4]
                [reg as usize & 0x3FFF] as f64
        };
    }
    if kind > 2 {
        return 0.0;
    }
    unsafe {
        (*crate::parallel::machine(&raw mut SYSREG_COUNTS))[kind as usize][reg as usize & 0xFFFF]
            as f64
    }
}
/// The count of class `key` (kind 0 stepped, 1 changed the context, 2 a
/// helper), or with kind 3 the class's last word
#[no_mangle]
pub fn a64_step_stat(kind: u32, key: u32) -> f64 {
    let key = key as usize & (STEP_KEYS - 1);
    unsafe {
        match kind {
            0..=2 => (*crate::parallel::machine(&raw mut STEP_COUNTS))[kind as usize][key] as f64,
            3 => (*crate::parallel::machine(&raw mut STEP_WORDS))[key] as f64,
            _ => 0.0,
        }
    }
}
/// An interrupt the PE would take now
fn interrupt_pending() -> bool {
    let signal = crate::aarch64::gic::signal(current_core());
    let state = cpu::get_pstate();
    signal & crate::aarch64::gic::SIGNAL_IRQ != 0 && state & cpu::PSTATE_I == 0
        || signal & crate::aarch64::gic::SIGNAL_FIQ != 0 && state & cpu::PSTATE_F == 0
}

/// (pagegen's TLBI template, a64_system) the TLBI `word` of Xt `value` at
/// EL1, as the interpreter does it: 1 when it changed what compiled code
/// depends on (the access cache's epoch): the function then leaves
#[no_mangle]
pub fn a64_page_tlbi(word: u32, value: u64) -> u32 {
    let core = current_core();
    let epoch = access(core).epoch();
    let crm = word >> 8 & 15;
    crate::aarch64::mmu::tlbi(crm == 3, word >> 5 & 7, value);
    note_step(
        HELPED,
        execute::step_key(&execute::decode_cached(word)),
        word,
    );
    (access(core).epoch() != epoch) as u32
}

/// (pagegen's MSR DAIF and DAIFClr templates) 1 when an interrupt is now
/// deliverable, or a debug exception may be: the function leaves for the
/// run loop to take it
#[no_mangle]
pub fn a64_page_unmasked() -> u32 {
    // (and when clearing PSTATE.D made a debug exception due: a software
    // step, a breakpoint or a watchpoint, which allowed() keeps compiled
    // code from)
    (interrupt_pending()
        || unsafe {
            crate::aarch64::debug::ANY_BREAKPOINT || crate::aarch64::debug::ANY_WATCHPOINT
        }
        || crate::aarch64::debug::stepping()) as u32
}

/// The system counter, CNTVCT_EL0 and CNTPCT_EL0 (pagegen's template: the
/// EL0 checks made)
#[no_mangle]
pub fn a64_page_counter() -> u64 { crate::aarch64::timer::counter() }

/// A helper for a page function (pagegen's helper template): the instruction
/// `word` at `pc` on the state in memory (the registers it names and NZCV
/// were written back), by the interpreter's own execute. Only forms that
/// never transfer control nor change what compiled code depends on come
/// here (pagegen::helper_kind); 0 when done, 1 when it refused before any
/// effect (an exception: the function retries it in the interpreter) or
/// was done but asks the run loop for something (HELPER_DONE)
#[no_mangle]
pub fn a64_page_helper(word: u32, pc: u64) -> u32 {
    unsafe { HELPERS += 1 };
    let inst = execute::decode_cached(word);
    note_step(HELPED, execute::step_key(&inst), word);
    match execute::execute(&inst, pc) {
        Ok(Flow::Next) => {
            crate::core_stats::add_pending(1, 0);
            0
        },
        Ok(flow @ (Flow::Yield | Flow::Wait(_) | Flow::Off)) => {
            crate::core_stats::add_pending(1, 0);
            unsafe { HELPER_DONE = Some((pc.wrapping_add(4), flow)) };
            1
        },
        _ => 1,
    }
}

/// A helper call of an AArch32 page function (pagegen::a32): the A32 or
/// T32 instruction (`length` 4, or T32's 2 or 4) executed on the state in
/// memory, as the interpreter does it without the fetch (the IT block a step
/// on); 1 when it did not simply go on to the next instruction, which the
/// compiler rules out but for its exceptions (raised before any of its
/// effects: the interpreter runs it again) and a load-exclusive's spin
/// yield (done: HELPER_DONE)
/// (diagnostics) AArch32's helper calls by instruction word: an open
/// addressed table of (word, count), new words dropped when it is full
const HELPER_WORDS_SIZE: usize = 4096;
static mut HELPER_WORDS: [(u32, u32); HELPER_WORDS_SIZE] = [(0, 0); HELPER_WORDS_SIZE];
#[inline(always)]
fn note_helper_word(word: u32) {
    let table = unsafe { &mut *crate::parallel::machine(&raw mut HELPER_WORDS) };
    let mut i = (word.wrapping_mul(0x9E37_79B1) >> 20) as usize;
    for _ in 0..8 {
        let e = &mut table[i];
        if e.1 == 0 || e.0 == word {
            *e = (word, e.1.wrapping_add(1));
            return;
        }
        i = (i + 1) % HELPER_WORDS_SIZE;
    }
}
/// (diagnostics) entry `i` of the helper words' table: `count` false the
/// word, true its count (0: empty)
#[no_mangle]
pub fn a32_helper_word(i: u32, count: bool) -> f64 {
    let e = unsafe {
        (*crate::parallel::machine(&raw mut HELPER_WORDS))[i as usize % HELPER_WORDS_SIZE]
    };
    if count {
        e.1 as f64
    }
    else {
        e.0 as f64
    }
}

#[no_mangle]
pub fn a32_page_helper(word: u32, pc: u64, length: u32) -> u32 {
    unsafe { HELPERS += 1 };
    note_helper_word(word);
    a32_trace(2, pc as u32, word);
    let thumb = cpu::get_pstate() & cpu::PSTATE_T != 0;
    note_step(
        HELPED,
        crate::aarch64::a32::step_key(word, length, thumb),
        word,
    );
    match crate::aarch64::a32::execute_fetched(word, length, pc as u32, thumb) {
        Ok(flow @ (Flow::Next | Flow::Yield | Flow::Wait(_) | Flow::Off)) => {
            crate::core_stats::add_pending(1, 0);
            if thumb {
                crate::aarch64::t32::it_advance();
            }
            if matches!(flow, Flow::Next) {
                return 0;
            }
            let next = (pc as u32).wrapping_add(length) as u64;
            unsafe { HELPER_DONE = Some((next, flow)) };
            1
        },
        _ => 1,
    }
}

/// A single step for a page function (the state is in memory)
#[no_mangle]
pub fn a64_page_step() -> i32 {
    rt().stats[STEPS] += 1;
    if cpu::aarch32() {
        a32_trace(5, cpu::get_pc() as u32, 0);
        let result = step::step::<A64Step>() as i32;
        a32_trace(8, cpu::get_pc() as u32, result as u32);
        return result;
    }
    step::step::<A64Step>() as i32
}

/// The page tier's counters (tests, diagnostics)
#[no_mangle]
pub fn a64_page_stat(n: u32) -> f64 {
    let r = rt();
    match n {
        100 => r.live() as f64,
        101 => (unsafe { WRITES }) as f64,
        102 => (unsafe { RESETS }) as f64,
        103 => r.pages.values().filter(|p| p.compiles != 0).count() as f64,
        104 => r.pages.values().map(|p| p.compiles).max().unwrap_or(0) as f64,
        105 => r.pages.values().map(|p| p.misses).sum::<u32>() as f64,
        106 => (unsafe { HELPERS }) as f64,
        107 => (unsafe { EVICTIONS }) as f64,
        108 => unsafe { COMPILE_MS },
        109 => (unsafe { AUTO_SWITCHES }) as f64,
        110 => (unsafe { super::ASID_TAG }) as u32 as f64,
        111 => (unsafe { LIVE_BYTES }) as f64,
        120..=127 => (unsafe { REFUSED[n as usize - 120] }) as f64,
        _ => r.stats.get(n as usize).copied().unwrap_or(0) as f64,
    }
}
