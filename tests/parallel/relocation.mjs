#!/usr/bin/env node
// Relocated instances (docs/multicore.md): the same Wasm module runs on
// two independent state bases without crosstalk. Two machines share one
// memory: A is v86-parallel.wasm at base 0, B a relocated instance of it
// (src/parallel/relocate.js) with its own statics, stack, CPU state block,
// JIT and heap. Both boot Linux and run in one thread, interleaved by the
// event loop, with compiled code; A with two cooperative cores. Their results
// must match the reference values, and a snapshot of B must restore into B.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { PARALLEL_WASM, Shell, linux4_options, value_of } from "./guest.mjs";
import { instantiate_relocated, memory_import, relocations, STATE_SLOT_SIZE } from "../../src/parallel/relocate.js";

const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const bytes = new Uint8Array(fs.readFileSync(PARALLEL_WASM));
assert.ok(memory_import(bytes)?.shared, "the parallel build imports a shared memory");
const table = relocations(bytes);
console.log(`relocation table: ${table.uleb5.length} offsets, ${table.sleb5.length} constants, ${table.u32.length} data pointers; ` +
    `of the state block ${table.uleb5_state.length}, ${table.sleb5_state.length}, ${table.u32_state.length}`);

const timeout = setTimeout(() => { console.log("timeout"); process.exit(1); }, 900000);

const a = new V86({ graphics_adapter: "bochs_vga", ...linux4_options(), wasm_path: PARALLEL_WASM, memory_size: 128 << 20, cpu_cores: 2, experimental_smp_jit: true });
await new Promise(resolve => a.add_listener("emulator-loaded", resolve));
const memory = a.v86.cpu.wasm_memory;
assert.ok(memory.buffer instanceof SharedArrayBuffer);

let base_b = 0;
const b = new V86({
    graphics_adapter: "bochs_vga",
    ...linux4_options(), memory_size: 96 << 20,
    wasm_fn: async env => {
        const { instance, base } = await instantiate_relocated(bytes, env, memory, 1);
        base_b = base;
        return instance.exports;
    },
});
await new Promise(resolve => b.add_listener("emulator-loaded", resolve));
const cpu_a = a.v86.cpu, cpu_b = b.v86.cpu;
assert.equal(cpu_b.wasm_memory, memory, "one memory");
assert.ok(base_b > 0 && cpu_a.state_base === 0 && cpu_b.state_base === STATE_SLOT_SIZE,
    "the state blocks are in slots 0 (A, where v86.wasm has it) and 1 (B)");
assert.notEqual(cpu_a.mem8.byteOffset, cpu_b.mem8.byteOffset);
assert.ok(cpu_b.mem8.byteOffset + cpu_b.mem8.length <= cpu_a.mem8.byteOffset ||
    cpu_a.mem8.byteOffset + cpu_a.mem8.length <= cpu_b.mem8.byteOffset, "guest RAM of A and B does not overlap");
console.log(`A: state ${cpu_a.state_base}, RAM ${cpu_a.mem8.byteOffset >>> 20} MiB; B: base ${base_b >>> 20} MiB, state ${cpu_b.state_base}, RAM ${cpu_b.mem8.byteOffset >>> 20} MiB`);

const shell_a = new Shell(a, "A"), shell_b = new Shell(b, "B");
const t0 = Date.now();
await Promise.all([shell_a.boot(), shell_b.boot()]);
console.log(`both booted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// work with a known result, in both machines at once
let expected_sum = 0;
for(let i = 0; i < 20000; i++) expected_sum = (expected_sum * 31 + i) % 1000003;
const expected_md5 = crypto.createHash("md5").update(Buffer.alloc(2 << 20, "x")).digest("hex");
const WORK = "i=0; s=0; while [ $i -lt 20000 ]; do s=$(((s * 31 + i) % 1000003)); i=$((i+1)); done; echo SUM=$s; " +
    "echo MD5=$(dd if=/dev/zero bs=64k count=32 2>/dev/null | tr '\\0' 'x' | md5sum | cut -d' ' -f1); echo CPUS=$(grep -c ^processor /proc/cpuinfo)";
for(let round = 1; round <= 3; round++)
{
    const [out_a, out_b] = await Promise.all([shell_a.run(WORK), shell_b.run(WORK)]);
    for(const [name, out, cpus] of [["A", out_a, 2], ["B", out_b, 1]])
    {
        assert.equal(+value_of(out, "SUM"), expected_sum, name + ": shell arithmetic");
        assert.equal(value_of(out, "MD5"), expected_md5, name + ": md5sum");
        assert.equal(+value_of(out, "CPUS"), cpus, name + ": cores");
    }
    console.log(`round ${round}: A and B computed the reference results`);
}

// a snapshot of the relocated instance restores into it while A keeps running
const busy_a = shell_a.run(WORK);
await b.stop();
const state = await b.save_state();
await b.run();
await shell_b.run("echo 12345 > /tmp/marker; echo WROTE=1");
await b.stop();
await b.restore_state(state);
await b.run();
const after = await shell_b.run("echo MARKER=$(cat /tmp/marker 2>/dev/null || echo none); " + WORK);
assert.equal(value_of(after, "MARKER"), "none", "B restored its snapshot, from before the marker");
assert.equal(+value_of(after, "SUM"), expected_sum);
assert.equal(+value_of(await busy_a, "SUM"), expected_sum, "A was unaffected");
console.log(`snapshot of B (${(state.byteLength / 2 ** 20).toFixed(1)} MiB) restored while A ran`);

await a.destroy();
await b.destroy();
clearTimeout(timeout);
console.log("relocation test passed");
