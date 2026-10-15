import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
// mmx_fast_path.mjs [baseline.wasm] [candidate.wasm]: machine 0 is the
// interpreter (or, with arguments, the baseline core); the candidate core runs
// every case once per compiled arm (the page tier) and must match it.
const paths = [process.argv[2] || "build/v86.wasm", process.argv[3] || "build/v86.wasm"];
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const DATA = 0x200000, OUT = 0x210000, CODE = 0x100000;
const machines = [], labels = [];
const interpreted_machines = new WeakSet();
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
async function run(vm, address, warm = false) {
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    // Programs reuse CODE: start each warm run from an empty compiler state
    // (compiled code needs more heat to recompile a page after each rewrite).
    if(warm) cpu.jit_clear_cache();
    vm.write_memory(new Uint8Array(4), 0x600);
    cpu.reg32[4] = 0x8000;
    cpu.instruction_pointer[0] = address; cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const end = performance.now() + 10000;
    while(word(vm, 0x600) !== 0xCAFE || warm && !interpreted_machines.has(vm) && compiled_activations(e) === start) {
        assert(performance.now() < end, "MMX guest/JIT timeout"); await sleep(1);
    }
    await vm.stop();
}
const data = new Uint8Array(8192), dv = new DataView(data.buffer);
for(let i = 0; i < data.length; i += 8) {
    const patterns = [0x8000800080008000n, 0xFFFFFFFF00000001n, 0x7FFF80010000FFFFn, 0x12345678ABCDEF01n];
    dv.setBigUint64(i, patterns[i / 8 % patterns.length], true);
}
function calculate(op, a, b) {
    if(op === 0x6F || (op === 0x7F || op === 0xE7)) return a;
    if(op === 0xFE) return BigInt.asUintN(32, a + b) |
        BigInt.asUintN(32, (a >> 32n) + (b >> 32n)) << 32n;
    const word16 = (v, n) => BigInt.asIntN(16, v >> BigInt(n * 16));
    let value = 0n;
    for(let lane = 0; lane < 2; lane++) value |= BigInt.asUintN(32,
        word16(a, lane * 2) * word16(b, lane * 2) +
        word16(a, lane * 2 + 1) * word16(b, lane * 2 + 1)) << BigInt(lane * 32);
    return value;
}
try {
    const interpreted = !process.argv[2];
    for(const [label, wasm_path, options] of [
        [interpreted ? "interpreter" : paths[0], paths[0], interpreted ? { disable_jit: true } : {}],
        ...COMPILED_ARMS.map(arm => [arm.label, paths[1], arm.options])]) {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path, ...options, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20,
            disable_keyboard: true, disable_mouse: true, disable_speaker: true,
            net_device: { type: "none" }, autostart: false });
        machines.push(vm); labels.push(label);
        if(options.disable_jit) interpreted_machines.add(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const end = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < end); await sleep(1); }
        await vm.stop(); vm.write_memory(data, DATA);
    }
    let count = 0;
    for(const op of [0x6F, 0x7F, 0xFE, 0xF5, 0xE7]) for(const memory of op === 0xE7 ? [true] : [false, true]) {
        const program = [], expected = [];
        for(let src = 0; src < 8; src++) for(let dst = 0; dst < 8; dst++) {
            const n = src * 8 + dst, output = OUT + n * 128;
            // Nonzero TOP before the optimized instruction; all physical MMX
            // registers have known values, including PMADDWD overflow pairs.
            program.push(0xDB, 0xE3);
            for(let r = 0; r < 8; r++) program.push(0x0F, 0x6F, 0x05 | r << 3, ...u32(DATA + r * 8));
            program.push(0xD9, 0xF7, 0xD9, 0xF7, 0xD9, 0xF7, 0xF9);
            const offset = [0, 1, 4092, 4095][src & 3];
            let a = dv.getBigUint64(src * 8, true), b = dv.getBigUint64(dst * 8, true);
            if(memory) {
                if((op === 0x7F || op === 0xE7)) {
                    program.push(0x0F, op, 0x05 | src << 3, ...u32(0x220000 + offset));
                    program.push(0x0F, 0x6F, 0x05 | dst << 3, ...u32(0x220000 + offset));
                } else {
                    a = dv.getBigUint64(offset, true);
                    program.push(0x0F, op, 0x05 | dst << 3, ...u32(DATA + offset));
                }
            } else program.push(0x0F, op, 0xC0 | ((op === 0x7F || op === 0xE7) ? src << 3 | dst : dst << 3 | src));
            program.push(0x9C, 0x58, 0xA3, ...u32(output + 8));
            program.push(0x0F, 0x7F, 0x05 | dst << 3, ...u32(output));
            program.push(0xDD, 0x35, ...u32(output + 16)); // FNSAVE, includes raw 80-bit registers
            expected.push(calculate(op, a, b));
        }
        program.push(0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE));
        program.push(0xE9, ...u32(-program.length - 5));
        const results = [];
        for(const vm of machines) {
            vm.write_memory(Uint8Array.from(program), CODE);
            await run(vm, CODE, true); await run(vm, CODE);
            const bytes = Uint8Array.from(vm.read_memory(OUT, 64 * 128)); results.push(bytes);
            const view = new DataView(bytes.buffer);
            for(let n = 0; n < 64; n++) {
                assert.equal(view.getBigUint64(n * 128, true), expected[n], `MMX ${op.toString(16)} memory=${memory} pair=${n}`);
                assert.equal(view.getUint32(n * 128 + 8, true) & 1, 1, "MMX preserves carry");
                assert.equal(view.getUint16(n * 128 + 20, true) & 0x3800, 0, "MMX resets TOP");
            }
        }
        for(let i = 1; i < machines.length; i++)
            assert.deepEqual(results[i], results[0], `${labels[i]}: MMX results and complete FNSAVE state match ${labels[0]}`);
        count += expected.length;
    }
    // Faulting instructions must preserve the destination, tag state and TOP.
    const idt = 0x250000, descriptor = 0x251000, handler = 0x280000;
    let faults = 0;
    for(const [op, memory] of [[0x6F, false], [0x7F, false], [0xFE, false], [0xF5, false],
        [0x6F, true], [0x7F, true], [0xFE, true], [0xF5, true], [0xE7,true],
        ...[0xEC,0x63,0xD5,0xE4,0xF4,0xF6,0xD1,0x68].flatMap(op => [[op,false],[op,true]])]) {
        for(const vector of memory ? [7, 6, 14] : [7, 6]) {
            const length = memory ? 7 : 3, frame = vector === 14 ? 4 : 0;
            const fault_address = vector === 14 ? 0x801FFC : DATA;
            const program = [0x0F, 0x01, 0x1D, ...u32(descriptor),
                0x0F, 0x20, 0xC0, 0x83, 0xE0, 0xF3, 0x0F, 0x22, 0xC0,
                0xDB, 0xE3, 0xD9, 0xE8];
            if(vector !== 14) program.push(0x0F, 0x20, 0xC0, 0x83, 0xC8, vector === 7 ? 8 : 4, 0x0F, 0x22, 0xC0);
            const fault_eip = CODE + program.length;
            program.push(0x0F, op, memory ? 0x05 : 0xC1, ...(memory ? u32(fault_address) : []));
            program.push(0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE));
            program.push(0x80, 0x3D, ...u32(0x604), 0, 0x75, 5);
            program.push(0xE9, ...u32(-program.length - 5), 0xF4);
            const handler_code = [0x8B, 0x44, 0x24, frame, 0xA3, ...u32(OUT),
                0x83, 0x44, 0x24, frame, length];
            if(vector === 14) handler_code.push(0x83, 0xC4, 4);
            else handler_code.push(0x0F, 0x20, 0xC0, 0x83, 0xE0, 0xF3, 0x0F, 0x22, 0xC0);
            handler_code.push(0xCF);
            const snapshots = [];
            for(const vm of machines) {
                vm.write_memory(Uint8Array.from([handler & 255, handler >>> 8 & 255, 8, 0, 0, 0x8E,
                    handler >>> 16 & 255, handler >>> 24]), idt + vector * 8);
                vm.write_memory(Uint8Array.from([255, 7, ...u32(idt)]), descriptor);
                vm.write_memory(Uint8Array.from(handler_code), handler);
                vm.write_memory(Uint8Array.from(program), CODE);
                vm.write_memory(new Uint8Array(1), 0x604);
                await run(vm, CODE, true);
                vm.write_memory(Uint8Array.of(1), 0x604);
                vm.v86.cpu.fpu_st.fill(0);
                vm.write_memory(Uint8Array.from(u32(0x87654321)), 0x101FFC);
                await run(vm, CODE);
                // Raw F80 registers lag the x87 shadow cache (a dirty f64 is
                // authoritative until a guest observer); synchronize to compare.
                vm.v86.cpu.wm.exports.fpu_sync_all();
                assert.equal(word(vm, OUT), fault_eip, `precise MMX fault #${vector}`);
                assert.equal(vm.v86.cpu.fpu_stack_ptr[0], 7, `fault preserves TOP: ${labels[machines.indexOf(vm)]} op=${op.toString(16)} memory=${memory} #${vector}`);
                assert.equal(vm.v86.cpu.fpu_stack_empty[0], 0x7F, "fault preserves tags");
                snapshots.push(Array.from(vm.v86.cpu.fpu_st));
                if(vector === 14 && (op === 0x7F || op === 0xE7)) assert.equal(word(vm, 0x101FFC), 0x87654321,
                    "cross-page store faults before writing the first page");
            }
            for(let i = 1; i < machines.length; i++) assert.deepEqual(snapshots[i], snapshots[0],
                `${labels[i]}: fault leaves all FPU registers unchanged from ${labels[0]} (op=${op.toString(16)} memory=${memory} #${vector})`);
            faults++;
        }
    }
    // Exercise direct x87 register reads/push/pop with every TOP and with
    // empty/full/partially occupied stacks. Compare complete saved FPU state.
    {
        const program = [];
        let cases = 0;
        for(let top = 0; top < 8; top++) for(const occupied of [0,1,4,8]) for(let source = 0; source < 8; source++) for(const emms of [false, true]) {
            program.push(0xDB,0xE3);
            for(let i = 0; i < occupied; i++) program.push(0xD9,0xE8);
            for(let i = 0; i < top; i++) program.push(0xD9,0xF6);
            program.push(0xD9,0xC0 | source); // FLD ST(i), including underflow/overflow
            program.push(0xD9,0x1D,...u32(0x230000)); // FSTP m32, including direct pop
            if(emms) program.push(0x0F,0x77);
            program.push(0xDD,0x35,...u32(OUT + cases * 128));
            cases++;
        }
        program.push(0xC7,0x05,...u32(0x600),...u32(0xCAFE));
        program.push(0xE9,...u32(-program.length - 5));
        const snapshots = [];
        for(const vm of machines) {
            vm.write_memory(Uint8Array.from(program), CODE);
            await run(vm, CODE, true);
            snapshots.push(Uint8Array.from(vm.read_memory(OUT, cases * 128)));
        }
        for(let i = 1; i < machines.length; i++) assert.deepEqual(snapshots[i], snapshots[0],
            `${labels[i]}: x87 stack tags, status and data across every TOP, underflow and overflow`);
        console.log(`PASS: ${cases} x87 stack boundary states and complete FNSAVE images`);
    }
    // Leave actual MMX state live, rather than the empty state after FNSAVE.
    const live = [0x0F, 0x6F, 0x05, ...u32(DATA), 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE)];
    live.push(0xE9, ...u32(-live.length - 5));
    for(const vm of machines.slice(1)) {
        vm.write_memory(Uint8Array.from(live), CODE);
        await run(vm, CODE, true);
        // Save/restore after executing MMX must retain its shared x87 register state.
        const state = await vm.save_state();
        const before = Array.from(vm.v86.cpu.fpu_st);
        assert.equal(vm.v86.cpu.fpu_stack_empty[0], 0);
        assert.equal(vm.v86.cpu.fpu_stack_ptr[0], 0);
        vm.v86.cpu.fpu_st.fill(0);
        await vm.restore_state(state);
        assert.deepEqual(Array.from(vm.v86.cpu.fpu_st), before);
        assert.equal(vm.v86.cpu.fpu_stack_empty[0], 0);
        assert.equal(vm.v86.cpu.fpu_stack_ptr[0], 0);
    }
    console.log(`PASS: ${faults} real guest #NM/#UD/#PF cases preserve MMX/x87 state and precise EIP`);
    console.log(`PASS: ${count} MMX register/memory cases, aliases, unaligned/page-crossing access, carry, TOP, full FNSAVE and save/restore`);
} finally { for(const vm of machines) await vm.destroy(); }
