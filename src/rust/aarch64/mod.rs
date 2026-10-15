//! The ARM core, build/v86-arm64.wasm (docs/arm64-virt-android16-plan.md):
//! an AArch64 CPU (profile v86-aarch64-v1) for the virt machine, built from
//! this crate with the feature aarch64 instead of the x86 modules. It shares
//! the ISA-neutral modules (jitrt, wasmgen, leb, page, zstd, parallel, the
//! state block) and names no x86 module (tools/check_a64_imports.mjs).

pub mod bus;
pub mod cpu;
pub mod debug;
pub mod decode;
pub mod execute;
pub mod fp;
pub mod gic;
pub mod isa_hooks;
pub mod memory;
pub mod mmu;
pub mod psci;
pub mod root;
pub mod smp;
pub mod state;
pub mod sysregs;
pub mod timer;

/// The ISA marker the loader checks after instantiating a core (P1.3): the
/// ARM core exports it, the x86 core does not
#[no_mangle]
pub fn isa_aarch64() -> u32 { 1 }
