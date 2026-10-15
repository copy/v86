// The JIT switches in tests (docs/jit-unification-plan.md, cross-phase rule 1;
// src/jit_switches.js): JIT_SWITCHES="name=value,..." in the environment
// becomes the V86 option jit_switches, under a test's own values.

import { get_jit_switches, parse_jit_switches, set_jit_switches } from "../../src/jit_switches.js";

/** The switches of JIT_SWITCHES, { name: value } */
export function jit_switches_from_env(env = process.env)
{
    return parse_jit_switches(env["JIT_SWITCHES"] || "");
}

/** V86 options with the switches of JIT_SWITCHES added to their jit_switches */
export function with_jit_switches(options, env = process.env)
{
    const from_env = jit_switches_from_env(env);
    if(!Object.keys(from_env).length) return options;
    return { ...options, jit_switches: { ...from_env, ...parse_jit_switches(options.jit_switches) } };
}

function cpu_of(emulator)
{
    return emulator.v86 ? emulator.v86.cpu : emulator;
}

/** The switch values of an emulator (a V86, or its cpu) */
export function jit_switches_of(emulator)
{
    const cpu = cpu_of(emulator);
    return get_jit_switches(cpu.wm.exports, cpu.wasm_memory);
}

/** Sets switches of an emulator by name; throws like set_jit_switches */
export function set_emulator_jit_switches(emulator, values)
{
    const cpu = cpu_of(emulator);
    set_jit_switches(cpu.wm.exports, cpu.wasm_memory, values, "set_emulator_jit_switches");
}
