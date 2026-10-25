//! Virtual memory accesses of the AArch64 core: translation (the stage 1 MMU,
//! mmu.rs; with SCTLR_EL1.M clear an address is its physical address, data
//! accesses are to Device memory and must be aligned) and the accesses
//! themselves through the address space (crate::aarch64::bus). A
//! multi-byte access that faults anywhere writes nothing.

use crate::aarch64::bus::{self, Fault, Lookup};
use crate::aarch64::cpu::{
    self, Exception, FSC_ADDRESS_SIZE_L0, FSC_ALIGNMENT, FSC_EXTERNAL, SCTLR_A, SCTLR_M,
};
use crate::aarch64::mmu;

/// What an access does
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Access {
    Read,
    Write,
    Fetch,
}

/// The data abort syndrome's ISS for an access: whether its ISS is valid
/// (ISV, a single general-purpose register without write-back, as QEMU
/// reports), the access size, sign extension, register, 64-bit register,
/// acquire/release (AR), write
#[derive(Clone, Copy, Default)]
pub struct Syndrome {
    pub valid: bool,
    pub size_log: u32,
    pub signed: bool,
    pub register: u32,
    pub sixty_four: bool,
    pub acquire_release: bool,
    /// a cache maintenance or DC ZVA (CM, reported as a write)
    pub cache: bool,
}

impl Syndrome {
    pub const NONE: Syndrome = Syndrome {
        valid: false,
        size_log: 0,
        signed: false,
        register: 0,
        sixty_four: false,
        acquire_release: false,
        cache: false,
    };
    /// The ISS of a data abort taken to EL1: ISV is 0 for every fault
    /// reported in ESR_EL1 without FEAT_LS64 (DDI 0487 L.b; QEMU likewise),
    /// so only WnR and CM are kept (the rest of the syndrome is for an EL2)
    fn iss(self, write: bool, fsc: u32) -> u32 {
        fsc | (write as u32) << 6 | (self.cache as u32) << 8
    }
}

fn abort(access: Access, va: u64, fsc: u32, syndrome: Syndrome) -> Exception {
    match access {
        Access::Fetch => Exception::InstructionAbort { fsc, far: va },
        _ => Exception::DataAbort {
            iss: syndrome.iss(access == Access::Write, fsc),
            far: va,
        },
    }
}

fn bus_fault(fault: Fault) -> u32 {
    match fault {
        Fault::External => FSC_EXTERNAL,
        Fault::AddressSize => FSC_ADDRESS_SIZE_L0,
    }
}

/// Translate `va` for an access of `size` bytes at the current EL (or EL0
/// for an unprivileged one): the physical address, or the fault. The access
/// must not cross a page (callers split them).
#[inline]
pub fn translate(
    va: u64,
    size: u32,
    access: Access,
    unprivileged: bool,
    syndrome: Syndrome,
) -> Result<u64, Exception> {
    let sctlr = cpu::sctlr();
    let aligned = va & (size as u64 - 1) == 0;
    let el0 = unprivileged || cpu::el() == 0;
    // (a watchpoint fires after translation, before the access; the MMU on or off)
    let watch = |pa: u64| {
        if access != Access::Fetch && unsafe { crate::aarch64::debug::ANY_WATCHPOINT } {
            if let Some(exception) =
                crate::aarch64::debug::check_watchpoint(va, size, access == Access::Write, el0)
            {
                return Err(exception);
            }
        }
        Ok(pa)
    };
    if sctlr & SCTLR_M == 0 {
        // the MMU off: data accesses are to Device memory (always aligned)
        if access != Access::Fetch && !aligned {
            return Err(abort(access, va, FSC_ALIGNMENT, syndrome));
        }
        let pa =
            mmu::mmu_off(va).ok_or_else(|| abort(access, va, FSC_ADDRESS_SIZE_L0, syndrome))?;
        return watch(pa);
    }
    if access != Access::Fetch && sctlr & SCTLR_A != 0 && !aligned {
        return Err(abort(access, va, FSC_ALIGNMENT, syndrome));
    }
    match mmu::translate(va, access, el0, size) {
        Ok(translation) => watch(translation.pa),
        Err(fsc) => Err(abort(access, va, fsc, syndrome)),
    }
}

/// Whether [va, va + size) crosses into the next page
#[inline(always)]
fn crosses_page(va: u64, size: u32) -> bool { (va & 0xFFF) + size as u64 > 0x1000 }

/// An access across a page is unaligned: with the MMU off (Device memory)
/// or SCTLR_EL1.A it is an alignment fault, before either page translates
#[inline]
fn check_split(va: u64, access: Access, syndrome: Syndrome) -> Result<(), Exception> {
    let sctlr = cpu::sctlr();
    if sctlr & SCTLR_M == 0 || sctlr & SCTLR_A != 0 {
        return Err(abort(access, va, FSC_ALIGNMENT, syndrome));
    }
    Ok(())
}

/// Fetch the instruction at `va`: guest memory only (a fetch from a device
/// is an external abort, without reading it)
pub fn fetch(va: u64) -> Result<u32, Exception> {
    let pa = translate(va, 4, Access::Fetch, false, Syndrome::NONE)?;
    match bus::bus().lookup(pa) {
        Lookup::Ram { backing, .. } => {
            Ok(unsafe { crate::parallel::load32(bus::MEM8.add(backing as usize)) })
        },
        Lookup::Extended { .. } => Ok(unsafe { crate::aarch64::extended::fetch(pa) }),
        _ => Err(Exception::InstructionAbort {
            fsc: FSC_EXTERNAL,
            far: va,
        }),
    }
}

/// Read `size` bytes (1, 2, 4, 8) at `va`, little-endian
pub fn read(va: u64, size: u32, unprivileged: bool, syndrome: Syndrome) -> Result<u64, Exception> {
    if crosses_page(va, size) {
        // (an unaligned access across a page: both pages translate first)
        check_split(va, Access::Read, syndrome)?;
        let first = 0x1000 - (va & 0xFFF) as u32;
        let pa_low = translate(va, first, Access::Read, unprivileged, syndrome)?;
        let pa_high = translate(
            va + first as u64,
            size - first,
            Access::Read,
            unprivileged,
            syndrome,
        )?;
        let mut value = 0u64;
        for i in 0..size {
            let pa = if i < first { pa_low + i as u64 } else { pa_high + (i - first) as u64 };
            let byte = unsafe { bus::read(pa, 1) }
                .map_err(|f| abort(Access::Read, va, bus_fault(f), syndrome))?;
            value |= byte << (8 * i);
        }
        return Ok(value);
    }
    let pa = translate(va, size, Access::Read, unprivileged, syndrome)?;
    unsafe { bus::read(pa, size) }.map_err(|f| abort(Access::Read, va, bus_fault(f), syndrome))
}

/// A write, translated (and checked) before anything is written
#[derive(Clone, Copy)]
pub struct Store {
    va: u64,
    size: u32,
    pa_low: u64,
    /// the second page's address when the store crosses a page
    pa_high: Option<u64>,
    syndrome: Syndrome,
}

/// Translate a write of `size` bytes at `va`: it may fault now, then
/// `commit` cannot fail on translation (an external abort from the bus
/// still can, before anything is written)
pub fn prepare_write(
    va: u64,
    size: u32,
    unprivileged: bool,
    syndrome: Syndrome,
) -> Result<Store, Exception> {
    if crosses_page(va, size) {
        check_split(va, Access::Write, syndrome)?;
        let first = 0x1000 - (va & 0xFFF) as u32;
        let pa_low = translate(va, first, Access::Write, unprivileged, syndrome)?;
        let pa_high = translate(
            va + first as u64,
            size - first,
            Access::Write,
            unprivileged,
            syndrome,
        )?;
        for (pa, len) in [(pa_low, first), (pa_high, size - first)] {
            if let Err(fault) = bus::bus().span(pa, len as u64) {
                return Err(abort(Access::Write, va, bus_fault(fault), syndrome));
            }
        }
        return Ok(Store {
            va,
            size,
            pa_low,
            pa_high: Some(pa_high),
            syndrome,
        });
    }
    let pa = translate(va, size, Access::Write, unprivileged, syndrome)?;
    if let Err(fault) = bus::bus().span(pa, size as u64) {
        return Err(abort(Access::Write, va, bus_fault(fault), syndrome));
    }
    Ok(Store {
        va,
        size,
        pa_low: pa,
        pa_high: None,
        syndrome,
    })
}

impl Store {
    /// Write `value` (little-endian)
    pub fn commit(self, value: u64) -> Result<(), Exception> {
        let fail = |f| abort(Access::Write, self.va, bus_fault(f), self.syndrome);
        match self.pa_high {
            None => unsafe { bus::write(self.pa_low, self.size, value) }.map_err(fail),
            Some(pa_high) => {
                let first = 0x1000 - (self.va & 0xFFF) as u32;
                for i in 0..self.size {
                    let pa = if i < first {
                        self.pa_low + i as u64
                    }
                    else {
                        pa_high + (i - first) as u64
                    };
                    unsafe { bus::write(pa, 1, value >> (8 * i) & 0xFF) }.map_err(fail)?;
                }
                Ok(())
            },
        }
    }
}

/// Write `size` bytes at `va` (a single access: nothing is written if it faults)
pub fn write(
    va: u64,
    size: u32,
    value: u64,
    unprivileged: bool,
    syndrome: Syndrome,
) -> Result<(), Exception> {
    prepare_write(va, size, unprivileged, syndrome)?.commit(value)
}
