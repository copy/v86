#![feature(const_fn)]
#![feature(extern_types)]

#[cfg(test)]
#[macro_use]
extern crate quickcheck;

#[macro_use]
mod dbg;

pub mod cpu2;

pub mod c_api;

mod analysis;
mod codegen;
mod config;
mod cpu;
mod cpu_context;
mod gen;
mod global_pointers;
mod jit;
mod jit_instructions;
mod leb;
mod modrm;
mod opstats;
mod page;
mod prefix;
mod profiler;
mod regs;
mod state_flags;
mod tlb;
mod util;
mod wasmgen;
