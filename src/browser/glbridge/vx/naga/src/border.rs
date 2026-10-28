//! Clamp to border (GLES 3.2, EXT_texture_border_clamp) for samples of float
//! images: WebGPU's samplers have no border, so the sampler clamps to the
//! edge and a sample whose coordinate is outside [0, 1) on an axis that
//! clamps to the border takes the border color instead. That is GL's
//! answer with the nearest filter; with the linear one the texels at the
//! edge do not blend with the border (a deviation). The border colors are
//! the draw's, constants of the translation, as the caller gives them in
//! the wraps list (intsample.rs's): an image's address modes
//! (VkSamplerAddressMode, 3 clamp to border, a nibble an axis), and each
//! color component's bits by `BORDER_COLOR | component << 24 | key`.
//! Depth comparisons, projective samples, gathers and cube images are left
//! as they were.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

/// The flag of a border color component's entry in the wraps list
pub const BORDER_COLOR: u32 = 0x8000_0000;
const CLAMP_TO_BORDER: u32 = 3;

const OP_TYPE_BOOL: u32 = 20;
const OP_TYPE_FLOAT: u32 = 22;
const OP_TYPE_VECTOR: u32 = 23;
const OP_TYPE_IMAGE: u32 = 25;
const OP_TYPE_SAMPLED_IMAGE: u32 = 27;
const OP_CONSTANT: u32 = 43;
const OP_CONSTANT_COMPOSITE: u32 = 44;
const OP_FUNCTION: u32 = 54;
const OP_LOAD: u32 = 61;
const OP_DECORATE: u32 = 71;
const OP_COMPOSITE_CONSTRUCT: u32 = 80;
const OP_COMPOSITE_EXTRACT: u32 = 81;
const OP_SAMPLED_IMAGE: u32 = 86;
const OP_IMAGE_SAMPLE_IMPLICIT_LOD: u32 = 87;
const OP_IMAGE_SAMPLE_EXPLICIT_LOD: u32 = 88;
const OP_LOGICAL_OR: u32 = 166;
const OP_SELECT: u32 = 169;
const OP_F_ORD_LESS_THAN: u32 = 184;
const OP_F_ORD_GREATER_THAN_EQUAL: u32 = 190;
const DECORATION_BINDING: u32 = 33;
const DECORATION_DESCRIPTOR_SET: u32 = 34;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The opcodes in a function that have no result type (intsample.rs's)
fn untyped(op: u32) -> bool { matches!(op, 8 | 56 | 62 | 63 | 99 | 224 | 225 | 246..=255 | 317) }

/// The module with its samples of images whose samplers clamp to the border
/// choosing the border color outside the image, or the words as they were
pub fn lower(words: &[u32], wraps: &[(u32, u32)]) -> Vec<u32> {
    // the images that clamp to the border: their axes and colors
    let mut borders: BTreeMap<u32, (u32, [u32; 4])> = BTreeMap::new();
    for &(key, modes) in wraps {
        if key & BORDER_COLOR != 0 {
            continue;
        }
        let axes = (0..3).filter(|k| modes >> (4 * k) & 0xF == CLAMP_TO_BORDER).fold(0, |m, k| m | 1 << k);
        if axes != 0 {
            let mut color = [0u32; 4];
            for (c, bits) in color.iter_mut().enumerate() {
                *bits = wraps.iter().find(|(x, _)| *x == BORDER_COLOR | (c as u32) << 24 | key).map_or(0, |(_, v)| *v);
            }
            borders.insert(key, (axes, color));
        }
    }
    if borders.is_empty() || words.len() < 5 {
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
    let defs: BTreeMap<u32, &[u32]> = instructions[first_function..].iter().filter(|w| w.len() >= 3 && !untyped(op(w))).map(|w| (w[2], *w)).collect();
    let decoration = |id: u32, d: u32| instructions[..first_function].iter().find(|w| op(w) == OP_DECORATE && w.len() >= 4 && w[1] == id && w[2] == d).map(|w| w[3]);
    // a sampled image's image key (an OpSampledImage of an OpLoad of a variable, intsample.rs's) and its image type
    let image_of = |si: u32| -> Option<(u32, &[u32])> {
        let s = defs.get(&si)?;
        if op(s) != OP_SAMPLED_IMAGE || s.len() < 5 {
            return None;
        }
        let load = defs.get(&s[3])?;
        if op(load) != OP_LOAD || load.len() < 4 {
            return None;
        }
        let key = decoration(load[3], DECORATION_DESCRIPTOR_SET)? << 16 | crate::wgsl_binding(decoration(load[3], DECORATION_BINDING)?);
        let sampled = types.get(&s[1])?;
        let image = if op(sampled) == OP_TYPE_SAMPLED_IMAGE { types.get(&sampled[2])? } else { return None };
        if op(image) != OP_TYPE_IMAGE || image.len() < 9 {
            return None;
        }
        Some((key, *image))
    };
    let float_vec4 = |ty: u32| types.get(&ty).is_some_and(|t| op(t) == OP_TYPE_VECTOR && t[3] == 4 && types.get(&t[2]).is_some_and(|f| op(f) == OP_TYPE_FLOAT));

    let mut bound = words[3];
    let mut fresh = || { bound += 1; bound - 1 };
    let mut declarations: Vec<Vec<u32>> = Vec::new();
    let mut boolean = types.iter().find(|(_, t)| op(t) == OP_TYPE_BOOL).map(|(&id, _)| id);
    let mut bvec4 = None;
    let mut constants: BTreeMap<(u32, u32), u32> = instructions[..first_function].iter().filter(|w| op(w) == OP_CONSTANT && w.len() == 4)
        .map(|w| ((w[1], w[3]), w[2])).collect();
    let mut colors: BTreeMap<u32, u32> = BTreeMap::new();
    let mut body: Vec<Vec<u32>> = Vec::new();
    let mut changed = false;
    for (i, w) in instructions.iter().enumerate() {
        let sample = i >= first_function && matches!(op(w), OP_IMAGE_SAMPLE_IMPLICIT_LOD | OP_IMAGE_SAMPLE_EXPLICIT_LOD) && w.len() >= 5;
        let found = if sample && float_vec4(w[1]) { image_of(w[3]).and_then(|(key, image)| borders.get(&key).map(|b| (key, *b, image))) } else { None };
        // (1D, 2D or 3D, arrayed or not; not a cube's; its float component type)
        let Some((key, (axes, color), image)) = found.filter(|(_, _, image)| image[3] <= 2 && image[4] != 1 && types.get(&image[2]).is_some_and(|t| op(t) == OP_TYPE_FLOAT)) else {
            body.push(w.to_vec());
            continue;
        };
        changed = true;
        let float = image[2];
        let spatial = image[3] + 1;
        let vec4 = w[1];
        let b = *boolean.get_or_insert_with(|| { let id = fresh(); declarations.push(instruction(OP_TYPE_BOOL, &[id])); id });
        let bv = *bvec4.get_or_insert_with(|| {
            types.iter().find(|(_, t)| op(t) == OP_TYPE_VECTOR && t[2] == b && t[3] == 4).map(|(&id, _)| id)
                .unwrap_or_else(|| { let id = fresh(); declarations.push(instruction(OP_TYPE_VECTOR, &[id, b, 4])); id })
        });
        let mut constant = |bits: u32, declarations: &mut Vec<Vec<u32>>, fresh: &mut dyn FnMut() -> u32| *constants.entry((float, bits)).or_insert_with(|| {
            let id = fresh();
            declarations.push(instruction(OP_CONSTANT, &[float, id, bits]));
            id
        });
        let zero = constant(0, &mut declarations, &mut fresh);
        let one = constant(0x3F80_0000, &mut declarations, &mut fresh);
        let border = match colors.get(&key) {
            Some(&id) => id,
            None => {
                let parts: Vec<u32> = color.iter().map(|&bits| constant(bits, &mut declarations, &mut fresh)).collect();
                let id = fresh();
                declarations.push(instruction(OP_CONSTANT_COMPOSITE, &[vec4, id, parts[0], parts[1], parts[2], parts[3]]));
                colors.insert(key, id);
                id
            },
        };
        // the sample's own result renamed; the original result the choice
        let result = w[2];
        let sampled = fresh();
        let mut renamed = w.to_vec();
        renamed[2] = sampled;
        body.push(renamed);
        let coordinate = w[4];
        let coordinate_is_vector = defs.get(&coordinate).and_then(|d| types.get(&d[1])).is_some_and(|t| op(t) == OP_TYPE_VECTOR)
            || image[3] > 0 || image[5] != 0;
        let mut outside = None;
        for k in 0..spatial {
            if axes >> k & 1 == 0 {
                continue;
            }
            let x = if coordinate_is_vector {
                let id = fresh();
                body.push(instruction(OP_COMPOSITE_EXTRACT, &[float, id, coordinate, k]));
                id
            } else { coordinate };
            let (below, above, either) = (fresh(), fresh(), fresh());
            body.push(instruction(OP_F_ORD_LESS_THAN, &[b, below, x, zero]));
            body.push(instruction(OP_F_ORD_GREATER_THAN_EQUAL, &[b, above, x, one]));
            body.push(instruction(OP_LOGICAL_OR, &[b, either, below, above]));
            outside = Some(match outside {
                None => either,
                Some(previous) => {
                    let id = fresh();
                    body.push(instruction(OP_LOGICAL_OR, &[b, id, previous, either]));
                    id
                },
            });
        }
        let Some(outside) = outside else {
            body.last_mut().unwrap()[2] = result;
            continue;
        };
        let condition = fresh();
        body.push(instruction(OP_COMPOSITE_CONSTRUCT, &[bv, condition, outside, outside, outside, outside]));
        body.push(instruction(OP_SELECT, &[vec4, result, condition, border, sampled]));
    }
    if !changed {
        return words.to_vec();
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
