#!/usr/bin/env node
// An Android image package made into a v64 disk in node
// (docs/android-images-plan.md I3.1, src/android/assemble.js): what the VM
// manager's importer does in a worker, into a file. A Cuttlefish images
// zip (ci.android.com's aosp_cf_arm64_only_phone-img-<build>.zip) gives the
// device's GPT disk: its images as they are, super shrunk, userdata blank
// (formatted at first boot). V86's android option boots it.
//
//   node tools/android_import.mjs <package.zip> <disk.img> [--userdata-mb 4096]

import fs from "node:fs";
import path from "node:path";
import { identify_package, cuttlefish_disk, write_disk, package_entries } from "../src/android/assemble.js";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args.splice(i, 2)[1]; };
const userdata_mb = +option("--userdata-mb", 4096);
if(args.length !== 2 || !(userdata_mb > 0)) throw new Error("node tools/android_import.mjs <package.zip> <disk.img> [--userdata-mb 4096]");
const [zip, out] = args.map(a => path.resolve(a));

const fd = fs.openSync(zip, "r");
const read = (offset, length) =>
{
    const b = Buffer.allocUnsafe(length);
    return b.subarray(0, fs.readSync(fd, b, 0, length, offset));
};
const entries = await package_entries(read, fs.statSync(zip).size);
const kind = await identify_package(entries, read);
if(!kind || kind.kind !== "cuttlefish") throw new Error(path.basename(zip) + ": " + (kind ? kind.text + ", which this importer does not take yet" : "not an Android image package"));
console.log(path.basename(zip) + ": " + kind.text);
const disk = await cuttlefish_disk(read, entries, { userdata_bytes: userdata_mb * 1048576 });
console.log(`disk: ${disk.disk_size} bytes, ${disk.partitions.length} partitions, super ${disk.super_size} bytes, ${disk.data_bytes} bytes to write`);
fs.rmSync(out, { force: true });
const target = fs.openSync(out, "w");
fs.ftruncateSync(target, disk.disk_size);
let shown = -1;
const started = Date.now();
await write_disk(read, disk, (offset, bytes) => { fs.writeSync(target, bytes, 0, bytes.length, offset); }, (done, total) =>
{
    const percent = Math.floor(done / total * 100);
    if(percent !== shown && percent % 10 === 0) console.log(`${percent}% (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    shown = percent;
});
fs.closeSync(target);
console.log(`${out}: ${disk.disk_size} bytes in ${((Date.now() - started) / 1000).toFixed(1)} s; partitions: ` +
    disk.partitions.map(p => `${p.name} ${p.start}+${p.size}`).join(", "));
