// Cache-resident promotion heat is an opt-in scheduling policy. It must retain
// per-alias work without granting publication or execution authority.
import assert from "node:assert/strict";
import fs from "node:fs";
import {V86} from "../../../build/libv86.mjs";

const wasm = process.argv[2] || "build/v86-ir-cache-test.wasm";
// The region scheduler is under test: ir_tier0 (32-bit code in the x64 page tier, on by default) is off.
const vm = new V86({graphics_adapter: "bochs_vga", wasm_path: wasm, ir_tier0: false, memory_size: 32 << 20,
    bios: {buffer: Uint8Array.from(fs.readFileSync("build/jit-capacity.bin")).buffer},
    disable_keyboard: true, disable_mouse: true, disable_speaker: true,
    net_device: {type: "none"}, autostart: false});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const instantiate = WebAssembly.instantiate;
const PC = 0x100000, INITIAL = 0xFFFFFFF0;
try {
    await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
    const cpu = vm.v86.cpu, e = cpu.wm.exports;
    const words = () => new Uint32Array(e.memory.buffer);
    const count = () => words()[664 >> 2];
    const stat = (pc, field, cs = 0, mode = 1) => e.ir_cache_entry_stat(pc, cs, mode, field);
    const owner = pc => [stat(pc, 18), stat(pc, 19)];
    const config = (enabled, threshold = 1000000, promote = 1000000) =>
        assert.equal(e.ir_auto_config(enabled, threshold, promote, 192, 256, 64), 1);
    const until = async (condition, label) => {
        const deadline = performance.now() + 15000;
        while(!condition()) { assert(performance.now() < deadline, label); await sleep(1); }
    };
    vm.run();
    await until(() => new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset).getUint16(0x500, true) === 0xCAFE, "BIOS boot");
    await vm.stop();

    const prepare = (pc = PC, iterations = 1) => {
        cpu.segment_offsets.fill(0, 0, 6); cpu.segment_is_null.fill(0, 0, 6);
        cpu.is_32[0] = cpu.stack_size_32[0] = 1;
        cpu.reg32.fill(0); cpu.reg32[1] = iterations; cpu.reg32[4] = 0x90000;
        cpu.reg_xmm32s.fill(0); cpu.flags[0] = 2; cpu.flags_changed[0] = cpu.in_hlt[0] = 0;
        cpu.instruction_pointer[0] = pc; words()[664 >> 2] = INITIAL;
        e.update_state_flags(); e.full_clear_tlb();
    };
    const clear = policy => {
        config(0); cpu.jit_clear_cache(); e.ir_cache_collect();
        assert.equal(e.ir_cache_stat(1), 0);
        assert.equal(e.ir_cache_set_resident_promotion(policy), 1);
        assert.equal(e.ir_cache_set_fusion(0), 1);
        assert.equal(e.ir_auto_set_hot_capacity(128), 1);
        assert.equal(e.ir_auto_set_hot_filter(0), 1);
    };
    const compile = async (pc, length, tier = 1) => {
        cpu.instruction_pointer[0] = pc; cpu.in_hlt[0] = 0;
        assert(await cpu.ir_compile_cached(length, tier, 1, 1, 256, 64), `explicit Tier ${tier} at ${pc.toString(16)}`);
    };
    const finish = async () => {
        const deadline = performance.now() + 15000;
        while(!cpu.in_hlt[0]) {
            assert(performance.now() < deadline, "finite guest progress");
            e.main_loop(); await sleep(0);
        }
        await until(() => e.ir_auto_stat(10) === 0, "pending publication settles");
    };
    const state = () => ({regs: Array.from(cpu.reg32), flags: e.get_eflags() >>> 0,
        raw: cpu.flags[0] >>> 0, changed: cpu.flags_changed[0] >>> 0,
        operand: words()[104 >> 2], result: words()[112 >> 2], size: words()[96 >> 2],
        pc: cpu.instruction_pointer[0] >>> 0, count: count(), xmm: Array.from(cpu.reg_xmm32s)});

    config(0); cpu.jit_clear_cache(); e.ir_cache_collect();
    assert.equal(e.ir_cache_stat(41), 0, "resident promotion is disabled by default");
    for(const invalid of [2, 0xFFFFFFFF]) assert.equal(e.ir_cache_set_resident_promotion(invalid), 0);
    assert.equal(e.ir_cache_set_resident_promotion(1), 1);
    config(1); assert.equal(e.ir_cache_set_resident_promotion(0), 0, "enabled scheduler rejects policy changes");
    config(0); assert.equal(e.ir_cache_stat(41), 1, "configuration preserves the policy");

    // Every entry is already resident; only the old 128-PC heat ring churns.
    // Four instructions per visit, except the final branch replaces JMP with HLT.
    const blocks = 160, visits = blocks * 12, halt = PC + blocks * 4096;
    let baseline;
    for(const policy of [0, 1]) {
        clear(policy); prepare();
        for(let i = 0; i < blocks; i++) {
            const pc = PC + i * 4096, next = PC + ((i + 1) % blocks) * 4096;
            const bytes = Uint8Array.of(0x40, 0x49, 0x0F, 0x84, 0, 0, 0, 0, 0xE9, 0, 0, 0, 0);
            const view = new DataView(bytes.buffer);
            view.setInt32(4, halt - pc - 8, true); view.setInt32(9, next - pc - 13, true);
            vm.write_memory(bytes, pc); await compile(pc, bytes.length);
        }
        vm.write_memory(Uint8Array.of(0xF4), halt);
        assert.equal(e.ir_cache_stat(0), blocks); assert.equal(e.ir_auto_stat(29), 128);
        assert.equal(e.ir_cache_set_resident_promotion(1 - policy), 0, "resident owners pin startup policy");
        prepare(PC, blocks); config(1, 1000000, 8);
        const attempts = e.ir_auto_stat(3), published = e.ir_auto_stat(5);
        // One bounded scan is allowed per outer frame. Twelve complete finite
        // laps provide identical frame boundaries without a wall-clock gate.
        for(let lap = 0; lap < visits / blocks; lap++) {
            cpu.reg32[1] = blocks; cpu.instruction_pointer[0] = PC; cpu.in_hlt[0] = 0;
            await finish();
            assert.equal(count(), (INITIAL + 4 * blocks * (lap + 1)) >>> 0);
        }
        assert.equal(count(), (INITIAL + 4 * visits) >>> 0);
        assert.equal(cpu.reg32[0], visits); assert.equal(cpu.reg32[1], 0);
        assert.equal(cpu.instruction_pointer[0], halt + 1);
        // Both policies earn upgrades from the resident owners' own activation
        // counts; the 128-PC heat ring no longer decides Tier-1 promotion.
        assert(e.ir_auto_stat(3) > attempts && e.ir_auto_stat(5) > published,
            `policy ${policy}: resident owners retain heat through more than 128 interleaved PCs`);
        if(policy) assert.deepEqual(state(), baseline, "promotion changes no guest or lazy-FLAGS state");
        else baseline = state();
    }
    console.log(`PASS: ${wasm}: 160 interleaved Tier-1 owners promote under both policies with identical wrapped guest/lazy-FLAGS state`);

    // Establish two entry aliases of one published body using actual observed
    // execution, then measure independent admission heat after a config reset.
    clear(1); prepare();
    const shared = Uint8Array.of(0x43, 0x49, 0x75, 0xFC, 0xF4);
    vm.write_memory(shared, PC); config(1, 4, 1000000);
    prepare(PC + 1, 1); await finish();
    prepare(PC, 16); await finish();
    assert.equal(stat(PC, 11), 2); assert.deepEqual(owner(PC), owner(PC + 1));
    const shared_owner = owner(PC);
    config(1, 1000000, 4); assert.equal(stat(PC, 15), 0); assert.equal(stat(PC + 1, 15), 0);
    for(const offset of [0, 0, 0, 1]) {
        const before = stat(PC + offset, 15);
        prepare(PC + offset, 1); await finish();
        assert.equal(count(), (INITIAL + 4 - offset) >>> 0);
        assert.equal(stat(PC + offset, 15), before + 1, "one Tier-1 admission earns one alias hit");
    }
    assert.equal(stat(PC, 15), 3); assert.equal(stat(PC + 1, 15), 1);
    assert.equal(stat(PC, 5), 1); assert.equal(stat(PC + 1, 5), 1,
        "combined owner heat cannot promote either independently cold alias");
    assert.equal(stat(PC, 15, 1), 0, "wrong CS is not the same alias");
    assert.equal(stat(PC, 15, 0, 0), 0, "wrong decode mode is not the same alias");
    await compile(PC + 1, 3, 2);
    assert.deepEqual(owner(PC), shared_owner); assert.notDeepEqual(owner(PC + 1), shared_owner);
    assert.equal(stat(PC, 11), 1); assert.equal(stat(PC, 15), 3, "partial supersession retains the other alias's heat");
    assert.equal(stat(PC + 1, 15), 0, "replacement owner does not inherit alias heat");
    config(1); assert.equal(stat(PC, 15), 0); assert.equal(stat(PC, 16), 0);
    assert.deepEqual(owner(PC), shared_owner, "configuration reset preserves executable owners");
    vm.write_memory(Uint8Array.of(shared[0]), PC);
    assert.equal(stat(PC, 0), 0); assert.equal(stat(PC + 1, 0), 0, "same-byte SMC retires all dependent owners");
    config(0); prepare(); await compile(PC, shared.length);
    assert.notDeepEqual(owner(PC), shared_owner); assert.equal(stat(PC, 15), 0);
    cpu.jit_clear_cache(); e.ir_cache_collect();
    assert.equal(e.ir_cache_stat(41), 1); assert.equal(stat(PC, 15), 0); assert.equal(stat(PC, 0), 0);
    console.log(`PASS: ${wasm}: per-alias heat, full key/owner identity, partial supersession, configuration reset, SMC and cache reset`);

    // The Tier-1 owner covers only INC. A failed Tier-2 source additionally
    // covers the tail: retries must compare that capture, not the Tier-1 byte.
    const body = Uint8Array.of(0x43, ...Array(32).fill(0x90), 0x49, 0x75, 0xDC, 0xF4);
    const seed_prefix = async (iterations = 256) => {
        clear(1); prepare(PC, iterations); vm.write_memory(body, PC);
        await compile(PC, 1); prepare(PC, 2); config(1, 1000000, 2);
        // Earn heat in one finite frame, then test selection in the next frame.
        await finish(); final_body(2); prepare(PC, iterations);
    };
    const final_body = iterations => {
        assert.equal(count(), (INITIAL + iterations * 35 + 1) >>> 0);
        assert.equal(cpu.reg32[1], 0); assert.equal(cpu.instruction_pointer[0], PC + body.length);
    };
    await seed_prefix(); const failed_owner = owner(PC);
    let rejected = 0;
    WebAssembly.instantiate = (bytes, imports) => imports.e
        ? (rejected++, Promise.reject(new WebAssembly.CompileError("controlled resident promotion failure")))
        : instantiate(bytes, imports);
    await finish(); final_body(256);
    assert.equal(rejected, 1); assert.equal(stat(PC, 5), 1); assert.equal(stat(PC, 16), 1);
    assert.deepEqual(owner(PC), failed_owner);
    const suppressed = e.ir_cache_stat(45);
    prepare(PC, 256); await finish(); final_body(256);
    assert.equal(rejected, 1, "same failed Tier-2 source cannot repeatedly compile");
    assert(e.ir_cache_stat(45) > suppressed);
    cpu.mem8[PC + 16] = 0xF8; // CLC outside the single-byte Tier-1 snapshot.
    prepare(PC, 256); await finish(); final_body(256);
    assert.equal(rejected, 2, "raw tail change retries the failed Tier-2 capture exactly once");
    assert.deepEqual(owner(PC), failed_owner, "Tier-1 prefix remains valid across raw tail changes");
    prepare(PC, 128); await finish(); final_body(128);
    assert.equal(rejected, 2); assert.equal(stat(PC, 16), 1);
    WebAssembly.instantiate = instantiate;
    config(1); assert.equal(stat(PC, 16), 0); assert.equal(stat(PC, 15), 0);
    console.log(`PASS: ${wasm}: rejected upgrade preserves Tier 1, full captured-source retry suppression and raw-tail retry`);

    for(const kind of ["cancel", "reset", "supersede", "raw-change"]) {
        await seed_prefix(); let held;
        const original_owner = owner(PC);
        WebAssembly.instantiate = (bytes, imports) => imports.e
            ? new Promise((resolve, reject) => { assert(!held); held = {bytes, imports, resolve, reject}; })
            : instantiate(bytes, imports);
        e.main_loop(); assert(held, `${kind}: hold resident Tier-2 installation`);
        assert.equal(stat(PC, 5), 1); assert.deepEqual(owner(PC), original_owner);
        const before = state(), completed_increments = cpu.reg32[3];
        if(kind === "cancel") config(0);
        if(kind === "reset") { config(0); cpu.jit_clear_cache(); e.ir_cache_collect(); }
        if(kind === "raw-change") cpu.mem8[PC] = 0x4B;
        WebAssembly.instantiate = instantiate;
        let replacement;
        if(kind === "supersede") {
            const ip = cpu.instruction_pointer[0]; await compile(PC, 1);
            replacement = owner(PC); assert.notDeepEqual(replacement, original_owner);
            cpu.instruction_pointer[0] = ip;
        }
        held.resolve(await instantiate(held.bytes, held.imports));
        await until(() => e.ir_auto_stat(10) === 0, "obsolete promotion completion settles");
        assert.deepEqual(state(), before, `${kind}: publication must not retire guest work`);
        assert.notEqual(stat(PC, 5), 2, `${kind}: obsolete resident promotion cannot install`);
        if(replacement) {
            assert.deepEqual(owner(PC), replacement); assert.equal(stat(PC, 16), 0,
                "stale completion cannot poison a replacement owner's retry state");
        }
        config(0); await finish(); final_body(256);
        assert.equal(cpu.reg32[3], kind === "raw-change" ? 2 * completed_increments - 256 : 256);
    }
    console.log(`PASS: ${wasm}: pending promotion cancellation, reset, owner supersession and raw SMC; exact retirement before/after asynchronous completion`);
} finally {
    WebAssembly.instantiate = instantiate;
    await vm.destroy();
}
