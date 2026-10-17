#!/usr/bin/env node
// The common parts of disk images (docs/disk-image-formats-plan.md P0): the
// guest's writes over the image (write then read, part of a cluster, across
// clusters, a read that began before a write, the memory budget), snapshots
// of the changes with the image's identity, cancellation and shared reads of
// the read cache, errors that end the request, and the checks of every HTTP
// response (status, Content-Range, length, ETag) with a transport that
// answers as a server would.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { make_samples, SAMPLES_DIR } from "./samples.mjs";
import { create_disk_image, check_image_options } from "../../src/image/factory.js";
import { URLSource, PartsSource, CachedSource, MemorySource, DiskImageError } from "../../src/image/source.js";
import { DiskImage, ImageReader, EXTENT_DATA } from "../../src/image/disk_image.js";
import { WriteOverlay } from "../../src/image/overlay.js";

process.on("unhandledRejection", exn => { throw exn; });

const manifest = make_samples();
const file = name => path.join(SAMPLES_DIR, name);
const base = fs.readFileSync(file("base.raw"));

const get = (disk, offset, length, options) => new Promise((resolve, reject) =>
    disk.get(offset, length, (data, error) => error ? reject(error) : resolve(data), options));
const set = (disk, offset, data) => new Promise((resolve, reject) =>
    disk.set(offset, data, error => error ? reject(error) : resolve()));
const equal_bytes = (actual, expected, what) => assert.ok(Buffer.compare(Buffer.from(actual), Buffer.from(expected)) === 0, what);

async function open_disk(name, extra = {}, settings = {})
{
    const disk = create_disk_image("hda", { url: file(name), async: true, format: "qcow2", ...extra }, settings);
    await disk.load();
    return disk;
}

// writes over the image
{
    const disk = await open_disk("v3.qcow2");
    assert.equal(disk.byteLength, base.length, "the guest sees the virtual size");
    const data = new Uint8Array(3 * 65536 + 1024).map((_, i) => i * 13 + 7);
    // across clusters, starting in the middle of one
    await set(disk, 65536 - 512, data);
    const expected = new Uint8Array(base.subarray(0, 5 * 65536));
    expected.set(data, 65536 - 512);
    equal_bytes(await get(disk, 0, 5 * 65536), expected, "written over the image, across clusters");
    // part of a block of 256: the read of a sector around it
    await set(disk, 4 * 65536 + 768, new Uint8Array(256).fill(0xAB));
    expected.fill(0xAB, 4 * 65536 + 768, 4 * 65536 + 1024);
    equal_bytes(await get(disk, 4 * 65536, 65536), expected.subarray(4 * 65536), "a write of part of a cluster");
    // covered by the writes: from memory, synchronously
    let sync = false;
    disk.get(65536, 512, () => { sync = true; });
    assert.ok(sync, "a read of written blocks completes at once");
    // get_from_cache: written blocks, and blocks read with get_and_cache
    equal_bytes(disk.get_from_cache(65536, 512), data.subarray(512, 1024), "get_from_cache: written");
    assert.equal(disk.get_from_cache(10 * 65536, 512), undefined, "get_from_cache: not read");
    await new Promise(resolve => disk.get_and_cache(10 * 65536, 512, resolve));
    equal_bytes(disk.get_from_cache(10 * 65536, 512), base.subarray(10 * 65536, 10 * 65536 + 512), "get_from_cache: read before");
    // the image itself is not written
    assert.equal(create_hash("sha256").update(fs.readFileSync(file("v3.qcow2"))).digest("hex"), manifest.samples["v3.qcow2"].sha256);
    console.log("ok - writes over the image: across clusters, part of a cluster, from the overlay, get_from_cache");
}

// the other sources: a whole download (url without async), a file read in
// ranges given its size, the length checked against it
{
    const whole = await open_disk("v3.qcow2", { async: false });
    assert.equal(whole.reader.source.constructor.name, "MemorySource", "downloaded whole");
    equal_bytes(await get(whole, 20 << 20, 1 << 20), base.subarray(20 << 20, 21 << 20), "a whole download");
    const sized = await open_disk("v3.qcow2", { size: manifest.samples["v3.qcow2"].length });
    equal_bytes(await get(sized, 0, 65536), base.subarray(0, 65536), "the size given");
    await assert.rejects(open_disk("v3.qcow2", { size: 12345 }), /the file has \d+ bytes, its size is given as 12345/);
    console.log("ok - sources: a whole download, a file read in ranges with its size; a wrong size refused");
}

// a read that began before a write returns the write's data, and the read
// cache does not keep data older than the write
{
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const disk = create_disk_image("hda", { url: file("v3.qcow2"), async: true, format: "qcow2" }, {
        open_source: async (name, descriptor) =>
        {
            const inner = new URLSource(descriptor.url, undefined, name);
            // reads that wait for the gate
            const slow = {
                name, sync: false,
                get byteLength() { return inner.byteLength; },
                open: callback => inner.open(callback),
                read: (offset, length, callback, signal) => gate.then(() => inner.read(offset, length, callback, signal)),
            };
            const cached = new CachedSource(slow);
            await new Promise((resolve, reject) => cached.open(e => e ? reject(e) : resolve()));
            // (open reads through the gate too: released below)
            return cached;
        },
    });
    const loading = disk.load();
    release();
    await loading;
    let release2;
    const gate2 = new Promise(resolve => { release2 = resolve; });
    const source = disk.reader.source;
    const inner_read = source.inner.read;
    source.inner.read = (offset, length, callback, signal) => gate2.then(() => inner_read(offset, length, callback, signal));
    const reading = get(disk, 20 * 65536, 65536);
    const written = new Uint8Array(512).fill(0x42);
    await set(disk, 20 * 65536 + 4096, written);
    release2();
    const result = await reading;
    const expected = new Uint8Array(base.subarray(20 * 65536, 21 * 65536));
    expected.set(written, 4096);
    equal_bytes(result, expected, "the read sees the later write");
    equal_bytes(await get(disk, 20 * 65536, 65536), expected, "and so does the next read");
    console.log("ok - a read that began before a write: the write wins, now and later");
}

// the memory budget: a write beyond it fails as a whole
{
    const disk = await open_disk("v3.qcow2", { overlay_limit: 65536 });
    await set(disk, 0, new Uint8Array(65536).fill(1));
    await set(disk, 0, new Uint8Array(4096).fill(2));
    await assert.rejects(set(disk, 65536, new Uint8Array(512).fill(3)), /memory budget/);
    equal_bytes(await get(disk, 65536, 512), base.subarray(65536, 65536 + 512), "the failed write left nothing");
    const overlay = new WriteOverlay(1 << 20, 1024);
    assert.ok(overlay.write(0, new Uint8Array(2048)) instanceof DiskImageError);
    assert.equal(overlay.size(), 0);
    console.log("ok - the memory budget: writes past it fail, nothing of them is written");
}

// snapshots: the changes with the image's identity
{
    const disk = await open_disk("v3.qcow2");
    const data = new Uint8Array(70000 * 256).map((_, i) => i * 7);
    await set(disk, 512, data.subarray(0, 512));
    await set(disk, 30 * 65536, data);
    const state = disk.get_state();
    assert.equal(state[0], "v86-disk-image");
    const again = await open_disk("v3.qcow2");
    again.set_state(state);
    equal_bytes(await get(again, 0, 1024), Buffer.concat([base.subarray(0, 512), data.subarray(0, 512)]), "restored: a sector");
    equal_bytes(await get(again, 30 * 65536, data.length), data, "restored: 17 MiB in two chunks");
    // the same disk from memory: the same image
    const from_memory = create_disk_image("hda", { buffer: new Uint8Array(fs.readFileSync(file("v3.qcow2"))).buffer, format: "qcow2" }, {});
    await from_memory.load();
    from_memory.check_state(state);
    // another image of the same disk (version 2), an image_id, RAW state
    const other = await open_disk("v2.qcow2");
    assert.throws(() => other.set_state(state), /another image/);
    const with_id = await open_disk("v3.qcow2", { image_id: "release-2" });
    assert.throws(() => with_id.check_state(state), /image_id "" in the snapshot, "release-2" here/);
    assert.throws(() => again.check_state([null, new Float64Array(0), []]), /is a RAW image/);
    assert.throws(() => again.check_state(null), /has no disk hda/);
    const bad = state.slice();
    bad[3] = new Float64Array([1e15]);
    bad[4] = [new Uint8Array(256)];
    assert.throws(() => again.check_state(bad), /block numbers/);
    // a child with its parent: the parent is part of the identity
    const child = await open_disk("child.qcow2", { backing: { url: file("parent.qcow2") } });
    await set(child, 0, new Uint8Array(512).fill(9));
    const child_state = child.get_state();
    (await open_disk("child.qcow2", { backing: { url: file("v3.qcow2") } })).check_state(child_state);
    const other_parent = await open_disk("child.qcow2", { backing: { url: file("v3-512.qcow2") } });
    assert.throws(() => other_parent.check_state(child_state), /another image \(parent: /);
    console.log("ok - snapshots: restored onto the same image only (file or memory), refused for another; the parent too");
}

// cancellation: a cancelled read never calls back; one shared with another
// read goes on for it; a request no read waits for is ended
{
    const requests = [];
    const inner = {
        name: "test", byteLength: 1 << 20, sync: false,
        open(callback) { callback(); },
        read(offset, length, callback, signal)
        {
            const request = { offset, length, callback, signal, aborted: false };
            signal.addEventListener("abort", () => { request.aborted = true; });
            requests.push(request);
        },
    };
    const cache = new CachedSource(inner, 65536);
    // (each byte: the number of its 64 KiB window)
    const answer = request => request.callback(new Uint8Array(request.length).map((_, i) => request.offset + i >> 16));
    const one = new AbortController(), two = new AbortController();
    const calls = [];
    cache.read(0, 512, data => calls.push(["one", data[0]]), one.signal);
    cache.read(256, 512, data => calls.push(["two", data[0]]), two.signal);
    assert.equal(requests.length, 1, "the second read waits for the first one's request");
    one.abort();
    assert.equal(requests[0].aborted, false, "still needed by the second read");
    answer(requests[0]);
    assert.deepEqual(calls, [["two", 0]], "only the read not cancelled calls back");
    // adjacent windows in one request, cached ones not again
    cache.read(65536, 3 * 65536, data => calls.push(["three", data.length]));
    assert.equal(requests.length, 2);
    assert.deepEqual([requests[1].offset, requests[1].length], [65536, 3 * 65536], "one request for adjacent windows");
    answer(requests[1]);
    cache.read(0, 4 * 65536, data => calls.push(["four", data[3 * 65536]]));
    assert.equal(requests.length, 2, "all cached");
    // a request only cancelled reads wait for is ended
    const three = new AbortController();
    cache.read(8 * 65536, 512, () => calls.push(["never"]), three.signal);
    three.abort();
    assert.equal(requests[2].aborted, true, "no read waits for it: ended");
    answer(requests[2]);
    // an error ends every read waiting
    cache.read(9 * 65536, 512, (data, error) => calls.push(["error", error.message]));
    requests[3].callback(undefined, new DiskImageError("broken"));
    assert.deepEqual(calls.slice(1), [["three", 3 * 65536], ["four", 3], ["error", "broken"]]);
    console.log("ok - the read cache: cancelled reads, shared requests, adjacent windows, errors");
}

// a fake HTTP server: the checks of every response
function server(bytes, behave = {})
{
    const log = [];
    const transport = (url, start, length, callback, signal) =>
    {
        log.push([start, length]);
        const n = log.length;
        const respond = () =>
        {
            if(signal && signal.aborted) return;
            const etag = typeof behave.etag === "function" ? behave.etag(n) : "\"v1\"";
            if(behave.fail && behave.fail(n))
            {
                callback(undefined, behave.fail(n) === "network" ? undefined : { status: 503 },
                    new DiskImageError("network error", "io"));
                return;
            }
            if(length === undefined)
            {
                callback(bytes, { status: 200, etag });
                return;
            }
            const end = Math.min(bytes.length, start + length);
            let data = bytes.subarray(start, end);
            if(behave.short) data = data.subarray(0, data.length - 1);
            callback(data, {
                status: behave.status || 206,
                content_range: behave.content_range ? behave.content_range(start, end) : "bytes " + start + "-" + (end - 1) + "/" + bytes.length,
                content_encoding: behave.encoding || null,
                etag, last_modified: null,
            });
        };
        setTimeout(respond, 1);
    };
    return { transport, log };
}

{
    const bytes = new Uint8Array(1 << 20).map((_, i) => i);
    const open = async (behave, size) =>
    {
        const { transport, log } = server(bytes, behave);
        const source = new URLSource("http://test/disk.img", size, "hda", transport, [1, 1, 1]);
        await new Promise((resolve, reject) => source.open(e => e ? reject(e) : resolve()));
        return { source, log };
    };
    const read = (source, offset, length) => new Promise((resolve, reject) =>
        source.read(offset, length, (data, error) => error ? reject(error) : resolve(data)));

    const { source, log } = await open({});
    assert.equal(source.byteLength, bytes.length, "the length from Content-Range of a read of byte 0");
    assert.deepEqual(log[0], [0, 1]);
    equal_bytes(await read(source, 1000, 5000), bytes.subarray(1000, 6000), "a read");

    await assert.rejects(open({ status: 200 }), /status 200/);
    const sized = await open({}, 12345);
    await assert.rejects(read(sized.source, 0, 512), /the server reports 1048576 bytes, the size is given as 12345/);
    const wrong_range = await open({ content_range: (s, e) => s === 0 ? "bytes 0-0/" + bytes.length : "bytes 0-99/" + bytes.length });
    await assert.rejects(read(wrong_range.source, 4096, 512), /is for bytes 0-99/);
    const short = await open({ short: true }, bytes.length);
    await assert.rejects(read(short.source, 4096, 512), /has 511 bytes/);
    const encoded = await open({ encoding: "gzip" }, bytes.length);
    await assert.rejects(read(encoded.source, 0, 512), /Content-Encoding gzip/);
    // the file changes on the server: no more reads from it
    const changing = await open({ etag: n => n < 3 ? "\"v1\"" : "\"v2\"" });
    await read(changing.source, 0, 512);
    await assert.rejects(read(changing.source, 512, 512), /changed on the server/);
    await assert.rejects(read(changing.source, 0, 512), /changed on the server/);
    assert.equal(changing.log.length, 3, "no request after the change");
    // 5xx and network errors are tried again, a bounded number of times
    const flaky = await open({ fail: n => n === 2 || n === 3 ? "network" : false });
    equal_bytes(await read(flaky.source, 0, 512), bytes.subarray(0, 512), "after two failed tries");
    assert.equal(flaky.source.stats.retries, 2);
    const down = await open({ fail: n => n > 1 ? "network" : false });
    await assert.rejects(read(down.source, 0, 512), /network error/);
    assert.equal(down.log.length, 1 + 4, "the first try and three more");
    console.log("ok - HTTP: status, Content-Range, length, encoding, a file that changes, retries");

    // split files
    const parts = server(bytes, {});
    const split = new PartsSource("http://test/disk.img", bytes.length, 65536, false, undefined, "hda",
        (url, start, length, callback, signal) =>
        {
            const match = /disk-(\d+)-(\d+)\.img$/.exec(url);
            assert.ok(match, url);
            parts.transport(url, +match[1], undefined, (data, info, error) =>
                callback(data && data.subarray(+match[1], +match[2]), info, error), signal);
        });
    await new Promise(resolve => split.open(resolve));
    equal_bytes(await read(split, 65536 - 100, 200), bytes.subarray(65536 - 100, 65436 + 200), "across two parts");
    console.log("ok - split files: a read across parts");
}

// a source that fails: the device's read ends with the error
{
    const reader = new ImageReader(new MemorySource(new Uint8Array(4096), "x"), "x");
    reader.format = "test";
    reader.virtual_size = 1 << 20;
    reader.map = (offset, length, callback) => callback([{ type: EXTENT_DATA, length, host_offset: 1 << 30 }]);
    const failing = new DiskImage("hda", async () => reader);
    await failing.load();
    // (a data extent past the end of the file reads as zeros)
    equal_bytes(await get(failing, 0, 512), new Uint8Array(512), "past the end of the file");
    reader.source = { byteLength: 2 ** 31, read: (o, l, callback) => callback(undefined, new DiskImageError("gone")) };
    const errors = [];
    const original = console.error;
    console.error = message => errors.push(message);
    await assert.rejects(get(failing, 0, 512), /gone/);
    await assert.rejects(get(failing, 512, 512), /gone/);
    console.error = original;
    assert.deepEqual(errors, ["Disk hda: gone"], "told once");
    const broken = new DiskImage("hda", async () => { throw new DiskImageError("cannot open"); });
    let told;
    broken.onerror = error => { told = error; };
    await assert.rejects(broken.load(), /cannot open/);
    assert.match(told.message, /cannot open/);
    console.log("ok - errors: a read fails with the source's error, a disk that cannot be opened fails load");
}

// export (P2): RAW of the whole disk, the image's data with the guest's
// writes; progress, backpressure, cancellation
{
    const { export_raw } = await import("../../src/image/export.js");
    const disk = await open_disk("v3-zlib.qcow2", {}, { zstd_decompress: undefined });
    const writes = [[0, 4096], [10 * 65536 + 512, 70000 * 256], [base.length - 1024, 1024]];
    const expected = new Uint8Array(base);
    for(const [offset, length] of writes)
    {
        const data = new Uint8Array(length).map((_, i) => i * 3 + offset);
        await set(disk, offset, data);
        expected.set(data, offset);
    }
    const chunks = [], progress = [];
    let writing = 0;
    const total = await export_raw(disk, async chunk =>
    {
        assert.equal(writing, 0, "one chunk at a time");
        writing++;
        await new Promise(resolve => setTimeout(resolve, 1));
        chunks.push(chunk);
        writing--;
    }, { progress: p => progress.push(p.loaded) });
    assert.equal(total, base.length);
    equal_bytes(Buffer.concat(chunks), expected, "the export: the image with the writes");
    assert.equal(progress[0], 0);
    assert.equal(progress[progress.length - 1], base.length);
    assert.ok(chunks.every(c => c.length <= 1024 * 1024), "chunks of at most 1 MiB");
    const controller = new AbortController();
    let count = 0;
    await assert.rejects(export_raw(disk, () => { if(++count === 3) controller.abort(); }, { signal: controller.signal }), /cancelled at 3145728/);
    console.log("ok - export: RAW of the disk with the guest's writes, in order, backpressure, progress, cancellation");
}

// the options of a descriptor
{
    assert.equal(check_image_options("hda", { url: "x" }, true), undefined, "no format: RAW as before");
    assert.equal(check_image_options("hda", { url: "x", format: "raw" }, true), undefined);
    assert.equal(check_image_options("hda", { url: "x", format: "qcow2" }, true), "qcow2");
    assert.equal(check_image_options("hda", { url: "x", format: "auto", disk_option: "read_only" }, true), "auto");
    assert.throws(() => check_image_options("hda", { url: "x", format: "qcow3" }, true), /unknown format "qcow3"/);
    assert.equal(check_image_options("hda", { url: "x", format: "vhd" }, true), "vhd");
    for(const format of ["vdi", "vmdk", "vhdx", "vpc"]) assert.equal(check_image_options("hda", { url: "x", format }, true), format);
    assert.throws(() => check_image_options("hda", { url: "x", format: "qed" }, true), /unknown format "qed"/);
    assert.throws(() => check_image_options("hda", { url: "x", format: "vmdk", files: { "a.vmdk": "a.vmdk" } }, true), /files must map/);
    assert.throws(() => check_image_options("hda", { url: "x", format: "vmdk", archive_member: 7 }, true), /archive_member/);
    assert.throws(() => check_image_options("cdrom", { url: "x", format: "qcow2" }, false), /for hard disks/);
    assert.throws(() => check_image_options("hda", { url: "x", disk_option: "read_write" }, true), /not supported yet/);
    assert.throws(() => check_image_options("hda", { url: "x", disk_option: "rw" }, true), /not one of/);
    assert.throws(() => check_image_options("bios", { url: "x", disk_option: "read_only" }, false), /for disks/);
    assert.throws(() => check_image_options("hda", { get() {}, set() {}, load() {}, format: "qcow2" }, true), /descriptors/);
    console.log("ok - options: format and disk_option checked");
}

console.log("disk image tests passed");
