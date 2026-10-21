// The browser disk backend (src/opfs_disk.js, docs/vm-manager-plan.md U6) in
// a dedicated worker, where FileSystemSyncAccessHandles exist: reads and
// writes, the record (identity, generation; the VM manager's fields kept),
// the generation's moves (a session's first write, the first after a
// snapshot), snapshots' references, the timed flush, one writer per disk,
// the checks at the start, the browser's quota as a write error that is not
// retried. tests/app/opfs_disk_test.html runs it.

import { OpfsDisk } from "../../src/opfs_disk.js";

const log = [];
const check = (condition, what) => { if(!condition) throw new Error(what); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (fn, ...args) => new Promise(resolve => fn(...args, (...result) => resolve(result)));

async function file(name, size, record)
{
    let dir = await navigator.storage.getDirectory();
    for(const part of ["v86", "disks"]) dir = await dir.getDirectoryHandle(part, { create: true });
    await dir.removeEntry(name).catch(() => {});
    await dir.removeEntry(name.replace(/\.img$/, ".json")).catch(() => {});
    const access = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
    access.truncate(size);
    access.close();
    if(record)
    {
        const writable = await (await dir.getFileHandle(name.replace(/\.img$/, ".json"), { create: true })).createWritable();
        await writable.write(JSON.stringify(record));
        await writable.close();
    }
    return dir;
}
async function record_of(dir, name)
{
    return JSON.parse(await (await (await dir.getFileHandle(name.replace(/\.img$/, ".json"))).getFile()).text());
}
async function load_error(disk)
{
    try { await disk.load(); }
    catch(e) { return e; }
    return null;
}

async function main()
{
    // a disk with the manager's record: its identity and generation, read and written
    const dir = await file("t1.img", 1 << 20, { uuid: "11111111-2222-3333-4444-555555555555", generation: 7, size: 1 << 20, label: "kept" });
    const disk = new OpfsDisk("opfs:v86/disks/t1.img", { name: "hda" });
    await disk.load();
    check(disk.byteLength === 1 << 20 && disk.writeback, "loaded");
    check(JSON.stringify(disk.identity) === JSON.stringify({ opfs: "opfs:v86/disks/t1.img", uuid: "11111111-2222-3333-4444-555555555555" }), "identity " + JSON.stringify(disk.identity));
    check(disk.generation() === "7", "the record's generation " + disk.generation());
    const [zeros] = await call(disk.get.bind(disk), 4096, 512);
    check(zeros.length === 512 && zeros.every(b => b === 0), "zeros");
    const data = new Uint8Array(1024).map((_, i) => i * 7 & 0xFF);
    const [write_error] = await call(disk.set.bind(disk), 512, data);
    check(!write_error, "a write");
    check(disk.generation() === "8", "the session's first write moved the generation: " + disk.generation());
    await call(disk.set.bind(disk), 4096, data.subarray(0, 512));
    check(disk.generation() === "8", "the second write did not");
    const [read] = await call(disk.get.bind(disk), 512, 1024);
    check(read.every((b, i) => b === data[i]), "read back");
    log.push("read and write; the record's identity and generation 7; the session's first write moved it to 8, the second did not");

    // the timed flush: 1 s after the last write
    check(disk.flushes === 0, "no flush yet");
    await sleep(1300);
    check(disk.flushes === 1, "the timed flush: " + disk.flushes);
    log.push("the timed flush 1 s after the last write");

    // a snapshot: the reference; the next write moves the generation; then the reference no longer fits
    const state = disk.get_state();
    check(state[0] === "v86-writeback" && state[3] === "8" && state[4] === 1 << 20, "the reference " + JSON.stringify(state));
    disk.check_state(state);
    await call(disk.set.bind(disk), 0, data.subarray(0, 512));
    check(disk.generation() === "9", "the first write after the snapshot moved the generation");
    let refused = null;
    try { disk.check_state(state); } catch(e) { refused = e; }
    check(refused && /cannot go back/.test(refused.message), "a reference of before the write is refused");
    log.push("a snapshot's reference (generation 8, no data); the write after it moved the generation to 9; the reference refused then");

    // one writer: another disk on the same image cannot open it
    const second = new OpfsDisk("opfs:v86/disks/t1.img", { name: "hdb" });
    const busy = await load_error(second);
    check(busy && busy.kind === "in_use" && /used by another tab/.test(busy.message), "the second writer: " + (busy && busy.message));
    log.push("a second writer refused: " + busy.message.slice(0, 70) + "…");

    // the browser's quota: a write error not retried
    const write = disk.access.write.bind(disk.access);
    disk.access.write = () => { throw new globalThis.DOMException("The quota has been exceeded.", "QuotaExceededError"); };
    const [quota] = await call(disk.set.bind(disk), 0, data.subarray(0, 512));
    check(quota && quota.kind === "no_space" && quota.retryable === false && /storage for this site is full/.test(quota.message), "the quota's error " + (quota && quota.message));
    disk.access.write = write;
    log.push("QuotaExceededError: a write error of kind no_space, not retried");

    // closed: flushed, the record kept (with the manager's fields); another session opens it
    await call(disk.close.bind(disk));
    const record = await record_of(dir, "t1.img");
    check(record.generation === 9 && record.label === "kept" && record.size === 1 << 20, "the record " + JSON.stringify(record));
    const again = new OpfsDisk("opfs:v86/disks/t1.img", { name: "hda" });
    await again.load();
    again.check_state(again.get_state());
    const [after] = await call(again.get.bind(again), 512, 1024);
    check(after.every((b, i) => b === data[i]), "the data after closing");
    await call(again.close.bind(again));
    log.push("closed and opened again: the data and the record (generation 9, the manager's label) kept");

    // the checks at the start
    await file("odd.img", 1000);
    const odd = await load_error(new OpfsDisk("opfs:v86/disks/odd.img", { name: "hda" }));
    check(odd && /whole number of 512-byte sectors/.test(odd.message), "a size that is not whole sectors: " + (odd && odd.message));
    const sized = await load_error(new OpfsDisk("opfs:v86/disks/t1.img", { name: "hda", size: 2048 }));
    check(sized && /the descriptor's size says 2048/.test(sized.message), "the descriptor's size");
    const missing = await load_error(new OpfsDisk("opfs:v86/disks/none.img", { name: "hda" }));
    check(missing && /does not exist/.test(missing.message), "a disk that does not exist: " + (missing && missing.message));
    // (a disk without a record: one made, its generation moved as its size differs from none)
    await file("plain.img", 4096);
    const plain = new OpfsDisk("opfs:v86/disks/plain.img", { name: "hda" });
    await plain.load();
    check(/^[0-9a-f-]{36}$/.test(plain.identity.uuid) && plain.generation() === "2", "a disk without a record: " + plain.generation());
    await call(plain.close.bind(plain));
    log.push("refused at the start: not whole sectors, another size than the descriptor's, a disk that does not exist; a disk without a record gets one");
}

main().then(() => postMessage({ status: "PASS", log }), e => postMessage({ status: "FAIL", error: e.stack || e.message, log }));
