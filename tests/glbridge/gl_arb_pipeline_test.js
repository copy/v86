"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{execFileSync}=require("node:child_process"),
 arb=require("../../src/browser/glbridge/gl-webgpu/gl_arb_program.js"),cases=require("./gl_arb_pipeline_cases.js"),reference=require("./gl_conformance/arb_pipeline_reference.json"),
 naga=require("./naga.js").requireNaga("ARB pipeline"),dir=fs.mkdtempSync(path.join(os.tmpdir(),"arb-pipeline-"));
const mesa=JSON.parse(require("node:zlib").gunzipSync(fs.readFileSync(path.join(__dirname,"gl_conformance/mesa_reference.json.gz")))).fixtures.arb_pipeline;
for (let i=0;i<cases.scalar.length;i++){const c=arb.compileARBProgram(cases.scalar[i]);assert.equal(c.ok,!mesa.scalar[i].error,"strict scalar grammar "+i);if (!c.ok)assert.ok(c.errorPosition>=0&&c.errorPosition<cases.scalar[i].length);}
for (const row of reference.cases){const other=mesa.cases.find(c=>c.name===row.name);assert.equal(row.error,0);assert.equal(other.error,0);assert.equal(row.rgba,other.rgba,row.name+" independent pixels");assert.equal(row.rgba1,other.rgba1,row.name+" second target");}
for (const logicOp of Array.from({length:16},(_,i)=>0x1500+i)){
 const result=arb.compileARBProgram("!!ARBfp1.0\nMOV result.color,fragment.texcoord[0];\nEND\n",{logicOp,colorTargets:2,pointSprite:true,pointCoordReplace:[0],alphaTest:"less"});
 assert.ok(result.ok,result.log);const file=path.join(dir,logicOp+".wgsl");fs.writeFileSync(file,result.wgsl);execFileSync(naga,[file],{stdio:"pipe"});
 assert.ok(result.wgsl.includes("vec4<f32>(fin.pointCoord,0.0,1.0)"));assert.ok(result.reflection.stateFields.includes("alphaRef"));
}
console.log("PASS native ARB scalar grammar, all logic ops/MRT, point replacement and alpha-test WGSL");
