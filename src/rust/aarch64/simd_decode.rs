//! The scalar FP, AdvSIMD and crypto part of the A64 decoder
//! (docs/arm64-virt-android16-plan.md P2.5-P2.8, P2.11): the classes of the
//! encoding index's "Data Processing -- Scalar Floating-Point and Advanced
//! SIMD" group and the AdvSIMD structure loads and stores. Each class
//! function checks a word against the class's allocated encodings for profile
//! v86-aarch64-v1 (v8.0 with FP, AdvSIMD, AES, PMULL, SHA1, SHA256; no FP16,
//! RDM, DotProd, FCMA, JSCVT, FRINTTS, SHA512, SHA3, SM3/SM4) and names
//! the instruction; the interpreter (simd.rs, fpu.rs) reads the operands
//! from the word again. A name ends in "2" for the second-half forms (Q = 1)
//! of the long, wide and narrow instructions, as llvm-mc prints them.

use crate::aarch64::decode::{bits, Inst, Op};

macro_rules! q2 {
    ($q:expr, $name:literal) => {
        if $q {
            concat!($name, "2")
        }
        else {
            $name
        }
    };
}

/// A word of the FP/SIMD data processing group (bits 28:25 = x111)
pub fn data_processing(word: u32) -> Inst {
    match classify(word) {
        Some((op, _)) => {
            let mut i = Inst::new(op, word);
            i.imm = word as u64;
            i
        },
        None => Inst::UNDEF,
    }
}

/// The class and name of a FP/SIMD data processing word
pub fn classify(word: u32) -> Option<(Op, &'static str)> {
    let m = |mask: u32, value: u32| word & mask == value;
    let r = |op: Op, name: Option<&'static str>| name.map(|n| (op, n));
    if word >> 28 & 1 == 0 {
        // vector AdvSIMD (0 Q U 0111x ...)
        if word >> 31 != 0 {
            return None;
        }
        if m(0xFF3E_0C00, 0x4E28_0800) {
            return r(Op::CryptoAes, aes(word));
        }
        if m(0xBF20_8C00, 0x0E00_0000) {
            return r(Op::SimdTable, table(word));
        }
        if m(0xBF20_8C00, 0x0E00_0800) {
            return r(Op::SimdPermute, permute(word));
        }
        if m(0xBF20_8400, 0x2E00_0000) {
            return r(Op::SimdExtract, extract(word));
        }
        if m(0x9FE0_8400, 0x0E00_0400) {
            return r(Op::SimdCopy, copy(word));
        }
        if m(0x9F20_0400, 0x0E20_0400) {
            return r(Op::SimdThreeSame, three_same(word));
        }
        if m(0x9F20_0C00, 0x0E20_0000) {
            return r(Op::SimdThreeDiff, three_different(word));
        }
        if m(0x9F3E_0C00, 0x0E20_0800) {
            return r(Op::SimdTwoMisc, two_misc(word));
        }
        if m(0x9F3E_0C00, 0x0E30_0800) {
            return r(Op::SimdAcross, across(word));
        }
        if m(0x9FF8_0400, 0x0F00_0400) {
            return r(Op::SimdModImm, modified_immediate(word));
        }
        if m(0x9F80_0400, 0x0F00_0400) {
            return r(Op::SimdShiftImm, shift_immediate(word));
        }
        if m(0x9F00_0400, 0x0F00_0000) {
            return r(Op::SimdIndexed, indexed(word));
        }
        return None;
    }
    if word >> 30 & 1 != 0 {
        // scalar AdvSIMD (01 U 1111x ...)
        if word >> 31 != 0 {
            return None;
        }
        if m(0xFF20_8C00, 0x5E00_0000) {
            return r(Op::CryptoSha3, sha3(word));
        }
        if m(0xFF3E_0C00, 0x5E28_0800) {
            return r(Op::CryptoSha2, sha2(word));
        }
        if m(0xDFE0_8400, 0x5E00_0400) {
            return r(Op::SimdCopy, scalar_copy(word));
        }
        if m(0xDF20_0400, 0x5E20_0400) {
            return r(Op::SimdThreeSame, scalar_three_same(word));
        }
        if m(0xDF20_0C00, 0x5E20_0000) {
            return r(Op::SimdThreeDiff, scalar_three_different(word));
        }
        if m(0xDF3E_0C00, 0x5E20_0800) {
            return r(Op::SimdTwoMisc, scalar_two_misc(word));
        }
        if m(0xDF3E_0C00, 0x5E30_0800) {
            return r(Op::SimdPairwise, scalar_pairwise(word));
        }
        if m(0xDF80_0400, 0x5F00_0400) {
            return r(Op::SimdShiftImm, scalar_shift_immediate(word));
        }
        if m(0xDF00_0400, 0x5F00_0000) {
            return r(Op::SimdIndexed, scalar_indexed(word));
        }
        return None;
    }
    // scalar FP and the conversions (M/sf 0 S 1111x)
    if m(0x5F20_0000, 0x1E00_0000) {
        return r(Op::FpFixed, fp_fixed(word));
    }
    if m(0x5F20_FC00, 0x1E20_0000) {
        return r(Op::FpInt, fp_int(word));
    }
    if m(0x5F00_0000, 0x1F00_0000) {
        return r(Op::FpDp3, fp_dp3(word));
    }
    // (the rest need M = 0, S = 0 and a single or double type: FP16 is not in v1)
    if word >> 31 != 0 || word >> 29 & 1 != 0 {
        return None;
    }
    let ty = bits(word, 23, 22);
    if m(0x5F20_7C00, 0x1E20_4000) {
        return r(Op::FpDp1, fp_dp1(word));
    }
    if ty >= 2 {
        return None;
    }
    if m(0x5F20_3C00, 0x1E20_2000) {
        let name = match (bits(word, 15, 14), bits(word, 4, 0)) {
            // (the zero forms ignore Rm, a should-be-zero field, as QEMU does)
            (0, 0b00000) | (0, 0b01000) => "fcmp",
            (0, 0b10000) | (0, 0b11000) => "fcmpe",
            _ => return None,
        };
        return Some((Op::FpCompare, name));
    }
    if m(0x5F20_1C00, 0x1E20_1000) {
        return if bits(word, 9, 5) == 0 { Some((Op::FpImm, "fmov")) } else { None };
    }
    if m(0x5F20_0C00, 0x1E20_0400) {
        return Some((
            Op::FpCondCompare,
            if word >> 4 & 1 == 0 { "fccmp" } else { "fccmpe" },
        ));
    }
    if m(0x5F20_0C00, 0x1E20_0800) {
        let name = match bits(word, 15, 12) {
            0b0000 => "fmul",
            0b0001 => "fdiv",
            0b0010 => "fadd",
            0b0011 => "fsub",
            0b0100 => "fmax",
            0b0101 => "fmin",
            0b0110 => "fmaxnm",
            0b0111 => "fminnm",
            0b1000 => "fnmul",
            _ => return None,
        };
        return Some((Op::FpDp2, name));
    }
    if m(0x5F20_0C00, 0x1E20_0C00) {
        return Some((Op::FpCondSelect, "fcsel"));
    }
    None
}

// ---- AdvSIMD, vector

fn three_same(word: u32) -> Option<&'static str> {
    let q = word >> 30 & 1 != 0;
    let u = word >> 29 & 1;
    let size = bits(word, 23, 22);
    let opcode = bits(word, 15, 11);
    if opcode >= 0b11000 {
        let a = size >> 1;
        if size & 1 == 1 && !q {
            return None;
        }
        return Some(match (u, a, opcode) {
            (0, 0, 0b11000) => "fmaxnm",
            (0, 0, 0b11001) => "fmla",
            (0, 0, 0b11010) => "fadd",
            (0, 0, 0b11011) => "fmulx",
            (0, 0, 0b11100) => "fcmeq",
            (0, 0, 0b11110) => "fmax",
            (0, 0, 0b11111) => "frecps",
            (0, 1, 0b11000) => "fminnm",
            (0, 1, 0b11001) => "fmls",
            (0, 1, 0b11010) => "fsub",
            (0, 1, 0b11110) => "fmin",
            (0, 1, 0b11111) => "frsqrts",
            (1, 0, 0b11000) => "fmaxnmp",
            (1, 0, 0b11010) => "faddp",
            (1, 0, 0b11011) => "fmul",
            (1, 0, 0b11100) => "fcmge",
            (1, 0, 0b11101) => "facge",
            (1, 0, 0b11110) => "fmaxp",
            (1, 0, 0b11111) => "fdiv",
            (1, 1, 0b11000) => "fminnmp",
            (1, 1, 0b11010) => "fabd",
            (1, 1, 0b11100) => "fcmgt",
            (1, 1, 0b11101) => "facgt",
            (1, 1, 0b11110) => "fminp",
            _ => return None,
        });
    }
    if opcode == 0b00011 {
        return Some(
            ["and", "bic", "orr", "orn", "eor", "bsl", "bit", "bif"][(u << 2 | size) as usize],
        );
    }
    // (the rule on the element size: not 64-bit, 64-bit only as 2D, only H and S, only B)
    enum Sizes {
        No64,
        Q64,
        HS,
        B,
    }
    use Sizes::*;
    let (name, sizes) = match (u, opcode) {
        (0, 0b00000) => ("shadd", No64),
        (0, 0b00001) => ("sqadd", Q64),
        (0, 0b00010) => ("srhadd", No64),
        (0, 0b00100) => ("shsub", No64),
        (0, 0b00101) => ("sqsub", Q64),
        (0, 0b00110) => ("cmgt", Q64),
        (0, 0b00111) => ("cmge", Q64),
        (0, 0b01000) => ("sshl", Q64),
        (0, 0b01001) => ("sqshl", Q64),
        (0, 0b01010) => ("srshl", Q64),
        (0, 0b01011) => ("sqrshl", Q64),
        (0, 0b01100) => ("smax", No64),
        (0, 0b01101) => ("smin", No64),
        (0, 0b01110) => ("sabd", No64),
        (0, 0b01111) => ("saba", No64),
        (0, 0b10000) => ("add", Q64),
        (0, 0b10001) => ("cmtst", Q64),
        (0, 0b10010) => ("mla", No64),
        (0, 0b10011) => ("mul", No64),
        (0, 0b10100) => ("smaxp", No64),
        (0, 0b10101) => ("sminp", No64),
        (0, 0b10110) => ("sqdmulh", HS),
        (0, 0b10111) => ("addp", Q64),
        (1, 0b00000) => ("uhadd", No64),
        (1, 0b00001) => ("uqadd", Q64),
        (1, 0b00010) => ("urhadd", No64),
        (1, 0b00100) => ("uhsub", No64),
        (1, 0b00101) => ("uqsub", Q64),
        (1, 0b00110) => ("cmhi", Q64),
        (1, 0b00111) => ("cmhs", Q64),
        (1, 0b01000) => ("ushl", Q64),
        (1, 0b01001) => ("uqshl", Q64),
        (1, 0b01010) => ("urshl", Q64),
        (1, 0b01011) => ("uqrshl", Q64),
        (1, 0b01100) => ("umax", No64),
        (1, 0b01101) => ("umin", No64),
        (1, 0b01110) => ("uabd", No64),
        (1, 0b01111) => ("uaba", No64),
        (1, 0b10000) => ("sub", Q64),
        (1, 0b10001) => ("cmeq", Q64),
        (1, 0b10010) => ("mls", No64),
        (1, 0b10011) => ("pmul", B),
        (1, 0b10100) => ("umaxp", No64),
        (1, 0b10101) => ("uminp", No64),
        (1, 0b10110) => ("sqrdmulh", HS),
        _ => return None,
    };
    let valid = match sizes {
        No64 => size != 3,
        Q64 => size != 3 || q,
        HS => size == 1 || size == 2,
        B => size == 0,
    };
    if valid {
        Some(name)
    }
    else {
        None
    }
}

fn three_different(word: u32) -> Option<&'static str> {
    let q = word >> 30 & 1 != 0;
    let u = word >> 29 & 1;
    let size = bits(word, 23, 22);
    let opcode = bits(word, 15, 12);
    let name = match (u, opcode) {
        (0, 0b0000) => q2!(q, "saddl"),
        (0, 0b0001) => q2!(q, "saddw"),
        (0, 0b0010) => q2!(q, "ssubl"),
        (0, 0b0011) => q2!(q, "ssubw"),
        (0, 0b0100) => q2!(q, "addhn"),
        (0, 0b0101) => q2!(q, "sabal"),
        (0, 0b0110) => q2!(q, "subhn"),
        (0, 0b0111) => q2!(q, "sabdl"),
        (0, 0b1000) => q2!(q, "smlal"),
        (0, 0b1001) => q2!(q, "sqdmlal"),
        (0, 0b1010) => q2!(q, "smlsl"),
        (0, 0b1011) => q2!(q, "sqdmlsl"),
        (0, 0b1100) => q2!(q, "smull"),
        (0, 0b1101) => q2!(q, "sqdmull"),
        (0, 0b1110) => q2!(q, "pmull"),
        (1, 0b0000) => q2!(q, "uaddl"),
        (1, 0b0001) => q2!(q, "uaddw"),
        (1, 0b0010) => q2!(q, "usubl"),
        (1, 0b0011) => q2!(q, "usubw"),
        (1, 0b0100) => q2!(q, "raddhn"),
        (1, 0b0101) => q2!(q, "uabal"),
        (1, 0b0110) => q2!(q, "rsubhn"),
        (1, 0b0111) => q2!(q, "uabdl"),
        (1, 0b1000) => q2!(q, "umlal"),
        (1, 0b1010) => q2!(q, "umlsl"),
        (1, 0b1100) => q2!(q, "umull"),
        _ => return None,
    };
    let valid = match (u, opcode) {
        (0, 0b1001) | (0, 0b1011) | (0, 0b1101) => size == 1 || size == 2,
        // PMULL: 8-bit, and the 64-bit form (FEAT_PMULL)
        (0, 0b1110) => size == 0 || size == 3,
        _ => size != 3,
    };
    if valid {
        Some(name)
    }
    else {
        None
    }
}

fn two_misc(word: u32) -> Option<&'static str> {
    let q = word >> 30 & 1 != 0;
    let u = word >> 29 & 1;
    let size = bits(word, 23, 22);
    let opcode = bits(word, 16, 12);
    let (a, sz) = (size >> 1, size & 1);
    // FP: the double-precision vector forms are 2D only
    let fp = |name: &'static str| if sz == 1 && !q { None } else { Some(name) };
    match (u, opcode) {
        (0, 0b00000) => (size != 3).then_some("rev64"),
        (0, 0b00001) => (size == 0).then_some("rev16"),
        (0, 0b00010) => (size != 3).then_some("saddlp"),
        (0, 0b00011) => (size != 3 || q).then_some("suqadd"),
        (0, 0b00100) => (size != 3).then_some("cls"),
        (0, 0b00101) => (size == 0).then_some("cnt"),
        (0, 0b00110) => (size != 3).then_some("sadalp"),
        (0, 0b00111) => (size != 3 || q).then_some("sqabs"),
        (0, 0b01000) => (size != 3 || q).then_some("cmgt"),
        (0, 0b01001) => (size != 3 || q).then_some("cmeq"),
        (0, 0b01010) => (size != 3 || q).then_some("cmlt"),
        (0, 0b01011) => (size != 3 || q).then_some("abs"),
        (0, 0b10010) => (size != 3).then_some(q2!(q, "xtn")),
        (0, 0b10100) => (size != 3).then_some(q2!(q, "sqxtn")),
        (1, 0b00000) => (size < 2).then_some("rev32"),
        (1, 0b00010) => (size != 3).then_some("uaddlp"),
        (1, 0b00011) => (size != 3 || q).then_some("usqadd"),
        (1, 0b00100) => (size != 3).then_some("clz"),
        (1, 0b00101) => match size {
            0 => Some("not"),
            1 => Some("rbit"),
            _ => None,
        },
        (1, 0b00110) => (size != 3).then_some("uadalp"),
        (1, 0b00111) => (size != 3 || q).then_some("sqneg"),
        (1, 0b01000) => (size != 3 || q).then_some("cmge"),
        (1, 0b01001) => (size != 3 || q).then_some("cmle"),
        (1, 0b01011) => (size != 3 || q).then_some("neg"),
        (1, 0b10010) => (size != 3).then_some(q2!(q, "sqxtun")),
        (1, 0b10011) => (size != 3).then_some(q2!(q, "shll")),
        (1, 0b10100) => (size != 3).then_some(q2!(q, "uqxtn")),
        _ => match (u, a, opcode) {
            (0, 0, 0b10110) => Some(q2!(q, "fcvtn")),
            (0, 0, 0b10111) => Some(q2!(q, "fcvtl")),
            (0, 0, 0b11000) => fp("frintn"),
            (0, 0, 0b11001) => fp("frintm"),
            (0, 0, 0b11010) => fp("fcvtns"),
            (0, 0, 0b11011) => fp("fcvtms"),
            (0, 0, 0b11100) => fp("fcvtas"),
            (0, 0, 0b11101) => fp("scvtf"),
            (0, 1, 0b01100) => fp("fcmgt"),
            (0, 1, 0b01101) => fp("fcmeq"),
            (0, 1, 0b01110) => fp("fcmlt"),
            (0, 1, 0b01111) => fp("fabs"),
            (0, 1, 0b11000) => fp("frintp"),
            (0, 1, 0b11001) => fp("frintz"),
            (0, 1, 0b11010) => fp("fcvtps"),
            (0, 1, 0b11011) => fp("fcvtzs"),
            (0, 1, 0b11100) => (sz == 0).then_some("urecpe"),
            (0, 1, 0b11101) => fp("frecpe"),
            (1, 0, 0b10110) => (sz == 1).then_some(q2!(q, "fcvtxn")),
            (1, 0, 0b11000) => fp("frinta"),
            (1, 0, 0b11001) => fp("frintx"),
            (1, 0, 0b11010) => fp("fcvtnu"),
            (1, 0, 0b11011) => fp("fcvtmu"),
            (1, 0, 0b11100) => fp("fcvtau"),
            (1, 0, 0b11101) => fp("ucvtf"),
            (1, 1, 0b01100) => fp("fcmge"),
            (1, 1, 0b01101) => fp("fcmle"),
            (1, 1, 0b01111) => fp("fneg"),
            (1, 1, 0b11001) => fp("frinti"),
            (1, 1, 0b11010) => fp("fcvtpu"),
            (1, 1, 0b11011) => fp("fcvtzu"),
            (1, 1, 0b11100) => (sz == 0).then_some("ursqrte"),
            (1, 1, 0b11101) => fp("frsqrte"),
            (1, 1, 0b11111) => fp("fsqrt"),
            _ => None,
        },
    }
}

fn across(word: u32) -> Option<&'static str> {
    let q = word >> 30 & 1 != 0;
    let u = word >> 29 & 1;
    let size = bits(word, 23, 22);
    let opcode = bits(word, 16, 12);
    let integer = size != 3 && (size != 2 || q);
    match (u, opcode) {
        (0, 0b00011) => integer.then_some("saddlv"),
        (0, 0b01010) => integer.then_some("smaxv"),
        (0, 0b11010) => integer.then_some("sminv"),
        (0, 0b11011) => integer.then_some("addv"),
        (1, 0b00011) => integer.then_some("uaddlv"),
        (1, 0b01010) => integer.then_some("umaxv"),
        (1, 0b11010) => integer.then_some("uminv"),
        // FP: 4S only
        (1, 0b01100) if size & 1 == 0 && q => {
            Some(if size >> 1 == 0 { "fmaxnmv" } else { "fminnmv" })
        },
        (1, 0b01111) if size & 1 == 0 && q => Some(if size >> 1 == 0 { "fmaxv" } else { "fminv" }),
        _ => None,
    }
}

fn copy(word: u32) -> Option<&'static str> {
    let q = word >> 30 & 1 != 0;
    let op = word >> 29 & 1;
    let imm5 = bits(word, 20, 16);
    let imm4 = bits(word, 14, 11);
    if imm5 & 0xF == 0 {
        return None;
    }
    let size = imm5.trailing_zeros();
    if op == 1 {
        return q.then_some("ins");
    }
    match imm4 {
        0b0000 => (size != 3 || q).then_some("dup"),
        0b0001 => (size != 3 || q).then_some("dup"),
        0b0011 => q.then_some("ins"),
        0b0101 => (size < 2 || q && size == 2).then_some("smov"),
        0b0111 => (if q { size == 3 } else { size < 3 }).then_some("umov"),
        _ => None,
    }
}

fn modified_immediate(word: u32) -> Option<&'static str> {
    let q = word >> 30 & 1 != 0;
    let op = word >> 29 & 1;
    let cmode = bits(word, 15, 12);
    if word >> 11 & 1 != 0 {
        // (o2: FMOV half precision, FEAT_FP16)
        return None;
    }
    Some(match (op, cmode) {
        (0, 0b1111) => "fmov",
        (1, 0b1111) => return q.then_some("fmov"),
        (1, 0b1110) => "movi",
        (0, _) if cmode & 0b1001 == 0b0001 || cmode & 0b1101 == 0b1001 => "orr",
        (1, _) if cmode & 0b1001 == 0b0001 || cmode & 0b1101 == 0b1001 => "bic",
        (0, _) => "movi",
        _ => "mvni",
    })
}

fn shift_immediate(word: u32) -> Option<&'static str> {
    let q = word >> 30 & 1 != 0;
    let u = word >> 29 & 1;
    let immh = bits(word, 22, 19);
    let opcode = bits(word, 15, 11);
    let wide = immh >> 3 == 0 || q; // (64-bit elements only as 2D)
    let narrow = immh >> 3 == 0; // (no 64-bit narrow or long element)
    let fixed = immh >= 0b0100 && wide; // (single or double: FP16 is not in v1)
    match (u, opcode) {
        (0, 0b00000) => wide.then_some("sshr"),
        (0, 0b00010) => wide.then_some("ssra"),
        (0, 0b00100) => wide.then_some("srshr"),
        (0, 0b00110) => wide.then_some("srsra"),
        (0, 0b01010) => wide.then_some("shl"),
        (0, 0b01110) => wide.then_some("sqshl"),
        (0, 0b10000) => narrow.then_some(q2!(q, "shrn")),
        (0, 0b10001) => narrow.then_some(q2!(q, "rshrn")),
        (0, 0b10010) => narrow.then_some(q2!(q, "sqshrn")),
        (0, 0b10011) => narrow.then_some(q2!(q, "sqrshrn")),
        (0, 0b10100) => narrow.then_some(q2!(q, "sshll")),
        (0, 0b11100) => fixed.then_some("scvtf"),
        (0, 0b11111) => fixed.then_some("fcvtzs"),
        (1, 0b00000) => wide.then_some("ushr"),
        (1, 0b00010) => wide.then_some("usra"),
        (1, 0b00100) => wide.then_some("urshr"),
        (1, 0b00110) => wide.then_some("ursra"),
        (1, 0b01000) => wide.then_some("sri"),
        (1, 0b01010) => wide.then_some("sli"),
        (1, 0b01100) => wide.then_some("sqshlu"),
        (1, 0b01110) => wide.then_some("uqshl"),
        (1, 0b10000) => narrow.then_some(q2!(q, "sqshrun")),
        (1, 0b10001) => narrow.then_some(q2!(q, "sqrshrun")),
        (1, 0b10010) => narrow.then_some(q2!(q, "uqshrn")),
        (1, 0b10011) => narrow.then_some(q2!(q, "uqrshrn")),
        (1, 0b10100) => narrow.then_some(q2!(q, "ushll")),
        (1, 0b11100) => fixed.then_some("ucvtf"),
        (1, 0b11111) => fixed.then_some("fcvtzu"),
        _ => None,
    }
}

fn indexed(word: u32) -> Option<&'static str> {
    let q = word >> 30 & 1 != 0;
    let u = word >> 29 & 1;
    let size = bits(word, 23, 22);
    let l = word >> 21 & 1;
    let opcode = bits(word, 15, 12);
    let integer = size == 1 || size == 2;
    let fp = size == 2 || size == 3 && l == 0 && q;
    match (u, opcode) {
        (0, 0b0010) => integer.then_some(q2!(q, "smlal")),
        (0, 0b0011) => integer.then_some(q2!(q, "sqdmlal")),
        (0, 0b0110) => integer.then_some(q2!(q, "smlsl")),
        (0, 0b0111) => integer.then_some(q2!(q, "sqdmlsl")),
        (0, 0b1000) => integer.then_some("mul"),
        (0, 0b1010) => integer.then_some(q2!(q, "smull")),
        (0, 0b1011) => integer.then_some(q2!(q, "sqdmull")),
        (0, 0b1100) => integer.then_some("sqdmulh"),
        (0, 0b1101) => integer.then_some("sqrdmulh"),
        (1, 0b0000) => integer.then_some("mla"),
        (1, 0b0010) => integer.then_some(q2!(q, "umlal")),
        (1, 0b0100) => integer.then_some("mls"),
        (1, 0b0110) => integer.then_some(q2!(q, "umlsl")),
        (1, 0b1010) => integer.then_some(q2!(q, "umull")),
        (0, 0b0001) => fp.then_some("fmla"),
        (0, 0b0101) => fp.then_some("fmls"),
        (0, 0b1001) => fp.then_some("fmul"),
        (1, 0b1001) => fp.then_some("fmulx"),
        _ => None,
    }
}

fn table(word: u32) -> Option<&'static str> {
    if bits(word, 23, 22) != 0 {
        return None;
    }
    Some(if word >> 12 & 1 == 0 { "tbl" } else { "tbx" })
}

fn permute(word: u32) -> Option<&'static str> {
    let q = word >> 30 & 1 != 0;
    if bits(word, 23, 22) == 3 && !q {
        return None;
    }
    match bits(word, 14, 12) {
        0b001 => Some("uzp1"),
        0b010 => Some("trn1"),
        0b011 => Some("zip1"),
        0b101 => Some("uzp2"),
        0b110 => Some("trn2"),
        0b111 => Some("zip2"),
        _ => None,
    }
}

fn extract(word: u32) -> Option<&'static str> {
    let q = word >> 30 & 1 != 0;
    if bits(word, 23, 22) != 0 || !q && word >> 14 & 1 != 0 {
        return None;
    }
    Some("ext")
}

// ---- AdvSIMD, scalar

fn scalar_three_same(word: u32) -> Option<&'static str> {
    let u = word >> 29 & 1;
    let size = bits(word, 23, 22);
    let opcode = bits(word, 15, 11);
    if opcode >= 0b11000 {
        return match (u, size >> 1, opcode) {
            (0, 0, 0b11011) => Some("fmulx"),
            (0, 0, 0b11100) => Some("fcmeq"),
            (0, 0, 0b11111) => Some("frecps"),
            (0, 1, 0b11111) => Some("frsqrts"),
            (1, 0, 0b11100) => Some("fcmge"),
            (1, 0, 0b11101) => Some("facge"),
            (1, 1, 0b11010) => Some("fabd"),
            (1, 1, 0b11100) => Some("fcmgt"),
            (1, 1, 0b11101) => Some("facgt"),
            _ => None,
        };
    }
    let d = size == 3;
    match (u, opcode) {
        (0, 0b00001) => Some("sqadd"),
        (0, 0b00101) => Some("sqsub"),
        (0, 0b00110) => d.then_some("cmgt"),
        (0, 0b00111) => d.then_some("cmge"),
        (0, 0b01000) => d.then_some("sshl"),
        (0, 0b01001) => Some("sqshl"),
        (0, 0b01010) => d.then_some("srshl"),
        (0, 0b01011) => Some("sqrshl"),
        (0, 0b10000) => d.then_some("add"),
        (0, 0b10001) => d.then_some("cmtst"),
        (0, 0b10110) => (size == 1 || size == 2).then_some("sqdmulh"),
        (1, 0b00001) => Some("uqadd"),
        (1, 0b00101) => Some("uqsub"),
        (1, 0b00110) => d.then_some("cmhi"),
        (1, 0b00111) => d.then_some("cmhs"),
        (1, 0b01000) => d.then_some("ushl"),
        (1, 0b01001) => Some("uqshl"),
        (1, 0b01010) => d.then_some("urshl"),
        (1, 0b01011) => Some("uqrshl"),
        (1, 0b10000) => d.then_some("sub"),
        (1, 0b10001) => d.then_some("cmeq"),
        (1, 0b10110) => (size == 1 || size == 2).then_some("sqrdmulh"),
        _ => None,
    }
}

fn scalar_three_different(word: u32) -> Option<&'static str> {
    let size = bits(word, 23, 22);
    if word >> 29 & 1 != 0 || !(size == 1 || size == 2) {
        return None;
    }
    match bits(word, 15, 12) {
        0b1001 => Some("sqdmlal"),
        0b1011 => Some("sqdmlsl"),
        0b1101 => Some("sqdmull"),
        _ => None,
    }
}

fn scalar_two_misc(word: u32) -> Option<&'static str> {
    let u = word >> 29 & 1;
    let size = bits(word, 23, 22);
    let opcode = bits(word, 16, 12);
    let d = size == 3;
    match (u, opcode) {
        (0, 0b00011) => Some("suqadd"),
        (0, 0b00111) => Some("sqabs"),
        (0, 0b01000) => d.then_some("cmgt"),
        (0, 0b01001) => d.then_some("cmeq"),
        (0, 0b01010) => d.then_some("cmlt"),
        (0, 0b01011) => d.then_some("abs"),
        (0, 0b10100) => (!d).then_some("sqxtn"),
        (1, 0b00011) => Some("usqadd"),
        (1, 0b00111) => Some("sqneg"),
        (1, 0b01000) => d.then_some("cmge"),
        (1, 0b01001) => d.then_some("cmle"),
        (1, 0b01011) => d.then_some("neg"),
        (1, 0b10010) => (!d).then_some("sqxtun"),
        (1, 0b10100) => (!d).then_some("uqxtn"),
        _ => match (u, size >> 1, opcode) {
            (0, 0, 0b11010) => Some("fcvtns"),
            (0, 0, 0b11011) => Some("fcvtms"),
            (0, 0, 0b11100) => Some("fcvtas"),
            (0, 0, 0b11101) => Some("scvtf"),
            (0, 1, 0b01100) => Some("fcmgt"),
            (0, 1, 0b01101) => Some("fcmeq"),
            (0, 1, 0b01110) => Some("fcmlt"),
            (0, 1, 0b11010) => Some("fcvtps"),
            (0, 1, 0b11011) => Some("fcvtzs"),
            (0, 1, 0b11101) => Some("frecpe"),
            (0, 1, 0b11111) => Some("frecpx"),
            (1, 0, 0b10110) => (size & 1 == 1).then_some("fcvtxn"),
            (1, 0, 0b11010) => Some("fcvtnu"),
            (1, 0, 0b11011) => Some("fcvtmu"),
            (1, 0, 0b11100) => Some("fcvtau"),
            (1, 0, 0b11101) => Some("ucvtf"),
            (1, 1, 0b01100) => Some("fcmge"),
            (1, 1, 0b01101) => Some("fcmle"),
            (1, 1, 0b11010) => Some("fcvtpu"),
            (1, 1, 0b11011) => Some("fcvtzu"),
            (1, 1, 0b11101) => Some("frsqrte"),
            _ => None,
        },
    }
}

fn scalar_pairwise(word: u32) -> Option<&'static str> {
    let u = word >> 29 & 1;
    let size = bits(word, 23, 22);
    match (u, bits(word, 16, 12)) {
        (0, 0b11011) => (size == 3).then_some("addp"),
        (1, 0b01100) => Some(if size >> 1 == 0 { "fmaxnmp" } else { "fminnmp" }),
        (1, 0b01101) => (size >> 1 == 0).then_some("faddp"),
        (1, 0b01111) => Some(if size >> 1 == 0 { "fmaxp" } else { "fminp" }),
        _ => None,
    }
}

fn scalar_copy(word: u32) -> Option<&'static str> {
    (word >> 29 & 1 == 0 && bits(word, 14, 11) == 0 && bits(word, 19, 16) != 0).then_some("dup")
}

fn scalar_shift_immediate(word: u32) -> Option<&'static str> {
    let u = word >> 29 & 1;
    let immh = bits(word, 22, 19);
    let opcode = bits(word, 15, 11);
    let d = immh >> 3 == 1;
    let narrow = immh != 0 && !d;
    let any = immh != 0;
    let fixed = immh >= 0b0100;
    match (u, opcode) {
        (0, 0b00000) => d.then_some("sshr"),
        (0, 0b00010) => d.then_some("ssra"),
        (0, 0b00100) => d.then_some("srshr"),
        (0, 0b00110) => d.then_some("srsra"),
        (0, 0b01010) => d.then_some("shl"),
        (0, 0b01110) => any.then_some("sqshl"),
        (0, 0b10010) => narrow.then_some("sqshrn"),
        (0, 0b10011) => narrow.then_some("sqrshrn"),
        (0, 0b11100) => fixed.then_some("scvtf"),
        (0, 0b11111) => fixed.then_some("fcvtzs"),
        (1, 0b00000) => d.then_some("ushr"),
        (1, 0b00010) => d.then_some("usra"),
        (1, 0b00100) => d.then_some("urshr"),
        (1, 0b00110) => d.then_some("ursra"),
        (1, 0b01000) => d.then_some("sri"),
        (1, 0b01010) => d.then_some("sli"),
        (1, 0b01100) => any.then_some("sqshlu"),
        (1, 0b01110) => any.then_some("uqshl"),
        (1, 0b10000) => narrow.then_some("sqshrun"),
        (1, 0b10001) => narrow.then_some("sqrshrun"),
        (1, 0b10010) => narrow.then_some("uqshrn"),
        (1, 0b10011) => narrow.then_some("uqrshrn"),
        (1, 0b11100) => fixed.then_some("ucvtf"),
        (1, 0b11111) => fixed.then_some("fcvtzu"),
        _ => None,
    }
}

fn scalar_indexed(word: u32) -> Option<&'static str> {
    let u = word >> 29 & 1;
    let size = bits(word, 23, 22);
    let l = word >> 21 & 1;
    let integer = size == 1 || size == 2;
    let fp = size == 2 || size == 3 && l == 0;
    match (u, bits(word, 15, 12)) {
        (0, 0b0011) => integer.then_some("sqdmlal"),
        (0, 0b0111) => integer.then_some("sqdmlsl"),
        (0, 0b1011) => integer.then_some("sqdmull"),
        (0, 0b1100) => integer.then_some("sqdmulh"),
        (0, 0b1101) => integer.then_some("sqrdmulh"),
        (0, 0b0001) => fp.then_some("fmla"),
        (0, 0b0101) => fp.then_some("fmls"),
        (0, 0b1001) => fp.then_some("fmul"),
        (1, 0b1001) => fp.then_some("fmulx"),
        _ => None,
    }
}

// ---- crypto (P2.11)

fn aes(word: u32) -> Option<&'static str> {
    if bits(word, 23, 22) != 0 {
        return None;
    }
    match bits(word, 16, 12) {
        0b00100 => Some("aese"),
        0b00101 => Some("aesd"),
        0b00110 => Some("aesmc"),
        0b00111 => Some("aesimc"),
        _ => None,
    }
}

fn sha3(word: u32) -> Option<&'static str> {
    if bits(word, 23, 22) != 0 {
        return None;
    }
    match bits(word, 14, 12) {
        0b000 => Some("sha1c"),
        0b001 => Some("sha1p"),
        0b010 => Some("sha1m"),
        0b011 => Some("sha1su0"),
        0b100 => Some("sha256h"),
        0b101 => Some("sha256h2"),
        0b110 => Some("sha256su1"),
        _ => None,
    }
}

fn sha2(word: u32) -> Option<&'static str> {
    if bits(word, 23, 22) != 0 {
        return None;
    }
    match bits(word, 16, 12) {
        0b00000 => Some("sha1h"),
        0b00001 => Some("sha1su1"),
        0b00010 => Some("sha256su0"),
        _ => None,
    }
}

// ---- scalar FP

fn fp_fixed(word: u32) -> Option<&'static str> {
    let sf = word >> 31;
    let ty = bits(word, 23, 22);
    if word >> 29 & 1 != 0 || ty >= 2 || sf == 0 && word >> 15 & 1 == 0 {
        return None;
    }
    match (bits(word, 20, 19), bits(word, 18, 16)) {
        (0b00, 0b010) => Some("scvtf"),
        (0b00, 0b011) => Some("ucvtf"),
        (0b11, 0b000) => Some("fcvtzs"),
        (0b11, 0b001) => Some("fcvtzu"),
        _ => None,
    }
}

fn fp_int(word: u32) -> Option<&'static str> {
    let sf = word >> 31;
    let ty = bits(word, 23, 22);
    if word >> 29 & 1 != 0 {
        return None;
    }
    let rmode = bits(word, 20, 19);
    let opcode = bits(word, 18, 16);
    if ty == 2 {
        // FMOV Xd, Vn.D[1] and FMOV Vd.D[1], Xn
        return (sf == 1 && rmode == 1 && opcode >= 0b110).then_some("fmov");
    }
    if ty == 3 {
        return None;
    }
    match (rmode, opcode) {
        (0b00, 0b000) => Some("fcvtns"),
        (0b00, 0b001) => Some("fcvtnu"),
        (0b00, 0b010) => Some("scvtf"),
        (0b00, 0b011) => Some("ucvtf"),
        (0b00, 0b100) => Some("fcvtas"),
        (0b00, 0b101) => Some("fcvtau"),
        (0b00, 0b110) | (0b00, 0b111) => (sf == ty).then_some("fmov"),
        (0b01, 0b000) => Some("fcvtps"),
        (0b01, 0b001) => Some("fcvtpu"),
        (0b10, 0b000) => Some("fcvtms"),
        (0b10, 0b001) => Some("fcvtmu"),
        (0b11, 0b000) => Some("fcvtzs"),
        (0b11, 0b001) => Some("fcvtzu"),
        _ => None,
    }
}

fn fp_dp1(word: u32) -> Option<&'static str> {
    let ty = bits(word, 23, 22);
    let opcode = bits(word, 20, 15);
    if ty == 2 {
        return None;
    }
    if ty == 3 {
        // half precision: only FCVT to single and double are v8.0
        return (opcode == 0b000100 || opcode == 0b000101).then_some("fcvt");
    }
    match opcode {
        0b000000 => Some("fmov"),
        0b000001 => Some("fabs"),
        0b000010 => Some("fneg"),
        0b000011 => Some("fsqrt"),
        0b000100 => (ty == 1).then_some("fcvt"),
        0b000101 => (ty == 0).then_some("fcvt"),
        0b000111 => Some("fcvt"),
        0b001000 => Some("frintn"),
        0b001001 => Some("frintp"),
        0b001010 => Some("frintm"),
        0b001011 => Some("frintz"),
        0b001100 => Some("frinta"),
        0b001110 => Some("frintx"),
        0b001111 => Some("frinti"),
        _ => None,
    }
}

fn fp_dp3(word: u32) -> Option<&'static str> {
    if word >> 31 != 0 || word >> 29 & 1 != 0 || bits(word, 23, 22) >= 2 {
        return None;
    }
    Some(["fmadd", "fmsub", "fnmadd", "fnmsub"][(word >> 20 & 2 | word >> 15 & 1) as usize])
}

// ---- AdvSIMD structure loads and stores

/// LD1-LD4/ST1-ST4 (multiple structures, single structures, replicate):
/// the name, the registers, and for a single structure its element
pub struct Structure {
    pub name: &'static str,
    pub load: bool,
    /// the number of registers (selem: 1-4)
    pub registers: u32,
    /// multiple structures: the registers' elements interleave `interleave` ways (1 for LD1/ST1 of 1-4 registers)
    pub interleave: u32,
    /// log2 of the element size in bytes
    pub size_log: u32,
    /// a single structure: the element index, or None for multiple structures
    pub index: Option<u32>,
    /// LDnR: replicate to every element
    pub replicate: bool,
}

pub fn structure(word: u32) -> Option<Structure> {
    let q = word >> 30 & 1;
    let load = word >> 22 & 1 != 0;
    let post = word >> 23 & 1 != 0;
    if !post && bits(word, 20, 16) != 0 {
        return None;
    }
    let size = bits(word, 11, 10);
    if word >> 24 & 1 == 0 {
        if word >> 21 & 1 != 0 {
            return None;
        }
        let (registers, interleave) = match bits(word, 15, 12) {
            0b0000 => (4, 4),
            0b0010 => (4, 1),
            0b0100 => (3, 3),
            0b0110 => (3, 1),
            0b0111 => (1, 1),
            0b1000 => (2, 2),
            0b1010 => (2, 1),
            _ => return None,
        };
        if interleave > 1 && size == 3 && q == 0 {
            return None;
        }
        let names = if load { ["ld1", "ld2", "ld3", "ld4"] } else { ["st1", "st2", "st3", "st4"] };
        return Some(Structure {
            name: names[(interleave - 1) as usize],
            load,
            registers,
            interleave,
            size_log: size,
            index: None,
            replicate: false,
        });
    }
    let r = word >> 21 & 1;
    let opcode = bits(word, 15, 13);
    let s = word >> 12 & 1;
    let registers = ((opcode & 1) << 1 | r) + 1;
    let (size_log, index, replicate) = match opcode >> 1 {
        0 => (0, q << 3 | s << 2 | size, false),
        1 => {
            if size & 1 != 0 {
                return None;
            }
            (1, q << 2 | s << 1 | size >> 1, false)
        },
        2 => {
            if size >> 1 != 0 {
                return None;
            }
            if size == 0 {
                (2, q << 1 | s, false)
            }
            else {
                if s != 0 {
                    return None;
                }
                (3, q, false)
            }
        },
        _ => {
            if !load || s != 0 {
                return None;
            }
            (size, 0, true)
        },
    };
    let name = match (load, replicate, registers) {
        (true, true, n) => ["ld1r", "ld2r", "ld3r", "ld4r"][(n - 1) as usize],
        (true, false, n) => ["ld1", "ld2", "ld3", "ld4"][(n - 1) as usize],
        (false, _, n) => ["st1", "st2", "st3", "st4"][(n - 1) as usize],
    };
    Some(Structure {
        name,
        load,
        registers,
        interleave: registers,
        size_log,
        index: if replicate { None } else { Some(index) },
        replicate,
    })
}
