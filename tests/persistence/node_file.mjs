#!/usr/bin/env node
// NodeFileDisk (src/disk_writeback.js; docs/disk-persistence-plan.md D1): a
// local file written back, the backend contract on its own:
// - opening: a file that cannot be written, a size that is not whole
//   sectors or not the descriptor's, a file this process writes back
//   already: refused with the reason;
// - reads and writes are synchronous; a write is in the file when it
//   completes; flush makes it durable (fdatasync), and so does the timed
//   flush: 1 s after the last write, at most 5 s after the first one;
// - snapshots: a reference (identity: real path, device, inode;
//   generation), no data; the first write after it moves the generation
//   on; check_state takes only the same file in the same generation;
// - close flushes and closes; the file can then be opened again.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { NodeFileDisk, is_writeback_state, FLUSH_IDLE_MS, FLUSH_MAX_MS } = await import("../../src/disk_writeback.js");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "v86-writeback-"));
const file = path.join(temp, "disk.img");
const SIZE = 1 << 20;
fs.writeFileSync(file, new Uint8Array(SIZE).map((_, i) => i & 0xFF));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (f, ...args) => new Promise(resolve => f(...args, (...result) => resolve(result)));

async function open(name, size)
{
    const disk = new NodeFileDisk(file, { name, size });
    await disk.load();
    return disk;
}

try
{
    // opening
    fs.writeFileSync(path.join(temp, "odd.img"), new Uint8Array(1000));
    await assert.rejects(new NodeFileDisk(path.join(temp, "odd.img"), { name: "hda" }).load(), /hda: .*odd\.img has 1000 bytes, not a whole number of 512-byte sectors/);
    await assert.rejects(new NodeFileDisk(path.join(temp, "missing.img"), { name: "hda" }).load(), /hda: the file .*missing\.img cannot be opened for writing/);
    fs.writeFileSync(path.join(temp, "ro.img"), new Uint8Array(512));
    fs.chmodSync(path.join(temp, "ro.img"), 0o444);
    await assert.rejects(new NodeFileDisk(path.join(temp, "ro.img"), { name: "hdb" }).load(), /hdb: the file .*ro\.img cannot be opened for writing/);
    await assert.rejects(open("hda", SIZE * 2), /has 1048576 bytes, the descriptor's size says 2097152/);
    const disk = await open("hda");
    assert.equal(disk.byteLength, SIZE);
    fs.symlinkSync(file, path.join(temp, "link.img"));
    await assert.rejects(new NodeFileDisk(path.join(temp, "link.img"), { name: "hdb" }).load(), /written back by another disk of this process already/,
        "the same file by another name");
    console.log("ok - opening: unwritable, missing, not whole sectors, not the descriptor's size, written back already: refused");

    // reads, writes, flush
    let synchronous = false;
    disk.get(512, 512, data => { synchronous = true; assert.deepEqual(data, new Uint8Array(512).map((_, i) => i & 0xFF)); });
    assert.ok(synchronous, "a synchronous read");
    const data = new Uint8Array(1024).fill(0xA7);
    let [error] = await call(disk.set.bind(disk), 4096, data);
    assert.equal(error, undefined);
    const fd = fs.openSync(file, "r");
    const read = () => { const b = new Uint8Array(1024); fs.readSync(fd, b, 0, 1024, 4096); return b; };
    assert.deepEqual(read(), data, "the write is in the file when it completes");
    assert.equal(disk.flushes, 0);
    [error] = await call(disk.flush.bind(disk));
    assert.equal(error, undefined);
    assert.equal(disk.flushes, 1, "flush: fdatasync");
    [error] = await call(disk.flush.bind(disk));
    assert.equal(disk.flushes, 1, "nothing to flush: no fdatasync");
    console.log("ok - reads and writes are synchronous, a completed write is in the file, flush makes it durable");

    // the timed flush
    await call(disk.set.bind(disk), 0, new Uint8Array(512).fill(1));
    await wait(FLUSH_IDLE_MS / 2);
    assert.equal(disk.flushes, 1, "not yet");
    await wait(FLUSH_IDLE_MS / 2 + 300);
    assert.equal(disk.flushes, 2, "1 s after the last write");
    const started = Date.now();
    let flushed_at = 0;
    while(Date.now() - started < FLUSH_MAX_MS + 1500)
    {
        await call(disk.set.bind(disk), 0, new Uint8Array(512).fill(2));
        if(disk.flushes === 3 && !flushed_at) flushed_at = Date.now() - started;
        await wait(200);
    }
    assert.ok(flushed_at >= FLUSH_MAX_MS - 100 && flushed_at <= FLUSH_MAX_MS + 600, "writes every 200 ms: flushed after 5 s (" + flushed_at + " ms)");
    console.log("ok - the timed flush: " + FLUSH_IDLE_MS + " ms after the last write; with writes going on, after " + flushed_at + " ms");

    // snapshots
    const state = disk.get_state();
    assert.ok(is_writeback_state(state));
    assert.equal(state.length, 5);
    assert.equal(state[4], SIZE);
    const identity = JSON.parse(state[2]);
    assert.equal(identity.path, fs.realpathSync(file));
    assert.equal(identity.ino, String(fs.statSync(file).ino));
    assert.equal(disk.dirty_since, 0, "saved after a flush");
    disk.check_state(state);
    assert.throws(() => disk.check_state([[], []]), /has its changes in memory/, "a read_only disk's state");
    assert.throws(() => disk.check_state(undefined), /has no disk hda/);
    assert.throws(() => disk.check_state([state[0], 9, state[2], state[3], state[4]]), /version 9/);
    const generation = state[3];
    await call(disk.set.bind(disk), 0, new Uint8Array(512).fill(3));
    assert.notEqual(disk.generation(), generation, "the first write after the snapshot moves the generation on");
    assert.throws(() => disk.check_state(state), /in generation .* cannot go back to it/);
    const second = disk.get_state();
    await call(disk.set.bind(disk), 0, new Uint8Array(512).fill(3));
    assert.notEqual(disk.generation(), second[3], "also a write of the same data");
    console.log("ok - snapshots: a reference without data; the next write moves the generation on, the reference no longer fits");

    // a copy is another file
    const third = disk.get_state();
    let [closed] = await call(disk.close.bind(disk));
    assert.equal(closed, undefined);
    assert.ok(disk.closed);
    [error] = await call(disk.set.bind(disk), 0, new Uint8Array(512));
    assert.match(error.message, /the disk is closed/);
    assert.equal(error.retryable, false);
    const again = await open("hda");
    again.check_state(third);
    fs.copyFileSync(file, path.join(temp, "copy.img"));
    const copy = new NodeFileDisk(path.join(temp, "copy.img"), { name: "hdb" });
    await copy.load();
    assert.throws(() => copy.check_state(third), /is \{"path":.*disk\.img.*\} in generation/, "the same data in another file");
    await call(copy.close.bind(copy));
    await call(again.close.bind(again));
    console.log("ok - close: flushed and closed, opened again in the same generation; a copy is another image");
    fs.closeSync(fd);
}
finally
{
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log("node file disk tests passed");
