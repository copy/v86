use std::alloc;

#[no_mangle]
pub fn call_indirect1(f: fn(u16), x: u16) { f(x); }

extern "C" {
    #[no_mangle]
    static mut mem8: *mut u8;
    #[no_mangle]
    static mut mem16: *mut u16;
    #[no_mangle]
    static mut mem32s: *mut i32;
}

#[no_mangle]
pub fn allocate_memory(size: u32) -> u32 {
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) as u32 };
    unsafe {
        mem8 = ptr as *mut u8;
        mem16 = ptr as *mut u16;
        mem32s = ptr as *mut i32;
    };
    ptr
}

macro_rules! dbg_log_c {
    ($fmt:expr) => {{
        dbg_log!($fmt);
    }};
    ($fmt:expr, $($arg:tt)*) => {{
        // TODO: Arguments
        dbg_log!($fmt);
    }};
}

macro_rules! c_comment {
    ($fmt:expr) => {{}};
}
