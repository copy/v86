#!/usr/bin/env node
// An Android image package made into a v64 disk in node
// (docs/android-images-plan.md I3.1, src/android/assemble.js): what the VM
// manager's importer does in a worker, into a file. A Cuttlefish images
// zip (ci.android.com's aosp_cf_arm64_only_phone-img-<build>.zip) gives the
// device's GPT disk: its images as they are, super shrunk, userdata blank
// (formatted at first boot). V86's android option boots it.
//
//   node tools/android_import.mjs <package.zip> <disk.img> [--userdata-mb 4096] [--gsi <gsi.zip>]
//   (--gsi: a Generic System Image's system as system_a, its vbmeta the
//   top-level one: docs/android-images-plan.md I5)

import fs from "node:fs";
import path from "node:path";
import { identify_package, cuttlefish_disk, write_disk, package_entries, gsi_package } from "../src/android/assemble.js";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args.splice(i, 2)[1]; };
const userdata_mb = +option("--userdata-mb", 4096);
const gsi_zip = option("--gsi", "");
if(args.length !== 2 || !(userdata_mb > 0)) throw new Error("node tools/android_import.mjs <package.zip> <disk.img> [--userdata-mb 4096] [--gsi <gsi.zip>]");
const [zip, out] = args.map(a => path.resolve(a));

const file_reader = file =>
{
    const fd = fs.openSync(file, "r");
    return (offset, length) =>
    {
        const b = Buffer.allocUnsafe(length);
        return b.subarray(0, fs.readSync(fd, b, 0, length, offset));
    };
};
const read = file_reader(zip);
const entries = await package_entries(read, fs.statSync(zip).size);
const kind = await identify_package(entries, read);
if(!kind || kind.kind !== "cuttlefish") throw new Error(path.basename(zip) + ": " + (kind ? kind.text + ", which this importer does not take yet" : "not an Android image package"));
console.log(path.basename(zip) + ": " + kind.text);
let gsi = null, gsi_read = null;
if(gsi_zip)
{
    gsi_read = file_reader(gsi_zip);
    const gsi_entries = await package_entries(gsi_read, fs.statSync(gsi_zip).size);
    if((await identify_package(gsi_entries, gsi_read))?.kind !== "gsi") throw new Error(gsi_zip + ": not a GSI zip");
    gsi = await gsi_package(gsi_read, gsi_entries);
    console.log(`${path.basename(gsi_zip)}: a GSI, Android ${gsi.release} (sdk_full ${gsi.sdk_full}), ${gsi.fingerprint}`);
}
const disk = await cuttlefish_disk(read, entries, { userdata_bytes: userdata_mb * 1048576, gsi, gsi_read });
if(gsi) console.log("the device's vendor: sdk_full " + disk.vendor_sdk_full);
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
