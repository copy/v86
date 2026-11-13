#!/usr/bin/env node
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawnSync}=require("node:child_process");
const pipeline=require("../../src/browser/glbridge/d3d9-webgpu/d3d9_shader_pipeline.js");
const naga=require("./naga.js").requireNaga("nv40_shader_test");
(async()=>{
const {decode_vertex_program,decode_fragment_program}=await import("../../src/graphics_adapters/geforce_6800/nv40_program.js");
const {translate_vertex_program,translate_fragment_program}=await import("../../src/graphics_adapters/geforce_6800/nv40_shader.js");
const vertex=decode_vertex_program(Uint32Array.of(0x401F9C6C,0x0040000D,0x81000000,0x0001EF81));
const fragment=decode_fragment_program(Uint32Array.of(0x01001E81,0x001DC802,0,0,0x3F800000,0x3F000000,0,0x3F800000));
const folder=fs.mkdtempSync(path.join(os.tmpdir(),"nv40-shader-"));let validated=0;
function validate(name,translated)
{
    const result=pipeline.compileShader(translated.bytecode);assert.equal(result.ok,true,result.error);
    if(naga)
    {
        const file=path.join(folder,name+".wgsl");fs.writeFileSync(file,result.wgsl);
        const checked=spawnSync(naga,[file],{encoding:"utf8"});assert.equal(checked.status,0,checked.stderr+"\n"+result.wgsl);
    }
    validated++;return result;
}
try
{
    const vs=translate_vertex_program(vertex),ps=translate_fragment_program(fragment);
    assert.deepEqual(vs.inputs,[[0,[1,0]]]);assert.deepEqual(vs.outputs,[[0,0]]);
    assert.equal(validate("position",vs).reflection.outputDeclarations[0].usage,0);
    assert.deepEqual(validate("constant",ps).reflection.colorOutputs,[0]);
    assert.deepEqual([...ps.constant_values[0]],fragment.constants[0]);
    const windowed=translate_vertex_program(vertex,{viewport:{width:32,height:16,bypass:true}});
    validate("NV-window-position",windowed);assert.equal(windowed.viewport_constants.length,2);
    const resized=translate_vertex_program(vertex,{viewport:{width:64,height:32,bypass:true}});
    assert.deepEqual(windowed.bytecode,resized.bytecode,"viewport changes only upload constants");
    assert.notDeepEqual(windowed.viewport_constants,resized.viewport_constants);
    const routed=structuredClone(vertex),texOut=structuredClone(vertex.instructions[0]);
    texOut.vector.index=5;texOut.sources[0].index=8;routed.instructions.unshift(texOut);
    const routing=translate_vertex_program(routed,{result_map:[[0,0,-1,true],[7,5,-1,true]]});
    const reflected=validate("NV-output-routing",routing).reflection.outputDeclarations;
    assert(reflected.some(item=>item.usage===5&&item.usageIndex===0),"raw TBUF5 becomes TEX0 via the output map");
    assert(!reflected.some(item=>item.usage===11),"raw register numbers are not fixed semantics");
    const changed=structuredClone(fragment);changed.constants[0][0]=0x40000000;
    assert.deepEqual(translate_fragment_program(changed).bytecode,ps.bytecode,"inline values stay outside shader code/cache key");
    const dual=structuredClone(vertex);const i=dual.instructions[0];
    i.vector={name:"MUL",mask:15,type:"temp",index:0};i.scalar={name:"RCP",mask:1,type:"temp",index:1};
    i.sources=Array.from({length:3},()=>({type:"temp",index:0,swizzle:[0,1,2,3],negate:false,absolute:false}));
    const end=structuredClone(vertex.instructions[0]);end.sources[0]=i.sources[0];dual.instructions.push(end);
    const dualCode=translate_vertex_program(dual).bytecode;
    const first=Array.from(dualCode).indexOf(0x03000005);
    assert.equal(dualCode[first+4]&65535,6,"scalar result computed before vector destination commits");
    assert.equal(dualCode[first+7]&65535,1,"both slots commit after reading their old operands");
    validate("dual",{bytecode:dualCode});
    for(const name of ["MOV","MUL","ADD","MAD","DP3","DP4","DST","MIN","MAX","SLT","SGE","FRC","FLR","RCP","RSQ","EX2","LG2","SIN","COS","DDX","DDY"])
    {
        const p=structuredClone(fragment);p.instructions[0].name=name;p.instructions[0].sources=Array.from({length:3},()=>p.instructions[0].sources[0]);
        validate("alu-"+name,translate_fragment_program(p));
    }
    for(const name of ["TEX","TXP","TXB","TXL","TXD"])
    {
        const p=structuredClone(fragment),i=p.instructions[0];i.name=name;i.sources=Array.from({length:3},()=>({type:"input",index:4,swizzle:[0,1,2,3],negate:false,absolute:false}));
        const t=translate_fragment_program(p);assert.deepEqual(t.samplers,[[0,2]]);validate(name,t);
    }
    const relative=structuredClone(vertex);relative.instructions[0].address.constant=true;
    assert.throws(()=>translate_vertex_program(relative),/relative/);
    const conditional=structuredClone(fragment);conditional.instructions[0].predicate.condition=1;
    assert.throws(()=>translate_fragment_program(conditional),/control flow/);
    const alias=structuredClone(fragment),later=structuredClone(alias.instructions[0]);later.sources[0]={type:"temp",index:0,half:false,swizzle:[0,1,2,3]};alias.instructions.push(later);
    assert.throws(()=>translate_fragment_program(alias),/alias/);
    if(process.env.NV_PROGRAMS)
        for(const [index,p]of JSON.parse(fs.readFileSync(process.env.NV_PROGRAMS)).entries())
        {
            assert.deepEqual(p.errors,[]);validate("native-vs-"+index,translate_vertex_program(p.vertex));
            validate("native-ps-"+index,translate_fragment_program(p.fragment));
        }
    console.log("PASS: NV40 SM3 bytecode, VLIW read-before-write, constants, explicit refusals; "+validated+" WGSL modules validated");
}
finally {fs.rmSync(folder,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
