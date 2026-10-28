//! GLSL ES 3.1's cube images (imageCube, an image unit's layered cube):
//! WGSL has no storage cube textures, so each becomes a 2D array of its six
//! faces (VX binds a `2d-array` view of the cube's level). Loads, stores and
//! texel pointers take the same coordinates (x, y, and the face as the
//! layer); a size query, which of an array has the layers too, keeps its
//! first two components.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;

const OP_TYPE_INT: u32 = 21;
const OP_TYPE_VECTOR: u32 = 23;
const OP_TYPE_IMAGE: u32 = 25;
const OP_FUNCTION: u32 = 54;
const OP_VECTOR_SHUFFLE: u32 = 79;
const OP_IMAGE_QUERY_SIZE: u32 = 104;
const DIM_2D: u32 = 1;
const DIM_CUBE: u32 = 3;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The opcodes in a function that have no result type (intsample.rs's)
fn untyped(op: u32) -> bool { matches!(op, 8 | 56 | 62 | 63 | 99 | 224 | 225 | 246..=255 | 317) }

/// The module with its storage cube images as 2D arrays, or the words as they were
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
    let first_function = instructions.iter().position(|w| op(w) == OP_FUNCTION).unwrap_or(instructions.len());
    // (OpTypeImage: id, sampled type, dim, depth, arrayed, ms, sampled (2: storage), format)
    let cubes: BTreeSet<u32> = instructions[..first_function].iter()
        .filter(|w| op(w) == OP_TYPE_IMAGE && w.len() >= 9 && w[3] == DIM_CUBE && w[5] == 0 && w[6] == 0 && w[7] == 2).map(|w| w[1]).collect();
    if cubes.is_empty() {
        return words.to_vec();
    }
    let types: BTreeMap<u32, &[u32]> = instructions[..first_function].iter().filter(|w| (19..=39).contains(&op(w)) && w.len() >= 2).map(|w| (w[1], *w)).collect();
    let results: BTreeMap<u32, u32> = instructions[first_function..].iter().filter(|w| w.len() >= 3 && !untyped(op(w))).map(|w| (w[2], w[1])).collect();
    let mut bound = words[3];
    let mut fresh = || { bound += 1; bound - 1 };
    // 3-component vectors of the size queries' components: the module's, or new ones (before the first function)
    let mut vec3s: BTreeMap<u32, u32> = instructions[..first_function].iter().filter(|w| op(w) == OP_TYPE_VECTOR && w.len() == 4 && w[3] == 3).map(|w| (w[2], w[1])).collect();
    let mut declarations: Vec<Vec<u32>> = Vec::new();
    let mut body: Vec<Vec<u32>> = Vec::new();
    for w in &instructions {
        match op(w) {
            OP_TYPE_IMAGE if cubes.contains(&w[1]) => {
                let mut changed = w.to_vec();
                changed[3] = DIM_2D;
                changed[5] = 1;
                body.push(changed);
            },
            OP_IMAGE_QUERY_SIZE if w.len() == 4 && results.get(&w[3]).map_or(false, |t| cubes.contains(t)) => {
                // (the array's width, height and layers, then the first two under the query's id)
                let component = match types.get(&w[1]) {
                    Some(t) if op(t) == OP_TYPE_VECTOR && t.len() == 4 && t[3] == 2 && types.get(&t[2]).map_or(false, |c| op(c) == OP_TYPE_INT) => t[2],
                    _ => return words.to_vec(),
                };
                let vec3 = *vec3s.entry(component).or_insert_with(|| {
                    let id = fresh();
                    declarations.push(instruction(OP_TYPE_VECTOR, &[id, component, 3]));
                    id
                });
                let size = fresh();
                body.push(instruction(OP_IMAGE_QUERY_SIZE, &[vec3, size, w[3]]));
                body.push(instruction(OP_VECTOR_SHUFFLE, &[w[1], w[2], size, size, 0, 1]));
            },
            _ => body.push(w.to_vec()),
        }
    }
    let mut out = words[..5].to_vec();
    out[3] = bound;
    for (i, w) in body.iter().enumerate() {
        if i == first_function {
            for d in &declarations {
                out.extend_from_slice(d);
            }
        }
        out.extend_from_slice(w);
    }
    out
}
