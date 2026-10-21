//! Combined image samplers (GLSL's `sampler2D`, as glslang writes them) as
//! separate images and samplers: naga reads only the separate kind
//! (`OpSampledImage` of an image and a sampler). Each UniformConstant
//! variable of an `OpTypeSampledImage` (or an array of them) becomes a
//! variable of the image, and a new one of the sampler, bound at the same
//! set with the binding `SAMPLER_BINDING + binding`; each load of it loads
//! both and makes the sampled image of them.

use alloc::vec::Vec;
use alloc::collections::BTreeMap;

/// The bindings of the samplers split off: SAMPLER_BINDING + the binding
pub const SAMPLER_BINDING: u32 = 0x10000;

const OP_ENTRY_POINT: u32 = 15;
const OP_TYPE_SAMPLER: u32 = 26;
const OP_TYPE_SAMPLED_IMAGE: u32 = 27;
const OP_TYPE_ARRAY: u32 = 28;
const OP_TYPE_RUNTIME_ARRAY: u32 = 29;
const OP_TYPE_POINTER: u32 = 32;
const OP_FUNCTION: u32 = 54;
const OP_VARIABLE: u32 = 59;
const OP_LOAD: u32 = 61;
const OP_ACCESS_CHAIN: u32 = 65;
const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
const OP_DECORATE: u32 = 71;
const OP_SAMPLED_IMAGE: u32 = 86;
const DECORATION_BINDING: u32 = 33;
const DECORATION_DESCRIPTOR_SET: u32 = 34;
const UNIFORM_CONSTANT: u32 = 0;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// What a combined pointer type points at
#[derive(Clone, Copy)]
enum Pointee {
    /// a sampled image of this image type
    One { image: u32 },
    /// an array of them: (length id or none for runtime arrays)
    Array { image: u32, length: Option<u32> },
}

/// The module with its combined image samplers split, or the words as they
/// were when it has none
pub fn split(words: &[u32]) -> Vec<u32> {
    if words.len() < 5 {
        return words.to_vec();
    }
    // the instructions
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
    let op = |i: &[u32]| i[0] & 0xFFFF;

    let mut sampled = BTreeMap::new(); // sampled image type -> image type
    let mut arrays = BTreeMap::new(); // array type -> (sampled image type, length)
    let mut sampler_type = None;
    for i in &instructions {
        match op(i) {
            OP_TYPE_SAMPLED_IMAGE => { sampled.insert(i[1], i[2]); }
            OP_TYPE_SAMPLER => { sampler_type = Some(i[1]); }
            _ => {}
        }
    }
    if sampled.is_empty() {
        return words.to_vec();
    }
    for i in &instructions {
        match op(i) {
            OP_TYPE_ARRAY if sampled.contains_key(&i[2]) => { arrays.insert(i[1], (i[2], Some(i[3]))); }
            OP_TYPE_RUNTIME_ARRAY if sampled.contains_key(&i[2]) => { arrays.insert(i[1], (i[2], None)); }
            _ => {}
        }
    }
    let mut pointers = BTreeMap::new(); // pointer type -> pointee
    for i in &instructions {
        if op(i) == OP_TYPE_POINTER && i[2] == UNIFORM_CONSTANT {
            if let Some(&image) = sampled.get(&i[3]) {
                pointers.insert(i[1], Pointee::One { image });
            } else if let Some(&(s, length)) = arrays.get(&i[3]) {
                pointers.insert(i[1], Pointee::Array { image: sampled[&s], length });
            }
        }
    }
    // the variables
    let mut variables = BTreeMap::new(); // combined variable -> pointee
    for i in &instructions {
        if op(i) == OP_VARIABLE && i[3] == UNIFORM_CONSTANT {
            if let Some(&p) = pointers.get(&i[1]) {
                variables.insert(i[2], p);
            }
        }
    }
    if variables.is_empty() {
        return words.to_vec();
    }

    let mut bound = words[3];
    let mut fresh = || { let id = bound; bound += 1; id };
    let mut types: Vec<Vec<u32>> = Vec::new();
    let sampler = match sampler_type {
        Some(id) => id,
        None => {
            let id = fresh();
            types.push(instruction(OP_TYPE_SAMPLER, &[id]));
            id
        }
    };
    let pointer_to_sampler = fresh();
    types.push(instruction(OP_TYPE_POINTER, &[pointer_to_sampler, UNIFORM_CONSTANT, sampler]));
    // per image type: a pointer to it; per array: arrays of images and samplers, pointers to them
    let mut pointer_to_image = BTreeMap::new();
    let mut array_types = BTreeMap::new(); // (image, length) -> (pointer to image array, pointer to sampler array)
    let mut new_variables = BTreeMap::new(); // combined variable -> (new type, sampler variable, sampler variable's type)
    for (&variable, &pointee) in &variables {
        let (image, length) = match pointee {
            Pointee::One { image } => (image, None),
            Pointee::Array { image, length } => (image, Some(length)),
        };
        let image_pointer = *pointer_to_image.entry(image).or_insert_with(|| {
            let id = fresh();
            types.push(instruction(OP_TYPE_POINTER, &[id, UNIFORM_CONSTANT, image]));
            id
        });
        match length {
            None => { new_variables.insert(variable, (image_pointer, fresh(), pointer_to_sampler)); }
            Some(length) => {
                let key = (image, length.unwrap_or(0));
                let (image_array_pointer, sampler_array_pointer) = *array_types.entry(key).or_insert_with(|| {
                    let (image_array, sampler_array) = (fresh(), fresh());
                    match length {
                        Some(n) => {
                            types.push(instruction(OP_TYPE_ARRAY, &[image_array, image, n]));
                            types.push(instruction(OP_TYPE_ARRAY, &[sampler_array, sampler, n]));
                        }
                        None => {
                            types.push(instruction(OP_TYPE_RUNTIME_ARRAY, &[image_array, image]));
                            types.push(instruction(OP_TYPE_RUNTIME_ARRAY, &[sampler_array, sampler]));
                        }
                    }
                    let (a, b) = (fresh(), fresh());
                    types.push(instruction(OP_TYPE_POINTER, &[a, UNIFORM_CONSTANT, image_array]));
                    types.push(instruction(OP_TYPE_POINTER, &[b, UNIFORM_CONSTANT, sampler_array]));
                    (a, b)
                });
                new_variables.insert(variable, (image_array_pointer, fresh(), sampler_array_pointer));
            }
        }
    }
    // decorations of the samplers: the variable's set, its binding + SAMPLER_BINDING
    let mut decorations: Vec<Vec<u32>> = Vec::new();
    for i in &instructions {
        if op(i) == OP_DECORATE && i.len() >= 4 {
            if let Some(&(_, sampler_variable, _)) = new_variables.get(&i[1]) {
                match i[2] {
                    DECORATION_DESCRIPTOR_SET => decorations.push(instruction(OP_DECORATE, &[sampler_variable, DECORATION_DESCRIPTOR_SET, i[3]])),
                    DECORATION_BINDING => decorations.push(instruction(OP_DECORATE, &[sampler_variable, DECORATION_BINDING, SAMPLER_BINDING + i[3]])),
                    _ => {}
                }
            }
        }
    }

    // the rewrite
    let mut out: Vec<u32> = words[..5].to_vec();
    let mut decorated = false;
    let mut typed = false;
    // access chains into combined arrays: chain -> its sampler twin
    let mut chains: BTreeMap<u32, u32> = BTreeMap::new();
    for i in &instructions {
        let o = op(i);
        // (the new decorations after the annotations, before the first
        // type, constant, variable or function; the new types, then the
        // variables of the images and samplers, after every other global:
        // after everything they name, whatever the order of the types)
        if !decorated && ((19..=52).contains(&o) || o == OP_VARIABLE || o == OP_FUNCTION || o == 1) {
            for d in &decorations { out.extend_from_slice(d); }
            decorated = true;
        }
        if !typed && o == OP_FUNCTION {
            for t in &types { out.extend_from_slice(t); }
            for (&variable, &(image_type, sampler_variable, sampler_type)) in &new_variables {
                out.extend(instruction(OP_VARIABLE, &[image_type, variable, UNIFORM_CONSTANT]));
                out.extend(instruction(OP_VARIABLE, &[sampler_type, sampler_variable, UNIFORM_CONSTANT]));
            }
            typed = true;
        }
        match o {
            OP_ENTRY_POINT => {
                // the interface: the samplers too
                let mut operands = i[1..].to_vec();
                // (execution model, function, name words..., interface ids: the name ends with a zero byte)
                let mut j = 3;
                while j < operands.len() && operands[j] & 0xFF00_0000 != 0 { j += 1; }
                j += 1;
                let interface: Vec<u32> = operands.get(j..).map(|s| s.to_vec()).unwrap_or_default();
                for id in interface {
                    if let Some(&(_, sampler_variable, _)) = new_variables.get(&id) { operands.push(sampler_variable); }
                }
                out.extend(instruction(OP_ENTRY_POINT, &operands));
            }
            // (made again before the first function)
            OP_VARIABLE if new_variables.contains_key(&i[2]) => {}
            OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN if new_variables.contains_key(&i[3]) => {
                let (_, sampler_variable, _) = new_variables[&i[3]];
                let image = match variables[&i[3]] { Pointee::Array { image, .. } | Pointee::One { image } => image };
                let twin = fresh();
                let mut operands = i[1..].to_vec();
                operands[0] = pointer_to_image[&image];
                out.extend(instruction(o, &operands));
                operands[0] = pointer_to_sampler;
                operands[1] = twin;
                operands[2] = sampler_variable;
                out.extend(instruction(o, &operands));
                chains.insert(i[2], twin);
            }
            OP_LOAD if sampled.contains_key(&i[1]) && (new_variables.contains_key(&i[3]) || chains.contains_key(&i[3])) => {
                let image = sampled[&i[1]];
                let sampler_pointer = match new_variables.get(&i[3]) { Some(&(_, v, _)) => v, None => chains[&i[3]] };
                let (loaded_image, loaded_sampler) = (fresh(), fresh());
                out.extend(instruction(OP_LOAD, &[image, loaded_image, i[3]]));
                out.extend(instruction(OP_LOAD, &[sampler, loaded_sampler, sampler_pointer]));
                out.extend(instruction(OP_SAMPLED_IMAGE, &[i[1], i[2], loaded_image, loaded_sampler]));
            }
            _ => out.extend_from_slice(i),
        }
    }
    out[3] = bound;
    out
}
