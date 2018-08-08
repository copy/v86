#[no_mangle]
pub unsafe extern "C" fn run_instruction(opcode: u32) { ::gen::interpreter::run(opcode) }
#[no_mangle]
pub unsafe extern "C" fn run_instruction0f_16(opcode: u32) {
    ::gen::interpreter0f_16::run(opcode as u8)
}
#[no_mangle]
pub unsafe extern "C" fn run_instruction0f_32(opcode: u32) {
    ::gen::interpreter0f_32::run(opcode as u8)
}

#[no_mangle]
pub fn sqrt(x: f64) -> f64 { x.sqrt() }

#[no_mangle]
pub fn sqrtf(x: f32) -> f32 { x.sqrt() }

#[no_mangle]
pub fn profiler_stat_increment(stat: u32) {}

#[no_mangle]
pub fn profiler_stat_increment_by(stat: u32, by: u32) {}

#[no_mangle]
pub fn call_indirect1(f: fn(u16), x: u16) { f(x); }

macro_rules! dbg_assert_c {
    ($fmt:expr) => {
        dbg_assert!($fmt != 0);
    };
    ($fmt:expr, $($arg:tt)*) => {
        dbg_assert!($fmt != 0, $arg);
    };
}
macro_rules! dbg_log_c {
    ($fmt:expr) => {};
    ($fmt:expr, $($arg:tt)*) => {};
}
macro_rules! assert_c {
    ($fmt:expr) => {
        assert!($fmt != 0);
    };
    ($fmt:expr, $($arg:tt)*) => {
        assert!($fmt != 0, $arg);
    };
}
