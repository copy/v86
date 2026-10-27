#!/usr/bin/env node
// An HFS+ or HFSX volume, read (docs/iphone4-plan.md S0; src/ios/hfsplus.js):
//
//   node tools/ios/hfsplus.mjs <image> info
//   node tools/ios/hfsplus.mjs <image> ls [<path>]
//   node tools/ios/hfsplus.mjs <image> find [<path>]        every entry under path
//   node tools/ios/hfsplus.mjs <image> cat <path>           to stdout
//   node tools/ios/hfsplus.mjs <image> extract <path> <out> a file, or a directory's tree

import fs from "node:fs";
import path from "node:path";
import { HFSPlus } from "../../src/ios/hfsplus.js";

const [image, command = "info", target = "/", out] = process.argv.slice(2);
if(!image || !["info", "ls", "find", "cat", "extract"].includes(command) || command === "extract" && !out)
{
    throw new Error("node tools/ios/hfsplus.mjs <image> info|ls|find|cat|extract [<path>] [<out>]");
}
const fd = fs.openSync(image, "r");
const read = (offset, length) =>
{
    const b = Buffer.alloc(length);
    fs.readSync(fd, b, 0, length, offset);
    return new Uint8Array(b.buffer, b.byteOffset, length);
};
const volume = await new HFSPlus(read).open();
const mode = e => (e.type === "directory" ? "d" : e.type === "symlink" ? "l" : e.type === "hardlink" ? "h" : "-") +
    (e.mode & 0o7777).toString(8).padStart(4, "0");
const line = (p, e) => `${mode(e)} ${String(e.uid).padStart(4)} ${String(e.gid).padStart(4)} ${String(e.type === "directory" ? e.valence : e.size).padStart(10)}` +
    `${e.compressed ? "c" : " "} ${p}`;

if(command === "info")
{
    console.log(`${volume.case_sensitive ? "HFSX" : "HFS+"}: ${volume.block_size}-byte blocks, ${volume.total_blocks} in all, ${volume.free_blocks} free`);
}
else if(command === "ls")
{
    const e = await volume.lookup(target);
    if(!e) throw new Error(`no ${target}`);
    for(const c of e.type === "directory" ? await volume.list(e.id) : [e]) console.log(line(c.name, c));
}
else if(command === "find")
{
    await volume.walk_tree(target, (p, e) => { console.log(line(p, e)); });
}
else if(command === "cat")
{
    const e = await volume.lookup(target);
    if(!e) throw new Error(`no ${target}`);
    process.stdout.write(await volume.contents(e));
}
else
{
    const start = await volume.lookup(target);
    if(!start) throw new Error(`no ${target}`);
    if(start.type !== "directory")
    {
        fs.writeFileSync(out, await volume.contents(start));
    }
    else
    {
        await volume.walk_tree(target, async (p, e) =>
        {
            const dest = path.join(out, path.relative(target, p));
            if(e.type === "directory") fs.mkdirSync(dest, { recursive: true });
            else if(e.type === "symlink") { fs.rmSync(dest, { force: true }); fs.symlinkSync(new TextDecoder().decode(await volume.contents(e)), dest); }
            else fs.writeFileSync(dest, await volume.contents(e));
        });
    }
}
