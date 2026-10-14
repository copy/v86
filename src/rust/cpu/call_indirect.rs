#[no_mangle]
pub fn call_indirect1(f: fn(u16), x: u16) { f(x); }
/// The x64 page tier's functions return the instructions they retired.
#[no_mangle]
pub fn call_indirect1_ret(f: fn(u16) -> i32, x: u16) -> i32 { f(x) }
