#!/usr/bin/env node
// Linux on disks of 4096-byte logical sectors (docs/disk-image-formats-plan.md,
// the appendix's "4K 逻辑扇区"): the kernel of images/linux4.iso (Linux 4.16)
// booted directly with its CD as the root, two such disks, a RAW one
// (logical_sector_size 4096) and a VHDX image with 4096-byte sectors
// (tests/image/tiny_vhdx.mjs), on
// - i440FX: IDE (ata_piix), with DMA;
// - Q35: AHCI (native command queuing).
// (Not PIO: this kernel's libata counts PIO data blocks of 512 bytes for
// reads and writes whatever the sector size, and waits for an interrupt
// after each, where the device asks for one per 4096-byte block as ATA
// has it; tests/devices/disk_sector_size.js checks the PIO protocol.)
// The guest's sd driver must see 4096-byte logical (and physical) blocks
// and the disks' size; it reads what the host put there, writes 2 MiB
// whose MD5 the host finds in the image, reads it back after dropping its
// caches; it sees no libata errors. SECTOR_GUEST selects machines (ide,
// ahci; comma separated).

import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build_vhdx } from "./tiny_vhdx.mjs";

process.on("unhandledRejection", exn => { throw exn; });

const root = fileURLToPath(new URL("../../", import.meta.url));
const SHOW_LOGS = +process.env.SHOW_LOGS;
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const ISO = root + "images/linux4.iso";
const MACHINES = process.env.SECTOR_GUEST ? process.env.SECTOR_GUEST.split(",") : ["ide", "ahci"];

/**
 * A file from an ISO9660 image (plain names, without version or Rock Ridge),
 * as tests/devices/acpi_guest.js reads the kernel
 * @param {string} file
 * @param {!Array<string>} names
 * @return {!ArrayBuffer}
 */
function iso_file(file, names)
{
    const iso = fs.readFileSync(file);
    let extent = iso.readUInt32LE(16 * 2048 + 156 + 2), size = iso.readUInt32LE(16 * 2048 + 156 + 10);
    for(const name of names)
    {
        let found = false;
        for(let at = extent * 2048; at < extent * 2048 + size;)
        {
            const length = iso[at];
            if(!length) { at = (Math.floor(at / 2048) + 1) * 2048; continue; }
            const entry = iso.toString("latin1", at + 33, at + 33 + iso[at + 32]).replace(/;\d+$/, "").replace(/\.$/, "");
            if(entry === name)
            {
                extent = iso.readUInt32LE(at + 2);
                size = iso.readUInt32LE(at + 10);
                found = true;
                break;
            }
            at += length;
        }
        assert.ok(found, name + " in " + file);
    }
    return iso.buffer.slice(iso.byteOffset + extent * 2048, iso.byteOffset + extent * 2048 + size);
}
const bzimage = iso_file(ISO, ["BOOT", "BZIMAGE"]);

const md5 = bytes => create_hash("md5").update(bytes).digest("hex");
const RAW_SIZE = 32 << 20, VHDX_SIZE = 48 << 20;
const PROMPT = /~% $/;

for(const kind of MACHINES)
{
    const raw = new Uint8Array(RAW_SIZE).map((_, i) => i * 7 + (i >> 12) & 0xFF);
    const vhdx_data = new Uint8Array(4 << 20).map((_, i) => i * 13 + (i >> 9) & 0xFF);
    const vhdx = build_vhdx({ size: VHDX_SIZE, logical_sector_size: 4096, data: [[0, vhdx_data]] });
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        bios: { url: root + "bios/seabios.bin" },
        vga_bios: { url: root + "bios/vgabios.bin" },
        machine_type: kind === "ahci" ? "q35" : undefined,
        memory_size: 256 << 20,
        autostart: true,
        log_level: 0,
        cdrom: { url: ISO },
        bzimage: { buffer: bzimage },
        cmdline: "root=/dev/sr0 nokaslr",
        hda: { buffer: raw.buffer, logical_sector_size: 4096 },
        hdb: { buffer: vhdx.image.buffer, format: "vhdx" },
    });
    let serial = "";
    emulator.add_listener("serial0-output-byte", byte =>
    {
        const c = String.fromCharCode(byte);
        if(SHOW_LOGS) process.stdout.write(c);
        serial += c;
    });
    const wait = async (what, timeout) =>
    {
        const start = Date.now();
        while(!PROMPT.test(serial))
        {
            if(Date.now() - start > timeout) throw new Error(kind + ": timed out waiting for " + what + "; serial:\n" + serial.slice(-2000));
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    };
    const command = async (text, timeout = 120000) =>
    {
        serial = "";
        emulator.serial0_send(text + "\n");
        await wait(JSON.stringify(text), timeout);
        return serial.slice(text.length).replace(PROMPT, "");
    };
    try
    {
        await wait("the shell", 300000);
        const sizes = await command("for d in sda sdb; do echo DISK $d $(cat /sys/block/$d/queue/logical_block_size) " +
            "$(cat /sys/block/$d/queue/physical_block_size) $(cat /sys/block/$d/size); done");
        const disk = name => sizes.match(new RegExp("DISK " + name + " (\\d+) (\\d+) (\\d+)"))?.slice(1).map(Number);
        assert.deepEqual(disk("sda"), [4096, 4096, RAW_SIZE / 512], kind + ": sda (RAW): " + sizes);
        assert.deepEqual(disk("sdb"), [4096, 4096, VHDX_SIZE / 512], kind + ": sdb (VHDX): " + sizes);
        const dmesg = await command("dmesg");
        assert.match(dmesg, /\[sda\] 8192 4096-byte logical blocks/, kind + ": sd's message for sda");
        assert.match(dmesg, /\[sdb\] 12288 4096-byte logical blocks/, kind + ": sd's message for sdb");
        if(kind === "ide") assert.match(dmesg, /ata1\.00: configured for MWDMA2/, "DMA: " + dmesg);
        if(kind === "ahci") assert.match(dmesg, /ata1\.00: .*NCQ \(depth/, "NCQ: " + dmesg);

        // what the host put there
        const read = await command("dd if=/dev/sda bs=4096 count=1024 2>/dev/null | md5sum; dd if=/dev/sdb bs=4096 count=1024 2>/dev/null | md5sum");
        const read_sums = read.match(/[0-9a-f]{32}/g);
        assert.deepEqual(read_sums, [md5(raw.subarray(0, 4 << 20)), md5(vhdx_data)], kind + ": the disks' first 4 MiB: " + read);

        // 2 MiB written, at 4096-byte sector 1000 of sda and 3000 of sdb
        const written = await command("dd if=/dev/urandom of=/tmp/x bs=4096 count=512 2>/dev/null; md5sum /tmp/x; " +
            "dd if=/tmp/x of=/dev/sda bs=4096 seek=1000 conv=fsync 2>/dev/null; dd if=/tmp/x of=/dev/sdb bs=4096 seek=3000 conv=fsync 2>/dev/null; " +
            "echo 3 > /proc/sys/vm/drop_caches; dd if=/dev/sda bs=4096 skip=1000 count=512 2>/dev/null | md5sum; " +
            "dd if=/dev/sdb bs=4096 skip=3000 count=512 2>/dev/null | md5sum; " +
            // (and in 512-byte reads, which the page cache makes 4096-byte ones)
            "dd if=/dev/sdb bs=512 skip=24000 count=4096 2>/dev/null | md5sum");
        const sums = written.match(/[0-9a-f]{32}/g);
        assert.ok(sums && sums.length === 4 && sums.every(s => s === sums[0]), kind + ": read back what was written: " + written);
        assert.equal(md5(raw.subarray(1000 * 4096, 1512 * 4096)), sums[0], kind + ": the RAW image holds the guest's data");
        const hdb = emulator.disk_buffer("hdb");
        const in_vhdx = await new Promise((resolve, reject) => hdb.get(3000 * 4096, 2 << 20, (data, error) => error ? reject(error) : resolve(data)));
        assert.equal(md5(in_vhdx), sums[0], kind + ": the VHDX disk holds the guest's data (in its overlay)");
        assert.equal(md5(raw.subarray(1512 * 4096, 1513 * 4096)), md5(new Uint8Array(4096).map((_, i) => (1512 * 4096 + i) * 7 + (1512) & 0xFF)),
            kind + ": the sector after the write is unchanged");

        const errors = await command("dmesg");
        assert.ok(!/exception Emask|failed command|hard resetting link|I\/O error|timeout/i.test(errors), kind + ": no disk errors: " + errors);
        console.log("ok - " + kind + ": Linux sees 4096-byte logical blocks on the RAW and the VHDX disk, reads them, writes 2 MiB, " +
            "reads it back; the images hold it");
    }
    finally
    {
        await emulator.destroy();
    }
}
console.log("sector size guest tests passed");
