//! Input attachments (`subpassInput`, SubpassData images): WGSL has none, so
//! each becomes a 2D (or multisampled 2D) texture of the same binding, read
//! at the fragment's position: OpImageRead's coordinate (an offset) plus
//! `gl_FragCoord.xy` (declared when the shader has none). VX binds the view
//! as a texture, and a copy of it when it is attached to the draw's pass
//! (vx_executor.js attachmentCopies).

use alloc::vec::Vec;

const OP_CAPABILITY: u32 = 17;
const OP_ENTRY_POINT: u32 = 15;
const OP_TYPE_INT: u32 = 21;
const OP_TYPE_FLOAT: u32 = 22;
const OP_TYPE_VECTOR: u32 = 23;
const OP_TYPE_IMAGE: u32 = 25;
const OP_TYPE_POINTER: u32 = 32;
const OP_CONSTANT: u32 = 43;
const OP_FUNCTION: u32 = 54;
const OP_VARIABLE: u32 = 59;
const OP_LOAD: u32 = 61;
const OP_DECORATE: u32 = 71;
const OP_VECTOR_SHUFFLE: u32 = 79;
const OP_IMAGE_FETCH: u32 = 95;
const OP_IMAGE_READ: u32 = 98;
const OP_CONVERT_F_TO_S: u32 = 110;
const OP_I_ADD: u32 = 128;
const DIM_SUBPASS_DATA: u32 = 6;
const CAPABILITY_INPUT_ATTACHMENT: u32 = 40;
const DECORATION_BUILTIN: u32 = 11;
const DECORATION_INPUT_ATTACHMENT_INDEX: u32 = 43;
const BUILTIN_FRAG_COORD: u32 = 15;
const STORAGE_INPUT: u32 = 1;
const IMAGE_OPERANDS_LOD: u32 = 2;
const IMAGE_OPERANDS_SAMPLE: u32 = 0x40;
const EXECUTION_MODEL_FRAGMENT: u32 = 4;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

fn untyped(op: u32) -> bool { matches!(op, 8 | 56 | 62 | 63 | 99 | 224 | 225 | 246..=255 | 317) }

/// The module with its input attachments made textures, or the words as they were
pub fn lower(words: &[u32]) -> Vec<u32> {
    if words.len() < 5 {
        return words.to_vec();
    }
    let mut instructions: Vec<Vec<u32>> = Vec::new();
    let mut at = 5;
    while at < words.len() {
        let count = (words[at] >> 16) as usize;
        if count == 0 || at + count > words.len() {
            return words.to_vec();
        }
        instructions.push(words[at..at + count].to_vec());
        at += count;
    }
    let op = |w: &[u32]| w[0] & 0xFFFF;
    let subpass: Vec<u32> = instructions.iter().filter(|w| op(w) == OP_TYPE_IMAGE && w.len() >= 9 && w[3] == DIM_SUBPASS_DATA).map(|w| w[1]).collect();
    if subpass.is_empty() {
        return words.to_vec();
    }
    let mut bound = words[3];
    let mut fresh = || {
        bound += 1;
        bound - 1
    };
    let first_function = instructions.iter().position(|w| op(w) == OP_FUNCTION).unwrap_or(instructions.len());
    // the types and the fragment position this needs, existing or new
    let find = |pred: &dyn Fn(&[u32]) -> bool| instructions[..first_function].iter().find(|w| pred(w)).map(|w| w[1]);
    let mut declarations: Vec<Vec<u32>> = Vec::new();
    let mut annotations: Vec<Vec<u32>> = Vec::new();
    let float = match find(&|w| op(w) == OP_TYPE_FLOAT && w[2] == 32) {
        Some(id) => id,
        None => { let id = fresh(); declarations.push(instruction(OP_TYPE_FLOAT, &[id, 32])); id },
    };
    let int = match find(&|w| op(w) == OP_TYPE_INT && w[2] == 32 && w[3] == 1) {
        Some(id) => id,
        None => { let id = fresh(); declarations.push(instruction(OP_TYPE_INT, &[id, 32, 1])); id },
    };
    let vector = |component: u32, n: u32, declarations: &mut Vec<Vec<u32>>, fresh: &mut dyn FnMut() -> u32| -> u32 {
        if let Some(id) = instructions[..first_function].iter().chain(declarations.iter())
            .find(|w| op(w) == OP_TYPE_VECTOR && w[2] == component && w[3] == n).map(|w| w[1]) {
            return id;
        }
        let id = fresh();
        declarations.push(instruction(OP_TYPE_VECTOR, &[id, component, n]));
        id
    };
    let vec4 = vector(float, 4, &mut declarations, &mut fresh);
    let vec2 = vector(float, 2, &mut declarations, &mut fresh);
    let ivec2 = vector(int, 2, &mut declarations, &mut fresh);
    let zero = match find(&|w| op(w) == OP_CONSTANT && w[1] == int && w[3] == 0) {
        Some(_) => instructions[..first_function].iter().find(|w| op(w) == OP_CONSTANT && w[1] == int && w[3] == 0).map(|w| w[2]).unwrap(),
        None => { let id = fresh(); declarations.push(instruction(OP_CONSTANT, &[int, id, 0])); id },
    };
    // gl_FragCoord: the shader's, or a new input
    let frag_coord_vars: Vec<u32> = instructions.iter().filter(|w| op(w) == OP_DECORATE && w.len() >= 4 && w[2] == DECORATION_BUILTIN && w[3] == BUILTIN_FRAG_COORD)
        .map(|w| w[1]).collect();
    let frag_coord = match instructions[..first_function].iter().find(|w| op(w) == OP_VARIABLE && frag_coord_vars.contains(&w[2])) {
        Some(w) => w[2],
        None => {
            let pointer = match instructions[..first_function].iter().find(|w| op(w) == OP_TYPE_POINTER && w[2] == STORAGE_INPUT && w[3] == vec4) {
                Some(w) => w[1],
                None => { let id = fresh(); declarations.push(instruction(OP_TYPE_POINTER, &[id, STORAGE_INPUT, vec4])); id },
            };
            let id = fresh();
            declarations.push(instruction(OP_VARIABLE, &[pointer, id, STORAGE_INPUT]));
            annotations.push(instruction(OP_DECORATE, &[id, DECORATION_BUILTIN, BUILTIN_FRAG_COORD]));
            id
        },
    };
    let declared_new_input = !instructions[..first_function].iter().any(|w| op(w) == OP_VARIABLE && w[2] == frag_coord);
    // the types of values, for the reads' images
    let mut type_of = alloc::collections::BTreeMap::new();
    for w in &instructions[first_function..] {
        if w.len() >= 3 && !untyped(op(w)) && op(w) != 248 {
            type_of.insert(w[2], w[1]);
        }
    }
    let mut out: Vec<u32> = words[..5].to_vec();
    let first_global = instructions.iter().position(|w| matches!(op(w), 19..=39 | 41..=52 | OP_VARIABLE)).unwrap_or(first_function);
    for (i, w) in instructions.iter().enumerate() {
        let o = op(w);
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
        if o == OP_CAPABILITY && w.get(1) == Some(&CAPABILITY_INPUT_ATTACHMENT) {
            continue;
        }
        if o == OP_DECORATE && w.len() >= 3 && w[2] == DECORATION_INPUT_ATTACHMENT_INDEX {
            continue;
        }
        if o == OP_TYPE_IMAGE && subpass.contains(&w[1]) {
            // a 2D sampled image of the same texel type and multisampling
            out.extend_from_slice(&instruction(OP_TYPE_IMAGE, &[w[1], w[2], 1, w[4], 0, w[6], 1, 0]));
            continue;
        }
        if o == OP_ENTRY_POINT && declared_new_input && w.len() >= 3 && w[1] == EXECUTION_MODEL_FRAGMENT {
            let mut e = w.clone();
            e.push(frag_coord);
            e[0] = (e.len() as u32) << 16 | OP_ENTRY_POINT;
            out.extend_from_slice(&e);
            continue;
        }
        if o == OP_IMAGE_READ && w.len() >= 5 && type_of.get(&w[3]).is_some_and(|t| subpass.contains(t)) {
            let (rt, result, image, coord) = (w[1], w[2], w[3], w[4]);
            let ms = w.len() >= 7 && w[5] & IMAGE_OPERANDS_SAMPLE != 0;
            let (fc, xy, ixy, place) = (fresh(), fresh(), fresh(), fresh());
            out.extend_from_slice(&instruction(OP_LOAD, &[vec4, fc, frag_coord]));
            out.extend_from_slice(&instruction(OP_VECTOR_SHUFFLE, &[vec2, xy, fc, fc, 0, 1]));
            out.extend_from_slice(&instruction(OP_CONVERT_F_TO_S, &[ivec2, ixy, xy]));
            out.extend_from_slice(&instruction(OP_I_ADD, &[ivec2, place, ixy, coord]));
            if ms {
                out.extend_from_slice(&instruction(OP_IMAGE_FETCH, &[rt, result, image, place, IMAGE_OPERANDS_SAMPLE, w[6]]));
            }
            else {
                out.extend_from_slice(&instruction(OP_IMAGE_FETCH, &[rt, result, image, place, IMAGE_OPERANDS_LOD, zero]));
            }
            continue;
        }
        out.extend_from_slice(w);
    }
    if first_function == instructions.len() {
        for d in &declarations {
            out.extend_from_slice(d);
        }
    }
    out[3] = bound;
    out
}
