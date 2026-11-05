// Prepare the supplied 10B329 system volume in place. It is already a
// private copy. No files from the IPSW are needed by the emulator build.
import { HFSPlus } from "./hfsplus.js";
import { DISPLAY_DAEMONS, link_guest_gles } from "./guest_load.js";

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

async function link_display_daemon(volume, write, path, compress)
{
    const file = await volume.lookup(path);
    expect(file?.compressed && file.resource.size, "Expected compressed display daemon: " + path);
    const attr = await volume.attribute(file.id, "com.apple.decmpfs");
    expect(attr && view(attr).getUint32(4, true) === 4, "Expected a compressed resource fork: " + path);
    const original = await volume.contents(file), patched = link_guest_gles(original);
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
            src.getUint32(8) === 4 + capacity && size <= file.resource.blocks * volume.block_size,
            "Compressed display daemon has no room: " + path);
        resource = new Uint8Array(size);
        resource.set(source.subarray(0, table));
        resource.set(source.subarray(oldMap), newMap);
        const dst = view(resource);
        dst.setUint32(4, newMap);
        dst.setUint32(8, 4 + used);
        dst.setUint32(base, used);
        if(equals(source.subarray(oldMap, oldMap + 16), source.subarray(0, 16)))
            resource.set(resource.subarray(0, 16), newMap);
        await resize_resource(volume, write, file, size);
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
    expect(equals(await volume.contents(file), patched), "Display daemon verification failed: " + path);
    return patched;
}

async function resize_resource(volume, write, file, size)
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
        v.setBigUint64(data + 168, BigInt(size));
        await write_fork(write, volume, tree.file_id, tree.fork, 0, at, node);
        tree.cache.delete(n);
        file.resource.size = size;
        return;
    }
    throw new Error("Could not locate the display daemon's resource fork record");
}

export async function prepare_system_volume(read, write, graphics, compress = deflate)
{
    const volume = await new HFSPlus(read).open(), daemons = [];
    await fix_fstab(volume, write, compress);
    expect(text.decode(await volume.contents(await volume.lookup("/private/etc/fstab"))) === V86_FSTAB,
        "Patched fstab could not be read back");
    if(graphics)
        for(const path of DISPLAY_DAEMONS) daemons.push(await link_display_daemon(volume, write, path, compress));
    return { volume, daemons };
}
