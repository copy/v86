use std::alloc;

#[no_mangle]
pub fn call_indirect1(f: fn(u16), x: u16) { f(x); }

#[no_mangle]
pub static mut mem8: *mut u8 = 0 as *mut u8;

#[no_mangle]
pub fn allocate_memory(size: u32) -> u32 {
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) as u32 };
    unsafe {
        mem8 = ptr as *mut u8;
    };
    ptr
}
