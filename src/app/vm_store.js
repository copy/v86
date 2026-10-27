// @ts-check
// The VM manager's library (docs/vm-manager-plan.md, "存储与持久化", U1):
// the configurations in IndexedDB (the database v86-vm-manager: the store
// vms by id, handles, the FileSystemFileHandles of the files the
// configurations name, and prefs, the manager's preferences such as its disk
// service, U3), and a configuration's export to a .v86vm.json file and
// import from one. The suspended states and the browser disks in OPFS come
// with U5 and U6.

import { migrate, validate_config, new_id } from "./vm_config.js";
import { machine_digest } from "./vm_state.js";

/** @typedef {import("./vm_config.js").VMConfig} VMConfig */
/** @typedef {import("./vm_config.js").Image} Image */

export const DB_NAME = "v86-vm-manager";
/** 1: vms, handles; 2: prefs */
const DB_VERSION = 2;
const VMS = "vms";
const HANDLES = "handles";
const PREFS = "prefs";

/**
 * A request's result
 * @template T
 * @param {IDBRequest<T>} request
 * @return {Promise<T>}
 */
function done(request)
{
    return new Promise((resolve, reject) =>
    {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * A transaction's end
 * @param {IDBTransaction} transaction
 * @return {Promise<void>}
 */
function complete(transaction)
{
    return new Promise((resolve, reject) =>
    {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error("The transaction was aborted"));
    });
}

/**
 * The images a configuration names, wherever they are
 * @param {VMConfig} config
 * @return {Image[]}
 */
export function config_images(config)
{
    return [config.machine.bios, config.machine.vga_bios, config.machine.uefi_vars, config.tpm && config.tpm.state,
        ...config.disks.map(d => d.image), ...(config.usb ? config.usb.disks.map(d => d.image) : []),
        config.cdrom.image,
        ...config.floppies.map(f => f.image), config.kernel && config.kernel.bzimage, config.kernel && config.kernel.initrd,
        config.kernel && config.kernel.multiboot, config.initial_state].filter(image => !!image);
}

/**
 * Why a configuration cannot be stored: its problems (validate_config), one per line
 * @param {import("./vm_config.js").Problem[]} problems
 * @return {Error}
 */
function invalid(problems)
{
    const error = new Error("The virtual machine's settings are not valid:\n" + problems.map(p => p.path + ": " + p.message).join("\n"));
    /** @type {any} */ (error).problems = problems;
    return error;
}

export class VMStore
{
    /**
     * @param {IDBDatabase} db
     */
    constructor(db)
    {
        this.db = db;
    }

    /**
     * Open (and on the first use create) the library
     * @param {string} [name] the database's name (tests use their own)
     * @return {Promise<VMStore>}
     */
    static async open(name = DB_NAME)
    {
        const request = globalThis.indexedDB.open(name, DB_VERSION);
        request.onupgradeneeded = () =>
        {
            const db = request.result;
            if(!db.objectStoreNames.contains(VMS)) db.createObjectStore(VMS, { keyPath: "id" });
            if(!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
            if(!db.objectStoreNames.contains(PREFS)) db.createObjectStore(PREFS);
        };
        return new VMStore(await done(request));
    }

    close()
    {
        this.db.close();
    }

    /**
     * Every configuration, in the current version, by name
     * @return {Promise<VMConfig[]>}
     */
    async list()
    {
        const transaction = this.db.transaction(VMS, "readonly");
        const all = await done(transaction.objectStore(VMS).getAll());
        const configs = await Promise.all(all.map(raw => this.current(raw)));
        return configs.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    }

    /**
     * @param {string} id
     * @return {Promise<VMConfig | undefined>}
     */
    async get(id)
    {
        const raw = await done(this.db.transaction(VMS, "readonly").objectStore(VMS).get(id));
        return raw === undefined ? undefined : this.current(raw);
    }

    /**
     * A stored configuration in the current version (migrate). A suspended
     * machine's digest (src/app/vm_state.js) is of the configuration as it
     * was stored; a migration changes the form, not the guest's hardware
     * (version 3: a PC's sound "none" was a muted Sound Blaster and becomes
     * one), so where the digest was still right the new form's replaces it,
     * and the configuration is stored in the new form: otherwise every
     * suspended machine would say its settings changed
     * @param {any} raw
     * @return {Promise<VMConfig>}
     */
    async current(raw)
    {
        const config = migrate(raw);
        if(raw.version === config.version || !config.suspended) return config;
        if(config.suspended.digest !== await machine_digest(raw)) return config;
        config.suspended = Object.assign({}, config.suspended, { digest: await machine_digest(config) });
        const transaction = this.db.transaction(VMS, "readwrite");
        transaction.objectStore(VMS).put(config);
        await complete(transaction);
        return config;
    }

    /**
     * Store a configuration (new or changed): checked first, its time of change set
     * @param {VMConfig} config
     * @return {Promise<VMConfig>} what was stored
     */
    async put(config)
    {
        const problems = validate_config(config);
        if(problems.length) throw invalid(problems);
        const stored = Object.assign({}, config, { modified: new Date().toISOString() });
        const transaction = this.db.transaction(VMS, "readwrite");
        transaction.objectStore(VMS).put(stored);
        await complete(transaction);
        return stored;
    }

    /**
     * Delete a configuration and the handles of its files (its browser disks
     * and suspended state: U5, U6)
     * @param {string} id
     */
    async delete(id)
    {
        const config = await this.get(id);
        const transaction = this.db.transaction([VMS, HANDLES], "readwrite");
        transaction.objectStore(VMS).delete(id);
        for(const image of config ? config_images(config) : [])
        {
            if(image.kind === "file" && image.handle) transaction.objectStore(HANDLES).delete(image.handle);
        }
        await complete(transaction);
    }

    /**
     * Keep a file's handle (Chrome and Edge keep a FileSystemFileHandle in
     * IndexedDB; the page asks for its permission again when it starts the machine)
     * @param {FileSystemFileHandle} handle
     * @return {Promise<string>} the handle's id, for the image's `handle`
     */
    async put_handle(handle)
    {
        const id = new_id();
        const transaction = this.db.transaction(HANDLES, "readwrite");
        transaction.objectStore(HANDLES).put(handle, id);
        await complete(transaction);
        return id;
    }

    /**
     * @param {string} id
     * @return {Promise<FileSystemFileHandle | undefined>}
     */
    async get_handle(id)
    {
        return done(this.db.transaction(HANDLES, "readonly").objectStore(HANDLES).get(id));
    }

    /**
     * A preference (undefined when not set)
     * @param {string} name
     * @return {Promise<any>}
     */
    async get_pref(name)
    {
        return done(this.db.transaction(PREFS, "readonly").objectStore(PREFS).get(name));
    }

    /**
     * Set a preference (undefined: back to its default)
     * @param {string} name
     * @param {any} value
     */
    async put_pref(name, value)
    {
        const transaction = this.db.transaction(PREFS, "readwrite");
        if(value === undefined) transaction.objectStore(PREFS).delete(name);
        else transaction.objectStore(PREFS).put(value, name);
        await complete(transaction);
    }
}

/**
 * A configuration as a .v86vm.json file's text: the files' handles stay in
 * this browser (an imported configuration's files need to be chosen again)
 * @param {VMConfig} config
 * @return {string}
 */
export function export_config(config)
{
    /** @type {any} */
    const copy = JSON.parse(JSON.stringify(config));
    for(const image of config_images(copy))
    {
        if(image.kind === "file") delete image.handle;
    }
    return JSON.stringify(copy, null, 4) + "\n";
}

/**
 * The file name to export a configuration to
 * @param {VMConfig} config
 * @return {string}
 */
export function export_file_name(config)
{
    return (config.name.replace(/[^\p{L}\p{N} ._-]+/gu, "_").trim() || "virtual machine") + ".v86vm.json";
}

/**
 * A configuration of a .v86vm.json file's text, in the current version and
 * checked; a new id when it has none or the library has one with its id already
 * @param {string} text
 * @param {Set<string>} [ids] the library's configurations' ids
 * @return {VMConfig}
 */
export function import_config(text, ids = new Set())
{
    let raw;
    try
    {
        raw = JSON.parse(text);
    }
    catch(e)
    {
        throw new Error("The file is not a v86 virtual machine (not JSON: " + e.message + ")");
    }
    const config = migrate(raw);
    if(typeof config.id !== "string" || !config.id || ids.has(config.id)) config.id = new_id();
    const problems = validate_config(config);
    if(problems.length) throw invalid(problems);
    return config;
}

/**
 * The images that need their file chosen again: files without a handle (imported, or from a browser
 * that does not keep handles)
 * @param {VMConfig} config
 * @return {Image[]}
 */
export function files_to_choose(config)
{
    return config_images(config).filter(image => image.kind === "file" && !image.handle);
}
