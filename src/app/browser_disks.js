// @ts-check
// Browser disks, managed (docs/vm-manager-plan.md "浏览器磁盘（OPFS）", "管理",
// U6): images in the browser's private file system (v86/disks/<id>.img, its
// record <id>.json beside it, src/opfs_disk.js), made empty, imported from a
// URL or a file (a copy: the source stays as it is; checked with SHA-256),
// exported, deleted; the space they take. A machine names one with the url
// "opfs:v86/disks/<id>.img" (an image of kind "browser").

import { SHA256 } from "../image/sha256.js";
import { new_id } from "./vm_config.js";

/** @typedef {{id: string, path: string, size: number, label: string, created: string, generation: number}} BrowserDisk */

const DISKS = ["v86", "disks"];
/** The prefix of a browser disk's path (an image's `path`) */
export const DISK_PATH = DISKS.join("/") + "/";

/**
 * The directory of the browser disks (made when missing)
 * @return {Promise<FileSystemDirectoryHandle>}
 */
async function disks_directory()
{
    let dir = await navigator.storage.getDirectory();
    for(const name of DISKS) dir = await dir.getDirectoryHandle(name, { create: true });
    return dir;
}

/**
 * A disk's path of its id
 * @param {string} id
 */
export function disk_path(id)
{
    return DISK_PATH + id + ".img";
}

/**
 * The id of a disk's path, or "" for another path
 * @param {string} path
 */
export function disk_id(path)
{
    const match = /^v86\/disks\/([A-Za-z0-9_-]+)\.img$/.exec(path);
    return match ? match[1] : "";
}

/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} id
 * @return {Promise<any>}
 */
async function read_record(dir, id)
{
    try
    {
        return JSON.parse(await (await (await dir.getFileHandle(id + ".json")).getFile()).text());
    }
    catch(e)
    {
        return {};
    }
}

/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} id
 * @param {any} record
 */
async function write_record(dir, id, record)
{
    const writable = await (await dir.getFileHandle(id + ".json", { create: true })).createWritable();
    await writable.write(JSON.stringify(record));
    await writable.close();
}

/**
 * The browser disks
 * @return {Promise<BrowserDisk[]>}
 */
export async function list_disks()
{
    const dir = await disks_directory();
    const disks = [];
    for await (const [name, handle] of /** @type {any} */ (dir).entries())
    {
        const match = /^([A-Za-z0-9_-]+)\.img$/.exec(name);
        if(!match || handle.kind !== "file") continue;
        const file = await handle.getFile();
        const record = await read_record(dir, match[1]);
        disks.push({ id: match[1], path: disk_path(match[1]), size: file.size, label: record.label || match[1],
            created: record.created || new Date(file.lastModified).toISOString(), generation: record.generation || 1 });
    }
    return disks.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The browser's room for a new disk: refused (thrown) when there is not
 * enough; persistent storage asked for (once, with the first disk)
 * @param {number} size
 * @param {{get_pref: (name: string) => Promise<any>, put_pref: (name: string, value: any) => Promise<void>}} [prefs]
 */
export async function make_room(size, prefs)
{
    const estimate = await navigator.storage.estimate();
    const free = (estimate.quota || 0) - (estimate.usage || 0);
    if(estimate.quota && free < size)
    {
        throw new Error("The browser gives this site " + Math.floor(free / 1048576) + " MB more, the disk needs " + Math.ceil(size / 1048576) + " MB");
    }
    if(prefs && !await prefs.get_pref("persist_asked"))
    {
        await prefs.put_pref("persist_asked", true);
        await navigator.storage.persist?.().catch(() => false);
    }
}

/**
 * A new empty browser disk (zeros; sparse where the browser keeps it so)
 * @param {number} size bytes, a multiple of 512
 * @param {string} label
 * @param {Parameters<typeof make_room>[1]} [prefs]
 * @return {Promise<BrowserDisk>}
 */
export async function create_disk(size, label, prefs)
{
    if(!Number.isSafeInteger(size) || size <= 0 || size % 512) throw new Error("A disk's size is a positive multiple of 512 bytes");
    await make_room(size, prefs);
    const dir = await disks_directory();
    const id = new_id();
    const writable = await (await dir.getFileHandle(id + ".img", { create: true })).createWritable();
    await writable.truncate(size);
    await writable.close();
    const created = new Date().toISOString();
    await write_record(dir, id, { uuid: new_id(), generation: 1, size, label, created });
    return { id, path: disk_path(id), size, label, created, generation: 1 };
}

/**
 * A copy of an image as a new browser disk: its bytes streamed in, hashed
 * (SHA-256) on the way, the copy read back and hashed again
 * @param {File | string} source a file of the user's, or a URL
 * @param {string} label
 * @param {{prefs?: Parameters<typeof make_room>[1], progress?: (done: number, total: number) => void}} [options]
 * @return {Promise<BrowserDisk & {sha256: string}>}
 */
export async function import_disk(source, label, options = {})
{
    let stream, total;
    if(typeof source === "string")
    {
        const response = await fetch(source);
        if(!response.ok || !response.body) throw new Error("The image at " + source + " cannot be read (" + response.status + ")");
        total = Number(response.headers.get("Content-Length")) || 0;
        stream = response.body;
    }
    else
    {
        total = source.size;
        stream = source.stream();
    }
    if(total) await make_room(total, options.prefs);
    const dir = await disks_directory();
    const id = new_id();
    const handle = await dir.getFileHandle(id + ".img", { create: true });
    const writable = await handle.createWritable();
    const hash = new SHA256();
    let done = 0;
    try
    {
        const reader = stream.getReader();
        for(;;)
        {
            const { done: end, value } = await reader.read();
            if(end) break;
            hash.update(value);
            await writable.write(value);
            done += value.length;
            options.progress && options.progress(done, total);
        }
        if(total && done !== total) throw new Error("The image has " + done + " bytes, " + total + " were announced");
        if(done % 512) throw new Error("The image has " + done + " bytes, not a whole number of 512-byte sectors");
        await writable.close();
    }
    catch(e)
    {
        await writable.abort().catch(() => {});
        await dir.removeEntry(id + ".img").catch(() => {});
        throw e;
    }
    const sha256 = hash.hex();
    // (the copy read back: the same bytes)
    const check = new SHA256();
    const copy = await handle.getFile();
    const reader = copy.stream().getReader();
    for(;;)
    {
        const { done: end, value } = await reader.read();
        if(end) break;
        check.update(value);
    }
    if(copy.size !== done || check.hex() !== sha256)
    {
        await dir.removeEntry(id + ".img").catch(() => {});
        throw new Error("The copy differs from the image (SHA-256)");
    }
    const created = new Date().toISOString();
    await write_record(dir, id, { uuid: new_id(), generation: 1, size: done, label, created, sha256,
        source: typeof source === "string" ? source : source.name });
    return { id, path: disk_path(id), size: done, label, created, generation: 1, sha256 };
}

/**
 * A browser disk's image as a File (to export it, or read it)
 * @param {string} id
 * @return {Promise<File>}
 */
export async function disk_file(id)
{
    return (await (await disks_directory()).getFileHandle(id + ".img")).getFile();
}

/**
 * Save a browser disk as a file of the user's: streamed into the file where
 * the browser lets the page write one (Chromium), else downloaded as it is
 * (the browser reads the file as it saves it, not into memory)
 * @param {string} id
 * @param {string} name
 * @param {(parts: BlobPart[], name: string) => void} download
 */
export async function export_disk(id, name, download)
{
    const file = await disk_file(id);
    const picker = /** @type {any} */ (window).showSaveFilePicker;
    if(typeof picker === "function")
    {
        let handle;
        try { handle = await picker({ suggestedName: name }); }
        catch(e) { if(e.name === "AbortError") return; throw e; }
        const writable = await handle.createWritable();
        await file.stream().pipeTo(writable);
        return;
    }
    download([file], name);
}

/**
 * Delete a browser disk and its record; refused while a machine uses it (another tab's)
 * @param {string} id
 */
export async function delete_disk(id)
{
    const dir = await disks_directory();
    try
    {
        await dir.removeEntry(id + ".img");
    }
    catch(e)
    {
        if(e.name === "NotFoundError") return;
        if(e.name === "NoModificationAllowedError" || e.name === "InvalidModificationError") throw new Error("The disk is in use: power its machine off first");
        throw e;
    }
    await dir.removeEntry(id + ".json").catch(() => {});
}

/**
 * Rename a browser disk (its label)
 * @param {string} id
 * @param {string} label
 */
export async function rename_disk(id, label)
{
    const dir = await disks_directory();
    const record = await read_record(dir, id);
    record.label = label;
    await write_record(dir, id, record);
}
