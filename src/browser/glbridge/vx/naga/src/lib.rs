//! SPIR-V to WGSL for VX, the renderer of virtio-gpu's Venus contexts
//! (src/browser/glbridge/vx/vx_executor.js), with naga. Built to
//! build/glbridge/vx_naga.wasm by tools/build_glbridge.mjs.
//!
//! What it changes on the way:
//! - combined image samplers become an image and a sampler (split.rs)
//! - bindings: Vulkan's binding b of a set is WGSL's binding 2b of the same
//!   group, and 2b + 1 for the sampler of a combined image sampler
//! - push constants (naga's immediates) become a read-only storage buffer
//!   at the group and binding the caller says
//! - uniform buffers whose layout WGSL's uniform rules refuse are storage too
//! - Y of the position is flipped (naga's default for SPIR-V: Vulkan's
//!   clip space has Y down, WebGPU's up)
//!
//! It answers in JSON: the WGSL, and per entry point the bindings it uses
//! and their kind; the overrides (specialization constants) by id.

extern crate alloc;

mod split;

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

fn rebind(module: &mut naga::Module, options: &Options) {
    for (_, var) in module.global_variables.iter_mut() {
        if matches!(var.space, AddressSpace::Immediate) {
            var.space = AddressSpace::Storage { access: StorageAccess::LOAD };
            var.binding = Some(ResourceBinding { group: options.immediates_group, binding: options.immediates_binding });
            continue;
        }
        if let Some(b) = var.binding.as_mut() {
            b.binding = if b.binding >= SAMPLER_BINDING { (b.binding - SAMPLER_BINDING) * 2 + 1 } else { b.binding * 2 };
        }
    }
}

fn validate(module: &naga::Module) -> Result<naga::valid::ModuleInfo, String> {
    naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all())
        .validate(module)
        .map_err(|e| format!("{:?}", e.into_inner()))
}

/// SPIR-V (bytes) to the JSON answer
pub fn translate(bytes: &[u8], options: &Options) -> Result<String, String> {
    if bytes.len() % 4 != 0 || bytes.len() < 20 {
        return Err(String::from("not SPIR-V: not whole words"));
    }
    let words: Vec<u32> = bytes.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let words = split::split(&words);
    let data: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
    let spv = naga::front::spv::Options { adjust_coordinate_space: !options.keep_coordinate_space, strict_capabilities: false, block_ctx_dump_prefix: None };
    let mut module = naga::front::spv::parse_u8_slice(&data, &spv).map_err(|e| format!("SPIR-V: {:?}", e))?;
    rebind(&mut module, options);
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
    let wgsl = naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty())
        .map_err(|e| format!("WGSL: {:?}", e))?;

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
        json.push_str(&format!("{{\"name\":{},\"stage\":\"{}\",\"workgroup\":[{},{},{}],\"bindings\":[",
            quote(&entry.name), stage, entry.workgroup_size[0], entry.workgroup_size[1], entry.workgroup_size[2]));
        let uses = info.get_entry_point(index);
        let mut first = true;
        for (handle, var) in module.global_variables.iter() {
            let Some(binding) = var.binding else { continue };
            if uses[handle].is_empty() { continue; }
            if !first { json.push(','); }
            first = false;
            json.push_str(&format!("[{},{},\"{}\"]", binding.group, binding.binding, kind(&module, var)));
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
    json.push_str("]}");
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

/// # Safety
/// `ptr` holds `len` bytes; `flags` bit 0: keep Vulkan's clip space (Options)
#[no_mangle]
pub unsafe extern "C" fn vx_translate(ptr: *const u8, len: usize, immediates_group: u32, immediates_binding: u32, flags: u32) -> *mut u8 {
    let bytes = core::slice::from_raw_parts(ptr, len);
    let options = Options { immediates_group, immediates_binding, keep_coordinate_space: flags & 1 != 0 };
    let answer = match translate(bytes, &options) {
        Ok(json) => json,
        Err(error) => format!("{{\"error\":{}}}", quote(&error)),
    };
    let out = vx_alloc(answer.len() + 4);
    core::ptr::copy_nonoverlapping((answer.len() as u32).to_le_bytes().as_ptr(), out, 4);
    core::ptr::copy_nonoverlapping(answer.as_ptr(), out.add(4), answer.len());
    out
}
