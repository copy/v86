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
    "$B cat /proc/interrupts",
    "$B echo A64_INIT_DONE",
    "$B poweroff -f",
    ""].join("\n"), { mode: 0o755 });
const tar_args = ["--uid", "0", "--gid", "0", "--no-xattrs", "--no-mac-metadata"];
run("bsdtar", ["--format", "newc", ...tar_args, "-cf", probe_directory + "probe.cpio", "-C", probe_directory + "root", "a64-init", "a64-probe"]);
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

const timeout = Number(process.env.A64_LINUX_TIMEOUT || 180000);
// (a root that does not exist: init looks for it, then enters single mode before mounting it)
const SINGLE_CMDLINE = "console=ttyAMA0 earlycon nokaslr panic=-1 single root=/dev/vda";
const SINGLE_COMMANDS = "cat /proc/interrupts; echo A64_SINGLE_$((6*7)) && echo A64_SINGLE_OK; /bin/busybox poweroff -f\n";
const tag = `${qemu_reference ? "qemu" : "v86"}-${stage}-${cores}c`;

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
    const base = ["-cpu", QEMU_CPU, "-m", "512M", "-smp", smp(cores),
        "-global", "virtio-mmio.force-legacy=false", "-display", "none", "-no-reboot"];
    // the DTB QEMU gives this machine (dumpdtb), once
    const dtb = directory + `qemu-virt-${cores}c.dtb`;
    run(qemu, ["-machine", machine + ",dumpdtb=" + dtb, ...base, "-kernel", prepared.kernel]);
    if(cores === 1) Object.assign(manifest, { qemu: version, dtb_sha256: sha256(fs.readFileSync(dtb)) });
    fs.writeFileSync(manifest_file, JSON.stringify(manifest, null, 2) + "\n");
    const live = stage === "live", single = stage === "single";
    const args = ["-machine", machine, ...base, "-serial", "stdio", "-monitor", "none", "-kernel", prepared.kernel,
        "-initrd", live || single ? prepared.initrd : initrd_probe,
        "-append", live ? "console=ttyAMA0 earlycon nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage"
            : single ? SINGLE_CMDLINE : "console=ttyAMA0 earlycon nokaslr panic=-1 rdinit=/a64-init -- ref=qemu",
        ...(live ? ["-drive", `if=none,id=iso,file=${prepared.iso},format=raw,readonly=on`, "-device", "virtio-blk-device,drive=iso",
            "-drive", `if=none,id=probe,file=${probe_directory}probe.tar,format=raw,snapshot=on`, "-device", "virtio-blk-device,drive=probe,serial=a64probe"] : [])];
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
                    child.stdin.write("for d in /sys/block/vd*; do [ \"$(cat $d/serial 2>/dev/null)\" = a64probe ] && tar -xf /dev/${d##*/} -C /tmp; done; " +
                        "/tmp/a64-probe ref=qemu; cat /proc/cpuinfo | head -12; echo A64_LIVE_DONE; poweroff -f\n");
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
assert.notEqual(stage, "live", "the live stage on v86 needs virtio-blk (P5.1, A3)");
const v86_options = {
    cpu_type: "arm64", graphics_adapter: "none", cpu_cores: cores, memory_size: 512 << 20, log_level: 0,
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm",
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
const single = stage === "single";
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const emulator = new V86({
    cpu_type: "arm64", graphics_adapter: "none", cpu_cores: cores, memory_size: 512 << 20, autostart: true, log_level: 0,
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm",
    kernel: { url: prepared.kernel }, initrd: { url: single ? prepared.initrd : initrd_probe },
    cmdline: single ? SINGLE_CMDLINE : "console=ttyAMA0 earlycon nokaslr panic=-1 rdinit=/a64-init -- ref=v86",
});
const verbose = !!+process.env.A64_VERBOSE;
let transcript = "", probe_ms, typed = false;
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
        emulator.add_listener("serial0-output-byte", byte => {
            const c = String.fromCharCode(byte);
            transcript += c;
            if(verbose) process.stdout.write(c);
            if(probe_ms === undefined && transcript.includes("A64_PROBE_XC")) probe_ms = Math.round(performance.now() - started);
            if(single && !typed && /Entering single mode[^\n]*\n/.test(transcript))
            {
                typed = true;
                emulator.serial0_send(SINGLE_COMMANDS);
            }
            const done = single ? /A64_SINGLE_42\r?\nA64_SINGLE_OK/ : /A64_INIT_DONE/;
            if(done.test(transcript) || /Kernel panic/.test(transcript) && transcript.endsWith("\n"))
            {
                clearTimeout(timer);
                setTimeout(() => (done.test(transcript) ? resolve() : reject(new Error("kernel panic: " + inspect()))), 200);
            }
        });
    });
}
finally
{
    fs.writeFileSync(directory + `${tag}.log`, transcript);
}
// (no UNDEF in the kernel, P2.3; no trouble in its log; the timer's and the UART's interrupts counted)
const undefined_instructions = emulator.v86.cpu.undefined_instructions();
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
const result = { tag, ms: Math.round(performance.now() - started), probe_done_ms: probe_ms, ...lines };
fs.writeFileSync(directory + `result-${tag}.json`, JSON.stringify({ ...manifest, ...result }, null, 2) + "\n");
console.log(JSON.stringify(result));
console.log(`A64_LINUX_BOOT_OK ${tag}`);
process.exit(0);
