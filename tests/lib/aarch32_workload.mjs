// The 32-bit Arm workload (docs/aarch32-plan.md Q5.1, R5.2): what a Linux
// kernel's 32-bit processes run, the same on a 64-bit kernel's compat tasks
// (tests/a64/linux_boot.mjs, A64_WORKLOAD=aarch32) and on a 32-bit kernel
// (tests/a32/linux_boot.mjs): tests/a64/linux_probe32.c built for A32 and
// for T32, then Alpine's armv7 programs (tools/alpine_repo.mjs --arch armv7
// --set aarch32) in a chroot: BusyBox and musl's dynamic linker, Lua, xz,
// OpenSSL's digests and ciphers (the crypto instructions), SQLite, forks.
// The script prints the outputs between <PREFIX>_WORKLOAD_BEGIN and _END.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { output_directory } from "../../tools/alpine_repo.mjs";
import { ROOT } from "./alpine_image.mjs";

// (inside the chroot every command is its own line, the outputs deterministic:
// no addresses, timings or the MIDR's fields)
export const AARCH32_COMMANDS = [
    "/bin/busybox --install -s",
    "uname -m",
    "lua5.4 -e 'print(string.format(\"%.6f %.3e\", math.sin(1.0) * 1e6, 2^-60)); local t = {} for i = 1, 200000 do t[i] = i * i end print(#t, t[#t])'",
    "seq 1 50000 | xz -6e | md5sum",
    "seq 1 50000 | xz -6 | xz -d | md5sum",
    "seq 1 20000 | openssl dgst -sha256",
    "seq 1 20000 | openssl dgst -sha1",
    "seq 1 20000 | openssl enc -aes-128-cbc -K 000102030405060708090a0b0c0d0e0f -iv 0f0e0d0c0b0a09080706050403020100 | md5sum",
    "seq 1 20000 | openssl enc -aes-256-ctr -K 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f -iv 0f0e0d0c0b0a09080706050403020100 | md5sum",
    "seq 1 20000 | openssl enc -chacha20 -K 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f -iv 0f0e0d0c0b0a09080706050403020100 | md5sum",
    "sqlite3 -list :memory: 'with recursive c(x) as (select 1 union all select x + 1 from c where x < 20000) select count(*), sum(x), total(x * 0.5) from c;'",
    "for i in 1 2 3 4 5 6 7 8; do true & done; wait; echo forks done",
    "grep -m1 Features /proc/cpuinfo",
    // (PER_LINUX32: the 32-bit uname and /proc/cpuinfo)
    "linux32 uname -m",
    "linux32 grep -m1 Features /proc/cpuinfo",
];

/**
 * Stage the workload in `staging` (a directory made anew; a cpio of it goes
 * after an initramfs): /a32 the chroot, /<prefix>-probe32-a32 and -t32 (their
 * objects in `objects`), /<prefix>-aarch32-workload the script. `run` runs
 * a program and fails on its failure, `lld` is rust-lld.
 * @param {{ staging: string, objects: string, run: function(string, !Array<string>): string, lld: string, prefix: string }} options
 */
export async function aarch32_workload({ staging, objects, run, lld, prefix })
{
    const repo = path.join(output_directory("armv7"), "aarch32-repo");
    assert.ok(fs.existsSync(repo), repo + " is missing: node tools/alpine_repo.mjs --arch armv7 --set aarch32");
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging + "a32", { recursive: true });
    for(const section of ["main", "community"])
    {
        const apks = path.join(repo, section, "armv7");
        if(!fs.existsSync(apks)) continue;
        for(const file of fs.readdirSync(apks).filter(f => f.endsWith(".apk")).sort())
        {
            run("bsdtar", ["-xf", path.join(apks, file), "-C", staging + "a32", "--exclude", ".PKGINFO", "--exclude", ".SIGN.*",
                "--exclude", ".*-install", "--exclude", ".*-upgrade", "--exclude", ".*-deinstall", "--exclude", ".trigger"]);
        }
    }
    // (bbsuid is setuid without read permission: the cpio needs to read it)
    run("chmod", ["-R", "u+rw", staging]);
    for(const [isa, flag] of [["a32", "-marm"], ["t32", "-mthumb"]])
    {
        run(process.env.CLANG || "clang", ["--target=armv7a-linux-gnueabihf", "-march=armv8-a", "-mfpu=crypto-neon-fp-armv8", "-mfloat-abi=hard",
            flag, "-O2", "-ffreestanding", "-fno-builtin", "-fno-stack-protector", "-fomit-frame-pointer", "-c",
            ROOT + "tests/a64/linux_probe32.c", "-o", objects + `probe32-${isa}.o`]);
        run(lld, ["-flavor", "gnu", "-m", "armelf_linux_eabi", "-static", "-e", "_start", "-o", staging + `${prefix}-probe32-${isa}`, objects + `probe32-${isa}.o`]);
        fs.chmodSync(staging + `${prefix}-probe32-${isa}`, 0o755);
    }
    const upper = prefix.toUpperCase();
    fs.writeFileSync(staging + `${prefix}-aarch32-workload`, [
        "#!/bin/busybox sh",
        "B=/bin/busybox",
        "$B mkdir -p /a32/proc /a32/dev /a32/tmp; $B mount -t proc proc /a32/proc; $B mount -o bind /dev /a32/dev",
        `$B echo ${upper}_WORKLOAD_BEGIN`,
        `/${prefix}-probe32-a32`,
        `/${prefix}-probe32-t32`,
        ...AARCH32_COMMANDS.map(c => `$B chroot /a32 /bin/busybox sh -c '${c.replace(/'/g, "'\\''")}' 2>&1`),
        `$B echo ${upper}_WORKLOAD_END`,
        ""].join("\n"), { mode: 0o755 });
}
