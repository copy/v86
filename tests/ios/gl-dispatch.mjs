// Run the actual position-independent Thumb wrappers on the AArch32 core.
// Supply dyld_shared_cache_armv7 from the owner's iPhone3,1 10B329 rootfs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build32, actual32, root } from "../a32/runner.mjs";
import { gl_wrappers, gl_slot_header } from "../../tools/ios/gl-dispatch.mjs";

const file = process.argv[2];
if(!file) throw new Error("usage: gl-dispatch.mjs dyld_shared_cache_armv7");
const wrappers = gl_wrappers(fs.readFileSync(file));
const dir = path.join(root, "build", "ios", "gl-dispatch");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "gl-slots.h"), gl_slot_header(wrappers));
assert.equal(wrappers.size, 344); // 10B329 OpenGLES public entries
const asm = [".syntax unified", ".thumb", ".text"];
for(const name of ["glClear", "glDrawArrays", "glDrawElements", "glGetError", "glViewport"])
{
    const bytes = wrappers.get(name);
    asm.push(".balign 4", ".global " + name, ".thumb_func", name + ":", ".byte " + bytes.join(","));
}
const source = path.join(dir, "entrypoints.S");
fs.writeFileSync(source, asm.join("\n") + "\n");
const guest = build32("ios-gl-dispatch", [source, path.join(root, "tests/ios/gl-dispatch.c")], { cflags: ["-ffixed-r9", "-I", dir] });
const result = await actual32(guest, { timeout: 30000 });
assert.equal(result.status, "ok", result.text);
assert.match(result.text, /N90 OpenGLES dispatch passed/);
console.log("PASS: original N90 OpenGLES calls use the current thread's driver table and forward register and stack arguments");
