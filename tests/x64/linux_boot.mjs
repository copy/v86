#!/usr/bin/env node
// Unmodified Alpine x86_64 kernel: real Linux boot protocol, firmware and initrd.
// The private CPUID switch is used only for qualification; no public CPU option.
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawn, spawnSync} from "node:child_process";
import {createHash as create_hash} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {setImmediate as set_immediate} from "node:timers";
import {fileURLToPath} from "node:url";
import {prepare_glibc, check_glibc, qemu_cpu, GLIBC_COMMAND} from "./linux_glibc.mjs";
import {prepare as prepare_alpine} from "../lib/alpine_image.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = root + "build/x64-linux/";
// X64_LINUX_FLAVOR: "virt" (default, the virt kernel) or "lts" (the standard
// ISO's lts kernel, which also has hibernation, for the S4 cycles)
const flavor = process.env.X64_LINUX_FLAVOR || "virt";
assert.ok(["virt", "lts"].includes(flavor), "X64_LINUX_FLAVOR is virt or lts");
// (the pinned ISO, downloaded, checked and unpacked: tests/lib/alpine_image.mjs)
const prepared = await prepare_alpine("x86_64-" + flavor);
const {name, sha256: digest} = prepared.image;
const kernel_file = `boot/vmlinuz-${flavor}`, initrd_file = `boot/initramfs-${flavor}`;
const source = prepared.source;
const hash = bytes => create_hash("sha256").update(bytes).digest("hex");
// 64-bit and compatibility-mode probes from one freestanding source. They are
// delivered as a ustar image on the IDE disk and unpacked by the guest shell.
// Concurrent configurations get separate probe builds and result files.
const cores = Number(process.env.X64_CORES || 1);
// X64_CPU_FEATURES: CPU features of docs/simd-xsave-plan.md, comma-separated
// (e.g. XSAVE); X64_LINUX_GLIBC=1: also the glibc acceptance of plan 11.3
// (tests/x64/linux_glibc.mjs), against a QEMU run with the same features
const features = process.env.X64_CPU_FEATURES ? process.env.X64_CPU_FEATURES.split(",") : [];
const glibc_test = !!+process.env.X64_LINUX_GLIBC;
const tag_for = backend => `${backend}-${cores}c${process.env.X64_HIGH_MEMORY ? "-high" : ""}${flavor === "virt" ? "" : "-" + flavor}` +
    (features.length ? "-" + create_hash("sha256").update(features.join(",")).digest("hex").slice(0, 8) : "") + (glibc_test ? "-glibc" : "") +
    (/\bnoxsave\b/.test(process.env.X64_LINUX_CMDLINE || "") ? "-noxsave" : "");
const tag = tag_for(+process.env.X64_LINUX_QEMU ? "qemu" : +process.env.X64_JIT ? "native" : "interpreter");
const probe_directory = directory + `probe-${tag}/`;
fs.mkdirSync(probe_directory, {recursive: true});
function run(program, args)
{
    const result = spawnSync(program, args, {encoding: "utf8"});
    assert.equal(result.status, 0, `${program}: ${result.stderr || result.error}`);
    return result.stdout.trim();
}
const host = run("rustc", ["-vV"]).match(/host: (.+)/)[1];
const lld = process.env.LD_LLD || `${run("rustc", ["--print", "sysroot"])}/lib/rustlib/${host}/bin/rust-lld`;
const probe_source = root + "tests/x64/linux_probe.c";
for(const [bits, target, flags, emulation] of [
    [64, "x86_64-unknown-linux-gnu", ["-mno-red-zone"], "elf_x86_64"],
    [32, "i386-unknown-linux-gnu", ["-m32", "-mno-sse", "-mno-mmx"], "elf_i386"],
])
{
    run(process.env.CLANG || "clang", [`--target=${target}`, ...flags, "-O2", "-ffreestanding", "-fno-stack-protector",
        "-fno-pic", "-fno-builtin", "-c", probe_source, "-o", probe_directory + `probe${bits}.o`]);
    run(lld, ["-flavor", "gnu", "-m", emulation, "-static", "-e", "_start", "-o", probe_directory + `linux_probe${bits}`, probe_directory + `probe${bits}.o`]);
}
const glibc = glibc_test ? await prepare_glibc(root, directory, probe_directory + "glibc/", lld) : null;
run("bsdtar", ["--format", "ustar", "--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0",
    "-cf", probe_directory + "probe.tar", "-C", probe_directory, "linux_probe64", "linux_probe32", ...(glibc ? ["-C", glibc.stage, "glibc"] : [])]);
const probe_disk = fs.readFileSync(probe_directory + "probe.tar");
// v86 runs also bring up virtio-net (Alpine virt has no NE2K driver) and echo
// raw frames on the host (X64_PROBE_NET); the QEMU reference skips that round.
// Extended RAM: X64_EXTENDED_MEMORY=<bytes> of extended RAM after the relocated RAM;
// X64_LINUX_MEMTEST=<MiB>: the probe maps, writes and checks that much and
// counts its pages in extended RAM (they must be there); X64_EXTENDED_CACHE=<bytes>
// of frames that hold it (default 512 MiB)
const extended_memory = Number(process.env.X64_EXTENDED_MEMORY || 0);
// X64_MEMORY=<MiB> of RAM in the WebAssembly heap (default 512; index.html
// puts 2048 there before it adds extended RAM)
const memory_mib = Number(process.env.X64_MEMORY || 512);
const extended_cache = Number(process.env.X64_EXTENDED_CACHE || 0);
const memtest_mib = Number(process.env.X64_LINUX_MEMTEST || 0);
const guest_command = net => (net ? "modprobe virtio_net 2>/dev/null; ifconfig eth0 up && " : "") +
    `tar -xf /dev/sda -C /tmp && /tmp/linux_probe64 ${net ? "net" : ""} && /tmp/linux_probe32 ${net ? "net" : ""}; ` +
    (glibc_test ? GLIBC_COMMAND : "") +
    (memtest_mib ? `grep MemTotal /proc/meminfo; /tmp/linux_probe64 memtest ${memtest_mib} ${extended_first_pfn()}; ` : "") +
    "uname -m; cat /sys/devices/system/cpu/online; grep 'System RAM' /proc/iomem; echo X64_LINUX_BOOT_OK\n";
function extended_first_pfn() { return (2 ** 32 + Number(process.env.X64_HIGH_MEMORY || 0)) / 4096; }
// High memory: relocate this many bytes of RAM to guest physical 4 GiB (v86) or give
// QEMU the same split, so the kernel and probes must use RAM above 4 GiB.
const high_memory = Number(process.env.X64_HIGH_MEMORY || 0);
// Sleep states: X64_LINUX_SLEEP=<cycles> suspends to RAM and hibernates to /dev/sdb
// (a blank disk) that many times each; Alpine's initramfs restores through resume=.
const sleep_cycles = Number(process.env.X64_LINUX_SLEEP || 0);
const cmdline = process.env.X64_LINUX_CMDLINE || "console=ttyS0,115200 earlyprintk=serial,ttyS0,115200 loglevel=7 nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage" +
    // (Alpine's live initramfs handles resume= before it loads disk drivers
    // for the root file system: load the IDE driver first, or /dev/sdb is missing)
    (sleep_cycles ? ",ata_piix resume=/dev/sdb" : "");
// (with noxsave on the command line the kernel leaves CR4.OSXSAVE clear:
// what needs XSAVE is not usable, and AVX instructions are #UD)
const XSAVE_DEPENDENT = ["XSAVE", "AVX", "AVX2", "FMA", "F16C", "XSAVEOPT", "XSAVEC", "XGETBV1", "XSAVES"];
const usable = /\bnoxsave\b/.test(cmdline) ? features.filter(name => !XSAVE_DEPENDENT.includes(name)) : features;
const manifest = {source, iso_sha256: digest, kernel_sha256: hash(fs.readFileSync(directory + kernel_file)),
    initrd_sha256: hash(fs.readFileSync(directory + initrd_file)), cmdline,
    probe_tar_sha256: hash(probe_disk), probe64_sha256: hash(fs.readFileSync(probe_directory + "linux_probe64")),
    probe32_sha256: hash(fs.readFileSync(probe_directory + "linux_probe32"))};
fs.writeFileSync(directory + `image-${tag}.json`, JSON.stringify(manifest, null, 2) + "\n");
if(+process.env.X64_LINUX_PREPARE_ONLY) process.exit(0);
function check_probes(text, net)
{
    for(const bits of [64, 32])
    {
        const line = text.match(new RegExp(`X64_PROBE_OK arch=${bits} cpus=(\\d+) threads=\\d+ counter=(\\d+) cpu_checks=([\\d,]+)`));
        assert.ok(line, `${bits}-bit probe result: ${text.match(new RegExp(`X64_PROBE_FAIL arch=${bits}[^\\r\\n]*`))?.[0] || "missing"}`);
        assert.equal(+line[1], cores, `${bits}-bit probe sees every online CPU`);
        assert.equal(+line[2], cores * 20000, `${bits}-bit LOCKed counter`);
        assert.deepEqual(line[3].split(",").map(Number), Array.from({length: cores}, (_, i) => i), `${bits}-bit threads ran on each CPU`);
        assert.match(text, new RegExp(`X64_PROBE_OK arch=${bits} [^\\r\\n]* tlb_stale=0 entry=${bits === 32 ? "vdso" : "syscall"}`), `${bits}-bit remote TLB shootdown and system call entry`);
        const matrix = text.match(new RegExp(`X64_PROBE_XC arch=${bits} packages=1 cores=(\\d+) threads_per_core=1 migrations=(\\d+) signals=(\\d+) smc_rounds=64 direct_io=1`));
        assert.ok(matrix, `${bits}-bit multicore matrix: ${text.match(new RegExp(`X64_PROBE_FAIL arch=${bits}[^\\r\\n]*`))?.[0] || "missing"}`);
        assert.deepEqual(matrix.slice(1).map(Number), [cores, cores * 24, cores * 16], `${bits}-bit topology, migrations and signals`);
        const placed = +text.match(new RegExp(`X64_PROBE_OK arch=${bits} [^\\r\\n]* high_pages=(\\d+)`))[1];
        if(high_memory || extended_memory) assert.ok(placed > 0, `${bits}-bit process received frames above 4 GiB`);
        else assert.equal(placed, 0, `${bits}-bit process: no RAM above 4 GiB exists`);
        if(net) assert.match(text, new RegExp(`X64_PROBE_NET arch=${bits} frames=16`), `${bits}-bit raw frames through eth0 (virtio-net) and back`);
        // YMM fingerprints across context switches: twice as many threads as
        // CPUs, 8 rounds of 5 steps (one of them a signal) each
        const ymm = text.match(new RegExp(`X64_PROBE_YMM arch=${bits} avx=(\\d)(?: registers=(\\d+) threads=(\\d+) steps=(\\d+) signals=(\\d+) bad=(\\d+))?`));
        assert.ok(ymm, `${bits}-bit YMM probe: ${text.match(new RegExp(`X64_PROBE_FAIL arch=${bits}[^\\r\\n]*`))?.[0] || "missing"}`);
        if(usable.includes("AVX")) assert.deepEqual(ymm.slice(1).map(Number), [1, bits === 64 ? 16 : 8, 2 * cores, 80 * cores, 16 * cores, 0], `${bits}-bit YMM state across context switches`);
        else assert.equal(ymm[1], "0", `${bits}-bit probe: no AVX without the feature`);
    }
}
if(+process.env.X64_LINUX_QEMU)
{
    // (with features: QEMU's CPU gets them, v86's vendor and model)
    const qemu_model = features.length || glibc_test ? qemu_cpu(features) : "qemu64,phys-bits=36,-pdpe1gb";
    const child = spawn("qemu-system-x86_64", ["-machine", `pc,accel=tcg${high_memory ? `,max-ram-below-4g=${(512 << 20) - high_memory}` : ""}`, "-cpu", qemu_model, "-m", "512M",
        "-display", "none", "-monitor", "none", "-serial", "stdio", "-no-reboot", "-no-shutdown",
        "-kernel", directory + kernel_file, "-initrd", directory + initrd_file, "-cdrom", directory + name, "-append", cmdline,
        "-drive", `file=${probe_directory}probe.tar,format=raw,if=ide,index=0,snapshot=on`,
        "-smp", `${Number(process.env.X64_CORES || 1)},sockets=1,cores=${Number(process.env.X64_CORES || 1)},threads=1`,
        ...(process.env.X64_QEMU_TRACE ? ["-d", "in_asm", "-D", directory + "qemu-instructions.log"] : [])],
    {stdio: ["pipe", "pipe", "pipe"]});
    let transcript = "", logged_in = false, command = false;
    let timer;
    try
    {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("QEMU Linux boot deadline")), Number(process.env.X64_LINUX_TIMEOUT || 60000));
            child.on("error", reject);
            child.on("exit", code => reject(new Error(`QEMU exited ${code}`)));
            const output = bytes => {
                transcript += bytes;
                if(+process.env.SHOW_LOGS) process.stdout.write(bytes);
                if(transcript.includes("localhost login:") && !logged_in) { child.stdin.write("root\n"); logged_in = true; }
                if(transcript.includes("localhost:~#") && !command) { child.stdin.write(guest_command(false)); command = true; }
                if(/\r?\nX64_LINUX_BOOT_OK\r?\n/.test(transcript)) resolve();
                if(transcript.includes("Kernel panic")) reject(new Error("QEMU kernel panic"));
            };
            child.stdout.on("data", output);
            child.stderr.on("data", output);
        });
        assert.match(transcript, /\r?\nx86_64\r?\n/);
        check_probes(transcript, false);
        if(high_memory) assert.match(transcript, /\n\s*100000000-[0-9a-f]+ : System RAM/, "kernel owns RAM above 4 GiB");
        if(glibc) console.log("X64_LINUX_GLIBC " + JSON.stringify(check_glibc(transcript, usable, glibc.libraries, null)));
        console.log("X64_LINUX_QEMU_PASS");
    }
    finally
    {
        clearTimeout(timer);
        child.kill();
        fs.writeFileSync(directory + `${tag}.serial`, transcript);
    }
    process.exit(0);
}
// The glibc acceptance compares with QEMU under the same features: that run first
let glibc_reference = null;
// (X64_LINUX_GLIBC_TIMES=1: only the times, without the QEMU reference)
if(glibc && !+process.env.X64_LINUX_GLIBC_TIMES)
{
    const reference = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {env: {...process.env, X64_LINUX_QEMU: "1"}, stdio: "inherit"});
    assert.equal(reference.status, 0, "the QEMU reference run");
    glibc_reference = fs.readFileSync(directory + tag_for("qemu") + ".serial", "utf8");
}
const {V86} = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const jit = !!+process.env.X64_JIT;
const emulator = new V86({
    graphics_adapter: "bochs_vga",
    wasm_path: process.env.WASM_PATH,
    bios: {url: root + "bios/seabios.bin"}, vga_bios: {url: root + "bios/vgabios.bin"},
    bzimage: {url: directory + kernel_file}, initrd: {url: directory + initrd_file},
    cdrom: {url: directory + name}, hda: {buffer: probe_disk.buffer.slice(probe_disk.byteOffset, probe_disk.byteOffset + probe_disk.length)},
    ...(sleep_cycles ? {hdb: {buffer: new ArrayBuffer(256 << 20)}} : {}),
    cmdline, memory_size: memory_mib * (1 << 20), high_memory_size: high_memory, cpu_cores: cores, acpi: true, autostart: false,
    ...(extended_memory ? {extended_memory_size: extended_memory} : {}),
    ...(extended_cache ? {extended_memory_cache: extended_cache} : {}),
    disable_jit: !jit, experimental_smp_jit: jit, ir_sync_publication: true, log_level: 0, net_device: {type: "virtio"},
    // (the x64 profile, as set_x64_test_capabilities below; LZCNT needs it)
    cpu_type: "x86_64",
    ...(features.length ? {cpu_features: features, cpu_features_unreleased: true} : {}),
    ...(process.env.X64_IR_TIER0 === "0" ? {ir_tier0: false} : {}),
    // X64_PARALLEL=1: the application processors run in vCPU workers
    ...(+process.env.X64_PARALLEL ? {parallel: true, wasm_path: root + "build/v86-parallel.wasm"} : {}),
});
let serial = "";
// Raw frames of EtherType 88B5 come back with source 02:00:00:00:00:02
let echoed = 0;
emulator.bus.register("net0-send", packet => {
    if(packet.length < 14 || packet[12] !== 0x88 || packet[13] !== 0xB5 || packet[11] !== 1) return;
    const reply = Uint8Array.from(packet);
    reply.set([2, 0, 0, 0, 0, 2], 6);
    echoed++;
    set_immediate(() => emulator.bus.send("net0-receive", reply));
});
let cpu;
let snapshot;
let rounds = 0;
let booted = false;
let execution_error;
let command_sent = false;
const snapshot_markers = ["X64_PROBE_START arch=64", "X64_PROBE_OK arch=64", "X64_PROBE_START arch=32"];
const snapshots_taken = [], snapshot_bytes = [];
const transcript = directory + `v86-${tag}.serial`;
emulator.add_listener("serial0-output-byte", byte => {
    const c = String.fromCharCode(byte);
    serial += c;
    if(+process.env.SHOW_LOGS) process.stdout.write(c);
});
function inspect()
{
    const view = new DataView(cpu.wasm_memory.buffer);
    const u64 = offset => view.getBigUint64(offset, true).toString(16);
    const wide_ip = BigInt(view.getUint32(1584, true)) << 32n | BigInt(cpu.instruction_pointer[0] >>> 0);
    // Read-only diagnostic walk for this 512 MiB fixture: never alters A/D,
    // devices, TLB contents or architectural state.
    const physical = address => {
        if(!(cpu.cr[0] & 0x80000000)) return Number(address);
        if(!(view.getBigUint64(1696, true) & 0x400n)) return null;
        const ram = new DataView(cpu.mem8.buffer, cpu.mem8.byteOffset, cpu.mem8.length);
        let table = BigInt(cpu.cr[3] >>> 0) | BigInt(view.getUint32(1612, true)) << 32n;
        for(const shift of [39n, 30n, 21n, 12n])
        {
            const at = Number(table & 0xFFFFFF000n) + Number(address >> shift & 511n) * 8;
            if(at + 8 > ram.byteLength) return null;
            const entry = ram.getBigUint64(at, true);
            if(!(entry & 1n)) return null;
            if(shift === 12n || shift < 39n && entry & 128n)
            {
                const mask = (1n << shift) - 1n;
                return Number(entry & 0xFFFFFF000n & ~mask | address & mask);
            }
            table = entry;
        }
        return null;
    };
    const at = physical(wide_ip);
    return {rounds, rip: (BigInt(view.getUint32(1584, true)) << 32n | BigInt(cpu.instruction_pointer[0] >>> 0)).toString(16),
        previous_rip: (BigInt(view.getUint32(1588, true)) << 32n | BigInt(cpu.previous_ip[0] >>> 0)).toString(16),
        physical_ip: at, instruction_bytes: at === null ? null : Buffer.from(cpu.mem8.subarray(at, at + 16)).toString("hex"),
        gpr: Array.from({length: 16}, (_, i) => ((BigInt(view.getUint32(1360 + i * 4, true)) << 32n) | BigInt(view.getUint32(i < 8 ? 64 + i * 4 : 1424 + (i - 8) * 4, true))).toString(16)),
        efer: u64(1696), cs_long: view.getUint8(1744), serial_bytes: serial.length,
        extended: cpu.extended_pages ? Array.from({length: 14}, (_, i) => cpu.wm.exports.x64_ext_stat(i)) : undefined,
        page_tier: cpu.wm.exports.x64_page_stat ? Object.fromEntries(["compiled", "native", "retries", "unknown", "steps", "invalidated", "entries", "failed", "recompiled", "instructions", "templated", "evicted", "live"].map((name, i) => [name, cpu.wm.exports.x64_page_stat(i)])) : null,
        diagnostics: cpu.get_diagnostics()};
}
try
{
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    cpu = emulator.v86.cpu;
    assert.equal(typeof cpu.wm.exports.set_x64_test_capabilities, "function", "rebuild Wasm with private qualification switch");
    cpu.wm.exports.set_x64_test_capabilities(1);
    // X64_ARCH_CAPABILITIES=0: no IA32_ARCH_CAPABILITIES, so the guest also
    // runs its speculation mitigations (PTI, VERW, ITS thunks).
    if(process.env.X64_ARCH_CAPABILITIES === "0") cpu.wm.exports.set_x64_arch_capabilities(0);
    if(process.env.X64_STEP_PROFILE) cpu.wm.exports.x64_page_profile(1);
    // compiled 32-bit code in compatibility mode (the probe's i386 process)
    // X64_RELAXED_FMA=0: FMA through the exact helper, not relaxed SIMD's
    // fused multiply-adds (an A/B switch for the timings)
    if(process.env.X64_RELAXED_FMA === "0") cpu.wm.exports.ir_set_relaxed_fma(0);
    const run_cores = cpu.run_cores.bind(cpu);
    cpu.run_cores = () => {
        rounds++;
        try { return run_cores(); }
        catch(error) { execution_error = error; emulator.stop(); return 100; }
    };
    emulator.run();
    const started = performance.now();
    const deadline = performance.now() + Number(process.env.X64_LINUX_TIMEOUT || 300000);
    let next_report = performance.now() + 10000;
    while(performance.now() < deadline)
    {
        await delay(10);
        if(execution_error) throw execution_error;
        if(serial.includes("Kernel panic") || serial.includes("not implemented")) throw new Error("Guest kernel reported a failure");
        if(/localhost login:/.test(serial) && !command_sent)
        {
            // (the boot's wall time, for the boot budget of docs/simd-xsave-plan.md 12.2)
            console.log("X64_LINUX_LOGIN_MS " + Math.round(performance.now() - started));
            emulator.serial0_send("root\n");
            command_sent = true;
        }
        if(/localhost:~#/.test(serial) && !booted)
        {
            emulator.serial0_send(guest_command(true));
            booted = true;
        }
        // X64_LINUX_SNAPSHOT=1: save and restore the whole machine while the
        // probes run (threads on every CPU, pending IPIs, page functions).
        // Rounds alternate between the chunked V7 stream, written to and read
        // back from a file (no whole-snapshot buffer on either side), and the
        // single-buffer V6 format.
        for(const marker of snapshot_markers)
        {
            if(+process.env.X64_LINUX_SNAPSHOT && booted && !snapshots_taken.includes(marker) && serial.includes(marker))
            {
                snapshots_taken.push(marker);
                emulator.stop();
                if(snapshots_taken.length % 2)
                {
                    const file = await fs.promises.open(directory + `snapshot-${tag}.v7`, "w+");
                    let bytes = 0, largest = 0, chunks = 0;
                    try
                    {
                        await emulator.save_state_stream(async chunk => {
                            await file.write(chunk, 0, chunk.length, bytes);
                            bytes += chunk.length; chunks++; largest = Math.max(largest, chunk.length);
                        });
                        await emulator.restore_state_stream({size: bytes, read: async (offset, length) => {
                            const data = new Uint8Array(length);
                            const read = (await file.read(data, 0, length, offset))["bytesRead"];
                            return read === length ? data : data.subarray(0, read);
                        }});
                    }
                    finally { await file.close(); fs.rmSync(directory + `snapshot-${tag}.v7`, {force: true}); }
                    assert.ok(largest <= 1 << 20, "V7 chunks are at most 1 MiB");
                    snapshot_bytes.push({format: "V7 stream", bytes, chunks, largest_chunk: largest});
                }
                else
                {
                    const state = await emulator.save_state();
                    await emulator.restore_state(state);
                    snapshot_bytes.push({format: "V6 buffer", bytes: state.byteLength});
                }
                emulator.run();
            }
        }
        if(booted && /\r?\nX64_LINUX_BOOT_OK\r?\n/.test(serial)) break;
        if(performance.now() >= next_report)
        {
            snapshot = inspect();
            console.log("X64_LINUX_PROGRESS " + JSON.stringify(snapshot));
            fs.writeFileSync(transcript, serial);
            next_report = performance.now() + 10000;
        }
    }
    snapshot = inspect();
    assert.ok(booted && /\r?\nX64_LINUX_BOOT_OK\r?\n/.test(serial), "real x64 Linux login shell and command deadline");
    // (to login and through the probes: docs/x86-64.md's boot time, the
    // arm64 plan's E level compares its own with it)
    console.log("X64_LINUX_PROBES_MS " + Math.round(performance.now() - started));
    assert.match(serial, /\r?\nx86_64\r?\n/, "uname confirms actual x86_64 userspace");
    check_probes(serial, true);
    assert.equal(echoed, 32, "the host echoed every probe frame");
    if(glibc) console.log("X64_LINUX_GLIBC " + JSON.stringify(check_glibc(serial, usable, glibc.libraries, glibc_reference)));
    if(high_memory || extended_memory)
    {
        assert.match(serial, new RegExp(`\\n\\s*100000000-${(0x100000000 + high_memory + extended_memory - 1).toString(16)} : System RAM`),
            "kernel owns the relocated and extended RAM above 4 GiB");
    }
    if(memtest_mib)
    {
        const line = serial.match(/X64_MEMTEST mib=(\d+) pages=(\d+) errors=(\d+) extended_pages=(\d+)/);
        assert.ok(line, "memtest result: " + (serial.match(/X64_PROBE_FAIL[^\r\n]*/)?.[0] || "missing"));
        assert.equal(+line[3], 0, "memtest contents");
        if(extended_memory) assert.ok(+line[4] > +line[2] / 4, `memtest pages in extended RAM: ${line[0]}`);
        console.log("X64_LINUX_MEMTEST " + line[0] + " " + (serial.match(/MemTotal:\s*\d+ kB/)?.[0] || ""));
    }
    if(+process.env.X64_LINUX_SNAPSHOT)
    {
        assert.deepEqual(snapshots_taken, snapshot_markers, "snapshots taken during every probe phase");
        console.log("X64_LINUX_SNAPSHOT_PASS " + JSON.stringify(snapshot_bytes));
    }
    if(sleep_cycles)
    {
        const next = (name, limit_ms = 120000) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`sleep: no ${name} event; acpi ` +
                JSON.stringify(cpu.get_diagnostics().acpi) + "\n" + serial.slice(-3000))), limit_ms);
            emulator.add_listener(name, function listener(value) {
                clearTimeout(timer);
                emulator.remove_listener(name, listener);
                resolve(value);
            });
        });
        const wait_serial = async (pattern, from, what, limit_ms = 300000) => {
            const limit = performance.now() + limit_ms;
            while(!pattern.test(serial.slice(from)))
            {
                if(execution_error) throw execution_error;
                if(performance.now() > limit) throw new Error("sleep: " + what + "\n" + serial.slice(-2000));
                await delay(10);
            }
            return serial.slice(from);
        };
        const run = async (command, marker) => {
            const from = serial.length;
            emulator.serial0_send(command + "; echo " + marker + "_$((6*7))\n");
            return wait_serial(new RegExp(marker + "_42\\r?\\n"), from, command);
        };
        const value = (text, key) => +(text.match(new RegExp(key + "=(\\d+)")) || [])[1];
        const states = await run("echo STATE=$(cat /sys/power/state)", "STATES");
        // (the serial console echoes the command line too: take the output line)
        const state_line = [...states.matchAll(/STATE=([^$\r\n][^\r\n]*)/g)].at(-1)[1];
        console.log("X64_LINUX_SLEEP_STATES " + state_line);
        assert.match(state_line, /\bmem\b/, "the kernel can suspend to RAM");
        // Alpine's virt kernel has no CONFIG_HIBERNATION; the lts kernel does
        const can_hibernate = /\bdisk\b/.test(state_line);
        assert.ok(can_hibernate || flavor === "virt", "the lts kernel can hibernate");
        await run("dd if=/dev/urandom of=/tmp/s3.bin bs=1024 count=4096 2>/dev/null; md5sum /tmp/s3.bin > /tmp/s3.md5", "PATTERN");
        const online = cores === 1 ? "0" : "0-" + (cores - 1);
        for(let cycle = 1; cycle <= sleep_cycles; cycle++)
        {
            const by_rtc = cycle % 2 === 1;
            const slept = next("acpi-sleep"), woke = next("acpi-wake");
            const from = serial.length;
            // (the kernel log is cleared each cycle: over many cycles its ring buffer wraps)
            emulator.serial0_send("dmesg -c >/dev/null; " + (by_rtc ? "echo 0 > /sys/class/rtc/rtc0/wakealarm; echo +3 > /sys/class/rtc/rtc0/wakealarm; " : "") +
                "echo mem > /sys/power/state; echo RESUMED_$((" + cycle + "*7))\n");
            assert.equal(await slept, "S3");
            if(!by_rtc) { await delay(500); await emulator.power_button(); }
            assert.equal(await woke, by_rtc ? "rtc" : "power-button");
            await wait_serial(new RegExp("RESUMED_" + cycle * 7 + "\\r?\\n"), from, "resume " + cycle);
            const check = await run("md5sum -c /tmp/s3.md5 >/dev/null && echo INTACT=1; echo WAKES=$(dmesg | grep -c 'Waking up from system sleep state S3'); echo ONLINE=$(cat /sys/devices/system/cpu/online)", "CHECK");
            assert.equal(value(check, "INTACT"), 1, "RAM survives S3");
            assert.equal(value(check, "WAKES"), 1, "woke from S3");
            assert.match(check, new RegExp("ONLINE=" + online + "\\r?\\n"), "every CPU is back online");
            console.log(`X64_LINUX_S3 cycle ${cycle}: ${by_rtc ? "RTC alarm" : "power button"}, RAM intact, CPUs ${online}`);
        }
        if(can_hibernate)
        {
            const swap = await run("mkswap /dev/sdb >/dev/null && swapon /dev/sdb && echo platform > /sys/power/disk && echo 1 > /sys/power/pm_debug_messages && echo SWAP_OK=1", "SWAP");
            assert.equal(value(swap, "SWAP_OK"), 1, "swap and platform hibernation");
        }
        else console.log("X64_LINUX_S4 skipped: this kernel has no hibernation (" + state_line + ")");
        for(let cycle = 1; can_hibernate && cycle <= sleep_cycles; cycle++)
        {
            const marker = 5000 + cycle;
            await run(`echo ${marker} > /tmp/s4-marker; dmesg -c >/dev/null`, "MARK");
            const off = next("acpi-power-off");
            const from = serial.length;
            emulator.serial0_send("echo disk > /sys/power/state; echo THAWED=$(cat /tmp/s4-marker)\n");
            assert.equal(await off, "S4");
            await delay(200);
            await emulator.power_button();
            const thawed = await wait_serial(/THAWED=\d+\r?\n/, from, "restore " + cycle, 600000);
            assert.equal(value(thawed, "THAWED"), marker, "the shell continues in the restored kernel");
            // (Linux 6 logs the restore itself only with pm_debug_messages during
            // suspend to RAM; the S4 wake-up of the restored kernel is always logged)
            const check = await run("echo RESTORED=$(dmesg | grep -c 'Waking up from system sleep state S4'); echo ONLINE=$(cat /sys/devices/system/cpu/online); md5sum -c /tmp/s3.md5 >/dev/null && echo INTACT=1", "CHECK");
            assert.equal(value(check, "RESTORED"), 1, "restored from the swap image");
            assert.equal(value(check, "INTACT"), 1, "tmpfs contents came back from disk");
            assert.match(check, new RegExp("ONLINE=" + online + "\\r?\\n"), "every CPU is back online");
            console.log(`X64_LINUX_S4 cycle ${cycle}: hibernated, powered on, restored (marker ${marker}), CPUs ${online}`);
        }
        console.log("X64_LINUX_SLEEP_PASS");
    }
    if(+process.env.X64_LINUX_LIFECYCLE)
    {
        // Guest reboot (reset through the FADT/keyboard controller path the
        // kernel picks), a second boot to a shell, then poweroff into S5.
        const wait_for = async (pattern, from, what) => {
            const limit = performance.now() + Number(process.env.X64_LINUX_TIMEOUT || 300000);
            while(!pattern.test(serial.slice(from)))
            {
                if(execution_error) throw execution_error;
                if(performance.now() > limit) throw new Error("lifecycle: " + what);
                await delay(10);
            }
        };
        let mark = serial.length;
        emulator.serial0_send("reboot\n");
        await wait_for(/Linux version[\s\S]*localhost login:/, mark, "second boot to login");
        mark = serial.length;
        emulator.serial0_send("root\n");
        await wait_for(/localhost:~#/, mark, "second shell");
        mark = serial.length;
        emulator.serial0_send("uname -m; cat /sys/devices/system/cpu/online; echo X64_REBOOT_OK\n");
        await wait_for(/\r?\nX64_REBOOT_OK\r?\n/, mark, "command after reboot");
        assert.match(serial.slice(mark), /\r?\nx86_64\r?\n/, "x86_64 after reboot");
        assert.match(serial.slice(mark), new RegExp(`\\r?\\n${cores === 1 ? "0" : "0-" + (cores - 1)}\\r?\\n`), "every CPU online after reboot");
        const off = new Promise(resolve => emulator.add_listener("acpi-power-off", resolve));
        emulator.serial0_send("poweroff\n");
        const state = await Promise.race([off, delay(120000).then(() => null)]);
        if(state !== "S5")
        {
            const diagnostics = cpu.get_diagnostics();
            fs.writeFileSync(directory + `poweroff-${tag}.json`, JSON.stringify(diagnostics, null, 1));
            throw new Error("no ACPI S5 after poweroff: " + JSON.stringify(diagnostics.cores.map(core => [core.state, core.linear_ip, core.halted, core.interrupts_enabled])));
        }
        await delay(100);
        assert.ok(!emulator.is_running(), "the machine stopped in S5");
        console.log("X64_LINUX_LIFECYCLE_PASS");
    }
    fs.writeFileSync(directory + `result-${tag}.json`, JSON.stringify({...manifest, passed: true, snapshot}, null, 2) + "\n");
    console.log("X64_LINUX_PASS " + JSON.stringify(snapshot));
    if(process.env.X64_STEP_PROFILE)
    {
        const get = cpu.wm.exports.x64_page_profile_get;
        const name = key => (key & 0x10000 ? "rep " : "") + (key & 0x4000 ?
            `VEX.${key & 0x1000 ? 256 : 128}.${["", "66.", "F3.", "F2."][(key >> 10) & 3]}` : "") +
            ["", "0F ", "0F38 ", "0F3A "][(key >> 8) & 3] + (key & 0xFF).toString(16).padStart(2, "0");
        for(const [label, base] of [["X64_STEP_PROFILE", 0], ["X64_RETRY_PROFILE", 0x20000]])
        {
            const rows = [];
            for(let key = 0; key < 0x20000; key++) { const n = get(base + key); if(n) rows.push([n, key]); }
            rows.sort((a, b) => b[0] - a[0]);
            console.log(label + " " + rows.slice(0, 60).map(([n, key]) => `${name(key)}:${n}`).join(" "));
        }
        console.log("X64_REFUSED crossing=" + get(0x40000) + " fault=" + get(0x40001) + " device=" + get(0x40002) + " code=" + get(0x40003));
    }
}
catch(error)
{
    if(cpu) snapshot = inspect();
    fs.writeFileSync(directory + `result-${tag}.json`, JSON.stringify({...manifest, passed: false, error: String(error), snapshot}, null, 2) + "\n");
    console.error("X64_LINUX_FAILURE " + JSON.stringify(snapshot));
    throw error;
}
finally
{
    fs.writeFileSync(transcript, serial);
    await emulator.destroy();
}
