// Bare-metal AArch32 guests for cpu_type "arm32" (docs/aarch32-plan.md R2,
// R3): C and assembly built with clang --target=armv7a-none-eabi (ARMv8-A's
// AArch32, VFP and Advanced SIMD, hard float) against tests/a32/baremetal
// and the AArch64 guests' libc, a raw image at RAM + 0x10000; run on QEMU
// 9.2 (-cpu cortex-a15, the 32-bit virt board) and on v86. The result block
// is tests/a64/guest_runner.mjs's.
//
//   build32(name, sources, { cflags, thumb }) -> the directory of guest.bin
//   reference32(directory, { cores })         -> { status, text, ... } from QEMU
//   actual32(directory, { cores })            -> the same from v86
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root, reference, actual } from "../a64/guest_runner.mjs";

export { root };
const runtime = root + "tests/a32/baremetal/";
const libc = root + "tests/a64/baremetal/";

// the 32-bit reference: cortex-a15 (its generic timer at the v86 frequency),
// everything below 4 GiB
export const QEMU_MACHINE32 = "virt-9.2,gic-version=3,its=off,highmem=off,virtualization=off,secure=off,acpi=off,dtb-randomness=off";
export const QEMU_CPU32 = "cortex-a15,cntfrq=1000000000";

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
 * Build a guest from `sources` (.c or .S) and the runtime into
 * build/a32-<name>/guest.bin (and guest.elf); `thumb`: the C as T32
 */
export function build32(name, sources, { cflags = [], optimize = "-O2", thumb = false } = {})
{
    const directory = `${root}build/a32-${name}/`;
    fs.mkdirSync(directory, { recursive: true });
    const common = ["--target=armv7a-none-eabihf", "-march=armv8-a+crc", "-mfpu=crypto-neon-fp-armv8", "-mfloat-abi=hard",
        "-ffreestanding", "-fno-builtin", "-fno-stack-protector", "-fno-pic", "-mno-unaligned-access", "-mno-implicit-float", "-nostdlibinc",
        "-isystem", runtime + "include", "-isystem", libc + "include", "-g"];
    const objects = [];
    const compile = (source, extra) => {
        const object = directory + path.basename(source).replace(/\.[cS]$/, "") + ".o";
        assert.ok(!objects.includes(object), "two sources named like " + source);
        run(clang, [...common, ...extra, "-c", "-o", object, source]);
        objects.push(object);
    };
    compile(runtime + "start.S", ["-marm"]);
    compile(runtime + "aeabi.S", ["-marm"]);
    compile(runtime + "runtime.c", ["-O2", "-marm"]);
    compile(libc + "libc.c", ["-O2", "-marm"]);
    for(const source of sources) compile(source, [optimize, thumb ? "-mthumb" : "-marm", ...cflags]);
    const link = ["-flavor", "gnu", "-m", "armelf", "-static", "-T", runtime + "link.ld", ...objects];
    run(lld, [...link, "-o", directory + "guest.elf"]);
    run(lld, [...link, "--oformat=binary", "-o", directory + "guest.bin"]);
    return directory;
}

/** guest.bin on QEMU's cortex-a15 */
export function reference32(directory, options = {})
{
    return reference(directory, { machine: QEMU_MACHINE32, cpu: QEMU_CPU32, ...options });
}

/** guest.bin on v86 with cpu_type "arm32" */
export function actual32(directory, { options = {}, ...rest } = {})
{
    return actual(directory, { ...rest, options: { cpu_type: "arm32", ...options } });
}

/** Both, by A32_TARGET=qemu|v86|both (default both): the outputs must be the same */
export async function compare(directory, options = {})
{
    const which = process.env.A32_TARGET || "both";
    const results = {};
    if(which !== "v86") results.qemu = await reference32(directory, options);
    if(which !== "qemu") results.v86 = await actual32(directory, options);
    return results;
}
