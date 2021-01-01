use std::alloc;

#[no_mangle]
pub fn call_indirect1(f: fn(u16), x: u16) { f(x); }

#[no_mangle]
pub static mut mem8: *mut u8 = 0 as *mut u8;
#[no_mangle]
pub static mut mem16: *mut u16 = 0 as *mut u16;
#[no_mangle]
pub static mut mem32s: *mut i32 = 0 as *mut i32;

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
