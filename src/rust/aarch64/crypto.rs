//! The crypto extension of profile v86-aarch64-v1 (docs/arm64-virt-android16-plan.md
//! P2.11): AESE, AESD, AESMC, AESIMC; SHA1C/P/M/H/SU0/SU1; SHA256H/H2/SU0/SU1
//! (PMULL is in simd.rs). Scalar helpers on V registers, as the Arm ARM's
//! pseudocode writes them; the JIT calls the same ones (P6).

use crate::aarch64::decode::bits;
use crate::aarch64::execute::Flow;
use crate::aarch64::simd::{set_vreg, vreg};

// ---- AES

const fn gf_mul(a: u8, b: u8) -> u8 {
    let (mut a, mut b, mut result) = (a, b, 0u8);
    while b != 0 {
        if b & 1 != 0 {
            result ^= a;
        }
        a = if a & 0x80 != 0 { a << 1 ^ 0x1B } else { a << 1 };
        b >>= 1;
    }
    result
}

const fn sbox() -> [u8; 256] {
    let mut table = [0u8; 256];
    let mut x = 0;
    while x < 256 {
        // the multiplicative inverse (x^254), then the affine transformation
        let mut inverse = 1u8;
        let mut i = 0;
        while i < 254 {
            inverse = gf_mul(inverse, x as u8);
            i += 1;
        }
        if x == 0 {
            inverse = 0;
        }
        let b = inverse;
        table[x] =
            b ^ b.rotate_left(1) ^ b.rotate_left(2) ^ b.rotate_left(3) ^ b.rotate_left(4) ^ 0x63;
        x += 1;
    }
    table
}

const fn inverse_sbox() -> [u8; 256] {
    let forward = sbox();
    let mut table = [0u8; 256];
    let mut x = 0;
    while x < 256 {
        table[forward[x] as usize] = x as u8;
        x += 1;
    }
    table
}

static SBOX: [u8; 256] = sbox();
static INVERSE_SBOX: [u8; 256] = inverse_sbox();
const SHIFT_ROWS: [usize; 16] = [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11];
const INVERSE_SHIFT_ROWS: [usize; 16] = [0, 13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3];

fn bytes(value: u128) -> [u8; 16] { value.to_le_bytes() }
fn from_bytes(bytes: [u8; 16]) -> u128 { u128::from_le_bytes(bytes) }

/// AESE (SubBytes(ShiftRows(d ^ n))) or AESD (InvSubBytes(InvShiftRows(d ^ n)))
pub fn aes_round(state: u128, key: u128, decrypt: bool) -> u128 {
    let input = bytes(state ^ key);
    let (rows, sbox) =
        if decrypt { (&INVERSE_SHIFT_ROWS, &INVERSE_SBOX) } else { (&SHIFT_ROWS, &SBOX) };
    let mut output = [0u8; 16];
    for i in 0..16 {
        output[i] = sbox[input[rows[i]] as usize];
    }
    from_bytes(output)
}

/// AESMC (MixColumns) or AESIMC (InvMixColumns), the four columns (the
/// 32-bit lanes) at once: forward, each byte is a ^ t ^ xtime(a ^ a'), t
/// the column's bytes xored and a' the next byte in it; the inverse first
/// adds xtime(xtime(a ^ a'')), a'' the byte two on (FIPS-197 5.3.3's
/// factorisation of InvMixColumns)
pub fn aes_mix(state: u128, inverse: bool) -> u128 {
    const LOW_BITS: u128 = 0x0101_0101_0101_0101_0101_0101_0101_0101;
    // each byte times x in GF(2^8)
    let xtime = |x: u128| (x << 1) & !(LOW_BITS * 0x01) ^ (x >> 7 & LOW_BITS) * 0x1B;
    // each 32-bit lane's bytes rotated by `bytes` toward the low one
    let rotate = |x: u128, bytes: u32| {
        let (right, left) = (8 * bytes, 32 - 8 * bytes);
        let lanes = |m: u32| u128::from(m) * 0x0000_0001_0000_0001_0000_0001_0000_0001;
        (x >> right) & lanes(u32::MAX >> right) | (x << left) & lanes(u32::MAX << left)
    };
    let mut a = state;
    if inverse {
        a ^= xtime(xtime(a ^ rotate(a, 2)));
    }
    let next = rotate(a, 1);
    let t = a ^ next ^ rotate(a, 2) ^ rotate(a, 3);
    a ^ t ^ xtime(a ^ next)
}

/// (tests) aes_mix as the Arm ARM's pseudocode writes it, byte by byte
#[cfg(test)]
fn aes_mix_reference(state: u128, inverse: bool) -> u128 {
    let input = bytes(state);
    let m: [u8; 4] = if inverse { [14, 11, 13, 9] } else { [2, 3, 1, 1] };
    let mut output = [0u8; 16];
    for c in 0..4 {
        let column = &input[4 * c..4 * c + 4];
        for r in 0..4 {
            output[4 * c + r] = gf_mul(column[r], m[0])
                ^ gf_mul(column[(r + 1) % 4], m[1])
                ^ gf_mul(column[(r + 2) % 4], m[2])
                ^ gf_mul(column[(r + 3) % 4], m[3]);
        }
    }
    from_bytes(output)
}

pub fn aes(word: u32) -> Flow {
    let d = word & 31;
    let n = word >> 5 & 31;
    let result = match bits(word, 16, 12) {
        0b00100 => aes_round(vreg(d), vreg(n), false),
        0b00101 => aes_round(vreg(d), vreg(n), true),
        0b00110 => aes_mix(vreg(n), false),
        _ => aes_mix(vreg(n), true),
    };
    set_vreg(d, result);
    Flow::Next
}

// ---- SHA

fn words(value: u128) -> [u32; 4] {
    [
        value as u32,
        (value >> 32) as u32,
        (value >> 64) as u32,
        (value >> 96) as u32,
    ]
}
fn from_words(w: [u32; 4]) -> u128 {
    w[0] as u128 | (w[1] as u128) << 32 | (w[2] as u128) << 64 | (w[3] as u128) << 96
}

pub(crate) fn choose(x: u32, y: u32, z: u32) -> u32 { (y ^ z) & x ^ z }
pub(crate) fn parity(x: u32, y: u32, z: u32) -> u32 { x ^ y ^ z }
pub(crate) fn majority(x: u32, y: u32, z: u32) -> u32 { x & y | (x | y) & z }

/// SHA1C (choose), SHA1P (parity), SHA1M (majority): four rounds
pub fn sha1_hash(abcd: u128, e: u32, w: u128, f: fn(u32, u32, u32) -> u32) -> u128 {
    let mut x = words(abcd);
    let mut y = e;
    let w = words(w);
    for i in 0..4 {
        let t = f(x[1], x[2], x[3]);
        y = y
            .wrapping_add(x[0].rotate_left(5))
            .wrapping_add(t)
            .wrapping_add(w[i]);
        x[1] = x[1].rotate_left(30);
        // (Y:X rotated left by 32)
        let top = x[3];
        x = [y, x[0], x[1], x[2]];
        y = top;
    }
    from_words(x)
}

/// SHA256H (part 1: the new X) and SHA256H2 (the new Y)
pub fn sha256_hash(x: u128, y: u128, w: u128, part1: bool) -> u128 {
    let (mut x, mut y, w) = (words(x), words(y), words(w));
    for e in 0..4 {
        let chs = choose(y[0], y[1], y[2]);
        let maj = majority(x[0], x[1], x[2]);
        let sigma1 = y[0].rotate_right(6) ^ y[0].rotate_right(11) ^ y[0].rotate_right(25);
        let sigma0 = x[0].rotate_right(2) ^ x[0].rotate_right(13) ^ x[0].rotate_right(22);
        let t = y[3]
            .wrapping_add(sigma1)
            .wrapping_add(chs)
            .wrapping_add(w[e]);
        x[3] = t.wrapping_add(x[3]);
        y[3] = t.wrapping_add(sigma0).wrapping_add(maj);
        // (Y:X rotated left by 32)
        let (x3, y3) = (x[3], y[3]);
        x = [y3, x[0], x[1], x[2]];
        y = [x3, y[0], y[1], y[2]];
    }
    from_words(if part1 { x } else { y })
}

pub fn sha3(word: u32) -> Flow {
    let d = word & 31;
    let n = word >> 5 & 31;
    let m = word >> 16 & 31;
    let (vd, vn, vm) = (vreg(d), vreg(n), vreg(m));
    let result = match bits(word, 14, 12) {
        0b000 => sha1_hash(vd, vn as u32, vm, choose),
        0b001 => sha1_hash(vd, vn as u32, vm, parity),
        0b010 => sha1_hash(vd, vn as u32, vm, majority),
        0b011 => sha1su0(vd, vn, vm),
        0b100 => sha256_hash(vd, vn, vm, true),
        0b101 => sha256_hash(vn, vd, vm, false),
        _ => sha256su1(vd, vn, vm),
    };
    set_vreg(d, result);
    Flow::Next
}

/// SHA1SU0
pub fn sha1su0(vd: u128, vn: u128, vm: u128) -> u128 { (vn << 64 | vd >> 64) ^ vd ^ vm }

/// SHA256SU1
pub fn sha256su1(vd: u128, vn: u128, vm: u128) -> u128 {
    let t0 = words((vm as u32 as u128) << 96 | vn >> 32);
    let op1 = words(vd);
    let sigma = |x: u32| x.rotate_right(17) ^ x.rotate_right(19) ^ (x >> 10);
    let mut r = [0u32; 4];
    let t1 = words(vm);
    for e in 0..2 {
        r[e] = sigma(t1[2 + e]).wrapping_add(op1[e]).wrapping_add(t0[e]);
    }
    for e in 2..4 {
        r[e] = sigma(r[e - 2]).wrapping_add(op1[e]).wrapping_add(t0[e]);
    }
    from_words(r)
}

pub fn sha2(word: u32) -> Flow {
    let d = word & 31;
    let n = word >> 5 & 31;
    let (vd, vn) = (vreg(d), vreg(n));
    let result = match bits(word, 16, 12) {
        0b00000 => (vn as u32).rotate_left(30) as u128,
        0b00001 => sha1su1(vd, vn),
        _ => sha256su0(vd, vn),
    };
    set_vreg(d, result);
    Flow::Next
}

/// SHA1SU1
pub fn sha1su1(vd: u128, vn: u128) -> u128 {
    let t = words(vd ^ vn >> 32);
    let mut r = [
        t[0].rotate_left(1),
        t[1].rotate_left(1),
        t[2].rotate_left(1),
        t[3].rotate_left(1),
    ];
    r[3] ^= t[0].rotate_left(2);
    from_words(r)
}

/// SHA256SU0
pub fn sha256su0(vd: u128, vn: u128) -> u128 {
    let t = words((vn as u32 as u128) << 96 | vd >> 32);
    let op1 = words(vd);
    let mut r = [0u32; 4];
    for e in 0..4 {
        let x = t[e];
        r[e] = (x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3)).wrapping_add(op1[e]);
    }
    from_words(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aes_tables() {
        assert_eq!(SBOX[0x00], 0x63);
        assert_eq!(SBOX[0x53], 0xED);
        assert_eq!(INVERSE_SBOX[0x63], 0x00);
        // FIPS-197 C.1, round 1: start of round, after SubBytes/ShiftRows (as AESE with a zero key)
        let state = u128::from_le_bytes(
            *b"\x00\x10\x20\x30\x40\x50\x60\x70\x80\x90\xa0\xb0\xc0\xd0\xe0\xf0",
        );
        let after = aes_round(state, 0, false);
        assert_eq!(
            after.to_le_bytes(),
            *b"\x63\x53\xe0\x8c\x09\x60\xe1\x04\xcd\x70\xb7\x51\xba\xca\xd0\xe7"
        );
        let mixed = aes_mix(after, false);
        assert_eq!(
            mixed.to_le_bytes(),
            *b"\x5f\x72\x64\x15\x57\xf5\xbc\x92\xf7\xbe\x3b\x29\x1d\xb9\xf9\x1a"
        );
        assert_eq!(aes_mix(mixed, true), after);
        assert_eq!(aes_round(aes_round(state, 0, false), 0, true), state);
    }

    #[test]
    fn aes_mix_matches_reference() {
        let mut x = 0x9E37_79B9_7F4A_7C15_F39C_C060_5CED_C834u128;
        for _ in 0..10000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            for inverse in [false, true] {
                assert_eq!(
                    aes_mix(x, inverse),
                    aes_mix_reference(x, inverse),
                    "{x:032x} {inverse}"
                );
            }
        }
    }
}
