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
//   "nodisk" and powers off. No virtio.
// - stage "live": the ISO as a read-only virtio-blk disk, the probe in a
//   ustar image on a second virtio-blk disk with serial a64probe; Alpine's
//   initramfs finds the modloop and the packages on the ISO and boots to
//   "localhost login:", where the probe runs from the disk it reads.
//
// A64_LINUX_QEMU=1 runs the fixed reference (QEMU 9.2.0 built from source,
// build/a64-ref or A64_QEMU, virt-9.2 with cortex-a35 and every default the
// plan names spelled out) and passes ref=qemu to the probe; A64_CORES (1, 2,
// 4), A64_LINUX_TIMEOUT (ms, 180000). A64_LINUX_PREPARE_ONLY=1 only prepares
// the files and the manifest (build/a64-linux/manifest.json): the ISO, the
// kernel, the Image inside it, the initramfs, the probe and, after a QEMU
// run, the reference DTB (dumpdtb) and QEMU's version.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { prepare, unzboot, sha256, ROOT } from "../lib/alpine_image.mjs";

const stage = process.env.A64_STAGE || "initramfs";
assert.ok(["initramfs", "live"].includes(stage), "A64_STAGE is initramfs or live");
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
    const qemu = process.env.A64_QEMU || ROOT + "build/a64-ref/qemu-9.2.0-install/bin/qemu-system-aarch64";
    assert.ok(fs.existsSync(qemu), qemu + " is missing: build QEMU 9.2.0 (docs/arm64-virt-android16-plan.md P0.11)");
    const version = run(qemu, ["--version"]).split("\n")[0];
    assert.match(version, /QEMU emulator version 9\.2\./, "the fixed reference is QEMU 9.2.x");
    const machine = "virt-9.2,gic-version=3,its=off,highmem-ecam=on,highmem-mmio=on,highmem-redists=on,virtualization=off,secure=off,acpi=off,dtb-randomness=off";
    const base = ["-cpu", "cortex-a35,pmu=off,cntfrq=1000000000", "-m", "512M", "-smp", `${cores},sockets=1,cores=${cores},threads=1`,
        "-global", "virtio-mmio.force-legacy=false", "-display", "none", "-no-reboot"];
    // the DTB QEMU gives this machine (dumpdtb), once
    const dtb = directory + `qemu-virt-${cores}c.dtb`;
    run(qemu, ["-machine", machine + ",dumpdtb=" + dtb, ...base, "-kernel", prepared.kernel]);
    if(cores === 1) Object.assign(manifest, { qemu: version, dtb_sha256: sha256(fs.readFileSync(dtb)) });
    fs.writeFileSync(manifest_file, JSON.stringify(manifest, null, 2) + "\n");
    const live = stage === "live";
    const args = ["-machine", machine, ...base, "-serial", "stdio", "-monitor", "none", "-kernel", prepared.kernel,
        "-initrd", live ? prepared.initrd : initrd_probe,
        "-append", live ? "console=ttyAMA0 earlycon nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage"
            : "console=ttyAMA0 earlycon nokaslr panic=-1 rdinit=/a64-init -- ref=qemu",
        ...(live ? ["-drive", `if=none,id=iso,file=${prepared.iso},format=raw,readonly=on`, "-device", "virtio-blk-device,drive=iso",
            "-drive", `if=none,id=probe,file=${probe_directory}probe.tar,format=raw,snapshot=on`, "-device", "virtio-blk-device,drive=probe,serial=a64probe"] : [])];
    const child = spawn(qemu, args, { stdio: ["pipe", "pipe", "pipe"] });
    let transcript = "", logged_in = false, ran = false;
    const started = performance.now();
    let timer;
    try
    {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`QEMU ${stage} deadline (${timeout} ms)`)), timeout);
            child.on("error", reject);
            child.on("exit", code => (/A64_INIT_DONE|A64_LIVE_DONE/.test(transcript) ? resolve() : reject(new Error(`QEMU exited ${code}`))));
            const output = bytes => {
                transcript += bytes;
                if(live && !logged_in && /localhost login: ?$/.test(transcript))
                {
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
    const lines = check_probe(transcript, true);
    const result = { tag, ms: Math.round(performance.now() - started), ...lines,
        login: live ? /localhost login:/.test(transcript) : undefined };
    console.log(JSON.stringify(result));
    console.log(`A64_LINUX_BOOT_OK ${tag}`);
    process.exit(0);
}
// (the v86 runs come with the ARM core: A2)
console.log("tests/a64/linux_boot.mjs: v86 runs need the ARM core (docs/arm64-virt-android16-plan.md A2); use A64_LINUX_QEMU=1");
process.exit(2);
