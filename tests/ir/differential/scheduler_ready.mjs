// An interpreted edge records its hot source even when the next PC is cold.
// Ready hints schedule compilation; they never authorize execution or publication.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../../build/libv86.mjs";
const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
// The region scheduler is under test: ir_tier0 (32-bit code in the x64 page tier, on by default) is off.
const vm = new V86({graphics_adapter: "bochs_vga", wasm_path: wasm, ir_tier0: false, memory_size: 32 << 20,
    bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: {type: "none"}, autostart: false});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const instantiate = WebAssembly.instantiate;
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports, PC = 0x100000, NEXT = PC + 4096;
    vm.run(); const deadline = performance.now() + 10000;
    while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "BIOS boot"); await sleep(1);
    }
    await vm.stop();
    const counter = new Uint32Array(e.memory.buffer, 664, 1);
    const prepare = threshold => {
        assert.equal(e.ir_auto_config(0, threshold, 1000000, 192, 256, 64), 1);
        cpu.jit_clear_cache(); e.ir_cache_collect();
        cpu.segment_offsets.fill(0, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
        cpu.is_32[0] = cpu.stack_size_32[0] = 1;
        cpu.flags[0] = 2; cpu.flags_changed[0] = cpu.in_hlt[0] = 0;
        cpu.reg32.fill(0); cpu.reg32[4] = 0x90000; cpu.instruction_pointer[0] = PC;
        counter[0] = 0xFFFFFFFE;
        e.update_state_flags(); e.full_clear_tlb();
        assert.equal(e.ir_auto_config(1, threshold, 1000000, 192, 256, 64), 1);
    };
    const branch = Uint8Array.of(0x43, 0xE9, 0, 0, 0, 0);
    new DataView(branch.buffer).setInt32(2, NEXT - PC - branch.length, true);
    vm.write_memory(branch, PC); vm.write_memory(Uint8Array.of(0xF4), NEXT);
    for(const outcome of ["success", "cancel", "raw-change"]) {
        prepare(1); let held;
        WebAssembly.instantiate = (code, imports) => imports.e
            ? new Promise((resolve, reject) => { assert(!held); held = {code, imports, resolve, reject}; })
            : instantiate(code, imports);
        e.main_loop();
        assert(held, `${outcome}: hot source compiles before executing the cold successor`);
        assert.equal(cpu.instruction_pointer[0], NEXT); assert.equal(cpu.reg32[3], 1);
        assert.equal(counter[0], 0, "exact wrapped retirement before publication");
        assert.equal(cpu.in_hlt[0], 0);
        assert.equal(e.ir_cache_entry_stat(PC, 0, 1, 0), 0, "hint is not executable code");
        if(outcome === "cancel") assert.equal(e.ir_auto_config(0, 1, 1000000, 192, 256, 64), 1);
        if(outcome === "raw-change") cpu.mem8[PC] = 0x4B;
        WebAssembly.instantiate = instantiate;
        held.resolve(await instantiate(held.code, held.imports)); await sleep(5);
        assert.equal(e.ir_cache_entry_stat(PC, 0, 1, 0) > 0, outcome === "success",
            "normal publication still rejects cancelled and changed source");
        e.main_loop();
        assert(cpu.in_hlt[0]); assert.equal(counter[0], 1); assert.equal(cpu.reg32[3], 1);
        assert.equal(cpu.instruction_pointer[0], NEXT + 1);
        vm.write_memory(branch, PC);
    }
    // Heating PCs below threshold cannot repeatedly request the cold-work path.
    prepare(1000000);
    vm.write_memory(Uint8Array.of(0x43, 0x49, 0x75, 0xFC, 0xF4), PC);
    cpu.reg32[1] = 8000;
    const probes = e.ir_auto_stat(28), publications = e.ir_auto_stat(4);
    e.main_loop();
    assert(cpu.in_hlt[0]); assert.equal(cpu.reg32[3], 8000);
    assert.equal(counter[0], (0xFFFFFFFE + 24001) >>> 0);
    assert.equal(e.ir_auto_stat(4), publications);
    assert(e.ir_auto_stat(28) - probes <= 2, "one bounded scan, no cold checks for 8000 heating visits");
    console.log(`PASS: ${wasm}: earned source selection, heating probe suppression, exact retirement, cancellation and raw-code publication rejection`);
} finally {WebAssembly.instantiate = instantiate; await vm.destroy();}
