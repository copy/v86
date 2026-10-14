//! Bounded automatic compilation at outer CPU dispatch points. Linked entries
//! contribute heat only; no compiler or publisher runs with guest locals alive.
use super::diagnostics::{CompileScope, Scope, Stage};
use super::hot_index::HotIndex;
use super::pages::{PageKey, Pages};
use super::{
    cache,
    compile::*,
    entry::CpuEntryKey,
    live::{self, Job},
    promotion::{Attempt, Ticket},
    region,
};
use crate::{cpu::global_pointers as gp, ir::backend::wasm::StateLayout, jit};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
// Larger heat sets remain an explicit experiment: they retain more recurrent
// PCs but regressed XP by increasing compilation/cache pressure.
const MAX_HOT_CAPACITY: usize = 512;
const MAX_FRAME_SCAN: usize = 128;
#[derive(Clone, Copy)]
struct Config {
    enabled: bool,
    threshold: u32,
    promote: u32,
    window: u32,
    budget: u32,
    rep: u32,
}
struct Hot {
    entry: CpuEntryKey,
    hits: u32,
    source: Option<ImmutableCodeSnapshot>,
    failed: u32,
    discovered: Option<f64>,
}
struct Queued {
    job: Job,
    promotion: Option<Attempt>,
}
struct Pending {
    id: u64,
    slot: u32,
    entries: Vec<(CpuEntryKey, Option<f64>)>,
    tier: u32,
    promotion: Option<Attempt>,
    page: Option<PageKey>,
}
struct Scheduler {
    debug: crate::ir::debug::Config,
    opt_level: u32,
    passes_disabled: u32,
    config: Config,
    hot: Vec<Hot>,
    hot_capacity: usize,
    hot_index: HotIndex,
    hot_hints: [u16; 256],
    hot_filter: bool,
    probation: [Option<(CpuEntryKey, Option<f64>)>; 256],
    cursor: usize,
    replacement: usize,
    pending: Option<Pending>,
    ready: VecDeque<Queued>,
    prefer_promotion: bool,
    resident_promotion: bool,
    credit: bool,
    scan_credit: bool,
    interpreted_ready: Option<CpuEntryKey>,
    stats: [u32; 24],
    /// Page-granular compilation (default). Region compilation remains the
    /// fallback for pages whose page function cannot be built.
    page_mode: bool,
    pages: Pages,
    page_tier2: u32,
    /// Interpreted visits a code page needs before its first compilation.
    page_threshold: u32,
    /// Compile while the guest is halted (HLT) instead of inside busy CPU
    /// frames; synchronous compilation resumes only after `sync_after` ms
    /// without an idle window (CPU-bound phases never starve).
    idle_mode: bool,
    frame_start: f64,
    last_idle: f64,
    sync_after: f64,
    /// Compilation/publication attempts (lets idle work detect progress).
    work: u32,
    idle_ms: f64,
    idle_compiles: u32,
    /// Entries that crossed a compilation threshold, kept until an idle window
    /// (or a synchronous fallback) compiles them. The bounded hot ring turns
    /// over within milliseconds; its heat alone does not survive until then.
    candidates: VecDeque<(CpuEntryKey, u32)>,
}
static SCHEDULER: Mutex<Scheduler> = Mutex::new(Scheduler {
    debug: crate::ir::debug::Config {
        verify: crate::ir::debug::VerifyMode::Debug,
        dump: crate::ir::debug::DumpMode::Off,
    },
    opt_level: 2,
    passes_disabled: 0,
    config: Config {
        enabled: false,
        threshold: 64,
        promote: 256,
        window: 192,
        budget: 256,
        rep: 64,
    },
    hot: Vec::new(),
    hot_capacity: 128,
    hot_index: HotIndex::new(),
    hot_hints: [u16::MAX; 256],
    hot_filter: false,
    probation: [None; 256],
    cursor: 0,
    replacement: 0,
    pending: None,
    ready: VecDeque::new(),
    prefer_promotion: true,
    resident_promotion: false,
    credit: false,
    scan_credit: false,
    interpreted_ready: None,
    stats: [0; 24],
    page_mode: false,
    pages: Pages::new(),
    page_tier2: 0,
    page_threshold: 512,
    idle_mode: false,
    frame_start: 0.0,
    last_idle: f64::NEG_INFINITY,
    sync_after: 16.0,
    work: 0,
    idle_ms: 0.0,
    idle_compiles: 0,
    candidates: VecDeque::new(),
});
static mut FORCED: bool = false;
static mut DIRECT_T2: bool = false;
#[no_mangle]
pub unsafe fn ir_auto_set_direct_tier2(enabled: u32) { DIRECT_T2 = enabled != 0; }
#[link(wasm_import_module = "env")]
extern "C" {
    fn ir_codegen_finalize(id: u64, slot: u32, ptr: u32, len: u32);
}
pub fn invalidate() {
    let mut s = SCHEDULER.try_lock().unwrap();
    s.hot.clear();
    s.hot_index.clear();
    s.probation.fill(None);
    s.cursor = 0;
    s.replacement = 0;
    s.pending = None;
    s.ready.clear();
    s.prefer_promotion = true;
    s.credit = false;
    s.scan_credit = false;
    s.interpreted_ready = None;
    s.pages.clear();
}
pub fn dirty_page(page: u32) {
    let mut s = SCHEDULER.try_lock().unwrap();
    s.pages.dirty(page);
    let previous_len = s.hot.len();
    s.ready.retain(|job| {
        !job.job
            .artifact
            .dependencies
            .iter()
            .any(|d| d.page.0 == page)
    });
    s.hot.retain(|h| {
        !h.source
            .as_ref()
            .is_some_and(|source| source.dependencies.iter().any(|d| d.page.0 == page))
    });
    if s.hot.len() != previous_len {
        rebuild_hot_index(&mut s);
    }
}
fn rebuild_hot_index(s: &mut Scheduler) {
    s.hot_index.clear();
    for (index, h) in s.hot.iter().enumerate() {
        s.hot_index.insert(h.entry, index);
    }
    s.cursor = 0;
    s.replacement = 0;
}
/// Whether the IR scheduler compiles (config.enabled): a lock-free mirror,
/// read by every long-mode instruction outside compiled code
/// (docs/jit-unification-plan.md P4.5a), written only with config
static ENABLED: AtomicBool = AtomicBool::new(false);
pub fn enabled() -> bool { ENABLED.load(Ordering::Relaxed) }
/// Startup-only mirror for cold scheduling, never an execution certificate.
/// Keeping it under this existing guard makes the default-off scan cost zero
/// additional cache locks. Reset/configuration preserve the chosen policy.
pub(super) fn set_resident_promotion(enabled: bool) -> bool {
    let mut s = SCHEDULER.try_lock().unwrap();
    if s.config.enabled
        || !s.hot.is_empty()
        || s.pending.is_some()
        || !s.ready.is_empty()
        || !cache::set_resident_promotion(enabled)
    {
        return false;
    }
    s.resident_promotion = enabled;
    true
}
/// Startup-only bounded working-set experiment. Reset/restore keep the chosen
/// policy; changing it requires a disabled, empty scheduler and no IR artifacts.
#[no_mangle]
pub unsafe fn ir_auto_set_hot_capacity(entries: u32) -> bool {
    if !(128..=MAX_HOT_CAPACITY as u32).contains(&entries)
        || !cold()
        || cache::ir_cache_stat(1) != 0
    {
        return false;
    }
    let mut s = SCHEDULER.try_lock().unwrap();
    if s.config.enabled || !s.hot.is_empty() || s.pending.is_some() || !s.ready.is_empty() {
        return false;
    }
    s.hot_capacity = entries as usize;
    s.probation.fill(None);
    s.cursor = 0;
    s.replacement = 0;
    true
}
/// Startup-only experiment: admission filtering can save bookkeeping while
/// increasing compilation of marginally hot PCs. Keep it opt-in after XP A/B.
#[no_mangle]
pub unsafe fn ir_auto_set_hot_filter(enabled: u32) -> bool {
    if enabled > 1 || !cold() {
        return false;
    }
    let mut s = SCHEDULER.try_lock().unwrap();
    if !s.hot.is_empty() || s.pending.is_some() || !s.ready.is_empty() {
        return false;
    }
    s.hot_filter = enabled != 0;
    s.probation.fill(None);
    true
}
/// Startup-only policy: no enabled scheduler, pending work or cached artifacts.
/// Snapshot restore/reset keep the destination policy, like backend selection.
#[no_mangle]
pub unsafe fn ir_auto_optimizations(level: u32, disabled: u32) -> bool {
    if level > 2
        || disabled & !crate::ir::passes::PassConfig::MASK != 0
        || !cold()
        || cache::ir_cache_stat(1) != 0
    {
        return false;
    }
    let mut s = SCHEDULER.try_lock().unwrap();
    if s.config.enabled || s.pending.is_some() || !s.ready.is_empty() {
        return false;
    }
    s.opt_level = level;
    s.passes_disabled = disabled;
    true
}
#[no_mangle]
pub unsafe fn ir_auto_debug(verify: u32, dump: u32) -> bool {
    let Some(config) = crate::ir::debug::Config::from_raw(verify, dump)
    else {
        return false;
    };
    if !cold() || cache::ir_cache_stat(1) != 0 {
        return false;
    }
    let mut s = SCHEDULER.try_lock().unwrap();
    if s.config.enabled || s.pending.is_some() || !s.ready.is_empty() {
        return false;
    }
    s.debug = config;
    crate::ir::debug::set_audit(config.verify == crate::ir::debug::VerifyMode::EveryPass);
    crate::ir::debug::ir_dump_clear();
    true
}
#[no_mangle]
pub fn ir_auto_optimization_stat(field: u32) -> u32 {
    let s = SCHEDULER.try_lock().unwrap();
    match field {
        0 => s.opt_level,
        1 => s.passes_disabled,
        2 => s.debug.verify as u32,
        3 => s.debug.dump as u32,
        _ => 0,
    }
}
pub fn begin_frame(now: f64) {
    let mut s = SCHEDULER.try_lock().unwrap();
    // (the step profile, docs/jit-unification-plan.md P4.0: frames)
    if crate::step_profile::enabled() {
        unsafe { crate::step_profile::note_event(crate::step_profile::event::FRAME, 0) };
    }
    s.credit = true;
    s.scan_credit = true;
    s.interpreted_ready = None;
    s.frame_start = now;
}
/// Guest halted until the next timer in `budget` ms: compile and publish
/// queued candidates now. Returns the milliseconds spent (the caller shortens
/// its idle wait, so timer delivery is not delayed by this work).
pub unsafe fn idle(budget: f64) -> f64 {
    if budget < 0.5 || !cold() {
        return 0.0;
    }
    let start = crate::cpu::cpu::js::microtick();
    {
        let mut s = SCHEDULER.try_lock().unwrap();
        if !s.config.enabled || !s.idle_mode || s.pending.is_some() {
            return 0.0;
        }
        s.last_idle = start;
    }
    FORCED = true;
    for _ in 0..256 {
        let before = {
            let mut s = SCHEDULER.try_lock().unwrap();
            s.credit = true;
            s.scan_credit = true;
            s.work
        };
        visit();
        let s = SCHEDULER.try_lock().unwrap();
        if s.work == before
            || s.pending.is_some()
            || crate::cpu::cpu::js::microtick() - start >= budget
        {
            break;
        }
    }
    FORCED = false;
    let end = crate::cpu::cpu::js::microtick();
    let mut s = SCHEDULER.try_lock().unwrap();
    s.last_idle = end;
    s.idle_ms += end - start;
    end - start
}
/// Startup/cold-point policy: compile during guest idle windows (off by
/// default: the JIT switch ir_idle_mode; docs/jit-unification-plan.md open
/// question 6).
#[no_mangle]
pub unsafe fn ir_auto_set_idle_mode(enabled: u32, sync_after_ms: u32) -> bool {
    if enabled > 1 || !(1..=10_000).contains(&sync_after_ms) || !cold() {
        return false;
    }
    let mut s = SCHEDULER.try_lock().unwrap();
    s.idle_mode = enabled != 0;
    s.sync_after = sync_after_ms as f64;
    true
}
/// An evicted region must earn fresh heat. Historical visits must not make a
/// working set larger than the cache continually recompile inactive entries.
pub(super) fn evicted(entry: CpuEntryKey) {
    let mut s = SCHEDULER.try_lock().unwrap();
    s.pages.unserve(&[entry]);
    if let Some(h) = s.hot.iter_mut().find(|h| h.entry == entry) {
        h.hits = 0;
    }
}
/// Startup/cold-point page heat threshold (interpreted visits per page).
#[no_mangle]
pub unsafe fn ir_auto_set_page_threshold(visits: u32) -> bool {
    if !(1..=1_000_000).contains(&visits) || !cold() {
        return false;
    }
    SCHEDULER.try_lock().unwrap().page_threshold = visits;
    true
}
/// Startup/cold-point A/B policy: page-granular versus region compilation.
#[no_mangle]
pub unsafe fn ir_auto_set_page_mode(enabled: u32) -> bool {
    if enabled > 1 || !cold() {
        return false;
    }
    let mut s = SCHEDULER.try_lock().unwrap();
    if s.pending.is_some() || !s.ready.is_empty() {
        return false;
    }
    s.page_mode = enabled != 0;
    s.pages.clear();
    true
}
/// ir_tier0 (since docs/jit-unification-plan.md P7.5 deleted IR Tier-0, an
/// alias): whether the x64 page tier compiles 32-bit legacy and
/// compatibility-mode code (crate::x64::pages::set_page32_tier0), which
/// x64_page_legacy32 and x64_page_compat32 select. Off, as region-only
/// configurations set it, legacy-mode code stays with the region tier.
static mut TIER0: bool = false;
#[no_mangle]
pub unsafe fn ir_auto_set_tier0(enabled: u32) -> bool {
    if enabled > 1 || !cold() {
        return false;
    }
    TIER0 = enabled != 0;
    crate::x64::pages::set_page32_tier0(TIER0);
    if TIER0 {
        reserve_compiler_heap();
    }
    true
}
/// The values of this module's switches (crate::jit_switches)
pub unsafe fn switch_value(name: &str) -> Option<u32> {
    let s = SCHEDULER.try_lock().ok()?;
    Some(match name {
        "ir_tier0" => TIER0 as u32,
        "ir_page_mode" => s.page_mode as u32,
        "ir_page_threshold" => s.page_threshold,
        "ir_hot_filter" => s.hot_filter as u32,
        "ir_hot_capacity" => s.hot_capacity as u32,
        "ir_heat_steps" => HEAT_STEPS_PER_VISIT,
        "ir_direct_tier2" => DIRECT_T2 as u32,
        "ir_idle_mode" => s.idle_mode as u32,
        "ir_idle_sync_ms" => s.sync_after as u32,
        "ir_resident_promotion" => s.resident_promotion as u32,
        _ => return None,
    })
}
unsafe fn cold() -> bool { !cache::busy() && jit::ir_cache_quiescent() }
/// Grow the Wasm heap once for the compiler's working set: every later
/// memory.grow of the (multi-GiB) guest memory makes the host re-account it as
/// external memory and collect, so many small grows cost far more than one.
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
#[no_mangle]
pub unsafe fn ir_auto_config(
    enabled: u32,
    threshold: u32,
    promote: u32,
    window: u32,
    budget: u32,
    rep: u32,
) -> bool {
    if !cold()
        || enabled > 1
        || !(1..=1_000_000).contains(&threshold)
        || !(1..=1_000_000).contains(&promote)
        || !(15..=960).contains(&window)
        || !(1..=4096).contains(&budget)
        || !(1..=4096).contains(&rep)
    {
        return false;
    }
    let pending = {
        let mut s = SCHEDULER.try_lock().unwrap();
        ENABLED.store(enabled != 0, Ordering::Relaxed);
        s.config = Config {
            enabled: enabled != 0,
            threshold,
            promote,
            window,
            budget,
            rep,
        };
        s.hot.clear();
        s.ready.clear();
        s.hot_index.clear();
        s.probation.fill(None);
        s.cursor = 0;
        s.replacement = 0;
        s.credit = false;
        s.scan_credit = false;
        s.interpreted_ready = None;
        s.prefer_promotion = true;
        s.pending.take()
    };
    cache::configure_promotion(enabled != 0, promote);
    configure_heat(threshold);
    if let Some(p) = pending {
        cache::ir_cache_cancel(p.id, p.slot);
        cache::ir_cache_collect();
    }
    true
}
unsafe fn record(entry: CpuEntryKey, interpreted: bool) { record_weighted(entry, interpreted, 1) }
unsafe fn record_weighted(entry: CpuEntryKey, interpreted: bool, weight: u32) {
    let mut s = SCHEDULER.try_lock().unwrap();
    // Interpreted visits are recorded after their block retired: the caller
    // checked prefix/HLT state at the block's entry instead.
    if !s.config.enabled || !interpreted && (*gp::prefixes != 0 || *gp::in_hlt) {
        return;
    }
    // Page functions are limited to 32-bit code: a real-mode boot-loader
    // regression remains unexplained in 16-bit page functions.
    if s.page_mode && interpreted && entry.default_32 {
        let threshold = s.page_threshold;
        // Only entries of pages that cannot be compiled whole keep the
        // bounded region heat ring.
        if !s.pages.visit(entry, threshold) {
            return;
        }
    }
    // Profile the exact same visits, but bypass tree lookup for stable hot PCs.
    // Replacement/compaction cannot give the hint authority: compare full entry.
    let hint = ((entry.linear.0 >> 1 ^ entry.pc.0 >> 12) & 255) as usize;
    let saved = s.hot_hints[hint] as usize;
    let index = if s.hot.get(saved).is_some_and(|h| h.entry == entry) {
        Some(saved)
    }
    else {
        s.hot_index.get(entry)
    };
    let recorded_index = if let Some(index) = index {
        s.hot_hints[hint] = index as u16;
        let h = &mut s.hot[index];
        let old = h.hits;
        h.hits = h.hits.saturating_add(weight);
        let (hits, failed) = (h.hits, h.failed);
        let crossed = |threshold: u32| old < threshold && hits >= threshold;
        if s.idle_mode && failed == 0 {
            let tier = if crossed(s.config.threshold) {
                Some(1)
            }
            else if crossed(s.config.promote) && !interpreted {
                Some(2)
            }
            else {
                None
            };
            if let Some(tier) = tier {
                if s.candidates.len() < 512 && !s.candidates.contains(&(entry, tier)) {
                    s.candidates.push_back((entry, tier));
                }
            }
        }
        index
    }
    else {
        // A single-use PC does not displace a recurrent entry. The witness owns
        // no code and carries no admission authority; count both observed visits
        // when promoting it into the hot ring. Threshold-one tests remain exact.
        let witness = s.probation[hint].filter(|(key, _)| *key == entry);
        if s.hot_filter && s.config.threshold > 1 && witness.is_none() {
            s.probation[hint] = Some((entry, super::diagnostics::discovery_start()));
            s.stats[19] = s.stats[19].wrapping_add(1);
            return;
        }
        s.probation[hint] = None;
        let new = Hot {
            entry,
            hits: if witness.is_some() { weight + 1 } else { weight },
            source: None,
            failed: 0,
            discovered: witness
                .and_then(|(_, start)| start)
                .or_else(super::diagnostics::discovery_start),
        };
        let index = if s.hot.len() == s.hot_capacity {
            let index = s.replacement;
            s.replacement = if index + 1 == s.hot_capacity { 0 } else { index + 1 };
            let old = std::mem::replace(&mut s.hot[index], new);
            s.hot_index.remove(old.entry);
            s.stats[18] = s.stats[18].wrapping_add(1);
            index
        }
        else {
            let index = s.hot.len();
            s.hot.push(new);
            index
        };
        s.hot_index.insert(entry, index);
        s.hot_hints[hint] = index as u16;
        index
    };
    // Record the PC that actually earned compilation, not merely that some
    // interpreted work happened. A cross-page edge can leave it before visit(),
    // while the next (cold) PC has no useful heat. This hint only selects work:
    // visit rechecks the full key, heat, failure state and current cache tier.
    let hot = &s.hot[recorded_index];
    if interpreted
        && s.interpreted_ready.is_none()
        && hot.hits >= s.config.threshold
        && hot.failed == 0
    {
        s.interpreted_ready = Some(entry);
    }
}
/// Admission already knows whether this entry can benefit from more heat.
/// Finished Tier-2 traces must not evict unpublished PCs from the small hot ring.
#[inline(always)]
pub unsafe fn note_cached(entry: CpuEntryKey, linked: bool, needs_heat: bool) {
    if linked {
        let mut s = SCHEDULER.try_lock().unwrap();
        if s.config.enabled {
            s.stats[1] = s.stats[1].wrapping_add(1);
        }
    }
    if needs_heat {
        record(entry, false);
    }
}
/// Interpreted heat is weighted by executed guest instructions, like the
/// legacy JIT's per-page heat, and accumulates in a large tagged direct-mapped
/// table instead of the bounded ring: a flood of cold PCs only ages a resident
/// slot, so a recurrent hot entry cannot be displaced before it is compiled.
/// Only an entry whose heat crosses the threshold reaches the ring (with the
/// visit threshold as its weight), which leaves the ring a short list of real
/// candidates. The table grants no execution authority: collisions, aging and
/// resets only change when compilation is attempted.
#[derive(Clone, Copy)]
struct HeatSlot {
    linear: u32,
    pc: u32,
    default_32: bool,
    heat: u32,
}
const HEAT_SLOTS: usize = 1 << 14;
const EMPTY_HEAT: HeatSlot = HeatSlot {
    linear: 0,
    pc: 0,
    default_32: false,
    heat: 0,
};
static mut HEAT: [HeatSlot; HEAT_SLOTS] = [EMPTY_HEAT; HEAT_SLOTS];
// Instruction-weighted threshold; zero keeps exact per-visit ring heat for
// small (test and explicitly tuned) visit thresholds.
static mut HEAT_STEPS: u32 = 0;
// Guest instructions charged per visit of the configured visit threshold. The
// default 32 visits x 4096 = 131072 interpreted instructions, comparable to the
// legacy JIT's 50K-200K per page. An XP boot compiles ~1000 regions with this
// threshold (all resident); lower thresholds compile 2-4x more regions whose
// compilation cost exceeds their interpretation savings.
static mut HEAT_STEPS_PER_VISIT: u32 = 4096;
#[inline(always)]
fn heat_slot(entry: CpuEntryKey) -> usize {
    let bits = entry.linear.0 ^ entry.pc.0.rotate_left(11) ^ u32::from(entry.default_32);
    (bits.wrapping_mul(0x9E3779B1) >> (32 - 14)) as usize
}
/// Startup/tuning knob: guest instructions charged per configured visit.
/// Zero restores per-visit heat. Applies at the next ir_auto_config.
#[no_mangle]
pub unsafe fn ir_auto_set_heat_steps(steps_per_visit: u32) -> bool {
    if steps_per_visit > 65536 {
        return false;
    }
    HEAT_STEPS_PER_VISIT = steps_per_visit;
    configure_heat(SCHEDULER.try_lock().unwrap().config.threshold);
    true
}
unsafe fn configure_heat(threshold: u32) {
    HEAT = [EMPTY_HEAT; HEAT_SLOTS];
    HEAT_STEPS = if threshold >= 32 { threshold.saturating_mul(HEAT_STEPS_PER_VISIT) } else { 0 };
}
/// One interpreted basic block starting at `entry` (outside HLT and any
/// prefix, checked by the caller before interpretation) retired `steps` guest
/// instructions.
pub unsafe fn note_interpreted(entry: CpuEntryKey, steps: u32) {
    if HEAT_STEPS == 0 {
        record(entry, true);
        return;
    }
    let steps = steps.max(1);
    let slot = &mut HEAT[heat_slot(entry)];
    if slot.linear == entry.linear.0 && slot.pc == entry.pc.0 && slot.default_32 == entry.default_32
    {
        slot.heat = slot.heat.saturating_add(steps);
    }
    else if slot.heat <= steps {
        *slot = HeatSlot {
            linear: entry.linear.0,
            pc: entry.pc.0,
            default_32: entry.default_32,
            heat: steps,
        };
    }
    else {
        slot.heat -= steps;
        return;
    }
    if slot.heat >= HEAT_STEPS {
        slot.heat = 0;
        let weight = SCHEDULER.try_lock().unwrap().config.threshold;
        record_weighted(entry, true, weight);
    }
}
pub(super) fn diagnose_missing(entry: CpuEntryKey) {
    let s = SCHEDULER.try_lock().unwrap();
    let reason = if s
        .pending
        .as_ref()
        .is_some_and(|p| p.entries.iter().any(|(key, _)| *key == entry))
        || s.ready.iter().any(|j| j.job.artifact.accepts_entry(entry))
    {
        3
    }
    else {
        match s.hot_index.get(entry).map(|i| &s.hot[i]) {
            None => {
                let hint = ((entry.linear.0 >> 1 ^ entry.pc.0 >> 12) & 255) as usize;
                u32::from(s.probation[hint].is_some_and(|(key, _)| key == entry)) as usize
            },
            Some(h) if h.failed != 0 => 4,
            Some(h) if h.hits < s.config.threshold => 1,
            Some(_) => 2,
        }
    };
    super::diagnostics::missing(reason);
}
/// Tier-aware reachable-CFG source selection. Direct targets outside the
/// bounded immutable window remain explicit exits in the shared frontend.
unsafe fn source(entry: CpuEntryKey, window: u32, tier: u32) -> Option<ImmutableCodeSnapshot> {
    let _clock = CompileScope::new(1);
    region::capture_region(entry, if tier == 1 { Tier::One } else { Tier::Two }, window)
}
fn same(a: &ImmutableCodeSnapshot, b: &ImmutableCodeSnapshot) -> bool {
    a.bytes == b.bytes && a.mappings == b.mappings
}
fn failed(
    entry: CpuEntryKey,
    tier: u32,
    source: Option<ImmutableCodeSnapshot>,
    ticket: Option<Ticket>,
) {
    if let Some(ticket) = ticket {
        cache::promotion_failed(ticket, source.clone());
    }
    let mut s = SCHEDULER.try_lock().unwrap();
    s.stats[6] = s.stats[6].wrapping_add(1);
    if let Some(h) = s.hot.iter_mut().find(|h| h.entry == entry) {
        h.source = source;
        h.failed = tier;
    }
}
/// True only when this call submitted a new module to the asynchronous host
/// installer. The CPU may hand off once at this cold point; an existing pending
/// Promise returns false, so delayed/failed compilation never stalls the guest.
pub unsafe fn visit() -> bool {
    {
        let mut s = SCHEDULER.try_lock().unwrap();
        if s.config.enabled && *gp::prefixes == 0 && !*gp::in_hlt {
            s.stats[0] = s.stats[0].wrapping_add(1);
        }
        if !s.config.enabled || s.pending.is_some() {
            return false;
        }
        // There is no work requiring a quiescence check once compilation or
        // scan credit is exhausted. Ready artifacts have a separate publication
        // budget and MUST bypass this rejection (including sibling entries).
        // This is only a negative work hint, never execution/publication authority.
        if !FORCED
            && s.ready.is_empty()
            && (!s.credit || !s.scan_credit && s.interpreted_ready.is_none())
        {
            s.stats[22] = s.stats[22].wrapping_add(1);
            return false;
        }
        s.stats[23] = s.stats[23].wrapping_add(1);
    }
    if !cold() {
        return false;
    }
    let ready = {
        let mut s = SCHEDULER.try_lock().unwrap();
        // Publication and compilation have different budgets. An already
        // compiled sibling must not wait another frame merely to reach JS.
        s.ready.pop_front()
    };
    if let Some(job) = ready {
        SCHEDULER.try_lock().unwrap().work += 1;
        return yields(publish(job));
    }
    {
        // Busy frames defer compilation to the next guest idle window, unless
        // the guest has not halted for a while (a CPU-bound phase).
        let s = SCHEDULER.try_lock().unwrap();
        if !FORCED && s.idle_mode && s.frame_start - s.last_idle < s.sync_after {
            return false;
        }
    }
    let page_work = {
        let mut s = SCHEDULER.try_lock().unwrap();
        if s.page_mode && s.credit {
            let promote = s.config.promote;
            match s.pages.take_ready() {
                Some((key, entries)) => Some((key, entries, 1)),
                None => cache::next_page_promotion(promote)
                    .map(|entries| (PageKey::of(entries[0]), entries, 2)),
            }
        }
        else {
            None
        }
    };
    if let Some((key, entries, tier)) = page_work {
        {
            let mut s = SCHEDULER.try_lock().unwrap();
            s.credit = false;
            s.work += 1;
            if FORCED {
                s.idle_compiles += 1;
            }
        }
        return yields(compile_page(key, entries, tier));
    }
    let selected = {
        let mut s = SCHEDULER.try_lock().unwrap();
        if !s.config.enabled
            || !s.credit
            || s.pending.is_some()
            || !s.scan_credit && s.interpreted_ready.is_none()
        {
            return false;
        }
        // Queued threshold crossings first: still needed if no newer tier exists.
        while let Some((entry, tier)) = s.candidates.pop_front() {
            let current = cache::tier(entry);
            let tier = if DIRECT_T2 && current == 0 { 2 } else { tier };
            if current + 1 == tier || DIRECT_T2 && current == 0 {
                let config = s.config;
                s.credit = false;
                s.work += 1;
                if FORCED {
                    s.idle_compiles += 1;
                }
                drop(s);
                return yields(compile_entry(entry, tier, config));
            }
        }
        let earned = s.interpreted_ready.take();
        // A fruitless scan must not consume the frame's compilation credit.
        // Bound full-ring scans separately, but still admit the currently
        // interpreted entry as soon as it actually reaches its heat threshold.
        let config = s.config;
        let current = live::entry();
        let mut selected = earned
            .into_iter()
            .chain(std::iter::once(current))
            .find_map(|entry| {
                let index = s.hot_index.get(entry)?;
                let hot = &s.hot[index];
                (hot.hits >= config.threshold && hot.failed == 0 && cache::tier(entry) == 0)
                    .then_some((entry, if DIRECT_T2 { 2 } else { 1 }, config, None))
            });
        if selected.is_none() && s.scan_credit {
            s.scan_credit = false;
            // Earned interpreted Tier 1 retains priority. Alternate the two
            // persistent scan domains so ready Tier 1 owners cannot starve
            // existing Tier 2 fusion; each domain examines at most 128 positions.
            let resident = s.resident_promotion;
            if !resident {
                selected = cache::next_region_promotion(config.promote)
                    .map(|entry| (entry, 2, config, None));
            }
            if selected.is_none() && resident && s.prefer_promotion {
                selected = cache::next_promotion(MAX_FRAME_SCAN)
                    .map(|ticket| (ticket.entry, 2, config, Some(ticket)));
            }
            if selected.is_none() {
                for _ in 0..s.hot.len().min(MAX_FRAME_SCAN) {
                    let index = s.cursor;
                    s.cursor = (s.cursor + 1) % s.hot.len();
                    let h = &s.hot[index];
                    let tier = cache::tier(h.entry);
                    let needed = if tier == 0 { config.threshold } else { config.promote };
                    if h.hits >= needed
                        && !(resident && tier == 1)
                        && (tier < 2 || cache::fusion_ready(h.entry))
                    {
                        let next = if DIRECT_T2 { 2 } else { (tier + 1).min(2) };
                        selected = Some((h.entry, next, config, None));
                        break;
                    }
                }
            }
            if selected.is_none() && resident && !s.prefer_promotion {
                selected = cache::next_promotion(MAX_FRAME_SCAN)
                    .map(|ticket| (ticket.entry, 2, config, Some(ticket)));
            }
            if let Some((_, _, _, ticket)) = &selected {
                s.prefer_promotion = ticket.is_none();
            }
        }
        if selected.is_some() {
            s.credit = false;
            s.work += 1;
            if FORCED {
                s.idle_compiles += 1;
            }
        }
        selected
    };
    let Some((entry, tier, config, ticket)) = selected
    else {
        return false;
    };
    compile_selected(entry, tier, config, ticket)
}
unsafe fn compile_entry(entry: CpuEntryKey, tier: u32, config: Config) -> bool {
    compile_selected(entry, tier, config, None)
}
/// Capture, compile and submit one selected entry (region compilation).
unsafe fn compile_selected(
    entry: CpuEntryKey,
    tier: u32,
    config: Config,
    ticket: Option<Ticket>,
) -> bool {
    if ticket.is_some_and(|ticket| !cache::promotion_current(ticket)) {
        return false;
    }
    let _compile_context = super::diagnostics::CompileContext::new(entry.linear.0, tier);
    let fusion_only = cache::tier(entry) == 2;
    let snapshot = source(entry, config.window, tier);
    let suppressed = {
        let mut s = SCHEDULER.try_lock().unwrap();
        let same = if let Some(ticket) = ticket {
            cache::promotion_suppressed(ticket, &snapshot)
        }
        else {
            s.hot.iter().find(|h| h.entry == entry).is_some_and(|h| {
                h.failed == tier
                    && match (&h.source, &snapshot) {
                        (Some(a), Some(b)) => same(a, b),
                        (None, None) => true,
                        _ => false,
                    }
            })
        };
        if same {
            s.stats[8] = s.stats[8].wrapping_add(1);
        }
        same
    };
    if suppressed {
        return false;
    }
    let Some(snapshot) = snapshot
    else {
        failed(entry, tier, None, ticket);
        return false;
    };
    if !cache::can_make_room(entry) {
        return false;
    }
    let Some(key) = live::publication_key()
    else {
        failed(entry, tier, Some(snapshot), ticket);
        return false;
    };
    {
        let mut s = SCHEDULER.try_lock().unwrap();
        s.stats[tier as usize + 1] = s.stats[tier as usize + 1].wrapping_add(1);
    }
    let compile_tier = if tier == 1 { Tier::One } else { Tier::Two };
    let region_policy = region::Policy::for_tier(compile_tier, config.window);
    let request = CompileRequest {
        key,
        pc: entry.pc,
        linear: entry.linear,
        default_32: entry.default_32,
        tier: compile_tier,
    };
    // Tier 1 may expose three already-observed side entries in the same shared
    // body, even before they independently become hot. A failed shared attempt
    // must retain the old heat and aggregate suffix-byte budget for fallback.
    // Tier 2 keeps its original hot-peer policy.
    let peers = {
        let tier_one =
            if tier == 2 { cache::tier_one_peers(entry, snapshot.bytes.len()) } else { vec![] };
        let s = SCHEDULER.try_lock().unwrap();
        let mut candidates: Vec<_> = s
            .hot
            .iter()
            .filter(|h| {
                h.entry.cs_base() == entry.cs_base()
                    && h.entry.default_32 == entry.default_32
                    && h.entry.linear.0.wrapping_sub(entry.linear.0) > 0
                    && (h.entry.linear.0.wrapping_sub(entry.linear.0) as usize)
                        < snapshot.bytes.len()
                    && h.hits > 0
                    && h.failed != tier
                    && cache::tier(h.entry) + 1 == tier
            })
            .map(|h| (h.entry, h.hits))
            .collect();
        for (peer, hits) in tier_one {
            if s.hot.iter().any(|h| h.entry == peer && h.failed == tier) {
                continue;
            }
            match candidates.iter_mut().find(|(e, _)| *e == peer) {
                Some((_, old)) => *old = (*old).max(hits),
                None => candidates.push((peer, hits)),
            }
        }
        super::peers::select(
            entry,
            snapshot.bytes.len(),
            compile_tier,
            if tier == 1 { config.threshold } else { config.promote },
            candidates,
        )
    };
    let entry_requests = |peers: &[CpuEntryKey]| {
        let mut entries = vec![CpuEntryRequest { offset: 0, key }];
        for peer in peers {
            if let Some(key) = live::publication_key() {
                entries.push(CpuEntryRequest {
                    offset: peer.linear.0.wrapping_sub(entry.linear.0) as usize,
                    key,
                });
            }
        }
        entries
    };
    let entries = entry_requests(&peers.shared);
    let (opt_level, disabled, debug) = {
        let s = SCHEDULER.try_lock().unwrap();
        (s.opt_level, s.passes_disabled, s.debug)
    };
    let config = IrConfig {
        optimize: opt_level != 0,
        passes: crate::ir::passes::PassConfig {
            debug,
            ..(if tier == 1 || opt_level == 1 {
                crate::ir::passes::PassConfig::tier1()
            }
            else {
                Default::default()
            })
            .disable(disabled | crate::ir::passes::PassConfig::shared_memory_disabled())
        },
        execution_budget: config.budget,
        rep_iteration_budget: config.rep,
        max_code_bytes: region_policy.max_bytes,
        layout: StateLayout {
            gpr: 0,
            flags: 32,
            eip: 36,
            committed: 40,
            flag_operand: 44,
        },
    };
    let compile_scope = Scope::new(Stage::Compile);
    let compile_clock = CompileScope::new(0);
    let started = crate::profiler::performance_codegen_start();
    let fusion = if tier == 2 { cache::take_fusion(entry) } else { None };
    let fused = fusion.map(|(primary, peer, edges)| {
        compile_cpu_fused_regions(&request, &primary, &peer, &edges, &config)
            .map(|artifact| vec![(artifact, primary, 0)])
    });
    if let Some(result) = &fused {
        let mut s = SCHEDULER.try_lock().unwrap();
        s.stats[14] = s.stats[14].wrapping_add(1);
        if let Err(error) = result {
            let index = match error {
                crate::ir::lowering::CompileError::Budget(_) => 15,
                crate::ir::lowering::CompileError::Unsupported(_) => 16,
                crate::ir::lowering::CompileError::InvalidIr(_) => 17,
            };
            s.stats[index] = s.stats[index].wrapping_add(1);
        }
    }
    let compiled = if let Some(Ok(fused)) = fused {
        Ok(fused)
    }
    else if fusion_only {
        crate::profiler::performance_codegen_finish(started);
        return false; // One failed fusion attempt leaves the working Tier 2 intact.
    }
    else if entries.len() > 1 {
        match compile_cpu_shared_entries(&request, &snapshot, &entries, &config) {
            Ok(artifact) => Ok(vec![(artifact, snapshot.clone(), 0)]),
            Err(_) => {
                // Never turn speculative shared aliases into independent cold
                // modules. Only peers that earned the original threshold and
                // aggregate suffix budget may accompany the primary fallback.
                let fallback = if peers.shared == peers.fallback {
                    entries
                }
                else {
                    entry_requests(&peers.fallback)
                };
                if fallback.len() > 1 {
                    compile_cpu_entries_available(&request, &snapshot, &fallback, &config)
                }
                else {
                    compile_cpu_cfg_bounded(&request, &snapshot, &config).map(|a| vec![a])
                }
            },
        }
    }
    else {
        compile_cpu_cfg_bounded(&request, &snapshot, &config).map(|a| vec![a])
    };
    crate::profiler::performance_codegen_finish(started);
    drop(compile_clock);
    drop(compile_scope);
    let compiled = match compiled {
        Ok(compiled) => compiled,
        Err(error) => {
            use crate::ir::lowering::CompileError;
            let field = match error {
                CompileError::Unsupported(_) => 9,
                CompileError::Budget(_) => 10,
                CompileError::InvalidIr(_) => 11,
            };
            {
                let mut s = SCHEDULER.try_lock().unwrap();
                s.stats[field] = s.stats[field].wrapping_add(1);
            }
            failed(entry, tier, Some(snapshot), ticket);
            return false;
        },
    };
    {
        let mut s = SCHEDULER.try_lock().unwrap();
        let peers = compiled.len() as u32 - 1;
        s.stats[tier as usize + 1] = s.stats[tier as usize + 1].wrapping_add(peers);
        s.stats[13] = s.stats[13].wrapping_add(peers);
        for (artifact, source, retries) in compiled {
            if !artifact.alternate_entries.is_empty() {
                s.stats[20] = s.stats[20].wrapping_add(1);
                s.stats[21] = s.stats[21].wrapping_add(artifact.alternate_entries.len() as u32);
            }
            s.stats[12] = s.stats[12].wrapping_add(retries);
            if let super::entry::EntryContract::Cpu(compiled_entry) = artifact.entry {
                if let Some(h) = s.hot.iter_mut().find(|h| h.entry == compiled_entry) {
                    h.source = Some(source.clone());
                    h.failed = 0;
                }
            }
            let promotion = ticket
                .filter(|t| artifact.entry == super::entry::EntryContract::Cpu(t.entry))
                .map(|ticket| Attempt {
                    ticket,
                    source: snapshot.clone(),
                });
            s.ready.push_back(Queued {
                job: Job {
                    observed: artifact.dependencies.clone(),
                    artifact,
                    source,
                    stale: false,
                },
                promotion,
            });
        }
        if let Some(h) = s.hot.iter_mut().find(|h| h.entry == entry) {
            h.source = Some(snapshot);
            h.failed = 0;
        }
    }
    let job = SCHEDULER.try_lock().unwrap().ready.pop_front().unwrap();
    yields(publish(job))
}
/// A host that published synchronously already completed the transaction;
/// only a still-pending asynchronous installation needs the CPU to yield.
fn yields(submitted: bool) -> bool { submitted && SCHEDULER.try_lock().unwrap().pending.is_some() }
/// Compile one whole code page with its observed entries and submit it.
unsafe fn compile_page(key: PageKey, entries: Vec<CpuEntryKey>, tier: u32) -> bool {
    let (config, opt_level, disabled, debug) = {
        let s = SCHEDULER.try_lock().unwrap();
        (s.config, s.opt_level, s.passes_disabled, s.debug)
    };
    let _compile_context = super::diagnostics::CompileContext::new(entries[0].linear.0, tier);
    let snapshot = {
        let _clock = CompileScope::new(1);
        super::snapshot::capture_page(key.base)
    };
    let snapshot = match snapshot {
        Ok(snapshot) => snapshot,
        Err(_) => {
            SCHEDULER.try_lock().unwrap().pages.capture_missed(key);
            return false;
        },
    };
    let physical = snapshot.mappings[0].physical.0;
    if !cache::can_make_room(entries[0]) {
        return false;
    }
    let Some(publication) = live::publication_key()
    else {
        return false;
    };
    let compile_tier = if tier == 1 { Tier::One } else { Tier::Two };
    let request = CompileRequest {
        key: publication,
        pc: entries[0].pc,
        linear: entries[0].linear,
        default_32: key.default_32,
        tier: compile_tier,
    };
    let ir_config = IrConfig {
        optimize: opt_level != 0,
        passes: crate::ir::passes::PassConfig {
            debug,
            ..(if tier == 1 || opt_level == 1 {
                crate::ir::passes::PassConfig::tier1()
            }
            else {
                Default::default()
            })
            .disable(disabled | crate::ir::passes::PassConfig::shared_memory_disabled())
        },
        execution_budget: config.budget,
        rep_iteration_budget: config.rep,
        max_code_bytes: 4096,
        layout: StateLayout {
            gpr: 0,
            flags: 32,
            eip: 36,
            committed: 40,
            flag_operand: 44,
        },
    };
    {
        let mut s = SCHEDULER.try_lock().unwrap();
        s.stats[tier as usize + 1] = s.stats[tier as usize + 1].wrapping_add(1);
    }
    let compile_scope = Scope::new(Stage::Compile);
    let compile_clock = CompileScope::new(0);
    let started = crate::profiler::performance_codegen_start();
    let compiled = compile_cpu_page(&request, &snapshot, &entries, &ir_config);
    crate::profiler::performance_codegen_finish(started);
    drop(compile_clock);
    drop(compile_scope);
    let artifact = match compiled {
        Ok(artifact) => artifact,
        Err(error) => {
            use crate::ir::lowering::CompileError;
            let mut s = SCHEDULER.try_lock().unwrap();
            let field = match error {
                CompileError::Unsupported(_) => 9,
                CompileError::Budget(_) => 10,
                CompileError::InvalidIr(_) => 11,
            };
            s.stats[field] = s.stats[field].wrapping_add(1);
            if tier == 1 {
                s.pages.compiled(key, &entries, None);
            }
            return false;
        },
    };
    let served: Vec<CpuEntryKey> = artifact.cpu_entries().collect();
    {
        let mut s = SCHEDULER.try_lock().unwrap();
        s.pages.compiled(key, &entries, Some((&served, physical)));
        if tier == 2 {
            s.page_tier2 = s.page_tier2.wrapping_add(1);
        }
    }
    publish_page(
        Queued {
            job: Job {
                observed: artifact.dependencies.clone(),
                artifact,
                source: snapshot,
                stale: false,
            },
            promotion: None,
        },
        key,
    )
}
unsafe fn publish_page(queued: Queued, page: PageKey) -> bool {
    let submitted = publish(queued);
    if submitted {
        if let Some(p) = SCHEDULER.try_lock().unwrap().pending.as_mut() {
            p.page = Some(page);
        }
    }
    submitted
}
unsafe fn publish(queued: Queued) -> bool {
    let Queued { job, promotion } = queued;
    let ticket = promotion.as_ref().map(|p| p.ticket);
    if ticket.is_some_and(|ticket| !cache::promotion_current(ticket)) {
        return false;
    }
    let super::entry::EntryContract::Cpu(entry) = job.artifact.entry
    else {
        return false;
    };
    let tier = if job.artifact.tier == Tier::One { 1 } else { 2 };
    let key = job.artifact.key;
    if !live::generation_current(key) {
        return false;
    }
    if !cache::make_room(entry) {
        return false;
    }
    let members = job.artifact.cpu_entries().collect::<Vec<_>>();
    let ptr = job.artifact.code.bytes.as_ptr() as u32;
    let len = job.artifact.code.bytes.len() as u32;
    // Keep the original capture fingerprint for bounded-prefix compilation:
    // a browser rejection must not retry just because the artifact is shorter.
    let snapshot = promotion
        .as_ref()
        .map(|p| p.source.clone())
        .or_else(|| {
            SCHEDULER
                .try_lock()
                .unwrap()
                .hot
                .iter()
                .find(|h| h.entry == entry)
                .and_then(|h| h.source.clone())
        })
        .unwrap_or_else(|| job.source.clone());
    let slot = cache::reserve_with_promotion(job, true, ticket);
    if slot == 0 {
        failed(entry, tier, Some(snapshot), ticket);
        return false;
    }
    {
        let mut s = SCHEDULER.try_lock().unwrap();
        s.pending = Some(Pending {
            id: key.job,
            slot,
            entries: members
                .into_iter()
                .map(|key| {
                    let discovered = s.hot_index.get(key).and_then(|i| s.hot[i].discovered);
                    (key, discovered)
                })
                .collect(),
            tier,
            promotion,
            page: None,
        });
    }
    // JS copies bytes now; all Rust locks have been released. Completion is a
    // later microtask, never recursive compilation/publication in this frame.
    super::entry::ir_admission_barrier();
    ir_codegen_finalize(key.job, slot, ptr, len);
    true
}
#[no_mangle]
pub fn ir_auto_complete(id: u64, success: u32) {
    let state = cache::completion_state(id);
    if state == 2 || success != 1 && state == 1 {
        return;
    }
    let success = success == 1 && state == 1;
    let mut s = SCHEDULER.try_lock().unwrap();
    if !s.pending.as_ref().is_some_and(|p| p.id == id) {
        return;
    }
    let p = s.pending.take().unwrap();
    if let Some(page) = p.page {
        if !success {
            let entries: Vec<_> = p.entries.iter().map(|(k, _)| *k).collect();
            s.pages.unserve(&entries);
            let _ = page;
        }
    }
    let resident = p.promotion.is_some();
    if !success {
        if let Some(attempt) = p.promotion {
            cache::promotion_failed(attempt.ticket, Some(attempt.source));
        }
    }
    if success {
        for (_, discovered) in &p.entries {
            super::diagnostics::discovery_complete(*discovered, p.tier);
        }
    }
    let stat = if success { p.tier as usize + 3 } else { 7 };
    s.stats[stat] = s.stats[stat].wrapping_add(1);
    // Region upgrades are requested once per Tier-1 owner (and fused traces
    // once per root): a failed Tier-2 publication is suppressed, not retried,
    // until changed bytes publish a new owner.
    if !success && p.tier == 2 && p.page.is_none() && !resident {
        s.stats[8] = s.stats[8].wrapping_add(1);
    }
    for hot in &mut s.hot {
        if p.entries.iter().any(|(key, _)| *key == hot.entry) {
            hot.hits = 0;
            hot.failed = if success { 0 } else { p.tier };
        }
    }
}
#[no_mangle]
pub fn ir_auto_stat(field: u32) -> u32 {
    let s = SCHEDULER.try_lock().unwrap();
    match field {
        0..=8 => s.stats[field as usize],
        9 => s.hot.len() as u32,
        10 => s.pending.is_some() as u32,
        11 => s.config.enabled as u32,
        12..=15 => s.stats[field as usize - 3],
        16 => s.stats[13],
        17 => s.ready.len() as u32,
        18..=21 => s.stats[field as usize - 4],
        22 => s.stats[18],
        23 => s.stats[19],
        24 => u32::from(s.hot_filter),
        25 => s.stats[20], // compiled shared functions (publication counted separately)
        26 => s.stats[21], // additional entries supplied by shared functions
        27 => s.stats[22], // idle visits rejected before cache/jit quiescence checks
        28 => s.stats[23], // visits requiring the original cold-work path
        29 => s.hot_capacity as u32,
        30 => u32::from(s.page_mode),
        31 => s.pages.compiles,
        32 => s.pages.failures,
        33 => s.page_tier2,
        34 => s.pages.first,
        35 => s.pages.again,
        36 => s.pages.dirty_resets,
        37 => s.pages.declined_entries,
        38 => s.idle_compiles,
        39 => s.idle_ms as u32,
        _ => 0,
    }
}
