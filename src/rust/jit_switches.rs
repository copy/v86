//! One registry of the JIT switches (docs/jit-unification-plan.md, cross-phase
//! rule 1). Each A/B switch of the IR runtime and the x64 page tier has a name
//! here, so that the V86 option `jit_switches`, the tests (JIT_SWITCHES, read
//! by tests/lib/jit_switches.mjs) and build-time defaults (JIT_DEFAULTS) set
//! them one way, vCPU workers copy them and measurements can record them
//! (src/jit_switches.js). The older setters (x64_page_set_outline,
//! ir_cache_set_fusion, ...) stay as aliases: jit_switch reads a value however
//! it was set. The region tier's own settings (ir_auto_set_region_instructions,
//! ir_auto_config) are frozen with it (P7.6) and not listed; the engine's tail
//! calls (ir_t0_set_tail_calls) are a host capability, not a switch.
//!
//! Values apply in the order of SWITCHES: ir_tier0 resets ir_page_mode and
//! ir_page_threshold, so those follow it.

use crate::cpu::{cpu, execution};
use crate::ir::runtime::{cache, schedule, tier0};
use crate::step_profile;
use crate::x64::{pagegen, pages};

pub struct Switch {
    /// the name in jit_switches, JIT_SWITCHES and JIT_DEFAULTS
    pub name: &'static str,
    /// the value of a fresh instance, before src/cpu.js applies its settings
    pub default: u32,
    /// false: the value is out of range, or the module refuses the change now
    /// (most IR settings only change while nothing is compiled)
    set: unsafe fn(u32) -> bool,
    get: unsafe fn(&str) -> Option<u32>,
}

fn flag(value: u32) -> Option<bool> { (value <= 1).then_some(value == 1) }

pub const SWITCHES: &[Switch] = &[
    // the x64 page tier (crate::x64), and compatibility mode's helpers
    Switch {
        name: "x64_page",
        default: 1,
        set: |v| flag(v).map(pages::x64_page_set_enabled).is_some(),
        get: pages::switch_value,
    },
    Switch {
        name: "x64_chaining",
        default: 0,
        // (chained page functions end in a Wasm tail call)
        set: |v| match flag(v) {
            Some(on) if !on || tier0::tail_calls() => {
                unsafe { pages::x64_page_set_chaining(on) };
                true
            },
            _ => false,
        },
        get: pages::switch_value,
    },
    Switch {
        name: "x64_recompile_misses",
        default: 64,
        set: |v| {
            v >= 1 && {
                unsafe { pages::x64_page_set_recompile_misses(v) };
                true
            }
        },
        get: pages::switch_value,
    },
    // (docs/jit-unification-plan.md P4.5b, P4.5c)
    Switch {
        name: "x64_heat_batch",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { pages::x64_page_set_heat_batch(on) })
                .is_some()
        },
        get: pages::switch_value,
    },
    Switch {
        name: "x64_miss_run",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { pages::x64_page_set_miss_run(on) })
                .is_some()
        },
        get: pages::switch_value,
    },
    // (docs/jit-unification-plan.md P4.15: the access cache's entries per
    // table; the page tier recompiles)
    Switch {
        name: "x64_jac_entries",
        default: 2048,
        set: |v| unsafe {
            crate::x64::jac::set_entries(v as usize) && {
                pages::reset();
                true
            }
        },
        get: |_| Some(crate::x64::jac::entries() as u32),
    },
    // (docs/jit-unification-plan.md P4.14)
    Switch {
        name: "x64_hot_inline",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { pages::x64_page_set_hot_inline(on) })
                .is_some()
        },
        get: pages::switch_value,
    },
    Switch {
        // (the execution count of a cold page function that recompiles its
        // page with inline lookups: long after V8 optimized the cold one,
        // so that only pages that stay hot pay for a new function that
        // starts over in Liftoff; docs/jit-unification-plan.md appendix C, M5)
        name: "x64_hot_count",
        default: 1 << 22,
        set: |v| {
            v >= 1 && {
                unsafe { pages::set_hot_count(v) };
                true
            }
        },
        get: pages::switch_value,
    },
    // (P7.2b: x64_hot_count of 32-bit compatibility-mode functions)
    Switch {
        name: "x64_compat_hot_count",
        default: 1 << 16,
        set: |v| {
            v >= 1 && {
                unsafe { pages::set_compat_hot_count(v) };
                true
            }
        },
        get: pages::switch_value,
    },
    // (docs/jit-unification-plan.md P7.2: 32-bit compatibility-mode code in
    // the page tier instead of Tier-0)
    Switch {
        name: "x64_page_compat32",
        default: 0,
        set: |v| {
            flag(v)
                .map(|on| unsafe { pages::x64_page_set_compat32(on) })
                .is_some()
        },
        get: pages::switch_value,
    },
    // (P7.2: compatibility mode's memory operands in the 32-bit TLB, as
    // Tier-0's)
    Switch {
        name: "x64_compat_tlb",
        default: 1,
        set: |v| flag(v).map(pagegen::x64_page_set_compat_tlb).is_some(),
        get: pagegen::switch_value,
    },
    Switch {
        name: "x64_bucket_dispatch",
        default: 1,
        set: |v| flag(v).map(pagegen::x64_page_set_bucket_dispatch).is_some(),
        get: pagegen::switch_value,
    },
    Switch {
        name: "x64_block_count",
        default: 1,
        set: |v| flag(v).map(pagegen::x64_page_set_block_count).is_some(),
        get: pagegen::switch_value,
    },
    Switch {
        name: "x64_outline",
        default: 1,
        set: |v| flag(v).map(pagegen::x64_page_set_outline).is_some(),
        get: pagegen::switch_value,
    },
    Switch {
        name: "x64_cvt",
        default: 1,
        set: |v| flag(v).map(pagegen::x64_page_set_cvt).is_some(),
        get: pagegen::switch_value,
    },
    Switch {
        name: "x64_loops",
        default: 2,
        // (2: only in compiles with inline lookups, P4.14's hot recompiles)
        set: pagegen::set_loops,
        get: pagegen::switch_value,
    },
    Switch {
        name: "x64_xmm_locals",
        default: 1,
        set: |v| flag(v).map(pagegen::x64_page_set_xmm_locals).is_some(),
        get: pagegen::switch_value,
    },
    // (docs/jit-unification-plan.md P4.23)
    Switch {
        name: "x64_exit_flags",
        default: 1,
        set: |v| flag(v).map(pagegen::x64_page_set_exit_flags).is_some(),
        get: pagegen::switch_value,
    },
    // (docs/jit-unification-plan.md P4.22; functions of either kind must
    // not chain to each other)
    Switch {
        name: "x64_fast_chain",
        default: 0,
        set: |v| {
            flag(v)
                .map(|on| {
                    pagegen::x64_page_set_fast_chain(on);
                    pages::reset();
                })
                .is_some()
        },
        get: pagegen::switch_value,
    },
    // (docs/jit-unification-plan.md P4.21)
    Switch {
        name: "x64_fast_lookup",
        default: 1,
        set: |v| flag(v).map(pagegen::x64_page_set_fast_lookup).is_some(),
        get: pagegen::switch_value,
    },
    // (docs/jit-unification-plan.md P4.20)
    Switch {
        name: "x64_i32_ops",
        default: 1,
        set: |v| flag(v).map(pagegen::x64_page_set_i32_ops).is_some(),
        get: pagegen::switch_value,
    },
    // (docs/jit-unification-plan.md P4.18)
    Switch {
        name: "x64_sse_fast_check",
        default: 1,
        set: |v| flag(v).map(pagegen::x64_page_set_sse_fast_check).is_some(),
        get: pagegen::switch_value,
    },
    Switch {
        name: "x64_sti_shadow",
        default: 1,
        set: |v| flag(v).map(pagegen::x64_page_set_sti_shadow).is_some(),
        get: pagegen::switch_value,
    },
    // (docs/jit-unification-plan.md P4.6)
    Switch {
        name: "x64_long_visit",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { crate::ir::runtime::schedule::x64_set_long_visit(on) })
                .is_some()
        },
        get: |_| Some(crate::ir::runtime::schedule::long_visit_enabled() as u32),
    },
    Switch {
        name: "x64_compat_jit",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { cpu::x64_set_compat_jit(on) })
                .is_some()
        },
        get: |_| Some(unsafe { cpu::compat_jit() } as u32),
    },
    // IR Tier-0 and the scheduler (crate::ir::runtime)
    Switch {
        name: "ir_tier0",
        default: 0,
        set: |v| unsafe { schedule::ir_auto_set_tier0(v) },
        get: schedule::switch_value,
    },
    Switch {
        name: "ir_page_mode",
        default: 0,
        set: |v| unsafe { schedule::ir_auto_set_page_mode(v) },
        get: schedule::switch_value,
    },
    Switch {
        name: "ir_page_threshold",
        default: 512,
        set: |v| unsafe { schedule::ir_auto_set_page_threshold(v) },
        get: schedule::switch_value,
    },
    Switch {
        name: "ir_t0_ranges",
        default: 0,
        set: |v| v <= 1 && unsafe { schedule::ir_t0_set_ranges(v) },
        get: schedule::switch_value,
    },
    Switch {
        name: "ir_t0_clusters",
        default: 1,
        set: |v| flag(v).map(schedule::set_t0_clusters).is_some(),
        get: schedule::switch_value,
    },
    Switch {
        name: "ir_t0_link",
        default: 0,
        set: |v| unsafe { tier0::ir_t0_set_link_mode(v) },
        get: |_| {
            Some(match tier0::t0_link() {
                tier0::Link::Iterative => 0,
                tier0::Link::Nested => 1,
                tier0::Link::Tail => 2,
            })
        },
    },
    Switch {
        name: "ir_t0_irq_deferral",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_irq_deferral(on) })
                .is_some()
        },
        get: |_| Some(tier0::irq_deferral() as u32),
    },
    Switch {
        name: "ir_relaxed_fma",
        default: 0,
        set: |v| unsafe { tier0::ir_set_relaxed_fma(v) },
        get: |_| Some(unsafe { tier0::ir_relaxed_fma() }),
    },
    Switch {
        name: "ir_hot_filter",
        default: 0,
        set: |v| unsafe { schedule::ir_auto_set_hot_filter(v) },
        get: schedule::switch_value,
    },
    Switch {
        name: "ir_hot_capacity",
        default: 128,
        set: |v| unsafe { schedule::ir_auto_set_hot_capacity(v) },
        get: schedule::switch_value,
    },
    Switch {
        name: "ir_heat_steps",
        default: 4096,
        set: |v| unsafe { schedule::ir_auto_set_heat_steps(v) },
        get: schedule::switch_value,
    },
    Switch {
        name: "ir_direct_tier2",
        default: 0,
        set: |v| {
            v <= 1 && {
                unsafe { schedule::ir_auto_set_direct_tier2(v) };
                true
            }
        },
        get: schedule::switch_value,
    },
    Switch {
        name: "ir_idle_mode",
        default: 0,
        set: |v| unsafe {
            schedule::ir_auto_set_idle_mode(
                v,
                schedule::switch_value("ir_idle_sync_ms").unwrap_or(16),
            )
        },
        get: schedule::switch_value,
    },
    Switch {
        name: "ir_idle_sync_ms",
        default: 16,
        set: |v| unsafe {
            schedule::ir_auto_set_idle_mode(schedule::switch_value("ir_idle_mode").unwrap_or(0), v)
        },
        get: schedule::switch_value,
    },
    Switch {
        name: "ir_resident_promotion",
        default: 0,
        set: |v| unsafe { cache::ir_cache_set_resident_promotion(v) },
        get: schedule::switch_value,
    },
    // the IR cache (crate::ir::runtime::cache)
    Switch {
        name: "ir_cache_capacity",
        default: 768,
        set: |v| unsafe { cache::ir_cache_set_capacity(v) },
        get: cache::switch_value,
    },
    Switch {
        name: "ir_fast_validation",
        default: 1,
        set: |v| unsafe { cache::ir_cache_set_fast_validation(v) },
        get: cache::switch_value,
    },
    Switch {
        name: "ir_warm_chaining",
        default: 1,
        set: |v| unsafe { cache::ir_cache_set_warm_chaining(v) },
        get: cache::switch_value,
    },
    Switch {
        name: "ir_fusion",
        default: 0,
        set: |v| unsafe { cache::ir_cache_set_fusion(v) },
        get: cache::switch_value,
    },
    Switch {
        name: "ir_merged_validation",
        default: 1,
        set: |v| unsafe { cache::ir_cache_set_merged_validation(v) },
        get: cache::switch_value,
    },
    Switch {
        name: "ir_missing_hint",
        default: 1,
        set: |v| unsafe { cache::ir_cache_set_missing_hint(v) },
        get: cache::switch_value,
    },
    Switch {
        name: "ir_poll_reuse",
        default: 1,
        set: |v| unsafe { cache::ir_cache_set_poll_reuse(v) },
        get: cache::switch_value,
    },
    Switch {
        name: "ir_strict_validation",
        default: 0,
        set: |v| unsafe { cache::ir_cache_set_strict_validation(v) },
        get: cache::switch_value,
    },
    // measurement: the step profile of both tiers (crate::step_profile)
    Switch {
        name: "step_profile",
        default: 0,
        set: |v| {
            flag(v)
                .map(|on| unsafe { step_profile::set_enabled(on) })
                .is_some()
        },
        get: |_| Some(step_profile::enabled() as u32),
    },
    // measurement: retired instructions by mode and how they ran
    // (crate::cpu::execution's mode ledger)
    Switch {
        name: "mode_ledger",
        default: 0,
        set: |v| {
            flag(v)
                .map(|on| unsafe { execution::set_ledger(on) })
                .is_some()
        },
        get: |_| Some(execution::ledger_on() as u32),
    },
    // Tier-0's template changes of P3 (docs/jit-unification-plan.md P3.7),
    // each off until its A/B flips it (P3.7(a)'s six: on, after their A/B as
    // a group; P3.7(b)'s t0_sreg_load, P3.7(c)'s three and P3.1's two: on);
    // page functions compiled before a change keep their code
    Switch {
        name: "t0_jecxz",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_JECXZ, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_JECXZ)),
    },
    Switch {
        name: "t0_sreg_read",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_SREG_READ, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_SREG_READ)),
    },
    Switch {
        name: "t0_xchg_mem",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_XCHG_MEM, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_XCHG_MEM)),
    },
    Switch {
        name: "t0_cld_std",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_CLD_STD, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_CLD_STD)),
    },
    Switch {
        name: "t0_pop_rm",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_POP_RM, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_POP_RM)),
    },
    Switch {
        name: "t0_pusha",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_PUSHA, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_PUSHA)),
    },
    Switch {
        name: "t0_sreg_load",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_SREG_LOAD, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_SREG_LOAD)),
    },
    Switch {
        name: "t0_vec_store_slow",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_VEC_STORE_SLOW, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_VEC_STORE_SLOW)),
    },
    Switch {
        name: "t0_cli",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_CLI, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_CLI)),
    },
    Switch {
        name: "t0_pop_esp",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_POP_ESP, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_POP_ESP)),
    },
    Switch {
        name: "t0_rep_blocks",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_REP_BLOCKS, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_REP_BLOCKS)),
    },
    Switch {
        name: "t0_rep_movs_stos",
        default: 1,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_feature(tier0::T0_REP_MOVS_STOS, on) })
                .is_some()
        },
        get: |_| Some(tier0::feature_value(tier0::T0_REP_MOVS_STOS)),
    },
    // measurement: the executions of what Tier-0 compiles from now on, by
    // template kind (ir::runtime::tier0::kind_profile)
    Switch {
        name: "t0_kind_profile",
        default: 0,
        set: |v| {
            flag(v)
                .map(|on| unsafe { tier0::set_kind_profile(on) })
                .is_some()
        },
        get: |_| Some(tier0::kind_profile_on() as u32),
    },
];

const COUNT: usize = SWITCHES.len();
const UNSET: u32 = u32::MAX;

/// name=value pairs, comma separated, set at build time (Makefile JIT_DEFAULTS)
const BUILD_DEFAULTS: &str = match option_env!("JIT_DEFAULTS") {
    Some(defaults) => defaults,
    None => "",
};

/// The values set through jit_set_switch, which vCPU workers copy (UNSET:
/// never set here)
static mut EXPLICIT: [u32; COUNT] = [UNSET; COUNT];
/// In a vCPU worker: the machine's values it applied last
static mut COPIED: [u32; COUNT] = [UNSET; COUNT];
/// "name default\n" for each switch, by id (jit_switch_text)
static mut NAMES: Option<String> = None;

#[no_mangle]
pub fn jit_switch_count() -> u32 { COUNT as u32 }

/// The value of switch `id`, or u32::MAX for an unknown id or a value that
/// cannot be read now (a module busy compiling)
#[no_mangle]
pub unsafe fn jit_switch(id: u32) -> u32 {
    match SWITCHES.get(id as usize) {
        Some(s) => (s.get)(s.name).unwrap_or(UNSET),
        None => UNSET,
    }
}

#[no_mangle]
pub unsafe fn jit_set_switch(id: u32, value: u32) -> bool {
    let Some(s) = SWITCHES.get(id as usize)
    else {
        return false;
    };
    if value == UNSET || !(s.set)(value) {
        return false;
    }
    EXPLICIT[id as usize] = value;
    true
}

/// The value last set through jit_set_switch, or u32::MAX (what a vCPU worker
/// is started with, src/browser/starter.js)
#[no_mangle]
pub unsafe fn jit_switch_explicit(id: u32) -> u32 {
    if (id as usize) < COUNT {
        EXPLICIT[id as usize]
    }
    else {
        UNSET
    }
}

/// The address of a text: 0, the switches ("name default\n" by id); 1, the
/// build-time defaults (JIT_DEFAULTS)
#[no_mangle]
pub unsafe fn jit_switch_text(which: u32) -> u32 { text(which).as_ptr() as u32 }
#[no_mangle]
pub unsafe fn jit_switch_text_length(which: u32) -> u32 { text(which).len() as u32 }

unsafe fn text(which: u32) -> &'static str {
    if which == 1 {
        return BUILD_DEFAULTS;
    }
    (*(&raw mut NAMES)).get_or_insert_with(|| {
        SWITCHES
            .iter()
            .map(|s| format!("{} {}\n", s.name, s.default))
            .collect()
    })
}

/// In a vCPU worker (cpu::copy_machine_configuration): apply the values set on
/// the machine instance since the last call, each change once
pub unsafe fn copy_from_machine() {
    if crate::parallel::machine_instance() {
        return;
    }
    let explicit = *crate::parallel::machine(&raw mut EXPLICIT);
    for id in 0..COUNT {
        let value = explicit[id];
        if value != UNSET && value != COPIED[id] {
            COPIED[id] = value;
            (SWITCHES[id].set)(value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique_and_defaults_in_range() {
        for (i, s) in SWITCHES.iter().enumerate() {
            assert!(
                SWITCHES[..i].iter().all(|t| t.name != s.name),
                "{} twice",
                s.name
            );
            assert!(s.default != UNSET, "{}", s.name);
            assert!(
                s.name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
                "{}",
                s.name
            );
        }
    }

    #[test]
    fn build_defaults_name_switches() {
        for pair in BUILD_DEFAULTS
            .split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            let (name, value) = pair
                .split_once('=')
                .expect("JIT_DEFAULTS: name=value pairs");
            assert!(
                SWITCHES.iter().any(|s| s.name == name.trim()),
                "JIT_DEFAULTS: unknown switch {}",
                name
            );
            value.trim().parse::<u32>().expect("JIT_DEFAULTS: a number");
        }
    }
}
