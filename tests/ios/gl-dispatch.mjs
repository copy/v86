// Run the actual position-independent Thumb wrappers on the AArch32 core.
// Supply dyld_shared_cache_armv7 from the owner's iPhone3,1 10B329 rootfs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build32, actual32, root } from "../a32/runner.mjs";
import { macho_parse, macho_symbols } from "../../src/apple/macho.js";

const file = process.argv[2];
if(!file) throw new Error("usage: gl-dispatch.mjs dyld_shared_cache_armv7");
const cache = fs.readFileSync(file), u32 = at => cache.readUInt32LE(at);
assert.equal(cache.toString("ascii", 0, 15), "dyld_v1   armv7");
const mappings = Array.from({ length: u32(20) }, (_, i) => {
    const at = u32(16) + 32 * i;
    return [0, 8, 16].map(n => Number(cache.readBigUInt64LE(at + n)));
});
function offset(va)
{
    for(const [base, size, fileoff] of mappings)
        if(va >= base && va - base < size) return fileoff + va - base;
    throw new Error("unmapped cache address " + va.toString(16));
}
let macho;
for(let i = 0; i < u32(28); i++)
{
    const at = u32(24) + i * 32, name = u32(at + 24);
    if(cache.toString("ascii", name, cache.indexOf(0, name)) === "/System/Library/Frameworks/OpenGLES.framework/OpenGLES")
    {
        macho = macho_parse(cache.subarray(offset(u32(at))));
        break;
    }
}
assert.ok(macho);
const symbols = macho_symbols(cache, macho).filter(s => s.sect === 1 && s.value).sort((a, b) => a.value - b.value);
const dir = path.join(root, "build", "ios", "gl-dispatch");
fs.mkdirSync(dir, { recursive: true });
const asm = [".syntax unified", ".thumb", ".text"];
for(const name of ["glClear", "glDrawArrays", "glDrawElements", "glGetError", "glViewport"])
{
    const symbol = symbols.find(s => s.name === "_" + name);
    assert.ok(symbol && symbol.desc & 8, name + " is not Thumb code");
    const end = symbols.find(s => s.value > symbol.value).value;
    assert.ok(end - symbol.value <= 256);
    const bytes = cache.subarray(offset(symbol.value), offset(end));
    asm.push(".balign 4", ".global " + name, ".thumb_func", name + ":", ".byte " + bytes.join(","));
}
const source = path.join(dir, "entrypoints.S");
fs.writeFileSync(source, asm.join("\n") + "\n");
const guest = build32("ios-gl-dispatch", [source, path.join(root, "tests/ios/gl-dispatch.c")], { cflags: ["-ffixed-r9"] });
const result = await actual32(guest, { timeout: 30000 });
assert.equal(result.status, "ok", result.text);
assert.match(result.text, /N90 OpenGLES dispatch passed/);
console.log("PASS: original N90 OpenGLES calls use the current thread's driver table and forward register and stack arguments");
