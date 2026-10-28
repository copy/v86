//! Integer operations naga cannot read as glslang writes them:
//! - negation of unsigned integers (GLSL's `-v` of a uint or uvec, which is
//!   two's complement): OpSNegate of the unsigned type, which naga refuses
//!   (`InvalidUnaryOperandType(Negate)`: WGSL negates signed integers and
//!   floats only), becomes OpISub from a null (zero) constant of the type,
//!   declared before the first function;
//! - GLSL's `%` of signed integers: OpSMod, which naga lowers through
//!   floor (refused for integers), becomes OpSRem, WGSL's `%`: the two
//!   differ only for negative operands, whose result GLSL ES leaves
//!   undefined;
//! - bitCount, findLSB and findMSB of unsigned integers (an `int` result):
//!   OpBitCount and GLSL.std.450's FindILsb, FindSMsb and FindUMsb of
//!   another signedness than their result, whose result naga gives the
//!   operand's type (`InvalidStoreTypes` where it is stored), become the
//!   operation in the operand's type, then an OpBitcast to the result's.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

const OP_EXT_INST_IMPORT: u32 = 11;
const OP_EXT_INST: u32 = 12;
const OP_TYPE_INT: u32 = 21;
const OP_CONSTANT: u32 = 43;
const OP_BITCAST: u32 = 124;
const OP_BIT_COUNT: u32 = 205;
/// GLSL.std.450's FindILsb, FindSMsb, FindUMsb
const GLSL_FIND_BITS: [u32; 3] = [73, 74, 75];
const OP_TYPE_VECTOR: u32 = 23;
const OP_CONSTANT_NULL: u32 = 46;
const OP_FUNCTION: u32 = 54;
const OP_S_NEGATE: u32 = 126;
const OP_I_SUB: u32 = 130;
const OP_S_REM: u32 = 138;
const OP_S_MOD: u32 = 139;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The opcodes in a function that have no result type (intsample.rs's)
fn untyped(op: u32) -> bool { matches!(op, 8 | 56 | 62 | 63 | 99 | 224 | 225 | 246..=255 | 317) }

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
    let integer = |ty: u32| {
        let scalar = match types.get(&ty) {
            Some(t) if op(t) == OP_TYPE_VECTOR => t[2],
            _ => ty,
        };
        types.get(&scalar).is_some_and(|t| op(t) == OP_TYPE_INT)
    };
    // the bit operations' operands of another type than their results (by the values' types: constants' and results')
    let glsl = instructions.iter().find(|w| op(w) == OP_EXT_INST_IMPORT && w.len() >= 3 && w[2..].iter().flat_map(|x| x.to_le_bytes())
        .take_while(|&b| b != 0).eq(b"GLSL.std.450".iter().copied())).map(|w| w[1]);
    let first_function = instructions.iter().position(|w| op(w) == OP_FUNCTION).unwrap_or(instructions.len());
    let values: BTreeMap<u32, u32> = instructions.iter().enumerate()
        .filter(|(i, w)| w.len() >= 3 && (*i >= first_function && !untyped(op(w)) || op(w) == OP_CONSTANT))
        .map(|(_, w)| (w[2], w[1])).collect();
    let operand_of = |w: &[u32]| -> Option<u32> {
        if op(w) == OP_BIT_COUNT && w.len() == 4 {
            return Some(w[3]);
        }
        (op(w) == OP_EXT_INST && w.len() == 6 && Some(w[3]) == glsl && GLSL_FIND_BITS.contains(&w[4])).then(|| w[5])
    };
    let mismatched = |w: &[u32]| -> Option<u32> {
        let ty = *values.get(&operand_of(w)?)?;
        (ty != w[1] && integer(ty) && integer(w[1])).then_some(ty)
    };
    if !instructions.iter().any(|w| op(w) == OP_S_NEGATE && w.len() == 4 && unsigned(w[1]) || op(w) == OP_S_MOD && w.len() == 5 && integer(w[1])
        || mismatched(w).is_some()) {
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
        else if op(w) == OP_S_MOD && w.len() == 5 && integer(w[1]) {
            body.push(instruction(OP_S_REM, &w[1..]));
        }
        else if let Some(ty) = mismatched(w) {
            // (the operation in the operand's type, under a new id; the result's id its bitcast)
            let id = bound;
            bound += 1;
            let mut changed = w[1..].to_vec();
            changed[0] = ty;
            changed[1] = id;
            body.push(instruction(op(w), &changed));
            body.push(instruction(OP_BITCAST, &[w[1], w[2], id]));
        }
        else {
            body.push(w.to_vec());
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
    if first_function >= body.len() {
        for d in &declarations {
            out.extend_from_slice(d);
        }
    }
    out
}
