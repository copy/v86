// Prepare a private copy of the 10B329 restore volume for the LwVM layout.
// Configure fstab and, when requested, link the two display daemons to the guest adapter.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { link_guest_gles } from "./guest-load.mjs";
import { open_volume, write_fork, write_node } from "./hfs_edit.mjs";

// Keep each executable's uncompressed length, resource map, allocated
// extents and catalog metadata. Only the chunk table and its payload change.
async function link_display_daemon(fd, target)
{
    const volume = await open_volume(fd), file = await volume.lookup(target);
    assert.ok(file?.compressed && file.resource.size);
    const attr = Buffer.from(await volume.attribute(file.id, "com.apple.decmpfs"));
    assert.equal(attr.readUInt32LE(4), 4);
    const original = Buffer.from(await volume.contents(file)), bytes = link_guest_gles(original);
    const resource = Buffer.from(await volume.read_fork(file.id, file.resource, 0, file.resource.size, 255));
    const data = resource.readUInt32BE(), table = data + 4, capacity = resource.readUInt32BE(data);
    const count = resource.readUInt32LE(table);
    assert.equal(count, Math.ceil(bytes.length / 65536));
    assert.ok(table + capacity <= resource.length);
    let used = 4 + count * 8;
    for(let i = 0; i < count; i++)
    {
        const block = bytes.subarray(i * 65536, (i + 1) * 65536);
        let chunk = deflateSync(block, { level: 9 });
        if(chunk.length >= block.length) chunk = Buffer.concat([Buffer.from([255]), block]);
        assert.ok(used + chunk.length <= capacity, target + ": compressed resource has no room");
        resource.writeUInt32LE(used, table + 4 + 8 * i);
        resource.writeUInt32LE(chunk.length, table + 8 + 8 * i);
        chunk.copy(resource, table + used);
        used += chunk.length;
    }
    await write_fork(fd, volume, file.id, file.resource, 255, 0, resource);
    const check = await open_volume(fd);
    assert.deepEqual(Buffer.from(await check.contents(await check.lookup(target))), bytes);
}

const [source, output, mode, ...extra] = process.argv.slice(2);
if(!source || !output || extra.length || mode && mode !== "--gles") throw new Error("usage: system-volume.mjs rootfs.hfs new-system.hfs [--gles]");
const original = "/dev/disk0s1 / hfs ro 0 1\n/dev/disk0s2 /private/var hfs rw,nosuid,nodev 0 2\n";
const prepared = original.replace("disk0s1 ", "disk0s1s1 ").replace("disk0s2 ", "disk0s1s2 ")
    .replace("rw,nosuid,nodev", "rw,nosuid,nodev,protect");
const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), ".n90-system-"));
const temp = path.join(dir, "volume");
try
{
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_FICLONE);
    const fd = fs.openSync(temp, "r+");
    try
    {
        const volume = await open_volume(fd), file = await volume.lookup("/private/etc/fstab");
        assert.equal(Buffer.from(await volume.contents(file)).toString(), original, "expected the 10B329 fstab");
        const attr = Buffer.from(await volume.attribute(file.id, "com.apple.decmpfs"));
        assert.equal(attr.readUInt32LE(4), 3, "expected inline DEFLATE");
        const updated = Buffer.concat([attr.subarray(0, 16), deflateSync(prepared)]);
        updated.writeBigUInt64LE(BigInt(Buffer.byteLength(prepared)), 8);

        const tree = volume.attributes;
        let patched = false;
        for(const [n, leaf] of tree.cache)
        {
            if(leaf.kind !== -1) continue;
            const index = leaf.records.findIndex(({ key, data }) =>
                Buffer.from(key).readUInt32BE(4) === file.id && Buffer.from(data.subarray(16)).subarray(0, attr.length).equals(attr));
            if(index < 0) continue;
            assert.ok(!patched);
            const size = tree.node_size, at = n * size;
            const node = Buffer.from(await volume.read_fork(tree.file_id, tree.fork, at, size));
            const count = leaf.records.length, slot = i => size - 2 * (i + 1);
            const start = node.readUInt16BE(slot(index)), end = node.readUInt16BE(slot(index + 1));
            const free = node.readUInt16BE(slot(count)), data = start + 2 + ((node.readUInt16BE(start) + 1) & ~1);
            const grow = data + 16 + ((updated.length + 1) & ~1) - end;
            assert.ok(free + grow <= slot(count), "attribute leaf is full");
            node.copyWithin(end + grow, end, free);
            for(let i = index + 1; i <= count; i++) node.writeUInt16BE(node.readUInt16BE(slot(i)) + grow, slot(i));
            node.writeUInt32BE(updated.length, data + 12);
            updated.copy(node, data + 16);
            if(updated.length & 1) node[data + 16 + updated.length] = 0;
            await write_node(fd, volume, tree, n, node);
            patched = true;
        }
        assert.ok(patched, "fstab attribute leaf not found");
        const check = await open_volume(fd);
        assert.equal(Buffer.from(await check.contents(await check.lookup("/private/etc/fstab"))).toString(), prepared);
        if(mode === "--gles")
        {
            await link_display_daemon(fd, "/usr/libexec/backboardd");
            await link_display_daemon(fd, "/System/Library/CoreServices/SpringBoard.app/SpringBoard");
        }
    }
    finally { fs.closeSync(fd); }
    fs.linkSync(temp, output);
}
finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("Prepared HFS system volume with disk0s1s1 root and disk0s1s2 data mount");
