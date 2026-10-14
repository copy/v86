// SSSE3 in the 32-bit engines (docs/simd-xsave-plan.md P3): every MMX and XMM
// form against a model of the SDM's pseudocode written here (independent of
// src/rust/cpu/simd_int.rs), with register and memory sources, a destination
// that is also the source, every PALIGNR shift, saturation and sign edges;
// the x87 aliasing and tag transition of the MMX forms; and the exception
// rules: #UD without SSSE3, with CR0.EM, LOCK or an F2/F3 prefix, #NM with
// CR0.TS, #GP for a misaligned XMM memory operand (none for MMX) and #PF,
// each without effect. Every case runs in the interpreter, then hot under
// The page tier and the region tiers.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
import { OPS, PALIGNR, model } from "./ssse3_model.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DEST = 0x200000, SOURCE = 0x201000, OUT = 0x210000, FAULT = 0x21F000, SKIP = 0x21F100;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000, ABSENT = 0x206000;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const bytes = (vm, a, n) => Uint8Array.from(vm.read_memory(a, n));

// Operand data: random bytes, and lanes of edge values
const CASES = 64;
const make_data = seed => {
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const a = new Uint8Array(256 * 16), v = new DataView(a.buffer);
    const bytes = [0x00, 0x01, 0x7F, 0x80, 0x81, 0xFE, 0xFF, 0x40];
    const words = [0x0000, 0x0001, 0x7FFF, 0x8000, 0x8001, 0xFFFF, 0x4000, 0xC000];
    const dwords = [0, 1, 0x7FFFFFFF, 0x80000000, 0x80000001, 0xFFFFFFFF, 0x40000000, 0xC0000000];
    for(let n = 0; n < 256; n++)
    {
        for(let i = 0; i < 16; i++)
        {
            const kind = n % 4;
            if(kind === 0) a[n * 16 + i] = random();
            else if(kind === 1) a[n * 16 + i] = bytes[random() & 7];
            else if(kind === 2 && i % 2 === 0) v.setUint16(n * 16 + i, words[random() & 7], true);
            else if(kind === 3 && i % 4 === 0) v.setUint32(n * 16 + i, dwords[random() & 7], true);
        }
    }
    return a;
};
const destinations = make_data(0x5EED1234), sources = make_data(0x0BADC0DE);

const LOAD_MM = [0x0F, 0x6F], STORE_MM = [0x0F, 0x7F], LOAD_XMM = [0xF3, 0x0F, 0x6F], STORE_XMM = [0xF3, 0x0F, 0x7F];
const absolute = (r, a) => [0x05 | r << 3, ...u32(a)];
/** The instruction: dst, src register, or dst, [address] */
function encode(op, xmm, dst, src, address, imm8, prefixes = [])
{
    const map = op === PALIGNR ? 0x3A : 0x38;
    return [...prefixes, ...(xmm ? [0x66] : []), 0x0F, map, op,
        ...(address === undefined ? [0xC0 | dst << 3 | src] : absolute(dst, address)),
        ...(op === PALIGNR ? [imm8] : [])];
}
// The registers, source address and PALIGNR shift of case n; a destination
// that is also the source holds the source
const operands = (n, xmm, count) => {
    const memory = n >= count / 2;
    // an MMX memory operand needs no alignment
    const address = memory ? SOURCE + n * 16 + (xmm ? 0 : n & 7) : undefined;
    // (every PALIGNR shift once, small and large ones in both halves)
    return { dst: n & 7, src: n >> 3 & 7, memory, address, imm8: n * 37 & 255 };
};
const OSFXSR = [0x0F, 0x20, 0xE0, 0x0D, ...u32(0x600), 0x0F, 0x22, 0xE0]; // CR4 |= OSFXSR | OSXMMEXCPT
const CLTS = [0x0F, 0x06], EMMS = [0x0F, 0x77];
const SET_CR0 = bits => [0x0F, 0x20, 0xC0, 0x0D, ...u32(bits), 0x0F, 0x22, 0xC0];
const CLEAR_CR0 = bits => [0x0F, 0x20, 0xC0, 0x25, ...u32(~bits >>> 0), 0x0F, 0x22, 0xC0];

const machines = [];
async function run(vm, program, warm, interpreter)
{
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    if(warm) cpu.jit_clear_cache();
    // (the page tier's step counts are the hot run's: x64_page_steps)
    else e["x64_page_steps_freeze"]();
    vm.write_memory(Uint8Array.from(program), CODE);
    vm.write_memory(new Uint8Array(4), 0x600);
    cpu.reg32[4] = 0x8000;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
    cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const deadline = performance.now() + 20000;
    while(word(vm, 0x600) !== 0xCAFE || warm && !interpreter && compiled_activations(e) === start)
    {
        assert(performance.now() < deadline, "program/JIT timeout");
        await sleep(1);
    }
    if(warm) await sleep(20);
    await vm.stop();
}
// the body repeats until byte 0x604 is set, then halts after one more round
function loop(body)
{
    const p = [...body, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
    p.push(0xE9, ...u32(-p.length - 5), 0xF4);
    return p;
}
/** A handler for `vector`: records it, the faulting EIP, CR2 and the error code, and skips [SKIP] bytes */
function handler(vector, error_code)
{
    const p = [];
    if(error_code) p.push(0x58, 0xA3, ...u32(FAULT + 12));
    p.push(0xC7, 0x05, ...u32(FAULT), ...u32(vector));
    p.push(0x8B, 0x04, 0x24, 0xA3, ...u32(FAULT + 4));
    p.push(0x0F, 0x20, 0xD0, 0xA3, ...u32(FAULT + 8));
    p.push(0xA1, ...u32(SKIP), 0x01, 0x04, 0x24, 0xCF);
    return p;
}
const VECTORS = [[6, false], [7, false], [13, true], [14, true]];
const PROLOGUE = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), ...CLTS, ...CLEAR_CR0(4), ...OSFXSR];
/** Runs `program` on each machine of `set`: warm (compiled), then once more
 * cold; returns what `read` reads after each run (the cold run is mostly
 * interpreted: the program was rewritten) */
async function run_all(program, before = () => {}, set = machines, read = () => null)
{
    const results = [];
    for(const [i, vm] of set.entries())
    {
        vm.write_memory(Uint8Array.from([255, 7, ...u32(IDT)]), DESCRIPTOR);
        VECTORS.forEach(([vector, error_code], i) => {
            const h = HANDLER + i * 0x100;
            vm.write_memory(Uint8Array.from([h & 255, h >>> 8 & 255, 8, 0, 0, 0x8E, h >>> 16 & 255, h >>> 24]), IDT + vector * 8);
            vm.write_memory(Uint8Array.from(handler(vector, error_code)), h);
        });
        for(const warm of [true, false])
        {
            before(vm);
            vm.write_memory(new Uint8Array(16), FAULT);
            vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
            await run(vm, loop([...PROLOGUE, ...program]), warm, vm === set[0]);
            results.push({ run: `machine ${i} ${warm ? "hot" : "one round"}`, data: read(vm) });
        }
    }
    return results;
}
async function create_machines(options = {})
{
    const set = [];
    for(const arm of [{ disable_jit: true }, ...COMPILED_ARMS.map(arm => arm.options)])
    {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: candidate, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20,
            ...arm, ...options, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
            net_device: { type: "none" }, autostart: false });
        set.push(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const deadline = performance.now() + 10000;
        while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
        await vm.stop();
    }
    return set;
}
/** `faulting` raises `vector` at its first byte after `prologue` (the
 * handler skips it) in every run; `check(out, run)` sees OUT after each */
async function expect_fault(set, prologue, faulting, vector, { epilogue = [], before = () => {}, cr2, error_code, label, check } = {})
{
    const at = CODE + PROLOGUE.length + prologue.length;
    const results = await run_all([...prologue, ...faulting, ...epilogue], vm => {
        vm.write_memory(Uint8Array.from(u32(faulting.length)), SKIP);
        before(vm);
    }, set, vm => ({ fault: [0, 4, 8, 12].map(o => word(vm, FAULT + o)), out: bytes(vm, OUT, 28) }));
    const name = label || faulting.map(b => b.toString(16)).join(" ");
    for(const { run, data } of results)
    {
        assert.deepEqual(data.fault.slice(0, 2), [vector, at], `${name} (${run}): vector, EIP`);
        if(cr2 !== undefined) assert.equal(data.fault[2], cr2, `${name} (${run}): CR2`);
        if(error_code !== undefined) assert.equal(data.fault[3], error_code, `${name} (${run}): error code`);
        check?.(data.out, `${name} (${run})`);
    }
}
const pages = (vm, page, present) => {
    // (the BIOS's page table: 0x13000, identity)
    vm.write_memory(Uint8Array.from(u32(present ? page | 3 : 0)), 0x13000 + (page >>> 12) * 4);
    vm.v86.cpu.wm.exports["full_clear_tlb"]();
};

let checks = 0;
try
{
    // Without SSSE3: every form is #UD, also with CR0.TS (#UD comes first)
    machines.push(...await create_machines());
    for(const [op, name] of OPS)
    {
        for(const xmm of [false, true])
        {
            await expect_fault(machines, [], encode(op, xmm, 1, 2, undefined, 0), 6, { label: `${name} without SSSE3` });
            await expect_fault(machines, SET_CR0(8), encode(op, xmm, 1, undefined, SOURCE, 0), 6,
                { epilogue: CLTS, label: `${name} [mem] without SSSE3, CR0.TS` });
            checks += 2;
        }
    }
    await run_all([0xB8, ...u32(1), 0x0F, 0xA2, 0x89, 0x0D, ...u32(OUT)]);
    for(const vm of machines) assert.equal(word(vm, OUT) >>> 9 & 1, 0, "CPUID.1:ECX.SSSE3");
    for(const vm of machines) await vm.destroy();
    machines.length = 0;
    console.log(`PASS: without SSSE3, CPUID reports none and ${OPS.length * 2} forms are #UD (before #NM)`);

    machines.push(...await create_machines({ cpu_features: ["SSSE3"] }));
    await run_all([0xB8, ...u32(1), 0x0F, 0xA2, 0x89, 0x0D, ...u32(OUT)]);
    for(const vm of machines) assert.equal(word(vm, OUT) >>> 9 & 1, 1, "CPUID.1:ECX.SSSE3");

    // Every form against the model
    let cases = 0;
    for(const [op, name] of OPS)
    {
        for(const xmm of [false, true])
        {
            const size = xmm ? 16 : 8, count = op === PALIGNR ? 256 : CASES;
            const [load, store] = xmm ? [LOAD_XMM, STORE_XMM] : [LOAD_MM, STORE_MM];
            const program = [];
            for(let n = 0; n < count; n++)
            {
                const { dst, src, memory, address, imm8 } = operands(n, xmm, count);
                program.push(...load, ...absolute(dst, DEST + n * 16));
                if(!memory) program.push(...load, ...absolute(src, SOURCE + n * 16));
                program.push(...encode(op, xmm, dst, src, address, imm8));
                program.push(...store, ...absolute(dst, OUT + n * 16));
            }
            if(!xmm) program.push(...EMMS);
            for(const vm of machines) vm.v86.cpu.wm.exports["x64_page_steps_reset"]();
            const runs = await run_all(program, vm => {
                vm.write_memory(destinations, DEST);
                vm.write_memory(sources, SOURCE);
                vm.write_memory(new Uint8Array(count * 16), OUT);
            }, machines, vm => bytes(vm, OUT, count * 16));
            // The page tier (machine 1) has templates for PSHUFB and PALIGNR on
            // XMM registers (IR Tier-0, deleted in P7.5, also had the MMX
            // ones); it steps the others through the interpreter (keyed by
            // their first two bytes: 66 0F, 0F 38 or 0F 3A), each round. A
            // build without Wasm SIMD has no SIMD templates (it still moves
            // XMM registers natively).
            const page_steps = machines[1].v86.cpu.wm.exports["x64_page_steps"];
            const steps = page_steps(xmm ? 0x0F66 : op === PALIGNR ? 0x3A0F : 0x380F);
            const templates = machines[1].v86.cpu.wm.exports["ir_wasm_simd_supported"]() !== 0;
            if(templates && xmm && (op === 0x00 || op === PALIGNR)) assert.ok(steps < count / 2, `${name}: the page tier template (${steps} steps)`);
            else assert.ok(steps >= count, `${name}: the page tier steps (${steps})`);
            const results = runs.map(({ data }) => data);
            for(let n = 0; n < count; n++)
            {
                const { dst, src, memory, address, imm8 } = operands(n, xmm, count);
                const source = memory ? sources.slice(address - SOURCE, address - SOURCE + size) : sources.slice(n * 16, n * 16 + size);
                // (a destination that is also the source register holds the source)
                const destination = !memory && dst === src ? source : destinations.slice(n * 16, n * 16 + size);
                const expected = model(op, destination, source, imm8);
                for(const [i, result] of results.entries())
                {
                    assert.deepEqual(result.slice(n * 16, n * 16 + size), expected,
                        `${name} ${xmm ? "xmm" : "mm"}${dst}, ${memory ? "[mem]" : (xmm ? "xmm" : "mm") + src}` +
                        `${op === PALIGNR ? ", " + imm8 : ""} on ${runs[i].run}: d=${Buffer.from(destination).toString("hex")} s=${Buffer.from(source).toString("hex")}`);
                }
            }
            cases += count;
        }
    }
    checks += cases;
    console.log(`PASS: ${cases} SSSE3 cases (${OPS.length} MMX and XMM forms, register and memory sources, all PALIGNR shifts) match the SDM model on 3 arms; the page tier templates XMM PSHUFB and PALIGNR`);

    // The MMX forms alias the x87 registers: the destination's exponent is all
    // ones, TOP is 0 and all tags are valid. A fault changes nothing.
    const FNINIT = [0xDB, 0xE3], FLD1 = [0xD9, 0xE8], fnstenv = a => [0xD9, 0x35, ...u32(a)], fxsave = a => [0x0F, 0xAE, 0x05, ...u32(a)];
    for(const [op, name] of OPS)
    {
        const runs = await run_all([...FNINIT, ...FLD1, ...LOAD_MM, ...absolute(3, DEST), ...FNINIT, ...FLD1,
            ...encode(op, false, 3, 5, undefined, 4), ...fnstenv(OUT), ...fxsave(OUT + 0x40), ...EMMS], vm => {
            vm.write_memory(destinations, DEST);
        }, machines, vm => ({ env: bytes(vm, OUT, 28), area: bytes(vm, OUT + 0x40, 512) }));
        for(const { run, data: { env, area } } of runs)
        {
            assert.equal(env[5] >> 3 & 7, 0, `${name} (${run}): TOP`);
            assert.equal(env[8] | env[9] << 8, 0, `${name} (${run}): tag word, all valid`);
            assert.deepEqual([area[32 + 3 * 16 + 8], area[32 + 3 * 16 + 9]], [0xFF, 0xFF], `${name} (${run}): MM3's exponent`);
        }
        checks++;
        // #PF on the source: no transition
        await expect_fault(machines, [...FNINIT, ...FLD1], encode(op, false, 3, undefined, ABSENT + 8, 0x11), 14, {
            epilogue: [...fnstenv(OUT), ...FNINIT], cr2: ABSENT + 8, label: `${name} mm3, [absent page]`,
            before: vm => pages(vm, ABSENT, false),
            check: (env, run) => assert.deepEqual([env[5] >> 3 & 7, env[8] | env[9] << 8], [7, 0x3FFF], `${run}: x87 state after #PF`),
        });
        for(const vm of machines) pages(vm, ABSENT, true);
        checks++;
    }
    console.log(`PASS: ${OPS.length} MMX forms set TOP 0, all tags valid and the exponent of their destination; none after #PF`);

    // Faults: CR0.TS (#NM), CR0.EM, LOCK, F2/F3 (#UD), a misaligned XMM memory
    // operand (#GP(0), MMX: none), #PF; the destination keeps its value
    const keep = (xmm, r) => [...(xmm ? LOAD_XMM : LOAD_MM), ...absolute(r, DEST)];
    const kept = (xmm, r) => [...(xmm ? STORE_XMM : STORE_MM), ...absolute(r, OUT)];
    for(const [op, name] of OPS)
    {
        for(const xmm of [false, true])
        {
            const label = `${name} ${xmm ? "xmm" : "mm"}`;
            const check = (out, run) => assert.deepEqual(out.slice(0, xmm ? 16 : 8), destinations.slice(0, xmm ? 16 : 8), `${run}: destination kept`);
            const before = vm => vm.write_memory(destinations, DEST);
            await expect_fault(machines, [...keep(xmm, 6), ...SET_CR0(8)], encode(op, xmm, 6, 1, undefined, 1), 7,
                { epilogue: [...CLTS, ...kept(xmm, 6)], before, label: label + " with CR0.TS", check });
            await expect_fault(machines, [...keep(xmm, 6), ...SET_CR0(4)], encode(op, xmm, 6, undefined, SOURCE, 1), 6,
                { epilogue: [...CLEAR_CR0(4), ...kept(xmm, 6)], before, label: label + " with CR0.EM", check });
            for(const prefix of [0xF0, 0xF2, 0xF3])
            {
                await expect_fault(machines, keep(xmm, 6), encode(op, xmm, 6, 1, undefined, 1, [prefix]), 6,
                    { epilogue: kept(xmm, 6), before, label: `${prefix.toString(16)} ${label}`, check });
            }
            // (the absolute address is linear: the flat segments have base 0)
            const misaligned = encode(op, xmm, 6, undefined, SOURCE + 8, 1);
            if(xmm)
            {
                await expect_fault(machines, keep(xmm, 6), misaligned, 13, { epilogue: kept(xmm, 6), before, error_code: 0, label: label + ", [misaligned]", check });
            }
            else
            {
                const runs = await run_all([...keep(xmm, 6), ...misaligned, ...kept(xmm, 6), ...EMMS], before, machines, vm => word(vm, FAULT));
                for(const { run, data } of runs) assert.equal(data, 0, `${label}, [misaligned] (${run}): no fault`);
            }
            await expect_fault(machines, keep(xmm, 6), encode(op, xmm, 6, undefined, ABSENT + 16, 1), 14, {
                epilogue: kept(xmm, 6), cr2: ABSENT + 16, label: label + ", [absent page]",
                before: vm => { before(vm); pages(vm, ABSENT, false); }, check,
            });
            for(const vm of machines) pages(vm, ABSENT, true);
            checks += 7;
        }
    }
    console.log(`PASS: #NM with CR0.TS; #UD with CR0.EM, LOCK, F2 and F3; #GP(0) for misaligned XMM operands only; #PF; destinations kept (${OPS.length * 2} forms)`);
    console.log(`PASS: ${checks} SSSE3 checks on 3 arms`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
