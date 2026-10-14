// The execution modes of the SMP tests (SMP_MODES; docs/jit-unification-plan.md
// M7 acceptance: the SMP matrix includes the page tier). "pages" is the
// default configuration since Legacy32's flip: 32-bit protected-mode code in
// the x64 page tier (x64_page_legacy32); "tier0" and "region" pin the page
// tier off, so that they still run those engines.

import { with_jit_switches } from "./jit_switches.mjs";

export const SMP_MODES = ["interpreter", "tier0", "region", "pages"];

/** The modes of SMP_MODES, else `fallback` */
export function smp_modes(fallback = SMP_MODES, env = process.env)
{
    const modes = env.SMP_MODES ? env.SMP_MODES.split(",") : fallback;
    if(!modes.every(mode => SMP_MODES.includes(mode))) throw new Error("SMP_MODES: " + SMP_MODES.join(", "));
    return modes;
}

/**
 * V86 options with `mode`'s ir_tier0 and JIT switches (and JIT_SWITCHES); with
 * `eager`, the page tier compiles a page after a few instructions, as the
 * fixtures' Tier-0 does (ir_auto_set_page_threshold(2))
 */
export function with_smp_mode(options, mode, eager = true)
{
    const switches = mode === "tier0" || mode === "region" ? { x64_page_legacy32: 0 } : mode === "pages" && eager ? { x64_legacy_heat: 2 } : {};
    return with_jit_switches({
        ...options,
        ir_tier0: mode === "tier0" || mode === "pages",
        jit_switches: { ...switches, ...options.jit_switches },
    });
}

/** Compiled execution so far: region and Tier-0 entries, and instructions the page tier ran natively */
export function compiled_hits(exports)
{
    return ((exports.ir_cache_stat(2) >>> 0) + (exports.ir_t0_entries() >>> 0) + (exports.x64_page_stat(1) >>> 0)) >>> 0;
}

/** Compiled execution in `mode`'s own engine (compiled_hits for the interpreter) */
export function mode_hits(exports, mode)
{
    switch(mode)
    {
        case "tier0": return exports.ir_t0_entries() >>> 0;
        case "region": return exports.ir_cache_stat(2) >>> 0;
        case "pages": return exports.x64_page_stat(1) >>> 0;
        default: return compiled_hits(exports);
    }
}

/** Code at linear (= physical) `address` is published: a region or Tier-0 entry, or a page function of its page */
export function published(exports, address)
{
    return !!exports.ir_cache_entry_stat(address, 0, 1, 0) || !!exports.x64_page_published(address);
}
