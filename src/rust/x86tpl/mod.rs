//! x86 leaf templates (docs/jit-unification-plan.md P2.2): the code that
//! every x86 engine generates alike, of x86 semantics. Tier-0 and the region
//! backend use them today; the page tier takes them over (P2.3, P2.4) and
//! keeps them when the others are deleted (P7). The ISA-neutral parts are in
//! wasmgen::leaves, which A64 shares.
//!
//! Imports: nothing of x64, ir::tier0, ir::runtime, jit or the region
//! backend (P2.10 checks it).
pub mod mmx;
pub mod native_fp;
pub mod ops;
pub mod string;
pub mod vec;
pub mod x87;
pub mod x87run;
