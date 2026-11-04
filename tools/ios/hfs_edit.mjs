// Offline edits to private volume copies. Map a B-tree leaf to its
// physical extents, just as HFSPlus.read_fork maps the corresponding read.
import assert from "node:assert/strict";
import fs from "node:fs";
import { HFSPlus } from "../../src/ios/hfsplus.js";

export function open_volume(fd)
{
    return new HFSPlus((at, n) => {
        const b = Buffer.alloc(n);
        assert.equal(fs.readSync(fd, b, 0, n, at), n);
        return b;
    }).open();
}

export async function write_node(fd, volume, tree, number, bytes)
{
    assert.equal(bytes.length, tree.node_size);
    await write_fork(fd, volume, tree.file_id, tree.fork, 0, number * tree.node_size, bytes);
}

export async function write_fork(fd, volume, id, fork, type, at, bytes)
{
    assert.ok(at >= 0 && at + bytes.length <= fork.size);
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
            const n = fs.writeSync(fd, bytes, lo - at, hi - lo, extent.start * volume.block_size + lo - pos);
            assert.equal(n, hi - lo);
            done += n;
        }
        pos += span;
    }
    assert.equal(done, bytes.length);
}
