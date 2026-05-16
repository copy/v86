pub fn increment_instruction_pointer(eip: i32, delta: i32, is_asize_32: bool, cs: i32) -> i32 {
    eip.wrapping_add(if is_asize_32 {
        delta
    }
    else {
        ((eip - cs + delta) & 0xFFFF) - ((eip - cs) & 0xFFFF)
    })
}
