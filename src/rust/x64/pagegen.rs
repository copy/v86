//! x64 page tier: one Wasm function per 4 KiB page of long-mode code.
//!
//! The function serves every compiled block start of its page. A dispatch
//! loop branches (br_table over the page offset) to a block; blocks continue
//! into each other without returning to the CPU loop. The 16 GPRs, EFLAGS
//! and RIP live in locals and are written back at every exit and around
//! interpreter steps, so memory is authoritative whenever Rust code runs.
//!
//! Templates cover the frequent integer forms. Everything else, and any
//! template precondition that fails at run time, has the wide interpreter's
//! exact behavior:
//! - step: the instruction is interpreted in place by `x64_page_step`, then
//!   the function dispatches on the new RIP (or returns if the step changed
//!   the execution context).
//! - retry: a memory access missing the access cache (x64::jac) that
//!   `x64_page_access` cannot serve (fault, device, page with compiled code,
//!   page crossing) leaves the function with RIP at the instruction and none
//!   of its effects; the runtime interprets it.
//! EFLAGS arithmetic bits are only computed where a later reader can observe
//! them (page-local liveness; exits and steps read all of them). Condition
//! consumers after CMP/SUB/TEST-like producers in the same block compare the
//! producer's operands directly.
//!
//! The tier also compiles 32-bit compatibility- and legacy-mode code (P7.2,
//! P7.3), which IR Tier-0 compiled until P7.5 deleted it: comments that
//! compare with "Tier-0" describe that code as it was.
use super::decode::{self, AddressBase, AddressExpr, ByteRegister, Decoded};
use super::jac;
use super::loops::Unit;
use super::state::{gpr_high_offset, gpr_low_offset, ExecutionMode, GuestIp};
use crate::cpu::cpu::{
    TLB_GLOBAL, TLB_HAS_CODE, TLB_IA32E_DATA, TLB_NO_USER, TLB_READONLY, TLB_VALID,
};
use crate::cpu::global_pointers as gp;
use crate::wasmgen::leaves::{self, Shift};
use crate::wasmgen::wasm_builder::{
    Label, Signature, WasmBuilder, WasmLocal, WasmLocalI64, WasmLocalV128, WasmType,
};
use crate::wasmgen::wasm_opcodes as op;
use crate::x86tpl::vec::{self, Packed};
use crate::x86tpl::x87::{x87_native, X87Cache, X87Words};
use crate::x86tpl::x87run::{x87_run, X87Run};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// x64_pagegen_size_stats: Wasm bytes emitted per template kind (count,
/// bytes), for code size work
static mut SIZE_STATS: Option<HashMap<String, (u64, u64)>> = None;
fn size_note(name: String, bytes: usize) {
    unsafe {
        if let Some(stats) = (*(&raw mut SIZE_STATS)).as_mut() {
            let entry = stats.entry(name).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += bytes as u64;
        }
    }
}
#[no_mangle]
pub fn x64_pagegen_size_stats(enabled: bool) { unsafe { SIZE_STATS = enabled.then(HashMap::new) }; }
#[no_mangle]
pub fn x64_pagegen_size_dump() {
    unsafe {
        if let Some(stats) = (*(&raw const SIZE_STATS)).as_ref() {
            let mut rows: Vec<_> = stats.iter().collect();
            rows.sort_by_key(|(_, &(_, bytes))| std::cmp::Reverse(bytes));
            let total: u64 = rows.iter().map(|(_, &(_, b))| b).sum();
            for (name, &(count, bytes)) in rows.iter().take(40) {
                console_log!(
                    "X64_PAGEGEN_SIZE {} count {} bytes {} ({:.1}%) avg {:.1}",
                    name,
                    count,
                    bytes,
                    100.0 * bytes as f64 / total as f64,
                    bytes as f64 / count as f64
                );
            }
        }
    }
}

/// Why a page function returned (gp::x64_page_exit).
pub const EXIT_NORMAL: u32 = 0;
/// Interpret the instruction at RIP: a template precondition failed before
/// any of its effects.
pub const EXIT_RETRY: u32 = 1;
/// RIP is inside the page but not a compiled block start.
pub const EXIT_UNKNOWN: u32 = 2;
/// x64_page_step results.
pub const STEP_CONTINUE: i32 = 0;
/// The step changed CS but nothing else the function depends on (far calls
/// and returns in code compiled for segment bases, P7.7; M11: or also the
/// mode among those, pages::x64_page_step switching the chaining table): it
/// leaves through the chaining table, to the function of the new RIP, whose
/// prologue checks CS's base in 16-bit code
pub const STEP_CHAIN: i32 = 1;
pub const STEP_EXIT: i32 = 2;

const PAGE: usize = 4096;
/// The consecutive linear pages a legacy-mode function may cover
/// (docs/jit-unification-plan.md P7.3b; CompileEnv::span)
pub const MAX_SPAN: usize = 16;
/// Offsets of a page's volatile instructions a compile takes at most
/// (CompileEnv::volatile)
pub const MAX_VOLATILE: usize = 16;
/// Decoded instructions per page function, including overlapping decodes.
const MAX_INSTRUCTIONS: usize = 3072;
/// An entry of compile's that is a guess (pages.rs: a likely function start
/// after INT3 padding): a block start unless decoded code runs straight into
/// it, where the 0xCC before it was an instruction's last byte
pub const GUESSED: u16 = 0x8000;

const CF: u32 = 1;
const PF: u32 = 4;
const AF: u32 = 0x10;
const ZF: u32 = 0x40;
const SF: u32 = 0x80;
const OF: u32 = 0x800;
const ARITH: u32 = CF | PF | AF | ZF | SF | OF;

fn mask(w: u8) -> u64 {
    if w == 64 {
        u64::MAX
    }
    else {
        (1u64 << w) - 1
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Reg {
    index: u8,
    /// AH, CH, DH or BH (no REX)
    high: bool,
}
#[derive(Clone, Copy, Debug)]
enum Opnd {
    Reg(Reg),
    Mem(AddressExpr),
    Imm(u64),
}
impl Opnd {
    fn reg(self) -> Option<Reg> {
        if let Opnd::Reg(r) = self {
            Some(r)
        }
        else {
            None
        }
    }
}
/// An XMM register (0..15) or a memory operand of an SSE instruction.
#[derive(Clone, Copy, Debug)]
enum Xmm {
    Reg(u8),
    Mem(AddressExpr),
}
/// Op::Mmx's forms (Xmm::Reg: an MM register here)
#[derive(Clone, Copy, Debug)]
enum MmxForm {
    /// MOVQ mm, mm/m64
    Load {
        reg: u8,
        src: Xmm,
    },
    /// MOVQ mm/m64, mm
    Store {
        reg: u8,
        dst: Xmm,
    },
    /// MOVD mm, r/m32
    MovdIn {
        reg: u8,
        src: Opnd,
    },
    /// MOVD r/m32, mm
    MovdOut {
        reg: u8,
        dst: Opnd,
    },
    /// the packed forms and PSHUFW; `bytes` of a memory source (PUNPCKL*:
    /// 4)
    Packed {
        op: Packed,
        reg: u8,
        src: Xmm,
        bytes: u8,
    },
    /// PSRLW/PSRAW/PSLLW and the D, Q forms by an immediate
    Shift {
        reg: u8,
        bits: u8,
        kind: u8,
        count: u8,
    },
    Emms,
}
/// Op::Bmi's operations
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    /// RORX by imm8 (no flags)
    Rorx(u8),
}
#[derive(Clone, Copy, Debug)]
enum Op {
    /// ADD OR ADC SBB AND SUB XOR CMP (x86 /digit order)
    Alu {
        code: u8,
        width: u8,
        dst: Opnd,
        src: Opnd,
    },
    Test {
        width: u8,
        a: Opnd,
        b: Opnd,
    },
    Mov {
        width: u8,
        dst: Opnd,
        src: Opnd,
    },
    Extend {
        width: u8,
        from: u8,
        signed: bool,
        dst: Reg,
        src: Opnd,
    },
    Lea {
        width: u8,
        dst: Reg,
        address: AddressExpr,
    },
    IncDec {
        dec: bool,
        width: u8,
        dst: Opnd,
    },
    Neg {
        width: u8,
        dst: Opnd,
    },
    Not {
        width: u8,
        dst: Opnd,
    },
    /// ROL ROR - - SHL SHR SAL SAR; `count` None is CL.
    Shift {
        code: u8,
        width: u8,
        dst: Opnd,
        count: Option<u8>,
    },
    /// Shifts and rotates without a template (8/16-bit by CL, RCL/RCR up to
    /// 32 bits): the interpreter's semantics through x64_page_shift
    ShiftCall {
        code: u8,
        width: u8,
        dst: Opnd,
        count: Option<u8>,
    },
    Imul {
        width: u8,
        dst: Reg,
        a: Opnd,
        b: Opnd,
    },
    MulWide {
        signed: bool,
        width: u8,
        src: Opnd,
    },
    Push {
        src: Opnd,
    },
    Pop {
        dst: Reg,
    },
    // Legacy mode's further templates (legacy_template, P7.3):
    /// LOOPNE, LOOPE, LOOP or JECXZ (`kind` 0-3); CX with a 16-bit address
    /// size
    LoopJump {
        kind: u8,
        cx: bool,
        target: u64,
    },
    /// MOV ES/DS/FS/GS, r/m16 (Emitter::load_segment)
    LoadSreg {
        segment: u8,
        src: Opnd,
    },
    /// POP ES/DS/FS/GS with a `width` operand
    PopSreg {
        segment: u8,
        width: u8,
    },
    /// PUSH Sreg with a `width` operand (a 32-bit one writes the low 16 bits
    /// of its slot, as cpu::misc_instr::push32_sreg)
    PushSreg {
        segment: u8,
        width: u8,
    },
    /// PUSH and POP with a 16-bit operand size
    Push16 {
        src: Opnd,
    },
    Pop16 {
        dst: Opnd,
    },
    /// POP m32: the address computed with ESP after the pop
    PopMem {
        address: AddressExpr,
    },
    /// 16-bit code (P7.7): PUSH and POP with a 32-bit operand size
    Push32 {
        src: Opnd,
    },
    Pop32 {
        dst: Opnd,
    },
    /// 16-bit code: LES and LDS (`segment` ES or DS), the offset of `width`
    /// bits and the selector after it at `address`
    LoadFar {
        segment: u8,
        width: u8,
        dst: Reg,
        address: AddressExpr,
    },
    /// 16-bit code: ENTER size, 0
    Enter {
        size: u16,
    },
    /// 16-bit code: LODS with 16-bit addresses (SI)
    Lods16 {
        width: u8,
        segment: u8,
    },
    /// Far CALL ptr16:16 or ptr16:32 and RETF (imm16) in code compiled for
    /// segment bases (M11): pages::x64_page_far, then through the chaining
    /// table
    FarCall {
        selector: u16,
        offset: u32,
        width: u8,
    },
    FarRet {
        pop: u16,
        width: u8,
    },
    /// PUSHAD and POPAD, whose 32 bytes are in one page (else a retry)
    Pusha,
    Popa,
    /// LODS without REP: AL, AX or EAX from `segment`:ESI
    Lods {
        width: u8,
        segment: u8,
    },
    Pushf,
    Leave,
    Call {
        target: u64,
    },
    CallIndirect {
        src: Opnd,
    },
    Ret {
        pop: u16,
    },
    Jmp {
        target: u64,
    },
    JmpIndirect {
        src: Opnd,
    },
    Jcc {
        cc: u8,
        target: u64,
    },
    Cmov {
        cc: u8,
        width: u8,
        dst: Reg,
        src: Opnd,
    },
    Setcc {
        cc: u8,
        dst: Opnd,
    },
    Xchg {
        width: u8,
        a: Opnd,
        b: Reg,
    },
    Xadd {
        width: u8,
        dst: Opnd,
        src: Reg,
    },
    Cmpxchg {
        width: u8,
        dst: Opnd,
        src: Reg,
    },
    /// CBW/CWDE/CDQE
    SignAcc {
        width: u8,
    },
    /// CWD/CDQ/CQO
    SignDx {
        width: u8,
    },
    /// BT BTS BTR BTC
    Bt {
        action: u8,
        width: u8,
        dst: Opnd,
        index: Opnd,
    },
    BitScan {
        reverse: bool,
        width: u8,
        dst: Reg,
        src: Opnd,
    },
    Popcnt {
        width: u8,
        dst: Reg,
        src: Opnd,
    },
    Bswap {
        width: u8,
        reg: u8,
    },
    /// BMI1 and BMI2's VEX forms, TZCNT and LZCNT on 32- and 64-bit
    /// operands (cpu::bmi): `dst` = `op`(`src`, `other`), where `other` is
    /// VEX.vvvv (ANDN's first source, BZHI's index, the shifts' count); the
    /// destination of BLSR, BLSMSK and BLSI is VEX.vvvv
    Bmi {
        op: BmiOp,
        width: u8,
        dst: Reg,
        src: Opnd,
        other: Reg,
    },
    /// FMA's VEX.128 and scalar forms (P11) through
    /// x64::helpers::x64_fma (`op` the opcode byte, `double` VEX.W1)
    Vfused {
        op: u8,
        double: bool,
        dst: u8,
        first: u8,
        src: Xmm,
    },
    /// MOVBE r, m (`load`) or m, r: one access, its bytes reversed
    Movbe {
        load: bool,
        width: u8,
        reg: Reg,
        mem: AddressExpr,
    },
    /// CMC CLC STC CLD STD by opcode
    Flag {
        opcode: u8,
    },
    Lahf,
    Sahf,
    Nop,
    Cli,
    /// STI ends the activation: the next instruction runs in the interrupt
    /// shadow in the interpreter.
    Sti,
    /// STI with the instruction in its shadow compiled after it in its block
    /// (x64_sti_shadow), which ends in End::Shadow.
    StiShadowed,
    Swapgs,
    Rdtsc,
    /// DIV/IDIV r/m32/64 whose quotient fits (else retried: #DE or a wide
    /// dividend).
    Div {
        signed: bool,
        width: u8,
        src: Opnd,
    },
    /// MOVS/STOS with 64-bit addresses and no FS/GS source; with REP only
    /// inside one page per operand, forward, RAX 0 for wide STOS.
    Movs {
        width: u8,
        rep: bool,
    },
    Stos {
        width: u8,
        rep: bool,
    },
    /// REPE/REPNE CMPS (SCAS: `scan`) with 64-bit addresses and no FS/GS
    /// source: natively inside one page per operand, forward (else a step)
    RepCompare {
        width: u8,
        scan: bool,
        equal: bool,
    },
    MovSreg {
        segment: u8,
        width: u8,
        dst: Opnd,
    },
    /// Compatibility mode's MMX (P7.2a, as Tier-0's: x86tpl::mmx, the packed
    /// templates at 8 bytes); the MM registers alias the x87 stack
    Mmx {
        form: MmxForm,
    },
    /// Compatibility mode's SHLD/SHRD r/m32, r32, CL (P7.2)
    DoubleShiftCl {
        left: bool,
        dst: Opnd,
        src: Reg,
    },
    /// SHLD/SHRD r/m32/64, r, imm8
    DoubleShift {
        left: bool,
        width: u8,
        dst: Opnd,
        src: Reg,
        count: u8,
    },
    /// CMPXCHG16B (wide) / CMPXCHG8B
    CompareExchange {
        wide: bool,
        address: AddressExpr,
    },
    /// SSE moves of the low `bits` (32, 64 or 128). Register destinations
    /// keep their other bits unless `zero` (always for 32/64-bit loads), or
    /// take them from `upper` (VMOVSS/VMOVSD between registers: VEX.vvvv);
    /// `aligned` memory operands must be 16-byte aligned (else #GP, retried).
    ///
    /// The vector templates serve the VEX forms too (see vex): their
    /// `first` source is read where the legacy forms read the destination
    /// (VEX.vvvv; the legacy forms' `first` is their `dst`), a register
    /// destination's bits 255:128 are zeroed (Emitter::vex_upper), and only
    /// the aligned moves check alignment.
    Vmove {
        bits: u8,
        dst: Xmm,
        src: Xmm,
        aligned: bool,
        zero: bool,
        upper: Option<u8>,
    },
    /// 128-bit AND ANDN OR XOR (PS/PD/integer forms) of `first` and `src`;
    /// legacy memory is aligned.
    Vlogic {
        code: u8,
        dst: u8,
        first: u8,
        src: Xmm,
    },
    /// ADD MUL SUB DIV (`code` 0x58 0x59 0x5C 0x5E) of single or double
    /// precision lanes: packed (legacy memory aligned) or scalar (the low
    /// lane; the others from `first`). See Emitter::vfp for when it runs
    /// natively. With x64_sse_fast_check (P4.18) also SQRT (0x51), RSQRT
    /// (0x52), RCP (0x53), MIN (0x5D) and MAX (0x5F), all through
    /// x86tpl::ops::float.
    Vfp {
        code: u8,
        double: bool,
        packed: bool,
        dst: u8,
        first: u8,
        src: Xmm,
    },
    /// MOVD/MOVQ xmm, r/m32/64 (upper bits cleared)
    MovdIn {
        width: u8,
        dst: u8,
        src: Opnd,
    },
    /// MOVD/MOVQ r/m32/64, xmm
    MovdOut {
        width: u8,
        dst: Opnd,
        src: u8,
    },
    /// SSE2 packed integer, shuffle and unpack forms with Wasm SIMD (the
    /// semantics of cpu::sse_instr, as ir::tier0::simd): dst = op(first,
    /// src). Memory sources are 128 bits and legacy ones must be aligned
    /// (else #GP, retried).
    Vpacked {
        op: Packed,
        dst: u8,
        first: u8,
        src: Xmm,
    },
    /// PCMPESTRM/PCMPESTRI/PCMPISTRM/PCMPISTRI (SSE4.2; `op` the 66 0F 3A
    /// byte) through x64_page_pcmpstr on the operand block; the lengths are
    /// RAX/RDX with REX.W (`wide`), else EAX/EDX. RCX (ECX, zero-extended)
    /// or XMM0, and the arithmetic flags. An m128 needs no alignment.
    Vstrings {
        op: u8,
        imm8: u8,
        wide: bool,
        dst: u8,
        src: Xmm,
    },
    /// ROUNDPS/ROUNDPD/ROUNDSS/ROUNDSD (SSE4.1) with Wasm SIMD, as
    /// ir::tier0::simd's Round: retried in the interpreter for a NaN lane,
    /// MXCSR.DAZ, MXCSR.RC other than nearest with imm8[2], and an inexact
    /// lane whose PE is reported and unmasked; PE is set here. Memory: a
    /// scalar form's lane, or an aligned m128.
    Vround {
        double: bool,
        scalar: bool,
        imm8: u8,
        dst: u8,
        first: u8,
        src: Xmm,
    },
    /// PSRLW/D/Q PSRAW/D PSLLW/D/Q xmm, imm8 (`kind` is the ModRM reg), and
    /// PSRLDQ/PSLLDQ (`bits` 128): dst = src shifted (VEX: dst is VEX.vvvv,
    /// src the r/m register; legacy: the same register); `wide`: AVX2's
    /// VEX.256 forms, each half alike
    VshiftImm {
        dst: u8,
        src: u8,
        bits: u8,
        kind: u8,
        count: u8,
        wide: bool,
    },
    /// VZEROUPPER: bits 255:128 of YMM0-15 zeroed
    Vzeroupper,
    /// VMOVUPS/UPD/DQU, VMOVAPS/APD/DQA (`aligned`: 32-byte) and
    /// VMOVNTPS/PD/DQ with VEX.256: all 32 bytes (a store's operand checked
    /// whole before it is written)
    Vmove256 {
        dst: Xmm,
        src: Xmm,
        aligned: bool,
    },
    /// VZEROALL: YMM0-15 zeroed
    Vzeroall,
    /// AVX2's packed integer forms (VEX.256, P7): `op` on each half of
    /// `first` (VEX.vvvv) and ymm/m256 (not the shifts by xmm/m128)
    Vpacked256 {
        op: Packed,
        dst: u8,
        first: u8,
        src: Xmm,
    },
    /// VINSERTF128, VINSERTI128: `first` (VEX.vvvv) with its `high` or low
    /// half replaced by xmm/m128
    Vinsert128 {
        dst: u8,
        first: u8,
        src: Xmm,
        high: bool,
    },
    /// VPERM2F128, VPERM2I128: each half of the destination is a half of
    /// `first` (VEX.vvvv) or of ymm/m256, or zero, as imm8 selects
    Vperm2 {
        dst: u8,
        first: u8,
        src: Xmm,
        imm8: u8,
    },
    /// VPMOVMSKB, VMOVMSKPS, VMOVMSKPD r32/r64, ymm: the sign bits of both
    /// halves' `lane`-byte lanes, zero-extended
    Vmovmsk256 {
        dst: Reg,
        src: u8,
        lane: u8,
    },
    /// VBROADCASTSS/SD (AVX2: also from a register), VPBROADCASTB/W/D/Q: the
    /// element (`bytes`) of memory or of a register's low lane in each lane
    /// of an XMM register (bits 255:128 zeroed) or (`wide`) a YMM register
    Vbroadcast {
        bytes: u8,
        dst: u8,
        src: Xmm,
        wide: bool,
    },
    /// PMOVMSKB MOVMSKPS MOVMSKPD r32/r64, xmm (and their VEX forms): the
    /// sign bits of the `lane`-byte lanes, zero-extended
    Vmovmsk {
        dst: Reg,
        src: u8,
        lane: u8,
    },
    /// CMPPS CMPPD CMPSS CMPSD with `predicate` (imm8[2:0]; VEX imm8[4:0]):
    /// for operands neither NaN nor denormal (else retried), which raise
    /// nothing and whose result imm8[2:0]'s relation decides; a scalar
    /// form's other lanes from `first`
    Vcmp {
        double: bool,
        scalar: bool,
        predicate: u8,
        dst: u8,
        first: u8,
        src: Xmm,
    },
    /// BLENDVPS BLENDVPD PBLENDVB: `src`'s lanes of `lane` bytes whose sign
    /// bit in XMM `mask` (XMM0; VEX imm8[7:4]) is set, else `first`'s
    Vblendv {
        lane: u8,
        dst: u8,
        first: u8,
        src: Xmm,
        mask: u8,
    },
    /// The packed conversions of x86tpl::ops (P2.5, switch x64_cvt; the
    /// decoder steps them while it is off): CVTPS2PD, CVTPD2PS, CVTDQ2PS,
    /// CVTDQ2PD, CVT(T)PS2DQ and CVT(T)PD2DQ
    Vcvt {
        op: Cvt,
        dst: u8,
        src: Xmm,
    },
    /// The scalar conversions (see Emitter::vconvert): retried unless exact
    /// or only inexact, MXCSR to nearest with every exception masked
    Vconvert {
        convert: Convert,
        dst: u8,
        first: u8,
    },
    /// COMISS UCOMISS COMISD UCOMISD: natively when neither operand is a NaN
    /// or a denormal, which leaves MXCSR unchanged; else retried.
    Vcompare {
        double: bool,
        dst: u8,
        src: Xmm,
    },
    /// INVLPG m (CPL 0; see pages::x64_page_invlpg)
    Invlpg {
        address: AddressExpr,
    },
    /// LDMXCSR (`load`) / STMXCSR m32
    Mxcsr {
        load: bool,
        address: AddressExpr,
    },
    /// MOV r64, CR0/CR2/CR3/CR4 (CPL 0)
    ReadCr {
        control: u8,
        reg: Reg,
    },
    /// MOV r64, CR8 / MOV CR8, r64 (the local APIC's TPR)
    Cr8 {
        write: bool,
        reg: Reg,
    },
    Rdtscp,
    /// Compatibility mode's x87 (docs/jit-unification-plan.md P7.2a): a
    /// form crate::x86tpl::x87_forms classifies, its memory operand at `address`,
    /// inlined in f64 against the shadow cache (x86tpl::x87) where it
    /// applies and the fast-math policy allows, else ir_t0_x87 on the CPU
    /// state, as Tier-0 runs it
    X87 {
        opcode: u8,
        modrm: u8,
        io: crate::x86tpl::x87_forms::Io,
        address: Option<AddressExpr>,
    },
    /// FNSTSW AX
    Fnstsw,
    /// FCOMI, FCOMIP, FUCOMI, FUCOMIP: `name`'s helper on the CPU state
    /// sets ZF, PF and CF (and clears OF, SF, AF)
    X87Flags {
        name: &'static str,
        r: u8,
    },
    /// FCMOVcc ST(0), ST(r)
    Fcmov {
        cc: u8,
        r: u8,
    },
    /// Interpreted in place by x64_page_step.
    Step,
}

/// Op::Vcvt's conversions
#[derive(Clone, Copy, Debug)]
enum Cvt {
    /// One Wasm operation (x86tpl::ops::convert): its opcode, the bytes of
    /// the source and of the result
    Convert { opcode: u32, source: u8, result: u8 },
    /// CVT(T)PS2DQ and CVT(T)PD2DQ (x86tpl::ops::convert_to_integers)
    Integers { double: bool, truncate: bool },
}

/// The scalar conversions of Op::Vconvert
#[derive(Clone, Copy, Debug)]
enum Convert {
    /// CVTSI2SS/CVTSI2SD xmm, r/m32/64 (`width`) into the low lane
    FromInteger { double: bool, width: u8, src: Opnd },
    /// CVT(T)SS2SI/CVT(T)SD2SI r32/r64 (`width`; Op::Vconvert's `dst` the
    /// general-purpose register), xmm/m32/m64
    ToInteger {
        double: bool,
        truncate: bool,
        width: u8,
        src: Xmm,
    },
    /// CVTSS2SD (`double`: to double precision) and CVTSD2SS xmm, xmm/m
    Precision { double: bool, src: Xmm },
}

/// x86tpl's packed SSE4 forms but PMULDQ, which this tier steps (its
/// template is Tier-0's alone so far)
fn sse4_packed(opcode: u32, imm8: Option<u64>) -> Option<Packed> {
    vec::sse4_packed(opcode, imm8.map(|imm| imm as u32)).filter(|_| opcode != 0x660F3828)
}

/// PALIGNR xmm, xmm/m128, imm8 (x86tpl::vec::palignr)
fn palignr(imm8: u64) -> Packed { vec::palignr(imm8.min(255) as u8, 16) }

fn register(encoded: u8, width: u8, rex: bool) -> Reg {
    if width == 8 {
        match decode::byte_register(encoded, rex) {
            ByteRegister::Low(index) => Reg { index, high: false },
            ByteRegister::HighLegacy(index) => Reg { index, high: true },
        }
    }
    else {
        Reg {
            index: encoded,
            high: false,
        }
    }
}

/// Branch target relative to the page (decoded at linear address 0; see
/// compile). Whether it is canonical depends on where the page runs.
fn relative(d: &Decoded) -> Option<u64> {
    let i = d.immediate?;
    let displacement = match i.encoded_bytes {
        1 => i.value as i8 as i64,
        2 => i.value as i16 as i64,
        _ => i.value as i32 as i64,
    };
    Some(d.next.0.wrapping_add(displacement as u64))
}
/// 16-bit protected-mode code (P7.7): a near branch's target IP wraps at
/// 64 KiB in CS, so its target relative to the page is that IP less the IP
/// of the page's first byte (CompileEnv::ip_base)
fn wrap_ip(op: Op, ip_base: i32) -> Op {
    let wrap = |target: u64| {
        ((ip_base as i64).wrapping_add(target as i64) & 0xFFFF).wrapping_sub(ip_base as i64) as u64
    };
    match op {
        Op::Jmp { target } => Op::Jmp {
            target: wrap(target),
        },
        Op::Jcc { cc, target } => Op::Jcc {
            cc,
            target: wrap(target),
        },
        Op::Call { target } => Op::Call {
            target: wrap(target),
        },
        Op::LoopJump { kind, cx, target } => Op::LoopJump {
            kind,
            cx,
            target: wrap(target),
        },
        op => op,
    }
}

/// A volatile instruction's op (CompileEnv::volatile): forms whose one
/// immediate is a source operand (Emitter::read loads it, Inst::dynamic),
/// else a step, which interprets the bytes as they are
fn volatile_op(d: &Decoded, op: Op) -> Op {
    let dynamic = d
        .immediate
        .is_some_and(|i| matches!(i.encoded_bytes, 1 | 2 | 4))
        && matches!(
            op,
            Op::Alu {
                src: Opnd::Imm(_),
                ..
            } | Op::Mov {
                src: Opnd::Imm(_),
                ..
            } | Op::Test {
                b: Opnd::Imm(_),
                ..
            } | Op::Imul {
                b: Opnd::Imm(_),
                ..
            } | Op::Push { src: Opnd::Imm(_) }
                | Op::Push16 { src: Opnd::Imm(_) }
        );
    if dynamic {
        op
    }
    else {
        Op::Step
    }
}

/// The mode of 16-bit code (CompileEnv::mode16): protected mode (P7.7),
/// real mode or virtual-8086 mode (P7.8). Real-mode segment bases are the
/// selectors shifted left by 4 (pages::x64_page_load_seg loads them as the
/// interpreter does); virtual-8086 code steps what IOPL governs there.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Mode16 {
    Protected,
    Real,
    V86,
}
/// 16-bit code in the page tier: 16-bit protected mode (P7.7), real and
/// virtual-8086 mode (P7.8)
fn code16(mode: ExecutionMode) -> bool {
    matches!(
        mode,
        ExecutionMode::Protected16 | ExecutionMode::Real | ExecutionMode::Vm86
    )
}

/// The template for a long-mode instruction, or Step. Mirrors
/// x64::execute::execute; anything it does not cover exactly is a Step.
/// 32-bit compatibility-mode code (CompileEnv::compat) shares the long-mode
/// templates the emitter treats in both modes (compat_template), its own
/// forms (INC/DEC 40-4F, the 32-bit stack), and steps the rest.
fn classify(d: &Decoded) -> Op {
    // (16-bit protected-mode code, P7.7, as 32-bit code with 16-bit
    // operands, addresses and stack)
    let prot16 = code16(d.mode);
    let compat = d.mode == ExecutionMode::Compatibility32 || prot16;
    if !d.mode.is_long() && !compat {
        return Op::Step;
    }
    // (the stack width of PUSH, POP, CALL and RET: 64, or 32 in
    // compatibility mode, 16 in 16-bit code; other operand sizes are steps)
    let stack = if prot16 {
        16
    }
    else if compat {
        32
    }
    else {
        64
    };
    let op = d.base_opcode();
    let w = d.operand_size;
    // (near branches: in compatibility mode with 32-bit operands, a 16-bit
    // operand size truncating EIP is a step; in 16-bit code with 16-bit
    // operands, their IP wrapping at 64 KiB: wrap_ip)
    let near = if prot16 { w == 16 } else { !compat || w == 32 };
    let rex = d.prefixes.rex.is_some();
    let group = d.modrm.map_or(0, |m| m >> 3 & 7);
    let imm = d.immediate.map(|i| i.value);
    let memory = d.rm_register.is_none() && d.address.is_some();
    let reg = |r: u8, width: u8| register(r, width, rex);
    let rm = |width: u8| -> Option<Opnd> {
        match d.rm_register {
            Some(r) => Some(Opnd::Reg(reg(r, width))),
            None => d.address.map(Opnd::Mem),
        }
    };
    // REP/REPNE are ignored by these forms in the interpreter (or select
    // their catalog entry); anything else with REP is a step.
    let rep_ok = matches!(op, 0xC2 | 0xC3 | 0xE8 | 0xE9 | 0xEB | 0x70..=0x7F | 0x0F80..=0x0F8F | 0x0FB8 | 0x0FBC | 0x0FBD | 0x0F1E | 0xA4..=0xA7 | 0xAA..=0xAF)
        || op == 0xFF && matches!(group, 2 | 4)
        // F3/F2 that select an SSE instruction are not repeat prefixes
        || matches!(d.opcode >> 16, 0xF2 | 0xF3);
    if d.prefixes.rep.is_some() && !rep_ok {
        return Op::Step;
    }
    // The decoder accepts LOCK only on memory read-modify-write forms.
    let lock_ok = memory
        && match op {
            0x00..=0x3D => op & 7 <= 1 && op >> 3 != 7,
            0x80 | 0x81 | 0x83 => group != 7,
            0xFE | 0xFF => group <= 1,
            0xF6 | 0xF7 => matches!(group, 2 | 3),
            0x86 | 0x87 | 0x0FC0 | 0x0FC1 | 0x0FB0 | 0x0FB1 | 0x0FAB | 0x0FB3 | 0x0FBB => true,
            0x0FBA => group >= 5,
            0x0FC7 => group == 1,
            _ => false,
        };
    if d.prefixes.lock && !lock_ok {
        return Op::Step;
    }
    // With cores in workers, a locked read-modify-write (XCHG with memory is
    // locked) commits with a compare-exchange loop (see locked_rmw), or
    // atomically in the interpreter (x64::memory::run_locked).
    let result = (|| -> Option<Op> {
        if d.vex.is_some() {
            return vex(d);
        }
        Some(match op {
            0x00..=0x3D if op & 7 <= 5 => {
                let code = (op >> 3) as u8;
                let width = if op & 1 == 0 { 8 } else { w };
                match op & 7 {
                    0 | 1 => Op::Alu {
                        code,
                        width,
                        dst: rm(width)?,
                        src: Opnd::Reg(reg(d.reg?, width)),
                    },
                    2 | 3 => Op::Alu {
                        code,
                        width,
                        dst: Opnd::Reg(reg(d.reg?, width)),
                        src: rm(width)?,
                    },
                    _ => Op::Alu {
                        code,
                        width,
                        dst: Opnd::Reg(reg(0, width)),
                        src: Opnd::Imm(imm? & mask(width)),
                    },
                }
            },
            0x80 | 0x81 | 0x83 => {
                let width = if op == 0x80 { 8 } else { w };
                Op::Alu {
                    code: group,
                    width,
                    dst: rm(width)?,
                    src: Opnd::Imm(imm? & mask(width)),
                }
            },
            0x84 | 0x85 => {
                let width = if op == 0x84 { 8 } else { w };
                Op::Test {
                    width,
                    a: rm(width)?,
                    b: Opnd::Reg(reg(d.reg?, width)),
                }
            },
            0xA8 | 0xA9 => {
                let width = if op == 0xA8 { 8 } else { w };
                Op::Test {
                    width,
                    a: Opnd::Reg(reg(0, width)),
                    b: Opnd::Imm(imm? & mask(width)),
                }
            },
            0x88..=0x8B => {
                let width = if op & 1 == 0 { 8 } else { w };
                if op & 2 == 0 {
                    Op::Mov {
                        width,
                        dst: rm(width)?,
                        src: Opnd::Reg(reg(d.reg?, width)),
                    }
                }
                else {
                    Op::Mov {
                        width,
                        dst: Opnd::Reg(reg(d.reg?, width)),
                        src: rm(width)?,
                    }
                }
            },
            0xB0..=0xBF => {
                let width = if op < 0xB8 { 8 } else { w };
                Op::Mov {
                    width,
                    dst: Opnd::Reg(reg(d.opcode_register?, width)),
                    src: Opnd::Imm(imm? & mask(width)),
                }
            },
            0xC6 | 0xC7 if group == 0 => {
                let width = if op == 0xC6 { 8 } else { w };
                Op::Mov {
                    width,
                    dst: rm(width)?,
                    src: Opnd::Imm(imm? & mask(width)),
                }
            },
            0x8D => Op::Lea {
                width: w,
                dst: reg(d.reg?, w),
                address: d.address?,
            },
            0x63 if !compat => Op::Extend {
                width: w,
                from: if w == 16 { 16 } else { 32 },
                signed: true,
                dst: reg(d.reg?, w),
                src: rm(if w == 16 { 16 } else { 32 })?,
            },
            0x0FB6 | 0x0FB7 | 0x0FBE | 0x0FBF => {
                let from = if op & 1 == 0 { 8 } else { 16 };
                Op::Extend {
                    width: w,
                    from,
                    signed: op & 8 != 0,
                    dst: reg(d.reg?, w),
                    src: rm(from)?,
                }
            },
            0xFE | 0xFF if group <= 1 => {
                let width = if op == 0xFE { 8 } else { w };
                Op::IncDec {
                    dec: group == 1,
                    width,
                    dst: rm(width)?,
                }
            },
            0xF6 | 0xF7 => {
                let width = if op == 0xF6 { 8 } else { w };
                match group {
                    0 | 1 => Op::Test {
                        width,
                        a: rm(width)?,
                        b: Opnd::Imm(imm? & mask(width)),
                    },
                    2 => Op::Not {
                        width,
                        dst: rm(width)?,
                    },
                    3 => Op::Neg {
                        width,
                        dst: rm(width)?,
                    },
                    // (16-bit code's DX:AX, P7.7)
                    4 | 5 if width >= 32 || width == 16 && prot16 => Op::MulWide {
                        signed: group == 5,
                        width,
                        src: rm(width)?,
                    },
                    6 | 7 if width >= 32 || width == 16 && prot16 => Op::Div {
                        signed: group == 7,
                        width,
                        src: rm(width)?,
                    },
                    _ => return None,
                }
            },
            0xC0 | 0xC1 | 0xD0 | 0xD1 | 0xD2 | 0xD3 => {
                let width = if op & 1 == 0 { 8 } else { w };
                let count = match op {
                    0xC0 | 0xC1 => Some(imm? as u8),
                    0xD0 | 0xD1 => Some(1),
                    _ => None,
                };
                // Rotates through carry, and narrow CL shifts or rotates,
                // call the interpreter's semantics (64-bit RCL/RCR step).
                if matches!(group, 2 | 3) || count.is_none() && width < 32 {
                    if width == 64 {
                        return None;
                    }
                    return Some(Op::ShiftCall {
                        code: group,
                        width,
                        dst: rm(width)?,
                        count,
                    });
                }
                Op::Shift {
                    code: group,
                    width,
                    dst: rm(width)?,
                    count,
                }
            },
            0x0FAF => Op::Imul {
                width: w,
                dst: reg(d.reg?, w),
                a: rm(w)?,
                b: Opnd::Reg(reg(d.reg?, w)),
            },
            0x69 | 0x6B => Op::Imul {
                width: w,
                dst: reg(d.reg?, w),
                a: rm(w)?,
                b: Opnd::Imm(imm? & mask(w)),
            },
            // (compatibility mode: INC and DEC r32, REX prefixes in 64-bit mode)
            0x40..=0x4F if compat => Op::IncDec {
                dec: op >= 0x48,
                width: w,
                dst: Opnd::Reg(reg(op as u8 & 7, w)),
            },
            0x50..=0x57 if w == stack => Op::Push {
                src: Opnd::Reg(reg(d.opcode_register?, stack)),
            },
            0x58..=0x5F if w == stack => Op::Pop {
                dst: reg(d.opcode_register?, stack),
            },
            0x68 | 0x6A if w == stack => Op::Push {
                src: Opnd::Imm(imm?),
            },
            0xFF if group == 6 && w == stack => Op::Push { src: rm(stack)? },
            // (virtual-8086 mode: IOPL governs it, a step; P7.8)
            0x9C if w == stack && d.mode != ExecutionMode::Vm86 => Op::Pushf,
            0xC9 if w == stack => Op::Leave,
            0xE8 if near => Op::Call {
                target: relative(d)?,
            },
            0xFF if group == 2 && near => Op::CallIndirect { src: rm(stack)? },
            0xFF if group == 4 && near => Op::JmpIndirect { src: rm(stack)? },
            0xC3 if near => Op::Ret { pop: 0 },
            0xC2 if near => Op::Ret { pop: imm? as u16 },
            0xE9 | 0xEB if near => Op::Jmp {
                target: relative(d)?,
            },
            0x70..=0x7F | 0x0F80..=0x0F8F if near => Op::Jcc {
                cc: op as u8 & 15,
                target: relative(d)?,
            },
            0x0F40..=0x0F4F => Op::Cmov {
                cc: op as u8 & 15,
                width: w,
                dst: reg(d.reg?, w),
                src: rm(w)?,
            },
            0x0F90..=0x0F9F => Op::Setcc {
                cc: op as u8 & 15,
                dst: rm(8)?,
            },
            0x86 | 0x87 => {
                let width = if op == 0x86 { 8 } else { w };
                Op::Xchg {
                    width,
                    a: rm(width)?,
                    b: reg(d.reg?, width),
                }
            },
            0x90 if d.opcode_register? & 7 == 0 && d.opcode_register? < 8 => {
                // PAUSE yields the core in the interpreter
                if d.prefixes.rep.is_some() {
                    return None;
                }
                Op::Nop
            },
            0x90..=0x97 => Op::Xchg {
                width: w,
                a: Opnd::Reg(reg(0, w)),
                b: reg(d.opcode_register?, w),
            },
            0x0FC0 | 0x0FC1 => {
                let width = if op == 0x0FC0 { 8 } else { w };
                Op::Xadd {
                    width,
                    dst: rm(width)?,
                    src: reg(d.reg?, width),
                }
            },
            0x0FB0 | 0x0FB1 => {
                let width = if op == 0x0FB0 { 8 } else { w };
                Op::Cmpxchg {
                    width,
                    dst: rm(width)?,
                    src: reg(d.reg?, width),
                }
            },
            0x98 => Op::SignAcc { width: w },
            0x99 => Op::SignDx { width: w },
            0x0FA3 | 0x0FAB | 0x0FB3 | 0x0FBB => Op::Bt {
                action: ((op >> 3) & 3) as u8,
                width: w,
                dst: rm(w)?,
                index: Opnd::Reg(reg(d.reg?, w)),
            },
            0x0FBA if group >= 4 => Op::Bt {
                action: group - 4,
                width: w,
                dst: rm(w)?,
                index: Opnd::Imm(imm?),
            },
            // (TZCNT and LZCNT, F3 0F BC/BD with their features: a step)
            // TZCNT and LZCNT (F3 0F BC/BD with their features; 16-bit: a step)
            0x0FBC | 0x0FBD if d.opcode >> 16 == 0xF3 && w != 16 => Op::Bmi {
                op: if op == 0x0FBC { BmiOp::Tzcnt } else { BmiOp::Lzcnt },
                width: w,
                dst: reg(d.reg?, w),
                src: rm(w)?,
                other: reg(0, w),
            },
            // MOVBE (not CRC32: F2 0F 38 F0/F1; memory only; 16-bit: a step)
            0x0F38F0 | 0x0F38F1 if d.opcode == op && memory && w != 16 => Op::Movbe {
                load: op == 0x0F38F0,
                width: w,
                reg: reg(d.reg?, w),
                mem: d.address?,
            },
            0x0FBC | 0x0FBD if d.opcode >> 16 != 0xF3 => Op::BitScan {
                reverse: op == 0x0FBD,
                width: w,
                dst: reg(d.reg?, w),
                src: rm(w)?,
            },
            0x0FB8 if d.opcode == 0xF30FB8 => Op::Popcnt {
                width: w,
                dst: reg(d.reg?, w),
                src: rm(w)?,
            },
            0x0FC8..=0x0FCF if w != 16 => Op::Bswap {
                width: w,
                reg: (op as u8 & 7) | d.prefixes.b(),
            },
            0xF5 | 0xF8 | 0xF9 | 0xFC | 0xFD => Op::Flag { opcode: op as u8 },
            0x9E => Op::Sahf,
            0x9F => Op::Lahf,
            0x0F0D | 0x0F18..=0x0F1F => Op::Nop,
            0xFA => Op::Cli,
            0xFB => Op::Sti,
            0x0F01 if d.modrm == Some(0xF8) => Op::Swapgs,
            0x0F01 if group == 7 && memory => Op::Invlpg {
                address: d.address?,
            },
            0x0F31 => Op::Rdtsc,
            0xA4 | 0xA5 | 0xAA | 0xAB
                if d.address_size == stack
                    && !(op <= 0xA5 && matches!(d.prefixes.segment, Some(4 | 5))) =>
            {
                let width = if op & 1 == 0 { 8 } else { w };
                let rep = d.prefixes.rep.is_some();
                if op <= 0xA5 {
                    Op::Movs { width, rep }
                }
                else {
                    Op::Stos { width, rep }
                }
            },
            0xA6 | 0xA7 | 0xAE | 0xAF
                if d.address_size == stack
                    && d.prefixes.rep.is_some()
                    && !(op <= 0xA7 && matches!(d.prefixes.segment, Some(4 | 5))) =>
            {
                Op::RepCompare {
                    width: if op & 1 == 0 { 8 } else { w },
                    scan: op >= 0xAE,
                    equal: d.prefixes.rep == Some(0xF3),
                }
            },
            0x8C if group < 6 => Op::MovSreg {
                segment: group,
                width: if memory { 16 } else { w },
                dst: rm(w)?,
            },
            0x0FA5 | 0x0FAD if compat && w == 32 => Op::DoubleShiftCl {
                left: op == 0x0FA5,
                dst: rm(w)?,
                src: reg(d.reg?, w),
            },
            0x0FA4 | 0x0FAC if w >= 32 => Op::DoubleShift {
                left: op == 0x0FA4,
                width: w,
                dst: rm(w)?,
                src: reg(d.reg?, w),
                count: imm? as u8,
            },
            0x0FC7 if group == 1 && memory => Op::CompareExchange {
                wide: w == 128,
                address: d.address?,
            },
            // MOV AL/rAX, moffs and back: an absolute address (FS/GS base added)
            0xA0..=0xA3 => {
                let width = if op & 1 == 0 { 8 } else { w };
                let address = AddressExpr {
                    base: AddressBase::None,
                    index: None,
                    scale: 1,
                    displacement: imm? as i64,
                    address_size: d.address_size,
                    segment: d.prefixes.segment.unwrap_or(3),
                };
                let accumulator = Opnd::Reg(Reg {
                    index: 0,
                    high: false,
                });
                if op & 2 == 0 {
                    Op::Mov {
                        width,
                        dst: accumulator,
                        src: Opnd::Mem(address),
                    }
                }
                else {
                    Op::Mov {
                        width,
                        dst: Opnd::Mem(address),
                        src: accumulator,
                    }
                }
            },
            // MOVNTI: an ordinary store here
            0x0FC3 if memory && w >= 32 => Op::Mov {
                width: w,
                dst: rm(w)?,
                src: Opnd::Reg(reg(d.reg?, w)),
            },
            // LFENCE MFENCE SFENCE: one core runs at a time, in program order
            0x0FAE if d.opcode == 0x0FAE && d.rm_register.is_some() && group >= 5 => Op::Nop,
            0x0FAE if d.opcode == 0x0FAE && memory && matches!(group, 2 | 3) => Op::Mxcsr {
                load: group == 2,
                address: d.address?,
            },
            0x0F01 if d.modrm == Some(0xF9) => Op::Rdtscp,
            0x0F20 if matches!(d.reg, Some(0 | 2 | 3 | 4)) && d.rm_register.is_some() => {
                Op::ReadCr {
                    control: d.reg?,
                    reg: reg(d.rm_register?, 64),
                }
            },
            0x0F20 | 0x0F22 if d.reg == Some(8) && d.rm_register.is_some() => Op::Cr8 {
                write: op == 0x0F22,
                reg: reg(d.rm_register?, 64),
            },
            // (compatibility mode's x87 as Tier-0's, P7.2a)
            0xD8..=0xDF if compat => {
                let modrm = d.modrm?;
                match crate::x86tpl::x87_forms::io(op as u8, modrm) {
                    Some(io) => Op::X87 {
                        opcode: op as u8,
                        modrm,
                        io,
                        address: if modrm < 0xC0 { Some(d.address?) } else { None },
                    },
                    None if op == 0xDF && modrm == 0xE0 => Op::Fnstsw,
                    None if modrm >= 0xC0 && matches!((op, group), (0xDB | 0xDF, 5 | 6)) => {
                        Op::X87Flags {
                            name: match (op, group) {
                                (0xDB, 5) => "fpu_fucomi",
                                (0xDB, _) => "fpu_fcomi",
                                (_, 5) => "fpu_fucomip",
                                _ => "fpu_fcomip",
                            },
                            r: modrm & 7,
                        }
                    },
                    None if modrm >= 0xC0 && matches!(op, 0xDA | 0xDB) && group <= 3 => Op::Fcmov {
                        cc: [2, 4, 6, 10][group as usize] | (op == 0xDB) as u8,
                        r: modrm & 7,
                    },
                    None => return None,
                }
            },
            // (compatibility mode's MMX, P7.2a)
            _ if compat && d.opcode >> 8 == 0x0F && !d.prefixes.lock && mmx(d).is_some() => {
                return mmx(d)
            },
            _ if d.opcode >> 8 & 0xFF == 0x0F
                || d.opcode >> 16 == 0x0F
                || matches!(op >> 8, 0x0F38 | 0x0F3A) =>
            {
                return sse(d)
            },
            _ => return None,
        })
    })();
    match result {
        // (compatibility mode: shifts and rotates by the 32-bit
        // interpreter's rules, 32-bit ROL, ROR, SHL, SHR and SAR inline
        // (Emitter::legacy_shift32), the others through its helper)
        Some(Op::Shift {
            code,
            width,
            dst,
            count,
        }) if compat
            && d.address.map_or(true, |a| a.address_size == 32 || prot16)
            && !(width == 32 && code != 2 && code != 3) =>
        {
            Op::ShiftCall {
                code,
                width,
                dst,
                count,
            }
        },
        Some(op) if !compat || compat_template(&op, d) => op,
        _ => Op::Step,
    }
}

/// Legacy mode's further templates (CompileEnv::legacy, P7.3) for what
/// classify leaves to a step, so that other modes compile as before:
/// Tier-0's forms that Windows 98 and XP code would step through otherwise
/// (P3.7 there): LOOP and JECXZ, segment register loads, pops and pushes,
/// 16-bit pushes and pops, POP m32, PUSHAD and POPAD, LODS without REP,
/// CLI and STI. Memory operands with 32-bit addresses only, as
/// compat_template.
fn legacy_template(d: &Decoded) -> Option<Op> {
    let prot16 = code16(d.mode);
    if d.address.is_some_and(|a| a.address_size != 32 && !prot16)
        || d.prefixes.rep.is_some()
        || d.prefixes.lock
    {
        return None;
    }
    let op = d.base_opcode();
    let w = d.operand_size;
    // (16-bit code, P7.7: LOOP and JCXZ with 16-bit operands, segment
    // register loads, pushes and pops, CLI and STI; the 32-bit forms step)
    if prot16
        && !matches!(op, 0xE0..=0xE3 | 0x8E | 0x06 | 0x07 | 0x0E | 0x16 | 0x1E | 0x1F | 0x0FA0 | 0x0FA1 | 0x0FA8 | 0x0FA9 | 0xFA | 0xFB
            | 0x50..=0x5F | 0x68 | 0x6A | 0xFF | 0x8F | 0xC4 | 0xC5 | 0xC8 | 0xAC | 0xAD | 0x9A | 0xCA | 0xCB)
    {
        return None;
    }
    let group = d.modrm.map_or(0, |m| m >> 3 & 7);
    let rm16 = || match d.rm_register {
        Some(r) => Some(Opnd::Reg(register(r, 16, false))),
        None => d.address.map(Opnd::Mem),
    };
    // (ES, CS, SS, DS, FS, GS)
    let segment = |op: u32| match op {
        0x06 | 0x07 => 0,
        0x0E => 1,
        0x16 => 2,
        0x1E | 0x1F => 3,
        0x0FA0 | 0x0FA1 => 4,
        _ => 5,
    };
    let rm32 = || match d.rm_register {
        Some(r) => Some(Opnd::Reg(register(r, 32, false))),
        None => d.address.map(Opnd::Mem),
    };
    Some(match op {
        // (16-bit code, P7.7: 32-bit pushes and pops, LES and LDS, ENTER at
        // level 0, LODS with 16-bit addresses)
        0x50..=0x57 if prot16 && w == 32 => Op::Push32 {
            src: Opnd::Reg(register(d.opcode_register?, 32, false)),
        },
        0x58..=0x5F if prot16 && w == 32 => Op::Pop32 {
            dst: Opnd::Reg(register(d.opcode_register?, 32, false)),
        },
        0x68 | 0x6A if prot16 && w == 32 => Op::Push32 {
            src: Opnd::Imm(d.immediate?.value & 0xFFFF_FFFF),
        },
        0xFF if prot16 && group == 6 && w == 32 => Op::Push32 { src: rm32()? },
        0x8F if prot16 && group == 0 && w == 32 => Op::Pop32 { dst: rm32()? },
        0xC4 | 0xC5 if prot16 && d.rm_register.is_none() => Op::LoadFar {
            segment: if op == 0xC4 { 0 } else { 3 },
            width: w,
            dst: register(d.reg?, w, false),
            address: d.address?,
        },
        0xC8 if prot16 && w == 16 && d.extra_immediate == Some(0) => Op::Enter {
            size: d.immediate?.value as u16,
        },
        // (far CALL and RETF, M11: for code compiled for segment bases,
        // Decoder::at)
        0x9A => Op::FarCall {
            selector: d.extra_immediate?,
            offset: d.immediate?.value as u32,
            width: w,
        },
        0xCB => Op::FarRet { pop: 0, width: w },
        0xCA => Op::FarRet {
            pop: d.immediate?.value as u16,
            width: w,
        },
        0xAC | 0xAD if prot16 && d.address_size == 16 => Op::Lods16 {
            width: if op == 0xAC { 8 } else { w },
            segment: d.prefixes.segment.unwrap_or(3),
        },
        _ if prot16
            && matches!(
                op,
                0x50..=0x5F | 0x68 | 0x6A | 0xFF | 0xC4 | 0xC5 | 0xC8 | 0xAC | 0xAD
            ) =>
        {
            return None
        },
        // (a 16-bit operand size truncates EIP: a step; 16-bit code's IP
        // wraps, wrap_ip)
        0xE0..=0xE3 if w == 32 && !prot16 || w == 16 && prot16 => Op::LoopJump {
            kind: op as u8 - 0xE0,
            cx: d.address_size == 16,
            target: relative(d)?,
        },
        0x8E if matches!(group, 0 | 3 | 4 | 5) => Op::LoadSreg {
            segment: group,
            src: rm16()?,
        },
        0x07 | 0x1F | 0x0FA1 | 0x0FA9 if w != 64 => Op::PopSreg {
            segment: segment(op),
            width: w,
        },
        0x06 | 0x0E | 0x16 | 0x1E | 0x0FA0 | 0x0FA8 if w != 64 => Op::PushSreg {
            segment: segment(op),
            width: w,
        },
        0x50..=0x57 if w == 16 => Op::Push16 {
            src: Opnd::Reg(register(d.opcode_register?, 16, false)),
        },
        0x58..=0x5F if w == 16 => Op::Pop16 {
            dst: Opnd::Reg(register(d.opcode_register?, 16, false)),
        },
        0x68 | 0x6A if w == 16 => Op::Push16 {
            src: Opnd::Imm(d.immediate?.value),
        },
        0xFF if group == 6 && w == 16 => Op::Push16 { src: rm16()? },
        0x8F if group == 0 && w == 16 => Op::Pop16 { dst: rm16()? },
        0x8F if group == 0 && w == 32 => match d.rm_register {
            Some(r) => Op::Pop {
                dst: register(r, 32, false),
            },
            None => Op::PopMem {
                address: d.address?,
            },
        },
        0x60 if w == 32 => Op::Pusha,
        0x61 if w == 32 => Op::Popa,
        0xAC | 0xAD if d.address_size == 32 && d.prefixes.segment != Some(5) => Op::Lods {
            width: if op == 0xAC { 8 } else { w },
            segment: d.prefixes.segment.unwrap_or(3),
        },
        0xFA => Op::Cli,
        0xFB => Op::Sti,
        _ => return None,
    })
}

/// The templates the emitter treats in 32-bit compatibility mode
/// (CompileEnv::compat, docs/jit-unification-plan.md P7.2): EIP, ESP and
/// addresses wrap at 4 GiB, the stack slots are 4 bytes. Memory operands
/// with 32-bit addresses only (a 16-bit address is a step); the rest steps
/// until its emitter covers the mode.
fn compat_template(op: &Op, d: &Decoded) -> bool {
    // (16-bit code, P7.7: 16-bit addresses, but its string instructions step)
    if code16(d.mode) {
        if matches!(
            op,
            Op::Movs { .. } | Op::Stos { .. } | Op::RepCompare { .. }
        ) {
            return false;
        }
    }
    else if d.address.is_some_and(|a| a.address_size != 32) {
        return false;
    }
    // (BMI as cpu::bmi in every engine; VEX.W1 is no 64-bit operand here and
    // VEX.vvvv names EAX..EDI: others step)
    if let Op::Bmi {
        width, dst, other, ..
    } = op
    {
        return *width == 32 && dst.index < 8 && other.index < 8;
    }
    matches!(
        op,
        Op::Alu { .. }
            | Op::Test { .. }
            | Op::Mov { .. }
            | Op::Lea { .. }
            | Op::Extend { .. }
            | Op::IncDec { .. }
            | Op::Not { .. }
            | Op::Neg { .. }
            | Op::MulWide { .. }
            | Op::Div { .. }
            | Op::Shift { width: 32, .. }
            | Op::ShiftCall { .. }
            | Op::Imul { .. }
            | Op::Push { .. }
            | Op::Pop { .. }
            | Op::Pushf
            | Op::Leave
            | Op::Call { .. }
            | Op::CallIndirect { .. }
            | Op::JmpIndirect { .. }
            | Op::Ret { .. }
            | Op::Jmp { .. }
            | Op::Jcc { .. }
            | Op::Cmov { .. }
            | Op::Setcc { .. }
            | Op::Xchg { .. }
            | Op::Nop
            | Op::Xadd { .. }
            | Op::Cmpxchg { .. }
            | Op::SignAcc { .. }
            | Op::SignDx { .. }
            | Op::Movs { .. }
            | Op::Stos { .. }
            | Op::RepCompare { .. }
            // (EFLAGS as the 32-bit interpreter leaves them, or none)
            | Op::Bt { .. }
            | Op::Bswap { .. }
            | Op::Flag { .. }
            | Op::Lahf
            | Op::Sahf
            | Op::CompareExchange { .. }
            | Op::MovSreg { .. }
            | Op::Movbe { .. }
            | Op::BitScan { .. }
            | Op::Popcnt { .. }
            | Op::DoubleShift { width: 32, .. }
            | Op::DoubleShiftCl { .. }
            | Op::Mmx { .. }
            // SSE, AVX and their templates (XMM0-7 only: no REX or VEX.R)
            | Op::Vmove { .. }
            | Op::Vlogic { .. }
            | Op::Vfp { .. }
            | Op::MovdIn { .. }
            | Op::MovdOut { .. }
            | Op::Vpacked { .. }
            | Op::Vstrings { .. }
            | Op::Vround { .. }
            | Op::VshiftImm { .. }
            | Op::Vzeroupper
            | Op::Vmove256 { .. }
            | Op::Vzeroall
            | Op::Vpacked256 { .. }
            | Op::Vinsert128 { .. }
            | Op::Vperm2 { .. }
            | Op::Vmovmsk256 { .. }
            | Op::Vbroadcast { .. }
            | Op::Vmovmsk { .. }
            | Op::Vcmp { .. }
            | Op::Vblendv { .. }
            | Op::Vcvt { .. }
            | Op::Vconvert { .. }
            | Op::Vcompare { .. }
            | Op::Vfused { .. }
            | Op::Mxcsr { .. }
            // x87 (P7.2a)
            | Op::X87 { .. }
            | Op::Fnstsw
            | Op::X87Flags { .. }
            | Op::Fcmov { .. }
    )
}

/// SSE data movement and bitwise templates (x64::vector semantics).
/// Whether the SSE templates (sse) take the instruction at the start of
/// `bytes`, and its length: the forms x64::replay's corpus covers
#[cfg(feature = "ir-test-hooks")]
pub(crate) fn sse_template(bytes: &[u8]) -> Option<usize> {
    let d = decode::decode_with(GuestIp(0x40_0000), ExecutionMode::Long64, |i| {
        bytes.get(i as usize).copied().ok_or(())
    })
    .ok()?;
    sse(&d).map(|_| d.length as usize)
}

/// Compatibility mode's MMX forms (P7.2a; Tier-0's ir::tier0::simd): no
/// prefix, MM registers 0-7
fn mmx(d: &Decoded) -> Option<Op> {
    let code = d.opcode as u8;
    if code == 0x77 {
        return Some(Op::Mmx {
            form: MmxForm::Emms,
        });
    }
    let modrm = d.modrm?;
    let reg = modrm >> 3 & 7;
    let src = match d.rm_register {
        Some(r) => Xmm::Reg(r & 7),
        None => Xmm::Mem(d.address?),
    };
    let rm32 = match d.rm_register {
        Some(r) => Opnd::Reg(register(r, 32, false)),
        None => Opnd::Mem(d.address?),
    };
    let form = match code {
        0x6F => MmxForm::Load { reg, src },
        0x7F => MmxForm::Store { reg, dst: src },
        0x6E => MmxForm::MovdIn { reg, src: rm32 },
        0x7E => MmxForm::MovdOut { reg, dst: rm32 },
        0x71 | 0x72 | 0x73 if d.rm_register.is_some() => {
            if !matches!(reg, 2 | 4 | 6) || code == 0x73 && reg == 4 {
                return None;
            }
            MmxForm::Shift {
                reg: d.rm_register? & 7,
                bits: 16 << (code - 0x71),
                kind: reg,
                count: d.immediate?.value as u8,
            }
        },
        0x70 => MmxForm::Packed {
            op: vec::shuffle(0x0F70, d.immediate?.value as u32),
            reg,
            src,
            bytes: 8,
        },
        _ => MmxForm::Packed {
            op: vec::packed_op(code, true)?,
            reg,
            src,
            bytes: if matches!(code, 0x60..=0x62) { 4 } else { 8 },
        },
    };
    Some(Op::Mmx { form })
}

fn sse(d: &Decoded) -> Option<Op> {
    let xmm_rm = || -> Option<Xmm> {
        match d.rm_register {
            Some(r) => Some(Xmm::Reg(r)),
            None => d.address.map(Xmm::Mem),
        }
    };
    let register = d.reg?;
    let memory = d.rm_register.is_none();
    let full = |aligned: bool, store: bool| -> Option<Op> {
        Some(if store {
            Op::Vmove {
                bits: 128,
                dst: xmm_rm()?,
                src: Xmm::Reg(register),
                aligned,
                zero: false,
                upper: None,
            }
        }
        else {
            Op::Vmove {
                bits: 128,
                dst: Xmm::Reg(register),
                src: xmm_rm()?,
                aligned,
                zero: false,
                upper: None,
            }
        })
    };
    Some(match d.opcode {
        // MOVUPS MOVUPD MOVDQU / MOVAPS MOVAPD MOVDQA
        0x0F10 | 0x660F10 | 0xF30F6F => full(false, false)?,
        0x0F11 | 0x660F11 | 0xF30F7F => full(false, true)?,
        0x0F28 | 0x660F28 | 0x660F6F => full(true, false)?,
        0x0F29 | 0x660F29 | 0x660F7F => full(true, true)?,
        // MOVNTPS MOVNTPD MOVNTDQ (memory only)
        0x0F2B | 0x660F2B | 0x660FE7 if memory => full(true, true)?,
        // MOVSS MOVSD
        0xF30F10 | 0xF20F10 => {
            let bits = if d.opcode == 0xF30F10 { 32 } else { 64 };
            Op::Vmove {
                bits,
                dst: Xmm::Reg(register),
                src: xmm_rm()?,
                aligned: false,
                zero: memory,
                upper: None,
            }
        },
        0xF30F11 | 0xF20F11 => {
            let bits = if d.opcode == 0xF30F11 { 32 } else { 64 };
            Op::Vmove {
                bits,
                dst: xmm_rm()?,
                src: Xmm::Reg(register),
                aligned: false,
                zero: false,
                upper: None,
            }
        },
        // MOVQ xmm, xmm/m64 and MOVQ xmm/m64, xmm: a register destination's upper half is cleared
        0xF30F7E => Op::Vmove {
            bits: 64,
            dst: Xmm::Reg(register),
            src: xmm_rm()?,
            aligned: false,
            zero: true,
            upper: None,
        },
        0x660FD6 => Op::Vmove {
            bits: 64,
            dst: xmm_rm()?,
            src: Xmm::Reg(register),
            aligned: false,
            zero: true,
            upper: None,
        },
        0x660F6E | 0x660F7E => {
            let width = if d.prefixes.w() { 64 } else { 32 };
            let rm = match d.rm_register {
                Some(r) => Opnd::Reg(Reg {
                    index: r,
                    high: false,
                }),
                None => Opnd::Mem(d.address?),
            };
            if d.opcode == 0x660F6E {
                Op::MovdIn {
                    width,
                    dst: register,
                    src: rm,
                }
            }
            else {
                Op::MovdOut {
                    width,
                    dst: rm,
                    src: register,
                }
            }
        },
        // AND ANDN OR XOR
        0x0F54 | 0x660F54 | 0x660FDB | 0x0F55 | 0x660F55 | 0x660FDF | 0x0F56 | 0x660F56
        | 0x660FEB | 0x0F57 | 0x660F57 | 0x660FEF => Op::Vlogic {
            code: logic_code(d.opcode as u8),
            dst: register,
            first: register,
            src: xmm_rm()?,
        },
        // ADDPS/PD/SS/SD MULx SUBx DIVx; SQRTx MINx MAXx, RSQRTPS/SS RCPPS/SS
        // (the latter steps without x64_sse_fast_check: Decoder::at)
        0x0F58 | 0x0F59 | 0x0F5C | 0x0F5E | 0x660F58 | 0x660F59 | 0x660F5C | 0x660F5E
        | 0xF30F58 | 0xF30F59 | 0xF30F5C | 0xF30F5E | 0xF20F58 | 0xF20F59 | 0xF20F5C | 0xF20F5E
        | 0x0F51 | 0x660F51 | 0xF30F51 | 0xF20F51 | 0x0F5D | 0x660F5D | 0xF30F5D | 0xF20F5D
        | 0x0F5F | 0x660F5F | 0xF30F5F | 0xF20F5F | 0x0F52 | 0xF30F52 | 0x0F53 | 0xF30F53 => {
            let prefix = d.opcode >> 16;
            Op::Vfp {
                code: d.opcode as u8,
                double: prefix == 0x66 || prefix == 0xF2,
                packed: prefix == 0 || prefix == 0x66,
                dst: register,
                first: register,
                src: xmm_rm()?,
            }
        },
        0x0F2E | 0x0F2F | 0x660F2E | 0x660F2F => Op::Vcompare {
            double: d.opcode >> 16 == 0x66,
            dst: register,
            src: xmm_rm()?,
        },
        // CVTSI2SS/SD, CVT(T)SS2SI/SD2SI, CVTSS2SD, CVTSD2SS
        0xF30F2A | 0xF20F2A | 0xF30F2C | 0xF20F2C | 0xF30F2D | 0xF20F2D | 0xF30F5A | 0xF20F5A => {
            Op::Vconvert {
                convert: conversion(d, d.opcode, d.prefixes.w())?,
                dst: register,
                first: register,
            }
        },
        // (the forms below emit Wasm SIMD: not in the build for engines without it)
        _ if !cfg!(target_feature = "simd128") => return None,
        0x0F5A | 0x660F5A | 0x0F5B | 0xF30FE6 => {
            let (opcode, source) = match d.opcode {
                0x0F5A => (0x5F, 8),    // CVTPS2PD: f64x2.promote_low_f32x4
                0x660F5A => (0x5E, 16), // CVTPD2PS: f32x4.demote_f64x2_zero
                0x0F5B => (0xFA, 16),   // CVTDQ2PS: f32x4.convert_i32x4_s
                _ => (0xFE, 8),         // CVTDQ2PD: f64x2.convert_low_i32x4_s
            };
            Op::Vcvt {
                op: Cvt::Convert {
                    opcode,
                    source,
                    result: 16,
                },
                dst: register,
                src: xmm_rm()?,
            }
        },
        0x660F5B | 0xF30F5B | 0x660FE6 | 0xF20FE6 => Op::Vcvt {
            op: Cvt::Integers {
                double: d.opcode & 0xFF == 0xE6,
                truncate: matches!(d.opcode, 0xF30F5B | 0x660FE6),
            },
            dst: register,
            src: xmm_rm()?,
        },
        0x660F70 | 0xF20F70 | 0xF30F70 | 0x0FC6 | 0x660FC6 => Op::Vpacked {
            op: vec::shuffle(d.opcode, d.immediate?.value as u32 & 0xFF),
            dst: register,
            first: register,
            src: xmm_rm()?,
        },
        // PMOVMSKB MOVMSKPS MOVMSKPD r32/r64, xmm
        0x660FD7 | 0x0F50 | 0x660F50 if !memory => Op::Vmovmsk {
            dst: Reg {
                index: register,
                high: false,
            },
            src: d.rm_register?,
            lane: movmsk_lane(d.opcode),
        },
        // CMPPS CMPPD CMPSS CMPSD (imm8[2:0])
        0x0FC2 | 0x660FC2 | 0xF30FC2 | 0xF20FC2 => Op::Vcmp {
            double: matches!(d.opcode >> 16, 0x66 | 0xF2),
            scalar: matches!(d.opcode >> 16, 0xF2 | 0xF3),
            predicate: d.immediate?.value as u8 & 7,
            dst: register,
            first: register,
            src: xmm_rm()?,
        },
        // PBLENDVB BLENDVPS BLENDVPD (the mask in XMM0)
        0x660F3810 | 0x660F3814 | 0x660F3815 => Op::Vblendv {
            lane: blendv_lane(d.opcode as u8),
            dst: register,
            first: register,
            src: xmm_rm()?,
            mask: 0,
        },
        0x660F71 | 0x660F72 | 0x660F73 if !memory => {
            let kind = d.modrm? >> 3 & 7;
            let code = d.opcode as u8;
            let bytes = matches!(kind, 3 | 7) && code == 0x73;
            if !(matches!(kind, 2 | 4 | 6) && !(code == 0x73 && kind == 4) || bytes) {
                return None;
            }
            Op::VshiftImm {
                dst: d.rm_register?,
                src: d.rm_register?,
                bits: if bytes { 128 } else { 16 << (code - 0x71) },
                kind,
                count: d.immediate?.value.min(255) as u8,
                wide: false,
            }
        },
        op if op >> 8 == 0x660F => Op::Vpacked {
            op: vec::packed_op(op as u8, false)?,
            dst: register,
            first: register,
            src: xmm_rm()?,
        },
        // PSHUFB, PALIGNR (SSSE3)
        0x660F3800 => Op::Vpacked {
            op: Packed::Swizzle(0x8F),
            dst: register,
            first: register,
            src: xmm_rm()?,
        },
        0x660F3A0F => Op::Vpacked {
            op: palignr(d.immediate?.value),
            dst: register,
            first: register,
            src: xmm_rm()?,
        },
        0x660F3A60..=0x660F3A63 => Op::Vstrings {
            op: d.opcode as u8,
            imm8: d.immediate?.value as u8,
            wide: d.prefixes.w(),
            dst: register,
            src: xmm_rm()?,
        },
        0x660F3A08..=0x660F3A0B => Op::Vround {
            double: d.opcode & 1 != 0,
            scalar: d.opcode & 2 != 0,
            imm8: d.immediate?.value as u8,
            dst: register,
            first: register,
            src: xmm_rm()?,
        },
        op if matches!(op >> 8, 0x660F38 | 0x660F3A) => Op::Vpacked {
            op: sse4_packed(op, d.immediate.map(|i| i.value))?,
            dst: register,
            first: register,
            src: xmm_rm()?,
        },
        _ => return None,
    })
}

/// Op::Vlogic's code of 0F 54-57 and 66 0F DB DF EB EF: AND, ANDN, OR, XOR
fn logic_code(code: u8) -> u8 {
    match code {
        0x54 | 0xDB => 0,
        0x55 | 0xDF => 1,
        0x56 | 0xEB => 2,
        _ => 3,
    }
}
/// Op::Vmovmsk's lane of PMOVMSKB (66 0F D7), MOVMSKPS (0F 50), MOVMSKPD
/// (66 0F 50), by their (legacy) key
fn movmsk_lane(key: u32) -> u8 {
    match key {
        0x660FD7 => 1,
        0x0F50 => 4,
        _ => 8,
    }
}
/// Op::Vblendv's lane of PBLENDVB (0x10), BLENDVPS (0x14), BLENDVPD (0x15)
fn blendv_lane(code: u8) -> u8 {
    match code {
        0x10 => 1,
        0x14 => 4,
        _ => 8,
    }
}
/// Op::Vconvert's conversion of the (legacy) key `key`: CVTSI2SS/SD,
/// CVT(T)SS2SI/SD2SI (64-bit integers with `wide`: REX.W or VEX.W1),
/// CVTSS2SD, CVTSD2SS
fn conversion(d: &Decoded, key: u32, wide: bool) -> Option<Convert> {
    let width = if wide { 64 } else { 32 };
    let xmm_rm = match d.rm_register {
        Some(r) => Xmm::Reg(r),
        None => Xmm::Mem(d.address?),
    };
    Some(match key {
        0xF30F2A | 0xF20F2A => Convert::FromInteger {
            double: key >> 16 == 0xF2,
            width,
            src: match d.rm_register {
                Some(r) => Opnd::Reg(Reg {
                    index: r,
                    high: false,
                }),
                None => Opnd::Mem(d.address?),
            },
        },
        0xF30F2C | 0xF20F2C | 0xF30F2D | 0xF20F2D => Convert::ToInteger {
            double: key >> 16 == 0xF2,
            truncate: key as u8 == 0x2C,
            width,
            src: xmm_rm,
        },
        0xF30F5A | 0xF20F5A => Convert::Precision {
            double: key >> 16 == 0xF3,
            src: xmm_rm,
        },
        _ => return None,
    })
}

/// The template of a VEX.256 form (P6): the moves and VZEROALL, the hot
/// forms of AVX's 256-bit ones; the others step
fn vex256(d: &Decoded) -> Option<Op> {
    use crate::decode_rules::vex;
    let v = d.vex?;
    if d.encoding.vex & vex::L1 == 0 {
        return None;
    }
    let key = crate::cpu::avx::legacy(d.opcode);
    if key == 0x0F77 {
        return Some(Op::Vzeroall);
    }
    let register = Xmm::Reg(d.reg?);
    let rm = match d.rm_register {
        Some(r) => Xmm::Reg(r),
        None => Xmm::Mem(d.address?),
    };
    let memory = d.rm_register.is_none();
    let (dst, src, aligned) = match (v.map, v.pp, key as u8) {
        // VMOVUPS VMOVUPD VMOVDQU, VMOVAPS VMOVAPD VMOVDQA (aligned)
        (1, 0 | 1, 0x10) | (1, 2, 0x6F) => (register, rm, false),
        (1, 0 | 1, 0x28) | (1, 1, 0x6F) => (register, rm, true),
        (1, 0 | 1, 0x11) | (1, 2, 0x7F) => (rm, register, false),
        (1, 0 | 1, 0x29) | (1, 1, 0x7F) => (rm, register, true),
        // VMOVNTPS VMOVNTPD VMOVNTDQ
        (1, 0 | 1, 0x2B) | (1, 1, 0xE7) if memory => (rm, register, true),
        // (the forms below emit Wasm SIMD: not in the build for engines
        // without it)
        _ if !cfg!(target_feature = "simd128") => return None,
        // AVX2 (P7 part 3): VPMOVMSKB; VMOVMSKPS, VMOVMSKPD
        (1, 1, 0xD7) | (1, 0 | 1, 0x50) if !memory => {
            return Some(Op::Vmovmsk256 {
                dst: Reg {
                    index: d.reg?,
                    high: false,
                },
                src: d.rm_register?,
                lane: movmsk_lane(key),
            })
        },
        // VBROADCASTSS, VBROADCASTSD, VPBROADCASTB/W/D/Q
        (2, 1, 0x18 | 0x19 | 0x58 | 0x59 | 0x78 | 0x79) => {
            return Some(Op::Vbroadcast {
                bytes: broadcast_bytes(key as u8),
                dst: d.reg?,
                src: rm,
                wide: true,
            })
        },
        // AVX2's shifts by imm8 on each half (VEX.vvvv the destination, the
        // r/m register the source), VPSHUFD/VPSHUFHW/VPSHUFLW and VPALIGNR
        // on each half (P12: the kernel's SHA-256/512 code with AVX2)
        (1, 1, code @ 0x71..=0x73) if !memory => {
            let kind = d.modrm? >> 3 & 7;
            let bytes = matches!(kind, 3 | 7) && code == 0x73;
            if !(matches!(kind, 2 | 4 | 6) && !(code == 0x73 && kind == 4) || bytes) {
                return None;
            }
            return Some(Op::VshiftImm {
                dst: v.vvvv,
                src: d.rm_register?,
                bits: if bytes { 128 } else { 16 << (code - 0x71) },
                kind,
                count: d.immediate?.value.min(255) as u8,
                wide: true,
            });
        },
        (1, 1..=3, 0x70) => {
            return Some(Op::Vpacked256 {
                op: vec::shuffle(key, d.immediate?.value as u32 & 0xFF),
                dst: d.reg?,
                first: d.reg?,
                src: rm,
            })
        },
        (3, 1, 0x0F) => {
            return Some(Op::Vpacked256 {
                op: palignr(d.immediate?.value),
                dst: d.reg?,
                first: v.vvvv,
                src: rm,
            })
        },
        // VINSERTF128, VINSERTI128 (AVX2 for I), VPERM2F128, VPERM2I128
        (3, 1, 0x18 | 0x38) => {
            return Some(Op::Vinsert128 {
                dst: d.reg?,
                first: v.vvvv,
                src: rm,
                high: d.immediate?.value & 1 != 0,
            })
        },
        (3, 1, 0x06 | 0x46) => {
            return Some(Op::Vperm2 {
                dst: d.reg?,
                first: v.vvvv,
                src: rm,
                imm8: d.immediate?.value as u8,
            })
        },
        // the packed integer forms of 66 0F, VPSHUFB and SSE4.1's of one
        // operation, on each half
        (1, 1, code) => {
            // (with VPAND VPANDN VPOR VPXOR, whose VEX.128 forms are Op::Vlogic)
            let op = vec::packed_op(code, false)?;
            if let Packed::Shift(..) = op {
                return None;
            }
            return Some(Op::Vpacked256 {
                op,
                dst: d.reg?,
                first: v.vvvv,
                src: rm,
            });
        },
        (2, 1, 0x00 | 0x28 | 0x29 | 0x2B | 0x37..=0x40) => {
            return Some(Op::Vpacked256 {
                op: if key as u8 == 0 { Packed::Swizzle(0x8F) } else { sse4_packed(key, None)? },
                dst: d.reg?,
                first: v.vvvv,
                src: rm,
            })
        },
        _ => return None,
    };
    Some(Op::Vmove256 { dst, src, aligned })
}

/// The element of VBROADCASTSS (18), VBROADCASTSD (19), VPBROADCASTD/Q (58,
/// 59), VPBROADCASTB/W (78, 79)
fn broadcast_bytes(code: u8) -> u8 {
    match code {
        0x78 => 1,
        0x79 => 2,
        0x18 | 0x58 => 4,
        _ => 8,
    }
}

/// VEX.W1's 64-bit general-purpose operands (VMOVQ, VCVTSI2SD, BMI, the
/// lengths of VPCMPESTRI): only in 64-bit mode, elsewhere it is W0's
fn gpr_w(d: &Decoded) -> bool { d.vex.is_some_and(|v| v.w) && d.mode == ExecutionMode::Long64 }
/// BMI1 and BMI2's VEX forms (exception type 13: no AVX state; VEX.W1 for
/// 64-bit operands): the hot ones of plan 5.1 and their siblings (MULX,
/// PDEP, PEXT, BEXTR and RORX step)
fn bmi(d: &Decoded) -> Option<Op> {
    let v = d.vex?;
    let width = if gpr_w(d) { 64 } else { 32 };
    let group = d.modrm? >> 3 & 7;
    let dst = register(d.reg?, width, true);
    let other = register(v.vvvv, width, true);
    let src = match d.rm_register {
        Some(r) => Opnd::Reg(register(r, width, true)),
        None => Opnd::Mem(d.address?),
    };
    let (op, dst) = match d.opcode {
        0xC402_00F2 => (BmiOp::Andn, dst),
        0xC402_00F3 => (
            match group {
                1 => BmiOp::Blsr,
                2 => BmiOp::Blsmsk,
                3 => BmiOp::Blsi,
                _ => return None,
            },
            other,
        ),
        0xC402_00F5 => (BmiOp::Bzhi, dst),
        0xC402_01F7 => (BmiOp::Shlx, dst),
        0xC402_02F7 => (BmiOp::Sarx, dst),
        0xC402_03F7 => (BmiOp::Shrx, dst),
        0xC403_03F0 => (BmiOp::Rorx(d.immediate?.value as u8), dst),
        _ => return None,
    };
    Some(Op::Bmi {
        op,
        width,
        dst,
        src,
        other,
    })
}

/// The template of a VEX form (AVX, P5: VEX.128 and VEX.LIG in 64-bit
/// mode; others step) on the SSE ones, as x64::vector's Avx executes it (see
/// Op::Vmove): VEX.vvvv the first source
fn vex(d: &Decoded) -> Option<Op> {
    use crate::decode_rules::vex;
    let v = d.vex?;
    if d.encoding.unimplemented {
        return None;
    }
    if d.encoding.vex & vex::GPR != 0 {
        return bmi(d);
    }
    // (VEX.L1 of other than VEX.LIG rows: the 256-bit forms)
    if v.l && d.encoding.vex & (vex::L0 | vex::L1) != 0 {
        return vex256(d);
    }
    let key = crate::cpu::avx::legacy(d.opcode);
    let code = key as u8;
    if key == 0x0F77 {
        return Some(Op::Vzeroupper);
    }
    let register = d.reg?;
    // (ModRM.reg of the forms it selects)
    let group = d.modrm? >> 3 & 7;
    let first = v.vvvv;
    let memory = d.rm_register.is_none();
    let xmm_rm = || -> Option<Xmm> {
        match d.rm_register {
            Some(r) => Some(Xmm::Reg(r)),
            None => d.address.map(Xmm::Mem),
        }
    };
    let gpr_rm = || -> Option<Opnd> {
        match d.rm_register {
            Some(r) => Some(Opnd::Reg(Reg {
                index: r,
                high: false,
            })),
            None => d.address.map(Opnd::Mem),
        }
    };
    let imm = d.immediate.map(|i| i.value);
    let move_128 = |aligned: bool, store: bool| -> Option<Op> {
        let (dst, src) =
            if store { (xmm_rm()?, Xmm::Reg(register)) } else { (Xmm::Reg(register), xmm_rm()?) };
        Some(Op::Vmove {
            bits: 128,
            dst,
            src,
            aligned,
            zero: false,
            upper: None,
        })
    };
    // FMA (P11): the VEX.128 and scalar forms
    if v.map == 2 && v.pp == 1 && matches!(code, 0x96..=0x9F | 0xA6..=0xAF | 0xB6..=0xBF) {
        return Some(Op::Vfused {
            op: code,
            double: v.w,
            dst: register,
            first,
            src: xmm_rm()?,
        });
    }
    Some(match (v.map, v.pp, code) {
        // VMOVUPS VMOVUPD VMOVDQU, VMOVAPS VMOVAPD VMOVDQA (aligned)
        (1, 0 | 1, 0x10) | (1, 2, 0x6F) => move_128(false, false)?,
        (1, 0 | 1, 0x28) | (1, 1, 0x6F) => move_128(true, false)?,
        (1, 0 | 1, 0x11) | (1, 2, 0x7F) => move_128(false, true)?,
        (1, 0 | 1, 0x29) | (1, 1, 0x7F) => move_128(true, true)?,
        // VMOVNTPS VMOVNTPD VMOVNTDQ
        (1, 0 | 1, 0x2B) | (1, 1, 0xE7) if memory => move_128(true, true)?,
        // VMOVSS VMOVSD: between registers the other bits from VEX.vvvv
        (1, 2 | 3, 0x10 | 0x11) => {
            let store = code == 0x11;
            let (dst, src) = if store {
                (xmm_rm()?, Xmm::Reg(register))
            }
            else {
                (Xmm::Reg(register), xmm_rm()?)
            };
            Op::Vmove {
                bits: if v.pp == 2 { 32 } else { 64 },
                dst,
                src,
                aligned: false,
                zero: memory && !store,
                upper: (!memory).then_some(first),
            }
        },
        // VMOVQ xmm, xmm/m64 and xmm/m64, xmm
        (1, 2, 0x7E) => Op::Vmove {
            bits: 64,
            dst: Xmm::Reg(register),
            src: xmm_rm()?,
            aligned: false,
            zero: true,
            upper: None,
        },
        (1, 1, 0xD6) => Op::Vmove {
            bits: 64,
            dst: xmm_rm()?,
            src: Xmm::Reg(register),
            aligned: false,
            zero: true,
            upper: None,
        },
        // VMOVD/VMOVQ xmm, r/m32/64 and r/m32/64, xmm
        (1, 1, 0x6E) => Op::MovdIn {
            width: if gpr_w(d) { 64 } else { 32 },
            dst: register,
            src: gpr_rm()?,
        },
        (1, 1, 0x7E) => Op::MovdOut {
            width: if gpr_w(d) { 64 } else { 32 },
            dst: gpr_rm()?,
            src: register,
        },
        // VLDMXCSR VSTMXCSR
        (1, 0, 0xAE) if memory && matches!(group, 2 | 3) => Op::Mxcsr {
            load: group == 2,
            address: d.address?,
        },
        // VANDPS/PD VANDNPS/PD VORPS/PD VXORPS/PD, VPAND VPANDN VPOR VPXOR
        (1, 0 | 1, 0x54..=0x57) | (1, 1, 0xDB | 0xDF | 0xEB | 0xEF) => Op::Vlogic {
            code: logic_code(code),
            dst: register,
            first,
            src: xmm_rm()?,
        },
        // VADD VMUL VSUB VDIV VSQRT VMIN VMAX PS/PD/SS/SD, VRSQRT VRCP PS/SS
        // (the latter steps without x64_sse_fast_check: Decoder::at)
        (1, _, 0x58 | 0x59 | 0x5C | 0x5E | 0x51 | 0x5D | 0x5F) | (1, 0 | 2, 0x52 | 0x53) => {
            Op::Vfp {
                code,
                double: v.pp & 1 != 0,
                packed: v.pp < 2,
                dst: register,
                first,
                src: xmm_rm()?,
            }
        },
        // VUCOMISS/SD VCOMISS/SD
        (1, 0 | 1, 0x2E | 0x2F) => Op::Vcompare {
            double: v.pp == 1,
            dst: register,
            src: xmm_rm()?,
        },
        // VCVTSI2SS/SD, VCVT(T)SS2SI/SD2SI (VEX.W1: 64-bit integers), VCVTSS2SD, VCVTSD2SS
        (1, 2 | 3, 0x2A | 0x2C | 0x2D | 0x5A) => Op::Vconvert {
            convert: conversion(d, key, gpr_w(d))?,
            dst: register,
            first,
        },
        // (the forms below emit Wasm SIMD: not in the build for engines without it)
        _ if !cfg!(target_feature = "simd128") => return None,
        // VBROADCASTSS xmm, m32 (AVX2: also xmm), VPBROADCASTB/W/D/Q (AVX2)
        (2, 1, 0x18 | 0x58 | 0x59 | 0x78 | 0x79) => Op::Vbroadcast {
            bytes: broadcast_bytes(code),
            dst: register,
            src: xmm_rm()?,
            wide: false,
        },
        // VPSHUFD VPSHUFHW VPSHUFLW (the source's lanes), VSHUFPS VSHUFPD
        (1, 1..=3, 0x70) | (1, 0 | 1, 0xC6) => Op::Vpacked {
            op: vec::shuffle(key, imm? as u32 & 0xFF),
            dst: register,
            first: if code == 0x70 { register } else { first },
            src: xmm_rm()?,
        },
        // VUNPCKLPS/PD VUNPCKHPS/PD (an m128)
        (1, 0 | 1, 0x14 | 0x15) => Op::Vpacked {
            op: Packed::Unpack(if v.pp == 1 { 8 } else { 4 }, code == 0x15),
            dst: register,
            first,
            src: xmm_rm()?,
        },
        // the shifts by imm8: VEX.vvvv the destination, the r/m register the source
        (1, 1, 0x71..=0x73) if !memory => {
            let kind = group;
            let bytes = matches!(kind, 3 | 7) && code == 0x73;
            if !(matches!(kind, 2 | 4 | 6) && !(code == 0x73 && kind == 4) || bytes) {
                return None;
            }
            Op::VshiftImm {
                dst: first,
                src: d.rm_register?,
                bits: if bytes { 128 } else { 16 << (code - 0x71) },
                kind,
                count: imm?.min(255) as u8,
                wide: false,
            }
        },
        // VPMOVMSKB VMOVMSKPS VMOVMSKPD
        (1, 1, 0xD7) | (1, 0 | 1, 0x50) if !memory => Op::Vmovmsk {
            dst: Reg {
                index: register,
                high: false,
            },
            src: d.rm_register?,
            lane: movmsk_lane(key),
        },
        // VCMPPS/PD/SS/SD (imm8[4:0])
        (1, _, 0xC2) => Op::Vcmp {
            double: v.pp & 1 != 0,
            scalar: v.pp >= 2,
            predicate: imm? as u8 & 31,
            dst: register,
            first,
            src: xmm_rm()?,
        },
        // the packed integer operations of 66 0F
        (1, 1, _) => Op::Vpacked {
            op: vec::packed_op(code, false)?,
            dst: register,
            first,
            src: xmm_rm()?,
        },
        // VBLENDVPS VBLENDVPD VPBLENDVB: the mask register imm8[7:4] (in
        // 32-bit mode imm8[6:4]: bit 7 is ignored)
        (3, 1, 0x4A..=0x4C) => Op::Vblendv {
            lane: [4, 8, 1][(code - 0x4A) as usize],
            dst: register,
            first,
            src: xmm_rm()?,
            mask: (imm? >> 4 & if d.mode == ExecutionMode::Long64 { 15 } else { 7 }) as u8,
        },
        // VROUNDPS/PD (one source), VROUNDSS/SD
        (3, 1, 0x08..=0x0B) => Op::Vround {
            double: code & 1 != 0,
            scalar: code & 2 != 0,
            imm8: imm? as u8,
            dst: register,
            first: if code & 2 != 0 { first } else { register },
            src: xmm_rm()?,
        },
        // VPCMPESTRM/I VPCMPISTRM/I (VEX.W1: the lengths RAX and RDX)
        (3, 1, 0x60..=0x63) => Op::Vstrings {
            op: code,
            imm8: imm? as u8,
            wide: gpr_w(d),
            dst: register,
            src: xmm_rm()?,
        },
        // VPSHUFB VPALIGNR, the SSE4.1 forms of one operation, the blends by imm8
        (2, 1, 0x00) => Op::Vpacked {
            op: Packed::Swizzle(0x8F),
            dst: register,
            first,
            src: xmm_rm()?,
        },
        (3, 1, 0x0F) => Op::Vpacked {
            op: palignr(imm?),
            dst: register,
            first,
            src: xmm_rm()?,
        },
        (2 | 3, 1, _) => Op::Vpacked {
            op: sse4_packed(key, imm)?,
            dst: register,
            first,
            src: xmm_rm()?,
        },
        _ => return None,
    })
}

fn cond_reads(cc: u8) -> u32 {
    match cc >> 1 {
        0 => OF,
        1 => CF,
        2 => ZF,
        3 => CF | ZF,
        4 => SF,
        5 => PF,
        6 => SF | OF,
        _ => ZF | SF | OF,
    }
}
fn shift_count(width: u8, count: u8) -> u8 { count & if width == 64 { 63 } else { 31 } }
/// (read, written) EFLAGS arithmetic bits.
/// How an instruction uses the XMM registers with XMM locals (P4.17)
enum XmmUse {
    /// none
    None,
    /// these (a mask), through the cached accessors, as v128 values
    Hold(u16),
    /// these by lanes in general registers (vfp, scalar moves): held ones
    /// from their locals, the others from memory, nothing loaded for them
    /// (a lane's way between a v128 register and a general one costs more
    /// than its memory)
    Lanes,
    /// some by their memory (other vector code, helpers): the locals are
    /// written back and dropped first
    Memory,
}
/// Whether an instruction may leave its function (retry, step or exit), as
/// all but arithmetic on registers and immediates may (P4.23)
fn may_leave(inst: &Inst) -> bool {
    if inst.straddle.is_some() || inst.span_straddle || inst.locked {
        return true;
    }
    let mem = |o: &Opnd| matches!(o, Opnd::Mem(_));
    match &inst.op {
        Op::Alu { dst, src, .. } | Op::Mov { dst, src, .. } => mem(dst) || mem(src),
        Op::Test { a, b, .. } => mem(a) || mem(b),
        Op::Imul { a, b, .. } => mem(a) || mem(b),
        Op::Extend { src, .. } | Op::Cmov { src, .. } | Op::MulWide { src, .. } => mem(src),
        Op::IncDec { dst, .. }
        | Op::Neg { dst, .. }
        | Op::Not { dst, .. }
        | Op::Shift { dst, .. }
        | Op::Setcc { dst, .. } => mem(dst),
        Op::Lea { .. } | Op::Bswap { .. } | Op::Nop | Op::Lahf | Op::Sahf => false,
        Op::Flag { opcode } => !matches!(opcode, 0xF5 | 0xF8 | 0xF9),
        _ => true,
    }
}
/// The XMM registers an instruction may write (P4.18's register facts end
/// there)
fn xmm_written(op: &Op) -> u16 {
    let bit = |n: u8| 1u16 << n;
    match *op {
        Op::Vmove {
            dst: Xmm::Reg(d), ..
        }
        | Op::Vmove256 {
            dst: Xmm::Reg(d), ..
        } => bit(d),
        Op::Vmove { .. } | Op::Vmove256 { .. } => 0,
        Op::Vfused { dst, .. }
        | Op::Vlogic { dst, .. }
        | Op::Vfp { dst, .. }
        | Op::MovdIn { dst, .. }
        | Op::Vpacked { dst, .. }
        | Op::Vround { dst, .. }
        | Op::VshiftImm { dst, .. }
        | Op::Vpacked256 { dst, .. }
        | Op::Vinsert128 { dst, .. }
        | Op::Vperm2 { dst, .. }
        | Op::Vbroadcast { dst, .. }
        | Op::Vcmp { dst, .. }
        | Op::Vblendv { dst, .. }
        | Op::Vcvt { dst, .. } => bit(dst),
        Op::Vconvert {
            convert: Convert::ToInteger { .. },
            ..
        } => 0,
        Op::Vconvert { dst, .. } => bit(dst),
        // (bits 255:128 only; general registers, flags, MXCSR)
        Op::Vzeroupper
        | Op::MovdOut { .. }
        | Op::Vmovmsk256 { .. }
        | Op::Vmovmsk { .. }
        | Op::Vcompare { .. }
        | Op::Mxcsr { .. } => 0,
        // (PCMPxSTRM: XMM0)
        Op::Vstrings { .. } | Op::Vzeroall | Op::Step | Op::FarCall { .. } | Op::FarRet { .. } => {
            !0
        },
        _ => 0,
    }
}
/// A kept translation (x64_fast_lookup, P4.21; Emitter::lookup_kept): of
/// the operands with base register `base`, of its kind (`write`) and
/// displacement page (kept_page), the page's tag (0 for none) and its delta
struct Kept {
    base: u8,
    write: bool,
    page: i64,
    tag: KeptTag,
    delta: WasmLocal,
}
/// A kept translation's tag: the access cache's (i64), or with
/// x64_compat_tlb the page | 1 << 20, an i32 as the in-page test is, which
/// V8 then compares in one branch (cmp, ccmp)
enum KeptTag {
    Wide(WasmLocalI64),
    Narrow(WasmLocal),
}
impl KeptTag {
    fn wide(&self) -> &WasmLocalI64 {
        match self {
            KeptTag::Wide(l) => l,
            KeptTag::Narrow(_) => unreachable!("an i32 tag"),
        }
    }
    fn narrow(&self) -> &WasmLocal {
        match self {
            KeptTag::Narrow(l) => l,
            KeptTag::Wide(_) => unreachable!("an i64 tag"),
        }
    }
    /// Forget it (INVLPG, steps)
    fn forget(&self, b: &mut WasmBuilder) {
        match self {
            KeptTag::Wide(l) => {
                b.const_i64(0);
                b.set_local_i64(l);
            },
            KeptTag::Narrow(l) => {
                b.const_i32(0);
                b.set_local(l);
            },
        }
    }
}
/// Kept translations per function
const MAX_KEPT: usize = 32;
/// A lazy record's bit: an INC or DEC whose `a` is its result
/// (Emitter::unit_record, pages::x64_page_flags)
pub const RECORD_UNIT: u32 = 1 << 24;
/// The displacement page of an operand `[r + displacement]`, which kept
/// translations tell apart: two arrays a loop reads through one register,
/// as `[EAX + 0x403000]` and `[EAX + 0x423000]`, would otherwise replace
/// each other's translation at every access (the page of displacements
/// within 2 KiB of 0 is 0: a structure's fields, a frame's slots)
fn kept_page(displacement: i64) -> i64 { displacement.wrapping_add(2048) >> 12 }
/// The i8x16.shuffle of a v128 whose low `bytes` come from the first operand
/// and the others from the second
fn low_lanes(bytes: u8) -> [u8; 16] {
    let mut lanes = [0; 16];
    for (k, lane) in lanes.iter_mut().enumerate() {
        *lane = if k < bytes as usize { k as u8 } else { 16 + k as u8 };
    }
    lanes
}
/// The XMM register an instruction overwrites whole, unconditionally and
/// without reading it (XMM locals: Emitter::xmm_claim)
fn xmm_overwritten(op: &Op) -> u16 {
    let names = |x: Xmm, n: u8| matches!(x, Xmm::Reg(r) if r == n);
    match *op {
        Op::Vmove {
            bits: 128,
            dst: Xmm::Reg(d),
            src,
            ..
        } if !names(src, d) => 1 << d,
        // (a scalar load zeroes the rest, a register move zeroes it or takes
        // it from VEX.vvvv)
        Op::Vmove {
            dst: Xmm::Reg(d),
            src: Xmm::Mem(_),
            ..
        } => 1 << d,
        Op::Vmove {
            dst: Xmm::Reg(d),
            src,
            zero,
            upper,
            ..
        } if !names(src, d) && (zero || upper.is_some_and(|first| first != d)) => 1 << d,
        Op::Vlogic {
            dst, first, src, ..
        }
        | Op::Vpacked {
            dst, first, src, ..
        } if dst != first && !names(src, dst) => 1 << dst,
        Op::VshiftImm {
            dst,
            src,
            wide: false,
            ..
        } if dst != src => 1 << dst,
        Op::Vmove256 {
            dst: Xmm::Reg(d),
            src,
            ..
        } if !names(src, d) => 1 << d,
        Op::Vpacked256 {
            dst, first, src, ..
        } if dst != first && !names(src, dst) => 1 << dst,
        Op::Vbroadcast { dst, src, .. } if !names(src, dst) => 1 << dst,
        Op::Vconvert {
            convert: Convert::FromInteger { .. },
            dst,
            first,
        } if dst != first => 1 << dst,
        _ => 0,
    }
}
/// Vector code that reads or writes XMM registers by their memory (not
/// through the cached accessors of P4.17)
fn touches_vectors(op: &Op) -> bool {
    matches!(
        op,
        Op::Vfused { .. }
            | Op::Vfp { .. }
            | Op::Vstrings { .. }
            | Op::Vround { .. }
            | Op::VshiftImm { .. }
            | Op::Vzeroupper
            | Op::Vmove256 { .. }
            | Op::Vzeroall
            | Op::Vpacked256 { .. }
            | Op::Vinsert128 { .. }
            | Op::Vperm2 { .. }
            | Op::Vmovmsk256 { .. }
            | Op::Vbroadcast { .. }
            | Op::Vmovmsk { .. }
            | Op::Vcmp { .. }
            | Op::Vblendv { .. }
            | Op::Vcvt { .. }
            | Op::Vconvert { .. }
            | Op::Vcompare { .. }
    )
}
/// Per instruction of `block`, the XMM registers worth holding (P4.17):
/// those its stretch of the block (between XmmUse::Memory instructions)
/// names twice or more, so a held register saves memory accesses
/// (`fast_check`: CompileEnv::sse_fast_check, see xmm_use)
fn xmm_worth(block: &Block, fast_check: bool) -> Vec<u16> {
    let mut worth = vec![0; block.insts.len()];
    let mut begin = 0;
    for end in 0..=block.insts.len() {
        let memory = end == block.insts.len()
            || matches!(xmm_use(&block.insts[end].op, fast_check), XmmUse::Memory);
        if !memory {
            continue;
        }
        let (mut once, mut twice) = (0u16, 0u16);
        for inst in &block.insts[begin..end] {
            if let XmmUse::Hold(registers) = xmm_use(&inst.op, fast_check) {
                twice |= once & registers;
                once |= registers;
            }
        }
        for w in &mut worth[begin..end] {
            *w = twice;
        }
        begin = end + 1;
    }
    worth
}
/// (`fast_check`: CompileEnv::sse_fast_check, whose Op::Vfp is a template)
/// The 32-bit TLB entry bits that must read TLB_VALID for a read or a
/// write in compatibility mode (Emitter::host_tlb; Tier-0's masks): valid,
/// for a write writable and without code, for user code a user page; not
/// device memory (TLB_IN_MAPPED_RANGE)
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
/// The run of register-only x87 forms (x86tpl::x87run) that `insts`
/// start with, if three or more (Tier-0's threshold) join it; never an
/// instruction that runs into the next page (Inst::straddle checks it)
fn x87_run_at(insts: &[Inst]) -> Option<X87Run> {
    let mut run = X87Run::new();
    while let Some(inst) = insts.get(run.length) {
        let joins = match inst.op {
            Op::X87 {
                opcode,
                modrm,
                io: crate::x86tpl::x87_forms::Io::Stack,
                ..
            } if inst.straddle.is_none() && !inst.span_straddle => run.append(opcode, modrm),
            _ => false,
        };
        if !joins {
            break;
        }
    }
    (run.length >= 3).then_some(run)
}
fn xmm_use(op: &Op, fast_check: bool) -> XmmUse {
    let bit = |n: u8| 1u16 << n;
    let reg = |x: &Xmm| match x {
        Xmm::Reg(n) => bit(*n),
        Xmm::Mem(_) => 0,
    };
    match op {
        Op::Vmove {
            dst,
            src,
            bits: 128,
            ..
        } => XmmUse::Hold(reg(dst) | reg(src)),
        // (the scalar moves as v128 values: v128.load64_zero, shuffles)
        Op::Vmove {
            dst, src, upper, ..
        } => XmmUse::Hold(reg(dst) | reg(src) | upper.map_or(0, bit)),
        Op::Vlogic {
            dst, first, src, ..
        }
        | Op::Vpacked {
            dst, first, src, ..
        } => XmmUse::Hold(bit(*dst) | bit(*first) | reg(src)),
        Op::VshiftImm {
            dst,
            src,
            wide: false,
            ..
        } => XmmUse::Hold(bit(*dst) | bit(*src)),
        // (x86tpl::ops through pagegen_vec::Operands' 128-bit accessors)
        Op::Vfused {
            dst, first, src, ..
        }
        | Op::Vround {
            dst, first, src, ..
        }
        | Op::Vcmp {
            dst, first, src, ..
        } => XmmUse::Hold(bit(*dst) | bit(*first) | reg(src)),
        Op::Vfp {
            dst, first, src, ..
        } if fast_check => XmmUse::Hold(bit(*dst) | bit(*first) | reg(src)),
        Op::Vblendv {
            dst,
            first,
            src,
            mask,
            ..
        } => XmmUse::Hold(bit(*dst) | bit(*first) | reg(src) | bit(*mask)),
        Op::Vbroadcast { dst, src, .. } => XmmUse::Hold(bit(*dst) | reg(src)),
        // (VEX.256 through the templates: the low halves as XMM registers,
        // bits 255:128 in memory, as Tier-0's)
        Op::Vmove256 { dst, src, .. } => XmmUse::Hold(reg(dst) | reg(src)),
        Op::Vpacked256 {
            dst, first, src, ..
        } => XmmUse::Hold(bit(*dst) | bit(*first) | reg(src)),
        Op::Vmovmsk256 { src, .. } => XmmUse::Hold(bit(*src)),
        // (bits 255:128 only)
        Op::Vzeroupper => XmmUse::None,
        Op::Vmovmsk { src, .. } => XmmUse::Hold(bit(*src)),
        Op::Vcvt { dst, src, .. } => XmmUse::Hold(bit(*dst) | reg(src)),
        // (CVTSI2SS/SD's result by a lane insert, vconvert)
        Op::Vconvert {
            convert: Convert::FromInteger { .. },
            dst,
            first,
        } => XmmUse::Hold(bit(*dst) | bit(*first)),
        // (lanes in general registers)
        Op::Vfp { .. }
        | Op::MovdIn { .. }
        | Op::MovdOut { .. }
        | Op::Vcompare { .. }
        | Op::Vconvert { .. } => XmmUse::Lanes,
        _ if touches_vectors(op) => XmmUse::Memory,
        _ => XmmUse::None,
    }
}

impl Level {
    /// The level of `units` (no labels yet), re-entered at `repeat`
    fn of(units: &[Unit], blocks: usize, repeat: Label) -> Level {
        let mut unit_of = vec![u32::MAX; blocks];
        let mut single = vec![];
        for (u, unit) in units.iter().enumerate() {
            let mut members = vec![];
            unit.blocks(&mut members);
            for k in members {
                unit_of[k as usize] = u as u32;
            }
            single.push(match unit {
                Unit::Block(k) => Some(*k),
                Unit::Loop { .. } => None,
            });
        }
        Level {
            repeat,
            unit_of,
            labels: vec![],
            single,
            current: 0,
            direct: false,
        }
    }
}
/// The structured layout of a page function (P4.16, x64_loops): each cycle
/// of its block graph a loop, nested (x64::loops, IR Tier-0's analysis);
/// without the switch every block is a unit of the page level. Loops whose
/// dispatch table would span too much of the page are flattened as Tier-0's.
fn layout(blocks: &[Block], index: &BTreeMap<u16, usize>, loops: bool, span: u64) -> Vec<Unit> {
    use super::loops::{flatten, units, visit_loops, MAX_LOOP_TABLE, MAX_LOOP_TABLES};
    if !loops {
        return (0..blocks.len() as u32).map(Unit::Block).collect();
    }
    // static in-page successors (a step and dynamic targets dispatch)
    let successors: Vec<Vec<u32>> = blocks
        .iter()
        .map(|b| {
            let mut out = vec![];
            let mut to = |o: u16| {
                if let Some(&k) = index.get(&o) {
                    out.push(k as u32);
                }
            };
            match b.insts.last().map(|i| i.op) {
                Some(Op::Step) => return out,
                Some(Op::Jcc { target, .. })
                | Some(Op::LoopJump { target, .. })
                | Some(Op::Jmp { target })
                | Some(Op::Call { target }) => {
                    if let Some(o) = in_page(span, target) {
                        to(o);
                    }
                },
                _ => {},
            }
            if let End::Next(o) | End::Shadow(o) = b.end {
                if (o as u64) < span {
                    to(o);
                }
            }
            out
        })
        .collect();
    let all: Vec<u32> = (0..blocks.len() as u32).collect();
    let mut layout = units(&all, &successors, None);
    let start = |k: u32| blocks[k as usize].start as usize;
    let range = |unit: &Unit| {
        let mut members = vec![];
        unit.blocks(&mut members);
        members.iter().map(|&k| start(k)).max().unwrap() - start(unit.first()) + 1
    };
    flatten(&mut layout, &|unit| range(unit) > MAX_LOOP_TABLE);
    loop {
        let (mut total, mut widest) = (0, 0);
        visit_loops(&layout, &mut |unit| {
            total += range(unit);
            widest = widest.max(range(unit));
        });
        if total <= MAX_LOOP_TABLES {
            break;
        }
        flatten(&mut layout, &|unit| range(unit) == widest);
    }
    layout
}

/// Whether the instruction at `next`, in STI's interrupt shadow, compiles
/// into STI's block (x64_sti_shadow): it decodes within the page, is no
/// control transfer, step, STI or REP string instruction (block boundaries),
/// and the instruction after it starts a block (a discovery cut short may
/// not have reached STI) or is on the next page
fn shadowed(decoder: &mut Decoder, next: u16, starts: &BTreeSet<u16>) -> bool {
    let span = decoder.span_bytes;
    if next as usize >= span {
        return false;
    }
    let Some((d, op)) = decoder.at(next)
    else {
        return false;
    };
    let after = next as usize + d.length as usize;
    after <= span
        && (after == span || starts.contains(&(after as u16)))
        && !(cfg!(feature = "parallel") && locked_rmw(&d, &op) && !lockable(&op))
        && !matches!(
            op,
            Op::Jcc { .. }
                | Op::LoopJump { .. }
                | Op::LoadSreg { .. }
                | Op::PopSreg { .. }
                | Op::Step
                | Op::Jmp { .. }
                | Op::Call { .. }
                | Op::CallIndirect { .. }
                | Op::Ret { .. }
                | Op::JmpIndirect { .. }
                | Op::FarCall { .. }
                | Op::FarRet { .. }
                | Op::Sti
                | Op::StiShadowed
                | Op::Movs { rep: true, .. }
                | Op::Stos { rep: true, .. }
                | Op::RepCompare { .. }
        )
}
/// The EFLAGS bits an instruction reads and writes; in compatibility mode
/// (P7.2) a multiply writes them all, as the 32-bit interpreter leaves SF,
/// ZF, PF and AF of its result (see Emitter::legacy_mul_flags)
fn effects(op: &Op, compat: bool) -> (u32, u32) {
    if compat && matches!(op, Op::Imul { .. } | Op::MulWide { .. }) {
        return (0, ARITH);
    }
    // (compatibility mode: INC and DEC keep CF, so the producer before them
    // computes it at once instead of leaving it to the record they replace,
    // whose helper call a loop's DEC ECX paid every iteration)
    if compat && matches!(op, Op::IncDec { .. }) {
        return (CF, ARITH & !CF);
    }
    // (compatibility mode: the 32-bit interpreter's BSF and BSR write every
    // flag (CF clear, SF, PF, AF and OF of their lazy record), and SHLD and
    // SHRD with a nonzero count too)
    match (compat, op) {
        (true, Op::BitScan { .. }) => return (0, ARITH),
        // (a zero count keeps every flag: it reads them)
        (true, Op::DoubleShiftCl { .. }) => return (ARITH, ARITH),
        (true, Op::DoubleShift { width, count, .. }) => {
            return if shift_count(*width, *count) == 0 { (0, 0) } else { (0, ARITH) };
        },
        _ => {},
    }
    // (compatibility mode: the 32-bit interpreter's shifts write OF for any
    // count, and SHL, SHR and SAR AF; a zero count changes nothing)
    if let (true, Op::Shift { code, count, .. }) = (compat, op) {
        let writes = if *code <= 1 { CF | OF } else { ARITH };
        return match count {
            Some(count) if count & 31 == 0 => (0, 0),
            Some(_) => (0, writes),
            None => (writes, writes),
        };
    }
    match *op {
        Op::Alu { code: 2 | 3, .. } => (CF, ARITH),
        Op::Alu { .. }
        | Op::Test { .. }
        | Op::Neg { .. }
        | Op::Xadd { .. }
        | Op::Cmpxchg { .. }
        | Op::Popcnt { .. } => (0, ARITH),
        Op::IncDec { .. } => (0, ARITH & !CF),
        Op::Shift {
            code,
            width,
            count: Some(count),
            ..
        } => {
            let raw = shift_count(width, count);
            if raw == 0 {
                (0, 0)
            }
            else {
                let of = if raw == 1 { OF } else { 0 };
                (0, if code >= 4 { CF | PF | ZF | SF | of } else { CF | of })
            }
        },
        // A zero CL count leaves every flag unchanged; rotates only set CF/OF.
        Op::Shift {
            code: 0 | 1,
            count: None,
            ..
        } => (CF | OF, CF | OF),
        Op::Shift { count: None, .. } => (CF | PF | ZF | SF | OF, CF | PF | ZF | SF | OF),
        // (the helper takes and returns all of EFLAGS)
        Op::ShiftCall { .. } => (ARITH, ARITH),
        Op::Imul { .. } | Op::MulWide { .. } => (0, CF | OF),
        Op::Bt { .. } => (0, CF),
        Op::BitScan { .. } => (0, ZF),
        Op::Bmi {
            op: BmiOp::Shlx | BmiOp::Shrx | BmiOp::Sarx | BmiOp::Rorx(_),
            ..
        } => (0, 0),
        Op::Bmi { .. } => (0, ARITH),
        Op::Jcc { cc, .. } | Op::Cmov { cc, .. } | Op::Setcc { cc, .. } => (cond_reads(cc), 0),
        // (LOOPNE and LOOPE)
        Op::LoopJump { kind: 0 | 1, .. } => (ZF, 0),
        // (the helper keeps FLAGS' other bits: it reads them all)
        Op::X87Flags { .. } => (ARITH, ARITH),
        Op::Fcmov { cc, .. } => (cond_reads(cc), 0),
        Op::Pushf => (ARITH, 0),
        Op::Flag { opcode: 0xF5 } => (CF, CF),
        Op::Flag {
            opcode: 0xF8 | 0xF9,
        } => (0, CF),
        Op::Lahf => (SF | ZF | AF | PF | CF, 0),
        Op::DoubleShift { width, count, .. } => {
            let count = shift_count(width, count);
            (
                0,
                if count == 0 { 0 } else { CF | PF | ZF | SF | if count == 1 { OF } else { 0 } },
            )
        },
        Op::CompareExchange { .. } => (0, ZF),
        Op::Sahf => (0, SF | ZF | AF | PF | CF),
        Op::Vcompare { .. } | Op::Vstrings { .. } => (0, ARITH),
        Op::Step | Op::FarCall { .. } | Op::FarRet { .. } => (ARITH, ARITH),
        // (RCX = 0 leaves EFLAGS as they were)
        Op::RepCompare { .. } => (ARITH, ARITH),
        _ => (0, 0),
    }
}

/// A flags producer whose operands a later condition can compare directly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Known {
    /// fa - fb = fr (CMP, SUB, NEG, CMPXCHG)
    Sub(u8),
    /// fr, with CF = OF = 0 (AND, OR, XOR, TEST)
    Logic(u8),
    /// only ZF, SF, PF of fr (ADD, XADD, INC, DEC)
    Result(u8),
}
fn producer(op: &Op) -> Option<Known> {
    match *op {
        Op::Alu {
            code: 5 | 7, width, ..
        }
        | Op::Neg { width, .. }
        | Op::Cmpxchg { width, .. } => Some(Known::Sub(width)),
        Op::Alu {
            code: 1 | 4 | 6,
            width,
            ..
        }
        | Op::Test { width, .. } => Some(Known::Logic(width)),
        Op::Alu { code: 0, width, .. } | Op::Xadd { width, .. } | Op::IncDec { width, .. } => {
            Some(Known::Result(width))
        },
        _ => None,
    }
}
fn fusable(known: Known, cc: u8) -> bool {
    match known {
        Known::Sub(_) | Known::Logic(_) => true,
        Known::Result(_) => matches!(cc >> 1, 2 | 4 | 5),
    }
}

struct Inst {
    d: Decoded,
    op: Op,
    /// EFLAGS bits the instruction reads (materialized first when pending)
    flags_read: u32,
    /// Liveness input: flags_read, but 0 for fused consumers and steps
    /// (which materialize everything themselves).
    reads: u32,
    writes: u32,
    live_out: u32,
    /// The EFLAGS bits a way out of the function before they are written
    /// again may observe (a retry, step or exit of a later instruction of
    /// the block, or the block's end), as the interpreter then reads them
    /// from memory: P4.23
    exit_live: u32,
    /// Condition from the producer operands instead of EFLAGS.
    fused: Option<Known>,
    /// Producer: keep operands for a fused consumer.
    keep: bool,
    /// An instruction that continues into the next page: its bytes there
    /// (little endian) and how many. It runs only while the next page
    /// fetches as these bytes (x64_page_straddle), else it is stepped.
    straddle: Option<(u64, u8)>,
    /// An instruction that continues into the next page of its span
    /// (P7.3b): it runs only while that page was verified, else it is
    /// stepped
    span_straddle: bool,
    /// A locked read-modify-write of memory (LOCK, XCHG) with cores in
    /// workers: committed with a compare-exchange loop (Emitter::read_dst)
    locked: bool,
    /// A volatile instruction's immediate (CompileEnv::volatile): its offset
    /// in the span, bytes and sign extension; Emitter::read loads it
    dynamic: Option<(u16, u8, bool)>,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum End {
    /// Continue at this page offset (4096: the next page).
    Next(u16),
    /// The last instruction transferred control.
    Stop,
    /// Interpret the instruction at this offset (undecodable here).
    Retry(u16),
    /// Step the instruction at this offset in place: it continues into the
    /// next page (or does not decode), so the interpreter fetches it.
    StepAt(u16),
    /// STI's shadow ended (Op::StiShadowed): leave for a deliverable
    /// interrupt, else continue at this offset.
    Shadow(u16),
}
struct Block {
    start: u16,
    insts: Vec<Inst>,
    end: End,
    live_in: u32,
}

/// The offset of `target` (relative to the function's first page) in its
/// `span` bytes
fn in_page(span: u64, target: u64) -> Option<u16> { (target < span).then_some(target as u16) }
fn is_rep_string(d: &Decoded) -> bool {
    d.prefixes.rep.is_some() && matches!(d.base_opcode(), 0x6C..=0x6F | 0xA4..=0xA7 | 0xAA..=0xAF)
}

/// With cores in workers: a locked read-modify-write of memory.
fn locked_rmw(d: &Decoded, op: &Op) -> bool {
    crate::parallel::active()
        && d.rm_register.is_none()
        && (d.prefixes.lock
            || matches!(
                op,
                Op::Xchg {
                    a: Opnd::Mem(_),
                    ..
                }
            ))
}
/// Templates that commit a locked memory operand with a compare-exchange
/// loop (Emitter::read_dst and write_dst; the rest are stepped).
fn lockable(op: &Op) -> bool {
    match *op {
        Op::Alu {
            code,
            dst: Opnd::Mem(_),
            ..
        } => code != 7,
        Op::IncDec {
            dst: Opnd::Mem(_), ..
        }
        | Op::Neg {
            dst: Opnd::Mem(_), ..
        }
        | Op::Not {
            dst: Opnd::Mem(_), ..
        }
        | Op::Xadd {
            dst: Opnd::Mem(_), ..
        }
        | Op::Cmpxchg {
            dst: Opnd::Mem(_), ..
        }
        | Op::Xchg {
            a: Opnd::Mem(_), ..
        } => true,
        Op::Bt {
            action,
            dst: Opnd::Mem(_),
            ..
        } => action != 0,
        _ => false,
    }
}

pub struct Compiled {
    pub bytes: Vec<u8>,
    /// Block starts, as a bitmap of offsets (64 words a page of the span)
    pub served: Vec<u64>,
    /// The bytes its instructions were decoded from, as a bitmap of offsets
    /// (as `served`): a write elsewhere leaves the code as it is
    /// (pages::dirty_bytes)
    pub code: Vec<u64>,
    /// The offsets its instructions start at, as `served`
    pub starts: Vec<u64>,
    /// The bytes of its volatile instructions it reads where it runs
    /// (CompileEnv::volatile: an immediate, or a stepped instruction), as
    /// `served`
    pub dynamic: Vec<u64>,
    pub instructions: usize,
    pub templated: usize,
    pub blocks: usize,
}

/// Multiplicative hashing of page offsets (the default SipHash showed in
/// compile profiles).
#[derive(Default)]
struct OffsetHasher(u64);
impl std::hash::Hasher for OffsetHasher {
    fn finish(&self) -> u64 { self.0 }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(8) ^ b as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        }
    }
    fn write_u16(&mut self, value: u16) {
        self.0 = (value as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}
struct Decoder<'a> {
    bytes: &'a [u8],
    /// the first bytes of the next page as compiled (may be empty)
    next: &'a [u8],
    page: u64,
    cache: HashMap<u16, Option<(Decoded, Op)>, std::hash::BuildHasherDefault<OffsetHasher>>,
    /// The templates of x64_cvt (CompileEnv::cvt): else they are steps
    cvt: bool,
    /// x64_sse_fast_check (CompileEnv::sse_fast_check): else SQRT, RSQRT,
    /// RCP, MIN and MAX are steps
    sse_fast_check: bool,
    /// Long64, or Compatibility32 (CompileEnv::compat), or Protected16
    /// (CompileEnv::prot16)
    mode: ExecutionMode,
    /// CompileEnv::ip_base of 16-bit code: its near branch targets wrap
    ip_base: Option<i32>,
    /// CompileEnv::legacy: legacy_template's forms; operands in GS are steps
    /// (GS is null in XP and Win98, and a null selector's accesses are #GP:
    /// the interpreter's) unless compiled for segment bases, which check
    /// (CompileEnv::segmented)
    legacy: bool,
    segmented: bool,
    /// CompileEnv::stack16
    stack16: bool,
    /// The bytes of the span (CompileEnv::span: 4096 a page)
    span_bytes: usize,
    /// CompileEnv::volatile
    volatile: [u16; MAX_VOLATILE],
}
impl Decoder<'_> {
    fn at(&mut self, offset: u16) -> Option<(Decoded, Op)> {
        let (bytes, next, page, cvt, fast_check, mode, legacy, segmented, span, ip_base) = (
            self.bytes,
            self.next,
            self.page,
            self.cvt,
            self.sse_fast_check,
            self.mode,
            self.legacy,
            self.segmented,
            self.span_bytes,
            self.ip_base,
        );
        let stack16 = self.stack16;
        let volatile = self.volatile.contains(&offset);
        *self.cache.entry(offset).or_insert_with(|| {
            let d = decode::decode_with(GuestIp(page + offset as u64), mode, |i| {
                let at = offset as usize + i as usize;
                if at < span { bytes.get(at) } else { next.get(at - span) }
                    .copied()
                    .ok_or(())
            })
            .ok()?;
            // (at most 8 bytes in the next page: x64_page_straddle compares
            // one word; a span's last page only: a span's straddles step)
            let end = offset as usize + d.length as usize;
            if end > span + 8 || span > PAGE && end > span {
                return None;
            }
            let op = match classify(&d) {
                Op::Vcvt { .. } if !cvt => Op::Step,
                Op::Vfp {
                    code: 0x51..=0x53 | 0x5D | 0x5F,
                    ..
                } if !fast_check => Op::Step,
                // (legacy mode: GS is null in XP and Win98; LOOP, segment
                // loads and others: legacy_template)
                _ if legacy && !segmented && d.address.is_some_and(|a| a.segment == 5) => Op::Step,
                Op::Step if legacy => legacy_template(&d).unwrap_or(Op::Step),
                op => op,
            };
            // (a stack of the other width than the code's, M11: PUSHA and
            // POPA's 32 bytes wrap at SP 0 push by push, ENTER's template is
            // 16-bit code's on a 16-bit stack)
            let op = match op {
                Op::Pusha | Op::Popa if stack16 && !code16(mode) => Op::Step,
                Op::Enter { .. } if !stack16 => Op::Step,
                // (flat legacy-mode code's far transfers step, as in M10)
                Op::FarCall { .. } | Op::FarRet { .. } if !segmented => Op::Step,
                op => op,
            };
            let op = if volatile { volatile_op(&d, op) } else { op };
            let op = match ip_base {
                Some(ip_base) => wrap_ip(op, ip_base),
                None => op,
            };
            Some((d, op))
        })
    }
}

/// Everything besides the page's bytes, entries and name that a page
/// function's bytes depend on (docs/jit-unification-plan.md P2.0):
/// compile_with reads nothing else, so a recorded compilation replays to the
/// same bytes in another build (x64::replay), which pins the addresses below
/// to fixed pseudo values (cross-phase rule 4).
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct CompileEnv {
    /// x64_page_set_bucket_dispatch, x64_page_set_block_count,
    /// x64_page_set_outline
    pub bucket_dispatch: bool,
    pub block_count: bool,
    pub outline: bool,
    /// Leaving the page, tail-call the function serving the new page when
    /// the chaining table (pages::CHAIN) has it
    pub chaining: bool,
    /// FMA through the host's relaxed multiply-adds (helpers::relaxed_fma)
    pub relaxed_fma: bool,
    /// The packed conversions as templates (x64_page_set_cvt)
    pub cvt: bool,
    /// x64_page_set_sti_shadow (Op::StiShadowed)
    pub sti_shadow: bool,
    /// Access cache entries per table (jac::entries, x64_jac_entries; P4.15)
    pub jac_entries: u32,
    /// Loops of the block graph as Wasm loops (x64_page_set_loops; P4.16)
    pub loops: bool,
    /// XMM registers in v128 locals within a block (x64_page_set_xmm_locals;
    /// P4.17)
    pub xmm_locals: bool,
    /// SSE arithmetic through x86tpl::ops::float, refusals exact in place,
    /// MXCSR and SSE checked once per block (x64_page_set_sse_fast_check;
    /// P4.18)
    pub sse_fast_check: bool,
    /// 32-bit integer operations in i32 (x64_page_set_i32_ops; P4.20)
    pub i32_ops: bool,
    /// Inline lookups by the last byte's tag and the host delta
    /// (x64_page_set_fast_lookup; P4.21)
    pub fast_lookup: bool,
    /// The GPRs passed on in x64_chain_gprs when chaining
    /// (x64_page_set_fast_chain; P4.22)
    pub fast_chain: bool,
    /// Eager EFLAGS only where read or observable (x64_page_set_exit_flags;
    /// P4.23)
    pub exit_flags: bool,
    /// The page's code runs in compatibility mode, 32-bit (CS.L = 0, CS.D =
    /// 1; x64_page_compat32, docs/jit-unification-plan.md P7.2), its data
    /// and stack segments flat (pages::run checks it at entry): EIP, ESP and
    /// addresses wrap at 4 GiB, only the GPRs' low halves are read and
    /// written back, as the 32-bit interpreter does under WOW64
    pub compat: bool,
    /// Compatibility mode's memory operands look up the 32-bit TLB
    /// (x64_compat_tlb, Emitter::host_tlb) instead of the access cache
    pub compat_tlb: bool,
    /// The page's 32-bit code runs in legacy protected mode
    /// (x64_page_legacy32, P7.3), as `compat` (pages::legacy_runnable at
    /// entry) with compat_tlb, whose misses translate through the 32-bit
    /// paging (pages::x64_page_access32); FS is not null there, accesses
    /// through GS step (Decoder::legacy)
    pub legacy: bool,
    /// Legacy-mode code compiled for segment bases (P7.2(3),
    /// pages::segmented_runnable): ES, SS and DS operands, stack slots and
    /// string pointers add their segment's base (read at each access, as
    /// Tier-0's functions for other than flat segments do)
    pub segmented: bool,
    /// 16-bit protected-mode code (P7.7, pages::prot16_runnable), as
    /// `segmented` with 16-bit operands, addresses, IP and stack (SP wraps
    /// at 64 KiB, ESP's high half is kept). `ip_base` is the IP of the page's
    /// first byte (its linear address less CS's base): near branch targets
    /// wrap at 64 KiB by it, near calls push IPs, returns and indirect
    /// branches add CS's base back; the prologue leaves at once when CS's
    /// base differs. Real-mode and virtual-8086 code too (P7.8, `mode16`).
    pub prot16: bool,
    pub ip_base: i32,
    pub mode16: Mode16,
    /// The stack is 16-bit (SS.B clear): SP wraps at 64 KiB, ESP's high
    /// half kept. 16-bit code's but on a 32-bit stack, and 32-bit code
    /// compiled for segment bases on a 16-bit stack (Windows 98's thunks,
    /// M11)
    pub stack16: bool,
    /// The consecutive linear pages the function covers (P7.3b; 1 but in
    /// legacy mode): offsets run over all of them, and span_hosts are their
    /// pages' host addresses as compiled (mem8 + physical). Its prologue
    /// finds where it was entered by the 32-bit TLB entry of the entry page,
    /// verifies each page's entry, and control only passes to a page
    /// verified in that activation (else it leaves; a TLB flush or INVLPG
    /// ends activations)
    pub span: u8,
    pub span_hosts: [u32; MAX_SPAN],
    /// Offsets (u16::MAX: none) of instructions of a page that a write
    /// changed while compiled (P7.3, pages::dirty_bytes; a page compiled
    /// alone, span_hosts its host): an immediate source operand loads from
    /// the page where it runs (Inst::dynamic), other forms step. Their bytes
    /// are no code (Compiled::code): rewriting them keeps the function.
    pub volatile: [u16; MAX_VOLATILE],
    /// The page's execution counter, incremented at each entry and dispatch
    /// (outlined, cold compiles with x64_hot_inline: pages::run recompiles
    /// a page whose counter passes HOT_INLINE with inline lookups; P4.14)
    pub counter: Option<u32>,
    /// The exact helpers' operand block (helpers::SSE_FP_OPERANDS: FMA)
    pub sse_fp_operands: u32,
    /// Cores in workers: the kick a page function polls (cpu::core_yield),
    /// the code publication counters (parallel::code::pending_addresses)
    /// and the bounce buffer of unaligned accesses (pages::bounce_address)
    pub core_yield: u32,
    pub pending: [u32; 4],
    pub bounce: u32,
}
impl CompileEnv {
    /// The running instance's, chaining or not; `outline`: memory accesses
    /// call the module's lookup function (cold compiles; see OUTLINE_ACCESS),
    /// else inline it; `counter`: CompileEnv::counter; `compat`, `legacy`:
    /// CompileEnv::compat and CompileEnv::legacy
    pub fn current(
        chaining: bool,
        outline: bool,
        counter: Option<u32>,
        compat: bool,
        legacy: bool,
        segmented: bool,
        prot16: Option<(i32, Mode16)>,
        stack16: bool,
        span_hosts: &[u32],
    ) -> CompileEnv {
        let mut hosts = [0; MAX_SPAN];
        hosts[..span_hosts.len()].copy_from_slice(span_hosts);
        unsafe {
            CompileEnv {
                bucket_dispatch: BUCKET_DISPATCH,
                block_count: BLOCK_COUNT,
                outline,
                chaining,
                relaxed_fma: super::helpers::relaxed_fma(),
                cvt: CVT,
                sti_shadow: STI_SHADOW,
                jac_entries: jac::entries() as u32,
                loops: LOOPS == 1 || LOOPS == 2 && !outline,
                xmm_locals: XMM_LOCALS,
                sse_fast_check: SSE_FAST_CHECK,
                i32_ops: I32_OPS,
                fast_lookup: FAST_LOOKUP,
                // (the chained GPRs are 64-bit: not for 32-bit code)
                fast_chain: FAST_CHAIN && !compat,
                exit_flags: EXIT_FLAGS,
                compat,
                // (no access cache in legacy mode)
                compat_tlb: compat && (COMPAT_TLB || legacy),
                legacy,
                segmented,
                prot16: prot16.is_some(),
                ip_base: prot16.map_or(0, |p| p.0),
                mode16: prot16.map_or(Mode16::Protected, |p| p.1),
                stack16,
                span: span_hosts.len().max(1) as u8,
                span_hosts: hosts,
                volatile: [u16::MAX; MAX_VOLATILE],
                counter,
                sse_fp_operands: super::helpers::sse_fp_operands(),
                core_yield: &raw const crate::cpu::cpu::core_yield as u32,
                pending: if cfg!(feature = "parallel") {
                    crate::parallel::code::pending_addresses()
                }
                else {
                    [0; 4]
                },
                bounce: super::pages::bounce_address(),
            }
        }
    }
    /// Replay's: the recorded switches, fixed pseudo addresses
    pub fn replay(
        bucket_dispatch: bool,
        block_count: bool,
        outline: bool,
        chaining: bool,
        relaxed_fma: bool,
        cvt: bool,
        sti_shadow: bool,
        counting: bool,
        jac_entries: u32,
        loops: bool,
        xmm_locals: bool,
        sse_fast_check: bool,
        i32_ops: bool,
        fast_lookup: bool,
        fast_chain: bool,
        exit_flags: bool,
        compat: bool,
        compat_tlb: bool,
        legacy: bool,
        segmented: bool,
        prot16: Option<(i32, Mode16)>,
        stack16: bool,
        span_hosts: &[u32],
    ) -> CompileEnv {
        let mut hosts = [0; MAX_SPAN];
        hosts[..span_hosts.len()].copy_from_slice(span_hosts);
        CompileEnv {
            bucket_dispatch,
            block_count,
            outline,
            chaining,
            relaxed_fma,
            cvt,
            sti_shadow,
            jac_entries,
            loops,
            xmm_locals,
            sse_fast_check,
            i32_ops,
            fast_lookup,
            fast_chain,
            exit_flags,
            compat,
            compat_tlb,
            legacy,
            segmented,
            prot16: prot16.is_some(),
            ip_base: prot16.map_or(0, |p| p.0),
            mode16: prot16.map_or(Mode16::Protected, |p| p.1),
            stack16,
            span: span_hosts.len().max(1) as u8,
            span_hosts: hosts,
            volatile: [u16::MAX; MAX_VOLATILE],
            counter: counting.then_some(0x0000_0E80),
            sse_fp_operands: 0x0000_0E00,
            core_yield: 0x0000_0D00,
            pending: [0x0000_0D10, 0x0000_0D14, 0x0000_0D18, 0x0000_0D1C],
            bounce: 0x0000_0C00,
        }
    }
}

/// Compile a page of long-mode code (the bytes of its RAM backing page) for
/// the block starts `entries` (with `compat`, of 32-bit compatibility-mode
/// code: CompileEnv::compat). The function is position independent: it runs
/// wherever the page is mapped (gp::x64_page_linear), so every mapping of the
/// same backing page shares it. Addresses below are relative to the page.
/// `chaining`: leaving the page, tail-call the function serving the new page
/// when the chaining table (pages::CHAIN) has it. `next`: the first bytes of
/// the next linear page where it was compiled, for instructions that
/// straddle into it (empty: those are stepped).
pub fn compile(
    bytes: &[u8],
    next: &[u8],
    entries: &[u16],
    chaining: bool,
    outline: bool,
    counter: Option<u32>,
    compat: bool,
    legacy: bool,
    segmented: bool,
    prot16: Option<(i32, Mode16)>,
    stack16: bool,
    span_hosts: &[u32],
    volatile: &[u16],
    name: String,
) -> Option<Compiled> {
    let mut env = CompileEnv::current(
        chaining, outline, counter, compat, legacy, segmented, prot16, stack16, span_hosts,
    );
    env.volatile[..volatile.len()].copy_from_slice(volatile);
    #[cfg(feature = "ir-test-hooks")]
    super::replay::record(&env, bytes, next, entries, &name);
    let compiled = compile_with(&env, bytes, next, entries, name);
    #[cfg(feature = "ir-test-hooks")]
    super::replay::record_output(compiled.as_ref().map_or(&[][..], |c| &c.bytes[..]));
    compiled
}

/// Discover the block starts of the code at `entries` (offsets in the
/// decoder's span; GUESSED ones once the others' code is decoded), and
/// whether MAX_INSTRUCTIONS cut it short
fn discover(decoder: &mut Decoder, entries: &[u16]) -> (BTreeSet<u16>, bool) {
    let span = decoder.span_bytes;
    // Discover block starts: entries, in-page branch targets, return
    // addresses, and the instruction after every step (steps continue by
    // dispatch). Each REP string instruction starts its own block so a
    // step that repeats it dispatches back to it.
    let mut starts = BTreeSet::new();
    let mut work: Vec<u16> = Vec::new();
    for &e in entries {
        if (e as usize) < span && starts.insert(e) {
            work.push(e);
        }
    }
    // (the guesses join once the entries' code is decoded: GUESSED)
    let mut guesses = entries
        .iter()
        .filter(|&&e| e & GUESSED != 0)
        .map(|&e| e & !GUESSED);
    // (the offsets decoded code runs into straight-line)
    let mut runs_into = vec![0u64; span / 64];
    let mut decoded = 0;
    loop {
        while let Some(start) = work.pop() {
            let add = |o: u64, starts: &mut BTreeSet<u16>, work: &mut Vec<u16>| {
                if o < span as u64 && starts.insert(o as u16) {
                    work.push(o as u16);
                }
            };
            let mut o = start;
            loop {
                if o != start && starts.contains(&o) {
                    break;
                }
                decoded += 1;
                if decoded > MAX_INSTRUCTIONS {
                    // Long runs (padding, data): the rest stays interpreted.
                    break;
                }
                let Some((d, op)) = decoder.at(o)
                else {
                    break;
                };
                let next = o as u64 + d.length as u64;
                match op {
                    Op::Jcc { target, .. } | Op::LoopJump { target, .. } => {
                        if let Some(t) = in_page(span as u64, target) {
                            add(t as u64, &mut starts, &mut work);
                        }
                        add(next, &mut starts, &mut work);
                        break;
                    },
                    Op::Jmp { target } | Op::Call { target } => {
                        if let Some(t) = in_page(span as u64, target) {
                            add(t as u64, &mut starts, &mut work);
                        }
                        if matches!(op, Op::Call { .. }) {
                            add(next, &mut starts, &mut work);
                        }
                        break;
                    },
                    Op::CallIndirect { .. } => {
                        add(next, &mut starts, &mut work);
                        break;
                    },
                    Op::Ret { .. } | Op::JmpIndirect { .. } => break,
                    Op::Sti => {
                        if next < span as u64 {
                            if let Some((shadow, _)) = decoder.at(next as u16) {
                                add(next + shadow.length as u64, &mut starts, &mut work);
                            }
                        }
                        break;
                    },
                    Op::Movs { rep: true, .. }
                    | Op::Stos { rep: true, .. }
                    | Op::RepCompare { .. }
                        if o != start =>
                    {
                        add(o as u64, &mut starts, &mut work);
                        break;
                    },
                    Op::Step => {
                        if is_rep_string(&d) && o != start {
                            add(o as u64, &mut starts, &mut work);
                            break;
                        }
                        add(next, &mut starts, &mut work);
                        break;
                    },
                    // (a far call's return comes back here)
                    Op::FarCall { .. } => {
                        add(next, &mut starts, &mut work);
                        break;
                    },
                    Op::FarRet { .. } => break,
                    _ => {},
                }
                if next >= span as u64 {
                    break;
                }
                // (P7.3b: each page of a span starts a block, where control
                // passes between pages)
                if next as usize / PAGE != o as usize / PAGE {
                    add(next, &mut starts, &mut work);
                    break;
                }
                o = next as u16;
                runs_into[o as usize / 64] |= 1 << (o % 64);
            }
        }
        for g in guesses.by_ref() {
            if (g as usize) < span
                && runs_into[g as usize / 64] >> (g % 64) & 1 == 0
                && starts.insert(g)
            {
                work.push(g);
            }
        }
        if work.is_empty() {
            break;
        }
    }
    (starts, decoded > MAX_INSTRUCTIONS)
}

/// compile in `env`
pub fn compile_with(
    env: &CompileEnv,
    bytes: &[u8],
    next: &[u8],
    entries: &[u16],
    name: String,
) -> Option<Compiled> {
    let page = 0;
    // (P7.3b: the bytes of each page of the span, one after the other)
    let span = PAGE * env.span as usize;
    if bytes.len() != span || entries.is_empty() {
        return None;
    }
    let mut decoder = Decoder {
        bytes,
        next,
        page,
        cache: HashMap::default(),
        cvt: env.cvt,
        sse_fast_check: env.sse_fast_check,
        mode: if env.prot16 {
            match env.mode16 {
                Mode16::Protected => ExecutionMode::Protected16,
                Mode16::Real => ExecutionMode::Real,
                Mode16::V86 => ExecutionMode::Vm86,
            }
        }
        else if env.compat {
            ExecutionMode::Compatibility32
        }
        else {
            ExecutionMode::Long64
        },
        legacy: env.legacy,
        segmented: env.segmented,
        stack16: env.stack16,
        ip_base: env.prot16.then_some(env.ip_base),
        span_bytes: PAGE * env.span as usize,
        volatile: env.volatile,
    };
    let (starts, truncated) = discover(&mut decoder, entries);
    // (a span whose code does not fit: pages::compile_mode compiles its
    // page alone, P7.3b)
    if truncated && span > PAGE {
        return None;
    }
    // Blocks, in page order: from each start to its first control transfer,
    // step, or the next start.
    let mut blocks: Vec<Block> = Vec::new();
    let mut total = 0;
    for &start in &starts {
        let mut insts = Vec::new();
        let mut o = start;
        // (the instruction at o is in STI's shadow: Op::StiShadowed)
        let mut after_sti = false;
        let end = loop {
            if o as usize >= span {
                // (past the page end after a straddling instruction)
                break End::Next(o);
            }
            if o != start && starts.contains(&o) && !after_sti {
                break End::Next(o);
            }
            if total >= MAX_INSTRUCTIONS {
                break End::Retry(o);
            }
            total += 1;
            let Some((d, op)) = decoder.at(o)
            else {
                break End::StepAt(o);
            };
            let next = o + d.length as u16;
            let (reads, writes) = effects(&op, env.compat);
            let liveness = if matches!(op, Op::Step) { 0 } else { reads };
            let locked = cfg!(feature = "parallel") && locked_rmw(&d, &op);
            let op = if locked && !lockable(&op) { Op::Step } else { op };
            let straddle = (next as usize > span).then(|| {
                let count = next as usize - span;
                let word = (0..count).fold(0u64, |w, i| w | (decoder.next[i] as u64) << (8 * i));
                (word, count as u8)
            });
            insts.push(Inst {
                d,
                op,
                flags_read: reads,
                reads: liveness,
                writes,
                live_out: ARITH,
                exit_live: ARITH,
                fused: None,
                keep: false,
                straddle,
                span_straddle: o as usize / PAGE != (next as usize - 1) / PAGE
                    && (next as usize) <= span,
                locked: locked && !matches!(op, Op::Step),
                dynamic: match (env.volatile.contains(&o), op, d.immediate) {
                    (true, Op::Step, _) | (false, ..) | (_, _, None) => None,
                    (true, _, Some(i)) => Some((
                        next - i.encoded_bytes as u16,
                        i.encoded_bytes,
                        i.sign_extended,
                    )),
                },
            });
            if after_sti {
                break End::Shadow(next);
            }
            match op {
                Op::Jcc { .. } | Op::LoopJump { .. } | Op::Step => break End::Next(next),
                Op::Sti
                    if env.sti_shadow
                        && total + 1 < MAX_INSTRUCTIONS
                        && shadowed(&mut decoder, next, &starts) =>
                {
                    insts.last_mut().unwrap().op = Op::StiShadowed;
                    after_sti = true;
                },
                Op::Jmp { .. }
                | Op::Call { .. }
                | Op::CallIndirect { .. }
                | Op::Ret { .. }
                | Op::JmpIndirect { .. }
                | Op::FarCall { .. }
                | Op::FarRet { .. }
                | Op::Sti => break End::Stop,
                _ => {},
            }
            o = next;
        };
        // After a truncated discovery a fall-through may not be a start.
        let end = match end {
            End::Next(o) if (o as usize) < span && !starts.contains(&o) => End::Retry(o),
            end => end,
        };
        blocks.push(Block {
            start,
            insts,
            end,
            live_in: ARITH,
        });
    }
    let index: BTreeMap<u16, usize> = blocks
        .iter()
        .enumerate()
        .map(|(i, b)| (b.start, i))
        .collect();
    // Fusion (per block, forward): a condition consumer reads the operands
    // of the last flags producer when no other flags writer intervenes.
    for block in &mut blocks {
        let mut known: Option<(usize, Known)> = None;
        for i in 0..block.insts.len() {
            let op = block.insts[i].op;
            let cc = match op {
                Op::Jcc { cc, .. } | Op::Cmov { cc, .. } | Op::Setcc { cc, .. } => Some(cc),
                _ => None,
            };
            if let (Some(cc), Some((p, k))) = (cc, known) {
                if fusable(k, cc) {
                    block.insts[i].fused = Some(k);
                    block.insts[i].reads = 0;
                    block.insts[i].flags_read = 0;
                    block.insts[p].keep = true;
                }
            }
            if block.insts[i].writes != 0 {
                known = producer(&op).map(|k| (i, k));
            }
        }
    }
    // EFLAGS liveness to a fixpoint (backward over the page's blocks).
    let successors = |blocks: &Vec<Block>, b: usize| -> u32 {
        let block = &blocks[b];
        // Only a performance estimate: anything reading a flag the lazy
        // record still holds materializes it (exits, steps, other code).
        let live = |o: u16| if (o as usize) < span { blocks[index[&o]].live_in } else { 0 };
        let target = |t: u64| {
            in_page(span as u64, t)
                .and_then(|o| index.get(&o))
                .map_or(0, |&i| blocks[i].live_in)
        };
        let last = block.insts.last().map(|i| i.op);
        match (block.end, last) {
            (End::Retry(_) | End::StepAt(_), _) => 0,
            (End::Next(_), Some(Op::Step)) => 0,
            (End::Next(o), Some(Op::Jcc { target: t, .. }))
            | (End::Next(o), Some(Op::LoopJump { target: t, .. })) => live(o) | target(t),
            (End::Next(o), _) | (End::Shadow(o), _) => live(o),
            (End::Stop, Some(Op::Jmp { target: t }))
            | (End::Stop, Some(Op::Call { target: t })) => target(t),
            (End::Stop, _) => 0,
        }
    };
    loop {
        let mut changed = false;
        for b in (0..blocks.len()).rev() {
            let mut live = successors(&blocks, b);
            let block = &mut blocks[b];
            for inst in block.insts.iter_mut().rev() {
                inst.live_out = live;
                live = inst.reads | (live & !inst.writes);
            }
            if live != block.live_in {
                block.live_in = live;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    // (P4.23) what ways out of the function may observe, backward over each
    // block: its end may leave, as may any instruction may_leave admits
    for block in blocks.iter_mut() {
        let mut live = ARITH;
        for inst in block.insts.iter_mut().rev() {
            inst.exit_live = live;
            live = if may_leave(inst) { ARITH } else { live & !inst.writes };
        }
    }
    let mut served = vec![0u64; span / 64];
    for &s in &starts {
        served[s as usize / 64] |= 1 << (s % 64);
    }
    // (an instruction's bytes past the span are checked where it runs:
    // Inst::straddle)
    // A volatile instruction's immediate (or, stepped, all of it) is none:
    // CompileEnv::volatile.
    let mut code = vec![0u64; span / 64];
    let mut instruction_starts = vec![0u64; span / 64];
    let mut dynamic = vec![0u64; span / 64];
    for block in &blocks {
        let mut o = block.start as usize;
        for inst in &block.insts {
            instruction_starts[o / 64] |= 1 << (o % 64);
            let (from, to) = match inst.dynamic {
                Some((at, bytes, _)) => (at as usize, at as usize + bytes as usize),
                None if env.volatile.contains(&(o as u16)) => (o, o + inst.d.length as usize),
                None => (o, o),
            };
            for b in o..(o + inst.d.length as usize).min(span) {
                if !(from..to).contains(&b) {
                    code[b / 64] |= 1 << (b % 64);
                }
                else {
                    dynamic[b / 64] |= 1 << (b % 64);
                }
            }
            o += inst.d.length as usize;
        }
    }
    let instructions = blocks.iter().map(|b| b.insts.len()).sum();
    let templated = blocks
        .iter()
        .flat_map(|b| &b.insts)
        .filter(|i| !matches!(i.op, Op::Step))
        .count();
    let bytes = Emitter::emit(&blocks, &index, env, name);
    Some(Compiled {
        bytes,
        served,
        code,
        starts: instruction_starts,
        dynamic,
        instructions,
        templated,
        blocks: blocks.len(),
    })
}

// i64 locals (0..16 are the GPRs)
const RIP: usize = 16;
const EP: usize = 17;
const FA: usize = 18;
const FB: usize = 19;
const FR: usize = 20;
const TA: usize = 21;
const TB: usize = 22;
const TR: usize = 23;
const TV: usize = 24;
const ADDR: usize = 25;
const TAG: usize = 26;
const TC: usize = 27;
/// scratch of flag and condition computations only
const TX: usize = 28;
/// linear address of the page
const BASE: usize = 29;
/// results of the two halves of an SSE floating point operation (vfp)
const FP0: usize = 30;
const FP1: usize = 31;
/// the value a locked instruction read (read_dst), for its compare-exchange
const OLD: usize = 32;
/// a value being stored (store: cores in workers)
const SV: usize = 33;
const LOCALS64: usize = 34;
// i32 locals
const FL: usize = 0;
const N: usize = 1;
const K: usize = 2;
const JAC: usize = 3;
const ENT: usize = 4;
const OFF: usize = 5;
const HOST: usize = 6;
const HH: usize = 7;
const ST: usize = 8;
const COND: usize = 9;
/// Lazy flags record: kind << 16 | pending EFLAGS bits (operands in FA/FB).
const FK: usize = 10;
/// ADC/SBB carry input
const CI: usize = 11;
/// REP MOVS source host address (host() clobbers HH)
const SRC: usize = 12;
/// an SSE arithmetic lane was inexact (vfp)
const INX: usize = 13;
/// the host address of a store (store, load_any: cores in workers)
const SH: usize = 14;
const LOCALS32: usize = 15;
const RAX: Reg = Reg {
    index: 0,
    high: false,
};
const RDX: Reg = Reg {
    index: 2,
    high: false,
};
const AH: Reg = Reg {
    index: 0,
    high: true,
};

#[derive(Clone, Copy)]
struct Frame {
    exit: Label,
    /// RIP left the page (normal exit): chain or return
    leave: Label,
    retry: Label,
    step: Label,
    dispatch: Label,
}
/// One level of a page function's structured layout (P4.16): the page's
/// units, or a loop's (each a block or a loop, in address order)
struct Level {
    /// re-enters the level: its loop's head (the page level: Frame::dispatch)
    repeat: Label,
    /// per block: its unit at this level, or u32::MAX
    unit_of: Vec<u32>,
    /// per unit: its label (the unit's code follows the label's end)
    labels: Vec<Label>,
    /// per unit: Some(block) for a single block
    single: Vec<Option<u32>>,
    /// the unit being emitted (those before it: emitted)
    current: usize,
    /// a loop of its header alone, whose head does not dispatch on RIP
    /// (Emitter::loop_unit): what continues at RIP goes further out
    /// (Emitter::dispatch)
    direct: bool,
}
struct Emitter {
    b: WasmBuilder,
    v: Vec<WasmLocalI64>,
    w: Vec<WasmLocal>,
    budget: WasmLocal,
    frame: Option<Frame>,
    /// the structured layout's levels (P4.16): the page level (its loop is
    /// Frame::dispatch), then each loop being emitted
    levels: Vec<Level>,
    /// XMM registers in v128 locals (CompileEnv::xmm_locals): the locals,
    /// the registers held in them, those written since they were loaded
    xmm_locals: [Option<WasmLocalV128>; 16],
    xmm_held: u16,
    xmm_dirty: u16,
    /// the registers worth holding for the instruction being emitted: used
    /// twice or more in its stretch of the block (between instructions that
    /// read them from memory)
    xmm_worth: u16,
    /// native_fp::mxcsr_refused's i32 once the block computed it, and the
    /// vector checks it passed (VECTOR_SSE, VECTOR_VEX): P4.18
    fp_mxcsr: Option<WasmLocal>,
    vector_checked: u8,
    /// per XMM register, the lanes known to be neither NaN nor denormal
    /// (x86tpl::vec::clean_bits; P4.18, as Tier-0's xmm_clean): from where
    /// the block learns them to the register's next write
    xmm_clean: [u8; 16],
    /// x64_fast_lookup (P4.21): per base register, kind and displacement
    /// page (Kept), the translation of an operand `[r + displacement]` (or a
    /// stack operation, r = RSP) the function's inline lookups found last,
    /// valid for the function's run (see host_fast; made when first used,
    /// MAX_KEPT at most). The base register of the operand being looked up,
    /// if it has no index, and its displacement's page (kept_page).
    lookup_kept: Vec<Kept>,
    lookup_base: Option<(u8, i64)>,
    /// The start of the instruction being emitted (a segment's null check
    /// retries it, P7.2(3))
    inst_start: u64,
    /// A span's pages verified at entry, a bit each (P7.3b, span_entry),
    /// and the page of the block being emitted
    verified: Option<WasmLocal>,
    current_page: u16,
    /// (compatibility mode: the kept translations the current block has
    /// set, host_tlb)
    kept_set: u64,
    /// the YMM registers whose bits 255:128 the block zeroed and nothing
    /// wrote since (ymm_zero once per block, as Tier-0's)
    ymm_zeroed: u16,
    /// the module's access-cache lookup function (see access_function)
    access: Option<u32>,
    /// the compare-exchange loop of a locked instruction (read_dst)
    lock_loop: Option<Label>,
    /// compatibility and legacy mode (P7.2, M8): the 32-bit interpreter's
    /// last_op1, which its ADD, ADC, SUB, SBB, CMP, INC and DEC (NEG, XADD,
    /// CMPXCHG, CMPS and SCAS through them) set to their first operand, and
    /// from which a later MUL's AF follows (cpu::misc_instr::getaf): it
    /// stays in the CPU state, written where the operations set it and read
    /// where flags take it, as Tier-0 keeps it (no register for it across
    /// loops and dispatch; M9 for compatibility mode, which kept it in a
    /// local)
    last_op1_memory: bool,
    /// legacy mode (P7.3): which vector_checked kinds may run natively, from
    /// CR0, CR4 and XCR0 at entry and after each step (reload: a stepped
    /// CLTS, MOV CR or XSETBV may change them), for the checks once a block
    vector_ok: Option<WasmLocal>,
    /// compatibility mode's x87 forms (P7.2a): their operand words (low,
    /// high), made when first used
    x87_words: Option<(WasmLocal, WasmLocal)>,
    /// and TOP, the tags and the shadow cache's VALID/DIRTY masks in
    /// function-wide locals while the runtime flag x87_is_open is set (then
    /// the CPU state is behind), as Tier-0's x87_open/x87_close: opened by
    /// an x87 form, kept open across the function's blocks and loops,
    /// closed before the helpers that read or change the x87 state and at
    /// every way out of the function (exit, chain, step)
    x87_cache: Option<X87Cache>,
    x87_is_open: Option<WasmLocal>,
    /// the emitted code has opened the x87 cache on every path to here
    x87_known_open: bool,
    /// CompileEnv::compat_tlb: the 32-bit TLB's address and the access
    /// masks of the activation's CPL (read, write), set by the prologue
    tlb: Option<[WasmLocal; 3]>,
    /// what else the bytes depend on
    env: CompileEnv,
}

/// The operand words of an x87 form inlined by x86tpl::x87, and the
/// block's x87 cache (P7.2a)
struct X87Operands<'a> {
    b: &'a mut WasmBuilder,
    words: [&'a WasmLocal; 2],
    cache: Option<X87Cache>,
}
impl X87Words for X87Operands<'_> {
    fn w(&mut self) -> &mut WasmBuilder { self.b }
    fn input(&mut self, k: usize) { self.b.get_local(self.words[k]) }
    fn output(&mut self, k: usize) { self.b.set_local(self.words[k]) }
    fn cache(&mut self) -> Option<X87Cache> { self.cache.as_ref().map(X87Cache::unsafe_clone) }
}
/// Emitter::vector_checked: the legacy SSE check passed, the VEX one passed
const VECTOR_SSE: u8 = 1;
const VECTOR_VEX: u8 = 2;
/// (and the x87 one: CR0.EM and TS clear, P7.2a)
const VECTOR_X87: u8 = 4;
/// Dispatch through a table of 16-byte buckets and compares instead of a
/// page-sized table (x64_page_set_bucket_dispatch).
static mut BUCKET_DISPATCH: bool = true;
const DISPATCH_SHIFT: u32 = 4;
/// Compatibility mode's page dispatch: one table over the block starts'
/// span up to this many bytes (else buckets)
const SPAN_TABLE: usize = 1024;
#[no_mangle]
pub fn x64_page_set_bucket_dispatch(enabled: bool) { unsafe { BUCKET_DISPATCH = enabled } }
/// Native instructions are counted once per block at its entry instead of
/// after each instruction (smaller code; N is then an upper bound when a
/// block is left early). x64_page_set_block_count.
static mut BLOCK_COUNT: bool = true;
#[no_mangle]
pub fn x64_page_set_block_count(enabled: bool) { unsafe { BLOCK_COUNT = enabled } }
/// Memory accesses call one small lookup function per module instead of
/// inlining the access cache lookup at each (page functions shrink by a
/// third; engines compile them that much faster). x64_page_set_outline:
/// cold compiles; hot pages are compiled inline with x64_hot_inline (P4.14).
static mut OUTLINE_ACCESS: bool = true;
#[no_mangle]
pub fn x64_page_set_outline(enabled: bool) { unsafe { OUTLINE_ACCESS = enabled } }
pub fn outline_access() -> bool { unsafe { OUTLINE_ACCESS } }
/// The values of the three switches above (crate::jit_switches)
/// The packed conversions (Op::Vcvt) as x86tpl::ops templates, else steps
/// (docs/jit-unification-plan.md P2.5, on since P2.8). x64_page_set_cvt.
static mut CVT: bool = true;
#[no_mangle]
pub fn x64_page_set_cvt(enabled: bool) { unsafe { CVT = enabled } }
/// STI and the instruction in its shadow compiled together, then a check
/// for a deliverable interrupt (docs/jit-unification-plan.md P4.5d, on since
/// its F gate), else STI leaves the function. x64_page_set_sti_shadow.
static mut STI_SHADOW: bool = true;
#[no_mangle]
pub fn x64_page_set_sti_shadow(enabled: bool) { unsafe { STI_SHADOW = enabled } }
/// Loops of a page function's block graph as Wasm loops whose back edges
/// skip the page dispatch (docs/jit-unification-plan.md P4.16): 1 in every
/// compile, 2 (the default since M5) only with inline lookups (hot
/// recompiles, x64_hot_inline; loops cost TurboFan an eighth more time,
/// which cold code that V8 seldom optimizes need not pay).
/// x64_page_set_loops sets 0 or 1.
static mut LOOPS: u32 = 2;
#[no_mangle]
pub fn x64_page_set_loops(enabled: bool) { unsafe { LOOPS = enabled as u32 } }
pub fn set_loops(mode: u32) -> bool {
    mode <= 2 && {
        unsafe { LOOPS = mode };
        true
    }
}
/// XMM registers in v128 locals within a block: loaded at the first
/// instruction that uses them, written back before anything that leaves the
/// block or reads them from memory (docs/jit-unification-plan.md P4.17).
/// x64_page_set_xmm_locals.
static mut XMM_LOCALS: bool = true;
#[no_mangle]
pub fn x64_page_set_xmm_locals(enabled: bool) { unsafe { XMM_LOCALS = enabled } }
/// SSE arithmetic (Op::Vfp, with SQRT, MIN, MAX, RSQRT and RCP) through
/// x86tpl::ops::float: the exactness check only while MXCSR.PE is clear,
/// v128 masks, refused instructions exact in place (ir_t0_sse_fp, also for
/// CMPPS and kin), MXCSR's condition and the SSE check once per block
/// (docs/jit-unification-plan.md P4.18). x64_page_set_sse_fast_check.
static mut SSE_FAST_CHECK: bool = true;
#[no_mangle]
pub fn x64_page_set_sse_fast_check(enabled: bool) { unsafe { SSE_FAST_CHECK = enabled } }
/// 32-bit integer operations in i32 (docs/jit-unification-plan.md P4.20):
/// a 32-bit register reads as i64.extend_i32_u(i32.wrap_i64), the operation
/// is an i32 one, its result zero-extended. Engines then emit one 32-bit
/// instruction where masks around a 64-bit one cost three more (V8 does not
/// narrow those). x64_page_set_i32_ops.
static mut I32_OPS: bool = true;
#[no_mangle]
pub fn x64_page_set_i32_ops(enabled: bool) { unsafe { I32_OPS = enabled } }
/// Inline access cache lookups that compare the tag of the operand's last
/// byte (a page crossing misses, no offset compare) and add the entry's host
/// delta to the address (jac::Entry::delta), as QEMU's softmmu does
/// (docs/jit-unification-plan.md P4.21). x64_page_set_fast_lookup.
static mut FAST_LOOKUP: bool = true;
#[no_mangle]
pub fn x64_page_set_fast_lookup(enabled: bool) { unsafe { FAST_LOOKUP = enabled } }
/// A chaining page function passes the GPRs on in gp::x64_chain_gprs, 64
/// bits each, and tells the function it tail-calls by bit 31 of its budget
/// argument (budgets are below it), which then loads them from there: a
/// third of the stores and loads of the GPRs' split halves
/// (docs/jit-unification-plan.md P4.22). Functions compiled with and
/// without it must not chain to each other: the switch resets the page
/// tier. x64_page_set_fast_chain.
static mut FAST_CHAIN: bool = false;
#[no_mangle]
pub fn x64_page_set_fast_chain(enabled: bool) { unsafe { FAST_CHAIN = enabled } }
/// The budget argument's bit for x64_chain_gprs (FAST_CHAIN)
const CHAINED_GPRS: i32 = 1 << 31;
/// Shifts, rotates and IMUL/MUL compute their EFLAGS (they keep no lazy
/// record) only where something reads them or may observe them: a later
/// instruction before they are written again, or a way out of the function
/// (Inst::exit_live), not every time (docs/jit-unification-plan.md P4.23).
/// x64_page_set_exit_flags.
static mut EXIT_FLAGS: bool = true;
#[no_mangle]
pub fn x64_page_set_exit_flags(enabled: bool) { unsafe { EXIT_FLAGS = enabled } }
/// Compatibility mode's memory operands as Tier-0 reads them: inline in the
/// 32-bit TLB that x64 translations fill in compatibility mode
/// (cpu::fill_ia32e_tlb), not in the access cache
/// (docs/jit-unification-plan.md P7.2). x64_page_set_compat_tlb.
static mut COMPAT_TLB: bool = true;
#[no_mangle]
pub fn x64_page_set_compat_tlb(enabled: bool) { unsafe { COMPAT_TLB = enabled } }
pub fn compat_tlb() -> bool { unsafe { COMPAT_TLB } }

pub fn switch_value(name: &str) -> Option<u32> {
    unsafe {
        Some(match name {
            "x64_cvt" => CVT as u32,
            "x64_sti_shadow" => STI_SHADOW as u32,
            "x64_loops" => LOOPS,
            "x64_xmm_locals" => XMM_LOCALS as u32,
            "x64_sse_fast_check" => SSE_FAST_CHECK as u32,
            "x64_i32_ops" => I32_OPS as u32,
            "x64_fast_lookup" => FAST_LOOKUP as u32,
            "x64_fast_chain" => FAST_CHAIN as u32,
            "x64_exit_flags" => EXIT_FLAGS as u32,
            "x64_compat_tlb" => COMPAT_TLB as u32,
            "x64_bucket_dispatch" => BUCKET_DISPATCH as u32,
            "x64_block_count" => BLOCK_COUNT as u32,
            "x64_outline" => OUTLINE_ACCESS as u32,
            _ => return None,
        })
    }
}

impl Emitter {
    fn emit(
        blocks: &[Block],
        index: &BTreeMap<u16, usize>,
        env: &CompileEnv,
        name: String,
    ) -> Vec<u8> {
        let mut b = WasmBuilder::new();
        b.set_entry_result();
        b.set_function_name(name);
        let budget = b.arg_local_initial_state.unsafe_clone();
        let v = (0..LOCALS64)
            .map(|_| b.declare_zeroed_local_i64())
            .collect();
        let w = (0..LOCALS32).map(|_| b.declare_zeroed_local()).collect();
        let vector_ok = env.compat.then(|| b.declare_zeroed_local());
        let verified = (env.span > 1).then(|| b.declare_zeroed_local());

        let mut e = Emitter {
            b,
            v,
            w,
            budget,
            frame: None,
            levels: Vec::new(),
            xmm_locals: Default::default(),
            xmm_held: 0,
            xmm_dirty: 0,
            xmm_worth: 0,
            fp_mxcsr: None,
            vector_checked: 0,
            xmm_clean: [0; 16],
            lookup_kept: Vec::new(),
            lookup_base: None,
            inst_start: 0,
            verified,
            current_page: 0,
            kept_set: 0,
            ymm_zeroed: 0,
            access: None,
            lock_loop: None,
            last_op1_memory: env.compat,
            vector_ok,
            x87_words: None,
            x87_cache: None,
            x87_is_open: None,
            x87_known_open: false,
            tlb: None,
            env: *env,
        };
        let mark = e.b.body_len();
        e.prologue();
        size_note("[prologue]".into(), e.b.body_len() - mark);
        let exit = e.b.block_void();
        if e.env.span > 1 {
            e.span_entry(exit);
        }
        if e.env.prot16 {
            e.prot16_entry(exit);
        }
        let leave = e.b.block_void();
        let retry = e.b.block_void();
        let dispatch = e.b.loop_void();
        let step = e.b.block_void();
        e.frame = Some(Frame {
            exit,
            leave,
            retry,
            step,
            dispatch,
        });
        // Budget (native instructions and steps), then the page.
        e.head();
        e.g(RIP);
        e.g(BASE);
        e.b.sub_i64();
        e.c64(e.span_bytes());
        e.b.op(op::OP_I64GEU);
        e.b.br_if(leave);
        e.span_check_rip();
        // The structured layout (P4.16): the page level's units, each with
        // its label; a block in a loop dispatches to the loop's
        let units = layout(blocks, index, e.env.loops, e.span_bytes());
        let mut level = Level::of(&units, blocks.len(), dispatch);
        level.labels = units.iter().map(|_| e.b.block_void()).collect();
        level.labels.reverse();
        let label_of = |level: &Level, i: usize| level.labels[level.unit_of[i] as usize];
        let bad = e.b.block_void();
        let mark = e.b.body_len();
        let offset = |e: &mut Emitter| e.rip_offset();
        // (compatibility mode: a table over the span of the block starts
        // when that is small, as Tier-0 dispatches: a loop through a switch
        // or a call's return is no loop of the static layout, P4.16, and
        // each of its rounds dispatches here; compare chains in a bucket
        // mispredict there, P7.2)
        let (low, high) = (
            index.keys().next().copied().unwrap_or(0),
            index.keys().next_back().copied().unwrap_or(0),
        );
        let span_table = e.env.compat && (high - low) as usize <= SPAN_TABLE;
        if span_table {
            offset(&mut e);
            if low != 0 {
                e.c32(low as i32);
                e.b.sub_i32();
            }
            let targets: Vec<Label> = (low..=high)
                .map(|o| index.get(&o).map_or(bad, |&i| label_of(&level, i)))
                .collect();
            e.b.brtable(bad, &mut targets.iter());
        }
        else if e.env.bucket_dispatch {
            // Two levels: a table over 16-byte buckets of the page, then the
            // block starts in the bucket (a page-sized table is most of a
            // small function and slow to compile)
            let mut buckets: BTreeMap<u16, Vec<(u16, usize)>> = BTreeMap::new();
            for (&o, &i) in index {
                buckets.entry(o >> DISPATCH_SHIFT).or_default().push((o, i));
            }
            let order: Vec<u16> = buckets.keys().copied().collect();
            let mut bucket_labels: HashMap<u16, Label> = HashMap::new();
            for &b in order.iter().rev() {
                bucket_labels.insert(b, e.b.block_void());
            }
            offset(&mut e);
            e.ti(OFF);
            e.c32(DISPATCH_SHIFT as i32);
            e.b.shr_u_i32();
            let targets: Vec<Label> = (0..(e.span_bytes() >> DISPATCH_SHIFT) as u16)
                .map(|b| bucket_labels.get(&b).copied().unwrap_or(bad))
                .collect();
            e.b.brtable(bad, &mut targets.iter());
            for b in order {
                e.b.block_end();
                for &(o, i) in &buckets[&b] {
                    e.gi(OFF);
                    e.c32(o as i32);
                    e.b.eq_i32();
                    e.b.br_if(label_of(&level, i));
                }
                e.b.br(bad);
            }
        }
        else {
            offset(&mut e);
            let targets: Vec<Label> = (0..e.span_bytes() as u32)
                .map(|o| index.get(&(o as u16)).map_or(bad, |&i| label_of(&level, i)))
                .collect();
            e.b.brtable(bad, &mut targets.iter());
        }
        size_note("[dispatch br_table]".into(), e.b.body_len() - mark);
        e.b.block_end();
        // Not a block start: step it in place, unless the page is due for a
        // recompile (pages::x64_page_unserved)
        e.g(RIP);
        e.b.call_signature(
            "x64_page_unserved",
            Signature::new(&[WasmType::I64], &[WasmType::I32]),
        );
        e.b.eqz_i32();
        e.b.br_if(step);
        e.set_exit(EXIT_UNKNOWN);
        e.b.br(exit);
        e.levels.push(level);
        if blocks
            .iter()
            .any(|b| b.insts.iter().any(|i| matches!(i.op, Op::X87 { .. })))
        {
            e.x87_cache_locals();
        }
        e.units(&units, blocks, index);
        let mark = e.b.body_len();
        e.b.unreachable();
        e.b.block_end(); // step
        e.step_code();
        e.b.block_end(); // dispatch loop
        e.b.unreachable();
        e.b.block_end(); // retry
        e.set_exit(EXIT_RETRY);
        e.b.br(exit);
        e.b.block_end(); // leave
        e.x87_close();
        if e.env.chaining {
            e.chain();
        }
        e.b.block_end(); // exit
        e.x87_close();
        e.materialize_if(ARITH);
        e.writeback();
        e.gi(N);
        size_note("[step, retry, chain, exit]".into(), e.b.body_len() - mark);
        let Emitter {
            mut b,
            v,
            w,
            budget,
            xmm_locals,
            fp_mxcsr,
            lookup_kept,
            vector_ok,
            x87_words,
            x87_cache,
            x87_is_open,
            tlb,
            verified,
            env,
            ..
        } = e;
        for l in v {
            b.free_local_i64(l);
        }
        for Kept { tag, delta, .. } in lookup_kept {
            match tag {
                KeptTag::Wide(l) => b.free_local_i64(l),
                KeptTag::Narrow(l) => b.free_local(l),
            }
            b.free_local(delta);
        }
        for l in w.into_iter().chain(fp_mxcsr).chain(vector_ok) {
            b.free_local(l);
        }
        if let Some((low, high)) = x87_words {
            b.free_local(low);
            b.free_local(high);
        }
        if let Some(c) = x87_cache {
            for l in [c.top, c.tags, c.valid, c.dirty]
                .into_iter()
                .chain(x87_is_open)
            {
                b.free_local(l);
            }
        }
        for l in xmm_locals.into_iter().flatten() {
            b.free_local_v128(l);
        }
        // (32-bit modes' write mask is their read mask's local: once)
        for (k, l) in tlb.into_iter().flatten().enumerate() {
            if env.compat && k == 2 {
                std::mem::forget(l);
            }
            else {
                b.free_local(l);
            }
        }
        if let Some(l) = verified {
            b.free_local(l);
        }
        std::mem::forget(budget);
        b.finish();
        b.output().to_vec()
    }
    fn f(&self) -> Frame { self.frame.unwrap() }
    /// The bytes the function's offsets cover (CompileEnv::span)
    fn span_bytes(&self) -> u64 { PAGE as u64 * self.env.span as u64 }
    /// Push the i32 offset of RIP in the function's pages (in a span from
    /// BASE, its first page)
    fn rip_offset(&mut self) {
        self.g(RIP);
        if self.env.span > 1 {
            self.g(BASE);
            self.b.sub_i64();
            self.b.wrap_i64_to_i32();
        }
        else {
            self.b.wrap_i64_to_i32();
            self.c32(4095);
            self.b.and_i32();
        }
    }
    /// [i32 linear page] -> the host address of its page (mem8 + physical)
    /// by its 32-bit TLB entry, or 1 when the entry does not grant reading
    /// (execution) at this CPL (P7.3b)
    fn tlb_page_host(&mut self) {
        let [tlb, read, _] = self
            .tlb
            .as_ref()
            .unwrap()
            .each_ref()
            .map(|l| l.unsafe_clone());
        self.si(OFF);
        self.b.get_local(&tlb);
        self.gi(OFF);
        self.c32(2);
        self.b.shl_i32();
        self.b.add_i32();
        self.b.load_aligned_i32(0);
        self.ti(ENT);
        self.c32(!0xFFF);
        self.b.and_i32();
        self.gi(OFF);
        self.c32(12);
        self.b.shl_i32();
        self.b.xor_i32();
        self.c32(1);
        self.gi(ENT);
        self.b.get_local(&read);
        self.b.and_i32();
        self.c32(TLB_VALID);
        self.b.eq_i32();
        self.b.select();
    }
    /// 16-bit code's entry (P7.7): it leaves at once with RIP unchanged
    /// (pages::run interprets an instruction then) unless the page's linear
    /// address less CS's base is CompileEnv::ip_base, which its IPs assume
    fn prot16_entry(&mut self, exit: Label) {
        self.g(BASE);
        self.b.wrap_i64_to_i32();
        self.c32(gp::segment_offsets as i32 + crate::cpu::cpu::CS * 4);
        self.b.load_aligned_i32(0);
        self.b.sub_i32();
        self.c32(self.env.ip_base);
        self.b.ne_i32();
        self.b.if_void();
        self.set_exit(EXIT_UNKNOWN);
        self.b.br(exit);
        self.b.block_end();
    }
    /// A span's entry (P7.3b): its page by the 32-bit TLB entry of the page
    /// entered (gp::x64_page_linear, BASE so far), then BASE its first
    /// page's address and `verified` the pages whose entries map them as
    /// compiled (CompileEnv::span_hosts). An entry page that maps none of
    /// them leaves at once with RIP unchanged (pages::run interprets an
    /// instruction then).
    fn span_entry(&mut self, exit: Label) {
        let hosts = self.env.span_hosts;
        self.g(BASE);
        self.c64(12);
        self.b.shr_u_i64();
        self.b.wrap_i64_to_i32();
        self.tlb_page_host();
        self.si(HH);
        self.c32(-1);
        self.si(ST);
        for j in (0..self.env.span as usize).rev() {
            self.c32(j as i32);
            self.gi(ST);
            self.gi(HH);
            self.c32(hosts[j] as i32);
            self.b.eq_i32();
            self.b.select();
            self.si(ST);
        }
        self.gi(ST);
        self.c32(-1);
        self.b.eq_i32();
        self.b.if_void();
        self.set_exit(EXIT_UNKNOWN);
        self.b.br(exit);
        self.b.block_end();
        self.g(BASE);
        self.gi(ST);
        self.c32(12);
        self.b.shl_i32();
        self.b.extend_unsigned_i32_to_i64();
        self.b.sub_i64();
        self.s(BASE);
        let verified = self.verified.as_ref().unwrap().unsafe_clone();
        self.c32(0);
        self.b.set_local(&verified);
        for m in 0..self.env.span as usize {
            self.g(BASE);
            self.c64(12);
            self.b.shr_u_i64();
            self.b.wrap_i64_to_i32();
            if m != 0 {
                self.c32(m as i32);
                self.b.add_i32();
            }
            self.tlb_page_host();
            self.c32(hosts[m] as i32);
            self.b.eq_i32();
            if m != 0 {
                self.c32(m as i32);
                self.b.shl_i32();
            }
            self.b.get_local(&verified);
            self.b.or_i32();
            self.b.set_local(&verified);
        }
    }
    /// (P7.3b) Before control passes to `target` in page `page` of the
    /// span from another page: leave unless that page was verified
    fn span_check(&mut self, target: u64) {
        let page = (target / PAGE as u64) as u16;
        if self.env.span > 1 && page != self.current_page {
            self.b.get_local(self.verified.as_ref().unwrap());
            self.c32(1 << page);
            self.b.and_i32();
            self.b.eqz_i32();
            self.b.if_void();
            self.leave_to(self.f().exit, target);
            self.b.block_end();
        }
    }
    /// (P7.3b) RIP is in the span: leave unless its page was verified
    fn span_check_rip(&mut self) {
        if self.env.span > 1 {
            self.b.get_local(self.verified.as_ref().unwrap());
            self.rip_offset();
            self.c32(12);
            self.b.shr_u_i32();
            self.b.shr_u_i32();
            self.c32(1);
            self.b.and_i32();
            self.b.eqz_i32();
            self.b.br_if(self.f().exit);
        }
    }
    /// The page dispatch's and each loop head's: the page's execution
    /// counter (CompileEnv::counter), then exit when the budget is spent
    /// (native instructions and steps; with cores in workers, also when
    /// another core kicked this one, e.g. with an IPI: parallel::kick)
    fn head(&mut self) {
        if let Some(counter) = self.env.counter {
            self.c32(counter as i32);
            self.c32(counter as i32);
            self.b.load_aligned_i32(0);
            self.c32(1);
            self.b.add_i32();
            self.b.store_aligned_i32(0);
        }
        self.n_and_steps();
        self.b.get_local(&self.budget);
        self.b.geu_i32();
        if cfg!(feature = "parallel") {
            self.c32(self.env.core_yield as i32);
            self.b.guest_load_u8(0);
            self.b.or_i32();
        }
        self.b.br_if(self.f().exit);
    }
    /// Push N plus the instructions stepped (K; the 32-bit modes count those
    /// in the budget instead, M8, M9)
    fn n_and_steps(&mut self) {
        self.gi(N);
        if !self.env.compat {
            self.gi(K);
            self.b.add_i32();
        }
    }
    fn g(&mut self, i: usize) { self.b.get_local_i64(&self.v[i]); }
    fn s(&mut self, i: usize) { self.b.set_local_i64(&self.v[i]); }
    fn gi(&mut self, i: usize) { self.b.get_local(&self.w[i]); }
    fn si(&mut self, i: usize) { self.b.set_local(&self.w[i]); }
    fn ti(&mut self, i: usize) { self.b.tee_local(&self.w[i]); }
    fn c64(&mut self, v: u64) { self.b.const_i64(v as i64); }
    fn c32(&mut self, v: i32) { self.b.const_i32(v); }

    fn set_exit(&mut self, code: u32) {
        self.c32(gp::x64_page_exit as i32);
        self.c32(code as i32);
        self.b.store_aligned_i32(0);
    }
    fn load_pair(&mut self, low: u32, high: u32) {
        self.c32(low as i32);
        self.b.memory_op(op::OP_I64LOAD32U, op::MEM_ALIGN32, 0);
        self.c32(high as i32);
        self.b.memory_op(op::OP_I64LOAD32U, op::MEM_ALIGN32, 0);
        self.c64(32);
        self.b.shl_i64();
        self.b.or_i64();
    }
    fn store_pair(&mut self, low: u32, high: u32, i: usize) {
        self.c32(low as i32);
        self.g(i);
        self.b.memory_op(op::OP_I64STORE32, op::MEM_ALIGN32, 0);
        self.c32(high as i32);
        self.g(i);
        self.c64(32);
        self.b.shr_u_i64();
        self.b.memory_op(op::OP_I64STORE32, op::MEM_ALIGN32, 0);
    }
    fn reload(&mut self) {
        // (compatibility mode: the eight GPRs' low halves, P7.2; the 32-bit
        // code leaves the high halves as they are)
        for i in 0..if self.env.compat { 8 } else { 16 } {
            if self.env.compat {
                self.c32(gpr_low_offset(i) as i32);
                self.b.memory_op(op::OP_I64LOAD32U, op::MEM_ALIGN32, 0);
            }
            else {
                self.load_pair(gpr_low_offset(i), gpr_high_offset(i));
            }
            self.s(i);
        }
        self.b.load_fixed_i32(gp::flags as u32);
        self.si(FL);
        if self.vector_ok.is_some() {
            // SSE: CR0.EM and TS clear, CR4.OSFXSR set (sse_check)
            self.b.load_fixed_i32(gp::cr as u32);
            self.c32(0xC);
            self.b.and_i32();
            self.b.eqz_i32();
            self.b.load_fixed_i32(gp::cr as u32 + 16);
            self.c32(0x200);
            self.b.and_i32();
            self.c32(0);
            self.b.ne_i32();
            self.b.and_i32();
            // VEX: CR0.TS clear, CR4.OSXSAVE set, XCR0 with SSE and AVX state
            self.b.load_fixed_i32(gp::cr as u32);
            self.c32(crate::cpu::cpu::CR0_TS);
            self.b.and_i32();
            self.b.eqz_i32();
            self.b.load_fixed_i32(gp::cr as u32 + 16);
            self.c32(crate::cpu::cpu::CR4_OSXSAVE);
            self.b.and_i32();
            self.c32(0);
            self.b.ne_i32();
            self.b.and_i32();
            self.b.load_fixed_i32(gp::xcr0 as u32);
            self.c32(6);
            self.b.and_i32();
            self.c32(6);
            self.b.eq_i32();
            self.b.and_i32();
            self.c32(VECTOR_VEX.trailing_zeros() as i32);
            self.b.shl_i32();
            self.b.or_i32();
            // x87: CR0.EM and TS clear (x87_check)
            self.b.load_fixed_i32(gp::cr as u32);
            self.c32(crate::cpu::cpu::CR0_EM | crate::cpu::cpu::CR0_TS);
            self.b.and_i32();
            self.b.eqz_i32();
            self.c32(VECTOR_X87.trailing_zeros() as i32);
            self.b.shl_i32();
            self.b.or_i32();
            self.b.set_local(self.vector_ok.as_ref().unwrap());
        }
    }
    /// Retry unless `kind` (vector_checked) may run, by the local reload
    /// sets (legacy mode)
    fn vector_ok_check(&mut self, kind: u8, start: u64) {
        self.b.get_local(self.vector_ok.as_ref().unwrap());
        self.c32(kind as i32);
        self.b.and_i32();
        self.b.eqz_i32();
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
    }
    /// RIP into its local (in compatibility mode EIP: its high half is 0)
    fn load_rip(&mut self) {
        if self.env.compat {
            self.c32(gp::instruction_pointer as i32);
            self.b.memory_op(op::OP_I64LOAD32U, op::MEM_ALIGN32, 0);
        }
        else {
            self.load_pair(gp::instruction_pointer as u32, gp::x64_rip_hi as u32);
        }
        self.s(RIP);
    }
    fn prologue(&mut self) {
        self.set_exit(EXIT_NORMAL);
        if self.env.fast_chain {
            // (P4.22: the GPRs of a chaining predecessor, see chain)
            self.b.get_local(&self.budget);
            self.c32(CHAINED_GPRS);
            self.b.and_i32();
            self.b.if_void();
            for i in 0..16 {
                self.c32(gp::x64_chain_gprs as i32 + 8 * i as i32);
                self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
                self.s(i);
            }
            self.b.load_fixed_i32(gp::flags as u32);
            self.si(FL);
            self.b.get_local(&self.budget);
            self.c32(!CHAINED_GPRS);
            self.b.and_i32();
            self.b.set_local(&self.budget);
            self.b.else_();
            self.reload();
            self.b.block_end();
        }
        else {
            self.reload();
        }
        self.load_rip();
        if self.env.compat_tlb {
            // (Tier-0's: supervisor code may use supervisor pages; a step
            // that changes CPL leaves, see pages::context)
            let tlb = self.b.declare_zeroed_local();
            self.b.load_fixed_i32(gp::ir_tlb_base as u32);
            self.b.set_local(&tlb);
            // (M8, the 32-bit modes: the write mask is the read mask with
            // TLB_READONLY and TLB_HAS_CODE, ORed where a write looks up:
            // one register less through the function)
            let masks = if self.env.compat {
                let read = self.b.declare_zeroed_local();
                [read.unsafe_clone(), read]
            }
            else {
                [self.b.declare_zeroed_local(), self.b.declare_zeroed_local()]
            };
            let count = if self.env.compat { 1 } else { 2 };
            for (mask, f) in masks
                .iter()
                .zip([tlb_read_mask as fn(bool) -> i32, tlb_write_mask])
                .take(count)
            {
                self.c32(f(true));
                self.c32(f(false));
                self.b.load_fixed_u8(gp::cpl as u32);
                self.c32(3);
                self.b.eq_i32();
                self.b.select();
                self.b.set_local(mask);
            }
            let [read, write] = masks;
            self.tlb = Some([tlb, read, write]);
        }
        self.b.load_fixed_i32(gp::x64_jac_base as u32);
        self.si(JAC);
        // (M8: the 32-bit modes read the epoch where they chain, its only
        // use, and count steps in the budget, not K: two registers less where
        // dispatch tables merge, which V8 otherwise spills around)
        if !self.env.compat {
            self.c32(gp::x64_jac_epoch as i32);
            self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
            self.s(EP);
        }
        self.c32(gp::x64_page_linear as i32);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        self.s(BASE);
        // a chaining predecessor passes its lazy EFLAGS record on (see chain)
        self.b.load_fixed_i32(gp::x64_page_lazy_kind as u32);
        self.si(FK);
        self.c32(gp::x64_page_lazy_a as i32);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        self.s(FA);
        self.c32(gp::x64_page_lazy_b as i32);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        self.s(FB);
    }
    /// Memory becomes authoritative: GPRs, materialized EFLAGS and RIP.
    fn writeback(&mut self) {
        for i in 0..if self.env.compat { 8 } else { 16 } {
            if self.env.compat {
                self.c32(gpr_low_offset(i) as i32);
                self.g(i);
                self.b.memory_op(op::OP_I64STORE32, op::MEM_ALIGN32, 0);
            }
            else {
                self.store_pair(gpr_low_offset(i), gpr_high_offset(i), i);
            }
        }
        self.writeback_except_gprs();
    }
    /// writeback but the GPRs
    fn writeback_except_gprs(&mut self) {
        self.c32(gp::flags as i32);
        self.gi(FL);
        self.b.store_aligned_i32(0);
        self.c32(gp::flags_changed as i32);
        self.c32(0);
        self.b.store_aligned_i32(0);
        if self.env.compat {
            self.c32(gp::instruction_pointer as i32);
            self.g(RIP);
            self.b.memory_op(op::OP_I64STORE32, op::MEM_ALIGN32, 0);
        }
        else {
            self.store_pair(gp::instruction_pointer as u32, gp::x64_rip_hi as u32, RIP);
        }
        self.c32(gp::last_virt_eip as i32);
        self.c32(-1);
        self.b.store_aligned_i32(0);
    }
    /// Shared: interpret the instruction at RIP, then dispatch on the new RIP
    /// unless the step changed the execution context (memory is current).
    /// Far CALL and RETF (M11, Op::FarCall, Op::FarRet): the state to
    /// memory as for a step, EIP the next instruction's and previous_ip this
    /// one's (a fault restarts it), pages::x64_page_far, then through the
    /// chaining table, or leave
    fn far_transfer(
        &mut self,
        op: u32,
        offset: u32,
        selector: u32,
        width: u8,
        start: u64,
        next: u64,
    ) {
        self.xmm_writeback();
        self.x87_close();
        self.materialize_if(ARITH);
        self.linear(next);
        self.s(RIP);
        self.writeback();
        self.c32(gp::previous_ip as i32);
        self.linear(start);
        self.b.wrap_i64_to_i32();
        self.b.store_aligned_i32(0);
        self.c32((op | (width as u32) << 8) as i32);
        self.c32(offset as i32);
        self.c32(selector as i32);
        self.b.call_signature(
            "x64_page_far",
            Signature::new(
                &[WasmType::I32, WasmType::I32, WasmType::I32],
                &[WasmType::I32],
            ),
        );
        self.si(ST);
        // (counted also when it faulted, as the interpreter counts an
        // instruction whose execution faults)
        self.retired();
        self.gi(ST);
        self.b.if_void();
        self.gi(N);
        self.b.return_();
        self.b.block_end();
        self.reload();
        self.c32(0);
        self.si(FK);
        self.load_rip();
        // (it returns: through the table or to pages::run)
        self.chain();
    }
    fn step_code(&mut self) {
        self.x87_close();
        self.materialize_if(ARITH);
        self.writeback();
        if self.env.compat {
            self.b.get_local(&self.budget);
            self.c32(1);
            self.b.sub_i32();
            self.b.set_local(&self.budget);
        }
        else {
            self.gi(K);
            self.c32(1);
            self.b.add_i32();
            self.si(K);
        }
        self.b
            .call_signature("x64_page_step", Signature::new(&[], &[WasmType::I32]));
        self.si(ST);
        self.gi(ST);
        self.b.if_void();
        // (code compiled for segment bases, 16-bit code among it: a far
        // transfer chains, pages::x64_page_step)
        if self.env.chaining && self.env.segmented {
            self.gi(ST);
            self.c32(STEP_CHAIN);
            self.b.eq_i32();
            self.b.if_void();
            self.reload();
            self.c32(0);
            self.si(FK);
            self.load_rip();
            // (it returns: through the table or to pages::run)
            self.chain();
            self.b.block_end();
        }
        self.gi(N);
        self.b.return_();
        self.b.block_end();
        self.reload();
        self.c32(0);
        self.si(FK);
        self.load_rip();
        // (P4.21: the step may have retired access cache entries without a
        // new epoch, a 4 KiB INVLPG among them: the kept translations go)
        for kept in &self.lookup_kept {
            kept.tag.forget(&mut self.b);
        }
        self.b.br(self.f().dispatch);
    }
    /// Count one native instruction, unless blocks count theirs at entry
    /// (BLOCK_COUNT).
    fn retired(&mut self) {
        if self.env.block_count {
            return;
        }
        self.gi(N);
        self.c32(1);
        self.b.add_i32();
        self.si(N);
    }
    /// Push the return address of a call whose next instruction is at
    /// page-relative `offset`: its linear address, or in 16-bit code its IP
    /// (P7.7: CompileEnv::ip_base)
    fn return_address(&mut self, offset: u64) {
        if self.env.prot16 {
            self.c64(((self.env.ip_base as i64).wrapping_add(offset as i64) & 0xFFFF) as u64);
        }
        else {
            self.linear(offset);
        }
    }
    /// In 16-bit code (P7.7), the IP in local `i` (a return address or an
    /// indirect branch target) to its linear address: plus CS's base, which
    /// is the page's linear address less CompileEnv::ip_base
    fn ip_to_linear(&mut self, i: usize) {
        if !self.env.prot16 {
            return;
        }
        self.g(BASE);
        self.c64(self.env.ip_base as i64 as u64);
        self.b.sub_i64();
        self.g(i);
        self.c64(0xFFFF);
        self.b.and_i64();
        self.b.add_i64();
        self.wrap32();
        self.s(i);
    }
    /// Push the linear address of page-relative address `offset` (in
    /// compatibility mode wrapped at 4 GiB, as EIP is).
    fn linear(&mut self, offset: u64) {
        self.g(BASE);
        if offset != 0 {
            self.c64(offset);
            self.b.add_i64();
            // (compatibility mode wraps at 4 GiB: not inside the page,
            // which is below it)
            if self.env.compat && offset >= PAGE as u64 {
                self.c64(0xFFFF_FFFF);
                self.b.and_i64();
            }
        }
    }
    fn leave_to(&mut self, label: Label, offset: u64) {
        self.xmm_writeback();
        self.linear(offset);
        self.s(RIP);
        self.b.br(label);
    }
    /// Continue at `target`: a later block of this function directly, an
    /// earlier one through dispatch (and its budget check), else return.
    fn goto(&mut self, target: u64, index: &BTreeMap<u16, usize>) {
        let Some(o) = in_page(self.span_bytes(), target)
        else {
            return self.leave_to(self.f().leave, target);
        };
        self.span_check(target);
        let Some(&k) = index.get(&o)
        else {
            return self.leave_to(self.f().dispatch, target);
        };
        // The innermost level holding the block: a unit after the one being
        // emitted by its label (a single block directly), else the level's
        // head, which dispatches on RIP (P4.16; the page level: Frame::dispatch)
        for level in self.levels.iter().rev() {
            let u = level.unit_of[k];
            if u == u32::MAX {
                continue;
            }
            let u = u as usize;
            let (single, label, repeat) = (level.single[u], level.labels[u], level.repeat);
            if u <= level.current {
                return self.leave_to(repeat, target);
            }
            if single == Some(k as u32) {
                self.xmm_writeback();
                return self.b.br(label);
            }
            return self.leave_to(label, target);
        }
        self.leave_to(self.f().dispatch, target)
    }
    /// Whether the block at `o` is the next unit of the innermost level, a
    /// single block, whose code follows (no branch needed)
    fn falls_into(&self, o: u16, index: &BTreeMap<u16, usize>) -> bool {
        let level = self.levels.last().unwrap();
        index
            .get(&o)
            .is_some_and(|&k| level.single.get(level.current + 1) == Some(&Some(k as u32)))
    }
    /// The units of a level, after its labels and dispatch: each one's code
    /// after its label's end
    fn units(&mut self, units: &[Unit], blocks: &[Block], index: &BTreeMap<u16, usize>) {
        for (u, unit) in units.iter().enumerate() {
            self.b.block_end();
            self.levels.last_mut().unwrap().current = u;
            match unit {
                Unit::Block(k) => self.block(&blocks[*k as usize], index),
                Unit::Loop { header, units } => self.loop_unit(*header, units, blocks, index),
            }
        }
    }
    /// A loop (P4.16): its head (budget) and a dispatch on RIP over its
    /// members, the header first; an offset it does not hold goes to the page
    /// dispatch. Back edges re-enter the head instead of the page dispatch.
    fn loop_unit(
        &mut self,
        header: u32,
        units: &[Unit],
        blocks: &[Block],
        index: &BTreeMap<u16, usize>,
    ) {
        let repeat = self.b.loop_void();
        self.head();
        let mut level = Level::of(units, blocks.len(), repeat);
        level.labels = units.iter().map(|_| self.b.block_void()).collect();
        level.labels.reverse();
        let mut members = vec![];
        for unit in units {
            unit.blocks(&mut members);
        }
        let start = |k: u32| blocks[k as usize].start;
        let (low, high) = (
            members.iter().map(|&k| start(k)).min().unwrap(),
            members.iter().map(|&k| start(k)).max().unwrap(),
        );
        // (P7.3: a loop of its header alone is entered and repeated at it:
        // no dispatch on RIP each iteration; the 32-bit modes, 706.memory)
        if self.env.compat && members.len() == 1 && units.len() == 1 {
            level.direct = true;
            self.levels.push(level);
            self.units(units, blocks, index);
            self.levels.pop();
            self.b.block_end();
            return;
        }
        self.rip_offset();
        self.ti(OFF);
        self.c32(start(header) as i32);
        self.b.eq_i32();
        self.b.br_if(level.labels[0]);
        let dispatch = self.f().dispatch;
        let table: Vec<Label> = (low..=high)
            .map(|o| match index.get(&o) {
                Some(&k) if level.unit_of[k] != u32::MAX => level.labels[level.unit_of[k] as usize],
                _ => dispatch,
            })
            .collect();
        self.gi(OFF);
        if low != 0 {
            self.c32(low as i32);
            self.b.sub_i32();
        }
        self.b.brtable(dispatch, &mut table.iter());
        self.levels.push(level);
        self.units(units, blocks, index);
        self.levels.pop();
        self.b.block_end();
    }
    /// RIP left the page: with budget left and a chaining entry for the new
    /// linear page (pages::CHAIN, tagged with the access cache epoch), write
    /// the state back and tail-call that page's function, which counts on
    /// from the instructions retired so far (gp::x64_page_chain). Else
    /// return to the dispatch loop.
    fn chain(&mut self) {
        self.n_and_steps();
        self.b.get_local(&self.budget);
        self.b.ltu_i32();
        if cfg!(feature = "parallel") {
            // (cores in workers: not while code publications or invalidations
            // of other cores wait for this one, see parallel::code::poll)
            let [publish, publish_seen, invalidate, invalidate_seen] = self.env.pending;
            for (next, seen) in [(publish, publish_seen), (invalidate, invalidate_seen)] {
                self.c32(next as i32);
                self.b.guest_load_i32(0);
                self.c32(seen as i32);
                self.b.load_aligned_i32(0);
                self.b.eq_i32();
                self.b.and_i32();
            }
            // nor when another core kicked this one
            self.c32(self.env.core_yield as i32);
            self.b.guest_load_u8(0);
            self.b.eqz_i32();
            self.b.and_i32();
        }
        self.b.if_void();
        self.g(RIP);
        self.c64(12);
        self.b.shr_u_i64();
        self.s(TAG);
        self.g(TAG);
        self.b.wrap_i64_to_i32();
        self.c32(super::pages::CHAIN_ENTRIES as i32 - 1);
        self.b.and_i32();
        self.c32(4);
        self.b.shl_i32();
        self.b.load_fixed_i32(gp::x64_code_base as u32);
        self.b.add_i32();
        self.si(ENT);
        self.gi(ENT);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        self.g(TAG);
        if self.env.compat {
            self.c32(gp::x64_jac_epoch as i32);
            self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        }
        else {
            self.g(EP);
        }
        self.b.or_i64();
        self.b.eq_i64();
        self.b.if_void();
        // the state goes to memory, EFLAGS with the lazy record unevaluated:
        // the next function continues with it (its prologue); with
        // x64_fast_chain the GPRs go to x64_chain_gprs (P4.22)
        if self.env.fast_chain {
            for i in 0..16 {
                self.c32(gp::x64_chain_gprs as i32 + 8 * i as i32);
                self.g(i);
                self.b.store_aligned_i64(0);
            }
            self.writeback_except_gprs();
        }
        else {
            self.writeback();
        }
        self.c32(gp::x64_page_lazy_kind as i32);
        self.gi(FK);
        self.b.store_aligned_i32(0);
        self.c32(gp::x64_page_lazy_a as i32);
        self.g(FA);
        self.b.store_aligned_i64(0);
        self.c32(gp::x64_page_lazy_b as i32);
        self.g(FB);
        self.b.store_aligned_i64(0);
        self.c32(gp::x64_page_linear as i32);
        self.g(RIP);
        self.c64(!4095);
        self.b.and_i64();
        self.b.store_aligned_i64(0);
        self.c32(gp::x64_page_chain as i32);
        self.b.load_fixed_i32(gp::x64_page_chain as u32);
        self.gi(N);
        self.b.add_i32();
        self.b.store_aligned_i32(0);
        self.b.get_local(&self.budget);
        self.gi(N);
        self.b.sub_i32();
        if !self.env.compat {
            self.gi(K);
            self.b.sub_i32();
        }
        if self.env.fast_chain {
            self.c32(CHAINED_GPRS);
            self.b.or_i32();
        }
        self.gi(ENT);
        self.b.load_aligned_i32(8);
        self.b.return_call_indirect_fn1();
        self.b.block_end();
        self.b.block_end();
        self.materialize_if(ARITH);
        self.writeback();
        self.gi(N);
        self.b.return_();
    }
    /// Retry the branch at `start` unless its target outside the page is
    /// canonical where the page runs (a noncanonical target is #GP at the
    /// branch).
    fn check_target(&mut self, target: u64, start: u64) {
        // (compatibility mode: every 32-bit EIP is valid in a flat CS)
        if in_page(self.span_bytes(), target).is_none() && !self.env.compat {
            self.linear(target);
            self.s(TX);
            self.check_canonical(TX, start);
        }
    }
    /// Continue at the address in RIP (checked by dispatch). In
    /// compatibility mode inside a loop (P4.16), at the innermost loop's
    /// head, which dispatches on RIP over its members (else the page
    /// dispatch): a switch's jump or a call's return in a loop body takes
    /// one table, not the page's buckets and then the loop's (P7.2)
    fn dispatch(&mut self) {
        self.xmm_writeback();
        if self.env.compat && self.levels.len() > 1 {
            // (out of the page: leave, as the page dispatch does)
            self.g(RIP);
            self.g(BASE);
            self.b.sub_i64();
            self.c64(self.span_bytes());
            self.b.op(op::OP_I64GEU);
            self.b.br_if(self.f().leave);
            self.span_check_rip();
            // (the innermost loop whose head dispatches on RIP, else the page)
            let repeat = self.levels[1..]
                .iter()
                .rev()
                .find(|l| !l.direct)
                .map(|l| l.repeat);
            return self.b.br(repeat.unwrap_or(self.f().dispatch));
        }
        self.b.br(self.f().dispatch);
    }
    fn block(&mut self, block: &Block, index: &BTreeMap<u16, usize>) {
        self.current_page = block.start / PAGE as u16;
        // (every way into a block left the XMM registers in memory; the
        // x87 cache is open on some of them, x87_is_open says which)
        self.xmm_held = 0;
        self.xmm_dirty = 0;
        self.x87_known_open = false;
        // (and what the block learns about MXCSR and the vector checks
        // holds from where it learns it)
        if let Some(local) = self.fp_mxcsr.take() {
            self.b.free_local(local);
        }
        self.vector_checked = 0;
        self.xmm_clean = [0; 16];
        self.kept_set = 0;
        self.ymm_zeroed = 0;
        if self.env.block_count {
            // (a block left early, by a retry or a step, counts the rest of
            // its instructions too: N bounds activations and feeds statistics)
            let native = block
                .insts
                .iter()
                .filter(|i| !matches!(i.op, Op::Step))
                .count();
            if native != 0 {
                self.gi(N);
                self.c32(native as i32);
                self.b.add_i32();
                self.si(N);
            }
        }
        let worth =
            if self.env.xmm_locals { xmm_worth(block, self.env.sse_fast_check) } else { vec![] };
        let mut i = 0;
        while i < block.insts.len() {
            if let Some(run) = self
                .env
                .compat
                .then(|| x87_run_at(&block.insts[i..]))
                .flatten()
            {
                let insts = &block.insts[i..i + run.length];
                self.x87_run(insts, &run, index);
                i += run.length;
                continue;
            }
            self.xmm_worth = worth.get(i).copied().unwrap_or(0);
            self.instruction(&block.insts[i], index);
            i += 1;
        }
        // (the next block, whose code may follow, starts from memory)
        self.xmm_release();
        match block.end {
            End::Stop => {},
            End::Retry(o) => self.leave_to(self.f().retry, o as u64),
            End::StepAt(o) => self.leave_to(self.f().step, o as u64),
            End::Next(o) => {
                if !block.insts.last().is_some_and(|i| matches!(i.op, Op::Step))
                    && !self.falls_into(o, index)
                {
                    self.goto(o as u64, index);
                }
                else if !block.insts.last().is_some_and(|i| matches!(i.op, Op::Step)) {
                    // (into the span's next page, P7.3b)
                    self.span_check(o as u64);
                }
            },
            End::Shadow(o) => {
                // (with IF set and an interrupt deliverable, the dispatcher
                // takes it: pages::x64_page_irq_window)
                self.gi(FL);
                self.b.call_signature(
                    "x64_page_irq_window",
                    Signature::new(&[WasmType::I32], &[WasmType::I32]),
                );
                self.b.if_void();
                self.leave_to(self.f().exit, o as u64);
                self.b.block_end();
                if !self.falls_into(o, index) {
                    self.goto(o as u64, index);
                }
            },
        }
    }

    // Operands ----------------------------------------------------------

    fn get_reg(&mut self, r: Reg, width: u8) {
        self.g(r.index as usize);
        if r.high {
            self.c64(8);
            self.b.shr_u_i64();
            self.c64(0xFF);
            self.b.and_i64();
        }
        else if width == 32 && self.env.i32_ops {
            // (P4.20: what an i32 operation reads for free)
            self.b.wrap_i64_to_i32();
            self.b.extend_unsigned_i32_to_i64();
        }
        else if width < 64 {
            self.c64(mask(width));
            self.b.and_i64();
        }
    }
    /// [i64 a, i64 b] -> the i32 operation `f` on their low halves,
    /// zero-extended (P4.20: one 32-bit instruction on hosts)
    fn op32(&mut self, a: usize, b: Option<usize>, f: impl FnOnce(&mut WasmBuilder)) {
        self.g(a);
        self.b.wrap_i64_to_i32();
        if let Some(b) = b {
            self.g(b);
            self.b.wrap_i64_to_i32();
        }
        f(&mut self.b);
        self.b.extend_unsigned_i32_to_i64();
    }
    /// Write the value on the stack (low `width` bits) with x86-64 register
    /// semantics: 32-bit writes zero-extend, 8/16-bit writes merge.
    fn set_reg(&mut self, r: Reg, width: u8) { self.set_reg_fitting(r, width, false) }
    /// set_reg of a value `fits` in `width` bits already (SETcc's 0 or 1)
    fn set_reg_fitting(&mut self, r: Reg, width: u8, fits: bool) {
        let i = r.index as usize;
        match width {
            64 => self.s(i),
            32 => {
                self.b.wrap_i64_to_i32();
                self.b.extend_unsigned_i32_to_i64();
                self.s(i);
            },
            _ => {
                if !fits {
                    self.c64(mask(width));
                    self.b.and_i64();
                }
                let keep = if r.high {
                    self.c64(8);
                    self.b.shl_i64();
                    !0xFF00u64
                }
                else {
                    !mask(width)
                };
                self.g(i);
                self.c64(keep);
                self.b.and_i64();
                self.b.or_i64();
                self.s(i);
            },
        }
    }
    /// Push the address of a memory operand: the effective address wrapped
    /// to its size, plus the FS/GS base when `segment` (not for LEA).
    fn address(&mut self, a: &AddressExpr, next: u64, segment: bool) {
        self.lookup_base = match (a.base, a.index) {
            (AddressBase::Register(r), None) => Some((r, kept_page(a.displacement))),
            _ => None,
        };
        if self.env.compat {
            // (32-bit addresses in i32, wrapped at 4 GiB for free, as
            // address32; plus a 32-bit FS/GS base)
            // (P7.2(3): ES, SS and DS bases too when compiled for them, CS's
            // is 0; then any but SS may be null: #GP, the interpreter's)
            if segment && self.env.segmented && matches!(a.segment, 0 | 3 | 4 | 5) {
                self.null_check(a.segment);
            }
            self.address32(a, next);
            // (CS's base: 0 in 32-bit code, which runs with a flat CS; 16-bit
            // code's, P7.7, is not)
            if segment
                && (a.segment >= 4 || self.env.segmented && (a.segment != 1 || self.env.prot16))
            {
                self.c32(gp::segment_offsets as i32 + a.segment as i32 * 4);
                self.b.load_aligned_i32(0);
                self.b.add_i32();
            }
            self.b.extend_unsigned_i32_to_i64();
            return;
        }
        let mut have = false;
        let mut displacement = a.displacement;
        match a.base {
            AddressBase::Register(r) => {
                self.g(r as usize);
                have = true;
            },
            AddressBase::NextRip => {
                self.linear((next as i64).wrapping_add(displacement) as u64);
                displacement = 0;
                have = true;
            },
            AddressBase::None => {},
        }
        if let Some(i) = a.index {
            self.g(i as usize);
            if a.scale != 0 {
                self.c64(a.scale as u64);
                self.b.shl_i64();
            }
            if have {
                self.b.add_i64();
            }
            have = true;
        }
        if !have {
            self.c64(displacement as u64);
        }
        else if displacement != 0 {
            self.c64(displacement as u64);
            self.b.add_i64();
        }
        match a.address_size {
            32 => {
                self.b.wrap_i64_to_i32();
                self.b.extend_unsigned_i32_to_i64();
            },
            16 => {
                self.c64(0xFFFF);
                self.b.and_i64();
            },
            _ => {},
        }
        if segment && a.segment >= 4 {
            let s = a.segment as u32;
            if self.env.compat {
                // (a 32-bit base; the linear address wraps at 4 GiB)
                self.c32(gp::segment_offsets as i32 + s as i32 * 4);
                self.b.memory_op(op::OP_I64LOAD32U, op::MEM_ALIGN32, 0);
                self.b.add_i64();
                self.c64(0xFFFF_FFFF);
                self.b.and_i64();
            }
            else {
                self.load_pair(
                    gp::segment_offsets as u32 + s * 4,
                    gp::x64_segment_base_hi as u32 + s * 4,
                );
                self.b.add_i64();
            }
        }
    }
    /// Push the low half of the effective address of `a` (i32; LEA r32 with
    /// x64_i32_ops, P4.20): its low 32 bits depend only on those of the
    /// registers. No segment base (as LEA).
    fn address32(&mut self, a: &AddressExpr, next: u64) {
        let mut have = false;
        let mut displacement = a.displacement;
        match a.base {
            AddressBase::Register(r) => {
                self.g(r as usize);
                self.b.wrap_i64_to_i32();
                have = true;
            },
            AddressBase::NextRip => {
                self.linear((next as i64).wrapping_add(displacement) as u64);
                self.b.wrap_i64_to_i32();
                displacement = 0;
                have = true;
            },
            AddressBase::None => {},
        }
        if let Some(i) = a.index {
            self.g(i as usize);
            self.b.wrap_i64_to_i32();
            if a.scale != 0 {
                self.c32(a.scale as i32);
                self.b.shl_i32();
            }
            if have {
                self.b.add_i32();
            }
            have = true;
        }
        if !have {
            self.c32(displacement as i32);
        }
        else if displacement as i32 != 0 {
            self.c32(displacement as i32);
            self.b.add_i32();
        }
        if a.address_size == 16 {
            self.c32(0xFFFF);
            self.b.and_i32();
        }
    }
    /// Host address (i32) of a `size`-byte access at the linear address in
    /// ADDR: an access cache hit, else x64_page_access, else a retry of the
    /// instruction at `start`.
    fn host(&mut self, size: u32, write: bool, start: u64) {
        self.host_or(size, write, start, self.f().retry)
    }
    /// host(), leaving for `fallback` (retry, or step) when refused.
    /// The module's internal function (addr: i64, kind: i32) -> i32: the
    /// host address for a `kind & 255`-byte access (bit 8: write) at linear
    /// addr from the access cache (x64::jac), else x64_page_access; 0 when
    /// refused. The same lookup host_or otherwise inlines.
    fn access_function(&mut self) -> u32 {
        if let Some(f) = self.access {
            return f;
        }
        use crate::leb::{write_leb_i32, write_leb_u32};
        // (write tables: 2 * entries * 16 bytes on)
        let write_shift = 15 + (self.env.jac_entries / 1024).trailing_zeros() as i32;
        debug_assert!(self.env.jac_entries.is_power_of_two() && jac::ENTRY_BYTES == 16);
        let slow = self.b.import_index(
            "x64_page_access",
            Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
        );
        // locals: tag (i64), entry, offset, host (i32)
        let mut c: Vec<u8> = vec![2, 1, op::TYPE_I64, 3, op::TYPE_I32];
        let i32c = |c: &mut Vec<u8>, v: i32| {
            c.push(op::OP_I32CONST);
            write_leb_i32(c, v);
        };
        // tag = addr >> 12 | epoch bits (local 2)
        c.extend_from_slice(&[op::OP_GETLOCAL, 0, op::OP_I64CONST, 12, op::OP_I64SHRU]);
        i32c(&mut c, gp::x64_jac_epoch as i32);
        c.extend_from_slice(&[op::OP_I64LOAD, 3, 0, op::OP_I64OR, op::OP_TEELOCAL, 2]);
        // entry = table base + (tag & (ENTRIES - 1)) * 16 (+ write tables) (local 3)
        c.push(op::OP_I32WRAPI64);
        i32c(&mut c, self.env.jac_entries as i32 - 1);
        c.push(op::OP_I32AND);
        i32c(&mut c, 4);
        c.push(op::OP_I32SHL);
        i32c(&mut c, gp::x64_jac_base as i32);
        c.extend_from_slice(&[op::OP_I32LOAD, 2, 0, op::OP_I32ADD, op::OP_GETLOCAL, 1]);
        i32c(&mut c, 8);
        c.push(op::OP_I32SHRU);
        i32c(&mut c, 1);
        c.push(op::OP_I32AND);
        i32c(&mut c, write_shift);
        c.extend_from_slice(&[op::OP_I32SHL, op::OP_I32ADD, op::OP_SETLOCAL, 3]);
        // offset in the page (local 4)
        c.extend_from_slice(&[op::OP_GETLOCAL, 0, op::OP_I32WRAPI64]);
        i32c(&mut c, 4095);
        c.extend_from_slice(&[op::OP_I32AND, op::OP_SETLOCAL, 4]);
        // hit: tag matches and the access stays in the page
        c.extend_from_slice(&[
            op::OP_GETLOCAL,
            3,
            op::OP_I64LOAD,
            3,
            0,
            op::OP_GETLOCAL,
            2,
            op::OP_I64EQ,
        ]);
        c.extend_from_slice(&[op::OP_GETLOCAL, 4]);
        i32c(&mut c, 4096);
        c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
        i32c(&mut c, 255);
        c.extend_from_slice(&[op::OP_I32AND, op::OP_I32SUB, op::OP_I32LEU, op::OP_I32AND]);
        c.extend_from_slice(&[op::OP_IF, op::TYPE_I32]);
        c.extend_from_slice(&[
            op::OP_GETLOCAL,
            3,
            op::OP_I32LOAD,
            2,
            8,
            op::OP_GETLOCAL,
            4,
            op::OP_I32ADD,
        ]);
        if WasmBuilder::ATOMIC_GUEST_MEMORY {
            // Cores in workers access guest memory with atomics, which need
            // natural alignment (min(size, 8)). An unaligned read is copied
            // with plain loads, then a fence (x86 orders it before later
            // loads), to an aligned buffer (pages::BOUNCE) the caller reads.
            // An unaligned write host is returned as it is when the caller
            // stores unaligned itself (kind bit 9: host_store), else the
            // slow path refuses it (retried).
            c.extend_from_slice(&[op::OP_TEELOCAL, 5, op::OP_GETLOCAL, 1]);
            i32c(&mut c, 255);
            c.push(op::OP_I32AND);
            i32c(&mut c, 8);
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 255);
            c.push(op::OP_I32AND);
            i32c(&mut c, 8);
            c.extend_from_slice(&[op::OP_I32LTU, op::OP_SELECT]);
            i32c(&mut c, 1);
            c.extend_from_slice(&[op::OP_I32SUB, op::OP_I32AND, op::OP_IF, op::TYPE_I32]);
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 0x100);
            c.extend_from_slice(&[op::OP_I32AND, op::OP_IF, op::TYPE_I32]);
            // (a write whose code handles unaligned hosts, bit 9: store)
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 0x200);
            c.extend_from_slice(&[
                op::OP_I32AND,
                op::OP_IF,
                op::TYPE_I32,
                op::OP_GETLOCAL,
                5,
                op::OP_ELSE,
            ]);
            c.extend_from_slice(&[op::OP_GETLOCAL, 0, op::OP_GETLOCAL, 1, op::OP_CALL]);
            write_leb_u32(&mut c, slow);
            c.push(op::OP_END);
            c.push(op::OP_ELSE);
            let bounce = self.env.bounce as i32;
            // (sizes 2, 4, 8, 16, 32: the first 8 bytes or fewer, then the
            // rest; 32: a VEX.256 load's)
            let copy = |c: &mut Vec<u8>, load: u8, store: u8, align: u8, offset: u32| {
                i32c(c, bounce);
                c.extend_from_slice(&[op::OP_GETLOCAL, 5, load, 0]);
                write_leb_u32(c, offset);
                c.extend_from_slice(&[store, align]);
                write_leb_u32(c, offset);
            };
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 255);
            c.push(op::OP_I32AND);
            i32c(&mut c, 4);
            c.extend_from_slice(&[op::OP_I32LTU, op::OP_IF, op::TYPE_VOID_BLOCK]);
            copy(&mut c, op::OP_I32LOAD16U, op::OP_I32STORE16, 1, 0);
            c.push(op::OP_ELSE);
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 255);
            c.push(op::OP_I32AND);
            i32c(&mut c, 4);
            c.extend_from_slice(&[op::OP_I32EQ, op::OP_IF, op::TYPE_VOID_BLOCK]);
            copy(&mut c, op::OP_I32LOAD, op::OP_I32STORE, 2, 0);
            c.push(op::OP_ELSE);
            copy(&mut c, op::OP_I64LOAD, op::OP_I64STORE, 3, 0);
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 255);
            c.push(op::OP_I32AND);
            i32c(&mut c, 16);
            c.extend_from_slice(&[op::OP_I32GEU, op::OP_IF, op::TYPE_VOID_BLOCK]);
            copy(&mut c, op::OP_I64LOAD, op::OP_I64STORE, 3, 8);
            c.extend_from_slice(&[op::OP_END]);
            c.extend_from_slice(&[op::OP_GETLOCAL, 1]);
            i32c(&mut c, 255);
            c.push(op::OP_I32AND);
            i32c(&mut c, 32);
            c.extend_from_slice(&[op::OP_I32EQ, op::OP_IF, op::TYPE_VOID_BLOCK]);
            copy(&mut c, op::OP_I64LOAD, op::OP_I64STORE, 3, 16);
            copy(&mut c, op::OP_I64LOAD, op::OP_I64STORE, 3, 24);
            c.extend_from_slice(&[op::OP_END, op::OP_END, op::OP_END]);
            c.extend_from_slice(&[0xFE, 0x03, 0x00]); // atomic.fence
            i32c(&mut c, bounce);
            c.extend_from_slice(&[op::OP_END, op::OP_ELSE, op::OP_GETLOCAL, 5, op::OP_END]);
        }
        c.extend_from_slice(&[
            op::OP_ELSE,
            op::OP_GETLOCAL,
            0,
            op::OP_GETLOCAL,
            1,
            op::OP_CALL,
        ]);
        write_leb_u32(&mut c, slow);
        c.extend_from_slice(&[op::OP_END, op::OP_END]);
        let f = self.b.add_internal_function(
            Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
            c,
        );
        self.access = Some(f);
        f
    }
    /// The host address of a store or read-modify-write of `size` bytes at
    /// ADDR (else a retry). With cores in workers it may be unaligned:
    /// store() and load_any() handle that.
    fn host_store(&mut self, size: u32, start: u64) {
        if WasmBuilder::ATOMIC_GUEST_MEMORY && size > 1 {
            self.host_kind((size, false), 0x300, start, self.f().retry)
        }
        else {
            self.host(size, true, start)
        }
    }
    fn host_or(&mut self, size: u32, write: bool, start: u64, fallback: Label) {
        self.host_kind((size, false), (write as u32) << 8, start, fallback)
    }
    /// host_or() of a `size`-byte operand known to be `aligned` to its size
    /// (an inline lookup then compares no page offset) with the lookup's
    /// kind bits (write: 0x100, unaligned write hosts accepted: 0x200;
    /// outlined lookups only)
    fn host_kind(&mut self, (size, aligned): (u32, bool), bits: u32, start: u64, fallback: Label) {
        let write = bits & 0x100 != 0;
        if self.tlb.is_some() {
            return self.host_tlb(size, aligned, write, start, fallback);
        }
        if self.env.outline {
            let f = self.access_function();
            self.g(ADDR);
            self.c32((size | bits) as i32);
            self.b.call_internal(f);
            self.ti(HH);
            self.b.eqz_i32();
            self.b.if_void();
            self.leave_to(fallback, start);
            self.b.block_end();
            self.gi(HH);
            return;
        }
        let table = if write { 2 * self.env.jac_entries * jac::ENTRY_BYTES } else { 0 };
        if self.env.fast_lookup {
            return self.host_fast(size, aligned, table, bits, start, fallback);
        }
        self.g(ADDR);
        self.c64(12);
        self.b.shr_u_i64();
        self.g(EP);
        self.b.or_i64();
        self.s(TAG);
        self.g(TAG);
        self.b.wrap_i64_to_i32();
        self.c32(self.env.jac_entries as i32 - 1);
        self.b.and_i32();
        self.c32(4);
        self.b.shl_i32();
        self.gi(JAC);
        self.b.add_i32();
        self.si(ENT);
        self.g(ADDR);
        self.b.wrap_i64_to_i32();
        self.c32(4095);
        self.b.and_i32();
        self.si(OFF);
        self.gi(ENT);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, table);
        self.g(TAG);
        self.b.eq_i64();
        if !aligned {
            self.gi(OFF);
            self.c32((4096 - size) as i32);
            self.b.leu_i32();
            self.b.and_i32();
        }
        if WasmBuilder::ATOMIC_GUEST_MEMORY && size > 1 && !aligned {
            // atomic accesses (cores in workers) need natural alignment; the
            // slow path refuses unaligned ones (x64_page_access)
            self.gi(OFF);
            self.c32(size.min(8) as i32 - 1);
            self.b.and_i32();
            self.b.eqz_i32();
            self.b.and_i32();
        }
        self.b.hint(true);
        self.b.if_i32();
        self.gi(ENT);
        self.b.load_aligned_i32(table + 8);
        self.gi(OFF);
        self.b.add_i32();
        self.b.else_();
        self.g(ADDR);
        if WasmBuilder::ATOMIC_GUEST_MEMORY {
            // (with cores in workers, inline lookups too: the module's
            // lookup, which takes unaligned accesses that x64_page_access
            // refuses; P4.14)
            let f = self.access_function();
            self.c32((size | bits) as i32);
            self.b.call_internal(f);
        }
        else {
            self.c32(size as i32 | (write as i32) << 8);
            self.b.call_signature(
                "x64_page_access",
                Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
            );
        }
        self.ti(HH);
        self.b.eqz_i32();
        self.b.if_void();
        self.leave_to(fallback, start);
        self.b.block_end();
        self.gi(HH);
        self.b.block_end();
    }
    /// The kept translation of the operand being looked up (lookup_base) of
    /// its kind, made when first used (MAX_KEPT at most)
    fn kept(&mut self, write: bool) -> Option<usize> {
        let (base, page) = self.lookup_base?;
        let key = |k: &Kept| k.base == base && k.write == write && k.page == page;
        if let Some(k) = self.lookup_kept.iter().position(key) {
            return Some(k);
        }
        if self.lookup_kept.len() >= MAX_KEPT {
            return None;
        }
        let tag = if self.tlb.is_some() {
            KeptTag::Narrow(self.b.declare_zeroed_local())
        }
        else {
            KeptTag::Wide(self.b.declare_zeroed_local_i64())
        };
        let delta = self.b.declare_zeroed_local();
        self.lookup_kept.push(Kept {
            base,
            write,
            page,
            tag,
            delta,
        });
        Some(self.lookup_kept.len() - 1)
    }
    /// host_kind in compatibility mode with x64_compat_tlb (P7.2): Tier-0's
    /// lookup (ir::tier0 tlb_miss) in the 32-bit TLB, whose entries x64
    /// translations fill in compatibility mode (cpu::fill_ia32e_tlb, plain
    /// RAM only; every x64 TLB invalidation clears it too, and code pages'
    /// entries carry TLB_HAS_CODE): an entry that grants the access to the
    /// activation's CPL (for a write: writable, no code) for an operand
    /// inside one page gives the host address, (entry & !0xFFF) ^ address;
    /// else x64_page_access, which fills the entry, refuses as for other
    /// lookups (then `fallback`) or serves what the TLB does not hold. With
    /// x64_fast_lookup, an operand `[register + displacement]` first tries
    /// the entry its base register's operands of its kind found last in its
    /// block, as host_fast keeps translations (lookup_kept: the page |
    /// 1 << 20, never 0 as a forgotten one is, and the entry's mask). A
    /// block's first access by its key sets that on every path, so none is
    /// live into a block: kept across the function's loops and dispatch,
    /// they took registers that cost more than the lookups they saved
    /// (702.call, 557.lz)
    fn host_tlb(&mut self, size: u32, aligned: bool, write: bool, start: u64, fallback: Label) {
        let [tlb, read, written] = self
            .tlb
            .as_ref()
            .unwrap()
            .each_ref()
            .map(|l| l.unsafe_clone());
        let kept = if self.env.fast_lookup { self.kept(write) } else { None };
        let split = size > 1 && !aligned;
        self.g(ADDR);
        self.b.wrap_i64_to_i32();
        self.si(OFF);
        let in_page = |e: &mut Self| {
            if split {
                e.gi(OFF);
                e.c32(0xFFF);
                e.b.and_i32();
                e.c32((4096 - size) as i32);
                e.b.leu_i32();
                e.b.and_i32();
                if WasmBuilder::ATOMIC_GUEST_MEMORY {
                    // (atomic accesses need natural alignment: as host_kind)
                    e.gi(OFF);
                    e.c32(size.min(8) as i32 - 1);
                    e.b.and_i32();
                    e.b.eqz_i32();
                    e.b.and_i32();
                }
            }
        };
        let first = kept.is_some_and(|k| self.kept_set >> k & 1 == 0);
        // (the kept tag: the page | 1 << 20)
        let tag = |e: &mut Self| {
            e.gi(OFF);
            e.c32(12);
            e.b.shr_u_i32();
            e.c32(1 << 20);
            e.b.or_i32();
        };
        if let Some(k) = kept {
            self.kept_set |= 1 << k;
        }
        if let Some(k) = kept.filter(|_| !first) {
            tag(self);
            self.b.get_local(self.lookup_kept[k].tag.narrow());
            self.b.eq_i32();
            in_page(self);
            self.b.hint(true);
            self.b.if_i32();
            self.b.get_local(&self.lookup_kept[k].delta);
            self.gi(OFF);
            self.b.xor_i32();
            self.b.else_();
        }
        self.b.get_local(&tlb);
        self.gi(OFF);
        self.c32(12);
        self.b.shr_u_i32();
        self.c32(2);
        self.b.shl_i32();
        self.b.add_i32();
        self.b.load_aligned_i32(0);
        self.ti(ENT);
        if write && self.env.compat {
            self.b.get_local(&read);
            self.c32(tlb_write_mask(true) & !tlb_read_mask(true));
            self.b.or_i32();
        }
        else {
            self.b.get_local(if write { &written } else { &read });
        }
        self.b.and_i32();
        self.c32(TLB_VALID);
        self.b.eq_i32();
        in_page(self);
        self.b.hint(true);
        self.b.if_i32();
        self.gi(ENT);
        self.c32(!0xFFF);
        self.b.and_i32();
        if let Some(k) = kept {
            self.b.tee_local(&self.lookup_kept[k].delta);
            tag(self);
            self.b.set_local(self.lookup_kept[k].tag.narrow());
        }
        self.gi(OFF);
        self.b.xor_i32();
        self.b.else_();
        if let Some(k) = kept.filter(|_| first) {
            // (set, forgotten, on this path too)
            self.lookup_kept[k].tag.forget(&mut self.b);
            self.c32(0);
            self.b.set_local(&self.lookup_kept[k].delta);
        }
        self.g(ADDR);
        if self.env.legacy {
            // (legacy mode's slow path, which translates through the 32-bit
            // paging: P7.3)
            self.c32(size as i32 | (write as i32) << 8);
            self.b.call_signature(
                "x64_page_access32",
                Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
            );
        }
        else if WasmBuilder::ATOMIC_GUEST_MEMORY {
            let f = self.access_function();
            self.c32(size as i32 | (write as i32) << 8);
            self.b.call_internal(f);
        }
        else {
            self.c32(size as i32 | (write as i32) << 8);
            self.b.call_signature(
                "x64_page_access",
                Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
            );
        }
        self.ti(HH);
        self.b.eqz_i32();
        self.b.if_void();
        self.leave_to(fallback, start);
        self.b.block_end();
        // (through two XORs: V8 knows the result of a 32-bit operation is
        // zero-extended, so the fast paths' addresses need no uxtw where
        // they meet this one)
        self.gi(HH);
        self.gi(OFF);
        self.b.xor_i32();
        self.gi(OFF);
        self.b.xor_i32();
        self.b.block_end();
        if kept.is_some() && !first {
            self.b.block_end();
        }
    }
    /// host_kind's inline lookup with x64_fast_lookup (P4.21): the access
    /// cache entry of the operand's first byte is a hit when its tag is
    /// that of the last byte's page (an operand crossing pages misses: the
    /// two pages have different entries), and the host is its delta plus
    /// the address. An operand `[register + displacement]` (a stack
    /// operation's too) first tries the translation of its kind that its
    /// base register's operands found last (lookup_kept, a hit when both
    /// the operand's last byte and its first are in that page; a hit in the
    /// access cache replaces it): those stay valid while the function runs,
    /// as entries retire only between runs, by what leaves the function
    /// (exits) and by what it may run in between: INVLPG (Op::Invlpg) and
    /// steps (step_code), after which it forgets them. (Not indexed
    /// operands: two that alternate between pages, as LZ77's matching loop
    /// reads its input, would miss every time, and a miss costs more than
    /// a hit saves.)
    fn host_fast(
        &mut self,
        size: u32,
        aligned: bool,
        table: u32,
        bits: u32,
        start: u64,
        fallback: Label,
    ) {
        let write = bits & 0x100 != 0;
        let kept = self.kept(write);
        let atomic = WasmBuilder::ATOMIC_GUEST_MEMORY && size > 1 && !aligned;
        // the last byte's tag
        self.g(ADDR);
        if size > 1 && !aligned {
            self.c64(size as u64 - 1);
            self.b.add_i64();
        }
        self.c64(12);
        self.b.shr_u_i64();
        self.g(EP);
        self.b.or_i64();
        self.s(TAG);
        let aligned_check = |e: &mut Self| {
            if atomic {
                // (atomics need natural alignment: see host_kind)
                e.g(ADDR);
                e.b.wrap_i64_to_i32();
                e.c32(size.min(8) as i32 - 1);
                e.b.and_i32();
                e.b.eqz_i32();
                e.b.and_i32();
            }
        };
        if let Some(k) = kept {
            self.g(TAG);
            self.b.get_local_i64(self.lookup_kept[k].tag.wide());
            self.b.eq_i64();
            if size > 1 && !aligned {
                // (and the first byte in that page too: unlike an access
                // cache entry, the kept translation is not the first byte's
                // page's by its place)
                self.g(ADDR);
                self.b.wrap_i64_to_i32();
                self.c32(4095);
                self.b.and_i32();
                self.c32((4096 - size) as i32);
                self.b.leu_i32();
                self.b.and_i32();
            }
            aligned_check(self);
            self.b.hint(true);
            self.b.if_i32();
            self.b.get_local(&self.lookup_kept[k].delta);
            self.g(ADDR);
            self.b.wrap_i64_to_i32();
            self.b.add_i32();
            self.b.else_();
        }
        self.g(ADDR);
        self.b.wrap_i64_to_i32();
        self.c32(8);
        self.b.shr_u_i32();
        self.c32(((self.env.jac_entries - 1) * jac::ENTRY_BYTES) as i32);
        self.b.and_i32();
        self.gi(JAC);
        self.b.add_i32();
        self.ti(ENT);
        self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, table);
        self.g(TAG);
        self.b.eq_i64();
        aligned_check(self);
        self.b.hint(true);
        self.b.if_i32();
        if let Some(k) = kept {
            self.g(TAG);
            self.b.set_local_i64(self.lookup_kept[k].tag.wide());
        }
        self.gi(ENT);
        self.b.load_aligned_i32(table + 12);
        if let Some(k) = kept {
            self.b.tee_local(&self.lookup_kept[k].delta);
        }
        self.g(ADDR);
        self.b.wrap_i64_to_i32();
        self.b.add_i32();
        self.b.else_();
        self.g(ADDR);
        if WasmBuilder::ATOMIC_GUEST_MEMORY {
            let f = self.access_function();
            self.c32((size | bits) as i32);
            self.b.call_internal(f);
        }
        else {
            self.c32(size as i32 | (bits & 0x100) as i32);
            self.b.call_signature(
                "x64_page_access",
                Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
            );
        }
        self.ti(HH);
        self.b.eqz_i32();
        self.b.if_void();
        self.leave_to(fallback, start);
        self.b.block_end();
        self.gi(HH);
        self.b.block_end();
        if kept.is_some() {
            self.b.block_end();
        }
    }
    fn load(&mut self, width: u8) { self.b.guest_load_i64_bits(width as u32, 0); }
    /// [host, value] -> []. With cores in workers, an unaligned host (see
    /// host_store) is a plain store after a fence (x86 orders it after the
    /// accesses before it), as the interpreter does.
    fn store(&mut self, width: u8) {
        if !WasmBuilder::ATOMIC_GUEST_MEMORY || width == 8 {
            return self.b.guest_store_i64_bits(width as u32, 0);
        }
        self.s(SV);
        self.ti(SH);
        self.c32(width as i32 / 8 - 1);
        self.b.and_i32();
        self.b.if_void();
        self.b.guest_fence();
        self.gi(SH);
        self.g(SV);
        self.b.memory_op(
            match width {
                16 => op::OP_I64STORE16,
                32 => op::OP_I64STORE32,
                _ => op::OP_I64STORE,
            },
            op::MEM_NO_ALIGN,
            0,
        );
        self.b.else_();
        self.gi(SH);
        self.g(SV);
        self.b.guest_store_i64_bits(width as u32, 0);
        self.b.block_end();
    }
    /// load() from a host of host_store: [host] -> [value]; unaligned (cores
    /// in workers) a plain load, then a fence
    fn load_any(&mut self, width: u8) {
        if !WasmBuilder::ATOMIC_GUEST_MEMORY || width == 8 {
            return self.load(width);
        }
        self.ti(SH);
        self.c32(width as i32 / 8 - 1);
        self.b.and_i32();
        self.b.if_i64();
        self.gi(SH);
        self.b.memory_op(
            match width {
                16 => op::OP_I64LOAD16U,
                32 => op::OP_I64LOAD32U,
                _ => op::OP_I64LOAD,
            },
            op::MEM_NO_ALIGN,
            0,
        );
        self.b.guest_fence();
        self.b.else_();
        self.gi(SH);
        self.load(width);
        self.b.block_end();
    }
    /// Push the (zero-extended) value of a source operand.
    fn read(&mut self, o: Opnd, width: u8, inst: &Inst) {
        match o {
            Opnd::Reg(r) => self.get_reg(r, width),
            // (a volatile instruction's, from the page as it is: P7.3)
            Opnd::Imm(_) if inst.dynamic.is_some() => {
                let (at, bytes, signed) = inst.dynamic.unwrap();
                let host = self.env.span_hosts[at as usize / PAGE] + at as u32 % PAGE as u32;
                self.c32(host as i32);
                self.b.memory_op(
                    match (bytes, signed) {
                        (1, true) => op::OP_I64LOAD8S,
                        (1, false) => op::OP_I64LOAD8U,
                        (2, true) => op::OP_I64LOAD16S,
                        (2, false) => op::OP_I64LOAD16U,
                        (_, true) => op::OP_I64LOAD32S,
                        (_, false) => op::OP_I64LOAD32U,
                    },
                    op::MEM_NO_ALIGN,
                    0,
                );
                if width < 64 {
                    self.c64(mask(width));
                    self.b.and_i64();
                }
            },
            Opnd::Imm(v) => self.c64(v & mask(width)),
            Opnd::Mem(a) => {
                self.address(&a, inst.d.next.0, true);
                self.s(ADDR);
                self.host(width as u32 / 8, false, inst.d.start.0);
                self.load(width);
            },
        }
    }
    /// Read a destination operand; a memory one is validated for writing
    /// first when `write` (its host address stays in HOST).
    fn read_dst(&mut self, o: Opnd, width: u8, write: bool, inst: &Inst) {
        match o {
            Opnd::Mem(a) if inst.locked => {
                self.address(&a, inst.d.next.0, true);
                self.s(ADDR);
                self.host(width as u32 / 8, true, inst.d.start.0);
                self.si(HOST);
                self.locked_load(width);
            },
            Opnd::Mem(a) if write => {
                self.address(&a, inst.d.next.0, true);
                self.s(ADDR);
                self.host_store(width as u32 / 8, inst.d.start.0);
                self.ti(HOST);
                self.load_any(width);
            },
            Opnd::Mem(a) => {
                self.address(&a, inst.d.next.0, true);
                self.s(ADDR);
                self.host(width as u32 / 8, false, inst.d.start.0);
                self.ti(HOST);
                self.load(width);
            },
            _ => self.read(o, width, inst),
        }
    }
    /// A locked instruction (cores in workers) with its operand's host
    /// address in HOST: from here to write_dst is a loop that computes from
    /// the value read, and commits with a compare-exchange; it starts over
    /// when another core changed the operand meanwhile. Pushes the value.
    fn locked_load(&mut self, width: u8) {
        debug_assert!(self.lock_loop.is_none());
        self.lock_loop = Some(self.b.loop_void());
        self.gi(HOST);
        self.load(width);
        self.s(OLD);
        self.g(OLD);
    }
    /// The locked instruction's write: [] -> [], leaves the loop when the
    /// compare-exchange found the value read. It commits as the
    /// interpreter's does (x64_page_lock_commit: never interleaved with a
    /// split locked operation on the same bytes).
    fn locked_store(&mut self, width: u8, value: usize) {
        let again = self.lock_loop.take().unwrap();
        self.gi(HOST);
        self.g(OLD);
        self.g(value);
        self.c32(width as i32 / 8);
        self.b.call_signature(
            "x64_page_lock_commit",
            Signature::new(
                &[WasmType::I32, WasmType::I64, WasmType::I64, WasmType::I32],
                &[WasmType::I32],
            ),
        );
        self.b.eqz_i32();
        self.b.br_if(again);
        self.b.block_end();
    }
    /// Store local `value` to a destination read by read_dst.
    fn write_dst(&mut self, o: Opnd, width: u8, value: usize) {
        if self.lock_loop.is_some() {
            return self.locked_store(width, value);
        }
        match o {
            Opnd::Reg(r) => {
                self.g(value);
                self.set_reg(r, width);
            },
            Opnd::Mem(_) => {
                self.gi(HOST);
                self.g(value);
                self.store(width);
            },
            Opnd::Imm(_) => unreachable!(),
        }
    }
    /// Validate a memory destination for writing without reading it.
    fn prepare_store(&mut self, a: &AddressExpr, width: u8, inst: &Inst) {
        self.address(a, inst.d.next.0, true);
        self.s(ADDR);
        self.host_store(width as u32 / 8, inst.d.start.0);
        self.si(HOST);
    }
    /// Reverse the bytes of the i64 on the stack: all 8 (`width` 64), or
    /// its low 4 (zero-extended)
    fn byte_swap(&mut self, width: u8) {
        if width == 64 {
            self.s(TV);
            self.g(TV);
            self.c64(8);
            self.b.shr_u_i64();
            self.c64(0x00FF_00FF_00FF_00FF);
            self.b.and_i64();
            self.g(TV);
            self.c64(0x00FF_00FF_00FF_00FF);
            self.b.and_i64();
            self.c64(8);
            self.b.shl_i64();
            self.b.or_i64();
            self.s(TV);
            self.g(TV);
            self.c64(16);
            self.b.shr_u_i64();
            self.c64(0x0000_FFFF_0000_FFFF);
            self.b.and_i64();
            self.g(TV);
            self.c64(0x0000_FFFF_0000_FFFF);
            self.b.and_i64();
            self.c64(16);
            self.b.shl_i64();
            self.b.or_i64();
            self.c64(32);
            self.b.op(op::OP_I64ROTL);
        }
        else {
            self.b.wrap_i64_to_i32();
            self.si(COND);
            // rotl(x & 0x00FF00FF, 24) | rotl(x & 0xFF00FF00, 8)
            self.gi(COND);
            self.c32(0x00FF_00FF);
            self.b.and_i32();
            self.c32(24);
            self.b.rotl_i32();
            self.gi(COND);
            self.c32(0xFF00_FF00u32 as i32);
            self.b.and_i32();
            self.c32(8);
            self.b.rotl_i32();
            self.b.or_i32();
            self.b.extend_unsigned_i32_to_i64();
        }
    }
    /// The flags of BLSR, BLSMSK, BLSI, BZHI, TZCNT and LZCNT
    /// (cpu::bmi::logic_flags): SF, ZF and PF of TR (masked), AF and OF
    /// clear, CF the i32 that `carry` pushes. CF is computed now; the other
    /// flags not needed now become an AND record of TR with itself, which
    /// gives them their values (AND's CF, 0, is not pending).
    fn bmi_flags(&mut self, width: u8, need: u32, inst: &Inst, carry: impl FnOnce(&mut Self)) {
        self.flags_begin(need | CF);
        let mut first = true;
        self.szp(TR, need, width, &mut first);
        carry(self);
        self.join(&mut first);
        self.flags_end(first);
        self.g(TR);
        self.s(TA);
        self.g(TR);
        self.s(TB);
        self.record(4, width, ARITH, need | CF, inst);
    }
    fn mask_to(&mut self, width: u8) {
        if width < 64 {
            self.c64(mask(width));
            self.b.and_i64();
        }
    }
    /// Sign-extend the `width`-bit value on the stack to 64 bits.
    fn sext(&mut self, width: u8) {
        match width {
            8 => self.b.op(0xC2),  // i64.extend8_s
            16 => self.b.op(0xC3), // i64.extend16_s
            32 => self.b.op(0xC4), // i64.extend32_s
            _ => {},
        }
    }
    /// Push local `i`'s low `width` bits sign-extended: an i32 below 64
    /// bits, else the i64
    fn sext32(&mut self, i: usize, width: u8) {
        self.g(i);
        if width < 64 {
            self.b.wrap_i64_to_i32();
            match width {
                8 => self.b.op(0xC0),  // i32.extend8_s
                16 => self.b.op(0xC1), // i32.extend16_s
                _ => {},
            }
        }
    }
    /// condition's signed L (`cc` 0xC), GE, LE and G (0xF) of two sext32
    /// values of `width`
    fn signed_compare(&mut self, cc: u8, width: u8) {
        let (less, invert) = (cc >> 1 == 6, cc & 1 != 0);
        self.b.op(match (less, invert, width == 64) {
            (true, false, false) => op::OP_I32LTS,
            (true, true, false) => op::OP_I32GES,
            (false, false, false) => op::OP_I32LES,
            (false, true, false) => op::OP_I32GTS,
            (true, false, true) => op::OP_I64LTS,
            (true, true, true) => op::OP_I64GES,
            (false, false, true) => op::OP_I64LES,
            (false, true, true) => op::OP_I64GTS,
        });
    }
    /// Retry the instruction unless the address in local `i` is canonical
    /// (compatibility mode has no noncanonical addresses).
    fn check_canonical(&mut self, i: usize, start: u64) {
        if self.env.compat {
            return;
        }
        self.g(i);
        self.c64(16);
        self.b.shl_i64();
        self.c64(16);
        self.b.shr_s_i64();
        self.g(i);
        self.b.ne_i64();
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
    }
    /// Push the stack slot `delta` bytes from RSP into ADDR, validated as a
    /// `write` access; host address in HOST.
    fn stack(&mut self, delta: i64, write: bool, start: u64) {
        self.stack_sized(delta, self.slot_bytes() as u32, write, start)
    }
    /// stack() of an access of `size` bytes (legacy mode's 16-bit slots,
    /// PUSHAD and POPAD: P7.3)
    fn stack_sized(&mut self, delta: i64, size: u32, write: bool, start: u64) {
        self.lookup_base = Some((4, 0));
        self.g(4);
        if self.env.compat {
            // (in i32: ESP wraps at 4 GiB for free)
            self.b.wrap_i64_to_i32();
            if delta != 0 {
                self.c32(delta as i32);
                self.b.add_i32();
            }
            if self.env.stack16 {
                // (a 16-bit stack's SP wraps at 64 KiB, P7.7)
                self.c32(0xFFFF);
                self.b.and_i32();
            }
            if self.env.segmented {
                // (P7.2(3): the SS base; commit_sp sets ESP)
                self.c32(gp::segment_offsets as i32 + 2 * 4);
                self.b.load_aligned_i32(0);
                self.b.add_i32();
            }
            self.b.extend_unsigned_i32_to_i64();
        }
        else if delta != 0 {
            self.c64(delta as u64);
            self.b.add_i64();
        }
        self.s(ADDR);
        self.host(size, write, start);
        self.si(HOST);
    }
    /// A stack slot's size: 8 bytes, 4 in compatibility mode (P7.2), 2 in
    /// 16-bit code (P7.7)
    fn slot_bytes(&self) -> u64 {
        if self.env.prot16 {
            2
        }
        else if self.env.compat {
            4
        }
        else {
            8
        }
    }
    /// The 64-bit value on the stack wrapped at 4 GiB (compatibility mode's
    /// EIP, ESP and addresses)
    fn wrap32(&mut self) {
        self.c64(0xFFFF_FFFF);
        self.b.and_i64();
    }
    /// RSP to the slot stack_sized(`delta`) addressed (a push): ADDR, or
    /// with segment bases (P7.2(3)), where ADDR holds the SS base too, ESP
    /// plus `delta`
    fn commit_sp(&mut self, delta: i64) {
        if self.env.segmented {
            self.adjust_sp(delta as u64);
        }
        else {
            self.g(ADDR);
            self.s(4);
        }
    }
    /// Retry the instruction being emitted if `segment` holds a null
    /// selector (P7.2(3))
    fn null_check(&mut self, segment: u8) {
        self.c32(gp::segment_is_null as i32 + segment as i32);
        self.b.load_u8(0);
        self.retry_if(self.inst_start);
    }
    /// The 32-bit address (an i64) on the stack plus the base of `segment`
    /// when compiled for segment bases (P7.2(3): string pointers, LEAVE),
    /// which must not be null
    fn segment_base(&mut self, segment: u8) {
        if self.env.segmented && (segment != 1 || self.env.prot16) {
            if segment != 1 && segment != 2 {
                self.null_check(segment);
            }
            self.b.wrap_i64_to_i32();
            self.c32(gp::segment_offsets as i32 + segment as i32 * 4);
            self.b.load_aligned_i32(0);
            self.b.add_i32();
            self.b.extend_unsigned_i32_to_i64();
        }
    }
    /// RSP += `bytes` (in compatibility mode ESP, wrapped; on a 16-bit stack
    /// SP, ESP's high half kept: P7.7)
    fn adjust_sp(&mut self, bytes: u64) {
        if self.env.stack16 {
            self.g(4);
            self.c64(0xFFFF_0000);
            self.b.and_i64();
            self.g(4);
            self.c64(bytes);
            self.b.add_i64();
            self.c64(0xFFFF);
            self.b.and_i64();
            self.b.or_i64();
            self.s(4);
            return;
        }
        self.g(4);
        if self.env.compat {
            self.b.wrap_i64_to_i32();
            self.c32(bytes as i32);
            self.b.add_i32();
            self.b.extend_unsigned_i32_to_i64();
        }
        else {
            self.c64(bytes);
            self.b.add_i64();
        }
        self.s(4);
    }

    // EFLAGS ------------------------------------------------------------

    /// Combine the i32 terms pushed so far (see flags_begin/flags_end).
    fn join(&mut self, first: &mut bool) {
        if !*first {
            self.b.or_i32();
        }
        *first = false;
    }
    fn flags_begin(&mut self, need: u32) {
        self.gi(FL);
        self.c32(!need as i32);
        self.b.and_i32();
    }
    fn flags_end(&mut self, first: bool) {
        if first {
            self.c32(0);
        }
        self.b.or_i32();
        self.si(FL);
    }
    /// i32: bit `bit` of i64 local `i`, moved to bit `to`.
    fn bit_of(&mut self, i: usize, bit: u8, to: u8) {
        self.g(i);
        if bit != 0 {
            self.c64(bit as u64);
            self.b.shr_u_i64();
        }
        self.b.wrap_i64_to_i32();
        self.c32(1);
        self.b.and_i32();
        if to != 0 {
            self.c32(to as i32);
            self.b.shl_i32();
        }
    }
    /// i32: 1 when the low byte of local `i` has even parity.
    fn parity(&mut self, i: usize) {
        self.g(i);
        self.b.wrap_i64_to_i32();
        self.c32(0xFF);
        self.b.and_i32();
        self.b.popcnt_i32();
        self.c32(1);
        self.b.and_i32();
        self.c32(1);
        self.b.xor_i32();
    }
    fn is_zero(&mut self, i: usize) {
        self.g(i);
        self.b.op(op::OP_I64EQZ);
    }
    /// Compatibility mode: last_op1 = the low 32 bits of i64 local `i` (see
    /// Emitter::last_op1)
    fn note_last_op1(&mut self, i: usize) {
        if self.last_op1_memory {
            self.c32(gp::last_op1 as i32);
            self.g(i);
            self.b.wrap_i64_to_i32();
            self.b.store_aligned_i32(0);
        }
    }
    /// Whether the 32-bit interpreter's last_op1 is kept (compatibility and
    /// legacy mode)
    fn tracks_last_op1(&self) -> bool { self.last_op1_memory }
    /// Push last_op1 (i32)
    fn push_last_op1(&mut self) { self.b.load_fixed_i32(gp::last_op1 as u32); }
    /// Compatibility mode: SF, ZF, PF and AF after a multiply as the 32-bit
    /// interpreter's lazy EFLAGS give them (cpu::arith::mul32 and kin: the
    /// result TR at `width`; AF from last_op1 and that result, getaf), each
    /// in `need`, joined to what is on the stack
    fn legacy_mul_flags(&mut self, width: u8, need: u32, first: &mut bool) {
        self.szp(TR, need, width, first);
        if need & AF != 0 {
            self.legacy_af();
            self.join(first);
        }
    }
    /// i32: the AF the 32-bit interpreter's lazy EFLAGS give a result in TR
    /// that its operation left to last_op1: (last_op1 ^ (result - last_op1)
    /// ^ result) & AF (cpu::misc_instr::getaf, not a subtraction)
    fn legacy_af(&mut self) {
        self.push_last_op1();
        self.g(TR);
        self.b.wrap_i64_to_i32();
        self.push_last_op1();
        self.b.sub_i32();
        self.b.xor_i32();
        self.g(TR);
        self.b.wrap_i64_to_i32();
        self.b.xor_i32();
        self.c32(AF as i32);
        self.b.and_i32();
    }
    /// Compatibility mode: `bits` (of SF, ZF, PF, AF and OF) pending in the
    /// lazy record as the 32-bit interpreter's EFLAGS leave them after a
    /// result TR at `width` of an operation that kept last_op1 (shifts,
    /// multiplies, SHLD, SHRD, BSF, BSR): its getters take SF, ZF and PF of
    /// the result, AF and OF of last_op1 and the result as of an addition
    /// (cpu::misc_instr::getaf, getof), which x64_page_flags gives as ADD of
    /// last_op1 and result - last_op1. It replaces any pending record: these
    /// instructions write every flag.
    fn legacy_record(&mut self, width: u8, bits: u32) {
        self.push_last_op1();
        self.b.extend_unsigned_i32_to_i64();
        self.s(FA);
        self.g(TR);
        self.g(FA);
        self.b.sub_i64();
        self.mask_to(32);
        self.s(FB);
        self.g(TR);
        self.s(FR);
        let size = match width {
            8 => 0,
            16 => 1,
            _ => 2,
        };
        self.c32((size << 20 | bits) as i32);
        self.si(FK);
    }
    /// Compatibility mode (P7.2): a 32-bit ROL, ROR, SHL, SHR or SAR (code
    /// 0, 1, 4 or 6, 5, 7) as the 32-bit interpreter computes it
    /// (cpu::arith::rol32 and kin): the count masked to 5 bits; CF and OF by
    /// its formulas for any nonzero count (ROL: OF = CF ^ MSB, ROR: the two
    /// top bits, SHL: CF ^ MSB, SHR: the operand's MSB, SAR: 0); SHL, SHR
    /// and SAR then leave SF, ZF and PF of the result and AF from last_op1;
    /// a zero count changes no flag. `count`: an immediate, else CL. The
    /// EFLAGS bits in `need` only; of SHL, SHR and SAR, SF, ZF, PF and AF
    /// that no later instruction reads (only a way out may observe them,
    /// P4.23) stay pending (legacy_record), as Tier-0 leaves them to the
    /// interpreter's lazy EFLAGS: returned, they are not written into FL
    fn legacy_shift32(
        &mut self,
        inst: &Inst,
        code: u8,
        dst: Opnd,
        count: Option<u8>,
        need: u32,
    ) -> u32 {
        let rotate = code <= 1;
        self.read_dst(dst, 32, true, inst);
        self.s(TA);
        match count {
            Some(count) => self.c64((count & 31) as u64),
            None => {
                self.g(1);
                self.c64(31);
                self.b.and_i64();
            },
        }
        self.s(TB);
        self.g(TA);
        self.b.wrap_i64_to_i32();
        self.g(TB);
        self.b.wrap_i64_to_i32();
        match code {
            0 => self.b.rotl_i32(),
            1 => self.b.rotr_i32(),
            5 => self.b.shr_u_i32(),
            7 => self.b.shr_s_i32(),
            _ => self.b.shl_i32(),
        }
        self.b.extend_unsigned_i32_to_i64();
        self.s(TR);
        self.write_dst(dst, 32, TR);
        let need = need & if rotate { CF | OF } else { ARITH };
        if need == 0 || count.is_some_and(|c| c & 31 == 0) {
            return 0;
        }
        // (a count of zero keeps every flag: the record too, see Op::Shift)
        let lazy = if rotate || !self.env.exit_flags {
            0
        }
        else {
            need & (SF | ZF | PF | AF) & !inst.live_out
        };
        let need = need & !lazy;
        if count.is_none() {
            self.g(TB);
            self.b.op(op::OP_I64EQZ);
            self.b.eqz_i32();
            self.b.if_void();
        }
        if lazy != 0 {
            self.legacy_record(32, lazy);
        }
        self.flags_begin(need);
        let mut first = true;
        // i32 0/1: bit `bit` of TA (the operand) or TR, or at a count from TB
        let bit = |e: &mut Self, local: usize, shift: Option<(i64, bool)>| {
            e.g(local);
            match shift {
                // (by the count plus a constant, or the constant minus it)
                Some((k, minus)) => {
                    if minus {
                        e.c64(k as u64);
                        e.g(TB);
                        e.b.sub_i64();
                    }
                    else {
                        e.g(TB);
                        e.c64(k as u64);
                        e.b.add_i64();
                    }
                    e.b.shr_u_i64();
                },
                None => {},
            }
            e.b.wrap_i64_to_i32();
            e.c32(1);
            e.b.and_i32();
        };
        let msb = |e: &mut Self, local: usize| {
            e.g(local);
            e.c64(31);
            e.b.shr_u_i64();
            e.b.wrap_i64_to_i32();
            e.c32(1);
            e.b.and_i32();
        };
        let carry = |e: &mut Self| match code {
            0 => bit(e, TR, None),
            1 => msb(e, TR),
            4 | 6 => bit(e, TA, Some((32, true))),
            _ => bit(e, TA, Some((-1, false))),
        };
        if need & CF != 0 {
            carry(self);
            self.join(&mut first);
        }
        if need & OF != 0 && code != 7 {
            match code {
                0 => {
                    bit(self, TR, None);
                    msb(self, TR);
                    self.b.xor_i32();
                },
                1 => {
                    msb(self, TR);
                    self.g(TR);
                    self.c64(30);
                    self.b.shr_u_i64();
                    self.b.wrap_i64_to_i32();
                    self.c32(1);
                    self.b.and_i32();
                    self.b.xor_i32();
                },
                4 | 6 => {
                    carry(self);
                    msb(self, TR);
                    self.b.xor_i32();
                },
                _ => msb(self, TA),
            }
            self.c32(11);
            self.b.shl_i32();
            self.join(&mut first);
        }
        if !rotate {
            self.szp(TR, need, 32, &mut first);
            if need & AF != 0 {
                self.legacy_af();
                self.join(&mut first);
            }
        }
        self.flags_end(first);
        if count.is_none() {
            self.b.block_end();
        }
        lazy
    }
    /// SF, ZF, PF of local `i` (masked to `width`).
    fn szp(&mut self, i: usize, need: u32, width: u8, first: &mut bool) {
        if need & PF != 0 {
            self.parity(i);
            self.c32(2);
            self.b.shl_i32();
            self.join(first);
        }
        if need & ZF != 0 {
            self.is_zero(i);
            self.c32(6);
            self.b.shl_i32();
            self.join(first);
        }
        if need & SF != 0 {
            self.bit_of(i, width - 1, 7);
            self.join(first);
        }
    }
    /// Flags of ALU `code` over TA (a), TB (b), TR (result, masked). ADC and
    /// SBB read their CF input from FL before it is replaced.
    fn alu_flags(&mut self, code: u8, width: u8, need: u32) {
        if need == 0 {
            return;
        }
        let logic = matches!(code, 1 | 4 | 6);
        let add = matches!(code, 0 | 2);
        let carry = matches!(code, 2 | 3);
        self.flags_begin(need);
        let mut first = true;
        self.szp(TR, need, width, &mut first);
        if !logic {
            if need & CF != 0 {
                let (x, y) = if add { (TR, TA) } else { (TA, TB) };
                self.g(x);
                self.g(y);
                self.b.ltu_i64();
                if carry {
                    self.g(x);
                    self.g(y);
                    self.b.eq_i64();
                    self.gi(CI);
                    self.b.and_i32();
                    self.b.or_i32();
                }
                self.join(&mut first);
            }
            if need & AF != 0 {
                self.g(TA);
                self.g(TB);
                self.b.xor_i64();
                self.g(TR);
                self.b.xor_i64();
                self.b.wrap_i64_to_i32();
                self.c32(AF as i32);
                self.b.and_i32();
                self.join(&mut first);
            }
            if need & OF != 0 {
                if add {
                    self.g(TA);
                    self.g(TR);
                    self.b.xor_i64();
                    self.g(TB);
                    self.g(TR);
                    self.b.xor_i64();
                }
                else {
                    self.g(TA);
                    self.g(TB);
                    self.b.xor_i64();
                    self.g(TA);
                    self.g(TR);
                    self.b.xor_i64();
                }
                self.b.and_i64();
                self.s(TX);
                self.bit_of(TX, width - 1, 11);
                self.join(&mut first);
            }
        }
        self.flags_end(first);
    }
    /// After a producer computed the `eager` part of the flags it `writes`:
    /// the rest becomes the lazy record (operands TA, TB; kind; carry CI).
    fn record(&mut self, code: u8, width: u8, writes: u32, eager: u32, inst: &Inst) {
        let pending = writes & !eager;
        if pending != 0 || inst.keep {
            self.g(TA);
            self.s(FA);
            self.g(TB);
            self.s(FB);
            self.g(TR);
            self.s(FR);
        }
        if pending != 0 {
            let kind = (code as u32) << 16 | (width.trailing_zeros() - 3) << 20 | pending;
            self.c32(kind as i32);
            if matches!(code, 2 | 3) {
                self.gi(CI);
                self.c32(23);
                self.b.shl_i32();
                self.b.or_i32();
            }
        }
        else {
            self.c32(0);
        }
        self.si(FK);
    }
    /// record() of INC or DEC in legacy mode (M8): FA holds the result, as FR
    /// does, and RECORD_UNIT says the operands are result -/+ 1 and 1
    /// (pages::x64_page_flags): a loop counter's old value and the constant
    /// are no values the loop carries
    fn unit_record(&mut self, dec: bool, width: u8, writes: u32, eager: u32, inst: &Inst) {
        let pending = writes & !eager;
        if pending != 0 || inst.keep {
            self.g(TR);
            self.s(FA);
            self.g(TR);
            self.s(FR);
        }
        if pending != 0 {
            let code = if dec { 5 } else { 0 };
            self.c32(
                ((code as u32) << 16 | (width.trailing_zeros() - 3) << 20 | RECORD_UNIT | pending)
                    as i32,
            );
        }
        else {
            self.c32(0);
        }
        self.si(FK);
    }
    /// A partial writer computed all of `bits` into FL: they are no longer
    /// pending in the record.
    fn written(&mut self, bits: u32) {
        self.gi(FK);
        self.c32(!bits as i32);
        self.b.and_i32();
        self.si(FK);
    }
    /// Make `bits` of FL current before reading them.
    fn materialize_if(&mut self, bits: u32) {
        if bits & ARITH == 0 {
            return;
        }
        self.gi(FK);
        self.c32((bits & ARITH) as i32);
        self.b.and_i32();
        self.b.hint(false);
        self.b.if_void();
        self.gi(FK);
        self.g(FA);
        self.g(FB);
        self.gi(FL);
        self.b.call_signature(
            "x64_page_flags",
            Signature::new(
                &[WasmType::I32, WasmType::I64, WasmType::I64, WasmType::I32],
                &[WasmType::I32],
            ),
        );
        self.si(FL);
        self.c32(0);
        self.si(FK);
        self.b.block_end();
    }
    /// Push condition `cc` (i32 0/1): from the kept producer operands when
    /// fused, else from FL.
    fn condition(&mut self, cc: u8, fused: Option<Known>) {
        // (an odd condition, the even one's opposite: the opposite
        // comparison where there is one, else i32.eqz at the end)
        let invert = cc & 1 != 0;
        match fused {
            Some(Known::Sub(w)) => match cc >> 1 {
                0 => {
                    self.g(FA);
                    self.g(FB);
                    self.b.xor_i64();
                    self.g(FA);
                    self.g(FR);
                    self.b.xor_i64();
                    self.b.and_i64();
                    self.s(TX);
                    self.bit_of(TX, w - 1, 0);
                },
                1..=3 => {
                    self.g(FA);
                    self.g(FB);
                    self.b.op(match (cc >> 1, invert) {
                        (1, false) => op::OP_I64LTU,
                        (1, true) => op::OP_I64GEU,
                        (2, false) => op::OP_I64EQ,
                        (2, true) => op::OP_I64NE,
                        (3, false) => op::OP_I64LEU,
                        _ => op::OP_I64GTU,
                    });
                    return;
                },
                4 => self.bit_of(FR, w - 1, 0),
                5 => self.parity(FR),
                _ => {
                    // L/GE, LE/G: signed, in i32 below 64 bits
                    for x in [FA, FB] {
                        self.sext32(x, w);
                    }
                    self.signed_compare(cc, w);
                    return;
                },
            },
            Some(Known::Logic(w)) | Some(Known::Result(w)) => match cc >> 1 {
                0 | 1 => self.c32(0),
                2 | 3 => {
                    self.g(FR);
                    if invert {
                        self.c64(0);
                        self.b.ne_i64();
                    }
                    else {
                        self.b.op(op::OP_I64EQZ);
                    }
                    return;
                },
                4 | 6 => self.bit_of(FR, w - 1, 0),
                5 => self.parity(FR),
                _ => {
                    // LE/G: the result's sign and zero (OF clear)
                    self.sext32(FR, w);
                    if w == 64 {
                        self.c64(0);
                    }
                    else {
                        self.c32(0);
                    }
                    self.signed_compare(cc, w);
                    return;
                },
            },
            None => {
                let bit = |e: &mut Self, shift: i32| {
                    e.gi(FL);
                    if shift != 0 {
                        e.c32(shift);
                        e.b.shr_u_i32();
                    }
                };
                match cc >> 1 {
                    0 => bit(self, 11),
                    1 => bit(self, 0),
                    2 => bit(self, 6),
                    3 => {
                        self.gi(FL);
                        self.c32((CF | ZF) as i32);
                        self.b.and_i32();
                        self.c32(0);
                        self.b.ne_i32();
                    },
                    4 => bit(self, 7),
                    5 => bit(self, 2),
                    6 => {
                        bit(self, 7);
                        bit(self, 11);
                        self.b.xor_i32();
                    },
                    _ => {
                        bit(self, 7);
                        bit(self, 11);
                        self.b.xor_i32();
                        bit(self, 6);
                        self.b.or_i32();
                    },
                }
                if cc >> 1 != 3 {
                    self.c32(1);
                    self.b.and_i32();
                }
            },
        }
        if invert {
            self.b.eqz_i32();
        }
    }
}

impl Emitter {
    fn instruction(&mut self, inst: &Inst, index: &BTreeMap<u16, usize>) {
        // (an access cache lookup takes a kept translation by the base
        // register of this instruction's operand, P4.21: set by address(),
        // stack() and the string instructions, never left from another)
        self.lookup_base = None;
        self.inst_start = inst.d.start.0;
        // (XMM locals, P4.17: the registers this instruction uses, loaded
        // now, in code every path runs; other vector code finds memory current)
        if self.env.xmm_locals {
            match xmm_use(&inst.op, self.env.sse_fast_check) {
                XmmUse::Hold(registers) => {
                    // (what it overwrites whole needs no load)
                    let overwritten = xmm_overwritten(&inst.op);
                    self.xmm_hold(registers & self.xmm_worth & !overwritten);
                    self.xmm_claim(registers & self.xmm_worth & overwritten);
                },
                XmmUse::Lanes => {},
                XmmUse::Memory => self.xmm_release(),
                XmmUse::None => {},
            }
        }
        if self.env.sse_fast_check {
            self.xmm_facts(&inst.op);
        }
        // (other vector code may write bits 255:128 by their memory)
        if matches!(xmm_use(&inst.op, self.env.sse_fast_check), XmmUse::Memory) {
            self.ymm_zeroed = 0;
        }
        if unsafe { (*(&raw const SIZE_STATS)).is_none() } {
            return self.instruction_inner(inst, index);
        }
        let before = self.b.body_len();
        self.instruction_inner(inst, index);
        let name = format!("{:?}", inst.op);
        let name = name
            .split([' ', '{', '('])
            .next()
            .unwrap_or("?")
            .to_string();
        size_note(name, self.b.body_len() - before);
    }
    fn instruction_inner(&mut self, inst: &Inst, index: &BTreeMap<u16, usize>) {
        let start = inst.d.start.0;
        let next = inst.d.next.0;
        let need = inst.writes & inst.live_out;
        if inst.span_straddle && !matches!(inst.op, Op::Step) {
            // (its bytes on the span's next page: as compiled once that page
            // was verified, else step it; P7.3b)
            self.b.get_local(self.verified.as_ref().unwrap());
            self.c32(1 << ((next - 1) / PAGE as u64));
            self.b.and_i32();
            self.b.eqz_i32();
            self.b.if_void();
            self.leave_to(self.f().step, start);
            self.b.block_end();
        }
        if let (Some((word, count)), false) = (inst.straddle, matches!(inst.op, Op::Step)) {
            // the next page still fetches as compiled, else step it
            self.c64(word);
            self.c32(count as i32);
            self.b.call_signature(
                "x64_page_straddle",
                Signature::new(&[WasmType::I64, WasmType::I32], &[WasmType::I32]),
            );
            self.b.eqz_i32();
            self.b.if_void();
            self.leave_to(self.f().step, start);
            self.b.block_end();
        }
        match inst.op {
            Op::Step => {
                self.leave_to(self.f().step, start);
                return;
            },
            Op::FarCall {
                selector,
                offset,
                width,
            } => self.far_transfer(0, offset, selector as u32, width, start, next),
            Op::FarRet { pop, width } => self.far_transfer(1, pop as u32, 0, width, start, next),
            Op::Nop => {},
            // compatibility mode's x87 (P7.2a)
            Op::X87 {
                opcode,
                modrm,
                io,
                address,
            } => self.x87(inst, opcode, modrm, io, address),
            Op::Fnstsw if self.env.compat => {
                // (P7.3: fpu_load_status_word with TOP from the x87 cache,
                // which stays open: i586 code compares with FCOMP, FNSTSW AX
                // and SAHF, 616.fcompare)
                self.x87_check(start);
                self.x87_cache_open();
                let top = self.x87_cache.as_ref().unwrap().top.unsafe_clone();
                self.b.load_fixed_u16(gp::fpu_status_word as u32);
                self.c32(!(7 << 11));
                self.b.and_i32();
                self.b.get_local(&top);
                self.c32(11);
                self.b.shl_i32();
                self.b.or_i32();
                self.b.extend_unsigned_i32_to_i64();
                self.set_reg(RAX, 16);
            },
            Op::Fnstsw => {
                self.x87_check(start);
                self.x87_close();
                self.b.call_signature(
                    "fpu_load_status_word",
                    Signature::new(&[], &[WasmType::I32]),
                );
                self.b.extend_unsigned_i32_to_i64();
                self.set_reg(RAX, 16);
            },
            Op::X87Flags { name, r } => {
                // (the helper reads and writes FLAGS in memory)
                self.x87_check(start);
                self.materialize_if(ARITH);
                self.c32(gp::flags as i32);
                self.gi(FL);
                self.b.store_aligned_i32(0);
                self.c32(gp::flags_changed as i32);
                self.c32(0);
                self.b.store_aligned_i32(0);
                self.x87_close();
                self.c32(r as i32);
                self.b
                    .call_signature(name, Signature::new(&[WasmType::I32], &[]));
                self.b.load_fixed_i32(gp::flags as u32);
                self.si(FL);
            },
            Op::Fcmov { cc, r } => {
                self.x87_check(start);
                self.materialize_if(inst.flags_read);
                self.x87_close();
                self.condition(cc, None);
                self.c32(r as i32);
                self.b.call_signature(
                    "fpu_fcmovcc",
                    Signature::new(&[WasmType::I32, WasmType::I32], &[]),
                );
            },
            Op::Mov { width, dst, src } => match dst {
                Opnd::Reg(r) => {
                    self.read(src, width, inst);
                    self.set_reg(r, width);
                },
                Opnd::Mem(a) => {
                    self.prepare_store(&a, width, inst);
                    self.gi(HOST);
                    self.read(src, width, inst);
                    self.store(width);
                },
                Opnd::Imm(_) => unreachable!(),
            },
            Op::Extend {
                width,
                from,
                signed,
                dst,
                src,
            } => {
                self.read(src, from, inst);
                if signed {
                    self.sext(from);
                }
                self.set_reg(dst, width);
            },
            Op::Lea {
                width,
                dst,
                address,
            } if width == 32 && self.env.i32_ops => {
                // (P4.20: the low half of the address in i32)
                self.address32(&address, next);
                self.b.extend_unsigned_i32_to_i64();
                self.set_reg(dst, 32);
            },
            Op::Lea {
                width,
                dst,
                address,
            } => {
                self.address(&address, next, false);
                self.set_reg(dst, width);
            },
            Op::Alu {
                code,
                width,
                dst,
                src,
            } => {
                if matches!(code, 5 | 6)
                    && matches!((dst, src), (Opnd::Reg(a), Opnd::Reg(b)) if a == b)
                {
                    // SUB/XOR of a register with itself
                    if code == 5 && self.tracks_last_op1() {
                        self.get_reg(dst.reg().unwrap(), width);
                        self.s(TA);
                        self.note_last_op1(TA);
                    }
                    self.c64(0);
                    self.set_reg(dst.reg().unwrap(), width);
                    // (P4.23: its EFLAGS only where read or observable,
                    // not as XOR EDX, EDX's before a CMP)
                    if !self.env.exit_flags
                        || inst.writes & (inst.live_out | inst.exit_live) != 0
                        || inst.keep
                    {
                        self.gi(FL);
                        self.c32(!ARITH as i32);
                        self.b.and_i32();
                        self.c32((ZF | PF) as i32);
                        self.b.or_i32();
                        self.si(FL);
                        self.c32(0);
                        self.si(FK);
                    }
                    if inst.keep {
                        for l in [FA, FB, FR] {
                            self.c64(0);
                            self.s(l);
                        }
                    }
                }
                else {
                    if matches!(code, 2 | 3) {
                        self.materialize_if(CF);
                        self.gi(FL);
                        self.c32(1);
                        self.b.and_i32();
                        self.si(CI);
                    }
                    self.read_dst(dst, width, code != 7, inst);
                    self.s(TA);
                    self.read(src, width, inst);
                    self.s(TB);
                    if matches!(code, 0 | 2 | 3 | 5 | 7) {
                        self.note_last_op1(TA);
                    }
                    if width == 32 && self.env.i32_ops {
                        let carry = matches!(code, 2 | 3).then_some(self.w[CI].unsafe_clone());
                        self.op32(TA, Some(TB), |b| {
                            match code {
                                0 | 2 => b.add_i32(),
                                1 => b.or_i32(),
                                3 | 5 | 7 => b.sub_i32(),
                                4 => b.and_i32(),
                                _ => b.xor_i32(),
                            }
                            if let Some(carry) = carry {
                                b.get_local(&carry);
                                if code == 2 {
                                    b.add_i32();
                                }
                                else {
                                    b.sub_i32();
                                }
                            }
                        });
                    }
                    else {
                        self.g(TA);
                        self.g(TB);
                        match code {
                            0 | 2 => self.b.add_i64(),
                            1 => self.b.or_i64(),
                            3 | 5 | 7 => self.b.sub_i64(),
                            4 => self.b.and_i64(),
                            _ => self.b.xor_i64(),
                        }
                        if matches!(code, 2 | 3) {
                            self.gi(CI);
                            self.b.extend_unsigned_i32_to_i64();
                            if code == 2 {
                                self.b.add_i64();
                            }
                            else {
                                self.b.sub_i64();
                            }
                        }
                        if !matches!(code, 1 | 4 | 6) {
                            self.mask_to(width);
                        }
                    }
                    self.s(TR);
                    if code != 7 {
                        self.write_dst(dst, width, TR);
                    }
                    self.alu_flags(code, width, need);
                    self.record(code, width, ARITH, need, inst);
                }
            },
            Op::Test { width, a, b } => {
                self.read(a, width, inst);
                self.s(TA);
                self.read(b, width, inst);
                self.s(TB);
                if width == 32 && self.env.i32_ops {
                    self.op32(TA, Some(TB), |b| b.and_i32());
                }
                else {
                    self.g(TA);
                    self.g(TB);
                    self.b.and_i64();
                }
                self.s(TR);
                self.alu_flags(4, width, need);
                self.record(4, width, ARITH, need, inst);
            },
            Op::IncDec { dec, width, dst } => {
                // CF survives: its pending value must not be lost with the record
                self.materialize_if(CF);
                self.read_dst(dst, width, true, inst);
                self.s(TA);
                self.note_last_op1(TA);
                self.c64(1);
                self.s(TB);
                if width == 32 && self.env.i32_ops {
                    self.op32(TA, Some(TB), |b| {
                        if dec {
                            b.sub_i32()
                        }
                        else {
                            b.add_i32()
                        }
                    });
                }
                else {
                    self.g(TA);
                    self.c64(1);
                    if dec {
                        self.b.sub_i64();
                    }
                    else {
                        self.b.add_i64();
                    }
                    self.mask_to(width);
                }
                self.s(TR);
                self.write_dst(dst, width, TR);
                self.alu_flags(if dec { 5 } else { 0 }, width, need);
                if self.env.compat {
                    self.unit_record(dec, width, ARITH & !CF, need, inst);
                }
                else {
                    self.record(if dec { 5 } else { 0 }, width, ARITH & !CF, need, inst);
                }
            },
            Op::Neg { width, dst } => {
                self.read_dst(dst, width, true, inst);
                self.s(TB);
                self.c64(0);
                self.s(TA);
                self.note_last_op1(TA);
                if width == 32 && self.env.i32_ops {
                    self.op32(TA, Some(TB), |b| b.sub_i32());
                }
                else {
                    self.c64(0);
                    self.g(TB);
                    self.b.sub_i64();
                    self.mask_to(width);
                }
                self.s(TR);
                self.write_dst(dst, width, TR);
                self.alu_flags(5, width, need);
                self.record(5, width, ARITH, need, inst);
            },
            Op::Not { width, dst } => {
                self.read_dst(dst, width, true, inst);
                if width == 32 && self.env.i32_ops {
                    self.s(TA);
                    self.op32(TA, None, |b| {
                        b.const_i32(-1);
                        b.xor_i32();
                    });
                }
                else {
                    self.c64(mask(width));
                    self.b.xor_i64();
                }
                self.s(TR);
                self.write_dst(dst, width, TR);
            },
            Op::Shift {
                code,
                width,
                dst,
                count: Some(count),
            } => {
                // (P4.23: only what is read or observable)
                let need = if self.env.exit_flags {
                    inst.writes & (inst.live_out | inst.exit_live)
                }
                else {
                    inst.writes
                };
                let lazy = if self.env.compat {
                    self.legacy_shift32(inst, code, dst, Some(count), need)
                }
                else {
                    self.shift_immediate(inst, code, width, dst, count, need);
                    0
                };
                self.written(inst.writes & !lazy);
            },
            Op::Shift {
                code,
                width,
                dst,
                count: None,
            } => {
                // a zero count keeps every flag
                self.materialize_if(inst.flags_read);
                let lazy = if self.env.compat {
                    self.legacy_shift32(inst, code, dst, None, inst.writes)
                }
                else {
                    self.shift_cl(inst, code, width, dst, inst.writes);
                    0
                };
                self.written(inst.writes & !lazy);
            },
            Op::ShiftCall {
                code,
                width,
                dst,
                count,
            } => {
                self.materialize_if(ARITH);
                self.read_dst(dst, width, true, inst);
                self.s(TA);
                self.g(TA);
                match count {
                    Some(count) => self.c32(count as i32),
                    None => {
                        self.g(1);
                        self.b.wrap_i64_to_i32();
                    },
                }
                self.gi(FL);
                self.c32(code as i32 | (width as i32) << 8);
                if self.tracks_last_op1() {
                    // (compatibility mode, P7.2: the 32-bit interpreter's
                    // rules, which leave AF to last_op1)
                    self.push_last_op1();
                    self.b.call_signature(
                        "x64_page_shift32",
                        Signature::new(
                            &[
                                WasmType::I64,
                                WasmType::I32,
                                WasmType::I32,
                                WasmType::I32,
                                WasmType::I32,
                            ],
                            &[WasmType::I64],
                        ),
                    );
                }
                else {
                    self.b.call_signature(
                        "x64_page_shift",
                        Signature::new(
                            &[WasmType::I64, WasmType::I32, WasmType::I32, WasmType::I32],
                            &[WasmType::I64],
                        ),
                    );
                }
                self.s(TV);
                self.g(TV);
                self.c64(0xFFFF_FFFF);
                self.b.and_i64();
                self.s(TR);
                self.write_dst(dst, width, TR);
                self.g(TV);
                self.c64(32);
                self.b.shr_u_i64();
                self.b.wrap_i64_to_i32();
                self.si(FL);
                self.written(ARITH);
            },
            Op::Imul { width, dst, a, b } => {
                self.read(a, width, inst);
                self.s(TA);
                self.read(b, width, inst);
                self.s(TB);
                if width == 64 {
                    self.g(TA);
                    self.g(TB);
                    self.b.mul_i64();
                    self.s(TR);
                }
                else if width == 32 && self.env.i32_ops {
                    // (P4.20: the full product from sign-extended halves)
                    for x in [TA, TB] {
                        self.g(x);
                        self.b.wrap_i64_to_i32();
                        self.b.extend_signed_i32_to_i64();
                    }
                    self.b.mul_i64();
                    self.s(TV);
                    self.op32(TV, None, |_| {});
                    self.s(TR);
                }
                else {
                    self.g(TA);
                    self.sext(width);
                    self.g(TB);
                    self.sext(width);
                    self.b.mul_i64();
                    self.s(TV);
                    self.g(TV);
                    self.mask_to(width);
                    self.s(TR);
                }
                self.g(TR);
                self.set_reg(dst, width);
                let need = if self.env.exit_flags {
                    inst.writes & (inst.live_out | inst.exit_live)
                }
                else {
                    inst.writes
                };
                // (compatibility mode: SF, ZF, PF and AF only a way out may
                // observe stay pending, legacy_record)
                let lazy = if self.env.compat && self.env.exit_flags {
                    need & (SF | ZF | PF | AF) & !inst.live_out
                }
                else {
                    0
                };
                if need != 0 {
                    self.flags_begin(need & !lazy);
                    if width == 64 {
                        // the high half is not the sign extension of the low
                        self.mul_high(TA, TB, true);
                        self.g(TR);
                        self.c64(63);
                        self.b.shr_s_i64();
                        self.b.ne_i64();
                    }
                    else {
                        self.g(TR);
                        self.sext(width);
                        self.g(TV);
                        self.b.ne_i64();
                    }
                    self.c32((CF | OF) as i32);
                    self.b.mul_i32();
                    self.c32(need as i32);
                    self.b.and_i32();
                    if self.env.compat {
                        self.legacy_mul_flags(width, need & !lazy, &mut false);
                    }
                    self.flags_end(false);
                    if lazy != 0 {
                        self.legacy_record(width, lazy);
                    }
                    self.written(need & !lazy);
                }
            },
            Op::MulWide { signed, width, src } => {
                self.get_reg(RAX, width);
                self.s(TA);
                self.read(src, width, inst);
                self.s(TB);
                if width == 64 {
                    self.g(TA);
                    self.g(TB);
                    self.b.mul_i64();
                    self.s(TR);
                    self.mul_high(TA, TB, signed);
                    self.s(TV);
                }
                else {
                    // (32 or, in 16-bit code, 16 bits: EDX:EAX or DX:AX)
                    self.g(TA);
                    if signed {
                        self.sext(width);
                    }
                    self.g(TB);
                    if signed {
                        self.sext(width);
                    }
                    self.b.mul_i64();
                    self.s(TC);
                    self.g(TC);
                    self.mask_to(width);
                    self.s(TR);
                    self.g(TC);
                    self.c64(width as u64);
                    self.b.shr_u_i64();
                    self.mask_to(width);
                    self.s(TV);
                }
                self.g(TR);
                self.set_reg(RAX, width);
                self.g(TV);
                self.set_reg(RDX, width);
                let need = if self.env.exit_flags {
                    inst.writes & (inst.live_out | inst.exit_live)
                }
                else {
                    inst.writes
                };
                // (compatibility mode: SF, ZF, PF and AF only a way out may
                // observe stay pending, legacy_record)
                let lazy = if self.env.compat && self.env.exit_flags {
                    need & (SF | ZF | PF | AF) & !inst.live_out
                }
                else {
                    0
                };
                if need != 0 {
                    self.flags_begin(need & !lazy);
                    match (signed, width) {
                        (false, _) => {
                            self.g(TV);
                            self.c64(0);
                            self.b.ne_i64();
                        },
                        (true, 64) => {
                            self.g(TV);
                            self.g(TR);
                            self.c64(63);
                            self.b.shr_s_i64();
                            self.b.ne_i64();
                        },
                        (true, _) => {
                            self.g(TR);
                            self.sext(width);
                            self.g(TC);
                            self.b.ne_i64();
                        },
                    }
                    self.c32((CF | OF) as i32);
                    self.b.mul_i32();
                    self.c32(need as i32);
                    self.b.and_i32();
                    if self.env.compat {
                        self.legacy_mul_flags(width, need & !lazy, &mut false);
                    }
                    self.flags_end(false);
                    if lazy != 0 {
                        self.legacy_record(width, lazy);
                    }
                    self.written(need & !lazy);
                }
            },
            // (compatibility mode: 4-byte slots, ESP and EIP wrapped; P7.2)
            Op::Push { src } => {
                let (bytes, width) = (self.slot_bytes(), self.slot_bytes() as u8 * 8);
                self.read(src, width, inst);
                self.s(TV);
                self.stack(-(bytes as i64), true, start);
                self.gi(HOST);
                self.g(TV);
                self.store(width);
                self.commit_sp(-(bytes as i64));
            },
            Op::Pushf => {
                let (bytes, width) = (self.slot_bytes(), self.slot_bytes() as u8 * 8);
                self.materialize_if(ARITH);
                self.stack(-(bytes as i64), true, start);
                self.gi(HOST);
                self.gi(FL);
                self.c32(!0x30000);
                self.b.and_i32();
                self.b.extend_unsigned_i32_to_i64();
                self.store(width);
                self.commit_sp(-(bytes as i64));
            },
            Op::Pop { dst } => {
                let (bytes, width) = (self.slot_bytes(), self.slot_bytes() as u8 * 8);
                self.stack(0, false, start);
                self.gi(HOST);
                self.load(width);
                self.s(TV);
                self.adjust_sp(bytes);
                self.g(TV);
                self.set_reg(dst, width);
            },
            // (legacy mode, P7.3: legacy_template)
            Op::LoopJump { kind, cx, target } => {
                let (count, width) = (register(1, 32, false), if cx { 16 } else { 32 });
                if kind < 3 {
                    // (LOOP: the count less one, EFLAGS unchanged)
                    self.get_reg(count, width);
                    self.c64(1);
                    self.b.sub_i64();
                    self.set_reg(count, width);
                }
                self.materialize_if(inst.flags_read);
                self.get_reg(count, width);
                self.b.wrap_i64_to_i32();
                self.b.eqz_i32();
                if kind < 3 {
                    self.b.eqz_i32();
                }
                if kind < 2 {
                    // (LOOPE while ZF, LOOPNE while not)
                    self.condition(if kind == 1 { 4 } else { 5 }, None);
                    self.b.and_i32();
                }
                self.b.if_void();
                self.check_target(target, start);
                self.retired();
                self.goto(target, index);
                self.b.block_end();
                self.retired();
            },
            Op::LoadSreg { segment, src } => {
                self.read(src, 16, inst);
                self.load_segment(segment, start);
                self.leave_unless_runnable(next);
            },
            Op::PopSreg { segment, width } => {
                let bytes = width as u64 / 8;
                self.stack_sized(0, bytes as u32, false, start);
                self.gi(HOST);
                self.load(width);
                self.load_segment(segment, start);
                self.adjust_sp(bytes);
                self.leave_unless_runnable(next);
            },
            Op::PushSreg { segment, width } => {
                self.stack_sized(-(width as i64 / 8), 2, true, start);
                self.gi(HOST);
                self.load_selector(segment);
                self.store(16);
                self.commit_sp(-(width as i64 / 8));
            },
            Op::Push16 { src } => {
                self.read(src, 16, inst);
                self.s(TV);
                self.stack_sized(-2, 2, true, start);
                self.gi(HOST);
                self.g(TV);
                self.store(16);
                self.commit_sp(-2);
            },
            Op::Pop16 { dst: Opnd::Reg(r) } => {
                self.stack_sized(0, 2, false, start);
                self.gi(HOST);
                self.load(16);
                self.s(TV);
                self.adjust_sp(2);
                self.g(TV);
                self.set_reg(r, 16);
            },
            Op::Pop16 { dst: Opnd::Mem(a) } => self.pop_memory(a, 16, inst),
            Op::Pop16 { dst: Opnd::Imm(_) } => unreachable!(),
            Op::Push32 { src } => {
                self.read(src, 32, inst);
                self.s(TV);
                self.stack_sized(-4, 4, true, start);
                self.gi(HOST);
                self.g(TV);
                self.store(32);
                self.commit_sp(-4);
            },
            Op::Pop32 { dst: Opnd::Reg(r) } => {
                self.stack_sized(0, 4, false, start);
                self.gi(HOST);
                self.load(32);
                self.s(TV);
                self.adjust_sp(4);
                self.g(TV);
                self.set_reg(r, 32);
            },
            Op::Pop32 { dst: Opnd::Mem(a) } => self.pop_memory(a, 32, inst),
            Op::Pop32 { dst: Opnd::Imm(_) } => unreachable!(),
            Op::LoadFar {
                segment,
                width,
                dst,
                address,
            } => {
                // (the offset and the selector after it, read before the
                // segment loads, which may retry: nothing changed then)
                self.read(Opnd::Mem(address), width, inst);
                self.s(TV);
                let selector = AddressExpr {
                    displacement: address.displacement.wrapping_add(width as i64 / 8),
                    ..address
                };
                self.read(Opnd::Mem(selector), 16, inst);
                self.load_segment(segment, start);
                self.g(TV);
                self.set_reg(dst, width);
                self.leave_unless_runnable(next);
            },
            Op::Enter { size } => {
                // (as enter16 at level 0: BP at SP - 2, BP = SP - 2, SP less
                // size + 2; ESP's and EBP's high halves stay)
                let bp = register(5, 16, false);
                self.stack_sized(-2, 2, true, start);
                self.gi(HOST);
                self.get_reg(bp, 16);
                self.store(16);
                self.g(4);
                self.c64(2);
                self.b.sub_i64();
                self.c64(0xFFFF);
                self.b.and_i64();
                self.s(TV);
                self.g(4);
                self.c64(0xFFFF_0000);
                self.b.and_i64();
                self.g(TV);
                self.c64(size as u64);
                self.b.sub_i64();
                self.c64(0xFFFF);
                self.b.and_i64();
                self.b.or_i64();
                self.s(4);
                self.g(TV);
                self.set_reg(bp, 16);
            },
            Op::Lods16 { width, segment } => {
                let source = AddressExpr {
                    base: AddressBase::Register(6),
                    index: None,
                    scale: 0,
                    displacement: 0,
                    address_size: 16,
                    segment,
                };
                self.address(&source, next, true);
                self.s(ADDR);
                self.host(width as u32 / 8, false, start);
                self.load(width);
                self.set_reg(register(0, width, false), width);
                // SI += the size, or with DF less it, at 16 bits
                let si = register(6, 16, false);
                self.get_reg(si, 16);
                self.b.wrap_i64_to_i32();
                self.c32(-(width as i32 / 8));
                self.c32(width as i32 / 8);
                self.gi(FL);
                self.c32(0x400);
                self.b.and_i32();
                self.b.select();
                self.b.add_i32();
                self.c32(0xFFFF);
                self.b.and_i32();
                self.b.extend_unsigned_i32_to_i64();
                self.set_reg(si, 16);
            },
            Op::PopMem { address } => self.pop_memory(address, 32, inst),
            Op::Pusha => {
                // (as cpu::misc_instr's pusha32: EAX, ECX, EDX, EBX, the
                // original ESP, EBP, ESI and EDI below ESP; the translation of
                // all 32 bytes stands for each store: all happen or none)
                self.stack_sized(-32, 32, true, start);
                for r in 0..8u8 {
                    self.gi(HOST);
                    self.c32(28 - 4 * r as i32);
                    self.b.add_i32();
                    self.get_reg(register(r, 32, false), 32);
                    self.store(32);
                }
                self.commit_sp(-32);
            },
            Op::Popa => {
                // (as popa32: EDI, ESI, EBP, ESP skipped, EBX, EDX, ECX, EAX)
                self.stack_sized(0, 32, false, start);
                for r in [7u8, 6, 5, 3, 2, 1, 0] {
                    self.gi(HOST);
                    self.c32(28 - 4 * r as i32);
                    self.b.add_i32();
                    self.load(32);
                    self.set_reg(register(r, 32, false), 32);
                }
                self.adjust_sp(32);
            },
            Op::Lods { width, segment } => {
                let source = AddressExpr {
                    base: AddressBase::Register(6),
                    index: None,
                    scale: 0,
                    displacement: 0,
                    address_size: 32,
                    segment,
                };
                self.address(&source, next, true);
                self.s(ADDR);
                self.host(width as u32 / 8, false, start);
                self.load(width);
                self.set_reg(register(0, width, false), width);
                // ESI += the size, or with DF less it
                let esi = register(6, 32, false);
                self.get_reg(esi, 32);
                self.b.wrap_i64_to_i32();
                self.c32(-(width as i32 / 8));
                self.c32(width as i32 / 8);
                self.gi(FL);
                self.c32(0x400);
                self.b.and_i32();
                self.b.select();
                self.b.add_i32();
                self.b.extend_unsigned_i32_to_i64();
                self.set_reg(esi, 32);
            },
            Op::Leave if self.env.prot16 || self.env.stack16 => {
                // (16-bit code, P7.7, or a 16-bit stack, M11: SP = BP on a
                // 16-bit stack, ESP's high half kept, else ESP = EBP; then
                // POP BP, or EBP in 32-bit code)
                let width = if self.env.prot16 { 16 } else { 32 };
                self.lookup_base = None;
                self.g(5);
                self.b.wrap_i64_to_i32();
                if self.env.stack16 {
                    self.c32(0xFFFF);
                    self.b.and_i32();
                }
                self.c32(gp::segment_offsets as i32 + 2 * 4);
                self.b.load_aligned_i32(0);
                self.b.add_i32();
                self.b.extend_unsigned_i32_to_i64();
                self.s(ADDR);
                self.host(width as u32 / 8, false, start);
                self.load(width);
                self.s(TV);
                if self.env.stack16 {
                    self.g(4);
                    self.c64(0xFFFF_0000);
                    self.b.and_i64();
                    self.g(5);
                    self.c64(width as u64 / 8);
                    self.b.add_i64();
                    self.c64(0xFFFF);
                    self.b.and_i64();
                    self.b.or_i64();
                }
                else {
                    self.g(5);
                    self.c64(width as u64 / 8);
                    self.b.add_i64();
                    self.wrap32();
                }
                self.s(4);
                self.g(TV);
                self.set_reg(register(5, width, false), width);
            },
            Op::Leave => {
                let (bytes, width) = (self.slot_bytes(), self.slot_bytes() as u8 * 8);
                self.lookup_base = Some((5, 0));
                self.g(5);
                self.segment_base(2);
                self.s(ADDR);
                self.host(bytes as u32, false, start);
                self.load(width);
                self.s(TV);
                self.g(5);
                self.c64(bytes);
                self.b.add_i64();
                if self.env.compat {
                    self.wrap32();
                }
                self.s(4);
                self.g(TV);
                self.s(5);
            },
            Op::Call { target } => {
                let (bytes, width) = (self.slot_bytes(), self.slot_bytes() as u8 * 8);
                self.check_target(target, start);
                self.stack(-(bytes as i64), true, start);
                self.gi(HOST);
                self.return_address(next);
                self.store(width);
                self.commit_sp(-(bytes as i64));
                self.retired();
                self.goto(target, index);
            },
            Op::CallIndirect { src } => {
                let (bytes, width) = (self.slot_bytes(), self.slot_bytes() as u8 * 8);
                self.read(src, width, inst);
                self.s(TV);
                self.ip_to_linear(TV);
                self.check_canonical(TV, start);
                self.stack(-(bytes as i64), true, start);
                self.gi(HOST);
                self.return_address(next);
                self.store(width);
                self.commit_sp(-(bytes as i64));
                self.retired();
                self.g(TV);
                self.s(RIP);
                self.dispatch();
            },
            Op::Ret { pop } => {
                let (bytes, width) = (self.slot_bytes(), self.slot_bytes() as u8 * 8);
                self.stack(0, false, start);
                self.gi(HOST);
                self.load(width);
                self.s(TV);
                self.ip_to_linear(TV);
                self.check_canonical(TV, start);
                self.adjust_sp(bytes + pop as u64);
                self.retired();
                self.g(TV);
                self.s(RIP);
                self.dispatch();
            },
            Op::JmpIndirect { src } => {
                let width = self.slot_bytes() as u8 * 8;
                self.read(src, width, inst);
                self.s(TV);
                self.ip_to_linear(TV);
                self.check_canonical(TV, start);
                self.retired();
                self.g(TV);
                self.s(RIP);
                self.dispatch();
            },
            Op::Jmp { target } => {
                self.check_target(target, start);
                self.retired();
                self.goto(target, index);
            },
            Op::Jcc { cc, target } => {
                self.materialize_if(inst.flags_read);
                self.condition(cc, inst.fused);
                self.b.if_void();
                self.check_target(target, start);
                self.retired();
                self.goto(target, index);
                self.b.block_end();
                self.retired();
            },
            Op::Cmov {
                cc,
                width,
                dst,
                src,
            } if self.env.i32_ops => {
                // (P4.20: without a branch, the destination written either
                // way, as a 32-bit CMOV writes it)
                self.materialize_if(inst.flags_read);
                self.read(src, width, inst);
                self.s(TV);
                if width == 32 {
                    self.g(TV);
                    self.b.wrap_i64_to_i32();
                    self.get_reg(dst, 32);
                    self.b.wrap_i64_to_i32();
                    self.condition(cc, inst.fused);
                    self.b.select();
                    self.b.extend_unsigned_i32_to_i64();
                }
                else {
                    self.g(TV);
                    self.get_reg(dst, width);
                    self.condition(cc, inst.fused);
                    self.b.select();
                }
                self.set_reg(dst, width);
            },
            Op::Cmov {
                cc,
                width,
                dst,
                src,
            } => {
                self.materialize_if(inst.flags_read);
                self.read(src, width, inst);
                self.s(TV);
                self.condition(cc, inst.fused);
                self.b.if_void();
                self.g(TV);
                self.set_reg(dst, width);
                if width == 32 {
                    self.b.else_();
                    self.get_reg(dst, 32);
                    self.set_reg(dst, 32);
                }
                self.b.block_end();
            },
            Op::Setcc { cc, dst } => {
                self.materialize_if(inst.flags_read);
                match dst {
                    Opnd::Reg(r) => {
                        self.condition(cc, inst.fused);
                        self.b.extend_unsigned_i32_to_i64();
                        self.set_reg_fitting(r, 8, true);
                    },
                    Opnd::Mem(a) => {
                        self.prepare_store(&a, 8, inst);
                        self.gi(HOST);
                        self.condition(cc, inst.fused);
                        self.b.extend_unsigned_i32_to_i64();
                        self.store(8);
                    },
                    Opnd::Imm(_) => unreachable!(),
                }
            },
            Op::Xchg { width, a, b } => {
                self.read_dst(a, width, true, inst);
                self.s(TA);
                self.get_reg(b, width);
                self.s(TB);
                self.write_dst(a, width, TB);
                self.g(TA);
                self.set_reg(b, width);
            },
            Op::Xadd { width, dst, src } => {
                self.read_dst(dst, width, true, inst);
                self.s(TA);
                self.note_last_op1(TA);
                self.get_reg(src, width);
                self.s(TB);
                self.g(TA);
                self.g(TB);
                self.b.add_i64();
                self.mask_to(width);
                self.s(TR);
                self.write_dst(dst, width, TR);
                if dst.reg() != Some(src) {
                    self.g(TA);
                    self.set_reg(src, width);
                }
                self.alu_flags(0, width, need);
                self.record(0, width, ARITH, need, inst);
            },
            Op::Cmpxchg { width, dst, src } => {
                self.read_dst(dst, width, true, inst);
                self.s(TB);
                self.get_reg(RAX, width);
                self.s(TA);
                self.note_last_op1(TA);
                self.g(TA);
                self.g(TB);
                self.b.sub_i64();
                self.mask_to(width);
                self.s(TR);
                self.g(TA);
                self.g(TB);
                self.b.eq_i64();
                self.si(COND);
                match dst {
                    Opnd::Mem(_) if inst.locked => {
                        // (unequal: the value read is written back, no change)
                        self.get_reg(src, width);
                        self.g(TB);
                        self.gi(COND);
                        self.b.select();
                        self.s(TV);
                        self.locked_store(width, TV);
                        self.gi(COND);
                        self.b.eqz_i32();
                        self.b.if_void();
                        self.g(TB);
                        self.set_reg(RAX, width);
                        self.b.block_end();
                    },
                    Opnd::Mem(_) => {
                        // the memory operand is always written
                        self.gi(HOST);
                        self.get_reg(src, width);
                        self.g(TB);
                        self.gi(COND);
                        self.b.select();
                        self.store(width);
                        self.gi(COND);
                        self.b.eqz_i32();
                        self.b.if_void();
                        self.g(TB);
                        self.set_reg(RAX, width);
                        self.b.block_end();
                    },
                    Opnd::Reg(d) => {
                        self.gi(COND);
                        self.b.if_void();
                        self.get_reg(src, width);
                        self.set_reg(d, width);
                        self.b.else_();
                        self.g(TB);
                        self.set_reg(RAX, width);
                        self.b.block_end();
                    },
                    Opnd::Imm(_) => unreachable!(),
                }
                self.alu_flags(7, width, need);
                self.record(7, width, ARITH, need, inst);
            },
            Op::SignAcc { width } => {
                self.get_reg(RAX, width / 2);
                self.sext(width / 2);
                self.set_reg(RAX, width);
            },
            Op::SignDx { width } => {
                self.c64(0);
                self.get_reg(RAX, width);
                self.c64(width as u64 - 1);
                self.b.shr_u_i64();
                self.b.sub_i64();
                self.set_reg(RDX, width);
            },
            Op::Bt {
                action,
                width,
                dst,
                index: bit,
            } => {
                let log = width.trailing_zeros() as u64;
                match dst {
                    Opnd::Reg(r) => {
                        self.get_reg(r, width);
                        self.s(TA);
                    },
                    Opnd::Mem(a) => {
                        self.address(&a, next, true);
                        if let Opnd::Reg(i) = bit {
                            // bit string: the index selects the operand
                            self.get_reg(i, width);
                            self.sext(width);
                            self.c64(log);
                            self.b.shr_s_i64();
                            self.c64(log - 3);
                            self.b.shl_i64();
                            self.b.add_i64();
                            if self.env.compat {
                                self.wrap32();
                            }
                        }
                        self.s(ADDR);
                        self.host(width as u32 / 8, action != 0, start);
                        if inst.locked {
                            self.si(HOST);
                            self.locked_load(width);
                        }
                        else {
                            self.ti(HOST);
                            self.load(width);
                        }
                        self.s(TA);
                    },
                    Opnd::Imm(_) => unreachable!(),
                }
                match bit {
                    Opnd::Imm(v) => self.c64(v & (width as u64 - 1)),
                    _ => {
                        self.read(bit, width, inst);
                        self.c64(width as u64 - 1);
                        self.b.and_i64();
                    },
                }
                self.s(TB);
                if action != 0 {
                    self.g(TA);
                    self.c64(1);
                    self.g(TB);
                    self.b.shl_i64();
                    match action {
                        1 => self.b.or_i64(),
                        2 => {
                            self.c64(u64::MAX);
                            self.b.xor_i64();
                            self.b.and_i64();
                        },
                        _ => self.b.xor_i64(),
                    }
                    self.s(TR);
                    self.write_dst(dst, width, TR);
                }
                self.flags_begin(CF);
                self.g(TA);
                self.g(TB);
                self.b.shr_u_i64();
                self.b.wrap_i64_to_i32();
                self.c32(1);
                self.b.and_i32();
                self.flags_end(false);
                self.written(CF);
            },
            Op::BitScan {
                reverse,
                width,
                dst,
                src,
            } if self.env.compat => {
                // (the 32-bit interpreter's bsf32 and kin: the destination
                // kept for a zero source; CF clear, ZF of the source, SF, PF,
                // AF and OF of the index, 0 for a zero source, as its lazy
                // record leaves them: legacy_record)
                self.read(src, width, inst);
                self.s(TA);
                self.is_zero(TA);
                self.b.if_void();
                self.c64(0);
                self.s(TR);
                self.b.else_();
                if reverse {
                    self.c64(63);
                    self.g(TA);
                    self.b.clz_i64();
                    self.b.sub_i64();
                }
                else {
                    self.g(TA);
                    self.b.ctz_i64();
                }
                self.s(TR);
                self.g(TR);
                self.set_reg(dst, width);
                self.b.block_end();
                let need = if self.env.exit_flags {
                    inst.writes & (inst.live_out | inst.exit_live)
                }
                else {
                    inst.writes
                };
                let lazy = need & (SF | PF | AF | OF);
                if need & (CF | ZF) != 0 {
                    self.flags_begin(need & (CF | ZF));
                    if need & ZF != 0 {
                        self.is_zero(TA);
                        self.c32(6);
                        self.b.shl_i32();
                    }
                    self.flags_end(need & ZF == 0);
                }
                if lazy != 0 {
                    self.legacy_record(width, lazy);
                }
                self.written(inst.writes & !lazy);
            },
            Op::BitScan {
                reverse,
                width,
                dst,
                src,
            } => {
                self.read(src, width, inst);
                self.s(TA);
                self.is_zero(TA);
                self.b.if_void();
                self.gi(FL);
                self.c32(ZF as i32);
                self.b.or_i32();
                self.si(FL);
                self.b.else_();
                if reverse {
                    self.c64(63);
                    self.g(TA);
                    self.b.clz_i64();
                    self.b.sub_i64();
                }
                else {
                    self.g(TA);
                    self.b.ctz_i64();
                }
                self.set_reg(dst, width);
                self.gi(FL);
                self.c32(!ZF as i32);
                self.b.and_i32();
                self.si(FL);
                self.b.block_end();
                self.written(ZF);
            },
            Op::Popcnt { width, dst, src } => {
                self.read(src, width, inst);
                self.s(TA);
                self.g(TA);
                self.b.popcnt_i64();
                self.set_reg(dst, width);
                self.flags_begin(ARITH);
                self.is_zero(TA);
                self.c32(6);
                self.b.shl_i32();
                self.flags_end(false);
                self.written(ARITH);
            },
            Op::Bswap { width, reg } => {
                self.g(reg as usize);
                self.byte_swap(width);
                self.s(reg as usize);
            },
            Op::Vfused {
                op,
                double,
                dst,
                first,
                src,
            } => {
                self.vector_check(inst, start);
                let mut operands = pagegen_vec::Operands {
                    e: self,
                    inst,
                    start,
                    dst,
                    first,
                    src,
                };
                crate::x86tpl::ops::fused(&mut operands, op, double);
                self.vex_upper(inst, dst);
            },
            Op::Movbe {
                load,
                width,
                reg,
                mem,
            } => {
                if load {
                    self.read(Opnd::Mem(mem), width, inst);
                    self.byte_swap(width);
                    self.set_reg(reg, width);
                }
                else {
                    self.prepare_store(&mem, width, inst);
                    self.gi(HOST);
                    self.get_reg(reg, width);
                    self.byte_swap(width);
                    self.store(width);
                }
            },
            Op::Bmi {
                op: BmiOp::Andn,
                width,
                dst,
                src,
                other,
            } => {
                // AND's flags, of NOT VEX.vvvv (TA) and the source (TB)
                self.read(src, width, inst);
                self.s(TB);
                self.get_reg(other, width);
                self.c64(mask(width));
                self.b.xor_i64();
                self.s(TA);
                self.g(TA);
                self.g(TB);
                self.b.and_i64();
                self.s(TR);
                self.g(TR);
                self.set_reg(dst, width);
                self.alu_flags(4, width, need);
                self.record(4, width, ARITH, need, inst);
            },
            Op::Bmi {
                op: op @ (BmiOp::Shlx | BmiOp::Shrx | BmiOp::Sarx),
                width,
                dst,
                src,
                other,
            } => {
                // (Wasm takes the count modulo the operand size, as these)
                self.read(src, width, inst);
                if width == 64 {
                    self.get_reg(other, 64);
                    match op {
                        BmiOp::Shlx => self.b.shl_i64(),
                        BmiOp::Shrx => self.b.shr_u_i64(),
                        _ => self.b.shr_s_i64(),
                    }
                }
                else {
                    self.b.wrap_i64_to_i32();
                    self.get_reg(other, 32);
                    self.b.wrap_i64_to_i32();
                    match op {
                        BmiOp::Shlx => self.b.shl_i32(),
                        BmiOp::Shrx => self.b.shr_u_i32(),
                        _ => self.b.shr_s_i32(),
                    }
                    self.b.extend_unsigned_i32_to_i64();
                }
                self.set_reg(dst, width);
            },
            Op::Bmi {
                op: BmiOp::Rorx(count),
                width,
                dst,
                src,
                ..
            } => {
                // (the count modulo the operand size; no flags)
                self.read(src, width, inst);
                if width == 64 {
                    self.c64(count as u64 & 63);
                    self.b.rotr_i64();
                }
                else {
                    self.b.wrap_i64_to_i32();
                    self.c32(count as i32 & 31);
                    self.b.rotr_i32();
                    self.b.extend_unsigned_i32_to_i64();
                }
                self.set_reg(dst, width);
            },
            Op::Bmi {
                op,
                width,
                dst,
                src,
                other,
            } => {
                // the source TA; BZHI's index TB
                self.read(src, width, inst);
                self.s(TA);
                match op {
                    BmiOp::Blsr | BmiOp::Blsmsk => {
                        self.g(TA);
                        self.c64(1);
                        self.b.sub_i64();
                        self.g(TA);
                        if op == BmiOp::Blsr {
                            self.b.and_i64();
                        }
                        else {
                            self.b.xor_i64();
                        }
                        self.mask_to(width);
                    },
                    BmiOp::Blsi => {
                        self.c64(0);
                        self.g(TA);
                        self.b.sub_i64();
                        self.g(TA);
                        self.b.and_i64();
                    },
                    BmiOp::Bzhi => {
                        // TA AND (1 << n) - 1 for an index n below the
                        // operand size, else TA
                        self.get_reg(other, width);
                        self.c64(0xFF);
                        self.b.and_i64();
                        self.s(TB);
                        self.g(TA);
                        self.c64(1);
                        self.g(TB);
                        self.b.shl_i64();
                        self.c64(1);
                        self.b.sub_i64();
                        self.b.and_i64();
                        self.g(TA);
                        self.g(TB);
                        self.c64(width as u64);
                        self.b.ltu_i64();
                        self.b.select();
                    },
                    // (Wasm's count of a zero operand is its size, as theirs)
                    _ if width == 64 => {
                        self.g(TA);
                        if op == BmiOp::Tzcnt {
                            self.b.ctz_i64();
                        }
                        else {
                            self.b.clz_i64();
                        }
                    },
                    _ => {
                        self.g(TA);
                        self.b.wrap_i64_to_i32();
                        if op == BmiOp::Tzcnt {
                            self.b.ctz_i32();
                        }
                        else {
                            self.b.clz_i32();
                        }
                        self.b.extend_unsigned_i32_to_i64();
                    },
                }
                self.s(TR);
                self.g(TR);
                self.set_reg(dst, width);
                self.bmi_flags(width, need, inst, |e| match op {
                    // CF: the source is not 0 (BLSI), the index is beyond
                    // the operand size (BZHI), else the source is 0
                    BmiOp::Blsi => {
                        e.is_zero(TA);
                        e.b.eqz_i32();
                    },
                    BmiOp::Bzhi => {
                        e.g(TB);
                        e.c64(width as u64 - 1);
                        e.b.gtu_i64();
                    },
                    _ => e.is_zero(TA),
                });
            },
            Op::Flag { opcode } => {
                self.materialize_if(inst.flags_read);
                self.gi(FL);
                match opcode {
                    0xF5 => {
                        self.c32(CF as i32);
                        self.b.xor_i32();
                    },
                    0xF8 => {
                        self.c32(!CF as i32);
                        self.b.and_i32();
                    },
                    0xF9 => {
                        self.c32(CF as i32);
                        self.b.or_i32();
                    },
                    0xFC => {
                        self.c32(!0x400);
                        self.b.and_i32();
                    },
                    _ => {
                        self.c32(0x400);
                        self.b.or_i32();
                    },
                }
                self.si(FL);
                self.written(inst.writes);
            },
            Op::Cli | Op::Sti | Op::StiShadowed => {
                // #GP unless CPL <= IOPL
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.gi(FL);
                self.c32(12);
                self.b.shr_u_i32();
                self.c32(3);
                self.b.and_i32();
                self.b.gtu_i32();
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                self.gi(FL);
                if matches!(inst.op, Op::Cli) {
                    self.c32(!0x200);
                    self.b.and_i32();
                    self.si(FL);
                }
                else if matches!(inst.op, Op::StiShadowed) {
                    // (the shadow instruction follows; End::Shadow checks)
                    self.c32(0x200);
                    self.b.or_i32();
                    self.si(FL);
                }
                else {
                    self.c32(0x200);
                    self.b.or_i32();
                    self.si(FL);
                    // as after the interpreter retired STI: one shadow instruction left
                    self.c32(gp::interrupt_shadow as i32);
                    self.c32(1);
                    self.b.store_u8(0);
                    self.retired();
                    self.leave_to(self.f().exit, next);
                }
            },
            Op::Swapgs => {
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                let (low, high) = (
                    gp::segment_offsets as u32 + 20,
                    gp::x64_segment_base_hi as u32 + 20,
                );
                self.load_pair(low, high);
                self.s(TV);
                self.c32(gp::x64_kernel_gs_base as i32);
                self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
                self.s(TX);
                self.store_pair(low, high, TX);
                self.c32(gp::x64_kernel_gs_base as i32);
                self.g(TV);
                self.b.store_aligned_i64(0);
            },
            Op::Rdtsc => {
                // #GP at CPL > 0 with CR4.TSD
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.c32(0);
                self.b.ne_i32();
                self.b.load_fixed_i32(gp::cr as u32 + 16);
                self.c32(2);
                self.b.shr_u_i32();
                self.c32(1);
                self.b.and_i32();
                self.b.and_i32();
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                self.b
                    .call_signature("x64_page_rdtsc", Signature::new(&[], &[WasmType::I64]));
                self.s(TV);
                self.g(TV);
                self.set_reg(RAX, 32);
                self.g(TV);
                self.c64(32);
                self.b.shr_u_i64();
                self.set_reg(RDX, 32);
            },
            Op::Div { signed, width, src } => self.divide(inst, signed, width, src),
            Op::RepCompare { width, scan, equal } => self.rep_compare(inst, width, scan, equal),
            Op::Movs { width, rep } | Op::Stos { width, rep } => {
                self.string(inst, matches!(inst.op, Op::Movs { .. }), width, rep)
            },
            Op::MovSreg {
                segment,
                width,
                dst,
            } => match dst {
                Opnd::Mem(a) => {
                    self.prepare_store(&a, 16, inst);
                    self.gi(HOST);
                    self.load_selector(segment);
                    self.store(16);
                },
                Opnd::Reg(r) => {
                    self.load_selector(segment);
                    self.set_reg(r, width);
                },
                Opnd::Imm(_) => unreachable!(),
            },
            Op::Mmx { form } => self.mmx(inst, form, start),
            Op::DoubleShiftCl { left, dst, src } => {
                // (as Op::DoubleShift in compatibility mode, by CL & 31: a
                // zero count keeps the destination, written back as the
                // interpreter writes it, and every flag, made current first)
                self.materialize_if(inst.flags_read);
                self.read_dst(dst, 32, true, inst);
                self.s(TA);
                self.g(1);
                self.c64(31);
                self.b.and_i64();
                self.s(TB);
                self.g(TA);
                self.s(TR);
                self.is_zero(TB);
                self.b.eqz_i32();
                self.b.if_void();
                {
                    self.get_reg(src, 32);
                    self.s(TC);
                    self.g(TA);
                    self.g(TB);
                    if left {
                        self.b.shl_i64()
                    }
                    else {
                        self.b.shr_u_i64()
                    }
                    self.g(TC);
                    self.c64(32);
                    self.g(TB);
                    self.b.sub_i64();
                    if left {
                        self.b.shr_u_i64()
                    }
                    else {
                        self.b.shl_i64()
                    }
                    self.b.or_i64();
                    self.mask_to(32);
                    self.s(TR);
                    let need = inst.writes;
                    let lazy = if self.env.exit_flags {
                        need & (SF | ZF | PF | AF) & !inst.live_out
                    }
                    else {
                        0
                    };
                    let eager = need & !lazy;
                    self.flags_begin(eager);
                    // CF: the last bit shifted out of the destination
                    self.g(TA);
                    if left {
                        self.c64(32);
                        self.g(TB);
                        self.b.sub_i64();
                    }
                    else {
                        self.g(TB);
                        self.c64(1);
                        self.b.sub_i64();
                    }
                    self.b.shr_u_i64();
                    self.b.wrap_i64_to_i32();
                    self.c32(1);
                    self.b.and_i32();
                    self.b.or_i32();
                    // OF: the sign change, for SHLD by 1 only
                    self.g(TA);
                    self.g(TR);
                    self.b.xor_i64();
                    self.c64(31);
                    self.b.shr_u_i64();
                    self.b.wrap_i64_to_i32();
                    self.c32(1);
                    self.b.and_i32();
                    if left {
                        self.g(TB);
                        self.c64(1);
                        self.b.eq_i64();
                        self.b.and_i32();
                    }
                    self.c32(11);
                    self.b.shl_i32();
                    self.b.or_i32();
                    // (CF and OF are in the base now: the terms start over)
                    let mut first = true;
                    self.szp(TR, eager, 32, &mut first);
                    if eager & AF != 0 {
                        self.legacy_af();
                        self.join(&mut first);
                    }
                    self.flags_end(first);
                    if lazy != 0 {
                        self.legacy_record(32, lazy);
                    }
                    self.written(inst.writes & !lazy);
                }
                self.b.block_end();
                self.write_dst(dst, 32, TR);
            },
            Op::DoubleShift {
                left,
                width: 32,
                dst,
                src,
                count,
            } if self.env.compat => {
                // (the 32-bit interpreter's shld32 and shrd32: CF the last
                // bit shifted out, OF for SHLD by 1 the sign change, else
                // clear, for SHRD by any count; SF, ZF, PF and AF of the
                // result as its lazy record leaves them; a zero count keeps
                // every flag)
                let count = shift_count(32, count) as u64;
                self.read_dst(dst, 32, true, inst);
                self.s(TA);
                if count == 0 {
                    self.write_dst(dst, 32, TA);
                }
                else {
                    self.get_reg(src, 32);
                    self.s(TB);
                    self.g(TA);
                    self.c64(count);
                    if left {
                        self.b.shl_i64()
                    }
                    else {
                        self.b.shr_u_i64()
                    }
                    self.g(TB);
                    self.c64(32 - count);
                    if left {
                        self.b.shr_u_i64()
                    }
                    else {
                        self.b.shl_i64()
                    }
                    self.b.or_i64();
                    self.mask_to(32);
                    self.s(TR);
                    self.write_dst(dst, 32, TR);
                    let need = if self.env.exit_flags {
                        inst.writes & (inst.live_out | inst.exit_live)
                    }
                    else {
                        inst.writes
                    };
                    let lazy = need & (SF | ZF | PF | AF) & !inst.live_out;
                    let eager = need & !lazy;
                    self.flags_begin(eager);
                    let mut first = true;
                    if eager & CF != 0 {
                        self.bit_of(
                            TA,
                            if left { (32 - count) as u8 } else { (count - 1) as u8 },
                            0,
                        );
                        self.join(&mut first);
                    }
                    if eager & OF != 0 && (!left || count == 1) {
                        self.g(TA);
                        self.g(TR);
                        self.b.xor_i64();
                        self.s(TX);
                        self.bit_of(TX, 31, 11);
                        self.join(&mut first);
                    }
                    self.szp(TR, eager, 32, &mut first);
                    if eager & AF != 0 {
                        self.legacy_af();
                        self.join(&mut first);
                    }
                    self.flags_end(first);
                    if lazy != 0 {
                        self.legacy_record(32, lazy);
                    }
                    self.written(inst.writes & !lazy);
                }
            },
            Op::DoubleShift {
                left,
                width,
                dst,
                src,
                count,
            } => {
                let count = shift_count(width, count) as u64;
                let w = width as u64;
                self.read_dst(dst, width, true, inst);
                self.s(TA);
                if count == 0 {
                    self.write_dst(dst, width, TA);
                }
                else {
                    self.get_reg(src, width);
                    self.s(TB);
                    self.g(TA);
                    self.c64(if left { count } else { count });
                    if left {
                        self.b.shl_i64()
                    }
                    else {
                        self.b.shr_u_i64()
                    }
                    self.g(TB);
                    self.c64(w - count);
                    if left {
                        self.b.shr_u_i64()
                    }
                    else {
                        self.b.shl_i64()
                    }
                    self.b.or_i64();
                    self.mask_to(width);
                    self.s(TR);
                    self.write_dst(dst, width, TR);
                    let writes = inst.writes;
                    self.flags_begin(writes);
                    let mut first = true;
                    self.bit_of(
                        TA,
                        if left { (w - count) as u8 } else { (count - 1) as u8 },
                        0,
                    );
                    self.join(&mut first);
                    self.szp(TR, writes, width, &mut first);
                    if count == 1 {
                        self.g(TA);
                        self.g(TR);
                        self.b.xor_i64();
                        self.s(TX);
                        self.bit_of(TX, width - 1, 11);
                        self.join(&mut first);
                    }
                    self.flags_end(first);
                    self.written(writes);
                }
            },
            Op::CompareExchange { wide, address } => self.compare_exchange(inst, wide, &address),
            Op::Vmove {
                bits,
                dst,
                src,
                aligned,
                zero,
                upper,
            } => {
                self.vector_check(inst, start);
                match (dst, src) {
                    (Xmm::Reg(d), Xmm::Reg(s)) if bits == 128 && self.env.xmm_locals => {
                        self.xv_push(s);
                        self.xv_pop(d);
                    },
                    // (XMM locals: the scalar moves as v128 values, no lane
                    // through a general register)
                    (Xmm::Reg(d), Xmm::Reg(s)) if bits < 128 && self.env.xmm_locals => {
                        // the low bits of s; the others zero, or from the
                        // destination or VEX.vvvv
                        self.xv_push(s);
                        if zero {
                            self.b.simd_zero();
                        }
                        else {
                            self.xv_push(upper.unwrap_or(d));
                        }
                        self.b.simd_shuffle(low_lanes(bits / 8));
                        self.xv_pop(d);
                    },
                    (Xmm::Reg(d), Xmm::Mem(a)) if bits < 128 && self.env.xmm_locals => {
                        self.vector_address(&a, bits, aligned, false, inst);
                        self.load_scalar_v128(bits);
                        self.xv_pop(d);
                    },
                    (Xmm::Reg(d), Xmm::Reg(s)) => {
                        self.xmm_load(s, 0, bits.min(64));
                        if let Some(first) = upper.filter(|&first| first != d) {
                            // (VMOVSS/VMOVSD: the other bits from VEX.vvvv)
                            self.s(TB);
                            self.xmm_copy(first, d);
                            self.g(TB);
                        }
                        self.xmm_store(d, 0, bits.min(64), !zero && bits == 32);
                        if bits == 128 {
                            self.xmm_load(s, 8, 64);
                            self.xmm_store(d, 8, 64, false);
                        }
                        else if zero {
                            self.clear_upper(d, bits);
                        }
                    },
                    // (XMM locals, P4.17: whole v128 accesses, no lanes)
                    (Xmm::Reg(d), Xmm::Mem(a)) if bits == 128 && self.env.xmm_locals => {
                        self.vector_address(&a, bits, aligned, false, inst);
                        self.gi(HOST);
                        let scratch = self.b.set_new_local();
                        self.b.get_local(&scratch);
                        self.b.guest_load_v128(&scratch);
                        self.b.free_local(scratch);
                        self.xv_pop(d);
                    },
                    (Xmm::Mem(a), Xmm::Reg(s)) if bits == 128 && self.env.xmm_locals => {
                        self.vector_address(&a, bits, aligned, true, inst);
                        self.xv_push(s);
                        let value = self.b.set_new_local_v128();
                        self.gi(HOST);
                        let address = self.b.set_new_local();
                        self.b.guest_store_v128(&address, &value);
                        self.b.free_local(address);
                        self.b.free_local_v128(value);
                    },
                    (Xmm::Reg(d), Xmm::Mem(a)) => {
                        self.vector_address(&a, bits, aligned, false, inst);
                        for half in 0..(bits as u32).div_ceil(64) {
                            self.gi(HOST);
                            self.load_bits(bits.min(64), half * 8);
                            self.xmm_store(d, half * 8, bits.min(64), bits == 32);
                        }
                        if bits < 128 {
                            self.clear_upper(d, bits);
                        }
                    },
                    (Xmm::Mem(a), Xmm::Reg(s)) => {
                        self.vector_address(&a, bits, aligned, true, inst);
                        for half in 0..(bits as u32).div_ceil(64) {
                            self.gi(HOST);
                            self.xmm_load(s, half * 8, bits.min(64));
                            self.b
                                .guest_store_i64_bits(if bits == 32 { 32 } else { 64 }, half * 8);
                        }
                    },
                    (Xmm::Mem(_), Xmm::Mem(_)) => unreachable!(),
                }
                if let Xmm::Reg(d) = dst {
                    self.vex_upper(inst, d);
                }
            },
            Op::Vlogic {
                code,
                dst,
                first,
                src,
            } => {
                self.vector_check(inst, start);
                if !self.env.xmm_locals {
                    self.vlogic_halves(inst, code, dst, first, src);
                    return;
                }
                // (the sources read before the destination is written)
                self.vector_source(src, inst);
                let source = self.b.set_new_local_v128();
                if code == 1 {
                    // ANDN: ~first & src, v128.andnot(src, first)
                    self.b.get_local_v128(&source);
                    self.xv_push(first);
                }
                else {
                    self.xv_push(first);
                    self.b.get_local_v128(&source);
                }
                self.b.simd(match code {
                    0 => 0x4E, // v128.and
                    1 => 0x4F, // v128.andnot
                    2 => 0x50, // v128.or
                    _ => 0x51, // v128.xor
                });
                self.xv_pop(dst);
                self.b.free_local_v128(source);
                self.vex_upper(inst, dst);
            },
            Op::Vfp {
                code,
                double,
                packed,
                dst,
                first,
                src,
            } if self.env.sse_fast_check => {
                self.vector_check(inst, start);
                let mut operands = pagegen_vec::Operands {
                    e: self,
                    inst,
                    start,
                    dst,
                    first,
                    src,
                };
                crate::x86tpl::ops::float(&mut operands, code, double, !packed);
                self.vex_upper(inst, dst);
            },
            Op::Vfp {
                code,
                double,
                packed,
                dst,
                first,
                src,
            } => self.vfp(inst, start, code, double, packed, dst, first, src),
            Op::Vpacked {
                op,
                dst,
                first,
                src,
            } => {
                self.vector_check(inst, start);
                self.vector_source(src, inst);
                let source = self.b.set_new_local_v128();
                self.xv_push(first);
                let destination = self.b.set_new_local_v128();
                if self.env.xmm_locals {
                    vec::packed(&mut self.b, op, &destination, &source, 16);
                    self.xv_pop(dst);
                }
                else {
                    self.c32(Self::xmm(dst) as i32);
                    vec::packed(&mut self.b, op, &destination, &source, 16);
                    self.b.simd_memory(0x0B, 0);
                }
                self.b.free_local_v128(source);
                self.b.free_local_v128(destination);
                self.vex_upper(inst, dst);
            },
            Op::VshiftImm {
                dst,
                src,
                bits,
                kind,
                count,
                wide,
            } => {
                self.vector_check(inst, start);
                // (a VEX.256 form: each half alike, the low one first; a
                // half is read before the same half is written)
                let halves: &[u32] = if wide {
                    self.ymm_zeroed &= !(1 << dst);
                    &[0, 16]
                }
                else if self.env.xmm_locals {
                    self.xv_push(src);
                    shift_immediate(&mut self.b, bits, kind, count);
                    self.xv_pop(dst);
                    &[]
                }
                else {
                    &[0]
                };
                for offset in halves {
                    self.c32(Self::ymm(dst, *offset) as i32);
                    self.c32(Self::ymm(src, *offset) as i32);
                    self.b.simd_memory(0x00, 0);
                    shift_immediate(&mut self.b, bits, kind, count);
                    self.b.simd_memory(0x0B, 0);
                }
                if !wide {
                    self.vex_upper(inst, dst);
                }
            },
            Op::Vcompare { double, dst, src } => self.vcompare(inst, start, double, dst, src),
            Op::Vround {
                double,
                scalar,
                imm8,
                dst,
                first,
                src,
            } => self.vround(inst, start, double, scalar, imm8, dst, first, src),
            Op::Vzeroupper => {
                self.vector_check(inst, start);
                let mut operands = pagegen_vec::Operands {
                    e: self,
                    inst,
                    start,
                    dst: 0,
                    first: 0,
                    src: Xmm::Reg(0),
                };
                crate::x86tpl::ops::zero_upper(&mut operands);
            },
            Op::Vmove256 { dst, src, aligned } => {
                self.vector_check(inst, start);
                // (a register destination loads, a memory one stores)
                let (dst, first, src, load) = match (dst, src) {
                    (Xmm::Reg(d), src) => (d, d, src, true),
                    (Xmm::Mem(a), Xmm::Reg(s)) => (s, s, Xmm::Mem(a), false),
                    (Xmm::Mem(_), Xmm::Mem(_)) => unreachable!(),
                };
                let mut operands = pagegen_vec::Operands {
                    e: self,
                    inst,
                    start,
                    dst,
                    first,
                    src,
                };
                if load {
                    crate::x86tpl::ops::load256(&mut operands, aligned);
                }
                else {
                    crate::x86tpl::ops::store256(&mut operands, aligned);
                }
            },
            Op::Vpacked256 {
                op,
                dst,
                first,
                src,
            } => {
                self.vector_check(inst, start);
                let mut operands = pagegen_vec::Operands {
                    e: self,
                    inst,
                    start,
                    dst,
                    first,
                    src,
                };
                crate::x86tpl::ops::packed256(&mut operands, op);
            },
            Op::Vinsert128 {
                dst,
                first,
                src,
                high,
            } => {
                self.vector_check(inst, start);
                self.ymm_zeroed &= !(1 << dst);
                // (the inserted 128 bits and the kept half before any write)
                self.vector_source(src, inst);
                let inserted = self.b.set_new_local_v128();
                let (kept, replaced) = if high { (0, 16) } else { (16, 0) };
                self.c32(Self::ymm(first, kept) as i32);
                self.b.simd_memory(0x00, 0);
                let other = self.b.set_new_local_v128();
                self.c32(Self::ymm(dst, kept) as i32);
                self.b.get_local_v128(&other);
                self.b.simd_memory(0x0B, 0);
                self.c32(Self::ymm(dst, replaced) as i32);
                self.b.get_local_v128(&inserted);
                self.b.simd_memory(0x0B, 0);
                self.b.free_local_v128(other);
                self.b.free_local_v128(inserted);
            },
            Op::Vperm2 {
                dst,
                first,
                src,
                imm8,
            } => {
                self.vector_check(inst, start);
                self.ymm_zeroed &= !(1 << dst);
                // (the four halves, VEX.vvvv's then ymm/m256's, before any write)
                let mut halves = Vec::new();
                for offset in [0, 16] {
                    self.c32(Self::ymm(first, offset) as i32);
                    self.b.simd_memory(0x00, 0);
                    halves.push(self.b.set_new_local_v128());
                }
                match src {
                    Xmm::Reg(s) => {
                        for offset in [0, 16] {
                            self.c32(Self::ymm(s, offset) as i32);
                            self.b.simd_memory(0x00, 0);
                            halves.push(self.b.set_new_local_v128());
                        }
                    },
                    Xmm::Mem(a) => {
                        self.vector_address_bytes(&a, 32, false, false, inst);
                        for offset in [0, 16] {
                            self.gi(HOST);
                            self.c32(offset);
                            self.b.add_i32();
                            let scratch = self.b.set_new_local();
                            self.b.get_local(&scratch);
                            self.b.guest_load_v128(&scratch);
                            self.b.free_local(scratch);
                            halves.push(self.b.set_new_local_v128());
                        }
                    },
                }
                for (k, offset) in [0, 16].into_iter().enumerate() {
                    self.c32(Self::ymm(dst, offset) as i32);
                    let selector = imm8 >> (4 * k) & 15;
                    if selector & 8 != 0 {
                        self.b.simd_zero();
                    }
                    else {
                        self.b.get_local_v128(&halves[selector as usize & 3]);
                    }
                    self.b.simd_memory(0x0B, 0);
                }
                for v in halves {
                    self.b.free_local_v128(v);
                }
            },
            Op::Vmovmsk256 { dst, src, lane } => {
                self.vector_check(inst, start);
                let mut operands = pagegen_vec::Operands {
                    e: self,
                    inst,
                    start,
                    dst: dst.index,
                    first: dst.index,
                    src: Xmm::Reg(src),
                };
                crate::x86tpl::ops::move_mask256(&mut operands, lane);
            },
            Op::Vbroadcast {
                bytes,
                dst,
                src,
                wide,
            } => {
                self.vector_check(inst, start);
                let mut operands = pagegen_vec::Operands {
                    e: self,
                    inst,
                    start,
                    dst,
                    first: dst,
                    src,
                };
                crate::x86tpl::ops::broadcast(&mut operands, bytes, wide);
                if !wide {
                    self.vex_upper(inst, dst);
                }
            },
            Op::Vzeroall => {
                self.vector_check(inst, start);
                let mut operands = pagegen_vec::Operands {
                    e: self,
                    inst,
                    start,
                    dst: 0,
                    first: 0,
                    src: Xmm::Reg(0),
                };
                crate::x86tpl::ops::zero_all(&mut operands);
            },
            Op::Vmovmsk { dst, src, lane } => {
                self.vector_check(inst, start);
                let mut operands = pagegen_vec::Operands {
                    e: self,
                    inst,
                    start,
                    dst: dst.index,
                    first: dst.index,
                    src: Xmm::Reg(src),
                };
                crate::x86tpl::ops::move_mask(&mut operands, lane);
            },
            Op::Vcmp {
                double,
                scalar,
                predicate,
                dst,
                first,
                src,
            } => self.vcmp(inst, start, double, scalar, predicate, dst, first, src),
            Op::Vblendv {
                lane,
                dst,
                first,
                src,
                mask,
            } => {
                self.vector_check(inst, start);
                let mut operands = pagegen_vec::Operands {
                    e: self,
                    inst,
                    start,
                    dst,
                    first,
                    src,
                };
                crate::x86tpl::ops::blend_variable(&mut operands, lane, mask);
                self.vex_upper(inst, dst);
            },
            Op::Vcvt { op, dst, src } => self.vcvt(inst, start, op, dst, src),
            Op::Vconvert {
                convert,
                dst,
                first,
            } => self.vconvert(inst, start, convert, dst, first),
            Op::Vstrings {
                op,
                imm8,
                wide,
                dst,
                src,
            } => {
                self.vector_check(inst, start);
                // the source first (a fault leaves nothing written); an
                // unaligned m128 is fine (the SDM's exception type 4 note)
                match src {
                    Xmm::Reg(s) => {
                        self.c32(Self::xmm(s) as i32);
                        self.b.simd_memory(0x00, 0);
                    },
                    Xmm::Mem(a) => {
                        self.vector_address(&a, 128, false, false, inst);
                        self.gi(HOST);
                        let scratch = self.b.set_new_local();
                        self.b.get_local(&scratch);
                        self.b.guest_load_v128(&scratch);
                        self.b.free_local(scratch);
                    },
                }
                let source = self.b.set_new_local_v128();
                let operands = super::helpers::sse_fp_operands() as i32;
                self.c32(operands + 16);
                self.b.get_local_v128(&source);
                self.b.simd_memory(0x0B, 0);
                self.c32(operands);
                self.c32(Self::xmm(dst) as i32);
                self.b.simd_memory(0x00, 0);
                self.b.simd_memory(0x0B, 0);
                self.c32(op as i32);
                self.c32(imm8 as i32);
                for r in [0, 2] {
                    self.g(r);
                    if !wide {
                        self.b.wrap_i64_to_i32();
                        self.b.extend_signed_i32_to_i64();
                    }
                }
                self.b.call_signature(
                    "x64_page_pcmpstr",
                    Signature::new(
                        &[WasmType::I32, WasmType::I32, WasmType::I64, WasmType::I64],
                        &[WasmType::I32],
                    ),
                );
                let result = self.b.set_new_local();
                if op & 1 != 0 {
                    self.b.get_local(&result);
                    self.c32(0xFF);
                    self.b.and_i32();
                    self.b.extend_unsigned_i32_to_i64();
                    self.set_reg(
                        Reg {
                            index: 1,
                            high: false,
                        },
                        32,
                    );
                }
                else {
                    self.c32(Self::xmm(0) as i32);
                    self.c32(operands);
                    self.b.simd_memory(0x00, 0);
                    self.b.simd_memory(0x0B, 0);
                    self.vex_upper(inst, 0);
                }
                self.flags_begin(ARITH);
                self.b.get_local(&result);
                self.c32(8);
                self.b.shr_u_i32();
                self.flags_end(false);
                self.written(ARITH);
                self.b.free_local(result);
                self.b.free_local_v128(source);
            },
            Op::Invlpg { address } => {
                // CPL > 0 is #GP (retried)
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                self.address(&address, next, true);
                self.b.call_signature(
                    "x64_page_invlpg",
                    Signature::new(&[WasmType::I64], &[WasmType::I32]),
                );
                self.b.if_void();
                self.retired();
                self.leave_to(self.f().exit, next);
                self.b.block_end();
                // (P4.21: the page's translation may be one the function
                // keeps)
                for kept in &self.lookup_kept {
                    kept.tag.forget(&mut self.b);
                }
            },
            Op::Mxcsr { load, address } => {
                self.vector_check(inst, start);
                if load {
                    self.address(&address, next, true);
                    self.s(ADDR);
                    self.host(4, false, start);
                    self.load(32);
                    self.b.wrap_i64_to_i32();
                    self.si(ST);
                    // reserved bits: #GP in the interpreter
                    self.gi(ST);
                    self.c32(!crate::cpu::cpu::MXCSR_MASK);
                    self.b.and_i32();
                    self.b.if_void();
                    self.leave_to(self.f().retry, start);
                    self.b.block_end();
                    self.c32(gp::mxcsr as i32);
                    self.gi(ST);
                    self.b.store_aligned_i32(0);
                    if let Some(local) = self.fp_mxcsr.take() {
                        self.b.free_local(local);
                    }
                }
                else {
                    self.address(&address, next, true);
                    self.s(ADDR);
                    self.host(4, true, start);
                    self.b.load_fixed_i32(gp::mxcsr as u32);
                    self.b.extend_unsigned_i32_to_i64();
                    self.store(32);
                }
            },
            Op::MovdIn { width, dst, src } => {
                self.vector_check(inst, start);
                self.read(src, width, inst);
                self.xmm_store(dst, 0, 64, false);
                self.clear_upper(dst, 64);
                self.vex_upper(inst, dst);
            },
            Op::MovdOut { width, dst, src } => {
                self.vector_check(inst, start);
                match dst {
                    Opnd::Reg(r) => {
                        self.xmm_load(src, 0, width);
                        self.set_reg(r, width);
                    },
                    Opnd::Mem(a) => {
                        self.prepare_store(&a, width, inst);
                        self.gi(HOST);
                        self.xmm_load(src, 0, width);
                        self.store(width);
                    },
                    Opnd::Imm(_) => unreachable!(),
                }
            },
            Op::ReadCr { control, reg } => {
                // CPL > 0 is #GP (retried)
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                self.load_pair(
                    gp::cr as u32 + 4 * control as u32,
                    gp::x64_cr_hi as u32 + 4 * control as u32,
                );
                self.set_reg(reg, 64);
            },
            Op::Cr8 { write, reg } => {
                // CPL > 0 is #GP (retried)
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                if write {
                    self.get_reg(reg, 64);
                    self.b.call_signature(
                        "x64_page_set_cr8",
                        Signature::new(&[WasmType::I64], &[WasmType::I32]),
                    );
                    self.ti(ST);
                    self.c32(1);
                    self.b.eq_i32();
                    self.b.if_void();
                    self.leave_to(self.f().retry, start);
                    self.b.block_end();
                    // an interrupt the lower priority unmasks is taken after this instruction
                    self.gi(ST);
                    self.c32(2);
                    self.b.eq_i32();
                    self.b.if_void();
                    self.retired();
                    self.leave_to(self.f().exit, next);
                    self.b.block_end();
                }
                else {
                    self.b
                        .call_signature("x64_page_cr8", Signature::new(&[], &[WasmType::I64]));
                    self.set_reg(reg, 64);
                }
            },
            Op::Rdtscp => {
                // #GP at CPL > 0 with CR4.TSD, as RDTSC
                self.c32(gp::cpl as i32);
                self.b.load_u8(0);
                self.c32(0);
                self.b.ne_i32();
                self.b.load_fixed_i32(gp::cr as u32 + 16);
                self.c32(2);
                self.b.shr_u_i32();
                self.c32(1);
                self.b.and_i32();
                self.b.and_i32();
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                self.b
                    .call_signature("x64_page_rdtsc", Signature::new(&[], &[WasmType::I64]));
                self.s(TV);
                self.g(TV);
                self.set_reg(RAX, 32);
                self.g(TV);
                self.c64(32);
                self.b.shr_u_i64();
                self.set_reg(RDX, 32);
                self.b.load_fixed_i32(gp::x64_tsc_aux as u32);
                self.b.extend_unsigned_i32_to_i64();
                self.set_reg(
                    Reg {
                        index: 1,
                        high: false,
                    },
                    32,
                );
            },
            Op::Lahf => {
                self.materialize_if(inst.flags_read);
                self.gi(FL);
                self.c32(0xD5);
                self.b.and_i32();
                self.c32(2);
                self.b.or_i32();
                self.b.extend_unsigned_i32_to_i64();
                self.set_reg(AH, 8);
            },
            Op::Sahf => {
                self.gi(FL);
                self.c32(!0xD5);
                self.b.and_i32();
                self.get_reg(AH, 8);
                self.b.wrap_i64_to_i32();
                self.c32(0xD5);
                self.b.and_i32();
                self.b.or_i32();
                self.si(FL);
                self.written(inst.writes);
            },
        }
        // Control transfers counted themselves before leaving.
        if !matches!(
            inst.op,
            Op::Call { .. }
                | Op::CallIndirect { .. }
                | Op::FarCall { .. }
                | Op::FarRet { .. }
                | Op::Ret { .. }
                | Op::JmpIndirect { .. }
                | Op::Jmp { .. }
                | Op::Jcc { .. }
                | Op::LoopJump { .. }
                | Op::Sti
        ) {
            self.retired();
        }
    }

    // SSE ---------------------------------------------------------------

    /// Address of XMM register `n` (the legacy bank for 0..7)
    fn xmm(n: u8) -> u32 {
        if n < 8 {
            gp::reg_xmm as u32 + n as u32 * 16
        }
        else {
            gp::x64_xmm_ext as u32 + (n as u32 - 8) * 16
        }
    }
    /// Op::Vlogic without XMM locals (as before P4.17): by 64-bit halves
    fn vlogic_halves(&mut self, inst: &Inst, code: u8, dst: u8, first: u8, src: Xmm) {
        if let Xmm::Mem(a) = src {
            self.vector_address(&a, 128, inst.d.vex.is_none(), false, inst);
        }
        // (each half read before it is written)
        for half in 0..2u32 {
            self.xmm_load(first, half * 8, 64);
            if code == 1 {
                self.c64(u64::MAX);
                self.b.xor_i64();
            }
            match src {
                Xmm::Reg(s) => self.xmm_load(s, half * 8, 64),
                Xmm::Mem(_) => {
                    self.gi(HOST);
                    self.b.guest_load_i64_bits(64, half * 8);
                },
            }
            match code {
                0 | 1 => self.b.and_i64(),
                2 => self.b.or_i64(),
                _ => self.b.xor_i64(),
            }
            self.s(TA);
            self.c32(Self::xmm(dst) as i32 + half as i32 * 8);
            self.g(TA);
            self.b.store_aligned_i64(0);
        }
        self.vex_upper(inst, dst);
    }
    /// Push native_fp::mxcsr_refused_any_daz's i32, computed once per block
    /// (x64_sse_fast_check, P4.18): MXCSR changes only by LDMXCSR (Op::Mxcsr
    /// drops the value) and by steps, which leave the block, while the exact
    /// helper only sets flags (PE too, which the value then misses: it
    /// errs on the slow side)
    fn fp_mxcsr_refused(&mut self) {
        match &self.fp_mxcsr {
            Some(local) => self.b.get_local(local),
            None => {
                crate::x86tpl::native_fp::mxcsr_refused_any_daz(&mut self.b);
                let local = self.b.set_new_local();
                self.b.get_local(&local);
                self.fp_mxcsr = Some(local);
            },
        }
    }
    /// The x87 cache's locals (Emitter::x87_cache), made once: from the
    /// start in a function with x87 forms, as Tier-0's, so that x87_close
    /// closes it in code emitted before them too (an MMX form at the top of
    /// a loop whose x87 forms, below it, left the cache open)
    fn x87_cache_locals(&mut self) {
        if self.x87_cache.is_none() {
            let b = &mut self.b;
            self.x87_cache = Some(X87Cache {
                top: b.declare_zeroed_local(),
                tags: b.declare_zeroed_local(),
                valid: b.declare_zeroed_local(),
                dirty: b.declare_zeroed_local(),
            });
            self.x87_is_open = Some(b.declare_zeroed_local());
        }
    }
    /// Open the x87 cache (Emitter::x87_cache) unless the emitted code has:
    /// loaded from the CPU state unless the runtime flag says it is open
    fn x87_cache_open(&mut self) {
        if self.x87_known_open {
            return;
        }
        self.x87_cache_locals();
        let c = self.x87_cache.as_ref().unwrap().unsafe_clone();
        let is_open = self.x87_is_open.as_ref().unwrap().unsafe_clone();
        let [_, valid, dirty] = crate::cpu::fpu::x87_cache_addresses();
        self.b.get_local(&is_open);
        self.b.eqz_i32();
        self.b.if_void();
        self.b.load_fixed_u8(gp::fpu_stack_ptr as u32);
        self.b.set_local(&c.top);
        self.b.load_fixed_u8(gp::fpu_stack_empty as u32);
        self.b.set_local(&c.tags);
        self.b.load_fixed_i32(valid);
        self.b.set_local(&c.valid);
        self.b.load_fixed_i32(dirty);
        self.b.set_local(&c.dirty);
        self.c32(1);
        self.b.set_local(&is_open);
        self.b.block_end();
        self.x87_known_open = true;
    }
    /// Write an open x87 cache back to the CPU state and close it (before
    /// the helpers that read or change the x87 state, and at every way out
    /// of the function); nothing in a function without x87 forms
    fn x87_close(&mut self) {
        self.x87_known_open = false;
        let Some(c) = self.x87_cache.as_ref().map(X87Cache::unsafe_clone)
        else {
            return;
        };
        let is_open = self.x87_is_open.as_ref().unwrap().unsafe_clone();
        let [_, valid, dirty] = crate::cpu::fpu::x87_cache_addresses();
        self.b.get_local(&is_open);
        self.b.if_void();
        for (address, local, byte) in [
            (gp::fpu_stack_ptr as u32, &c.top, true),
            (gp::fpu_stack_empty as u32, &c.tags, true),
            (valid, &c.valid, false),
            (dirty, &c.dirty, false),
        ] {
            self.c32(address as i32);
            self.b.get_local(local);
            if byte {
                self.b.store_u8(0);
            }
            else {
                self.b.store_aligned_i32(0);
            }
        }
        self.c32(0);
        self.b.set_local(&is_open);
        self.b.block_end();
    }
    /// Compatibility mode's MMX (P7.2a), as Tier-0's ir::tier0::simd: CR0.EM
    /// and TS clear (else a retry: #UD, #NM), the x87 cache closed (the MM
    /// registers are the x87 mantissas: x86tpl::mmx syncs and invalidates
    /// the f64 shadow slots in memory), every form ending with the switch to
    /// MMX (all tags valid, TOP 0) but EMMS (all empty)
    fn mmx(&mut self, inst: &Inst, form: MmxForm, start: u64) {
        use crate::x86tpl::mmx;
        self.x87_check(start);
        self.x87_close();
        let result = |e: &mut Self, reg: u8| {
            let v = e.b.set_new_local_v128();
            mmx::store(&mut e.b, reg, &v);
            mmx::transition(&mut e.b);
            e.b.free_local_v128(v);
        };
        match form {
            MmxForm::Emms => {
                self.c32(gp::fpu_stack_empty as i32);
                self.c32(0xFF);
                self.b.store_u8(0);
            },
            MmxForm::Load { reg, src } => {
                self.mmx_source(src, 8, inst);
                result(self, reg);
            },
            MmxForm::Store { reg, dst } => match dst {
                Xmm::Reg(r) => {
                    mmx::load(&mut self.b, reg);
                    result(self, r);
                },
                Xmm::Mem(a) => {
                    self.vector_address(&a, 64, false, true, inst);
                    self.gi(HOST);
                    mmx::load(&mut self.b, reg);
                    self.b.simd_lane(0x1D, 0);
                    self.b.guest_store_i64_bits(64, 0);
                    mmx::transition(&mut self.b);
                },
            },
            MmxForm::MovdIn { reg, src } => {
                self.read(src, 32, inst);
                self.b.wrap_i64_to_i32();
                let value = self.b.set_new_local();
                self.b.simd_zero();
                self.b.get_local(&value);
                self.b.simd_lane(0x1C, 0);
                self.b.free_local(value);
                result(self, reg);
            },
            MmxForm::MovdOut { reg, dst } => {
                // (a memory destination's host first, as MOV's: a refused
                // one retries before anything changed)
                if let Opnd::Mem(a) = dst {
                    self.prepare_store(&a, 32, inst);
                }
                mmx::load(&mut self.b, reg);
                self.b.simd_lane(0x1B, 0);
                self.b.extend_unsigned_i32_to_i64();
                self.s(TV);
                self.write_dst(dst, 32, TV);
                mmx::transition(&mut self.b);
            },
            MmxForm::Packed {
                op,
                reg,
                src,
                bytes,
            } => {
                self.mmx_source(src, bytes, inst);
                let source = self.b.set_new_local_v128();
                mmx::load(&mut self.b, reg);
                let destination = self.b.set_new_local_v128();
                vec::packed(&mut self.b, op, &destination, &source, 8);
                result(self, reg);
                self.b.free_local_v128(source);
                self.b.free_local_v128(destination);
            },
            MmxForm::Shift {
                reg,
                bits,
                kind,
                count,
            } => {
                mmx::load(&mut self.b, reg);
                let value = self.b.set_new_local_v128();
                vec::shift_immediate(&mut self.b, &value, bits, kind, count);
                result(self, reg);
                self.b.free_local_v128(value);
            },
        }
    }
    /// Push an MMX form's source (v128, low quadword): an MM register, or
    /// `bytes` of memory zero-extended
    fn mmx_source(&mut self, src: Xmm, bytes: u8, inst: &Inst) {
        match src {
            Xmm::Reg(r) => crate::x86tpl::mmx::load(&mut self.b, r),
            Xmm::Mem(a) => {
                self.vector_address(&a, bytes * 8, false, false, inst);
                self.b.simd_zero();
                self.gi(HOST);
                self.load_bits(bytes * 8, 0);
                self.b.simd_lane(0x1E, 0);
            },
        }
    }
    /// Compatibility mode's x87 (P7.2a): CR0.EM and TS clear, else a retry
    /// (the interpreter raises #NM); once per block
    fn x87_check(&mut self, start: u64) {
        if self.vector_checked & VECTOR_X87 != 0 {
            return;
        }
        self.vector_checked |= VECTOR_X87;
        self.b.load_fixed_i32(gp::cr as u32);
        self.c32(crate::cpu::cpu::CR0_EM | crate::cpu::cpu::CR0_TS);
        self.b.and_i32();
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
    }
    /// A run of register-only x87 forms (P7.2a, x86tpl::x87run, as Tier-0
    /// compiles it): one guard and f64 locals, else the forms one by one
    fn x87_run(&mut self, insts: &[Inst], run: &X87Run, index: &BTreeMap<u16, usize>) {
        self.x87_check(insts[0].d.start.0);
        self.x87_cache_open();
        let done = self.b.block_void();
        let slow = self.b.block_void();
        self.b.load_fixed_u8(gp::x87_native_policy as u32);
        self.b.eqz_i32();
        self.b.hint(false);
        self.b.br_if(slow);
        let cache = self.x87_cache.as_ref().unwrap().unsafe_clone();
        x87_run(&mut self.b, &cache, run, slow);
        if !self.env.block_count {
            self.gi(N);
            self.c32(insts.len() as i32);
            self.b.add_i32();
            self.si(N);
        }
        self.b.br(done);
        self.b.block_end();
        for inst in insts {
            self.xmm_worth = 0;
            self.instruction(inst, index);
        }
        self.b.block_end();
    }
    /// Compatibility mode's x87 form (P7.2a) as Tier-0 emits it (ir::tier0
    /// Form::X87): its memory operand read into the two words, or for a
    /// store the translation validated first (the form may pop: the store
    /// must not fault after it); the f64 form of x86tpl::x87 where it
    /// applies and gp::x87_native_policy allows, else ir_t0_x87 on the CPU
    /// state from unchanged state; then the store.
    fn x87(
        &mut self,
        inst: &Inst,
        opcode: u8,
        modrm: u8,
        io: crate::x86tpl::x87_forms::Io,
        address: Option<AddressExpr>,
    ) {
        use crate::x86tpl::x87_forms::Io;
        let (start, next) = (inst.d.start.0, inst.d.next.0);
        self.x87_check(start);
        if self.x87_words.is_none() {
            let words = (self.b.declare_zeroed_local(), self.b.declare_zeroed_local());
            self.x87_words = Some(words);
        }
        let (low, high) = {
            let (low, high) = self.x87_words.as_ref().unwrap();
            (low.unsafe_clone(), high.unsafe_clone())
        };
        let kind = match io {
            Io::Stack => 0,
            Io::Load { .. } => 1,
            Io::Store { .. } => 2,
        };
        let form = opcode as i32 | (modrm as i32) << 8 | kind << 16;
        match io {
            Io::Stack => {},
            Io::Load { bytes } => {
                self.address(&address.unwrap(), next, true);
                self.s(ADDR);
                self.host(bytes as u32, false, start);
                self.load(bytes * 8);
                self.s(TV);
                self.g(TV);
                self.b.wrap_i64_to_i32();
                self.b.set_local(&low);
                self.g(TV);
                self.c64(32);
                self.b.shr_u_i64();
                self.b.wrap_i64_to_i32();
                self.b.set_local(&high);
            },
            Io::Store { bytes } => {
                self.address(&address.unwrap(), next, true);
                self.s(ADDR);
                self.host(bytes as u32, true, start);
                self.si(HOST);
            },
        }
        // (M8, legacy mode: FLDCW sets the control word and SoftFloat's
        // rounding and precision, nothing of the stack: the x87 cache stays
        // open, where the helper would close it; 615.ftol's truncating casts
        // take two)
        if self.env.compat && opcode == 0xD9 && modrm < 0xC0 && modrm >> 3 & 7 == 5 {
            self.b.get_local(&low);
            self.b
                .call_signature("x64_page_fldcw", Signature::new(&[WasmType::I32], &[]));
            return;
        }
        let done = self.b.block_void();
        if let Some(native) = crate::x86tpl::x87_forms::native(opcode, modrm) {
            self.x87_cache_open();
            let slow = self.b.block_void();
            self.b.load_fixed_u8(gp::x87_native_policy as u32);
            self.b.eqz_i32();
            self.b.hint(false);
            self.b.br_if(slow);
            let cache = self.x87_cache.as_ref().map(X87Cache::unsafe_clone);
            let mut words = X87Operands {
                b: &mut self.b,
                words: [&low, &high],
                cache,
            };
            x87_native(&mut words, native, slow);
            self.b.br(done);
            self.b.block_end();
        }
        // (the helper works on the CPU state)
        self.x87_close();
        self.c32(form);
        self.b.get_local(&low);
        self.b.get_local(&high);
        self.b.call_signature(
            "x64_x87",
            Signature::new(
                &[WasmType::I32, WasmType::I32, WasmType::I32],
                &[WasmType::I64],
            ),
        );
        self.s(TV);
        self.g(TV);
        self.b.wrap_i64_to_i32();
        self.b.set_local(&low);
        self.g(TV);
        self.c64(32);
        self.b.shr_u_i64();
        self.b.wrap_i64_to_i32();
        self.b.set_local(&high);
        self.b.block_end();
        if let Io::Store { bytes } = io {
            self.gi(HOST);
            self.b.get_local(&high);
            self.b.extend_unsigned_i32_to_i64();
            self.c64(32);
            self.b.shl_i64();
            self.b.get_local(&low);
            self.b.extend_unsigned_i32_to_i64();
            self.b.or_i64();
            self.store(bytes * 8);
        }
    }
    /// Retry unless the vector instruction may execute (the interpreter
    /// raises #UD or #NM): sse_check, or for a VEX form CR0.TS clear,
    /// CR4.OSXSAVE set and XCR0 with SSE and AVX state (CR0.EM and
    /// CR4.OSFXSR do not matter)
    fn vector_check(&mut self, inst: &Inst, start: u64) {
        // (P4.18: once per block; nothing a block compiles changes CR0, CR4
        // or XCR0)
        let kind = if inst.d.vex.is_none() { VECTOR_SSE } else { VECTOR_VEX };
        if self.env.sse_fast_check {
            if self.vector_checked & kind != 0 {
                return;
            }
            self.vector_checked |= kind;
        }
        if self.vector_ok.is_some() {
            return self.vector_ok_check(kind, start);
        }
        if inst.d.vex.is_none() {
            self.sse_check(start);
            return;
        }
        self.b.load_fixed_i32(gp::cr as u32);
        self.c32(crate::cpu::cpu::CR0_TS);
        self.b.and_i32();
        self.b.load_fixed_i32(gp::cr as u32 + 16);
        self.c32(crate::cpu::cpu::CR4_OSXSAVE);
        self.b.and_i32();
        self.b.eqz_i32();
        self.b.or_i32();
        self.b.load_fixed_i32(gp::xcr0 as u32);
        self.c32(6);
        self.b.and_i32();
        self.c32(6);
        self.b.ne_i32();
        self.b.or_i32();
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
    }
    /// The address of the 64 bits at `offset` (0, 8, 16, 24) of YMM
    /// register `n`
    fn ymm(n: u8, offset: u32) -> u32 {
        if offset < 16 {
            Self::xmm(n) + offset
        }
        else {
            unsafe { gp::ymm_hi.add(n as usize) as u32 + offset - 16 }
        }
    }
    /// YMM register `n` = (`low`, `high`): the low half through the XMM
    /// accessors (its v128 local while held, P4.17), bits 255:128 in memory
    fn ymm_store(&mut self, n: u8, low: &WasmLocalV128, high: &WasmLocalV128) {
        self.ymm_zeroed &= !(1 << n);
        if self.env.xmm_locals {
            self.b.get_local_v128(low);
            self.xv_pop(n);
        }
        else {
            self.c32(Self::ymm(n, 0) as i32);
            self.b.get_local_v128(low);
            self.b.simd_memory(0x0B, 0); // v128.store
        }
        self.c32(Self::ymm(n, 16) as i32);
        self.b.get_local_v128(high);
        self.b.simd_memory(0x0B, 0); // v128.store
    }
    /// Zero bits 255:128 of YMM register `n`
    fn ymm_zero(&mut self, n: u8) {
        if self.ymm_zeroed >> n & 1 != 0 {
            return;
        }
        self.ymm_zeroed |= 1 << n;
        for half in 0..2 {
            self.c32(unsafe { gp::ymm_hi.add(n as usize) } as i32 + 8 * half);
            self.c64(0);
            self.b.store_aligned_i64(0);
        }
    }
    /// A VEX form's register destination `n` written (last): its bits
    /// 255:128 zeroed
    fn vex_upper(&mut self, inst: &Inst, n: u8) {
        if inst.d.vex.is_some() {
            self.ymm_zero(n);
        }
    }
    /// XMM register `to` = XMM register `from`
    fn xmm_copy(&mut self, from: u8, to: u8) {
        if self.env.xmm_locals {
            self.xv_push(from);
            self.xv_pop(to);
            return;
        }
        for half in 0..2 {
            self.xmm_load(from, half * 8, 64);
            self.xmm_store(to, half * 8, 64, false);
        }
    }
    /// Retry unless SSE may execute: CR0.EM and CR0.TS clear, CR4.OSFXSR set
    /// (the interpreter raises #UD or #NM).
    fn sse_check(&mut self, start: u64) {
        self.b.load_fixed_i32(gp::cr as u32);
        self.c32(0xC);
        self.b.and_i32();
        self.b.load_fixed_i32(gp::cr as u32 + 16);
        self.c32(0x200);
        self.b.and_i32();
        self.b.eqz_i32();
        self.b.or_i32();
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
    }
    /// SSE ADD/MUL/SUB/DIV natively when the result is exactly what the
    /// interpreter (SoftFloat, crate::x64::vector) produces: round to
    /// nearest and every exception masked (FTZ and DAZ may be set: they
    /// affect none of the operands and results admitted here); operands
    /// finite and normal or zero; a divisor that is not zero; and a result
    /// that is normal above the smallest binade (no underflow, whichever way
    /// tininess is detected) or an exact zero. An inexact result sets PE
    /// itself (INX). Otherwise the instruction is retried in the
    /// interpreter; no lane is written before all passed.
    fn vfp(
        &mut self,
        inst: &Inst,
        start: u64,
        code: u8,
        double: bool,
        packed: bool,
        dst: u8,
        first: u8,
        src: Xmm,
    ) {
        self.vector_check(inst, start);
        // (DAZ and FTZ change nothing for the operands and results below;
        // the exception flags other than PE are never set by them)
        self.b.load_fixed_i32(gp::mxcsr as u32);
        self.c32(0x7F80);
        self.b.and_i32();
        self.c32(0x1F80);
        self.b.ne_i32();
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
        self.c32(0);
        self.si(INX);
        let bits = if packed {
            128
        }
        else if double {
            64
        }
        else {
            32
        };
        if let Xmm::Mem(a) = src {
            self.vector_address(&a, bits, packed && inst.d.vex.is_none(), false, inst);
        }
        self.c32(0);
        self.si(COND);
        for half in 0..if packed { 2 } else { 1 } {
            self.xmm_load(first, half * 8, 64);
            self.s(TV);
            match src {
                Xmm::Reg(s) => self.xmm_load(s, half * 8, 64),
                Xmm::Mem(_) => {
                    self.gi(HOST);
                    self.load_bits(bits.min(64), half * 8);
                },
            }
            self.s(TC);
            let out = if half == 0 { FP0 } else { FP1 };
            if double {
                self.g(TV);
                self.s(TA);
                self.g(TC);
                self.s(TB);
                self.fp_lane(code, true);
                self.g(TR);
                self.s(out);
                continue;
            }
            for lane in 0..if packed { 2 } else { 1 } {
                for (from, to) in [(TV, TA), (TC, TB)] {
                    self.g(from);
                    if lane == 1 {
                        self.c64(32);
                        self.b.shr_u_i64();
                    }
                    self.c64(0xFFFF_FFFF);
                    self.b.and_i64();
                    self.s(to);
                }
                self.fp_lane(code, false);
                if lane == 0 {
                    self.g(TR);
                }
                else {
                    self.g(out);
                    self.g(TR);
                    self.c64(32);
                    self.b.shl_i64();
                    self.b.or_i64();
                }
                self.s(out);
            }
        }
        self.gi(COND);
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
        // an inexact result sets PE (sticky)
        self.gi(INX);
        self.b.if_void();
        self.c32(gp::mxcsr as i32);
        self.b.load_fixed_i32(gp::mxcsr as u32);
        self.c32(0x20);
        self.b.or_i32();
        self.b.store_aligned_i32(0);
        self.b.block_end();
        if !packed && first != dst {
            // (a scalar form's other lanes from VEX.vvvv)
            self.xmm_copy(first, dst);
        }
        self.g(FP0);
        self.xmm_store(dst, 0, if packed || double { 64 } else { 32 }, true);
        if packed {
            self.g(FP1);
            self.xmm_store(dst, 8, 64, false);
        }
        self.vex_upper(inst, dst);
    }
    /// One lane of vfp: operand bit patterns in TA and TB (zero-extended in
    /// single precision), the result's into TR; refusals or'ed into COND
    fn fp_lane(&mut self, code: u8, double: bool) {
        let (shift, max, magnitude) =
            if double { (52, 0x7FF, 0x7FFF_FFFF_FFFF_FFFF) } else { (23, 0xFF, 0x7FFF_FFFF) };
        let zero = |e: &mut Self, x: usize| {
            e.g(x);
            e.c64(magnitude);
            e.b.and_i64();
            e.b.op(op::OP_I64EQZ);
        };
        let exponent = |e: &mut Self, x: usize| {
            e.g(x);
            e.c64(shift);
            e.b.shr_u_i64();
            e.c64(max);
            e.b.and_i64();
            e.s(TX);
        };
        // operands: no NaN or infinity (exponent all ones), no denormal
        for x in [TA, TB] {
            exponent(self, x);
            self.g(TX);
            self.c64(max);
            self.b.eq_i64();
            self.g(TX);
            self.b.op(op::OP_I64EQZ);
            zero(self, x);
            self.b.eqz_i32();
            self.b.and_i32();
            self.b.or_i32();
            self.fp_refuse();
        }
        if code == 0x5E {
            // a zero divisor: #Z, or #I for 0/0
            zero(self, TB);
            self.fp_refuse();
        }
        for x in [TA, TB] {
            self.g(x);
            if double {
                self.b.reinterpret_i64_as_f64();
            }
            else {
                self.b.wrap_i64_to_i32();
                self.b.reinterpret_i32_as_f32();
            }
        }
        let operation = match code {
            0x58 => 0,
            0x5C => 1,
            0x59 => 2,
            _ => 3,
        };
        if double {
            self.b.arithmetic_f64(operation);
            self.b.reinterpret_f64_as_i64();
        }
        else {
            self.b.arithmetic_f32(operation);
            self.b.reinterpret_f32_as_i32();
            self.b.extend_unsigned_i32_to_i64();
        }
        self.s(TR);
        // the result: its exponent 0 or 1 (possible underflow) or all ones
        // (overflow) is refused, unless it is an exact zero
        exponent(self, TR);
        self.g(TX);
        self.c64(!1);
        self.b.and_i64();
        self.b.op(op::OP_I64EQZ);
        self.g(TX);
        self.c64(max);
        self.b.eq_i64();
        self.b.or_i32();
        zero(self, TR);
        match code {
            // a zero sum or difference of finite normal operands is exact
            0x58 | 0x5C => {},
            // a zero product is exact only with a zero factor
            0x59 => {
                zero(self, TA);
                zero(self, TB);
                self.b.or_i32();
                self.b.and_i32();
            },
            // a zero quotient only with a zero dividend
            _ => {
                zero(self, TA);
                self.b.and_i32();
            },
        }
        self.b.eqz_i32();
        self.b.and_i32();
        self.fp_refuse();
        self.fp_inexact(code, double);
        self.gi(INX);
        self.b.or_i32();
        self.si(INX);
    }
    /// Push i32 1 when the lane's result (TR) is not the exact result of the
    /// operation on TA and TB (sets MXCSR.PE), for the operands and results
    /// fp_lane admits. Single precision: the operation is exact in double
    /// (TwoSum for ADD/SUB). Double: TwoSum, and Dekker's TwoProduct for MUL
    /// (and DIV: the product of quotient and divisor is the dividend), which
    /// refuse extreme exponents where its terms would overflow or underflow.
    fn fp_inexact(&mut self, code: u8, double: bool) {
        let value = |e: &mut Self, i: usize| {
            e.g(i);
            if double {
                e.b.reinterpret_i64_as_f64();
            }
            else {
                e.b.wrap_i64_to_i32();
                e.b.reinterpret_i32_as_f32();
                e.b.promote_f32_to_f64();
            }
        };
        value(self, TA);
        let x = self.b.set_new_local_f64();
        value(self, TB);
        if code == 0x5C {
            self.b.unary_f64(true);
        }
        let y = self.b.set_new_local_f64();
        value(self, TR);
        let r = self.b.set_new_local_f64();
        let f = |e: &mut Self, l: &crate::wasmgen::wasm_builder::WasmLocalF64| e.b.get_local_f64(l);
        match (code, double) {
            (0x58 | 0x5C, _) => {
                // TwoSum: s = x + y, err = (x - (s - bb)) + (y - bb), bb = s - x
                f(self, &x);
                f(self, &y);
                self.b.arithmetic_f64(0);
                let s = self.b.set_new_local_f64();
                f(self, &s);
                f(self, &x);
                self.b.arithmetic_f64(1);
                let bb = self.b.set_new_local_f64();
                f(self, &x);
                f(self, &s);
                f(self, &bb);
                self.b.arithmetic_f64(1);
                self.b.arithmetic_f64(1);
                f(self, &y);
                f(self, &bb);
                self.b.arithmetic_f64(1);
                self.b.arithmetic_f64(0);
                self.b.const_f64(0.0);
                self.b.ne_f64();
                f(self, &s);
                f(self, &r);
                self.b.ne_f64();
                self.b.or_i32();
                self.b.free_local_f64(s);
                self.b.free_local_f64(bb);
            },
            (0x59, false) => {
                f(self, &x);
                f(self, &y);
                self.b.arithmetic_f64(2);
                f(self, &r);
                self.b.ne_f64();
            },
            (_, false) => {
                f(self, &r);
                f(self, &y);
                self.b.arithmetic_f64(2);
                f(self, &x);
                self.b.ne_f64();
            },
            (_, true) => {
                // TwoProduct of (a, b) = (x, y) for MUL, (r, y) for DIV;
                // exact when the error term is 0 (and, for DIV, the product
                // is the dividend). Refused: an operand or the result (not
                // zero) outside 2^-450..2^450, where splitting could overflow
                // or the error terms lose bits to underflow.
                for i in [TA, TB, TR] {
                    self.g(i);
                    self.c64(52);
                    self.b.shr_u_i64();
                    self.c64(0x7FF);
                    self.b.and_i64();
                    self.c64(0x3FF - 450);
                    self.b.sub_i64();
                    self.c64(900);
                    self.b.gtu_i64();
                    self.g(i);
                    self.c64(0x7FFF_FFFF_FFFF_FFFF);
                    self.b.and_i64();
                    self.c64(0);
                    self.b.ne_i64();
                    self.b.and_i32();
                    self.fp_refuse();
                }
                let (a, p) = if code == 0x59 { (&x, &r) } else { (&r, &x) };
                let split = |e: &mut Self, v: &crate::wasmgen::wasm_builder::WasmLocalF64| {
                    // hi = c - (c - v), c = v * (2^27 + 1); lo = v - hi
                    e.b.const_f64(134217729.0);
                    f(e, v);
                    e.b.arithmetic_f64(2);
                    let c = e.b.set_new_local_f64();
                    f(e, &c);
                    f(e, &c);
                    f(e, v);
                    e.b.arithmetic_f64(1);
                    e.b.arithmetic_f64(1);
                    let hi = e.b.set_new_local_f64();
                    f(e, v);
                    f(e, &hi);
                    e.b.arithmetic_f64(1);
                    let lo = e.b.set_new_local_f64();
                    e.b.free_local_f64(c);
                    (hi, lo)
                };
                let (ah, al) = split(self, a);
                let (bh, bl) = split(self, &y);
                // product = a * b rounded (MUL: the result; DIV: computed)
                if code == 0x59 {
                    f(self, &r);
                }
                else {
                    f(self, a);
                    f(self, &y);
                    self.b.arithmetic_f64(2);
                }
                let product = self.b.set_new_local_f64();
                // err = ((ah*bh - product) + ah*bl + al*bh) + al*bl
                f(self, &ah);
                f(self, &bh);
                self.b.arithmetic_f64(2);
                f(self, &product);
                self.b.arithmetic_f64(1);
                f(self, &ah);
                f(self, &bl);
                self.b.arithmetic_f64(2);
                self.b.arithmetic_f64(0);
                f(self, &al);
                f(self, &bh);
                self.b.arithmetic_f64(2);
                self.b.arithmetic_f64(0);
                f(self, &al);
                f(self, &bl);
                self.b.arithmetic_f64(2);
                self.b.arithmetic_f64(0);
                self.b.const_f64(0.0);
                self.b.ne_f64();
                if code != 0x59 {
                    f(self, &product);
                    f(self, p);
                    self.b.ne_f64();
                    self.b.or_i32();
                }
                for l in [ah, al, bh, bl, product] {
                    self.b.free_local_f64(l);
                }
            },
        }
        self.b.free_local_f64(x);
        self.b.free_local_f64(y);
        self.b.free_local_f64(r);
    }
    fn fp_refuse(&mut self) {
        self.gi(COND);
        self.b.or_i32();
        self.si(COND);
    }

    /// The register facts across an instruction that does not keep them
    /// itself (P4.18): what it writes loses its facts, but a register copy
    /// passes them on. The templates of x86tpl::ops on pagegen_vec::Operands
    /// end their destination's facts at each write and state new ones.
    fn xmm_facts(&mut self, op: &Op) {
        match *op {
            Op::Vfp { .. } | Op::Vcmp { .. } | Op::Vcvt { .. } => {},
            Op::Vmove {
                bits: 128,
                dst: Xmm::Reg(d),
                src: Xmm::Reg(s),
                ..
            } => self.xmm_clean[d as usize] = self.xmm_clean[s as usize],
            _ => {
                let mut written = xmm_written(op);
                while written != 0 {
                    self.xmm_clean[written.trailing_zeros() as usize] = 0;
                    written &= written - 1;
                }
            },
        }
    }
    /// Whether XMM register `n` is in its v128 local (P4.17)
    fn held(&self, n: u8) -> bool { self.xmm_held >> n & 1 != 0 }
    /// Load the XMM `registers` (a mask) not held yet into their locals;
    /// only where every path runs (an instruction's start)
    fn xmm_hold(&mut self, registers: u16) {
        let mut load = registers & !self.xmm_held;
        while load != 0 {
            let n = load.trailing_zeros() as usize;
            load &= load - 1;
            let b = &mut self.b;
            let local = self.xmm_locals[n].get_or_insert_with(|| b.declare_zeroed_local_v128());
            self.b.const_i32(Self::xmm(n as u8) as i32);
            self.b.simd_memory(0x00, 0);
            self.b.set_local_v128(local);
        }
        self.xmm_held |= registers;
    }
    /// Hold the XMM `registers` (a mask) without loading those not held yet:
    /// the instruction about to be emitted overwrites them whole before
    /// anything reads them (xmm_overwritten), and until it does, a way out
    /// writes back only what is dirty
    fn xmm_claim(&mut self, registers: u16) {
        let mut claim = registers & !self.xmm_held;
        while claim != 0 {
            let n = claim.trailing_zeros() as usize;
            claim &= claim - 1;
            let b = &mut self.b;
            self.xmm_locals[n].get_or_insert_with(|| b.declare_zeroed_local_v128());
        }
        self.xmm_held |= registers;
    }
    /// Store the held registers written since they were loaded (before
    /// leaving the block, or code that reads XMM memory); any path
    fn xmm_writeback(&mut self) {
        let mut dirty = self.xmm_dirty;
        while dirty != 0 {
            let n = dirty.trailing_zeros() as usize;
            dirty &= dirty - 1;
            self.b.const_i32(Self::xmm(n as u8) as i32);
            self.b.get_local_v128(self.xmm_locals[n].as_ref().unwrap());
            self.b.simd_memory(0x0B, 0);
        }
    }
    /// xmm_writeback, and nothing held from here: only where every path runs
    fn xmm_release(&mut self) {
        self.xmm_writeback();
        self.xmm_held = 0;
        self.xmm_dirty = 0;
    }
    /// Push XMM register `n` (v128): its local while held, else memory
    fn xv_push(&mut self, n: u8) {
        if self.held(n) {
            self.b
                .get_local_v128(self.xmm_locals[n as usize].as_ref().unwrap());
        }
        else {
            self.c32(Self::xmm(n) as i32);
            self.b.simd_memory(0x00, 0);
        }
    }
    /// Pop a v128 into XMM register `n`
    fn xv_pop(&mut self, n: u8) {
        if self.held(n) {
            self.b
                .set_local_v128(self.xmm_locals[n as usize].as_ref().unwrap());
            self.xmm_dirty |= 1 << n;
        }
        else {
            let value = self.b.set_new_local_v128();
            self.c32(Self::xmm(n) as i32);
            self.b.get_local_v128(&value);
            self.b.simd_memory(0x0B, 0);
            self.b.free_local_v128(value);
        }
    }
    /// Push the `bits` (32 or 64) at the host address HOST as a v128, the
    /// rest zero: v128.load32_zero or v128.load64_zero (with the workers'
    /// atomic guest memory a scalar load into lane 0)
    fn load_scalar_v128(&mut self, bits: u8) {
        if WasmBuilder::ATOMIC_GUEST_MEMORY {
            self.b.simd_zero();
            self.gi(HOST);
            self.load_bits(bits, 0);
            if bits == 64 {
                self.b.simd_lane(0x1E, 0); // i64x2.replace_lane
            }
            else {
                self.b.wrap_i64_to_i32();
                self.b.simd_lane(0x1C, 0); // i32x4.replace_lane
            }
            return;
        }
        self.gi(HOST);
        self.b.simd_memory(if bits == 64 { 0x5D } else { 0x5C }, 0);
    }
    /// Push the low `bits` (32 or 64) at byte `offset` of XMM register `n`.
    fn xmm_load(&mut self, n: u8, offset: u32, bits: u8) {
        if self.held(n) {
            self.b
                .get_local_v128(self.xmm_locals[n as usize].as_ref().unwrap());
            if bits == 32 {
                self.b.simd_lane(0x1B, (offset / 4) as u8); // i32x4.extract_lane
                self.b.extend_unsigned_i32_to_i64();
            }
            else {
                self.b.simd_lane(0x1D, (offset / 8) as u8); // i64x2.extract_lane
            }
            return;
        }
        self.c32((Self::xmm(n) + offset) as i32);
        if bits == 32 {
            self.b.memory_op(op::OP_I64LOAD32U, op::MEM_ALIGN32, 0);
        }
        else {
            self.b.memory_op(op::OP_I64LOAD, op::MEM_ALIGN64, 0);
        }
    }
    /// Store the value on the stack into XMM register `n` at byte `offset`;
    /// a 32-bit store keeps the rest of the qword when `merge`.
    fn xmm_store(&mut self, n: u8, offset: u32, bits: u8, merge: bool) {
        if self.held(n) {
            self.s(TA);
            self.b
                .get_local_v128(self.xmm_locals[n as usize].as_ref().unwrap());
            self.g(TA);
            if bits == 32 && merge {
                self.b.wrap_i64_to_i32();
                self.b.simd_lane(0x1C, (offset / 4) as u8); // i32x4.replace_lane
            }
            else {
                if bits == 32 {
                    self.c64(0xFFFF_FFFF);
                    self.b.and_i64();
                }
                self.b.simd_lane(0x1E, (offset / 8) as u8); // i64x2.replace_lane
            }
            self.b
                .set_local_v128(self.xmm_locals[n as usize].as_ref().unwrap());
            self.xmm_dirty |= 1 << n;
            return;
        }
        self.s(TA);
        self.c32((Self::xmm(n) + offset) as i32);
        self.g(TA);
        if bits == 32 && merge {
            self.b.memory_op(op::OP_I64STORE32, op::MEM_ALIGN32, 0);
        }
        else {
            if bits == 32 {
                self.c64(0xFFFF_FFFF);
                self.b.and_i64();
            }
            self.b.store_aligned_i64(0);
        }
    }
    /// Zero XMM register `n` above its low `bits` (32 or 64).
    fn clear_upper(&mut self, n: u8, bits: u8) {
        if self.held(n) {
            self.b
                .get_local_v128(self.xmm_locals[n as usize].as_ref().unwrap());
            if bits == 32 {
                self.c32(0);
                self.b.simd_lane(0x1C, 1); // i32x4.replace_lane
            }
            self.c64(0);
            self.b.simd_lane(0x1E, 1); // i64x2.replace_lane
            self.b
                .set_local_v128(self.xmm_locals[n as usize].as_ref().unwrap());
            self.xmm_dirty |= 1 << n;
            return;
        }
        if bits == 32 {
            self.c32(Self::xmm(n) as i32 + 4);
            self.c32(0);
            self.b.store_aligned_i32(0);
        }
        self.c32(Self::xmm(n) as i32 + 8);
        self.c64(0);
        self.b.store_aligned_i64(0);
    }
    /// Push the 128-bit source of a packed form: an XMM register, or memory
    /// (legacy SSE: aligned, else #GP, retried).
    fn vector_source(&mut self, src: Xmm, inst: &Inst) {
        match src {
            Xmm::Reg(s) => self.xv_push(s),
            Xmm::Mem(a) => {
                self.vector_address(&a, 128, inst.d.vex.is_none(), false, inst);
                self.gi(HOST);
                let scratch = self.b.set_new_local();
                self.b.get_local(&scratch);
                self.b.guest_load_v128(&scratch);
                self.b.free_local(scratch);
            },
        }
    }
    /// ROUNDPS/PD/SS/SD (Op::Vround): x86tpl::ops::round on the page tier's
    /// operands, whose refused instructions retry
    fn vround(
        &mut self,
        inst: &Inst,
        start: u64,
        double: bool,
        scalar: bool,
        imm8: u8,
        dst: u8,
        first: u8,
        src: Xmm,
    ) {
        self.vector_check(inst, start);
        let mut operands = pagegen_vec::Operands {
            e: self,
            inst,
            start,
            dst,
            first,
            src,
        };
        crate::x86tpl::ops::round(&mut operands, double, scalar, imm8);
        self.vex_upper(inst, dst);
    }
    /// COMISS/UCOMISS/COMISD/UCOMISD. With no NaN or denormal operand the
    /// interpreter changes no MXCSR bit and sets ZF (equal) or CF (less),
    /// clearing the other arithmetic flags; anything else is retried.
    fn vcompare(&mut self, inst: &Inst, start: u64, double: bool, dst: u8, src: Xmm) {
        self.vector_check(inst, start);
        let bits = if double { 64 } else { 32 };
        match src {
            Xmm::Reg(s) => self.xmm_load(s, 0, bits),
            Xmm::Mem(a) => {
                self.vector_address(&a, bits, false, false, inst);
                self.gi(HOST);
                self.load_bits(bits, 0);
            },
        }
        self.s(TB);
        self.xmm_load(dst, 0, bits);
        self.s(TA);
        // exponent all zeros or all ones with a nonzero fraction
        let (fraction, exponent_shift, exponent_max) =
            if double { ((1u64 << 52) - 1, 52, 0x7FF) } else { ((1u64 << 23) - 1, 23, 0xFF) };
        for v in [TA, TB] {
            self.g(v);
            self.c64(fraction);
            self.b.and_i64();
            self.c64(0);
            self.b.ne_i64();
            self.g(v);
            self.c64(exponent_shift);
            self.b.shr_u_i64();
            self.c64(exponent_max);
            self.b.and_i64();
            self.s(TX);
            self.g(TX);
            self.b.op(op::OP_I64EQZ);
            self.g(TX);
            self.c64(exponent_max);
            self.b.eq_i64();
            self.b.or_i32();
            self.b.and_i32();
            self.b.if_void();
            self.leave_to(self.f().retry, start);
            self.b.block_end();
        }
        // FL = FL & ~arithmetic | ZF (a == b) | CF (a < b)
        self.gi(FL);
        self.c32(!ARITH as i32);
        self.b.and_i32();
        for (compare, flag) in [(op::OP_F64EQ, ZF), (op::OP_F64LT, CF)] {
            for v in [TA, TB] {
                self.g(v);
                if double {
                    self.b.op(op::OP_F64REINTERPRETI64);
                }
                else {
                    self.b.wrap_i64_to_i32();
                    self.b.op(op::OP_F32REINTERPRETI32);
                    self.b.op(op::OP_F64PROMOTEF32);
                }
            }
            self.b.op(compare);
            if flag != 1 {
                self.c32(flag.trailing_zeros() as i32);
                self.b.shl_i32();
            }
            self.b.or_i32();
        }
        self.si(FL);
        self.written(ARITH);
    }
    /// CMPPS/CMPPD/CMPSS/CMPSD (Op::Vcmp): x86tpl::ops::compare_mask on the
    /// page tier's operands, whose refused instructions retry (a NaN or
    /// denormal operand raises IE or DE, or makes them unordered)
    #[allow(clippy::too_many_arguments)]
    fn vcmp(
        &mut self,
        inst: &Inst,
        start: u64,
        double: bool,
        scalar: bool,
        predicate: u8,
        dst: u8,
        first: u8,
        src: Xmm,
    ) {
        self.vector_check(inst, start);
        let mut operands = pagegen_vec::Operands {
            e: self,
            inst,
            start,
            dst,
            first,
            src,
        };
        crate::x86tpl::ops::compare_mask(&mut operands, double, scalar, predicate);
        self.vex_upper(inst, dst);
    }
    /// Retry if the float in local `v` (`double` or single precision bits)
    /// is a NaN or a denormal: its exponent all zeros or all ones with a
    /// nonzero fraction
    fn refuse_nan_denormal(&mut self, v: usize, double: bool, start: u64) {
        let (fraction, exponent_shift, exponent_max) =
            if double { ((1u64 << 52) - 1, 52, 0x7FF) } else { ((1u64 << 23) - 1, 23, 0xFF) };
        self.g(v);
        self.c64(fraction);
        self.b.and_i64();
        self.c64(0);
        self.b.ne_i64();
        self.g(v);
        self.c64(exponent_shift);
        self.b.shr_u_i64();
        self.c64(exponent_max);
        self.b.and_i64();
        self.s(TX);
        self.g(TX);
        self.b.op(op::OP_I64EQZ);
        self.g(TX);
        self.c64(exponent_max);
        self.b.eq_i64();
        self.b.or_i32();
        self.b.and_i32();
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
    }
    /// MXCSR.PE if INX (an inexact result)
    /// CVTSI2SS/SD (Convert::FromInteger) of TA: MXCSR.PE when |x| has more
    /// significant bits than the precision (24 or 53) after its trailing
    /// zeros (|i64::MIN| is 2^63)
    fn from_integer_inexact(&mut self, double: bool) {
        self.g(TA);
        self.c64(63);
        self.b.shr_s_i64();
        self.s(TB);
        self.g(TA);
        self.g(TB);
        self.b.xor_i64();
        self.g(TB);
        self.b.sub_i64();
        self.s(TC);
        self.c64(64);
        self.g(TC);
        self.b.op(op::OP_I64CLZ);
        self.b.sub_i64();
        self.g(TC);
        self.b.op(op::OP_I64CTZ);
        self.c64(if double { 53 } else { 24 });
        self.b.add_i64();
        self.b.gtu_i64();
        self.si(INX);
        self.inexact_pe();
    }
    fn inexact_pe(&mut self) {
        self.gi(INX);
        self.b.if_void();
        self.c32(gp::mxcsr as i32);
        self.b.load_fixed_i32(gp::mxcsr as u32);
        self.c32(0x20);
        self.b.or_i32();
        self.b.store_aligned_i32(0);
        self.b.block_end();
    }
    /// The packed conversions (Op::Vcvt): x86tpl::ops on the page tier's
    /// operands (pagegen_vec), whose refused instructions retry
    fn vcvt(&mut self, inst: &Inst, start: u64, op: Cvt, dst: u8, src: Xmm) {
        self.vector_check(inst, start);
        let mut operands = pagegen_vec::Operands {
            e: self,
            inst,
            start,
            dst,
            first: dst,
            src,
        };
        match op {
            Cvt::Convert {
                opcode,
                source,
                result,
            } => crate::x86tpl::ops::convert(&mut operands, opcode, source, result),
            Cvt::Integers { double, truncate } => {
                crate::x86tpl::ops::convert_to_integers(&mut operands, double, truncate)
            },
        }
        self.vex_upper(inst, dst);
    }
    /// The scalar conversions (Op::Vconvert) natively when they are exact or
    /// only inexact (PE set here), with MXCSR to nearest and every exception
    /// masked; else retried, as for a NaN or denormal operand, a value out of
    /// the integer's range, and a single-precision result that overflows or
    /// is tiny
    fn vconvert(&mut self, inst: &Inst, start: u64, convert: Convert, dst: u8, first: u8) {
        self.vector_check(inst, start);
        // (FZ and DAZ matter only for the denormals refused here)
        self.b.load_fixed_i32(gp::mxcsr as u32);
        self.c32(0x7F80);
        self.b.and_i32();
        self.c32(0x1F80);
        self.b.ne_i32();
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
        let lane = |double: bool| if double { 64 } else { 32 };
        match convert {
            Convert::FromInteger { double, width, src } => {
                self.read(src, width, inst);
                if width == 32 {
                    self.b.wrap_i64_to_i32();
                    self.b.extend_signed_i32_to_i64();
                }
                self.s(TA);
                // (a 32-bit integer is exact in double precision)
                if !(double && width == 32) {
                    self.from_integer_inexact(double);
                }
                if self.env.xmm_locals {
                    // (into lane 0 of the first source by a lane insert:
                    // the value stays in the vector unit)
                    self.xv_push(first);
                    self.g(TA);
                    if double {
                        self.b.op(op::OP_F64CONVERTSI64);
                        self.b.simd_lane(0x22, 0); // f64x2.replace_lane
                    }
                    else {
                        self.b.op(op::OP_F32CONVERTSI64);
                        self.b.simd_lane(0x20, 0); // f32x4.replace_lane
                    }
                    self.xv_pop(dst);
                    self.vex_upper(inst, dst);
                    return;
                }
                self.g(TA);
                if double {
                    self.b.op(op::OP_F64CONVERTSI64);
                    self.b.op(op::OP_I64REINTERPRETF64);
                }
                else {
                    self.b.op(op::OP_F32CONVERTSI64);
                    self.b.op(op::OP_I32REINTERPRETF32);
                    self.b.extend_unsigned_i32_to_i64();
                }
                self.s(TR);
                if first != dst {
                    // (the other lanes from VEX.vvvv)
                    self.xmm_copy(first, dst);
                }
                self.g(TR);
                self.xmm_store(dst, 0, lane(double), true);
                self.vex_upper(inst, dst);
            },
            Convert::ToInteger {
                double,
                truncate,
                width,
                src,
            } => {
                let bits = lane(double);
                match src {
                    Xmm::Reg(s) => self.xmm_load(s, 0, bits),
                    Xmm::Mem(a) => {
                        self.vector_address(&a, bits, false, false, inst);
                        self.gi(HOST);
                        self.load_bits(bits, 0);
                    },
                }
                self.s(TA);
                self.refuse_nan_denormal(TA, double, start);
                self.g(TA);
                if double {
                    self.b.op(op::OP_F64REINTERPRETI64);
                }
                else {
                    self.b.wrap_i64_to_i32();
                    self.b.op(op::OP_F32REINTERPRETI32);
                    self.b.op(op::OP_F64PROMOTEF32);
                }
                let x = self.b.set_new_local_f64();
                self.b.get_local_f64(&x);
                self.b
                    .op(if truncate { op::OP_F64TRUNC } else { op::OP_F64NEAREST });
                let r = self.b.set_new_local_f64();
                // (outside the integer's range: IE)
                let limit = if width == 64 { 9223372036854775808.0 } else { 2147483648.0 };
                self.b.get_local_f64(&r);
                self.b.const_f64(-limit);
                self.b.op(op::OP_F64GE);
                self.b.get_local_f64(&r);
                self.b.const_f64(limit);
                self.b.op(op::OP_F64LT);
                self.b.and_i32();
                self.b.eqz_i32();
                self.b.if_void();
                self.leave_to(self.f().retry, start);
                self.b.block_end();
                self.b.get_local_f64(&r);
                self.b.get_local_f64(&x);
                self.b.op(op::OP_F64NE);
                self.si(INX);
                self.inexact_pe();
                self.b.get_local_f64(&r);
                self.b.op(op::OP_I64TRUNCSF64);
                self.set_reg(
                    Reg {
                        index: dst,
                        high: false,
                    },
                    width,
                );
                self.b.free_local_f64(x);
                self.b.free_local_f64(r);
            },
            Convert::Precision { double, src } => {
                // (the source's precision is the other one)
                let bits = lane(!double);
                match src {
                    Xmm::Reg(s) => self.xmm_load(s, 0, bits),
                    Xmm::Mem(a) => {
                        self.vector_address(&a, bits, false, false, inst);
                        self.gi(HOST);
                        self.load_bits(bits, 0);
                    },
                }
                self.s(TA);
                self.refuse_nan_denormal(TA, !double, start);
                if double {
                    // single to double precision: exact
                    self.g(TA);
                    self.b.wrap_i64_to_i32();
                    self.b.op(op::OP_F32REINTERPRETI32);
                    self.b.op(op::OP_F64PROMOTEF32);
                    self.b.op(op::OP_I64REINTERPRETF64);
                    self.s(TR);
                    self.c32(0);
                    self.si(INX);
                }
                else {
                    // double to single precision, to nearest: refused when
                    // it overflows (an infinity from a finite value) or is
                    // tiny (at most the smallest normal, from a nonzero value)
                    self.g(TA);
                    self.b.op(op::OP_F64REINTERPRETI64);
                    let x = self.b.set_new_local_f64();
                    self.b.get_local_f64(&x);
                    self.b.op(op::OP_F32DEMOTEF64);
                    self.b.op(op::OP_F64PROMOTEF32);
                    let r = self.b.set_new_local_f64();
                    self.b.get_local_f64(&r);
                    self.b.op(op::OP_F64ABS);
                    self.b.const_f64(f64::INFINITY);
                    self.b.op(op::OP_F64EQ);
                    self.b.get_local_f64(&x);
                    self.b.op(op::OP_F64ABS);
                    self.b.const_f64(f64::INFINITY);
                    self.b.op(op::OP_F64NE);
                    self.b.and_i32();
                    self.b.get_local_f64(&r);
                    self.b.op(op::OP_F64ABS);
                    self.b.const_f64(f32::MIN_POSITIVE as f64);
                    self.b.op(op::OP_F64LE);
                    self.b.get_local_f64(&x);
                    self.b.const_f64(0.0);
                    self.b.op(op::OP_F64NE);
                    self.b.and_i32();
                    self.b.or_i32();
                    self.b.if_void();
                    self.leave_to(self.f().retry, start);
                    self.b.block_end();
                    self.b.get_local_f64(&r);
                    self.b.get_local_f64(&x);
                    self.b.op(op::OP_F64NE);
                    self.si(INX);
                    self.b.get_local_f64(&x);
                    self.b.op(op::OP_F32DEMOTEF64);
                    self.b.op(op::OP_I32REINTERPRETF32);
                    self.b.extend_unsigned_i32_to_i64();
                    self.s(TR);
                    self.b.free_local_f64(x);
                    self.b.free_local_f64(r);
                }
                self.inexact_pe();
                if first != dst {
                    // (the other lanes from VEX.vvvv)
                    self.xmm_copy(first, dst);
                }
                self.g(TR);
                self.xmm_store(dst, 0, lane(double), true);
                self.vex_upper(inst, dst);
            },
        }
    }
    fn load_bits(&mut self, bits: u8, offset: u32) {
        self.b
            .guest_load_i64_bits(if bits == 32 { 32 } else { 64 }, offset);
    }
    /// HOST = host address of the `bits` memory operand, retried when an
    /// aligned form is misaligned (#GP) or the access cache refuses it.
    fn vector_address(
        &mut self,
        a: &AddressExpr,
        bits: u8,
        aligned: bool,
        write: bool,
        inst: &Inst,
    ) {
        self.vector_address_bytes(a, bits as u32 / 8, aligned, write, inst)
    }
    /// vector_address of a `bytes` operand (aligned: an m256 32-byte, the
    /// others 16-byte)
    fn vector_address_bytes(
        &mut self,
        a: &AddressExpr,
        bytes: u32,
        aligned: bool,
        write: bool,
        inst: &Inst,
    ) {
        self.address(a, inst.d.next.0, true);
        self.s(ADDR);
        if aligned {
            self.g(ADDR);
            self.b.wrap_i64_to_i32();
            self.c32(if bytes == 32 { 31 } else { 15 });
            self.b.and_i32();
            self.b.if_void();
            self.leave_to(self.f().retry, inst.d.start.0);
            self.b.block_end();
        }
        // (XMM locals, P4.17: an aligned operand stays in its page)
        let aligned = aligned && self.env.xmm_locals;
        self.host_kind(
            (bytes, aligned),
            (write as u32) << 8,
            inst.d.start.0,
            self.f().retry,
        );
        self.si(HOST);
    }

    fn shift_immediate(
        &mut self,
        inst: &Inst,
        code: u8,
        width: u8,
        dst: Opnd,
        count: u8,
        need: u32,
    ) {
        let raw = shift_count(width, count);
        let w = width as u64;
        self.read_dst(dst, width, true, inst);
        self.s(TA);
        if raw == 0 {
            // No flags; the destination is still written (32-bit zero extension).
            self.write_dst(dst, width, TA);
            return;
        }
        let raw64 = raw as u64;
        let rotate = raw64 % w;
        let narrow = width == 32 && self.env.i32_ops;
        match code {
            // (P4.20: the 32-bit forms in i32, the count below 32)
            _ if narrow => {
                let (count, rotate) = (raw as i32, rotate as i32);
                self.op32(TA, None, |b| match code {
                    4 | 6 => {
                        b.const_i32(count);
                        b.shl_i32();
                    },
                    5 => {
                        b.const_i32(count);
                        b.shr_u_i32();
                    },
                    7 => {
                        b.const_i32(count);
                        b.shr_s_i32();
                    },
                    0 => {
                        b.const_i32(rotate);
                        b.rotl_i32();
                    },
                    _ => {
                        b.const_i32(rotate);
                        b.rotr_i32();
                    },
                });
            },
            4 | 6 => {
                self.g(TA);
                self.c64(raw64);
                self.b.shl_i64();
                self.mask_to(width);
            },
            5 => {
                if raw64 >= w {
                    self.c64(0);
                }
                else {
                    self.g(TA);
                    self.c64(raw64);
                    self.b.shr_u_i64();
                }
            },
            7 => {
                self.g(TA);
                self.sext(width);
                self.c64(raw64);
                self.b.shr_s_i64();
                self.mask_to(width);
            },
            _ => {
                if rotate == 0 {
                    self.g(TA);
                }
                else if width == 64 {
                    self.g(TA);
                    self.c64(rotate);
                    self.b
                        .op(if code == 0 { op::OP_I64ROTL } else { op::OP_I64ROTR });
                }
                else {
                    let (left, right) =
                        if code == 0 { (rotate, w - rotate) } else { (w - rotate, rotate) };
                    self.g(TA);
                    self.c64(left);
                    self.b.shl_i64();
                    self.g(TA);
                    self.c64(right);
                    self.b.shr_u_i64();
                    self.b.or_i64();
                    self.mask_to(width);
                }
            },
        }
        self.s(TR);
        self.write_dst(dst, width, TR);
        if need == 0 {
            return;
        }
        self.flags_begin(need);
        let mut first = true;
        if need & CF != 0 {
            match code {
                4 | 6 if raw64 <= w => self.bit_of(TA, (w - raw64) as u8, 0),
                5 if raw64 <= w => self.bit_of(TA, (raw64 - 1) as u8, 0),
                4 | 5 | 6 => self.c32(0),
                7 => self.bit_of(TA, if raw64 >= w { width - 1 } else { raw - 1 }, 0),
                0 => self.bit_of(if rotate == 0 { TA } else { TR }, 0, 0),
                _ => self.bit_of(if rotate == 0 { TA } else { TR }, width - 1, 0),
            }
            self.join(&mut first);
        }
        if code >= 4 {
            self.szp(TR, need, width, &mut first);
        }
        if raw == 1 && need & OF != 0 {
            match code {
                4 | 6 => {
                    self.bit_of(TR, width - 1, 0);
                    self.bit_of(TA, width - 1, 0);
                    self.b.xor_i32();
                },
                5 => self.bit_of(TA, width - 1, 0),
                7 => self.c32(0),
                0 => {
                    self.bit_of(TR, width - 1, 0);
                    self.bit_of(TR, 0, 0);
                    self.b.xor_i32();
                },
                _ => {
                    self.bit_of(TR, width - 1, 0);
                    self.bit_of(TR, width - 2, 0);
                    self.b.xor_i32();
                },
            }
            self.c32(11);
            self.b.shl_i32();
            self.join(&mut first);
        }
        self.flags_end(first);
    }

    /// SHL/SHR/SAR r/m32/64, CL (count below the width once masked).
    fn shift_cl(&mut self, inst: &Inst, code: u8, width: u8, dst: Opnd, need: u32) {
        self.read_dst(dst, width, true, inst);
        self.s(TA);
        self.g(1);
        self.c64(width as u64 - 1);
        self.b.and_i64();
        self.s(TC);
        match code {
            // ROL ROR: the masked count is below the width
            0 | 1 if width == 64 => {
                self.g(TA);
                self.g(TC);
                self.b
                    .op(if code == 0 { op::OP_I64ROTL } else { op::OP_I64ROTR });
            },
            0 | 1 => {
                self.g(TA);
                self.b.wrap_i64_to_i32();
                self.g(TC);
                self.b.wrap_i64_to_i32();
                if code == 0 {
                    self.b.rotl_i32()
                }
                else {
                    self.b.rotr_i32()
                }
                self.b.extend_unsigned_i32_to_i64();
            },
            4 | 6 => {
                self.g(TA);
                self.g(TC);
                self.b.shl_i64();
                self.mask_to(width);
            },
            5 => {
                self.g(TA);
                self.g(TC);
                self.b.shr_u_i64();
            },
            _ => {
                self.g(TA);
                self.sext(width);
                self.g(TC);
                self.b.shr_s_i64();
                self.mask_to(width);
            },
        }
        self.s(TR);
        self.write_dst(dst, width, TR);
        if need == 0 {
            return;
        }
        if code <= 1 {
            // A nonzero count sets CF from the result, OF only for a count of 1.
            self.g(TC);
            self.b.op(op::OP_I64EQZ);
            self.b.eqz_i32();
            self.b.if_void();
            if need & CF != 0 {
                self.flags_begin(CF);
                self.bit_of(TR, if code == 0 { 0 } else { width - 1 }, 0);
                self.flags_end(false);
            }
            if need & OF != 0 {
                self.g(TC);
                self.c64(1);
                self.b.eq_i64();
                self.b.if_void();
                self.flags_begin(OF);
                self.bit_of(TR, width - 1, 0);
                self.bit_of(TR, if code == 0 { 0 } else { width - 2 }, 0);
                self.b.xor_i32();
                self.c32(11);
                self.b.shl_i32();
                self.flags_end(false);
                self.b.block_end();
            }
            self.b.block_end();
            return;
        }
        // A zero count leaves all flags unchanged.
        self.g(TC);
        self.b.op(op::OP_I64EQZ);
        self.b.eqz_i32();
        self.b.if_void();
        let base = need & (CF | PF | ZF | SF);
        if base != 0 {
            self.flags_begin(base);
            let mut first = true;
            if base & CF != 0 {
                self.g(TA);
                if matches!(code, 4 | 6) {
                    self.c64(width as u64);
                    self.g(TC);
                    self.b.sub_i64();
                }
                else {
                    self.g(TC);
                    self.c64(1);
                    self.b.sub_i64();
                }
                self.b.shr_u_i64();
                self.b.wrap_i64_to_i32();
                self.c32(1);
                self.b.and_i32();
                self.join(&mut first);
            }
            self.szp(TR, base, width, &mut first);
            self.flags_end(first);
        }
        if need & OF != 0 {
            self.g(TC);
            self.c64(1);
            self.b.eq_i64();
            self.b.if_void();
            self.flags_begin(OF);
            match code {
                4 | 6 => {
                    self.bit_of(TR, width - 1, 0);
                    self.bit_of(TA, width - 1, 0);
                    self.b.xor_i32();
                },
                5 => self.bit_of(TA, width - 1, 0),
                _ => self.c32(0),
            }
            self.c32(11);
            self.b.shl_i32();
            self.flags_end(false);
            self.b.block_end();
        }
        self.b.block_end();
    }
}

impl Emitter {
    fn load_selector(&mut self, segment: u8) {
        self.c32(gp::sreg as i32 + segment as i32 * 2);
        self.b.memory_op(op::OP_I64LOAD16U, op::MEM_ALIGN16, 0);
    }
    /// Load segment register `segment` (ES, DS, FS, GS) with the selector in
    /// the i64 on the stack (legacy mode, P7.3): pages::x64_page_load_seg,
    /// as Tier-0's ir_t0_load_seg; a refusal (nothing changed) retries. ST
    /// is then 2 if the code no longer runs here (leave_unless_runnable)
    fn load_segment(&mut self, segment: u8, start: u64) {
        self.b.wrap_i64_to_i32();
        self.si(ST);
        self.c32(segment as i32);
        self.gi(ST);
        self.c32(self.env.segmented as i32);
        self.b.call_signature(
            "x64_page_load_seg",
            Signature::new(
                &[WasmType::I32, WasmType::I32, WasmType::I32],
                &[WasmType::I32],
            ),
        );
        self.ti(ST);
        self.c32(1);
        self.b.eq_i32();
        self.retry_if(start);
    }
    /// After load_segment's instruction: leave for `next` when ST says so
    fn leave_unless_runnable(&mut self, next: u64) {
        self.gi(ST);
        self.b.if_void();
        self.retired();
        self.leave_to(self.f().exit, next);
        self.b.block_end();
    }
    /// POP m16 or m32 (legacy mode, P7.3): the value at ESP stored to the
    /// address computed with ESP after the pop (as instr32_8F_0_mem), then
    /// ESP moves; both accesses are validated before anything changes
    fn pop_memory(&mut self, address: AddressExpr, width: u8, inst: &Inst) {
        let (start, bytes) = (inst.d.start.0, width as u64 / 8);
        self.stack_sized(0, bytes as u32, false, start);
        self.gi(HOST);
        self.load(width);
        self.s(TV);
        let destination = match address.base {
            AddressBase::Register(4) => AddressExpr {
                displacement: address.displacement.wrapping_add(bytes as i64),
                ..address
            },
            _ => address,
        };
        self.prepare_store(&destination, width, inst);
        self.gi(HOST);
        self.g(TV);
        self.store(width);
        self.adjust_sp(bytes);
    }
    /// Step the instruction (in place) when the i32 on the stack is nonzero.
    fn step_if(&mut self, start: u64) {
        self.b.if_void();
        self.leave_to(self.f().step, start);
        self.b.block_end();
    }
    /// Retry when the i32 on the stack is nonzero.
    fn retry_if(&mut self, start: u64) {
        self.b.if_void();
        self.leave_to(self.f().retry, start);
        self.b.block_end();
    }
    fn divide(&mut self, inst: &Inst, signed: bool, width: u8, src: Opnd) {
        let start = inst.d.start.0;
        self.read(src, width, inst);
        self.s(TB);
        self.is_zero(TB);
        self.retry_if(start);
        if width == 64 {
            // RDX must be the (sign) extension of RAX: a wide dividend retries
            self.g(2);
            if signed {
                self.g(0);
                self.c64(63);
                self.b.shr_s_i64();
                self.b.ne_i64();
                self.retry_if(start);
                // MIN / -1 overflows
                self.g(TB);
                self.c64(u64::MAX);
                self.b.eq_i64();
                self.g(0);
                self.c64(1 << 63);
                self.b.eq_i64();
                self.b.and_i32();
                self.retry_if(start);
            }
            else {
                self.c64(0);
                self.b.ne_i64();
                self.retry_if(start);
            }
            self.g(0);
            self.s(TA);
        }
        else if width == 16 {
            // DX:AX (16-bit code, P7.7): a 32-bit dividend, no i64 overflow
            self.g(2);
            self.mask_to(16);
            self.c64(16);
            self.b.shl_i64();
            self.g(0);
            self.mask_to(16);
            self.b.or_i64();
            if signed {
                self.sext(32);
            }
            self.s(TA);
            if signed {
                self.g(TB);
                self.sext(16);
                self.s(TB);
            }
        }
        else {
            // EDX:EAX
            self.g(2);
            self.c64(32);
            self.b.shl_i64();
            self.g(0);
            self.mask_to(32);
            self.b.or_i64();
            self.s(TA);
            if signed {
                self.g(TB);
                self.sext(32);
                self.s(TB);
                self.g(TB);
                self.c64(u64::MAX);
                self.b.eq_i64();
                self.g(TA);
                self.c64(1 << 63);
                self.b.eq_i64();
                self.b.and_i32();
                self.retry_if(start);
            }
        }
        self.g(TA);
        self.g(TB);
        self.b
            .op(if signed { op::OP_I64DIVS } else { op::OP_I64DIVU });
        self.s(TR);
        if width < 64 {
            // the quotient must fit
            self.g(TR);
            if signed {
                self.sext(width);
            }
            else {
                self.mask_to(width);
            }
            self.g(TR);
            self.b.ne_i64();
            self.retry_if(start);
        }
        if self.env.compat {
            // (the 32-bit modes, P7.3: the remainder from the quotient, one
            // multiply where engines emit a second division for i64.rem; the
            // quotient is exact, so the dividend less quotient * divisor)
            self.g(TA);
            self.g(TR);
            self.g(TB);
            self.b.mul_i64();
            self.b.sub_i64();
        }
        else {
            self.g(TA);
            self.g(TB);
            self.b
                .op(if signed { op::OP_I64REMS } else { op::OP_I64REMU });
        }
        self.s(TV);
        self.g(TR);
        self.set_reg(RAX, width);
        self.g(TV);
        self.set_reg(RDX, width);
    }
    /// Direction: +size, or -size with EFLAGS.DF.
    fn step_size(&mut self, size: u64) {
        self.c64(size.wrapping_neg());
        self.c64(size);
        self.gi(FL);
        self.c32(0x400);
        self.b.and_i32();
        self.b.select();
    }
    fn string(&mut self, inst: &Inst, movs: bool, width: u8, rep: bool) {
        let start = inst.d.start.0;
        let size = width as u64 / 8;
        if !rep {
            if movs {
                self.lookup_base = Some((6, 0));
                self.g(6);
                self.segment_base(inst.d.prefixes.segment.unwrap_or(3));
                self.s(ADDR);
                self.host(size as u32, false, start);
                self.load(width);
                self.s(TV);
            }
            self.lookup_base = Some((7, 0));
            self.g(7);
            self.segment_base(0);
            self.s(ADDR);
            self.host(size as u32, true, start);
            if movs {
                self.g(TV);
            }
            else {
                self.get_reg(RAX, width);
            }
            self.store(width);
            self.step_size(size);
            self.s(TX);
            for register in if movs { [6, 7].as_slice() } else { [7].as_slice() } {
                self.g(*register);
                self.g(TX);
                self.b.add_i64();
                if self.env.compat {
                    self.wrap32();
                }
                self.s(*register);
            }
            return;
        }
        // REP: all at once when it stays inside one page per operand, going
        // forward (and, for wide STOS, stores zero); else an interpreter step
        // (an element, or a chunk of RAM) that dispatches back to this block.
        // RCX = 0: nothing happens
        self.g(1);
        self.b.op(op::OP_I64EQZ);
        self.b.eqz_i32();
        self.b.if_void();
        self.gi(FL);
        self.c32(0x400);
        self.b.and_i32();
        self.g(1);
        self.c64(4096 / size);
        self.b.op(op::OP_I64GTU);
        self.b.or_i32();
        if !movs && width != 8 {
            self.get_reg(RAX, width);
            self.c64(0);
            self.b.ne_i64();
            self.b.or_i32();
        }
        self.step_if(start);
        // length in bytes, within 4096
        self.g(1);
        self.c64(size);
        self.b.mul_i64();
        self.b.wrap_i64_to_i32();
        self.si(COND);
        for (register, _) in
            if movs { [(6, false), (7, true)].as_slice() } else { [(7, true)].as_slice() }
        {
            self.g(*register);
            // (the linear address's page offset, with segment bases)
            self.segment_base(if *register == 6 {
                inst.d.prefixes.segment.unwrap_or(3)
            }
            else {
                0
            });
            self.b.wrap_i64_to_i32();
            self.c32(4095);
            self.b.and_i32();
            self.gi(COND);
            self.b.add_i32();
            self.c32(4096);
            self.b.gtu_i32();
            self.step_if(start);
        }
        if movs {
            self.lookup_base = Some((6, 0));
            self.g(6);
            self.segment_base(inst.d.prefixes.segment.unwrap_or(3));
            self.s(ADDR);
            self.host_or(1, false, start, self.f().step);
            self.si(SRC);
            self.lookup_base = Some((7, 0));
            self.g(7);
            self.segment_base(0);
            self.s(ADDR);
            self.host_or(1, true, start, self.f().step);
            self.si(HOST);
            // an overlapping forward copy repeats the source (element order)
            self.gi(HOST);
            self.gi(SRC);
            self.b.gtu_i32();
            self.gi(HOST);
            self.gi(SRC);
            self.gi(COND);
            self.b.add_i32();
            self.b.ltu_i32();
            self.b.and_i32();
            self.step_if(start);
            // (a string operation's elements are not ordered among themselves,
            // but with respect to the other instructions: fenced with workers)
            self.b.guest_fence();
            self.gi(HOST);
            self.gi(SRC);
            self.gi(COND);
            crate::x86tpl::string::memory_copy(&mut self.b);
            self.b.guest_fence();
        }
        else {
            self.lookup_base = Some((7, 0));
            self.g(7);
            self.segment_base(0);
            self.s(ADDR);
            self.host_or(1, true, start, self.f().step);
            self.si(HOST);
            self.b.guest_fence();
            self.gi(HOST);
            self.g(0);
            self.b.wrap_i64_to_i32();
            self.gi(COND);
            crate::x86tpl::string::memory_fill(&mut self.b);
            self.b.guest_fence();
        }
        if self.env.compat {
            self.note_rep(|e| {
                e.g(1);
                e.b.wrap_i64_to_i32();
            });
        }
        self.gi(COND);
        self.b.extend_unsigned_i32_to_i64();
        self.s(TX);
        for register in if movs { [6, 7].as_slice() } else { [7].as_slice() } {
            self.g(*register);
            self.g(TX);
            self.b.add_i64();
            if self.env.compat {
                self.wrap32();
            }
            self.s(*register);
        }
        self.c64(0);
        self.s(1);
        self.b.block_end();
    }
    /// Push the high 64 bits of the 128-bit product of i64 locals `a` and
    /// `b` (signed or unsigned), from 32-bit halves (TC and TX are scratch).
    fn mul_high(&mut self, a: usize, b: usize, signed: bool) {
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
        // TC = lo(a) * lo(b) >> 32
        half(self, a, false);
        half(self, b, false);
        self.b.mul_i64();
        self.c64(32);
        self.b.shr_u_i64();
        self.s(TC);
        // TX = hi(a) * lo(b) + TC (no carry out of 64 bits)
        half(self, a, true);
        half(self, b, false);
        self.b.mul_i64();
        self.g(TC);
        self.b.add_i64();
        self.s(TX);
        // TC = lo(a) * hi(b) + lo(TX)
        half(self, a, false);
        half(self, b, true);
        self.b.mul_i64();
        half(self, TX, false);
        self.b.add_i64();
        self.s(TC);
        // hi(a) * hi(b) + hi(TX) + hi(TC)
        half(self, a, true);
        half(self, b, true);
        self.b.mul_i64();
        half(self, TX, true);
        self.b.add_i64();
        half(self, TC, true);
        self.b.add_i64();
        if signed {
            // minus b when a is negative, minus a when b is negative
            for (x, y) in [(a, b), (b, a)] {
                self.g(x);
                self.c64(63);
                self.b.shr_s_i64();
                self.g(y);
                self.b.and_i64();
                self.b.sub_i64();
            }
        }
    }
    /// REPE/REPNE CMPS or SCAS inside one page per operand, forward: one
    /// loop over the elements, EFLAGS of the last comparison; anything else
    /// is stepped (the step dispatches back here to continue).
    /// Legacy mode: `count`'s i32, elements of a REP string instruction run
    /// here, onto gp::x64_page_rep_elements, which the activation adds to the
    /// core's statistics (a call here would spill the function's registers:
    /// 563.memops 0.92)
    fn note_rep(&mut self, count: impl FnOnce(&mut Self)) {
        self.c32(gp::x64_page_rep_elements as i32);
        self.b.load_fixed_i32(gp::x64_page_rep_elements as u32);
        count(self);
        self.b.add_i32();
        self.b.store_aligned_i32(0);
    }
    fn rep_compare(&mut self, inst: &Inst, width: u8, scan: bool, equal: bool) {
        let start = inst.d.start.0;
        let size = width as u64 / 8;
        self.materialize_if(ARITH);
        // RCX = 0: nothing happens
        self.g(1);
        self.b.op(op::OP_I64EQZ);
        self.b.eqz_i32();
        self.b.if_void();
        self.gi(FL);
        self.c32(0x400);
        self.b.and_i32();
        self.g(1);
        self.c64(4096 / size);
        self.b.op(op::OP_I64GTU);
        self.b.or_i32();
        self.step_if(start);
        // at most this many bytes, within 4096
        self.g(1);
        self.c64(size);
        self.b.mul_i64();
        self.b.wrap_i64_to_i32();
        self.si(COND);
        for register in if scan { [7].as_slice() } else { [6, 7].as_slice() } {
            self.g(*register);
            // (the linear address's page offset, with segment bases)
            self.segment_base(if *register == 6 {
                inst.d.prefixes.segment.unwrap_or(3)
            }
            else {
                0
            });
            self.b.wrap_i64_to_i32();
            self.c32(4095);
            self.b.and_i32();
            self.gi(COND);
            self.b.add_i32();
            self.c32(4096);
            self.b.gtu_i32();
            self.step_if(start);
        }
        if !scan {
            self.lookup_base = Some((6, 0));
            self.g(6);
            self.segment_base(inst.d.prefixes.segment.unwrap_or(3));
            self.s(ADDR);
            self.host_or(1, false, start, self.f().step);
            self.si(SRC);
        }
        self.lookup_base = Some((7, 0));
        self.g(7);
        self.segment_base(0);
        self.s(ADDR);
        self.host_or(1, false, start, self.f().step);
        self.si(HOST);
        // (the elements are plain loads, ordered as a whole by a fence with
        // cores in workers; any alignment)
        let plain = |e: &mut Self, base: usize| {
            e.gi(base);
            e.gi(ENT);
            e.b.add_i32();
            e.b.memory_op(
                match width {
                    8 => op::OP_I64LOAD8U,
                    16 => op::OP_I64LOAD16U,
                    32 => op::OP_I64LOAD32U,
                    _ => op::OP_I64LOAD,
                },
                op::MEM_NO_ALIGN,
                0,
            );
        };
        if scan {
            self.get_reg(RAX, width);
            self.s(TA);
        }
        self.c32(0);
        self.si(ENT);
        let again = self.b.loop_void();
        if !scan {
            plain(self, SRC);
            self.s(TA);
        }
        plain(self, HOST);
        self.s(TB);
        self.gi(ENT);
        self.c32(size as i32);
        self.b.add_i32();
        self.si(ENT);
        self.g(TA);
        self.g(TB);
        if equal {
            self.b.eq_i64();
        }
        else {
            self.b.ne_i64();
        }
        self.gi(ENT);
        self.gi(COND);
        self.b.ltu_i32();
        self.b.and_i32();
        self.b.br_if(again);
        self.b.block_end();
        self.b.guest_fence();
        // elements done: RCX, RSI, RDI
        if self.env.compat {
            let shift = size.trailing_zeros() as i32;
            self.note_rep(|e| {
                e.gi(ENT);
                e.c32(shift);
                e.b.shr_u_i32();
            });
        }
        self.gi(ENT);
        self.b.extend_unsigned_i32_to_i64();
        self.s(TX);
        self.g(1);
        self.g(TX);
        self.c64(size.trailing_zeros() as u64);
        self.b.shr_u_i64();
        self.b.sub_i64();
        self.s(1);
        for register in if scan { [7].as_slice() } else { [6, 7].as_slice() } {
            self.g(*register);
            self.g(TX);
            self.b.add_i64();
            if self.env.compat {
                self.wrap32();
            }
            self.s(*register);
        }
        // EFLAGS: the last comparison (and last_op1, its first operand)
        self.note_last_op1(TA);
        self.g(TA);
        self.g(TB);
        self.b.sub_i64();
        self.mask_to(width);
        self.s(TR);
        self.alu_flags(7, width, 0);
        self.record(7, width, ARITH, 0, inst);
        self.b.block_end();
    }
    fn compare_exchange(&mut self, inst: &Inst, wide: bool, address: &AddressExpr) {
        let start = inst.d.start.0;
        self.address(address, inst.d.next.0, true);
        self.s(ADDR);
        if wide {
            self.g(ADDR);
            self.c64(15);
            self.b.and_i64();
            self.b.wrap_i64_to_i32();
            self.retry_if(start);
        }
        self.host(if wide { 16 } else { 8 }, true, start);
        self.si(HOST);
        self.gi(HOST);
        self.load(64);
        self.s(TA);
        if wide {
            self.gi(HOST);
            self.b.guest_load_i64_bits(64, 8);
            self.s(TB);
            self.g(TA);
            self.g(0);
            self.b.eq_i64();
            self.g(TB);
            self.g(2);
            self.b.eq_i64();
            self.b.and_i32();
            self.si(COND);
            self.gi(HOST);
            self.g(3);
            self.g(TA);
            self.gi(COND);
            self.b.select();
            self.store(64);
            self.gi(HOST);
            self.g(1);
            self.g(TB);
            self.gi(COND);
            self.b.select();
            self.b.guest_store_i64_bits(64, 8);
            self.gi(COND);
            self.b.eqz_i32();
            self.b.if_void();
            self.g(TA);
            self.s(0);
            self.g(TB);
            self.s(2);
            self.b.block_end();
        }
        else {
            // EDX:EAX against the qword, ECX:EBX stored on a match
            self.g(2);
            self.c64(32);
            self.b.shl_i64();
            self.g(0);
            self.mask_to(32);
            self.b.or_i64();
            self.g(TA);
            self.b.eq_i64();
            self.si(COND);
            self.gi(HOST);
            self.g(1);
            self.c64(32);
            self.b.shl_i64();
            self.g(3);
            self.mask_to(32);
            self.b.or_i64();
            self.g(TA);
            self.gi(COND);
            self.b.select();
            self.store(64);
            self.gi(COND);
            self.b.eqz_i32();
            self.b.if_void();
            self.g(TA);
            self.set_reg(RAX, 32);
            self.g(TA);
            self.c64(32);
            self.b.shr_u_i64();
            self.set_reg(RDX, 32);
            self.b.block_end();
        }
        self.flags_begin(ZF);
        self.gi(COND);
        self.c32(6);
        self.b.shl_i32();
        self.flags_end(false);
        self.written(ZF);
    }
}

// The immediate shifts of the v128 on the stack (Tier-0's take a local:
// x86tpl::vec::shift_immediate); tests/x86tpl/pagegen_leaf_digests.rs pins
// the output.

/// PSRLx/PSRAx/PSLLx (`bits` 16, 32 or 64: the lane width) and PSRLDQ/PSLLDQ
/// (128: bytes) by imm8 `count` of the v128 on the stack, `kind` the ModRM
/// reg (2 PSRL, 4 PSRA, 6 PSLL, 3 PSRLDQ, 7 PSLLDQ): replace it by the result
fn shift_immediate(w: &mut WasmBuilder, bits: u8, kind: u8, count: u8) {
    let count = count as u32;
    if bits == 128 {
        w.simd_zero();
        w.simd_shuffle(leaves::byte_shift_lanes(count, kind == 3));
    }
    else if count >= bits as u32 && kind != 4 {
        w.drop_();
        w.simd_zero();
    }
    else {
        let shift = match kind {
            6 => Shift::Left,
            4 => Shift::Arithmetic,
            _ => Shift::Logical,
        };
        leaves::shift_lanes(w, bits, shift, count.min(bits as u32 - 1));
    }
}

#[path = "pagegen_vec.rs"]
mod pagegen_vec;

#[cfg(test)]
#[path = "../../../tests/x86tpl/pagegen_leaf_digests.rs"]
mod pagegen_leaf_digests;

/// STI and the instruction in its shadow compiled together (x64_sti_shadow,
/// docs/jit-unification-plan.md P4.5d)
#[cfg(test)]
mod sti_shadow_tests {
    use super::{compile_with, CompileEnv, PAGE};

    fn compiled(page: &[u8], sti_shadow: bool) -> Vec<u8> {
        let env = CompileEnv::replay(
            true,
            true,
            true,
            false,
            false,
            true,
            sti_shadow,
            false,
            1024,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            None,
            false,
            &[],
        );
        compile_with(&env, page, &[], &[0], "sti".into())
            .expect("compiled")
            .bytes
    }
    fn imports_irq_window(bytes: &[u8]) -> bool {
        bytes.windows(19).any(|w| w == b"x64_page_irq_window")
    }

    #[test]
    fn sti_and_its_shadow_compile_together() {
        // STI; NOP; CLI; RET
        let mut page = vec![0xCC; PAGE];
        page[..4].copy_from_slice(&[0xFB, 0x90, 0xFA, 0xC3]);
        assert!(imports_irq_window(&compiled(&page, true)));
        assert!(!imports_irq_window(&compiled(&page, false)));
    }

    #[test]
    fn a_discovery_cut_short_before_sti_keeps_it_apart() {
        // 20 JZ to 20 runs of 160 NOPs and RET; the first run (discovered
        // last, after the decoding limit) ends in STI; NOP; CLI; RET, so
        // the CLI after the shadow is no block start
        let mut page = vec![0xCC; PAGE];
        let target = |k: usize| 0x100 + k * 0xA8;
        for k in 0..20 {
            let at = k * 6;
            let rel = (target(k) as i32 - (at as i32 + 6)).to_le_bytes();
            page[at..at + 6].copy_from_slice(&[0x0F, 0x84, rel[0], rel[1], rel[2], rel[3]]);
        }
        page[120] = 0xC3;
        for k in 0..20 {
            page[target(k)..target(k) + 160].fill(0x90);
            page[target(k) + 160] = 0xC3;
        }
        page[target(0) + 160..target(0) + 164].copy_from_slice(&[0xFB, 0x90, 0xFA, 0xC3]);
        // (it compiled into End::Shadow at a non-start, which panicked)
        assert!(!imports_irq_window(&compiled(&page, true)));
    }
}
