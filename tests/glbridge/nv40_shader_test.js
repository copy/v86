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
    assert.equal(dualCode[first+4]&0xFFFFFF,0x41000,"scalar result computed before vector destination commits");
    assert.equal(dualCode[first+7]&65535,1,"both slots commit after reading their old operands");
    validate("dual",{bytecode:dualCode});
    for(const name of ["MOV","LIT"])
    {
        const p=structuredClone(vertex),i=p.instructions[0];i.vector={name:"NOP",mask:0};
        i.scalar={name,type:"output",index:0,mask:15};i.sources[2]={...i.sources[0],swizzle:[3,1,0,2]};
        const translated=translate_vertex_program(p);validate("scalar-vector-"+name,translated);
        const instruction=Array.from(translated.bytecode).findIndex(word=>(word&0xFFFFFF)===(name==="MOV"?1:0x31000));
        assert.equal(translated.bytecode[instruction+2]>>>16&255,0x87,"MOV/LIT keep the complete source swizzle");
    }

    for(const name of ["MOV","MUL","ADD","MAD","DP3","DP4","DST","MIN","MAX","SLT","SGE","FRC","FLR","RCP","RSQ","EX2","LG2","SIN","COS","DDX","DDY",
        "DPH","DP2A","SEQ","SNE","SLE","SGT","SSG","SFL","STR","DIV"])
    {
        const p=structuredClone(fragment);p.instructions[0].name=name;p.instructions[0].sources=Array.from({length:3},()=>p.instructions[0].sources[0]);
        validate("alu-"+name,translate_fragment_program(p));
    }
    for(const name of ["RCC","EXP","LOG","RCP","RSQ","LG2"])
    {
        const p=structuredClone(vertex),i=p.instructions[0];i.vector={name:"NOP",mask:0};
        i.scalar={name,type:"output",index:0,mask:15};i.sources[2]={...i.sources[0]};
        validate("nv-scalar-"+name,translate_vertex_program(p));
    }
    const ara=structuredClone(vertex);
    ara.instructions[0].vector={name:"ARA",type:"temp",index:1,mask:15};ara.instructions[0].address.register=0;
    ara.instructions[0].sources=ara.instructions[0].sources.map(s=>({...s,type:"invalid"}));
    validate("address-paired-add",translate_vertex_program(ara));
    const late=structuredClone(vertex),setTrue=structuredClone(late.instructions[0]);
    setTrue.vector={name:"STR",mask:15,type:"temp",index:0};late.instructions.unshift(setTrue);
    late.instructions[1].sources[0]={...late.instructions[1].sources[0],type:"constant",index:255};
    const lateCode=translate_vertex_program(late);validate("late-constant",lateCode);
    assert(lateCode.constants.some(index=>index>=544) && lateCode.constants.includes(255),"internal constants cannot shadow a later guest operand");
    for(const name of ["TEX","TXP","TXB","TXL","TXD"])
    {
        const p=structuredClone(fragment),i=p.instructions[0];i.name=name;i.sources=Array.from({length:3},()=>({type:"input",index:4,swizzle:[0,1,2,3],negate:false,absolute:false}));
        const t=translate_fragment_program(p);assert.deepEqual(t.samplers,[[0,2]]);validate(name,t);
        const rect=translate_fragment_program(p,{texture_sizes:[[8,4,1]]});validate(name+"-unnormalized",rect);
        assert.deepEqual([...rect.texture_constants[0][1]],[.125,.25,1,1]);
        const resized=translate_fragment_program(p,{texture_sizes:[[16,16,1]]});
        assert.deepEqual(rect.bytecode,resized.bytecode,"texture dimensions remain uniform values outside the shader cache key");
    }
    const fogged=structuredClone(fragment);fogged.instructions[0].sources[0]={type:"input",index:3,swizzle:[0,1,2,3],negate:false,absolute:false};
    for(const mode of [0x2601,0x804,0x800,0x801,0x802,0x803])validate("fog-"+mode,translate_fragment_program(fogged,{fog:{mode,constant:1,linear:1}}));
    assert.throws(()=>translate_fragment_program(fogged,{fog:{mode:0x805,constant:1,linear:1}}),/invalid fog/);
    assert.throws(()=>translate_fragment_program(fogged,{fog:{mode:0x2601,constant:NaN,linear:1}}),/nonfinite fog/);
    for(let register=0;register<2;register++)for(let condition=0;condition<8;condition++)
    {
        const p=structuredClone(vertex),update=structuredClone(p.instructions[0]);
        update.predicate={...update.predicate,update:true,vector:true,register};p.instructions.unshift(update);
        p.instructions[1].predicate={...p.instructions[1].predicate,enabled:true,register,condition};
        validate("vertex-cc-"+register+"-"+condition,translate_vertex_program(p));
    }
    const relative=structuredClone(vertex);relative.instructions[0].address.constant=true;
    validate("relative-constant-unused",translate_vertex_program(relative));
    for(const name of ["ARL","ARR"])
    {
        const p=structuredClone(vertex),load=structuredClone(p.instructions[0]);load.vector={name,type:"temp",index:1,mask:15};
        p.instructions.unshift(load);p.instructions[1].address={register:1,component:2,input:false,constant:true};
        p.instructions[1].sources[0]={...p.instructions[1].sources[0],type:"constant",index:7};
        validate("relative-constant-"+name,translate_vertex_program(p));
        p.instructions[1].sources[0].type="input";p.instructions[1].sources[0].index=2;p.instructions[1].address.input=true;
        const t=translate_vertex_program(p);assert.equal(t.inputs.length,16);validate("relative-input-"+name,t);
    }
    const conditional=structuredClone(fragment);conditional.instructions[0].predicate.condition=1;
    validate("conditional",translate_fragment_program(conditional));
    for(let condition=1;condition<7;condition++) {conditional.instructions[0].predicate.condition=condition;conditional.instructions[0].predicate.update=true;validate("cc-"+condition,translate_fragment_program(conditional));}
    for(let read=0;read<2;read++)for(let write=0;write<2;write++)
    {
        const p=structuredClone(conditional);p.instructions[0].predicate.register=read;p.instructions[0].predicate.destination=write;
        validate("fragment-cc-banks-"+read+"-"+write,translate_fragment_program(p));
    }
    const base=vertex.instructions[0],flowOp=(name,pc,target=0)=>{
        const i=structuredClone(base);i.pc=pc;i.end=false;i.vector.name="NOP";i.scalar={name,mask:0};
        i.target=target;return i;
    };
    const final=structuredClone(base);final.pc=1;
    validate("vertex-call",translate_vertex_program({entry:0,instructions:[flowOp("CAL",0,3),final,flowOp("RET",3)]}));
    for(let condition=0;condition<8;condition++)
    {
        const jump=flowOp("BRA",0,1);jump.predicate.condition=condition;
        validate("vertex-branch-"+condition,translate_vertex_program({entry:0,instructions:[jump,final]}));
    }
    const branch=structuredClone(fragment);branch.instructions[0].branch=true;assert.throws(()=>translate_fragment_program(branch),/control flow/);
    const fpFlow=(name,pc,end,otherwise=end,condition=7)=>{
        const i=structuredClone(fragment.instructions[0]);Object.assign(i,{name,pc,end:false,branch:true,end_offset:end,else_offset:otherwise,loop:{count:3}});
        i.predicate.condition=condition;return i;
    };
    const fpMove=pc=>{const i=structuredClone(fragment.instructions[0]);i.pc=pc;i.end=false;return i;};
    for(const condition of [0,1,2,4,7])validate("fragment-if-"+condition,translate_fragment_program({constants:fragment.constants,word_count:28,
        instructions:[fpFlow("IF",0,20,12,condition),fpMove(4),fpMove(12),fpMove(20)]}));
    validate("fragment-repeat-break",translate_fragment_program({constants:fragment.constants,word_count:24,
        instructions:[fpFlow("REP",0,16),fpMove(4),fpFlow("BRK",12,0),fpMove(16)]}));
    const indexed=fpMove(4);indexed.input_relative=true;indexed.address=2;indexed.sources[0]={...indexed.sources[0],type:"input"};
    const loop=fpFlow("LOOP",0,8);loop.loop={count:3,initial:1,increment:2};
    const loopTranslated=translate_fragment_program({constants:fragment.constants,word_count:16,instructions:[loop,indexed,fpMove(8)]});
    assert.equal(loopTranslated.inputs.length,10);validate("fragment-indexed-loop",loopTranslated);
    assert.throws(()=>translate_fragment_program({constants:fragment.constants,word_count:8,instructions:[indexed]}),/outside LOOP/);
    const fpReturn=[5<<24,7<<18,0x80000000,0],fpConstant=end=>[fragment.instructions[0].words[0]&~1|end,...fragment.instructions[0].words.slice(1),...fragment.constants[0]];
    const fpCall=(target,condition=7)=>[1<<24,condition<<18,0x80000000|target,0];
    for(const condition of [0,1,2,4,7])validate("fragment-call-"+condition,translate_fragment_program(decode_fragment_program(Uint32Array.from([
        ...fpCall(12,condition),...fpConstant(1),...fpConstant(0),...fpReturn]))));
    validate("fragment-recursion",translate_fragment_program(decode_fragment_program(Uint32Array.from([
        ...fpConstant(0),...fpCall(0),...fpConstant(1)]))));
    validate("fragment-empty-return",translate_fragment_program(decode_fragment_program(Uint32Array.from([...fpConstant(0),...fpReturn]))));
    assert.throws(()=>translate_fragment_program({constants:fragment.constants,word_count:8,instructions:[fpFlow("BRK",0,0),fpMove(4)]}),/outside loop/);
    assert.throws(()=>translate_fragment_program({constants:fragment.constants,word_count:12,instructions:[fpFlow("IF",0,10),fpMove(4)]}),/scope/);
    const alias=structuredClone(fragment),later=structuredClone(alias.instructions[0]);later.sources[0]={type:"temp",index:0,half:false,swizzle:[0,1,2,3]};alias.instructions.push(later);
    assert.throws(()=>translate_fragment_program(alias),/alias/);
    for(const full of [false,true])
    {
        const multiple=structuredClone(fragment);
        multiple.instructions=[0,2,3,4].map(register=>{
            const i=structuredClone(fragment.instructions[0]);i.destination.index=register*(full?1:2);i.destination.half=!full;return i;
        });
        const output=validate("MRT-"+full,translate_fragment_program(multiple,{targets:4,fp32_outputs:full}));
        assert.deepEqual(output.reflection.colorOutputs,[0,1,2,3],"Curie skips the depth register when exporting MRT colors");
    }
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
