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

/// Whether the core waits: 1 WFI, 2 WFE (until an interrupt or an event), 3 off
#[inline(always)]
fn waiting_now() -> u32 { unsafe { *waiting } }

/// Take a pending interrupt the PE does not mask (at an instruction boundary): whether it did
#[inline(always)]
fn take_interrupt() -> bool {
    let signal = unsafe { crate::aarch64::gic::SIGNAL[crate::isa::current_core()] };
    let state = cpu::get_pstate();
    let kind = if signal & crate::aarch64::gic::SIGNAL_FIQ != 0 && state & cpu::PSTATE_F == 0 {
        cpu::VECTOR_FIQ
    }
    else if signal & crate::aarch64::gic::SIGNAL_IRQ != 0 && state & cpu::PSTATE_I == 0 {
        cpu::VECTOR_IRQ
    }
    else {
        return false;
    };
    cpu::take_exception(kind, cpu::get_pc(), None, None);
    true
}

/// Whether a waiting core wakes: WFI on any pending interrupt (masked or
/// not), WFE on an event or an interrupt the PE does not mask
fn wakes(kind: u32) -> bool {
    let signal = unsafe { crate::aarch64::gic::SIGNAL[crate::isa::current_core()] };
    match kind {
        1 => signal != 0,
        2 => {
            let state = cpu::get_pstate();
            let unmasked = signal & crate::aarch64::gic::SIGNAL_IRQ != 0
                && state & cpu::PSTATE_I == 0
                || signal & crate::aarch64::gic::SIGNAL_FIQ != 0 && state & cpu::PSTATE_F == 0;
            unmasked || unsafe { *event_register } != 0
        },
        _ => false,
    }
}

/// The milliseconds a waiting core can sleep (capped at 100)
fn sleep_ms() -> f64 {
    let due = crate::aarch64::timer::next_due();
    if due == u64::MAX {
        100.0
    }
    else {
        (due as f64 / 1e6).min(100.0)
    }
}

/// Run the machine for one slice: the milliseconds until something is due
/// (0: run again soon)
#[no_mangle]
pub fn a64_run_slice(_now: f64) -> f64 {
    if crate::aarch64::psci::a64_powered_off() {
        return 100.0;
    }
    crate::aarch64::timer::tick();
    let kind = waiting_now();
    if kind != 0 {
        if kind == 3 || !wakes(kind) {
            return if kind == 3 { 100.0 } else { sleep_ms() };
        }
        unsafe {
            *waiting = 0;
            if kind == 2 {
                *event_register = 0;
            }
        }
    }
    for i in 0..SLICE {
        if i & 1023 == 1023 {
            crate::aarch64::timer::tick();
        }
        if unsafe { crate::aarch64::gic::SIGNAL[crate::isa::current_core()] } != 0
            && take_interrupt()
        {
            continue;
        }
        match execute::interpret_one() {
            Flow::Wait(kind) => {
                // (a wait that is already over goes on; WFE consumes the event)
                if wakes(kind) {
                    if kind == 2 {
                        unsafe { *event_register = 0 };
                    }
                    continue;
                }
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
    match waiting_now() {
        0 => 0.0,
        3 => 100.0,
        _ => sleep_ms(),
    }
}

/// Reset the machine's cores: core 0 starts at `entry` with `x0`
#[no_mangle]
pub fn a64_boot(entry_low: u32, entry_high: u32, x0_low: u32, x0_high: u32) {
    let entry = entry_low as u64 | (entry_high as u64) << 32;
    let x0 = x0_low as u64 | (x0_high as u64) << 32;
    cpu::reset_core(entry, x0);
    crate::aarch64::gic::reset();
    crate::aarch64::debug::reset();
    crate::aarch64::tlb::flush(true);
    unsafe {
        crate::aarch64::psci::POWER = [0, 1, 1, 1, 1, 1, 1, 1];
        crate::aarch64::psci::REQUEST = 0;
    }
}

/// The core's registers for JavaScript (tests, diagnostics): X0-X30, SP,
/// PC, NZCV, PSTATE are in the state block (src/arm/state_layout.js)
#[no_mangle]
pub fn a64_state_base() -> u32 { crate::state_block::state_base() }
