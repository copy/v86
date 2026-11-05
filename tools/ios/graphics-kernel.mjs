// Prepare a local kernel that trusts only the linked display daemons
// and the guest graphics library.
import fs from "node:fs";
import { open_volume } from "./hfs_edit.mjs";
import { DISPLAY_DAEMONS, graphics_kernel } from "../../src/ios/guest_load.js";

const [kernelPath, systemPath, libPath, output, ...extra] = process.argv.slice(2);
if(!output || extra.length) throw new Error("usage: graphics-kernel.mjs stock-kernel linked-system.hfs libv86gles.dylib new-kernel");
const fd = fs.openSync(systemPath, "r");
try
{
    const volume = await open_volume(fd), daemons = [];
    for(const path of DISPLAY_DAEMONS) daemons.push(await volume.contents(await volume.lookup(path)));
    fs.writeFileSync(output, graphics_kernel(fs.readFileSync(kernelPath), daemons, fs.readFileSync(libPath)), { flag: "wx" });
}
finally { fs.closeSync(fd); }
console.log("Prepared local N90 kernel with graphics CodeDirectory trust entries");
