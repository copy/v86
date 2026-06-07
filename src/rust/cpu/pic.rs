#![allow(non_snake_case)]

// Programmable Interrupt Controller
// http://stanislavs.org/helppc/8259.html

use std::sync::{Mutex, MutexGuard};

pub const PIC_LOG: bool = false;
pub const PIC_LOG_VERBOSE: bool = false;

// Note: This layout is deliberately chosen to match the old JavaScript pic state
// (cpu.get_state_pic depens on this layout)
const _: () = assert!(std::mem::offset_of!(Pic0, special_mask_mode) == 12);
#[repr(C)]
struct Pic0 {
    irq_mask: u8,

    irq_map: u8,

    // in-service register
    // Holds interrupts that are currently being serviced
    isr: u8,

    // interrupt request register
    // Holds interrupts that have been requested
    irr: u8,

    master: bool,
    dummy: u8, // remove when state image is updated

    expect_icw4: bool,
    state: u8,
    read_isr: bool,
    auto_eoi: bool,

    elcr: u8,

    irq_value: u8,
    special_mask_mode: bool,
}

struct Pic {
    master: Pic0,
    slave: Pic0,
}

static PIC: Mutex<Pic> = Mutex::new(Pic {
    master: Pic0 {
        // all irqs off
        irq_mask: 0,
        // Bogus default value (both master and slave mapped to 0).
        // Will be initialized by the BIOS
        irq_map: 0,
        // in-service register
        // Holds interrupts that are currently being serviced
        isr: 0,
        // interrupt request register
        // Holds interrupts that have been requested
        irr: 0,
        irq_value: 0,
        expect_icw4: false,
        state: 0,
        read_isr: false,
        auto_eoi: false,
        special_mask_mode: false,
        elcr: 0,
        master: true,
        dummy: 0,
    },
    slave: Pic0 {
        // all irqs off
        irq_mask: 0,
        // Bogus default value (both master and slave mapped to 0).
        // Will be initialized by the BIOS
        irq_map: 0,
        // in-service register
        // Holds interrupts that are currently being serviced
        isr: 0,
        // interrupt request register
        // Holds interrupts that have been requested
        irr: 0,
        irq_value: 0,
        expect_icw4: false,
        state: 0,
        read_isr: false,
        auto_eoi: false,
        special_mask_mode: false,
        elcr: 0,
        master: false,
        dummy: 0,
    },
});

fn get_pic() -> MutexGuard<'static, Pic> { PIC.try_lock().unwrap() }

// called from javascript for saving/restoring state
#[no_mangle]
pub fn get_pic_addr_master() -> u32 { &raw mut get_pic().master as u32 }
#[no_mangle]
pub fn get_pic_addr_slave() -> u32 { &raw mut get_pic().slave as u32 }

impl Pic0 {
    fn get_irq(&mut self) -> Option<u8> {
        let enabled_irr = self.irr & self.irq_mask;

        if enabled_irr == 0 {
            if PIC_LOG_VERBOSE {
                dbg_log!(
                    "[PIC] no unmasked irrs. irr={:x} mask={:x} isr={:x}",
                    self.irr,
                    self.irq_mask,
                    self.isr
                );
            }
            return None;
        }

        let irq_mask = enabled_irr & (!enabled_irr + 1);
        let special_mask = if self.special_mask_mode { self.irq_mask } else { 0xFF };

        if self.isr != 0 && (self.isr & (!self.isr + 1) & special_mask) <= irq_mask {
            // wait for eoi of higher or same priority interrupt
            if PIC_LOG {
                dbg_log!(
                    "[PIC] higher prio: master={} isr={:x} mask={:x} irq={:x}",
                    self.master,
                    self.isr,
                    self.irq_mask,
                    irq_mask
                );
            }
            return None;
        }

        dbg_assert!(irq_mask != 0);
        let irq_number = irq_mask.ilog2() as u8;
        dbg_assert!(irq_mask == 1 << irq_number);

        if PIC_LOG_VERBOSE {
            dbg_log!("[PIC] request irq {}", irq_number);
        }

        Some(irq_number)
    }

    fn port0_read(self: &Pic0) -> u32 { (if self.read_isr { self.isr } else { self.irr }) as u32 }
    fn port1_read(self: &Pic0) -> u32 { !self.irq_mask as u32 }
}

impl Pic {
    fn set_irq(self: &mut Pic, i: u8) {
        let mask = 1 << (i & 7);
        let dev = if i < 8 { &mut self.master } else { &mut self.slave };
        if dev.irq_value & mask == 0 || dev.elcr & mask != 0 {
            dev.irr |= mask;
            dev.irq_value |= mask;
            if i >= 8 {
                self.check_irqs_slave()
            }
        }
    }

    fn clear_irq(self: &mut Pic, i: u8) {
        let mask = 1 << (i & 7);
        let dev = if i < 8 { &mut self.master } else { &mut self.slave };
        dev.irq_value &= !mask;
        if dev.elcr & mask != 0 {
            dev.irr &= !mask;
            if i >= 8 {
                self.check_irqs_slave()
            }
        }
    }

    fn port0_write(&mut self, index: u8, v: u8) {
        let dev = if index == 0 { &mut self.master } else { &mut self.slave };
        if v & 0x10 != 0 {
            // xxxx1xxx
            // icw1
            dbg_log!("icw1 = {:x}", v);
            dev.isr = 0;
            dev.irr = 0;
            dev.irq_mask = 0xff;
            dev.irq_value = 0;
            dev.auto_eoi = true;

            dev.expect_icw4 = v & 1 != 0;
            dbg_assert!(v & 2 == 0, "unimplemented: single mode");
            dbg_assert!(v & 8 == 0, "unimplemented: level mode");
            dev.state = 1;
        }
        else if v & 8 != 0 {
            // xxx01xxx
            // ocw3
            dbg_log!("ocw3: {:x}", v);
            if v & 2 != 0 {
                dev.read_isr = v & 1 != 0;
            }
            if v & 4 != 0 {
                dbg_assert!(false, "unimplemented: polling");
            }
            if v & 0x40 != 0 {
                dev.special_mask_mode = (v & 0x20) == 0x20;
                dbg_log!("special mask mode: {}", dev.special_mask_mode);
            }
        }
        else {
            // xxx00xxx
            // ocw2
            // end of interrupt
            if PIC_LOG {
                dbg_log!("eoi: {:x}", v);
            }

            let eoi_type = v >> 5;

            if eoi_type == 1 {
                // non-specific eoi
                dev.isr &= dev.isr - 1;
                if PIC_LOG {
                    dbg_log!("new isr: {:x}", dev.isr);
                }
            }
            else if eoi_type == 3 {
                // specific eoi
                dev.isr &= !(1 << (v & 7));
            }
            else if eoi_type == 6 {
                // os2 v4, freebsd
                let priority = v & 7;
                dbg_log!("lowest priority: {:x}", priority);
            }
            else {
                dbg_log!("Unknown eoi: {:x} type={:x}", v, eoi_type);
                dbg_assert!(false);
                dev.isr &= dev.isr - 1;
            }

            if index == 1 {
                self.check_irqs_slave()
            }
        }
    }

    fn port1_write(&mut self, index: u8, v: u8) {
        let dev = if index == 0 { &mut self.master } else { &mut self.slave };
        if dev.state == 0 {
            if dev.expect_icw4 {
                // icw4
                dev.expect_icw4 = false;
                dev.auto_eoi = v & 2 != 0;
                dbg_log!("icw4: {:x} autoeoi={}", v, dev.auto_eoi);
                dbg_assert!(v & 0x10 == 0, "unimplemented: nested mode");
                dbg_assert!(v & 1 == 1, "unimplemented: 8086/88 mode");
            }
            else {
                // ocw1
                dev.irq_mask = !v;

                if PIC_LOG_VERBOSE {
                    dbg_log!("interrupt mask: {:x}", dev.irq_mask);
                }

                if index == 1 {
                    self.check_irqs_slave()
                }
            }
        }
        else if dev.state == 1 {
            // icw2
            dev.irq_map = v;
            dbg_log!("interrupts are mapped to {:x}", dev.irq_map);
            dev.state += 1;
        }
        else if dev.state == 2 {
            // icw3
            dev.state = 0;
            dbg_log!("icw3: {:x}", v);
        }
    }

    fn check_irqs_slave(&mut self) {
        let is_set = self.slave.get_irq().is_some();
        if is_set {
            self.set_irq(2)
        }
        else {
            self.clear_irq(2)
        }
    }
}

// called by the cpu
pub fn pic_acknowledge_irq() -> Option<u8> {
    let mut pic = get_pic();
    let irq = match pic.master.get_irq() {
        Some(i) => i,
        None => return None,
    };

    if pic.master.irr == 0 {
        dbg_assert!(false);
        //PIC_LOG_VERBOSE && dbg_log!("master> spurious requested=" + irq);
        //Some(pic.irq_map | 7)
        return None;
    }

    let mask = 1 << irq;

    if pic.master.elcr & mask == 0 {
        // not in level mode
        pic.master.irr &= !mask;
    }

    if !pic.master.auto_eoi {
        pic.master.isr |= mask;
    }

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] master> acknowledge {}", irq);
    }

    dbg_assert!(pic.master.get_irq().is_none());

    if irq == 2 {
        acknowledge_irq_slave(&mut pic)
    }
    else {
        Some(pic.master.irq_map | irq)
    }
}

fn acknowledge_irq_slave(pic: &mut Pic) -> Option<u8> {
    let irq = match pic.slave.get_irq() {
        Some(i) => i,
        None => return None,
    };

    if pic.slave.irr == 0 {
        //PIC_LOG_VERBOSE && dbg_log!("slave> spurious requested=" + irq);
        //Some(pic.irq_map | 7)
        dbg_assert!(false);
        return None;
    }

    let mask = 1 << irq;

    if pic.slave.elcr & mask == 0 {
        // not in level mode
        pic.slave.irr &= !mask;
    }

    if !pic.slave.auto_eoi {
        pic.slave.isr |= mask;
    }

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] slave> acknowledge {}", irq);
    }

    dbg_assert!(pic.slave.get_irq().is_none());
    pic.clear_irq(2);

    Some(pic.slave.irq_map | irq)
}

pub fn set_irq(i: u8) {
    dbg_assert!(i < 16);

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] set irq {}", i);
    }

    get_pic().set_irq(i)
}

pub fn clear_irq(i: u8) {
    dbg_assert!(i < 16);

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] clear irq {}", i);
    }

    get_pic().clear_irq(i)
}

pub fn port20_read() -> u32 { get_pic().master.port0_read() }
pub fn port21_read() -> u32 { get_pic().master.port1_read() }

pub fn portA0_read() -> u32 { get_pic().slave.port0_read() }
pub fn portA1_read() -> u32 { get_pic().slave.port1_read() }

pub fn port20_write(v: u8) { get_pic().port0_write(0, v) }
pub fn port21_write(v: u8) { get_pic().port1_write(0, v) }

pub fn portA0_write(v: u8) { get_pic().port0_write(1, v) }
pub fn portA1_write(v: u8) { get_pic().port1_write(1, v) }

pub fn port4D0_read() -> u32 { get_pic().master.elcr as u32 }
pub fn port4D1_read() -> u32 { get_pic().slave.elcr as u32 }
pub fn port4D0_write(v: u8) { get_pic().master.elcr = v }
pub fn port4D1_write(v: u8) { get_pic().slave.elcr = v }
