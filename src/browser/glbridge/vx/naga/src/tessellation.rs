//! Tessellation (GLES 3.2, docs/gles3-plan.md L6) as compute shaders, as
//! geometry.rs does geometry shaders: WebGPU has no tessellation stages. A
//! draw of patches runs its vertex shader as a compute shader (xfb.rs,
//! every output captured), then
//! - the control shader (`Stage::Control`) a workgroup a patch, an
//!   invocation an output vertex: its inputs private variables the wrapper
//!   fills from the vertex records, its outputs workgroup variables
//!   (barrier() a workgroup barrier with workgroup memory), written after it
//!   as a record an output vertex and a record a patch whose first eight
//!   words are the tess factors as GX's tessellator (tessellator_wgsl.js)
//!   reads them for the domain the caller gives (triangles: three edges and
//!   the inside; quads: four edges, two insides; isolines: two), then GL's
//!   outer levels (8), inner (12) and the patch outputs (location l at
//!   16 + 4l);
//! - the tessellator (the caller's);
//! - the evaluation shader (`Stage::Evaluation`) once a point the
//!   tessellator made: gl_TessCoord, the patch's control points and patch
//!   values, its outputs a record a point as a vertex shader's (position
//!   at word 0, point size at 4, location l at 8 + 4l), which the caller
//!   draws by the tessellator's indices through a pass-through vertex
//!   shader.
//!
//! (The wrappers' locals are not named patch: WGSL reserves it.)
//!
//! The control shader's resources, in the caller's group: 960 its
//! parameters (VxTcParams: the patches, the vertex records' stride in
//! words, the vertices a patch, the patches an instance, the domain), 961
//! the vertex records, 962 each patch's vertices' records, 963 the control
//! point records, 964 the patch records. The evaluation shader's: 960
//! VxTeParams (the patches an instance, the domain), 961 the control point
//! records, 962 the patch records, 963 the tessellator's points, 964 its
//! indirect arguments (the points' count at word 7), 965 the vertex records.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use naga::{ScalarKind, TypeInner};

use crate::geometry::{Leaf, instruction, leaves, load_from, member_name, store, string_length, string_words};

const OP_NAME: u32 = 5;
const OP_MEMBER_NAME: u32 = 6;
const OP_ENTRY_POINT: u32 = 15;
const OP_EXECUTION_MODE: u32 = 16;
const OP_CAPABILITY: u32 = 17;
const OP_TYPE_INT: u32 = 21;
const OP_TYPE_ARRAY: u32 = 28;
const OP_TYPE_STRUCT: u32 = 30;
const OP_TYPE_POINTER: u32 = 32;
const OP_CONSTANT: u32 = 43;
const OP_FUNCTION: u32 = 54;
const OP_VARIABLE: u32 = 59;
const OP_DECORATE: u32 = 71;
const OP_MEMBER_DECORATE: u32 = 72;
const OP_CONTROL_BARRIER: u32 = 224;

const MODEL_TESS_CONTROL: u32 = 1;
const MODEL_TESS_EVALUATION: u32 = 2;
const MODEL_GL_COMPUTE: u32 = 5;
const STORAGE_INPUT: u32 = 1;
const STORAGE_OUTPUT: u32 = 3;
const STORAGE_WORKGROUP: u32 = 4;
const STORAGE_PRIVATE: u32 = 6;

const DECORATION_RELAXED_PRECISION: u32 = 0;
const DECORATION_BLOCK: u32 = 2;
const DECORATION_BUILTIN: u32 = 11;
const DECORATION_NO_PERSPECTIVE: u32 = 13;
const DECORATION_FLAT: u32 = 14;
const DECORATION_PATCH: u32 = 15;
const DECORATION_CENTROID: u32 = 16;
const DECORATION_SAMPLE: u32 = 17;
const DECORATION_LOCATION: u32 = 30;

const BUILTIN_POSITION: u32 = 0;
const BUILTIN_POINT_SIZE: u32 = 1;
const BUILTIN_PRIMITIVE_ID: u32 = 7;
const BUILTIN_INVOCATION_ID: u32 = 8;
const BUILTIN_TESS_LEVEL_OUTER: u32 = 11;
const BUILTIN_TESS_LEVEL_INNER: u32 = 12;
const BUILTIN_TESS_COORD: u32 = 13;
const BUILTIN_PATCH_VERTICES: u32 = 14;

/// The patch record's words: the tessellator's factors at 0, GL's outer levels at 8, inner at 12, location l at 16 + 4l
const OUTER_WORD: u32 = 8;
const INNER_WORD: u32 = 12;
const PATCH_LOCATIONS: u32 = 16;
/// A vertex record's: the position at 0, the point size at 4, location l at 8 + 4l
const LOCATIONS: u32 = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Control,
    Evaluation,
}

pub const CONTROL_MAIN: &str = "vx_tcmain";
pub const EVALUATION_MAIN: &str = "vx_temain";
fn vertex_name(location: u32, output: bool) -> String { format!("vx_t{}{}x", if output { "o" } else { "i" }, location) }
fn patch_name(location: u32, output: bool) -> String { format!("vx_tp{}{}x", if output { "o" } else { "i" }, location) }
fn builtin_name(builtin: u32, output: bool) -> String { format!("vx_tb{}{}x", builtin, if output { "o" } else { "i" }) }
const PER_VERTEX_IN: &str = "vx_tpvix";
const PER_VERTEX_OUT: &str = "vx_tpvox";

/// What `prepare` read of a tessellation shader
#[derive(Clone, Debug, Default)]
pub struct Tessellation {
    pub stage: Option<Stage>,
    /// the control shader's output vertices
    pub vertices: u32,
    /// the evaluation shader's: GX's domain (1 isolines, 2 triangles, 3 quads), partitioning (1 equal, 3 fractional odd, 4 fractional even)
    /// and output primitive (1 points, 2 lines, 3 D3D's clockwise triangles (GL's counterclockwise), 4 D3D's counterclockwise)
    pub domain: u32,
    pub spacing: u32,
    pub primitive: u32,
    point_mode: bool,
    clockwise: bool,
    inputs: Vec<u32>,
    outputs: Vec<u32>,
    patch_inputs: Vec<u32>,
    patch_outputs: Vec<u32>,
    builtins: Vec<(u32, bool)>,
    in_members: Vec<u32>,
    out_members: Vec<u32>,
    interpolation: BTreeMap<u32, u32>,
}

/// The tessellation shader's SPIR-V as a compute shader's (above), and what it read
pub fn prepare(words: &[u32], stage: Stage) -> Result<(Vec<u32>, Tessellation), String> {
    if words.len() < 5 {
        return Err(String::from("not SPIR-V"));
    }
    let mut instructions: Vec<&[u32]> = Vec::new();
    let mut at = 5;
    while at < words.len() {
        let count = (words[at] >> 16) as usize;
        if count == 0 || at + count > words.len() {
            return Err(String::from("SPIR-V: a malformed instruction"));
        }
        instructions.push(&words[at..at + count]);
        at += count;
    }
    let op = |w: &[u32]| w[0] & 0xFFFF;
    let model = if stage == Stage::Control { MODEL_TESS_CONTROL } else { MODEL_TESS_EVALUATION };
    let mut entry = None;
    let mut uint = None;
    let mut pointers: BTreeMap<u32, u32> = BTreeMap::new();
    let mut arrays: BTreeMap<u32, u32> = BTreeMap::new();
    let mut structs: BTreeMap<u32, usize> = BTreeMap::new();
    let mut constants: BTreeMap<(u32, u32), u32> = BTreeMap::new();
    let mut variables: Vec<(u32, u32, bool)> = Vec::new();
    let mut decorations: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
    let mut members: BTreeMap<(u32, u32), Vec<(u32, u32)>> = BTreeMap::new();
    for w in &instructions {
        match op(w) {
            OP_ENTRY_POINT if w.len() >= 3 && w[1] == model && entry.is_none() => entry = Some(w[2]),
            OP_TYPE_INT if w.len() >= 4 && w[2] == 32 && w[3] == 0 => uint = Some(w[1]),
            OP_TYPE_POINTER if w.len() >= 4 => {
                pointers.insert(w[1], w[3]);
            },
            OP_TYPE_ARRAY if w.len() >= 3 => {
                arrays.insert(w[1], w[2]);
            },
            OP_TYPE_STRUCT if w.len() >= 2 => {
                structs.insert(w[1], w.len() - 2);
            },
            OP_CONSTANT if w.len() == 4 => {
                constants.entry((w[1], w[3])).or_insert(w[2]);
            },
            OP_VARIABLE if w.len() >= 4 && (w[3] == STORAGE_INPUT || w[3] == STORAGE_OUTPUT) => variables.push((w[2], w[1], w[3] == STORAGE_OUTPUT)),
            OP_DECORATE if w.len() >= 3 => decorations.entry(w[1]).or_default().push((w[2], w.get(3).copied().unwrap_or(0))),
            OP_MEMBER_DECORATE if w.len() >= 4 => members.entry((w[1], w[2])).or_default().push((w[3], w.get(4).copied().unwrap_or(0))),
            _ => {},
        }
    }
    let entry = entry.ok_or("no tessellation entry point")?;
    let find = |list: Option<&Vec<(u32, u32)>>, d: u32| list.and_then(|l| l.iter().find(|(k, _)| *k == d).map(|(_, v)| *v));
    let has = |list: Option<&Vec<(u32, u32)>>, d: u32| list.is_some_and(|l| l.iter().any(|(k, _)| *k == d));

    let mut t = Tessellation { stage: Some(stage), spacing: 1, ..Tessellation::default() };
    let mut names: BTreeMap<u32, String> = BTreeMap::new();
    let mut io_structs: BTreeSet<u32> = BTreeSet::new();
    for &(var, pointer, output) in &variables {
        let mut ty = pointers.get(&pointer).copied().unwrap_or(0);
        while let Some(&element) = arrays.get(&ty) {
            ty = element;
        }
        if structs.contains_key(&ty) {
            io_structs.insert(ty);
        }
        let decorated = decorations.get(&var);
        let name = if let Some(builtin) = find(decorated, DECORATION_BUILTIN) {
            t.builtins.push((builtin, output));
            builtin_name(builtin, output)
        }
        else if structs.get(&ty).is_some_and(|&n| (0..n as u32).any(|m| find(members.get(&(ty, m)), DECORATION_BUILTIN).is_some())) {
            let list: Vec<u32> = (0..structs[&ty] as u32).map(|m| find(members.get(&(ty, m)), DECORATION_BUILTIN).unwrap_or(u32::MAX)).collect();
            if output {
                t.out_members = list;
                String::from(PER_VERTEX_OUT)
            }
            else {
                t.in_members = list;
                String::from(PER_VERTEX_IN)
            }
        }
        else {
            let location = find(decorated, DECORATION_LOCATION).or_else(|| find(members.get(&(ty, 0)), DECORATION_LOCATION))
                .ok_or("an input or output of no location")?;
            if has(decorated, DECORATION_PATCH) {
                if output { t.patch_outputs.push(location) } else { t.patch_inputs.push(location) }
                patch_name(location, output)
            }
            else {
                if output {
                    let mut flags = 0;
                    for (d, bit) in [(DECORATION_FLAT, 1), (DECORATION_NO_PERSPECTIVE, 2), (DECORATION_CENTROID, 4), (DECORATION_SAMPLE, 8)] {
                        if has(decorated, d) {
                            flags |= bit;
                        }
                    }
                    t.interpolation.insert(location, flags);
                    t.outputs.push(location);
                }
                else {
                    t.inputs.push(location);
                }
                vertex_name(location, output)
            }
        };
        names.insert(var, name);
    }
    let converted: BTreeMap<u32, bool> = variables.iter().map(|v| (v.0, v.2)).collect();
    // (the control shader's outputs shared by the patch's invocations: workgroup memory)
    let output_storage = if stage == Stage::Control { STORAGE_WORKGROUP } else { STORAGE_PRIVATE };

    let mut bound = words[3];
    let mut fresh = || { bound += 1; bound - 1 };
    // (a barrier's memory scope and semantics: the workgroup's, its memory acquired and released)
    let mut declarations: Vec<Vec<u32>> = Vec::new();
    let mut uint_constant = |value: u32, declarations: &mut Vec<Vec<u32>>, fresh: &mut dyn FnMut() -> u32| -> u32 {
        let ty = match uint {
            Some(ty) => ty,
            None => {
                let ty = fresh();
                declarations.push(instruction(OP_TYPE_INT, &[ty, 32, 0]));
                uint = Some(ty);
                ty
            },
        };
        *constants.entry((ty, value)).or_insert_with(|| {
            let id = fresh();
            declarations.push(instruction(OP_CONSTANT, &[ty, id, value]));
            id
        })
    };
    let barrier_scope = uint_constant(2, &mut declarations, &mut fresh);
    let barrier_semantics = uint_constant(0x108, &mut declarations, &mut fresh);
    let mut out = words[..5].to_vec();
    let first_function = instructions.iter().position(|w| op(w) == OP_FUNCTION).unwrap_or(instructions.len());
    for (i, w) in instructions.iter().enumerate() {
        if i == first_function {
            for d in &declarations {
                out.extend_from_slice(d);
            }
        }
        match op(w) {
            OP_CAPABILITY if w.len() >= 2 && matches!(w[1], 3 | 23) => continue,
            OP_ENTRY_POINT if w.len() >= 3 && w[2] == entry => {
                let n = string_length(&w[3..]);
                let mut operands = Vec::from([MODEL_GL_COMPUTE, entry]);
                operands.extend_from_slice(&w[3..3 + n]);
                out.extend(instruction(OP_ENTRY_POINT, &operands));
                out.extend(instruction(OP_EXECUTION_MODE, &[entry, 17, 1, 1, 1]));
                continue;
            },
            OP_EXECUTION_MODE if w.len() >= 3 && w[1] == entry => {
                match w[2] {
                    26 => t.vertices = w.get(3).copied().unwrap_or(0),
                    22 => t.domain = 2,
                    24 => t.domain = 3,
                    25 => t.domain = 1,
                    1 => t.spacing = 1,
                    2 => t.spacing = 4,
                    3 => t.spacing = 3,
                    4 => t.clockwise = true,
                    5 => t.clockwise = false,
                    10 => t.point_mode = true,
                    _ => out.extend_from_slice(w),
                }
                continue;
            },
            OP_NAME if w.len() >= 2 && (names.contains_key(&w[1]) || w[1] == entry) => {
                let name = if w[1] == entry {
                    String::from(if stage == Stage::Control { CONTROL_MAIN } else { EVALUATION_MAIN })
                } else { names[&w[1]].clone() };
                let mut operands = Vec::from([w[1]]);
                operands.extend(string_words(&name));
                out.extend(instruction(OP_NAME, &operands));
                continue;
            },
            OP_MEMBER_NAME if w.len() >= 3 && io_structs.contains(&w[1]) => {
                let mut operands = Vec::from([w[1], w[2]]);
                operands.extend(string_words(&member_name(w[2] as usize)));
                out.extend(instruction(OP_MEMBER_NAME, &operands));
                continue;
            },
            OP_DECORATE if w.len() >= 3 && (converted.contains_key(&w[1]) && w[2] != DECORATION_RELAXED_PRECISION
                || io_structs.contains(&w[1]) && w[2] == DECORATION_BLOCK) => continue,
            OP_MEMBER_DECORATE if w.len() >= 4 && io_structs.contains(&w[1]) && w[3] != DECORATION_RELAXED_PRECISION => continue,
            OP_TYPE_POINTER if w.len() >= 4 && (w[2] == STORAGE_INPUT || w[2] == STORAGE_OUTPUT) => {
                out.extend(instruction(OP_TYPE_POINTER, &[w[1], if w[2] == STORAGE_OUTPUT { output_storage } else { STORAGE_PRIVATE }, w[3]]));
                continue;
            },
            OP_VARIABLE if w.len() >= 4 && converted.contains_key(&w[2]) => {
                out.extend(instruction(OP_VARIABLE, &[w[1], w[2], if converted[&w[2]] { output_storage } else { STORAGE_PRIVATE }]));
                continue;
            },
            OP_CONTROL_BARRIER if w.len() == 4 => {
                out.extend(instruction(OP_CONTROL_BARRIER, &[w[1], barrier_scope, barrier_semantics]));
                continue;
            },
            _ => {},
        }
        out.extend_from_slice(w);
    }
    if first_function >= instructions.len() {
        for d in &declarations {
            out.extend_from_slice(d);
        }
    }
    out[3] = bound;
    if stage == Stage::Control && t.vertices == 0 {
        return Err(String::from("a tessellation control shader without its output vertices"));
    }
    if stage == Stage::Evaluation {
        if t.domain == 0 {
            return Err(String::from("a tessellation evaluation shader without its primitive mode"));
        }
        // (GL's order is D3D's other one: the tessellator's v runs the other way)
        t.primitive = if t.point_mode { 1 } else if t.domain == 1 { 2 } else if t.clockwise { 4 } else { 3 };
    }
    Ok((out, t))
}

/// What the caller needs of a translated tessellation shader: the WGSL to append and the JSON
pub struct Finished {
    pub appended: String,
    pub json: String,
}

/// The leaves of a variable's element `index` (an array's, the variable's own when `index` is None)
fn variable_leaves(module: &naga::Module, name: &str, location: u32, index: Option<&str>) -> Result<Vec<Leaf>, String> {
    let (_, ty) = module.global_variables.iter().find(|(_, v)| v.name.as_deref() == Some(name)).map(|(h, v)| (h, v.ty))
        .ok_or_else(|| format!("{} naga left out", name))?;
    let (ty, access) = match (index, &module.types[ty].inner) {
        (Some(i), TypeInner::Array { base, .. }) => (*base, format!("{}[{}]", name, i)),
        (Some(_), _) => return Err(format!("{} is not an array", name)),
        (None, _) => (ty, String::from(name)),
    };
    let mut out = Vec::new();
    leaves(module, ty, &access, location, &mut out)?;
    Ok(out)
}

fn exists(module: &naga::Module, name: &str) -> bool {
    module.global_variables.iter().any(|(_, v)| v.name.as_deref() == Some(name))
}

/// The stores of leaves into `buffer` at `base` + LOCATIONS
fn write_leaves(wgsl: &mut String, list: &[Leaf], buffer: &str, base: &str, first_word: u32) {
    for leaf in list {
        for k in 0..leaf.components {
            let value = if leaf.components == 1 { leaf.access.clone() } else { format!("{}[{}]", leaf.access, k) };
            wgsl.push_str(&format!("    {}[{} + {}u] = {};\n", buffer, base, first_word + 4 * leaf.location + k, store(leaf.kind, &value)));
        }
    }
}

/// The reads of leaves from `buffer` at `base`
fn read_leaves(wgsl: &mut String, list: &[Leaf], buffer: &str, base: &str, first_word: u32) {
    for leaf in list {
        let at = format!("{} + {}u", base, first_word + 4 * leaf.location);
        wgsl.push_str(&format!("        {} = {};\n", leaf.access, load_from(buffer, leaf.kind, leaf.components, &at)));
    }
}

/// The position and point size of the per-vertex block (or the built-ins) into a vertex record
fn write_position(wgsl: &mut String, members: &[u32], block: &str, builtins: &[(u32, bool)], module: &naga::Module, buffer: &str, base: &str) {
    let mut put = |access: String, builtin: u32| {
        match builtin {
            BUILTIN_POSITION => for k in 0..4 {
                wgsl.push_str(&format!("    {}[{} + {}u] = {};\n", buffer, base, k, store(ScalarKind::Float, &format!("{}[{}]", access, k))));
            },
            BUILTIN_POINT_SIZE => wgsl.push_str(&format!("    {}[{} + 4u] = {};\n", buffer, base, store(ScalarKind::Float, &access))),
            _ => {},
        }
    };
    if exists(module, PER_VERTEX_OUT) {
        for (k, &b) in members.iter().enumerate() {
            put(format!("{}.{}", block, member_name(k)), b);
        }
    }
    for &(b, output) in builtins {
        if output && (b == BUILTIN_POSITION || b == BUILTIN_POINT_SIZE) && exists(module, &builtin_name(b, true)) {
            put(builtin_name(b, true), b);
        }
    }
}

/// The record of the outputs' leaves: its stride in words
fn stride_of(list: &[Leaf], first_word: u32) -> u32 {
    first_word + 4 * list.iter().map(|l| l.location + 1).max().unwrap_or(0)
}

/// The module without its entry point; the WGSL of the compute shader that runs its function
pub fn finish(module: &mut naga::Module, t: &Tessellation, group: u32) -> Result<Finished, String> {
    module.entry_points.clear();
    let mut wgsl = String::new();
    // the per-vertex inputs: control points (the vertex records, or the control shader's), as arrays of the patch's
    let fill_inputs = |wgsl: &mut String, module: &naga::Module, buffer: &str, record: &str| -> Result<(), String> {
        if exists(module, PER_VERTEX_IN) {
            for (k, &b) in t.in_members.iter().enumerate() {
                let access = format!("{}[k].{}", PER_VERTEX_IN, member_name(k));
                match b {
                    BUILTIN_POSITION => wgsl.push_str(&format!("        {} = {};\n", access, load_from(buffer, ScalarKind::Float, 4, record))),
                    BUILTIN_POINT_SIZE => wgsl.push_str(&format!("        {} = {};\n", access, load_from(buffer, ScalarKind::Float, 1, &format!("{} + 4u", record)))),
                    _ => {},
                }
            }
        }
        for &location in &t.inputs {
            if exists(module, &vertex_name(location, false)) {
                let list = variable_leaves(module, &vertex_name(location, false), location, Some("k"))?;
                read_leaves(wgsl, &list, buffer, record, LOCATIONS);
            }
        }
        Ok(())
    };
    let builtin = |b: u32, output: bool| Some(builtin_name(b, output)).filter(|n| exists(module, n));
    match t.stage {
        Some(Stage::Control) => {
            let n = t.vertices;
            let mut outputs = Vec::new();
            for &location in &t.outputs {
                outputs.extend(variable_leaves(module, &vertex_name(location, true), location, Some("inv"))?);
            }
            let mut patch = Vec::new();
            for &location in &t.patch_outputs {
                patch.extend(variable_leaves(module, &patch_name(location, true), location, None)?);
            }
            let cp_stride = stride_of(&outputs, LOCATIONS);
            let patch_stride = stride_of(&patch, PATCH_LOCATIONS);
            wgsl.push_str("\nstruct VxTcParams { patches: u32, in_stride: u32, patch_vertices: u32, per_instance: u32, domain: u32, pad0: u32, pad1: u32, pad2: u32 }\n");
            wgsl.push_str(&format!("@group({g}) @binding(960) var<uniform> vx_tc_p: VxTcParams;\n\
                @group({g}) @binding(961) var<storage, read> vx_tc_in: array<u32>;\n\
                @group({g}) @binding(962) var<storage, read> vx_tc_ids: array<u32>;\n\
                @group({g}) @binding(963) var<storage, read_write> vx_tc_cp: array<u32>;\n\
                @group({g}) @binding(964) var<storage, read_write> vx_tc_patch: array<u32>;\n", g = group));
            wgsl.push_str(&format!("@compute @workgroup_size({n}) fn vx_tess_control(@builtin(workgroup_id) wg: vec3<u32>, \
                @builtin(local_invocation_id) lid: vec3<u32>) {{\n    let vx_patch = wg.x + wg.y * 65535u;\n    \
                if (vx_patch >= vx_tc_p.patches) {{ return; }}\n    let inv = lid.x;\n    \
                for (var k = 0u; k < vx_tc_p.patch_vertices; k = k + 1u) {{\n        \
                let r = vx_tc_ids[vx_patch * vx_tc_p.patch_vertices + k] * vx_tc_p.in_stride;\n", n = n));
            fill_inputs(&mut wgsl, module, "vx_tc_in", "r")?;
            wgsl.push_str("    }\n");
            if let Some(name) = builtin(BUILTIN_INVOCATION_ID, false) { wgsl.push_str(&format!("    {} = i32(inv);\n", name)); }
            if let Some(name) = builtin(BUILTIN_PRIMITIVE_ID, false) { wgsl.push_str(&format!("    {} = i32(vx_patch % vx_tc_p.per_instance);\n", name)); }
            if let Some(name) = builtin(BUILTIN_PATCH_VERTICES, false) { wgsl.push_str(&format!("    {} = i32(vx_tc_p.patch_vertices);\n", name)); }
            wgsl.push_str(&format!("    {}();\n    workgroupBarrier();\n    let o = (vx_patch * {}u + inv) * {}u;\n", CONTROL_MAIN, n, cp_stride));
            let block = format!("{}[inv]", PER_VERTEX_OUT);
            write_position(&mut wgsl, &t.out_members, &block, &[], module, "vx_tc_cp", "o");
            write_leaves(&mut wgsl, &outputs, "vx_tc_cp", "o", LOCATIONS);
            // the patch's record: the tessellator's factors by the domain, GL's levels, the patch outputs
            wgsl.push_str(&format!("    if (inv != 0u) {{ return; }}\n    let p = vx_patch * {}u;\n", patch_stride));
            let outer = builtin(BUILTIN_TESS_LEVEL_OUTER, true).map_or(String::from("array<f32, 4>(0.0, 0.0, 0.0, 0.0)"), |n| n);
            let inner = builtin(BUILTIN_TESS_LEVEL_INNER, true).map_or(String::from("array<f32, 2>(0.0, 0.0)"), |n| n);
            wgsl.push_str(&format!("    let outer = {};\n    let inner = {};\n", outer, inner));
            wgsl.push_str("    var f = array<f32, 8>(outer[0], outer[1], outer[2], outer[3], inner[0], inner[1], 0.0, 0.0);\n    \
                if (vx_tc_p.domain == 2u) { f[3] = inner[0]; f[4] = 0.0; f[5] = 0.0; }\n    \
                if (vx_tc_p.domain == 1u) { f[2] = 0.0; f[3] = 0.0; f[4] = 0.0; f[5] = 0.0; }\n    \
                for (var k = 0u; k < 8u; k = k + 1u) { vx_tc_patch[p + k] = bitcast<u32>(f[k]); }\n");
            wgsl.push_str(&format!("    for (var k = 0u; k < 4u; k = k + 1u) {{ vx_tc_patch[p + {o}u + k] = bitcast<u32>(outer[k]); }}\n    \
                vx_tc_patch[p + {i}u] = bitcast<u32>(inner[0]);\n    vx_tc_patch[p + {i}u + 1u] = bitcast<u32>(inner[1]);\n", o = OUTER_WORD, i = INNER_WORD));
            write_leaves(&mut wgsl, &patch, "vx_tc_patch", "p", PATCH_LOCATIONS);
            wgsl.push_str("}\n");
            let json = format!("{{\"stage\":\"control\",\"vertices\":{},\"cp_stride\":{},\"patch_stride\":{}}}", n, cp_stride, patch_stride);
            Ok(Finished { appended: wgsl, json })
        },
        _ => {
            let mut outputs = Vec::new();
            for &location in &t.outputs {
                outputs.extend(variable_leaves(module, &vertex_name(location, true), location, None)?);
            }
            let stride = stride_of(&outputs, LOCATIONS);
            wgsl.push_str("\nstruct VxTeParams { per_instance: u32, cp_stride: u32, patch_stride: u32, vertices: u32, domain: u32, pad0: u32, pad1: u32, pad2: u32 }\n");
            wgsl.push_str(&format!("@group({g}) @binding(960) var<uniform> vx_te_p: VxTeParams;\n\
                @group({g}) @binding(961) var<storage, read> vx_te_cp: array<u32>;\n\
                @group({g}) @binding(962) var<storage, read> vx_te_patch: array<u32>;\n\
                @group({g}) @binding(963) var<storage, read> vx_te_points: array<vec4<u32>>;\n\
                @group({g}) @binding(964) var<storage, read> vx_te_args: array<u32>;\n\
                @group({g}) @binding(965) var<storage, read_write> vx_te_out: array<u32>;\n", g = group));
            wgsl.push_str("@compute @workgroup_size(64) fn vx_tess_eval(@builtin(global_invocation_id) id: vec3<u32>) {\n    \
                let n = id.x + id.y * 65535u * 64u;\n    if (n >= vx_te_args[7]) { return; }\n    let vx_point = vx_te_points[n];\n    \
                let u = bitcast<f32>(vx_point.x);\n    let v = bitcast<f32>(vx_point.y);\n    let vx_patch = vx_point.z;\n");
            if let Some(name) = builtin(BUILTIN_TESS_COORD, false) {
                wgsl.push_str(&format!("    {} = select(vec3<f32>(u, v, 0.0), vec3<f32>(u, v, 1.0 - u - v), vx_te_p.domain == 2u);\n", name));
            }
            wgsl.push_str("    for (var k = 0u; k < vx_te_p.vertices; k = k + 1u) {\n        let r = (vx_patch * vx_te_p.vertices + k) * vx_te_p.cp_stride;\n");
            fill_inputs(&mut wgsl, module, "vx_te_cp", "r")?;
            wgsl.push_str("    }\n    let p = vx_patch * vx_te_p.patch_stride;\n");
            for &location in &t.patch_inputs {
                if exists(module, &patch_name(location, false)) {
                    let list = variable_leaves(module, &patch_name(location, false), location, None)?;
                    read_leaves(&mut wgsl, &list, "vx_te_patch", "p", PATCH_LOCATIONS);
                }
            }
            if let Some(name) = builtin(BUILTIN_TESS_LEVEL_OUTER, false) {
                wgsl.push_str(&format!("    for (var k = 0u; k < 4u; k = k + 1u) {{ {}[k] = bitcast<f32>(vx_te_patch[p + {}u + k]); }}\n", name, OUTER_WORD));
            }
            if let Some(name) = builtin(BUILTIN_TESS_LEVEL_INNER, false) {
                wgsl.push_str(&format!("    for (var k = 0u; k < 2u; k = k + 1u) {{ {}[k] = bitcast<f32>(vx_te_patch[p + {}u + k]); }}\n", name, INNER_WORD));
            }
            if let Some(name) = builtin(BUILTIN_PRIMITIVE_ID, false) { wgsl.push_str(&format!("    {} = i32(vx_patch % vx_te_p.per_instance);\n", name)); }
            if let Some(name) = builtin(BUILTIN_PATCH_VERTICES, false) { wgsl.push_str(&format!("    {} = i32(vx_te_p.vertices);\n", name)); }
            wgsl.push_str(&format!("    {}();\n    let o = n * {}u;\n", EVALUATION_MAIN, stride));
            write_position(&mut wgsl, &t.out_members, PER_VERTEX_OUT, &t.builtins, module, "vx_te_out", "o");
            write_leaves(&mut wgsl, &outputs, "vx_te_out", "o", LOCATIONS);
            wgsl.push_str("}\n");
            let mut json = format!("{{\"stage\":\"evaluation\",\"domain\":{},\"spacing\":{},\"primitive\":{},\"stride\":{},\"outputs\":[",
                t.domain, t.spacing, t.primitive, stride);
            for (i, leaf) in outputs.iter().enumerate() {
                if i > 0 { json.push(','); }
                let kind = match leaf.kind { ScalarKind::Sint => "i", ScalarKind::Uint => "u", _ => "f" };
                let flags = t.interpolation.range(..=leaf.location).next_back().map_or(0, |(_, f)| *f);
                json.push_str(&format!("[{},\"{}\",{},{}]", leaf.location, kind, leaf.components, flags));
            }
            json.push_str("]}");
            Ok(Finished { appended: wgsl, json })
        },
    }
}
