#!/usr/bin/env node

// USB disks in a guest (usb.mass_storage, docs/usb.md,
// docs/modern-pc-devices-plan.md U2): Alpine 3.24 x86_64 (uhci-hcd,
// usb-storage, sd-mod) with a disk image on the UHCI controller. The disk
// seen (vendor, model, removable, size), data written through it and read
// back by SHA-256 on both sides of the image (the guest's page cache
// dropped), the time it took, a FAT file system made, mounted, written,
// unmounted and found in the image; a read-only disk attached at run time
// (writes refused), detached; the disk out of its port and back; an eject
// ("usb-disk-ejected"); a snapshot.
// Env: MACHINE (i440fx, q35), CPU_CORES (1), TEST_RELEASE_BUILD, SHOW_LOGS,
// USB_CONTROLLER (uhci; ehci: the disk at high speed, 480M, on the EHCI;
// xhci: at SuperSpeed, 5000M, on a USB 3 root port),
// USB_DISK_MB (64: the image; the data written is a quarter of it, at most 32 MiB),
// USB_WRITE_MB (none: a step that writes that many MiB, 16 MiB of random
// data again and again, reads them back and checks each copy, with the
// times: the plan's 1 GiB measure, USB_DISK_MB=1040 USB_WRITE_MB=1024).

import assert from "node:assert/strict";
import { createHash as create_hash } from "node:crypto";
import url from "node:url";
import { prepare as prepare_alpine } from "../lib/alpine_image.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = __dirname + "../../";
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const CPU_CORES = +process.env.CPU_CORES || 1;
const MACHINE = process.env.MACHINE || "i440fx";
const CONTROLLER = process.env.USB_CONTROLLER || "uhci";
const DISK_MB = +process.env.USB_DISK_MB || 64;
const WRITE_MB = +process.env.USB_WRITE_MB || 0;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const prepared = await prepare_alpine("x86_64-virt");
const directory = ROOT + "build/x64-linux/";
const image = new Uint8Array(DISK_MB << 20);
const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: ROOT + "bios/seabios.bin" },
    vga_bios: { url: ROOT + "bios/vgabios.bin" },
    bzimage: { url: directory + "boot/vmlinuz-virt" },
    initrd: { url: directory + "boot/initramfs-virt" },
    cdrom: { url: directory + prepared.image.name },
    cmdline: "console=ttyS0,115200 loglevel=4 nokaslr modules=loop,squashfs,sd-mod,usb-storage",
    memory_size: 512 * 1024 * 1024,
    cpu_type: "x86_64",
    cpu_cores: CPU_CORES,
    experimental_smp_jit: CPU_CORES > 1,
    machine_type: MACHINE,
    acpi: true,
    net_device: { type: "none" },
    usb: { controller: CONTROLLER, tablet: false, mass_storage: [{ id: "stick", image: { buffer: image.buffer } }] },
    autostart: true,
    log_level: 0,
});

const overall_timeout = setTimeout(() => {
    console.log("\nTimeout. Serial output since the last command:\n" + serial);
    process.exit(1);
}, 1800 * 1000);

let serial = "";
let waiter = null;
emulator.add_listener("serial0-output-byte", byte =>
{
    const chr = String.fromCharCode(byte);
    if(SHOW_LOGS) process.stdout.write(chr);
    serial += chr;
    if(waiter && waiter.pattern.test(serial))
    {
        const { resolve } = waiter;
        waiter = null;
        resolve(serial);
    }
});
const ejected = [];
emulator.add_listener("usb-disk-ejected", id => ejected.push(id));

const PROMPT = /:~# (\x1b\[6n)?$/;
function wait_serial(pattern, what, timeout_ms)
{
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for " + what + ":\n" + serial.slice(-3000))), timeout_ms);
        waiter = { pattern, resolve: text => { clearTimeout(timer); resolve(text); } };
        if(pattern.test(serial))
        {
            waiter = null;
            clearTimeout(timer);
            resolve(serial);
        }
    });
}
async function command(cmd, timeout_ms = 120000)
{
    serial = "";
    emulator.serial0_send(cmd + "\n");
    const output = await wait_serial(PROMPT, JSON.stringify(cmd), timeout_ms);
    return output.slice(cmd.length).replace(PROMPT, "");
}
let passed = 0;
async function step(name, f)
{
    const start = Date.now();
    await f();
    passed++;
    console.log("ok - " + name + " (" + ((Date.now() - start) / 1000).toFixed(1) + " s)");
}
const sha256 = bytes => create_hash("sha256").update(bytes).digest("hex");
/**
 * The SCSI disks in /sys/block, once `until` (a shell test) holds or after 30 s
 * @param {string} until
 * @return {!Promise<!Array<string>>}
 */
async function scsi_disks(until)
{
    const output = await command("for i in $(seq 30); do " + until + " && break; sleep 1; done; echo BLO''CKS $(ls /sys/block | grep sd)");
    return output.match(/^BLOCKS(.*)$/m)[1].trim().split(/\s+/).filter(Boolean);
}
/** The block device of a USB disk by its SCSI model, once it is there */
async function block_device(gone = false)
{
    const output = await command("for i in $(seq 30); do " + (gone ? "! " : "") + "grep -l 'USB Disk' /sys/block/sd*/device/model >/dev/null 2>&1 && break; " +
        "sleep 1; done; for d in /sys/block/sd*; do [ -e $d/device/model ] && echo $(basename $d) $(cat $d/device/vendor) $(cat $d/device/model) " +
        "$(cat $d/removable) $(cat $d/size) $(cat $d/ro); done");
    return output.split("\n").map(line => line.trim().split(/\s+/)).filter(f => /^sd[a-z]$/.test(f[0]))
        .map(f => ({ name: f[0], vendor: f[1], model: f[2] + " " + f[3], removable: +f[4], sectors: +f[5], ro: +f[6] }));
}

console.log("Booting Alpine x86_64 with a USB disk of " + DISK_MB + " MiB (" + CONTROLLER + ", " + MACHINE + ", " + CPU_CORES + " core" +
    (CPU_CORES > 1 ? "s" : "") + ")");
await wait_serial(/login: $/, "the login prompt", 600000);
serial = "";
emulator.serial0_send("root\n");
await wait_serial(PROMPT, "the shell", 120000);

let disk;
await step("usb-storage: the disk is sda, \"v86\" \"USB Disk\", removable, its size", async () => {
    const disks = await block_device();
    assert.equal(disks.length, 1, JSON.stringify(disks));
    disk = disks[0];
    assert.deepEqual([disk.vendor, disk.model, disk.removable, disk.sectors, disk.ro], ["v86", "USB Disk", 1, DISK_MB * 2048, 0]);
    // (the SCSI device's host's parent: the USB interface; its device's speed)
    const driver = await command("basename $(readlink /sys/block/" + disk.name + "/device/../../../driver)");
    assert.match(driver, /usb-storage/);
    const speed = await command("echo SPE''ED $(cat /sys/block/" + disk.name + "/device/../../../../speed)");
    assert.match(speed, CONTROLLER === "xhci" ? /^SPEED 5000$/m : CONTROLLER === "ehci" ? /^SPEED 480$/m : /^SPEED 12$/m);
});

await step("data written through the disk is in the image, and read back the same (SHA-256 on both sides)", async () => {
    // (from /tmp, a tmpfs of half the guest's memory)
    const mb = Math.min(DISK_MB / 4, 32);
    const output = await command("dd if=/dev/urandom of=/tmp/data bs=1M count=" + mb + " 2>/dev/null; sha256sum /tmp/data; " +
        "t=$(date +%s); dd if=/tmp/data of=/dev/" + disk.name + " bs=64k seek=16 conv=fsync 2>/dev/null; echo WROTE $(( $(date +%s) - t )); " +
        "echo 3 > /proc/sys/vm/drop_caches; t=$(date +%s); dd if=/dev/" + disk.name + " bs=64k skip=16 count=" + mb * 16 + " 2>/dev/null | sha256sum; " +
        "echo READ $(( $(date +%s) - t ))", 1200000);
    const sums = Array.from(output.matchAll(/^([0-9a-f]{64})/gm), m => m[1]);
    assert.equal(sums.length, 2, output);
    assert.equal(sums[1], sums[0], "read back");
    assert.equal(sha256(image.subarray(1 << 20, (1 + mb) << 20)), sums[0], "the image");
    const wrote = +output.match(/WROTE (\d+)/)[1], read = +output.match(/READ (\d+)/)[1];
    console.log("  " + mb + " MiB written in " + wrote + " s, read in " + read + " s (guest clock)");
});

if(WRITE_MB)
{
    await step(WRITE_MB + " MiB written (16 MiB of random data again and again), read back, each copy checked in the image", async () => {
        const copies = Math.ceil(WRITE_MB / 16);
        const output = await command("dd if=/dev/urandom of=/tmp/block bs=1M count=16 2>/dev/null; sha256sum /tmp/block; t=$(date +%s); i=0; " +
            "while [ $i -lt " + copies + " ]; do dd if=/tmp/block of=/dev/" + disk.name + " bs=1M seek=$((1 + i * 16)) 2>/dev/null; i=$((i + 1)); done; " +
            "sync; echo WROTE $(( $(date +%s) - t )); echo 3 > /proc/sys/vm/drop_caches; t=$(date +%s); i=0; " +
            "while [ $i -lt " + copies + " ]; do dd if=/dev/" + disk.name + " bs=1M skip=$((1 + i * 16)) count=16 2>/dev/null | sha256sum; i=$((i + 1)); done " +
            "| sort | uniq -c; echo READ $(( $(date +%s) - t ))", 3600000);
        const block = output.match(/^([0-9a-f]{64})/m)[1];
        assert.match(output, new RegExp("^\\s*" + copies + " " + block, "m"), "every copy read back: " + output);
        for(let i = 0; i < copies; i++)
        {
            assert.equal(sha256(image.subarray((1 + i * 16) << 20, (17 + i * 16) << 20)), block, "copy " + i + " in the image");
        }
        const wrote = +output.match(/WROTE (\d+)/)[1], read = +output.match(/READ (\d+)/)[1];
        console.log("  " + copies * 16 + " MiB written in " + wrote + " s (" + (copies * 16 / wrote).toFixed(1) + " MiB/s), read in " + read + " s (" +
            (copies * 16 / read).toFixed(1) + " MiB/s, guest clock)");
    });
}

await step("a FAT file system: made, mounted, a file written, unmounted (sync); the file in the image", async () => {
    // (markers split in the command, so that its echo does not match them)
    const output = await command("modprobe vfat; mkfs.vfat /dev/" + disk.name + " >/dev/null && mkdir -p /mnt/usb && " +
        "mount -t vfat /dev/" + disk.name + " /mnt/usb && echo v86-usb-disk-check > /mnt/usb/HELLO.TXT && umount /mnt/usb && echo DO''NE", 300000);
    assert.match(output, /^DONE/m);
    assert.ok(Buffer.from(image).includes("v86-usb-disk-check"), "the file's text in the image");
    assert.ok(Buffer.from(image).includes("HELLO   TXT"), "its directory entry");
});

let ro_disk;
const ro_image = new Uint8Array(4 << 20).fill(0x5A);
await step("usb_attach_disk(read_only): sdb, read only; a write refused; the image unchanged; usb_detach_disk: gone", async () => {
    await emulator.usb_attach_disk("ro", { buffer: ro_image.buffer }, { read_only: true });
    assert.equal((await scsi_disks("[ $(ls /sys/block | grep -c sd) = 2 ]")).length, 2);
    ro_disk = (await block_device()).find(d => d.name !== disk.name);
    assert.equal(ro_disk.ro, 1);
    const write = await command("dd if=/dev/zero of=/dev/" + ro_disk.name + " bs=512 count=1 oflag=direct 2>&1; echo STA''TUS $?");
    assert.match(write, /^STATUS [1-9]/m);
    assert.ok(ro_image.every(b => b === 0x5A));
    const read = await command("dd if=/dev/" + ro_disk.name + " bs=1M count=1 2>/dev/null | sha256sum");
    assert.equal(read.trim().slice(0, 64), sha256(ro_image.subarray(0, 1 << 20)));
    await emulator.usb_detach_disk("ro");
    assert.deepEqual(await scsi_disks("[ ! -e /sys/block/" + ro_disk.name + " ]"), [disk.name]);
});

await step("out of its port and back (usb_plug): gone, then the same disk again", async () => {
    await emulator.usb_plug("stick", false);
    assert.deepEqual(await scsi_disks("! ls /sys/block | grep -q sd"), []);
    await emulator.usb_plug("stick", true);
    disk = (await block_device())[0];
    assert.equal(disk.sectors, DISK_MB * 2048);
    const output = await command("mount -t vfat /dev/" + disk.name + " /mnt/usb && cat /mnt/usb/HELLO.TXT && umount /mnt/usb");
    assert.match(output, /^v86-usb-disk-check/m);
});

await step("a snapshot: restored, the disk reads as before", async () => {
    const state = await emulator.save_state();
    await emulator.restore_state(state);
    serial = "";
    emulator.serial0_send("\n");
    await wait_serial(PROMPT, "the shell after restoring", 30000);
    const output = await command("mount -t vfat /dev/" + disk.name + " /mnt/usb && cat /mnt/usb/HELLO.TXT && umount /mnt/usb");
    assert.match(output, /^v86-usb-disk-check/m);
});

await step("eject: the guest ejects the medium (\"usb-disk-ejected\"), the disk has none then", async () => {
    // (-s: SCSI's ALLOW MEDIUM REMOVAL and START STOP UNIT, not the CD drive's ioctl)
    const output = await command("eject -s /dev/" + disk.name + "; echo STA''TUS $?; sleep 1; cat /sys/block/" + disk.name + "/size");
    assert.match(output, /^STATUS 0/m, output);
    assert.deepEqual(ejected, ["stick"]);
    assert.match(output, /^\s*0\s*$/m, "no medium: size 0");
});

clearTimeout(overall_timeout);
await emulator.destroy();
console.log("PASS: " + passed + " steps");
