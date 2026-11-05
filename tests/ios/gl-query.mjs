// Execute the owner's original ARMv7 GL entry points against the guest query
// adapters. Compare every packet with the independent host wire encoder.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build32, actual32, root } from "../a32/runner.mjs";
import { gl_wrappers, gl_slot_header } from "../../tools/ios/gl-dispatch.mjs";
import { command_of_name, encode_command } from "../../src/gles/gles_wire.js";

const file = process.argv[2];
if(!file) throw new Error("usage: gl-query.mjs dyld_shared_cache_armv7");
const wrappers = gl_wrappers(fs.readFileSync(file)), dir = path.join(root, "build/ios/query-wire");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "gl-slots.h"), gl_slot_header(wrappers));
const calls = [
    ["glGetIntegerv", [0xba2, 16], new Int32Array([3, 4, 640, 960])],
    ["glGetFloatv", [0xb70, 8], new Float32Array([0.25, 0.75])],
    ["glGetBooleanv", [0xc23, 4], new Uint8Array([1, 0, 1, 0])],
    ["glGetIntegerv", [0x86a2, 4], new Int32Array([3])],
    ["glGetIntegerv", [0x86a3, 12], new Int32Array([0x83f0, 0x83f1, 0x83f2])],
    ["glGetShaderiv", [7, 0x8b81, 4], new Int32Array([1])],
    ["glGetProgramiv", [9, 0x8b82, 4], new Int32Array([1])],
    ["glGetShaderInfoLog", [7, 8, 4, 8], new Uint8Array([7, 0, 0, 0, ...Buffer.from("compile\0")])],
    ["glGetProgramInfoLog", [9, 1, 4, 1], new Uint8Array(5)],
    ["glGetShaderSource", [7, 4, 4, 4], new Uint8Array([3, 0, 0, 0, 97, 98, 99, 0])],
];
const defs = [], packets = [], asm = [".syntax unified", ".thumb", ".text"];
for(const name of new Set(calls.map(c => c[0])))
{
    defs.push("#define gles2_" + name + " " + command_of_name("gles2:" + name).opcode);
    asm.push(".balign 4", ".global " + name, ".thumb_func", name + ":", ".byte " + wrappers.get(name).join(","));
}
calls.forEach(([name, args, reply], i) => {
    defs.push(`static const unsigned char request${i}[] = {${encode_command("gles2:" + name, args)}};`);
    const bytes = new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
    defs.push(`static const unsigned char reply${i}[] = {${bytes}};`);
    packets.push(`{request${i}, sizeof(request${i}), reply${i}, sizeof(reply${i})}`);
});
const c = `#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "gl-slots.h"
typedef uintptr_t driver_word;
struct context { struct { unsigned connection; int ok; } driver; unsigned error; };
${defs.join("\n")}
static const struct {const unsigned char *req; unsigned n; const unsigned char *reply; unsigned r;} packets[] = {${packets}};
static unsigned sent, read_at, reading;
static int gles_send(unsigned conn, unsigned *p, unsigned n)
{
    p[1] = n;
    if(conn != 27 || sent >= sizeof(packets)/sizeof(*packets) ||
       n != packets[sent].n || memcmp(p, packets[sent].req, n)) return 0;
    if(sent && read_at != packets[sent-1].r) return 0;
    reading = sent++; read_at = 0; return 1;
}
static int gles_read(unsigned conn, void *out, unsigned n)
{
    if(conn != 27 || !sent || read_at+n > packets[reading].r) return 0;
    if(n) memcpy(out, packets[reading].reply+read_at, n);
    read_at += n; return 1;
}
#define SEND(c,op,...) gles_send(c,(unsigned[]){op,0,__VA_ARGS__},sizeof((unsigned[]){op,0,__VA_ARGS__}))
static void draw_error(struct context *c, unsigned e) { if(!c->error) c->error = e; }
static int integer_value(struct context *c, unsigned p, int *out)
{ return SEND(c->driver.connection,gles2_glGetIntegerv,p,4) && gles_read(c->driver.connection,out,4); }
#define N90_MAX_PAYLOAD ((80u<<20)-32)
#include "gli-query.h"
extern void glGetIntegerv(unsigned,int *), glGetFloatv(unsigned,float *), glGetBooleanv(unsigned,unsigned char *);
extern void glGetShaderiv(unsigned,unsigned,int *), glGetProgramiv(unsigned,unsigned,int *);
extern void glGetShaderInfoLog(unsigned,int,int *,char *), glGetProgramInfoLog(unsigned,int,int *,char *);
extern void glGetShaderSource(unsigned,int,int *,char *);
static driver_word tls[64],table[N90_GL_TABLE_WORDS];
int main(void)
{
    struct context ctx = {{27,1},0}; driver_word p = (driver_word)tls;
    __asm__ volatile("mcr p15,0,%0,c13,c0,3\\n\\tisb"::"r"(p):"memory");
    tls[30]=(driver_word)table; table[4]=(driver_word)&ctx; install_query_functions(table+5);
    int viewport[6]={91,0,0,0,0,92}; glGetIntegerv(0xba2,viewport+1);
    if(memcmp(viewport,(int[]){91,3,4,640,960,92},sizeof(viewport))) return 1;
    float range[4]={11,0,0,12}; glGetFloatv(0xb70,range+1);
    if(memcmp(range,(float[]){11,0.25,0.75,12},sizeof(range))) return 2;
    unsigned char mask[6]={91,9,9,9,9,92}; glGetBooleanv(0xc23,mask+1);
    if(memcmp(mask,(unsigned char[]){91,1,0,1,0,92},6)) return 3;
    int formats[5]={91,0,0,0,92}; glGetIntegerv(0x86a3,formats+1);
    if(memcmp(formats,(int[]){91,0x83f0,0x83f1,0x83f2,92},sizeof(formats))) return 4;
    int status=0; glGetShaderiv(7,0x8b81,&status); if(status!=1) return 5;
    status=0; glGetProgramiv(9,0x8b82,&status); if(status!=1) return 6;
    char log[10]; memset(log,91,sizeof(log)); int length=-1;
    glGetShaderInfoLog(7,8,&length,log+1);
    if(length!=7 || log[0]!=91 || log[9]!=91 || strcmp(log+1,"compile")) return 7;
    glGetProgramInfoLog(9,1,0,log+1); if(log[1] || log[2]!='o') return 8;
    glGetShaderSource(7,4,&length,log+1); if(length!=3 || strcmp(log+1,"abc")) return 9;
    unsigned before=sent; glGetShaderInfoLog(7,-1,&length,log);
    if(ctx.error!=0x501 || sent!=before || !ctx.driver.ok) return 10;
    if(sent!=sizeof(packets)/sizeof(*packets) || read_at!=packets[reading].r) return 11;
    puts("native query packets and output bounds passed"); return 0;
}
`;
fs.writeFileSync(path.join(dir, "queries.c"), c);
fs.writeFileSync(path.join(dir, "wrappers.S"), asm.join("\n") + "\n");
const guest = build32("ios-query-wire", [path.join(dir, "queries.c"), path.join(dir, "wrappers.S")],
    { cflags: ["-I", dir, "-I", path.join(root, "tools/ios/guest"), "-ffixed-r9"] });
const result = await actual32(guest, { timeout: 30000 });
assert.equal(result.status, "ok", result.text);
assert.match(result.text, /native query packets and output bounds passed/);
console.log("PASS: original N90 state, shader and program queries preserve pointer ABI, wire replies and output bounds");
