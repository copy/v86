// Local preparation of the single supported 10B329 restore image.
import { check_payload, extract_system_partition, ipsw_check, ipsw_image, ipsw_open, ipsw_sha1, keys_parse } from "./ipsw.js";
import { complzss_decompress } from "./lzss.js";
import { prepare_system_volume } from "./system_volume.js";
import { check_guest_library, graphics_kernel, has_offline_lockdown, LOCKDOWN_DAEMON } from "./guest_load.js";
import { offline_setup_file, systembag } from "./provision.js";
import { write_hfsx_data } from "./hfsx_data.js";
import { HFSPlus } from "./hfsplus.js";
import { write_bootstrap_pages } from "./nand_layout.js";
import { data_capacity, write_volumes } from "./nand_volumes.js";
import { write_nand_boot } from "./nand_boot.js";
import { NAND_BYTES, NAND_SLOT, nand_offset } from "../apple/nand_geometry.js";
import { N90_RESTORE } from "./catalog.js";

export async function inspect_n90_ipsw(read, size, progress = () => {})
{
    const model = N90_RESTORE;
    if(size !== model.size) throw new Error("Choose the original " + model.file + " (" + model.size + " bytes)");
    const ipsw = await ipsw_open(read, size);
    if(ipsw.build !== model.build || ipsw.version !== model.version || !ipsw.product_types.includes(model.model) ||
        !ipsw.boards.includes(model.board)) throw new Error("The IPSW is not for iPhone 4 (GSM), iOS 6.1.3 (10B329)");
    if(await ipsw_sha1(read, size, done => progress("Checking IPSW", done, size)) !== model.sha1)
        throw new Error("The IPSW's SHA-1 does not match the supported firmware");
    return ipsw;
}

function n90_keys(ipsw, source)
{
    const keys = keys_parse(source), model = N90_RESTORE;
    if(keys.device !== model.model || keys.build !== model.build) throw new Error("The keys must be for iPhone3,1 build 10B329");
    for(const [name, path] of [["Kernelcache", ipsw.kernelcache], ["DeviceTree", ipsw.devicetree],
        ["RestoreRamdisk", ipsw.restore_ramdisk], ["RootFileSystem", ipsw.system_image]])
    {
        const entry = keys.images[name] && ipsw.member(keys.images[name].file);
        if(!entry || path && entry.name !== path) throw new Error(name + ": missing key or wrong IPSW member");
    }
    return keys;
}

export async function verify_n90_keys(ipsw, source, report, progress = () => {})
{
    const keys = n90_keys(ipsw, source);
    return ipsw_check(ipsw, keys, report, (name, done) => {
        const entry = ipsw.member(keys.images[name].file);
        progress("Checking " + name, done, entry.compressed_size);
    });
}

// The system scratch store is a seekable zero-filled file. The data volume
// touches only a few blocks; its sparse scratch store can live in memory.
function sparse_data()
{
    const blocks = new Map(), unit = 4096;
    function visit(at, bytes, f)
    {
        for(let i = 0; i < bytes.length;)
        {
            const n = Math.floor((at + i) / unit), offset = (at + i) % unit;
            const size = Math.min(bytes.length - i, unit - offset);
            f(n, offset, bytes.subarray(i, i + size));
            i += size;
        }
    }
    return {
        write(at, bytes) {
            visit(at, bytes, (n, off, part) => {
                if(!blocks.has(n)) blocks.set(n, new Uint8Array(unit));
                blocks.get(n).set(part, off);
            });
        },
        read(at, size) {
            const bytes = new Uint8Array(size);
            visit(at, bytes, (n, off, part) => {
                const block = blocks.get(n);
                if(block) part.set(block.subarray(off, off + part.length));
            });
            return bytes;
        },
    };
}

export async function assemble_n90(ipsw, keySource, scratch, nand, library, progress = () => {})
{
    const keys = n90_keys(ipsw, keySource);
    if(library) check_guest_library(library);
    async function payload(name)
    {
        const image = keys.images[name], result = await ipsw_image(ipsw, image);
        check_payload(result.type, result.data);
        return result.data;
    }
    progress("Decrypting boot files", 0, 1);
    let kernel = complzss_decompress(await payload("Kernelcache"));
    const tree = await payload("DeviceTree");
    await payload("RestoreRamdisk"); // check the supplied key, not used for a normal boot
    const logo = keys.images.AppleLogo ? await payload("AppleLogo") : undefined;
    const root = keys.images.RootFileSystem, entry = ipsw.member(root.file);
    const system = await extract_system_partition(ipsw, root, scratch.write, (stage, done) =>
        progress(stage === "check" ? "Checking root filesystem" : "Extracting system volume", done, entry.compressed_size));
    scratch.resize(system.size);
    progress("Preparing system and data volumes", 0, 1);
    const { volume, daemons, lockdown } = await prepare_system_volume(scratch.read, scratch.write, !!library, undefined, true, library);
    kernel = graphics_kernel(kernel, daemons, library, lockdown);
    await write_prepared_n90(scratch.read, nand, { kernel, tree, logo, library }, progress, volume);
}

export async function write_prepared_n90(read, nand, boot, progress, volume = null)
{
    volume ||= await new HFSPlus(read).open();
    const { kernel, tree, logo, library } = boot;
    const files = [{ path: "/keybags/systembag.kb", bytes: systembag(), dir_mode: 0o700, mode: 0o600 }];
    if(library) files.push({ path: "/v86/libv86gles.dylib", bytes: library, dir_mode: 0o755, mode: 0o755 });
    const lockdownd = await volume.lookup(LOCKDOWN_DAEMON);
    if(lockdownd && has_offline_lockdown(await volume.contents(lockdownd))) files.push(offline_setup_file());
    const data = sparse_data();
    await write_hfsx_data(volume, data_capacity(volume.block_size * volume.total_blocks), data.write, files);
    nand.resize(NAND_BYTES);
    const slot = new Uint8Array(NAND_SLOT);
    function put(bus, ce, row, raw)
    {
        for(let i = 0; i < raw.length; i++) slot[i] = ~raw[i];
        nand.write(nand_offset(bus, ce, row), slot);
    }
    write_bootstrap_pages(put);
    write_nand_boot(put, kernel, tree, logo || undefined, library || undefined);
    await write_volumes(put, read, data.read, (done, total) => progress("Writing NAND image", done, total), true);
}
