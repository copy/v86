// Opt-in larger heat sets can compile a cyclic working set above the default
// 128 entries. This is scheduling/progress coverage, not a wall-clock speed gate.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
// The region scheduler is under test: ir_tier0 (32-bit code in the x64 page tier, on by default) is off.
const vm = new V86({graphics_adapter: "bochs_vga", wasm_path: wasm, ir_tier0: false, memory_size: 32 << 20,
    bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: {type: "none"}, autostart: false});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, description) => {
    const deadline = performance.now() + 15000;
    while(!condition()) {
        assert(performance.now() < deadline, description);
        await sleep(1);
    }
};
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    vm.run();
    await until(() => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint16(0x500, true) === 0xCAFE, "BIOS boot");
    await vm.stop();
    assert.equal(e.ir_auto_config(0, 16, 1000000, 192, 256, 64), 1);
    cpu.jit_clear_cache(); e.ir_cache_collect();
    assert.equal(e.ir_auto_stat(29), 128, "default remains the XP-validated policy");
    for(const invalid of [0, 127, 513, 0xFFFFFFFF]) {
        assert.equal(e.ir_auto_set_hot_capacity(invalid), 0, "reject invalid capacity");
    }
    assert.equal(e.ir_auto_set_hot_capacity(512), 1);
    assert.equal(e.ir_auto_stat(29), 512);
    assert.equal(e.ir_auto_config(1, 16, 1000000, 192, 256, 64), 1);
    assert.equal(e.ir_auto_set_hot_capacity(128), 0, "enabled empty scheduler cannot change policy");
    assert.equal(e.ir_auto_config(0, 16, 1000000, 192, 256, 64), 1);
    assert.equal(e.ir_auto_stat(29), 512, "configuration reset retains policy");
    assert.equal(e.ir_cache_set_fusion(0), 1);
    const base = 0x100000, blocks = 256;
    for(let i = 0; i < blocks; i++) {
        const pc = base + i * 4096, next = base + ((i + 1) % blocks) * 4096;
        const bytes = new Uint8Array([0x40, 0xE9, 0, 0, 0, 0]);
        new DataView(bytes.buffer).setInt32(2, next - pc - bytes.length, true);
        vm.write_memory(bytes, pc);
    }
    cpu.segment_offsets.fill(0, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
    cpu.is_32[0] = cpu.stack_size_32[0] = 1;
    cpu.reg32.fill(0); cpu.reg32[4] = 0x90000;
    cpu.flags[0] = 2; cpu.flags_changed[0] = cpu.in_hlt[0] = 0;
    cpu.instruction_pointer[0] = base;
    new Uint32Array(e.memory.buffer)[664 >> 2] = 0;
    e.update_state_flags();
    const published = e.ir_auto_stat(4), hits = e.ir_cache_stat(2);
    assert.equal(e.ir_auto_config(1, 16, 1000000, 192, 256, 64), 1);
    vm.run();
    await until(() => e.ir_auto_stat(4) >= published + 4 && e.ir_cache_stat(2) > hits,
        "256 recurrent entries retain enough heat for automatic compilation");
    await vm.stop();
    const pc = cpu.instruction_pointer[0] >>> 0;
    assert(pc >= base && pc < base + blocks * 4096);
    assert([0, 1].includes(pc & 4095), "execution stops only at an instruction boundary");
    const steps = vm.get_instruction_counter() >>> 0;
    assert.equal(steps, ((cpu.reg32[0] >>> 0) * 2 - ((pc & 4095) === 1 ? 1 : 0)) >>> 0,
        "compilation preserves exact guest work");
    assert(e.ir_auto_stat(9) >= blocks && e.ir_auto_stat(9) <= 512);
    assert.equal(e.ir_auto_set_hot_capacity(128), 0, "running working set cannot change policy");
    assert.equal(e.ir_auto_config(0, 16, 1000000, 192, 256, 64), 1);
    assert(e.ir_cache_stat(1) > 0);
    assert.equal(e.ir_auto_set_hot_capacity(128), 0, "disabled scheduler with cached owners cannot change policy");
    cpu.jit_clear_cache(); e.ir_cache_collect();
    assert.equal(e.ir_auto_stat(29), 512, "cache reset retains policy");
    assert.equal(e.ir_auto_set_hot_capacity(128), 1, "cold empty instance can restore default");
    const observer_pc = base + blocks * 4096;
    vm.write_memory(Uint8Array.of(0xE4, 0x93, 0xF4), observer_pc);
    cpu.in_hlt[0] = 0; cpu.instruction_pointer[0] = observer_pc;
    assert(await cpu.ir_compile_cached(3, 2, 1, 1, 256, 64));
    let callbacks = 0;
    cpu.io.register_read(0x93, null, () => {
        callbacks++;
        assert.equal(e.ir_auto_set_hot_capacity(512), 0, "active guest observer cannot change policy");
        return 0x7A;
    });
    e.main_loop();
    assert(cpu.in_hlt[0]); assert.equal(callbacks, 1); assert.equal(e.ir_auto_stat(29), 128);
    console.log(`PASS: ${wasm}: opt-in cyclic 256-block heat, exact retirement, default128 and invalid/enabled/cached/active setter rejection`);
} finally {
    await vm.destroy();
}
