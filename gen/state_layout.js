#!/usr/bin/env node
// Layout of the CPU state at fixed addresses in the Wasm memory (below Rust's
// --global-base, 4096), and who owns each piece of CPU-related state.
//
// This is the single source for
//   src/rust/cpu/global_pointers.rs  the constants between the GENERATED markers
//   src/state_layout.js              offsets and per-core ranges for JavaScript
// Regenerate with `node gen/state_layout.js`; `--check` fails if either file is
// stale, a field overlaps another, or a Rust static is missing from STATICS.
//
// Owners (docs/multicore.md):
//   core     architectural state of one core: copied when the active core
//            changes and saved in snapshots
//   cache    derived from core state; dropped or recomputed when the active
//            core changes (see CPU.prototype.load_core_state)
//   scratch  only live inside one instruction, helper or generated-code
//            activation; never live at a main-loop safe point
//   machine  shared by all cores (devices, configuration, JIT caches that are
//            re-validated against the live TLB and CPU state on every use)
//   debug    diagnostics and profiling counters
//
// A core field may name a `range`: the per-core snapshot ranges
// (CORE_STATE_RANGES) never merge fields of different ranges, so state added
// later gets a range of its own, which snapshots from before it lack (and
// restore to reset values). `init: "keep"` marks core state that INIT leaves
// alone (INIT_PRESERVED); INIT resets the rest.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

const RUST_SIZE = { u8: 1, bool: 1, u16: 2, i32: 4, u32: 4, u64: 8, reg128: 16, F80: 16, CachedStateFlags: 1, "[u64; 8]": 64 };

// size: bytes the field owns. JavaScript views some 1-byte Rust fields as
// 32-bit (e.g. protected_mode), so a slot can be larger than the Rust type.
export const STATE_FIELDS = [
    { name: "reg32", offset: 64, rust: "i32", count: 8, size: 32, owner: "core", aliases: [["reg8", "u8"], ["reg16", "u16"]] },
    { name: "last_op_size", offset: 96, rust: "i32", size: 4, owner: "core" },
    { name: "flags_changed", offset: 100, rust: "i32", size: 4, owner: "core" },
    { name: "last_op1", offset: 104, rust: "i32", size: 4, owner: "core" },
    { name: "state_flags", offset: 108, rust: "CachedStateFlags", size: 4, owner: "cache", note: "recomputed by update_state_flags" },
    { name: "last_result", offset: 112, rust: "i32", size: 4, owner: "core" },
    { name: "flags", offset: 120, rust: "i32", size: 4, owner: "core" },
    { name: "segment_access_bytes", offset: 512, rust: "u8", count: 8, size: 8, owner: "core", comment: "TODO: reorder below segment_limits" },
    { name: "apic_enabled", offset: 548, rust: "bool", size: 4, owner: "core", note: "IA32_APIC_BASE.EN" },
    { name: "acpi_enabled", offset: 552, rust: "bool", size: 4, owner: "machine" },
    { name: "instruction_pointer", offset: 556, rust: "i32", size: 4, owner: "core", note: "linear address (EIP + CS base)" },
    { name: "previous_ip", offset: 560, rust: "i32", size: 4, owner: "core" },
    { name: "idtr_size", offset: 564, rust: "i32", size: 4, owner: "core" },
    { name: "idtr_offset", offset: 568, rust: "i32", size: 4, owner: "core" },
    { name: "gdtr_size", offset: 572, rust: "i32", size: 4, owner: "core" },
    { name: "gdtr_offset", offset: 576, rust: "i32", size: 4, owner: "core" },
    { name: "cr", offset: 580, rust: "i32", count: 8, size: 32, owner: "core" },
    { name: "cpl", offset: 612, rust: "u8", size: 4, owner: "core" },
    { name: "in_hlt", offset: 616, rust: "bool", size: 4, owner: "core" },
    { name: "last_virt_eip", offset: 620, rust: "i32", size: 4, owner: "cache", note: "reset by full_clear_tlb" },
    { name: "eip_phys", offset: 624, rust: "i32", size: 4, owner: "cache", note: "valid while last_virt_eip is" },
    { name: "nmi_blocked", offset: 628, rust: "bool", size: 4, owner: "core", note: "an NMI handler runs; cleared by IRET" },
    { name: "interrupt_shadow", offset: 632, rust: "u8", size: 4, owner: "core", note: "deterministic interpreter STI shadow" },
    { name: "sysenter_cs", offset: 636, rust: "i32", size: 4, owner: "core" },
    { name: "sysenter_esp", offset: 640, rust: "i32", size: 4, owner: "core" },
    { name: "sysenter_eip", offset: 644, rust: "i32", size: 4, owner: "core" },
    // Should be 0 at instruction boundaries, but the IR entry path tests it,
    // so it travels with the core
    { name: "prefixes", offset: 648, rust: "u8", size: 4, owner: "core" },
    { name: "instruction_counter", offset: 664, rust: "u32", size: 4, owner: "machine", note: "dispatch/JIT step counter for budgets; deterministic retirement is separate" },
    { name: "sreg", offset: 668, rust: "u16", count: 8, size: 16, owner: "core" },
    { name: "dreg", offset: 684, rust: "i32", count: 8, size: 32, owner: "core" },
    { name: "svga_dirty_bitmap_min_offset", offset: 716, rust: "u32", size: 4, owner: "machine",
        comment: "filled in by svga_fill_pixel_buffer, read by javacsript for optimised putImageData calls" },
    { name: "svga_dirty_bitmap_max_offset", offset: 720, rust: "u32", size: 4, owner: "machine" },
    { name: "segment_is_null", offset: 724, rust: "bool", count: 8, size: 8, owner: "core" },
    { name: "segment_offsets", offset: 736, rust: "i32", count: 8, size: 32, owner: "core" },
    { name: "segment_limits", offset: 768, rust: "u32", count: 8, size: 32, owner: "core" },
    { name: "protected_mode", offset: 800, rust: "bool", size: 4, owner: "core" },
    { name: "is_32", offset: 804, rust: "bool", size: 4, owner: "core" },
    { name: "stack_size_32", offset: 808, rust: "bool", size: 4, owner: "core" },
    { name: "memory_size", offset: 812, rust: "u32", size: 4, owner: "machine" },
    { name: "fpu_stack_empty", offset: 816, rust: "u8", size: 1, owner: "core", init: "keep" },
    { name: "mxcsr", offset: 824, rust: "i32", size: 4, owner: "core", init: "keep" },
    { name: "reg_xmm", offset: 832, rust: "reg128", count: 8, size: 128, owner: "core", init: "keep" },
    { name: "current_tsc", offset: 960, rust: "u64", size: 8, owner: "cache", note: "written by store_current_tsc for snapshots" },
    { name: "reg_pdpte", offset: 968, rust: "u64", count: 4, size: 32, owner: "core", comment: "4 64-bit entries" },
    { name: "fpu_stack_ptr", offset: 1032, rust: "u8", size: 1, owner: "core", init: "keep" },
    { name: "fpu_control_word", offset: 1036, rust: "u16", size: 2, owner: "core", init: "keep" },
    { name: "fpu_status_word", offset: 1040, rust: "u16", size: 2, owner: "core", init: "keep" },
    { name: "fpu_opcode", offset: 1044, rust: "i32", size: 4, owner: "core", init: "keep" },
    { name: "fpu_ip", offset: 1048, rust: "i32", size: 4, owner: "core", init: "keep" },
    { name: "fpu_ip_selector", offset: 1052, rust: "i32", size: 4, owner: "core", init: "keep" },
    { name: "fpu_dp", offset: 1056, rust: "i32", size: 4, owner: "core", init: "keep" },
    { name: "fpu_dp_selector", offset: 1060, rust: "i32", size: 4, owner: "core", init: "keep" },
    { name: "tss_size_32", offset: 1128, rust: "bool", size: 4, owner: "core" },
    { name: "sse_scratch_register", offset: 1136, rust: "reg128", size: 16, owner: "scratch" },
    { name: "fpu_st", offset: 1152, rust: "F80", count: 8, size: 128, owner: "core", init: "keep" },
    { name: "x87_shadow_values", offset: 1280, rust: "[u64; 8]", size: 64, owner: "cache", note: "synced into fpu_st before a switch",
        doc: ["f64 shadow of the physical x87 registers (cpu::fpu), with VALID/DIRTY", "masks, at fixed addresses so natively generated IR fixtures stay valid."] },
    { name: "x87_shadow_valid", offset: 1344, rust: "u32", size: 4, owner: "cache" },
    { name: "x87_shadow_dirty", offset: 1348, rust: "u32", size: 4, owner: "cache" },
    { name: "x87_native_policy", offset: 1352, rust: "u8", size: 1, owner: "machine",
        doc: ["Nonzero while generated IR code may inline fast-math x87 on that cache."] },
    { name: "slice_budget", offset: 1356, rust: "u32", size: 4, owner: "machine", note: "maximum retired work in one generated activation" },
    // Wide architectural banks keep legacy low-register offsets stable.
    { name: "x64_gpr_hi", offset: 1360, rust: "u32", count: 16, size: 64, owner: "core" },
    { name: "x64_gpr_ext_lo", offset: 1424, rust: "u32", count: 8, size: 32, owner: "core" },
    { name: "x64_xmm_ext", offset: 1456, rust: "reg128", count: 8, size: 128, owner: "core", init: "keep" },
    { name: "x64_rip_hi", offset: 1584, rust: "u32", size: 4, owner: "core" },
    { name: "x64_previous_ip_hi", offset: 1588, rust: "u32", size: 4, owner: "core" },
    { name: "x64_idtr_base_hi", offset: 1592, rust: "u32", size: 4, owner: "core" },
    { name: "x64_gdtr_base_hi", offset: 1596, rust: "u32", size: 4, owner: "core" },
    { name: "x64_cr_hi", offset: 1600, rust: "u32", count: 8, size: 32, owner: "core" },
    { name: "x64_dr_hi", offset: 1632, rust: "u32", count: 8, size: 32, owner: "core" },
    { name: "x64_segment_base_hi", offset: 1664, rust: "u32", count: 8, size: 32, owner: "core" },
    { name: "x64_efer", offset: 1696, rust: "u64", size: 8, owner: "core" },
    { name: "x64_kernel_gs_base", offset: 1704, rust: "u64", size: 8, owner: "core" },
    { name: "x64_star", offset: 1712, rust: "u64", size: 8, owner: "core" },
    { name: "x64_lstar", offset: 1720, rust: "u64", size: 8, owner: "core" },
    { name: "x64_cstar", offset: 1728, rust: "u64", size: 8, owner: "core" },
    { name: "x64_sfmask", offset: 1736, rust: "u64", size: 8, owner: "core" },
    { name: "x64_cs_long", offset: 1744, rust: "u8", size: 4, owner: "core" },
    { name: "x64_rex", offset: 1748, rust: "u8", size: 4, owner: "scratch" },
    { name: "x64_cr8", offset: 1752, rust: "u64", size: 8, owner: "core" },
    { name: "x64_sysenter_esp_hi", offset: 1760, rust: "u32", size: 4, owner: "core" },
    { name: "x64_sysenter_eip_hi", offset: 1764, rust: "u32", size: 4, owner: "core" },
    { name: "x64_fpu_ip_hi", offset: 1768, rust: "u32", size: 4, owner: "core", init: "keep" },
    { name: "x64_fpu_dp_hi", offset: 1772, rust: "u32", size: 4, owner: "core", init: "keep" },
    { name: "x64_pat", offset: 1776, rust: "u64", size: 8, owner: "core", init: "keep" },
    { name: "x64_tsc_aux", offset: 1784, rust: "u32", size: 4, owner: "core" },
    // x64 page functions (src/rust/x64/pages.rs): written by the runtime
    // immediately before an activation and read by generated code.
    { name: "x64_page_exit", offset: 1792, rust: "u32", size: 4, owner: "scratch", note: "why the last page function returned" },
    { name: "x64_jac_base", offset: 1796, rust: "u32", size: 4, owner: "scratch", note: "access cache read table of the active core and CPL" },
    { name: "x64_jac_epoch", offset: 1800, rust: "u64", size: 8, owner: "scratch", note: "tag bits of the active core's access cache epoch" },
    { name: "x64_page_linear", offset: 1808, rust: "u64", size: 8, owner: "scratch", note: "linear address of the page a page function runs at" },
    { name: "x64_page_chain", offset: 1816, rust: "u32", size: 4, owner: "scratch", note: "native instructions of the page functions an activation tail-called from" },
    { name: "x64_code_base", offset: 1820, rust: "u32", size: 4, owner: "scratch", note: "chaining table of the active core and CPL (x64::pages)" },
    { name: "x64_page_lazy_kind", offset: 1824, rust: "u32", size: 4, owner: "scratch", note: "lazy EFLAGS record a page function tail-called with (0: flags are materialized)" },
    { name: "x64_page_lazy_a", offset: 1832, rust: "u64", size: 8, owner: "scratch", note: "its first operand" },
    { name: "x64_page_lazy_b", offset: 1840, rust: "u64", size: 8, owner: "scratch", note: "its second operand" },
    { name: "x64_page_rep_elements", offset: 1848, rust: "u32", size: 4, owner: "scratch", note: "REP elements legacy-mode page functions ran in an activation (into the core's statistics after it)" },
    { name: "x64_chain_gprs", offset: 1864, rust: "u64", count: 16, size: 128, owner: "scratch", note: "the GPRs a page function tail-calls with (x64_fast_chain)" },
    // System management mode (src/rust/cpu/smm.rs). Its own per-core range, so
    // that snapshots from before it restore it to its reset value.
    { name: "smm_state", offset: 1856, rust: "u32", size: 4, owner: "core", note: "bit 0: in SMM; bit 1: NMIs were blocked at the SMI; bit 2: the state is in the 64-bit save map" },
    { name: "smbase", offset: 1860, rust: "u32", size: 4, owner: "core", init: "keep", note: "SMRAM state save base: 0x30000 at reset, kept across INIT" },
    { name: "ir_tlb_base", offset: 2048, rust: "u32", size: 4, owner: "machine",
        doc: ["Address of cpu::tlb_data, written at startup. Generated IR code loads it", "from this fixed slot (below --global-base) instead of calling an import."] },
    // Memory-type and machine-check MSRs (x64 profile; see instructions_0f.rs
    // read_msr_table). Disabled/zero after reset, unchanged by INIT.
    { name: "x64_mtrr_def_type", offset: 2056, rust: "u64", size: 8, owner: "core", init: "keep", note: "IA32_MTRR_DEF_TYPE" },
    { name: "x64_mtrr_fixed", offset: 2064, rust: "u64", count: 11, size: 88, owner: "core", init: "keep", note: "FIX64K_00000, FIX16K_80000/A0000, FIX4K_C0000..F8000" },
    { name: "x64_mtrr_var", offset: 2152, rust: "u64", count: 16, size: 128, owner: "core", init: "keep", note: "IA32_MTRR_PHYSBASE0/PHYSMASK0 .. 7, in MSR order" },
    { name: "x64_mcg_status", offset: 2280, rust: "u64", size: 8, owner: "core", init: "keep" },
    { name: "x64_mcg_ctl", offset: 2288, rust: "u64", size: 8, owner: "core", init: "keep" },
    { name: "x64_mc_banks", offset: 2296, rust: "u64", count: 16, size: 128, owner: "core", init: "keep", note: "IA32_MCi_CTL/STATUS/ADDR/MISC for 4 banks" },
    // XSAVE-managed state (cpu/xstate.rs, docs/simd-xsave-plan.md 6.4). Like
    // the x87 and SSE registers, INIT keeps it; RESET sets XCR0 to 1.
    { name: "xcr0", offset: 2432, rust: "u64", size: 8, owner: "core", range: "xstate", init: "keep" },
    { name: "xss", offset: 2440, rust: "u64", size: 8, owner: "core", range: "xstate", init: "keep", note: "IA32_XSS (XSAVES)" },
    { name: "ymm_hi", offset: 2448, rust: "reg128", count: 16, size: 256, owner: "core", range: "xstate", init: "keep", note: "bits 255:128 of YMM0-YMM15" },
];

// Every static in src/rust, by file. The check fails on a static that is not
// listed here, so new state has to be classified when it is added.
export const STATICS = {
    // one local APIC per core, indexed by core; the scheduler's current core and INIT/SIPI events
    // the state block of this instance in the parallel build: each relocated instance has its own
    "state_block.rs": { STATE_BLOCK: "core" },
    // the ARM core (docs/arm64-virt-android16-plan.md P1.0): its scheduler's
    // current core, the machine's core count, the yield flag of this
    // instance, guest RAM's base
    "aarch64/isa_hooks.rs": { CURRENT_CORE: "machine", CORE_COUNT: "machine", CORE_YIELD: "scratch" },
    "aarch64/root.rs": { MEM8: "machine" },
    "cpu/apic.rs": { APICS: "core", APIC_AUX: "core", CURRENT_CORE: "machine", CORE_COUNT: "machine", CORE_EVENTS: "machine", NMI_PENDING: "machine", SMI_PENDING: "machine" },
    "cpu/cpu.rs": {
        INTERPRETED: "debug", INTERPRETED_OFFSETS: "debug", INTERPRETED_PAGES: "debug", INTERPRETED_VEX: "debug", INTERPRETED_WATCH: "debug",
        INSTRUCTION_TRACE: "debug", INSTRUCTION_TRACE_NEXT: "debug", INSTRUCTION_TRACE_ENABLED: "debug",
        cpuid_level: "machine", debug_last_jump: "debug", jit_block_boundary: "scratch", core_yield: "scratch",
        jit_link_batch: "scratch", jit_link_batch_start: "scratch", jit_link_batch_limit: "scratch",
        // active TLB working set; context.rs preserves each inactive core
        tlb_data: "cache", valid_tlb_entries: "cache", valid_tlb_entries_count: "cache",
        // active TSC offset lives in context.rs across switches; old interpolation slots remain for test hooks
        tsc_last_extra: "machine", tsc_last_value: "machine", tsc_number_of_same_readings: "machine",
        tsc_offset: "core", tsc_resolution: "machine", tsc_speed: "machine",
    },
    "cpu/exceptions.rs": { DELIVERING: "scratch", EXTERNAL: "scratch", SHUTDOWN: "core", BSP_RESET: "machine" },
    "cpu/context.rs": { CONTEXTS: "core" },
    "cpu/execution.rs": { execution_state: "machine", CORE_STATISTICS: "core", LEDGER: "debug",
        // flushed into CORE_STATISTICS before every read, reset and core switch
        PENDING_RETIRED: "scratch", PENDING_REP_ELEMENTS: "scratch" },
    "cpu/fpu.rs": { X87_JIT_CACHE: "machine" },
    // (IOAPIC_LOCK guards it while cores run in workers; UNUSED stands in for it in the normal build)
    "cpu/ioapic.rs": { IOAPIC: "machine", IOAPIC_LOCK: "machine", UNUSED: "machine" },
    "cpu/instructions_0f.rs": { X64_TEST_CAPABILITIES: "machine", X64_ARCH_CAPABILITIES: "machine" },
    // the CPU features of docs/simd-xsave-plan.md this machine has;
    // TEST_FEATURES replaces them per thread under cargo test
    "cpu/features.rs": { FEATURES: "machine", TEST_FEATURES: "debug" },
    // cargo test only: decode rows whose semantics come later
    "decode/decode.rs": { TEST_DECODE_UNIMPLEMENTED: "debug" },
    // the chipset's SMRAM control (Q35 MCH: G_SMRAME, D_OPEN) and TSEG; per
    // instance: the TSEG generation its fast RAM limit reflects
    "cpu/smm.rs": { SMRAM_CONTROL: "machine", TSEG: "machine", TSEG_SEEN: "cache" },
    "cpu/memory.rs": { mem8: "machine", ram_fast_limit: "machine" },
    // device memory regions (frame buffers) and where they are mapped
    "cpu/mmio_ram.rs": { TABLE: "machine", TEST_TABLE: "debug" },
    "cpu/pic.rs": { PIC: "machine", PORT_WRITTEN: "machine" },
    // SoftFloat's state around one SSE instruction (saved and restored)
    "cpu/simd_fp.rs": { softfloat_roundingMode: "scratch", softfloat_exceptionFlags: "scratch" },
    "decode/encodings.rs": { ENCODINGS: "machine", OPCODES: "machine", FORMS: "debug" },
    // (calls of the AVX helper, for tests)
    "jit.rs": { ENABLED: "machine", RESERVED: "machine" },
    // (the ISA-neutral runtime, P5: an instance's table and watched pages;
    // LOG is a unit test's)
    "jitrt/mod.rs": { STATE: "machine" },
    "jitrt/host.rs": { ENV: "machine" },
    "jitrt/publish.rs": { CLIENTS: "machine" },
    "jitrt/capacity.rs": { QUOTA: "machine", REQUESTS: "machine" },
    "jitrt/stat.rs": { STATS: "machine" },
    "jitrt/watch.rs": { WATCHED: "machine", LOG: "debug" },
    // the JIT switches set on this instance, the machine's ones a vCPU worker applied, the names
    "jit_switches.rs": { EXPLICIT: "machine", COPIED: "machine", NAMES: "machine" },
    // the step profile (docs/jit-unification-plan.md P0.5)
    "step_profile.rs": { PROFILE: "debug", SAMPLES: "debug", PAIRS: "debug", PAIRS_FROZEN: "debug", SNAPSHOT: "debug", X64_LEGACY: "debug", X64_LEGACY_STALE: "debug" },
    // the parallel runtime: where this instance's statics are and whether
    // cores run in workers, then machine-wide words reached through machine():
    // wake-ups, yield flags, the locks of locked operations and the code
    // publication/invalidation rings; per instance: its ring positions and the
    // pages it claimed
    "parallel.rs": {
        INSTANCE_BASE: "machine", ACTIVE: "machine", CORE_WAKE: "machine", CORE_YIELD: "machine",
        LOCKED_OPERATIONS: "machine", SPLIT_LOCK: "machine",
        OWNERS: "machine", OWNER_PAGES: "machine", PUBLISH_NEXT: "machine", PUBLISHED: "machine",
        INVALIDATE_NEXT: "machine", INVALIDATED: "machine", ACKED: "machine", IDLE: "machine",
        REFUSED: "debug", PUBLISH_SEEN: "cache", INVALIDATE_SEEN: "cache", CLAIMED: "cache",
        KICKS: "debug",
    },
    "profiler.rs": Object.fromEntries([
        "PERFORMANCE_BATCH_CHUNKS", "PERFORMANCE_CODEGEN", "PERFORMANCE_COUNTDOWN", "PERFORMANCE_COUNTERS", "PERFORMANCE_EXECUTION",
        "PERFORMANCE_NEXT_SAMPLE", "PERFORMANCE_PENDING_ROW", "PERFORMANCE_PREVIOUS_CHUNKS", "PERFORMANCE_RANDOM",
        "PERFORMANCE_RECORDING", "PERFORMANCE_ROWS", "PERFORMANCE_SAMPLE_TIME", "PERFORMANCE_STARTED", "stat_array",
    ].map(name => [name, "debug"])),
    // SoftFloat's C globals: set from the x87 control word before each operation
    "softfloat.rs": {
        X87_FAST_MATH: "machine", X87_POLICY_OBSERVER: "machine",
        softfloat_roundingMode: "scratch", extF80_roundingPrecision: "scratch", softfloat_exceptionFlags: "scratch",
    },
    "x87_profiler.rs": { CACHE: "debug", COUNTS: "debug", ENABLED: "debug" },
    "x64/physical.rs": { PHYSICAL_BUS: "machine" },
    // (LOCKED: the locked instruction in progress, within one instruction)
    "x64/memory.rs": { X64_TLBS: "core", LOCKED: "scratch" },
    // extended RAM: the frame pool and its lock; access caches holding frames
    // are released at the next safe point; aperture slots are remapped on demand
    "x64/extended.rs": { EXTENDED: "machine", LOCK: "machine", DEPTH: "scratch", RELEASE_PENDING: "cache",
        LEGACY_TLB_CACHED: "cache", SLOT_PAGE: "cache", NEXT: "cache" },
    // page functions and their bookkeeping; entries re-check the live translation
    // the page tier's exact SSE/FMA paths (their operand block and call
    // counts), the host's tail calls and relaxed multiply-adds (P7.5: from
    // ir/runtime/tier0.rs)
    "x64/helpers.rs": {
        SSE_FP_OPERANDS: "scratch", SSE_FP_CALLS: "debug", FMA_CALLS: "debug", TAIL_CALLS: "machine",
        RELAXED_FMA_FUSED: "machine", RELAXED_FMA: "machine",
    },
    "x64/pages.rs": { RUNTIME: "machine", FAST: "machine", ACTIVE: "scratch", IN_ACTIVATION: "scratch", SEGMENTED_ACTIVE: "scratch", CODE_WRITES: "machine", STEPS: "debug", ACCESS_REFUSED: "debug",
        // per core, tagged with that core's access cache epoch
        CODE_TLB: "cache", CHAIN: "cache",
        COUNTERS: "debug", CHAINING: "machine", LAST_UNSERVED: "cache", BOUNCE: "scratch", RECOMPILE_MISSES: "machine", TIMING: "debug", TIME_IN_CALLS: "debug", TIME_IN_EXECUTE: "debug", TIME_FIRST_CALLS: "debug", BYTES_COMPILED: "debug",
        // (step profile: stepped instructions by RIP; whether the last
        // activation ended in a step, for its exit event)
        STEP_RIPS: "debug", SORTED: "debug", STEP_EXITED: "debug",
        // interpreted heat of a page without a function, valid while the
        // runtime's functions are unchanged (P4.5b); the P4.5 switches
        HEAT_BATCH: "machine", BATCH_HEAT: "machine", MISS_RUN: "machine",
        // page functions' execution counters, their free cells, and the
        // switches x64_hot_inline and x64_hot_count (P4.14)
        HOT_COUNTS: "machine", HOT_FREE: "machine", HOT_NEXT: "machine", HOT_INLINE: "machine", HOT_COUNT: "machine", COMPAT_HOT_COUNT: "machine",
        // the switches x64_page_compat32 (P7.2) and x64_page_legacy32 (P7.3)
        COMPAT32: "machine", COMPAT_ACTIVE: "machine", LEGACY32: "machine", PAGE32_TIER0: "machine", LEGACY_ACTIVE: "machine", PROT16: "machine", PROT16_ACTIVE: "machine", V86: "machine", V86_ACTIVE: "machine", LEGACY_HEAT: "machine", LEGACY_MISSES: "machine", CLUSTERS: "machine", SPAN_CROSSINGS: "machine", SPAN_ENTRIES: "machine", SPAN_DECLINED: "scratch" },
    // derived from each core's x64 TLB (flushed with it); FRAME_BUFFER_WRITES:
    // some entry maps the VGA frame buffer
    "x64/jac.rs": { JAC: "cache", FRAME_BUFFER_WRITES: "cache", ENTRIES: "machine" },
    "x64/execute.rs": { DECODE_CACHE: "cache" },
    "x64/pagegen.rs": { SIZE_STATS: "debug", OUTLINE_ACCESS: "machine", BLOCK_COUNT: "machine", BUCKET_DISPATCH: "machine", CVT: "machine",
        STI_SHADOW: "machine", LOOPS: "machine", XMM_LOCALS: "machine",
        SSE_FAST_CHECK: "machine", I32_OPS: "machine", FAST_LOOKUP: "machine", FAST_CHAIN: "machine",
        EXIT_FLAGS: "machine", COMPAT_TLB: "machine" },
    "x64/replay.rs": { RECORDS: "debug", INPUT: "debug", OUTPUT: "debug", OUTPUTS: "debug" },
    "x64/debug.rs": { PENDING: "scratch" },
    "x64/system.rs": { FAULT_LOG: "debug", FAULT_NEXT: "debug", USER_TRACE: "debug", USER_TRACE_NEXT: "debug", USER_TRACE_ENABLED: "debug" },
    "x64/profile.rs": { PERIOD: "debug", COUNTDOWN: "debug", SAMPLES: "debug" },
    "x64/vector.rs": { softfloat_roundingMode: "scratch", softfloat_exceptionFlags: "scratch" },
};

const OWNERS = new Set(["core", "cache", "scratch", "machine", "debug"]);

function validate()
{
    const sorted = [...STATE_FIELDS].sort((a, b) => a.offset - b.offset);
    for(const [i, f] of sorted.entries())
    {
        assert.ok(OWNERS.has(f.owner) && f.owner !== "debug", f.name + ": owner");
        const rust_size = RUST_SIZE[f.rust] * (f.count || 1);
        assert.ok(rust_size, f.name + ": unknown Rust type " + f.rust);
        assert.ok(f.size >= rust_size, f.name + ": slot smaller than the Rust type");
        assert.ok(f.offset >= 64 && f.offset + f.size <= 4096, f.name + ": outside the fixed region");
        assert.ok(f.owner === "core" || f.range === undefined && f.init === undefined, f.name + ": range and init are for core state");
        assert.ok(f.init === undefined || f.init === "keep", f.name + ": init");
        const next = sorted[i + 1];
        assert.ok(!next || f.offset + f.size <= next.offset, f.name + " overlaps " + (next && next.name));
    }
    for(const statics of Object.values(STATICS))
    {
        for(const [name, owner] of Object.entries(statics)) assert.ok(OWNERS.has(owner), name + ": owner");
    }
}

/** [start, end) byte ranges covering the core fields, merged across unused gaps within a range */
export function core_ranges()
{
    const sorted = [...STATE_FIELDS].sort((a, b) => a.offset - b.offset);
    const ranges = [];
    let current = null, range;
    for(const f of sorted)
    {
        if(f.owner === "core")
        {
            if(current && f.range !== range)
            {
                ranges.push(current);
                current = null;
            }
            if(current) current[1] = f.offset + f.size;
            else current = [f.offset, f.offset + f.size];
            range = f.range;
        }
        else if(current)
        {
            ranges.push(current);
            current = null;
        }
    }
    if(current) ranges.push(current);
    return ranges;
}

function rust_consts()
{
    const lines = [];
    for(const f of [...STATE_FIELDS].sort((a, b) => a.offset - b.offset))
    {
        const type = f.rust;
        for(const line of f.doc || []) lines.push("// " + line);
        for(const [alias, alias_type] of f.aliases || [])
        {
            lines.push(`state!(${alias}: ${alias_type} = ${f.offset});`);
        }
        const comment = f.comment ? " // " + f.comment : "";
        lines.push(`state!(${f.name}: ${type} = ${f.offset});${comment}`);
    }
    return lines.join("\n") + "\n";
}

const BEGIN = "// BEGIN GENERATED by gen/state_layout.js (edit the layout there)\n";
const END = "// END GENERATED\n";

function rust_file(current)
{
    const start = current.indexOf(BEGIN);
    const end = current.indexOf(END);
    assert.ok(start !== -1 && end > start, "global_pointers.rs: GENERATED markers missing");
    return current.slice(0, start + BEGIN.length) + rust_consts() + current.slice(end);
}

function js_file()
{
    const offsets = {};
    for(const f of [...STATE_FIELDS].sort((a, b) => a.offset - b.offset))
    {
        for(const [alias] of f.aliases || []) offsets[alias] = f.offset;
        offsets[f.name] = f.offset;
    }
    return `// Generated by gen/state_layout.js from the CPU state layout; do not edit.

/** Offsets of the CPU state fields in the Wasm memory */
export const STATE_OFFSETS = {
${Object.entries(offsets).map(([name, offset]) => `    ${name}: ${offset},`).join("\n")}
};

/**
 * Byte ranges [start, end) of the per-core state; copied when the active core
 * changes (CPU.prototype.save_core_state/load_core_state)
 */
export const CORE_STATE_RANGES = [
${core_ranges().map(([a, b]) => `    [${a}, ${b}],`).join("\n")}
];

/** [offset, size] of the core state that INIT keeps (the rest takes its reset value) */
export const INIT_PRESERVED = [
${init_preserved().map(([a, b]) => `    [${a}, ${b}],`).join("\n")}
];
`;
}

/** [offset, size] of the fields marked init: "keep", adjacent ones merged */
function init_preserved()
{
    const kept = [];
    for(const f of [...STATE_FIELDS].sort((a, b) => a.offset - b.offset).filter(f => f.init === "keep"))
    {
        const last = kept[kept.length - 1];
        if(last && last[0] + last[1] === f.offset) last[1] += f.size;
        else kept.push([f.offset, f.size]);
    }
    return kept;
}

/** Statics declared in src/rust, as {file: [names]} */
function find_statics()
{
    const found = {};
    const walk = dir => {
        for(const entry of fs.readdirSync(dir, { withFileTypes: true }))
        {
            const p = path.join(dir, entry.name);
            if(entry.isDirectory()) walk(p);
            else if(p.endsWith(".rs"))
            {
                const text = fs.readFileSync(p, "utf8");
                const names = [...text.matchAll(/^\s*(?:pub(?:\([a-z]+\))?\s+)?static\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(m => m[1]);
                if(names.length) found[path.relative(path.join(ROOT, "src/rust"), p)] = names;
            }
        }
    };
    walk(path.join(ROOT, "src/rust"));
    return found;
}

function check_statics()
{
    const problems = [];
    const found = find_statics();
    for(const [file, names] of Object.entries(found))
    {
        for(const name of names)
        {
            if(!STATICS[file] || !STATICS[file][name]) problems.push(`src/rust/${file}: static ${name} has no owner in gen/state_layout.js`);
        }
    }
    for(const [file, statics] of Object.entries(STATICS))
    {
        for(const name of Object.keys(statics))
        {
            if(!found[file] || !found[file].includes(name)) problems.push(`gen/state_layout.js: ${file} ${name} no longer exists`);
        }
    }
    assert.deepEqual(problems, [], "\n" + problems.join("\n"));
}

if(process.argv[1] === url.fileURLToPath(import.meta.url))
{
    validate();
    const check = process.argv.includes("--check");
    const rust_path = path.join(ROOT, "src/rust/cpu/global_pointers.rs");
    const outputs = [[rust_path, rust_file(fs.readFileSync(rust_path, "utf8"))], [path.join(ROOT, "src/state_layout.js"), js_file()]];
    for(const [file, content] of outputs)
    {
        if(check) assert.equal(fs.existsSync(file) && fs.readFileSync(file, "utf8"), content, file + " is stale; run node gen/state_layout.js");
        else fs.writeFileSync(file, content);
    }
    check_statics();
    const core_bytes = core_ranges().reduce((n, [a, b]) => n + b - a, 0);
    console.log(`state layout: ${STATE_FIELDS.length} fields, per-core ranges ${JSON.stringify(core_ranges())} (${core_bytes} bytes), ` +
        `${Object.values(STATICS).reduce((n, s) => n + Object.keys(s).length, 0)} Rust statics classified`);
}
