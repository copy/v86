// AVX in the 32-bit engines (docs/simd-xsave-plan.md 8, P5): the VEX forms
// of the shared executor (src/rust/cpu/avx.rs) against a model written here
// from the SDM, and the rules every VEX form shares: VEX.vvvv is the first
// source; a VEX.128 destination register has bits 255:128 zeroed (seen
// through XSAVE, after XRSTOR loaded every upper half), legacy SSE leaves
// them; memory operands have their exact width and need no alignment but
// for VMOVAPS/VMOVAPD/VMOVDQA and the non-temporal moves (#GP(0)); #UD
// without CR4.OSXSAVE, XCR0's SSE and YMM bits or the AVX feature, #NM with
// CR0.TS (after #UD); CR0.EM and CR4.OSFXSR do not matter; #PF has no
// effect. Operands alias in every combination; VEX.W and VEX.L where they
// are ignored, and both VEX prefixes. Every case runs in the interpreter,
// then hot under the page tier (templates for the hot forms, steps for the others)
// and the region tiers (natively on the legacy SSE lifters, or through the
// AVX helpers, ir::runtime::avx).
//
// P5 part 1: the data movement and logic forms, VZEROUPPER, VLDMXCSR and
// VSTMXCSR.
import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations, vex_settled } from "./compiled_arms.mjs";
import { FORMS, big, execute, le, mask, memory_bytes } from "./avx_model.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const hex = bytes => Buffer.from(bytes).toString("hex");
const CODE = 0x100000, SOURCE = 0x200000, DEST = 0x220000, OUT = 0x240000, FAULT = 0x24F000, SKIP = 0x24F100;
const IDT = 0x250000, DESCRIPTOR = 0x251000, HANDLER = 0x280000, ABSENT = 0x2F0000;
// a case's XRSTOR and XSAVE areas (standard format, YMM_Hi128 at 576)
const AREAS = 0x300000;
const area_in = n => AREAS + n * 0x800, area_out = n => AREAS + n * 0x800 + 0x400;
// a case's memory at SOURCE and DEST
const SPAN = 48;
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const bytes = (vm, a, n) => Uint8Array.from(vm.read_memory(a, n));

// instructions
const absolute = (r, a) => [0x05 | r << 3, ...u32(a)];
const mov_r32 = (r, v) => [0xB8 | r, ...u32(v)];
const store_r32 = (r, a) => [0x89, 0x05 | r << 3, ...u32(a)];
const xsetbv = value => [...mov_r32(1, 0), ...mov_r32(0, value), ...mov_r32(2, 0), 0x0F, 0x01, 0xD1];
const xrstor = a => [...mov_r32(3, a), ...mov_r32(0, 6), ...mov_r32(2, 0), 0x0F, 0xAE, 0x2B];
const xsave = a => [...mov_r32(3, a), ...mov_r32(0, 6), ...mov_r32(2, 0), 0x0F, 0xAE, 0x23];
// CR4 = CR4 | or & and
const cr4 = (or, and = -1) => [0x0F, 0x20, 0xE0, 0x0D, ...u32(or), 0x25, ...u32(and >>> 0), 0x0F, 0x22, 0xE0];
const OSFXSR = 0x200, OSXMMEXCPT = 0x400, OSXSAVE = 1 << 18;
const CLTS = [0x0F, 0x06];
const SET_CR0 = bits => [0x0F, 0x20, 0xC0, 0x0D, ...u32(bits), 0x0F, 0x22, 0xC0];
const CLEAR_CR0 = bits => [0x0F, 0x20, 0xC0, 0x25, ...u32(~bits >>> 0), 0x0F, 0x22, 0xC0];
/** A VEX instruction: map (1: 0F, 2: 0F38, 3: 0F3A), pp (0, 1: 66, 2: F3,
 * 3: F2), VEX.L, VEX.W and VEX.vvvv; the ModRM byte's reg and r/m register
 * or [address] (neither: no ModRM byte); imm8. The two-byte prefix unless
 * `three`, the map or VEX.W needs the three-byte one. */
function vex({ map = 1, pp = 0, l = 0, w = 0, vvvv = 0, three = false }, op, reg, rm, address, imm8)
{
    const modrm = address !== undefined ? absolute(reg, address) : rm !== undefined ? [0xC0 | reg << 3 | rm] : [];
    const tail = [op, ...modrm, ...(imm8 === undefined ? [] : [imm8])];
    const fields = (~vvvv & 15) << 3 | l << 2 | pp;
    if(map === 1 && !w && !three) return [0xC5, 0x80 | fields, ...tail];
    return [0xC4, 0xE0 | map, w << 7 | fields, ...tail];
}
const GPRS = [1, 5, 6, 7, 0, 2, 3]; // (not ESP)

// Operand data: a case's XMM and YMM_Hi128 registers, MXCSR and memory
const random_bytes = (seed, n) => {
    const a = new Uint8Array(n);
    for(let i = 0; i < n; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; a[i] = seed; }
    return a;
};
const MAX_CASES = 64;
const XMM = random_bytes(0x5EED1234, MAX_CASES * 128), YMMH = random_bytes(0x0BADC0DE, MAX_CASES * 128);
const SOURCES = random_bytes(0x13579BDF, MAX_CASES * SPAN), DESTINATIONS = random_bytes(0x2468ACE1, MAX_CASES * SPAN);
const MXCSRS = random_bytes(0x600DF00D, MAX_CASES * 2);
const GPR_VALUES = random_bytes(0xFEEDFACE, MAX_CASES * 4);
// (exceptions masked: the floating-point forms' cases run without faults, tests/rust/avx_fp.mjs has those)
const mxcsr_of = n => MXCSRS[2 * n] | MXCSRS[2 * n + 1] << 8 | 0x1F80;
const gpr_of = n => new DataView(GPR_VALUES.buffer).getUint32(4 * n, true);
/** The state of case `n` (`c`) before its instruction: XMM0-7 (x), their
 * upper halves (h), MXCSR, the memory at its source (read-only here) and
 * destination, and 16 bytes of results (out); its memory operand at `c.at`
 * of both (avx_model.mjs's execute) */
function initial(n, c)
{
    const s = {
        x: Array.from({ length: 8 }, (_, r) => big(XMM.subarray((n * 8 + r) * 16, (n * 8 + r + 1) * 16))),
        h: Array.from({ length: 8 }, (_, r) => big(YMMH.subarray((n * 8 + r) * 16, (n * 8 + r + 1) * 16))),
        mxcsr: mxcsr_of(n),
        src: c.source || SOURCES.subarray(n * SPAN, (n + 1) * SPAN),
        dest: Uint8Array.from(c.destination || DESTINATIONS.subarray(n * SPAN, (n + 1) * SPAN)),
        out: Uint8Array.from(c.out_before || new Uint8Array(16)),
    };
    const at = c.at ?? 0;
    s.load = size => big(s.src.subarray(at, at + size));
    s.store = (size, v) => s.dest.set(le(v, size), at);
    s.load_at = (offset, size) => big(s.src.subarray(at + offset, at + offset + size));
    s.store_at = (offset, size, v) => s.dest.set(le(v, size), at + offset);
    // (registers the case sets: c.registers)
    for(const [r, value] of Object.entries(c.registers || {})) s.x[r] = value;
    for(const [r, value] of Object.entries(c.uppers || {})) s.h[r] = value;
    s.masked = (value, selected) => le(value).forEach((b, i) => { if(selected[i]) s.dest[at + i] = b; });
    s.gpr = r => BigInt(c.gpr_values?.[r] ?? c.gpr);
    // (ECX of VPCMPESTRI/VPCMPISTRI and the general-purpose destinations: out[0..4])
    s.set_gpr = (r, value) => s.out.set(le(value & mask(32), 4));
    // (the flags: out[4..8], those that set them)
    Object.defineProperty(s, "flags", { set: value => { s.out.set(le(BigInt(value), 4), 4); } });
    return s;
}
/** Case `n`'s XRSTOR area: MXCSR, XMM0-7 (those of `registers` instead)
 * and YMM_Hi128 0-7 in use */
function area(n, registers = {}, uppers = {})
{
    const a = new Uint8Array(832);
    a.set(u32(mxcsr_of(n)), 24);
    a.set(XMM.subarray(n * 128, n * 128 + 128), 160);
    for(const [r, value] of Object.entries(registers)) a.set(le(value), 160 + 16 * r);
    a[512] = 6;
    a.set(YMMH.subarray(n * 128, n * 128 + 128), 576);
    for(const [r, value] of Object.entries(uppers)) a.set(le(value), 576 + 16 * r);
    return a;
}

const machines = [];
/** `until`: what else a warm run of compiled code waits for */
async function run(vm, program, warm, interpreter, label, until = () => true)
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
    while(word(vm, 0x600) !== 0xCAFE || warm && !interpreter && (compiled_activations(e) === start || !until(vm)))
    {
        assert(performance.now() < deadline, `program/JIT timeout (${label}: ${program.length} bytes, done ${word(vm, 0x600) === 0xCAFE}, ` +
            `compiled ${compiled_activations(e) - start}, ${until(vm) ? "" : "not "}ready, last fault ${word(vm, FAULT)} at ${word(vm, FAULT + 4).toString(16)})`);
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
const VECTORS = [[6, false], [7, false], [13, true], [14, true], [19, false]];
// SSE and AVX state enabled: CR4.OSFXSR, OSXMMEXCPT and OSXSAVE, XCR0 7
// (without AVX: 3)
const prologue = xcr0 => [0x0F, 0x01, 0x1D, ...u32(DESCRIPTOR), ...CLTS, ...CLEAR_CR0(4), ...cr4(OSFXSR | OSXMMEXCPT | OSXSAVE), ...xsetbv(xcr0)];
let PROLOGUE = prologue(7);
/** Runs `program` on each machine of `set`: warm (compiled), then once more
 * cold; returns what `read` reads after each run (the cold run is mostly
 * interpreted: the program was rewritten) */
async function run_all(program, before = () => {}, set = machines, read = () => null, until = undefined)
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
            await run(vm, loop([...PROLOGUE, ...program]), warm, vm === set[0], `machine ${i} ${warm ? "hot" : "one round"}`, until);
            results.push({ label: `machine ${i} ${warm ? "hot" : "one round"}`, data: read(vm) });
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
const pages = (vm, page, present) => {
    // (the BIOS's page table: 0x13000, identity)
    vm.write_memory(Uint8Array.from(u32(present ? page | 3 : 0)), 0x13000 + (page >>> 12) * 4);
    vm.v86.cpu.wm.exports["full_clear_tlb"]();
};
/** The rounds of a check_cases program that the page tier (machine 1) ran since
 * x64_page_steps_reset: it steps each case's XRSTOR and XSAVE (0F AE) */
const page_rounds = () => machines[1].v86.cpu.wm.exports["x64_page_steps"](0xAE0F) / 2;
// The VEX forms of gen/isa_hot_forms.json, which have page tier templates (P5
// part 5): the others here, against every case; the floating-point ones with
// ordinary operands (see PAGE_HOT_FP)
const PAGE_HOT = ["vmovsd", "vmovss", "vmovapd", "vmovaps", "vmovdqu", "vmovdqa", "vmovq", "vmovd", "vxorpd", "vxorps",
    "vandpd", "vandnpd", "vorpd", "vpand", "vpandn", "vpor", "vpxor", "vpcmpeqb", "vpcmpeqd", "vpcmpgtb", "vpaddb",
    "vpmovmskb", "vzeroupper", "vunpcklpd", "vunpckhpd", "vblendvpd", "vpshufb", "vpbroadcastb", "vpbroadcastd"];
// The VEX.256 ones (P6 part 3: the moves and VZEROALL; with the moves of
// the other types): every form of the name templated
const PAGE_HOT_256 = ["vmovdqu", "vmovdqa", "vmovntdq", "vzeroall", "vmovups", "vmovaps", "vmovupd", "vmovapd",
    "vmovntps", "vmovntpd",
    // (AVX2, P7 part 3)
    "vpmovmskb", "vpcmpeqb", "vpcmpeqd", "vpaddb", "vpandn", "vpminub", "vpcmpgtb", "vpand", "vpminud", "vpor", "vpxor",
    "vpbroadcastb", "vpbroadcastd"].map(name => name + " ymm");
// (IR Tier-0, deleted in P7.5, also templated VCVTTSD2SI, VCVTSD2SS,
// VCVTSI2SD, VCVTSS2SD and VCVTPD2PS; the page tier steps them)
const PAGE_HOT_FP = ["vaddsd", "vmulsd", "vsubsd", "vdivsd", "vaddss", "vmulss", "vsubss", "vdivss", "vmulpd", "vcomisd",
    "vucomisd", "vcomiss", "vucomiss", "vcmpsd"];
// The hot forms the region tiers run without the AVX helpers (P5 part 6):
// PAGE_HOT's but VBLENDVPD (BLENDVPD's helper) and VPSHUFB (from memory:
// PSHUFB's helper) and AVX2's broadcasts (the AVX helper)
const REGIONS_NATIVE = PAGE_HOT.filter(name => !["vblendvpd", "vpshufb", "vpbroadcastb", "vpbroadcastd"].includes(name));
/** The forms whose cases the page tier ran templates for (fewer steps than cases)
 * or stepped, by name (" ymm": a VEX.256 form's) */
const page_forms = { templated: new Set(), stepped: new Set() };
/** The forms the region tiers ran without the AVX helpers (no calls in the
 * hot run) or with them */
const region_forms = { native: new Set(), helper: new Set() };
/** VEX instructions stepped by the page tier (machine 1) since x64_page_steps_reset:
 * keyed by their first two bytes, C4 or C5 and the next, or an address-size
 * or segment prefix and C4 or C5 */
function page_vex_steps()
{
    const steps = machines[1].v86.cpu.wm.exports["x64_page_steps"];
    let count = 0;
    for(let byte = 0; byte < 256; byte++) count += steps(0xC4 | byte << 8) + steps(0xC5 | byte << 8);
    for(const prefix of [0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x67]) count += steps(prefix | 0xC400) + steps(prefix | 0xC500);
    return count;
}

let checks = 0;
/** The build has Wasm SIMD (the portable one has no vector IR) */
const simd = vm => vm.v86.cpu.wm.exports["ir_wasm_simd_supported"]() !== 0;
/** Runs `cases` in one program: each loads its registers with XRSTOR, runs
 * its `code` between `pre` and `post` and stores its registers with XSAVE;
 * the registers, MXCSR, its destination memory and `out` must be as its
 * `model` says, in each run. Returns the VEX instructions the page tier stepped in
 * its hot run; with the `form` under test, records whether the page tier ran a
 * template for it (page_forms) */
async function check_cases(name, cases, { before = () => {}, form } = {})
{
    const program = [];
    for(const c of cases)
    {
        program.push(...xrstor(area_in(c.n)), ...(c.pre || []), ...c.code, ...(c.post || []), ...xsave(area_out(c.n)));
    }
    const write = vm => {
        for(const c of cases)
        {
            vm.write_memory(area(c.n, c.registers, c.uppers), area_in(c.n));
            vm.write_memory(new Uint8Array(832), area_out(c.n));
            vm.write_memory(c.source || SOURCES.subarray(c.n * SPAN, (c.n + 1) * SPAN), c.source_at ?? SOURCE + c.n * SPAN);
            vm.write_memory(c.destination || DESTINATIONS.subarray(c.n * SPAN, (c.n + 1) * SPAN), c.destination_at ?? DEST + c.n * SPAN);
            vm.write_memory(new Uint8Array(16), OUT + c.n * 16);
        }
        before(vm);
    };
    for(const vm of machines)
    {
        vm.v86.cpu.wm.exports["x64_page_steps_reset"]();
        vm.v86.cpu.wm.exports["ir_avx_calls_reset"]();
    }
    const settled = vex_settled(0x600);
    const results = await run_all(program, write, machines, vm => ({
        fault: word(vm, FAULT),
        cases: cases.map(c => ({
            area: bytes(vm, area_out(c.n), 832),
            dest: bytes(vm, c.destination_at ?? DEST + c.n * SPAN, SPAN),
            out: bytes(vm, OUT + c.n * 16, 16),
        })),
        page: vm === machines[1] ? page_vex_steps() : 0,
        avx_calls: vm.v86.cpu.wm.exports["ir_avx_calls"](),
    }), vm => vm === machines[1] ? page_rounds() >= cases.length :
        vm === machines[2] && simd(vm) ? settled(vm) : true);
    // (the hot runs ran the VEX forms compiled: the page tier a template or steps,
    // the region tiers call the AVX helper, but in a build without Wasm
    // SIMD, which has neither page tier SIMD templates nor regions with XMM state)
    const steps = results[2].data.page;
    if(form)
    {
        // (a template retries some cases at most: floating-point lanes it refuses)
        if(steps < cases.length / 2 && simd(machines[1])) page_forms.templated.add(form_key(form));
        else
        {
            assert.ok(steps >= cases.length || form.kind === "fp", `${name}: the page tier stepped ${steps} VEX instructions`);
            page_forms.stepped.add(form_key(form));
        }
    }
    if(form && simd(machines[2])) region_forms[results[4].data.avx_calls ? "helper" : "native"].add(form_key(form));
    for(const { label, data } of results)
    {
        assert.equal(data.fault, 0, `${name} (${label}): no fault`);
        cases.forEach((c, i) => {
            const s = initial(c.n, c);
            c.model(s);
            const got = data.cases[i];
            const what = `${name} case ${c.n} ${hex(c.code)} (${label})`;
            for(let r = 0; r < 8; r++)
            {
                assert.equal(hex(got.area.subarray(160 + 16 * r, 176 + 16 * r)), hex(le(s.x[r])), `${what}: xmm${r}`);
                assert.equal(hex(got.area.subarray(576 + 16 * r, 592 + 16 * r)), hex(le(s.h[r])), `${what}: ymm${r}[255:128]`);
            }
            assert.equal(new DataView(got.area.buffer).getUint32(24, true), s.mxcsr, `${what}: MXCSR`);
            assert.equal(hex(got.dest), hex(s.dest), `${what}: memory`);
            assert.equal(hex(got.out), hex(s.out), `${what}: results`);
        });
    }
    checks += cases.length;
    return steps;
}
/** Registers of case `n`: destination, first source and r/m, which alias in
 * every combination over 32 cases */
const regs = n => {
    const d = n & 7;
    const v = [d, d + 1 & 7, n >> 1 & 7, n * 5 & 7][n >> 3 & 3];
    const m = [d, v, d + 3 & 7, n * 3 + 2 & 7][n & 3];
    return [d, v, m];
};
const CASES = 32;

/** `faulting` raises `vector` at its first byte in every run, after
 * XRSTOR of case 0's registers and `setup`, before `epilogue` and XSAVE:
 * the registers (but YMM_Hi128 with `keep_upper` false), MXCSR and the
 * memory at `memory` are unchanged */
async function expect_fault(setup, faulting, vector, { epilogue = [], before = () => {}, cr2, error_code, label, memory, keep_upper = true, registers = {}, uppers = {} } = {})
{
    const at = CODE + PROLOGUE.length + xrstor(0).length + setup.length;
    for(const vm of machines) vm.v86.cpu.wm.exports["x64_page_steps_reset"]();
    const results = await run_all([...xrstor(area_in(0)), ...setup, ...faulting, ...epilogue, ...xsave(area_out(0))], vm => {
        vm.write_memory(Uint8Array.from(u32(faulting.length)), SKIP);
        vm.write_memory(area(0, registers, uppers), area_in(0));
        before(vm);
    }, machines, vm => ({ fault: [0, 4, 8, 12].map(o => word(vm, FAULT + o)), area: bytes(vm, area_out(0), 832),
        memory: memory && bytes(vm, memory[0], memory[1].length) }),
    // (the page tier steps XRSTOR: the faulting form runs as a template once the
    // page has been compiled again with an entry after it)
    vm => vm !== machines[1] || page_rounds() >= 300);
    const name = label || hex(faulting);
    const initial_area = area(0, registers, uppers);
    for(const { label: run, data } of results)
    {
        assert.deepEqual(data.fault.slice(0, 2), [vector, at], `${name} (${run}): vector, EIP`);
        if(cr2 !== undefined) assert.equal(data.fault[2], cr2, `${name} (${run}): CR2`);
        if(error_code !== undefined) assert.equal(data.fault[3], error_code, `${name} (${run}): error code`);
        assert.equal(hex(data.area.subarray(160, 288)), hex(initial_area.subarray(160, 288)), `${name} (${run}): XMM registers kept`);
        if(keep_upper) assert.equal(hex(data.area.subarray(576, 704)), hex(initial_area.subarray(576, 704)), `${name} (${run}): YMM_Hi128 kept`);
        assert.equal(word_of(data.area, 24), mxcsr_of(0), `${name} (${run}): MXCSR kept`);
        if(memory) assert.equal(hex(data.memory), hex(memory[1]), `${name} (${run}): memory kept`);
    }
    checks++;
}
const word_of = (a, at) => new DataView(a.buffer, a.byteOffset).getUint32(at, true);

// the kinds of forms (avx_model.mjs) whose memory operand is a destination,
// and those with VEX.vvvv
const STORES = ["store", "scalar_st", "store64", "gpr_store", "stmxcsr", "extract", "maskstore", "extract128"];
const VVVV = ["binary", "low", "high", "binary_imm", "insert", "insertps", "blendv", "shift_imm", "maskload", "maskstore", "insert128"];
/** The form has VEX.vvvv (the immediate shifts: the destination) */
const has_vvvv = (f, memory) => VVVV.includes(f.kind) || ["scalar", "scalar_st"].includes(f.kind) && !memory ||
    f.kind === "fp" && ["three", "from_gpr"].includes(f.operands);
// flags before an instruction that sets them: OF, SF, AF (0x7F + 1) and CF (STC)
const FLAGS_BEFORE = [0xB0, 0x7F, 0x04, 0x01, 0xF9];
/** EFLAGS' OSZAPC to `a` (EAX changes) */
const store_flags = a => [0x9C, 0x58, 0x25, ...u32(0x8D5), 0xA3, ...u32(a)];
// explicit lengths of VPCMPESTRx (EAX, EDX): within, beyond, negative, the extremes
const LENGTHS = [0, 1, 3, 7, 8, 9, 15, 16, 17, -1, -5, -16, -17, 0x7FFFFFFF, -0x80000000];
/** Case `n` of gather `f`: VSIB [EBX + index << scale], EBX the source's
 * middle (negative indices too), every element within the source; the
 * destination, mask and index registers distinct; quadword indices beyond
 * 32 bits in odd elements, which 32-bit addressing drops; random masks */
function gather_case(f, n)
{
    const [d, v, index] = [n & 7, n + 3 & 7, n + 5 & 7], scale = n & 3, at = 24;
    const count = (f.l ? 32 : 16) / Math.max(f.data, f.index);
    const low = -(at >> scale), high = SPAN - at - f.data >> scale;
    let indices = 0n;
    for(let k = 0; k < count; k++)
    {
        const value = BigInt(low + (n * 7 + k * 5) % (high - low + 1)) + (f.index === 8 && k & 1 ? 1n << 40n : 0n);
        indices |= BigInt.asUintN(8 * f.index, value) << BigInt(8 * f.index * k);
    }
    const c = { n, at, registers: { [index]: indices & mask(128) }, pre: mov_r32(3, SOURCE + n * SPAN + at), post: [],
        code: [...vex({ map: 2, pp: 1, l: f.l ?? 0, w: f.w, vvvv: v }, f.op), d << 3 | 4, scale << 6 | index << 3 | 3] };
    // (indices beyond the low 128 bits: the others random)
    if(count * f.index > 16) c.uppers = { [index]: indices >> 128n };
    c.model = s => execute(f, s, { d, v, index, scale, long: false });
    return c;
}
/** A form's name, " ymm" added for a VEX.256 one */
const form_key = f => f.name + (f.l ? " ymm" : "");
/** Case `n` of form `f`: registers that alias in every combination, the
 * memory operand from n/2 on (unaligned but for the aligned moves), the
 * general-purpose registers set before and stored after */
function form_case(f, n)
{
    if(f.kind === "gather") return gather_case(f, n);
    const [d, v, m] = regs(n);
    const memory = f.memory || !f.register && n >= CASES / 2;
    const at = f.aligned ? 16 * (n & 1) : n % 17;
    // (the immediate shifts: VEX.vvvv is the destination)
    const vvvv = f.kind === "shift_imm" ? d : has_vvvv(f, memory) ? v : 0;
    // (every imm8 in turn over the forms' cases; VPBLENDVB: the mask register in imm8[7:4], imm8[7] ignored;
    // the shifts by imm8 and VPALIGNR mostly counts below the element's or the
    // operand's size, beyond which the result is 0)
    const imm8 = f.kind === "blendv" ? (n * 5 + 3) % 16 << 4 | n * 7 & 15 : f.kind === "shift_imm" ? (n * 7 + 1) % 20 :
        f.name === "vpalignr" ? (n * 7 + 3) % 36 : n * 37 + 11 & 255;
    const store = STORES.includes(f.kind);
    const address = memory ? (store ? DEST : SOURCE) + n * SPAN + at : undefined;
    const r = GPRS[n % 7];
    const c = { n, at, pre: [], post: [] };
    let [reg, rm] = [d, m];
    const o = { d, v: f.kind === "shift_imm" ? d : v, m: memory ? undefined : m, imm8, long: false };
    switch(f.kind)
    {
        case "to_gpr":
            reg = o.d = r;
            c.pre = mov_r32(r, 0xDEADBEEF);
            c.post = store_r32(r, OUT + n * 16);
            break;
        case "shift_imm": reg = f.group; break;
        case "extract": case "insert":
            rm = r;
            if(memory) break;
            o.m = r;
            c.gpr = gpr_of(n);
            c.pre = mov_r32(r, f.kind === "insert" ? c.gpr : 0xDEADBEEF);
            if(f.kind === "extract") c.post = store_r32(r, OUT + n * 16);
            break;
        case "ptest": case "vtest":
            c.pre = FLAGS_BEFORE;
            c.post = store_flags(OUT + n * 16 + 4);
            break;
        case "fp":
            if(f.operands === "comi")
            {
                c.pre = FLAGS_BEFORE;
                c.post = store_flags(OUT + n * 16 + 4);
            }
            else if(f.operands === "to_gpr")
            {
                reg = o.d = r;
                c.pre = mov_r32(r, 0xDEADBEEF);
                c.post = store_r32(r, OUT + n * 16);
            }
            else if(f.operands === "from_gpr" && !memory)
            {
                rm = o.m = r;
                c.gpr = gpr_of(n);
                c.pre = mov_r32(r, c.gpr);
            }
            break;
        case "pcmpstr":
        {
            // (EAX and EDX: the explicit lengths; ECX ones; the flags set)
            const [la, lb] = [LENGTHS[n % LENGTHS.length], LENGTHS[(n * 7 + 3) % LENGTHS.length]];
            c.gpr_values = { 0: la >>> 0, 2: lb >>> 0 };
            // (VPCMPxSTRM leave ECX)
            c.out_before = Uint8Array.of(255, 255, 255, 255, ...new Array(12).fill(0));
            c.pre = [...FLAGS_BEFORE, ...mov_r32(0, la >>> 0), ...mov_r32(2, lb >>> 0), ...mov_r32(1, -1 >>> 0)];
            c.post = [...store_r32(1, OUT + n * 16), ...store_flags(OUT + n * 16 + 4)];
            break;
        }
        case "gpr_load": case "gpr_store":
            rm = r;
            if(memory) break;
            o.m = r;
            c.gpr = gpr_of(n);
            c.pre = mov_r32(r, f.kind === "gpr_load" ? c.gpr : 0xDEADBEEF);
            if(f.kind === "gpr_store") c.post = store_r32(r, OUT + n * 16);
            break;
        case "ldmxcsr":
        {
            reg = f.group;
            const value = u32(mxcsr_of(n + 32));
            c.source = Uint8Array.from({ length: SPAN }, (_, i) => i >= at && i < at + 4 ? value[i - at] : SOURCES[n * SPAN + i]);
            break;
        }
        case "stmxcsr": reg = f.group; break;
        case "maskmov": c.pre = mov_r32(7, DEST + n * SPAN + at); break;
    }
    // (the shifts by xmm/m128: a count below or beyond the element's width
    // in the low quadword, which alone counts, and random bits above it)
    if(!f.map && f.kind === "binary" && [0xD1, 0xD2, 0xD3, 0xE1, 0xE2, 0xF1, 0xF2, 0xF3].includes(f.op))
    {
        const count = BigInt(n * 5 % 70) | big(SOURCES.subarray(n * SPAN + 8, n * SPAN + 16)) << 64n;
        if(memory)
        {
            c.source = Uint8Array.from(SOURCES.subarray(n * SPAN, (n + 1) * SPAN));
            c.source.set(le(count), at);
        }
        else c.registers = { [m]: count };
    }
    // (the variable shifts: each element's count below or beyond the
    // element's width; as dwords, the qwords' counts and zeros)
    if(f.map === 2 && f.op >= 0x45 && f.op <= 0x47 && f.kind === "binary")
    {
        let counts = 0n;
        for(let k = 0; k < 4; k++) counts |= BigInt((n * 7 + k * 13) % 72) << BigInt(64 * k);
        if(memory)
        {
            c.source = Uint8Array.from(SOURCES.subarray(n * SPAN, (n + 1) * SPAN));
            c.source.set(le(counts, f.l ? 32 : 16), at);
        }
        else
        {
            c.registers = { [m]: counts & mask(128) };
            if(f.l) c.uppers = { [m]: counts >> 128n };
        }
    }
    // (VEX.W where ignored: WIG, WIG32 outside 64-bit mode; VEX.L where ignored, VEX.256 forms' 1)
    const fields = { map: f.map || 1, pp: f.pp, w: f.w === undefined || f.wig32 ? n & 1 : f.w, l: f.l ?? (f.lig ? n >> 2 & 1 : 0), three: !!(n & 2), vvvv };
    const immediate = ["load_imm", "binary_imm", "shift_imm", "extract", "insert", "insertps", "blendv", "pcmpstr", "insert128", "extract128"].includes(f.kind) ||
        f.imm || f.legacy?.imm8 ? imm8 : undefined;
    c.code = f.kind === "zero_upper" || f.kind === "zero_all" ? vex(fields, f.op) : vex(fields, f.op, reg, rm, address, immediate);
    c.model = s => execute(f, s, o);
    return c;
}

try
{
    // Without AVX: CPUID does not report it, and every VEX form is #UD (with
    // CR4.OSXSAVE and XCR0 3)
    machines.push(...await create_machines({ cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE"], cpu_features_unreleased: true }));
    PROLOGUE = prologue(3);
    {
        const results = await run_all([0xB8, ...u32(1), 0x0F, 0xA2, 0x89, 0x0D, ...u32(OUT)], () => {}, machines, vm => word(vm, OUT));
        for(const { label, data } of results) assert.equal(data >>> 28 & 1, 0, `CPUID.1:ECX.AVX (${label})`);
    }
    for(const [label, form] of [["vmovaps xmm1, xmm2", vex({ pp: 0 }, 0x28, 1, 2)], ["vpxor xmm1, xmm2, [mem]", vex({ pp: 1, vvvv: 2 }, 0xEF, 1, undefined, SOURCE)],
        ["vzeroupper", vex({}, 0x77)], ["vmovd xmm1, ecx", vex({ pp: 1 }, 0x6E, 1, 1)]])
    {
        const results = await run_all(form, vm => vm.write_memory(Uint8Array.from(u32(form.length)), SKIP), machines,
            vm => [0, 4].map(o => word(vm, FAULT + o)));
        for(const { label: run, data } of results) assert.deepEqual(data, [6, CODE + PROLOGUE.length], `${label} without AVX (${run}): #UD`);
        checks++;
    }
    PROLOGUE = prologue(7);
    for(const vm of machines) await vm.destroy();
    machines.length = 0;
    console.log("PASS: without AVX, CPUID does not report it and VEX forms are #UD");

    // With AVX but without AVX2: CPUID.7.0:EBX does not report it, and
    // AVX2's forms (VEX.256 of the packed integer instructions) are #UD
    machines.push(...await create_machines({ cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX"], cpu_features_unreleased: true }));
    {
        const results = await run_all([0xB8, ...u32(7), 0x31, 0xC9, 0x0F, 0xA2, 0x89, 0x1D, ...u32(OUT)], () => {}, machines, vm => word(vm, OUT));
        for(const { label, data } of results) assert.equal(data >>> 5 & 1, 0, `CPUID.7.0:EBX.AVX2 (${label})`);
    }
    for(const [label, form] of [["vpaddd ymm1, ymm2, ymm3", vex({ pp: 1, l: 1, vvvv: 2 }, 0xFE, 1, 3)],
        ["vpshufb ymm1, ymm2, [mem]", vex({ map: 2, pp: 1, l: 1, vvvv: 2 }, 0x00, 1, undefined, SOURCE)],
        ["vpsrlw ymm1, ymm2, 3", vex({ pp: 1, l: 1, vvvv: 1 }, 0x71, 2, 2, undefined, 3)], ["vpmovmskb ecx, ymm1", vex({ pp: 1, l: 1 }, 0xD7, 1, 1)],
        ["vpbroadcastb xmm1, xmm2", vex({ map: 2, pp: 1 }, 0x78, 1, 2)], ["vpsllvd xmm1, xmm2, xmm3", vex({ map: 2, pp: 1, vvvv: 2 }, 0x47, 1, 3)],
        ["vpermq ymm1, ymm2, 0x1B", vex({ map: 3, pp: 1, l: 1, w: 1 }, 0x00, 1, 2, undefined, 0x1B)],
        ["vbroadcastss xmm1, xmm2", vex({ map: 2, pp: 1 }, 0x18, 1, 2)]])
    {
        const results = await run_all(form, vm => vm.write_memory(Uint8Array.from(u32(form.length)), SKIP), machines,
            vm => [0, 4].map(o => word(vm, FAULT + o)));
        for(const { label: run, data } of results) assert.deepEqual(data, [6, CODE + PROLOGUE.length], `${label} without AVX2 (${run}): #UD`);
        checks++;
    }
    for(const vm of machines) await vm.destroy();
    machines.length = 0;
    console.log("PASS: with AVX but without AVX2, CPUID does not report AVX2 and its forms are #UD");

    machines.push(...await create_machines({ cpu_features: ["SSSE3", "SSE4.1", "SSE4.2", "XSAVE", "AVX", "AVX2"], cpu_features_unreleased: true }));
    {
        const results = await run_all([0xB8, ...u32(1), 0x0F, 0xA2, 0x89, 0x0D, ...u32(OUT)], () => {}, machines, vm => word(vm, OUT));
        for(const { label, data } of results) assert.equal(data >>> 27 & 3, 3, `CPUID.1:ECX.OSXSAVE and AVX (${label})`);
    }

    // every form against the model (AVX_ONLY=name,...: those forms only)
    const only = process.env.AVX_ONLY?.split(",");
    for(const f of FORMS.filter(f => !f.long && (!only || only.includes(f.name))))
    {
        await check_cases(`${f.name}${f.l ? " ymm" : ""} (${(f.map || 1) === 1 ? "" : (f.map === 2 ? "0F38 " : "0F3A ")}${f.op.toString(16)}${f.group === undefined ? "" : "/" + f.group})`,
            Array.from({ length: f.kind.startsWith("zero_") || f.memory && f.kind.endsWith("mxcsr") ? 8 : CASES }, (_, n) => form_case(f, n)), { form: f });
    }
    if(simd(machines[1]))
    {
        for(const name of PAGE_HOT.filter(name => !only || only.includes(name))) assert.ok(page_forms.templated.has(name), `${name}: a page tier template`);
        for(const name of PAGE_HOT_256.filter(name => !only || only.includes(name.slice(0, -4))))
        {
            assert.ok(page_forms.templated.has(name) && !page_forms.stepped.has(name), `${name}: the page tier templates`);
        }
    }
    if(simd(machines[2]))
    {
        for(const name of REGIONS_NATIVE.filter(name => !only || only.includes(name))) assert.ok(region_forms.native.has(name), `${name}: natively in the region tiers`);
    }
    if(process.env.AVX_REGION_FORMS) console.log("regions without the AVX helpers:", [...region_forms.native].join(","), "\nwith them:", [...region_forms.helper].join(","));
    console.log(`PASS: ${FORMS.filter(f => !f.long).length} forms against the model, from registers and memory: bits 255:128 of register destinations zeroed; ` +
        `The page tier templates for ${page_forms.templated.size} of them, the region tiers without the AVX helpers for ${region_forms.native.size}`);

    // The floating-point hot forms run page tier templates (or their exact path)
    // for ordinary operands: finite, normal and of moderate size
    {
        const values = [1.5, -2.25, 3000, -0.007, 1024, -1, 650, 0.125];
        const vector = (double, k) => {
            const b = new Uint8Array(16), view = new DataView(b.buffer);
            for(let lane = 0; lane < (double ? 2 : 4); lane++)
            {
                const x = values[(k + lane * 3) % values.length];
                if(double) view.setFloat64(8 * lane, x, true);
                else view.setFloat32(4 * lane, x, true);
            }
            return b;
        };
        for(const f of FORMS.filter(f => !f.long && !f.l && PAGE_HOT_FP.includes(f.name) && (!only || only.includes(f.name))))
        {
            const double = f.legacy.double ?? f.legacy.kind === "narrow";
            const cases = Array.from({ length: CASES }, (_, n) => {
                const c = form_case(f, n);
                c.registers = Object.fromEntries(Array.from({ length: 8 }, (_, r) => [r, big(vector(double, n + r))]));
                c.source = new Uint8Array(SPAN);
                c.source.set(vector(double, n + 5).subarray(0, 16), c.at);
                return c;
            });
            const steps = await check_cases(`${f.name} of ordinary operands`, cases);
            if(simd(machines[1])) assert.ok(steps < CASES / 2, `${f.name}: a page tier template (${steps} steps)`);
        }
    }
    // VEX.256 moves among VEX.128 forms in one block (P6 part 3): a VEX.128
    // write zeroes bits 255:128 again after a VEX.256 move wrote them
    // (the page tier zeroes a register's once per block, Emitter::ymm_zeroed), the
    // halves between registers and memory, VZEROALL
    {
        const cases = [];
        for(let n = 0; n < 8; n++)
        {
            // (32-byte aligned: SPAN is 48)
            const at = 16 * (n & 1), source = SOURCE + n * SPAN + at, destination = DEST + n * SPAN + at;
            const load = (pp, op, reg) => vex({ pp, l: 1 }, op, reg, undefined, source);
            cases.push({ n, at, code: n < 4 ? [
                ...load(2, 0x6F, 1), // vmovdqu ymm1, [m256]
                ...vex({ vvvv: 1 }, 0x57, 1, 1), // vxorps xmm1, xmm1, xmm1
                ...load(0, 0x10, 1), // vmovups ymm1, [m256]
                ...vex({ pp: 1, vvvv: 1 }, 0xEF, 1, 1), // vpxor xmm1, xmm1, xmm1
                ...load(0, 0x28, 2), // vmovaps ymm2, [m256]
                ...vex({ l: 1 }, 0x28, 3, 2), // vmovaps ymm3, ymm2
                ...vex({ l: 1 }, 0x11, 2, 4), // vmovups ymm4, ymm2 (11 /r)
                ...vex({ pp: 1, l: 1 }, 0x7F, 3, undefined, destination), // vmovdqa [m256], ymm3
                ...vex({ pp: 1, vvvv: 5 }, 0xEF, 5, 4), // vpxor xmm5, xmm5, xmm4
            ] : [
                ...load(2, 0x6F, 6), // vmovdqu ymm6, [m256]
                ...vex({ l: 1 }, 0x77), // vzeroall
                ...load(1, 0x6F, 7), // vmovdqa ymm7, [m256]
                ...vex({ pp: 2, l: 1 }, 0x7F, 7, 0), // vmovdqu ymm0, ymm7 (7F /r)
                ...vex({ vvvv: 7 }, 0x57, 7, 7), // vxorps xmm7, xmm7, xmm7
                ...vex({ pp: 1, l: 1 }, 0xE7, 0, undefined, destination), // vmovntdq [m256], ymm0
            ], model: s => {
                const [low, high] = [s.load_at(0, 16), s.load_at(16, 16)];
                if(n < 4)
                {
                    [s.x[1], s.h[1]] = [0n, 0n];
                    for(const r of [2, 3, 4]) [s.x[r], s.h[r]] = [low, high];
                    [s.x[5], s.h[5]] = [s.x[5] ^ low, 0n];
                }
                else
                {
                    s.x.fill(0n);
                    s.h.fill(0n);
                    [s.x[0], s.h[0]] = [low, high];
                }
                s.store_at(0, 16, low);
                s.store_at(16, 16, high);
            } });
        }
        const steps = await check_cases("VEX.256 moves and VEX.128 forms in a block", cases);
        if(simd(machines[1])) assert.ok(steps < cases.length / 2, `VEX.256 moves in a block: the page tier templates (${steps} steps)`);
    }
    console.log(`PASS: the page tier templates for ${PAGE_HOT.length + PAGE_HOT_FP.length + PAGE_HOT_256.length} hot forms, VEX.256 moves among VEX.128 forms in a block`);

    // (IR Tier-0 made the instruction after an interpreted VEX one a dispatch
    // entry, so a loop of VEX forms was checked to dispatch as often as one of
    // their legacy forms, P5 part 5; the page tier, which replaced it in
    // P7.5, interprets 32-bit code one instruction at a time, VEX or not)

    // VMASKMOVDQU to [DI] with an address-size prefix (DI's address below
    // 64 KiB; EDI's upper half ignored)
    {
        const f = FORMS.find(f => f.kind === "maskmov");
        const cases = [];
        for(let n = 0; n < 8; n++)
        {
            const c = form_case(f, n), low = 0xC000 + n * SPAN;
            cases.push({ ...c, pre: mov_r32(7, 0x5A5A0000 | low + c.at), code: [0x67, ...c.code], destination_at: low });
        }
        await check_cases("vmaskmovdqu (address size 16)", cases);
    }
    console.log("PASS: VMASKMOVDQU to [DI]");

    // Legacy SSE keeps bits 255:128 of its destination, VEX.128 zeroes them
    {
        const chain = [
            0x0F, 0x28, 0xCA,                       // movaps xmm1, xmm2
            ...vex({ pp: 0 }, 0x28, 3, 4),          // vmovaps xmm3, xmm4
            0x0F, 0x57, 0xEE,                       // xorps xmm5, xmm6
            ...vex({ pp: 0, vvvv: 6 }, 0x57, 6, 6), // vxorps xmm6, xmm6, xmm6
            0xF3, 0x0F, 0x10, 0xF8,                 // movss xmm7, xmm0
            ...vex({ pp: 1, vvvv: 7 }, 0xEB, 0, 1), // vpor xmm0, xmm7, xmm1
        ];
        await check_cases("legacy and VEX moves", [{ n: 0, code: chain, model: s => {
            s.x[1] = s.x[2];
            s.x[3] = s.x[4]; s.h[3] = 0n;
            s.x[5] ^= s.x[6];
            s.x[6] = 0n; s.h[6] = 0n;
            s.x[7] = s.x[7] & ~mask(32) | s.x[0] & mask(32);
            s.x[0] = s.x[7] | s.x[1]; s.h[0] = 0n;
        } }]);
    }
    // CR0.EM and CR4.OSFXSR do not matter to VEX forms
    await check_cases("VEX with CR0.EM or without CR4.OSFXSR", [
        { n: 0, pre: SET_CR0(4), code: vex({ pp: 0 }, 0x28, 1, 2), post: CLEAR_CR0(4), model: s => { s.x[1] = s.x[2]; s.h[1] = 0n; } },
        { n: 1, pre: cr4(0, ~OSFXSR), code: vex({ pp: 1, vvvv: 3 }, 0xEF, 1, 2), post: cr4(OSFXSR), model: s => { s.x[1] = s.x[3] ^ s.x[2]; s.h[1] = 0n; } },
        { n: 2, pre: [...SET_CR0(4), ...cr4(0, ~OSFXSR)], code: vex({ pp: 0 }, 0x77), post: [...CLEAR_CR0(4), ...cr4(OSFXSR)], model: s => s.h.fill(0n) },
    ]);
    // narrow operands at the end of a page: no access beyond them
    const form = (pp, op, kind) => FORMS.find(f => f.pp === pp && f.op === op && f.kind === kind && (f.map || 1) === 1);
    // (the form of a name, not one of the 64-bit mode's; the VEX.256 one)
    const named = (name, kind) => FORMS.find(f => f.name === name && !f.long && (kind === undefined || f.kind === kind));
    const ymm = (name, kind) => FORMS.find(f => f.name === name && f.l === 1 && (kind === undefined || f.kind === kind));
    for(const [label, f, d, v, imm8] of [
        ["vmovss xmm1, [m32]", form(2, 0x10, "scalar"), 1], ["vmovsd xmm2, [m64]", form(3, 0x10, "scalar"), 2],
        ["vmovlps xmm3, xmm4, [m64]", form(0, 0x12, "low"), 3, 4], ["vmovhpd xmm5, xmm6, [m64]", form(1, 0x16, "high"), 5, 6],
        ["vmovddup xmm7, [m64]", form(3, 0x12, "load"), 7], ["vmovq xmm0, [m64]", form(2, 0x7E, "load"), 0],
        ["vmovd xmm1, [m32]", form(1, 0x6E, "gpr_load"), 1], ["vldmxcsr [m32]", form(0, 0xAE, "ldmxcsr"), 2],
        ["vmovss [m32], xmm1", form(2, 0x11, "scalar_st"), 1], ["vmovhps [m64], xmm2", form(0, 0x17, "store64"), 2],
        ["vmovq [m64], xmm3", form(1, 0xD6, "store"), 3], ["vstmxcsr [m32]", form(0, 0xAE, "stmxcsr"), 3],
        ["vmovd [m32], xmm4", form(1, 0x7E, "gpr_store"), 4],
        ["vpmovsxbq xmm1, [m16]", named("vpmovsxbq"), 1], ["vpmovzxdq xmm7, [m64]", named("vpmovzxdq"), 7],
        ["vpinsrb xmm2, xmm3, [m8], 1", named("vpinsrb"), 2, 3, 1], ["vinsertps xmm5, xmm6, [m32], 0x10", named("vinsertps"), 5, 6, 0x10],
        ["vpextrb [m8], xmm4, 2", named("vpextrb"), 4, undefined, 2], ["vpextrw [m16], xmm3, 5", named("vpextrw", "extract"), 3, undefined, 5],
        ["vaddss xmm1, xmm2, [m32]", named("vaddss"), 1, 2], ["vcvtsd2ss xmm3, xmm4, [m64]", named("vcvtsd2ss"), 3, 4],
        ["vcvtps2pd xmm5, [m64]", named("vcvtps2pd"), 5], ["vroundsd xmm6, xmm7, [m64], 1", named("vroundsd"), 6, 7, 1],
        ["vcomiss xmm0, [m32]", named("vcomiss"), 0], ["vbroadcastss xmm2, [m32]", named("vbroadcastss"), 2],
        // (VEX.256: 32 bytes, or those of the element)
        ["vmovups ymm1, [m256]", ymm("vmovups", "load"), 1], ["vmovdqu [m256], ymm2", ymm("vmovdqu", "store"), 2],
        ["vmovddup ymm3, [m256]", ymm("vmovddup"), 3], ["vptest ymm4, [m256]", ymm("vptest"), 4],
        ["vbroadcastsd ymm5, [m64]", ymm("vbroadcastsd"), 5], ["vbroadcastf128 ymm6, [m128]", ymm("vbroadcastf128"), 6],
        ["vinsertf128 ymm7, ymm0, [m128], 1", ymm("vinsertf128"), 7, 0, 1], ["vextractf128 [m128], ymm1, 1", ymm("vextractf128"), 1, undefined, 1],
        // (AVX2: the count of a shift by xmm/m128; the elements of
        // broadcasts and extensions, VBROADCASTI128's m128)
        ["vpsrlw ymm1, ymm2, [m128]", ymm("vpsrlw", "binary"), 1, 2], ["vpslld ymm3, ymm4, [m128]", ymm("vpslld", "binary"), 3, 4],
        ["vpbroadcastb xmm1, [m8]", named("vpbroadcastb"), 1], ["vpbroadcastw ymm2, [m16]", ymm("vpbroadcastw"), 2],
        ["vpbroadcastq ymm3, [m64]", ymm("vpbroadcastq"), 3], ["vbroadcasti128 ymm4, [m128]", ymm("vbroadcasti128"), 4],
        ["vpmovsxbq ymm5, [m32]", ymm("vpmovsxbq"), 5], ["vpmovzxwq ymm6, [m64]", ymm("vpmovzxwq"), 6], ["vpmovzxbw ymm7, [m128]", ymm("vpmovzxbw"), 7],
    ])
    {
        const at = SPAN - memory_bytes(f), store = STORES.includes(f.kind);
        // (VLDMXCSR: a valid value)
        const source = Uint8Array.from(SOURCES.subarray(0, SPAN));
        if(f.kind === "ldmxcsr") source.set(u32(0x7F80), at);
        const c = { n: 0, at, source, code: vex({ map: f.map || 1, pp: f.pp, l: f.l ?? 0, vvvv: v ?? 0 }, f.op, d, undefined, ABSENT - SPAN + at, imm8),
            model: s => execute(f, s, { d, v, imm8, long: false }) };
        // (VCOMISS, VPTEST: the flags)
        if(f.operands === "comi" || f.kind === "ptest") Object.assign(c, { pre: FLAGS_BEFORE, post: store_flags(OUT + 4) });
        await check_cases(label + " at a page end", [{ ...c, [store ? "destination_at" : "source_at"]: ABSENT - SPAN }], { before: vm => pages(vm, ABSENT, false) });
    }
    // VMASKMOVPS/PD across into an absent page: the unselected lanes there
    // are not accessed (no fault), the selected ones before it are
    {
        // (the low quadword's lanes selected: those of VMASKMOVPS 0 and 1, VMASKMOVPD 0)
        const low_lanes = big(Uint8Array.from({ length: 16 }, (_, i) => i < 8 ? 0x80 : 0));
        // (AVX2: VPMASKMOVD and VPMASKMOVQ, VEX.W1, as VMASKMOVPS and VMASKMOVPD)
        for(const [op, w] of [[0x2C, 0], [0x2D, 0], [0x2E, 0], [0x2F, 0], [0x8C, 0], [0x8C, 1], [0x8E, 0], [0x8E, 1]])
        {
            const f = FORMS.find(f => f.map === 2 && f.op === op && f.w === w && !f.l);
            const store = f.kind === "maskstore";
            const c = { n: 0, at: SPAN - 8, registers: { 2: low_lanes }, code: vex({ map: 2, pp: 1, w, vvvv: 2 }, op, 1, undefined, ABSENT - 8),
                model: s => execute(f, s, { d: 1, v: 2, long: false }) };
            await check_cases(`${f.name} across into an absent page (the lanes there not selected)`, [{ ...c, [store ? "destination_at" : "source_at"]: ABSENT - SPAN }],
                { before: vm => pages(vm, ABSENT, false) });
        }
        // (VEX.256: the 32-byte operand's high half on the absent page; the
        // low half's lanes selected, the high half's not)
        const low_half = big(Uint8Array.from({ length: 16 }, (_, i) => i % 4 === 3 ? 0x80 : 0));
        for(const [op, w] of [[0x2C, 0], [0x2D, 0], [0x2E, 0], [0x2F, 0], [0x8C, 0], [0x8C, 1], [0x8E, 0], [0x8E, 1]])
        {
            const f = FORMS.find(f => f.map === 2 && f.op === op && f.w === w && f.l === 1);
            const store = f.kind === "maskstore";
            const c = { n: 0, at: SPAN - 16, registers: { 2: low_half }, uppers: { 2: 0n },
                code: vex({ map: 2, pp: 1, l: 1, w, vvvv: 2 }, op, 1, undefined, ABSENT - 16),
                model: s => execute(f, s, { d: 1, v: 2, long: false }) };
            await check_cases(`${f.name} ymm across into an absent page (the lanes there not selected)`,
                [{ ...c, [store ? "destination_at" : "source_at"]: ABSENT - SPAN }], { before: vm => pages(vm, ABSENT, false) });
        }
    }
    for(const vm of machines) pages(vm, ABSENT, true);
    // VMASKMOVPS/PD set the accessed (and, storing, the dirty) bit of the
    // pages their selected lanes are on; the SDM leaves those of pages with
    // only unselected lanes to the implementation: v86 does not set them
    {
        const low_lanes = big(Uint8Array.from({ length: 16 }, (_, i) => i < 8 ? 0x80 : 0));
        const pte = (vm, page) => word(vm, 0x13000 + (page >>> 12) * 4);
        for(const op of [0x2C, 0x2E])
        {
            const program = [...xrstor(area_in(0)), ...vex({ map: 2, pp: 1, vvvv: 2 }, op, 1, undefined, ABSENT - 8), ...xsave(area_out(0))];
            const results = await run_all(program, vm => {
                vm.write_memory(area(0, { 2: low_lanes }), area_in(0));
                pages(vm, ABSENT - 0x1000, true);
                pages(vm, ABSENT, true);
            }, machines, vm => [pte(vm, ABSENT - 0x1000) & 0x60, pte(vm, ABSENT) & 0x60]);
            for(const { label, data } of results)
            {
                assert.deepEqual(data, [op === 0x2E ? 0x60 : 0x20, 0], `vmaskmovps ${op === 0x2E ? "store" : "load"} (${label}): accessed/dirty bits of the selected lanes' page and the other`);
            }
            checks++;
        }
    }
    // A gather faulting on element k (#PF at the instruction, CR2 the
    // element's address): the elements before it done (loaded if selected,
    // their mask cleared), the rest's mask normalized (all ones or zero by
    // its sign) and the destination's kept, the mask beyond the elements
    // zero (the SDM's operation). The guest then maps the page and runs the
    // gather again, which completes the rest: the result of one uninterrupted
    // gather. (Element 0 not selected; scale 1, base EBX, which XSAVE's
    // address needs too.)
    {
        const PTE = 0x13000 + (ABSENT >>> 12) * 4;
        const pte = value => [0xC7, 0x05, ...u32(PTE), ...u32(value), 0x0F, 0x01, 0x3D, ...u32(ABSENT)];
        const [d, v, index] = [1, 2, 3];
        for(const f of FORMS.filter(f => f.kind === "gather"))
        {
            const count = (f.l ? 32 : 16) / Math.max(f.data, f.index), k = count > 2 ? 2 : 1, bits = BigInt(8 * f.data);
            let indices = 0n, selection = 0n;
            for(let j = 0; j < count; j++)
            {
                indices |= BigInt(j < k ? 8 * j : 64 + 8 * j) << BigInt(8 * f.index * j);
                if(j) selection |= 1n << bits * BigInt(j + 1) - 1n;
            }
            const source = Uint8Array.from(DESTINATIONS.subarray(0, 128));
            const c = { n: 0, at: 0, source, registers: { [index]: indices & mask(128), [v]: selection & mask(128) },
                uppers: { [index]: indices >> 128n, [v]: selection >> 128n } };
            const gather = [...vex({ map: 2, pp: 1, l: f.l ?? 0, w: f.w, vvvv: v }, f.op), d << 3 | 4, index << 3 | 3];
            const prefix = [...xrstor(area_in(0)), ...mov_r32(3, ABSENT - 64)];
            const program = [...prefix, ...gather, ...xsave(area_out(1)), ...pte(ABSENT | 3),
                ...mov_r32(3, ABSENT - 64), ...gather, ...xsave(area_out(0)), ...pte(0)];
            const results = await run_all(program, vm => {
                vm.write_memory(Uint8Array.from(u32(gather.length)), SKIP);
                vm.write_memory(area(0, c.registers, c.uppers), area_in(0));
                vm.write_memory(source, ABSENT - 64);
                pages(vm, ABSENT, false);
            }, machines, vm => ({ fault: [0, 4, 8, 12].map(o => word(vm, FAULT + o)), partial: bytes(vm, area_out(1), 832), done: bytes(vm, area_out(0), 832) }));
            // the expected states
            const whole = initial(0, c);
            execute(f, whole, { d, v, index, scale: 0, long: false });
            const partial = initial(0, c);
            const elements = (value, size) => Array.from({ length: 256 / size }, (_, j) => value >> BigInt(size * j) & mask(size));
            const dest = elements(partial.x[d] | partial.h[d] << 128n, Number(bits));
            const masks = elements(partial.x[v] | partial.h[v] << 128n, Number(bits)).map((x, j) =>
                j >= count ? 0n : x >> bits - 1n ? mask(Number(bits)) : 0n);
            for(let j = 0; j < k; j++)
            {
                if(masks[j]) dest[j] = big(source.subarray(8 * j, 8 * j + f.data));
                masks[j] = 0n;
            }
            const join_all = list => list.reduceRight((value, x) => value << bits | x, 0n);
            const [partial_dest, partial_mask] = [join_all(dest), join_all(masks)];
            const name = `${f.name}${f.l ? " ymm" : ""} faulting on element ${k}`;
            for(const { label, data } of results)
            {
                assert.deepEqual(data.fault.slice(0, 3), [14, CODE + PROLOGUE.length + prefix.length, ABSENT + 8 * k], `${name} (${label}): #PF, EIP, CR2`);
                for(const [r, value, what, area_bytes] of [[d, partial_dest, "destination", data.partial], [v, partial_mask, "mask", data.partial],
                    [d, whole.x[d] | whole.h[d] << 128n, "destination after the restart", data.done], [v, whole.x[v] | whole.h[v] << 128n, "mask after the restart", data.done]])
                {
                    assert.equal(hex(area_bytes.subarray(160 + 16 * r, 176 + 16 * r)), hex(le(value & mask(128))), `${name} (${label}): ${what}, bits 127:0`);
                    assert.equal(hex(area_bytes.subarray(576 + 16 * r, 592 + 16 * r)), hex(le(value >> 128n)), `${name} (${label}): ${what}, bits 255:128`);
                }
            }
            checks++;
        }
        for(const vm of machines) pages(vm, ABSENT, true);
    }
    // A gather's segment: an override's (FS, its base 0x10000) for every
    // element, at the base (EBX) plus the element's scaled index (within 120
    // bytes either side); every third element not selected. A third of the
    // forms, each width and size in turn
    {
        const FS_BASE = 0x10000, [d, v, index] = [4, 5, 6], source = Uint8Array.from(SOURCES.subarray(0, 256));
        const saved = machines.map(vm => ["segment_offsets", "segment_limits", "segment_is_null"].map(name => vm.v86.cpu[name][4]));
        const segment = (vm, values) => ["segment_offsets", "segment_limits", "segment_is_null"].forEach((name, i) => { vm.v86.cpu[name][4] = values[i]; });
        for(const [n, f] of FORMS.filter(f => f.kind === "gather").entries())
        {
            if(n % 3) continue;
            const scale = n & 3, count = (f.l ? 32 : 16) / Math.max(f.data, f.index);
            let indices = 0n, selection = 0n;
            for(let j = 0; j < 32 / f.index; j++)
            {
                const offset = (n * 37 + j * 53) % 241 - 120;
                indices |= BigInt.asUintN(8 * f.index, BigInt(Math.trunc(offset / 2 ** scale))) << BigInt(8 * f.index * j);
            }
            for(let j = 0; j < count; j++) if(j % 3 !== 1) selection |= 1n << BigInt(8 * f.data * (j + 1) - 1);
            const c = { n: 0, at: 128, source, registers: { [index]: indices & mask(128), [v]: selection & mask(128) },
                uppers: { [index]: indices >> 128n, [v]: selection >> 128n } };
            const gather = [0x64, ...vex({ map: 2, pp: 1, l: f.l ?? 0, w: f.w, vvvv: v }, f.op), d << 3 | 4, scale << 6 | index << 3 | 3];
            const program = [...xrstor(area_in(0)), ...mov_r32(3, SOURCE + 128 - FS_BASE), ...gather, ...xsave(area_out(0))];
            const results = await run_all(program, vm => {
                vm.write_memory(area(0, c.registers, c.uppers), area_in(0));
                vm.write_memory(source, SOURCE);
                segment(vm, [FS_BASE, -1, 0]);
            }, machines, vm => bytes(vm, area_out(0), 832));
            const s = initial(0, c);
            execute(f, s, { d, v, index, scale, long: false });
            const name = `${f.name}${f.l ? " ymm" : ""} with FS's base`;
            for(const { label, data } of results)
            {
                for(const r of [d, v])
                {
                    assert.equal(hex(data.subarray(160 + 16 * r, 176 + 16 * r)), hex(le(s.x[r])), `${name} (${label}): XMM${r}`);
                    assert.equal(hex(data.subarray(576 + 16 * r, 592 + 16 * r)), hex(le(s.h[r])), `${name} (${label}): YMM${r}'s upper half`);
                }
            }
            checks++;
        }
        machines.forEach((vm, i) => segment(vm, saved[i]));
    }
    console.log("PASS: legacy SSE keeps the upper halves, VEX zeroes them; CR0.EM and CR4.OSFXSR ignored; narrow operands and VMASKMOV's unselected lanes at a page end (no access, no accessed bit); gathers faulting on an element, then restarted; gathers with FS's base");

    // #UD without CR4.OSXSAVE or with XCR0 3 (before #NM), #NM with CR0.TS
    for(const [label, form] of [
        ["vmovaps xmm1, xmm2", vex({ pp: 0 }, 0x28, 1, 2)], ["vmovups xmm1, [mem]", vex({ pp: 0 }, 0x10, 1, undefined, SOURCE + 3)],
        ["vmovdqu [mem], xmm1", vex({ pp: 2 }, 0x7F, 1, undefined, DEST + 3)], ["vzeroupper", vex({}, 0x77)],
        ["vldmxcsr [mem]", vex({}, 0xAE, 2, undefined, SOURCE)], ["vmaskmovdqu", vex({ pp: 1 }, 0xF7, 1, 2)],
        ["vmovd ecx, xmm1", vex({ pp: 1 }, 0x7E, 1, 1)],
    ])
    {
        const memory = [DEST, DESTINATIONS.subarray(0, 32)];
        const before = vm => { vm.write_memory(DESTINATIONS.subarray(0, 32), DEST); vm.write_memory(Uint8Array.from(u32(0x1F80)), SOURCE); };
        await expect_fault(cr4(0, ~OSXSAVE), form, 6, { epilogue: cr4(OSXSAVE), before, memory, label: label + " without CR4.OSXSAVE" });
        await expect_fault(xsetbv(3), form, 6, { epilogue: xsetbv(7), before, memory, keep_upper: false, label: label + " with XCR0 3" });
        await expect_fault(SET_CR0(8), form, 7, { epilogue: CLTS, before, memory, label: label + " with CR0.TS" });
        await expect_fault([...SET_CR0(8), ...cr4(0, ~OSXSAVE)], form, 6, { epilogue: [...cr4(OSXSAVE), ...CLTS], before, memory, label: label + " with CR0.TS, without CR4.OSXSAVE" });
    }
    console.log("PASS: #UD without CR4.OSXSAVE or with XCR0 3, then #NM with CR0.TS");

    // #GP(0) for a misaligned operand of the aligned moves; #UD for VEX.L1 of
    // VLDMXCSR, VEX.vvvv other than 1111b without that operand; VLDMXCSR's reserved bits
    {
        const memory = [DEST, DESTINATIONS.subarray(0, 48)];
        const before = vm => vm.write_memory(DESTINATIONS.subarray(0, 48), DEST);
        for(const f of FORMS.filter(f => f.aligned))
        {
            const store = f.kind === "store";
            // (first an ordinary access to the same page: the page tier's template
            // finds it in the TLB, where its alignment check decides)
            const warm = store ? [0xA3, ...u32(DEST + 0x100)] : [0xA1, ...u32(SOURCE + 0x100)];
            // (VEX.256: aligned to 16 bytes, not to 32)
            const misaligned = f.l ? 16 : store ? 4 : 8;
            await expect_fault(warm, vex({ map: f.map || 1, pp: f.pp, l: f.l ?? 0 }, f.op, 1, undefined, (store ? DEST : SOURCE) + misaligned), 13,
                { error_code: 0, before, memory, label: `${f.name}${f.l ? " ymm" : ""} misaligned ${store ? "store" : "load"}` });
        }
        await expect_fault([], vex({ l: 1 }, 0xAE, 2, undefined, SOURCE), 6, { label: "vldmxcsr with VEX.L1" });
        await expect_fault([], vex({ pp: 0, vvvv: 3 }, 0x28, 1, 2), 6, { label: "vmovaps with VEX.vvvv 3" });
        await expect_fault([], vex({ three: true, vvvv: 1 }, 0x77), 6, { label: "vzeroupper with VEX.vvvv 1" });
        await expect_fault([], vex({ map: 3, pp: 1, w: 1, vvvv: 2 }, 0x4C, 1, 3, undefined, 0x40), 6, { label: "vpblendvb with VEX.W1" });
        await expect_fault([], vex({ pp: 1, vvvv: 2 }, 0x73, 3, undefined, SOURCE, 3), 6, { label: "vpsrldq with a memory operand" });
        await expect_fault([], vex({ pp: 1 }, 0xC5, 1, undefined, SOURCE, 1), 6, { label: "vpextrw (C5) with a memory operand" });
        await expect_fault([], vex({ pp: 1, vvvv: 3 }, 0x70, 1, 2, undefined, 0x1B), 6, { label: "vpshufd with VEX.vvvv 3" });
        // (gathers: the destination, mask and indices in three registers;
        // 32-bit addressing)
        for(const [label, prefix, vvvv, index] of [["the indices the destination", [], 2, 1], ["the mask the destination", [], 1, 3],
            ["the indices the mask", [], 2, 2], ["16-bit addressing", [0x67], 2, 3]])
        {
            await expect_fault(mov_r32(3, SOURCE), [...prefix, ...vex({ map: 2, pp: 1, vvvv }, 0x90), 1 << 3 | 4, 2 << 6 | index << 3 | 3], 6,
                { label: `vpgatherdd with ${label}` });
        }
        await expect_fault([], vex({}, 0xAE, 2, undefined, SOURCE + 4), 13, { error_code: 0, before: vm => vm.write_memory(Uint8Array.from(u32(0x10000)), SOURCE + 4), label: "vldmxcsr with a reserved bit" });
    }
    // #PF: a load from and a store to an absent page, nothing written; the
    // two VMASKMOVDQU writes: the whole range writable first, as MASKMOVDQU's
    {
        const memory = [ABSENT - 16, DESTINATIONS.subarray(0, 16)];
        const absent = vm => { vm.write_memory(DESTINATIONS.subarray(0, 16), ABSENT - 16); pages(vm, ABSENT, false); };
        await expect_fault([], vex({ pp: 0 }, 0x10, 1, undefined, ABSENT - 8), 14, { before: absent, cr2: ABSENT, error_code: 0, label: "vmovups across into an absent page" });
        await expect_fault([], vex({ pp: 3 }, 0x10, 1, undefined, ABSENT - 4), 14, { before: absent, cr2: ABSENT, error_code: 0, label: "vmovsd across into an absent page" });
        await expect_fault([], vex({ pp: 2 }, 0x7F, 1, undefined, ABSENT - 8), 14, { before: absent, cr2: ABSENT, error_code: 2, memory, label: "vmovdqu store across into an absent page" });
        await expect_fault([], vex({ pp: 1 }, 0xD6, 1, undefined, ABSENT - 4), 14, { before: absent, cr2: ABSENT, error_code: 2, memory, label: "vmovq store across into an absent page" });
        await expect_fault(mov_r32(7, ABSENT - 8), vex({ pp: 1 }, 0xF7, 1, 2), 14, { before: absent, cr2: ABSENT, error_code: 2, memory, label: "vmaskmovdqu across into an absent page" });
        // VMASKMOVPS/PD: a selected lane on the absent page faults, nothing
        // written (the lanes before it selected too: PS 0, 1 and 3, PD 0 and 1)
        const both = big(Uint8Array.from({ length: 16 }, (_, i) => i === 3 || i === 7 || i === 15 ? 0x80 : 0));
        await expect_fault([], vex({ map: 2, pp: 1, vvvv: 2 }, 0x2C, 1, undefined, ABSENT - 8), 14, { before: absent, cr2: ABSENT + 4, error_code: 0,
            registers: { 2: both }, label: "vmaskmovps load, lane 3 on an absent page" });
        await expect_fault([], vex({ map: 2, pp: 1, vvvv: 2 }, 0x2E, 1, undefined, ABSENT - 8), 14, { before: absent, cr2: ABSENT + 4, error_code: 2, memory,
            registers: { 2: both }, label: "vmaskmovps store, lane 3 on an absent page" });
        await expect_fault([], vex({ map: 2, pp: 1, vvvv: 2 }, 0x2F, 1, undefined, ABSENT - 8), 14, { before: absent, cr2: ABSENT, error_code: 2, memory,
            registers: { 2: both }, label: "vmaskmovpd store, lane 1 on an absent page" });
        // VEX.256: the 32 bytes' high half on the absent page; nothing written
        await expect_fault([], vex({ pp: 0, l: 1 }, 0x10, 1, undefined, ABSENT - 16), 14, { before: absent, cr2: ABSENT, error_code: 0, label: "vmovups ymm across into an absent page" });
        await expect_fault([], vex({ pp: 2, l: 1 }, 0x7F, 1, undefined, ABSENT - 16), 14, { before: absent, cr2: ABSENT, error_code: 2, memory, label: "vmovdqu ymm store across into an absent page" });
        await expect_fault([], vex({ map: 3, pp: 1, l: 1 }, 0x19, 1, undefined, ABSENT - 8, 1), 14, { before: absent, cr2: ABSENT, error_code: 2, memory, label: "vextractf128 store across into an absent page" });
        // (VMASKMOVPS: lanes 3 and 5 selected, the 32 bytes at ABSENT - 16: lane 5 on the absent page)
        const lanes_3_5 = [big(Uint8Array.from({ length: 16 }, (_, i) => i === 15 ? 0x80 : 0)), big(Uint8Array.from({ length: 16 }, (_, i) => i === 7 ? 0x80 : 0))];
        await expect_fault([], vex({ map: 2, pp: 1, l: 1, vvvv: 2 }, 0x2C, 1, undefined, ABSENT - 16), 14, { before: absent, cr2: ABSENT + 4, error_code: 0,
            registers: { 2: lanes_3_5[0] }, uppers: { 2: lanes_3_5[1] }, label: "vmaskmovps ymm load, lane 5 on an absent page" });
        await expect_fault([], vex({ map: 2, pp: 1, l: 1, vvvv: 2 }, 0x2E, 1, undefined, ABSENT - 16), 14, { before: absent, cr2: ABSENT + 4, error_code: 2, memory,
            registers: { 2: lanes_3_5[0] }, uppers: { 2: lanes_3_5[1] }, label: "vmaskmovps ymm store, lane 5 on an absent page" });
        for(const vm of machines) pages(vm, ABSENT, true);
    }
    // VEX.256 floating point: all lanes in one exception context (SDM Vol. 1,
    // 11.5.3). VADDPS ymm2, ymm1, ymm0 with only IE unmasked: the low half's
    // sums are inexact (PE, masked), the high half has an SNaN (IE): #XM
    // before any post-computation flag, MXCSR gets IE alone, YMM2 unchanged
    {
        const join32 = l => l.reduceRight((v, x) => v << 32n | x, 0n);
        const one = 0x3F800000n, tiny = 0x30800000n, snan = 0x7F800001n;
        const registers = { 1: join32([one, one, one, one]), 0: join32([tiny, tiny, tiny, tiny]) };
        const uppers = { 1: join32([one, one, one, one]), 0: join32([snan, one, one, one]) };
        const mxcsr = 0x1F80 & ~0x80;
        const initial = area(0, registers, uppers);
        initial.set(u32(mxcsr), 24);
        const at = CODE + PROLOGUE.length + xrstor(0).length;
        const faulting = vex({ pp: 0, l: 1, vvvv: 1 }, 0x58, 2, 0);
        const results = await run_all([...xrstor(area_in(0)), ...faulting, ...xsave(area_out(0))], vm => {
            vm.write_memory(Uint8Array.from(u32(faulting.length)), SKIP);
            vm.write_memory(initial, area_in(0));
        }, machines, vm => ({ fault: [0, 4].map(o => word(vm, FAULT + o)), area: bytes(vm, area_out(0), 832) }),
        vm => vm !== machines[1] || page_rounds() >= 300);
        for(const { label, data } of results)
        {
            assert.deepEqual(data.fault, [19, at], `vaddps ymm, an SNaN in the high half (${label}): #XM`);
            assert.equal(word_of(data.area, 24), mxcsr | 1, `vaddps ymm, an SNaN in the high half (${label}): MXCSR gets IE alone`);
            assert.equal(hex(data.area.subarray(160, 288)), hex(initial.subarray(160, 288)), `vaddps ymm (${label}): XMM registers kept`);
            assert.equal(hex(data.area.subarray(576, 704)), hex(initial.subarray(576, 704)), `vaddps ymm (${label}): YMM_Hi128 kept`);
        }
        checks++;
    }
    console.log("PASS: #GP(0) for misaligned aligned moves and VLDMXCSR's reserved bits, #UD for VEX.L1, VEX.W1, VEX.vvvv, memory operands where invalid and gathers' register overlaps and 16-bit addressing, #PF without effect; one exception context for a VEX.256 floating-point form's lanes");
    console.log(`PASS: ${checks} AVX checks on 3 arms`);
}
finally
{
    for(const vm of machines) await vm.destroy();
}
