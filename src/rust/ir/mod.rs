//! The IR compiler (frontend, MIR, Wasm backend: the region tiers) and its
//! runtime, which also schedules the x64 page tier (crate::x64). See docs/ir-design.md.
#![allow(dead_code)]
pub mod analysis;
pub mod backend;
pub mod builder;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/control.rs"]
mod control_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/copy.rs"]
mod copy_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/core.rs"]
mod core_tests;
pub mod dump;
pub mod effects;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/far_control.rs"]
mod far_control_tests;
pub mod frontend;
pub mod helper;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/helpers.rs"]
mod helper_tests;
pub mod hir;
pub mod ids;
pub mod lowering;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/memory.rs"]
mod memory_tests;
pub mod mir;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/page_bench.rs"]
mod page_bench_tests;
pub mod passes;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/region_bench.rs"]
mod region_bench_tests;
pub mod runtime;
pub mod simd;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/stack.rs"]
mod stack_tests;
pub mod state;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/store_continuation.rs"]
mod store_continuation_tests;
pub mod types;
pub mod verify;
pub mod x87;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/shifts.rs"]
mod shift_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/multiply.rs"]
mod multiply_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/bits.rs"]
mod bit_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/enter.rs"]
mod enter_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/exchange.rs"]
mod exchange_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/loops.rs"]
mod loop_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/misc.rs"]
mod misc_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/segments.rs"]
mod segment_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/system_stack.rs"]
mod system_stack_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/strings.rs"]
mod string_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/io.rs"]
mod io_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/ir10.rs"]
mod ir10_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/rep.rs"]
mod rep_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/cpu_info.rs"]
mod cpu_info_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/cpu_system.rs"]
mod cpu_system_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/control_regs.rs"]
mod control_regs_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/descriptor.rs"]
mod descriptor_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/task_regs.rs"]
mod task_regs_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/selector_query.rs"]
mod selector_query_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/verr.rs"]
mod verr_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/cmpxchg8b.rs"]
mod cmpxchg8b_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/x87.rs"]
mod x87_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/simd_moves.rs"]
mod simd_move_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/simd_integer.rs"]
mod simd_integer_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/simd_immediate.rs"]
mod simd_immediate_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/simd_shuffle.rs"]
mod simd_shuffle_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/simd_transfer.rs"]
mod simd_transfer_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/simd_lane.rs"]
mod simd_lane_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/simd_masked.rs"]
mod simd_masked_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/mir_memory.rs"]
mod mir_memory_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/mir_effect.rs"]
mod mir_effect_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/mir_arithmetic.rs"]
mod mir_arithmetic_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/dynamic_count.rs"]
mod dynamic_count_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/mir_call.rs"]
mod mir_call_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/mir_control.rs"]
mod mir_control_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/mir_state.rs"]
mod mir_state_tests;
#[cfg(test)]
#[path = "../../../tests/ir/semantics/mir_value.rs"]
mod mir_value_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/cfg_frontend.rs"]
mod cfg_frontend_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/merge.rs"]
mod merge_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/dataflow.rs"]
mod dataflow_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/entry.rs"]
mod entry_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/fusion.rs"]
mod fusion_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/compile_replay.rs"]
mod compile_replay_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/x87_memory.rs"]
mod x87_memory_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/fp_state.rs"]
mod fp_state_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/sse_fp.rs"]
mod sse_fp_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/crc32.rs"]
mod crc32_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/avx.rs"]
mod avx_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/bmi.rs"]
mod bmi_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/mmx.rs"]
mod mmx_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/coverage.rs"]
mod coverage_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/sti.rs"]
mod sti_tests;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/invalid.rs"]
mod invalid_tests;

pub mod debug;

#[cfg(test)]
#[path = "../../../tests/ir/semantics/budget_batch.rs"]
mod budget_batch_tests;
