pub fn increment_instruction_pointer(eip: i32, delta: i32, is_asize_32: bool) -> i32 {
    if !is_asize_32 {
        let offset = eip & 0xFFFF;
        eip + (((offset.wrapping_add(delta)) & 0xFFFF) - offset)
    }
    else {
        eip.wrapping_add(delta)
    }
}
