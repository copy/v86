#!/usr/bin/env node

// The JIT switch registry (docs/jit-unification-plan.md, cross-phase rule 1;
// src/rust/jit_switches.rs, src/jit_switches.js):
// - a module on its own reads each switch's default, refuses unknown ids,
//   unknown names and values out of range, and reads back what it set;
// - JIT_SWITCHES and the V86 option jit_switches set switches by name over
//   the settings configure_jit_backend applied; an unknown name fails the
//   construction.

import assert from "node:assert/strict";
import fs from "node:fs";
import url from "node:url";
import { WASM_TABLE_OFFSET, WASM_TABLE_SIZE } from "../../src/const.js";
import { get_jit_switches, jit_switch_table, parse_jit_switches, set_jit_switches } from "../../src/jit_switches.js";
import { jit_switches_from_env, jit_switches_of, set_emulator_jit_switches, with_jit_switches } from "../lib/jit_switches.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const WASM = __dirname + "/../../build/" + (TEST_RELEASE_BUILD ? "v86.wasm" : "v86-debug.wasm");

process.on("unhandledRejection", exn => { throw exn; });

// A module on its own
{
    const module = await WebAssembly.compile(fs.readFileSync(WASM));
    const env = {};
    for(const { name, kind } of WebAssembly.Module.imports(module))
    {
        env[name] = kind === "table" ? new WebAssembly.Table({ element: "anyfunc", initial: WASM_TABLE_SIZE + WASM_TABLE_OFFSET }) : () => 0;
    }
    const { exports } = await WebAssembly.instantiate(module, { env });
    exports["rust_init"]();
    const memory = exports.memory;

    const table = jit_switch_table(exports, memory);
    assert.equal(table.length, exports["jit_switch_count"]());
    assert.ok(table.length >= 28, "switches: " + table.map(s => s.name).join(" "));
    table.forEach(({ name, default: value }, id) => assert.equal(exports["jit_switch"](id) >>> 0, value, name + ": the default"));
    assert.equal(exports["jit_switch"](table.length) >>> 0, 0xFFFFFFFF);
    assert.equal(exports["jit_set_switch"](table.length, 0), 0);
    assert.deepEqual(get_jit_switches(exports, memory, true), {});

    set_jit_switches(exports, memory, { x64_outline: 0, x64_block_count: false, x64_legacy_heat: 1000, x64_span_entries: 40 });
    const now = get_jit_switches(exports, memory);
    assert.equal(now.x64_outline, 0);
    assert.equal(now.x64_block_count, 0);
    assert.equal(now.x64_legacy_heat, 1000);
    assert.equal(now.x64_span_entries, 40);
    assert.equal(now.x64_span_crossings, 4096, "x64_span_entries keeps x64_span_crossings");
    assert.deepEqual(get_jit_switches(exports, memory, true), { x64_outline: 0, x64_block_count: 0, x64_legacy_heat: 1000, x64_span_entries: 40 });
    // (an old setter is an alias: jit_switch reads what it set)
    exports["x64_page_set_outline"](1);
    assert.equal(get_jit_switches(exports, memory).x64_outline, 1);

    assert.throws(() => set_jit_switches(exports, memory, { x64_outline: 2 }), /x64_outline cannot be 2/);
    assert.throws(() => set_jit_switches(exports, memory, { x64_legacy_heat: 0 }), /x64_legacy_heat cannot be 0/);
    assert.throws(() => set_jit_switches(exports, memory, { no_such_switch: 1 }), /no JIT switch no_such_switch/);
    // (chained page functions need tail calls, which src/cpu.js reports)
    assert.throws(() => set_jit_switches(exports, memory, { x64_chaining: 1 }), /x64_chaining cannot be 1/);
    exports["jit_set_tail_calls"](1);
    set_jit_switches(exports, memory, { x64_chaining: 1 });
    set_jit_switches(exports, memory, { x64_chaining: 0 });
    assert.equal(get_jit_switches(exports, memory).x64_chaining, 0);
    console.log(`${table.length} switches: defaults, round trips and refusals`);
}

// Parsing, and JIT_SWITCHES
assert.deepEqual(parse_jit_switches("a=1, b = 0,c_2=7"), { a: 1, b: 0, c_2: 7 });
assert.deepEqual(parse_jit_switches({ a: true, b: false, c: 3 }), { a: 1, b: 0, c: 3 });
assert.deepEqual(parse_jit_switches(undefined), {});
assert.throws(() => parse_jit_switches("a"), /expected name=value/);
assert.throws(() => parse_jit_switches("a=-1"), /expected name=value/);
assert.deepEqual(jit_switches_from_env({ JIT_SWITCHES: "x64_outline=0" }), { x64_outline: 0 });
assert.deepEqual(with_jit_switches({ jit_switches: { x64_loops: 1 } }, { JIT_SWITCHES: "x64_outline=0,x64_loops=0" }).jit_switches,
    { x64_outline: 0, x64_loops: 1 }, "a test's own value wins over JIT_SWITCHES");
assert.deepEqual(with_jit_switches({ memory_size: 1 }, {}), { memory_size: 1 });

// The V86 option
const config = {
    graphics_adapter: "none",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    autostart: false,
    memory_size: 32 * 1024 * 1024,
    log_level: 0,
};

function load(options)
{
    const emulator = new V86(options);
    return new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", () => resolve(emulator));
        emulator.add_listener("emulator-error", error => { emulator.destroy(); reject(error); });
    });
}

{
    const emulator = await load({ ...config, jit_switches: "x64_outline=0, x64_legacy_heat=1000" });
    const values = jit_switches_of(emulator);
    assert.equal(values.x64_outline, 0);
    assert.equal(values.x64_legacy_heat, 1000);
    // (not named: as configure_jit_backend left them; the region tiers'
    // switches went with them in M11)
    assert.equal(values.ir_tier0, 1);
    assert.equal(values.x64_page_legacy32, 1);
    assert.equal(values.x64_page_prot16, 1);
    assert.equal(values.x64_page_v86, 1);
    set_emulator_jit_switches(emulator, { x64_outline: 1 });
    assert.equal(jit_switches_of(emulator).x64_outline, 1);
    await emulator.destroy();
    console.log("the option jit_switches");
}

await assert.rejects(load({ ...config, jit_switches: { no_such_switch: 1 } }), /no JIT switch no_such_switch/);
await assert.rejects(load({ ...config, jit_switches: { x64_legacy_heat: 0 } }), /x64_legacy_heat cannot be 0/);
console.log("unknown names and refused values fail the construction");
console.log("Done");
