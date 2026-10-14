// IR policy sweep: ir_tier0 on/off (32-bit code in the x64 page tier or in
// the regions; IR Tier-0 until P7.5) and the region tiers' heat and promotion
// thresholds. Cold compilation and warm throughput are reported separately.
// Each sample starts a fresh VM, so no generated-code cache carries between
// policies.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { compiled_activations } from "./compiled_arms.mjs";
const wasm_path = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const median = a => a.toSorted((x, y) => x - y)[a.length >> 1];
// [ir_tier0, hot_threshold, promotion_threshold]; the first row is the default.
const policies = [
    [true, 32, 65536], [true, 8, 65536], [true, 32, 4096],
    [false, 32, 65536], [false, 8, 65536], [false, 128, 65536], [false, 32, 4096],
];
const results = policies.map(() => []);
for(let round = 0; round < 5; round++) {
    const order = Array.from(policies.keys());
    if(round & 1) order.reverse();
    for(const index of order) {
        const [tier0, hot_threshold, promotion_threshold] = policies[index];
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20,
            ir_tier0: tier0, ir_region_budget: { hot_threshold, promotion_threshold },
            disable_keyboard: true, disable_mouse: true, disable_speaker: true,
            net_device: { type: "none" }, autostart: false });
        try {
            await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
            vm.run();
            const deadline = performance.now() + 10000;
            while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
            await vm.stop();
            const cpu = vm.v86.cpu, e = cpu.wm.exports;
            // Six directly connected pages with integer work and branches.
            for(let page = 0; page < 6; page++) {
                const address = 0x100000 + page * 4096, p = [];
                for(let i = 0; i < 16; i++) p.push(0x01, 0xD8, 0x89, 0xDA, 0x29, 0xD8);
                p.push(0xFF, 0x05, ...u32(0x600));
                const next = 0x100000 + ((page + 1) % 6) * 4096;
                p.push(0xE9, ...u32(next - address - p.length - 5));
                vm.write_memory(Uint8Array.from(p), address);
            }
            cpu.instruction_pointer[0] = 0x100000; cpu.in_hlt[0] = 0;
            const activations = compiled_activations(e), start = performance.now();
            vm.run();
            while(compiled_activations(e) === activations) {
                assert(performance.now() - start < 10000); await sleep(1);
            }
            const first_compiled_ms = performance.now() - start;
            // Fixed warmup measures total compilation, not just first entry.
            await sleep(150); await vm.stop();
            const ir = vm.get_jit_info().ir;
            const before = word(vm, 0x600), warm_start = performance.now();
            while(performance.now() - warm_start < 100) cpu.main_loop();
            const blocks_per_ms = ((word(vm, 0x600) - before) >>> 0) / (performance.now() - warm_start);
            results[index].push({ first_compiled_ms, page_functions: ir.page_tier?.functions || 0,
                tier1: ir.tier1_published, tier2: ir.tier2_published, blocks_per_ms });
        } finally { await vm.destroy(); }
    }
}
for(const [index, [tier0, hot_threshold, promotion_threshold]] of policies.entries()) {
    const row = { tier0, hot_threshold, promotion_threshold, rounds: 5 };
    for(const key of Object.keys(results[index][0])) row[key] = median(results[index].map(x => x[key]));
    console.log(JSON.stringify(row));
}
