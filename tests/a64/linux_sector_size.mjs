#!/usr/bin/env node
// Linux on virtio-blk disks of 4096-byte logical sectors (docs/disk-image-formats-plan.md,
// the appendix's "4K 逻辑扇区"): the pinned Alpine 3.24 aarch64 kernel and
// initramfs (tests/lib/alpine_image.mjs; ALPINE_CACHE=<dir> where another
// worktree keeps the ISO) on the virt machine, with an init of the test's
// (rdinit) that loads virtio_mmio and virtio_blk. Three disks: a RAW one
// with logical_sector_size 4096, a VHDX image with 4096-byte sectors
// (tests/image/tiny_vhdx.mjs) and a RAW one of 512-byte sectors. The guest
// must see each disk's logical block size (blk_size) and size, read what
// the host put there, write 2 MiB that it reads back after dropping its
// caches and that the host finds in the image, and report no I/O errors.

import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { prepare, unzboot, ROOT } from "../lib/alpine_image.mjs";
import { build_vhdx } from "../image/tiny_vhdx.mjs";

process.on("unhandledRejection", exn => { throw exn; });

const SHOW_LOGS = +process.env.SHOW_LOGS;
const TIMEOUT = Number(process.env.A64_LINUX_TIMEOUT || 300000);
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const prepared = await prepare("aarch64-virt", ["boot/vmlinuz-virt", "boot/initramfs-virt"]);
const directory = prepared.directory + "sector-size/";
fs.mkdirSync(directory + "root", { recursive: true });
const disk_commands = "for d in /sys/block/vd*; do n=${d##*/}; s=$($B cat $d/serial); " +
    "$B echo \"S4K_DISK $s $($B cat $d/queue/logical_block_size) $($B cat $d/queue/physical_block_size) $($B cat $d/size) " +
    "$($B dd if=/dev/$n bs=4096 count=1024 2>/dev/null | $B md5sum | $B cut -c1-32)\"; " +
    "$B dd if=/tmp/x of=/dev/$n bs=4096 seek=1000 conv=fsync 2>/dev/null || $B echo \"S4K_WRITE_FAILED $s\"; done; " +
    "$B echo 3 > /proc/sys/vm/drop_caches; " +
    "for d in /sys/block/vd*; do n=${d##*/}; $B echo \"S4K_BACK $($B cat $d/serial) " +
    "$($B dd if=/dev/$n bs=4096 skip=1000 count=512 2>/dev/null | $B md5sum | $B cut -c1-32)\"; done";
fs.writeFileSync(directory + "root/s4k-init", [
    "#!/bin/busybox sh",
    "B=/bin/busybox",
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH",
    "$B mount -t proc proc /proc; $B mount -t sysfs sys /sys; $B mount -t devtmpfs dev /dev",
    "$B mkdir -p /tmp; $B mount -t tmpfs tmp /tmp",
    "modprobe virtio_mmio; modprobe virtio_blk",
    "for i in 1 2 3 4 5 6 7 8 9 10; do [ -e /sys/block/vdc ] && break; $B sleep 1; done",
    "$B dd if=/dev/urandom of=/tmp/x bs=4096 count=512 2>/dev/null",
    "$B echo \"S4K_DATA $($B md5sum /tmp/x | $B cut -c1-32)\"",
    disk_commands,
    "$B dmesg | $B grep -i -E 'I/O error|virtio_blk' | $B sed 's/^/S4K_DMESG /'",
    "$B echo S4K_DONE",
    "$B poweroff -f",
    ""].join("\n"), { mode: 0o755 });
const tar = spawnSync("bsdtar", ["--format", "newc", "--uid", "0", "--gid", "0", "--no-xattrs", "--no-mac-metadata",
    "-cf", directory + "s4k.cpio", "-C", directory + "root", "s4k-init"], { encoding: "utf8" });
assert.equal(tar.status, 0, tar.stderr);
const initrd = Buffer.concat([fs.readFileSync(prepared.initrd), fs.readFileSync(directory + "s4k.cpio")]);
const kernel = unzboot(fs.readFileSync(prepared.kernel));
const array_buffer = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

const md5 = bytes => create_hash("md5").update(bytes).digest("hex");
const RAW_SIZE = 16 << 20, VHDX_SIZE = 24 << 20;
const raw = new Uint8Array(RAW_SIZE).map((_, i) => i * 7 + (i >> 12) & 0xFF);
const raw512 = new Uint8Array(RAW_SIZE).map((_, i) => i * 5 + (i >> 9) & 0xFF);
const vhdx_data = new Uint8Array(4 << 20).map((_, i) => i * 13 + (i >> 9) & 0xFF);
const vhdx = build_vhdx({ size: VHDX_SIZE, logical_sector_size: 4096, data: [[0, vhdx_data]] });
// (before the guest writes into the RAW disks' buffers)
const expected = {
    raw4k: [4096, RAW_SIZE, md5(raw.subarray(0, 4 << 20))],
    vhdx4k: [4096, VHDX_SIZE, md5(vhdx_data)],
    raw512: [512, RAW_SIZE, md5(raw512.subarray(0, 4 << 20))],
};

const emulator = new V86({
    cpu_type: "arm64", graphics_adapter: "none", memory_size: 512 << 20, log_level: 0, autostart: true,
    wasm_path: process.env.A64_WASM || ROOT + "build/v86-arm64.wasm",
    kernel: { buffer: array_buffer(kernel) }, initrd: { buffer: array_buffer(initrd) },
    cmdline: "console=ttyAMA0 earlycon nokaslr panic=-1 rdinit=/s4k-init",
    virtio_disks: [
        { buffer: raw.buffer, logical_sector_size: 4096, id: "raw4k" },
        { buffer: vhdx.image.buffer, format: "vhdx", id: "vhdx4k" },
        { buffer: raw512.buffer, id: "raw512" },
    ],
});
let serial = "";
emulator.add_listener("serial0-output-byte", byte =>
{
    const c = String.fromCharCode(byte);
    if(SHOW_LOGS) process.stdout.write(c);
    serial += c;
});
const started = Date.now();
while(!/S4K_DONE/.test(serial))
{
    if(Date.now() - started > TIMEOUT)
    {
        console.log(serial.slice(-4000));
        throw new Error("timed out waiting for S4K_DONE");
    }
    await new Promise(resolve => setTimeout(resolve, 100));
}
const text = serial.replace(/\r/g, "");
const data_sum = text.match(/^S4K_DATA ([0-9a-f]{32})/m)?.[1];
assert.ok(data_sum, "the data written");
const disks = Object.fromEntries([...text.matchAll(/^S4K_DISK (\S+) (\d+) (\d+) (\d+) ([0-9a-f]{32})/gm)].map(m => [m[1], m.slice(2)]));
const back = Object.fromEntries([...text.matchAll(/^S4K_BACK (\S+) ([0-9a-f]{32})/gm)].map(m => [m[1], m[2]]));
for(const [id, [block, size, sum]] of Object.entries(expected))
{
    assert.ok(disks[id], id + ": seen by the guest: " + text.slice(-3000));
    assert.deepEqual(disks[id], [String(block), String(block), String(size / 512), sum], id + ": block sizes, size, the first 4 MiB");
    assert.equal(back[id], data_sum, id + ": the 2 MiB written, read back");
}
assert.ok(!/S4K_WRITE_FAILED|S4K_DMESG.*I\/O error/.test(text), "no I/O errors: " + text.slice(-3000));
assert.equal(md5(raw.subarray(1000 * 4096, 1512 * 4096)), data_sum, "raw4k: the image holds the guest's data");
assert.equal(md5(raw512.subarray(1000 * 4096, 1512 * 4096)), data_sum, "raw512: likewise");
const vhdx_disk = emulator.disk_buffer("virtio_disk1");
const in_vhdx = await new Promise((resolve, reject) => vhdx_disk.get(1000 * 4096, 2 << 20, (data, error) => error ? reject(error) : resolve(data)));
assert.equal(md5(in_vhdx), data_sum, "vhdx4k: the disk image holds it (in its overlay)");
await emulator.destroy();
console.log("ok - Linux (Alpine 3.24 aarch64) on virtio-blk: 4096-byte logical blocks on the RAW and the VHDX disk, 512 on the other; " +
    "reads, 2 MiB written and read back, in the images; " + Math.round((Date.now() - started) / 1000) + " s");
console.log("linux_sector_size: passed");
