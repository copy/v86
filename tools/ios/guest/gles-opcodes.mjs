// C names for the same emugl protocol table decoded by the host.
import { GLES_APIS } from "../../../src/gles/gles_protocol.js";

for(const [api, { base, commands }] of Object.entries(GLES_APIS))
    for(const [i, [name]] of commands.entries())
        console.log("#define " + api + "_" + name + " " + (base + i));
