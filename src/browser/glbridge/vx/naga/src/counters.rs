//! GLSL ES 3.1's atomic counters, which glslang writes (in Vulkan's relaxed
//! rules) as a storage block per binding, `gl_AtomicCounterBlock_<binding>`,
//! a member per counter at its layout offset in the order of the shader's
//! declarations: a first counter past offset 0 naga moves to 0 (its WGSL
//! struct has no room before the first member), and offsets that do not grow
//! (counters declared in reverse order) it refuses. Each such block becomes
//! one array of `uint`s 4 bytes apart at offset 0:
//! - a counter's pointer, the array's element at its offset / 4 (an array
//!   of counters' element: plus its indices times their strides / 4);
//! - a load of a counter (glslang's atomicCounter()), an atomic load: the
//!   array is atomic in WGSL as soon as one of its counters is written.
//!
//! A module with another access to such a block (a counter array's pointer
//! of its own) is left as it was.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;

const OP_NAME: u32 = 5;
const OP_MEMBER_NAME: u32 = 6;
const OP_DECORATE: u32 = 71;
const OP_MEMBER_DECORATE: u32 = 72;
const OP_TYPE_INT: u32 = 21;
const OP_TYPE_ARRAY: u32 = 28;
const OP_TYPE_STRUCT: u32 = 30;
const OP_TYPE_POINTER: u32 = 32;
const OP_CONSTANT: u32 = 43;
const OP_FUNCTION: u32 = 54;
const OP_VARIABLE: u32 = 59;
const OP_LOAD: u32 = 61;
const OP_ACCESS_CHAIN: u32 = 65;
const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
const OP_BITCAST: u32 = 124;
const OP_I_ADD: u32 = 128;
const OP_I_MUL: u32 = 132;
const OP_ATOMIC_LOAD: u32 = 227;
const DECORATION_ARRAY_STRIDE: u32 = 6;
const DECORATION_OFFSET: u32 = 35;
const SCOPE_DEVICE: u32 = 1;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The opcodes in a function that have no result type (intsample.rs's)
fn untyped(op: u32) -> bool { matches!(op, 8 | 56 | 62 | 63 | 99 | 224 | 225 | 246..=255 | 317) }

fn string_at(words: &[u32]) -> Vec<u8> {
    let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
    bytes.into_iter().take_while(|&b| b != 0).collect()
}

/// A counter block: its members' offsets and (per array level, outermost first) strides, its length in uints
struct Block {
    offsets: Vec<u32>,
    strides: Vec<Vec<u32>>,
    length: u32,
    uint: u32,
}

/// The module with its atomic counter blocks as arrays of uints, or the words as they were
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
    let names: BTreeMap<u32, Vec<u8>> = instructions.iter().filter(|w| op(w) == OP_NAME && w.len() >= 3).map(|w| (w[1], string_at(&w[2..]))).collect();
    let types: BTreeMap<u32, &[u32]> = instructions[..first_function].iter().filter(|w| (19..=39).contains(&op(w)) && w.len() >= 2).map(|w| (w[1], *w)).collect();
    let constants: BTreeMap<u32, (u32, u32)> = instructions[..first_function].iter().filter(|w| op(w) == OP_CONSTANT && w.len() == 4).map(|w| (w[2], (w[1], w[3]))).collect();
    let strides: BTreeMap<u32, u32> = instructions.iter().filter(|w| op(w) == OP_DECORATE && w.len() == 4 && w[2] == DECORATION_ARRAY_STRIDE).map(|w| (w[1], w[3])).collect();
    // the blocks: structs named so, every member a uint or an array (of arrays) of them
    let mut blocks: BTreeMap<u32, Block> = BTreeMap::new();
    for w in &instructions[..first_function] {
        if op(w) != OP_TYPE_STRUCT || !names.get(&w[1]).map_or(false, |n| n.starts_with(b"gl_AtomicCounterBlock")) {
            continue;
        }
        let members = &w[2..];
        let mut offsets = Vec::new();
        let mut member_strides = Vec::new();
        let mut length = 0;
        let mut uint = 0;
        for (m, &member) in members.iter().enumerate() {
            let offset = instructions.iter().find(|d| op(d) == OP_MEMBER_DECORATE && d.len() == 5 && d[1] == w[1] && d[2] == m as u32 && d[3] == DECORATION_OFFSET);
            let Some(offset) = offset.map(|d| d[4]) else { return words.to_vec() };
            // (the array levels down to the uint: their strides and the elements they hold)
            let mut level_strides = Vec::new();
            let mut count = 1;
            let mut t = member;
            while let Some(ty) = types.get(&t).filter(|ty| op(ty) == OP_TYPE_ARRAY && ty.len() == 4) {
                let Some(&(_, n)) = constants.get(&ty[3]) else { return words.to_vec() };
                level_strides.push(strides.get(&t).copied().unwrap_or(0));
                count *= n;
                t = ty[2];
            }
            match types.get(&t) {
                Some(ty) if op(ty) == OP_TYPE_INT && ty.len() == 4 && ty[2] == 32 && ty[3] == 0 => uint = t,
                _ => return words.to_vec(),
            }
            if offset % 4 != 0 || level_strides.iter().any(|&s| s == 0 || s % 4 != 0) {
                return words.to_vec();
            }
            length = length.max(offset / 4 + count);
            offsets.push(offset);
            member_strides.push(level_strides);
        }
        if uint != 0 && length > 0 {
            blocks.insert(w[1], Block { offsets, strides: member_strides, length, uint });
        }
    }
    if blocks.is_empty() {
        return words.to_vec();
    }
    // the blocks' variables
    let pointers: BTreeMap<u32, u32> = instructions[..first_function].iter().filter(|w| op(w) == OP_TYPE_POINTER && w.len() == 4 && blocks.contains_key(&w[3])).map(|w| (w[1], w[3])).collect();
    let variables: BTreeMap<u32, u32> = instructions.iter().filter(|w| op(w) == OP_VARIABLE && w.len() >= 4 && pointers.contains_key(&w[1])).map(|w| (w[2], pointers[&w[1]])).collect();
    let results: BTreeMap<u32, u32> = instructions[first_function..].iter().filter(|w| w.len() >= 3 && !untyped(op(w))).map(|w| (w[2], w[1])).collect();
    let type_of = |id: u32| constants.get(&id).map(|&(t, _)| t).or_else(|| results.get(&id).copied());

    let mut bound = words[3];
    let mut fresh = || { bound += 1; bound - 1 };
    // constants by (type, value): the module's, then this pass's (declared before the first function)
    let mut own: BTreeMap<(u32, u32), u32> = constants.iter().map(|(&id, &(t, v))| ((t, v), id)).collect();
    let mut declarations: Vec<Vec<u32>> = Vec::new();
    let mut constant = |t: u32, v: u32, declarations: &mut Vec<Vec<u32>>, fresh: &mut dyn FnMut() -> u32| *own.entry((t, v)).or_insert_with(|| {
        let id = fresh();
        declarations.push(instruction(OP_CONSTANT, &[t, id, v]));
        id
    });
    // each block's array type and its length (declared before the struct)
    let arrays: BTreeMap<u32, (u32, u32)> = blocks.keys().map(|&s| (s, (fresh(), fresh()))).collect();
    let mut chains: BTreeSet<u32> = BTreeSet::new();
    let mut body: Vec<Vec<u32>> = Vec::new();
    let mut decorated: BTreeSet<u32> = BTreeSet::new();
    for (i, w) in instructions.iter().enumerate() {
        match op(w) {
            OP_MEMBER_NAME if blocks.contains_key(&w[1]) => {},
            OP_MEMBER_DECORATE if blocks.contains_key(&w[1]) => {
                // (the array's offset and stride in place of the members')
                if decorated.insert(w[1]) {
                    body.push(instruction(OP_MEMBER_DECORATE, &[w[1], 0, DECORATION_OFFSET, 0]));
                    body.push(instruction(OP_DECORATE, &[arrays[&w[1]].0, DECORATION_ARRAY_STRIDE, 4]));
                }
            },
            OP_TYPE_STRUCT if blocks.contains_key(&w[1]) => {
                let block = &blocks[&w[1]];
                let (array, length) = arrays[&w[1]];
                body.push(instruction(OP_CONSTANT, &[block.uint, length, block.length]));
                body.push(instruction(OP_TYPE_ARRAY, &[array, block.uint, length]));
                body.push(instruction(OP_TYPE_STRUCT, &[w[1], array]));
            },
            OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN if i > first_function && w.len() >= 5 && variables.contains_key(&w[3]) => {
                let block = &blocks[&variables[&w[3]]];
                let Some(&(index_type, m)) = constants.get(&w[4]) else { return words.to_vec() };
                let m = m as usize;
                if m >= block.offsets.len() || w.len() - 5 != block.strides[m].len() {
                    return words.to_vec();
                }
                // the element: the counter's offset / 4, plus each index times its level's stride / 4
                let mut fixed = block.offsets[m] / 4;
                let mut sum: Option<(u32, u32)> = None;
                for (&index, &stride) in w[5..].iter().zip(&block.strides[m]) {
                    if let Some(&(_, v)) = constants.get(&index) {
                        fixed += v * (stride / 4);
                        continue;
                    }
                    let Some(t) = type_of(index) else { return words.to_vec() };
                    let t_sum = sum.map_or(t, |(t_sum, _)| t_sum);
                    let mut term = index;
                    if t != t_sum {
                        let cast = fresh();
                        body.push(instruction(OP_BITCAST, &[t_sum, cast, term]));
                        term = cast;
                    }
                    if stride != 4 {
                        let scaled = fresh();
                        let factor = constant(t_sum, stride / 4, &mut declarations, &mut fresh);
                        body.push(instruction(OP_I_MUL, &[t_sum, scaled, term, factor]));
                        term = scaled;
                    }
                    sum = Some(match sum {
                        Some((t_sum, acc)) => {
                            let added = fresh();
                            body.push(instruction(OP_I_ADD, &[t_sum, added, acc, term]));
                            (t_sum, added)
                        },
                        None => (t_sum, term),
                    });
                }
                let element = match sum {
                    None => constant(index_type, fixed, &mut declarations, &mut fresh),
                    Some((t_sum, acc)) if fixed != 0 => {
                        let added = fresh();
                        let base = constant(t_sum, fixed, &mut declarations, &mut fresh);
                        body.push(instruction(OP_I_ADD, &[t_sum, added, acc, base]));
                        added
                    },
                    Some((_, acc)) => acc,
                };
                let zero = constant(index_type, 0, &mut declarations, &mut fresh);
                body.push(instruction(op(w), &[w[1], w[2], w[3], zero, element]));
                chains.insert(w[2]);
            },
            OP_LOAD if w.len() >= 4 && chains.contains(&w[3]) => {
                let uint = blocks.values().next().unwrap().uint;
                let scope = constant(uint, SCOPE_DEVICE, &mut declarations, &mut fresh);
                let semantics = constant(uint, 0, &mut declarations, &mut fresh);
                body.push(instruction(OP_ATOMIC_LOAD, &[w[1], w[2], w[3], scope, semantics]));
            },
            _ => body.push(w.to_vec()),
        }
    }
    // (another use of a block's variable: left as it was)
    let chain_ids: BTreeSet<u32> = instructions[first_function..].iter().filter(|w| matches!(op(w), OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN) && w.len() >= 4 && variables.contains_key(&w[3])).map(|w| w[2]).collect();
    let other_use = instructions[first_function..].iter().any(|w| {
        let operands = if untyped(op(w)) { &w[1..] } else if w.len() >= 3 { &w[3..] } else { &w[1..] };
        !matches!(op(w), OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN) && operands.iter().any(|x| variables.contains_key(x))
    });
    if other_use || chain_ids.len() != chains.len() {
        return words.to_vec();
    }
    let first_function = body.iter().position(|w| op(w) == OP_FUNCTION).unwrap_or(body.len());
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
    if first_function >= body.len() {
        for d in &declarations {
            out.extend_from_slice(d);
        }
    }
    out
}
