//! The A64 page tier's code generator (docs/jit-unification-plan.md P6.3,
//! J2): one Wasm function per 4 KiB page of A64 code, built in the neutral
//! skeleton crate::pagegen::frame (the frame, the structured layout of the
//! block graph, the page dispatch, the access cache's lookups, chaining).
//!
//! The function serves the page's block starts (the interpreter's block
//! boundaries the runtime saw, and the static targets and fall-throughs
//! found from them). X0-X30, SP (of the EL the function was compiled for),
//! the PC and NZCV live in locals, loaded in the prologue and written back
//! at every way out and around single steps, so memory is authoritative
//! whenever Rust code runs. Templates cover integer v1 (P6.3): the
//! arithmetic, logical, move, bitfield, shift, multiply and divide forms,
//! conditional select and compare, every branch, and the loads and stores
//! of general registers (single, pair, literal, acquire/release); NOPs and
//! barriers. Everything else is a single step (jitrt::step: the
//! interpreter, crate::aarch64::jit::pages::a64_page_step), and so is a
//! template whose precondition fails at run time (an access the cache
//! does not serve, a misaligned SP or acquire/release address, a tagged
//! branch target): the function leaves with the PC at the instruction and
//! none of its effects (EXIT_RETRY).
//!
//! NZCV is kept in its local as the interpreter keeps it (bits 31:28),
//! computed by every flag-setting template.
//!
//! In the parallel build (cores in workers, P8.2) guest memory accesses are
//! sequentially consistent atomics (the frame refuses unaligned ones, which
//! retry in the interpreter), DMB and ISB a fence, and a DSB a single step
//! while cores run in workers (it waits for their TLB maintenance, P8.3),
//! with a64_system only when this core's maintenance is pending.

use crate::aarch64::cpu;
use crate::aarch64::decode::{
    self, Inst, Op, LS_LOAD, LS_PREFETCH, LS_SIGNED, LS_SIMD, LS_TO_W, LS_UNPRIVILEGED, MODE_POST,
    MODE_PRE, MODE_REGISTER,
};
use crate::aarch64::state;
use crate::jitrt::step::{StepAbi, EXIT_RETRY, EXIT_UNKNOWN};
use crate::pagegen::frame::{
    self, AccessAbi, ChainEpoch, DispatchKind, Frame, Level, LookupLocals, PageEmitter,
};
use crate::wasmgen::wasm_builder::{
    Label, Signature, WasmBuilder, WasmLocal, WasmLocalI64, WasmType,
};
use crate::wasmgen::wasm_opcodes as op;
use std::collections::{BTreeMap, BTreeSet};

mod a32;
mod neon;

const PAGE: u64 = 4096;
/// The sign-extension operators
const OP_I64EXTEND8S: u8 = 0xC2;
const OP_I64EXTEND16S: u8 = 0xC3;
const OP_I64EXTEND32S: u8 = 0xC4;

/// What the bytes depend on besides the page
#[derive(Clone, Copy)]
pub struct CompileEnv {
    /// the code runs at EL1 (else EL0): which SP, which access cache tables
    pub el1: bool,
    /// SP alignment is checked for SP-based accesses (SCTLR_EL1.SA or SA0)
    pub sp_checked: bool,
    /// leaving the page tail-calls the next page's function (jitrt::chain)
    pub chaining: bool,
    /// AdvSIMD templates (a64_neon; P6.3b)
    pub neon: bool,
    /// helper calls (a64_helpers)
    pub helpers: bool,
    /// the EL1 system templates (a64_system: SYSTEM_*)
    pub system: u32,
    /// the host's relaxed SIMD multiply-adds fuse (a64_relaxed_fma, probed by the host)
    pub relaxed_fma: bool,
    /// the page's instruction set: A64, or AArch32's at EL0 (pagegen::a32)
    pub isa: Isa,
}

/// The instruction sets of page functions
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Isa {
    A64,
    /// AArch32's (docs/aarch32-plan.md Q6): R0-R14 and NZCV stay in memory
    A32,
    T32,
}

/// A scalar FP form with a native template (P6.3b), from its word
#[derive(Clone, Copy, PartialEq, Eq)]
enum FpForm {
    /// FMUL, FDIV, FADD, FSUB (0-3), FNMUL (8): admitted on the fast path's conditions
    Arithmetic { op: u8, negate: bool },
    /// FMADD, FMSUB, FNMADD, FNMSUB: o1 negates the addend, o0 the product
    MultiplyAdd {
        negate_addend: bool,
        negate_product: bool,
    },
    /// FMOV, FABS, FNEG (register): bit operations, never an exception
    Move(u8),
    /// FCMP, FCMPE (with zero: `zero`): NZCV, when neither operand is a NaN
    Compare { zero: bool },
}
/// The native scalar FP template of `word` (S and D only), if any
fn fp_form(i: &Inst, env: &CompileEnv) -> Option<FpForm> {
    if !env.neon {
        return None;
    }
    let word = i.imm as u32;
    let ptype = word >> 22 & 3;
    if ptype > 1 || word >> 29 & 7 != 0 {
        return None;
    }
    match i.op {
        Op::FpDp2 => match word >> 12 & 15 {
            op @ 0..=3 => Some(FpForm::Arithmetic {
                op: op as u8,
                negate: false,
            }),
            8 => Some(FpForm::Arithmetic {
                op: 0,
                negate: true,
            }),
            _ => None,
        },
        // (relaxed SIMD: a core built with simd128 only)
        Op::FpDp3 if env.relaxed_fma && cfg!(target_feature = "simd128") => {
            Some(FpForm::MultiplyAdd {
                negate_addend: word >> 21 & 1 != 0,
                negate_product: (word >> 21 & 1) != (word >> 15 & 1),
            })
        },
        Op::FpDp1 => match word >> 15 & 63 {
            op @ 0..=2 => Some(FpForm::Move(op as u8)),
            _ => None,
        },
        Op::FpCompare if word >> 14 & 3 == 0 && word & 7 == 0 => Some(FpForm::Compare {
            zero: word >> 3 & 1 != 0,
        }),
        _ => None,
    }
}

pub struct Compiled {
    pub bytes: Vec<u8>,
    /// block starts served: a bitmap of offsets
    pub served: Vec<u64>,
    pub instructions: u32,
    pub templated: u32,
}

// ---- discovery

#[derive(Clone, Copy, PartialEq, Eq)]
enum End {
    /// the next instruction, at this offset (4096: the next page)
    Next(u16),
    /// the instruction at this offset is stepped
    StepAt(u16),
    /// the last instruction transferred control itself
    Stop,
}
struct Block {
    start: u16,
    insts: Vec<(u16, Inst)>,
    /// AArch32's instructions (pagegen::a32), in place of `insts`
    insts32: Vec<(u16, a32::Inst32)>,
    end: End,
}
impl Block {
    /// the instructions it runs natively or by helpers
    fn count(&self) -> usize { self.insts.len() + self.insts32.len() }
}

/// How an instruction ends a block: not (None), or with its targets in the
/// page and whether it falls through
fn control(i: &Inst, offset: u16) -> Option<(Vec<u64>, bool)> {
    let relative = |imm: u64| (offset as u64).wrapping_add(imm);
    match i.op {
        Op::Branch => Some((
            if i.sub == 1 {
                vec![relative(i.imm), offset as u64 + 4]
            }
            else {
                vec![relative(i.imm)]
            },
            false,
        )),
        Op::BCond | Op::CompareBranch | Op::TestBranch => Some((vec![relative(i.imm)], true)),
        // (a call's return lands after it)
        Op::BranchReg => Some((
            if i.sub == 1 { vec![offset as u64 + 4] } else { vec![] },
            false,
        )),
        _ => None,
    }
}

/// Whether the instruction has a template (native or a helper; else it is stepped)
fn templated(i: &Inst, env: &CompileEnv) -> bool { native(i, env) || helper(i, env).is_some() }

/// What a helper call (crate::aarch64::jit::pages::a64_page_helper) syncs:
/// the general registers it may read or write (stored before, loaded after:
/// their state copies must be current), and whether NZCV
struct HelperSync {
    gprs: Vec<u8>,
    nzcv: bool,
}
/// Whether the instruction runs as a helper call: the interpreter's execute
/// on the state in memory, for forms that never transfer control nor change
/// what compiled code depends on (the translation regime, the access cache,
/// the EL; those step): the scalar FP, AdvSIMD and crypto forms (P6.3b: the
/// crypto helpers of P2.11, not steps), the SIMD&FP loads and stores, CRC32,
/// RBIT, the exclusives, CLREX, MRS, the unprivileged loads and stores
fn helper(i: &Inst, env: &CompileEnv) -> Option<HelperSync> {
    if !env.helpers {
        return None;
    }
    let fields = |word: u32| {
        vec![
            (word & 31) as u8,
            (word >> 5 & 31) as u8,
            (word >> 16 & 31) as u8,
        ]
    };
    let named = |i: &Inst| vec![i.rd, i.rn, i.rm, i.ra];
    let sync = |gprs: Vec<u8>, nzcv: bool| Some(HelperSync { gprs, nzcv });
    let word = i.imm as u32;
    match i.op {
        // (V registers, FPCR and FPSR only)
        Op::FpDp1
        | Op::FpDp2
        | Op::FpDp3
        | Op::FpImm
        | Op::SimdThreeSame
        | Op::SimdThreeDiff
        | Op::SimdTwoMisc
        | Op::SimdAcross
        | Op::SimdPairwise
        | Op::SimdModImm
        | Op::SimdShiftImm
        | Op::SimdIndexed
        | Op::SimdTable
        | Op::SimdPermute
        | Op::SimdExtract
        | Op::CryptoAes
        | Op::CryptoSha3
        | Op::CryptoSha2 => sync(vec![], false),
        // (general registers too: DUP, INS, UMOV, SMOV; FMOV, conversions)
        Op::SimdCopy | Op::FpInt | Op::FpFixed => sync(fields(word), false),
        Op::FpCompare | Op::FpCondCompare | Op::FpCondSelect => sync(vec![], true),
        // (the base and a post-index register)
        Op::SimdStructure => sync(fields(word), false),
        Op::LoadStore
            if !native_simd(i, env)
                && (i.sub & LS_SIMD != 0 || i.sub & LS_UNPRIVILEGED != 0 && env.el1) =>
        {
            sync(named(i), false)
        },
        Op::LoadStorePair if i.sub & LS_SIMD != 0 && !native_simd(i, env) => sync(named(i), false),
        Op::LoadLiteral if i.sub >= 4 => sync(vec![], false),
        Op::DataProc2 if i.sub >= 0b010000 => sync(named(i), false),
        Op::DataProc1 if i.sub == 0 => sync(named(i), false),
        Op::Exclusive => sync(named(i), false),
        Op::Clrex => sync(vec![], false),
        Op::Mrs => sync(vec![i.rd], true),
        _ => None,
    }
}

/// Whether the instruction has a native template
fn native(i: &Inst, env: &CompileEnv) -> bool {
    if fp_form(i, env).is_some() || neon::form(i, env).is_some() {
        return true;
    }
    match i.op {
        Op::Adr
        | Op::Adrp
        | Op::AddSubImm
        | Op::LogicalImm
        | Op::MoveWide
        | Op::Bitfield
        | Op::Extr
        | Op::BCond
        | Op::CompareBranch
        | Op::TestBranch
        | Op::LogicalShifted
        | Op::AddSubShifted
        | Op::AddSubExtended
        | Op::AddSubCarry
        | Op::CondCompare
        | Op::CondSelect => true,
        Op::Branch => true,
        // BR, BLR, RET (not the pointer authentication forms, nor ERET, DRPS)
        Op::BranchReg => i.sub <= 2,
        Op::DataProc3 => matches!(i.sub, 0..=4 | 10 | 11 | 12),
        // UDIV, SDIV, LSLV, LSRV, ASRV, RORV (CRC32: stepped)
        Op::DataProc2 => matches!(i.sub, 0b000010 | 0b000011 | 0b001000..=0b001011),
        // RBIT, REV16, REV32, REV, CLZ, CLS
        Op::DataProc1 => matches!(i.sub, 0..=5),
        // NOP and the hints that are NOPs here (YIELD, WFE, WFI, SEV, SEVL step)
        Op::Hint => !(1..=5).contains(&i.imm),
        // (DSB with cores in workers: a step, crate::aarch64::tlb::synced;
        // with a64_system only when this core's maintenance is pending)
        Op::Barrier => !(i.sub == 0 && crate::parallel::active()) || env.system & SYSTEM_DSB != 0,
        // (and the SIMD&FP registers' S, D and Q forms: native_simd)
        // (LDTR, STTR at EL1 through EL0's access cache tables with a64_system)
        Op::LoadStore => {
            i.sub & LS_SIMD == 0
                && (i.sub & LS_UNPRIVILEGED == 0
                    || !env.el1
                    || env.system & SYSTEM_UNPRIVILEGED != 0)
                || native_simd(i, env)
        },
        Op::LoadStorePair => i.sub & LS_SIMD == 0 || native_simd(i, env),
        Op::LoadLiteral => i.sub <= 3,
        Op::LoadAcquireStoreRelease => true,
        Op::Mrs | Op::Msr => {
            i.imm as u32 == TPIDR_EL0
                || i.imm as u32 == NZCV_KEY
                || system_register(i, env).is_some()
        },
        // MSR DAIFSet, DAIFClr at EL1 (a64_system)
        Op::MsrImm => env.system & SYSTEM_REGISTERS != 0 && env.el1 && (i.sub == 1 || i.sub == 2),
        // TLBI at EL1, DC ZVA at EL1 and EL0 (a64_system; at EL0 it checks
        // SCTLR_EL1.DZE as it runs: bionic's memset zeroes with it)
        Op::Sys => {
            i.sub == 0
                && (env.el1 && env.system & SYSTEM_TLBI != 0 && tlbi_form(i.imm as u32)
                    || env.system & SYSTEM_DC_ZVA != 0 && i.imm as u32 == DC_ZVA)
        },
        _ => false,
    }
}

/// a64_system's templates: the system registers and PSTATE.DAIF, TLBI, DC
/// ZVA, LDTR and STTR, DSB (with cores in workers)
pub const SYSTEM_REGISTERS: u32 = 1;
pub const SYSTEM_TLBI: u32 = 2;
pub const SYSTEM_DC_ZVA: u32 = 4;
pub const SYSTEM_UNPRIVILEGED: u32 = 8;
pub const SYSTEM_DSB: u32 = 16;
pub const SYSTEM_ALL: u32 = 31;

/// SYS's DC ZVA (op1:CRn:CRm:op2)
const DC_ZVA: u32 = 3 << 11 | 7 << 7 | 4 << 3 | 1;
/// A TLBI the interpreter does (sysregs::sys): op1 0, CRn 8, CRm 3 (inner
/// shareable) or 7, op2 VMALLE1, VAE1, ASIDE1, VAAE1, VALE1, VAALE1
fn tlbi_form(op: u32) -> bool {
    op >> 11 == 0
        && op >> 7 & 15 == 8
        && matches!(op >> 3 & 15, 3 | 7)
        && matches!(op & 7, 0..=3 | 5 | 7)
}

/// The system registers whose MRS and MSR (register) have EL1 templates
/// (a64_system): plain state, or PSTATE's bits
#[derive(Clone, Copy, PartialEq, Eq)]
enum SystemRegister {
    /// SP_EL0: Linux's `current`; at EL1t the SP itself (an MSR there is UNDEFINED: retried)
    SpEl0,
    Tpidr1,
    Daif,
    Elr,
    /// SPSR_EL1 (MSR: the bits the profile keeps)
    Spsr,
    /// ESR_EL1 (MSR: the low 32 bits)
    Esr,
    Far,
    /// DCZID_EL0: BS 4, DZP set at EL0 while SCTLR_EL1.DZE is clear
    Dczid,
    /// CNTVCT_EL0 (EL0: CNTKCTL_EL1 bit 1) or CNTPCT_EL0 (bit 0), read: the counter
    Counter(u64),
    /// CNTFRQ_EL0, read (EL0: CNTKCTL_EL1 bit 0 or 1)
    Cntfrq,
    /// TPIDRRO_EL0 (MSR at EL1 only)
    TpidrRo,
    /// CONTEXTIDR_EL1 (MSR: the low 32 bits)
    Contextidr,
    /// FPCR and FPSR (as FP instructions, CPACR_EL1.FPEN as it runs; MSR:
    /// the writable bits; compiled FP code reads them as it runs)
    Fpcr,
    Fpsr,
}
fn system_register(i: &Inst, env: &CompileEnv) -> Option<SystemRegister> {
    use crate::aarch64::sysregs::key;
    if env.system & SYSTEM_REGISTERS == 0 {
        return None;
    }
    let reg = i.imm as u32;
    let write = i.op == Op::Msr;
    // (at EL0 too, its checks made as the template runs: the counter that
    // Android's clock_gettime reads in the vDSO, TPIDRRO_EL0, FPCR and FPSR)
    let any_el = match reg {
        r if r == key(3, 3, 14, 0, 2) && !write => Some(SystemRegister::Counter(2)),
        r if r == key(3, 3, 14, 0, 1) && !write => Some(SystemRegister::Counter(1)),
        r if r == key(3, 3, 14, 0, 0) && !write => Some(SystemRegister::Cntfrq),
        r if r == key(3, 3, 0, 0, 7) && !write => Some(SystemRegister::Dczid),
        r if r == key(3, 3, 13, 0, 3) && (!write || env.el1) => Some(SystemRegister::TpidrRo),
        r if r == key(3, 3, 4, 4, 0) => Some(SystemRegister::Fpcr),
        r if r == key(3, 3, 4, 4, 1) => Some(SystemRegister::Fpsr),
        _ => None,
    };
    if any_el.is_some() || !env.el1 {
        return any_el;
    }
    Some(match reg {
        r if r == key(3, 0, 4, 1, 0) => SystemRegister::SpEl0,
        r if r == key(3, 0, 13, 0, 4) => SystemRegister::Tpidr1,
        r if r == key(3, 3, 4, 2, 1) => SystemRegister::Daif,
        r if r == key(3, 0, 4, 0, 1) => SystemRegister::Elr,
        r if r == key(3, 0, 4, 0, 0) => SystemRegister::Spsr,
        r if r == key(3, 0, 5, 2, 0) => SystemRegister::Esr,
        r if r == key(3, 0, 6, 0, 0) => SystemRegister::Far,
        r if r == key(3, 0, 13, 0, 1) => SystemRegister::Contextidr,
        _ => return None,
    })
}
/// A SIMD&FP load or store of an S, D or Q register (single or pair, not a
/// prefetch) with the native template (a64_neon)
fn native_simd(i: &Inst, env: &CompileEnv) -> bool {
    env.neon && i.sub & LS_SIMD != 0 && i.sub & LS_PREFETCH == 0 && (2..=4).contains(&i.cond)
}

/// The system register keys of the MRS/MSR templates (sysregs::key)
const TPIDR_EL0: u32 = 3 << 14 | 3 << 11 | 13 << 7 | 0 << 3 | 2;
const NZCV_KEY: u32 = 3 << 14 | 3 << 11 | 4 << 7 | 2 << 3 | 0;

fn discover(
    words: &[u32],
    entries: &[u16],
    env: &CompileEnv,
) -> (Vec<Block>, BTreeMap<u16, usize>) {
    let mut starts: BTreeSet<u16> = entries.iter().copied().filter(|&o| o % 4 == 0).collect();
    let mut queue: Vec<u16> = starts.iter().copied().collect();
    let mut decoded: BTreeSet<u16> = BTreeSet::new();
    let add = |o: u64, starts: &mut BTreeSet<u16>, queue: &mut Vec<u16>| {
        if o < PAGE && o % 4 == 0 && starts.insert(o as u16) {
            queue.push(o as u16);
        }
    };
    while let Some(start) = queue.pop() {
        let mut o = start;
        loop {
            if !decoded.insert(o) {
                break;
            }
            let i = decode::decode(words[o as usize / 4]);
            if let Some((targets, falls)) = control(&i, o).filter(|_| templated(&i, env)) {
                for t in targets {
                    add(t, &mut starts, &mut queue);
                }
                if falls {
                    add(o as u64 + 4, &mut starts, &mut queue);
                }
                break;
            }
            if !templated(&i, env) {
                // (a step continues at the PC it leaves: usually the next instruction)
                add(o as u64 + 4, &mut starts, &mut queue);
                break;
            }
            o += 4;
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
            let i = decode::decode(words[o as usize / 4]);
            if !templated(&i, env) {
                break End::StepAt(o);
            }
            insts.push((o, i));
            if let Some((_, falls)) = control(&i, o) {
                break if falls { End::Next(o + 4) } else { End::Stop };
            }
            o += 4;
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
            insts,
            insts32: Vec::new(),
            end,
        });
    }
    (blocks, index)
}

/// The static successors of each block in the page (pagegen::frame::structured)
fn successors(blocks: &[Block], index: &BTreeMap<u16, usize>) -> Vec<Vec<u32>> {
    blocks
        .iter()
        .map(|b| {
            let mut out = vec![];
            let mut to = |o: u64| {
                if o < PAGE {
                    if let Some(&k) = index.get(&(o as u16)) {
                        out.push(k as u32);
                    }
                }
            };
            if let Some(&(o, i)) = b.insts.last() {
                if let Some((targets, _)) = control(&i, o) {
                    if !matches!(i.op, Op::Branch if i.sub == 1) {
                        for t in targets {
                            to(t);
                        }
                    }
                    else {
                        to((o as u64).wrapping_add(i.imm));
                    }
                }
            }
            if let Some((o, i)) = b.insts32.last() {
                for t in a32::targets(i, *o) {
                    to(t);
                }
            }
            if let End::Next(o) = b.end {
                to(o as u64);
            }
            out
        })
        .collect()
}

// ---- the emitter

// i64 locals: X0-X30, SP (31), then
const PC: usize = 32;
const BASE: usize = 33;
const ADDR: usize = 34;
const EP: usize = 35;
const TAG: usize = 36;
const T0: usize = 37;
const T1: usize = 38;
const T2: usize = 39;
const T3: usize = 40;
const T4: usize = 41;
/// a store's value (store_any)
const SV: usize = 42;
const LOCALS64: usize = 43;
// i32 locals
const N: usize = 0;
const K: usize = 1;
const NZCV: usize = 2;
const JAC: usize = 3;
const ENT: usize = 4;
const OFF: usize = 5;
const HH: usize = 6;
const ST: usize = 7;
const C0: usize = 8;
const C1: usize = 9;
/// the access cache's EL0 tables, for LDTR and STTR at EL1
const J0: usize = 10;
/// AArch32's operands and results (pagegen::a32)
const A0: usize = 11;
const A1: usize = 12;
const A2: usize = 13;
/// a store's host address (store_any)
const SH: usize = 14;
const LOCALS32: usize = 15;

struct Emitter<'a> {
    b: WasmBuilder,
    v: Vec<WasmLocalI64>,
    w: Vec<WasmLocal>,
    budget: WasmLocal,
    frame: Option<Frame>,
    levels: Vec<Level>,
    blocks: &'a [Block],
    env: CompileEnv,
    access: Option<u32>,
    step: StepAbi,
    /// the page's instruction words (helpers take theirs)
    words: Vec<u32>,
}

/// The state block's fields generated code reads and writes
fn x_address(n: usize) -> u32 { state::x as u32 + 8 * n as u32 }

/// (debugging, pages::a32_trace_dump) AArch32 discovery's blocks over the
/// offsets [from, to): each one's start, instructions' kinds and end
pub fn describe_a32(bytes: &[u8], entries: &[u16], env: CompileEnv, from: u16, to: u16) -> String {
    let (blocks, _) = a32::discover(bytes, entries, &env);
    let mut out = String::new();
    for b in &blocks {
        let last = b
            .insts32
            .last()
            .map_or(b.start, |&(o, i)| o + i.length as u16);
        if last < from || b.start >= to {
            continue;
        }
        out += &format!("block {:x}:", b.start);
        for (o, i) in &b.insts32 {
            out += &format!(" {:x}={}", o, a32::kind_name(&i.kind));
        }
        out += &match b.end {
            End::Stop => " stop".to_string(),
            End::StepAt(o) => format!(" step@{:x}", o),
            End::Next(o) => format!(" next@{:x}", o),
        };
        out += "\n";
    }
    out
}

pub fn compile(bytes: &[u8], entries: &[u16], env: CompileEnv, name: String) -> Option<Compiled> {
    let words: Vec<u32> = bytes
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let (blocks, index) = if env.isa == Isa::A64 {
        discover(&words, entries, &env)
    }
    else {
        a32::discover(bytes, entries, &env)
    };
    if blocks.is_empty() {
        return None;
    }
    let instructions = blocks
        .iter()
        .map(|b| b.count() as u32 + matches!(b.end, End::StepAt(_)) as u32)
        .sum();
    let templated = blocks.iter().map(|b| b.count() as u32).sum();
    let mut served = vec![0u64; 64];
    for &o in index.keys() {
        served[o as usize / 64] |= 1 << (o % 64);
    }
    let mut b = WasmBuilder::new();
    b.set_entry_result();
    b.set_function_name(name);
    let budget = b.arg_local_initial_state.unsafe_clone();
    let v = (0..LOCALS64)
        .map(|_| b.declare_zeroed_local_i64())
        .collect();
    let w = (0..LOCALS32).map(|_| b.declare_zeroed_local()).collect();
    let mut e = Emitter {
        b,
        v,
        w,
        budget,
        frame: None,
        levels: Vec::new(),
        blocks: &blocks,
        env,
        access: None,
        step: StepAbi {
            exit_code: state::a64_page_exit as u32,
        },
        words: words.clone(),
    };
    e.prologue();
    let start = |k: u32| blocks[k as usize].start as usize;
    let units = frame::structured(&successors(&blocks, &index), &start, true);
    e.page(&units, blocks.len(), &index, DispatchKind::Buckets);
    let Emitter {
        mut b,
        v,
        w,
        budget,
        ..
    } = e;
    for l in v {
        b.free_local_i64(l);
    }
    for l in w {
        b.free_local(l);
    }
    std::mem::forget(budget);
    b.finish();
    Some(Compiled {
        bytes: b.output().to_vec(),
        served,
        instructions,
        templated,
    })
}

impl Emitter<'_> {
    fn g(&mut self, i: usize) { self.b.get_local_i64(&self.v[i]) }
    fn s(&mut self, i: usize) { self.b.set_local_i64(&self.v[i]) }
    fn gi(&mut self, i: usize) { self.b.get_local(&self.w[i]) }
    fn si(&mut self, i: usize) { self.b.set_local(&self.w[i]) }
    fn ti(&mut self, i: usize) { self.b.tee_local(&self.w[i]) }
    fn c64(&mut self, v: u64) { self.b.const_i64(v as i64) }
    fn c32(&mut self, v: i32) { self.b.const_i32(v) }
    fn o(&mut self, opcode: u8) { self.b.op(opcode) }
    fn f(&self) -> Frame { self.frame.unwrap() }

    fn load64(&mut self, address: u32) {
        self.c32(address as i32);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
    }
    fn load32(&mut self, address: u32) {
        self.c32(address as i32);
        self.b.memory_op(op::OP_I32LOAD, op::MEM_ALIGN32, 0);
    }
    /// (the value pushed after) a store to `address`: push the address first
    fn store64_at(&mut self, address: u32, local: usize) {
        self.c32(address as i32);
        self.g(local);
        self.b.memory_op(op::OP_I64STORE, op::MEM_ALIGN64, 0);
    }

    /// The registers, the PC and NZCV into their locals; the access cache's
    /// epoch and table base
    fn prologue(&mut self) {
        self.load_registers();
        self.load64(state::a64_page_linear as u32);
        self.s(BASE);
    }
    fn load_registers(&mut self) {
        // (AArch32's registers and NZCV stay in memory: pagegen::a32)
        let a64 = self.env.isa == Isa::A64;
        if a64 {
            for i in 0..32 {
                self.load64(x_address(i));
                self.s(i);
            }
        }
        self.load64(state::pc as u32);
        self.s(PC);
        if a64 {
            self.load32(state::nzcv as u32);
            self.si(NZCV);
        }
        self.load64(state::a64_jac_epoch as u32);
        self.s(EP);
        self.load32(state::a64_jac_base as u32);
        self.si(JAC);
    }
    fn writeback(&mut self) {
        if self.env.isa != Isa::A64 {
            self.store64_at(state::pc as u32, PC);
            return;
        }
        for i in 0..32 {
            self.store64_at(x_address(i), i);
        }
        self.store64_at(state::pc as u32, PC);
        self.c32(state::nzcv as i32);
        self.gi(NZCV);
        self.b.store_aligned_i32(0);
    }
    fn set_exit(&mut self, code: u32) {
        self.c32(self.step.exit_code as i32);
        self.c32(code as i32);
        self.b.store_aligned_i32(0);
    }
    /// Push N + K (the instructions retired natively and stepped)
    fn n_and_steps(&mut self) {
        self.gi(N);
        self.gi(K);
        self.b.add_i32();
    }
    /// Push the absolute address of offset `offset` of the page
    fn linear(&mut self, offset: u64) {
        self.g(BASE);
        if offset != 0 {
            self.c64(offset);
            self.b.add_i64();
        }
    }

    // ---- operands

    /// Push X[n] (register 31: the zero register), 64-bit
    fn xr(&mut self, n: u8) {
        if n == 31 {
            self.c64(0)
        }
        else {
            self.g(n as usize)
        }
    }
    /// Push X[n] with register 31 as SP
    fn xr_sp(&mut self, n: u8) { self.g(n as usize) }
    /// Pop into X[n] (register 31: discarded)
    fn set_x(&mut self, n: u8) {
        if n == 31 {
            self.b.drop_()
        }
        else {
            self.s(n as usize)
        }
    }
    /// Pop into X[n] with register 31 as SP
    fn set_x_sp(&mut self, n: u8) { self.s(n as usize) }
    /// Pop a result of width `sf` into the register: a 32-bit one zero-extended
    fn set_xw(&mut self, n: u8, sf: bool, sp: bool) {
        if !sf {
            self.c64(0xFFFF_FFFF);
            self.b.and_i64();
        }
        if sp {
            self.set_x_sp(n)
        }
        else {
            self.set_x(n)
        }
    }
    /// The shifted register operand (LSL, LSR, ASR, ROR) of width `sf`, as an i64
    fn shifted(&mut self, rm: u8, kind: u8, amount: u8, sf: bool) {
        self.xr(rm);
        if amount == 0 {
            return;
        }
        if sf {
            self.c64(amount as u64);
            match kind {
                0 => self.b.shl_i64(),
                1 => self.b.shr_u_i64(),
                2 => self.b.shr_s_i64(),
                _ => self.b.rotr_i64(),
            }
        }
        else {
            self.b.wrap_i64_to_i32();
            self.c32(amount as i32);
            match kind {
                0 => self.b.shl_i32(),
                1 => self.b.shr_u_i32(),
                2 => self.b.shr_s_i32(),
                _ => self.b.rotr_i32(),
            }
            self.b.extend_unsigned_i32_to_i64();
        }
    }
    /// The extended register operand (UXTB..SXTX, shifted left), as an i64
    fn extended(&mut self, rm: u8, option: u8, amount: u8) {
        self.xr(rm);
        match option {
            0 => {
                self.c64(0xFF);
                self.b.and_i64();
            },
            1 => {
                self.c64(0xFFFF);
                self.b.and_i64();
            },
            2 => {
                self.c64(0xFFFF_FFFF);
                self.b.and_i64();
            },
            4 => self.o(OP_I64EXTEND8S),
            5 => self.o(OP_I64EXTEND16S),
            6 => self.o(OP_I64EXTEND32S),
            _ => {},
        }
        if amount != 0 {
            self.c64(amount as u64);
            self.b.shl_i64();
        }
    }

    // ---- flags

    /// NZCV from T0 (x), T1 (the second operand, inverted for a subtraction
    /// with carry, see add_flags) and T2 (the result) of an addition (`sub`
    /// false) or subtraction of width `sf` without carry in
    fn arith_flags(&mut self, sub: bool, sf: bool) {
        if sf {
            // N, Z
            self.g(T2);
            self.c64(32);
            self.b.shr_u_i64();
            self.b.wrap_i64_to_i32();
            self.c32(0x8000_0000u32 as i32);
            self.b.and_i32();
            self.g(T2);
            self.o(op::OP_I64EQZ);
            self.c32(30);
            self.b.shl_i32();
            self.b.or_i32();
            // C: no borrow (x >= y), or the sum wrapped (result < x)
            if sub {
                self.g(T0);
                self.g(T1);
                self.o(op::OP_I64GEU);
            }
            else {
                self.g(T2);
                self.g(T0);
                self.o(op::OP_I64LTU);
            }
            self.c32(29);
            self.b.shl_i32();
            self.b.or_i32();
            // V: ((x ^ y) & (x ^ r)) for a subtraction, ((x ^ r) & (y ^ r)) for an addition
            if sub {
                self.g(T0);
                self.g(T1);
                self.b.xor_i64();
                self.g(T0);
                self.g(T2);
                self.b.xor_i64();
            }
            else {
                self.g(T0);
                self.g(T2);
                self.b.xor_i64();
                self.g(T1);
                self.g(T2);
                self.b.xor_i64();
            }
            self.b.and_i64();
            self.c64(63);
            self.b.shr_u_i64();
            self.b.wrap_i64_to_i32();
            self.c32(28);
            self.b.shl_i32();
            self.b.or_i32();
        }
        else {
            // (32-bit: the low halves; T2 holds the 32-bit result zero-extended)
            self.g(T2);
            self.b.wrap_i64_to_i32();
            self.ti(C0);
            self.c32(0x8000_0000u32 as i32);
            self.b.and_i32();
            self.gi(C0);
            self.b.eqz_i32();
            self.c32(30);
            self.b.shl_i32();
            self.b.or_i32();
            if sub {
                self.g(T0);
                self.b.wrap_i64_to_i32();
                self.g(T1);
                self.b.wrap_i64_to_i32();
                self.o(op::OP_I32GEU);
            }
            else {
                self.gi(C0);
                self.g(T0);
                self.b.wrap_i64_to_i32();
                self.o(op::OP_I32LTU);
            }
            self.c32(29);
            self.b.shl_i32();
            self.b.or_i32();
            if sub {
                self.g(T0);
                self.g(T1);
                self.b.xor_i64();
                self.g(T0);
                self.g(T2);
                self.b.xor_i64();
            }
            else {
                self.g(T0);
                self.g(T2);
                self.b.xor_i64();
                self.g(T1);
                self.g(T2);
                self.b.xor_i64();
            }
            self.b.and_i64();
            self.b.wrap_i64_to_i32();
            self.c32(31);
            self.b.shr_u_i32();
            self.c32(28);
            self.b.shl_i32();
            self.b.or_i32();
        }
        self.si(NZCV);
    }
    /// x (T0) + y (T1) + carry (C1, 0 or 1) of width `sf` into T2, NZCV when
    /// `flags` (AddWithCarry: y is already inverted for a subtraction)
    fn add_with_carry(&mut self, sf: bool, flags: bool) {
        self.g(T0);
        self.g(T1);
        self.b.add_i64();
        self.gi(C1);
        self.b.extend_unsigned_i32_to_i64();
        self.b.add_i64();
        if !sf {
            self.c64(0xFFFF_FFFF);
            self.b.and_i64();
        }
        self.s(T2);
        if !flags {
            return;
        }
        // N, Z
        if sf {
            self.g(T2);
            self.c64(32);
            self.b.shr_u_i64();
            self.b.wrap_i64_to_i32();
        }
        else {
            self.g(T2);
            self.b.wrap_i64_to_i32();
        }
        self.c32(0x8000_0000u32 as i32);
        self.b.and_i32();
        self.g(T2);
        self.o(op::OP_I64EQZ);
        self.c32(30);
        self.b.shl_i32();
        self.b.or_i32();
        // C: carry out of x + y + c: r < x, or c and r == x (width sf)
        let (x_, r_) = (T0, T2);
        let cmp = |e: &mut Self, opcode: u8| {
            e.g(r_);
            if !sf {
                e.b.wrap_i64_to_i32();
            }
            e.g(x_);
            if !sf {
                e.b.wrap_i64_to_i32();
            }
            e.o(opcode);
        };
        cmp(self, if sf { op::OP_I64LTU } else { op::OP_I32LTU });
        cmp(self, if sf { op::OP_I64EQ } else { op::OP_I32EQ });
        self.gi(C1);
        self.b.and_i32();
        self.b.or_i32();
        self.c32(29);
        self.b.shl_i32();
        self.b.or_i32();
        // V: ((x ^ r) & (y ^ r)) sign
        self.g(T0);
        self.g(T2);
        self.b.xor_i64();
        self.g(T1);
        self.g(T2);
        self.b.xor_i64();
        self.b.and_i64();
        self.c64(if sf { 63 } else { 31 });
        self.b.shr_u_i64();
        self.b.wrap_i64_to_i32();
        self.c32(1);
        self.b.and_i32();
        self.c32(28);
        self.b.shl_i32();
        self.b.or_i32();
        self.si(NZCV);
    }
    /// NZCV of a logical result in T2 (width sf): N, Z; C and V clear
    fn logic_flags(&mut self, sf: bool) {
        if sf {
            self.g(T2);
            self.c64(32);
            self.b.shr_u_i64();
            self.b.wrap_i64_to_i32();
        }
        else {
            self.g(T2);
            self.b.wrap_i64_to_i32();
        }
        self.c32(0x8000_0000u32 as i32);
        self.b.and_i32();
        self.g(T2);
        if !sf {
            self.c64(0xFFFF_FFFF);
            self.b.and_i64();
        }
        self.o(op::OP_I64EQZ);
        self.c32(30);
        self.b.shl_i32();
        self.b.or_i32();
        self.si(NZCV);
    }
    /// Push ConditionHolds(cond) of NZCV (an i32 0 or 1)
    fn condition(&mut self, cond: u8) {
        let bit = |e: &mut Self, n: i32| {
            e.gi(NZCV);
            e.c32(n);
            e.b.shr_u_i32();
            e.c32(1);
            e.b.and_i32();
        };
        match cond >> 1 {
            0 => bit(self, 30),
            1 => bit(self, 29),
            2 => bit(self, 31),
            3 => bit(self, 28),
            4 => {
                // C && !Z
                self.gi(NZCV);
                self.c32(0x6000_0000);
                self.b.and_i32();
                self.c32(0x2000_0000);
                self.b.eq_i32();
            },
            5 | 6 => {
                // N == V (GE), and !Z (GT)
                self.gi(NZCV);
                self.c32(31);
                self.b.shr_u_i32();
                self.gi(NZCV);
                self.c32(28);
                self.b.shr_u_i32();
                self.b.xor_i32();
                self.c32(1);
                self.b.and_i32();
                self.b.eqz_i32();
                if cond >> 1 == 6 {
                    bit(self, 30);
                    self.b.eqz_i32();
                    self.b.and_i32();
                }
            },
            _ => self.c32(1),
        }
        if cond & 1 != 0 && cond != 0b1111 {
            self.b.eqz_i32();
        }
    }

    // ---- memory

    fn lookup_locals(&self) -> LookupLocals {
        LookupLocals {
            addr: self.v[ADDR].unsafe_clone(),
            epoch: self.v[EP].unsafe_clone(),
            tag: self.v[TAG].unsafe_clone(),
            tables: self.w[JAC].unsafe_clone(),
            entry: self.w[ENT].unsafe_clone(),
            offset: self.w[OFF].unsafe_clone(),
            host: self.w[HH].unsafe_clone(),
        }
    }
    fn access_abi() -> AccessAbi {
        AccessAbi {
            epoch: state::a64_jac_epoch as u32,
            base: state::a64_jac_base as u32,
            entries: super::pages::ENTRIES as u32,
            slow: "a64_page_access",
            bounce: super::pages::bounce_address(),
        }
    }
    /// Push the host address of a `size`-byte access at ADDR (else retry the
    /// instruction at `offset`)
    fn host(&mut self, size: u32, write: bool, offset: u16) { self.host_in(size, write, offset, 0) }
    /// As `host`, an unaligned read copied to bounce slot `slot` (0 or 1:
    /// a pair's second element, whose copy must not replace the first's)
    fn host_in(&mut self, size: u32, write: bool, offset: u16, slot: u32) {
        let (l, abi) = (self.lookup_locals(), Self::access_abi());
        let retry = self.f().retry;
        self.inline_lookup(
            &l,
            &abi,
            (size, false),
            (write as u32) << 8 | slot << 10,
            offset as u64,
            retry,
        );
    }
    /// As `host_in` for a plain store (STR, STP, the SIMD&FP ones): with
    /// cores in workers the host may be unaligned, which store_any stores
    /// to (kind bit 9; LDAR, STLR, the exclusives must fault instead)
    fn host_store(&mut self, size: u32, offset: u16, slot: u32) {
        if !WasmBuilder::ATOMIC_GUEST_MEMORY || size == 1 {
            return self.host_in(size, true, offset, slot);
        }
        let (l, abi) = (self.lookup_locals(), Self::access_abi());
        let retry = self.f().retry;
        self.inline_lookup(
            &l,
            &abi,
            (size, false),
            0x300 | slot << 10,
            offset as u64,
            retry,
        );
    }
    /// Push the value of a system register with an EL1 template (system_register)
    fn system_read(&mut self, r: SystemRegister, offset: u16) {
        match r {
            SystemRegister::SpEl0 => {
                // (at EL1h the banked copy, at EL1t the SP)
                self.load64(state::sp_el as u32);
                self.g(31);
                self.load32(state::pstate as u32);
                self.c32(cpu::PSTATE_SP as i32);
                self.b.and_i32();
                self.b.select();
            },
            SystemRegister::Tpidr1 => self.load64(state::tpidr_el1 as u32),
            SystemRegister::Daif => {
                self.load32(state::pstate as u32);
                self.c32(cpu::PSTATE_DAIF as i32);
                self.b.and_i32();
                self.b.extend_unsigned_i32_to_i64();
            },
            SystemRegister::Elr => self.load64(state::elr_el1 as u32),
            SystemRegister::Spsr => self.load64(state::spsr_el1 as u32),
            SystemRegister::Esr => self.load64(state::esr_el1 as u32),
            SystemRegister::Far => self.load64(state::far_el1 as u32),
            SystemRegister::Dczid if self.env.el1 => self.c64(4),
            SystemRegister::Dczid => {
                // (DZP: SCTLR_EL1.DZE clear)
                self.load64(state::sctlr_el1 as u32);
                self.c64(crate::aarch64::cpu::SCTLR_DZE);
                self.b.and_i64();
                self.c64(0);
                self.b.eq_i64();
                self.b.extend_unsigned_i32_to_i64();
                self.c64(4);
                self.b.shl_i64();
                self.c64(4);
                self.b.or_i64();
            },
            SystemRegister::Counter(enable) => {
                self.el0_enabled(enable, offset);
                self.b
                    .call_signature("a64_page_counter", Signature::new(&[], &[WasmType::I64]));
            },
            SystemRegister::Cntfrq => {
                self.el0_enabled(3, offset);
                self.load64(state::cntfrq_el0 as u32);
            },
            SystemRegister::TpidrRo => self.load64(state::tpidrro_el0 as u32),
            SystemRegister::Contextidr => self.load64(state::contextidr_el1 as u32),
            SystemRegister::Fpcr | SystemRegister::Fpsr => {
                self.fp_check(offset);
                self.load32(if matches!(r, SystemRegister::Fpcr) {
                    state::fpcr
                }
                else {
                    state::fpsr
                } as u32);
                self.b.extend_unsigned_i32_to_i64();
            },
        }
    }
    /// At EL0, retry (the interpreter's trap) unless CNTKCTL_EL1 has one of `bits`
    fn el0_enabled(&mut self, bits: u64, offset: u16) {
        if self.env.el1 {
            return;
        }
        self.load64(state::cntkctl_el1 as u32);
        self.c64(bits);
        self.b.and_i64();
        self.c64(0);
        self.b.eq_i64();
        self.retry_if(offset);
    }
    /// MSR of a system register with an EL1 template: X[rt] into it
    fn system_write(&mut self, r: SystemRegister, rt: u8, offset: u16) {
        let store64 = |e: &mut Self, address: u32, mask: u64| {
            e.c32(address as i32);
            e.xr(rt);
            if mask != u64::MAX {
                e.c64(mask);
                e.b.and_i64();
            }
            e.b.store_aligned_i64(0);
        };
        match r {
            SystemRegister::SpEl0 => {
                // (UNDEFINED at EL1t: the interpreter says so)
                self.load32(state::pstate as u32);
                self.c32(cpu::PSTATE_SP as i32);
                self.b.and_i32();
                self.b.eqz_i32();
                self.retry_if(offset);
                store64(self, state::sp_el as u32, u64::MAX);
            },
            SystemRegister::Tpidr1 => store64(self, state::tpidr_el1 as u32, u64::MAX),
            SystemRegister::Daif => {
                self.c32(state::pstate as i32);
                self.load32(state::pstate as u32);
                self.c32(!cpu::PSTATE_DAIF as i32);
                self.b.and_i32();
                self.xr(rt);
                self.b.wrap_i64_to_i32();
                self.c32(cpu::PSTATE_DAIF as i32);
                self.b.and_i32();
                self.b.or_i32();
                self.b.store_aligned_i32(0);
                self.unmasked(offset);
            },
            SystemRegister::Elr => store64(self, state::elr_el1 as u32, u64::MAX),
            SystemRegister::Spsr => {
                // (sysregs' mask: in profile v3 AArch32's Q, IT, GE and IL too)
                let pan = if cpu::has_pan() { cpu::PSTATE_PAN as u64 } else { 0 };
                let a32 = if cpu::has_aarch32() {
                    (cpu::PSTATE_Q | cpu::PSTATE_IT | cpu::PSTATE_GE | cpu::PSTATE_IL) as u64
                }
                else {
                    0
                };
                store64(self, state::spsr_el1 as u32, 0xF060_03FF | pan | a32)
            },
            SystemRegister::Esr => store64(self, state::esr_el1 as u32, 0xFFFF_FFFF),
            SystemRegister::Far => store64(self, state::far_el1 as u32, u64::MAX),
            SystemRegister::TpidrRo => store64(self, state::tpidrro_el0 as u32, u64::MAX),
            SystemRegister::Contextidr => store64(self, state::contextidr_el1 as u32, 0xFFFF_FFFF),
            SystemRegister::Fpcr | SystemRegister::Fpsr => {
                self.fp_check(offset);
                let (at, mask) = if matches!(r, SystemRegister::Fpcr) {
                    (state::fpcr as u32, crate::aarch64::fp::FPCR_WRITABLE)
                }
                else {
                    (state::fpsr as u32, 0xF800_009F)
                };
                self.c32(at as i32);
                self.xr(rt);
                self.b.wrap_i64_to_i32();
                self.c32(mask as i32);
                self.b.and_i32();
                self.b.store_aligned_i32(0);
            },
            SystemRegister::Dczid | SystemRegister::Counter(_) | SystemRegister::Cntfrq => {
                unreachable!()
            },
        }
    }
    /// After a write to PSTATE.DAIF at `offset`: leave for the run loop,
    /// the PC at the next instruction, when an interrupt is now deliverable
    fn unmasked(&mut self, offset: u16) {
        self.b
            .call_signature("a64_page_unmasked", Signature::new(&[], &[WasmType::I32]));
        self.b.if_void();
        let exit = self.f().exit;
        self.leave_to(exit, offset as u64 + 4);
        self.b.block_end();
    }
    /// As `host`, an unprivileged access at EL1 (LDTR, STTR): a lookup of
    /// the access cache's EL0 tables (after the EL1 ones: jitrt::access's
    /// kinds, read 1 and write 3), filled on a miss with EL0's permissions
    /// (pages::a64_page_access, kind bit 11); not the frame's lookups, which
    /// probe the activation's tables
    fn host_unprivileged(&mut self, size: u32, write: bool, offset: u16) {
        let entries = super::pages::ENTRIES as u32;
        let bytes = crate::jitrt::access::ENTRY_BYTES;
        let table = if write { 2 * entries * bytes } else { 0 };
        // the tag, the entry, the offset in the page
        self.g(ADDR);
        self.c64(12);
        self.b.shr_u_i64();
        self.g(EP);
        self.b.or_i64();
        self.s(TAG);
        self.g(TAG);
        self.b.wrap_i64_to_i32();
        self.c32(entries as i32 - 1);
        self.b.and_i32();
        self.c32(bytes.trailing_zeros() as i32);
        self.b.shl_i32();
        self.gi(JAC);
        self.b.add_i32();
        self.c32((entries * bytes) as i32);
        self.b.add_i32();
        self.si(J0);
        self.g(ADDR);
        self.b.wrap_i64_to_i32();
        self.c32(4095);
        self.b.and_i32();
        self.si(OFF);
        // a hit: the tag matches, the access stays in the page (and is
        // aligned with cores in workers, whose accesses are atomic)
        self.gi(J0);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, table);
        self.g(TAG);
        self.b.eq_i64();
        self.gi(OFF);
        self.c32((4096 - size) as i32);
        self.b.leu_i32();
        self.b.and_i32();
        if WasmBuilder::ATOMIC_GUEST_MEMORY && size > 1 {
            self.gi(OFF);
            self.c32(size.min(8) as i32 - 1);
            self.b.and_i32();
            self.b.eqz_i32();
            self.b.and_i32();
        }
        self.b.if_i32();
        self.gi(J0);
        self.b.load_aligned_i32(table + 8);
        self.gi(OFF);
        self.b.add_i32();
        self.b.else_();
        self.g(ADDR);
        self.c32(size as i32 | (write as i32) << 8 | 0x800);
        self.b.call_signature(
            "a64_page_access",
            Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
        );
        self.b.block_end();
        self.b.tee_local(&self.w[HH]);
        self.b.eqz_i32();
        self.retry_if(offset);
        self.gi(HH);
    }
    /// Retry the instruction at `offset` when the i32 condition on the stack is true
    fn retry_if(&mut self, offset: u16) {
        self.b.if_void();
        let retry = self.f().retry;
        self.leave_to(retry, offset as u64);
        self.b.block_end();
    }
    /// An SP-based access with SP alignment checked: retry when SP is misaligned
    fn sp_check(&mut self, rn: u8, offset: u16) {
        if rn == 31 && self.env.sp_checked {
            self.g(31);
            self.c64(15);
            self.b.and_i64();
            self.c64(0);
            self.b.ne_i64();
            self.retry_if(offset);
        }
    }
    /// Load `size_log` bytes from the host address on the stack into an i64
    /// (sign-extended by `signed`, to 32 bits then zero-extended by `to_w`)
    fn load_value(&mut self, size_log: u32, signed: bool, to_w: bool) {
        if WasmBuilder::ATOMIC_GUEST_MEMORY {
            // (atomic loads only zero-extend: the sign extension follows)
            self.b.guest_load_i64_bits(8 << size_log.min(3), 0);
            if signed && size_log < 3 {
                self.o([0xC2, 0xC3, 0xC4][size_log as usize]); // i64.extend8_s, 16_s, 32_s
                if to_w {
                    self.c64(0xFFFF_FFFF);
                    self.b.and_i64();
                }
            }
            return;
        }
        let align = size_log.min(3) as u8;
        if signed && to_w {
            let opcode = [op::OP_I32LOAD8S, op::OP_I32LOAD16S, op::OP_I32LOAD][size_log as usize];
            self.b.memory_op(opcode, align, 0);
            self.b.extend_unsigned_i32_to_i64();
            return;
        }
        let opcode = match (size_log, signed) {
            (0, false) => op::OP_I64LOAD8U,
            (1, false) => op::OP_I64LOAD16U,
            (2, false) => op::OP_I64LOAD32U,
            (0, true) => op::OP_I64LOAD8S,
            (1, true) => op::OP_I64LOAD16S,
            (2, true) => op::OP_I64LOAD32S,
            _ => op::OP_I64LOAD,
        };
        self.b.memory_op(opcode, align, 0);
    }
    /// [host, value] -> []: the low `bits` of the value stored at host +
    /// `offset`, a host of host_store: with cores in workers an unaligned one
    /// is a plain store, as the interpreter's (an unaligned access is no
    /// single-copy atomic one; barriers order it as any other)
    fn store_any(&mut self, bits: u32, offset: u32) {
        if !WasmBuilder::ATOMIC_GUEST_MEMORY || bits == 8 {
            return self.b.guest_store_i64_bits(bits, offset);
        }
        self.s(SV);
        self.ti(SH);
        self.c32(bits as i32 / 8 - 1);
        self.b.and_i32();
        self.b.if_void();
        self.gi(SH);
        self.g(SV);
        self.b.memory_op(
            match bits {
                16 => op::OP_I64STORE16,
                32 => op::OP_I64STORE32,
                _ => op::OP_I64STORE,
            },
            op::MEM_NO_ALIGN,
            offset,
        );
        self.b.else_();
        self.gi(SH);
        self.g(SV);
        self.b.guest_store_i64_bits(bits, offset);
        self.b.block_end();
    }
    /// Store the i64 on the stack (after the host address) as `size_log` bytes
    fn store_value(&mut self, size_log: u32) {
        if WasmBuilder::ATOMIC_GUEST_MEMORY {
            self.b.guest_store_i64_bits(8 << size_log.min(3), 0);
            return;
        }
        let opcode = [
            op::OP_I64STORE8,
            op::OP_I64STORE16,
            op::OP_I64STORE32,
            op::OP_I64STORE,
        ][size_log as usize];
        self.b.memory_op(opcode, size_log.min(3) as u8, 0);
    }

    // ---- instructions

    /// A helper call (helper): the registers it names and NZCV to memory,
    /// the interpreter's execute, back into their locals; a refusal retries
    /// the instruction in the interpreter. (The locals are loaded again
    /// before the result is looked at: a helper that was done but asks the
    /// run loop for something, a load-exclusive's spin yield, leaves as a
    /// refusal does (pages::HELPER_DONE), and the leaving writes the locals
    /// back over what it wrote; after a refusal memory holds what was stored)
    fn helper_call(&mut self, offset: u16, sync: &HelperSync) {
        let mut gprs = sync.gprs.clone();
        gprs.sort_unstable();
        gprs.dedup();
        for &r in &gprs {
            self.store64_at(x_address(r as usize), r as usize);
        }
        if sync.nzcv {
            self.c32(state::nzcv as i32);
            self.gi(NZCV);
            self.b.store_aligned_i32(0);
        }
        self.c32(self.words[offset as usize / 4] as i32);
        self.linear(offset as u64);
        self.b.call_signature(
            "a64_page_helper",
            Signature::new(&[WasmType::I32, WasmType::I64], &[WasmType::I32]),
        );
        self.si(A0);
        for &r in &gprs {
            self.load64(x_address(r as usize));
            self.s(r as usize);
        }
        if sync.nzcv {
            self.load32(state::nzcv as u32);
            self.si(NZCV);
        }
        self.gi(A0);
        self.retry_if(offset);
    }

    // ---- scalar FP (P6.3b): the fast path's rules (docs/arm64-virt-android16-plan.md P6)

    /// Push whether an FP value's bits in local `l` (D: 64 bits, S: the low
    /// 32) are zero or a normal number, or with `result`, zero or a normal
    /// number of exponent 2 or more (no NaN, infinity, denormal, nor what
    /// may have been tiny)
    fn fp_ordinary(&mut self, l: usize, double: bool, result: bool) {
        let (sign, low, inf) = if double {
            (
                0x8000_0000_0000_0000u64,
                if result { 0x0020_0000_0000_0000u64 } else { 0x0010_0000_0000_0000 },
                0x7FF0_0000_0000_0000u64,
            )
        }
        else {
            (
                0x8000_0000u64,
                if result { 0x0100_0000u64 } else { 0x0080_0000 },
                0x7F80_0000u64,
            )
        };
        let magnitude = |e: &mut Self| {
            e.g(l);
            e.c64(!sign & if double { u64::MAX } else { 0xFFFF_FFFF });
            e.b.and_i64();
        };
        magnitude(self);
        self.o(op::OP_I64EQZ);
        magnitude(self);
        self.c64(low);
        self.b.sub_i64();
        self.c64(inf - low);
        self.o(op::OP_I64LTU);
        self.b.or_i32();
    }
    /// Load V[v]'s low 64 bits (D) or 32 (S, zero-extended) into local `l`
    fn fp_load(&mut self, v: u32, double: bool, l: usize) {
        self.c32((state::v as u32 + 16 * v) as i32);
        self.b.memory_op(
            if double { op::OP_I64LOAD } else { op::OP_I64LOAD32U },
            if double { 3 } else { 2 },
            0,
        );
        self.s(l);
    }
    /// Write local `l`'s bits to V[d], the rest of the register zero
    fn fp_store(&mut self, d: u32, double: bool, l: usize) {
        let at = state::v as u32 + 16 * d;
        self.c32(at as i32);
        self.g(l);
        if !double {
            self.c64(0xFFFF_FFFF);
            self.b.and_i64();
        }
        self.b.store_aligned_i64(0);
        self.c32(at as i32 + 8);
        self.c64(0);
        self.b.store_aligned_i64(0);
    }
    /// Push local `l` as an f64 (D) or f32 (S)
    fn fp_value(&mut self, l: usize, double: bool) {
        self.g(l);
        if double {
            self.b.reinterpret_i64_as_f64();
        }
        else {
            self.b.wrap_i64_to_i32();
            self.b.reinterpret_i32_as_f32();
        }
    }
    /// Pop an f64 (D) or f32 (S) into local `l` as its bits
    fn fp_bits(&mut self, l: usize, double: bool) {
        if double {
            self.b.reinterpret_f64_as_i64();
        }
        else {
            self.b.reinterpret_f32_as_i32();
            self.b.extend_unsigned_i32_to_i64();
        }
        self.s(l);
    }
    fn fp_instruction(&mut self, offset: u16, i: &Inst, form: FpForm) {
        let word = i.imm as u32;
        let double = word >> 22 & 1 != 0;
        let (d, n, m, a) = (word & 31, word >> 5 & 31, word >> 16 & 31, word >> 10 & 31);
        self.fp_check(offset);
        if let FpForm::Move(op) = form {
            self.fp_load(n, double, T0);
            self.g(T0);
            let sign = if double { 1u64 << 63 } else { 1 << 31 };
            match op {
                1 => {
                    self.c64(!sign);
                    self.b.and_i64();
                },
                2 => {
                    self.c64(sign);
                    self.b.xor_i64();
                },
                _ => {},
            }
            self.s(T0);
            return self.fp_store(d, double, T0);
        }
        let done = self.b.block_void();
        // the fast path: RMode RN and FZ 0 (FPCR), IXC already set (FPSR), operands ordinary
        self.fp_load(n, double, T0);
        match form {
            FpForm::Compare { zero: true } => {
                self.c64(0);
                self.s(T1);
            },
            _ => self.fp_load(m, double, T1),
        }
        let compare = matches!(form, FpForm::Compare { .. });
        if let FpForm::MultiplyAdd { .. } = form {
            self.fp_load(a, double, T2);
        }
        self.load32(state::fpcr as u32);
        self.c32(0x01C0_0000);
        self.b.and_i32();
        self.b.eqz_i32();
        if !compare {
            // (IXC: bit 4, as 0 or 1)
            self.load32(state::fpsr as u32);
            self.c32(4);
            self.b.shr_u_i32();
            self.c32(1);
            self.b.and_i32();
            self.b.and_i32();
        }
        for l in if matches!(form, FpForm::MultiplyAdd { .. }) {
            &[T0, T1, T2][..]
        }
        else {
            &[T0, T1][..]
        } {
            if compare {
                // (a compare only refuses NaNs: magnitude <= infinity)
                self.g(*l);
                self.c64(if double { 0x7FFF_FFFF_FFFF_FFFF } else { 0x7FFF_FFFF });
                self.b.and_i64();
                self.c64(if double { 0x7FF0_0000_0000_0000 } else { 0x7F80_0000 });
                self.o(op::OP_I64LEU);
            }
            else {
                self.fp_ordinary(*l, double, false);
            }
            self.b.and_i32();
        }
        if let FpForm::Arithmetic { op: 1, .. } = form {
            // (FDIV: a divisor that is not zero)
            self.g(T1);
            self.c64(if double { 0x7FFF_FFFF_FFFF_FFFF } else { 0x7FFF_FFFF });
            self.b.and_i64();
            self.c64(0);
            self.b.ne_i64();
            self.b.and_i32();
        }
        self.b.if_void();
        match form {
            FpForm::Compare { .. } => {
                // equal 0110, less 1000, greater 0010
                self.fp_value(T0, double);
                self.fp_value(T1, double);
                self.o(if double { op::OP_F64EQ } else { 0x5B });
                self.b.if_i32();
                self.c32(0x6000_0000);
                self.b.else_();
                self.fp_value(T0, double);
                self.fp_value(T1, double);
                self.o(if double { op::OP_F64LT } else { 0x5D });
                self.b.if_i32();
                self.c32(0x8000_0000u32 as i32);
                self.b.else_();
                self.c32(0x2000_0000);
                self.b.block_end();
                self.b.block_end();
                self.si(NZCV);
                self.b.br(done);
                self.b.block_end();
            },
            _ => {
                match form {
                    FpForm::Arithmetic { op, negate } => {
                        // (FMUL 0, FDIV 1, FADD 2, FSUB 3 in the word; Wasm's 0 add, 1 sub, 2 mul, 3 div)
                        let wasm = [2, 3, 0, 1][op as usize];
                        self.fp_value(T0, double);
                        self.fp_value(T1, double);
                        if double {
                            self.b.arithmetic_f64(wasm);
                        }
                        else {
                            self.b.arithmetic_f32(wasm);
                        }
                        if negate {
                            if double {
                                self.b.unary_f64(true);
                            }
                            else {
                                self.o(0x8C); // f32.neg
                            }
                        }
                    },
                    FpForm::MultiplyAdd {
                        negate_addend,
                        negate_product,
                    } => {
                        // relaxed_madd(n, m, a) = n * m + a; relaxed_nmadd = -(n * m) + a, fused (probed)
                        for l in [T0, T1, T2] {
                            self.fp_value(l, double);
                            if l == T2 && negate_addend {
                                if double {
                                    self.b.unary_f64(true);
                                }
                                else {
                                    self.o(0x8C);
                                }
                            }
                            self.b.simd(if double { 0x14 } else { 0x13 }); // splat
                        }
                        self.b.simd(match (double, negate_product) {
                            (false, false) => 0x105,
                            (false, true) => 0x106,
                            (true, false) => 0x107,
                            (true, true) => 0x108,
                        });
                        self.b.simd_lane(if double { 0x21 } else { 0x1F }, 0); // extract lane 0
                    },
                    _ => unreachable!(),
                }
                self.fp_bits(T3, double);
                self.fp_ordinary(T3, double, true);
                self.b.if_void();
                self.fp_store(d, double, T3);
                self.b.br(done);
                self.b.block_end();
                self.b.block_end();
            },
        }
        // the exact path: the interpreter's SoftFloat
        let sync = HelperSync {
            gprs: vec![],
            nzcv: compare,
        };
        self.helper_call(offset, &sync);
        self.b.block_end();
    }

    fn instruction(&mut self, offset: u16, i: &Inst, index: &BTreeMap<u16, usize>) {
        if let Some(form) = fp_form(i, &self.env) {
            return self.fp_instruction(offset, i, form);
        }
        if let Some(form) = neon::form(i, &self.env) {
            return self.vector_instruction(offset, i, form);
        }
        if !native(i, &self.env) {
            let sync = helper(i, &self.env).expect("a template");
            return self.helper_call(offset, &sync);
        }
        let (rd, rn, rm, sf) = (i.rd, i.rn, i.rm, i.sf);
        let mask = |sf: bool| if sf { u64::MAX } else { 0xFFFF_FFFF };
        match i.op {
            Op::Adr => {
                self.linear((offset as u64).wrapping_add(i.imm));
                self.set_x(rd);
            },
            Op::Adrp => {
                self.g(BASE);
                self.c64(i.imm);
                self.b.add_i64();
                self.set_x(rd);
            },
            Op::AddSubImm => {
                self.xr_sp(rn);
                self.s(T0);
                if i.s {
                    self.c64(i.imm);
                    self.s(T1);
                    self.g(T0);
                    self.g(T1);
                    if i.sub == 0 {
                        self.b.add_i64();
                    }
                    else {
                        self.b.sub_i64();
                    }
                    self.c64(mask(sf));
                    self.b.and_i64();
                    self.s(T2);
                    self.arith_flags(i.sub != 0, sf);
                    self.g(T2);
                    self.set_x(rd);
                }
                else {
                    self.g(T0);
                    self.c64(i.imm);
                    if i.sub == 0 {
                        self.b.add_i64();
                    }
                    else {
                        self.b.sub_i64();
                    }
                    self.set_xw(rd, sf, true);
                }
            },
            Op::LogicalImm => {
                self.xr(rn);
                self.c64(i.imm);
                match i.sub {
                    0 | 3 => self.b.and_i64(),
                    1 => self.b.or_i64(),
                    _ => self.b.xor_i64(),
                }
                self.c64(mask(sf));
                self.b.and_i64();
                if i.sub == 3 {
                    self.s(T2);
                    self.logic_flags(sf);
                    self.g(T2);
                    self.set_x(rd);
                }
                else {
                    self.set_x_sp(rd);
                }
            },
            Op::MoveWide => {
                let shifted = i.imm << i.amount;
                match i.sub {
                    0 => self.c64(!shifted & mask(sf)),
                    2 => self.c64(shifted),
                    _ => {
                        self.xr(rd);
                        self.c64(!(0xFFFFu64 << i.amount) & mask(sf));
                        self.b.and_i64();
                        self.c64(shifted);
                        self.b.or_i64();
                    },
                }
                self.set_x(rd);
            },
            Op::Bitfield => self.bitfield(i),
            Op::Extr => {
                let lsb = i.amount as u64;
                if sf {
                    self.xr(rm);
                    if lsb != 0 {
                        self.c64(lsb);
                        self.b.shr_u_i64();
                        self.xr(rn);
                        self.c64(64 - lsb);
                        self.b.shl_i64();
                        self.b.or_i64();
                    }
                }
                else {
                    self.xr(rn);
                    self.c64(32);
                    self.b.shl_i64();
                    self.xr(rm);
                    self.c64(0xFFFF_FFFF);
                    self.b.and_i64();
                    self.b.or_i64();
                    self.c64(lsb);
                    self.b.shr_u_i64();
                    self.c64(0xFFFF_FFFF);
                    self.b.and_i64();
                }
                self.set_x(rd);
            },
            Op::LogicalShifted => {
                self.xr(rn);
                self.shifted(rm, i.shift, i.amount, sf);
                if i.sub & 1 != 0 {
                    self.c64(u64::MAX);
                    self.b.xor_i64();
                }
                match i.sub >> 1 {
                    0 | 3 => self.b.and_i64(),
                    1 => self.b.or_i64(),
                    _ => self.b.xor_i64(),
                }
                self.c64(mask(sf));
                self.b.and_i64();
                if i.sub >> 1 == 3 {
                    self.s(T2);
                    self.logic_flags(sf);
                    self.g(T2);
                }
                self.set_x(rd);
            },
            Op::AddSubShifted | Op::AddSubExtended => {
                let extended = i.op == Op::AddSubExtended;
                if extended {
                    self.xr_sp(rn);
                }
                else {
                    self.xr(rn);
                }
                self.s(T0);
                if extended {
                    self.extended(rm, i.shift, i.amount);
                }
                else {
                    self.shifted(rm, i.shift, i.amount, sf);
                }
                self.s(T1);
                self.g(T0);
                self.g(T1);
                if i.sub == 0 {
                    self.b.add_i64();
                }
                else {
                    self.b.sub_i64();
                }
                self.c64(mask(sf));
                self.b.and_i64();
                self.s(T2);
                if i.s {
                    self.arith_flags(i.sub != 0, sf);
                }
                self.g(T2);
                if extended && !i.s {
                    self.set_x_sp(rd);
                }
                else {
                    self.set_x(rd);
                }
            },
            Op::AddSubCarry => {
                self.xr(rn);
                self.s(T0);
                self.xr(rm);
                if i.sub != 0 {
                    self.c64(u64::MAX);
                    self.b.xor_i64();
                }
                self.c64(mask(sf));
                self.b.and_i64();
                self.s(T1);
                self.gi(NZCV);
                self.c32(29);
                self.b.shr_u_i32();
                self.c32(1);
                self.b.and_i32();
                self.si(C1);
                if !sf {
                    self.g(T0);
                    self.c64(0xFFFF_FFFF);
                    self.b.and_i64();
                    self.s(T0);
                }
                self.add_with_carry(sf, i.s);
                self.g(T2);
                self.set_x(rd);
            },
            Op::CondCompare => {
                self.condition(i.cond);
                self.b.if_void();
                self.xr(rn);
                self.c64(mask(sf));
                self.b.and_i64();
                self.s(T0);
                if i.amount == 1 {
                    self.c64(rm as u64);
                }
                else {
                    self.xr(rm);
                }
                self.c64(mask(sf));
                self.b.and_i64();
                self.s(T1);
                self.g(T0);
                self.g(T1);
                if i.sub == 0 {
                    self.b.add_i64();
                }
                else {
                    self.b.sub_i64();
                }
                self.c64(mask(sf));
                self.b.and_i64();
                self.s(T2);
                self.arith_flags(i.sub != 0, sf);
                self.b.else_();
                self.c32(((i.imm as u32) << 28) as i32);
                self.si(NZCV);
                self.b.block_end();
            },
            Op::CondSelect => {
                self.xr(rn);
                self.xr(rm);
                match i.sub {
                    0 => {},
                    1 => {
                        self.c64(1);
                        self.b.add_i64();
                    },
                    2 => {
                        self.c64(u64::MAX);
                        self.b.xor_i64();
                    },
                    _ => {
                        self.s(T0);
                        self.c64(0);
                        self.g(T0);
                        self.b.sub_i64();
                    },
                }
                self.condition(i.cond);
                self.b.select();
                self.set_xw(rd, sf, false);
            },
            Op::DataProc3 => self.data_processing_3(i),
            Op::DataProc2 => self.data_processing_2(i),
            Op::DataProc1 => self.data_processing_1(i),
            Op::Hint => {},
            Op::Barrier => {
                self.b.guest_fence();
                if i.sub == 0 && crate::parallel::active() {
                    // (the TLB maintenance this core posted: the DSB steps, and waits)
                    self.load32(crate::aarch64::tlb::pending_address());
                    self.b.if_void();
                    let step = self.f().step;
                    self.leave_to(step, offset as u64);
                    self.b.block_end();
                }
            },
            Op::MsrImm => {
                // DAIFSet (1), DAIFClr (2) at EL1
                let bits = (i.imm as u32 & 15) << 6;
                self.c32(state::pstate as i32);
                self.load32(state::pstate as u32);
                if i.sub == 1 {
                    self.c32(bits as i32);
                    self.b.or_i32();
                }
                else {
                    self.c32(!bits as i32);
                    self.b.and_i32();
                }
                self.b.store_aligned_i32(0);
                if i.sub == 2 {
                    self.unmasked(offset);
                }
            },
            Op::Sys if i.imm as u32 == DC_ZVA => {
                // (at EL0 only while SCTLR_EL1.DZE allows it: else the
                // interpreter, which traps)
                if !self.env.el1 {
                    self.load64(state::sctlr_el1 as u32);
                    self.c64(crate::aarch64::cpu::SCTLR_DZE);
                    self.b.and_i64();
                    self.b.wrap_i64_to_i32();
                    self.b.eqz_i32();
                    self.retry_if(offset);
                }
                // the 64-byte block (DCZID_EL0's BS 4) zeroed through the
                // access cache's write entry (a miss, Device memory, a code
                // or watched page: the interpreter, which faults or marks)
                self.xr(rd);
                self.c64(!63);
                self.b.and_i64();
                self.s(ADDR);
                self.host(8, true, offset);
                self.si(C1);
                for k in 0..8 {
                    self.gi(C1);
                    self.c64(0);
                    self.b.guest_store_i64(8 * k);
                }
            },
            Op::Sys => {
                // TLBI: the TLBs and access caches in Rust; the function leaves
                // when what it depends on changed (its access cache's epoch)
                self.c32(self.words[offset as usize / 4] as i32);
                self.xr(rd);
                self.b.call_signature(
                    "a64_page_tlbi",
                    Signature::new(&[WasmType::I32, WasmType::I64], &[WasmType::I32]),
                );
                self.b.if_void();
                let exit = self.f().exit;
                self.leave_to(exit, offset as u64 + 4);
                self.b.block_end();
            },
            Op::Mrs if system_register(i, &self.env).is_some() => {
                self.system_read(system_register(i, &self.env).unwrap(), offset);
                self.set_x(rd);
            },
            Op::Msr if system_register(i, &self.env).is_some() => {
                self.system_write(system_register(i, &self.env).unwrap(), rd, offset);
            },
            Op::Mrs => {
                if i.imm as u32 == TPIDR_EL0 {
                    self.load64(state::tpidr_el0 as u32);
                }
                else {
                    self.gi(NZCV);
                    self.b.extend_unsigned_i32_to_i64();
                }
                self.set_x(rd);
            },
            Op::Msr => {
                if i.imm as u32 == TPIDR_EL0 {
                    self.c32(state::tpidr_el0 as i32);
                    self.xr(rd);
                    self.b.store_aligned_i64(0);
                }
                else {
                    self.xr(rd);
                    self.b.wrap_i64_to_i32();
                    self.c32(0xF000_0000u32 as i32);
                    self.b.and_i32();
                    self.si(NZCV);
                }
            },
            Op::LoadLiteral => {
                if i.sub == 3 {
                    // (PRFM literal: no effect)
                    return;
                }
                self.linear((offset as u64).wrapping_add(i.imm));
                self.s(ADDR);
                let size = if i.sub == 1 { 8 } else { 4 };
                self.host(size, false, offset);
                if WasmBuilder::ATOMIC_GUEST_MEMORY {
                    self.b.guest_load_i64_bits(8 * size, 0);
                    if i.sub == 2 {
                        self.o(0xC4); // i64.extend32_s
                    }
                }
                else {
                    match i.sub {
                        0 => self.b.memory_op(op::OP_I64LOAD32U, 2, 0),
                        1 => self.b.memory_op(op::OP_I64LOAD, 3, 0),
                        _ => self.b.memory_op(op::OP_I64LOAD32S, 2, 0),
                    }
                }
                self.set_x(rd);
            },
            Op::LoadStore => self.load_store(offset, i),
            Op::LoadStorePair => self.load_store_pair(offset, i),
            Op::LoadAcquireStoreRelease => {
                let size_log = i.cond as u32;
                self.sp_check(rn, offset);
                self.xr_sp(rn);
                self.s(ADDR);
                // (aligned, or the interpreter's alignment fault)
                if size_log != 0 {
                    self.g(ADDR);
                    self.c64((1 << size_log) - 1);
                    self.b.and_i64();
                    self.c64(0);
                    self.b.ne_i64();
                    self.retry_if(offset);
                }
                self.host(1 << size_log, i.sub != 1, offset);
                if i.sub == 1 {
                    self.load_value(size_log, false, false);
                    self.set_x(rd);
                }
                else {
                    self.xr(rd);
                    self.store_value(size_log);
                }
            },
            Op::Branch => {
                if i.sub == 1 {
                    self.linear(offset as u64 + 4);
                    self.s(30);
                }
                self.goto((offset as u64).wrapping_add(i.imm), index);
            },
            Op::BCond => {
                self.condition(i.cond);
                self.b.if_void();
                self.goto((offset as u64).wrapping_add(i.imm), index);
                self.b.block_end();
            },
            Op::CompareBranch => {
                self.xr(rd);
                if !sf {
                    self.b.wrap_i64_to_i32();
                    self.b.eqz_i32();
                }
                else {
                    self.o(op::OP_I64EQZ);
                }
                if i.sub != 0 {
                    self.b.eqz_i32();
                }
                self.b.if_void();
                self.goto((offset as u64).wrapping_add(i.imm), index);
                self.b.block_end();
            },
            Op::TestBranch => {
                self.xr(rd);
                self.c64(i.amount as u64);
                self.b.shr_u_i64();
                self.c64(1);
                self.b.and_i64();
                self.b.wrap_i64_to_i32();
                if i.sub != 1 {
                    self.b.eqz_i32();
                }
                self.b.if_void();
                self.goto((offset as u64).wrapping_add(i.imm), index);
                self.b.block_end();
            },
            Op::BranchReg => {
                self.xr(rn);
                self.s(T0);
                // (a target whose top byte is not its bit 55 extended: TBI, the interpreter's)
                self.g(T0);
                self.c64(8);
                self.b.shl_i64();
                self.c64(8);
                self.b.shr_s_i64();
                self.g(T0);
                self.b.ne_i64();
                self.retry_if(offset);
                if i.sub == 1 {
                    self.linear(offset as u64 + 4);
                    self.s(30);
                }
                self.g(T0);
                self.s(PC);
                self.b.br(self.f().dispatch);
            },
            _ => unreachable!("no template: {:?}", i.op),
        }
    }

    fn bitfield(&mut self, i: &Inst) {
        let sf = i.sf;
        let width = if sf { 64 } else { 32 };
        let imms = i.imm as u32;
        let immr = i.amount as u32;
        let (wmask, tmask) = crate::aarch64::execute::bitfield_masks(sf as u32, imms, immr, sf);
        let full = if sf { u64::MAX } else { 0xFFFF_FFFF };
        // rotated = ROR(src, immr) within the width
        let rotated = |e: &mut Self| {
            e.xr(i.rn);
            if sf {
                if immr != 0 {
                    e.c64(immr as u64);
                    e.b.rotr_i64();
                }
            }
            else {
                e.b.wrap_i64_to_i32();
                if immr != 0 {
                    e.c32(immr as i32);
                    e.b.rotr_i32();
                }
                e.b.extend_unsigned_i32_to_i64();
            }
        };
        match i.sub {
            0 => {
                // SBFM: the sign of bit imms above the field
                rotated(self);
                self.c64(wmask & tmask);
                self.b.and_i64();
                self.xr(i.rn);
                self.c64((63 - imms) as u64);
                self.b.shl_i64();
                self.c64(63);
                self.b.shr_s_i64();
                self.c64(!tmask & full);
                self.b.and_i64();
                self.b.or_i64();
            },
            1 => {
                // BFM: the destination's other bits stay
                self.xr(i.rd);
                self.c64(!(wmask & tmask) & full);
                self.b.and_i64();
                rotated(self);
                self.c64(wmask & tmask);
                self.b.and_i64();
                self.b.or_i64();
            },
            _ => {
                rotated(self);
                self.c64(wmask & tmask);
                self.b.and_i64();
            },
        }
        let _ = width;
        self.set_x(i.rd);
    }

    fn data_processing_3(&mut self, i: &Inst) {
        let (rd, rn, rm, ra, sf) = (i.rd, i.rn, i.rm, i.ra, i.sf);
        match i.sub {
            0 | 1 => {
                self.xr(ra);
                self.xr(rn);
                self.xr(rm);
                self.b.mul_i64();
                if i.sub == 0 {
                    self.b.add_i64();
                }
                else {
                    self.b.sub_i64();
                }
                self.set_xw(rd, sf, false);
            },
            2 | 3 | 10 | 11 => {
                // SMADDL, SMSUBL, UMADDL, UMSUBL
                let signed = i.sub < 10;
                self.xr(ra);
                for r in [rn, rm] {
                    self.xr(r);
                    if signed {
                        self.o(OP_I64EXTEND32S);
                    }
                    else {
                        self.c64(0xFFFF_FFFF);
                        self.b.and_i64();
                    }
                }
                self.b.mul_i64();
                if i.sub & 1 == 0 {
                    self.b.add_i64();
                }
                else {
                    self.b.sub_i64();
                }
                self.set_x(rd);
            },
            _ => {
                // SMULH (4), UMULH (12): the product's high 64 bits from 32-bit halves
                self.xr(rn);
                self.s(T0);
                self.xr(rm);
                self.s(T1);
                let half = |e: &mut Self, l: usize, high: bool| {
                    e.g(l);
                    if high {
                        e.c64(32);
                        e.b.shr_u_i64();
                    }
                    else {
                        e.c64(0xFFFF_FFFF);
                        e.b.and_i64();
                    }
                };
                // T2 = lo(a) * lo(b); T3 = hi(a) * lo(b); T4 = lo(a) * hi(b)
                half(self, T0, false);
                half(self, T1, false);
                self.b.mul_i64();
                self.s(T2);
                half(self, T0, true);
                half(self, T1, false);
                self.b.mul_i64();
                self.s(T3);
                half(self, T0, false);
                half(self, T1, true);
                self.b.mul_i64();
                self.s(T4);
                // cross = (T2 >> 32) + (T3 & mask) + T4, in T4
                self.g(T2);
                self.c64(32);
                self.b.shr_u_i64();
                self.g(T3);
                self.c64(0xFFFF_FFFF);
                self.b.and_i64();
                self.b.add_i64();
                self.g(T4);
                self.b.add_i64();
                self.s(T4);
                // high = hi(a) * hi(b) + (T3 >> 32) + (cross >> 32)
                half(self, T0, true);
                half(self, T1, true);
                self.b.mul_i64();
                self.g(T3);
                self.c64(32);
                self.b.shr_u_i64();
                self.b.add_i64();
                self.g(T4);
                self.c64(32);
                self.b.shr_u_i64();
                self.b.add_i64();
                if i.sub == 4 {
                    // signed: minus b where a < 0, minus a where b < 0
                    for (sign, other) in [(T0, T1), (T1, T0)] {
                        self.g(other);
                        self.g(sign);
                        self.c64(63);
                        self.b.shr_s_i64();
                        self.b.and_i64();
                        self.b.sub_i64();
                    }
                }
                self.set_x(rd);
            },
        }
    }

    fn data_processing_2(&mut self, i: &Inst) {
        let (rd, rn, rm, sf) = (i.rd, i.rn, i.rm, i.sf);
        match i.sub {
            0b000010 | 0b000011 => {
                // UDIV, SDIV: by 0 gives 0; SDIV of the most negative by -1 wraps
                let signed = i.sub == 0b000011;
                if sf {
                    self.xr(rn);
                    self.s(T0);
                    self.xr(rm);
                    self.s(T1);
                }
                else {
                    for (r, l) in [(rn, T0), (rm, T1)] {
                        self.xr(r);
                        if signed {
                            self.o(OP_I64EXTEND32S);
                        }
                        else {
                            self.c64(0xFFFF_FFFF);
                            self.b.and_i64();
                        }
                        self.s(l);
                    }
                }
                self.g(T1);
                self.o(op::OP_I64EQZ);
                self.b.if_i64();
                self.c64(0);
                self.b.else_();
                if signed {
                    self.g(T1);
                    self.c64(u64::MAX);
                    self.b.eq_i64();
                    self.b.if_i64();
                    self.c64(0);
                    self.g(T0);
                    self.b.sub_i64();
                    self.b.else_();
                    self.g(T0);
                    self.g(T1);
                    self.o(op::OP_I64DIVS);
                    self.b.block_end();
                }
                else {
                    self.g(T0);
                    self.g(T1);
                    self.o(op::OP_I64DIVU);
                }
                self.b.block_end();
                self.set_xw(rd, sf, false);
            },
            _ => {
                // LSLV, LSRV, ASRV, RORV: Wasm takes the count modulo the width, as A64
                let kind = i.sub - 0b001000;
                self.xr(rn);
                if sf {
                    self.xr(rm);
                    match kind {
                        0 => self.b.shl_i64(),
                        1 => self.b.shr_u_i64(),
                        2 => self.b.shr_s_i64(),
                        _ => self.b.rotr_i64(),
                    }
                }
                else {
                    self.b.wrap_i64_to_i32();
                    self.xr(rm);
                    self.b.wrap_i64_to_i32();
                    match kind {
                        0 => self.b.shl_i32(),
                        1 => self.b.shr_u_i32(),
                        2 => self.b.shr_s_i32(),
                        _ => self.b.rotr_i32(),
                    }
                    self.b.extend_unsigned_i32_to_i64();
                }
                self.set_x(rd);
            },
        }
    }

    fn data_processing_1(&mut self, i: &Inst) {
        let (rd, rn, sf) = (i.rd, i.rn, i.sf);
        // swap adjacent groups of `bits` bits within each 2*bits
        let swap = |e: &mut Self, bits: u64, m: u64| {
            e.s(T0);
            e.g(T0);
            e.c64(m);
            e.b.and_i64();
            e.c64(bits);
            e.b.shl_i64();
            e.g(T0);
            e.c64(bits);
            e.b.shr_u_i64();
            e.c64(m);
            e.b.and_i64();
            e.b.or_i64();
        };
        match i.sub {
            0 => {
                // RBIT: bits, pairs and nibbles swapped, then REV (the
                // swaps stay in 32-bit lanes: a W register's low word)
                self.xr(rn);
                swap(self, 1, 0x5555_5555_5555_5555);
                swap(self, 2, 0x3333_3333_3333_3333);
                swap(self, 4, 0x0F0F_0F0F_0F0F_0F0F);
                swap(self, 8, 0x00FF_00FF_00FF_00FF);
                swap(self, 16, 0x0000_FFFF_0000_FFFF);
                if sf {
                    self.c64(32);
                    self.b.rotr_i64();
                }
                else {
                    self.c64(0xFFFF_FFFF);
                    self.b.and_i64();
                }
                self.set_x(rd);
            },
            1 => {
                // REV16
                self.xr(rn);
                swap(self, 8, 0x00FF_00FF_00FF_00FF);
                self.set_xw(rd, sf, false);
            },
            2 | 3 => {
                // REV32 (and REV of a W register), REV
                self.xr(rn);
                swap(self, 8, 0x00FF_00FF_00FF_00FF);
                swap(self, 16, 0x0000_FFFF_0000_FFFF);
                if i.sub == 3 && sf {
                    self.c64(32);
                    self.b.rotr_i64();
                }
                if !sf {
                    self.c64(0xFFFF_FFFF);
                    self.b.and_i64();
                }
                self.set_x(rd);
            },
            4 => {
                // CLZ
                self.xr(rn);
                if sf {
                    self.b.clz_i64();
                }
                else {
                    self.b.wrap_i64_to_i32();
                    self.b.clz_i32();
                    self.b.extend_unsigned_i32_to_i64();
                }
                self.set_x(rd);
            },
            _ => {
                // CLS: CLZ(x ^ (x >> (width - 1))) - 1
                self.xr(rn);
                if sf {
                    self.s(T0);
                    self.g(T0);
                    self.g(T0);
                    self.c64(63);
                    self.b.shr_s_i64();
                    self.b.xor_i64();
                    self.b.clz_i64();
                    self.c64(1);
                    self.b.sub_i64();
                }
                else {
                    self.b.wrap_i64_to_i32();
                    self.ti(C0);
                    self.gi(C0);
                    self.c32(31);
                    self.b.shr_s_i32();
                    self.b.xor_i32();
                    self.b.clz_i32();
                    self.c32(1);
                    self.b.sub_i32();
                    self.b.extend_unsigned_i32_to_i64();
                }
                self.set_x(rd);
            },
        }
    }

    /// The FP and AdvSIMD access check of the compiled EL (CPACR_EL1.FPEN:
    /// EL1 needs bit 0, EL0 both bits): retry the instruction when disabled
    fn fp_check(&mut self, offset: u16) {
        self.load32(state::cpacr_el1 as u32);
        self.c32(20);
        self.b.shr_u_i32();
        self.c32(3);
        self.b.and_i32();
        if self.env.el1 {
            self.c32(1);
            self.b.and_i32();
            self.b.eqz_i32();
        }
        else {
            self.c32(3);
            self.b.ne_i32();
        }
        self.retry_if(offset);
    }
    /// Load a SIMD&FP register of `size_log` bytes (2: S, 3: D, 4: Q) from the
    /// host address in `host` into V[v] (zero-extended to 128 bits)
    fn load_vector(&mut self, host: usize, size_log: u32, v: u8) {
        let at = state::v as u32 + 16 * v as u32;
        // low half
        self.c32(at as i32);
        self.gi(host);
        if WasmBuilder::ATOMIC_GUEST_MEMORY {
            self.b
                .guest_load_i64_bits(if size_log == 2 { 32 } else { 64 }, 0);
        }
        else if size_log == 2 {
            self.b.memory_op(op::OP_I64LOAD32U, 2, 0);
        }
        else {
            self.b.memory_op(op::OP_I64LOAD, 3, 0);
        }
        self.b.store_aligned_i64(0);
        // high half
        self.c32(at as i32 + 8);
        if size_log == 4 {
            self.gi(host);
            if WasmBuilder::ATOMIC_GUEST_MEMORY {
                self.b.guest_load_i64(8);
            }
            else {
                self.b.memory_op(op::OP_I64LOAD, 3, 8);
            }
        }
        else {
            self.c64(0);
        }
        self.b.store_aligned_i64(0);
    }
    /// Store V[v]'s low `size_log` bytes at the host address in `host`
    fn store_vector(&mut self, host: usize, size_log: u32, v: u8) {
        let at = state::v as u32 + 16 * v as u32;
        self.gi(host);
        self.load64(at);
        if WasmBuilder::ATOMIC_GUEST_MEMORY {
            // (a host of host_store: maybe unaligned)
            self.store_any(if size_log == 2 { 32 } else { 64 }, 0);
        }
        else if size_log == 2 {
            self.b.memory_op(op::OP_I64STORE32, 2, 0);
        }
        else {
            self.b.memory_op(op::OP_I64STORE, 3, 0);
        }
        if size_log == 4 {
            self.gi(host);
            self.load64(at + 8);
            if WasmBuilder::ATOMIC_GUEST_MEMORY {
                self.store_any(64, 8);
            }
            else {
                self.b.memory_op(op::OP_I64STORE, 3, 8);
            }
        }
    }

    fn load_store(&mut self, offset: u16, i: &Inst) {
        let (rt, rn) = (i.rd, i.rn);
        let size_log = i.cond as u32;
        let simd = i.sub & LS_SIMD != 0;
        if simd {
            self.fp_check(offset);
        }
        if i.sub & LS_PREFETCH != 0 {
            // (PRFM: no effect, never a fault)
            return;
        }
        self.sp_check(rn, offset);
        let writeback = i.shift == MODE_PRE || i.shift == MODE_POST;
        // the address in ADDR (the base in T0 for a writeback)
        self.xr_sp(rn);
        if writeback {
            self.s(T0);
            self.g(T0);
        }
        match i.shift {
            MODE_POST => {},
            MODE_REGISTER => {
                self.extended(i.rm, i.ra, i.amount);
                self.b.add_i64();
            },
            _ => {
                if i.imm != 0 {
                    self.c64(i.imm);
                    self.b.add_i64();
                }
            },
        }
        self.s(ADDR);
        let load = i.sub & LS_LOAD != 0;
        if i.sub & LS_UNPRIVILEGED != 0 && self.env.el1 {
            self.host_unprivileged(1 << size_log, !load, offset);
        }
        else if load {
            self.host(1 << size_log, false, offset);
        }
        else {
            self.host_store(1 << size_log, offset, 0);
        }
        if simd {
            self.si(C1);
            if load {
                self.load_vector(C1, size_log, rt);
            }
            else {
                self.store_vector(C1, size_log, rt);
            }
        }
        else if load {
            self.load_value(size_log, i.sub & LS_SIGNED != 0, i.sub & LS_TO_W != 0);
            self.set_x(rt);
        }
        else if i.sub & LS_UNPRIVILEGED != 0 && self.env.el1 {
            self.xr(rt);
            self.store_value(size_log);
        }
        else {
            self.xr(rt);
            self.store_any(8 << size_log.min(3), 0);
        }
        if writeback {
            if i.shift == MODE_POST {
                self.g(T0);
                self.c64(i.imm);
                self.b.add_i64();
            }
            else {
                self.g(ADDR);
            }
            self.set_x_sp(rn);
        }
    }

    fn load_store_pair(&mut self, offset: u16, i: &Inst) {
        let (rt, rt2, rn) = (i.rd, i.ra, i.rn);
        let size_log = i.cond as u32;
        let size = 1u32 << size_log;
        let simd = i.sub & LS_SIMD != 0;
        if simd {
            self.fp_check(offset);
        }
        self.sp_check(rn, offset);
        let writeback = i.shift == MODE_PRE || i.shift == MODE_POST;
        self.xr_sp(rn);
        self.s(T0);
        // the first address in T1, the second in ADDR, both looked up first
        self.g(T0);
        if i.shift != MODE_POST {
            self.c64(i.imm);
            self.b.add_i64();
        }
        self.s(T1);
        let load = i.sub & LS_LOAD != 0;
        self.g(T1);
        self.s(ADDR);
        if load {
            self.host(size, false, offset);
        }
        else {
            self.host_store(size, offset, 0);
        }
        self.si(C1);
        self.g(T1);
        self.c64(size as u64);
        self.b.add_i64();
        self.s(ADDR);
        if load {
            self.host_in(size, false, offset, 1);
        }
        else {
            self.host_store(size, offset, 1);
        }
        self.si(HH);
        if simd {
            // (both read before either register is written, as the interpreter)
            if load {
                if rt == rt2 {
                    self.load_vector(HH, size_log, rt2);
                }
                else {
                    self.load_vector(C1, size_log, rt);
                    self.load_vector(HH, size_log, rt2);
                }
            }
            else {
                self.store_vector(C1, size_log, rt);
                self.store_vector(HH, size_log, rt2);
            }
        }
        else if load {
            let signed = i.sub & LS_SIGNED != 0;
            self.gi(C1);
            self.load_value(size_log, signed, false);
            self.s(T2);
            self.gi(HH);
            self.load_value(size_log, signed, false);
            self.s(T3);
            self.g(T2);
            self.set_x(rt);
            self.g(T3);
            self.set_x(rt2);
        }
        else {
            self.gi(C1);
            self.xr(rt);
            self.store_any(8 << size_log.min(3), 0);
            self.gi(HH);
            self.xr(rt2);
            self.store_any(8 << size_log.min(3), 0);
        }
        if writeback {
            if i.shift == MODE_POST {
                self.g(T0);
                self.c64(i.imm);
                self.b.add_i64();
            }
            else {
                self.g(T1);
            }
            self.set_x_sp(rn);
        }
    }

    /// The chaining lookup at the leave (jitrt::chain): with budget left and
    /// an entry for the PC's page, write the state back and tail-call that
    /// page's function, which counts on from what this one retired
    fn chain(&mut self) {
        self.n_and_steps();
        self.b.get_local(&self.budget);
        self.b.ltu_i32();
        self.b.if_void();
        frame::chain_lookup(
            &mut self.b,
            &self.v[PC],
            &self.v[TAG],
            &self.w[ENT],
            state::a64_code_base as u32,
            ChainEpoch::Local(&self.v[EP]),
        );
        self.writeback();
        self.c32(state::a64_page_chain as i32);
        self.load32(state::a64_page_chain as u32);
        self.n_and_steps();
        self.b.add_i32();
        self.b.store_aligned_i32(0);
        // (the linear page the next function runs at)
        self.c32(state::a64_page_linear as i32);
        self.g(PC);
        self.c64(!0xFFF);
        self.b.and_i64();
        self.b.store_aligned_i64(0);
        self.b.get_local(&self.budget);
        self.n_and_steps();
        self.b.sub_i32();
        frame::chain_call(&mut self.b, &self.w[ENT]);
        self.b.block_end();
        self.b.block_end();
    }
}

impl PageEmitter for Emitter<'_> {
    fn b(&mut self) -> &mut WasmBuilder { &mut self.b }
    fn frame(&self) -> Frame { self.frame.unwrap() }
    fn set_frame(&mut self, frame: Frame) { self.frame = Some(frame) }
    fn levels(&mut self) -> &mut Vec<Level> { &mut self.levels }
    fn levels_ref(&self) -> &[Level] { &self.levels }
    fn span_bytes(&self) -> u64 { PAGE }
    fn pc_offset(&mut self) {
        self.g(PC);
        self.g(BASE);
        self.b.sub_i64();
        self.b.wrap_i64_to_i32();
    }
    fn tee_offset(&mut self) { self.ti(OFF) }
    fn get_offset(&mut self) { self.gi(OFF) }
    fn head(&mut self) {
        self.n_and_steps();
        self.b.get_local(&self.budget);
        self.b.geu_i32();
        self.b.br_if(self.f().exit);
    }
    fn emit_block(&mut self, k: u32, index: &BTreeMap<u16, usize>) {
        let blocks = self.blocks;
        let block = &blocks[k as usize];
        // (the block's native instructions counted at its entry)
        if block.count() != 0 {
            self.gi(N);
            self.c32(block.count() as i32);
            self.b.add_i32();
            self.si(N);
        }
        for (offset, i) in &block.insts {
            self.instruction(*offset, i, index);
        }
        for (offset, i) in &block.insts32 {
            self.instruction32(*offset, i, index);
        }
        match block.end {
            End::Stop => {},
            End::StepAt(o) => {
                let step = self.f().step;
                self.leave_to(step, o as u64);
            },
            End::Next(o) => {
                if !self.falls_into(o, index) {
                    self.goto(o as u64, index);
                }
            },
        }
    }
    fn block_start(&self, k: u32) -> u16 { self.blocks[k as usize].start }
    fn leave_to(&mut self, label: Label, target: u64) {
        self.linear(target);
        // (AArch32's addresses wrap at 4 GiB)
        if self.env.isa != Isa::A64 {
            self.c64(0xFFFF_FFFF);
            self.b.and_i64();
        }
        self.s(PC);
        self.b.br(label);
    }
    fn before_branch(&mut self) {}
    fn span_check(&mut self, _target: u64) {}
    fn direct_loops(&self) -> bool { true }
    fn bounds(&mut self, leave: Label) {
        self.g(PC);
        self.g(BASE);
        self.b.sub_i64();
        self.c64(PAGE);
        self.o(op::OP_I64GEU);
        self.b.br_if(leave);
    }
    fn unknown_offset(&mut self) {
        self.g(PC);
        self.b.call_signature(
            "a64_page_unserved",
            Signature::new(&[WasmType::I64], &[WasmType::I32]),
        );
        self.b.eqz_i32();
        self.b.br_if(self.f().step);
        self.set_exit(EXIT_UNKNOWN);
        self.b.br(self.f().exit);
    }
    fn step_tail(&mut self) {
        self.writeback();
        self.gi(K);
        self.c32(1);
        self.b.add_i32();
        self.si(K);
        self.b
            .call_signature("a64_page_step", Signature::new(&[], &[WasmType::I32]));
        self.si(ST);
        self.gi(ST);
        self.b.if_void();
        self.n_and_steps();
        self.b.return_();
        self.b.block_end();
        self.load_registers();
        self.b.br(self.f().dispatch);
    }
    fn retry_tail(&mut self) {
        self.set_exit(EXIT_RETRY);
        self.b.br(self.f().exit);
    }
    fn leave_tail(&mut self) {
        if !self.env.chaining {
            return;
        }
        if self.env.isa == Isa::T32 {
            // (T32: not inside an IT block, which the next page's function
            // knows nothing of: pages::run's rule for entries)
            self.load32(state::pstate as u32);
            self.c32(cpu::PSTATE_IT as i32);
            self.b.and_i32();
            self.b.eqz_i32();
            self.b.if_void();
            self.chain();
            self.b.block_end();
            return;
        }
        self.chain();
    }
    fn exit_tail(&mut self) {
        self.writeback();
        self.n_and_steps();
    }
    fn lookup_function(&mut self) -> u32 {
        if let Some(f) = self.access {
            return f;
        }
        let f = frame::lookup_function(&mut self.b, &Self::access_abi());
        self.access = Some(f);
        f
    }
}
