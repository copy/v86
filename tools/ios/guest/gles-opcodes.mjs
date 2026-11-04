// C names for the same emugl protocol table decoded by the host.
import { GLES_APIS } from "../../../src/gles/gles_protocol.js";

import { IOSURFACE_ACQUIRE } from "../../../src/gles/gles_wire.js";

console.log("#define v86_AcquireIOSurface " + IOSURFACE_ACQUIRE);
for(const [api, { base, commands }] of Object.entries(GLES_APIS))
    for(const [i, [name]] of commands.entries())
        console.log("#define " + api + "_" + name + " " + (base + i));
