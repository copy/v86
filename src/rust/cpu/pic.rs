#![allow(non_snake_case)]

pub const PIC_LOG: bool = false;
pub const PIC_LOG_VERBOSE: bool = false;
use cpu::cpu;

struct Pic {
    irq_mask: u8,

    irq_map: u8,

    // in-service register
    // Holds interrupts that are currently being serviced
    isr: u8,

    // interrupt request register
    // Holds interrupts that have been requested
    irr: u8,

    irq_value: u8,

    requested_irq: Option<u8>,

    expect_icw4: bool,
    state: u8,
    read_isr: bool,
    auto_eoi: bool,
    special_mask_mode: bool,

    elcr: u8,

    master: bool,
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
    requested_irq: None,
    expect_icw4: false,
    state: 0,
    read_isr: false,
    auto_eoi: false,
    special_mask_mode: false,
    elcr: 0,
    master: true,
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
    requested_irq: None,
    expect_icw4: false,
    state: 0,
    read_isr: false,
    auto_eoi: false,
    special_mask_mode: false,
    elcr: 0,
    master: false,
};


// Checking for callable interrupts:
// (cpu changes interrupt flag) -> cpu.handle_irqs -> pic.check_irqs -> cpu.pic_call_irq
// (pic changes isr/irr) -> cpu.handle_irqs -> ...

// triggering irqs:
// (io device has irq) -> cpu.device_raise_irq -> pic.set_irq -> cpu.handle_irqs -> (see above)

// called by the cpu
pub unsafe fn pic_acknowledge_irq() {
    let irq = match master.requested_irq {
        Some(i) => i,
        None => return
    };
    master.requested_irq = None;

    if master.irr == 0 {
        //PIC_LOG_VERBOSE && dbg_log!("master> spurious requested=" + pic.requested_irq);
        //pic.cpu.pic_call_irq(pic.irq_map | 7);
        return;
    }

    let mask = 1 << irq;

    if master.elcr & mask == 0  {
        // not in level mode
        master.irr &= !mask;
    }

    if !master.auto_eoi {
        master.isr |= mask;
    }

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] master> acknowledge {}", irq);
    }
    if irq == 2 {
        acknowledge_irq_slave();
    }
    else {
        cpu::pic_call_irq(master.irq_map | irq);
    }

    check_irqs(&mut master);
}

unsafe fn acknowledge_irq_slave() {
    let irq = match slave.requested_irq {
        Some(i) => i,
        None => return
    };
    slave.requested_irq = None;
    master.irq_value &= !(1 << 2);

    if slave.irr == 0 {
        //PIC_LOG_VERBOSE && dbg_log!("slave> spurious requested=" + pic.requested_irq);
        //pic.cpu.pic_call_irq(pic.irq_map | 7);
        cpu::pic_call_irq(slave.irq_map | 7);
        return;
    }

    let mask = 1 << irq;

    if slave.elcr & mask == 0  {
        // not in level mode
        slave.irr &= !mask;
    }

    if !slave.auto_eoi {
        slave.isr |= mask;
    }

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] slave> acknowledge {}", irq);
    }
    cpu::pic_call_irq(slave.irq_map | irq);

    check_irqs(&mut slave);
}

unsafe fn check_irqs(pic: &mut Pic) {
    if let Some(irq) = pic.requested_irq {
        if PIC_LOG_VERBOSE {
            dbg_log!("[PIC] Already requested irq: {}", irq);
        }
        cpu::handle_irqs();
        return;
    }

    let enabled_irr = pic.irr & pic.irq_mask;

    if enabled_irr == 0 {
        if PIC_LOG_VERBOSE {
            dbg_log!("master> no unmasked irrs. irr={:x} mask={:x} isr={:x}", pic.irr, pic.irq_mask, pic.isr);
        }
        return;
    }

    let irq_mask = enabled_irr & (!enabled_irr + 1);
    let special_mask = if pic.special_mask_mode { pic.irq_mask } else { 0xFF };

    if pic.isr != 0 && (pic.isr & (!pic.isr + 1) & special_mask) <= irq_mask {
        // wait for eoi of higher or same priority interrupt
        if PIC_LOG {
            dbg_log!("[PIC] higher prio: isr={:x} mask={:x} irq={:x}", pic.isr, pic.irq_mask, irq_mask);
        }
        return;
    }

    dbg_assert!(irq_mask != 0);
    let irq_number = irq_mask.ilog2() as u8;
    dbg_assert!(irq_mask == (1 << irq_number));

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] request irq {}", irq_number);
    }

    pic.requested_irq = Some(irq_number);
    // XXX: lifetimes ...
    if !pic.master {
        pic_set_irq(2);
    }
    cpu::handle_irqs();
}

// called by javascript
#[no_mangle]
pub unsafe fn pic_set_irq(i: u8) {
    dbg_assert!(i < 16);

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] set irq {}, irq_value={:x}", i, master.irq_value);
    }

    if i < 8 {
        let mask = 1 << i;
        if master.irq_value & mask == 0 {
            master.irr |= mask;
            master.irq_value |= mask;
            check_irqs(&mut master);
        }
    }
    else {
        let mask = 1 << (i - 8);
        if slave.irq_value & mask == 0 {
            slave.irr |= mask;
            slave.irq_value |= mask;
            check_irqs(&mut slave);
        }
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
        let mask = 1 << i;
        if master.irq_value & mask != 0 {
            master.irq_value &= !mask;
            master.irr &= !mask;
            check_irqs(&mut master);
        }
    } else {
        let mask = 1 << (i - 8);
        if slave.irq_value & mask != 0 {
            slave.irq_value &= !mask;
            slave.irr &= !mask;
            check_irqs(&mut slave);
        }
    }
}

unsafe fn port0_read(pic: &mut Pic) -> u32 {
    (if pic.read_isr { pic.isr } else { pic.irr }) as u32
}
unsafe fn port1_read(pic: &mut Pic) -> u32 {
    !pic.irq_mask as u32
}

unsafe fn port0_write(pic: &mut Pic, v: u8) {
    if v & 0x10 != 0 { // xxxx1xxx
        // icw1
        dbg_log!("icw1 = {:x}", v);
        pic.isr = 0;
        pic.irr = 0;
        pic.irq_mask = 0;
        pic.irq_value = 0;
        pic.auto_eoi = true;
        pic.requested_irq = None;

        pic.expect_icw4 = v & 1 != 0;
        pic.state = 1;
    }
    else if v & 8 != 0 { // xxx01xxx
        // ocw3
        dbg_log!("ocw3: {:x}", v);
        if v & 2 != 0 {
            pic.read_isr = v & 1 != 0;
        }
        if v & 4 != 0 {
            dbg_assert!(false, "unimplemented: polling");
        }
        if v & 0x40 != 0 {
            pic.special_mask_mode = (v & 0x20) == 0x20;
            dbg_log!("special mask mode: {}", pic.special_mask_mode);
        }
    }
    else { // xxx00xxx
        // ocw2
        // end of interrupt
        if PIC_LOG {
            dbg_log!("eoi: {:x}", v);
        }

        let eoi_type = v >> 5;

        if eoi_type == 1 {
            // non-specific eoi
            pic.isr &= pic.isr - 1;
            if PIC_LOG {
                dbg_log!("new isr: {:x}", pic.isr);
            }
        }
        else if eoi_type == 3 {
            // specific eoi
            pic.isr &= !(1 << (v & 7));
        }
        else if (v & 0xC8) == 0xC0 {
            // os2 v4
            let priority = v & 7;
            dbg_log!("lowest priority: {:x}", priority);
        }
        else {
            dbg_log!("Unknown eoi: {:x}", v);
            dbg_assert!(false);
            pic.isr &= pic.isr - 1;
        }

        check_irqs(pic);
    }
}

unsafe fn port1_write(pic: &mut Pic, v: u8) {
    //dbg_log!("21 write: " + h(v));
    if pic.state == 0 {
        if pic.expect_icw4 {
            // icw4
            pic.expect_icw4 = false;
            pic.auto_eoi = v & 2 != 0;
            dbg_log!("icw4: {:x} autoeoi={}", v, pic.auto_eoi);

            if v & 1 == 0 {
                dbg_assert!(false, "unimplemented: not 8086 mode");
            }
        }
        else {
            // ocw1
            pic.irq_mask = !v;

            if PIC_LOG_VERBOSE {
                dbg_log!("interrupt mask: {:x}", pic.irq_mask);
            }

            check_irqs(pic);
        }
    }
    else if pic.state == 1 {
        // icw2
        pic.irq_map = v;
        dbg_log!("interrupts are mapped to {}", pic.irq_map);
        pic.state += 1;
    }
    else if pic.state == 2 {
        // icw3
        pic.state = 0;
        dbg_log!("icw3: {:x}", v);
    }
}

#[no_mangle]
pub unsafe fn port20_read() -> u32 { port0_read(&mut master) }
#[no_mangle]
pub unsafe fn port21_read() -> u32 { port1_read(&mut master) }

#[no_mangle]
pub unsafe fn portA0_read() -> u32 { port0_read(&mut slave) }
#[no_mangle]
pub unsafe fn portA1_read() -> u32 { port1_read(&mut slave) }

#[no_mangle]
pub unsafe fn port20_write(v: u8) { port0_write(&mut master, v) }
#[no_mangle]
pub unsafe fn port21_write(v: u8) { port1_write(&mut master, v) }

#[no_mangle]
pub unsafe fn portA0_write(v: u8) { port0_write(&mut slave, v) }
#[no_mangle]
pub unsafe fn portA1_write(v: u8) { port1_write(&mut slave, v) }

#[no_mangle]
pub unsafe fn port4D0_read() -> u32 { master.elcr as u32 }
#[no_mangle]
pub unsafe fn port4D1_read() -> u32 { slave.elcr as u32 }
#[no_mangle]
pub unsafe fn port4D0_write(v: u8) { master.elcr = v }
#[no_mangle]
pub unsafe fn port4D1_write(v: u8) { slave.elcr = v }
