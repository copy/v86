use crate::cpu::cpu::translate_address_system_read;

#[no_mangle]
pub unsafe fn translate_address_system_read_js(addr: i32) -> u32 {
    translate_address_system_read(addr).unwrap()
}
