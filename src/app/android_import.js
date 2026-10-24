// @ts-check
// Android image packages in the VM manager (docs/android-images-plan.md
// I3): what a chosen file is (read on the page: the zip's directory, the
// start of its boot image and super's metadata) and the browser disk made
// from it in a worker (android_import_worker.js, build/android-import-worker.js).

import { package_entries, identify_package, cuttlefish_disk, emulator_disk, gsi_package } from "../android/assemble.js";
import { reserve_disk, finish_disk, delete_disk } from "./browser_disks.js";
import { create_image, list_images, new_image_name } from "./disk_service_client.js";
import { query_append } from "./emulator_bridge.js";
import { catalog_parts_of } from "./android_catalog.js";

/** The userdata sizes offered (GiB) and the default (the owner's, 2026-10-23); first boot formats it */
export const USERDATA_GIB = [2, 4, 8, 16];
export const DEFAULT_USERDATA_GIB = 4;
const GIB = 1024 * 1024 * 1024;

/**
 * @typedef {{kind: string, text: string, device: string | undefined, disk_size: (userdata_gib: number) => number,
 *     data_bytes: number, super_size: number, vendor_sdk_full: string,
 *     gsi: {name: string, release: string, sdk_full: string, fingerprint: string, abilist32: string} | null,
 *     emulator: {api: number, abi: string, tag: string, release: string, cpu: string} | null}} PackageInfo
 *     disk_size: the disk's with that userdata (an emulator image's: its own userdata.img, whatever the size);
 *     gsi: the system the device runs in place of its own; emulator: an Android Emulator image's (I6)
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
        if(!kind) throw new Error(name + " is not an Android image package v64 knows (a Cuttlefish images zip, aosp_cf_arm64_only_phone-img-<build>.zip, " +
            "a GSI zip, or an Android Emulator image zip)");
        if(kind.kind === "cuttlefish" || kind.kind === "emulator") sorted.device = file;
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
    if(!kind) throw new Error("Not an Android image package v64 knows (a Cuttlefish images zip, aosp_cf_arm64_only_phone-img-<build>.zip, " +
        "an Android Emulator image zip)");
    if(kind.kind === "gsi") throw new Error("This is a GSI: a system for a device; add the device's package (a Cuttlefish images zip) with it");
    if(kind.kind === "emulator")
    {
        if(gsi_file) throw new Error("A GSI goes with a Cuttlefish images zip, not with an emulator image");
        const disk = await emulator_disk(read, entries);
        return { kind: kind.kind, text: kind.text, device: disk.device.id, disk_size: () => disk.disk_size, data_bytes: disk.data_bytes,
            super_size: 0, vendor_sdk_full: "", gsi: null,
            emulator: { api: disk.api, abi: disk.abi, tag: disk.tag, release: disk.release, cpu: disk.device.cpu } };
    }
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
        gsi: gsi && { name: gsi_file && gsi_file.name || "", release: gsi.release, sdk_full: gsi.sdk_full, fingerprint: gsi.fingerprint, abilist32: gsi.abilist32 },
        emulator: null };
}

/**
 * The importer's worker on a message: its progress, then its answer;
 * signal aborts it (the worker ended at once)
 * @param {any} message
 * @param {{progress?: (done: number, total: number) => void, signal?: AbortSignal}} options
 * @return {Promise<any>}
 */
function run_worker(message, options)
{
    const worker = new Worker("build/android-import-worker.js" + query_append(), { type: "module" });
    return new Promise((resolve, reject) =>
    {
        const end = () => { worker.terminate(); options.signal && options.signal.removeEventListener("abort", abort); };
        const abort = () => { end(); reject(new Error("Cancelled")); };
        if(options.signal && options.signal.aborted) { abort(); return; }
        options.signal && options.signal.addEventListener("abort", abort);
        worker.onmessage = e =>
        {
            if(e.data.progress) { options.progress && options.progress(e.data.progress[0], e.data.progress[1]); return; }
            end();
            if(e.data.error) reject(new Error(e.data.error));
            else resolve(e.data);
        };
        worker.onerror = e => { end(); reject(new Error("The importer's worker failed: " + (e.message || "it did not start"))); };
        worker.postMessage(message);
    });
}

/**
 * The browser disk of a package (with a GSI), made in a worker; cancelled
 * by signal (the disk made so far deleted)
 * @param {Blob & {name?: string}} file
 * @param {string} label
 * @param {{userdata_gib: number, gsi?: (Blob & {name?: string}) | null, prefs?: any, progress?: (done: number, total: number) => void,
 *     signal?: AbortSignal}} options
 * @return {Promise<import("./browser_disks.js").BrowserDisk>}
 */
export async function import_android_package(file, label, options)
{
    const info = await inspect_android_package(file, options.gsi || null);
    const userdata_bytes = options.userdata_gib * GIB;
    const { id } = await reserve_disk(info.disk_size(options.userdata_gib), options.prefs);
    /** @type {any} */
    let result;
    try
    {
        result = (await run_worker({ file, gsi_file: options.gsi || null, id, userdata_bytes }, options)).done;
    }
    catch(e)
    {
        // (the worker's handle on the file goes with it: the disk deleted once it can be)
        for(let i = 0; i < 20; i++)
        {
            try { await delete_disk(id); break; }
            catch(_) { await new Promise(resolve => setTimeout(resolve, 250)); }
        }
        throw e;
    }
    return await finish_disk(id, label, { source: file.name || "", android: { kind: result.kind, device: result.device, userdata_gib: options.userdata_gib,
        gsi: options.gsi ? options.gsi.name || "" : undefined } });
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
    return (await run_worker({ op: "wipe", id }, {})).wiped;
}

/**
 * A file's SHA-256, in the importer's worker
 * @param {Blob} file
 * @param {(done: number, total: number) => void} [progress]
 * @return {Promise<string>}
 */
export async function hash_file(file, progress)
{
    return (await run_worker({ op: "hash", file }, { progress })).sha256;
}

/**
 * A package (with a GSI) made into a new image of the disk service
 * (docs/android-images-plan.md I3.2): the image created, then written by
 * the importer's worker through a write session
 * @param {Blob & {name?: string}} file
 * @param {string} machine the machine's name (the image's)
 * @param {import("./disk_service_client.js").Service} service
 * @param {{userdata_gib: number, gsi?: (Blob & {name?: string}) | null, progress?: (done: number, total: number) => void, signal?: AbortSignal}} options
 *     signal: cancelled (the image created stays: the service has no delete; its name said)
 * @return {Promise<{url: string, size: number}>}
 */
export async function import_android_package_to_service(file, machine, service, options)
{
    const info = await inspect_android_package(file, options.gsi || null);
    const size = info.disk_size(options.userdata_gib);
    const image = await create_image(service, new_image_name(machine, (await list_images(service)).images), size);
    try
    {
        await run_worker({ file, gsi_file: options.gsi || null, id: "", userdata_bytes: options.userdata_gib * GIB,
            service: { url: image.url, token: service.token } }, options);
    }
    catch(e)
    {
        throw new Error(e.message + " (the disk service keeps the image made so far, " + image.name + ")");
    }
    return { url: image.url, size };
}
