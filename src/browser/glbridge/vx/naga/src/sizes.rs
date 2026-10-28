//! GLSL's textureSize(sampler, lod) of a level past the base: the page's
//! view of a texture whose filter takes no mipmaps holds its base level
//! alone (so that WebGPU picks the minification filter as GL does, by the
//! unclamped λ), where WGSL's textureDimensions of a level past it has
//! nothing to answer. GL's level sizes follow from the base's, each axis
//! halved a level and at least 1, so the query becomes the base level's
//! (level 0 of the view) shifted right by the lod on its spatial axes
//! (an array's layer count as it is). A query of level 0 (a constant) is
//! left as it is.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

const OP_EXT_INST_IMPORT: u32 = 11;
const OP_EXT_INST: u32 = 12;
const OP_TYPE_INT: u32 = 21;
const OP_TYPE_VECTOR: u32 = 23;
const OP_TYPE_IMAGE: u32 = 25;
const OP_TYPE_SAMPLED_IMAGE: u32 = 27;
const OP_CONSTANT: u32 = 43;
const OP_FUNCTION: u32 = 54;
const OP_COMPOSITE_CONSTRUCT: u32 = 80;
const OP_COMPOSITE_EXTRACT: u32 = 81;
const OP_IMAGE_QUERY_SIZE_LOD: u32 = 103;
const OP_SHIFT_RIGHT_ARITHMETIC: u32 = 195;
const GLSL_S_MAX: u32 = 42;
const DIM_1D: u32 = 0;
const DIM_3D: u32 = 2;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The opcodes in a function that have no result type (intsample.rs's)
fn untyped(op: u32) -> bool { matches!(op, 8 | 56 | 62 | 63 | 99 | 224 | 225 | 246..=255 | 317) }

/// "GLSL.std.450" as an OpExtInstImport's name words
fn glsl_name() -> Vec<u32> {
    let mut bytes = b"GLSL.std.450".to_vec();
    bytes.resize((bytes.len() / 4 + 1) * 4, 0);
    bytes.chunks(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// The module with its size queries of levels past the base made the base's shifted, or the words as they were
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
    let types: BTreeMap<u32, &[u32]> = instructions[..first_function].iter().filter(|w| (19..=39).contains(&op(w)) && w.len() >= 2).map(|w| (w[1], *w)).collect();
    let constants: BTreeMap<u32, (u32, u32)> = instructions[..first_function].iter().filter(|w| op(w) == OP_CONSTANT && w.len() == 4).map(|w| (w[2], (w[1], w[3]))).collect();
    let defs: BTreeMap<u32, &[u32]> = instructions[first_function..].iter().filter(|w| w.len() >= 3 && !untyped(op(w))).map(|w| (w[2], *w)).collect();
    // an image operand's image type: its definition's result type (an image, or a sampled image's image)
    let image_type = |image: u32| -> Option<&[u32]> {
        let ty = types.get(&defs.get(&image)?[1])?;
        let ty = if op(ty) == OP_TYPE_SAMPLED_IMAGE { types.get(&ty[2])? } else { ty };
        (op(ty) == OP_TYPE_IMAGE && ty.len() >= 9).then_some(*ty)
    };
    let queries: Vec<usize> = instructions.iter().enumerate().skip(first_function)
        .filter(|(_, w)| op(w) == OP_IMAGE_QUERY_SIZE_LOD && w.len() == 5 && constants.get(&w[4]).map_or(true, |&(_, v)| v != 0) && image_type(w[3]).is_some())
        .map(|(i, _)| i).collect();
    if queries.is_empty() {
        return words.to_vec();
    }
    let mut bound = words[3];
    let mut fresh = || { bound += 1; bound - 1 };
    let mut declarations: Vec<Vec<u32>> = Vec::new();
    let mut header: Vec<Vec<u32>> = Vec::new();
    let glsl = match instructions.iter().find(|w| op(w) == OP_EXT_INST_IMPORT && w[2..] == glsl_name()[..]) {
        Some(w) => w[1],
        None => {
            let id = fresh();
            let mut operands = Vec::from([id]);
            operands.extend(glsl_name());
            header.push(instruction(OP_EXT_INST_IMPORT, &operands));
            id
        },
    };
    let mut body: Vec<Vec<u32>> = Vec::new();
    let mut zeros: BTreeMap<u32, u32> = BTreeMap::new();
    let mut ones: BTreeMap<u32, u32> = BTreeMap::new();
    for (i, w) in instructions.iter().enumerate() {
        if !queries.contains(&i) {
            body.push(w.to_vec());
            continue;
        }
        let (result_type, result, image, lod) = (w[1], w[2], w[3], w[4]);
        let image_ty = image_type(image).unwrap();
        let (dim, arrayed) = (image_ty[3], image_ty[5] != 0);
        let spatial = if dim == DIM_1D { 1 } else if dim == DIM_3D { 3 } else { 2 };
        // the component type: the result's (an int, or a vector of them)
        let (int, count) = match types.get(&result_type) {
            Some(t) if op(t) == OP_TYPE_VECTOR => (t[2], t[3]),
            Some(t) if op(t) == OP_TYPE_INT => (result_type, 1),
            _ => { body.push(w.to_vec()); continue; },
        };
        let constant = |map: &mut BTreeMap<u32, u32>, value: u32, declarations: &mut Vec<Vec<u32>>, fresh: &mut dyn FnMut() -> u32| *map.entry(int).or_insert_with(|| {
            let id = constants.iter().find(|(_, &(t, v))| t == int && v == value).map(|(&id, _)| id).unwrap_or_else(|| {
                let id = fresh();
                declarations.push(instruction(OP_CONSTANT, &[int, id, value]));
                id
            });
            id
        });
        let zero = constant(&mut zeros, 0, &mut declarations, &mut fresh);
        let one = constant(&mut ones, 1, &mut declarations, &mut fresh);
        let base = fresh();
        body.push(instruction(OP_IMAGE_QUERY_SIZE_LOD, &[result_type, base, image, zero]));
        let shift = |body: &mut Vec<Vec<u32>>, fresh: &mut dyn FnMut() -> u32, x: u32| {
            let (shifted, at_least) = (fresh(), fresh());
            body.push(instruction(OP_SHIFT_RIGHT_ARITHMETIC, &[int, shifted, x, lod]));
            body.push(instruction(OP_EXT_INST, &[int, at_least, glsl, GLSL_S_MAX, shifted, one]));
            at_least
        };
        if count == 1 {
            // (a scalar's: the shifted value under the query's own id)
            let shifted = fresh();
            body.push(instruction(OP_SHIFT_RIGHT_ARITHMETIC, &[int, shifted, base, lod]));
            body.push(instruction(OP_EXT_INST, &[int, result, glsl, GLSL_S_MAX, shifted, one]));
            continue;
        }
        let mut parts = Vec::new();
        for k in 0..count {
            let part = fresh();
            body.push(instruction(OP_COMPOSITE_EXTRACT, &[int, part, base, k]));
            // (the layer count of an array: as it is)
            parts.push(if k < spatial && !(arrayed && k == count - 1) { shift(&mut body, &mut fresh, part) } else { part });
        }
        let mut operands = Vec::from([result_type, result]);
        operands.extend(parts);
        body.push(instruction(OP_COMPOSITE_CONSTRUCT, &operands));
    }
    // (the import with the others, the constants before the first function)
    let first_import = body.iter().position(|w| op(w) == OP_EXT_INST_IMPORT || op(w) == 14).unwrap_or(0);
    let mut out = words[..5].to_vec();
    out[3] = bound;
    for (i, w) in body.iter().enumerate() {
        if i == first_import {
            for h in &header {
                out.extend_from_slice(h);
            }
        }
        if i == first_function {
            for d in &declarations {
                out.extend_from_slice(d);
            }
        }
        out.extend_from_slice(w);
    }
    out
}
