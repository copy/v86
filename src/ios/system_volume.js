// Prepare the supplied 10B329 system volume in place. It is already a
// private copy. No files from the IPSW are needed by the emulator build.
import { HFSPlus } from "./hfsplus.js";
import { catalog_key, catalog_thread } from "./hfsx_data.js";
import { DISPLAY_DAEMONS, LOCKDOWN_DAEMON, SYSTEM_GL_APPLICATIONS, SYSTEM_GL_LIBRARY,
    check_guest_library, link_guest_gles, offline_lockdown } from "./guest_load.js";

const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const expect = (condition, message) => { if(!condition) throw new Error(message); };
const equals = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const text = new TextDecoder();
const encoder = new TextEncoder();
const STOCK_FSTAB = "/dev/disk0s1 / hfs ro 0 1\n/dev/disk0s2 /private/var hfs rw,nosuid,nodev 0 2\n";
const V86_FSTAB = "/dev/disk0s1s1 / hfs ro 0 1\n/dev/disk0s1s2 /private/var hfs rw,nosuid,nodev,protect 0 2\n";
const deflate = async bytes => new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());

async function write_fork(write, volume, id, fork, type, at, bytes)
{
    expect(at >= 0 && at + bytes.length <= fork.size, "HFS write outside the allocated fork");
    let extents = fork.extents;
    const covered = extents.reduce((n, e) => n + e.count, 0);
    if(at + bytes.length > covered * volume.block_size)
        extents = extents.concat(await volume.overflow_extents(id, type, covered));
    let pos = 0, done = 0;
    for(const extent of extents)
    {
        const span = extent.count * volume.block_size;
        const lo = Math.max(at, pos), hi = Math.min(at + bytes.length, pos + span);
        if(hi > lo)
        {
            await write(extent.start * volume.block_size + lo - pos, bytes.subarray(lo - at, hi - at));
            done += hi - lo;
        }
        pos += span;
    }
    expect(done === bytes.length, "Incomplete HFS fork");
}

async function fix_fstab(volume, write, compress)
{
    const file = await volume.lookup("/private/etc/fstab");
    expect(file && text.decode(await volume.contents(file)) === STOCK_FSTAB, "Expected the original 10B329 fstab");
    const attr = await volume.attribute(file.id, "com.apple.decmpfs"), tree = volume.attributes;
    expect(attr && view(attr).getUint32(4, true) === 3, "Expected inline compressed fstab");
    const contents = encoder.encode(V86_FSTAB), payload = await compress(contents), size = tree.node_size;
    const updated = new Uint8Array(16 + payload.length);
    updated.set(attr.subarray(0, 16));
    updated.set(payload, 16);
    view(updated).setBigUint64(8, BigInt(contents.length), true);
    for(const [n, leaf] of tree.cache)
    {
        if(leaf.kind !== -1) continue;
        const index = leaf.records.findIndex(({ key, data }) => view(key).getUint32(4) === file.id &&
            equals(data.subarray(16, 16 + attr.length), attr));
        if(index < 0) continue;
        const at = n * size, node = await volume.read_fork(tree.file_id, tree.fork, at, size), v = view(node);
        const count = leaf.records.length, slot = i => size - 2 * (i + 1);
        const start = v.getUint16(slot(index)), end = v.getUint16(slot(index + 1)), free = v.getUint16(slot(count));
        const data = start + 2 + ((v.getUint16(start) + 1) & ~1);
        const grow = data + 16 + ((updated.length + 1) & ~1) - end;
        expect(free + grow <= slot(count), "The fstab attribute leaf has no room");
        node.copyWithin(end + grow, end, free);
        for(let i = index + 1; i <= count; i++) v.setUint16(slot(i), v.getUint16(slot(i)) + grow);
        v.setUint32(data + 12, updated.length);
        node.set(updated, data + 16);
        if(updated.length & 1) node[data + 16 + updated.length] = 0;
        await write_fork(write, volume, tree.file_id, tree.fork, 0, at, node);
        tree.cache.delete(n);
        return;
    }
    throw new Error("Could not locate the fstab attribute leaf");
}

async function rewrite_daemon(volume, write, path, compress, patch)
{
    const file = await volume.lookup(path);
    expect(file?.compressed && file.resource.size, "Expected compressed daemon: " + path);
    const attr = await volume.attribute(file.id, "com.apple.decmpfs");
    expect(attr && view(attr).getUint32(4, true) === 4, "Expected a compressed resource fork: " + path);
    const original = await volume.contents(file), patched = patch(original);
    expect(original.length === patched.length, "A daemon patch changed its uncompressed size: " + path);
    const source = await volume.read_fork(file.id, file.resource, 0, file.resource.size, 255);
    const src = view(source), base = src.getUint32(0), table = base + 4;
    const capacity = src.getUint32(base), count = src.getUint32(table, true);
    expect(count === Math.ceil(patched.length / 65536) && table + capacity <= source.length, "Unexpected resource layout: " + path);
    const chunks = [];
    let used = 4 + count * 8;
    for(let i = 0; i < count; i++)
    {
        const at = i * 65536, block = patched.subarray(at, at + 65536), slot = table + 4 + 8 * i;
        let chunk;
        if(equals(block, original.subarray(at, at + 65536)))
        {
            const offset = src.getUint32(slot, true), length = src.getUint32(slot + 4, true);
            expect(offset + length <= capacity, "Invalid display daemon chunk: " + path);
            chunk = source.subarray(table + offset, table + offset + length);
        }
        else
        {
            chunk = await compress(block);
            if(chunk.length >= block.length)
            {
                chunk = new Uint8Array(1 + block.length);
                chunk[0] = 255;
                chunk.set(block, 1);
            }
        }
        chunks.push(chunk);
        used += chunk.length;
    }
    let resource = source.slice();
    if(used > capacity)
    {
        // A browser's zlib output can differ from the original. The HFS
        // fork has allocation-block padding after its single resource map.
        // Move that map into the padding and extend the logical fork length.
        const oldMap = src.getUint32(4), mapLength = src.getUint32(12), newMap = table + used;
        const size = newMap + mapLength;
        expect(oldMap === table + capacity && oldMap + mapLength === source.length &&
            src.getUint32(8) === 4 + capacity, "Unexpected compressed resource map: " + path);
        resource = new Uint8Array(size);
        resource.set(source.subarray(0, table + 4)); // resource header and little-endian block count
        resource.set(source.subarray(oldMap), newMap);
        const dst = view(resource);
        dst.setUint32(4, newMap);
        dst.setUint32(8, 4 + used);
        dst.setUint32(base, used);
        if(equals(source.subarray(oldMap, oldMap + 16), source.subarray(0, 16)))
            resource.set(resource.subarray(0, 16), newMap);
        const fork = size <= file.resource.blocks * volume.block_size ? { ...file.resource, size } :
            await extend_system_volume(volume, write, file.resource, size);
        await resize_resource(volume, write, file, fork);
    }
    const dst = view(resource);
    used = 4 + count * 8;
    for(const [i, chunk] of chunks.entries())
    {
        const slot = table + 4 + 8 * i;
        dst.setUint32(slot, used, true);
        dst.setUint32(slot + 4, chunk.length, true);
        resource.set(chunk, table + used);
        used += chunk.length;
    }
    await write_fork(write, volume, file.id, file.resource, 255, 0, resource);
    expect(equals(await volume.contents(file), patched), "Patched daemon verification failed: " + path);
    return patched;
}

async function extend_system_volume(volume, write, fork, size)
{
    // This restore's HFSX is packed with no free blocks. Grow the private
    // copy by one extent plus its new alternate volume header. Leave all
    // other forks in place and release any directly mapped old extents.
    const block = volume.block_size, start = volume.total_blocks;
    const count = Math.ceil(size / block), total = start + count + 1;
    const allocation = volume.forks[6];
    expect(total <= allocation.size * 8 && fork.extents.reduce((n, e) => n + e.count, 0) === fork.blocks,
        "Cannot extend the N90 system volume");
    const bitmap = await volume.read_fork(6, allocation, 0, allocation.size);
    // HFSX reserves the old last allocation block for its alternate
    // header, even on this restore where the header lives in partition padding.
    const oldTail = await volume.read((start - 1) * block, block);
    const oldAlt = view(oldTail.subarray(block - 1024, block - 512));
    expect(oldTail.length === block && oldTail.subarray(0, block - 1024).every(b => b === 0) &&
        oldTail.subarray(block - 512).every(b => b === 0) &&
        (oldTail.subarray(block - 1024, block - 512).every(b => b === 0) ||
            oldAlt.getUint16(0) === view(volume.header).getUint16(0) && oldAlt.getUint32(44) === start),
        "Unexpected final N90 system allocation block");
    const release = b => {
        const bit = 128 >>> (b & 7);
        expect(b < start && bitmap[b >>> 3] & bit, "Invalid old system allocation");
        bitmap[b >>> 3] &= ~bit;
    };
    release(start - 1);
    for(const e of fork.extents)
        for(let b = e.start; b < e.start + e.count; b++) release(b);
    for(let b = start; b < total; b++) bitmap[b >>> 3] |= 128 >>> (b & 7);
    await write_fork(write, volume, 6, allocation, 0, 0, bitmap);

    const header = volume.header.slice(), v = view(header), free = volume.free_blocks + fork.blocks + 1;
    v.setUint32(44, total);
    v.setUint32(48, free);
    volume.total_blocks = total;
    volume.free_blocks = free;
    await write_volume_header(volume, write, header);
    return { size, blocks: count, extents: [{ start, count }] };
}

async function write_volume_header(volume, write, header)
{
    const block = volume.block_size, tail = new Uint8Array(block);
    tail.set(header, block - 1024);
    await write((volume.total_blocks - 1) * block, tail);
    await write(1024, header);
    volume.header = header;
}

async function resize_resource(volume, write, file, fork)
{
    const tree = volume.catalog;
    for(const [n, leaf] of tree.cache)
    {
        if(leaf.kind !== -1) continue;
        const index = leaf.records.findIndex(({ data }) => view(data).getUint16(0) === 2 && view(data).getUint32(8) === file.id);
        if(index < 0) continue;
        const at = n * tree.node_size, node = await volume.read_fork(tree.file_id, tree.fork, at, tree.node_size);
        const v = view(node), start = v.getUint16(tree.node_size - 2 * (index + 1));
        const data = start + 2 + ((v.getUint16(start) + 1) & ~1);
        const resource = data + 168;
        v.setBigUint64(resource, BigInt(fork.size));
        if(fork.extents !== file.resource.extents)
        {
            v.setUint32(resource + 12, fork.blocks);
            node.fill(0, resource + 16, resource + 80);
            for(const [i, extent] of fork.extents.entries())
            {
                v.setUint32(resource + 16 + 8 * i, extent.start);
                v.setUint32(resource + 20 + 8 * i, extent.count);
            }
        }
        await write_fork(write, volume, tree.file_id, tree.fork, 0, at, node);
        tree.cache.delete(n);
        file.resource = fork;
        return;
    }
    throw new Error("Could not locate the display daemon's resource fork record");
}

function compare_catalog_key(a, b)
{
    const av = view(a), bv = view(b);
    const parent = av.getUint32(2) - bv.getUint32(2);
    if(parent) return parent;
    for(let i = 8; i < Math.min(a.length, b.length); i += 2)
    {
        const unit = av.getUint16(i) - bv.getUint16(i);
        if(unit) return unit;
    }
    return a.length - b.length;
}

async function insert_catalog_record(volume, write, key, data)
{
    const tree = volume.catalog, size = tree.node_size;
    await volume.walk(tree, other => compare_catalog_key(other, key), () => false);
    for(const [n, leaf] of tree.cache)
    {
        if(leaf.kind !== -1 || !leaf.records.length || compare_catalog_key(leaf.records[0].key, key) >= 0) continue;
        const index = leaf.records.findIndex(record => compare_catalog_key(record.key, key) >= 0);
        if(index < 0 && leaf.next) continue;
        expect(index < 0 || compare_catalog_key(leaf.records[index].key, key) > 0, "Duplicate system catalog record");
        const at = n * size, node = await volume.read_fork(tree.file_id, tree.fork, at, size), v = view(node);
        const count = leaf.records.length, slot = i => size - 2 * (i + 1);
        const position = index < 0 ? count : index;
        const start = v.getUint16(slot(position)), free = v.getUint16(slot(count)), grow = key.length + data.length;
        // Both records fit in existing 10B329 leaves without changing their first keys.
        expect(free + grow <= slot(count + 1), "The system catalog leaf has no room for the guest library");
        node.copyWithin(start + grow, start, free);
        for(let i = count; i >= position; i--) v.setUint16(slot(i + 1), v.getUint16(slot(i)) + grow);
        node.set(key, start);
        node.set(data, start + key.length);
        v.setUint16(10, count + 1);
        await write_fork(write, volume, tree.file_id, tree.fork, 0, at, node);
        tree.cache.delete(n);
        return;
    }
    throw new Error("Could not insert the guest library's system catalog record");
}

async function install_system_gl(volume, write, library)
{
    check_guest_library(library);
    return install_system_file(volume, write, SYSTEM_GL_LIBRARY, library, 0o755);
}

// Only offline private copies may be edited. Parent directories must exist;
// insertion fails before overwriting a full catalog leaf.
export async function install_system_file(volume, write, path, library, mode = 0o644)
{
    expect(path.startsWith("/") && !path.split("/").some(p => p === "." || p === ".."), "Invalid system file path");
    expect(!await volume.lookup(path), "System file already exists: " + path);
    const slash = path.lastIndexOf("/"), directory = await volume.lookup(path.slice(0, slash) || "/"), name = path.slice(slash + 1);
    const tree = volume.catalog;
    expect(volume.case_sensitive && tree.key_compare === 0xBC && directory?.type === "directory", "Expected an existing N90 HFSX parent directory: " + path);
    const parent = [...tree.cache].find(([, leaf]) => leaf.kind === -1 && leaf.records.some(({ data }) =>
        view(data).getUint16(0) === 1 && view(data).getUint32(8) === directory.id));
    expect(parent, "Missing the system library directory record");
    const [parentNode, leaf] = parent, size = tree.node_size;
    const parentIndex = leaf.records.findIndex(({ data }) => view(data).getUint16(0) === 1 && view(data).getUint32(8) === directory.id);

    const fileID = view(volume.header).getUint32(64), record = new Uint8Array(248), v = view(record);
    v.setUint16(0, 2);
    v.setUint16(2, 2); // has a file thread
    v.setUint32(8, fileID);
    record.set(leaf.records[parentIndex].data.subarray(12, 32), 12);
    v.setUint16(42, 0o100000 | mode);
    v.setUint32(44, 1);
    const { blocks, extents: [{ start }] } = await extend_system_volume(volume, write, { blocks: 0, extents: [] }, library.length);
    v.setBigUint64(88, BigInt(library.length));
    v.setUint32(100, blocks);
    v.setUint32(104, start);
    v.setUint32(108, blocks);
    await write(start * volume.block_size, library);

    // Update the directory before inserting records, which can shift offsets in its leaf.
    const parentAt = parentNode * size, node = await volume.read_fork(tree.file_id, tree.fork, parentAt, size), nv = view(node);
    const keyAt = nv.getUint16(size - 2 * (parentIndex + 1)), bodyAt = keyAt + 2 + nv.getUint16(keyAt);
    nv.setUint32(bodyAt + 4, directory.valence + 1);
    await write_fork(write, volume, tree.file_id, tree.fork, 0, parentAt, node);
    tree.cache.delete(parentNode);

    await insert_catalog_record(volume, write, catalog_key(directory.id, name), record);
    await insert_catalog_record(volume, write, catalog_key(fileID, ""), catalog_thread(directory.id, name, false));
    const catalogHeader = await volume.read_fork(tree.file_id, tree.fork, 0, size), ch = view(catalogHeader);
    ch.setUint32(20, ch.getUint32(20) + 2); // leaf records in BTHeaderRec
    await write_fork(write, volume, tree.file_id, tree.fork, 0, 0, catalogHeader);
    const header = volume.header.slice(), hv = view(header);
    hv.setUint32(32, hv.getUint32(32) + 1);
    hv.setUint32(64, fileID + 1);
    await write_volume_header(volume, write, header);
    const installed = await volume.lookup(path);
    expect(installed && equals(await volume.contents(installed), library), "Could not read back the system guest library");
}

export async function prepare_system_volume(read, write, graphics, compress = deflate, offline = false, library = null)
{
    const volume = await new HFSPlus(read).open(), daemons = [];
    await fix_fstab(volume, write, compress);
    expect(text.decode(await volume.contents(await volume.lookup("/private/etc/fstab"))) === V86_FSTAB,
        "Patched fstab could not be read back");
    if(graphics)
        for(const path of DISPLAY_DAEMONS) daemons.push(await rewrite_daemon(volume, write, path, compress, link_guest_gles));
    if(library)
    {
        await install_system_gl(volume, write, library);
        for(const path of SYSTEM_GL_APPLICATIONS)
            daemons.push(await rewrite_daemon(volume, write, path, compress, bytes => link_guest_gles(bytes, SYSTEM_GL_LIBRARY)));
    }
    const lockdown = offline ? await rewrite_daemon(volume, write, LOCKDOWN_DAEMON, compress, offline_lockdown) : null;
    return { volume, daemons, lockdown };
}
