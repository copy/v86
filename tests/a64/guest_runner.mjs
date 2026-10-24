// Bare-metal AArch64 guests (docs/arm64-virt-android16-plan.md P0.5): C and
// assembly built with clang --target=aarch64-none-elf and rust-lld against
// tests/a64/baremetal (an arm64 Image at RAM + 0x80000, a small libc with
// glibc's printf), run on the fixed QEMU reference and, from A1, on v86. A
// guest writes its output into the result block (baremetal/include/a64.h);
// the runner polls the block's magic over QMP and reads it with pmemsave.
//
//   build(name, sources, { cflags })  -> the directory of guest.bin
//   reference(directory, { cores })   -> { status, text, serial, ... } from QEMU
//   actual(directory, { cores })      -> the same from v86
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const runtime = root + "tests/a64/baremetal/";

// the fixed reference: QEMU 9.2.0 built from source (P0.11), the virt board
// with every default the plan names spelled out, cortex-a35 without a PMU
export const QEMU_MACHINE = "virt-9.2,gic-version=3,its=off,highmem-ecam=on,highmem-mmio=on,highmem-redists=on," +
    "virtualization=off,secure=off,acpi=off,dtb-randomness=off";
export const QEMU_CPU = "cortex-a35,pmu=off,cntfrq=1000000000";
export function qemu_binary()
{
    const qemu = process.env.A64_QEMU || root + "build/a64-ref/qemu-9.2.0-install/bin/qemu-system-aarch64";
    assert.ok(fs.existsSync(qemu), qemu + " is missing: build QEMU 9.2.0 (docs/arm64-virt-android16-plan.md P0.11)");
    return qemu;
}
export const smp = cores => `${cores},sockets=1,cores=${cores},threads=1`;

// (baremetal/include/a64.h)
export const RESULT = 0x40800000, TEXT = RESULT + 0x1000, TEXT_SIZE = 0x100000 - 0x1000, DONE = 0xA64D0E00;
const STATUS = ["ok", "failed", "unexpected exception", "text overflow"];

const host = spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout.match(/host: (.*)/)[1];
const lld = process.env.LD_LLD || `${spawnSync("rustc", ["--print", "sysroot"], { encoding: "utf8" }).stdout.trim()}/lib/rustlib/${host}/bin/rust-lld`;
const clang = process.env.CLANG || "clang";

function run(program, args)
{
    const result = spawnSync(program, args, { encoding: "utf8" });
    assert.equal(result.status, 0, `${program} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout;
}

/**
 * Build a guest from `sources` (paths, .c or .S) and the runtime into
 * build/a64-<name>/guest.bin (and guest.elf for disassembly)
 */
export function build(name, sources, { cflags = [], optimize = "-O2", general_regs_only = false } = {})
{
    const directory = `${root}build/a64-${name}/`;
    fs.mkdirSync(directory, { recursive: true });
    const common = ["--target=aarch64-none-elf", "-march=armv8-a+crc+crypto", "-ffreestanding", "-fno-builtin",
        "-fno-stack-protector", "-fno-pic", "-mstrict-align", "-nostdlibinc", "-isystem", runtime + "include", "-g"];
    const objects = [];
    const compile = (source, extra) => {
        const object = directory + path.basename(source).replace(/\.[cS]$/, "") + ".o";
        assert.ok(!objects.includes(object), "two sources named like " + source);
        run(clang, [...common, ...extra, "-c", "-o", object, source]);
        objects.push(object);
    };
    compile(runtime + "start.S", []);
    // (general_regs_only: no FP or SIMD register anywhere, for the integer
    // core before P2.5; printf has no %a then)
    const no_fp = general_regs_only ? ["-mgeneral-regs-only", "-DA64_GENERAL_REGS_ONLY"] : [];
    // (A64_MMU=1: the runtime turns the MMU on, an identity map, before main: see runtime.c)
    compile(runtime + "runtime.c", ["-O2", ...no_fp, ...(+process.env.A64_MMU ? ["-DA64_MMU"] : [])]);
    compile(runtime + "exception.c", ["-O2", "-mgeneral-regs-only"]);
    for(const source of sources)
    {
        // (AArch32 code, foo.a32.S: assembled for ARMv8-A AArch32 into a flat
        // binary that the image carries as foo_a32 .. foo_a32_end, page aligned;
        // position independent, with .arm and .thumb as it needs)
        if(source.endsWith(".a32.S"))
        {
            const base = path.basename(source, ".a32.S");
            const object = directory + base + ".a32.o", binary = directory + base + ".a32.bin", wrapper = directory + base + ".a32.wrap.S";
            run(clang, ["--target=armv8a-none-eabi", "-march=armv8-a+crc+crypto", "-mfpu=crypto-neon-fp-armv8", "-c", "-o", object, source]);
            run(lld, ["-flavor", "gnu", "-m", "armelf", "--image-base=0", "-Ttext=0", "--oformat=binary", "-o", binary, object]);
            fs.writeFileSync(wrapper, `    .section .rodata\n    .balign 4096\n    .global ${base}_a32\n${base}_a32:\n    .incbin "${binary}"\n` +
                `    .global ${base}_a32_end\n${base}_a32_end:\n`);
            compile(wrapper, []);
            continue;
        }
        compile(source, [optimize, ...no_fp, ...cflags]);
    }
    const link = ["-flavor", "gnu", "-m", "aarch64elf", "-static", "-T", runtime + "link.ld", ...objects];
    run(lld, [...link, "-o", directory + "guest.elf"]);
    run(lld, [...link, "--oformat=binary", "-o", directory + "guest.bin"]);
    const image = fs.readFileSync(directory + "guest.bin");
    assert.equal(image.readUInt32LE(56), 0x644D5241, "guest.bin: no arm64 Image header");
    return directory;
}

/** The result block and its text */
export function parse(bytes)
{
    const magic = bytes.readUInt32LE(0), status = bytes.readUInt32LE(4), length = bytes.readUInt32LE(8);
    assert.ok(length <= TEXT_SIZE, "result text length " + length);
    const big = at => bytes.readBigUInt64LE(at);
    return {
        done: magic === DONE, status: STATUS[status] || "status " + status, cores: bytes.readUInt32LE(12),
        exception: { vector: big(16), esr: big(24), elr: big(32), far: big(40), spsr: big(48) }, dtb: big(56),
        text: bytes.toString("latin1", TEXT - RESULT, TEXT - RESULT + length),
    };
}

// A test interrupted by a signal skips `finally`; QEMU would outlive it. The
// handlers are there only while QEMU runs: Node runs them on the event loop,
// and a test busy in the emulator (a hang included) would never see SIGTERM
// (`timeout` could not stop it)
const references = new Set();
process.on("exit", () => { for(const child of references) child.kill("SIGKILL"); });
const SIGNALS = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]].map(([signal, code]) => [signal, () => process.exit(code)]);
function track(child)
{
    if(!references.size) for(const [signal, handler] of SIGNALS) process.on(signal, handler);
    references.add(child);
    child.on("exit", () => {
        references.delete(child);
        if(!references.size) for(const [signal, handler] of SIGNALS) process.off(signal, handler);
    });
}

/**
 * Run guest.bin on QEMU until its result block is done (or `timeout` ms)
 * and return parse() of the block
 */
export async function reference(directory, { cores = 1, memory = 128, timeout = 60000, extra = [] } = {})
{
    const args = ["-machine", QEMU_MACHINE, "-cpu", QEMU_CPU, "-m", memory + "M", "-smp", smp(cores),
        "-display", "none", "-serial", "file:" + directory + "qemu-serial.txt", "-monitor", "none", "-qmp", "stdio", "-no-reboot", "-no-shutdown",
        "-kernel", directory + "guest.bin", ...extra,
        ...(process.env.A64_QEMU_TRACE ? ["-d", "int,guest_errors", "-D", directory + "qemu.log"] : [])];
    const child = spawn(qemu_binary(), args, { stdio: ["pipe", "pipe", "pipe"] });
    track(child);
    let input = "", error = "", id = 0;
    const pending = new Map();
    child.stderr.on("data", data => error += data);
    const fail_pending = reason => {
        for(const callback of pending.values()) callback({ error: { desc: String(reason) } });
        pending.clear();
    };
    child.on("error", fail_pending);
    child.on("exit", (code, signal) => fail_pending(`QEMU exited (${code}, ${signal}): ${error}`));
    child.stdin.on("error", fail_pending);
    child.stdout.on("data", data => {
        input += data;
        while(input.includes("\n"))
        {
            const end = input.indexOf("\n"), line = input.slice(0, end);
            input = input.slice(end + 1);
            let message;
            try { message = JSON.parse(line); } catch{ continue; }
            if(message.id !== undefined)
            {
                const callback = pending.get(message.id);
                pending.delete(message.id);
                callback?.(message);
            }
        }
    });
    const request = (execute, args = {}) => new Promise((resolve, reject) => {
        const n = id++;
        const timer = setTimeout(() => {
            pending.delete(n);
            reject(new Error(`QEMU monitor timeout for ${execute}: ${error}`));
        }, 20000);
        pending.set(n, message => {
            clearTimeout(timer);
            if(message.error) reject(new Error(JSON.stringify(message.error)));
            else resolve(message.return);
        });
        child.stdin.write(JSON.stringify({ execute, arguments: args, id: n }) + "\n");
    });
    const hmp = command => request("human-monitor-command", { "command-line": command });
    const dump = directory + "qemu.bin";
    try
    {
        await request("qmp_capabilities");
        const deadline = performance.now() + timeout;
        let seen = false;
        while(performance.now() < deadline)
        {
            if((await hmp(`xp /1wx ${RESULT}`)).includes(DONE.toString(16))) { seen = true; break; }
            await delay(20);
        }
        await request("stop");
        await hmp(`pmemsave ${RESULT} ${TEXT - RESULT + TEXT_SIZE} "${dump}"`);
        if(!seen)
        {
            const registers = await hmp("info registers");
            const result = parse(fs.readFileSync(dump));
            throw new Error(`QEMU guest timed out after ${timeout} ms: ${error}\n${registers}\noutput so far:\n${result.text}`);
        }
        await request("quit");
    }
    // (SIGTERM is only a shutdown request, which -no-shutdown turns into a pause)
    finally { child.kill("SIGKILL"); }
    const result = parse(fs.readFileSync(dump));
    result.serial = fs.existsSync(directory + "qemu-serial.txt") ? fs.readFileSync(directory + "qemu-serial.txt", "latin1") : "";
    return result;
}

/**
 * The A64 page tier for v86 runs (docs/jit-unification-plan.md J2): A64_JIT=1
 * turns it on, with synchronous publication (the runners drive the slices
 * themselves) and the compile threshold A64_JIT_HOT (default 1: code is
 * compiled at its first block boundary, so even code that runs once runs
 * compiled)
 */
export function jit_options()
{
    if(!+process.env.A64_JIT) return {};
    // (A64_JIT_SWITCHES: more switches, "name=value,...")
    const more = Object.fromEntries((process.env.A64_JIT_SWITCHES || "").split(",").filter(Boolean).map(p => [p.split("=")[0], +p.split("=")[1]]));
    return { jit_switches: { a64_page: 1, a64_page_hot: +(process.env.A64_JIT_HOT || 1), ...more }, ir_sync_publication: true };
}

/**
 * The same on v86: the arm64 CPU boots guest.bin as its kernel (an arm64
 * Image at RAM + 0x80000, src/virt/loader.js); the slices run until the
 * result block is done (or `timeout` ms). A64_WASM selects the core
 * (default build/v86-arm64.wasm), TEST_RELEASE_BUILD=1 the compiled library,
 * A64_JIT=1 the page tier (jit_options); `setup(cpu)` runs before the first
 * instruction.
 */
export async function actual(directory, { cores = 1, memory = 128, timeout = 60000, options = {}, setup = null } = {})
{
    const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
    const emulator = new V86({
        cpu_type: "arm64", graphics_adapter: "none", cpu_cores: cores, memory_size: memory << 20, autostart: false, log_level: 0,
        wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm",
        kernel: { url: directory + "guest.bin" },
        ...jit_options(),
        ...options,
    });
    try
    {
        await new Promise((resolve, reject) => {
            emulator.add_listener("emulator-loaded", resolve);
            emulator.add_listener("emulator-error", reject);
        });
        const cpu = emulator.v86.cpu;
        // (setup(cpu): a test's own configuration of the core, e.g. the granules)
        setup?.(cpu);
        let serial = "";
        emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
        const at = RESULT - 0x40000000;
        const block = () => Buffer.from(cpu.mem8.buffer, cpu.mem8.byteOffset + at, TEXT - RESULT + TEXT_SIZE);
        const deadline = performance.now() + timeout;
        while(block().readUInt32LE(0) !== DONE)
        {
            if(performance.now() > deadline)
            {
                const result = parse(Buffer.from(block()));
                throw new Error(`v86 guest timed out after ${timeout} ms at PC ${cpu.read_pc()}: ` +
                    JSON.stringify(cpu.get_diagnostics()) + `\noutput so far:\n${result.text}`);
            }
            cpu.run_cores();
        }
        const result = parse(Buffer.from(block()));
        result.serial = serial;
        // (with A64_JIT=1 on stderr: what the page tier did)
        result.page_tier = cpu.page_tier_stats();
        if(+process.env.A64_JIT) console.error("page tier: " + JSON.stringify(result.page_tier));
        fs.writeFileSync(directory + "v86.bin", Buffer.from(block()));
        return result;
    }
    finally
    {
        await emulator.destroy();
    }
}

/** reference() or actual(), by A64_TARGET=qemu|v86 (default qemu until A1) */
export function target()
{
    const name = process.env.A64_TARGET || "qemu";
    assert.ok(name === "qemu" || name === "v86", "A64_TARGET=" + name);
    return { name, run: name === "qemu" ? reference : actual };
}
