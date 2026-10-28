//! Transform feedback (VK_EXT_transform_feedback) for VX: WebGPU's vertex
//! stage cannot write storage buffers, so a draw that captures runs its
//! vertex shader again as a compute shader first, one invocation a vertex,
//! which reads the vertex attributes from the vertex buffers itself (as
//! storage buffers of u32) and writes the outputs the SPIR-V decorates with
//! XfbBuffer, XfbStride and Offset into the transform feedback buffers.
//!
//! The vertex entry point stays as it is; a copy of it becomes an ordinary
//! function (vx_vs: its arguments without their bindings, its result the
//! entry point's output struct, whose members get the names vx_o0m, ...), and
//! the compute entry point vx_xfb (WGSL appended to naga's) calls it. Its
//! resources, in the group the caller gives (one the vertex shader does not
//! use):
//! - binding 960: the parameters (uniform, VxXfbParams): first vertex,
//!   vertex count (an instance's), first instance, instance count, the
//!   capture's first vertex (its place in the buffers), the vertices to
//!   capture (those of the primitives that fit), then each transform feedback
//!   buffer's offset in bytes, and each vertex buffer slot's;
//! - 961 + slot: vertex buffer `slot`'s memory (read-only storage, whole);
//! - 970 + buffer: transform feedback buffer `buffer` (read-write storage).
//!
//! Positions are as Vulkan's (the caller translates with the clip space
//! kept), so that what is captured is what Vulkan's would be.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use naga::{Binding, BuiltIn, Handle, ScalarKind, TypeInner, VectorSize};

/// What a captured output is (by its binding) and where it goes
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Output {
    Location(u32),
    Position,
    PointSize,
}
#[derive(Clone, Copy, Debug)]
pub struct Capture {
    pub output: Output,
    pub buffer: u32,
    pub offset: u32,
}

/// A vertex attribute of the pipeline: its location, buffer slot, VkFormat and offset
#[derive(Clone, Copy, Debug)]
pub struct Attribute {
    pub location: u32,
    pub slot: u32,
    pub format: u32,
    pub offset: u32,
}
/// A vertex buffer slot of the pipeline: its stride and input rate (1: per instance)
#[derive(Clone, Copy, Debug)]
pub struct Slot {
    pub slot: u32,
    pub stride: u32,
    pub instance: bool,
}

const OP_EXECUTION_MODE: u32 = 16;
const OP_DECORATE: u32 = 71;
const OP_MEMBER_DECORATE: u32 = 72;
const OP_VARIABLE: u32 = 59;
const OP_TYPE_POINTER: u32 = 32;
const EXECUTION_MODE_XFB: u32 = 11;
const DECORATION_BUILTIN: u32 = 11;
const DECORATION_LOCATION: u32 = 30;
const DECORATION_OFFSET: u32 = 35;
const DECORATION_XFB_BUFFER: u32 = 36;
const DECORATION_XFB_STRIDE: u32 = 37;
const BUILTIN_POSITION: u32 = 0;
const BUILTIN_POINT_SIZE: u32 = 1;
const STORAGE_OUTPUT: u32 = 3;

/// The captured outputs a vertex shader's SPIR-V declares (an Xfb execution
/// mode, outputs with XfbBuffer and Offset), and each buffer's stride; none
/// when it captures nothing
pub fn captures(words: &[u32]) -> Option<(Vec<Capture>, [u32; 4])> {
    use alloc::collections::BTreeMap;
    let mut xfb = false;
    // decorations by id, and by (struct type, member)
    let mut decorations: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
    let mut members: BTreeMap<(u32, u32), Vec<(u32, u32)>> = BTreeMap::new();
    let mut pointers: BTreeMap<u32, u32> = BTreeMap::new();
    let mut outputs: Vec<(u32, u32)> = Vec::new();
    let mut at = 5;
    while at < words.len() {
        let count = (words[at] >> 16) as usize;
        let op = words[at] & 0xFFFF;
        if count == 0 || at + count > words.len() {
            return None;
        }
        let w = &words[at..at + count];
        match op {
            OP_EXECUTION_MODE if count >= 3 && w[2] == EXECUTION_MODE_XFB => xfb = true,
            OP_DECORATE if count >= 3 => decorations.entry(w[1]).or_default().push((w[2], *w.get(3).unwrap_or(&0))),
            OP_MEMBER_DECORATE if count >= 4 => members.entry((w[1], w[2])).or_default().push((w[3], *w.get(4).unwrap_or(&0))),
            OP_TYPE_POINTER if count >= 4 => {
                pointers.insert(w[1], w[3]);
            },
            OP_VARIABLE if count >= 4 && w[3] == STORAGE_OUTPUT => outputs.push((w[2], w[1])),
            _ => {},
        }
        at += count;
    }
    if !xfb {
        return None;
    }
    let find = |list: &Vec<(u32, u32)>, d: u32| list.iter().find(|(k, _)| *k == d).map(|(_, v)| *v);
    let mut strides = [0u32; 4];
    let mut captures = Vec::new();
    for (var, pointer) in outputs {
        let empty = Vec::new();
        let decorated = decorations.get(&var).unwrap_or(&empty);
        let buffer = find(decorated, DECORATION_XFB_BUFFER);
        if let Some(stride) = find(decorated, DECORATION_XFB_STRIDE) {
            if let Some(b) = buffer {
                strides[b as usize & 3] = stride;
            }
        }
        // a block's members (gl_PerVertex's position)
        let ty = pointers.get(&pointer).copied().unwrap_or(0);
        for ((t, member), list) in members.range((ty, 0)..=(ty, u32::MAX)) {
            let _ = (t, member);
            let (Some(builtin), Some(offset)) = (find(list, DECORATION_BUILTIN), find(list, DECORATION_OFFSET))
            else {
                continue;
            };
            let Some(b) = find(list, DECORATION_XFB_BUFFER).or(buffer)
            else {
                continue;
            };
            if let Some(stride) = find(list, DECORATION_XFB_STRIDE) {
                strides[b as usize & 3] = stride;
            }
            if builtin == BUILTIN_POSITION {
                captures.push(Capture { output: Output::Position, buffer: b, offset });
            }
            else if builtin == BUILTIN_POINT_SIZE {
                captures.push(Capture { output: Output::PointSize, buffer: b, offset });
            }
        }
        let (Some(b), Some(offset)) = (buffer, find(decorated, DECORATION_OFFSET))
        else {
            continue;
        };
        if let Some(location) = find(decorated, DECORATION_LOCATION) {
            captures.push(Capture { output: Output::Location(location), buffer: b, offset });
        }
        else if find(decorated, DECORATION_BUILTIN) == Some(BUILTIN_POSITION) {
            captures.push(Capture { output: Output::Position, buffer: b, offset });
        }
        else if find(decorated, DECORATION_BUILTIN) == Some(BUILTIN_POINT_SIZE) {
            captures.push(Capture { output: Output::PointSize, buffer: b, offset });
        }
    }
    if captures.is_empty() {
        return None;
    }
    Some((captures, strides))
}

/// The SPIR-V without what naga refuses of transform feedback (the Xfb
/// execution mode; the TransformFeedback capability, the XfbBuffer,
/// XfbStride and Stream decorations, and the Offset of outputs, which naga
/// has no use for): `captures` has read them first
pub fn strip(words: &[u32]) -> Vec<u32> {
    const OP_CAPABILITY: u32 = 17;
    const CAPABILITY_TRANSFORM_FEEDBACK: u32 = 53;
    const DECORATION_STREAM: u32 = 29;
    let mut outputs = alloc::collections::BTreeSet::new();
    let mut at = 5;
    while at < words.len() {
        let count = (words[at] >> 16) as usize;
        if count == 0 || at + count > words.len() {
            return words.to_vec();
        }
        if words[at] & 0xFFFF == OP_VARIABLE && count >= 4 && words[at + 3] == STORAGE_OUTPUT {
            outputs.insert(words[at + 2]);
        }
        at += count;
    }
    let mut out = words[..5.min(words.len())].to_vec();
    let mut at = 5;
    while at < words.len() {
        let count = (words[at] >> 16) as usize;
        let op = words[at] & 0xFFFF;
        let w = &words[at..at + count];
        let drop = match op {
            OP_EXECUTION_MODE => count >= 3 && w[2] == EXECUTION_MODE_XFB,
            OP_CAPABILITY => count >= 2 && w[1] == CAPABILITY_TRANSFORM_FEEDBACK,
            OP_DECORATE => count >= 3 && (matches!(w[2], DECORATION_XFB_BUFFER | DECORATION_XFB_STRIDE | DECORATION_STREAM)
                || w[2] == DECORATION_OFFSET && outputs.contains(&w[1])),
            OP_MEMBER_DECORATE => count >= 4 && matches!(w[3], DECORATION_XFB_BUFFER | DECORATION_XFB_STRIDE | DECORATION_STREAM),
            _ => false,
        };
        if !drop {
            out.extend_from_slice(w);
        }
        at += count;
    }
    out
}

/// A scalar or vector type in WGSL
fn wgsl_type(module: &naga::Module, ty: Handle<naga::Type>) -> Option<String> {
    let scalar = |s: naga::Scalar| match (s.kind, s.width) {
        (ScalarKind::Float, 4) => Some("f32"),
        (ScalarKind::Sint, 4) => Some("i32"),
        (ScalarKind::Uint, 4) => Some("u32"),
        (ScalarKind::Bool, _) => Some("bool"),
        _ => None,
    };
    match module.types[ty].inner {
        TypeInner::Scalar(s) => scalar(s).map(String::from),
        TypeInner::Vector { size, scalar: s } => scalar(s).map(|n| format!("vec{}<{}>", size as u8, n)),
        _ => None,
    }
}

/// The scalars of a value of type `ty` named `name` (WGSL expressions) and
/// whether they are floats, in the order transform feedback writes them
fn scalars(module: &naga::Module, ty: Handle<naga::Type>, name: &str, out: &mut Vec<(String, ScalarKind)>) -> bool {
    match module.types[ty].inner {
        TypeInner::Scalar(s) => {
            out.push((String::from(name), s.kind));
            true
        },
        TypeInner::Vector { size, scalar } => {
            for i in 0..size as usize {
                out.push((format!("{}[{}]", name, i), scalar.kind));
            }
            true
        },
        TypeInner::Matrix { columns, rows, scalar } => {
            for c in 0..columns as usize {
                for r in 0..rows as usize {
                    out.push((format!("{}[{}][{}]", name, c, r), scalar.kind));
                }
            }
            true
        },
        TypeInner::Array { base, size: naga::ArraySize::Constant(n), .. } => {
            (0..n.get()).all(|i| scalars(module, base, &format!("{}[{}]", name, i), out))
        },
        _ => false,
    }
}

/// A vertex format's WGSL decoding of the attribute at byte address `a` of
/// slot `s` into `ty`: (components, bytes each, kind); kinds: f float, n
/// unorm, s snorm, u uint, i sint, U uscaled, S sscaled
fn format_info(format: u32) -> Option<(u32, u32, char)> {
    Some(match format {
        // 8-bit: R8 9-15, R8G8 16-22, R8G8B8 23-29, R8G8B8A8 37-43 (UNORM, SNORM, USCALED, SSCALED, UINT, SINT, SRGB)
        9..=14 => (1, 1, ['n', 's', 'U', 'S', 'u', 'i'][(format - 9) as usize]),
        16..=21 => (2, 1, ['n', 's', 'U', 'S', 'u', 'i'][(format - 16) as usize]),
        23..=28 => (3, 1, ['n', 's', 'U', 'S', 'u', 'i'][(format - 23) as usize]),
        37..=42 => (4, 1, ['n', 's', 'U', 'S', 'u', 'i'][(format - 37) as usize]),
        // 16-bit: R16 70-76, R16G16 77-83, R16G16B16 84-90, R16G16B16A16 91-97 (UNORM, SNORM, USCALED, SSCALED, UINT, SINT, SFLOAT)
        70..=76 => (1, 2, ['n', 's', 'U', 'S', 'u', 'i', 'h'][(format - 70) as usize]),
        77..=83 => (2, 2, ['n', 's', 'U', 'S', 'u', 'i', 'h'][(format - 77) as usize]),
        84..=90 => (3, 2, ['n', 's', 'U', 'S', 'u', 'i', 'h'][(format - 84) as usize]),
        91..=97 => (4, 2, ['n', 's', 'U', 'S', 'u', 'i', 'h'][(format - 91) as usize]),
        // 32-bit: R32 98-100, R32G32 101-103, R32G32B32 104-106, R32G32B32A32 107-109 (UINT, SINT, SFLOAT)
        98..=100 => (1, 4, ['u', 'i', 'f'][(format - 98) as usize]),
        101..=103 => (2, 4, ['u', 'i', 'f'][(format - 101) as usize]),
        104..=106 => (3, 4, ['u', 'i', 'f'][(format - 104) as usize]),
        107..=109 => (4, 4, ['u', 'i', 'f'][(format - 107) as usize]),
        _ => return None,
    })
}

/// One component of a format (a WGSL f32, i32 or u32 expression, as the kind
/// gives) at the byte address in `a` of vertex buffer slot `s`
fn component(s: u32, a: &str, bytes: u32, kind: char) -> String {
    let raw = match bytes {
        1 => format!("vx_byte{}({})", s, a),
        2 => format!("(vx_byte{s}({a}) | (vx_byte{s}({a} + 1u) << 8u))"),
        _ => format!("vx_word{}({})", s, a),
    };
    let bits = bytes * 8;
    // (WGSL chains no shifts, and mixes them with nothing unparenthesized)
    let signed = format!("((i32({}) << {}u) >> {}u)", raw, 32 - bits, 32 - bits);
    match kind {
        'f' => format!("bitcast<f32>({})", raw),
        'h' => format!("unpack2x16float({}).x", raw),
        'n' => format!("(f32({}) / {}.0)", raw, (1u64 << bits) - 1),
        's' => format!("max(f32({}) / {}.0, -1.0)", signed, (1u64 << (bits - 1)) - 1),
        'U' => format!("f32({})", raw),
        'S' => format!("f32({})", signed),
        'u' => raw,
        _ => if bits == 32 { format!("bitcast<i32>({})", raw) } else { signed },
    }
}

/// The components of a value of type `ty` named `name` from `location`, a
/// location each scalar, vector or matrix column: (expression, kind,
/// location, component); how many locations they take
fn location_scalars(module: &naga::Module, ty: Handle<naga::Type>, name: &str, location: u32, out: &mut Vec<(String, ScalarKind, u32, u32)>) -> Option<u32> {
    match module.types[ty].inner {
        TypeInner::Scalar(s) => {
            out.push((String::from(name), s.kind, location, 0));
            Some(1)
        },
        TypeInner::Vector { size, scalar } => {
            for i in 0..size as u32 {
                out.push((format!("{}[{}]", name, i), scalar.kind, location, i));
            }
            Some(1)
        },
        TypeInner::Matrix { columns, rows, scalar } => {
            for c in 0..columns as u32 {
                for r in 0..rows as u32 {
                    out.push((format!("{}[{}][{}]", name, c, r), scalar.kind, location + c, r));
                }
            }
            Some(columns as u32)
        },
        TypeInner::Array { base, size: naga::ArraySize::Constant(n), .. } => {
            let mut used = 0;
            for i in 0..n.get() {
                used += location_scalars(module, base, &format!("{}[{}]", name, i), location + used, out)?;
            }
            Some(used)
        },
        _ => None,
    }
}

/// The compute shader for a vertex shader that captures (naga's module of
/// it, its SPIR-V's captures and strides), with the pipeline's vertex input;
/// the WGSL to append to the module's own (which `module` becomes) and the
/// buffers' strides. `all`: every output captured into buffer 0 instead, a
/// record a vertex as a geometry shader reads it (geometry.rs: the position
/// at word 0, the point size at 4, location l at 8 + 4l)
pub fn compute_shader(module: &mut naga::Module, captures: &[Capture], strides: [u32; 4], attributes: &[Attribute], slots: &[Slot], group: u32,
    all: bool) -> Result<(String, [u32; 4]), String> {
    let entry = module.entry_points.iter().position(|e| e.stage == naga::ShaderStage::Vertex).ok_or("no vertex entry point")?;
    // the entry point's copy, an ordinary function
    let mut function = module.entry_points[entry].function.clone();
    function.name = Some(String::from("vx_vs"));
    let arguments: Vec<(Option<Binding>, Handle<naga::Type>)> = function.arguments.iter().map(|a| (a.binding.clone(), a.ty)).collect();
    for argument in function.arguments.iter_mut() {
        argument.binding = None;
    }
    let result = function.result.clone().ok_or("the vertex shader has no outputs")?;
    // the output struct's members; the copy's own struct of them, named, and
    // without bindings (an ordinary struct: gl_PointSize too, which WGSL's
    // entry points cannot have)
    let (members, span) = match &module.types[result.ty].inner {
        TypeInner::Struct { members, span } => (members.clone(), *span),
        _ => return Err(String::from("the vertex shader's output is not a struct")),
    };
    let plain: Vec<naga::StructMember> = members.iter().enumerate().map(|(i, m)| naga::StructMember {
        // (not ending in a digit: naga's namer would add an underscore)
        name: Some(format!("vx_o{}m", i)),
        ty: m.ty,
        binding: None,
        offset: m.offset,
    }).collect();
    let plain = module.types.insert(naga::Type { name: Some(String::from("VxVertexOut")), inner: TypeInner::Struct { members: plain, span } },
        naga::Span::UNDEFINED);
    crate::retype(&mut function, result.ty, plain, None);
    module.functions.append(function, naga::Span::UNDEFINED);

    let mut wgsl = String::new();
    wgsl.push_str("\nstruct VxXfbParams { first_vertex: u32, vertex_count: u32, first_instance: u32, instance_count: u32, first_capture: u32, \
        limit: u32, pad1: u32, pad2: u32, offsets: vec4<u32>, vb: array<vec4<u32>, 2> }\n");
    wgsl.push_str(&format!("@group({}) @binding(960) var<uniform> vx_xfb_p: VxXfbParams;\n", group));
    let mut used_slots: Vec<u32> = attributes.iter().map(|a| a.slot).collect();
    used_slots.sort_unstable();
    used_slots.dedup();
    for &s in &used_slots {
        wgsl.push_str(&format!("@group({g}) @binding({b}) var<storage, read> vx_vb{s}: array<u32>;\n\
            fn vx_word{s}(a: u32) -> u32 {{ let w = a >> 2u; let k = (a & 3u) * 8u; if (k == 0u) {{ return vx_vb{s}[w]; }} \
            return (vx_vb{s}[w] >> k) | (vx_vb{s}[w + 1u] << (32u - k)); }}\n\
            fn vx_byte{s}(a: u32) -> u32 {{ return (vx_vb{s}[a >> 2u] >> ((a & 3u) * 8u)) & 0xFFu; }}\n",
            g = group, b = 961 + s, s = s));
    }
    let mut used_buffers: Vec<u32> = if all { vec![0] } else { captures.iter().map(|c| c.buffer).collect() };
    used_buffers.sort_unstable();
    used_buffers.dedup();
    for &b in &used_buffers {
        wgsl.push_str(&format!("@group({}) @binding({}) var<storage, read_write> vx_xfb{}: array<u32>;\n", group, 970 + b, b));
    }
    wgsl.push_str("@compute @workgroup_size(64) fn vx_xfb(@builtin(global_invocation_id) id: vec3<u32>) {\n\
        let n = id.x;\n\
        if (n >= vx_xfb_p.limit) { return; }\n\
        let vertex = vx_xfb_p.first_vertex + n % vx_xfb_p.vertex_count;\n\
        let instance = vx_xfb_p.first_instance + n / vx_xfb_p.vertex_count;\n");
    let mut call = Vec::new();
    for (i, (binding, ty)) in arguments.iter().enumerate() {
        let wgsl_ty = wgsl_type(module, *ty).ok_or("a vertex input of a type not done")?;
        let value = match binding {
            Some(Binding::BuiltIn(BuiltIn::VertexIndex)) => format!("{}(vertex)", wgsl_ty),
            Some(Binding::BuiltIn(BuiltIn::InstanceIndex)) => format!("{}(instance)", wgsl_ty),
            Some(Binding::Location { location, .. }) => {
                let a = attributes.iter().find(|a| a.location == *location).ok_or("a vertex input without an attribute")?;
                let slot = slots.iter().find(|s| s.slot == a.slot).ok_or("an attribute without its buffer")?;
                let (count, bytes, kind) = format_info(a.format).ok_or_else(|| format!("vertex format {} not done", a.format))?;
                wgsl.push_str(&format!("    let a{i} = vx_xfb_p.vb[{}][{}] + {} * {}u + {}u;\n", a.slot / 4, a.slot % 4,
                    if slot.instance { "instance" } else { "vertex" }, slot.stride, a.offset));
                let parts: Vec<String> = (0..count).map(|k| component(a.slot, &format!("a{} + {}u", i, k * bytes), bytes, kind)).collect();
                // (the input's type: as many components as it has, the format's missing ones 0, 0, 0, 1)
                let (size, scalar) = match module.types[*ty].inner {
                    TypeInner::Scalar(s) => (1, s),
                    TypeInner::Vector { size, scalar } => (size as u32, scalar),
                    _ => return Err(String::from("a vertex input of a type not done")),
                };
                let base = wgsl_type(module, module.types.iter().find(|(_, t)| t.inner == TypeInner::Scalar(scalar)).map(|(h, _)| h)
                    .unwrap_or(*ty)).unwrap_or_else(|| String::from("f32"));
                let one = if scalar.kind == ScalarKind::Float { "1.0" } else { "1" };
                let values: Vec<String> = (0..size).map(|k| if k < count { format!("{}({})", base, parts[k as usize]) }
                    else if k == 3 { format!("{}({})", base, one) } else { format!("{}(0)", base) }).collect();
                if size == 1 { values[0].clone() } else { format!("{}({})", wgsl_ty, values.join(", ")) }
            },
            _ => return Err(String::from("a vertex input not done")),
        };
        wgsl.push_str(&format!("    let v{} = {};\n", i, value));
        call.push(format!("v{}", i));
    }
    wgsl.push_str(&format!("    let o = vx_vs({});\n    let at = vx_xfb_p.first_capture + n;\n", call.join(", ")));
    if all {
        // (each output's words: as geometry.rs reads them)
        let mut writes: Vec<(String, ScalarKind, u32)> = Vec::new();
        let mut last = 0u32;
        for (i, m) in members.iter().enumerate() {
            let name = format!("o.vx_o{}m", i);
            match m.binding {
                Some(Binding::BuiltIn(BuiltIn::Position { .. })) => {
                    for k in 0..4 {
                        writes.push((format!("{}[{}]", name, k), ScalarKind::Float, k));
                    }
                },
                Some(Binding::BuiltIn(BuiltIn::PointSize)) => writes.push((name, ScalarKind::Float, 4)),
                Some(Binding::Location { location, .. }) => {
                    let mut parts = Vec::new();
                    let used = location_scalars(module, m.ty, &name, location, &mut parts).ok_or("an output of a type not done")?;
                    last = last.max(location + used);
                    for (expr, kind, l, k) in parts {
                        writes.push((expr, kind, 8 + 4 * l + k));
                    }
                },
                _ => {},
            }
        }
        let stride = 4 * (8 + 4 * last);
        for (expr, kind, word) in writes {
            let value = if kind == ScalarKind::Uint { expr } else { format!("bitcast<u32>({})", expr) };
            wgsl.push_str(&format!("    vx_xfb0[vx_xfb_p.offsets[0] / 4u + at * {}u + {}u] = {};\n", stride / 4, word, value));
        }
        wgsl.push_str("}\n");
        return Ok((wgsl, [stride, 0, 0, 0]));
    }
    for c in captures {
        let member = members.iter().position(|m| match (&m.binding, c.output) {
            (Some(Binding::Location { location, .. }), Output::Location(l)) => *location == l,
            (Some(Binding::BuiltIn(BuiltIn::Position { .. })), Output::Position) => true,
            (Some(Binding::BuiltIn(BuiltIn::PointSize)), Output::PointSize) => true,
            _ => false,
        }).ok_or("a captured output the shader does not write")?;
        let mut parts = Vec::new();
        if !scalars(module, members[member].ty, &format!("o.vx_o{}m", member), &mut parts) {
            return Err(String::from("a captured output of a type not done"));
        }
        let stride = strides[c.buffer as usize & 3];
        for (k, (expr, kind)) in parts.iter().enumerate() {
            let value = if *kind == ScalarKind::Uint { expr.clone() } else { format!("bitcast<u32>({})", expr) };
            wgsl.push_str(&format!("    vx_xfb{b}[(vx_xfb_p.offsets[{b}] + at * {stride}u + {off}u) / 4u] = {v};\n",
                b = c.buffer, stride = stride, off = c.offset + 4 * k as u32, v = value));
        }
    }
    wgsl.push_str("}\n");
    let _ = VectorSize::Bi;
    Ok((wgsl, strides))
}
