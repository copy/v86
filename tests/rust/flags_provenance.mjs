// Compare flag-neutral instruction chains against the interpreter. Each
// consumer gets a fresh producer, so all 16 conditions exercise provenance.
// The page tier runs every program.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";

const wasm_path = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CODE = 0x100000, OUT = 0x210000;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const producers = [
    ["cmp32", [0x39, 0xD8]], ["cmp32-zero", [0x83, 0xF8, 0]],
    ["cmp32-imm", [0x83, 0xF8, 0xFF]], ["cmp16", [0x66, 0x39, 0xD8]],
    ["cmp8", [0x38, 0xD8]], ["cmp-high8", [0x38, 0xFC]],
    ["add32", [0x01, 0xD8]], ["sub32", [0x29, 0xD8]],
    ["sub8", [0x28, 0xD8]], ["sub-high8", [0x28, 0xFC]],
    ["adc32", [0x11, 0xD8]], ["sbb32", [0x19, 0xD8]],
    ["inc32", [0x40]], ["dec32", [0x48]],
    ["inc16", [0x66, 0x40]], ["dec16", [0x66, 0x48]],
    ["test32", [0x85, 0xD8]], ["test16", [0x66, 0x85, 0xD8]],
    ["test8", [0x84, 0xD8]], ["xor32", [0x31, 0xD8]],
    ["shl32", [0xD1, 0xE0]], ["shr32", [0xD1, 0xE8]],
    ["sar32", [0xD1, 0xF8]], ["add32-alias", [0x01, 0xC0]],
];
const neutral = [
    ["nop", [0x90, 0x90]],
    ["mov-unrelated", [0x89, 0xD1, 0xB9, ...u32(7)]],
    ["mov-dest", [0x89, 0xD0]], ["mov-source", [0x8B, 0xDA]],
    ["mov-both", [0x89, 0xD0, 0x89, 0xD3]],
    ["mov-low8", [0xB0, 0x42]], ["mov-high8", [0xB4, 0x42]],
    ["mov-source-high8", [0xB7, 0x42]],
    ["mov8-reg", [0x88, 0xD4, 0x8A, 0xDA]],
    ["mov16", [0x66, 0x89, 0xD0, 0x66, 0x8B, 0xDA]],
    ["mov16-imm", [0x66, 0xB8, 0x12, 0x34]],
    ["mov-c6-c7", [0xC6, 0xC4, 0x42, 0xC7, 0xC3, ...u32(77)]],
    ["mov16-c7", [0x66, 0xC7, 0xC0, 0x12, 0x34]],
    ["lea-unrelated", [0x8D, 0x4C, 0x42, 7]],
    ["lea-dest", [0x8D, 0x40, 7]],
    ["lea16", [0x66, 0x8D, 0x40, 7]],
    ["lea-address16", [0x67, 0x8D, 0x40, 7]],
    ["movzx8", [0x0F, 0xB6, 0xC4]], ["movsx8", [0x0F, 0xBE, 0xC4]],
    ["movzx16", [0x0F, 0xB7, 0xC3]], ["movsx16", [0x0F, 0xBF, 0xD8]],
    ["movzx8-to16", [0x66, 0x0F, 0xB6, 0xC4]],
    ["movsx8-to16", [0x66, 0x0F, 0xBE, 0xDC]],
    ["movx16-to16", [0x66, 0x0F, 0xB7, 0xC3, 0x66, 0x0F, 0xBF, 0xD8]],
    ["xchg-eax", [0x93]], ["xchg16-eax", [0x66, 0x93]],
    ["xchg-reg", [0x87, 0xD8]], ["xchg16-reg", [0x66, 0x87, 0xD8]],
    ["bswap", [0x0F, 0xC8, 0x0F, 0xCB]],
    // Barriers must discard provenance even though earlier MOVs retain it.
    ["helper-barrier", [0x90, 0xD1, 0xC0]], // ROL changes CF/OF
    ["carry-barrier", [0x90, 0xF8]],
    ["flags-barrier", [0x90, 0x9C, 0x5A, 0x80, 0xF2, 1, 0x52, 0x9D]],
    ["memory-barrier", [0x90, 0xA3, ...u32(0x200000), 0x8B, 0x1D, ...u32(0x200000)]],
];
const inputs = [[0, 0], [0x80000000, 1], [0x7FFFFFFF, 0xFFFFFFFF], [0x80017F80, 0x7FFF80FF]];
const machines = [];
let cases = 0, programs = 0;

// Independent integer reference for CMP conditions, including signed overflow
// and parity. This also checks the interpreter rather than trusting it alone.
function cmp_conditions(producer, a, b) {
    if(!producer.startsWith("cmp")) return null;
    let width = 32;
    if(producer === "cmp32-zero") b = 0;
    if(producer === "cmp32-imm") b = 0xFFFFFFFF;
    if(producer === "cmp16") width = 16;
    if(producer === "cmp8" || producer === "cmp-high8") width = 8;
    if(producer === "cmp-high8") { a >>>= 8; b >>>= 8; }
    const mask = width === 32 ? 0xFFFFFFFF : (1 << width) - 1;
    a = (a & mask) >>> 0;
    b = (b & mask) >>> 0;
    const result = ((a - b) & mask) >>> 0;
    const sign = 2 ** (width - 1);
    const cf = a < b, zf = result === 0, sf = (result & sign) !== 0;
    const of = ((a ^ b) & (a ^ result) & sign) !== 0;
    let parity = 0;
    for(let bit = 0; bit < 8; bit++) parity ^= result >>> bit & 1;
    return [of, !of, cf, !cf, zf, !zf, cf || zf, !cf && !zf,
        sf, !sf, parity === 0, parity !== 0, sf !== of, sf === of,
        zf || sf !== of, !zf && sf === of].map(Number);
}

async function execute(vm, program, label) {
    const interpreted = !label;
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    // Every program reuses CODE. Start each from an empty compiler state:
    // compiled code needs more heat to recompile a page after each rewrite.
    cpu.jit_clear_cache();
    vm.write_memory(Uint8Array.from(program), CODE);
    vm.write_memory(new Uint8Array(4096), OUT);
    vm.write_memory(new Uint8Array(4), 0x600);
    cpu.instruction_pointer[0] = CODE;
    cpu.in_hlt[0] = 0;
    const warm_start = compiled_activations(e);
    vm.run();
    const deadline = performance.now() + 10000;
    while(word(vm, 0x600) < 2 || !interpreted && compiled_activations(e) === warm_start) {
        assert(performance.now() < deadline, `${label || "interpreter"}: warmup timeout`);
        await sleep(1);
    }
    await vm.stop();
    if(!interpreted) {
        // Replay from the beginning after warming, not from an arbitrary
        // partially executed loop. All output must be written again.
        vm.write_memory(new Uint8Array(4096), OUT);
        vm.write_memory(new Uint8Array(4), 0x600);
        cpu.instruction_pointer[0] = CODE;
        const replay_start = compiled_activations(e);
        vm.run();
        while(word(vm, 0x600) < 2) {
            assert(performance.now() < deadline, `${label}: replay timeout`);
            await sleep(1);
        }
        await vm.stop();
        assert(compiled_activations(e) !== replay_start, `${label}: replay must execute compiled code`);
    }
    return Uint8Array.from(vm.read_memory(OUT, 4096));
}

try {
    for(const options of [{ disable_jit: true }, ...COMPILED_ARMS.map(arm => arm.options)]) {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path, bios: { buffer: bios.slice(0) }, ...options,
            memory_size: 32 << 20, disable_keyboard: true, disable_mouse: true,
            disable_speaker: true, net_device: { type: "none" }, autostart: false });
        machines.push(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const deadline = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) {
            assert(performance.now() < deadline, "boot timeout");
            await sleep(1);
        }
        await vm.stop();
    }
    for(const [producer, op] of producers) for(const [name, moves] of neutral) {
        if(process.env.FLAGS_FILTER && !`${producer}/${name}`.includes(process.env.FLAGS_FILTER)) continue;
        for(const consumer of ["setcc", "cmov", "jcc"]) {
            const p = [];
            let output = OUT;
            for(const [a, b] of inputs) for(let cc = 0; cc < 16; cc++) {
                p.push(0xB8, ...u32(a), 0xBB, ...u32(b), 0xBA, ...u32(0x12345678),
                    0xB9, ...u32(0), 0xBE, ...u32(1), 0xF9, ...op, ...moves);
                if(consumer === "setcc") p.push(0x0F, 0x90 | cc, 0x05, ...u32(output));
                else {
                    // EDI/ESI are not aliases of any neutral operation above.
                    p.push(0xBF, ...u32(0));
                    if(consumer === "cmov") p.push(0x0F, 0x40 | cc, 0xFE); // cmovcc edi,esi
                    else p.push(0x70 | (cc ^ 1), 5, 0xBF, ...u32(1));
                    p.push(0x89, 0x3D, ...u32(output));
                }
                // PUSHFD checks that preserving metadata never drops visible
                // flags; mask undefined AF for logical/shift operations.
                p.push(0x9C, 0x5A, 0x81, 0xE2, ...u32(0x8C5), 0x89, 0x15, ...u32(output + 4));
                output += 8;
            }
            p.push(0xFF, 0x05, ...u32(0x600));
            p.push(0xE9, ...u32(-p.length - 5));
            assert(p.length < 8192, "test must fit within two pages");
            const reference = await execute(machines[0], p);
            for(const [arm, { label }] of COMPILED_ARMS.entries()) {
                const actual = await execute(machines[1 + arm], p, label);
                const mismatch = actual.findIndex((value, i) => value !== reference[i]);
                assert.equal(mismatch, -1, `${label}: ${producer}/${name}/${consumer} byte=${mismatch}: ` +
                    `JIT=${actual[mismatch]}, interpreter=${reference[mismatch]}`);
                if(!name.endsWith("barrier")) for(const [index, [a, b]] of inputs.entries()) {
                    const expected = cmp_conditions(producer, a, b);
                    if(expected) for(let cc = 0; cc < 16; cc++) {
                        assert.equal(actual[(index * 16 + cc) * 8], expected[cc],
                            `${label}: ${producer}/${name}/${consumer} independent condition ${cc}, input ${index}`);
                    }
                }
            }
            cases += inputs.length * 16;
            programs++;
        }
    }
    console.log(`PASS: ${cases} flag/condition cases in ${programs} programs (interpreter vs warmed page tier)`);
} finally { for(const vm of machines) await vm.destroy(); }
