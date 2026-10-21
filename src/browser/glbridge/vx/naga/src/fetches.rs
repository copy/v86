//! Offsets of fetches (GLSL's `texelFetchOffset`, OpImageFetch with a
//! ConstOffset or Offset operand): naga's front end reads a fetch's Lod and
//! Sample operands only and drops the rest, and WGSL's `textureLoad` takes no
//! offset. The offset is added to the coordinate's spatial components (an
//! array's layer kept), and the operand goes.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

const OP_TYPE_VECTOR: u32 = 23;
const OP_FUNCTION: u32 = 54;
const OP_COMPOSITE_CONSTRUCT: u32 = 80;
const OP_COMPOSITE_EXTRACT: u32 = 81;
const OP_IMAGE_FETCH: u32 = 95;
const OP_I_ADD: u32 = 128;
const OPERANDS_CONST_OFFSET: u32 = 0x8;
const OPERANDS_OFFSET: u32 = 0x10;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The image operands' words each bit takes, in their order
fn operand_words(bit: u32) -> usize {
    match bit {
        0x4 => 2, // Grad
        0x40 => 1, // Sample
        0x80 => 1, // MinLod
        0x100..=0x800 => 0, // memory model bits
        _ => 1,
    }
}

/// The module with its fetches' offsets added to their coordinates, or the words as they were
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
    let fetch_with_offset = |w: &[u32]| op(w) == OP_IMAGE_FETCH && w.len() >= 6 && w[5] & (OPERANDS_CONST_OFFSET | OPERANDS_OFFSET) != 0;
    if !instructions.iter().any(|w| fetch_with_offset(w)) {
        return words.to_vec();
    }
    // the types of values (results and constants), and vector types
    let mut type_of: BTreeMap<u32, u32> = BTreeMap::new();
    let mut vectors: BTreeMap<u32, (u32, u32)> = BTreeMap::new();
    // (the instructions of no result type in a function: debug, stores, copies, barriers, control flow)
    let untyped = |o: u32| matches!(o, 8 | 56 | 62 | 63 | 99 | 224 | 225 | 246..=255 | 317);
    let first_function = instructions.iter().position(|w| op(w) == OP_FUNCTION).unwrap_or(instructions.len());
    for (i, w) in instructions.iter().enumerate() {
        let o = op(w);
        if o == OP_TYPE_VECTOR && w.len() >= 4 {
            vectors.insert(w[1], (w[2], w[3]));
        }
        else if w.len() >= 3 && ((41..=52).contains(&o) || o == 59 || i >= first_function && !untyped(o)) {
            type_of.insert(w[2], w[1]);
        }
    }
    let mut bound = words[3];
    let mut out = words[..5].to_vec();
    for (i, w) in instructions.iter().enumerate() {
        if i < first_function || !fetch_with_offset(w) {
            out.extend_from_slice(w);
            continue;
        }
        let (rt, result, image, coordinate, mask) = (w[1], w[2], w[3], w[4], w[5]);
        // the operands: the offset's taken out
        let mut kept = Vec::new();
        let mut offset = None;
        let mut at = 6;
        let mut bits = mask;
        let mut whole = true;
        while bits != 0 {
            let bit = 1 << bits.trailing_zeros();
            let n = operand_words(bit);
            if at + n > w.len() {
                whole = false;
                break;
            }
            if bit == OPERANDS_CONST_OFFSET || bit == OPERANDS_OFFSET {
                offset = Some(w[at]);
            }
            else {
                kept.extend_from_slice(&w[at..at + n]);
            }
            at += n;
            bits ^= bit;
        }
        let (true, Some(offset), Some(&coordinate_ty), Some(&offset_ty)) = (whole, offset, type_of.get(&coordinate), offset.and_then(|o| type_of.get(&o))) else {
            out.extend_from_slice(w);
            continue;
        };
        let coordinate_n = vectors.get(&coordinate_ty).map_or(1, |v| v.1);
        let offset_n = vectors.get(&offset_ty).map_or(1, |v| v.1);
        let scalar = vectors.get(&coordinate_ty).map_or(coordinate_ty, |v| v.0);
        // (an array's layer: the offset made as long, a zero more)
        let full_offset = if offset_n == coordinate_n { offset } else {
            let mut parts = Vec::new();
            for k in 0..offset_n {
                let id = bound;
                bound += 1;
                if offset_n == 1 {
                    parts.push(offset);
                    break;
                }
                out.extend_from_slice(&instruction(OP_COMPOSITE_EXTRACT, &[scalar, id, offset, k]));
                parts.push(id);
            }
            // a zero of the coordinate's scalar type: the coordinate's own last component minus itself
            let (last, zero) = (bound, bound + 1);
            bound += 2;
            out.extend_from_slice(&instruction(OP_COMPOSITE_EXTRACT, &[scalar, last, coordinate, coordinate_n - 1]));
            out.extend_from_slice(&instruction(130, &[scalar, zero, last, last]));
            while (parts.len() as u32) < coordinate_n {
                parts.push(zero);
            }
            let id = bound;
            bound += 1;
            let mut c = Vec::from([coordinate_ty, id]);
            c.extend(parts);
            out.extend_from_slice(&instruction(OP_COMPOSITE_CONSTRUCT, &c));
            id
        };
        let moved = bound;
        bound += 1;
        out.extend_from_slice(&instruction(OP_I_ADD, &[coordinate_ty, moved, coordinate, full_offset]));
        let rest = mask & !(OPERANDS_CONST_OFFSET | OPERANDS_OFFSET);
        let mut operands = Vec::from([rt, result, image, moved]);
        if rest != 0 {
            operands.push(rest);
            operands.extend(kept);
        }
        out.extend_from_slice(&instruction(OP_IMAGE_FETCH, &operands));
    }
    out[3] = bound;
    out
}
