#![allow(non_snake_case)]

// Programmable Interrupt Controller
// http://stanislavs.org/helppc/8259.html

pub const PIC_LOG: bool = false;
pub const PIC_LOG_VERBOSE: bool = false;
use cpu::cpu;

// Note: This layout is deliberately chosen to match the old JavaScript pic state
// (cpu.get_state_pic depens on this layout)
#[repr(C, packed)]
struct Pic {
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

#[allow(non_upper_case_globals)]
static mut master: Pic = Pic {
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
};

#[allow(non_upper_case_globals)]
static mut slave: Pic = Pic {
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
};

// Checking for callable interrupts:
// (cpu changes interrupt flag) -> cpu.handle_irqs -> pic_acknowledge_irq
// (pic changes isr/irr) -> pic.check_irqs -> cpu.handle_irqs -> ...

// triggering irqs:
// (io device has irq) -> cpu.device_raise_irq -> pic.set_irq -> pic.check_irqs -> cpu.handle_irqs -> (see above)

impl Pic {
    unsafe fn get_irq(&mut self) -> Option<u8> {
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

    unsafe fn check_irqs(&mut self) {
        let is_set = self.get_irq().is_some();

        if self.master {
            if is_set {
                cpu::handle_irqs();
            }
        }
        else {
            if is_set {
                master.set_irq(2)
            }
            else {
                master.clear_irq(2)
            }
        }
    }

    unsafe fn set_irq(&mut self, i: u8) {
        let mask = 1 << i;
        if self.irq_value & mask == 0 || self.elcr & mask != 0 {
            self.irr |= mask;
            self.irq_value |= mask;
            self.check_irqs()
        }
    }

    unsafe fn clear_irq(&mut self, i: u8) {
        let mask = 1 << i;
        if self.elcr & mask != 0 {
            self.irq_value &= !mask;
            self.irr &= !mask;
            self.check_irqs()
        }
        else if self.irq_value & mask != 0 {
            self.irq_value &= !mask;
            self.check_irqs()
        }
    }

    unsafe fn port0_read(self: &Pic) -> u32 {
        (if self.read_isr { self.isr } else { self.irr }) as u32
    }
    unsafe fn port1_read(self: &Pic) -> u32 { !self.irq_mask as u32 }

    unsafe fn port0_write(&mut self, v: u8) {
        if v & 0x10 != 0 {
            // xxxx1xxx
            // icw1
            dbg_log!("icw1 = {:x}", v);
            self.isr = 0;
            self.irr = 0;
            self.irq_mask = 0xff;
            self.irq_value = 0;
            self.auto_eoi = true;

            self.expect_icw4 = v & 1 != 0;
            self.state = 1;
        }
        else if v & 8 != 0 {
            // xxx01xxx
            // ocw3
            dbg_log!("ocw3: {:x}", v);
            if v & 2 != 0 {
                self.read_isr = v & 1 != 0;
            }
            if v & 4 != 0 {
                dbg_assert!(false, "unimplemented: polling");
            }
            if v & 0x40 != 0 {
                self.special_mask_mode = (v & 0x20) == 0x20;
                dbg_log!("special mask mode: {}", self.special_mask_mode);
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
                self.isr &= self.isr - 1;
                if PIC_LOG {
                    dbg_log!("new isr: {:x}", self.isr);
                }
            }
            else if eoi_type == 3 {
                // specific eoi
                self.isr &= !(1 << (v & 7));
            }
            else if (v & 0xC8) == 0xC0 {
                // os2 v4
                let priority = v & 7;
                dbg_log!("lowest priority: {:x}", priority);
            }
            else {
                dbg_log!("Unknown eoi: {:x}", v);
                dbg_assert!(false);
                self.isr &= self.isr - 1;
            }

            self.check_irqs()
        }
    }

    unsafe fn port1_write(&mut self, v: u8) {
        //dbg_log!("21 write: " + h(v));
        if self.state == 0 {
            if self.expect_icw4 {
                // icw4
                self.expect_icw4 = false;
                self.auto_eoi = v & 2 != 0;
                dbg_log!("icw4: {:x} autoeoi={}", v, self.auto_eoi);

                if v & 1 == 0 {
                    dbg_assert!(false, "unimplemented: not 8086 mode");
                }
            }
            else {
                // ocw1
                self.irq_mask = !v;

                if PIC_LOG_VERBOSE {
                    dbg_log!("interrupt mask: {:x}", self.irq_mask);
                }

                self.check_irqs()
            }
        }
        else if self.state == 1 {
            // icw2
            self.irq_map = v;
            dbg_log!("interrupts are mapped to {:x}", self.irq_map);
            self.state += 1;
        }
        else if self.state == 2 {
            // icw3
            self.state = 0;
            dbg_log!("icw3: {:x}", v);
        }
    }
}

// called by the cpu
pub unsafe fn pic_acknowledge_irq() -> Option<u8> {
    let irq = match master.get_irq() {
        Some(i) => i,
        None => return None,
    };

    if master.irr == 0 {
        dbg_assert!(false);
        //PIC_LOG_VERBOSE && dbg_log!("master> spurious requested=" + irq);
        //Some(pic.irq_map | 7)
        return None;
    }

    let mask = 1 << irq;

    if master.elcr & mask == 0 {
        // not in level mode
        master.irr &= !mask;
    }

    if !master.auto_eoi {
        master.isr |= mask;
    }

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] master> acknowledge {}", irq);
    }

    master.check_irqs();

    if irq == 2 {
        acknowledge_irq_slave()
    }
    else {
        Some(master.irq_map | irq)
    }
}

unsafe fn acknowledge_irq_slave() -> Option<u8> {
    let irq = match slave.get_irq() {
        Some(i) => i,
        None => return None,
    };

    if slave.irr == 0 {
        //PIC_LOG_VERBOSE && dbg_log!("slave> spurious requested=" + irq);
        //Some(pic.irq_map | 7)
        dbg_assert!(false);
        return None;
    }

    let mask = 1 << irq;

    if slave.elcr & mask == 0 {
        // not in level mode
        slave.irr &= !mask;
    }

    if !slave.auto_eoi {
        slave.isr |= mask;
    }

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] slave> acknowledge {}", irq);
    }
    slave.check_irqs();

    Some(slave.irq_map | irq)
}

// called by javascript
#[no_mangle]
pub unsafe fn pic_set_irq(i: u8) {
    dbg_assert!(i < 16);

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] set irq {}, irq_value={:x}", i, master.irq_value);
    }

    if i < 8 {
        master.set_irq(i)
    }
    else {
        slave.set_irq(i - 8)
    }
}

// called by javascript
#[no_mangle]
pub unsafe fn pic_clear_irq(i: u8) {
    dbg_assert!(i < 16);

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] clear irq {}", i);
    }

    if i < 8 {
        master.clear_irq(i)
    }
    else {
        slave.clear_irq(i - 8)
    }
}

#[no_mangle]
pub unsafe fn port20_read() -> u32 { master.port0_read() }
#[no_mangle]
pub unsafe fn port21_read() -> u32 { master.port1_read() }

#[no_mangle]
pub unsafe fn portA0_read() -> u32 { slave.port0_read() }
#[no_mangle]
pub unsafe fn portA1_read() -> u32 { slave.port1_read() }

#[no_mangle]
pub unsafe fn port20_write(v: u8) { master.port0_write(v) }
#[no_mangle]
pub unsafe fn port21_write(v: u8) { master.port1_write(v) }

#[no_mangle]
pub unsafe fn portA0_write(v: u8) { slave.port0_write(v) }
#[no_mangle]
pub unsafe fn portA1_write(v: u8) { slave.port1_write(v) }

#[no_mangle]
pub unsafe fn port4D0_read() -> u32 { master.elcr as u32 }
#[no_mangle]
pub unsafe fn port4D1_read() -> u32 { slave.elcr as u32 }
#[no_mangle]
pub unsafe fn port4D0_write(v: u8) { master.elcr = v }
#[no_mangle]
pub unsafe fn port4D1_write(v: u8) { slave.elcr = v }

#[no_mangle]
pub unsafe fn get_pic_addr_master() -> u32 { std::ptr::addr_of_mut!(master) as u32 }
#[no_mangle]
pub unsafe fn get_pic_addr_slave() -> u32 { std::ptr::addr_of_mut!(slave) as u32 }
