//! Wide linear accesses. Validate every touched page before device reads or
//! writes; one element of an atomic/string operation is a complete transaction.
use super::paging::{Access, Controls, Tlb, WalkMode};
use super::state::LinearAddress;
use super::{paging, physical, state};
use crate::cpu::{apic, global_pointers as gp};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Fault {
    pub vector: u8,
    pub error: Option<u32>,
    pub address: Option<u64>,
}
impl Fault {
    pub fn gp() -> Self {
        Self {
            vector: 13,
            error: Some(0),
            address: None,
        }
    }
    pub fn ud() -> Self {
        Self {
            vector: 6,
            error: None,
            address: None,
        }
    }
    pub fn de() -> Self {
        Self {
            vector: 0,
            error: None,
            address: None,
        }
    }
}
static mut X64_TLBS: [Tlb; 8] = [const { Tlb::new() }; 8];

/// A locked instruction in progress while cores run in workers
/// (crate::parallel): its first memory read is the read-modify-write operand,
/// read from RAM, and the write to the same bytes commits with a
/// compare-exchange. If another core changed the operand in between, the
/// instruction runs again from its saved registers.
#[derive(Clone, Copy)]
struct LockedOperand {
    address: u64,
    size: usize,
    backing: u32,
    old: u128,
}
/// (`extended`: the operand is in extended RAM, whose lock the instruction
/// holds until it ends, crate::x64::extended)
struct Locked {
    operand: Option<LockedOperand>,
    conflict: bool,
    extended: bool,
}
static mut LOCKED: Option<Locked> = None;

pub unsafe fn run_locked(mut instruction: impl FnMut() -> Result<(), Fault>) -> Result<(), Fault> {
    #[cfg(feature = "parallel")]
    {
        let saved = crate::parallel::Registers::save();
        loop {
            LOCKED = Some(Locked {
                operand: None,
                conflict: false,
                extended: false,
            });
            let result = instruction();
            let locked = (*(&raw mut LOCKED)).take();
            if locked.as_ref().is_some_and(|locked| locked.extended) {
                super::extended::unlock();
            }
            let conflict = locked.is_some_and(|locked| locked.conflict);
            if !conflict || result.is_err() {
                return result;
            }
            saved.restore();
        }
    }
    #[cfg(not(feature = "parallel"))]
    instruction()
}

/// The operand read of a locked instruction, if it is in RAM
unsafe fn locked_read(address: u64, size: usize, stack: bool) -> Result<Option<u128>, Fault> {
    let Some(locked) = &mut *(&raw mut LOCKED)
    else {
        return Ok(None);
    };
    if locked.operand.is_some() {
        return Ok(None);
    }
    // (a locked operand is checked for writing before it is read)
    let span = preflight(address, size, Access::Write, stack, false)?;
    let Some(backing) =
        (if span.contiguous() { physical::ram_backing(span.first, size) } else { None })
    else {
        // in extended RAM, the instruction is atomic under that module's lock
        if !locked.extended && super::extended::contains(span.first) {
            super::extended::begin_locked_operand();
            locked.extended = true;
        }
        return Ok(None);
    };
    let old = match size {
        1 => crate::cpu::memory::read8_no_mmap_check(backing) as u8 as u128,
        2 => crate::cpu::memory::read16_no_mmap_check(backing) as u16 as u128,
        4 => crate::cpu::memory::read32_no_mmap_check(backing) as u32 as u128,
        8 => crate::cpu::memory::read64_no_mmap_check(backing) as u128,
        _ => {
            crate::cpu::memory::read64_no_mmap_check(backing) as u128
                | (crate::cpu::memory::read64_no_mmap_check(backing + 8) as u128) << 64
        },
    };
    locked.operand = Some(LockedOperand {
        address,
        size,
        backing,
        old,
    });
    Ok(Some(old))
}

/// The operand write of a locked instruction: true if it was the operand
unsafe fn locked_write(address: u64, size: usize, value: u128) -> bool {
    let Some(locked) = &mut *(&raw mut LOCKED)
    else {
        return false;
    };
    let Some(operand) = locked.operand
    else {
        return false;
    };
    if operand.address != address || operand.size != size {
        return false;
    }
    crate::jit::jit_dirty_cache_small(operand.backing, operand.backing + size as u32);
    let at = crate::cpu::memory::mem8.add(operand.backing as usize);
    let committed = if size == 16 {
        crate::parallel::compare_exchange128(at, operand.old, value)
    }
    else {
        crate::parallel::compare_exchange(at, size as u32, operand.old as u64, value as u64)
    };
    locked.conflict |= !committed;
    true
}
// Compiled-code access cache entries derive from these TLBs: retire them too.
pub unsafe fn invalidate_all_tlbs() {
    for core in 0..8 {
        X64_TLBS[core].clear();
    }
    super::jac::flush_all();
}
pub unsafe fn invalidate_core(core: usize) {
    X64_TLBS[core].clear();
    super::jac::flush(core);
}
/// MOV CR3 with CR4.PGE: translations of global pages survive (in the TLB,
/// the access cache and the chaining table).
pub unsafe fn invalidate_core_nonglobal(core: usize) {
    X64_TLBS[core].clear_nonglobal();
    super::jac::flush_nonglobal(core);
    super::pages::forget_nonglobal_code(core);
}
pub unsafe fn invlpg(address: u64) {
    super::pages::COUNTERS[super::pages::COUNT_INVLPG] += 1;
    let core = apic::current_core();
    X64_TLBS[core].invalidate(LinearAddress(address));
    super::jac::invlpg(core, address);
    super::pages::forget_code_page(core, address);
}

/// Compilation observes the same stale translations as execution, but never
/// fills a cache, updates A/D, reads an MMIO page table, or delivers a fault.
pub unsafe fn snapshot_translation(address: u64, access: Access) -> Option<paging::Translation> {
    let controls = Controls {
        cr3: state::read_cr(3),
        user: *gp::cpl == 3,
        write_protect: state::read_cr(0) & 0x10000 != 0,
        nx_enable: state::efer() & state::EFER_NXE != 0,
    };
    X64_TLBS[apic::current_core()]
        .lookup(LinearAddress(address), access, controls)
        .or_else(|| {
            paging::walk(
                &mut physical::PageTables,
                LinearAddress(address),
                access,
                controls,
                WalkMode::Snapshot,
            )
            .ok()
        })
}

// Snapshot transfer buffers are host-owned allocations (v86_malloc/free), not
// guest physical addresses. Each valid record contains 18 portable DWORDs;
// zero records restores an empty cache. All callers run at a CPU safe point.
#[no_mangle]
pub unsafe extern "C" fn x64_tlb_snapshot_dwords(core: u32) -> i32 {
    if core >= 8 {
        return -1;
    }
    X64_TLBS[core as usize].snapshot().len() as i32
}

#[no_mangle]
pub unsafe extern "C" fn x64_tlb_snapshot_write(core: u32, data: u32, capacity: u32) -> i32 {
    if core >= 8 {
        return -1;
    }
    let records = X64_TLBS[core as usize].snapshot();
    if (capacity as usize) < records.len() || !records.is_empty() && (data == 0 || data & 3 != 0) {
        return -1;
    }
    if !records.is_empty() {
        std::ptr::copy_nonoverlapping(records.as_ptr(), data as *mut u32, records.len());
    }
    records.len() as i32
}

unsafe fn snapshot_records<'a>(data: u32, count: u32) -> Option<&'a [u32]> {
    if count as usize > paging::TLB_CAPACITY * paging::TLB_SNAPSHOT_DWORDS
        || count as usize % paging::TLB_SNAPSHOT_DWORDS != 0
    {
        return None;
    }
    if count == 0 {
        return Some(&[]);
    }
    if data == 0 || data & 3 != 0 {
        return None;
    }
    Some(std::slice::from_raw_parts(
        data as *const u32,
        count as usize,
    ))
}

#[no_mangle]
pub unsafe extern "C" fn x64_tlb_snapshot_validate(data: u32, count: u32) -> bool {
    snapshot_records(data, count).is_some_and(|records| Tlb::new().restore_snapshot(records))
}

#[no_mangle]
pub unsafe extern "C" fn x64_tlb_snapshot_restore(core: u32, data: u32, count: u32) -> bool {
    if core >= 8 {
        return false;
    }
    let restored = snapshot_records(data, count)
        .is_some_and(|records| X64_TLBS[core as usize].restore_snapshot(records));
    if restored {
        super::jac::flush(core as usize);
    }
    restored
}

/// A data translation for the access cache (x64::jac): the physical address,
/// and whether it comes from a large page (conservatively true if the TLB
/// did not keep the entry).
/// translate_page for instruction fetch
pub unsafe fn translate_page_execute(address: u64) -> Result<(u64, bool, bool), Fault> {
    translate_page(address, Access::Execute)
}
/// Also whether it is global (else conservatively false): kept by MOV CR3.
pub unsafe fn translate_page(address: u64, access: Access) -> Result<(u64, bool, bool), Fault> {
    let physical = translate(address, access, false, false)?;
    let c = Controls {
        cr3: state::read_cr(3),
        user: *gp::cpl == 3,
        write_protect: state::read_cr(0) & 0x10000 != 0,
        nx_enable: state::efer() & state::EFER_NXE != 0,
    };
    let t = X64_TLBS[apic::current_core()].lookup(LinearAddress(address), access, c);
    Ok((
        physical,
        t.map_or(true, |t| t.page_shift > 12),
        t.is_some_and(|t| t.global),
    ))
}
pub unsafe fn translate(
    address: u64,
    access: Access,
    stack: bool,
    supervisor: bool,
) -> Result<u64, Fault> {
    translate_user(address, access, stack, !supervisor && *gp::cpl == 3)
}
/// In compatibility mode, x64 translations fill the 32-bit TLB too
/// (cpu::fill_ia32e_tlb) when compiled 32-bit code reads it: the page
/// tier's (x64_page_compat32 with x64_compat_tlb, pagegen::Emitter::host_tlb;
/// the region tiers' until M11)
unsafe fn compat_tlb() -> bool { super::pages::compat32() && super::pagegen::compat_tlb() }
pub unsafe fn translate_user(
    address: u64,
    access: Access,
    stack: bool,
    user: bool,
) -> Result<u64, Fault> {
    if !state::canonical(address, 48) {
        return Err(Fault {
            vector: if stack { 12 } else { 13 },
            error: Some(0),
            address: None,
        });
    }
    let c = Controls {
        cr3: state::read_cr(3),
        user,
        write_protect: state::read_cr(0) & 0x10000 != 0,
        nx_enable: state::efer() & state::EFER_NXE != 0,
    };
    let cache = &mut X64_TLBS[apic::current_core()];
    if let Some(physical) = cache.lookup_physical(LinearAddress(address), access, c) {
        if *gp::x64_cs_long == 0 && compat_tlb() {
            crate::cpu::cpu::fill_ia32e_tlb(address as u32, physical, access, user);
        }
        return Ok(physical);
    }
    super::pages::COUNTERS[super::pages::COUNT_WALKS] += 1;
    let result = paging::walk(
        &mut physical::PageTables,
        LinearAddress(address),
        access,
        c,
        WalkMode::Runtime,
    )
    .map_err(|fault| match fault {
        paging::Fault::Page { address, error, .. } => Fault {
            vector: 14,
            error: Some(error),
            address: Some(address.0),
        },
        paging::Fault::NonCanonical(_) => Fault {
            vector: if stack { 12 } else { 13 },
            error: Some(0),
            address: None,
        },
        paging::Fault::Unavailable(_) => Fault::gp(),
    })?;
    cache.insert(LinearAddress(address), access, c, result);
    // compatibility mode: 32-bit linear addresses, served to compiled code too
    if *gp::x64_cs_long == 0 && compat_tlb() {
        crate::cpu::cpu::fill_ia32e_tlb(address as u32, result.physical.0, access, user);
    }
    Ok(result.physical.0)
}

/// Physical bytes of one linear access: `head` bytes from `first`, the rest
/// from `second` when the access crosses a page.
#[derive(Clone, Copy)]
struct Span {
    first: u64,
    second: u64,
    head: usize,
    size: usize,
}
impl Span {
    fn byte(&self, i: usize) -> u64 {
        if i < self.head {
            self.first + i as u64
        }
        else {
            self.second + (i - self.head) as u64
        }
    }
    fn contiguous(&self) -> bool {
        self.head == self.size || self.second == self.first + self.head as u64
    }
}
unsafe fn preflight(
    address: u64,
    size: usize,
    access: Access,
    stack: bool,
    supervisor: bool,
) -> Result<Span, Fault> {
    assert!(matches!(size, 1 | 2 | 4 | 8 | 16));
    let first = translate(address, access, stack, supervisor)?;
    // Page order: the first page's bus check precedes the second page's walk.
    let head = size.min(4096 - (address & 4095) as usize);
    physical::probe(first, head).map_err(|_| Fault::gp())?;
    let mut second = 0;
    if head < size {
        second = translate(address.wrapping_add(head as u64), access, stack, supervisor)?;
        physical::probe(second, size - head).map_err(|_| Fault::gp())?;
    }
    Ok(Span {
        first,
        second,
        head,
        size,
    })
}
fn read_physical(span: Span) -> Result<u128, Fault> {
    unsafe {
        if span.contiguous() {
            let at = span.first;
            return match span.size {
                1 => physical::read8(at).map(|v| v as u128),
                2 => physical::read16(at).map(|v| v as u128),
                4 => physical::read32(at).map(|v| v as u128),
                8 => physical::read64(at).map(|v| v as u128),
                16 => {
                    let lo = physical::read64(at).map_err(|_| Fault::gp())?;
                    let hi = physical::read64(at + 8).map_err(|_| Fault::gp())?;
                    return Ok(lo as u128 | (hi as u128) << 64);
                },
                _ => unreachable!(),
            }
            .map_err(|_| Fault::gp());
        }
        let mut value = 0;
        for i in 0..span.size {
            value |= (physical::read8(span.byte(i)).map_err(|_| Fault::gp())? as u128) << (i * 8);
        }
        Ok(value)
    }
}
fn write_physical(span: Span, value: u128) -> Result<(), Fault> {
    unsafe {
        if span.contiguous() {
            let at = span.first;
            return match span.size {
                1 => physical::write8(at, value as u8),
                2 => physical::write16(at, value as u16),
                4 => physical::write32(at, value as u32),
                8 => physical::write64(at, value as u64),
                16 => {
                    physical::write64(at, value as u64).map_err(|_| Fault::gp())?;
                    return physical::write64(at + 8, (value >> 64) as u64)
                        .map_err(|_| Fault::gp());
                },
                _ => unreachable!(),
            }
            .map_err(|_| Fault::gp());
        }
        for i in 0..span.size {
            physical::write8(span.byte(i), (value >> (i * 8)) as u8).map_err(|_| Fault::gp())?;
        }
        Ok(())
    }
}
pub unsafe fn read(address: u64, width: u8, stack: bool) -> Result<u64, Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    if let Some(value) = locked_read(address, size, stack)? {
        return Ok(value as u64);
    }
    let value = read_physical(preflight(address, size, Access::Read, stack, false)?)? as u64;
    super::debug::data(address, size, false);
    Ok(value)
}
pub unsafe fn write(address: u64, width: u8, value: u64, stack: bool) -> Result<(), Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    if locked_write(address, size, value as u128) {
        return Ok(());
    }
    write_physical(
        preflight(address, size, Access::Write, stack, false)?,
        value as u128,
    )?;
    super::debug::data(address, size, true);
    Ok(())
}
pub unsafe fn read128(address: u64, stack: bool) -> Result<u128, Fault> {
    if let Some(value) = locked_read(address, 16, stack)? {
        return Ok(value);
    }
    let value = read_physical(preflight(address, 16, Access::Read, stack, false)?)?;
    super::debug::data(address, 16, false);
    Ok(value)
}
pub unsafe fn write128(address: u64, value: u128, stack: bool) -> Result<(), Fault> {
    if locked_write(address, 16, value) {
        return Ok(());
    }
    write_physical(preflight(address, 16, Access::Write, stack, false)?, value)?;
    super::debug::data(address, 16, true);
    Ok(())
}
pub unsafe fn fetch(address: u64) -> Result<u8, Fault> {
    let address = translate(address, Access::Execute, false, false)?;
    fetch_physical(address)
}
/// An instruction byte outside plain RAM (SMRAM serves code fetches in SMM
/// also with D_CLS: crate::cpu::memory::fetch8)
unsafe fn fetch_physical(address: u64) -> Result<u8, Fault> {
    if address >> 32 == 0 {
        if let Some(ram) = crate::cpu::smm::smram_ram(address as u32, 1, true) {
            return Ok(*crate::cpu::memory::mem8.add(ram as usize));
        }
    }
    physical::read8(address).map_err(|_| Fault::gp())
}
/// Instruction fetch within one decode: `page` remembers the last linear to
/// physical code page, so each page is translated once per instruction.
pub unsafe fn fetch_cached(address: u64, page: &mut Option<(u64, u64)>) -> Result<u8, Fault> {
    let physical = match *page {
        Some((linear, physical)) if linear == address >> 12 => physical | (address & 4095),
        _ => {
            let physical = translate(address, Access::Execute, false, false)?;
            *page = Some((address >> 12, physical & !4095));
            physical
        },
    };
    if physical::plain_ram(physical, 1) {
        return Ok(*crate::cpu::memory::mem8.add(physical as usize));
    }
    fetch_physical(physical)
}
pub unsafe fn read_system(address: u64, width: u8) -> Result<u64, Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    Ok(read_physical(preflight(address, size, Access::Read, false, true)?)? as u64)
}
pub unsafe fn write_system(address: u64, width: u8, value: u64) -> Result<(), Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64));
    let size = (width / 8) as usize;
    write_physical(
        preflight(address, size, Access::Write, true, true)?,
        value as u128,
    )
}

pub unsafe fn probe_write(address: u64, width: u8, stack: bool) -> Result<(), Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64 | 128));
    preflight(address, (width / 8) as usize, Access::Write, stack, false).map(|_| ())
}

pub unsafe fn probe_read(address: u64, width: u8, stack: bool) -> Result<(), Fault> {
    assert!(matches!(width, 8 | 16 | 32 | 64 | 128));
    preflight(address, (width / 8) as usize, Access::Read, stack, false).map(|_| ())
}

pub unsafe fn probe_system_write(address: u64, width: u8) -> Result<(), Fault> {
    preflight(address, (width / 8) as usize, Access::Write, true, true).map(|_| ())
}

/// Bridge compatibility-mode instructions to the wide walker while preserving
/// the legacy memory helper ABI. A remapped page resolves to its backing page;
/// mapping changes flush all translations before this identity can change.
pub unsafe fn legacy_translate(
    address: u32,
    access: Access,
    user: bool,
    side_effects: bool,
) -> Result<u32, ()> {
    let physical = if side_effects {
        match translate_user(address as u64, access, false, user) {
            Ok(address) => address,
            Err(fault) => {
                super::system::raise(fault);
                return Err(());
            },
        }
    }
    else {
        let c = Controls {
            cr3: state::read_cr(3),
            user,
            write_protect: state::read_cr(0) & 0x10000 != 0,
            nx_enable: state::efer() & state::EFER_NXE != 0,
        };
        paging::walk(
            &mut physical::PageTables,
            LinearAddress(address as u64),
            access,
            c,
            WalkMode::Snapshot,
        )
        .map_err(|_| ())?
        .physical
        .0
    };
    physical::resolve_backing(physical).map_err(|_| ())
}
