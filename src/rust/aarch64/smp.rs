//! The machine's cores and how they run (docs/arm64-virt-android16-plan.md
//! P3.9: cooperative SMP; P8.2 runs them in workers): one core at a time in
//! the state block, the others' state in their saved copies, switched in a
//! round robin of bounded turns; waiting (WFI, WFE), events (SEV, the event
//! stream, the global monitor), starting cores (PSCI CPU_ON), and the global
//! exclusive monitor (P3.7). The GIC's CPU interfaces, the TLBs and the
//! statistics are per core already and stay where they are.

use crate::aarch64::cpu;
use crate::aarch64::execute::{self, Flow};
use crate::aarch64::psci;
use crate::aarch64::state::*;
use crate::isa::{core_count, current_core, MAX_CORES};

/// Instructions in a slice before the machine's other work (timers, devices) runs
pub const SLICE: u32 = 50_000;
/// Instructions a core runs in its turn when there are several
const QUANTUM: u32 = 4096;

/// The per-core part of the state block, from its offset 64 to the end of the last field
/// (src/arm/state_layout.js: event_register at 1316)
const STATE_START: usize = 64;
const STATE_END: usize = 1320;
const STATE_BYTES: usize = STATE_END - STATE_START;

#[repr(C, align(16))]
struct Saved([u8; STATE_BYTES]);

/// The state of the cores that are not running (the running core's copy is stale)
static mut SAVED: [Saved; MAX_CORES] = [const { Saved([0; STATE_BYTES]) }; MAX_CORES];
/// Events for cores that are not running (SEV, the event stream, a cleared
/// reservation): their event register is set when they run next
static mut EVENTS: u32 = 0;
/// Where the next round robin starts
static mut ROUND: usize = 0;

/// The global monitor (P3.7): the cores holding a reservation, and each one's
/// 64-byte granule of guest RAM (its offset in the RAM's backing >> 6)
static mut MONITORS: u32 = 0;
static mut MONITOR_GRANULE: [u32; MAX_CORES] = [0; MAX_CORES];

#[inline(always)]
fn live() -> *mut u8 { (crate::state_block::state_base() as usize + STATE_START) as *mut u8 }

/// A field of core `core`'s state: the state block for the running core, its saved copy otherwise
#[inline]
pub fn field<T>(core: usize, pointer: *mut T) -> *mut T {
    if core == current_core() {
        pointer
    }
    else {
        let offset = pointer as usize - crate::state_block::state_base() as usize - STATE_START;
        debug_assert!(offset + core::mem::size_of::<T>() <= STATE_BYTES);
        unsafe {
            (&raw mut SAVED[core].0)
                .cast::<u8>()
                .add(offset)
                .cast::<T>()
        }
    }
}

/// Make `core` the running core
pub fn switch_to(core: usize) {
    let old = current_core();
    if old == core {
        return;
    }
    unsafe {
        crate::core_stats::flush_core_statistics();
        core::ptr::copy_nonoverlapping(live(), (&raw mut SAVED[old].0).cast::<u8>(), STATE_BYTES);
        core::ptr::copy_nonoverlapping(
            (&raw const SAVED[core].0).cast::<u8>(),
            live(),
            STATE_BYTES,
        );
        crate::aarch64::isa_hooks::CURRENT_CORE = core;
        if EVENTS & 1 << core != 0 {
            EVENTS &= !(1 << core);
            *event_register = 1;
        }
    }
    // (what derives from the core's registers: the debug fast paths, the fetch fast path)
    crate::aarch64::debug::refresh();
    crate::aarch64::tlb::bump_generation();
    execute::core_switched();
}

/// The running core (tests, snapshots)
#[no_mangle]
pub fn a64_current_core() -> u32 { current_core() as u32 }

/// (snapshots, diagnostics) make `core` the running one, between slices
#[no_mangle]
pub fn a64_switch_core(core: u32) {
    assert!((core as usize) < core_count());
    switch_to(core as usize);
}

/// An event for `core` (its WFE ends)
pub fn event_to(core: usize) {
    unsafe {
        if core == current_core() {
            *event_register = 1;
        }
        else {
            EVENTS |= 1 << core;
        }
    }
}

/// SEV: an event to every core
pub fn send_event() {
    unsafe {
        *event_register = 1;
        EVENTS |= ((1u32 << core_count()) - 1) & !(1 << current_core());
    }
}

// ---- the global monitor (P3.7)

/// A load-exclusive of guest RAM at `backing` marks its granule for the running core
pub fn reserve(backing: u32) {
    let core = current_core();
    let changed =
        unsafe { MONITORS & 1 << core == 0 || MONITOR_GRANULE[core] >> 6 != backing >> 12 };
    unsafe {
        MONITORS |= 1 << core;
        MONITOR_GRANULE[core] = backing >> 6;
    }
    // (other cores' compiled stores to the page must reach monitors_written:
    // the page tier's access cache stops serving them, P3.7; a core's own
    // stores do not clear its reservation, so one core needs none of it)
    if changed && core_count() > 1 {
        crate::aarch64::jit::pages::retire_write_entries(backing & !0xFFF);
    }
}

/// Whether a core holds a reservation in the RAM page at `backing` (the page
/// tier's access cache serves no stores to it)
pub fn reserved_page(backing: u32) -> bool {
    if core_count() == 1 {
        return false;
    }
    let page = backing >> 12;
    let monitors = unsafe { MONITORS };
    monitors != 0
        && (0..MAX_CORES)
            .any(|c| monitors & 1 << c != 0 && unsafe { MONITOR_GRANULE[c] } >> 6 == page)
}

/// Whether the running core's reservation of the granule at `backing` still holds
pub fn reserved(backing: u32) -> bool {
    let core = current_core();
    unsafe { MONITORS & 1 << core != 0 && MONITOR_GRANULE[core] == backing >> 6 }
}

/// The running core's reservation ends (a store-exclusive, CLREX)
pub fn release() { unsafe { MONITORS &= !(1 << current_core()) } }

/// Guest RAM at [backing, backing + len) was written by the running core
/// (`device` false) or a device: the reservations of other observers on
/// those granules clear, and their cores get an event
#[inline(always)]
pub fn monitors_written(backing: u32, len: u32, device: bool) {
    let others = unsafe { MONITORS } & if device { u32::MAX } else { !(1 << current_core()) };
    if others != 0 {
        clear_reservations(others, backing, len);
    }
}

#[cold]
fn clear_reservations(cores: u32, backing: u32, len: u32) {
    let first = backing >> 6;
    let last = (backing + len.max(1) - 1) >> 6;
    for core in 0..MAX_CORES {
        if cores & 1 << core != 0 {
            let granule = unsafe { MONITOR_GRANULE[core] };
            if granule >= first && granule <= last {
                unsafe { MONITORS &= !(1 << core) };
                event_to(core);
            }
        }
    }
}

// ---- running

/// Take a pending interrupt the PE does not mask (at an instruction boundary): whether it did
#[inline(always)]
fn take_interrupt() -> bool {
    let signal = unsafe { crate::aarch64::gic::SIGNAL[current_core()] };
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

/// Whether core `core`, waiting, wakes: WFI on any pending interrupt (masked
/// or not), WFE on an event or an interrupt the PE does not mask
fn wakes(core: usize, kind: u32) -> bool {
    let signal = unsafe { crate::aarch64::gic::SIGNAL[core] };
    match kind {
        1 => signal != 0,
        2 => {
            let state = unsafe { *field(core, pstate) };
            let unmasked = signal & crate::aarch64::gic::SIGNAL_IRQ != 0
                && state & cpu::PSTATE_I == 0
                || signal & crate::aarch64::gic::SIGNAL_FIQ != 0 && state & cpu::PSTATE_F == 0;
            unmasked || unsafe { *field(core, event_register) != 0 || EVENTS & 1 << core != 0 }
        },
        _ => false,
    }
}

/// Whether core `core` can run now (PSCI's power state, its wait)
fn runnable(core: usize) -> bool {
    match unsafe { psci::POWER[core] } {
        psci::ON_PENDING => true,
        psci::ON => {
            let kind = unsafe { *field(core, waiting) };
            kind == 0 || kind != 3 && wakes(core, kind)
        },
        _ => false,
    }
}

/// Switch to a runnable core and end its wait (a core started by CPU_ON comes out of reset)
fn prepare(core: usize) {
    switch_to(core);
    unsafe {
        if psci::POWER[core] == psci::ON_PENDING {
            let (entry, context) = psci::START[core];
            reset_state(entry, context);
            psci::POWER[core] = psci::ON;
            return;
        }
        let kind = *waiting;
        if kind != 0 {
            *waiting = 0;
            if kind == 2 {
                // (WFE consumes the event that ended it)
                *event_register = 0;
            }
        }
    }
}

/// The running core from reset: every register of the state block (P4.4:
/// EL1h, MMU off, DAIF masked), its TLB empty
fn reset_state(entry: u64, context: u64) {
    unsafe { core::ptr::write_bytes(live(), 0, STATE_BYTES) };
    cpu::reset_core(entry, context);
    crate::aarch64::debug::reset();
    crate::aarch64::tlb::flush(false);
    release();
    unsafe { EVENTS &= !(1 << current_core()) };
}

/// Run the running core for up to `budget` instructions: how many it ran.
/// At each block boundary (a branch, an exception, an interrupt, the turn's
/// start) the A64 page tier may run the PC's compiled function
/// (crate::aarch64::jit::pages; J2), else instructions are interpreted.
fn run_core(budget: u32) -> u32 {
    use crate::aarch64::jit::pages::{self, Ran};
    let several = core_count() > 1;
    let mut i = 0;
    let mut next_tick = 1023;
    let mut boundary = true;
    while i < budget {
        if i >= next_tick {
            crate::aarch64::timer::tick();
            next_tick = i + 1024;
        }
        if unsafe { crate::aarch64::gic::SIGNAL[current_core()] } != 0 && take_interrupt() {
            i += 1;
            boundary = true;
            continue;
        }
        let flow = if boundary && unsafe { pages::ENABLED } {
            boundary = false;
            match pages::run(budget - i) {
                Ran::Native { retired, flow } => {
                    i += retired.max(1);
                    boundary = true;
                    flow
                },
                Ran::None => {
                    i += 1;
                    pages::interpreted();
                    execute::interpret_one()
                },
            }
        }
        else {
            i += 1;
            pages::interpreted();
            execute::interpret_one()
        };
        match flow {
            Flow::Jump(_) | Flow::Set => boundary = true,
            Flow::Wait(kind) => {
                boundary = true;
                // (a wait that is already over goes on; WFE consumes the event)
                if wakes(current_core(), kind) {
                    if kind == 2 {
                        unsafe { *event_register = 0 };
                    }
                    continue;
                }
                unsafe { *waiting = kind };
                unsafe { crate::core_stats::note_halt() };
                return i;
            },
            Flow::Off => {
                unsafe { *waiting = 3 };
                return i;
            },
            // (YIELD: the other cores' turn; a spin loop waits for one of them)
            Flow::Yield if several => return i,
            _ => {},
        }
    }
    i
}

/// The milliseconds the machine can sleep: until the first waiting core's
/// timers or event stream need it (capped at 100)
fn sleep_ms() -> f64 {
    let mut due = u64::MAX;
    for core in 0..core_count() {
        if unsafe { psci::POWER[core] } == psci::ON && unsafe { *field(core, waiting) } != 3 {
            due = due.min(crate::aarch64::timer::next_due(core));
        }
    }
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
    if psci::a64_powered_off() {
        return 100.0;
    }
    let count = core_count();
    let budget = if count == 1 { SLICE } else { QUANTUM };
    let mut executed = 0;
    loop {
        crate::aarch64::timer::tick_all();
        let start = unsafe {
            ROUND = (ROUND + 1) % count;
            ROUND
        };
        let mut ran = false;
        for turn in 0..count {
            let core = (start + turn) % count;
            if !runnable(core) {
                continue;
            }
            prepare(core);
            executed += run_core(budget);
            ran = true;
            // (SYSTEM_OFF, SYSTEM_RESET: the machine stops here)
            if unsafe { psci::REQUEST } != 0 {
                unsafe { crate::core_stats::flush_core_statistics() };
                return 0.0;
            }
        }
        if !ran || executed >= SLICE {
            break;
        }
    }
    unsafe { crate::core_stats::flush_core_statistics() };
    crate::aarch64::timer::tick_all();
    if (0..count).any(runnable) {
        0.0
    }
    else {
        sleep_ms()
    }
}

/// Reset the machine's cores: core 0 starts at `entry` with `x0`, the others are off
#[no_mangle]
pub fn a64_boot(entry_low: u32, entry_high: u32, x0_low: u32, x0_high: u32) {
    let entry = entry_low as u64 | (entry_high as u64) << 32;
    let x0 = x0_low as u64 | (x0_high as u64) << 32;
    switch_to(0);
    unsafe {
        for core in 1..MAX_CORES {
            SAVED[core].0.fill(0);
        }
        EVENTS = 0;
        MONITORS = 0;
        ROUND = 0;
        psci::POWER = [psci::OFF; MAX_CORES];
        psci::POWER[0] = psci::ON;
        psci::REQUEST = 0;
    }
    reset_state(entry, x0);
    crate::aarch64::gic::reset();
    crate::aarch64::tlb::flush(true);
}

// ---- snapshots (P3.10): the machine's state outside the cores' state blocks

/// The bytes of the machine's own state `which` (0 the GIC, 1 PSCI's power
/// states): its address in the Wasm memory and its size
#[no_mangle]
pub fn a64_machine_state(which: u32, size: bool) -> u32 {
    let (pointer, length) = match which {
        0 => crate::aarch64::gic::state_bytes(),
        _ => psci::state_bytes(),
    };
    if size {
        length
    }
    else {
        pointer
    }
}

/// After a state was restored: what derives from it is recomputed (interrupt
/// lines, the debug fast paths), what may not survive is dropped (TLBs, the
/// exclusive monitors); every core gets an event (a WFE may end early, as
/// the architecture allows, rather than miss one)
#[no_mangle]
pub fn a64_restored() {
    crate::aarch64::tlb::flush(true);
    crate::aarch64::debug::refresh();
    crate::aarch64::gic::restored();
    unsafe {
        MONITORS = 0;
        for core in 0..core_count() {
            *field(core, excl_valid) = 0;
        }
    }
    for core in 0..core_count() {
        event_to(core);
    }
    crate::aarch64::timer::tick_all();
}

/// The core's registers for JavaScript (tests, diagnostics): X0-X30, SP,
/// PC, NZCV, PSTATE are in the state block (src/arm/state_layout.js)
#[no_mangle]
pub fn a64_state_base() -> u32 { crate::state_block::state_base() }

#[cfg(test)]
mod tests {
    #[test]
    fn saved_range_covers_the_layout() {
        use crate::aarch64::state::{event_register, x};
        let base = crate::state_block::state_base() as usize;
        assert_eq!(x as usize - base, super::STATE_START);
        assert_eq!(event_register as usize + 4 - base, super::STATE_END);
    }
}
