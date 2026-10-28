//! Outputs of a struct type at a location (GLSL's `out S var;`, a struct
//! varying): naga's SPIR-V front end makes an output struct's members the
//! entry point's results only when they have bindings of their own, so the
//! whole output went missing (and the next stage's input had nothing to
//! read). Here each member gets a location of its own, consecutive from the
//! variable's (a matrix's columns, an array's elements), with the
//! variable's interpolation decorations; io.rs then splits them as it does
//! any other output.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

const OP_TYPE_MATRIX: u32 = 24;
const OP_TYPE_ARRAY: u32 = 28;
const OP_TYPE_STRUCT: u32 = 30;
const OP_TYPE_POINTER: u32 = 32;
const OP_CONSTANT: u32 = 43;
const OP_FUNCTION: u32 = 54;
const OP_VARIABLE: u32 = 59;
const OP_DECORATE: u32 = 71;
const OP_MEMBER_DECORATE: u32 = 72;
const STORAGE_OUTPUT: u32 = 3;
const DECORATION_BUILTIN: u32 = 11;
const DECORATION_LOCATION: u32 = 30;
/// what a member takes of its variable: NoPerspective, Flat, Centroid, Sample
const INTERPOLATION: [u32; 4] = [13, 14, 16, 17];

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The module with its struct outputs' members at locations of their own, or the words as they were
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
    let mut types: BTreeMap<u32, &[u32]> = BTreeMap::new();
    let mut constants: BTreeMap<u32, u32> = BTreeMap::new();
    let mut decorations: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
    let mut member_decorated: BTreeMap<u32, bool> = BTreeMap::new();
    let mut outputs: Vec<(u32, u32)> = Vec::new();
    for w in &instructions {
        match op(w) {
            19..=39 if w.len() >= 2 => {
                types.insert(w[1], *w);
            },
            OP_CONSTANT if w.len() == 4 => {
                constants.insert(w[2], w[3]);
            },
            OP_DECORATE if w.len() >= 3 => decorations.entry(w[1]).or_default().push((w[2], w.get(3).copied().unwrap_or(0))),
            OP_MEMBER_DECORATE if w.len() >= 4 && (w[3] == DECORATION_LOCATION || w[3] == DECORATION_BUILTIN) => {
                member_decorated.insert(w[1], true);
            },
            OP_VARIABLE if w.len() >= 4 && w[3] == STORAGE_OUTPUT => outputs.push((w[2], w[1])),
            _ => {},
        }
    }
    // the locations a type takes
    fn span(types: &BTreeMap<u32, &[u32]>, constants: &BTreeMap<u32, u32>, ty: u32) -> u32 {
        match types.get(&ty) {
            Some(t) if t[0] & 0xFFFF == OP_TYPE_MATRIX => t[3],
            Some(t) if t[0] & 0xFFFF == OP_TYPE_ARRAY => constants.get(&t[3]).copied().unwrap_or(1) * span(types, constants, t[2]),
            Some(t) if t[0] & 0xFFFF == OP_TYPE_STRUCT => t[2..].iter().map(|&m| span(types, constants, m)).sum(),
            _ => 1,
        }
    }
    let mut added: Vec<Vec<u32>> = Vec::new();
    for (var, pointer) in outputs {
        let Some(p) = types.get(&pointer).filter(|p| op(p) == OP_TYPE_POINTER && p.len() >= 4) else { continue };
        let ty = p[3];
        let Some(s) = types.get(&ty).filter(|s| op(s) == OP_TYPE_STRUCT) else { continue };
        if member_decorated.contains_key(&ty) {
            continue;
        }
        let decorated = decorations.get(&var).cloned().unwrap_or_default();
        let Some(&(_, location)) = decorated.iter().find(|(d, _)| *d == DECORATION_LOCATION) else { continue };
        let mut next = location;
        for (m, &member) in s[2..].iter().enumerate() {
            added.push(instruction(OP_MEMBER_DECORATE, &[ty, m as u32, DECORATION_LOCATION, next]));
            for &(d, _) in decorated.iter().filter(|(d, _)| INTERPOLATION.contains(d)) {
                added.push(instruction(OP_MEMBER_DECORATE, &[ty, m as u32, d]));
            }
            next += span(&types, &constants, member);
        }
        member_decorated.insert(ty, true);
    }
    if added.is_empty() {
        return words.to_vec();
    }
    // (the new decorations with the others: before the first type)
    let first_type = instructions.iter().position(|w| (19..=39).contains(&op(w)) || op(w) == OP_FUNCTION).unwrap_or(instructions.len());
    let mut out = words[..5].to_vec();
    for (i, w) in instructions.iter().enumerate() {
        if i == first_type {
            for d in &added {
                out.extend_from_slice(d);
            }
        }
        out.extend_from_slice(w);
    }
    out
}
