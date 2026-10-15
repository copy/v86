// Disabling the JIT at run time (jit_set_enabled) stops the page tier: a hot
// loop runs in the interpreter for 128 CPU frames without a compilation or an
// activation of compiled code; re-enabling compiles and enters it. (Until M11
// of docs/jit-unification-plan.md this tested the region tiers' promotion.)
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
const wasm = process.argv[2] || "build/v86-debug.wasm";
const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: wasm, memory_size: 32 << 20, ir_sync_publication: true,
    bios: { buffer: Uint8Array.from(fs.readFileSync("build/cpu-worker-test.bin")).buffer },
    disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: { type: "none" } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (test, message) => {
    const deadline = performance.now() + 15000;
    while(!test()) { assert(performance.now() < deadline, message); await sleep(1); }
};
try
{
    await new Promise((resolve, reject) => { vm.add_listener("emulator-loaded", resolve); vm.add_listener("emulator-error", reject); });
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    vm.run(); await until(() => cpu.mem32s[0x500 >> 2] === 0xCAFE, "boot"); await vm.stop();
    cpu.jit_clear_cache();
    const pc = 0x1200000;
    // (inc eax; jmp short back)
    vm.write_memory(Uint8Array.of(0x40, 0xEB, 0xFD), pc);
    cpu.instruction_pointer[0] = pc; cpu.in_hlt[0] = 0;
    const compiles = () => e.x64_page_stat(0) >>> 0, activations = () => e.x64_page_stat(13) >>> 0;
    assert(e.jit_set_enabled(0));
    const compiled = compiles(), entered = activations(), eax = cpu.reg32[0];
    let frames = 0;
    const main_loop = cpu.main_loop;
    cpu.main_loop = function() { const result = main_loop.call(this); frames++; return result; };
    vm.run(); await until(() => frames >= 128, "128 CPU frames"); await vm.stop();
    const interpreted = (cpu.reg32[0] - eax) >>> 0;
    assert(interpreted > 0, "the loop ran");
    assert.equal(compiles(), compiled, "no compilation with the JIT disabled");
    assert.equal(activations(), entered, "no compiled code entered with the JIT disabled");
    assert(e.jit_set_enabled(1));
    vm.run(); await until(() => activations() > entered, "compiled code after re-enabling"); await vm.stop();
    assert(compiles() > compiled, "the loop compiles after re-enabling");
    console.log(`PASS: ${wasm}: a disabled JIT neither compiles nor enters page functions for 128 CPU frames (${interpreted} interpreted iterations); re-enabled, it compiles the loop`);
}
finally { await vm.destroy(); }
