//! Host-parallel execution (docs/multicore.md).
//!
//! build/v86-parallel.wasm runs one instance per vCPU in one shared memory
//! (src/parallel/relocate.js). The machine instance, at base 0, runs the
//! bootstrap processor and owns the devices; each application processor runs
//! in a worker with its own relocated copy of the module. A static therefore
//! belongs to one instance, unless it is reached through `machine()`, which
//! maps a static of this instance to the same static of the machine instance:
//! the local APICs, the IOAPIC, the INIT/SIPI/NMI latches, the physical bus
//! and the code page counts are machine state accessed that way.
//!
//! Guest RAM is shared. In the parallel build every aligned access to it is a
//! sequentially consistent atomic (x86 TSO needs ordered loads and stores on
//! weakly ordered hosts), read-modify-write instructions commit with a
//! compare-exchange, and unaligned accesses are fenced on both sides. The
//! normal build compiles these helpers to plain memory accesses.

use std::ptr;
#[cfg(feature = "parallel")]
use std::sync::atomic::{fence, AtomicU16, AtomicU32, AtomicU64, AtomicU8, Ordering::SeqCst};

pub const MAX_CORES: usize = crate::isa::MAX_CORES;

#[cfg(feature = "parallel")]
mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn parallel_notify(address: u32);
    }
}

/// Address at which this instance's static data starts relative to the
/// machine instance (0 in the machine instance)
static mut INSTANCE_BASE: u32 = 0;
/// Set while the machine runs cores in workers: in every instance
static mut ACTIVE: bool = false;

/// Whether this is the machine instance (the BSP and the devices)
pub fn machine_instance() -> bool {
    #[cfg(feature = "parallel")]
    {
        unsafe { INSTANCE_BASE == 0 }
    }
    #[cfg(not(feature = "parallel"))]
    {
        true
    }
}

/// The machine instance's copy of a static of this instance
#[inline(always)]
pub fn machine<T>(p: *mut T) -> *mut T {
    #[cfg(feature = "parallel")]
    {
        (p as u32).wrapping_sub(unsafe { INSTANCE_BASE }) as *mut T
    }
    #[cfg(not(feature = "parallel"))]
    {
        p
    }
}

/// The machine instance's copy of a field of this instance's CPU state block
/// (crate::state_block): the state blocks are in slots below the static
/// data, one per core (src/parallel/relocate.js), the machine's in slot 0
#[inline(always)]
pub fn machine_state<T>(p: *mut T) -> *mut T {
    #[cfg(feature = "parallel")]
    {
        (p as u32).wrapping_sub(crate::state_block::state_base()) as *mut T
    }
    #[cfg(not(feature = "parallel"))]
    {
        p
    }
}

/// Whether other cores may run concurrently in other workers
#[inline(always)]
pub fn active() -> bool {
    #[cfg(feature = "parallel")]
    {
        unsafe { ACTIVE }
    }
    #[cfg(not(feature = "parallel"))]
    {
        false
    }
}

/// This instance runs one application processor in a worker
#[inline(always)]
pub fn is_worker() -> bool { cfg!(feature = "parallel") && unsafe { INSTANCE_BASE } != 0 }

// Machine-wide words of the parallel runtime (accessed through machine()):
// the wake-up sequence each core waits on while halted, and where each core's
// yield flag is (the instance-private cpu::core_yield of its worker).
static mut CORE_WAKE: [u32; MAX_CORES] = [0; MAX_CORES];
static mut CORE_YIELD: [u32; MAX_CORES] = [0; MAX_CORES];

/// Address of the word a halted core waits on (Atomics.wait in its worker)
#[no_mangle]
pub unsafe fn parallel_wake_addr(core: u32) -> u32 {
    assert!((core as usize) < MAX_CORES);
    machine(&raw mut CORE_WAKE).cast::<u32>().add(core as usize) as u32
}

/// Make a core notice new work soon: leave its current slice and, if it
/// waits, wake up. Called after an interrupt, INIT/SIPI or a request was
/// posted for it. Harmless for the core that calls it.
/// Kicks by all cores (diagnostics: parallel_kick_count)
static mut KICKS: u32 = 0;
#[no_mangle]
pub unsafe fn parallel_kick_count() -> u32 { *machine(&raw mut KICKS) }
pub unsafe fn kick(core: usize) {
    #[cfg(feature = "parallel")]
    {
        if !ACTIVE || core >= MAX_CORES {
            return;
        }
        (*(machine(&raw mut KICKS) as *const AtomicU32)).fetch_add(1, SeqCst);
        let flag = *machine(&raw mut CORE_YIELD).cast::<u32>().add(core);
        if flag != 0 {
            (*(flag as *const AtomicU8)).store(1, SeqCst);
        }
        let wake = machine(&raw mut CORE_WAKE).cast::<u32>().add(core);
        (*(wake as *const AtomicU32)).fetch_add(1, SeqCst);
        // (memory.atomic.notify is not available to stable Rust: Atomics.notify)
        js::parallel_notify(wake as u32);
    }
    #[cfg(not(feature = "parallel"))]
    let _ = core;
}

#[no_mangle]
pub unsafe fn parallel_kick(core: u32) { kick(core as usize) }

/// The machine instance starts or stops running cores in workers
#[no_mangle]
pub unsafe fn parallel_set_active(active: bool) {
    assert!(cfg!(feature = "parallel") || !active);
    ACTIVE = active;
    if active {
        let yield_flags = machine(&raw mut CORE_YIELD).cast::<u32>();
        *yield_flags.add(crate::isa::current_core()) = crate::isa::core_yield_address();
        if !is_worker() {
            crate::isa::machine_set_active();
        }
    }
}

/// Attach this relocated instance to the machine: `base` is where its static
/// data was placed, `core` the application processor it runs. RAM, the
/// machine configuration and the machine-shared state are the ones of the
/// machine instance from now on.
#[no_mangle]
pub unsafe fn parallel_attach(base: u32, core: u32) {
    assert!(cfg!(feature = "parallel"));
    assert!(base != 0 && (core as usize) < MAX_CORES && core != 0);
    INSTANCE_BASE = base;
    ACTIVE = true;
    crate::isa::attach_worker(core);
    let yield_flags = machine(&raw mut CORE_YIELD).cast::<u32>();
    *yield_flags.add(core as usize) = crate::isa::core_yield_address();
}

/// After a stop of all cores: the machine may have changed its physical bus
/// windows or ACPI mode while this worker was parked
#[no_mangle]
pub unsafe fn parallel_sync() {
    if is_worker() {
        crate::isa::sync_worker();
        sync_worker_configuration();
    }
}

/// Machine configuration that may change while the cores run (ACPI enable,
/// the CPU profile, TSEG): copied into a worker at the start of each of its
/// slices
pub unsafe fn sync_worker_configuration() {
    if is_worker() {
        crate::isa::sync_worker_configuration();
    }
}

/// A lock in machine memory. Critical sections are short (one IOAPIC or
/// local APIC operation) and never wait for another core. The word holds the
/// owner's core number + 1: when a worker fails, parallel_fail releases the
/// locks its core held, so the other cores do not spin forever.
#[repr(transparent)]
pub struct SpinLock(u32);
impl SpinLock {
    pub const fn new() -> Self { SpinLock(0) }
    #[inline(always)]
    pub fn lock(&self) {
        #[cfg(feature = "parallel")]
        {
            let word = unsafe { &*(&raw const self.0 as *const AtomicU32) };
            let owner = crate::isa::current_core() as u32 + 1;
            while word
                .compare_exchange_weak(0, owner, SeqCst, SeqCst)
                .is_err()
            {
                std::hint::spin_loop();
            }
        }
    }
    #[inline(always)]
    pub fn unlock(&self) {
        #[cfg(feature = "parallel")]
        {
            let word = unsafe { &*(&raw const self.0 as *const AtomicU32) };
            word.store(0, SeqCst);
        }
    }
    /// Whether `core` holds the lock
    pub fn held_by(&self, core: usize) -> bool {
        #[cfg(feature = "parallel")]
        {
            let word = unsafe { &*(&raw const self.0 as *const AtomicU32) };
            word.load(SeqCst) == core as u32 + 1
        }
        #[cfg(not(feature = "parallel"))]
        {
            let _ = core;
            false
        }
    }
    /// Release the lock if `core` holds it
    pub fn release_held_by(&self, core: usize) {
        #[cfg(feature = "parallel")]
        {
            let word = unsafe { &*(&raw const self.0 as *const AtomicU32) };
            let _ = word.compare_exchange(core as u32 + 1, 0, SeqCst, SeqCst);
        }
        #[cfg(not(feature = "parallel"))]
        let _ = core;
    }
}

/// This instance's core failed: its worker caught an error (a trap or an
/// exception of the JS side) and stops. Release the machine's locks the core
/// held and count it as idle, so that the other cores neither spin on its
/// locks nor wait for it to acknowledge code publications. The machine then
/// stops (src/parallel/machine.js).
#[no_mangle]
pub unsafe fn parallel_fail() { release_core(crate::isa::current_core()) }

/// The machine found a core's worker failed or gone (the same as
/// parallel_fail, in case the worker could not run it)
#[no_mangle]
pub unsafe fn parallel_core_failed(core: u32) {
    assert!((core as usize) < MAX_CORES);
    release_core(core as usize)
}

unsafe fn release_core(core: usize) {
    if !active() {
        return;
    }
    #[cfg(feature = "parallel")]
    if split_lock().held_by(core) {
        // (an exclusive locked operation of this core stopped halfway)
        locked_operations().fetch_and(!EXCLUSIVE, SeqCst);
    }
    split_lock().release_held_by(core);
    crate::isa::release_locks_held_by(core);
    code::set_idle(core, true);
}

/// Test hook (tests/parallel/lifecycle.mjs): trap inside the critical
/// sections, as a failing core could
#[no_mangle]
pub unsafe fn parallel_test_fault() {
    split_lock().lock();
    crate::isa::lock_for_test_fault();
    #[cfg(target_arch = "wasm32")]
    std::arch::wasm32::unreachable();
    #[cfg(not(target_arch = "wasm32"))]
    unreachable!("parallel_test_fault");
}

// Guest RAM accesses (host pointers into mem8). Naturally aligned accesses
// are single-copy atomic and sequentially consistent in the parallel build;
// the others are fenced on both sides, which keeps their order with respect
// to every other access (x86 does not make them atomic either).

#[inline(always)]
pub unsafe fn load8(p: *const u8) -> u8 {
    #[cfg(feature = "parallel")]
    {
        (*(p as *const AtomicU8)).load(SeqCst)
    }
    #[cfg(not(feature = "parallel"))]
    {
        *p
    }
}
#[inline(always)]
pub unsafe fn load16(p: *const u8) -> u16 {
    #[cfg(feature = "parallel")]
    {
        if p as usize & 1 == 0 {
            return (*(p as *const AtomicU16)).load(SeqCst);
        }
        fence(SeqCst);
        let value = ptr::read_unaligned(p as *const u16);
        fence(SeqCst);
        value
    }
    #[cfg(not(feature = "parallel"))]
    {
        ptr::read_unaligned(p as *const u16)
    }
}
#[inline(always)]
pub unsafe fn load32(p: *const u8) -> u32 {
    #[cfg(feature = "parallel")]
    {
        if p as usize & 3 == 0 {
            return (*(p as *const AtomicU32)).load(SeqCst);
        }
        fence(SeqCst);
        let value = ptr::read_unaligned(p as *const u32);
        fence(SeqCst);
        value
    }
    #[cfg(not(feature = "parallel"))]
    {
        ptr::read_unaligned(p as *const u32)
    }
}
#[inline(always)]
pub unsafe fn load64(p: *const u8) -> u64 {
    #[cfg(feature = "parallel")]
    {
        if p as usize & 7 == 0 {
            return (*(p as *const AtomicU64)).load(SeqCst);
        }
        fence(SeqCst);
        let value = ptr::read_unaligned(p as *const u64);
        fence(SeqCst);
        value
    }
    #[cfg(not(feature = "parallel"))]
    {
        ptr::read_unaligned(p as *const u64)
    }
}
/// 16 bytes: two ordered 8-byte halves (SSE accesses are not atomic as a whole)
#[inline(always)]
pub unsafe fn load128(p: *const u8) -> [u64; 2] { [load64(p), load64(p.add(8))] }

#[inline(always)]
pub unsafe fn store8(p: *mut u8, value: u8) {
    #[cfg(feature = "parallel")]
    {
        (*(p as *const AtomicU8)).store(value, SeqCst)
    }
    #[cfg(not(feature = "parallel"))]
    {
        *p = value
    }
}
#[inline(always)]
pub unsafe fn store16(p: *mut u8, value: u16) {
    #[cfg(feature = "parallel")]
    {
        if p as usize & 1 == 0 {
            return (*(p as *const AtomicU16)).store(value, SeqCst);
        }
        fence(SeqCst);
        ptr::write_unaligned(p as *mut u16, value);
        fence(SeqCst);
    }
    #[cfg(not(feature = "parallel"))]
    {
        ptr::write_unaligned(p as *mut u16, value)
    }
}
#[inline(always)]
pub unsafe fn store32(p: *mut u8, value: u32) {
    #[cfg(feature = "parallel")]
    {
        if p as usize & 3 == 0 {
            return (*(p as *const AtomicU32)).store(value, SeqCst);
        }
        fence(SeqCst);
        ptr::write_unaligned(p as *mut u32, value);
        fence(SeqCst);
    }
    #[cfg(not(feature = "parallel"))]
    {
        ptr::write_unaligned(p as *mut u32, value)
    }
}
#[inline(always)]
pub unsafe fn store64(p: *mut u8, value: u64) {
    #[cfg(feature = "parallel")]
    {
        if p as usize & 7 == 0 {
            return (*(p as *const AtomicU64)).store(value, SeqCst);
        }
        fence(SeqCst);
        ptr::write_unaligned(p as *mut u64, value);
        fence(SeqCst);
    }
    #[cfg(not(feature = "parallel"))]
    {
        ptr::write_unaligned(p as *mut u64, value)
    }
}
#[inline(always)]
pub unsafe fn store128(p: *mut u8, value: [u64; 2]) {
    store64(p, value[0]);
    store64(p.add(8), value[1]);
}

/// A full barrier (MFENCE, locked instructions around non-atomic bulk
/// copies); nothing in the normal build
#[inline(always)]
pub fn full_fence() {
    #[cfg(feature = "parallel")]
    fence(SeqCst);
}

/// CMPXCHG16B: no 16-byte atomic exists. It runs exclusively (no other
/// locked operation commits meanwhile) and commits each half with a
/// compare-exchange, so that a plain store to either half in between makes
/// it fail (and the instruction run again) instead of being lost.
pub unsafe fn compare_exchange128(p: *mut u8, expected: u128, value: u128) -> bool {
    #[cfg(not(feature = "parallel"))]
    {
        let equal = ptr::read_unaligned(p as *const u128) == expected;
        if equal {
            ptr::write_unaligned(p as *mut u128, value);
        }
        equal
    }
    #[cfg(feature = "parallel")]
    exclusive(|| {
        let (old_low, old_high) = (expected as u64, (expected >> 64) as u64);
        let (new_low, new_high) = (value as u64, (value >> 64) as u64);
        if p as usize & 7 != 0 {
            // (not for CMPXCHG16B, which requires 16-byte alignment)
            let equal = ptr::read_unaligned(p as *const u128) == expected;
            if equal {
                ptr::write_unaligned(p as *mut u128, value);
            }
            return equal;
        }
        let low = &*(p as *const AtomicU64);
        let high = &*(p.add(8) as *const AtomicU64);
        if high.load(SeqCst) != old_high
            || low
                .compare_exchange(old_low, new_low, SeqCst, SeqCst)
                .is_err()
        {
            return false;
        }
        if high
            .compare_exchange(old_high, new_high, SeqCst, SeqCst)
            .is_err()
        {
            // (if a plain store replaced the low half meanwhile, it stays)
            let _ = low.compare_exchange(new_low, old_low, SeqCst, SeqCst);
            return false;
        }
        true
    })
}

/// Locked operations that no single host atomic covers (unaligned, split,
/// 16 bytes) run exclusively; the aligned ones commit with one atomic
/// compare-exchange while holding a share, so that neither interleaves with
/// the other on the same bytes. Bit 31: an exclusive operation holds it (or
/// waits for the shares to drain); below: aligned operations committing.
#[cfg(feature = "parallel")]
static mut LOCKED_OPERATIONS: u32 = 0;
#[cfg(feature = "parallel")]
const EXCLUSIVE: u32 = 1 << 31;
#[cfg(feature = "parallel")]
fn locked_operations() -> &'static AtomicU32 {
    unsafe { &*(machine(&raw mut LOCKED_OPERATIONS) as *const AtomicU32) }
}
#[cfg(feature = "parallel")]
#[inline(always)]
fn shared<T>(commit: impl FnOnce() -> T) -> T {
    let word = locked_operations();
    loop {
        let current = word.load(SeqCst);
        if current & EXCLUSIVE == 0
            && word
                .compare_exchange_weak(current, current + 1, SeqCst, SeqCst)
                .is_ok()
        {
            break;
        }
        std::hint::spin_loop();
    }
    let result = commit();
    word.fetch_sub(1, SeqCst);
    result
}
#[cfg(feature = "parallel")]
fn exclusive<T>(operation: impl FnOnce() -> T) -> T {
    split_lock().lock();
    let word = locked_operations();
    word.fetch_or(EXCLUSIVE, SeqCst);
    while word.load(SeqCst) & !EXCLUSIVE != 0 {
        std::hint::spin_loop();
    }
    let result = operation();
    word.fetch_and(!EXCLUSIVE, SeqCst);
    split_lock().unlock();
    result
}

/// Replace `expected` by `value` at `p` if it is still there. Unaligned or
/// split operands run exclusively (see `exclusive`): atomic with respect to
/// other locked operations, not to plain stores (a bus lock has no equivalent
/// here). Always succeeds in the normal build.
#[inline(always)]
pub unsafe fn compare_exchange(p: *mut u8, bytes: u32, expected: u64, value: u64) -> bool {
    #[cfg(feature = "parallel")]
    {
        let aligned = p as usize & (bytes as usize - 1) == 0;
        if aligned {
            return shared(|| match bytes {
                1 => (*(p as *const AtomicU8))
                    .compare_exchange(expected as u8, value as u8, SeqCst, SeqCst)
                    .is_ok(),
                2 => (*(p as *const AtomicU16))
                    .compare_exchange(expected as u16, value as u16, SeqCst, SeqCst)
                    .is_ok(),
                4 => (*(p as *const AtomicU32))
                    .compare_exchange(expected as u32, value as u32, SeqCst, SeqCst)
                    .is_ok(),
                _ => (*(p as *const AtomicU64))
                    .compare_exchange(expected, value, SeqCst, SeqCst)
                    .is_ok(),
            });
        }
        exclusive(|| {
            let current = match bytes {
                2 => ptr::read_unaligned(p as *const u16) as u64,
                4 => ptr::read_unaligned(p as *const u32) as u64,
                _ => ptr::read_unaligned(p as *const u64),
            };
            let equal = current == expected;
            if equal {
                match bytes {
                    2 => ptr::write_unaligned(p as *mut u16, value as u16),
                    4 => ptr::write_unaligned(p as *mut u32, value as u32),
                    _ => ptr::write_unaligned(p as *mut u64, value),
                }
            }
            equal
        })
    }
    #[cfg(not(feature = "parallel"))]
    {
        let _ = expected;
        match bytes {
            1 => *p = value as u8,
            2 => ptr::write_unaligned(p as *mut u16, value as u16),
            4 => ptr::write_unaligned(p as *mut u32, value as u32),
            _ => ptr::write_unaligned(p as *mut u64, value),
        }
        true
    }
}

static mut SPLIT_LOCK: SpinLock = SpinLock::new();
/// Serializes locked operations that no single atomic instruction covers
/// (split or unaligned operands, CMPXCHG16B)
pub fn split_lock() -> &'static SpinLock { unsafe { &*machine(&raw mut SPLIT_LOCK) } }

/// Set bits of a guest page table entry (accessed/dirty): other cores may
/// update the same entry at the same time
#[inline(always)]
pub unsafe fn or8(p: *mut u8, bits: u8) {
    #[cfg(feature = "parallel")]
    {
        (*(p as *const AtomicU8)).fetch_or(bits, SeqCst);
    }
    #[cfg(not(feature = "parallel"))]
    {
        *p |= bits
    }
}
#[inline(always)]
pub unsafe fn or32(p: *mut u8, bits: u32) {
    #[cfg(feature = "parallel")]
    {
        if p as usize & 3 == 0 {
            (*(p as *const AtomicU32)).fetch_or(bits, SeqCst);
            return;
        }
    }
    store32(p, load32(p) | bits)
}
#[inline(always)]
pub unsafe fn or64(p: *mut u8, bits: u64) {
    #[cfg(feature = "parallel")]
    {
        if p as usize & 7 == 0 {
            (*(p as *const AtomicU64)).fetch_or(bits, SeqCst);
            return;
        }
    }
    store64(p, load64(p) | bits)
}

/// Add to a machine-shared word: its previous value (a ring's next
/// sequence number, the ARM core's TLB maintenance, P8.3)
#[inline(always)]
pub unsafe fn fetch_add32(p: *mut u32, value: u32) -> u32 {
    #[cfg(feature = "parallel")]
    {
        (*(p as *const AtomicU32)).fetch_add(value, SeqCst)
    }
    #[cfg(not(feature = "parallel"))]
    {
        let previous = *p;
        *p = previous.wrapping_add(value);
        previous
    }
}

/// The larger of a machine-shared doubleword and `value`, which it becomes
/// (the ARM core's system counter, P8.2)
#[inline(always)]
pub unsafe fn max64(p: *mut u64, value: u64) -> u64 {
    #[cfg(feature = "parallel")]
    {
        let previous = (*(p as *const AtomicU64)).fetch_max(value, SeqCst);
        previous.max(value)
    }
    #[cfg(not(feature = "parallel"))]
    {
        *p = (*p).max(value);
        *p
    }
}

/// Swap a machine-shared doubleword (device memory's marks, P8.2)
#[inline(always)]
pub unsafe fn swap64(p: *mut u64, value: u64) -> u64 {
    #[cfg(feature = "parallel")]
    {
        (*(p as *const AtomicU64)).swap(value, SeqCst)
    }
    #[cfg(not(feature = "parallel"))]
    {
        std::mem::replace(&mut *p, value)
    }
}

/// Atomic bit operations on machine-shared words (APIC registers)
#[inline(always)]
pub unsafe fn word_or(p: *mut u32, bits: u32) {
    #[cfg(feature = "parallel")]
    {
        (*(p as *const AtomicU32)).fetch_or(bits, SeqCst);
    }
    #[cfg(not(feature = "parallel"))]
    {
        *p |= bits
    }
}
#[inline(always)]
pub unsafe fn word_and(p: *mut u32, bits: u32) {
    #[cfg(feature = "parallel")]
    {
        (*(p as *const AtomicU32)).fetch_and(bits, SeqCst);
    }
    #[cfg(not(feature = "parallel"))]
    {
        *p &= bits
    }
}
#[inline(always)]
pub unsafe fn word_load(p: *const u32) -> u32 {
    #[cfg(feature = "parallel")]
    {
        (*(p as *const AtomicU32)).load(SeqCst)
    }
    #[cfg(not(feature = "parallel"))]
    {
        *p
    }
}
#[inline(always)]
pub unsafe fn word_store(p: *mut u32, value: u32) {
    #[cfg(feature = "parallel")]
    {
        (*(p as *const AtomicU32)).store(value, SeqCst)
    }
    #[cfg(not(feature = "parallel"))]
    {
        *p = value
    }
}
#[inline(always)]
pub unsafe fn word_swap(p: *mut u32, value: u32) -> u32 {
    #[cfg(feature = "parallel")]
    {
        (*(p as *const AtomicU32)).swap(value, SeqCst)
    }
    #[cfg(not(feature = "parallel"))]
    {
        std::mem::replace(&mut *p, value)
    }
}

/// Coherence of compiled code between cores in workers. Each worker
/// compiles from guest RAM on its own; a store by any core to a page another
/// core compiled from must retire that code.
///
/// - OWNERS: one byte per backing page, a bit per core whose instance holds
///   code (or a cached write barrier) compiled from the page.
/// - A core that starts watching a page (jit::ir_page_count 0 -> 1) claims
///   it and publishes it on the publication ring. Every other core, at its
///   next safe point (`poll`), marks its translations of the page so that
///   stores take the slow path, and acknowledges. The claiming core installs
///   the code only when every other core has acknowledged or is idle
///   (`published`), then validates the source bytes once more: a store that
///   bypassed the mark happened before the acknowledgement, and the
///   validation sees it. (Store then check, and publish then read, are
///   ordered by the sequentially consistent accesses on both sides.)
/// - A store that reaches the slow path for a page other cores own posts the
///   page on the invalidation ring; their next `poll` retires their code.
///   Until then they may still run the old code: x86 requires a serializing
///   instruction on the executing core first, and CPUID and interrupt
///   delivery poll.
pub mod code {
    use super::*;
    #[allow(unused_imports)]
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering::SeqCst};

    const PUBLISH_RING: usize = 1024;
    const INVALIDATE_RING: usize = 4096;

    // machine state (through machine())
    static mut OWNERS: *mut u8 = ptr::null_mut();
    static mut OWNER_PAGES: u32 = 0;
    static mut PUBLISH_NEXT: u32 = 0;
    static mut PUBLISHED: [u64; PUBLISH_RING] = [0; PUBLISH_RING];
    static mut INVALIDATE_NEXT: u32 = 0;
    static mut INVALIDATED: [u64; INVALIDATE_RING] = [0; INVALIDATE_RING];
    static mut ACKED: [u32; MAX_CORES] = [0; MAX_CORES];
    static mut IDLE: [u32; MAX_CORES] = [0; MAX_CORES];
    // this instance
    static mut REFUSED: u32 = 0; // installations given up: other cores had not acknowledged in time
    static mut PUBLISH_SEEN: u32 = 0;
    static mut INVALIDATE_SEEN: u32 = 0;
    static mut CLAIMED: Vec<u32> = Vec::new(); // publication sequence per page, 0: none

    unsafe fn me() -> usize { crate::isa::current_core() }
    /// For generated code that leaves for poll() when other cores published
    /// or invalidated code (x64 page functions chaining): the machine's
    /// PUBLISH_NEXT, this instance's PUBLISH_SEEN, the machine's
    /// INVALIDATE_NEXT and this instance's INVALIDATE_SEEN
    pub unsafe fn pending_addresses() -> [u32; 4] {
        [
            machine(&raw mut PUBLISH_NEXT) as u32,
            &raw mut PUBLISH_SEEN as u32,
            machine(&raw mut INVALIDATE_NEXT) as u32,
            &raw mut INVALIDATE_SEEN as u32,
        ]
    }
    unsafe fn owner(page: u32) -> *mut u8 {
        let owners = *machine(&raw mut OWNERS);
        if owners.is_null() || page >= *machine(&raw mut OWNER_PAGES) {
            return ptr::null_mut();
        }
        owners.add(page as usize)
    }

    /// The machine instance: RAM pages to track (all cores stopped)
    pub unsafe fn allocate(pages: u32) {
        if (*(&raw mut OWNERS)).is_null() || OWNER_PAGES < pages {
            let owners = vec![0u8; pages as usize].leak();
            OWNERS = owners.as_mut_ptr();
            OWNER_PAGES = pages;
        }
        reset();
    }
    /// Machine reset or snapshot restore (all cores stopped): no code anywhere
    #[no_mangle]
    pub unsafe fn parallel_code_reset() { reset() }
    unsafe fn reset() {
        if !(*machine(&raw mut OWNERS)).is_null() {
            ptr::write_bytes(
                *machine(&raw mut OWNERS),
                0,
                *machine(&raw mut OWNER_PAGES) as usize,
            );
        }
    }

    /// jit_clear_cache: this instance has no code any more
    pub unsafe fn release_all() {
        if !active() {
            return;
        }
        let claimed = &mut *(&raw mut CLAIMED);
        for (page, seq) in claimed.iter_mut().enumerate() {
            if *seq != 0 {
                *seq = 0;
                let at = owner(page as u32);
                if !at.is_null() {
                    and8(at, !(1 << me()));
                }
            }
        }
    }

    /// Whether another core has code from this backing page: its stores need
    /// the slow path (TLB fills, write translation caches)
    #[inline]
    pub unsafe fn others_own(page: u32) -> bool {
        if !active() {
            return false;
        }
        let at = owner(page);
        !at.is_null() && load8(at) & !(1u8 << me()) != 0
    }

    /// This core now has code from `page`
    pub unsafe fn claim(page: u32) {
        if !active() {
            return;
        }
        let at = owner(page);
        if at.is_null() {
            return;
        }
        or8(at, 1 << me());
        let seq = append(
            machine(&raw mut PUBLISH_NEXT),
            machine(&raw mut PUBLISHED).cast(),
            PUBLISH_RING,
            page,
        );
        let claimed = &mut *(&raw mut CLAIMED);
        if claimed.len() <= page as usize {
            claimed.resize(page as usize + 1, 0);
        }
        claimed[page as usize] = seq;
        for core in 0..crate::isa::core_count() {
            if core != me() {
                kick(core);
            }
        }
    }
    /// This core has no code from `page` any more
    pub unsafe fn release(page: u32) {
        if !active() {
            return;
        }
        let at = owner(page);
        if !at.is_null() {
            and8(at, !(1 << me()));
        }
        if let Some(seq) = (&mut *(&raw mut CLAIMED)).get_mut(page as usize) {
            *seq = 0;
        }
    }

    /// A write reached `page` through the slow path (or a device wrote it):
    /// retire other cores' code from it
    pub unsafe fn written(page: u32) {
        if !active() {
            return;
        }
        let at = owner(page);
        if at.is_null() {
            return;
        }
        let others = load8(at) & !(1u8 << me());
        if others == 0 {
            return;
        }
        append(
            machine(&raw mut INVALIDATE_NEXT),
            machine(&raw mut INVALIDATED).cast(),
            INVALIDATE_RING,
            page,
        );
        for core in 0..MAX_CORES {
            if others & 1 << core != 0 {
                kick(core);
            }
        }
    }

    /// Whether every other core has marked the pages this core published
    /// (the latest claim of each), so that code compiled from them may run
    pub unsafe fn published(pages: impl Iterator<Item = u32>) -> bool {
        if !active() {
            return true;
        }
        let claimed = &*(&raw const CLAIMED);
        let mut needed = 0u32;
        for page in pages {
            match claimed.get(page as usize) {
                Some(&seq) if seq != 0 => {
                    if (seq.wrapping_sub(needed) as i32) > 0 {
                        needed = seq;
                    }
                },
                // not claimed (no RAM page, or claimed and released again): no code may depend on it
                _ => {
                    if !owner(page).is_null() {
                        return false;
                    }
                },
            }
        }
        if needed == 0 {
            return true;
        }
        let acked = machine(&raw mut ACKED).cast::<u32>();
        let idle = machine(&raw mut IDLE).cast::<u32>();
        for core in 0..crate::isa::core_count() {
            if core == me() {
                continue;
            }
            if word_load(idle.add(core)) != 0 {
                continue;
            }
            if (word_load(acked.add(core)).wrapping_sub(needed) as i32) < 0 {
                return false;
            }
        }
        true
    }

    /// Wait up to `ms` for `published`; count a refusal when it stays false.
    /// The machine clock stands still while the machine is paused, and an
    /// asynchronous installation can complete then (with the other cores
    /// parked), so the wait is bounded by a number of checks as well.
    pub unsafe fn wait_published(pages: impl Iterator<Item = u32> + Clone, ms: f64) -> bool {
        if published(pages.clone()) {
            return true;
        }
        let deadline = crate::isa::microtick() + ms;
        for _ in 0..MAX_PUBLICATION_CHECKS {
            if published(pages.clone()) {
                return true;
            }
            if crate::isa::microtick() >= deadline {
                break;
            }
        }
        REFUSED = REFUSED.wrapping_add(1);
        false
    }
    /// (a few milliseconds of checks at most)
    const MAX_PUBLICATION_CHECKS: u32 = 1 << 14;

    /// Diagnostics: 0 installations this core gave up because other cores
    /// had not acknowledged its pages in time, 1 publications, 2
    /// invalidations posted by all cores
    #[no_mangle]
    pub unsafe fn parallel_code_stat(kind: u32) -> u32 {
        match kind {
            0 => REFUSED,
            1 => *machine(&raw mut PUBLISH_NEXT),
            _ => *machine(&raw mut INVALIDATE_NEXT),
        }
    }

    /// This core waits (halted, parked, not started) or runs again. A waking
    /// core polls before it executes anything.
    #[no_mangle]
    pub unsafe fn parallel_idle(idle: bool) {
        if !active() {
            return;
        }
        set_idle(me(), idle);
        if !idle {
            poll();
        }
    }
    pub unsafe fn set_idle(core: usize, idle: bool) {
        word_store(machine(&raw mut IDLE).cast::<u32>().add(core), idle as u32);
    }
    /// Whether `core` waits (halted, parked, not started): it polls before it runs again
    pub unsafe fn is_idle(core: usize) -> bool {
        word_load(machine(&raw mut IDLE).cast::<u32>().add(core)) != 0
    }

    /// Take other cores' publications and invalidations: at safe points
    #[no_mangle]
    pub unsafe fn parallel_poll() { poll() }
    pub unsafe fn poll() {
        if !active() {
            return;
        }
        let publications = (*(machine(&raw mut PUBLISH_NEXT) as *const AtomicU32)).load(SeqCst);
        let invalidations = (*(machine(&raw mut INVALIDATE_NEXT) as *const AtomicU32)).load(SeqCst);
        if publications == PUBLISH_SEEN && invalidations == INVALIDATE_SEEN {
            return;
        }
        // publications: mark this core's translations of the pages
        let mut pages = Vec::new();
        let overflow = drain(
            machine(&raw mut PUBLISH_NEXT),
            machine(&raw mut PUBLISHED).cast(),
            PUBLISH_RING,
            &raw mut PUBLISH_SEEN,
            &mut pages,
        );
        crate::isa::others_published(&pages, overflow);
        word_store(
            machine(&raw mut ACKED).cast::<u32>().add(me()),
            PUBLISH_SEEN,
        );
        // invalidations: retire this core's code from the pages
        pages.clear();
        let overflow = drain(
            machine(&raw mut INVALIDATE_NEXT),
            machine(&raw mut INVALIDATED).cast(),
            INVALIDATE_RING,
            &raw mut INVALIDATE_SEEN,
            &mut pages,
        );
        crate::isa::others_wrote(pages, overflow);
    }

    unsafe fn append(next: *mut u32, ring: *mut u64, size: usize, page: u32) -> u32 {
        let seq = (*(next as *const AtomicU32))
            .fetch_add(1, SeqCst)
            .wrapping_add(1);
        let slot = ring.add(seq as usize % size);
        (*(slot as *const AtomicU64)).store((seq as u64) << 32 | page as u64, SeqCst);
        seq
    }
    /// The entries after `*seen`; true if some were overwritten before they were read
    unsafe fn drain(
        next: *mut u32,
        ring: *mut u64,
        size: usize,
        seen: *mut u32,
        out: &mut Vec<u32>,
    ) -> bool {
        let current = (*(next as *const AtomicU32)).load(SeqCst);
        let first = *seen;
        *seen = current;
        let count = current.wrapping_sub(first);
        if count == 0 {
            return false;
        }
        if count as usize > size {
            return true;
        }
        for i in 1..=count {
            let seq = first.wrapping_add(i);
            let slot = ring.add(seq as usize % size);
            loop {
                let entry = (*(slot as *const AtomicU64)).load(SeqCst);
                let tag = (entry >> 32) as u32;
                if tag == seq {
                    out.push(entry as u32);
                    break;
                }
                if (tag.wrapping_sub(seq) as i32) > 0 {
                    return true; // overwritten by a later round of the ring
                }
                // the writer reserved this sequence number and stores the entry next
                std::hint::spin_loop();
            }
        }
        false
    }
}

#[inline(always)]
pub unsafe fn and8(p: *mut u8, bits: u8) {
    #[cfg(feature = "parallel")]
    {
        (*(p as *const AtomicU8)).fetch_and(bits, SeqCst);
    }
    #[cfg(not(feature = "parallel"))]
    {
        *p &= bits
    }
}
