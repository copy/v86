// A FAT16 disk image with directories, in memory: one MBR partition of type
// 0xEF (an EFI System Partition), 2 KiB clusters, 8.3 names (upper case):
// what a UEFI boot manager reads \EFI\BOOT\BOOTX64.EFI from. For tests that
// should not depend on a host's tools (tests/uefi/secure_boot.mjs).

const SECTOR = 512;
const PARTITION = 2048;
const CLUSTER_SECTORS = 4;
const CLUSTER = CLUSTER_SECTORS * SECTOR;
const ROOT_ENTRIES = 512;

/**
 * @param {!Object<string, !Uint8Array>} files by path ("EFI/BOOT/BOOTX64.EFI")
 * @param {number=} size_mb the disk's size (at least 16)
 * @return {!Uint8Array}
 */
export function make_esp(files, size_mb = 64)
{
    const disk = new Uint8Array(size_mb << 20), view = new DataView(disk.buffer);
    const sectors = disk.length / SECTOR - PARTITION;
    const clusters = Math.floor(sectors / CLUSTER_SECTORS);
    const fat_sectors = Math.ceil((clusters + 2) * 2 / SECTOR);
    const boot = PARTITION * SECTOR, fat = boot + SECTOR, root = fat + 2 * fat_sectors * SECTOR;
    const data = root + ROOT_ENTRIES * 32;
    const total_clusters = Math.floor((disk.length - data) / CLUSTER);
    if(total_clusters < 4085 || total_clusters > 65524) throw new Error("not a FAT16 size: " + size_mb + " MiB");

    // the MBR: one partition, type 0xEF
    disk[446] = 0x00;
    disk.set([0xFE, 0xFF, 0xFF], 447);
    disk[450] = 0xEF;
    disk.set([0xFE, 0xFF, 0xFF], 451);
    view.setUint32(454, PARTITION, true);
    view.setUint32(458, sectors, true);
    view.setUint16(510, 0xAA55, true);
    // the boot sector's BIOS parameter block
    disk.set([0xEB, 0x3C, 0x90], boot);
    disk.set(Buffer.from("V86 ESP "), boot + 3);
    view.setUint16(boot + 11, SECTOR, true);
    disk[boot + 13] = CLUSTER_SECTORS;
    view.setUint16(boot + 14, 1, true);
    disk[boot + 16] = 2;
    view.setUint16(boot + 17, ROOT_ENTRIES, true);
    view.setUint16(boot + 19, sectors < 0x10000 ? sectors : 0, true);
    disk[boot + 21] = 0xF8;
    view.setUint16(boot + 22, fat_sectors, true);
    view.setUint16(boot + 24, 63, true);
    view.setUint16(boot + 26, 255, true);
    view.setUint32(boot + 28, PARTITION, true);
    view.setUint32(boot + 32, sectors < 0x10000 ? 0 : sectors, true);
    disk[boot + 36] = 0x80;
    disk[boot + 38] = 0x29;
    view.setUint32(boot + 39, 0x86E5B007, true);
    disk.set(Buffer.from("V86 ESP    FAT16   "), boot + 43);
    view.setUint16(boot + 510, 0xAA55, true);

    const fat_entry = (cluster, value) => view.setUint16(fat + cluster * 2, value, true);
    fat_entry(0, 0xFFF8);
    fat_entry(1, 0xFFFF);
    let next = 2;
    /** Clusters for bytes (at least one), chained: the first */
    const allocate = bytes =>
    {
        const count = Math.max(1, Math.ceil(bytes.length / CLUSTER));
        if(next + count > total_clusters + 2) throw new Error("the files do not fit the disk");
        const first = next;
        for(let i = 0; i < count; i++) fat_entry(first + i, i + 1 === count ? 0xFFFF : first + i + 1);
        disk.set(bytes, data + (first - 2) * CLUSTER);
        next += count;
        return first;
    };
    const name83 = name =>
    {
        const [base, extension = ""] = name.toUpperCase().split(".");
        if(!base || base.length > 8 || extension.length > 3) throw new Error("not an 8.3 name: " + name);
        return Buffer.from(base.padEnd(8) + extension.padEnd(3), "ascii");
    };
    const entry = (name, attributes, cluster, size) =>
    {
        const e = new Uint8Array(32), v = new DataView(e.buffer);
        e.set(typeof name === "string" ? name83(name) : name, 0);
        e[11] = attributes;
        v.setUint16(22, 0, true);
        v.setUint16(24, (46 << 9) | (10 << 5) | 27, true);
        v.setUint16(26, cluster, true);
        v.setUint32(28, size, true);
        return e;
    };

    // the tree: directories and files
    const tree = new Map();
    for(const [path, bytes] of Object.entries(files))
    {
        const parts = path.split("/");
        let node = tree;
        for(const part of parts.slice(0, -1))
        {
            if(!node.has(part)) node.set(part, new Map());
            node = node.get(part);
        }
        node.set(parts[parts.length - 1], bytes);
    }
    /** A directory's entries, its subdirectories written first (cluster of the directory itself: parent's ".." needs it) */
    const write_directory = (node, self, parent) =>
    {
        const entries = [];
        if(self)
        {
            entries.push(entry(Buffer.from(".          "), 0x10, self, 0), entry(Buffer.from("..         "), 0x10, parent, 0));
        }
        for(const [name, child] of node)
        {
            if(child instanceof Map)
            {
                // (its cluster first, then its entries into it)
                const size = (child.size + 2) * 32;
                const cluster = allocate(new Uint8Array(size));
                const bytes = write_directory(child, cluster, self);
                disk.set(bytes, data + (cluster - 2) * CLUSTER);
                if(bytes.length > Math.max(1, Math.ceil(size / CLUSTER)) * CLUSTER) throw new Error("directory too large");
                entries.push(entry(name, 0x10, cluster, 0));
            }
            else
            {
                entries.push(entry(name, 0x20, child.length ? allocate(child) : 0, child.length));
            }
        }
        const bytes = new Uint8Array(entries.length * 32);
        entries.forEach((e, i) => bytes.set(e, i * 32));
        return bytes;
    };
    const root_bytes = write_directory(tree, 0, 0);
    if(root_bytes.length > ROOT_ENTRIES * 32) throw new Error("too many entries in the root directory");
    disk.set(root_bytes, root);
    disk.copyWithin(fat + fat_sectors * SECTOR, fat, fat + fat_sectors * SECTOR);
    return disk;
}
