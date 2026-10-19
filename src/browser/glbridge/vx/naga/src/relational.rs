//! `OpIsNan` and `OpIsInf` as bit tests: WGSL has neither, so naga's WGSL
//! writer refuses them. Each becomes a bitcast of the (32-bit) float to
//! unsigned, the sign masked off, compared with the exponent's all ones
//! (0x7F800000): equal is infinite, above it NaN. The unsigned types and
//! the constants this needs are declared before the first function.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

const OP_TYPE_BOOL: u32 = 20;
const OP_TYPE_INT: u32 = 21;
const OP_TYPE_VECTOR: u32 = 23;
const OP_CONSTANT: u32 = 43;
const OP_CONSTANT_COMPOSITE: u32 = 44;
const OP_FUNCTION: u32 = 54;
const OP_BITCAST: u32 = 124;
const OP_IS_NAN: u32 = 156;
const OP_IS_INF: u32 = 157;
const OP_IEQUAL: u32 = 170;
const OP_UGREATER_THAN: u32 = 172;
const OP_BITWISE_AND: u32 = 199;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The module with its NaN and infinity tests made bit tests, or the words
/// as they were when it has none
pub fn lower(words: &[u32]) -> Vec<u32> {
    if words.len() < 5 {
        return words.to_vec();
    }
    let mut instructions: Vec<&[u32]> = Vec::new();
    let mut at = 5;
    while at < words.len() {
        let count = (words[at] >> 16) as usize;
        if count == 0 || at + count > words.len() {
            return words.to_vec();
        }
        instructions.push(&words[at..at + count]);
        at += count;
    }
    let op = |w: &[u32]| w[0] & 0xFFFF;
    if !instructions.iter().any(|w| matches!(op(w), OP_IS_NAN | OP_IS_INF) && w.len() >= 4) {
        return words.to_vec();
    }
    // the bool vectors' sizes (by type id), the unsigned int and its vectors
    let mut bool_type = None;
    let mut bool_vectors: BTreeMap<u32, u32> = BTreeMap::new();
    let mut uint = None;
    let mut uint_vectors: BTreeMap<u32, u32> = BTreeMap::new();
    for w in &instructions {
        match op(w) {
            OP_TYPE_BOOL if w.len() >= 2 => bool_type = Some(w[1]),
            OP_TYPE_INT if w.len() >= 4 && w[2] == 32 && w[3] == 0 => uint = Some(w[1]),
            _ => {},
        }
    }
    for w in &instructions {
        if op(w) == OP_TYPE_VECTOR && w.len() >= 4 {
            if Some(w[2]) == bool_type {
                bool_vectors.insert(w[1], w[3]);
            }
            else if Some(w[2]) == uint {
                uint_vectors.insert(w[3], w[1]);
            }
        }
    }
    let mut bound = words[3];
    let mut fresh = || {
        let id = bound;
        bound += 1;
        id
    };
    // what to declare: per size, the unsigned type and the two constants
    let mut declarations: Vec<Vec<u32>> = Vec::new();
    let uint = match uint {
        Some(id) => id,
        None => {
            let id = fresh();
            declarations.push(instruction(OP_TYPE_INT, &[id, 32, 0]));
            id
        },
    };
    let mut sizes: BTreeMap<u32, (u32, u32, u32)> = BTreeMap::new();
    for w in &instructions {
        if !matches!(op(w), OP_IS_NAN | OP_IS_INF) || w.len() < 4 {
            continue;
        }
        let size = bool_vectors.get(&w[1]).copied().unwrap_or(1);
        if sizes.contains_key(&size) {
            continue;
        }
        let (mask, exponent) = (fresh(), fresh());
        let ty = if size == 1 {
            declarations.push(instruction(OP_CONSTANT, &[uint, mask, 0x7FFF_FFFF]));
            declarations.push(instruction(OP_CONSTANT, &[uint, exponent, 0x7F80_0000]));
            uint
        }
        else {
            let ty = match uint_vectors.get(&size) {
                Some(&ty) => ty,
                None => {
                    let ty = fresh();
                    declarations.push(instruction(OP_TYPE_VECTOR, &[ty, uint, size]));
                    ty
                },
            };
            let (m, e) = (fresh(), fresh());
            declarations.push(instruction(OP_CONSTANT, &[uint, m, 0x7FFF_FFFF]));
            declarations.push(instruction(OP_CONSTANT, &[uint, e, 0x7F80_0000]));
            let mut ms = Vec::from([ty, mask]);
            let mut es = Vec::from([ty, exponent]);
            for _ in 0..size {
                ms.push(m);
                es.push(e);
            }
            declarations.push(instruction(OP_CONSTANT_COMPOSITE, &ms));
            declarations.push(instruction(OP_CONSTANT_COMPOSITE, &es));
            ty
        };
        sizes.insert(size, (ty, mask, exponent));
    }
    let mut out = words[..5].to_vec();
    let mut declared = false;
    for w in &instructions {
        if op(w) == OP_FUNCTION && !declared {
            declared = true;
            for d in &declarations {
                out.extend_from_slice(d);
            }
        }
        if matches!(op(w), OP_IS_NAN | OP_IS_INF) && w.len() >= 4 {
            let size = bool_vectors.get(&w[1]).copied().unwrap_or(1);
            let (ty, mask, exponent) = sizes[&size];
            let (bits, magnitude) = (fresh(), fresh());
            out.extend_from_slice(&instruction(OP_BITCAST, &[ty, bits, w[3]]));
            out.extend_from_slice(&instruction(OP_BITWISE_AND, &[ty, magnitude, bits, mask]));
            let compare = if op(w) == OP_IS_INF { OP_IEQUAL } else { OP_UGREATER_THAN };
            out.extend_from_slice(&instruction(compare, &[w[1], w[2], magnitude, exponent]));
            continue;
        }
        out.extend_from_slice(w);
    }
    out[3] = bound;
    out
}
