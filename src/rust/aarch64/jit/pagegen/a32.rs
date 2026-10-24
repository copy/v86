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
//! decides their conditions); compiled code is entered at ITSTATE 0
//! (pages::run).

use super::{Block, CompileEnv, Emitter, End, Isa, NZCV, PAGE};
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
    /// BX, BLX of a register: the same instruction set's target (else a retry)
    Exchange { rm: u8, link: bool },
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
        Kind::Exchange { link, .. } => Some((
            if link { vec![offset as u64 + i.length as u64] } else { vec![] },
            false,
        )),
        Kind::Helper => None,
    }
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
                // the media instructions (UDF among them)
                let udf = word >> 20 & 0xFF == 0x7F && word >> 4 & 15 == 15;
                return (!udf && rd != 15 && rn != 15).then_some(Kind::Helper);
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
    // the instructions IT blocks cover (helpers or steps only)
    let mut covered: BTreeSet<u16> = BTreeSet::new();
    let decode = |o: u16, covered: &mut BTreeSet<u16>| -> (Option<Inst32>, u16) {
        let Some((word, length)) = fetch(o)
        else {
            return (None, 2);
        };
        let mut kind = if thumb { t32(word, length, o) } else { a32(word, o) };
        let debug = unsafe { crate::aarch64::jit::pages::AARCH32_DEBUG };
        if debug == 2 && !matches!(kind, Some(Kind::Helper))
            || debug == 3 && matches!(kind, Some(Kind::Helper))
        {
            kind = None;
        }
        if covered.contains(&o) && !matches!(kind, Some(Kind::Helper) | None) {
            kind = None;
        }
        if thumb && length == 2 && word & 0xFF00 == 0xBF00 && word & 15 != 0 && kind.is_some() {
            let mut at = o + 2;
            for _ in 0..it_count(word) {
                if at as u64 >= PAGE {
                    break;
                }
                covered.insert(at);
                at += fetch(at).map_or(2, |(_, l)| l as u16);
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

    pub(super) fn instruction32(&mut self, offset: u16, i: &Inst32, index: &BTreeMap<u16, usize>) {
        match i.kind {
            Kind::Helper => {
                self.c32(i.word as i32);
                self.linear(offset as u64);
                self.c32(i.length as i32);
                self.b.call_signature(
                    "a32_page_helper",
                    Signature::new(
                        &[WasmType::I32, WasmType::I64, WasmType::I32],
                        &[WasmType::I32],
                    ),
                );
                self.retry_if(offset);
            },
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
            Kind::Exchange { rm, link } => {
                // (the target's instruction set this one's: T32 bit 0 set,
                // A32 bits 1:0 clear; else the interpreter switches)
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
                    self.link(offset, i.length);
                }
                self.g(super::T0);
                self.c64(!1);
                self.b.and_i64();
                self.s(super::PC);
                self.b.br(self.f().dispatch);
            },
        }
    }
}
