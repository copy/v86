//! The TLB of the AArch64 core (docs/arm64-virt-android16-plan.md P3.5):
//! per core, direct-mapped by the 4 KiB page of the VA (a leaf of a larger
//! granule or a block is cached per 4 KiB page it covers), tagged with the
//! ASID unless global. An entry holds the permissions of both EL0 and EL1,
//! so it serves either. Intermediate table entries are not cached. TLBI by
//! VA covers every entry derived from the same leaf: the 4 KiB pages of the
//! 64 KiB-aligned range holding the VA (any granule's page), and a block's
//! pages through the list of blocks cached since the last full flush (a hit
//! there flushes everything).

use crate::isa::MAX_CORES;

pub const TLB_BITS: u32 = 10;
pub const TLB_SIZE: usize = 1 << TLB_BITS;

// entry flags
pub const EL1_READ: u16 = 1 << 0;
pub const EL1_WRITE: u16 = 1 << 1;
pub const EL1_EXEC: u16 = 1 << 2;
pub const EL0_READ: u16 = 1 << 3;
pub const EL0_WRITE: u16 = 1 << 4;
pub const EL0_EXEC: u16 = 1 << 5;
pub const GLOBAL: u16 = 1 << 6;
pub const DEVICE: u16 = 1 << 7;

#[derive(Clone, Copy)]
pub struct Entry {
    /// the VA's 4 KiB page (TBI applied) + 1; 0: empty
    pub tag: u64,
    /// the physical address of that 4 KiB page
    pub pa: u64,
    pub asid: u16,
    pub flags: u16,
    /// the leaf's level and log2 of its size
    pub level: u8,
    pub size_log: u8,
    /// MAIR attribute and shareability (AT, PAR_EL1)
    pub attr: u8,
    pub sh: u8,
}

impl Entry {
    pub const EMPTY: Entry = Entry {
        tag: 0,
        pa: 0,
        asid: 0,
        flags: 0,
        level: 0,
        size_log: 0,
        attr: 0,
        sh: 0,
    };
}

/// A cached block (a leaf larger than a page): its VA (TBI applied), size and ASID
#[derive(Clone, Copy)]
struct Block {
    va: u64,
    size_log: u8,
    asid: u16,
    global: bool,
}

const BLOCKS: usize = 32;

struct Tlb {
    entries: [Entry; TLB_SIZE],
    blocks: [Block; BLOCKS],
    block_count: usize,
    /// a block was dropped from the full list: TLBI by VA flushes everything
    blocks_overflowed: bool,
}

static mut TLBS: [Tlb; MAX_CORES] = [const {
    Tlb {
        entries: [Entry::EMPTY; TLB_SIZE],
        blocks: [Block {
            va: 0,
            size_log: 0,
            asid: 0,
            global: false,
        }; BLOCKS],
        block_count: 0,
        blocks_overflowed: false,
    }
}; MAX_CORES];

/// Changes with every invalidation on any core (the fetch fast path checks it)
pub static mut GENERATION: u32 = 1;

#[inline(always)]
fn tlb(core: usize) -> &'static mut Tlb { unsafe { &mut (*(&raw mut TLBS))[core] } }

#[inline(always)]
pub fn index(page: u64) -> usize { (page as usize ^ (page >> TLB_BITS) as usize) & (TLB_SIZE - 1) }

/// The entry of `page` (VA >> 12, TBI applied) for `asid`, if cached
#[inline(always)]
pub fn lookup(page: u64, asid: u16) -> Option<Entry> {
    let entry = tlb(crate::isa::current_core()).entries[index(page)];
    if entry.tag == page + 1 && (entry.flags & GLOBAL != 0 || entry.asid == asid) {
        Some(entry)
    }
    else {
        None
    }
}

pub fn insert(page: u64, entry: Entry) {
    let t = tlb(crate::isa::current_core());
    t.entries[index(page)] = Entry {
        tag: page + 1,
        ..entry
    };
    if entry.level < 3 {
        // (a block: TLBI by VA must find its other pages)
        let block = Block {
            va: page << 12 & !((1u64 << entry.size_log) - 1),
            size_log: entry.size_log,
            asid: entry.asid,
            global: entry.flags & GLOBAL != 0,
        };
        let known = t.blocks[..t.block_count].iter().any(|b| {
            b.va == block.va
                && b.size_log == block.size_log
                && b.asid == block.asid
                && b.global == block.global
        });
        if !known {
            if t.block_count < BLOCKS {
                t.blocks[t.block_count] = block;
                t.block_count += 1;
            }
            else {
                t.blocks_overflowed = true;
            }
        }
    }
}

fn bump() { unsafe { GENERATION = GENERATION.wrapping_add(1).max(1) } }
/// (another core runs now: the fetch fast path's translation is another TLB's)
pub fn bump_generation() { bump() }

fn flush_core(core: usize) {
    let t = tlb(core);
    t.entries.fill(Entry::EMPTY);
    t.block_count = 0;
    t.blocks_overflowed = false;
    // (what the page tier derived from the TLB goes with it: P6.4)
    crate::aarch64::jit::pages::tlb_flushed(core);
}

/// The cores a TLBI acts on: this one, or all (the inner shareable domain)
fn cores(shareable: bool) -> core::ops::Range<usize> {
    if shareable {
        0..crate::isa::core_count()
    }
    else {
        let core = crate::isa::current_core();
        core..core + 1
    }
}

/// Everything (TLBI VMALLE1, and any change of the regime's controls)
pub fn flush(shareable: bool) {
    for core in cores(shareable) {
        flush_core(core);
    }
    bump();
}

/// The non-global entries of `asid` (TLBI ASIDE1)
pub fn flush_asid(shareable: bool, asid: u16) {
    for core in cores(shareable) {
        let t = tlb(core);
        for entry in t.entries.iter_mut() {
            if entry.flags & GLOBAL == 0 && entry.asid == asid {
                *entry = Entry::EMPTY;
            }
        }
        crate::aarch64::jit::pages::tlb_flushed_asid(core, asid);
    }
    bump();
}

/// The entries of `page` (VA >> 12, TBI applied) for `asid`, or for every
/// ASID (`asid` None: TLBI VAAE1, VAALE1)
pub fn flush_page(shareable: bool, page: u64, asid: Option<u16>) {
    let matches = |global: bool, entry_asid: u16| global || asid.map_or(true, |a| a == entry_asid);
    for core in cores(shareable) {
        let t = tlb(core);
        let va = page << 12;
        let in_block = t.blocks_overflowed
            || t.blocks[..t.block_count]
                .iter()
                .any(|b| va & !((1u64 << b.size_log) - 1) == b.va && matches(b.global, b.asid));
        if in_block {
            flush_core(core);
            continue;
        }
        // (the 4 KiB pages of the largest page, 64 KiB, holding `va`)
        let first = page & !15;
        for p in first..first + 16 {
            let entry = &mut t.entries[index(p)];
            if entry.tag == p + 1 && matches(entry.flags & GLOBAL != 0, entry.asid) {
                *entry = Entry::EMPTY;
            }
            crate::aarch64::jit::pages::tlb_flushed_page(core, p, asid);
        }
    }
    bump();
}
