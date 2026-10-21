import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
// node tests/rust/x87_fast_path.mjs [baseline.wasm] [candidate.wasm]
// With a core built with the profiler feature (build/v86-profiler.wasm), the
// paths the F80 operations took are checked too, from the profiler's
// statistics; X87_PATHS=1 requires such a core.
const bios = Uint8Array.from(fs.readFileSync("build/x87-fast-test.bin")).buffer;
// (the stat enum's names in order: src/rust/profiler.rs)
const stats = fs.readFileSync(new URL("../../src/rust/profiler.rs", import.meta.url), "utf8")
    .match(/pub enum stat \{([^}]*)\}/)[1].replace(/\/\/.*$/gm, "").split(",").map(s => s.trim()).filter(Boolean);
const stat = name => { const index = stats.indexOf(name); assert(index >= 0, name); return index; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(wasm, interpreted, fast_math = false) {
    const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: wasm, bios: { buffer: bios }, memory_size: 32 << 20,
        disable_jit: interpreted, disable_keyboard: true, disable_mouse: true,
        x87_fast_math: fast_math,
        disable_speaker: true, net_device: { type: "none" }, autostart: false });
    try {
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        const e = vm.v86.cpu.wm.exports;
        if(process.env.X87_PATHS === "1") assert(e.profiler_is_enabled(), "X87_PATHS=1: " + wasm + " needs the profiler feature");
        const cycles = () => { const bytes = vm.read_memory(0x400, 2); return bytes[0] | bytes[1] << 8; };
        const until = async predicate => {
            const deadline = performance.now() + 10000;
            while(!predicate()) {
                assert(performance.now() < deadline, "x87 guest timed out");
                await sleep(10);
            }
        };
        vm.run();
        await until(() => cycles() >= 20 && (interpreted || vm.get_jit_info().ir.page_tier.native_instructions > 0));
        await vm.stop();
        if(e.profiler_is_enabled()) {
            const [exact, softfloat, native] = ["X87_EXACT", "X87_SOFTFLOAT", "X87_NATIVE_F64"].map(name => e.profiler_stat_get(stat(name)));
            const paths = JSON.stringify({ exact, softfloat, native });
            if(fast_math) assert(native > 0 && exact === 0 && softfloat === 0, "fast math: native f64 only " + paths);
            else assert(exact > 0 && softfloat > 0 && native === 0, "compatible: the exact path and SoftFloat both " + paths);
            checked_paths++;
        }
        const result = Uint8Array.from(vm.read_memory(0x500, 12 * (9 * 6 * 12 + 16 * 18 + 12 * 6)));
        const state = await vm.save_state();
        const before = cycles();
        vm.run();
        await until(() => cycles() > before + 5);
        await vm.stop();
        await vm.restore_state(state);
        assert.equal(e.get_x87_fast_math(), +fast_math, "guest state restore preserves selected host arithmetic policy");
        assert.equal(cycles(), before, "save/restore preserves the guest timeline");
        vm.run();
        await until(() => cycles() > before + 5);
        await vm.stop();
        assert.deepEqual(Uint8Array.from(vm.read_memory(0x500, result.length)), result,
            "x87 arithmetic after state restore preserves results and status words");
        return result;
    } finally { await vm.destroy(); }
}
let checked_paths = 0;
const candidate = process.argv[3] || "build/v86.wasm";
const interpreted = await run(candidate, true);
const jit = await run(candidate, false);
assert.deepEqual(jit, interpreted, "interpreter and actual JIT must match arithmetic/comparison and binary32 conversion results/status");
if(process.argv[2]) {
    assert.deepEqual(jit, await run(process.argv[2], false), "before/after Wasm results must match");
}
const fast_interpreted = await run(candidate, true, true);
const fast_jit = await run(candidate, false, true);
assert.deepEqual(fast_jit, fast_interpreted, "fast f64 interpreter/JIT results and state restore agree");
assert.notDeepEqual(fast_jit, jit, "extended precision/rounding cases expose the intentional semantic difference");
// Per control: nine pairs with four arithmetic results then two comparisons,
// followed by load/store conversion tests. These remain byte-for-byte intact.
const stride = 9 * 6 * 12 + 16 * 18 + 12 * 6;
for(let mode = 0; mode < 12; mode++) {
    for(let pair = 0; pair < 9; pair++) {
        const offset = mode * stride + pair * 72 + 48;
        assert.deepEqual(fast_jit.slice(offset, offset + 24), jit.slice(offset, offset + 24),
            "comparison semantics are unchanged");
    }
    assert.deepEqual(fast_jit.slice(mode * stride + 648, (mode + 1) * stride),
        jit.slice(mode * stride + 648, (mode + 1) * stride), "load/store conversion semantics are unchanged");
}
console.log("PASS: compatible and fast-f64 x87, all 12 controls, interpreter/JIT and save/restore; comparisons and conversions unchanged" +
    (process.argv[2] ? "; compatible mode matches previous Wasm" : "") +
    (checked_paths ? "; the paths taken (profiler statistics, " + checked_paths + " runs)" : ""));
