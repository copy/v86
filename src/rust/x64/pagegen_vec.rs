//! The page tier's operands for the x86tpl::ops templates
//! (docs/jit-unification-plan.md P2.4, P2.5): the XMM registers in the CPU
//! state, memory operands through the access cache (vector_address, which
//! retries an aligned form's misaligned address). A refused instruction
//! retries in the interpreter, which leaves the CPU as the templates found
//! it (they write after their last retry point); with x64_sse_fast_check
//! (P4.18) SSE arithmetic and compares run the exact helper in place
//! instead, as Tier-0's. MXCSR.PE may be clear: the templates set it for an
//! inexact result. With x64_sse_fast_check the page tier keeps register
//! facts as Tier-0 (Emitter::xmm_clean): every write here ends the
//! destination's, and the arithmetic, compare and conversion templates read
//! and state them. Integer results are i64 here: store_int extends a
//! template's i32 explicitly.
use super::{low_lanes, Emitter, Inst, Op, Reg, Xmm, HOST};
use crate::wasmgen::wasm_builder::{WasmBuilder, WasmLocalV128};
use crate::x86tpl::native_fp;
use crate::x86tpl::ops::{Facts, VecOperands};
use crate::x86tpl::vec::{sse_fp_call, sse_fp_result};

/// One instruction's operands: destination `dst`, first source `first` (the
/// destination, or VEX.vvvv), r/m operand `src`
pub(super) struct Operands<'e> {
    pub e: &'e mut Emitter,
    pub inst: &'e Inst,
    /// the instruction's offset, where a retry resumes
    pub start: u64,
    pub dst: u8,
    pub first: u8,
    pub src: Xmm,
}

impl VecOperands for Operands<'_> {
    fn w(&mut self) -> &mut WasmBuilder { &mut self.e.b }
    // (XMM registers through the emitter's accessors: their v128 locals
    // while held, P4.17)
    fn first(&mut self) { self.e.xv_push(self.first) }
    fn source(&mut self, bytes: u8, whole: bool) {
        match self.src {
            Xmm::Reg(s) => {
                self.e.xv_push(s);
                if bytes < 16 && !whole {
                    // the low `bytes`, zero-extended
                    self.e.b.simd_zero();
                    self.e.b.simd_shuffle(low_lanes(bytes));
                }
            },
            Xmm::Mem(a) => {
                // (legacy SSE's m128 operands are aligned)
                let aligned = bytes == 16 && self.inst.d.vex.is_none();
                self.e
                    .vector_address(&a, bytes * 8, aligned, false, self.inst);
                if bytes == 16 {
                    self.e.gi(HOST);
                    let scratch = self.e.b.set_new_local();
                    self.e.b.get_local(&scratch);
                    self.e.b.guest_load_v128(&scratch);
                    self.e.b.free_local(scratch);
                    return;
                }
                if matches!(bytes, 4 | 8) {
                    self.e.load_scalar_v128(bytes * 8);
                    return;
                }
                // (exactly the operand's bytes: a broadcast's may be 1 or 2)
                self.e.b.simd_zero();
                self.e.gi(HOST);
                self.e.b.guest_load_i64_bits(bytes as u32 * 8, 0);
                if bytes == 8 {
                    self.e.b.simd_lane(0x1E, 0); // i64x2.replace_lane
                }
                else {
                    self.e.b.wrap_i64_to_i32();
                    self.e.b.simd_lane(0x1C, 0); // i32x4.replace_lane
                }
            },
        }
    }
    fn register(&mut self, r: u8) { self.e.xv_push(r) }
    /// (compatibility mode has XMM0-7: VZEROUPPER and VZEROALL keep
    /// YMM8-15 there)
    fn registers(&self) -> u8 {
        if self.e.env.compat {
            8
        }
        else {
            16
        }
    }
    fn memory(&self) -> bool { matches!(self.src, Xmm::Mem(_)) }
    fn first_high(&mut self) {
        self.e.c32(Emitter::ymm(self.first, 16) as i32);
        self.e.b.simd_memory(0x00, 0); // v128.load
    }
    fn source_high(&mut self) {
        let Xmm::Reg(s) = self.src
        else {
            unreachable!("a register form's");
        };
        self.e.c32(Emitter::ymm(s, 16) as i32);
        self.e.b.simd_memory(0x00, 0); // v128.load
    }
    fn source256(&mut self, aligned: bool) -> [WasmLocalV128; 2] {
        let Xmm::Mem(a) = self.src
        else {
            unreachable!("a memory form's");
        };
        self.e
            .vector_address_bytes(&a, 32, aligned, false, self.inst);
        [0, 16].map(|offset| {
            self.e.gi(HOST);
            self.e.c32(offset);
            self.e.b.add_i32();
            let scratch = self.e.b.set_new_local();
            self.e.b.get_local(&scratch);
            self.e.b.guest_load_v128(&scratch);
            self.e.b.free_local(scratch);
            self.e.b.set_new_local_v128()
        })
    }
    fn store256(&mut self, low: &WasmLocalV128, high: &WasmLocalV128) {
        self.e.xmm_clean[self.dst as usize] = 0;
        self.e.ymm_store(self.dst, low, high);
    }
    fn store256_rm(&mut self, halves: &[WasmLocalV128; 2], aligned: bool) {
        match self.src {
            Xmm::Reg(s) => {
                self.e.xmm_clean[s as usize] = 0;
                self.e.ymm_store(s, &halves[0], &halves[1]);
            },
            Xmm::Mem(a) => {
                self.e
                    .vector_address_bytes(&a, 32, aligned, true, self.inst);
                for (half, offset) in [(&halves[0], 0), (&halves[1], 16)] {
                    self.e.gi(HOST);
                    self.e.c32(offset);
                    self.e.b.add_i32();
                    let address = self.e.b.set_new_local();
                    self.e.b.guest_store_v128(&address, half);
                    self.e.b.free_local(address);
                }
            },
        }
    }
    fn zero_upper(&mut self, r: u8) { self.e.ymm_zero(r) }
    fn destination(&mut self) { self.e.xv_push(self.dst) }
    fn relaxed_fma(&self) -> bool { self.e.env.relaxed_fma }
    fn sse_fp_operands(&self) -> u32 { self.e.env.sse_fp_operands }
    fn store_register(&mut self, r: u8, value: &WasmLocalV128) {
        self.e.xmm_clean[r as usize] = 0;
        if self.e.env.xmm_locals {
            self.e.b.get_local_v128(value);
            self.e.xv_pop(r);
        }
        else {
            self.e.c32(Emitter::xmm(r) as i32);
            self.e.b.get_local_v128(value);
            self.e.b.simd_memory(0x0B, 0); // v128.store
        }
        self.e.ymm_zero(r);
    }
    fn source_int(&mut self, _wide: bool) {
        unreachable!("the page tier converts integers in Op::Vconvert")
    }
    fn store_vec(&mut self, value: &WasmLocalV128, bytes: u8) {
        // (a template states the new facts after its write)
        self.e.xmm_clean[self.dst as usize] = 0;
        if bytes < 16 && self.e.env.xmm_locals && self.e.held(self.dst) {
            // (into the held register by a shuffle, no lane through a
            // general register: the other lanes from the first source)
            self.e.b.get_local_v128(value);
            self.e.xv_push(self.first);
            self.e.b.simd_shuffle(low_lanes(bytes));
            self.e.xv_pop(self.dst);
            return;
        }
        if bytes < 16 && self.first != self.dst {
            // (a scalar form's other lanes from VEX.vvvv)
            self.e.xmm_copy(self.first, self.dst);
        }
        if !self.e.env.xmm_locals {
            // (memory only: as before P4.17)
            self.e.c32(Emitter::xmm(self.dst) as i32);
            self.e.b.get_local_v128(value);
            match bytes {
                16 => self.e.b.simd_memory(0x0B, 0), // v128.store
                8 => {
                    self.e.b.simd_lane(0x1D, 0); // i64x2.extract_lane
                    self.e.b.store_aligned_i64(0);
                },
                _ => {
                    self.e.b.simd_lane(0x1B, 0); // i32x4.extract_lane
                    self.e.b.store_aligned_i32(0);
                },
            }
            return;
        }
        self.e.b.get_local_v128(value);
        match bytes {
            16 => self.e.xv_pop(self.dst),
            8 => {
                self.e.b.simd_lane(0x1D, 0); // i64x2.extract_lane
                self.e.xmm_store(self.dst, 0, 64, false);
            },
            _ => {
                self.e.b.simd_lane(0x1B, 0); // i32x4.extract_lane
                self.e.b.extend_unsigned_i32_to_i64();
                self.e.xmm_store(self.dst, 0, 32, true);
            },
        }
    }
    fn store_int(&mut self, wide: bool) {
        if !wide {
            self.e.b.extend_unsigned_i32_to_i64();
        }
        let r = Reg {
            index: self.dst,
            high: false,
        };
        self.e.set_reg(r, if wide { 64 } else { 32 });
    }
    fn retry_if(&mut self) { self.e.retry_if(self.start) }
    /// (x64_sse_fast_check: DAZ either way, see native_fp::mxcsr_refused_any_daz)
    fn mxcsr_refused(&mut self) {
        if self.e.env.sse_fast_check {
            self.e.fp_mxcsr_refused();
        }
        else {
            native_fp::mxcsr_refused(&mut self.e.b);
        }
    }
    /// (only the templates whose code after a refusal suits an exact result:
    /// arithmetic and compares)
    fn in_place(&self) -> bool {
        self.e.env.sse_fast_check && matches!(self.inst.op, Op::Vfp { .. } | Op::Vcmp { .. })
    }
    fn detects_inexact(&self) -> bool { true }
    fn exact_open(
        &mut self,
        destination: &WasmLocalV128,
        source: &WasmLocalV128,
        imm8: Option<u32>,
    ) {
        dbg_assert!(self.in_place());
        self.e.b.hint(false);
        self.e.b.if_void();
        // (a VEX form: its legacy form's key, the first source as the
        // destination)
        let d = &self.inst.d;
        let key = match d.vex {
            Some(_) => crate::cpu::avx::legacy(d.opcode),
            None => d.opcode,
        };
        let imm8 = imm8.unwrap_or(d.immediate.map_or(0, |i| i.value as u32 & 0xFF));
        sse_fp_call(
            &mut self.e.b,
            self.e.env.sse_fp_operands,
            key,
            imm8,
            destination,
            source,
        );
        self.e.retry_if(self.start);
    }
    fn exact_result(&mut self) { sse_fp_result(&mut self.e.b, self.e.env.sse_fp_operands) }
    /// (the templates whose facts the page tier follows: arithmetic,
    /// compares, conversions)
    fn facts(&mut self) -> Option<Facts<'_>> {
        if !self.e.env.sse_fast_check
            || !matches!(
                self.inst.op,
                Op::Vfp { .. } | Op::Vcmp { .. } | Op::Vcvt { .. }
            )
        {
            return None;
        }
        Some(Facts {
            clean: &mut self.e.xmm_clean,
            reg: self.dst,
            first: self.first,
            source: match self.src {
                Xmm::Reg(r) => Some(r),
                Xmm::Mem(_) => None,
            },
        })
    }
}
