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
            use crate::util::{ console_log_to_js_console };
            console_log_to_js_console($fmt);
        }
    };
    ($fmt:expr, $($arg:tt)*) => {
        {
            use crate::util::{ console_log_to_js_console };
            console_log_to_js_console(format!($fmt, $($arg)*));
        }
    };
}

#[cfg(target_arch = "wasm32")]
#[allow(unused_macros)]
macro_rules! dbg_log {
    ($fmt:expr) => {
        {
            use crate::util::{ DEBUG, log_to_js_console };
            if DEBUG { log_to_js_console($fmt); }
        }
    };
    ($fmt:expr, $($arg:tt)*) => {
        {
            use crate::util::{ DEBUG, log_to_js_console };
            if DEBUG { log_to_js_console(format!($fmt, $($arg)*)); }
        }
    };
}
