//! x86 leaf templates (docs/jit-unification-plan.md P2.2): the code that
//! every x86 engine generates alike, of x86 semantics. The page tier uses
//! them (IR Tier-0 too until P7.5, the region backend until M11 deleted it,
//! P7.9). The ISA-neutral parts are in wasmgen::leaves, which A64 shares.
//!
//! Imports: nothing of x64 or jit (P2.10 checks it).
pub mod mmx;
pub mod native_fp;
pub mod ops;
pub mod string;
pub mod vec;
pub mod x87;
pub mod x87_forms;
pub mod x87run;
