#!/usr/bin/env node
// Alpine 3.24 aarch64 installed to a virtio-blk disk on v86
// (docs/arm64-virt-android16-plan.md P5.4, A3), in one machine session:
// 1. from the ISO, `setup-disk -m sys` (no swap, no boot loader: the machine
//    boots its kernel directly, as the reference does) installs onto an
//    empty disk from a local repository disk, offline (the virt ISO has no
//    kernel package: tools/alpine_repo.mjs --arch aarch64 --set sys); the
//    installed files' MD5s, fsck -n; the installed /boot's kernel and
//    initramfs written to an export disk;
// 2. the machine reboots into the installed system: its own kernel and
//    initramfs (read from the export disk), its root by UUID; the same
//    files' MD5s; a clean reboot;
// 3. back into the ISO: the root file system is clean (fsck -n).
// Writes stay in the disks' in-memory overlays for the session. The disks
// are found by their virtio-blk serials. A64_TRANSPORT=pci: the disks are
// virtio-pci functions on the PCIe host (P5.7) instead of virtio-mmio.
//
//     [A64_JIT=1] [A64_CORES=N] [A64_TRANSPORT=pci] node tests/a64/linux_install.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { prepare, ROOT } from "../lib/alpine_image.mjs";
import { output_directory } from "../../tools/alpine_repo.mjs";

const cores = Number(process.env.A64_CORES || 1);
const jit = !!+process.env.A64_JIT;
const transport = process.env.A64_TRANSPORT || "mmio";
assert.ok(["mmio", "pci"].includes(transport), "A64_TRANSPORT is mmio or pci");
const timeout = Number(process.env.A64_LINUX_TIMEOUT || 1800000);
const prepared = await prepare("aarch64-virt", ["boot/vmlinuz-virt", "boot/initramfs-virt", "boot/modloop-virt"]);
const repo_image = path.join(output_directory("aarch64"), "sys-repo.tar");
assert.ok(fs.existsSync(repo_image), repo_image + " is missing: node tools/alpine_repo.mjs --arch aarch64 --set sys");
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const array_buffer = file => { const b = fs.readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const MiB = 1 << 20;
const disks = [
    { buffer: array_buffer(prepared.iso), id: "a64iso", readonly: true },
    { buffer: new ArrayBuffer(768 * MiB), id: "a64target" },
    { buffer: array_buffer(repo_image), id: "a64repo", readonly: true },
    { buffer: new ArrayBuffer(128 * MiB), id: "a64export" },
];
const export_disk = disks[3].buffer;

const LIVE_CMDLINE = "console=ttyAMA0 earlycon nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage";
const disk_cmdline = uuid => `console=ttyAMA0 earlycon nokaslr panic=-1 root=UUID=${uuid} rootfstype=ext4 modules=ext4`;
// (shell: the disk with a serial, as $name)
const find = (name, serial) => `${name}=; for d in /sys/block/vd*; do [ "$(cat $d/serial 2>/dev/null)" = ${serial} ] && ${name}=/dev/\${d##*/}; done; `;
const DISKS = find("T", "a64target") + find("R", "a64repo") + find("E", "a64export");
// (the repository disk's tar, as the only repository: setup-disk stops the
// modloop service, which unmounts the boot media)
const REPOSITORY = "mkdir -p /tmp/repo && tar -xf $R -C /tmp/repo && echo /tmp/repo/main > /etc/apk/repositories; ";
const MD5 = root => `md5sum ${root}/bin/busybox ${root}/etc/alpine-release ${root}/sbin/apk | sed -e 's, ${root}/, /,' -e 's/^/A64_MD5 /'; `;

const iso_boot = { kernel: array_buffer(prepared.kernel), initrd: array_buffer(prepared.initrd), cmdline: LIVE_CMDLINE };
const emulator = new V86({
    cpu_type: "arm64", graphics_adapter: "none", cpu_cores: cores, memory_size: 512 << 20, log_level: 0,
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm",
    kernel: { buffer: iso_boot.kernel }, initrd: { buffer: iso_boot.initrd }, cmdline: LIVE_CMDLINE,
    virtio_disks: disks, virtio_transport: transport, autostart: true, ...(jit ? { jit_switches: { a64_page: 1 } } : {}),
});
let transcript = "";
emulator.add_listener("serial0-output-byte", byte => {
    transcript += String.fromCharCode(byte);
    if(+process.env.A64_VERBOSE) process.stdout.write(String.fromCharCode(byte));
});
const text = () => transcript.replace(/\r/g, "");
/** Wait until `pattern` matches the transcript after `from` */
function wait_for(pattern, what, from)
{
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`no ${what} after ${timeout} ms:\n${text().slice(-2000)}`)); }, timeout);
        const poll = setInterval(() => {
            const match = text().slice(from).match(pattern);
            if(match) { clearTimeout(timer); clearInterval(poll); resolve(match); }
            else if(/Kernel panic/.test(text().slice(from))) { clearTimeout(timer); clearInterval(poll); reject(new Error(`${what}: kernel panic:\n${text().slice(-2000)}`)); }
        }, 50);
    });
}
/** Log in on the serial console (the boot from `from`) and run `commands`; the transcript from there */
async function session(name, commands, done)
{
    const from = text().length;
    const started = performance.now();
    await wait_for(/login: ?(\x1b\[[0-9;]*[A-Za-z])*$/, name + " login prompt", from);
    emulator.serial0_send("root\n");
    // (busybox's ash asks the terminal for the cursor position after its prompt: ESC [ 6 n)
    await wait_for(/:~# ?(\x1b\[[0-9;]*[A-Za-z])*$/, name + " shell", from);
    const at = text().length;
    emulator.serial0_send(commands);
    await wait_for(done, name + " end", at);
    console.log(`${name}: ${Math.round(performance.now() - started)} ms`);
    return text().slice(at);
}
const md5s = output => [...output.matchAll(/^A64_MD5 (\w+) +(\S+)$/gm)].map(m => m[2] + " " + m[1]).sort();
const value = (output, name) => output.match(new RegExp(`^${name}=(\\S+)$`, "m"))?.[1];

/** The files of a ustar image on a disk */
function untar(buffer)
{
    const bytes = new Uint8Array(buffer), files = {};
    for(let at = 0; at + 512 <= bytes.length;)
    {
        const name = new TextDecoder().decode(bytes.subarray(at, at + 100)).replace(/\0.*$/s, "");
        if(!name) break;
        const size = parseInt(new TextDecoder().decode(bytes.subarray(at + 124, at + 136)), 8) || 0;
        files[name.replace(/^\.\//, "")] = bytes.slice(at + 512, at + 512 + size).buffer;
        at += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
}

try
{
    // 1. from the ISO: setup-disk, the installed files' MD5s, fsck, /boot exported
    const setup = await session("setup", DISKS + REPOSITORY +
        "ERASE_DISKS=$T setup-disk -m sys -s 0 -B none $T > /tmp/setup.log 2>&1; echo A64_SETUP=$?; tail -3 /tmp/setup.log; " +
        "echo A64_UUID=$(blkid ${T}2 | grep -o ' UUID=\"[^\"]*\"' | cut -d'\"' -f2); mount ${T}2 /mnt && " + MD5("/mnt") + "umount /mnt; " +
        "fsck.ext4 -fn ${T}2; echo A64_FSCK=$?; mount ${T}1 /mnt && tar -cf $E -C /mnt vmlinuz-virt initramfs-virt && umount /mnt; " +
        "sync; echo A64_EXPORTED\n", /\nA64_EXPORTED\n/);
    assert.equal(value(setup, "A64_SETUP"), "0", "setup-disk -m sys:\n" + setup.slice(-1500));
    assert.equal(value(setup, "A64_FSCK"), "0", "the installed root file system, fsck -n");
    const uuid = value(setup, "A64_UUID");
    assert.ok(uuid && uuid.length >= 32, "the root file system's UUID");
    const installed = md5s(setup);
    assert.equal(installed.length, 3, "the installed files' MD5s");

    // 2. reboot into the installed system: its kernel and initramfs, its root
    const boot = untar(export_disk);
    assert.ok(boot["vmlinuz-virt"] && boot["initramfs-virt"], "the installed kernel and initramfs on the export disk");
    emulator.v86.cpu.boot_files = { ...emulator.v86.cpu.boot_files, kernel: boot["vmlinuz-virt"], initrd: boot["initramfs-virt"],
        cmdline: disk_cmdline(uuid) };
    emulator.serial0_send("reboot\n");
    const system = await session("installed", "cat /proc/cmdline; uname -r; " + MD5("") + "echo A64_INSTALLED_UP\n",
        /\nA64_INSTALLED_UP\n/);
    assert.ok(system.includes("root=UUID=" + uuid), "booted with the installed root");
    assert.deepEqual(md5s(system), installed, "the installed files, as the installer left them");

    // 3. back into the ISO: the root file system after the installed system's clean reboot
    emulator.v86.cpu.boot_files = { ...emulator.v86.cpu.boot_files, ...iso_boot };
    emulator.serial0_send("reboot\n");
    const check = await session("fsck", DISKS + REPOSITORY + "apk add -q e2fsprogs > /dev/null 2>&1; fsck.ext4 -fn ${T}2; echo A64_FSCK=$?\n",
        /\nA64_FSCK=\d+\n/);
    assert.equal(value(check, "A64_FSCK"), "0", "the root file system after the installed system ran, fsck -n");
    console.log(`linux_install: ${uuid}; ${installed.join(", ")}; passed`);
}
finally
{
    fs.writeFileSync(prepared.directory + `v86${jit ? "-jit" : ""}-install${transport === "pci" ? "-pci" : ""}-${cores}c.log`, transcript);
    await emulator.destroy();
}
process.exit(0);
