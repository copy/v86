//! Golden digests of the page tier's leaf emission (x64/pagegen.rs; until
//! P7.5 deleted IR Tier-0, tests/x86tpl/leaf_digests.rs pinned the leaves as
//! Tier-0's classifiers used them, the method of P2.1): its own
//! immediate shift, and x86tpl's packed operations as pagegen classifies
//! them, keyed by encoding. That digest is the one of pagegen's own Packed
//! table and emitter before P2.3 replaced them, so the change kept every
//! encoding's bytes, for every imm8.
use super::*;
use crate::wasmgen::wasm_builder::WasmLocalV128;
use std::collections::BTreeMap;

/// FNV-1a, 64-bit
struct Fnv(u64);
impl Fnv {
    fn new() -> Self { Fnv(0xCBF2_9CE4_8422_2325) }
    fn bytes(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 ^= byte as u64;
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01B3);
        }
    }
}

/// A leaf's outputs by their parameters
#[derive(Default)]
struct Grid(BTreeMap<String, Vec<u8>>);
impl Grid {
    /// Emit `f` into a fresh builder that has two v128 locals (zeros), and
    /// record the finished module under `key`
    fn emit(&mut self, key: String, f: impl FnOnce(&mut WasmBuilder, [&WasmLocalV128; 2])) {
        let mut w = WasmBuilder::new();
        let locals = [(); 2].map(|_| {
            w.simd_zero();
            w.set_new_local_v128()
        });
        f(&mut w, [&locals[0], &locals[1]]);
        for local in locals {
            w.free_local_v128(local);
        }
        w.finish();
        let output = w.output().to_vec();
        if let Some(previous) = self.0.insert(key.clone(), output.clone()) {
            assert!(previous == output, "{key}: two outputs");
        }
    }
    fn digest(&self) -> (usize, u64) {
        let mut hash = Fnv::new();
        for (key, output) in &self.0 {
            hash.bytes(key.as_bytes());
            hash.bytes(&(output.len() as u32).to_le_bytes());
            hash.bytes(output);
        }
        (self.0.len(), hash.0)
    }
}

/// The packed operations pagegen's classifiers give each encoding (key):
/// the 66 0F codes of packed_op, VPAND/VPANDN/VPOR/VPXOR (VEX.256), the
/// shuffles, PALIGNR and the SSE4 forms with every imm8, PSHUFB and the
/// VEX unpacks. Keyed by encoding rather than by value, so that the digest
/// survives P2.3's change of type (x86tpl's Packed) when the bytes do.
fn packed_by_encoding() -> Vec<(String, Packed)> {
    // (66 0F DB DF EB EF: Op::Vlogic in sse(), "logic" below for VEX.256)
    let mut forms: Vec<(String, Packed)> = (0..=255u8)
        .filter(|code| !matches!(code, 0xDB | 0xDF | 0xEB | 0xEF))
        .filter_map(|code| vec::packed_op(code, false).map(|op| (format!("66 0F {code:02X}"), op)))
        .collect();
    forms.extend([
        ("logic DB".to_string(), Packed::Binary(0x4E)),
        ("logic DF".to_string(), Packed::AndNot),
        ("logic EB".to_string(), Packed::Binary(0x50)),
        ("logic EF".to_string(), Packed::Binary(0x51)),
        ("pshufb".to_string(), Packed::Swizzle(0x8F)),
    ]);
    for (double, high) in [(false, false), (false, true), (true, false), (true, true)] {
        forms.push((
            format!("unpack {double} {high}"),
            Packed::Unpack(if double { 8 } else { 4 }, high),
        ));
    }
    for op in [0x660F70, 0xF20F70, 0xF30F70, 0x0FC6, 0x660FC6] {
        for imm in 0..256 {
            forms.push((format!("shuffle {op:X} {imm}"), vec::shuffle(op, imm)));
        }
    }
    for imm in 0..256 {
        forms.push((format!("palignr {imm}"), palignr(imm)));
    }
    for op in 0x660F3800..=0x660F38FF {
        forms.extend(sse4_packed(op, None).map(|p| (format!("sse4 {op:X}"), p)));
    }
    for op in 0x660F3A00..=0x660F3AFF {
        for imm in 0..256 {
            forms.extend(sse4_packed(op, Some(imm)).map(|p| (format!("sse4 {op:X} {imm}"), p)));
        }
    }
    forms
}

#[test]
fn pagegen_packed_by_encoding() {
    let mut grid = Grid::default();
    for (key, op) in packed_by_encoding() {
        grid.emit(key, |w, [a, b]| vec::packed(w, op, a, b, 16));
    }
    let (points, digest) = grid.digest();
    println!("    packed by encoding: {points}, 0x{digest:016X}");
    assert_eq!((points, digest), (2378, 0x8E4D380DE01AA2A4));
}

/// (name, grid points, digest)
const GOLDEN: [(&str, usize, u64); 1] = [("shift_immediate", 8192, 0x43F6712CA35E8767)];

#[test]
fn pagegen_leaf_digests() {
    let mut shift = Grid::default();
    for bits in [16u8, 32, 64, 128] {
        for kind in 0..8u8 {
            for count in 0..=255u8 {
                shift.emit(format!("{bits} {kind} {count}"), |w, [a, _]| {
                    w.get_local_v128(a);
                    shift_immediate(w, bits, kind, count)
                });
            }
        }
    }
    let actual: Vec<(&str, usize, u64)> = [("shift_immediate", shift)]
        .iter()
        .map(|(name, grid)| {
            let (points, digest) = grid.digest();
            (*name, points, digest)
        })
        .collect();
    for (name, points, digest) in &actual {
        println!("    (\"{name}\", {points}, 0x{digest:016X}),");
    }
    assert_eq!(
        actual, GOLDEN,
        "pagegen leaf digests changed (expected: GOLDEN; printed above)"
    );
}
