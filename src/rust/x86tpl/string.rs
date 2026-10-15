//! Leaves of the REP string templates (docs/jit-unification-plan.md P3.1b):
//! the bulk operations a REP MOVS or STOS becomes when it is done at once,
//! for every x86 engine (Tier-0's template, the page tier's Op::Movs and
//! Op::Stos)
use crate::wasmgen::wasm_builder::WasmBuilder;

/// memory.copy over the guest memory: (destination, source, length) on
/// the stack, host addresses
pub fn memory_copy(w: &mut WasmBuilder) {
    w.op(0xFC);
    w.op(10);
    w.op(0);
    w.op(0);
}
/// memory.fill over the guest memory: (destination, byte, length) on the
/// stack
pub fn memory_fill(w: &mut WasmBuilder) {
    w.op(0xFC);
    w.op(11);
    w.op(0);
}
