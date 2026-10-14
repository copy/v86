import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";

const candidate = process.argv[2] || "build/v86.wasm";
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const CODE = 0x100000, DATA = 0x200000, OUT = 0x210000;
const machines = [];
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const data = new Uint8Array(8192), dv = new DataView(data.buffer);
const load = (r, a) => [0xF3,0x0F,0x6F,5 | r << 3,...u32(a)];
const store = (r, a) => [0xF3,0x0F,0x7F,5 | r << 3,...u32(a)];
const ops = [["addsubps",0xF2,0xD0,4], ["addsubpd",0x66,0xD0,8],
    ["haddps",0xF2,0x7C,4], ["haddpd",0x66,0x7C,8],
    ["hsubps",0xF2,0x7D,4], ["hsubpd",0x66,0x7D,8],
    ["movddup",0xF2,0x12,8], ["movsldup",0xF3,0x12,4], ["movshdup",0xF3,0x16,4],
    ["lddqu",0xF2,0xF0,1]];
async function run(vm, program, warm = true) {
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    // Programs reuse CODE: start each warm run from an empty compiler state
    // (compiled code needs more heat to recompile a page after each rewrite).
    if(warm) cpu.jit_clear_cache();
    vm.write_memory(Uint8Array.from(program), CODE);
    vm.write_memory(new Uint8Array(4), 0x600);
    cpu.reg32[4] = 0x8000;
    // Defined EFLAGS: programs record them, and a previous program's flags
    // depend on where its VM stopped (a region boundary or the loop head).
    cpu.flags[0] = 2; cpu.flags_changed[0] = 0;
    cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const deadline = performance.now() + 10000;
    while(word(vm, 0x600) !== 0xCAFE || warm && vm !== machines[0] && compiled_activations(e) === start) {
        assert(performance.now() < deadline, "SSE3 program/JIT timeout"); await sleep(1);
    }
    if(warm) await sleep(20);
    await vm.stop();
}
// SSE enabled (CR4.OSFXSR, OSXMMEXCPT: the BIOS leaves them clear)
const ENABLE_SSE = [0x0F,0x20,0xE0,0x0D,...u32(0x600),0x0F,0x22,0xE0];
function loop(body) {
    const p = [...ENABLE_SSE,...body,0xC7,0x05,...u32(0x600),...u32(0xCAFE)];
    p.push(0xE9,...u32(-p.length-5)); return p;
}
function calculate(name, width, source, target) {
    if(name === "lddqu") return source.slice();
    const output = new Uint8Array(16), out = new DataView(output.buffer);
    const a = new DataView(source.buffer, source.byteOffset, 16), b = new DataView(target.buffer, target.byteOffset, 16);
    for(let i = 0; i < 16 / width; i++) {
        if(name.startsWith("mov")) {
            const lane = name === "movddup" ? 0 : (i & ~1) + Number(name === "movshdup");
            output.set(source.slice(lane*width,(lane+1)*width),i*width); continue;
        }
        const get = (v, lane) => width === 8 ? v.getFloat64(lane*8,true) : v.getFloat32(lane*4,true);
        let x, y;
        if(name.startsWith("addsub")) { x = get(b,i); y = get(a,i); }
        else {
            const input = i < 8 / width ? b : a, lane = (i % (8/width))*2;
            x = get(input,lane); y = get(input,lane+1);
        }
        const value = name.startsWith("hsub") || name.startsWith("addsub") && i % 2 === 0 ? x-y : x+y;
        if(width === 8) out.setFloat64(i*8,value,true); else out.setFloat32(i*4,value,true);
    }
    return output;
}
try {
    // Compare the interpreter with both IR code generators within one build.
    for(const options of [{ disable_jit: true }, ...COMPILED_ARMS.map(arm => arm.options)]) {
        const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: candidate, bios: { buffer: bios.slice(0) }, memory_size: 32 << 20,
            ...options, disable_keyboard: true, disable_mouse: true, disable_speaker: true,
            net_device: { type: "none" }, autostart: false });
        machines.push(vm);
        await new Promise(resolve => vm.add_listener("emulator-loaded",resolve));
        vm.run();
        const deadline = performance.now()+10000;
        while(word(vm,0x500) !== 0xCAFE) { assert(performance.now()<deadline); await sleep(1); }
        await vm.stop();
    }
    // CPUID feature bits and legacy SAHF/LAHF are separate capabilities.
    const flags_program = [0xB8,...u32(1),0x0F,0xA2,0x89,0x0D,...u32(OUT),0x89,0x15,...u32(OUT+4)];
    for(let ah = 0; ah < 256; ah++) {
        flags_program.push(0xB8,...u32(0x7FFFFFFF),0x83,0xC0,1,0xB4,ah,0x9E,0x9F,
            0x0F,0xB6,0xC4,0xA3,...u32(OUT+16+ah*8),0x9C,0x58,0xA3,...u32(OUT+20+ah*8));
    }
    for(const vm of machines) {
        await run(vm,loop(flags_program));
        assert.equal(word(vm,OUT)&1,1,"CPUID advertises SSE3");
        assert.equal(word(vm,OUT)&8,0,"MONITOR/MWAIT has a separate, disabled CPUID bit");
        assert.equal(word(vm,OUT+4)&(1<<24),1<<24,"CPUID advertises FXSR");
        for(let ah = 0; ah < 256; ah++) {
            assert.equal(word(vm,OUT+16+ah*8),(ah&0xD5)|2,"SAHF/LAHF selected status flags");
            assert.equal(word(vm,OUT+20+ah*8)&0x8D5,(ah&0xD5)|0x800,"SAHF preserves OF");
        }
    }
    console.log("PASS: CPUID SSE3/FXSR, disabled MONITOR, and 256 SAHF/LAHF flag patterns");
    let cases = 0;
    for(const [name,prefix,op,width] of ops) for(const special of [false,true]) {
        for(let i = 0; i < data.length; i++) data[i] = (i*37 ^ i>>3)&255;
        if(width > 1) for(let i = 0; i < data.length/width; i++) {
            if(special) {
                const patterns = width === 8 ? [0n,0x8000000000000000n,1n,0x7FF0000000000000n,0xFFF0000000000000n,0x7FF123456789ABCDn,0x7FFABCDE01234567n] :
                    [0n,0x80000000n,1n,0x7F800000n,0xFF800000n,0x7F812345n,0x7FCABCDEn];
                if(width === 8) dv.setBigUint64(i*8,patterns[i%patterns.length],true);
                else dv.setUint32(i*4,Number(patterns[i%patterns.length]),true);
            } else if(width === 8) dv.setFloat64(i*8,((i*19)%127-63)*0.125,true);
            else dv.setFloat32(i*4,((i*19)%127-63)*0.125,true);
        }
        const p = [], expected = [];
        for(let n = 0; n < 96; n++) {
            const src = n >> 3 & 7, dst = n & 7, memory = name === "lddqu" || n >= 64;
            // (an m128 operand must be 16-byte aligned, but MOVDDUP's m64 and LDDQU's)
            const offset = name === "movddup" || name === "lddqu" ? [0,1,4080,4095][n&3] : [0,16,4080,4096][n&3];
            const source = memory ? offset : src*16, target = 512+dst*16;
            p.push(...load(dst,DATA+target),...load(src,DATA+source));
            p.push(0xF9,prefix,0x0F,op,(memory ? 5 : 0xC0|src)|dst<<3,...(memory ? u32(DATA+source) : []),
                ...store(dst,OUT+n*32),0x9C,0x58,0xA3,...u32(OUT+n*32+16));
            expected.push(calculate(name,width,data.slice(source,source+16),data.slice(src === dst ? source : target,(src === dst ? source : target)+16)));
        }
        const results = [];
        for(const vm of machines) {
            vm.write_memory(data,DATA); vm.write_memory(new Uint8Array(8192),OUT);
            await run(vm,loop(p));
            const bytes = Uint8Array.from(vm.read_memory(OUT,96*32)); results.push(bytes);
            for(let n = 0; n < 96; n++) {
                assert.equal(bytes[n*32+16]&1,1,`${name} preserves carry`);
                // Special-value payloads are compared bitwise between core
                // paths; the independent JS oracle covers exact finite inputs.
                if(!special && (!name.startsWith("h") && !name.startsWith("addsub") || n < 64 || name.startsWith("addsub")))
                    assert.deepEqual(bytes.slice(n*32,n*32+16),expected[n],`${name} oracle ${n}`);
            }
        }
        assert.deepEqual(results[1],results[0],`${name}: interpreter/page tier bits`);
        assert.deepEqual(results[2],results[0],`${name}: interpreter/regions bits`);
        cases += 96;
    }
    console.log(`PASS: ${cases} SSE3 cases, finite oracle, special bits, aliases and memory boundaries`);

    // The three duplications must see dirty cached inputs and feed cached
    // arithmetic; memory loads and FXSAVE are materialization boundaries.
    for(const special of [false,true]) {
        for(let i = 0; i < 128; i++) dv.setUint32(i*4,special ? [0x7FC12345,0x80000000,1,0x3F800000][i&3] : 0x3F800000,true);
        const p = [0xDB,0xE3];
        for(let r = 0; r < 8; r++) p.push(...load(r,DATA+r*16));
        for(let i = 0; i < 96; i++) {
            const [,prefix,op] = ops[i%9];
            p.push(prefix,0x0F,op,0xC0|(i&7)<<3|((i+1)&7));
            if(i%19 === 18) p.push(...load(i&7,DATA));
        }
        for(let r = 0; r < 8; r++) p.push(...store(r,OUT+r*16));
        p.push(0x0F,0xAE,0x05,...u32(OUT+512));
        const results = [];
        for(const vm of machines) {
            vm.write_memory(data,DATA); vm.write_memory(new Uint8Array(8192),OUT);
            await run(vm,loop(p)); results.push(Uint8Array.from(vm.read_memory(OUT,800)));
        }
        assert.deepEqual(results[2],results[1],"SSE3 mixed sequence, including NaN fallback: regions/page tier");
    }
    console.log("PASS: mixed SSE3 cached sequences, alias chains, memory barriers and FXSAVE");

    // FXSAVE/FXRSTOR preserves the live x87 stack and all eight XMMs.
    dv.setUint32(8000,0x1F80,true);
    const fx = [0xDB,0xE3];
    for(let i = 0; i < 8; i++) fx.push(0xD9,0xE8);
    fx.push(0xD9,0xF7,0xD9,0xF7,0xD9,0xF7,0x0F,0xAE,0x15,...u32(DATA+8000));
    for(let r = 0; r < 8; r++) fx.push(...load(r,DATA+r*16));
    fx.push(0x0F,0xAE,0x05,...u32(OUT),0xDB,0xE3);
    for(let r = 0; r < 8; r++) fx.push(0x66,0x0F,0xEF,0xC0|r<<3|r);
    fx.push(0x0F,0xAE,0x0D,...u32(OUT),0x0F,0xAE,0x05,...u32(OUT+512));
    for(const vm of machines) {
        vm.write_memory(data,DATA); vm.write_memory(new Uint8Array(1024),OUT);
        await run(vm,loop(fx));
        assert.deepEqual(Uint8Array.from(vm.read_memory(OUT,512)),Uint8Array.from(vm.read_memory(OUT+512,512)),"FXSAVE/FXRSTOR live state");
    }
    // FISTTP must truncate under every rounding control, then pop ST(0).
    let integer_cases = 0;
    for(const pc of [0,2,3]) for(let rc = 0; rc < 4; rc++) {
        const control = 0x7F|pc<<8|rc<<10;
        dv.setUint16(7900,control,true);
        const p = [], expected = [];
        for(const [size,opcode] of [[2,0xDF],[4,0xDB],[8,0xDD]])
            for(const input of [0,-0,1.75,-1.75,32768,-32769,2147483648,-2147483649,2**63,-(2**63),Infinity,NaN]) {
                const n = expected.length;
                dv.setFloat64(5000+n*8,input,true);
                p.push(0xDB,0xE3,0xD9,0x2D,...u32(DATA+7900),0xDD,0x05,...u32(DATA+5000+n*8),
                    opcode,0x0D,...u32(OUT+n*16),0xDD,0x3D,...u32(OUT+n*16+8),0xD9,0x3D,...u32(OUT+n*16+10));
                const min = -(1n<<BigInt(size*8-1)), max = -min-1n;
                let value = Number.isFinite(input) ? BigInt(Math.trunc(input)) : min;
                if(value < min || value > max) value = min;
                expected.push({ size,value });
            }
        const results = [];
        for(const vm of machines) {
            vm.write_memory(data,DATA); vm.write_memory(new Uint8Array(8192),OUT);
            await run(vm,loop(p));
            const bytes = Uint8Array.from(vm.read_memory(OUT,expected.length*16)), v = new DataView(bytes.buffer);
            results.push(bytes);
            for(const [n,{ size,value }] of expected.entries()) {
                const actual = size === 8 ? v.getBigInt64(n*16,true) : BigInt(size === 4 ? v.getInt32(n*16,true) : v.getInt16(n*16,true));
                assert.equal(actual,value,"FISTTP truncation and integer indefinite");
                assert.equal(v.getUint16(n*16+8,true)&0x3800,0,"FISTTP pops ST(0)");
                assert.equal(v.getUint16(n*16+10,true),control,"FISTTP preserves rounding control");
            }
        }
        assert.deepEqual(results[1],results[0],"FISTTP interpreter/page tier result and status");
        assert.deepEqual(results[2],results[0],"FISTTP interpreter/regions result and status");
        integer_cases += expected.length;
    }
    console.log(`PASS: FXSAVE/FXRSTOR state and ${integer_cases} FISTTP cases across 12 controls`);

    // Real guest exception delivery after the code has reached the JIT.
    const idt = 0x250000, descriptor = 0x251000, handler = 0x280000;
    let faults = 0;
    const fault_cases = [];
    for(const [name,prefix,op] of ops.filter(x => x[2] === 0xD0 || x[0] === "lddqu")) {
        for(const vector of [7,6,14,...(op === 0xD0 ? [13] : [])]) {
            fault_cases.push({ name, vector, instruction: [prefix,0x0F,op,5,
                ...u32(vector === 14 ? op === 0xD0 ? 0x802000 : 0x801FF8 : vector === 13 ? DATA+1 : DATA)] });
        }
    }
    fault_cases.push({ name: "lddqu register invalid", vector: 6, instruction: [0xF2,0x0F,0xF0,0xC1] });
    for(const { name,vector,instruction } of fault_cases) {
        const p = [0x0F,0x01,0x1D,...u32(descriptor),...ENABLE_SSE,
            0x0F,0x20,0xC0,0x83,0xE0,0xF3,0x0F,0x22,0xC0,...load(0,DATA),...load(1,DATA),0xF3,0x0F,0x12,0xC9];
        if(vector === 7 || vector === 6 && !name.includes("invalid"))
            p.push(0x0F,0x20,0xC0,0x83,0xC8,vector === 7 ? 8 : 4,0x0F,0x22,0xC0);
        const fault_eip = CODE+p.length;
        p.push(...instruction,0xC7,0x05,...u32(0x600),...u32(0xCAFE));
        p.push(0x80,0x3D,...u32(0x604),0,0x75,5);
        p.push(0xE9,...u32(-p.length-5),0xF4);
        const frame = vector === 13 || vector === 14 ? 4 : 0;
        const h = [0x8B,0x44,0x24,frame,0xA3,...u32(OUT),0x83,0x44,0x24,frame,instruction.length];
        if(frame) h.push(0x83,0xC4,4);
        else h.push(0x0F,0x20,0xC0,0x83,0xE0,0xF3,0x0F,0x22,0xC0);
        h.push(0xCF);
        for(const vm of machines) {
            vm.write_memory(data,DATA);
            vm.write_memory(Uint8Array.from([handler&255,handler>>>8&255,8,0,0,0x8E,handler>>>16&255,handler>>>24]),idt+vector*8);
            vm.write_memory(Uint8Array.from([255,7,...u32(idt)]),descriptor);
            vm.write_memory(Uint8Array.from(h),handler); vm.write_memory(new Uint8Array(1),0x604);
            await run(vm,p);
            // (the hot run stops anywhere in its loop: its fault record, not its registers)
            assert.equal(word(vm,OUT),fault_eip,`${name} precise #${vector} (hot)`);
            vm.write_memory(new Uint8Array(4),OUT);
            vm.write_memory(Uint8Array.of(1),0x604); await run(vm,p,false);
            assert.equal(word(vm,OUT),fault_eip,`${name} precise #${vector}`);
            assert.deepEqual(new Uint8Array(vm.v86.cpu.reg_xmm32s.buffer,vm.v86.cpu.reg_xmm32s.byteOffset,16),data.slice(0,16),`${name} fault preserves XMM0`);
            assert.deepEqual(new Uint8Array(vm.v86.cpu.reg_xmm32s.buffer,vm.v86.cpu.reg_xmm32s.byteOffset+16,16),
                calculate("movsldup",4,data.slice(0,16),data.slice(0,16)),"fault materializes earlier cached duplication");
        }
        faults++;
    }
    console.log(`PASS: ${faults} guest #NM/#UD/#GP/#PF cases preserve XMM destination and EIP`);
} finally { for(const vm of machines) await vm.destroy(); }
