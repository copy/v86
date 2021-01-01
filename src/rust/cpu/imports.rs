use std::alloc;
use std::ptr;

#[no_mangle]
pub fn call_indirect1(f: fn(u16), x: u16) { f(x); }

#[no_mangle]
pub static mut mem8: *mut u8 = ptr::null_mut();

#[no_mangle]
pub fn allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(mem8.is_null())
    };
    dbg_log!("Allocate memory size={}m", size >> 20);
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) as u32 };
    unsafe {
        mem8 = ptr as *mut u8;
    };
    ptr
}
