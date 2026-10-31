// Generate genuine cgc output and execute Wine's unmodified plain-blit generator.
// node tools/gl_arb_corpus.mjs [Cg extraction root] [Wine 4.0 arb_program_shader.c]
import fs from "node:fs";
import path from "node:path";
import { createHash as create_hash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
const cg_root = path.resolve(process.argv[2] || "build/gl-e2/cg"), wine_path = path.resolve(process.argv[3] || "build/gl-e2/wine-4.0-arb_program_shader.c"),
    output = "build/gl-e2/corpus", target = "tests/glbridge/arb_corpus", hash = data => create_hash("sha256").update(data).digest("hex");
fs.mkdirSync(output, {recursive:true});fs.mkdirSync(target,{recursive:true});
const compiler = path.join(cg_root,"usr/bin/cgc"), queried = spawnSync(compiler,["--version"],{encoding:"utf8"}), version = (queried.stdout+queried.stderr).trim();
if(!version.includes("3.1.0013")) throw new Error("Expected cgc 3.1.0013");
if(hash(fs.readFileSync(compiler)) !== "036110e9e78a74f858878b0f340c1546e21d79b3569d06f1343a5efc3ac11c61") throw new Error("Unexpected cgc binary (pinned macOS 3.1.0013)");
const wine_source = fs.readFileSync(wine_path,"utf8");
if(hash(wine_source) !== "72129e9acdf4b824e9b89a9a299c7df871c74f70b95921085419ac730d774baf") throw new Error("Unexpected Wine source");
const source_function = name => {
    const start = wine_source.indexOf("static ",wine_source.lastIndexOf("\n}",wine_source.indexOf(name + "(")) + 2);
    const found = wine_source.indexOf(name + "(",start), end = wine_source.indexOf("\n}",found);
    if(found < start || end < found) throw new Error("Missing upstream function " + name);
    return wine_source.slice(start,end+2);
};
const shim = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
typedef unsigned int GLuint;typedef unsigned int GLenum;
struct wined3d_gl_info{int unused;};struct arbfp_blit_type{int res_type,use_color_key;};
struct wined3d_string_buffer{char* buffer;size_t length;};
enum wined3d_gl_resource_type {WINED3D_GL_RES_TYPE_TEX_1D,WINED3D_GL_RES_TYPE_TEX_2D,WINED3D_GL_RES_TYPE_TEX_3D,WINED3D_GL_RES_TYPE_TEX_CUBE,WINED3D_GL_RES_TYPE_TEX_RECT};
#define ARBFP_BLIT_PARAM_COLOR_KEY_LOW 1
#define ARBFP_BLIT_PARAM_COLOR_KEY_HIGH 2
#define GL_FRAGMENT_PROGRAM_ARB 0x8804
#define GL_EXTCALL(call) call
#define ERR(...) fprintf(stderr,__VA_ARGS__)
static int string_buffer_init(struct wined3d_string_buffer* b){b->buffer=calloc(1,16384);b->length=0;return !!b->buffer;}
static void string_buffer_free(struct wined3d_string_buffer* b){free(b->buffer);}
static void shader_addline(struct wined3d_string_buffer* b,const char* fmt,...){va_list args;va_start(args,fmt);b->length+=vsnprintf(b->buffer+b->length,16384-b->length,fmt,args);va_end(args);}
static void glGenProgramsARB(int n,GLuint* p){*p=1;}
static void glBindProgramARB(GLenum t,GLuint p){}
static void shader_arb_compile(const struct wined3d_gl_info* gl,GLenum t,const char* text){fputs(text,stdout);}
${source_function("arbfp_texture_target")}
${source_function("arbfp_gen_plain_shader")}
int main(int argc,char**argv){struct wined3d_gl_info gl={0};struct arbfp_blit_type type={atoi(argv[1]),atoi(argv[2])};return !arbfp_gen_plain_shader(&gl,&type);}
`;
fs.writeFileSync(output+"/wine_generator.c",shim);execFileSync("clang",["-w","-O1",output+"/wine_generator.c","-o",output+"/wine_generator"]);
const records = [];
for(const [i,texture] of ["1D","2D","3D","CUBE","RECT"].entries()) for(const key of [false,true])
{
    const source = execFileSync(output+"/wine_generator",[String(i),String(+key)],{encoding:"utf8"});
    records.push({name:"wine_plain_"+texture.toLowerCase()+(key?"_key":""),stage:"fragment",source,texture,key,
        locals:key?[[1,[0,0,0,0]],[2,[1,1,1,2]]]:[],producer:"Wine 4.0 arbfp_gen_plain_shader (executed unmodified)"});
}
const walk = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry => entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
const examples = path.join(cg_root,"Developer/NVIDIA/Cg/examples/OpenGL/basic"), files = walk(examples);
const selected = ["C2E1v_green","C3E1v_anycolor","C3E2v_varying","C3E3f_texture","C3E5v_twoTextures","C3E6f_twoTextures","C4E1v_transform","C9E1f_fog","C9E5v_projTex","C9E6f_projTex"];
for(const entry of selected)
{
    const input = files.filter(file => path.basename(file)===entry+".cg").sort()[0], source = fs.readFileSync(input,"utf8"),
        stage = entry.includes("v_")?"vertex":"fragment", profile = stage==="vertex"?"arbvp1":"arbfp1", filename = output+"/"+entry+".arb";
    const args = ["-quiet","-profile",profile,"-entry",entry,path.relative(process.cwd(),input),"-o",filename];execFileSync(compiler,args);
    const generated = fs.readFileSync(filename,"utf8"), locals = [];
    for(const match of generated.matchAll(/^#var (\S+) (\S+) : {2}: c\[(\d+)\](?:, (\d+))?/gm))
    {
        const [,type,name,index,count] = match, size = Number(count||1);
        for(let i=0;i<size;i++)
        {
            const value = type.includes("x")?[0,1,2,3].map(k => +(k===i%4)):
                /[Pp]osition/.test(name)?[0,0,4,1]:/shininess/.test(name)?[4,4,4,4]:[0.25,0.5,0.75,1];
            locals.push([Number(index)+i,value]);
        }
    }
    records.push({name:"cgc_"+entry,stage,source:generated,locals,texture:generated.includes("SHADOW2D")?"SHADOW2D":generated.includes(", 2D;")?"2D":null,
        producer:version,input:source,input_sha256:hash(source),command:args});
}
const manifest = {version:1,wine_url:"https://raw.githubusercontent.com/wine-mirror/wine/wine-4.0/dlls/wined3d/arb_program_shader.c",wine_sha256:hash(wine_source),
    cg_url:"https://developer.download.nvidia.com/cg/Cg_3.1/Cg-3.1_April2012.dmg",compiler_sha256:hash(fs.readFileSync(compiler)),records};
fs.writeFileSync(target+"/programs.json",JSON.stringify(manifest,null,2)+"\n");
if(fs.existsSync(target+"/NVIDIA-Cg-LICENSE.txt")) fs.chmodSync(target+"/NVIDIA-Cg-LICENSE.txt",0o644);
fs.writeFileSync(target+"/NVIDIA-Cg-LICENSE.txt",fs.readFileSync(path.join(cg_root,"Developer/NVIDIA/Cg/docs/license.txt")));
console.log("Generated",records.length,"genuine Wine/cgc programs");
