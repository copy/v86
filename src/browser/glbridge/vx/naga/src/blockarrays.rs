//! Descriptor arrays (GLSL's `uniform B { ... } b[2];` and `uniform
//! sampler2D s[4];`): WGSL binds no arrays of buffers, and WebGPU no
//! arrays of textures or samplers, so each element a shader uses becomes a
//! variable of its own, element 0 at the array's binding, element e > 0 at
//! `ELEMENT_BINDING + 16 * binding + e` (lib.rs's rebind makes that WGSL's
//! 300 + 2 (16b + e), its split sampler's one more), and each access chain
//! into the array with a constant index starts at that element's variable
//! (or is that variable, with no more indices). An array indexed otherwise,
//! used other than by access chains, or of a binding past 19, is left as it
//! was (GLSL ES 3.0 indexes them with constant expressions only). This runs
//! before split.rs, which splits the combined elements as any other.
//!
//! A module marked by `OpModuleProcessed` CONSECUTIVE (the GLES host's,
//! glsl_program.js, whose bindings give each element of a block array a
//! binding of its own, the array's plus the index) has its arrays of
//! blocks' elements at those bindings, of any binding and length.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;

/// The SPIR-V bindings of the elements after the first
pub const ELEMENT_BINDING: u32 = 0x20000;
/// The elements an array can have, and the largest binding of one
pub const ELEMENTS_A_BINDING: u32 = 16;
const LAST_BINDING: u32 = 19;
/// The marker of modules whose block arrays' elements have consecutive bindings
pub const CONSECUTIVE: &[u8] = b"vx consecutive block elements";
const OP_MODULE_PROCESSED: u32 = 330;

const OP_TYPE_IMAGE: u32 = 25;
const OP_TYPE_SAMPLER: u32 = 26;
const OP_TYPE_SAMPLED_IMAGE: u32 = 27;
const OP_TYPE_ARRAY: u32 = 28;
const OP_TYPE_STRUCT: u32 = 30;
const OP_TYPE_POINTER: u32 = 32;
const OP_CONSTANT: u32 = 43;
const OP_FUNCTION: u32 = 54;
const OP_FUNCTION_CALL: u32 = 57;
const OP_VARIABLE: u32 = 59;
const OP_LOAD: u32 = 61;
const OP_ARRAY_LENGTH: u32 = 68;
const OP_ACCESS_CHAIN: u32 = 65;
const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
const OP_DECORATE: u32 = 71;
const DECORATION_BLOCK: u32 = 2;
const DECORATION_BUFFER_BLOCK: u32 = 3;
const DECORATION_BINDING: u32 = 33;
const DECORATION_DESCRIPTOR_SET: u32 = 34;

/// Whether word i of an instruction of this opcode is a literal, not an id
/// (the ones a function's code has that might equal one by chance)
pub(crate) fn literal(op: u32, i: usize) -> bool {
    match op {
        8 | 317 => true,                       // OpLine, OpNoLine
        12 => i == 4,                          // OpExtInst's instruction
        61 => i >= 4,                          // OpLoad's memory access
        62 => i >= 3,                          // OpStore's
        79 => i >= 5,                          // OpVectorShuffle's components
        81 => i >= 4,                          // OpCompositeExtract's indices
        82 => i >= 5,                          // OpCompositeInsert's
        87 | 88 | 91 | 92 | 95 | 98 => i == 5, // image operands' masks
        89 | 90 | 93 | 94 | 96 | 97 => i == 6,
        99 => i == 4,
        59 => i == 3,                          // OpVariable's storage class
        246 => i >= 3,                         // OpLoopMerge's controls
        247 => i == 2,                         // OpSelectionMerge's
        250 => i >= 4,                         // OpBranchConditional's weights
        _ => false,
    }
}

/// Whether an instruction names `id` among its operands: its ids, not its
/// literals (a member's offset, a constant's value, a pointer's storage
/// class, an entry point's name), and nothing for debug names, decorations
/// and the module's settings, which keep no type declared (layout.rs's too)
pub(crate) fn names(w: &[u32], id: u32) -> bool {
    let at = |i: usize| w.get(i) == Some(&id);
    match w[0] & 0xFFFF {
        2..=11 | 14 | 16 | 17 | 19..=22 | 26 | 71..=74 | 330..=332 => false,
        // (OpEntryPoint: its function, and its interface after the name's words)
        15 => {
            let name_end = w.iter().skip(3).position(|x| x.to_le_bytes().contains(&0)).map_or(w.len(), |p| p + 4);
            at(2) || w.iter().skip(name_end).any(|&x| x == id)
        },
        23..=25 | 27 | 29 => at(2),
        32 => at(3),
        43 | 50 => at(1),
        52 => at(1) || w.iter().skip(4).any(|&x| x == id),
        _ => w.iter().enumerate().skip(1).any(|(i, &x)| x == id && !literal(w[0] & 0xFFFF, i)),
    }
}

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The module with its arrays of blocks split, or the words as they were
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
    let constants: BTreeMap<u32, u32> = instructions.iter().filter(|w| op(w) == OP_CONSTANT && w.len() == 4).map(|w| (w[2], w[3])).collect();
    let blocks: Vec<u32> = instructions.iter().filter(|w| op(w) == OP_DECORATE && w.len() >= 3 && matches!(w[2], DECORATION_BLOCK | DECORATION_BUFFER_BLOCK))
        .map(|w| w[1]).collect();
    let decoration = |id: u32, d: u32| instructions.iter().find(|w| op(w) == OP_DECORATE && w.len() >= 4 && w[1] == id && w[2] == d).map(|w| w[3]);
    let marker = |w: &[u32]| op(w) == OP_MODULE_PROCESSED && w[1..].iter().flat_map(|x| x.to_le_bytes()).take_while(|&b| b != 0).eq(CONSECUTIVE.iter().copied());
    let consecutive = instructions.iter().any(|w| marker(w));
    // the variables of arrays of blocks: (variable, its class, the block, the length, set, binding, its elements' bindings consecutive)
    let mut arrays = Vec::new();
    for w in &instructions {
        if op(w) != OP_VARIABLE || w.len() < 4 {
            continue;
        }
        let Some(pointer) = types.get(&w[1]) else { continue };
        if op(pointer) != OP_TYPE_POINTER || pointer.len() < 4 {
            continue;
        }
        let Some(array) = types.get(&pointer[3]) else { continue };
        if op(array) != OP_TYPE_ARRAY {
            continue;
        }
        let element = types.get(&array[2]).map(|t| op(t));
        let block = blocks.contains(&array[2]) && element == Some(OP_TYPE_STRUCT);
        if !block && !matches!(element, Some(OP_TYPE_IMAGE | OP_TYPE_SAMPLER | OP_TYPE_SAMPLED_IMAGE)) {
            continue;
        }
        let (Some(&length), Some(set), Some(binding)) = (constants.get(&array[3]), decoration(w[2], DECORATION_DESCRIPTOR_SET), decoration(w[2], DECORATION_BINDING))
        else {
            continue;
        };
        let own_bindings = block && consecutive;
        if length < 1 || !own_bindings && (length > ELEMENTS_A_BINDING || binding > LAST_BINDING) {
            continue;
        }
        arrays.push((w[2], pointer[2], array[2], length, set, binding, own_bindings, w[1], pointer[3]));
    }
    if arrays.is_empty() {
        return words.to_vec();
    }
    // (an entry point listing one among its interface: SPIR-V 1.4's, not done)
    const OP_ENTRY_POINT: u32 = 15;
    if instructions.iter().any(|w| op(w) == OP_ENTRY_POINT && arrays.iter().any(|a| w[3..].contains(&a.0))) {
        return words.to_vec();
    }
    // every use of such a variable: an access chain with a constant first
    // index (the elements used); a chain of that index alone is the
    // element's variable, which only loads, calls and array lengths may then use
    let first_function = instructions.iter().position(|w| op(w) == OP_FUNCTION).unwrap_or(instructions.len());
    let mut used_elements: BTreeSet<(u32, u32)> = BTreeSet::new();
    let mut whole: BTreeMap<u32, (u32, u32)> = BTreeMap::new();
    for w in &instructions[first_function..] {
        let chain = matches!(op(w), OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN) && w.len() >= 5;
        for &(var, ..) in &arrays {
            let used = w[1..].iter().enumerate().any(|(i, &x)| x == var && !(chain && i + 1 == 3) && !literal(op(w), i + 1));
            if used || chain && w[3] == var && !constants.contains_key(&w[4]) {
                return words.to_vec();
            }
            if chain && w[3] == var {
                used_elements.insert((var, constants[&w[4]]));
                if w.len() == 5 {
                    whole.insert(w[2], (var, constants[&w[4]]));
                }
            }
        }
        // (a load's pointer, an array length's structure, a call's arguments, a chain's own result or base)
        let allowed = |i: usize| match op(w) {
            OP_LOAD | OP_ARRAY_LENGTH => i == 3,
            OP_FUNCTION_CALL => i >= 4,
            OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN => i == 2 || i == 3,
            _ => false,
        };
        if w.iter().enumerate().skip(1).any(|(i, x)| whole.contains_key(x) && !allowed(i) && !literal(op(w), i)) {
            return words.to_vec();
        }
    }
    let mut bound = words[3];
    let mut fresh = || {
        bound += 1;
        bound - 1
    };
    // the elements' variables, and pointer types to the blocks
    let mut declarations: Vec<Vec<u32>> = Vec::new();
    let mut annotations: Vec<Vec<u32>> = Vec::new();
    let mut elements: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    let mut pointers: BTreeMap<(u32, u32), u32> = types.values().filter(|w| op(w) == OP_TYPE_POINTER && w.len() >= 4).map(|w| ((w[2], w[3]), w[1])).collect();
    for &(var, class, block, length, set, binding, own_bindings, ..) in &arrays {
        let pointer = match pointers.get(&(class, block)) {
            Some(&p) => p,
            None => {
                let p = fresh();
                declarations.push(instruction(OP_TYPE_POINTER, &[p, class, block]));
                pointers.insert((class, block), p);
                p
            },
        };
        let mut list = Vec::new();
        for e in 0..length {
            // (the elements not used: none)
            if !used_elements.contains(&(var, e)) {
                list.push(0);
                continue;
            }
            let id = fresh();
            declarations.push(instruction(OP_VARIABLE, &[pointer, id, class]));
            annotations.push(instruction(OP_DECORATE, &[id, DECORATION_DESCRIPTOR_SET, set]));
            let element_binding = if e == 0 { binding } else if own_bindings { binding + e } else { ELEMENT_BINDING + ELEMENTS_A_BINDING * binding + e };
            annotations.push(instruction(OP_DECORATE, &[id, DECORATION_BINDING, element_binding]));
            list.push(id);
        }
        elements.insert(var, list);
    }
    // the arrays' pointer and array types where nothing else names them (an array of blocks with an unsized array, which
    // naga refuses to declare at all)
    const OP_NAME: u32 = 5;
    let naming = |w: &[u32]| matches!(op(w), OP_NAME | OP_DECORATE);
    let variables: BTreeSet<u32> = arrays.iter().map(|a| a.0).collect();
    let dead_pointers: BTreeSet<u32> = arrays.iter().map(|a| a.7).filter(|&p| !instructions.iter().any(|w| {
        let defines = op(w) == OP_TYPE_POINTER && w[1] == p || op(w) == OP_VARIABLE && w.len() >= 3 && variables.contains(&w[2]);
        !defines && names(w, p)
    })).collect();
    let dead_arrays: BTreeSet<u32> = arrays.iter().filter(|a| dead_pointers.contains(&a.7)).map(|a| a.8).filter(|&t| !instructions.iter().any(|w| {
        let defines = op(w) == OP_TYPE_ARRAY && w[1] == t || op(w) == OP_TYPE_POINTER && dead_pointers.contains(&w[1]);
        !defines && names(w, t)
    })).collect();
    let dead = |id: u32| dead_pointers.contains(&id) || dead_arrays.contains(&id);
    let first_global = instructions.iter().position(|w| matches!(op(w), 19..=39 | 41..=52 | OP_VARIABLE)).unwrap_or(first_function);
    let mut out = words[..5].to_vec();
    for (i, w) in instructions.iter().enumerate() {
        if i == first_global {
            for a in &annotations {
                out.extend_from_slice(a);
            }
        }
        if i == first_function {
            for d in &declarations {
                out.extend_from_slice(d);
            }
        }
        let o = op(w);
        // the arrays' variables and their decorations go, and the marker, and the types nothing names
        if marker(w) || matches!(o, OP_TYPE_POINTER | OP_TYPE_ARRAY) && dead(w[1]) || naming(w) && w.len() >= 2 && dead(w[1]) {
            continue;
        }
        if o == OP_VARIABLE && w.len() >= 3 && elements.contains_key(&w[2]) || o == OP_DECORATE && w.len() >= 2 && elements.contains_key(&w[1]) {
            continue;
        }
        if matches!(o, OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN) && w.len() >= 5 {
            if let Some(list) = elements.get(&w[3]) {
                let e = constants[&w[4]] as usize;
                if e >= list.len() {
                    return words.to_vec();
                }
                // (a chain of the index alone: the element's variable in its uses)
                if w.len() == 5 {
                    continue;
                }
                let mut operands = Vec::from([w[1], w[2], list[e]]);
                operands.extend_from_slice(&w[5..]);
                out.extend_from_slice(&instruction(o, &operands));
                continue;
            }
        }
        let element_of = |id: u32| whole.get(&id).map(|&(var, e)| elements[&var][e as usize]);
        if matches!(o, OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN) && w.len() >= 4 {
            if let Some(v) = element_of(w[3]) {
                let mut c = w.to_vec();
                c[3] = v;
                out.extend_from_slice(&c);
                continue;
            }
        }
        if matches!(o, OP_LOAD | OP_ARRAY_LENGTH) && w.len() >= 4 {
            if let Some(v) = element_of(w[3]) {
                let mut l = w.to_vec();
                l[3] = v;
                out.extend_from_slice(&l);
                continue;
            }
        }
        if o == OP_FUNCTION_CALL && w.len() >= 4 && w[4..].iter().any(|x| whole.contains_key(x)) {
            let mut c = w.to_vec();
            for x in c[4..].iter_mut() {
                if let Some(v) = element_of(*x) {
                    *x = v;
                }
            }
            out.extend_from_slice(&c);
            continue;
        }
        out.extend_from_slice(w);
    }
    out[3] = bound;
    out
}
