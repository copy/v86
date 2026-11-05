// Prepare a local kernel that trusts the locally linked executables and
// the guest graphics library.
import fs from "node:fs";
import { open_volume } from "./hfs_edit.mjs";
import { macho_parse } from "../../src/apple/macho.js";
import { DISPLAY_DAEMONS, LOCKDOWN_DAEMON, SYSTEM_GL_APPLICATIONS, SYSTEM_GL_LIBRARY, graphics_kernel } from "../../src/ios/guest_load.js";

const [kernelPath, systemPath, libPath, output, mode, ...extra] = process.argv.slice(2);
if(!output || extra.length || mode && mode !== "--offline")
    throw new Error("usage: graphics-kernel.mjs stock-kernel linked-system.hfs libv86gles.dylib new-kernel [--offline]");
const fd = fs.openSync(systemPath, "r");
try
{
    const volume = await open_volume(fd), daemons = [];
    for(const path of DISPLAY_DAEMONS) daemons.push(await volume.contents(await volume.lookup(path)));
    const library = fs.readFileSync(libPath), systemLibrary = await volume.lookup(SYSTEM_GL_LIBRARY);
    if(systemLibrary)
    {
        if(!library.equals(await volume.contents(systemLibrary))) throw new Error("System and data graphics libraries differ");
        for(const path of SYSTEM_GL_APPLICATIONS)
        {
            const executable = await volume.contents(await volume.lookup(path));
            if(macho_parse(executable).dylibs.includes(SYSTEM_GL_LIBRARY)) daemons.push(executable);
        }
    }
    const lockdown = mode === "--offline" ? await volume.contents(await volume.lookup(LOCKDOWN_DAEMON)) : null;
    fs.writeFileSync(output, graphics_kernel(fs.readFileSync(kernelPath), daemons, library, lockdown), { flag: "wx" });
}
finally { fs.closeSync(fd); }
console.log("Prepared local N90 kernel with graphics CodeDirectory trust entries");
