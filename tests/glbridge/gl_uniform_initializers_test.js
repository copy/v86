"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),
 {GLShadow}=require("../../src/browser/glbridge/gl-webgpu/gl_shadow.js"),
 {Glslang}=require("../../src/browser/glbridge/gl-webgpu/gl_glslang.js"),
 {GLWebGPUExecutor}=require("../../src/browser/glbridge/gl-webgpu/gl_executor.js"),
 {createFakeHost}=require("./gl_fake_gpu.js"),{GLStream,GL}=require("./gl_stream_builder.js"),P=require("../../src/browser/glbridge/gl-webgpu/gl_protocol.js");
require("../../src/browser/glbridge/gl-webgpu/gl_shadow_glsl.js");
const compiler=new Glslang(fs.readFileSync(path.join(__dirname,"../../bios/glslang.wasm"))),
 fragment="#version 120\nstruct Params{bool enabled;vec2 shift;};uniform Params opts=Params(true,vec2(0.25,0.75));uniform float weights[3]=float[3](0.125,0.25,0.5);uniform mat2 basis=mat2(0.25,0.5,0.75,1.0);uniform int counter=7;void main(){gl_FragColor=vec4(opts.enabled?weights[2]:0.0,opts.shift.x,basis[1][0],float(counter)/7.0);}",
 expected={"opts.enabled":[1],"opts.shift":[0.25,0.75],weights:[0.125,0.25,0.5],basis:[0.25,0.5,0.75,1],counter:[7]};
(async()=>{
 for (const copied of [false,true]){
  const cpu=new GLShadow(),{host}=createFakeHost(),gpu=new GLWebGPUExecutor(null,{host,strict:true});await gpu.initialize();cpu.setCapabilities(gpu.capabilities());cpu.setGlslang(compiler);
  const send=async stream=>{const bytes=stream.bytes();for (const segment of cpu.process(bytes)){const part=segment.bytes||bytes.subarray(segment.offset,segment.offset+segment.length);gpu.submit(copied?part.slice():part,{});} await gpu.idle();assert.equal(cpu.current.error,0);};
  await send(new GLStream().makeCurrent(1,0,0,16,16,1,1).call("CREATE_PROGRAM",1).call("CREATE_SHADER",2,GL.VERTEX_SHADER).call("CREATE_SHADER",3,GL.FRAGMENT_SHADER)
   .shaderSource(2,"void main(){gl_Position=gl_Vertex;}").shaderSource(3,fragment).call("COMPILE_SHADER",2).call("COMPILE_SHADER",3).call("ATTACH_SHADER",1,2).call("ATTACH_SHADER",1,3).call("LINK_PROGRAM",1));
  const c=cpu.current.group.programs.get(1),g=gpu.current.shareGroup.programs.get(1);assert.ok(c.linked.ok,c.linked.log);assert.ok(g.linked,g.log);
  const verify=()=>{for (const [name,values] of Object.entries(expected)){const u=c.linked.uniforms.find(u=>u.name===name);assert.ok(u,name);const mapped=g.uniformByLocation.get(u.location).uniform;
   const width=values.length/u.size;for (let i=0;i<u.size;i++){assert.deepEqual(c.values.get(u.location+i),values.slice(i*width,(i+1)*width),"CPU "+name);
    for (let k=0;k<width;k++){const at=(mapped.offsetBytes+i*mapped.arrayStrideBytes+(mapped.kind==="matrix"?Math.floor(k/mapped.rows)*mapped.matrixColumnStrideBytes+k%mapped.rows*4:k*4))/4;
     assert.equal((mapped.baseType==="float"?g.uniformFloats:g.uniformInts)[at],values[i*width+k],"GPU "+name+" "+k);}}}};
  verify();assert.equal(cpu.current.program,0,"defaults do not bind a program");assert.equal(gpu.current.currentProgram,0);
  const weights=c.linked.uniforms.find(u=>u.name==="weights");await send(new GLStream().call("USE_PROGRAM",1).uniformfv(weights.location,1,3,[9,8,7]).call("LINK_PROGRAM",1));verify();
  const before=g.uniformData.slice();await send(new GLStream().shaderSource(3,"void main(){broken;}").call("COMPILE_SHADER",3).call("LINK_PROGRAM",1));assert.equal(c.linked.ok,false);assert.deepEqual(g.uniformData,before,"failed relink preserves defaults/executable");
  const restored=new GLShadow();restored.setState(JSON.parse(JSON.stringify(cpu.getState())));assert.deepEqual([...restored.current.group.programs.get(1).values],[...c.values]);
 }
 const bytes=P.encodeProgramInterface({program:1,object_id:2,link_generation:3},[],[{location:17,values:[0.25,0.5]}]),view=new DataView(bytes.buffer);
 assert.deepEqual(P.decodeProgramInterface(view,0,bytes.length).initializers,[{location:17,values:[0.25,0.5]}]);
 for (const count of [0,17,0xFFFFFFFF]){const bad=bytes.slice();new DataView(bad.buffer).setUint32(P.RECORDS.RESOLVED_PROGRAM_INTERFACE.size+4,count,true);assert.throws(()=>P.decodeProgramInterface(new DataView(bad.buffer),0,bad.length),/initializer/);}
 console.log("PASS desktop uniform defaults: typed structs/arrays/matrices, CPU/GPU, relink/snapshot, bounded internal transport in both modes");
})().catch(error=>{console.error(error);process.exitCode=1;});
