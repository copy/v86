// @ts-check
// Android image packages in the VM manager (docs/android-images-plan.md
// I3): what a chosen file is (read on the page: the zip's directory, the
// start of its boot image and super's metadata) and the browser disk made
// from it in a worker (android_import_worker.js, build/android-import-worker.js).

import { package_entries, identify_package, cuttlefish_disk, gsi_package } from "../android/assemble.js";
import { reserve_disk, finish_disk } from "./browser_disks.js";
import { query_append } from "./emulator_bridge.js";
import { catalog_parts_of } from "./android_catalog.js";

/** The userdata sizes offered (GiB) and the default (the owner's, 2026-10-23); first boot formats it */
export const USERDATA_GIB = [2, 4, 8, 16];
export const DEFAULT_USERDATA_GIB = 4;
const GIB = 1024 * 1024 * 1024;

/**
 * @typedef {{kind: string, text: string, device: string | undefined, disk_size: (userdata_gib: number) => number,
 *     data_bytes: number, super_size: number, vendor_sdk_full: string,
 *     gsi: {name: string, release: string, sdk_full: string, fingerprint: string, abilist32: string} | null}} PackageInfo
 *     disk_size: the disk's with that userdata; gsi: the system the device runs in place of its own
 */

/**
 * @param {Blob} file
 * @return {(offset: number, length: number) => Promise<Uint8Array>}
 */
function file_reader(file)
{
    return async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
}

/**
 * The chosen files sorted: the device's package (a Cuttlefish images zip)
 * and a GSI (docs/android-images-plan.md I5), each read on the page
 * @param {File[]} files
 * @return {Promise<{device: File | null, gsi: File | null, debug_ramdisk: File | null}>}
 */
export async function sort_android_files(files)
{
    /** @type {{device: any, gsi: any, debug_ramdisk: any}} */
    const sorted = { device: null, gsi: null, debug_ramdisk: null };
    for(const file of files)
    {
        // (the catalog's debug vendor ramdisk, by its size: not a zip)
        if(catalog_parts_of(file).some(p => p.role === "debug_ramdisk")) { sorted.debug_ramdisk = file; continue; }
        const read = file_reader(file);
        const kind = await identify_package(await package_entries(read, file.size), read);
        const name = file.name || "the file";
        if(!kind) throw new Error(name + " is not an Android image package v64 knows (a Cuttlefish images zip, aosp_cf_arm64_only_phone-img-<build>.zip, or a GSI zip)");
        if(kind.kind === "cuttlefish") sorted.device = file;
        else if(kind.kind === "gsi") sorted.gsi = file;
        else throw new Error(name + " is " + kind.text + ": v64 does not import it yet");
    }
    return sorted;
}

/**
 * What the package (and a GSI with it) gives: the device, the disk
 * @param {Blob} file the device's package
 * @param {(Blob & {name?: string}) | null} [gsi_file]
 * @return {Promise<PackageInfo>}
 */
export async function inspect_android_package(file, gsi_file = null)
{
    const read = file_reader(file);
    const entries = await package_entries(read, file.size);
    const kind = await identify_package(entries, read);
    if(!kind) throw new Error("Not an Android image package v64 knows (a Cuttlefish images zip, aosp_cf_arm64_only_phone-img-<build>.zip)");
    if(kind.kind === "gsi") throw new Error("This is a GSI: a system for a device; add the device's package (a Cuttlefish images zip) with it");
    if(kind.kind !== "cuttlefish") throw new Error("This is " + kind.text + ": v64 does not import it yet");
    let gsi = null, gsi_read;
    if(gsi_file)
    {
        gsi_read = file_reader(gsi_file);
        gsi = await gsi_package(gsi_read, await package_entries(gsi_read, gsi_file.size));
    }
    const disk = await cuttlefish_disk(read, entries, { userdata_bytes: GIB, gsi: gsi || undefined, gsi_read });
    return { kind: kind.kind, text: kind.text, device: kind.device, disk_size: userdata_gib => disk.disk_size - GIB + userdata_gib * GIB,
        data_bytes: disk.data_bytes, super_size: disk.super_size, vendor_sdk_full: disk.vendor_sdk_full,
        gsi: gsi && { name: gsi_file && gsi_file.name || "", release: gsi.release, sdk_full: gsi.sdk_full, fingerprint: gsi.fingerprint, abilist32: gsi.abilist32 } };
}

/**
 * The browser disk of a package (with a GSI), made in a worker
 * @param {Blob & {name?: string}} file
 * @param {string} label
 * @param {{userdata_gib: number, gsi?: (Blob & {name?: string}) | null, prefs?: any, progress?: (done: number, total: number) => void}} options
 * @return {Promise<import("./browser_disks.js").BrowserDisk>}
 */
export async function import_android_package(file, label, options)
{
    const info = await inspect_android_package(file, options.gsi || null);
    const userdata_bytes = options.userdata_gib * GIB;
    const { id } = await reserve_disk(info.disk_size(options.userdata_gib), options.prefs);
    const worker = new Worker("build/android-import-worker.js" + query_append(), { type: "module" });
    try
    {
        /** @type {any} */
        const result = await new Promise((resolve, reject) =>
        {
            worker.onmessage = e =>
            {
                if(e.data.progress) options.progress && options.progress(e.data.progress[0], e.data.progress[1]);
                else if(e.data.done) resolve(e.data.done);
                else reject(new Error(e.data.error));
            };
            worker.onerror = e => reject(new Error("The importer's worker failed: " + (e.message || "it did not start")));
            worker.postMessage({ file, gsi_file: options.gsi || null, id, userdata_bytes });
        });
        return await finish_disk(id, label, { source: file.name || "", android: { kind: result.kind, device: result.device, userdata_gib: options.userdata_gib,
            gsi: options.gsi ? options.gsi.name || "" : undefined } });
    }
    finally
    {
        worker.terminate();
    }
}

/**
 * A browser disk's Android user data wiped: the start of its userdata and
 * metadata partitions zeroed (their file systems' superblocks), which
 * Android formats again at its next boot (fs_mgr's formattable). In the
 * importer's worker, through the file's sync access handle: not while the
 * machine runs (its CPU holds the disk open)
 * @param {string} id the browser disk's
 * @return {Promise<string[]>} the partitions wiped
 */
export async function wipe_android_data(id)
{
    const worker = new Worker("build/android-import-worker.js" + query_append(), { type: "module" });
    try
    {
        return await new Promise((resolve, reject) =>
        {
            worker.onmessage = e => e.data.wiped ? resolve(e.data.wiped) : reject(new Error(e.data.error));
            worker.onerror = e => reject(new Error("The importer's worker failed: " + (e.message || "it did not start")));
            worker.postMessage({ op: "wipe", id });
        });
    }
    finally
    {
        worker.terminate();
    }
}

/**
 * A file's SHA-256, in the importer's worker
 * @param {Blob} file
 * @param {(done: number, total: number) => void} [progress]
 * @return {Promise<string>}
 */
export async function hash_file(file, progress)
{
    const worker = new Worker("build/android-import-worker.js" + query_append(), { type: "module" });
    try
    {
        return await new Promise((resolve, reject) =>
        {
            worker.onmessage = e =>
            {
                if(e.data.progress) progress && progress(e.data.progress[0], e.data.progress[1]);
                else if(e.data.sha256) resolve(e.data.sha256);
                else reject(new Error(e.data.error));
            };
            worker.onerror = e => reject(new Error("The importer's worker failed: " + (e.message || "it did not start")));
            worker.postMessage({ op: "hash", file });
        });
    }
    finally
    {
        worker.terminate();
    }
}
