// Fixed retired work, cold code, serial alternating VMs. This is a region-tier
// publication latency workload (ir_tier0 off), not an XP boot benchmark or a
// substitute for system tests.
// node tests/ir/performance/cold_publication.mjs [current.wasm] [baseline.wasm]
import assert from "node:assert/strict";
import fs from "node:fs";
import { finish_halted_timing } from "./timing.mjs";
import { V86 } from "../../../build/libv86.mjs";
const [current = "build/v86-ir-runtime.wasm", baseline, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
const integer = (name, fallback, minimum, maximum) => {
    const n = Number(process.env[name] ?? fallback);
    assert(Number.isSafeInteger(n) && n >= minimum && n <= maximum, name);
    return n;
};
const rounds = integer("IR_COMPARE_RUNS", 3, 3, 25);
const stages = integer("IR_COLD_STAGES", 32, 2, 128);
const iterations = integer("IR_COLD_ITERATIONS", 131072, 1024, 1000000);
const probe = process.env.IR_COLD_PROBE === "1";
const PC = 0x100000, DATA = 0x280000, STACK = 0x90000, END = PC + stages * 4096;
const retired = stages * (3 * iterations + 2) + 2;
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const word = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24];
const variants = [{ label: "current", wasm: current }];
if(baseline) variants.push({ label: "baseline", wasm: baseline });
const arms = variants;
const rows = [];
for(let round = 0; round < rounds; round++) {
    const ordered = arms.slice(round % arms.length).concat(arms.slice(0, round % arms.length));
    for(const arm of ordered) {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: arm.wasm, ir_tier0: false, memory_size: 32 << 20,
            bios: { buffer: bios.slice(0) }, autostart: false, disable_keyboard: true,
            disable_mouse: true, disable_speaker: true, net_device: { type: "none" } });
        try {
            await new Promise((resolve, reject) => {
                vm.add_listener("emulator-loaded", resolve);
                vm.add_listener("emulator-error", reject);
            });
            const cpu = vm.v86.cpu, e = cpu.wm.exports;
            const memory = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
            vm.run();
            const deadline = performance.now() + 15000;
            while(memory().getUint16(0x500, true) !== 0xCAFE) {
                assert(performance.now() < deadline, "BIOS timeout");
                await sleep(1);
            }
            await vm.stop();
            cpu.jit_clear_cache();
            // MOV ECX,N; loop: INC EBX; DEC ECX; JNZ loop; JMP next page.
            for(let i = 0; i < stages; i++) {
                const at = PC + i * 4096;
                const code = [0xB9, ...word(iterations), 0x43, 0x49, 0x75, 0xFC, 0xE9,
                    ...word(at + 4096 - (at + 14))];
                vm.write_memory(Uint8Array.from(code), at);
            }
            vm.write_memory(Uint8Array.of(0x89, 0x1E, 0xF4), END); // MOV [ESI],EBX; HLT.
            cpu.segment_offsets.fill(0, 0, 6);
            cpu.segment_is_null.fill(0, 0, 6);
            cpu.is_32[0] = cpu.stack_size_32[0] = 1;
            cpu.reg32.set([0, 0, 0, 0, STACK, 0, DATA, 0]);
            cpu.flags[0] = 2;
            cpu.flags_changed[0] = cpu.in_hlt[0] = 0;
            cpu.instruction_pointer[0] = PC;
            memory().setUint32(DATA - 4, 0x12345678, true);
            memory().setUint32(DATA, 0xDEADBEEF, true);
            memory().setUint32(DATA + 4, 0x87654321, true);
            e.update_state_flags();
            const publications = [];
            if(probe) {
                const publish = cpu.ir_publish_cached;
                cpu.ir_publish_cached = function(...args) {
                    const count = vm.get_instruction_counter() >>> 0, start = performance.now();
                    return publish.apply(this, args).then(ok => {
                        publications.push({ ok, steps: ((vm.get_instruction_counter() >>> 0) - count) >>> 0,
                            ms: performance.now() - start });
                        return ok;
                    });
                };
            }
            const fields = { guest_steps: 10, activations: 2, full_checks: 19, observer_checks: 32, warm_handoffs: 35, missing_hint_hits: 37 };
            const stats = () => Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, e.ir_cache_stat(f) >>> 0]));
            const before = vm.get_instruction_counter() >>> 0, before_stats = stats(), start = performance.now();
            vm.run();
            while(!cpu.in_hlt[0]) {
                assert(performance.now() - start < 60000, "cold workload timeout");
                await sleep(1);
            }
            const timing = await finish_halted_timing(vm, start);
            const { ms } = timing;
            const steps = ((vm.get_instruction_counter() >>> 0) - before) >>> 0;
            const ir = Object.fromEntries(Object.entries(stats()).map(([k, v]) => [k, (v - before_stats[k]) >>> 0]));
            assert.equal(steps, retired, "exact retired work across all arms");
            assert.deepEqual(Array.from(cpu.reg32, x => x >>> 0), [0, 0, 0, stages * iterations, STACK, 0, DATA, 0]);
            assert.equal(e.get_eflags() & 0xCD5, 0x44);
            assert.equal(cpu.instruction_pointer[0] >>> 0, END + 3);
            assert.deepEqual([-4, 0, 4].map(x => memory().getUint32(DATA + x, true)),
                [0x12345678, stages * iterations, 0x87654321]);
            const row = { event: "sample", ...arm, round, stages, iterations, probe, ...timing, steps,
                mips: steps / ms / 1000, ir, ir_coverage: ir.guest_steps / steps, publications };
            rows.push(row);
            console.log(JSON.stringify(row));
        } finally { await vm.destroy(); }
    }
}
const median = values => { const a = values.toSorted((a, b) => a - b); return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2; };
console.log(JSON.stringify({ event: "summary", probe, rounds, stages, iterations, retired,
    matrix: arms.map(arm => { const samples = rows.filter(r => r.label === arm.label);
        return { ...arm, ms: median(samples.map(r => r.ms)), mips: median(samples.map(r => r.mips)),
            ir_coverage: median(samples.map(r => r.ir_coverage)) }; }) }));
