//! The A64 decoder (docs/arm64-virt-android16-plan.md P2.1): an instruction
//! word to an `Inst`, following the encoding index of the Arm ARM (DDI 0487
//! L.b, C4.1). Every encoding is implemented, a HINT (a NOP unless
//! implemented), or UNDEF: unallocated, or a feature profile v86-aarch64-v1
//! does not declare (tests/platform/a64-profile.json). The scalar FP,
//! AdvSIMD and crypto classes are in simd_decode (P2.5-P2.8, P2.11).
//! `mnemonic` names the base instruction (not LLVM's preferred alias) for
//! the decode oracle (tests/a64/oracle/decode.mjs).

/// What an instruction does; the fields of `Inst` hold its operands
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Op {
    Undef,
    // data processing (immediate)
    Adr,
    Adrp,
    /// ADD/ADDS/SUB/SUBS (immediate): sub = 1 for SUB, s = 1 sets flags
    AddSubImm,
    /// AND/ORR/EOR/ANDS (immediate): sub = opc, imm = the bitmask
    LogicalImm,
    /// MOVN (sub 0), MOVZ (2), MOVK (3): imm = imm16, amount = hw * 16
    MoveWide,
    /// SBFM (sub 0), BFM (1), UBFM (2): amount = immr, imm = imms
    Bitfield,
    /// EXTR: amount = lsb
    Extr,
    // branches, exceptions, system
    /// B.cond: cond, imm = offset
    BCond,
    /// B (sub 0) or BL (sub 1): imm = offset
    Branch,
    /// BR (sub 0), BLR (1), RET (2): rn
    BranchReg,
    /// CBZ (sub 0), CBNZ (1): rd = Rt, imm = offset
    CompareBranch,
    /// TBZ (sub 0), TBNZ (1): rd = Rt, amount = bit, imm = offset
    TestBranch,
    /// SVC, HVC, SMC, BRK, HLT: sub = 1..5, imm = imm16
    ExceptionGen,
    Eret,
    /// a hint: imm = CRm:op2 (0 NOP, 1 YIELD, 2 WFE, 3 WFI, 4 SEV, 5 SEVL, others NOP)
    Hint,
    Clrex,
    /// DSB (sub 0), DMB (1), ISB (2)
    Barrier,
    /// MSR (immediate) to PSTATE: sub 0 SPSel, 1 DAIFSet, 2 DAIFClr, 3 PAN; imm = CRm
    MsrImm,
    /// SYS (cache and TLB maintenance, AT): imm = op1:CRn:CRm:op2 (14 bits), rd = Rt
    Sys,
    /// MRS: imm = the system register's op0:op1:CRn:CRm:op2 (16 bits), rd = Rt
    Mrs,
    /// MSR (register): as Mrs
    Msr,
    // loads and stores
    /// LDR (literal): sub 0 W, 1 X, 2 LDRSW, 3 PRFM; imm = offset; rd = Rt
    LoadLiteral,
    /// a single register: see LdSt
    LoadStore,
    /// a pair: see LdSt
    LoadStorePair,
    /// LDXR/STXR/LDAXR/STLXR/LDXP/STXP/LDAXP/STLXP: rd = Rt, ra = Rt2, rm = Rs, size; sub bit 0 load,
    /// bit 1 pair, bit 2 acquire/release
    Exclusive,
    /// LDAR/STLR (and B, H): rd = Rt, size; sub = 1 for loads
    LoadAcquireStoreRelease,
    // data processing (register)
    /// AND/BIC/ORR/ORN/EOR/EON/ANDS/BICS (shifted register): sub = opc << 1 | N, shift, amount
    LogicalShifted,
    /// ADD/ADDS/SUB/SUBS (shifted register): sub = 1 for SUB, s, shift, amount
    AddSubShifted,
    /// ADD/ADDS/SUB/SUBS (extended register): sub, s, shift = option, amount = imm3
    AddSubExtended,
    /// ADC/ADCS/SBC/SBCS: sub = 1 for SBC, s
    AddSubCarry,
    /// CCMN (sub 0) / CCMP (1): cond, imm = nzcv; amount = 1 for the immediate form (rm = imm5)
    CondCompare,
    /// CSEL (sub 0), CSINC (1), CSINV (2), CSNEG (3): cond
    CondSelect,
    /// MADD/MSUB/SMADDL/SMSUBL/SMULH/UMADDL/UMSUBL/UMULH: sub = op31 << 1 | o0
    DataProc3,
    /// UDIV, SDIV, LSLV, LSRV, ASRV, RORV, CRC32*: sub = opcode
    DataProc2,
    /// RBIT, REV16, REV32, REV, CLZ, CLS: sub = opcode
    DataProc1,
    // scalar FP, AdvSIMD and crypto (simd_decode): imm = the instruction
    // word; a scalar AdvSIMD form shares its vector form's class (bit 28 of
    // the word tells them apart)
    FpDp1,
    FpDp2,
    FpDp3,
    FpCompare,
    FpCondCompare,
    FpCondSelect,
    FpImm,
    FpFixed,
    FpInt,
    SimdThreeSame,
    SimdThreeDiff,
    SimdTwoMisc,
    SimdAcross,
    SimdPairwise,
    SimdCopy,
    SimdModImm,
    SimdShiftImm,
    SimdIndexed,
    SimdTable,
    SimdPermute,
    SimdExtract,
    CryptoAes,
    CryptoSha3,
    CryptoSha2,
    /// LD1-LD4/ST1-ST4 and LD1R-LD4R (simd_decode::structure): imm = the word
    SimdStructure,
}

/// A decoded instruction
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Inst {
    pub op: Op,
    pub rd: u8,
    pub rn: u8,
    pub rm: u8,
    pub ra: u8,
    /// 64-bit operation (or a load/store's register width: see LdSt)
    pub sf: bool,
    /// sets the flags
    pub s: bool,
    pub sub: u8,
    pub cond: u8,
    pub shift: u8,
    pub amount: u8,
    pub imm: u64,
}

impl Inst {
    pub const UNDEF: Inst = Inst {
        op: Op::Undef,
        rd: 0,
        rn: 0,
        rm: 0,
        ra: 0,
        sf: false,
        s: false,
        sub: 0,
        cond: 0,
        shift: 0,
        amount: 0,
        imm: 0,
    };
    pub(crate) fn new(op: Op, word: u32) -> Inst {
        Inst {
            op,
            rd: (word & 31) as u8,
            rn: (word >> 5 & 31) as u8,
            rm: (word >> 16 & 31) as u8,
            ra: (word >> 10 & 31) as u8,
            sf: word >> 31 != 0,
            ..Inst::UNDEF
        }
    }
}

// Load/store details (LoadStore, LoadStorePair), packed in sub, shift and amount:
/// sub bits: 0 load, 1 SIMD&FP register, 2 sign-extend, 3 to a 32-bit register (sign-extending loads), 4 prefetch, 5 unprivileged
pub const LS_LOAD: u8 = 1;
pub const LS_SIMD: u8 = 2;
pub const LS_SIGNED: u8 = 4;
pub const LS_TO_W: u8 = 8;
pub const LS_PREFETCH: u8 = 16;
pub const LS_UNPRIVILEGED: u8 = 32;
/// cond: log2 of the access size in bytes (0..4)
/// shift: the addressing mode
pub const MODE_OFFSET: u8 = 0;
pub const MODE_PRE: u8 = 1;
pub const MODE_POST: u8 = 2;
/// register offset: amount = the shift (0 or log2 size), ra = option (extend)
pub const MODE_REGISTER: u8 = 3;
/// amount of an immediate-offset single register: the unscaled form (LDUR, STUR, PRFUM)
pub const LS_UNSCALED: u8 = 1;
/// amount of a pair: the no-allocate form (LDNP, STNP)
pub const LS_NO_ALLOCATE: u8 = 1;

#[inline(always)]
pub(crate) fn bits(word: u32, high: u32, low: u32) -> u32 {
    word >> low & ((1u32 << (high - low + 1)) - 1)
}
#[inline(always)]
fn sext(value: u64, width: u32) -> u64 { ((value << (64 - width)) as i64 >> (64 - width)) as u64 }

/// DecodeBitMasks (Arm ARM J1): the wmask of a logical immediate, or None
/// for a reserved encoding
pub fn decode_bit_masks(n: u32, imms: u32, immr: u32, sf: bool) -> Option<u64> {
    let combined = n << 6 | !imms & 0x3F;
    if combined == 0 {
        return None;
    }
    let len = 31 - combined.leading_zeros();
    if len < 1 || !sf && len > 5 {
        return None;
    }
    let levels = (1u32 << len) - 1;
    let s = imms & levels;
    let r = immr & levels;
    if s == levels {
        return None;
    }
    let esize = 1u32 << len;
    let welem: u64 = if s + 1 == 64 { u64::MAX } else { (1u64 << (s + 1)) - 1 };
    let mask = if esize == 64 { u64::MAX } else { (1u64 << esize) - 1 };
    let rotated = if r == 0 { welem } else { (welem >> r | welem << (esize - r)) & mask };
    let mut result = 0u64;
    let mut at = 0;
    while at < 64 {
        result |= rotated << at;
        at += esize;
    }
    Some(if sf { result } else { result & 0xFFFF_FFFF })
}

/// Decode one instruction word
pub fn decode(word: u32) -> Inst {
    match bits(word, 28, 25) {
        0b1000 | 0b1001 => data_processing_immediate(word),
        0b1010 | 0b1011 => branch_system(word),
        0b0100 | 0b0110 | 0b1100 | 0b1110 => load_store(word),
        0b0101 | 0b1101 => data_processing_register(word),
        0b0111 | 0b1111 => crate::aarch64::simd_decode::data_processing(word),
        // reserved, SME, SVE
        _ => Inst::UNDEF,
    }
}

fn data_processing_immediate(word: u32) -> Inst {
    let sf = word >> 31 != 0;
    match bits(word, 25, 23) {
        0b000 | 0b001 => {
            let mut i = Inst::new(if word >> 31 != 0 { Op::Adrp } else { Op::Adr }, word);
            let imm = sext((bits(word, 23, 5) << 2 | bits(word, 30, 29)) as u64, 21);
            i.imm = if i.op == Op::Adrp { imm << 12 } else { imm };
            i
        },
        0b010 => {
            let mut i = Inst::new(Op::AddSubImm, word);
            i.sub = bits(word, 30, 30) as u8;
            i.s = word >> 29 & 1 != 0;
            i.imm = (bits(word, 21, 10) as u64) << if word >> 22 & 1 != 0 { 12 } else { 0 };
            i
        },
        0b100 => {
            let n = bits(word, 22, 22);
            if !sf && n != 0 {
                return Inst::UNDEF;
            }
            match decode_bit_masks(n, bits(word, 15, 10), bits(word, 21, 16), sf) {
                Some(mask) => {
                    let mut i = Inst::new(Op::LogicalImm, word);
                    i.sub = bits(word, 30, 29) as u8;
                    i.imm = mask;
                    i
                },
                None => Inst::UNDEF,
            }
        },
        0b101 => {
            let opc = bits(word, 30, 29);
            let hw = bits(word, 22, 21);
            if opc == 1 || !sf && hw >= 2 {
                return Inst::UNDEF;
            }
            let mut i = Inst::new(Op::MoveWide, word);
            i.sub = opc as u8;
            i.imm = bits(word, 20, 5) as u64;
            i.amount = (hw * 16) as u8;
            i
        },
        0b110 => {
            let opc = bits(word, 30, 29);
            let n = bits(word, 22, 22);
            let immr = bits(word, 21, 16);
            let imms = bits(word, 15, 10);
            if opc == 3 || (n != 0) != sf || !sf && (immr >= 32 || imms >= 32) {
                return Inst::UNDEF;
            }
            let mut i = Inst::new(Op::Bitfield, word);
            i.sub = opc as u8;
            i.amount = immr as u8;
            i.imm = imms as u64;
            i
        },
        0b111 => {
            let n = bits(word, 22, 22);
            let imms = bits(word, 15, 10);
            if bits(word, 30, 29) != 0
                || bits(word, 21, 21) != 0
                || (n != 0) != sf
                || !sf && imms >= 32
            {
                return Inst::UNDEF;
            }
            let mut i = Inst::new(Op::Extr, word);
            i.amount = imms as u8;
            i
        },
        // ADD/SUB (immediate, with tags): MTE
        _ => Inst::UNDEF,
    }
}

fn branch_system(word: u32) -> Inst {
    let op0 = bits(word, 31, 29);
    if op0 == 0b010 {
        // conditional branch (BC.cond, o0 = 1, is FEAT_HBC)
        if bits(word, 25, 24) != 0 || word >> 4 & 1 != 0 {
            return Inst::UNDEF;
        }
        let mut i = Inst::new(Op::BCond, word);
        i.cond = (word & 15) as u8;
        i.imm = sext((bits(word, 23, 5) as u64) << 2, 21);
        return i;
    }
    if op0 & 3 == 0b00 {
        let mut i = Inst::new(Op::Branch, word);
        i.sub = (word >> 31) as u8;
        i.imm = sext((bits(word, 25, 0) as u64) << 2, 28);
        return i;
    }
    if op0 & 3 == 0b01 {
        if word >> 25 & 1 == 0 {
            let mut i = Inst::new(Op::CompareBranch, word);
            i.sub = (word >> 24 & 1) as u8;
            i.imm = sext((bits(word, 23, 5) as u64) << 2, 21);
            return i;
        }
        let mut i = Inst::new(Op::TestBranch, word);
        i.sub = (word >> 24 & 1) as u8;
        i.amount = (bits(word, 31, 31) << 5 | bits(word, 23, 19)) as u8;
        i.imm = sext((bits(word, 18, 5) as u64) << 2, 16);
        return i;
    }
    if op0 != 0b110 {
        return Inst::UNDEF;
    }
    // op0 = 110
    if word >> 25 & 1 == 1 {
        // unconditional branch (register)
        let opc = bits(word, 24, 21);
        if bits(word, 20, 16) != 0b11111 || bits(word, 15, 10) != 0 || word & 31 != 0 {
            return Inst::UNDEF;
        }
        return match opc {
            0b0000 | 0b0001 | 0b0010 => {
                let mut i = Inst::new(Op::BranchReg, word);
                i.sub = opc as u8;
                i
            },
            0b0100 if bits(word, 9, 5) == 31 => Inst::new(Op::Eret, word),
            // DRPS: an instruction, UNDEF outside Debug state
            0b0101 if bits(word, 9, 5) == 31 => {
                let mut i = Inst::new(Op::BranchReg, word);
                i.sub = 5;
                i
            },
            _ => Inst::UNDEF,
        };
    }
    if word >> 24 & 1 == 0 {
        // exception generation
        let opc = bits(word, 23, 21);
        let op2 = bits(word, 4, 2);
        let ll = bits(word, 1, 0);
        let sub = match (opc, op2, ll) {
            (0b000, 0, 1) => 1, // SVC
            (0b000, 0, 2) => 2, // HVC
            (0b000, 0, 3) => 3, // SMC
            (0b001, 0, 0) => 4, // BRK
            (0b010, 0, 0) => 5, // HLT
            // DCPS1-3: instructions, UNDEF outside Debug state
            (0b101, 0, 1..=3) => 5 + ll as u8,
            // TCANCEL (FEAT_TME)
            _ => return Inst::UNDEF,
        };
        let mut i = Inst::new(Op::ExceptionGen, word);
        i.sub = sub;
        i.imm = bits(word, 20, 5) as u64;
        return i;
    }
    if bits(word, 23, 22) != 0b00 {
        return Inst::UNDEF;
    }
    // system: L op0 op1 CRn CRm op2 Rt
    let l = word >> 21 & 1;
    let sys_op0 = bits(word, 20, 19);
    let op1 = bits(word, 18, 16);
    let crn = bits(word, 15, 12);
    let crm = bits(word, 11, 8);
    let op2 = bits(word, 7, 5);
    let rt = bits(word, 4, 0);
    if sys_op0 == 0 {
        if l == 1 {
            return Inst::UNDEF;
        }
        if crn == 0b0010 && op1 == 0b011 && rt == 31 {
            let mut i = Inst::new(Op::Hint, word);
            i.imm = (crm << 3 | op2) as u64;
            return i;
        }
        if crn == 0b0011 && op1 == 0b011 {
            return match (op2, rt) {
                (0b010, 31) => Inst::new(Op::Clrex, word),
                (0b100, 31) | (0b101, 31) => {
                    let mut i = Inst::new(Op::Barrier, word);
                    i.sub = (op2 - 0b100) as u8;
                    i.imm = crm as u64;
                    i
                },
                (0b110, 31) => {
                    let mut i = Inst::new(Op::Barrier, word);
                    i.sub = 2;
                    i.imm = crm as u64;
                    i
                },
                // SB (FEAT_SB), DSB nXS (FEAT_XS), TCOMMIT (FEAT_TME)
                _ => Inst::UNDEF,
            };
        }
        if crn == 0b0100 && rt == 31 {
            // MSR (immediate): SPSel, DAIFSet, DAIFClr; PAN (FEAT_PAN: profile v2,
            // UNDEFINED when it executes without it); UAO, DIT, SSBS, TCO are not
            let sub = match (op1, op2) {
                (0b000, 0b101) => 0,
                (0b011, 0b110) => 1,
                (0b011, 0b111) => 2,
                (0b000, 0b100) => 3,
                _ => return Inst::UNDEF,
            };
            let mut i = Inst::new(Op::MsrImm, word);
            i.sub = sub;
            i.imm = crm as u64;
            return i;
        }
        return Inst::UNDEF;
    }
    if sys_op0 == 1 {
        // SYS, and SYSL (sub 1: an instruction, but v1 defines no SYSL operation)
        let mut i = Inst::new(Op::Sys, word);
        i.sub = l as u8;
        i.imm = (op1 << 11 | crn << 7 | crm << 3 | op2) as u64;
        return i;
    }
    let mut i = Inst::new(if l == 1 { Op::Mrs } else { Op::Msr }, word);
    i.imm = bits(word, 20, 5) as u64;
    i
}

fn load_store(word: u32) -> Inst {
    let v = word >> 26 & 1 != 0;
    match bits(word, 29, 28) {
        0b00 => {
            if bits(word, 29, 24) == 0b001000 && !v {
                return exclusive(word);
            }
            if v && word >> 31 == 0 && bits(word, 29, 25) == 0b00110 {
                // AdvSIMD structures
                return match crate::aarch64::simd_decode::structure(word) {
                    Some(_) => {
                        let mut i = Inst::new(Op::SimdStructure, word);
                        i.imm = word as u64;
                        i
                    },
                    None => Inst::UNDEF,
                };
            }
            // LDAPR, RCPC, MTE, LSE128, ...
            Inst::UNDEF
        },
        0b01 => {
            if word >> 24 & 1 != 0 {
                // LDAPR/STLR (unscaled immediate): FEAT_LRCPC2; MTE
                return Inst::UNDEF;
            }
            let opc = bits(word, 31, 30);
            let mut i = Inst::new(Op::LoadLiteral, word);
            if v {
                // LDR (literal, SIMD&FP): sub 4 S, 5 D, 6 Q
                if opc == 3 {
                    return Inst::UNDEF;
                }
                i.sub = 4 + opc as u8;
                i.imm = sext((bits(word, 23, 5) as u64) << 2, 21);
                return i;
            }
            i.sub = opc as u8;
            i.imm = sext((bits(word, 23, 5) as u64) << 2, 21);
            i
        },
        0b10 => pair(word),
        _ => single(word),
    }
}

fn exclusive(word: u32) -> Inst {
    let size = bits(word, 31, 30);
    let o2 = word >> 23 & 1;
    let load = word >> 22 & 1;
    let o1 = word >> 21 & 1;
    let o0 = word >> 15 & 1;
    let mut i = Inst::new(Op::Exclusive, word);
    i.rm = bits(word, 20, 16) as u8;
    i.ra = bits(word, 14, 10) as u8;
    i.cond = size as u8;
    match (o2, o1) {
        (0, 0) => {
            i.sub = load as u8 | (o0 as u8) << 2;
        },
        (0, 1) => {
            if size < 2 {
                // CASP (FEAT_LSE)
                return Inst::UNDEF;
            }
            i.sub = load as u8 | 2 | (o0 as u8) << 2;
        },
        (1, 0) => {
            // LDAR/STLR; LDLAR/STLLR (o0 = 0) are FEAT_LOR
            if o0 == 0 {
                return Inst::UNDEF;
            }
            i.op = Op::LoadAcquireStoreRelease;
            i.sub = load as u8;
        },
        // CAS (FEAT_LSE)
        _ => return Inst::UNDEF,
    }
    i
}

fn pair(word: u32) -> Inst {
    let opc = bits(word, 31, 30);
    let v = word >> 26 & 1 != 0;
    let mode = bits(word, 24, 23);
    let load = word >> 22 & 1 != 0;
    let (size, signed) = if v {
        // S, D, Q
        if opc == 3 {
            return Inst::UNDEF;
        }
        (2 + opc, false)
    }
    else {
        match (opc, load) {
            (0b00, _) => (2, false),
            (0b01, true) if mode != 0 => (2, true), // LDPSW
            (0b10, _) => (3, false),
            // STGP (FEAT_MTE), LDPSW without allocation, reserved
            _ => return Inst::UNDEF,
        }
    };
    let mut i = Inst::new(Op::LoadStorePair, word);
    i.ra = bits(word, 14, 10) as u8; // Rt2
    i.cond = size as u8;
    i.sub = load as u8 | if signed { LS_SIGNED } else { 0 } | if v { LS_SIMD } else { 0 };
    i.shift = match mode {
        0b00 | 0b10 => MODE_OFFSET,
        0b01 => MODE_POST,
        _ => MODE_PRE,
    };
    if mode == 0b00 {
        i.amount = LS_NO_ALLOCATE;
    }
    i.imm = sext(bits(word, 21, 15) as u64, 7) << size;
    i
}

fn single(word: u32) -> Inst {
    let size = bits(word, 31, 30);
    let v = word >> 26 & 1 != 0;
    let opc = bits(word, 23, 22);
    let unsigned_offset = word >> 24 & 1 != 0;
    let unscaled = !unsigned_offset && word >> 21 & 1 == 0 && bits(word, 11, 10) == 0b00;
    let (mode, unprivileged) = if unsigned_offset {
        (MODE_OFFSET, false)
    }
    else if word >> 21 & 1 == 0 {
        match bits(word, 11, 10) {
            0b00 => (MODE_OFFSET, false),
            0b01 => (MODE_POST, false),
            0b10 => (MODE_OFFSET, true),
            _ => (MODE_PRE, false),
        }
    }
    else if bits(word, 11, 10) == 0b10 {
        (MODE_REGISTER, false)
    }
    else {
        // atomic memory operations (FEAT_LSE), LDRAA/LDRAB (FEAT_PAuth)
        return Inst::UNDEF;
    };
    // the access: store, load, prefetch, sign-extending loads; SIMD&FP B, H, S, D, Q
    let (sub, size_log) = if v {
        if unprivileged {
            return Inst::UNDEF;
        }
        match (size, opc) {
            (_, 0b00) => (LS_SIMD, size),
            (_, 0b01) => (LS_SIMD | LS_LOAD, size),
            (0b00, 0b10) => (LS_SIMD, 4),
            (0b00, 0b11) => (LS_SIMD | LS_LOAD, 4),
            _ => return Inst::UNDEF,
        }
    }
    else {
        match (size, opc) {
            (_, 0b00) => (0, size),
            (_, 0b01) => (LS_LOAD, size),
            (0b11, 0b10) => {
                // PRFM, PRFUM; none unprivileged or with write-back
                if unprivileged || mode == MODE_PRE || mode == MODE_POST {
                    return Inst::UNDEF;
                }
                (LS_PREFETCH, 3)
            },
            (0b11, _) | (0b10, 0b11) => return Inst::UNDEF,
            (_, 0b10) => (LS_LOAD | LS_SIGNED, size),
            (_, _) => (LS_LOAD | LS_SIGNED | LS_TO_W, size),
        }
    };
    let mut i = Inst::new(Op::LoadStore, word);
    i.cond = size_log as u8;
    i.sub = sub | if unprivileged { LS_UNPRIVILEGED } else { 0 };
    i.shift = mode;
    match mode {
        MODE_REGISTER => {
            let option = bits(word, 15, 13);
            if option & 2 == 0 {
                // (option<1> = 0 is reserved)
                return Inst::UNDEF;
            }
            i.ra = option as u8;
            i.amount = if word >> 12 & 1 != 0 { size_log as u8 } else { 0 };
        },
        _ if unsigned_offset => i.imm = (bits(word, 21, 10) as u64) << size_log,
        _ => i.imm = sext(bits(word, 20, 12) as u64, 9),
    }
    if unscaled {
        i.amount = LS_UNSCALED;
    }
    i
}

fn data_processing_register(word: u32) -> Inst {
    let sf = word >> 31 != 0;
    let op0 = word >> 30 & 1;
    let op1 = word >> 28 & 1;
    let op2 = bits(word, 24, 21);
    if op1 == 0 {
        if op2 & 0b1000 == 0 {
            // logical (shifted register)
            let imm6 = bits(word, 15, 10);
            if !sf && imm6 >= 32 {
                return Inst::UNDEF;
            }
            let mut i = Inst::new(Op::LogicalShifted, word);
            i.sub = (bits(word, 30, 29) << 1 | bits(word, 21, 21)) as u8;
            i.shift = bits(word, 23, 22) as u8;
            i.amount = imm6 as u8;
            return i;
        }
        if op2 & 1 == 0 {
            let shift = bits(word, 23, 22);
            let imm6 = bits(word, 15, 10);
            if shift == 3 || !sf && imm6 >= 32 {
                return Inst::UNDEF;
            }
            let mut i = Inst::new(Op::AddSubShifted, word);
            i.sub = op0 as u8;
            i.s = word >> 29 & 1 != 0;
            i.shift = shift as u8;
            i.amount = imm6 as u8;
            return i;
        }
        let imm3 = bits(word, 12, 10);
        if bits(word, 23, 22) != 0 || imm3 > 4 {
            return Inst::UNDEF;
        }
        let mut i = Inst::new(Op::AddSubExtended, word);
        i.sub = op0 as u8;
        i.s = word >> 29 & 1 != 0;
        i.shift = bits(word, 15, 13) as u8;
        i.amount = imm3 as u8;
        return i;
    }
    match op2 {
        0b0000 => {
            if bits(word, 15, 10) != 0 {
                // RMIF, SETF8/SETF16 (FEAT_FlagM)
                return Inst::UNDEF;
            }
            let mut i = Inst::new(Op::AddSubCarry, word);
            i.sub = op0 as u8;
            i.s = word >> 29 & 1 != 0;
            i
        },
        0b0010 => {
            if word >> 29 & 1 == 0 || word >> 10 & 1 != 0 || word >> 4 & 1 != 0 {
                return Inst::UNDEF;
            }
            let mut i = Inst::new(Op::CondCompare, word);
            i.sub = op0 as u8;
            i.cond = bits(word, 15, 12) as u8;
            i.imm = (word & 15) as u64;
            i.amount = (word >> 11 & 1) as u8;
            i
        },
        0b0100 => {
            let op2_bits = bits(word, 11, 10);
            if word >> 29 & 1 != 0 || op2_bits >= 2 {
                return Inst::UNDEF;
            }
            let mut i = Inst::new(Op::CondSelect, word);
            i.sub = (op0 << 1 | op2_bits) as u8;
            i.cond = bits(word, 15, 12) as u8;
            i
        },
        0b0110 => {
            if word >> 29 & 1 != 0 {
                return Inst::UNDEF;
            }
            let opcode = bits(word, 15, 10);
            if op0 == 0 {
                let valid = match opcode {
                    0b000010 | 0b000011 | 0b001000..=0b001011 => true,
                    // CRC32B/H/W (sf 0), CRC32X (sf 1), and the CRC32C forms
                    0b010000..=0b010010 | 0b010100..=0b010110 => !sf,
                    0b010011 | 0b010111 => sf,
                    _ => false,
                };
                if !valid {
                    return Inst::UNDEF;
                }
                let mut i = Inst::new(Op::DataProc2, word);
                i.sub = opcode as u8;
                return i;
            }
            if bits(word, 20, 16) != 0 {
                return Inst::UNDEF;
            }
            let valid = match opcode {
                0b000000 | 0b000001 | 0b000100 | 0b000101 => true,
                0b000010 => true, // REV32 (sf 1) or REV (sf 0)
                0b000011 => sf,
                _ => false,
            };
            if !valid {
                return Inst::UNDEF;
            }
            let mut i = Inst::new(Op::DataProc1, word);
            i.sub = opcode as u8;
            i
        },
        0b1000..=0b1111 => {
            if bits(word, 30, 29) != 0 {
                return Inst::UNDEF;
            }
            let op31 = bits(word, 23, 21);
            let o0 = word >> 15 & 1;
            let valid = match (op31, o0) {
                (0b000, _) => true,
                (0b001, _) | (0b101, _) => sf,
                (0b010, 0) | (0b110, 0) => sf,
                _ => false,
            };
            if !valid {
                return Inst::UNDEF;
            }
            let mut i = Inst::new(Op::DataProc3, word);
            i.sub = (op31 << 1 | o0) as u8;
            i
        },
        _ => Inst::UNDEF,
    }
}

/// The base mnemonic (the Arm ARM's instruction name, not an alias) of a
/// decoded instruction, "" for UNDEF
pub fn mnemonic(i: &Inst) -> &'static str {
    match i.op {
        Op::Undef => "",
        Op::Adr => "adr",
        Op::Adrp => "adrp",
        Op::AddSubImm | Op::AddSubShifted | Op::AddSubExtended => match (i.sub, i.s) {
            (0, false) => "add",
            (0, true) => "adds",
            (_, false) => "sub",
            (_, true) => "subs",
        },
        Op::LogicalImm => ["and", "orr", "eor", "ands"][i.sub as usize],
        Op::MoveWide => ["movn", "", "movz", "movk"][i.sub as usize],
        Op::Bitfield => ["sbfm", "bfm", "ubfm"][i.sub as usize],
        Op::Extr => "extr",
        Op::BCond => "b.cond",
        Op::Branch => ["b", "bl"][i.sub as usize],
        Op::BranchReg => ["br", "blr", "ret", "", "", "drps"][i.sub as usize],
        Op::CompareBranch => ["cbz", "cbnz"][i.sub as usize],
        Op::TestBranch => ["tbz", "tbnz"][i.sub as usize],
        Op::ExceptionGen => [
            "", "svc", "hvc", "smc", "brk", "hlt", "dcps1", "dcps2", "dcps3",
        ][i.sub as usize],
        Op::Eret => "eret",
        Op::Hint => "hint",
        Op::Clrex => "clrex",
        Op::Barrier => ["dsb", "dmb", "isb"][i.sub as usize],
        Op::MsrImm => "msr",
        Op::Sys => ["sys", "sysl"][i.sub as usize],
        Op::Mrs => "mrs",
        Op::Msr => "msr",
        Op::LoadLiteral => ["ldr", "ldr", "ldrsw", "prfm", "ldr", "ldr", "ldr"][i.sub as usize],
        Op::LoadStore => {
            let load = i.sub & LS_LOAD != 0;
            let unprivileged = i.sub & LS_UNPRIVILEGED != 0;
            let unscaled = i.amount == LS_UNSCALED && i.shift == MODE_OFFSET;
            if i.sub & LS_SIMD != 0 {
                return match (load, unscaled) {
                    (false, false) => "str",
                    (true, false) => "ldr",
                    (false, true) => "stur",
                    (true, true) => "ldur",
                };
            }
            if i.sub & LS_PREFETCH != 0 {
                return if unscaled { "prfum" } else { "prfm" };
            }
            let signed = i.sub & LS_SIGNED != 0;
            if unscaled {
                return match (load, signed, i.cond) {
                    (false, _, 0) => "sturb",
                    (false, _, 1) => "sturh",
                    (false, _, _) => "stur",
                    (true, false, 0) => "ldurb",
                    (true, false, 1) => "ldurh",
                    (true, false, _) => "ldur",
                    (true, true, 0) => "ldursb",
                    (true, true, 1) => "ldursh",
                    (true, true, _) => "ldursw",
                };
            }
            match (load, signed, i.cond, unprivileged) {
                (false, _, 0, false) => "strb",
                (false, _, 1, false) => "strh",
                (false, _, _, false) => "str",
                (false, _, 0, true) => "sttrb",
                (false, _, 1, true) => "sttrh",
                (false, _, _, true) => "sttr",
                (true, false, 0, false) => "ldrb",
                (true, false, 1, false) => "ldrh",
                (true, false, _, false) => "ldr",
                (true, true, 0, false) => "ldrsb",
                (true, true, 1, false) => "ldrsh",
                (true, true, _, false) => "ldrsw",
                (true, false, 0, true) => "ldtrb",
                (true, false, 1, true) => "ldtrh",
                (true, false, _, true) => "ldtr",
                (true, true, 0, true) => "ldtrsb",
                (true, true, 1, true) => "ldtrsh",
                (true, true, _, true) => "ldtrsw",
            }
        },
        Op::LoadStorePair => match (
            i.sub & LS_LOAD != 0,
            i.sub & LS_SIGNED != 0,
            i.amount == LS_NO_ALLOCATE,
        ) {
            (false, _, true) => "stnp",
            (true, _, true) => "ldnp",
            (false, _, false) => "stp",
            (true, false, false) => "ldp",
            (true, true, false) => "ldpsw",
        },
        Op::Exclusive => {
            let names: [[&str; 4]; 2] = [
                ["stxr", "ldxr", "stxp", "ldxp"],
                ["stlxr", "ldaxr", "stlxp", "ldaxp"],
            ];
            let base = names[(i.sub >> 2 & 1) as usize][(i.sub & 3) as usize];
            // (store or load, plain or acquire/release)
            let kind = (i.sub & 1 | i.sub >> 1 & 2) as usize;
            match (i.sub & 2 != 0, i.cond) {
                (false, 0) => ["stxrb", "ldxrb", "stlxrb", "ldaxrb"][kind],
                (false, 1) => ["stxrh", "ldxrh", "stlxrh", "ldaxrh"][kind],
                _ => base,
            }
        },
        Op::LoadAcquireStoreRelease => match (i.sub, i.cond) {
            (0, 0) => "stlrb",
            (0, 1) => "stlrh",
            (0, _) => "stlr",
            (_, 0) => "ldarb",
            (_, 1) => "ldarh",
            _ => "ldar",
        },
        Op::LogicalShifted => {
            ["and", "bic", "orr", "orn", "eor", "eon", "ands", "bics"][i.sub as usize]
        },
        Op::AddSubCarry => match (i.sub, i.s) {
            (0, false) => "adc",
            (0, true) => "adcs",
            (_, false) => "sbc",
            (_, true) => "sbcs",
        },
        Op::CondCompare => ["ccmn", "ccmp"][i.sub as usize],
        Op::CondSelect => ["csel", "csinc", "csinv", "csneg"][i.sub as usize],
        Op::DataProc3 => match i.sub {
            0 => "madd",
            1 => "msub",
            2 => "smaddl",
            3 => "smsubl",
            4 => "smulh",
            10 => "umaddl",
            11 => "umsubl",
            _ => "umulh",
        },
        Op::DataProc2 => match i.sub {
            0b000010 => "udiv",
            0b000011 => "sdiv",
            0b001000 => "lslv",
            0b001001 => "lsrv",
            0b001010 => "asrv",
            0b001011 => "rorv",
            0b010000 => "crc32b",
            0b010001 => "crc32h",
            0b010010 => "crc32w",
            0b010011 => "crc32x",
            0b010100 => "crc32cb",
            0b010101 => "crc32ch",
            0b010110 => "crc32cw",
            _ => "crc32cx",
        },
        Op::DataProc1 => match (i.sub, i.sf) {
            (0, _) => "rbit",
            (1, _) => "rev16",
            (2, true) => "rev32",
            (2, false) | (3, _) => "rev",
            (4, _) => "clz",
            _ => "cls",
        },
        Op::SimdStructure => {
            crate::aarch64::simd_decode::structure(i.imm as u32).map_or("", |s| s.name)
        },
        _ => crate::aarch64::simd_decode::classify(i.imm as u32).map_or("", |c| c.1),
    }
}

/// (tests/a64/oracle/decode.mjs --check: the base mnemonic of a word, a
/// NUL-terminated string in the Wasm memory, empty for UNDEF)
#[no_mangle]
pub fn a64_decode_mnemonic(word: u32) -> u32 {
    static mut BUFFER: [u8; 16] = [0; 16];
    let name = mnemonic(&decode(word));
    unsafe {
        let buffer = &mut *(&raw mut BUFFER);
        buffer.fill(0);
        buffer[..name.len()].copy_from_slice(name.as_bytes());
        buffer.as_ptr() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bit_masks() {
        // ORR W0, WZR, #0x55555555 (N 0, immr 0, imms 0b111100)
        assert_eq!(decode_bit_masks(0, 0b111100, 0, false), Some(0x5555_5555));
        assert_eq!(decode_bit_masks(1, 0b000000, 0, true), Some(1));
        assert_eq!(decode_bit_masks(1, 0b111111, 0, true), None);
        assert_eq!(
            decode_bit_masks(0, 0b011111, 1, false),
            None,
            "32 ones of 32: reserved"
        );
        assert_eq!(decode_bit_masks(0, 0b011110, 1, false), Some(0xBFFF_FFFF));
    }

    #[test]
    fn some_words() {
        let m = |w: u32| mnemonic(&decode(w));
        assert_eq!(m(0xD503201F), "hint"); // NOP
        assert_eq!(m(0x8B020020), "add");
        assert_eq!(m(0xEB02003F), "subs"); // CMP
        assert_eq!(m(0xAA0103E0), "orr"); // MOV X0, X1
        assert_eq!(m(0xD2800020), "movz");
        assert_eq!(m(0x9AC20C20), "sdiv");
        assert_eq!(m(0xC85FFC20), "ldaxr");
        assert_eq!(m(0xA9BF7BFD), "stp");
        assert_eq!(m(0xF9400020), "ldr");
        assert_eq!(m(0x00000000), "");
        assert_eq!(m(0xB8200020), "", "LDADD (LSE) is outside v1");
        assert_eq!(m(0xD5380000), "mrs");
        assert_eq!(m(0xD69F03E0), "eret");
        assert_eq!(m(0xD4000001), "svc");
        assert_eq!(m(0x1AC04000), "crc32b");
    }
}
