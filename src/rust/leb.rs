pub fn write_leb_i32(buf: &mut Vec<u8>, v: i32) { write_leb_i64(buf, v as i64); }

pub fn write_leb_i64(buf: &mut Vec<u8>, mut v: i64) {
    // https://en.wikipedia.org/wiki/LEB128#Encode_signed_integer
    loop {
        let mut byte = v as u8 & 0b0111_1111;
        v >>= 7;
        let sign = byte & (1 << 6);
        let done = v == 0 && sign == 0 || v == -1 && sign != 0;
        if !done {
            byte |= 0b1000_0000;
        }
        buf.push(byte);
        if done {
            break;
        }
    }
}

pub fn write_leb_u32(buf: &mut Vec<u8>, mut v: u32) {
    loop {
        let mut byte = v as u8 & 0b0111_1111;
        v >>= 7;
        if v != 0 {
            byte |= 0b1000_0000;
        }
        buf.push(byte);
        if v == 0 {
            break;
        }
    }
}

pub fn write_fixed_leb16_at_idx(vec: &mut Vec<u8>, idx: usize, x: u16) {
    dbg_assert!(x < (1 << 14)); // we have 14 bits of available space in 2 bytes for leb
    vec[idx] = ((x & 0b1111111) | 0b10000000) as u8;
    vec[idx + 1] = (x >> 7) as u8;
}

pub fn write_fixed_leb32_at_idx(vec: &mut Vec<u8>, idx: usize, x: u32) {
    dbg_assert!(x < (1 << 28)); // we have 28 bits of available space in 4 bytes for leb
    vec[idx] = (x & 0b1111111) as u8 | 0b10000000;
    vec[idx + 1] = (x >> 7 & 0b1111111) as u8 | 0b10000000;
    vec[idx + 2] = (x >> 14 & 0b1111111) as u8 | 0b10000000;
    vec[idx + 3] = (x >> 21 & 0b1111111) as u8;
}
