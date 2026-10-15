//! Retired instructions and the other per-core counters, the same for both
//! cores (docs/arm64-virt-android16-plan.md P1.10): the x86 core's
//! cpu::execution and the ARM core count through here, and
//! core_statistics_get(core, 0) means retired instructions in both
//! (docs/jit-unification-plan.md cross-phase rule 3). Up to 8 cores.

use crate::isa::current_core;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(crate) struct CoreStatistics {
    pub retired: u64,
    pub rep_elements: u64,
    pub faults: u64,
    pub halts: u64,
    pub runtime_ms: f64,
}
pub(crate) static mut CORE_STATISTICS: [CoreStatistics; 8] = [CoreStatistics {
    retired: 0,
    rep_elements: 0,
    faults: 0,
    halts: 0,
    runtime_ms: 0.0,
}; 8];
// Retired instructions and REP elements of the current core not yet added to
// CORE_STATISTICS: two plain adds per instruction instead of an indexed
// update. Flushed on core switch and before any read or reset.
pub(crate) static mut PENDING_RETIRED: u64 = 0;
pub(crate) static mut PENDING_REP_ELEMENTS: u64 = 0;
pub unsafe fn flush_core_statistics() {
    if PENDING_RETIRED | PENDING_REP_ELEMENTS != 0 {
        let stats = &mut (*crate::parallel::machine(&raw mut CORE_STATISTICS))[current_core()];
        stats.retired += PENDING_RETIRED;
        stats.rep_elements += PENDING_REP_ELEMENTS;
        PENDING_RETIRED = 0;
        PENDING_REP_ELEMENTS = 0;
    }
}

// (the ARM core's counting; the x86 core updates the statics in cpu::execution)
/// Instructions (and REP elements) the current core retired one by one
#[allow(dead_code)]
#[inline(always)]
pub fn add_pending(retired: u32, rep_elements: u32) {
    unsafe {
        PENDING_RETIRED += retired as u64;
        PENDING_REP_ELEMENTS += rep_elements as u64;
    }
}
/// A synchronous fault of the current core
#[allow(dead_code)]
pub fn note_fault() {
    unsafe { (*crate::parallel::machine(&raw mut CORE_STATISTICS))[current_core()].faults += 1 }
}

/// A HLT or WFI of the current core
pub unsafe fn note_halt() {
    (*crate::parallel::machine(&raw mut CORE_STATISTICS))[current_core()].halts += 1;
}
/// REP elements compiled code completed
pub unsafe fn note_jit_rep(elements: u32) {
    (*crate::parallel::machine(&raw mut CORE_STATISTICS))[current_core()].rep_elements +=
        elements as u64;
}
/// Instructions compiled code retired natively (the instructions it leaves
/// to the interpreter retire there: finish_instruction)
pub unsafe fn note_native_retired(native: u32) {
    (*crate::parallel::machine(&raw mut CORE_STATISTICS))[current_core()].retired += native as u64;
}
/// The current core's retired instructions so far, pending ones included
pub unsafe fn retired_now() -> u64 {
    (*crate::parallel::machine(&raw mut CORE_STATISTICS))[current_core()].retired + PENDING_RETIRED
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
