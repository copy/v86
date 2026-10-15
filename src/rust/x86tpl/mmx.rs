//! MMX leaves (docs/jit-unification-plan.md P2.2). The MMX registers alias
//! the x87 mantissas: a read first syncs its slot from the f64 shadow cache,
//! a write invalidates the slot and sets its exponent to 0xFFFF, and a form
//! ends with the transition to MMX (all tags valid, TOP 0).
use crate::cpu::{fpu, global_pointers as gp};
use crate::wasmgen::wasm_builder::{Signature, WasmBuilder, WasmLocalV128, WasmType};

/// Push MMX `r` (cpu::read_mmx64s: sync the slot from the f64 cache first)
pub fn load(w: &mut WasmBuilder, r: u8) {
    let [_, _, dirty] = fpu::x87_cache_addresses();
    w.load_fixed_i32(dirty);
    w.const_i32(1 << r);
    w.and_i32();
    w.hint(false);
    w.if_void();
    w.const_i32(r as i32);
    w.call_signature("fpu_sync_slot", Signature::new(&[WasmType::I32], &[]));
    w.block_end();
    w.const_i32(gp::get_reg_mmx_offset(r as u32) as i32);
    w.simd_memory(0x5D, 0);
}
/// cpu::write_mmx_reg64 of the low quadword of `value`
pub fn store(w: &mut WasmBuilder, r: u8, value: &WasmLocalV128) {
    invalidate(w, r);
    let address = gp::get_reg_mmx_offset(r as u32);
    w.const_i32(address as i32);
    w.get_local_v128(value);
    w.simd_lane(0x1D, 0);
    w.store_unaligned_i64(0);
    w.const_i32(address as i32 + 8);
    w.const_i32(0xFFFF);
    w.store_unaligned_u16(0);
}
/// fpu_invalidate_slot(r)
pub fn invalidate(w: &mut WasmBuilder, r: u8) {
    let [_, valid, dirty] = fpu::x87_cache_addresses();
    for address in [valid, dirty] {
        w.const_i32(address as i32);
        w.load_fixed_i32(address);
        w.const_i32(!(1 << r));
        w.and_i32();
        w.store_aligned_i32(0);
    }
}
/// cpu::transition_fpu_to_mmx: all tags valid, TOP 0
pub fn transition(w: &mut WasmBuilder) {
    for address in [gp::fpu_stack_empty as u32, gp::fpu_stack_ptr as u32] {
        w.const_i32(address as i32);
        w.const_i32(0);
        w.store_u8(0);
    }
}
