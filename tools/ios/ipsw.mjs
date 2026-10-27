#!/usr/bin/env node
// An iPhone IPSW's images, decrypted with the user's key file
// (docs/iphone4-plan.md S0; src/ios/ipsw.js). The key file comes from
// --keys or IPHONE4_KEYS (build/ios/keys/, never committed).
//
//   node tools/ios/ipsw.mjs info <ipsw>
//   node tools/ios/ipsw.mjs sha1 <ipsw>
//   node tools/ios/ipsw.mjs check <ipsw> [--keys <file>]
//   node tools/ios/ipsw.mjs extract <ipsw> <dir> [--keys <file>] [--no-rootfs]
//     kernelcache.<model>.macho (decompressed), DeviceTree.<board>.bin, restore.dmg (the
//     restore ramdisk's HFS+ volume), rootfs.hfs (the system partition, sparse)

import fs from "node:fs";
import path from "node:path";
import { ipsw_open, ipsw_sha1, ipsw_check, ipsw_image, keys_parse, extract_system_partition } from "../../src/ios/ipsw.js";
import { complzss_decompress } from "../../src/ios/lzss.js";

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const flag = name => { const i = args.indexOf(name); return i >= 0 && !!args.splice(i, 1); };
const keys_file = option("--keys") || process.env.IPHONE4_KEYS;
const no_rootfs = flag("--no-rootfs");
const [command, file, out_dir] = args;
const usage = "node tools/ios/ipsw.mjs info|sha1|check|extract <ipsw> [<dir>] [--keys <file>] [--no-rootfs]";
if(!file || !["info", "sha1", "check", "extract"].includes(command) || (command === "extract") !== !!out_dir) throw new Error(usage);

const fd = fs.openSync(file, "r");
const size = fs.fstatSync(fd).size;
const read = (offset, length) =>
{
    const b = Buffer.allocUnsafe(length);
    return new Uint8Array(b.buffer, b.byteOffset, fs.readSync(fd, b, 0, length, offset));
};
const progress_line = (label, done, total) =>
{
    if(process.stderr.isTTY) process.stderr.write(`\r${label} ${(done / total * 100).toFixed(0)}%   ` + (done >= total ? "\n" : ""));
};

if(command === "sha1")
{
    console.log(await ipsw_sha1(read, size, done => progress_line("sha1", done, size)));
    process.exit(0);
}

const ipsw = await ipsw_open(read, size);
console.log(`${path.basename(file)}: iOS ${ipsw.version} (${ipsw.build}) for ${ipsw.product_types.join(", ")}` +
    (ipsw.boards.length ? `, boards ${ipsw.boards.join(", ")}` : "") + `, ${size} bytes`);
if(command === "info")
{
    console.log(`kernelcache ${ipsw.kernelcache}, restore ramdisk ${ipsw.restore_ramdisk}, system image ${ipsw.system_image}`);
    for(const e of ipsw.entries) console.log(`${String(e.size).padStart(11)}  ${e.name}`);
    process.exit(0);
}

if(!keys_file) throw new Error("no key file: --keys <file> or IPHONE4_KEYS");
const keys = keys_parse(fs.readFileSync(keys_file, "utf8"));
if(keys.build !== ipsw.build || !ipsw.product_types.includes(keys.device))
{
    throw new Error(`the key file is for ${keys.device} ${keys.build}, the IPSW is ${ipsw.product_types.join(", ")} ${ipsw.build}`);
}
const rootfs_size = name => ipsw.member(keys.images[name].file)?.compressed_size || 1;

if(command === "check")
{
    const failures = await ipsw_check(ipsw, keys, (name, ok, text) => console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(17)} ${text}`),
        (name, done) => progress_line(name, done, rootfs_size(name)));
    console.log(`${Object.keys(keys.images).length - failures}/${Object.keys(keys.images).length} images decrypt and check out`);
    process.exit(failures ? 1 : 0);
}

fs.mkdirSync(out_dir, { recursive: true });
const write_file = (name, bytes) =>
{
    fs.writeFileSync(path.join(out_dir, name), bytes);
    console.log(`${name}: ${bytes.length} bytes`);
};
const model = ipsw.kernelcache?.replace(/^.*kernelcache\.release\./, "") || "kernel";
const board = ipsw.boards[0] || "board";
const image = name =>
{
    if(!keys.images[name]) throw new Error(`the key file has no ${name}`);
    return ipsw_image(ipsw, keys.images[name]);
};
write_file(`kernelcache.${model}.macho`, complzss_decompress((await image("Kernelcache")).data));
write_file(`DeviceTree.${board}.bin`, (await image("DeviceTree")).data);
write_file("restore.dmg", (await image("RestoreRamdisk")).data);
if(!no_rootfs)
{
    const target = path.join(out_dir, "rootfs.hfs");
    fs.rmSync(target, { force: true });
    const out = fs.openSync(target, "w");
    let written = 0;
    const result = await extract_system_partition(ipsw, keys.images.RootFileSystem, (offset, bytes) =>
    {
        fs.writeSync(out, bytes, 0, bytes.length, offset);
        written += bytes.length;
    }, (stage, done) => progress_line("RootFileSystem " + stage, done, rootfs_size("RootFileSystem")));
    fs.ftruncateSync(out, result.size);
    fs.closeSync(out);
    console.log(`rootfs.hfs: ${result.name}, ${result.size} bytes (${written} written, the rest zeros)`);
}
