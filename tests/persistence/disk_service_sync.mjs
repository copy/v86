#!/usr/bin/env node
// The disk service client's synchronous requests (docs/disk-persistence-plan.md
// D2, src/disk_service.js): in a worker, reads and writes to the local disk
// service are synchronous XMLHttpRequests. Node has none: this test gives it
// one (a worker thread makes the request, this thread waits with
// Atomics.wait), against tools/disk-service.mjs (in that thread, which is
// free to answer while this one waits):
// - a read and a write complete before get and set return; a cached read
//   makes no request; the write is in the file when it completes;
// - a sync request that fails (no answer; an answer lost after the service
//   applied the write; a 5xx) goes the asynchronous way: the right data, the
//   write applied once;
// - a write overlapping one on its way waits for it (asynchronously), the
//   later data wins;
// - a refusal (the lease lost) is the error at once, not retried;
// - not on the page (window), not to another computer.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";

const { DiskServiceDisk } = await import("../../src/disk_service.js");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "v86-disk-service-sync-"));
const SIZE = 1 << 20;
fs.writeFileSync(path.join(temp, "disk.img"), new Uint8Array(SIZE).map((_, i) => i * 5 & 0xFF));

const shared = new SharedArrayBuffer(8 + (4 << 20));
const control = new Int32Array(shared, 0, 2);
const helper = new Worker(`
const { parentPort, workerData } = require("node:worker_threads");
const { shared, dir, module } = workerData;
const control = new Int32Array(shared, 0, 2);
const bytes = new Uint8Array(shared, 8);
let service;
import(module).then(async ({ create_disk_service }) =>
{
    service = create_disk_service({ dir, origins: [], lease_ms: 400 });
    await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
    parentPort.postMessage({ port: service.server.address().port });
});
parentPort.on("message", async ({ method, url, headers, body, mode, stats, close }) =>
{
    if(stats) { parentPort.postMessage({ stats: { ...service.stats } }); return; }
    if(close) { await service.close(); parentPort.postMessage({ closed: true }); return; }
    let answer;
    try
    {
        if(mode.startsWith("status:")) answer = { status: +mode.slice(7), headers: {}, body: new TextEncoder().encode("{}") };
        else
        {
            const response = await fetch(url, { method, headers, body: body || undefined });
            answer = { status: response.status, headers: Object.fromEntries(response.headers), body: new Uint8Array(await response.arrayBuffer()) };
        }
        if(mode === "lost") answer = null;
    }
    catch(e)
    {
        answer = null;
    }
    if(answer)
    {
        const head = new TextEncoder().encode(JSON.stringify({ status: answer.status, headers: answer.headers, length: answer.body.length }));
        new DataView(shared, 8).setUint32(0, head.length, true);
        bytes.set(head, 4);
        bytes.set(answer.body, 4 + head.length);
    }
    Atomics.store(control, 0, answer ? 1 : 2);
    Atomics.notify(control, 0);
});
`, { eval: true, workerData: { shared, dir: temp, module: new URL("../../tools/disk-service.mjs", import.meta.url).href } });
const port = (await once(helper, "message"))[0].port;
const stats = async () => { helper.postMessage({ stats: true }); return (await once(helper, "message"))[0].stats; };

/** A synchronous XMLHttpRequest, as a worker has one (what src/disk_service.js uses of it) */
class SyncXMLHttpRequest
{
    constructor() { this.headers = {}; this.status = 0; this.response = null; this.answer_headers = {}; this.responseType = ""; this.timeout = 0; }
    open(method, url, async) { assert.equal(async, false, "synchronous"); this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getResponseHeader(name) { return this.answer_headers[name.toLowerCase()] ?? null; }
    send(body)
    {
        const mode = SyncXMLHttpRequest.next.shift() || "";
        SyncXMLHttpRequest.sent.push({ op: this.headers["X-V86-Disk-Op"] || this.method, mode });
        if(mode === "network") throw new Error("NetworkError: a network error occurred");
        Atomics.store(control, 0, 0);
        helper.postMessage({ method: this.method, url: this.url, headers: this.headers, body: body ? body.slice() : null, mode });
        assert.notEqual(Atomics.wait(control, 0, 0, this.timeout || 10000), "timed-out", "the helper answers");
        if(Atomics.load(control, 0) === 2) throw new Error("NetworkError: a network error occurred");
        const length = new DataView(shared, 8).getUint32(0, true);
        const head = JSON.parse(new TextDecoder().decode(new Uint8Array(shared, 12, length)));
        this.status = head.status;
        this.answer_headers = head.headers;
        this.response = new Uint8Array(shared, 12 + length, head.length).slice().buffer;
    }
}
/** @type {string[]} the next requests' failures: "network", "lost" (the service got it), "status:<n>" */
SyncXMLHttpRequest.next = [];
SyncXMLHttpRequest.sent = [];
globalThis.XMLHttpRequest = SyncXMLHttpRequest;

const file_bytes = (offset, length) => new Uint8Array(fs.readFileSync(path.join(temp, "disk.img")).subarray(offset, offset + length));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
/** a call's callback: [synchronous?, its arguments] once it ran */
function call(f, ...args)
{
    let sync = true, result;
    const done = new Promise(resolve => f(...args, (...values) => { result = values; resolve([sync, values]); }));
    sync = result !== undefined;
    return done.then(([, values]) => [sync, values]);
}

const url = "http://127.0.0.1:" + port + "/disk.img";

try
{
    assert.equal(new DiskServiceDisk("http://disk.example/disk.img", { name: "hda" }).sync, false, "another computer: asynchronous");
    globalThis.window = {};
    assert.equal(new DiskServiceDisk(url, { name: "hda" }).sync, false, "on the page: asynchronous");
    delete globalThis.window;
    const disk = new DiskServiceDisk(url, { name: "hda" });
    assert.equal(disk.sync, true);
    await disk.load();
    console.log("ok - synchronous only in a worker, to this computer");

    // a read and a write, before get and set return
    let [sync, [data, error]] = await call(disk.get.bind(disk), 4096, 1024);
    assert(sync, "the read completed before get returned");
    assert.equal(error, undefined);
    assert.deepEqual(data, file_bytes(4096, 1024));
    const requests = disk.requests;
    [sync, [data]] = await call(disk.get.bind(disk), 4096 + 512, 512);
    assert(sync && disk.requests === requests, "cached");
    const first = new Uint8Array(1024).fill(0x31);
    const generation = disk.generation();
    let file_at_completion;
    disk.set(8192, first, e => { error = e; file_at_completion = file_bytes(8192, 1024); });
    assert(file_at_completion, "the write completed before set returned");
    assert.equal(error, undefined);
    assert.deepEqual(file_at_completion, first, "in the file when it completes");
    assert.notEqual(disk.generation(), generation, "the service's generation");
    assert.deepEqual(SyncXMLHttpRequest.sent.map(r => r.op), ["GET", "write"]);
    console.log("ok - a read and a write complete before get and set return; a cached read makes no request; the write in the file");

    // sync requests that fail: the asynchronous way
    SyncXMLHttpRequest.next.push("network");
    [sync, [data, error]] = await call(disk.get.bind(disk), 65536, 512);
    assert(!sync && error === undefined, "the read again, asynchronously");
    assert.deepEqual(data, file_bytes(65536, 512));
    const writes = (await stats()).writes;
    SyncXMLHttpRequest.next.push("lost");
    const second = new Uint8Array(512).fill(0x32);
    [sync, [error]] = await call(disk.set.bind(disk), 16384, second);
    assert(!sync && error === undefined, "the write again, asynchronously");
    assert.equal((await stats()).writes, writes + 1, "applied once (its sequence number)");
    assert.deepEqual(file_bytes(16384, 512), second);
    SyncXMLHttpRequest.next.push("status:503");
    const third = new Uint8Array(512).fill(0x33);
    [sync, [error]] = await call(disk.set.bind(disk), 16384, third);
    assert(!sync && error === undefined, "a 5xx: asynchronously");
    assert.deepEqual(file_bytes(16384, 512), third);
    console.log("ok - a failed sync request (no answer, an answer lost, 5xx) goes the asynchronous way; the write applied once");

    // a write overlapping one on its way
    SyncXMLHttpRequest.next.push("network");
    const sent = SyncXMLHttpRequest.sent.length;
    const a = call(disk.set.bind(disk), 32768, new Uint8Array(1024).fill(0x41));
    const b = call(disk.set.bind(disk), 33280, new Uint8Array(512).fill(0x42));
    assert.equal(SyncXMLHttpRequest.sent.length, sent + 1, "the overlapping write was not sent synchronously");
    const [[a_sync, [a_error]], [b_sync, [b_error]]] = await Promise.all([a, b]);
    assert(!a_sync && !b_sync && a_error === undefined && b_error === undefined);
    assert.deepEqual(file_bytes(32768, 1024), new Uint8Array(1024).fill(0x41).fill(0x42, 512), "the later write wins");
    console.log("ok - a write overlapping one on its way waits for it; the later data wins");

    // a refusal: the error at once
    clearTimeout(disk.renew_timer);
    await wait(600);
    const other = await fetch(url, { method: "POST", headers: { "X-V86-Disk-Op": "open" } });
    assert.equal(other.status, 200, "another session took the image over");
    [sync, [error]] = await call(disk.set.bind(disk), 0, new Uint8Array(512));
    assert(sync, "refused synchronously");
    assert.equal(error.kind, "lease");
    assert.equal(error.retryable, false);
    assert.match(error.message, /another session writes the image now/);
    console.log("ok - a refusal (the lease lost) at once, not retried");
}
finally
{
    helper.postMessage({ close: true });
    await once(helper, "message");
    await helper.terminate();
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log("disk service sync tests passed");
