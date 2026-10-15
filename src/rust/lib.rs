#[macro_use]
#[cfg_attr(feature = "aarch64", allow(dead_code))]
mod dbg;

// The state block each core declares its fields in (state!)
#[macro_use]
#[cfg_attr(feature = "aarch64", allow(unused_macros))]
mod state_block;

// The two cores (docs/arm64-virt-android16-plan.md, "Wasm core"): one crate,
// the x86 core by default and the ARM core with the feature aarch64. Only
// this file and src/rust/aarch64/ name the feature
// (tools/check_a64_imports.mjs); the shared modules reach the ISA as
// crate::isa, which names the core's hooks. (Until the ARM core has a code
// client, P6, it leaves most of the shared runtime unused.)
#[cfg(not(feature = "aarch64"))]
#[macro_use]
mod paging;

#[cfg(feature = "aarch64")]
pub mod aarch64;
#[cfg(not(feature = "aarch64"))]
pub mod cpu;
#[cfg(not(feature = "aarch64"))]
pub mod x64;

#[cfg(feature = "aarch64")]
use aarch64::isa_hooks as isa;
#[cfg(not(feature = "aarch64"))]
use cpu::isa_hooks as isa;

#[cfg(not(feature = "aarch64"))]
pub mod js_api;
pub mod parallel;
#[cfg(not(feature = "aarch64"))]
pub mod profiler;

#[cfg(not(feature = "aarch64"))]
mod config;
#[cfg(not(feature = "aarch64"))]
#[allow(dead_code)]
#[path = "decode/decode.rs"]
pub(crate) mod decode;
#[cfg(not(feature = "aarch64"))]
mod decode_rules;
#[cfg(not(feature = "aarch64"))]
mod gen;
#[cfg(not(feature = "aarch64"))]
mod jit;
#[cfg(not(feature = "aarch64"))]
mod jit_switches;
#[cfg_attr(feature = "aarch64", allow(dead_code))]
mod jitrt;
#[cfg_attr(feature = "aarch64", allow(dead_code))]
mod leb;
#[cfg_attr(feature = "aarch64", allow(dead_code))]
mod page;
#[cfg(not(feature = "aarch64"))]
mod prefix;
#[cfg(all(test, not(feature = "aarch64")))]
#[path = "../../tests/decode/simd_corpus.rs"]
mod simd_corpus;
#[cfg(not(feature = "aarch64"))]
mod softfloat;
#[cfg(not(feature = "aarch64"))]
mod state_flags;
#[cfg(not(feature = "aarch64"))]
mod step_profile;
#[cfg_attr(feature = "aarch64", allow(dead_code))]
mod wasmgen;
#[cfg(not(feature = "aarch64"))]
mod x86tpl;
#[cfg(not(feature = "aarch64"))]
mod x87_profiler;
mod zstd;
