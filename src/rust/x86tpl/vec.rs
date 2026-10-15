//! Vector leaves of x86 semantics (docs/jit-unification-plan.md P2.2): the
//! table of packed integer and logic operations (Packed) and its emission,
//! the immediate shifts, the SSE arithmetic, compares and conversions, the
//! call of the exact SSE helper (x64::helpers::x64_sse_fp) and the
//! register facts behind native_fp's admission. The page tier uses them
//! (P2.3 on; IR Tier-0 until P7.5); tests/x86tpl/pagegen_leaf_digests.rs
//! pins their output.
use crate::wasmgen::leaves::{self, Shift};
use crate::wasmgen::wasm_builder::{Signature, WasmBuilder, WasmLocal, WasmLocalV128, WasmType};

/// Register facts (the page tier's Emitter::xmm_clean): lanes known to be neither NaN
/// nor denormal, as single precision (the low lane, all lanes) or double
/// precision.
pub const CLEAN_SS: u8 = 1;
pub const CLEAN_PS: u8 = 2;
pub const CLEAN_SD: u8 = 4;
pub const CLEAN_PD: u8 = 8;

#[derive(Clone, Copy, Debug)]
pub enum Packed {
    /// i8x16.shuffle over (destination, source)
    Shuffle([u8; 16]),
    /// i8x16.shuffle over (destination, zero)
    ShuffleZero([u8; 16]),
    /// PSHUFB: the destination's bytes by the source's indices, masked
    /// (bit 7 selects zero)
    Swizzle(u8),
    Binary(u32),
    AndNot,
    Unpack(u8, bool),
    Pack(u32),
    /// Shift by the source's low quadword: (opcode, lane bits, arithmetic).
    Shift(u32, u32, bool),
    MulHigh(bool),
    /// PMULUDQ (false), PMULDQ (true): the even dwords' 64-bit products
    MulDwords(bool),
    Sad,
}

/// Packed integer and logic operations (Wasm SIMD opcodes).
pub fn packed_op(code: u8, mmx: bool) -> Option<Packed> {
    Some(match code {
        0xFC => Packed::Binary(0x6E),
        0xFD => Packed::Binary(0x8E),
        0xFE => Packed::Binary(0xAE),
        0xD4 => Packed::Binary(0xCE),
        0xF8 => Packed::Binary(0x71),
        0xF9 => Packed::Binary(0x91),
        0xFA => Packed::Binary(0xB1),
        0xFB => Packed::Binary(0xD1),
        0xEC => Packed::Binary(0x6F),
        0xED => Packed::Binary(0x8F),
        0xDC => Packed::Binary(0x70),
        0xDD => Packed::Binary(0x90),
        0xE8 => Packed::Binary(0x72),
        0xE9 => Packed::Binary(0x92),
        0xD8 => Packed::Binary(0x73),
        0xD9 => Packed::Binary(0x93),
        0x64 => Packed::Binary(0x27),
        0x65 => Packed::Binary(0x31),
        0x66 => Packed::Binary(0x3B),
        0x74 => Packed::Binary(0x23),
        0x75 => Packed::Binary(0x2D),
        0x76 => Packed::Binary(0x37),
        0xDA => Packed::Binary(0x77),
        0xDE => Packed::Binary(0x79),
        0xEA => Packed::Binary(0x96),
        0xEE => Packed::Binary(0x98),
        0xE0 => Packed::Binary(0x7B),
        0xE3 => Packed::Binary(0x9B),
        0xE4 => Packed::MulHigh(false),
        0xE5 => Packed::MulHigh(true),
        0xF4 => Packed::MulDwords(false),
        0xF6 => Packed::Sad,
        0xD5 => Packed::Binary(0x95),
        0xF5 => Packed::Binary(0xBA),
        0xDB => Packed::Binary(0x4E),
        0xDF => Packed::AndNot,
        0xEB => Packed::Binary(0x50),
        0xEF => Packed::Binary(0x51),
        0x60 => Packed::Unpack(1, false),
        0x61 => Packed::Unpack(2, false),
        0x62 => Packed::Unpack(4, false),
        0x68 => Packed::Unpack(1, true),
        0x69 => Packed::Unpack(2, true),
        0x6A => Packed::Unpack(4, true),
        0x6C if !mmx => Packed::Unpack(8, false),
        0x6D if !mmx => Packed::Unpack(8, true),
        0x63 => Packed::Pack(0x65),
        0x67 => Packed::Pack(0x66),
        0x6B => Packed::Pack(0x85),
        0xD1 => Packed::Shift(0x8D, 16, false),
        0xD2 => Packed::Shift(0xAD, 32, false),
        0xD3 => Packed::Shift(0xCD, 64, false),
        0xE1 => Packed::Shift(0x8C, 16, true),
        0xE2 => Packed::Shift(0xAC, 32, true),
        0xF1 => Packed::Shift(0x8B, 16, false),
        0xF2 => Packed::Shift(0xAB, 32, false),
        0xF3 => Packed::Shift(0xCB, 64, false),
        _ => return None,
    })
}

/// Shuffle lanes of PSHUFW/PSHUFD/PSHUFLW/PSHUFHW/SHUFPS/SHUFPD over
/// (first, source); `two`: the first operand is the destination, else the
/// source itself.
pub fn shuffle_lanes(op: u32, imm: u32) -> ([u8; 16], bool) {
    let mut lanes = [0; 16];
    for i in 0..16u32 {
        lanes[i as usize] = match op {
            0x0F70 => ((imm >> (2 * (i / 2 % 4)) & 3) * 2 + i % 2) as u8,
            0x660F70 => ((imm >> (2 * (i / 4)) & 3) * 4 + i % 4) as u8,
            0xF20F70 if i < 8 => ((imm >> (2 * (i / 2)) & 3) * 2 + i % 2) as u8,
            0xF30F70 if i >= 8 => (8 + (imm >> (2 * ((i - 8) / 2)) & 3) * 2 + i % 2) as u8,
            0x0FC6 => ((imm >> (2 * (i / 4)) & 3) * 4 + i % 4 + if i >= 8 { 16 } else { 0 }) as u8,
            0x660FC6 => ((imm >> (i / 8) & 1) * 8 + i % 8 + if i >= 8 { 16 } else { 0 }) as u8,
            _ => i as u8,
        };
    }
    (lanes, matches!(op, 0x0FC6 | 0x660FC6))
}

/// The shuffle of PSHUFW/PSHUFD/PSHUFLW/PSHUFHW/SHUFPS/SHUFPD with `imm` over
/// (destination, source) (shuffle_lanes; the one-operand forms select from
/// the source only)
pub fn shuffle(op: u32, imm: u32) -> Packed {
    let (mut lanes, two) = shuffle_lanes(op, imm);
    if !two {
        for lane in &mut lanes {
            *lane += 16;
        }
    }
    Packed::Shuffle(lanes)
}

impl Packed {
    /// The byte lanes of a shuffle over (destination, source)
    pub fn lanes(self, bytes: u8) -> Option<[u8; 16]> {
        match self {
            Packed::Shuffle(lanes) => Some(lanes),
            Packed::Unpack(width, high) => Some(leaves::interleave_lanes(width, high, bytes)),
            _ => None,
        }
    }
}

/// PALIGNR with `imm8` on `n`-byte operands (simd_int::palignr_lanes)
pub fn palignr(imm8: u8, n: u32) -> Packed {
    match crate::cpu::simd_int::palignr_lanes(imm8, n as usize) {
        (lanes, true) => Packed::ShuffleZero(lanes),
        (lanes, false) => Packed::Shuffle(lanes),
    }
}

/// The packed SSE4.1/SSE4.2 forms of one Wasm SIMD operation over
/// (destination, source), by catalogue key `op` (a VEX form's legacy one):
/// the hot PMINUD and its siblings, and the blends with `imm8` as shuffles
pub fn sse4_packed(op: u32, imm8: Option<u32>) -> Option<Packed> {
    let blend = |size: u8, mask: u32| {
        let mut lanes = [0; 16];
        for (k, lane) in lanes.iter_mut().enumerate() {
            *lane = k as u8 + if mask >> (k as u8 / size) & 1 != 0 { 16 } else { 0 };
        }
        Packed::Shuffle(lanes)
    };
    Some(match op {
        0x660F3828 => Packed::MulDwords(true), // pmuldq
        0x660F3829 => Packed::Binary(0xD6),    // pcmpeqq: i64x2.eq
        0x660F382B => Packed::Pack(0x86),      // packusdw: i16x8.narrow_i32x4_u
        0x660F3837 => Packed::Binary(0xD9),    // pcmpgtq: i64x2.gt_s
        0x660F3838 => Packed::Binary(0x76),    // pminsb: i8x16.min_s
        0x660F3839 => Packed::Binary(0xB6),    // pminsd: i32x4.min_s
        0x660F383A => Packed::Binary(0x97),    // pminuw: i16x8.min_u
        0x660F383B => Packed::Binary(0xB7),    // pminud: i32x4.min_u
        0x660F383C => Packed::Binary(0x78),    // pmaxsb: i8x16.max_s
        0x660F383D => Packed::Binary(0xB8),    // pmaxsd: i32x4.max_s
        0x660F383E => Packed::Binary(0x99),    // pmaxuw: i16x8.max_u
        0x660F383F => Packed::Binary(0xB9),    // pmaxud: i32x4.max_u
        0x660F3840 => Packed::Binary(0xB5),    // pmulld: i32x4.mul
        0x660F3A0C => blend(4, imm8? & 0xF),
        0x660F3A0D => blend(8, imm8? & 3),
        0x660F3A0E => blend(2, imm8? & 0xFF),
        _ => return None,
    })
}

/// Push op(dst, src) on `bytes`-wide registers (8: MMX, low quadword).
pub fn packed(
    w: &mut WasmBuilder,
    op: Packed,
    dst: &WasmLocalV128,
    src: &WasmLocalV128,
    bytes: u8,
) {
    match op {
        Packed::ShuffleZero(lanes) => {
            w.get_local_v128(dst);
            w.simd_zero();
            w.simd_shuffle(lanes);
        },
        Packed::Swizzle(mask) => {
            w.get_local_v128(dst);
            w.get_local_v128(src);
            w.const_i32(mask as i32);
            w.simd(0x0F); // i8x16.splat
            w.simd(0x4E); // v128.and
            w.simd(0x0E); // i8x16.swizzle
        },
        Packed::MulHigh(signed) => {
            w.get_local_v128(dst);
            w.get_local_v128(src);
            w.simd(if signed { 0xBC } else { 0xBE });
            if bytes == 16 {
                w.get_local_v128(dst);
                w.get_local_v128(src);
                w.simd(if signed { 0xBD } else { 0xBF });
            }
            else {
                w.simd_zero();
            }
            w.simd_shuffle([2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23, 26, 27, 30, 31]);
        },
        Packed::MulDwords(signed) => {
            for v in [dst, src] {
                w.get_local_v128(v);
                w.simd_zero();
                w.simd_shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
            }
            // i64x2.extmul_low_i32x4_s/u
            w.simd(if signed { 0xDC } else { 0xDE });
        },
        Packed::Sad => {
            // |dst - src| per byte, summed per quadword.
            w.get_local_v128(dst);
            w.get_local_v128(src);
            w.simd(0x79);
            w.get_local_v128(dst);
            w.get_local_v128(src);
            w.simd(0x77);
            w.simd(0x71);
            w.simd(0x7D);
            w.simd(0x7F);
            let sums = w.set_new_local_v128();
            w.get_local_v128(&sums);
            w.get_local_v128(&sums);
            w.get_local_v128(&sums);
            w.simd_shuffle([4, 5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11]);
            w.simd(0xAE);
            w.simd_zero();
            w.simd_shuffle([0, 1, 2, 3, 16, 17, 18, 19, 8, 9, 10, 11, 16, 17, 18, 19]);
            w.free_local_v128(sums);
        },
        Packed::Shift(opcode, bits, arithmetic) => {
            w.get_local_v128(src);
            w.simd_lane(0x1D, 0);
            let count = w.set_new_local_i64();
            w.get_local_i64(&count);
            w.const_i64((bits - 1) as i64);
            w.gtu_i64();
            w.if_v128();
            if arithmetic {
                w.get_local_v128(dst);
                w.const_i32((bits - 1) as i32);
                w.simd(opcode);
            }
            else {
                w.simd_zero();
            }
            w.else_();
            w.get_local_v128(dst);
            w.get_local_i64(&count);
            w.wrap_i64_to_i32();
            w.simd(opcode);
            w.block_end();
            w.free_local_i64(count);
        },
        _ => {
            if let Packed::AndNot = op {
                w.get_local_v128(src);
                w.get_local_v128(dst);
            }
            else {
                w.get_local_v128(dst);
                w.get_local_v128(src);
            }
            match op {
                Packed::Shuffle(lanes) => w.simd_shuffle(lanes),
                Packed::Binary(opcode) => w.simd(opcode),
                Packed::AndNot => w.simd(0x4F),
                Packed::Pack(opcode) => {
                    w.simd(opcode);
                    if bytes == 8 {
                        w.simd_zero();
                        w.simd_shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
                    }
                },
                Packed::Unpack(..) => w.simd_shuffle(op.lanes(bytes).unwrap()),
                _ => unreachable!(),
            }
        },
    }
}

/// CVT(T)PS2DQ/CVT(T)PD2DQ of the vector on the stack, rounded to nearest
/// (or truncated): push the integer vector and return an i32 local,
/// nonzero if a lane was out of the i32 range (or NaN)
pub fn convert_integer(w: &mut WasmBuilder, double: bool, truncate: bool) -> WasmLocal {
    let input = w.set_new_local_v128();
    if truncate {
        w.get_local_v128(&input);
        w.simd(if double { 0x7A } else { 0x69 });
    }
    else {
        // (admitted only with MXCSR.RC to nearest)
        w.get_local_v128(&input);
        w.simd(if double { 0x94 } else { 0x6A }); // nearest
    }
    let rounded = w.set_new_local_v128();
    w.get_local_v128(&rounded);
    if double {
        w.const_i64(0xC1E0000000000000u64 as i64);
        w.simd(0x12);
    }
    else {
        w.const_i32(0xCF000000u32 as i32);
        w.simd(0x11);
    }
    w.simd(if double { 0x4C } else { 0x46 });
    w.get_local_v128(&rounded);
    if double {
        w.const_i64(0x41E0000000000000);
        w.simd(0x12);
    }
    else {
        w.const_i32(0x4F000000);
        w.simd(0x11);
    }
    w.simd(if double { 0x49 } else { 0x43 });
    w.simd(0x4E);
    if double {
        w.simd_zero();
        w.simd_shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]);
    }
    let valid = w.set_new_local_v128();
    // (the lanes that exist: 0 and 1 for double precision)
    w.get_local_v128(&valid);
    w.simd(0xA4); // i32x4.bitmask
    w.const_i32(if double { 3 } else { 15 });
    w.and_i32();
    w.const_i32(if double { 3 } else { 15 });
    w.ne_i32();
    let out_of_range = w.set_new_local();
    w.get_local_v128(&rounded);
    w.simd(if double { 0xFC } else { 0xF8 });
    w.const_i32(i32::MIN);
    w.simd(0x11);
    w.get_local_v128(&valid);
    w.simd(0x52);
    if double {
        w.simd_zero();
        w.simd_shuffle([0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23]);
    }
    w.free_local_v128(input);
    w.free_local_v128(rounded);
    w.free_local_v128(valid);
    out_of_range
}

/// Push i32 nonzero if a lane of the conversion `opcode` (ops::convert: 0x5E
/// f64 to f32, 0xFA i32 to f32; the others are exact) of `x` into `v` is
/// inexact, for the lanes it admitted: the low one if `scalar`
pub fn conversion_inexact(
    w: &mut WasmBuilder,
    opcode: u32,
    scalar: bool,
    x: &WasmLocalV128,
    v: &WasmLocalV128,
) {
    if opcode == 0x5E {
        // f32 back to f64 differs
        w.get_local_v128(v);
        w.simd(0x5F); // f64x2.promote_low_f32x4
        w.get_local_v128(x);
        w.simd(0x48); // f64x2.ne
    }
    else {
        // the f32 back to i32 differs, or the f32 is 2^31 (trunc_sat
        // saturates it to i32::MAX)
        w.get_local_v128(v);
        w.simd(0xF8); // i32x4.trunc_sat_f32x4_s
        w.get_local_v128(x);
        w.simd(0x38); // i32x4.ne
        w.get_local_v128(v);
        leaves::splat_i32(w, 0x4F000000);
        w.simd(0x41); // f32x4.eq
        w.simd(0x50); // v128.or
    }
    if scalar {
        w.simd_lane(0x1B, 0); // i32x4.extract_lane
    }
    else {
        w.simd(0x53); // v128.any_true
    }
}

/// Push i32 nonzero if a lane of `x` is not integral after CVT(T)PS2DQ's or
/// CVT(T)PD2DQ's rounding (to nearest, or `truncate`): an inexact result
pub fn integer_conversion_inexact(
    w: &mut WasmBuilder,
    double: bool,
    truncate: bool,
    x: &WasmLocalV128,
) {
    w.get_local_v128(x);
    w.simd(match (double, truncate) {
        (false, false) => 0x6A, // f32x4.nearest
        (false, true) => 0x69,  // f32x4.trunc
        (true, false) => 0x94,  // f64x2.nearest
        (true, true) => 0x7A,   // f64x2.trunc
    });
    w.get_local_v128(x);
    w.simd(if double { 0x48 } else { 0x42 }); // f64x2.ne, f32x4.ne
    w.simd(0x53); // v128.any_true
}

/// PSRLx/PSRAx/PSLLx (`bits` 16, 32 or 64: the lane width) and PSRLDQ/PSLLDQ
/// (128: bytes) of `value` by imm8 `count`, `kind` the ModRM reg (2 PSRL, 4
/// PSRA, 6 PSLL, 3 PSRLDQ, 7 PSLLDQ): push the result
pub fn shift_immediate(w: &mut WasmBuilder, value: &WasmLocalV128, bits: u8, kind: u8, count: u8) {
    let count = count as u32;
    if bits == 128 {
        w.get_local_v128(value);
        w.simd_zero();
        w.simd_shuffle(leaves::byte_shift_lanes(count, kind == 3));
    }
    else if count >= bits as u32 && kind != 4 {
        w.simd_zero();
    }
    else {
        w.get_local_v128(value);
        let shift = match kind {
            6 => Shift::Left,
            4 => Shift::Arithmetic,
            _ => Shift::Logical,
        };
        leaves::shift_lanes(w, bits, shift, count.min(bits as u32 - 1));
    }
}

/// The native operation of SQRT (`opcode` 0x51), RSQRT (0x52), RCP (0x53),
/// ADD (0x58), MUL (0x59), SUB (0x5C), MIN (0x5D), DIV (0x5E) and MAX (0x5F)
/// on (`dst`, `src`), PS or PD (scalar forms use the low lane): push it
pub fn float_arithmetic(
    w: &mut WasmBuilder,
    opcode: u8,
    double: bool,
    dst: &WasmLocalV128,
    src: &WasmLocalV128,
) {
    let base = if double { 0xF0 } else { 0xE4 };
    match opcode {
        0x51 => {
            w.get_local_v128(src);
            w.simd(base - 1); // sqrt
        },
        0x52 | 0x53 => {
            // rsqrt/rcp as the interpreter computes them: 1 / sqrt(x), 1 / x.
            leaves::splat_i32(w, 0x3F800000); // 1.0f
            w.get_local_v128(src);
            if opcode == 0x52 {
                w.simd(0xE3);
            }
            w.simd(0xE7);
        },
        0x5D | 0x5F => {
            // dst where dst < src (> for max), else src (NaNs, zeros).
            w.get_local_v128(dst);
            w.get_local_v128(src);
            w.get_local_v128(dst);
            w.get_local_v128(src);
            w.simd(if double { 0x49 } else { 0x43 } + (opcode == 0x5F) as u32);
            w.simd(0x52);
        },
        _ => {
            w.get_local_v128(dst);
            w.get_local_v128(src);
            w.simd(
                base + match opcode {
                    0x58 => 0,
                    0x5C => 1,
                    0x59 => 2,
                    _ => 3,
                },
            );
        },
    }
}

/// CMPPS/CMPPD/CMPSS/CMPSD's relation of imm8[2:0] (`predicate`) for ordered
/// operands (`dst`, `src`): EQ, LT, LE, UNORD (false), NEQ, NLT (ge), NLE
/// (gt), ORD (true); push the mask
pub fn compare_relation(
    w: &mut WasmBuilder,
    double: bool,
    predicate: u8,
    dst: &WasmLocalV128,
    src: &WasmLocalV128,
) {
    match predicate & 7 {
        3 => w.simd_zero(),
        7 => leaves::splat_i32(w, -1),
        relation => {
            w.get_local_v128(dst);
            w.get_local_v128(src);
            // (f32x4/f64x2: eq ne lt gt le ge)
            let offset = [0, 2, 4, 0, 1, 5, 3][relation as usize];
            w.simd(if double { 0x47 } else { 0x41 } + offset);
        },
    }
}

/// Call runtime::tier0::ir_t0_sse_fp, the exact path of a refused
/// instruction: (`destination`, `source`) into its operand block at
/// `operands` (Tier-0's Page::env.sse_fp_operands), the form `key` (a catalogue key:
/// a VEX form's legacy one) with `imm8`. Push its i32, nonzero if the
/// instruction faults; the result is sse_fp_result's.
pub fn sse_fp_call(
    w: &mut WasmBuilder,
    operands: u32,
    key: u32,
    imm8: u32,
    destination: &WasmLocalV128,
    source: &WasmLocalV128,
) {
    for (k, value) in [destination, source].into_iter().enumerate() {
        w.const_i32((operands + 16 * k as u32) as i32);
        w.get_local_v128(value);
        w.simd_memory(0x0B, 4); // v128.store
    }
    w.const_i32(key as i32);
    w.const_i32(imm8 as i32);
    w.call_signature(
        "x64_sse_fp",
        Signature::new(&[WasmType::I32, WasmType::I32], &[WasmType::I32]),
    );
}
/// Push the result of sse_fp_call
pub fn sse_fp_result(w: &mut WasmBuilder, operands: u32) {
    w.const_i32(operands as i32);
    w.simd_memory(0x00, 4); // v128.load
}

/// The register-fact bit of a lane format: the low lane or all lanes,
/// single or double precision (all lanes clean implies the low lane)
pub fn clean_bits(double: bool, scalar: bool) -> u8 {
    match (double, scalar) {
        (false, true) => CLEAN_SS,
        (false, false) => CLEAN_PS | CLEAN_SS,
        (true, true) => CLEAN_SD,
        (true, false) => CLEAN_PD | CLEAN_SD,
    }
}
/// Whether XMM `first` and `source` (None: memory) are known to hold `lanes`
/// clean (the register facts): native_fp's `known` operands
pub fn known_clean(clean: &[u8], lanes: u8, first: u8, source: Option<u8>) -> [bool; 2] {
    let holds = |r: u8| clean[r as usize] & lanes == lanes;
    [holds(first), source.is_some_and(holds)]
}
/// Whether an SSE arithmetic form (Simd::Float, not RSQRT or RCP) leaves
/// facts that hold only for admitted operands (float_facts): a clean result
/// (all but ADD and SUB), or a source register found clean. Its refused
/// operands then retry, as the exact path would not make the facts true.
pub fn float_claims(opcode: u8, source: Option<u8>, known: [bool; 2]) -> bool {
    !matches!(opcode, 0x58 | 0x5C) || source.is_some() && !known[1]
}
/// The register facts after an admitted SSE arithmetic form (Simd::Float) wrote
/// XMM `reg`, of operands that passed native_fp::arithmetic_refused: a source
/// register (None: memory) is clean, and so is the result of all but ADD and
/// SUB, whose clean operands can cancel to a denormal; a scalar result keeps
/// the other lanes of the first source (its facts `before` the write).
/// RSQRT and RCP check only their operand and leave nothing.
pub fn float_facts(
    clean: &mut [u8],
    opcode: u8,
    double: bool,
    scalar: bool,
    reg: u8,
    source: Option<u8>,
    before: u8,
) {
    if matches!(opcode, 0x52 | 0x53) {
        return;
    }
    // (see native_fp::arithmetic_refused)
    let lanes = clean_bits(double, scalar);
    if let Some(source) = source.filter(|&r| r != reg) {
        clean[source as usize] |= lanes;
    }
    if !matches!(opcode, 0x58 | 0x5C) {
        // a scalar result keeps the destination's other lanes
        clean[reg as usize] = lanes | if scalar { before & clean_bits(double, false) } else { 0 };
    }
}
/// The register facts after a conversion of one Wasm operation
/// (ops::convert, `opcode`) wrote XMM `reg`: an admitted result is neither
/// NaN nor denormal (integers convert to normals or zeros), a scalar one
/// keeps the first source's other lanes (its facts `before` the write), and
/// the source register of CVTPS2PD and CVTSS2SD passed operands_refused
pub fn convert_facts(
    clean: &mut [u8],
    opcode: u32,
    scalar: bool,
    reg: u8,
    source: Option<u8>,
    before: u8,
) {
    let double = matches!(opcode, 0x5F | 0xFE);
    let lanes = clean_bits(double, scalar);
    clean[reg as usize] = lanes | if scalar { before & clean_bits(double, false) } else { 0 };
    if let (0x5F, Some(source)) = (opcode, source.filter(|&r| r != reg)) {
        clean[source as usize] |= CLEAN_SS;
    }
}
