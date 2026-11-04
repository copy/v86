// Prepare an optional local graphics kernel. Preload only the CodeDirectory
// hashes of the two linked executables and their guest driver into AMFI's
// native trust-cache list. Keep the preloaded head when AMFI initializes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { macho_offset, macho_parse } from "../../src/apple/macho.js";
import { open_volume } from "./hfs_edit.mjs";
import { GUEST_GL_LIBRARY, cdhashes } from "./guest-load.mjs";

const [kernelPath, systemPath, libPath, output, ...extra] = process.argv.slice(2);
if(!output || extra.length) throw new Error("usage: graphics-kernel.mjs stock-kernel linked-system.hfs libv86gles.dylib new-kernel");
const kernel = fs.readFileSync(kernelPath);
assert.equal(createHash("sha256").update(kernel).digest("hex"),
    "82127c1ea84dbc1b55f423a4d60cdfe6a3baaabc117d4a891af0b502e57a2c47", "expected the stock N90 10B329 kernel");
const hashes = [];
const fd = fs.openSync(systemPath, "r");
try
{
    const volume = await open_volume(fd);
    for(const path of ["/usr/libexec/backboardd", "/System/Library/CoreServices/SpringBoard.app/SpringBoard"])
    {
        const bytes = Buffer.from(await volume.contents(await volume.lookup(path)));
        assert.ok(macho_parse(bytes).dylibs.includes(GUEST_GL_LIBRARY), path + " must link the guest library");
        hashes.push(...cdhashes(bytes));
    }
}
finally { fs.closeSync(fd); }
const lib = fs.readFileSync(libPath);
assert.equal(macho_parse(lib).id, GUEST_GL_LIBRARY);
hashes.push(...cdhashes(lib));
const entries = Buffer.concat(hashes.sort(Buffer.compare));
const node = Buffer.alloc(24 + entries.length);
createHash("sha256").update(entries).digest().copy(node, 4, 0, 16); // cache UUID
node.writeUInt32LE(hashes.length, 20);
entries.copy(node, 24);
const macho = macho_parse(kernel);
const head = macho_offset(macho, 0x80423B3C), address = 0x80424120, at = macho_offset(macho, address);
assert.ok(head >= 0 && kernel.readUInt32LE(head) === 0 && at >= 0 &&
    address + node.length <= 0x80425000 && kernel.subarray(at, at + node.length).every(b => b === 0));
const clear = macho_offset(macho, 0x80413142);
assert.ok(clear >= 0 && kernel.readUInt16LE(clear) === 0x60E5, "unexpected AMFI list initializer");
kernel.writeUInt16LE(0xBF00, clear); // skip str r5, [r4, #12], which clears this list during boot
node.copy(kernel, at); // unused tail of the prelinked AMFI data segment
kernel.writeUInt32LE(address, head);
fs.writeFileSync(output, kernel, { flag: "wx" });
console.log("Prepared local N90 kernel with " + hashes.length + " graphics CodeDirectory hashes");
