//! The AArch32 translation regime of cpu_type "arm32" (docs/aarch32-plan.md
//! R3), as QEMU 9.2 (target/arm/ptw.c: get_phys_addr_v6, get_phys_addr_lpae)
//! has it. TTBCR.EAE 0: VMSAv7's short descriptors (sections, supersections,
//! large and small pages; AP[2:0], or SCTLR.AFE's simplified model with
//! AP[0] the access flag; XN and PXN; TEX remap by PRRR and NMRR with
//! SCTLR.TRE; the ASID CONTEXTIDR's); TTBCR.EAE 1: LPAE's long descriptors
//! (mmu.rs's walk of the 4 KiB granule, a 32-bit input, 40-bit output).
//!
//! A short descriptor's domain is checked by the walk and again on every
//! use of its TLB entry (`with_domain`): the entry keeps the client
//! permissions and the domain (in `sh`), so a write of DACR (Linux's
//! uaccess windows) needs no flush. A small page's entry is at level 3
//! (not a block for tlb.rs), its faults' level the page's.

use crate::aarch64::cpu;
use crate::aarch64::mmu::{
    descriptor32, walk_tables, Leaf, FSC_ACCESS_FLAG, FSC_EXTERNAL_WALK, FSC_TRANSLATION,
};
use crate::aarch64::state::{a32_dacr, a32_ttbcr, contextidr_el1, mair_el1, ttbr0_el1, ttbr1_el1};
use crate::aarch64::tlb::{
    Entry, DEVICE, EL0_EXEC, EL0_READ, EL0_WRITE, EL1_EXEC, EL1_READ, EL1_WRITE, GLOBAL,
};

const TTBCR_EAE: u32 = 1 << 31;
const TTBCR_PD0: u32 = 1 << 4;
const TTBCR_PD1: u32 = 1 << 5;
const SCTLR_TRE: u64 = 1 << 28;
const SCTLR_AFE: u64 = 1 << 29;

/// The domain faults (AArch64's DFSC encodings of them): section, page
pub const FSC_DOMAIN_SECTION: u32 = 0x3D;
pub const FSC_DOMAIN_PAGE: u32 = 0x3E;

/// An entry's `sh` with a domain: bit 3, the domain in bits 7:4
const SH_DOMAIN: u8 = 1 << 3;

/// A short-descriptor fault's domain (DFSR and IFSR bits 7:4, as QEMU reports
/// every fault's): bits 23:20 of its fault status code
pub const FSC_DOMAIN_SHIFT: u32 = 20;

const ALL: u16 = EL1_READ | EL1_WRITE | EL1_EXEC | EL0_READ | EL0_WRITE | EL0_EXEC;

/// Whether TTBCR selects the long descriptors (LPAE)
#[inline(always)]
pub fn long_descriptors() -> bool { (unsafe { *a32_ttbcr }) & TTBCR_EAE != 0 }

/// The current ASID: CONTEXTIDR's (short descriptors), or TTBR0's or
/// TTBR1's (TTBCR.A1) bits 55:48
#[inline(always)]
pub fn asid() -> u16 {
    unsafe {
        if *a32_ttbcr & TTBCR_EAE == 0 {
            *contextidr_el1 as u16 & 0xFF
        }
        else {
            let ttbr = if *a32_ttbcr >> 22 & 1 != 0 { *ttbr1_el1 } else { *ttbr0_el1 };
            (ttbr >> 48) as u16 & 0xFF
        }
    }
}

/// The walk of `va` (its 32 bits)
pub(crate) fn walk(va: u64) -> Result<Leaf, u32> {
    if long_descriptors() {
        walk_long(va as u32)
    }
    else {
        walk_short(va as u32)
    }
}

/// An entry as DACR has its domain now: a domain fault (no access), every
/// permission (manager), or the entry's (client)
#[inline(always)]
pub fn with_domain(entry: Entry) -> Result<Entry, u32> {
    if entry.sh & SH_DOMAIN == 0 {
        return Ok(entry);
    }
    let domain = entry.sh >> 4;
    match unsafe { *a32_dacr } >> (2 * domain as u32) & 3 {
        1 => Ok(entry),
        3 => Ok(Entry {
            flags: entry.flags | ALL,
            ..entry
        }),
        _ => Err(
            if entry.level == 1 { FSC_DOMAIN_SECTION } else { FSC_DOMAIN_PAGE }
                | (domain as u32) << FSC_DOMAIN_SHIFT,
        ),
    }
}

/// The domain bits of a permission fault on `entry` (none with the long descriptors)
#[inline(always)]
pub fn fault_domain(entry: &Entry) -> u32 {
    if entry.sh & SH_DOMAIN != 0 {
        ((entry.sh >> 4) as u32) << FSC_DOMAIN_SHIFT
    }
    else {
        0
    }
}

// ---- LPAE

fn walk_long(va: u32) -> Result<Leaf, u32> {
    let ttbcr = unsafe { *a32_ttbcr };
    let (t0sz, t1sz) = (ttbcr & 7, ttbcr >> 16 & 7);
    // (aa32_va_parameters: TTBR1 when T1SZ is 0 above TTBR0's region, else from its own)
    let select = if t1sz == 0 { va > u32::MAX >> t0sz } else { va >= !(u32::MAX >> t1sz) };
    let (tsz, epd, ttbr) = unsafe {
        if select {
            (t1sz, ttbcr >> 23 & 1, *ttbr1_el1)
        }
        else {
            (t0sz, ttbcr >> 7 & 1, *ttbr0_el1)
        }
    };
    let inputsize = 32 - tsz;
    if inputsize < 32 {
        // (the gap between the regions)
        let top = va >> inputsize;
        let all = u32::MAX >> inputsize;
        if top != if select { all } else { 0 } {
            return Err(FSC_TRANSLATION + 1);
        }
    }
    if epd != 0 {
        return Err(FSC_TRANSLATION + 1);
    }
    walk_tables(va as u64, inputsize, 12, 40, ttbr, true)
}

// ---- short descriptors

/// AP[2:0]'s read and write permissions (PL1, PL0) without the access flag model
fn full_permissions(ap: u32) -> (u16, u16) {
    const RW: u16 = 3;
    const R: u16 = 1;
    match ap {
        1 => (RW, 0),
        2 => (RW, R),
        3 => (RW, RW),
        5 => (R, 0),
        6 | 7 => (R, R),
        _ => (0, 0),
    }
}

/// AP[2:1]'s (SCTLR.AFE)
fn simple_permissions(ap: u32) -> (u16, u16) {
    match ap {
        0 => (3, 0),
        1 => (3, 3),
        2 => (1, 0),
        _ => (1, 1),
    }
}

/// A MAIR-like attribute byte of a cacheability (NMRR's encoding: 0 Non-cacheable,
/// 1 write-back write-allocate, 2 write-through, 3 write-back)
fn cacheability(c: u32) -> u8 { [0x4, 0xF, 0xA, 0xE][c as usize & 3] }

fn walk_short(va: u32) -> Result<Leaf, u32> {
    let ttbcr = unsafe { *a32_ttbcr };
    let n = ttbcr & 7;
    let table = unsafe {
        if n != 0 && va >> (32 - n) != 0 {
            if ttbcr & TTBCR_PD1 != 0 {
                return Err(FSC_TRANSLATION + 1);
            }
            *ttbr1_el1 as u32 & 0xFFFF_C000
        }
        else {
            if ttbcr & TTBCR_PD0 != 0 {
                return Err(FSC_TRANSLATION + 1);
            }
            *ttbr0_el1 as u32 & !(0x3FFF >> n)
        }
    };
    let l1 = descriptor32((table | va >> 18 & 0x3FFC) as u64).ok_or(FSC_EXTERNAL_WALK + 1)?;
    let kind = l1 & 3;
    // (the faults' domain: the level 1 descriptor's bits 8:5, as QEMU has it)
    let in_domain = (l1 >> 5 & 15) << FSC_DOMAIN_SHIFT;
    if kind == 0 {
        return Err(FSC_TRANSLATION + 1 | in_domain);
    }
    let supersection = kind != 1 && l1 & 1 << 18 != 0;
    // (supersections are in domain 0)
    let domain = if supersection { 0 } else { l1 >> 5 & 15 };
    let domain_prot = unsafe { *a32_dacr } >> (2 * domain) & 3;
    let page = kind == 1;
    if domain_prot == 0 || domain_prot == 2 {
        return Err(if page { FSC_DOMAIN_PAGE } else { FSC_DOMAIN_SECTION } | in_domain);
    }
    let (pa, size_log, ap, xn, pxn, tex, cb, s, ng);
    if !page {
        if supersection {
            pa = (l1 & 0xFF00_0000 | va & 0x00FF_FFFF) as u64
                | ((l1 >> 20 & 15) as u64) << 32
                | ((l1 >> 5 & 15) as u64) << 36;
            size_log = 24;
        }
        else {
            pa = (l1 & 0xFFF0_0000 | va & 0x000F_FFFF) as u64;
            size_log = 20;
        }
        ap = l1 >> 10 & 3 | l1 >> 13 & 4;
        xn = l1 >> 4 & 1 != 0;
        pxn = l1 & 1 != 0;
        tex = l1 >> 12 & 7;
        cb = l1 >> 2 & 3;
        s = l1 >> 16 & 1;
        ng = l1 >> 17 & 1;
    }
    else {
        pxn = l1 >> 2 & 1 != 0;
        let l2 = descriptor32((l1 & 0xFFFF_FC00 | va >> 10 & 0x3FC) as u64)
            .ok_or(FSC_EXTERNAL_WALK + 2 | in_domain)?;
        ap = l2 >> 4 & 3 | l2 >> 7 & 4;
        match l2 & 3 {
            0 => return Err(FSC_TRANSLATION + 2 | in_domain),
            1 => {
                pa = (l2 & 0xFFFF_0000 | va & 0xFFFF) as u64;
                size_log = 16;
                xn = l2 >> 15 & 1 != 0;
                tex = l2 >> 12 & 7;
            },
            _ => {
                pa = (l2 & 0xFFFF_F000 | va & 0xFFF) as u64;
                size_log = 12;
                xn = l2 & 1 != 0;
                tex = l2 >> 6 & 7;
            },
        }
        cb = l2 >> 2 & 3;
        s = l2 >> 10 & 1;
        ng = l2 >> 11 & 1;
    }
    let level = if page { 2 } else { 1 };
    let sctlr = cpu::sctlr();
    // the client permissions (a manager's are every one: with_domain)
    let afe = sctlr & SCTLR_AFE != 0;
    let (pl1, pl0) = if afe {
        if ap & 1 == 0 {
            if domain_prot != 3 {
                return Err(FSC_ACCESS_FLAG + level | in_domain);
            }
            (0, 0)
        }
        else {
            simple_permissions(ap >> 1)
        }
    }
    else {
        full_permissions(ap)
    };
    let mut flags = 0;
    if pl1 & 1 != 0 {
        flags |= EL1_READ;
        if !xn && !pxn {
            flags |= EL1_EXEC;
        }
    }
    if pl1 & 2 != 0 {
        flags |= EL1_WRITE;
    }
    if pl0 & 1 != 0 {
        flags |= EL0_READ;
        if !xn {
            flags |= EL0_EXEC;
        }
    }
    if pl0 & 2 != 0 {
        flags |= EL0_WRITE;
    }
    if ng == 0 {
        flags |= GLOBAL;
    }
    // the memory type: PRRR's and NMRR's with TEX remap (TEX[0]:C:B), else TEX:C:B's
    let (device, attr) = if sctlr & SCTLR_TRE != 0 {
        let index = (tex & 1) << 2 | cb;
        let (prrr, nmrr) = unsafe { (*mair_el1 as u32, (*mair_el1 >> 32) as u32) };
        let tr = prrr >> (2 * index) & 3;
        let inner = cacheability(nmrr >> (2 * index));
        let outer = cacheability(nmrr >> (2 * index + 16));
        (tr < 2, if tr < 2 { 0 } else { outer << 4 | inner })
    }
    else if tex & 4 != 0 {
        (false, cacheability(tex & 3) << 4 | cacheability(cb))
    }
    else {
        match (tex, cb) {
            (0, 0 | 1) | (2, 0) => (true, 0),
            (0, 2) => (false, 0xAA),
            (0, 3) => (false, 0xEE),
            (1, 3) => (false, 0xFF),
            _ => (false, 0x44),
        }
    };
    if device {
        flags |= DEVICE;
    }
    Ok(Leaf {
        pa,
        // (a small or large page is a page for tlb.rs, a section a block)
        level: if page { 3 } else { 1 },
        size_log,
        flags,
        attr,
        sh: if s != 0 { 3 } else { 0 } | SH_DOMAIN | (domain as u8) << 4,
    })
}
