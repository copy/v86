//! AArch32's page functions (docs/aarch32-plan.md Q6): EL0's A32 and T32
//! code in the A64 page tier's frame. R0-R14 (X0-X14's low halves) and NZCV
//! stay in the state's memory, so a helper call, the interpreter's execute
//! of the instruction (crate::aarch64::jit::pages::a32_page_helper), needs
//! no copies; branches are native (B, BL, B<c>, CBZ, CBNZ, BX and BLX of a
//! register to the same instruction set; another one retries in the
//! interpreter). What writes the PC otherwise (loads of the PC, LDM and POP
//! with it, data processing into it), changes the instruction set (BLX of
//! an immediate), raises an exception (SVC, BKPT, UDF) or waits (WFE, WFI,
//! YIELD), and the UNPREDICTABLE forms around the PC, are single steps.
//! Inside an IT block every instruction is a helper call or a step (ITSTATE
//! decides their conditions), but in IT blocks of native instructions only
//! (their conditions compiled, ITSTATE left 0, no block starts inside);
//! compiled code is entered at ITSTATE 0 (pages::run), and a step that
//! leaves ITSTATE set ends the activation.

use super::{Block, CompileEnv, Emitter, End, Isa, A0, A1, A2, C0, C1, NZCV, PAGE};
use crate::aarch64::state;
use crate::pagegen::frame::PageEmitter;
use crate::wasmgen::wasm_builder::{Signature, WasmType};
use std::collections::{BTreeMap, BTreeSet};

/// An AArch32 instruction of a page function
#[derive(Clone, Copy)]
pub struct Inst32 {
    /// A32's word, T32's halfword or two (the first in bits 31:16)
    pub word: u32,
    /// 4, or T32's 2
    pub length: u8,
    pub kind: Kind,
}

#[derive(Clone, Copy)]
pub enum Kind {
    /// the interpreter's execute (pages::a32_page_helper)
    Helper,
    /// B, BL, B<c>: to `target` (the page's offset, wrapping), when `cond`
    /// holds (14: always); BL's LR the next instruction's address (T32's
    /// with bit 0 set)
    Branch { target: u64, cond: u8, link: bool },
    /// CBZ, CBNZ (T32)
    CompareBranch { rn: u8, nonzero: bool, target: u64 },
    /// BX, BLX of a register: the same instruction set's target (else a
    /// retry), when `cond` holds (A32's may have one)
    Exchange { rm: u8, link: bool, cond: u8 },
    /// data processing (Q6.2): `op` A32's opcode (ORN 16), `rn` 16 for
    /// none (MOV, MVN), 15 the PC as the instruction set reads it (A32 +8,
    /// T32's Align(PC + 4, 4): ADR's); not into the PC
    Data {
        op: u8,
        s: bool,
        rd: u8,
        rn: u8,
        op2: Operand,
        cond: u8,
    },
    /// MOVW, MOVT
    Wide {
        rd: u8,
        imm: u16,
        top: bool,
        cond: u8,
    },
    /// LDR, STR and their byte, halfword and signed forms: a size of
    /// 1 << `size` bytes; `index`: the offset address accessed, `writeback`
    /// to Rn; Rn 15: a literal (no writeback); never of the PC
    Mem {
        load: bool,
        size: u8,
        signed: bool,
        rt: u8,
        rn: u8,
        offset: Offset,
        add: bool,
        index: bool,
        writeback: bool,
        cond: u8,
    },
    /// LDM, STM, PUSH, POP of R0-R14 (not of the base for LDM, nor with
    /// it and a writeback for STM): `increment`, `before` the addressing mode
    Multiple {
        load: bool,
        rn: u8,
        list: u16,
        increment: bool,
        before: bool,
        writeback: bool,
        cond: u8,
    },
    /// MUL, MLA, MLS (no flags)
    Multiply {
        rd: u8,
        rn: u8,
        rm: u8,
        ra: u8,
        sub: bool,
        cond: u8,
    },
    /// SXTB, SXTH, UXTB, UXTH (Rm rotated right by `rotation`)
    Extend {
        rd: u8,
        rm: u8,
        signed: bool,
        half: bool,
        rotation: u8,
        cond: u8,
    },
    /// LDRD, STRD of an immediate offset (word aligned, in one page)
    Dual {
        load: bool,
        rt: u8,
        rt2: u8,
        rn: u8,
        imm: u32,
        add: bool,
        index: bool,
        writeback: bool,
        cond: u8,
    },
    /// CLZ (0), REV (1), REV16 (2), REVSH (3)
    Bits { op: u8, rd: u8, rm: u8, cond: u8 },
    /// VLDR, VSTR (`single`: one register at Rn plus or minus `imm`; Rn 15
    /// a literal), VLDM, VSTM, VPUSH, VPOP: `count` S (or with `double` D)
    /// registers from `first`, word aligned and in one page (Q6.3)
    FpMemory {
        load: bool,
        double: bool,
        first: u8,
        count: u8,
        rn: u8,
        imm: u16,
        add: bool,
        single: bool,
        writeback: bool,
        cond: u8,
    },
    /// VADD, VSUB, VMUL, VNMUL, VDIV (`op` 0-4) of S (or with `double` D)
    /// registers: on A64's fast path (RN, no flush, IXC set, ordinary
    /// operands and result: Wasm's arithmetic), else the helper (Q6.3)
    FpArith {
        op: u8,
        double: bool,
        d: u8,
        n: u8,
        m: u8,
        cond: u8,
    },
    /// VFP's moves (Q6.3): `kind` 0 VMOV (register), 1 VABS, 2 VNEG of S or
    /// D registers (`double`) m to d; 3 core register `n` to S[d]; 4 S[m] to
    /// core register `d`; 5 core registers `n`, `m` to D[d]; 6 D[d] to them
    FpMove {
        kind: u8,
        double: bool,
        d: u8,
        n: u8,
        m: u8,
        cond: u8,
    },
    /// VLD1, VST1 of multiple single elements (whole D registers `first`..,
    /// `count` of them): word aligned (and to `align` bytes, 0 none) and in
    /// one page; Rm 15 no writeback, 13 the size, else Rm added (Q6.3)
    Vld1 {
        load: bool,
        first: u8,
        count: u8,
        rn: u8,
        rm: u8,
        align: u8,
    },
    /// an IT whose instructions are all native (with their conditions,
    /// pagegen's discovery): nothing at run time, ITSTATE stays 0
    It,
    /// Transfers between core registers and system or extension registers
    /// (Q6.3 part 4): `op` TRANSFER_*; `address` the state's field (the
    /// TPIDR registers) or the element's byte (VMOV scalar: `size` bytes,
    /// `signed`); VDUP's Q (`q`)
    Transfer {
        op: u8,
        rt: u8,
        address: u32,
        size: u8,
        signed: bool,
        q: bool,
        cond: u8,
    },
    /// Advanced SIMD data processing (Q6.3 part 3), unconditional (T32's in
    /// an IT block are helper calls): `form` on D registers (`q` false: the
    /// 64 bits of D[d], D[n], D[m]; the other half of their Q register
    /// stays) or Q registers (Q[d/2], ...)
    Neon {
        form: NeonForm,
        q: bool,
        d: u8,
        n: u8,
        m: u8,
    },
}

/// The template of an Advanced SIMD data processing instruction (Wasm SIMD,
/// neon.rs's lane operations)
#[derive(Clone, Copy)]
pub enum NeonForm {
    /// d = op(n, m), the lanes' operation `op`; `invert_m`: VORN's m
    /// inverted first; `test`: VTST, (n & m) != 0 with `op` the lanes' ne
    Binary { op: u32, invert_m: bool, test: bool },
    /// VBSL, VBIT, VBIF: v128.bitselect(first, second, mask), each 0 (d), 1 (n) or 2 (m)
    Select { first: u8, second: u8, mask: u8 },
    /// d = op(m, amount): VSHL, VSHR by an immediate; `zero`: VSHR.U by the element's size
    Shift { op: u32, amount: u8, zero: bool },
    /// VMOV, VMVN (`kind` 0: d = value), VORR (1: d | value), VBIC (2: d & value) of a modified immediate
    Immediate { value: u64, kind: u8 },
    /// VDUP (scalar): element `index` of D[m] (`esize` bits) in every element
    Dup { esize: u8, index: u8 },
    /// VEXT, VREV: the bytes `lanes` of first:m (0-15 first's, n's or with
    /// `of_m` m's; 16-31 m's)
    Shuffle { lanes: [u8; 16], of_m: bool },
    /// d = op(m): VMVN, VCNT, VABS, VNEG (register)
    Unary { op: u32 },
}

/// (debugging) the kind's name, and a condition's
pub fn kind_name(kind: &Kind) -> String {
    match kind {
        Kind::Helper => "helper".into(),
        Kind::Branch { cond, .. } => format!("branch/{}", cond),
        Kind::CompareBranch { .. } => "cbz".into(),
        Kind::Exchange { cond, .. } => format!("bx/{}", cond),
        Kind::Data { cond, s, .. } => format!("data{}/{}", if *s { "s" } else { "" }, cond),
        Kind::Wide { cond, .. } => format!("wide/{}", cond),
        Kind::Mem { cond, .. } => format!("mem/{}", cond),
        Kind::Multiple { .. } => "multiple".into(),
        Kind::Multiply { cond, .. } => format!("mul/{}", cond),
        Kind::Extend { cond, .. } => format!("extend/{}", cond),
        Kind::Dual { .. } => "dual".into(),
        Kind::Bits { cond, .. } => format!("bits/{}", cond),
        Kind::FpMemory { .. } => "fpmem".into(),
        Kind::FpArith { .. } => "fparith".into(),
        Kind::FpMove { .. } => "fpmove".into(),
        Kind::Vld1 { .. } => "vld1".into(),
        Kind::It => "it".into(),
        Kind::Neon { .. } => "neon".into(),
        Kind::Transfer { op, cond, .. } => format!("transfer{}/{}", op, cond),
    }
}

/// Data processing's second operand
#[derive(Clone, Copy)]
pub enum Operand {
    /// a constant, and its shifter carry (None: C as it was)
    Imm { value: u32, carry: Option<bool> },
    /// a register shifted by a constant: `kind` 0 LSL, 1 LSR, 2 ASR, 3 ROR,
    /// 4 RRX; `amount` 0 none, LSR and ASR up to 32
    Reg { rm: u8, kind: u8, amount: u8 },
    /// a register shifted by Rs's bottom byte (`kind` 0-3)
    RegShift { rm: u8, kind: u8, rs: u8 },
}

/// A load's or store's offset
#[derive(Clone, Copy)]
pub enum Offset {
    Imm(u32),
    /// a register shifted left
    Reg {
        rm: u8,
        shift: u8,
    },
}

// data processing's operations (A32's opcodes; ORN T32's)
const AND: u8 = 0;
const EOR: u8 = 1;
const SUB: u8 = 2;
const RSB: u8 = 3;
const ADD: u8 = 4;
const ADC: u8 = 5;
const SBC: u8 = 6;
const RSC: u8 = 7;
const TST: u8 = 8;
const TEQ: u8 = 9;
const CMP: u8 = 10;
const CMN: u8 = 11;
const ORR: u8 = 12;
const MOV: u8 = 13;
const BIC: u8 = 14;
const MVN: u8 = 15;
const ORN: u8 = 16;
/// no first operand
const NONE: u8 = 16;

/// VFP's and Advanced SIMD's loads and stores with native templates (Q6.3):
/// A32's word, or T32's (whose halfwords are A32's with the condition 1110
/// and, for Advanced SIMD, 1111 1001 for 1111 0100): VLDR, VSTR, VLDM,
/// VSTM (not FLDMX nor FSTMX, nor the UNPREDICTABLE forms) and VLD1, VST1
/// of multiple single elements; None for anything else
fn fp_memory(word: u32, thumb: bool) -> Option<Kind> {
    let rn = (word >> 16 & 15) as u8;
    let simd = if thumb { word >> 24 == 0xF9 } else { word >> 24 == 0xF4 };
    if simd {
        // 1111 0100 A D L 0 Rn Vd type size align Rm, A 0 (multiple structures)
        if word & 1 << 23 != 0 || word & 1 << 20 != 0 || rn == 15 {
            return None;
        }
        let align_field = word >> 4 & 3;
        let count = match word >> 8 & 15 {
            0b0111 if align_field & 2 == 0 => 1,
            0b1010 if align_field != 3 => 2,
            0b0110 if align_field & 2 == 0 => 3,
            0b0010 => 4,
            _ => return None,
        };
        let first = (word >> 22 & 1) << 4 | word >> 12 & 15;
        if first + count > 32 {
            return None;
        }
        return Some(Kind::Vld1 {
            load: word & 1 << 21 != 0,
            first: first as u8,
            count: count as u8,
            rn,
            rm: (word & 15) as u8,
            align: if align_field == 0 { 0 } else { 4 << align_field },
        });
    }
    let cond = (word >> 28) as u8;
    if cond == 15 || word >> 25 & 7 != 0b110 || word >> 9 & 7 != 0b101 {
        return None;
    }
    let (p, u, w, l) = (
        word & 1 << 24 != 0,
        word & 1 << 23 != 0,
        word & 1 << 21 != 0,
        word & 1 << 20 != 0,
    );
    let double = word & 1 << 8 != 0;
    let (vd, bit) = (word >> 12 & 15, word >> 22 & 1);
    let first = if double { bit << 4 | vd } else { vd << 1 | bit };
    let imm8 = word & 0xFF;
    let cond = if thumb { 14 } else { cond };
    if p && !w {
        // VLDR, VSTR
        return Some(Kind::FpMemory {
            load: l,
            double,
            first: first as u8,
            count: 1,
            rn,
            imm: (imm8 * 4) as u16,
            add: u,
            single: true,
            writeback: false,
            cond,
        });
    }
    // VLDM, VSTM: increment after (W 0 or 1), or decrement before with W
    if p == u || p && !w || rn == 15 || double && imm8 & 1 != 0 {
        return None;
    }
    let count = if double { imm8 / 2 } else { imm8 };
    if count == 0 || first + count > 32 || double && count > 16 {
        return None;
    }
    Some(Kind::FpMemory {
        load: l,
        double,
        first: first as u8,
        count: count as u8,
        rn,
        imm: 0,
        add: u,
        single: false,
        writeback: w,
        cond,
    })
}

/// VFP's data processing with native templates (Q6.3): A32's word or
/// T32's (A32's with the condition 1110): the arithmetic of FpArith and
/// the moves of FpMove; None for anything else
/// Kind::Transfer's operations
const TRANSFER_READ: u8 = 0;
const TRANSFER_WRITE: u8 = 1;
const TRANSFER_FPSCR: u8 = 2;
const TRANSFER_FPSCR_FLAGS: u8 = 3;
const TRANSFER_FROM_SCALAR: u8 = 4;
const TRANSFER_TO_SCALAR: u8 = 5;
const TRANSFER_DUP: u8 = 6;

/// MRC and MCR of the thread ID registers (EL0: TPIDRURW and TPIDRURO;
/// PL1's reads of those and TPIDRPRW), VMRS of FPSCR, VMOV between a core
/// register and a scalar, VDUP (core) as native transfers (Q6.3 part 4)
fn transfer(word: u32, thumb: bool, el1: bool) -> Option<Kind> {
    let cond = (word >> 28) as u8;
    if cond == 15 || word >> 24 & 15 != 0b1110 || word & 1 << 4 == 0 {
        return None;
    }
    let cond = if thumb { 14 } else { cond };
    let rt = (word >> 12 & 15) as u8;
    if rt == 15 && word & 0x0FFF_0FFF != 0x0EF1_0A10 || thumb && rt == 13 {
        return None;
    }
    let read = word & 1 << 20 != 0;
    let kind = |op: u8, address: u32, size: u8, signed: bool, q: bool| {
        Some(Kind::Transfer {
            op,
            rt,
            address,
            size,
            signed,
            q,
            cond,
        })
    };
    match word >> 8 & 15 {
        15 => {
            // MRC, MCR p15: opc1 0, CRn 13, CRm 0
            if word >> 21 & 7 != 0 || word >> 16 & 15 != 13 || word & 15 != 0 {
                return None;
            }
            let field = match (word >> 5 & 7, el1) {
                (2, _) => state::tpidr_el0 as u32,
                (3, _) => state::tpidrro_el0 as u32,
                (4, true) => state::tpidr_el1 as u32,
                _ => return None,
            };
            if read {
                kind(TRANSFER_READ, field, 4, false, false)
            }
            else if !el1 && word >> 5 & 7 == 2 {
                kind(TRANSFER_WRITE, field, 4, false, false)
            }
            else {
                None
            }
        },
        10 => {
            // VMRS Rt, FPSCR; VMRS APSR_nzcv, FPSCR
            if word & 0x0FFF_0FFF != 0x0EF1_0A10 {
                return None;
            }
            kind(
                if rt == 15 { TRANSFER_FPSCR_FLAGS } else { TRANSFER_FPSCR },
                0,
                4,
                false,
                false,
            )
        },
        11 => {
            // VMOV (scalar), VDUP (core): D[Vn:N]
            if word & 15 != 0 || rt == 15 {
                return None;
            }
            let n = (word >> 7 & 1) << 4 | word >> 16 & 15;
            let unsigned = word & 1 << 23 != 0;
            if !read && unsigned {
                let (b, q, e) = (word >> 22 & 1, word >> 21 & 1 != 0, word >> 5 & 1);
                if word & 1 << 6 != 0 || b == 1 && e == 1 || q && n & 1 != 0 {
                    return None;
                }
                return kind(
                    TRANSFER_DUP,
                    state::v as u32 + 8 * n,
                    if b == 1 {
                        1
                    }
                    else if e == 1 {
                        2
                    }
                    else {
                        4
                    },
                    false,
                    q,
                );
            }
            let (size, index) = if word & 1 << 22 != 0 {
                (1, (word >> 21 & 1) << 2 | (word >> 5 & 3))
            }
            else if word & 1 << 5 != 0 {
                (2, (word >> 21 & 1) << 1 | (word >> 6 & 1))
            }
            else if word & 1 << 6 == 0 && !unsigned {
                (4, word >> 21 & 1)
            }
            else {
                return None;
            };
            let address = state::v as u32 + 8 * n + size * index;
            if read {
                kind(
                    TRANSFER_FROM_SCALAR,
                    address,
                    size as u8,
                    !unsigned && size < 4,
                    false,
                )
            }
            else {
                kind(TRANSFER_TO_SCALAR, address, size as u8, false, false)
            }
        },
        _ => None,
    }
}

/// Advanced SIMD data processing (A32's 1111 001U, T32's 111U 1111) as a
/// native form (Q6.3 part 3); None: a helper call (the others, and the
/// UNDEFINED forms: odd Q registers, reserved sizes)
fn neon_data(word: u32, thumb: bool) -> Option<Kind> {
    if !cfg!(target_feature = "simd128") {
        return None;
    }
    let word = if thumb {
        if word >> 24 & 0xEF != 0xEF {
            return None;
        }
        0xF200_0000 | (word >> 28 & 1) << 24 | word & 0x00FF_FFFF
    }
    else {
        if word >> 25 != 0b111_1001 {
            return None;
        }
        word
    };
    let d = (word >> 22 & 1) << 4 | word >> 12 & 15;
    let n = (word >> 7 & 1) << 4 | word >> 16 & 15;
    let m = (word >> 5 & 1) << 4 | word & 15;
    let q = word & 1 << 6 != 0;
    let u = word >> 24 & 1;
    let even = |r: u32| !q || r & 1 == 0;
    let neon = |form: NeonForm, registers: &[u32]| {
        registers.iter().all(|&r| even(r)).then_some(Kind::Neon {
            form,
            q,
            d: d as u8,
            n: n as u8,
            m: m as u8,
        })
    };
    if word & 1 << 23 == 0 {
        // three registers of the same length
        let size = (word >> 20 & 3) as usize;
        let lanes = |table: [u32; 4]| Some(table[size]).filter(|&op| op != 0);
        let binary = |op: Option<u32>, test: bool| {
            op.and_then(|op| {
                neon(
                    NeonForm::Binary {
                        op,
                        invert_m: false,
                        test,
                    },
                    &[d, n, m],
                )
            })
        };
        return match (word >> 8 & 15, word >> 4 & 1, u) {
            (0b0001, 1, 0) => neon(
                NeonForm::Binary {
                    op: [0x4E, 0x4F, 0x50, 0x50][size],
                    invert_m: size == 3,
                    test: false,
                },
                &[d, n, m],
            ),
            (0b0001, 1, _) => neon(
                match size {
                    0 => NeonForm::Binary {
                        op: 0x51,
                        invert_m: false,
                        test: false,
                    },
                    1 => NeonForm::Select {
                        first: 1,
                        second: 2,
                        mask: 0,
                    },
                    2 => NeonForm::Select {
                        first: 1,
                        second: 0,
                        mask: 2,
                    },
                    _ => NeonForm::Select {
                        first: 0,
                        second: 1,
                        mask: 2,
                    },
                },
                &[d, n, m],
            ),
            (0b1000, 0, 0) => binary(lanes([0x6E, 0x8E, 0xAE, 0xCE]), false),
            (0b1000, 0, _) => binary(lanes([0x71, 0x91, 0xB1, 0xD1]), false),
            (0b1000, 1, 0) => binary(lanes([0x24, 0x2E, 0x38, 0]), true),
            (0b1000, 1, _) => binary(lanes([0x23, 0x2D, 0x37, 0]), false),
            (0b0011, 0, 0) => binary(lanes([0x27, 0x31, 0x3B, 0]), false),
            (0b0011, 0, _) => binary(lanes([0x28, 0x32, 0x3C, 0]), false),
            (0b0011, 1, 0) => binary(lanes([0x2B, 0x35, 0x3F, 0]), false),
            (0b0011, 1, _) => binary(lanes([0x2C, 0x36, 0x40, 0]), false),
            (0b0110, 0, 0) => binary(lanes([0x78, 0x98, 0xB8, 0]), false),
            (0b0110, 0, _) => binary(lanes([0x79, 0x99, 0xB9, 0]), false),
            (0b0110, 1, 0) => binary(lanes([0x76, 0x96, 0xB6, 0]), false),
            (0b0110, 1, _) => binary(lanes([0x77, 0x97, 0xB7, 0]), false),
            (0b1001, 1, 0) => binary(lanes([0, 0x95, 0xB5, 0]), false),
            _ => None,
        };
    }
    if word & 1 << 4 != 0 {
        if word >> 19 & 7 == 0 && word & 1 << 7 == 0 {
            // one register and a modified immediate (expand_imm: VMVN's and
            // VBIC's inverted)
            let imm8 = (word >> 24 & 1) << 7 | (word >> 16 & 7) << 4 | word & 15;
            let (cmode, op) = (word >> 8 & 15, word >> 5 & 1);
            if cmode == 15 && op == 1 {
                return None;
            }
            let value = crate::aarch64::a32_simd::expand_imm(imm8, cmode, op);
            let kind = if cmode & 1 == 1 && cmode < 12 { 1 + op as u8 } else { 0 };
            return neon(NeonForm::Immediate { value, kind }, &[d]);
        }
        // shifts by an immediate: VSHR, VSHL
        let imm6 = word >> 16 & 63;
        let size = if word & 1 << 7 != 0 {
            3
        }
        else {
            match imm6 >> 3 {
                0 => return None,
                1 => 0,
                2 | 3 => 1,
                _ => 2,
            }
        };
        let esize = 8u32 << size;
        let field = if size == 3 { imm6 } else { imm6 & (2 * esize - 1) };
        return match (word >> 8 & 15, u) {
            (0b0000, _) => {
                let amount = (if size == 3 { 64 } else { 2 * esize }) - field;
                let zero = u == 1 && amount == esize;
                let op =
                    if u == 1 { [0x6D, 0x8D, 0xAD, 0xCD] } else { [0x6C, 0x8C, 0xAC, 0xCC] }[size];
                neon(
                    NeonForm::Shift {
                        op,
                        amount: amount.min(esize - 1) as u8,
                        zero,
                    },
                    &[d, m],
                )
            },
            (0b0101, 0) => neon(
                NeonForm::Shift {
                    op: [0x6B, 0x8B, 0xAB, 0xCB][size],
                    amount: (if size == 3 { field } else { field - esize }) as u8,
                    zero: false,
                },
                &[d, m],
            ),
            _ => None,
        };
    }
    if word >> 20 & 3 != 3 {
        return None;
    }
    if word & 1 << 24 == 0 {
        // VEXT: bytes from imm4 of n:m
        let imm = (word >> 8 & 15) as u8;
        let bytes = if q { 16 } else { 8 };
        if imm >= bytes {
            return None;
        }
        let mut lanes = [0u8; 16];
        for i in 0..bytes {
            let at = i + imm;
            lanes[i as usize] = if at < bytes { at } else { 16 + at - bytes };
        }
        return neon(NeonForm::Shuffle { lanes, of_m: false }, &[d, n, m]);
    }
    if word >> 7 & 31 == 0b11000 {
        // VDUP (scalar)
        let imm4 = word >> 16 & 15;
        let (esize, index) = match imm4.trailing_zeros() {
            0 => (8, imm4 >> 1),
            1 => (16, imm4 >> 2),
            2 => (32, imm4 >> 3),
            _ => return None,
        };
        return neon(
            NeonForm::Dup {
                esize,
                index: index as u8,
            },
            &[d],
        );
    }
    if word & 1 << 11 != 0 {
        return None;
    }
    // two registers, miscellaneous
    let size = (word >> 18 & 3) as usize;
    let unary = |op: u32| neon(NeonForm::Unary { op }, &[d, m]);
    match (word >> 16 & 3, word >> 7 & 15) {
        (0b00, 0b1011) if size == 0 => unary(0x4D),
        (0b00, 0b1010) if size == 0 => unary(0x62),
        (0b01, 0b0110) if size < 3 => unary([0x60, 0x80, 0xA0][size]),
        (0b01, 0b0111) if size < 3 => unary([0x61, 0x81, 0xA1][size]),
        (0b00, rev @ 0..=2) => {
            // VREV64, VREV32, VREV16: the elements reversed in each region
            let (region, element) = (8 >> rev, 1 << size);
            if element >= region {
                return None;
            }
            let mut lanes = [0u8; 16];
            for i in 0..16 {
                let (start, j, k) = (i - i % region, i % region / element, i % element);
                lanes[i as usize] = (start + (region / element - 1 - j) * element + k) as u8;
            }
            neon(NeonForm::Shuffle { lanes, of_m: true }, &[d, m])
        },
        _ => None,
    }
}

fn fp_data(word: u32, thumb: bool) -> Option<Kind> {
    let cond = (word >> 28) as u8;
    if cond == 15 {
        return None;
    }
    let cond = if thumb { 14 } else { cond };
    let double = word & 1 << 8 != 0;
    let (vd, vn, vm) = (word >> 12 & 15, word >> 16 & 15, word & 15);
    let (bd, bn, bm) = (word >> 22 & 1, word >> 7 & 1, word >> 5 & 1);
    let reg = |v: u32, bit: u32| (if double { bit << 4 | v } else { v << 1 | bit }) as u8;
    let (d, n, m) = (reg(vd, bd), reg(vn, bn), reg(vm, bm));
    let op = match word & 0x0FB0_0E50 {
        0x0E30_0A00 => Some(0),
        0x0E30_0A40 => Some(1),
        0x0E20_0A00 => Some(2),
        0x0E20_0A40 => Some(4),
        0x0E80_0A00 => Some(3),
        _ => None,
    };
    if let Some(op) = op {
        return Some(Kind::FpArith {
            op,
            double,
            d,
            n,
            m,
            cond,
        });
    }
    let unary = match word & 0x0FBF_0ED0 {
        0x0EB0_0A40 => Some(0),
        0x0EB0_0AC0 => Some(1),
        0x0EB1_0A40 => Some(2),
        _ => None,
    };
    if let Some(kind) = unary {
        return Some(Kind::FpMove {
            kind,
            double,
            d,
            n: 0,
            m,
            cond,
        });
    }
    let rt = (word >> 12 & 15) as u8;
    if word & 0x0FE0_0F7F == 0x0E00_0A10 && rt != 15 {
        // VMOV between Rt and S[Vn:N]
        let s = (vn << 1 | bn) as u8;
        return Some(if word & 1 << 20 != 0 {
            Kind::FpMove {
                kind: 4,
                double: false,
                d: rt,
                n: 0,
                m: s,
                cond,
            }
        }
        else {
            Kind::FpMove {
                kind: 3,
                double: false,
                d: s,
                n: rt,
                m: 0,
                cond,
            }
        });
    }
    let rt2 = (word >> 16 & 15) as u8;
    if word & 0x0FE0_0FD0 == 0x0C40_0B10 && rt != 15 && rt2 != 15 {
        // VMOV between Rt, Rt2 and D[M:Vm] (to the core registers: not one register twice)
        let dm = (bm << 4 | vm) as u8;
        if word & 1 << 20 != 0 {
            if rt == rt2 {
                return None;
            }
            return Some(Kind::FpMove {
                kind: 6,
                double: true,
                d: dm,
                n: rt,
                m: rt2,
                cond,
            });
        }
        return Some(Kind::FpMove {
            kind: 5,
            double: true,
            d: dm,
            n: rt,
            m: rt2,
            cond,
        });
    }
    None
}

/// DecodeImmShift: the kind and amount of a constant shift (`kind` 0-3, `imm5`)
fn imm_shift(kind: u32, imm5: u32) -> (u8, u8) {
    match (kind, imm5) {
        (1 | 2, 0) => (kind as u8, 32),
        (3, 0) => (4, 1),
        _ => (kind as u8, imm5 as u8),
    }
}

/// The targets of an instruction that ends a block, in the page or not
/// (pagegen::successors keeps the page's)
pub fn targets(i: &Inst32, _offset: u16) -> Vec<u64> {
    match i.kind {
        Kind::Branch { target, .. } | Kind::CompareBranch { target, .. } => vec![target],
        _ => vec![],
    }
}

/// How an instruction ends a block: its in-page targets and whether it
/// falls through; None: it does not
fn control(i: &Inst32, offset: u16) -> Option<(Vec<u64>, bool)> {
    match i.kind {
        Kind::Branch { target, cond, link } => Some((
            if link { vec![target, offset as u64 + i.length as u64] } else { vec![target] },
            cond != 14,
        )),
        Kind::CompareBranch { target, .. } => Some((vec![target], true)),
        // (a return: LDM, POP, LDR of the PC)
        Kind::Multiple { list, cond, .. } if list & 0x8000 != 0 => Some((vec![], cond != 14)),
        Kind::Mem {
            load: true,
            rt: 15,
            cond,
            ..
        } => Some((vec![], cond != 14)),
        Kind::Exchange { link, cond, .. } => Some((
            if link || cond != 14 { vec![offset as u64 + i.length as u64] } else { vec![] },
            cond != 14,
        )),
        _ => None,
    }
}

/// (PL1, cpu_type arm32: docs/aarch32-plan.md R5.3) the instructions a PL1
/// function steps that are helpers otherwise: MSR of CPSR's control or
/// extension field (the mode, the masks: a function is of one privilege,
/// and interrupts are taken between activations) and CP15's writes, MCR
/// and MCRR (the MMU's controls, TLB and cache maintenance)
fn pl1_steps(word: u32, length: u8, thumb: bool) -> bool {
    if !thumb {
        let msr = word & 0x0FB0_F000 == 0x0320_F000 || word & 0x0FB0_FFF0 == 0x0120_F000;
        let mcr = word & 0x0F10_0010 == 0x0E00_0010 || word & 0x0FF0_0000 == 0x0C40_0000;
        return msr && word & 1 << 22 == 0 && word >> 16 & 3 != 0 || mcr && word >> 8 & 15 == 15;
    }
    if length != 4 {
        return false;
    }
    let (hw1, hw2) = (word >> 16, word & 0xFFFF);
    let msr = hw1 & 0xFFE0 == 0xF380 && hw2 & 0xD020 == 0x8000 && hw2 >> 8 & 3 != 0;
    let mcr = (hw1 & 0xEF10 == 0xEE00 && hw2 & 0x10 != 0 || hw1 & 0xEFF0 == 0xEC40)
        && hw2 >> 8 & 15 == 15;
    msr || mcr
}

fn sign_extend(value: u32, bits: u32) -> i64 {
    ((value << (32 - bits)) as i32 >> (32 - bits)) as i64
}

/// A32: the instruction's kind at `offset`; None: a single step
fn a32(word: u32, offset: u16) -> Option<Kind> {
    let cond = (word >> 28) as u8;
    let rd = word >> 12 & 15;
    let rn = word >> 16 & 15;
    if cond == 0xF {
        // the unconditional space: Advanced SIMD (data processing, element
        // and structure loads and stores), PLD and PLI, the barriers and
        // CLREX, VFP's unconditional forms; BLX of an immediate changes the
        // instruction set, CPS, SETEND, RFE and SRS are not EL0's
        let helper = word >> 25 & 7 == 0b001
            || word >> 24 & 15 == 0b0100 && word & 1 << 20 == 0
            || word >> 26 & 3 == 0b01 && word >> 20 & 3 == 0b01
            || word & 0xFFFF_FF00 == 0xF57F_F000
            || word >> 24 & 15 == 0b1110;
        return helper.then_some(Kind::Helper);
    }
    let compare = |w: u32| w >> 23 & 3 == 2 && w & 1 << 20 != 0;
    match word >> 25 & 7 {
        0b101 => Some(Kind::Branch {
            target: (offset as i64 + 8 + sign_extend(word & 0xFF_FFFF, 24) * 4) as u64,
            cond,
            link: word & 1 << 24 != 0,
        }),
        0b100 => {
            // LDM and STM: not the user registers' nor an exception return,
            // nor LDM of the PC; the PC as the base is UNPREDICTABLE
            let writes_pc = word & 1 << 20 != 0 && word & 1 << 15 != 0;
            (word & 1 << 22 == 0 && !writes_pc && rn != 15).then_some(Kind::Helper)
        },
        0b010 | 0b011 => {
            if word & 1 << 25 != 0 && word & 1 << 4 != 0 {
                // the media instructions (UDF among them): Rd in bits 15:12
                // (Rn 1111 the extends' and BFC's without an operand, REV's),
                // the signed multiplies' and USAD8's in bits 19:16
                let udf = word >> 20 & 0xFF == 0x7F && word >> 4 & 15 == 15;
                let high =
                    word >> 23 & 31 == 0b01110 || word >> 20 & 0xFF == 0x78 && word >> 5 & 7 == 0;
                return (!udf && if high { rn != 15 } else { rd != 15 }).then_some(Kind::Helper);
            }
            // LDR, STR, LDRB, STRB (and the unprivileged forms)
            let load = word & 1 << 20 != 0;
            let writeback = word & 1 << 24 == 0 || word & 1 << 21 != 0;
            (!(load && rd == 15) && !(writeback && rn == 15)).then_some(Kind::Helper)
        },
        0b110 | 0b111 => {
            // SVC, else the coprocessors' (VFP, Advanced SIMD's transfers,
            // CP15's EL0 registers; their traps are exceptions)
            (word >> 24 & 15 != 15).then_some(Kind::Helper)
        },
        _ => {
            // data processing and the miscellaneous instructions
            let immediate = word & 1 << 25 != 0;
            let op = word >> 21 & 15;
            let s = word & 1 << 20 != 0;
            if !immediate && word & 0x90 == 0x90 {
                // multiplies, swaps and exclusives, the extra loads and stores
                if word >> 5 & 3 == 0 {
                    return (rd != 15 && rn != 15).then_some(Kind::Helper);
                }
                let load = word & 1 << 20 != 0;
                let dual = !load && word >> 5 & 2 != 0;
                let writeback = word & 1 << 24 == 0 || word & 1 << 21 != 0;
                if load && rd == 15 || dual && rd >= 14 || writeback && rn == 15 {
                    return None;
                }
                return Some(Kind::Helper);
            }
            if op >> 2 == 2 && !s {
                if immediate {
                    // MOVW, MOVT; MSR of an immediate and the hints (NOP the
                    // only one that goes on)
                    if op & 1 == 0 {
                        return (rd != 15).then_some(Kind::Helper);
                    }
                    if word & 0x0FFF_FFFF == 0x0320_F000 {
                        return Some(Kind::Helper);
                    }
                    return (rn != 0 && word & 1 << 22 == 0).then_some(Kind::Helper);
                }
                // BX, BLX of a register
                if word & 0x0FFF_FFD0 == 0x012F_FF10 && word & 15 != 15 {
                    return Some(Kind::Exchange {
                        rm: (word & 15) as u8,
                        link: word & 1 << 5 != 0,
                        cond,
                    });
                }
                return match word >> 4 & 15 {
                    // MRS, MSR of a register
                    0 => (word & 1 << 21 != 0 || rd != 15).then_some(Kind::Helper),
                    // CLZ
                    1 if op == 0b1011 => (rd != 15).then_some(Kind::Helper),
                    // QADD, QSUB, QDADD, QDSUB
                    5 => (rd != 15).then_some(Kind::Helper),
                    // the halfword multiplies
                    8 | 10 | 12 | 14 => (rd != 15 && rn != 15).then_some(Kind::Helper),
                    _ => None,
                };
            }
            (rd != 15 || compare(word)).then_some(Kind::Helper)
        },
    }
}

/// T32: the kind of the instruction (`length` 2 or 4) at `offset`; None: a single step
fn t32(word: u32, length: u8, offset: u16) -> Option<Kind> {
    if length == 2 {
        let hw = word;
        return match hw >> 10 {
            0b010001 => {
                // ADD, CMP, MOV of the high registers; BX, BLX
                let rdn = (hw >> 4 & 8 | hw & 7) as u8;
                match hw >> 8 & 3 {
                    0 | 2 => (rdn != 15).then_some(Kind::Helper),
                    1 => Some(Kind::Helper),
                    _ => {
                        let rm = (hw >> 3 & 15) as u8;
                        (rm != 15).then_some(Kind::Exchange {
                            rm,
                            link: hw & 0x80 != 0,
                            cond: 14,
                        })
                    },
                }
            },
            0b101100..=0b101111 => {
                if hw & 0xF500 == 0xB100 {
                    // CBZ, CBNZ
                    let imm = (hw >> 3 & 0x40 | hw >> 2 & 0x3E) as u64;
                    return Some(Kind::CompareBranch {
                        rn: (hw & 7) as u8,
                        nonzero: hw & 0x800 != 0,
                        target: offset as u64 + 4 + imm,
                    });
                }
                match hw >> 8 & 15 {
                    // POP with the PC
                    0xD => None,
                    // CPS, SETEND
                    0x6 => None,
                    // BKPT
                    0xE => None,
                    // IT; the hints (NOP the only one that goes on)
                    0xF => (hw & 15 != 0 || hw == 0xBF00).then_some(Kind::Helper),
                    _ => Some(Kind::Helper),
                }
            },
            0b110100..=0b110111 => {
                // B<c>; UDF, SVC
                let cond = (hw >> 8 & 15) as u8;
                (cond < 14).then_some(Kind::Branch {
                    target: (offset as i64 + 4 + sign_extend(hw & 0xFF, 8) * 2) as u64,
                    cond,
                    link: false,
                })
            },
            0b111000 | 0b111001 => Some(Kind::Branch {
                target: (offset as i64 + 4 + sign_extend(hw & 0x7FF, 11) * 2) as u64,
                cond: 14,
                link: false,
            }),
            _ => Some(Kind::Helper),
        };
    }
    let hw1 = word >> 16;
    let hw2 = word & 0xFFFF;
    let rd = hw2 >> 8 & 15;
    let rt = hw2 >> 12 & 15;
    let rn = hw1 & 15;
    match hw1 >> 11 {
        0b11101 => {
            if hw1 >> 9 & 3 == 0 {
                if hw1 & 1 << 6 == 0 {
                    // LDM, STM (not of the PC), not SRS nor RFE
                    let kind = hw1 >> 7 & 3;
                    let load = hw1 & 1 << 4 != 0;
                    return ((kind == 1 || kind == 2) && !(load && hw2 & 1 << 15 != 0) && rn != 15)
                        .then_some(Kind::Helper);
                }
                // TBB, TBH branch; the exclusives, LDRD and STRD
                if hw1 & 0xFFF0 == 0xE8D0 && hw2 & 0xFFE0 == 0xF000 {
                    return None;
                }
                let load = hw1 & 1 << 4 != 0;
                return (!(load && (rt == 15 || rd == 15))).then_some(Kind::Helper);
            }
            if hw1 >> 9 & 3 == 1 {
                // data processing (shifted register): Rd the PC only for the
                // compares and tests (S)
                return (rd != 15 || hw1 & 1 << 4 != 0).then_some(Kind::Helper);
            }
            // the coprocessors (VFP, Advanced SIMD)
            Some(Kind::Helper)
        },
        0b11110 => {
            if hw2 & 0x8000 == 0 {
                // data processing (immediates)
                return (rd != 15 || hw1 & 1 << 4 != 0 && hw1 & 1 << 9 == 0)
                    .then_some(Kind::Helper);
            }
            let s = (hw1 >> 10 & 1) as i64;
            let j1 = (hw2 >> 13 & 1) as i64;
            let j2 = (hw2 >> 11 & 1) as i64;
            match hw2 >> 12 & 5 {
                0 => {
                    let cond = (hw1 >> 6 & 15) as u8;
                    if cond < 14 {
                        let imm = (hw1 & 0x3F) as i64 * 2048 + (hw2 & 0x7FF) as i64;
                        let value = (s << 20 | j2 << 19 | j1 << 18) + imm * 2;
                        let signed = value - (s << 21);
                        return Some(Kind::Branch {
                            target: (offset as i64 + 4 + signed) as u64,
                            cond,
                            link: false,
                        });
                    }
                    // MSR, MRS, the hints (NOP), barriers, CLREX; not
                    // BXJ, ERET, SMC, HVC, UDF
                    match hw1 >> 4 & 0x7F {
                        0b0111000 | 0b0111001 | 0b0111011 => Some(Kind::Helper),
                        0b0111010 => (hw2 & 0x7FF == 0).then_some(Kind::Helper),
                        0b0111110 | 0b0111111 => (rd != 15).then_some(Kind::Helper),
                        _ => None,
                    }
                },
                1 | 5 => {
                    // B.W, BL
                    let i1 = 1 - (j1 ^ s);
                    let i2 = 1 - (j2 ^ s);
                    let imm = (hw1 & 0x3FF) as i64 * 2048 + (hw2 & 0x7FF) as i64;
                    let value = (i1 << 23 | i2 << 22) + imm * 2;
                    let signed = value - (s << 24);
                    Some(Kind::Branch {
                        target: (offset as i64 + 4 + signed) as u64,
                        cond: 14,
                        link: hw2 & 0x4000 != 0,
                    })
                },
                // BLX of an immediate: A32's
                _ => None,
            }
        },
        _ => {
            if hw1 >> 9 & 7 == 0b100 {
                // loads and stores of one register: not of the PC
                let load = hw1 & 1 << 4 != 0;
                return (!(load && rt == 15)).then_some(Kind::Helper);
            }
            if hw1 >> 8 & 15 == 0b1010 {
                // data processing (register): shifts, extends (Rn 1111: no
                // addition), parallel additions, REV, CLZ, SEL
                return (rd != 15).then_some(Kind::Helper);
            }
            if hw1 >> 8 & 15 == 0b1011 {
                // multiplies; the long ones (RdLo too) and divides (1111 there)
                let long = hw1 & 1 << 7 != 0 && hw1 >> 4 & 7 != 0b001 && hw1 >> 4 & 7 != 0b011;
                return (rd != 15 && rn != 15 && !(long && rt == 15)).then_some(Kind::Helper);
            }
            // the coprocessors, Advanced SIMD's element and structure accesses
            Some(Kind::Helper)
        },
    }
}

// ---- Q6.2: the native forms' decoding (of instructions the classification
// above runs by helper calls: the PC is never their destination)

/// A32's register list without the PC (else None)
fn list_without_pc(list: u32) -> Option<u16> {
    (list & 0x8000 == 0 && list != 0).then_some(list as u16)
}

/// LDM and STM's native form: not of the base for LDM, nor with it and a
/// writeback for STM (UNKNOWN values)
fn multiple(
    load: bool,
    rn: u8,
    list: u16,
    increment: bool,
    before: bool,
    writeback: bool,
    cond: u8,
) -> Option<Kind> {
    let based = list & 1 << rn != 0;
    if load && based || !load && based && writeback || rn == 15 || list & 1 << 13 != 0 {
        return None;
    }
    Some(Kind::Multiple {
        load,
        rn,
        list,
        increment,
        before,
        writeback,
        cond,
    })
}

/// A32's native forms
fn a32_native(word: u32) -> Option<Kind> {
    let cond = (word >> 28) as u8;
    if cond == 15 {
        return None;
    }
    let rd = (word >> 12 & 15) as u8;
    let rn = (word >> 16 & 15) as u8;
    let rm = (word & 15) as u8;
    let p = word & 1 << 24 != 0;
    let u = word & 1 << 23 != 0;
    let w = word & 1 << 21 != 0;
    let l = word & 1 << 20 != 0;
    match word >> 25 & 7 {
        0b000 | 0b001 => {
            let immediate = word & 1 << 25 != 0;
            if !immediate && word & 0x90 == 0x90 {
                if word >> 4 & 15 == 9 && word >> 24 & 15 == 0 {
                    // MUL, MLA, MLS (no S)
                    let op = word >> 21 & 7;
                    if word & 1 << 20 != 0 || !(op == 0 || op == 1 || op == 3) {
                        return None;
                    }
                    let (rd, ra, rs) = (rn, rd, (word >> 8 & 15) as u8);
                    if rd == 15 || rm == 15 || rs == 15 || op != 0 && ra == 15 {
                        return None;
                    }
                    return Some(Kind::Multiply {
                        rd,
                        rn: rm,
                        rm: rs,
                        ra: if op == 0 { NONE } else { ra },
                        sub: op == 3,
                        cond,
                    });
                }
                // LDRH, STRH, LDRSB, LDRSH (not the unprivileged ones); LDRD,
                // STRD of an immediate offset
                let sh = word >> 5 & 3;
                if !l && sh >= 2 {
                    let writeback = !p || w;
                    if word & 1 << 22 == 0
                        || rd & 1 != 0
                        || rd == 14
                        || !p && w
                        || rn == 15
                        || writeback && (rn == rd || rn == rd + 1)
                    {
                        return None;
                    }
                    return Some(Kind::Dual {
                        load: sh == 2,
                        rt: rd,
                        rt2: rd + 1,
                        rn,
                        imm: word >> 4 & 0xF0 | word & 15,
                        add: u,
                        index: p,
                        writeback,
                        cond,
                    });
                }
                let (size, signed) = match (l, sh) {
                    (false, 1) | (true, 1) => (1, false),
                    (true, 2) => (0, true),
                    (true, 3) => (1, true),
                    _ => return None,
                };
                if !p && w || rd == 15 || l && (!p || w) && rn == rd || (!p || w) && rn == 15 {
                    return None;
                }
                let offset = if word & 1 << 22 != 0 {
                    Offset::Imm(word >> 4 & 0xF0 | word & 15)
                }
                else {
                    if rm == 15 {
                        return None;
                    }
                    Offset::Reg { rm, shift: 0 }
                };
                return Some(Kind::Mem {
                    load: l,
                    size,
                    signed,
                    rt: rd,
                    rn,
                    offset,
                    add: u,
                    index: p,
                    writeback: !p || w,
                    cond,
                });
            }
            let op = (word >> 21 & 15) as u8;
            let s = word & 1 << 20 != 0;
            if word & 0x0FFF_0FF0 == 0x016F_0F10 && rd != 15 && rm != 15 {
                return Some(Kind::Bits {
                    op: 0,
                    rd,
                    rm,
                    cond,
                });
            }
            if op >> 2 == 2 && !s {
                // MOVW, MOVT; the miscellaneous instructions
                if immediate && op & 1 == 0 && rd != 15 {
                    return Some(Kind::Wide {
                        rd,
                        imm: (word >> 4 & 0xF000 | word & 0xFFF) as u16,
                        top: op == 10,
                        cond,
                    });
                }
                return None;
            }
            let op2 = if immediate {
                let rotation = (word >> 8 & 15) * 2;
                let value = (word & 0xFF).rotate_right(rotation);
                Operand::Imm {
                    value,
                    carry: (rotation != 0).then_some(value >> 31 != 0),
                }
            }
            else if word & 1 << 4 == 0 {
                let (kind, amount) = imm_shift(word >> 5 & 3, word >> 7 & 31);
                Operand::Reg { rm, kind, amount }
            }
            else {
                // shifted by a register (none of them the PC)
                let rs = (word >> 8 & 15) as u8;
                if rs == 15 || rm == 15 || rn == 15 {
                    return None;
                }
                Operand::RegShift {
                    rm,
                    kind: (word >> 5 & 3) as u8,
                    rs,
                }
            };
            let rn = if op == MOV || op == MVN { NONE } else { rn };
            Some(Kind::Data {
                op,
                s,
                rd,
                rn,
                op2,
                cond,
            })
        },
        0b010 | 0b011 => {
            if word & 1 << 25 != 0 && word & 1 << 4 != 0 {
                // REV, REV16, REVSH
                let bits = match word & 0x0FFF_0FF0 {
                    0x06BF_0F30 => Some(1),
                    0x06BF_0FB0 => Some(2),
                    0x06FF_0FB0 => Some(3),
                    _ => None,
                };
                if let Some(op) = bits {
                    return (rd != 15 && rm != 15).then_some(Kind::Bits { op, rd, rm, cond });
                }
                // SXTB, SXTH, UXTB, UXTH (not their adding forms)
                if word >> 23 & 3 == 0b01 && word >> 4 & 15 == 7 && rn == 15 && rd != 15 && rm != 15
                {
                    let op = word >> 20 & 7;
                    let (signed, half) = match op {
                        0b010 => (true, false),
                        0b011 => (true, true),
                        0b110 => (false, false),
                        0b111 => (false, true),
                        _ => return None,
                    };
                    return Some(Kind::Extend {
                        rd,
                        rm,
                        signed,
                        half,
                        rotation: (word >> 10 & 3) as u8 * 8,
                        cond,
                    });
                }
                return None;
            }
            // LDR, STR, LDRB, STRB (not the unprivileged forms); register
            // offsets shifted left only
            if !p && w || rd == 15 || l && (!p || w) && rn == rd || (!p || w) && rn == 15 {
                return None;
            }
            let offset = if word & 1 << 25 == 0 {
                Offset::Imm(word & 0xFFF)
            }
            else {
                if word >> 5 & 3 != 0 || rm == 15 {
                    return None;
                }
                Offset::Reg {
                    rm,
                    shift: (word >> 7 & 31) as u8,
                }
            };
            let size = if word & 1 << 22 != 0 { 0 } else { 2 };
            Some(Kind::Mem {
                load: l,
                size,
                signed: false,
                rt: rd,
                rn,
                offset,
                add: u,
                index: p,
                writeback: !p || w,
                cond,
            })
        },
        0b100 => {
            if word & 1 << 22 != 0 {
                return None;
            }
            multiple(l, rn, list_without_pc(word & 0xFFFF)?, u, p, w, cond)
        },
        _ => None,
    }
}

/// T32's modified immediate (ThumbExpandImm_C): the value and its carry
fn thumb_expand(imm12: u32) -> Option<(u32, Option<bool>)> {
    let imm8 = imm12 & 0xFF;
    if imm12 >> 10 == 0 {
        if imm12 >> 8 & 3 != 0 && imm8 == 0 {
            return None;
        }
        let value = match imm12 >> 8 & 3 {
            0 => imm8,
            1 => imm8 << 16 | imm8,
            2 => imm8 << 24 | imm8 << 8,
            _ => imm8 * 0x0101_0101,
        };
        return Some((value, None));
    }
    let value = (0x80 | imm12 & 0x7F).rotate_right(imm12 >> 7 & 31);
    Some((value, Some(value >> 31 != 0)))
}

/// T32's data processing operations (bits 24:21 of their encodings) as A32's
fn t32_data(op: u32, s: bool, rd: u8, rn: u8, op2: Operand) -> Option<Kind> {
    let (op, rd, rn) = match op {
        0b0000 if rd == 15 => (TST, 0, rn),
        0b0000 => (AND, rd, rn),
        0b0001 => (BIC, rd, rn),
        0b0010 if rn == 15 => (MOV, rd, NONE),
        0b0010 => (ORR, rd, rn),
        0b0011 if rn == 15 => (MVN, rd, NONE),
        0b0011 => (ORN, rd, rn),
        0b0100 if rd == 15 => (TEQ, 0, rn),
        0b0100 => (EOR, rd, rn),
        0b1000 if rd == 15 => (CMN, 0, rn),
        0b1000 => (ADD, rd, rn),
        0b1010 => (ADC, rd, rn),
        0b1011 => (SBC, rd, rn),
        0b1101 if rd == 15 => (CMP, 0, rn),
        0b1101 => (SUB, rd, rn),
        0b1110 => (RSB, rd, rn),
        _ => return None,
    };
    // (the compares and tests only with S; the PC nowhere else; SP only as ADD's and SUB's)
    let compare = matches!(op, TST | TEQ | CMN | CMP);
    if compare && !s || rd == 15 || rn == 15 {
        return None;
    }
    if (rd == 13 || rn == 13) && !matches!(op, ADD | SUB | CMP | CMN) {
        return None;
    }
    if let Operand::Reg { rm: 13 | 15, .. } = op2 {
        return None;
    }
    Some(Kind::Data {
        op,
        s,
        rd,
        rn,
        op2,
        cond: 14,
    })
}

/// T32's native forms (outside IT blocks: the 16-bit forms set flags)
fn t32_native(word: u32, length: u8) -> Option<Kind> {
    if length == 2 {
        let hw = word;
        let r = |at: u32| (hw >> at & 7) as u8;
        let reg = |rm: u8| Operand::Reg {
            rm,
            kind: 0,
            amount: 0,
        };
        let imm = |value: u32| Operand::Imm { value, carry: None };
        let data = |op: u8, rd: u8, rn: u8, op2: Operand| {
            Some(Kind::Data {
                op,
                s: true,
                rd,
                rn,
                op2,
                cond: 14,
            })
        };
        let mem = |load: bool, size: u8, signed: bool, rt: u8, rn: u8, offset: Offset| {
            Some(Kind::Mem {
                load,
                size,
                signed,
                rt,
                rn,
                offset,
                add: true,
                index: true,
                writeback: false,
                cond: 14,
            })
        };
        return match hw >> 11 {
            // LSL, LSR, ASR of a constant (LSL #0: MOVS)
            0b00000..=0b00010 => {
                let (kind, amount) = imm_shift(hw >> 11, hw >> 6 & 31);
                data(
                    MOV,
                    r(0),
                    NONE,
                    Operand::Reg {
                        rm: r(3),
                        kind,
                        amount,
                    },
                )
            },
            0b00011 => {
                let op = if hw & 1 << 9 != 0 { SUB } else { ADD };
                data(
                    op,
                    r(0),
                    r(3),
                    if hw & 1 << 10 != 0 { imm(hw >> 6 & 7) } else { reg(r(6)) },
                )
            },
            0b00100 => data(MOV, r(8), NONE, imm(hw & 0xFF)),
            0b00101 => data(CMP, 0, r(8), imm(hw & 0xFF)),
            0b00110 => data(ADD, r(8), r(8), imm(hw & 0xFF)),
            0b00111 => data(SUB, r(8), r(8), imm(hw & 0xFF)),
            0b01000 => {
                if hw & 1 << 10 == 0 {
                    // data processing (registers): not the shifts by a register, nor MULS
                    let (rdn, rm) = (r(0), r(3));
                    let shift = |kind: u8| {
                        data(
                            MOV,
                            rdn,
                            NONE,
                            Operand::RegShift {
                                rm: rdn,
                                kind,
                                rs: rm,
                            },
                        )
                    };
                    return match hw >> 6 & 15 {
                        0b0000 => data(AND, rdn, rdn, reg(rm)),
                        0b0001 => data(EOR, rdn, rdn, reg(rm)),
                        0b0010 => shift(0),
                        0b0011 => shift(1),
                        0b0100 => shift(2),
                        0b0111 => shift(3),
                        0b0101 => data(ADC, rdn, rdn, reg(rm)),
                        0b0110 => data(SBC, rdn, rdn, reg(rm)),
                        0b1000 => data(TST, 0, rdn, reg(rm)),
                        0b1001 => data(RSB, rdn, rm, imm(0)),
                        0b1010 => data(CMP, 0, rdn, reg(rm)),
                        0b1011 => data(CMN, 0, rdn, reg(rm)),
                        0b1100 => data(ORR, rdn, rdn, reg(rm)),
                        0b1110 => data(BIC, rdn, rdn, reg(rm)),
                        0b1111 => data(MVN, rdn, NONE, reg(rm)),
                        _ => None,
                    };
                }
                // ADD, CMP, MOV of the high registers (not of the PC)
                let rdn = (hw >> 4 & 8 | hw & 7) as u8;
                let rm = (hw >> 3 & 15) as u8;
                if rm == 15 || rdn == 15 {
                    return None;
                }
                match hw >> 8 & 3 {
                    0 => Some(Kind::Data {
                        op: ADD,
                        s: false,
                        rd: rdn,
                        rn: rdn,
                        op2: reg(rm),
                        cond: 14,
                    }),
                    1 => data(CMP, 0, rdn, reg(rm)),
                    2 => Some(Kind::Data {
                        op: MOV,
                        s: false,
                        rd: rdn,
                        rn: NONE,
                        op2: reg(rm),
                        cond: 14,
                    }),
                    _ => None,
                }
            },
            0b01001 => mem(true, 2, false, r(8), 15, Offset::Imm((hw & 0xFF) * 4)),
            0b01010 | 0b01011 => {
                let (load, size, signed) = match hw >> 9 & 7 {
                    0 => (false, 2, false),
                    1 => (false, 1, false),
                    2 => (false, 0, false),
                    3 => (true, 0, true),
                    4 => (true, 2, false),
                    5 => (true, 1, false),
                    6 => (true, 0, false),
                    _ => (true, 1, true),
                };
                mem(
                    load,
                    size,
                    signed,
                    r(0),
                    r(3),
                    Offset::Reg { rm: r(6), shift: 0 },
                )
            },
            0b01100 | 0b01101 => mem(
                hw & 1 << 11 != 0,
                2,
                false,
                r(0),
                r(3),
                Offset::Imm((hw >> 6 & 31) * 4),
            ),
            0b01110 | 0b01111 => mem(
                hw & 1 << 11 != 0,
                0,
                false,
                r(0),
                r(3),
                Offset::Imm(hw >> 6 & 31),
            ),
            0b10000 | 0b10001 => mem(
                hw & 1 << 11 != 0,
                1,
                false,
                r(0),
                r(3),
                Offset::Imm((hw >> 6 & 31) * 2),
            ),
            0b10010 | 0b10011 => mem(
                hw & 1 << 11 != 0,
                2,
                false,
                r(8),
                13,
                Offset::Imm((hw & 0xFF) * 4),
            ),
            // ADR, ADD of SP (no flags)
            0b10100 => Some(Kind::Data {
                op: ADD,
                s: false,
                rd: r(8),
                rn: 15,
                op2: imm((hw & 0xFF) * 4),
                cond: 14,
            }),
            0b10101 => Some(Kind::Data {
                op: ADD,
                s: false,
                rd: r(8),
                rn: 13,
                op2: imm((hw & 0xFF) * 4),
                cond: 14,
            }),
            0b10110 | 0b10111 => match hw >> 8 & 15 {
                0b0000 => Some(Kind::Data {
                    op: if hw & 0x80 != 0 { SUB } else { ADD },
                    s: false,
                    rd: 13,
                    rn: 13,
                    op2: imm((hw & 0x7F) * 4),
                    cond: 14,
                }),
                0b0010 => Some(Kind::Extend {
                    rd: r(0),
                    rm: r(3),
                    signed: hw & 0x80 == 0,
                    half: hw & 0x40 == 0,
                    rotation: 0,
                    cond: 14,
                }),
                // REV, REV16, REVSH
                0b1010 if hw >> 6 & 3 != 2 => Some(Kind::Bits {
                    op: [1, 2, 0, 3][(hw >> 6 & 3) as usize],
                    rd: r(0),
                    rm: r(3),
                    cond: 14,
                }),
                // PUSH (LR with M), POP (without the PC)
                0b0100 | 0b0101 => multiple(
                    false,
                    13,
                    (hw & 0xFF | (hw & 0x100) << 6) as u16,
                    false,
                    true,
                    true,
                    14,
                ),
                0b1100 => multiple(true, 13, (hw & 0xFF) as u16, true, false, true, 14),
                _ => None,
            },
            // STM, LDM (the writeback unless LDM's base is listed)
            0b11000 => multiple(false, r(8), (hw & 0xFF) as u16, true, false, true, 14),
            0b11001 => {
                let list = (hw & 0xFF) as u16;
                if list & 1 << r(8) != 0 {
                    return None;
                }
                multiple(true, r(8), list, true, false, true, 14)
            },
            _ => None,
        };
    }
    let hw1 = word >> 16;
    let hw2 = word & 0xFFFF;
    let rn = (hw1 & 15) as u8;
    let rd = (hw2 >> 8 & 15) as u8;
    let rt = (hw2 >> 12 & 15) as u8;
    let rm = (hw2 & 15) as u8;
    let s = hw1 & 1 << 4 != 0;
    t32_native32(hw1, hw2, rn, rd, rt, rm, s)
}

fn t32_native32(hw1: u32, hw2: u32, rn: u8, rd: u8, rt: u8, rm: u8, s: bool) -> Option<Kind> {
    if hw1 >> 11 == 0b11110 && hw2 & 0x8000 == 0 {
        if hw1 & 1 << 9 == 0 {
            let (value, carry) =
                thumb_expand((hw1 >> 10 & 1) << 11 | (hw2 >> 12 & 7) << 8 | hw2 & 0xFF)?;
            return t32_data(hw1 >> 5 & 15, s, rd, rn, Operand::Imm { value, carry });
        }
        // the plain binary immediates: ADDW, SUBW (ADR with the PC), MOVW, MOVT
        let imm12 = (hw1 >> 10 & 1) << 11 | (hw2 >> 12 & 7) << 8 | hw2 & 0xFF;
        if rd == 15 || rd == 13 && rn != 13 {
            return None;
        }
        return match hw1 >> 4 & 31 {
            0b00000 => Some(Kind::Data {
                op: ADD,
                s: false,
                rd,
                rn,
                op2: Operand::Imm {
                    value: imm12,
                    carry: None,
                },
                cond: 14,
            }),
            0b01010 => Some(Kind::Data {
                op: SUB,
                s: false,
                rd,
                rn,
                op2: Operand::Imm {
                    value: imm12,
                    carry: None,
                },
                cond: 14,
            }),
            0b00100 | 0b01100 => Some(Kind::Wide {
                rd,
                imm: ((hw1 & 15) << 12 | imm12) as u16,
                top: hw1 & 1 << 7 != 0,
                cond: 14,
            }),
            _ => None,
        };
    }
    if hw1 >> 9 == 0b1110101 {
        // data processing (shifted register)
        let (kind, amount) = imm_shift(hw2 >> 4 & 3, (hw2 >> 12 & 7) << 2 | hw2 >> 6 & 3);
        return t32_data(hw1 >> 5 & 15, s, rd, rn, Operand::Reg { rm, kind, amount });
    }
    if hw1 >> 9 == 0b1110100 && hw1 & 1 << 6 == 0 {
        // LDM, STM (IA, DB): one register at least (one as the interpreter
        // takes it, t32_block_transfer), neither SP nor the PC
        let mode = hw1 >> 7 & 3;
        let list = hw2 as u16;
        if !(mode == 1 || mode == 2) || list == 0 || list & 0xA000 != 0 {
            return None;
        }
        return multiple(
            hw1 & 1 << 4 != 0,
            rn,
            list,
            mode == 1,
            mode == 2,
            hw1 & 1 << 5 != 0,
            14,
        );
    }
    if hw1 >> 9 == 0b1111100 && hw1 & 1 << 8 == 0 || hw1 >> 8 == 0b11111001 && hw1 & 1 << 4 != 0 {
        // loads and stores of one register
        let load = hw1 & 1 << 4 != 0;
        let signed = hw1 & 1 << 8 != 0;
        let size = (hw1 >> 5 & 3) as u8;
        if size == 3 || rt == 15 || rt == 13 && !(size == 2 && !signed) {
            return None;
        }
        if rn == 15 {
            // a literal
            return load.then_some(Kind::Mem {
                load,
                size,
                signed,
                rt,
                rn,
                offset: Offset::Imm(hw2 & 0xFFF),
                add: hw1 & 1 << 7 != 0,
                index: true,
                writeback: false,
                cond: 14,
            });
        }
        let (offset, add, index, writeback) = if hw1 & 1 << 7 != 0 {
            (Offset::Imm(hw2 & 0xFFF), true, true, false)
        }
        else if hw2 & 1 << 11 != 0 {
            let (p, u, w) = (hw2 & 1 << 10 != 0, hw2 & 1 << 9 != 0, hw2 & 1 << 8 != 0);
            // (LDRT and the like: P U W 1 1 0)
            if p && u && !w || !p && !w {
                return None;
            }
            (Offset::Imm(hw2 & 0xFF), u, p, w || !p)
        }
        else if hw2 >> 6 & 63 == 0 {
            if rm == 13 || rm == 15 {
                return None;
            }
            (
                Offset::Reg {
                    rm,
                    shift: (hw2 >> 4 & 3) as u8,
                },
                true,
                true,
                false,
            )
        }
        else {
            return None;
        };
        if writeback && (rn == rt || rn == 15) {
            return None;
        }
        return Some(Kind::Mem {
            load,
            size,
            signed,
            rt,
            rn,
            offset,
            add,
            index,
            writeback,
            cond: 14,
        });
    }
    if hw1 >> 4 == 0b111110110000 && hw2 >> 4 & 15 <= 1 {
        // MUL, MLA, MLS
        let ra = rt;
        let sub = hw2 >> 4 & 15 == 1;
        if rd == 15
            || rd == 13
            || rn == 15
            || rn == 13
            || rm == 15
            || rm == 13
            || sub && ra == 15
            || ra == 13
        {
            return None;
        }
        return Some(Kind::Multiply {
            rd,
            rn,
            rm,
            ra: if ra == 15 { NONE } else { ra },
            sub,
            cond: 14,
        });
    }
    if hw1 >> 7 == 0b111110100 && hw2 >> 12 == 15 && hw2 & 0xF0 == 0 {
        // LSL, LSR, ASR, ROR of a register (Rm the amount)
        if rd >= 13 || rn >= 13 || rm >= 13 {
            return None;
        }
        return Some(Kind::Data {
            op: MOV,
            s,
            rd,
            rn: NONE,
            op2: Operand::RegShift {
                rm: rn,
                kind: (hw1 >> 5 & 3) as u8,
                rs: rm,
            },
            cond: 14,
        });
    }
    if (hw1 & 0xFFF0 == 0xFA90 || hw1 & 0xFFF0 == 0xFAB0) && hw2 & 0xF0C0 == 0xF080 && rn == rm {
        // REV, REV16, REVSH; CLZ (not RBIT)
        let op = if hw1 & 0xFFF0 == 0xFAB0 {
            if hw2 & 0x30 != 0 {
                return None;
            }
            0
        }
        else {
            match hw2 >> 4 & 3 {
                0 => 1,
                1 => 2,
                3 => 3,
                _ => return None,
            }
        };
        return (rd < 13 && rm < 13).then_some(Kind::Bits {
            op,
            rd,
            rm,
            cond: 14,
        });
    }
    if hw1 >> 9 == 0b1110100 && hw1 & 1 << 6 != 0 && (hw1 & 1 << 8 != 0 || hw1 & 1 << 5 != 0) {
        // LDRD, STRD of an immediate offset
        let rt2 = rd;
        let (p, u, w, load) = (
            hw1 & 1 << 8 != 0,
            hw1 & 1 << 7 != 0,
            hw1 & 1 << 5 != 0,
            hw1 & 1 << 4 != 0,
        );
        if rt >= 13 || rt2 >= 13 || rn == 15 || load && rt == rt2 || w && (rn == rt || rn == rt2) {
            return None;
        }
        return Some(Kind::Dual {
            load,
            rt,
            rt2,
            rn,
            imm: (hw2 & 0xFF) * 4,
            add: u,
            index: p,
            writeback: w,
            cond: 14,
        });
    }
    if hw1 >> 7 == 0b111110100 && rn == 15 && hw2 >> 12 == 15 && hw2 & 0x80 != 0 && hw2 & 0x40 == 0
    {
        // SXTH, UXTH, SXTB, UXTB
        let (signed, half) = match hw1 >> 4 & 7 {
            0b000 => (true, true),
            0b001 => (false, true),
            0b100 => (true, false),
            0b101 => (false, false),
            _ => return None,
        };
        if rd >= 13 || rm >= 13 {
            return None;
        }
        return Some(Kind::Extend {
            rd,
            rm,
            signed,
            half,
            rotation: (hw2 >> 4 & 3) as u8 * 8,
            cond: 14,
        });
    }
    None
}

/// A32's returns: LDM of the PC (not the user registers', not of the base
/// nor SP), LDR of the PC (not unprivileged); the target's instruction set
/// checked at run time (another one: the interpreter's)
fn a32_return(word: u32) -> Option<Kind> {
    let cond = (word >> 28) as u8;
    if cond == 15 {
        return None;
    }
    let rn = (word >> 16 & 15) as u8;
    let (p, u, w, l) = (
        word & 1 << 24 != 0,
        word & 1 << 23 != 0,
        word & 1 << 21 != 0,
        word & 1 << 20 != 0,
    );
    match word >> 25 & 7 {
        0b100 if l && word & 1 << 22 == 0 && word & 0x8000 != 0 => {
            let list = word as u16;
            if rn == 15 || list & 1 << rn != 0 || list & 0x2000 != 0 {
                return None;
            }
            Some(Kind::Multiple {
                load: true,
                rn,
                list,
                increment: u,
                before: p,
                writeback: w,
                cond,
            })
        },
        0b010 if l && word & 1 << 22 == 0 && word >> 12 & 15 == 15 => {
            if !p && w || (!p || w) && rn == 15 {
                return None;
            }
            Some(Kind::Mem {
                load: true,
                size: 2,
                signed: false,
                rt: 15,
                rn,
                offset: Offset::Imm(word & 0xFFF),
                add: u,
                index: p,
                writeback: !p || w,
                cond,
            })
        },
        _ => None,
    }
}

/// T32's returns: POP and LDM of the PC, LDR of the PC
fn t32_return(word: u32, length: u8) -> Option<Kind> {
    if length == 2 {
        // POP with the PC
        return (word >> 8 == 0xBD).then_some(Kind::Multiple {
            load: true,
            rn: 13,
            list: (word & 0xFF | 0x8000) as u16,
            increment: true,
            before: false,
            writeback: true,
            cond: 14,
        });
    }
    let hw1 = word >> 16;
    let hw2 = word & 0xFFFF;
    let rn = (hw1 & 15) as u8;
    if hw1 >> 9 == 0b1110100 && hw1 & 1 << 6 == 0 && hw1 & 1 << 4 != 0 {
        // LDM.W (IA, DB) of the PC: not of LR too, nor SP, nor of the base with a writeback
        let mode = hw1 >> 7 & 3;
        let list = hw2 as u16;
        let writeback = hw1 & 1 << 5 != 0;
        if !(mode == 1 || mode == 2)
            || list & 0x8000 == 0
            || list & 0x6000 != 0
            || rn == 15
            || list & 1 << rn != 0
        {
            return None;
        }
        return Some(Kind::Multiple {
            load: true,
            rn,
            list,
            increment: mode == 1,
            before: mode == 2,
            writeback,
            cond: 14,
        });
    }
    if hw1 & 0xFFF0 == 0xF8D0
        || hw1 & 0xFF7F == 0xF85F
        || hw1 & 0xFFF0 == 0xF850 && hw2 & 0x0800 != 0
    {
        // LDR.W of the PC: an offset of 12 bits, a literal, or 8 bits indexed
        if hw2 >> 12 != 15 {
            return None;
        }
        let (offset, add, index, writeback) = if rn == 15 {
            (hw2 & 0xFFF, hw1 & 1 << 7 != 0, true, false)
        }
        else if hw1 & 1 << 7 != 0 {
            (hw2 & 0xFFF, true, true, false)
        }
        else {
            let (p, u, w) = (hw2 & 1 << 10 != 0, hw2 & 1 << 9 != 0, hw2 & 1 << 8 != 0);
            if p && u && !w || !p && !w {
                return None;
            }
            (hw2 & 0xFF, u, p, w || !p)
        };
        if writeback && rn == 15 {
            return None;
        }
        return Some(Kind::Mem {
            load: true,
            size: 2,
            signed: false,
            rt: 15,
            rn,
            offset: Offset::Imm(offset),
            add,
            index,
            writeback,
            cond: 14,
        });
    }
    None
}

/// An instruction of an IT block as a native form of condition `cond`: the
/// 16-bit forms that set the flags outside one do not inside; None for
/// what might leave (loads and stores, branches)
fn t32_native_it(word: u32, length: u8, cond: u8) -> Option<Kind> {
    let mut kind = t32_native(word, length)?;
    match &mut kind {
        Kind::Data { op, s, cond: c, .. } => {
            if length == 2 && !matches!(*op, CMP | CMN | TST) {
                *s = false;
            }
            *c = cond;
        },
        Kind::Wide { cond: c, .. }
        | Kind::Multiply { cond: c, .. }
        | Kind::Extend { cond: c, .. }
        | Kind::Bits { cond: c, .. } => *c = cond,
        _ => return None,
    }
    Some(kind)
}

/// The instructions an IT instruction's mask covers
fn it_count(hw: u32) -> u32 { 4 - (hw & 15).trailing_zeros() }

/// Discovery (pagegen::discover's, AArch32's instructions): blocks from the
/// entries the runtime saw, their static targets and fall-throughs
pub(super) fn discover(
    bytes: &[u8],
    entries: &[u16],
    env: &CompileEnv,
) -> (Vec<Block>, BTreeMap<u16, usize>) {
    let thumb = env.isa == Isa::T32;
    let align: u16 = if thumb { 2 } else { 4 };
    let half = |o: u16| u16::from_le_bytes([bytes[o as usize], bytes[o as usize + 1]]) as u32;
    // the instruction at `o` and its length; None at a T32 instruction the
    // page splits (stepped: the interpreter fetches across)
    let fetch = |o: u16| -> Option<(u32, u8)> {
        if !thumb {
            return Some((
                u32::from_le_bytes(bytes[o as usize..o as usize + 4].try_into().unwrap()),
                4,
            ));
        }
        let first = half(o);
        if !crate::aarch64::a32::t32_wide(first) {
            return Some((first, 2));
        }
        if o as u64 + 4 > PAGE {
            return None;
        }
        Some((first << 16 | half(o + 2), 4))
    };
    // the instructions IT blocks cover (helpers or steps only), but those of
    // native IT blocks (their conditions)
    let mut covered: BTreeSet<u16> = BTreeSet::new();
    let native_it: std::cell::RefCell<BTreeMap<u16, u8>> = Default::default();
    let decode = |o: u16, covered: &mut BTreeSet<u16>| -> (Option<Inst32>, u16) {
        let Some((word, length)) = fetch(o)
        else {
            return (None, 2);
        };
        let mut kind = if thumb { t32(word, length, o) } else { a32(word, o) };
        if env.el1 && pl1_steps(word, length, thumb) {
            kind = None;
        }
        // (an instruction of an IT block whose instructions are all native)
        if let Some(&cond) = native_it.borrow().get(&o) {
            return (
                t32_native_it(word, length, cond).map(|kind| Inst32 { word, length, kind }),
                length as u16,
            );
        }
        // (Q6.2: returns, which the interpreter steps otherwise)
        if kind.is_none()
            && !covered.contains(&o)
            && unsafe { crate::aarch64::jit::pages::AARCH32_DEBUG } < 2
        {
            kind = if thumb { t32_return(word, length) } else { a32_return(word) };
        }
        // (Q6.2: the forms with native templates, of those a helper call would
        // run; Q6.3: VFP's and Advanced SIMD's loads and stores)
        if matches!(kind, Some(Kind::Helper)) && !covered.contains(&o) {
            let native =
                if thumb { t32_native(word, length) } else { a32_native(word) }.or_else(|| {
                    (length == 4)
                        .then(|| {
                            fp_memory(word, thumb)
                                .or_else(|| fp_data(word, thumb))
                                .or_else(|| transfer(word, thumb, env.el1))
                                .or_else(|| env.neon.then(|| neon_data(word, thumb)).flatten())
                        })
                        .flatten()
                });
            if let Some(native) = native {
                let debug = unsafe { crate::aarch64::jit::pages::AARCH32_DEBUG };
                let bit = match native {
                    Kind::Data { .. } => 32,
                    Kind::Wide { .. } => 64,
                    Kind::Mem { .. } => 128,
                    Kind::Multiple { .. } => 256,
                    Kind::Multiply { .. } => 512,
                    Kind::FpMemory { .. }
                    | Kind::Vld1 { .. }
                    | Kind::FpArith { .. }
                    | Kind::FpMove { .. }
                    | Kind::Neon { .. }
                    | Kind::Transfer { .. } => 2048,
                    _ => 1024,
                };
                if debug & 16 == 0 || debug & bit == 0 {
                    kind = Some(native);
                }
            }
        }
        let debug = unsafe { crate::aarch64::jit::pages::AARCH32_DEBUG };
        if debug == 2 && !matches!(kind, Some(Kind::Helper))
            || debug == 3 && matches!(kind, Some(Kind::Helper))
        {
            kind = None;
        }
        if covered.contains(&o) && !matches!(kind, Some(Kind::Helper) | None) {
            kind = None;
        }
        if thumb && length == 2 && word & 0xFF00 == 0xBF00 && word & 15 != 0 {
            // its instructions and their conditions (ITAdvance)
            let mut block = Vec::new();
            let mut at = o + 2;
            let mut it = word & 0xFF;
            for _ in 0..it_count(word) {
                if at as u64 >= PAGE {
                    break;
                }
                covered.insert(at);
                let instruction = fetch(at);
                block.push((at, instruction, (it >> 4) as u8));
                it = if it & 7 == 0 { 0 } else { it & 0xE0 | it << 1 & 0x1F };
                at += instruction.map_or(2, |(_, l)| l as u16);
            }
            // (all native, none that may leave: the block runs with its
            // conditions and no ITSTATE)
            let native = block.len() as u32 == it_count(word)
                && unsafe { crate::aarch64::jit::pages::AARCH32_DEBUG } < 2
                && block.iter().all(|&(_, instruction, cond)| {
                    instruction.is_some_and(|(w, l)| t32_native_it(w, l, cond).is_some())
                });
            if native && matches!(kind, Some(Kind::Helper)) {
                for &(at, _, cond) in &block {
                    native_it.borrow_mut().insert(at, cond);
                }
                kind = Some(Kind::It);
            }
        }
        (
            kind.map(|kind| Inst32 { word, length, kind }),
            length as u16,
        )
    };
    let mut starts: BTreeSet<u16> = entries
        .iter()
        .copied()
        .filter(|&o| o % align == 0)
        .collect();
    let mut queue: Vec<u16> = starts.iter().copied().collect();
    let mut decoded: BTreeSet<u16> = BTreeSet::new();
    let add = |o: u64, starts: &mut BTreeSet<u16>, queue: &mut Vec<u16>| {
        if o < PAGE && o % align as u64 == 0 && starts.insert(o as u16) {
            queue.push(o as u16);
        }
    };
    while let Some(start) = queue.pop() {
        let mut o = start;
        loop {
            if !decoded.insert(o) {
                break;
            }
            let (inst, length) = decode(o, &mut covered);
            let Some(inst) = inst
            else {
                // (a step continues at the PC it leaves: usually the next instruction)
                add(o as u64 + length as u64, &mut starts, &mut queue);
                break;
            };
            if let Some((targets, falls)) = control(&inst, o) {
                for t in targets {
                    add(t, &mut starts, &mut queue);
                }
                if falls {
                    add(o as u64 + length as u64, &mut starts, &mut queue);
                }
                break;
            }
            o += length;
            if o as u64 >= PAGE || starts.contains(&o) {
                break;
            }
        }
    }
    // (no block starts inside a native IT block: its instructions run with
    // their conditions and ITSTATE 0, so none may be entered nor left at.
    // Such a start is the target of something that is not code (a literal
    // pool's "branch" after a call that does not return) or a stepped PC
    // inside the block; the interpreter runs those)
    starts.retain(|o| !native_it.borrow().contains_key(o));
    let mut blocks = Vec::new();
    let mut index = BTreeMap::new();
    for &start in &starts {
        let mut insts = Vec::new();
        let mut o = start;
        let end = loop {
            let (inst, length) = decode(o, &mut covered);
            let Some(inst) = inst
            else {
                break End::StepAt(o);
            };
            insts.push((o, inst));
            if let Some((_, falls)) = control(&inst, o) {
                break if falls { End::Next(o + length) } else { End::Stop };
            }
            o += length;
            if o as u64 >= PAGE {
                break End::Next(PAGE as u16);
            }
            if starts.contains(&o) {
                break End::Next(o);
            }
        };
        index.insert(start, blocks.len());
        blocks.push(Block {
            start,
            insts: Vec::new(),
            insts32: insts,
            end,
        });
    }
    (blocks, index)
}

impl Emitter<'_> {
    /// Push X[n]'s low half, an i32 (R0-R14 in memory)
    fn r32(&mut self, n: u8) { self.load32(super::x_address(n as usize)); }
    /// LR := the address after the instruction (T32's with bit 0 set)
    fn link(&mut self, offset: u16, length: u8) {
        self.c32(super::x_address(14) as i32);
        self.linear(offset as u64 + length as u64);
        self.c64(if self.env.isa == Isa::T32 { 1 } else { 0 });
        self.b.or_i64();
        self.c64(0xFFFF_FFFF);
        self.b.and_i64();
        self.b.store_aligned_i64(0);
    }

    // ---- Q6.2's native forms: the registers and NZCV in memory

    /// Push the PC as an operand: A32's instruction + 8, T32's Align(+ 4, 4)
    fn pc_operand(&mut self, offset: u16) {
        let thumb = self.env.isa == Isa::T32;
        self.linear(if thumb { (offset as u64 + 4) & !3 } else { offset as u64 + 8 });
        self.b.wrap_i64_to_i32();
    }
    /// Push R[n] (the PC as an operand)
    fn operand(&mut self, n: u8, offset: u16) {
        if n == 15 {
            self.pc_operand(offset)
        }
        else {
            self.r32(n)
        }
    }
    /// R[n] := the i32 in local `l`
    fn set_r32(&mut self, n: u8, l: usize) {
        self.c32(super::x_address(n as usize) as i32);
        self.gi(l);
        self.b.extend_unsigned_i32_to_i64();
        self.b.store_aligned_i64(0);
    }
    /// Push NZCV (memory's)
    fn nzcv(&mut self) { self.load32(state::nzcv as u32); }
    /// Push C (0 or 1)
    fn carry_flag(&mut self) {
        self.nzcv();
        self.c32(29);
        self.b.shr_u_i32();
        self.c32(1);
        self.b.and_i32();
    }
    /// NZCV := local NZCV
    fn store_nzcv(&mut self) {
        self.c32(state::nzcv as i32);
        self.gi(NZCV);
        self.b.store_aligned_i32(0);
    }
    /// The body when `cond` holds (14: always)
    fn when(&mut self, cond: u8, body: impl FnOnce(&mut Self)) {
        if cond == 14 {
            return body(self);
        }
        self.nzcv();
        self.si(NZCV);
        self.condition(cond);
        self.b.if_void();
        body(self);
        self.b.block_end();
    }

    /// The second operand into A1; its shifter carry into C1 when
    /// `carry` and the operand has one (the answer)
    fn operand2(&mut self, op2: Operand, offset: u16, carry: bool) -> bool {
        match op2 {
            Operand::Imm { value, carry: c } => {
                self.c32(value as i32);
                self.si(A1);
                if carry && c.is_some() {
                    self.c32(c.unwrap() as i32);
                    self.si(C1);
                }
                c.is_some()
            },
            Operand::RegShift { rm, kind, rs } => {
                // the amount: Rs's bottom byte
                self.r32(rm);
                self.si(C0);
                self.r32(rs);
                self.c32(0xFF);
                self.b.and_i32();
                self.si(A0);
                // the value
                match kind {
                    0 | 1 => {
                        self.gi(C0);
                        self.gi(A0);
                        if kind == 0 {
                            self.b.shl_i32();
                        }
                        else {
                            self.b.shr_u_i32();
                        }
                        self.c32(0);
                        self.gi(A0);
                        self.c32(32);
                        self.b.ltu_i32();
                        self.b.select();
                    },
                    2 => {
                        self.gi(C0);
                        self.gi(A0);
                        self.c32(31);
                        self.gi(A0);
                        self.c32(31);
                        self.b.ltu_i32();
                        self.b.select();
                        self.b.shr_s_i32();
                    },
                    _ => {
                        self.gi(C0);
                        self.gi(A0);
                        self.b.rotr_i32();
                    },
                }
                self.si(A1);
                if !carry {
                    return false;
                }
                // the carry: the last bit out (none when the amount is 0: C as it was)
                match kind {
                    0 | 1 => {
                        // (64-bit: up to 32 positions; past them 0)
                        self.gi(C0);
                        self.b.extend_unsigned_i32_to_i64();
                        if kind == 0 {
                            self.gi(A0);
                            self.b.extend_unsigned_i32_to_i64();
                            self.b.shl_i64();
                            self.c64(32);
                            self.b.shr_u_i64();
                        }
                        else {
                            self.gi(A0);
                            self.c32(1);
                            self.b.sub_i32();
                            self.b.extend_unsigned_i32_to_i64();
                            self.c64(63);
                            self.b.and_i64();
                            self.b.shr_u_i64();
                        }
                        self.b.wrap_i64_to_i32();
                        self.c32(1);
                        self.b.and_i32();
                        self.c32(0);
                        self.gi(A0);
                        self.c32(33);
                        self.b.ltu_i32();
                        self.b.select();
                    },
                    2 => {
                        self.gi(C0);
                        self.gi(A0);
                        self.c32(1);
                        self.b.sub_i32();
                        self.c32(31);
                        self.gi(A0);
                        self.c32(32);
                        self.b.ltu_i32();
                        self.b.select();
                        self.b.shr_s_i32();
                        self.c32(1);
                        self.b.and_i32();
                    },
                    _ => {
                        self.gi(A1);
                        self.c32(31);
                        self.b.shr_u_i32();
                    },
                }
                self.carry_flag();
                self.gi(A0);
                self.b.select();
                self.si(C1);
                true
            },
            Operand::Reg { rm, kind, amount } => {
                self.operand(rm, offset);
                self.si(C0);
                let n = amount as i32;
                // the value
                match (kind, amount) {
                    (_, 0) => self.gi(C0),
                    (0, _) => {
                        self.gi(C0);
                        self.c32(n);
                        self.b.shl_i32();
                    },
                    (1, 32) => self.c32(0),
                    (1, _) => {
                        self.gi(C0);
                        self.c32(n);
                        self.b.shr_u_i32();
                    },
                    (2, _) => {
                        self.gi(C0);
                        self.c32(n.min(31));
                        self.b.shr_s_i32();
                    },
                    (3, _) => {
                        self.gi(C0);
                        self.c32(n);
                        self.b.rotr_i32();
                    },
                    _ => {
                        // RRX
                        self.carry_flag();
                        self.c32(31);
                        self.b.shl_i32();
                        self.gi(C0);
                        self.c32(1);
                        self.b.shr_u_i32();
                        self.b.or_i32();
                    },
                }
                self.si(A1);
                if amount == 0 {
                    return false;
                }
                if carry {
                    // the last bit shifted out
                    self.gi(C0);
                    match kind {
                        0 => self.c32(32 - n),
                        4 => self.c32(0),
                        _ => self.c32(n - 1),
                    }
                    self.b.shr_u_i32();
                    self.c32(1);
                    self.b.and_i32();
                    self.si(C1);
                }
                true
            },
        }
    }

    fn data(&mut self, op: u8, s: bool, rd: u8, rn: u8, op2: Operand, offset: u16) {
        let logical = matches!(op, AND | EOR | TST | TEQ | ORR | MOV | BIC | MVN | ORN);
        let shifter_carry = self.operand2(op2, offset, s && logical);
        if rn != NONE {
            self.operand(rn, offset);
            self.si(A0);
        }
        if logical {
            match op {
                AND | TST => {
                    self.gi(A0);
                    self.gi(A1);
                    self.b.and_i32();
                },
                EOR | TEQ => {
                    self.gi(A0);
                    self.gi(A1);
                    self.b.xor_i32();
                },
                ORR => {
                    self.gi(A0);
                    self.gi(A1);
                    self.b.or_i32();
                },
                MOV => self.gi(A1),
                BIC | ORN => {
                    self.gi(A0);
                    self.gi(A1);
                    self.c32(-1);
                    self.b.xor_i32();
                    if op == BIC {
                        self.b.and_i32();
                    }
                    else {
                        self.b.or_i32();
                    }
                },
                _ => {
                    self.gi(A1);
                    self.c32(-1);
                    self.b.xor_i32();
                },
            }
            self.si(A2);
            if s {
                // N, Z of the result; C the shifter's (or as it was), V as it was
                self.gi(A2);
                self.c32(0x8000_0000u32 as i32);
                self.b.and_i32();
                self.gi(A2);
                self.b.eqz_i32();
                self.c32(30);
                self.b.shl_i32();
                self.b.or_i32();
                self.nzcv();
                if shifter_carry {
                    self.c32(0x1000_0000);
                    self.b.and_i32();
                    self.b.or_i32();
                    self.gi(C1);
                    self.c32(29);
                    self.b.shl_i32();
                }
                else {
                    self.c32(0x3000_0000);
                    self.b.and_i32();
                }
                self.b.or_i32();
                self.si(NZCV);
                self.store_nzcv();
            }
        }
        else {
            // x + y + carry in: subtractions add the inverse
            let (x, y_inverted, swap) = match op {
                ADD | ADC | CMN => (A0, false, false),
                SUB | SBC | CMP => (A0, true, false),
                _ => (A1, true, true),
            };
            let (x, y) = if swap { (A1, A0) } else { (x, A1) };
            self.gi(y);
            if y_inverted {
                self.c32(-1);
                self.b.xor_i32();
            }
            self.si(C1);
            self.gi(x);
            self.si(C0);
            // (the 64-bit sum: the carry out in bit 32)
            self.gi(C0);
            self.b.extend_unsigned_i32_to_i64();
            self.gi(C1);
            self.b.extend_unsigned_i32_to_i64();
            self.b.add_i64();
            match op {
                ADC | SBC | RSC => {
                    self.carry_flag();
                    self.b.extend_unsigned_i32_to_i64();
                    self.b.add_i64();
                },
                SUB | CMP | RSB => {
                    self.c64(1);
                    self.b.add_i64();
                },
                _ => {},
            }
            self.s(super::T0);
            self.g(super::T0);
            self.b.wrap_i64_to_i32();
            self.si(A2);
            if s {
                self.gi(A2);
                self.c32(0x8000_0000u32 as i32);
                self.b.and_i32();
                self.gi(A2);
                self.b.eqz_i32();
                self.c32(30);
                self.b.shl_i32();
                self.b.or_i32();
                self.g(super::T0);
                self.c64(32);
                self.b.shr_u_i64();
                self.b.wrap_i64_to_i32();
                self.c32(29);
                self.b.shl_i32();
                self.b.or_i32();
                // V: x and y of one sign, the result of the other
                self.gi(C0);
                self.gi(A2);
                self.b.xor_i32();
                self.gi(C1);
                self.gi(A2);
                self.b.xor_i32();
                self.b.and_i32();
                self.c32(31);
                self.b.shr_u_i32();
                self.c32(28);
                self.b.shl_i32();
                self.b.or_i32();
                self.si(NZCV);
                self.store_nzcv();
            }
        }
        if !matches!(op, TST | TEQ | CMP | CMN) {
            self.set_r32(rd, A2);
        }
    }

    fn wide(&mut self, rd: u8, imm: u16, top: bool) {
        if top {
            self.r32(rd);
            self.c32(0xFFFF);
            self.b.and_i32();
            self.c32((imm as i32) << 16);
            self.b.or_i32();
        }
        else {
            self.c32(imm as i32);
        }
        self.si(A2);
        self.set_r32(rd, A2);
    }

    #[allow(clippy::too_many_arguments)]
    fn memory(
        &mut self,
        load: bool,
        size: u8,
        signed: bool,
        rt: u8,
        rn: u8,
        offset_form: Offset,
        add: bool,
        index: bool,
        writeback: bool,
        offset: u16,
    ) {
        // the base, the offset, the offset address
        self.operand(rn, offset);
        self.si(A0);
        match offset_form {
            Offset::Imm(value) => self.c32(value as i32),
            Offset::Reg { rm, shift } => {
                self.r32(rm);
                if shift != 0 {
                    self.c32(shift as i32);
                    self.b.shl_i32();
                }
            },
        }
        self.si(A1);
        self.gi(A0);
        self.gi(A1);
        if add {
            self.b.add_i32();
        }
        else {
            self.b.sub_i32();
        }
        self.si(A2);
        self.gi(if index { A2 } else { A0 });
        self.b.extend_unsigned_i32_to_i64();
        self.s(super::ADDR);
        // (a miss, a fault, an access across the page: the interpreter's)
        self.host(1 << size, !load, offset);
        if load {
            self.load_value(size as u32, signed, true);
            self.s(super::T1);
            if rt == 15 {
                // a return: to this instruction set (else the interpreter's)
                self.g(super::T1);
                self.b.wrap_i64_to_i32();
                self.si(C0);
                self.same_set(offset);
                if writeback {
                    self.set_r32(rn, A2);
                }
                return self.jump_c0();
            }
            if writeback {
                self.set_r32(rn, A2);
            }
            self.c32(super::x_address(rt as usize) as i32);
            self.g(super::T1);
            self.b.store_aligned_i64(0);
        }
        else {
            self.operand(rt, offset);
            self.b.extend_unsigned_i32_to_i64();
            self.store_value(size as u32);
            if writeback {
                self.set_r32(rn, A2);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn multiple(
        &mut self,
        load: bool,
        rn: u8,
        list: u16,
        increment: bool,
        before: bool,
        writeback: bool,
        offset: u16,
    ) {
        let n = list.count_ones() as i32;
        // the lowest address, the base's new value
        self.r32(rn);
        self.si(A0);
        self.gi(A0);
        let start = match (increment, before) {
            (true, false) => 0,
            (true, true) => 4,
            (false, false) => 4 - 4 * n,
            (false, true) => -4 * n,
        };
        if start != 0 {
            self.c32(start);
            self.b.add_i32();
        }
        self.si(A1);
        self.gi(A0);
        self.c32(if increment { 4 * n } else { -4 * n });
        self.b.add_i32();
        self.si(A2);
        // (aligned, in one page: else the interpreter's)
        self.gi(A1);
        self.c32(3);
        self.b.and_i32();
        self.gi(A1);
        self.c32(0xFFF);
        self.b.and_i32();
        self.c32(4096 - 4 * n);
        self.b.gtu_i32();
        self.b.or_i32();
        self.retry_if(offset);
        self.gi(A1);
        self.b.extend_unsigned_i32_to_i64();
        self.s(super::ADDR);
        self.host(4, !load, offset);
        self.si(super::HH);
        let pc = load && list & 0x8000 != 0;
        if pc {
            // a return: its target (the highest word) first, to this
            // instruction set (else the interpreter's, before any effect)
            self.gi(super::HH);
            self.c32(4 * (n - 1));
            self.b.add_i32();
            self.load_value(2, false, true);
            self.b.wrap_i64_to_i32();
            self.si(C0);
            self.same_set(offset);
        }
        let mut at = 0;
        for r in (0..15u8).filter(|r| list & 1 << r != 0) {
            if load {
                self.c32(super::x_address(r as usize) as i32);
                self.gi(super::HH);
                if at != 0 {
                    self.c32(at);
                    self.b.add_i32();
                }
                self.load_value(2, false, true);
                self.b.store_aligned_i64(0);
            }
            else {
                self.gi(super::HH);
                if at != 0 {
                    self.c32(at);
                    self.b.add_i32();
                }
                self.r32(r);
                self.b.extend_unsigned_i32_to_i64();
                self.store_value(2);
            }
            at += 4;
        }
        if writeback {
            self.set_r32(rn, A2);
        }
        if pc {
            self.jump_c0();
        }
    }

    /// Retry the instruction at `offset` when the target in C0 is another
    /// instruction set's (T32: bit 0 set; A32: bits 1:0 clear)
    fn same_set(&mut self, offset: u16) {
        let thumb = self.env.isa == Isa::T32;
        self.gi(C0);
        self.c32(if thumb { 1 } else { 3 });
        self.b.and_i32();
        self.c32(thumb as i32);
        self.b.ne_i32();
        self.retry_if(offset);
    }
    /// PC := C0 (bit 0 clear), dispatched
    fn jump_c0(&mut self) {
        self.gi(C0);
        self.c32(!1);
        self.b.and_i32();
        self.b.extend_unsigned_i32_to_i64();
        self.s(super::PC);
        self.b.br(self.f().dispatch);
    }

    /// The FP and Advanced SIMD access check (pagegen's fp_check), with
    /// cpu_type arm32's FPEXC.EN too: retry the instruction when disabled
    fn fp_access(&mut self, offset: u16) {
        self.fp_check(offset);
        if crate::aarch64::cpu::a32_only() {
            self.load32(state::a32_fpexc as u32);
            self.c32(1 << 30);
            self.b.and_i32();
            self.b.eqz_i32();
            self.retry_if(offset);
        }
    }

    /// Words between memory at the host address in HH and the SIMD&FP
    /// registers' bytes from `register_word` (the state's V registers as
    /// words: S[n] word n, D[n] words 2n and 2n + 1): word copies, which
    /// atomic guest memory allows at any word-aligned address
    fn fp_words(&mut self, load: bool, register_word: u32, words: u32) {
        for w in 0..words {
            let at = state::v as u32 + 4 * (register_word + w);
            if load {
                self.c32(at as i32);
                self.gi(super::HH);
                if w != 0 {
                    self.c32(4 * w as i32);
                    self.b.add_i32();
                }
                self.load_value(2, false, false);
                self.b.wrap_i64_to_i32();
                self.b.store_aligned_i32(0);
            }
            else {
                self.gi(super::HH);
                if w != 0 {
                    self.c32(4 * w as i32);
                    self.b.add_i32();
                }
                self.load32(at);
                self.b.extend_unsigned_i32_to_i64();
                self.store_value(2);
            }
        }
    }

    /// The host address of `bytes` from the address in local A1 into HH:
    /// word aligned (and to `align` bytes) and in one page, else the
    /// interpreter's
    fn fp_host(&mut self, load: bool, bytes: u32, align: u32, offset: u16) {
        self.gi(A1);
        self.c32(align.max(4) as i32 - 1);
        self.b.and_i32();
        self.gi(A1);
        self.c32(0xFFF);
        self.b.and_i32();
        self.c32((4096 - bytes) as i32);
        self.b.gtu_i32();
        self.b.or_i32();
        self.retry_if(offset);
        self.gi(A1);
        self.b.extend_unsigned_i32_to_i64();
        self.s(super::ADDR);
        self.host(4, !load, offset);
        self.si(super::HH);
    }

    /// A helper call: the interpreter's execute of the instruction
    /// (pages::a32_page_helper), a refusal retried in the interpreter
    fn a32_helper(&mut self, word: u32, length: u8, offset: u16) {
        self.c32(word as i32);
        self.linear(offset as u64);
        self.c32(length as i32);
        self.b.call_signature(
            "a32_page_helper",
            Signature::new(
                &[WasmType::I32, WasmType::I64, WasmType::I32],
                &[WasmType::I32],
            ),
        );
        self.retry_if(offset);
    }

    /// The state's address of S[r] (word r of the V registers) or D[r]
    fn fp_address(r: u8, double: bool) -> u32 {
        state::v as u32 + if double { 8 } else { 4 } * r as u32
    }
    /// S[r] (zero-extended) or D[r] into 64-bit local `l`
    fn a32_fp_load(&mut self, r: u8, double: bool, l: usize) {
        self.c32(Self::fp_address(r, double) as i32);
        self.b.memory_op(
            if double {
                crate::wasmgen::wasm_opcodes::OP_I64LOAD
            }
            else {
                crate::wasmgen::wasm_opcodes::OP_I64LOAD32U
            },
            if double { 3 } else { 2 },
            0,
        );
        self.s(l);
    }
    /// 64-bit local `l` into D[r], or its low 32 bits into S[r] (the rest of the V register as it was)
    fn a32_fp_store(&mut self, r: u8, double: bool, l: usize) {
        self.c32(Self::fp_address(r, double) as i32);
        self.g(l);
        if double {
            self.b.store_aligned_i64(0);
        }
        else {
            self.b.wrap_i64_to_i32();
            self.b.store_aligned_i32(0);
        }
    }

    /// VADD, VSUB, VMUL, VNMUL, VDIV (FpArith): pagegen's scalar rules
    #[allow(clippy::too_many_arguments)]
    fn fp_arith(
        &mut self,
        op: u8,
        double: bool,
        d: u8,
        n: u8,
        m: u8,
        word: u32,
        length: u8,
        offset: u16,
    ) {
        use super::{T0, T1, T3};
        self.fp_access(offset);
        let done = self.b.block_void();
        self.a32_fp_load(n, double, T0);
        self.a32_fp_load(m, double, T1);
        // RMode RN and FZ 0 (FPCR), IXC already set (FPSR), the operands zero or normal
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
        for l in [T0, T1] {
            self.fp_ordinary(l, double, false);
            self.b.and_i32();
        }
        if op == 3 {
            // (a divisor that is not zero)
            self.g(T1);
            self.c64(if double { 0x7FFF_FFFF_FFFF_FFFF } else { 0x7FFF_FFFF });
            self.b.and_i64();
            self.c64(0);
            self.b.ne_i64();
            self.b.and_i32();
        }
        self.b.if_void();
        self.fp_value(T0, double);
        self.fp_value(T1, double);
        // (Wasm's 0 add, 1 sub, 2 mul, 3 div)
        let wasm = [0, 1, 2, 3, 2][op as usize];
        if double {
            self.b.arithmetic_f64(wasm);
        }
        else {
            self.b.arithmetic_f32(wasm);
        }
        if op == 4 {
            if double {
                self.b.unary_f64(true);
            }
            else {
                self.o(0x8C); // f32.neg
            }
        }
        self.fp_bits(T3, double);
        self.fp_ordinary(T3, double, true);
        self.b.if_void();
        self.a32_fp_store(d, double, T3);
        self.b.br(done);
        self.b.block_end();
        self.b.block_end();
        // the exact path: the interpreter's
        self.a32_helper(word, length, offset);
        self.b.block_end();
    }

    /// VFP's moves (FpMove)
    /// Kind::Transfer
    #[allow(clippy::too_many_arguments)]
    fn transfer(
        &mut self,
        op: u8,
        rt: u8,
        address: u32,
        size: u8,
        signed: bool,
        q: bool,
        offset: u16,
    ) {
        use crate::wasmgen::wasm_opcodes as o;
        match op {
            TRANSFER_READ => {
                self.load32(address);
                self.si(A0);
                self.set_r32(rt, A0);
            },
            TRANSFER_WRITE => {
                self.c32(address as i32);
                self.r32(rt);
                self.b.extend_unsigned_i32_to_i64();
                self.b.store_aligned_i64(0);
            },
            TRANSFER_FPSCR | TRANSFER_FPSCR_FLAGS => {
                self.fp_access(offset);
                if op == TRANSFER_FPSCR_FLAGS {
                    self.c32(state::nzcv as i32);
                    self.load32(state::fpsr as u32);
                    self.c32(0xF000_0000u32 as i32);
                    self.b.and_i32();
                    self.b.store_aligned_i32(0);
                    return;
                }
                self.load32(state::fpsr as u32);
                self.c32(0xF800_009Fu32 as i32);
                self.b.and_i32();
                self.load32(state::fpcr as u32);
                self.c32(crate::aarch64::fp::FPCR_WRITABLE as i32);
                self.b.and_i32();
                self.b.or_i32();
                self.si(A0);
                self.set_r32(rt, A0);
            },
            TRANSFER_FROM_SCALAR => {
                self.fp_access(offset);
                self.c32(address as i32);
                let opcode = match (size, signed) {
                    (1, true) => o::OP_I32LOAD8S,
                    (1, false) => o::OP_I32LOAD8U,
                    (2, true) => o::OP_I32LOAD16S,
                    (2, false) => o::OP_I32LOAD16U,
                    _ => o::OP_I32LOAD,
                };
                self.b.memory_op(opcode, size.trailing_zeros() as u8, 0);
                self.si(A0);
                self.set_r32(rt, A0);
            },
            TRANSFER_TO_SCALAR => {
                self.fp_access(offset);
                self.c32(address as i32);
                self.r32(rt);
                let opcode = match size {
                    1 => o::OP_I32STORE8,
                    2 => o::OP_I32STORE16,
                    _ => o::OP_I32STORE,
                };
                self.b.memory_op(opcode, size.trailing_zeros() as u8, 0);
            },
            _ => {
                // VDUP (core): Rt's low `size` bytes in every element of D or Q
                self.fp_access(offset);
                self.c32(address as i32);
                self.r32(rt);
                self.b.simd(match size {
                    1 => 0x0F,
                    2 => 0x10,
                    _ => 0x11,
                });
                if q {
                    self.b.simd_memory(0x0B, 4);
                }
                else {
                    self.b.simd_lane(0x1D, 0);
                    self.b.store_aligned_i64(0);
                }
            },
        }
    }

    /// D[r] (`q` false: in both halves) or Q[r/2] onto the stack, a v128
    fn neon_load(&mut self, r: u8, q: bool) {
        self.c32(state::v as i32 + 8 * r as i32);
        if q {
            self.b.simd_memory(0x00, 4);
        }
        else {
            self.b
                .memory_op(crate::wasmgen::wasm_opcodes::OP_I64LOAD, 3, 0);
            self.b.simd(0x12);
        }
    }

    /// Advanced SIMD data processing (Neon): the result into D[d] (the
    /// v128's low half) or Q[d/2]
    fn neon(&mut self, form: NeonForm, q: bool, d: u8, n: u8, m: u8, offset: u16) {
        self.fp_access(offset);
        self.c32(state::v as i32 + 8 * d as i32);
        let register = |x: u8| [d, n, m][x as usize];
        match form {
            NeonForm::Binary { op, invert_m, test } => {
                self.neon_load(n, q);
                self.neon_load(m, q);
                if invert_m {
                    self.b.simd(0x4D);
                }
                if test {
                    self.b.simd(0x4E);
                    self.b.simd_zero();
                }
                self.b.simd(op);
            },
            NeonForm::Select {
                first,
                second,
                mask,
            } => {
                self.neon_load(register(first), q);
                self.neon_load(register(second), q);
                self.neon_load(register(mask), q);
                self.b.simd(0x52);
            },
            NeonForm::Shift { op, amount, zero } => {
                if zero {
                    self.b.simd_zero();
                }
                else {
                    self.neon_load(m, q);
                    self.c32(amount as i32);
                    self.b.simd(op);
                }
            },
            NeonForm::Immediate { value, kind } => {
                if kind != 0 {
                    self.neon_load(d, q);
                }
                let mut bytes = [0u8; 16];
                bytes[..8].copy_from_slice(&value.to_le_bytes());
                bytes[8..].copy_from_slice(&value.to_le_bytes());
                self.b.const_v128(bytes);
                match kind {
                    1 => self.b.simd(0x50),
                    2 => self.b.simd(0x4E),
                    _ => {},
                }
            },
            NeonForm::Dup { esize, index } => {
                self.neon_load(m, false);
                let (extract, splat) = match esize {
                    8 => (0x16, 0x0F),
                    16 => (0x19, 0x10),
                    _ => (0x1B, 0x11),
                };
                self.b.simd_lane(extract, index);
                self.b.simd(splat);
            },
            NeonForm::Shuffle { lanes, of_m } => {
                self.neon_load(if of_m { m } else { n }, q);
                self.neon_load(m, q);
                self.b.simd_shuffle(lanes);
            },
            NeonForm::Unary { op } => {
                self.neon_load(m, q);
                self.b.simd(op);
            },
        }
        if q {
            self.b.simd_memory(0x0B, 4);
        }
        else {
            self.b.simd_lane(0x1D, 0);
            self.b.store_aligned_i64(0);
        }
    }

    fn fp_move(&mut self, kind: u8, double: bool, d: u8, n: u8, m: u8, offset: u16) {
        use super::T0;
        self.fp_access(offset);
        match kind {
            0..=2 => {
                self.a32_fp_load(m, double, T0);
                let sign = if double { 1u64 << 63 } else { 1 << 31 };
                if kind != 0 {
                    self.g(T0);
                    if kind == 1 {
                        self.c64(!sign);
                        self.b.and_i64();
                    }
                    else {
                        self.c64(sign);
                        self.b.xor_i64();
                    }
                    self.s(T0);
                }
                self.a32_fp_store(d, double, T0);
            },
            3 => {
                self.c32(Self::fp_address(d, false) as i32);
                self.r32(n);
                self.b.store_aligned_i32(0);
            },
            4 => {
                self.load32(Self::fp_address(m, false));
                self.si(A0);
                self.set_r32(d, A0);
            },
            5 => {
                let at = Self::fp_address(d, true);
                self.c32(at as i32);
                self.r32(n);
                self.b.store_aligned_i32(0);
                self.c32(at as i32 + 4);
                self.r32(m);
                self.b.store_aligned_i32(0);
            },
            _ => {
                let at = Self::fp_address(d, true);
                self.load32(at);
                self.si(A0);
                self.set_r32(n, A0);
                self.load32(at + 4);
                self.si(A0);
                self.set_r32(m, A0);
            },
        }
    }

    /// VLDR, VSTR, VLDM, VSTM, VPUSH, VPOP (FpMemory)
    #[allow(clippy::too_many_arguments)]
    fn fp_memory(
        &mut self,
        load: bool,
        double: bool,
        first: u8,
        count: u8,
        rn: u8,
        imm: u16,
        add: bool,
        single: bool,
        writeback: bool,
        offset: u16,
    ) {
        self.fp_access(offset);
        let bytes = count as i32 * if double { 8 } else { 4 };
        // the lowest address (A1) and the base's new value (A2)
        self.operand(rn, offset);
        self.si(A0);
        self.gi(A0);
        if single {
            if imm != 0 {
                self.c32(imm as i32);
                if add {
                    self.b.add_i32();
                }
                else {
                    self.b.sub_i32();
                }
            }
        }
        else if !add {
            self.c32(bytes);
            self.b.sub_i32();
        }
        self.si(A1);
        self.gi(A0);
        self.c32(if add { bytes } else { -bytes });
        self.b.add_i32();
        self.si(A2);
        self.fp_host(load, bytes as u32, 4, offset);
        let register_word = if double { 2 * first as u32 } else { first as u32 };
        self.fp_words(load, register_word, bytes as u32 / 4);
        if writeback {
            self.set_r32(rn, A2);
        }
    }

    /// VLD1, VST1 of multiple single elements (Vld1)
    #[allow(clippy::too_many_arguments)]
    fn vld1(&mut self, load: bool, first: u8, count: u8, rn: u8, rm: u8, align: u8, offset: u16) {
        self.fp_access(offset);
        let bytes = 8 * count as u32;
        self.r32(rn);
        self.si(A1);
        self.fp_host(load, bytes, align as u32, offset);
        self.fp_words(load, 2 * first as u32, 2 * count as u32);
        if rm != 15 {
            self.gi(A1);
            if rm == 13 {
                self.c32(bytes as i32);
            }
            else {
                self.r32(rm);
            }
            self.b.add_i32();
            self.si(A2);
            self.set_r32(rn, A2);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn dual(
        &mut self,
        load: bool,
        rt: u8,
        rt2: u8,
        rn: u8,
        imm: u32,
        add: bool,
        index: bool,
        writeback: bool,
        offset: u16,
    ) {
        self.r32(rn);
        self.si(A0);
        self.gi(A0);
        self.c32(imm as i32);
        if add {
            self.b.add_i32();
        }
        else {
            self.b.sub_i32();
        }
        self.si(A2);
        self.gi(if index { A2 } else { A0 });
        self.si(A1);
        // (word aligned, both words in one page: else the interpreter's)
        self.gi(A1);
        self.c32(3);
        self.b.and_i32();
        self.gi(A1);
        self.c32(0xFFF);
        self.b.and_i32();
        self.c32(4088);
        self.b.gtu_i32();
        self.b.or_i32();
        self.retry_if(offset);
        self.gi(A1);
        self.b.extend_unsigned_i32_to_i64();
        self.s(super::ADDR);
        self.host(4, !load, offset);
        self.si(super::HH);
        for (k, r) in [rt, rt2].into_iter().enumerate() {
            if load {
                self.c32(super::x_address(r as usize) as i32);
                self.gi(super::HH);
                if k != 0 {
                    self.c32(4);
                    self.b.add_i32();
                }
                self.load_value(2, false, true);
                self.b.store_aligned_i64(0);
            }
            else {
                self.gi(super::HH);
                if k != 0 {
                    self.c32(4);
                    self.b.add_i32();
                }
                self.r32(r);
                self.b.extend_unsigned_i32_to_i64();
                self.store_value(2);
            }
        }
        if writeback {
            self.set_r32(rn, A2);
        }
    }

    /// CLZ, REV, REV16, REVSH
    fn bits(&mut self, op: u8, rd: u8, rm: u8) {
        self.r32(rm);
        self.si(C0);
        match op {
            0 => {
                self.gi(C0);
                self.b.clz_i32();
            },
            1 => {
                for (shift, mask, left) in [
                    (24, 0xFF, false),
                    (8, 0xFF00, false),
                    (8, 0xFF_0000, true),
                    (24, 0xFF00_0000u32, true),
                ] {
                    self.gi(C0);
                    self.c32(shift);
                    if left {
                        self.b.shl_i32();
                    }
                    else {
                        self.b.shr_u_i32();
                    }
                    self.c32(mask as i32);
                    self.b.and_i32();
                }
                self.b.or_i32();
                self.b.or_i32();
                self.b.or_i32();
            },
            2 => {
                self.gi(C0);
                self.c32(8);
                self.b.shr_u_i32();
                self.c32(0x00FF_00FF);
                self.b.and_i32();
                self.gi(C0);
                self.c32(8);
                self.b.shl_i32();
                self.c32(0xFF00_FF00u32 as i32);
                self.b.and_i32();
                self.b.or_i32();
            },
            _ => {
                self.gi(C0);
                self.c32(24);
                self.b.shl_i32();
                self.c32(16);
                self.b.shr_s_i32();
                self.gi(C0);
                self.c32(8);
                self.b.shr_u_i32();
                self.c32(0xFF);
                self.b.and_i32();
                self.b.or_i32();
            },
        }
        self.si(A2);
        self.set_r32(rd, A2);
    }

    fn multiply(&mut self, rd: u8, rn: u8, rm: u8, ra: u8, sub: bool) {
        if ra != NONE {
            self.r32(ra);
        }
        self.r32(rn);
        self.r32(rm);
        self.b.mul_i32();
        if ra != NONE {
            if sub {
                self.b.sub_i32();
            }
            else {
                self.b.add_i32();
            }
        }
        self.si(A2);
        self.set_r32(rd, A2);
    }

    fn extend(&mut self, rd: u8, rm: u8, signed: bool, half: bool, rotation: u8) {
        self.r32(rm);
        if rotation != 0 {
            self.c32(rotation as i32);
            self.b.rotr_i32();
        }
        let bits = if half { 16 } else { 24 };
        if signed {
            self.c32(bits);
            self.b.shl_i32();
            self.c32(bits);
            self.b.shr_s_i32();
        }
        else {
            self.c32(if half { 0xFFFF } else { 0xFF });
            self.b.and_i32();
        }
        self.si(A2);
        self.set_r32(rd, A2);
    }

    pub(super) fn instruction32(&mut self, offset: u16, i: &Inst32, index: &BTreeMap<u16, usize>) {
        match i.kind {
            Kind::Data {
                op,
                s,
                rd,
                rn,
                op2,
                cond,
            } => self.when(cond, |e| e.data(op, s, rd, rn, op2, offset)),
            Kind::Wide { rd, imm, top, cond } => self.when(cond, |e| e.wide(rd, imm, top)),
            Kind::Mem {
                load,
                size,
                signed,
                rt,
                rn,
                offset: o,
                add,
                index: ix,
                writeback,
                cond,
            } => self.when(cond, |e| {
                e.memory(load, size, signed, rt, rn, o, add, ix, writeback, offset)
            }),
            Kind::Multiple {
                load,
                rn,
                list,
                increment,
                before,
                writeback,
                cond,
            } => self.when(cond, |e| {
                e.multiple(load, rn, list, increment, before, writeback, offset)
            }),
            Kind::Multiply {
                rd,
                rn,
                rm,
                ra,
                sub,
                cond,
            } => self.when(cond, |e| e.multiply(rd, rn, rm, ra, sub)),
            Kind::Extend {
                rd,
                rm,
                signed,
                half,
                rotation,
                cond,
            } => self.when(cond, |e| e.extend(rd, rm, signed, half, rotation)),
            Kind::Dual {
                load,
                rt,
                rt2,
                rn,
                imm,
                add,
                index: ix,
                writeback,
                cond,
            } => self.when(cond, |e| {
                e.dual(load, rt, rt2, rn, imm, add, ix, writeback, offset)
            }),
            Kind::Bits { op, rd, rm, cond } => self.when(cond, |e| e.bits(op, rd, rm)),
            Kind::FpMemory {
                load,
                double,
                first,
                count,
                rn,
                imm,
                add,
                single,
                writeback,
                cond,
            } => self.when(cond, |e| {
                e.fp_memory(
                    load, double, first, count, rn, imm, add, single, writeback, offset,
                )
            }),
            Kind::Vld1 {
                load,
                first,
                count,
                rn,
                rm,
                align,
            } => self.vld1(load, first, count, rn, rm, align, offset),
            Kind::FpArith {
                op,
                double,
                d,
                n,
                m,
                cond,
            } => self.when(cond, |e| {
                e.fp_arith(op, double, d, n, m, i.word, i.length, offset)
            }),
            Kind::FpMove {
                kind,
                double,
                d,
                n,
                m,
                cond,
            } => self.when(cond, |e| e.fp_move(kind, double, d, n, m, offset)),
            Kind::It => {},
            Kind::Neon { form, q, d, n, m } => self.neon(form, q, d, n, m, offset),
            Kind::Transfer {
                op,
                rt,
                address,
                size,
                signed,
                q,
                cond,
            } => self.when(cond, |e| {
                e.transfer(op, rt, address, size, signed, q, offset)
            }),
            Kind::Helper => self.a32_helper(i.word, i.length, offset),
            Kind::Branch { target, cond, link } => {
                if cond != 14 {
                    self.load32(state::nzcv as u32);
                    self.si(NZCV);
                    self.condition(cond);
                    self.b.if_void();
                }
                if link {
                    self.link(offset, i.length);
                }
                self.goto(target, index);
                if cond != 14 {
                    self.b.block_end();
                }
            },
            Kind::CompareBranch {
                rn,
                nonzero,
                target,
            } => {
                self.r32(rn);
                if !nonzero {
                    self.b.eqz_i32();
                }
                self.b.if_void();
                self.goto(target, index);
                self.b.block_end();
            },
            Kind::Exchange { rm, link, cond } => {
                self.when(cond, |e| e.exchange(rm, link, offset, i.length))
            },
        }
    }

    /// BX, BLX of a register: the target's instruction set this one's (T32
    /// bit 0 set, A32 bits 1:0 clear; else the interpreter switches)
    fn exchange(&mut self, rm: u8, link: bool, offset: u16, length: u8) {
        self.r32(rm);
        self.b.extend_unsigned_i32_to_i64();
        self.s(super::T0);
        self.g(super::T0);
        self.c64(if self.env.isa == Isa::T32 { 1 } else { 3 });
        self.b.and_i64();
        self.c64(if self.env.isa == Isa::T32 { 1 } else { 0 });
        self.b.ne_i64();
        self.retry_if(offset);
        if link {
            self.link(offset, length);
        }
        self.g(super::T0);
        self.c64(!1);
        self.b.and_i64();
        self.s(super::PC);
        self.b.br(self.f().dispatch);
    }
}
