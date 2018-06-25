pub fn write_leb_i32(buf: &mut Vec<u8>, mut v: i32) {
    // Super complex stuff. See the following:
    // https://en.wikipedia.org/wiki/LEB128#Encode_signed_integer
    // http://llvm.org/doxygen/LEB128_8h_source.html#l00048

    let mut more = true;
    let negative = v < 0;
    let size = 32;
    while more {
        let mut byte = (v & 0b1111111) as u8; // get last 7 bits
        v >>= 7; // shift them away from the value
        if negative {
            v |= (!0 as i32) << (size - 7); // extend sign
        }
        let sign_bit = byte & (1 << 6);
        if (v == 0 && sign_bit == 0) || (v == -1 && sign_bit != 0) {
            more = false;
        }
        else {
            byte |= 0b10000000; // turn on MSB
        }
        buf.push(byte);
    }
}

pub fn write_leb_u32(buf: &mut Vec<u8>, mut v: u32) {
    loop {
        let mut byte = v as u8 & 0b01111111; // get last 7 bits
        v >>= 7; // shift them away from the value
        if v != 0 {
            byte |= 0b10000000; // turn on MSB
        }
        buf.push(byte);
        if v == 0 {
            break;
        }
    }
}

pub fn write_fixed_leb16_at_idx(vec: &mut Vec<u8>, idx: usize, x: u16) {
    dbg_assert!(x < (1 << 14)); // we have 14 bits of available space in 2 bytes for leb
    vec[idx    ] = ((x & 0b1111111) | 0b10000000) as u8;
    vec[idx + 1] = (x >> 7) as u8;
}

pub fn write_fixed_leb32_at_idx(vec: &mut Vec<u8>, idx: usize, x: u32) {
    dbg_assert!(x < (1 << 28)); // we have 28 bits of available space in 4 bytes for leb
    vec[idx    ] = (x       & 0b1111111) as u8 | 0b10000000;
    vec[idx + 1] = (x >> 7  & 0b1111111) as u8 | 0b10000000;
    vec[idx + 2] = (x >> 14 & 0b1111111) as u8 | 0b10000000;
    vec[idx + 3] = (x >> 21 & 0b1111111) as u8;
}

pub type PackedStr = (u64, u64, u64);

#[allow(dead_code)]
pub fn pack_str(s: &str) -> PackedStr {
    assert!(s.len() <= 16);
    let mut a: [u8; 24] = [0; 24];
    for (i, ch) in s.char_indices() {
        a[i] = ch as u8;
    }

    unsafe { ::std::mem::transmute(a) }
}

pub fn unpack_str(s: PackedStr) -> String {
    let mut buf = String::with_capacity(24);
    let bytes: [u8; 24] = unsafe { ::std::mem::transmute(s) };
    for i in 0..24 {
        if bytes[i] == 0 {
            break;
        }
        buf.push(bytes[i] as char);
    }
    buf
}

#[allow(dead_code)]
pub const DEBUG: bool = true;

#[cfg(target_arch = "wasm32")]
extern "C" {
    pub fn log_from_wasm(ptr: *const u8, len: usize);
    pub fn abort();
}

#[cfg(target_arch = "wasm32")]
use std::string::ToString;

#[cfg(target_arch = "wasm32")]
pub fn _log_to_js_console<T: ToString>(s: T) {
    let s: String = s.to_string();
    let len = s.len();
    unsafe { log_from_wasm(s.as_bytes().as_ptr(), len); }
}

#[cfg(test)]
mod tests {
    use ::util::*;

    #[test]
    fn packed_strs() {
        let pstr = pack_str("foo");
        assert_eq!("foo", unpack_str(pstr));

        let pstr = pack_str("abcdefghijkl");
        assert_eq!("abcdefghijkl", unpack_str(pstr));
    }

}
