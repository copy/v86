// BMI1, BMI2, TZCNT, LZCNT and MOVBE in the 32-bit engines
// (docs/simd-xsave-plan.md 9.2, P10) against tests/rust/bmi_model.mjs:
// every VEX form from registers and memory with edge and random values, the
// destination aliasing the sources, VEX.vvvv and MULX's EDX; the flags the
// SDM defines, v86's values for the undefined ones and, for MULX, PDEP,
// PEXT, RORX and the shifts, flags kept; TZCNT and LZCNT (16 and 32 bits);
// MOVBE loads and stores (16 and 32 bits). Exceptions: #UD for VEX.L1, a
// VEX.vvvv other than 1111b where it is no operand, 66/F2/F3/LOCK before
// VEX, MOVBE from a register; none for CR4.OSXSAVE clear or CR0.TS set (no
// AVX state requirements); #PF without effect, MOVBE's store too. Without
// the features: CPUID reports none, TZCNT and LZCNT are BSF and BSR, the VEX
// forms and MOVBE #UD. Each case runs in the interpreter, then hot under
// the page tier (LZCNT needs the x86-64 profile's machines).
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
import { ARITHMETIC, VEX_FORMS, execute_vex, ops, v86_flags } from "./bmi_model.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, SOURCE = 0x210000, OUT = 0x230000, FAULT = 0x24F000, SKIP = 0x24F100;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000, ABSENT = 0x2F0000;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const bytes = (vm, a, n) => Uint8Array.from(vm.read_memory(a, n));

const absolute = (r, a) => [0x05 | r << 3, ...u32(a)];
const mov_r32 = (r, v) => [0xB8 | r, ...u32(v)];
const store_r32 = (r, a) => [0x89, 0x05 | r << 3, ...u32(a)];
const PUSHF_STORE = a => [0x9C, 0x58, 0xA3, ...u32(a)];
const CLTS = [0x0F, 0x06];
const SET_TS = [0x0F, 0x20, 0xC0, 0x0D, ...u32(8), 0x0F, 0x22, 0xC0];
const NO_OSXSAVE = [0x0F, 0x20, 0xE0, 0x25, ...u32(~(1 << 18) >>> 0), 0x0F, 0x22, 0xE0];
const GPRS = [0, 1, 2, 3, 5, 6, 7]; // (not ESP)
// flags before (set before the operands: MOV keeps them): OF, SF, AF, CF
// (0x7F + 1, STC) or ZF, PF (XOR EAX, EAX)
const FLAGS_BEFORE = [[[0xB0, 0x7F, 0x04, 0x01, 0xF9], 0x891], [[0x31, 0xC0], 0x44]];

/** A three-byte VEX prefix (no register extensions) and opcode, then ModRM
 * (reg, rm register or [address]) and imm8 */
const vex = ({ map, pp, w = 0, vvvv = 0, l = 0 }, op, reg, rm, address, imm8) => [0xC4, 0xE0 | map, w << 7 | (~vvvv & 15) << 3 | l << 2 | pp, op,
    ...(address === undefined ? [0xC0 | reg << 3 | rm] : absolute(reg, address)), ...(imm8 === undefined ? [] : [imm8])];

// Values: edges of 32 bits and random ones
let seed = 0x5EED5EED;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const EDGES = [0, 1, 2, 0x7FFFFFFF, 0x80000000, 0x80000001, 0xFFFFFFFF, 0xFFFFFFFE, 0x0000FFFF, 0xFFFF0000, 0x00010000, 0x8000, 0x55555555, 0xAAAAAAAA, 0x00F0F000];
// BEXTR's control and BZHI's index: within, at and beyond the operand, bits above 15
const CONTROLS = [0x0000, 0x0804, 0x1000, 0x2000, 0x1F01, 0x2001, 0x0020, 0x0021, 0x00FF, 0xFF00, 0xFFFF, 0x10101, 0x0510, 0x401E, 0xFFFF0303];
const INDICES = [0, 1, 4, 15, 16, 31, 32, 33, 63, 64, 255, 0x100, 0x101F, 0xFFFFFF05, 7];
const value_of = n => n % 3 === 0 ? EDGES[(n / 3 | 0) % EDGES.length] : random();

const machines = [];
// The forms the page tier (machines[1]) runs as templates (P10 part 2: the hot ones
// of plan 5.1 and their siblings, 32-bit operands); it steps the others
const PAGE_TEMPLATED = ["andn", "blsr", "blsmsk", "blsi", "bzhi", "shlx", "sarx", "shrx", "rorx", "tzcnt 32", "lzcnt 32", "movbe 32"];
const page_forms = { templated: [], stepped: [] };
/** Before a run: the page tier's step counts from 0 */
const reset_steps = vm => vm.v86.cpu.wm.exports["x64_page_steps_reset"]();
/** After a hot run of `count` cases of `name` on the page tier machine: its
 * steps of instructions beginning with the bytes of `key` (two, little
 * endian) say whether it ran a template (a few steps at most: TLB misses) */
function page_check(vm, run, name, key, count)
{
    if(vm !== machines[1] || !run.startsWith("hot")) return;
    const steps = vm.v86.cpu.wm.exports["x64_page_steps"](key), templated = steps < count;
    assert.equal(templated, PAGE_TEMPLATED.includes(name), `${name}: the page tier ${templated ? "ran a template" : "stepped"} (${steps} steps, ${count} cases)`);
    page_forms[templated ? "templated" : "stepped"].push(name);
}
async function run(vm, program, warm, interpreter, label)
{
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    if(warm) cpu.jit_clear_cache();
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
        assert(performance.now() < deadline, `program/JIT timeout (${label})`);
        await sleep(1);
    }
    // (a hot run goes on a while, then ends at the end of a round)
    if(warm)
    {
        await sleep(20);
        vm.write_memory(Uint8Array.of(1), 0x604);
        while(!cpu.in_hlt[0])
        {
            assert(performance.now() < deadline, `program end timeout (${label})`);
            await sleep(1);
        }
    }
    await vm.stop();
}
// the body repeats until byte 0x604 is set, then halts at the end of the
// round; each round clears the fault record first
const CLEAR_FAULT = [0xC7, 0x05, ...u32(FAULT), 0, 0, 0, 0];
function loop(body)
{
    const p = [...CLEAR_FAULT, ...body, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
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
const PROLOGUE = [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), ...CLTS];
/** Runs `program` on each machine, hot (compiled) then cold; `check` after each run */
async function run_all(program, before = () => {}, set = machines, check = () => {})
{
    for(const [i, vm] of set.entries())
    {
        vm.write_memory(Uint8Array.from([255, 7, ...u32(IDT)]), DESCRIPTOR);
        VECTORS.forEach(([vector, error_code], k) => {
            const h = HANDLER + k * 0x100;
            vm.write_memory(Uint8Array.from([h & 255, h >>> 8 & 255, 8, 0, 0, 0x8E, h >>> 16 & 255, h >>> 24]), IDT + vector * 8);
            vm.write_memory(Uint8Array.from(handler(vector, error_code)), h);
        });
        for(const warm of [true, false])
        {
            before(vm);
            vm.write_memory(new Uint8Array(16), FAULT);
            vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
            await run(vm, loop([...PROLOGUE, ...program]), warm, vm === set[0], `machine ${i} ${warm ? "hot" : "cold"}`);
            check(vm, `${warm ? "hot" : "cold"}, machine ${i}`);
        }
    }
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
/** `faulting` raises `vector` at its first byte after `prologue`, and `check` holds */
async function expect_fault(prologue, faulting, vector, { epilogue = [], before = () => {}, cr2, label, check = () => {} } = {})
{
    const at = CODE + CLEAR_FAULT.length + PROLOGUE.length + prologue.length;
    await run_all([...prologue, ...faulting, ...epilogue], vm => {
        vm.write_memory(Uint8Array.from(u32(faulting.length)), SKIP);
        before(vm);
    }, machines, (vm, run) => {
        assert.deepEqual([word(vm, FAULT), word(vm, FAULT + 4)], [vector, at], `${label} (${run}): vector, EIP`);
        if(cr2 !== undefined) assert.equal(word(vm, FAULT + 8), cr2, `${label} (${run}): CR2`);
        check(vm, run);
    });
}
const no_fault = name => (vm, run) => assert.equal(word(vm, FAULT), 0, `${name} (${run}): fault ${word(vm, FAULT)} at ${word(vm, FAULT + 4).toString(16)}`);
const pages = (vm, page, present) => {
    vm.write_memory(Uint8Array.from(u32(present ? page | 3 : 0)), 0x13000 + (page >>> 12) * 4);
    vm.v86.cpu.wm.exports["full_clear_tlb"]();
};
const CPUID = (leaf, out) => [0xB8, ...u32(leaf), 0x31, 0xC9, 0x0F, 0xA2, 0x89, 0x1D, ...u32(out), 0x89, 0x0D, ...u32(out + 4)];

/** TZCNT/LZCNT (F3 0F BC/BD), BSF/BSR without the F3 */
const count_form = (op, bits, reg, rm, address) => [...bits === 16 ? [0x66] : [], 0xF3, 0x0F, op,
    ...(address === undefined ? [0xC0 | reg << 3 | rm] : absolute(reg, address))];
/** MOVBE load (F0) and store (F1) */
const movbe_form = (op, bits, reg, address) => [...bits === 16 ? [0x66] : [], 0x0F, 0x38, op, ...absolute(reg, address)];

let checks = 0;
try
{
    // Without the features: CPUID reports none; TZCNT and LZCNT are BSF and
    // BSR (the F3 prefix ignored); the VEX forms and MOVBE #UD
    machines.push(...await create_machines());
    await run_all([...CPUID(7, OUT), ...CPUID(1, OUT + 8)], undefined, machines, (vm, run) => {
        assert.equal(word(vm, OUT) & (1 << 3 | 1 << 8), 0, `CPUID.7.0:EBX BMI1, BMI2 (${run})`);
        assert.equal(word(vm, OUT + 12) & 1 << 22, 0, `CPUID.1:ECX MOVBE (${run})`);
    });
    {
        const program = [], count = 16;
        for(let n = 0; n < count; n++)
        {
            const op = n & 1 ? 0xBD : 0xBC, value = n < 8 ? 0 : EDGES[n - 7];
            program.push(...mov_r32(2, value), ...mov_r32(1, 0xDEADBEEF), ...count_form(op, 32, 1, 2), ...store_r32(1, OUT + n * 8), ...PUSHF_STORE(OUT + n * 8 + 4));
        }
        await run_all(program, undefined, machines, (vm, run) => {
            no_fault("TZCNT/LZCNT without their features")(vm, run);
            for(let n = 0; n < count; n++)
            {
                const value = n < 8 ? 0 : EDGES[n - 7], name = n & 1 ? "bsr" : "bsf";
                const { result, flags } = ops[name](BigInt(value), 32, 0xDEADBEEFn);
                assert.equal(word(vm, OUT + n * 8), Number(result), `${name} for F3 0F ${n & 1 ? "BD" : "BC"} ${value.toString(16)} (${run})`);
                assert.equal(word(vm, OUT + n * 8 + 4) & flags.defined, flags.value, `${name}'s ZF (${run})`);
            }
        });
    }
    for(const f of VEX_FORMS)
    {
        await expect_fault([], vex(f, f.op, f.group ?? 1, 2, undefined, f.name === "rorx" ? 5 : undefined), 6, { label: `${f.name} without ${f.isa}` });
    }
    await expect_fault([], movbe_form(0xF0, 32, 1, SOURCE), 6, { label: "movbe without its feature" });
    checks += 4 + VEX_FORMS.length;
    for(const vm of machines) await vm.destroy();
    machines.length = 0;
    console.log("PASS: without the features, CPUID reports none, TZCNT and LZCNT are BSF and BSR, the VEX forms and MOVBE #UD");

    // With them (the x86-64 profile, which alone can have LZCNT)
    machines.push(...await create_machines({ cpu_type: "x86_64", cpu_features: ["BMI1", "BMI2", "LZCNT", "MOVBE"], cpu_features_unreleased: true }));
    await run_all([...CPUID(7, OUT), ...CPUID(1, OUT + 8), ...CPUID(0x80000001, OUT + 16)], undefined, machines, (vm, run) => {
        assert.equal(word(vm, OUT) & (1 << 3 | 1 << 8), 1 << 3 | 1 << 8, `CPUID.7.0:EBX BMI1, BMI2 (${run})`);
        assert.equal(word(vm, OUT + 12) & 1 << 22, 1 << 22, `CPUID.1:ECX MOVBE (${run})`);
        assert.equal(word(vm, OUT + 20) & 1 << 5, 1 << 5, `CPUID.80000001H:ECX LZCNT (${run})`);
    });
    checks += 3;

    // Every VEX form against the model
    for(const f of VEX_FORMS)
    {
        const count = 96, cases = [];
        for(let n = 0; n < count; n++)
        {
            const memory = n >= count / 2;
            // (registers: the destinations alias the sources in a third of the cases)
            const reg = GPRS[n % 7], vvvv = f.roles === "reg = rm, imm8" ? 0 : GPRS[(n + (n % 3 === 0 ? 0 : 3)) % 7];
            const rm = memory ? undefined : GPRS[(n + (n % 3 === 1 ? 0 : 5)) % 7];
            const second = ["bextr"].includes(f.name) ? CONTROLS[n % CONTROLS.length] : ["bzhi"].includes(f.name) ? INDICES[n % INDICES.length] : value_of(n + 1);
            cases.push({ memory, reg: f.group === undefined ? reg : f.group, vvvv, rm, source: value_of(n), second,
                rdx: random(), imm8: n * 7 & 255, address: SOURCE + n * 8 + (n & 3), flags: n & 1 });
        }
        const program = [];
        cases.forEach((c, n) => {
            // the flags, then the registers: every GPR but ESP a value;
            // VEX.vvvv's second, the r/m register the source, EDX MULX's
            // multiplier
            program.push(...FLAGS_BEFORE[c.flags][0]);
            for(const r of GPRS) program.push(...mov_r32(r, 0x11111111 * (r + 1)));
            program.push(...mov_r32(2, c.rdx));
            if(f.roles !== "reg = rm, imm8") program.push(...mov_r32(c.vvvv, c.second));
            if(c.memory) program.push(0xC7, 0x05, ...u32(c.address), ...u32(c.source));
            else program.push(...mov_r32(c.rm, c.source));
            program.push(...vex({ map: f.map, pp: f.pp, vvvv: c.vvvv }, f.op, c.reg, c.rm, c.memory ? c.address : undefined, f.name === "rorx" ? c.imm8 : undefined));
            for(const [k, r] of GPRS.entries()) program.push(...store_r32(r, OUT + n * 32 + 4 * k));
            program.push(...PUSHF_STORE(OUT + n * 32 + 28));
        });
        await run_all(program, vm => { vm.write_memory(new Uint8Array(count * 32), OUT); reset_steps(vm); }, machines, (vm, run) => {
            no_fault(f.name)(vm, run);
            page_check(vm, run, f.name, f.map === 3 ? 0xE3C4 : 0xE2C4, count);
            cases.forEach((c, n) => {
                const registers = [];
                for(const r of GPRS) registers[r] = BigInt(0x11111111 * (r + 1) >>> 0);
                registers[2] = BigInt(c.rdx);
                if(f.roles !== "reg = rm, imm8") registers[c.vvvv] = BigInt(c.second >>> 0);
                if(!c.memory) registers[c.rm] = BigInt(c.source);
                const source = c.memory ? BigInt(c.source) : registers[c.rm];
                const { writes, flags } = execute_vex(f, { reg: c.reg, vvvv: c.vvvv, source, imm8: c.imm8, gpr: r => registers[r], bits: 32 });
                for(const [r, v] of writes) registers[r] = v;
                const label = `${f.name} case ${n} (${c.memory ? "memory" : "r" + c.rm}, vvvv r${c.vvvv}, reg r${c.reg}) source ${c.source.toString(16)} second ${(c.second >>> 0).toString(16)} (${run})`;
                for(const [k, r] of GPRS.entries()) assert.equal(word(vm, OUT + n * 32 + 4 * k), Number(registers[r]), `${label}: r${r}`);
                const after = word(vm, OUT + n * 32 + 28) & ARITHMETIC;
                if(flags) assert.equal(after, v86_flags(writes[writes.length - 1][1], 32, flags), `${label}: flags`);
                else assert.equal(after, FLAGS_BEFORE[c.flags][1], `${label}: flags kept`);
            });
        });
        checks += count;
    }
    console.log(`PASS: ${VEX_FORMS.length} VEX forms from registers and memory as the model: the destinations, aliasing, MULX's EDX, the flags (kept where the SDM leaves them)`);

    // TZCNT and LZCNT (16 and 32 bits) from registers and memory, the 16-bit
    // destination's upper half kept
    for(const [op, name] of [[0xBC, "tzcnt"], [0xBD, "lzcnt"]]) for(const bits of [16, 32])
    {
        const count = 48, program = [];
        const operands = Array.from({ length: count }, (_, n) => ({ memory: n >= count / 2, dst: GPRS[n % 7], src: GPRS[(n + 3) % 7], value: value_of(n),
            address: SOURCE + n * 8 + (n & 3) }));
        const operand = n => operands[n];
        for(let n = 0; n < count; n++)
        {
            const { memory, dst, src, value, address } = operand(n);
            program.push(...FLAGS_BEFORE[n & 1][0]);
            if(memory) program.push(0xC7, 0x05, ...u32(address), ...u32(value));
            else program.push(...mov_r32(src, value));
            program.push(...mov_r32(dst, 0xDEADBEEF));
            program.push(...count_form(op, bits, dst, src, memory ? address : undefined), ...store_r32(dst, OUT + n * 8), ...PUSHF_STORE(OUT + n * 8 + 4));
        }
        await run_all(program, reset_steps, machines, (vm, run) => {
            no_fault(name)(vm, run);
            page_check(vm, run, `${name} ${bits}`, bits === 16 ? 0xF366 : 0x0FF3, count);
            for(let n = 0; n < count; n++)
            {
                const { memory, dst, src, value } = operand(n);
                const source = memory || src !== dst ? value : 0xDEADBEEF;
                const { result, flags } = ops[name](BigInt(source), bits);
                const expected = bits === 16 ? (0xDEADBEEF & 0xFFFF0000 | Number(result)) >>> 0 : Number(result);
                const label = `${name} (${bits}) case ${n} ${source.toString(16)} (${run})`;
                assert.equal(word(vm, OUT + n * 8), expected, label);
                assert.equal(word(vm, OUT + n * 8 + 4) & ARITHMETIC, v86_flags(result, bits, flags), `${label}: flags`);
            }
        });
        checks += count;
    }
    console.log("PASS: TZCNT and LZCNT (16 and 32 bits) from registers and memory: the counts, the operand's size for 0 with CF, ZF");

    // MOVBE: loads and stores of 16 and 32 bits, unaligned; flags kept
    for(const bits of [16, 32])
    {
        const count = 32, program = [], values = Array.from({ length: count }, (_, n) => value_of(n));
        for(let n = 0; n < count; n++)
        {
            const value = values[n], r = GPRS[n % 7], address = SOURCE + n * 8 + (n & 3);
            program.push(...FLAGS_BEFORE[n & 1][0], 0xC7, 0x05, ...u32(address), ...u32(value), ...mov_r32(r, 0xA5A5A5A5));
            program.push(...movbe_form(0xF0, bits, r, address), ...store_r32(r, OUT + n * 16));
            program.push(...mov_r32(r, value), ...movbe_form(0xF1, bits, r, OUT + n * 16 + 4 + (n & 3)), ...PUSHF_STORE(OUT + n * 16 + 12));
        }
        await run_all(program, vm => { vm.write_memory(new Uint8Array(count * 16).fill(0xEE), OUT); reset_steps(vm); }, machines, (vm, run) => {
            no_fault("movbe")(vm, run);
            page_check(vm, run, `movbe ${bits}`, bits === 16 ? 0x0F66 : 0x380F, count * 2);
            for(let n = 0; n < count; n++)
            {
                const value = values[n], swapped = Number(ops.movbe(BigInt(value) & (1n << BigInt(bits)) - 1n, bits).result);
                const label = `movbe (${bits}) case ${n} ${value.toString(16)} (${run})`;
                assert.equal(word(vm, OUT + n * 16), bits === 16 ? (0xA5A50000 | swapped) >>> 0 : swapped, `${label}: load`);
                const stored = bytes(vm, OUT + n * 16 + 4 + (n & 3), bits / 8 + 1);
                assert.deepEqual(Array.from(stored.subarray(0, bits / 8)), u32(swapped).slice(0, bits / 8), `${label}: store`);
                assert.equal(stored[bits / 8], 0xEE, `${label}: no byte beyond`);
                assert.equal(word(vm, OUT + n * 16 + 12) & ARITHMETIC, FLAGS_BEFORE[n & 1][1], `${label}: flags kept`);
            }
        });
        checks += count;
    }
    console.log("PASS: MOVBE loads and stores (16 and 32 bits): the bytes reversed, no byte beyond");
    assert.deepEqual([...page_forms.templated].sort(), [...PAGE_TEMPLATED].sort(), "every form the page tier runs as a template was run");
    console.log(`PASS: the page tier ran templates for ${page_forms.templated.join(", ")}; stepped ${page_forms.stepped.join(", ")}`);

    // Exceptions: #UD for VEX.L1, a VEX.vvvv other than 1111b where it is no
    // operand (RORX), 66/F2/F3/LOCK before VEX, MOVBE from a register; none
    // for CR4.OSXSAVE clear or CR0.TS set
    const andn = vex({ map: 2, pp: 0, vvvv: 3 }, 0xF2, 1, 2);
    await expect_fault([], vex({ map: 2, pp: 0, vvvv: 3, l: 1 }, 0xF2, 1, 2), 6, { label: "andn with VEX.L1" });
    await expect_fault([], vex({ map: 3, pp: 3, vvvv: 2 }, 0xF0, 1, 2, undefined, 3), 6, { label: "rorx with VEX.vvvv 2" });
    for(const prefix of [0x66, 0xF2, 0xF3, 0xF0]) await expect_fault([], [prefix, ...andn], 6, { label: `${prefix.toString(16)} andn` });
    await expect_fault([], [0x0F, 0x38, 0xF0, 0xC1], 6, { label: "movbe from a register" });
    await run_all([...NO_OSXSAVE, ...SET_TS, ...mov_r32(2, 0xF0F0), ...mov_r32(3, 0xFF00), ...andn, ...store_r32(1, OUT), ...CLTS], undefined, machines, (vm, run) => {
        no_fault("andn without CR4.OSXSAVE, with CR0.TS")(vm, run);
        assert.equal(word(vm, OUT), 0x00F0, `andn without CR4.OSXSAVE, with CR0.TS (${run})`);
    });
    checks += 8;
    // #PF: the source on an absent page, the destination kept; MOVBE's store
    // across into it writes nothing
    await expect_fault([...mov_r32(1, 0x12345678)], vex({ map: 2, pp: 0, vvvv: 3 }, 0xF2, 1, undefined, ABSENT - 2), 14, {
        cr2: ABSENT, label: "andn across into an absent page",
        before: vm => pages(vm, ABSENT, false),
        check: (vm, run) => assert.equal(vm.v86.cpu.reg32[1] >>> 0, 0x12345678, `andn's destination kept (${run})`),
    });
    await expect_fault([...mov_r32(1, 0x12345678)], movbe_form(0xF1, 32, 1, ABSENT - 2), 14, {
        cr2: ABSENT, label: "movbe store across into an absent page",
        before: vm => { vm.write_memory(new Uint8Array(2).fill(0xEE), ABSENT - 2); pages(vm, ABSENT, false); },
        check: (vm, run) => assert.deepEqual(Array.from(bytes(vm, ABSENT - 2, 2)), [0xEE, 0xEE], `movbe wrote nothing (${run})`),
    });
    for(const vm of machines) pages(vm, ABSENT, true);
    checks += 2;
    console.log("PASS: #UD for VEX.L1, VEX.vvvv where no operand, prefixes before VEX and MOVBE from a register; no AVX state requirements; #PF without effect");

    // Virtual-8086 mode and real mode with a 32-bit code segment, where C4
    // is LES (last: it rewrites the descriptor and page tables): a loop
    // runs until the byte at 604h is set (on the compiled arms in
    // virtual-8086 mode once compiled code ran it: the page tier compiles
    // virtual-8086 code, x64_page_v86, but not real-mode code on a 32-bit
    // stack, which the interpreter runs; the region tiers, which compiled
    // both, were deleted in M11), then falls through to ANDN, which raises
    // #UD, or TZCNT, which runs, and the HLT after it halts (real mode) or
    // raises #GP. The handlers halt: virtual-8086 mode's at ring 0 (a TSS
    // gives the stack), real mode's through the vector table at 0.
    const V86_CODE = 0x8000, GDT = 0x251100, TSS = 0x251200, RING0_STACK = 0x253000, UD_HALT = 0x281000, GP_HALT = 0x281010, REAL_UD = 0x70000;
    const descriptor = (base, limit, access, flags) => [...u32(limit & 0xFFFF | base << 16), ...u32(base & 0xFF000000 | base >>> 16 & 255 | access << 8 | limit & 0xF0000 | flags << 20)];
    // (virtual-8086 mode first: real mode leaves CR0.PE clear)
    for(const real of [false, true])
    {
        for(const [form, name] of [[[0xC4, 0xE2, 0x68, 0xF2, 0xCE], "andn"], [[0xF3, 0x0F, 0xBC, 0xCE], "tzcnt"]])
        {
            for(const [i, vm] of machines.entries())
            {
                const cpu = vm.v86.cpu, e = cpu.wm.exports;
                const label = `${name} in ${real ? "real mode (32-bit code)" : "virtual-8086 mode"} (machine ${i})`;
                // L: INC (E)SI; CMP BYTE [604h], 0; JE L; the form; HLT
                const loop_code = real ? [0x46, 0x80, 0x3D, ...u32(0x604), 0x00, 0x74, 0xF6] : [0x46, 0x80, 0x3E, 0x04, 0x06, 0x00, 0x74, 0xF8];
                cpu.jit_clear_cache();
                vm.write_memory(Uint8Array.from([...loop_code, ...form, 0xF4]), V86_CODE);
                vm.write_memory(new Uint8Array(1), 0x604);
                vm.write_memory(Uint8Array.of(0xF4), UD_HALT);
                vm.write_memory(Uint8Array.of(0xF4), GP_HALT);
                vm.write_memory(Uint8Array.of(0xF4), REAL_UD);
                if(real)
                {
                    // (CR0.PE and PG clear; the vector table at 0: #UD at 7000:0000)
                    cpu.cr[0] &= ~0x80000001; cpu.protected_mode[0] = 0;
                    vm.write_memory(Uint8Array.from([0, 0, 0x00, 0x70]), 6 * 4);
                    cpu.idtr_offset[0] = 0; cpu.idtr_size[0] = 0x3FF;
                    cpu.sreg.fill(0, 0, 6);
                    for(let r = 0; r < 6; r++)
                    {
                        cpu.segment_offsets[r] = 0; cpu.segment_limits[r] = 0xFFFFFFFF; cpu.segment_is_null[r] = 0;
                    }
                    cpu.segment_access_bytes.set([0x93, 0x9B, 0x93, 0x93, 0x93, 0x93]);
                    cpu.cpl[0] = 0; cpu.is_32[0] = 1; cpu.stack_size_32[0] = 1;
                    cpu.flags[0] = 2;
                }
                else
                {
                    // ring-0 code (8) and data (16), the TSS (24) with SS0:ESP0
                    vm.write_memory(Uint8Array.from([...new Array(8).fill(0), ...descriptor(0, 0xFFFFF, 0x9B, 12), ...descriptor(0, 0xFFFFF, 0x93, 12), ...descriptor(TSS, 0x67, 0x89, 0)]), GDT);
                    vm.write_memory(Uint8Array.from([0, 0, 0, 0, ...u32(RING0_STACK), ...u32(16)]), TSS);
                    cpu.gdtr_offset[0] = GDT; cpu.gdtr_size[0] = 31;
                    cpu.segment_offsets[6] = TSS; cpu.segment_limits[6] = 0x67; cpu.tss_size_32[0] = 1;
                    for(const [vector, h] of [[6, UD_HALT], [13, GP_HALT]])
                        vm.write_memory(Uint8Array.from([h & 255, h >>> 8 & 255, 8, 0, 0, 0x8E, h >>> 16 & 255, h >>> 24]), IDT + vector * 8);
                    cpu.idtr_offset[0] = IDT; cpu.idtr_size[0] = 0x7FF;
                    // (user pages: the first 4 MiB)
                    const pde = cpu.cr[3] & ~0xFFF, table = word(vm, pde) & ~0xFFF;
                    vm.write_memory(Uint8Array.from(u32(word(vm, pde) | 4)), pde);
                    for(const page of [0, 8, 9]) vm.write_memory(Uint8Array.from(u32(word(vm, table + page * 4) | 4)), table + page * 4);
                    // CS 0800h (the code at 0), SS 0900h (SP 1000h), ES/DS/FS/GS 0
                    cpu.sreg.set([0, 0x0800, 0x0900, 0, 0, 0]);
                    for(let r = 0; r < 6; r++)
                    {
                        cpu.segment_offsets[r] = cpu.sreg[r] << 4; cpu.segment_limits[r] = 0xFFFF; cpu.segment_is_null[r] = 0;
                    }
                    cpu.segment_access_bytes.set([0xF3, 0xFB, 0xF3, 0xF3, 0xF3, 0xF3]);
                    cpu.cpl[0] = 3; cpu.is_32[0] = 0; cpu.stack_size_32[0] = 0;
                    cpu.flags[0] = 0x20002;
                }
                cpu.flags_changed[0] = 0;
                cpu.reg32.set([0, 0xA5A5A5A5, 0x804, 0x5A5A5A5A, real ? 0xA000 : 0x1000, 0, 0x12345677, 0]);
                cpu.instruction_pointer[0] = V86_CODE; cpu.in_hlt[0] = 0;
                e.update_state_flags(); e.full_clear_tlb();
                const start = compiled_activations(e);
                vm.run();
                const deadline = performance.now() + 20000;
                while(i !== 0 && !real && compiled_activations(e) === start)
                {
                    assert(performance.now() < deadline, `${label}: no compiled code ran`);
                    await sleep(1);
                }
                await sleep(20);
                vm.write_memory(Uint8Array.of(1), 0x604);
                while(!cpu.in_hlt[0])
                {
                    assert(performance.now() < deadline, `${label}: timed out`);
                    await sleep(1);
                }
                await vm.stop();
                const at = loop_code.length, source = real ? cpu.reg32[6] >>> 0 : cpu.reg32[6] & 0xFFFF;
                const halted = name === "andn" ? real ? REAL_UD : UD_HALT : real ? V86_CODE + at + form.length : GP_HALT;
                assert.equal(cpu.instruction_pointer[0] >>> 0, halted + 1, `${label}: halted`);
                if(!real) assert.equal(word(vm, RING0_STACK - 36), name === "andn" ? at : at + form.length, `${label}: the faulting IP`);
                const count = Number(ops.tzcnt(BigInt(source), real ? 32 : 16).result);
                assert.equal(cpu.reg32[1] >>> 0, name === "andn" ? 0xA5A5A5A5 : real ? count : (0xA5A50000 | count) >>> 0, `${label}: ECX`);
            }
            checks++;
        }
    }
    console.log("PASS: virtual-8086 mode and real mode, where C4 is LES: ANDN raises #UD, TZCNT runs, interpreted and compiled");
    console.log(`PASS: ${checks} BMI1/BMI2/TZCNT/LZCNT/MOVBE checks on ${COMPILED_ARMS.length + 1} arms`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
