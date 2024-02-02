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

// called by the cpu
pub unsafe fn pic_acknowledge_irq() -> Option<u8> {
    let irq = match get_irq(&mut master) {
        Some(i) => i,
        None => return None
    };

    if master.irr == 0 {
        dbg_assert!(false);
        //PIC_LOG_VERBOSE && dbg_log!("master> spurious requested=" + irq);
        //Some(pic.irq_map | 7)
        return None
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

    check_irqs(&mut master);

    if irq == 2 {
        acknowledge_irq_slave()
    }
    else {
        Some(master.irq_map | irq)
    }
}

unsafe fn acknowledge_irq_slave() -> Option<u8> {
    let irq = match get_irq(&mut slave) {
        Some(i) => i,
        None => return None
    };

    if slave.irr == 0 {
        //PIC_LOG_VERBOSE && dbg_log!("slave> spurious requested=" + irq);
        //Some(pic.irq_map | 7)
        dbg_assert!(false);
        return None
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
    check_irqs(&mut slave);

    Some(slave.irq_map | irq)
}

unsafe fn get_irq(pic: &mut Pic) -> Option<u8> {
    let enabled_irr = pic.irr & pic.irq_mask;

    if enabled_irr == 0 {
        if PIC_LOG_VERBOSE {
            dbg_log!("[PIC] no unmasked irrs. irr={:x} mask={:x} isr={:x}", pic.irr, pic.irq_mask, pic.isr);
        }
        return None
    }

    let irq_mask = enabled_irr & (!enabled_irr + 1);
    let special_mask = if pic.special_mask_mode { pic.irq_mask } else { 0xFF };

    if pic.isr != 0 && (pic.isr & (!pic.isr + 1) & special_mask) <= irq_mask {
        // wait for eoi of higher or same priority interrupt
        if PIC_LOG {
            dbg_log!("[PIC] higher prio: master={} isr={:x} mask={:x} irq={:x}", pic.master, pic.isr, pic.irq_mask, irq_mask);
        }
        return None
    }

    dbg_assert!(irq_mask != 0);
    let irq_number = irq_mask.ilog2() as u8;
    dbg_assert!(irq_mask == 1 << irq_number);

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] request irq {}", irq_number);
    }

    Some(irq_number)
}

unsafe fn check_irqs(pic: &mut Pic) {
    let is_set = get_irq(pic).is_some();

    if pic.master {
        if is_set {
            cpu::handle_irqs();
        }
    }
    else {
        if is_set {
            set_irq(&mut master, 2);
        }
        else {
            clear_irq(&mut master, 2);
        }
    }
}

// called by javascript
#[no_mangle]
pub unsafe fn pic_set_irq(i: u8) {
    dbg_assert!(i < 16);

    if PIC_LOG_VERBOSE {
        dbg_log!("[PIC] set irq {}, irq_value={:x}", i, master.irq_value);
    }

    if i < 8 {
        set_irq(&mut master, i);
    }
    else {
        set_irq(&mut slave, i - 8);
    }
}

unsafe fn set_irq(pic: &mut Pic, i: u8) {
    let mask = 1 << i;
    if pic.irq_value & mask == 0 || pic.elcr & mask != 0 {
        pic.irr |= mask;
        pic.irq_value |= mask;
        check_irqs(pic);
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
        clear_irq(&mut master, i);
    } else {
        clear_irq(&mut slave, i - 8);
    }
}

unsafe fn clear_irq(pic: &mut Pic, i: u8) {
    let mask = 1 << i;
    if pic.elcr & mask != 0 {
        pic.irq_value &= !mask;
        pic.irr &= !mask;
        check_irqs(pic);
    }
    else if pic.irq_value & mask != 0 {
        pic.irq_value &= !mask;
        check_irqs(pic);
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
        dbg_log!("interrupts are mapped to {:x}", pic.irq_map);
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

#[no_mangle]
pub unsafe fn get_pic_addr_master() -> u32 { std::ptr::addr_of_mut!(master) as u32 }
#[no_mangle]
pub unsafe fn get_pic_addr_slave() -> u32 { std::ptr::addr_of_mut!(slave) as u32 }
