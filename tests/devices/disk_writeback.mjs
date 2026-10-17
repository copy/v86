#!/usr/bin/env node

// Disks written back to local files (docs/disk-persistence-plan.md D1),
// driven through the IDE ports (no guest code runs) and, for virtio-blk,
// through a queue in guest RAM of the virt machine:
// - hda read_write (a file), hdb read_only (a file read in ranges): a write
//   to hda is in the file when the command completes, FLUSH CACHE makes it
//   durable (fdatasync); hdb's file never changes;
// - IDENTIFY: hda reports a write cache, enabled (words 82, 85 bit 5); hdb
//   as before; SET FEATURES 82h turns it off (each write then durable
//   before it completes), 02h on again; the setting is in snapshots;
// - the snapshot table: read_write onto read_write, same file and
//   generation: restored; onto a read_only disk of the same file (read in
//   ranges): restored, its changes in memory dropped; a write after the
//   snapshot, a copy of the file, a read_only disk read whole: refused; a
//   read_only snapshot (changes in memory) onto read_write: refused; all
//   before anything is restored;
// - destroy() flushes and closes the file; detach_sata_drive too;
// - virtio-blk: a write is in the file, FLUSH is fdatasync, a snapshot is a
//   reference.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const root = path.resolve(__dirname, "../..") + "/";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "v86-writeback-"));
const SIZE = 4 << 20;
const make = (name, fill) =>
{
    const file = path.join(temp, name);
    const data = new Uint8Array(SIZE).map((_, i) => i * fill + (i >> 9) & 0xFF);
    data.fill(0, 0, 512);
    data.set([0xEB, 0xFE], 0);
    data.set([0x55, 0xAA], 510);
    fs.writeFileSync(file, data);
    return file;
};
const hda_file = make("hda.img", 3), hdb_file = make("hdb.img", 5);
const hdb_original = fs.readFileSync(hdb_file);
const read_file = (file, offset, length) => { const b = Buffer.alloc(length); const fd = fs.openSync(file, "r"); fs.readSync(fd, b, 0, length, offset); fs.closeSync(fd); return new Uint8Array(b); };

const bios = { url: root + "bios/seabios.bin" }, vga_bios = { url: root + "bios/vgabios.bin" };
async function machine(options)
{
    const emulator = new V86({ bios, vga_bios, graphics_adapter: "none", autostart: false, memory_size: 32 << 20, log_level: 0, ...options });
    await new Promise((resolve, reject) => { emulator.add_listener("emulator-loaded", resolve); emulator.add_listener("emulator-error", reject); });
    return emulator;
}

const DATA = 0x1F0, ERROR = 0x1F1, FEATURES = 0x1F1, COUNT = 0x1F2, LBA_LOW = 0x1F3, LBA_MID = 0x1F4, LBA_HIGH = 0x1F5, DEVICE = 0x1F6, COMMAND = 0x1F7, CONTROL = 0x3F6;
const NIEN = 0x02, DRQ = 0x08, ERR = 0x01, BSY = 0x80;
function ide(emulator)
{
    const io = emulator.v86.cpu.io;
    io.port_write8(CONTROL, NIEN);
    const status = () => io.port_read8(COMMAND);
    const command = (slave, lba, count, cmd, features = 0) =>
    {
        io.port_write8(DEVICE, 0xE0 | (slave ? 0x10 : 0) | lba >> 24 & 0x0F);
        io.port_write8(FEATURES, features);
        io.port_write8(COUNT, count);
        io.port_write8(LBA_LOW, lba & 0xFF);
        io.port_write8(LBA_MID, lba >> 8 & 0xFF);
        io.port_write8(LBA_HIGH, lba >> 16 & 0xFF);
        io.port_write8(COMMAND, cmd);
    };
    const words = n => Array.from({ length: n }, () => io.port_read16(DATA));
    const write = (slave, lba, bytes) =>
    {
        command(slave, lba, bytes.length / 512, 0x30);
        for(let i = 0; i < bytes.length; i += 2) io.port_write16(DATA, bytes[i] | bytes[i + 1] << 8);
        assert.equal(status() & (BSY | ERR | DRQ), 0, "the write completed");
    };
    // (hda's reads complete at once, those of a file read in ranges later)
    const read = async (slave, lba, count) =>
    {
        command(slave, lba, count, 0x20);
        const bytes = new Uint8Array(count * 512);
        for(let s = 0; s < count; s++)
        {
            for(let i = 0; i < 1000 && status() & BSY; i++) await new Promise(resolve => setTimeout(resolve, 1));
            assert.equal(status() & (DRQ | ERR | BSY), DRQ);
            words(256).forEach((w, i) => { bytes[s * 512 + 2 * i] = w; bytes[s * 512 + 2 * i + 1] = w >> 8; });
        }
        return bytes;
    };
    const identify = slave => { command(slave, 0, 0, 0xEC); assert.equal(status() & DRQ, DRQ); return words(256); };
    const flush_cache = slave => { command(slave, 0, 0, 0xE7); assert.equal(status() & (BSY | ERR), 0); };
    const set_features = (slave, subcommand) => { command(slave, 0, 0, 0xEF, subcommand); assert.equal(status() & (BSY | ERR), 0); };
    return { status, command, write, read, identify, flush_cache, set_features, io };
}

try
{
    const options = { hda: { url: hda_file, disk_option: "read_write" }, hdb: { url: hdb_file, async: true } };
    const emulator = await machine(options);
    const cpu = emulator.v86.cpu;
    const hda = cpu.devices.ide.primary.master.buffer, hdb = cpu.devices.ide.primary.slave.buffer;
    assert.ok(hda.writeback && !hdb.writeback);
    const d = ide(emulator);

    // stop() on a stopped machine still flushes
    await call_set(hda, 0, hda.get_from_cache(0, 512));
    assert.ok(hda.dirty_since);
    await emulator.stop();
    assert.equal(hda.dirty_since, 0, "stop(): flushed");

    // writes are in the file when they complete; FLUSH CACHE: fdatasync
    const pattern = new Uint8Array(1024).fill(0x6C);
    d.write(false, 100, pattern);
    assert.deepEqual(read_file(hda_file, 100 * 512, 1024), pattern, "hda's file has the write");
    assert.deepEqual(await d.read(false, 100, 2), pattern, "and reads it back");
    const flushes = hda.flushes;
    d.flush_cache(false);
    assert.equal(hda.flushes, flushes + 1, "FLUSH CACHE: fdatasync");
    d.write(true, 100, pattern);
    assert.deepEqual(read_file(hdb_file, 0, SIZE), new Uint8Array(hdb_original), "hdb's file does not change");
    assert.deepEqual(await d.read(true, 100, 2), pattern, "hdb's write is in memory");
    console.log("ok - read_write: a completed write is in the file, FLUSH CACHE is fdatasync; read_only: the file never changes");

    // the write cache
    let id = d.identify(false);
    assert.equal(id[82] & 1 << 5, 1 << 5, "hda: write cache supported");
    assert.equal(id[85] & 1 << 5, 1 << 5, "hda: enabled");
    id = d.identify(true);
    assert.equal(id[82] & 1 << 5, 0, "hdb: as before");
    assert.equal(id[85] & 1 << 5, 0);
    d.set_features(false, 0x82);
    assert.equal(d.identify(false)[85] & 1 << 5, 0, "SET FEATURES 82h: off");
    let before = hda.flushes;
    d.write(false, 200, pattern);
    d.write(false, 202, pattern);
    assert.equal(hda.flushes, before + 2, "write cache off: each write durable before it completes");
    const saved_off = await emulator.save_state();
    d.set_features(false, 0x02);
    assert.equal(d.identify(false)[85] & 1 << 5, 1 << 5, "02h: on again");
    before = hda.flushes;
    d.write(false, 204, pattern);
    assert.equal(hda.flushes, before, "write cache on: no flush per write");
    d.set_features(true, 0x82);
    assert.equal(d.identify(true)[85] & 1 << 5, 0, "hdb: SET FEATURES taken as before, nothing reported");
    console.log("ok - IDENTIFY reports hda's write cache (words 82, 85), SET FEATURES 82h/02h turn it off/on; hdb as before");

    // snapshots
    const state = await emulator.save_state();
    await emulator.destroy();
    assert.ok(hda.closed, "destroy() closed the file");
    {
        const same = await machine(options);
        const memory = same.v86.cpu.mem8.slice(0, 1 << 16);
        await same.restore_state(state);
        const s = ide(same);
        assert.equal(s.identify(false)[85] & 1 << 5, 1 << 5, "the write cache as saved (on)");
        assert.deepEqual(await s.read(false, 204, 2), pattern);
        await assert.rejects(same.restore_state(saved_off), /in generation .* cannot go back to it/,
            "a snapshot from before later writes");
        s.write(false, 300, pattern);
        await assert.rejects(same.restore_state(state), /in generation/, "a write after the restore: the snapshot is gone");
        same.v86.cpu.mem8.set(memory);
        await same.destroy();
        console.log("ok - snapshot onto read_write, the same file in the same generation: restored; after a write: refused");
    }
    {
        const fresh = await machine(options);
        const s = ide(fresh);
        const state2 = await fresh.save_state();
        s.write(false, 400, pattern);
        const marker = new Uint8Array([1, 2, 3, 4]);
        fresh.v86.cpu.write_blob_physical(marker, 0x1000);
        await assert.rejects(fresh.restore_state(state2), /in generation/, "a write after the save");
        assert.deepEqual(fresh.v86.cpu.read_blob_physical(0x1000, 4), marker, "nothing restored");
        const now = await fresh.save_state();
        await fresh.destroy();
        // onto a read_only disk of the same file, read in ranges
        const reader = await machine({ hda: { url: hda_file, async: true }, hdb: options.hdb });
        const r = ide(reader);
        r.write(false, 400, new Uint8Array(1024).fill(0x11));
        await reader.restore_state(now);
        assert.deepEqual(await r.read(false, 400, 2), pattern, "read_only, the same file in the same generation: its changes in memory dropped");
        assert.equal(r.identify(false)[82] & 1 << 5, 0, "and no write cache");
        await reader.destroy();
        // read whole: refused
        const whole = await machine({ hda: { url: hda_file }, hdb: options.hdb });
        await assert.rejects(whole.restore_state(now), /cannot tell whether its image is that one/);
        await whole.destroy();
        // a copy of the file
        const copy = path.join(temp, "copy.img");
        fs.copyFileSync(hda_file, copy);
        const other = await machine({ hda: { url: copy, disk_option: "read_write" }, hdb: options.hdb });
        await assert.rejects(other.restore_state(now), /is \{"path":.*hda\.img.*\} in generation .*copy\.img/);
        // and a read_only snapshot (changes in memory) onto read_write
        const memory_machine = await machine({ hda: { url: copy, async: true }, hdb: options.hdb });
        ide(memory_machine).write(false, 10, pattern);
        const in_memory = await memory_machine.save_state();
        await memory_machine.destroy();
        await assert.rejects(other.restore_state(in_memory), /has its changes in memory .* not written into/);
        await other.destroy();
        console.log("ok - snapshot onto a read_only disk of the file in ranges: restored without its changes; read whole, a copy, " +
            "changes in memory onto read_write: refused");
    }

    // the same file twice
    fs.symlinkSync(hda_file, path.join(temp, "link.img"));
    await assert.rejects(machine({ hda: { url: hda_file, disk_option: "read_write" }, hdb: { url: path.join(temp, "link.img"), async: true } }),
        /hda and hdb are the same file .* an image written back has one disk/, "by another name");
    assert.throws(() => new V86({ bios, vga_bios, graphics_adapter: "none", autostart: false,
        hda: { url: hda_file, disk_option: "read_write" }, hdb: { url: hda_file, async: true } }), /hda and hdb are the same image/);
    console.log("ok - the same file as two disks, one of them read_write: refused (by the same or another name)");

    // Q35: attach and detach a write-back drive
    {
        const q35 = await machine({ machine_type: "q35", hda: { url: hdb_file, async: true } });
        await q35.attach_sata_drive(3, { url: hda_file, disk_option: "read_write" });
        const drive = q35.v86.cpu.devices.ahci.ports[3].device.buffer;
        assert.ok(drive.writeback && !drive.closed);
        await assert.rejects(q35.attach_sata_drive(4, { url: hda_file, async: true }), /sata3 and sata4 are the same image|same file/);
        await call_set(drive, 0, new Uint8Array(512).fill(9));
        q35.detach_sata_drive(3);
        assert.ok(drive.closed, "detached: flushed and closed");
        assert.equal(drive.dirty_since, 0);
        await q35.attach_sata_drive(3, { url: hda_file, disk_option: "read_write" });
        await q35.destroy();
        console.log("ok - attach_sata_drive: a write-back drive; detach_sata_drive flushes and closes it");
    }

    // virtio-blk
    {
        const virt = await machine({ cpu_type: "arm64", bios: undefined, vga_bios: undefined, wasm_path: root + "build/v86-arm64.wasm",
            virtio_disks: [{ url: hda_file, disk_option: "read_write" }] });
        const vcpu = virt.v86.cpu;
        const disk = vcpu.virtio_devices[0].device.backend.buffer;
        const transport = vcpu.virtio_mmio[31];
        const reg = (offset, value) => value === undefined ? transport.read(offset, 4) : transport.write(offset, 4, value);
        const RAM = 0x40000000, DESC = RAM + 0x10000, AVAIL = RAM + 0x11000, USED = RAM + 0x12000, BUF = RAM + 0x20000;
        const u16 = (a, v) => vcpu.write_blob_physical(new Uint8Array([v & 0xFF, v >> 8]), a);
        const u32 = (a, v) => vcpu.write_blob_physical(new Uint8Array(new Uint32Array([v]).buffer), a);
        reg(0x070, 0); reg(0x070, 3); reg(0x024, 1); reg(0x020, 1); reg(0x024, 0); reg(0x020, 0); reg(0x070, 11);
        reg(0x030, 0); reg(0x038, 8); reg(0x080, DESC); reg(0x084, 0); reg(0x090, AVAIL); reg(0x094, 0); reg(0x0A0, USED); reg(0x0A4, 0);
        vcpu.write_blob_physical(new Uint8Array(0x3000), DESC);
        reg(0x044, 1); reg(0x070, 15);
        let avail = 0;
        const request = (type, sector, data) =>
        {
            const head = new Uint8Array(16);
            new DataView(head.buffer).setUint32(0, type, true);
            new DataView(head.buffer).setUint32(8, sector, true);
            vcpu.write_blob_physical(head, BUF);
            if(data) vcpu.write_blob_physical(data, BUF + 0x100);
            const desc = (i, address, length, flags, next) => { u32(DESC + 16 * i, address); u32(DESC + 16 * i + 4, 0); u32(DESC + 16 * i + 8, length); u16(DESC + 16 * i + 12, flags); u16(DESC + 16 * i + 14, next); };
            desc(0, BUF, 16, 1, data ? 1 : 2);
            if(data) desc(1, BUF + 0x100, data.length, 1, 2);
            desc(2, BUF + 0x1000, 1, 2, 0);
            u16(AVAIL + 4 + 2 * (avail % 8), 0);
            u16(AVAIL + 2, ++avail);
            reg(0x050, 0);
            assert.equal(vcpu.read16_physical(USED + 2), avail, "completed");
            return vcpu.read8_physical(BUF + 0x1000);
        };
        const data = new Uint8Array(512).fill(0x3C);
        assert.equal(request(1, 50, data), 0);
        assert.deepEqual(read_file(hda_file, 50 * 512, 512), data, "virtio-blk: the write is in the file");
        const f = disk.flushes;
        assert.equal(request(4, 0), 0);
        assert.equal(disk.flushes, f + 1, "FLUSH: fdatasync");
        const virt_state = await virt.save_state();
        assert.ok(virt_state.byteLength < SIZE, "the snapshot has no disk data (" + virt_state.byteLength + " bytes)");
        await virt.destroy();
        assert.ok(disk.closed);
        const again = await machine({ cpu_type: "arm64", bios: undefined, vga_bios: undefined, wasm_path: root + "build/v86-arm64.wasm",
            virtio_disks: [{ url: hda_file, disk_option: "read_write" }] });
        await again.restore_state(virt_state);
        const reopened = again.v86.cpu.virtio_devices[0].device.backend.buffer;
        await call_set(reopened, 0, new Uint8Array(512));
        await assert.rejects(again.restore_state(virt_state), /virtio_disk0 .* in generation/, "after a write: refused");
        await again.destroy();
        console.log("ok - virtio-blk: a write is in the file, FLUSH is fdatasync, the snapshot is a reference: restored, refused after a write");
    }
}
finally
{
    fs.rmSync(temp, { recursive: true, force: true });
}

function call_set(buffer, start, data)
{
    return new Promise(resolve => buffer.set(start, data, resolve));
}
console.log("disk write-back tests passed");
