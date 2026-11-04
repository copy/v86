// Extract only the original entry points exercised by the private recovery
// test. No code from the owner's cache is included in the repository.
import fs from "node:fs";
import path from "node:path";
import { scalar_commands, scalar_driver } from "./gl-scalar.mjs";
import { gl_wrappers, gl_slot_header } from "../gl-dispatch.mjs";

const [cache, out, mode] = process.argv.slice(2);
const wrappers = gl_wrappers(fs.readFileSync(cache));
fs.writeFileSync(path.join(out, "gl-slots.h"), gl_slot_header(wrappers));
if(mode === "--slots-only")
{
    fs.writeFileSync(path.join(out, "gl-scalar.h"), scalar_driver(scalar_commands(wrappers)));
    process.exit(0);
}
const asm = [".syntax unified", ".thumb", ".text"];
for(const name of ["glClearColor", "glClear", "glEnable", "glScissor"])
{
    const bytes = wrappers.get(name);
    asm.push(".balign 4", ".global _" + name, ".thumb_func _" + name, "_" + name + ":", ".byte " + bytes.join(","));
}
fs.writeFileSync(path.join(out, "gl-frame-wrappers.s"), asm.join("\n") + "\n");
