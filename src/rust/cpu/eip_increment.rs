pub fn increment_instruction_pointer(eip: i32, delta: i32, is_asize_32: bool, cs: i32) -> i32 {
    if !is_asize_32 {
        let offset = eip.wrapping_sub(cs) & 0xFFFF;
        eip.wrapping_add((offset.wrapping_add(delta) & 0xFFFF) - offset)
    }
    else {
        eip.wrapping_add(delta)
    }
}
