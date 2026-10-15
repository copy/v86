// Bare-metal AArch64 guests (docs/arm64-virt-android16-plan.md P0.5): C and
// assembly built with clang --target=aarch64-none-elf and rust-lld against
// tests/a64/baremetal (an arm64 Image at RAM + 0x80000, a small libc with
// glibc's printf), run on the fixed QEMU reference and, from A1, on v86. A
// guest writes its output into the result block (baremetal/include/a64.h);
// the runner polls the block's magic over QMP and reads it with pmemsave.
//
//   build(name, sources, { cflags })  -> the directory of guest.bin
//   reference(directory, { cores })   -> { status, text, ... } from QEMU
//   actual(directory, { cores })      -> the same from v86 (A1)
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
export function build(name, sources, { cflags = [], optimize = "-O2" } = {})
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
    compile(runtime + "runtime.c", ["-O2"]);
    compile(runtime + "exception.c", ["-O2", "-mgeneral-regs-only"]);
    for(const source of sources) compile(source, [optimize, ...cflags]);
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

// A test interrupted by a signal skips `finally`; QEMU would outlive it.
const references = new Set();
process.on("exit", () => { for(const child of references) child.kill("SIGKILL"); });
for(const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]])
{
    process.once(signal, () => process.exit(code));
}

/**
 * Run guest.bin on QEMU until its result block is done (or `timeout` ms)
 * and return parse() of the block
 */
export async function reference(directory, { cores = 1, memory = 128, timeout = 60000, extra = [] } = {})
{
    const args = ["-machine", QEMU_MACHINE, "-cpu", QEMU_CPU, "-m", memory + "M", "-smp", smp(cores),
        "-display", "none", "-serial", "none", "-monitor", "none", "-qmp", "stdio", "-no-reboot", "-no-shutdown",
        "-kernel", directory + "guest.bin", ...extra,
        ...(process.env.A64_QEMU_TRACE ? ["-d", "int,guest_errors", "-D", directory + "qemu.log"] : [])];
    const child = spawn(qemu_binary(), args, { stdio: ["pipe", "pipe", "pipe"] });
    references.add(child);
    child.on("exit", () => references.delete(child));
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
    return parse(fs.readFileSync(dump));
}

/** The same on v86: the ARM core and its loader arrive with A1 (P1.3) */
export async function actual(directory, options = {})
{
    void directory;
    void options;
    throw new Error("tests/a64/guest_runner.mjs: v86 runs need the ARM core (docs/arm64-virt-android16-plan.md A1)");
}

/** reference() or actual(), by A64_TARGET=qemu|v86 (default qemu until A1) */
export function target()
{
    const name = process.env.A64_TARGET || "qemu";
    assert.ok(name === "qemu" || name === "v86", "A64_TARGET=" + name);
    return { name, run: name === "qemu" ? reference : actual };
}
