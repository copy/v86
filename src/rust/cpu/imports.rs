#[no_mangle]
pub fn call_indirect1(f: fn(u16), x: u16) { f(x); }
