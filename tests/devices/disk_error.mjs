#!/usr/bin/env node

// What a failed disk request does (docs/disk-persistence-plan.md D0, "错误处理"):
// an IDE disk whose backend fails reads and writes on request, driven
// through the ports while the guest (a boot sector spinning in `jmp $`)
// runs.
// - disk_error "stop" (the default): the request stays unfinished, the
//   machine stops, "disk-error" tells the host (disk, operation, offset,
//   length, reason, retryable); a snapshot is refused meanwhile; run()
//   retries it and the command completes; one that cannot be retried is
//   reported to the guest (ERR/ABRT) by run(); a write held is retried;
//   a reset drops a held read; destroy() and a restored snapshot drop what
//   is held;
// - disk_error "report": the guest sees ERR/ABRT at once, the machine goes on.

import assert from "node:assert/strict";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const SIZE = 1 << 20;

// (a class: state images take no plain objects)
class FlakyDisk
{
    constructor()
    {
        this.byteLength = SIZE;
        this.data = new Uint8Array(SIZE).map((_, i) => i * 13 + (i >> 9) & 0xFF);
        // a boot sector: jmp $
        this.data.fill(0, 0, 512);
        this.data.set([0xEB, 0xFE], 0);
        this.data.set([0x55, 0xAA], 510);
        /** the next reads and writes that fail, and whether they can be retried */
        this.fail_reads = 0;
        this.fail_writes = 0;
        this.retryable = true;
        this.reads = 0;
        this.writes = 0;
    }
    load() { this.onload?.({}); }
    error(what)
    {
        const error = new Error("the test's disk failed the " + what);
        if(!this.retryable) error.retryable = false;
        return error;
    }
    get(start, length, done)
    {
        this.reads++;
        if(this.fail_reads) { this.fail_reads--; done(undefined, this.error("read")); return; }
        done(this.data.slice(start, start + length));
    }
    get_and_cache(start, length, done) { this.get(start, length, done); }
    get_from_cache() { return undefined; }
    set(start, data, done)
    {
        this.writes++;
        if(this.fail_writes) { this.fail_writes--; done(this.error("write")); return; }
        this.data.set(data, start);
        done();
    }
    get_buffer(done) { done(undefined); }
    get_state() { return [this.data]; }
    set_state(state) { this.data.set(state[0]); }
}

async function machine(hda)
{
    const emulator = new V86({
        graphics_adapter: "bochs_vga",
        bios: { url: __dirname + "/../../bios/seabios.bin" },
        vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
        hda,
        autostart: true,
        memory_size: 32 * 1024 * 1024,
        log_level: 0,
    });
    const events = [];
    emulator.add_listener("disk-error", event => events.push(event));
    await new Promise(resolve => emulator.add_listener("emulator-loaded", resolve));
    // (SeaBIOS boots the disk: then the guest spins)
    const disk = hda.buffer || hda;
    for(let i = 0; i < 2000 && disk.reads === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 500));
    return { emulator, events, io: emulator.v86.cpu.io, cpu: emulator.v86.cpu };
}

const DATA = 0x1F0, ERROR = 0x1F1, COUNT = 0x1F2, LBA_LOW = 0x1F3, LBA_MID = 0x1F4, LBA_HIGH = 0x1F5, DEVICE = 0x1F6, COMMAND = 0x1F7, CONTROL = 0x3F6;
const NIEN = 0x02, SRST = 0x04, DRQ = 0x08, ERR = 0x01, BSY = 0x80, ABRT = 0x04;
const READ = 0x20, WRITE = 0x30;

function command(io, lba, count, cmd)
{
    io.port_write8(CONTROL, NIEN);
    io.port_write8(DEVICE, 0xE0 | lba >> 24 & 0x0F);
    io.port_write8(COUNT, count);
    io.port_write8(LBA_LOW, lba & 0xFF);
    io.port_write8(LBA_MID, lba >> 8 & 0xFF);
    io.port_write8(LBA_HIGH, lba >> 16 & 0xFF);
    io.port_write8(COMMAND, cmd);
}
function read_data(io, count)
{
    const bytes = new Uint8Array(count * 512);
    for(let i = 0; i < bytes.length; i += 2)
    {
        const w = io.port_read16(DATA);
        bytes[i] = w; bytes[i + 1] = w >> 8;
    }
    return bytes;
}
function write_data(io, bytes)
{
    for(let i = 0; i < bytes.length; i += 2) io.port_write16(DATA, bytes[i] | bytes[i + 1] << 8);
}
const status = io => io.port_read8(COMMAND);
const until = async (condition, what) =>
{
    for(let i = 0; i < 2000 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok(condition(), what);
};

// --- disk_error "stop" (the default) ---------------------------------------
{
    const disk = new FlakyDisk();
    const { emulator, events, io, cpu } = await machine(disk);
    assert.ok(emulator.is_running(), "the guest runs");

    // a read fails: held, the machine stops
    disk.fail_reads = 1;
    const stopped = new Promise(resolve => emulator.add_listener("emulator-stopped", resolve));
    command(io, 8, 2, READ);
    await stopped;
    assert.equal(emulator.is_running(), false, "the machine stopped");
    assert.equal(events.length, 1, "one disk-error event");
    assert.deepEqual(events[0], { disk: "hda", operation: "read", offset: 8 * 512, length: 1024,
        reason: "the test's disk failed the read", retryable: true, policy: "stop" });
    assert.equal(status(io) & BSY, BSY, "the command is not finished");
    assert.equal(cpu.disk_holds.length, 1);
    await assert.rejects(emulator.save_state(), /held after an I\/O error/, "no snapshot while a request is held");
    // run(): the read is retried and completes
    await emulator.run();
    assert.ok(emulator.is_running());
    await until(() => (status(io) & (BSY | DRQ)) === DRQ, "the retried read completes");
    assert.deepEqual(read_data(io, 2), disk.data.subarray(8 * 512, 10 * 512), "with the disk's data");
    assert.equal(cpu.disk_holds.length, 0);
    console.log("ok - stop: a failed read stops the machine (disk-error), run() retries it, the guest gets the data");

    // a write fails: held, retried by run(), lands
    disk.fail_writes = 1;
    const pattern = new Uint8Array(512).fill(0xA5);
    const stopped2 = new Promise(resolve => emulator.add_listener("emulator-stopped", resolve));
    command(io, 20, 1, WRITE);
    write_data(io, pattern);
    await stopped2;
    assert.equal(events.length, 2);
    assert.equal(events[1].operation, "write");
    assert.equal(events[1].offset, 20 * 512);
    assert.notDeepEqual(disk.data.subarray(20 * 512, 21 * 512), pattern, "the write has not landed");
    assert.equal(status(io) & BSY, BSY);
    await emulator.run();
    await until(() => (status(io) & (BSY | ERR)) === 0, "the retried write completes");
    assert.deepEqual(disk.data.subarray(20 * 512, 21 * 512), pattern, "the write landed");
    console.log("ok - stop: a failed write is held, run() retries it, it lands");

    // an error that cannot be retried: held; run() reports it to the guest
    disk.fail_reads = 1;
    disk.retryable = false;
    const stopped3 = new Promise(resolve => emulator.add_listener("emulator-stopped", resolve));
    command(io, 4, 1, READ);
    await stopped3;
    assert.equal(events[2].retryable, false);
    const reads = disk.reads;
    await emulator.run();
    await until(() => !(status(io) & BSY), "the command ends");
    assert.equal(status(io) & (ERR | DRQ), ERR, "ERR");
    assert.equal(io.port_read8(ERROR), ABRT, "ABRT");
    assert.equal(disk.reads, reads, "not retried");
    disk.retryable = true;
    command(io, 4, 1, READ);
    await until(() => (status(io) & (BSY | DRQ)) === DRQ, "the next read works");
    assert.deepEqual(read_data(io, 1), disk.data.subarray(4 * 512, 5 * 512));
    console.log("ok - stop: an error that cannot be retried is reported to the guest (ERR/ABRT) by run()");

    // a reset drops a held read
    disk.fail_reads = 1;
    const stopped4 = new Promise(resolve => emulator.add_listener("emulator-stopped", resolve));
    command(io, 4, 1, READ);
    await stopped4;
    assert.equal(cpu.disk_holds.length, 1);
    io.port_write8(CONTROL, SRST | NIEN);
    io.port_write8(CONTROL, NIEN);
    assert.equal(cpu.disk_holds.length, 0, "the reset dropped it");
    const reads2 = disk.reads;
    await emulator.run();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(disk.reads, reads2, "nothing retried");
    console.log("ok - stop: a device reset drops a held read");

    // a restored snapshot drops what is held
    await until(() => !(status(io) & BSY), "ready after the reset");
    const state = await emulator.save_state();
    disk.fail_writes = 1;
    const stopped5 = new Promise(resolve => emulator.add_listener("emulator-stopped", resolve));
    command(io, 30, 1, WRITE);
    write_data(io, pattern);
    await stopped5;
    assert.equal(cpu.disk_holds.length, 1);
    await emulator.restore_state(state);
    assert.equal(cpu.disk_holds.length, 0, "the restore dropped it");
    const writes = disk.writes;
    await emulator.run();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(disk.writes, writes, "not retried");
    console.log("ok - stop: a restored snapshot drops a held write");

    // destroy() with a request held
    disk.fail_reads = 1;
    const stopped6 = new Promise(resolve => emulator.add_listener("emulator-stopped", resolve));
    command(io, 4, 1, READ);
    await stopped6;
    await emulator.destroy();
    assert.equal(cpu.disk_holds.length, 0, "destroy() dropped it");
    console.log("ok - stop: destroy() drops a held request");
}

// --- disk_error "report" ---------------------------------------------------
{
    const disk = new FlakyDisk();
    disk.disk_error = "report";
    const { emulator, events, io } = await machine(disk);
    disk.fail_reads = 1;
    command(io, 8, 1, READ);
    await until(() => !(status(io) & BSY), "the command ends");
    assert.equal(status(io) & (ERR | DRQ), ERR, "ERR at once");
    assert.equal(io.port_read8(ERROR), ABRT, "ABRT");
    assert.equal(events.length, 1);
    assert.equal(events[0].policy, "report");
    assert.ok(emulator.is_running(), "the machine goes on");
    disk.fail_writes = 1;
    command(io, 9, 1, WRITE);
    write_data(io, new Uint8Array(512).fill(1));
    await until(() => !(status(io) & BSY), "the write ends");
    assert.equal(status(io) & ERR, ERR, "the failed write: ERR");
    assert.equal(events[1].operation, "write");
    command(io, 8, 1, READ);
    await until(() => (status(io) & (BSY | DRQ)) === DRQ, "the next read works");
    assert.deepEqual(read_data(io, 1), disk.data.subarray(8 * 512, 9 * 512));
    await emulator.destroy();
    console.log("ok - report: the guest sees ERR/ABRT at once, disk-error tells the host, the machine goes on");
}

console.log("disk error tests passed");
