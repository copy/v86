// CVTPI2PS and CVTPI2PD leave the x87 for MMX (TOP 0, every tag valid) only
// when their source is an MMX register; from memory the x87 stack stays as it
// was. Need for Speed: Most Wanted's mixer runs x87 code right after
// CVTPI2PS xmm, m64: with the transition every load overflowed into the
// indefinite NaN, which reached the reverb's feedback and silenced each race.
// In the interpreter, then hot under the page tier.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DATA = 0x200000, OUT = 0x300000;
const read32 = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const FSW_IE = 1, FSW_SF = 1 << 6;

const fninit = [0xDB, 0xE3], fld1 = [0xD9, 0xE8], faddp = [0xDE, 0xC1], emms = [0x0F, 0x77];
const fstp_m32 = a => [0xD9, 0x1D, ...u32(a)];
const fnstsw_to = a => [0xDF, 0xE0, 0xA3, ...u32(a)];
const movdqu_store = (r, a) => [0xF3, 0x0F, 0x7F, 0x05 | r << 3, ...u32(a)];
// (SSE: CLTS, CR4.OSFXSR and OSXMMEXCPT)
const PROLOGUE = [0x0F, 0x06, 0x0F, 0x20, 0xE0, 0x0D, ...u32(0x600), 0x0F, 0x22, 0xE0];
const program = prefix => [
    ...PROLOGUE,
    // from memory: 1 + 1 on the x87 around it, no stack fault
    ...fninit, ...fld1,
    ...prefix, 0x0F, 0x2A, 0x05, ...u32(DATA),
    ...fld1, ...faddp, ...fstp_m32(OUT), ...fnstsw_to(OUT + 4), ...movdqu_store(0, OUT + 16),
    // from MM0: the transition, so that the next load overflows
    ...fninit, 0x0F, 0x6F, 0x05, ...u32(DATA), ...emms, ...fld1,
    ...prefix, 0x0F, 0x2A, 0xC8,
    ...fld1, ...fstp_m32(OUT + 8), ...fnstsw_to(OUT + 12),
    ...fninit, ...emms,
];
function loop(body)
{
    const p = [...body, 0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE), 0x80, 0x3D, ...u32(0x604), 0, 0x75, 5];
    p.push(0xE9, ...u32(-p.length - 5), 0xF4);
    return p;
}

async function run(vm, code, warm, interpreter)
{
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    if(warm) cpu.jit_clear_cache();
    else e["x64_page_steps_freeze"]();
    vm.write_memory(Uint8Array.from(code), CODE);
    vm.write_memory(new Uint8Array(4), 0x600);
    vm.write_memory(Uint8Array.of(warm ? 0 : 1), 0x604);
    cpu.reg32[4] = 0x8000;
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
    cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const deadline = performance.now() + 60000;
    while(read32(vm, 0x600) !== 0xCAFE || warm && !interpreter && compiled_activations(e) === start)
    {
        assert(performance.now() < deadline, "program/JIT timeout");
        await sleep(1);
    }
    if(warm)
    {
        await sleep(20);
        vm.write_memory(Uint8Array.of(1), 0x604);
        while(!cpu.in_hlt[0])
        {
            assert(performance.now() < deadline, "program end timeout");
            await sleep(1);
        }
    }
    await vm.stop();
}

const machines = [];
try
{
    for(const arm of [{ disable_jit: true }, ...COMPILED_ARMS.map(arm => arm.options)])
    {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: candidate, bios: { buffer: bios.slice(0) }, memory_size: 64 << 20,
            ...arm, disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: { type: "none" }, autostart: false });
        machines.push(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        vm.run();
        const deadline = performance.now() + 10000;
        while(read32(vm, 0x500) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
        await vm.stop();
    }
    for(const [name, prefix] of [["cvtpi2ps", []], ["cvtpi2pd", [0x66]]])
    {
        const code = loop(program(prefix));
        for(const [m, vm] of machines.entries())
        {
            for(const warm of [true, false])
            {
                const run_name = `${name}, machine ${m} ${warm ? "hot" : "one round"}`;
                vm.write_memory(Uint8Array.from([...u32(1), ...u32(-2)]), DATA);
                vm.write_memory(new Uint8Array(32), OUT);
                await run(vm, code, warm, m === 0);
                assert.equal(read32(vm, OUT), 0x40000000, run_name + ": from memory, 1 + 1 on the x87 is 2");
                assert.equal(read32(vm, OUT + 4) & (FSW_SF | FSW_IE), 0, run_name + ": from memory, no stack fault");
                const converted = name === "cvtpi2ps" ? [0x3F800000, 0xC0000000] : [0, 0x3FF00000, 0, 0xC0000000];
                converted.forEach((v, i) => assert.equal(read32(vm, OUT + 16 + 4 * i), v, run_name + ": the conversion"));
                // (the indefinite NaN; its sign as FST m32 stores it is the host's, a separate matter)
                const stored = read32(vm, OUT + 8);
                assert.ok((stored & 0x7FC00000) === 0x7FC00000, run_name + ": from MM0, the next load overflows into a NaN: " + stored.toString(16));
                assert.equal(read32(vm, OUT + 12) & (FSW_SF | FSW_IE), FSW_SF | FSW_IE, run_name + ": from MM0, a stack fault");
            }
        }
        console.log(`PASS: ${name} from memory leaves the x87 stack, from MM0 enters MMX`);
    }
}
finally
{
    for(const vm of machines) await vm.destroy();
}
