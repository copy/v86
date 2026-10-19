//! The TLB of the AArch64 core (docs/arm64-virt-android16-plan.md P3.5):
//! per core, direct-mapped by the 4 KiB page of the VA (a leaf of a larger
//! granule or a block is cached per 4 KiB page it covers), tagged with the
//! ASID unless global. An entry holds the permissions of both EL0 and EL1,
//! so it serves either. Intermediate table entries are not cached. TLBI by
//! VA covers every entry derived from the same leaf: the 4 KiB pages of the
//! 64 KiB-aligned range holding the VA (any granule's page), and a block's
//! pages through the list of blocks cached since the last full flush (a hit
//! there flushes everything).
//!
//! With cores in workers (P8.3) an inner shareable TLBI (and IC IVAU) acts
//! on this core at once and goes to the other cores through the machine's
//! ring (`post`); each core takes the ring at its safe points (`poll`) and
//! acknowledges, and the posting core's DSB completes only when every other
//! core has acknowledged or is idle (`synced`: an idle core polls before it
//! runs again).

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

/// The cores a TLBI acts on here: this one, or all (the inner shareable
/// domain); with cores in workers the others take it from the ring
fn cores(shareable: bool) -> core::ops::Range<usize> {
    if shareable && !crate::parallel::active() {
        0..crate::isa::core_count()
    }
    else {
        let core = crate::isa::current_core();
        core..core + 1
    }
}

// ---- the other cores' maintenance (cores in workers, P8.3)

/// What an entry of the ring does: all entries, one ASID's, a page's (an
/// ASID's or every ASID's), or nothing but a poll of the code invalidations (IC IVAU)
const RING_ALL: u64 = 1;
const RING_ASID: u64 = 2;
const RING_PAGE: u64 = 3;
const RING_PAGE_ALL_ASIDS: u64 = 4;
const RING_CODE: u64 = 5;
const RING: usize = 1024;

// the machine's (crate::parallel::machine)
static mut RING_NEXT: u32 = 0;
/// Each entry: [seq << 32 | kind << 16 | asid, page]
static mut RING_ENTRIES: [[u64; 2]; RING] = [[0; 2]; RING];
static mut RING_ACKED: [u32; MAX_CORES] = [0; MAX_CORES];
// this instance's
static mut RING_SEEN: u32 = 0;
/// The last entry this core posted that its next DSB waits for (0: none)
static mut PENDING: u32 = 0;
/// Where PENDING is (the page tier's DSB template steps a DSB only when it is not 0)
pub fn pending_address() -> u32 { &raw const PENDING as u32 }
/// (diagnostics, this instance's) 0 entries posted, 1 DSBs that waited, 2
/// entries taken from the ring, 3 rings overflowed
static mut RING_STATS: [u32; 4] = [0; 4];
#[no_mangle]
pub fn a64_tlb_ring_stat(field: u32) -> u32 {
    unsafe {
        (*(&raw const RING_STATS))
            .get(field as usize)
            .copied()
            .unwrap_or(0)
    }
}
/// Entries posted since this core's last completed DSB (a batch): IC posts
/// once a batch, and after BATCH_PAGES pages one full flush stands for the rest
static mut BATCH: u32 = 0;
static mut BATCH_CODE: bool = false;
static mut BATCH_ALL: bool = false;
const BATCH_PAGES: u32 = 32;
/// The pending entry each core was last kicked for (synced kicks a core once a batch)
static mut KICKED_FOR: [u32; MAX_CORES] = [0; MAX_CORES];

/// Post maintenance for the other cores (with cores in workers); they take
/// it when the posting core's DSB kicks them, or at their next safe point
fn post(kind: u64, page: u64, asid: u16) {
    if !crate::parallel::active() || crate::isa::core_count() == 1 {
        return;
    }
    unsafe {
        // (a batch: one IC entry; many pages: one full flush)
        let kind = match kind {
            RING_CODE if BATCH_CODE => return,
            RING_PAGE | RING_PAGE_ALL_ASIDS | RING_ASID if BATCH_ALL => return,
            RING_PAGE | RING_PAGE_ALL_ASIDS if BATCH >= BATCH_PAGES => RING_ALL,
            _ => kind,
        };
        BATCH += 1;
        BATCH_CODE |= kind == RING_CODE;
        BATCH_ALL |= kind == RING_ALL;
        let next = crate::parallel::machine(&raw mut RING_NEXT);
        let seq = crate::parallel::fetch_add32(next, 1).wrapping_add(1);
        let entry = crate::parallel::machine(&raw mut RING_ENTRIES)
            .cast::<[u64; 2]>()
            .add(seq as usize % RING);
        crate::parallel::store64((&raw mut (*entry)[1]).cast(), page);
        crate::parallel::store64(
            (&raw mut (*entry)[0]).cast(),
            (seq as u64) << 32 | kind << 16 | asid as u64,
        );
        PENDING = seq;
        RING_STATS[0] += 1;
    }
}

/// IC IVAU (and IC IALLUIS) with cores in workers: the next DSB waits until
/// every other core has taken the code invalidations (crate::parallel::code)
pub fn post_code() { post(RING_CODE, 0, 0) }

/// Take the other cores' maintenance (at a safe point: no compiled code
/// runs) and acknowledge it
pub fn poll() {
    if !crate::parallel::active() {
        return;
    }
    unsafe {
        let next = crate::parallel::word_load(crate::parallel::machine(&raw mut RING_NEXT));
        let first = RING_SEEN;
        if next == first {
            return;
        }
        let me = crate::isa::current_core();
        let count = next.wrapping_sub(first);
        let ring = crate::parallel::machine(&raw mut RING_ENTRIES).cast::<[u64; 2]>();
        let mut overflow = count as usize > RING;
        if !overflow {
            for i in 1..=count {
                let seq = first.wrapping_add(i);
                let entry = ring.add(seq as usize % RING);
                let meta = loop {
                    let meta = crate::parallel::load64((&raw const (*entry)[0]).cast());
                    let tag = (meta >> 32) as u32;
                    if tag == seq {
                        break Some(meta);
                    }
                    if (tag.wrapping_sub(seq) as i32) > 0 {
                        break None; // overwritten by a later round
                    }
                    // (the poster reserved the slot and fills it next)
                    std::hint::spin_loop();
                };
                let Some(meta) = meta
                else {
                    overflow = true;
                    break;
                };
                let page = crate::parallel::load64((&raw const (*entry)[1]).cast());
                // (one's own entries were done when they were posted)
                let asid = meta as u16;
                match meta >> 16 & 0xFFFF {
                    RING_ALL => flush_local(),
                    RING_ASID => flush_asid_local(asid),
                    RING_PAGE => flush_page_local(page, Some(asid)),
                    RING_PAGE_ALL_ASIDS => flush_page_local(page, None),
                    _ => {},
                }
            }
        }
        if overflow {
            flush_local();
            RING_STATS[3] += 1;
        }
        RING_STATS[2] = RING_STATS[2].wrapping_add(count);
        RING_SEEN = next;
        crate::parallel::word_store(
            crate::parallel::machine(&raw mut RING_ACKED)
                .cast::<u32>()
                .add(me),
            next,
        );
        bump();
    }
}

/// Whether the maintenance this core posted is done on every other core
/// (the DSB that waits for it may complete); kicks the cores it waits for
pub fn synced() -> bool {
    unsafe {
        let pending = PENDING;
        if pending == 0 || !crate::parallel::active() {
            return true;
        }
        let me = crate::isa::current_core();
        let acked = crate::parallel::machine(&raw mut RING_ACKED).cast::<u32>();
        let mut done = true;
        for core in 0..crate::isa::core_count() {
            if core == me || crate::parallel::code::is_idle(core) {
                continue;
            }
            if (crate::parallel::word_load(acked.add(core)).wrapping_sub(pending) as i32) < 0 {
                done = false;
                if KICKED_FOR[core] != pending {
                    KICKED_FOR[core] = pending;
                    crate::parallel::kick(core);
                }
            }
        }
        if done {
            PENDING = 0;
            BATCH = 0;
            BATCH_CODE = false;
            BATCH_ALL = false;
        }
        else {
            RING_STATS[1] += 1;
        }
        done
    }
}

/// (a stop, a reset) this core has taken the ring as it is now: nothing is pending
pub fn ring_synced_now() {
    unsafe {
        RING_SEEN = crate::parallel::word_load(crate::parallel::machine(&raw mut RING_NEXT));
        PENDING = 0;
        BATCH = 0;
        BATCH_CODE = false;
        BATCH_ALL = false;
        crate::parallel::word_store(
            crate::parallel::machine(&raw mut RING_ACKED)
                .cast::<u32>()
                .add(crate::isa::current_core()),
            RING_SEEN,
        );
    }
}

/// Everything (TLBI VMALLE1, and any change of the regime's controls)
pub fn flush(shareable: bool) {
    for core in cores(shareable) {
        flush_core(core);
    }
    bump();
    if shareable {
        post(RING_ALL, 0, 0);
    }
}
fn flush_local() { flush(false) }

/// The non-global entries of `asid` (TLBI ASIDE1)
pub fn flush_asid(shareable: bool, asid: u16) {
    flush_asid_cores(cores(shareable), asid);
    if shareable {
        post(RING_ASID, 0, asid);
    }
}
fn flush_asid_local(asid: u16) { flush_asid(false, asid) }
fn flush_asid_cores(cores: core::ops::Range<usize>, asid: u16) {
    for core in cores {
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
    flush_page_cores(cores(shareable), page, asid);
    if shareable {
        match asid {
            Some(asid) => post(RING_PAGE, page, asid),
            None => post(RING_PAGE_ALL_ASIDS, page, 0),
        }
    }
}
fn flush_page_local(page: u64, asid: Option<u16>) { flush_page(false, page, asid) }
fn flush_page_cores(cores: core::ops::Range<usize>, page: u64, asid: Option<u16>) {
    let matches = |global: bool, entry_asid: u16| global || asid.map_or(true, |a| a == entry_asid);
    for core in cores {
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
