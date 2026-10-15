//! Helpers of the page tier's generated code and their host switches
//! (docs/jit-unification-plan.md P7.5: shared with IR Tier-0 until it was
//! deleted, from its runtime, renamed): the exact SSE floating point and FMA
//! paths on one operand block, PCMPxSTRx, x87 forms (x64_x87, from the
//! region runtime's when M11 deleted the region tiers), and whether the
//! engine has Wasm tail calls and fused relaxed multiply-adds.

/// The operands of x64_sse_fp: the destination (replaced by the result)
/// and the source, written by the page function (x64_fma's: the
/// destination, the first source and the third)
#[repr(C, align(16))]
pub struct SseFpOperands(pub [u128; 3]);
pub static mut SSE_FP_OPERANDS: SseFpOperands = SseFpOperands([0; 3]);
/// Address of SSE_FP_OPERANDS for generated code
pub fn sse_fp_operands() -> u32 { (&raw const SSE_FP_OPERANDS) as u32 }

/// SSE floating point exactly (cpu::simd_fp), for the native templates'
/// refused instructions, on SSE_FP_OPERANDS: `key` is the catalogue key and
/// `imm8` CMPPS' predicate; the result (for conversions to an integer and
/// COMISS, the integer or the EFLAGS bits) replaces the destination and
/// MXCSR's flags are updated. 1 if the instruction faults: only MXCSR's
/// flags are set, as the interpreter, which delivers the fault, sets them
/// again; else 0.
#[no_mangle]
pub unsafe fn x64_sse_fp(key: u32, imm8: u32) -> u32 {
    use crate::cpu::simd_fp;
    SSE_FP_CALLS[(key as usize).wrapping_mul(0x9E37_79B9) >> 24 & 255] += 1;
    let [destination, source, _] = SSE_FP_OPERANDS.0;
    let result = match key {
        // ROUNDPS/PD/SS/SD (SSE4.1)
        0x660F3A08..=0x660F3A0B => simd_fp::round(key, destination, source, imm8 as u8),
        _ => match key as u8 {
            0x52 | 0x53 => Ok(simd_fp::reciprocal(key, destination, source)),
            0x2E | 0x2F => simd_fp::compare_flags(key, destination, source).map(u128::from),
            // (the predicate: imm8[2:0], VEX imm8[4:0])
            0xC2 => simd_fp::compare(key, destination, source, imm8 as u8),
            0x2A | 0x2C | 0x2D | 0x5A | 0x5B | 0xE6 => {
                simd_fp::convert(key, false, destination, source)
            },
            _ => simd_fp::arithmetic(key, destination, source, imm8 as u8),
        },
    };
    match result {
        Ok(result) => {
            SSE_FP_OPERANDS.0[0] = result;
            0
        },
        Err(simd_fp::Unmasked) => 1,
    }
}

/// FMA's VEX.128 and scalar forms exactly (cpu::simd_fp::fused), for the
/// page tier's templates, on SSE_FP_OPERANDS (the destination,
/// the first source and the r/m operand): `op` is the opcode byte, bit 8
/// VEX.W. The result replaces the destination and MXCSR's flags are
/// updated. 1 if the instruction faults: only MXCSR's flags are set, as the
/// interpreter, which delivers the fault, sets them again; else 0.
#[no_mangle]
pub unsafe fn x64_fma(op: u32) -> u32 {
    FMA_CALLS = FMA_CALLS.wrapping_add(1);
    let [destination, first, third] = SSE_FP_OPERANDS.0;
    match crate::cpu::simd_fp::fused(op as u8, op & 0x100 != 0, [destination], [first], [third]) {
        Ok([result]) => {
            SSE_FP_OPERANDS.0[0] = result;
            0
        },
        Err(crate::cpu::simd_fp::Unmasked) => 1,
    }
}

/// PCMPESTRM/PCMPESTRI/PCMPISTRM/PCMPISTRI (`op`: the 66 0F 3A byte) with
/// imm8 on SSE_FP_OPERANDS (destination, source), the explicit forms' lengths `a`
/// and `b` (cpu::simd_int::compare_strings): xSTRM's mask replaces the
/// destination; returns the index | EFLAGS (CF, ZF, SF, OF) << 8. For the page
/// tier's templates.
pub unsafe fn pcmpstr(op: u32, imm8: u32, a: i64, b: i64) -> u32 {
    let [destination, source, _] = SSE_FP_OPERANDS.0;
    let explicit = op & 2 == 0;
    let result = crate::cpu::simd_int::compare_strings(
        imm8 as u8,
        destination.to_le_bytes(),
        source.to_le_bytes(),
        explicit.then_some(a),
        explicit.then_some(b),
    );
    SSE_FP_OPERANDS.0[0] = u128::from_le_bytes(result.xmm0);
    result.index | (result.flags as u32) << 8
}
/// x64_sse_fp's calls by a hash of the catalogue key (a diagnostic of
/// refused native floating point, see x64_sse_fp_calls)
static mut SSE_FP_CALLS: [u32; 256] = [0; 256];
/// The exact-path calls of the form whose catalogue key is `key` (shared
/// with the keys of the same hash)
#[no_mangle]
pub unsafe fn x64_sse_fp_calls(key: u32) -> u32 {
    SSE_FP_CALLS[(key as usize).wrapping_mul(0x9E37_79B9) >> 24 & 255]
}
#[no_mangle]
pub unsafe fn x64_sse_fp_calls_reset() { SSE_FP_CALLS = [0; 256]; }
/// x64_fma's calls: the FMA instructions the templates did not compute
/// natively (see relaxed_fma)
static mut FMA_CALLS: u32 = 0;
#[no_mangle]
pub unsafe fn x64_fma_calls() -> u32 { FMA_CALLS }
#[no_mangle]
pub unsafe fn x64_fma_calls_reset() { FMA_CALLS = 0; }

/// Whether the engine has Wasm tail calls (jit_set_tail_calls, src/cpu.js):
/// the page tier's chaining needs them (x64_chaining)
static mut TAIL_CALLS: bool = false;
pub fn tail_calls() -> bool { unsafe { TAIL_CALLS } }
/// Whether the host engine validates Wasm tail calls and passes its
/// function table to generated modules as ("e", "t")
#[no_mangle]
pub unsafe fn jit_set_tail_calls(supported: u32) -> bool {
    if supported > 1 {
        return false;
    }
    TAIL_CALLS = supported == 1;
    true
}
/// Whether the host engine has Wasm relaxed SIMD and its multiply-adds fuse
/// (cpu.js relaxed_fma_fused, at startup)
static mut RELAXED_FMA_FUSED: bool = false;
/// Whether the page tier computes FMA with them
/// (native_fp::fused): where they fuse, unless switched off. Code compiled
/// before a change keeps its path; both are exact.
static mut RELAXED_FMA: bool = false;
pub fn relaxed_fma() -> bool { unsafe { RELAXED_FMA } }
#[no_mangle]
pub unsafe fn ir_relaxed_fma_fused(fused: u32) {
    RELAXED_FMA_FUSED = fused == 1;
    RELAXED_FMA = RELAXED_FMA_FUSED;
}
/// A/B switch: 0 the exact helper, 1 relaxed multiply-adds (if they fuse)
#[no_mangle]
pub unsafe fn ir_set_relaxed_fma(on: u32) -> bool {
    if on > 1 || on == 1 && !RELAXED_FMA_FUSED {
        return false;
    }
    RELAXED_FMA = on == 1;
    true
}
#[no_mangle]
pub unsafe fn ir_relaxed_fma() -> u32 { RELAXED_FMA as u32 }

// x87 (x64_x87) ---------------------------------------------------------

/// The interpreter's register-only x87 forms (D8-DF, ModRM 0xC0 up)
unsafe fn register_semantics(opcode: u32, group: u32, r: u32) {
    let r = r as i32;
    match (opcode, group) {
        (0xD8, 0) => crate::cpu::instructions::instr_D8_0_reg(r),
        (0xD8, 1) => crate::cpu::instructions::instr_D8_1_reg(r),
        (0xD8, 2) => crate::cpu::instructions::instr_D8_2_reg(r),
        (0xD8, 3) => crate::cpu::instructions::instr_D8_3_reg(r),
        (0xD8, 4) => crate::cpu::instructions::instr_D8_4_reg(r),
        (0xD8, 5) => crate::cpu::instructions::instr_D8_5_reg(r),
        (0xD8, 6) => crate::cpu::instructions::instr_D8_6_reg(r),
        (0xD8, 7) => crate::cpu::instructions::instr_D8_7_reg(r),

        (0xD9, 0) => crate::cpu::instructions::instr16_D9_0_reg(r),
        (0xD9, 1) => crate::cpu::instructions::instr16_D9_1_reg(r),
        (0xD9, 2) => crate::cpu::instructions::instr16_D9_2_reg(r),
        (0xD9, 3) => crate::cpu::instructions::instr16_D9_3_reg(r),
        (0xD9, 4) => crate::cpu::instructions::instr16_D9_4_reg(r),
        (0xD9, 5) => crate::cpu::instructions::instr16_D9_5_reg(r),
        (0xD9, 6) => crate::cpu::instructions::instr16_D9_6_reg(r),
        (0xD9, 7) => crate::cpu::instructions::instr16_D9_7_reg(r),

        (0xDA, 0) => crate::cpu::instructions::instr_DA_0_reg(r),
        (0xDA, 1) => crate::cpu::instructions::instr_DA_1_reg(r),
        (0xDA, 2) => crate::cpu::instructions::instr_DA_2_reg(r),
        (0xDA, 3) => crate::cpu::instructions::instr_DA_3_reg(r),
        (0xDA, 5) => crate::cpu::instructions::instr_DA_5_reg(r),

        (0xDB, 0) => crate::cpu::instructions::instr_DB_0_reg(r),
        (0xDB, 1) => crate::cpu::instructions::instr_DB_1_reg(r),
        (0xDB, 2) => crate::cpu::instructions::instr_DB_2_reg(r),
        (0xDB, 3) => crate::cpu::instructions::instr_DB_3_reg(r),
        (0xDB, 4) => crate::cpu::instructions::instr_DB_4_reg(r),
        (0xDB, 5) => crate::cpu::instructions::instr_DB_5_reg(r),
        (0xDB, 6) => crate::cpu::instructions::instr_DB_6_reg(r),

        (0xDC, 0) => crate::cpu::instructions::instr_DC_0_reg(r),
        (0xDC, 1) => crate::cpu::instructions::instr_DC_1_reg(r),
        (0xDC, 2) => crate::cpu::instructions::instr_DC_2_reg(r),
        (0xDC, 3) => crate::cpu::instructions::instr_DC_3_reg(r),
        (0xDC, 4) => crate::cpu::instructions::instr_DC_4_reg(r),
        (0xDC, 5) => crate::cpu::instructions::instr_DC_5_reg(r),
        (0xDC, 6) => crate::cpu::instructions::instr_DC_6_reg(r),
        (0xDC, 7) => crate::cpu::instructions::instr_DC_7_reg(r),

        (0xDD, 0) => crate::cpu::instructions::instr16_DD_0_reg(r),
        (0xDD, 1) => crate::cpu::instructions::instr16_DD_1_reg(r),
        (0xDD, 2) => crate::cpu::instructions::instr16_DD_2_reg(r),
        (0xDD, 3) => crate::cpu::instructions::instr16_DD_3_reg(r),
        (0xDD, 4) => crate::cpu::instructions::instr16_DD_4_reg(r),
        (0xDD, 5) => crate::cpu::instructions::instr16_DD_5_reg(r),

        (0xDE, 0) => crate::cpu::instructions::instr_DE_0_reg(r),
        (0xDE, 1) => crate::cpu::instructions::instr_DE_1_reg(r),
        (0xDE, 2) => crate::cpu::instructions::instr_DE_2_reg(r),
        (0xDE, 3) => crate::cpu::instructions::instr_DE_3_reg(r),
        (0xDE, 4) => crate::cpu::instructions::instr_DE_4_reg(r),
        (0xDE, 5) => crate::cpu::instructions::instr_DE_5_reg(r),
        (0xDE, 6) => crate::cpu::instructions::instr_DE_6_reg(r),
        (0xDE, 7) => crate::cpu::instructions::instr_DE_7_reg(r),

        (0xDF, 0) => crate::cpu::instructions::instr_DF_0_reg(r),
        (0xDF, 1) => crate::cpu::instructions::instr_DF_1_reg(r),
        (0xDF, 2) => crate::cpu::instructions::instr_DF_2_reg(r),
        (0xDF, 3) => crate::cpu::instructions::instr_DF_3_reg(r),
        (0xDF, 4) => crate::cpu::instructions::instr_DF_4_reg(r),
        (0xDF, 5) => crate::cpu::instructions::instr_DF_5_reg(r),
        (0xDF, 6) => crate::cpu::instructions::instr_DF_6_reg(r),
        _ => unreachable!("validated x87 register dispatch"),
    }
}

/// One x87 form for the x64 page tier's functions (IR Tier-0's until P7.5
/// deleted it, ir_t0_x87; the region tiers' ir_x87_op until M11), which
/// never inline f64 forms (no mirroring) and classify at compile time:
/// `form` is opcode | modrm << 8 | kind << 16 (0 stack, 1 load, 2 store;
/// the transfer width is implied). Operands arrive loaded, and stores leave
/// through the returned (high << 32 | low) word after a write preflight;
/// the bodies are the interpreter's, with the shared f64 shadow cache.
#[no_mangle]
pub unsafe fn x64_x87(form: u32, low: u32, high: u32) -> u64 {
    use crate::x86tpl::x87_forms::Io;
    let (opcode, modrm) = (form as u8, (form >> 8) as u8);
    let io = match form >> 16 {
        0 => Io::Stack,
        1 => Io::Load { bytes: 0 },
        _ => Io::Store { bytes: 0 },
    };
    x87_semantics(opcode, modrm, io, low, high)
}
#[inline(always)]
unsafe fn x87_semantics(
    opcode: u8,
    modrm: u8,
    io: crate::x86tpl::x87_forms::Io,
    low: u32,
    high: u32,
) -> u64 {
    use crate::{cpu::fpu::*, cpu::global_pointers as gp, softfloat::F80, x86tpl::x87_forms::Io};
    let group = modrm >> 3 & 7;
    let wide = (high as u64) << 32 | low as u64;
    match io {
        Io::Stack => register_semantics(opcode.into(), group.into(), (modrm & 7).into()),
        Io::Load { .. } => {
            let value = match opcode {
                0xD8 => f32_to_f80(low as i32),
                0xDA => i32_to_f80(low as i32),
                0xDC => f64_to_f80(wide),
                0xDE => i32_to_f80(low as i16 as i32),
                _ => {
                    match (opcode, group) {
                        (0xD9, 0) => {
                            F80::clear_exception_flags();
                            fpu_push_m32_bits(low as i32);
                        },
                        (0xDD, 0) => {
                            F80::clear_exception_flags();
                            fpu_push_m64_bits(wide);
                        },
                        (0xDB, 0) => fpu_push(i32_to_f80(low as i32)),
                        (0xDF, 0) => fpu_push(i32_to_f80(low as i16 as i32)),
                        (0xDF, 5) => fpu_push(i64_to_f80(wide as i64)),
                        (0xD9, 5) => set_control_word(low as u16),
                        _ => unreachable!(),
                    }
                    return 0;
                },
            };
            match group {
                0 => fpu_fadd(0, value),
                1 => fpu_fmul(0, value),
                2 => fpu_fcom(value),
                3 => fpu_fcomp(value),
                4 => fpu_fsub(0, value),
                5 => fpu_fsubr(0, value),
                6 => fpu_fdiv(0, value),
                7 => fpu_fdivr(0, value),
                _ => unreachable!(),
            }
        },
        Io::Store { .. } => {
            let bits = match (opcode, group) {
                (0xD9, 7) => (*gp::fpu_control_word).into(),
                (0xDD, 7) => fpu_load_status_word().into(),
                (0xD9, 2 | 3) => {
                    let value = fpu_get_st0();
                    F80::clear_exception_flags();
                    let bits = value.to_f32() as u32 as u64;
                    *gp::fpu_status_word |= F80::get_exception_flags() as u16;
                    bits
                },
                (0xDD, 2 | 3) => {
                    if let Some(value) = fpu_cached_st0() {
                        F80::clear_exception_flags();
                        value
                    }
                    else {
                        let value = fpu_get_st0();
                        F80::clear_exception_flags();
                        let bits = value.to_f64();
                        *gp::fpu_status_word |= F80::get_exception_flags() as u16;
                        bits
                    }
                },
                (0xDB, _) => {
                    let value = fpu_get_st0();
                    (if group == 1 {
                        fpu_truncate_to_i32(value)
                    }
                    else {
                        fpu_convert_to_i32(value)
                    }) as u32 as u64
                },
                (0xDD, 1) => fpu_truncate_to_i64(fpu_get_st0()) as u64,
                (0xDF, 7) => fpu_convert_to_i64(fpu_get_st0()) as u64,
                (0xDF, _) => {
                    let value = fpu_get_st0();
                    (if group == 1 {
                        fpu_truncate_to_i16(value)
                    }
                    else {
                        fpu_convert_to_i16(value)
                    }) as u16 as u64
                },
                _ => unreachable!(),
            };
            let pops = match (opcode, group) {
                (0xD9 | 0xDD, 7) => false,
                (0xD9 | 0xDD, 2) | (0xDB | 0xDF, 2) => false,
                _ => true,
            };
            if pops {
                fpu_pop();
            }
            return bits;
        },
    }
    0
}
