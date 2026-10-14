import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";

// Compiled code against independent oracles, once per IR arm (the page tier and regions).
const wasm = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
let vm;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const word = address => new DataView(Uint8Array.from(vm.read_memory(address, 4)).buffer).getUint32(0, true);
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const DATA = 0x200000, RESULT = 0x210000;
let cpu, e;
async function run(address) {
    vm.write_memory(new Uint8Array(4), 0x600);
    cpu.instruction_pointer[0] = address;
    cpu.in_hlt[0] = 0;
    vm.run();
    const end = performance.now() + 10000;
    while(word(0x600) !== 0xCAFE) { assert(performance.now() < end, "guest timeout"); await sleep(1); }
    await vm.stop();
}
async function compile(address) {
    cpu.instruction_pointer[0] = address;
    cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const deadline = performance.now() + 10000;
    while(compiled_activations(e) === start) {
        assert(performance.now() < deadline, "natural JIT warmup timeout");
        await sleep(1);
    }
    await vm.stop();
}
const done = [0xC7, 0x05, ...u32(0x600), ...u32(0xCAFE)];
for(const { label, options } of COMPILED_ARMS) {
vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: wasm, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20, ...options,
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: { type: "none" }, autostart: false });
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    vm.run();
    const deadline = performance.now() + 10000;
    while(word(0x500) !== 0xCAFE) { assert(performance.now() < deadline); await sleep(1); }
    await vm.stop();
    cpu = vm.v86.cpu; e = cpu.wm.exports;
    // SSE enabled (CR4.OSFXSR, OSXMMEXCPT: the BIOS leaves them clear)
    cpu.cr[4] |= 0x600;
    const patterns = new Uint8Array(512);
    let seed = 0x9132913;
    for(let i = 0; i < patterns.length; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        patterns[i] = seed;
    }
    const pattern_view = new DataView(patterns.buffer);
    for(const [i, bits] of [0, 0x80000000, 0x7F800000, 0xFF800000,
        0x7FC12345, 0x7F812345, 1, 0xFFFFFFFF].entries()) {
        pattern_view.setUint32(i * 4, bits, true);
        pattern_view.setUint32(256 + i * 4, ~bits, true);
    }
    vm.write_memory(patterns, DATA);
    const operations = [
        [[], 0x54, "and"], [[0x66], 0x54, "and"], [[0x66], 0xDB, "and"],
        [[], 0x55, "andnot"], [[0x66], 0x55, "andnot"], [[0x66], 0xDF, "andnot"],
        [[], 0x56, "or"], [[0x66], 0x56, "or"], [[0x66], 0xEB, "or"],
        [[], 0x57, "xor"], [[0x66], 0x57, "xor"], [[0x66], 0xEF, "xor"],
    ];
    let cases = 0;
    for(const [index, [prefix, opcode, op]] of operations.entries()) {
        const address = 0x100000 + index * 4096;
        const program = [], expected = new Uint8Array(64 * 20);
        for(let src = 0; src < 8; src++) for(let dst = 0; dst < 8; dst++) {
            const n = src * 8 + dst;
            program.push(0xF3, 0x0F, 0x6F, 0x05 | src << 3, ...u32(DATA + src * 16));
            program.push(0xF3, 0x0F, 0x6F, 0x05 | dst << 3, ...u32(DATA + 256 + dst * 16));
            program.push(0xF9, ...prefix, 0x0F, opcode, 0xC0 | dst << 3 | src);
            program.push(0xF3, 0x0F, 0x7F, 0x05 | dst << 3, ...u32(RESULT + n * 20));
            program.push(0x9C, 0x58, 0xA3, ...u32(RESULT + n * 20 + 16));
            for(let k = 0; k < 16; k++) {
                const b = patterns[256 + dst * 16 + k];
                const a = src === dst ? b : patterns[src * 16 + k];
                expected[n * 20 + k] = op === "and" ? a & b : op === "andnot" ? a & ~b : op === "or" ? a | b : a ^ b;
            }
        }
        program.push(...done);
        program.push(0xE9, ...u32(-program.length - 5));
        assert(program.length < 4096);
        vm.write_memory(Uint8Array.from(program), address);
        await compile(address);
        const before = compiled_activations(e);
        await run(address);
        assert(compiled_activations(e) !== before, "execute compiled IR");
        const result = Uint8Array.from(vm.read_memory(RESULT, expected.length));
        for(let n = 0; n < 64; n++) {
            assert.deepEqual(result.slice(n * 20, n * 20 + 16), expected.slice(n * 20, n * 20 + 16), `${op} ${index} register pair ${n}`);
            assert.equal(result[n * 20 + 16] & 1, 1, "SSE logic preserves carry");
        }
        cases += 64;
    }
    // Same-module and cross-module indirect CALL/RET, followed by live code
    // invalidation. Results must change after replacing the callee.
    for(const target of [0x180100, 0x190100]) {
        const address = 0x180000;
        const program = [0x31, 0xC0, 0xBB, ...u32(target), 0xB9, ...u32(100),
            0xFF, 0xD3, 0x49, 0x75, 0xFB, 0xA3, ...u32(RESULT), ...done];
        program.push(0xE9, ...u32(-program.length - 5));
        vm.write_memory(Uint8Array.from(program), address);
        vm.write_memory(Uint8Array.from([0x83, 0xC0, 7, 0xC3]), target);
        await compile(address);
        await run(address);
        assert.equal(word(RESULT), 700, "indirect call/ret result");
        vm.write_memory(Uint8Array.from([0x83, 0xC0, 11, 0xC3]), target);
        await compile(address);
        await run(address);
        assert.equal(word(RESULT), 1100, "invalidated callee is never reused");
        const state = await vm.save_state();
        await vm.restore_state(state);
        await compile(address);
        await run(address);
        assert.equal(word(RESULT), 1100, "indirect targets after save/restore");
    }
    console.log("PASS: same/cross-module indirect CALL/RET, SMC and save/restore");
    const arith = [[0x01, 0xD8, false, true], [0x03, 0xC3, false, true],
        [0x29, 0xD8, true, true], [0x2B, 0xC3, true, true],
        [0x39, 0xD8, true, false], [0x3B, 0xC3, true, false]];
    const arithmetic = (a, b, sub) => {
        const value = (sub ? a - b : a + b) >>> 0;
        let parity = value & 255;
        parity ^= parity >>> 4; parity ^= parity >>> 2; parity ^= parity >>> 1;
        const carry = sub ? a < b : a + b > 0xFFFFFFFF;
        const overflow = sub ? ((a ^ b) & (a ^ value)) >>> 31 : (~(a ^ b) & (a ^ value)) >>> 31;
        const flags = Number(carry) | ((~parity & 1) << 2) | ((a ^ b ^ value) & 16) |
            (value === 0 ? 64 : 0) | (value >>> 24 & 128) | (overflow << 11);
        return { value, flags };
    };
    let flag_cases = 0;
    for(let first = 0; first < 6; first++) for(let second = 0; second < 6; second++) {
        const program = [], expected = [];
        for(let i = 0; i < 64; i++) {
            const edge = [0, 1, 0xFFFFFFFF, 0x7FFFFFFF, 0x80000000, 0x80000001, 0xFFFF, 0x10000];
            const a = edge[i & 7], b = edge[i >>> 3];
            const f = arith[first], g = arith[second];
            const intermediate = arithmetic(a, b, f[2]);
            const result = arithmetic(f[3] ? intermediate.value : a, b, g[2]);
            expected.push([g[3] ? result.value : f[3] ? intermediate.value : a, result.flags]);
            program.push(0xB8, ...u32(a), 0xBB, ...u32(b), f[0], f[1], 0xB9, ...u32(0x12345678), 0x89, 0xDA, 0x90, g[0], g[1],
                0xA3, ...u32(RESULT + i * 8), 0x9C, 0x58, 0xA3, ...u32(RESULT + i * 8 + 4));
        }
        program.push(...done);
        program.push(0xE9, ...u32(-program.length - 5));
        assert(program.length < 4096);
        const address = 0x300000 + (first * 6 + second) * 4096;
        vm.write_memory(Uint8Array.from(program), address);
        await compile(address); await run(address);
        for(let i = 0; i < expected.length; i++) {
            assert.equal(word(RESULT + i * 8), expected[i][0], "arithmetic result");
            assert.equal(word(RESULT + i * 8 + 4) & 0x8D5, expected[i][1], `flags ${first}/${second}/${i}`);
        }
        flag_cases += expected.length;
    }
    // A flags observer/consumer between arithmetic operations must keep the
    // first operation's carry/overflow, rather than exposing stale metadata.
    for(const [index, barrier] of [[0, [0x9C, 0x5A]], [1, [0x83, 0xD0, 0]],
        [2, [0x40]], [3, [0xD3, 0xE0]]]) {
        const address = 0x340000 + index * 4096;
        const program = [0xB8, ...u32(0xFFFFFFFF), 0xBB, ...u32(1), 0xB9, ...u32(0),
            0x01, 0xD8, ...barrier, 0x89, 0x15, ...u32(RESULT + 8),
            0x9C, 0x5A, 0x89, 0x15, ...u32(RESULT + 4), 0x03, 0xC3, 0xA3, ...u32(RESULT), ...done];
        program.push(0xE9, ...u32(-program.length - 5));
        vm.write_memory(Uint8Array.from(program), address);
        await compile(address); await run(address);
        assert.equal(word(RESULT), index === 1 || index === 2 ? 2 : 1, "flags consumer result");
        if(index !== 1) assert.equal(word(RESULT + 4) & 1, 1, "preserved carry at observer");
        if(index === 0) assert.equal(word(RESULT + 8) & 0x8D5, arithmetic(0xFFFFFFFF, 1, false).flags);
    }
    console.log(`PASS: ${flag_cases} arithmetic flag cases across MOV/NOP and PUSHFD/ADC/INC/zero-shift barriers`);
    // A real #NM must still be raised by the optimized register instruction.
    // Install a guest handler that skips the faulting instruction and clears TS.
    const handler = 0x381000, idt = 0x250000, descriptor = 0x251000;
    const gate = [handler & 255, handler >>> 8 & 255, 8, 0, 0, 0x8E, handler >>> 16 & 255, handler >>> 24];
    vm.write_memory(Uint8Array.from(gate), idt + 7 * 8);
    vm.write_memory(Uint8Array.from([255, 7, ...u32(idt)]), descriptor);
    vm.write_memory(Uint8Array.from([
        0x8B, 0x04, 0x24, 0xA3, ...u32(RESULT),
        0xFF, 0x05, ...u32(RESULT + 4),
        0x83, 0x04, 0x24, 3,
        0x0F, 0x20, 0xC0, 0x83, 0xE0, 0xF7, 0x0F, 0x22, 0xC0, 0xCF,
    ]), handler);
    const fault_program = [0x0F, 0x01, 0x1D, ...u32(descriptor),
        0xF3, 0x0F, 0x6F, 0x05, ...u32(DATA),
        0xF3, 0x0F, 0x6F, 0x0D, ...u32(DATA + 16),
        0x0F, 0x20, 0xC0, 0x83, 0xC8, 8, 0x0F, 0x22, 0xC0];
    const fault_eip = 0x380000 + fault_program.length;
    fault_program.push(0x0F, 0x57, 0xC1, 0xF3, 0x0F, 0x7F, 0x05, ...u32(RESULT + 16), ...done);
    fault_program.push(0xE9, ...u32(-fault_program.length - 5));
    vm.write_memory(Uint8Array.from(fault_program), 0x380000);
    vm.write_memory(new Uint8Array(8), RESULT);
    await compile(0x380000); await run(0x380000);
    assert.equal(word(RESULT), fault_eip, "#NM points to the SSE instruction");
    assert(word(RESULT + 4) > 0, "SSE still raises #NM with TS set");
    assert.deepEqual(Uint8Array.from(vm.read_memory(RESULT + 16, 16)), patterns.slice(0, 16), "faulting XORPS did not change XMM");
    console.log("PASS: optimized SSE retains guest #NM and precise fault EIP");
    // Selectively synchronized division helpers must leave every register
    // intact on #DE; the exception is delivered after locals are materialized.
    const de_handler=0x38C000,de_code=0x38D000;
    vm.write_memory(Uint8Array.from([de_handler&255,de_handler>>>8&255,8,0,0,0x8E,de_handler>>>16&255,de_handler>>>24]),idt);
    for(const instruction of [[0x66,0xF7,0xF3],[0x66,0xF7,0xFB],[0xF7,0xFB]]) {
        const regs=[[0,0x11223344],[1,0xABCDEF01],[2,0x77880000],[3,0],[5,0x10101010],[6,0x12345678],[7,0x99887766]];
        const handler=[];
        for(const [r] of regs) handler.push(0x89,5|r<<3,...u32(RESULT+r*4));
        handler.push(0x8B,0x04,0x24,0xA3,...u32(RESULT+32),0x83,0x04,0x24,instruction.length,0xCF);
        vm.write_memory(Uint8Array.from(handler),de_handler);
        const p=[];
        for(const [r,v] of regs) p.push(0xB8+r,...u32(v));
        const fault=de_code+p.length;
        p.push(...instruction,...done,0xE9,...u32(-p.length-instruction.length-done.length-5));
        vm.write_memory(Uint8Array.from(p),de_code);
        await compile(de_code);await run(de_code);
        for(const [r,v] of regs) assert.equal(word(RESULT+r*4),v,"#DE preserves register "+r);
        assert.equal(word(RESULT+32),fault,"#DE preserves fault EIP");
    }
    console.log("PASS: helper register contracts retain precise division faults");
    // Flags before a faulting memory access must remain observable in the
    // hardware exception frame, even when later arithmetic overwrites them.
    const pf_handler = 0x383000, pf_address = 0x382000;
    vm.write_memory(Uint8Array.from([pf_handler & 255, pf_handler >>> 8 & 255,
        8, 0, 0, 0x8E, pf_handler >>> 16 & 255, pf_handler >>> 24]), idt + 14 * 8);
    vm.write_memory(Uint8Array.from([
        0x8B, 0x44, 0x24, 12, 0xA3, ...u32(RESULT),
        0x8B, 0x44, 0x24, 4, 0xA3, ...u32(RESULT + 4),
        0x83, 0x44, 0x24, 4, 6, 0x83, 0xC4, 4, 0xCF,
    ]), pf_handler);
    const pf_program = [0xB8, ...u32(0xFFFFFFFF), 0xBB, ...u32(1), 0x01, 0xD8,
        // Carry flag provenance through MOV/LEA, overwriting both aliases,
        // before the fault observes the original ADD's architectural flags.
        0xB8, ...u32(7), 0x8D, 0x58, 4,
        0xBE, ...u32(0x801FFC), 0x8B, 0x0E]; // seed a valid relative-read cache
    const pf_eip = pf_address + pf_program.length;
    pf_program.push(0x8B, 0x96, ...u32(4), 0x9C, 0x59, 0x89, 0x0D, ...u32(RESULT + 8),
        0x03, 0xC3, ...done);
    pf_program.push(0xE9, ...u32(-pf_program.length - 5));
    vm.write_memory(Uint8Array.from(pf_program), pf_address);
    await compile(pf_address); await run(pf_address);
    const pf_flags = arithmetic(0xFFFFFFFF, 1, false).flags;
    assert.equal(word(RESULT) & 0x8D5, pf_flags, "flags in page fault frame");
    assert.equal(word(RESULT + 4), pf_eip, "precise memory fault EIP");
    assert.equal(word(RESULT + 8) & 0x8D5, pf_flags, "flags survive fault/IRET");
    console.log("PASS: flags remain precise across guest page fault and IRET");
    // A mapped device read must occur for each access, never reuse paging scratch.
    const old_mmio = cpu.memory_map_read32[0xA0000 >>> 17];
    let device_reads = 0;
    cpu.memory_map_read32[0xA0000 >>> 17] = () => ++device_reads;
    try {
        for(const loads of [
            [0xA1,...u32(0xA0000),0x8B,0x1D,...u32(0xA0004)],
            [0xBE,...u32(0xA0000),0x8B,0x06,0x8B,0x5E,4],
            [0xBE,...u32(0xA0000),0x8B,0x06,0x31,0xC9,0x41,0x8B,0x5E,4],
        ]) {
            const p = [...loads,0x29,0xC3,
                0x89,0x1D,...u32(RESULT),...done];
            p.push(0xE9,...u32(-p.length-5));
            vm.write_memory(Uint8Array.from(p),0x384000);
            await compile(0x384000); await run(0x384000);
            assert(device_reads > 2);
            assert.equal(word(RESULT),1,"each MMIO read observes a fresh device value");
        }
    } finally { cpu.memory_map_read32[0xA0000 >>> 17] = old_mmio; }
    // Every mapped store must reach the device even after a nearby store.
    const write_index = 0xA0000 >>> 17, old_write = cpu.memory_map_write32[write_index];
    const device_writes = [];
    cpu.memory_map_write32[write_index] = (address,value) => device_writes.push([address,value >>> 0]);
    try {
        const p=[0xBE,...u32(0xA0000),0xB8,...u32(0x12345678),
            0x89,0x06,0x89,0x46,4,...done];
        p.push(0xE9,...u32(-p.length-5));
        vm.write_memory(Uint8Array.from(p),0x386000);
        await compile(0x386000); device_writes.length=0; await run(0x386000);
        // The VM may stop between the two stores (regions exit after every
        // MMIO store), so the last pair can be incomplete; the order cannot.
        assert(device_writes.length >= 2);
        for(let i=0;i<device_writes.length;i++) assert.deepEqual(device_writes[i],
            [0xA0000+(i%2)*4,0x12345678]);
    } finally { cpu.memory_map_write32[write_index]=old_write; }
    // RMW cache misses must retain both device reads and writes.
    let rmw_reads=0;
    cpu.memory_map_read32[write_index]=()=>++rmw_reads;
    cpu.memory_map_write32[write_index]=(address,value)=>device_writes.push([address,value>>>0]);
    try {
        const p=[0xBE,...u32(0xA0000),0xB8,...u32(17),0x01,0x06,0x01,0x46,4,...done];
        p.push(0xE9,...u32(-p.length-5));
        vm.write_memory(Uint8Array.from(p),0x386000);
        await compile(0x386000); rmw_reads=0; device_writes.length=0; await run(0x386000);
        assert(rmw_reads>=2 && device_writes.length===rmw_reads);
        for(let i=0;i<rmw_reads;i++) assert.deepEqual(device_writes[i],[0xA0000+(i%2)*4,i+18]);
    } finally { cpu.memory_map_read32[write_index]=old_mmio; cpu.memory_map_write32[write_index]=old_write; }
    // Cached POP crosses upward into a missing page; the exception frame can
    // still use the mapped stack below it. Resume restores the original ESP.
    {
        const base=0x38B000;
        const original_stack=cpu.reg32[4] >>> 0;
        // compile()/run() may stop in a later iteration while ESP still points
        // into the fault-test page. Do not capture that borrowed ESP as the
        // original stack on replay, or later fault frames corrupt copy output.
        const p=[0xBD,...u32(original_stack),0xBC,...u32(0x801FFC),0x58];
        const fault_eip_local=base+p.length; p.push(0x5A);
        const resume=base+p.length; p.push(0x89,0xEC,...done);
        p.push(0xE9,...u32(-p.length-5));
        vm.write_memory(Uint8Array.from([
            0xA3,...u32(RESULT),0x8B,0x44,0x24,4,0xA3,...u32(RESULT+4),
            0xC7,0x44,0x24,4,...u32(resume),0x83,0xC4,4,0xCF,
        ]),pf_handler);
        vm.write_memory(Uint8Array.from(p),base);
        await compile(base);
        vm.write_memory(Uint8Array.from(u32(0x76543210)),0x101FFC);
        // Subsequent fault frames overwrite the popped stack slot, so the
        // precise fault address is the invariant across repeated execution.
        await run(base);
        assert.equal(word(RESULT+4),fault_eip_local,"cached POP retains precise page fault EIP");
        cpu.reg32[4]=original_stack;
    }
    // Warm writers against RAM, then redirect the same compiled code to a
    // previously compiled target. Cached stores/copies must invalidate it.
    const smc_target=0x388000, writer=0x389000, pointer=DATA+768;
    const target_bytes=value => {
        const p=[0xB8,...u32(value),0xA3,...u32(RESULT+32),...done];
        p.push(0xE9,...u32(-p.length-5));
        while(p.length<64) p.push(0x90);
        return p;
    };
    for(const copy of [false,true]) {
        vm.write_memory(Uint8Array.from(target_bytes(1)),smc_target);
        await compile(smc_target); await run(smc_target);
        assert.equal(word(RESULT+32),1);
        vm.write_memory(Uint8Array.from(target_bytes(777)),DATA+1024);
        vm.write_memory(Uint8Array.from(u32(DATA+4096)),pointer);
        const p=[0x8B,0x3D,...u32(pointer)];
        if(copy) p.push(0xBE,...u32(DATA+1024),0xB9,...u32(64),
            0x8A,0x06,0x88,0x07,0x46,0x47,0x49,0x75,0xF7);
        else p.push(0xB8,...u32(777),0x89,0x07,0x89,0x47,64);
        p.push(...done,0xE9,...u32(-p.length-done.length-5));
        vm.write_memory(Uint8Array.from(p),writer);
        await compile(writer);
        vm.write_memory(Uint8Array.from(u32(smc_target+(copy ? 0 : 1))),pointer);
        await run(writer); await run(smc_target);
        assert.equal(word(RESULT+32),777,copy ? "copy into compiled code invalidates JIT" : "cached stores invalidate JIT");
    }
    console.log("PASS: cached stores and ordinary copies preserve code-page invalidation");
    // Capture architectural state at a write fault and leave the failing
    // loop. Tests include a cached store, both batched loops and REP fills.
    for(const kind of ["stores","rmw-stores","byte-loop","dword-loop","stosw","stosd","rmw-add","rmw-xor"]) {
        const base=0x387000;
        const p=[...(kind.startsWith("rmw") ? [0xFC,0xBF,...u32(0x801FD0),0xB9,...u32(12),0x31,0xC0,0xF3,0xAB] : []),
            0xFC,0xBE,...u32(DATA),0xBF,...u32(0x801FD0),
            0xB9,...u32(64),0xB8,...u32(0x12345678),0xF9];
        let fault_eip_local_local, copied, size;
        if(kind === "stores" || kind === "rmw-stores") {
            p.push(0xBF,...u32(0x801FFC));
            if(kind === "rmw-stores") p.push(0xC7,0x07,...u32(0));
            const op=kind === "stores" ? 0x89 : 0x01;
            p.push(op,0x07);
            fault_eip_local_local=base+p.length; p.push(op,0x87,...u32(4)); size=4; copied=1;
        } else if(kind.startsWith("rmw")) {
            size=4;copied=12;fault_eip_local_local=base+p.length;
            p.push(kind === "rmw-add" ? 0x01 : 0x31,0x07,0x83,0xC7,4,0x49,0x75,0xF8);
        } else if(kind.endsWith("loop")) {
            size=kind === "byte-loop" ? 1 : 4; copied=48/size;
            fault_eip_local_local=base+p.length+2;
            p.push(...(size === 1 ? [0x8A,0x06,0x88,0x07,0x46,0x47,0x49,0x75,0xF7] :
                [0x8B,0x06,0x89,0x07,0x83,0xC6,4,0x83,0xC7,4,0x49,0x75,0xF3]));
        } else {
            size=kind === "stosw" ? 2 : 4; copied=48/size;
            fault_eip_local_local=base+p.length; p.push(0xF3,...(size === 2 ? [0x66] : []),0xAB);
        }
        const resume=base+p.length;
        p.push(...done,0xE9,...u32(-p.length-done.length-5));
        // The handler also copies the 48 target bytes (REP MOVSD into
        // RESULT+64): the state at the fault, not wherever the VM stops later
        // (the rmw kinds zero the bytes again at the start of each iteration).
        vm.write_memory(Uint8Array.from([
            0x89,0x0D,...u32(RESULT),0x89,0x35,...u32(RESULT+4),0x89,0x3D,...u32(RESULT+8),
            0xA3,...u32(RESULT+16),0x8B,0x44,0x24,4,0xA3,...u32(RESULT+12),
            0xBE,...u32(0x801FD0),0xBF,...u32(RESULT+64),0xB9,...u32(12),0xF3,0xA5,
            0xC7,0x44,0x24,4,...u32(resume),0x83,0xC4,4,0xCF,
        ]),pf_handler);
        vm.write_memory(Uint8Array.from(p),base);
        await compile(base); await run(base);
        assert.equal(word(RESULT+12),fault_eip_local_local,kind+" precise fault EIP");
        if(kind === "stores" || kind === "rmw-stores") {
            assert.equal(word(RESULT+64+0x2C),0x12345678,"first cached store committed");
        } else {
            assert.equal(word(RESULT),64-copied,kind+" remaining count");
            assert.equal(word(RESULT+8),0x802000,kind+" destination progress");
            assert.equal(word(RESULT+4),DATA+(kind.endsWith("loop") ? 48 : 0),kind+" source progress");
            const expected = kind.endsWith("loop") ? Uint8Array.from(vm.read_memory(DATA,48)) :
                Uint8Array.from({length:48},(_,i)=>(0x12345678 >>> (i%size*8))&255);
            assert.deepEqual(Uint8Array.from(vm.read_memory(RESULT+64,48)),expected,kind+" partial writes");
        }
    }
    console.log("PASS: cached MMIO stores and batched copies/fills retain precise partial write faults");
    // Overlap ends at an unmapped virtual page. The first 47 byte stores must
    // complete, and the fault frame/registers must describe the remaining 17.
    vm.write_memory(Uint8Array.from([
        0x89,0x0D,...u32(RESULT),0x89,0x35,...u32(RESULT+4),0x89,0x3D,...u32(RESULT+8),
        0x8B,0x44,0x24,4,0xA3,...u32(RESULT+12),
        0x83,0x44,0x24,4,2,0x83,0xC4,4,0xCF,
    ]),pf_handler);
    const overlap = [0xFC,0xBE,...u32(0x801FD0),0xBF,...u32(0x801FD1),0xB9,...u32(64)];
    const overlap_eip = 0x385000 + overlap.length;
    overlap.push(0xF3,0xA4,...done);
    overlap.push(0xE9,...u32(-overlap.length-5));
    vm.write_memory(Uint8Array.from({length:48},(_,i)=>i+17),0x101FD0);
    vm.write_memory(Uint8Array.from(overlap),0x385000);
    await compile(0x385000); await run(0x385000);
    assert.equal(word(RESULT),17,"REP remaining ECX after partial page fault");
    assert.equal(word(RESULT+4),0x801FFF,"REP partial ESI");
    assert.equal(word(RESULT+8),0x802000,"REP partial EDI");
    assert.equal(word(RESULT+12),overlap_eip,"fault restarts the REP instruction");
    assert.deepEqual(Uint8Array.from(vm.read_memory(0x101FD0,48)),new Uint8Array(48).fill(17));
    console.log("PASS: MMIO reads are not cached; overlapping REP preserves partial progress at #PF");
    console.log(`PASS: ${cases} real-JIT SSE logical register cases, aliases and carry; ${wasm} ${label}`);
} finally { await vm.destroy(); }
}
