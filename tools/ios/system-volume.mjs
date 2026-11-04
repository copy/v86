// Prepare a private copy of the 10B329 restore volume for the LwVM layout.
// Update only fstab's inline compressed attribute in its existing HFS leaf.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { open_volume, write_node } from "./hfs_edit.mjs";

const [source, output] = process.argv.slice(2);
if(!source || !output) throw new Error("usage: system-volume.mjs rootfs.hfs new-system.hfs");
const original = "/dev/disk0s1 / hfs ro 0 1\n/dev/disk0s2 /private/var hfs rw,nosuid,nodev 0 2\n";
const prepared = original.replace("disk0s1 ", "disk0s1s1 ").replace("disk0s2 ", "disk0s1s2 ");
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
    }
    finally { fs.closeSync(fd); }
    fs.linkSync(temp, output);
}
finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("Prepared HFS system volume with disk0s1s1 root and disk0s1s2 data mount");
