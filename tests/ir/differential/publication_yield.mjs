// A real automatic publication must hand the CPU back to the host once, without
// suspending the guest indefinitely while the asynchronous compiler is pending.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../../build/libv86.mjs";
const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
// disable_jit: IR starts idle (no scheduler, no page tier); each case enables it.
const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: wasm, disable_jit: true, memory_size: 32 << 20,
    bios: { buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer },
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: { type: "none" }, autostart: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const instantiate = WebAssembly.instantiate;
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports, PC = 0x100000;
    const count = () => vm.get_instruction_counter() >>> 0;
    vm.run(); const deadline = performance.now() + 10000;
    while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "BIOS timeout"); await sleep(1);
    }
    await vm.stop();
    for(const completion of ["success", "reject", "cancel"]) {
        cpu.jit_clear_cache();
        assert.equal(e.ir_auto_config(0, 1, 1000000, 192, 256, 64), 1);
        cpu.segment_offsets.fill(0, 0, 6);
        cpu.segment_is_null.fill(0, 0, 6);
        cpu.is_32[0] = cpu.stack_size_32[0] = 1;
        cpu.flags[0] = 2; cpu.flags_changed[0] = cpu.in_hlt[0] = 0;
        cpu.reg32.fill(0); cpu.reg32[4] = 0x90000;
        cpu.instruction_pointer[0] = PC;
        vm.write_memory(Uint8Array.of(0x43, 0xEB, 0xFD), PC); // INC EBX; JMP PC.
        e.update_state_flags(); e.full_clear_tlb();
        new Uint32Array(e.memory.buffer)[664 >> 2] = 0xFFFFFFFC;
        let held;
        WebAssembly.instantiate = (code, imports) => imports.e
            ? new Promise((resolve, reject) => { assert(!held, "only one pending publication"); held = { code, imports, resolve, reject, count: count() }; })
            : instantiate(code, imports);
        assert.equal(e.ir_auto_config(1, 1, 1000000, 192, 256, 64), 1);
        const initial = count();
        e.main_loop();
        const submitted_steps = (count() - initial) >>> 0;
        assert(held, `${completion}: first empty scan does not waste the frame's compile credit`);
        assert(submitted_steps < 100003,
            `${completion}: handoff before wasting a full interpreter batch (${submitted_steps})`);
        assert.equal((count() - held.count) >>> 0, 0, `${completion}: no guest work after submission before host handoff`);
        const before_pending = count(), missing_hits = e.ir_cache_stat(37); e.main_loop();
        assert(e.ir_cache_stat(37) > missing_hits, "held publication reuses exact missing-entry hint");
        assert(((count() - before_pending) >>> 0) >= 100003,
            `${completion}: a held Promise does not yield repeatedly or stop guest progress`);
        assert([PC, PC + 1].includes(cpu.instruction_pointer[0]));
        assert.equal(((count() - 0xFFFFFFFC) >>> 0), cpu.reg32[3] * 2 - (cpu.instruction_pointer[0] === PC + 1 ? 1 : 0),
            `${completion}: exact wrapped retirement while pending`);
        console.log(`${wasm}: ${completion}: submitted after ${submitted_steps} instructions; held Promise still retires ${(count()-before_pending)>>>0}`);
        assert.equal(e.ir_auto_stat(10), 1);
        if(completion === "cancel") assert.equal(e.ir_auto_config(0, 1, 1000000, 192, 256, 64), 1);
        WebAssembly.instantiate = instantiate;
        if(completion === "reject") held.reject(new WebAssembly.CompileError("controlled publication failure"));
        else held.resolve(await instantiate(held.code, held.imports));
        await sleep(5);
        assert.equal(e.ir_auto_stat(10), 0, "pending identity completed or cancelled");
        assert.equal(e.ir_cache_entry_stat(PC, 0, 1, 0) > 0, completion === "success");
        const before = count(), cache_hits = e.ir_cache_stat(2); e.main_loop();
        if(completion === "success") assert(e.ir_cache_stat(2) > cache_hits, "publication clears absence hint before entry executes");
        assert(count() !== before, `${completion}: CPU continues after completion`);
        assert([PC, PC + 1].includes(cpu.instruction_pointer[0]));
        assert.equal(((count() - 0xFFFFFFFC) >>> 0), cpu.reg32[3] * 2 - (cpu.instruction_pointer[0] === PC + 1 ? 1 : 0));
        assert.equal(e.ir_auto_config(0, 1, 1000000, 192, 256, 64), 1);
    }
    console.log(`PASS: ${wasm}: one-shot automatic publication handoff, pending progress, success/rejection/cancellation and wrapped retirement`);
} finally { WebAssembly.instantiate = instantiate; await vm.destroy(); }
