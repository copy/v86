//! Chaining tables (docs/jit-unification-plan.md P5.8): a page function
//! leaving its page looks the new virtual page up in its core's table for
//! the code mode and privilege it runs in, and tail-calls the function
//! serving it without returning to the dispatch loop
//! (crate::pagegen::frame emits the lookup). Direct mapped by virtual page:
//! the tag is the page with the core's access cache epoch (access::TagLayout,
//! so every flush of the ISA's TLB retires the entries; invalidating a page
//! forgets its entry), and the Wasm table index of a published function
//! whose code page the virtual page executed from when the entry was
//! filled. Retiring a function clears its entries.
//!
//! The memory layout is what generated code reads: ENTRIES entries of
//! ENTRY_BYTES, the tag at 0 (u64), the table index at TABLE_INDEX_OFFSET.

use crate::jitrt::access::TagLayout;

pub const ENTRIES: usize = 1024;
pub const ENTRY_BYTES: u32 = 16;
pub const TABLE_INDEX_OFFSET: u32 = 8;

#[derive(Clone, Copy)]
#[repr(C)]
pub struct ChainEntry {
    pub tag: u64,
    pub table_index: u32,
    /// the code page's translation is global (kept by address space switches)
    pub global: u32,
}
const NO_CHAIN: ChainEntry = ChainEntry {
    tag: 0,
    table_index: 0,
    global: 0,
};

#[repr(C, align(16))]
pub struct ChainTable(pub [ChainEntry; ENTRIES]);
impl ChainTable {
    pub const EMPTY: ChainTable = ChainTable([NO_CHAIN; ENTRIES]);
    /// The address of the first entry (what generated code indexes)
    pub fn base(&self) -> u32 { std::ptr::addr_of!(self.0) as u32 }
    /// Virtual page `page` runs the function at `table_index`
    #[inline]
    pub fn fill(&mut self, page: u64, epoch_bits: u64, table_index: u32, global: bool) {
        self.0[page as usize & (ENTRIES - 1)] = ChainEntry {
            tag: page | epoch_bits,
            table_index,
            global: global as u32,
        };
    }
    /// Page `page`'s translation was invalidated
    pub fn forget_page(&mut self, layout: TagLayout, page: u64) {
        let entry = &mut self.0[page as usize & (ENTRIES - 1)];
        if layout.page(entry.tag) == page {
            entry.tag = 0;
        }
    }
    /// An address space switch: only global pages' entries stay
    pub fn forget_nonglobal(&mut self) {
        for entry in self.0.iter_mut() {
            if entry.global == 0 {
                entry.tag = 0;
            }
        }
    }
    pub fn clear(&mut self) {
        for entry in self.0.iter_mut() {
            entry.tag = 0;
        }
    }
    /// The function at `table_index` was retired
    pub fn unchain(&mut self, table_index: u32) {
        for entry in self.0.iter_mut() {
            if entry.table_index == table_index {
                entry.tag = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const LAYOUT: TagLayout = TagLayout {
        epoch_shift: 52,
        region_shift: 21,
    };

    #[test]
    fn layout_fill_and_forget() {
        assert_eq!(std::mem::size_of::<ChainEntry>() as u32, ENTRY_BYTES);
        assert_eq!(
            std::mem::offset_of!(ChainEntry, table_index) as u32,
            TABLE_INDEX_OFFSET
        );
        let mut t = Box::new(ChainTable::EMPTY);
        t.fill(0x12345, 1 << 52, 77, false);
        t.fill(0x12346, 1 << 52, 78, true);
        assert_eq!(t.0[0x345].tag, 0x12345 | 1 << 52);
        t.forget_nonglobal();
        assert_eq!(t.0[0x345].tag, 0);
        assert_ne!(t.0[0x346].tag, 0);
        t.forget_page(LAYOUT, 0x22346);
        assert_ne!(t.0[0x346].tag, 0);
        t.unchain(78);
        assert_eq!(t.0[0x346].tag, 0);
    }
}
