#!/usr/bin/env node
// The disk protocol (docs/disk-persistence-plan.md D2): tools/disk-service.mjs
// and its client, src/disk_service.js, in Node (fetch):
// - the service: reads as a static server (206, Content-Range, ETag the
//   generation, no-store), 416; a write session: open (the protocol
//   header), a second writer refused, writes in the file before the answer,
//   flush (fdatasync), mark and the next write's new generation (kept in
//   the state file), a repeated sequence number applied once, an older
//   write arriving after a newer overlapping one not applied, a takeover
//   after the lease ended and the old epoch's writes refused, renew,
//   close; the file changed behind its back: a new generation; Origin and
//   token checks; bad writes;
// - the client: a static server's URL and an unreachable one refused at
//   the start with the reason; reads (and their cache), writes, flush, the
//   snapshot reference; a write whose answer was lost is retried with its
//   sequence number (applied once); 5xx answers retried; a lost lease and
//   a full disk fail without retry.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const { create_disk_service } = await import("../../tools/disk-service.mjs");
const { DiskServiceDisk } = await import("../../src/disk_service.js");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "v86-disk-service-"));
const SIZE = 1 << 20;
fs.writeFileSync(path.join(temp, "disk.img"), new Uint8Array(SIZE).map((_, i) => i * 3 & 0xFF));
fs.writeFileSync(path.join(temp, "odd.img"), new Uint8Array(1000));
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + server.address().port)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (f, ...args) => new Promise(resolve => f(...args, (...result) => resolve(result)));
const file_bytes = (offset, length) => new Uint8Array(fs.readFileSync(path.join(temp, "disk.img")).subarray(offset, offset + length));

const service = create_disk_service({ dir: temp, origins: ["http://page.test"], token: undefined, lease_ms: 400 });
const base = await listen(service.server);
const url = base + "/disk.img";
const post = (op, headers = {}, body) => fetch(url, { method: "POST", headers: { "X-V86-Disk-Op": op, ...headers }, body });
const session_headers = s => ({ "X-V86-Disk-Session": s.session, "X-V86-Disk-Epoch": String(s.epoch) });
const write = (s, sequence, offset, data) => post("write", { ...session_headers(s), "X-V86-Disk-Sequence": String(sequence), "X-V86-Disk-Offset": String(offset) }, data);

try
{
    // reads
    let response = await fetch(url, { headers: { Range: "bytes=512-1023" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 512-1023/" + SIZE);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const etag = response.headers.get("etag");
    assert.match(etag, /^"[0-9a-f-]{36}:\d+"$/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), file_bytes(512, 512));
    assert.equal((await fetch(url, { headers: { Range: "bytes=" + SIZE + "-" + (SIZE + 10) } })).status, 416);
    assert.equal((await fetch(base + "/missing.img")).status, 404);
    assert.equal((await fetch(base + "/.v86-disk-service.json")).status, 404, "the state file is not served");
    console.log("ok - service: Range reads (206, Content-Range, ETag, no-store), 416, 404");

    // a write session
    response = await post("open");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-v86-disk-protocol"), "1");
    const a = await response.json();
    assert.equal(a.size, SIZE);
    assert.equal(a.sector_size, 512);
    assert.equal(a.lease_ms, 400);
    response = await post("open");
    assert.equal(response.status, 409, "a second writer while the lease is valid");
    assert.equal((await response.json()).code, "writer");
    const data = new Uint8Array(1024).fill(0x71);
    response = await write(a, 1, 4096, data);
    assert.equal(response.status, 200);
    const generation = (await response.json()).generation;
    assert.deepEqual(file_bytes(4096, 1024), data, "in the file before the answer");
    assert.notEqual((await fetch(url, { headers: { Range: "bytes=0-511" } })).headers.get("etag"), etag, "the ETag is the generation");
    const before = service.stats.flushes;
    assert.equal((await post("flush", session_headers(a))).status, 200);
    assert.equal(service.stats.flushes, before + 1, "flush: fdatasync");
    // repeated and late writes
    const newer = new Uint8Array(512).fill(0x22), older = new Uint8Array(512).fill(0x11);
    await write(a, 3, 8192, newer);
    response = await write(a, 2, 8192, older);
    assert.equal(response.status, 200, "an older write arriving late: answered");
    assert.deepEqual(file_bytes(8192, 512), newer, "not applied over the newer one");
    response = await write(a, 3, 8192, older);
    assert.equal((await response.json()).repeated, true, "a repeated sequence number");
    assert.deepEqual(file_bytes(8192, 512), newer, "applied once");
    // mark
    response = await post("mark", session_headers(a));
    const marked = (await response.json()).generation;
    const state = JSON.parse(fs.readFileSync(path.join(temp, ".v86-disk-service.json"), "utf8"));
    assert.equal(String(state["disk.img"].generation), marked, "the marked generation is in the state file");
    response = await write(a, 4, 0, new Uint8Array(512));
    assert.notEqual((await response.json()).generation, marked, "the next write: another generation");
    assert.equal(String(JSON.parse(fs.readFileSync(path.join(temp, ".v86-disk-service.json"), "utf8"))["disk.img"].generation),
        String(+marked + 1), "kept before the data was written");
    // bad writes
    assert.equal((await write(a, 5, 100, new Uint8Array(512))).status, 400, "not sector aligned");
    assert.equal((await write(a, 6, SIZE, new Uint8Array(512))).status, 400, "past the end");
    // renew, then the lease ends: taken over, the old epoch refused
    assert.equal((await post("renew", session_headers(a))).status, 200);
    await wait(600);
    response = await post("open");
    assert.equal(response.status, 200, "the lease ended: taken over");
    const b = await response.json();
    assert.equal(b.epoch, a.epoch + 1);
    response = await write(a, 7, 0, new Uint8Array(512).fill(9));
    assert.equal(response.status, 409, "the old epoch's write");
    assert.equal((await response.json()).code, "epoch");
    assert.notDeepEqual(file_bytes(0, 512), new Uint8Array(512).fill(9));
    assert.equal((await post("close", session_headers(b))).status, 200);
    response = await post("open");
    assert.equal(response.status, 200, "closed: open again at once");
    assert.equal((await post("close", session_headers(await response.json()))).status, 200);
    console.log("ok - service: one writer; writes in the file; flush; repeated and late writes; mark; lease, takeover, old epoch refused; close");

    // changed behind its back
    const g1 = (await fetch(url, { headers: { Range: "bytes=0-511" } })).headers.get("etag");
    await wait(20);
    const fd = fs.openSync(path.join(temp, "disk.img"), "r+");
    fs.writeSync(fd, new Uint8Array(512).fill(5), 0, 512, 65536);
    fs.closeSync(fd);
    const g2 = (await fetch(url, { headers: { Range: "bytes=0-511" } })).headers.get("etag");
    assert.notEqual(g1, g2, "the file changed outside: another generation");
    console.log("ok - service: a change of the file behind its back is another generation");

    // Origin and token
    response = await fetch(url, { method: "POST", headers: { "X-V86-Disk-Op": "open", "Origin": "http://evil.test" } });
    assert.equal(response.status, 403);
    response = await fetch(url, { method: "OPTIONS", headers: { "Origin": "http://page.test", "Access-Control-Request-Method": "POST" } });
    assert.equal(response.headers.get("access-control-allow-origin"), "http://page.test");
    assert.match(response.headers.get("access-control-allow-headers"), /X-V86-Disk-Op/);
    assert.match(response.headers.get("access-control-expose-headers"), /ETag/);
    const locked = create_disk_service({ dir: temp, token: "s3cret", lease_ms: 400 });
    const locked_base = await listen(locked.server);
    response = await fetch(locked_base + "/odd.img", { method: "POST", headers: { "X-V86-Disk-Op": "open" } });
    assert.equal(response.status, 401, "no token");
    response = await fetch(locked_base + "/odd.img", { method: "POST", headers: { "X-V86-Disk-Op": "open", "Authorization": "Bearer s3cret" } });
    assert.equal(response.status, 200, "the token");
    await locked.close();
    console.log("ok - service: Origin checked, CORS for the origins given; the token");

    // the client: refused at the start
    const plain = http.createServer((req, res) => { res.writeHead(req.method === "GET" ? 200 : 405).end(); });
    const plain_base = await listen(plain);
    await assert.rejects(new DiskServiceDisk(plain_base + "/disk.img", { name: "hda" }).load(),
        /hda's URL can only be read, not written back .* use a disk service that supports writing .* or omit disk_option/);
    plain.close();
    await assert.rejects(new DiskServiceDisk("http://127.0.0.1:1/disk.img", { name: "hdb" }).load(), /hdb: the disk service at .* cannot be reached/);
    await assert.rejects(new DiskServiceDisk(base + "/odd.img", { name: "hda" }).load(), /not a whole number of 512-byte sectors/);
    await assert.rejects(new DiskServiceDisk(url, { name: "hda", size: 512 }).load(), /the descriptor's size says 512/);
    console.log("ok - client: a static server's URL, an unreachable service, odd sizes refused at the start");

    // the client: reads, writes, flush, the snapshot reference
    await wait(600);
    const disk = new DiskServiceDisk(url, { name: "hda" });
    await disk.load();
    assert.equal(disk.byteLength, SIZE);
    let [got, error] = await call(disk.get.bind(disk), 4096, 1024);
    assert.equal(error, undefined);
    assert.deepEqual(got, new Uint8Array(1024).fill(0x71));
    const requests = disk.requests;
    [got] = await call(disk.get.bind(disk), 4096 + 512, 512);
    assert.equal(disk.requests, requests, "cached");
    const fresh = new Uint8Array(512).fill(0x5D);
    [error] = await call(disk.set.bind(disk), 4096, fresh);
    assert.equal(error, undefined);
    assert.deepEqual(file_bytes(4096, 512), fresh, "in the file when it completes");
    assert.deepEqual(disk.get_from_cache(4096, 512), fresh, "the cache has the write");
    [error] = await call(disk.flush.bind(disk));
    assert.equal(disk.flushes, 1);
    assert.throws(() => disk.get_state(), /needs it flushed first/);
    [error] = await call(disk.prepare_snapshot.bind(disk));
    const reference = disk.get_state();
    assert.equal(reference[0], "v86-writeback");
    disk.check_state(reference);
    await call(disk.set.bind(disk), 0, new Uint8Array(512));
    assert.throws(() => disk.check_state(reference), /cannot go back to it/);
    assert.throws(() => disk.get_state(), /needs it flushed first/, "a write after the mark");
    console.log("ok - client: reads (cached), a write in the file and the cache when it completes, flush, the snapshot reference");

    // the answer of a write lost: retried, applied once
    const proxy_state = { drop_answer: 0, fail: 0, status: 0 };
    const proxy = http.createServer((req, res) =>
    {
        const chunks = [];
        req.on("data", c => chunks.push(c));
        req.on("end", async () =>
        {
            if(proxy_state.status && req.headers["x-v86-disk-op"] === "write")
            {
                proxy_state.status_count = (proxy_state.status_count || 0) + 1;
                res.writeHead(proxy_state.status, { "X-V86-Disk-Protocol": "1", "Content-Type": "application/json" });
                res.end(JSON.stringify({ code: proxy_state.status === 507 ? "no_space" : "io", error: "test" }));
                if(proxy_state.status !== 507 && --proxy_state.fail <= 0) proxy_state.status = 0;
                return;
            }
            const upstream = await fetch(url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-v86") || k === "range")), body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
            const body = Buffer.from(await upstream.arrayBuffer());
            if(proxy_state.drop_answer && req.headers["x-v86-disk-op"] === "write")
            {
                proxy_state.drop_answer--;
                req.socket.destroy();
                return;
            }
            res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([k]) => k !== "content-length" && k !== "transfer-encoding")));
            res.end(body);
        });
    });
    const proxy_base = await listen(proxy);
    await call(disk.close.bind(disk));
    const through = new DiskServiceDisk(proxy_base + "/disk.img", { name: "hda" });
    await through.load();
    const writes = service.stats.writes;
    proxy_state.drop_answer = 1;
    [error] = await call(through.set.bind(through), 16384, new Uint8Array(512).fill(0x44));
    assert.equal(error, undefined, "retried after the lost answer");
    assert.equal(service.stats.writes, writes + 1, "applied once");
    proxy_state.status = 503;
    proxy_state.fail = 2;
    [error] = await call(through.set.bind(through), 16384, new Uint8Array(512).fill(0x45));
    assert.equal(error, undefined, "5xx answers retried");
    assert.equal(proxy_state.status_count, 2);
    proxy_state.status = 507;
    [error] = await call(through.set.bind(through), 16384, new Uint8Array(512).fill(0x46));
    assert.equal(error.kind, "no_space");
    assert.equal(error.retryable, false, "a full disk: not retried");
    proxy_state.status = 0;
    console.log("ok - client: a lost answer retried with its sequence number (applied once); 5xx retried; 507 not");

    // a lost lease
    clearTimeout(through.renew_timer);
    await wait(600);
    const other = await post("open");
    assert.equal(other.status, 200, "another session took the image over");
    [error] = await call(through.set.bind(through), 0, new Uint8Array(512));
    assert.equal(error.kind, "lease");
    assert.equal(error.retryable, false);
    assert.match(error.message, /another session writes the image now/);
    [error] = await call(through.set.bind(through), 512, new Uint8Array(512));
    assert.equal(error.retryable, false, "and so do the next ones");
    proxy.close();
    console.log("ok - client: a lost lease fails the writes, not to be retried");
}
finally
{
    await service.close();
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log("disk service tests passed");
