//! SPIR-V to WGSL for VX, the renderer of virtio-gpu's Venus contexts
//! (src/browser/glbridge/vx/vx_executor.js), with naga. Built to
//! build/glbridge/vx_naga.wasm by tools/build_glbridge.mjs.
//!
//! What it changes on the way:
//! - combined image samplers become an image and a sampler (split.rs)
//! - NaN and infinity tests become bit tests (relational.rs: WGSL has none)
//! - samples of integer images become fetches (intsample.rs: WGSL samples
//!   float textures only)
//! - input attachments become textures read at the fragment's position
//!   (subpass.rs)
//! - matrices of laid out blocks naga cannot read (std140's 2-row ones, row
//!   major ones) become arrays of vectors (layout.rs)
//! - entry point inputs and outputs of matrices, arrays and structs at a
//!   location become their vectors at consecutive locations (io.rs)
//! - an array image's size has its layer count (layers.rs: naga's SPIR-V
//!   front end leaves it out)
//! - outer products become matrices of columns, modf's and frexp's results
//!   naga's special types (math.rs)
//! - switch cases that fall through get the next ones' statements (switches.rs)
//! - bindings: Vulkan's binding b of a set is WGSL's binding 2b of the same
//!   group, and 2b + 1 for the sampler of a combined image sampler; a
//!   descriptor array of blocks becomes a block each (blockarrays.rs), its
//!   element e > 0 at 300 + 12b + e
//! - push constants (naga's immediates) become a read-only storage buffer
//!   at the group and binding the caller says
//! - uniform buffers whose layout WGSL's uniform rules refuse are storage too,
//!   and so are those the caller names (a stage has 12 uniform buffers in
//!   WebGPU, Vulkan's devices report more: the rest are read-only storage)
//! - Y of the position is flipped (naga's default for SPIR-V: Vulkan's
//!   clip space has Y down, WebGPU's up)
//! - a vertex shader's gl_PointSize is dropped (WGSL has none: WebGPU's
//!   points are one pixel); a capturing draw's compute shader keeps it
//!
//! It answers in JSON: the WGSL, and per entry point the bindings it uses
//! and their kind; the overrides (specialization constants) by id.

extern crate alloc;

mod intsample;
mod io;
mod layers;
mod layout;
mod math;
mod relational;
mod remap;
mod blockarrays;
mod cubes;
mod fetches;
mod depth;
mod split;
mod subpass;
mod switches;
pub mod xfb;

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use naga::{AddressSpace, ImageClass, ImageDimension, ResourceBinding, ShaderStage, StorageAccess, TypeInner};

pub use split::SAMPLER_BINDING;

/// Where push constants go; whether Vulkan's clip space stays as it is
pub struct Options {
    pub immediates_group: u32,
    pub immediates_binding: u32,
    /// (WebGPU's y is Vulkan's flipped, and naga flips the vertex position
    /// to make up for it; a draw with a viewport of a negative height,
    /// Vulkan's own flip, which WebGPU's viewports cannot do, keeps it as
    /// it is: ANGLE draws GL's frames so)
    pub keep_coordinate_space: bool,
    /// The uniform buffers to make read-only storage buffers, by their
    /// group and WGSL binding, `group << 16 | binding`
    pub storage_uniforms: Vec<u32>,
    /// a fragment shader's depth output dropped (a pipeline with no depth
    /// attachment); a vertex shader's depth reversed (a viewport with its
    /// depths reversed): depth.rs
    pub drop_frag_depth: bool,
    pub reverse_depth: bool,
    /// The address modes of the samplers of integer images (whose samples
    /// are fetches, intsample.rs), by their group and WGSL binding
    /// (`group << 16 | binding`): VkSamplerAddressMode u | v << 4 | w << 8;
    /// clamp to edge for the others
    pub int_wraps: Vec<(u32, u32)>,
}

fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A resource's kind, as the bind groups need it
fn kind(module: &naga::Module, var: &naga::GlobalVariable) -> &'static str {
    match var.space {
        AddressSpace::Uniform => "uniform",
        AddressSpace::Storage { access } => if access.contains(StorageAccess::STORE) { "storage-rw" } else { "storage" },
        AddressSpace::Handle => match module.types[var.ty].inner {
            TypeInner::Sampler { comparison } => if comparison { "sampler-comparison" } else { "sampler" },
            TypeInner::Image { class, dim, .. } => match class {
                ImageClass::Storage { .. } => "storage-texture",
                ImageClass::Depth { multi: true } => "texture-depth-ms",
                ImageClass::Depth { .. } => "texture-depth",
                ImageClass::Sampled { multi: true, .. } => "texture-ms",
                // (an integer cube's faces, cubes.rs)
                ImageClass::Sampled { kind, .. } if var.name.as_deref() == Some(cubes::FACES) => match kind {
                    naga::ScalarKind::Uint => "texture-uint-faces",
                    _ => "texture-sint-faces",
                },
                ImageClass::Sampled { kind, .. } => match kind {
                    naga::ScalarKind::Uint => "texture-uint",
                    naga::ScalarKind::Sint => "texture-sint",
                    _ => if dim == ImageDimension::D1 { "texture-1d" } else { "texture" },
                },
                _ => "texture",
            },
            _ => "other",
        },
        _ => "other",
    }
}

/// WGSL's binding of a SPIR-V binding: Vulkan's b is 2b, a split sampler's
/// 2b + 1; element e > 0 of a descriptor array (blockarrays.rs) is
/// ELEMENTS + 2 (16b + e), its split sampler's one more (vx_executor.js's
/// descriptorKey reads them back)
pub(crate) fn wgsl_binding(binding: u32) -> u32 {
    if binding >= blockarrays::ELEMENT_BINDING + SAMPLER_BINDING {
        ELEMENTS + (binding - blockarrays::ELEMENT_BINDING - SAMPLER_BINDING) * 2 + 1
    }
    else if binding >= blockarrays::ELEMENT_BINDING {
        ELEMENTS + (binding - blockarrays::ELEMENT_BINDING) * 2
    }
    else if binding >= SAMPLER_BINDING {
        (binding - SAMPLER_BINDING) * 2 + 1
    }
    else {
        binding * 2
    }
}

const ELEMENTS: u32 = 300;

fn rebind(module: &mut naga::Module, options: &Options) {
    for (_, var) in module.global_variables.iter_mut() {
        if let (AddressSpace::Uniform, Some(b)) = (var.space, var.binding.as_ref()) {
            if options.storage_uniforms.contains(&(b.group << 16 | wgsl_binding(b.binding))) {
                var.space = AddressSpace::Storage { access: StorageAccess::LOAD };
            }
        }
        if matches!(var.space, AddressSpace::Immediate) {
            var.space = AddressSpace::Storage { access: StorageAccess::LOAD };
            var.binding = Some(ResourceBinding { group: options.immediates_group, binding: options.immediates_binding });
            continue;
        }
        if let Some(b) = var.binding.as_mut() {
            b.binding = wgsl_binding(b.binding);
        }
    }
}

/// Function `f`'s values of struct type `from` made of `to` instead: its
/// result, and its Compose (of the members `keep` says) and ZeroValue
/// expressions
pub(crate) fn retype(f: &mut naga::Function, from: naga::Handle<naga::Type>, to: naga::Handle<naga::Type>, keep: Option<&[bool]>) {
    if let Some(r) = f.result.as_mut() {
        if r.ty == from {
            r.ty = to;
        }
    }
    for (_, e) in f.expressions.iter_mut() {
        match e {
            naga::Expression::Compose { ty, components } if *ty == from => {
                *ty = to;
                if let Some(keep) = keep {
                    let mut i = 0;
                    components.retain(|_| {
                        i += 1;
                        keep.get(i - 1).copied().unwrap_or(true)
                    });
                }
            },
            naga::Expression::ZeroValue(ty) if *ty == from => *ty = to,
            _ => {},
        }
    }
}

/// The vertex entry points' gl_PointSize outputs dropped: each result a new
/// struct without them, and the structs that keep them (gl_PerVertex's, a
/// private global's, the old results: naga may have made them one type)
/// unbound, since naga's WGSL writes every struct
fn drop_point_size(module: &mut naga::Module) {
    let point_size = |m: &naga::StructMember| matches!(m.binding, Some(naga::Binding::BuiltIn(naga::BuiltIn::PointSize)));
    for ep in module.entry_points.iter_mut() {
        if ep.stage != ShaderStage::Vertex {
            continue;
        }
        let Some(old) = ep.function.result.as_ref().map(|r| r.ty) else { continue };
        let (members, span) = match &module.types[old].inner {
            TypeInner::Struct { members, span } => (members.clone(), *span),
            _ => continue,
        };
        let keep: Vec<bool> = members.iter().map(|m| !point_size(m)).collect();
        if keep.iter().all(|k| *k) {
            continue;
        }
        let kept = members.into_iter().zip(&keep).filter(|(_, k)| **k).map(|(m, _)| m).collect();
        let new = module.types.insert(naga::Type { name: Some(String::from("VxVertexOutput")), inner: TypeInner::Struct { members: kept, span } },
            naga::Span::UNDEFINED);
        retype(&mut ep.function, old, new, Some(&keep));
    }
    let results: Vec<naga::Handle<naga::Type>> = module.entry_points.iter().filter_map(|ep| ep.function.result.as_ref().map(|r| r.ty)).collect();
    let unbind: Vec<naga::Handle<naga::Type>> = module.types.iter().filter(|(handle, ty)| !results.contains(handle) && match &ty.inner {
        TypeInner::Struct { members, .. } => members.iter().any(point_size),
        _ => false,
    }).map(|(handle, _)| handle).collect();
    for handle in unbind {
        let mut ty = module.types[handle].clone();
        if let TypeInner::Struct { members, .. } = &mut ty.inner {
            for m in members.iter_mut() {
                if point_size(m) {
                    m.binding = None;
                }
            }
        }
        module.types.replace(handle, ty);
    }
}

fn validate(module: &naga::Module) -> Result<naga::valid::ModuleInfo, String> {
    naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all())
        .validate(module)
        .map_err(|e| format!("{:?}", e.into_inner()))
}

/// VX's passes on the SPIR-V, in order; VX_SKIP (a list of their names, in
/// a native build's environment: debugging) leaves some out
/// (`wraps`: the address modes of integer images' samplers, intsample.rs;
/// `sampled`: the integer images it made fetches of)
fn passes(words: &[u32], wraps: &[(u32, u32)], sampled: &mut Vec<u32>) -> Vec<u32> {
    let skip = std::env::var("VX_SKIP").unwrap_or_default();
    let list: [(&str, fn(&[u32]) -> Vec<u32>); 7] = [("blockarrays", blockarrays::lower), ("split", split::split), ("coordinates", intsample::coordinate_types), ("subpass", subpass::lower),
        ("relational", relational::lower), ("fetches", fetches::lower), ("layout", layout::lower)];
    let mut words = words.to_vec();
    for (name, pass) in list {
        // (intsample after subpass)
        if name == "relational" && !skip.split(',').any(|s| s == "intsample") {
            words = intsample::lower(&words, wraps, sampled);
        }
        if !skip.split(',').any(|s| s == name) {
            words = pass(&words);
        }
    }
    words
}

/// The module naga reads of SPIR-V (bytes), after VX's passes on the SPIR-V
/// (examples/dump.rs)
pub fn parse_for_debugging(bytes: &[u8]) -> Result<naga::Module, String> {
    let words: Vec<u32> = bytes.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let words = passes(&words, &[], &mut Vec::new());
    let data: Vec<u8> = xfb::strip(&words).iter().flat_map(|w| w.to_le_bytes()).collect();
    let spv = naga::front::spv::Options { adjust_coordinate_space: true, strict_capabilities: false, block_ctx_dump_prefix: None };
    naga::front::spv::parse_u8_slice(&data, &spv).map_err(|e| format!("SPIR-V: {:?}", e))
}

/// The SPIR-V (bytes) after VX's passes on it (examples/dump.rs)
pub fn passes_for_debugging(bytes: &[u8]) -> Vec<u8> {
    let words: Vec<u32> = bytes.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    passes(&words, &[], &mut Vec::new()).iter().flat_map(|w| w.to_le_bytes()).collect()
}

/// SPIR-V (bytes) to the JSON answer
pub fn translate(bytes: &[u8], options: &Options) -> Result<String, String> { translate_with(bytes, options, None) }

/// What a capturing draw's compute shader needs (xfb.rs): the pipeline's
/// vertex input and the group of its own resources
pub struct XfbInput {
    pub attributes: Vec<xfb::Attribute>,
    pub slots: Vec<xfb::Slot>,
    pub group: u32,
}

/// The compute shader of a capturing draw (vx_translate_xfb), as JSON
pub fn translate_xfb(bytes: &[u8], options: &Options, input: &XfbInput) -> Result<String, String> { translate_with(bytes, options, Some(input)) }

fn translate_with(bytes: &[u8], options: &Options, xfb_input: Option<&XfbInput>) -> Result<String, String> {
    if bytes.len() % 4 != 0 || bytes.len() < 20 {
        return Err(String::from("not SPIR-V: not whole words"));
    }
    let words: Vec<u32> = bytes.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let mut sampled = Vec::new();
    let words = passes(&words, &options.int_wraps, &mut sampled);
    // (transform feedback's: read by xfb::captures, naga refuses them)
    let data: Vec<u8> = xfb::strip(&words).iter().flat_map(|w| w.to_le_bytes()).collect();
    let spv = naga::front::spv::Options { adjust_coordinate_space: !options.keep_coordinate_space, strict_capabilities: false, block_ctx_dump_prefix: None };
    let mut module = naga::front::spv::parse_u8_slice(&data, &spv).map_err(|e| format!("SPIR-V: {:?}", e))?;
    layers::lower(&mut module);
    cubes::lower(&mut module);
    math::lower(&mut module);
    switches::lower(&mut module);
    rebind(&mut module, options);
    // (transform feedback: the compute shader of a capturing draw, xfb.rs)
    let mut appended = String::new();
    let mut capture_json = String::new();
    if let Some(input) = xfb_input {
        let (captures, strides) = xfb::captures(&words).ok_or("the vertex shader captures nothing")?;
        appended = xfb::compute_shader(&mut module, &captures, strides, &input.attributes, &input.slots, input.group)?;
        let mut buffers: Vec<u32> = captures.iter().map(|c| c.buffer).collect();
        buffers.sort_unstable();
        buffers.dedup();
        capture_json = format!(",\"xfb\":{{\"strides\":[{},{},{},{}],\"buffers\":{:?},\"slots\":{:?}}}", strides[0], strides[1], strides[2], strides[3],
            buffers, { let mut s: Vec<u32> = input.attributes.iter().map(|a| a.slot).collect(); s.sort_unstable(); s.dedup(); s });
    }
    else if xfb::captures(&words).is_some() {
        capture_json = String::from(",\"captures\":true");
    }
    drop_point_size(&mut module);
    io::flatten(&mut module)?;
    if options.drop_frag_depth {
        depth::drop_frag_depth(&mut module);
    }
    if options.reverse_depth {
        depth::reverse_depth(&mut module);
    }
    let info = match validate(&module) {
        Ok(info) => info,
        Err(first) => {
            // uniform buffers of a layout WGSL's uniforms refuse: as storage
            for (_, var) in module.global_variables.iter_mut() {
                if matches!(var.space, AddressSpace::Uniform) {
                    var.space = AddressSpace::Storage { access: StorageAccess::LOAD };
                }
            }
            validate(&module).map_err(|_| first)?
        }
    };
    // the types nothing uses any more (the arrays blockarrays.rs split, the
    // structs io.rs flattened) gone: naga's WGSL writer writes every type,
    // and enables binding arrays when one is among them
    let _ = info;
    naga::compact::compact(&mut module, naga::compact::KeepUnused::Yes);
    let info = validate(&module)?;
    let mut wgsl = naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty())
        .map_err(|e| format!("WGSL: {:?}", e))?;
    wgsl.push_str(&appended);

    let mut layouter = naga::proc::Layouter::default();
    let laid = layouter.update(module.to_ctx()).is_ok();
    let mut json = String::from("{\"wgsl\":");
    json.push_str(&quote(&wgsl));
    json.push_str(",\"entries\":[");
    for (index, entry) in module.entry_points.iter().enumerate() {
        if index > 0 { json.push(','); }
        let stage = match entry.stage {
            ShaderStage::Vertex => "vertex",
            ShaderStage::Fragment => "fragment",
            ShaderStage::Compute => "compute",
            _ => "other",
        };
        // (a vertex shader's outputs flat shaded: the provoking vertex matters, vx_executor.js's provokingLast)
        let flat_binding = |b: &Option<naga::Binding>| matches!(b, Some(naga::Binding::Location { interpolation: Some(naga::Interpolation::Flat), .. }));
        let flat = entry.function.result.as_ref().is_some_and(|r| flat_binding(&r.binding) || match &module.types[r.ty].inner {
            TypeInner::Struct { members, .. } => members.iter().any(|m| flat_binding(&m.binding)),
            _ => false,
        });
        json.push_str(&format!("{{\"name\":{},\"stage\":\"{}\",\"workgroup\":[{},{},{}],\"flat\":{},\"bindings\":[",
            quote(&entry.name), stage, entry.workgroup_size[0], entry.workgroup_size[1], entry.workgroup_size[2], flat));
        let uses = info.get_entry_point(index);
        let mut first = true;
        for (handle, var) in module.global_variables.iter() {
            let Some(binding) = var.binding else { continue };
            if uses[handle].is_empty() { continue; }
            if !first { json.push(','); }
            first = false;
            // (a buffer's: the size WebGPU wants bound at least, its type's: one element of a runtime array)
            let size = match var.space {
                AddressSpace::Uniform | AddressSpace::Storage { .. } if laid => layouter[var.ty].size,
                _ => 0,
            };
            json.push_str(&format!("[{},{},\"{}\",{}]", binding.group, binding.binding, kind(&module, var), size));
        }
        json.push_str("]}");
    }
    json.push_str("],\"overrides\":[");
    let mut first = true;
    for (_, o) in module.overrides.iter() {
        let Some(id) = o.id else { continue };
        let ty = match module.types[o.ty].inner {
            TypeInner::Scalar(s) => match s.kind {
                naga::ScalarKind::Bool => "bool",
                naga::ScalarKind::Sint => "i32",
                naga::ScalarKind::Uint => "u32",
                _ => "f32",
            },
            _ => "other",
        };
        if !first { json.push(','); }
        first = false;
        json.push_str(&format!("[{},\"{}\"]", id, ty));
    }
    json.push(']');
    // (the integer images whose samples are fetches: their samplers' address modes matter, int_wraps)
    sampled.sort_unstable();
    sampled.dedup();
    json.push_str(&format!(",\"intsamples\":{:?}", sampled));
    json.push_str(&capture_json);
    json.push('}');
    Ok(json)
}

// ---------------------------------------------------------------------------
// The wasm interface: the caller copies SPIR-V into memory it got from
// vx_alloc, calls vx_translate, reads the answer (a length, then UTF-8 JSON)
// and frees both with vx_free

#[no_mangle]
pub extern "C" fn vx_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` as vx_alloc gave them
#[no_mangle]
pub unsafe extern "C" fn vx_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

/// The compute shader of a capturing draw (xfb.rs) for the vertex shader in
/// `ptr` (`len` bytes, translated as vx_translate does with Vulkan's clip
/// space kept): `input` holds `input_count` words: the group, the attribute
/// count, each attribute's location, slot, VkFormat and offset, the slot
/// count, each slot's slot, stride and input rate
///
/// # Safety
/// as vx_translate's
#[no_mangle]
pub unsafe extern "C" fn vx_translate_xfb(ptr: *const u8, len: usize, immediates_group: u32, immediates_binding: u32,
    storage: *const u32, storage_count: usize, input: *const u32, input_count: usize) -> *mut u8 {
    let bytes = core::slice::from_raw_parts(ptr, len);
    let storage_uniforms = if storage.is_null() || storage_count == 0 { Vec::new() } else { core::slice::from_raw_parts(storage, storage_count).to_vec() };
    let w = core::slice::from_raw_parts(input, input_count);
    let mut at = 0;
    let mut next = || { let v = w.get(at).copied().unwrap_or(0); at += 1; v };
    let group = next();
    let attributes = (0..next()).map(|_| xfb::Attribute { location: next(), slot: next(), format: next(), offset: next() }).collect();
    let slots = (0..next()).map(|_| xfb::Slot { slot: next(), stride: next(), instance: next() != 0 }).collect();
    let options = Options { immediates_group, immediates_binding, keep_coordinate_space: true, storage_uniforms, drop_frag_depth: false, reverse_depth: false,
        int_wraps: Vec::new() };
    let answer = match translate_with(bytes, &options, Some(&XfbInput { attributes, slots, group })) {
        Ok(json) => json,
        Err(error) => format!("{{\"error\":{}}}", quote(&error)),
    };
    let out = vx_alloc(answer.len() + 4);
    core::ptr::copy_nonoverlapping((answer.len() as u32).to_le_bytes().as_ptr(), out, 4);
    core::ptr::copy_nonoverlapping(answer.as_ptr(), out.add(4), answer.len());
    out
}

/// # Safety
/// `ptr` holds `len` bytes; `flags` bit 0: keep Vulkan's clip space (Options);
/// `storage` holds `storage_count` words, the uniform buffers to make
/// storage (Options::storage_uniforms; null when none)
#[no_mangle]
pub unsafe extern "C" fn vx_translate(ptr: *const u8, len: usize, immediates_group: u32, immediates_binding: u32, flags: u32,
    storage: *const u32, storage_count: usize, wraps: *const u32, wrap_count: usize) -> *mut u8 {
    let bytes = core::slice::from_raw_parts(ptr, len);
    let storage_uniforms = if storage.is_null() || storage_count == 0 { Vec::new() } else { core::slice::from_raw_parts(storage, storage_count).to_vec() };
    // (pairs: the image's group << 16 | binding, its address modes)
    let int_wraps = if wraps.is_null() || wrap_count == 0 { Vec::new() } else {
        core::slice::from_raw_parts(wraps, wrap_count * 2).chunks_exact(2).map(|p| (p[0], p[1])).collect()
    };
    let options = Options { immediates_group, immediates_binding, keep_coordinate_space: flags & 1 != 0, storage_uniforms,
        drop_frag_depth: flags & 2 != 0, reverse_depth: flags & 4 != 0, int_wraps };
    let answer = match translate(bytes, &options) {
        Ok(json) => json,
        Err(error) => format!("{{\"error\":{}}}", quote(&error)),
    };
    let out = vx_alloc(answer.len() + 4);
    core::ptr::copy_nonoverlapping((answer.len() as u32).to_le_bytes().as_ptr(), out, 4);
    core::ptr::copy_nonoverlapping(answer.as_ptr(), out.add(4), answer.len());
    out
}
