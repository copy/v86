//! ISA-neutral v128 leaves (docs/jit-unification-plan.md P2.2): lane
//! permutations and constant shifts that x86tpl builds on and that A64's NEON
//! templates use (ARM64 plan P6.3). Nothing here has an ISA's semantics:
//! callers decide what out-of-range counts and saturation mean.
use crate::wasmgen::wasm_builder::WasmBuilder;

/// i8x16.shuffle lanes that interleave the `element`-byte elements of two
/// `bytes`-wide operands (lanes 0-15 the first, 16-31 the second), their low
/// halves or (`high`) their high halves: x86's PUNPCKL/PUNPCKH, A64's ZIP1
/// and ZIP2
pub fn interleave_lanes(element: u8, high: bool, bytes: u8) -> [u8; 16] {
    let mut lanes = [0; 16];
    let half = bytes / 2;
    for k in 0..bytes {
        let index = k / (element * 2);
        let side = k / element % 2;
        lanes[k as usize] =
            (if high { half } else { 0 }) + index * element + k % element + side * 16;
    }
    lanes
}

/// i8x16.shuffle lanes over (value, zero) that shift the bytes by `count`,
/// toward lane 0 (`down`, x86's PSRLDQ) or away from it (PSLLDQ); A64's EXT
/// with a zero register
pub fn byte_shift_lanes(count: u32, down: bool) -> [u8; 16] {
    let mut lanes = [16; 16];
    for (k, lane) in lanes.iter_mut().enumerate() {
        let index = if down { k as i32 + count as i32 } else { k as i32 - count as i32 };
        if (0..16).contains(&index) {
            *lane = index as u8;
        }
    }
    lanes
}

/// A lane shift (shift_lanes)
#[derive(Clone, Copy)]
pub enum Shift {
    Left,
    Arithmetic,
    Logical,
}

/// Shift the `bits`-wide lanes (16, 32 or 64) of the v128 on the stack by
/// `count`, below `bits`
pub fn shift_lanes(w: &mut WasmBuilder, bits: u8, shift: Shift, count: u32) {
    dbg_assert!(count < bits as u32);
    w.const_i32(count as i32);
    let base = match bits {
        16 => 0x8B,
        32 => 0xAB,
        _ => 0xCB,
    };
    w.simd(
        base + match shift {
            Shift::Left => 0,
            Shift::Arithmetic => 1,
            Shift::Logical => 2,
        },
    );
}

/// Push the i32x4 that has `value` in every lane
pub fn splat_i32(w: &mut WasmBuilder, value: i32) {
    w.const_i32(value);
    w.simd(0x11); // i32x4.splat
}
