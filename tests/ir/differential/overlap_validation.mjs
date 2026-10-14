// Exact source-union validation against the original per-source checks. Every
// run uses actually fused owners with overlapping immutable capture windows.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../../build/libv86.mjs";
const wasm = process.argv[2] || "build/v86-ir-runtime.wasm";
const vm = new V86({jit_switches:{x64_page_legacy32:0}, graphics_adapter: "bochs_vga", wasm_path: wasm, jit_backend: "ir", memory_size: 32 << 20,
    bios: { buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer },
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: { type: "none" }, autostart: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (test, label) => {
    const end = performance.now() + 15000;
    while(!test()) { assert(performance.now() < end, label); await sleep(1); }
};
const iterations = 256, initial_count = 0xFFFFFF00, alternate = 0x300000;
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    // These cases exercise the strict (byte-validating) admission contract and
    // its slow-path machinery; notified_validation.mjs covers the default.
    assert.equal(e.ir_cache_set_strict_validation(1), 1);
    const words = () => new Uint32Array(e.memory.buffer);
    const memory = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
    const write32 = (address, value) => memory().setUint32(address, value, true);
    vm.run(); await until(() => memory().getUint16(0x500, true) === 0xCAFE, "BIOS");
    await vm.stop();
    assert.equal(e.ir_cache_set_merged_validation(2), 0, "reject invalid policy");
    let comparisons = 0, observer_checks = 0, saved_bytes = 0;
    for(const PC of [0x100000, 0x100FE0]) {
        const peer = PC + 32;
        const reset = (limit = iterations) => {
            cpu.in_hlt[0] = 0; cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
            cpu.is_32[0] = cpu.stack_size_32[0] = 1;
            cpu.segment_offsets.fill(0, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
            cpu.reg32.set([0, PC, peer, 0, 0x90000, 0, 0, limit]);
            cpu.instruction_pointer[0] = PC; cpu.reg_xmm32s.fill(0);
            words()[664 >> 2] = initial_count; e.update_state_flags();
        };
        for(const kind of ["ordinary", "raw_head", "raw_peer_tail", "notified_tail", "mapping", "cold_tail"]) {
            const states = [];
            for(const enabled of [0, 1]) {
                assert.equal(e.ir_auto_config(0, 2, 4, 192, 256, 64), 1);
                cpu.jit_clear_cache(); e.ir_cache_collect();
                assert.equal(e.ir_cache_set_fusion(1), 1);
                assert.equal(e.ir_cache_set_fast_validation(0), 1);
                assert.equal(e.ir_cache_set_merged_validation(enabled), 1);
                cpu.cr[0] = 0x80010011 | 0; cpu.cr[3] = 0x12000; cpu.cr[4] = 512;
                write32(0x12000, 0x13003);
                for(let page = 0; page < 1024; page++) write32(0x13000 + page * 4, page * 4096 | 3);
                e.full_clear_tlb(); reset(0x7FFFFFFF);
                vm.write_memory(new Uint8Array(256).fill(0x90), PC);
                // INC EBX; INC EBP; CMP EBX,EDI; JE HLT; JMP EDX; HLT.
                vm.write_memory(Uint8Array.of(0x43, 0x45, 0x39, 0xFB, 0x74, 0x02, 0xFF, 0xE2, 0xF4), PC);
                // Every peer visit is an observer, then the indirect backedge.
                vm.write_memory(Uint8Array.of(0xE4, 0x93, 0xFF, 0xE1), peer);
                cpu.io.register_read(0x93, null, () => 0x7A);
                for(const at of [PC, peer]) {
                    cpu.instruction_pointer[0] = at;
                    assert(await cpu.ir_compile_cached(192, 2, 1, 1, 256, 64));
                }
                cpu.instruction_pointer[0] = PC;
                assert.equal(e.ir_auto_config(1, 2, 4, 192, 256, 64), 1);
                vm.run();
                await until(() => [PC, peer].some(at => e.ir_cache_entry_stat(at, 0, 1, 14) > 0
                    && e.ir_cache_entry_stat(at, 0, 1, 3) > 7), "overlapping fused source execution");
                await vm.stop();
                assert.equal(e.ir_auto_config(0, 2, 4, 192, 256, 64), 1);
                const owners = [PC, peer].filter(at => e.ir_cache_entry_stat(at, 0, 1, 14) > 0);
                assert(owners.length > 0); saved_bytes += e.ir_cache_entry_stat(owners[0], 0, 1, 14);
                const original_page = peer & ~4095;
                vm.write_memory(cpu.mem8.slice(original_page, original_page + 4096), alternate);
                if(kind === "cold_tail") cpu.mem8[PC + 200] ^= 1;
                let calls = 0, mutations = 0;
                cpu.io.register_read(0x93, null, () => {
                    calls++;
                    if(calls === 16) {
                        mutations++;
                        if(kind !== "cold_tail") {
                            assert.equal(e.ir_cache_set_merged_validation(enabled), 0, "active owner rejects policy changes");
                        }
                        if(kind === "raw_head") cpu.mem8[PC + 1] = 0x4D;
                        if(kind === "raw_peer_tail") cpu.mem8[PC + 200] ^= 1;
                        if(kind === "notified_tail") vm.write_memory(Uint8Array.of(cpu.mem8[PC + 200] ^ 1), PC + 200);
                        if(kind === "mapping") {
                            write32(0x13000 + (peer >>> 12) * 4, alternate | 3); e.full_clear_tlb();
                        }
                    }
                    return 0x7A;
                });
                reset();
                const checks = e.ir_cache_stat(32), rejects = e.ir_cache_stat(33);
                const deadline = performance.now() + 15000;
                while(!cpu.in_hlt[0]) { assert(performance.now() < deadline, "fixed guest work"); e.main_loop(); }
                observer_checks += (e.ir_cache_stat(32) - checks) >>> 0;
                assert.equal(vm.get_instruction_counter() >>> 0, (initial_count + iterations * 7 - 2) >>> 0, "wrapped retirement");
                assert.equal(cpu.reg32[3], iterations);
                assert.equal(cpu.reg32[5], kind === "raw_head" ? 32 - iterations : iterations);
                assert.equal(cpu.instruction_pointer[0], PC + 9);
                assert.equal(calls, iterations - 1); assert.equal(mutations, 1);
                if(["raw_head", "raw_peer_tail", "notified_tail", "mapping"].includes(kind)) {
                    // A notified write retires the active owner directly; it
                    // need not reach the raw-memory observer continuation.
                    if(kind !== "notified_tail") {
                        assert(e.ir_cache_stat(33) > rejects, `${kind}: observer invalidation detected`);
                    }
                    for(const owner of owners) assert.equal(e.ir_cache_entry_stat(owner, 0, 1, 0), 0, "stale fused owner retired");
                }
                states.push({ gpr: Array.from(cpu.reg32, x => x >>> 0), flags: e.get_eflags() >>> 0,
                    ip: cpu.instruction_pointer[0] >>> 0, previous: words()[560 >> 2],
                    count: vm.get_instruction_counter() >>> 0, xmm: Array.from(cpu.reg_xmm32s),
                    code: Array.from(cpu.mem8.slice(PC, PC + 224)) });
            }
            assert.deepEqual(states[1], states[0], `${kind}/${PC.toString(16)}: merged equals original validation`);
            comparisons++;
        }
    }
    assert(observer_checks > 0); assert(saved_bytes > 0);
    console.log(`PASS: ${wasm}: ${comparisons} paired overlap validations, ${observer_checks} observer checks; ordinary/cross-page capture, exact wrapped retirement, raw/notified tail SMC, raw instruction mutation, remapping and cold admission`);
} finally { await vm.destroy(); }
