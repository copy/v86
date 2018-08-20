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
        debug_assert!($($arg)*);
    };
}

#[cfg(target_arch = "wasm32")]
#[allow(unused_macros)]
macro_rules! console_log {
    ($fmt:expr) => {
        {
            use ::util::{ console_log_to_js_console };
            console_log_to_js_console($fmt);
        }
    };
    ($fmt:expr, $($arg:tt)*) => {
        {
            use ::util::{ console_log_to_js_console };
            console_log_to_js_console(format!($fmt, $($arg)*));
        }
    };
}

#[cfg(target_arch = "wasm32")]
#[allow(unused_macros)]
macro_rules! dbg_log {
    ($fmt:expr) => {
        {
            use ::util::{ DEBUG, log_to_js_console };
            if DEBUG { log_to_js_console($fmt); }
        }
    };
    ($fmt:expr, $($arg:tt)*) => {
        {
            use ::util::{ DEBUG, log_to_js_console };
            if DEBUG { log_to_js_console(format!($fmt, $($arg)*)); }
        }
    };
}

#[cfg(target_arch = "wasm32")]
#[allow(unused_macros)]
macro_rules! dbg_assert {
    ($cond:expr) => {{
        use util::{abort, log_to_js_console, DEBUG};
        if DEBUG && !$cond {
            log_to_js_console(format!(
                "Assertion failed at {}:{}:{}: '{}'",
                file!(),
                line!(),
                column!(),
                stringify!($cond),
            ));
            #[allow(unused_unsafe)]
            unsafe {
                abort();
            }
        }
    }};
    ($cond:expr, $desc:expr) => {{
        use util::{abort, log_to_js_console, DEBUG};
        if DEBUG && !$cond {
            log_to_js_console(format!(
                "Assertion failed at {}:{}:{}: '{}' - '{}'",
                file!(),
                line!(),
                column!(),
                stringify!($cond),
                $desc,
            ));
            #[allow(unused_unsafe)]
            unsafe {
                abort();
            }
        }
    }};
}
