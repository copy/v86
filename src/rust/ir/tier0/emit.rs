//! One Wasm function per code page: an entry guard, then a dispatch loop that
//! branches (br_table over the page offset) to the code of each basic block.
//!
//! The eight GPRs live in Wasm locals for the whole activation. The last
//! FLAGS producers' lazy stores, XMM registers a template keeps in locals and
//! the x87 register cache can be pending as well. All of them are written
//! back, in exactly the interpreter's representation, at every exit and
//! before every interpreter fallback, together with EIP and the retired-
//! instruction count; segments and the rest of the CPU state stay in memory.
//!
//! Templates cover the most frequent integer forms. Each checks everything it
//! needs (segment usable, 32-bit stack, ...) before its first state change;
//! any failed check runs the whole instruction through `ir_t0_step` instead,
//! so faults and rare cases keep the interpreter's exact behavior. An access
//! off the TLB fast path (a TLB miss, MMIO, a page crossing, a store to a page
//! with code) calls `ir_t0_read_slow` or `ir_t0_write_slow`: they access with
//! all of the interpreter's effects, interrupt delivery held to the next
//! instruction boundary (runtime::tier0::held), or leave the instruction to
//! `ir_t0_step` as well (it would fault, or it stores to a page with IR code).
use super::analysis::{self, Instruction, PagePlan, Unit};
use crate::cpu::cpu::{
    FLAGS_ALL, FLAG_ADJUST, FLAG_CARRY, FLAG_DIRECTION, FLAG_INTERRUPT, FLAG_OVERFLOW, FLAG_SIGN,
    FLAG_SUB, FLAG_VM, FLAG_ZERO, TLB_GLOBAL, TLB_HAS_CODE, TLB_IA32E_DATA, TLB_NO_USER,
    TLB_READONLY, TLB_VALID,
};
use crate::cpu::global_pointers as gp;
use crate::ir::frontend::decode::{DecodedInstruction, EffectiveAddress, Flow};
use crate::ir::helper::imports::signature;
use crate::ir::x87::Io;
use crate::x86tpl::x87::{x87_native, X87Cache, X87Words};
use crate::x86tpl::x87run::X87Run;

#[path = "simd.rs"]
mod simd;
#[path = "x87run.rs"]
mod x87run;
/// Register-only x87 runs (A/B switch).
const X87_RUNS: bool = true;
use super::CompileEnv;
use crate::ir::runtime::entry::{CpuEntryKey, ExitKind};
use crate::ir::runtime::tier0::{
    Link, T0_CLD_STD, T0_CLI, T0_JECXZ, T0_POP_ESP, T0_POP_RM, T0_PUSHA, T0_REP_MOVS_STOS,
    T0_SREG_LOAD, T0_SREG_READ, T0_XCHG_MEM,
};
use crate::state_flags::CachedStateFlags;
use crate::wasmgen::wasm_builder::{
    Label, Signature, WasmBuilder, WasmLocal, WasmLocalI64, WasmLocalV128, WasmType,
};

/// Whether the SIMD templates take `i` (simd::classify, and its VEX forms):
/// the forms tier0::replay's corpus covers
#[cfg(feature = "ir-test-hooks")]
pub(crate) fn simd_template(i: &DecodedInstruction) -> bool {
    simd::classify(i).is_some() || simd::classify_vex(i).is_some()
}

/// ir_t0_step results (see runtime::tier0).
const STEP_EXIT: i32 = 2;
const ES: u8 = 0;
const CS: u8 = 1;
const SS: u8 = 2;
const DS: u8 = 3;

pub struct Emitted {
    pub bytes: Vec<u8>,
    pub locals: usize,
    /// Instructions emitted as templates rather than interpreter fallbacks.
    pub templated: usize,
    pub instructions: usize,
}

/// The FLAGS-producing operation whose operands are still in fa/fb/fr.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Known {
    None,
    Sub(u8),
    Add(u8),
    Logic(u8),
    Inc(u8),
    Dec(u8),
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Src {
    Reg(u8),
    Imm(u32),
    Rm,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shift {
    Left,
    Right,
    Arithmetic,
}
/// Names of Form kinds, by Form::kind (tests/ir/performance/xp_boot.mjs).
pub const FORM_NAMES: &[&str] = &[
    "Alu",
    "Test",
    "MovToRm",
    "MovToReg",
    "Lea",
    "MovExtend",
    "IncDec",
    "NegNot",
    "Shift",
    "ShiftHelper",
    "Carry",
    "DoubleShift",
    "BitScan",
    "BitTest",
    "MulWide",
    "Div",
    "Xadd",
    "Cmpxchg",
    "Moffs",
    "X87",
    "Fnstsw",
    "X87Flags",
    "Fcmov",
    "Simd",
    "Imul",
    "Push",
    "Pop",
    "Xchg",
    "Cdq",
    "Cwde",
    "Nop",
    "Leave",
    "Setcc",
    "Cmov",
    "Jmp",
    "Jcc",
    "Call",
    "Ret",
    "JmpIndirect",
    "CallIndirect",
    "Lahf",
    "Bmi",
    "Movbe",
    "Jecxz",
    "MovFromSreg",
    "PushSreg",
    "XchgMem",
    "Direction",
    "PopRm",
    "Pusha",
    "Popa",
    "MovToSreg",
    "Cli",
    "RepMovsStos",
];
/// The template-kind profile's keys (runtime::tier0::kind_profile, the
/// switch t0_kind_profile; docs/jit-unification-plan.md P3.0a): a Form kind
/// (FORM_NAMES), FORM_NAMES.len() for a step, and from X87_KEYS an x87
/// instruction's opcode (D8-DF), templated or not, with its ModRM byte: a
/// register form's whole byte, a memory form's reg field (as reg << 3,
/// below 0xC0)
pub const PROFILE_KEYS: usize = X87_KEYS + 8 * 256;
pub const X87_KEYS: usize = 64;
/// The profile key of `i`, templated as `form` or (None) stepped
fn profile_key(form: Option<Form>, i: &DecodedInstruction) -> usize {
    let op = i.encoding.opcode;
    match i.modrm {
        Some(modrm) if (0xD8..=0xDF).contains(&op) => {
            let low = if modrm >= 0xC0 { modrm } else { modrm & 0x38 };
            X87_KEYS + ((op as usize & 7) << 8) + low as usize
        },
        _ => form.map_or(FORM_NAMES.len(), Form::kind),
    }
}
/// Form::Bmi's operations
#[derive(Clone, Copy, PartialEq, Eq)]
enum BmiOp {
    Andn,
    Blsr,
    Blsmsk,
    Blsi,
    Bzhi,
    Shlx,
    Shrx,
    Sarx,
    Tzcnt,
    Lzcnt,
}
/// Shift/rotate count operand.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Count {
    Imm(u8),
    Cl,
}
/// A templated instruction form. Control forms end their block.
#[derive(Clone, Copy)]
enum Form {
    /// ADD/OR/AND/SUB/XOR/CMP: rm (or reg) op src.
    Alu {
        op: u8,
        size: u8,
        to_rm: bool,
        reg: u8,
        src: Src,
    },
    Test {
        size: u8,
        src: Src,
    },
    MovToRm {
        size: u8,
        src: Src,
    },
    MovToReg {
        size: u8,
        reg: u8,
        src: Src,
    },
    Lea {
        size: u8,
        reg: u8,
    },
    MovExtend {
        reg: u8,
        from: u8,
        signed: bool,
    },
    IncDec {
        dec: bool,
        size: u8,
        reg: Option<u8>,
    },
    NegNot {
        neg: bool,
        size: u8,
    },
    Shift {
        kind: Shift,
        count: u8,
    },
    /// rm = helper(rm, count & 31): rotates and the remaining shifts, which
    /// update the lazy FLAGS in memory like the interpreter.
    ShiftHelper {
        name: &'static str,
        size: u8,
        count: Count,
    },
    /// ADC/SBB through cpu::arith (CF input from the lazy FLAGS).
    Carry {
        sub: bool,
        size: u8,
        to_rm: bool,
        reg: u8,
        src: Src,
    },
    /// SHLD/SHRD: rm = helper(rm, reg, count & 31).
    DoubleShift {
        left: bool,
        size: u8,
        reg: u8,
        count: Count,
    },
    /// BSF/BSR: reg = helper(reg, rm).
    BitScan {
        reverse: bool,
        reg: u8,
    },
    /// BMI1 and BMI2's VEX forms, TZCNT and LZCNT (cpu::bmi): reg (ModRM.reg;
    /// VEX.vvvv for BLSR, BLSMSK and BLSI) = op(r/m, VEX.vvvv)
    Bmi {
        op: BmiOp,
        reg: u8,
        vvvv: u8,
    },
    /// MOVBE r32, m32 (`load`) or m32, r32: the bytes reversed
    Movbe {
        load: bool,
        reg: u8,
    },
    /// BT/BTS/BTR/BTC on a register operand.
    BitTest {
        op: u8,
        offset: Src,
    },
    /// One-operand MUL/IMUL: EDX:EAX = EAX * rm.
    MulWide {
        signed: bool,
    },
    /// DIV/IDIV: EAX, EDX = EDX:EAX / rm (retry on #DE).
    Div {
        signed: bool,
    },
    Xadd {
        size: u8,
        reg: u8,
    },
    Cmpxchg {
        size: u8,
        reg: u8,
    },
    /// MOV between AL/eAX and a direct memory offset.
    Moffs {
        size: u8,
        store: bool,
        ea: EffectiveAddress,
    },
    /// A continuing x87 form (ir::x87::io): operand transfer here, FPU state
    /// through runtime::x87::ir_t0_x87.
    X87 {
        opcode: u8,
        modrm: u8,
        io: Io,
    },
    /// FNSTSW AX.
    Fnstsw,
    /// FUCOMI/FCOMI(P) ST, ST(r) through cpu::fpu (writes FLAGS).
    X87Flags {
        name: &'static str,
        r: u8,
    },
    /// FCMOVcc ST, ST(r).
    Fcmov {
        cc: u8,
        r: u8,
    },
    /// MMX, SSE to SSE4.2 and VEX forms (see simd).
    Simd(simd::Simd, Option<simd::Vex>),
    Imul {
        reg: u8,
        immediate: Option<u32>,
    },
    Push {
        src: Src,
    },
    Pop {
        reg: u8,
    },
    Xchg {
        a: u8,
        b: u8,
    },
    Cdq,
    Cwde,
    Nop,
    Leave,
    Setcc {
        cc: u8,
    },
    Cmov {
        cc: u8,
        reg: u8,
    },
    Jmp {
        target: u32,
    },
    Jcc {
        cc: u8,
        target: u32,
    },
    /// JECXZ, or JCXZ with a 16-bit address size (`cx`): P3.7, the feature
    /// T0_JECXZ
    Jecxz {
        target: u32,
        cx: bool,
    },
    /// MOV r/m, Sreg (P3.7, T0_SREG_READ): the selector, zero-extended into
    /// a 32-bit register, 16 bits into memory or a 16-bit register
    MovFromSreg {
        seg: u8,
        size: u8,
    },
    /// PUSH ES/CS/SS/DS/FS/GS with a 32-bit operand (P3.7, T0_SREG_READ):
    /// ESP - 4 with only the low 16 bits written, as
    /// cpu::misc_instr::push32_sreg
    PushSreg {
        seg: u8,
    },
    /// XCHG r/m, r with a memory operand (P3.7, T0_XCHG_MEM)
    XchgMem {
        size: u8,
        reg: u8,
    },
    /// CLD and STD (P3.7, T0_CLD_STD)
    Direction {
        set: bool,
    },
    /// POP m32 (P3.7, T0_POP_RM), an address that uses ESP (`esp`: the base)
    /// with T0_POP_ESP (P3.7(c))
    PopRm {
        esp: bool,
    },
    /// CLI (P3.7(c), T0_CLI)
    Cli,
    /// REP MOVS (`movs`) or REP STOS of `size`-byte elements with a 32-bit
    /// address size (P3.1b, T0_REP_MOVS_STOS): at once when it stays in a
    /// page per operand, else the interpreter
    RepMovsStos {
        movs: bool,
        size: u8,
    },
    /// PUSHAD and POPAD whose 32 bytes are in one page (P3.7, T0_PUSHA)
    Pusha,
    Popa,
    /// MOV ES/DS/FS/GS, r/m16 (P3.7(b), T0_SREG_LOAD): ir_t0_load_seg, or
    /// the interpreter when it refuses
    MovToSreg {
        seg: u8,
    },
    Call {
        target: u32,
    },
    Ret {
        pop: u16,
    },
    JmpIndirect,
    CallIndirect,
    /// LAHF: AH = SF:ZF:0:AF:0:PF:1:CF of the materialized FLAGS.
    Lahf,
}
impl Form {
    /// Index of the form kind (statistics; see FORM_NAMES).
    fn kind(self) -> usize {
        #[allow(unreachable_patterns)]
        match self {
            Form::Alu { .. } => 0,
            Form::Test { .. } => 1,
            Form::MovToRm { .. } => 2,
            Form::MovToReg { .. } => 3,
            Form::Lea { .. } => 4,
            Form::MovExtend { .. } => 5,
            Form::IncDec { .. } => 6,
            Form::NegNot { .. } => 7,
            Form::Shift { .. } => 8,
            Form::ShiftHelper { .. } => 9,
            Form::Carry { .. } => 10,
            Form::DoubleShift { .. } => 11,
            Form::BitScan { .. } => 12,
            Form::BitTest { .. } => 13,
            Form::MulWide { .. } => 14,
            Form::Div { .. } => 15,
            Form::Xadd { .. } => 16,
            Form::Cmpxchg { .. } => 17,
            Form::Moffs { .. } => 18,
            Form::X87 { .. } => 19,
            Form::Fnstsw { .. } => 20,
            Form::X87Flags { .. } => 21,
            Form::Fcmov { .. } => 22,
            Form::Simd { .. } => 23,
            Form::Imul { .. } => 24,
            Form::Push { .. } => 25,
            Form::Pop { .. } => 26,
            Form::Xchg { .. } => 27,
            Form::Cdq { .. } => 28,
            Form::Cwde { .. } => 29,
            Form::Nop { .. } => 30,
            Form::Leave { .. } => 31,
            Form::Setcc { .. } => 32,
            Form::Cmov { .. } => 33,
            Form::Jmp { .. } => 34,
            Form::Jcc { .. } => 35,
            Form::Call { .. } => 36,
            Form::Ret { .. } => 37,
            Form::JmpIndirect { .. } => 38,
            Form::CallIndirect { .. } => 39,
            Form::Lahf => 40,
            Form::Bmi { .. } => 41,
            Form::Movbe { .. } => 42,
            Form::Jecxz { .. } => 43,
            Form::MovFromSreg { .. } => 44,
            Form::PushSreg { .. } => 45,
            Form::XchgMem { .. } => 46,
            Form::Direction { .. } => 47,
            Form::PopRm { .. } => 48,
            Form::Pusha => 49,
            Form::Popa => 50,
            Form::MovToSreg { .. } => 51,
            Form::Cli => 52,
            Form::RepMovsStos { .. } => 53,
        }
    }
    /// Whether the template can retry() (else no retry tail is emitted).
    fn may_retry(self, i: &DecodedInstruction) -> bool {
        i.ea.is_some() && !matches!(self, Form::Lea { .. })
            || !matches!(
                self,
                Form::Alu { .. }
                    | Form::Test { .. }
                    | Form::MovToRm { .. }
                    | Form::MovToReg { .. }
                    | Form::Lea { .. }
                    | Form::MovExtend { .. }
                    | Form::IncDec { .. }
                    | Form::NegNot { .. }
                    | Form::Shift { .. }
                    | Form::ShiftHelper { .. }
                    | Form::Carry { .. }
                    | Form::DoubleShift { .. }
                    | Form::BitScan { .. }
                    | Form::Bmi {
                        op: BmiOp::Tzcnt | BmiOp::Lzcnt,
                        ..
                    }
                    | Form::BitTest { .. }
                    | Form::MulWide { .. }
                    | Form::Xadd { .. }
                    | Form::Cmpxchg { .. }
                    | Form::Imul { .. }
                    | Form::Xchg { .. }
                    | Form::Cdq
                    | Form::Cwde
                    | Form::Nop
                    | Form::Setcc { .. }
                    | Form::Cmov { .. }
                    | Form::Jmp { .. }
                    | Form::Jcc { .. }
                    | Form::Jecxz { .. }
                    | Form::MovFromSreg { .. }
                    | Form::Direction { .. }
                    | Form::Lahf
            )
    }
    /// Whether the template reads or writes the CPU's x87 state other than
    /// through the x87 cache (MMX aliases the stack; helpers).
    fn reads_x87_state(self) -> bool {
        use simd::Simd as S;
        match self {
            Form::Fnstsw | Form::X87Flags { .. } | Form::Fcmov { .. } => true,
            Form::Simd(s, _) => matches!(
                s,
                S::MmxLoad { .. }
                    | S::MmxStore { .. }
                    | S::Emms
                    | S::MovdIn { mmx: true, .. }
                    | S::MovdOut { mmx: true, .. }
                    | S::Packed { mmx: true, .. }
                    | S::ShiftImmediate { mmx: true, .. }
            ),
            _ => false,
        }
    }
    /// Whether the template reads or read-modify-writes the lazy FLAGS in
    /// memory (pending stores are written first). Others keep their FLAGS
    /// effects pending (see PendingFlags) or read the pending state.
    fn touches_flags_memory(self) -> bool {
        match self {
            Form::ShiftHelper {
                name: "rol32" | "ror32",
                size: 32,
                count: Count::Imm(_),
            } => false,
            Form::DoubleShift {
                size: 32,
                count: Count::Imm(_),
                ..
            } => false,
            // Helpers over the lazy state, and dynamic counts (no FLAGS
            // change for a zero count).
            Form::ShiftHelper { .. } | Form::DoubleShift { .. } => true,
            Form::X87Flags { .. }
            | Form::Simd(simd::Simd::CompareFlags { .. } | simd::Simd::Strings { .. }, _)
            | Form::Lahf
            | Form::Direction { .. }
            | Form::Cli => true,
            _ => false,
        }
    }
    fn control(self) -> bool {
        matches!(
            self,
            Form::Jmp { .. }
                | Form::Jcc { .. }
                | Form::Jecxz { .. }
                | Form::Call { .. }
                | Form::Ret { .. }
                | Form::JmpIndirect
                | Form::CallIndirect
        )
    }
    fn uses_memory(self, i: &DecodedInstruction) -> bool {
        i.ea.is_some()
            || matches!(
                self,
                Form::Push { .. }
                    | Form::Pop { .. }
                    | Form::PushSreg { .. }
                    | Form::PopRm { .. }
                    | Form::Pusha
                    | Form::Popa
                    | Form::RepMovsStos { .. }
                    | Form::Leave
                    | Form::Call { .. }
                    | Form::Ret { .. }
                    | Form::CallIndirect
            )
    }
}

fn relative_target(i: &DecodedInstruction) -> Option<u32> {
    match i.flow {
        Flow::Relative { displacement, .. } if i.operand_size == 32 => {
            Some(i.next_pc.0.wrapping_add(displacement as u32))
        },
        _ => None,
    }
}

/// BMI1 and BMI2's VEX forms, TZCNT, LZCNT and MOVBE on 32-bit operands:
/// the hot forms of plan 5.1 and their siblings (MULX, PDEP, PEXT, BEXTR,
/// RORX and the 16-bit forms are interpreted)
fn bmi(i: &DecodedInstruction) -> Option<Form> {
    if i.baseline_ud || i.prefixes.lock {
        return None;
    }
    let reg = i.modrm? >> 3 & 7;
    if let Some(v) = i.vex {
        if i.encoding.vex & crate::decode_rules::vex::GPR == 0 {
            return None;
        }
        let vvvv = v.vvvv & 7;
        let (op, reg) = match i.encoding.opcode {
            0xC402_00F2 => (BmiOp::Andn, reg),
            0xC402_00F3 => (
                match reg {
                    1 => BmiOp::Blsr,
                    2 => BmiOp::Blsmsk,
                    3 => BmiOp::Blsi,
                    _ => return None,
                },
                vvvv,
            ),
            0xC402_00F5 => (BmiOp::Bzhi, reg),
            0xC402_01F7 => (BmiOp::Shlx, reg),
            0xC402_02F7 => (BmiOp::Sarx, reg),
            0xC402_03F7 => (BmiOp::Shrx, reg),
            _ => return None,
        };
        return Some(Form::Bmi { op, reg, vvvv });
    }
    if i.operand_size != 32 {
        return None;
    }
    Some(match i.encoding.opcode {
        0xF30FBC => Form::Bmi {
            op: BmiOp::Tzcnt,
            reg,
            vvvv: 0,
        },
        0xF30FBD => Form::Bmi {
            op: BmiOp::Lzcnt,
            reg,
            vvvv: 0,
        },
        0x0F38F0 | 0x0F38F1 if i.ea.is_some() => Form::Movbe {
            load: i.encoding.opcode == 0x0F38F0,
            reg,
        },
        _ => return None,
    })
}

/// Whether the instruction has a template with Tier-0's `features`
/// (CompileEnv::features; others end their block).
pub fn templated(i: &DecodedInstruction, features: u32) -> bool { classify(i, features).is_some() }

/// The template for `i` with Tier-0's `features`, or None for an
/// interpreter fallback.
fn classify(i: &DecodedInstruction, features: u32) -> Option<Form> {
    // SSE selects forms by F2/F3/66 prefixes, so it precedes the REP check.
    if let Some(form) = simd::classify(i) {
        return Some(Form::Simd(form, None));
    }
    if let Some((form, vex)) = simd::classify_vex(i) {
        return Some(Form::Simd(form, Some(vex)));
    }
    // (TZCNT and LZCNT: F3 selects them)
    if let Some(form) = bmi(i) {
        return Some(form);
    }
    // (P3.1b: REP MOVS/STOS, the encodings F3A4, F3A5, F3AA and F3AB, on
    // one core: with several, the interpreter does at most 256 elements per
    // step so that the others run, which P3.1d's t0_rep_smp would keep)
    if features & T0_REP_MOVS_STOS != 0
        && i.address_size == 32
        && !i.baseline_ud
        && !crate::parallel::active()
        && crate::cpu::apic::core_count() == 1
    {
        let size = |byte: bool| if byte { 1 } else { i.operand_size / 8 };
        match i.encoding.opcode {
            0xF3A4 | 0xF3A5 => {
                return Some(Form::RepMovsStos {
                    movs: true,
                    size: size(i.encoding.opcode == 0xF3A4),
                })
            },
            0xF3AA | 0xF3AB => {
                return Some(Form::RepMovsStos {
                    movs: false,
                    size: size(i.encoding.opcode == 0xF3AA),
                })
            },
            _ => {},
        }
    }
    // Invalid LOCK forms are rejected by the shared decoder. A valid locked
    // RMW stays inside one activation, including its guarded slow path.
    let p = i.prefixes;
    if p.rep || p.repne || i.baseline_ud {
        return None;
    }
    let op = i.encoding.opcode;
    // With cores in workers a locked read-modify-write needs one atomic
    // commit (the interpreter's compare-exchange helpers)
    if crate::parallel::active() && i.ea.is_some() && (p.lock || matches!(op, 0x86 | 0x87)) {
        return None;
    }
    let modrm = i.modrm.unwrap_or(0);
    let reg = modrm >> 3 & 7;
    let v = i.operand_size;
    let imm = i.immediate;
    Some(match op {
        0x00..=0x3F if op & 7 < 6 && !matches!(op >> 3, 2 | 3) => {
            let alu = (op >> 3) as u8;
            let size = if op & 1 == 0 { 8 } else { v };
            match op & 7 {
                0 | 1 => Form::Alu {
                    op: alu,
                    size,
                    to_rm: true,
                    reg: 0,
                    src: Src::Reg(reg),
                },
                2 | 3 => Form::Alu {
                    op: alu,
                    size,
                    to_rm: false,
                    reg,
                    src: Src::Rm,
                },
                _ => Form::Alu {
                    op: alu,
                    size,
                    to_rm: false,
                    reg: 0,
                    src: Src::Imm(imm?),
                },
            }
        },
        0x80 | 0x81 | 0x83 if !matches!(reg, 2 | 3) => Form::Alu {
            op: reg,
            size: if op == 0x80 { 8 } else { v },
            to_rm: true,
            reg: 0,
            src: Src::Imm(imm?),
        },
        0x84 | 0x85 => Form::Test {
            size: if op == 0x84 { 8 } else { v },
            src: Src::Reg(reg),
        },
        0xA8 | 0xA9 => Form::Alu {
            op: 8,
            size: if op == 0xA8 { 8 } else { v },
            to_rm: false,
            reg: 0,
            src: Src::Imm(imm?),
        },
        0xF6 | 0xF7 if reg == 0 => Form::Test {
            size: if op == 0xF6 { 8 } else { v },
            src: Src::Imm(imm?),
        },
        0xF6 | 0xF7 if matches!(reg, 2 | 3) => Form::NegNot {
            neg: reg == 3,
            size: if op == 0xF6 { 8 } else { v },
        },
        0x88 | 0x89 => Form::MovToRm {
            size: if op == 0x88 { 8 } else { v },
            src: Src::Reg(reg),
        },
        0x8A | 0x8B => Form::MovToReg {
            size: if op == 0x8A { 8 } else { v },
            reg,
            src: Src::Rm,
        },
        0xB0..=0xB7 => Form::MovToReg {
            size: 8,
            reg: (op & 7) as u8,
            src: Src::Imm(imm?),
        },
        0xB8..=0xBF => Form::MovToReg {
            size: v,
            reg: (op & 7) as u8,
            src: Src::Imm(imm?),
        },
        0xC6 | 0xC7 if reg == 0 => Form::MovToRm {
            size: if op == 0xC6 { 8 } else { v },
            src: Src::Imm(imm?),
        },
        0x8D if i.ea.is_some() => Form::Lea { size: v, reg },
        0x0FB6 | 0x0FB7 | 0x0FBE | 0x0FBF if v == 32 => Form::MovExtend {
            reg,
            from: if op & 1 == 0 { 8 } else { 16 },
            signed: op >= 0x0FBE,
        },
        0x40..=0x4F => Form::IncDec {
            dec: op >= 0x48,
            size: v,
            reg: Some((op & 7) as u8),
        },
        0xFE | 0xFF if reg <= 1 => Form::IncDec {
            dec: reg == 1,
            size: if op == 0xFE { 8 } else { v },
            reg: None,
        },
        0xC1 | 0xD1 if v == 32 && matches!(reg, 4 | 5 | 7) => Form::Shift {
            kind: match reg {
                4 => Shift::Left,
                5 => Shift::Right,
                _ => Shift::Arithmetic,
            },
            count: if op == 0xD1 { 1 } else { (imm? & 31) as u8 },
        },
        0xC0 | 0xC1 | 0xD0 | 0xD1 | 0xD2 | 0xD3 => {
            let size = if op & 1 == 0 { 8 } else { v };
            let count = match op {
                0xC0 | 0xC1 => Count::Imm((imm? & 31) as u8),
                0xD0 | 0xD1 => Count::Imm(1),
                _ => Count::Cl,
            };
            let name = match (reg, size) {
                (0, 8) => "rol8",
                (0, 16) => "rol16",
                (0, _) => "rol32",
                (1, 8) => "ror8",
                (1, 16) => "ror16",
                (1, _) => "ror32",
                (2, 8) => "rcl8",
                (2, 16) => "rcl16",
                (2, _) => "rcl32",
                (3, 8) => "rcr8",
                (3, 16) => "rcr16",
                (3, _) => "rcr32",
                (4 | 6, 8) => "shl8",
                (4 | 6, 16) => "shl16",
                (4 | 6, _) => "shl32",
                (5, 8) => "shr8",
                (5, 16) => "shr16",
                (5, _) => "shr32",
                (_, 8) => "sar8",
                (_, 16) => "sar16",
                _ => "sar32",
            };
            Form::ShiftHelper { name, size, count }
        },
        0x10..=0x15 | 0x18..=0x1D => {
            let size = if op & 1 == 0 { 8 } else { v };
            let sub = op >= 0x18;
            match op & 7 {
                0 | 1 => Form::Carry {
                    sub,
                    size,
                    to_rm: true,
                    reg: 0,
                    src: Src::Reg(reg),
                },
                2 | 3 => Form::Carry {
                    sub,
                    size,
                    to_rm: false,
                    reg,
                    src: Src::Rm,
                },
                _ => Form::Carry {
                    sub,
                    size,
                    to_rm: false,
                    reg: 0,
                    src: Src::Imm(imm?),
                },
            }
        },
        0x80 | 0x81 | 0x83 => Form::Carry {
            sub: reg == 3,
            size: if op == 0x80 { 8 } else { v },
            to_rm: true,
            reg: 0,
            src: Src::Imm(imm?),
        },
        0x0FA4 | 0x0FA5 | 0x0FAC | 0x0FAD => Form::DoubleShift {
            left: op < 0x0FA8,
            size: v,
            reg,
            count: if op & 1 == 0 { Count::Imm((imm? & 31) as u8) } else { Count::Cl },
        },
        0x0FBC | 0x0FBD if v == 32 => Form::BitScan {
            reverse: op == 0x0FBD,
            reg,
        },
        0x0FA3 | 0x0FAB | 0x0FB3 | 0x0FBB if v == 32 && i.ea.is_none() => Form::BitTest {
            op: ((op >> 3) & 3) as u8,
            offset: Src::Reg(reg),
        },
        0x0FBA if v == 32 && reg >= 4 && i.ea.is_none() => Form::BitTest {
            op: reg - 4,
            offset: Src::Imm(imm?),
        },
        0xF7 if v == 32 && matches!(reg, 4 | 5) => Form::MulWide { signed: reg == 5 },
        0xF7 if v == 32 && matches!(reg, 6 | 7) => Form::Div { signed: reg == 7 },
        0x0FC0 | 0x0FC1 => Form::Xadd {
            size: if op == 0x0FC0 { 8 } else { v },
            reg,
        },
        0x0FB0 | 0x0FB1 => Form::Cmpxchg {
            size: if op == 0x0FB0 { 8 } else { v },
            reg,
        },
        0xA0..=0xA3 => Form::Moffs {
            size: if op & 1 == 0 { 8 } else { v },
            store: op >= 0xA2,
            ea: EffectiveAddress {
                base: None,
                index: None,
                scale: 0,
                displacement: imm?,
                address_size: i.address_size,
                segment: p.segment.unwrap_or(DS),
            },
        },
        0xD8..=0xDF => match crate::ir::x87::io(op as u8, modrm) {
            // 8-byte operands are read as two words at ea and ea + 4.
            Some(Io::Load { bytes: 8 } | Io::Store { bytes: 8 }) if i.address_size == 16 => {
                return None
            },
            Some(io) => Form::X87 {
                opcode: op as u8,
                modrm,
                io,
            },
            None if op == 0xDF && modrm == 0xE0 => Form::Fnstsw,
            // FUCOMI(P)/FCOMI(P) write ZF/PF/CF; FCMOVcc reads FLAGS.
            None if modrm >= 0xC0 && matches!((op, reg), (0xDB | 0xDF, 5 | 6)) => Form::X87Flags {
                name: match (op, reg) {
                    (0xDB, 5) => "fpu_fucomi",
                    (0xDB, _) => "fpu_fcomi",
                    (_, 5) => "fpu_fucomip",
                    _ => "fpu_fcomip",
                },
                r: modrm & 7,
            },
            None if modrm >= 0xC0 && matches!(op, 0xDA | 0xDB) && reg <= 3 => Form::Fcmov {
                cc: [2, 4, 6, 10][reg as usize] | (op == 0xDB) as u8,
                r: modrm & 7,
            },
            None => return None,
        },
        0x0FAF if v == 32 => Form::Imul {
            reg,
            immediate: None,
        },
        0x69 | 0x6B if v == 32 => Form::Imul {
            reg,
            immediate: Some(imm?),
        },
        0x50..=0x57 if v == 32 => Form::Push {
            src: Src::Reg((op & 7) as u8),
        },
        0x68 | 0x6A if v == 32 => Form::Push {
            src: Src::Imm(imm?),
        },
        0xFF if reg == 6 && v == 32 => Form::Push { src: Src::Rm },
        0x58..=0x5F if v == 32 => Form::Pop {
            reg: (op & 7) as u8,
        },
        0x91..=0x97 if v == 32 => Form::Xchg {
            a: 0,
            b: (op & 7) as u8,
        },
        0x87 if v == 32 && i.ea.is_none() => Form::Xchg {
            a: reg,
            b: modrm & 7,
        },
        0x99 if v == 32 => Form::Cdq,
        0x98 if v == 32 => Form::Cwde,
        0x90 => Form::Nop,
        0x9F => Form::Lahf,
        0xC9 if v == 32 => Form::Leave,
        0x0F90..=0x0F9F => Form::Setcc {
            cc: (op & 15) as u8,
        },
        0x0F40..=0x0F4F if v == 32 => Form::Cmov {
            cc: (op & 15) as u8,
            reg,
        },
        0xEB | 0xE9 => Form::Jmp {
            target: relative_target(i)?,
        },
        0x70..=0x7F | 0x0F80..=0x0F8F => Form::Jcc {
            cc: (op & 15) as u8,
            target: relative_target(i)?,
        },
        0xE3 if features & T0_JECXZ != 0 => Form::Jecxz {
            target: relative_target(i)?,
            cx: i.address_size == 16,
        },
        // (ModRM.reg above GS is #UD)
        0x8C if features & T0_SREG_READ != 0 && reg <= 5 => Form::MovFromSreg {
            seg: reg,
            size: if i.ea.is_some() { 16 } else { v },
        },
        0x06 | 0x0E | 0x16 | 0x1E | 0x0FA0 | 0x0FA8 if features & T0_SREG_READ != 0 && v == 32 => {
            Form::PushSreg {
                seg: match op {
                    0x06 => 0,
                    0x0E => 1,
                    0x16 => 2,
                    0x1E => 3,
                    0x0FA0 => 4,
                    _ => 5,
                },
            }
        },
        0x86 | 0x87 if features & T0_XCHG_MEM != 0 && i.ea.is_some() => Form::XchgMem {
            size: if op == 0x86 { 8 } else { v },
            reg,
        },
        0xFC | 0xFD if features & T0_CLD_STD != 0 => Form::Direction { set: op == 0xFD },
        0x8F if features & T0_POP_RM != 0
            && reg == 0
            && v == 32
            && i.ea.as_ref().is_some_and(|ea| {
                ea.index != Some(4) && (ea.base != Some(4) || features & T0_POP_ESP != 0)
            }) =>
        {
            Form::PopRm {
                esp: i.ea.as_ref().is_some_and(|ea| ea.base == Some(4)),
            }
        },
        0xFA if features & T0_CLI != 0 => Form::Cli,
        0x8E if features & T0_SREG_LOAD != 0 && matches!(reg, 0 | 3 | 4 | 5) => {
            Form::MovToSreg { seg: reg }
        },
        0x60 if features & T0_PUSHA != 0 && v == 32 => Form::Pusha,
        0x61 if features & T0_PUSHA != 0 && v == 32 => Form::Popa,
        0xE8 => Form::Call {
            target: relative_target(i)?,
        },
        0xC3 if v == 32 => Form::Ret { pop: 0 },
        0xC2 if v == 32 => Form::Ret { pop: imm? as u16 },
        0xFF if reg == 4 && v == 32 => Form::JmpIndirect,
        0xFF if reg == 2 && v == 32 => Form::CallIndirect,
        _ => return None,
    })
}

struct Page {
    w: WasmBuilder,
    /// The first covered page. A function of one run of consecutive pages
    /// maps offsets to linear addresses by adding it; one of several runs
    /// (a cluster, see analysis::Slots) maps through `runs`, and leaves for
    /// a target outside with offset = span and the target in `far_eip`.
    page_linear: u32,
    slots: analysis::Slots,
    runs: Vec<(u32, usize, usize)>,
    far_eip: WasmLocal,
    eip: WasmLocal,
    cs_base: u32,
    gpr: Vec<WasmLocal>,
    tlb: WasmLocal,
    read_mask: WasmLocal,
    write_mask: WasmLocal,
    offset: WasmLocal,
    result: WasmLocal,
    fa: WasmLocal,
    fb: WasmLocal,
    fr: WasmLocal,
    addr: WasmLocal,
    host: WasmLocal,
    value: WasmLocal,
    tmp: WasmLocal,
    wide: WasmLocalI64,
    quotient: WasmLocalI64,
    dispatch: Label,
    /// Retired instructions of this activation (its work budget, like the
    /// legacy JIT's LOOP_COUNTER), of which `committed` have been added to
    /// instruction_counter (only dispatch-level accounting reads it: exits,
    /// interpreter steps and chaining).
    retired: WasmLocal,
    committed: WasmLocal,
    /// Retired instructions of this block not yet added to `retired`.
    pending: u32,
    known: Known,
    block_at: Vec<Option<u32>>,
    /// Page offset of each block.
    starts: Vec<u16>,
    /// Bytes covered (slots.span()).
    span: u32,
    /// Host address of each covered page when compiled (mem8 + physical):
    /// entering another page checks its current translation against it.
    hosts: Vec<u32>,
    /// What else the bytes depend on (tier0::CompileEnv)
    env: CompileEnv,
    /// Page index of the block being emitted.
    current_page: u32,
    /// Enclosing layout levels, innermost last (see emit_units).
    levels: Vec<Level>,
    /// Leaves the function with EIP = page base + offset (see emit_page).
    exit: Label,
    /// Interprets the instruction at `offset`, then dispatches.
    step: Label,
    /// Retired instructions before, and page offset of, the instruction
    /// being emitted (for retry()).
    context: (u32, u16),
    /// The current instruction's retry target (see instruction()).
    retry_label: Option<Label>,
    flags: PendingFlags,
    p_op1: WasmLocal,
    p_result: WasmLocal,
    p_word: WasmLocal,
    /// GPRs any template writes: sync_out stores of the others (recorded in
    /// sync_stores) become nops once the function is complete, as locals of
    /// unwritten GPRs always equal the CPU state.
    gpr_written: u8,
    sync_stores: Vec<(usize, usize, u8)>,
    /// XMM registers cached in locals within the block; `xmm_dirty` ones are
    /// newer than the CPU state (written at block ends and before any
    /// interpreter step, see xmm_store).
    xmm: [Option<WasmLocalV128>; 8],
    xmm_dirty: u8,
    /// native_fp::mxcsr_refused, once evaluated in the block: MXCSR changes
    /// only in interpreter steps, which leave the block, and ir_t0_sse_fp,
    /// which sets flags it ignores
    fp_mxcsr: Option<WasmLocal>,
    /// Per XMM register, the floating-point lanes known to be neither NaN nor
    /// denormal in the block (x86tpl::vec::CLEAN_*; see native_fp)
    xmm_clean: [u8; 8],
    /// The SIMD task checks the block has made (simd::simd_guard): 1 those of
    /// MMX forms, 2 also those of XMM forms, 4 those of VEX forms
    /// (simd::vex_guard). CR0 and CR4 change only in interpreter steps,
    /// which leave the block.
    simd_checked: u8,
    /// Nonzero when VEX forms fault (simd::vex_fault, computed on entry; a
    /// page without VEX templates has none)
    vex_fault: Option<WasmLocal>,
    /// The YMM registers whose bits 255:128 the block has zeroed (simd::
    /// ymm_zero) and not written since (simd::store_ymm, a VEX.256 move's;
    /// the other 256-bit forms are interpreter steps, which leave the block)
    ymm_zeroed: u8,
    /// The VEX form being emitted (simd::Page::simd)
    vex: Option<simd::Vex>,
    /// x87 TOP/tags/VALID/DIRTY in function-wide locals while `x87_is_open`
    /// (then the CPU state is behind; see x87_open/x87_close).
    x87: X87Cache,
    x87_is_open: WasmLocal,
    /// The emitted code has opened the cache on every path to here.
    x87_known_open: bool,
    /// Compiled for flat segmentation and a 32-bit stack (checked on entry).
    flat: bool,
}

/// Operand words of an inlined x87 form in two locals (inputs and outputs),
/// with the block's cached x87 bookkeeping.
struct X87Locals<'a> {
    w: &'a mut WasmBuilder,
    words: [&'a WasmLocal; 2],
    cache: Option<X87Cache>,
}
impl X87Words for X87Locals<'_> {
    fn w(&mut self) -> &mut WasmBuilder { self.w }
    fn input(&mut self, k: usize) { self.w.get_local(self.words[k]) }
    fn output(&mut self, k: usize) { self.w.set_local(self.words[k]) }
    fn cache(&mut self) -> Option<X87Cache> { self.cache.as_ref().map(X87Cache::unsafe_clone) }
}

/// Lazy-FLAGS stores of this block's last producers not yet written to memory
/// (see Page::materialize): last_op1 from p_op1, last_result from p_result,
/// last_op_size/flags_changed constants, and FLAGS bits `clear` replaced by
/// p_word's bits in `set` (the others by 0). Bits of a pending flags_changed
/// are computed lazily, so their FLAGS bits are dead (each producer that
/// removes a bit from flags_changed also writes that FLAGS bit): pruned.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct PendingFlags {
    op1: bool,
    result: bool,
    size_changed: Option<(i32, i32)>,
    clear: i32,
    set: i32,
}

/// One level of the structured layout: the page's dispatch loop or a loop
/// region (analysis::Unit::Loop).
struct Level {
    /// Continues this level's loop: dispatch on `offset`.
    repeat: Label,
    /// Unit of each block at this level (u32::MAX: not in this level).
    unit_of: Vec<u32>,
    labels: Vec<Label>,
    emitted: Vec<bool>,
    /// The block of a single-block unit.
    single: Vec<Option<u32>>,
}

fn mask(size: u8) -> i32 {
    match size {
        8 => 0xFF,
        16 => 0xFFFF,
        _ => -1,
    }
}
fn sign(size: u8) -> i32 { 1i32 << (size - 1) }
fn tlb_read_mask(user: bool) -> i32 {
    0xFFF
        & !TLB_READONLY
        & !TLB_GLOBAL
        & !TLB_HAS_CODE
        & !TLB_IA32E_DATA
        & if user { !0 } else { !TLB_NO_USER }
}
fn tlb_write_mask(user: bool) -> i32 {
    0xFFF & !TLB_GLOBAL & !TLB_IA32E_DATA & if user { !0 } else { !TLB_NO_USER }
}

impl Page {
    fn store_fixed(&mut self, address: u32, value: &WasmLocal) {
        self.w.const_i32(address as i32);
        self.w.get_local(value);
        self.w.store_aligned_i32(0);
    }
    fn store_fixed_const(&mut self, address: u32, value: i32) {
        self.w.const_i32(address as i32);
        self.w.const_i32(value);
        self.w.store_aligned_i32(0);
    }
    /// Write the GPRs back (only those the function writes survive: see
    /// Page::gpr_written).
    fn sync_out(&mut self) {
        for r in 0..8 {
            let start = self.w.body_len();
            self.w.const_i32(gp::reg32 as i32 + 4 * r);
            self.w.get_local(&self.gpr[r as usize]);
            self.w.store_aligned_i32(0);
            self.sync_stores.push((start, self.w.body_len(), r as u8));
        }
    }
    /// A GPR write (the value on the stack).
    fn set_gpr(&mut self, r: usize) {
        self.gpr_written |= 1 << r;
        self.w.set_local(&self.gpr[r]);
    }
    /// The CPU's exit request (see runtime::entry), stored directly when
    /// the generated code runs in this instance.
    fn request_exit(&mut self, kind: ExitKind) {
        match self.env.exit_kind {
            Some(address) => {
                self.w.const_i32(address as i32);
                self.w.const_i32(kind as i32);
                self.w.store_u8(0);
            },
            None => {
                let name =
                    if kind == ExitKind::Poll { "ir_request_poll_exit" } else { "ir_request_link" };
                self.w.call_signature(name, signature(name));
            },
        }
    }
    fn sync_in(&mut self) {
        for r in 0..8 {
            self.w.load_fixed_i32(gp::reg32 as u32 + 4 * r);
            self.w.set_local(&self.gpr[r as usize]);
        }
    }
    fn add_count(&mut self, n: u32) {
        if n != 0 {
            self.w.get_local(&self.retired);
            self.w.const_i32(n as i32);
            self.w.add_i32();
            self.w.set_local(&self.retired);
        }
    }
    fn commit_count(&mut self) {
        self.w.const_i32(gp::instruction_counter as i32);
        self.w.load_fixed_i32(gp::instruction_counter as u32);
        self.w.get_local(&self.retired);
        self.w.get_local(&self.committed);
        self.w.sub_i32();
        self.w.add_i32();
        self.w.store_aligned_i32(0);
        self.w.get_local(&self.retired);
        self.w.set_local(&self.committed);
    }
    fn flush(&mut self) {
        let n = std::mem::replace(&mut self.pending, 0);
        self.add_count(n);
    }
    /// Branch to the dispatch loop at a constant page offset (possibly outside
    /// the page, which exits there).
    fn goto_linear(&mut self, linear: u32) {
        self.leave_block();
        let offset = match self.slots.offset(linear) {
            Some(offset) => offset as u32,
            None if self.runs.len() > 1 => {
                self.w.const_i32(linear as i32);
                self.w.set_local(&self.far_eip);
                self.span
            },
            None => linear.wrapping_sub(self.page_linear),
        };
        if offset < self.span && offset >> 12 != self.current_page {
            self.check_page(offset);
        }
        let target = self.block_at.get(offset as usize).copied().flatten();
        // The innermost level holding the target: a unit not yet emitted is
        // an enclosing label (forward, bounded work); otherwise re-enter that
        // level's loop, which dispatches on `offset` (a header directly).
        let mut label = self.dispatch;
        let mut direct = false;
        if let Some(t) = target {
            for level in self.levels.iter().rev() {
                let u = level.unit_of[t as usize];
                if u == u32::MAX {
                    continue;
                }
                let u = u as usize;
                if level.emitted[u] {
                    label = level.repeat;
                }
                else {
                    label = level.labels[u];
                    direct = level.single[u] == Some(t);
                }
                break;
            }
        }
        if !direct {
            self.w.const_i32(offset as i32);
            self.w.set_local(&self.offset);
        }
        self.w.br(label);
    }
    /// Leave for `offset` (static, in another covered page) unless that page
    /// still translates to the compiled code (the interpreter's TLB view).
    fn check_page(&mut self, offset: u32) {
        let page = offset >> 12;
        let linear = self.slots.pages[page as usize];
        self.w.get_local(&self.tlb);
        self.w.load_aligned_i32((linear >> 12) * 4);
        self.page_mismatch(linear as i32, self.hosts[page as usize] as i32);
        self.w.hint(false);
        self.w.if_void();
        self.w.const_i32(offset as i32);
        self.w.set_local(&self.offset);
        self.w.br(self.exit);
        self.w.block_end();
    }
    /// At the start of a block whose bytes run into page `page` of a
    /// multi-page function: interpret its first instruction (the step block,
    /// which always progresses) unless that page still translates to the
    /// compiled code.
    fn check_block_page(&mut self, page: u32, start: u32) {
        let linear = self.slots.pages[page as usize];
        self.w.get_local(&self.tlb);
        self.w.load_aligned_i32((linear >> 12) * 4);
        self.page_mismatch(linear as i32, self.hosts[page as usize] as i32);
        self.w.hint(false);
        self.w.if_void();
        self.w.const_i32(start as i32);
        self.w.set_local(&self.offset);
        self.w.br(self.step);
        self.w.block_end();
    }
    /// Push nonzero unless the TLB entry on the stack maps `linear` (a page
    /// base) readable to `host`.
    fn page_mismatch(&mut self, linear: i32, host: i32) {
        self.w.tee_local(&self.tmp);
        self.w.get_local(&self.read_mask);
        self.w.and_i32();
        self.w.const_i32(TLB_VALID);
        self.w.ne_i32();
        self.w.get_local(&self.tmp);
        self.w.const_i32(!0xFFF);
        self.w.and_i32();
        self.w.const_i32(linear);
        self.w.xor_i32();
        self.w.const_i32(host);
        self.w.ne_i32();
        self.w.or_i32();
    }
    /// check_page for the runtime `offset` of a multi-page function (offsets
    /// outside it leave through the dispatcher's range check).
    fn check_offset_page(&mut self) {
        if self.span <= 4096 {
            return;
        }
        self.w.get_local(&self.offset);
        self.w.const_i32(self.span as i32);
        self.w.ltu_i32();
        self.w.if_void();
        for page in 0..self.span >> 12 {
            let linear = self.slots.pages[page as usize];
            self.w.get_local(&self.offset);
            self.w.const_i32(12);
            self.w.shr_u_i32();
            self.w.const_i32(page as i32);
            self.w.eq_i32();
            self.w.if_void();
            self.w.get_local(&self.tlb);
            self.w.load_aligned_i32((linear >> 12) * 4);
            self.page_mismatch(linear as i32, self.hosts[page as usize] as i32);
            self.w.br_if(self.exit);
            self.w.block_end();
        }
        self.w.block_end();
    }
    /// offset <- the function offset of the linear address on the stack
    /// (outside: >= span, and far_eip <- it in a function of several runs).
    fn set_offset_from_linear(&mut self) {
        offset_from_linear(
            &mut self.w,
            &self.runs,
            self.page_linear,
            self.span,
            [&self.offset, &self.far_eip, &self.eip],
        );
    }
    /// Push the linear address the function leaves for: that of `offset`,
    /// or far_eip for a target outside a function of several runs.
    fn push_exit_eip(&mut self) {
        if self.runs.len() == 1 {
            self.w.get_local(&self.offset);
            self.w.const_i32(self.page_linear as i32);
            self.w.add_i32();
            return;
        }
        self.w.get_local(&self.far_eip);
        self.w.set_local(&self.eip);
        for (linear, start, bytes) in self.runs.clone() {
            self.w.get_local(&self.offset);
            self.w.const_i32(start as i32);
            self.w.sub_i32();
            self.w.const_i32(bytes as i32);
            self.w.ltu_i32();
            self.w.if_void();
            self.w.get_local(&self.offset);
            self.w.const_i32(linear.wrapping_sub(start as u32) as i32);
            self.w.add_i32();
            self.w.set_local(&self.eip);
            self.w.block_end();
        }
        self.w.get_local(&self.eip);
    }
    /// Bound the work of one activation so interrupts and timers are serviced
    /// (at every loop head; `offset` is the block about to run).
    fn poll_check(&mut self) {
        self.w.get_local(&self.retired);
        self.w.const_i32(gp::slice_budget as i32);
        self.w.load_aligned_i32(0);
        self.w.geu_i32();
        self.w.hint(false);
        self.w.if_void();
        self.sync_out();
        self.x87_close();
        self.commit_count();
        self.w.const_i32(gp::instruction_pointer as i32);
        self.push_exit_eip();
        self.w.store_aligned_i32(0);
        self.request_exit(ExitKind::Poll);
        self.w.const_i32(0);
        self.w.return_();
        self.w.block_end();
    }
    /// Dispatch to the CS-relative EIP on the stack: first within the
    /// innermost loop (returns mostly land nearby), whose table defers other
    /// offsets to the enclosing level.
    fn goto_dynamic(&mut self) { self.goto_dynamic_at(true) }
    /// goto_dynamic; `nearby`: dispatch within the innermost loop first
    /// (returns, jump tables), else at the page level (called functions).
    fn goto_dynamic_at(&mut self, nearby: bool) {
        self.leave_block();
        self.w.const_i32(self.cs_base as i32);
        self.w.add_i32();
        self.set_offset_from_linear();
        self.check_offset_page();
        let label = if nearby {
            self.levels
                .last()
                .map_or(self.dispatch, |level| level.repeat)
        }
        else {
            self.dispatch
        };
        self.w.br(label);
    }

    /// Interpret the instruction (analysis ends its block, so execution
    /// continues at a block start through the dispatch loop).
    fn fallback(&mut self, i: &Instruction) {
        crate::ir::runtime::tier0::note_template(FORM_NAMES.len(), 0);
        self.context = (self.pending, i.offset);
        self.retry();
    }

    fn read_reg(&mut self, r: u8, size: u8) {
        match size {
            32 => self.w.get_local(&self.gpr[r as usize]),
            16 => {
                self.w.get_local(&self.gpr[r as usize]);
                self.w.const_i32(0xFFFF);
                self.w.and_i32();
            },
            _ => {
                self.w.get_local(&self.gpr[(r & 3) as usize]);
                if r >= 4 {
                    self.w.const_i32(8);
                    self.w.shr_u_i32();
                }
                self.w.const_i32(0xFF);
                self.w.and_i32();
            },
        }
    }
    /// Write the value on the stack to a register of `size`.
    fn write_reg(&mut self, r: u8, size: u8) {
        if size == 32 {
            self.set_gpr(r as usize);
            return;
        }
        self.w.set_local(&self.tmp);
        let (register, keep, shift) = match size {
            16 => (r, !0xFFFF, 0),
            _ if r < 4 => (r, !0xFF, 0),
            _ => (r & 3, !0xFF00, 8),
        };
        self.w.get_local(&self.gpr[register as usize]);
        self.w.const_i32(keep);
        self.w.and_i32();
        self.w.get_local(&self.tmp);
        self.w.const_i32(mask(size));
        self.w.and_i32();
        if shift != 0 {
            self.w.const_i32(shift);
            self.w.shl_i32();
        }
        self.w.or_i32();
        self.set_gpr(register as usize);
    }
    /// Run the current instruction in the interpreter instead (which delivers
    /// any fault with the GPRs written back), through the page's shared step
    /// block. Nothing of the instruction has been committed.
    fn retry(&mut self) {
        if let Some(label) = self.retry_label {
            self.w.br(label);
            return;
        }
        // The interpreter continues from the FLAGS and XMM registers before
        // this instruction.
        let flags = self.flags;
        self.emit_flags(flags);
        self.xmm_store(self.xmm_dirty);
        let (pending, offset) = self.context;
        self.add_count(pending);
        self.w.const_i32(offset as i32);
        self.w.set_local(&self.offset);
        self.w.br(self.step);
    }
    /// BMI1 and BMI2's VEX forms: C4 is LES in real and virtual-8086 mode,
    /// whose #UD belongs to the interpreter; checked once per block
    /// (simd_checked bit 3)
    fn vex_mode_guard(&mut self) {
        if self.simd_checked & 8 != 0 {
            return;
        }
        self.w.load_fixed_u8(gp::protected_mode as u32);
        self.w.eqz_i32();
        self.w.load_fixed_i32(gp::flags as u32);
        self.w.const_i32(FLAG_VM);
        self.w.and_i32();
        self.w.or_i32();
        self.retry_if();
        self.simd_checked |= 8;
    }
    /// Reverse the bytes of the i32 on the stack (MOVBE)
    fn byte_swap(&mut self) {
        self.w.set_local(&self.tmp);
        // rotl(x & 0x00FF00FF, 24) | rotl(x & 0xFF00FF00, 8)
        self.w.get_local(&self.tmp);
        self.w.const_i32(0x00FF_00FF);
        self.w.and_i32();
        self.w.const_i32(24);
        self.w.rotl_i32();
        self.w.get_local(&self.tmp);
        self.w.const_i32(0xFF00_FF00u32 as i32);
        self.w.and_i32();
        self.w.const_i32(8);
        self.w.rotl_i32();
        self.w.or_i32();
    }
    /// Form::Bmi but the shifts, of the source in fa: the result (fr) to
    /// `reg`, and cpu::bmi::logic_flags: SF, ZF and PF of the result
    /// (lazily), AF and OF clear, and CF: ANDN 0 (a logic producer); the
    /// source is not 0 (BLSI); the index is beyond 31 (BZHI); the source
    /// is 0 (the others)
    fn bmi(&mut self, op: BmiOp, reg: u8, vvvv: u8) {
        let (fa, fb, fr) = (
            self.fa.unsafe_clone(),
            self.fb.unsafe_clone(),
            self.fr.unsafe_clone(),
        );
        match op {
            BmiOp::Andn => {
                self.read_reg(vvvv, 32);
                self.w.const_i32(-1);
                self.w.xor_i32();
                self.w.get_local(&fa);
                self.w.and_i32();
            },
            BmiOp::Blsr | BmiOp::Blsmsk => {
                self.w.get_local(&fa);
                self.w.const_i32(1);
                self.w.sub_i32();
                self.w.get_local(&fa);
                if op == BmiOp::Blsr {
                    self.w.and_i32();
                }
                else {
                    self.w.xor_i32();
                }
            },
            BmiOp::Blsi => {
                self.w.const_i32(0);
                self.w.get_local(&fa);
                self.w.sub_i32();
                self.w.get_local(&fa);
                self.w.and_i32();
            },
            BmiOp::Bzhi => {
                // fa AND (1 << n) - 1 for an index n (VEX.vvvv[7:0]) below
                // 32, else fa
                self.read_reg(vvvv, 32);
                self.w.const_i32(0xFF);
                self.w.and_i32();
                self.w.set_local(&fb);
                self.w.get_local(&fa);
                self.w.const_i32(1);
                self.w.get_local(&fb);
                self.w.shl_i32();
                self.w.const_i32(1);
                self.w.sub_i32();
                self.w.and_i32();
                self.w.get_local(&fa);
                self.w.get_local(&fb);
                self.w.const_i32(32);
                self.w.ltu_i32();
                self.w.select();
            },
            // (Wasm's count of 0 is 32, as theirs)
            BmiOp::Tzcnt => {
                self.w.get_local(&fa);
                self.w.ctz_i32();
            },
            _ => {
                self.w.get_local(&fa);
                self.w.clz_i32();
            },
        }
        self.w.set_local(&fr);
        self.w.get_local(&fr);
        self.write_reg(reg, 32);
        self.flags_logic(32);
        if op != BmiOp::Andn {
            match op {
                BmiOp::Blsi => {
                    self.w.get_local(&fa);
                    self.w.const_i32(0);
                    self.w.ne_i32();
                },
                BmiOp::Bzhi => {
                    self.w.get_local(&fb);
                    self.w.const_i32(31);
                    self.w.gtu_i32();
                },
                _ => {
                    self.w.get_local(&fa);
                    self.w.eqz_i32();
                },
            }
            self.pend_word(FLAG_CARRY);
            self.known = Known::None;
        }
    }
    /// retry() if the condition on the stack is nonzero.
    fn retry_if(&mut self) {
        self.w.hint(false);
        if let Some(label) = self.retry_label {
            self.w.br_if(label);
            return;
        }
        self.w.if_void();
        self.retry();
        self.w.block_end();
    }
    /// addr <- linear address of the memory operand (retry on a null segment).
    fn linear(&mut self, ea: &EffectiveAddress) {
        // Flat: CS, SS and DS have base 0 and are not null.
        let flat = self.flat && matches!(ea.segment, CS | SS | DS);
        if !flat {
            self.segment_check(ea.segment);
        }
        self.w.const_i32(ea.displacement as i32);
        if let Some(base) = ea.base {
            self.w.get_local(&self.gpr[base as usize]);
            self.w.add_i32();
        }
        if let Some(index) = ea.index {
            self.w.get_local(&self.gpr[index as usize]);
            if ea.scale != 0 {
                self.w.const_i32(ea.scale as i32);
                self.w.shl_i32();
            }
            self.w.add_i32();
        }
        if ea.address_size == 16 {
            self.w.const_i32(0xFFFF);
            self.w.and_i32();
        }
        if !flat {
            self.w.load_fixed_i32(gp::get_seg_offset(ea.segment as u32));
            self.w.add_i32();
        }
        self.w.set_local(&self.addr);
    }
    fn segment_check(&mut self, segment: u8) {
        self.w
            .load_fixed_u8(gp::get_segment_is_null_offset(segment as u32));
        self.retry_if();
    }
    /// Push nonzero unless one ordinary RAM page grants the access at addr
    /// (stores: writable, no code, no MMIO); leaves the TLB entry in host.
    fn tlb_miss(&mut self, bytes: u32, write: bool) {
        self.w.get_local(&self.tlb);
        self.w.get_local(&self.addr);
        self.w.const_i32(12);
        self.w.shr_u_i32();
        self.w.const_i32(2);
        self.w.shl_i32();
        self.w.add_i32();
        self.w.load_aligned_i32(0);
        self.w.tee_local(&self.host);
        self.w
            .get_local(if write { &self.write_mask } else { &self.read_mask });
        self.w.and_i32();
        self.w.const_i32(TLB_VALID);
        self.w.ne_i32();
        if bytes > 1 {
            self.w.get_local(&self.addr);
            self.w.const_i32(0xFFF);
            self.w.and_i32();
            self.w.const_i32(0x1000 - bytes as i32);
            self.w.gtu_i32();
            self.w.or_i32();
            if WasmBuilder::ATOMIC_GUEST_MEMORY {
                // atomic accesses need natural alignment (16 bytes: 8-byte halves)
                self.w.get_local(&self.addr);
                self.w.const_i32(bytes.min(8) as i32 - 1);
                self.w.and_i32();
                self.w.or_i32();
            }
        }
    }
    fn host_address(&mut self) {
        self.w.get_local(&self.host);
        self.w.const_i32(!0xFFF);
        self.w.and_i32();
        self.w.get_local(&self.addr);
        self.w.xor_i32();
    }
    /// Push the value of `size` at addr. `write` also requires write
    /// permission (read-modify-write).
    fn read_mem(&mut self, size: u8, write: bool) {
        let bytes = size as u32 / 8;
        self.tlb_miss(bytes, write);
        self.w.hint(false);
        self.w.if_i32();
        self.w.get_local(&self.addr);
        self.w.const_i32(bytes as i32);
        self.w.const_i32(write as i32);
        self.w
            .call_signature("ir_t0_read_slow", signature("ir_t0_read_slow"));
        self.w.set_local_i64(&self.wide);
        self.w.get_local_i64(&self.wide);
        self.w.const_i64(32);
        self.w.shr_u_i64();
        self.w.wrap_i64_to_i32();
        self.retry_if();
        self.w.get_local_i64(&self.wide);
        self.w.wrap_i64_to_i32();
        self.w.else_();
        self.host_address();
        match size {
            8 => self.w.guest_load_u8(0),
            16 => self.w.guest_load_u16(0),
            _ => self.w.guest_load_i32(0),
        }
        self.w.block_end();
    }
    /// Store `value` of `size` at addr. Off the fast path, ir_t0_write_slow
    /// stores it (MMIO with interrupt delivery held), or the instruction is
    /// retried in the interpreter: the store would fault, or IR code lies on
    /// a page it writes.
    fn write_mem(&mut self, size: u8, value: &WasmLocal) {
        let bytes = size as u32 / 8;
        self.tlb_miss(bytes, true);
        self.w.hint(false);
        self.w.if_void();
        self.w.get_local(&self.addr);
        self.w.get_local(value);
        self.w.const_i32(bytes as i32);
        self.w
            .call_signature("ir_t0_write_slow", signature("ir_t0_write_slow"));
        self.retry_if();
        self.w.else_();
        self.host_address();
        self.w.get_local(value);
        match size {
            8 => self.w.guest_store_u8(0),
            16 => self.w.guest_store_u16(0),
            _ => self.w.guest_store_i32(0),
        }
        self.w.block_end();
    }
    /// Push the r/m operand of `i`. For memory, `write` also requires write
    /// permission for a later write_rm.
    fn read_rm(&mut self, i: &DecodedInstruction, size: u8, write: bool) {
        match &i.ea {
            None => self.read_reg(i.modrm.unwrap() & 7, size),
            Some(ea) => {
                self.linear(ea);
                self.read_mem(size, write);
            },
        }
    }
    /// Store `value` to the r/m operand (address from read_rm or prepare_rm).
    fn write_rm(&mut self, i: &DecodedInstruction, size: u8, value: &WasmLocal) {
        match &i.ea {
            None => {
                self.w.get_local(value);
                self.write_reg(i.modrm.unwrap() & 7, size);
            },
            Some(_) => self.write_mem(size, value),
        }
    }
    fn prepare_rm(&mut self, i: &DecodedInstruction) {
        if let Some(ea) = &i.ea {
            self.linear(ea);
        }
    }
    fn source(&mut self, i: &DecodedInstruction, src: Src, size: u8) {
        match src {
            Src::Reg(r) => self.read_reg(r, size),
            Src::Imm(v) => self.w.const_i32((v as i32) & mask(size)),
            Src::Rm => self.read_rm(i, size, false),
        }
    }

    // Lazy FLAGS, stored exactly as cpu::arith does.
    /// ADD/SUB-type lazy FLAGS: replaces every pending store (FLAGS bits are
    /// then all lazily computed, so a pending clear is moot).
    fn flags_arith(&mut self, size: u8, sub: bool) {
        self.w.get_local(&self.fa);
        self.w.set_local(&self.p_op1);
        self.w.get_local(&self.fr);
        self.w.set_local(&self.p_result);
        self.flags = PendingFlags {
            op1: true,
            result: true,
            size_changed: Some((size as i32 - 1, FLAGS_ALL | if sub { FLAG_SUB } else { 0 })),
            clear: 0,
            set: 0,
        };
        self.known = if sub { Known::Sub(size) } else { Known::Add(size) };
    }
    /// AND/OR/XOR/TEST: last_op1 keeps its (possibly pending) value.
    fn flags_logic(&mut self, size: u8) {
        self.w.get_local(&self.fr);
        self.w.set_local(&self.p_result);
        let bits = FLAG_CARRY | FLAG_OVERFLOW | FLAG_ADJUST;
        self.flags = PendingFlags {
            op1: self.flags.op1,
            result: true,
            size_changed: Some((size as i32 - 1, FLAGS_ALL & !bits)),
            clear: self.flags.clear | bits,
            set: self.flags.set & !bits,
        };
        self.prune_word();
        self.known = Known::Logic(size);
    }
    /// A producer's last_result (pending).
    fn pend_result(&mut self, local: &WasmLocal) {
        self.w.get_local(local);
        self.w.set_local(&self.p_result);
        self.flags.result = true;
    }
    fn pend_op1(&mut self, local: &WasmLocal) {
        self.w.get_local(local);
        self.w.set_local(&self.p_op1);
        self.flags.op1 = true;
    }
    /// A producer's last_op_size and flags_changed (pending constants).
    fn pend_size_changed(&mut self, size: u8, changed: i32) {
        self.flags.size_changed = Some((size as i32 - 1, changed));
        self.prune_word();
    }
    /// flags_changed &= keep: on the pending constant, else in memory.
    fn and_changed(&mut self, keep: i32) {
        match self.flags.size_changed {
            Some((size, changed)) => self.flags.size_changed = Some((size, changed & keep)),
            None => {
                self.w.const_i32(gp::flags_changed as i32);
                self.w.load_fixed_i32(gp::flags_changed as u32);
                self.w.const_i32(keep);
                self.w.and_i32();
                self.w.store_aligned_i32(0);
            },
        }
    }
    /// FLAGS bits `bits` become the value on the stack (only those bits).
    fn pend_word(&mut self, bits: i32) {
        if self.flags.set != 0 {
            self.w.get_local(&self.p_word);
            self.w.const_i32(!bits);
            self.w.and_i32();
            self.w.or_i32();
        }
        self.w.set_local(&self.p_word);
        self.flags.clear |= bits;
        self.flags.set |= bits;
    }
    fn prune_word(&mut self) {
        if let Some((_, changed)) = self.flags.size_changed {
            self.flags.clear &= !changed;
            self.flags.set &= !changed;
        }
    }
    fn push_op1(&mut self) {
        if self.flags.op1 {
            self.w.get_local(&self.p_op1)
        }
        else {
            self.w.load_fixed_i32(gp::last_op1 as u32)
        }
    }
    fn push_result(&mut self) {
        if self.flags.result {
            self.w.get_local(&self.p_result)
        }
        else {
            self.w.load_fixed_i32(gp::last_result as u32)
        }
    }
    /// FLAGS bit `flag` (not lazily computed) as 0/1: pending or in memory.
    fn word_bit(&mut self, flag: i32) {
        if self.flags.clear & flag != 0 {
            if self.flags.set & flag == 0 {
                self.w.const_i32(0);
                return;
            }
            self.w.get_local(&self.p_word);
        }
        else {
            self.w.load_fixed_i32(gp::flags as u32);
        }
        if flag != 1 {
            self.w.const_i32(flag.trailing_zeros() as i32);
            self.w.shr_u_i32();
        }
        self.w.const_i32(1);
        self.w.and_i32();
    }
    /// Write the pending lazy-FLAGS stores (the interpreter's state).
    fn materialize(&mut self) {
        let flags = std::mem::take(&mut self.flags);
        self.emit_flags(flags);
    }
    /// Write the cached XMM registers of `dirty` to the CPU state.
    fn xmm_store(&mut self, dirty: u8) {
        for r in 0..8u8 {
            if dirty & 1 << r != 0 {
                let local = self.xmm[r as usize].as_ref().unwrap().unsafe_clone();
                self.w.const_i32(gp::get_reg_xmm_offset(r as u32) as i32);
                self.w.get_local_v128(&local);
                self.w.simd_memory(0x0B, 0);
            }
        }
    }
    /// Leaving the block: CPU-state FLAGS and XMM registers.
    fn leave_block(&mut self) {
        self.materialize();
        let dirty = std::mem::take(&mut self.xmm_dirty);
        self.xmm_store(dirty);
        self.xmm_reset();
    }
    /// Make the function's x87 cache hold the CPU's x87 bookkeeping: loaded
    /// unless the runtime flag says it is already open (from any block).
    fn x87_open(&mut self) {
        if self.x87_known_open {
            return;
        }
        let c = self.x87.unsafe_clone();
        let [_, valid, dirty] = crate::cpu::fpu::x87_cache_addresses();
        self.w.get_local(&self.x87_is_open);
        self.w.eqz_i32();
        self.w.if_void();
        self.w.load_fixed_u8(gp::fpu_stack_ptr as u32);
        self.w.set_local(&c.top);
        self.w.load_fixed_u8(gp::fpu_stack_empty as u32);
        self.w.set_local(&c.tags);
        self.w.load_fixed_i32(valid);
        self.w.set_local(&c.valid);
        self.w.load_fixed_i32(dirty);
        self.w.set_local(&c.dirty);
        self.w.const_i32(1);
        self.w.set_local(&self.x87_is_open);
        self.w.block_end();
        self.x87_known_open = true;
    }
    /// Write an open x87 cache back to the CPU state and close it (before
    /// anything else reads that state, and at every exit of the function).
    fn x87_close(&mut self) {
        let c = self.x87.unsafe_clone();
        let [_, valid, dirty] = crate::cpu::fpu::x87_cache_addresses();
        self.w.get_local(&self.x87_is_open);
        self.w.if_void();
        for (address, local, byte) in [
            (gp::fpu_stack_ptr as u32, &c.top, true),
            (gp::fpu_stack_empty as u32, &c.tags, true),
            (valid, &c.valid, false),
            (dirty, &c.dirty, false),
        ] {
            self.w.const_i32(address as i32);
            self.w.get_local(local);
            if byte {
                self.w.store_u8(0)
            }
            else {
                self.w.store_aligned_i32(0)
            }
        }
        self.w.const_i32(0);
        self.w.set_local(&self.x87_is_open);
        self.w.block_end();
        self.x87_known_open = false;
    }
    /// Drop the XMM cache (at a block start every way in has stored it).
    fn xmm_reset(&mut self) {
        self.xmm_dirty = 0;
        for local in self.xmm.iter_mut().filter_map(Option::take) {
            self.w.free_local_v128(local);
        }
        if let Some(local) = self.fp_mxcsr.take() {
            self.w.free_local(local);
        }
        self.xmm_clean = [0; 8];
        self.simd_checked = 0;
        self.ymm_zeroed = 0;
    }
    fn emit_flags(&mut self, flags: PendingFlags) {
        if flags.op1 {
            let op1 = self.p_op1.unsafe_clone();
            self.store_fixed(gp::last_op1 as u32, &op1);
        }
        if flags.result {
            let result = self.p_result.unsafe_clone();
            self.store_fixed(gp::last_result as u32, &result);
        }
        if let Some((size, changed)) = flags.size_changed {
            self.store_size_changed(size, changed);
        }
        if flags.clear != 0 {
            self.w.const_i32(gp::flags as i32);
            self.w.load_fixed_i32(gp::flags as u32);
            self.w.const_i32(!flags.clear);
            self.w.and_i32();
            if flags.set != 0 {
                self.w.get_local(&self.p_word);
                self.w.const_i32(flags.set);
                self.w.and_i32();
                self.w.or_i32();
            }
            self.w.store_aligned_i32(0);
        }
    }
    /// last_op_size and flags_changed (adjacent) in one store.
    fn store_size_changed(&mut self, size: i32, changed: i32) {
        self.w.const_i32(gp::last_op_size as i32);
        self.w
            .const_i64((changed as u32 as i64) << 32 | size as u32 as i64);
        self.w.store_aligned_i64(0);
    }
    /// cpu::misc_instr::getcf over the lazy state (pending or in memory).
    fn lazy_carry(&mut self) {
        if let Some((_, changed)) = self.flags.size_changed {
            if changed & FLAG_CARRY == 0 {
                self.word_bit(FLAG_CARRY);
                return;
            }
            let sub = changed >> 31;
            self.push_result();
            if sub != 0 {
                self.w.const_i32(sub);
                self.w.xor_i32();
            }
            self.push_op1();
            if sub != 0 {
                self.w.const_i32(sub);
                self.w.xor_i32();
            }
            self.w.ltu_i32();
            return;
        }
        self.materialize();
        self.w.load_fixed_i32(gp::flags_changed as u32);
        self.w.const_i32(1);
        self.w.and_i32();
        self.w.if_i32();
        for field in [gp::last_result as u32, gp::last_op1 as u32] {
            self.w.load_fixed_i32(field);
            self.w.load_fixed_i32(gp::flags_changed as u32);
            self.w.const_i32(31);
            self.w.shr_s_i32();
            self.w.xor_i32();
        }
        self.w.ltu_i32();
        self.w.else_();
        self.w.load_fixed_i32(gp::flags as u32);
        self.w.const_i32(1);
        self.w.and_i32();
        self.w.block_end();
    }
    fn signed(&mut self, local: &WasmLocal, size: u8) {
        self.w.get_local(local);
        if size != 32 {
            self.w.const_i32(32 - size as i32);
            self.w.shl_i32();
            self.w.const_i32(32 - size as i32);
            self.w.shr_s_i32();
        }
    }
    fn bit(&mut self, local: &WasmLocal, size: u8) {
        self.w.get_local(local);
        self.w.const_i32(size as i32 - 1);
        self.w.shr_u_i32();
        self.w.const_i32(1);
        self.w.and_i32();
    }
    /// Push the (non-negated) condition cc & !1 from fa/fb/fr, if known.
    fn known_condition(&mut self, base: u8) -> bool {
        let (fa, fb, fr) = (
            self.fa.unsafe_clone(),
            self.fb.unsafe_clone(),
            self.fr.unsafe_clone(),
        );
        let zero = |p: &mut Page| {
            p.w.get_local(&fr);
            p.w.eqz_i32();
        };
        match (self.known, base) {
            (Known::None, _) | (_, 10) => return false,
            (Known::Sub(s), _) => match base {
                0 => {
                    self.w.get_local(&fa);
                    self.w.get_local(&fb);
                    self.w.xor_i32();
                    self.w.get_local(&fa);
                    self.w.get_local(&fr);
                    self.w.xor_i32();
                    self.w.and_i32();
                    self.w.set_local(&self.tmp);
                    let tmp = self.tmp.unsafe_clone();
                    self.bit(&tmp, s);
                },
                2 | 6 => {
                    self.w.get_local(&fa);
                    self.w.get_local(&fb);
                    if base == 2 {
                        self.w.ltu_i32()
                    }
                    else {
                        self.w.leu_i32()
                    }
                },
                4 => zero(self),
                8 => self.bit(&fr, s),
                12 | 14 => {
                    self.signed(&fa, s);
                    self.signed(&fb, s);
                    if base == 12 {
                        self.w.lt_i32()
                    }
                    else {
                        self.w.le_i32()
                    }
                },
                _ => unreachable!(),
            },
            (Known::Add(s), _) => match base {
                2 => {
                    self.w.get_local(&fr);
                    self.w.get_local(&fa);
                    self.w.ltu_i32();
                },
                4 => zero(self),
                8 => self.bit(&fr, s),
                _ => return false,
            },
            (Known::Logic(s), _) => match base {
                0 | 2 => self.w.const_i32(0),
                4 | 6 => zero(self),
                8 | 12 => self.bit(&fr, s),
                14 => {
                    zero(self);
                    self.bit(&fr, s);
                    self.w.or_i32();
                },
                _ => unreachable!(),
            },
            (Known::Inc(s) | Known::Dec(s), _) => match base {
                0 => {
                    self.w.get_local(&fr);
                    let overflow = if matches!(self.known, Known::Inc(_)) {
                        sign(s)
                    }
                    else {
                        sign(s).wrapping_sub(1) & mask(s)
                    };
                    self.w.const_i32(overflow);
                    self.w.eq_i32();
                },
                4 => zero(self),
                8 => self.bit(&fr, s),
                _ => return false,
            },
        }
        true
    }
    /// x87 forms fault (#NM) when CR0.EM or CR0.TS is set: the interpreter
    /// runs them then. (The condition of MMX forms, once per block: see
    /// simd_checked.)
    fn x87_guard(&mut self) {
        if self.simd_checked & 1 != 0 {
            return;
        }
        self.w.load_fixed_i32(gp::cr as u32);
        self.w
            .const_i32(crate::cpu::cpu::CR0_EM | crate::cpu::cpu::CR0_TS);
        self.w.and_i32();
        self.retry_if();
        self.simd_checked |= 1;
    }
    /// Push a shift count (already masked for immediates, CL & 31).
    fn count(&mut self, count: Count) {
        match count {
            Count::Imm(c) => self.w.const_i32(c as i32),
            Count::Cl => {
                self.read_reg(1, 8);
                self.w.const_i32(31);
                self.w.and_i32();
            },
        }
    }
    /// Push condition `cc` (0..15, Jcc order) as 0/1.
    fn condition(&mut self, cc: u8) {
        if !self.known_condition(cc & !1) && !self.lazy_condition(cc & !1) {
            self.materialize();
            self.w.const_i32(cc as i32);
            self.w.call_signature(
                "ir_t0_condition",
                Signature::new(&[WasmType::I32], &[WasmType::I32]),
            );
            return;
        }
        if cc & 1 != 0 {
            self.w.eqz_i32();
        }
    }
    /// Push the (non-negated) condition cc & !1 from the lazy FLAGS in
    /// memory, as cpu::misc_instr::test_* (PF is left to the helper).
    fn lazy_condition(&mut self, base: u8) -> bool {
        match base {
            0 => self.lazy_flag(FLAG_OVERFLOW),
            2 => self.lazy_carry(),
            4 => self.lazy_flag(FLAG_ZERO),
            6 => {
                self.lazy_carry();
                self.lazy_flag(FLAG_ZERO);
                self.w.or_i32();
            },
            8 => self.lazy_flag(FLAG_SIGN),
            12 | 14 => {
                self.lazy_flag(FLAG_SIGN);
                self.lazy_flag(FLAG_OVERFLOW);
                self.w.xor_i32();
                if base == 14 {
                    self.lazy_flag(FLAG_ZERO);
                    self.w.or_i32();
                }
            },
            _ => return false,
        }
        true
    }
    /// cpu::misc_instr::getzf/getsf/getof over the lazy state (pending or in
    /// memory).
    fn lazy_flag(&mut self, flag: i32) {
        if let Some((size, changed)) = self.flags.size_changed {
            if changed & flag == 0 {
                self.word_bit(flag);
                return;
            }
            match flag {
                FLAG_ZERO => {
                    self.push_result();
                    self.w.const_i32(-1);
                    self.w.xor_i32();
                    self.push_result();
                    self.w.const_i32(1);
                    self.w.sub_i32();
                    self.w.and_i32();
                },
                FLAG_SIGN => self.push_result(),
                _ => {
                    self.push_op1();
                    self.push_result();
                    self.w.xor_i32();
                    self.push_result();
                    self.push_op1();
                    self.w.sub_i32();
                    if changed < 0 {
                        self.w.const_i32(1);
                        self.w.sub_i32();
                    }
                    self.push_result();
                    self.w.xor_i32();
                    self.w.and_i32();
                },
            }
            self.w.const_i32(size);
            self.w.shr_u_i32();
            self.w.const_i32(1);
            self.w.and_i32();
            return;
        }
        self.materialize();
        self.w.load_fixed_i32(gp::flags_changed as u32);
        self.w.const_i32(flag);
        self.w.and_i32();
        self.w.if_i32();
        match flag {
            FLAG_ZERO => {
                // (!result & (result - 1)) >> size & 1
                self.w.load_fixed_i32(gp::last_result as u32);
                self.w.const_i32(-1);
                self.w.xor_i32();
                self.w.load_fixed_i32(gp::last_result as u32);
                self.w.const_i32(1);
                self.w.sub_i32();
                self.w.and_i32();
            },
            FLAG_SIGN => self.w.load_fixed_i32(gp::last_result as u32),
            _ => {
                // (op1 ^ result) & ((result - op1 - is_sub) ^ result)
                self.w.load_fixed_i32(gp::last_op1 as u32);
                self.w.load_fixed_i32(gp::last_result as u32);
                self.w.xor_i32();
                self.w.load_fixed_i32(gp::last_result as u32);
                self.w.load_fixed_i32(gp::last_op1 as u32);
                self.w.sub_i32();
                self.w.load_fixed_i32(gp::flags_changed as u32);
                self.w.const_i32(31);
                self.w.shr_u_i32();
                self.w.sub_i32();
                self.w.load_fixed_i32(gp::last_result as u32);
                self.w.xor_i32();
                self.w.and_i32();
            },
        }
        self.w.load_fixed_i32(gp::last_op_size as u32);
        self.w.shr_u_i32();
        self.w.const_i32(1);
        self.w.and_i32();
        self.w.else_();
        self.w.load_fixed_i32(gp::flags as u32);
        self.w.const_i32(flag.trailing_zeros() as i32);
        self.w.shr_u_i32();
        self.w.const_i32(1);
        self.w.and_i32();
        self.w.block_end();
    }

    /// addr <- SS base + ESP + delta; retry for a 16-bit or null SS.
    fn stack_address(&mut self, delta: i32) { self.stack_address_from(4, delta) }
    /// addr <- SS base + register + delta (a flat page function has a
    /// 32-bit stack at base 0, see emit_page).
    fn stack_address_from(&mut self, register: u8, delta: i32) {
        if !self.flat {
            self.w.load_fixed_u8(gp::stack_size_32 as u32);
            self.w.eqz_i32();
            self.retry_if();
            self.segment_check(SS);
        }
        self.w.get_local(&self.gpr[register as usize]);
        if delta != 0 {
            self.w.const_i32(delta);
            self.w.add_i32();
        }
        if !self.flat {
            self.w.load_fixed_i32(gp::get_seg_offset(SS as u32));
            self.w.add_i32();
        }
        self.w.set_local(&self.addr);
    }
    /// Push the value in `value` (translate, store, then commit ESP).
    fn push(&mut self, value: &WasmLocal) {
        self.stack_address(-4);
        self.write_mem(32, value);
        self.w.get_local(&self.gpr[4]);
        self.w.const_i32(4);
        self.w.sub_i32();
        self.set_gpr(4);
    }

    /// Emit the fast path of `form`; guard failures branch to `slow`.
    fn template(&mut self, form: Form, i: &DecodedInstruction) {
        let value = self.value.unsafe_clone();
        let (fa, fb, fr) = (
            self.fa.unsafe_clone(),
            self.fb.unsafe_clone(),
            self.fr.unsafe_clone(),
        );
        match form {
            Form::Alu {
                op,
                size,
                to_rm,
                reg,
                src,
            } => {
                // op 8: TEST AL/eAX, imm (no write).
                let compare = matches!(op, 7 | 8);
                if to_rm {
                    self.read_rm(i, size, !compare);
                }
                else {
                    self.read_reg(reg, size);
                }
                self.w.set_local(&fa);
                self.source(i, src, size);
                self.w.set_local(&fb);
                self.w.get_local(&fa);
                self.w.get_local(&fb);
                match op {
                    0 => self.w.add_i32(),
                    1 => self.w.or_i32(),
                    4 | 8 => self.w.and_i32(),
                    5 | 7 => self.w.sub_i32(),
                    6 => self.w.xor_i32(),
                    _ => unreachable!(),
                }
                if matches!(op, 0 | 5 | 7) && size != 32 {
                    self.w.const_i32(mask(size));
                    self.w.and_i32();
                }
                self.w.set_local(&fr);
                if !compare {
                    if to_rm {
                        self.write_rm(i, size, &fr);
                    }
                    else {
                        self.w.get_local(&fr);
                        self.write_reg(reg, size);
                    }
                }
                match op {
                    0 => self.flags_arith(size, false),
                    5 | 7 => self.flags_arith(size, true),
                    _ => self.flags_logic(size),
                }
            },
            Form::Test { size, src } => {
                self.read_rm(i, size, false);
                self.source(i, src, size);
                self.w.and_i32();
                self.w.set_local(&fr);
                self.flags_logic(size);
            },
            Form::MovToRm { size, src } => {
                self.prepare_rm(i);
                self.source(i, src, size);
                self.w.set_local(&value);
                self.write_rm(i, size, &value);
            },
            Form::MovToReg { size, reg, src } => {
                self.source(i, src, size);
                self.write_reg(reg, size);
            },
            Form::Lea { size, reg } => {
                let ea = i.ea.unwrap();
                self.w.const_i32(ea.displacement as i32);
                if let Some(base) = ea.base {
                    self.w.get_local(&self.gpr[base as usize]);
                    self.w.add_i32();
                }
                if let Some(index) = ea.index {
                    self.w.get_local(&self.gpr[index as usize]);
                    if ea.scale != 0 {
                        self.w.const_i32(ea.scale as i32);
                        self.w.shl_i32();
                    }
                    self.w.add_i32();
                }
                if ea.address_size == 16 {
                    self.w.const_i32(0xFFFF);
                    self.w.and_i32();
                }
                self.write_reg(reg, size);
            },
            Form::MovExtend { reg, from, signed } => {
                self.read_rm(i, from, false);
                if signed {
                    self.w.set_local(&value);
                    self.signed(&value, from);
                }
                self.write_reg(reg, 32);
            },
            Form::IncDec { dec, size, reg } => {
                match reg {
                    Some(r) => self.read_reg(r, size),
                    None => self.read_rm(i, size, true),
                }
                self.w.set_local(&fa);
                // CF survives: the current lazy CF becomes a FLAGS bit
                // (pending after the result, so a retried store commits nothing).
                self.lazy_carry();
                self.w.set_local(&value);
                self.w.get_local(&fa);
                self.w.const_i32(1);
                if dec {
                    self.w.sub_i32()
                }
                else {
                    self.w.add_i32()
                }
                self.w.const_i32(mask(size));
                self.w.and_i32();
                self.w.set_local(&fr);
                match reg {
                    Some(r) => {
                        self.w.get_local(&fr);
                        self.write_reg(r, size);
                    },
                    None => self.write_rm(i, size, &fr),
                }
                self.w.get_local(&value);
                self.pend_word(FLAG_CARRY);
                self.pend_op1(&fa);
                self.pend_result(&fr);
                self.pend_size_changed(size, FLAGS_ALL & !1 | if dec { FLAG_SUB } else { 0 });
                self.known = if dec { Known::Dec(size) } else { Known::Inc(size) };
            },
            Form::NegNot { neg, size } => {
                self.read_rm(i, size, true);
                if neg {
                    self.w.set_local(&fb);
                    self.w.const_i32(0);
                    self.w.set_local(&fa);
                    self.w.const_i32(0);
                    self.w.get_local(&fb);
                    self.w.sub_i32();
                    self.w.const_i32(mask(size));
                    self.w.and_i32();
                    self.w.set_local(&fr);
                    self.write_rm(i, size, &fr);
                    self.flags_arith(size, true);
                }
                else {
                    self.w.const_i32(-1);
                    self.w.xor_i32();
                    self.w.set_local(&value);
                    self.write_rm(i, size, &value);
                }
            },
            Form::Shift { kind, count } => {
                self.read_rm(i, 32, true);
                if count == 0 {
                    // No effect (the operand stays as is): keep fa and FLAGS.
                    self.w.drop_();
                    return;
                }
                self.w.set_local(&fa);
                self.w.get_local(&fa);
                self.w.const_i32(count as i32);
                match kind {
                    Shift::Left => self.w.shl_i32(),
                    Shift::Right => self.w.shr_u_i32(),
                    Shift::Arithmetic => self.w.shr_s_i32(),
                }
                self.w.set_local(&fr);
                self.write_rm(i, 32, &fr);
                // CF | OF, as cpu::arith::shl32/shr32/sar32.
                self.w.get_local(&fa);
                self.w.const_i32(match kind {
                    Shift::Left => 32 - count as i32,
                    _ => count as i32 - 1,
                });
                if kind == Shift::Left {
                    self.w.shr_s_i32()
                }
                else {
                    self.w.shr_u_i32()
                }
                self.w.const_i32(1);
                self.w.and_i32();
                self.w.set_local(&value);
                self.w.get_local(&value);
                match kind {
                    Shift::Left => {
                        self.w.get_local(&value);
                        self.w.get_local(&fr);
                        self.w.const_i32(31);
                        self.w.shr_s_i32();
                        self.w.xor_i32();
                        self.w.const_i32(11);
                        self.w.shl_i32();
                        self.w.const_i32(FLAG_OVERFLOW);
                        self.w.and_i32();
                        self.w.or_i32();
                    },
                    Shift::Right => {
                        self.w.get_local(&fa);
                        self.w.const_i32(20);
                        self.w.shr_s_i32();
                        self.w.const_i32(FLAG_OVERFLOW);
                        self.w.and_i32();
                        self.w.or_i32();
                    },
                    Shift::Arithmetic => {},
                }
                self.pend_word(FLAG_CARRY | FLAG_OVERFLOW);
                self.pend_result(&fr);
                self.pend_size_changed(32, FLAGS_ALL & !1 & !FLAG_OVERFLOW);
                self.known = Known::None;
            },
            Form::ShiftHelper {
                name: name @ ("rol32" | "ror32"),
                size: 32,
                count,
            } => {
                // As cpu::arith::rol32/ror32: a zero count changes nothing.
                let left = name == "rol32";
                self.read_rm(i, 32, true);
                self.w.set_local(&fa);
                self.count(count);
                self.w.set_local(&fb);
                self.w.get_local(&fa);
                self.w.get_local(&fb);
                if left {
                    self.w.rotl_i32()
                }
                else {
                    self.w.rotr_i32()
                }
                self.w.set_local(&fr);
                self.write_rm(i, 32, &fr);
                if count != Count::Imm(0) {
                    // A dynamic count updates the lazy state in memory (see
                    // touches_flags_memory), a constant one the pending state.
                    let dynamic = count == Count::Cl;
                    if dynamic {
                        self.w.get_local(&fb);
                        self.w.if_void();
                        self.w.const_i32(gp::flags_changed as i32);
                        self.w.load_fixed_i32(gp::flags_changed as u32);
                        self.w.const_i32(!1 & !FLAG_OVERFLOW);
                        self.w.and_i32();
                        self.w.store_aligned_i32(0);
                        self.w.const_i32(gp::flags as i32);
                        self.w.load_fixed_i32(gp::flags as u32);
                        self.w.const_i32(!1 & !FLAG_OVERFLOW);
                        self.w.and_i32();
                    }
                    self.w.get_local(&fr);
                    if left {
                        // result & 1 | (result << 11 ^ result >> 20) & OF
                        self.w.const_i32(1);
                        self.w.and_i32();
                        self.w.get_local(&fr);
                        self.w.const_i32(11);
                        self.w.shl_i32();
                    }
                    else {
                        // result >> 31 & 1 | (result >> 20 ^ result >> 19) & OF
                        self.w.const_i32(31);
                        self.w.shr_u_i32();
                        self.w.get_local(&fr);
                        self.w.const_i32(19);
                        self.w.shr_s_i32();
                    }
                    self.w.get_local(&fr);
                    self.w.const_i32(20);
                    self.w.shr_s_i32();
                    self.w.xor_i32();
                    self.w.const_i32(FLAG_OVERFLOW);
                    self.w.and_i32();
                    self.w.or_i32();
                    if dynamic {
                        self.w.or_i32();
                        self.w.store_aligned_i32(0);
                        self.w.block_end();
                    }
                    else {
                        self.and_changed(!1 & !FLAG_OVERFLOW);
                        self.pend_word(FLAG_CARRY | FLAG_OVERFLOW);
                    }
                }
                self.known = Known::None;
            },
            Form::ShiftHelper { name, size, count } => {
                self.read_rm(i, size, true);
                self.w.set_local(&fa);
                self.w.get_local(&fa);
                self.count(count);
                self.w
                    .call_signature(name, Signature::new(&[WasmType::I32; 2], &[WasmType::I32]));
                self.w.set_local(&fr);
                self.write_rm(i, size, &fr);
                self.known = Known::None;
            },
            Form::Carry {
                sub,
                size,
                to_rm,
                reg,
                src,
            } => {
                // As cpu::arith::adc/sbb. CF first: it may come from fa/fb.
                if !self.known_condition(2) {
                    self.lazy_carry();
                }
                self.w.set_local(&value);
                if to_rm {
                    self.read_rm(i, size, true);
                }
                else {
                    self.read_reg(reg, size);
                }
                self.w.set_local(&fa);
                self.source(i, src, size);
                self.w.set_local(&fb);
                self.w.get_local(&fa);
                self.w.get_local(&fb);
                if sub {
                    self.w.sub_i32()
                }
                else {
                    self.w.add_i32()
                }
                self.w.get_local(&value);
                if sub {
                    self.w.sub_i32()
                }
                else {
                    self.w.add_i32()
                }
                if size != 32 {
                    self.w.const_i32(mask(size));
                    self.w.and_i32();
                }
                self.w.set_local(&fr);
                if to_rm {
                    self.write_rm(i, size, &fr);
                }
                else {
                    self.w.get_local(&fr);
                    self.write_reg(reg, size);
                }
                // CF: adc: a ^ ((a ^ b) & (b ^ r)); sbb: r ^ ((r ^ b) & (b ^ a)).
                let (x, y) = if sub { (&fr, &fa) } else { (&fa, &fr) };
                self.w.get_local(x);
                self.w.get_local(x);
                self.w.get_local(&fb);
                self.w.xor_i32();
                self.w.get_local(&fb);
                self.w.get_local(y);
                self.w.xor_i32();
                self.w.and_i32();
                self.w.xor_i32();
                self.w.const_i32(size as i32 - 1);
                self.w.shr_u_i32();
                self.w.const_i32(1);
                self.w.and_i32();
                // AF: a ^ b ^ r.
                self.w.get_local(&fa);
                self.w.get_local(&fb);
                self.w.xor_i32();
                self.w.get_local(&fr);
                self.w.xor_i32();
                self.w.const_i32(FLAG_ADJUST);
                self.w.and_i32();
                self.w.or_i32();
                // OF: adc: (b ^ r) & (a ^ r); sbb: (b ^ a) & (r ^ a).
                let (x, y) = if sub { (&fa, &fr) } else { (&fr, &fa) };
                self.w.get_local(&fb);
                self.w.get_local(x);
                self.w.xor_i32();
                self.w.get_local(y);
                self.w.get_local(x);
                self.w.xor_i32();
                self.w.and_i32();
                self.w.const_i32(size as i32 - 1);
                self.w.shr_u_i32();
                self.w.const_i32(11);
                self.w.shl_i32();
                self.w.const_i32(FLAG_OVERFLOW);
                self.w.and_i32();
                self.w.or_i32();
                self.pend_word(FLAG_CARRY | FLAG_ADJUST | FLAG_OVERFLOW);
                self.pend_op1(&fa);
                self.pend_result(&fr);
                self.pend_size_changed(
                    size,
                    FLAGS_ALL & !FLAG_CARRY & !FLAG_ADJUST & !FLAG_OVERFLOW
                        | if sub { FLAG_SUB } else { 0 },
                );
                self.known = Known::None;
            },
            Form::DoubleShift {
                left,
                size: 32,
                reg,
                count,
            } => {
                // As cpu::arith::shld32/shrd32: a zero count changes nothing.
                self.read_rm(i, 32, true);
                self.w.set_local(&fa);
                self.read_reg(reg, 32);
                self.w.set_local(&fb);
                self.count(count);
                self.w.set_local(&value);
                let dynamic = count == Count::Cl;
                if dynamic {
                    self.w.get_local(&value);
                    self.w.if_i32();
                }
                if count != Count::Imm(0) {
                    self.w.get_local(&fa);
                    self.w.get_local(&value);
                    if left {
                        self.w.shl_i32()
                    }
                    else {
                        self.w.shr_u_i32()
                    }
                    self.w.get_local(&fb);
                    self.w.const_i32(32);
                    self.w.get_local(&value);
                    self.w.sub_i32();
                    if left {
                        self.w.shr_u_i32()
                    }
                    else {
                        self.w.shl_i32()
                    }
                    self.w.or_i32();
                }
                if dynamic {
                    self.w.else_();
                }
                if dynamic || count == Count::Imm(0) {
                    self.w.get_local(&fa);
                }
                if dynamic {
                    self.w.block_end();
                }
                self.w.set_local(&fr);
                self.write_rm(i, 32, &fr);
                if count != Count::Imm(0) {
                    // A dynamic count updates the lazy state in memory (see
                    // touches_flags_memory), a constant one the pending state.
                    if dynamic {
                        self.w.get_local(&value);
                        self.w.if_void();
                        self.store_fixed(gp::last_result as u32, &fr);
                        self.store_fixed_const(gp::last_op_size as u32, 31);
                        self.store_fixed_const(
                            gp::flags_changed as u32,
                            FLAGS_ALL & !1 & !FLAG_OVERFLOW,
                        );
                        self.w.const_i32(gp::flags as i32);
                        self.w.load_fixed_i32(gp::flags as u32);
                        self.w.const_i32(!1 & !FLAG_OVERFLOW);
                        self.w.and_i32();
                    }
                    // CF: the last bit shifted out of the destination.
                    self.w.get_local(&fa);
                    if left {
                        self.w.const_i32(32);
                        self.w.get_local(&value);
                        self.w.sub_i32();
                    }
                    else {
                        self.w.get_local(&value);
                        self.w.const_i32(1);
                        self.w.sub_i32();
                    }
                    self.w.shr_u_i32();
                    self.w.const_i32(1);
                    self.w.and_i32();
                    self.w.tee_local(&self.tmp);
                    if left {
                        // OF (count 1 only): CF ^ the result's sign.
                        self.w.get_local(&self.tmp);
                        self.w.get_local(&fr);
                        self.w.const_i32(31);
                        self.w.shr_u_i32();
                        self.w.xor_i32();
                        self.w.const_i32(11);
                        self.w.shl_i32();
                        self.w.const_i32(0);
                        self.w.get_local(&value);
                        self.w.const_i32(1);
                        self.w.eq_i32();
                        self.w.select();
                    }
                    else {
                        // OF: (result ^ destination) >> 20 & OF.
                        self.w.get_local(&fr);
                        self.w.get_local(&fa);
                        self.w.xor_i32();
                        self.w.const_i32(20);
                        self.w.shr_s_i32();
                        self.w.const_i32(FLAG_OVERFLOW);
                        self.w.and_i32();
                    }
                    self.w.or_i32();
                    if dynamic {
                        self.w.or_i32();
                        self.w.store_aligned_i32(0);
                        self.w.block_end();
                    }
                    else {
                        self.pend_word(FLAG_CARRY | FLAG_OVERFLOW);
                        self.pend_result(&fr);
                        self.pend_size_changed(32, FLAGS_ALL & !1 & !FLAG_OVERFLOW);
                    }
                }
                self.known = Known::None;
            },
            Form::DoubleShift {
                left,
                size,
                reg,
                count,
            } => {
                self.read_rm(i, size, true);
                self.w.set_local(&fa);
                self.w.get_local(&fa);
                self.read_reg(reg, size);
                self.count(count);
                let name = match (left, size) {
                    (true, 16) => "shld16",
                    (true, _) => "shld32",
                    (false, 16) => "shrd16",
                    (false, _) => "shrd32",
                };
                self.w
                    .call_signature(name, Signature::new(&[WasmType::I32; 3], &[WasmType::I32]));
                self.w.set_local(&fr);
                self.write_rm(i, size, &fr);
                self.known = Known::None;
            },
            Form::BitScan { reverse, reg } => {
                // As cpu::arith::bsf32/bsr32: a zero source keeps the register.
                self.read_rm(i, 32, false);
                self.w.set_local(&fb);
                // ZF: a zero source; CF: 0.
                self.w.get_local(&fb);
                self.w.eqz_i32();
                self.w.const_i32(6);
                self.w.shl_i32();
                self.pend_word(FLAG_ZERO | FLAG_CARRY);
                self.pend_size_changed(32, FLAGS_ALL & !FLAG_ZERO & !FLAG_CARRY);
                self.w.get_local(&fb);
                self.w.if_i32();
                if reverse {
                    self.w.const_i32(31);
                    self.w.get_local(&fb);
                    self.w.clz_i32();
                    self.w.sub_i32();
                }
                else {
                    self.w.get_local(&fb);
                    self.w.ctz_i32();
                }
                self.w.tee_local(&fr);
                self.write_reg(reg, 32);
                self.w.get_local(&fr);
                self.w.else_();
                self.w.const_i32(0);
                self.w.block_end();
                self.w.set_local(&fr);
                self.pend_result(&fr);
                self.known = Known::None;
            },
            Form::BitTest { op, offset } => {
                // As cpu::arith::bt_reg/bts_reg/btr_reg/btc_reg.
                let base = i.modrm.unwrap() & 7;
                match offset {
                    Src::Reg(r) => self.read_reg(r, 32),
                    Src::Imm(v) => self.w.const_i32(v as i32),
                    Src::Rm => unreachable!(),
                }
                self.w.const_i32(31);
                self.w.and_i32();
                self.w.set_local(&fb);
                self.read_reg(base, 32);
                self.w.get_local(&fb);
                self.w.shr_u_i32();
                self.w.const_i32(1);
                self.w.and_i32();
                self.pend_word(FLAG_CARRY);
                self.and_changed(!1);
                if op != 0 {
                    self.read_reg(base, 32);
                    self.w.const_i32(1);
                    self.w.get_local(&fb);
                    self.w.shl_i32();
                    match op {
                        1 => self.w.or_i32(),
                        2 => {
                            self.w.const_i32(-1);
                            self.w.xor_i32();
                            self.w.and_i32();
                        },
                        _ => self.w.xor_i32(),
                    }
                    self.write_reg(base, 32);
                }
                self.known = Known::None;
            },
            Form::MulWide { signed } => {
                // As cpu::arith::mul32/imul32.
                self.read_rm(i, 32, false);
                if signed {
                    self.w.extend_signed_i32_to_i64()
                }
                else {
                    self.w.extend_unsigned_i32_to_i64()
                }
                self.w.get_local(&self.gpr[0]);
                if signed {
                    self.w.extend_signed_i32_to_i64()
                }
                else {
                    self.w.extend_unsigned_i32_to_i64()
                }
                self.w.mul_i64();
                self.w.set_local_i64(&self.wide);
                self.w.get_local_i64(&self.wide);
                self.w.wrap_i64_to_i32();
                self.set_gpr(0);
                self.w.get_local_i64(&self.wide);
                self.w.const_i64(32);
                self.w.shr_u_i64();
                self.w.wrap_i64_to_i32();
                self.set_gpr(2);
                let eax = self.gpr[0].unsafe_clone();
                // CF = OF = the high half is not the extension of the low.
                self.w.get_local(&self.gpr[2]);
                if signed {
                    self.w.get_local(&self.gpr[0]);
                    self.w.const_i32(31);
                    self.w.shr_s_i32();
                    self.w.ne_i32();
                }
                else {
                    self.w.const_i32(0);
                    self.w.ne_i32();
                }
                self.w.const_i32(1 | FLAG_OVERFLOW);
                self.w.mul_i32();
                self.pend_word(FLAG_CARRY | FLAG_OVERFLOW);
                self.pend_result(&eax);
                self.pend_size_changed(32, FLAGS_ALL & !1 & !FLAG_OVERFLOW);
                self.known = Known::None;
            },
            Form::Div { signed } => {
                // As cpu::arith::div32/idiv32; #DE cases go to the interpreter
                // (as does IDIV by -1, whose i64 division could trap).
                self.read_rm(i, 32, false);
                self.w.set_local(&value);
                self.w.get_local(&value);
                self.w.eqz_i32();
                if signed {
                    self.w.get_local(&value);
                    self.w.const_i32(-1);
                    self.w.eq_i32();
                    self.w.or_i32();
                }
                self.retry_if();
                self.w.get_local(&self.gpr[2]);
                self.w.extend_unsigned_i32_to_i64();
                self.w.const_i64(32);
                self.w.shl_i64();
                self.w.get_local(&self.gpr[0]);
                self.w.extend_unsigned_i32_to_i64();
                self.w.or_i64();
                self.w.set_local_i64(&self.wide);
                self.w.get_local_i64(&self.wide);
                self.w.get_local(&value);
                if signed {
                    self.w.extend_signed_i32_to_i64();
                    self.w.div_s_i64();
                }
                else {
                    self.w.extend_unsigned_i32_to_i64();
                    self.w.div_i64();
                }
                self.w.set_local_i64(&self.quotient);
                // The quotient must fit in 32 bits.
                self.w.get_local_i64(&self.quotient);
                if signed {
                    self.w.get_local_i64(&self.quotient);
                    self.w.wrap_i64_to_i32();
                    self.w.extend_signed_i32_to_i64();
                    self.w.ne_i64();
                }
                else {
                    self.w.const_i64(32);
                    self.w.shr_u_i64();
                    self.w.const_i64(0);
                    self.w.ne_i64();
                }
                self.retry_if();
                self.w.get_local_i64(&self.wide);
                self.w.get_local(&value);
                if signed {
                    self.w.extend_signed_i32_to_i64();
                    self.w.rem_s_i64();
                }
                else {
                    self.w.extend_unsigned_i32_to_i64();
                    self.w.rem_i64();
                }
                self.w.wrap_i64_to_i32();
                self.set_gpr(2);
                self.w.get_local_i64(&self.quotient);
                self.w.wrap_i64_to_i32();
                self.set_gpr(0);
            },
            Form::Xadd { size, reg } => {
                // As cpu::arith::xadd*: reg = old rm, rm = old rm + reg.
                self.read_rm(i, size, true);
                self.w.set_local(&fa);
                self.read_reg(reg, size);
                self.w.set_local(&fb);
                self.w.get_local(&fa);
                self.w.get_local(&fb);
                self.w.add_i32();
                if size != 32 {
                    self.w.const_i32(mask(size));
                    self.w.and_i32();
                }
                self.w.set_local(&fr);
                if i.ea.is_some() {
                    self.write_rm(i, size, &fr);
                    self.w.get_local(&fa);
                    self.write_reg(reg, size);
                }
                else {
                    self.w.get_local(&fa);
                    self.write_reg(reg, size);
                    self.write_rm(i, size, &fr);
                }
                self.flags_arith(size, false);
            },
            Form::Cmpxchg { size, reg } => {
                // As cpu::arith::cmpxchg*: flags of CMP eAX, rm; equal: rm =
                // reg, else eAX = rm (and rm is rewritten unchanged).
                self.read_rm(i, size, true);
                self.w.set_local(&fb);
                self.read_reg(0, size);
                self.w.set_local(&fa);
                self.w.get_local(&fa);
                self.w.get_local(&fb);
                self.w.sub_i32();
                if size != 32 {
                    self.w.const_i32(mask(size));
                    self.w.and_i32();
                }
                self.w.set_local(&fr);
                self.read_reg(reg, size);
                self.w.get_local(&fb);
                self.w.get_local(&fr);
                self.w.eqz_i32();
                self.w.select();
                self.w.set_local(&value);
                self.write_rm(i, size, &value);
                self.w.get_local(&fr);
                self.w.if_void();
                self.w.get_local(&fb);
                self.write_reg(0, size);
                self.w.block_end();
                self.flags_arith(size, true);
            },
            Form::Moffs { size, store, ea } => {
                self.linear(&ea);
                if store {
                    self.read_reg(0, size);
                    self.w.set_local(&value);
                    self.write_mem(size, &value);
                }
                else {
                    self.read_mem(size, false);
                    self.write_reg(0, size);
                }
            },
            Form::X87 { opcode, modrm, io } => {
                self.x87_guard();
                let kind = match io {
                    Io::Stack => 0,
                    Io::Load { .. } => 1,
                    Io::Store { .. } => 2,
                };
                let form = opcode as i32 | (modrm as i32) << 8 | kind << 16;
                let (low, high) = (self.value.unsafe_clone(), self.tmp.unsafe_clone());
                match io {
                    Io::Stack => {},
                    Io::Load { bytes } => {
                        self.linear(&i.ea.unwrap());
                        self.read_mem(if bytes == 2 { 16 } else { 32 }, false);
                        self.w.set_local(&low);
                        self.w.const_i32(0);
                        self.w.set_local(&high);
                        if bytes == 8 {
                            self.w.get_local(&self.addr);
                            self.w.const_i32(4);
                            self.w.add_i32();
                            self.w.set_local(&self.addr);
                            self.read_mem(32, false);
                            self.w.set_local(&high);
                        }
                    },
                    Io::Store { bytes } => {
                        // Write preflight: the operation may pop, so the
                        // store must not fault (else the interpreter runs it).
                        self.linear(&i.ea.unwrap());
                        self.tlb_miss(bytes as u32, true);
                        self.retry_if();
                    },
                }
                // The inlined f64 form (x86tpl::x87) where it applies,
                // else ir_t0_x87 from unchanged state.
                let done = self.w.block_void();
                if let Some(native) = crate::ir::x87::native(opcode, modrm) {
                    self.x87_open();
                    let slow = self.w.block_void();
                    self.w.load_fixed_u8(gp::x87_native_policy as u32);
                    self.w.eqz_i32();
                    self.w.hint(false);
                    self.w.br_if(slow);
                    let cache = Some(self.x87.unsafe_clone());
                    let mut words = X87Locals {
                        w: &mut self.w,
                        words: [&low, &high],
                        cache,
                    };
                    x87_native(&mut words, native, slow);
                    self.w.br(done);
                    self.w.block_end();
                }
                // The helper works on the CPU state.
                self.x87_close();
                self.w.const_i32(form);
                self.w.get_local(&low);
                self.w.get_local(&high);
                self.w.call_signature("ir_t0_x87", signature("ir_t0_x87"));
                self.w.set_local_i64(&self.wide);
                self.w.get_local_i64(&self.wide);
                self.w.wrap_i64_to_i32();
                self.w.set_local(&low);
                self.w.get_local_i64(&self.wide);
                self.w.const_i64(32);
                self.w.shr_u_i64();
                self.w.wrap_i64_to_i32();
                self.w.set_local(&high);
                self.w.block_end();
                // Open after the native form, closed after the helper.
                self.x87_known_open = false;
                if let Io::Store { bytes } = io {
                    self.host_address();
                    self.w.get_local(&low);
                    match bytes {
                        2 => self.w.guest_store_u16(0),
                        4 => self.w.guest_store_i32(0),
                        _ => {
                            self.w.guest_store_i32(0);
                            self.host_address();
                            self.w.get_local(&high);
                            self.w.guest_store_i32(4);
                        },
                    }
                }
            },
            Form::Simd(form, vex) => self.simd(form, i, vex),
            Form::X87Flags { name, r } => {
                self.x87_guard();
                self.w.const_i32(r as i32);
                self.w
                    .call_signature(name, Signature::new(&[WasmType::I32], &[]));
                self.known = Known::None;
            },
            Form::Fcmov { cc, r } => {
                self.x87_guard();
                self.condition(cc);
                self.w.const_i32(r as i32);
                self.w
                    .call_signature("fpu_fcmovcc", Signature::new(&[WasmType::I32; 2], &[]));
            },
            Form::Bmi { op, reg, vvvv } => {
                if i.vex.is_some() {
                    self.vex_mode_guard();
                }
                // the source fa
                self.read_rm(i, 32, false);
                self.w.set_local(&fa);
                if matches!(op, BmiOp::Shlx | BmiOp::Shrx | BmiOp::Sarx) {
                    // (Wasm takes the count modulo 32, as these; no flags)
                    self.w.get_local(&fa);
                    self.read_reg(vvvv, 32);
                    match op {
                        BmiOp::Shlx => self.w.shl_i32(),
                        BmiOp::Shrx => self.w.shr_u_i32(),
                        _ => self.w.shr_s_i32(),
                    }
                    self.write_reg(reg, 32);
                }
                else {
                    self.bmi(op, reg, vvvv);
                }
            },
            Form::Movbe { load, reg } => {
                if load {
                    self.read_rm(i, 32, false);
                    self.byte_swap();
                    self.write_reg(reg, 32);
                }
                else {
                    self.prepare_rm(i);
                    self.read_reg(reg, 32);
                    self.byte_swap();
                    self.w.set_local(&value);
                    self.write_rm(i, 32, &value);
                }
            },
            Form::Lahf => {
                // The lazy FLAGS are in memory (touches_flags_memory).
                self.w
                    .call_signature("get_eflags", Signature::new(&[], &[WasmType::I32]));
                self.w.const_i32(0xD5);
                self.w.and_i32();
                self.w.const_i32(2);
                self.w.or_i32();
                self.write_reg(4, 8);
            },
            Form::Fnstsw => {
                self.x87_guard();
                self.w.call_signature(
                    "fpu_load_status_word",
                    Signature::new(&[], &[WasmType::I32]),
                );
                self.write_reg(0, 16);
            },
            Form::Imul { reg, immediate } => {
                match immediate {
                    Some(v) => {
                        self.read_rm(i, 32, false);
                        self.w.extend_signed_i32_to_i64();
                        self.w.const_i64(v as i32 as i64);
                    },
                    None => {
                        self.read_reg(reg, 32);
                        self.w.extend_signed_i32_to_i64();
                        self.read_rm(i, 32, false);
                        self.w.extend_signed_i32_to_i64();
                    },
                }
                self.w.mul_i64();
                self.w.set_local_i64(&self.wide);
                self.w.get_local_i64(&self.wide);
                self.w.wrap_i64_to_i32();
                self.w.set_local(&fr);
                self.w.get_local(&fr);
                self.write_reg(reg, 32);
                // CF = OF = the product does not fit in 32 signed bits.
                self.w.get_local_i64(&self.wide);
                self.w.get_local(&fr);
                self.w.extend_signed_i32_to_i64();
                self.w.ne_i64();
                self.w.const_i32(1 | FLAG_OVERFLOW);
                self.w.mul_i32();
                self.pend_word(FLAG_CARRY | FLAG_OVERFLOW);
                self.pend_result(&fr);
                self.pend_size_changed(32, FLAGS_ALL & !1 & !FLAG_OVERFLOW);
                self.known = Known::None;
            },
            Form::Push { src } => {
                match src {
                    Src::Rm => self.read_rm(i, 32, false),
                    Src::Reg(r) => self.read_reg(r, 32),
                    Src::Imm(v) => self.w.const_i32(v as i32),
                }
                self.w.set_local(&value);
                self.push(&value);
            },
            Form::Pop { reg } => {
                self.stack_address(0);
                self.read_mem(32, false);
                self.w.set_local(&value);
                self.w.get_local(&self.gpr[4]);
                self.w.const_i32(4);
                self.w.add_i32();
                self.set_gpr(4);
                self.w.get_local(&value);
                self.write_reg(reg, 32);
            },
            Form::Xchg { a, b } => {
                self.w.get_local(&self.gpr[a as usize]);
                self.w.get_local(&self.gpr[b as usize]);
                self.set_gpr(a as usize);
                self.set_gpr(b as usize);
            },
            Form::Cdq => {
                self.w.get_local(&self.gpr[0]);
                self.w.const_i32(31);
                self.w.shr_s_i32();
                self.set_gpr(2);
            },
            Form::Cwde => {
                let eax = self.gpr[0].unsafe_clone();
                self.signed(&eax, 16);
                self.set_gpr(0);
            },
            Form::Nop => {},
            Form::Leave => {
                // ESP = EBP; EBP = pop.
                self.stack_address_from(5, 0);
                self.read_mem(32, false);
                self.w.set_local(&value);
                self.w.get_local(&self.gpr[5]);
                self.w.const_i32(4);
                self.w.add_i32();
                self.set_gpr(4);
                self.w.get_local(&value);
                self.set_gpr(5);
            },
            Form::Setcc { cc } => {
                self.prepare_rm(i);
                self.condition(cc);
                self.w.set_local(&value);
                self.write_rm(i, 8, &value);
            },
            Form::Cmov { cc, reg } => {
                self.read_rm(i, 32, false);
                self.w.set_local(&value);
                self.condition(cc);
                self.w.if_void();
                self.w.get_local(&value);
                self.set_gpr(reg as usize);
                self.w.block_end();
            },
            Form::Jmp { target } => {
                self.flush();
                self.goto_linear(self.cs_base.wrapping_add(target));
            },
            Form::Jcc { cc, target } => {
                self.flush();
                self.condition(cc);
                self.leave_block();
                self.w.if_void();
                self.goto_linear(self.cs_base.wrapping_add(target));
                self.w.block_end();
                self.goto_linear(self.cs_base.wrapping_add(i.next_pc.0));
            },
            Form::Jecxz { target, cx } => {
                self.flush();
                self.read_reg(1, if cx { 16 } else { 32 });
                self.w.eqz_i32();
                self.leave_block();
                self.w.if_void();
                self.goto_linear(self.cs_base.wrapping_add(target));
                self.w.block_end();
                self.goto_linear(self.cs_base.wrapping_add(i.next_pc.0));
            },
            Form::MovFromSreg { seg, size } => {
                self.prepare_rm(i);
                self.w.load_fixed_u16(gp::sreg as u32 + 2 * seg as u32);
                self.w.set_local(&value);
                self.write_rm(i, size, &value);
            },
            Form::PushSreg { seg } => {
                self.w.load_fixed_u16(gp::sreg as u32 + 2 * seg as u32);
                self.w.set_local(&value);
                self.stack_address(-4);
                self.write_mem(16, &value);
                self.w.get_local(&self.gpr[4]);
                self.w.const_i32(4);
                self.w.sub_i32();
                self.set_gpr(4);
            },
            Form::XchgMem { size, reg } => {
                // As cpu::arith::xchg*: rm = reg, then reg = old rm
                self.read_rm(i, size, true);
                self.w.set_local(&fa);
                self.read_reg(reg, size);
                self.w.set_local(&fb);
                self.write_rm(i, size, &fb);
                self.w.get_local(&fa);
                self.write_reg(reg, size);
            },
            Form::Direction { set } => {
                self.w.const_i32(gp::flags as i32);
                self.w.load_fixed_i32(gp::flags as u32);
                if set {
                    self.w.const_i32(FLAG_DIRECTION);
                    self.w.or_i32();
                }
                else {
                    self.w.const_i32(!FLAG_DIRECTION);
                    self.w.and_i32();
                }
                self.w.store_aligned_i32(0);
            },
            Form::PopRm { esp } => {
                // As instr32_8F_0_mem: the value at ESP, stored to the
                // address computed with ESP + 4, then ESP + 4
                self.stack_address(0);
                self.read_mem(32, false);
                self.w.set_local(&fb);
                match &i.ea {
                    Some(ea) if esp => {
                        let after = EffectiveAddress {
                            displacement: ea.displacement.wrapping_add(4),
                            ..ea.clone()
                        };
                        self.linear(&after);
                    },
                    _ => self.prepare_rm(i),
                }
                self.write_mem(32, &fb);
                self.w.get_local(&self.gpr[4]);
                self.w.const_i32(4);
                self.w.add_i32();
                self.set_gpr(4);
            },
            Form::Pusha => {
                // As pusha32: EAX, ECX, EDX, EBX, the original ESP, EBP, ESI
                // and EDI below ESP, all in one page (else the interpreter):
                // the first store's translation stands for the others, so
                // they all happen or none
                self.stack_address(-32);
                self.w.get_local(&self.addr);
                self.w.const_i32(0xFFF);
                self.w.and_i32();
                self.w.const_i32(0x1000 - 32);
                self.w.gtu_i32();
                self.retry_if();
                let base = fa.unsafe_clone();
                self.w.get_local(&self.addr);
                self.w.set_local(&base);
                for r in 0..8u8 {
                    self.w.get_local(&base);
                    self.w.const_i32(28 - 4 * r as i32);
                    self.w.add_i32();
                    self.w.set_local(&self.addr);
                    self.w.get_local(&self.gpr[r as usize]);
                    self.w.set_local(&value);
                    self.write_mem(32, &value);
                }
                self.w.get_local(&self.gpr[4]);
                self.w.const_i32(32);
                self.w.sub_i32();
                self.set_gpr(4);
            },
            Form::RepMovsStos { movs, size } => {
                // As cpu::string's REP MOVS/STOS when it is done at once:
                // DF clear, each operand within one page of plain RAM (no
                // compiled code under the destination), MOVS's ranges not
                // overlapping forward, STOS's element one byte repeated;
                // else the interpreter, which does a page and leaves EIP
                // here (P3.1a's block)
                let (length, destination, source) = (fa, fb, fr);
                let shift = size.trailing_zeros() as i32;
                self.w.get_local(&self.gpr[1]);
                self.w.if_void();
                self.w.load_fixed_i32(gp::flags as u32);
                self.w.const_i32(FLAG_DIRECTION);
                self.w.and_i32();
                self.retry_if();
                self.w.get_local(&self.gpr[1]);
                self.w.const_i32(4096 >> shift);
                self.w.gtu_i32();
                self.retry_if();
                self.w.get_local(&self.gpr[1]);
                self.w.const_i32(shift);
                self.w.shl_i32();
                self.w.set_local(&length);
                // ES:EDI, then (MOVS) the source segment's ESI: host
                // addresses of plain RAM pages holding the whole range
                let operands: &[(u8, u8, bool, &WasmLocal)] = if movs {
                    &[
                        (7, ES, true, &destination),
                        (6, i.prefixes.segment.unwrap_or(DS), false, &source),
                    ]
                }
                else {
                    &[(7, ES, true, &destination)]
                };
                for &(register, segment, write, host) in operands {
                    self.linear(&EffectiveAddress {
                        base: Some(register),
                        index: None,
                        scale: 0,
                        displacement: 0,
                        address_size: 32,
                        segment,
                    });
                    self.tlb_miss(1, write);
                    self.retry_if();
                    self.w.get_local(&self.addr);
                    self.w.const_i32(0xFFF);
                    self.w.and_i32();
                    self.w.get_local(&length);
                    self.w.add_i32();
                    self.w.const_i32(0x1000);
                    self.w.gtu_i32();
                    self.retry_if();
                    self.host_address();
                    self.w.set_local(host);
                }
                if movs {
                    crate::x86tpl::string::overlaps_forward(
                        &mut self.w,
                        &destination,
                        &source,
                        &length,
                    );
                    self.retry_if();
                    self.w.get_local(&destination);
                    self.w.get_local(&source);
                    self.w.get_local(&length);
                    crate::x86tpl::string::memory_copy(&mut self.w);
                    self.note_rep();
                    self.w.get_local(&self.gpr[6]);
                    self.w.get_local(&length);
                    self.w.add_i32();
                    self.set_gpr(6);
                }
                else {
                    self.read_reg(0, size * 8);
                    self.w.set_local(&value);
                    // (the byte above, whether it is not the whole element)
                    crate::x86tpl::string::fill_byte(&mut self.w, size, &value);
                    self.retry_if();
                    self.w.set_local(&value);
                    self.w.get_local(&destination);
                    self.w.get_local(&value);
                    self.w.get_local(&length);
                    crate::x86tpl::string::memory_fill(&mut self.w);
                    self.note_rep();
                }
                self.w.get_local(&self.gpr[7]);
                self.w.get_local(&length);
                self.w.add_i32();
                self.set_gpr(7);
                self.w.const_i32(0);
                self.set_gpr(1);
                self.w.block_end();
            },
            Form::Cli => {
                // As instr_FA_without_fault outside virtual-8086 mode: IF
                // cleared in real mode or when IOPL >= CPL, else #GP (the
                // interpreter)
                self.w.load_fixed_i32(gp::flags as u32);
                self.w.const_i32(FLAG_VM);
                self.w.and_i32();
                self.retry_if();
                self.w.load_fixed_u8(gp::protected_mode as u32);
                self.w.load_fixed_i32(gp::flags as u32);
                self.w.const_i32(12);
                self.w.shr_u_i32();
                self.w.const_i32(3);
                self.w.and_i32();
                self.w.load_fixed_u8(gp::cpl as u32);
                self.w.ltu_i32();
                self.w.and_i32();
                self.retry_if();
                self.w.const_i32(gp::flags as i32);
                self.w.load_fixed_i32(gp::flags as u32);
                self.w.const_i32(!FLAG_INTERRUPT);
                self.w.and_i32();
                self.w.store_aligned_i32(0);
            },
            Form::MovToSreg { seg } => {
                self.read_rm(i, 16, false);
                self.w.set_local(&value);
                self.w.const_i32(seg as i32);
                self.w.get_local(&value);
                self.w
                    .call_signature("ir_t0_load_seg", signature("ir_t0_load_seg"));
                self.retry_if();
            },
            Form::Popa => {
                // As popa32: EDI, ESI, EBP, (ESP skipped), EBX, EDX, ECX and
                // EAX from ESP up, all read before any register is written
                self.stack_address(0);
                self.w.get_local(&self.addr);
                self.w.const_i32(0xFFF);
                self.w.and_i32();
                self.w.const_i32(0x1000 - 32);
                self.w.gtu_i32();
                self.retry_if();
                let base = fa.unsafe_clone();
                self.w.get_local(&self.addr);
                self.w.set_local(&base);
                let mut values = vec![];
                for r in (0..8u8).rev().filter(|&r| r != 4) {
                    self.w.get_local(&base);
                    self.w.const_i32(28 - 4 * r as i32);
                    self.w.add_i32();
                    self.w.set_local(&self.addr);
                    self.read_mem(32, false);
                    values.push((r, self.w.set_new_local()));
                }
                for (r, local) in values {
                    self.w.get_local(&local);
                    self.set_gpr(r as usize);
                    self.w.free_local(local);
                }
                self.w.get_local(&self.gpr[4]);
                self.w.const_i32(32);
                self.w.add_i32();
                self.set_gpr(4);
            },
            Form::Call { target } => {
                self.w.const_i32(i.next_pc.0 as i32);
                self.w.set_local(&value);
                self.push(&value);
                self.flush();
                self.goto_linear(self.cs_base.wrapping_add(target));
            },
            Form::Ret { pop } => {
                self.stack_address(0);
                self.read_mem(32, false);
                self.w.set_local(&value);
                self.w.get_local(&self.gpr[4]);
                self.w.const_i32(4 + pop as i32);
                self.w.add_i32();
                self.set_gpr(4);
                self.flush();
                self.w.get_local(&value);
                self.goto_dynamic();
            },
            Form::JmpIndirect => {
                self.read_rm(i, 32, false);
                self.w.set_local(&value);
                self.flush();
                self.w.get_local(&value);
                self.goto_dynamic();
            },
            Form::CallIndirect => {
                // The target is read before the push (CALL [ESP], CALL ESP).
                self.read_rm(i, 32, false);
                self.w.set_local(&fb);
                self.w.const_i32(i.next_pc.0 as i32);
                self.w.set_local(&value);
                self.push(&value);
                self.flush();
                self.w.get_local(&fb);
                self.known = Known::None;
                self.goto_dynamic_at(false);
            },
        }
    }

    /// ECX's elements of a REP template into the core's statistics
    /// (runtime::tier0::ir_t0_note_rep), as the interpreter counts them
    fn note_rep(&mut self) {
        self.w.get_local(&self.gpr[1]);
        self.w
            .call_signature("ir_t0_note_rep", signature("ir_t0_note_rep"));
    }
    /// The template-kind profile (CompileEnv::kind_profile): one more
    /// execution of profile key `key`
    fn profile(&mut self, key: usize) {
        let Some(table) = self.env.kind_profile
        else {
            return;
        };
        let address = table + 8 * key as u32;
        self.w.const_i32(address as i32);
        self.w.const_i32(address as i32);
        self.w.load_unaligned_i64(0);
        self.w.const_i64(1);
        self.w.add_i64();
        self.w.store_unaligned_i64(0);
    }

    /// One instruction: a template (whose rare cases leave for the
    /// interpreter) or an interpreter fallback.
    fn instruction(&mut self, i: &Instruction, templated: &mut usize) {
        let form = classify(&i.decoded, self.env.features);
        self.profile(profile_key(form, &i.decoded));
        let Some(form) = form
        else {
            self.fallback(i);
            self.known = Known::None;
            return;
        };
        *templated += 1;
        self.context = (self.pending, i.offset);
        self.pending += 1;
        let before = self.w.body_len();
        if form.touches_flags_memory() {
            self.materialize();
        }
        if form.reads_x87_state() {
            self.x87_close();
        }
        // FLAGS and XMM state for retry tails: templates write them last.
        let flags_before = self.flags;
        let xmm_before = self.xmm_dirty;
        // Locals of the cache at the start (a block exit inside a control
        // template frees them; the tail runs before anything reuses them).
        let xmm_locals: [Option<WasmLocalV128>; 8] =
            std::array::from_fn(|r| self.xmm[r].as_ref().map(WasmLocalV128::unsafe_clone));
        // Retry sites of the instruction branch to one shared tail after it.
        let trampoline = form.may_retry(&i.decoded);
        let after = if trampoline {
            let after = self.w.block_void();
            self.retry_label = Some(self.w.block_void());
            Some(after)
        }
        else {
            None
        };
        self.template(form, &i.decoded);
        if let Some(after) = after {
            self.w.br(after);
            self.w.block_end();
            self.retry_label = None;
            let flags_after = std::mem::replace(&mut self.flags, flags_before);
            let xmm_after = std::mem::replace(&mut self.xmm_dirty, xmm_before);
            let cache_after = std::mem::replace(&mut self.xmm, xmm_locals);
            self.retry();
            self.flags = flags_after;
            self.xmm_dirty = xmm_after;
            // The snapshot aliases live (or already freed) locals: drop, not free.
            std::mem::forget(std::mem::replace(&mut self.xmm, cache_after));
            self.w.block_end();
        }
        crate::ir::runtime::tier0::note_template(form.kind(), self.w.body_len() - before);
    }
}

/// offset <- the function offset of the linear address on the stack (see
/// Page::set_offset_from_linear); locals are offset, far_eip, a scratch.
fn offset_from_linear(
    w: &mut WasmBuilder,
    runs: &[(u32, usize, usize)],
    page_linear: u32,
    span: u32,
    [offset, far_eip, scratch]: [&WasmLocal; 3],
) {
    if runs.len() == 1 {
        w.const_i32(page_linear as i32);
        w.sub_i32();
        w.set_local(offset);
        return;
    }
    w.set_local(far_eip);
    w.const_i32(span as i32);
    w.set_local(offset);
    for &(linear, start, bytes) in runs {
        w.get_local(far_eip);
        w.const_i32(linear as i32);
        w.sub_i32();
        w.tee_local(scratch);
        w.const_i32(bytes as i32);
        w.ltu_i32();
        w.if_void();
        w.get_local(scratch);
        w.const_i32(start as i32);
        w.add_i32();
        w.set_local(offset);
        w.block_end();
    }
}

/// Emit the units of one level: nested blocks in unit order (the first unit's
/// code comes first), entered through a br_table on `offset` (for a loop,
/// its header directly), each unit's code after its block's end.
fn emit_units(
    p: &mut Page,
    plan: &PagePlan,
    units: &[Unit],
    header: Option<u32>,
    repeat: Label,
    // Offsets outside this level: the enclosing level's dispatch (the page's
    // miss exit at the top).
    miss: Label,
    templated: &mut usize,
    instructions: &mut usize,
) {
    let n = plan.blocks.len();
    let mut unit_of = vec![u32::MAX; n];
    let mut single = vec![];
    let mut members = vec![];
    for (u, unit) in units.iter().enumerate() {
        let mut blocks = vec![];
        unit.blocks(&mut blocks);
        for &k in &blocks {
            unit_of[k as usize] = u as u32;
        }
        single.push(match unit {
            Unit::Block(k) => Some(*k),
            Unit::Loop { .. } => None,
        });
        members.extend(blocks);
    }
    // units[0] is innermost.
    let mut labels: Vec<Label> = units.iter().map(|_| p.w.block_void()).collect();
    labels.reverse();
    if let Some(h) = header {
        p.w.get_local(&p.offset);
        p.w.const_i32(p.starts[h as usize] as i32);
        p.w.eq_i32();
        p.w.br_if(labels[0]);
        // Return sites (reached by dynamic dispatch from RET) skip the
        // table: every unit's label encloses this dispatch.
        for &k in members
            .iter()
            .filter(|&&k| k != h && plan.return_site[k as usize])
            .take(4)
        {
            p.w.get_local(&p.offset);
            p.w.const_i32(p.starts[k as usize] as i32);
            p.w.eq_i32();
            p.w.br_if(labels[unit_of[k as usize] as usize]);
        }
    }
    let low = if header.is_some() {
        members.iter().map(|&k| p.starts[k as usize]).min().unwrap() as usize
    }
    else {
        0
    };
    let high = members.iter().map(|&k| p.starts[k as usize]).max().unwrap() as usize;
    let table: Vec<Label> = (low..=high)
        .map(|at| match plan.block_at[at] {
            Some(k) if unit_of[k as usize] != u32::MAX => labels[unit_of[k as usize] as usize],
            _ => miss,
        })
        .collect();
    p.w.get_local(&p.offset);
    if low != 0 {
        p.w.const_i32(low as i32);
        p.w.sub_i32();
    }
    p.w.brtable(miss, &mut table.iter());
    p.levels.push(Level {
        repeat,
        unit_of,
        labels: labels.clone(),
        emitted: vec![false; units.len()],
        single,
    });
    for (u, unit) in units.iter().enumerate() {
        p.w.block_end();
        p.levels.last_mut().unwrap().emitted[u] = true;
        match unit {
            Unit::Block(k) => {
                let block = &plan.blocks[*k as usize];
                p.pending = 0;
                p.known = Known::None;
                // Every way into a block has written its FLAGS and XMM state.
                p.flags = PendingFlags::default();
                p.xmm_reset();
                p.x87_known_open = false;
                p.current_page = block.start as u32 >> 12;
                // Instructions in (or running into) a later page: see
                // check_block_page.
                for page in p.current_page + 1..=(block.end() as u32 - 1) >> 12 {
                    p.check_block_page(page, block.start as u32);
                }
                let mut ended = false;
                let insts = &block.instructions;
                let mut j = 0;
                while j < insts.len() {
                    // A run of register-only x87 forms: one guard, f64 locals.
                    let mut run = X87Run::new();
                    while insts
                        .get(j + run.length)
                        .is_some_and(|i| x87run::append(&mut run, i))
                    {}
                    if run.length >= 3 && X87_RUNS {
                        p.x87_open();
                        let done = p.w.block_void();
                        let slow = p.w.block_void();
                        p.x87_run(&run, slow);
                        for i in &insts[j..j + run.length] {
                            let form = classify(&i.decoded, p.env.features);
                            p.profile(profile_key(form, &i.decoded));
                        }
                        p.w.br(done);
                        p.w.block_end();
                        for i in &insts[j..j + run.length] {
                            *instructions += 1;
                            p.instruction(i, templated);
                        }
                        p.w.block_end();
                        p.x87_known_open = false;
                        j += run.length;
                        ended = false;
                        continue;
                    }
                    let i = &insts[j];
                    j += 1;
                    *instructions += 1;
                    // An interpreted instruction leaves the block too (see fallback).
                    let control = classify(&i.decoded, p.env.features).map_or(true, Form::control);
                    p.instruction(i, templated);
                    ended = control;
                }
                if !ended {
                    p.flush();
                    let last = block.instructions.last().unwrap();
                    p.goto_linear(
                        p.slots
                            .linear(last.offset as usize)
                            .wrapping_add(last.decoded.length as u32),
                    );
                }
            },
            Unit::Loop { header, units } => {
                let inner = p.w.loop_void();
                p.poll_check();
                emit_units(
                    p,
                    plan,
                    units,
                    Some(*header),
                    inner,
                    repeat,
                    templated,
                    instructions,
                );
                p.w.block_end();
            },
        }
    }
    p.levels.pop();
}

pub fn emit_page(
    plan: &PagePlan,
    entries: &[CpuEntryKey],
    flat: bool,
    hosts: &[u32],
    env: &CompileEnv,
) -> Emitted {
    let page_linear = plan.slots.pages[0];
    let runs = plan.slots.runs();
    let mut w = WasmBuilder::new();
    // The result is the linear EIP left for when a link is requested (see
    // cache::t0_execute; other returns leave 0).
    w.set_entry_result();
    w.set_function_name(format!("t0_{:x}", entries[0].linear.0 & !4095));
    // The argument is the chain depth (0 from the CPU dispatcher, see
    // cache::ir_t0_chain). A foreign context returns before any state change.
    let depth = w.arg_local_initial_state.unsafe_clone();
    // Any block start of the page is a valid entry: exact served entries and
    // page witnesses (cache::fast_probe) only admit offsets in page_blocks.
    w.load_fixed_i32(gp::instruction_pointer as u32);
    let offset = w.set_new_local();
    let cs_base = entries[0].cs_base();
    // Chained entries (depth > 0) were checked by cache::ir_t0_chain.
    w.get_local(&depth);
    w.eqz_i32();
    w.if_void();
    w.const_i32(cs_base as i32);
    w.const_i32(i32::from(entries[0].default_32));
    w.call_signature("ir_enter_page", signature("ir_enter_page"));
    w.eqz_i32();
    w.if_void();
    w.const_i32(0);
    w.return_();
    w.block_end();
    w.block_end();
    if flat {
        // Entered in another state: interpret one instruction (progress for
        // the CPU loop) and return. Within an activation the state only
        // changes through interpreter steps, which then exit (runtime::tier0).
        let required = (CachedStateFlags::MASK_FLAT_SEGS | CachedStateFlags::MASK_SS32) as i32;
        w.load_fixed_u8(gp::state_flags as u32);
        w.const_i32(required);
        w.and_i32();
        w.const_i32(required);
        w.ne_i32();
        w.hint(false);
        w.if_void();
        w.const_i32(-1);
        w.call_signature(
            "ir_t0_step",
            Signature::new(&[WasmType::I32], &[WasmType::I32]),
        );
        w.drop_();
        w.const_i32(gp::instruction_counter as i32);
        w.load_fixed_i32(gp::instruction_counter as u32);
        w.const_i32(1);
        w.add_i32();
        w.store_aligned_i32(0);
        w.const_i32(0);
        w.return_();
        w.block_end();
    }

    let gpr: Vec<WasmLocal> = (0..8)
        .map(|r| {
            w.load_fixed_i32(gp::reg32 as u32 + 4 * r);
            w.set_new_local()
        })
        .collect();
    w.load_fixed_i32(gp::ir_tlb_base as u32);
    let tlb = w.set_new_local();
    // Kernel mode may use supervisor pages: then NO_USER is not a failure bit.
    w.load_fixed_u8(gp::cpl as u32);
    w.const_i32(3);
    w.eq_i32();
    let user = w.set_new_local();
    for f in [tlb_read_mask, tlb_write_mask] {
        w.const_i32(f(true));
        w.const_i32(f(false));
        w.get_local(&user);
        w.select();
    }
    w.free_local(user);
    let write_mask = w.set_new_local();
    let read_mask = w.set_new_local();
    let mut locals = vec![];
    for _ in 0..18 {
        locals.push(w.declare_zeroed_local());
    }
    let wide = w.declare_zeroed_local_i64();
    let quotient = w.declare_zeroed_local_i64();
    let retired = w.declare_zeroed_local();
    let committed = w.declare_zeroed_local();
    // The VEX guard's condition once per activation: a step changing CR0,
    // CR4, XCR0 (XSETBV's admission barrier) or the mode leaves it
    // (runtime::tier0::ir_t0_step)
    let vex_fault = plan
        .blocks
        .iter()
        .flat_map(|b| &b.instructions)
        .any(|i| simd::classify_vex(&i.decoded).is_some())
        .then(|| {
            simd::vex_fault(&mut w);
            w.set_new_local()
        });

    // offset holds the entry EIP.
    let span = plan.block_at.len() as u32;
    let far_eip = locals.pop().unwrap();
    let eip = locals.pop().unwrap();
    w.get_local(&offset);
    offset_from_linear(&mut w, &runs, page_linear, span, [&offset, &far_eip, &eip]);
    let exit_link = w.block_void();
    let dispatch = w.loop_void();
    let mut p = Page {
        w,
        page_linear,
        slots: plan.slots.clone(),
        runs,
        far_eip,
        eip,
        cs_base,
        gpr,
        tlb,
        read_mask,
        write_mask,
        offset,
        result: locals.pop().unwrap(),
        fa: locals.pop().unwrap(),
        fb: locals.pop().unwrap(),
        fr: locals.pop().unwrap(),
        addr: locals.pop().unwrap(),
        host: locals.pop().unwrap(),
        value: locals.pop().unwrap(),
        tmp: locals.pop().unwrap(),
        wide,
        quotient,
        dispatch,
        retired,
        committed,
        pending: 0,
        known: Known::None,
        block_at: plan.block_at.clone(),
        starts: plan.blocks.iter().map(|b| b.start).collect(),
        span: plan.block_at.len() as u32,
        hosts: hosts.to_vec(),
        env: *env,
        current_page: 0,
        levels: vec![],
        exit: exit_link,
        step: exit_link, // set below
        context: (0, 0),
        retry_label: None,
        flags: PendingFlags::default(),
        xmm: Default::default(),
        xmm_dirty: 0,
        fp_mxcsr: None,
        xmm_clean: [0; 8],
        simd_checked: 0,
        vex_fault,
        ymm_zeroed: 0,
        vex: None,
        x87: X87Cache {
            top: locals.pop().unwrap(),
            tags: locals.pop().unwrap(),
            valid: locals.pop().unwrap(),
            dirty: locals.pop().unwrap(),
        },
        x87_is_open: locals.pop().unwrap(),
        x87_known_open: false,
        p_op1: locals.pop().unwrap(),
        p_result: locals.pop().unwrap(),
        p_word: locals.pop().unwrap(),
        gpr_written: 0,
        sync_stores: vec![],
        flat,
    };
    p.poll_check();
    p.w.get_local(&p.offset);
    p.w.const_i32(p.span as i32);
    p.w.geu_i32();
    p.w.br_if(exit_link);

    let step = p.w.block_void();
    p.step = step;
    let miss = p.w.block_void();
    let mut templated = 0;
    let mut instructions = 0;
    let units = analysis::layout(plan);
    emit_units(
        &mut p,
        plan,
        &units,
        None,
        dispatch,
        miss,
        &mut templated,
        &mut instructions,
    );
    p.xmm_reset();
    p.w.block_end(); // miss: not a block start in this page
    p.w.br(exit_link);
    p.w.block_end(); // step: interpret the instruction at offset
    p.sync_out();
    p.x87_close();
    p.commit_count();
    p.w.const_i32(gp::instruction_pointer as i32);
    p.push_exit_eip();
    p.w.store_aligned_i32(0);
    // No "next" continuation: every outcome but an exit dispatches on EIP.
    p.w.const_i32(-1);
    p.w.call_signature(
        "ir_t0_step",
        Signature::new(&[WasmType::I32], &[WasmType::I32]),
    );
    p.add_count(1);
    p.w.const_i32(STEP_EXIT);
    p.w.eq_i32();
    p.w.if_void();
    p.commit_count();
    p.w.const_i32(0);
    p.w.return_();
    p.w.block_end();
    p.sync_in();
    p.w.load_fixed_i32(gp::instruction_pointer as u32);
    p.set_offset_from_linear();
    p.check_offset_page();
    p.w.br(dispatch);
    p.w.block_end(); // dispatch loop
    p.w.block_end(); // exit_link: EIP outside this page or not a block start
    p.sync_out();
    p.x87_close();
    p.commit_count();
    p.w.const_i32(gp::instruction_pointer as i32);
    p.push_exit_eip();
    p.w.store_aligned_i32(0);
    // Continue in the page function serving the target, if any.
    match p.env.link {
        Link::Tail => {
            p.w.call_signature("ir_t0_link", signature("ir_t0_link"));
            p.w.tee_local(&p.tmp);
            p.w.const_i32(0);
            p.w.ge_i32();
            p.w.if_void();
            p.w.const_i32(1);
            p.w.get_local(&p.tmp);
            p.w.return_call_indirect_fn1();
            p.w.block_end();
        },
        Link::Nested => {
            p.w.get_local(&depth);
            p.w.call_signature("ir_t0_chain", signature("ir_t0_chain"));
            p.w.if_void();
            p.w.const_i32(0);
            p.w.return_();
            p.w.block_end();
        },
        Link::Iterative => {},
    }
    p.request_exit(ExitKind::Normal);
    p.push_exit_eip();
    for &(start, end, r) in &p.sync_stores {
        if p.gpr_written & 1 << r == 0 {
            p.w.patch_nop(start, end);
        }
    }
    let Page {
        mut w,
        gpr,
        tlb,
        read_mask,
        write_mask,
        offset,
        result,
        fa,
        fb,
        fr,
        addr,
        host,
        value,
        tmp,
        wide,
        quotient,
        retired,
        committed,
        p_op1,
        p_result,
        p_word,
        x87,
        x87_is_open,
        far_eip,
        eip,
        vex_fault,
        ..
    } = p;
    for local in gpr.into_iter().chain([
        tlb,
        read_mask,
        write_mask,
        offset,
        result,
        fa,
        fb,
        fr,
        addr,
        host,
        value,
        tmp,
        retired,
        committed,
        p_op1,
        p_result,
        p_word,
        x87.top,
        x87.tags,
        x87.valid,
        x87.dirty,
        x87_is_open,
        far_eip,
        eip,
    ]) {
        w.free_local(local);
    }
    if let Some(local) = vex_fault {
        w.free_local(local);
    }
    w.free_local_i64(wide);
    w.free_local_i64(quotient);
    w.finish();
    Emitted {
        bytes: w.output().to_vec(),
        locals: w.declared_local_count(),
        templated,
        instructions,
    }
}
