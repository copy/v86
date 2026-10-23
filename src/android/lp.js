// The super partition (system/core/fs_mgr/liblp/include/liblp/
// metadata_format.h): its geometry and metadata, little-endian, and its
// logical partitions replaced with their hash trees and vbmeta descriptors
// (docs/android-images-plan.md I1)

import { u32, u64, u64be, put32, put64, put32be, put64be, c_string, latin1, bytes_of, copy, concat, equals, hex, sha256 } from "./bytes.js";
import { vbmeta_struct, hashtree_descriptor, avb_hashtree, set_hashtree } from "./avb.js";

const LP_RESERVED_BYTES = 4096, LP_GEOMETRY_SIZE = 4096;
const LP_GEOMETRY_MAGIC = 0x616C4467, LP_HEADER_MAGIC = 0x414C5030;
const SECTOR = 512;
/** the tables' entry sizes (LpMetadataPartition, LpMetadataExtent,
 * LpMetadataPartitionGroup, LpMetadataBlockDevice) and where the header
 * describes each table */
const PARTITION_SIZE = 52, EXTENT_SIZE = 24, GROUP_SIZE = 48, DEVICE_SIZE = 64;
const TABLES = [80, 92, 104, 116];

/**
 * A metadata copy's partitions with their extents (at: where each extent is
 * in bytes)
 * @param {!Uint8Array} bytes
 * @return {!Array<{name: string, extents: !Array<{at: number, sectors: number, type: number, sector: number}>}>}
 */
function copy_partitions(bytes)
{
    const header_size = u32(bytes, 8);
    const table = at => ({ offset: header_size + u32(bytes, at), count: u32(bytes, at + 4), size: u32(bytes, at + 8) });
    const partitions = [], extents = table(92);
    const t = table(80);
    for(let p = 0; p < t.count; p++)
    {
        const at = t.offset + p * t.size;
        const first = u32(bytes, at + 40), count = u32(bytes, at + 44);
        partitions.push({ name: c_string(bytes, at, 36), extents: Array.from({ length: count }, (_, e) =>
        {
            const x = extents.offset + (first + e) * extents.size;
            return { at: x, sectors: u64(bytes, x), type: u32(bytes, x + 8), sector: u64(bytes, x + 12) };
        }) });
    }
    return partitions;
}

/**
 * Every copy of super's metadata (each slot's primary and backup), read
 * through read(offset, length); max: the room of each copy
 * @param {function(number, number): !Uint8Array} read
 * @return {{copies: !Array<{offset: number, bytes: !Uint8Array, partitions: !Array<{name: string, extents: !Array<{at: number, sectors: number, type: number, sector: number}>}>}>, alignment: number, size: number, max: number, slots: number}}
 */
export function lp_metadata(read)
{
    const geometry = read(LP_RESERVED_BYTES, 52);
    if(u32(geometry, 0) !== LP_GEOMETRY_MAGIC) throw new Error("super: no liblp geometry");
    const max = u32(geometry, 40), slots = u32(geometry, 44);
    const copies = [];
    for(let i = 0; i < 2 * slots; i++)
    {
        const offset = LP_RESERVED_BYTES + 2 * LP_GEOMETRY_SIZE + max * i;
        const head = read(offset, 48);
        if(u32(head, 0) !== LP_HEADER_MAGIC) throw new Error(`super: no metadata at ${offset}`);
        // (a copy of its own: changed in place)
        const bytes = new Uint8Array(read(offset, u32(head, 8) + u32(head, 44)));
        copies.push({ offset, bytes, partitions: copy_partitions(bytes) });
    }
    // (the block device: super itself)
    const bytes = copies[0].bytes, device = u32(bytes, 8) + u32(bytes, 116);
    return { copies, alignment: u32(bytes, device + 8), size: u64(bytes, device + 16), max, slots };
}

/**
 * A metadata copy as tables: partitions (their extents in them), groups
 * and block devices; header: the header's bytes (its other fields kept)
 * @param {!Uint8Array} bytes
 */
export function lp_parse(bytes)
{
    const header_size = u32(bytes, 8);
    const t = TABLES.map(at => ({ offset: header_size + u32(bytes, at), count: u32(bytes, at + 4), size: u32(bytes, at + 8) }));
    [PARTITION_SIZE, EXTENT_SIZE, GROUP_SIZE, DEVICE_SIZE].forEach((size, i) =>
    {
        if(t[i].size !== size) throw new Error(`super: table ${i}'s entries are ${t[i].size} bytes`);
    });
    const entries = (i, f) => Array.from({ length: t[i].count }, (_, k) => f(bytes.subarray(t[i].offset + k * t[i].size, t[i].offset + (k + 1) * t[i].size)));
    const extents = entries(1, e => ({ sectors: u64(e, 0), type: u32(e, 8), target: u64(e, 12), source: u32(e, 20) }));
    return {
        header: copy(bytes, 0, header_size),
        partitions: entries(0, e => ({ name: c_string(e, 0, 36), attributes: u32(e, 36), group: u32(e, 48),
            extents: extents.slice(u32(e, 40), u32(e, 40) + u32(e, 44)) })),
        groups: entries(2, e => ({ name: c_string(e, 0, 36), flags: u32(e, 36), maximum_size: u64(e, 40) })),
        block_devices: entries(3, e => ({ first_logical_sector: u64(e, 0), alignment: u32(e, 8), alignment_offset: u32(e, 12),
            size: u64(e, 16), name: c_string(e, 24, 36), flags: u32(e, 60) })),
    };
}

/**
 * lp_parse's tables as a metadata copy (extents in partition order), its
 * checksums new
 * @param {!Object} model
 * @return {!Uint8Array}
 */
export function lp_serialize(model)
{
    const name = (e, text) =>
    {
        if(text.length > 36) throw new Error("super: a name beyond 36 bytes: " + text);
        e.set(bytes_of(text), 0);
    };
    const extents = [], partitions = model.partitions.map(p =>
    {
        const e = new Uint8Array(PARTITION_SIZE);
        name(e, p.name);
        put32(e, 36, p.attributes);
        put32(e, 40, extents.length);
        put32(e, 44, p.extents.length);
        put32(e, 48, p.group);
        for(const x of p.extents)
        {
            const b = new Uint8Array(EXTENT_SIZE);
            put64(b, 0, x.sectors);
            put32(b, 8, x.type);
            put64(b, 12, x.target);
            put32(b, 20, x.source);
            extents.push(b);
        }
        return e;
    });
    const groups = model.groups.map(g =>
    {
        const e = new Uint8Array(GROUP_SIZE);
        name(e, g.name);
        put32(e, 36, g.flags);
        put64(e, 40, g.maximum_size);
        return e;
    });
    const devices = model.block_devices.map(d =>
    {
        const e = new Uint8Array(DEVICE_SIZE);
        put64(e, 0, d.first_logical_sector);
        put32(e, 8, d.alignment);
        put32(e, 12, d.alignment_offset);
        put64(e, 16, d.size);
        e.subarray(24).set(bytes_of(d.name).subarray(0, 36));
        put32(e, 60, d.flags);
        return e;
    });
    const header = new Uint8Array(model.header);
    let offset = 0;
    [[partitions, PARTITION_SIZE], [extents, EXTENT_SIZE], [groups, GROUP_SIZE], [devices, DEVICE_SIZE]].forEach(([list, size], i) =>
    {
        put32(header, TABLES[i], offset);
        put32(header, TABLES[i] + 4, list.length);
        put32(header, TABLES[i] + 8, size);
        offset += list.length * size;
    });
    put32(header, 44, offset);
    const bytes = concat([header, ...partitions, ...extents, ...groups, ...devices]);
    lp_checksum(bytes);
    return bytes;
}

/**
 * Every metadata copy of lp changed by change(model, index) (lp_parse's,
 * changed in place) and written again, lp's copies replaced; returns the
 * writes into super
 * @param {!Object} lp
 * @param {function(!Object, number)} change
 * @return {!Array<{offset: number, bytes: !Uint8Array}>}
 */
export function lp_rewrite(lp, change)
{
    return lp.copies.map((copy, i) =>
    {
        const model = lp_parse(copy.bytes);
        change(model, i);
        const bytes = lp_serialize(model);
        if(bytes.length > lp.max) throw new Error(`super: metadata of ${bytes.length} bytes, room for ${lp.max}`);
        copy.bytes = bytes;
        copy.partitions = copy_partitions(bytes);
        if(i === 0)
        {
            const device = model.block_devices[0];
            lp.alignment = device.alignment;
            lp.size = device.size;
        }
        return { offset: copy.offset, bytes };
    });
}

/**
 * Super shrunk (or grown) to size (aligned up, past every extent): its
 * block device's size in every copy
 * @param {!Object} lp
 * @param {number} size bytes
 * @return {!Array<{offset: number, bytes: !Uint8Array}>}
 */
export function lp_resize(lp, size)
{
    const aligned = Math.ceil(size / lp.alignment) * lp.alignment;
    if(aligned < lp_end(lp) * SECTOR) throw new Error(`super: ${aligned} bytes leave out its partitions (up to ${lp_end(lp) * SECTOR})`);
    return lp_rewrite(lp, model => { model.block_devices[0].size = aligned; });
}

/**
 * Super's logical partition name gone from every copy (its extents with it)
 * @param {!Object} lp
 * @param {string} name
 * @return {!Array<{offset: number, bytes: !Uint8Array}>}
 */
export function lp_remove(lp, name)
{
    return lp_rewrite(lp, model =>
    {
        const i = model.partitions.findIndex(p => p.name === name);
        if(i < 0) throw new Error(`super: no ${name}`);
        model.partitions.splice(i, 1);
    });
}

/**
 * Super's logical partition name given one linear extent of sectors at
 * sector (on super itself) in every copy
 * @param {!Object} lp
 * @param {string} name
 * @param {number} sector
 * @param {number} sectors
 * @return {!Array<{offset: number, bytes: !Uint8Array}>}
 */
export function lp_place(lp, name, sector, sectors)
{
    if(sector % (lp.alignment / SECTOR)) throw new Error(`super: ${name} at an unaligned sector ${sector}`);
    if((sector + sectors) * SECTOR > lp.size) throw new Error(`super: no room for ${name}`);
    return lp_rewrite(lp, model =>
    {
        const p = model.partitions.find(p => p.name === name);
        if(!p) throw new Error(`super: no ${name}`);
        p.extents = [{ sectors, type: 0, target: sector, source: 0 }];
    });
}

/**
 * A metadata copy's checksums (sha256 of the tables, then of the header
 * with its own checksum zero), set in place
 * @param {!Uint8Array} bytes
 */
export function lp_checksum(bytes)
{
    const header_size = u32(bytes, 8);
    bytes.set(sha256(bytes.subarray(header_size)), 48);
    bytes.fill(0, 12, 44);
    bytes.set(sha256(bytes.subarray(0, header_size)), 12);
}

/**
 * The first sector after every extent of super's partitions
 * @param {!Object} lp lp_metadata's
 * @return {number}
 */
export function lp_end(lp)
{
    return Math.max(...lp.copies.flatMap(c => c.partitions.flatMap(p => p.extents.map(e => e.sector + e.sectors))));
}

/**
 * Super's partition name (slot a) replaced by image: its hash tree (as
 * the descriptor's: sha256 over 4 KiB blocks, its salt; no FEC), vbmeta
 * (the image holding name's hashtree descriptor) with the descriptor's sizes
 * and root digest, and the partition's one linear extent moved to free
 * space, space.sector onwards, in every metadata copy of lp (lp_metadata's,
 * changed in place). With `footer` (the partition's own vbmeta struct, as
 * the old one's AVB footer held it) the partition gets a footer again: that
 * struct with the same descriptor changes after the tree, the footer in the
 * extent's last 64 bytes (fs_mgr reads the "offline" vbmeta there). Returns
 * the new vbmeta, the bytes to write into super and a record
 * @param {!Object} lp
 * @param {!Uint8Array} vbmeta
 * @param {string} name
 * @param {!Uint8Array} image
 * @param {{sector: number}} space
 * @param {Uint8Array=} footer
 */
export function super_replace(lp, vbmeta, name, image, space, footer = null)
{
    const descriptor = hashtree_descriptor(vbmeta, name);
    if(descriptor.algorithm !== "sha256" || descriptor.data_block !== 4096 || descriptor.hash_block !== 4096) throw new Error(`vbmeta: ${name}'s hash tree is not sha256 over 4 KiB blocks`);
    const { root, tree } = avb_hashtree(image, descriptor.salt);
    const new_vbmeta = new Uint8Array(vbmeta);
    set_hashtree(new_vbmeta, descriptor, image.length, tree.length, root);
    let struct = null;
    if(footer)
    {
        // (the same changes in the partition's own struct: unsigned, avbtool's add_hashtree_footer)
        struct = new Uint8Array(footer);
        const own = hashtree_descriptor(struct, name);
        if(!equals(own.salt, descriptor.salt)) throw new Error(`vbmeta: ${name}'s footer has another salt`);
        set_hashtree(struct, own, image.length, tree.length, root);
    }
    const page = n => Math.ceil(n / 4096) * 4096;
    const vbmeta_offset = page(image.length + tree.length);
    const used = struct ? vbmeta_offset + page(struct.length) + 4096 : image.length + tree.length;
    const align = lp.alignment / SECTOR;
    const sector = Math.ceil(space.sector / align) * align, sectors = Math.ceil(used / lp.alignment) * align;
    if((sector + sectors) * SECTOR > lp.size) throw new Error(`super: no room for ${name}_a`);
    const old = lp.copies[0].partitions.find(p => p.name === name + "_a")?.extents;
    if(!old || old.length !== 1 || old[0].type !== 0) throw new Error(`super: ${name}_a is not one linear extent`);
    for(const copy of lp.copies)
    {
        const p = copy.partitions.find(p => p.name === name + "_a");
        if(!p || p.extents.length !== 1 || p.extents[0].sector !== old[0].sector) throw new Error(`super: the metadata copies differ in ${name}_a`);
        put64(copy.bytes, p.extents[0].at, sectors);
        put64(copy.bytes, p.extents[0].at + 12, sector);
        lp_checksum(copy.bytes);
    }
    space.sector = sector + sectors;
    let bytes = concat([image, tree]);
    if(struct)
    {
        // AvbFooter: magic, version 1.0, original_image_size, vbmeta_offset, vbmeta_size, reserved[28]
        bytes = new Uint8Array(sectors * SECTOR);
        bytes.set(image, 0);
        bytes.set(tree, image.length);
        bytes.set(struct, vbmeta_offset);
        const f = bytes.length - 64;
        bytes.set(bytes_of("AVBf"), f);
        put32be(bytes, f + 4, 1);
        put32be(bytes, f + 8, 0);
        put64be(bytes, f + 12, image.length);
        put64be(bytes, f + 20, vbmeta_offset);
        put64be(bytes, f + 28, struct.length);
    }
    return { vbmeta: new_vbmeta, data: { offset: sector * SECTOR, bytes },
        record: { sector, sectors, image_blocks: image.length / 4096, root_digest: hex(root), footer: !!struct } };
}

/**
 * The vbmeta struct of super's partition name (slot a) as its AVB footer
 * holds it, or null
 * @param {function(number, number): !Uint8Array} super_read
 * @param {!Object} lp
 * @param {string} name
 * @return {Uint8Array}
 */
export function super_footer_struct(super_read, lp, name)
{
    const p = lp.copies[0].partitions.find(p => p.name === name + "_a");
    if(!p || p.extents.length !== 1) return null;
    const end = (p.extents[0].sector + p.extents[0].sectors) * SECTOR;
    const footer = super_read(end - 64, 64);
    if(latin1(footer, 0, 4) !== "AVBf") return null;
    const offset = u64be(footer, 20), size = u64be(footer, 28);
    return vbmeta_struct(super_read(p.extents[0].sector * SECTOR + offset, size)).struct;
}

/**
 * Super's partition name (slot a) as its hashtree descriptor in vbmeta sizes it
 * @param {function(number, number): !Uint8Array} super_read
 * @param {!Object} lp
 * @param {!Uint8Array} vbmeta
 * @param {string} name
 * @return {!Uint8Array}
 */
export function super_partition(super_read, lp, vbmeta, name)
{
    const p = lp.copies[0].partitions.find(p => p.name === name + "_a");
    if(!p || p.extents.length !== 1 || p.extents[0].type !== 0) throw new Error(`super: ${name}_a is not one linear extent`);
    return super_read(p.extents[0].sector * SECTOR, hashtree_descriptor(vbmeta, name).image_size);
}
