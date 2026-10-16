#!/usr/bin/env node
// The ARM core's extended RAM (docs/arm64-virt-android16-plan.md P8.5;
// src/rust/aarch64/extended.rs): 64 MiB of RAM and 8 MiB of extended RAM at
// 4 GiB, cached in 1 MiB of frames, so that most accesses page. The bus's
// view of it (a hole after it, accesses of each width, across pages, Q
// registers), eviction under a pattern over all of it, the DMA facade
// (blobs across pages, scalars), the device tree's second memory range,
// code at 4 GiB (through an identity map: the page tier needs the MMU on),
// rewritten by DMA after its frame was evicted, run again (interpreter and
// page tier: the page tier compiles it from extended RAM, the DMA write
// retires it), a single-buffer snapshot
// refused, a snapshot stream restored into another machine, power-on
// clearing it.
//
//   node tests/a64/extended_memory.mjs   (A64_WASM: the core, default build/v86-arm64.wasm)
//   (A64_VERBOSE=1: the page tier's statistics)
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { virt_tree } from "../../src/virt/dtb.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const MiB = 1 << 20, EXT = 2 ** 32, EXTENDED = 8 * MiB;
const RAM = 0x40000000;
const options = jit => ({
    cpu_type: "arm64", graphics_adapter: "none", memory_size: 64 * MiB, autostart: false, log_level: 0,
    extended_memory_size: EXTENDED, extended_memory_cache: MiB,
    wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm",
    ...(jit ? { jit_switches: { a64_page: 1 }, ir_sync_publication: true } : {}),
});
const start = async jit => {
    const emulator = new V86(options(jit));
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    return emulator;
};
const split = pa => [pa >>> 0, Math.floor(pa / 2 ** 32)];
// (a pattern word of each 8 bytes of extended RAM)
const pattern = pa => BigInt.asUintN(64, BigInt(pa) * 0x9E3779B97F4A7C15n);

// the bootstrap in RAM at BOOT (assembled here): the MMU on with an identity
// map of 1 GiB blocks at TABLE (RAM's first GiB, extended RAM's), then to the program
const BOOT = RAM + 0x1000, TABLE = RAM + 0x100000;
const directory = root + "build/a64-extended/";
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(directory + "boot.S", `.global start
start:
    movz x0, #0xFF
    msr mair_el1, x0
    ldr x0, =0x200803519
    msr tcr_el1, x0
    ldr x0, =${TABLE}
    msr ttbr0_el1, x0
    isb
    mrs x0, sctlr_el1
    orr x0, x0, #1
    msr sctlr_el1, x0
    isb
    ldr x0, =${EXT + 0x10000}
    br x0
.ltorg
`);
const host = spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout.match(/^host: (.*)$/m)[1];
const lld = process.env.LD_LLD || `${spawnSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).stdout.trim()}/lib/rustlib/${host}/bin/rust-lld`;
for(const [program, args] of [[process.env.CLANG || "clang", ["--target=aarch64-none-elf", "-c", "-o", directory + "boot.o", directory + "boot.S"]],
    [lld, ["-flavor", "gnu", "-m", "aarch64elf", "-static", "-e", "start", "-Ttext=" + BOOT.toString(16), "--oformat=binary", "-o", directory + "boot.bin", directory + "boot.o"]]])
{
    const result = spawnSync(program, args, { encoding: "utf8" });
    assert.equal(result.status, 0, program + ": " + result.stderr);
}
const boot_code = fs.readFileSync(directory + "boot.bin");
const table = new Uint8Array(4096);
for(const block of [RAM, EXT]) new DataView(table.buffer).setBigUint64(8 * (block / 2 ** 30), BigInt(block) | 0x701n, true);

// the program at 4 GiB + CODE: 20000 times a constant stored to RAM, then
// 0xD0E after it, then a loop on itself
const CODE = 0x10000;
const LOOP_VALUE = 1;
const program = value => [0xD2A80002, 0x5289C404, 0x52800001 | value << 5, 0xB9000041, 0x71000484, 0x54FFFFA1, 0x5281A1C5, 0xB9000445, 0x14000000];
const code_bytes = value => new Uint8Array(new Uint32Array(program(value)).buffer);
const run_program = (cpu, what) => {
    cpu.mem8.fill(0, 0, 8);
    cpu.write_blob_physical(boot_code, BOOT);
    cpu.write_blob_physical(table, TABLE);
    cpu.boot(BOOT, 0);
    const deadline = performance.now() + 60000;
    const word = i => cpu.mem8[4 * i] | cpu.mem8[4 * i + 1] << 8 | cpu.mem8[4 * i + 2] << 16 | cpu.mem8[4 * i + 3] << 24;
    while(word(1) !== 0xD0E)
    {
        assert.ok(performance.now() < deadline, what + ": the program did not finish, PC " + cpu.read_pc());
        cpu.run_cores();
    }
    return word(0);
};

const stats = [];
for(const jit of [false, true])
{
    const emulator = await start(jit);
    const cpu = emulator.v86.cpu;
    const e = cpu.wm.exports;
    const mode = jit ? "page tier" : "interpreter";
    try
    {
        const kind = pa => e.a64_bus_lookup(...split(pa));
        const read = (pa, width) => { const v = e.a64_bus_read(...split(pa), width); assert.equal(e.a64_bus_status(), 0, "read " + pa.toString(16)); return BigInt.asUintN(64, v); };
        const write = (pa, width, value) => assert.equal(e.a64_bus_write(...split(pa), width, BigInt(value)), 0, "write " + pa.toString(16));
        assert.equal(kind(EXT), 4);
        assert.equal(e.a64_bus_lookup_detail(...split(EXT + 5 * 4096 + 12)), 5);
        assert.equal(kind(EXT + EXTENDED), 0, "a hole after extended RAM");
        assert.equal(kind(EXT - 1), 0, "a hole before it");
        assert.equal(cpu.dma_classify(EXT + 4000, 200), -1, "the DMA facade: extended RAM, not one backing");
        assert.equal(cpu.dma_classify(EXT + EXTENDED - 8, 16), -2, "past its end");

        // each width; an 8-byte access across a page
        write(EXT + 0x1001, 1, 0xAB);
        write(EXT + 0x1002, 2, 0xCDEF);
        write(EXT + 0x1004, 4, 0x12345678);
        write(EXT + 0x1FFC, 8, 0x1122334455667788n);
        assert.equal(read(EXT + 0x1000, 8), 0x12345678CDEFAB00n);
        assert.equal(read(EXT + 0x1FFC, 8), 0x1122334455667788n);
        assert.equal(read(EXT + 0x2000, 4), 0x11223344n);

        // a pattern over all of it: 8192 frames' worth through 256 frames
        for(let pa = EXT; pa < EXT + EXTENDED; pa += 512) write(pa, 8, pattern(pa));
        for(let pa = EXT; pa < EXT + EXTENDED; pa += 512) assert.equal(read(pa, 8), pattern(pa), "the pattern at " + pa.toString(16));
        assert.ok(e.a64_ext_stat(3) > EXTENDED / 4096, "frames reused: " + e.a64_ext_stat(3));

        // DMA: a blob across pages, scalars
        const blob = Uint8Array.from({ length: 10000 }, (_, i) => i * 7 + 3);
        cpu.write_blob_physical(blob, EXT + 3 * MiB + 1234);
        assert.deepEqual(cpu.read_blob_physical(EXT + 3 * MiB + 1234, 10000), blob);
        cpu.write32_physical(EXT + 4 * MiB - 2, 0xA1B2C3D4);
        assert.equal(cpu.read32_physical(EXT + 4 * MiB - 2), 0xA1B2C3D4);
        assert.equal(cpu.read16_physical(EXT + 4 * MiB), 0xA1B2);
        assert.equal(read(EXT + 4 * MiB - 2, 4), 0xA1B2C3D4n, "the core sees the DMA write");
        assert.throws(() => cpu.read_blob_physical(EXT + EXTENDED - 4, 8), RangeError);

        // code from extended RAM, rewritten by DMA after its frame went
        cpu.write_blob_physical(code_bytes(LOOP_VALUE), EXT + CODE);
        assert.equal(run_program(cpu, mode), LOOP_VALUE, mode + ": the program at 4 GiB");
        for(let pa = EXT + MiB; pa < EXT + 3 * MiB; pa += 4096) read(pa, 8);
        cpu.write_blob_physical(code_bytes(0x777), EXT + CODE);
        assert.equal(run_program(cpu, mode), 0x777, mode + ": the program after its rewrite");
        const fetched = e.a64_ext_stat(16), compiled = e.a64_ext_stat(17), retired = e.a64_ext_stat(15);
        if(+process.env.A64_VERBOSE) console.log(mode, JSON.stringify(cpu.page_tier_stats()));
        if(jit)
        {
            assert.ok(compiled > 50000, "the page tier ran the loop from extended RAM: " + compiled);
            assert.ok(retired >= 1, "the DMA write retired its code: " + retired);
        }
        else
        {
            assert.ok(fetched > 100000 && compiled === 0, "interpreted from extended RAM: " + [fetched, compiled]);
        }
        stats.push(Array.from({ length: 18 }, (_, i) => e.a64_ext_stat(i)));

        if(jit)
        {
            // a single-buffer snapshot does not hold extended RAM; a stream does
            await assert.rejects(emulator.save_state(), /save_state_stream/);
            const chunks = [];
            await emulator.save_state_stream(chunk => { chunks.push(chunk.slice()); });
            const snapshot = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
            let at = 0;
            for(const chunk of chunks) { snapshot.set(chunk, at); at += chunk.length; }
            const second = await start(true);
            try
            {
                await second.restore_state_stream({ size: snapshot.length, read: async (offset, length) => snapshot.subarray(offset, offset + length) });
                const c = second.v86.cpu;
                assert.deepEqual(c.read_blob_physical(EXT + 3 * MiB + 1234, 10000), blob, "the restored DMA blob");
                for(let pa = EXT + 5 * MiB; pa < EXT + EXTENDED; pa += 512) assert.equal(BigInt.asUintN(64, c.wm.exports.a64_bus_read(...split(pa), 8)), pattern(pa));
                assert.equal(run_program(c, "restored"), 0x777, "the restored program");
                console.log(`PASS snapshot stream: ${(snapshot.length / MiB).toFixed(1)} MiB restored into another machine`);
            }
            finally
            {
                await second.destroy();
            }
            // power-on: extended RAM reads as zero again
            cpu.reboot_internal("power-on");
            assert.equal(read(EXT + 0x1FFC, 8), 0n, "power-on cleared extended RAM");
            assert.equal(read(EXT + 7 * MiB, 8), 0n);
        }
        console.log(`PASS ${mode}: hits ${stats.at(-1)[0]}, loads ${stats.at(-1)[1]}, write-backs ${stats.at(-1)[2]}, ` +
            `evictions ${stats.at(-1)[3]}, code retired by writes ${retired}, instructions fetched ${fetched}, compiled ${compiled}`);
    }
    finally
    {
        await emulator.destroy();
    }
}

// the device tree's second memory range
{
    const tree = virt_tree({ cores: 1, memory_size: 64 * MiB, extended: { base: EXT, size: 6 * 2 ** 30 } });
    const memory = tree.children.filter(n => n.name.startsWith("memory@"));
    assert.deepEqual(memory.map(n => n.name), ["memory@40000000", "memory@100000000"]);
    assert.deepEqual(memory[1].props.find(([name]) => name === "reg")[1], [1, 0, 1, 0x80000000]);
    console.log("PASS the device tree's memory@100000000");
}
console.log("A64_EXTENDED_MEMORY_PASS");
