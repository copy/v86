// Run from the repository root. Fixed-work timings follow bounded code warmup.
// node tests/ir/performance/boundaries.mjs [current.wasm] [baseline.wasm]
// Measures the IR region tiers, so ir_tier0 (32-bit code in the x64 page tier) is off.
// IR_FUSION defaults to 0 so separated pages remain separate compiled regions.
// Set IR_FUSION=1 explicitly to measure how much fusion recovers instead.
import assert from "node:assert/strict";
import fs from "node:fs";
import { finish_halted_timing } from "./timing.mjs";
import { V86 } from "../../../build/libv86.mjs";

const [currentWasm = "build/v86-ir-runtime.wasm", baselineWasm, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, "usage: boundaries.mjs [current.wasm] [baseline.wasm]");
const positive_integer = (name, fallback, minimum = 1) => {
    const value = Number(process.env[name] ?? fallback);
    assert(Number.isSafeInteger(value) && value >= minimum, `${name} must be an integer >= ${minimum}`);
    return value;
};
const repetitions = positive_integer("IR_COMPARE_RUNS", 3, 3);
const updates = positive_integer("IR_BOUNDARY_UPDATES", 8_000_000, 16);
const warm_runs = positive_integer("IR_BOUNDARY_WARM_RUNS", 20, 20);
const warm_iterations = positive_integer("IR_BOUNDARY_WARM_ITERATIONS", 20_000, 20_000);
const timeout = positive_integer("IR_BOUNDARY_TIMEOUT_MS", 60_000, 1000);
const fusion = Number(process.env.IR_FUSION ?? 0);
assert([0, 1].includes(fusion), "IR_FUSION must be 0 or 1");
assert.equal(updates % 16, 0, "IR_BOUNDARY_UPDATES must be divisible by 16");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PC = 0x100000, DATA = 0x120000, STACK = 0x90000, XOR = 0x31415926;
const pages = [PC, PC + 0x9000, PC + 0x3000, PC + 0xC000];
const bodies = process.env.IR_BOUNDARY_BODY
    ? [positive_integer("IR_BOUNDARY_BODY", 1)] : [1, 4];
assert(bodies.every(body => [1, 4].includes(body)), "IR_BOUNDARY_BODY must be 1 or 4");
const all_shapes = ["straight", "compact_jumps", "page_boundaries"];
const shapes = process.env.IR_BOUNDARY_SHAPE ? [process.env.IR_BOUNDARY_SHAPE] : all_shapes;
assert(shapes.every(shape => all_shapes.includes(shape)), "invalid IR_BOUNDARY_SHAPE");
const variants = [{ label: "current", wasm: currentWasm }];
if(baselineWasm) variants.push({ label: "baseline", wasm: baselineWasm });
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;

// One update: ADD EAX,EBX; XOR EAX,EDX; INC EBX. The accumulator stays live
// across every edge, preventing the arithmetic from becoming dead work.
const arithmetic = [0x01, 0xD8, 0x31, 0xD0, 0x43];
const finish = [0x89, 0x06, 0x89, 0x5E, 0x04, 0xF4]; // Store EAX/EBX; HLT.
const relative = (opcode, address, target) => {
    const displacement = Buffer.alloc(4);
    displacement.writeInt32LE(target - address - opcode.length - 4);
    return [...opcode, ...displacement];
};

function make_work(shape, body) {
    const operations = Array.from({ length: body }, () => arithmetic).flat();
    const chunks = [];
    let end;
    if(shape === "page_boundaries") {
        for(let fragment = 0; fragment < pages.length; fragment++) {
            const address = pages[fragment], bytes = [...operations];
            if(fragment < pages.length - 1) {
                bytes.push(...relative([0xE9], address + bytes.length, pages[fragment + 1]));
            } else {
                bytes.push(0x49); // DEC ECX.
                bytes.push(...relative([0x0F, 0x85], address + bytes.length, PC));
                bytes.push(...finish);
                end = address + bytes.length;
            }
            chunks.push({ address, bytes });
        }
    } else {
        const bytes = [];
        for(let fragment = 0; fragment < pages.length; fragment++) {
            bytes.push(...operations);
            if(shape === "compact_jumps" && fragment < pages.length - 1) {
                // Same instructions as page_boundaries, with targets adjacent
                // to the JMP. All four fragments fit one captured region.
                bytes.push(...relative([0xE9], PC + bytes.length, PC + bytes.length + 5));
            }
        }
        bytes.push(0x49);
        bytes.push(...relative([0x0F, 0x85], PC + bytes.length, PC));
        bytes.push(...finish);
        chunks.push({ address: PC, bytes });
        end = PC + bytes.length;
    }
    const updates_per_iteration = pages.length * body;
    return {
        name: `${shape}_${body * 3}`, shape, body, chunks, end,
        entries: shape === "page_boundaries" ? pages : [PC],
        iterations: updates / updates_per_iteration,
        updatesPerIteration: updates_per_iteration,
        instructionsPerIteration: updates_per_iteration * 3 + 2 + (shape === "straight" ? 0 : pages.length - 1),
    };
}
const workloads = bodies.flatMap(body => shapes.map(shape => make_work(shape, body)));
for(const work of workloads) {
    assert(work.iterations * work.instructionsPerIteration + 3 < 2 ** 32, "measured retirement delta must not wrap");
    assert(warm_iterations * work.instructionsPerIteration + 3 < 2 ** 32, "warm retirement delta must not wrap");
}

// Independent architectural oracle. Computed outside every timed interval and
// cached by total updates, so the entire matrix performs identical arithmetic.
const expected = new Map();
function oracle(count) {
    if(!expected.has(count)) {
        let eax = 0, ebx = 7;
        for(let i = 0; i < count; i++) {
            eax = ((eax + ebx) ^ XOR) >>> 0;
            ebx = (ebx + 1) >>> 0;
        }
        expected.set(count, { eax, ebx });
    }
    return expected.get(count);
}

const stat_fields = {
    guest_steps: 10, activations: 2, full_checks: 19, observer_checks: 32,
    warm_handoffs: 35, fast_checks: 18, target_hits: 21, successor_hits: 29, fused_steps: 25,
};
const rows = [];
const paired_states = new Map();
for(const work of workloads) for(let round = 0; round < repetitions; round++) {
    // Rotate all arms, including optional baseline arms, to distribute drift.
    const arms = variants;
    const ordered = arms.slice(round % arms.length).concat(arms.slice(0, round % arms.length));
    for(const arm of ordered) {
        const { label, wasm } = arm;
        const context = `${work.name}/${label}/round=${round}`;
        const vm = new V86({
            graphics_adapter: "bochs_vga",
            wasm_path: wasm, ir_tier0: false, memory_size: 32 << 20,
            bios: { buffer: bios.slice(0) }, disable_keyboard: true,
            disable_mouse: true, disable_speaker: true,
            net_device: { type: "none" }, autostart: false,
        });
        try {
            await new Promise((resolve, reject) => {
                vm.add_listener("emulator-loaded", resolve);
                vm.add_listener("emulator-error", reject);
            });
            const cpu = vm.v86.cpu, e = cpu.wm.exports;
            const data = () => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset);
            assert.equal(typeof e.ir_cache_set_fusion, "function", `${context}: requires an IR runtime wasm`);
            assert.equal(e.ir_cache_set_fusion(fusion), 1, context);
            vm.run();
            const boot_deadline = performance.now() + 15_000;
            while(data().getUint16(0x500, true) !== 0xCAFE) {
                assert(performance.now() < boot_deadline, `${context}: BIOS timeout`);
                await sleep(1);
            }
            await vm.stop();
            for(const { address, bytes } of work.chunks) vm.write_memory(Uint8Array.from(bytes), address);
            const read_stats = () => Object.fromEntries(Object.entries(stat_fields).map(([name, field]) =>
                [name, typeof e.ir_cache_stat === "function" ? e.ir_cache_stat(field) >>> 0 : 0]));
            const entry_tier = pc => e.ir_cache_entry_stat(pc, 0, 1, 5);

            const run = async iterations => {
                const count = iterations * work.updatesPerIteration;
                const { eax, ebx } = oracle(count);
                cpu.segment_offsets.fill(0, 0, 6);
                cpu.segment_is_null.fill(0, 0, 6);
                cpu.is_32[0] = cpu.stack_size_32[0] = 1;
                cpu.reg32.set([0, iterations, XOR, 7, STACK, 0, DATA, 0]);
                cpu.flags[0] = 2;
                cpu.flags_changed[0] = cpu.in_hlt[0] = 0;
                cpu.instruction_pointer[0] = PC;
                data().setUint32(DATA - 4, 0x12345678, true);
                data().setUint32(DATA, 0xDEADBEEF, true);
                data().setUint32(DATA + 4, 0xDEADBEEF, true);
                data().setUint32(DATA + 8, 0x87654321, true);
                e.update_state_flags();
                const before_ir = read_stats(), before_steps = vm.get_instruction_counter() >>> 0;
                const start = performance.now();
                vm.run();
                while(!cpu.in_hlt[0]) {
                    assert(performance.now() - start < timeout, `${context}: guest timeout`);
                    await sleep(1);
                }
                const timing = await finish_halted_timing(vm, start);
                const steps = ((vm.get_instruction_counter() >>> 0) - before_steps) >>> 0;
                const ir = Object.fromEntries(Object.entries(read_stats()).map(([name, value]) =>
                    [name, (value - before_ir[name]) >>> 0]));
                assert.equal(steps, iterations * work.instructionsPerIteration + 3, `${context}: exact retirement`);
                const state = {
                    gpr: Array.from(cpu.reg32, value => value >>> 0),
                    flags: e.get_eflags() >>> 0,
                    memory: Array.from({ length: 4 }, (_, i) => data().getUint32(DATA - 4 + i * 4, true)),
                };
                assert.deepEqual(state.gpr, [eax, 0, XOR, ebx, STACK, 0, DATA, 0], `${context}: registers`);
                assert.deepEqual(state.memory, [0x12345678, eax, ebx, 0x87654321], `${context}: stores/guards`);
                assert.equal(state.flags & 0xCD5, 0x44, `${context}: final arithmetic/direction flags`);
                assert.equal(cpu.instruction_pointer[0] >>> 0, work.end, `${context}: final EIP`);
                return { ...timing, steps, ir, state, iterations, updates: count };
            };

            // Bounded runs let async publication complete between runs. Require
            // every separated entry to reach Tier 2; never time a cold fallback.
            let warmed = 0;
            do {
                await run(warm_iterations);
                await sleep(1);
                warmed++;
            } while(warmed < warm_runs || (warmed < warm_runs + 40 &&
                work.entries.some(pc => entry_tier(pc) !== 2)));
            for(const pc of work.entries) {
                assert.equal(entry_tier(pc), 2, `${context}: 0x${pc.toString(16)} must reach Tier 2`);
                if(!fusion) assert.equal(e.ir_cache_entry_stat(pc, 0, 1, 10), 1, `${context}: entry must not be fused`);
            }
            const result = await run(work.iterations);
            const coverage = result.ir.guest_steps / result.steps;
            assert(coverage >= 0.99, `${context}: IR coverage ${coverage} must be >= 99%`);
            if(!fusion) assert.equal(result.ir.fused_steps, 0, `${context}: fusion must stay disabled`);
            // All workloads perform the same update count, not merely each
            // core pair. Their PCs differ, but architectural data must agree.
            const key = `${round}`;
            if(paired_states.has(key)) assert.deepEqual(result.state, paired_states.get(key), `${context}: architectural parity`);
            else paired_states.set(key, result.state);
            const row = {
                event: "sample", workload: work.name, shape: work.shape,
                arithmetic_per_fragment: work.body * 3, variant: label,
                wasm, fusion, round, warm_runs: warmed, ...result,
                mips: result.steps / result.ms / 1000,
                ns_per_update: result.ms * 1e6 / result.updates,
                ns_per_iteration: result.ms * 1e6 / result.iterations,
                ir_coverage: coverage,
                instructions_per_activation: result.ir.activations ? result.ir.guest_steps / result.ir.activations : null,
            };
            rows.push(row);
            console.log(JSON.stringify(row));
        } finally {
            await vm.destroy();
        }
    }
}

const median = values => {
    const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const timing = (variant, body, shape) => {
    const samples = rows.filter(row => row.variant === variant &&
        row.arithmetic_per_fragment === body * 3 && row.shape === shape);
    return {
        ns_per_update: median(samples.map(row => row.ns_per_update)),
        ns_per_iteration: median(samples.map(row => row.ns_per_iteration)),
        min_ms: Math.min(...samples.map(row => row.ms)),
        max_ms: Math.max(...samples.map(row => row.ms)),
        instructions_per_activation: median(samples.map(row => row.instructions_per_activation)),
    };
};
const matrix = variants.flatMap(({ label }) => bodies.map(body => {
    const by_shape = Object.fromEntries(shapes.map(shape => [shape, timing(label, body, shape)]));
    return {
        variant: label, arithmetic_per_fragment: body * 3, ...by_shape,
        // compact_jumps and page_boundaries have identical guest retirement;
        // this delta includes layout/compilation effects as well as admission.
        boundary_penalty_ns_per_iteration: shapes.includes("page_boundaries") && shapes.includes("compact_jumps")
            ? by_shape.page_boundaries.ns_per_iteration - by_shape.compact_jumps.ns_per_iteration : null,
    };
}));
const comparison = baselineWasm ? bodies.flatMap(body => shapes.map(shape => ({
    arithmetic_per_fragment: body * 3, shape,
    current_over_baseline: timing("baseline", body, shape).ns_per_update /
        timing("current", body, shape).ns_per_update,
}))) : [];
console.log(JSON.stringify({ event: "summary", repetitions, updates, fusion, matrix, comparison }));
// Diagnostic benchmark: correctness/warmup failures fail the process. No noisy
// speed threshold, and no aggregation that hides a short-region regression.
