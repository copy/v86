// Prepare a sparse N90 data volume from the owner's local HFSX image.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open_volume } from "./hfs_edit.mjs";
import { write_hfsx_data } from "../../src/ios/hfsx_data.js";
import { data_capacity } from "../../src/ios/nand_volumes.js";
import { check_guest_library, has_offline_lockdown, LOCKDOWN_DAEMON } from "../../src/ios/guest_load.js";
import { offline_setup_file, systembag } from "../../src/ios/provision.js";

const [source, output, option, library, ...extra] = process.argv.slice(2);
if(!source || !output || extra.length || option && (option !== "--gles-library" || !library))
    throw new Error("usage: data-volume.mjs system.hfs new-data.hfs [--gles-library libv86gles.dylib]");

const files = [{ path: "/keybags/systembag.kb", bytes: systembag(), dir_mode: 0o700, mode: 0o600 }];
if(library)
{
    const bytes = fs.readFileSync(library);
    check_guest_library(bytes);
    files.push({ path: "/v86/libv86gles.dylib", bytes, dir_mode: 0o755, mode: 0o755 });
}
const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), ".n90-data-")), temp = path.join(dir, "volume");
try
{
    const sourceFD = fs.openSync(source, "r");
    try
    {
        const system = await open_volume(sourceFD), capacity = data_capacity(system.block_size * system.total_blocks);
        const lockdownd = await system.lookup(LOCKDOWN_DAEMON);
        if(lockdownd && has_offline_lockdown(await system.contents(lockdownd))) files.push(offline_setup_file());
        const fd = fs.openSync(temp, "wx+");
        try
        {
            fs.ftruncateSync(fd, capacity);
            const count = await write_hfsx_data(system, capacity, (at, bytes) => {
                assert.equal(fs.writeSync(fd, bytes, 0, bytes.length, at), bytes.length);
            }, files);
            const result = await open_volume(fd);
            async function verify(p, original, bytes)
            {
                const actual = await result.lookup(p);
                assert.deepEqual([actual?.type, actual?.uid, actual?.gid, actual?.mode],
                    [original.type, original.uid, original.gid, original.mode], p);
                if(bytes) assert.ok(Buffer.from(await result.contents(actual)).equals(bytes), p);
            }
            await system.walk_tree("/private/var", async (p, entry) =>
                verify(p.slice("/private/var".length), entry, entry.type === "directory" ? null : await system.contents(entry)));
            for(const f of files)
                await verify(f.path, { type: "file", uid: f.uid || 0, gid: f.gid || 0, mode: 0o100000 | f.mode }, f.bytes);
            console.log("Prepared " + capacity + " bytes of HFSX data with " + count + " catalog entries");
        }
        finally { fs.closeSync(fd); }
    }
    finally { fs.closeSync(sourceFD); }
    fs.linkSync(temp, output);
}
finally { fs.rmSync(dir, { recursive: true, force: true }); }
