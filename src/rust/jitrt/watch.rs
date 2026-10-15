//! The guest pages compiled code was made from (P5.3): each slot's pages,
//! how many slots depend on each page, a lock-free bit per page for the
//! writers that must notify (crate::jit::page_watched), and the listeners
//! that hear of writes and of a reset.
//!
//! A write: the Always listeners first (with cores in workers, the other
//! cores must hear of it whatever this instance compiled), then, for a page
//! this instance watches, the WatchedOnly listeners, which retire their code
//! from it and name the slots they keep (code a write of a few bytes misses);
//! every other slot made from the page stops watching all its pages. A
//! reset: the listeners, then nothing is watched. Listeners run in the order
//! they were registered. (The IR's orders, live, cache and scheduler around
//! the x64 page tier, went with the region tiers in M11.)

use super::host::env;
use crate::page::Page;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    /// every write
    Always,
    /// writes to pages this instance watches
    WatchedOnly,
}

/// A write to backing page `page` (all of it, or the bytes lo..hi): the
/// slots whose code stays (none for an Always listener)
pub type DirtyListener = fn(page: u32, bytes: Option<(u32, u32)>) -> Vec<u32>;
pub type ResetListener = fn();

pub struct Watch {
    slots: HashMap<u32, HashSet<Page>>,
    /// slots watching each page (TLB fills ask on every page walk; iterating
    /// the slots' sets was measurable)
    counts: Vec<u16>,
    dirty: Vec<(Trigger, DirtyListener)>,
    reset: Vec<ResetListener>,
}

/// Lock-free mirror of `counts != 0`, one bit per page
static mut WATCHED: Vec<u64> = Vec::new();
fn set_bit(page: usize, watched: bool) {
    unsafe {
        let bits = &mut *(&raw mut WATCHED);
        if bits.len() <= page / 64 {
            if !watched {
                return;
            }
            bits.resize(page / 64 + 1, 0);
        }
        if watched {
            bits[page / 64] |= 1 << (page % 64)
        }
        else {
            bits[page / 64] &= !(1 << (page % 64))
        }
    }
}
/// Whether this instance watches the page (no lock)
#[inline(always)]
pub fn bit(page: u32) -> bool {
    unsafe {
        (&*(&raw const WATCHED))
            .get(page as usize / 64)
            .is_some_and(|w| w >> (page % 64) & 1 != 0)
    }
}

impl Watch {
    pub fn new() -> Watch {
        Watch {
            slots: HashMap::new(),
            counts: Vec::new(),
            dirty: Vec::new(),
            reset: Vec::new(),
        }
    }
    pub fn on_dirty(&mut self, trigger: Trigger, listener: DirtyListener) {
        self.dirty.push((trigger, listener))
    }
    pub fn on_reset(&mut self, listener: ResetListener) { self.reset.push(listener) }

    pub fn watched(&self, page: Page) -> bool {
        self.counts
            .get(page.to_u32() as usize)
            .is_some_and(|count| *count != 0)
    }
    fn count(&mut self, page: Page, delta: i32) {
        let index = page.to_u32() as usize;
        if self.counts.len() <= index {
            self.counts.resize(index + 1, 0);
        }
        let before = self.counts[index] != 0;
        self.counts[index] = (self.counts[index] as i32 + delta).max(0) as u16;
        let after = self.counts[index] != 0;
        set_bit(index, after);
        if before != after {
            (env().claim)(index as u32, after);
        }
    }

    /// Slot `slot`'s code was made from `pages`
    pub fn attach(&mut self, slot: u32, pages: HashSet<Page>) {
        for &page in &pages {
            self.count(page, 1);
        }
        (env().pages_gain_code)(&pages);
        self.slots.insert(slot, pages);
    }
    /// Slot `slot` was released: its pages are no longer its
    pub fn detach(&mut self, slot: u32) {
        let Some(pages) = self.slots.remove(&slot)
        else {
            return;
        };
        for &page in &pages {
            self.count(page, -1);
        }
        for page in pages {
            let watched = self.watched(page);
            (env().page_has_code)(page, watched);
        }
    }

    /// A write to `page` (all of it, or the bytes lo..hi): every listener.
    /// False when this instance watches no code there.
    pub fn write(&mut self, page: Page, bytes: Option<(u32, u32)>) -> bool {
        for &(trigger, listener) in &self.dirty {
            if trigger == Trigger::Always {
                listener(page.to_u32(), bytes);
            }
        }
        self.retire(page, bytes)
    }
    /// A write to `page` that the Always listeners have heard of (another
    /// core's, reported back): the code this instance made from it retires.
    /// False when it watches no code there.
    pub fn retire(&mut self, page: Page, bytes: Option<(u32, u32)>) -> bool {
        if !self.watched(page) {
            return false;
        }
        let mut kept = Vec::new();
        for &(trigger, listener) in &self.dirty {
            if trigger == Trigger::WatchedOnly {
                kept.extend(listener(page.to_u32(), bytes));
            }
        }
        let mut unwatched = HashSet::new();
        let mut drained = Vec::new();
        for (&slot, pages) in self.slots.iter_mut() {
            if pages.contains(&page) && !kept.contains(&slot) {
                drained.extend(pages.drain());
            }
        }
        for p in drained {
            self.count(p, -1);
            unwatched.insert(p);
        }
        for page in unwatched {
            let watched = self.watched(page);
            (env().page_has_code)(page, watched);
        }
        true
    }

    /// Every client's code goes (crate::jit::jit_clear_cache_js): the
    /// listeners, then no page is watched
    pub fn reset(&mut self) {
        for listener in &self.reset {
            listener();
        }
        let mut pages = HashSet::new();
        for slot_pages in self.slots.values_mut() {
            pages.extend(slot_pages.drain());
        }
        self.counts.clear();
        unsafe { (*(&raw mut WATCHED)).clear() };
        (env().release_all)();
        for page in pages {
            (env().page_has_code)(page, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jitrt::host::{self, Env};
    use std::sync::Mutex;

    static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
    fn log(s: String) { LOG.lock().unwrap().push(s) }
    fn take() -> Vec<String> { std::mem::take(&mut *LOG.lock().unwrap()) }

    fn env() -> Env {
        Env {
            table_size: 16,
            table_offset: 0,
            state_base: 0,
            mem8: || std::ptr::null_mut(),
            now: || 0.0,
            core: || 0,
            clear_slot: |_| {},
            page_has_code: |page, has| log(format!("has {} {}", page.to_u32(), has)),
            pages_gain_code: |pages| log(format!("gain {}", pages.len())),
            claim: |page, on| log(format!("claim {} {}", page, on)),
            release_all: || log("release all".into()),
        }
    }

    // (one test: the listeners and the log are shared)
    #[test]
    fn listener_order_kept_slots_and_reset() {
        host::set(env());
        let mut w = Watch::new();
        w.on_dirty(Trigger::Always, |page, _| {
            log(format!("always {}", page));
            vec![]
        });
        // (the client keeps slot 2's code for a write of a few bytes)
        w.on_dirty(Trigger::WatchedOnly, |page, bytes| {
            log(format!("client {} {:?}", page, bytes));
            if bytes.is_some() {
                vec![2]
            }
            else {
                vec![]
            }
        });
        w.on_reset(|| log("reset client".into()));
        w.attach(
            1,
            [Page::page_of(0x5000), Page::page_of(0x6000)]
                .into_iter()
                .collect(),
        );
        w.attach(2, [Page::page_of(0x5000)].into_iter().collect());
        let mut attached = take();
        attached.sort();
        assert_eq!(
            attached,
            ["claim 5 true", "claim 6 true", "gain 1", "gain 2"]
        );
        assert!(bit(5) && bit(6) && !bit(7));

        // an unwatched page: only the Always listener
        w.write(Page::page_of(0x7000), None);
        assert_eq!(take(), ["always 7"]);
        assert!(!w.retire(Page::page_of(0x7000), None));

        // a few bytes of page 5: slot 2 kept, slot 1 stops watching 5 and 6
        w.write(Page::page_of(0x5000), Some((8, 12)));
        let mut log = take();
        let mut retired = log.split_off(2);
        assert_eq!(log, ["always 5", "client 5 Some((8, 12))"]);
        retired.sort();
        assert_eq!(retired, ["claim 6 false", "has 5 true", "has 6 false"]);
        assert!(bit(5) && !bit(6));

        // all of page 5, reported back by another core: no Always listener
        assert!(w.retire(Page::page_of(0x5000), None));
        assert_eq!(take(), ["client 5 None", "claim 5 false", "has 5 false"]);
        assert!(!bit(5));

        w.attach(3, [Page::page_of(0x9000)].into_iter().collect());
        take();
        w.reset();
        assert_eq!(take(), ["reset client", "release all", "has 9 false"]);
        assert!(!bit(9));
        w.detach(3);
        assert_eq!(take(), Vec::<String>::new());
    }
}
