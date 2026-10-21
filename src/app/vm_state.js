// @ts-check
// Suspended machines (docs/vm-manager-plan.md "存储与持久化", U5): a
// machine's state saved as a V7 stream into the browser's private file
// system (OPFS, v86/states/<id>.bin), the space it needs checked first,
// persistent storage asked for once; the configuration's digest, to tell
// whether its settings changed after it was suspended; the lock that keeps
// a machine in one tab (navigator.locks).

/** @typedef {import("./vm_config.js").VMConfig} VMConfig */

const STATES = ["v86", "states"];

/**
 * The directory of the states (made when missing)
 * @return {Promise<FileSystemDirectoryHandle>}
 */
async function states_directory()
{
    let dir = await navigator.storage.getDirectory();
    for(const name of STATES) dir = await dir.getDirectoryHandle(name, { create: true });
    return dir;
}

/**
 * @param {string} id
 */
function state_name(id)
{
    return id.replace(/[^A-Za-z0-9_-]/g, "_") + ".bin";
}

/**
 * The suspended state's file of a machine, or undefined
 * @param {string} id
 * @return {Promise<File | undefined>}
 */
export async function read_state(id)
{
    try
    {
        return await (await (await states_directory()).getFileHandle(state_name(id))).getFile();
    }
    catch(e)
    {
        if(e.name === "NotFoundError") return undefined;
        throw e;
    }
}

/**
 * Remove a machine's suspended state (none: nothing to do)
 * @param {string} id
 */
export async function delete_state(id)
{
    try
    {
        await (await states_directory()).removeEntry(state_name(id));
    }
    catch(e)
    {
        if(e.name !== "NotFoundError") throw e;
    }
}

/**
 * Save a machine's state into its file, as a V7 stream written as it is
 * made; the file is replaced only when the whole state is written
 * @param {string} id
 * @param {(write: (chunk: Uint8Array) => any) => Promise<any>} save the emulator's save_state_stream
 * @return {Promise<number>} its size
 */
export async function write_state(id, save)
{
    const dir = await states_directory();
    const handle = await dir.getFileHandle(state_name(id), { create: true });
    const writable = await handle.createWritable();
    let size = 0;
    try
    {
        await save(chunk => { size += chunk.length; return writable.write(chunk.slice()); });
        await writable.close();
    }
    catch(e)
    {
        await writable.abort().catch(() => {});
        throw e;
    }
    return size;
}

/**
 * The browser's space for this site: what is free, and whether it is kept
 * when the browser runs short (persistent)
 * @return {Promise<{free: number, usage: number, quota: number, persisted: boolean}>}
 */
export async function storage_space()
{
    const estimate = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { free: Math.max(0, (estimate.quota || 0) - (estimate.usage || 0)), usage: estimate.usage || 0, quota: estimate.quota || 0, persisted };
}

/**
 * About how much a machine's state takes: its RAM and video memory (the
 * stream holds them whole), and a margin for the devices
 * @param {any} options the machine's V86 options
 */
export function state_estimate(options)
{
    return (options.memory_size || 0) + (options.extended_memory_size || 0) + (options.vram_size || 0) + (16 << 20);
}

/**
 * The digest of a configuration's machine: its settings without the name,
 * notes, times and the suspension itself (a change of them does not matter
 * to a saved state)
 * @param {VMConfig} config
 * @return {Promise<string>}
 */
export async function machine_digest(config)
{
    /** @type {any} */
    const machine = JSON.parse(JSON.stringify(config));
    for(const name of ["id", "name", "notes", "guest", "template", "created", "modified", "suspended"]) delete machine[name];
    const canonical = value => Array.isArray(value) ? value.map(canonical) :
        value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
    const bytes = new TextEncoder().encode(JSON.stringify(canonical(machine)));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}

/** A machine's lock's name */
export function lock_name(id)
{
    return "v86-vm-" + id;
}

/**
 * Hold a machine's lock while it runs in this tab: null when another tab holds it
 * @param {string} id
 * @return {Promise<{release: () => void} | null>}
 */
export function hold_machine(id)
{
    if(!navigator.locks) return Promise.resolve({ release: () => {} });
    return new Promise(resolve =>
    {
        navigator.locks.request(lock_name(id), { ifAvailable: true }, lock =>
        {
            if(!lock)
            {
                resolve(null);
                return undefined;
            }
            // (held until released: the tab closes, or the machine powers off)
            return new Promise(release => resolve({ release: () => release(undefined) }));
        });
    });
}

/**
 * The machines that run in a tab now (their locks are held)
 * @return {Promise<Set<string>>}
 */
export async function running_machines()
{
    if(!navigator.locks) return new Set();
    const state = await navigator.locks.query();
    return new Set((state.held || []).map(lock => lock.name || "").filter(name => name.startsWith("v86-vm-")).map(name => name.slice(7)));
}
