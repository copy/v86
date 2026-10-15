//! A page tier's runtime (P5.7): its functions (one per code page, or a span
//! of pages), the code pages it knows (heat::PageState), the functions'
//! publication phases, least-recently-used eviction and the release of dead
//! functions' slots at the client's cold points. Generic over the client's
//! frontend (PageFrontend), whose types hold what is the ISA's: the x64 page
//! tier (crate::x64::pages, `X86`) is the first client; when, how and in
//! which mode to compile, and how to run a function, stay its own.

use super::heat::PageState;
use super::publish::Phase;
use std::collections::HashMap;

/// A client's types
pub trait PageFrontend {
    /// a function's own data
    type Code;
    /// a code page's own state
    type Page: Default;
    /// the runtime's own state
    type Extra;
}

pub struct Function<C> {
    /// the key of its (first) page: a backing page number with the client's
    /// mode bits
    pub page: u32,
    pub id: u64,
    pub slot: u32,
    pub phase: Phase,
    /// Block starts: a bitmap of offsets, 64 words a page of `members`
    pub served: Vec<u64>,
    /// The keys of the pages it covers, `page` first
    pub members: Vec<u32>,
    pub last_used: u64,
    pub x: C,
}
fn bit(set: &[u64], offset: u16) -> bool { set[offset as usize / 64] >> (offset % 64) & 1 != 0 }
impl<C> Function<C> {
    /// Which of its pages has key `key`, if any
    pub fn member(&self, key: u32) -> Option<usize> { self.members.iter().position(|&m| m == key) }
    /// Whether it serves offset `offset` of its member page `m`
    pub fn serves(&self, m: usize, offset: u16) -> bool {
        bit(&self.served, (m * 4096) as u16 + offset)
    }
}

/// Multiplicative hashing for page numbers.
#[derive(Default)]
pub struct PageHasher(u64);
impl std::hash::Hasher for PageHasher {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(8) ^ b as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        }
    }
    fn write_u32(&mut self, value: u32) {
        self.0 = (value as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}
pub type PageMap<V> = HashMap<u32, V, std::hash::BuildHasherDefault<PageHasher>>;

pub struct PageRuntime<F: PageFrontend> {
    pub functions: Vec<Function<F::Code>>,
    pub by_page: PageMap<usize>,
    pub pages: PageMap<PageState<F::Page>>,
    /// slots of dead functions, released at the next cold point
    pub releases: Vec<(u32, u64)>,
    pub next_id: u64,
    pub clock: u64,
    pub enabled: bool,
    /// the client's counters
    pub stats: [u64; 13],
    /// Changes whenever a function is registered or retired (HeatBatch)
    pub generation: u32,
    pub x: F::Extra,
}

impl<F: PageFrontend> PageRuntime<F> {
    pub fn new(x: F::Extra) -> Self {
        PageRuntime {
            functions: Vec::new(),
            by_page: PageMap::default(),
            pages: PageMap::default(),
            releases: Vec::new(),
            next_id: 1,
            clock: 0,
            enabled: true,
            stats: [0; 13],
            generation: 0,
            x,
        }
    }
    /// Its functions that are not dead
    pub fn live(&self) -> u32 {
        self.functions
            .iter()
            .filter(|f| f.phase != Phase::Dead)
            .count() as u32
    }
    /// The function a full quota retires for a compile of code of a class
    /// (`in_class`, a mode of the client's): the least recently used ready
    /// one, of that class when the class holds more than `share` (P7.2b)
    pub fn victim(
        &self,
        in_class: impl Fn(&Function<F::Code>) -> bool,
        share: usize,
    ) -> Option<usize> {
        let held = self
            .functions
            .iter()
            .filter(|f| f.phase != Phase::Dead && in_class(f))
            .count();
        let crowded = held > share;
        self.functions
            .iter()
            .enumerate()
            .filter(|(_, f)| f.phase == Phase::Ready && (!crowded || in_class(f)))
            .min_by_key(|(_, f)| f.last_used)
            .map(|(i, _)| i)
    }
    /// The pending function with code `id` in `slot` (the host asks before it
    /// sets the slot)
    pub fn pending(&self, id: u64, slot: u32) -> Option<usize> {
        self.functions
            .iter()
            .position(|f| f.id == id && f.slot == slot && f.phase == Phase::Pending)
    }
    /// Pending -> Ready for the function with code `id` in `slot`
    pub fn ready(&mut self, id: u64, slot: u32) -> Option<usize> {
        let i = self.pending(id, slot)?;
        self.functions[i].phase.ready();
        Some(i)
    }
    /// The function with code `id` in `slot`, unless dead
    pub fn alive(&self, id: u64, slot: u32) -> Option<usize> {
        self.functions
            .iter()
            .position(|f| f.id == id && f.slot == slot && f.phase != Phase::Dead)
    }
    /// Function `index` dies (false if it was dead): its slot is released at
    /// the next cold point (release_dead), its page keys stay the client's to
    /// unmap
    pub fn kill(&mut self, index: usize) -> bool {
        let f = &mut self.functions[index];
        if !f.phase.kill() {
            return false;
        }
        self.generation = self.generation.wrapping_add(1);
        self.releases.push((f.slot, f.id));
        true
    }
    /// At a cold point (no function running): each dead function's slot,
    /// through `release`
    pub fn release_dead(&mut self, mut release: impl FnMut(u32, u64)) {
        for (slot, id) in self.releases.drain(..) {
            release(slot, id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Test;
    impl PageFrontend for Test {
        type Code = bool;
        type Page = ();
        type Extra = ();
    }
    fn function(page: u32, id: u64, phase: Phase, last_used: u64, class: bool) -> Function<bool> {
        Function {
            page,
            id,
            slot: id as u32,
            phase,
            served: vec![0; 64],
            members: vec![page],
            last_used,
            x: class,
        }
    }

    #[test]
    fn phases_eviction_and_release() {
        let mut r: PageRuntime<Test> = PageRuntime::new(());
        r.functions.push(function(1, 1, Phase::Ready, 5, false));
        r.functions.push(function(2, 2, Phase::Ready, 3, true));
        r.functions.push(function(3, 3, Phase::Pending, 1, true));
        r.functions.push(function(4, 4, Phase::Ready, 9, true));
        assert_eq!(r.live(), 4);
        // (any class: the least recently used ready one; a crowded class: its own)
        assert_eq!(r.victim(|f| !f.x, 10), Some(1));
        assert_eq!(r.victim(|f| !f.x, 0), Some(0));
        assert_eq!(r.pending(3, 3), Some(2));
        assert_eq!(r.pending(3, 4), None);
        assert_eq!(r.ready(3, 3), Some(2));
        assert_eq!(r.ready(3, 3), None);
        let generation = r.generation;
        assert!(r.kill(1));
        assert!(!r.kill(1));
        assert_eq!(r.generation, generation.wrapping_add(1));
        assert_eq!(r.alive(2, 2), None);
        assert_eq!(r.live(), 3);
        let mut released = Vec::new();
        r.release_dead(|slot, id| released.push((slot, id)));
        assert_eq!(released, [(2, 2)]);
        assert!(r.releases.is_empty());
        let f = &r.functions[0];
        assert_eq!(f.member(1), Some(0));
        assert!(!f.serves(0, 5));
    }
}
