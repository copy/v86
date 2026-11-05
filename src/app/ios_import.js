// The VM manager keeps IPSW files and keys out of its saved configuration.
import { delete_disk, finish_disk, make_room, replace_disk_record, reserve_disk } from "./browser_disks.js";
import { query_append } from "./emulator_bridge.js";
import { N90_RESTORE } from "../ios/catalog.js";

export { N90_RESTORE };

function worker_request(message, options)
{
    const worker = new Worker("build/ios-import-worker.js" + query_append(), { type: "module" });
    return new Promise((resolve, reject) => {
        const close = () => { worker.terminate(); options.signal?.removeEventListener("abort", abort); };
        const abort = () => { close(); reject(new Error("Cancelled")); };
        if(options.signal?.aborted) { abort(); return; }
        options.signal?.addEventListener("abort", abort);
        worker.onmessage = ({ data }) => {
            if(data.progress) { options.progress?.(...data.progress); return; }
            if(data.check) { options.check?.(...data.check); return; }
            close();
            if(data.error) reject(new Error(data.error));
            else resolve(data.result);
        };
        worker.onerror = error => {
            close();
            reject(new Error("The iPhone import worker could not start: " + (error.message || "build/ios-import-worker.js")));
        };
        worker.postMessage(message);
    });
}

export function inspect_ios_package(file, options = {})
{
    return worker_request({ op: "inspect", file }, options);
}

export function verify_ios_keys(file, keys, options = {})
{
    return worker_request({ op: "keys", file, keys }, options);
}

async function discard_import(id)
{
    let directory = await navigator.storage.getDirectory();
    for(const name of ["v86", "disks"]) directory = await directory.getDirectoryHandle(name);
    const remove_scratch = () => directory.removeEntry(id + ".ios-system").catch(error => {
        if(error.name !== "NotFoundError") throw error;
    });
    for(let attempt = 0; attempt < 20; attempt++)
    {
        try { await remove_scratch(); await delete_disk(id); return; }
        catch(error)
        {
            if(attempt === 19) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

export async function reset_ios_data(id, progress)
{
    await make_room(2 * 1024 ** 3);
    await worker_request({ op: "reset", id }, { progress });
    await replace_disk_record(id, N90_RESTORE.nand_bytes);
}

export async function import_ios_package(file, keys, label, options)
{
    // Only written NAND chunks and the original system volume count.
    const { id } = await reserve_disk(4 * 1024 ** 3, options.prefs);
    try
    {
        await worker_request({ op: "import", id, file, keys,
            acceleration: options.acceleration, library: options.library || null }, options);
        return await finish_disk(id, label, { source: file.name, size: N90_RESTORE.nand_bytes,
            ios: { model: N90_RESTORE.model, build: N90_RESTORE.build } });
    }
    catch(error)
    {
        await discard_import(id);
        throw error;
    }
}
