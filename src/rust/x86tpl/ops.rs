//! Vector templates that every x86 engine instantiates alike
//! (docs/jit-unification-plan.md P2.4): the SSE arithmetic, the masked
//! compares and the conversions, over an engine's VecOperands. Their
//! admission is native_fp's. What differs between the engines is a property
//! of the operands: where a refused instruction goes (in_place: the exact
//! helper x64::helpers::x64_sse_fp where it stands, as IR Tier-0 ran it until
//! P7.5; else the page tier retries in the interpreter), and the register
//! facts an engine keeps (facts).
//!
//! A template reads its operands and passes every retry point before its
//! first write (store_vec, store_int), so a retry finds the CPU as it was.
use super::native_fp::{self, Lanes};
use super::vec::{
    clean_bits, compare_relation, conversion_inexact, convert_facts, convert_integer,
    float_arithmetic, float_claims, float_facts, integer_conversion_inexact, known_clean, packed,
    Packed,
};
use crate::cpu::global_pointers as gp;
use crate::ir::helper::imports::signature;
use crate::wasmgen::wasm_builder::{WasmBuilder, WasmLocalV128};

/// An engine's register facts (the page tier's Emitter::xmm_clean: per register, the lanes known to be neither NaN nor
/// denormal) and the instruction's registers
pub struct Facts<'a> {
    pub clean: &'a mut [u8],
    /// The destination
    pub reg: u8,
    /// The first source: the destination, or VEX.vvvv
    pub first: u8,
    /// The r/m register (None: memory)
    pub source: Option<u8>,
}

/// One instruction's operands in an engine (see the module comment)
pub trait VecOperands {
    fn w(&mut self) -> &mut WasmBuilder;
    /// Push the first source register (the destination, or VEX.vvvv)
    fn first(&mut self);
    /// Push the r/m operand: `bytes` of memory, zero-extended (an aligned
    /// m128 checked), or an XMM register, its low `bytes` zero-extended, or
    /// `whole` (the forms that use only the low lane)
    fn source(&mut self, bytes: u8, whole: bool);
    /// Push XMM `r`, whole (another register the form names, such as
    /// BLENDV's mask)
    fn register(&mut self, r: u8);
    /// The XMM/YMM registers there are: 8 outside 64-bit mode, else 16
    fn registers(&self) -> u8;
    /// Whether the r/m operand is memory
    fn memory(&self) -> bool;
    /// Push bits 255:128 of the first source (VEX.256)
    fn first_high(&mut self);
    /// Push bits 255:128 of the r/m register (VEX.256 register forms)
    fn source_high(&mut self);
    /// The m256 r/m operand's halves in two locals, low and high (VEX.256;
    /// `aligned`: 32-byte aligned, else a retry)
    fn source256(&mut self, aligned: bool) -> [WasmLocalV128; 2];
    /// Write YMM destination = (`low`, `high`)
    fn store256(&mut self, low: &WasmLocalV128, high: &WasmLocalV128);
    /// Write `halves` to the r/m operand: the m256 (`aligned`: 32-byte, else
    /// a retry, before anything is written) or the YMM register
    fn store256_rm(&mut self, halves: &[WasmLocalV128; 2], aligned: bool);
    /// Zero bits 255:128 of YMM `r`
    fn zero_upper(&mut self, r: u8);
    /// Push the destination register's value (FMA reads it)
    fn destination(&mut self);
    /// Whether the host's relaxed multiply-adds fuse (FMA natively,
    /// native_fp::fused)
    fn relaxed_fma(&self) -> bool;
    /// The address of the exact helpers' operand block
    /// (runtime::tier0::T0_SSE_FP, pinned when compilations replay)
    fn sse_fp_operands(&self) -> u32;
    /// XMM `r` = `value`, bits 255:128 zeroed (a VEX form's write)
    fn store_register(&mut self, r: u8, value: &WasmLocalV128);
    /// Write the low `bytes` of `value` to the destination, keeping the
    /// first source's other bytes (16: all of `value`)
    fn store_vec(&mut self, value: &WasmLocalV128, bytes: u8);
    /// Write the integer on the stack, an i32 (an i64 if `wide`), to the
    /// destination register
    fn store_int(&mut self, wide: bool);
    /// Retry the instruction in the interpreter if the i32 on the stack is
    /// nonzero
    fn retry_if(&mut self);
    /// Push i32 nonzero if MXCSR refuses native results
    /// (native_fp::mxcsr_refused: PE set; the templates that find inexact
    /// results themselves, where detects_inexact, ask
    /// native_fp::mxcsr_refused_any_pe instead)
    fn mxcsr_refused(&mut self);
    /// Whether a refused instruction runs exactly in place (exact_open);
    /// else it retries
    fn in_place(&self) -> bool;
    /// Whether the conversion templates may run with MXCSR.PE clear and set
    /// it for an inexact result themselves (the page tier); else they ask
    /// mxcsr_refused, which wants PE set
    fn detects_inexact(&self) -> bool { false }
    /// If the i32 on the stack is nonzero, open a block that runs the
    /// instruction exactly on (`destination`, `source`) with `imm8` (None:
    /// the instruction's own); a fault retries
    fn exact_open(
        &mut self,
        destination: &WasmLocalV128,
        source: &WasmLocalV128,
        imm8: Option<u32>,
    );
    /// Push the v128 result of exact_open's run
    fn exact_result(&mut self);
    /// The register facts, if the engine keeps them
    fn facts(&mut self) -> Option<Facts<'_>> { None }

    /// Refuse the instruction if the i32 on the stack is nonzero: `result`
    /// is the exact one (in place), or it retries
    fn refused(
        &mut self,
        destination: &WasmLocalV128,
        source: &WasmLocalV128,
        imm8: Option<u32>,
        result: &WasmLocalV128,
    ) {
        if self.in_place() {
            self.exact_open(destination, source, imm8);
            self.exact_result();
            self.w().set_local_v128(result);
            self.w().block_end();
        }
        else {
            self.retry_if();
        }
    }
}

/// Whether the first source and the r/m register are known to hold `lanes`
/// clean (nothing is known without facts)
fn known<T: VecOperands>(t: &mut T, lanes: u8) -> [bool; 2] {
    t.facts().map_or([false; 2], |f| {
        known_clean(f.clean, lanes, f.first, f.source)
    })
}
/// The first source's facts, read before the destination is written
fn first_facts<T: VecOperands>(t: &mut T) -> u8 {
    t.facts().map_or(0, |f| f.clean[f.first as usize])
}

/// The bytes a form reads and writes: 16 packed, else the low lane
fn lane_bytes(double: bool, scalar: bool) -> u8 {
    match (scalar, double) {
        (false, _) => 16,
        (true, true) => 8,
        (true, false) => 4,
    }
}

/// SQRT (`opcode` 0x51), RSQRT (0x52), RCP (0x53), ADD (0x58), MUL (0x59),
/// SUB (0x5C), MIN (0x5D), DIV (0x5E) and MAX (0x5F), PS, PD, SS and SD:
/// natively only where the result is cpu::simd_fp's, MXCSR too
pub fn float<T: VecOperands>(t: &mut T, opcode: u8, double: bool, scalar: bool) {
    if t.detects_inexact() && matches!(opcode, 0x51 | 0x58 | 0x59 | 0x5C | 0x5E) {
        return float_inexact(t, opcode, double, scalar);
    }
    let bytes = lane_bytes(double, scalar);
    // Scalar forms compute (and NaN-check) only the low lane.
    t.source(bytes, true);
    let src = t.w().set_new_local_v128();
    t.first();
    let dst = t.w().set_new_local_v128();
    float_arithmetic(t.w(), opcode, double, &dst, &src);
    let result = t.w().set_new_local_v128();
    if matches!(opcode, 0x52 | 0x53) {
        native_fp::reciprocal_refused(t.w(), opcode, scalar, &src, &result);
    }
    else {
        let lanes = clean_bits(double, scalar);
        let source = t.facts().and_then(|f| f.source);
        let known = known(t, lanes);
        // a cheap first test where it saves work (zeros fail it)
        let unsure = native_fp::arithmetic_unsure(
            t.w(),
            opcode,
            double,
            scalar,
            [&dst, &src],
            known,
            &result,
        );
        if unsure {
            // (no hint: zero-heavy data takes this path every time)
            t.w().if_void();
        }
        native_fp::arithmetic_refused(t.w(), opcode, double, scalar, [&dst, &src], known, &result);
        // (the facts of an admitted form hold only for admitted operands:
        // float_claims; an engine without facts claims nothing)
        let claims = t.facts().is_some() && float_claims(opcode, source, known);
        if claims {
            t.retry_if();
        }
        else {
            t.refused(&dst, &src, None, &result);
        }
        if unsure {
            t.w().block_end();
        }
        if !matches!(opcode, 0x5D | 0x5F) {
            // (a second exact run after refused lanes is harmless)
            t.mxcsr_refused();
            t.refused(&dst, &src, None, &result);
        }
    }
    if matches!(opcode, 0x52 | 0x53) {
        t.refused(&dst, &src, None, &result);
    }
    let before = first_facts(t);
    t.store_vec(&result, bytes);
    for v in [src, dst, result] {
        t.w().free_local_v128(v);
    }
    if let Some(f) = t.facts() {
        float_facts(f.clean, opcode, double, scalar, f.reg, f.source, before);
    }
}

/// float's SQRT, ADD, MUL, SUB and DIV for an engine that sets PE itself
/// (detects_inexact: the page tier, docs/jit-unification-plan.md P4.18),
/// where MXCSR.PE may be clear and DAZ or FZ set. With mxcsr_refused's
/// condition an admitted result is final, as for Tier-0. Else (rarely),
/// with every exception masked and rounding to nearest: FZ refuses a sum or
/// difference it would flush, and with PE clear an inexact result sets PE
/// (native_fp::inexact). Refused lanes, any other MXCSR and what
/// native_fp::inexact cannot decide take the engine's refused path (in
/// place: the exact helper).
fn float_inexact<T: VecOperands>(t: &mut T, opcode: u8, double: bool, scalar: bool) {
    let bytes = lane_bytes(double, scalar);
    t.source(bytes, true);
    let src = t.w().set_new_local_v128();
    t.first();
    let dst = t.w().set_new_local_v128();
    float_arithmetic(t.w(), opcode, double, &dst, &src);
    let result = t.w().set_new_local_v128();
    let lanes = clean_bits(double, scalar);
    let source = t.facts().and_then(|f| f.source);
    let known = known(t, lanes);
    // (facts that hold only for admitted operands retry the refused ones:
    // float_claims)
    let claims = t.facts().is_some() && float_claims(opcode, source, known);
    t.w().const_i32(0);
    let refused = t.w().set_new_local();
    let unsure =
        native_fp::arithmetic_unsure(t.w(), opcode, double, scalar, [&dst, &src], known, &result);
    if unsure {
        t.w().if_void();
    }
    native_fp::arithmetic_refused(t.w(), opcode, double, scalar, [&dst, &src], known, &result);
    if claims {
        t.retry_if();
    }
    else {
        t.w().set_local(&refused);
    }
    if unsure {
        t.w().block_end();
    }
    t.mxcsr_refused();
    t.w().hint(false);
    t.w().if_void();
    t.w().get_local(&refused);
    t.w().eqz_i32();
    t.w().if_void();
    native_fp::masked_nearest_refused(t.w());
    if matches!(opcode, 0x58 | 0x5C) {
        native_fp::flush_to_zero(t.w());
        native_fp::flushed(t.w(), double, scalar, &result);
        t.w().and_i32();
        t.w().or_i32();
    }
    t.w().tee_local(&refused);
    t.w().eqz_i32();
    t.w().if_void();
    native_fp::precision_clear(t.w());
    t.w().if_void();
    if native_fp::inexact_decides(opcode, double) {
        if native_fp::inexact_undecided(t.w(), opcode, double, scalar, [&dst, &src], &result) {
            t.w().tee_local(&refused);
            t.w().eqz_i32();
            t.w().if_void();
        }
        native_fp::inexact(t.w(), opcode, double, scalar, [&dst, &src], &result);
        native_fp::inexact_pe(t.w());
        if double && matches!(opcode, 0x59 | 0x5E) {
            t.w().block_end();
        }
    }
    else {
        t.w().const_i32(1);
        t.w().set_local(&refused);
    }
    t.w().block_end();
    t.w().block_end();
    t.w().block_end();
    t.w().block_end();
    t.w().get_local(&refused);
    t.refused(&dst, &src, None, &result);
    t.w().free_local(refused);
    let before = first_facts(t);
    t.store_vec(&result, bytes);
    for v in [src, dst, result] {
        t.w().free_local_v128(v);
    }
    if let Some(f) = t.facts() {
        float_facts(f.clean, opcode, double, scalar, f.reg, f.source, before);
    }
}

/// CMPPS, CMPPD, CMPSS and CMPSD with `predicate` (imm8[2:0], VEX
/// imm8[4:0]): natively for operands neither NaN nor denormal, which raise
/// nothing and whose result imm8[2:0] decides (simd_fp::Fp::compare)
pub fn compare_mask<T: VecOperands>(t: &mut T, double: bool, scalar: bool, predicate: u8) {
    let bytes = lane_bytes(double, scalar);
    t.source(bytes, true);
    let src = t.w().set_new_local_v128();
    t.first();
    let dst = t.w().set_new_local_v128();
    compare_relation(t.w(), double, predicate, &dst, &src);
    let result = t.w().set_new_local_v128();
    let known = known(t, clean_bits(double, scalar));
    if known != [true, true] {
        // a NaN or denormal operand raises IE or DE, and a NaN makes them
        // unordered
        let lanes = if scalar { Lanes::Scalar } else { Lanes::Packed };
        native_fp::operands_refused(t.w(), double, lanes, [&dst, &src], known);
        t.refused(&dst, &src, Some(predicate as u32), &result);
    }
    t.store_vec(&result, bytes);
    for v in [src, dst, result] {
        t.w().free_local_v128(v);
    }
}

/// The conversions of one Wasm operation (`opcode`: f64x2.promote_low_f32x4
/// 0x5F, f32x4.demote_f64x2_zero 0x5E, f32x4.convert_i32x4_s 0xFA,
/// f64x2.convert_low_i32x4_s 0xFE) from `source` bytes to `result` bytes:
/// CVTPS2PD, CVTSS2SD, CVTPD2PS, CVTSD2SS, CVTDQ2PS and CVTDQ2PD
pub fn convert<T: VecOperands>(t: &mut T, opcode: u32, source: u8, result: u8) {
    t.source(source, false);
    let x = t.w().set_new_local_v128();
    t.w().get_local_v128(&x);
    t.w().simd(opcode);
    let v = t.w().set_new_local_v128();
    // (the scalar forms CVTSS2SD and CVTSD2SS write less than 16 bytes and
    // keep the destination's upper bytes)
    let scalar = result < 16;
    if scalar {
        t.first();
    }
    else {
        t.w().simd_zero();
    }
    let destination = t.w().set_new_local_v128();
    match opcode {
        // f32 to f64: exact
        0x5F => {
            let lanes = if scalar { Lanes::Scalar } else { Lanes::LowPair };
            let known = known(t, clean_bits(false, scalar))[1];
            native_fp::operands_refused(t.w(), false, lanes, [&x, &x], [known, true]);
        },
        0x5E => native_fp::narrowing_refused(t.w(), scalar, &x, &v),
        _ => t.w().const_i32(0),
    }
    // (an admitted result is a fact: convert_facts)
    t.retry_if();
    if opcode == 0xFA && t.detects_inexact() {
        // CVTDQ2PS raises nothing but PE: an exact result is right in every
        // MXCSR state, an inexact one needs rounding to nearest and PE
        // masked, and sets PE
        conversion_inexact(t.w(), opcode, scalar, &x, &v);
        let inexact = t.w().set_new_local();
        t.w().get_local(&inexact);
        native_fp::rounding_refused(t.w());
        t.w().and_i32();
        t.retry_if();
        t.w().get_local(&inexact);
        native_fp::inexact_pe(t.w());
        t.w().free_local(inexact);
    }
    else if matches!(opcode, 0x5E | 0xFA) {
        // (CVTDQ2PS: only PE)
        if t.detects_inexact() {
            native_fp::mxcsr_refused_any_pe(t.w());
        }
        else {
            t.mxcsr_refused();
        }
        t.refused(&destination, &x, None, &v);
        if t.detects_inexact() {
            conversion_inexact(t.w(), opcode, scalar, &x, &v);
            native_fp::inexact_pe(t.w());
        }
    }
    let before = first_facts(t);
    t.store_vec(&v, result);
    for local in [v, x, destination] {
        t.w().free_local_v128(local);
    }
    if let Some(f) = t.facts() {
        convert_facts(f.clean, opcode, scalar, f.reg, f.source, before);
    }
}

/// CVT(T)PS2DQ and CVT(T)PD2DQ: natively unless a lane is NaN, out of the
/// i32 range or, with MXCSR's condition, inexact
pub fn convert_to_integers<T: VecOperands>(t: &mut T, double: bool, truncate: bool) {
    t.source(16, false);
    let x = t.w().set_new_local_v128();
    t.w().get_local_v128(&x);
    let out_of_range = convert_integer(t.w(), double, truncate);
    let v = t.w().set_new_local_v128();
    // a NaN or out-of-range lane raises IE; an inexact one PE
    t.w().get_local(&out_of_range);
    if t.detects_inexact() {
        native_fp::mxcsr_refused_any_pe(t.w());
    }
    else {
        t.mxcsr_refused();
    }
    t.w().or_i32();
    t.refused(&v, &x, None, &v);
    if t.detects_inexact() {
        integer_conversion_inexact(t.w(), double, truncate, &x);
        native_fp::inexact_pe(t.w());
    }
    t.w().free_local(out_of_range);
    t.store_vec(&v, 16);
    t.w().free_local_v128(v);
    t.w().free_local_v128(x);
}

/// PMOVMSKB (`lane` 1), MOVMSKPS (4) and MOVMSKPD (8) r32, xmm: the sign bits
/// of the lanes (register forms only)
pub fn move_mask<T: VecOperands>(t: &mut T, lane: u8) {
    t.source(16, true);
    t.w().simd(match lane {
        1 => 0x64, // i8x16.bitmask
        4 => 0xA4, // i32x4.bitmask
        _ => 0xC4, // i64x2.bitmask
    });
    t.store_int(false);
}

/// BLENDVPS, BLENDVPD and PBLENDVB (`lane` 4, 8, 1): the source's lanes
/// whose sign bit in XMM `mask` (XMM0, VEX imm8[7:4]) is set
pub fn blend_variable<T: VecOperands>(t: &mut T, lane: u8, mask: u8) {
    t.source(16, false);
    let src = t.w().set_new_local_v128();
    t.first();
    let dst = t.w().set_new_local_v128();
    // the source's lanes where the mask's lane is negative
    t.w().get_local_v128(&src);
    t.w().get_local_v128(&dst);
    t.register(mask);
    t.w().const_i32(lane as i32 * 8 - 1);
    t.w().simd(match lane {
        1 => 0x6C, // i8x16.shr_s
        4 => 0xAC, // i32x4.shr_s
        _ => 0xCC, // i64x2.shr_s
    });
    t.w().simd(0x52); // v128.bitselect
    let result = t.w().set_new_local_v128();
    t.store_vec(&result, 16);
    for v in [src, dst, result] {
        t.w().free_local_v128(v);
    }
}

/// ROUNDPS, ROUNDPD, ROUNDSS and ROUNDSD with `imm8`: Wasm's rounding of the
/// lanes (a scalar form's low one into the destination), imm8[1:0]'s mode,
/// or MXCSR.RC's with imm8[2], admitted to nearest only. Refused: a NaN lane
/// (its payload; an SNaN raises IE), DAZ, and an inexact lane while PE is
/// reported (imm8[3] clear) and unmasked. Denormals need no DE (ROUND has
/// none); a result is integral, never tiny. PE is set here, after the last
/// refusal.
pub fn round<T: VecOperands>(t: &mut T, double: bool, scalar: bool, imm8: u8) {
    let bytes = if double { 8 } else { 4 };
    if scalar {
        t.source(bytes, true);
    }
    else {
        t.source(16, false);
    }
    let source = t.w().set_new_local_v128();
    t.first();
    let destination = t.w().set_new_local_v128();
    let mode = if imm8 & 4 != 0 { 0 } else { imm8 & 3 };
    t.w().get_local_v128(&source);
    t.w().simd(match (double, mode) {
        (false, 0) => 0x6A, // f32x4.nearest
        (false, 1) => 0x68, // f32x4.floor
        (false, 2) => 0x67, // f32x4.ceil
        (false, _) => 0x69, // f32x4.trunc
        (true, 0) => 0x94,  // f64x2.nearest
        (true, 1) => 0x75,  // f64x2.floor
        (true, 2) => 0x74,  // f64x2.ceil
        (true, _) => 0x7A,  // f64x2.trunc
    });
    let rounded = t.w().set_new_local_v128();
    // per lane: a NaN (x != x), an inexact result (r != x); the lanes that
    // count: all, or the low one
    let ne = if double { 0x48 } else { 0x42 };
    let any = |w: &mut WasmBuilder, a: &WasmLocalV128, b: &WasmLocalV128| {
        w.get_local_v128(a);
        w.get_local_v128(b);
        w.simd(ne);
        if scalar {
            w.simd_lane(0x1B, 0); // i32x4.extract_lane
        }
        else {
            w.simd(0x53); // v128.any_true
        }
    };
    any(t.w(), &rounded, &source);
    let inexact = t.w().set_new_local();
    t.w().load_fixed_i32(gp::mxcsr as u32);
    let mxcsr = t.w().set_new_local();
    any(t.w(), &source, &source);
    t.w().get_local(&mxcsr);
    t.w()
        .const_i32(0x40 | if imm8 & 4 != 0 { 0x6000 } else { 0 });
    t.w().and_i32();
    t.w().or_i32();
    if imm8 & 8 == 0 {
        // (PE unmasked: PM, MXCSR bit 12, clear)
        t.w().get_local(&inexact);
        t.w().get_local(&mxcsr);
        t.w().const_i32(0x1000);
        t.w().and_i32();
        t.w().eqz_i32();
        t.w().and_i32();
        t.w().or_i32();
    }
    let refused = t.w().set_new_local();
    if scalar {
        t.w().get_local_v128(&rounded);
        t.w().get_local_v128(&destination);
        let mut lanes = [0; 16];
        for (k, lane) in lanes.iter_mut().enumerate() {
            *lane = if k < bytes as usize { k as u8 } else { 16 + k as u8 };
        }
        t.w().simd_shuffle(lanes);
    }
    else {
        t.w().get_local_v128(&rounded);
    }
    let v = t.w().set_new_local_v128();
    if imm8 & 8 == 0 {
        // MXCSR.PE for an inexact lane (when not refused)
        t.w().get_local(&inexact);
        t.w().get_local(&refused);
        t.w().eqz_i32();
        t.w().and_i32();
        t.w().if_void();
        t.w().const_i32(gp::mxcsr as i32);
        t.w().get_local(&mxcsr);
        t.w().const_i32(0x20);
        t.w().or_i32();
        t.w().store_aligned_i32(0);
        t.w().block_end();
    }
    t.w().get_local(&refused);
    t.refused(&destination, &source, None, &v);
    t.store_vec(&v, if scalar { bytes } else { 16 });
    // (no lane facts: the exact path may produce a NaN)
    if let Some(f) = t.facts() {
        f.clean[f.reg as usize] = 0;
    }
    for local in [refused, mxcsr, inexact] {
        t.w().free_local(local);
    }
    for v128 in [v, rounded, destination, source] {
        t.w().free_local_v128(v128);
    }
}

/// VZEROUPPER: bits 255:128 of every YMM register zeroed
pub fn zero_upper<T: VecOperands>(t: &mut T) {
    for r in 0..t.registers() {
        t.zero_upper(r);
    }
}

/// VZEROALL: every YMM register zeroed
pub fn zero_all<T: VecOperands>(t: &mut T) {
    t.w().simd_zero();
    let zero = t.w().set_new_local_v128();
    for r in 0..t.registers() {
        t.store_register(r, &zero);
    }
    t.w().free_local_v128(zero);
}

/// The r/m operand of a VEX.256 form in two locals, low and high (both
/// halves read before anything is written)
fn source256<T: VecOperands>(t: &mut T, aligned: bool) -> [WasmLocalV128; 2] {
    if t.memory() {
        return t.source256(aligned);
    }
    t.source(16, true);
    let low = t.w().set_new_local_v128();
    t.source_high();
    [low, t.w().set_new_local_v128()]
}

/// VMOVUPS/UPD/DQU and VMOVAPS/APD/DQA ymm, ymm/m256 (`aligned`: the A forms)
pub fn load256<T: VecOperands>(t: &mut T, aligned: bool) {
    let memory = t.memory();
    let halves = source256(t, aligned);
    t.store256(&halves[0], &halves[1]);
    if let Some(f) = t.facts().filter(|_| !memory) {
        // (a register's lanes keep their facts)
        if let Some(source) = f.source {
            f.clean[f.reg as usize] = f.clean[source as usize];
        }
    }
    for v in halves {
        t.w().free_local_v128(v);
    }
}

/// VMOVUPS/UPD/DQU, VMOVAPS/APD/DQA and VMOVNTPS/PD/DQ ymm/m256, ymm
/// (`aligned`: the A and NT forms)
pub fn store256<T: VecOperands>(t: &mut T, aligned: bool) {
    let memory = t.memory();
    t.first();
    let low = t.w().set_new_local_v128();
    t.first_high();
    let halves = [low, t.w().set_new_local_v128()];
    t.store256_rm(&halves, aligned);
    if let Some(f) = t.facts().filter(|_| !memory) {
        if let Some(source) = f.source {
            f.clean[source as usize] = f.clean[f.reg as usize];
        }
    }
    for v in halves {
        t.w().free_local_v128(v);
    }
}

/// The packed integer operations of AVX2 (VEX.256): `op` on each half of
/// the first source and the r/m operand
pub fn packed256<T: VecOperands>(t: &mut T, op: Packed) {
    // (both halves of both sources before the destination is written)
    let source = source256(t, false);
    t.first();
    let low = t.w().set_new_local_v128();
    t.first_high();
    let first = [low, t.w().set_new_local_v128()];
    packed(t.w(), op, &first[0], &source[0], 16);
    let low = t.w().set_new_local_v128();
    packed(t.w(), op, &first[1], &source[1], 16);
    let result = [low, t.w().set_new_local_v128()];
    t.store256(&result[0], &result[1]);
    for v in source.into_iter().chain(first).chain(result) {
        t.w().free_local_v128(v);
    }
}

/// VPMOVMSKB (`lane` 1), VMOVMSKPS (4) and VMOVMSKPD (8) r32, ymm: the sign
/// bits of both halves (register forms only)
pub fn move_mask256<T: VecOperands>(t: &mut T, lane: u8) {
    let bitmask = match lane {
        1 => 0x64, // i8x16.bitmask
        4 => 0xA4, // i32x4.bitmask
        _ => 0xC4, // i64x2.bitmask
    };
    t.source(16, true);
    t.w().simd(bitmask);
    t.source_high();
    t.w().simd(bitmask);
    t.w().const_i32(16 / lane as i32);
    t.w().shl_i32();
    t.w().or_i32();
    t.store_int(false);
}

/// VBROADCASTSS, VBROADCASTSD and VPBROADCASTB/W/D/Q: the element (`bytes`)
/// in every lane, of both halves (`wide`, VEX.256) or of the low one
pub fn broadcast<T: VecOperands>(t: &mut T, bytes: u8, wide: bool) {
    t.source(bytes, false);
    let element = t.w().set_new_local_v128();
    t.w().get_local_v128(&element);
    t.w().get_local_v128(&element);
    t.w().simd_shuffle(std::array::from_fn(|k| k as u8 % bytes));
    let value = t.w().set_new_local_v128();
    if wide {
        t.store256(&value, &value);
    }
    else {
        t.store_vec(&value, 16);
    }
    t.w().free_local_v128(element);
    t.w().free_local_v128(value);
}

/// FMA's VEX.128 and scalar forms (`op` the opcode byte, `double` VEX.W1):
/// natively where the host's relaxed multiply-adds fuse
/// (native_fp::fused), a scalar form's other lanes the destination's; the
/// exact helper runtime::tier0::ir_t0_fma in place where a lane or MXCSR is
/// refused, or always without fusing multiply-adds (its fault retries)
pub fn fused<T: VecOperands>(t: &mut T, op: u8, double: bool) {
    // (the r/m operand first: its access may retry; a scalar form's 32 or
    // 64 bits)
    let scalar = op & 0xF >= 9 && op & 1 == 1;
    t.source(
        if !scalar {
            16
        }
        else if double {
            8
        }
        else {
            4
        },
        false,
    );
    let third = t.w().set_new_local_v128();
    // (both registers read before the branch)
    let native = t.relaxed_fma().then(|| {
        t.destination();
        let d = t.w().set_new_local_v128();
        t.first();
        let f = t.w().set_new_local_v128();
        let r = native_fp::fused(t.w(), op, double, scalar, [&d, &f, &third]);
        t.mxcsr_refused();
        t.w().or_i32();
        let refused = t.w().set_new_local();
        if scalar {
            let bytes = if double { 8 } else { 4 };
            t.w().get_local_v128(&r);
            t.w().get_local_v128(&d);
            let mut lanes = [0; 16];
            for (k, lane) in lanes.iter_mut().enumerate() {
                *lane = if k < bytes { k as u8 } else { 16 + k as u8 };
            }
            t.w().simd_shuffle(lanes);
            t.w().set_local_v128(&r);
        }
        t.w().get_local(&refused);
        t.w().free_local(refused);
        t.w().free_local_v128(d);
        t.w().free_local_v128(f);
        t.w().hint(false);
        t.w().if_void();
        r
    });
    let operands = t.sse_fp_operands();
    t.w().const_i32(operands as i32);
    t.destination();
    t.w().simd_memory(0x0B, 4); // v128.store
    t.w().const_i32((operands + 16) as i32);
    t.first();
    t.w().simd_memory(0x0B, 4);
    t.w().const_i32((operands + 32) as i32);
    t.w().get_local_v128(&third);
    t.w().simd_memory(0x0B, 4);
    t.w().const_i32(op as i32 | (double as i32) << 8);
    t.w().call_signature("x64_fma", signature("x64_fma"));
    t.retry_if();
    t.w().const_i32(operands as i32);
    t.w().simd_memory(0x00, 4); // v128.load
    let result = match native {
        Some(r) => {
            t.w().set_local_v128(&r);
            t.w().block_end();
            r
        },
        None => t.w().set_new_local_v128(),
    };
    t.store_vec(&result, 16);
    t.w().free_local_v128(third);
    t.w().free_local_v128(result);
}
