// Exercise each generated scalar encoder through the owner's real ARMv7
// entry point and compare its request to the host protocol's encoder.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build32, actual32, root } from "../a32/runner.mjs";
import { gl_wrappers, gl_slot_header } from "../../tools/ios/gl-dispatch.mjs";
import { c_type, scalar_commands, scalar_driver } from "../../tools/ios/guest/gl-scalar.mjs";
import { command_of_name, encode_command } from "../../src/gles/gles_wire.js";

const file = process.argv[2];
if(!file) throw new Error("usage: gl-scalar.mjs dyld_shared_cache_armv7");
const wrappers = gl_wrappers(fs.readFileSync(file));
const commands = scalar_commands(wrappers);
const dir = path.join(root, "build", "ios", "scalar-wire");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "gl-slots.h"), gl_slot_header(wrappers));
fs.writeFileSync(path.join(dir, "gl-scalar.h"), scalar_driver(commands));
const asm = [".syntax unified", ".thumb", ".text"];
const defs = [], cases = [];
for(const [name, ret, params] of commands)
{
    asm.push(".balign 4", ".global " + name, ".thumb_func", name + ":", ".byte " + wrappers.get(name).join(","));
    defs.push("#define gles2_" + name + " " + command_of_name("gles2:" + name).opcode);
    defs.push("extern __attribute__((pcs(\"aapcs\"))) " + c_type[ret] + " " + name + "(" +
        (params.map(p => c_type[p[1]]).join(", ") || "void") + ");");
    const values = params.map(([, type], i) => type === "f32" ? -3.25 + i * 0.75 :
        type === "u8" ? 0x87 + i : type === "i32" ? -73 - i : 0x78654321 + i);
    const bytes = encode_command("gles2:" + name, values);
    const call = name + "(" + values.join(", ") + ")";
    cases.push("    { static const unsigned char bytes[] = {" + bytes.join(",") + "};",
        "      expected = bytes; length = sizeof(bytes); sent = read_back = 0;",
        ret === "void" ? "      " + call + ";" : "      if(" + call + " != " + (ret === "u8" ? 1 : 0x34567812) + ") return 1;",
        "      if(!driver.ok || sent != 1 || read_back != " + Number(ret !== "void") + ") { puts(\"" + name + "\"); return 1; } }");
}
const c = `#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "gl-slots.h"
${defs.join("\n")}
typedef uintptr_t driver_word;
struct n90_driver { unsigned connection; int ok; };
static const unsigned char *expected;
static unsigned length, sent, read_back;
static int gles_call(unsigned op, const void *data, unsigned n, unsigned conn)
{
    sent++;
    return op == 2 && conn == 27 && n == length && !memcmp(data, expected, n) ? (int)n : -1;
}
static int gles_read(unsigned conn, void *out, unsigned n)
{
    unsigned word = n == 1 ? 1 : 0x34567812;
    if(conn != 27 || (n != 1 && n != 4)) return 0;
    memcpy(out, &word, n); read_back++; return 1;
}
#include "gl-scalar.h"
static driver_word tls[64], table[N90_GL_TABLE_WORDS];
int main(void)
{
    struct n90_driver driver = {27, 1};
    driver_word ptr = (driver_word)tls;
    __asm__ volatile("mcr p15,0,%0,c13,c0,3\\n\\tisb" :: "r"(ptr) : "memory");
    tls[30] = (driver_word)table; table[4] = (driver_word)&driver;
    install_scalar_functions(table + 5);
${cases.join("\n")}
    puts("all scalar packets passed"); return 0;
}
`;
fs.writeFileSync(path.join(dir, "scalars.c"), c);
fs.writeFileSync(path.join(dir, "wrappers.S"), asm.join("\n") + "\n");
const guest = build32("ios-scalar-wire", [path.join(dir, "scalars.c"), path.join(dir, "wrappers.S")],
    { cflags: ["-I", dir, "-ffixed-r9"] });
const result = await actual32(guest, { timeout: 30000 });
assert.equal(result.status, "ok", result.text);
assert.match(result.text, /all scalar packets passed/);
console.log("PASS: " + commands.length + " original N90 OpenGLES entry points emitted the expected scalar packets and returned the host results");
