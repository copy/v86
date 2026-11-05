// Prepare a private copy of the 10B329 system volume.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { prepare_system_volume } from "../../src/ios/system_volume.js";

const [source, output, ...options] = process.argv.slice(2);
if(!source || !output || options.some(option => !["--gles", "--offline"].includes(option)))
    throw new Error("usage: system-volume.mjs rootfs.hfs new-system.hfs [--gles] [--offline]");
const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), ".n90-system-")), temp = path.join(dir, "volume");
try
{
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_FICLONE);
    const fd = fs.openSync(temp, "r+");
    try
    {
        await prepare_system_volume((at, n) => {
            const bytes = new Uint8Array(n);
            assert.equal(fs.readSync(fd, bytes, 0, n, at), n);
            return bytes;
        }, (at, bytes) => {
            assert.equal(fs.writeSync(fd, bytes, 0, bytes.length, at), bytes.length);
        }, options.includes("--gles"), undefined, options.includes("--offline"));
    }
    finally { fs.closeSync(fd); }
    fs.linkSync(temp, output);
}
finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("Prepared HFS system volume with disk0s1s1 root and disk0s1s2 data mount");
