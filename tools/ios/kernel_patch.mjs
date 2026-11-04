// S3 only: build a local kernel for the modified restore ramdisk. 10B329
// invokes the platform SecureRootName callback from BSD init, then waits
// for a verifier for the physical boot chain which is absent on direct boot.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { macho_parse, macho_offset } from "../../src/apple/macho.js";

const [source, output] = process.argv.slice(2);
if(!output) throw new Error("usage: kernel_patch.mjs original-N90-kernel new-recovery-kernel");
const bytes = fs.readFileSync(source);
if(createHash("sha256").update(bytes).digest("hex") !== "82127c1ea84dbc1b55f423a4d60cdfe6a3baaabc117d4a891af0b502e57a2c47")
    throw new Error("expected the original iPhone3,1 10B329 kernelcache");
const kernel = macho_parse(bytes);
const site = macho_offset(kernel, 0x802BBE68);
if(site < 0 || bytes.readUInt32LE(site) !== 0xF82CF7B5) throw new Error("unexpected SecureRootName call site");
// The original call returns void. Keep this change local to the debug image
// and this BSD-init caller; the platform-function dispatcher stays intact.
bytes.writeUInt32LE(0xBF00BF00, site);
fs.writeFileSync(output, bytes, { flag: "wx" });
console.log("Created local 10B329 recovery kernel " + output);
