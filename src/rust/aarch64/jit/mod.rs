//! The A64 page tier (docs/jit-unification-plan.md P6, J2;
//! docs/arm64-virt-android16-plan.md P6): the runtime client (pages) and the
//! code generator (pagegen), the ARM core's composition of jitrt (with
//! crate::aarch64::root) and its switches (P6.0):
//!
//! - a64_page: compiled code runs (default off until its F gate)
//! - a64_page_hot: interpreted instructions on a page before it is compiled
//! - a64_neon: the AdvSIMD templates (P6.3b)
//! - a64_asid_tag: the ASID in the access cache's tags (P6.4: an epoch per
//!   ASID; 0, off: an ASID switch flushes the non-global entries; 2, auto,
//!   the default since the ARM plan's P9.3: on while the ASIDs change often)
//! - a64_helpers: helper calls for the forms pagegen::helper takes (off:
//!   single steps)
//! - a64_relaxed_fma: the multiply-adds through relaxed SIMD (only where the
//!   host fuses them; its default is the host's probe)
//! - a64_page_aarch32: AArch32's code (EL0's A32 and T32) compiled too
//!   (docs/aarch32-plan.md Q6; on since its gate, Q6.4); for bisecting,
//!   2: helper calls only (the native forms stepped), 3: the native forms
//!   only (helper calls stepped), 16 + a mask of native kinds run as helper
//!   calls (32 data processing, 64 MOVW and MOVT, 128 loads and stores, 256
//!   LDM and STM, 512 multiplies, 1024 extends)
//! - a64_page_aarch32_filter: (bisecting) n << 16 | pattern: only the
//!   AArch32 pages whose code key's low n bits are the pattern's are
//!   compiled, each named on the console
//! - a64_system: the EL1 system templates, a mask (pagegen::SYSTEM_*): bit 0
//!   MRS and MSR of SP_EL0, TPIDR_EL1, DAIF, ELR_EL1, SPSR_EL1, ESR_EL1,
//!   FAR_EL1, MRS DCZID_EL0, MSR DAIFSet and DAIFClr; 1 TLBI; 2 DC ZVA; 3 LDTR
//!   and STTR; 4 DSB with cores in workers when nothing is pending (0: helpers
//!   and steps, as before 2026-10-20)
//!
//! jitrt and pagegen never name this module (tools/check_a64_imports.mjs,
//! tools/check_x86tpl_imports.mjs).

pub mod pagegen;
pub mod pages;

/// AdvSIMD templates
pub static mut NEON: bool = true;
/// Helper calls instead of single steps for the forms pagegen::helper takes
pub static mut HELPERS: bool = true;
/// The EL1 system templates (a64_system's mask: pagegen::SYSTEM_*)
pub static mut SYSTEM: u32 = pagegen::SYSTEM_ALL;
/// The multiply-adds through relaxed SIMD (a64_relaxed_fma): only where the
/// host fuses them (a64_page_set_relaxed_fma_fused, the host's probe)
pub static mut RELAXED_FMA: bool = false;
static mut FMA_FUSED: bool = false;
#[no_mangle]
pub fn a64_page_set_relaxed_fma_fused(fused: bool) {
    unsafe {
        FMA_FUSED = fused;
        RELAXED_FMA = fused;
    }
}
/// The ASID in the access cache's tags (P6.4: an epoch per ASID,
/// pages::bind_asid; off, an ASID switch drops the non-global entries)
pub static mut ASID_TAG: bool = false;
/// a64_asid_tag: 0 off, 1 on, 2 auto (pages::asid_tag_tick: on while the
/// ASIDs change often, as with SW_TTBR0_PAN, which changes them at every
/// entry from EL0 and around every uaccess; the epochs cost a stock kernel,
/// whose ASIDs change seldom, refills of its global entries in each; auto
/// passed P9.3's F gate: the androidish kernel's boot to a login 30% faster,
/// the stock kernel's runs as with 0)
pub static mut ASID_TAG_MODE: u32 = 2;

// ---- the switch registry: the x86 core's interface (src/rust/jit_switches.rs,
// src/jit_switches.js), so the V86 option jit_switches and tests' JIT_SWITCHES
// set them by name

struct Switch {
    name: &'static str,
    default: u32,
    get: fn() -> u32,
    /// false: the value is refused
    set: fn(u32) -> bool,
}
const UNSET: u32 = u32::MAX;
const SWITCHES: [Switch; 13] = [
    Switch {
        name: "a64_page",
        default: 0,
        get: || unsafe { pages::ENABLED as u32 },
        set: |v| v <= 1 && unsafe { pages::ENABLED = v != 0 } == (),
    },
    Switch {
        name: "a64_page_hot",
        default: 2000,
        get: || unsafe { pages::HOT },
        set: |v| v >= 1 && unsafe { pages::HOT = v } == (),
    },
    Switch {
        name: "a64_neon",
        default: 1,
        get: || unsafe { NEON as u32 },
        set: |v| v <= 1 && unsafe { NEON = v != 0 } == (),
    },
    Switch {
        name: "a64_helpers",
        default: 1,
        get: || unsafe { HELPERS as u32 },
        set: |v| v <= 1 && unsafe { HELPERS = v != 0 } == (),
    },
    Switch {
        name: "a64_system",
        default: pagegen::SYSTEM_ALL,
        get: || unsafe { SYSTEM },
        set: |v| v <= pagegen::SYSTEM_ALL && unsafe { SYSTEM = v } == (),
    },
    Switch {
        name: "a64_relaxed_fma",
        default: 0,
        get: || unsafe { RELAXED_FMA as u32 },
        // (on only where the host fuses them)
        set: |v| {
            v <= 1 && (v == 0 || unsafe { FMA_FUSED }) && unsafe { RELAXED_FMA = v != 0 } == ()
        },
    },
    Switch {
        name: "a64_page_code_mb",
        default: 160,
        get: || unsafe { pages::CODE_BUDGET_MB },
        set: |v| v >= 8 && unsafe { pages::CODE_BUDGET_MB = v } == (),
    },
    Switch {
        name: "a64_page_aarch32",
        default: 1,
        get: || unsafe { pages::AARCH32 as u32 },
        set: |v| {
            v < 1 << 12
                && unsafe {
                    pages::AARCH32 = v != 0;
                    pages::AARCH32_DEBUG = v
                } == ()
        },
    },
    Switch {
        name: "a64_page_aarch32_filter",
        default: 0,
        get: || unsafe { pages::AARCH32_FILTER },
        set: |v| v < 32 << 16 && unsafe { pages::AARCH32_FILTER = v } == (),
    },
    Switch {
        name: "a64_page_aarch32_trace",
        default: 0,
        get: || unsafe { pages::A32_TRACE as u32 },
        set: |v| v <= 1 && unsafe { pages::A32_TRACE = v != 0 } == (),
    },
    Switch {
        name: "a64_reserved_fill",
        default: 0,
        get: || unsafe { pages::RESERVED_FILL_REFUSED as u32 },
        set: |v| v <= 1 && unsafe { pages::RESERVED_FILL_REFUSED = v != 0 } == (),
    },
    Switch {
        name: "a64_step_stats",
        default: 1,
        get: || unsafe { pages::STEP_STATS as u32 },
        set: |v| v <= 1 && unsafe { pages::STEP_STATS = v != 0 } == (),
    },
    Switch {
        name: "a64_asid_tag",
        default: 2,
        get: || unsafe { ASID_TAG_MODE },
        set: |v| v <= 2 && unsafe { ASID_TAG_MODE = v } == () && pages::set_asid_tag(v == 1) == (),
    },
];
static mut EXPLICIT: [u32; SWITCHES.len()] = [UNSET; SWITCHES.len()];
static mut NAMES: Option<String> = None;

#[no_mangle]
pub fn jit_switch_count() -> u32 { SWITCHES.len() as u32 }
#[no_mangle]
pub fn jit_switch(id: u32) -> u32 { SWITCHES.get(id as usize).map_or(UNSET, |s| (s.get)()) }
#[no_mangle]
pub fn jit_set_switch(id: u32, value: u32) -> bool {
    let Some(s) = SWITCHES.get(id as usize)
    else {
        return false;
    };
    if value == UNSET || !(s.set)(value) {
        return false;
    }
    unsafe { EXPLICIT[id as usize] = value };
    true
}
#[no_mangle]
pub fn jit_switch_explicit(id: u32) -> u32 {
    unsafe {
        (*(&raw const EXPLICIT))
            .get(id as usize)
            .copied()
            .unwrap_or(UNSET)
    }
}
/// The address of a text: 0, the switches ("name default\n" by id); 1, the
/// build-time defaults (none in the ARM core)
#[no_mangle]
pub fn jit_switch_text(which: u32) -> u32 { text(which).as_ptr() as u32 }
#[no_mangle]
pub fn jit_switch_text_length(which: u32) -> u32 { text(which).len() as u32 }
fn text(which: u32) -> &'static str {
    if which == 1 {
        return "";
    }
    unsafe {
        (*(&raw mut NAMES)).get_or_insert_with(|| {
            SWITCHES
                .iter()
                .map(|s| format!("{} {}\n", s.name, s.default))
                .collect()
        })
    }
}

/// The page tier's functions return the instructions they retired (the
/// table's Fn1Ret: called by index)
#[no_mangle]
pub fn call_indirect1_ret(f: fn(u16) -> i32, x: u16) -> i32 { f(x) }
