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
use std::collections::HashSet;

extern "C" {
    fn call_indirect1_ret(f: i32, x: u16) -> i32;
}

// ---- switches (crate::aarch64::jit's registry)

/// The page tier runs (a64_page; default off until its F gate)
pub static mut ENABLED: bool = false;
/// Interpreted instructions on a page before it is compiled
pub static mut HOT: u32 = 2000;
/// Unserved entries of a published function before its page is recompiled
const RECOMPILE_MISSES: u32 = 64;
/// The most functions (this client's quota of the core's table)
pub const MAX_FUNCTIONS: u32 = 9000;
/// Instructions an activation may retire: the run loop ticks the timers
/// and takes interrupts between activations (a step ticks them too)
const MAX_BUDGET: u32 = 1 << 14;

// ---- keys and modes

/// A function's key: the code key (below 2^28) with its mode's bits
const MODE_SHIFT: u32 = 28;
/// Modes: bit 0 EL1, bit 1 SP alignment checked
pub const MODES: usize = 4;

/// The mode the running core's code would be compiled for
#[inline(always)]
fn mode() -> u32 {
    let el1 = cpu::el() != 0;
    let sctlr = cpu::sctlr();
    let sp_checked = sctlr & if el1 { cpu::SCTLR_SA } else { cpu::SCTLR_SA0 } != 0;
    el1 as u32 | (sp_checked as u32) << 1
}

// ---- the access cache (jitrt::access) and the chaining tables (jitrt::chain)

/// A64's tags: the virtual page below bit 52, the epoch above (with
/// a64_asid_tag, the ASID's: bind_asid); a tagged pointer (TBI) gets no
/// entry, since a TLBI by VA names the page untagged; regions: no block
/// marks them (the TLB decides when a page's invalidation flushes,
/// tlb::flush_page)
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
#[derive(Default)]
pub struct A64Code;
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

/// A function is retired: its chaining entries and fast entries go
fn retire(r: &mut Runtime, index: usize) {
    if !r.kill(index) {
        return;
    }
    let f = &r.functions[index];
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
    for c in 0..MAX_CORES {
        if monitors & 1 << c != 0 {
            hosts[count] = mem8.wrapping_add(crate::aarch64::smp::reserved_backing(c) & !0xFFF);
            count += 1;
        }
    }
    access(core).retire_writes(ENTRIES, |entry| hosts[..count].contains(&entry.host));
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
    let Lookup::Ram { code_key, .. } = bus::bus().lookup(pa)
    else {
        return None;
    };
    if code_key >= 1 << MODE_SHIFT {
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
    if !allowed() || budget == 0 {
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
                return execute(slot, budget, pc);
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

/// The flow a step asked for (a wait, a stop, a yield) while compiled code ran
static mut STEP_FLOW: Option<Flow> = None;

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
    }
    let r = rt();
    r.stats[ACTIVATIONS] += 1;
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
        EXIT_RETRY => {
            // (the instruction at the PC: a template refused it before any of its effects)
            r.stats[RETRIES] += 1;
            let f = execute::interpret_one();
            if !matches!(f, Flow::Set) {
                retired += 1;
            }
            if matches!(f, Flow::Wait(_) | Flow::Off | Flow::Yield) {
                flow = f;
            }
        },
        EXIT_UNKNOWN => r.stats[UNKNOWN] += 1,
        _ => {},
    }
    release_dead(rt());
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
    let bytes =
        unsafe { std::slice::from_raw_parts(bus::MEM8.add((code_key << 12) as usize), 4096) }
            .to_vec();
    let name = format!(
        "a64_page{}_{:x}",
        if mode & 1 != 0 { "_el1" } else { "_el0" },
        pc & !0xFFF
    );
    let started = unsafe { crate::isa::microtick() };
    let compiled = pagegen::compile(
        &bytes,
        &entries,
        pagegen::CompileEnv {
            el1: mode & 1 != 0,
            sp_checked: mode & 2 != 0,
            chaining: unsafe { CHAINING },
            neon: unsafe { super::NEON },
            helpers: unsafe { super::HELPERS },
            relaxed_fma: unsafe { super::RELAXED_FMA },
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
            .attach(slot, HashSet::from([Page::page_of(code_key << 12)]));
        slot
    };
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
                x: A64Code,
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
        x: A64Code,
    };
    r.by_page.insert(key, index);
    r.generation = r.generation.wrapping_add(1);
    r.stats[COMPILED] += 1;
    r.stats[INSTRUCTIONS] += code.instructions as u64;
    r.stats[TEMPLATED] += code.templated as u64;
    publish::publish(ClientId::A64Page, id, slot, &code.bytes);
}

// publication's answers (jitrt::publish)
fn install(id: u64, slot: u32) -> bool { rt().pending(id, slot).is_some() }
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
    if (address & 0xFFF) + size as u64 > 0x1000 {
        r.stats[ACCESS_REFUSED] += 1;
        return 0;
    }
    let el0 = cpu::el() == 0;
    let Some((pa, _large, global)) = crate::aarch64::mmu::translate_for_cache(address, write, el0)
    else {
        r.stats[ACCESS_REFUSED] += 1;
        return 0;
    };
    let Lookup::Ram {
        backing, writable, ..
    } = bus::bus().lookup(pa)
    else {
        r.stats[ACCESS_REFUSED] += 1;
        return 0;
    };
    let page = backing & !0xFFF;
    // (device memory: its writes go the interpreter's way, which marks them)
    if write
        && (!writable
            || page >= unsafe { bus::DEVICE_START }
            || crate::aarch64::root::page_watched(page >> 12)
            || crate::aarch64::smp::reserved_page(page))
    {
        r.stats[ACCESS_REFUSED] += 1;
        return 0;
    }
    let host = (unsafe { bus::MEM8 } as u32).wrapping_add(page);
    // (a tagged pointer, TBI: no entry, since a TLBI names the page untagged)
    if ((address << 8) as i64 >> 8) as u64 != address {
        return host + (address & 0xFFF) as u32;
    }
    let core = current_core();
    access(core).fill(LAYOUT, ENTRIES, el0, write, address, host, false, global);
    if global && address >> 55 == 0 && unsafe { super::ASID_TAG } {
        let a = asids(core);
        if let Some(i) = a.current {
            a.slots[i].low_global = true;
        }
    }
    r.stats[ACCESS_FILLS] += 1;
    host + (address & 0xFFF) as u32
}

/// The PC (an offset in the page) is no block start of the function: note
/// it; whether the page is due for a recompile (the function then leaves)
#[no_mangle]
pub fn a64_page_unserved(pc: u64) -> u32 {
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
    /// DAIF, SS, IL, SPSel
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
                & (cpu::PSTATE_DAIF | cpu::PSTATE_SS | PSTATE_IL | cpu::PSTATE_SP),
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
        if matches!(flow, Flow::Wait(_) | Flow::Off | Flow::Yield) {
            unsafe { STEP_FLOW = Some(flow) };
        }
    }
    fn outcome(before: &Context) -> StepOutcome {
        // (a busy loop around a stepped counter read sees its timer's interrupt)
        crate::aarch64::timer::tick();
        if unsafe { (*(&raw const STEP_FLOW)).is_some() }
            || context() != *before
            || interrupt_pending()
        {
            return StepOutcome::Exit;
        }
        StepOutcome::Continue
    }
}
/// An interrupt the PE would take now
fn interrupt_pending() -> bool {
    let signal = unsafe { crate::aarch64::gic::SIGNAL[current_core()] };
    let state = cpu::get_pstate();
    signal & crate::aarch64::gic::SIGNAL_IRQ != 0 && state & cpu::PSTATE_I == 0
        || signal & crate::aarch64::gic::SIGNAL_FIQ != 0 && state & cpu::PSTATE_F == 0
}

/// A helper for a page function (pagegen's helper template): the instruction
/// `word` at `pc` on the state in memory (the registers it names and NZCV
/// were written back), by the interpreter's own execute. Only forms that
/// never transfer control nor change what compiled code depends on come
/// here (pagegen::helper_kind); 0 when done, 1 when it refused before any
/// effect (an exception: the function retries it in the interpreter)
#[no_mangle]
pub fn a64_page_helper(word: u32, pc: u64) -> u32 {
    unsafe { HELPERS += 1 };
    let inst = execute::decode_cached(word);
    match execute::execute(&inst, pc) {
        Ok(Flow::Next) => {
            crate::core_stats::add_pending(1, 0);
            0
        },
        _ => 1,
    }
}

/// A single step for a page function (the state is in memory)
#[no_mangle]
pub fn a64_page_step() -> i32 {
    rt().stats[STEPS] += 1;
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
        _ => r.stats.get(n as usize).copied().unwrap_or(0) as f64,
    }
}
