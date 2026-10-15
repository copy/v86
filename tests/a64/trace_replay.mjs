#!/usr/bin/env node
// The Alpine corpus and trace differential (docs/arm64-virt-android16-plan.md
// P2.10). The plan's qemu-aarch64 (user mode) does not exist on macOS, so
// the reference is qemu-system-aarch64 running the initramfs stage of
// tests/a64/linux_boot.mjs with its workload (A64_WORKLOAD: busybox and musl
// at work, after the probe) under -icount, with the plugin
// tools/a64_qemu/trace_sample.c: it samples instructions run at EL0 (one in
// --period on average, so the sample follows how often each encoding runs),
// with the registers before and after and every memory value read or
// written, and collects the corpus of translated instruction words.
//
// Each sample is replayed on v86's ARM core at EL0: the code page and the
// pages the instruction touched are mapped at their addresses (48-bit VAs,
// 4 KiB pages, tables built here), the values read are in memory, the
// registers are the sample's; after one step the registers (X0-X30, SP, PC,
// NZCV, FPCR, FPSR, TPIDR_EL0, and V0-V31 for the FP/SIMD and branch
// classes) and every byte written must be what the reference had. Left out
// (the state they depend on is not in a sample, or the allowed list covers
// them): store-exclusives (the monitor), reads of the counters and CTR_EL0,
// DC ZVA (QEMU reports no writes for it).
//
// The corpus: every word translated (EL1 too) must decode on v86 as
// llvm-mc decodes it for profile v1 (tests/a64/decode_check.mjs --words).
//
//   node tests/a64/trace_replay.mjs [--samples N] [--period N] [--workload N] [--seed S]
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { root, QEMU_MACHINE, QEMU_CPU, qemu_binary } from "./guest_runner.mjs";
import { STATE_OFFSETS } from "../../src/arm/state_layout.js";

const args = process.argv.slice(2);
const option = (name, value) => { const i = args.indexOf(name); return i < 0 ? value : args[i + 1]; };
const SAMPLES = +option("--samples", 10_000_000);
const PERIOD = +option("--period", 24);
const WORKLOAD = +option("--workload", 40);
const SEED = +option("--seed", 1);

const directory = root + "build/a64-trace/";
fs.mkdirSync(directory, { recursive: true });
function run(program, program_args, options = {})
{
    const result = spawnSync(program, program_args, { encoding: "utf8", ...options });
    assert.equal(result.status, 0, `${program} ${program_args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout.trim();
}

// ---- the plugin and the guest's files
const qemu = qemu_binary();
const qemu_source = root + "build/a64-ref/qemu-9.2.0/";
const plugin = directory + "trace_sample.dylib";
run(process.env.CLANG || "clang", ["-O2", "-fPIC", "-bundle", "-Wl,-undefined,dynamic_lookup", "-Wall",
    ...run("pkg-config", ["--cflags", "glib-2.0"]).split(/\s+/), "-I", qemu_source + "include/qemu",
    "-o", plugin, root + "tools/a64_qemu/trace_sample.c", ...run("pkg-config", ["--libs", "glib-2.0"]).split(/\s+/)]);
run("node", [root + "tests/a64/linux_boot.mjs"], { env: { ...process.env, A64_LINUX_PREPARE_ONLY: "1" } });
const linux = root + "build/a64-linux/";
const fifo = directory + "samples.fifo";
fs.rmSync(fifo, { force: true });
run("mkfifo", [fifo]);
const corpus = directory + "corpus.txt";

const child = spawn(qemu, ["-machine", QEMU_MACHINE, "-cpu", QEMU_CPU, "-m", "512M", "-smp", "1",
    "-global", "virtio-mmio.force-legacy=false", "-display", "none", "-no-reboot", "-monitor", "none",
    "-serial", "file:" + directory + "serial.txt", "-icount", "shift=0,sleep=off",
    "-kernel", linux + "boot/vmlinuz-virt", "-initrd", linux + "probe/initramfs-virt+probe.cpio",
    "-append", `console=ttyAMA0 earlycon nokaslr panic=-1 A64_WORKLOAD=${WORKLOAD} rdinit=/a64-init -- ref=qemu`,
    "-plugin", `${plugin},out=${fifo},corpus=${corpus},period=${PERIOD},seed=${SEED},limit=${SAMPLES}`],
    { stdio: ["ignore", "inherit", "pipe"] });
let qemu_errors = "";
child.stderr.on("data", data => { qemu_errors += data; });
process.on("exit", () => child.exitCode === null && child.kill("SIGKILL"));
for(const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) process.once(signal, () => process.exit(status));
const exited = new Promise(resolve => child.on("exit", resolve));

// ---- v86's ARM core, as an EL0 harness
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const RAM = 0x40000000, RAM_SIZE = 256 << 20;
const emulator = new V86({ cpu_type: "arm64", graphics_adapter: "none", memory_size: RAM_SIZE, autostart: false, log_level: 0,
    wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm" });
await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
const cpu = emulator.v86.cpu, exports = cpu.wm.exports;
exports["a64_boot"](RAM, 0, 0, 0);
// (guest RAM directly: cpu.mem8 is a checked view; the ARM core's memory does not grow)
const mem8 = new Uint8Array(cpu.wasm_memory.buffer, cpu.mem8.byteOffset, RAM_SIZE);
const ram = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
let state_view, state_bytes;
function attach_state()
{
    state_view = new DataView(cpu.wasm_memory.buffer, cpu.state_base, 4096);
    state_bytes = new Uint8Array(cpu.wasm_memory.buffer, cpu.state_base, 4096);
}
attach_state();
const set64 = (offset, value) => state_view.setBigUint64(offset, value, true);
// (the bytes a sample's stores wrote: their physical addresses and values)
const write_pa = new Float64Array(4096), write_value = new Uint8Array(4096);

// the regime: Linux's for EL0 (TBI0, 16-bit ASIDs, 4 KiB pages, 48-bit VAs; UCT, DZE, UCI, nTWI, nTWE, SA0)
const SCTLR = 0x00C50838n | 1n | 1n << 2n | 1n << 12n | 1n << 4n | 1n << 3n | 1n << 15n | 1n << 14n | 1n << 26n | 1n << 16n | 1n << 18n;
const TCR = 16n | 1n << 8n | 1n << 10n | 3n << 12n | 16n << 16n | 1n << 23n | 2n << 32n | 1n << 36n | 1n << 37n;
// pages for tables and for the guest's pages (the first 1 MiB of RAM holds nothing)
const POOL = RAM + 0x100000, POOL_PAGES = (RAM_SIZE - 0x100000) / 4096;
let next_page, root_table;
const mapped = new Map();
function allocate()
{
    const pa = POOL + 4096 * next_page++;
    mem8.fill(0, pa - RAM, pa - RAM + 4096);
    return pa;
}
function reset_tables()
{
    next_page = 0;
    mapped.clear();
    root_table = allocate();
    set64(STATE_OFFSETS.ttbr0_el1, BigInt(root_table));
    exports["a64_restored"](); // (the TLBs flushed)
}
/** The physical address of VA page `page` (va >> 12), mapped now if it was not */
function page_pa(page)
{
    let pa = mapped.get(page);
    if(pa !== undefined) return pa;
    assert.ok(next_page + 4 <= POOL_PAGES, "the page pool");
    let table = root_table;
    for(let level = 0; level < 3; level++)
    {
        const index = Math.floor(page / 2 ** (27 - 9 * level)) % 512;
        const at = table - RAM + 8 * index;
        let entry = ram.getBigUint64(at, true);
        if(!(entry & 1n))
        {
            entry = BigInt(allocate()) | 3n;
            ram.setBigUint64(at, entry, true);
        }
        table = Number(entry & 0xFFFFFFFFF000n);
    }
    pa = allocate();
    // a page: AttrIndx 0 (normal), EL0 and EL1 read/write, inner shareable, AF
    ram.setBigUint64(table - RAM + 8 * (page & 511), BigInt(pa) | 3n | 1n << 6n | 3n << 8n | 1n << 10n, true);
    mapped.set(page, pa);
    return pa;
}
function setup_regime()
{
    set64(STATE_OFFSETS.sctlr_el1, SCTLR);
    set64(STATE_OFFSETS.tcr_el1, TCR);
    set64(STATE_OFFSETS.mair_el1, 0xFFn);
    set64(STATE_OFFSETS.cpacr_el1, 3n << 20n);
    set64(STATE_OFFSETS.cntkctl_el1, 2n);
    set64(STATE_OFFSETS.vbar_el1, BigInt(RAM));
    reset_tables();
}
setup_regime();

// ---- the samples
const NAMED = 38, HEADER = 16, REGS = NAMED * 8, VECTORS = 32 * 16, ACCESS = 32;
const R_SP = 31, R_PC = 32, R_CPSR = 33, R_FPSR = 34, R_FPCR = 35, R_TPIDR = 36, R_TPIDRRO = 37;

/** Words whose result depends on state a sample does not carry, or the allowed list */
function left_out(word)
{
    if((word & 0x3FC00000) >>> 0 === 0x08000000) return "store-exclusive"; // STXR, STLXR, STXP, STLXP (o2 0, L 0)
    const mrs = (word & 0xFFF00000) >>> 0 === 0xD5300000 ? (word & 0xFFFE0) >>> 0 : -1;
    if(mrs === 0xBE040 || mrs === 0xBE020 || mrs === 0xBE0C0 || mrs === 0xBE0A0) return "counter"; // CNTVCT, CNTPCT (and the SS forms)
    if(mrs === 0xB0020) return "CTR_EL0";
    if((word & 0xFFFFFFE0) >>> 0 === 0xD50B7420) return "DC ZVA";
    return null;
}

const stats = { samples: 0, replayed: 0, left_out: {}, differences: 0, words: new Set() };
const examples = [];
function difference(word, what)
{
    stats.differences++;
    if(examples.length < 40)
    {
        examples.push(`${(word >>> 0).toString(16).padStart(8, "0")}: ${what}`);
        console.log("DIFF " + examples.at(-1));
    }
}

const hex64 = (bytes, at) => Buffer.from(bytes.subarray(at, at + 8)).reverse().toString("hex").replace(/^0{1,15}/, "");

function replay(buffer, at)
{
    const view = new DataView(buffer.buffer, buffer.byteOffset + at);
    const bytes = buffer.subarray(at);
    const word = view.getUint32(4, true), accesses = view.getUint32(8, true), vectors = view.getUint32(12, true) & 1;
    const block = REGS + (vectors ? VECTORS : 0);
    const before = HEADER, after = HEADER + block, memory = HEADER + 2 * block;
    stats.samples++;
    const excluded = left_out(word);
    if(excluded)
    {
        stats.left_out[excluded] = (stats.left_out[excluded] || 0) + 1;
        return;
    }
    stats.words.add(word);
    if(state_bytes.byteLength === 0) attach_state();
    // (a fresh set of tables when the pool runs low: never within a sample)
    if(next_page + 4 * (2 + 2 * accesses) + 8 > POOL_PAGES) reset_tables();
    // the code page and the instruction
    const pc_low = view.getUint32(before + 8 * R_PC, true), pc_high = view.getUint32(before + 8 * R_PC + 4, true);
    const code = page_pa(pc_high * 0x100000 + (pc_low >>> 12));
    ram.setUint32(code - RAM + (pc_low & 0xFFF), word, true);
    // the memory read (in place before) and written (checked after); TBI: the top byte is no part of the address
    let writes = 0;
    for(let k = 0; k < accesses; k++)
    {
        const a = memory + ACCESS * k;
        const low = view.getUint32(a, true), high = view.getUint32(a + 4, true) & 0xFFFFFF;
        const size = view.getUint32(a + 24, true), store = view.getUint32(a + 28, true);
        for(let b = 0; b < size; b++)
        {
            const offset = low + b; // (no carry out of the low word can matter: accesses stay below 2^32 - 16 of a page)
            const page = (high + (offset >= 0x100000000 ? 1 : 0)) * 0x100000 + ((offset >>> 12) & 0xFFFFF);
            const pa = page_pa(page) + (offset & 0xFFF);
            if(store)
            {
                write_pa[writes] = pa;
                write_value[writes++] = bytes[a + 8 + b];
            }
            else
            {
                mem8[pa - RAM] = bytes[a + 8 + b];
            }
        }
    }
    // the registers: X0-X30 and SP in the record's order are the state block's x[0..31]; V0-V31 likewise
    state_bytes.set(bytes.subarray(before, before + 256), STATE_OFFSETS.x);
    state_bytes.set(bytes.subarray(before + 8 * R_PC, before + 8 * R_PC + 8), STATE_OFFSETS.pc);
    const cpsr = view.getUint32(before + 8 * R_CPSR, true);
    state_view.setUint32(STATE_OFFSETS.nzcv, cpsr & 0xF0000000, true);
    state_view.setUint32(STATE_OFFSETS.pstate, cpsr & 0x3C0, true);
    state_view.setUint32(STATE_OFFSETS.fpcr, view.getUint32(before + 8 * R_FPCR, true), true);
    state_view.setUint32(STATE_OFFSETS.fpsr, view.getUint32(before + 8 * R_FPSR, true), true);
    state_bytes.set(bytes.subarray(before + 8 * R_TPIDR, before + 8 * R_TPIDR + 16), STATE_OFFSETS.tpidr_el0);
    if(vectors) state_bytes.set(bytes.subarray(before + REGS, before + REGS + VECTORS), STATE_OFFSETS.v);
    exports["a64_step"]();
    stats.replayed++;
    if(state_bytes.byteLength === 0) attach_state();
    // the registers after
    const pstate = state_view.getUint32(STATE_OFFSETS.pstate, true);
    if(pstate >> 2 & 3)
    {
        difference(word, `took an exception to EL1: ESR ${hex64(state_bytes, STATE_OFFSETS.esr_el1)}, FAR ${hex64(state_bytes, STATE_OFFSETS.far_el1)}` +
            `, at ${hex64(bytes, before + 8 * R_PC)}`);
        return;
    }
    const same = (offset, record, length) => {
        for(let i = 0; i < length; i++) if(state_bytes[offset + i] !== bytes[record + i]) return false;
        return true;
    };
    let problems = null;
    const problem = text => (problems ||= []).push(text);
    for(let i = 0; i < 32; i++)
    {
        if(!same(STATE_OFFSETS.x + 8 * i, after + 8 * i, 8))
        {
            problem(`${i === 31 ? "sp" : "x" + i} ${hex64(state_bytes, STATE_OFFSETS.x + 8 * i)} want ${hex64(bytes, after + 8 * i)}`);
        }
    }
    if(!same(STATE_OFFSETS.pc, after + 8 * R_PC, 8)) problem(`pc ${hex64(state_bytes, STATE_OFFSETS.pc)} want ${hex64(bytes, after + 8 * R_PC)}`);
    const nzcv = state_view.getUint32(STATE_OFFSETS.nzcv, true) >>> 0, want_nzcv = (view.getUint32(after + 8 * R_CPSR, true) & 0xF0000000) >>> 0;
    if(nzcv !== want_nzcv) problem(`nzcv ${nzcv.toString(16)} want ${want_nzcv.toString(16)}`);
    for(const [name, offset, record] of [["fpcr", STATE_OFFSETS.fpcr, R_FPCR], ["fpsr", STATE_OFFSETS.fpsr, R_FPSR]])
    {
        const have = state_view.getUint32(offset, true) >>> 0, want = view.getUint32(after + 8 * record, true) >>> 0;
        if(have !== want) problem(`${name} ${have.toString(16)} want ${want.toString(16)}`);
    }
    if(!same(STATE_OFFSETS.tpidr_el0, after + 8 * R_TPIDR, 8)) problem(`tpidr_el0 ${hex64(state_bytes, STATE_OFFSETS.tpidr_el0)} want ${hex64(bytes, after + 8 * R_TPIDR)}`);
    if(vectors)
    {
        for(let i = 0; i < 32; i++)
        {
            if(!same(STATE_OFFSETS.v + 16 * i, after + REGS + 16 * i, 16))
            {
                problem(`v${i} ${hex64(state_bytes, STATE_OFFSETS.v + 16 * i + 8)}:${hex64(state_bytes, STATE_OFFSETS.v + 16 * i)} ` +
                    `want ${hex64(bytes, after + REGS + 16 * i + 8)}:${hex64(bytes, after + REGS + 16 * i)}`);
            }
        }
    }
    for(let k = 0; k < writes; k++)
    {
        if(mem8[write_pa[k] - RAM] !== write_value[k]) problem(`byte at pa ${write_pa[k].toString(16)}: ${mem8[write_pa[k] - RAM]} want ${write_value[k]}`);
    }
    if(problems) difference(word, `at ${hex64(bytes, before + 8 * R_PC)}: ` + problems.slice(0, 6).join(", "));
}

// the records from the FIFO, as they come (QEMU waits while this falls behind)
const started = performance.now();
let pending = Buffer.alloc(0), reported = 0;
for await (const chunk of fs.createReadStream(fifo, { highWaterMark: 1 << 22 }))
{
    let buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let at = 0;
    for(;;)
    {
        if(buffer.length - at < HEADER) break;
        assert.equal(buffer.readUInt32LE(at), 0x53343641, "record magic at " + at);
        const vectors = buffer.readUInt32LE(at + 12) & 1;
        const size = HEADER + 2 * (REGS + (vectors ? VECTORS : 0)) + ACCESS * buffer.readUInt32LE(at + 8);
        if(buffer.length - at < size) break;
        replay(buffer, at);
        at += size;
    }
    pending = buffer.subarray(at);
    if(stats.samples - reported >= 1000000)
    {
        reported = stats.samples;
        console.log(`${stats.samples} samples, ${stats.differences} differences, ${((performance.now() - started) / 1000).toFixed(0)} s`);
    }
}
const code = await exited;
await emulator.destroy();
const serial = fs.readFileSync(directory + "serial.txt", "latin1");
assert.ok(/A64_WORKLOAD_END/.test(serial), "the workload ran to its end on the reference");
assert.equal(code, 0, "QEMU: " + qemu_errors);
const summary = qemu_errors.match(/trace_sample: .*/)?.[0] || "";
console.log(`trace replay: ${stats.samples} samples (${stats.replayed} replayed, ${stats.words.size} distinct words; left out ` +
    `${JSON.stringify(stats.left_out)}), ${stats.differences} differences, ${((performance.now() - started) / 1000).toFixed(0)} s; ${summary}`);
assert.ok(stats.samples >= SAMPLES || !SAMPLES, `only ${stats.samples} samples: a larger --workload`);

// ---- the corpus
const check = spawnSync("node", [root + "tests/a64/decode_check.mjs", "--words", corpus], { encoding: "utf8" });
console.log(check.stdout.trim().split("\n").slice(-8).join("\n"));
assert.equal(check.status, 0, "the corpus decodes on v86 as on llvm-mc");
assert.equal(stats.differences, 0, "trace replay differences");
console.log("trace replay: passed");
