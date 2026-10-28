//! Geometry shaders (GLES 3.2, docs/gles3-plan.md L6) as compute shaders:
//! WebGPU has no geometry stage. A draw with one runs its vertex shader as a
//! compute shader first (xfb.rs, every output captured: a record a vertex),
//! then its geometry shader once an input primitive and invocation, here:
//! the SPIR-V made a compute shader's (`prepare`: the inputs and outputs
//! private variables of names this module knows, EmitVertex and
//! EndPrimitive calls of functions it writes), the emitted vertices a list
//! of primitives (a strip's made a list's, GL's provoking vertex, the last,
//! first as WebGPU's flat inputs take it) in a buffer the draw reads as its
//! vertex buffer through a vertex shader that passes them on (the caller's,
//! of `outputs`).
//!
//! A record is u32 words: the position at 0, the point size at 4, gl_Layer
//! at 5, gl_PrimitiveID at 6, location l's components at 8 + 4l. The list
//! has `list` records an invocation; those it does not fill get a position
//! outside the clip volume (2, 2, 2, 1): nothing is drawn of them.
//!
//! The resources, in the group the caller gives:
//! - 960: the parameters (uniform, VxGsParams): the input primitives (all
//!   instances'), the vertex records' stride in words, the primitives an
//!   instance (gl_PrimitiveIDIn counts from 0 in each);
//! - 961: the vertex records (read-only storage);
//! - 962: each input primitive's vertices' record indices (read-only);
//! - 963: the emitted vertices (storage, `max_vertices` records an invocation);
//! - 964: the list (storage).

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use naga::{ScalarKind, TypeInner};

const OP_NAME: u32 = 5;
const OP_MEMBER_NAME: u32 = 6;
const OP_ENTRY_POINT: u32 = 15;
const OP_EXECUTION_MODE: u32 = 16;
const OP_CAPABILITY: u32 = 17;
const OP_TYPE_VOID: u32 = 19;
const OP_TYPE_ARRAY: u32 = 28;
const OP_TYPE_STRUCT: u32 = 30;
const OP_TYPE_POINTER: u32 = 32;
const OP_TYPE_FUNCTION: u32 = 33;
const OP_FUNCTION: u32 = 54;
const OP_FUNCTION_END: u32 = 56;
const OP_FUNCTION_CALL: u32 = 57;
const OP_VARIABLE: u32 = 59;
const OP_DECORATE: u32 = 71;
const OP_MEMBER_DECORATE: u32 = 72;
const OP_EMIT_VERTEX: u32 = 218;
const OP_END_PRIMITIVE: u32 = 219;
const OP_LABEL: u32 = 248;
const OP_RETURN: u32 = 253;

const MODEL_GEOMETRY: u32 = 3;
const MODEL_GL_COMPUTE: u32 = 5;
const STORAGE_INPUT: u32 = 1;
const STORAGE_OUTPUT: u32 = 3;
const STORAGE_PRIVATE: u32 = 6;

const DECORATION_RELAXED_PRECISION: u32 = 0;
const DECORATION_BLOCK: u32 = 2;
const DECORATION_BUILTIN: u32 = 11;
const DECORATION_NO_PERSPECTIVE: u32 = 13;
const DECORATION_FLAT: u32 = 14;
const DECORATION_CENTROID: u32 = 16;
const DECORATION_SAMPLE: u32 = 17;
const DECORATION_LOCATION: u32 = 30;

const BUILTIN_POSITION: u32 = 0;
const BUILTIN_POINT_SIZE: u32 = 1;
const BUILTIN_PRIMITIVE_ID: u32 = 7;
const BUILTIN_INVOCATION_ID: u32 = 8;
const BUILTIN_LAYER: u32 = 9;

/// The record's words: position, point size, layer, primitive id, then location l at LOCATIONS + 4l
const LAYER_WORD: u32 = 5;
const PRIMITIVE_WORD: u32 = 6;
const LOCATIONS: u32 = 8;

/// The names the converted variables and functions get (not ending in a
/// digit: naga's namer would add an underscore)
pub const MAIN: &str = "vx_gsmain";
const EMIT: &str = "vx_emit";
const END: &str = "vx_end";
fn input_name(location: u32) -> String { format!("vx_gi{}x", location) }
fn output_name(location: u32) -> String { format!("vx_go{}x", location) }
fn builtin_name(builtin: u32, output: bool) -> String { format!("vx_gb{}{}x", builtin, if output { "o" } else { "i" }) }
const PER_VERTEX_IN: &str = "vx_gpvix";
const PER_VERTEX_OUT: &str = "vx_gpvox";
pub(crate) fn member_name(index: usize) -> String { format!("vx_m{}x", index) }

/// What `prepare` read of the geometry shader
#[derive(Clone, Debug, Default)]
pub struct Geometry {
    /// vertices an input primitive: 1, 2, 4 (lines with adjacency), 3, 6
    pub input_vertices: u32,
    /// 0 points, 1 line strip, 2 triangle strip
    pub output: u32,
    pub max_vertices: u32,
    pub invocations: u32,
    /// the outputs' interpolation by location: 1 flat, 2 no perspective, 4 centroid, 8 sample
    interpolation: BTreeMap<u32, u32>,
    /// the per-vertex blocks' members' built-ins (gl_in's, the output's)
    in_members: Vec<u32>,
    out_members: Vec<u32>,
    /// the inputs' and outputs' locations, the built-ins (built-in, output)
    inputs: Vec<u32>,
    outputs: Vec<u32>,
    builtins: Vec<(u32, bool)>,
}

pub(crate) fn string_words(text: &str) -> Vec<u32> {
    let mut bytes = text.as_bytes().to_vec();
    bytes.push(0);
    while bytes.len() % 4 != 0 {
        bytes.push(0);
    }
    bytes.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

pub(crate) fn instruction(op: u32, operands: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(operands.len() + 1);
    out.push((operands.len() as u32 + 1) << 16 | op);
    out.extend_from_slice(operands);
    out
}

/// The words of a literal string at the start of `w`: how many
pub(crate) fn string_length(w: &[u32]) -> usize {
    w.iter().position(|word| word.to_le_bytes().contains(&0)).map_or(w.len(), |i| i + 1)
}

/// The geometry shader's SPIR-V as a compute shader's (see above), and what it read
pub fn prepare(words: &[u32]) -> Result<(Vec<u32>, Geometry), String> {
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
    let mut entry = None;
    let mut void = None;
    let mut void_function = None;
    let mut pointers: BTreeMap<u32, u32> = BTreeMap::new();
    let mut arrays: BTreeMap<u32, u32> = BTreeMap::new();
    let mut structs: BTreeMap<u32, usize> = BTreeMap::new();
    let mut variables: Vec<(u32, u32, bool)> = Vec::new();
    let mut decorations: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
    let mut members: BTreeMap<(u32, u32), Vec<(u32, u32)>> = BTreeMap::new();
    for w in &instructions {
        match op(w) {
            OP_ENTRY_POINT if w.len() >= 3 && w[1] == MODEL_GEOMETRY && entry.is_none() => entry = Some(w[2]),
            OP_TYPE_VOID if w.len() >= 2 => void = Some(w[1]),
            OP_TYPE_FUNCTION if w.len() == 3 && Some(w[2]) == void => void_function = Some(w[1]),
            OP_TYPE_POINTER if w.len() >= 4 => {
                pointers.insert(w[1], w[3]);
            },
            OP_TYPE_ARRAY if w.len() >= 3 => {
                arrays.insert(w[1], w[2]);
            },
            OP_TYPE_STRUCT if w.len() >= 2 => {
                structs.insert(w[1], w.len() - 2);
            },
            OP_VARIABLE if w.len() >= 4 && (w[3] == STORAGE_INPUT || w[3] == STORAGE_OUTPUT) => variables.push((w[2], w[1], w[3] == STORAGE_OUTPUT)),
            OP_DECORATE if w.len() >= 3 => decorations.entry(w[1]).or_default().push((w[2], w.get(3).copied().unwrap_or(0))),
            OP_MEMBER_DECORATE if w.len() >= 4 => members.entry((w[1], w[2])).or_default().push((w[3], w.get(4).copied().unwrap_or(0))),
            _ => {},
        }
    }
    let entry = entry.ok_or("no geometry entry point")?;
    let void = void.ok_or("no void type")?;
    let void_function = void_function.ok_or("no void function type")?;
    let find = |list: Option<&Vec<(u32, u32)>>, d: u32| list.and_then(|l| l.iter().find(|(k, _)| *k == d).map(|(_, v)| *v));

    // each variable's role and name; the blocks of the interface
    let mut g = Geometry { invocations: 1, ..Geometry::default() };
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
            g.builtins.push((builtin, output));
            builtin_name(builtin, output)
        }
        else if let Some(&count) = structs.get(&ty).filter(|_| (0..structs[&ty] as u32).any(|m| find(members.get(&(ty, m)), DECORATION_BUILTIN).is_some())) {
            let list: Vec<u32> = (0..count as u32).map(|m| find(members.get(&(ty, m)), DECORATION_BUILTIN).unwrap_or(u32::MAX)).collect();
            if output {
                g.out_members = list;
                String::from(PER_VERTEX_OUT)
            }
            else {
                g.in_members = list;
                String::from(PER_VERTEX_IN)
            }
        }
        else {
            let location = find(decorated, DECORATION_LOCATION).or_else(|| find(members.get(&(ty, 0)), DECORATION_LOCATION))
                .ok_or("an input or output of no location")?;
            if output {
                let mut flags = 0;
                for (d, bit) in [(DECORATION_FLAT, 1), (DECORATION_NO_PERSPECTIVE, 2), (DECORATION_CENTROID, 4), (DECORATION_SAMPLE, 8)] {
                    if decorated.is_some_and(|l| l.iter().any(|(k, _)| *k == d)) {
                        flags |= bit;
                    }
                }
                g.interpolation.insert(location, flags);
                g.outputs.push(location);
                output_name(location)
            }
            else {
                g.inputs.push(location);
                input_name(location)
            }
        };
        names.insert(var, name);
    }
    let converted: BTreeSet<u32> = variables.iter().map(|v| v.0).collect();

    let mut bound = words[3];
    let mut fresh = || {
        let id = bound;
        bound += 1;
        id
    };
    let emit = fresh();
    let end = fresh();
    let mut out = words[..5].to_vec();
    let mut named_stubs = false;
    for w in &instructions {
        match op(w) {
            OP_CAPABILITY if w.len() >= 2 && matches!(w[1], 2 | 24 | 54) => continue,
            OP_ENTRY_POINT if w.len() >= 3 && w[2] == entry => {
                let n = string_length(&w[3..]);
                let mut operands = vec![MODEL_GL_COMPUTE, entry];
                operands.extend_from_slice(&w[3..3 + n]);
                out.extend(instruction(OP_ENTRY_POINT, &operands));
                // (LocalSize 1 1 1: naga wants a compute shader's size; the module's own entry point goes, vx_geometry calls its function)
                out.extend(instruction(OP_EXECUTION_MODE, &[entry, 17, 1, 1, 1]));
                continue;
            },
            OP_EXECUTION_MODE if w.len() >= 3 && w[1] == entry => {
                match w[2] {
                    0 => g.invocations = w.get(3).copied().unwrap_or(1).max(1),
                    19 => g.input_vertices = 1,
                    20 => g.input_vertices = 2,
                    21 => g.input_vertices = 4,
                    22 => g.input_vertices = 3,
                    23 => g.input_vertices = 6,
                    26 => g.max_vertices = w.get(3).copied().unwrap_or(0),
                    27 => g.output = 0,
                    28 => g.output = 1,
                    29 => g.output = 2,
                    _ => {
                        out.extend_from_slice(w);
                    },
                }
                continue;
            },
            OP_NAME if w.len() >= 2 => {
                if let Some(name) = names.get(&w[1]) {
                    let mut operands = vec![w[1]];
                    operands.extend(string_words(name));
                    out.extend(instruction(OP_NAME, &operands));
                    continue;
                }
                if w[1] == entry {
                    let mut operands = vec![entry];
                    operands.extend(string_words(MAIN));
                    out.extend(instruction(OP_NAME, &operands));
                    for (id, name) in [(emit, EMIT), (end, END)] {
                        let mut operands = vec![id];
                        operands.extend(string_words(name));
                        out.extend(instruction(OP_NAME, &operands));
                    }
                    named_stubs = true;
                    continue;
                }
            },
            OP_MEMBER_NAME if w.len() >= 3 && io_structs.contains(&w[1]) => {
                let mut operands = vec![w[1], w[2]];
                operands.extend(string_words(&member_name(w[2] as usize)));
                out.extend(instruction(OP_MEMBER_NAME, &operands));
                continue;
            },
            OP_DECORATE if w.len() >= 3 && (converted.contains(&w[1]) && w[2] != DECORATION_RELAXED_PRECISION
                || io_structs.contains(&w[1]) && w[2] == DECORATION_BLOCK) => continue,
            OP_MEMBER_DECORATE if w.len() >= 4 && io_structs.contains(&w[1]) && w[3] != DECORATION_RELAXED_PRECISION => continue,
            OP_TYPE_POINTER if w.len() >= 4 && (w[2] == STORAGE_INPUT || w[2] == STORAGE_OUTPUT) => {
                out.extend(instruction(OP_TYPE_POINTER, &[w[1], STORAGE_PRIVATE, w[3]]));
                continue;
            },
            OP_VARIABLE if w.len() >= 4 && converted.contains(&w[2]) => {
                let mut operands = vec![w[1], w[2], STORAGE_PRIVATE];
                operands.extend_from_slice(&w[4..]);
                out.extend(instruction(OP_VARIABLE, &operands));
                continue;
            },
            OP_EMIT_VERTEX | OP_END_PRIMITIVE => {
                let callee = if op(w) == OP_EMIT_VERTEX { emit } else { end };
                let result = fresh();
                out.extend(instruction(OP_FUNCTION_CALL, &[void, result, callee]));
                continue;
            },
            _ => {},
        }
        out.extend_from_slice(w);
    }
    if g.input_vertices == 0 || g.max_vertices == 0 {
        return Err(String::from("a geometry shader without its input or output layout"));
    }
    if !named_stubs {
        return Err(String::from("the geometry shader's entry point has no name"));
    }
    // the functions EmitVertex and EndPrimitive call: empty, their WGSL written after naga's (finish)
    for callee in [emit, end] {
        let label = fresh();
        out.extend(instruction(OP_FUNCTION, &[void, callee, 0, void_function]));
        out.extend(instruction(OP_LABEL, &[label]));
        out.extend(instruction(OP_RETURN, &[]));
        out.extend(instruction(OP_FUNCTION_END, &[]));
    }
    out[3] = bound;
    Ok((out, g))
}

/// A scalar or vector of an input or output, at its location: its WGSL
/// access (from the variable's), kind and components
pub(crate) struct Leaf {
    pub(crate) access: String,
    pub(crate) location: u32,
    pub(crate) kind: ScalarKind,
    pub(crate) components: u32,
}

/// The leaves of a value of type `ty` (`access`), from `location`; how many locations they take
pub(crate) fn leaves(module: &naga::Module, ty: naga::Handle<naga::Type>, access: &str, location: u32, out: &mut Vec<Leaf>) -> Result<u32, String> {
    match module.types[ty].inner {
        TypeInner::Scalar(s) => {
            out.push(Leaf { access: String::from(access), location, kind: s.kind, components: 1 });
            Ok(1)
        },
        TypeInner::Vector { size, scalar } => {
            out.push(Leaf { access: String::from(access), location, kind: scalar.kind, components: size as u32 });
            Ok(1)
        },
        TypeInner::Matrix { columns, rows, .. } => {
            for c in 0..columns as u32 {
                out.push(Leaf { access: format!("{}[{}]", access, c), location: location + c, kind: ScalarKind::Float, components: rows as u32 });
            }
            Ok(columns as u32)
        },
        TypeInner::Array { base, size: naga::ArraySize::Constant(n), .. } => {
            let mut used = 0;
            for e in 0..n.get() {
                used += leaves(module, base, &format!("{}[{}]", access, e), location + used, out)?;
            }
            Ok(used)
        },
        TypeInner::Struct { ref members, .. } => {
            let mut used = 0;
            for (k, m) in members.iter().enumerate() {
                used += leaves(module, m.ty, &format!("{}.{}", access, member_name(k)), location + used, out)?;
            }
            Ok(used)
        },
        _ => Err(String::from("an input or output of a type not done")),
    }
}

fn scalar_name(kind: ScalarKind) -> &'static str {
    match kind {
        ScalarKind::Sint => "i32",
        ScalarKind::Uint => "u32",
        ScalarKind::Bool => "bool",
        _ => "f32",
    }
}

/// A leaf's value read from words `base + k` (a WGSL expression) of `buffer`
pub(crate) fn load_from(buffer: &str, kind: ScalarKind, components: u32, base: &str) -> String {
    let one = |k: u32| {
        let word = format!("{}[{} + {}u]", buffer, base, k);
        match kind {
            ScalarKind::Sint => format!("bitcast<i32>({})", word),
            ScalarKind::Uint => word,
            ScalarKind::Bool => format!("({} != 0u)", word),
            _ => format!("bitcast<f32>({})", word),
        }
    };
    if components == 1 {
        return one(0);
    }
    let parts: Vec<String> = (0..components).map(one).collect();
    format!("vec{}<{}>({})", components, scalar_name(kind), parts.join(", "))
}

fn load(kind: ScalarKind, components: u32, base: &str) -> String { load_from("vx_gs_in", kind, components, base) }

/// A component of a leaf as a word
pub(crate) fn store(kind: ScalarKind, value: &str) -> String {
    match kind {
        ScalarKind::Uint => String::from(value),
        ScalarKind::Bool => format!("select(0u, 1u, {})", value),
        _ => format!("bitcast<u32>({})", value),
    }
}

/// What the caller needs of a translated geometry shader: the WGSL of
/// vx_emit and vx_end (in place of naga's empty ones) and the rest to
/// append, and the JSON of the outputs and layout
pub struct Finished {
    pub emit: String,
    pub end: String,
    pub appended: String,
    pub json: String,
}

/// The module (naga's, of `prepare`'s SPIR-V) without its entry point; the
/// WGSL of the compute shader vx_geometry that runs the shader's function
pub fn finish(module: &mut naga::Module, g: &Geometry, group: u32) -> Result<Finished, String> {
    module.entry_points.clear();
    let global = |name: &str| module.global_variables.iter().find(|(_, v)| v.name.as_deref() == Some(name)).map(|(h, v)| (h, v.ty));
    let n = g.input_vertices;
    let list = match g.output {
        0 => g.max_vertices,
        1 => 2 * g.max_vertices.saturating_sub(1),
        _ => 3 * g.max_vertices.saturating_sub(2),
    }.max(1);

    // the outputs' leaves: the record's stride
    let mut outputs: Vec<Leaf> = Vec::new();
    for &location in &g.outputs {
        let (_, ty) = global(&output_name(location)).ok_or("an output naga left out")?;
        leaves(module, ty, &output_name(location), location, &mut outputs)?;
    }
    let stride = LOCATIONS + 4 * outputs.iter().map(|l| l.location + 1).max().unwrap_or(0);

    // vx_emit: the outputs into the emitted record, then the list's primitive of it
    let mut emit = format!("fn {}() {{\n    if (vx_gs_n >= {}u) {{ return; }}\n    let r = vx_gs_ebase + vx_gs_n * {}u;\n", EMIT, g.max_vertices, stride);
    let mut word = |w: u32, value: String, out: &mut String| out.push_str(&format!("    vx_gs_emit[r + {}u] = {};\n", w, value));
    let vector4 = |access: &str, out: &mut String, word: &mut dyn FnMut(u32, String, &mut String)| {
        for k in 0..4 {
            word(k, store(ScalarKind::Float, &format!("{}[{}]", access, k)), out);
        }
    };
    if let Some((_, _)) = global(PER_VERTEX_OUT) {
        for (k, &builtin) in g.out_members.iter().enumerate() {
            let access = format!("{}.{}", PER_VERTEX_OUT, member_name(k));
            match builtin {
                BUILTIN_POSITION => vector4(&access, &mut emit, &mut word),
                BUILTIN_POINT_SIZE => word(4, store(ScalarKind::Float, &access), &mut emit),
                _ => {},
            }
        }
    }
    for &(builtin, output) in &g.builtins {
        if !output || global(&builtin_name(builtin, true)).is_none() {
            continue;
        }
        let access = builtin_name(builtin, true);
        match builtin {
            BUILTIN_POSITION => vector4(&access, &mut emit, &mut word),
            BUILTIN_POINT_SIZE => word(4, store(ScalarKind::Float, &access), &mut emit),
            BUILTIN_LAYER => word(LAYER_WORD, store(ScalarKind::Sint, &access), &mut emit),
            BUILTIN_PRIMITIVE_ID => word(PRIMITIVE_WORD, store(ScalarKind::Sint, &access), &mut emit),
            _ => {},
        }
    }
    for leaf in &outputs {
        for k in 0..leaf.components {
            let value = if leaf.components == 1 { leaf.access.clone() } else { format!("{}[{}]", leaf.access, k) };
            word(LOCATIONS + 4 * leaf.location + k, store(leaf.kind, &value), &mut emit);
        }
    }
    emit.push_str("    vx_gs_n = vx_gs_n + 1u;\n    vx_gs_strip = vx_gs_strip + 1u;\n    let k = vx_gs_n - 1u;\n");
    emit.push_str(match g.output {
        0 => "    vx_gs_copy(k);\n",
        1 => "    if (vx_gs_strip >= 2u) { vx_gs_copy(k); vx_gs_copy(k - 1u); }\n",
        _ => "    if (vx_gs_strip >= 3u) {\n        vx_gs_copy(k);\n        if (((vx_gs_strip - 3u) & 1u) == 0u) { vx_gs_copy(k - 2u); vx_gs_copy(k - 1u); }\n        \
            else { vx_gs_copy(k - 1u); vx_gs_copy(k - 2u); }\n    }\n",
    });
    emit.push_str("}\n");
    let end = format!("fn {}() {{\n    vx_gs_strip = 0u;\n}}\n", END);

    let mut wgsl = String::new();
    wgsl.push_str("\nstruct VxGsParams { prims: u32, in_stride: u32, prims_per_instance: u32, pad: u32 }\n");
    wgsl.push_str(&format!("@group({g}) @binding(960) var<uniform> vx_gs_p: VxGsParams;\n\
        @group({g}) @binding(961) var<storage, read> vx_gs_in: array<u32>;\n\
        @group({g}) @binding(962) var<storage, read> vx_gs_ids: array<u32>;\n\
        @group({g}) @binding(963) var<storage, read_write> vx_gs_emit: array<u32>;\n\
        @group({g}) @binding(964) var<storage, read_write> vx_gs_out: array<u32>;\n", g = group));
    wgsl.push_str("var<private> vx_gs_n: u32;\nvar<private> vx_gs_strip: u32;\nvar<private> vx_gs_listed: u32;\n\
        var<private> vx_gs_ebase: u32;\nvar<private> vx_gs_lbase: u32;\n");
    // (\"from\" is a reserved word of WGSL's)
    wgsl.push_str(&format!("fn vx_gs_copy(k: u32) {{\n    let vx_from = vx_gs_ebase + k * {s}u;\n    let vx_to = vx_gs_lbase + vx_gs_listed * {s}u;\n    \
        for (var w = 0u; w < {s}u; w = w + 1u) {{ vx_gs_out[vx_to + w] = vx_gs_emit[vx_from + w]; }}\n    vx_gs_listed = vx_gs_listed + 1u;\n}}\n", s = stride));
    wgsl.push_str(&format!("@compute @workgroup_size(64) fn vx_geometry(@builtin(global_invocation_id) id: vec3<u32>) {{\n    \
        let n = id.x;\n    if (n >= vx_gs_p.prims * {inv}u) {{ return; }}\n    let prim = n / {inv}u;\n    let inv = n % {inv}u;\n    \
        vx_gs_ebase = n * {maxv}u * {s}u;\n    vx_gs_lbase = n * {list}u * {s}u;\n    vx_gs_n = 0u;\n    vx_gs_strip = 0u;\n    vx_gs_listed = 0u;\n",
        inv = g.invocations, maxv = g.max_vertices, s = stride, list = list));
    // the inputs, from the vertex records
    for i in 0..n {
        wgsl.push_str(&format!("    let r{i} = vx_gs_ids[prim * {n}u + {i}u] * vx_gs_p.in_stride;\n", i = i, n = n));
    }
    if let Some((_, _)) = global(PER_VERTEX_IN) {
        for i in 0..n {
            for (k, &builtin) in g.in_members.iter().enumerate() {
                let access = format!("{}[{}].{}", PER_VERTEX_IN, i, member_name(k));
                match builtin {
                    BUILTIN_POSITION => wgsl.push_str(&format!("    {} = {};\n", access, load(ScalarKind::Float, 4, &format!("r{}", i)))),
                    BUILTIN_POINT_SIZE => wgsl.push_str(&format!("    {} = {};\n", access, load(ScalarKind::Float, 1, &format!("r{} + 4u", i)))),
                    _ => {},
                }
            }
        }
    }
    for &location in &g.inputs {
        let Some((_, ty)) = global(&input_name(location)) else { continue };
        let TypeInner::Array { base, .. } = module.types[ty].inner else { return Err(String::from("a geometry input not an array")) };
        for i in 0..n {
            let mut list = Vec::new();
            leaves(module, base, &format!("{}[{}]", input_name(location), i), location, &mut list)?;
            for leaf in list {
                let at = format!("r{} + {}u", i, LOCATIONS + 4 * leaf.location);
                wgsl.push_str(&format!("    {} = {};\n", leaf.access, load(leaf.kind, leaf.components, &at)));
            }
        }
    }
    for &(builtin, output) in &g.builtins {
        if output || global(&builtin_name(builtin, false)).is_none() {
            continue;
        }
        match builtin {
            BUILTIN_PRIMITIVE_ID => wgsl.push_str(&format!("    {} = i32(prim % vx_gs_p.prims_per_instance);\n", builtin_name(builtin, false))),
            BUILTIN_INVOCATION_ID => wgsl.push_str(&format!("    {} = i32(inv);\n", builtin_name(builtin, false))),
            _ => return Err(format!("a geometry shader's built-in input {} not done", builtin)),
        }
    }
    wgsl.push_str(&format!("    {}();\n", MAIN));
    // (the list's slots left: outside the clip volume)
    wgsl.push_str(&format!("    for (var k = vx_gs_listed; k < {list}u; k = k + 1u) {{\n        let vx_to = vx_gs_lbase + k * {s}u;\n        \
        vx_gs_out[vx_to] = 0x40000000u;\n        vx_gs_out[vx_to + 1u] = 0x40000000u;\n        vx_gs_out[vx_to + 2u] = 0x40000000u;\n        \
        vx_gs_out[vx_to + 3u] = 0x3F800000u;\n    }}\n}}\n", list = list, s = stride));

    // the outputs the pass-through vertex shader has: [location, kind, components, interpolation]
    let mut json = format!("{{\"input\":{},\"output\":{},\"max_vertices\":{},\"invocations\":{},\"list\":{},\"stride\":{},\"outputs\":[",
        n, g.output, g.max_vertices, g.invocations, list, stride);
    for (i, leaf) in outputs.iter().enumerate() {
        if i > 0 { json.push(','); }
        let kind = match leaf.kind { ScalarKind::Sint => "i", ScalarKind::Uint => "u", _ => "f" };
        // (the variable's interpolation, by its first location)
        let flags = g.interpolation.range(..=leaf.location).next_back().map_or(0, |(_, f)| *f);
        json.push_str(&format!("[{},\"{}\",{},{}]", leaf.location, kind, leaf.components, flags));
    }
    json.push_str(&format!("],\"layer\":{},\"primitive_id\":{}}}",
        g.builtins.contains(&(BUILTIN_LAYER, true)), g.builtins.contains(&(BUILTIN_PRIMITIVE_ID, true))));
    Ok(Finished { emit, end, appended: wgsl, json })
}

/// naga's WGSL with its empty vx_emit and vx_end replaced by `finished`'s
pub fn replace_stubs(wgsl: &mut String, finished: &Finished) -> Result<(), String> {
    for (name, body) in [(EMIT, &finished.emit), (END, &finished.end)] {
        let head = format!("fn {}() {{", name);
        let start = wgsl.find(&head).ok_or_else(|| format!("naga wrote no {}", name))?;
        let close = wgsl[start..].find("\n}\n").ok_or("an unterminated function")? + start + 3;
        wgsl.replace_range(start..close, body);
    }
    Ok(())
}
