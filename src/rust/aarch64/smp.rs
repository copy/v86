//! The machine's cores and how they run (docs/arm64-virt-android16-plan.md
//! P3.9: cooperative SMP; P8.2 runs them in workers): one core at a time in
//! the state block, the others' state in their saved copies, switched in a
//! round robin of bounded turns; waiting (WFI, WFE), events (SEV, the event
//! stream, the global monitor), starting cores (PSCI CPU_ON), and the global
//! exclusive monitor (P3.7). The GIC's CPU interfaces, the TLBs and the
//! statistics are per core already and stay where they are.
//!
//! With cores in workers (P8.2) each instance runs one core (`local`): the
//! machine instance core 0, a worker its own; the events and the global
//! monitor are the machine's words, and an event for a core in another
//! instance kicks it. A worker runs its core through a64_worker_slice.

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
/// (src/arm/state_layout.js: a32_fpexc at 1480, cpu_type arm32's; the
/// page tier's scratch fields before the a32 range come along, unused
/// between activations)
const STATE_START: usize = 64;
const STATE_END: usize = 1484;
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
/// (diagnostics, this instance's) runs a kick ended early
static mut KICKED: u32 = 0;
/// A kick ended the last run: the machine's core returns to its loop, which
/// serves the workers' requests (a device register access waits for it)
static mut KICKED_NOW: bool = false;
#[no_mangle]
pub fn a64_kicked() -> u32 { unsafe { KICKED } }

/// (cores in workers) a WFE of this instance's core ends by this counter
/// value at the latest: a store compiled in another worker clears no
/// reservation and sends no event, and WFE may end without one
static mut WFE_UNTIL: u64 = 0;
const WFE_TIMEOUT_NS: u64 = 20_000;
/// (cores in workers) the most instructions an activation of compiled code runs
const ACTIVATION: u32 = 1024;

/// The global monitor (P3.7): the cores holding a reservation, and each one's
/// 64-byte granule of guest RAM (its offset in the RAM's backing >> 6)
static mut MONITORS: u32 = 0;
static mut MONITOR_GRANULE: [u32; MAX_CORES] = [0; MAX_CORES];

#[inline(always)]
fn live() -> *mut u8 { (crate::state_block::state_base() as usize + STATE_START) as *mut u8 }

/// The cores this instance runs: all of them, or with cores in workers its own
#[inline]
pub fn local() -> core::ops::Range<usize> {
    if crate::parallel::active() {
        current_core()..current_core() + 1
    }
    else {
        0..core_count()
    }
}

// the machine's words (crate::parallel::machine): events, the global monitor
#[inline(always)]
fn events() -> *mut u32 { crate::parallel::machine(&raw mut EVENTS) }
#[inline(always)]
fn monitors() -> *mut u32 { crate::parallel::machine(&raw mut MONITORS) }
#[inline(always)]
fn granule(core: usize) -> *mut u32 {
    unsafe {
        crate::parallel::machine(&raw mut MONITOR_GRANULE)
            .cast::<u32>()
            .add(core)
    }
}

/// A field of core `core`'s state: the state block for the running core, its saved copy otherwise
#[inline]
pub fn field<T>(core: usize, pointer: *mut T) -> *mut T {
    if core == current_core() {
        pointer
    }
    else {
        // (the other cores' state is in other instances with cores in workers)
        debug_assert!(!crate::parallel::active());
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
    }
    take_events();
    // (what derives from the core's registers: the debug fast paths, the fetch fast path)
    crate::aarch64::debug::refresh();
    crate::aarch64::tlb::bump_generation();
    execute::core_switched();
    // (the page tier: this core's compiled stores to pages other cores hold
    // reservations in must reach monitors_written, P3.7; while it runs no
    // other core reserves, and reserved pages get no write entries)
    let others = unsafe { crate::parallel::word_load(monitors()) } & !(1 << core);
    if others != 0 {
        crate::aarch64::jit::pages::retire_reserved_writes(core, others);
    }
}

/// The running core's pending events (SEV, the event stream, a cleared reservation) set its event register
#[inline]
fn take_events() {
    let core = current_core();
    unsafe {
        if crate::parallel::word_load(events()) & 1 << core != 0 {
            crate::parallel::word_and(events(), !(1 << core));
            *event_register = 1;
        }
    }
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
            crate::parallel::word_or(events(), 1 << core);
            crate::parallel::kick(core);
        }
    }
}

/// SEV: an event to every core
pub fn send_event() {
    unsafe {
        *event_register = 1;
        let others = ((1u32 << core_count()) - 1) & !(1 << current_core());
        crate::parallel::word_or(events(), others);
        for core in 0..core_count() {
            if others & 1 << core != 0 {
                crate::parallel::kick(core);
            }
        }
    }
}

// ---- the global monitor (P3.7)

/// A load-exclusive of guest RAM at `backing` marks its granule for the running core
pub fn reserve(backing: u32) {
    let core = current_core();
    unsafe {
        crate::parallel::word_store(granule(core), backing >> 6);
        crate::parallel::word_or(monitors(), 1 << core);
    }
    // (other cores' compiled stores to the page must reach monitors_written:
    // their write entries to it retire when they next run, switch_to, and
    // the access cache fills none while the reservation holds, P3.7)
}

/// The RAM backing offset of `core`'s reserved granule
pub fn reserved_backing(core: usize) -> u32 {
    unsafe { crate::parallel::word_load(granule(core)) << 6 }
}

/// Whether a core holds a reservation in the RAM page at `backing` (the page
/// tier's access cache serves no stores to it)
pub fn reserved_page(backing: u32) -> bool {
    if core_count() == 1 {
        return false;
    }
    let page = backing >> 12;
    let held = unsafe { crate::parallel::word_load(monitors()) };
    held != 0
        && (0..MAX_CORES).any(|c| {
            held & 1 << c != 0 && unsafe { crate::parallel::word_load(granule(c)) } >> 6 == page
        })
}

/// Whether the running core's reservation of the granule at `backing` still holds
pub fn reserved(backing: u32) -> bool {
    let core = current_core();
    unsafe {
        crate::parallel::word_load(monitors()) & 1 << core != 0
            && crate::parallel::word_load(granule(core)) == backing >> 6
    }
}

/// The running core's reservation ends (a store-exclusive, CLREX)
pub fn release() { unsafe { crate::parallel::word_and(monitors(), !(1 << current_core())) } }

/// Guest RAM at [backing, backing + len) was written by the running core
/// (`device` false) or a device: the reservations of other observers on
/// those granules clear, and their cores get an event
#[inline(always)]
pub fn monitors_written(backing: u32, len: u32, device: bool) {
    let others = unsafe { crate::parallel::word_load(monitors()) }
        & if device { u32::MAX } else { !(1 << current_core()) };
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
            let reserved = unsafe { crate::parallel::word_load(granule(core)) };
            if reserved >= first && reserved <= last {
                unsafe { crate::parallel::word_and(monitors(), !(1 << core)) };
                event_to(core);
            }
        }
    }
}

// ---- running

/// Take a pending interrupt the PE does not mask (at an instruction boundary): whether it did
#[inline(always)]
fn take_interrupt() -> bool {
    let signal = crate::aarch64::gic::signal(current_core());
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
    let signal = crate::aarch64::gic::signal(core);
    match kind {
        1 => signal != 0,
        2 => {
            let state = unsafe { *field(core, pstate) };
            let unmasked = signal & crate::aarch64::gic::SIGNAL_IRQ != 0
                && state & cpu::PSTATE_I == 0
                || signal & crate::aarch64::gic::SIGNAL_FIQ != 0 && state & cpu::PSTATE_F == 0;
            unmasked
                || unsafe {
                    *field(core, event_register) != 0
                        || crate::parallel::word_load(events()) & 1 << core != 0
                        || crate::parallel::active()
                            && crate::aarch64::timer::counter() >= WFE_UNTIL
                }
        },
        _ => false,
    }
}

/// Whether core `core` can run now (PSCI's power state, its wait)
fn runnable(core: usize) -> bool {
    match psci::power(core) {
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
    take_events();
    unsafe {
        if psci::power(core) == psci::ON_PENDING {
            let (entry, context) = psci::start(core);
            reset_state(entry, context);
            psci::set_power(core, psci::ON);
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
    unsafe { crate::parallel::word_and(events(), !(1 << current_core())) };
}

/// Run the running core for up to `budget` instructions: how many it ran.
/// At each block boundary (a branch, an exception, an interrupt, the turn's
/// start) the A64 page tier may run the PC's compiled function
/// (crate::aarch64::jit::pages; J2), else instructions are interpreted.
/// With cores in workers a kick (an interrupt, an event, a stop, another
/// core's TLBI) ends the run early.
fn run_core(budget: u32) -> u32 {
    use crate::aarch64::jit::pages::{self, Ran};
    let several = core_count() > 1;
    let mut i = 0;
    let mut next_tick = 1023;
    let mut boundary = true;
    while i < budget {
        if cfg!(feature = "parallel") && unsafe { crate::aarch64::isa_hooks::CORE_YIELD } != 0 {
            unsafe {
                crate::aarch64::isa_hooks::CORE_YIELD = 0;
                KICKED += 1;
                KICKED_NOW = true;
            }
            // (what the kick may be for: another core's DSB waiting for this one)
            crate::aarch64::isa_hooks::poll();
            break;
        }
        if i >= next_tick {
            crate::aarch64::timer::tick();
            next_tick = i + 1024;
            // (no compiled code is active: frames of extended RAM the access
            // caches hold are released if due; a64_asid_tag's auto mode)
            unsafe { crate::extended::safe_point() };
            pages::asid_tag_tick();
        }
        if crate::aarch64::gic::signal(current_core()) != 0 && take_interrupt() {
            i += 1;
            boundary = true;
            continue;
        }
        let flow = if boundary && unsafe { pages::ENABLED } {
            boundary = false;
            // (with cores in workers an activation is short: a kick, another
            // core's DSB waiting for this one, ends the run at its end)
            let activation =
                if crate::parallel::active() { (budget - i).min(ACTIVATION) } else { budget - i };
            match pages::run(activation) {
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
                take_events();
                if wakes(current_core(), kind) {
                    if kind == 2 {
                        unsafe { *event_register = 0 };
                    }
                    continue;
                }
                unsafe { *waiting = kind };
                if kind == 2 && crate::parallel::active() {
                    unsafe { WFE_UNTIL = crate::aarch64::timer::counter() + WFE_TIMEOUT_NS };
                }
                unsafe { crate::core_stats::note_halt() };
                return i;
            },
            Flow::Off => {
                unsafe { *waiting = 3 };
                return i;
            },
            // (YIELD: the other cores' turn; a spin loop waits for one of them)
            Flow::Yield if several => return i,
            // (a DSB waits for other cores' acknowledgements, P8.3: a worker
            // waits here, taking the others' maintenance meanwhile, until a
            // kick asks it to stop; the machine's core returns, its loop
            // serves the workers' requests meanwhile)
            Flow::Retry => {
                if !crate::parallel::is_worker() || !wait_synced() {
                    return i;
                }
            },
            _ => {},
        }
    }
    i
}

/// (a worker's DSB) until the TLB maintenance this core posted is done on
/// the others, taking theirs meanwhile: whether it is (else a kick asks
/// this core to stop, or it waited long)
fn wait_synced() -> bool {
    for _ in 0..1 << 16 {
        crate::aarch64::isa_hooks::poll();
        if crate::aarch64::tlb::synced() {
            return true;
        }
        if unsafe { crate::aarch64::isa_hooks::CORE_YIELD } != 0 {
            return false;
        }
        std::hint::spin_loop();
    }
    false
}

/// The milliseconds the machine can sleep: until the first waiting core's
/// timers or event stream need it (capped at 100)
fn sleep_ms() -> f64 {
    let mut due = u64::MAX;
    for core in local() {
        if psci::power(core) == psci::ON && unsafe { *field(core, waiting) } != 3 {
            due = due.min(crate::aarch64::timer::next_due(core));
            if crate::parallel::active() && unsafe { *field(core, waiting) } == 2 {
                due =
                    due.min(unsafe { WFE_UNTIL }.saturating_sub(crate::aarch64::timer::counter()));
            }
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
/// (0: run again soon). With cores in workers, only the machine's core runs here.
#[no_mangle]
pub fn a64_run_slice(_now: f64) -> f64 {
    if psci::a64_powered_off() {
        return 100.0;
    }
    let cores = local();
    let count = cores.len();
    let budget = if core_count() == 1 { SLICE } else { QUANTUM };
    let mut executed = 0;
    // (other cores' code writes, publications and TLB maintenance, P8.2, P8.3)
    crate::aarch64::isa_hooks::poll();
    loop {
        crate::aarch64::timer::tick_all();
        let start = unsafe {
            ROUND = (ROUND + 1) % count;
            ROUND
        };
        let mut ran = false;
        for turn in 0..count {
            let core = cores.start + (start + turn) % count;
            // (with cores in workers, what they posted: they may wait for this core's acknowledgement)
            crate::aarch64::isa_hooks::poll();
            if !runnable(core) {
                continue;
            }
            prepare(core);
            executed += run_core(budget);
            ran = true;
            if crate::parallel::active()
                && unsafe { core::ptr::replace(&raw mut KICKED_NOW, false) }
            {
                unsafe { crate::core_stats::flush_core_statistics() };
                return 0.0;
            }
            // (SYSTEM_OFF, SYSTEM_RESET: the machine stops here)
            if psci::request() != 0 {
                unsafe { crate::core_stats::flush_core_statistics() };
                return 0.0;
            }
        }
        // (with cores in workers the machine's loop serves their requests between slices)
        if !ran || executed >= SLICE || crate::parallel::active() && executed >= 4 * QUANTUM {
            break;
        }
    }
    unsafe { crate::core_stats::flush_core_statistics() };
    crate::aarch64::timer::tick_all();
    if cores.clone().any(runnable) {
        0.0
    }
    else {
        sleep_ms()
    }
}

/// A vCPU worker's slice (P8.2): its core, up to `budget` instructions. The
/// milliseconds until it needs to run again (0: at once, the core waits
/// otherwise), or -1 while it is off (it waits for CPU_ON). Other cores'
/// code writes, publications and TLB maintenance are taken first.
#[no_mangle]
pub fn a64_worker_slice(budget: u32) -> f64 {
    unsafe { crate::aarch64::bus::sync_worker_if_stale() };
    crate::aarch64::isa_hooks::poll();
    let core = current_core();
    if psci::request() != 0 || psci::power(core) == psci::OFF {
        return -1.0;
    }
    crate::aarch64::timer::tick();
    if !runnable(core) {
        return sleep_ms().max(0.01);
    }
    prepare(core);
    run_core(budget);
    unsafe { crate::core_stats::flush_core_statistics() };
    crate::aarch64::timer::tick();
    if runnable(core) {
        0.0
    }
    else if psci::power(core) == psci::OFF {
        -1.0
    }
    else {
        sleep_ms().max(0.01)
    }
}

/// Reset the machine's cores: core 0 starts at `entry` with `x0`, the others
/// are off (with cores in workers, the workers reset theirs: COMMAND_RESET)
#[no_mangle]
pub fn a64_boot(entry_low: u32, entry_high: u32, x0_low: u32, x0_high: u32) {
    let entry = entry_low as u64 | (entry_high as u64) << 32;
    let x0 = x0_low as u64 | (x0_high as u64) << 32;
    switch_to(0);
    unsafe {
        for core in 1..MAX_CORES {
            SAVED[core].0.fill(0);
        }
        crate::parallel::word_store(events(), 0);
        crate::parallel::word_store(monitors(), 0);
        ROUND = 0;
    }
    psci::reset();
    crate::aarch64::timer::reset_counter();
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
        // (the GICv2's own state, docs/aarch32-plan.md R4.2)
        2 => crate::aarch64::gic::v2_state_bytes(),
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
/// the architecture allows, rather than miss one). With cores in workers,
/// the machine's core here, each worker's in a64_worker_restored.
#[no_mangle]
pub fn a64_restored() {
    crate::aarch64::timer::reset_counter();
    crate::aarch64::tlb::flush(true);
    crate::aarch64::debug::refresh();
    crate::aarch64::gic::restored();
    unsafe {
        crate::parallel::word_store(monitors(), 0);
        for core in local() {
            *field(core, excl_valid) = 0;
        }
    }
    for core in 0..core_count() {
        event_to(core);
    }
    crate::aarch64::timer::tick_all();
}

/// (a vCPU worker, P8.2) its core's state was replaced: as a64_restored for it
#[no_mangle]
pub fn a64_worker_restored() {
    crate::aarch64::tlb::flush(false);
    crate::aarch64::debug::refresh();
    unsafe { *excl_valid = 0 };
    event_to(current_core());
    crate::aarch64::timer::tick();
}

/// The core's registers for JavaScript (tests, diagnostics): X0-X30, SP,
/// PC, NZCV, PSTATE are in the state block (src/arm/state_layout.js)
#[no_mangle]
pub fn a64_state_base() -> u32 { crate::state_block::state_base() }

#[cfg(test)]
mod tests {
    #[test]
    fn saved_range_covers_the_layout() {
        use crate::aarch64::state::{a32_fpexc, x};
        let base = crate::state_block::state_base() as usize;
        assert_eq!(x as usize - base, super::STATE_START);
        assert_eq!(a32_fpexc as usize + 4 - base, super::STATE_END);
    }
}
