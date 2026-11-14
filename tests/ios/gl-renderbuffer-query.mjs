// The real N90 public entry point must write the drawable size through the
// caller's pointer. Sending a query without copying its reply breaks UE3 depth FBOs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build32, actual32, root } from "../a32/runner.mjs";
import { gl_wrappers, gl_slot_header } from "../../tools/ios/gl-dispatch.mjs";
import { GLES_APIS } from "../../src/gles/gles_protocol.js";
import { command_of_name } from "../../src/gles/gles_wire.js";
const cache = process.argv[2];
if(!cache) throw Error("usage: gl-renderbuffer-query.mjs dyld_shared_cache_armv7");
const wrappers = gl_wrappers(fs.readFileSync(cache));
const dir = path.join(root, "build/ios/renderbuffer-query");fs.mkdirSync(dir, {recursive:true});
fs.writeFileSync(path.join(dir,"gl-slots.h"),gl_slot_header(wrappers));
const name="glGetRenderbufferParameteriv";
fs.writeFileSync(path.join(dir,"wrapper.S"),`.syntax unified\n.thumb\n.text\n.balign 4\n.global ${name}\n.thumb_func\n${name}:\n.byte ${wrappers.get(name).join(",")}\n`);
const defs=GLES_APIS.gles2.commands.map(([n])=>`#define gles2_${n} ${command_of_name("gles2:"+n).opcode}`).join("\n");
const c=`#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include "gl-slots.h"
#define N90_MAX_PAYLOAD (64u << 20)
${defs}
typedef uintptr_t driver_word;
struct context { struct { unsigned connection; int ok; } driver; };
static unsigned expected_pname,reply,requests,reads,errors;
static void draw_error(struct context *c,unsigned error) { (void)c;(void)error;errors++; }
static int integer_value(struct context *c,unsigned name,int *out) { (void)c;(void)name;*out=1;return 1; }
static int query_send(unsigned connection,unsigned opcode,...)
{
    va_list a;va_start(a,opcode);unsigned target=va_arg(a,unsigned),pname=va_arg(a,unsigned),bytes=va_arg(a,unsigned);va_end(a);
    if(connection!=27||opcode!=gles2_glGetRenderbufferParameteriv||target!=0x8d41||pname!=expected_pname||bytes!=4)return 0;
    requests++;return 1;
}
#define SEND query_send
static int gles_read(unsigned connection,void *out,unsigned n) { if(connection!=27||n!=4)return 0;memcpy(out,&reply,4);reads++;return 1; }
#include "${root}tools/ios/guest/gli-query.h"
extern __attribute__((pcs("aapcs"))) void glGetRenderbufferParameteriv(unsigned,unsigned,int *);
static driver_word tls[64],table[N90_GL_TABLE_WORDS];
int main(void)
{
    struct context c={{27,1}};driver_word ptr=(driver_word)tls;
    __asm__ volatile("mcr p15,0,%0,c13,c0,3\\n\\tisb" :: "r"(ptr) : "memory");
    tls[30]=(driver_word)table;table[4]=(driver_word)&c;install_query_functions(table+5);
    for(unsigned i=0;i<3;i++) {
        int size=-1;expected_pname=i==0?0x8d42:i==1?0x8d43:0x8d54;reply=i==0?960:i==1?640:24;
        glGetRenderbufferParameteriv(0x8d41,expected_pname,&size);
        if(size!=(int)reply||!c.driver.ok)return 1;
    }
    if(requests!=3||reads!=3||errors)return 1;
    puts("renderbuffer width, height and depth bits copied to native pointers");return 0;
}
`;
fs.writeFileSync(path.join(dir,"query.c"),c);
const guest=build32("ios-renderbuffer-query",[path.join(dir,"query.c"),path.join(dir,"wrapper.S")],{cflags:["-I",dir,"-ffixed-r9"]});
const result=await actual32(guest,{timeout:30000});
assert.equal(result.status,"ok",result.text);assert.match(result.text,/copied to native pointers/);
console.log("PASS: original N90 renderbuffer queries write native width, height and depth bit results");
