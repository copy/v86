use crate::cpu::cpu::{device_lower_irq, device_raise_irq};

pub const CMOS_RTC_SECONDS: usize = 0x00;
pub const CMOS_RTC_SECONDS_ALARM: usize = 0x01;
pub const CMOS_RTC_MINUTES: usize = 0x02;
pub const CMOS_RTC_MINUTES_ALARM: usize = 0x03;
pub const CMOS_RTC_HOURS: usize = 0x04;
pub const CMOS_RTC_HOURS_ALARM: usize = 0x05;
pub const CMOS_RTC_DAY_WEEK: usize = 0x06;
pub const CMOS_RTC_DAY_MONTH: usize = 0x07;
pub const CMOS_RTC_MONTH: usize = 0x08;
pub const CMOS_RTC_YEAR: usize = 0x09;
pub const CMOS_STATUS_A: usize = 0x0a;
pub const CMOS_STATUS_B: usize = 0x0b;
pub const CMOS_STATUS_C: usize = 0x0c;
pub const CMOS_STATUS_D: usize = 0x0d;
pub const CMOS_DIAG_STATUS: usize = 0x0e;
pub const CMOS_RESET_CODE: usize = 0x0f;

pub const CMOS_FLOPPY_DRIVE_TYPE: usize = 0x10;
pub const CMOS_DISK_DATA: usize = 0x12;
pub const CMOS_EQUIPMENT_INFO: usize = 0x14;
pub const CMOS_MEM_BASE_LOW: usize = 0x15;
pub const CMOS_MEM_BASE_HIGH: usize = 0x16;
pub const CMOS_MEM_OLD_EXT_LOW: usize = 0x17;
pub const CMOS_MEM_OLD_EXT_HIGH: usize = 0x18;
pub const CMOS_DISK_DRIVE1_TYPE: usize = 0x19;
pub const CMOS_DISK_DRIVE2_TYPE: usize = 0x1a;
pub const CMOS_DISK_DRIVE1_CYL: usize = 0x1b;
pub const CMOS_DISK_DRIVE2_CYL: usize = 0x24;
pub const CMOS_MEM_EXTMEM_LOW: usize = 0x30;
pub const CMOS_MEM_EXTMEM_HIGH: usize = 0x31;
pub const CMOS_CENTURY: usize = 0x32;
pub const CMOS_MEM_EXTMEM2_LOW: usize = 0x34;
pub const CMOS_MEM_EXTMEM2_HIGH: usize = 0x35;
pub const CMOS_CENTURY2: usize = 0x37;
pub const CMOS_BIOS_BOOTFLAG1: usize = 0x38;
pub const CMOS_BIOS_DISKTRANSFLAG: usize = 0x39;
pub const CMOS_BIOS_BOOTFLAG2: usize = 0x3d;
pub const CMOS_MEM_HIGHMEM_LOW: usize = 0x5b;
pub const CMOS_MEM_HIGHMEM_MID: usize = 0x5c;
pub const CMOS_MEM_HIGHMEM_HIGH: usize = 0x5d;
pub const CMOS_BIOS_SMP_COUNT: usize = 0x5f;

// see CPU.prototype.fill_cmos
pub const BOOT_ORDER_CD_FIRST: usize = 0x123;
pub const BOOT_ORDER_HD_FIRST: usize = 0x312;
pub const BOOT_ORDER_FD_FIRST: usize = 0x321;

extern "C" {
    fn get_epoch_milis() -> f64;
    fn microtick() -> f64;
    fn getDate(_: f64) -> u8;
    fn getDay(_: f64) -> u8;
    fn getFullYear(_: f64) -> u32;
    fn getMonth(_: f64) -> u8;
    fn getHours(_: f64) -> u8;
    fn getMinutes(_: f64) -> u8;
    fn getSeconds(_: f64) -> u8;
}

/// RTC (real time clock) and CMOS
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct RTC {
    cmos_index: usize,
    cmos_data: [u8; 128],

    // used for cmos entries
    rtc_time: u64,
    last_update: u64,

    // used for periodic interrupt
    next_interrupt: u64,

    // next alarm interrupt
    next_interrupt_alarm_enabled: bool,
    interrupt_alarm_hour: u8,
    interrupt_alarm_minute: u8,
    interrupt_alarm_second: u8,

    periodic_interrupt: bool,

    // corresponds to default value for cmos_a
    periodic_interrupt_time: f64,

    cmos_a: u8,
    cmos_b: u8,
    cmos_c: u8,

    cmos_diag_status: u8,

    nmi_disabled: bool,

    update_interrupt: bool,
    update_interrupt_time: u64,
}

impl RTC {
    pub fn new() -> Self {
        let rtc_time = unsafe { get_epoch_milis() } as u64;
        Self {
            cmos_index: 0,
            cmos_data: [0; 128],
            rtc_time,
            last_update: rtc_time,
            next_interrupt: 0,
            next_interrupt_alarm_enabled: false,
            periodic_interrupt: false,
            interrupt_alarm_hour: 0,
            interrupt_alarm_minute: 0,
            interrupt_alarm_second: 0,
            periodic_interrupt_time: 1000.0 / 1024.0,
            cmos_a: 0x26,
            cmos_b: 2,
            cmos_c: 0,
            cmos_diag_status: 0,
            nmi_disabled: false,
            update_interrupt: false,
            update_interrupt_time: 0,
        }
    }

    pub fn timer(&mut self) -> u64 {
        let time_f = unsafe { get_epoch_milis() };
        let time = time_f as u64;
        // note time is not garantied to be monolitic.
        self.rtc_time += time.saturating_sub(self.last_update);
        self.last_update = time;

        let second = unsafe { getSeconds(self.rtc_time as f64) };
        let minute = unsafe { getMinutes(self.rtc_time as f64) };
        let hour = unsafe { getHours(self.rtc_time as f64) };

        if self.periodic_interrupt && self.next_interrupt < time {
            unsafe { device_raise_irq(8) };
            self.cmos_c |= 1 << 6 | 1 << 7;

            self.next_interrupt += (self.periodic_interrupt_time
                * f64::ceil((time_f - self.next_interrupt as f64) / self.periodic_interrupt_time))
                as u64;
        }
        else if self.next_interrupt_alarm_enabled {
            unsafe { device_raise_irq(8) };
            self.cmos_c |= 1 << 5 | 1 << 7;

            self.next_interrupt_alarm_enabled = false;
        }
        else if self.update_interrupt && self.update_interrupt_time < time {
            unsafe { device_raise_irq(8) };
            self.cmos_c |= 1 << 4 | 1 << 7;

            self.update_interrupt_time = time + 1000; // 1 second
        }

        let mut t = 100;

        if self.periodic_interrupt && self.next_interrupt != 0 {
            t = t.min(self.next_interrupt.saturating_sub(time));
        }
        if self.next_interrupt_alarm_enabled {
            if hour == self.interrupt_alarm_hour && minute == self.interrupt_alarm_minute {
                t = t.min(u64::from(self.interrupt_alarm_second.saturating_sub(second)) * 1000);
            }
        }
        if self.update_interrupt {
            t = t.min(self.update_interrupt_time.saturating_sub(time));
        }

        t
    }
    fn encode_time(&self, t: u8) -> u8 {
        if self.cmos_b & 4 != 0 {
            // binary mode
            t
        }
        else {
            bcd_pack(t)
        }
    }

    fn decode_time(&self, t: u8) -> u8 {
        if self.cmos_b & 4 != 0 {
            // binary mode
            t
        }
        else {
            bcd_unpack(t)
        }
    }

    // TODO
    // - interrupt on update
    // - countdown
    // - letting bios/os set values
    // (none of these are used by seabios or the OSes we're
    // currently testing)
    pub fn port_read(&mut self) -> u8 { self.cmos_port_read(self.cmos_index) }

    pub fn port_write(&mut self, value: u8) { self.cmos_port_write(self.cmos_index, value) }

    pub fn cmos_port_read(&mut self, cmos_index: usize) -> u8 {
        match cmos_index {
            CMOS_RTC_SECONDS => {
                let second = unsafe { getSeconds(self.rtc_time as f64) };
                dbg_log!("RTC read second: {}", second);
                self.encode_time(second)
            },
            CMOS_RTC_MINUTES => {
                let minute = unsafe { getMinutes(self.rtc_time as f64) };
                dbg_log!("RTC read minute: {}", minute);
                self.encode_time(minute)
            },
            CMOS_RTC_HOURS => {
                let hour = unsafe { getHours(self.rtc_time as f64) };
                dbg_log!("RTC read hour: {}", hour);
                // TODO: 12 hour mode
                self.encode_time(hour)
            },
            CMOS_RTC_DAY_WEEK => {
                // getDay returns Sunday..=Saturday 0..=6
                // CMOS store     Sunday..=Saturday 1..=7
                let day_week = unsafe { getDay(self.rtc_time as f64) } + 1;
                dbg_log!("RTC read day of week: {}", day_week);
                self.encode_time(day_week)
            },
            CMOS_RTC_DAY_MONTH => {
                let day_month = unsafe { getDate(self.rtc_time as f64) };
                dbg_log!("RTC read day of month: {}", day_month);
                self.encode_time(day_month)
            },
            CMOS_RTC_MONTH => {
                // getDate returns from 0..=11
                // CMOS stores          1..=12
                let month = unsafe { getMonth(self.rtc_time as f64) } + 1;
                dbg_log!("RTC read month: {}", month);
                self.encode_time(month)
            },
            CMOS_RTC_YEAR => {
                let year: u8 = (unsafe { getFullYear(self.rtc_time as f64) } % 100)
                    .try_into()
                    .unwrap();
                dbg_log!("RTC read year: {}", year);
                self.encode_time(year)
            },

            CMOS_CENTURY | CMOS_CENTURY2 => {
                let century: u8 = (unsafe { getFullYear(self.rtc_time as f64) } / 100)
                    .try_into()
                    .unwrap();
                dbg_log!("RTC read century: {}", century);
                self.encode_time(century)
            },

            CMOS_STATUS_A => {
                if unsafe { microtick() } % 1000.0 >= 999.0 {
                    // Set update-in-progress for one millisecond every second (we
                    // may not have precision higher than that in browser
                    // environments)
                    return self.cmos_a | 0x80;
                }
                self.cmos_a
            },
            CMOS_STATUS_B => self.cmos_b,
            CMOS_STATUS_C => {
                // It is important to know that upon a IRQ 8, Status Register C
                // will contain a bitmask telling which interrupt happened.
                // What is important is that if register C is not read after an
                // IRQ 8, then the interrupt will not happen again.
                unsafe { device_lower_irq(8) };

                dbg_log!("RTC cmos reg C read");
                // Missing IRQF flag
                //return cmos_b & 0x70;
                let c = self.cmos_c;
                self.cmos_c &= !0xF0;
                c
            },
            // CMOS battery charged
            CMOS_STATUS_D => 1 << 7,
            CMOS_DIAG_STATUS => {
                dbg_log!("RTC cmos diagnostic status read");
                self.cmos_diag_status
            },

            CMOS_RTC_HOURS_ALARM => self.encode_time(self.interrupt_alarm_hour),
            CMOS_RTC_MINUTES_ALARM => self.encode_time(self.interrupt_alarm_minute),
            CMOS_RTC_SECONDS_ALARM => self.encode_time(self.interrupt_alarm_second),

            index => {
                dbg_log!("RTC cmos read from index {:#X}", index);
                cmos_read(self, index.into())
            },
        }
    }

    pub fn cmos_port_write(&mut self, cmos_index: usize, data_byte: u8) {
        match cmos_index {
            CMOS_STATUS_A => {
                self.cmos_a = data_byte & 0x7F;
                let freq_div = data_byte & 0xF;
                dbg_log!("RTC cmos write reg_a: {:#X}", data_byte);
                if freq_div != 0 {
                    let freq = 32768u16 >> (freq_div - 1);
                    self.periodic_interrupt_time = 1000.0 / freq as f64;
                    dbg_log!(
                        "RTC Periodic interrupt {}.{:03}Hz or {:.3}ms",
                        freq / 1000,
                        freq % 1000,
                        1000.0 / f32::from(freq),
                    );
                }
            },
            CMOS_STATUS_B => {
                dbg_log!("RTC cmos write reg_b: {:#X}", data_byte);
                self.cmos_b = data_byte;
                if self.cmos_b & 0x80 != 0 {
                    // remove update interrupt flag
                    self.cmos_b &= 0xEF;
                }
                let now = unsafe { get_epoch_milis() } as u64;
                if self.cmos_b & 0x40 != 0 {
                    self.next_interrupt = now;
                }

                if self.cmos_b & 0x20 != 0 {
                    dbg_log!(
                        "RTC alarm scheduled hh:mm:ss={:02}:{:02}:{:02}",
                        self.interrupt_alarm_hour,
                        self.interrupt_alarm_minute,
                        self.interrupt_alarm_second,
                    );

                    self.next_interrupt_alarm_enabled = true;
                }

                if self.cmos_b & 0x10 != 0 {
                    dbg_log!("update interrupt");
                    self.update_interrupt_time = now;
                }
            },
            CMOS_DIAG_STATUS => self.cmos_diag_status = data_byte,

            CMOS_RTC_SECONDS_ALARM => {
                let second = self.decode_time(data_byte);
                if second > 59 {
                    dbg_log!("RTC invalid alarm second {:#X}", second);
                    self.interrupt_alarm_second = 0;
                }
                else {
                    self.interrupt_alarm_second = second;
                }
            },
            CMOS_RTC_MINUTES_ALARM => {
                let minute = self.decode_time(data_byte);
                if minute > 59 {
                    dbg_log!("RTC invalid alarm minute {:#X}", minute);
                    self.interrupt_alarm_minute = 0;
                }
                else {
                    self.interrupt_alarm_minute = minute;
                }
            },
            CMOS_RTC_HOURS_ALARM => {
                // TODO what about 12hours?
                let hour = self.decode_time(data_byte);
                if hour > 23 {
                    dbg_log!("RTC invalid alarm hour {:#X}", hour);
                    self.interrupt_alarm_hour = 0;
                }
                else {
                    self.interrupt_alarm_hour = hour;
                }
            },

            index => {
                dbg_log!("RTC cmos write {}: {:#X}", index, data_byte);
            },
        }

        self.update_interrupt = (self.cmos_b & 0x10) != 0 && (self.cmos_a & 0xF) != 0;
        self.periodic_interrupt = (self.cmos_b & 0x40) != 0 && (self.cmos_a & 0xF) != 0;
    }

    pub fn cmos_read(&self, index: usize) -> u8 {
        self.cmos_data.get(index).copied().unwrap_or_else(|| {
            dbg_log!("RTC cmos read out-of-memory");
            0
        })
    }

    pub fn cmos_write(&mut self, index: usize, value: u8) {
        dbg_log!("RTC cmos write {:#X} <- {:#X}", index, value);
        let Some(mem) = self.cmos_data.get_mut(index)
        else {
            dbg_log!("RTC cmos write out-of-memory");
            return;
        };
        *mem = value
    }
}

const fn bcd_pack(mut n: u8) -> u8 {
    let mut i = 0;
    let mut result = 0;
    let mut digit;

    while n != 0 {
        digit = n % 10;

        result |= digit << (4 * i);
        i += 1;
        n = (n - digit) / 10;
    }

    result
}

const fn bcd_unpack(n: u8) -> u8 {
    let low = n & 0xf;
    let high = (n >> 4) & 0xf;

    dbg_assert!(low < 10);
    dbg_assert!(high < 10);

    low + (10 * high)
}

#[no_mangle]
pub unsafe extern "C" fn rtc_new() -> RTC { RTC::new() }

#[no_mangle]
pub extern "C" fn port_70_write(rtc: &mut RTC, value: usize) {
    rtc.nmi_disabled |= value & 0x80 != 0;
    rtc.cmos_index = value & 0x7F;
}

#[no_mangle]
pub extern "C" fn port_71_read(rtc: &mut RTC) -> u8 { rtc.port_read() }

#[no_mangle]
pub extern "C" fn port_71_write(rtc: &mut RTC, value: u8) { rtc.port_write(value) }

#[no_mangle]
pub extern "C" fn cmos_read(rtc: &RTC, index: usize) -> u8 { rtc.cmos_read(index) }

#[no_mangle]
pub extern "C" fn cmos_write(rtc: &mut RTC, index: usize, value: u8) {
    rtc.cmos_write(index, value)
}

#[no_mangle]
pub extern "C" fn rtc_timer(rtc: &mut RTC) -> u64 { rtc.timer() }
