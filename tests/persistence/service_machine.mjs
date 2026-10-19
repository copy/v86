#!/usr/bin/env node
// Machines whose disks are written back to a disk service
// (docs/disk-persistence-plan.md D2; tools/disk-service.mjs in this
// process), in Node, driven through the IDE ports (no guest code runs),
// the AHCI controller of Q35 and virtio-blk on the virt machine:
// - IDE: a write is in the service's file when the command completes,
//   FLUSH CACHE is the service's fdatasync, the write cache is reported;
//   save_state flushes and records the generation (mark), destroy() closes
//   the session (another writer may open it at once), a new machine
//   restores the snapshot, and after a write refuses it;
// - errors: the service gone, disk_error "stop": the write is held, the
//   machine stops, save_state is refused; the service back, run() retries
//   it, it lands; "report": ERR at once; a lost lease (another session
//   took the image over) is not retried: run() reports it to the guest;
// - Q35: a drive written back to the service, pulled out: its session
//   closed (the lease released);
// - virtio-blk: a write in the file, FLUSH.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });
const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
const { create_disk_service } = await import("../../tools/disk-service.mjs");
const root = path.resolve(__dirname, "../..") + "/";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "v86-service-machine-"));
const SIZE = 4 << 20;
for(const name of ["hda.img", "sata.img", "virtio.img"])
{
    const data = new Uint8Array(SIZE).map((_, i) => i * 5 + (i >> 9) & 0xFF);
    data.fill(0, 0, 512);
    data.set([0xEB, 0xFE], 0);
    data.set([0x55, 0xAA], 510);
    fs.writeFileSync(path.join(temp, name), data);
}
const file_bytes = (name, offset, length) => new Uint8Array(fs.readFileSync(path.join(temp, name)).subarray(offset, offset + length));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let service = create_disk_service({ dir: temp, lease_ms: 2000 });
await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
const port = service.server.address().port;
const base = "http://127.0.0.1:" + port + "/";
const writer = name => service.images.get(name)?.writer;

const bios = { url: root + "bios/seabios.bin" }, vga_bios = { url: root + "bios/vgabios.bin" };
async function machine(options)
{
    const emulator = new V86({ bios, vga_bios, graphics_adapter: "none", autostart: false, memory_size: 32 << 20, log_level: 0, ...options });
    const events = [];
    emulator.add_listener("disk-error", event => events.push(event));
    await new Promise((resolve, reject) => { emulator.add_listener("emulator-loaded", resolve); emulator.add_listener("emulator-error", reject); });
    return { emulator, events };
}
const DATA = 0x1F0, ERROR = 0x1F1, FEATURES = 0x1F1, COUNT = 0x1F2, LBA_LOW = 0x1F3, LBA_MID = 0x1F4, LBA_HIGH = 0x1F5, DEVICE = 0x1F6, COMMAND = 0x1F7, CONTROL = 0x3F6;
const DRQ = 0x08, ERR = 0x01, BSY = 0x80, ABRT = 0x04;
function ide(emulator)
{
    const io = emulator.v86.cpu.io;
    io.port_write8(CONTROL, 0x02);
    const status = () => io.port_read8(COMMAND);
    const until = async (condition, what, ms = 20000) =>
    {
        const end = Date.now() + ms;
        while(!condition()) { assert.ok(Date.now() < end, what); await wait(2); }
    };
    const command = (lba, count, cmd, features = 0) =>
    {
        io.port_write8(DEVICE, 0xE0 | lba >> 24 & 0x0F);
        io.port_write8(FEATURES, features);
        io.port_write8(COUNT, count);
        io.port_write8(LBA_LOW, lba & 0xFF);
        io.port_write8(LBA_MID, lba >> 8 & 0xFF);
        io.port_write8(LBA_HIGH, lba >> 16 & 0xFF);
        io.port_write8(COMMAND, cmd);
    };
    const start_write = (lba, bytes) =>
    {
        command(lba, bytes.length / 512, 0x30);
        for(let i = 0; i < bytes.length; i += 2) io.port_write16(DATA, bytes[i] | bytes[i + 1] << 8);
    };
    const write = async (lba, bytes) => { start_write(lba, bytes); await until(() => !(status() & BSY), "the write ends"); assert.equal(status() & ERR, 0); };
    const read = async (lba, count) =>
    {
        command(lba, count, 0x20);
        const bytes = new Uint8Array(count * 512);
        for(let s = 0; s < count; s++)
        {
            await until(() => !(status() & BSY), "the read");
            assert.equal(status() & (DRQ | ERR), DRQ);
            for(let i = 0; i < 256; i++) { const w = io.port_read16(DATA); bytes[s * 512 + 2 * i] = w; bytes[s * 512 + 2 * i + 1] = w >> 8; }
        }
        return bytes;
    };
    const identify = async () => { command(0, 0, 0xEC); await until(() => status() & DRQ, "IDENTIFY"); return Array.from({ length: 256 }, () => io.port_read16(DATA)); };
    const flush_cache = async () => { command(0, 0, 0xE7); await until(() => !(status() & BSY), "FLUSH CACHE"); assert.equal(status() & ERR, 0); };
    return { status, until, start_write, write, read, identify, flush_cache, io };
}

try
{
    // IDE
    const options = { hda: { url: base + "hda.img", disk_option: "read_write" } };
    let { emulator } = await machine(options);
    let d = ide(emulator);
    const hda = emulator.v86.cpu.devices.ide.primary.master.buffer;
    assert.ok(hda.writeback && typeof hda.prepare_snapshot === "function", "the disk service's backend");
    assert.ok(writer("hda.img"), "a write session");
    const pattern = new Uint8Array(1024).fill(0x6A);
    await d.write(100, pattern);
    assert.deepEqual(file_bytes("hda.img", 100 * 512, 1024), pattern, "in the service's file when the command completes");
    assert.deepEqual(await d.read(100, 2), pattern);
    const flushes = service.stats.flushes;
    await d.flush_cache();
    assert.equal(service.stats.flushes, flushes + 1, "FLUSH CACHE: the service's fdatasync");
    assert.equal((await d.identify())[85] & 1 << 5, 1 << 5, "the write cache reported");
    const state = await emulator.save_state();
    await emulator.destroy();
    assert.equal(writer("hda.img"), null, "destroy(): the session closed");
    ({ emulator } = await machine(options));
    await emulator.restore_state(state);
    d = ide(emulator);
    assert.deepEqual(await d.read(100, 2), pattern);
    await d.write(300, pattern);
    await assert.rejects(emulator.restore_state(state), /hda .* in generation/, "after a write: refused");
    await emulator.destroy();
    console.log("ok - IDE on a disk service: writes in the file, FLUSH CACHE, the write cache; save, destroy (session closed), restore; refused after a write");

    // the service gone: stop holds the write, run() retries it once the service is back
    {
        const m = await machine(options);
        d = ide(m.emulator);
        await service.close();
        d.start_write(400, pattern);
        await d.until(() => m.events.length === 1, "disk-error after the retries", 30000);
        assert.equal(m.events[0].operation, "write");
        assert.equal(m.events[0].retryable, true);
        assert.equal(m.events[0].policy, "stop");
        assert.equal(d.status() & BSY, BSY, "held");
        await assert.rejects(m.emulator.save_state(), /held after an I\/O error/);
        service = create_disk_service({ dir: temp, lease_ms: 2000 });
        await new Promise(resolve => service.server.listen(port, "127.0.0.1", resolve));
        // (the service restarted: it does not know the session, which only a
        // new machine opens again. The held write's retry is refused: held
        // again, not to be retried; the next run() reports it to the guest)
        m.emulator.v86.run();
        m.emulator.v86.stop();
        await d.until(() => m.events.length === 2, "the retry refused");
        assert.equal(m.events[1].retryable, false);
        assert.match(m.events[1].reason, /another session writes the image now|not the image's writer/);
        m.emulator.v86.run();
        m.emulator.v86.stop();
        await d.until(() => !(d.status() & BSY), "the write ends");
        assert.equal(d.status() & ERR, ERR, "the session was gone with the service: the guest sees an error");
        await m.emulator.destroy();
    }
    {
        // a service that comes back with the session (a network outage)
        const m = await machine(options);
        d = ide(m.emulator);
        const saved_listeners = service.server.listeners("request");
        service.server.removeAllListeners("request");
        service.server.on("request", (req, res) => { req.socket.destroy(); });
        d.start_write(500, pattern);
        await d.until(() => m.events.length === 1, "disk-error after the retries", 30000);
        assert.equal(m.events[0].retryable, true);
        service.server.removeAllListeners("request");
        for(const listener of saved_listeners) service.server.on("request", listener);
        m.emulator.v86.run();
        m.emulator.v86.stop();
        await d.until(() => !(d.status() & BSY), "the retried write ends");
        assert.equal(d.status() & ERR, 0, "the network back: run() retried the write");
        assert.deepEqual(file_bytes("hda.img", 500 * 512, 1024), pattern, "it landed");
        await m.emulator.destroy();
    }
    console.log("ok - the service unreachable: the write held (disk_error stop), save_state refused; run() retries it (lands, or reports a session gone with the service)");

    // report; a lost lease
    {
        const m = await machine({ hda: { url: base + "hda.img", disk_option: "read_write", disk_error: "report" } });
        d = ide(m.emulator);
        const disk = m.emulator.v86.cpu.devices.ide.primary.master.buffer;
        clearTimeout(disk.renew_timer);
        service.images.get("hda.img").writer.expires = 0;
        const other = await fetch(base + "hda.img", { method: "POST", headers: { "X-V86-Disk-Op": "open" } });
        assert.equal(other.status, 200, "another session takes the image over");
        d.start_write(600, pattern);
        await d.until(() => !(d.status() & BSY), "the write ends");
        assert.equal(d.status() & ERR, ERR, "report: ERR at once");
        assert.equal(d.io.port_read8(ERROR), ABRT);
        assert.equal(m.events[0].retryable, false, "a lost lease is not retried");
        await m.emulator.destroy();
        const answer = await other.json();
        await fetch(base + "hda.img", { method: "POST", headers: { "X-V86-Disk-Op": "close", "X-V86-Disk-Session": answer.session, "X-V86-Disk-Epoch": String(answer.epoch) } });
    }
    console.log("ok - report: ERR/ABRT at once; a lost lease is not retried");

    // Q35: pulled out, the session closed
    {
        const m = await machine({ machine_type: "q35" });
        await m.emulator.attach_sata_drive(3, { url: base + "sata.img", disk_option: "read_write" });
        assert.ok(writer("sata.img"));
        m.emulator.detach_sata_drive(3);
        await d.until(() => writer("sata.img") === null, "the session closed");
        await m.emulator.destroy();
    }
    console.log("ok - Q35: a drive written back to the service, pulled out: its session closed");

    // virtio-blk
    {
        const m = await machine({ cpu_type: "arm64", bios: undefined, vga_bios: undefined, wasm_path: root + "build/v86-arm64.wasm",
            virtio_disks: [{ url: base + "virtio.img", disk_option: "read_write" }] });
        const vcpu = m.emulator.v86.cpu;
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
        const request = async (type, sector, data) =>
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
            for(let i = 0; i < 5000 && vcpu.read16_physical(USED + 2) !== avail; i++) await wait(1);
            assert.equal(vcpu.read16_physical(USED + 2), avail, "completed");
            return vcpu.read8_physical(BUF + 0x1000);
        };
        const data = new Uint8Array(512).fill(0x3C);
        assert.equal(await request(1, 50, data), 0);
        assert.deepEqual(file_bytes("virtio.img", 50 * 512, 512), data, "virtio-blk: the write is in the service's file");
        const before = service.stats.flushes;
        assert.equal(await request(4, 0), 0);
        assert.equal(service.stats.flushes, before + 1, "FLUSH: the service's fdatasync");
        await m.emulator.destroy();
        assert.equal(writer("virtio.img"), null);
    }
    console.log("ok - virtio-blk on a disk service: a write in the file, FLUSH");
}
finally
{
    await service.close();
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log("service machine tests passed");
