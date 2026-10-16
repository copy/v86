//! Guest RAM beyond the wasm32 backing store, "extended RAM": the engine
//! both cores share (docs/x86-64.md; docs/arm64-virt-android16-plan.md
//! P8.5). Guest physical [base, base + pages * 4 KiB) lives in a host store
//! (JavaScript ArrayBuffers, shared with vCPU workers: `js::extended_load`
//! and `js::extended_store` copy one page, src/extended_memory.js) and is
//! cached in a pool of 4 KiB frames in the wasm heap.
//!
//! What this module does: the frames (a FIFO with a second chance for
//! referenced frames), loading, writing back and evicting them; pinning a
//! frame for a host copy; flushing the store (snapshots) and discarding the
//! frames (restore, power-on); the pages that compiled code was made from
//! (`code`, retired at their next write); one re-entrant lock with cores in
//! workers. What a core adds through crate::isa's hooks: whatever else may
//! hold a frame (an access cache of compiled code may map a frame, which is
//! then CACHED and not reused before `release_cached`; x86:
//! crate::x64::extended::cache_frame), the code of a written page, and the
//! state to drop with the frames (x86: the aperture of compatibility mode).

use crate::parallel::{machine, SpinLock};
use std::ptr;

#[cfg(target_arch = "wasm32")]
mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        /// Copy extended page `page` (index from the start of the range) from
        /// the host store to `pointer` in wasm memory
        pub fn extended_load(page: u32, pointer: u32);
        /// Copy the page at `pointer` to the host store
        pub fn extended_store(page: u32, pointer: u32);
    }
}
// (cargo test: no test configures extended RAM, and a native frame's
// address does not fit the imports' u32)
#[cfg(not(target_arch = "wasm32"))]
mod js {
    pub unsafe fn extended_load(_page: u32, _pointer: u32) { unreachable!() }
    pub unsafe fn extended_store(_page: u32, _pointer: u32) { unreachable!() }
}

pub const PAGE: u64 = 4096;
pub const NONE: u32 = u32::MAX;
pub const REFERENCED: u8 = 1;
pub const DIRTY: u8 = 2;
/// in an access cache of compiled code: not reusable before `release_cached`
pub const CACHED: u8 = 4;
/// in the replacement queue
pub const QUEUED: u8 = 8;

pub struct Extended {
    pub base: u64,
    pub pages: u32,
    pub pool: *mut u8,
    pub frames: u32,
    /// frame of each page, or NONE
    pub page_frame: Vec<u32>,
    /// page of each frame, or NONE
    pub frame_page: Vec<u32>,
    pub frame_state: Vec<u8>,
    pub frame_pins: Vec<u16>,
    /// Replacement order: a FIFO ring of resident frames with a second chance
    /// for referenced ones; cached frames leave it until released. Fixed
    /// capacity (one slot per frame): workers never allocate machine memory.
    queue: Vec<u32>,
    head: u32,
    pub queued: u32,
    /// frames below this were used since the pool was (re)set
    unused_from: u32,
    /// frames marked CACHED
    pub cached: u32,
    /// one more frame, for an access when no frame is reusable
    bounce: *mut u8,
    /// pages with compiled code, one bit each (see `note_write`)
    pub code: Vec<u64>,
    pub stats: [u64; 9],
}
pub const STAT_HITS: usize = 0;
pub const STAT_LOADS: usize = 1;
pub const STAT_STORES: usize = 2;
pub const STAT_EVICTIONS: usize = 3;
pub const STAT_APERTURE: usize = 4;
pub const STAT_LOCKED: usize = 5;
pub const STAT_RELEASES: usize = 6;
pub const STAT_BOUNCES: usize = 7;
pub const STAT_CODE_WRITES: usize = 8;

static mut EXTENDED: Extended = Extended {
    base: 0,
    pages: 0,
    pool: ptr::null_mut(),
    frames: 0,
    page_frame: Vec::new(),
    frame_page: Vec::new(),
    frame_state: Vec::new(),
    frame_pins: Vec::new(),
    queue: Vec::new(),
    head: 0,
    queued: 0,
    unused_from: 0,
    cached: 0,
    bounce: ptr::null_mut(),
    code: Vec::new(),
    stats: [0; 9],
};
/// Too many frames are CACHED, or none was reusable: release them at the
/// next safe point
pub static mut RELEASE_PENDING: bool = false;
// the machine instance's module state and its lock (crate::parallel)
pub fn ext() -> &'static mut Extended { unsafe { &mut *machine(&raw mut EXTENDED) } }

static mut LOCK: SpinLock = SpinLock::new();
/// Owner depth of LOCK (the lock word holds the owner's core + 1)
static mut DEPTH: [u32; crate::parallel::MAX_CORES] = [0; crate::parallel::MAX_CORES];

/// Take the module's lock (re-entrant); a no-op without cores in workers
pub unsafe fn lock() {
    if !crate::parallel::active() {
        return;
    }
    let core = crate::isa::current_core();
    let depth = machine(&raw mut DEPTH).cast::<u32>().add(core);
    if *depth == 0 {
        (*machine(&raw mut LOCK)).lock();
    }
    *depth += 1;
}
pub unsafe fn unlock() {
    if !crate::parallel::active() {
        return;
    }
    let core = crate::isa::current_core();
    let depth = machine(&raw mut DEPTH).cast::<u32>().add(core);
    dbg_assert!(*depth > 0);
    *depth -= 1;
    if *depth == 0 {
        (*machine(&raw mut LOCK)).unlock();
    }
}
/// A failed core's worker holds the lock no more (crate::parallel::parallel_fail)
pub unsafe fn release_held_by(core: usize) {
    *machine(&raw mut DEPTH).cast::<u32>().add(core) = 0;
    (*machine(&raw mut LOCK)).release_held_by(core);
}
pub struct Guard;
impl Guard {
    pub unsafe fn new() -> Guard {
        lock();
        Guard
    }
}
impl Drop for Guard {
    fn drop(&mut self) { unsafe { unlock() } }
}

/// Whether guest physical `address` is extended RAM
#[inline]
pub unsafe fn contains(address: u64) -> bool {
    let e = ext();
    address.wrapping_sub(e.base) < e.pages as u64 * PAGE
}
pub unsafe fn range() -> Option<(u64, u64)> {
    let e = ext();
    (e.pages != 0).then(|| (e.base, e.base + e.pages as u64 * PAGE))
}

/// The resident frame of `page` (loading it, and writing back and reusing
/// another frame when the pool is full), or None if no frame is reusable.
/// Under the lock. Every write to extended RAM comes here first.
pub unsafe fn resident(e: &mut Extended, page: u32, write: bool) -> Option<u32> {
    if write {
        note_write(e, page);
    }
    let mut frame = e.page_frame[page as usize];
    if frame == NONE {
        frame = victim(e)?;
        js::extended_load(page, e.pool.add(frame as usize * PAGE as usize) as u32);
        e.page_frame[page as usize] = frame;
        e.frame_page[frame as usize] = page;
        e.frame_state[frame as usize] = 0;
        enqueue(e, frame);
        e.stats[STAT_LOADS] += 1;
    }
    else {
        e.stats[STAT_HITS] += 1;
    }
    e.frame_state[frame as usize] |= REFERENCED | if write { DIRTY } else { 0 };
    Some(frame)
}

/// Run `access` on the bytes of `page`: in its frame, or, when no frame is
/// reusable, in the bounce frame (written back at once after a write)
pub unsafe fn with_page<T>(
    e: &mut Extended,
    page: u32,
    write: bool,
    access: impl FnOnce(*mut u8) -> T,
) -> T {
    if let Some(frame) = resident(e, page, write) {
        return access(e.pool.add(frame as usize * PAGE as usize));
    }
    RELEASE_PENDING = true;
    e.stats[STAT_BOUNCES] += 1;
    js::extended_load(page, e.bounce as u32);
    let result = access(e.bounce);
    if write {
        js::extended_store(page, e.bounce as u32);
    }
    result
}

pub fn enqueue(e: &mut Extended, frame: u32) {
    dbg_assert!(e.frame_state[frame as usize] & QUEUED == 0 && e.queued < e.frames);
    let at = (e.head + e.queued) % e.frames;
    e.queue[at as usize] = frame;
    e.queued += 1;
    e.frame_state[frame as usize] |= QUEUED;
}
fn dequeue(e: &mut Extended) -> Option<u32> {
    if e.queued == 0 {
        return None;
    }
    let frame = e.queue[e.head as usize];
    e.head = (e.head + 1) % e.frames;
    e.queued -= 1;
    e.frame_state[frame as usize] &= !QUEUED;
    Some(frame)
}

/// A frame to reuse: an unused one, else the oldest resident frame that is
/// not referenced (referenced ones get a second chance), not pinned and not
/// cached (a cached frame leaves the queue until it is released)
unsafe fn victim(e: &mut Extended) -> Option<u32> {
    if e.unused_from < e.frames {
        e.unused_from += 1;
        return Some(e.unused_from - 1);
    }
    for _ in 0..2 * e.queued + 1 {
        let frame = dequeue(e)?;
        let state = e.frame_state[frame as usize];
        if state & CACHED != 0 {
            continue;
        }
        if e.frame_pins[frame as usize] != 0 || state & REFERENCED != 0 {
            e.frame_state[frame as usize] &= !REFERENCED;
            enqueue(e, frame);
            continue;
        }
        evict(e, frame);
        return Some(frame);
    }
    None
}

/// Mark a frame as held by an access cache of compiled code (the core's
/// cache_frame): not reused before `release_cached`
pub fn mark_cached(e: &mut Extended, frame: u32) {
    let state = &mut e.frame_state[frame as usize];
    if *state & CACHED == 0 {
        *state |= CACHED;
        e.cached += 1;
        // (released while half the pool is still reusable)
        if e.cached > e.frames / 2 {
            unsafe { RELEASE_PENDING = true };
        }
    }
}

/// The bytes of extended page `page`, to compile from
pub unsafe fn copy_page(page: u32) -> Vec<u8> {
    let _guard = Guard::new();
    with_page(ext(), page, false, |frame| {
        std::slice::from_raw_parts(frame, PAGE as usize).to_vec()
    })
}

pub fn has_code(e: &Extended, page: u32) -> bool {
    e.code[page as usize / 64] >> (page % 64) & 1 != 0
}

/// Code was compiled from `page`: its next write retires it. Stores through
/// the access caches would not come here: the core retires those.
pub unsafe fn watch_code(page: u32) {
    let e = ext();
    e.code[page as usize / 64] |= 1 << (page % 64);
    let frame = e.page_frame[page as usize];
    // (only a CACHED frame can be in an access cache)
    if frame != NONE && e.frame_state[frame as usize] & CACHED != 0 {
        crate::isa::extended_retire_cached_writes(e.pool.add(frame as usize * PAGE as usize) as u32);
    }
}
/// The code of `page` was retired
pub unsafe fn unwatch_code(page: u32) {
    let e = ext();
    e.code[page as usize / 64] &= !(1 << (page % 64));
}
/// `page` is about to be written: retire the code compiled from it
#[inline]
unsafe fn note_write(e: &mut Extended, page: u32) {
    if has_code(e, page) {
        e.code[page as usize / 64] &= !(1 << (page % 64));
        e.stats[STAT_CODE_WRITES] += 1;
        crate::isa::extended_code_written(page);
    }
}

/// A safe point of the dispatch loop: no compiled code is active
#[inline(always)]
pub unsafe fn safe_point() {
    if RELEASE_PENDING {
        release_cached();
    }
}

/// Retire every access cache entry (the core's), so that no frame is CACHED any more
pub unsafe fn release_cached() {
    RELEASE_PENDING = false;
    let e = ext();
    if e.cached == 0 {
        return;
    }
    crate::isa::extended_release_caches();
    e.stats[STAT_RELEASES] += 1;
    for frame in 0..e.frames {
        let state = e.frame_state[frame as usize];
        if state & CACHED != 0 {
            e.frame_state[frame as usize] &= !CACHED;
            if state & QUEUED == 0 && e.frame_page[frame as usize] != NONE {
                enqueue(e, frame);
            }
        }
    }
    e.cached = 0;
}

unsafe fn evict(e: &mut Extended, frame: u32) {
    let page = e.frame_page[frame as usize];
    if e.frame_state[frame as usize] & DIRTY != 0 {
        js::extended_store(page, e.pool.add(frame as usize * PAGE as usize) as u32);
        e.stats[STAT_STORES] += 1;
    }
    e.page_frame[page as usize] = NONE;
    e.frame_page[frame as usize] = NONE;
    e.frame_state[frame as usize] = 0;
    e.stats[STAT_EVICTIONS] += 1;
}

/// `width` (1, 2, 4 or 8) bytes at `address`, within one page
pub unsafe fn read(address: u64, width: usize) -> u64 {
    let _guard = Guard::new();
    let e = ext();
    let offset = address - e.base;
    dbg_assert!(offset % PAGE + width as u64 <= PAGE);
    with_page(e, (offset / PAGE) as u32, false, |frame| {
        let at = frame.add((offset % PAGE) as usize);
        match width {
            1 => *at as u64,
            2 => ptr::read_unaligned(at as *const u16) as u64,
            4 => ptr::read_unaligned(at as *const u32) as u64,
            _ => ptr::read_unaligned(at as *const u64),
        }
    })
}

pub unsafe fn write(address: u64, width: usize, value: u64) {
    let _guard = Guard::new();
    let e = ext();
    let offset = address - e.base;
    dbg_assert!(offset % PAGE + width as u64 <= PAGE);
    with_page(e, (offset / PAGE) as u32, true, |frame| {
        let at = frame.add((offset % PAGE) as usize);
        match width {
            1 => *at = value as u8,
            2 => ptr::write_unaligned(at as *mut u16, value as u16),
            4 => ptr::write_unaligned(at as *mut u32, value as u32),
            _ => ptr::write_unaligned(at as *mut u64, value),
        }
    })
}

/// Set bits of a qword (paging entry accessed/dirty bits): one step for the
/// other cores, which access extended RAM only under the same lock
pub unsafe fn or64(address: u64, bits: u64) {
    let _guard = Guard::new();
    let value = read(address, 8);
    write(address, 8, value | bits);
}

/// Configure extended RAM (machine instance, before the cores run): `pages`
/// pages at guest physical `base`, cached in `frames` frames (at least 64)
pub unsafe fn configure(base: u64, pages: u32, frames: u32) -> bool {
    if base % PAGE != 0 || pages != 0 && frames < 64 {
        return false;
    }
    let e = &mut *(&raw mut EXTENDED);
    if e.pages != 0 || pages == 0 {
        return pages == 0 && e.pages == 0;
    }
    // (and the bounce frame)
    let layout =
        std::alloc::Layout::from_size_align((frames as usize + 1) * PAGE as usize, PAGE as usize)
            .unwrap();
    let pool = std::alloc::alloc(layout);
    if pool.is_null() {
        return false;
    }
    e.base = base;
    e.pages = pages;
    e.pool = pool;
    e.frames = frames;
    e.page_frame = vec![NONE; pages as usize];
    e.frame_page = vec![NONE; frames as usize];
    e.frame_state = vec![0; frames as usize];
    e.frame_pins = vec![0; frames as usize];
    e.queue = vec![0; frames as usize];
    e.head = 0;
    e.queued = 0;
    e.unused_from = 0;
    e.cached = 0;
    e.bounce = pool.add(frames as usize * PAGE as usize);
    e.code = vec![0; (pages as usize).div_ceil(64)];
    true
}

/// Write back every dirty frame (the store is then complete: snapshots)
pub unsafe fn flush() {
    let _guard = Guard::new();
    // (so that no store bypasses the dirty bits cleared here)
    release_cached();
    let e = ext();
    for frame in 0..e.frames {
        let page = e.frame_page[frame as usize];
        if page != NONE && e.frame_state[frame as usize] & DIRTY != 0 {
            js::extended_store(page, e.pool.add(frame as usize * PAGE as usize) as u32);
            e.frame_state[frame as usize] &= !DIRTY;
            e.stats[STAT_STORES] += 1;
        }
    }
}

/// Forget every frame without writing it back (the store was replaced:
/// snapshot restore, power-on). Every core is stopped.
pub unsafe fn discard() {
    release_cached();
    let e = ext();
    for frame in 0..e.frames as usize {
        dbg_assert!(e.frame_pins[frame] == 0);
        e.frame_page[frame] = NONE;
        e.frame_state[frame] = 0;
    }
    for page in e.page_frame.iter_mut() {
        *page = NONE;
    }
    // (the compiled code goes too: the core clears its caches after this)
    e.code.fill(0);
    e.head = 0;
    e.queued = 0;
    e.unused_from = 0;
    crate::isa::extended_discarded();
}

/// The frame of extended page `page` for a host copy (DMA, debugging),
/// resident until `unpin`: its address in wasm memory (0: no such page)
pub unsafe fn pin(page: u32, write: bool) -> u32 {
    let _guard = Guard::new();
    let e = ext();
    if page >= e.pages {
        return 0;
    }
    // (the host calls this outside compiled code: a safe point)
    let frame = match resident(e, page, write) {
        Some(frame) => frame,
        None => {
            release_cached();
            resident(e, page, write).expect("extended RAM: every frame is pinned")
        },
    };
    e.frame_pins[frame as usize] += 1;
    e.pool.add(frame as usize * PAGE as usize) as u32
}
pub unsafe fn unpin(page: u32) {
    let _guard = Guard::new();
    let e = ext();
    let frame = e.page_frame[page as usize];
    dbg_assert!(frame != NONE && e.frame_pins[frame as usize] > 0);
    e.frame_pins[frame as usize] -= 1;
}

/// 0 hits, 1 loads, 2 write-backs, 3 evictions, 4 aperture mappings (x86),
/// 5 locked instructions (x86); 6 pages, 7 frames; 8 releases of cached frames,
/// 9 accesses through the bounce frame; now: 10 queued frames, 11 frames
/// counted as cached, 12 frames marked CACHED, 13 pinned frames; 14 pages
/// with compiled code now, 15 compiled code retired by writes
pub unsafe fn stat(field: u32) -> f64 {
    let e = ext();
    let frames = || 0..e.frames as usize;
    match field {
        0..=5 => e.stats[field as usize] as f64,
        6 => e.pages as f64,
        7 => e.frames as f64,
        8 => e.stats[STAT_RELEASES] as f64,
        9 => e.stats[STAT_BOUNCES] as f64,
        10 => e.queued as f64,
        11 => e.cached as f64,
        12 => frames().filter(|&f| e.frame_state[f] & CACHED != 0).count() as f64,
        13 => frames().filter(|&f| e.frame_pins[f] != 0).count() as f64,
        14 => e.code.iter().map(|word| word.count_ones()).sum::<u32>() as f64,
        15 => e.stats[STAT_CODE_WRITES] as f64,
        _ => -1.0,
    }
}
