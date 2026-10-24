//! The GICv3 of the virt machine (docs/arm64-virt-android16-plan.md P4.2):
//! the distributor (GICD), one redistributor (GICR, RD and SGI frames) and
//! one CPU interface (the ICC_* system registers) per core, decoded here in
//! Rust. The configuration is the reference's (QEMU 9.2 virt, gic-version=3,
//! its=off, no EL3): one security state (GICD_CTLR.DS = 1), affinity
//! routing always on, 288 INTIDs (256 SPIs), no LPIs, 5 priority bits;
//! group 0 is signaled as FIQ and group 1 as IRQ. Where the architecture
//! leaves a choice this follows QEMU's hw/intc/arm_gicv3*.c: equal
//! priorities go to the lowest INTID, the distributor keeps all 8 priority
//! bits, IROUTER's IRM is ignored (No1N), an SPI routed to no core stays
//! pending.
//!
//! With cores in workers (P8.2) the GIC is the machine instance's: every
//! entry point holds its lock (re-entrant), the signals are its bytes, and a
//! changed signal of another core kicks that core.
//!
//! The same state behind a GICv2's registers (a64_gic_set_version(2): the
//! ranchu board's Linux 3.10, docs/aarch32-plan.md R4.2, R6): the
//! distributor without affinity routing (the SGIs' and PPIs' registers
//! banked per core, ITARGETSR, GICD_SGIR and the SGIs' source cores) and a
//! memory-mapped CPU interface (GICC) at GICC_BASE whose priority logic is
//! the ICC registers'; group 0 is an IRQ there unless GICC_CTLR.FIQEn. No
//! Security Extensions, 5 priority bits, as QEMU's GICv2 without EL3.

use crate::aarch64::cpu::{self, Exception};
use crate::isa::MAX_CORES;

pub const NUM_IRQ: usize = 288;
const WORDS: usize = NUM_IRQ / 32;
const SPURIOUS: u64 = 1023;

/// The distributor's and redistributors' frames
pub const GICD_BASE: u64 = 0x0800_0000;
pub const GICD_SIZE: u64 = 0x1_0000;
pub const GICR_BASE: u64 = 0x080A_0000;
pub const GICR_STRIDE: u64 = 0x2_0000;
/// The GICv2 CPU interface's frame (GICC_DIR at 0x1000)
pub const GICC_BASE: u64 = 0x0801_0000;
pub const GICC_SIZE: u64 = 0x1_0000;

const CTLR_EN_GRP0: u32 = 1 << 0;
const CTLR_EN_GRP1: u32 = 1 << 1;
const CTLR_ARE: u32 = 1 << 4;
const CTLR_DS: u32 = 1 << 6;

// the CPU interface
const PRIBITS: u32 = 5;
const PRIO_MASK: u32 = (0xFF << (8 - PRIBITS)) & 0xFF;
/// The minimum BPR of group 0 (7 - PREbits) and group 1 (one more)
const MIN_BPR0: u32 = 7 - PRIBITS;
const MIN_BPR1: u32 = MIN_BPR0 + 1;
const ICC_CTLR_CBPR: u32 = 1 << 0;
const ICC_CTLR_EOIMODE: u32 = 1 << 1;
const ICC_CTLR_RESET: u32 = 1 << 15 /* A3V */ | 1 << 11 /* IDbits: 24 */ | (PRIBITS - 1) << 8;

#[derive(Clone, Copy)]
struct Distributor {
    ctlr: u32,
    group: [u32; WORDS],
    enabled: [u32; WORDS],
    pending: [u32; WORDS],
    active: [u32; WORDS],
    level: [u32; WORDS],
    edge: [u32; WORDS],
    priority: [u8; NUM_IRQ],
    irouter: [u64; NUM_IRQ],
}

#[derive(Clone, Copy)]
struct Redistributor {
    waker: u32,
    group: u32,
    enabled: u32,
    pending: u32,
    active: u32,
    level: u32,
    edge: u32,
    priority: [u8; 32],
}

/// A core's CPU interface: index 0 group 0, 1 group 1
#[derive(Clone, Copy)]
struct CpuInterface {
    pmr: u32,
    bpr: [u32; 2],
    igrpen: [u32; 2],
    ctlr: u32,
    apr: [u32; 2],
}

/// The highest priority pending interrupt of a core: (INTID, priority, group); priority 0x100 none
#[derive(Clone, Copy)]
struct Hppi {
    irq: u32,
    prio: u32,
    group: usize,
}

const HPPI_NONE: Hppi = Hppi {
    irq: SPURIOUS as u32,
    prio: 0x100,
    group: 0,
};

struct Gic {
    dist: Distributor,
    redist: [Redistributor; MAX_CORES],
    cpuif: [CpuInterface; MAX_CORES],
    hppi: [Hppi; MAX_CORES],
}

const REDIST_RESET: Redistributor = Redistributor {
    waker: 0b110,
    group: 0,
    enabled: 0,
    pending: 0,
    active: 0,
    level: 0,
    edge: 0xFFFF,
    priority: [0; 32],
};
const CPUIF_RESET: CpuInterface = CpuInterface {
    pmr: 0,
    bpr: [MIN_BPR0, MIN_BPR1],
    igrpen: [0, 0],
    ctlr: ICC_CTLR_RESET,
    apr: [0, 0],
};

static mut GIC: Gic = Gic {
    dist: Distributor {
        ctlr: CTLR_DS | CTLR_ARE,
        group: [0; WORDS],
        enabled: [0; WORDS],
        pending: [0; WORDS],
        active: [0; WORDS],
        level: [0; WORDS],
        edge: [0; WORDS],
        priority: [0; NUM_IRQ],
        irouter: [0; NUM_IRQ],
    },
    redist: [REDIST_RESET; MAX_CORES],
    cpuif: [CPUIF_RESET; MAX_CORES],
    hppi: [HPPI_NONE; MAX_CORES],
};

/// The GICv2's own state (a64_gic_set_version; snapshots: a64_machine_state 2)
#[derive(Clone, Copy)]
struct Gic2 {
    /// 2 or 3
    version: u32,
    /// ITARGETSR of the SPIs: the cores an SPI may go to (the lowest takes it)
    targets: [u8; NUM_IRQ],
    /// the source cores of each core's pending SGIs
    sgi_sources: [[u8; 16]; MAX_CORES],
    /// GICC_CTLR's bits besides the group enables and EOImode: AckCtl, FIQEn, CBPR
    ctlr: [u32; MAX_CORES],
    /// the source core of each core's active SGIs (IAR's CPUID)
    active_source: [[u8; 16]; MAX_CORES],
}
static mut GIC2: Gic2 = Gic2 {
    version: 3,
    targets: [0; NUM_IRQ],
    sgi_sources: [[0; 16]; MAX_CORES],
    ctlr: [0; MAX_CORES],
    active_source: [[0; 16]; MAX_CORES],
};
#[inline(always)]
fn gic2() -> &'static mut Gic2 { unsafe { &mut *crate::parallel::machine(&raw mut GIC2) } }
/// Whether the GIC is a GICv2
#[inline(always)]
pub fn is_v2() -> bool { gic2().version == 2 }

/// (the machine, before a64_set_cores) the GIC's architecture: 2 or 3 (the default)
#[no_mangle]
pub fn a64_gic_set_version(version: u32) {
    gic2().version = if version == 2 { 2 } else { 3 };
    reset();
}

/// (snapshots) the GICv2's own state as bytes: its address and size
pub fn v2_state_bytes() -> (u32, u32) {
    (&raw const GIC2 as u32, core::mem::size_of::<Gic2>() as u32)
}

const GICC_CTLR_FIQEN: u32 = 1 << 3;
const GICC_CTLR_CBPR: u32 = 1 << 4;
const GICC_CTLR_EOIMODE: u32 = 1 << 9;

/// Each core's interrupt request to the PE: bit 0 IRQ, bit 1 FIQ
pub static mut SIGNAL: [u8; MAX_CORES] = [0; MAX_CORES];
pub const SIGNAL_IRQ: u8 = 1;
pub const SIGNAL_FIQ: u8 = 2;

#[inline(always)]
fn gic() -> &'static mut Gic { unsafe { &mut *crate::parallel::machine(&raw mut GIC) } }

/// Core `core`'s interrupt request to the PE (SIGNAL_IRQ, SIGNAL_FIQ)
#[inline(always)]
pub fn signal(core: usize) -> u8 {
    unsafe {
        crate::parallel::load8(
            crate::parallel::machine(&raw mut SIGNAL)
                .cast::<u8>()
                .add(core),
        )
    }
}
fn set_signal(core: usize, value: u8) {
    unsafe {
        let at = crate::parallel::machine(&raw mut SIGNAL)
            .cast::<u8>()
            .add(core);
        if crate::parallel::load8(at) != value {
            crate::parallel::store8(at, value);
            // (a core in a worker leaves its slice or its wait)
            if value != 0 && core != crate::isa::current_core() {
                crate::parallel::kick(core);
            }
        }
    }
}

/// (cores in workers) the machine's GIC lock, held through each entry point
static mut LOCK: crate::parallel::SpinLock = crate::parallel::SpinLock::new();
/// How deep this instance's core holds it
static mut DEPTH: u32 = 0;
struct Guard;
impl Guard {
    #[inline(always)]
    fn new() -> Guard {
        unsafe {
            if crate::parallel::active() {
                if DEPTH == 0 {
                    (*crate::parallel::machine(&raw mut LOCK)).lock();
                }
                DEPTH += 1;
            }
        }
        Guard
    }
}
impl Drop for Guard {
    #[inline(always)]
    fn drop(&mut self) {
        unsafe {
            if crate::parallel::active() {
                DEPTH -= 1;
                if DEPTH == 0 {
                    (*crate::parallel::machine(&raw mut LOCK)).unlock();
                }
            }
        }
    }
}
/// A failed core's worker holds the lock no more (crate::parallel::parallel_fail)
pub fn release_held_by(core: usize) {
    unsafe { (*crate::parallel::machine(&raw mut LOCK)).release_held_by(core) }
}
/// (tests/parallel/lifecycle.mjs) a failing core traps inside the critical section
pub fn lock_for_test_fault() { unsafe { (*crate::parallel::machine(&raw mut LOCK)).lock() } }

fn cores() -> usize { crate::isa::core_count() }

/// (snapshots) the GIC's state as bytes: its address and size
pub fn state_bytes() -> (u32, u32) { (&raw const GIC as u32, core::mem::size_of::<Gic>() as u32) }

/// (snapshots) the state was replaced: the signals follow it
pub fn restored() {
    let _guard = Guard::new();
    update_all();
}

/// Reset the distributor, the redistributors and the CPU interfaces
pub fn reset() {
    let _guard = Guard::new();
    let g = gic();
    g.dist = Distributor {
        ctlr: CTLR_DS | CTLR_ARE,
        group: [0; WORDS],
        enabled: [0; WORDS],
        pending: [0; WORDS],
        active: [0; WORDS],
        level: [0; WORDS],
        edge: [0; WORDS],
        priority: [0; NUM_IRQ],
        irouter: [0; NUM_IRQ],
    };
    g.redist = [REDIST_RESET; MAX_CORES];
    g.cpuif = [CPUIF_RESET; MAX_CORES];
    g.hppi = [HPPI_NONE; MAX_CORES];
    let v2 = gic2();
    v2.targets = [0; NUM_IRQ];
    v2.sgi_sources = [[0; 16]; MAX_CORES];
    v2.ctlr = [0; MAX_CORES];
    v2.active_source = [[0; 16]; MAX_CORES];
    if v2.version == 2 {
        // (no affinity routing; the SGIs always enabled, as QEMU's; BPR's
        // minimum 0, ABPR's 1)
        g.dist.ctlr = 0;
        for core in 0..MAX_CORES {
            g.redist[core].enabled = 0xFFFF;
            g.cpuif[core].bpr = [0, 1];
        }
    }
    for core in 0..MAX_CORES {
        set_signal(core, 0);
    }
}

#[inline(always)]
fn bit(words: &[u32], irq: usize) -> bool { words[irq / 32] >> (irq % 32) & 1 != 0 }
#[inline(always)]
fn set_bit(words: &mut [u32], irq: usize, value: bool) {
    if value {
        words[irq / 32] |= 1 << (irq % 32);
    }
    else {
        words[irq / 32] &= !(1 << (irq % 32));
    }
}

/// The core an SPI goes to (its IROUTER's affinity; a GICv2's lowest ITARGETSR core), if any
fn target(irq: usize) -> Option<usize> {
    if is_v2() {
        let mask = gic2().targets[irq];
        let core = mask.trailing_zeros() as usize;
        return (mask != 0 && core < cores()).then_some(core);
    }
    let r = gic().dist.irouter[irq];
    // (Aff3:Aff2:Aff1:Aff0; Aff0 is the core, the others 0)
    let affinity = r & 0xFF_FFFF | (r >> 32 & 0xFF) << 24;
    let core = affinity as usize;
    (core < cores()).then_some(core)
}

/// Group enables of the distributor, as a mask for the group bits `group`
#[inline(always)]
fn group_mask(group: u32) -> u32 {
    let ctlr = gic().dist.ctlr;
    let mut mask = 0;
    if ctlr & CTLR_EN_GRP1 != 0 {
        mask |= group;
    }
    if ctlr & CTLR_EN_GRP0 != 0 {
        mask |= !group;
    }
    mask
}

/// Recompute a core's highest priority pending interrupt and its IRQ/FIQ signal
fn update(core: usize) {
    let g = gic();
    let mut best = HPPI_NONE;
    let mut consider = |irq: usize, prio: u32, group: usize| {
        if prio < best.prio || prio == best.prio && (irq as u32) < best.irq {
            best = Hppi {
                irq: irq as u32,
                prio,
                group,
            };
        }
    };
    let r = &g.redist[core];
    let pending = (r.pending | !r.edge & r.level) & r.enabled & !r.active & group_mask(r.group);
    let mut bits = pending;
    while bits != 0 {
        let irq = bits.trailing_zeros() as usize;
        bits &= bits - 1;
        consider(irq, r.priority[irq] as u32, (r.group >> irq & 1) as usize);
    }
    let d = &g.dist;
    for w in 1..WORDS {
        let mut bits = (d.pending[w] | !d.edge[w] & d.level[w])
            & d.enabled[w]
            & !d.active[w]
            & group_mask(d.group[w]);
        while bits != 0 {
            let irq = w * 32 + bits.trailing_zeros() as usize;
            bits &= bits - 1;
            if target(irq) == Some(core) {
                consider(irq, d.priority[irq] as u32, bit(&d.group, irq) as usize);
            }
        }
    }
    g.hppi[core] = best;
    let signal = if can_preempt(core) {
        // (a GICv2's group 0 is an IRQ unless FIQEn)
        if best.group == 0 && (!is_v2() || gic2().ctlr[core] & GICC_CTLR_FIQEN != 0) {
            SIGNAL_FIQ
        }
        else {
            SIGNAL_IRQ
        }
    }
    else {
        0
    };
    set_signal(core, signal);
}

fn update_all() {
    for core in 0..cores() {
        update(core);
    }
}

/// The SPI `irq` changed: its target core's state
fn update_spi(irq: usize) {
    match target(irq) {
        Some(core) => update(core),
        None => update_all(),
    }
}

// ---- the CPU interface's priority logic

/// The running priority: from the lowest set bit of the active priorities, 0xFF idle
fn running_priority(core: usize) -> u32 {
    let c = &gic().cpuif[core];
    let apr = c.apr[0] | c.apr[1];
    if apr == 0 {
        0xFF
    }
    else {
        apr.trailing_zeros() << (MIN_BPR0 + 1)
    }
}

/// The mask of a group's group-priority bits (GroupBits)
fn group_priority_mask(core: usize, group: usize) -> u32 {
    let c = &gic().cpuif[core];
    let (group, bpr) = if group == 1 && c.ctlr & ICC_CTLR_CBPR != 0 {
        (0, c.bpr[0] & 7)
    }
    else {
        (group, c.bpr[group] & 7)
    };
    let bpr = if group == 1 { bpr - 1 } else { bpr };
    !0u32 << (bpr + 1)
}

fn no_enabled_hppi(core: usize) -> bool {
    let h = gic().hppi[core];
    h.prio == 0x100 || gic().cpuif[core].igrpen[h.group] == 0
}

fn can_preempt(core: usize) -> bool {
    if no_enabled_hppi(core) {
        return false;
    }
    let h = gic().hppi[core];
    if h.prio >= gic().cpuif[core].pmr {
        return false;
    }
    let running = running_priority(core);
    if running == 0xFF {
        return true;
    }
    let mask = group_priority_mask(core, h.group);
    h.prio & mask < running & mask
}

fn activate(core: usize, irq: usize) {
    let g = gic();
    let h = g.hppi[core];
    let prio = h.prio & group_priority_mask(core, h.group);
    let aprbit = prio >> (8 - PRIBITS);
    g.cpuif[core].apr[h.group] |= 1 << aprbit;
    if irq < 32 {
        let r = &mut g.redist[core];
        r.active |= 1 << irq;
        r.pending &= !(1 << irq);
        // (a GICv2's SGI: one source at a time, the others stay pending)
        if is_v2() && irq < 16 {
            let sources = &mut gic2().sgi_sources[core][irq];
            let source = sources.trailing_zeros().min(7) as u8;
            *sources &= !(1 << source);
            gic2().active_source[core][irq] = source;
            if *sources != 0 {
                g.redist[core].pending |= 1 << irq;
            }
        }
        update(core);
    }
    else {
        set_bit(&mut g.dist.active, irq, true);
        set_bit(&mut g.dist.pending, irq, false);
        update_spi(irq);
        update(core);
    }
}

fn deactivate(core: usize, irq: usize) {
    let g = gic();
    if irq < 32 {
        g.redist[core].active &= !(1 << irq);
        update(core);
    }
    else if irq < NUM_IRQ {
        set_bit(&mut g.dist.active, irq, false);
        update_spi(irq);
    }
}

fn highest_active_group(core: usize) -> Option<usize> {
    let c = &gic().cpuif[core];
    let (a0, a1) = (c.apr[0], c.apr[1]);
    if a0 == 0 && a1 == 0 {
        return None;
    }
    // (the lowest set bit is the highest priority)
    Some(if a1 != 0 && (a0 == 0 || a1.trailing_zeros() < a0.trailing_zeros()) { 1 } else { 0 })
}

// ---- input lines

/// A device's SPI line (INTID 32-287) went to `level`
pub fn set_spi(irq: usize, level: bool) {
    if !(32..NUM_IRQ).contains(&irq) {
        return;
    }
    let _guard = Guard::new();
    let d = &mut gic().dist;
    if bit(&d.level, irq) == level {
        return;
    }
    set_bit(&mut d.level, irq, level);
    if level && bit(&d.edge, irq) {
        set_bit(&mut d.pending, irq, true);
    }
    update_spi(irq);
}

/// A PPI line (INTID 16-31) of `core` went to `level` (the timers)
pub fn set_ppi(core: usize, irq: usize, level: bool) {
    let _guard = Guard::new();
    let r = &mut gic().redist[core];
    if r.level >> irq & 1 == level as u32 {
        return;
    }
    r.level = r.level & !(1 << irq) | (level as u32) << irq;
    if level && r.edge >> irq & 1 != 0 {
        r.pending |= 1 << irq;
    }
    update(core);
}

/// (src/virt: a device's interrupt line)
#[no_mangle]
pub fn a64_gic_set_spi(irq: u32, level: bool) { set_spi(irq as usize, level) }

/// ISR_EL1: the pending IRQ (bit 7) and FIQ (bit 6) of the current core
pub fn isr_el1() -> u64 {
    crate::aarch64::timer::tick();
    let s = signal(crate::isa::current_core());
    ((s & SIGNAL_IRQ != 0) as u64) << 7 | ((s & SIGNAL_FIQ != 0) as u64) << 6
}

// ---- the ICC system registers

/// Whether `reg` is an ICC_* register (op0 3, op1 0, CRn 12 with CRm 8, 9,
/// 11 or 12, or ICC_PMR_EL1)
pub fn is_icc(reg: u32) -> bool {
    let op0 = reg >> 14;
    let op1 = reg >> 11 & 7;
    let crn = reg >> 7 & 15;
    let crm = reg >> 3 & 15;
    let op2 = reg & 7;
    op0 == 3
        && op1 == 0
        && (crn == 12 && matches!(crm, 8 | 9 | 11 | 12) || crn == 4 && crm == 6 && op2 == 0)
}

fn hppir_value(core: usize, group: usize) -> u64 {
    if no_enabled_hppi(core) {
        return SPURIOUS;
    }
    let h = gic().hppi[core];
    if h.group != group {
        SPURIOUS
    }
    else {
        h.irq as u64
    }
}

pub fn icc_read(reg: u32) -> Result<u64, Exception> {
    if cpu::el() == 0 {
        return Err(Exception::Undefined);
    }
    crate::aarch64::timer::tick();
    let _guard = Guard::new();
    let core = crate::isa::current_core();
    let crm = reg >> 3 & 15;
    let op2 = reg & 7;
    let crn = reg >> 7 & 15;
    if crn == 4 {
        return Ok(gic().cpuif[core].pmr as u64);
    }
    let c = gic().cpuif[core];
    Ok(match (crm, op2) {
        (8, 0) | (12, 0) => {
            // IAR0, IAR1: acknowledge
            let group = (crm == 12) as usize;
            let intid = if can_preempt(core) { hppir_value(core, group) } else { SPURIOUS };
            if intid < 1020 {
                activate(core, intid as usize);
            }
            intid
        },
        (8, 2) => hppir_value(core, 0),
        (12, 2) => hppir_value(core, 1),
        (8, 3) => c.bpr[0] as u64,
        (12, 3) => {
            if c.ctlr & ICC_CTLR_CBPR != 0 {
                (c.bpr[0] + 1).min(7) as u64
            }
            else {
                c.bpr[1] as u64
            }
        },
        (8, 4..=7) => {
            if op2 == 4 {
                c.apr[0] as u64
            }
            else {
                0
            }
        },
        (9, 0..=3) => {
            if op2 == 0 {
                c.apr[1] as u64
            }
            else {
                0
            }
        },
        (11, 3) => running_priority(core) as u64,
        (12, 4) => c.ctlr as u64,
        // ICC_SRE_EL1: SRE, DFB, DIB (RAO/WI)
        (12, 5) => 7,
        (12, 6) => c.igrpen[0] as u64,
        (12, 7) => c.igrpen[1] as u64,
        // (EOIR, DIR, SGIxR are write-only)
        _ => return Err(Exception::Undefined),
    })
}

pub fn icc_write(reg: u32, value: u64) -> Result<(), Exception> {
    if cpu::el() == 0 {
        return Err(Exception::Undefined);
    }
    let _guard = Guard::new();
    let core = crate::isa::current_core();
    let crm = reg >> 3 & 15;
    let op2 = reg & 7;
    let crn = reg >> 7 & 15;
    let g = gic();
    if crn == 4 {
        g.cpuif[core].pmr = value as u32 & PRIO_MASK;
        update(core);
        return Ok(());
    }
    match (crm, op2) {
        (8, 1) | (12, 1) => {
            // EOIR0, EOIR1: priority drop (and deactivation unless EOImode)
            let irq = (value & 0xFF_FFFF) as usize;
            if irq >= NUM_IRQ {
                return Ok(());
            }
            let eoir0 = crm == 8;
            match highest_active_group(core) {
                Some(0) if eoir0 => {},
                Some(1) if !eoir0 => {},
                _ => return Ok(()),
            }
            let group = (!eoir0) as usize;
            let apr = &mut g.cpuif[core].apr[group];
            *apr &= apr.wrapping_sub(1);
            update(core);
            if g.cpuif[core].ctlr & ICC_CTLR_EOIMODE == 0 {
                deactivate(core, irq);
            }
        },
        (11, 1) => {
            // DIR: deactivation with EOImode
            let irq = (value & 0xFF_FFFF) as usize;
            if irq < NUM_IRQ && g.cpuif[core].ctlr & ICC_CTLR_EOIMODE != 0 {
                deactivate(core, irq);
            }
        },
        (8, 3) => {
            g.cpuif[core].bpr[0] = (value as u32).max(MIN_BPR0) & 7;
            update(core);
        },
        (12, 3) => {
            if g.cpuif[core].ctlr & ICC_CTLR_CBPR == 0 {
                g.cpuif[core].bpr[1] = (value as u32).max(MIN_BPR1) & 7;
                update(core);
            }
        },
        (8, 4..=7) => {
            if op2 == 4 {
                g.cpuif[core].apr[0] = value as u32;
                update(core);
            }
        },
        (9, 0..=3) => {
            if op2 == 0 {
                g.cpuif[core].apr[1] = value as u32;
                update(core);
            }
        },
        // SGI1R (group 1), ASGI1R (the other group: group 0 here), SGI0R
        (11, 5) => send_sgi(core, value, 1),
        (11, 6) | (11, 7) => send_sgi(core, value, 0),
        (12, 4) => {
            let mask = ICC_CTLR_CBPR | ICC_CTLR_EOIMODE;
            let c = &mut g.cpuif[core];
            c.ctlr = c.ctlr & !mask | value as u32 & mask;
            update(core);
        },
        (12, 5) => {},
        (12, 6) => {
            g.cpuif[core].igrpen[0] = value as u32 & 1;
            update(core);
        },
        (12, 7) => {
            g.cpuif[core].igrpen[1] = value as u32 & 1;
            update(core);
        },
        // (IAR, HPPIR, RPR are read-only)
        _ => return Err(Exception::Undefined),
    }
    Ok(())
}

/// ICC_SGI*R: SGI `value[27:24]` to the cores in the target list of
/// Aff3.Aff2.Aff1 (IRM 0) or to every other core (IRM 1), in `group`
fn send_sgi(core: usize, value: u64, group: usize) {
    let affinity = (value >> 48 & 0xFF) << 16 | (value >> 32 & 0xFF) << 8 | (value >> 16 & 0xFF);
    let targets = value & 0xFFFF;
    let irq = (value >> 24 & 15) as usize;
    let irm = value >> 40 & 1 != 0;
    for other in 0..cores() {
        if irm {
            if other == core {
                continue;
            }
        }
        else if affinity != 0 || other > 15 || targets >> other & 1 == 0 {
            continue;
        }
        // (the SGI is accepted if it is in the requested group at the target)
        let r = &mut gic().redist[other];
        if (r.group >> irq & 1) as usize != group {
            continue;
        }
        r.pending |= 1 << irq;
        update(other);
    }
}

// ---- the distributor's and redistributors' registers

/// ID registers at 0xFFD0-0xFFFC (PIDR4-7, PIDR0-3, CIDR0-3), `pidr0` the part
fn id_register(offset: u64, pidr0: u64) -> u64 {
    const IDS: [u64; 12] = [0x44, 0, 0, 0, 0x92, 0xB4, 0x3B, 0, 0x0D, 0xF0, 0x05, 0xB1];
    let index = ((offset - 0xFFD0) / 4) as usize;
    if index == 4 {
        pidr0
    }
    else {
        IDS[index]
    }
}

/// A bitmap register of 32 INTIDs at `word` (set/clear forms); `words` the state
fn bitmap_write(words: &mut [u32], word: usize, value: u32, set: bool) {
    if set {
        words[word] |= value;
    }
    else {
        words[word] &= !value;
    }
}

/// Read a byte-wide field array (IPRIORITYR) of `size` bytes from `bytes[irq..]`
fn bytes_read(bytes: &[u8], irq: usize, size: u32) -> u64 {
    let mut value = 0;
    for i in 0..size as usize {
        if irq + i < bytes.len() {
            value |= (bytes[irq + i] as u64) << (8 * i);
        }
    }
    value
}

pub fn gicd_read(offset: u64, size: u32) -> u64 {
    crate::aarch64::timer::tick_all();
    let _guard = Guard::new();
    if is_v2() {
        let value = gicd2_read(offset, size);
        return value & if size == 8 { u64::MAX } else { (1u64 << (8 * size)) - 1 };
    }
    let d = &gic().dist;
    let word = ((offset & 0x7F) / 4) as usize;
    let value = match offset {
        0x0000 => d.ctlr as u64,
        // TYPER: No1N, A3V, IDbits 16, ITLinesNumber
        0x0004 => (1 << 25 | 1 << 24 | 0xF << 19 | (NUM_IRQ / 32 - 1)) as u64,
        0x0008 => 0x43B,
        0x0080..=0x00FC => {
            if word == 0 || word >= WORDS {
                0
            }
            else {
                d.group[word] as u64
            }
        },
        0x0100..=0x017C | 0x0180..=0x01FC => {
            if word == 0 || word >= WORDS {
                0
            }
            else {
                d.enabled[word] as u64
            }
        },
        // (the pending latch, or the line of a level-sensitive interrupt)
        0x0200..=0x027C | 0x0280..=0x02FC => {
            if word == 0 || word >= WORDS {
                0
            }
            else {
                (d.pending[word] | !d.edge[word] & d.level[word]) as u64
            }
        },
        0x0300..=0x037C | 0x0380..=0x03FC => {
            if word == 0 || word >= WORDS {
                0
            }
            else {
                d.active[word] as u64
            }
        },
        0x0400..=0x07FB => {
            let irq = (offset - 0x400) as usize;
            if irq < 32 {
                0
            }
            else {
                bytes_read(&d.priority, irq, size)
            }
        },
        0x0C00..=0x0CFC => {
            // ICFGR: 16 INTIDs per word, bit 2n+1 edge
            let first = ((offset - 0xC00) / 4) as usize * 16;
            let mut value = 0u64;
            if first >= 32 && first < NUM_IRQ {
                for i in 0..16 {
                    if bit(&d.edge, first + i) {
                        value |= 2 << (2 * i);
                    }
                }
            }
            value
        },
        0x6100..=0x7FD8 => {
            let irq = ((offset - 0x6000) / 8) as usize;
            let v = if irq < NUM_IRQ { d.irouter[irq] } else { 0 };
            if offset & 4 != 0 {
                v >> 32
            }
            else {
                v
            }
        },
        0xFFD0..=0xFFFC => id_register(offset & !3, 0x92),
        _ => 0,
    };
    value & if size == 8 { u64::MAX } else { (1u64 << (8 * size)) - 1 }
}

pub fn gicd_write(offset: u64, size: u32, value: u64) {
    let _guard = Guard::new();
    if is_v2() {
        return gicd2_write(offset, size, value);
    }
    let g = gic();
    let word = ((offset & 0x7F) / 4) as usize;
    let v = value as u32;
    match offset {
        0x0000 => {
            let mask = CTLR_EN_GRP0 | CTLR_EN_GRP1;
            g.dist.ctlr = g.dist.ctlr & !mask | v & mask;
            update_all();
        },
        0x0080..=0x00FC if word != 0 && word < WORDS => {
            g.dist.group[word] = v;
            update_all();
        },
        0x0100..=0x017C if word != 0 && word < WORDS => {
            bitmap_write(&mut g.dist.enabled, word, v, true);
            update_all();
        },
        0x0180..=0x01FC if word != 0 && word < WORDS => {
            bitmap_write(&mut g.dist.enabled, word, v, false);
            update_all();
        },
        0x0200..=0x027C if word != 0 && word < WORDS => {
            bitmap_write(&mut g.dist.pending, word, v, true);
            update_all();
        },
        0x0280..=0x02FC if word != 0 && word < WORDS => {
            bitmap_write(&mut g.dist.pending, word, v, false);
            update_all();
        },
        0x0300..=0x037C if word != 0 && word < WORDS => {
            bitmap_write(&mut g.dist.active, word, v, true);
            update_all();
        },
        0x0380..=0x03FC if word != 0 && word < WORDS => {
            bitmap_write(&mut g.dist.active, word, v, false);
            update_all();
        },
        0x0400..=0x07FB => {
            let irq = (offset - 0x400) as usize;
            for i in 0..size as usize {
                if irq + i >= 32 && irq + i < NUM_IRQ {
                    g.dist.priority[irq + i] = (value >> (8 * i)) as u8;
                }
            }
            update_all();
        },
        0x0C00..=0x0CFC => {
            let first = ((offset - 0xC00) / 4) as usize * 16;
            if first >= 32 && first < NUM_IRQ {
                for i in 0..16 {
                    set_bit(&mut g.dist.edge, first + i, v >> (2 * i + 1) & 1 != 0);
                }
            }
            update_all();
        },
        0x6100..=0x7FD8 => {
            let irq = ((offset - 0x6000) / 8) as usize;
            if irq >= 32 && irq < NUM_IRQ {
                let old = g.dist.irouter[irq];
                g.dist.irouter[irq] = match (size, offset & 4) {
                    (8, _) => value,
                    (_, 0) => old & !0xFFFF_FFFF | value & 0xFFFF_FFFF,
                    _ => old & 0xFFFF_FFFF | (value & 0xFFFF_FFFF) << 32,
                };
                update_all();
            }
        },
        _ => {},
    }
}

pub fn gicr_read(offset: u64, size: u32) -> u64 {
    // (every core's timer lines as of now: they follow the counter)
    crate::aarch64::timer::tick_all();
    let _guard = Guard::new();
    let core = (offset / GICR_STRIDE) as usize;
    if core >= cores() {
        return 0;
    }
    let offset = offset % GICR_STRIDE;
    let r = &gic().redist[core];
    let typer =
        (core as u64) << 32 | 1 << 24 | (core as u64) << 8 | ((core + 1 == cores()) as u64) << 4;
    let value = match offset {
        0x0000 => 0,
        0x0004 => 0x43B,
        0x0008 => typer,
        0x000C => typer >> 32,
        0x0014 => r.waker as u64,
        0xFFD0..=0xFFFC => id_register(offset & !3, 0x93),
        0x1_0080 => r.group as u64,
        0x1_0100 | 0x1_0180 => r.enabled as u64,
        0x1_0200 | 0x1_0280 => (r.pending | !r.edge & r.level) as u64,
        0x1_0300 | 0x1_0380 => r.active as u64,
        0x1_0400..=0x1_041F => bytes_read(&r.priority, (offset - 0x1_0400) as usize, size),
        0x1_0C00 => 0xAAAA_AAAA,
        0x1_0C04 => {
            let mut value = 0u64;
            for i in 0..16 {
                if r.edge >> (16 + i) & 1 != 0 {
                    value |= 2 << (2 * i);
                }
            }
            value
        },
        _ => 0,
    };
    value & if size == 8 { u64::MAX } else { (1u64 << (8 * size)) - 1 }
}

pub fn gicr_write(offset: u64, size: u32, value: u64) {
    let _guard = Guard::new();
    let core = (offset / GICR_STRIDE) as usize;
    if core >= cores() {
        return;
    }
    let offset = offset % GICR_STRIDE;
    let r = &mut gic().redist[core];
    let v = value as u32;
    match offset {
        0x0014 => {
            // WAKER: ProcessorSleep, and ChildrenAsleep follows it at once
            let sleep = v & 2;
            r.waker = sleep | sleep << 1;
        },
        0x1_0080 => r.group = v,
        0x1_0100 => r.enabled |= v,
        0x1_0180 => r.enabled &= !v,
        0x1_0200 => r.pending |= v,
        0x1_0280 => r.pending &= !v,
        0x1_0300 => r.active |= v,
        0x1_0380 => r.active &= !v,
        0x1_0400..=0x1_041F => {
            let irq = (offset - 0x1_0400) as usize;
            for i in 0..size as usize {
                if irq + i < 32 {
                    r.priority[irq + i] = (value >> (8 * i)) as u8;
                }
            }
        },
        0x1_0C04 => {
            let mut edge = r.edge & 0xFFFF;
            for i in 0..16 {
                if v >> (2 * i + 1) & 1 != 0 {
                    edge |= 1 << (16 + i);
                }
            }
            r.edge = edge;
        },
        _ => return,
    }
    update(core);
}

// ---- the GICv2's registers

/// A GICv2 distributor register: the SGIs' and PPIs' words and bytes are
/// the current core's (its redistributor state)
fn gicd2_read(offset: u64, size: u32) -> u64 {
    let core = crate::isa::current_core();
    let g = gic();
    let d = &g.dist;
    let r = &g.redist[core];
    let word = ((offset & 0x7F) / 4) as usize;
    let banked = |w: usize, own: u32, words: &[u32; WORDS]| -> u64 {
        if w == 0 {
            own as u64
        }
        else if w < WORDS {
            words[w] as u64
        }
        else {
            0
        }
    };
    match offset {
        0x0000 => (d.ctlr & (CTLR_EN_GRP0 | CTLR_EN_GRP1)) as u64,
        // TYPER: CPUNumber, ITLinesNumber; no Security Extensions
        0x0004 => (cores() as u64 - 1) << 5 | (NUM_IRQ / 32 - 1) as u64,
        0x0008 => 0x43B,
        0x0080..=0x00FC => banked(word, r.group, &d.group),
        0x0100..=0x017C | 0x0180..=0x01FC => banked(word, r.enabled, &d.enabled),
        0x0200..=0x027C | 0x0280..=0x02FC => {
            let own = r.pending | !r.edge & r.level;
            if word == 0 {
                own as u64
            }
            else if word < WORDS {
                (d.pending[word] | !d.edge[word] & d.level[word]) as u64
            }
            else {
                0
            }
        },
        0x0300..=0x037C | 0x0380..=0x03FC => banked(word, r.active, &d.active),
        0x0400..=0x07FB => {
            let irq = (offset - 0x400) as usize;
            let mut value = 0u64;
            for i in 0..size as usize {
                let n = irq + i;
                let p = if n < 32 {
                    r.priority[n]
                }
                else if n < NUM_IRQ {
                    d.priority[n]
                }
                else {
                    0
                };
                value |= (p as u64) << (8 * i);
            }
            value
        },
        // ITARGETSR: the SGIs' and PPIs' read as this core
        0x0800..=0x0BFB => {
            let irq = (offset - 0x800) as usize;
            let mut value = 0u64;
            for i in 0..size as usize {
                let n = irq + i;
                let t = if n < 32 {
                    1u8 << core
                }
                else if n < NUM_IRQ {
                    gic2().targets[n]
                }
                else {
                    0
                };
                value |= (t as u64) << (8 * i);
            }
            value
        },
        0x0C00..=0x0CFC => {
            let first = ((offset - 0xC00) / 4) as usize * 16;
            let mut value = 0u64;
            for i in 0..16 {
                let n = first + i;
                let edge = if n < 16 {
                    true
                }
                else if n < 32 {
                    r.edge >> n & 1 != 0
                }
                else {
                    n < NUM_IRQ && bit(&d.edge, n)
                };
                if edge {
                    value |= 2 << (2 * i);
                }
            }
            value
        },
        // CPENDSGIR, SPENDSGIR: a byte per SGI, a bit per source core
        0x0F10..=0x0F2F => {
            let sgi = ((offset & 0xF) as usize).min(15);
            let mut value = 0u64;
            for i in 0..size as usize {
                if sgi + i < 16 {
                    value |= (gic2().sgi_sources[core][sgi + i] as u64) << (8 * i);
                }
            }
            value
        },
        // PIDR2: ArchRev 2
        0x0FE8 => 0x2B,
        _ => 0,
    }
}

fn gicd2_write(offset: u64, size: u32, value: u64) {
    let core = crate::isa::current_core();
    let g = gic();
    let word = ((offset & 0x7F) / 4) as usize;
    let v = value as u32;
    // (word 0 of a bitmap: the current core's SGIs and PPIs)
    let bitmap = |g: &mut Gic, kind: usize, set: bool| {
        if word == 0 {
            let r = &mut g.redist[core];
            let own = match kind {
                0 => &mut r.enabled,
                1 => &mut r.pending,
                _ => &mut r.active,
            };
            if set {
                *own |= v;
            }
            else {
                *own &= !v;
            }
        }
        else if word < WORDS {
            let words = match kind {
                0 => &mut g.dist.enabled,
                1 => &mut g.dist.pending,
                _ => &mut g.dist.active,
            };
            bitmap_write(words, word, v, set);
        }
    };
    match offset {
        0x0000 => g.dist.ctlr = v & (CTLR_EN_GRP0 | CTLR_EN_GRP1),
        0x0080..=0x00FC => {
            if word == 0 {
                g.redist[core].group = v;
            }
            else if word < WORDS {
                g.dist.group[word] = v;
            }
        },
        0x0100..=0x017C => bitmap(g, 0, true),
        0x0180..=0x01FC => {
            bitmap(g, 0, false);
            g.redist[core].enabled |= 0xFFFF;
        },
        0x0200..=0x027C => bitmap(g, 1, true),
        0x0280..=0x02FC => {
            bitmap(g, 1, false);
            // (SGIs are cleared through CPENDSGIR, not here)
        },
        0x0300..=0x037C => bitmap(g, 2, true),
        0x0380..=0x03FC => bitmap(g, 2, false),
        0x0400..=0x07FB => {
            let irq = (offset - 0x400) as usize;
            for i in 0..size as usize {
                let n = irq + i;
                let p = (value >> (8 * i)) as u8;
                if n < 32 {
                    g.redist[core].priority[n] = p;
                }
                else if n < NUM_IRQ {
                    g.dist.priority[n] = p;
                }
            }
        },
        0x0800..=0x0BFB => {
            let irq = (offset - 0x800) as usize;
            for i in 0..size as usize {
                let n = irq + i;
                if (32..NUM_IRQ).contains(&n) {
                    gic2().targets[n] = (value >> (8 * i)) as u8;
                }
            }
        },
        0x0C00..=0x0CFC => {
            let first = ((offset - 0xC00) / 4) as usize * 16;
            for i in 0..16 {
                let n = first + i;
                let edge = v >> (2 * i + 1) & 1 != 0;
                if (16..32).contains(&n) {
                    let r = &mut g.redist[core];
                    r.edge = r.edge & !(1 << n) | (edge as u32) << n;
                }
                else if (32..NUM_IRQ).contains(&n) {
                    set_bit(&mut g.dist.edge, n, edge);
                }
            }
        },
        // SGIR: TargetListFilter (0 the list, 1 the others, 2 this core), the list, the INTID
        0x0F00 => {
            let sgi = (v & 15) as usize;
            let list = match v >> 24 & 3 {
                0 => v >> 16 & 0xFF,
                1 => 0xFF & !(1 << core),
                2 => 1 << core,
                _ => 0,
            };
            for other in 0..cores().min(8) {
                if list >> other & 1 != 0 {
                    gic2().sgi_sources[other][sgi] |= 1 << core;
                    g.redist[other].pending |= 1 << sgi;
                    update(other);
                }
            }
        },
        0x0F10..=0x0F2F => {
            let set = offset >= 0x0F20;
            let sgi = (offset & 0xF) as usize;
            for i in 0..size as usize {
                if sgi + i >= 16 {
                    break;
                }
                let bits = (value >> (8 * i)) as u8;
                let sources = &mut gic2().sgi_sources[core][sgi + i];
                if set {
                    *sources |= bits;
                }
                else {
                    *sources &= !bits;
                }
                let r = &mut g.redist[core];
                r.pending = r.pending & !(1 << (sgi + i)) | ((*sources != 0) as u32) << (sgi + i);
            }
        },
        _ => return,
    }
    update_all();
}

/// The GICv2 CPU interface (GICC): its registers are the ICC registers'
/// logic for both groups at once (no Security Extensions)
pub fn gicc_read(offset: u64, _size: u32) -> u64 {
    crate::aarch64::timer::tick();
    let _guard = Guard::new();
    let core = crate::isa::current_core();
    let c = gic().cpuif[core];
    match offset {
        0x0000 => {
            (c.igrpen[0] | c.igrpen[1] << 1) as u64
                | gic2().ctlr[core] as u64
                | if c.ctlr & ICC_CTLR_EOIMODE != 0 { GICC_CTLR_EOIMODE as u64 } else { 0 }
        },
        0x0004 => c.pmr as u64,
        0x0008 => c.bpr[0] as u64,
        0x001C => c.bpr[1] as u64,
        // IAR, AIAR: acknowledge the highest priority pending interrupt (an SGI with its source)
        0x000C | 0x0020 => {
            if !can_preempt(core) {
                return SPURIOUS;
            }
            let h = gic().hppi[core];
            let irq = h.irq as usize;
            activate(core, irq);
            if irq < 16 {
                irq as u64 | (gic2().active_source[core][irq] as u64) << 10
            }
            else {
                irq as u64
            }
        },
        0x0014 => running_priority(core) as u64,
        // (HPPIR: not an interrupt the priority mask holds back, as QEMU's)
        0x0018 | 0x0028 => {
            let h = gic().hppi[core];
            if no_enabled_hppi(core) || h.prio >= c.pmr {
                SPURIOUS
            }
            else {
                h.irq as u64
            }
        },
        0x00D0 => c.apr[0] as u64,
        0x00E0 => c.apr[1] as u64,
        // IIDR: GICv2, ARM
        0x00FC => 0x0202_043B,
        _ => 0,
    }
}

pub fn gicc_write(offset: u64, _size: u32, value: u64) {
    let _guard = Guard::new();
    let core = crate::isa::current_core();
    let g = gic();
    let v = value as u32;
    match offset {
        0x0000 => {
            let c = &mut g.cpuif[core];
            c.igrpen = [v & 1, v >> 1 & 1];
            let mut ctlr = c.ctlr & !(ICC_CTLR_CBPR | ICC_CTLR_EOIMODE);
            if v & GICC_CTLR_CBPR != 0 {
                ctlr |= ICC_CTLR_CBPR;
            }
            if v & GICC_CTLR_EOIMODE != 0 {
                ctlr |= ICC_CTLR_EOIMODE;
            }
            c.ctlr = ctlr;
            gic2().ctlr[core] = v & (1 << 2 | GICC_CTLR_FIQEN | GICC_CTLR_CBPR);
        },
        0x0004 => g.cpuif[core].pmr = v & PRIO_MASK,
        0x0008 => g.cpuif[core].bpr[0] = v & 7,
        0x001C => g.cpuif[core].bpr[1] = v.max(1) & 7,
        // EOIR, AEOIR: priority drop of the highest active priority, and deactivation unless EOImode
        0x0010 | 0x0024 => {
            let irq = (v & 0x3FF) as usize;
            if irq >= NUM_IRQ {
                return;
            }
            let Some(group) = highest_active_group(core)
            else {
                return;
            };
            let apr = &mut g.cpuif[core].apr[group];
            *apr &= apr.wrapping_sub(1);
            update(core);
            if g.cpuif[core].ctlr & ICC_CTLR_EOIMODE == 0 {
                deactivate(core, irq);
            }
        },
        0x00D0 => g.cpuif[core].apr[0] = v,
        0x00E0 => g.cpuif[core].apr[1] = v,
        // DIR
        0x1000 => {
            let irq = (v & 0x3FF) as usize;
            if irq < NUM_IRQ && g.cpuif[core].ctlr & ICC_CTLR_EOIMODE != 0 {
                deactivate(core, irq);
            }
        },
        _ => return,
    }
    update(core);
}
