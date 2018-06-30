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
#[allow(unused_macros)]
macro_rules! dbg_log {
    ($fmt:expr) => {
        use ::util::{ DEBUG, _log_to_js_console };
        if DEBUG { _log_to_js_console($fmt); }
    };
    ($fmt:expr, $($arg:tt)*) => {
        use ::util::{ DEBUG, _log_to_js_console };
        if DEBUG { _log_to_js_console(format!($fmt, $($arg)*)); }
    };
}

#[cfg(target_arch = "wasm32")]
#[allow(unused_macros)]
macro_rules! dbg_assert {
    ($cond:expr) => {
        use ::util::{ DEBUG, _log_to_js_console, abort };
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
        use ::util::{ DEBUG, _log_to_js_console, abort };
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
