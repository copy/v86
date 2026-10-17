//! The generic timer of the AArch64 core (docs/arm64-virt-android16-plan.md
//! P4.3): one system counter for the machine at CNTFRQ's 1 GHz, the EL1
//! virtual and physical timers of each core with their registers and their
//! interrupt lines (PPIs 27 and 30, level-sensitive, in the GIC), the event
//! stream of CNTKCTL_EL1; CNTVOFF is 0 (no EL2).

use crate::aarch64::cpu::{self, Exception};
use crate::aarch64::state::*;
use crate::aarch64::sysregs::key;

/// The system counter: nanoseconds of the machine's clock. With cores in
/// workers (P8.2) each reads its own host clock: the machine's last value
/// keeps the counter from going back from one core to the next.
pub fn counter() -> u64 {
    let now = unsafe { crate::isa::microtick() };
    let value = (now * 1_000_000.0) as u64;
    if crate::parallel::active() {
        unsafe { crate::parallel::max64(crate::parallel::machine(&raw mut COUNTER_LAST), value) }
    }
    else {
        value
    }
}
/// (cores in workers) the highest counter value read on any core
static mut COUNTER_LAST: u64 = 0;
/// The machine's clock was set back (a snapshot restored, a boot): the
/// counter follows it (every core is stopped)
pub fn reset_counter() { unsafe { *crate::parallel::machine(&raw mut COUNTER_LAST) = 0 } }

const CTL_ENABLE: u64 = 1;
const CTL_IMASK: u64 = 2;
const CTL_ISTATUS: u64 = 4;

/// The timers' PPIs (the INTIDs the DTB lists: virtual 27, non-secure physical 30)
pub const PPI_VIRTUAL: usize = 27;
pub const PPI_PHYSICAL: usize = 30;

/// The counter when the event stream last ticked (per core)
static mut EVENT_STREAM_LAST: [u64; crate::isa::MAX_CORES] = [0; crate::isa::MAX_CORES];

#[inline(always)]
fn fires(control: u64, compare: u64, now: u64) -> bool {
    control & CTL_ENABLE != 0 && now >= compare
}

/// Bring the current core's timer interrupt lines and event stream up to
/// the counter: called on timer register writes and from the run loop
pub fn tick() { tick_core(crate::isa::current_core(), counter()) }

/// Every core's timers (the cores that are not running too: their registers
/// are in their saved state, crate::aarch64::smp::field); with cores in
/// workers, this instance's core's
pub fn tick_all() {
    let now = counter();
    for core in crate::aarch64::smp::local() {
        tick_core(core, now);
    }
}

fn tick_core(core: usize, now: u64) {
    use crate::aarch64::smp::field;
    unsafe {
        let (vctl, vcval) = (*field(core, cntv_ctl), *field(core, cntv_cval));
        let (pctl, pcval) = (*field(core, cntp_ctl), *field(core, cntp_cval));
        let virtual_line = fires(vctl, vcval, now) && vctl & CTL_IMASK == 0;
        let physical_line = fires(pctl, pcval, now) && pctl & CTL_IMASK == 0;
        crate::aarch64::gic::set_ppi(core, PPI_VIRTUAL, virtual_line);
        crate::aarch64::gic::set_ppi(core, PPI_PHYSICAL, physical_line);
        // the event stream: an event whenever bit EVNTI of the counter has toggled
        let kctl = *field(core, cntkctl_el1);
        if kctl >> 2 & 1 != 0 {
            let shift = (kctl >> 4 & 15) + 1;
            if now >> shift != EVENT_STREAM_LAST[core] >> shift {
                crate::aarch64::smp::event_to(core);
            }
        }
        EVENT_STREAM_LAST[core] = now;
    }
}

/// Nanoseconds until core `core`'s timers or event stream next need it
/// (u64::MAX: never), for a core that waits
pub fn next_due(core: usize) -> u64 {
    use crate::aarch64::smp::field;
    let now = counter();
    let mut due = u64::MAX;
    unsafe {
        for (control, compare) in [
            (*field(core, cntv_ctl), *field(core, cntv_cval)),
            (*field(core, cntp_ctl), *field(core, cntp_cval)),
        ] {
            if control & CTL_ENABLE != 0 && control & CTL_IMASK == 0 {
                due = due.min(compare.saturating_sub(now));
            }
        }
        let kctl = *field(core, cntkctl_el1);
        if kctl >> 2 & 1 != 0 {
            due = due.min(1u64 << ((kctl >> 4 & 15) + 1));
        }
    }
    due
}

/// CNTx_CTL with ISTATUS: whether the timer's condition is met
fn ctl(control: u64, compare: u64) -> u64 {
    let status = control & CTL_ENABLE != 0 && counter() >= compare;
    control & (CTL_ENABLE | CTL_IMASK) | if status { CTL_ISTATUS } else { 0 }
}

fn trap(reg: u32, rt: u32, read: bool) -> Exception {
    let op0 = reg >> 14 & 3;
    let op1 = reg >> 11 & 7;
    let crn = reg >> 7 & 15;
    let crm = reg >> 3 & 15;
    let op2 = reg & 7;
    Exception::SystemRegister(
        op0 << 20 | op2 << 17 | op1 << 14 | crn << 10 | rt << 5 | crm << 1 | read as u32,
    )
}

/// Whether EL0 may access the register (CNTKCTL_EL1)
fn el0_allowed(reg: u32) -> bool {
    let kctl = unsafe { *cntkctl_el1 };
    let pcten = kctl & 1 != 0;
    let vcten = kctl & 2 != 0;
    match reg {
        r if r == key(3, 3, 14, 0, 0) => pcten || vcten,
        r if r == key(3, 3, 14, 0, 1) => pcten,
        r if r == key(3, 3, 14, 0, 2) => vcten,
        r if r >> 3 == key(3, 3, 14, 2, 0) >> 3 => kctl & 1 << 9 != 0,
        r if r >> 3 == key(3, 3, 14, 3, 0) >> 3 => kctl & 1 << 8 != 0,
        _ => false,
    }
}

pub fn read(reg: u32, rt: u32) -> Result<u64, Exception> {
    if cpu::el() == 0 && !el0_allowed(reg) {
        return Err(trap(reg, rt, true));
    }
    unsafe {
        Ok(match reg {
            r if r == key(3, 3, 14, 0, 0) => *cntfrq_el0,
            r if r == key(3, 3, 14, 0, 1) || r == key(3, 3, 14, 0, 2) => counter(),
            r if r == key(3, 3, 14, 2, 0) => {
                (*cntp_cval).wrapping_sub(counter()) as u32 as i32 as u64 & 0xFFFF_FFFF
            },
            r if r == key(3, 3, 14, 2, 1) => ctl(*cntp_ctl, *cntp_cval),
            r if r == key(3, 3, 14, 2, 2) => *cntp_cval,
            r if r == key(3, 3, 14, 3, 0) => {
                (*cntv_cval).wrapping_sub(counter()) as u32 as i32 as u64 & 0xFFFF_FFFF
            },
            r if r == key(3, 3, 14, 3, 1) => ctl(*cntv_ctl, *cntv_cval),
            r if r == key(3, 3, 14, 3, 2) => *cntv_cval,
            _ => return Err(Exception::Undefined),
        })
    }
}

pub fn write(reg: u32, rt: u32, value: u64) -> Result<(), Exception> {
    let el = cpu::el();
    if el == 0 && !el0_allowed(reg) {
        return Err(trap(reg, rt, false));
    }
    unsafe {
        match reg {
            // (CNTFRQ_EL0: writable at EL1, the highest EL here)
            r if r == key(3, 3, 14, 0, 0) => {
                if el == 0 {
                    return Err(Exception::Undefined);
                }
                *cntfrq_el0 = value & 0xFFFF_FFFF
            },
            r if r == key(3, 3, 14, 0, 1) || r == key(3, 3, 14, 0, 2) => {
                return Err(Exception::Undefined)
            },
            r if r == key(3, 3, 14, 2, 0) => {
                *cntp_cval = counter().wrapping_add(value as u32 as i32 as i64 as u64)
            },
            r if r == key(3, 3, 14, 2, 1) => *cntp_ctl = value & (CTL_ENABLE | CTL_IMASK),
            r if r == key(3, 3, 14, 2, 2) => *cntp_cval = value,
            r if r == key(3, 3, 14, 3, 0) => {
                *cntv_cval = counter().wrapping_add(value as u32 as i32 as i64 as u64)
            },
            r if r == key(3, 3, 14, 3, 1) => *cntv_ctl = value & (CTL_ENABLE | CTL_IMASK),
            r if r == key(3, 3, 14, 3, 2) => *cntv_cval = value,
            _ => return Err(Exception::Undefined),
        }
    }
    tick();
    Ok(())
}
