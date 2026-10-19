#!/usr/bin/env node
// Guests on disks written back (docs/disk-persistence-plan.md D1, "验收矩阵"):
// - Linux 4.16 (images/linux4.iso, from the CD drive), on Q35 (AHCI, NCQ)
//   and i440FX (IDE), hda a local file with disk_option "read_write", hdb a
//   file read_only: Linux sees hda's write cache enabled, hdb's not; data
//   written with fsync reaches the backend's flush and is in hda's file
//   after destroy(); writes written out without a FLUSH (sync of a block
//   device) are in the file when they complete; hdparm -W0 turns the cache
//   off and each write is then flushed; hdb's file never changes; a
//   snapshot saved and restored into a new machine ("save and power off")
//   goes on with the disk as it was (busybox 1.28 here: dd has no oflag);
// - power loss: an ext2 file system on a disk that records its writes and
//   keeps only the flushed ones when "power" is lost: every FLUSH the
//   guest issues completes after the writes completed before it are
//   flushed; a file synced before the loss is intact after it, the file
//   system mounts (the guest has no fsck, the host neither: busybox only);
// - MS-DOS 6.22 (images/msdos622.img), which never sends FLUSH CACHE: its
//   writes reach the file's stable storage by the timed flush.
//   PARTS=linux-q35,linux-ide,power,dos (default: all)

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });
const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const PARTS = (process.env.PARTS || "linux-q35,linux-ide,power,dos").split(",");
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const ROOT = path.resolve(__dirname, "../..") + "/";
const IMAGES = ROOT + "images/";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "v86-writeback-guest-"));
const md5 = bytes => crypto.createHash("md5").update(bytes).digest("hex");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(options)
{
    const emulator = new V86({
        graphics_adapter: "bochs_vga", bios: { url: ROOT + "bios/seabios.bin" }, vga_bios: { url: ROOT + "bios/vgabios.bin" },
        memory_size: 256 << 20, autostart: true, screen_dummy: true, log_level: 0, ...options,
    });
    const machine = { emulator, serial: "" };
    emulator.add_listener("serial0-output-byte", byte =>
    {
        const c = String.fromCharCode(byte);
        if(SHOW_LOGS) process.stdout.write(c);
        machine.serial += c;
    });
    await new Promise((resolve, reject) => { emulator.add_listener("emulator-loaded", resolve); emulator.add_listener("emulator-error", reject); });
    return machine;
}
function wait_for(what, predicate, timeout_ms)
{
    return new Promise((resolve, reject) =>
    {
        const begin = Date.now();
        const check = () =>
        {
            if(predicate()) return resolve();
            if(Date.now() - begin > timeout_ms) return reject(new Error("timed out waiting for " + what));
            setTimeout(check, 50);
        };
        check();
    });
}
const PROMPT = /~% $/;
async function command(machine, cmd, timeout_ms = 120000)
{
    machine.serial = "";
    machine.emulator.serial0_send(cmd + "\n");
    await wait_for(JSON.stringify(cmd), () => PROMPT.test(machine.serial), timeout_ms);
    return machine.serial.slice(cmd.length).replace(PROMPT, "");
}
const disk_buffer = (emulator, name) => emulator.v86.cpu.disk_devices().find(([n]) => n === name)[1].buffer;
/**
 * Wrap a drive's FLUSH CACHE (IDEInterface.when_writes_done: the devices
 * are not extensible, the prototype's method is wrapped for this one)
 * @return {function()} undo
 */
function on_flush_command(device, wrap)
{
    const prototype = Object.getPrototypeOf(device);
    const original = prototype.when_writes_done;
    prototype.when_writes_done = function(callback, ...rest)
    {
        return original.call(this, this === device ? wrap(callback) : callback, ...rest);
    };
    return () => { prototype.when_writes_done = original; };
}

async function linux(machine_type)
{
    const tag = "linux (" + (machine_type === "q35" ? "Q35, AHCI" : "i440FX, IDE") + ")";
    const hda_file = path.join(temp, "linux-" + machine_type + "-hda.img"), hdb_file = path.join(temp, "linux-" + machine_type + "-hdb.img");
    fs.writeFileSync(hda_file, new Uint8Array(0));
    fs.truncateSync(hda_file, 64 << 20);
    fs.writeFileSync(hdb_file, new Uint8Array(8 << 20).map((_, i) => i * 7 & 0xFF));
    const hdb_sum = md5(fs.readFileSync(hdb_file));
    const options = { machine_type, cdrom: { url: IMAGES + "linux4.iso" },
        hda: { url: hda_file, disk_option: "read_write" }, hdb: { url: hdb_file, async: true } };
    let machine = await start(options);
    await wait_for("the shell", () => PROMPT.test(machine.serial), 240000);
    const hda = disk_buffer(machine.emulator, "hda");

    const cache = await command(machine, "cat /sys/block/sda/queue/write_cache /sys/block/sdb/queue/write_cache; dmesg | grep 'Write cache'");
    assert.match(cache, /write back\s+write through/, "sda: write back, sdb: write through: " + cache);
    assert.match(cache, /\[sda\] Write cache: enabled/);
    assert.match(cache, /\[sdb\] Write cache: disabled/);
    console.log("ok - " + tag + ": Linux sees hda's write cache enabled (write back), hdb's not");

    // written and synced: in the file after destroy()
    const sum = (await command(machine, "dd if=/dev/urandom of=/tmp/x bs=1k count=2048 2>/dev/null; md5sum /tmp/x")).match(/[0-9a-f]{32}/)[0];
    const requests = hda.flush_requests;
    await command(machine, "dd if=/tmp/x of=/dev/sda bs=64k conv=fsync 2>/dev/null");
    assert.ok(hda.flush_requests > requests, "fsync: the guest's FLUSH reached the backend (" + (hda.flush_requests - requests) + ")");
    // completed writes (written out by sync, which sends no FLUSH for a
    // block device): in the file, without a flush
    const device = machine.emulator.v86.cpu.disk_devices().find(([n]) => n === "hda")[1];
    let flush_commands = 0;
    const undo = on_flush_command(device, callback => { flush_commands++; return callback; });
    const written = (await command(machine, "dd if=/dev/urandom of=/tmp/y bs=4k count=16 2>/dev/null; md5sum /tmp/y")).match(/[0-9a-f]{32}/)[0];
    await command(machine, "dd if=/tmp/y of=/dev/sda bs=4k seek=1024 2>/dev/null; sync");
    const in_file = Buffer.alloc(65536);
    const fd = fs.openSync(hda_file, "r");
    fs.readSync(fd, in_file, 0, 65536, 4 << 20);
    fs.closeSync(fd);
    assert.equal(flush_commands, 0, "no FLUSH CACHE");
    assert.equal(md5(in_file), written, "completed writes are in the file, before any flush");
    // hdparm -W0: the cache off, each write flushed
    const off = await command(machine, "hdparm -W0 /dev/sda; cat /sys/block/sda/queue/write_cache");
    assert.match(off, /setting drive write-caching to 0 \(off\)/, off);
    assert.equal(device.write_cache_enabled, false, "the drive's write cache is off");
    let writes = hda.writes, flushes = hda.flushes;
    await command(machine, "dd if=/tmp/y of=/dev/sda bs=4k seek=2048 2>/dev/null; sync");
    assert.ok(hda.writes > writes && hda.flushes - flushes >= hda.writes - writes,
        "each write flushed: " + (hda.writes - writes) + " writes, " + (hda.flushes - flushes) + " fdatasync");
    await command(machine, "hdparm -W1 /dev/sda");
    assert.equal(device.write_cache_enabled, true);
    writes = hda.writes;
    flushes = hda.flushes;
    await command(machine, "dd if=/tmp/x of=/dev/sda bs=4k seek=4096 count=64 2>/dev/null; sync");
    assert.ok(hda.flushes - flushes < hda.writes - writes, "the cache on again: not each write flushed (" +
        (hda.writes - writes) + " writes, " + (hda.flushes - flushes) + " fdatasync)");
    undo();
    console.log("ok - " + tag + ": completed writes are in the file without a flush; hdparm -W0: each write flushed, -W1: not");
    // hdb: written by the guest, its file unchanged
    await command(machine, "dd if=/dev/urandom of=/dev/sdb bs=64k count=16 2>/dev/null; sync");

    // save and power off, then go on in a new machine
    const state = await machine.emulator.save_state();
    await machine.emulator.destroy();
    assert.ok(hda.closed, "destroy() closed hda's file");
    assert.equal(md5(fs.readFileSync(hda_file).subarray(0, 2 << 20)), sum, "after destroy(): hda's file has the synced data");
    assert.equal(md5(fs.readFileSync(hdb_file)), hdb_sum, "hdb's file is unchanged");
    machine = await start({ ...options, autostart: false });
    await machine.emulator.restore_state(state);
    await machine.emulator.run();
    const after = await command(machine, "echo 3 > /proc/sys/vm/drop_caches; dd if=/dev/sda bs=64k count=32 2>/dev/null | md5sum");
    assert.ok(after.includes(sum), "the restored machine reads the disk: " + after);
    await command(machine, "dd if=/dev/zero of=/dev/sda bs=4k count=1 seek=4000 conv=fsync 2>/dev/null");
    await machine.emulator.destroy();
    console.log("ok - " + tag + ": synced data is in the file after destroy(); hdb's file unchanged; saved, powered off, restored, going on");
}

/**
 * A disk written back that keeps what it was told to flush, and loses the
 * rest when the power goes (a buffer object of one's own with the backend
 * contract)
 */
class PowerLossDisk
{
    constructor(size)
    {
        this.durable = new Uint8Array(size);
        this.byteLength = size;
        /** @type {!Map<number, !Uint8Array>} sectors written, not flushed */
        this.volatile = new Map();
        this.disk_option = "read_write";
        this.completed = 0;
        this.flushed_upto = 0;
        this.flushes = 0;
        this.lost = false;
    }
    load() { this.onload?.({}); }
    get(start, length, done) { done(this.get_from_cache(start, length)); }
    get_and_cache(start, length, done) { this.get(start, length, done); }
    get_from_cache(start, length)
    {
        const data = this.durable.slice(start, start + length);
        for(let s = start / 512; s < (start + length) / 512; s++)
        {
            const sector = this.volatile.get(s);
            if(sector) data.set(sector, s * 512 - start);
        }
        return data;
    }
    set(start, data, done)
    {
        if(this.lost) { done(); return; }
        for(let i = 0; i < data.length; i += 512) this.volatile.set(start / 512 + i / 512, data.slice(i, i + 512));
        this.completed++;
        done();
    }
    flush(done)
    {
        if(!this.lost)
        {
            for(const [s, sector] of this.volatile) this.durable.set(sector, s * 512);
            this.volatile.clear();
            this.flushed_upto = this.completed;
            this.flushes++;
        }
        done();
    }
    close(done) { this.flush(done); }
    mark() { return this.generation(); }
    generation() { return String(this.completed); }
    get_buffer(done) { done(undefined); }
    get_state() { return ["v86-writeback", 1, "{}", this.generation(), this.byteLength]; }
    set_state() {}
    check_state() {}
    power_loss() { this.volatile.clear(); this.lost = true; }
}

async function power()
{
    const disk = new PowerLossDisk(64 << 20);
    let machine = await start({ machine_type: "q35", cdrom: { url: IMAGES + "linux4.iso" }, hda: disk });
    await wait_for("the shell", () => PROMPT.test(machine.serial), 240000);
    // every FLUSH CACHE: when it completes, the writes completed before it was issued are flushed
    const device = machine.emulator.v86.cpu.disk_devices().find(([n]) => n === "hda")[1];
    let checked = 0;
    const undo = on_flush_command(device, callback =>
    {
        const completed = disk.completed;
        return () =>
        {
            assert.ok(disk.flushed_upto >= completed, "FLUSH completed with " + (completed - disk.flushed_upto) + " earlier writes not flushed");
            checked++;
            callback();
        };
    });
    await command(machine, "mke2fs -q /dev/sda >/dev/null 2>&1; mkdir -p /mnt; mount /dev/sda /mnt && echo mounted");
    const sum = (await command(machine, "dd if=/dev/urandom of=/mnt/a bs=1k count=1024 2>/dev/null; sync; md5sum /mnt/a")).match(/[0-9a-f]{32}/)[0];
    // (another file, written out by the flusher thread at once, no FLUSH:
    // completed writes, not durable)
    await command(machine, "echo 1 > /proc/sys/vm/dirty_writeback_centisecs; echo 1 > /proc/sys/vm/dirty_expire_centisecs; " +
        "dd if=/dev/urandom of=/mnt/b bs=1k count=1024 2>/dev/null; sleep 3; echo written");
    assert.ok(checked > 0, "the guest's FLUSH commands were checked (" + checked + ")");
    const lost = disk.volatile.size;
    assert.ok(lost > 0, "writes completed and not flushed when the power goes");
    disk.power_loss();
    undo();
    await machine.emulator.destroy();
    console.log("ok - power loss: " + checked + " FLUSH commands, each after the writes before it were flushed; " + lost + " sectors not flushed are lost");
    // the disk as it was when the power went: the synced file is intact
    const after = new PowerLossDisk(64 << 20);
    after.durable = disk.durable;
    machine = await start({ machine_type: "q35", cdrom: { url: IMAGES + "linux4.iso" }, hda: after });
    await wait_for("the shell", () => PROMPT.test(machine.serial), 240000);
    const out = await command(machine, "mkdir -p /mnt; mount /dev/sda /mnt && echo mounted; md5sum /mnt/a; ls /mnt");
    assert.match(out, /mounted/, out);
    assert.ok(out.includes(sum), "the file synced before the power loss is intact: " + out);
    await machine.emulator.destroy();
    console.log("ok - power loss: the file system mounts, the file synced before is intact");
}

async function dos()
{
    const file = path.join(temp, "msdos622.img");
    fs.copyFileSync(IMAGES + "msdos622.img", file);
    const machine = await start({ hda: { url: file, disk_option: "read_write" }, memory_size: 32 << 20, screen_dummy: false });
    const hda = disk_buffer(machine.emulator, "hda");
    const device = machine.emulator.v86.cpu.disk_devices().find(([n]) => n === "hda")[1];
    let flush_commands = 0;
    const undo = on_flush_command(device, callback => { flush_commands++; return callback; });
    const screen = () => machine.emulator.screen_adapter ? machine.emulator.screen_adapter.get_text_screen().join("\n") : "";
    let stable = 0;
    await wait_for("C:\\>", () =>
    {
        const lines = screen().split("\n").filter(l => l.trim());
        stable = lines.length && lines[lines.length - 1].trim() === "C:\\>" ? stable + 1 : 0;
        return stable >= 20;
    }, 120000);
    await wait(1500);
    const flushes = hda.flushes;
    await machine.emulator.keyboard_send_text("echo WRITTEN BACK BY DOS > C:\\DOSDATA.TXT\n", 20);
    await wait_for("the write", () => hda.dirty_since, 30000);
    await wait_for("the timed flush", () => hda.flushes > flushes, 10000);
    assert.equal(flush_commands, 0, "MS-DOS sent no FLUSH CACHE");
    assert.ok(fs.readFileSync(file).includes("WRITTEN BACK BY DOS"), "the file has the text");
    undo();
    await machine.emulator.destroy();
    console.log("ok - MS-DOS (no FLUSH CACHE): its write reached the file and was flushed by the timed flush");
}

try
{
    if(PARTS.includes("linux-q35")) await linux("q35");
    if(PARTS.includes("linux-ide")) await linux("i440fx");
    if(PARTS.includes("power")) await power();
    if(PARTS.includes("dos")) await dos();
}
finally
{
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log("write-back guest tests passed");
