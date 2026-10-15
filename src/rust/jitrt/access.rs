//! The access cache of compiled code (docs/jit-unification-plan.md P5.8):
//! per core, per privilege (user: x86 CPL 3, A64 EL0) and per access kind,
//! a direct-mapped table of virtual 4 KiB pages whose current translation is
//! plain guest RAM (and, for writes, holds no compiled code). Page functions
//! look entries up inline or through their module's lookup function
//! (crate::pagegen::frame); a miss goes to the ISA's runtime, which fills
//! the entry from a successful translation.
//!
//! An entry is only ever derived from a translation the ISA made, so a hit
//! is as valid as that translation: every invalidation of the ISA's TLB
//! retires the core's entries, an epoch step (TagLayout: the epoch is part of
//! each entry's tag). Entries that came from a large translation (an x86
//! large page, an A64 block) mark their region: invalidating one page there
//! flushes the core. Entries of global translations survive an address
//! space switch (flush_nonglobal).
//!
//! The memory layout is what generated code reads: four tables of
//! `entries` 16-byte entries (tag: u64, host: u32, delta: u32), read
//! supervisor, read user, write supervisor, write user, in room for
//! MAX_ENTRIES each. The ISA keeps the caches (one per core) and how a
//! physical page reaches the host, through Bus.

/// Room per table; the ISA chooses `entries`, a power of two up to it
pub const MAX_ENTRIES: usize = 4096;
pub const ENTRY_BYTES: u32 = 16;
/// The tables: read supervisor, read user, write supervisor, write user
pub const TABLES: usize = 4;
const LARGE_WORDS: usize = 16;

/// How tags are made: the virtual page number below `epoch_shift`, the
/// core's epoch (never 0) from there; large translations mark regions of
/// 2^`region_shift` bytes
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TagLayout {
    pub epoch_shift: u32,
    pub region_shift: u32,
}
impl TagLayout {
    /// The epochs a tag holds: past them, the tables are emptied
    pub const fn epoch_limit(self) -> u64 { 1 << (64 - self.epoch_shift) }
    pub const fn tag(self, page: u64, epoch: u64) -> u64 { page | epoch << self.epoch_shift }
    /// The page number of a tag
    pub const fn page(self, tag: u64) -> u64 { tag & !(!0 << self.epoch_shift) }
}

#[derive(Clone, Copy)]
#[repr(C)]
pub struct Entry {
    pub tag: u64,
    pub host: u32,
    /// host minus the low 32 bits of the page's virtual address: what an
    /// address's low 32 bits add to (inline lookups that keep translations,
    /// x86's P4.21)
    pub delta: u32,
}
pub const EMPTY: Entry = Entry {
    tag: 0,
    host: 0,
    delta: 0,
};

/// One core's cache
#[repr(C, align(16))]
pub struct AccessCache {
    /// TABLES tables of `entries` each (slot)
    pub tables: [Entry; TABLES * MAX_ENTRIES],
    /// The epoch, which is never 0 (so zeroed entries never match), less
    /// one: a zeroed cache is the initial state, and a static of caches
    /// takes no room in the module's data
    epoch_less_one: u64,
    /// Regions (hashed to LARGE_WORDS * 64 bits) with entries from a large
    /// translation since the last flush
    large: [u64; LARGE_WORDS],
    /// Per entry of `tables`: from a global translation
    global: [u64; TABLES * MAX_ENTRIES / 64],
}

/// The physical memory behind the cache (the ISA's bus, P5.8's extension
/// point: x86's physical bus, the virt board's AddressSpace)
pub trait Bus {
    /// The RAM backing offset of the physical page holding `physical`, if
    /// page functions may access it directly (plain RAM, no device)
    fn ram_backing(&self, physical: u64) -> Option<u32>;
}

impl AccessCache {
    pub const NEW: AccessCache = AccessCache {
        tables: [EMPTY; TABLES * MAX_ENTRIES],
        epoch_less_one: 0,
        large: [0; LARGE_WORDS],
        global: [0; TABLES * MAX_ENTRIES / 64],
    };
    #[inline(always)]
    pub fn epoch(&self) -> u64 { self.epoch_less_one + 1 }
    /// Tag bits of entries in the current epoch
    #[inline(always)]
    pub fn epoch_bits(&self, layout: TagLayout) -> u64 { self.epoch() << layout.epoch_shift }
    /// The entry of page `page` in table `kind` (0-3)
    #[inline(always)]
    pub fn slot(entries: usize, kind: usize, page: u64) -> usize {
        kind * entries + (page as usize & (entries - 1))
    }
    /// The address of table `kind`'s first entry
    pub fn base(&self, entries: usize, kind: usize) -> u32 {
        std::ptr::addr_of!(self.tables[kind * entries]) as u32
    }
    fn region_bit(layout: TagLayout, address: u64) -> (usize, u64) {
        let region = (address >> layout.region_shift) as usize & (LARGE_WORDS * 64 - 1);
        (region / 64, 1 << (region % 64))
    }
    /// Every entry retired by a new epoch: true when the epochs wrapped (the
    /// tables were emptied; anything else tagged with the epoch must go too)
    pub fn flush(&mut self, layout: TagLayout) -> bool {
        self.epoch_less_one += 1;
        self.large = [0; LARGE_WORDS];
        if self.epoch() == layout.epoch_limit() {
            self.tables.fill(EMPTY);
            self.epoch_less_one = 0;
            return true;
        }
        false
    }
    /// Empty the tables (a new number of entries)
    pub fn clear(&mut self) { self.tables.fill(EMPTY) }
    /// An ISA that keeps several epochs live (A64 with a64_asid_tag: one per
    /// ASID) makes `epoch` the current one; it numbers them itself, never
    /// reusing one before the tables were emptied (and never 0). (The x86
    /// core has no use for it.)
    #[allow(dead_code)]
    pub fn set_epoch(&mut self, epoch: u64) { self.epoch_less_one = epoch - 1 }
    /// An address space switch: only the entries of global translations stay
    pub fn flush_nonglobal(&mut self, entries: usize) {
        for (i, entry) in self.tables[..TABLES * entries].iter_mut().enumerate() {
            if self.global[i / 64] >> (i % 64) & 1 == 0 {
                entry.tag = 0;
            }
        }
    }
    /// One page's translations were invalidated: its entries go, or every
    /// entry when the page is in a region with large translations. Whether
    /// that flushed the cache (and its epochs wrapped: Some(true))
    pub fn invalidate_page(
        &mut self,
        layout: TagLayout,
        entries: usize,
        address: u64,
    ) -> Option<bool> {
        let (word, bit) = Self::region_bit(layout, address);
        if self.large[word] & bit != 0 {
            return Some(self.flush(layout));
        }
        let page = address >> 12;
        let tag = layout.tag(page, self.epoch());
        for kind in 0..TABLES {
            let entry = &mut self.tables[Self::slot(entries, kind, page)];
            if entry.tag == tag {
                entry.tag = 0;
            }
        }
        None
    }
    /// The write entries `retire` picks go (a page gained compiled code)
    #[inline]
    pub fn retire_writes(&mut self, entries: usize, retire: impl Fn(&Entry) -> bool) {
        for entry in self.tables[2 * entries..4 * entries].iter_mut() {
            if entry.tag != 0 && retire(entry) {
                entry.tag = 0;
            }
        }
    }
    /// Record that the virtual page of `address` translates to host address
    /// `host` (page aligned) for this access kind and privilege; `large`:
    /// part of a large translation; `global`: kept by address space
    /// switches. Whether it replaced a live entry of another page (a
    /// conflict, for the ISA's statistics)
    #[inline]
    pub fn fill(
        &mut self,
        layout: TagLayout,
        entries: usize,
        user: bool,
        write: bool,
        address: u64,
        host: u32,
        large: bool,
        global: bool,
    ) -> bool {
        let page = address >> 12;
        if large {
            let (word, bit) = Self::region_bit(layout, address);
            self.large[word] |= bit;
        }
        let index = Self::slot(entries, write as usize * 2 + user as usize, page);
        let epoch = self.epoch();
        let entry = &mut self.tables[index];
        let tag = layout.tag(page, epoch);
        let conflict = entry.tag >> layout.epoch_shift == epoch && entry.tag != tag;
        *entry = Entry {
            tag,
            host,
            delta: host.wrapping_sub((page << 12) as u32),
        };
        let (word, bit) = (index / 64, 1u64 << (index % 64));
        if global {
            self.global[word] |= bit;
        }
        else {
            self.global[word] &= !bit;
        }
        conflict
    }
    /// (tests) the entry of table `kind` for `page`
    #[cfg(test)]
    pub fn entry(&self, entries: usize, kind: usize, page: u64) -> Entry {
        self.tables[Self::slot(entries, kind, page)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const LAYOUT: TagLayout = TagLayout {
        epoch_shift: 52,
        region_shift: 21,
    };
    static mut CACHE: AccessCache = AccessCache::NEW;

    #[test]
    fn epochs_large_regions_and_globals() {
        let c = unsafe { &mut *(&raw mut CACHE) };
        let address = 0xFFFF_8000_1234_5678u64;
        let page = address >> 12;
        assert!(!c.fill(LAYOUT, 1024, true, true, address, 0x5000, false, true));
        assert_eq!(c.entry(1024, 3, page).tag, LAYOUT.tag(page, c.epoch()));
        assert_eq!(
            c.entry(1024, 3, page).delta,
            0x5000u32.wrapping_sub((page << 12) as u32)
        );
        // a global entry survives an address space switch, a page's invalidation does not
        c.flush_nonglobal(1024);
        assert_ne!(c.entry(1024, 3, page).tag, 0);
        assert_eq!(c.invalidate_page(LAYOUT, 1024, address), None);
        assert_eq!(c.entry(1024, 3, page).tag, 0);
        // an entry of a large translation: invalidating any page of its region flushes
        c.fill(LAYOUT, 1024, false, false, address, 0x6000, true, false);
        let before = c.epoch();
        assert_eq!(
            c.invalidate_page(LAYOUT, 1024, address & !0x1F_FFFF | 0x1000),
            Some(false)
        );
        assert_eq!(c.epoch(), before + 1);
        assert_ne!(c.entry(1024, 0, page).tag, LAYOUT.tag(page, c.epoch()));
        // epochs wrap to an emptied cache, never to 0
        let mut wrapped = false;
        for _ in 0..LAYOUT.epoch_limit() {
            wrapped |= c.flush(LAYOUT);
        }
        assert!(wrapped);
        assert_ne!(c.epoch(), 0);
        assert_eq!(LAYOUT.page(c.entry(1024, 0, page).tag), 0);
    }

    static mut KEPT: AccessCache = AccessCache::NEW;
    #[test]
    fn epochs_kept_side_by_side() {
        // (A64's a64_asid_tag: an epoch per ASID, switched to and back)
        let c = unsafe { &mut *(&raw mut KEPT) };
        let address = 0x0000_7FFF_0000_1000u64;
        let page = address >> 12;
        c.set_epoch(5);
        c.fill(LAYOUT, 1024, true, false, address, 0x5000, false, false);
        c.set_epoch(9);
        assert_ne!(c.entry(1024, 1, page).tag, LAYOUT.tag(page, c.epoch()));
        c.fill(
            LAYOUT,
            1024,
            true,
            false,
            address + 0x1000,
            0x6000,
            false,
            false,
        );
        c.set_epoch(5);
        assert_eq!(c.epoch(), 5);
        assert_eq!(c.entry(1024, 1, page).tag, LAYOUT.tag(page, 5));
    }
}
