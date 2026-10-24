//! The ARM core's physical address space (docs/arm64-virt-android16-plan.md
//! P1.5; the JIT plan's `Bus`): 64-bit physical addresses up to the
//! profile's 40 bits, guest RAM from 0x4000_0000 at backing offset 0 of
//! guest memory (mem8), and regions of ROM (read-only backing), MMIO (with
//! the owner that handles it, also above 4 GiB) and holes. Unlike the x86
//! core's physical bus there is no VGA hole and no 4 GiB split; an access
//! never spans regions (it faults instead, writing nothing).
//!
//! Every write to RAM goes through `write` or `written` (CPU stores, DC
//! ZVA, store-exclusive, DMA, the loader and snapshot restore), which retire
//! code compiled from the page (crate::jitrt::watch, and with cores in
//! workers crate::parallel::code). A change of the map bumps the generation
//! and drops all compiled code and cached translations.
//!
//! Device memory (P7.1: virtio-gpu's host visible memory) is guest memory
//! a device owns, from DEVICE_START in the backing (after RAM and the ROMs),
//! mapped where its BAR is: the cores read and write it as RAM, but their
//! writes mark its pages (the device takes them, a64_device_take_dirty), and
//! compiled code writes it through the interpreter's path (the access cache
//! is not filled for it).
//!
//! Extended RAM (P8.5: RAM beyond the one allocation of guest memory) is a
//! region at or above 4 GiB that crate::aarch64::extended keeps (a host store
//! cached in frames): the cores read and write it a page at a time, code is
//! compiled from it under its own code keys (from EXTENDED_CODE_KEY on), the
//! access cache is not filled for it.
//!
//! With cores in workers (P8.2), the map is the machine instance's: a
//! worker keeps a copy (`sync_worker`), taken again when the machine's
//! generation changes; the machine changes it under MAP_SEQ (odd while
//! changing), so that a copy made meanwhile is made again. Device memory's
//! marks are the machine's words, set and taken atomically.
//!
//! JavaScript passes 64-bit addresses as two 32-bit halves (low, high).

use crate::page::Page;

/// Guest RAM's base
pub const RAM_BASE: u64 = 0x4000_0000;
/// The physical address range of profile v86-aarch64-v1 (40 bits)
pub const PA_LIMIT: u64 = 1 << 40;
/// The largest access: a Q register (larger SIMD accesses are split into these)
pub const MAX_ACCESS: u32 = 16;
/// The largest probe (DC ZVA, an exclusive pair): one 64-byte granule
pub const MAX_PROBE: u64 = 64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// read-only backing at `backing` in guest memory
    Rom { backing: u32 },
    /// a device: its accesses go to the owner (src/virt), offset from the region's base
    Mmio { owner: u32 },
    /// device memory at `backing` (at or above DEVICE_START): guest memory whose written pages are marked
    Device { backing: u32 },
    /// extended RAM (crate::aarch64::extended)
    Extended,
}

/// The code key of extended RAM's first page (the keys of guest memory are
/// its pages, below 2 GiB)
pub const EXTENDED_CODE_KEY: u32 = 1 << 20;

/// What a physical address is
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lookup {
    /// guest memory at `backing` (RAM, or ROM when not `writable`); compiled
    /// code from it is watched under `code_key`
    Ram {
        backing: u32,
        code_key: u32,
        writable: bool,
    },
    Mmio {
        owner: u32,
        offset: u64,
    },
    /// extended RAM: `page` from its start
    Extended {
        page: u32,
    },
    Hole,
}

/// A synchronous external abort or (beyond the PA range) an address size fault
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Fault {
    External,
    AddressSize,
}

#[derive(Clone, Copy)]
struct Region {
    base: u64,
    size: u64,
    kind: Kind,
}

pub struct AddressSpace {
    ram_size: u64,
    /// the non-RAM regions, sorted by base, not overlapping
    regions: Vec<Region>,
    generation: u32,
}

static mut BUS: AddressSpace = AddressSpace {
    ram_size: 0,
    regions: Vec::new(),
    generation: 0,
};
/// Guest memory's base in the Wasm memory (crate::aarch64::root's Env.mem8)
pub static mut MEM8: *mut u8 = std::ptr::null_mut();
/// The bytes of guest memory (RAM and the ROMs after it)
pub static mut MEM8_SIZE: u32 = 0;
/// Where device memory starts in guest memory (u32::MAX: there is none)
pub static mut DEVICE_START: u32 = u32::MAX;
/// One bit per 4 KiB page of device memory, from DEVICE_START: written by a core since its device took it
static mut DEVICE_DIRTY: Vec<u64> = Vec::new();
/// The words a64_device_take_dirty hands out
static mut DEVICE_TAKEN: Vec<u64> = Vec::new();

#[inline(always)]
pub fn bus() -> &'static AddressSpace { unsafe { &*(&raw const BUS) } }

/// The bus behind compiled code's access cache (jitrt::access::Bus,
/// docs/jit-unification-plan.md P5.8; the A64 page tier is J2): writable
/// RAM only, never ROM, a device or a hole
impl crate::jitrt::access::Bus for AddressSpace {
    fn ram_backing(&self, physical: u64) -> Option<u32> {
        match self.lookup(physical & !4095) {
            Lookup::Ram {
                backing,
                writable: true,
                ..
            } => Some(backing),
            _ => None,
        }
    }
}
#[inline(always)]
fn bus_mut() -> &'static mut AddressSpace { unsafe { &mut *(&raw mut BUS) } }

impl AddressSpace {
    #[inline(always)]
    pub fn ram_size(&self) -> u64 { self.ram_size }
    #[inline(always)]
    pub fn generation(&self) -> u32 { self.generation }

    /// What `pa` is
    #[inline]
    pub fn lookup(&self, pa: u64) -> Lookup {
        let offset = pa.wrapping_sub(RAM_BASE);
        if offset < self.ram_size {
            return Lookup::Ram {
                backing: offset as u32,
                code_key: (offset >> 12) as u32,
                writable: true,
            };
        }
        match self.region_of(pa) {
            Some(r) => match r.kind {
                Kind::Rom { backing } => {
                    let at = backing + (pa - r.base) as u32;
                    Lookup::Ram {
                        backing: at,
                        code_key: at >> 12,
                        writable: false,
                    }
                },
                Kind::Mmio { owner } => Lookup::Mmio {
                    owner,
                    offset: pa - r.base,
                },
                Kind::Device { backing } => {
                    let at = backing + (pa - r.base) as u32;
                    Lookup::Ram {
                        backing: at,
                        code_key: at >> 12,
                        writable: true,
                    }
                },
                Kind::Extended => Lookup::Extended {
                    page: ((pa - r.base) >> 12) as u32,
                },
            },
            None => Lookup::Hole,
        }
    }

    fn region_of(&self, pa: u64) -> Option<&Region> {
        let i = self.regions.partition_point(|r| r.base <= pa);
        let r = self.regions.get(i.checked_sub(1)?)?;
        (pa - r.base < r.size).then_some(r)
    }

    /// The region (RAM, a ROM, a device) holding all of [pa, pa + len), or a
    /// fault: a hole, beyond the PA range, or more than one region
    pub fn span(&self, pa: u64, len: u64) -> Result<Lookup, Fault> {
        debug_assert!(len >= 1);
        let last = pa.checked_add(len - 1).ok_or(Fault::AddressSize)?;
        if last >= PA_LIMIT {
            return Err(Fault::AddressSize);
        }
        let first = self.lookup(pa);
        let end = self.lookup(last);
        match (first, end) {
            (
                Lookup::Ram {
                    backing: a,
                    writable: wa,
                    ..
                },
                Lookup::Ram {
                    backing: b,
                    writable: wb,
                    ..
                },
            ) if wa == wb && b.wrapping_sub(a) as u64 == len - 1 => Ok(first),
            (
                Lookup::Mmio {
                    owner: a,
                    offset: o,
                },
                Lookup::Mmio {
                    owner: b,
                    offset: p,
                },
            ) if a == b && p - o == len - 1 => Ok(first),
            (Lookup::Extended { .. }, Lookup::Extended { .. }) => Ok(first),
            _ => Err(Fault::External),
        }
    }

    /// The code key of the page `pa` is on, if it is guest memory
    pub fn code_key(&self, pa: u64) -> Option<u32> {
        match self.lookup(pa) {
            Lookup::Ram { code_key, .. } => Some(code_key),
            Lookup::Extended { page } => Some(EXTENDED_CODE_KEY + page),
            _ => None,
        }
    }

    fn map(&mut self, base: u64, size: u64, kind: Kind) -> bool {
        let Some(end) = base.checked_add(size)
        else {
            return false;
        };
        if size == 0 || end > PA_LIMIT {
            return false;
        }
        // (not over RAM or another region)
        if base < RAM_BASE + self.ram_size && end > RAM_BASE {
            return false;
        }
        let i = self.regions.partition_point(|r| r.base < base);
        if self.regions.get(i).is_some_and(|r| r.base < end)
            || i > 0 && self.regions[i - 1].base + self.regions[i - 1].size > base
        {
            return false;
        }
        if let Kind::Rom { backing } = kind {
            if backing as u64 + size > unsafe { MEM8_SIZE } as u64 {
                return false;
            }
        }
        if kind == Kind::Extended && (base | size) & 0xFFF != 0 {
            return false;
        }
        if let Kind::Device { backing } = kind {
            if backing < unsafe { DEVICE_START }
                || backing as u64 + size > unsafe { MEM8_SIZE } as u64
                || (backing | size as u32) & 0xFFF != 0
            {
                return false;
            }
        }
        self.regions.insert(i, Region { base, size, kind });
        self.changed();
        true
    }

    fn unmap(&mut self, base: u64) -> bool {
        let Some(i) = self.regions.iter().position(|r| r.base == base)
        else {
            return false;
        };
        self.regions.remove(i);
        self.changed();
        true
    }

    /// The map changed: translations and compiled code that cached it go
    fn changed(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        run_map_hooks();
    }
}

fn run_map_hooks() {
    for hook in unsafe { &*(&raw const MAP_CHANGED) } {
        hook();
    }
}

/// (cores in workers) odd while the machine instance changes its map
static mut MAP_SEQ: u32 = 0;

/// Change the machine's map (`change`), so that workers copying it meanwhile notice
fn mutate<T>(change: impl FnOnce(&mut AddressSpace) -> T) -> T {
    let seq = &raw mut MAP_SEQ;
    unsafe {
        crate::parallel::word_store(seq, *seq | 1);
        let result = change(bus_mut());
        crate::parallel::word_store(seq, (*seq | 1).wrapping_add(1));
        result
    }
}

/// A worker's copy of the machine's map and guest memory (P8.2): at its
/// attachment, after a stop, and when the machine's generation changed
pub unsafe fn sync_worker() {
    let machine = &*crate::parallel::machine(&raw mut BUS);
    let seq = crate::parallel::machine(&raw mut MAP_SEQ);
    MEM8 = *crate::parallel::machine(&raw mut MEM8);
    MEM8_SIZE = *crate::parallel::machine(&raw mut MEM8_SIZE);
    DEVICE_START = *crate::parallel::machine(&raw mut DEVICE_START);
    let b = bus_mut();
    loop {
        let before = crate::parallel::word_load(seq);
        if before & 1 != 0 {
            std::hint::spin_loop();
            continue;
        }
        // (the machine's Vec may be changing: its length is checked, a torn copy made again)
        let (pointer, length) = (machine.regions.as_ptr(), machine.regions.len());
        if length <= 4096 {
            b.regions.clear();
            b.regions
                .extend_from_slice(std::slice::from_raw_parts(pointer, length));
            b.ram_size = machine.ram_size;
            b.generation = machine.generation;
        }
        if crate::parallel::word_load(seq) == before && length <= 4096 {
            WORKER_SEQ = before;
            break;
        }
    }
    run_map_hooks();
}

/// The machine's MAP_SEQ when the worker's copy was made
static mut WORKER_SEQ: u32 = 0;
/// (cores in workers, each slice) copy the map again if the machine changed it
#[inline]
pub unsafe fn sync_worker_if_stale() {
    if crate::parallel::word_load(crate::parallel::machine(&raw mut MAP_SEQ)) != WORKER_SEQ {
        sync_worker();
    }
}

/// Called when the map changes (the TLB, compiled code: crate::aarch64::root)
static mut MAP_CHANGED: Vec<fn()> = Vec::new();
pub fn on_map_changed(hook: fn()) { unsafe { (*(&raw mut MAP_CHANGED)).push(hook) } }

#[cfg(target_arch = "wasm32")]
mod js {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn a64_mmio_read(owner: u32, offset: u64, size: u32) -> u64;
        pub fn a64_mmio_write(owner: u32, offset: u64, size: u32, value: u64);
    }
}
// (cargo test: a device that reads its offset and keeps the last write)
#[cfg(not(target_arch = "wasm32"))]
mod js {
    pub static mut LAST_WRITE: (u32, u64, u32, u64) = (0, 0, 0, 0);
    pub unsafe fn a64_mmio_read(owner: u32, offset: u64, size: u32) -> u64 {
        offset ^ (owner as u64) << 32 ^ (size as u64) << 48
    }
    pub unsafe fn a64_mmio_write(owner: u32, offset: u64, size: u32, value: u64) {
        LAST_WRITE = (owner, offset, size, value)
    }
}

#[inline(always)]
unsafe fn host(backing: u32) -> *mut u8 { MEM8.add(backing as usize) }

/// A write of the running core reached guest memory at `backing` (len
/// bytes, within one page or across pages): retire code compiled from the
/// pages, clear other cores' exclusive reservations of its granules
#[inline]
pub fn written(backing: u32, len: u32) {
    if len == 0 {
        return;
    }
    if backing >= unsafe { DEVICE_START } {
        device_written(backing, len);
    }
    crate::aarch64::smp::monitors_written(backing, len, false);
    retire_code(backing, len);
}

/// A core wrote device memory: its pages are marked (the machine's words)
#[cold]
fn device_written(backing: u32, len: u32) {
    let dirty = unsafe { &*crate::parallel::machine(&raw mut DEVICE_DIRTY) };
    let start = unsafe { DEVICE_START };
    for page in (backing - start) >> 12..=(backing - start + (len - 1)) >> 12 {
        if (page as usize / 64) < dirty.len() {
            unsafe {
                crate::parallel::or64(
                    dirty.as_ptr().add(page as usize / 64) as *mut u8,
                    1 << (page % 64),
                )
            };
        }
    }
}

/// Retire code compiled from the pages of [backing, backing + len), by
/// this core and (cores in workers) the others
#[inline]
fn retire_code(backing: u32, len: u32) {
    let first = backing >> 12;
    let last = (backing + (len - 1)) >> 12;
    for page in first..=last {
        if crate::aarch64::root::page_watched(page) {
            let lo = if page == first { backing & 0xFFF } else { 0 };
            let hi = if page == last { ((backing + (len - 1)) & 0xFFF) + 1 } else { 0x1000 };
            crate::aarch64::root::dirty_bytes(Page::page_of(page << 12), lo, hi);
            unsafe { crate::parallel::code::written(page) };
        }
    }
}

/// The owners of the devices the ARM core decodes itself (the GIC's
/// distributor and redistributors, P4.2); src/virt's owners count from 1
pub const OWNER_GICD: u32 = 0xFFFF_0000;
pub const OWNER_GICR: u32 = 0xFFFF_0001;
/// (a GICv2's CPU interface)
pub const OWNER_GICC: u32 = 0xFFFF_0002;

#[inline(always)]
unsafe fn mmio_read(owner: u32, offset: u64, size: u32) -> u64 {
    match owner {
        OWNER_GICD => crate::aarch64::gic::gicd_read(offset, size),
        OWNER_GICR => crate::aarch64::gic::gicr_read(offset, size),
        OWNER_GICC => crate::aarch64::gic::gicc_read(offset, size),
        _ => js::a64_mmio_read(owner, offset, size),
    }
}

#[inline(always)]
unsafe fn mmio_write(owner: u32, offset: u64, size: u32, value: u64) {
    match owner {
        OWNER_GICD => crate::aarch64::gic::gicd_write(offset, size, value),
        OWNER_GICR => crate::aarch64::gic::gicr_write(offset, size, value),
        OWNER_GICC => crate::aarch64::gic::gicc_write(offset, size, value),
        _ => js::a64_mmio_write(owner, offset, size, value),
    }
}

/// Map the GIC's frames for `cores` cores (the machine's devices, P4.2)
#[no_mangle]
pub unsafe fn a64_set_cores(cores: u32) -> bool {
    let cores = (cores as usize).clamp(1, crate::isa::MAX_CORES);
    *crate::parallel::machine(&raw mut crate::aarch64::isa_hooks::CORE_COUNT) = cores;
    let v2 = crate::aarch64::gic::is_v2();
    mutate(|b| {
        b.unmap(crate::aarch64::gic::GICD_BASE);
        b.unmap(crate::aarch64::gic::GICR_BASE);
        b.unmap(crate::aarch64::gic::GICC_BASE);
        b.map(
            crate::aarch64::gic::GICD_BASE,
            crate::aarch64::gic::GICD_SIZE,
            Kind::Mmio { owner: OWNER_GICD },
        ) && if v2 {
            // (a GICv2: its CPU interface, no redistributors)
            b.map(
                crate::aarch64::gic::GICC_BASE,
                crate::aarch64::gic::GICC_SIZE,
                Kind::Mmio { owner: OWNER_GICC },
            )
        }
        else {
            b.map(
                crate::aarch64::gic::GICR_BASE,
                crate::aarch64::gic::GICR_STRIDE * cores as u64,
                Kind::Mmio { owner: OWNER_GICR },
            )
        }
    })
}

/// Read `size` bytes (1, 2, 4, 8) at `pa`, little-endian
pub unsafe fn read(pa: u64, size: u32) -> Result<u64, Fault> {
    debug_assert!(matches!(size, 1 | 2 | 4 | 8));
    match bus().span(pa, size as u64)? {
        Lookup::Ram { backing, .. } => {
            let p = host(backing);
            Ok(match size {
                1 => crate::parallel::load8(p) as u64,
                2 => crate::parallel::load16(p) as u64,
                4 => crate::parallel::load32(p) as u64,
                _ => crate::parallel::load64(p),
            })
        },
        Lookup::Mmio { owner, offset } => Ok(mmio_read(owner, offset, size)),
        Lookup::Extended { .. } => Ok(crate::aarch64::extended::read(pa, size)),
        Lookup::Hole => Err(Fault::External),
    }
}

/// Write `size` bytes (1, 2, 4, 8) at `pa`, little-endian; a write to ROM is ignored
pub unsafe fn write(pa: u64, size: u32, value: u64) -> Result<(), Fault> {
    debug_assert!(matches!(size, 1 | 2 | 4 | 8));
    match bus().span(pa, size as u64)? {
        Lookup::Ram {
            backing, writable, ..
        } => {
            if writable {
                let p = host(backing);
                match size {
                    1 => crate::parallel::store8(p, value as u8),
                    2 => crate::parallel::store16(p, value as u16),
                    4 => crate::parallel::store32(p, value as u32),
                    _ => crate::parallel::store64(p, value),
                }
                written(backing, size);
            }
            Ok(())
        },
        Lookup::Mmio { owner, offset } => {
            mmio_write(owner, offset, size, value);
            Ok(())
        },
        Lookup::Extended { .. } => {
            crate::aarch64::extended::write(pa, size, value);
            Ok(())
        },
        Lookup::Hole => Err(Fault::External),
    }
}

/// Read a Q register's 16 bytes at `pa` (a device sees two 8-byte reads)
pub unsafe fn read128(pa: u64) -> Result<u128, Fault> {
    match bus().span(pa, 16)? {
        Lookup::Ram { backing, .. } => {
            let [lo, hi] = crate::parallel::load128(host(backing));
            Ok(lo as u128 | (hi as u128) << 64)
        },
        Lookup::Mmio { owner, offset } => {
            let lo = mmio_read(owner, offset, 8);
            let hi = mmio_read(owner, offset + 8, 8);
            Ok(lo as u128 | (hi as u128) << 64)
        },
        Lookup::Extended { .. } => {
            let lo = crate::aarch64::extended::read(pa, 8);
            let hi = crate::aarch64::extended::read(pa + 8, 8);
            Ok(lo as u128 | (hi as u128) << 64)
        },
        Lookup::Hole => Err(Fault::External),
    }
}

/// Write a Q register's 16 bytes at `pa`, all or nothing
pub unsafe fn write128(pa: u64, value: u128) -> Result<(), Fault> {
    match bus().span(pa, 16)? {
        Lookup::Ram {
            backing, writable, ..
        } => {
            if writable {
                crate::parallel::store128(host(backing), [value as u64, (value >> 64) as u64]);
                written(backing, 16);
            }
            Ok(())
        },
        Lookup::Mmio { owner, offset } => {
            mmio_write(owner, offset, 8, value as u64);
            mmio_write(owner, offset + 8, 8, (value >> 64) as u64);
            Ok(())
        },
        Lookup::Extended { .. } => {
            let _guard = crate::extended::Guard::new();
            crate::aarch64::extended::write(pa, 8, value as u64);
            crate::aarch64::extended::write(pa + 8, 8, (value >> 64) as u64);
            Ok(())
        },
        Lookup::Hole => Err(Fault::External),
    }
}

/// Whether [pa, pa + len) (at most 64 bytes) is one region of guest memory
/// that may be written, where (DC ZVA, a store-exclusive pair) an access
/// completes at once: its backing
pub fn probe_writable(pa: u64, len: u64) -> Result<Option<u32>, Fault> {
    debug_assert!(len >= 1 && len <= MAX_PROBE);
    Ok(match bus().span(pa, len)? {
        Lookup::Ram {
            backing,
            writable: true,
            ..
        } => Some(backing),
        Lookup::Hole => return Err(Fault::External),
        _ => None,
    })
}

const fn pa(low: u32, high: u32) -> u64 { low as u64 | (high as u64) << 32 }

/// Guest memory of `size` bytes (RAM first, then any ROM backing): its
/// address in the Wasm memory. Once, before the RAM is mapped.
#[no_mangle]
pub unsafe fn a64_allocate_memory(size: u32) -> u32 {
    assert!(MEM8.is_null(), "a64_allocate_memory: already allocated");
    let memory = vec![0u8; size as usize].leak();
    MEM8 = memory.as_mut_ptr();
    MEM8_SIZE = size;
    MEM8 as u32
}

/// RAM of `size` bytes at 0x4000_0000, backed by the start of guest memory
#[no_mangle]
pub unsafe fn a64_bus_set_ram(size: u32) -> bool {
    if size > MEM8_SIZE
        || bus()
            .regions
            .iter()
            .any(|r| r.base < RAM_BASE + size as u64 && r.base + r.size > RAM_BASE)
    {
        return false;
    }
    mutate(|b| {
        b.ram_size = size as u64;
        b.changed();
    });
    true
}

/// Map a device's registers (`owner`, src/virt) at [base, base + size)
#[no_mangle]
pub unsafe fn a64_bus_map_mmio(
    base_low: u32,
    base_high: u32,
    size_low: u32,
    size_high: u32,
    owner: u32,
) -> bool {
    mutate(|b| {
        b.map(
            pa(base_low, base_high),
            pa(size_low, size_high),
            Kind::Mmio { owner },
        )
    })
}
/// Map read-only guest memory at [base, base + size), from `backing`
#[no_mangle]
pub unsafe fn a64_bus_map_rom(
    base_low: u32,
    base_high: u32,
    size_low: u32,
    size_high: u32,
    backing: u32,
) -> bool {
    mutate(|b| {
        b.map(
            pa(base_low, base_high),
            pa(size_low, size_high),
            Kind::Rom { backing },
        )
    })
}
/// Device memory from `start` to the end of guest memory (once, after
/// a64_allocate_memory; `start` page aligned, at or after the RAM's end)
#[no_mangle]
pub unsafe fn a64_device_memory(start: u32) -> bool {
    if start & 0xFFF != 0 || start > MEM8_SIZE || (start as u64) < bus().ram_size {
        return false;
    }
    DEVICE_START = start;
    let pages = (MEM8_SIZE - start).div_ceil(4096) as usize;
    *(&raw mut DEVICE_DIRTY) = vec![0; pages.div_ceil(64)];
    true
}
/// Map device memory at [base, base + size), from `backing` (page aligned, device memory)
#[no_mangle]
pub unsafe fn a64_bus_map_device(
    base_low: u32,
    base_high: u32,
    size_low: u32,
    size_high: u32,
    backing: u32,
) -> bool {
    mutate(|b| {
        b.map(
            pa(base_low, base_high),
            pa(size_low, size_high),
            Kind::Device { backing },
        )
    })
}
/// Take the marks of the pages of [backing, backing + size) of device
/// memory (backing 256 KiB aligned from DEVICE_START): the address of words
/// with a bit a page, the first page bit 0 of the first word, 64 a word;
/// 0 when none was written. The marks clear.
#[no_mangle]
pub unsafe fn a64_device_take_dirty(backing: u32, size: u32) -> u32 {
    take_device_dirty(backing, size).map_or(0, |words| words.as_ptr() as u32)
}
unsafe fn take_device_dirty(backing: u32, size: u32) -> Option<&'static [u64]> {
    let dirty = &mut *(&raw mut DEVICE_DIRTY);
    let taken = &mut *(&raw mut DEVICE_TAKEN);
    let offset = backing.checked_sub(DEVICE_START)?;
    debug_assert!(offset % (64 * 4096) == 0);
    let first = (offset >> 18) as usize;
    let count = (size.div_ceil(4096) as usize).div_ceil(64);
    taken.clear();
    let mut any = false;
    for i in first..(first + count).min(dirty.len()) {
        // (cores in workers mark them meanwhile)
        let word = crate::parallel::swap64(&raw mut dirty[i], 0);
        any |= word != 0;
        taken.push(word);
    }
    any.then_some(&taken[..])
}
/// Mark every page of [backing, backing + size) of device memory written
#[no_mangle]
pub unsafe fn a64_device_mark_dirty(backing: u32, size: u32) {
    if backing >= DEVICE_START && size != 0 {
        device_written(backing, size);
    }
}
/// Map extended RAM at [base, base + size) (crate::aarch64::extended)
pub fn map_extended(base: u64, size: u64) -> bool { mutate(|b| b.map(base, size, Kind::Extended)) }

/// Unmap the region at `base`
#[no_mangle]
pub unsafe fn a64_bus_unmap(base_low: u32, base_high: u32) -> bool {
    mutate(|b| b.unmap(pa(base_low, base_high)))
}
#[no_mangle]
pub fn a64_bus_generation() -> u32 { bus().generation() }

/// What `pa` is: 0 a hole, 1 RAM, 2 ROM, 3 MMIO, 4 extended RAM
/// (a64_bus_lookup_detail: the backing, the owner or the extended page)
#[no_mangle]
pub fn a64_bus_lookup(pa_low: u32, pa_high: u32) -> u32 {
    match bus().lookup(pa(pa_low, pa_high)) {
        Lookup::Hole => 0,
        Lookup::Ram { writable: true, .. } => 1,
        Lookup::Ram { .. } => 2,
        Lookup::Mmio { .. } => 3,
        Lookup::Extended { .. } => 4,
    }
}
#[no_mangle]
pub fn a64_bus_lookup_detail(pa_low: u32, pa_high: u32) -> f64 {
    match bus().lookup(pa(pa_low, pa_high)) {
        Lookup::Hole => -1.0,
        Lookup::Ram { backing, .. } => backing as f64,
        Lookup::Mmio { owner, .. } => owner as f64,
        Lookup::Extended { page } => page as f64,
    }
}
/// The code key of `pa`'s page, -1 when it is not guest memory
#[no_mangle]
pub fn a64_bus_code_key(pa_low: u32, pa_high: u32) -> i32 {
    bus()
        .code_key(pa(pa_low, pa_high))
        .map_or(-1, |key| key as i32)
}

/// A read through the bus (tests, the debugger): the value, or with
/// a64_bus_status 1 an external abort, 2 an address size fault
static mut STATUS: u32 = 0;
#[no_mangle]
pub fn a64_bus_status() -> u32 { unsafe { STATUS } }
fn status(result: Result<(), Fault>) {
    unsafe {
        STATUS = match result {
            Ok(()) => 0,
            Err(Fault::External) => 1,
            Err(Fault::AddressSize) => 2,
        }
    }
}
#[no_mangle]
pub unsafe fn a64_bus_read(pa_low: u32, pa_high: u32, size: u32) -> u64 {
    let result = read(pa(pa_low, pa_high), size);
    status(result.map(|_| ()));
    result.unwrap_or(0)
}
#[no_mangle]
pub unsafe fn a64_bus_write(pa_low: u32, pa_high: u32, size: u32, value: u64) -> u32 {
    status(write(pa(pa_low, pa_high), size, value));
    STATUS
}
/// JavaScript wrote guest memory at [backing, backing + len) (the loader,
/// snapshot restore, a device's DMA): retire code compiled from it
#[no_mangle]
pub fn a64_bus_written(backing: u32, len: u32) {
    // (a device's write: every core's reservation of the granules clears)
    if len != 0 {
        crate::aarch64::smp::monitors_written(backing, len, true);
        retire_code(backing, len);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe fn setup(ram: u32, extra: u32) {
        let b = bus_mut();
        b.regions.clear();
        b.ram_size = 0;
        MEM8 = std::ptr::null_mut();
        DEVICE_START = u32::MAX;
        a64_allocate_memory(ram + extra);
        assert!(a64_bus_set_ram(ram));
    }

    /// Device memory (P7.1): read and written as RAM where it is mapped,
    /// the pages the cores write marked, a device's own writes not
    #[test]
    fn device_memory() {
        unsafe {
            setup(1 << 20, 1 << 20);
            let start = 1 << 20;
            assert!(
                !a64_bus_map_device(0, 0x80, 0x40000, 0, start),
                "no device memory yet"
            );
            assert!(a64_device_memory(start));
            assert!(
                !a64_bus_map_device(0, 0x80, 0x40000, 0, 0x1000),
                "RAM is no device memory"
            );
            assert!(a64_bus_map_device(0, 0x80, 0x80000, 0, start + 0x40000));
            let take = || take_device_dirty(start + 0x40000, 0x80000).map(|words| words.to_vec());
            assert_eq!(take(), None, "nothing written yet");
            assert_eq!(write(0x80_0000_1008, 8, 0x1122_3344_5566_7788), Ok(()));
            assert_eq!(
                write(0x80_0004_5ffe, 4, 0xAABB_CCDD),
                Ok(()),
                "across two pages"
            );
            assert_eq!(read(0x80_0000_1008, 8), Ok(0x1122_3344_5566_7788));
            assert_eq!(*host(start + 0x40000 + 0x100c), 0x44, "at its backing");
            assert_eq!(
                take(),
                Some(vec![1 << 1, 1 << 5 | 1 << 6]),
                "pages 1, 0x45 and 0x46"
            );
            assert_eq!(take(), None, "taken: clear");
            // (a device's own writes, through JavaScript, are not marked)
            a64_bus_written(start + 0x40000, 4096);
            assert_eq!(take(), None);
            a64_device_mark_dirty(start + 0x40000 + 0x2000, 1);
            assert_eq!(take(), Some(vec![1 << 2, 0]));
            assert!(a64_bus_unmap(0, 0x80));
            assert_eq!(bus().lookup(0x80_0000_1008), Lookup::Hole);
        }
    }

    #[test]
    fn address_space() {
        unsafe {
            setup(1 << 20, 0x10000);
            let b = bus();
            assert_eq!(
                b.lookup(RAM_BASE),
                Lookup::Ram {
                    backing: 0,
                    code_key: 0,
                    writable: true
                }
            );
            assert_eq!(
                b.lookup(RAM_BASE + 0x1234),
                Lookup::Ram {
                    backing: 0x1234,
                    code_key: 1,
                    writable: true
                }
            );
            assert_eq!(b.lookup(RAM_BASE + (1 << 20)), Lookup::Hole);
            assert_eq!(b.lookup(0), Lookup::Hole);
            // a 0x200 window inside a 128 KiB block, and devices above 4 GiB
            let generation = b.generation();
            assert!(a64_bus_map_mmio(0x0a00_0200, 0, 0x200, 0, 7));
            assert!(a64_bus_map_mmio(0x0a00_0400, 0, 0x200, 0, 8));
            assert!(a64_bus_map_mmio(0x1000_0000, 0x40, 0x1000_0000, 0, 9));
            assert!(a64_bus_map_mmio(0, 0x80, 0x1000, 0, 10));
            assert_ne!(b.generation(), generation);
            assert!(!a64_bus_map_mmio(0x0a00_0300, 0, 0x200, 0, 11), "overlap");
            assert!(!a64_bus_map_mmio(0x4000_0000, 0, 0x1000, 0, 11), "over RAM");
            assert!(!a64_bus_map_mmio(0, 0x100, 0x1000, 0, 11), "beyond 40 bits");
            assert_eq!(b.lookup(0x0a00_01ff), Lookup::Hole);
            assert_eq!(
                b.lookup(0x0a00_0200),
                Lookup::Mmio {
                    owner: 7,
                    offset: 0
                }
            );
            assert_eq!(
                b.lookup(0x0a00_03ff),
                Lookup::Mmio {
                    owner: 7,
                    offset: 0x1ff
                }
            );
            assert_eq!(
                b.lookup(0x0a00_0400),
                Lookup::Mmio {
                    owner: 8,
                    offset: 0
                }
            );
            assert_eq!(
                b.lookup(0x40_1000_0010),
                Lookup::Mmio {
                    owner: 9,
                    offset: 0x10
                }
            );
            assert_eq!(
                b.lookup(0x80_0000_0fff),
                Lookup::Mmio {
                    owner: 10,
                    offset: 0xfff
                }
            );
            // 16-bit and 64-bit device accesses
            assert_eq!(read(0x0a00_0204, 2), Ok(0x4 ^ 7 << 32 ^ 2 << 48));
            write(0x80_0000_0008, 8, 0x1122_3344_5566_7788).unwrap();
            assert_eq!(
                *&raw const js::LAST_WRITE,
                (10, 8, 8, 0x1122_3344_5566_7788)
            );
            // RAM
            write(RAM_BASE + 8, 8, 0x0102_0304_0506_0708).unwrap();
            assert_eq!(read(RAM_BASE + 8, 4), Ok(0x0506_0708));
            assert_eq!(read(RAM_BASE + 12, 2), Ok(0x0304));
            write128(RAM_BASE + 0x100, 0xAAAA_BBBB_CCCC_DDDD_EEEE_FFFF_0000_1111).unwrap();
            assert_eq!(
                read128(RAM_BASE + 0x100),
                Ok(0xAAAA_BBBB_CCCC_DDDD_EEEE_FFFF_0000_1111)
            );
            // an access over the end of RAM faults and writes nothing
            let end = RAM_BASE + (1 << 20);
            write(end - 8, 8, 0).unwrap();
            assert_eq!(write(end - 4, 8, u64::MAX), Err(Fault::External));
            assert_eq!(read(end - 8, 8), Ok(0));
            assert_eq!(
                read(0x0a00_03fe, 4),
                Err(Fault::External),
                "across two devices"
            );
            assert_eq!(read(1 << 40, 1), Err(Fault::AddressSize));
            assert_eq!(read(0x0900_0000, 4), Err(Fault::External));
            // ROM: reads its backing, ignores writes; its own code keys
            assert!(a64_bus_map_rom(0, 0, 0x10000, 0, 1 << 20));
            *MEM8.add((1 << 20) + 4) = 0x5a;
            assert_eq!(read(4, 1), Ok(0x5a));
            write(4, 1, 0).unwrap();
            assert_eq!(read(4, 1), Ok(0x5a));
            assert_eq!(b.code_key(0x2000), Some(((1 << 20) + 0x2000) >> 12));
            assert_eq!(b.code_key(0x0a00_0200), None);
            // probes
            assert_eq!(probe_writable(RAM_BASE + 0x40, 64), Ok(Some(0x40)));
            assert_eq!(probe_writable(0x40, 64), Ok(None));
            assert_eq!(probe_writable(end - 32, 64), Err(Fault::External));
            assert!(a64_bus_unmap(0x0a00_0200, 0));
            assert_eq!(b.lookup(0x0a00_0200), Lookup::Hole);
        }
    }

    /// A fill of a page-function access cache (the JIT plan's jac, as
    /// x64::pages::x64_page_access does): a guest page resolved to a host
    /// pointer and a code key, valid while the generation stays
    #[test]
    fn access_cache_fill() {
        unsafe {
            setup(1 << 16, 0);
            struct Entry {
                page: u64,
                host: *mut u8,
                code_key: u32,
                generation: u32,
            }
            let fill = |pa: u64| match bus().span(pa & !0xFFF, 0x1000) {
                Ok(Lookup::Ram {
                    backing,
                    code_key,
                    writable: true,
                }) => Some(Entry {
                    page: pa & !0xFFF,
                    host: host(backing),
                    code_key,
                    generation: bus().generation(),
                }),
                _ => None,
            };
            let entry = fill(RAM_BASE + 0x3008).unwrap();
            assert_eq!(entry.page, RAM_BASE + 0x3000);
            assert_eq!(entry.code_key, 3);
            *entry.host.add(8) = 0x77;
            assert_eq!(read(RAM_BASE + 0x3008, 1), Ok(0x77));
            assert!(fill(0x0900_0000).is_none());
            a64_bus_map_mmio(0x0900_0000, 0, 0x1000, 0, 1);
            assert_ne!(
                entry.generation,
                bus().generation(),
                "the map changed: the entry is stale"
            );
        }
    }
}
