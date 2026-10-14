//! Architectural progress for the machine clock. Dispatch attempts, exceptions
//! and REP continuation batches are deliberately not retired instructions.
//!
//! The cooperative scheduler switches cores only outside begin/finish. This
//! state is therefore Machine-owned transient execution state, not vCPU state.

use crate::cpu::apic;
use crate::cpu::string::{StringExecution, StringOutcome};

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CoreStatistics {
    retired: u64,
    rep_elements: u64,
    faults: u64,
    halts: u64,
    runtime_ms: f64,
}
static mut CORE_STATISTICS: [CoreStatistics; 8] = [CoreStatistics {
    retired: 0,
    rep_elements: 0,
    faults: 0,
    halts: 0,
    runtime_ms: 0.0,
}; 8];
// Retired instructions and REP elements of the current core not yet added to
// CORE_STATISTICS: two plain adds per instruction instead of an indexed
// update. Flushed on core switch and before any read or reset.
static mut PENDING_RETIRED: u64 = 0;
static mut PENDING_REP_ELEMENTS: u64 = 0;
pub unsafe fn flush_core_statistics() {
    if PENDING_RETIRED | PENDING_REP_ELEMENTS != 0 {
        let stats =
            &mut (*crate::parallel::machine(&raw mut CORE_STATISTICS))[apic::current_core()];
        stats.retired += PENDING_RETIRED;
        stats.rep_elements += PENDING_REP_ELEMENTS;
        PENDING_RETIRED = 0;
        PENDING_REP_ELEMENTS = 0;
    }
}

struct ExecutionState {
    deterministic: bool,
    active: bool,
    faulted: bool,
    string_result: Option<StringExecution>,
    pending_work: u64,
    retired: u32,
    rep_elements: u32,
    // The wide executor commits RIP only after its last access. A device
    // callback inside that window must not deliver an IRQ; the dispatch
    // loop polls again at the instruction boundary.
    defer_irqs: bool,
    // handle_irqs was called while defer_irqs held
    irq_noted: bool,
}

impl ExecutionState {
    const fn new() -> Self {
        Self {
            deterministic: false,
            active: false,
            faulted: false,
            string_result: None,
            pending_work: 0,
            retired: 0,
            rep_elements: 0,
            defer_irqs: false,
            irq_noted: false,
        }
    }

    fn begin(&mut self) {
        dbg_assert!(!self.active);
        self.active = true;
        self.faulted = false;
        self.string_result = None;
    }

    fn mark_fault(&mut self) {
        if self.active {
            self.faulted = true;
        }
    }

    fn record_string(&mut self, result: StringExecution) {
        if self.active {
            dbg_assert!(self.string_result.is_none());
            self.string_result = Some(result);
        }
    }

    fn finish(&mut self) -> u32 {
        dbg_assert!(self.active);
        let work = match self.string_result {
            // Completed REP elements remain architectural progress even when
            // the next element faults or a page/budget boundary yields.
            Some(result) if result.iterations > 0 => result.iterations,
            Some(result) => (result.outcome == StringOutcome::Complete && !self.faulted) as u32,
            None => (!self.faulted) as u32,
        };
        self.retired = (!self.faulted
            && self
                .string_result
                .is_none_or(|r| r.outcome == StringOutcome::Complete))
            as u32;
        self.rep_elements = self.string_result.map_or(0, |r| r.iterations);
        self.active = false;
        self.pending_work += work as u64;
        work
    }

    fn take_progress(&mut self) -> f64 {
        // JS consumes at slice boundaries and device reads. This counter is a
        // delta, rather than a floating-point lifetime instruction accumulator.
        dbg_assert!(self.pending_work <= (1u64 << 53) - 1);
        let work = self.pending_work;
        self.pending_work = 0;
        work as f64
    }
}

#[allow(non_upper_case_globals)]
static mut execution_state: ExecutionState = ExecutionState::new();

/// Hold external interrupt delivery until the current wide instruction has
/// committed or faulted.
#[inline(always)]
pub unsafe fn set_irq_deferral(enabled: bool) { execution_state.defer_irqs = enabled; }

#[inline(always)]
pub unsafe fn irqs_deferred() -> bool { execution_state.defer_irqs }

/// Whether handle_irqs was called while delivery was held, and nothing has
/// delivered since (cpu::run_compat_instruction)
#[inline(always)]
pub unsafe fn irq_check_owed() -> bool { execution_state.irq_noted }

/// handle_irqs while delivery is held: the hold's end looks again
#[inline(always)]
pub unsafe fn note_held_irq() { execution_state.irq_noted = true; }

/// handle_irqs outside a hold delivers what is deliverable: nothing is owed
#[inline(always)]
pub unsafe fn held_irqs_served() { execution_state.irq_noted = false; }

/// This mode uses the bounded interpreter and never a JIT/IR dispatch path.
#[no_mangle]
pub unsafe fn set_deterministic_execution(enabled: bool) {
    dbg_assert!(!execution_state.active);
    execution_state.deterministic = enabled;
}

#[inline(always)]
pub unsafe fn is_deterministic() -> bool { execution_state.deterministic }

/// Begin at outer dispatch; prefix recursion stays in this instruction.
#[inline(always)]
pub unsafe fn begin_instruction() { (&mut *(&raw mut execution_state)).begin() }

/// Return successful work from this dispatch, also queued for the JS clock.
#[inline(always)]
pub unsafe fn finish_instruction() -> u32 {
    let work = (&mut *(&raw mut execution_state)).finish();
    PENDING_RETIRED += execution_state.retired as u64;
    PENDING_REP_ELEMENTS += execution_state.rep_elements as u64;
    if !execution_state.deterministic {
        execution_state.pending_work = 0;
    }
    work
}

/// Mark synchronous faults only; traps and asynchronous IRQs are not faults.
#[inline(always)]
pub unsafe fn mark_fault() {
    (*crate::parallel::machine(&raw mut CORE_STATISTICS))[apic::current_core()].faults += 1;
    (&mut *(&raw mut execution_state)).mark_fault()
}

/// Called once by the outer interpreter string-instruction wrapper.
#[inline(always)]
pub unsafe fn record_string(result: StringExecution) {
    (&mut *(&raw mut execution_state)).record_string(result)
}

/// Consume accumulated progress without retiring the currently executing PIO.
#[no_mangle]
pub unsafe fn take_clock_progress() -> f64 { (&mut *(&raw mut execution_state)).take_progress() }

/// STI has retired before its recursively interpreted shadow instruction.
pub unsafe fn begin_shadow_instruction() {
    if execution_state.active {
        finish_instruction();
        begin_instruction();
    }
}

pub unsafe fn note_halt() {
    (*crate::parallel::machine(&raw mut CORE_STATISTICS))[apic::current_core()].halts += 1;
}
pub unsafe fn note_jit_rep(elements: u32) {
    (*crate::parallel::machine(&raw mut CORE_STATISTICS))[apic::current_core()].rep_elements +=
        elements as u64;
}
/// Instructions compiled code retired natively (the instructions it leaves
/// to the interpreter retire there: finish_instruction)
pub unsafe fn note_native_retired(native: u32) {
    (*crate::parallel::machine(&raw mut CORE_STATISTICS))[apic::current_core()].retired +=
        native as u64;
}
/// How retired instructions ran (the mode ledger)
#[derive(Clone, Copy)]
pub enum Way {
    /// by the interpreter, outside compiled code
    Interpreted = 0,
    // 1 and 2 were IR Tier-0's page functions and the instructions they
    // stepped (deleted in P7.5); the numbering, which tools read, stays
    /// IR regions (Tier-1 and Tier-2)
    RegionNative = 3,
    /// the x64 page tier, the instructions it stepped and the ones it
    /// retried in the interpreter after refusing an access
    PageNative = 4,
    PageStep = 5,
    PageRetry = 6,
}
const WAYS: usize = 7;
/// x64::state::ExecutionMode
const MODES: usize = 7;
/// The mode ledger (docs/jit-unification-plan.md P0.6, the JIT switch
/// mode_ledger, off by default): retired instructions (cross-phase rule 3:
/// what core_statistics_get(core, 0) counts) by mode, by whether 32-bit code
/// ran with flat segments (index 1), and by Way. While it is on, its sum
/// grows exactly as the retired count does.
static mut LEDGER: Option<[[[u64; WAYS]; 2]; MODES]> = None;

#[inline(always)]
pub fn ledger_on() -> bool { unsafe { (*(&raw const LEDGER)).is_some() } }
/// Off: the ledger is dropped; on: an empty one unless it was on
pub unsafe fn set_ledger(on: bool) {
    if on != ledger_on() {
        LEDGER = on.then_some([[[0; WAYS]; 2]; MODES]);
    }
}
#[no_mangle]
pub unsafe fn mode_ledger_reset() {
    if let Some(ledger) = (*(&raw mut LEDGER)).as_mut() {
        *ledger = [[[0; WAYS]; 2]; MODES];
    }
}
/// Retired instructions of mode `mode` (ExecutionMode), with flat 32-bit
/// segments or not (`flat`), that ran the Way `way`
#[no_mangle]
pub unsafe fn mode_ledger_get(mode: u32, flat: u32, way: u32) -> f64 {
    (*(&raw const LEDGER))
        .as_ref()
        .and_then(|l| l.get(mode as usize)?.get(flat as usize)?.get(way as usize))
        .map_or(0.0, |&n| n as f64)
}

/// Retirements of one Way from one mode, while the ledger is on: begun before
/// the instructions run, so that their mode is the row
pub struct LedgerSpan {
    mode: u8,
    flat: u8,
    retired: u64,
    counter: u32,
}
#[inline(always)]
pub unsafe fn ledger_begin() -> Option<LedgerSpan> {
    if ledger_on() {
        Some(ledger_begin_now())
    }
    else {
        None
    }
}
#[cold]
#[inline(never)]
unsafe fn ledger_begin_now() -> LedgerSpan {
    use crate::x64::state::ExecutionMode;
    let mode = crate::x64::state::mode();
    let flat = matches!(
        mode,
        ExecutionMode::Protected32 | ExecutionMode::Compatibility32
    ) && crate::cpu::cpu::has_flat_segmentation();
    LedgerSpan {
        mode: mode as u8,
        flat: flat as u8,
        retired: retired_now(),
        counter: *crate::cpu::global_pointers::instruction_counter,
    }
}
/// The current core's retired instructions so far, pending ones included
unsafe fn retired_now() -> u64 {
    (*crate::parallel::machine(&raw mut CORE_STATISTICS))[apic::current_core()].retired
        + PENDING_RETIRED
}
unsafe fn ledger_add(span: &LedgerSpan, way: Way, retired: u64) {
    if let Some(ledger) = (*(&raw mut LEDGER)).as_mut() {
        ledger[span.mode as usize][span.flat as usize][way as usize] += retired;
    }
}
/// Instructions retired one by one (finish_instruction) since the span began
#[inline(always)]
pub unsafe fn ledger_end(span: Option<LedgerSpan>, way: Way) {
    if let Some(span) = span {
        ledger_add(&span, way, retired_now() - span.retired);
    }
}
/// Instructions compiled code retired since the span began, as
/// note_native_retired counts them: the instruction counter's advance
#[inline(always)]
pub unsafe fn ledger_end_native(span: Option<LedgerSpan>, way: Way) {
    if let Some(span) = span {
        let native = (*crate::cpu::global_pointers::instruction_counter).wrapping_sub(span.counter);
        ledger_add(&span, way, native as u64);
    }
}
/// `retired` instructions compiled code retired since the span began, counted
/// by the caller
#[inline(always)]
pub unsafe fn ledger_end_count(span: Option<LedgerSpan>, way: Way, retired: u32) {
    if let Some(span) = span {
        ledger_add(&span, way, retired as u64);
    }
}

#[no_mangle]
pub unsafe fn core_statistics_reset() {
    PENDING_RETIRED = 0;
    PENDING_REP_ELEMENTS = 0;
    *crate::parallel::machine(&raw mut CORE_STATISTICS) = [CoreStatistics::default(); 8];
}
#[no_mangle]
pub unsafe fn core_statistics_addr(core: u32) -> u32 {
    assert!(core < 8);
    flush_core_statistics();
    crate::parallel::machine(&raw mut CORE_STATISTICS)
        .cast::<CoreStatistics>()
        .add(core as usize) as u32
}
#[no_mangle]
pub fn core_statistics_size() -> u32 { std::mem::size_of::<CoreStatistics>() as u32 }
#[no_mangle]
pub unsafe fn core_statistics_get(core: u32, field: u32) -> f64 {
    assert!(core < 8);
    flush_core_statistics();
    let stats = (*crate::parallel::machine(&raw mut CORE_STATISTICS))[core as usize];
    match field {
        0 => stats.retired as f64,
        1 => stats.rep_elements as f64,
        2 => stats.faults as f64,
        3 => stats.halts as f64,
        4 => stats.runtime_ms,
        _ => 0.0,
    }
}
#[no_mangle]
pub unsafe fn core_statistics_runtime(core: u32, elapsed_ms: f64) {
    assert!(core < 8 && elapsed_ms.is_finite() && elapsed_ms >= 0.0);
    (*crate::parallel::machine(&raw mut CORE_STATISTICS))[core as usize].runtime_ms += elapsed_ms;
}

/// Used after reset/restore, with the previous pending delta already consumed.
/// The machine's execution mode survives architectural reset.
pub unsafe fn reset() {
    let deterministic = execution_state.deterministic;
    execution_state = ExecutionState::new();
    execution_state.deterministic = deterministic;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn string_result(outcome: StringOutcome, iterations: u32) -> StringExecution {
        StringExecution {
            outcome,
            iterations,
        }
    }

    #[test]
    fn faults_do_not_retire_but_completed_instructions_do() {
        let mut state = ExecutionState::new();
        state.mark_fault(); // fault delivery outside a dispatch is irrelevant
        state.begin();
        assert_eq!(state.finish(), 1);
        state.begin();
        state.mark_fault();
        assert_eq!(state.finish(), 0);
        assert_eq!(state.take_progress(), 1.0);
        assert_eq!(state.take_progress(), 0.0);
    }

    #[test]
    fn rep_work_survives_faults_and_continuations_without_extra_retirements() {
        let mut state = ExecutionState::new();
        for (outcome, iterations, work) in [
            (StringOutcome::Complete, 0, 1),
            (StringOutcome::Complete, 17, 17),
            (StringOutcome::Repeat, 256, 256),
            (StringOutcome::Repeat, 0, 0),
            (StringOutcome::Fault, 5, 5),
            (StringOutcome::Fault, 0, 0),
        ] {
            state.begin();
            if outcome == StringOutcome::Fault {
                state.mark_fault();
            }
            state.record_string(string_result(outcome, iterations));
            assert_eq!(state.finish(), work);
        }
        assert_eq!(state.take_progress(), 279.0);
    }

    #[test]
    fn device_read_observes_only_prior_completed_dispatches() {
        let mut state = ExecutionState::new();
        state.begin();
        state.finish();
        state.begin(); // PIO callback during the next instruction
        assert_eq!(state.take_progress(), 1.0);
        assert_eq!(state.take_progress(), 0.0);
        state.finish();
        assert_eq!(state.take_progress(), 1.0);
    }

    #[test]
    fn jit_strings_outside_interpreter_dispatch_do_not_fabricate_progress() {
        let mut state = ExecutionState::new();
        state.record_string(string_result(StringOutcome::Complete, 100));
        assert_eq!(state.take_progress(), 0.0);
        state.begin();
        assert_eq!(state.finish(), 1);
    }
}
