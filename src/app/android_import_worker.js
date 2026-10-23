// The Android importer's worker (docs/android-images-plan.md I3.1): an
// image package (a File) made into a browser disk, v86/disks/<id>.img,
// through the file's sync access handle (dedicated workers only), as
// src/android/assemble.js lays it out. Bundled into
// build/android-import-worker.js; src/app/android_import.js starts it.
//
// in:  { file: File, id: string, userdata_bytes: number }
// out: { progress: [done, total] }..., then { done: { size, kind, partitions } } or { error: string }
// in:  { op: "wipe", id }: the disk's userdata and metadata wiped (their first MiB zeroed)
// out: { wiped: [names] } or { error: string }

import { package_entries, identify_package, cuttlefish_disk, write_disk } from "../android/assemble.js";
import { gpt_partitions } from "../android/gpt.js";

/** the browser disks' directory */
async function disks_directory()
{
    let dir = await navigator.storage.getDirectory();
    for(const name of ["v86", "disks"]) dir = await dir.getDirectoryHandle(name, { create: true });
    return dir;
}

/** a browser disk's userdata and metadata: their first MiB zeroed */
async function wipe(id)
{
    const handle = await (await disks_directory()).getFileHandle(id + ".img");
    let access;
    try
    {
        access = await handle.createSyncAccessHandle();
    }
    catch(e)
    {
        throw new Error("the disk is in use: power the machine off first (" + e.message + ")");
    }
    try
    {
        const size = access.getSize();
        const read = (offset, length) =>
        {
            const bytes = new Uint8Array(length);
            return bytes.subarray(0, access.read(bytes, { at: offset }));
        };
        const wiped = [];
        for(const p of gpt_partitions(read, size))
        {
            if(p.name !== "userdata" && p.name !== "metadata") continue;
            access.write(new Uint8Array(Math.min(p.size, 1 << 20)), { at: p.start });
            wiped.push(p.name);
        }
        if(!wiped.length) throw new Error("the disk has no userdata or metadata partition");
        access.flush();
        return wiped;
    }
    finally
    {
        access.close();
    }
}

globalThis.onmessage = async event =>
{
    if(event.data.op === "wipe")
    {
        try { postMessage({ wiped: await wipe(event.data.id) }); }
        catch(e) { postMessage({ error: e && e.message || String(e) }); }
        return;
    }
    const { file, id, userdata_bytes } = event.data;
    /** @type {any} */
    let dir = null, access = null;
    try
    {
        const read = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        const entries = await package_entries(read, file.size);
        const kind = await identify_package(entries, read);
        if(!kind) throw new Error(file.name + " is not an Android image package v64 knows (a Cuttlefish images zip)");
        if(kind.kind !== "cuttlefish") throw new Error(file.name + " is " + kind.text + ": not imported yet");
        const disk = await cuttlefish_disk(read, entries, { userdata_bytes });
        dir = await disks_directory();
        const handle = await dir.getFileHandle(id + ".img", { create: true });
        access = await handle.createSyncAccessHandle();
        access.truncate(disk.disk_size);
        let shown = 0;
        await write_disk(read, disk, (offset, bytes) =>
        {
            if(access.write(bytes, { at: offset }) !== bytes.length) throw new Error("a short write into the browser disk (no room?)");
        }, (done, total) =>
        {
            // (at most every 1/200th)
            if(done - shown >= total / 200 || done === total)
            {
                shown = done;
                postMessage({ progress: [done, total] });
            }
        });
        access.flush();
        access.close();
        access = null;
        postMessage({ done: { size: disk.disk_size, kind: kind.kind, device: kind.device,
            partitions: disk.partitions.map(p => ({ name: p.name, start: p.start, size: p.size })) } });
    }
    catch(e)
    {
        try { access && access.close(); } catch(_) { /* closed */ }
        if(dir) await dir.removeEntry(id + ".img").catch(() => {});
        postMessage({ error: e && e.message || String(e) });
    }
};
