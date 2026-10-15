//! The page tiers' code generation, ISA-neutral (docs/jit-unification-plan.md
//! P5.9): the skeleton of a page function (frame) and the loop structure of
//! its block graph (loops). The ISAs' modules emit their instructions into
//! it: crate::x64::pagegen for x86; the A64 page tier is J2.

pub mod frame;
pub mod loops;
