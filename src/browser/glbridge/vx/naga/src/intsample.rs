//! Samples of integer images (GLSL's `texture` of a usampler2D or isampler3D)
//! as fetches: WGSL samples only float textures. The texel is the one the
//! nearest filter takes, `floor(coordinate * size)` (plus a constant
//! offset), clamped to the image: the sampler's wrap mode is the
//! sampler's, which the shader cannot read, so it is always clamp to edge.
//! An array's layer is the coordinate rounded, clamped; a projective
//! sample's coordinate is divided first; the level is an explicit lod's,
//! else 0. Cube images are left as they were.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

const OP_EXT_INST_IMPORT: u32 = 11;
const OP_MEMORY_MODEL: u32 = 14;
const OP_EXT_INST: u32 = 12;
const OP_TYPE_INT: u32 = 21;
const OP_TYPE_FLOAT: u32 = 22;
const OP_TYPE_VECTOR: u32 = 23;
const OP_TYPE_IMAGE: u32 = 25;
const OP_TYPE_SAMPLED_IMAGE: u32 = 27;
const OP_CONSTANT: u32 = 43;
const OP_CONSTANT_COMPOSITE: u32 = 44;
const OP_FUNCTION: u32 = 54;
const OP_VECTOR_SHUFFLE: u32 = 79;
const OP_COMPOSITE_EXTRACT: u32 = 81;
const OP_COMPOSITE_CONSTRUCT: u32 = 80;
const OP_IMAGE_SAMPLE_IMPLICIT_LOD: u32 = 87;
const OP_IMAGE_SAMPLE_EXPLICIT_LOD: u32 = 88;
const OP_IMAGE_SAMPLE_PROJ_IMPLICIT_LOD: u32 = 91;
const OP_IMAGE_SAMPLE_PROJ_EXPLICIT_LOD: u32 = 92;
const OP_IMAGE_FETCH: u32 = 95;
const OP_IMAGE: u32 = 100;
const OP_IMAGE_QUERY_SIZE_LOD: u32 = 103;
const OP_CONVERT_F_TO_S: u32 = 110;
const OP_CONVERT_S_TO_F: u32 = 111;
const OP_I_ADD: u32 = 128;
const OP_F_ADD: u32 = 129;
const OP_I_SUB: u32 = 130;
const OP_F_MUL: u32 = 133;
const OP_F_DIV: u32 = 136;
const GLSL_FLOOR: u32 = 8;
const GLSL_CEIL: u32 = 9;
const GLSL_LOG2: u32 = 30;
const OP_F_SUB: u32 = 131;
const GLSL_F_MAX: u32 = 40;
const GLSL_F_CLAMP: u32 = 43;
const GLSL_LENGTH: u32 = 66;
const OP_IMAGE_QUERY_LEVELS: u32 = 106;
const OP_DPDX: u32 = 207;
const OP_I_MUL: u32 = 132;
const OP_S_REM: u32 = 138;
const OP_S_LESS_THAN: u32 = 177;
const OP_SELECT: u32 = 169;
const OP_TYPE_BOOL: u32 = 20;
const OP_DPDY: u32 = 208;
const GLSL_S_CLAMP: u32 = 45;
const IMAGE_OPERANDS_BIAS: u32 = 1;
const IMAGE_OPERANDS_LOD: u32 = 2;
const IMAGE_OPERANDS_GRAD: u32 = 4;
const IMAGE_OPERANDS_CONST_OFFSET: u32 = 8;
const IMAGE_OPERANDS_OFFSET: u32 = 0x10;

fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The opcodes in a function that have no result type
fn untyped(op: u32) -> bool { matches!(op, 8 | 56 | 62 | 63 | 99 | 224 | 225 | 246..=255 | 317) }

struct Pass {
    bound: u32,
    types: BTreeMap<u32, Vec<u32>>,
    vectors: BTreeMap<(u32, u32), u32>,
    constants: BTreeMap<(u32, u32), u32>,
    composites: BTreeMap<(u32, Vec<u32>), u32>,
    int: Option<u32>,
    declarations: Vec<Vec<u32>>,
}

impl Pass {
    fn fresh(&mut self) -> u32 {
        self.bound += 1;
        self.bound - 1
    }
    fn declare(&mut self, w: Vec<u32>) { self.declarations.push(w); }
    fn int(&mut self) -> u32 {
        if let Some(id) = self.int {
            return id;
        }
        let id = self.fresh();
        self.declare(instruction(OP_TYPE_INT, &[id, 32, 1]));
        self.int = Some(id);
        id
    }
    /// the bool type, existing or new
    fn boolean(&mut self) -> u32 {
        if let Some((&id, _)) = self.types.iter().find(|(_, w)| w[0] & 0xFFFF == OP_TYPE_BOOL) {
            return id;
        }
        let id = self.fresh();
        let w = instruction(OP_TYPE_BOOL, &[id]);
        self.types.insert(id, w.clone());
        self.declare(w);
        id
    }

    fn vector(&mut self, component: u32, n: u32) -> u32 {
        if n == 1 {
            return component;
        }
        if let Some(&id) = self.vectors.get(&(component, n)) {
            return id;
        }
        let id = self.fresh();
        self.declare(instruction(OP_TYPE_VECTOR, &[id, component, n]));
        self.vectors.insert((component, n), id);
        id
    }
    fn constant(&mut self, ty: u32, bits: u32) -> u32 {
        if let Some(&id) = self.constants.get(&(ty, bits)) {
            return id;
        }
        let id = self.fresh();
        self.declare(instruction(OP_CONSTANT, &[ty, id, bits]));
        self.constants.insert((ty, bits), id);
        id
    }
    /// A constant vector of `n` of the scalar constant
    fn splat(&mut self, scalar_ty: u32, bits: u32, n: u32) -> u32 {
        let c = self.constant(scalar_ty, bits);
        if n == 1 {
            return c;
        }
        let ty = self.vector(scalar_ty, n);
        let parts: Vec<u32> = core::iter::repeat(c).take(n as usize).collect();
        if let Some(&id) = self.composites.get(&(ty, parts.clone())) {
            return id;
        }
        let id = self.fresh();
        let mut operands = Vec::from([ty, id]);
        operands.extend(&parts);
        self.declare(instruction(OP_CONSTANT_COMPOSITE, &operands));
        self.composites.insert((ty, parts), id);
        id
    }
}

/// The module with its samples of integer images made fetches, or the words
/// as they were; `wraps`: their samplers' address modes by the images'
/// group << 16 | WGSL binding (VkSamplerAddressMode u | v << 4 | w << 8:
/// repeat 0 and mirrored repeat 1 wrap the texel, the others clamp it);
/// `fetched`: the images made fetches of, so
pub fn lower(words: &[u32], wraps: &[(u32, u32)], fetched: &mut Vec<u32>) -> Vec<u32> {
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
    let sample = |o: u32| matches!(o, OP_IMAGE_SAMPLE_IMPLICIT_LOD | OP_IMAGE_SAMPLE_EXPLICIT_LOD | OP_IMAGE_SAMPLE_PROJ_IMPLICIT_LOD | OP_IMAGE_SAMPLE_PROJ_EXPLICIT_LOD);
    if !instructions.iter().any(|w| sample(op(w))) {
        return words.to_vec();
    }
    let mut pass = Pass { bound: words[3], types: BTreeMap::new(), vectors: BTreeMap::new(), constants: BTreeMap::new(), composites: BTreeMap::new(),
        int: None, declarations: Vec::new() };
    let mut type_of: BTreeMap<u32, u32> = BTreeMap::new();
    let mut glsl = None;
    let first_function = instructions.iter().position(|w| op(w) == OP_FUNCTION).unwrap_or(instructions.len());
    for (i, w) in instructions.iter().enumerate() {
        let o = op(w);
        match o {
            19..=39 if w.len() >= 2 => {
                pass.types.insert(w[1], w.to_vec());
                if o == OP_TYPE_VECTOR && w.len() >= 4 {
                    pass.vectors.entry((w[2], w[3])).or_insert(w[1]);
                }
                if o == OP_TYPE_INT && w.len() >= 4 && w[2] == 32 && w[3] == 1 {
                    pass.int = Some(w[1]);
                }
            },
            OP_CONSTANT if w.len() == 4 => {
                pass.constants.entry((w[1], w[3])).or_insert(w[2]);
            },
            OP_EXT_INST_IMPORT if w.len() >= 3 => {
                let name: Vec<u8> = w[2..].iter().flat_map(|x| x.to_le_bytes()).take_while(|&b| b != 0).collect();
                if name == b"GLSL.std.450" {
                    glsl = Some(w[1]);
                }
            },
            _ => {},
        }
        if (i >= first_function && !untyped(o) && o != 248 || i < first_function && (41..=52).contains(&o)) && w.len() >= 3 {
            type_of.insert(w[2], w[1]);
        }
    }
    // (GLSL.std.450, for floor and clamp: imported when the shader does not)
    let imported = glsl.is_none();
    let glsl = match glsl {
        Some(id) => id,
        None => {
            pass.bound += 1;
            pass.bound - 1
        },
    };
    // what defines each id in the functions, and the variables' set and binding
    // (a sampled image's image: OpSampledImage of an OpLoad of a variable)
    let defs: BTreeMap<u32, &[u32]> = instructions[first_function..].iter().filter(|w| w.len() >= 3 && !untyped(op(w))).map(|w| (w[2], *w)).collect();
    let decoration = |id: u32, d: u32| instructions[..first_function].iter().find(|w| op(w) == 71 && w.len() >= 4 && w[1] == id && w[2] == d).map(|w| w[3]);
    let image_key = |si: u32| -> Option<u32> {
        let s = defs.get(&si)?;
        if op(s) != 86 || s.len() < 5 {
            return None;
        }
        let load = defs.get(&s[3])?;
        if op(load) != 61 || load.len() < 4 {
            return None;
        }
        let (set, binding) = (decoration(load[3], 34)?, decoration(load[3], 33)?);
        Some(set << 16 | crate::wgsl_binding(binding))
    };
    // the image type of a sampled image's type, when its texels are integers and it is not a cube
    let integer_image = |pass: &Pass, sampled_image_ty: u32| -> Option<(u32, u32, bool)> {
        let si = pass.types.get(&sampled_image_ty)?;
        if op(si) != OP_TYPE_SAMPLED_IMAGE {
            return None;
        }
        let image = pass.types.get(&si[2])?;
        if op(image) != OP_TYPE_IMAGE || op(pass.types.get(&image[2])?) != OP_TYPE_INT {
            return None;
        }
        // (dim: 1 2D, 2 3D; arrayed)
        let (dim, arrayed, ms) = (image[3], image[5], image[6]);
        if ms != 0 || !matches!(dim, 1 | 2) {
            return None;
        }
        Some((si[2], dim, arrayed != 0))
    };
    let mut body: Vec<Vec<u32>> = Vec::new();
    let mut changed = false;
    for w in &instructions[first_function..] {
        let o = op(w);
        let sampled = if sample(o) && w.len() >= 5 { type_of.get(&w[3]).and_then(|&t| integer_image(&pass, t)) } else { None };
        let Some((image_ty, dim, arrayed)) = sampled else {
            body.push(w.to_vec());
            continue;
        };
        let (rt, result, si, coord) = (w[1], w[2], w[3], w[4]);
        let Some(&coord_ty) = type_of.get(&coord) else {
            body.push(w.to_vec());
            continue;
        };
        let float = match pass.types.get(&coord_ty).map(|t| (op(t), t.clone())) {
            Some((OP_TYPE_VECTOR, t)) => t[2],
            _ => {
                body.push(w.to_vec());
                continue;
            },
        };
        if pass.types.get(&float).map(|t| op(t)) != Some(OP_TYPE_FLOAT) {
            body.push(w.to_vec());
            continue;
        }
        changed = true;
        let int = pass.int();
        let spatial = if dim == 2 { 3 } else { 2 };
        let size_n = spatial + arrayed as u32;
        // the image operands: an explicit lod, a constant offset
        let mask = *w.get(5).unwrap_or(&0);
        let mut arg = 6;
        let mut lod_f = None;
        let mut bias = None;
        let mut grad = None;
        let mut offset = None;
        for (bit, args) in [(IMAGE_OPERANDS_BIAS, 1), (IMAGE_OPERANDS_LOD, 1), (IMAGE_OPERANDS_GRAD, 2), (IMAGE_OPERANDS_CONST_OFFSET, 1), (IMAGE_OPERANDS_OFFSET, 1)] {
            if mask & bit != 0 {
                if bit == IMAGE_OPERANDS_LOD {
                    lod_f = w.get(arg).copied();
                }
                if bit == IMAGE_OPERANDS_BIAS {
                    bias = w.get(arg).copied();
                }
                if bit == IMAGE_OPERANDS_GRAD {
                    grad = w.get(arg).copied().zip(w.get(arg + 1).copied());
                }
                if bit == IMAGE_OPERANDS_CONST_OFFSET || bit == IMAGE_OPERANDS_OFFSET {
                    offset = w.get(arg).copied();
                }
                arg += args;
            }
        }
        let image = pass.fresh();
        body.push(instruction(OP_IMAGE, &[image_ty, image, si]));
        let size_ty = pass.vector(int, size_n);
        // the coordinate: divided by q for a projective one
        let fvec = pass.vector(float, spatial);
        let ivec = pass.vector(int, spatial);
        let mut xy = pass.fresh();
        let mut operands = Vec::from([fvec, xy, coord, coord]);
        operands.extend(0..spatial);
        body.push(instruction(OP_VECTOR_SHUFFLE, &operands));
        if matches!(o, OP_IMAGE_SAMPLE_PROJ_IMPLICIT_LOD | OP_IMAGE_SAMPLE_PROJ_EXPLICIT_LOD) {
            let q_index = pass.types.get(&coord_ty).map_or(spatial, |t| t[3] - 1);
            let (q, qs, divided) = (pass.fresh(), pass.fresh(), pass.fresh());
            body.push(instruction(OP_COMPOSITE_EXTRACT, &[float, q, coord, q_index]));
            let mut c = Vec::from([fvec, qs]);
            c.extend(core::iter::repeat(q).take(spatial as usize));
            body.push(instruction(OP_COMPOSITE_CONSTRUCT, &c));
            body.push(instruction(OP_F_DIV, &[fvec, divided, xy, qs]));
            xy = divided;
        }
        // (the spatial components of a size query)
        let spatial_of = |pass: &mut Pass, body: &mut Vec<Vec<u32>>, size: u32| if arrayed {
            let id = pass.fresh();
            let mut operands = Vec::from([ivec, id, size, size]);
            operands.extend(0..spatial);
            body.push(instruction(OP_VECTOR_SHUFFLE, &operands));
            id
        }
        else {
            size
        };
        // the level, as the nearest mip filter takes it: ceil(λ + 0.5) - 1 within
        // the levels (0 for an image of one level), λ an explicit lod, or
        // log2(ρ) of the texel coordinate's derivatives at level 0 (given, or a
        // fragment shader's own, plus the bias)
        let implicit = matches!(o, OP_IMAGE_SAMPLE_IMPLICIT_LOD | OP_IMAGE_SAMPLE_PROJ_IMPLICIT_LOD);
        let lambda = match (lod_f, grad) {
            (Some(l), _) => Some(l),
            (None, grad) if grad.is_some() || implicit => {
                let zero = pass.constant(int, 0);
                let size0 = pass.fresh();
                body.push(instruction(OP_IMAGE_QUERY_SIZE_LOD, &[size_ty, size0, image, zero]));
                let size0 = spatial_of(&mut pass, &mut body, size0);
                let fsize0 = pass.fresh();
                body.push(instruction(OP_CONVERT_S_TO_F, &[fvec, fsize0, size0]));
                let (dx, dy) = match grad {
                    Some((gx, gy)) => {
                        // (the gradients' spatial components, in texels)
                        let (sx, sy, tx, ty) = (pass.fresh(), pass.fresh(), pass.fresh(), pass.fresh());
                        let shuffle = |from: u32, to: u32, body: &mut Vec<Vec<u32>>| {
                            let mut operands = Vec::from([fvec, to, from, from]);
                            operands.extend(0..spatial);
                            body.push(instruction(OP_VECTOR_SHUFFLE, &operands));
                        };
                        let gx_ty = type_of.get(&gx).copied();
                        if gx_ty == Some(fvec) { body.push(instruction(OP_F_MUL, &[fvec, tx, gx, fsize0])); }
                        else { shuffle(gx, sx, &mut body); body.push(instruction(OP_F_MUL, &[fvec, tx, sx, fsize0])); }
                        let gy_ty = type_of.get(&gy).copied();
                        if gy_ty == Some(fvec) { body.push(instruction(OP_F_MUL, &[fvec, ty, gy, fsize0])); }
                        else { shuffle(gy, sy, &mut body); body.push(instruction(OP_F_MUL, &[fvec, ty, sy, fsize0])); }
                        (tx, ty)
                    },
                    None => {
                        let (scaled0, dx, dy) = (pass.fresh(), pass.fresh(), pass.fresh());
                        body.push(instruction(OP_F_MUL, &[fvec, scaled0, xy, fsize0]));
                        body.push(instruction(OP_DPDX, &[fvec, dx, scaled0]));
                        body.push(instruction(OP_DPDY, &[fvec, dy, scaled0]));
                        (dx, dy)
                    },
                };
                let (lx, ly, rho, lambda) = (pass.fresh(), pass.fresh(), pass.fresh(), pass.fresh());
                body.push(instruction(OP_EXT_INST, &[float, lx, glsl, GLSL_LENGTH, dx]));
                body.push(instruction(OP_EXT_INST, &[float, ly, glsl, GLSL_LENGTH, dy]));
                body.push(instruction(OP_EXT_INST, &[float, rho, glsl, GLSL_F_MAX, lx, ly]));
                body.push(instruction(OP_EXT_INST, &[float, lambda, glsl, GLSL_LOG2, rho]));
                Some(match bias {
                    Some(b) => {
                        let id = pass.fresh();
                        body.push(instruction(OP_F_ADD, &[float, id, lambda, b]));
                        id
                    },
                    None => lambda,
                })
            },
            _ => None,
        };
        let lod = match lambda {
            Some(lambda) => {
                let half = pass.constant(float, 0x3F00_0000);
                let zero_f = pass.constant(float, 0);
                let one_f = pass.constant(float, 0x3F80_0000);
                let one = pass.constant(int, 1);
                let (rounded, ceiled, below, levels, last, last_f, level, lod) = (pass.fresh(), pass.fresh(), pass.fresh(), pass.fresh(), pass.fresh(),
                    pass.fresh(), pass.fresh(), pass.fresh());
                body.push(instruction(OP_F_ADD, &[float, rounded, lambda, half]));
                body.push(instruction(OP_EXT_INST, &[float, ceiled, glsl, GLSL_CEIL, rounded]));
                body.push(instruction(OP_F_SUB, &[float, below, ceiled, one_f]));
                body.push(instruction(OP_IMAGE_QUERY_LEVELS, &[int, levels, image]));
                body.push(instruction(OP_I_SUB, &[int, last, levels, one]));
                body.push(instruction(OP_CONVERT_S_TO_F, &[float, last_f, last]));
                body.push(instruction(OP_EXT_INST, &[float, level, glsl, GLSL_F_CLAMP, below, zero_f, last_f]));
                body.push(instruction(OP_CONVERT_F_TO_S, &[int, lod, level]));
                lod
            },
            None => pass.constant(int, 0),
        };
        let size = pass.fresh();
        body.push(instruction(OP_IMAGE_QUERY_SIZE_LOD, &[size_ty, size, image, lod]));
        let size_xy = spatial_of(&mut pass, &mut body, size);
        let (fsize, scaled, floored, texel) = (pass.fresh(), pass.fresh(), pass.fresh(), pass.fresh());
        body.push(instruction(OP_CONVERT_S_TO_F, &[fvec, fsize, size_xy]));
        body.push(instruction(OP_F_MUL, &[fvec, scaled, xy, fsize]));
        body.push(instruction(OP_EXT_INST, &[fvec, floored, glsl, GLSL_FLOOR, scaled]));
        body.push(instruction(OP_CONVERT_F_TO_S, &[ivec, texel, floored]));
        let mut texel = texel;
        if let Some(offset) = offset {
            let id = pass.fresh();
            body.push(instruction(OP_I_ADD, &[ivec, id, texel, offset]));
            texel = id;
        }
        // the sampler's address modes, each axis's
        let key = image_key(w[3]);
        if let Some(k) = key {
            fetched.push(k);
        }
        let modes = key.and_then(|k| wraps.iter().find(|(x, _)| *x == k)).map_or(0x222, |&(_, m)| m);
        let mode = |k: u32| modes >> (4 * k) & 0xF;
        let (zero, one) = (pass.splat(int, 0, spatial), pass.splat(int, 1, spatial));
        let (last, clamped) = (pass.fresh(), pass.fresh());
        body.push(instruction(OP_I_SUB, &[ivec, last, size_xy, one]));
        body.push(instruction(OP_EXT_INST, &[ivec, clamped, glsl, GLSL_S_CLAMP, texel, zero, last]));
        // (repeat: the texel modulo the size; mirrored repeat: modulo twice the size, folded back)
        let clamped = if (0..spatial).all(|k| mode(k) >= 2) { clamped } else {
            let boolean = pass.boolean();
            let (one1, two1) = (pass.constant(int, 1), pass.constant(int, 2));
            let mut parts = Vec::new();
            for k in 0..spatial {
                let part = pass.fresh();
                body.push(instruction(OP_COMPOSITE_EXTRACT, &[int, part, if mode(k) >= 2 { clamped } else { texel }, k]));
                if mode(k) >= 2 {
                    parts.push(part);
                    continue;
                }
                let size_k = pass.fresh();
                body.push(instruction(OP_COMPOSITE_EXTRACT, &[int, size_k, size_xy, k]));
                // (a floored modulo, never negative, of remainders: ((a % b) + b) % b; naga refuses OpSMod of
                // integers, and negate.rs makes a shader's own OpSMod the remainder)
                let floored = |pass: &mut Pass, body: &mut Vec<Vec<u32>>, a: u32, b: u32| {
                    let (r, shifted, m) = (pass.fresh(), pass.fresh(), pass.fresh());
                    body.push(instruction(OP_S_REM, &[int, r, a, b]));
                    body.push(instruction(OP_I_ADD, &[int, shifted, r, b]));
                    body.push(instruction(OP_S_REM, &[int, m, shifted, b]));
                    m
                };
                if mode(k) == 0 {
                    let wrapped = floored(&mut pass, &mut body, part, size_k);
                    parts.push(wrapped);
                    continue;
                }
                let (twice, back, last_k, under, mirrored) = (pass.fresh(), pass.fresh(), pass.fresh(), pass.fresh(), pass.fresh());
                body.push(instruction(OP_I_MUL, &[int, twice, size_k, two1]));
                let folded = floored(&mut pass, &mut body, part, twice);
                body.push(instruction(OP_I_SUB, &[int, last_k, twice, one1]));
                body.push(instruction(OP_I_SUB, &[int, back, last_k, folded]));
                body.push(instruction(OP_S_LESS_THAN, &[boolean, under, folded, size_k]));
                body.push(instruction(OP_SELECT, &[int, mirrored, under, folded, back]));
                parts.push(mirrored);
            }
            let id = pass.fresh();
            let mut c = Vec::from([ivec, id]);
            c.extend(parts);
            body.push(instruction(OP_COMPOSITE_CONSTRUCT, &c));
            id
        };
        let fetch_at = if arrayed {
            // the layer: floor(z + 0.5), clamped
            let half = pass.constant(float, 0x3F00_0000);
            let (z, zh, zf, zi, layers, layers_last, layer, at) = (pass.fresh(), pass.fresh(), pass.fresh(), pass.fresh(), pass.fresh(), pass.fresh(),
                pass.fresh(), pass.fresh());
            body.push(instruction(OP_COMPOSITE_EXTRACT, &[float, z, coord, spatial]));
            body.push(instruction(OP_F_ADD, &[float, zh, z, half]));
            body.push(instruction(OP_EXT_INST, &[float, zf, glsl, GLSL_FLOOR, zh]));
            body.push(instruction(OP_CONVERT_F_TO_S, &[int, zi, zf]));
            body.push(instruction(OP_COMPOSITE_EXTRACT, &[int, layers, size, spatial]));
            let (zero1, one1) = (pass.constant(int, 0), pass.constant(int, 1));
            body.push(instruction(OP_I_SUB, &[int, layers_last, layers, one1]));
            body.push(instruction(OP_EXT_INST, &[int, layer, glsl, GLSL_S_CLAMP, zi, zero1, layers_last]));
            let all = pass.vector(int, spatial + 1);
            let mut c = Vec::from([all, at]);
            for k in 0..spatial {
                let x = pass.fresh();
                body.push(instruction(OP_COMPOSITE_EXTRACT, &[int, x, clamped, k]));
                c.push(x);
            }
            c.push(layer);
            body.push(instruction(OP_COMPOSITE_CONSTRUCT, &c));
            at
        }
        else {
            clamped
        };
        body.push(instruction(OP_IMAGE_FETCH, &[rt, result, image, fetch_at, IMAGE_OPERANDS_LOD, lod]));
    }
    if !changed {
        return words.to_vec();
    }
    let mut out = words[..5].to_vec();
    for w in &instructions[..first_function] {
        if imported && op(w) == OP_MEMORY_MODEL {
            let mut import = Vec::from([glsl]);
            import.extend(b"GLSL.std.450\0\0\0\0".chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])));
            out.extend_from_slice(&instruction(OP_EXT_INST_IMPORT, &import));
        }
        out.extend_from_slice(w);
    }
    for d in &pass.declarations {
        out.extend_from_slice(d);
    }
    for w in &body {
        out.extend_from_slice(w);
    }
    out[3] = pass.bound;
    out
}

/// Each image's coordinate types declared (float and signed int vectors of
/// its dimensions' size): naga's SPIR-V front end looks them up for an
/// array image's coordinates (a fetch splits off the layer) and panics when
/// the module never declared them
pub fn coordinate_types(words: &[u32]) -> Vec<u32> {
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
    let mut sizes: Vec<u32> = instructions.iter().filter(|w| op(w) == OP_TYPE_IMAGE && w.len() >= 9 && w[5] != 0)
        .filter_map(|w| match w[3] { 1 => Some(2), 2 | 3 => Some(3), _ => None }).collect();
    sizes.sort_unstable();
    sizes.dedup();
    if sizes.is_empty() {
        return words.to_vec();
    }
    let first_function = instructions.iter().position(|w| op(w) == OP_FUNCTION).unwrap_or(instructions.len());
    let find = |pred: &dyn Fn(&[u32]) -> bool| instructions[..first_function].iter().find(|w| pred(w)).map(|w| w[1]);
    let mut bound = words[3];
    let mut declarations: Vec<Vec<u32>> = Vec::new();
    let mut fresh = || {
        bound += 1;
        bound - 1
    };
    let float = find(&|w| op(w) == OP_TYPE_FLOAT && w[2] == 32).unwrap_or_else(|| {
        let id = fresh();
        declarations.push(instruction(OP_TYPE_FLOAT, &[id, 32]));
        id
    });
    let int = find(&|w| op(w) == OP_TYPE_INT && w[2] == 32 && w[3] == 1).unwrap_or_else(|| {
        let id = fresh();
        declarations.push(instruction(OP_TYPE_INT, &[id, 32, 1]));
        id
    });
    for size in sizes {
        for component in [float, int] {
            if find(&|w| op(w) == OP_TYPE_VECTOR && w[2] == component && w[3] == size).is_none() {
                let id = fresh();
                declarations.push(instruction(OP_TYPE_VECTOR, &[id, component, size]));
            }
        }
    }
    if declarations.is_empty() {
        return words.to_vec();
    }
    let mut out = words[..5].to_vec();
    for (i, w) in instructions.iter().enumerate() {
        if i == first_function {
            for d in &declarations {
                out.extend_from_slice(d);
            }
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
