"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"),
    {spawnSync} = require("node:child_process"), translator = require("../../src/browser/glbridge/gl-webgpu/gl_shader_translator.js"),
    {Glslang} = require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"), cases = require("./gl_glsl120_codegen_cases.js"),
    naga = require("./naga.js").requireNaga("GLSL 1.20 code generation"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl120-")),
    authority = new Glslang(fs.readFileSync(path.join(__dirname, "../../bios/glslang.wasm")));
const extra = [
    "void main(){float value=1e40;gl_FragColor=vec4(value);}",
    "void main(){float value=log(0.0);gl_FragColor=vec4(value);}",
    "const float value=1.0/0.0;void main(){gl_FragColor=vec4(value);}",
    "const float value=sqrt(-1.0);void main(){gl_FragColor=vec4(value);}",
    "const int N=3;void main(){const int N=2;float a[N]=float[2](0.25,0.5);gl_FragColor=vec4(a[0],a[1],float(a.length())/4.0,1.0);}",
    "struct GLState{float value;};void main(){GLState result=GLState(0.5);float _t0=0.25;float vgl_61=0.75;gl_FragColor=vec4(result.value,_t0,vgl_61,1.0);}",
].map((source,i)=>({name:"regression_"+i,vertex:cases[0].vertex,fragment:"#version 120\n"+source}));
const names = ["target","target_","var","var_","floor","select","fsin","vsin","__name","vgl_61","u_color","GLState","glsl_main","_t0","x"];
assert.equal(new Set(names.map(translator.safeName)).size,names.length,"injective identifier escape");
const generated = spawnSync(process.execPath,[path.join(__dirname,"gl_conformance/reference/gen_glsl120_c.js"),"--check"],{encoding:"utf8"});
assert.equal(generated.status,0,generated.stderr);
const apple = require("./gl_conformance/glsl120_codegen_reference.json"),
    mesa = JSON.parse(require("node:zlib").gunzipSync(fs.readFileSync(path.join(__dirname,"gl_conformance/mesa_reference.json.gz")))).fixtures.glsl120_codegen;
for (const entry of cases) if (entry.defined) {
    assert.ok(apple[entry.name].compile&&apple[entry.name].link&&!apple[entry.name].error);
    assert.ok(mesa[entry.name].compile&&mesa[entry.name].link&&!mesa[entry.name].error);
    assert.equal(apple[entry.name].rgba,mesa[entry.name].rgba,"independent native pixels: "+entry.name);
}
let failed = 0;
for (const entry of [...cases,...extra]) {
    const checked = authority.link([{stage:0,source:entry.vertex},{stage:4,source:entry.fragment}]);
    assert.ok(checked.ok, entry.name + " invalid corpus: " + checked.log);
    const vs = translator.compileShader(entry.vertex,"vertex"), fs2 = translator.compileShader(entry.fragment,"fragment");
    const program = translator.linkProgram(vs,fs2,{desktopTextureState:true});
    if (!program.ok) {console.error(entry.name,vs.log,fs2.log,program.log);failed++;continue;}
    for (const [stage,code] of [["vertex",program.wgslVertex],["fragment",program.wgslFragment]]) {
        const file = path.join(dir,entry.name+"-"+stage+".wgsl");fs.writeFileSync(file,code);
        const validated = spawnSync(naga,[file],{encoding:"utf8"});
        if (validated.status) {console.error(entry.name,stage,validated.stderr);failed++;}
    }
}
assert.equal(failed,0,"generated GLSL 1.20 corpus failures ("+dir+")");
console.log("PASS "+(cases.length+extra.length)+" valid GLSL 1.20 pairs generate accepted WGSL, injective names");
