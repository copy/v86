//! The stage 1 MMU of the AArch64 core (docs/arm64-virt-android16-plan.md
//! P3.3-P3.5): VMSAv8-64 translation of the EL1&0 regime with the 4 KiB
//! granule (16 and 64 KiB too with profiles v1.1 and v2, the default), TBI, ASIDs, the TLB
//! (tlb.rs), AT and TLBI. Where the Arm ARM leaves a choice this follows
//! QEMU 9.2 (target/arm/ptw.c), the reference: a TnSZ out of range is a
//! level 0 translation fault; a granule the profile does not have is the
//! 4 KiB one; faults come in the order translation, address size, access
//! flag (the walk), then the alignment of Device memory, then permission.
//! Hardware access-flag and dirty-state updates are not in v1.

use crate::aarch64::cpu::{self, SCTLR_M};
use crate::aarch64::state::{mair_el1, par_el1, sctlr_el1, tcr_el1, ttbr0_el1, ttbr1_el1};
use crate::aarch64::tlb::{
    self, Entry, DEVICE, EL0_EXEC, EL0_READ, EL0_WRITE, EL1_EXEC, EL1_READ, EL1_WRITE, GLOBAL,
};

/// What an access does
pub use crate::aarch64::memory::Access;

// fault status codes (DFSC/IFSC), plus the level
pub(crate) const FSC_ADDRESS_SIZE: u32 = 0x00;
pub(crate) const FSC_TRANSLATION: u32 = 0x04;
pub(crate) const FSC_ACCESS_FLAG: u32 = 0x08;
pub(crate) const FSC_PERMISSION: u32 = 0x0C;
pub(crate) const FSC_EXTERNAL_WALK: u32 = 0x14;

/// The granules the profile has: bit 0 4 KiB, 1 16 KiB, 2 64 KiB (v1: 4 KiB only)
static mut GRANULES: u32 = 1;

/// (profiles v1.1 and v2, the default: 16 and 64 KiB granules too, P3.4)
#[no_mangle]
pub fn a64_set_granules(mask: u32) {
    unsafe { *crate::parallel::machine(&raw mut GRANULES) = mask & 7 | 1 };
    tlb::flush(true);
}

/// The profile's granules (a64_set_granules): bit 0 4 KiB, 1 16 KiB, 2 64 KiB
#[no_mangle]
pub fn a64_granules() -> u32 { unsafe { *crate::parallel::machine(&raw mut GRANULES) } }

/// ID_AA64MMFR0_EL1's TGran16 and TGran64 fields for the profile
pub fn mmfr0_granules() -> u64 {
    let g = unsafe { *crate::parallel::machine(&raw mut GRANULES) };
    let tgran16 = if g & 2 != 0 { 1 } else { 0 };
    let tgran64 = if g & 4 != 0 { 0 } else { 0xF };
    tgran16 << 20 | tgran64 << 24
}

/// log2 of the granule TCR_EL1 selects for the half of the VA space bit 55 picks
fn granule_of(select: u64) -> u32 {
    let tcr = unsafe { *tcr_el1 };
    // (TG0: 00 4K, 01 64K, 10 16K; TG1: 01 16K, 10 4K, 11 64K)
    let log = if select == 0 {
        match tcr >> 14 & 3 {
            1 => 16,
            2 => 14,
            _ => 12,
        }
    }
    else {
        match tcr >> 30 & 3 {
            1 => 14,
            3 => 16,
            _ => 12,
        }
    };
    let supported = unsafe { *crate::parallel::machine(&raw mut GRANULES) }
        & match log {
            12 => 1,
            14 => 2,
            _ => 4,
        }
        != 0;
    if supported {
        log
    }
    else {
        12
    }
}

/// The current ASID: TTBR1_EL1's if TCR_EL1.A1, else TTBR0_EL1's (8 bits
/// unless TCR_EL1.AS; AArch32's regime: crate::aarch64::mmu_a32::asid)
#[inline(always)]
pub fn current_asid() -> u16 {
    if cpu::a32_only() {
        return crate::aarch64::mmu_a32::asid();
    }
    unsafe {
        let tcr = *tcr_el1;
        let ttbr = if tcr >> 22 & 1 != 0 { *ttbr1_el1 } else { *ttbr0_el1 };
        let asid = (ttbr >> 48) as u16;
        if tcr >> 36 & 1 != 0 {
            asid
        }
        else {
            asid & 0xFF
        }
    }
}

/// The VA with TBI applied (bits 63:56 a copy of bit 55 when TBI is on for its half)
#[inline(always)]
fn untagged(va: u64) -> u64 {
    let tcr = unsafe { *tcr_el1 };
    let tbi = if va >> 55 & 1 == 0 { tcr >> 37 & 1 } else { tcr >> 38 & 1 };
    if tbi != 0 {
        ((va << 8) as i64 >> 8) as u64
    }
    else {
        va
    }
}

/// A successful walk: the leaf for one VA
pub(crate) struct Leaf {
    /// the physical address of the VA
    pub pa: u64,
    pub level: u32,
    pub size_log: u32,
    pub flags: u16,
    pub attr: u8,
    pub sh: u8,
}

/// Read a translation table descriptor (RAM only: anything else is an external abort on the walk)
pub(crate) fn descriptor(pa: u64) -> Option<u64> {
    match crate::aarch64::bus::bus().lookup(pa) {
        crate::aarch64::bus::Lookup::Ram { backing, .. } => Some(unsafe {
            crate::parallel::load64(crate::aarch64::bus::MEM8.add(backing as usize))
        }),
        crate::aarch64::bus::Lookup::Extended { .. } => {
            Some(unsafe { crate::aarch64::extended::read(pa, 8) })
        },
        _ => None,
    }
}

#[inline(always)]
fn mask(bits: u32) -> u64 {
    if bits >= 64 {
        u64::MAX
    }
    else {
        (1u64 << bits) - 1
    }
}

/// A 32-bit descriptor (AArch32's short descriptors)
pub(crate) fn descriptor32(pa: u64) -> Option<u32> {
    match crate::aarch64::bus::bus().lookup(pa) {
        crate::aarch64::bus::Lookup::Ram { backing, .. } => Some(unsafe {
            crate::parallel::load32(crate::aarch64::bus::MEM8.add(backing as usize))
        }),
        crate::aarch64::bus::Lookup::Extended { .. } => {
            Some(unsafe { crate::aarch64::extended::read(pa, 4) } as u32)
        },
        _ => None,
    }
}

/// The translation table walk of `va` (AArch64.TranslationTableWalk for the
/// EL1&0 regime; AArch32's with cpu::a32_only): the leaf, or the fault status code
fn walk(va: u64) -> Result<Leaf, u32> {
    if cpu::a32_only() {
        return crate::aarch64::mmu_a32::walk(va);
    }
    let tcr = unsafe { *tcr_el1 };
    let select = va >> 55 & 1;
    let (tsz, epd) =
        if select == 0 { (tcr & 63, tcr >> 7 & 1) } else { (tcr >> 16 & 63, tcr >> 23 & 1) };
    if !(16..=39).contains(&tsz) {
        return Err(FSC_TRANSLATION);
    }
    let tbi = tcr >> (37 + select) & 1;
    let addrsize = 64 - 8 * tbi as u32;
    let inputsize = 64 - tsz as u32;
    if inputsize < addrsize {
        // (the bits above the region must all be `select`: the gap faults)
        let top = ((va >> inputsize) << (64 - (addrsize - inputsize))) as i64
            >> (64 - (addrsize - inputsize));
        if top.wrapping_neg() as u64 != select {
            return Err(FSC_TRANSLATION);
        }
    }
    if epd != 0 {
        return Err(FSC_TRANSLATION);
    }
    let granule = granule_of(select);
    // (the output size: TCR_EL1.IPS bounded by PARange, 40 bits)
    let ps = (tcr >> 32 & 7).min(2);
    let outputsize = [32, 36, 40][ps as usize];
    let ttbr = unsafe {
        if select == 0 {
            *ttbr0_el1
        }
        else {
            *ttbr1_el1
        }
    };
    walk_tables(va, inputsize, granule, outputsize, ttbr, false)
}

/// The walk from the table `ttbr` of a VA of `inputsize` bits, its region
/// chosen (the long descriptors: AArch64's and, `aarch32`, LPAE's, whose
/// execution needs read permission at its level, and PL1's no permission
/// to write at PL0 unless SCTLR.UWXN)
pub(crate) fn walk_tables(
    va: u64,
    inputsize: u32,
    granule: u32,
    outputsize: u32,
    ttbr: u64,
    aarch32: bool,
) -> Result<Leaf, u32> {
    let stride = granule - 3;
    let mut level = 4 - (inputsize - 4) / stride;
    let mut descaddr = ttbr & mask(48);
    if descaddr >> outputsize != 0 {
        return Err(FSC_ADDRESS_SIZE);
    }
    let indexmask_grainsize = mask(stride + 3);
    let mut indexmask = mask(inputsize - stride * (4 - level));
    descaddr &= !indexmask;
    let descaddrmask = mask(48) & !indexmask_grainsize;
    let mut tableattrs = 0u64;
    loop {
        descaddr |= (va >> (stride * (4 - level))) & indexmask;
        descaddr &= !7;
        let d = match descriptor(descaddr) {
            Some(d) => d,
            None => return Err(FSC_EXTERNAL_WALK + level),
        };
        // (a block is valid at level 1 or 2 with 4 KiB, level 2 with 16 or 64 KiB)
        let block_valid = level == 2 || level == 1 && granule == 12;
        if d & 1 == 0 || d & 2 == 0 && !block_valid {
            return Err(FSC_TRANSLATION + level);
        }
        let next = d & descaddrmask;
        if next >> outputsize != 0 {
            return Err(FSC_ADDRESS_SIZE + level);
        }
        if d & 2 != 0 && level < 3 {
            tableattrs |= d >> 59 & 31;
            level += 1;
            indexmask = indexmask_grainsize;
            descaddr = next;
            continue;
        }
        let size_log = stride * (4 - level) + 3;
        let pa = next & !mask(size_log) | va & mask(size_log);
        if d >> 10 & 1 == 0 {
            return Err(FSC_ACCESS_FLAG + level);
        }
        // AP[2:1] with APTable (APTable[0]: no EL0 access, APTable[1]: read-only)
        let mut ap = d >> 6 & 3;
        if tableattrs >> 2 & 1 != 0 {
            ap &= !1;
        }
        if tableattrs >> 3 & 1 != 0 {
            ap |= 2;
        }
        let uxn = d >> 54 & 1 != 0 || tableattrs >> 1 & 1 != 0;
        let pxn = d >> 53 & 1 != 0 || tableattrs & 1 != 0;
        let el1_write = ap & 2 == 0;
        let el0_read = ap & 1 != 0;
        let el0_write = ap == 1;
        let wxn = unsafe { *sctlr_el1 } >> 19 & 1 != 0;
        let mut flags = EL1_READ;
        if el1_write {
            flags |= EL1_WRITE;
        }
        if el0_read {
            flags |= EL0_READ;
        }
        if el0_write {
            flags |= EL0_WRITE;
        }
        if aarch32 {
            // (VMSAv8-32: XN for both, PXN; WXN; UWXN, SCTLR bit 20)
            let uwxn = unsafe { *sctlr_el1 } >> 20 & 1 != 0;
            if el0_read && !uxn && !(wxn && el0_write) {
                flags |= EL0_EXEC;
            }
            if !uxn && !pxn && !(wxn && el1_write) && !(uwxn && el0_write) {
                flags |= EL1_EXEC;
            }
        }
        else {
            if !uxn && !(wxn && el0_write) {
                flags |= EL0_EXEC;
            }
            if !(pxn || el0_write) && !(wxn && el1_write) {
                flags |= EL1_EXEC;
            }
        }
        if d >> 11 & 1 == 0 {
            flags |= GLOBAL;
        }
        let attr = (unsafe { *mair_el1 } >> (8 * (d >> 2 & 7))) as u8;
        if attr & 0xF0 == 0 {
            flags |= DEVICE;
        }
        return Ok(Leaf {
            pa,
            level,
            size_log,
            flags,
            attr,
            sh: (d >> 8 & 3) as u8,
        });
    }
}

/// A translation: the physical address, and whether it is Device memory
pub struct Translation {
    pub pa: u64,
    pub device: bool,
}

/// The TLB entry of `va` (walked and cached on a miss), or the walk's fault status code
#[inline(always)]
fn entry_of(va: u64) -> Result<Entry, u32> {
    let page = untagged(va) >> 12;
    let asid = current_asid();
    if let Some(entry) = tlb::lookup(page, asid) {
        if cpu::a32_only() {
            return crate::aarch64::mmu_a32::with_domain(entry);
        }
        return Ok(entry);
    }
    let leaf = walk(va)?;
    let entry = Entry {
        tag: 0,
        pa: leaf.pa & !0xFFF,
        asid,
        flags: leaf.flags,
        level: leaf.level as u8,
        size_log: leaf.size_log as u8,
        attr: leaf.attr,
        sh: leaf.sh,
    };
    tlb::insert(page, entry);
    if cpu::a32_only() {
        return crate::aarch64::mmu_a32::with_domain(entry);
    }
    Ok(entry)
}

/// Translate `va` (the MMU is on) for an access at EL0 (`el0`: also an
/// unprivileged access at EL1) or EL1 needing `align` bytes of alignment on
/// Device memory: the physical address, or the fault status code
#[inline]
pub fn translate(va: u64, access: Access, el0: bool, align: u32) -> Result<Translation, u32> {
    let entry = entry_of(va)?;
    let device = entry.flags & DEVICE != 0;
    if device && access != Access::Fetch && va & (align as u64 - 1) != 0 {
        return Err(cpu::FSC_ALIGNMENT);
    }
    let needed = match (access, el0) {
        (Access::Read, false) => EL1_READ,
        (Access::Write, false) => EL1_WRITE,
        (Access::Fetch, false) => EL1_EXEC,
        (Access::Read, true) => EL0_READ,
        (Access::Write, true) => EL0_WRITE,
        (Access::Fetch, true) => EL0_EXEC,
    };
    if entry.flags & needed == 0 {
        if cpu::a32_only() {
            return Err(
                FSC_PERMISSION + entry.level as u32 | crate::aarch64::mmu_a32::fault_domain(&entry)
            );
        }
        return Err(FSC_PERMISSION + entry.level as u32);
    }
    // (PAN: an EL1 data access to memory EL0 may access, AP[1] set; not
    // the unprivileged ones, `el0`, nor instruction fetches)
    if !el0
        && access != Access::Fetch
        && entry.flags & EL0_READ != 0
        && cpu::get_pstate() & cpu::PSTATE_PAN != 0
    {
        return Err(FSC_PERMISSION + entry.level as u32);
    }
    Ok(Translation {
        pa: entry.pa | va & 0xFFF,
        device,
    })
}

/// (the page tier's access cache, crate::aarch64::jit::pages) The
/// translation of `va` for a data access at EL0 (`el0`) or EL1 with the MMU
/// on, if the access cache may keep it: Normal memory the access is allowed
/// to: the physical address, whether it came from a block (invalidating a
/// page of it must flush), whether it is global
pub fn translate_for_cache(va: u64, write: bool, el0: bool) -> Option<(u64, bool, bool)> {
    let entry = entry_of(va).ok()?;
    let needed = match (write, el0) {
        (false, false) => EL1_READ,
        (true, false) => EL1_WRITE,
        (false, true) => EL0_READ,
        (true, true) => EL0_WRITE,
    };
    if entry.flags & DEVICE != 0 || entry.flags & needed == 0 {
        return None;
    }
    // (with FEAT_PAN, EL1's entries are never of memory EL0 may access:
    // PSTATE.PAN changes without the cache knowing)
    if !el0 && entry.flags & EL0_READ != 0 && cpu::has_pan() {
        return None;
    }
    Some((
        entry.pa | va & 0xFFF,
        entry.size_log > 12,
        entry.flags & GLOBAL != 0,
    ))
}

/// SCTLR_EL1, TCR_EL1 or MAIR_EL1 changed: what the TLB derived from them is stale
pub fn regime_changed() { tlb::flush(false); }

/// TTBR0_EL1 and TTBR1_EL1 writes, and those that changed their core's
/// current ASID (P9.3: what SW_TTBR0_PAN costs, two of each per entry from
/// EL0 and per uaccess window); each core's last ASID
static mut TTBR_WRITES: u64 = 0;
static mut ASID_CHANGES: u64 = 0;
static mut LAST_ASID: [u16; crate::aarch64::isa_hooks::MAX_CORES] =
    [0; crate::aarch64::isa_hooks::MAX_CORES];

/// TTBR0_EL1 or TTBR1_EL1 changed: entries are tagged with their ASID, so
/// nothing is flushed (software changing a table under an ASID must TLBI)
pub fn ttbr_changed() {
    unsafe {
        tlb::GENERATION = tlb::GENERATION.wrapping_add(1).max(1);
        TTBR_WRITES += 1;
        let asid = current_asid();
        let core = crate::isa::current_core() as usize % crate::aarch64::isa_hooks::MAX_CORES;
        if LAST_ASID[core] != asid {
            LAST_ASID[core] = asid;
            ASID_CHANGES += 1;
        }
    }
    // (without a64_asid_tag, the page tier's access cache is not tagged with
    // the ASID: its non-global entries go; with it, the next activation
    // takes the running ASID's epoch, P6.4)
    if !unsafe { crate::aarch64::jit::ASID_TAG } {
        crate::aarch64::jit::pages::tlb_flushed_nonglobal(crate::isa::current_core());
    }
}

/// The ASID changes so far (crate::aarch64::jit::pages::asid_tag_tick)
pub fn asid_changes() -> u64 { unsafe { ASID_CHANGES } }

/// The TTBR writes (0) and ASID changes (1) since the module started (tests)
#[no_mangle]
pub fn a64_mmu_stat(n: u32) -> f64 {
    unsafe {
        match n {
            0 => TTBR_WRITES as f64,
            1 => ASID_CHANGES as f64,
            _ => 0.0,
        }
    }
}

/// A data or instruction cache maintenance by VA: no effect, and no fault
/// (as QEMU, which implements them as NOPs)
pub fn check_cache_maintenance(_va: u64) -> Result<(), crate::aarch64::cpu::Exception> { Ok(()) }

/// AT S1E1R (0), S1E1W (1), S1E0R (2), S1E0W (3): PAR_EL1. An external abort
/// on the walk is taken as a data abort (CM 1, WnR 1) instead.
pub fn address_translate(op2: u32, va: u64) -> Result<(), crate::aarch64::cpu::Exception> {
    let access = if op2 & 1 != 0 { Access::Write } else { Access::Read };
    let el0 = op2 & 2 != 0;
    let par = if cpu::sctlr() & SCTLR_M == 0 {
        // (the MMU off: the VA is the PA, Device-nGnRnE, outer shareable)
        match mmu_off(va) {
            None => 1 | (FSC_ADDRESS_SIZE as u64) << 1,
            Some(pa) => pa & !0xFFF | 1 << 9 | 2 << 7,
        }
    }
    else {
        match walk(va) {
            Ok(leaf) => {
                let needed = match (access, el0) {
                    (Access::Read, false) => EL1_READ,
                    (Access::Write, false) => EL1_WRITE,
                    (Access::Read, true) => EL0_READ,
                    _ => EL0_WRITE,
                };
                if leaf.flags & needed == 0 {
                    1 | ((FSC_PERMISSION + leaf.level) as u64) << 1
                }
                else {
                    let sh = if leaf.attr & 0xF0 == 0 || leaf.attr == 0x44 || leaf.attr == 0x40 {
                        2
                    }
                    else {
                        leaf.sh as u64
                    };
                    leaf.pa & mask(48) & !0xFFF | (leaf.attr as u64) << 56 | 1 << 9 | sh << 7
                }
            },
            Err(fsc) if fsc & 0x3C == FSC_EXTERNAL_WALK => {
                return Err(crate::aarch64::cpu::Exception::DataAbort {
                    iss: fsc | 1 << 6 | 1 << 8,
                    far: va,
                });
            },
            Err(fsc) => 1 | (fsc as u64) << 1,
        }
    };
    unsafe { *par_el1 = par | 1 << 11 };
    Ok(())
}

/// TLBI (op1 0, CRn 8): `shareable` the IS forms (CRm 3), op2 the operation, `value` Xt
pub fn tlbi(shareable: bool, op2: u32, value: u64) {
    let asid = (value >> 48) as u16;
    let asid = if unsafe { *tcr_el1 } >> 36 & 1 != 0 { asid } else { asid & 0xFF };
    // (VA[55:12] in Xt[43:0], the upper bits a copy of bit 55)
    let page = (((value << 20) as i64) >> 20) as u64 & mask(52);
    match op2 {
        0 => tlb::flush(shareable),
        2 => tlb::flush_asid(shareable, asid),
        1 | 5 => tlb::flush_page(shareable, page, Some(asid)),
        _ => tlb::flush_page(shareable, page, None),
    }
}

/// AArch64.BranchAddr: a branch target with TBI (TCR_EL1.TBI0/TBI1 for the
/// half bit 55 selects): bits 63:56 become copies of bit 55
#[inline(always)]
pub fn branch_address(target: u64) -> u64 {
    let tcr = unsafe { *tcr_el1 };
    let tbi = if target >> 55 & 1 == 0 { tcr >> 37 & 1 } else { tcr >> 38 & 1 };
    if tbi == 0 {
        target
    }
    else {
        ((target << 8) as i64 >> 8) as u64
    }
}

/// The physical address of `va` with the MMU off: the VA itself (TBI still
/// applies), or None for one beyond the 40-bit physical address space (a
/// level 0 address size fault)
#[inline(always)]
pub fn mmu_off(va: u64) -> Option<u64> {
    let tcr = unsafe { *tcr_el1 };
    let tbi = if va >> 55 & 1 == 0 { tcr >> 37 & 1 } else { tcr >> 38 & 1 };
    let pa = if tbi != 0 { va & mask(56) } else { va };
    if pa >> 40 != 0 {
        None
    }
    else {
        Some(pa)
    }
}

/// The physical address `va` translates to now for a read at the current
/// EL, if it does (the exclusive monitor's address)
pub fn physical_address_of(va: u64) -> Option<u64> {
    if cpu::sctlr() & SCTLR_M == 0 {
        mmu_off(va)
    }
    else {
        translate(va, Access::Read, cpu::el() == 0, 1)
            .ok()
            .map(|t| t.pa)
    }
}
