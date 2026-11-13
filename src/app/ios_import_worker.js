// The iPhone firmware never leaves this browser worker or its local disk.
import { assemble_n90, inspect_n90_ipsw, verify_n90_keys, write_prepared_n90 } from "../ios/assemble.js";
import { N90_RESTORE } from "../ios/catalog.js";
import { ipsw_open } from "../ios/ipsw.js";
import { read_nand_boot } from "../ios/nand_boot.js";
import { open_sparse_nand } from "../ios/sparse_nand.js";
import { reset_install_trust } from "../ios/install_trust.js";

const reader = file => async (at, size) => new Uint8Array(await file.slice(at, at + size).arrayBuffer());

function disk_store(handle)
{
    return {
        read(at, size) {
            const bytes = new Uint8Array(size);
            return bytes.subarray(0, handle.read(bytes, { at }));
        },
        write(at, bytes) {
            if(handle.write(bytes, { at }) !== bytes.length) throw new Error("Incomplete write to browser storage");
        },
        resize(size) { handle.truncate(size); },
    };
}

function nand_store(handle)
{
    const disk = open_sparse_nand(handle, true);
    return { write: disk.write, resize(size) {
        if(size !== disk.size) throw new Error("Incorrect iPhone NAND size");
    } };
}

globalThis.onmessage = async ({ data }) => {
    let previousStage = "", previous = 0, directory, scratch, nand, cleanup;
    const progress = (stage, done, total) => {
        const percent = Math.min(100, Math.floor(done * 100 / total));
        if(stage !== previousStage || percent !== previous)
        {
            previousStage = stage;
            previous = percent;
            globalThis.postMessage({ progress: [stage, percent] });
        }
    };
    try
    {
        const read = reader(data.file);
        if(data.op === "inspect")
        {
            await inspect_n90_ipsw(read, data.file.size, progress);
            globalThis.postMessage({ result: N90_RESTORE });
            return;
        }
        if(data.op === "keys")
        {
            const ipsw = await ipsw_open(read, data.file.size);
            const failures = await verify_n90_keys(ipsw, data.keys, (name, ok, message) =>
                globalThis.postMessage({ check: [name, ok, message] }), progress);
            globalThis.postMessage({ result: failures });
            return;
        }
        if(!["import", "reset"].includes(data.op) || !/^[A-Za-z0-9_-]+$/.test(data.id)) throw new Error("Invalid iPhone disk request");
        directory = await navigator.storage.getDirectory();
        for(const name of ["v86", "disks"]) directory = await directory.getDirectoryHandle(name, { create: true });
        if(data.op === "reset")
        {
            const name = data.id + ".img";
            const current = await directory.getFileHandle(name);
            const access = await current.createSyncAccessHandle();
            let files;
            try { files = await read_nand_boot((open_sparse_nand(access) || disk_store(access)).read); }
            finally { access.close(); }
            const base = await directory.getFileHandle(data.id + ".ios-system").catch(() => {
                throw new Error("The original system volume is missing. Import the IPSW again to make a new iPhone disk.");
            });
            scratch = await base.createSyncAccessHandle();
            cleanup = data.id + ".ios-reset";
            const replacement = await directory.getFileHandle(cleanup, { create: true });
            if(typeof replacement.move !== "function") throw new Error("This browser cannot replace an iPhone disk safely");
            nand = await replacement.createSyncAccessHandle();
            await write_prepared_n90(disk_store(scratch).read, nand_store(nand), {
                kernel: new Uint8Array(files.kernel), tree: new Uint8Array(files.tree),
                logo: files.logo && new Uint8Array(files.logo), library: files.library && new Uint8Array(files.library),
                ...(files.install ? (() => { const cleared = reset_install_trust(files.kernel, files.install); return { kernel: cleared.kernel, install: cleared.state }; })() : {}),
            }, progress);
            nand.flush();
            nand.close();
            nand = null;
            scratch.close();
            scratch = null;
            // Only replace the writable disk after its replacement is complete.
            await replacement.move(name);
            cleanup = null;
            globalThis.postMessage({ result: true });
            return;
        }
        const ipsw = await inspect_n90_ipsw(read, data.file.size, progress);
        let library = null;
        if(data.acceleration)
        {
            if(data.library) library = new Uint8Array(await data.library.arrayBuffer());
            else
            {
                const response = await fetch(new URL("ios-guest/libv86gles.dylib", globalThis.location.href));
                if(!response.ok) throw new Error("The iPhone graphics adapter is missing. Choose a built libv86gles.dylib or turn off graphics acceleration for a diagnostic boot.");
                library = new Uint8Array(await response.arrayBuffer());
            }
        }
        // Keep the prepared, immutable system partition so Reset can
        // rebuild the data volume without asking for the firmware keys.
        cleanup = data.id + ".ios-system";
        scratch = await (await directory.getFileHandle(cleanup, { create: true })).createSyncAccessHandle();
        nand = await (await directory.getFileHandle(data.id + ".img", { create: true })).createSyncAccessHandle();
        const components = {};
        for(const [key, name] of [["agent", "v86-app-agent"], ["bootstrap", "libv86appbootstrap.dylib"], ["policy", "libv86install.dylib"]])
        {
            const response = await fetch(new URL("ios-install-fixtures/" + name, globalThis.location.href));
            if(!response.ok) throw new Error("The iPhone installation helper is missing. Build it with make ios-install-fixtures before importing this firmware.");
            components[key] = new Uint8Array(await response.arrayBuffer());
        }
        await assemble_n90(ipsw, data.keys, disk_store(scratch), nand_store(nand), library, progress, components);
        nand.flush();
        nand.close();
        nand = null;
        scratch.close();
        scratch = null;
        cleanup = null;
        globalThis.postMessage({ result: true });
    }
    catch(error)
    {
        globalThis.postMessage({ error: error?.message || String(error) });
    }
    finally
    {
        nand?.close();
        scratch?.close();
        if(directory && cleanup) await directory.removeEntry(cleanup).catch(() => {});
    }
};
