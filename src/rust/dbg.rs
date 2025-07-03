#[allow(dead_code)]
pub const DEBUG: bool = cfg!(debug_assertions);

#[cfg(target_arch = "wasm32")]
extern "C" {
    pub fn log_from_wasm(ptr: *const u8, len: usize);
    pub fn console_log_from_wasm(ptr: *const u8, len: usize);
    pub fn dbg_trace_from_wasm();
}

#[cfg(target_arch = "wasm32")]
pub fn log_to_js_console<T: std::string::ToString>(s: T) {
    let s = s.to_string();
    let len = s.len();
    unsafe {
        log_from_wasm(s.as_bytes().as_ptr(), len);
    }
}

#[cfg(target_arch = "wasm32")]
pub fn console_log_to_js_console<T: std::string::ToString>(s: T) {
    let s = s.to_string();
    let len = s.len();
    unsafe {
        console_log_from_wasm(s.as_bytes().as_ptr(), len);
    }
}

#[cfg(target_arch = "wasm32")]
pub fn dbg_trace() {
    if DEBUG {
        unsafe {
            dbg_trace_from_wasm();
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn dbg_trace() {}

#[allow(unused_macros)]
macro_rules! dbg_log {
    ($fmt:expr) => {
        println!($fmt);
    };
    ($fmt:expr, $($arg:tt)*) => {
        println!($fmt, $($arg)*);
    }
}

#[allow(unused_macros)]
macro_rules! console_log {
    ($fmt:expr) => {
        println!($fmt);
    };
    ($fmt:expr, $($arg:tt)*) => {
        println!($fmt, $($arg)*);
    }
}

#[allow(unused_macros)]
macro_rules! dbg_assert {
    ($($arg:tt)*) => {
        debug_assert!($($arg)*)
    };
}

#[cfg(target_arch = "wasm32")]
#[allow(unused_macros)]
macro_rules! console_log {
    ($fmt:expr) => {
        {
            crate::dbg::console_log_to_js_console($fmt);
        }
    };
    ($fmt:expr, $($arg:tt)*) => {
        {
            crate::dbg::console_log_to_js_console(format!($fmt, $($arg)*));
        }
    };
}

#[cfg(target_arch = "wasm32")]
#[allow(unused_macros)]
macro_rules! dbg_log {
    ($fmt:expr) => {
        {
            use crate::dbg::{ DEBUG, log_to_js_console };
            if DEBUG { log_to_js_console($fmt); }
        }
    };
    ($fmt:expr, $($arg:tt)*) => {
        {
            use crate::dbg::{ DEBUG, log_to_js_console };
            if DEBUG { log_to_js_console(format!($fmt, $($arg)*)); }
        }
    };
}
