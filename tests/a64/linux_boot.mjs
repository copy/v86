#!/usr/bin/env node
// Unmodified Alpine Linux 3.24.0 aarch64 (docs/arm64-virt-android16-plan.md
// P0.1, P0.2; the v86 runs from A2): the pinned virt ISO's EFI zboot kernel
// and initramfs, and the aarch64 probe (tests/a64/linux_probe.c) built with
// clang and rust-lld as a static ELF, delivered two ways:
//
// - stage "initramfs" (A64_STAGE, the default): the initrd is
//   initramfs-virt followed by a newc cpio with /a64-init and /a64-probe
//   (Linux takes concatenated cpio archives), rdinit=/a64-init mounts proc,
//   sys, devtmpfs and a tmpfs with Alpine's busybox, runs the probe with
//   "nodisk", lists /proc/interrupts and powers off. No virtio.
// - stage "single": initramfs-virt alone and Alpine's own init with
//   "single" (and a root that does not exist): it says "Entering single
//   mode" and opens a shell, which lists /proc/interrupts, echoes
//   A64_SINGLE_OK and powers off.
// - stage "lifecycle" (v86, P4.8): single mode to its shell, a snapshot
//   saved there and restored into a new machine where the shell goes on,
//   "reboot -f" (PSCI SYSTEM_RESET) back to single mode, "poweroff -f"
//   (SYSTEM_OFF) stopping the emulator.
// - stage "live": the ISO as a read-only virtio-blk disk, the probe in a
//   ustar image on a second virtio-blk disk with serial a64probe; Alpine's
//   initramfs finds the modloop and the packages on the ISO and boots to
//   "localhost login:", where the probe runs from the disk it reads.
//   A64_TRANSPORT=pci: the same devices as virtio-pci functions on the PCIe
//   host instead of virtio-mmio (P5.7; the reference's are non-transitional,
//   without MSI-X or an option ROM); both machines list their PCI functions
//   (A64_PCI: IDs, class, subsystem, pin and each BAR's place, size and
//   flags from /sys), which must be the reference's, for either transport.
//   The live stage has a virtio keyboard and tablet too (P5.8): on v86 the
//   test injects keys, a pointer position and a click, which the guest reads
//   from /dev/input/event* (dd and hexdump: struct input_event).
//   A64_LINUX_SLEEP=N (v86, the live stage; P8.1): after the probe, N
//   cycles of suspend to idle (s2idle) woken by the PL031's alarm, then N of
//   hibernation onto a swap disk (serial a64swap): the kernel powers off
//   (PSCI SYSTEM_OFF), the machine is powered on (V86.power_button: RAM
//   cleared) with resume=UUID=<the swap's> and the shell goes on in the
//   restored kernel; a tmpfs file's MD5 and the online CPUs are checked
//   after every cycle.
//   A64_LIVE_QCOW2=1 (v86, the live stage): the ISO's disk is a compressed
//   QCOW2 image of it (qemu-img convert -c, build/a64-linux/live-iso.qcow2),
//   read by the disk image layer (docs/disk-image-formats-plan.md).
//
// A64_KERNEL selects v86's kernel: 16k, 64k and androidish are
// tools/a64_kernel.mjs's (P8.6, P9.1, P9.2); gki is Android 16's GKI kernel
// from tools/a64_android.mjs (P10.6's bridge, on the reference too): the
// initramfs stage with the vendor ramdisk's virtual-device modules loaded
// before the probe, the virtio drivers they register checked against the
// reference's.
//
// A64_LINUX_QEMU=1 runs the fixed reference (QEMU 9.2.0 built from source,
// build/a64-ref or A64_QEMU, virt-9.2 with cortex-a35 and every default the
// plan names spelled out) and passes ref=qemu to the probe; A64_CORES (1, 2,
// 4), A64_LINUX_TIMEOUT (ms, 180000); A64_QEMU_PLUGINS=1 adds QEMU's insn and
// howvec plugins (the guest's instruction count and classes, P0.9).
// A64_LINUX_PREPARE_ONLY=1 only prepares
// the files and the manifest (build/a64-linux/manifest.json): the ISO, the
// kernel, the Image inside it, the initramfs, the probe and, after a QEMU
// run, the reference DTB (dumpdtb) and QEMU's version.
//
// The measurements (P0.9), in build/a64-linux/result-<tag>.json:
// boot_to_login_ms, from the start until "localhost login:" on the serial
// console (live stage); probe_done_ms, until the probe's A64_PROBE_XC line;
// with the plugins, the guest's retired instructions and their classes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { gunzipSync as gunzip } from "node:zlib";
import { prepare, unzboot, sha256, ROOT } from "../lib/alpine_image.mjs";
import { QEMU_MACHINE, QEMU_CPU, qemu_binary, smp } from "./guest_runner.mjs";
import { aarch32_workload as stage_aarch32_workload } from "../lib/aarch32_workload.mjs";

const stage = process.env.A64_STAGE || "initramfs";
assert.ok(["initramfs", "single", "lifecycle", "live"].includes(stage), "A64_STAGE is initramfs, single, lifecycle or live");
const sleep_cycles = Number(process.env.A64_LINUX_SLEEP || 0);
assert.ok(!sleep_cycles || (process.env.A64_STAGE === "live" && !+process.env.A64_LINUX_QEMU), "A64_LINUX_SLEEP is a variant of v86's live stage");
const transport = process.env.A64_TRANSPORT || "mmio";
assert.ok(["mmio", "pci"].includes(transport), "A64_TRANSPORT is mmio or pci");
assert.ok(transport === "mmio" || stage === "live", "A64_TRANSPORT=pci is a variant of the live stage");
const cores = Number(process.env.A64_CORES || 1);
assert.ok([1, 2, 4, 8].includes(cores), "A64_CORES is 1, 2, 4 or 8");
const qemu_reference = !!+process.env.A64_LINUX_QEMU;
const config_name = "boot/config-6.18.35-0-virt";
const prepared = await prepare("aarch64-virt", ["boot/vmlinuz-virt", "boot/initramfs-virt", "boot/modloop-virt", config_name]);
const directory = prepared.directory;

function run(program, args, options = {})
{
    const result = spawnSync(program, args, { encoding: "utf8", ...options });
    assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr || result.error}`);
    return result.stdout.trim();
}

// the Image inside the zboot kernel (what QEMU's -kernel and v86's loader boot)
const image = unzboot(fs.readFileSync(prepared.kernel));

// the probe: clang for aarch64-unknown-linux-gnu, freestanding, rust-lld
const host = run("rustc", ["-vV"]).match(/host: (.+)/)[1];
const lld = process.env.LD_LLD || `${run("rustc", ["--print", "sysroot"])}/lib/rustlib/${host}/bin/rust-lld`;
const probe_directory = directory + "probe/";
fs.mkdirSync(probe_directory + "root", { recursive: true });
run(process.env.CLANG || "clang", ["--target=aarch64-unknown-linux-gnu", "-O2", "-ffreestanding", "-fno-stack-protector",
    "-fno-pic", "-fno-builtin", "-c", ROOT + "tests/a64/linux_probe.c", "-o", probe_directory + "probe.o"]);
run(lld, ["-flavor", "gnu", "-m", "aarch64linux", "-static", "-e", "_start", "-o", probe_directory + "root/a64-probe", probe_directory + "probe.o"]);
fs.chmodSync(probe_directory + "root/a64-probe", 0o755);
// (rdinit: Alpine's initramfs has busybox but no applet links yet; the
// kernel passes what follows "--" on its command line to init)
fs.writeFileSync(probe_directory + "root/a64-init", [
    "#!/bin/busybox sh",
    "B=/bin/busybox",
    "$B mount -t proc proc /proc; $B mount -t sysfs sys /sys; $B mount -t devtmpfs dev /dev",
    "$B mkdir -p /tmp; $B mount -t tmpfs tmp /tmp",
    // (the androidish kernel's cpio, P9.1, P9.2: its tests before and after the probe)
    "[ -x /a64-android/pre ] && /a64-android/pre",
    "/a64-probe nodisk \"$@\"",
    "[ -x /a64-android/post ] && /a64-android/post",
    // (smpN: N copies of the workload at once, between two readings of the uptime: P8.2's speed-up)
    "case \"$A64_WORKLOAD\" in '') ;; jit) /a64-jit-workload ;; aarch32) /a64-aarch32-workload ;; " +
        "smp*) $B echo A64_SMP_START $($B cat /proc/uptime); for i in $($B seq 1 ${A64_WORKLOAD#smp}); do /a64-workload 3 > /dev/null & done; wait; " +
        "$B echo A64_SMP_END $($B cat /proc/uptime) ;; " +
        // (soakN, P8.4: N minutes of rounds of four workloads at once and the probe; a failing probe's output shows)
        "soak*) E=$(( $($B cut -d. -f1 /proc/uptime) + ${A64_WORKLOAD#soak} * 60 )); R=0; " +
        "while [ $($B cut -d. -f1 /proc/uptime) -lt $E ]; do for i in 1 2 3 4; do /a64-workload 1 > /dev/null & done; " +
        "/a64-probe nodisk \"$@\" > /tmp/soak.out 2>&1 || $B cat /tmp/soak.out; wait; R=$((R+1)); done; " +
        "$B echo A64_SOAK_DONE rounds=$R ;; *) /a64-workload \"$A64_WORKLOAD\" ;; esac",
    "$B cat /proc/interrupts",
    "for f in /sys/devices/system/cpu/vulnerabilities/*; do $B echo \"A64_VULN ${f##*/}: $($B cat $f)\"; done",
    "$B echo A64_INIT_DONE",
    "$B poweroff -f",
    ""].join("\n"), { mode: 0o755 });
// (A64_WORKLOAD=N on the command line: busybox and musl at work, N times
// over, between A64_WORKLOAD_BEGIN and A64_WORKLOAD_END: floating point in
// awk and printf, hashing, compression, sorting, sed; the output must equal
// the reference's, P2b, and tests/a64/trace_replay.mjs samples it, P2.10)
fs.writeFileSync(probe_directory + "root/a64-workload", [
    "#!/bin/busybox sh",
    "B=/bin/busybox",
    "N=${1:-1}",
    "$B echo A64_WORKLOAD_BEGIN",
    "$B awk -v n=$((N*20000)) 'BEGIN { s = 0; for (i = 1; i <= n; i++) s += sin(i) * sqrt(i) / (1 + log(i)); " +
        "printf \"awk-math %.12g %.6e %.9f %.15g\\n\", s, exp(10.5), atan2(1, 1) * 4, cos(0.5) ^ 3.5 }'",
    "$B awk -v n=$((N*5000)) 'BEGIN { for (i = 0; i < n; i++) { x = i * 0.1; s += x * x - int(x) / 3; t = t (i % 10) } " +
        "printf \"awk-loop %.10f %d %s %d\\n\", s, length(t), substr(t, 1, 20), index(t, \"789012\") }'",
    "$B seq 1 $((N*20000)) | $B sha256sum",
    "$B seq 1 $((N*20000)) | $B md5sum",
    "$B seq 1 $((N*5000)) | $B gzip -9 | $B gzip -d | $B sha1sum",
    "$B seq 1 $((N*3000)) | $B sort -rn | $B head -3 | $B tr '\\n' ' '; $B echo",
    "$B seq 1 $((N*2000)) | $B sed -e 's/1/one/g' -e 's/\\([0-9]\\)\\([0-9]\\)/\\2\\1/' | $B md5sum",
    "$B printf '%.6f %e %g %x %o\\n' 3.14159265 1234.5678 0.000012345 3735928559 511",
    "$B echo A64_WORKLOAD_END",
    ""].join("\n"), { mode: 0o755 });
const tar_args = ["--uid", "0", "--gid", "0", "--no-xattrs", "--no-mac-metadata"];
run("bsdtar", ["--format", "newc", ...tar_args, "-cf", probe_directory + "probe.cpio", "-C", probe_directory + "root", "a64-init", "a64-probe", "a64-workload"]);
run("bsdtar", ["--format", "ustar", ...tar_args, "-cf", probe_directory + "probe.tar", "-C", probe_directory + "root", "a64-probe"]);
const initrd_probe = probe_directory + "initramfs-virt+probe.cpio";
fs.writeFileSync(initrd_probe, Buffer.concat([fs.readFileSync(prepared.initrd), fs.readFileSync(probe_directory + "probe.cpio")]));

const manifest_file = directory + "manifest.json";
const manifest = {
    source: prepared.source, iso: prepared.image.name, iso_sha256: prepared.image.sha256,
    vmlinuz_sha256: sha256(fs.readFileSync(prepared.kernel)), image_sha256: sha256(image), image_bytes: image.length,
    initramfs_sha256: sha256(fs.readFileSync(prepared.initrd)), modloop_sha256: sha256(fs.readFileSync(directory + "boot/modloop-virt")),
    config_sha256: sha256(fs.readFileSync(directory + config_name)),
    probe_sha256: sha256(fs.readFileSync(probe_directory + "root/a64-probe")),
    probe_cpio_sha256: sha256(fs.readFileSync(probe_directory + "probe.cpio")),
    probe_tar_sha256: sha256(fs.readFileSync(probe_directory + "probe.tar")),
    ...(fs.existsSync(manifest_file) ? (({ qemu, dtb_sha256 }) => ({ qemu, dtb_sha256 }))(JSON.parse(fs.readFileSync(manifest_file, "utf8"))) : {}),
};
fs.writeFileSync(manifest_file, JSON.stringify(manifest, null, 2) + "\n");
if(+process.env.A64_LINUX_PREPARE_ONLY) process.exit(0);

// (A64_WORKLOAD=jit: the guest JIT workloads of docs/arm64-virt-android16-plan.md
// P6.7 between A64_WORKLOAD_BEGIN and A64_WORKLOAD_END: V8 in nodejs, HotSpot
// running `java Hello.java`, LuaJIT with -jon and -joff, PCRE2's JIT; sources
// in tests/a64/jit_workload/. Their packages (tools/alpine_repo.mjs --arch
// aarch64 --set jit) are unpacked into one more cpio after the probe's (no
// disk yet: P5), without the JDK's jmods; 1.5 GiB of RAM: the arm64 core takes less than 2 GiB)
const jit_workload = process.env.A64_WORKLOAD === "jit";
const JIT_EXCLUDED = ["openjdk21-jmods", "busybox", "busybox-binsh"];
let initrd = initrd_probe;
if(jit_workload)
{
    const { output_directory } = await import("../../tools/alpine_repo.mjs");
    const repo = path.join(output_directory("aarch64"), "jit-repo");
    assert.ok(fs.existsSync(repo), repo + " is missing: node tools/alpine_repo.mjs --arch aarch64 --set jit");
    const staging = directory + "jit-root/";
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging + "jit", { recursive: true });
    for(const section of ["main", "community"])
    {
        const apks = path.join(repo, section, "aarch64");
        for(const file of fs.readdirSync(apks).filter(f => f.endsWith(".apk")).sort())
        {
            if(JIT_EXCLUDED.some(name => new RegExp(`^${name}-\\d`).test(file))) continue;
            run("bsdtar", ["-xf", path.join(apks, file), "-C", staging, "--exclude", ".PKGINFO", "--exclude", ".SIGN.*",
                "--exclude", ".*-install", "--exclude", ".*-upgrade", "--exclude", ".*-deinstall", "--exclude", ".trigger"]);
        }
    }
    for(const file of fs.readdirSync(ROOT + "tests/a64/jit_workload")) fs.copyFileSync(ROOT + "tests/a64/jit_workload/" + file, staging + "jit/" + file);
    fs.writeFileSync(staging + "a64-jit-workload", [
        "#!/bin/busybox sh",
        "B=/bin/busybox",
        "export PATH=/usr/bin:/usr/sbin:/bin:/sbin HOME=/tmp TMPDIR=/tmp",
        "$B echo A64_WORKLOAD_BEGIN",
        "/usr/bin/node /jit/work.js 2>&1",
        "cd /tmp && /usr/lib/jvm/java-21-openjdk/bin/java -Xmx256m -XX:+UseSerialGC /jit/Hello.java 2>&1",
        "/usr/bin/luajit -jon /jit/work.lua 2>&1",
        "/usr/bin/luajit -joff /jit/work.lua 2>&1",
        "/usr/bin/pcre2test -C jit | $B cat; /usr/bin/pcre2test -jit /jit/pcre2.txt 2>&1 | $B cat",
        "$B echo A64_WORKLOAD_END",
        ""].join("\n"), { mode: 0o755 });
    run("bsdtar", ["--format", "newc", ...tar_args, "-cf", directory + "jit.cpio", "-C", staging, "."]);
    initrd = directory + "initramfs-virt+probe+jit.cpio";
    fs.writeFileSync(initrd, Buffer.concat([fs.readFileSync(initrd_probe), fs.readFileSync(directory + "jit.cpio")]));
}
// (A64_WORKLOAD=aarch32, docs/aarch32-plan.md Q5.1: 32-bit processes on the
// 64-bit kernel, between A64_WORKLOAD_BEGIN and A64_WORKLOAD_END:
// tests/a64/linux_probe32.c built for A32 and for T32, then Alpine's armv7
// programs (tools/alpine_repo.mjs --arch armv7 --set aarch32) in a chroot:
// BusyBox and musl's dynamic linker, Lua, xz, OpenSSL's digests and ciphers
// (the crypto instructions), SQLite, forks; v86 needs profile v3
// (A64_PROFILE=v3), the reference runs them as they are)
const aarch32_workload = process.env.A64_WORKLOAD === "aarch32";
assert.ok(!aarch32_workload || +process.env.A64_LINUX_QEMU || process.env.A64_PROFILE === "v3", "A64_WORKLOAD=aarch32 on v86 needs A64_PROFILE=v3");
if(aarch32_workload)
{
    const staging = directory + "aarch32-root/";
    await stage_aarch32_workload({ staging, objects: directory, run, lld, prefix: "a64" });
    run("bsdtar", ["--format", "newc", ...tar_args, "-cf", directory + "aarch32.cpio", "-C", staging, "."]);
    initrd = directory + "initramfs-virt+probe+aarch32.cpio";
    fs.writeFileSync(initrd, Buffer.concat([fs.readFileSync(initrd_probe), fs.readFileSync(directory + "aarch32.cpio")]));
}
const memory_mb = +process.env.A64_MEMORY_MB || (jit_workload ? 1536 : 512);
// (A64_EXTENDED_MEMORY=<bytes>: v86's extended RAM from 4 GiB, P8.5, the
// RAM below it A64_MEMORY_MB; A64_LINUX_MEMTEST=<MiB>: the initramfs stage's
// probe maps, writes and checks that much first, A64_MEMTEST)
const extended_memory = Number(process.env.A64_EXTENDED_MEMORY || 0);
// (A64_PARALLEL=1: v86's cores 1 and up in vCPU workers, P8.2; the probe's
// exclusive ABA is then only reported, the deviation docs/aarch64.md declares)
const parallel = !!+process.env.A64_PARALLEL;
assert.ok(!parallel || !+process.env.A64_LINUX_QEMU && cores > 1, "A64_PARALLEL is a variant of v86 on more than one core");
// (A64_KERNEL=16k|64k: v86 boots tools/a64_kernel.mjs's kernel of that page
// size, P8.6, the drivers the stages need built in; A64_KERNEL_FILE another
// Image. The probe must report the page size)
// (A64_KERNEL=gki, P10.6's bridge: Android's GKI kernel, tools/a64_android.mjs's,
// on the reference too, in the initramfs stage with the virtual-device modules
// of its vendor ramdisk loaded before the probe)
const kernel_variant = process.env.A64_KERNEL || "stock";
const PAGE_SIZES = { stock: 4096, "16k": 16384, "64k": 65536, androidish: 4096, gki: 4096 };
assert.ok(PAGE_SIZES[kernel_variant], "A64_KERNEL: stock, 16k, 64k, androidish or gki");
const gki = kernel_variant === "gki";
assert.ok(kernel_variant === "stock" || gki || !+process.env.A64_LINUX_QEMU, "A64_KERNEL is a variant of v86's runs (gki: of both)");
assert.ok(!gki || stage === "initramfs", "A64_KERNEL=gki: the initramfs stage");
const GKI_FILES = ROOT + "build/a64-android/out/";
const v86_kernel = process.env.A64_KERNEL_FILE ||
    (kernel_variant === "stock" ? prepared.kernel : gki ? GKI_FILES + "Image" : ROOT + `build/a64-kernel/${kernel_variant}/Image`);
assert.ok(fs.existsSync(v86_kernel), v86_kernel + " is missing: node tools/" + (gki ? "a64_android.mjs" : "a64_kernel.mjs"));
// (A64_KERNEL=androidish, the initramfs stage, P9.1, P9.2: the programs and
// images built with it in one more cpio, under /a64-android with the
// scripts a64-init runs before and after the probe, a bootconfig after the
// initrd, an f2fs disk. Before the probe: f2fs with fscrypt (the first boot
// writes and reboots, the second reads, without the key and with it),
// /proc/bootconfig, the minimal SELinux policy, enforcing from then on.
// After it: binderfs's selftest, binder between the first and the last CPU,
// userfaultfd, erofs on dm-verity (and the same tree over an image with one
// byte changed: reads fail), zram as swap under a 16 MiB memory cgroup with
// PSI's trigger)
const android = kernel_variant === "androidish" && stage === "initramfs";
const ANDROID_FILES = ROOT + "build/a64-kernel/androidish/";
const ANDROID_PROGRAMS = ["binder_pingpong", "binderfs_test", "uffd_test", "selinux_load", "dm_verity", "fscrypt_test", "psi_test"];
const BOOTCONFIG = { "androidboot.hardware": "v86", "androidboot.serialno": "a64-p9", "kernel.printk.devkmsg": "on" };
const VERITY_SALT = Buffer.alloc(32, 0xa6);
let android_expect, f2fs_disk;
/**
 * dm-verity's hash tree, format 1 (the salt before each block), SHA-256,
 * 4 KiB blocks, the top level first (hash_start 0), as veritysetup lays it out
 * @param {!Buffer} data more than one block
 * @return {{tree: !Buffer, root: !Buffer}}
 */
function verity_tree(data)
{
    const BLOCK = 4096, PER_BLOCK = BLOCK / 32;
    assert.ok(data.length > BLOCK && data.length % BLOCK === 0, "verity: whole blocks, more than one");
    const digest = block => create_hash("sha256").update(VERITY_SALT).update(block).digest();
    let digests = [];
    for(let at = 0; at < data.length; at += BLOCK) digests.push(digest(data.subarray(at, at + BLOCK)));
    const levels = [];
    while(digests.length > 1)
    {
        const blocks = [];
        for(let i = 0; i < digests.length; i += PER_BLOCK) blocks.push(Buffer.concat(digests.slice(i, i + PER_BLOCK), BLOCK));
        levels.push(Buffer.concat(blocks));
        digests = blocks.map(digest);
    }
    return { tree: Buffer.concat(levels.reverse()), root: digests[0] };
}
/** The initrd with a bootconfig after it: the text, its NUL, padding to 4 bytes, size, checksum, magic (tools/bootconfig) */
function with_bootconfig(initrd_bytes, keys)
{
    const text = Buffer.from(Object.entries(keys).map(([key, value]) => `${key} = "${value}"\n`).join("") + "\0");
    const pad = (4 - (initrd_bytes.length + text.length + 8 + 12) % 4) % 4;
    const data = Buffer.concat([text, Buffer.alloc(pad)]);
    const footer = Buffer.alloc(8);
    footer.writeUInt32LE(data.length, 0);
    footer.writeUInt32LE(data.reduce((sum, byte) => sum + byte, 0) >>> 0, 4);
    return Buffer.concat([initrd_bytes, data, footer, Buffer.from("#BOOTCONFIG\n")]);
}
if(android)
{
    const staging = directory + "android-root/";
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging + "a64-android", { recursive: true });
    const put = (name, bytes, mode = 0o644) => fs.writeFileSync(staging + "a64-android/" + name, bytes, { mode });
    for(const name of [...ANDROID_PROGRAMS, "policy.33", "erofs.img", "f2fs.img.gz"])
    {
        assert.ok(fs.existsSync(ANDROID_FILES + name), ANDROID_FILES + name + " is missing: node tools/a64_kernel.mjs --variants androidish");
    }
    for(const program of ANDROID_PROGRAMS) put(program, fs.readFileSync(ANDROID_FILES + program), 0o755);
    put("policy.33", fs.readFileSync(ANDROID_FILES + "policy.33"));
    // (erofs, its tree, and a copy with one byte of the payload changed in the middle)
    const erofs = fs.readFileSync(ANDROID_FILES + "erofs.img");
    const { tree, root } = verity_tree(erofs);
    const bad = Buffer.from(erofs);
    const middle = bad.indexOf("\n20000\n");
    assert.ok(middle > 0, "the payload's middle in erofs.img");
    bad[middle + 1] ^= 1;
    put("erofs.img", erofs);
    put("erofs-bad.img", bad);
    put("erofs.hash", tree);
    const table = (data, hash) => `${erofs.length / 512} 1 ${data} ${hash} 4096 4096 ${erofs.length / 4096} 0 sha256 ` +
        `${root.toString("hex")} ${VERITY_SALT.toString("hex")}\n`;
    put("verity-good", table("/dev/loop0", "/dev/loop1"));
    put("verity-bad", table("/dev/loop2", "/dev/loop3"));
    const payload = Array.from({ length: 40000 }, (_, i) => i + 1).join("\n") + "\n";
    android_expect = { payload_sha256: sha256(payload), erofs_sha256: sha256(erofs), bad_block: Math.floor((middle + 1) / 4096) };
    put("pre", [
        "#!/bin/busybox sh",
        "B=/bin/busybox",
        "A=/a64-android",
        "F=; for d in /sys/block/vd*; do [ \"$($B cat $d/serial 2>/dev/null)\" = a64f2fs ] && F=/dev/${d##*/}; done",
        "$B mkdir -p /mnt/f2fs",
        "if $B mount -t f2fs $F /mnt/f2fs; then",
        "    if [ ! -e /mnt/f2fs/enc ] && $A/fscrypt_test setup /mnt/f2fs; then",
        "        $B umount /mnt/f2fs; $B sync; $B echo A64_REBOOTING; $B reboot -f; $B sleep 600",
        "    fi",
        "    $A/fscrypt_test verify /mnt/f2fs; $B umount /mnt/f2fs",
        "else $B echo A64_FSCRYPT_FAIL mount; fi",
        "$B sed 's/^/A64_BOOTCONFIG /' /proc/bootconfig",
        "$B echo \"A64_CMDLINE $($B cat /proc/cmdline)\"",
        "$A/selinux_load $A/policy.33",
        ""].join("\n"), 0o755);
    put("post", [
        "#!/bin/busybox sh",
        "B=/bin/busybox",
        "A=/a64-android",
        "$B mkdir -p /dev/binderfs && $B mount -t binder binder /dev/binderfs && " +
            "$A/binderfs_test 2>&1 | $B grep -E '^(ok|not ok|# Totals|# FAILED|# [a-z_]+: Test|# binderfs_test\\.c:)'",
        "$A/binder_pingpong /dev/binderfs 10000 0 $(( $($B nproc) - 1 ))",
        "$A/uffd_test 64",
        "$B losetup -r /dev/loop0 $A/erofs.img && $B losetup -r /dev/loop1 $A/erofs.hash && " +
            "$B losetup -r /dev/loop2 $A/erofs-bad.img && $B losetup -r /dev/loop3 $A/erofs.hash",
        "G=$($A/dm_verity a64verity $($B cat $A/verity-good)) && $B mkdir -p /mnt/erofs && $B mount -t erofs -o ro $G /mnt/erofs && " +
            "$B echo \"A64_EROFS $G $($B sha256sum < /mnt/erofs/payload.txt | $B cut -d' ' -f1) $($B cat /mnt/erofs/hello.txt) " +
            "$($B dd if=$G bs=4096 2>/dev/null | $B sha256sum | $B cut -d' ' -f1)\"",
        "X=$($A/dm_verity a64verity_bad $($B cat $A/verity-bad)) && " +
            "if $B dd if=$X of=/dev/null bs=4096 2>/dev/null; then $B echo \"A64_VERITY_BAD $X read\"; else $B echo \"A64_VERITY_BAD $X eio\"; fi",
        "$B mount -t cgroup2 cgroup2 /sys/fs/cgroup && $B echo +memory > /sys/fs/cgroup/cgroup.subtree_control && " +
            "$B mkdir /sys/fs/cgroup/a64 && $B echo 16M > /sys/fs/cgroup/a64/memory.max",
        "$B echo 256M > /sys/block/zram0/disksize && $B mkswap /dev/zram0 > /dev/null && $B swapon /dev/zram0",
        "$A/psi_test /sys/fs/cgroup/a64 40",
        "$B echo \"A64_MEMINFO $($B grep MemTotal /proc/meminfo)\"",
        ""].join("\n"), 0o755);
    run("bsdtar", ["--format", "newc", ...tar_args, "-cf", directory + "android.cpio", "-C", staging, "."]);
    const combined = directory + "initramfs-virt+probe+android.cpio";
    fs.writeFileSync(combined, with_bootconfig(Buffer.concat([fs.readFileSync(initrd), fs.readFileSync(directory + "android.cpio")]), BOOTCONFIG));
    initrd = combined;
    // (a fresh copy of the 64 MiB f2fs, made with the encrypt feature, for each run)
    const f2fs = gunzip(fs.readFileSync(ANDROID_FILES + "f2fs.img.gz"));
    f2fs_disk = f2fs.buffer.slice(f2fs.byteOffset, f2fs.byteOffset + f2fs.byteLength);
}
// (A64_KERNEL=gki: the modules in one more cpio, loaded before the probe as
// modprobe would load modules.load's: each one's modules.dep first, with
// their modules.options)
let gki_modules = 0;
if(gki)
{
    const staging = directory + "gki-root/";
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging + "a64-gki", { recursive: true });
    fs.mkdirSync(staging + "a64-android");
    const load = fs.readFileSync(GKI_FILES + "modules/modules.load", "utf8").trim().split("\n");
    const deps = new Map(fs.readFileSync(GKI_FILES + "modules/modules.dep", "utf8").trim().split("\n").map(line => {
        const [name, list] = line.split(":");
        return [path.basename(name), list.trim().split(/\s+/).filter(Boolean).map(d => path.basename(d))];
    }));
    const order = [];
    const visit = name => { if(order.includes(name)) return; for(const d of [...(deps.get(name) || [])].reverse()) visit(d); order.push(name); };
    load.forEach(visit);
    gki_modules = order.length;
    for(const name of [...order, "modules.options"]) fs.copyFileSync(GKI_FILES + "modules/" + name, staging + "a64-gki/" + name);
    fs.writeFileSync(staging + "a64-gki/order", order.join("\n") + "\n");
    fs.writeFileSync(staging + "a64-android/pre", [
        "#!/bin/busybox sh",
        "B=/bin/busybox",
        "N=0",
        "for m in $($B cat /a64-gki/order); do",
        "    O=$($B grep \"^options ${m%.ko} \" /a64-gki/modules.options | $B cut -d' ' -f3-)",
        "    if $B insmod /a64-gki/$m $O; then N=$((N+1)); else $B echo \"A64_GKI_FAIL $m\"; fi",
        "done",
        "$B echo \"A64_GKI_MODULES loaded=$N virtio=$($B ls /sys/bus/virtio/drivers | $B tr '\\n' ,) $($B uname -r)\"",
        ""].join("\n"), { mode: 0o755 });
    run("bsdtar", ["--format", "newc", ...tar_args, "-cf", directory + "gki.cpio", "-C", staging, "."]);
    const combined = directory + "initramfs-virt+probe+gki.cpio";
    fs.writeFileSync(combined, Buffer.concat([fs.readFileSync(initrd), fs.readFileSync(directory + "gki.cpio")]));
    initrd = combined;
}
const PARALLEL_OPTIONS = parallel ? { parallel: true, parallel_wasm_path: process.env.A64_PARALLEL_WASM || ROOT + "build/v86-arm64-parallel.wasm" } : {};
const memtest_mib = Number(process.env.A64_LINUX_MEMTEST || 0);
const EXTENDED_BASE = 0x100000000;
assert.ok(!(extended_memory || memtest_mib) || stage === "initramfs" && !+process.env.A64_LINUX_QEMU,
    "A64_EXTENDED_MEMORY and A64_LINUX_MEMTEST are variants of v86's initramfs stage");
const soak_minutes = /^soak\d+$/.test(process.env.A64_WORKLOAD || "") ? +process.env.A64_WORKLOAD.slice(4) : 0;
const timeout = Number(process.env.A64_LINUX_TIMEOUT || (soak_minutes ? (soak_minutes + 10) * 60000 :
    jit_workload ? 3600000 : aarch32_workload ? 1800000 : stage === "live" ? 1800000 : android ? 900000 : 180000));
// (a root that does not exist: init looks for it, then enters single mode before mounting it)
const SINGLE_CMDLINE = "console=ttyAMA0 earlycon nokaslr panic=-1 single root=/dev/vda";
const SINGLE_COMMANDS = "cat /proc/interrupts; echo A64_SINGLE_$((6*7)) && echo A64_SINGLE_OK; /bin/busybox poweroff -f\n";
// (the live stage: from the ISO on virtio-blk, modloop's modules; logged in
// as root, the probe from the disk whose serial is a64probe)
const LIVE_CMDLINE = "console=ttyAMA0 earlycon nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage";
// (the live stage's devices besides the disks, on both machines in this
// order: virtio-net, virtio-rng, virtio-console; v86 echoes the probe's raw
// frames and lets the test log in on hvc0, then A64_LIVE_PROBED ends the
// first part; QEMU, without a host side for either, goes straight on)
// (the PCI functions, from /sys: vendor, device, class, subsystem, revision, interrupt pin, each BAR's start, end and flags)
const PCI_LIST = "for d in /sys/bus/pci/devices/*; do echo A64_PCI ${d##*/} $(cat $d/vendor $d/device $d/class $d/subsystem_vendor " +
    "$d/subsystem_device $d/revision) pin=$(od -An -tu1 -j61 -N1 $d/config | tr -d ' ') $(awk 'NR <= 7 && $1 != \"0x0000000000000000\" " +
    "{ printf \"bar%d=%s-%s/%s \", NR - 1, $1, $2, $3 }' $d/resource); done; ";
const pci_functions = text => [...text.matchAll(/^A64_PCI ([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.\d [^\r\n]*)/gm)].map(m => m[1].trim());
const LIVE_COMMANDS = ref => PCI_LIST + "modprobe virtio_net 2>/dev/null; modprobe virtio-rng 2>/dev/null; ifconfig eth0 up; " +
    "for d in /sys/block/vd*; do [ \"$(cat $d/serial 2>/dev/null)\" = a64probe ] && tar -xf /dev/${d##*/} -C /tmp; done; " +
    `/tmp/a64-probe ${ref === "v86" ? "net " : ""}${ref === "v86" && parallel ? "parallel " : ""}ref=${ref}; echo A64_HWRNG=$(head -c 64 /dev/hwrng | wc -c); ` +
    "cat /proc/cpuinfo | head -12; cat /proc/interrupts; " +
    "for f in /sys/devices/system/cpu/vulnerabilities/*; do echo \"A64_VULN ${f##*/}: $(cat $f)\"; done; " +
    (ref === "v86" ? INPUT_COMMANDS + VPORT_COMMANDS + "(/sbin/getty -L hvc0 115200 vt100 &); echo A64_LIVE_PROBED\n" : "echo A64_LIVE_DONE; poweroff -f\n");
// (P9.1: virtio-console's ports 1-3, generic ports named org.v86.port<N>,
// found under /sys/class/virtio-ports, whose device numbers follow the
// enumeration: a line to each, which the host echoes)
const VPORT_COMMANDS = "for d in /sys/class/virtio-ports/vport*; do n=$(cat $d/name 2>/dev/null); case \"$n\" in org.v86.port*) " +
    "exec 3<>/dev/${d##*/}; echo \"VPING_${n#org.v86.port}\" >&3; read -t 5 r <&3; echo \"A64_VPORT $n ${d##*/} $r\"; exec 3<&-;; esac; done; ";
const LIVE_FINISH = "echo A64_LIVE_DONE; poweroff -f\n";
// (virtio-input, P5.8: each device's events as hex, 24 bytes each, while the test injects them after A64_INPUT_READY)
const input_reader = (name, count, tag) => `(dd if=/dev/input/$${name} bs=24 count=${count} 2>/dev/null | ` +
    `hexdump -v -e '24/1 "%02x" "\\n"' | sed 's/^/${tag} /') & `;
const INPUT_COMMANDS = "modprobe evdev 2>/dev/null; modprobe virtio_input 2>/dev/null; sleep 1; K=; T=; " +
    "for e in /sys/class/input/event*; do case \"$(cat $e/device/name)\" in *Keyboard) K=${e##*/};; *Tablet) T=${e##*/};; esac; done; " +
    input_reader("K", 8, "A64_EVK") + input_reader("T", 7, "A64_EVT") + "sleep 1; echo A64_INPUT_READY; wait; ";
/** The events (type, code, value) of `tag`'s lines */
const input_events = (text, tag) => [...text.matchAll(new RegExp(`^${tag} ([0-9a-f]{48})`, "gm"))].map(m => {
    const b = Buffer.from(m[1], "hex");
    return [b.readUInt16LE(16), b.readUInt16LE(18), b.readInt32LE(20)];
});
// (A64_KPTI=1: the initramfs stage with kpti=1, KPTI forced on although CSV3 says it is not needed, P3.9)
const kpti = !!+process.env.A64_KPTI;
assert.ok(!kpti || stage === "initramfs", "A64_KPTI is a variant of the initramfs stage");
// (A64_WORKLOAD=N: the initramfs stage runs /a64-workload N after the probe;
// A64_WORKLOAD=jit: the guest JIT workloads, aarch32: 32-bit processes, below)
const workload = ["jit", "aarch32"].includes(process.env.A64_WORKLOAD) ? process.env.A64_WORKLOAD : /^(smp|soak)\d+$/.test(process.env.A64_WORKLOAD || "") ?
    process.env.A64_WORKLOAD : +process.env.A64_WORKLOAD || 0;
assert.ok(!workload || stage === "initramfs", "A64_WORKLOAD is a variant of the initramfs stage");
// (androidish: bootconfig, and pseudo-NMIs, GKI's: interrupts masked by the GIC's priority mask, not PSTATE.I)
const INITRAMFS_CMDLINE = ref => `console=ttyAMA0 earlycon nokaslr panic=-1${kpti ? " kpti=1" : ""}` +
    `${android ? " bootconfig irqchip.gicv3_pseudo_nmi=1" : ""}` +
    `${workload ? " A64_WORKLOAD=" + workload : ""}${ref === "v86" ? V86_WATCHDOG : ""} rdinit=/a64-init -- ref=${ref}${ref === "v86" && parallel ? " parallel" : ""}` +
    `${ref === "v86" && process.env.A64_PROFILE === "v3" ? " aarch32" : ""}` +
    `${memtest_mib ? " memtest=" + memtest_mib : ""}${extended_memory ? " high=" + EXTENDED_BASE / 4096 : ""}`;
// (A64_JIT=1: the v86 runs with the A64 page tier, docs/jit-unification-plan.md J2;
// A64_JIT_HOT its compile threshold)
const jit = !!+process.env.A64_JIT;
// (v86 interpreted on more than one core: the guest's clock is the host's,
// so every core's timer ticks share the one host thread for the whole slow
// boot; the jitter entropy self-test then takes 17-18 s on 4 cores, beyond
// the soft lockup threshold's 20 s whenever the host is busy. 60 s here; a
// core that hangs is still reported, or misses the run's deadline)
const V86_WATCHDOG = !jit && cores > 1 ? " watchdog_thresh=30" : "";
// A64_PROFILE: the CPU profile by its short name (v86-aarch64-v1, -v1.1, v2
// with FEAT_PAN, the default, or v3 with AArch32 at EL0), run as its CPU model
const A64_CPU_PROFILES = { "v1": "generic-arm64-v1", "v1.1": "generic-arm64-v1.1", "v2": "generic-arm64", "v3": "generic-arm64-compat32" };
assert.ok(!process.env.A64_PROFILE || A64_CPU_PROFILES[process.env.A64_PROFILE], "A64_PROFILE is v1, v1.1, v2 or v3");
const PROFILE_OPTIONS = process.env.A64_PROFILE ? { cpu_profile: A64_CPU_PROFILES[process.env.A64_PROFILE] } : {};
const profile_name = process.env.A64_PROFILE || "v2";
const JIT_OPTIONS = jit ? { jit_switches: { a64_page: 1, ...(process.env.A64_JIT_HOT ? { a64_page_hot: +process.env.A64_JIT_HOT } : {}),
    ...(process.env.A64_JIT_SWITCHES ? Object.fromEntries(process.env.A64_JIT_SWITCHES.split(",").map(p => [p.split("=")[0], +p.split("=")[1]])) : {}) } } : {};
const tag_of = target => `${target}${target === "v86" && jit ? "-jit" : ""}-${stage}${transport === "pci" ? "-pci" : ""}` +
    `${kpti ? "-kpti" : ""}${workload ? "-wl" + workload : ""}${target === "v86" && sleep_cycles ? "-sleep" : ""}` +
    `${extended_memory ? "-ext" + Math.round((memory_mb * 1048576 + extended_memory) / 1048576) + "m" : ""}` +
    `${target === "v86" && parallel ? "-par" : ""}${(target === "v86" || gki) && kernel_variant !== "stock" ? "-" + kernel_variant : ""}-${cores}c`;
// (without the kernel's messages, which may land between the workload's lines)
const workload_output = text => text.match(/A64_WORKLOAD_BEGIN\r?\n([\s\S]*?)A64_WORKLOAD_END/)?.[1].replace(/\r/g, "")
    .split("\n").filter(line => !/^\[\s*\d+\.\d+\] /.test(line)).join("\n");
const tag = tag_of(qemu_reference ? "qemu" : "v86");

// The "CPU features: detected" lines may differ from the reference's only
// where the profile's register differences lead (tests/platform/a64-profile.json):
// the reference's 32-bit EL0 and EL1 (no AArch32 in v1); Spectre-v4 and
// Spectre-BHB on v86, whose MIDR is on none of Linux's safe lists (the
// reference's Cortex-A35 is on all of them)
// (profile v3 has AArch32 at EL0: "32-bit EL0 Support" on both)
const FEATURES_ONLY_ON_REFERENCE = profile_name === "v3" ? ["32-bit EL1 Support"] : ["32-bit EL0 Support", "32-bit EL1 Support"];
// (and profile v2's own, which v3 has too, tests/platform/a64-profile.json: the reference has not got them)
const FEATURES_ONLY_ON_V86 = ["Spectre-v4", "Spectre-BHB",
    ...(profile_name === "v2" || profile_name === "v3" ? JSON.parse(fs.readFileSync(ROOT + "tests/platform/a64-profile.json", "utf8")).v2.linux_cpu_features : [])];
const detected = text => [...new Set([...text.matchAll(/CPU features: detected: ([^\r\n]+)/g)].map(m => m[1].trim()))].sort();

/** The probe's lines in `text`, judged against `cores` and the stage */
function check_probe(text, reference)
{
    const fail = text.match(/A64_PROBE_FAIL[^\r\n]*/);
    assert.ok(!fail, fail?.[0]);
    const ok = text.match(/A64_PROBE_OK arch=aarch64 cpus=(\d+) threads=(\d+) counter=(\d+) cpu_checks=([\d,]+) fault=page esr=(\w+) child=7 tlb_stale=(\d+) page_size=(\d+)[^\r\n]* high_pages=(\d+)/);
    assert.ok(ok, "no A64_PROBE_OK line");
    assert.deepEqual(ok.slice(1, 4).map(Number), [cores, cores, cores * 20000], "CPUs, threads and the exclusive counter");
    if(!reference) assert.equal(+ok[7], PAGE_SIZES[kernel_variant], "the kernel's page size (AT_PAGESZ)");
    assert.equal(ok[4], Array.from({ length: cores }, (_, i) => i).join(","), "each thread on its CPU");
    assert.equal(+ok[6], 0, "no stale TLB entry after the remap");
    const xc = text.match(/A64_PROBE_XC arch=aarch64 packages=1 cores=(\d+) threads_per_core=1 migrations=(\d+) signals=(\d+) smc_rounds=(\d+) dual_map=(\d+) excl_aba=(\d) futex=(\d+) clocks=1 fp_threads=(\d+) fp_steps=(\d+) fp_bad=(\d+) aarch32=(\w+) direct_io=(\d)/);
    assert.ok(xc, "no A64_PROBE_XC line");
    assert.deepEqual([xc[1], xc[2], xc[3], xc[4], xc[5]].map(Number), [cores, cores * 24, cores * 16, 64, 64], "topology, migrations, signals, cross-modified and dual-mapped code");
    assert.deepEqual([+xc[8], +xc[9], +xc[10]], [2 * cores, 2 * cores * 20, 0], "FPCR, FPSR and V0-V31 across context switches");
    assert.equal(+xc[12], stage === "initramfs" ? 0 : 1, "O_DIRECT read of the probe disk");
    if(!reference && !parallel) assert.equal(xc[6], "1", "exclusive ABA: the store-exclusive fails");
    // (AArch32 at EL0: the reference's, profile v3's; ENOEXEC before it)
    if(!reference) assert.equal(xc[11], profile_name === "v3" ? "ran" : "enoexec", "the AArch32 ELF (profile " + profile_name + ")");
    return { ok: ok[0], xc: xc[0] };
}

/** P10.6: every module of modules.load loaded; the virtio drivers they register */
function check_gki(text)
{
    const m = text.match(/A64_GKI_MODULES loaded=(\d+) virtio=(\S*) (\S+)/);
    assert.ok(m, "no A64_GKI_MODULES line");
    assert.equal(+m[1], gki_modules, "the GKI modules loaded: " + ([...text.matchAll(/A64_GKI_FAIL[^\r\n]*/g)].map(f => f[0]).join(", ") || "-"));
    return { gki_modules: +m[1], virtio_drivers: m[2], kernel_release: m[3] };
}

if(qemu_reference)
{
    const qemu = qemu_binary();
    const version = run(qemu, ["--version"]).split("\n")[0];
    assert.match(version, /QEMU emulator version 9\.2\./, "the fixed reference is QEMU 9.2.x");
    const machine = QEMU_MACHINE;
    // (virtio-mmio, or non-transitional virtio-pci functions without MSI-X)
    // (virtio-input is non-transitional anyway: virtio-*-pci)
    const device = (name, options) => (transport === "pci" ? name + (/keyboard|tablet/.test(name) ? "-pci" : "-pci-non-transitional") +
        ",vectors=0" : name + "-device") + (options ? "," + options : "");
    const base = ["-cpu", QEMU_CPU, "-m", memory_mb + "M", "-smp", smp(cores),
        "-global", "virtio-mmio.force-legacy=false", "-display", "none", "-no-reboot"];
    // the DTB QEMU gives this machine (dumpdtb), once
    const dtb = directory + `qemu-virt-${cores}c.dtb`;
    run(qemu, ["-machine", machine + ",dumpdtb=" + dtb, ...base, "-kernel", prepared.kernel]);
    if(cores === 1) Object.assign(manifest, { qemu: version, dtb_sha256: sha256(fs.readFileSync(dtb)) });
    fs.writeFileSync(manifest_file, JSON.stringify(manifest, null, 2) + "\n");
    const live = stage === "live", single = stage === "single";
    const args = ["-machine", machine, ...base, "-serial", "stdio", "-monitor", "none", "-kernel", gki ? v86_kernel : prepared.kernel,
        "-initrd", live || single ? prepared.initrd : initrd,
        "-append", live ? LIVE_CMDLINE
            : single ? SINGLE_CMDLINE : INITRAMFS_CMDLINE("qemu"),
        ...(live ? ["-drive", `if=none,id=iso,file=${prepared.iso},format=raw,readonly=on`, "-device", device("virtio-blk", "drive=iso"),
            "-drive", `if=none,id=probe,file=${probe_directory}probe.tar,format=raw,snapshot=on`, "-device", device("virtio-blk", "drive=probe,serial=a64probe"),
            // (the same devices as v86's, in its order; their host sides are empty)
            "-netdev", "hubport,id=net0,hubid=0", "-device", device("virtio-net", "netdev=net0" + (transport === "pci" ? ",romfile=" : "")),
            "-device", device("virtio-rng"), "-chardev", "null,id=hvc", "-device", device("virtio-serial"), "-device", "virtconsole,chardev=hvc",
            "-device", device("virtio-keyboard"), "-device", device("virtio-tablet")] : [])];
    const plugins = !!+process.env.A64_QEMU_PLUGINS;
    const plugin_log = directory + `${tag}-plugins.log`;
    if(plugins)
    {
        const qemu_build = path.dirname(qemu) + "/../../qemu-9.2.0/build/";
        const library = name => [".dylib", ".so"].map(suffix => qemu_build + name + suffix).find(file => fs.existsSync(file));
        const insn = library("tests/tcg/plugins/libinsn"), howvec = library("contrib/plugins/libhowvec");
        assert.ok(insn && howvec, "QEMU's insn and howvec plugins are missing: tools/a64_qemu/build.sh");
        // (-icount: the guest's clock follows its instructions, 1 ns each, so
        // the plugins' slowdown does not lengthen time-driven loops)
        args.push("-plugin", insn, "-plugin", howvec, "-d", "plugin", "-D", plugin_log, "-icount", "shift=0,sleep=on");
    }
    const child = spawn(qemu, args, { stdio: ["pipe", "pipe", "pipe"] });
    let transcript = "", logged_in = false, ran = false, login_ms, probe_ms;
    const started = performance.now();
    let timer;
    try
    {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`QEMU ${stage} deadline (${timeout} ms)`)), timeout);
            child.on("error", reject);
            child.on("exit", code => (/A64_INIT_DONE|A64_LIVE_DONE|A64_SINGLE_42\r?\nA64_SINGLE_OK/.test(transcript) ? resolve() : reject(new Error(`QEMU exited ${code}`))));
            const output = bytes => {
                transcript += bytes;
                if(single && /Entering single mode[^\n]*\n/.test(transcript) && !ran)
                {
                    ran = true;
                    child.stdin.write(SINGLE_COMMANDS);
                }
                if(probe_ms === undefined && transcript.includes("A64_PROBE_XC")) probe_ms = Math.round(performance.now() - started);
                if(live && !logged_in && /localhost login: ?$/.test(transcript))
                {
                    login_ms = Math.round(performance.now() - started);
                    logged_in = true;
                    child.stdin.write("root\n");
                }
                if(live && logged_in && !ran && /localhost:~# ?$/.test(transcript))
                {
                    ran = true;
                    child.stdin.write(LIVE_COMMANDS("qemu"));
                }
            };
            child.stdout.on("data", output);
            child.stderr.on("data", output);
        });
    }
    finally
    {
        clearTimeout(timer);
        child.kill();
        fs.writeFileSync(directory + `${tag}.log`, transcript);
    }
    const lines = single ? { single: /A64_SINGLE_42\r?\nA64_SINGLE_OK/.test(transcript) } : check_probe(transcript, true);
    if(gki) Object.assign(lines, check_gki(transcript));
    if(live) assert.match(transcript, /\nA64_HWRNG=64\r?\n/, "64 bytes from /dev/hwrng (virtio-rng)");
    if(live) lines.pci = pci_functions(transcript);
    const result = { tag, ms: Math.round(performance.now() - started), boot_to_login_ms: login_ms, probe_done_ms: probe_ms, ...lines,
        login: live ? /localhost login:/.test(transcript) : undefined };
    if(plugins)
    {
        const log = fs.readFileSync(plugin_log, "utf8");
        result.instructions = Number(log.match(/total insns: (\d+)/)?.[1]);
        result.classes = Object.fromEntries([...log.matchAll(/^Class: (.+?)\s+\((\d+) hits\)/gm)].map(m => [m[1].trim(), +m[2]]));
    }
    fs.writeFileSync(directory + `result-${tag}.json`, JSON.stringify({ ...manifest, ...result }, null, 2) + "\n");
    console.log(JSON.stringify(result));
    console.log(`A64_LINUX_BOOT_OK ${tag}`);
    process.exit(0);
}
// ---- v86 (the ARM core; P4.7): the same kernel, initrd and command line
const v86_options = {
    cpu_type: "arm64", graphics_adapter: "none", cpu_cores: cores, memory_size: 512 << 20, log_level: 0,
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm", ...JIT_OPTIONS, ...PROFILE_OPTIONS, ...PARALLEL_OPTIONS,
};
if(stage === "lifecycle")
{
    const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
    const options = { ...v86_options, kernel: { url: v86_kernel }, initrd: { url: prepared.initrd }, cmdline: SINGLE_CMDLINE + V86_WATCHDOG };
    let transcript = "";
    const started = performance.now();
    const attach = emulator => emulator.add_listener("serial0-output-byte", byte => { transcript += String.fromCharCode(byte); });
    const wait_for = (pattern, what, ms = timeout) => new Promise((resolve, reject) => {
        const t0 = transcript.length;
        const timer = setTimeout(() => reject(new Error(`v86 lifecycle: no ${what} after ${ms} ms:\n${transcript.slice(-1500)}`)), ms);
        const poll = setInterval(() => {
            if(pattern.test(transcript.slice(t0)))
            {
                clearInterval(poll);
                clearTimeout(timer);
                resolve();
            }
        }, 20);
    });
    // (the prompt: "~ # ", then busybox asks the terminal where the cursor is)
    const marks = {};
    const first = new V86({ ...options, autostart: true });
    attach(first);
    await wait_for(/Entering single mode[^\n]*\n[\s\S]*# /, "single mode's prompt");
    marks.single_ms = Math.round(performance.now() - started);
    // (a snapshot at the prompt, restored into a new machine)
    await first.stop();
    const saved = await first.save_state();
    await first.destroy();
    marks.state_bytes = saved.byteLength;
    const second = new V86({ ...options, autostart: false });
    await new Promise(resolve => second.add_listener("emulator-loaded", resolve));
    await second.restore_state(saved);
    attach(second);
    second.run();
    second.serial0_send("echo A64_RESTORED_$((6*7))\n");
    await wait_for(/A64_RESTORED_42/, "the restored shell's answer", 60000);
    marks.restored = true;
    // (PSCI SYSTEM_RESET: the kernel loads again and boots to single mode again)
    second.serial0_send("/bin/busybox reboot -f\n");
    await wait_for(/Entering single mode[^\n]*\n[\s\S]*# /, "single mode after the reboot");
    marks.rebooted = true;
    // (PSCI SYSTEM_OFF: the emulator stops)
    const stopped = new Promise(resolve => second.add_listener("emulator-stopped", resolve));
    second.serial0_send("/bin/busybox poweroff -f\n");
    await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(new Error("no emulator-stopped after poweroff")), 60000))]);
    marks.powered_off = second.v86.cpu.powered_off();
    assert.ok(marks.powered_off, "the machine is off");
    await second.destroy();
    fs.writeFileSync(directory + `${tag}.log`, transcript);
    const result = { tag, ms: Math.round(performance.now() - started), ...marks };
    console.log(JSON.stringify(result));
    console.log(`A64_LINUX_BOOT_OK ${tag}`);
    process.exit(0);
}
const single = stage === "single", live = stage === "live";
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const array_buffer = file => { const b = fs.readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
// (A64_LIVE_QCOW2: the ISO as a compressed QCOW2 image)
const live_qcow2 = live && +process.env.A64_LIVE_QCOW2 ? directory + "live-iso.qcow2" : "";
if(live_qcow2 && !fs.existsSync(live_qcow2))
{
    run(process.env.QEMU_IMG || "qemu-img", ["convert", "-c", "-f", "raw", "-O", "qcow2", prepared.iso, live_qcow2 + ".tmp"]);
    fs.renameSync(live_qcow2 + ".tmp", live_qcow2);
}
const machine_options = {
    cpu_type: "arm64", graphics_adapter: "none", cpu_cores: cores, memory_size: memory_mb * 1048576, log_level: 0,
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm",
    kernel: { url: v86_kernel }, initrd: { url: single || live ? prepared.initrd : initrd },
    cmdline: single ? SINGLE_CMDLINE + V86_WATCHDOG : live ? LIVE_CMDLINE + V86_WATCHDOG : INITRAMFS_CMDLINE("v86"), ...JIT_OPTIONS, ...PROFILE_OPTIONS, ...PARALLEL_OPTIONS,
    ...(extended_memory ? { extended_memory_size: extended_memory } : {}),
    ...(process.env.A64_EXTENDED_CACHE ? { extended_memory_cache: +process.env.A64_EXTENDED_CACHE } : {}),
    ...(android ? { virtio_disks: [{ buffer: f2fs_disk, id: "a64f2fs" }] } : {}),
    // (the live stage's disks and devices, in the reference's -device order: P5.3)
    ...(live ? { virtio_disks: [live_qcow2 ? { buffer: array_buffer(live_qcow2), format: "qcow2", readonly: true } :
        { buffer: array_buffer(prepared.iso), readonly: true },
        { buffer: array_buffer(probe_directory + "probe.tar"), id: "a64probe" },
        // (A64_LINUX_SLEEP: hibernation's swap, after the reference's disks)
        ...(sleep_cycles ? [{ buffer: new ArrayBuffer(512 << 20), id: "a64swap" }] : [])],
        net_device: { type: "virtio" }, virtio_rng: true, virtio_console: true, virtio_input: true, virtio_transport: transport } : {}),
};
let emulator = new V86({ ...machine_options, autostart: true });
// (A64_MIDWAY_SNAPSHOT=1 with A64_WORKLOAD: a snapshot 1.5 s into the
// workload, while its code runs compiled, restored into a new machine that
// finishes it; its output must still be the reference's: P6.5)
const midway = !!+process.env.A64_MIDWAY_SNAPSHOT;
assert.ok(!midway || workload, "A64_MIDWAY_SNAPSHOT needs A64_WORKLOAD");
let snapped = false, snapshot_bytes;
const verbose = !!+process.env.A64_VERBOSE;
let transcript = "", probe_ms, typed = false, logged_in = false, login_ms;
// (the live stage: raw frames of EtherType 88B5 come back with source 02:00:00:00:00:02; hvc0's transcript)
let echoed = 0, hvc = "", hvc_state = 0, injected = false;
// (P5.8: two keys, one of them extended, down and up; a position and a left click)
const INJECTED_KEYS = [[1, 30, 1], [0, 0, 0], [1, 30, 0], [0, 0, 0], [1, 103, 1], [0, 0, 0], [1, 103, 0], [0, 0, 0]];
const INJECTED_TABLET = [[3, 0, 16384], [3, 1, 8192], [0, 0, 0], [1, 272, 1], [0, 0, 0], [1, 272, 0], [0, 0, 0]];
const inject_input = emulator =>
{
    for(const code of [0x1E, 0x9E, 0xE0, 0x48, 0xE0, 0xC8]) emulator.bus.send("keyboard-code", code);
    emulator.bus.send("mouse-absolute", [400, 150, 800, 600]);
    emulator.bus.send("mouse-click", [true, false, false]);
    emulator.bus.send("mouse-click", [false, false, false]);
};
const attach_live = emulator =>
{
    emulator.bus.register("net0-send", packet => {
        if(packet.length < 14 || packet[12] !== 0x88 || packet[13] !== 0xB5 || packet[11] !== 1) return;
        const reply = Uint8Array.from(packet);
        reply.set([2, 0, 0, 0, 0, 2], 6);
        echoed++;
        setTimeout(() => emulator.bus.send("net0-receive", reply), 0);
    });
    // (virtio-console's ports 1-3: the host echoes what the guest writes)
    for(const port of [1, 2, 3])
    {
        emulator.add_listener(`virtio-console${port}-output-bytes`, bytes => {
            const copy = Uint8Array.from(bytes);
            setTimeout(() => emulator.bus.send(`virtio-console${port}-input-bytes`, copy), 0);
        });
    }
    emulator.add_listener("virtio-console0-output-bytes", bytes => {
        hvc += String.fromCharCode(...bytes);
        const send = text => emulator.bus.send("virtio-console0-input-bytes", Uint8Array.from(Buffer.from(text)));
        if(hvc_state === 0 && /login: ?$/.test(hvc)) { hvc_state = 1; send("root\n"); }
        else if(hvc_state === 1 && /# ?$/.test(hvc)) { hvc_state = 2; send("echo A64_HVC_$((6*7)); exit\n"); }
        else if(hvc_state === 2 && /\nA64_HVC_42\r?\n/.test(hvc))
        {
            hvc_state = 3;
            if(sleep_cycles) sleep_and_hibernate(emulator).then(() => emulator.serial0_send(LIVE_FINISH), error => { sleep_error = error; fail_run?.(error); });
            else emulator.serial0_send(LIVE_FINISH);
        }
    });
};
if(live) attach_live(emulator);
// (A64_LINUX_SLEEP: what the cycles found, and a failure of theirs)
const sleep_results = [];
let sleep_error = null;
/** @type {?function(*)} the run's reject, for a failure outside the serial console's bytes */
let fail_run = null;
/** Wait until `pattern` matches the transcript after `from` (the serial console's) */
function serial_wait(pattern, from, what, limit_ms = timeout)
{
    return new Promise((resolve, reject) => {
        const limit = performance.now() + limit_ms;
        const poll = setInterval(() => {
            if(pattern.test(transcript.slice(from))) { clearInterval(poll); resolve(transcript.slice(from)); }
            else if(performance.now() > limit) { clearInterval(poll); reject(new Error("sleep: " + what + "\n" + transcript.slice(-2000))); }
        }, 20);
    });
}
/**
 * P8.1: s2idle woken by the PL031's alarm, then hibernation onto the swap
 * disk, powered on again and resumed, each `sleep_cycles` times
 * @param {!Object} emulator
 */
async function sleep_and_hibernate(emulator)
{
    const run = async (command, marker) => {
        const from = transcript.length;
        emulator.serial0_send(command + "; echo " + marker + "_$((6*7))\n");
        return serial_wait(new RegExp("\n" + marker + "_42\r?\n"), from, command);
    };
    const value = (text, key) => text.match(new RegExp("\n" + key + "=([^\r\n]*)"))?.[1];
    const online = cores === 1 ? "0" : "0-" + (cores - 1);
    const states = await run("echo STATE=$(cat /sys/power/state); echo MEM_SLEEP=$(cat /sys/power/mem_sleep); echo DISK=$(cat /sys/power/disk)", "STATES");
    sleep_results.push({ states: value(states, "STATE"), mem_sleep: value(states, "MEM_SLEEP"), disk: value(states, "DISK") });
    assert.match(value(states, "STATE"), /\bfreeze\b[\s\S]*\bdisk\b/, "s2idle and hibernation: " + value(states, "STATE"));
    await run("dd if=/dev/urandom of=/tmp/sleep.bin bs=1024 count=4096 2>/dev/null; md5sum /tmp/sleep.bin > /tmp/sleep.md5", "PATTERN");
    const check = async what => {
        const text = await run("md5sum -c /tmp/sleep.md5 >/dev/null && echo INTACT=1; echo ONLINE=$(cat /sys/devices/system/cpu/online)", "CHECK");
        assert.equal(value(text, "INTACT"), "1", what + ": the tmpfs file is intact");
        assert.equal(value(text, "ONLINE"), online, what + ": every CPU is online");
    };
    for(let cycle = 1; cycle <= sleep_cycles; cycle++)
    {
        // (the alarm 3 s on: the PL031's interrupt wakes the cores from their WFI)
        const from = transcript.length, started = performance.now();
        emulator.serial0_send("echo 0 > /sys/class/rtc/rtc0/wakealarm; echo +3 > /sys/class/rtc/rtc0/wakealarm; " +
            "echo freeze > /sys/power/state; echo RESUMED_$((" + cycle + "*7))\n");
        await serial_wait(new RegExp("\nRESUMED_" + cycle * 7 + "\r?\n"), from, "s2idle " + cycle);
        await check("s2idle " + cycle);
        sleep_results.push({ s2idle: cycle, ms: Math.round(performance.now() - started) });
    }
    const swap = await run("S=; for d in /sys/block/vd*; do [ \"$(cat $d/serial 2>/dev/null)\" = a64swap ] && S=/dev/${d##*/}; done; " +
        "mkswap $S >/dev/null && swapon $S && echo SWAP_UUID=$(blkid $S | grep -o ' UUID=\"[^\"]*\"' | cut -d'\"' -f2)", "SWAP");
    const uuid = value(swap, "SWAP_UUID");
    assert.ok(uuid && uuid.length >= 32, "the swap's UUID");
    // (the live ISO's init resumes before it looks for the boot media, which
    // loads the disk's driver: the swap's driver loaded first)
    emulator.v86.cpu.boot_files = { ...emulator.v86.cpu.boot_files,
        cmdline: LIVE_CMDLINE.replace("modules=loop,", "modules=virtio_mmio,virtio_blk,loop,") + V86_WATCHDOG + " resume=UUID=" + uuid };
    for(let cycle = 1; cycle <= sleep_cycles; cycle++)
    {
        const marker = 5000 + cycle;
        await run(`echo ${marker} > /tmp/s4-marker`, "MARK");
        const from = transcript.length, started = performance.now();
        emulator.serial0_send("echo disk > /sys/power/state; echo THAWED=$(cat /tmp/s4-marker)\n");
        // (the image written, the kernel powers off: PSCI SYSTEM_OFF)
        await new Promise((resolve, reject) => {
            const limit = performance.now() + timeout;
            const poll = setInterval(() => {
                if(emulator.v86.cpu.powered_off()) { clearInterval(poll); resolve(); }
                else if(performance.now() > limit) { clearInterval(poll); reject(new Error("hibernation: no SYSTEM_OFF\n" + transcript.slice(-2000))); }
            }, 50);
        });
        const off_ms = Math.round(performance.now() - started);
        assert.ok(await emulator.power_button(), "the machine powers on");
        const thawed = await serial_wait(/\nTHAWED=\d+\r?\n/, from, "restore " + cycle);
        assert.equal(value(thawed, "THAWED"), String(marker), "the shell goes on in the restored kernel");
        await check("hibernation " + cycle);
        sleep_results.push({ hibernate: cycle, off_ms, ms: Math.round(performance.now() - started) });
    }
}
// (A64_LINUX_SNAPSHOT=1: the whole machine saved and restored at three of the
// probe's markers, while its threads, signals and the virtio devices' I/O
// are under way: rounds alternate between the chunked V7 stream, written to
// and read back from a file, and the single-buffer V6 format; as
// tests/x64/linux_boot.mjs's X64_LINUX_SNAPSHOT, P5.9)
const SNAPSHOT_MARKERS = ["A64_PROBE_START", "A64_PROBE_OK", "A64_PROBE_XC"];
const snapshots = !!+process.env.A64_LINUX_SNAPSHOT;
const snapshots_taken = [], snapshot_rounds = [];
let snapshot_busy = false;
async function snapshot_round(marker)
{
    snapshot_busy = true;
    await emulator.stop();
    if(snapshots_taken.length % 2)
    {
        const file_name = directory + `snapshot-${tag}.v7`;
        const file = await fs.promises.open(file_name, "w+");
        let bytes = 0, largest = 0, chunks = 0;
        try
        {
            await emulator.save_state_stream(async chunk => {
                await file.write(chunk, 0, chunk.length, bytes);
                bytes += chunk.length; chunks++; largest = Math.max(largest, chunk.length);
            });
            await emulator.restore_state_stream({ size: bytes, read: async (offset, length) => {
                const data = new Uint8Array(length);
                const read = (await file.read(data, 0, length, offset))["bytesRead"];
                return read === length ? data : data.subarray(0, read);
            } });
        }
        finally { await file.close(); fs.rmSync(file_name, { force: true }); }
        assert.ok(largest <= 1 << 20, "V7 chunks are at most 1 MiB");
        snapshot_rounds.push({ marker, format: "V7 stream", bytes, chunks, largest_chunk: largest });
    }
    else
    {
        const state = await emulator.save_state();
        await emulator.restore_state(state);
        snapshot_rounds.push({ marker, format: "V6 buffer", bytes: state.byteLength });
    }
    snapshot_busy = false;
    emulator.run();
}
const started = performance.now();
/** (A64 inspect: where the core is, for a run that does not finish) */
function inspect()
{
    const cpu = emulator.v86?.cpu;
    return JSON.stringify(cpu?.get_diagnostics?.() ?? {}) + "\n--- the serial console's last lines:\n" + transcript.split("\n").slice(-25).join("\n");
}
try
{
    await new Promise((resolve, reject) => {
        fail_run = reject;
        const timer = setTimeout(() => reject(new Error(`v86 ${stage} deadline (${timeout} ms): ${inspect()}`)), timeout);
        const on_byte = byte => {
            const c = String.fromCharCode(byte);
            transcript += c;
            if(verbose) process.stdout.write(c);
            if(midway && !snapped && transcript.includes("A64_WORKLOAD_BEGIN"))
            {
                snapped = true;
                setTimeout(async () => {
                    await emulator.stop();
                    const saved = await emulator.save_state();
                    snapshot_bytes = saved.byteLength;
                    await emulator.destroy();
                    emulator = new V86({ ...machine_options, autostart: false });
                    await new Promise(r => emulator.add_listener("emulator-loaded", r));
                    await emulator.restore_state(saved);
                    emulator.add_listener("serial0-output-byte", on_byte);
                    emulator.run();
                }, 1500);
            }
            if(probe_ms === undefined && transcript.includes("A64_PROBE_XC")) probe_ms = Math.round(performance.now() - started);
            for(const marker of SNAPSHOT_MARKERS)
            {
                // (the probe's line, not the shell echoing the command)
                if(snapshots && !snapshot_busy && !snapshots_taken.includes(marker) && transcript.includes("\n" + marker))
                {
                    snapshots_taken.push(marker);
                    snapshot_round(marker).catch(reject);
                }
            }
            if(single && !typed && /Entering single mode[^\n]*\n/.test(transcript))
            {
                typed = true;
                emulator.serial0_send(SINGLE_COMMANDS);
            }
            if(live && !logged_in && /localhost login: ?$/.test(transcript))
            {
                login_ms = Math.round(performance.now() - started);
                logged_in = true;
                emulator.serial0_send("root\n");
            }
            if(live && logged_in && !typed && /localhost:~# ?$/.test(transcript))
            {
                typed = true;
                emulator.serial0_send(LIVE_COMMANDS("v86"));
            }
            if(live && !injected && /\nA64_INPUT_READY\r?\n/.test(transcript))
            {
                injected = true;
                inject_input(emulator);
            }
            // (a line of its own: the shell echoes the command, which names it too)
            if(sleep_error) { clearTimeout(timer); reject(sleep_error); return; }
            const done = single ? /A64_SINGLE_42\r?\nA64_SINGLE_OK/ : live ? /\nA64_LIVE_DONE\r?\n/ : /A64_INIT_DONE/;
            if(done.test(transcript) || /Kernel panic/.test(transcript) && transcript.endsWith("\n"))
            {
                clearTimeout(timer);
                setTimeout(() => (done.test(transcript) ? resolve() : reject(new Error("kernel panic: " + inspect()))), 200);
            }
        };
        emulator.add_listener("serial0-output-byte", on_byte);
        emulator.add_listener("emulator-error", error => reject(error));
    });
}
finally
{
    fs.writeFileSync(directory + `${tag}.log`, transcript);
}
// (no UNDEF in the kernel, P2.3; no trouble in its log; the timer's and the UART's interrupts counted)
const undefined_instructions = emulator.v86.cpu.undefined_instructions();
const page_tier = jit ? emulator.v86.cpu.page_tier_stats() : undefined;
// (every core's; MIPS over the whole run, P0.9)
const retired_per_core = Array.from({ length: cores }, (_, core) => emulator.v86.cpu.retired_instructions(core));
const retired_instructions = retired_per_core.reduce((sum, n) => sum + n, 0);
// (cores in workers: what each did, src/parallel/machine.js)
const parallel_status = parallel ? emulator.v86.cpu.get_diagnostics().parallel : undefined;
// (extended RAM: its frames' traffic, and the instructions from it, interpreted and compiled)
// (P9.3: TTBR writes and ASID changes, the machine thread's instance's cores)
const mmu_stat = emulator.v86.cpu.wm.exports["a64_mmu_stat"];
const mmu = mmu_stat ? { ttbr_writes: mmu_stat(0), asid_changes: mmu_stat(1) } : undefined;
const ext_stat = field => emulator.v86.cpu.wm.exports["a64_ext_stat"](field);
const extended_stats = extended_memory ? { hits: ext_stat(0), loads: ext_stat(1), write_backs: ext_stat(2), evictions: ext_stat(3),
    code_pages: ext_stat(14), code_writes: ext_stat(15), interpreted: ext_stat(16), compiled: ext_stat(17) } : undefined;
await emulator.destroy();
assert.equal(undefined_instructions.el1, 0, "UNDEF at EL1: " + JSON.stringify(undefined_instructions));
const trouble = transcript.match(/^.*(Oops|BUG:|WARNING:|SError|rcu_.*stall|Internal error|undefined instruction).*$/m);
assert.ok(!trouble, "the kernel reports: " + trouble?.[0]);
// (the UART's interrupts come with input: the single stage types its commands; the
// initramfs stage writes the console by polling, on the reference too)
{
    for(const name of single ? ["arch_timer", "uart-pl011"] : ["arch_timer"])
    {
        const line = transcript.match(new RegExp("^\\s*\\d+:\\s+(\\d+)\\s.*" + name + ".*$", "m"));
        assert.ok(line && +line[1] > 0, name + " interrupts in /proc/interrupts");
    }
}
const lines = single ? { single: /A64_SINGLE_42\r?\nA64_SINGLE_OK/.test(transcript) } : check_probe(transcript, false);
if(extended_memory)
{
    // (the device tree's second memory range, as the kernel took it)
    const end = (EXTENDED_BASE + extended_memory - 1).toString(16).padStart(16, "0");
    assert.match(transcript, new RegExp(`node\\s+0: \\[mem 0x0000000100000000-0x${end}\\]`), "extended RAM in the kernel's memory map");
    extended_stats.share = Math.round((extended_stats.interpreted + extended_stats.compiled) / retired_instructions * 1e4) / 1e4;
    lines.extended = extended_stats;
}
if(android)
{
    // (P9.1: binderfs's selftest and the cross-core binder ping-pong)
    const totals = transcript.match(/# Totals: pass:(\d+) fail:(\d+)/);
    assert.ok(totals && +totals[1] > 0 && +totals[2] === 0, "binderfs's selftest: " + (totals?.[0] || "no totals"));
    const pingpong = transcript.match(/A64_BINDER_OK rounds=(\d+) cpus=(\d+),(\d+)/);
    assert.ok(pingpong && +pingpong[1] === 10000, "binder ping-pong: " + (transcript.match(/A64_BINDER_FAIL[^\r\n]*/)?.[0] || "no result"));
    // (P9.2: userfaultfd)
    const uffd = transcript.match(/A64_UFFD_OK faults=(\d+)/);
    assert.ok(uffd && +uffd[1] === 64, "userfaultfd: " + (transcript.match(/A64_UFFD_FAIL[^\r\n]*/)?.[0] || "no result"));
    lines.binder = { selftest: totals[0], pingpong: pingpong[0] };
    lines.uffd = uffd[0];
    const failure = what => transcript.match(new RegExp(`A64_${what}_FAIL[^\\r\\n]*`))?.[0] || "no result";
    // (P9.2: f2fs with fscrypt, written, one reboot, read without the key and with it)
    const setup = transcript.match(/A64_FSCRYPT_SETUP id=([0-9a-f]{32})/);
    const fscrypt = transcript.match(/A64_FSCRYPT_OK id=([0-9a-f]{32})[^\r\n]*/);
    assert.ok(setup && fscrypt && setup[1] === fscrypt[1], "fscrypt across the reboot: " + failure("FSCRYPT"));
    assert.equal(transcript.split("\nA64_REBOOTING").length - 1, 1, "one reboot (PSCI SYSTEM_RESET) after writing");
    assert.equal(transcript.match(/Booting Linux on physical CPU 0x0+ /g)?.length, 2, "two boots");
    assert.ok(transcript.indexOf("A64_FSCRYPT_OK") > transcript.indexOf("A64_REBOOTING"), "read after the reboot");
    // (bootconfig: /proc/bootconfig, and kernel.* on the command line)
    // (after the keys, as comments, the command line the bootloader gave)
    const bootconfig = [...transcript.matchAll(/^A64_BOOTCONFIG ([^#\r\n][^\r\n]*)/gm)].map(m => m[1]);
    assert.deepEqual(bootconfig, Object.entries(BOOTCONFIG).map(([key, value]) => `${key} = "${value}"`), "/proc/bootconfig");
    assert.match(transcript, /^A64_BOOTCONFIG # [^\r\n]*\bbootconfig\b/m, "/proc/bootconfig's parameters from the bootloader");
    assert.match(transcript, /^A64_CMDLINE printk\.devkmsg=on [^\r\n]*\bbootconfig\b/m, "bootconfig's kernel.* keys first on the command line");
    // (pseudo-NMIs: the GIC's priority masking in use)
    assert.ok(detected(transcript).includes("IRQ priority masking"), "pseudo-NMIs (CPU features: detected: IRQ priority masking)");
    // (SELinux enforcing before the probe)
    const selinux = transcript.match(/A64_SELINUX_OK enforce=1 context=(\S+)[^\r\n]*/);
    assert.ok(selinux, "SELinux: " + failure("SELINUX"));
    assert.equal(selinux[1], "u:r:t", "the processes' context, from the policy's initial SIDs");
    assert.ok(selinux.index < transcript.lastIndexOf("A64_PROBE_OK"), "the probe passed under enforcing");
    // (erofs on dm-verity: the file and the whole device as built; the changed byte's block fails)
    const erofs = transcript.match(/^A64_EROFS (\S+) ([0-9a-f]{64}) A64_EROFS_HELLO ([0-9a-f]{64})/m);
    assert.ok(erofs, "erofs on dm-verity: " + failure("VERITY"));
    assert.deepEqual([erofs[2], erofs[3]], [android_expect.payload_sha256, android_expect.erofs_sha256], "erofs's file and the verity device's bytes");
    const bad = transcript.match(/^A64_VERITY_BAD (\S+) (\w+)/m);
    assert.equal(bad?.[2], "eio", "dm-verity over the changed image: reads fail");
    assert.match(transcript, new RegExp(`data block ${android_expect.bad_block} is corrupted`), "dm-verity names the changed block");
    // (zram and PSI)
    const psi = transcript.match(/A64_PSI_OK events=(\d+)[^\r\n]*/);
    assert.ok(psi && +psi[1] > 0, "PSI's trigger: " + failure("PSI"));
    const swapped = transcript.match(/A64_PSI_CHILD swap=(\d+) zram=(\d+)\s+(\d+)/);
    assert.ok(swapped && +swapped[1] > 0 && +swapped[2] > +swapped[3], "pages in zram, compressed: " + swapped?.[0]);
    const memory_kib = +transcript.match(/A64_MEMINFO MemTotal:\s+(\d+) kB/)?.[1];
    Object.assign(lines, { fscrypt: fscrypt[0], bootconfig: bootconfig.length, selinux: selinux[0], erofs_verity: true, psi: psi[0],
        zram: swapped[0], mem_total_kib: memory_kib });
}
if(gki)
{
    // (the reference's run, A64_LINUX_QEMU=1 A64_KERNEL=gki, gives the expected drivers)
    Object.assign(lines, check_gki(transcript));
    const reference_log = directory + tag_of("qemu") + ".log";
    assert.ok(fs.existsSync(reference_log), "the GKI bridge compares with the reference's run: " + reference_log);
    assert.equal(lines.virtio_drivers, check_gki(fs.readFileSync(reference_log, "latin1")).virtio_drivers, "the virtio drivers, against the reference's");
}
if(/^soak/.test(workload))
{
    const done = transcript.match(/A64_SOAK_DONE rounds=(\d+)/);
    assert.ok(done && +done[1] > 0, "the soak's rounds");
    assert.ok(!/A64_PROBE_FAIL/.test(transcript.slice(transcript.indexOf("A64_PROBE_XC"))), "no probe failed during the soak");
    lines.soak = { minutes: soak_minutes, rounds: +done[1] };
}
if(/^smp/.test(workload))
{
    const start = transcript.match(/A64_SMP_START ([\d.]+)/), end = transcript.match(/A64_SMP_END ([\d.]+)/);
    assert.ok(start && end, "the smp workload's start and end");
    lines.smp = { copies: +workload.slice(3), seconds: Math.round((end[1] - start[1]) * 100) / 100 };
}
if(memtest_mib)
{
    const line = transcript.match(/A64_MEMTEST mib=(\d+) pages=(\d+) errors=(\d+) extended_pages=(\d+) code=(\d) exclusive=(\d) zva=(\d)/);
    assert.ok(line, "the memtest's line");
    assert.equal(+line[3], 0, "memtest contents");
    if(extended_memory)
    {
        assert.ok(+line[4] > +line[2] / 4, "memtest pages in extended RAM: " + line[0]);
        assert.deepEqual(line.slice(5, 8).map(Number), [1, 1, 1], "code, an exclusive counter and DC ZVA in extended RAM: " + line[0]);
    }
    lines.memtest = line[0];
}
if(live)
{
    // (P5.4, P5.5: the frames through virtio-net, /dev/hwrng, a login on hvc0)
    assert.match(transcript, /A64_PROBE_NET arch=aarch64 frames=16/, "raw frames through eth0 (virtio-net) and back");
    assert.equal(echoed, 16, "the host echoed every probe frame");
    assert.match(transcript, /\nA64_HWRNG=64\r?\n/, "64 bytes from /dev/hwrng (virtio-rng)");
    assert.equal(hvc_state, 3, "a login on hvc0 (virtio-console): " + JSON.stringify(hvc.slice(-300)));
    // (P9.1: each of the ports 1-3 echoed its line)
    const vports = [...transcript.matchAll(/^A64_VPORT org\.v86\.port(\d) vport\d+p(\d) VPING_(\d)\r?$/gm)].map(m => m.slice(1).join(""));
    assert.deepEqual(vports.sort(), ["111", "222", "333"], "virtio-console's ports 1-3 echo (/dev/vport<N>p1-p3)");
    // (P5.8: the injected events, as the guest's evdev read them)
    assert.deepEqual(input_events(transcript, "A64_EVK"), INJECTED_KEYS, "the keyboard's events (virtio-input)");
    assert.deepEqual(input_events(transcript, "A64_EVT"), INJECTED_TABLET, "the tablet's events (virtio-input)");
    Object.assign(lines, { net_frames: echoed, hvc0: true, input_events: INJECTED_KEYS.length + INJECTED_TABLET.length, pci: pci_functions(transcript) });
    // (the PCI functions, against the reference's: needed for the pci variant;
    // not with A64_LINUX_SLEEP's swap disk, which the reference does not have)
    const reference_log = directory + tag_of("qemu") + ".log";
    assert.ok(transport === "mmio" || sleep_cycles || fs.existsSync(reference_log), "the pci variant compares with the reference's run: " + reference_log);
    if(!sleep_cycles && fs.existsSync(reference_log))
    {
        assert.deepEqual(lines.pci, pci_functions(fs.readFileSync(reference_log, "latin1")), "the PCI functions, against the reference's");
        lines.pci_compared = true;
    }
    assert.equal(lines.pci.length, transport === "pci" ? 1 + machine_options.virtio_disks.length + 5 : 1,
        "the PCI functions: the host bridge and the devices on pci");
    if(sleep_cycles)
    {
        assert.equal(sleep_results.filter(r => r.s2idle).length + sleep_results.filter(r => r.hibernate).length, 2 * sleep_cycles, "every sleep cycle");
        lines.sleep = sleep_results;
    }
}
if(snapshots)
{
    assert.deepEqual(snapshots_taken, SNAPSHOT_MARKERS, "a snapshot at each marker");
    lines.snapshots = snapshot_rounds;
}
const features = detected(transcript);
let reference_features;
if(!single)
{
    // (CSV3: meltdown is not a concern, with or without kpti=1; kpti=1 turns KPTI on all the same)
    const meltdown = transcript.match(/A64_VULN meltdown: ([^\r\n]*)/);
    assert.equal(meltdown?.[1], "Not affected", "vulnerabilities/meltdown");
    assert.equal(features.some(f => /^Kernel page table isolation/.test(f)), kpti, "KPTI " + (kpti ? "on" : "off"));
    // (the same stage on the reference, if it ran: A64_LINUX_QEMU=1)
    const reference_log = directory + tag_of("qemu") + ".log";
    if(fs.existsSync(reference_log))
    {
        const reference_text = fs.readFileSync(reference_log, "latin1");
        reference_features = detected(reference_text);
        if(workload)
        {
            assert.ok(workload_output(transcript), "the workload's output");
            assert.equal(workload_output(transcript), workload_output(reference_text), "the workload's output, against the reference's");
        }
        // (and the androidish runs' pseudo-NMIs, their command line's, not the reference's)
        const only_v86 = features.filter(f => !reference_features.includes(f) && !FEATURES_ONLY_ON_V86.includes(f) &&
            !(android && f === "IRQ priority masking"));
        const only_reference = reference_features.filter(f => !features.includes(f) && !FEATURES_ONLY_ON_REFERENCE.includes(f));
        assert.deepEqual([only_v86, only_reference], [[], []], "CPU features: detected, beyond the allowed differences (v86, reference)");
    }
}
const vulnerabilities = Object.fromEntries([...transcript.matchAll(/A64_VULN (\S+): ([^\r\n]*)/g)].map(m => [m[1], m[2]]));
if(midway) assert.ok(snapped && snapshot_bytes, "the snapshot in the workload's middle was taken and restored");
const ms = Math.round(performance.now() - started);
const result = { tag, ms, ...(live ? { boot_to_login_ms: login_ms } : {}), probe_done_ms: probe_ms, retired_instructions,
    retired_per_core, mips: Math.round(retired_instructions / ms / 100) / 10, page_tier, mmu, ...(parallel ? { parallel: parallel_status } : {}),
    ...(midway ? { midway_snapshot_bytes: snapshot_bytes } : {}), ...lines, features,
    reference_features: reference_features ? "compared" : "no reference log", vulnerabilities };
fs.writeFileSync(directory + `result-${tag}.json`, JSON.stringify({ ...manifest, ...result }, null, 2) + "\n");
console.log(JSON.stringify(result));
console.log(`A64_LINUX_BOOT_OK ${tag}`);
process.exit(0);
