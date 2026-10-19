#!/usr/bin/env node
// virtio-blk's failed requests and FLUSH (docs/disk-persistence-plan.md D0),
// the test the driver through the virtio-mmio registers and a queue in
// guest RAM (as tests/a64/device_io_reset.mjs). The disk's writes complete
// after a delay the test sets per write; its reads and writes fail on
// request.
// - FLUSH waits for the writes issued before it, not for those issued
//   after it (write A, FLUSH, a slower write B: FLUSH completes before B);
// - disk_error "stop" (the default): a failed write is held, the FLUSH
//   behind it waits; run() retries the write, then the FLUSH completes; a
//   failed read is held and retried; "disk-error" tells the host;
// - disk_error "report": a failed read and write complete with
//   VIRTIO_BLK_S_IOERR at once.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

const SIZE = 1 << 20;
// (a class: state images take no plain objects)
class SlowDisk
{
    constructor(policy)
    {
        this.byteLength = SIZE;
        this.data = new Uint8Array(SIZE).map((_, i) => i * 7 + (i >> 9) & 0xFF);
        /** @type {!Map<number, number>} the delay of a write, by its offset */
        this.latency = new Map();
        this.fail_reads = 0;
        this.fail_writes = 0;
        this.writes_landed = [];
        if(policy) this.disk_error = policy;
    }
    load() { this.onload?.({}); }
    get(start, length, done)
    {
        if(this.fail_reads) { this.fail_reads--; done(undefined, new Error("the test's disk failed the read")); return; }
        done(this.data.slice(start, start + length));
    }
    get_and_cache(start, length, done) { this.get(start, length, done); }
    get_from_cache() { return undefined; }
    set(start, data, done)
    {
        if(this.fail_writes) { this.fail_writes--; done(new Error("the test's disk failed the write")); return; }
        const land = () => { this.data.set(data, start); this.writes_landed.push(start); done(); };
        const delay = this.latency.get(start);
        if(delay) setTimeout(land, delay); else land();
    }
    get_buffer(done) { done(undefined); }
    get_state() { return [this.data]; }
    set_state(state) { this.data.set(state[0]); }
}

async function machine(disk)
{
    const emulator = new V86({
        cpu_type: "arm64", graphics_adapter: "none", memory_size: 16 << 20, autostart: false, log_level: 0,
        wasm_path: process.env.A64_WASM || root + "build/v86-arm64.wasm", virtio_disks: [{ buffer: disk }],
    });
    await new Promise((resolve, reject) => {
        emulator.add_listener("emulator-loaded", resolve);
        emulator.add_listener("emulator-error", reject);
    });
    const events = [];
    emulator.add_listener("disk-error", event => events.push(event));
    const cpu = emulator.v86.cpu;
    const transport = cpu.virtio_mmio[31];
    const reg = (offset, value) => value === undefined ? transport.read(offset, 4) : transport.write(offset, 4, value);
    const RAM = 0x40000000, DESC = RAM + 0x10000, AVAIL = RAM + 0x11000, USED = RAM + 0x12000, BUFFERS = RAM + 0x20000;
    const QUEUE = 16;
    const u16 = (address, value) => cpu.write_blob_physical(new Uint8Array([value & 0xFF, value >> 8]), address);
    const u32 = (address, value) => cpu.write_blob_physical(new Uint8Array(new Uint32Array([value]).buffer), address);
    const used_idx = () => cpu.read16_physical(USED + 2);
    reg(0x070, 0);
    reg(0x070, 1 | 2);
    reg(0x024, 1); reg(0x020, 1); // VIRTIO_F_VERSION_1
    reg(0x024, 0); reg(0x020, 0);
    reg(0x070, 1 | 2 | 8);
    reg(0x030, 0); reg(0x038, QUEUE);
    reg(0x080, DESC); reg(0x084, 0); reg(0x090, AVAIL); reg(0x094, 0); reg(0x0A0, USED); reg(0x0A4, 0);
    cpu.write_blob_physical(new Uint8Array(0x3000), DESC);
    reg(0x044, 1);
    reg(0x070, 1 | 2 | 8 | 4);
    let avail = 0, slot = 0;
    /** Queue one request (not notified yet): its head and its status */
    const queue = (type, sector, data_length, data) =>
    {
        const n = slot++ % 5, head = n * 3;
        const header = BUFFERS + n * 0x2000, payload = header + 0x100, status = header + 0x1F00;
        const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
        view.setUint32(0, type, true); view.setUint32(8, sector, true);
        cpu.write_blob_physical(bytes, header);
        if(data) cpu.write_blob_physical(data, payload);
        cpu.write_blob_physical(new Uint8Array([0xFF]), status);
        const descriptor = (i, address, length, flags, next) => {
            u32(DESC + 16 * i, address); u32(DESC + 16 * i + 4, 0); u32(DESC + 16 * i + 8, length);
            u16(DESC + 16 * i + 12, flags); u16(DESC + 16 * i + 14, next);
        };
        const WRITE = 2, NEXT = 1;
        descriptor(head, header, 16, NEXT, data_length ? head + 1 : head + 2);
        if(data_length) descriptor(head + 1, payload, data_length, NEXT | (type === 0 ? WRITE : 0), head + 2);
        descriptor(head + 2, status, 1, WRITE, 0);
        u16(AVAIL + 4 + 2 * (avail % QUEUE), head);
        u16(AVAIL + 2, ++avail);
        return { head, status: () => cpu.read8_physical(status), payload: length => cpu.read_blob_physical(payload, length) };
    };
    const notify = () => reg(0x050, 0);
    /** the heads in the used ring, in their order */
    const used = () => Array.from({ length: used_idx() }, (_, i) =>
        new DataView(cpu.read_blob_physical(USED + 4 + 8 * (i % QUEUE), 4).slice().buffer).getUint32(0, true));
    return { emulator, cpu, events, queue, notify, used, used_idx };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, what)
{
    for(let i = 0; i < 2000 && !condition(); i++) await wait(2);
    assert.ok(condition(), what);
}
const T_IN = 0, T_OUT = 1, T_FLUSH = 4, S_OK = 0, S_IOERR = 1;

// FLUSH waits for the writes before it only
{
    const disk = new SlowDisk();
    disk.latency.set(0, 50);
    disk.latency.set(8 * 512, 400);
    const m = await machine(disk);
    const a = m.queue(T_OUT, 0, 512, new Uint8Array(512).fill(0xAA));
    const flush = m.queue(T_FLUSH, 0, 0);
    const b = m.queue(T_OUT, 8, 512, new Uint8Array(512).fill(0xBB));
    m.notify();
    await until(() => m.used_idx() === 3, "the three requests complete");
    assert.deepEqual(m.used(), [a.head, flush.head, b.head], "write A, then FLUSH, then the slower write B issued after it");
    assert.deepEqual([a.status(), flush.status(), b.status()], [S_OK, S_OK, S_OK]);
    assert.deepEqual(disk.writes_landed, [0, 8 * 512]);
    await m.emulator.destroy();
    console.log("ok - FLUSH waits for the writes issued before it, not for a slower one issued after it");
}

// disk_error "stop": held, run() retries
{
    const disk = new SlowDisk();
    const m = await machine(disk);
    disk.fail_writes = 1;
    const a = m.queue(T_OUT, 2, 512, new Uint8Array(512).fill(0x5A));
    const flush = m.queue(T_FLUSH, 0, 0);
    m.notify();
    await wait(50);
    assert.equal(m.used_idx(), 0, "the failed write is held, the FLUSH behind it waits");
    assert.equal(m.cpu.disk_holds.length, 1);
    assert.deepEqual(m.events, [{ disk: "virtio_disk0", operation: "write", offset: 1024, length: 512,
        reason: "the test's disk failed the write", retryable: true, policy: "stop" }]);
    await assert.rejects(m.emulator.save_state(), /held after an I\/O error/);
    m.emulator.v86.run();
    m.emulator.v86.stop();
    await until(() => m.used_idx() === 2, "the write and the FLUSH complete after run()");
    assert.deepEqual(m.used(), [a.head, flush.head]);
    assert.equal(a.status(), S_OK);
    assert.deepEqual(disk.data.subarray(1024, 1536), new Uint8Array(512).fill(0x5A), "the write landed");
    disk.fail_reads = 1;
    const r = m.queue(T_IN, 2, 512);
    m.notify();
    assert.equal(m.used_idx(), 2, "the failed read is held");
    m.emulator.v86.run();
    m.emulator.v86.stop();
    await until(() => m.used_idx() === 3, "the read completes after run()");
    assert.equal(r.status(), S_OK);
    assert.deepEqual(r.payload(512), new Uint8Array(512).fill(0x5A));
    assert.equal(m.events.length, 2);
    await m.emulator.destroy();
    console.log("ok - stop: a failed write is held (and the FLUSH behind it), a failed read too; run() retries them");
}

// disk_error "report": IOERR at once
{
    const disk = new SlowDisk("report");
    const m = await machine(disk);
    disk.fail_reads = 1;
    disk.fail_writes = 1;
    const r = m.queue(T_IN, 0, 512);
    const w = m.queue(T_OUT, 1, 512, new Uint8Array(512));
    m.notify();
    await until(() => m.used_idx() === 2, "both complete");
    assert.equal(r.status(), S_IOERR, "the read: VIRTIO_BLK_S_IOERR");
    assert.equal(w.status(), S_IOERR, "the write: VIRTIO_BLK_S_IOERR");
    assert.deepEqual(m.events.map(e => [e.operation, e.policy]), [["read", "report"], ["write", "report"]]);
    assert.equal(m.cpu.disk_holds?.length || 0, 0);
    await m.emulator.destroy();
    console.log("ok - report: a failed read and write end with VIRTIO_BLK_S_IOERR at once");
}
console.log("virtio_blk_disk_error: passed");
