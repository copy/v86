import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
// packed_simd.mjs [baseline.wasm] [candidate.wasm]: machine 0 is the
// interpreter (or, with arguments, the baseline core); the candidate core runs
// every case once per compiled arm (the page tier) and must match it.
const candidate = process.argv[3] || "build/v86.wasm";
const baseline = process.argv[2] || candidate;
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const machines = [], DATA = 0x200000, OUT = 0x210000, CODE = 0x100000;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const labels = [];
// SSE enabled (CR4.OSFXSR, OSXMMEXCPT: the BIOS leaves them clear)
const ENABLE_SSE = [0x0F,0x20,0xE0,0x0D,...u32(0x600),0x0F,0x22,0xE0];
/** An m128 operand, which must be 16-byte aligned (#GP(0)); MMX forms and
 * the narrow SSE operands need no alignment */
function aligned_m128({ mmx, op, prefix }) {
    const p = prefix[0] ?? 0;
    // (MOVLPS/MOVHPS/MOVLPD/MOVHPD and MOVDDUP: an m64; MOVSLDUP, MOVSHDUP: an m128)
    if([0x12, 0x13, 0x16, 0x17].includes(op)) return p === 0xF3;
    if(p === 0x66) return ![0x2A, 0x2E, 0x2F, 0x6E, 0xC4].includes(op); // m64, m64, m32, m16
    if(p === 0xF2) return [0x70, 0x7C, 0x7D, 0xE6].includes(op);
    if(p === 0xF3) return [0x70, 0x5B].includes(op);
    return !mmx && ![0x5A, 0x2A, 0x2C, 0x2D, 0x2E, 0x2F].includes(op); // m64 and m32 sources
}
const ops = [0xE4,0xE5,0xF4,0xF6,0xFC,0xFD,0xFE,0xD4,0xF8,0xF9,0xFA,0xFB,0xEC,0xED,0xDC,0xDD,
    0xE8,0xE9,0xD8,0xD9,0x64,0x65,0x66,0x74,0x75,0x76,0xDA,0xDE,0xEA,0xEE,
    0xE0,0xE3,0xD5,0xF5,0xDB,0xDF,0xEB,0xEF,0x60,0x61,0x62,0x68,0x69,0x6A,
    0x63,0x67,0x6B,0xD1,0xD2,0xD3,0xE1,0xE2,0xF1,0xF2,0xF3];
const instructions = [];
for(const mmx of [true, false]) {
    const prefix = mmx ? [] : [0x66];
    for(const op of mmx ? ops : [...ops, 0x6C, 0x6D]) instructions.push({ mmx, op, prefix });
    for(const op of [0x71, 0x72, 0x73]) for(const group of op === 0x73 ? (mmx ? [2,6] : [2,3,6,7]) : [2,4,6])
        instructions.push({ mmx, op, prefix, group });
}
for(const [prefix, mmx, op] of [[[],true,0x70], [[0x66],false,0x70], [[0xF2],false,0x70],
    [[0xF3],false,0x70], [[],false,0xC6], [[0x66],false,0xC6],
    [[],false,0x14], [[],false,0x15], [[0x66],false,0x14], [[0x66],false,0x15]])
    instructions.push({ mmx, op, prefix, shuffle: op === 0x70 || op === 0xC6 });
for(const prefix of [[], [0x66], [0xF2], [0xF3]]) for(const op of [0x51,0x58,0x59,0x5C,0x5D,0x5E,0x5F,
    ...(!prefix.length || prefix[0] === 0xF3 ? [0x52,0x53] : [])])
    instructions.push({ mmx: false, op, prefix, floating: true });
for(const prefix of [[], [0x66], [0xF2], [0xF3]])
    instructions.push({ mmx: false, op: 0xC2, prefix, shuffle: true, floating: true });
for(const [prefix, op] of [[[],0x5A], [[0x66],0x5A], [[0xF2],0x5A], [[0xF3],0x5A],
    [[],0x5B], [[0x66],0x5B], [[0xF3],0x5B], [[0x66],0xE6], [[0xF2],0xE6], [[0xF3],0xE6]])
    for(let rounding_mode = 0; rounding_mode < 4; rounding_mode++)
        instructions.push({ mmx: false, op, prefix, floating: true, rounding_mode });
for(const prefix of [[], [0x66], [0xF2], [0xF3]]) for(const op of [0x2A,0x2C,0x2D])
    for(let rounding_mode = 0; rounding_mode < 4; rounding_mode++) {
        const scalar = prefix[0] === 0xF2 || prefix[0] === 0xF3;
        instructions.push({ mmx: !scalar && op !== 0x2A, op, prefix, floating: true, rounding_mode,
            source_mmx: !scalar && op === 0x2A, source_gpr: scalar && op === 0x2A,
            target_gpr: scalar && op !== 0x2A });
    }
for(const mmx of [true, false]) {
    const prefix = mmx ? [] : [0x66];
    instructions.push({ mmx, op: 0xF7, prefix, register_only: true, masked_store: true });
    for(const op of [0x6E,0xC4]) instructions.push({ mmx, op, prefix, source_gpr: true, shuffle: op === 0xC4 });
    for(const op of [0xC5,0xD7]) instructions.push({ mmx, op, prefix, source_mmx: mmx, target_gpr: true,
        register_only: true, shuffle: op === 0xC5 });
}
instructions.push({ mmx: true, op: 0x7E, prefix: [], target_gpr: true, register_only: true, reverse: true });
instructions.push({ mmx: true, op: 0x7E, prefix: [], memory_only: true, memory_store: true, output_width: 4 });
for(const prefix of [[], [0x66]]) instructions.push({ mmx: false, op: 0x50, prefix, target_gpr: true, register_only: true });
for(const prefix of [[], [0x66]]) for(const op of [0x2E,0x2F])
    instructions.push({ mmx: false, op, prefix, floating: true, changes_flags: true });
for(const prefix of [[0x66], [0xF2]]) for(const op of [0x7C,0x7D])
    instructions.push({ mmx: false, op, prefix, floating: true });
for(const [prefix, op] of [[[],0x16],[[0xF2],0x12],[[0xF3],0x12],[[0xF3],0x16]])
    instructions.push({ mmx: false, op, prefix });
for(const prefix of [[0xF2], [0xF3]]) instructions.push({ mmx: prefix[0] === 0xF2, op: 0xD6,
    prefix, source_mmx: prefix[0] === 0xF3, register_only: true });
try {
    for(const [label, wasm_path, options] of [
        [process.argv[2] ? baseline : "interpreter", baseline, process.argv[2] ? {} : { disable_jit: true }],
        ...COMPILED_ARMS.map(arm => [arm.label, candidate, arm.options])]) {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20,
            ...options, disable_keyboard: true,
            disable_mouse: true, disable_speaker: true, net_device: { type: "none" }, autostart: false });
        machines.push(vm); labels.push(label);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const end = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < end); await sleep(1); }
        await vm.stop();
    }
    let cases = 0;
    for(const { mmx, op, prefix, group, shuffle, floating, rounding_mode = 0, source_mmx, source_gpr, target_gpr, register_only, masked_store, changes_flags, reverse, memory_only, memory_store, output_width } of instructions) {
        const data = new Uint8Array(8192), view = new DataView(data.buffer);
        let seed = 0x713923AB;
        for(let i = 0; i < data.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; data[i] = seed; }
        if(floating) {
            const special = prefix[0] === 0x66 || prefix[0] === 0xF2 ?
                [0n,0x8000000000000000n,0x3FF0000000000000n,0xBFF0000000000000n,1n,
                    0x7FF0000000000000n,0xFFF0000000000000n,0x7FF123456789ABCDn,0x7FFABCDE01234567n] :
                [0n,0x8000000080000000n,0x3F8000003F800000n,0xBF800000BF800000n,0x100000001n,
                    0x7F8000007F800000n,0xFF800000FF800000n,0x7F8123457F812345n,0x7FCABCDE7FCABCDEn];
            const extra = [0.5,-0.5,1.5,-1.5,2.5,-2.5,2147483647,2147483648,-2147483648,-2147483649];
            const scratch = new DataView(new ArrayBuffer(8));
            for(const value of extra) {
                if(prefix[0] === 0x66 || prefix[0] === 0xF2) scratch.setFloat64(0, value, true);
                else { scratch.setFloat32(0, value, true); scratch.setFloat32(4, value, true); }
                special.push(scratch.getBigUint64(0, true));
            }
            for(let i = 0; i < 128; i++) view.setBigUint64(i * 8, special[i % special.length], true);
        }
        const shift = [0xD1,0xD2,0xD3,0xE1,0xE2,0xF1,0xF2,0xF3].includes(op);
        const counts = [0n,1n,15n,16n,31n,32n,63n,64n,255n,0x100000000n,0xFFFFFFFFFFFFFFFFn];
        // Signed saturation and multiply-add overflow alongside random data.
        const patterns = [0x8000800080008000n,0x7FFF7FFF7FFF7FFFn,0xFFFFFFFFFFFFFFFFn,0n];
        for(let i = 0; !floating && i < 16; i++) view.setBigUint64(i * 16,
            shift ? counts[i % counts.length] : patterns[i % 4], true);
        const width = output_width || (target_gpr ? 4 : mmx ? 8 : 16);
        view.setUint32(8000, 0x1F80 | rounding_mode << 13, true);
        const program = [...ENABLE_SSE,0x0F,0xAE,0x15,...u32(DATA + 8000)], total = group || shuffle ? 256 : 96;
        // (misaligned and page-crossing operands where alignment is not required)
        const offsets = aligned_m128({ mmx, op, prefix }) ? [0,16,4064,4080] : [0,1,4092,4095];
        for(let n = 0; n < total; n++) {
            const src = n >> 3 & (source_gpr ? 3 : 7), dst = n & (target_gpr ? 3 : 7), memory = memory_only || !register_only && !group && n >= 64;
            const source = DATA + ((n >> 3) * 16);
            const target = DATA + 512 + dst * 16;
            const load = mmx ? [0x0F,0x6F] : [0xF3,0x0F,0x6F];
            const store = mmx ? [0x0F,0x7F] : [0xF3,0x0F,0x7F];
            program.push(...load, 0x05 | dst << 3, ...u32(target));
            if(source_gpr) program.push(0xB8 | src, ...u32(view.getUint32(source - DATA, true)));
            else program.push(...((source_mmx ?? mmx) ? [0x0F,0x6F] : [0xF3,0x0F,0x6F]), 0x05 | src << 3, ...u32(source));
            if(masked_store) program.push(0xBF,...u32(OUT + n * 32));
            program.push(0xF9, ...prefix, 0x0F, op,
                group ? 0xC0 | group << 3 | dst : reverse ? 0xC0 | src << 3 | dst : memory ? 0x05 | dst << 3 : 0xC0 | dst << 3 | src,
                ...(memory ? u32(memory_store ? OUT + n * 32 : DATA + offsets[n & 3]) : []),
                ...(group || shuffle ? [n] : []));
            if(!masked_store && !memory_store) program.push(...(target_gpr ? [0x89] : store), 0x05 | dst << 3, ...u32(OUT + n * 32));
            program.push(0x9C, 0x58, 0xA3, ...u32(OUT + n * 32 + 16));
        }
        program.push(0xC7,0x05,...u32(0x600),...u32(0xCAFE));
        program.push(0xE9,...u32(-program.length - 5));
        const results = [];
        for(const [i, vm] of machines.entries()) {
            const cpu = vm.v86.cpu, e = cpu.wm.exports;
            // Programs reuse CODE: start each from an empty compiler state
            // (compiled code needs more heat to recompile a page after each rewrite).
            cpu.jit_clear_cache();
            vm.write_memory(data, DATA); vm.write_memory(new Uint8Array(total * 32), OUT);
            vm.write_memory(Uint8Array.from(program), CODE); vm.write_memory(new Uint8Array(4), 0x600);
            cpu.reg32[4] = 0x8000;
            cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
            const start = compiled_activations(e);
            vm.run();
            const end = performance.now() + 10000;
            while(word(vm, 0x600) !== 0xCAFE || (i >= 1 || process.argv[2]) && compiled_activations(e) === start) {
                assert(performance.now() < end, `${labels[i]}: SIMD timeout ${mmx}/${op.toString(16)}`); await sleep(1);
            }
            // Allow every page of the program to reach/publish its compiled code.
            await sleep(20); await vm.stop();
            results.push(Uint8Array.from(vm.read_memory(OUT, total * 32)));
            for(let n = 0; !changes_flags && n < total; n++) assert.equal(results[i][n * 32 + 16] & 1, 1, "preserves CF");
        }
        for(let i = 1; i < machines.length; i++) {
            for(let n = 0; n < total; n++) assert.deepEqual(results[i].slice(n*32,n*32+width), results[0].slice(n*32,n*32+width),
                `${labels[i]}: packed mismatch prefix=${prefix} mmx=${mmx} op=${op.toString(16)} case=${n}`);
            if(changes_flags) for(let n = 0; n < total; n++) assert.deepEqual(
                results[i].slice(n*32+16,n*32+20), results[0].slice(n*32+16,n*32+20), `${labels[i]}: COMI flags`);
        }
        cases += total;
    }
    console.log(`PASS: ${cases} MMX/SSE integer, floating, conversion and transfer cases; aliases, boundaries and memory, on the page tier`);
} finally {
    for(const vm of machines) await vm.destroy();
}
