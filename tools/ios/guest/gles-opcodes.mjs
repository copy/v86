// C names for the same emugl protocol table decoded by the host.
import { GLES_APIS } from "../../../src/gles/gles_protocol.js";

import { IOSURFACE_ACQUIRE, IOSURFACE_COMMANDS } from "../../../src/gles/gles_wire.js";

for(const [i, [name]] of IOSURFACE_COMMANDS.entries())
    console.log("#define v86_" + name.slice(3) + " " + (IOSURFACE_ACQUIRE + i));
for(const [api, { base, commands }] of Object.entries(GLES_APIS))
    for(const [i, [name]] of commands.entries())
        console.log("#define " + api + "_" + name + " " + (base + i));
