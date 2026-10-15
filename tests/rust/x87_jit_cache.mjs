import assert from "node:assert/strict";
import fs from "node:fs";
import { V86 } from "../../build/libv86.mjs";
import { COMPILED_ARMS, compiled_activations } from "./compiled_arms.mjs";
// x87 in the page tier against the interpreter: native f64 arithmetic over
// the shadow cache (x87_fast_math with x87_jit_cache), its entry guards and
// observers, and the runtime policies. (The region tiers, a second compiled
// arm, were deleted in M11.)
const bios = Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer;
const CODE = 0x100000, DATA = 0x200000, OUT = 0x210000;
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const word = (vm, a) => new DataView(Uint8Array.from(vm.read_memory(a, 4)).buffer).getUint32(0, true);
const machines = [];
async function boot(options, wasm = process.argv[2] || "build/v86.wasm") {
    const vm = new V86({ graphics_adapter: "bochs_vga", wasm_path: wasm, bios: { buffer: bios.slice(0) },
        memory_size: 32 << 20, x87_fast_math: true, ...options,
        disable_keyboard: true, disable_mouse: true, disable_speaker: true, net_device: { type: "none" }, autostart: false });
    machines.push(vm);
    await new Promise(r => vm.add_listener("emulator-loaded", r));
    vm.run();
    const end = performance.now() + 10000;
    while(word(vm, 0x500) !== 0xCAFE) { assert(performance.now() < end); await sleep(1); }
    await vm.stop();
    // SSE enabled (CR4.OSFXSR, OSXMMEXCPT: the BIOS leaves them clear)
    vm.v86.cpu.cr[4] |= 0x600;
    return vm;
}
async function run(vm, body, data, interpreted = false) {
    const p = [...body, 0xFF, 0x05, ...u32(0x600)];
    p.push(0xE9, ...u32(-p.length - 5));
    // Every program reuses CODE: start each from an empty compiler state
    // (compiled code needs more heat to recompile a page after each rewrite).
    vm.v86.cpu.jit_clear_cache();
    vm.write_memory(data, DATA);
    vm.write_memory(new Uint8Array(1024), OUT);
    vm.write_memory(new Uint8Array(4), 0x600);
    vm.write_memory(Uint8Array.from(p), CODE);
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    // A preceding #NM case may stop with TS set between guest instructions.
    // Reset that fixture state; the #NM test sets TS itself inside its body.
    cpu.cr[0] &= ~12;
    cpu.instruction_pointer[0] = CODE; cpu.in_hlt[0] = 0;
    const start = compiled_activations(e);
    vm.run();
    const end = performance.now() + 10000;
    while(word(vm, 0x600) < 4 || !interpreted && compiled_activations(e) === start) {
        assert(performance.now() < end, "guest/JIT timeout"); await sleep(1);
    }
    await vm.stop();
    return { bytes: Uint8Array.from(vm.read_memory(OUT, 512)), program: p };
}
let reference, helper;
const arms = [];
// Interpreter reference, then every compiled arm (the page tier); all must produce identical bytes.
async function compare(body, message) {
    const a = await run(reference, body, data, true), results = [];
    for(const { label, vm } of arms) {
        const b = await run(vm, body, data);
        assert.deepEqual(b.bytes, a.bytes, `${label}: ${message}`);
        results.push(b);
    }
    return { a, results };
}
const region = [0xD9,0xC0, 0xD8,0xC8, 0xD9,0xC9, 0xD8,0xC9, 0xDE,0xC1,
    0xD8,0xE1, 0xDC,0xE9, 0xD8,0xF2, 0xD8,0xCA];
const snapshot = [0xDB,0xF1, 0x9C,0x58,0xA3,...u32(OUT+128), // FCOMI then flags
    0xDD,0x35,...u32(OUT)]; // FNSAVE observes every stack slot, tags, TOP and status
const data = new Uint8Array(4096), d = new DataView(data.buffer);
for(const [i,n] of [1.234567890123,0.7321987654321,2].entries()) d.setFloat64(i*8,n,true);
const prefix = (control, rotation = 0, wide = false, count = 3) => {
    d.setUint16(64,control,true);
    return [0xDB,0xE3,...Array.from({length:8},()=>[0xD9,0xEE]).flat(),0xDB,0xE3,
        ...Array.from({length:rotation},()=>[0xD9,0xF7]).flat(),0xD9,0x2D,...u32(DATA+64),
        ...Array.from({length:count},(_,i)=>[...(wide && i === 2 ? [0xDB,0x2D,...u32(DATA+80)] : [0xDD,0x05,...u32(DATA+i%3*8)])]).flat()];
};
try {
    reference = await boot({ disable_jit: true, x87_jit_cache: false });
    // The page tier without the x87 cache: every x87 operation uses helpers.
    helper = await boot({ x87_jit_cache: false });
    for(const { label, options } of COMPILED_ARMS) arms.push({ label, vm: await boot({ ...options, x87_jit_cache: true }) });
    for(const pc of [0,2,3]) for(let rc=0;rc<4;rc++) for(let rotation=0;rotation<8;rotation++) {
        const control=0x7F|pc<<8|rc<<10;
        const body=[...prefix(control,rotation),...region,
            0xDD,0x15,...u32(OUT+256), // memory observer separates regions
            ...region,...snapshot];
        const { a } = await compare(body, `pc=${pc},rc=${rc},top=${rotation}`);
        assert.deepEqual((await run(helper,body,data)).bytes,a.bytes,`helper pc=${pc},rc=${rc},top=${rotation}`);
    }
    console.log("PASS: 96 control/TOP combinations, native regions, stack copies/exchanges/pops, compare/memory observers");
    // Exercise every decoded arithmetic form, including reverse operands,
    // ST(0) aliases, distant stack slots and popping into ST(0).
    for(const opcode of [0xD8,0xDC,0xDE]) for(const group of [0,1,4,5,6,7]) for(const r of [0,1,7]) {
        const body=[...prefix(0x27F,0,false,8),0xD8,0xC1,0xD8,0xC9,
            opcode,0xC0|group<<3|r,...snapshot];
        await compare(body, `arithmetic opcode=${opcode},group=${group},r=${r}`);
    }
    console.log("PASS: all 18 arithmetic forms, aliases, distant slots and pop destinations");
    // Ordered compares must preserve all non-arithmetic EFLAGS, distinguish
    // status-word vs integer flags, pop correctly, and keep values cached.
    const observe=snapshot.slice(2); // do not overwrite the comparison under test
    const compare_forms=[[0xD8,0xD1],[0xD8,0xD9],[0xDC,0xD1],[0xDC,0xD9],
        [0xDE,0xD9],[0xDB,0xF1],[0xDF,0xF1]];
    for(const cmp of compare_forms) for(const value of [0.0625,0.125,0.25,-0.125]) for(const rc of [0,1,2,3]) {
        d.setFloat64(0,1,true);d.setFloat64(8,value,true);d.setFloat64(16,2,true);
        const body=[...prefix(0x27F|rc<<10,7,false,8),0xD9,0xE5, // FXAM seeds C bits
            0xB8,...u32(0x7FFFFFFF),0x83,0xC0,1,0xF9, // deferred OF/SF/AF and CF
            0xD8,0xC0,0xD8,0xC0,0xD8,0xC0,...cmp,...observe];
        await compare(body, `compare ${cmp}, value=${value},rc=${rc}`);
    }
    // Normal entry -> overflow -> NaN exercises signaling ordered comparisons,
    // including a later ADD clearing SoftFloat flags but retaining x87 invalid.
    d.setFloat64(0,Number.MAX_VALUE,true);d.setFloat64(8,2,true);d.setFloat64(16,3,true);
    for(const cmp of compare_forms) for(const tail of [[],[0xD8,0xC1],[0xD8,0xC9],[0xD8,0xE1],[0xD8,0xF1]]) {
        const body=[...prefix(0x27F,0,false,4),0xB8,...u32(0x7FFFFFFF),0x83,0xC0,1,0xF9,0xD8,0xC0,0xD8,0xE0,0xD8,0xC0,...cmp,...tail,...observe];
        const { results } = await compare(body, `cached NaN compare ${cmp} and subsequent arithmetic ${tail}`);
        for(const b of results) assert(new DataView(b.bytes.buffer).getUint16(4,true)&1,"ordered NaN sets x87 invalid");
    }
    for(const [i,n] of [1.234567890123,0.7321987654321,2].entries()) d.setFloat64(i*8,n,true);
    // Compare then more arithmetic/stack moves stays in a single region.
    const joined=[...prefix(0x27F),...region,0xDF,0xF1,0xD9,0xC0,
        0xD8,0xC1,0xD8,0xC9,0xD8,0xE1,0xD8,0xD1,...observe];
    await compare(joined, "comparison connects subsequent cached operations");
    console.log("PASS: ordered compare forms/rounding, EFLAGS/status, pops, NaNs and cache continuity");
    // Conditional branches consume the EFLAGS produced by FCOMIP at a block
    // boundary. Cover ordered less/equal/greater and unordered parity branches.
    for(const value of [0.0625,0.125,0.25,Number.MAX_VALUE]) for(const jump of [0x72,0x74,0x7A]) {
        d.setFloat64(16,value,true);d.setFloat64(8,1,true);
        const arithmetic=value===Number.MAX_VALUE ? [0xD8,0xC0,0xD8,0xE0,0xD8,0xC0] : [0xD8,0xC0,0xD8,0xC0,0xD8,0xC0];
        const body=[...prefix(0x27F),...arithmetic,0xDF,0xF1,
            jump,7,0xB8,...u32(111),0xEB,5,0xB8,...u32(222),0xA3,...u32(OUT+300),...observe];
        await compare(body, "Jcc sees cached FCOMIP flags");
        const take=jump===0x72 ? value===0.0625 || value===Number.MAX_VALUE :
            jump===0x74 ? value===0.125 || value===Number.MAX_VALUE : value===Number.MAX_VALUE;
        for(const { vm } of arms) assert.equal(word(vm,OUT+300),take?222:111);
    }
    for(const [i,n] of [1.234567890123,0.7321987654321,2].entries()) d.setFloat64(i*8,n,true);
    // Entry guards preserve wide/special/subnormal values and stack faults.
    for(const [mantissa,exponent,count] of [[0x8000000000000001n,0x3FFF,3],
        [0x8000000000000000n,0x7FFF,3],[0xC000000000000000n,0x7FFF,3],
        [0xA000000000000000n,0x7FFF,3],[1n,0,3],[0x8000000000000000n,0x3FFF,1],
        [0x8000000000000000n,0x3FFF,8]]) {
        d.setBigUint64(80,mantissa,true);d.setUint16(88,exponent,true);
        const body=[...prefix(0x27F,0,true,count),...region,...snapshot];
        await compare(body, "guarded fallback preserves original helper semantics");
    }
    for(const value of [Number.MAX_VALUE, 2 ** -1022, Number.MIN_VALUE, -0]) {
        d.setFloat64(0,value,true);
        for(let rc=0;rc<4;rc++) {
            const body=[...prefix(0x27F|rc<<10),...region,...snapshot];
            await compare(body,"overflow/subnormal/NaN intermediates preserve helper results");
        }
    }
    d.setFloat64(0,1.234567890123,true);
    // Newly native stack/control operations, quiet compares and math helpers
    // must preserve the complete F80 image, including freed physical slots.
    const extra_ops = [
        [0xD9,0xFC], [0xD9,0xD0], [0xD9,0xE0], [0xD9,0xE1], [0xD9,0xE8], [0xD9,0xEE],
        [0xD9,0xF6,0xD9,0xF7], [0xDD,0xC2], [0xDD,0xD2], [0xDD,0xDA],
        [0xDD,0xE1], [0xDD,0xE9], [0xDA,0xE9], [0xDB,0xE9], [0xDF,0xE9],
        [0xD9,0xFE], [0xD9,0xFF], [0xD9,0xFB], [0xD9,0xF2], [0xD9,0xF3],
    ];
    for(const ops of extra_ops) for(const rotation of [0,3,7]) for(const rc of [0,1,2,3]) {
        const body=[...prefix(0x27F|rc<<10,rotation),0xD8,0xC1,0x31,0xC0,...ops,...observe];
        await compare(body,`extended operations ${ops},top=${rotation},rc=${rc}`);
    }
    for(const value of [-2.5,-1.5,-0.5,-0,0,0.5,1.5,2.5,2**53,Infinity]) for(const rc of [0,1,2,3]) {
        d.setFloat64(16,value,true);
        const body=[...prefix(0x27F|rc<<10),0xD9,0xFC,...snapshot];
        await compare(body,`FRNDINT value=${value},rc=${rc}`);
    }
    d.setFloat64(16,2,true);
    // Generate a quiet NaN inside the cache, then use every unordered compare.
    for(const cmp of [[0xDD,0xE1],[0xDD,0xE9],[0xDA,0xE9],[0xDB,0xE9],[0xDF,0xE9]]) {
        const body=[...prefix(0x27F),0xD8,0xE0,0xD8,0xF0,0x31,0xC0,...cmp,...observe];
        await compare(body,`quiet NaN compare ${cmp}`);
    }
    console.log("PASS: native stack/control/quiet comparisons and cached transcendental helpers");
    // MMX accesses observe the physical F80 storage; direct MMX writes then
    // invalidate cached values before later x87 accesses, including EMMS.
    for(const ops of [
        [0x0F,0x7F,0x05,...u32(OUT+256)], // MOVQ [out],mm0
        [0x0F,0x6F,0x05,...u32(DATA),0x0F,0x77], // MOVQ mm0,[data]; EMMS
        [0x0F,0xEF,0xC0,0x0F,0x77], // PXOR mm0,mm0; EMMS
        [0x66,0x0F,0x2A,0xC0], // CVTPI2PD xmm0,mm0 also has a mandatory prefix
        [0xF3,0x0F,0xD6,0xC0,0xF2,0x0F,0xD6,0xC8,0x0F,0x77], // MMX/XMM transfers
        [0x66,0x0F,0xEF,0xC0], // ordinary XMM PXOR must not alias the x87 stack

        [0x0F,0xAE,0x05,...u32(OUT+512), // FXSAVE/FXRSTOR, overwrite between
         0xD9,0xE0,0x0F,0xAE,0x0D,...u32(OUT+512)],
        [0xD9,0x35,...u32(OUT+256),0xD9,0x25,...u32(OUT+256)], // environment
        [0xDD,0x35,...u32(OUT+256),0xDD,0x25,...u32(OUT+256)], // full state
    ]) {
        const body=[...prefix(0x27F),...region,0x31,0xC0,...ops,...observe];
        await compare(body,`MMX/state observer ${ops}`);
    }
    for(const is32 of [false,true]) for(const rc of [0,1,2,3]) {
        for(const bits of is32 ? [0,0x80000000,1,0x7F800000,0x7FC12345,0x7F812345] :
            [0n,0x8000000000000000n,1n,0x7FF0000000000000n,0x7FF8123456789ABCn,0x7FF0123456789ABCn]) {
            if(is32) d.setUint32(96,bits,true); else d.setBigUint64(96,bits,true);
            const body=[...prefix(0x27F|rc<<10),is32?0xD9:0xDD,0x05,...u32(DATA+96),
                0xDD,0x1D,...u32(OUT+256),...snapshot];
            await compare(body,`memory load/store width=${is32?32:64},bits=${bits},rc=${rc}`);
        }
    }
    console.log("PASS: cached m32/m64 loads and m64 stores, signed zero, subnormals, infinities and NaN payloads");
    // Consecutive regions separated by real branches reuse the shadow cache.
    // No F80 observer is needed until the final FNSAVE.
    const split=[...prefix(0x27F),0x31,0xC0,...Array.from({length:30},()=>[0xD8,0xC9,0xEB,0]).flat(),...observe];
    await compare(split, "persistent branch boundaries");
    console.log("PASS: persistent branch caching, MMX aliases and environment/full-state observers");
    // Observe the committed FPU state inside #PF and resume after the memory
    // instruction. #NM must instead trap before any cached operation executes.
    const IDT=0x220000,DESC=0x221000,HANDLER=0x222000;
    for(const fault_kind of ["read","store","load","nm"]) {
        const nm=fault_kind==="nm", fault_length=fault_kind==="read"?5:6;
        const handler=nm ? [0x8B,0x04,0x24,0xA3,...u32(OUT+400),0x0F,0x06,0xCF] :
            [0xDD,0x35,...u32(OUT),0xDD,0x25,...u32(OUT),
                0x8B,0x44,0x24,4,0xA3,...u32(OUT+400),
                0x83,0x44,0x24,4,fault_length,0x83,0xC4,4,0xCF];
        for(const vm of machines) {
            vm.write_memory(Uint8Array.from([HANDLER&255,HANDLER>>>8&255,8,0,0,0x8E,HANDLER>>>16&255,HANDLER>>>24]),IDT+(nm?7:14)*8);
            vm.write_memory(Uint8Array.from([0xFF,7,...u32(IDT)]),DESC);
            vm.write_memory(Uint8Array.from(handler),HANDLER);
        }
        const body=[...prefix(0x27F),0x0F,0x01,0x1D,...u32(DESC)];
        if(nm) body.push(0x0F,0x20,0xC0,0x83,0xC8,8,0x0F,0x22,0xC0);
        const fault_ops=[...region,0xDF,0xF1];
        const fault=CODE+body.length+(nm?0:fault_ops.length);
        body.push(...fault_ops);
        if(nm) body.push(...snapshot);
        else body.push(...(fault_kind==="store"?[0xDD,0x1D]:fault_kind==="load"?[0xDD,0x05]:[0xA1]),...u32(0xA00000));
        await compare(body,nm?"#NM preserves first-instruction EIP and state":`#PF ${fault_kind} sees precise cache and stack state`);
        for(const { vm } of arms) assert.equal(word(vm,OUT+400),fault,"precise fault EIP");
    }
    console.log("PASS: overflow/subnormal intermediates and precise #NM/#PF state");
    // A long x87 run (20 copies of the sequence; the region tiers split it at
    // their bound until M11); warm code checks the runtime policy anew at
    // every instruction (x87_native_policy).
    const body=[...prefix(0x27F),...Array.from({length:20},()=>region).flat(),...snapshot];
    const a=await run(helper,body,data);
    helper.v86.cpu.wm.exports.set_x87_fast_math(false);
    const compatible=await run(helper,body,data);
    helper.v86.cpu.wm.exports.set_x87_fast_math(true);
    const output=vm=>Uint8Array.from(vm.read_memory(OUT,512));
    for(const { label, vm: cached } of arms) {
        const e=cached.v86.cpu.wm.exports, b=await run(cached,body,data);
        assert.deepEqual(b.bytes,a.bytes,`${label}: a long x87 run preserves all stack state`);
        e.set_x87_fast_math(false);cached.run();await sleep(25);await cached.stop();
        assert.deepEqual(output(cached),compatible.bytes,`${label}: warm code honors compatible arithmetic`);
        e.set_x87_fast_math(true);cached.run();await sleep(25);await cached.stop();
        const saved=await cached.save_state();
        e.set_x87_jit_cache(false);cached.run();await sleep(25);await cached.stop();
        assert.deepEqual(output(cached),a.bytes,`${label}: warm code honors cache disable`);
        await cached.restore_state(saved);
        assert.equal(e.get_x87_jit_cache(),0,"restore retains selected host policy");
        e.set_x87_jit_cache(true);cached.run();await sleep(25);await cached.stop();
        assert.deepEqual(output(cached),b.bytes,`${label}: restore regenerates valid cached code`);
    }
    console.log("PASS: guard fallback, long x87 runs, runtime switch, SMC between cases and save/restore");
    // Save while f64 is authoritative and no guest F80 observer has run.
    d.setFloat64(8,1,true);d.setFloat64(16,2,true);
    const seed_only=[...prefix(0x27F),0xD8,0xC1,0xFF,0x05,...u32(0x600),0xE9,...u32(-11)];
    for(const { label, vm: cached } of arms) {
        await run(cached,seed_only,data);
        const dirty_saved=await cached.save_state();
        assert.equal(cached.v86.cpu.fpu_st[5*4+1]>>>0,0xC0000000,`${label}: save materializes 3.0 significand`);
        assert.equal(cached.v86.cpu.fpu_st[5*4+2]&65535,0x4000,`${label}: save materializes 3.0 exponent`);
        await run(cached,[...prefix(0x27F),0xD8,0xE0,...snapshot],data);
        await cached.restore_state(dirty_saved);
        assert.equal(BigInt.asUintN(64,cached.v86.cpu.wm.exports.fpu_store_m64_bits()),0x4008000000000000n,
            `${label}: restore discards newer shadow values and reads saved 3.0`);
    }
    console.log("PASS: host save materializes dirty f64 state and restore discards stale shadow values");
    // Warm-loop throughput in the page tier, same generated code and input; switch
    // only runtime cache policy. The body reloads its seeds each iteration.
    const cached=arms[0].vm;
    await run(cached,[...prefix(0x27F),...Array.from({length:3},()=>region).flat(),...snapshot],data);
    const times=[[],[]];
    for(let round=0;round<7;round++) for(const mode of round&1?[1,0]:[0,1]) {
        cached.v86.cpu.wm.exports.set_x87_jit_cache(!!mode);
        const start=performance.now(),before=word(cached,0x600);
        while(performance.now()-start<80) cached.v86.cpu.main_loop();
        if(round>=2) times[mode].push(((word(cached,0x600)-before)>>>0)/(performance.now()-start));
    }
    const median=a=>a.sort((a,b)=>a-b)[a.length>>1];
    console.log(JSON.stringify({benchmark:"actual x87 guest loop, unrecorded",helper_loops_per_ms:median(times[0]),
        cached_loops_per_ms:median(times[1]),speedup:median(times[1])/median(times[0])}));
    if(process.env.X87_COMPARE_BASELINE) {
        const baseline=await boot({ x87_jit_cache: true },process.env.X87_COMPARE_BASELINE);
        cached.v86.cpu.wm.exports.set_x87_jit_cache(true);
        const body=[...prefix(0x27F),...region,0xD8,0xD1,...region,0xD8,0xD1,...region,0xDF,0xF1,...observe];
        const before=await run(baseline,body,data),after=await run(cached,body,data);
        assert.deepEqual(after.bytes,before.bytes,"previous cached build and cached comparisons agree");
        const rates=[[],[]], vms=[baseline,cached];
        for(let round=0;round<7;round++) for(const mode of round&1?[1,0]:[0,1]) {
            const vm=vms[mode],start=performance.now(),count=word(vm,0x600);
            while(performance.now()-start<80) vm.v86.cpu.main_loop();
            if(round>=2) rates[mode].push(((word(vm,0x600)-count)>>>0)/(performance.now()-start));
        }
        console.log(JSON.stringify({benchmark:"previous build vs persistent cache, unrecorded guest loop",
            before_loops_per_ms:median(rates[0]),after_loops_per_ms:median(rates[1]),speedup:median(rates[1])/median(rates[0])}));
        // Seed once, then retain the stack across loop backedges, matching the
        // persistence mechanism independently of per-iteration FSAVE/reloads.
        d.setFloat64(0,0.25,true);d.setFloat64(8,1,true);d.setFloat64(16,2,true);
        const seeded=prefix(0x27F), loop=[...Array.from({length:4},()=>
            [0xD8,0xC1,0xD8,0xE1,0xD8,0xC9]).flat(),0xD8,0xD1,
            0xDD,0x15,...u32(OUT+256),0xFF,0x05,...u32(0x600)];
        loop.push(0xE9,...u32(-loop.length-5));
        const persistent_body=[...seeded,...loop];
        const old_persistent=await run(baseline,persistent_body,data),new_persistent=await run(cached,persistent_body,data);
        assert.deepEqual(new_persistent.bytes,old_persistent.bytes,"persistent loop output agrees");
        const persistent_rates=[[],[]];
        for(let round=0;round<7;round++) for(const mode of round&1?[1,0]:[0,1]) {
            const vm=vms[mode],start=performance.now(),count=word(vm,0x600);
            while(performance.now()-start<80) vm.v86.cpu.main_loop();
            if(round>=2) persistent_rates[mode].push(((word(vm,0x600)-count)>>>0)/(performance.now()-start));
        }
        console.log(JSON.stringify({benchmark:"persistent x87 backedge, unrecorded guest loop",
            before_loops_per_ms:median(persistent_rates[0]),after_loops_per_ms:median(persistent_rates[1]),
            speedup:median(persistent_rates[1])/median(persistent_rates[0])}));

    }
} finally { for(const vm of machines) await vm.destroy(); }
