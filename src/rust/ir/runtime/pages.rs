//! Page-granular heat for automatic compilation, the legacy JIT's unit of work.
//! Interpreted visits heat the linear code page they start in and record their
//! exact entry; a hot page is compiled once with every observed entry. Later
//! misses on the same page (new entries) accumulate fresh heat and recompile it
//! with the enlarged entry set. This table only selects work: admission
//! authority stays in the cache's exact-key publication records.
use super::entry::CpuEntryKey;
use std::collections::{BTreeMap, VecDeque};

/// Primary plus aliases; the page lifter accepts CfgLimits::PAGE.entries.
const MAX_ENTRIES: usize = 63;
const CAPACITY: usize = 2048;
/// Compilations of one page per code version; misses beyond this bound stay
/// interpreted instead of recompiling a page whose entries keep changing.
const MAX_ATTEMPTS: u8 = 8;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub(super) struct PageKey {
    pub base: u32,
    pub cs_base: u32,
    pub default_32: bool,
}
impl PageKey {
    pub fn of(entry: CpuEntryKey) -> Self {
        Self {
            base: entry.linear.0 & !4095,
            cs_base: entry.cs_base(),
            default_32: entry.default_32,
        }
    }
}
struct Page {
    key: PageKey,
    visits: u32,
    entries: Vec<(CpuEntryKey, u32)>,
    /// Entries a published page function already serves (no new heat needed).
    served: Vec<CpuEntryKey>,
    /// Requested entries the page function could not serve; they keep the
    /// region compiler as their fallback instead of reheating the page.
    declined: Vec<CpuEntryKey>,
    attempts: u8,
    /// Code-page writes since the page was first compiled. Pages that mix
    /// code with frequently written data need exponentially more heat before
    /// each recompilation (the removed legacy JIT restarted its large page threshold).
    invalidations: u8,
    failed: bool,
    queued: bool,
    physical: Option<u32>,
    stamp: u64,
}
pub(super) struct Pages {
    pages: Vec<Page>,
    index: BTreeMap<PageKey, usize>,
    /// Index of the page slot() found last (checked against its key).
    last: usize,
    ready: VecDeque<PageKey>,
    clock: u64,
    pub compiles: u32,
    pub failures: u32,
    pub first: u32,
    pub again: u32,
    pub dirty_resets: u32,
    pub declined_entries: u32,
}
impl Pages {
    pub const fn new() -> Self {
        Self {
            pages: Vec::new(),
            index: BTreeMap::new(),
            last: usize::MAX,
            ready: VecDeque::new(),
            clock: 0,
            compiles: 0,
            failures: 0,
            first: 0,
            again: 0,
            dirty_resets: 0,
            declined_entries: 0,
        }
    }
    pub fn clear(&mut self) {
        self.pages.clear();
        self.index.clear();
        self.ready.clear();
    }
    fn slot(&mut self, key: PageKey) -> usize {
        // Consecutive visits mostly stay on one page.
        if let Some(page) = self.pages.get(self.last) {
            if page.key == key {
                return self.last;
            }
        }
        let i = self.slot_uncached(key);
        self.last = i;
        i
    }
    fn slot_uncached(&mut self, key: PageKey) -> usize {
        if let Some(&i) = self.index.get(&key) {
            return i;
        }
        let page = Page {
            key,
            visits: 0,
            entries: Vec::new(),
            served: Vec::new(),
            declined: Vec::new(),
            attempts: 0,
            invalidations: 0,
            failed: false,
            queued: false,
            physical: None,
            stamp: self.clock,
        };
        if self.pages.len() < CAPACITY {
            self.pages.push(page);
            self.index.insert(key, self.pages.len() - 1);
            return self.pages.len() - 1;
        }
        // Replace the least recently visited page that is not queued.
        let victim = self
            .pages
            .iter()
            .enumerate()
            .filter(|(_, p)| !p.queued)
            .min_by_key(|(_, p)| p.stamp)
            .map(|(i, _)| i)
            .unwrap_or(0);
        let old = std::mem::replace(&mut self.pages[victim], page);
        self.index.remove(&old.key);
        self.ready.retain(|k| *k != old.key);
        self.index.insert(key, victim);
        victim
    }
    /// One interpreted visit starting at `entry`. Returns whether the page may
    /// still use region compilation (its page compilation failed).
    pub fn visit(&mut self, entry: CpuEntryKey, threshold: u32) -> bool {
        self.clock += 1;
        let i = self.slot(PageKey::of(entry));
        let clock = self.clock;
        let page = &mut self.pages[i];
        page.stamp = clock;
        if page.failed || page.declined.contains(&entry) {
            return true;
        }
        if page.served.contains(&entry) {
            // A published entry reached through interpretation (admission
            // declined it once): heat does not justify a recompilation.
            return false;
        }
        match page.entries.iter_mut().find(|(e, _)| *e == entry) {
            Some((_, hits)) => *hits = hits.saturating_add(1),
            None => {
                if page.entries.len() == MAX_ENTRIES {
                    // Keep the hottest entries; a new one replaces the coldest.
                    let (at, _) = page
                        .entries
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, (_, hits))| *hits)
                        .unwrap();
                    if page.entries[at].1 > 1 {
                        page.entries[at].1 -= 1;
                        page.visits = page.visits.saturating_add(1);
                        return false;
                    }
                    page.entries[at] = (entry, 1);
                }
                else {
                    page.entries.push((entry, 1));
                }
            },
        }
        page.visits = page.visits.saturating_add(1);
        // Each recompilation of the same code version doubles the heat its new
        // entries must earn; each code-page write quadruples it.
        let shift = page.attempts.min(6) as u32 + 2 * page.invalidations.min(8) as u32;
        let needed = threshold.saturating_mul(1 << shift);
        if page.visits >= needed && !page.queued && page.attempts < MAX_ATTEMPTS {
            page.queued = true;
            let key = page.key;
            self.ready.push_back(key);
        }
        false
    }
    /// Whether pages wait in the ready queue (take_ready may still drop some)
    pub fn has_ready(&self) -> bool { !self.ready.is_empty() }
    /// Next page whose heat justifies a (re)compilation, with its entries in
    /// descending heat order (the first is the primary entry).
    pub fn take_ready(&mut self) -> Option<(PageKey, Vec<CpuEntryKey>)> {
        while let Some(key) = self.ready.pop_front() {
            if let Some(work) = self.take(key) {
                return Some(work);
            }
        }
        None
    }
    /// The page `key`, taken from the queue: its entries to compile, or None
    /// when it has nothing left to compile
    fn take(&mut self, key: PageKey) -> Option<(PageKey, Vec<CpuEntryKey>)> {
        let Some(&i) = self.index.get(&key)
        else {
            return None;
        };
        let page = &mut self.pages[i];
        page.queued = false;
        if page.failed || page.attempts >= MAX_ATTEMPTS || page.entries.is_empty() {
            return None;
        }
        if page.served.is_empty() {
            self.first += 1;
        }
        else {
            self.again += 1;
        }
        page.attempts += 1;
        page.visits = 0;
        let mut entries = page.entries.clone();
        entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.linear.0.cmp(&b.0.linear.0)));
        let mut keys: Vec<CpuEntryKey> = entries.into_iter().map(|(e, _)| e).collect();
        for served in &page.served {
            if keys.len() < MAX_ENTRIES && !keys.contains(served) {
                keys.push(*served);
            }
        }
        Some((key, keys))
    }
    /// Record the entries a compiled page function serves, or that the page
    /// cannot be compiled at all (its entries then use region compilation).
    pub fn compiled(
        &mut self,
        key: PageKey,
        requested: &[CpuEntryKey],
        served: Option<(&[CpuEntryKey], u32)>,
    ) {
        let Some(&i) = self.index.get(&key)
        else {
            return;
        };
        let page = &mut self.pages[i];
        match served {
            Some((served, physical)) => {
                self.compiles = self.compiles.wrapping_add(1);
                page.physical = Some(physical);
                for entry in served {
                    if !page.served.contains(entry) {
                        page.served.push(*entry);
                    }
                }
                for entry in requested {
                    if !served.contains(entry) && !page.declined.contains(entry) {
                        page.declined.push(*entry);
                        self.declined_entries += 1;
                    }
                }
                page.entries
                    .retain(|(e, _)| !served.contains(e) && !page.declined.contains(e));
            },
            None => {
                self.failures = self.failures.wrapping_add(1);
                page.failed = true;
            },
        }
    }
    /// The page's code could not be captured now (not mapped in the current
    /// address space): not a failure, a later heat batch may compile it.
    pub fn capture_missed(&mut self, key: PageKey) {
        if let Some(&i) = self.index.get(&key) {
            let page = &mut self.pages[i];
            page.queued = false;
        }
    }
    /// The published function was retired or evicted: its entries need heat.
    pub fn unserve(&mut self, entries: &[CpuEntryKey]) {
        for entry in entries {
            if let Some(&i) = self.index.get(&PageKey::of(*entry)) {
                self.pages[i].served.retain(|e| e != entry);
            }
        }
    }
    /// Code bytes changed: allow new attempts and forget stale service claims.
    pub fn dirty(&mut self, physical: u32) {
        for page in &mut self.pages {
            if page.physical == Some(physical) {
                self.dirty_resets += 1;
                page.invalidations = page.invalidations.saturating_add(1);
                page.visits = 0;
                page.attempts = 0;
                page.failed = false;
                page.served.clear();
                page.declined.clear();
                page.physical = None;
            }
        }
    }
}
