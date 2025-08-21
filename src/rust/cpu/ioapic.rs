// http://download.intel.com/design/chipsets/datashts/29056601.pdf

use crate::cpu::{apic, global_pointers::acpi_enabled};
use std::sync::{Mutex, MutexGuard};

const IOAPIC_LOG_VERBOSE: bool = false;

const IOREGSEL: u32 = 0;
const IOWIN: u32 = 0x10;

const IOAPIC_IRQ_COUNT: usize = 24;

const IOAPIC_FIRST_IRQ_REG: u32 = 0x10;
const IOAPIC_LAST_IRQ_REG: u32 = 0x10 + 2 * IOAPIC_IRQ_COUNT as u32;

const IOAPIC_ID: u32 = 0; // must match value in seabios

pub const IOAPIC_CONFIG_TRIGGER_MODE_LEVEL: u32 = 1 << 15;

const IOAPIC_CONFIG_MASKED: u32 = 1 << 16;
const IOAPIC_CONFIG_DELIVS: u32 = 1 << 12;
const IOAPIC_CONFIG_REMOTE_IRR: u32 = 1 << 14;
const IOAPIC_CONFIG_READONLY_MASK: u32 =
    IOAPIC_CONFIG_REMOTE_IRR | IOAPIC_CONFIG_DELIVS | 0xFFFE0000;

const IOAPIC_DELIVERY_FIXED: u8 = 0;
const IOAPIC_DELIVERY_LOWEST_PRIORITY: u8 = 1;
const _IOAPIC_DELIVERY_NMI: u8 = 4;
const _IOAPIC_DELIVERY_INIT: u8 = 5;

const DELIVERY_MODES: [&str; 8] = [
    "Fixed (0)",
    "Lowest Prio (1)",
    "SMI (2)",
    "Reserved (3)",
    "NMI (4)",
    "INIT (5)",
    "Reserved (6)",
    "ExtINT (7)",
];

const DESTINATION_MODES: [&str; 2] = ["physical", "logical"];

// keep in sync with cpu.js
#[allow(dead_code)]
const IOAPIC_STRUCT_SIZE: usize = 4 * 52;

// Note: JavaScript (cpu.get_state_apic) depens on this layout
const _: () = assert!(std::mem::offset_of!(Ioapic, ioredtbl_destination) == 24 * 4);
const _: () = assert!(std::mem::offset_of!(Ioapic, ioregsel) == 48 * 4);
const _: () = assert!(std::mem::offset_of!(Ioapic, irq_value) == 51 * 4);
const _: () = assert!(std::mem::size_of::<Ioapic>() == IOAPIC_STRUCT_SIZE);
#[repr(C)]
struct Ioapic {
    ioredtbl_config: [u32; IOAPIC_IRQ_COUNT],
    ioredtbl_destination: [u32; IOAPIC_IRQ_COUNT],
    ioregsel: u32,
    ioapic_id: u32,
    irr: u32,
    irq_value: u32,
}

static IOAPIC: Mutex<Ioapic> = Mutex::new(Ioapic {
    ioredtbl_config: [IOAPIC_CONFIG_MASKED; IOAPIC_IRQ_COUNT],
    ioredtbl_destination: [0; IOAPIC_IRQ_COUNT],
    ioregsel: 0,
    ioapic_id: IOAPIC_ID,
    irr: 0,
    irq_value: 0,
});

fn get_ioapic() -> MutexGuard<'static, Ioapic> { IOAPIC.try_lock().unwrap() }

#[no_mangle]
pub fn get_ioapic_addr() -> u32 { &raw mut *get_ioapic() as u32 }

pub fn remote_eoi(apic: &mut apic::Apic, vector: u8) {
    remote_eoi_internal(&mut get_ioapic(), apic, vector);
}

fn remote_eoi_internal(ioapic: &mut Ioapic, apic: &mut apic::Apic, vector: u8) {
    for i in 0..IOAPIC_IRQ_COUNT as u8 {
        let config = ioapic.ioredtbl_config[i as usize];

        if (config & 0xFF) as u8 == vector && config & IOAPIC_CONFIG_REMOTE_IRR != 0 {
            dbg_log!("Clear remote IRR for irq={:x}", i);
            ioapic.ioredtbl_config[i as usize] &= !IOAPIC_CONFIG_REMOTE_IRR;
            check_irq(ioapic, apic, i);
        }
    }
}

fn check_irq(ioapic: &mut Ioapic, apic: &mut apic::Apic, irq: u8) {
    let mask = 1 << irq;

    if ioapic.irr & mask == 0 {
        return;
    }

    let config = ioapic.ioredtbl_config[irq as usize];

    if config & IOAPIC_CONFIG_MASKED == 0 {
        let delivery_mode = ((config >> 8) & 7) as u8;
        let destination_mode = ((config >> 11) & 1) as u8;
        let vector = (config & 0xFF) as u8;
        let destination = (ioapic.ioredtbl_destination[irq as usize] >> 24) as u8;
        let is_level =
            config & IOAPIC_CONFIG_TRIGGER_MODE_LEVEL == IOAPIC_CONFIG_TRIGGER_MODE_LEVEL;

        if config & IOAPIC_CONFIG_TRIGGER_MODE_LEVEL == 0 {
            ioapic.irr &= !mask;
        }
        else {
            ioapic.ioredtbl_config[irq as usize] |= IOAPIC_CONFIG_REMOTE_IRR;

            if config & IOAPIC_CONFIG_REMOTE_IRR != 0 {
                dbg_log!("No route: level interrupt and remote IRR still set");
                return;
            }
        }

        if delivery_mode == IOAPIC_DELIVERY_FIXED
            || delivery_mode == IOAPIC_DELIVERY_LOWEST_PRIORITY
        {
            apic::route(
                apic,
                vector,
                delivery_mode,
                is_level,
                destination,
                destination_mode,
            );
        }
        else {
            dbg_assert!(false, "TODO");
        }

        ioapic.ioredtbl_config[irq as usize] &= !IOAPIC_CONFIG_DELIVS;
    }
}

pub fn set_irq(i: u8) { set_irq_internal(&mut get_ioapic(), &mut apic::get_apic(), i) }

fn set_irq_internal(ioapic: &mut Ioapic, apic: &mut apic::Apic, i: u8) {
    if i as usize >= IOAPIC_IRQ_COUNT {
        dbg_assert!(false, "Bad irq: {}", i);
        return;
    }

    let mask = 1 << i;

    if ioapic.irq_value & mask == 0 {
        if IOAPIC_LOG_VERBOSE {
            dbg_log!("apic set irq {}", i);
        }

        ioapic.irq_value |= mask;

        let config = ioapic.ioredtbl_config[i as usize];
        if config & (IOAPIC_CONFIG_TRIGGER_MODE_LEVEL | IOAPIC_CONFIG_MASKED)
            == IOAPIC_CONFIG_MASKED
        {
            // edge triggered and masked
            return;
        }

        ioapic.irr |= mask;

        check_irq(ioapic, apic, i);
    }
}

pub fn clear_irq(i: u8) { clear_irq_internal(&mut get_ioapic(), i) }

fn clear_irq_internal(ioapic: &mut Ioapic, i: u8) {
    if i as usize >= IOAPIC_IRQ_COUNT {
        dbg_assert!(false, "Bad irq: {}", i);
        return;
    }

    let mask = 1 << i;

    if ioapic.irq_value & mask == mask {
        ioapic.irq_value &= !mask;

        let config = ioapic.ioredtbl_config[i as usize];
        if config & IOAPIC_CONFIG_TRIGGER_MODE_LEVEL != 0 {
            ioapic.irr &= !mask;
        }
    }
}

pub fn read32(addr: u32) -> u32 {
    if unsafe { !*acpi_enabled } {
        return 0;
    }
    read32_internal(&mut get_ioapic(), addr)
}

fn read32_internal(ioapic: &mut Ioapic, addr: u32) -> u32 {
    match addr {
        IOREGSEL => ioapic.ioregsel,
        IOWIN => match ioapic.ioregsel {
            0 => {
                dbg_log!("IOAPIC Read id");
                ioapic.ioapic_id << 24
            },
            1 => {
                dbg_log!("IOAPIC Read version");
                0x11 | (IOAPIC_IRQ_COUNT as u32 - 1) << 16
            },
            2 => {
                dbg_log!("IOAPIC Read arbitration id");
                ioapic.ioapic_id << 24
            },
            IOAPIC_FIRST_IRQ_REG..IOAPIC_LAST_IRQ_REG => {
                let irq = ((ioapic.ioregsel - IOAPIC_FIRST_IRQ_REG) >> 1) as u8;
                let index = ioapic.ioregsel & 1;

                if index != 0 {
                    let value = ioapic.ioredtbl_destination[irq as usize];
                    dbg_log!("IOAPIC Read destination irq={:x} -> {:08x}", irq, value);
                    value
                }
                else {
                    let value = ioapic.ioredtbl_config[irq as usize];
                    dbg_log!("IOAPIC Read config irq={:x} -> {:08x}", irq, value);
                    value
                }
            },
            reg => {
                dbg_assert!(false, "IOAPIC register read outside of range {:x}", reg);
                0
            },
        },
        _ => {
            dbg_assert!(false, "Unaligned or oob IOAPIC memory read: {:x}", addr);
            0
        },
    }
}

pub fn write32(addr: u32, value: u32) {
    if unsafe { !*acpi_enabled } {
        return;
    }
    write32_internal(&mut get_ioapic(), &mut apic::get_apic(), addr, value)
}

fn write32_internal(ioapic: &mut Ioapic, apic: &mut apic::Apic, addr: u32, value: u32) {
    //dbg_log!("IOAPIC write {:x} <- {:08x}", reg, value);

    match addr {
        IOREGSEL => ioapic.ioregsel = value,
        IOWIN => match ioapic.ioregsel {
            0 => ioapic.ioapic_id = (value >> 24) & 0x0F,
            1 | 2 => {
                dbg_log!("IOAPIC Invalid write: {}", ioapic.ioregsel);
            },
            IOAPIC_FIRST_IRQ_REG..IOAPIC_LAST_IRQ_REG => {
                let irq = ((ioapic.ioregsel - IOAPIC_FIRST_IRQ_REG) >> 1) as u8;
                let index = ioapic.ioregsel & 1;

                if index != 0 {
                    dbg_log!(
                        "Write destination {:08x} irq={:x} dest={:02x}",
                        value,
                        irq,
                        value >> 24
                    );
                    ioapic.ioredtbl_destination[irq as usize] = value & 0xFF000000;
                }
                else {
                    let old_value = ioapic.ioredtbl_config[irq as usize] as u32;
                    ioapic.ioredtbl_config[irq as usize] = (value & !IOAPIC_CONFIG_READONLY_MASK)
                        | (old_value & IOAPIC_CONFIG_READONLY_MASK);

                    let vector = value & 0xFF;
                    let delivery_mode = (value >> 8) & 7;
                    let destination_mode = (value >> 11) & 1;
                    let is_level = (value >> 15) & 1;
                    let disabled = (value >> 16) & 1;

                    dbg_log!(
                            "Write config {:08x} irq={:x} vector={:02x} deliverymode={} destmode={} is_level={} disabled={}",
                            value,
                            irq,
                            vector,
                            DELIVERY_MODES[delivery_mode as usize],
                            DESTINATION_MODES[destination_mode as usize],
                            is_level,
                            disabled
                        );

                    check_irq(ioapic, apic, irq);
                }
            },
            reg => {
                dbg_assert!(
                    false,
                    "IOAPIC register write outside of range {:x} <- {:x}",
                    reg,
                    value
                )
            },
        },
        _ => {
            dbg_assert!(
                false,
                "Unaligned or oob IOAPIC memory write: {:x} <- {:x}",
                addr,
                value
            )
        },
    }
}
