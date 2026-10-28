//! Atomic operations whose value is of the other signedness than their
//! result: glslang writes GLSL ES 3.1's atomic counters (in Vulkan's rules,
//! a storage block of `uint`s) as `OpAtomicIAdd` of a signed constant 1 or
//! -1, which naga refuses (`InvalidAtomic`). The value becomes the result's
//! type: a constant of the same bits, declared before the first function,
//! or an `OpBitcast` before the operation.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

const OP_TYPE_INT: u32 = 21;
const OP_CONSTANT: u32 = 43;
const OP_FUNCTION: u32 = 54;
const OP_BITCAST: u32 = 124;
/// the operations whose last operand is a value of the result's type
const OP_ATOMIC_EXCHANGE: u32 = 229;
const OP_ATOMIC_I_ADD: u32 = 234;
const OP_ATOMIC_XOR: u32 = 242;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The module with its atomic operations' values of their results' types,
/// or the words as they were when none needs it
pub fn values(words: &[u32]) -> Vec<u32> {
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
    // the integer types (id: width, signedness), the values' types (constants' and other results')
    let mut ints: BTreeMap<u32, (u32, u32)> = BTreeMap::new();
    let mut types: BTreeMap<u32, u32> = BTreeMap::new();
    let mut constants: BTreeMap<u32, (u32, u32)> = BTreeMap::new();
    for w in &instructions {
        match op(w) {
            OP_TYPE_INT if w.len() >= 4 => {
                ints.insert(w[1], (w[2], w[3]));
            },
            OP_CONSTANT if w.len() >= 4 => {
                constants.insert(w[2], (w[1], w[3]));
                types.insert(w[2], w[1]);
            },
            // (a result type and a result: function calls, loads, extracts, conversions, arithmetic, atomics, phis)
            o if w.len() >= 3 && matches!(o, 57 | 61 | 81 | 109..=124 | 126..=200 | 227 | 229..=242 | 245) => {
                types.insert(w[2], w[1]);
            },
            _ => {},
        }
    }
    let is_atomic_value = |w: &[u32]| matches!(op(w), OP_ATOMIC_EXCHANGE | OP_ATOMIC_I_ADD..=OP_ATOMIC_XOR) && w.len() >= 7;
    let mismatched = |w: &[u32]| {
        let value = w[w.len() - 1];
        let result = w[1];
        match (types.get(&value), ints.get(&result)) {
            (Some(&t), Some(&(width, _))) => t != result && ints.get(&t).map_or(false, |&(w2, _)| w2 == width),
            _ => false,
        }
    };
    if !instructions.iter().any(|w| is_atomic_value(w) && mismatched(w)) {
        return words.to_vec();
    }
    let mut bound = words[3];
    let mut fresh = || {
        let id = bound;
        bound += 1;
        id
    };
    // constants of the results' types: (type, bits) to id
    let mut own: BTreeMap<(u32, u32), u32> = constants.iter().map(|(&id, &(t, v))| ((t, v), id)).collect();
    let mut declarations: Vec<Vec<u32>> = Vec::new();
    let mut body: Vec<Vec<u32>> = Vec::new();
    let first_function = instructions.iter().position(|w| op(w) == OP_FUNCTION).unwrap_or(instructions.len());
    for (i, w) in instructions.iter().enumerate() {
        if i < first_function || !(is_atomic_value(w) && mismatched(w)) {
            body.push(w.to_vec());
            continue;
        }
        let value = w[w.len() - 1];
        let result_type = w[1];
        let replacement = match constants.get(&value) {
            Some(&(_, bits)) => *own.entry((result_type, bits)).or_insert_with(|| {
                let id = fresh();
                declarations.push(instruction(OP_CONSTANT, &[result_type, id, bits]));
                id
            }),
            None => {
                let id = fresh();
                body.push(instruction(OP_BITCAST, &[result_type, id, value]));
                id
            },
        };
        let mut changed = w.to_vec();
        let last = changed.len() - 1;
        changed[last] = replacement;
        body.push(changed);
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
    if first_function >= body.len() {
        for d in &declarations {
            out.extend_from_slice(d);
        }
    }
    out
}
