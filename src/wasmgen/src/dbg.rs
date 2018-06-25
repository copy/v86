#[allow(dead_code)]
pub const DEBUG: bool = true;

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
macro_rules! dbg_assert {
    ($($arg:tt)*) => {
        debug_assert!($($arg)*);
    };
}

#[cfg(target_arch = "wasm32")]
extern "C" {
    pub fn log_from_wasm(ptr: *const u8, len: usize);
    pub fn abort();
}

#[cfg(target_arch = "wasm32")]
use std::string::ToString;

#[cfg(target_arch = "wasm32")]
pub fn _log_to_js_console<T: ToString>(s: T) {
    let s: String = s.to_string();
    let len = s.len();
    unsafe { log_from_wasm(s.as_bytes().as_ptr(), len); }
}

#[cfg(target_arch = "wasm32")]
macro_rules! dbg_log {
    ($fmt:expr) => {
        if DEBUG { _log_to_js_console($fmt); }
    };
    ($fmt:expr, $($arg:tt)*) => {
        if DEBUG { _log_to_js_console(format!($fmt, $($arg)*)); }
    };
}

#[cfg(target_arch = "wasm32")]
macro_rules! dbg_assert {
    ($cond:expr) => {
        if DEBUG && !$cond {
            _log_to_js_console(format!(
                "Assertion failed at {}:{}:{}: '{}'",
                file!(), line!(), column!(),
                stringify!($cond),
            ));
            unsafe { abort(); }
        }
    };
    ($cond:expr, $desc:expr) => {
        if DEBUG && !$cond {
            _log_to_js_console(format!(
                "Assertion failed at {}:{}:{}: '{}' - '{}'",
                file!(), line!(), column!(),
                stringify!($cond),
                $desc,
            ));
            unsafe { abort(); }
        }
    };
}
