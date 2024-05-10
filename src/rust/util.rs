pub trait SafeToU8 {
    fn safe_to_u8(self) -> u8;
}
pub trait SafeToU16 {
    fn safe_to_u16(self) -> u16;
}

impl SafeToU8 for u16 {
    fn safe_to_u8(self) -> u8 {
        dbg_assert!(self <= ::std::u8::MAX as u16);
        self as u8
    }
}

impl SafeToU8 for u32 {
    fn safe_to_u8(self) -> u8 {
        dbg_assert!(self <= ::std::u8::MAX as u32);
        self as u8
    }
}

impl SafeToU8 for i32 {
    fn safe_to_u8(self) -> u8 {
        dbg_assert!(self >= 0 && self <= ::std::u8::MAX as i32);
        self as u8
    }
}

impl SafeToU8 for usize {
    fn safe_to_u8(self) -> u8 {
        dbg_assert!(self <= ::std::u8::MAX as usize);
        self as u8
    }
}

impl SafeToU16 for u32 {
    fn safe_to_u16(self) -> u16 {
        dbg_assert!(self <= ::std::u16::MAX as u32);
        self as u16
    }
}

impl SafeToU16 for i32 {
    fn safe_to_u16(self) -> u16 {
        dbg_assert!(self >= 0 && self <= ::std::u16::MAX as i32);
        self as u16
    }
}

impl SafeToU16 for usize {
    fn safe_to_u16(self) -> u16 {
        dbg_assert!(self <= ::std::u16::MAX as usize);
        self as u16
    }
}

#[allow(dead_code)]
pub const DEBUG: bool = cfg!(debug_assertions);

#[cfg(target_arch = "wasm32")]
extern "C" {
    pub fn log_from_wasm(ptr: *const u8, len: usize);
    pub fn console_log_from_wasm(ptr: *const u8, len: usize);
    pub fn abort();
}

extern "C" {
    pub fn dbg_trace_from_wasm();
}

#[cfg(target_arch = "wasm32")]
use std::string::ToString;

#[cfg(target_arch = "wasm32")]
pub fn log_to_js_console<T: ToString>(s: T) {
    let s = s.to_string();
    let len = s.len();
    unsafe {
        log_from_wasm(s.as_bytes().as_ptr(), len);
    }
}

#[cfg(target_arch = "wasm32")]
pub fn console_log_to_js_console<T: ToString>(s: T) {
    let s = s.to_string();
    let len = s.len();
    unsafe {
        console_log_from_wasm(s.as_bytes().as_ptr(), len);
    }
}

pub fn dbg_trace() {
    if DEBUG {
        unsafe {
            dbg_trace_from_wasm();
        }
    }
}
