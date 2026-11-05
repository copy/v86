// Exercise the owner's original public GL entry points on AArch32. The
// independent host encoder defines the expected packed requests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build32, actual32, root } from "../a32/runner.mjs";
import { gl_wrappers, gl_slot_header } from "../../tools/ios/gl-dispatch.mjs";
import { GLES_APIS } from "../../src/gles/gles_protocol.js";
import { encode_command } from "../../src/gles/gles_wire.js";

const file = process.argv[2];
if(!file) throw new Error("usage: gl-uniform.mjs dyld_shared_cache_armv7");
const wrappers = gl_wrappers(fs.readFileSync(file)), dir = path.join(root, "build/ios/uniform-wire");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "gl-slots.h"), gl_slot_header(wrappers));
const defs = [], cases = [], packets = [], names = new Set();
for(const [i, [name]] of GLES_APIS.gles2.commands.entries())
    defs.push(`#define gles2_${name} ${GLES_APIS.gles2.base + i}`);
function call(name, args, statement, reply = [])
{
    const i = packets.length;
    defs.push(`static const unsigned char packet${i}[] = {${encode_command("gles2:" + name, args)}};`);
    packets.push(`{packet${i}, sizeof(packet${i}), ${reply.length ? "1" : "0"}}`);
    cases.push(statement); names.add(name);
}
for(const kind of ["fv", "iv"])
    for(let n = 1; n <= 4; n++)
    {
        const name = `glUniform${n}${kind}`, type = kind === "fv" ? "float" : "int";
        const values = Array.from({ length: 2 * n }, (_, i) => kind === "fv" ? -3.25 + 0.75 * i : -91 + i);
        const data = kind === "fv" ? new Float32Array(values) : new Int32Array(values);
        defs.push(`extern void ${name}(int, int, const ${type} *);`);
        call(name, [7, 2, new Uint8Array(data.buffer)], `{ static const ${type} v[] = {${values}}; ${name}(7, 2, v); }`);
    }
for(let n = 2; n <= 4; n++)
{
    const name = `glUniformMatrix${n}fv`, values = Array.from({ length: 2 * n * n }, (_, i) => -2.5 + i / 4);
    defs.push(`extern void ${name}(int, int, unsigned char, const float *);`);
    call(name, [11, 2, 0, new Uint8Array(new Float32Array(values).buffer)],
        `{ static const float v[] = {${values}}; ${name}(11, 2, 0, v); }`);
}
call("glUniform4fv", [7, 0, new Uint8Array()], "glUniform4fv(7, 0, 0);");
defs.push("extern int glGetUniformLocation(unsigned, const char *);");
defs.push("extern void glBindAttribLocation(unsigned, unsigned, const char *);");
call("glGetUniformLocation", [9, new TextEncoder().encode("transform[1]\0")],
    "if(glGetUniformLocation(9, \"transform[1]\") != 23) return 1;", [23]);
call("glBindAttribLocation", [9, 5, new TextEncoder().encode("position\0")], "glBindAttribLocation(9, 5, \"position\");");
const asm = [".syntax unified", ".thumb", ".text"];
for(const name of names)
    asm.push(".balign 4", ".global " + name, ".thumb_func", name + ":", ".byte " + wrappers.get(name).join(","));
const c = `#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "gl-slots.h"
typedef uintptr_t driver_word;
struct context { struct { unsigned connection; int ok; } driver; unsigned error; };
${defs.join("\n")}
static const struct {const unsigned char *req; unsigned n, reply;} packets[] = {${packets}};
static unsigned sent, replied;
static int gles_send(unsigned conn, unsigned *p, unsigned n)
{
    p[1] = n;
    if(conn != 27 || sent >= sizeof(packets)/sizeof(*packets) ||
       n != packets[sent].n || memcmp(p, packets[sent].req, n)) return 0;
    sent++; return 1;
}
static int gles_read(unsigned conn, void *out, unsigned n)
{
    int location = 23;
    if(conn != 27 || !sent || !packets[sent-1].reply || n != 4) return 0;
    memcpy(out, &location, 4); replied++; return 1;
}
static int integer_value(struct context *c, unsigned p, int *out) { return 0; }
static unsigned invalid_operation(struct context *c) { c->error = 0x502; return 0; }
#include "gli-draw.h"
#include "gli-uniform.h"
static driver_word tls[64], table[N90_GL_TABLE_WORDS];
int main(void)
{
    struct context ctx = {{27,1},0}; driver_word ptr = (driver_word)tls;
    __asm__ volatile("mcr p15,0,%0,c13,c0,3\\n\\tisb"::"r"(ptr):"memory");
    tls[30]=(driver_word)table; table[4]=(driver_word)&ctx; install_uniform_functions(table+5);
${cases.map(s => "    " + s).join("\n")}
    if(!ctx.driver.ok || ctx.error || sent != sizeof(packets)/sizeof(*packets) || replied != 1) return 2;
    unsigned before = sent;
    glUniform4fv(-1, 1, (const float *)1); // ignored location must not read a guest pointer
    if(sent != before || ctx.error) return 3;
    glUniform4iv(7, -1, 0); if(ctx.error != 0x501 || sent != before) return 4;
    ctx.error = 0; glUniformMatrix4fv(7, 1, 1, 0);
    if(ctx.error != 0x501 || sent != before) return 5;
    ctx.error = 0; glUniform3fv(7, 1, 0);
    if(ctx.error != 0x501 || sent != before) return 6;
    ctx.error = 0; glUniformMatrix4fv(7, 0x7fffffff, 0, (const float *)1);
    if(ctx.error != 0x505 || sent != before) return 7;
    ctx.error = 0; glGetUniformLocation(9, 0);
    if(ctx.error != 0x501 || sent != before) return 8;
    puts("all native uniform arrays and names passed"); return 0;
}
`;
fs.writeFileSync(path.join(dir, "uniforms.c"), c);
fs.writeFileSync(path.join(dir, "wrappers.S"), asm.join("\n") + "\n");
const guest = build32("ios-uniform-wire", [path.join(dir, "uniforms.c"), path.join(dir, "wrappers.S")],
    { cflags: ["-I", dir, "-I", path.join(root, "tools/ios/guest"), "-ffixed-r9"] });
const result = await actual32(guest, { timeout: 30000 });
assert.equal(result.status, "ok", result.text);
assert.match(result.text, /all native uniform arrays and names passed/);
console.log("PASS: original N90 vector/matrix uniforms and shader names preserve pointer ABI, packed arrays and error bounds");
