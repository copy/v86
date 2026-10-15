// The step profile (docs/jit-unification-plan.md P0.5): the instructions
// compiled code leaves to the interpreter, from the x64 page tier (and IR
// Tier-0 until P7.5 deleted it: stepper 0) in one store keyed by StepKey v1 (src/rust/step_profile.rs, which
// documents the layout). Turn it on with the JIT switch step_profile; it
// slows every step, so measure in rounds that are not timed.

export const MODES = ["real", "vm86", "prot16", "prot32", "compat16", "compat32", "long64"];
export const STEPPERS = ["tier0", "x64page", "event"];   // ("tier0": none since P7.5)
// Events that are not steps (stepper "event", docs/jit-unification-plan.md
// P4.0; src/rust/step_profile.rs's event module): the event, then names of
// its details by number
export const EVENTS = {
    1: ["miss", [null, "disabled", "no-code", "cold", "compiling", "compile", "recompile", "unserved", "shadow", "trap-flags",
        "breakpoints", "events", "halt"]],
    2: ["exit", [null, "retry", "unknown", "step", "budget", "leave"]],
    3: ["step-exit", [null, "halt", "yield", "shadow", "core-event", "code-write", "irq", "nmi", "barrier", "chainable"]],
    4: ["step-context", [null, "cpl", "cs", "mode", "cr0", "cr3", "cr4", "efer", "if", "tf", "ac", "vm", "rf", "iopl", "dr7", "epoch"]],
    // (5: IR Tier-0's starved pages, before P7.5)
    5: ["starved", [null, "pending", "other-cr3", "this-cr3"]],
    6: ["#NM", []],
    7: ["CLTS", []],
    8: ["CR0.TS", []],
    9: ["fxstate", ["FXSAVE", "FXRSTOR", "XSAVE", "XRSTOR"]],
    10: ["hpet-read", []],
    11: ["pm-timer-read", []],
    // (CPU frames, until M11 deleted the region scheduler's begin_cpu_frame)
    12: ["frame", []],
};
const MAPS = ["", "0F", "0F38", "0F3A"];
const PP = ["", "66", "F3", "F2"];

/** The fields of a StepKey */
export function step_key_fields(key)
{
    return {
        opcode: key & 0xFF,
        map: key >>> 8 & 3,
        vex_pp: key >>> 10 & 3,
        vex_l: !!(key & 1 << 12),
        vex: !!(key & 1 << 14),
        rep: !!(key & 1 << 16),
        retry: !!(key & 1 << 17),
        reg: key & 1 << 21 ? key >>> 18 & 7 : null,
        operand_size: !!(key & 1 << 22),
        repne: !!(key & 1 << 23),
        rex_w: !!(key & 1 << 24),
        mode: MODES[key >>> 25 & 7] ?? String(key >>> 25 & 7),
        stepper: STEPPERS[key >>> 28 & 3] ?? String(key >>> 28 & 3),
        isa: key >>> 30,
    };
}

/** A StepKey from fields (the defaults: a one-byte opcode stepped by the page tier in 32-bit protected mode) */
export function step_key({ opcode, map = 0, vex = false, vex_pp = 0, vex_l = false, rep = false, repne = false, retry = false,
    reg = null, operand_size = false, rex_w = false, mode = "prot32", stepper = "x64page", isa = 0 })
{
    const mode_index = MODES.indexOf(mode), stepper_index = STEPPERS.indexOf(stepper);
    if(mode_index < 0 || stepper_index < 0) throw new Error(`step_key: mode ${mode} or stepper ${stepper} unknown`);
    return (opcode & 0xFF | map << 8 | vex_pp << 10 | (vex_l ? 1 << 12 : 0) | (vex ? 1 << 14 : 0) | (rep || repne ? 1 << 16 : 0) |
        (retry ? 1 << 17 : 0) | (reg === null ? 0 : (reg & 7) << 18 | 1 << 21) | (operand_size ? 1 << 22 : 0) |
        (repne ? 1 << 23 : 0) | (rex_w ? 1 << 24 : 0) | mode_index << 25 | stepper_index << 28 | isa << 30) >>> 0;
}

/** "prot32 x64page 0F A2", "long64 x64page retry F3 66 VEX.256.66.0F38 18 /2", "long64 event exit leave" */
export function step_key_name(key)
{
    const f = step_key_fields(key);
    if(f.stepper === "event")
    {
        const [name, details] = EVENTS[key & 0xFF] ?? ["event " + (key & 0xFF), []];
        const detail = key >>> 8 & 0xFF;
        return [f.mode, "event", name, ...details[detail] ? [details[detail]] : detail ? [String(detail)] : []].join(" ");
    }
    const hex = n => n.toString(16).toUpperCase().padStart(2, "0");
    const parts = [f.mode, f.stepper];
    if(f.isa) parts.push("isa" + f.isa);
    if(f.retry) parts.push("retry");
    if(f.rep) parts.push(f.repne ? "F2" : "F3");
    if(f.operand_size) parts.push("66");
    if(f.rex_w && !f.vex) parts.push("REX.W");
    if(f.vex) parts.push(`VEX.${f.vex_l ? 256 : 128}${f.vex_pp ? "." + PP[f.vex_pp] : ""}.${MAPS[f.map]}${f.rex_w ? ".W1" : ""}`);
    else if(f.map) parts.push(MAPS[f.map]);
    parts.push(hex(f.opcode) + (f.reg === null ? "" : " /" + f.reg));
    return parts.join(" ");
}

/**
 * The profile of a core now, most stepped first: [{key, count, name}] (at
 * most `limit` rows; none while the profile is off)
 */
export function step_profile(exports, limit = Infinity)
{
    const rows = [];
    if(!exports["step_profile_snapshot"]) return rows;
    const size = exports["step_profile_snapshot"]();
    for(let i = 0; i < Math.min(size, limit); i++)
    {
        const key = exports["step_profile_key"](i) >>> 0;
        const row = { key, count: exports["step_profile_count"](i) >>> 0, name: step_key_name(key) };
        // (step keys: the last stepped instruction, its address and bytes)
        const address = exports["step_profile_sample"]?.(i, 0) >>> 0;
        if(address)
        {
            const word = n => exports["step_profile_sample"](i, n) >>> 0;
            const bytes = [word(1), word(2)].flatMap(w => [0, 8, 16, 24].map(s => (w >>> s & 255).toString(16).padStart(2, "0")));
            row.sample = { address: address.toString(16), bytes: bytes.join(" ") };
        }
        rows.push(row);
    }
    return rows;
}
