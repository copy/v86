// The policy of a disk (docs/disk-persistence-plan.md): where the guest's
// writes go (disk_option: "read_only", the default, keeps them in memory;
// "read_write" writes them back to the image), and what a failed read or
// write does (disk_error: "stop", the default, stops the machine until
// run() retries the request; "report" ends the command with the device's
// error status). Both are options of each disk's descriptor, never of the
// V86 options themselves; they are checked when the machine is created (and
// when attach_sata_drive attaches a drive), before anything is loaded.
//
// A disk's buffer carries its policy for src/block_backend.js: disk_name
// (hda, hdb, sata<port>, cdrom, virtio_disk<n>) and disk_error.

/** what disk_option may be */
export const DISK_OPTIONS = ["read_only", "read_write"];

/** what disk_error may be */
export const DISK_ERRORS = ["stop", "report"];

/** what a buffer object of one's own needs for disk_option "read_write" (besides load, get, set) */
export const BACKEND_CONTRACT = ["flush", "close", "mark", "generation", "get_state", "set_state", "check_state"];

/**
 * What kind of descriptor a name is
 * @param {string} name
 * @return {string} "hard_disk", "cdrom", "floppy" or "other"
 */
export function disk_kind(name)
{
    if(name === "hda" || name === "hdb" || /^sata\d+$/.test(name) || /^virtio_disk\d+$/.test(name)) return "hard_disk";
    if(name === "cdrom") return "cdrom";
    if(name === "fda" || name === "fdb") return "floppy";
    return "other";
}

/**
 * @param {string} message
 * @return {!Error}
 */
function config_error(message)
{
    const error = new Error(message);
    /** @type {?} */ (error).kind = "config";
    return error;
}

/**
 * Whether we run in Node (where a disk's url is a local file path)
 * @return {boolean}
 */
export function in_node()
{
    return typeof process !== "undefined" && !!process.versions && !!process.versions.node &&
        typeof XMLHttpRequest === "undefined";
}

/**
 * Why a descriptor's image cannot take disk_option "read_write", or "" if
 * it can (docs/disk-persistence-plan.md "配置": a disk service's URL, a
 * local file in Node, a buffer object implementing the backend contract)
 * @param {string} name
 * @param {!Object} file
 * @return {string}
 */
export function writeback_problem(name, file)
{
    const keep = " Without disk_option (or with \"read_only\"), the guest's changes stay in memory.";
    if(file.get && file.set && file.load)
    {
        const missing = BACKEND_CONTRACT.filter(method => typeof file[method] !== "function");
        return missing.length ? name + ": a buffer object of one's own is written back only when it implements the backend contract " +
            "(docs/disk-persistence-plan.md, \"后端契约\"); it has no " + missing.join(", ") + "." + keep : "";
    }
    if(file.buffer instanceof ArrayBuffer)
    {
        return name + ": an ArrayBuffer is an image in memory, with no persistent source to write the changes back to." + keep +
            " (They change that ArrayBuffer itself: pass a copy to keep the original.)";
    }
    if(typeof Blob !== "undefined" && file.buffer instanceof Blob)
    {
        return name + ": a File cannot be written back (a browser does not write into a file the user picked in place). " +
            "To keep the changes in a file of your own, serve it with the local disk service (tools/disk-service.mjs)." + keep;
    }
    if(typeof file.url !== "string")
    {
        return name + ": disk_option \"read_write\" needs a url (a disk service, or a local file in Node)." + keep;
    }
    if(file.use_parts || file.url.endsWith(".zst"))
    {
        return name + ": an image in parts (use_parts, .zst) can only be read, not written back." + keep;
    }
    // (in Node a local file, src/disk_writeback.js; a URL: a disk service,
    // src/disk_service.js, which tells at the start whether it is one)
    return "";
}

/**
 * Whether a disk written back is a disk service's (a URL), not a local
 * file (in Node, a path)
 * @param {string} url
 * @return {boolean}
 */
export function is_service_url(url)
{
    return !in_node() || /^https?:\/\//i.test(url);
}

/**
 * Check a descriptor's disk_option, disk_error and token
 * @param {string} name hda, hdb, cdrom, fda, sata<port>, virtio_disk<n>, bios, ...
 * @param {*} file the descriptor (or a buffer object of one's own)
 * @return {{disk_option: string, disk_error: string}}
 */
export function check_disk_policy(name, file)
{
    const policy = { disk_option: "read_only", disk_error: "stop" };
    if(!file || typeof file !== "object") return policy;
    // (a browser disk, docs/vm-manager-plan.md U6: in a browser's private storage)
    if(typeof file.url === "string" && file.url.startsWith("opfs:") && in_node())
    {
        throw config_error(name + ": a browser disk (" + file.url + ") is in a browser's private storage (OPFS), not in Node");
    }
    const option = file.disk_option, on_error = file.disk_error, token = file.token;
    const kind = disk_kind(name);
    if(option !== undefined)
    {
        if(kind === "other" || kind === "cdrom")
        {
            throw config_error(name + ": disk_option is for disks (hda, hdb, fda, fdb, SATA drives, virtio_disks), not " + name);
        }
        if(!DISK_OPTIONS.includes(option))
        {
            throw config_error(name + ": disk_option " + JSON.stringify(option) + " is not one of " + DISK_OPTIONS.join(", "));
        }
        policy.disk_option = option;
    }
    if(on_error !== undefined)
    {
        if(kind === "other")
        {
            throw config_error(name + ": disk_error is for disks and CD drives, not " + name);
        }
        if(!DISK_ERRORS.includes(on_error))
        {
            throw config_error(name + ": disk_error " + JSON.stringify(on_error) + " is not one of " + DISK_ERRORS.join(", "));
        }
        if(kind === "floppy" && on_error !== "report")
        {
            // (the floppy controller reports a failed transfer to the guest: src/floppy.js)
            throw config_error(name + ": floppy drives report a failed read or write to the guest (disk_error \"report\"); " +
                "\"stop\" is for hard disks and CD drives");
        }
        policy.disk_error = on_error;
    }
    if(token !== undefined)
    {
        if(kind === "other")
        {
            throw config_error(name + ": token is for disks (a disk service's), not " + name);
        }
        if(typeof token !== "string")
        {
            throw config_error(name + ": token must be a string");
        }
    }
    if(kind === "floppy") policy.disk_error = "report";
    if(policy.disk_option === "read_write")
    {
        if(file.readonly)
        {
            throw config_error(name + ": disk_option \"read_write\" and readonly: the guest cannot write the disk, " +
                "there is nothing to write back");
        }
        if(file.format !== undefined && file.format !== "raw")
        {
            throw config_error(name + ": disk_option \"read_write\" is for RAW images; writing back into a " + file.format +
                " image is not supported (docs/disk-image-formats-plan.md P5)");
        }
        const problem = writeback_problem(name, file);
        if(problem) throw config_error(problem);
    }
    return policy;
}

/**
 * The source a descriptor reads, to find a source bound twice: its URL, or
 * its buffer object
 * @param {!Object} file
 * @return {*}
 */
function source_of(file)
{
    if(file.get && file.set && file.load) return file;
    if(file.buffer) return file.buffer;
    if(typeof file.url === "string")
    {
        try { return "url:" + new URL(file.url, globalThis.location ? globalThis.location.href : undefined).href; }
        catch(e) { return "url:" + file.url; }
    }
    return undefined;
}

/**
 * Check the disks of a machine's options (the V86 constructor): no
 * disk_option, disk_error or token in the V86 options themselves, each
 * disk's policy, and no image bound to two disks with one of them
 * read_write
 * @param {!Object} options the V86 options
 * @param {!Array<!Array<*>>=} also [name, descriptor] of disks attached already (attach_sata_drive)
 * @return {!Array<!Array<*>>} [name, descriptor, policy] of each disk
 */
export function check_disk_options(options, also)
{
    // (the options by property, as the rest of v86 reads them: Closure
    // renames them alike in v86_all.js)
    for(const [key, value] of [["disk_option", options.disk_option], ["disk_error", options.disk_error], ["token", options.token]])
    {
        if(value !== undefined)
        {
            throw config_error(key + " is an option of each disk (hda: { url, " + key + " }), not of the machine");
        }
    }
    const disks = [["hda", options.hda], ["hdb", options.hdb], ["cdrom", options.cdrom], ["fda", options.fda], ["fdb", options.fdb]]
        .filter(([, file]) => file);
    (options.virtio_disks || []).forEach((disk, i) => { if(disk) disks.push(["virtio_disk" + i, disk]); });
    for(const [name, file] of [["bios", options.bios], ["vga_bios", options.vga_bios], ["initial_state", options.initial_state],
        ["multiboot", options.multiboot], ["bzimage", options.bzimage], ["initrd", options.initrd], ["kernel", options.kernel], ["dtb", options.dtb]])
    {
        check_disk_policy(name, file);
    }
    return check_disk_bindings(disks.map(([name, file]) => [name, file, check_disk_policy(name, file)]), also);
}

/**
 * No image bound to two disks of a machine with one of them read_write
 * @param {!Array<!Array<*>>} disks [name, descriptor, policy]
 * @param {!Array<!Array<*>>=} also [name, descriptor] of disks attached already
 * @return {!Array<!Array<*>>} disks
 */
export function check_disk_bindings(disks, also)
{
    const all = (also || []).map(([name, file]) => [name, file, check_disk_policy(name, file)]).concat(disks);
    const seen = new Map();
    for(const [name, file, policy] of all)
    {
        const source = source_of(/** @type {!Object} */ (file));
        if(source === undefined) continue;
        const other = seen.get(source);
        if(other && (other.policy.disk_option === "read_write" || policy.disk_option === "read_write"))
        {
            throw config_error(other.name + " and " + name + " are the same image, and one of them has disk_option " +
                "\"read_write\": an image written back has one disk");
        }
        if(!other) seen.set(source, { name, policy });
    }
    return disks;
}

/**
 * Put a disk's policy on its buffer (src/block_backend.js reads it there)
 * @param {?} buffer
 * @param {string} name
 * @param {{disk_option: string, disk_error: string}} policy
 */
export function set_disk_policy(buffer, name, policy)
{
    if(!buffer || typeof buffer !== "object") return;
    buffer.disk_name = name;
    buffer.disk_error = policy.disk_error;
    // (a write-back backend: the device reports a write cache, src/ide.js)
    if(policy.disk_option === "read_write") buffer.writeback = true;
}
