// Hard disk images by their descriptor (docs/disk-image-formats-plan.md P0):
// the options a disk's descriptor may have, the format from its signature
// and structure ("auto"), the source of its bytes and the format's reader.
// Without a format (or with "raw") a disk keeps the buffers of src/buffer.js.

import { DiskImageError, MemorySource, BlobSource, URLSource, PartsSource, CachedSource } from "./source.js";
import { DiskImage, ImageReader, EXTENT_DATA } from "./disk_image.js";
import { QCOW2Reader, QCOW2_MAGIC } from "./qcow2.js";
import { VHDReader } from "./vhd.js";
import { VDIReader } from "./vdi.js";
import { VMDKReader } from "./vmdk.js";
import { VHDXReader } from "./vhdx.js";
import { SliceSource, read_tar, read_ova } from "./ova.js";
import { load_file } from "../lib.js";

/** the formats a hard disk's `format` may name */
export const DISK_IMAGE_FORMATS = ["raw", "qcow2", "vhd", "vpc", "vdi", "vmdk", "vhdx", "auto"];

/** formats recognised but not (yet) read, and where they are planned */
const FORMATS_LATER = {};

/** what disk_option may be (docs/disk-persistence-plan.md) */
const DISK_OPTIONS = ["read_only", "read_write"];

/** the descriptors that are not disks */
const NOT_DISKS = ["bios", "vga_bios", "initial_state", "multiboot", "bzimage", "initrd", "kernel", "dtb", "cdrom"];

// how many parents a disk may have
export const MAX_CHAIN_DEPTH = 16;

/**
 * Check the image options of a descriptor: `format` and `disk_option`
 * @param {string} name hda, hdb, cdrom, ...
 * @param {*} file
 * @param {boolean} hard_disk whether the descriptor is a hard disk's
 * @return {string|undefined} the format, undefined for RAW in a buffer of src/buffer.js
 */
export function check_image_options(name, file, hard_disk)
{
    if(!file || typeof file !== "object") return undefined;
    const format = file.format;
    const option = file.disk_option;
    if(option !== undefined)
    {
        if(NOT_DISKS.includes(name))
        {
            throw new DiskImageError(name + ": disk_option is for disks (hda, hdb, SATA drives), not " + name, "config");
        }
        if(!DISK_OPTIONS.includes(option))
        {
            throw new DiskImageError(name + ": disk_option " + JSON.stringify(option) + " is not one of " + DISK_OPTIONS.join(", "), "config");
        }
        if(option === "read_write")
        {
            throw new DiskImageError(name + ": disk_option \"read_write\" (writing the changes back to the image) is not " +
                "supported yet (docs/disk-persistence-plan.md); without it, the changes stay in memory", "config");
        }
    }
    if(format === undefined || format === "raw") return undefined;
    if(typeof format !== "string")
    {
        throw new DiskImageError(name + ": format must be a string", "config");
    }
    if(!hard_disk)
    {
        throw new DiskImageError(name + ": format " + JSON.stringify(format) + " is for hard disks (hda, hdb, SATA drives); " +
            name + " is read as it is", "config");
    }
    if(FORMATS_LATER[format])
    {
        throw new DiskImageError(name + ": the format " + format + " is not supported yet (docs/disk-image-formats-plan.md " +
            FORMATS_LATER[format] + ")", "unsupported");
    }
    if(!DISK_IMAGE_FORMATS.includes(format))
    {
        throw new DiskImageError(name + ": unknown format " + JSON.stringify(format) + " (one of " + DISK_IMAGE_FORMATS.join(", ") + ")", "config");
    }
    if(file.get || file.set || file.load)
    {
        throw new DiskImageError(name + ": format is for descriptors (url, buffer), not for a disk object of one's own", "config");
    }
    if(!file.url && !(file.buffer instanceof ArrayBuffer) && !(typeof Blob !== "undefined" && file.buffer instanceof Blob))
    {
        throw new DiskImageError(name + ": a disk image needs a url or a buffer (ArrayBuffer, File)", "config");
    }
    if(file.files !== undefined && (typeof file.files !== "object" || !file.files ||
        Object.values(file.files).some(f => !f || typeof f !== "object")))
    {
        throw new DiskImageError(name + ": files must map file names to descriptors (url, buffer)", "config");
    }
    if(file.archive_member !== undefined && typeof file.archive_member !== "string")
    {
        throw new DiskImageError(name + ": archive_member must be the name of a file in the archive", "config");
    }
    return format;
}

/**
 * @param {!Uint8Array} bytes
 * @param {number} offset
 * @param {string} text
 * @return {boolean}
 */
function has_text(bytes, offset, text)
{
    if(offset < 0 || offset + text.length > bytes.length) return false;
    for(let i = 0; i < text.length; i++)
    {
        if(bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
}

/**
 * The format of an image from its first bytes and its last 512: a format
 * reader decides, or the name of one v86 does not read, or "" (RAW has no
 * signature)
 * @param {!Uint8Array} head
 * @param {!Uint8Array} tail
 * @return {string}
 */
export function detect_format(head, tail)
{
    const u32 = offset => (head[offset] << 24 | head[offset + 1] << 16 | head[offset + 2] << 8 | head[offset + 3]) >>> 0;
    if(head.length >= 8 && u32(0) === QCOW2_MAGIC)
    {
        const version = u32(4);
        return version === 1 ? "qcow" : "qcow2";
    }
    if(has_text(head, 0, "QED\0")) return "qed";
    if(has_text(head, 0, "vhdxfile")) return "vhdx";
    if(has_text(head, 0, "conectix") || has_text(tail, tail.length - 512, "conectix") ||
        has_text(tail, tail.length - 511, "conectix"))
    {
        return "vhd";
    }
    if(head.length >= 0x44 && (head[0x40] | head[0x41] << 8 | head[0x42] << 16 | head[0x43] << 24) >>> 0 === 0xBEDA107F)
    {
        return "vdi";
    }
    if(has_text(head, 0, "KDMV") || has_text(head, 0, "# Disk DescriptorFile")) return "vmdk";
    if(has_text(head, 0, "COWD")) return "vmdk-cowd";
    if(has_text(head, 0, "WithoutFreeSpace") || has_text(head, 0, "WithouFreSpacExt")) return "parallels";
    if(has_text(head, 0x8001, "CD001")) return "iso";
    return "";
}

/**
 * A raw image as a reader (a parent of another image)
 */
export class RawReader extends ImageReader
{
    constructor(source, name)
    {
        super(source, name);
        this.format = "raw";
    }

    /** @param {function((Error|undefined))} callback */
    open(callback)
    {
        this.virtual_size = this.source.byteLength;
        // (a RAW image has no metadata: it is identified by its size and,
        // like any image, an image_id)
        this.metadata_sha256 = "";
        callback(undefined);
    }

    map(offset, length, callback, signal)
    {
        callback([{ type: EXTENT_DATA, length, host_offset: offset }]);
    }
}

/**
 * A name for messages: the disk and its file
 * @param {string} name
 * @param {!Object} file
 * @return {string}
 */
function display_name(name, file)
{
    const path = file.url || file.buffer && file.buffer.name;
    return path ? name + " (" + String(path).replace(/^.*\//, "") + ")" : name;
}

/**
 * The source of an image file's bytes
 * @param {string} name
 * @param {!Object} file
 * @param {!Object} settings
 * @return {!Promise<?>}
 */
export async function open_source(name, file, settings)
{
    if(settings.open_source) return settings.open_source(name, file);
    let source;
    if(file.buffer instanceof ArrayBuffer)
    {
        source = new MemorySource(new Uint8Array(file.buffer), name);
    }
    else if(typeof Blob !== "undefined" && file.buffer instanceof Blob)
    {
        source = new BlobSource(file.buffer, name);
    }
    else if(file.url && !file.async)
    {
        // downloaded whole, as RAW disks with async: false
        const bytes = await new Promise((resolve, reject) =>
        {
            load_file(file.url, {
                done: result => resolve(new Uint8Array(result)),
                error: status => reject(new DiskImageError(name + ": loading " + file.url + " failed (" + status + ")", "io")),
                progress: settings.progress && (e => settings.progress(file.url, e)),
            });
        });
        let data = bytes;
        if(file.url.endsWith(".zst"))
        {
            if(!file.size || !settings.zstd_decompress)
            {
                throw new DiskImageError(name + ": a compressed (.zst) image needs its size", "config");
            }
            data = new Uint8Array(settings.zstd_decompress(file.size, bytes));
        }
        source = new MemorySource(data, name);
    }
    else if(file.url && file.use_parts)
    {
        source = new CachedSource(new PartsSource(file.url, file.size, file.fixed_chunk_size, false,
            settings.zstd_decompress_worker, name), file.fixed_chunk_size);
    }
    else if(file.url)
    {
        source = new CachedSource(new URLSource(file.url, file.size, name), file.fixed_chunk_size);
    }
    else
    {
        throw new DiskImageError(name + ": no url or buffer", "config");
    }
    await new Promise((resolve, reject) => source.open(error => error ? reject(error) : resolve()));
    if(file.archive_member)
    {
        // a file in a TAR archive (an OVA)
        const member = (await read_tar(source)).find(m => m.name === file.archive_member);
        if(!member) throw new DiskImageError(name + ": the archive has no file " + JSON.stringify(file.archive_member), "config");
        return new SliceSource(source, member.offset, member.size, name + " " + file.archive_member);
    }
    return source;
}

/**
 * The first and last bytes of a source, for detect_format
 * @param {?} source
 * @return {!Promise<!Array<!Uint8Array>>}
 */
function read_ends(source)
{
    const read = (offset, length) => new Promise((resolve, reject) =>
        source.read(offset, length, (data, error) => error ? reject(error) : resolve(data)));
    const size = source.byteLength;
    const head_length = Math.min(size, 0x10000);
    return Promise.all([read(0, head_length), size >= 512 ? read(size - 512, 512) : Promise.resolve(new Uint8Array(0))]);
}

/** the readers by format */
const READERS = {
    "qcow2": QCOW2Reader,
    "vhd": VHDReader,
    "vdi": VDIReader,
    "vmdk": VMDKReader,
    "vhdx": VHDXReader,
};

/**
 * The source of a file an image's descriptor names (VMDK extents): from the
 * descriptor's files (by the name, or the name without a directory), or,
 * for an image in an archive, the archive's file of that name
 * @param {string} label
 * @param {!Object} file the image's descriptor
 * @param {string} extent the name in the image's descriptor
 * @param {!Object} settings
 * @return {!Promise<?>}
 */
async function extent_source(label, file, extent, settings)
{
    const base = name => name.replace(/^.*[\\/]/, "");
    const files = file.files || {};
    const given = files[extent] || Object.keys(files).filter(name => base(name) === base(extent)).map(name => files[name])[0];
    if(given) return open_source(label + " " + base(extent), given, settings);
    if(file.archive_member)
    {
        const directory = file.archive_member.replace(/[^\/]*$/, "");
        return open_source(label + " " + base(extent), { url: file.url, buffer: file.buffer, async: file.async, size: file.size,
            archive_member: directory + extent }, settings);
    }
    throw new DiskImageError(label + ": the image is in several files, and " + JSON.stringify(extent) +
        " is not given: name it in files", "config");
}

/**
 * Whether a descriptor is one of `chain` (the same object, URL or buffer)
 * @param {!Object} file
 * @param {!Array<!Object>} chain
 * @return {boolean}
 */
function in_chain(file, chain)
{
    return chain.some(other => other === file || file.url && other.url === file.url ||
        file.buffer && other.buffer === file.buffer);
}

/**
 * The formats QEMU names in a QCOW2 image's backing format, as v86's
 * @param {string} name
 * @return {string}
 */
function format_name(name)
{
    return name === "vpc" ? "vhd" : name === "file" ? "raw" : name;
}

/**
 * Open an image file and its parents: a parent is given by the caller
 * (backing), never loaded by the name an image has for it; a missing parent
 * is an error, not zeros (docs/disk-image-formats-plan.md P2)
 * @param {string} name
 * @param {!Object} file
 * @param {!Object} settings
 * @param {number=} depth
 * @param {!Array<!Object>=} chain the descriptors of the children
 * @return {!Promise<!ImageReader>}
 */
export async function open_image(name, file, settings, depth = 0, chain = [])
{
    const label = display_name(name, file);
    if(depth > MAX_CHAIN_DEPTH)
    {
        throw new DiskImageError(label + ": more than " + MAX_CHAIN_DEPTH + " parent images", "config");
    }
    if(in_chain(file, chain))
    {
        throw new DiskImageError(label + ": the chain of parents is circular (an image is its own parent)", "config");
    }
    const source = await open_source(label, file, settings);
    const [head, tail] = await read_ends(source);
    const detected = detect_format(head, tail);
    // ("vpc": QEMU's name of VHD)
    let format = format_name(file.format || "auto");
    if(format === "auto")
    {
        if(!detected)
        {
            throw new DiskImageError(label + ": the format could not be determined (RAW has no signature): give the " +
                "format (\"raw\" for a RAW image)", "config");
        }
        format = detected;
    }
    else if(format !== "raw" && detected !== format)
    {
        throw new DiskImageError(label + ": not a " + format + " image" + (detected ? " (it looks like " + detected + ")" : ""), "config");
    }
    if(format === "iso")
    {
        throw new DiskImageError(label + ": an ISO 9660 image, for a CD drive (cdrom), not a hard disk", "config");
    }
    const Reader = format === "raw" ? RawReader : READERS[format];
    if(!Reader)
    {
        throw new DiskImageError(label + ": the format " + format + " is not supported" +
            (FORMATS_LATER[format] ? " yet (docs/disk-image-formats-plan.md " + FORMATS_LATER[format] + ")" : ""), "unsupported");
    }
    const reader = new Reader(source, label, Object.assign({}, settings,
        { open_extent_source: extent => extent_source(label, file, extent, settings) }));
    await new Promise((resolve, reject) => reader.open(error => error ? reject(error) : resolve()));
    reader.image_id = file.image_id || "";

    const link = reader.parent_link;
    const backing = file.backing;
    if(link && !backing)
    {
        throw new DiskImageError(label + ": the image's data continues in a parent image (" + JSON.stringify(link) +
            "): give it as backing (a missing parent is not read as zeros)", "config");
    }
    if(!link && backing)
    {
        throw new DiskImageError(label + ": backing is given, but the image has no parent", "config");
    }
    if(link)
    {
        if(typeof backing !== "object") throw new DiskImageError(label + ": backing must be a descriptor (url, buffer)", "config");
        // the parent's format: the one given, or the one the image names
        const named = format_name(link["backing_format"] || "");
        const given = backing.format && backing.format !== "auto" ? backing.format : "";
        if(named && given && named !== given)
        {
            throw new DiskImageError(label + ": the image names its parent's format " + named + ", backing is given as " + given, "config");
        }
        const parent_file = Object.assign({}, backing, { format: given || named || "auto" });
        const parent = await open_image(name + " parent", parent_file, settings, depth + 1, chain.concat([file]));
        reader.check_parent(parent);
        reader.parent = parent;
    }
    return reader;
}

/**
 * An OVF package (an OVA archive): its disks as descriptors (the archive's,
 * with archive_member), the hardware as v86 options, notes for what v86
 * does not have (docs/disk-image-formats-plan.md P4)
 * @param {!Object} file the archive's descriptor (url, buffer)
 * @param {!Object} settings
 * @return {!Promise<!Object>}
 */
export async function import_ova(file, settings)
{
    const label = display_name("ova", file);
    const source = await open_source(label, Object.assign({}, file, { archive_member: undefined }), settings);
    const ova = await read_ova(source);
    const archive = { url: file.url, buffer: file.buffer, async: file.async === undefined ? true : file.async, size: file.size };
    const disks = ova.disks.map(disk => Object.assign({}, disk, {
        descriptor: disk.member && !disk.missing ? Object.assign({}, archive, { archive_member: disk.member, format: disk.format }) : null,
    }));
    const options = Object.assign({}, ova.options);
    const usable = disks.filter(d => d.descriptor);
    if(options["machine_type"] === "q35" || usable.length > 2)
    {
        options["machine_type"] = "q35";
    }
    if(usable[0]) options["hda"] = usable[0].descriptor;
    if(usable[1]) options["hdb"] = usable[1].descriptor;
    if(usable.length > 2)
    {
        ova.notes.push("disks after the second: attach them with attach_sata_drive (ports 3-5) after the start");
    }
    return { "ovf": ova.ovf, "files": ova.members.map(m => m.name), "disks": disks, "options": options, "notes": ova.notes };
}

/**
 * A hard disk from a descriptor with a format (check_image_options)
 * @param {string} name hda, hdb, sata<port>
 * @param {!Object} file
 * @param {!Object} settings zstd_decompress (synchronous), zstd_decompress_worker, progress
 * @return {!DiskImage}
 */
export function create_disk_image(name, file, settings)
{
    return new DiskImage(name, () => open_image(name, file, settings), {
        overlay_limit: file.overlay_limit,
    });
}
