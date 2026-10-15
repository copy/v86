//! The machine's cores and how they run (docs/arm64-virt-android16-plan.md
//! P3.7: cooperative SMP; P8.2 runs them in workers): the run loop of a
//! slice, waiting (WFI, WFE), events, and starting cores (PSCI CPU_ON).
//! Until P3.7 there is one core.

use crate::aarch64::cpu;
use crate::aarch64::execute::{self, Flow};
use crate::aarch64::state::*;

/// Instructions in a slice before the machine's other work (timers, devices) runs
pub const SLICE: u32 = 50_000;

/// SEV: an event to every core (their WFE ends)
pub fn send_event() { unsafe { *event_register = 1 } }

/// Whether the core waits: 1 WFI, 2 WFE (until an interrupt or an event)
#[inline(always)]
fn waiting_now() -> u32 { unsafe { *waiting } }

/// Run the machine for one slice: the milliseconds until something is due
/// (0: run again soon)
#[no_mangle]
pub fn a64_run_slice(_now: f64) -> f64 {
    if crate::aarch64::psci::a64_powered_off() {
        return 100.0;
    }
    if waiting_now() != 0 {
        // (no interrupt can end the wait yet: P3.5)
        return 100.0;
    }
    for _ in 0..SLICE {
        match execute::interpret_one() {
            Flow::Wait(kind) => {
                unsafe { *waiting = kind };
                unsafe { crate::core_stats::note_halt() };
                break;
            },
            Flow::Off => {
                unsafe { *waiting = 3 };
                break;
            },
            _ => {},
        }
    }
    unsafe { crate::core_stats::flush_core_statistics() };
    if waiting_now() != 0 {
        10.0
    }
    else {
        0.0
    }
}

/// Reset the machine's cores: core 0 starts at `entry` with `x0`
#[no_mangle]
pub fn a64_boot(entry_low: u32, entry_high: u32, x0_low: u32, x0_high: u32) {
    let entry = entry_low as u64 | (entry_high as u64) << 32;
    let x0 = x0_low as u64 | (x0_high as u64) << 32;
    cpu::reset_core(entry, x0);
    unsafe {
        crate::aarch64::psci::POWER = [0, 1, 1, 1, 1, 1, 1, 1];
        crate::aarch64::psci::REQUEST = 0;
    }
}

/// The core's registers for JavaScript (tests, diagnostics): X0-X30, SP,
/// PC, NZCV, PSTATE are in the state block (src/arm/state_layout.js)
#[no_mangle]
pub fn a64_state_base() -> u32 { crate::state_block::state_base() }
