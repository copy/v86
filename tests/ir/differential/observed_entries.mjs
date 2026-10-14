// A cold observed side entry may share an already-earned Tier-1 body. Failed
// sharing must preserve the primary without compiling independent cold siblings.
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
const PC = 0x100000, INITIAL = 0xFFFFFFF0, N = 512, THRESHOLD = 64;
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    // These cases exercise the strict (byte-validating) admission contract and
    // its slow-path machinery; notified_validation.mjs covers the default.
    assert.equal(e.ir_cache_set_strict_validation(1), 1);
    // THRESHOLD counts exact visits: disable instruction-weighted heat.
    assert.equal(e.ir_auto_set_heat_steps(0), 1);
    const words = () => new Uint32Array(e.memory.buffer);
    const count = () => vm.get_instruction_counter() >>> 0;
    vm.run(); const deadline = performance.now() + 10000;
    while(new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint16(0x500, true) !== 0xCAFE) {
        assert(performance.now() < deadline, "BIOS boot"); await sleep(1);
    }
    await vm.stop();
    const prepare = (offset, iterations) => {
        cpu.segment_offsets.fill(0, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
        cpu.is_32[0] = cpu.stack_size_32[0] = 1;
        cpu.flags[0] = 2; cpu.flags_changed[0] = cpu.in_hlt[0] = 0;
        cpu.reg32.fill(0); cpu.reg32[1] = iterations; cpu.reg32[4] = 0x90000;
        cpu.reg_xmm32s.fill(0); cpu.instruction_pointer[0] = PC + offset;
        words()[664 >> 2] = INITIAL; e.update_state_flags();
    };
    const finish = () => {
        const end = performance.now() + 10000;
        while(!cpu.in_hlt[0]) { assert(performance.now() < end, "guest progress"); e.main_loop(); }
    };
    let compared = 0;
    for(const kind of ["shared", "overlap", "cancel", "raw-change"]) {
        assert.equal(e.ir_auto_config(0, THRESHOLD, 1000000, 192, 256, 64), 1);
        cpu.jit_clear_cache(); e.ir_cache_collect();
        const overlap = kind === "overlap";
        const code = overlap
            ? Uint8Array.of(0xB8, 0x43, 0xF4, 0x90, 0x90, 0x49, 0x75, 0xF8, 0xF4)
            : Uint8Array.of(0x43, 0x49, 0x75, 0xFC, 0xF4);
        prepare(1, 1); vm.write_memory(code, PC); e.full_clear_tlb();
        assert.equal(e.ir_auto_config(1, THRESHOLD, 1000000, 192, 256, 64), 1);
        const attempts = e.ir_auto_stat(2);
        e.main_loop(); assert(cpu.in_hlt[0]);
        assert.equal(e.ir_auto_stat(2), attempts, "one cold alias alone cannot trigger compilation");
        assert.equal(e.ir_cache_entry_stat(PC + 1, 0, 1, 0), 0);
        assert.equal(count(), (INITIAL + (overlap ? 2 : 3)) >>> 0);
        prepare(0, N);
        let held;
        WebAssembly.instantiate = (bytes, imports) => imports.e
            ? new Promise((resolve, reject) => { assert(!held); held = {bytes, imports, resolve, reject}; })
            : instantiate(bytes, imports);
        e.main_loop(); assert(held, `${kind}: hot primary submits its single body`);
        const retired = (count() - INITIAL) >>> 0;
        assert.equal(retired, THRESHOLD * 3, "sharing does not advance guest work");
        assert.equal(cpu.reg32[1], N - THRESHOLD);
        assert.equal(e.ir_auto_stat(17), 0, "no independent speculative sibling queued");
        assert.equal(e.ir_cache_entry_stat(PC, 0, 1, 0), 0, "pending primary has no execution authority");
        assert.equal(e.ir_cache_entry_stat(PC + 1, 0, 1, 0), 0, "pending alias has no execution authority");
        if(kind === "cancel") assert.equal(e.ir_auto_config(0, THRESHOLD, 1000000, 192, 256, 64), 1);
        if(kind === "raw-change") cpu.mem8[PC] = 0x4B;
        WebAssembly.instantiate = instantiate;
        held.resolve(await instantiate(held.bytes, held.imports)); await sleep(5);
        const published = kind === "shared" || overlap;
        assert.equal(e.ir_cache_entry_stat(PC, 0, 1, 0), +published);
        assert.equal(e.ir_cache_entry_stat(PC + 1, 0, 1, 0), +(kind === "shared"),
            `${kind}: only a valid shared body grants the cold observed alias`);
        if(published) assert.equal(e.ir_cache_entry_stat(PC, 0, 1, 11), overlap ? 1 : 2);
        if(kind === "shared") {
            assert.equal(e.ir_cache_entry_stat(PC, 0, 1, 12), e.ir_cache_entry_stat(PC + 1, 0, 1, 12));
            assert.equal(e.ir_cache_entry_stat(PC + 2, 0, 1, 0), 0, "unobserved instruction boundary is not published");
        }
        assert.equal(e.ir_auto_config(0, THRESHOLD, 1000000, 192, 256, 64), 1);
        finish();
        assert.equal(count(), (INITIAL + N * 3 + 1) >>> 0);
        assert.equal(cpu.reg32[1], 0); assert.equal(cpu.instruction_pointer[0], PC + code.length);
        assert.equal(cpu.reg32[3], overlap ? 0 : kind === "raw-change" ? THRESHOLD * 2 - N : N);
        if(kind === "shared") {
            prepare(1, 2); const hits = e.ir_cache_stat(2); finish();
            assert(e.ir_cache_stat(2) > hits, "published cold alias really executes IR");
            assert.equal(count(), (INITIAL + 6) >>> 0); assert.equal(cpu.reg32[3], 1);
            // A raw write invalidates every entry sharing this immutable owner.
            cpu.mem8[PC] = 0x4B; prepare(1, 2); const stale_hits = e.ir_cache_stat(2); finish();
            assert.equal(e.ir_cache_stat(2), stale_hits); assert.equal(cpu.reg32[3], -1);
            assert.equal(count(), (INITIAL + 6) >>> 0);
        }
        compared++;
    }
    console.log(`PASS: ${wasm}: ${compared} observed-side-entry cases; cold heat, shared owner, overlap fallback, exact wrapped retirement, cancellation and raw-byte rejection`);
} finally {WebAssembly.instantiate = instantiate; await vm.destroy();}
