//! Helpers of the page tier's generated code and their host switches
//! (docs/jit-unification-plan.md P7.5: shared with IR Tier-0 until it was
//! deleted, from ir::runtime::tier0, renamed): the exact SSE floating point
//! and FMA paths on one operand block, PCMPxSTRx, and whether the engine has
//! Wasm tail calls and fused relaxed multiply-adds.

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
