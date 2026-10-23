// @ts-check
// Android image packages in the VM manager (docs/android-images-plan.md
// I3): what a chosen file is (read on the page: the zip's directory, the
// start of its boot image and super's metadata) and the browser disk made
// from it in a worker (android_import_worker.js, build/android-import-worker.js).

import { package_entries, identify_package, cuttlefish_disk } from "../android/assemble.js";
import { reserve_disk, finish_disk } from "./browser_disks.js";
import { query_append } from "./emulator_bridge.js";

/** The userdata sizes offered (GiB) and the default (the owner's, 2026-10-23); first boot formats it */
export const USERDATA_GIB = [2, 4, 8, 16];
export const DEFAULT_USERDATA_GIB = 4;
const GIB = 1024 * 1024 * 1024;

/**
 * @typedef {{kind: string, text: string, device: string | undefined, disk_size: (userdata_gib: number) => number,
 *     data_bytes: number, super_size: number}} PackageInfo disk_size: the disk's with that userdata
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
 * What a chosen file is, and the disk it gives
 * @param {Blob} file
 * @return {Promise<PackageInfo>}
 */
export async function inspect_android_package(file)
{
    const read = file_reader(file);
    const entries = await package_entries(read, file.size);
    const kind = await identify_package(entries, read);
    if(!kind) throw new Error("Not an Android image package v64 knows (a Cuttlefish images zip, aosp_cf_arm64_only_phone-img-<build>.zip)");
    if(kind.kind !== "cuttlefish") throw new Error("This is " + kind.text + ": v64 does not import it yet");
    const disk = await cuttlefish_disk(read, entries, { userdata_bytes: GIB });
    return { kind: kind.kind, text: kind.text, device: kind.device, disk_size: userdata_gib => disk.disk_size - GIB + userdata_gib * GIB,
        data_bytes: disk.data_bytes, super_size: disk.super_size };
}

/**
 * The browser disk of a package, made in a worker
 * @param {Blob & {name?: string}} file
 * @param {string} label
 * @param {{userdata_gib: number, prefs?: any, progress?: (done: number, total: number) => void}} options
 * @return {Promise<import("./browser_disks.js").BrowserDisk>}
 */
export async function import_android_package(file, label, options)
{
    const info = await inspect_android_package(file);
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
            worker.postMessage({ file, id, userdata_bytes });
        });
        return await finish_disk(id, label, { source: file.name || "", android: { kind: result.kind, device: result.device, userdata_gib: options.userdata_gib } });
    }
    finally
    {
        worker.terminate();
    }
}
