#!/usr/bin/env node
// Layout of the CPU state at fixed addresses in the Wasm memory (below Rust's
// --global-base, 4096), and who owns each piece of CPU-related state.
//
// This is the single source for
//   src/rust/cpu/global_pointers.rs  the constants between the GENERATED markers
//   src/state_layout.js              offsets and per-core ranges for JavaScript
// and for the ARM core's own state block (docs/arm64-virt-android16-plan.md
// P1.4: each core has its 4096 bytes, from offset 64)
//   src/rust/aarch64/state.rs        the constants between the GENERATED markers
//   src/arm/state_layout.js          offsets and per-core ranges for JavaScript
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

const RUST_SIZE = { u8: 1, bool: 1, u16: 2, i32: 4, u32: 4, u64: 8, u128: 16, reg128: 16, F80: 16, CachedStateFlags: 1, "[u64; 8]": 64 };

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

// The ARM core's state block (src/rust/aarch64/state.rs): the hottest fields
// first (PC, X0-X30 and the current SP, NZCV), then FPCR/FPSR and V0-V31,
// then the EL1 system registers, the timers, the GIC CPU interface, the
// exclusive monitor and the debug registers. Bits of PSTATE other than NZCV
// are in `pstate` as SPSR_EL1 lays them out (D, A, I, F at 9:6, SS 21, IL 20,
// EL 3:2, SP 0). SVE state beyond 128 bits (not in v1) goes outside.
export const A64_STATE_FIELDS = [
    { name: "x", offset: 64, rust: "u64", count: 32, size: 256, owner: "core", note: "X0-X30, then the current SP (SP_EL0 or SP_EL1 by PSTATE.SP)" },
    { name: "pc", offset: 320, rust: "u64", size: 8, owner: "core" },
    { name: "nzcv", offset: 328, rust: "u32", size: 4, owner: "core", note: "N Z C V at bits 31:28" },
    { name: "pstate", offset: 332, rust: "u32", size: 4, owner: "core", note: "PSTATE but NZCV, as in SPSR_EL1" },
    { name: "fpcr", offset: 336, rust: "u32", size: 4, owner: "core" },
    { name: "fpsr", offset: 340, rust: "u32", size: 4, owner: "core" },
    { name: "instruction_counter", offset: 344, rust: "u32", size: 4, owner: "machine", note: "dispatch/JIT step counter for budgets" },
    { name: "slice_budget", offset: 348, rust: "u32", size: 4, owner: "machine", note: "maximum retired work in one generated activation" },
    { name: "v", offset: 352, rust: "u128", count: 32, size: 512, owner: "core", note: "V0-V31" },
    // the inactive stack pointer and the EL1 system registers (P3.1)
    { name: "sp_el", offset: 864, rust: "u64", count: 2, size: 16, owner: "core", range: "sys", note: "SP_EL0, SP_EL1 while not the current SP" },
    { name: "elr_el1", offset: 880, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "spsr_el1", offset: 888, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "esr_el1", offset: 896, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "far_el1", offset: 904, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "vbar_el1", offset: 912, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "sctlr_el1", offset: 920, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "cpacr_el1", offset: 928, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "ttbr0_el1", offset: 936, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "ttbr1_el1", offset: 944, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "tcr_el1", offset: 952, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "mair_el1", offset: 960, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "amair_el1", offset: 968, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "contextidr_el1", offset: 976, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "tpidr_el0", offset: 984, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "tpidrro_el0", offset: 992, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "tpidr_el1", offset: 1000, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "par_el1", offset: 1008, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "afsr0_el1", offset: 1016, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "afsr1_el1", offset: 1024, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "actlr_el1", offset: 1032, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "csselr_el1", offset: 1040, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "cntkctl_el1", offset: 1048, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "cntfrq_el0", offset: 1056, rust: "u64", size: 8, owner: "core", range: "sys", note: "writable at EL1; the counter's rate does not follow it" },
    { name: "mdscr_el1", offset: 1064, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "osdlr_el1", offset: 1072, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "oslsr_el1", offset: 1080, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "mdccint_el1", offset: 1088, rust: "u64", size: 8, owner: "core", range: "sys" },
    { name: "disr_el1", offset: 1096, rust: "u64", size: 8, owner: "core", range: "sys" },
    // the generic timer's EL1 virtual and physical timers (P3.6)
    { name: "cntv_ctl", offset: 1104, rust: "u64", size: 8, owner: "core", range: "timer" },
    { name: "cntv_cval", offset: 1112, rust: "u64", size: 8, owner: "core", range: "timer" },
    { name: "cntp_ctl", offset: 1120, rust: "u64", size: 8, owner: "core", range: "timer" },
    { name: "cntp_cval", offset: 1128, rust: "u64", size: 8, owner: "core", range: "timer" },
    // the GICv3 CPU interface (P3.5): ICC_PMR, BPR0/1, IGRPEN0/1, CTLR, the
    // active priorities AP0R0/AP1R0 and the running priority stack
    { name: "icc_pmr", offset: 1136, rust: "u32", size: 4, owner: "core", range: "gic" },
    { name: "icc_bpr", offset: 1140, rust: "u32", count: 2, size: 8, owner: "core", range: "gic" },
    { name: "icc_igrpen", offset: 1148, rust: "u32", count: 2, size: 8, owner: "core", range: "gic" },
    { name: "icc_ctlr", offset: 1156, rust: "u32", size: 4, owner: "core", range: "gic" },
    { name: "icc_ap0r", offset: 1160, rust: "u32", size: 4, owner: "core", range: "gic" },
    { name: "icc_ap1r", offset: 1164, rust: "u32", size: 4, owner: "core", range: "gic" },
    { name: "icc_active", offset: 1168, rust: "u32", count: 8, size: 32, owner: "core", range: "gic", note: "INTIDs being handled, innermost last" },
    { name: "icc_active_count", offset: 1200, rust: "u32", size: 4, owner: "core", range: "gic" },
    // the local exclusive monitor (P3.3): the reserved granule and the value
    // for the parallel build's compare-exchange
    { name: "excl_valid", offset: 1208, rust: "u32", size: 4, owner: "core", range: "exclusive" },
    { name: "excl_addr", offset: 1216, rust: "u64", size: 8, owner: "core", range: "exclusive" },
    { name: "excl_value", offset: 1232, rust: "u128", size: 16, owner: "core", range: "exclusive" },
    // the debug registers (P3.8): 2 breakpoints, 2 watchpoints
    { name: "dbgbvr", offset: 1248, rust: "u64", count: 2, size: 16, owner: "core", range: "debug" },
    { name: "dbgbcr", offset: 1264, rust: "u64", count: 2, size: 16, owner: "core", range: "debug" },
    { name: "dbgwvr", offset: 1280, rust: "u64", count: 2, size: 16, owner: "core", range: "debug" },
    { name: "dbgwcr", offset: 1296, rust: "u64", count: 2, size: 16, owner: "core", range: "debug" },
    // waiting (WFI, WFE) and the event register
    { name: "waiting", offset: 1312, rust: "u32", size: 4, owner: "core", range: "wait", note: "0 running, 1 WFI, 2 WFE" },
    { name: "event_register", offset: 1316, rust: "u32", size: 4, owner: "core", range: "wait" },
    // the A64 page tier's activation (docs/jit-unification-plan.md P6, J2):
    // set by the runtime before each call, read by generated code at small
    // offsets (jitrt::step's StepAbi and pagegen::frame's AccessAbi)
    { name: "a64_page_exit", offset: 1328, rust: "u32", size: 4, owner: "scratch", note: "why the last page function returned (jitrt::step::EXIT_*)" },
    { name: "a64_page_chain", offset: 1332, rust: "u32", size: 4, owner: "scratch", note: "native instructions of the page functions an activation tail-called from" },
    { name: "a64_page_linear", offset: 1336, rust: "u64", size: 8, owner: "scratch", note: "virtual address of the page a page function runs at" },
    { name: "a64_jac_epoch", offset: 1344, rust: "u64", size: 8, owner: "scratch", note: "tag bits of the running core's access cache epoch" },
    { name: "a64_jac_base", offset: 1352, rust: "u32", size: 4, owner: "scratch", note: "access cache read table of the running core and EL" },
    { name: "a64_code_base", offset: 1356, rust: "u32", size: 4, owner: "scratch", note: "chaining table of the running core and EL" },
    // AArch32 at PL1 (cpu_type "arm32", docs/aarch32-plan.md R2): the current
    // mode's R0-R14 are X0-X14; the banked registers of the modes not current,
    // the modes' SPSRs, and the CP15 registers without an AArch64 home (DFSR
    // is ESR_EL1, DFAR and IFAR FAR_EL1's halves, PRRR and NMRR MAIR_EL1's,
    // the other system registers their AArch64 counterparts)
    { name: "a32_bank", offset: 1360, rust: "u32", count: 12, size: 48, owner: "core", range: "a32", note: "R13, R14 of USR (and SYS), FIQ, IRQ, SVC, ABT, UND while not current" },
    { name: "a32_bank_r8", offset: 1408, rust: "u32", count: 10, size: 40, owner: "core", range: "a32", note: "R8-R12 of the modes but FIQ, then FIQ's, while not current" },
    { name: "a32_spsr", offset: 1448, rust: "u32", count: 5, size: 20, owner: "core", range: "a32", note: "SPSR of FIQ, IRQ, SVC, ABT, UND" },
    { name: "a32_ttbcr", offset: 1468, rust: "u32", size: 4, owner: "core", range: "a32" },
    { name: "a32_dacr", offset: 1472, rust: "u32", size: 4, owner: "core", range: "a32" },
    { name: "a32_ifsr", offset: 1476, rust: "u32", size: 4, owner: "core", range: "a32" },
    { name: "a32_fpexc", offset: 1480, rust: "u32", size: 4, owner: "core", range: "a32", note: "FPEXC (EN: VFP and Advanced SIMD enabled)" },
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
    // the address space (P1.5): RAM's size, the regions, the map's generation,
    // guest memory, the status of the last read or write from JavaScript
    "aarch64/root.rs": { TEST_RETIRED: "debug" },
    // the interpreter's decode cache (keyed and checked by the instruction
    // word: valid in every instance), the decoder's mnemonic for the oracle
    // (and UNDEF telemetry; per core: the load-exclusive spin detection,
    // P3.9, and the stepped instruction's EX bit, P3.8)
    // (AArch32: the executing instruction's length, whether it was an IT)
    "aarch64/a32.rs": { INSTRUCTION_LENGTH: "scratch" },
    "aarch64/t32.rs": { IT_JUST_SET: "scratch" },
    "aarch64/execute.rs": { DECODE_CACHE: "cache", UNDEF_COUNTS: "debug", UNDEF_LAST: "debug", UNDEF_NEXT: "debug", SPIN: "core",
        STEPPED_EXCLUSIVE_LOADS: "core", STEPPED_EXCLUSIVE_LOAD: "scratch", STEPPED_CORE: "scratch",
        // (the page tier's step counters: the instruction interpret_one ran last)
        LAST_STEPPED: "debug" },
    // the profile's optional features (FEAT_PAN in v2)
    "aarch64/cpu.rs": { FEATURES: "machine" },
    // the AES S-boxes (read-only); SoftFloat's globals around each FP operation
    "aarch64/crypto.rs": { SBOX: "machine", INVERSE_SBOX: "machine" },
    "aarch64/fp.rs": { softfloat_roundingMode: "scratch", softfloat_exceptionFlags: "scratch" },
    // the debug fast paths, derived from the running core's registers
    "aarch64/debug.rs": { ANY_BREAKPOINT: "cache", ANY_WATCHPOINT: "cache" },
    // the GIC (P4.2): distributor, redistributors and CPU interfaces, each
    // core's interrupt request lines
    // (cores in workers: the GIC's lock, how deep this instance holds it;
    // GIC2: the GICv2 front end's own state, ranchu's and arm32's)
    "aarch64/gic.rs": { GIC: "machine", SIGNAL: "machine", LOCK: "machine", DEPTH: "scratch", GIC2: "machine" },
    // the granules of profile v1.1 (P3.4); the TTBR writes and ASID
    // changes (P9.3: counted, a64_asid_tag's auto mode reads their deltas)
    // and each core's last ASID; per core TLBs and the generation the fetch
    // fast path checks (P3.5)
    "aarch64/mmu.rs": { GRANULES: "machine", TTBR_WRITES: "debug", ASID_CHANGES: "cache", LAST_ASID: "cache" },
    // (cores in workers, P8.3: the TLB maintenance ring, the machine's; this
    // instance's progress through it and the entry its DSB waits for, its
    // batch since the last DSB, the kicks it sent; its counters)
    "aarch64/tlb.rs": { TLBS: "core", GENERATION: "cache", RING_NEXT: "machine", RING_ENTRIES: "machine", RING_ACKED: "machine",
        RING_SEEN: "core", PENDING: "core", BATCH: "core", BATCH_CODE: "core", BATCH_ALL: "core", KICKED_FOR: "cache", RING_STATS: "debug" },
    // the cooperative cores (P3.9): the saved state of the cores not
    // running, their pending events, the round robin, the global monitor
    // (P3.7); each core's event stream (P4.3)
    // (cores in workers: a kick ended the run, their count; a WFE's deadline;
    // the highest counter value any core read)
    "aarch64/smp.rs": { SAVED: "core", EVENTS: "machine", ROUND: "machine", MONITORS: "machine", MONITOR_GRANULE: "machine",
        KICKED: "debug", KICKED_NOW: "scratch", WFE_UNTIL: "core" },
    "aarch64/timer.rs": { EVENT_STREAM_LAST: "core", COUNTER_LAST: "machine" },
    // the A64 page tier (J2): its switches, functions and code pages, the
    // access caches and chaining tables per core (derived from the TLBs),
    // the code pages' translations, the flow a step asked for
    "aarch64/jit/mod.rs": { NEON: "machine", HELPERS: "machine", SYSTEM: "machine", RELAXED_FMA: "machine", FMA_FUSED: "machine", ASID_TAG: "machine",
        ASID_TAG_MODE: "machine", EXPLICIT: "machine", NAMES: "machine" },
    "aarch64/jit/pages.rs": { ENABLED: "machine", HOT: "machine", AARCH32: "machine", AARCH32_DEBUG: "machine", AARCH32_FILTER: "machine",
        ACCESS: "cache", CHAIN: "cache", CHAINING: "machine",
        CODE_TLB: "cache", RUNTIME: "machine", CODE_WRITES: "machine", STEP_FLOW: "scratch", WRITES: "debug", RESETS: "debug", HELPERS: "debug", EVICTIONS: "debug", COMPILE_MS: "debug", ASIDS: "cache",
        // (a64_asid_tag's auto window, P9.3; the parallel build's bounce slots for unaligned reads, P8.3)
        AUTO_TICKS: "cache", AUTO_LAST: "cache", AUTO_SWITCHES: "debug", BOUNCE: "scratch",
        // (the code budget, a64_page_code_mb, and the live functions' Wasm bytes against it)
        CODE_BUDGET_MB: "machine", LIVE_BYTES: "machine",
        // (diagnostics: the steps, context changes and helpers by instruction class and system register, every core's;
        // AArch32's helper calls by word, and the a64_page_aarch32_trace switch and its event ring)
        STEP_COUNTS: "debug", STEP_WORDS: "debug", SYSREG_COUNTS: "debug", SYS_COUNTS: "debug", HELPER_WORDS: "debug",
        A32_TRACE: "machine", TRACE: "debug", TRACE_AT: "debug",
        // (a helper that was done but asked the run loop for something: from the call to the function's exit)
        HELPER_DONE: "scratch",
        // (the access caches' refused fills by reason; the a64_reserved_fill and a64_step_stats switches; the
        // step counters' sampling, each instance's own)
        REFUSED: "debug", RESERVED_FILL_REFUSED: "machine", STEP_STATS: "machine", STEP_SAMPLED: "debug" },
    "aarch64/decode.rs": { BUFFER: "debug" },
    // PSCI: the cores' power states and pending CPU_ON starts, a SYSTEM_OFF
    // or SYSTEM_RESET request
    "aarch64/psci.rs": { POWER: "machine", START: "machine", REQUEST: "machine", SNAPSHOT: "scratch" },
    // (device memory, P7.1: where it starts, its pages written since their
    // device took them, the words handed out; cores in workers: the map's
    // sequence, odd while it changes, and the one this instance copied)
    "aarch64/bus.rs": { BUS: "machine", MEM8: "machine", MEM8_SIZE: "machine", MAP_CHANGED: "machine", STATUS: "scratch", LAST_WRITE: "debug",
        DEVICE_START: "machine", DEVICE_DIRTY: "machine", DEVICE_TAKEN: "scratch", MAP_SEQ: "machine", WORKER_SEQ: "cache" },
    // (extended RAM, P8.5: the instructions run from it)
    "aarch64/extended.rs": { RETIRED: "debug" },
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
    "cpu/execution.rs": { execution_state: "machine", LEDGER: "debug" },
    // both cores' per-core counters (docs/arm64-virt-android16-plan.md P1.10);
    // the pending ones are flushed into CORE_STATISTICS before every read,
    // reset and core switch
    "core_stats.rs": { CORE_STATISTICS: "core", PENDING_RETIRED: "scratch", PENDING_REP_ELEMENTS: "scratch" },
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
    // (unit tests')
    "jitrt/step.rs": { STATE: "debug" },
    "jitrt/access.rs": { CACHE: "debug", KEPT: "debug" },
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
    "profiler.rs": { stat_array: "debug" },
    // SoftFloat's C globals: set from the x87 control word before each operation
    "softfloat.rs": {
        X87_FAST_MATH: "machine", X87_POLICY_OBSERVER: "machine",
        softfloat_roundingMode: "scratch", extF80_roundingPrecision: "scratch", softfloat_exceptionFlags: "scratch",
    },
    "x64/physical.rs": { PHYSICAL_BUS: "machine" },
    // (LOCKED: the locked instruction in progress, within one instruction)
    "x64/memory.rs": { X64_TLBS: "core", LOCKED: "scratch" },
    // extended RAM: the frame pool and its lock; access caches holding frames
    // are released at the next safe point; aperture slots are remapped on demand
    "x64/extended.rs": { LEGACY_TLB_CACHED: "cache", SLOT_PAGE: "cache", NEXT: "cache" },
    // the engine both cores share (P8.5 moved it here from x64/extended.rs)
    "extended.rs": { EXTENDED: "machine", LOCK: "machine", DEPTH: "scratch", RELEASE_PENDING: "cache" },
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

function validate(fields)
{
    const sorted = [...fields].sort((a, b) => a.offset - b.offset);
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
export function core_ranges(fields = STATE_FIELDS)
{
    const sorted = [...fields].sort((a, b) => a.offset - b.offset);
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

function rust_consts(fields)
{
    const lines = [];
    for(const f of [...fields].sort((a, b) => a.offset - b.offset))
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

function rust_file(current, fields, name)
{
    const start = current.indexOf(BEGIN);
    const end = current.indexOf(END);
    assert.ok(start !== -1 && end > start, name + ": GENERATED markers missing");
    return current.slice(0, start + BEGIN.length) + rust_consts(fields) + current.slice(end);
}

function js_file(fields)
{
    const offsets = {};
    for(const f of [...fields].sort((a, b) => a.offset - b.offset))
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
${core_ranges(fields).map(([a, b]) => `    [${a}, ${b}],`).join("\n")}
];

/** [offset, size] of the core state that INIT keeps (the rest takes its reset value) */
export const INIT_PRESERVED = [
${init_preserved(fields).map(([a, b]) => `    [${a}, ${b}],`).join("\n")}
];
`;
}

/** [offset, size] of the fields marked init: "keep", adjacent ones merged */
function init_preserved(fields)
{
    const kept = [];
    for(const f of [...fields].sort((a, b) => a.offset - b.offset).filter(f => f.init === "keep"))
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
    validate(STATE_FIELDS);
    validate(A64_STATE_FIELDS);
    const check = process.argv.includes("--check");
    const rust_path = path.join(ROOT, "src/rust/cpu/global_pointers.rs");
    const a64_rust_path = path.join(ROOT, "src/rust/aarch64/state.rs");
    const outputs = [
        [rust_path, rust_file(fs.readFileSync(rust_path, "utf8"), STATE_FIELDS, "global_pointers.rs")],
        [path.join(ROOT, "src/state_layout.js"), js_file(STATE_FIELDS)],
        [a64_rust_path, rust_file(fs.readFileSync(a64_rust_path, "utf8"), A64_STATE_FIELDS, "aarch64/state.rs")],
        [path.join(ROOT, "src/arm/state_layout.js"), js_file(A64_STATE_FIELDS)],
    ];
    for(const [file, content] of outputs)
    {
        if(check) assert.equal(fs.existsSync(file) && fs.readFileSync(file, "utf8"), content, file + " is stale; run node gen/state_layout.js");
        else fs.writeFileSync(file, content);
    }
    check_statics();
    const core_bytes = fields => core_ranges(fields).reduce((n, [a, b]) => n + b - a, 0);
    console.log(`state layout: ${STATE_FIELDS.length} fields, per-core ranges ${JSON.stringify(core_ranges())} (${core_bytes(STATE_FIELDS)} bytes), ` +
        `${Object.values(STATICS).reduce((n, s) => n + Object.keys(s).length, 0)} Rust statics classified`);
    console.log(`ARM state layout: ${A64_STATE_FIELDS.length} fields, per-core ranges ${JSON.stringify(core_ranges(A64_STATE_FIELDS))} ` +
        `(${core_bytes(A64_STATE_FIELDS)} bytes)`);
}
