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
import { prepare, unzboot, sha256, ROOT } from "../lib/alpine_image.mjs";
import { QEMU_MACHINE, QEMU_CPU, qemu_binary, smp } from "./guest_runner.mjs";

const stage = process.env.A64_STAGE || "initramfs";
assert.ok(["initramfs", "single", "lifecycle", "live"].includes(stage), "A64_STAGE is initramfs, single, lifecycle or live");
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
    "/a64-probe nodisk \"$@\"",
    "case \"$A64_WORKLOAD\" in '') ;; jit) /a64-jit-workload ;; *) /a64-workload \"$A64_WORKLOAD\" ;; esac",
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
const memory_mb = jit_workload ? 1536 : 512;
const timeout = Number(process.env.A64_LINUX_TIMEOUT || (jit_workload ? 3600000 : stage === "live" ? 1800000 : 180000));
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
const LIVE_COMMANDS = ref => "modprobe virtio_net 2>/dev/null; modprobe virtio-rng 2>/dev/null; ifconfig eth0 up; " +
    "for d in /sys/block/vd*; do [ \"$(cat $d/serial 2>/dev/null)\" = a64probe ] && tar -xf /dev/${d##*/} -C /tmp; done; " +
    `/tmp/a64-probe ${ref === "v86" ? "net " : ""}ref=${ref}; echo A64_HWRNG=$(head -c 64 /dev/hwrng | wc -c); ` +
    "cat /proc/cpuinfo | head -12; cat /proc/interrupts; " +
    "for f in /sys/devices/system/cpu/vulnerabilities/*; do echo \"A64_VULN ${f##*/}: $(cat $f)\"; done; " +
    (ref === "v86" ? "(/sbin/getty -L hvc0 115200 vt100 &); echo A64_LIVE_PROBED\n" : "echo A64_LIVE_DONE; poweroff -f\n");
const LIVE_FINISH = "echo A64_LIVE_DONE; poweroff -f\n";
// (A64_KPTI=1: the initramfs stage with kpti=1, KPTI forced on although CSV3 says it is not needed, P3.9)
const kpti = !!+process.env.A64_KPTI;
assert.ok(!kpti || stage === "initramfs", "A64_KPTI is a variant of the initramfs stage");
// (A64_WORKLOAD=N: the initramfs stage runs /a64-workload N after the probe;
// A64_WORKLOAD=jit: the guest JIT workloads, below)
const workload = process.env.A64_WORKLOAD === "jit" ? "jit" : +process.env.A64_WORKLOAD || 0;
assert.ok(!workload || stage === "initramfs", "A64_WORKLOAD is a variant of the initramfs stage");
const INITRAMFS_CMDLINE = ref => `console=ttyAMA0 earlycon nokaslr panic=-1${kpti ? " kpti=1" : ""}` +
    `${workload ? " A64_WORKLOAD=" + workload : ""} rdinit=/a64-init -- ref=${ref}`;
// (A64_JIT=1: the v86 runs with the A64 page tier, docs/jit-unification-plan.md J2;
// A64_JIT_HOT its compile threshold)
const jit = !!+process.env.A64_JIT;
const JIT_OPTIONS = jit ? { jit_switches: { a64_page: 1, ...(process.env.A64_JIT_HOT ? { a64_page_hot: +process.env.A64_JIT_HOT } : {}),
    ...(process.env.A64_JIT_SWITCHES ? Object.fromEntries(process.env.A64_JIT_SWITCHES.split(",").map(p => [p.split("=")[0], +p.split("=")[1]])) : {}) } } : {};
const tag_of = target => `${target}${target === "v86" && jit ? "-jit" : ""}-${stage}${kpti ? "-kpti" : ""}${workload ? "-wl" + workload : ""}-${cores}c`;
// (without the kernel's messages, which may land between the workload's lines)
const workload_output = text => text.match(/A64_WORKLOAD_BEGIN\r?\n([\s\S]*?)A64_WORKLOAD_END/)?.[1].replace(/\r/g, "")
    .split("\n").filter(line => !/^\[\s*\d+\.\d+\] /.test(line)).join("\n");
const tag = tag_of(qemu_reference ? "qemu" : "v86");

// The "CPU features: detected" lines may differ from the reference's only
// where the profile's register differences lead (tests/platform/a64-profile.json):
// the reference's 32-bit EL0 and EL1 (no AArch32 in v1); Spectre-v4 and
// Spectre-BHB on v86, whose MIDR is on none of Linux's safe lists (the
// reference's Cortex-A35 is on all of them)
const FEATURES_ONLY_ON_REFERENCE = ["32-bit EL0 Support", "32-bit EL1 Support"];
const FEATURES_ONLY_ON_V86 = ["Spectre-v4", "Spectre-BHB"];
const detected = text => [...new Set([...text.matchAll(/CPU features: detected: ([^\r\n]+)/g)].map(m => m[1].trim()))].sort();

/** The probe's lines in `text`, judged against `cores` and the stage */
function check_probe(text, reference)
{
    const fail = text.match(/A64_PROBE_FAIL[^\r\n]*/);
    assert.ok(!fail, fail?.[0]);
    const ok = text.match(/A64_PROBE_OK arch=aarch64 cpus=(\d+) threads=(\d+) counter=(\d+) cpu_checks=([\d,]+) fault=page esr=(\w+) child=7 tlb_stale=(\d+) page_size=(\d+)[^\r\n]* high_pages=(\d+)/);
    assert.ok(ok, "no A64_PROBE_OK line");
    assert.deepEqual(ok.slice(1, 4).map(Number), [cores, cores, cores * 20000], "CPUs, threads and the exclusive counter");
    assert.equal(ok[4], Array.from({ length: cores }, (_, i) => i).join(","), "each thread on its CPU");
    assert.equal(+ok[6], 0, "no stale TLB entry after the remap");
    const xc = text.match(/A64_PROBE_XC arch=aarch64 packages=1 cores=(\d+) threads_per_core=1 migrations=(\d+) signals=(\d+) smc_rounds=(\d+) dual_map=(\d+) excl_aba=(\d) futex=(\d+) clocks=1 fp_threads=(\d+) fp_steps=(\d+) fp_bad=(\d+) aarch32=(\w+) direct_io=(\d)/);
    assert.ok(xc, "no A64_PROBE_XC line");
    assert.deepEqual([xc[1], xc[2], xc[3], xc[4], xc[5]].map(Number), [cores, cores * 24, cores * 16, 64, 64], "topology, migrations, signals, cross-modified and dual-mapped code");
    assert.deepEqual([+xc[8], +xc[9], +xc[10]], [2 * cores, 2 * cores * 20, 0], "FPCR, FPSR and V0-V31 across context switches");
    assert.equal(+xc[12], stage === "initramfs" ? 0 : 1, "O_DIRECT read of the probe disk");
    if(!reference)
    {
        assert.equal(xc[6], "1", "exclusive ABA: the store-exclusive fails");
        assert.equal(xc[11], "enoexec", "no AArch32");
    }
    return { ok: ok[0], xc: xc[0] };
}

if(qemu_reference)
{
    const qemu = qemu_binary();
    const version = run(qemu, ["--version"]).split("\n")[0];
    assert.match(version, /QEMU emulator version 9\.2\./, "the fixed reference is QEMU 9.2.x");
    const machine = QEMU_MACHINE;
    const base = ["-cpu", QEMU_CPU, "-m", memory_mb + "M", "-smp", smp(cores),
        "-global", "virtio-mmio.force-legacy=false", "-display", "none", "-no-reboot"];
    // the DTB QEMU gives this machine (dumpdtb), once
    const dtb = directory + `qemu-virt-${cores}c.dtb`;
    run(qemu, ["-machine", machine + ",dumpdtb=" + dtb, ...base, "-kernel", prepared.kernel]);
    if(cores === 1) Object.assign(manifest, { qemu: version, dtb_sha256: sha256(fs.readFileSync(dtb)) });
    fs.writeFileSync(manifest_file, JSON.stringify(manifest, null, 2) + "\n");
    const live = stage === "live", single = stage === "single";
    const args = ["-machine", machine, ...base, "-serial", "stdio", "-monitor", "none", "-kernel", prepared.kernel,
        "-initrd", live || single ? prepared.initrd : initrd,
        "-append", live ? LIVE_CMDLINE
            : single ? SINGLE_CMDLINE : INITRAMFS_CMDLINE("qemu"),
        ...(live ? ["-drive", `if=none,id=iso,file=${prepared.iso},format=raw,readonly=on`, "-device", "virtio-blk-device,drive=iso",
            "-drive", `if=none,id=probe,file=${probe_directory}probe.tar,format=raw,snapshot=on`, "-device", "virtio-blk-device,drive=probe,serial=a64probe",
            // (the same devices as v86's, in its order; their host sides are empty)
            "-netdev", "hubport,id=net0,hubid=0", "-device", "virtio-net-device,netdev=net0", "-device", "virtio-rng-device",
            "-chardev", "null,id=hvc", "-device", "virtio-serial-device", "-device", "virtconsole,chardev=hvc"] : [])];
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
    if(live) assert.match(transcript, /\nA64_HWRNG=64\r?\n/, "64 bytes from /dev/hwrng (virtio-rng)");
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
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm", ...JIT_OPTIONS,
};
if(stage === "lifecycle")
{
    const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
    const options = { ...v86_options, kernel: { url: prepared.kernel }, initrd: { url: prepared.initrd }, cmdline: SINGLE_CMDLINE };
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
const machine_options = {
    cpu_type: "arm64", graphics_adapter: "none", cpu_cores: cores, memory_size: memory_mb * 1048576, log_level: 0,
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm",
    kernel: { url: prepared.kernel }, initrd: { url: single || live ? prepared.initrd : initrd },
    cmdline: single ? SINGLE_CMDLINE : live ? LIVE_CMDLINE : INITRAMFS_CMDLINE("v86"), ...JIT_OPTIONS,
    // (the live stage's disks and devices, in the reference's -device order: P5.3)
    ...(live ? { virtio_disks: [{ buffer: array_buffer(prepared.iso), readonly: true },
        { buffer: array_buffer(probe_directory + "probe.tar"), id: "a64probe" }],
        net_device: { type: "virtio" }, virtio_rng: true, virtio_console: true } : {}),
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
let echoed = 0, hvc = "", hvc_state = 0;
const attach_live = emulator =>
{
    emulator.bus.register("net0-send", packet => {
        if(packet.length < 14 || packet[12] !== 0x88 || packet[13] !== 0xB5 || packet[11] !== 1) return;
        const reply = Uint8Array.from(packet);
        reply.set([2, 0, 0, 0, 0, 2], 6);
        echoed++;
        setTimeout(() => emulator.bus.send("net0-receive", reply), 0);
    });
    emulator.add_listener("virtio-console0-output-bytes", bytes => {
        hvc += String.fromCharCode(...bytes);
        const send = text => emulator.bus.send("virtio-console0-input-bytes", Uint8Array.from(Buffer.from(text)));
        if(hvc_state === 0 && /login: ?$/.test(hvc)) { hvc_state = 1; send("root\n"); }
        else if(hvc_state === 1 && /# ?$/.test(hvc)) { hvc_state = 2; send("echo A64_HVC_$((6*7)); exit\n"); }
        else if(hvc_state === 2 && /\nA64_HVC_42\r?\n/.test(hvc)) { hvc_state = 3; emulator.serial0_send(LIVE_FINISH); }
    });
};
if(live) attach_live(emulator);
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
            // (a line of its own: the shell echoes the command, which names it too)
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
const retired_instructions = Array.from({ length: cores }, (_, core) => emulator.v86.cpu.wm.exports["core_statistics_get"](core, 0))
    .reduce((sum, n) => sum + n, 0);
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
if(live)
{
    // (P5.4, P5.5: the frames through virtio-net, /dev/hwrng, a login on hvc0)
    assert.match(transcript, /A64_PROBE_NET arch=aarch64 frames=16/, "raw frames through eth0 (virtio-net) and back");
    assert.equal(echoed, 16, "the host echoed every probe frame");
    assert.match(transcript, /\nA64_HWRNG=64\r?\n/, "64 bytes from /dev/hwrng (virtio-rng)");
    assert.equal(hvc_state, 3, "a login on hvc0 (virtio-console): " + JSON.stringify(hvc.slice(-300)));
    Object.assign(lines, { net_frames: echoed, hvc0: true });
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
        const only_v86 = features.filter(f => !reference_features.includes(f) && !FEATURES_ONLY_ON_V86.includes(f));
        const only_reference = reference_features.filter(f => !features.includes(f) && !FEATURES_ONLY_ON_REFERENCE.includes(f));
        assert.deepEqual([only_v86, only_reference], [[], []], "CPU features: detected, beyond the allowed differences (v86, reference)");
    }
}
const vulnerabilities = Object.fromEntries([...transcript.matchAll(/A64_VULN (\S+): ([^\r\n]*)/g)].map(m => [m[1], m[2]]));
if(midway) assert.ok(snapped && snapshot_bytes, "the snapshot in the workload's middle was taken and restored");
const ms = Math.round(performance.now() - started);
const result = { tag, ms, ...(live ? { boot_to_login_ms: login_ms } : {}), probe_done_ms: probe_ms, retired_instructions,
    mips: Math.round(retired_instructions / ms / 100) / 10, page_tier,
    ...(midway ? { midway_snapshot_bytes: snapshot_bytes } : {}), ...lines, features,
    reference_features: reference_features ? "compared" : "no reference log", vulnerabilities };
fs.writeFileSync(directory + `result-${tag}.json`, JSON.stringify({ ...manifest, ...result }, null, 2) + "\n");
console.log(JSON.stringify(result));
console.log(`A64_LINUX_BOOT_OK ${tag}`);
process.exit(0);
