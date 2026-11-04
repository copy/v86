// On macOS, create the N90 data volume from the owner's HFSX system image.
// hdiutil only sees a private staging folder. Restore the guest's ownership
// in the completed catalog rather than changing host file ownership.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { open_volume, write_node } from "./hfs_edit.mjs";
import { plist_parse } from "../../src/ios/plist.js";
import { macho_parse, CPU_TYPE_ARM } from "../../src/apple/macho.js";
import { data_capacity } from "./nand_volumes.mjs";
import { GUEST_GL_LIBRARY } from "./guest-load.mjs";
import { systembag } from "./systembag.mjs";

const [source, output, option, library, ...extra] = process.argv.slice(2);
if(!source || !output || extra.length || option && (option !== "--gles-library" || !library))
    throw new Error("usage: data-volume.mjs system.hfs new-data.hfs [--gles-library libv86gles.dylib]");

const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), ".n90-data-"));
const stage = path.join(dir, "files"), bundle = path.join(dir, "Data.sparsebundle"), raw = path.join(dir, "volume");

try
{
    const sourceFD = fs.openSync(source, "r");
    try
    {
        const system = await open_volume(sourceFD), entries = new Map();
        const capacity = data_capacity(system.block_size * system.total_blocks);
        assert.ok(Number.isSafeInteger(capacity) && capacity > 0);
        fs.mkdirSync(stage);
        await system.walk_tree("/private/var", async (p, entry) => {
            const rel = p.slice("/private/var/".length);
            assert.ok(rel && rel.split("/").every(n => n && n !== "." && n !== ".."));
            const dest = path.join(stage, rel);
            if(entry.type === "directory") fs.mkdirSync(dest);
            else if(entry.type === "symlink") fs.symlinkSync(Buffer.from(await system.contents(entry)).toString(), dest);
            else if(entry.type === "file") fs.writeFileSync(dest, await system.contents(entry), { flag: "wx" });
            else throw new Error("unsupported data volume entry " + p);
            entries.set("/" + rel, entry);
        });
        const generated = new Map();
        function provision(directory, name, bytes, dirMode, fileMode)
        {
            const key = "/" + directory, file = key + "/" + name;
            if(!entries.has(key))
            {
                fs.mkdirSync(path.join(stage, directory), { mode: dirMode });
                entries.set(key, { type: "directory", uid: 0, gid: 0, flags: 0, mode: 0o40000 | dirMode });
            }
            fs.writeFileSync(path.join(stage, directory, name), bytes, { flag: "wx", mode: fileMode });
            entries.set(file, { type: "file", uid: 0, gid: 0, flags: 0, mode: 0o100000 | fileMode });
            generated.set(file, bytes);
        }
        provision("keybags", "systembag.kb", systembag(), 0o700, 0o600);
        if(library)
        {
            const bytes = fs.readFileSync(library), binary = macho_parse(bytes);
            assert.ok(!binary.is64 && binary.cputype === CPU_TYPE_ARM && binary.filetype === 6 &&
                binary.id === GUEST_GL_LIBRARY, "expected the N90 guest GLES dylib");
            provision("v86", "libv86gles.dylib", bytes, 0o755, 0o755);
        }
        execFileSync("hdiutil", ["create", "-srcfolder", stage, "-fs", "HFSX", "-layout", "NONE", "-format", "UDSB",
            "-size", capacity / 1048576 + "m", "-nospotlight", "-volname", "Data", bundle], { stdio: "inherit" });

        const info = plist_parse(fs.readFileSync(path.join(bundle, "Info.plist"), "utf8"));
        const bandSize = Number(info["band-size"]);
        assert.equal(Number(info.size), capacity);
        assert.ok(Number.isSafeInteger(bandSize) && bandSize > 0);
        const fd = fs.openSync(raw, "wx+");
        try
        {
            fs.ftruncateSync(fd, capacity);
            for(const name of fs.readdirSync(path.join(bundle, "bands")))
            {
                assert.match(name, /^[a-f0-9]+$/);
                const at = parseInt(name, 16) * bandSize, bytes = fs.readFileSync(path.join(bundle, "bands", name));
                assert.ok(bytes.length <= bandSize && at + bytes.length <= capacity);
                assert.equal(fs.writeSync(fd, bytes, 0, bytes.length, at), bytes.length);
            }
            const data = await open_volume(fd), tree = data.catalog, byId = new Map();
            for(const [p, sourceEntry] of entries)
            {
                const dest = await data.lookup(p);
                assert.equal(dest?.type, sourceEntry.type, p);
                byId.set(dest.id, sourceEntry);
            }
            for(let n = tree.first_leaf; n;)
            {
                const node = await data.node(tree, n);
                const rawNode = Buffer.from(await data.read_fork(tree.file_id, tree.fork, n * tree.node_size, tree.node_size));
                let dirty = false;
                for(const [i, record] of node.records.entries())
                {
                    const body = Buffer.from(record.data);
                    if(![1, 2].includes(body.readInt16BE(0))) continue;
                    const entry = byId.get(body.readUInt32BE(8));
                    if(!entry) continue;
                    const start = rawNode.readUInt16BE(tree.node_size - 2 * (i + 1));
                    const at = start + 2 + ((rawNode.readUInt16BE(start) + 1) & ~1);
                    rawNode.writeUInt32BE(entry.uid, at + 32);
                    rawNode.writeUInt32BE(entry.gid, at + 36);
                    rawNode.writeUInt16BE(entry.flags & ~0x20 | body.readUInt16BE(40) & 0x20, at + 40);
                    rawNode.writeUInt16BE(entry.mode, at + 42);
                    dirty = true;
                }
                if(dirty) await write_node(fd, data, tree, n, rawNode);
                n = node.next;
            }
            const verified = await open_volume(fd);
            for(const [p, sourceEntry] of entries)
            {
                const dest = await verified.lookup(p);
                assert.deepEqual([dest.type, dest.uid, dest.gid, dest.mode],
                    [sourceEntry.type, sourceEntry.uid, sourceEntry.gid, sourceEntry.mode], p);
                if(dest.type !== "directory")
                    assert.ok(Buffer.from(await verified.contents(dest)).equals(generated.get(p) ?? await system.contents(sourceEntry)), p);
            }
        }
        finally { fs.closeSync(fd); }
        fs.linkSync(raw, output);
        console.log("Prepared " + capacity + " bytes of HFSX data with " + entries.size + " verified entries");
    }
    finally { fs.closeSync(sourceFD); }
}
finally { fs.rmSync(dir, { recursive: true, force: true }); }
