//! The AdvSIMD templates of the A64 page tier (docs/jit-unification-plan.md
//! P6.3b): vector forms as Wasm SIMD (v128) operations on the V registers
//! in the state block, emitted only by a core built with simd128 (as
//! src/rust/x64/pagegen.rs's vector templates). The integer and bitwise
//! forms, the permutes and the element moves have no exceptions and no
//! FPSR effects (the saturating forms, which set FPSR.QC, are helper
//! calls). The FP forms take the fast path of the ARM plan's rules
//! ("A64 JIT 的语义红线"), lane by lane: FPCR RMode RN and FZ 0, FPSR.IXC
//! already set, every operand lane zero or normal, every divisor lane not
//! zero, every result lane zero or normal with exponent 2 or more; FMLA
//! and FMLS only with fused relaxed multiply-adds (a64_relaxed_fma).
//! Anything else calls the interpreter (the helper). A 64-bit form (Q = 0)
//! computes on the low half and writes the upper half zero.

use super::*;
use crate::wasmgen::wasm_builder::WasmLocalV128;

// Wasm SIMD opcodes (after the 0xFD prefix)
const V128_LOAD: u32 = 0x00;
const V128_STORE: u32 = 0x0B;
const V128_NOT: u32 = 0x4D;
const V128_AND: u32 = 0x4E;
const V128_ANDNOT: u32 = 0x4F;
const V128_OR: u32 = 0x50;
const V128_BITSELECT: u32 = 0x52;
const I8X16_POPCNT: u32 = 0x62;

/// Where an operand of a bit select comes from
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Source {
    D,
    N,
    M,
}

/// The template of a vector instruction
#[derive(Clone, Copy)]
pub(super) enum VecForm {
    /// d = op(n, m), the lane width's operation `op`; `invert_m`: ORN's m
    /// inverted first; `test`: CMTST, (n & m) != 0 with `op` the lanes' ne
    Binary { op: u32, invert_m: bool, test: bool },
    /// BSL, BIT, BIF: v128.bitselect(first, second, mask)
    Select {
        first: Source,
        second: Source,
        mask: Source,
    },
    /// d = op(n); `compare_zero`: op(n, 0)
    Unary { op: u32, compare_zero: bool },
    /// d = op(n, amount) (a lane shift); `zero`: USHR by the element size
    Shift { op: u32, amount: u32, zero: bool },
    /// d = the bytes `lanes` of first:second (0-15: first, 16-31: second),
    /// the bytes from `keep` on zero
    Shuffle {
        first: u8,
        second: u8,
        lanes: [u8; 16],
        keep: u8,
    },
    /// d = `value` (MOVI, MVNI, FMOV vector immediate), d | value (ORR),
    /// d & !value (BIC)
    Immediate { value: u128, kind: u8 },
    /// DUP (general): X[n]'s low `esize` bits in every element
    DupGeneral { esize: u32 },
    /// INS: element `index` of d from X[n] or from element `source` of n
    Insert {
        esize: u32,
        index: u32,
        source: Option<u32>,
    },
    /// UMOV, SMOV: element `index` of n into X[d] (`signed`; `wide`: X, else W)
    Move {
        esize: u32,
        index: u32,
        signed: bool,
        wide: bool,
    },
    /// FADD, FSUB, FMUL, FDIV (0-3), FMLA, FMLS (4, 5) on the fast path
    Fp { op: u8, double: bool },
    /// FMOV (general): between X[n]/X[d] and V's low 32 or 64 bits, or the
    /// upper 64 (`top`)
    FmovGeneral { to_gpr: bool, bits: u32, top: bool },
}

const IMM_SET: u8 = 0;
const IMM_OR: u8 = 1;
const IMM_AND_NOT: u8 = 2;

/// The lane operation of `table` for elements of 8 << size bits (None: no
/// such Wasm operation)
fn lanes(table: [u32; 4], size: u32) -> Option<u32> {
    Some(table[size as usize]).filter(|&o| o != 0)
}

/// The bytes of a shuffle that builds `elements` elements of `esize` bits,
/// element e from element `pick(e)` = (operand 0 or 1, index) of first:second
fn element_lanes(esize: u32, elements: u32, pick: impl Fn(u32) -> (u32, u32)) -> [u8; 16] {
    let bytes = esize / 8;
    let mut lanes = [0u8; 16];
    for e in 0..elements {
        let (operand, index) = pick(e);
        for b in 0..bytes {
            lanes[(e * bytes + b) as usize] = (16 * operand + index * bytes + b) as u8;
        }
    }
    lanes
}

/// The vector template of `i`, if any
pub(super) fn form(i: &Inst, env: &CompileEnv) -> Option<VecForm> {
    if !env.neon || !cfg!(target_feature = "simd128") {
        return None;
    }
    let word = i.imm as u32;
    let q = word >> 30 & 1 != 0;
    let u = word >> 29 & 1;
    let vector = word >> 28 & 1 == 0;
    let size = word >> 22 & 3;
    let datasize = if q { 128 } else { 64 };
    match i.op {
        Op::SimdThreeSame if vector => {
            let opcode = word >> 11 & 31;
            if opcode >= 0b11000 {
                // FP: FADD, FSUB, FMUL, FDIV; FMLA, FMLS fused
                let double = size & 1 != 0;
                let op = match (u, size >> 1, opcode) {
                    (0, 0, 0b11010) => 0,
                    (0, 1, 0b11010) => 1,
                    (1, 0, 0b11011) => 2,
                    (1, 0, 0b11111) => 3,
                    (0, 0, 0b11001) if env.relaxed_fma => 4,
                    (0, 1, 0b11001) if env.relaxed_fma => 5,
                    _ => return None,
                };
                return Some(VecForm::Fp { op, double });
            }
            if opcode == 0b00011 {
                use Source::*;
                return Some(match u << 2 | size {
                    0 => VecForm::Binary {
                        op: V128_AND,
                        invert_m: false,
                        test: false,
                    },
                    1 => VecForm::Binary {
                        op: V128_ANDNOT,
                        invert_m: false,
                        test: false,
                    },
                    2 => VecForm::Binary {
                        op: V128_OR,
                        invert_m: false,
                        test: false,
                    },
                    3 => VecForm::Binary {
                        op: V128_OR,
                        invert_m: true,
                        test: false,
                    },
                    4 => VecForm::Binary {
                        op: 0x51,
                        invert_m: false,
                        test: false,
                    },
                    5 => VecForm::Select {
                        first: N,
                        second: M,
                        mask: D,
                    },
                    6 => VecForm::Select {
                        first: N,
                        second: D,
                        mask: M,
                    },
                    _ => VecForm::Select {
                        first: D,
                        second: N,
                        mask: M,
                    },
                });
            }
            let binary = |op: Option<u32>| {
                op.map(|op| VecForm::Binary {
                    op,
                    invert_m: false,
                    test: false,
                })
            };
            match (u, opcode) {
                (0, 0b10000) => binary(lanes([0x6E, 0x8E, 0xAE, 0xCE], size)),
                (1, 0b10000) => binary(lanes([0x71, 0x91, 0xB1, 0xD1], size)),
                (1, 0b10001) => binary(lanes([0x23, 0x2D, 0x37, 0xD6], size)),
                (0, 0b10001) => lanes([0x24, 0x2E, 0x38, 0xD7], size).map(|op| VecForm::Binary {
                    op,
                    invert_m: false,
                    test: true,
                }),
                (0, 0b00110) => binary(lanes([0x27, 0x31, 0x3B, 0xD9], size)),
                (1, 0b00110) => binary(lanes([0x28, 0x32, 0x3C, 0], size)),
                (0, 0b00111) => binary(lanes([0x2B, 0x35, 0x3F, 0xDB], size)),
                (1, 0b00111) => binary(lanes([0x2C, 0x36, 0x40, 0], size)),
                (0, 0b01100) => binary(lanes([0x78, 0x98, 0xB8, 0], size)),
                (1, 0b01100) => binary(lanes([0x79, 0x99, 0xB9, 0], size)),
                (0, 0b01101) => binary(lanes([0x76, 0x96, 0xB6, 0], size)),
                (1, 0b01101) => binary(lanes([0x77, 0x97, 0xB7, 0], size)),
                (0, 0b10011) => binary(lanes([0, 0x95, 0xB5, 0], size)),
                // URHADD
                (1, 0b00010) => binary(lanes([0x7B, 0x9B, 0, 0], size)),
                _ => None,
            }
        },
        Op::SimdTwoMisc if vector => {
            let opcode = word >> 12 & 31;
            let unary = |op: Option<u32>| {
                op.map(|op| VecForm::Unary {
                    op,
                    compare_zero: false,
                })
            };
            let zero = |op: Option<u32>| {
                op.map(|op| VecForm::Unary {
                    op,
                    compare_zero: true,
                })
            };
            match (u, opcode) {
                (1, 0b00101) if size == 0 => Some(VecForm::Unary {
                    op: V128_NOT,
                    compare_zero: false,
                }),
                (0, 0b00101) if size == 0 => Some(VecForm::Unary {
                    op: I8X16_POPCNT,
                    compare_zero: false,
                }),
                (0, 0b01011) => unary(lanes([0x60, 0x80, 0xA0, 0xC0], size)),
                (1, 0b01011) => unary(lanes([0x61, 0x81, 0xA1, 0xC1], size)),
                (0, 0b01000) => zero(lanes([0x27, 0x31, 0x3B, 0xD9], size)),
                (1, 0b01000) => zero(lanes([0x2B, 0x35, 0x3F, 0xDB], size)),
                (0, 0b01001) => zero(lanes([0x23, 0x2D, 0x37, 0xD6], size)),
                (1, 0b01001) => zero(lanes([0x29, 0x33, 0x3D, 0xDA], size)),
                (0, 0b01010) => zero(lanes([0x25, 0x2F, 0x39, 0xD8], size)),
                // REV64, REV32, REV16: the elements reversed within each container
                (_, 0b00000) | (0, 0b00001) => {
                    let container = match (u, opcode) {
                        (0, 0b00000) => 64,
                        (1, 0b00000) => 32,
                        _ => 16,
                    };
                    let esize = 8 << size;
                    let per = container / esize;
                    let lanes = element_lanes(esize, datasize / esize, |e| {
                        (0, e - e % per + (per - 1 - e % per))
                    });
                    let n = (word >> 5 & 31) as u8;
                    Some(VecForm::Shuffle {
                        first: n,
                        second: n,
                        lanes,
                        keep: datasize as u8 / 8,
                    })
                },
                // XTN, XTN2: the low halves of n's elements, into d's lower or upper half
                (0, 0b10010) => {
                    let esize = 8 << size;
                    let narrow = element_lanes(esize, 64 / esize, |e| (1, 2 * e));
                    // (element e of n, 2 * esize bits wide: byte 2e*esize/8 of n, as an
                    // esize-wide index 2e)
                    let mut lanes = [0u8; 16];
                    for b in 0..8 {
                        lanes[b] = if q { b as u8 } else { narrow[b] };
                        if q {
                            lanes[8 + b] = narrow[b];
                        }
                    }
                    Some(VecForm::Shuffle {
                        first: (word & 31) as u8,
                        second: (word >> 5 & 31) as u8,
                        lanes,
                        keep: if q { 16 } else { 8 },
                    })
                },
                _ => None,
            }
        },
        Op::SimdShiftImm if vector => {
            let opcode = word >> 11 & 31;
            let immh = word >> 19 & 15;
            let immhb = word >> 16 & 127;
            let size = 31 - immh.leading_zeros();
            let esize = 8 << size;
            match (u, opcode) {
                (0, 0b01010) => Some(VecForm::Shift {
                    op: [0x6B, 0x8B, 0xAB, 0xCB][size as usize],
                    amount: immhb - esize,
                    zero: false,
                }),
                (_, 0b00000) => {
                    let amount = 2 * esize - immhb;
                    if u == 1 {
                        Some(VecForm::Shift {
                            op: [0x6D, 0x8D, 0xAD, 0xCD][size as usize],
                            amount,
                            zero: amount == esize,
                        })
                    }
                    else {
                        Some(VecForm::Shift {
                            op: [0x6C, 0x8C, 0xAC, 0xCC][size as usize],
                            amount: amount.min(esize - 1),
                            zero: false,
                        })
                    }
                },
                _ => None,
            }
        },
        Op::SimdModImm => {
            let op = word >> 29 & 1;
            let cmode = word >> 12 & 15;
            let imm8 = (word >> 16 & 7) << 5 | word >> 5 & 31;
            let imm64 = crate::aarch64::simd::expand_imm(op, cmode, imm8 as u64);
            let imm = if q { imm64 as u128 | (imm64 as u128) << 64 } else { imm64 as u128 };
            let keep = if q { u128::MAX } else { u64::MAX as u128 };
            let orr_bic = cmode < 0b1100 && cmode & 1 == 1;
            Some(match (orr_bic, op) {
                (true, 0) => VecForm::Immediate {
                    value: imm,
                    kind: IMM_OR,
                },
                (true, _) => VecForm::Immediate {
                    value: imm,
                    kind: IMM_AND_NOT,
                },
                (false, 1) if cmode < 0b1110 => VecForm::Immediate {
                    value: !imm & keep,
                    kind: IMM_SET,
                },
                _ => VecForm::Immediate {
                    value: imm & keep,
                    kind: IMM_SET,
                },
            })
        },
        Op::SimdCopy => {
            let imm5 = word >> 16 & 31;
            let imm4 = word >> 11 & 15;
            let size = imm5.trailing_zeros();
            let esize = 8 << size;
            let index = imm5 >> (size + 1);
            let n = (word >> 5 & 31) as u8;
            if !vector {
                // DUP (element), scalar: element `index` of n, the rest zero
                let lanes = element_lanes(esize, 1, |_| (0, index));
                return Some(VecForm::Shuffle {
                    first: n,
                    second: n,
                    lanes,
                    keep: (esize / 8) as u8,
                });
            }
            if u == 1 {
                return Some(VecForm::Insert {
                    esize,
                    index,
                    source: Some(imm4 >> size),
                });
            }
            match imm4 {
                0b0000 => {
                    let lanes = element_lanes(esize, datasize / esize, |_| (0, index));
                    Some(VecForm::Shuffle {
                        first: n,
                        second: n,
                        lanes,
                        keep: datasize as u8 / 8,
                    })
                },
                0b0001 => Some(VecForm::DupGeneral { esize }),
                0b0011 => Some(VecForm::Insert {
                    esize,
                    index,
                    source: None,
                }),
                0b0101 => Some(VecForm::Move {
                    esize,
                    index,
                    signed: true,
                    wide: q,
                }),
                _ => Some(VecForm::Move {
                    esize,
                    index,
                    signed: false,
                    wide: esize == 64,
                }),
            }
        },
        Op::SimdPermute => {
            let esize = 8 << size;
            let elements = datasize / esize;
            let part = word >> 14 & 1;
            let pairs = elements / 2;
            let lanes = match word >> 12 & 3 {
                // UZP1, UZP2
                0b01 => element_lanes(esize, elements, |e| {
                    let i = 2 * e + part;
                    if i < elements {
                        (0, i)
                    }
                    else {
                        (1, i - elements)
                    }
                }),
                // TRN1, TRN2
                0b10 => element_lanes(esize, elements, |e| (e % 2, 2 * (e / 2) + part)),
                // ZIP1, ZIP2
                _ => element_lanes(esize, elements, |e| (e % 2, part * pairs + e / 2)),
            };
            Some(VecForm::Shuffle {
                first: (word >> 5 & 31) as u8,
                second: (word >> 16 & 31) as u8,
                lanes,
                keep: datasize as u8 / 8,
            })
        },
        Op::SimdExtract => {
            // EXT: bytes position.. of m:n (the 64-bit form: of m's and n's low halves)
            let position = word >> 11 & 15;
            let mut lanes = [0u8; 16];
            for k in 0..datasize / 8 {
                let at = position + k;
                lanes[k as usize] = if q {
                    at as u8
                }
                else if at < 8 {
                    at as u8
                }
                else {
                    (16 + at - 8) as u8
                };
            }
            Some(VecForm::Shuffle {
                first: (word >> 5 & 31) as u8,
                second: (word >> 16 & 31) as u8,
                lanes,
                keep: datasize as u8 / 8,
            })
        },
        Op::FpInt => {
            // FMOV (general): sf, type, rmode, opcode
            let (sf, ptype, rmode, opcode) =
                (word >> 31, word >> 22 & 3, word >> 19 & 3, word >> 16 & 7);
            if word >> 29 & 1 != 0 || opcode < 6 {
                return None;
            }
            let (bits, top) = match (sf, ptype, rmode) {
                (0, 0, 0) => (32, false),
                (1, 1, 0) => (64, false),
                (1, 2, 1) => (64, true),
                _ => return None,
            };
            Some(VecForm::FmovGeneral {
                to_gpr: opcode == 6,
                bits,
                top,
            })
        },
        _ => None,
    }
}

impl Emitter<'_> {
    fn v_address(r: u32) -> u32 { state::v as u32 + 16 * r }
    fn vload(&mut self, r: u32) {
        self.c32(Self::v_address(r) as i32);
        self.b.simd_memory(V128_LOAD, 4);
    }
    fn vstore(&mut self) { self.b.simd_memory(V128_STORE, 4) }
    /// v128 & the low `bytes` bytes
    fn keep_bytes(&mut self, bytes: u8) {
        if bytes < 16 {
            let mut mask = [0u8; 16];
            mask[..bytes as usize].fill(0xFF);
            self.b.const_v128(mask);
            self.b.simd(V128_AND);
        }
    }
    fn splat_const(&mut self, value: u64, double: bool) {
        let bytes = if double {
            let mut b = [0u8; 16];
            b[..8].copy_from_slice(&value.to_le_bytes());
            b[8..].copy_from_slice(&value.to_le_bytes());
            b
        }
        else {
            let mut b = [0u8; 16];
            for lane in 0..4 {
                b[4 * lane..4 * lane + 4].copy_from_slice(&(value as u32).to_le_bytes());
            }
            b
        };
        self.b.const_v128(bytes);
    }
    /// Push whether every lane of `l` is zero or a normal number (with
    /// `result`: of exponent 2 or more)
    fn v_ordinary(&mut self, l: &WasmLocalV128, double: bool, result: bool) {
        let (low, inf, magnitude) = if double {
            (
                if result { 0x0020_0000_0000_0000u64 } else { 0x0010_0000_0000_0000 },
                0x7FF0_0000_0000_0000u64,
                0x7FFF_FFFF_FFFF_FFFFu64,
            )
        }
        else {
            (
                if result { 0x0100_0000u64 } else { 0x0080_0000 },
                0x7F80_0000u64,
                0x7FFF_FFFFu64,
            )
        };
        let (eq, ge_s, lt_s, all_true) =
            if double { (0xD6, 0xDB, 0xD8, 0xC3) } else { (0x37, 0x3F, 0x39, 0xA3) };
        self.b.get_local_v128(l);
        self.splat_const(magnitude, double);
        self.b.simd(V128_AND);
        let m = self.b.set_new_local_v128();
        self.b.get_local_v128(&m);
        self.b.simd_zero();
        self.b.simd(eq);
        self.b.get_local_v128(&m);
        self.splat_const(low, double);
        self.b.simd(ge_s);
        self.b.get_local_v128(&m);
        self.splat_const(inf, double);
        self.b.simd(lt_s);
        self.b.simd(V128_AND);
        self.b.simd(V128_OR);
        self.b.simd(all_true);
        self.b.free_local_v128(m);
    }
    /// V[r] as a v128 local (the 64-bit form: its low half in both halves)
    fn v_operand(&mut self, r: u32, q: bool) -> WasmLocalV128 {
        self.vload(r);
        if !q {
            self.vload(r);
            self.b
                .simd_shuffle([0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7]);
        }
        self.b.set_new_local_v128()
    }

    pub(super) fn vector_instruction(&mut self, offset: u16, i: &Inst, form: VecForm) {
        let word = i.imm as u32;
        let q = word >> 30 & 1 != 0;
        let (d, n, m) = (word & 31, word >> 5 & 31, word >> 16 & 31);
        let keep = if q { 16 } else { 8 };
        self.fp_check(offset);
        match form {
            VecForm::Binary { op, invert_m, test } => {
                self.c32(Self::v_address(d) as i32);
                self.vload(n);
                self.vload(m);
                if invert_m {
                    self.b.simd(V128_NOT);
                }
                if test {
                    self.b.simd(V128_AND);
                    self.b.simd_zero();
                }
                self.b.simd(op);
                self.keep_bytes(keep);
                self.vstore();
            },
            VecForm::Select {
                first,
                second,
                mask,
            } => {
                let register = |s: Source| match s {
                    Source::D => d,
                    Source::N => n,
                    Source::M => m,
                };
                self.c32(Self::v_address(d) as i32);
                self.vload(register(first));
                self.vload(register(second));
                self.vload(register(mask));
                self.b.simd(V128_BITSELECT);
                self.keep_bytes(keep);
                self.vstore();
            },
            VecForm::Unary { op, compare_zero } => {
                self.c32(Self::v_address(d) as i32);
                self.vload(n);
                if compare_zero {
                    self.b.simd_zero();
                }
                self.b.simd(op);
                self.keep_bytes(keep);
                self.vstore();
            },
            VecForm::Shift { op, amount, zero } => {
                self.c32(Self::v_address(d) as i32);
                if zero {
                    self.b.simd_zero();
                }
                else {
                    self.vload(n);
                    self.c32(amount as i32);
                    self.b.simd(op);
                    self.keep_bytes(keep);
                }
                self.vstore();
            },
            VecForm::Shuffle {
                first,
                second,
                lanes,
                keep,
            } => {
                self.c32(Self::v_address(d) as i32);
                self.vload(first as u32);
                self.vload(second as u32);
                self.b.simd_shuffle(lanes);
                self.keep_bytes(keep);
                self.vstore();
            },
            VecForm::Immediate { value, kind } => {
                self.c32(Self::v_address(d) as i32);
                if kind != IMM_SET {
                    self.vload(d);
                }
                self.b.const_v128(value.to_le_bytes());
                match kind {
                    IMM_OR => self.b.simd(V128_OR),
                    IMM_AND_NOT => self.b.simd(V128_ANDNOT),
                    _ => {},
                }
                if kind != IMM_SET {
                    self.keep_bytes(keep);
                }
                self.vstore();
            },
            VecForm::DupGeneral { esize } => {
                self.c32(Self::v_address(d) as i32);
                self.xr(n as u8);
                if esize == 64 {
                    self.b.simd(0x12);
                }
                else {
                    self.b.wrap_i64_to_i32();
                    self.b.simd([0x0F, 0x10, 0x11][(esize / 16) as usize]);
                }
                self.keep_bytes(keep);
                self.vstore();
            },
            VecForm::Insert {
                esize,
                index,
                source,
            } => {
                let (extract, replace) = match esize {
                    8 => (0x16, 0x17),
                    16 => (0x19, 0x1A),
                    32 => (0x1B, 0x1C),
                    _ => (0x1D, 0x1E),
                };
                self.c32(Self::v_address(d) as i32);
                self.vload(d);
                match source {
                    Some(source) => {
                        self.vload(n);
                        self.b.simd_lane(extract, source as u8);
                    },
                    None => {
                        self.xr(n as u8);
                        if esize != 64 {
                            self.b.wrap_i64_to_i32();
                        }
                    },
                }
                self.b.simd_lane(replace, index as u8);
                self.vstore();
            },
            VecForm::Move {
                esize,
                index,
                signed,
                wide,
            } => {
                self.vload(n);
                let extract = match (esize, signed) {
                    (8, true) => 0x15,
                    (8, false) => 0x16,
                    (16, true) => 0x18,
                    (16, false) => 0x19,
                    (32, _) => 0x1B,
                    _ => 0x1D,
                };
                self.b.simd_lane(extract, index as u8);
                if esize != 64 {
                    if signed && wide {
                        self.b.extend_signed_i32_to_i64();
                    }
                    else {
                        self.b.extend_unsigned_i32_to_i64();
                    }
                }
                self.set_x(d as u8);
            },
            VecForm::FmovGeneral { to_gpr, bits, top } => {
                let at = Self::v_address(if to_gpr { n } else { d }) + if top { 8 } else { 0 };
                if to_gpr {
                    self.c32(at as i32);
                    self.b.memory_op(
                        if bits == 32 { op::OP_I64LOAD32U } else { op::OP_I64LOAD },
                        if bits == 32 { 2 } else { 3 },
                        0,
                    );
                    self.set_x(d as u8);
                }
                else {
                    self.c32(at as i32);
                    self.xr(n as u8);
                    if bits == 32 {
                        self.c64(0xFFFF_FFFF);
                        self.b.and_i64();
                    }
                    self.b.store_aligned_i64(0);
                    if !top {
                        self.c32(at as i32 + 8);
                        self.c64(0);
                        self.b.store_aligned_i64(0);
                    }
                }
            },
            VecForm::Fp { op, double } => self.vector_fp(offset, word, op, double),
        }
    }

    /// The FP forms: the fast path, else the helper
    fn vector_fp(&mut self, offset: u16, word: u32, op: u8, double: bool) {
        let q = word >> 30 & 1 != 0;
        let (d, n, m) = (word & 31, word >> 5 & 31, word >> 16 & 31);
        let done = self.b.block_void();
        let a = self.v_operand(n, q);
        let b = self.v_operand(m, q);
        let c = if op >= 4 { Some(self.v_operand(d, q)) } else { None };
        // RMode RN and FZ 0 (FPCR), IXC already set (FPSR)
        self.load32(state::fpcr as u32);
        self.c32(0x01C0_0000);
        self.b.and_i32();
        self.b.eqz_i32();
        self.load32(state::fpsr as u32);
        self.c32(4);
        self.b.shr_u_i32();
        self.c32(1);
        self.b.and_i32();
        self.b.and_i32();
        for l in [Some(&a), Some(&b), c.as_ref()].into_iter().flatten() {
            self.v_ordinary(l, double, false);
            self.b.and_i32();
        }
        if op == 3 {
            // (FDIV: no divisor lane zero)
            self.b.get_local_v128(&b);
            self.splat_const(
                if double { 0x7FFF_FFFF_FFFF_FFFF } else { 0x7FFF_FFFF },
                double,
            );
            self.b.simd(V128_AND);
            self.b.simd_zero();
            self.b.simd(if double { 0xD7 } else { 0x38 });
            self.b.simd(if double { 0xC3 } else { 0xA3 });
            self.b.and_i32();
        }
        self.b.if_void();
        self.b.get_local_v128(&a);
        self.b.get_local_v128(&b);
        match op {
            4 | 5 => {
                self.b.get_local_v128(c.as_ref().unwrap());
                // relaxed_madd(n, m, d) = n * m + d, relaxed_nmadd = -(n * m) + d, fused (probed)
                self.b.simd(match (double, op == 5) {
                    (false, false) => 0x105,
                    (false, true) => 0x106,
                    (true, false) => 0x107,
                    (true, true) => 0x108,
                });
            },
            _ => {
                // (f32x4 add, sub, mul, div 0xE4-0xE7; f64x2 0xF0-0xF3)
                self.b.simd(if double { 0xF0 } else { 0xE4 } + op as u32);
            },
        }
        let r = self.b.set_new_local_v128();
        self.v_ordinary(&r, double, true);
        self.b.if_void();
        self.c32(Self::v_address(d) as i32);
        self.b.get_local_v128(&r);
        self.keep_bytes(if q { 16 } else { 8 });
        self.vstore();
        self.b.br(done);
        self.b.block_end();
        self.b.block_end();
        // the exact path: the interpreter
        let sync = HelperSync {
            gprs: vec![],
            nzcv: false,
        };
        self.helper_call(offset, &sync);
        self.b.block_end();
        self.b.free_local_v128(r);
        for l in [Some(a), Some(b), c].into_iter().flatten() {
            self.b.free_local_v128(l);
        }
    }
}
