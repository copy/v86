//! A 36-bit guest physical bus over the existing wasm32 backing store.
//!
//! Guest addresses never become host pointers by truncation. High RAM windows
//! relocate existing backing bytes: their old low physical range becomes a
//! hole in this bus. MMIO windows explicitly decode to an existing 32-bit
//! device address; this does not extend that device's DMA address width.
//!
//! Mapping changes are host operations at a CPU safe point. They invalidate
//! all core translations and shared generated code, never from a memory helper
//! while a compiled frame is active. RAM capacity remains bounded by wasm32.

use crate::cpu::{context, global_pointers, memory};
use crate::x64::state::PhysicalAddress;

pub const PHYSICAL_BITS: u32 = 36;
pub const PHYSICAL_LIMIT: u64 = 1 << PHYSICAL_BITS;
pub const HIGH_MEMORY_BASE: u64 = 1 << 32;
pub const MAX_WINDOWS: usize = 16;
const PAGE_MASK: u64 = 0xFFF;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PhysicalError {
    AddressWidth,
    Unmapped,
    InvalidWindow,
    Overlap,
    SideEffecting,
    Busy,
    GenerationExhausted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WindowKind {
    Ram,
    Mmio,
    /// RAM beyond the wasm32 backing store (crate::x64::extended): no window
    /// has this kind; the bus resolves the extended range to it. It is never
    /// plain RAM for caches, so every access goes through the bus helpers.
    Extended,
}

/// `backing` is an address in the old 32-bit RAM/MMIO bus, not a host pointer
/// and not the low dword of `guest_base`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Window {
    pub guest_base: PhysicalAddress,
    pub backing: u32,
    pub length: u32,
    pub kind: WindowKind,
}

/// A code/page-table snapshot may use this page only while its generation
/// still matches. Code-write dependencies must watch `backing` as well as
/// retain the full guest physical identity; writes still use the bus helpers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RamPage {
    pub guest: PhysicalAddress,
    pub backing: u32,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Resolved {
    backing: u32,
    kind: WindowKind,
}

#[derive(Clone, Copy)]
struct PhysicalBus {
    windows: [Option<Window>; MAX_WINDOWS],
    generation: u64,
}

impl PhysicalBus {
    const fn new() -> Self {
        Self {
            windows: [None; MAX_WINDOWS],
            generation: 1,
        }
    }

    fn validate(&self, slot: usize, window: Window, ram_size: u32) -> Result<(), PhysicalError> {
        if slot >= MAX_WINDOWS
            || window.length == 0
            || window.guest_base.0 < HIGH_MEMORY_BASE
            || (window.guest_base.0 | window.backing as u64 | window.length as u64) & PAGE_MASK != 0
        {
            return Err(PhysicalError::InvalidWindow);
        }
        checked_range(window.guest_base.0, window.length as u64)?;
        let backing_end = window.backing as u64 + window.length as u64;
        if backing_end > HIGH_MEMORY_BASE {
            return Err(PhysicalError::InvalidWindow);
        }
        let backing_is_ram = backing_end <= ram_size as u64
            && !overlaps(window.backing as u64, backing_end, 0xA0000, 0xC0000);
        let backing_is_mmio =
            window.backing >= ram_size || window.backing >= 0xA0000 && backing_end <= 0xC0000;
        if match window.kind {
            WindowKind::Ram => !backing_is_ram,
            WindowKind::Mmio => !backing_is_mmio,
            WindowKind::Extended => true,
        } {
            return Err(PhysicalError::InvalidWindow);
        }
        if let Some((start, end)) = unsafe { super::extended::range() } {
            if overlaps(
                window.guest_base.0,
                window.guest_base.0 + window.length as u64,
                start,
                end,
            ) {
                return Err(PhysicalError::Overlap);
            }
        }
        for (index, other) in self.windows.iter().enumerate() {
            if index == slot {
                continue;
            }
            let Some(other) = other
            else {
                continue;
            };
            if overlaps(
                window.guest_base.0,
                window.guest_base.0 + window.length as u64,
                other.guest_base.0,
                other.guest_base.0 + other.length as u64,
            ) || window.kind == WindowKind::Ram
                && other.kind == WindowKind::Ram
                && overlaps(
                    window.backing as u64,
                    backing_end,
                    other.backing as u64,
                    other.backing as u64 + other.length as u64,
                )
            {
                return Err(PhysicalError::Overlap);
            }
        }
        Ok(())
    }

    fn replace(
        &mut self,
        slot: usize,
        window: Option<Window>,
        ram_size: u32,
    ) -> Result<bool, PhysicalError> {
        if slot >= MAX_WINDOWS {
            return Err(PhysicalError::InvalidWindow);
        }
        if let Some(window) = window {
            self.validate(slot, window, ram_size)?;
        }
        if self.windows[slot] == window {
            return Ok(false);
        }
        let next = self
            .generation
            .checked_add(1)
            .ok_or(PhysicalError::GenerationExhausted)?;
        self.windows[slot] = window;
        self.generation = next;
        Ok(true)
    }

    fn resolve(&self, address: u64, ram_size: u32) -> Result<Resolved, PhysicalError> {
        checked_range(address, 1)?;
        if address < HIGH_MEMORY_BASE {
            // (the extended RAM aperture is not guest physical memory)
            if super::extended::aperture::contains(address as u32) {
                return Err(PhysicalError::Unmapped);
            }
            // A relocated RAM range is absent at its original guest address.
            // Its backing remains accessible only after a high-window lookup.
            for window in self.windows.iter().flatten() {
                if window.kind == WindowKind::Ram
                    && address >= window.backing as u64
                    && address < window.backing as u64 + window.length as u64
                {
                    return Err(PhysicalError::Unmapped);
                }
            }
            return Ok(Resolved {
                backing: address as u32,
                kind: if address >= ram_size as u64
                    || (0xA0000..0xC0000).contains(&address)
                    // (TSEG outside SMM: the legacy bus's all-ones hole)
                    || unsafe { crate::cpu::smm::tseg_blackhole(address as u32) }
                {
                    WindowKind::Mmio
                }
                else {
                    WindowKind::Ram
                },
            });
        }
        for window in self.windows.iter().flatten() {
            if address >= window.guest_base.0
                && address - window.guest_base.0 < window.length as u64
            {
                return Ok(Resolved {
                    backing: (window.backing as u64 + address - window.guest_base.0) as u32,
                    kind: window.kind,
                });
            }
        }
        if unsafe { super::extended::contains(address) } {
            return Ok(Resolved {
                backing: 0,
                kind: WindowKind::Extended,
            });
        }
        Err(PhysicalError::Unmapped)
    }

    fn probe(&self, address: u64, size: usize, ram_size: u32) -> Result<(), PhysicalError> {
        if size == 0 || size > 16 {
            return Err(PhysicalError::InvalidWindow);
        }
        checked_range(address, size as u64)?;
        for offset in 0..size {
            self.resolve(address + offset as u64, ram_size)?;
        }
        Ok(())
    }

    fn ram_page(&self, address: u64, ram_size: u32) -> Result<RamPage, PhysicalError> {
        if address & PAGE_MASK != 0 {
            return Err(PhysicalError::InvalidWindow);
        }
        checked_range(address, 0x1000)?;
        let first = self.resolve(address, ram_size)?;
        let last = self.resolve(address + PAGE_MASK, ram_size)?;
        if first.kind != WindowKind::Ram || last.kind != WindowKind::Ram {
            return Err(PhysicalError::SideEffecting);
        }
        // Windows and the VGA hole have page-aligned boundaries. Checking
        // both ends also excludes a final partial page of the backing RAM.
        if first.backing.checked_add(PAGE_MASK as u32) != Some(last.backing) {
            return Err(PhysicalError::Unmapped);
        }
        Ok(RamPage {
            guest: PhysicalAddress(address),
            backing: first.backing,
            generation: self.generation,
        })
    }

    // Resolve the entire access before any backing read/write. Thus an absent
    // trailing window cannot produce partial RAM writes or a leading MMIO read.
    fn access(
        &self,
        address: u64,
        width: usize,
        ram_size: u32,
    ) -> Result<[Resolved; 8], PhysicalError> {
        if ![1, 2, 4, 8].contains(&width) {
            return Err(PhysicalError::InvalidWindow);
        }
        checked_range(address, width as u64)?;
        let mut bytes = [Resolved {
            backing: 0,
            kind: WindowKind::Ram,
        }; 8];
        for (offset, byte) in bytes.iter_mut().enumerate().take(width) {
            *byte = self.resolve(address + offset as u64, ram_size)?;
        }
        Ok(bytes)
    }
}

// Machine-owned mapping state; no CPU register or TLB state lives here.
static mut PHYSICAL_BUS: PhysicalBus = PhysicalBus::new();

/// A worker instance (crate::parallel) maps the machine's windows. They
/// change only while every worker is stopped, which copies them again.
pub unsafe fn copy_from_machine() {
    PHYSICAL_BUS = *crate::parallel::machine(&raw mut PHYSICAL_BUS);
}

fn checked_range(address: u64, length: u64) -> Result<(), PhysicalError> {
    if length == 0
        || address >= PHYSICAL_LIMIT
        || address
            .checked_add(length - 1)
            .is_none_or(|last| last >= PHYSICAL_LIMIT)
    {
        Err(PhysicalError::AddressWidth)
    }
    else {
        Ok(())
    }
}

fn overlaps(start: u64, end: u64, other_start: u64, other_end: u64) -> bool {
    start < other_end && other_start < end
}

fn contiguous(bytes: &[Resolved]) -> bool {
    let first = bytes[0];
    // (extended RAM has no backing address: see read_allowed and write)
    first.kind != WindowKind::Extended && bytes.iter().enumerate().all(|(offset, byte)| {
        first.backing.checked_add(offset as u32) == Some(byte.backing) && first.kind == byte.kind
            // Keep a fast MMIO access inside one device page. Cross-page or
            // split-window accesses are performed in ascending byte order.
            && (first.kind == WindowKind::Ram || first.backing >> 12 == byte.backing >> 12)
    })
}

/// Mapping generation must accompany any cached RAM view/translation.
pub unsafe fn generation() -> u64 { PHYSICAL_BUS.generation }

/// Portable configuration for snapshots; restoring it uses `restore_windows`
/// so old generation values cannot accidentally revalidate stale code/views.
pub unsafe fn windows() -> [Option<Window>; MAX_WINDOWS] { PHYSICAL_BUS.windows }

/// Validate a complete scalar/SIMD transaction without reading any MMIO byte
/// or committing a RAM write. Adjacent, separately backed windows are valid.
pub unsafe fn probe(address: u64, size: usize) -> Result<(), PhysicalError> {
    // (extended RAM does not overlap any window: see PhysicalBus::validate)
    if size != 0
        && size <= 16
        && (plain_ram(address, size)
            || super::extended::contains(address) && same_page(address, size))
    {
        return Ok(());
    }
    (&*(&raw const PHYSICAL_BUS)).probe(address, size, *global_pointers::memory_size)
}

/// Below the first relocated RAM byte and outside the VGA hole, physical
/// bytes are their own RAM backing: the window search cannot change the
/// result, so hot accesses skip it. Anything else takes the full decode.
#[inline(always)]
pub unsafe fn plain_ram(address: u64, width: usize) -> bool {
    let end = address.wrapping_add(width as u64);
    end >= address && end <= memory::ram_fast_limit as u64 && (end <= 0xA0000 || address >= 0xC0000)
}

/// Resolve one physical byte to the legacy RAM/MMIO bus. This is address
/// decoding, not truncation; callers accessing more than one byte must probe
/// or resolve the complete range first.
pub unsafe fn resolve_backing(address: u64) -> Result<u32, PhysicalError> {
    if plain_ram(address, 1) {
        return Ok(address as u32);
    }
    let resolved = (&*(&raw const PHYSICAL_BUS)).resolve(address, *global_pointers::memory_size)?;
    Ok(match resolved.kind {
        // (a slot of the aperture: extended RAM through the 32-bit bus)
        WindowKind::Extended => super::extended::aperture::map(address),
        _ => resolved.backing,
    })
}

/// The backing address of `size` bytes of RAM at `address` that are
/// contiguous in the backing store, or None (MMIO, holes, split windows)
pub unsafe fn ram_backing(address: u64, size: usize) -> Option<u32> {
    if plain_ram(address, size) {
        return Some(address as u32);
    }
    let bytes = (&*(&raw const PHYSICAL_BUS))
        .access(address, size, *global_pointers::memory_size)
        .ok()?;
    (contiguous(&bytes[..size])
        && bytes[..size]
            .iter()
            .all(|byte| byte.kind == WindowKind::Ram))
    .then_some(bytes[0].backing)
}

/// Called only above the legacy RAM fast limit. A high RAM window removes
/// this range from the low guest bus while keeping its host backing alive.
pub unsafe fn is_low_ram_hole(address: u32) -> bool {
    (&*(&raw const PHYSICAL_BUS))
        .windows
        .iter()
        .flatten()
        .any(|window| {
            window.kind == WindowKind::Ram
                && address >= window.backing
                && (address as u64) < window.backing as u64 + window.length as u64
        })
}

#[no_mangle]
pub unsafe extern "C" fn x64_phys_kind(low: u32, high: u32) -> u32 {
    match (&*(&raw const PHYSICAL_BUS)).resolve(
        (high as u64) << 32 | low as u64,
        *global_pointers::memory_size,
    ) {
        Ok(Resolved {
            kind: WindowKind::Ram,
            ..
        }) => 1,
        Ok(Resolved {
            kind: WindowKind::Mmio,
            ..
        }) => 2,
        Ok(Resolved {
            kind: WindowKind::Extended,
            ..
        }) => 3,
        Err(_) => 0,
    }
}

#[no_mangle]
pub unsafe extern "C" fn x64_phys_resolve(low: u32, high: u32) -> f64 {
    resolve_backing((high as u64) << 32 | low as u64).map_or(-1.0, |value| value as f64)
}

#[no_mangle]
pub unsafe extern "C" fn x64_phys_probe(low: u32, high: u32, size: u32) -> bool {
    probe((high as u64) << 32 | low as u64, size as usize).is_ok()
}

/// Host configuration only, while the CPU is stopped at a machine safe point.
/// kind: 0 removes a window, 1 relocates RAM, 2 aliases a device decode.
#[no_mangle]
pub unsafe extern "C" fn x64_phys_set_window(
    slot: u32,
    low: u32,
    high: u32,
    backing: u32,
    length: u32,
    kind: u32,
) -> bool {
    let window = match kind {
        0 => None,
        1 | 2 => Some(Window {
            guest_base: PhysicalAddress((high as u64) << 32 | low as u64),
            backing,
            length,
            kind: if kind == 1 { WindowKind::Ram } else { WindowKind::Mmio },
        }),
        _ => return false,
    };
    set_window(slot as usize, window).is_ok()
}

/// Fields: guest low, guest high, backing, length, kind (0/1/2).
/// Invalid slot/field returns -1; an empty slot has five zero fields.
#[no_mangle]
pub unsafe extern "C" fn x64_phys_get_window(slot: u32, field: u32) -> f64 {
    if slot as usize >= MAX_WINDOWS || field > 4 {
        return -1.0;
    }
    let Some(window) = PHYSICAL_BUS.windows[slot as usize]
    else {
        return 0.0;
    };
    match field {
        0 => window.guest_base.0 as u32 as f64,
        1 => (window.guest_base.0 >> 32) as f64,
        2 => window.backing as f64,
        3 => window.length as f64,
        4 => {
            if window.kind == WindowKind::Ram {
                1.0
            }
            else {
                2.0
            }
        },
        _ => unreachable!(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn x64_phys_generation(high: bool) -> u32 {
    if high {
        (generation() >> 32) as u32
    }
    else {
        generation() as u32
    }
}

/// Restore all windows in one transaction. `data` must be a host-owned,
/// 4-byte-aligned wasm allocation containing exactly 16 records of 5 u32s:
/// [guest_low, guest_high, backing, length, kind]. The host can use v86_malloc
/// and v86_free for this 320-byte transfer; no guest-memory pointer is accepted
/// by a device path. Kind 0 ignores the other four fields. Invalid contents
/// leave every live mapping and its generation unchanged.
unsafe fn window_records(data: u32, dwords: u32) -> Option<[Option<Window>; MAX_WINDOWS]> {
    if data == 0 || data & 3 != 0 || dwords as usize != MAX_WINDOWS * 5 {
        return None;
    }
    let records = std::slice::from_raw_parts(data as *const u32, MAX_WINDOWS * 5);
    let mut windows = [None; MAX_WINDOWS];
    for (slot, record) in records.chunks_exact(5).enumerate() {
        windows[slot] = match record[4] {
            0 => None,
            1 | 2 => Some(Window {
                guest_base: PhysicalAddress((record[1] as u64) << 32 | record[0] as u64),
                backing: record[2],
                length: record[3],
                kind: if record[4] == 1 { WindowKind::Ram } else { WindowKind::Mmio },
            }),
            _ => return None,
        };
    }
    Some(windows)
}

fn validated_windows(
    windows: [Option<Window>; MAX_WINDOWS],
    ram_size: u32,
) -> Result<PhysicalBus, PhysicalError> {
    let mut candidate = PhysicalBus::new();
    for (slot, window) in windows.into_iter().enumerate() {
        candidate.replace(slot, window, ram_size)?;
    }
    Ok(candidate)
}

/// Parse and validate portable window records without invalidation, generation
/// changes, or other mutation of the running machine.
#[no_mangle]
pub unsafe extern "C" fn x64_phys_validate_windows(data: u32, dwords: u32) -> bool {
    window_records(data, dwords)
        .is_some_and(|windows| validated_windows(windows, *global_pointers::memory_size).is_ok())
}

#[no_mangle]
pub unsafe extern "C" fn x64_phys_restore_windows(data: u32, dwords: u32) -> bool {
    window_records(data, dwords).is_some_and(|windows| restore_windows(windows).is_ok())
}

// f64 keeps every unsigned DWORD exact and reserves -1 for an address error.
// JS can reject invalid guest DMA without confusing it with 0xFFFF_FFFF data.
macro_rules! physical_exports {
    ($read_export:ident, $write_export:ident, $read:ident, $write:ident, $value:ty) => {
        #[no_mangle]
        pub unsafe extern "C" fn $read_export(low: u32, high: u32) -> f64 {
            $read((high as u64) << 32 | low as u64).map_or(-1.0, |value| value as f64)
        }

        #[no_mangle]
        pub unsafe extern "C" fn $write_export(low: u32, high: u32, value: u32) -> bool {
            $write((high as u64) << 32 | low as u64, value as $value).is_ok()
        }
    };
}

physical_exports!(x64_phys_read8, x64_phys_write8, read8, write8, u8);
physical_exports!(x64_phys_read16, x64_phys_write16, read16, write16, u16);
physical_exports!(x64_phys_read32, x64_phys_write32, read32, write32, u32);

/// A page-bounded RAM witness, never an MMIO view or a raw host pointer.
pub unsafe fn ram_page(address: u64) -> Result<RamPage, PhysicalError> {
    if address & PAGE_MASK == 0 && plain_ram(address, 0x1000) {
        return Ok(RamPage {
            guest: PhysicalAddress(address),
            backing: address as u32,
            generation: generation(),
        });
    }
    // (extended RAM is never plain RAM: no window search needed to say so)
    if super::extended::contains(address) {
        return Err(PhysicalError::SideEffecting);
    }
    (&*(&raw const PHYSICAL_BUS)).ram_page(address, *global_pointers::memory_size)
}

/// Replace/remove one high mapping. Caller must be outside any CPU frame,
/// including interpreted I/O callbacks. Active JIT frames are rejected too.
pub unsafe fn set_window(slot: usize, window: Option<Window>) -> Result<(), PhysicalError> {
    if crate::ir::runtime::cache::busy() {
        return Err(PhysicalError::Busy);
    }
    let changed =
        (&mut *(&raw mut PHYSICAL_BUS)).replace(slot, window, *global_pointers::memory_size)?;
    if changed {
        invalidate_mapping();
    }
    Ok(())
}

/// Validate all restored mappings before replacing any live state. The local
/// generation advances instead of trusting a serialized host-cache epoch.
pub unsafe fn restore_windows(windows: [Option<Window>; MAX_WINDOWS]) -> Result<(), PhysicalError> {
    if crate::ir::runtime::cache::busy() {
        return Err(PhysicalError::Busy);
    }
    let mut candidate = validated_windows(windows, *global_pointers::memory_size)?;
    candidate.generation = PHYSICAL_BUS
        .generation
        .checked_add(1)
        .ok_or(PhysicalError::GenerationExhausted)?;
    PHYSICAL_BUS = candidate;
    invalidate_mapping();
    Ok(())
}

/// The chipset changed what the low bus decodes (TSEG, crate::cpu::smm)
/// while cores may run: a new generation for cached RAM views, the fast RAM
/// limit and this instance's translations (cores in workers take the change
/// over at their next slice: crate::cpu::smm::sync_worker). Compiled code
/// stays; what it reads and writes goes through the translations.
pub unsafe fn memory_map_changed() {
    let bus = &mut *(&raw mut PHYSICAL_BUS);
    bus.generation = bus
        .generation
        .checked_add(1)
        .expect("physical bus generation");
    memory::ram_fast_limit = fast_limit();
    context::invalidate_all_tlbs();
    crate::ir::runtime::entry::ir_admission_barrier();
}

/// The first relocated low RAM byte, or the first byte of TSEG (at the top of
/// low RAM), or the end of RAM
unsafe fn fast_limit() -> u32 {
    (&*(&raw const PHYSICAL_BUS))
        .windows
        .iter()
        .flatten()
        .filter(|window| window.kind == WindowKind::Ram)
        .map(|window| window.backing)
        .min()
        .unwrap_or(*global_pointers::memory_size)
        .min(*global_pointers::memory_size)
        .min(crate::cpu::smm::tseg_floor())
}

unsafe fn invalidate_mapping() {
    memory::ram_fast_limit = fast_limit();
    context::invalidate_all_tlbs();
    crate::jit::jit_clear_cache_js();
    crate::ir::runtime::entry::ir_admission_barrier();
}

unsafe fn read_allowed(address: u64, width: usize, allow_mmio: bool) -> Result<u64, PhysicalError> {
    if plain_ram(address, width) {
        return Ok(read_ram(address as u32, width));
    }
    // extended RAM does not overlap any window (see PhysicalBus::validate)
    if super::extended::contains(address) && same_page(address, width) {
        return Ok(super::extended::read(address, width));
    }
    let bytes =
        (&*(&raw const PHYSICAL_BUS)).access(address, width, *global_pointers::memory_size)?;
    if !allow_mmio
        && bytes[..width]
            .iter()
            .any(|byte| byte.kind == WindowKind::Mmio)
    {
        return Err(PhysicalError::SideEffecting);
    }
    if bytes[..width]
        .iter()
        .all(|byte| byte.kind == WindowKind::Extended)
        && same_page(address, width)
    {
        return Ok(super::extended::read(address, width));
    }
    if contiguous(&bytes[..width]) {
        let address = bytes[0].backing;
        if bytes[0].kind == WindowKind::Ram {
            return Ok(read_ram(address, width));
        }
        return Ok(match width {
            1 => memory::read8(address) as u8 as u64,
            2 => memory::read16(address) as u16 as u64,
            4 => memory::read32s(address) as u32 as u64,
            8 => memory::read64s(address) as u64,
            _ => unreachable!(),
        });
    }
    let mut value = 0;
    for (offset, byte) in bytes.iter().enumerate().take(width) {
        let part = match byte.kind {
            WindowKind::Ram => memory::read8_no_mmap_check(byte.backing),
            WindowKind::Mmio => memory::read8(byte.backing),
            WindowKind::Extended => super::extended::read(address + offset as u64, 1) as i32,
        };
        value |= (part as u8 as u64) << (offset * 8);
    }
    Ok(value)
}

fn same_page(address: u64, width: usize) -> bool { address % 4096 + width as u64 <= 4096 }

#[inline(always)]
unsafe fn read_ram(address: u32, width: usize) -> u64 {
    match width {
        1 => memory::read8_no_mmap_check(address) as u8 as u64,
        2 => memory::read16_no_mmap_check(address) as u16 as u64,
        4 => memory::read32_no_mmap_check(address) as u32 as u64,
        // (one access: aligned 8-byte loads are single-copy atomic on x86)
        8 => memory::read64_no_mmap_check(address),
        _ => unreachable!(),
    }
}

#[inline(always)]
unsafe fn write_ram(address: u32, width: usize, value: u64) {
    // Long-mode writes only notify pages with compiled code: the 32-bit IR
    // cannot run meanwhile and validates its snapshots' bytes on publication.
    let last = address.wrapping_add(width as u32 - 1);
    if !crate::jit::page_watched(address >> 12) && !crate::jit::page_watched(last >> 12) {
        match width {
            1 => memory::write8_no_mmap_or_dirty_check(address, value as u8 as i32),
            2 => memory::write16_no_mmap_or_dirty_check(address, value as u16 as i32),
            4 => memory::write32_no_mmap_or_dirty_check(address, value as i32),
            _ => memory::write64_no_mmap_or_dirty_check(address, value),
        }
        return;
    }
    match width {
        1 => memory::write8_ram(address, value as u8 as i32),
        2 => memory::write16_ram(address, value as u16 as i32),
        4 => memory::write32_ram(address, value as i32),
        8 => {
            crate::jit::jit_dirty_bytes_small(address, address + 8);
            memory::write64_no_mmap_or_dirty_check(address, value);
        },
        _ => unreachable!(),
    }
}

/// Set accessed/dirty bits of a long-mode paging entry with a locked OR
/// (another core may change the entry concurrently); `bits` within 0x60
unsafe fn set_entry_bits(address: u64, bits: u64) -> Result<(), PhysicalError> {
    if plain_ram(address, 8) && address & 7 == 0 {
        crate::jit::jit_dirty_cache_small(address as u32, address as u32 + 8);
        crate::parallel::or64(memory::mem8.add(address as usize), bits);
        return Ok(());
    }
    if super::extended::contains(address) && address & 7 == 0 {
        super::extended::or64(address, bits);
        return Ok(());
    }
    let value = read_allowed(address, 8, true)?;
    write(address, 8, value | bits)
}

unsafe fn write(address: u64, width: usize, value: u64) -> Result<(), PhysicalError> {
    if plain_ram(address, width) {
        write_ram(address as u32, width, value);
        return Ok(());
    }
    if super::extended::contains(address) && same_page(address, width) {
        super::extended::write(address, width, value);
        return Ok(());
    }
    let bytes =
        (&*(&raw const PHYSICAL_BUS)).access(address, width, *global_pointers::memory_size)?;
    if bytes[..width]
        .iter()
        .all(|byte| byte.kind == WindowKind::Extended)
        && same_page(address, width)
    {
        super::extended::write(address, width, value);
        return Ok(());
    }
    if contiguous(&bytes[..width]) {
        let address = bytes[0].backing;
        if bytes[0].kind == WindowKind::Ram {
            write_ram(address, width, value);
            return Ok(());
        }
        match width {
            1 => memory::write8(address, value as u8 as i32),
            2 => memory::write16(address, value as u16 as i32),
            4 => memory::write32(address, value as i32),
            8 => {
                // Preserve the existing shared CPU/DMA/debug code-write
                // barrier on both touched backing pages. MMIO also uses two
                // 32-bit transactions, including Rust-owned LAPIC/IOAPIC.
                memory::write32(address, value as i32);
                memory::write32(address + 4, (value >> 32) as i32);
            },
            _ => unreachable!(),
        }
    }
    else {
        for (offset, byte) in bytes.iter().enumerate().take(width) {
            let part = (value >> (offset * 8)) as u8 as i32;
            match byte.kind {
                WindowKind::Ram => memory::write8_ram(byte.backing, part),
                WindowKind::Mmio => memory::write8(byte.backing, part),
                WindowKind::Extended => {
                    super::extended::write(address + offset as u64, 1, part as u64)
                },
            }
        }
    }
    Ok(())
}

pub unsafe fn read8(address: u64) -> Result<u8, PhysicalError> {
    read_allowed(address, 1, true).map(|v| v as u8)
}
pub unsafe fn read16(address: u64) -> Result<u16, PhysicalError> {
    read_allowed(address, 2, true).map(|v| v as u16)
}
pub unsafe fn read32(address: u64) -> Result<u32, PhysicalError> {
    read_allowed(address, 4, true).map(|v| v as u32)
}
pub unsafe fn read64(address: u64) -> Result<u64, PhysicalError> { read_allowed(address, 8, true) }
/// Compiler inspection rejects an access touching any device byte before
/// invoking the backing bus; it neither updates A/D nor delivers a fault.
pub unsafe fn peek64(address: u64) -> Result<u64, PhysicalError> { read_allowed(address, 8, false) }
pub unsafe fn write8(address: u64, value: u8) -> Result<(), PhysicalError> {
    write(address, 1, value as u64)
}
pub unsafe fn write16(address: u64, value: u16) -> Result<(), PhysicalError> {
    write(address, 2, value as u64)
}
pub unsafe fn write32(address: u64, value: u32) -> Result<(), PhysicalError> {
    write(address, 4, value as u64)
}
pub unsafe fn write64(address: u64, value: u64) -> Result<(), PhysicalError> {
    write(address, 8, value)
}

/// Execution and compiler walks use the same full-width address resolution.
pub struct PageTables;
impl crate::x64::paging::PageTableMemory for PageTables {
    fn read_entry(
        &mut self,
        address: PhysicalAddress,
        mode: crate::x64::paging::WalkMode,
    ) -> Option<u64> {
        unsafe {
            match mode {
                crate::x64::paging::WalkMode::Runtime => read64(address.0),
                crate::x64::paging::WalkMode::Snapshot => peek64(address.0),
            }
            .ok()
        }
    }
    /// The walker only sets A (0x20) and D (0x40)
    fn write_entry(&mut self, address: PhysicalAddress, value: u64) -> bool {
        unsafe { set_entry_bits(address.0, value & 0x60).is_ok() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const RAM: u32 = 16 << 20;
    fn ram(guest_base: u64, backing: u32, length: u32) -> Window {
        Window {
            guest_base: PhysicalAddress(guest_base),
            backing,
            length,
            kind: WindowKind::Ram,
        }
    }

    #[test]
    fn high_ram_is_relocated_without_low_dword_aliasing() {
        let mut bus = PhysicalBus::new();
        bus.replace(
            0,
            Some(ram(HIGH_MEMORY_BASE + 0x1000, 0x800000, 0x2000)),
            RAM,
        )
        .unwrap();
        assert_eq!(
            bus.resolve(HIGH_MEMORY_BASE + 0x1234, RAM).unwrap().backing,
            0x800234
        );
        assert_eq!(bus.resolve(0x1234, RAM).unwrap().backing, 0x1234);
        assert_eq!(bus.resolve(0x800234, RAM), Err(PhysicalError::Unmapped));
        assert_eq!(
            bus.resolve(HIGH_MEMORY_BASE + 0x3000, RAM),
            Err(PhysicalError::Unmapped)
        );
        bus.replace(0, None, RAM).unwrap();
        assert_eq!(bus.resolve(0x800234, RAM).unwrap().backing, 0x800234);
    }

    #[test]
    fn full_access_obeys_the_36_bit_limit_and_does_not_wrap() {
        assert_eq!(checked_range(PHYSICAL_LIMIT - 8, 8), Ok(()));
        for (address, length) in [
            (PHYSICAL_LIMIT - 7, 8),
            (PHYSICAL_LIMIT, 1),
            (u64::MAX, 2),
            (0, 0),
        ] {
            assert_eq!(
                checked_range(address, length),
                Err(PhysicalError::AddressWidth)
            );
        }
        let mut bus = PhysicalBus::new();
        bus.replace(0, Some(ram(PHYSICAL_LIMIT - 0x1000, 0x800000, 0x1000)), RAM)
            .unwrap();
        assert_eq!(
            bus.access(PHYSICAL_LIMIT - 8, 8, RAM).unwrap()[7].backing,
            0x800FFF
        );
        assert_eq!(
            bus.access(PHYSICAL_LIMIT - 7, 8, RAM),
            Err(PhysicalError::AddressWidth)
        );
    }

    #[test]
    fn crossing_four_gib_resolves_both_sides_before_backing_access() {
        let mut bus = PhysicalBus::new();
        assert_eq!(
            bus.access(HIGH_MEMORY_BASE - 4, 8, RAM),
            Err(PhysicalError::Unmapped)
        );
        bus.replace(0, Some(ram(HIGH_MEMORY_BASE, 0x800000, 0x1000)), RAM)
            .unwrap();
        let access = bus.access(HIGH_MEMORY_BASE - 4, 8, RAM).unwrap();
        assert_eq!(access[3].backing, u32::MAX);
        assert_eq!(access[4].backing, 0x800000);
        assert!(!contiguous(&access));
    }

    #[test]
    fn split_windows_and_low_ram_mmio_edges_disable_wide_fast_access() {
        let mut bus = PhysicalBus::new();
        bus.replace(0, Some(ram(HIGH_MEMORY_BASE, 0x800000, 0x1000)), RAM)
            .unwrap();
        assert_eq!(
            bus.access(HIGH_MEMORY_BASE + 0xFFD, 8, RAM),
            Err(PhysicalError::Unmapped)
        );
        bus.replace(
            1,
            Some(ram(HIGH_MEMORY_BASE + 0x1000, 0x900000, 0x1000)),
            RAM,
        )
        .unwrap();
        let access = bus.access(HIGH_MEMORY_BASE + 0xFFD, 8, RAM).unwrap();
        assert_eq!(access[2].backing, 0x800FFF);
        assert_eq!(access[3].backing, 0x900000);
        assert!(!contiguous(&access));
        assert!(!contiguous(&bus.access(0x9FFFE, 4, RAM).unwrap()[..4]));
        assert!(!contiguous(
            &bus.access(RAM as u64 - 2, 4, RAM).unwrap()[..4]
        ));
    }

    #[test]
    fn mmio_aliases_are_explicit_and_preserve_a_contiguous_register_access() {
        let mut bus = PhysicalBus::new();
        let window = Window {
            guest_base: PhysicalAddress(HIGH_MEMORY_BASE + 0x10000),
            backing: 0xFEE00000,
            length: 0x1000,
            kind: WindowKind::Mmio,
        };
        bus.replace(0, Some(window), RAM).unwrap();
        let access = bus.access(window.guest_base.0 + 0xF0, 4, RAM).unwrap();
        assert_eq!(
            access[0],
            Resolved {
                backing: 0xFEE000F0,
                kind: WindowKind::Mmio
            }
        );
        assert!(contiguous(&access[..4]));
        assert_eq!(bus.resolve(0xFEE000F0, RAM).unwrap(), access[0]);
    }

    #[test]
    fn mapping_validation_rejects_invalid_backing_overlap_and_alignment_atomically() {
        let mut bus = PhysicalBus::new();
        let first = ram(HIGH_MEMORY_BASE, 0x800000, 0x2000);
        bus.replace(0, Some(first), RAM).unwrap();
        let before = bus.generation;
        for invalid in [
            ram(HIGH_MEMORY_BASE + 1, 0x900000, 0x1000),
            ram(HIGH_MEMORY_BASE + 0x4000, RAM, 0x1000),
            ram(HIGH_MEMORY_BASE + 0x4000, 0x9F000, 0x2000),
            ram(HIGH_MEMORY_BASE + 0x4000, 0x900000, 0),
        ] {
            assert_eq!(
                bus.replace(1, Some(invalid), RAM),
                Err(PhysicalError::InvalidWindow)
            );
            assert_eq!(bus.generation, before);
        }
        assert_eq!(
            bus.replace(
                1,
                Some(ram(HIGH_MEMORY_BASE + 0x1000, 0x900000, 0x1000)),
                RAM
            ),
            Err(PhysicalError::Overlap)
        );
        assert_eq!(
            bus.replace(
                1,
                Some(ram(HIGH_MEMORY_BASE + 0x4000, 0x801000, 0x1000)),
                RAM
            ),
            Err(PhysicalError::Overlap)
        );
        assert_eq!(bus.windows[0], Some(first));
        assert_eq!(bus.windows[1], None);
    }

    #[test]
    fn epochs_advance_only_on_changes_and_never_reuse_an_exhausted_generation() {
        let mut bus = PhysicalBus::new();
        let window = Some(ram(HIGH_MEMORY_BASE, 0x800000, 0x1000));
        assert_eq!(bus.replace(0, window, RAM), Ok(true));
        assert_eq!(bus.generation, 2);
        assert_eq!(bus.replace(0, window, RAM), Ok(false));
        assert_eq!(bus.generation, 2);
        bus.generation = u64::MAX;
        assert_eq!(
            bus.replace(0, None, RAM),
            Err(PhysicalError::GenerationExhausted)
        );
        assert_eq!(bus.windows[0], window);
    }

    #[test]
    fn vector_probe_checks_a_missing_second_half_and_allows_separate_windows() {
        let mut bus = PhysicalBus::new();
        bus.replace(0, Some(ram(HIGH_MEMORY_BASE, 0x800000, 0x1000)), RAM)
            .unwrap();
        assert_eq!(bus.probe(HIGH_MEMORY_BASE + 0xFF8, 8, RAM), Ok(()));
        assert_eq!(
            bus.probe(HIGH_MEMORY_BASE + 0xFF8, 16, RAM),
            Err(PhysicalError::Unmapped)
        );
        bus.replace(
            1,
            Some(ram(HIGH_MEMORY_BASE + 0x1000, 0x900000, 0x1000)),
            RAM,
        )
        .unwrap();
        assert_eq!(bus.probe(HIGH_MEMORY_BASE + 0xFF8, 16, RAM), Ok(()));
        assert_eq!(
            bus.probe(PHYSICAL_LIMIT - 8, 16, RAM),
            Err(PhysicalError::AddressWidth)
        );
    }

    #[test]
    fn ram_witness_preserves_full_identity_and_changes_epoch_with_backing() {
        let mut bus = PhysicalBus::new();
        bus.replace(0, Some(ram(HIGH_MEMORY_BASE, 0x800000, 0x1000)), RAM)
            .unwrap();
        let first = bus.ram_page(HIGH_MEMORY_BASE, RAM).unwrap();
        assert_eq!(first.guest, PhysicalAddress(HIGH_MEMORY_BASE));
        assert_eq!(first.backing, 0x800000);
        assert_eq!(
            bus.ram_page(0xA0000, RAM),
            Err(PhysicalError::SideEffecting)
        );
        assert_eq!(
            bus.ram_page(0xFEE00000, RAM),
            Err(PhysicalError::SideEffecting)
        );
        bus.replace(0, Some(ram(HIGH_MEMORY_BASE, 0x900000, 0x1000)), RAM)
            .unwrap();
        let second = bus.ram_page(HIGH_MEMORY_BASE, RAM).unwrap();
        assert_eq!(second.guest, first.guest);
        assert_eq!(second.backing, 0x900000);
        assert!(second.generation > first.generation);
    }
}
