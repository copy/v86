#!/usr/bin/env node
// The step profile's events (docs/jit-unification-plan.md P4.0), counted on
// system_bench.mjs's guests: FXSAVE/FXRSTOR, CLTS, MOV CR0 changing TS and
// #NM as often as the guest executes them, whichever tier runs it; HPET and
// ACPI PM timer reads; why the x64 page tier's functions return (a retry, a
// step that ended the activation, why it did: CR0 changes are barriers,
// SYSCALL/SYSRETQ and MOV CR3 only change what P4.3's STEP_CHAIN may
// continue after); misses before the first compile; CPU frames. A step that
// continues (CPUID, IN) is no exit.
import assert from "node:assert/strict";
import {run, iterations, WARM} from "./system_bench.mjs";

const N = 4000;
const profile = {};
for(const name of ["base", "cpuid", "port_in", "retry", "hpet", "syscall", "mov_cr3", "fxsave", "cr0_ts", "nm"])
{
    const {records} = await run(name, N, {profile: true, inspect: name === "base" ? emulator => {
        // (a PM timer read: the guest has no PM base, read the device)
        for(let i = 0; i < 7; i++) emulator.v86.cpu.devices.acpi.pm_read(8, 4);
    } : undefined});
    profile[name] = records;
}
const count = (name, key) => profile[name].find(r => r.name === "long64 " + key)?.count ?? 0;
// (all iterations: the warm pass and the timed one; the timed pass runs compiled)
const all = name => WARM + iterations(name, N), timed = name => iterations(name, N);
const exactly = (name, key, expected) =>
    assert.equal(count(name, key), expected, `${name}: ${key}: ${JSON.stringify(profile[name].slice(0, 12))}`);
const at_least = (name, key, expected) =>
    assert.ok(count(name, key) >= expected, `${name}: ${key} ${count(name, key)} < ${expected}: ${JSON.stringify(profile[name].slice(0, 12))}`);
const below = (name, key, limit) =>
    assert.ok(count(name, key) < limit, `${name}: ${key} ${count(name, key)} >= ${limit}`);

// executed in every tier: exact
exactly("fxsave", "event fxstate FXSAVE", all("fxsave"));
exactly("fxsave", "event fxstate FXRSTOR", all("fxsave"));
exactly("cr0_ts", "event CLTS", all("cr0_ts"));
exactly("cr0_ts", "event CR0.TS", all("cr0_ts"));
exactly("nm", "event #NM", all("nm"));
exactly("nm", "event CLTS", all("nm"));
exactly("nm", "event CR0.TS", all("nm"));
exactly("hpet", "event hpet-read", all("hpet"));
exactly("base", "event pm-timer-read", 7);
// the x64 page tier's exits
at_least("retry", "event exit retry", timed("retry"));
at_least("hpet", "event exit retry", timed("hpet"));
at_least("cr0_ts", "event exit step", 2 * timed("cr0_ts"));
at_least("cr0_ts", "event step-exit barrier", 2 * timed("cr0_ts"));
at_least("cr0_ts", "event step-context cr0", 2 * timed("cr0_ts"));
at_least("syscall", "event step-exit chainable", 2 * timed("syscall"));
at_least("syscall", "event step-context cpl", 2 * timed("syscall"));
at_least("syscall", "event step-context cs", 2 * timed("syscall"));
at_least("mov_cr3", "event step-exit chainable", timed("mov_cr3"));
below("syscall", "event step-exit barrier", timed("syscall") / 10);
for(const name of ["cpuid", "port_in"]) below(name, "event exit step", timed(name) / 10);
at_least("cpuid", "x64page 0F A2", timed("cpuid"));
at_least("port_in", "x64page E4", timed("port_in"));
// misses before the compile, and HLT
at_least("base", "event miss cold", 1);
at_least("base", "event miss compile", 1);
// (no frame events since M11: the region scheduler's begin_cpu_frame noted them)
exactly("base", "event step-exit halt", 1);
console.log(`PASS: the step profile's events: FXSAVE/FXRSTOR, CLTS, CR0.TS, #NM, HPET and PM timer reads counted exactly; ` +
    `retries ${count("retry", "event exit retry")}, SYSCALL/SYSRETQ chainable step exits ${count("syscall", "event step-exit chainable")}, ` +
    `CR0 barriers ${count("cr0_ts", "event step-exit barrier")}, cold misses ${count("base", "event miss cold")}`);
