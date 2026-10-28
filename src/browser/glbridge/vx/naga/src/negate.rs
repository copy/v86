//! Negation of unsigned integers (GLSL's `-v` of a uint or uvec, which is
//! two's complement): glslang writes OpSNegate of the unsigned type, which
//! naga refuses (`InvalidUnaryOperandType(Negate)`: WGSL negates signed
//! integers and floats only). It becomes OpISub from a null (zero) constant
//! of the type, declared before the first function.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

const OP_TYPE_INT: u32 = 21;
const OP_TYPE_VECTOR: u32 = 23;
const OP_CONSTANT_NULL: u32 = 46;
const OP_FUNCTION: u32 = 54;
const OP_S_NEGATE: u32 = 126;
const OP_I_SUB: u32 = 130;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The module with its negations of unsigned integers made subtractions from zero, or the words as they were
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
    let types: BTreeMap<u32, &[u32]> = instructions.iter().filter(|w| (19..=39).contains(&op(w)) && w.len() >= 2).map(|w| (w[1], *w)).collect();
    let unsigned = |ty: u32| {
        let scalar = match types.get(&ty) {
            Some(t) if op(t) == OP_TYPE_VECTOR => t[2],
            _ => ty,
        };
        types.get(&scalar).is_some_and(|t| op(t) == OP_TYPE_INT && t.len() >= 4 && t[3] == 0)
    };
    if !instructions.iter().any(|w| op(w) == OP_S_NEGATE && w.len() == 4 && unsigned(w[1])) {
        return words.to_vec();
    }
    let mut bound = words[3];
    let mut nulls: BTreeMap<u32, u32> = BTreeMap::new();
    let mut declarations: Vec<Vec<u32>> = Vec::new();
    let mut body: Vec<Vec<u32>> = Vec::new();
    for w in &instructions {
        if op(w) == OP_S_NEGATE && w.len() == 4 && unsigned(w[1]) {
            let zero = *nulls.entry(w[1]).or_insert_with(|| {
                let id = bound;
                bound += 1;
                declarations.push(instruction(OP_CONSTANT_NULL, &[w[1], id]));
                id
            });
            body.push(instruction(OP_I_SUB, &[w[1], w[2], zero, w[3]]));
        }
        else {
            body.push(w.to_vec());
        }
    }
    let first_function = instructions.iter().position(|w| op(w) == OP_FUNCTION).unwrap_or(instructions.len());
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
